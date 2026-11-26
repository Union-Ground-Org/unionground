// The physical database baseline (docs/contracts/ci.md, "Database lane").
//
// A from-zero replay of every migration costs about 25 minutes per lab on
// GitHub's 2-vCPU runner, and on a slower machine of that class it fails: PR
// #81's second run (43082264943, November 11, 2026) crossed the 60-second
// statement limit that 20260924170000_organization_structure_import.sql sets
// for itself, at statement 98, on the first replay and on the replay from
// zero. Migrations are never edited. So the replay moves off the pull request:
//
// - `--build` (.github/workflows/disposable-db-baseline.yml, on main) builds
//   the snapshot in a fresh lab: incrementally, by restoring the newest main
//   snapshot that fits this tree (the same restore a pull request runs) and
//   applying only the newer migrations, or by replaying every migration from
//   zero when no snapshot can be its base. Either way it checks history and
//   pristine state, runs the pristine proofs, stops the database cleanly,
//   archives its data directory with a manifest naming every input and how
//   the snapshot was made (its chain), then restores that archive into a
//   second fresh lab and requires the same schema before publishing. Path
//   `compare` is the periodic full replay: from zero, compared with the
//   snapshot the run built, never published.
// - `--next` tells the workflow what a next attempt does after this one failed.
// - `--restore` (ci.yml's `db` job) restores the snapshot that
//   scripts/fetch-physical-db-baseline.mjs verified into both labs, applies
//   only the migrations newer than its prefix, and records them.
// - `--cleanup` removes every container of the labs a build's ledger names.
//
// Ported from the sibling repository's scripts/physical-db-baseline.mjs
// without its cold-versus-warm comparison and start admission.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { prepareTargets, rewriteSupabaseConfig } from "./prepare-ci-disposable-db.mjs";
import { DISPOSABLE_DB_START_BUDGET_MS, START_DEADLINE_ENV } from "./lib/disposable-db-start-admission.mjs";
import { GRANT_PROBE_SCRIPT, applyHeldBackGrantMigrations, startDisposableDbStack } from "./start-disposable-db-stack.mjs";
import { holdBackMigrations } from "./lib/public-table-grant-probe.mjs";
import { PRISTINE_DB_PROOFS } from "./run-required-db-proofs.mjs";
import {
  assertBaselineContainer, assertBaselinePristine, assertBaselineTarget, assertCleanupLedger,
  baselineEnvironment, baselineHash, baselineJson, canonicalSchema, identityMismatchFields, orderedSchema,
  comparisonMismatches, describeBuild, fromZeroBuild, incrementalBuild, nextAttempt, physicalImportCommand, physicalKey, physicalRunKey,
  removePhysicalProject, runtimeMismatchFields, snapshotComparison, stackInputMismatches, suffixAfter, validatePhysicalManifest,
} from "./lib/physical-db-baseline.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE = join(ROOT, "node_modules/.bin/supabase");
const minute = 60_000;

const PRISTINE_SQL = `select json_build_object(
 'auth_users',(select count(*)::int from auth.users),
 'auth_identities',(select count(*)::int from auth.identities),
 'auth_sessions',(select count(*)::int from auth.sessions),
 'members',(select count(*)::int from public.member_profiles),
 'storage_objects',(select count(*)::int from storage.objects),
 'organizations',(select count(*)::int from public.organizations),
 'chapters',(select count(*)::int from public.chapters)) as state`;

// What shapes the data directory: the platform, the pinned CLI (which pins
// every service image) and its Linux binary package by lockfile integrity,
// the Supabase configuration as the labs rewrite it, the migrations up to the
// prefix, and the database image, engine and extension pins in `runtime`.
// Scripts, Node, the rest of the lockfile and the workflows are not inputs: a
// change to the builder is proven by the builder's own pull-request run.
export const PHYSICAL_PACKAGES = ["supabase", "@supabase/cli-linux-x64"];

