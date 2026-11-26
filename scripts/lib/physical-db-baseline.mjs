// The physical database baseline's offline rules: identity, manifest and
// archive checks, which stored snapshot a tree may use, and the guards that
// keep every operation on an owned unionground-lab-ci-* lab. Only
// removePhysicalProject starts a process, through its caller's `run`.
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

export const baselineHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const baselineJson = (value) => JSON.stringify(value);
export const physicalKey = (identity) => baselineHash(baselineJson(identity));

export const PRODUCER_WORKFLOW = ".github/workflows/disposable-db-baseline.yml";
export const SNAPSHOT_ARTIFACT = "physical-disposable-baseline";
// The repository whose main-branch snapshot runs a lane may reuse:
// PHYSICAL_DB_BASELINE_REPOSITORY (owner/name) when the deployment pins one,
// else the repository the run belongs to. No other repository is trusted.
export function trustedRepository(env) {
  return String(env.PHYSICAL_DB_BASELINE_REPOSITORY ?? "").trim() || String(env.GITHUB_REPOSITORY ?? "");
}
export const TRUSTED_BRANCH = "main";
const LAB_PROJECT = /^unionground-lab-ci-[a-f0-9]{12}$/;
const LAB_WORKDIR = /^unionground-lab-ci-[A-Za-z0-9]+$/;
const fail = (reason) => { throw new Error(`physical-baseline-refused: ${reason}`); };

// No inherited credential, NODE_OPTIONS or Supabase override reaches a
// baseline command. RUNNER_ENVIRONMENT is the one runner value kept: the
// proof workers' time budgets read it (scripts/lib/runner-timeout.mjs).
export function baselineEnvironment(env, output) {
  return { PATH: env.PATH, HOME: env.HOME, TMPDIR: output,
    ...(env.RUNNER_ENVIRONMENT === "github-hosted" ? { RUNNER_ENVIRONMENT: "github-hosted" } : {}),
    LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "America/New_York" };
}

// Realtime creates one realtime.messages partition per UTC day when it starts.
// A snapshot restored after the UTC midnight that followed its production
// raced that service: in the sibling repository all 9 schema refusals in 140
// database jobs from Nov 8 to 10, 2026 came after such a midnight. Only those
// dated pg_dump entries are dropped; the partitioned parent and every other
// object stay.
const REALTIME_DAY_PARTITION = /^-- Name: [^;\n]*\bmessages_\d{4}_\d{2}_\d{2}\w*[^;\n]*; Type: [^;\n]+; Schema: realtime;/;
const withoutRealtimeDayPartitions = (dump) => dump.split(/(?=^--\n-- Name: )/m)
  .filter((entry) => !REALTIME_DAY_PARTITION.test(entry.split("\n")[1])).join("");
// pg_dump's \restrict nonce differs on every dump.
export const orderedSchema = (dump) => withoutRealtimeDayPartitions(dump).replace(/^\\(?:un)?restrict .*\n/gm, "");
export const canonicalSchema = (dump) => orderedSchema(dump)
  .split("\n").filter(Boolean).sort().join("\n") + "\n";

// A registry host says where an image was pulled from, not what it holds; the
// content-addressed imageId and every other pin still have to match exactly.
export const imageRepository = (reference) => {
  const [host, ...rest] = String(reference).split("/");
  return rest.length && /[.:]|^localhost$/.test(host) ? rest.join("/") : reference;
};

export function runtimeMismatchFields(expected, actual) {
  const comparable = (pins) => ({ ...pins, ...("image" in pins ? { image: imageRepository(pins.image) } : {}) });
  const [want, got] = [comparable(expected), comparable(actual)];
  return [...new Set([...Object.keys(want), ...Object.keys(got)])]
    .filter((field) => JSON.stringify(got[field]) !== JSON.stringify(want[field]));
}

// Names the identity fields, and the files, migrations or packages within
// them, that differ, so a refused snapshot says why without another run.
export function identityMismatchFields(expected, actual) {
  const named = (list) => new Map((Array.isArray(list) ? list : []).map((entry) => [entry?.[0], baselineJson(entry)]));
  return [...new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})])]
    .filter((field) => baselineJson(expected?.[field]) !== baselineJson(actual?.[field]))
    .map((field) => {
      if (!["files", "migrations", "packages"].includes(field)) return field;
      const [want, got] = [named(expected[field]), named(actual?.[field])];
      const names = [...new Set([...want.keys(), ...got.keys()])].filter((name) => want.get(name) !== got.get(name));
      return `${field} ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`;
    });
}

