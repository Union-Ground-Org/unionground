import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { createClient } from "@supabase/supabase-js";
import { assertExactTarget, publicPlan, resolveStressPlan, stressConfig } from "./member-stress-config.mjs";

// Enrichment lane for a ledgered stress run (REQ-UG-STRESS-RESEED-ORGS-20260726).
//
// `stress:seed` produces 100,000 members who are byte-identical clones sitting
// in one chapter, because member_stress_apply_batch only writes auth.users and
// private.handle_new_member fans out one fixed shape. This lane reshapes that
// output into a believable multi-agency local: chapter/agency spread, real
// names and job titles, globally unique case references, and participation
// across the surfaces the seed leaves empty.
//
// ORDER MATTERS. Run this AFTER `stress:verify` has passed: the stock verifier
// asserts exact per-member multiples (n*3 notifications, n*4 cases, ...) that
// enrichment deliberately breaks. member_stress_verify never downgrades run
// state and member_stress_begin_remove accepts 'verified', so a later failing
// re-verify costs nothing and teardown still works.

const PHASES = [
  { name: "profile", note: "chapter/agency spread, names, role lines, member_since, language" },
  { name: "texture", note: "notification/conversation/message variety (kind stays 'general')" },
  { name: "cases", note: "unique references, varied type/step/status, case timelines" },
  { name: "rights", note: "additional rights-lesson progress" },
  { name: "participation", note: "rsvps, check-ins, surveys, broadcasts, steward requests, forms, workload, guide" },
  { name: "ballots", note: "ballot turnout (receipts follow by trigger)" },
  { name: "points", note: "backdated point history — never through the award trigger" },
  { name: "roles", note: "chapter-scoped stewards" },
];

const allowedModes = new Set(["plan", "run", "verify"]);

function parseArgs(argv) {
  const args = { mode: argv[0] || "plan", targetName: "local", profileName: "smoke", only: null, batch: 2000 };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--target" && value) args.targetName = value;
    else if (flag === "--profile" && value) args.profileName = value;
    else if (flag === "--only" && value) args.only = value.split(",").map((phase) => phase.trim());
    else if (flag === "--batch" && value) args.batch = Number.parseInt(value, 10);
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  if (!allowedModes.has(args.mode)) throw new Error(`Unknown mode: ${args.mode}`);
  if (!Number.isInteger(args.batch) || args.batch < 1 || args.batch > 5000) {
    throw new Error("--batch must be between 1 and 5000");
  }
  if (args.only) {
    const known = new Set(PHASES.map((phase) => phase.name));
    for (const phase of args.only) if (!known.has(phase)) throw new Error(`Unknown phase: ${phase}`);
  }
  return args;
}

function emit(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

function requireConfirm() {
  if (process.env.MEMBER_STRESS_CONFIRM !== stressConfig.confirmToken) {
    throw new Error("MEMBER_STRESS_CONFIRM does not match the checked-in confirmation token");
  }
}

function requiredEnvironment(plan) {
  const suppliedUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || plan.target.url;
  const url = assertExactTarget(plan, suppliedUrl);
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required");
  return { url, serviceKey };
}

function serviceClient(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

async function run(plan, env, args) {
  requireConfirm();
  const client = serviceClient(env.url, env.serviceKey);
  const phases = args.only ? PHASES.filter((phase) => args.only.includes(phase.name)) : PHASES;
  const batches = Math.ceil(plan.profile.memberCount / args.batch);

  for (const phase of phases) {
    const started = Date.now();
    let touched = 0;
    for (let batch = 0; batch < batches; batch += 1) {
      const start = batch * args.batch + 1;
      const result = await rpc(client, "member_stress_enrich_batch", {
        p_run_id: plan.runId,
        p_phase: phase.name,
        p_start_ordinal: start,
        p_batch_count: args.batch,
        p_target_ref: plan.target.projectRef,
        p_confirm_token: stressConfig.confirmToken,
      });
      touched += result?.touched ?? 0;
      if ((batch + 1) % 10 === 0 || batch + 1 === batches) {
        emit("phase-progress", { phase: phase.name, batch: batch + 1, batches, touched });
      }
    }
    emit("phase-done", { phase: phase.name, touched, seconds: Math.round((Date.now() - started) / 1000) });
  }

  const verified = await rpc(client, "member_stress_enrich_verify", { p_run_id: plan.runId });
  emit("verified", verified);
  if (!verified.ok) throw new Error("Enrichment verification did not pass");
}

async function verify(plan, env) {
  const client = serviceClient(env.url, env.serviceKey);
  const result = await rpc(client, "member_stress_enrich_verify", { p_run_id: plan.runId });
  emit("verified", result);
  if (!result.ok) throw new Error("Enrichment verification did not pass");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = resolveStressPlan(args);
  emit("plan", { ...publicPlan(plan), phases: PHASES.map((phase) => phase.name), batch: args.batch });
  if (args.mode === "plan") return;
  const env = requiredEnvironment(plan);
  if (args.mode === "run") await run(plan, env, args);
  else if (args.mode === "verify") await verify(plan, env);
}

if (false) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: "failed", message: error.message })}\n`);
  process.exitCode = 1;
});
