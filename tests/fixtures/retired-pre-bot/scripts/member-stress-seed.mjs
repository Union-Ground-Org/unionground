import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { createClient } from "@supabase/supabase-js";
import { percentile } from "./member-active-user-load-lib.mjs";
import {
  assertExactTarget,
  publicPlan,
  resolveStressPlan,
  stressConfig,
  stressEmail,
  stressUserId
} from "./member-stress-config.mjs";

const allowedModes = new Set(["dry-run", "apply", "verify", "status", "load", "remove"]);

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
  if (process.env.MEMBER_STRESS_CONFIRM !== stressConfig.confirmToken) {
    throw new Error("MEMBER_STRESS_CONFIRM does not match the checked-in confirmation token");
  }
}

function requirePassword() {
  const loginCredential = Reflect.get(process.env, "MEMBER_STRESS_PASSWORD") || "";
  if (loginCredential.length < 24) throw new Error("MEMBER_STRESS_PASSWORD must contain at least 24 characters");
  return loginCredential;
}

function requiredEnvironment(plan, { password = false } = {}) {
  const suppliedUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || plan.target.url;
  const url = assertExactTarget(plan, suppliedUrl);
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required");
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  return { url, serviceKey, publishableKey, password: password ? requirePassword() : undefined };
}

function serviceClient(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
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
    p_confirm_token: stressConfig.confirmToken
  };
}

async function apply(plan, env) {
  requireConfirm();
  const client = serviceClient(env.url, env.serviceKey);
  const begun = await rpc(client, "member_stress_begin", {
    ...commonArgs(plan),
    p_dataset_version: stressConfig.datasetVersion,
    p_member_count: plan.profile.memberCount,
    p_login_count: plan.profile.loginCount,
    p_config_hash: plan.configHash
  });
  emit("ledger-ready", begun);

  const batches = Math.ceil(plan.profile.memberCount / plan.profile.batchSize);
  for (let batch = 0; batch < batches; batch += 1) {
    const start = batch * plan.profile.batchSize + 1;
    const result = await rpc(client, "member_stress_apply_batch", {
      ...commonArgs(plan),
      p_start_ordinal: start,
      p_batch_count: plan.profile.batchSize,
      p_password: env.password
    });
    if ((batch + 1) % 10 === 0 || batch === 0 || batch + 1 === batches) {
      emit("apply-progress", { batch: batch + 1, batches, ...result });
    }
  }

  const verified = await rpc(client, "member_stress_verify", {
    p_run_id: plan.runId,
    p_password: env.password
  });
  emit("verified", verified);
  if (!verified.ok) throw new Error("Database verification did not pass");
}

async function verify(plan, env) {
  const client = serviceClient(env.url, env.serviceKey);
  const result = await rpc(client, "member_stress_verify", { p_run_id: plan.runId, p_password: env.password });
  emit("verified", result);
  if (!result.ok) throw new Error("Database verification did not pass");
}

async function status(plan, env) {
  const client = serviceClient(env.url, env.serviceKey);
  emit("status", await rpc(client, "member_stress_status", { p_run_id: plan.runId }));
}

async function remove(plan, env) {
  requireConfirm();
  const client = serviceClient(env.url, env.serviceKey);
  emit("removal-preflight", await rpc(client, "member_stress_begin_remove", commonArgs(plan)));
  let remaining = plan.profile.memberCount;
  let batches = 0;
  while (remaining > 0) {
    const result = await rpc(client, "member_stress_remove_batch", {
      ...commonArgs(plan),
      p_batch_count: plan.profile.batchSize
    });
    batches += 1;
    remaining = result.remaining;
    if (batches % 10 === 0 || remaining === 0) emit("remove-progress", { batches, ...result });
  }
  const finalStatus = await rpc(client, "member_stress_status", { p_run_id: plan.runId });
  emit("removed", finalStatus);
  if (finalStatus.state !== "removed" || finalStatus.auth_users !== 0 || !finalStatus.protected_unchanged) {
    throw new Error("Removal verification did not pass");
  }
}

async function login(url, publishableKey, email, password) {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token || !body.user?.id) {
    throw new Error(`Login failed for ${email}: HTTP ${response.status}`);
  }
  return { token: body.access_token, userId: body.user.id };
}

async function apiRead(url, publishableKey, session, requestIndex) {
  const paths = [
    `/rest/v1/member_profiles?select=id,full_name&id=eq.${session.userId}`,
    "/rest/v1/member_notifications?select=id,title&order=created_at.desc&limit=3",
    "/rest/v1/member_cases?select=id,reference,status&order=updated_at.desc&limit=4",
    "/rest/v1/member_conversations?select=id,title&order=updated_at.desc&limit=2"
  ];
  const started = performance.now();
  const response = await fetch(`${url}${paths[requestIndex % paths.length]}`, {
    headers: { apikey: publishableKey, authorization: `Bearer ${session.token}` }
  });
  if (!response.ok) throw new Error(`API read failed: HTTP ${response.status}`);
  await response.arrayBuffer();
  return performance.now() - started;
}

async function mapConcurrent(count, concurrency, worker) {
  const output = new Array(count);
  let cursor = 0;
  async function lane() {
    while (true) {
      const current = cursor;
      cursor += 1;
      if (current >= count) return;
      output[current] = await worker(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, lane));
  return output;
}

async function load(plan, env) {
  if (!env.publishableKey) throw new Error("A publishable or anon key is required for login/load proof");
  const proofCount = plan.profile.loginProofCount;
  const sessions = await mapConcurrent(proofCount, Math.min(5, proofCount), async (index) => {
    const ordinal = index + 1;
    const session = await login(env.url, env.publishableKey, stressEmail(plan.runId, ordinal), env.password);
    if (session.userId !== stressUserId(plan.runId, ordinal)) throw new Error(`Unexpected user id for ordinal ${ordinal}`);
    return session;
  });
  emit("login-proof", { accounts: sessions.length, passed: true });

  const latencies = await mapConcurrent(plan.profile.loadRequests, plan.profile.loadConcurrency, (index) =>
    apiRead(env.url, env.publishableKey, sessions[index % sessions.length], index)
  );
  latencies.sort((a, b) => a - b);
  emit("load-proof", {
    requests: latencies.length,
    concurrency: plan.profile.loadConcurrency,
    failures: 0,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = resolveStressPlan(args);
  emit("plan", publicPlan(plan));
  if (args.mode === "dry-run") return;
  const needsPassword = ["apply", "verify", "load"].includes(args.mode);
  const env = requiredEnvironment(plan, { password: needsPassword });
  if (args.mode === "apply") await apply(plan, env);
  else if (args.mode === "verify") await verify(plan, env);
  else if (args.mode === "status") await status(plan, env);
  else if (args.mode === "load") await load(plan, env);
  else if (args.mode === "remove") await remove(plan, env);
}

if (false) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: "failed", message: error.message })}\n`);
  process.exitCode = 1;
});
