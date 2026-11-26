import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { assertDisposableProofUrl } from "../../scripts/run-required-db-proofs.mjs";
import { replayWithCronPaused } from "../../scripts/lib/disposable-db-cron.mjs";

// The proof's own stack replays every migration from zero, the same replay the
// parent CI stack runs. CI starts it after the parent on their shared runner (see
// preStartedSensitiveProofStack); a proof run without one starts it here. That
// self-start window follows that measured replay
// (DISPOSABLE_DB_REPLAY_MS, written by the parent start step) with a 1.5x
// margin for runner load, never below the old fixed 25 minutes and never
// above 50. 2026-10-05: the parent replay took 20 minutes at 570 migrations in
// the morning and 28-30 minutes on loaded afternoon runners; the fixed window
// timed out at 571 and 573. About 15 migrations that run the account-lifecycle
// catalog scans account for most of the replay; the rest take milliseconds.
const minute = 60_000;
export function sensitiveProofLimits(parentReplayMs) {
  const measured = Number(parentReplayMs);
  const known = Number.isFinite(measured) && measured > 0;
  const startupMs = known ? Math.min(50 * minute, Math.max(25 * minute, Math.ceil(measured * 1.5))) : 25 * minute;
  return Object.freeze({
    prepareMs: 60_000,
    startupMs,
    // Retry only when enough of the shared window remains for another
    // replay: 20 minutes, or the measured parent replay when that is longer.
    minimumRetryMs: Math.min(startupMs, Math.max(20 * minute, known ? Math.ceil(measured) : 0)),
    commandMs: 60_000,
    assertionsMs: 10 * minute,
    testMs: 65 * minute,
  });
}

export const SENSITIVE_PROOF_LIMITS = sensitiveProofLimits(process.env.DISPOSABLE_DB_REPLAY_MS);

export const EXCLUDED_SERVICES = "studio,imgproxy,mailpit,edge-runtime,logflare,vector";

// Migrations from 20260907150000 until 20260929034500 replaced the regex
// trigger surface (BUG-UG-ACCOUNT-LIFECYCLE-TRIGGER-INVENTORY-TIMEOUT-20260928)
// still run its CPU-bound inventory scans under their own 30s/60s/120s
// statement limits on every from-zero replay. A slow or contended runner can
// cross one (SQLSTATE 57014, PR #4075 runs 37811322037 and 37819006581,
// October 8, 2026). The migration bytes are checked against the checkout, so
// a start that failed that way earns one fresh replay instead.
export function failedOnStatementTimeout(result) {
  return result?.status !== 0 && /SQLSTATE 57014/.test(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
}

export function createSensitiveProofStack(supabase, workdir, {
  run = spawnSync,
  limits = SENSITIVE_PROOF_LIMITS,
  now = () => performance.now(),
  networkId = process.env.SENSITIVE_PROOF_NETWORK_ID,
  freshWindowOnStatementTimeout = false,
  // An outer deadline in the same `now()` timebase; no attempt runs past it.
  deadline = Infinity,
  replay = replayWithCronPaused,
} = {}) {
  const invoke = (args, timeout) => run(supabase, ["--workdir", workdir, ...args], {
    encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024,
  });
  const command = (...args) => invoke(args, limits.commandMs);
  const start = () => {
    let began = now();
    const attempts = [];
    let result = { status: null, signal: null, error: { code: "STARTUP_BUDGET_EXHAUSTED" } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = Math.floor(Math.min(limits.startupMs - (now() - began), deadline - now()));
      if (remaining < (attempt === 0 ? 1 : limits.minimumRetryMs)) break;
      result = replay({ workdir, invoke, run,
        startArgs: ["start", ...(networkId ? ["--network-id", networkId] : []), "--exclude", EXCLUDED_SERVICES],
        timeout: remaining, now });
      attempts.push({
        status: result.status, signal: result.signal,
        errorCode: result.error?.code ?? null,
        timeoutMs: remaining, elapsedMs: Math.ceil(now() - began),
      });
      if (result.status === 0) break;
      // Cleanup is part of the same elapsed startup window. Never overlap a
      // retry with a stack that did not stop, or discard its cleanup failure.
      const stopped = command("stop", "--no-backup");
      if (stopped.status !== 0) {
        throw new Error(`sensitive-proof-stack-retry-cleanup-failed: ${JSON.stringify({ attempts, status: stopped.status, signal: stopped.signal, errorCode: stopped.error?.code ?? null })}\nStartup stderr:\n${String(result.stderr ?? "").slice(-8000)}\nCleanup stderr:\n${String(stopped.stderr ?? "").slice(-8000)}`);
      }
      // A late statement-limit failure would leave the one retry too little of
      // the shared window for a full replay; give that retry a fresh one.
      if (freshWindowOnStatementTimeout && failedOnStatementTimeout(result)) began = now();
    }
    return { result, attempts };
  };
  return { command, start };
}

// CI prepares the proof's own empty project with the shared one and replays
// both before the proofs (.github/workflows/ci.yml, "Start disposable DB verification
// target"). It sets SENSITIVE_PROOF_STACK_STARTED=1 only after that start
// succeeded. Anything partial, or anything that could be the shared proof
// stack other suites commit fixtures to, is refused, never silently replaced.
export function preStartedSensitiveProofStack(env = process.env) {
  if (env.SENSITIVE_PROOF_STACK_STARTED !== "1") return null;
  const workdir = env.SENSITIVE_PROOF_CI_DB_WORKDIR;
  if (!workdir || !isAbsolute(workdir)) throw new Error("sensitive-proof-stack-workdir-missing");
  const url = assertDisposableProofUrl(env.SENSITIVE_PROOF_SUPABASE_DB_URL);
  const shared = assertDisposableProofUrl(env.SUPABASE_DB_URL);
  if (new URL(url).port === new URL(shared).port || workdir === env.CI_DB_WORKDIR) {
    throw new Error("sensitive-proof-stack-is-the-shared-stack");
  }
  return { workdir, url };
}

// Every repository migration version, in order. The proof's stack must hold
// exactly these before the ENC tail is reconstructed: a full from-zero replay
// of this head, whichever path started it.
export function repositoryMigrationVersions(directory = new URL("../../supabase/migrations/", import.meta.url)) {
  return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => name.slice(0, 14));
}
