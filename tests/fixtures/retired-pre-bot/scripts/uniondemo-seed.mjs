import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { createSensitiveServiceClient } from "../../../../api/_lib/sensitiveSupabase.js";
import { stageSensitiveDemoSeed } from "./sensitive-demo-seed.mjs";
// Driver for the Union Demo Org SAMPLE seed (20 chapters / 30k members /
// 800 stewards / 4 years of history).
//
//   node scripts/uniondemo-seed.mjs dry-run --target local --profile smoke
//   node scripts/uniondemo-seed.mjs apply   --target local --profile smoke
//   node scripts/uniondemo-seed.mjs verify  --target local --profile smoke
//   node scripts/uniondemo-seed.mjs status  --target local --profile smoke
//   node scripts/uniondemo-seed.mjs login   --target local --profile smoke
//   node scripts/uniondemo-seed.mjs remove  --target local --profile smoke
//
// apply/remove require UNIONDEMO_CONFIRM to equal the checked-in token;
// apply/verify/login require UNIONDEMO_PASSWORD (>= 24 chars) — the shared
// sign-in password every login-capable demo account gets, which is what the
// web app and the iOS/Android apps use during a demo.
import {
  activateKnowledgeSampleLane,
  knowledgeSampleLaneStatus,
  removeKnowledgeSampleLane,
} from "./mi1-knowledge-sample.mjs";
import {
  applyDuesSampleLane,
  removeDuesSampleLane,
  verifyDuesSampleLane,
} from "./mi1-dues-sample.mjs";
import {
  assertExactTarget,
  uniondemoConfig,
  uniondemoEmail,
  uniondemoUserId,
  publicPlan,
  resolveUniondemoPlan
} from "./uniondemo-config.mjs";

const allowedModes = new Set(["dry-run", "apply", "verify", "status", "login", "remove"]);

const ENRICH_PHASES = ["texture", "casework", "participation", "history"];

function parseArgs(argv) {
  const args = { mode: argv[0] || "dry-run", targetName: "local", profileName: "smoke" };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--target" && value) args.targetName = value;
    else if (flag === "--profile" && value) args.profileName = value;
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  if (!allowedModes.has(args.mode)) throw new Error(`Unknown mode: ${args.mode}`);
  return args;
}