export const migrationNames = (root = ROOT) => readdirSync(join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();

export function physicalIdentity(prefix, runtime, root = ROOT) {
  if (!/^\d{14}$/.test(prefix ?? "")) throw new Error("physical-baseline-refused: invalid prefix");
  const names = migrationNames(root);
  if (!names.some((name) => name.startsWith(`${prefix}_`))) throw new Error("physical-baseline-refused: missing physical prefix");
  const regular = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("physical-baseline-refused: symlinked Supabase input");
    return stat.isFile();
  };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages ?? {};
  return {
    schema: 1, physicalFormat: 1, prefix, platform: platform(), architecture: arch(),
    environment: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "America/New_York" },
    packages: PHYSICAL_PACKAGES.map((name) => [name, lock[`node_modules/${name}`]?.version ?? null, lock[`node_modules/${name}`]?.integrity ?? null]),
    preparedConfig: baselineHash(rewriteSupabaseConfig(readFileSync(join(root, "supabase/config.toml"), "utf8"),
      { projectId: "baseline-identity", basePort: 55000 })),
    files: readdirSync(join(root, "supabase")).sort().filter((name) => regular(join(root, "supabase", name)))
      .map((name) => [`supabase/${name}`, baselineHash(readFileSync(join(root, "supabase", name)))]),
    migrations: names.filter((name) => name.slice(0, 14) <= prefix).map((name) => {
      const path = join(root, "supabase/migrations", name);
      if (!regular(path)) throw new Error("physical-baseline-refused: non-file migration");
      return [name, baselineHash(readFileSync(path))];
    }),
    runtime,
  };
}

