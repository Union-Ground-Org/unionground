import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const ADMITTED = "--disposable-db-start-admitted";
const minute = 60_000;

// Admission runs the two cold starts one after the other, so their retries no
// longer overlap. Both share one deadline, written by the prepare step just
// before them: every start attempt on either target is cut at it, and a retry
// needs at least a full replay's worth of it. 95 minutes holds two afternoon
// replays (28-30 minutes each) plus one late statement-timeout retry, and ends
// the start step (plus a one-minute stop) at least 30 minutes before the DB
// job's 130-minute timeout, the proof tail's measured 20-30 minutes.
export const DISPOSABLE_DB_START_BUDGET_MS = 95 * minute;
export const DISPOSABLE_DB_MINIMUM_REPLAY_MS = 20 * minute;
export const START_DEADLINE_ENV = "CI_DB_START_DEADLINE_EPOCH_MS";

// node_modules/.bin/supabase is a Node shim that runs the platform package's
// bin/supabase through execFileSync without forwarding signals. Up to CLI
// 2.109.1 that binary was itself a launcher that ran bin/supabase-go for
// start and stop and ignored SIGTERM (PR #4566 round 3), so these helpers ran
// supabase-go. Since 2.121.0 bin/supabase implements init, start, stop,
// status and migration itself and supabase-go keeps only db and functions
// (`unknown command "init"`); bin/supabase exits on SIGTERM and takes its
// docker child with it. Resolve bin/supabase from the package the pinned shim
// would use (same override, same platform packages, resolved from the
// supabase package) and run it, so the deadline's signal reaches the process
// doing the work.
const SUPABASE_CLI_PACKAGES = {
  darwin: { arm64: ["darwin-arm64"], x64: ["darwin-x64"] },
  linux: { arm64: ["linux-arm64", "linux-arm64-musl"], x64: ["linux-x64", "linux-x64-musl"] },
  win32: { arm64: ["windows-arm64"], x64: ["windows-x64"] },
};

export function supabaseCliBinary({
  env = process.env,
  os = platform(),
  cpu = arch(),
  resolve = createRequire(new URL("../../node_modules/supabase/package.json", import.meta.url)).resolve,
} = {}) {
  if (env.SUPABASE_CLI_BINARY_OVERRIDE) return env.SUPABASE_CLI_BINARY_OVERRIDE;
  for (const suffix of SUPABASE_CLI_PACKAGES[os]?.[cpu] ?? []) {
    let bin;
    try {
      bin = join(dirname(resolve(`@supabase/cli-${suffix}/package.json`)), "bin");
    } catch { continue; /* try the next package the shim would try */ }
    return join(bin, `supabase${os === "win32" ? ".exe" : ""}`);
  }
  throw new Error(`No pinned Supabase CLI binary package for ${os}-${cpu}`);
}

export function startDeadlineRemainingMs(env = process.env, wallNow = Date.now) {
  const deadline = Number(env[START_DEADLINE_ENV]);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error(`${START_DEADLINE_ENV} must be the shared start deadline written by scripts/prepare-ci-disposable-db.mjs`);
  }
  return deadline - wallNow();
}

// Required PR workflows can use Main's shell while checking out candidate
// scripts. Enforce admission in both entry points as well as the workflow:
// the parent and sensitive targets share this runner-owned temporary root.
// flock holds across the whole child, including failed-start cleanup and
// retries, and the kernel releases it when the child exits. No polling,
// stale-owner recovery or cross-runner/repository concurrency group is needed.
export function runWithDisposableDbStartAdmission(entrypoint, {
  env = process.env,
  args = process.argv.slice(2),
  run = spawnSync,
} = {}) {
  if (args.includes(ADMITTED)) return null;
  if (!env.CI_DB_WORKDIR || !isAbsolute(env.CI_DB_WORKDIR)) {
    throw new Error("CI_DB_WORKDIR must be an absolute disposable workdir for startup admission");
  }
  const lock = join(dirname(env.CI_DB_WORKDIR), "unionground-lab-ci-start-admission.lock");
  console.log(`Disposable DB startup admission: ${lock}`);
  const result = run("flock", ["--exclusive", "--no-fork", lock, process.execPath, entrypoint, ...args, ADMITTED], {
    env, stdio: "inherit",
  });
  if (result.error) throw new Error(`disposable-db-start-admission-failed: ${result.error.message}`);
  return result.status ?? 1;
}