// The fields that hold the migration history. Every other identity field is
// an input of the stack itself (CLI, configuration, platform): a change to one
// of those cannot be bridged by applying newer migrations. (The fetch checks
// an identity built with the snapshot's own runtime pins; the restore checks
// those pins against the lab it starts.)
const HISTORY_FIELDS = new Set(["prefix", "migrations"]);
export const stackInputMismatches = (fields) => fields.filter((field) => !HISTORY_FIELDS.has(field.split(" ")[0]));

export function validatePhysicalManifest(bytes, archive, trustedDigest, expectedIdentity) {
  if (!/^[a-f0-9]{64}$/.test(trustedDigest ?? "") || baselineHash(bytes) !== trustedDigest) fail("physical manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  if (manifest.key !== physicalKey(expectedIdentity) || baselineJson(manifest.identity) !== baselineJson(expectedIdentity)) {
    const fields = identityMismatchFields(expectedIdentity, manifest.identity);
    fail(`physical identity mismatch${fields.length ? `: ${fields.join("; ")}` : ""}`);
  }
  if (![1, 2].includes(manifest.schema) || manifest.kind !== "physical-disposable" || manifest.pristine !== true
    || !/^[a-f0-9]{64}$/.test(manifest.schemaSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(manifest.orderedSchemaSha256 ?? "")
    || !/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? "")
    || !/^[1-9]\d*$/.test(String(manifest.source?.run ?? ""))) fail("physical manifest incomplete");
  assertPhysicalChain(manifest, trustedDigest);
  assertBaselinePristine(manifest.state);
  if (baselineHash(archive) !== manifest.archiveSha256) fail("physical archive digest mismatch");
  return manifest;
}

// How a snapshot was made (manifest schema 2, `build`). A from-zero replay is
// a chain's root. An incremental build restored an older main snapshot (its
// base), applied exactly the migrations after the base's prefix, and was
// verified like a replay. `root` is the from-zero snapshot the chain started
// from and `depth` the incremental builds since it. Schema 1 manifests predate
// the incremental builder: every one of them was a from-zero replay.
const snapshotRef = (ref) => ref && Number.isSafeInteger(ref.run) && ref.run > 0
  && /^[a-f0-9]{40}$/.test(ref.commit ?? "") && /^[a-f0-9]{64}$/.test(ref.manifestSha256 ?? "");
export const fromZeroBuild = (reason) => ({ path: "from-zero", reason, base: null, applied: [], depth: 0, root: null });
export function incrementalBuild(base, baseDigest, applied, reason) {
  const self = { run: Number(base.source.run), commit: base.source.commit, manifestSha256: baseDigest };
  return { path: "incremental", reason, base: { ...self, prefix: base.identity.prefix }, applied,
    depth: (base.build?.depth ?? 0) + 1, root: base.build?.path === "incremental" ? base.build.root : self };
}
export const buildOf = (manifest) => manifest.schema === 1 ? fromZeroBuild("schema 1 snapshot, before incremental builds") : manifest.build;

export function assertPhysicalChain(manifest, digest) {
  if (manifest.schema === 1) {
    if ("build" in manifest) fail("physical chain: a schema 1 manifest carries no build record");
    return;
  }
  const build = manifest.build;
  if (!build || typeof build.reason !== "string" || !build.reason || !Array.isArray(build.applied)) fail("physical chain incomplete");
  if (build.path === "from-zero") {
    if (build.base !== null || build.applied.length || build.depth !== 0 || build.root !== null) fail("physical chain: a from-zero snapshot names a base");
    return;
  }
  if (build.path !== "incremental" || !snapshotRef(build.base) || !snapshotRef(build.root)
    || !Number.isSafeInteger(build.depth) || build.depth < 1 || !/^\d{14}$/.test(build.base.prefix ?? "")) fail("physical chain incomplete");
  const names = (manifest.identity?.migrations ?? []).map(([name]) => name);
  if (!names.some((name) => name.startsWith(`${build.base.prefix}_`))) fail(`physical chain: base prefix ${build.base.prefix} is not one of this snapshot's migrations`);
  if (baselineJson(build.applied) !== baselineJson(suffixAfter(names, build.base.prefix))) fail("physical chain: applied migrations are not exactly those after the base's prefix");
  if (build.base.run >= Number(manifest.source.run) || build.base.manifestSha256 === digest) fail("physical chain: the base is not an older snapshot");
  const { prefix: _prefix, ...baseRef } = build.base;
  if (build.depth === 1 ? baselineJson(build.root) !== baselineJson(baseRef) : build.root.run >= build.base.run) fail("physical chain: root and depth disagree with the base");
}