// Every check a stored snapshot must pass against this tree before a lab is
// touched. The fetch uses it to choose among recent producer runs and the
// restore repeats it on the chosen bytes. A refusal carries the stack inputs
// (not migrations) that differ, which no newer migration can bridge.
export function verifyPhysicalSnapshot(directory, trustedDigest, root = ROOT) {
  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  if (manifestBytes.length > 1024 * 1024 || baselineHash(manifestBytes) !== trustedDigest) throw new Error("physical-baseline-refused: physical manifest digest mismatch");
  const candidate = JSON.parse(manifestBytes);
  const prefix = candidate.identity?.prefix;
  const names = migrationNames(root);
  if (!/^\d{14}$/.test(prefix ?? "") || !names.some((name) => name.startsWith(`${prefix}_`))) {
    // A branch behind main. Its stack inputs are still compared, against an
    // identity at this tree's own newest migration.
    const error = new Error(`physical-baseline-refused: this tree lacks the snapshot's last migration ${prefix}`);
    error.stackInputs = stackInputMismatches(identityMismatchFields(physicalIdentity(names.at(-1).slice(0, 14), candidate.identity?.runtime, root), candidate.identity ?? {}));
    throw error;
  }
  const expected = physicalIdentity(prefix, candidate.identity.runtime, root);
  const fields = identityMismatchFields(expected, candidate.identity);
  if (fields.length) {
    const error = new Error(`physical-baseline-refused: physical identity mismatch: ${fields.join("; ")}`);
    error.stackInputs = stackInputMismatches(fields);
    throw error;
  }
  const stat = lstatSync(join(directory, "data.tgz"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 * 1024) throw new Error("physical-baseline-refused: physical archive is not a bounded regular file");
  const archive = readFileSync(join(directory, "data.tgz"));
  return { manifest: validatePhysicalManifest(manifestBytes, archive, trustedDigest, expected), archive };
}

export class PhysicalStack {
  constructor(target, { output, env = process.env, log = console.log } = {}) {
    assertBaselineTarget(target);
    this.target = target;
    this.output = output;
    this.env = { ...baselineEnvironment(env, output), CI: "true" };
    this.log = log;
    this.events = [];
  }
  run(label, command, args, extra = {}) {
    const began = performance.now();
    const result = spawnSync(command, args, { cwd: ROOT, env: this.env, encoding: "utf8",
      timeout: label.startsWith("cleanup") ? minute : 30 * minute, maxBuffer: 64 * 1024 * 1024, ...extra });
    const event = { label, elapsedMs: Math.round(performance.now() - began), status: result.status, signal: result.signal, error: result.error?.code };
    this.events.push(event);
    writeFileSync(join(this.output, `${this.target.CI_DB_PROJECT_ID}-${this.events.length}-${label}.log`), `${JSON.stringify(event)}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    this.log(`Physical baseline ${label}: ${event.elapsedMs} ms, status ${result.status}`);
    if (result.status !== 0) throw new Error(`${label}: ${result.error?.code ?? result.signal ?? result.status}: ${String(result.stderr).slice(-2000)}`);
    return result.stdout;
  }
  cli(label, args) {
    return this.run(label, SUPABASE, ["--workdir", this.target.CI_DB_WORKDIR, ...args]);
  }
  ensureLocalDocker(cleanup = false) {
    const endpoint = this.run(cleanup ? "cleanup-local-docker-context" : "local-docker-context", "docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    if (!endpoint.trim().startsWith("unix://")) throw new Error("physical baseline requires a local Unix-socket Docker context");
  }
  container() {
    return assertBaselineContainer(this.target, JSON.parse(this.run("inspect", "docker", ["inspect", `supabase_db_${this.target.CI_DB_PROJECT_ID}`]))[0]);
  }
  async sql(query) {
    this.container();
    const client = new pg.Client({ connectionString: this.target.SUPABASE_DB_URL, connectionTimeoutMillis: 10_000, statement_timeout: 60_000, query_timeout: 65_000 });
    await client.connect();
    try { return (await client.query(query)).rows; } finally { await client.end(); }
  }
  async pristineState() {
    return assertBaselinePristine((await this.sql(PRISTINE_SQL))[0].state);
  }
  async runtime() {
    const c = this.container();
    return { image: c.Config.Image, imageId: c.Image,
      engine: (await this.sql("select version() as version"))[0].version,
      settings: await this.sql("select name,setting from pg_settings where name in ('server_encoding','lc_collate','lc_ctype','shared_preload_libraries','max_locks_per_transaction') order by name"),
      availableExtensions: await this.sql("select name,default_version from pg_available_extensions order by name"),
      extensions: await this.sql("select extname,extversion from pg_extension order by extname") };
  }
  schema(ordered = false) {
    this.container();
    const dump = this.run("schema", "docker", ["exec", `supabase_db_${this.target.CI_DB_PROJECT_ID}`, "pg_dump", "-U", "postgres", "-d", "postgres", "--schema-only"]);
    return baselineHash(ordered ? orderedSchema(dump) : canonicalSchema(dump));
  }
  async history(names) {
    const versions = (await this.sql("select version from supabase_migrations.schema_migrations order by version")).map((row) => row.version);
    if (baselineJson(versions) !== baselineJson(names.map((name) => name.slice(0, 14)))) throw new Error("physical baseline migration history mismatch");
  }
  // The pristine-phase proofs of scripts/run-required-db-proofs.mjs. Each
  // rolls its transaction back and asserts the zero-organization state.
  proofs() {
    this.run("pristine-proofs", process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...PRISTINE_DB_PROOFS, "--maxWorkers=1"],
      { env: { ...this.env, REQUIRE_DB_REPAIR_PROOFS: "1", SUPABASE_DB_URL: this.target.SUPABASE_DB_URL } });
  }
  // The same start the lane's cold path uses: image pulls retried twice, one
  // replay from zero after a migration statement timeout.
  cold({ bootstrapOnly = false } = {}) {
    this.ensureLocalDocker();
    const status = startDisposableDbStack({
      CI_DB_WORKDIR: this.target.CI_DB_WORKDIR,
      [START_DEADLINE_ENV]: String(Date.now() + DISPOSABLE_DB_START_BUDGET_MS),
    }, { log: this.log, bootstrapOnly });
    if (status !== 0) throw new Error(`physical baseline start failed: status ${status}`);
  }
  cleanup() {
    this.ensureLocalDocker(true);
    try { this.cli("cleanup", ["stop", "--no-backup"]); }
    catch (error) { this.log(`Physical stop failed; removing exact-project containers: ${error.message}`); }
    removePhysicalProject(this.target.CI_DB_PROJECT_ID, this.run.bind(this));
  }
  stopPhysical() {
    const db = this.container();
    const ids = this.run("owned-services", "docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${this.target.CI_DB_PROJECT_ID}`]).trim().split(/\s+/).filter(Boolean);
    const containers = JSON.parse(this.run("owned-inspect", "docker", ["inspect", ...ids]));
    if (!containers.some((c) => c.Id === db.Id) || containers.some((c) => c.Config.Labels["com.supabase.cli.project"] !== this.target.CI_DB_PROJECT_ID)) throw new Error("physical service ownership mismatch");
    const volume = db.Mounts.find((m) => m.Destination === "/var/lib/postgresql/data" && m.Type === "volume");
    if (volume?.Name !== `supabase_db_${this.target.CI_DB_PROJECT_ID}`) throw new Error("unexpected physical data volume");
    const policy = db.HostConfig?.RestartPolicy;
    if (!["no", "always", "unless-stopped", "on-failure"].includes(policy?.Name)
      || !Number.isSafeInteger(policy.MaximumRetryCount) || policy.MaximumRetryCount < 0) throw new Error("unexpected physical restart policy");
    const restartPolicy = policy.Name === "on-failure" && policy.MaximumRetryCount ? `on-failure:${policy.MaximumRetryCount}` : policy.Name;
    // An explicit postmaster shutdown otherwise triggers `unless-stopped`
    // immediately. Keep and restore this owned container's own policy.
    this.run("physical-disable-restart", "docker", ["update", "--restart=no", db.Id]);
    const services = containers.filter((c) => c.Id !== db.Id).map((c) => c.Id);
    if (services.length) this.run("physical-stop-services", "docker", ["stop", "--time", "60", ...services]);
    // The CLI wraps postgres in `sh -c`; signalling PID 1 leaves the
    // postmaster running until Docker kills it. Stop the real postmaster
    // through pg_ctl, then require the container to exit cleanly.
    this.run("physical-db-shutdown", "docker", ["exec", "--user", "postgres", db.Id,
      "pg_ctl", "-D", volume.Destination, "-m", "fast", "-W", "stop"]);
    this.run("physical-db-wait", "docker", ["wait", db.Id], { timeout: minute });
    const stopped = JSON.parse(this.run("stopped-inspect", "docker", ["inspect", db.Id]))[0];
    if (stopped.Id !== db.Id || stopped.State.Running || stopped.State.ExitCode !== 0) throw new Error("database did not shut down cleanly");
    return { ids, databaseId: db.Id, restartPolicy, volume: volume.Name, imageId: db.Image };
  }
  // A throwaway container of the stopped database's own image, with no
  // network, that sees only this lab's data volume and one directory.
  helper(stopped, label, args, directory = this.output, readOnly = false) {
    return this.run(label, "docker", ["run", "--rm", "--label", `com.supabase.cli.project=${this.target.CI_DB_PROJECT_ID}`, "--network", "none", "--user", "0", "--entrypoint", "/bin/sh",
      "--mount", `type=volume,src=${stopped.volume},dst=/data`, "--mount", `type=bind,src=${directory},dst=/artifact${readOnly ? ",readonly" : ""}`, stopped.imageId, "-ec", ...args]);
  }
  restart(stopped) {
    this.run("physical-restart-policy", "docker", ["update", `--restart=${stopped.restartPolicy}`, stopped.databaseId]);
    this.run("physical-restart", "docker", ["start", ...stopped.ids]);
    // pg_isready waits inside the owned container, about a minute at most.
    this.run("database-ready", "docker", ["exec", `supabase_db_${this.target.CI_DB_PROJECT_ID}`, "sh", "-ec", "for n in $(seq 1 60); do pg_isready -U postgres -d postgres && exit 0; sleep 1; done; exit 1"]);
  }
  // The plan is a replay from zero ({ path: "from-zero", reason }) or an
  // incremental build ({ path: "incremental", reason, directory,
  // manifestSha256 }): the base snapshot the fetch verified is restored into
  // this lab through the pull request's own restore, which applies only the
  // newer migrations. Either way the lab then passes the same history, state
  // and proof checks, and the manifest records how it was made.
  async produce(directory, source, plan) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const names = migrationNames();
    const prefix = names.at(-1).slice(0, 14);
    const before = baselineJson(physicalIdentity(prefix, {}));
    let build;
    if (plan.path === "incremental") {
      const { manifest: base, suffix } = await this.restore(plan.directory, plan.manifestSha256);
      build = incrementalBuild(base, plan.manifestSha256, suffix, plan.reason);
    } else {
      this.cold();
      await this.history(names);
      build = fromZeroBuild(plan.reason);
    }
    await this.pristineState();
    this.proofs();
    const state = await this.pristineState();
    const runtime = await this.runtime();
    if (baselineJson(physicalIdentity(prefix, {})) !== before) throw new Error("physical producer source changed during the build");
    const identity = physicalIdentity(prefix, runtime);
    const schemaSha256 = this.schema();
    const orderedSchemaSha256 = this.schema(true);
    const stopped = this.stopPhysical();
    this.helper(stopped, "physical-export", ["tar -czf /artifact/data.tgz -C /data . && chmod 644 /artifact/data.tgz"], directory);
    const archive = readFileSync(join(directory, "data.tgz"));
    const manifest = { schema: 2, kind: "physical-disposable", identity, key: physicalKey(identity), schemaSha256, orderedSchemaSha256,
      archiveSha256: baselineHash(archive), archiveBytes: archive.length, pristine: true, state, source, build };
    const bytes = JSON.stringify(manifest) + "\n";
    writeFileSync(join(directory, "manifest.json"), bytes);
    return { manifest, trustedDigest: baselineHash(bytes) };
  }
  // A refusal of the snapshot itself (its bytes, identity, chain, runtime pins,
  // history, state or schema on this lab) carries `baseRefused`: the builder's
  // next attempt then replays from zero, since no other runner changes it.
  async restore(directory, trustedDigest, { grantProbeMigrations = [] } = {}) {
    const refusal = (error) => Object.assign(error, { baseRefused: true });
    // Source identity and archive bytes are checked before a lab is touched.
    let verified;
    try { verified = verifyPhysicalSnapshot(directory, trustedDigest); } catch (error) { throw refusal(error); }
    const { manifest, archive } = verified;
    const names = migrationNames();
    const prefix = manifest.identity.prefix;
    const suffix = suffixAfter(names, prefix);
    if (grantProbeMigrations.some((name) => !suffix.includes(name))) {
      throw new Error("physical baseline already includes a migration that must run under the public-table grant probe");
    }
    this.ensureLocalDocker();
    const verifiedDirectory = join(this.target.CI_DB_WORKDIR, "verified-physical-baseline");
    mkdirSync(verifiedDirectory, { mode: 0o700 });
    writeFileSync(join(verifiedDirectory, "data.tgz"), archive, { mode: 0o444, flag: "wx" });
    // The CLI creates this lab's own containers, network and volume without
    // replaying application migrations from the snapshot.
    this.cold({ bootstrapOnly: true });
    const { extensions: _installed, ...actualPins } = await this.runtime();
    const { extensions: expectedExtensions, ...expectedPins } = manifest.identity.runtime;
    const fields = runtimeMismatchFields(expectedPins, actualPins);
    if (fields.length) {
      throw refusal(Object.assign(new Error(`physical engine/image/extension availability mismatch: ${fields.join(", ")}`),
        { runtimeMismatch: { expected: expectedPins, actual: actualPins } }));
    }
    const stopped = this.stopPhysical();
    this.helper(stopped, "physical-import", [
      // Authenticated archive; still refuse links, devices and traversal.
      // Docker mounts only this lab's own volume, never a host data directory.
      physicalImportCommand(),
    ], verifiedDirectory, true);
    this.restart(stopped);
    if (baselineJson((await this.runtime()).extensions) !== baselineJson(expectedExtensions)) throw refusal(new Error("physical installed extension mismatch"));
    try { await this.history(names.filter((name) => name.slice(0, 14) <= prefix)); } catch (error) { throw refusal(error); }
    if (baselineJson(await this.pristineState()) !== baselineJson(manifest.state)) throw refusal(new Error("physical restored state differs from the snapshot's"));
    // The ordered digest also keeps function statement order; a sorted line
    // multiset alone could hide a changed function's control flow.
    if (this.schema() !== manifest.schemaSha256 || this.schema(true) !== manifest.orderedSchemaSha256) throw refusal(new Error("physical schema digest mismatch"));
    if (grantProbeMigrations.length) holdBackMigrations(this.target.CI_DB_WORKDIR, grantProbeMigrations);
    if (suffix.length > grantProbeMigrations.length) this.cli("suffix", ["migration", "up", "--local"]);
    if (grantProbeMigrations.length) {
      applyHeldBackGrantMigrations(this.target.CI_DB_WORKDIR, grantProbeMigrations, {
        probe: (step, ...args) => {
          this.run(`grant-probe-${step}`, process.execPath, [GRANT_PROBE_SCRIPT, step, ...args], {
            env: { ...this.env, ...this.target, CI_DB_GRANT_PROBE_ADDED: grantProbeMigrations.join(",") }, timeout: 120_000,
          });
          return { status: 0 };
        },
        migrate: () => {
          this.cli("grant-probe-migration", ["migration", "up", "--local"]);
          return { status: 0 };
        },
      });
    }
    await this.history(names);
    await this.pristineState();
    return { manifest, suffix };
  }
}

