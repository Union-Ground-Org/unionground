// Chooses how ci.yml's `db` job gets its labs (docs/contracts/ci.md,
// "Database lane"), and records the choice:
//
// - warm: the newest of the last PHYSICAL_SNAPSHOT_LOOKBACK snapshots that
//   main's producer published (.github/workflows/disposable-db-baseline.yml)
//   whose identity matches this tree. GitHub's own artifact digest is the
//   trust root for the downloaded ZIP; the manifest inside it must then name
//   this tree's CLI, configuration, platform and every migration up to its
//   prefix, byte for byte, and the producer run and commit it came from.
// - cold (a from-zero replay, announced as a warning): only when main has no
//   live snapshot yet (the bootstrap right after the producer merges, or every
//   snapshot expired), or when this change alters a stack input of the
//   snapshot (the Supabase configuration or the pinned CLI), which no newer
//   migration can bridge, or every otherwise suitable snapshot already
//   contains migrations this run must apply under the grant probe.
// - refused (the job fails): anything else. A snapshot whose bytes disagree
//   with GitHub's digest, a producer the manifest does not name, a branch
//   whose migrations none of the recent snapshots is a prefix of, or a GitHub
//   API that cannot be read. The job never passes without a database.
//
// With `--builder` it chooses the base of the snapshot builder's incremental
// build instead (.github/actions/physical-db-baseline): only producer runs
// older than the builder's own run, and when none of them fits, a replay from
// zero rather than a refusal, since main's own migrations are the truth the
// builder must reach. The warm choice's record names how its snapshot was
// built (manifest `build`), so the summary shows the chain.
//
// Ported from the sibling repository's scripts/fetch-physical-db-baseline.mjs,
// which falls back to a cold replay on every refusal.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyPhysicalSnapshot, migrationNames } from "./physical-db-baseline.mjs";
import {
  SNAPSHOT_ARTIFACT, TRUSTED_BRANCH, baselineHash, buildOf, describeBuild, selectTrustedRuns, suffixAfter, trustedRepository,
} from "./lib/physical-db-baseline.mjs";

// A branch behind main lacks main's newest migration, so the newest snapshot
// cannot fit it; an older one can. Five bounds the downloads when none fits.
export const PHYSICAL_SNAPSHOT_LOOKBACK = 5;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