// One line for the step summary and the record.
export function describeBuild(build) {
  if (build.path === "from-zero") return `replayed every migration from zero (${build.reason})`;
  return `built incrementally on main run ${build.base.run}'s snapshot (commit ${build.base.commit}, manifest ${build.base.manifestSha256}) by applying ${build.applied.length ? build.applied.join(", ") : "no migration"}; ${build.depth} incremental build(s) since the from-zero snapshot of run ${build.root.run}`;
}

// The periodic full replay compares its from-zero result with the snapshot
// the same run built: every identity input but the runtime pins by key, the
// runtime pins as the restore compares them, both schema digests and the
// recorded state.
export function snapshotComparison(manifest, manifestSha256) {
  const { runtime, ...inputs } = manifest.identity;
  return { run: Number(manifest.source.run), manifestSha256, path: buildOf(manifest).path, prefix: manifest.identity.prefix, inputsKey: physicalKey(inputs),
    runtime, schemaSha256: manifest.schemaSha256, orderedSchemaSha256: manifest.orderedSchemaSha256, state: manifest.state };
}
export function comparisonMismatches(expected, actual) {
  const runtime = runtimeMismatchFields(expected.runtime ?? {}, actual.runtime ?? {}).map((field) => `runtime ${field}`);
  return [...["prefix", "inputsKey", "schemaSha256", "orderedSchemaSha256", "state"]
    .filter((field) => baselineJson(expected[field]) !== baselineJson(actual[field])), ...runtime];
}

// What the next attempt on a fresh runner does after this one failed: the
// same choice again (`auto`, `compare`), a replay from zero (this attempt was
// one, or it could not restore its base on this tree's stack, which no other
// runner changes), or nothing (`stop`: the full replay differs from the
// snapshot, which another replay would only repeat).
export function nextAttempt(report, requested) {
  if (!report?.path) return { next: requested, reason: "" };
  const line = (text) => String(text ?? "").replace(/\s+/g, " ").slice(0, 400);
  if (report.path === "compare") return { next: report.mismatches?.length ? "stop" : "compare", reason: "" };
  if (report.path === "from-zero") return { next: "from-zero", reason: line(report.reason) };
  if (report.baseRefused) return { next: "from-zero", reason: line(`the previous attempt could not restore main run ${report.base?.run}'s snapshot: ${report.failure}`) };
  return { next: "auto", reason: "" };
}

// Producer runs whose snapshot a lab may restore: this workflow, in this
// repository, on main, from a push, the schedule or a dispatch on main. A
// run's overall conclusion is not read: attempt 1 failing and attempt 2
// publishing leaves the run red, and only an attempt whose every step
// succeeded uploads the snapshot.
export function selectTrustedRuns(runs, repository) {
  return (runs ?? []).filter((run) => run.path === PRODUCER_WORKFLOW
    && ["push", "schedule", "workflow_dispatch"].includes(run.event) && run.head_branch === TRUSTED_BRANCH
    && run.status === "completed"
    && /^[a-f0-9]{40}$/.test(run.head_sha ?? "") && run.repository?.full_name === repository
    && run.head_repository?.full_name === repository);
}

// The lab state a snapshot may hold: no login, identity, session, member or
// stored object. Organizations and chapters are recorded, not pinned: the
// pristine proofs assert their own zero-organization state in the producer.
const PRISTINE_KEYS = "auth_identities,auth_sessions,auth_users,chapters,members,organizations,storage_objects";
const PRISTINE_ZERO = ["auth_identities", "auth_sessions", "auth_users", "members", "storage_objects"];
export function assertBaselinePristine(counts) {
  if (!counts || Object.keys(counts).sort().join(",") !== PRISTINE_KEYS
    || Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0)
    || PRISTINE_ZERO.some((key) => counts[key] !== 0)) fail("non-pristine database");
  return counts;
}

export function assertBaselineTarget(target, others = []) {
  const workdir = resolve(target?.CI_DB_WORKDIR ?? "");
  let url;
  try { url = new URL(target?.SUPABASE_DB_URL); } catch { fail("not an owned local disposable target"); }
  if (!isAbsolute(target.CI_DB_WORKDIR ?? "") || !LAB_PROJECT.test(target.CI_DB_PROJECT_ID ?? "")
    || !LAB_WORKDIR.test(workdir.split("/").at(-1))
    || !["postgres:", "postgresql:"].includes(url.protocol)
    || url.hostname !== "127.0.0.1" || url.pathname !== "/postgres"
    || url.username !== "postgres" || url.password !== "postgres" || url.search || url.hash
    || Number(url.port) !== Number(target.CI_DB_BASE_PORT) + 2
    || Number(url.port) < 55002 || Number(url.port) > 59992) fail("not an owned local disposable target");
  for (const other of others) {
    if (other.CI_DB_WORKDIR === target.CI_DB_WORKDIR || other.CI_DB_PROJECT_ID === target.CI_DB_PROJECT_ID
      || other.CI_DB_BASE_PORT === target.CI_DB_BASE_PORT) fail("target alias");
  }
  return target;
}