const labTarget = (env, prefix) => Object.fromEntries(["CI_DB_WORKDIR", "CI_DB_PROJECT_ID", "CI_DB_BASE_PORT", "SUPABASE_DB_URL"]
  .map((key) => [key, env[`${prefix}${key}`]]));

// ci.yml's `db` job, after the fetch chose a snapshot: restore it into the
// shared lab, then into the sensitive-rollout proof's own lab, one at a time.
// Any refusal fails the step; the job never falls back once it trusted a
// snapshot, and its cleanup step stops both labs by project.
export async function restoreLabs(env = process.env, { log = console.log, stackFor = (target, options) => new PhysicalStack(target, options) } = {}) {
  const directory = env.PHYSICAL_DB_BASELINE_DIRECTORY;
  const digest = env.PHYSICAL_DB_BASELINE_MANIFEST_SHA256;
  if (env.PHYSICAL_DB_BASELINE_MODE !== "warm" || !isAbsolute(directory ?? "") || !/^[a-f0-9]{64}$/.test(digest ?? "")) {
    throw new Error("physical-baseline-refused: no verified snapshot was chosen for this job");
  }
  const shared = assertBaselineTarget(labTarget(env, ""));
  const sensitive = assertBaselineTarget(labTarget(env, "SENSITIVE_PROOF_"), [shared]);
  const labs = [];
  for (const [name, target] of [["shared", shared], ["sensitive-rollout", sensitive]]) {
    const output = join(target.CI_DB_WORKDIR, "physical-baseline-logs");
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const began = performance.now();
    const grantProbeMigrations = name === "shared" ? (env.CI_DB_GRANT_PROBE_ADDED ?? "").split(",").filter(Boolean) : [];
    const { manifest, suffix } = await stackFor(target, { output, env, log }).restore(directory, digest, { grantProbeMigrations });
    const lab = { name, projectId: target.CI_DB_PROJECT_ID, prefix: manifest.identity.prefix, suffix, elapsedMs: Math.round(performance.now() - began) };
    labs.push(lab);
    const line = `Restored the ${name} lab (${lab.projectId}) from main ${manifest.source.commit} (producer run ${manifest.source.run}, manifest ${digest}) in ${Math.round(lab.elapsedMs / 1000)} s; applied on top: ${suffix.length ? suffix.join(", ") : "none"}`;
    log(line);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
  }
  if (env.PHYSICAL_DB_BASELINE_RECORD) {
    const record = JSON.parse(readFileSync(env.PHYSICAL_DB_BASELINE_RECORD, "utf8"));
    writeFileSync(env.PHYSICAL_DB_BASELINE_RECORD, JSON.stringify({ ...record, labs }, null, 2) + "\n");
  }
  return labs;
}

