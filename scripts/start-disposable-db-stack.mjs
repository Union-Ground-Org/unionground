import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXCLUDED_SERVICES, failedOnStatementTimeout } from "../tests/helpers/sensitive-rollout-stack.mjs";
import { replayWithCronPaused } from "./lib/disposable-db-cron.mjs";
import { holdBackMigrations, releaseMigrations } from "./lib/public-table-grant-probe.mjs";
import {
  DISPOSABLE_DB_MINIMUM_REPLAY_MS,
  runWithDisposableDbStartAdmission,
  startDeadlineRemainingMs,
  supabaseCliBinary,
} from "./lib/disposable-db-start-admission.mjs";

export const GRANT_PROBE_SCRIPT = fileURLToPath(new URL("./grant-probe-step.mjs", import.meta.url));

export function applyHeldBackGrantMigrations(workdir, added, { probe, migrate }) {
  const revoked = probe("revoke");
  if (revoked.status !== 0) return revoked;
  // Rehearse each file against its exact predecessor before the CLI applies
  // it. Releasing one at a time also supports dependent added migrations.
  for (const file of [...added].sort()) {
    const rehearsed = probe("hosted", file);
    if (rehearsed.status !== 0) return rehearsed;
    releaseMigrations(workdir, [file]);
    const applied = migrate();
    if (applied.status !== 0) return applied;
  }
  return probe("restore");
}

// A GitHub runner pulls every stack image cold, and a registry can refuse a
// burst ("toomanyrequests", "Data limit exceeded"; run 39844043581). The CLI
// retries each pull twice within seconds. A start that still failed to pull is
// stopped and started again after these waits; images that did pull stay in
// the daemon, so a retry fetches only what is missing.
export const IMAGE_PULL_RETRY_DELAYS_MS = [30_000, 90_000];

export function failedOnImagePull(result) {
  return result?.status !== 0 && /failed to pull docker image/i.test(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
}

const blockingPause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Starts the shared disposable stack from zero. A replay that crossed a
// migration's own statement limit on a slow runner (see
// failedOnStatementTimeout) is stopped and replayed once more from zero; any
// other failure, or a second timeout, still fails the step. Both attempts are
// cut at the start deadline the two targets share, and the retry runs only
// when a full replay's worth of it remains. A failed start is stopped (one
// bounded minute) before this process exits and releases admission.
export function startDisposableDbStack(env = process.env, {
  supabase = supabaseCliBinary(),
  run = spawnSync,
  log = console.log,
  wallNow = Date.now,
  bootstrapOnly = false,
  replay = replayWithCronPaused,
  write = (result) => { process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); },
  pause = blockingPause,
} = {}) {
  const workdir = env.CI_DB_WORKDIR;
  if (!workdir || !isAbsolute(workdir)) throw new Error("CI_DB_WORKDIR must be an absolute disposable workdir");
  const remaining = () => startDeadlineRemainingMs(env, wallNow);
  remaining();
  const invoke = (args, timeout) => run(supabase, ["--workdir", workdir, ...args], {
    encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
  });
  const stop = () => invoke(["stop", "--no-backup"], 60_000);
  const start = () => {
    const timeout = Math.floor(remaining());
    if (timeout < 1) {
      log("Disposable DB start deadline has passed; not starting the shared stack.");
      return { status: null, signal: null, error: { code: "STARTUP_BUDGET_EXHAUSTED" } };
    }
    const result = replay({ workdir, invoke, run, startArgs: ["start", "--exclude", EXCLUDED_SERVICES], timeout, bootstrapOnly });
    write(result);
    if (result.error?.code === "ETIMEDOUT") log(`Disposable DB start reached the shared start deadline after ${timeout} ms.`);
    return result;
  };
  // Public-table grant probe (docs/conventions/public-table-grants.md): the
  // change's added migrations stay out of the first replay and are applied
  // afterwards, unchanged, with the default table privileges revoked.
  const added = (env.CI_DB_GRANT_PROBE_ADDED ?? "").split(",").filter(Boolean);
  if (added.length) holdBackMigrations(workdir, added);
  const probe = (step, ...args) => {
    const checked = run(process.execPath, [GRANT_PROBE_SCRIPT, step, ...args],
      { encoding: "utf8", env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    write(checked);
    return checked;
  };
  const migrate = () => {
    const timeout = Math.floor(remaining());
    if (timeout < 1) return { status: null, signal: null, error: { code: "STARTUP_BUDGET_EXHAUSTED" } };
    const applied = invoke(["migration", "up", "--local"], timeout);
    write(applied);
    return applied;
  };
  let result = start();
  for (const delay of IMAGE_PULL_RETRY_DELAYS_MS) {
    if (!failedOnImagePull(result)) break;
    const stopped = stop();
    if (stopped.status !== 0) throw new Error(`disposable-db-stack-pull-retry-cleanup-failed: status ${stopped.status}`);
    const left = Math.floor(remaining()) - delay;
    if (left < DISPOSABLE_DB_MINIMUM_REPLAY_MS) {
      log(`Only ${left} ms of the shared start deadline would remain after waiting, less than a full replay; not retrying the image pulls.`);
      return result.status ?? 1;
    }
    log(`Disposable DB stack images did not pull; starting again in ${delay / 1000} s.`);
    pause(delay);
    // start() re-reads the shared deadline and writes this attempt's output.
    result = start();
  }
  if (failedOnStatementTimeout(result)) {
    log("Disposable DB replay crossed a migration statement limit (SQLSTATE 57014); stopping it.");
    const stopped = stop();
    if (stopped.status !== 0) throw new Error(`disposable-db-stack-retry-cleanup-failed: status ${stopped.status}`);
    const left = Math.floor(remaining());
    if (left < DISPOSABLE_DB_MINIMUM_REPLAY_MS) {
      log(`Only ${left} ms of the shared start deadline remain, less than a full replay; not replaying.`);
      return result.status ?? 1;
    }
    log("Replaying the shared stack once from zero.");
    result = start();
  }
  if (result.status === 0 && added.length) {
    log(`Applying ${added.length} added migration(s) with default table privileges revoked (public-table grant probe).`);
    result = applyHeldBackGrantMigrations(workdir, added, { probe, migrate });
  }
  if (result.status !== 0 && result.error?.code !== "STARTUP_BUDGET_EXHAUSTED") {
    // Never release admission (or leave the workflow cleanup) with a start
    // that may still be running or holding the daemon.
    const stopped = stop();
    log(`Stopped the failed shared stack before releasing admission: status ${stopped.status}${stopped.error ? ` (${stopped.error.code})` : ""}.`);
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const admitted = runWithDisposableDbStartAdmission(fileURLToPath(import.meta.url));
    if (admitted !== null) process.exitCode = admitted;
    else {
      // This edition's warm start is ci.yml's own `physical-db-baseline.mjs
      // --restore` step; this starter is the cold replay.
      if (startDeadlineRemainingMs() <= 0) throw new Error("Disposable DB start deadline has passed");
      process.exitCode = startDisposableDbStack();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