export function assertBaselineContainer(target, container) {
  assertBaselineTarget(target);
  if (container?.Config?.Labels?.["com.supabase.cli.project"] !== target.CI_DB_PROJECT_ID
    || container?.Name !== `/supabase_db_${target.CI_DB_PROJECT_ID}`
    || !container?.NetworkSettings?.Ports?.["5432/tcp"]?.some((port) =>
      port.HostPort === new URL(target.SUPABASE_DB_URL).port && ["0.0.0.0", "127.0.0.1"].includes(port.HostIp))) {
    fail("database container is not the target endpoint");
  }
  return container;
}

// The migrations a restored lab applies on top of the snapshot's prefix.
export const suffixAfter = (names, prefix) => names.filter((name) => name.slice(0, 14) > prefix);

// The builder's cleanup ledger names each lab it prepared; its project id is
// derived from the ledger, so the cleanup can only ever name its own labs.
// The shell a restore runs in its helper container: list the archive, refuse
// an absolute or traversing entry and anything that is not a plain file or a
// directory, and only then empty the lab's data directory and extract.
// Each refusal is an explicit `if ...; then exit 1; fi`: under `sh -e` a
// command negated with `!` never stops the script, so the earlier
// `! grep ...;` guards let a forbidden archive through to the delete and the
// extract (end-to-end review, record #79, finding U79-03).
export function physicalImportCommand({ archive = "/artifact/data.tgz", data = "/data", scratch = "/tmp" } = {}) {
  return [
    `tar -tzf ${archive} > ${scratch}/entries.txt`,
    `if grep -E '(^/|(^|/)\\.\\.(/|$))' ${scratch}/entries.txt; then echo 'refusing an absolute or traversing archive entry' >&2; exit 1; fi`,
    `tar -tvzf ${archive} > ${scratch}/types.txt`,
    `if grep -Ev '^[-d]' ${scratch}/types.txt; then echo 'refusing an archive entry that is not a file or a directory' >&2; exit 1; fi`,
    `find ${data} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
    `tar -xzf ${archive} -C ${data}`,
  ].join("; ");
}

export const PHYSICAL_TARGET_NAMES = ["producer", "round-trip"];
export const physicalRunKey = (output, attemptId, name) => `${resolve(output)}:${attemptId}:${name}`;
export const physicalProjectId = (output, attemptId, name) =>
  `unionground-lab-ci-${baselineHash(physicalRunKey(output, attemptId, name)).slice(0, 12)}`;

// Exact inspected IDs, never a name substring or a daemon-wide prune.
export function removePhysicalProject(projectId, run) {
  if (!LAB_PROJECT.test(projectId ?? "")) fail("invalid physical cleanup project");
  const list = () => run("cleanup-list", "docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${projectId}`]).trim().split(/\s+/).filter(Boolean);
  const ids = list();
  if (ids.length) {
    const containers = JSON.parse(run("cleanup-inspect", "docker", ["inspect", ...ids]));
    if (containers.length !== ids.length || containers.some((c, index) =>
      !/^[a-f0-9]{64}$/.test(c.Id) || !c.Id.startsWith(ids[index])
      || c.Config?.Labels?.["com.supabase.cli.project"] !== projectId)) fail("physical cleanup ownership mismatch");
    run("cleanup-remove", "docker", ["rm", "-f", ...containers.map((c) => c.Id)]);
  }
  if (list().length) fail(`physical cleanup containers remain: ${projectId}`);
}

export function assertCleanupLedger(output, report) {
  if (!/^[a-f0-9-]{36}$/.test(report?.attemptId ?? "") || !Array.isArray(report.targets)
    || report.targets.length > PHYSICAL_TARGET_NAMES.length) fail("invalid physical cleanup ledger");
  const names = new Set();
  for (const target of report.targets) {
    if (!PHYSICAL_TARGET_NAMES.includes(target.name) || names.has(target.name)
      || target.projectId !== physicalProjectId(output, report.attemptId, target.name)) fail("physical cleanup ledger ownership mismatch");
    names.add(target.name);
  }
  return report.targets;
}