// One builder attempt. Every lab it prepares is written to the ledger
// (build.json) before it starts, so `--cleanup` can remove it even when the
// runner kills this process. `plan` is the produce() plan, with `path`
// "compare" for the periodic full replay: a replay from zero that is compared
// with `compare` (the snapshot this run built, snapshotComparison) and never
// round-tripped or published.
export async function buildPhysicalBaseline(output, {
  attemptId = randomUUID(),
  source,
  plan,
  compare = null,
  runner = null,
  prepare = prepareTargets,
  stackFor = (target, options) => new PhysicalStack(target, options),
} = {}) {
  if (!/^[a-f0-9-]{36}$/.test(attemptId)) throw new Error("invalid physical attempt identity");
  if (existsSync(join(output, "build.json"))) throw new Error("physical build output already exists; use a new directory");
  if (platform() !== "linux" || arch() !== "x64") throw new Error("the physical baseline is built only on linux x64, the runner the database lane uses");
  if (!["incremental", "from-zero", "compare"].includes(plan?.path) || !plan.reason || (plan.path === "compare") !== Boolean(compare)) throw new Error("invalid physical build plan");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const report = { schema: 2, attemptId, source, path: plan.path, reason: plan.reason, runner, complete: false, targets: [] };
  if (plan.path === "incremental") report.base = { run: plan.run, commit: plan.commit, manifestSha256: plan.manifestSha256 };
  if (compare) report.comparedWith = { run: compare.run, manifestSha256: compare.manifestSha256 };
  const save = () => {
    writeFileSync(join(output, "build.json.tmp"), JSON.stringify(report, null, 2) + "\n");
    renameSync(join(output, "build.json.tmp"), join(output, "build.json"));
  };
  const stacks = [];
  const live = new Set();
  const lab = async (name) => {
    const target = await prepare({ tempRoot: output, runKey: physicalRunKey(output, attemptId, name) });
    assertBaselineTarget(target, [...live]);
    report.targets.push({ name, projectId: target.CI_DB_PROJECT_ID }); save();
    const stack = stackFor(target, { output });
    stacks.push(stack); live.add(target);
    return stack;
  };
  const began = performance.now();
  save();
  try {
    const producer = await lab("producer");
    const artifact = join(output, "artifact");
    const published = await producer.produce(artifact, source, plan.path === "compare" ? { path: "from-zero", reason: plan.reason } : plan);
    report.manifest = { sha256: published.trustedDigest, prefix: published.manifest.identity.prefix,
      archiveBytes: published.manifest.archiveBytes, state: published.manifest.state, build: published.manifest.build };
    report.producedMs = Math.round(performance.now() - began); save();
    producer.cleanup(); live.delete(producer.target);
    if (compare) {
      report.mismatches = comparisonMismatches(compare, snapshotComparison(published.manifest, published.trustedDigest));
      if (report.mismatches.length) throw new Error(`the full replay differs from main run ${compare.run}'s snapshot (manifest ${compare.manifestSha256}): ${report.mismatches.join(", ")}`);
    } else {
      // The round trip is the pull request's own restore, into a fresh lab.
      const roundTrip = await lab("round-trip");
      const restoreBegan = performance.now();
      const { suffix } = await roundTrip.restore(artifact, published.trustedDigest);
      if (suffix.length) throw new Error(`the round trip applied migrations on top of a fresh snapshot: ${suffix.join(", ")}`);
      report.restoreMs = Math.round(performance.now() - restoreBegan);
      report.snapshot = snapshotComparison(published.manifest, published.trustedDigest);
    }
    report.complete = true;
  } catch (error) {
    report.failure = error.message;
    if (error.runtimeMismatch) report.runtimeMismatch = error.runtimeMismatch;
    // Only the base's own restore can refuse the base; the round trip's
    // refusal is this attempt's snapshot failing.
    if (error.baseRefused && plan.path === "incremental" && !report.manifest) report.baseRefused = true;
    throw error;
  } finally {
    report.elapsedMs = Math.round(performance.now() - began);
    for (const stack of [...stacks].reverse()) {
      try { stack.cleanup(); } catch (error) { (report.cleanupFailures ??= []).push(error.message); }
      (report.events ??= []).push({ projectId: stack.target.CI_DB_PROJECT_ID, events: stack.events });
    }
    if (report.cleanupFailures?.length) report.complete = false;
    save();
  }
  if (report.cleanupFailures?.length) throw new Error("physical build cleanup failed");
  return report;
}

