import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
// Guarded operator entrypoint for the existing fictional SAMPLE lanes.
// `plan` is the default and performs no database call. Applying, verifying,
// and removing all require a pre-existing lane run and the exact SAMPLE ref.
import { createClient } from "@supabase/supabase-js";

import { presgConfig, resolvePresgPlan, assertExactTarget as assertPresgTarget } from "./presg-demo-config.mjs";
import { uniondemoConfig, resolveUniondemoPlan, assertExactTarget as assertUniondemoTarget } from "./uniondemo-config.mjs";

const MODES = new Set(["plan", "apply", "verify", "remove"]);
const LANES = new Set(["presg", "uniondemo"]);

export function parseDuesSampleArgs(argv) {
  const args = { mode: argv[0] || "plan", lane: "uniondemo", targetName: "local", profileName: "smoke" };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--lane" && value) args.lane = value;
    else if (flag === "--target" && value) args.targetName = value;
    else if (flag === "--profile" && value) args.profileName = value;
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  if (!MODES.has(args.mode)) throw new Error(`Unknown mode: ${args.mode}`);
  if (!LANES.has(args.lane)) throw new Error(`Unknown SAMPLE lane: ${args.lane}`);
  return args;
}

export function resolveDuesSamplePlan(args) {
  const plan = args.lane === "presg"
    ? resolvePresgPlan({ targetName: args.targetName, profileName: args.profileName })
    : resolveUniondemoPlan({ targetName: args.targetName, profileName: args.profileName });
  return { ...plan, lane: args.lane };
}

function laneConfig(lane) {
  return lane === "presg" ? presgConfig : uniondemoConfig;
}

function targetAssertion(lane) {
  return lane === "presg" ? assertPresgTarget : assertUniondemoTarget;
}

function confirmationEnvironment(lane) {
  return lane === "presg" ? "PRESG_DEMO_CONFIRM" : "UNIONDEMO_CONFIRM";
}

export function publicDuesSamplePlan(plan) {
  return {
    lane: plan.lane,
    target: plan.targetName,
    projectRef: plan.target.projectRef,
    runId: plan.runId,
    profile: plan.profileName,
    mode: "plan",
    zeroWrites: true,
    stripe: "unset",
    memberHistoryRows: 60,
    staffObligationRows: 60,
  };
}

function requireConfirmation(plan) {
  const environmentName = confirmationEnvironment(plan.lane);
  if (process.env[environmentName] !== laneConfig(plan.lane).confirmToken) {
    throw new Error(`${environmentName} must equal the checked-in SAMPLE confirmation token`);
  }
}

function requiredEnvironment(plan) {
  const suppliedUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || plan.target.url;
  const url = targetAssertion(plan.lane)(plan, suppliedUrl, {
    disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM,
  });
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required");
  return { url, serviceKey };
}

export async function runDuesSampleLane(client, { lane, runId, targetRef, confirmToken, mode }) {
  if (!LANES.has(lane) || !MODES.has(mode) || mode === "plan") throw new Error("Invalid Dues SAMPLE operation");
  const { data, error } = await client.rpc("authorize_dues_sample_seed", {
    p_target_ref: targetRef,
    p_confirm_token: confirmToken,
    p_lane: lane,
    p_run_id: runId,
    p_mode: mode,
  });
  if (error) throw new Error(`authorize_dues_sample_seed failed: ${error.message}`);
  return data;
}

export async function applyDuesSampleLane(client, lane, plan) {
  return runDuesSampleLane(client, {
    lane, runId: plan.runId, targetRef: plan.target.projectRef,
    confirmToken: laneConfig(lane).confirmToken, mode: "apply",
  });
}

export async function verifyDuesSampleLane(client, lane, plan) {
  return runDuesSampleLane(client, {
    lane, runId: plan.runId, targetRef: plan.target.projectRef,
    confirmToken: laneConfig(lane).confirmToken, mode: "verify",
  });
}

export async function removeDuesSampleLane(client, lane, plan) {
  return runDuesSampleLane(client, {
    lane, runId: plan.runId, targetRef: plan.target.projectRef,
    confirmToken: laneConfig(lane).confirmToken, mode: "remove",
  });
}

async function main() {
  const args = parseDuesSampleArgs(process.argv.slice(2));
  const plan = resolveDuesSamplePlan(args);
  if (args.mode === "plan") {
    process.stdout.write(`${JSON.stringify(publicDuesSamplePlan(plan))}\n`);
    return;
  }
  if (args.mode === "apply" || args.mode === "remove") requireConfirmation(plan);
  const environment = requiredEnvironment(plan);
  const client = createClient(environment.url, environment.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const result = await runDuesSampleLane(client, {
    lane: plan.lane,
    runId: plan.runId,
    targetRef: plan.target.projectRef,
    confirmToken: laneConfig(plan.lane).confirmToken,
    mode: args.mode,
  });
  process.stdout.write(`${JSON.stringify({ mode: args.mode, lane: plan.lane, result })}\n`);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  throw new Error("Retired pre-bot test fixture: direct execution is forbidden");
  if (false) main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "failed", message: error.message })}\n`);
    process.exitCode = 1;
  });
}