export function fetchPhysicalBaseline(env = process.env, {
  log = console.log,
  execute = spawnSync,
  verify = verifyPhysicalSnapshot,
  names = migrationNames(),
  builder = false,
} = {}) {
  const record = join(env.RUNNER_TEMP ?? "", "physical-db-baseline-record.json");
  const decide = (decision) => {
    if (isAbsolute(env.RUNNER_TEMP ?? "")) {
      writeFileSync(record, JSON.stringify({ schema: 1, ...decision, refusedSnapshots: refused }, null, 2) + "\n");
    }
    const lines = decision.mode === "refused" ? [] : [`PHYSICAL_DB_BASELINE_MODE=${decision.mode}`, `PHYSICAL_DB_BASELINE_RECORD=${record}`,
      ...(decision.mode === "warm" ? [`PHYSICAL_DB_BASELINE_DIRECTORY=${decision.directory}`, `PHYSICAL_DB_BASELINE_MANIFEST_SHA256=${decision.source.manifestSha256}`] : [])];
    if (lines.length && env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, lines.join("\n") + "\n");
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `mode=${decision.mode}\n`);
    const summary = decision.mode === "warm"
      ? `${builder ? "Snapshot base" : "Database baseline"}: main ${decision.source.commit} (producer run ${decision.source.run}, last migration ${decision.source.prefix}, manifest ${decision.source.manifestSha256}), which ${describeBuild(decision.source.build)}. Migrations ${builder ? "this build applies" : "this job applies"} on top: ${decision.suffix.length ? decision.suffix.join(", ") : "none"}.`
      : decision.mode === "cold"
        ? builder ? `Snapshot base: none; this attempt replays every migration from zero. Why: ${decision.reason}`
          : `Database baseline: none used; both labs replay every migration from zero. Why: ${decision.reason}`
        : `${builder ? "Snapshot base refused; this attempt fails" : "Database baseline refused; the lane fails without a database"}. Why: ${decision.reason}`;
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${builder ? "Snapshot base" : "Database baseline"}\n\n- ${summary}\n`);
    log(decision.mode === "warm" ? summary : decision.mode === "cold" ? `::warning::PHYSICAL BASELINE COLD REPLAY: ${decision.reason}` : `::error::PHYSICAL BASELINE REFUSED: ${decision.reason}`);
    return decision;
  };
  const refused = [];
  try {
    if (!env.GITHUB_REPOSITORY || env.GITHUB_REPOSITORY !== trustedRepository(env)) throw new Error(`untrusted repository ${env.GITHUB_REPOSITORY}`);
    if (!isAbsolute(env.RUNNER_TEMP ?? "") || !env.GITHUB_ENV) throw new Error("runner environment required (RUNNER_TEMP, GITHUB_ENV)");
    // A base is always an older run, so a chain's runs only ever increase.
    if (builder && !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "")) throw new Error("runner environment required (GITHUB_RUN_ID)");
    const older = (run) => !builder || run.id < Number(env.GITHUB_RUN_ID);
    const run = (command, args, extra = {}) => {
      const result = execute(command, args, { encoding: "utf8", timeout: 90_000, maxBuffer: MAX_ARTIFACT_BYTES + 1024 * 1024, ...extra });
      if (result.status !== 0) {
        const error = new Error(`${command} ${args[0]} failed: ${result.error?.code ?? result.status}: ${String(result.stderr ?? "").trim().slice(-300)}`);
        error.notFound = /HTTP 404/.test(String(result.stderr ?? ""));
        throw error;
      }
      return result.stdout;
    };
    const api = (path) => JSON.parse(run("gh", ["api", `repos/${env.GITHUB_REPOSITORY}/${path}`]));
    let listed;
    try {
      listed = api(`actions/workflows/disposable-db-baseline.yml/runs?branch=${TRUSTED_BRANCH}&status=completed&per_page=20`).workflow_runs;
    } catch (error) {
      if (error.notFound) return decide({ mode: "cold", reason: "bootstrap: the snapshot producer (disposable-db-baseline.yml) is not on main yet" });
      throw error;
    }
    let candidates = 0;
    let newestStackInputs = null;
    let includesGrantProbeMigrations = false;
    const grantProbeMigrations = builder ? [] : (env.CI_DB_GRANT_PROBE_ADDED ?? "").split(",").filter(Boolean);
    for (const producer of selectTrustedRuns(listed, env.GITHUB_REPOSITORY).filter(older)) {
      if (candidates === PHYSICAL_SNAPSHOT_LOOKBACK) break;
      const artifact = api(`actions/runs/${producer.id}/artifacts?per_page=100`).artifacts?.find((entry) => entry.name === SNAPSHOT_ARTIFACT && !entry.expired);
      // Every attempt of that run failed, or its snapshot expired.
      if (!artifact) continue;
      candidates += 1;
      const directory = join(env.RUNNER_TEMP, `physical-db-baseline-${producer.id}`);
      let created = false;
      try {
        if (!(artifact.size_in_bytes <= MAX_ARTIFACT_BYTES) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")) throw new Error("oversized artifact or no GitHub digest");
        mkdirSync(directory, { mode: 0o700 }); created = true;
        const zip = run("gh", ["api", `repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { encoding: null });
        if (`sha256:${baselineHash(zip)}` !== artifact.digest) throw new Error("GitHub artifact ZIP digest mismatch");
        const path = join(directory, "artifact.zip");
        writeFileSync(path, zip, { mode: 0o600 });
        const entries = run("unzip", ["-Z1", path]).trim().split("\n").sort();
        if (JSON.stringify(entries) !== JSON.stringify(["data.tgz", "manifest.json"])) throw new Error("unexpected snapshot artifact entries");
        run("unzip", ["-q", path, "-d", directory]);
        rmSync(path);
        const manifestSha256 = baselineHash(readFileSync(join(directory, "manifest.json")));
        let manifest;
        try {
          ({ manifest } = verify(directory, manifestSha256));
        } catch (error) {
          newestStackInputs ??= error.stackInputs ?? [];
          throw error;
        }
        newestStackInputs ??= [];
        if (String(manifest.source?.run) !== String(producer.id) || manifest.source?.commit !== producer.head_sha) {
          throw new Error(`the manifest names producer run ${manifest.source?.run} at ${manifest.source?.commit}, not run ${producer.id} at ${producer.head_sha}`);
        }
        const prefix = manifest.identity.prefix;
        const suffix = suffixAfter(names, prefix);
        if (grantProbeMigrations.some((name) => !suffix.includes(name))) {
          includesGrantProbeMigrations = true;
          throw new Error("snapshot already includes a migration that must run under the public-table grant probe");
        }
        return decide({ mode: "warm", directory, reason: `${candidates - 1} newer main snapshot(s) did not fit this tree`,
          source: { run: producer.id, commit: producer.head_sha, event: producer.event, artifact: artifact.id, artifactDigest: artifact.digest, manifestSha256, prefix, build: buildOf(manifest) },
          suffix });
      } catch (error) {
        if (created) rmSync(directory, { recursive: true, force: true });
        refused.push(`run ${producer.id}: ${error.message}`);
        log(`Snapshot from main run ${producer.id} does not fit this tree: ${error.message}`);
      }
    }
    if (!candidates) return decide({ mode: "cold", reason: "bootstrap: no main run of the snapshot producer has a live snapshot (none yet, or every one expired)" });
    if (newestStackInputs?.length) {
      return decide({ mode: "cold", reason: `this change alters a stack input the newest main snapshot was built from (${newestStackInputs.join("; ")}); no newer migration can bridge that` });
    }
    if (includesGrantProbeMigrations) {
      return decide({ mode: "cold", reason: "no fitting snapshot predates every migration that must run under the public-table grant probe" });
    }
    if (builder) {
      return decide({ mode: "cold", reason: `none of the ${candidates} newest main snapshots is a prefix of this tree's migrations (${refused.join("; ")}); only a replay from zero reaches main's database` });
    }
    return decide({ mode: "refused", reason: `none of the ${candidates} newest main snapshots fits this tree (${refused.join("; ")}). Update the branch from main; a migration added here must sort after main's newest.` });
  } catch (error) {
    return decide({ mode: "refused", reason: error.message });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (fetchPhysicalBaseline(process.env, { builder: process.argv.includes("--builder") }).mode === "refused") process.exitCode = 1;
}