// The attempt's plan, from the action's inputs and the fetch's decision
// (scripts/fetch-physical-db-baseline.mjs --builder, path `auto` only): its
// warm choice is the base of an incremental build, its cold one a replay from
// zero with the fetch's reason. Anything else refuses the attempt.
export function attemptPlan(env = process.env) {
  const path = env.PHYSICAL_BASELINE_PATH;
  if (path === "from-zero") return { plan: { path, reason: env.PHYSICAL_BASELINE_REASON || "a replay from zero was requested for this attempt" } };
  if (path === "compare") {
    const compare = JSON.parse(env.PHYSICAL_BASELINE_COMPARE || "null");
    if (!/^[a-f0-9]{64}$/.test(compare?.manifestSha256 ?? "") || !Number.isSafeInteger(compare.run) || !compare.inputsKey) throw new Error("the full replay needs the snapshot this run built (compare)");
    return { plan: { path, reason: `the periodic full replay, compared with main run ${compare.run}'s snapshot (${compare.path})` }, compare };
  }
  if (path !== "auto") throw new Error(`unknown physical build path '${path}'`);
  const record = isAbsolute(env.PHYSICAL_DB_BASELINE_RECORD ?? "") ? JSON.parse(readFileSync(env.PHYSICAL_DB_BASELINE_RECORD, "utf8")) : null;
  if (!record || record.mode !== env.PHYSICAL_DB_BASELINE_MODE) throw new Error("physical-baseline-refused: the base decision and its record disagree");
  if (record.mode === "cold") return { plan: { path: "from-zero", reason: record.reason } };
  if (record.mode !== "warm" || !isAbsolute(env.PHYSICAL_DB_BASELINE_DIRECTORY ?? "")
    || env.PHYSICAL_DB_BASELINE_MANIFEST_SHA256 !== record.source?.manifestSha256) throw new Error("physical-baseline-refused: no verified base was chosen for this attempt");
  return { plan: { path: "incremental", reason: `main run ${record.source.run}'s snapshot fits this tree; ${record.suffix.length} newer migration(s) to apply`,
    directory: env.PHYSICAL_DB_BASELINE_DIRECTORY, manifestSha256: record.source.manifestSha256, run: record.source.run, commit: record.source.commit } };
}

