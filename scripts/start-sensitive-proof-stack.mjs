import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runWithDisposableDbStartAdmission,
  startDeadlineRemainingMs,
  supabaseCliBinary,
} from "./lib/disposable-db-start-admission.mjs";
import {
  createSensitiveProofStack,
  preStartedSensitiveProofStack,
  sensitiveProofLimits,
} from "../tests/helpers/sensitive-rollout-stack.mjs";

export function startPreparedSensitiveProofStack(env = process.env, {
  supabase = supabaseCliBinary(),
  run,
  now = () => performance.now(),
  wallNow = Date.now,
  log = console.log,
  replay,
} = {}) {
  // Validate the same isolated target tuple the proof will accept. This does
  // not export the success flag: the workflow does that after BOTH starts.
  const { workdir } = preStartedSensitiveProofStack({ ...env, SENSITIVE_PROOF_STACK_STARTED: "1" });
  // Admission ran the other target first or runs it next; both stay inside
  // the one start deadline the prepare step exported.
  const deadline = now() + startDeadlineRemainingMs(env, wallNow);
  // Keep the prepared target's existing maximum window independent of the
  // parent's duration, retaining its two-attempt limit,
  // cleanup accounting and minimum remaining budget for a second replay.
  const limits = { ...sensitiveProofLimits(), startupMs: 50 * 60_000 };
  // A start that crossed a migration statement limit (SQLSTATE 57014) gets
  // its one retry in a fresh window of the same size, still cut at the shared
  // deadline; never a third replay.
  const { result, attempts } = createSensitiveProofStack(supabase, workdir, {
    run, now, limits, deadline, replay, networkId: env.SENSITIVE_PROOF_NETWORK_ID, freshWindowOnStatementTimeout: true,
  }).start();
  log(`Sensitive-rollout startup attempts: ${JSON.stringify(attempts)}`);
  if (result.status !== 0) {
    throw new Error(`sensitive-proof-stack-start-failed: ${JSON.stringify({
      status: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    })}\n${String(result.stderr ?? "").slice(-8000)}`);
  }
  return attempts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const admitted = runWithDisposableDbStartAdmission(fileURLToPath(import.meta.url));
    if (admitted !== null) process.exitCode = admitted;
    else {
      // This edition's warm start is ci.yml's own `physical-db-baseline.mjs
      // --restore` step; this starter is the cold replay.
      if (startDeadlineRemainingMs() <= 0) throw new Error("Disposable DB start deadline has passed");
      startPreparedSensitiveProofStack();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