function emit(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

function requireConfirm() {
  if (process.env.UNIONDEMO_CONFIRM !== uniondemoConfig.confirmToken) {
    throw new Error("UNIONDEMO_CONFIRM does not match the checked-in confirmation token");
  }
}

function requirePassword() {
  const loginCredential = Reflect.get(process.env, "UNIONDEMO_PASSWORD") || "";
  if (loginCredential.length < 24) throw new Error("UNIONDEMO_PASSWORD must contain at least 24 characters");
  return loginCredential;
}

function requiredEnvironment(plan, { password = false } = {}) {
  const suppliedUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || plan.target.url;
  const url = assertExactTarget(plan, suppliedUrl, {
    disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM,
  });
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required");
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  return { url, serviceKey, publishableKey, password: password ? requirePassword() : undefined };
}

function serviceClient(url, key) {
  return createSensitiveServiceClient(url, key);
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}

function commonArgs(plan) {
  return {
    p_run_id: plan.runId,
    p_target_ref: plan.target.projectRef,
    p_confirm_token: uniondemoConfig.confirmToken
  };
}

async function apply(plan, env) {
  requireConfirm();
  const client = serviceClient(env.url, env.serviceKey);
  const begun = await rpc(client, "uniondemo_begin", {
    ...commonArgs(plan),
    p_dataset_version: uniondemoConfig.datasetVersion,
    p_member_count: plan.profile.memberCount,
    p_steward_count: plan.profile.stewardCount,
    p_login_count: plan.profile.loginCount,
    p_config_hash: plan.configHash
  });
  emit("ledger-ready", begun);

  if (begun.resumed) {
    emit("reapply-guard", await rpc(client, "uniondemo_prepare_reapply", {
      ...commonArgs(plan),
      p_password: env.password,
    }));

    // A completed parity run may own rows with restrictive foreign keys back
    // to member_cases. Remove that owned layer before apply_batch rebuilds the
    // deterministic member history; the parity phase below restores it.
    emit("reapply-cleanup", await rpc(client, "uniondemo_remove_function_parity", commonArgs(plan)));
  }

  for (let chapter = 1; chapter <= uniondemoConfig.chapterCount; chapter += 1) {
    const result = await rpc(client, "uniondemo_seed_org", {
      ...commonArgs(plan),
      p_chapter_index: chapter
    });
    if (chapter === 1 || chapter === uniondemoConfig.chapterCount) emit("org", result);
  }

  const batches = Math.ceil(plan.profile.memberCount / plan.profile.batchSize);
  for (let batch = 0; batch < batches; batch += 1) {
    const start = batch * plan.profile.batchSize + 1;
    const result = await rpc(client, "uniondemo_apply_batch", {
      ...commonArgs(plan),
      p_start_ordinal: start,
      p_batch_count: plan.profile.batchSize,
      p_password: env.password
    });
    if (batch === 0 || batch + 1 === batches) emit("apply-progress", { batch: batch + 1, batches, ...result });
  }

  for (let batch = 0; batch < batches; batch += 1) {
    const start = batch * plan.profile.batchSize + 1;
    const result = await rpc(client, "uniondemo_enrich_batch", {
      ...commonArgs(plan),
      p_phase: "roles",
      p_start_ordinal: start,
      p_batch_count: plan.profile.batchSize
    });
    if (batch === 0 || batch + 1 === batches) emit("roles-progress", { batch: batch + 1, batches, ...result });
  }

  for (let chapter = 1; chapter <= uniondemoConfig.chapterCount; chapter += 1) {
    const result = await rpc(client, "uniondemo_seed_channels", {
      ...commonArgs(plan),
      p_chapter_index: chapter
    });
    if (chapter === 1 || chapter === uniondemoConfig.chapterCount) emit("channels", result);
  }

  for (const phase of ENRICH_PHASES) {
    for (let batch = 0; batch < batches; batch += 1) {
      const start = batch * plan.profile.batchSize + 1;
      const result = await rpc(client, "uniondemo_enrich_batch", {
        ...commonArgs(plan),
        p_phase: phase,
        p_start_ordinal: start,
        p_batch_count: plan.profile.batchSize
      });
      if (batch === 0 || batch + 1 === batches) emit("enrich-progress", { phase, batch: batch + 1, batches, ...result });
    }
  }

  emit("dues", await applyDuesSampleLane(client, "uniondemo", plan));

  // Activate before the aggregate parity phase so an unrelated gated function
  // cannot leave these five landed functions falsely catalog-only. Reapply
  // after parity because that phase rebuilds the shared evidence tables.
  await activateKnowledgeSampleLane(client, "uniondemo", plan.runId);
  await stageSensitiveDemoSeed(client, "uniondemo", plan.runId);
  const parity = await rpc(client, "uniondemo_seed_function_parity", commonArgs(plan));
  emit("function-parity", parity);
  if (!parity.ok) throw new Error("Function parity or two-page verification did not pass");
  await activateKnowledgeSampleLane(client, "uniondemo", plan.runId);

  const verified = await rpc(client, "uniondemo_verify", {
    p_run_id: plan.runId,
    p_password: env.password
  });
  emit("verified", verified);
  if (!verified.ok) throw new Error("Database verification did not pass");
  emit("dues", await verifyDuesSampleLane(client, "uniondemo", plan));
}

async function verify(plan, env) {
  const client = serviceClient(env.url, env.serviceKey);
  const result = await rpc(client, "uniondemo_verify", { p_run_id: plan.runId, p_password: env.password });
  emit("verified", result);
  if (!result.ok) throw new Error("Database verification did not pass");
  emit("dues", await verifyDuesSampleLane(client, "uniondemo", plan));
  await stageSensitiveDemoSeed(client, "uniondemo", plan.runId);
  const parity = await rpc(client, "uniondemo_function_parity_status", { p_run_id: plan.runId });
  emit("function-parity", parity);
  if (!parity.ok) throw new Error("Function parity or two-page verification did not pass");
  await knowledgeSampleLaneStatus(client, "uniondemo", plan.runId, true, true);
}

async function status(plan, env) {
  const client = serviceClient(env.url, env.serviceKey);
  emit("status", await rpc(client, "uniondemo_status", { p_run_id: plan.runId }));
  emit("function-parity", await rpc(client, "uniondemo_function_parity_status", { p_run_id: plan.runId }));
  await knowledgeSampleLaneStatus(client, "uniondemo", plan.runId, false);
}

async function login(plan, env) {
  if (!env.publishableKey) throw new Error("A publishable or anon key is required for the login proof");
  const proofOrdinals = [1, Math.min(plan.profile.stewardCount + 1, plan.profile.loginCount), plan.profile.loginCount].filter(
    (ordinal, index, list) => ordinal >= 1 && list.indexOf(ordinal) === index
  );
  for (const ordinal of proofOrdinals) {
    const email = uniondemoEmail(plan.runId, ordinal);
    const response = await fetch(`${env.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: env.publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password: env.password })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token || !body.user?.id) {
      throw new Error(`Login failed for ${email}: HTTP ${response.status}`);
    }
    if (body.user.id !== uniondemoUserId(plan.runId, ordinal)) {
      throw new Error(`Unexpected user id for ordinal ${ordinal}`);
    }
  }
  emit("login-proof", { accounts: proofOrdinals.length, passed: true });
}

async function remove(plan, env) {
  requireConfirm();
  const client = serviceClient(env.url, env.serviceKey);
  emit("dues-remove", await removeDuesSampleLane(client, "uniondemo", plan));
  await removeKnowledgeSampleLane(client, "uniondemo", plan.runId);
  emit("function-parity-remove", await rpc(client, "uniondemo_remove_function_parity", commonArgs(plan)));
  emit("removal-preflight", await rpc(client, "uniondemo_begin_remove", commonArgs(plan)));
  let remaining = plan.profile.memberCount;
  let batches = 0;
  while (remaining > 0) {
    const result = await rpc(client, "uniondemo_remove_batch", {
      ...commonArgs(plan),
      p_batch_count: plan.profile.batchSize
    });
    batches += 1;
    remaining = result.remaining;
    if (result.state === "removed" || batches % 5 === 0) emit("remove-progress", { batches, ...result });
    if (result.state === "removed") break;
  }
  emit("function-parity-finalize", await rpc(client, "uniondemo_remove_function_parity", commonArgs(plan)));
  const finalStatus = await rpc(client, "uniondemo_status", { p_run_id: plan.runId });
  emit("removed", finalStatus);
  if (finalStatus.state !== "removed" || finalStatus.auth_users !== 0 || !finalStatus.protected_unchanged) {
    throw new Error("Removal verification did not pass");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = resolveUniondemoPlan(args);
  emit("plan", publicPlan(plan));
  if (args.mode === "dry-run") return;
  const needsPassword = ["apply", "verify", "login"].includes(args.mode);
  const env = requiredEnvironment(plan, { password: needsPassword });
  if (args.mode === "apply") await apply(plan, env);
  else if (args.mode === "verify") await verify(plan, env);
  else if (args.mode === "status") await status(plan, env);
  else if (args.mode === "login") await login(plan, env);
  else if (args.mode === "remove") await remove(plan, env);
}

if (false) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: "failed", message: error.message })}\n`);
  process.exitCode = 1;
});