// The action's always-run step: what a next attempt does, and, for a complete
// attempt, the snapshot the full replay compares with.
export function attemptOutputs(output, requested) {
  const path = isAbsolute(output ?? "") ? join(output, "build.json") : null;
  const report = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const { next, reason } = nextAttempt(report, requested);
  const lines = [`next=${next}`, `reason=${reason}`];
  if (report?.complete && report.snapshot) lines.push(`snapshot=${JSON.stringify(report.snapshot)}`);
  return lines.join("\n") + "\n";
}

export function cleanupPhysicalBuild(output, { run } = {}) {
  const path = join(output, "build.json");
  if (!existsSync(path)) return;
  const targets = assertCleanupLedger(output, JSON.parse(readFileSync(path, "utf8")));
  const execute = run ?? ((label, command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", env: baselineEnvironment(process.env, output), timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${label} failed: ${result.error?.code ?? result.signal ?? result.status}`);
    return result.stdout;
  });
  if (!execute("cleanup-local-docker-context", "docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
    .trim().startsWith("unix://")) throw new Error("physical cleanup requires a local Unix-socket Docker context");
  const errors = [];
  for (const target of [...targets].reverse()) {
    try { removePhysicalProject(target.projectId, execute); } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join("; "));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes("--restore")) await restoreLabs();
    else if (process.argv.includes("--next")) {
      // Always answers, even when the attempt failed before it had an output
      // directory: the next attempt then repeats the requested path.
      const outputs = attemptOutputs(process.argv[process.argv.indexOf("--output") + 1], process.env.PHYSICAL_BASELINE_PATH);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
      console.log(outputs.split("\n").filter((line) => !line.startsWith("snapshot=")).join("\n"));
    } else {
      const output = process.argv[process.argv.indexOf("--output") + 1];
      if (!process.argv.includes("--output") || !isAbsolute(output ?? "")) throw new Error("--output requires an absolute runner temp directory");
      if (process.argv.includes("--cleanup")) cleanupPhysicalBuild(output);
      else if (process.argv.includes("--build")) {
        const { GITHUB_SHA: commit, GITHUB_RUN_ID: run } = process.env;
        if (!/^[a-f0-9]{40}$/.test(commit ?? "") || !/^[1-9]\d*$/.test(run ?? "")) throw new Error("--build runs only in a GitHub Actions run (GITHUB_SHA, GITHUB_RUN_ID)");
        const { plan, compare } = attemptPlan();
        console.log(`Physical baseline attempt: ${plan.path}. Why: ${plan.reason}`);
        const report = await buildPhysicalBaseline(output, { source: { commit, run: Number(run) }, plan, compare,
          runner: { cpu: process.env.PHYSICAL_BASELINE_CPU || null } });
        const line = report.path === "compare" ? `Full replay matches main run ${compare.run}'s snapshot (manifest ${compare.manifestSha256}).`
          : `Snapshot ${report.manifest.sha256} (last migration ${report.manifest.prefix}) ${describeBuild(report.manifest.build)}.`;
        console.log(line);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);
      } else throw new Error("usage: --build --output DIR | --cleanup --output DIR | --next --output DIR | --restore");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
