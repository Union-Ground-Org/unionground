import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  activeUserConfig,
  estimateUsageCost,
  expectedReservationBaseline,
  markdownReport,
  normalizeGatewayUsage,
  parseActiveUserArgs,
  publicActiveUserPlan,
  resolveActiveUserPlan,
  reservationDelta,
  reservationUserId,
  sanitizeReport,
  stressTitleHash,
  summarizeOperation,
  validateOwnedGuideThreads,
} from "./member-active-user-load-lib.mjs";
import { assertExactTarget, stressEmail, stressUserId } from "./member-stress-config.mjs";

const REQUEST_TIMEOUT_MS = 12000;
const GUIDE_TIMEOUT_MS = 35000;
const MAX_ERROR_SAMPLES = 50;
const RESERVATION_BATCH_SIZE = 100;

function emit(event, detail = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`);
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolveDelay();
    }, { once: true });
  });
}

function randomBetween(minimum, maximum) {
  if (maximum <= minimum) return minimum;
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function chunks(values, size = RESERVATION_BATCH_SIZE) {
  const output = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
}

function bareOrigin(value, expected) {
  const actualUrl = new URL(value);
  const expectedUrl = new URL(expected);
  if (actualUrl.username || actualUrl.password || actualUrl.search || actualUrl.hash || actualUrl.pathname !== "/") {
    throw new Error("Application target must be a bare origin");
  }
  if (actualUrl.origin !== expectedUrl.origin) throw new Error(`Application target mismatch: expected ${expectedUrl.origin}`);
  return actualUrl.origin;
}

function requiredEnvironment(plan) {
  const suppliedSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || plan.seedPlan.target.url;
  const supabaseUrl = assertExactTarget(plan.seedPlan, suppliedSupabaseUrl);
  const suppliedAppUrl = process.env.MEMBER_ACTIVE_STRESS_APP_URL || plan.target.appUrl;
  const appUrl = bareOrigin(suppliedAppUrl, plan.target.appUrl);
  const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const password = Reflect.get(process.env, "MEMBER_STRESS_PASSWORD") || "";
  if (!publishableKey) throw new Error("A Supabase publishable or anon key is required");
  if (!serviceKey) throw new Error("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required for fail-closed cleanup");
  if (password.length < 24) throw new Error("MEMBER_STRESS_PASSWORD must contain at least 24 characters");
  if (plan.targetName === "production" && process.env.MEMBER_ACTIVE_STRESS_CONFIRM !== activeUserConfig.confirmToken) {
    throw new Error("MEMBER_ACTIVE_STRESS_CONFIRM does not match the checked-in production confirmation token");
  }
  return { supabaseUrl, appUrl, publishableKey, serviceKey, password };
}

function requiredCleanupEnvironment(plan) {
  const suppliedSupabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || plan.seedPlan.target.url;
  const supabaseUrl = assertExactTarget(plan.seedPlan, suppliedSupabaseUrl);
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required for fail-closed cleanup");
  if (plan.targetName === "production" && process.env.MEMBER_ACTIVE_STRESS_CONFIRM !== activeUserConfig.confirmToken) {
    throw new Error("MEMBER_ACTIVE_STRESS_CONFIRM does not match the checked-in production confirmation token");
  }
  return { supabaseUrl, serviceKey };
}

export class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async run(callback) {
    if (this.active >= this.limit) {
      await new Promise((resolveWaiter) => this.queue.push(resolveWaiter));
    } else {
      this.active += 1;
    }
    try {
      return await callback();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

class Metrics {
  constructor(onRecord) {
    this.byOperation = new Map();
    this.errors = [];
    this.total = 0;
    this.failed = 0;
    this.onRecord = onRecord;
  }

  record(operation, sample) {
    if (!this.byOperation.has(operation)) this.byOperation.set(operation, []);
    this.byOperation.get(operation).push(sample);
    this.total += 1;
    if (!sample.ok) {
      this.failed += 1;
      if (this.errors.length < MAX_ERROR_SAMPLES) {
        this.errors.push({ operation, status: sample.status ?? "error", message: String(sample.message || "request failed").slice(0, 180) });
      }
    }
    this.onRecord?.(this);
  }

  summaries() {
    return Object.fromEntries([...this.byOperation.entries()].map(([name, samples]) => [name, summarizeOperation(samples)]));
  }
}

function requestSignal(control, timeoutMs) {
  return AbortSignal.any([control.signal, AbortSignal.timeout(timeoutMs)]);
}

async function fetchMeasured(state, operation, url, options = {}, { timeoutMs = REQUEST_TIMEOUT_MS, parseJson = false } = {}) {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: requestSignal(state.control, timeoutMs) });
    const payload = parseJson ? await response.json().catch(() => ({})) : (await response.arrayBuffer(), null);
    state.metrics.record(operation, { ok: response.ok, status: response.status, ms: performance.now() - started });
    return { response, payload };
  } catch (error) {
    if (!state.control.signal.aborted) {
      state.metrics.record(operation, { ok: false, status: "network", ms: performance.now() - started, message: error.name });
    }
    return { response: null, payload: null };
  }
}

async function fetchBuildInfo(state, appUrl) {
  const { response, payload } = await fetchMeasured(state, "buildInfo", `${appUrl}/build-info.json`, { cache: "no-store" }, { parseJson: true });
  if (!response?.ok || !/^[0-9a-f]{40}$/.test(payload?.commitSha || "")) throw new Error("Production build-info did not return a valid commitSha");
  return { commitSha: payload.commitSha, builtAt: payload.builtAt || null };
}

// The in-house mesh has no per-token price list; Union Ground operates the
// hardware. Cost estimates therefore stay null unless a pricing map is passed
// in explicitly by the caller.
async function fetchPricing() {
  return new Map();
}

async function loginVirtualUser(state, ordinal) {
  const email = stressEmail(state.plan.seedPlan.runId, ordinal);
  const expectedUserId = stressUserId(state.plan.seedPlan.runId, ordinal);
  const { response, payload } = await fetchMeasured(state, "login", `${state.env.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "apikey": state.env.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password: state.env.password }),
  }, { parseJson: true });
  if (!response?.ok || !payload?.access_token || payload.user?.id !== expectedUserId) return null;
  return {
    ordinal,
    userId: expectedUserId,
    token: payload.access_token,
    refreshToken: payload.refresh_token || null,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
    threadId: null,
    persistAttempts: 0,
    history: [],
  };
}

function authenticatedHeaders(state, session) {
  return { "apikey": state.env.publishableKey, authorization: `Bearer ${session.token}` };
}

async function ensureSessionFresh(state, session) {
  if (Date.now() < session.expiresAt - 60000) return true;
  if (!session.refreshToken) {
    state.metrics.record("refresh", { ok: false, status: "missing", ms: 0, message: "refresh token unavailable" });
    return false;
  }
  const { response, payload } = await fetchMeasured(state, "refresh", `${state.env.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "apikey": state.env.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  }, { parseJson: true });
  if (!response?.ok || !payload?.access_token) return false;
  session.token = payload.access_token;
  session.refreshToken = payload.refresh_token || session.refreshToken;
  session.expiresAt = Date.now() + Number(payload.expires_in || 3600) * 1000;
  return true;
}

const memberOperations = {
  profile: (session) => `/rest/v1/member_profiles?select=id,full_name&id=eq.${session.userId}`,
  notifications: () => "/rest/v1/member_notifications?select=id,title,read_at&order=created_at.desc&limit=8",
  cases: () => "/rest/v1/member_cases?select=id,reference,status&order=updated_at.desc&limit=8",
  conversations: () => "/rest/v1/member_conversations?select=id,title&order=updated_at.desc&limit=6",
  rights: () => "/rest/v1/member_rights_lessons?select=id,title,steps&limit=8",
};

async function performMemberRead(state, session, operation) {
  if (!await ensureSessionFresh(state, session)) return;
  const path = memberOperations[operation](session);
  await fetchMeasured(state, operation, `${state.env.supabaseUrl}${path}`, { headers: authenticatedHeaders(state, session) });
}

async function performAppPage(state) {
  const paths = ["/m", "/m/messages", "/m/cases", "/m/rights"];
  await fetchMeasured(state, "appPage", `${state.env.appUrl}${paths[Math.floor(Math.random() * paths.length)]}`, {
    headers: { "user-agent": "unionground-active-user-stress/1.0" },
    redirect: "follow",
  });
}

function chooseWeightedOperation() {
  const entries = Object.entries(activeUserConfig.operationWeights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = Math.random() * total;
  for (const [name, weight] of entries) {
    cursor -= weight;
    if (cursor <= 0) return name;
  }
  return entries.at(-1)[0];
}

function reserveAiBudget(state) {
  if (state.plan.aiMode !== "real" || state.ai.disabled || state.ai.budgetUsed >= state.plan.values.maxAiCalls) return false;
  state.ai.budgetUsed += 1;
  return true;
}

async function persistGuideExchange(state, session, question, answer) {
  if (!await ensureSessionFresh(state, session)) return false;
  const pendingKey = session.threadId ? null : `${session.userId}:${++session.persistAttempts}`;
  const titlePrefix = question.slice(0, 120);
  const titleMarker = `[stress:${state.plan.runId}:${session.ordinal}]`;
  const threadLedger = { userId: session.userId, titlePrefix, titleMarker, titleHash: stressTitleHash(titlePrefix) };
  if (pendingKey) {
    state.pendingThreads.set(pendingKey, threadLedger);
    try {
      await persistCleanupManifest(state);
    } catch (error) {
      state.stopReason ||= `cleanup manifest write failed: ${String(error.message || error).slice(0, 160)}`;
      state.control.abort();
      return false;
    }
  }
  const { response, payload } = await fetchMeasured(state, "guidePersist", `${state.env.supabaseUrl}/rest/v1/rpc/save_member_guide_exchange`, {
    method: "POST",
    headers: { ...authenticatedHeaders(state, session), "content-type": "application/json" },
    body: JSON.stringify({ p_thread_id: session.threadId, p_question: question, p_answer: answer }),
  }, { parseJson: true });
  if (!response?.ok || typeof payload !== "string") return false;
  session.threadId = payload;
  if (!state.createdThreads.has(payload)) {
    state.createdThreads.set(payload, threadLedger);
  }
  if (pendingKey) state.pendingThreads.delete(pendingKey);
  try {
    await persistCleanupManifest(state);
  } catch (error) {
    state.stopReason ||= `cleanup manifest write failed: ${String(error.message || error).slice(0, 160)}`;
    state.control.abort();
    return false;
  }
  return true;
}

async function performGuideCall(state, session) {
  if (session.aiBusy || !reserveAiBudget(state)) return false;
  session.aiBusy = true;
  let requestStarted = false;
  try {
    return await state.aiSemaphore.run(async () => {
      if (state.ai.disabled || state.control.signal.aborted) return false;
      if (!await ensureSessionFresh(state, session)) return false;
      if (state.ai.disabled || state.control.signal.aborted) return false;
      state.ai.calls += 1;
      requestStarted = true;
      const baseQuestion = activeUserConfig.guideQuestions[(session.ordinal + state.ai.calls) % activeUserConfig.guideQuestions.length];
      const question = `[stress:${state.plan.runId}:${session.ordinal}] ${baseQuestion}`;
      const { response, payload } = await fetchMeasured(state, "guide", `${state.env.appUrl}/api/guide`, {
        method: "POST",
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", "user-agent": "unionground-active-user-stress/1.0" },
        body: JSON.stringify({ question, history: session.history.slice(-6) }),
      }, { timeoutMs: GUIDE_TIMEOUT_MS, parseJson: true });

      if (response?.status === 429) {
        state.ai.disabled = true;
        state.ai.quotaStopped = true;
        state.stopReason ||= "production AI quota returned 429; further AI calls stopped";
        return false;
      }
      const answer = typeof payload?.answer === "string" ? payload.answer.trim() : "";
      if (!response?.ok || !answer) return false;

      const usage = normalizeGatewayUsage(payload?.meta?.usage);
      if (payload?.meta?.model) state.ai.models.add(String(payload.meta.model).slice(0, 120));
      if (usage) {
        state.ai.usage.promptTokens += usage.promptTokens;
        state.ai.usage.completionTokens += usage.completionTokens;
        state.ai.usage.totalTokens += usage.totalTokens;
        const cost = estimateUsageCost(usage, state.pricing.get(payload?.meta?.model));
        if (cost !== null) state.ai.estimatedCostUsd += cost;
        else state.ai.costComplete = false;
      } else {
        state.ai.usageComplete = false;
        state.ai.costComplete = false;
      }

      const persisted = await persistGuideExchange(state, session, question, answer);
      if (persisted) {
        session.history.push({ role: "user", body: question }, { role: "assistant", body: answer });
        session.history = session.history.slice(-6);
      }
      return persisted;
    });
  } finally {
    if (!requestStarted) state.ai.budgetUsed -= 1;
    session.aiBusy = false;
  }
}

async function runVirtualUser(state, index, globalStart, globalEnd) {
  const offset = state.plan.values.virtualUsers === 1 ? 0 : Math.floor(state.plan.values.rampSeconds * 1000 * index / (state.plan.values.virtualUsers - 1));
  await delay(Math.max(0, globalStart + offset - Date.now()), state.control.signal);
  if (state.control.signal.aborted) return;
  const session = await loginVirtualUser(state, index + 1);
  if (!session || state.control.signal.aborted) return;

  state.sessions.push(session);
  state.activeUsers += 1;
  state.peakActiveUsers = Math.max(state.peakActiveUsers, state.activeUsers);
  try {
    while (!state.control.signal.aborted && Date.now() < globalEnd) {
      const wantsAi = state.ai.waveStarted && Math.random() * 100 < state.plan.values.aiPercent;
      if (wantsAi && reserveAiBudgetPreview(state)) await performGuideCall(state, session);
      else {
        const operation = chooseWeightedOperation();
        if (operation === "appPage") await performAppPage(state);
        else await performMemberRead(state, session, operation);
      }
      state.iterations += 1;
      await delay(randomBetween(state.plan.values.thinkMinMs, state.plan.values.thinkMaxMs), state.control.signal);
    }
  } finally {
    state.activeUsers -= 1;
  }
}

async function runAiWave(state, globalStart) {
  if (state.plan.aiMode !== "real" || !state.plan.values.maxAiCalls) return;
  await delay(Math.max(0, globalStart + state.plan.values.rampSeconds * 1000 - Date.now()), state.control.signal);
  if (state.control.signal.aborted) return;
  const desiredSessions = Math.min(state.plan.values.virtualUsers, state.plan.values.aiConcurrency);
  const sessionDeadline = Date.now() + 5000;
  while (!state.control.signal.aborted && state.sessions.length < desiredSessions && Date.now() < sessionDeadline) {
    await delay(100, state.control.signal);
  }
  state.ai.waveStarted = true;
  const waveCount = Math.min(
    state.sessions.length,
    state.plan.values.maxAiCalls,
    Math.max(state.plan.values.aiConcurrency * 2, Math.ceil(state.plan.values.maxAiCalls / 2)),
  );
  emit("ai-wave", { runId: state.plan.runId, availableSessions: state.sessions.length, calls: waveCount, concurrency: state.plan.values.aiConcurrency });
  await Promise.all(state.sessions.slice(0, waveCount).map((session) => performGuideCall(state, session)));
}

function reserveAiBudgetPreview(state) {
  return state.plan.aiMode === "real" && !state.ai.disabled && state.ai.budgetUsed < state.plan.values.maxAiCalls;
}

async function listReservations(client, userIds) {
  const rows = [];
  for (const batch of chunks(userIds)) {
    const { data, error } = await client.from("member_ai_requests").select("id,user_id,created_at").in("user_id", batch);
    if (error) throw new Error(`reservation snapshot failed: ${error.message}`);
    rows.push(...data);
  }
  return new Map(rows.map((row) => [row.id, { userId: row.user_id, createdAt: row.created_at }]));
}

function cleanupManifestPath(plan) {
  return resolve(plan.reportDir, `active-user-cleanup-${plan.runId}.json`);
}

function cleanupManifestDocument(state, cleanup = null) {
  return {
    schemaVersion: 1,
    runId: state.plan.runId,
    startedAt: state.startedAt,
    plan: publicActiveUserPlan(state.plan),
    plannedUserIds: state.plannedUserIds,
    baselineReservations: [...state.baselineReservations.entries()].map(([id, value]) => ({
      id,
      userId: reservationUserId(value),
      createdAt: value?.createdAt || null,
    })),
    threads: [...state.createdThreads.entries()].map(([id, value]) => ({ id, userId: value.userId, titleMarker: value.titleMarker, titleHash: value.titleHash })),
    pendingThreads: [...state.pendingThreads.values()].map((value) => ({ userId: value.userId, titleMarker: value.titleMarker, titleHash: value.titleHash })),
    status: cleanup?.ok ? "completed" : "pending",
    cleanup,
    updatedAt: new Date().toISOString(),
  };
}

async function writeAtomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function targetLockPath(plan, lockDirectory = resolve(tmpdir(), "unionground-active-user-locks")) {
  return resolve(lockDirectory, `${plan.seedPlan.target.projectRef}-${plan.targetName}.json`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function claimTargetLock(plan, { cleanup = false, lockDirectory } = {}) {
  const path = targetLockPath(plan, lockDirectory);
  await mkdir(dirname(path), { recursive: true });
  const lock = {
    schemaVersion: 1,
    runId: plan.runId,
    target: plan.targetName,
    supabaseProjectRef: plan.seedPlan.target.projectRef,
    pid: process.pid,
    ownerId: randomUUID(),
    mode: cleanup ? "cleanup" : "run",
    createdAt: new Date().toISOString(),
  };
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return { path, ownerId: lock.ownerId };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  let existing;
  try {
    existing = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("active-user target lock is unreadable; inspect it before continuing");
  }
  if (!cleanup || existing.runId !== plan.runId || processIsAlive(existing.pid)) {
    throw new Error(`active-user target lock is held by run ${String(existing.runId || "unknown").slice(0, 80)}`);
  }

  const takeoverPath = `${path}.${plan.runId}.takeover`;
  let takeover;
  try {
    takeover = await open(takeoverPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("active-user cleanup takeover is already in progress", { cause: error });
    }
    throw error;
  }
  try {
    await writeAtomicJson(path, lock);
  } finally {
    await takeover.close();
    await unlink(takeoverPath).catch(() => {});
  }
  return { path, ownerId: lock.ownerId };
}

async function releaseTargetLock(lock, runId) {
  const current = JSON.parse(await readFile(lock.path, "utf8"));
  if (current.runId !== runId || current.ownerId !== lock.ownerId) throw new Error("active-user target lock ownership changed");
  await unlink(lock.path);
}

function persistCleanupManifest(state, cleanup = null) {
  state.manifestWrite = state.manifestWrite.catch(() => {}).then(() => state.writeManifest(state.manifestPath, cleanupManifestDocument(state, cleanup)));
  return state.manifestWrite;
}

async function locatePendingThreads(client, pendingThreads) {
  const located = new Map();
  const entries = [...pendingThreads.values()];
  for (const batch of chunks(entries)) {
    const userIds = [...new Set(batch.map((entry) => entry.userId))];
    const { data, error } = await client.from("member_guide_threads").select("id,user_id,title").in("user_id", userIds);
    if (error) throw new Error(`pending guide thread recovery failed: ${error.message}`);
    for (const entry of batch) {
      const matches = data.filter((row) => row.user_id === entry.userId && row.title.startsWith(entry.titleMarker) && stressTitleHash(row.title) === entry.titleHash);
      for (const row of matches) located.set(row.id, row);
    }
  }
  return [...located.values()];
}

async function deleteExactIds(client, table, ids) {
  const deleted = [];
  for (const batch of chunks(ids)) {
    const { data, error } = await client.from(table).delete().in("id", batch).select("id");
    if (error) throw new Error(`${table} cleanup failed: ${error.message}`);
    deleted.push(...data.map((row) => row.id));
  }
  return deleted;
}

async function cleanupRun(state, { allowAlreadyDeleted = false } = {}) {
  const result = { ok: false, guideThreadsExpected: 0, guideThreadsDeleted: 0, guideThreadsAlreadyAbsent: 0, aiReservationsDeleted: 0, baselineReservationsPreserved: false, baselineReservationsAllowedToExpire: 0 };
  const client = state.serviceClient;
  try {
    const recoveredThreads = await locatePendingThreads(client, state.pendingThreads);
    for (const row of recoveredThreads) {
      state.createdThreads.set(row.id, { userId: row.user_id, titleMarker: row.title.match(/^\[stress:[^\]]+\]/)?.[0] || "", titleHash: stressTitleHash(row.title) });
    }
    state.pendingThreads.clear();
    result.guideThreadsExpected = state.createdThreads.size;
    const threadIds = [...state.createdThreads.keys()];
    if (threadIds.length) {
      const located = [];
      for (const batch of chunks(threadIds)) {
        const { data, error } = await client.from("member_guide_threads").select("id,user_id,title").in("id", batch);
        if (error) throw new Error(`guide thread cleanup preflight failed: ${error.message}`);
        located.push(...data);
      }
      const expectedLocated = allowAlreadyDeleted
        ? new Map(located.map((row) => [row.id, state.createdThreads.get(row.id)]))
        : state.createdThreads;
      validateOwnedGuideThreads(located, expectedLocated);
      const locatedIds = located.map((row) => row.id);
      result.guideThreadsAlreadyAbsent = threadIds.length - locatedIds.length;
      const deleted = await deleteExactIds(client, "member_guide_threads", locatedIds);
      result.guideThreadsDeleted = deleted.length;
      if (deleted.length !== locatedIds.length) throw new Error("guide thread cleanup delete count mismatch");
    }

    const afterReservations = await listReservations(client, state.plannedUserIds);
    const createdReservationIds = reservationDelta(state.baselineReservations, afterReservations);
    if (createdReservationIds.length) {
      const deleted = await deleteExactIds(client, "member_ai_requests", createdReservationIds);
      result.aiReservationsDeleted = deleted.length;
      if (deleted.length !== createdReservationIds.length) throw new Error("AI reservation cleanup delete count mismatch");
    }
    const finalReservations = await listReservations(client, state.plannedUserIds);
    const expectedBaseline = expectedReservationBaseline(state.baselineReservations, Date.now());
    result.baselineReservationsAllowedToExpire = state.baselineReservations.size - expectedBaseline.size;
    result.baselineReservationsPreserved = [...expectedBaseline.entries()].every(([id, value]) => reservationUserId(finalReservations.get(id)) === reservationUserId(value));
    const unexpected = reservationDelta(state.baselineReservations, finalReservations);
    if (!result.baselineReservationsPreserved || unexpected.length) throw new Error("AI reservation cleanup verification failed");

    result.ok = allowAlreadyDeleted || result.guideThreadsDeleted === result.guideThreadsExpected;
    return result;
  } catch (error) {
    result.error = String(error.message || error).slice(0, 240);
    return result;
  }
}

// Shared tail of both cleanup paths (a completed run and a resume from a
// manifest). Order is load-bearing: the manifest records the cleanup result
// first, and the target lock is released ONLY when cleanup succeeded and that
// record reached disk — a half-cleaned run must keep the lock so the next
// operator cannot start on top of it. Neither failure throws; both are recorded
// on `cleanup` and read by determineOutcome.
async function finalizeCleanup(state, cleanup, plan) {
  cleanup.manifestPersisted = true;
  try {
    await persistCleanupManifest(state, cleanup);
  } catch (error) {
    cleanup.manifestPersisted = false;
    cleanup.manifestError = String(error.message || error).slice(0, 240);
  }
  cleanup.targetLockReleased = false;
  if (cleanup.ok && cleanup.manifestPersisted) {
    try {
      await releaseTargetLock(state.targetLock, plan.runId);
      cleanup.targetLockReleased = true;
    } catch (error) {
      cleanup.targetLockError = String(error.message || error).slice(0, 240);
    }
  }
}

function determineOutcome(state, operations, cleanup) {
  const failures = [];
  const errorRate = state.metrics.total ? state.metrics.failed / state.metrics.total : 1;
  const aggregateLatencies = [...state.metrics.byOperation.values()].flat().map((sample) => sample.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const aggregate = summarizeOperation(aggregateLatencies.map((ms) => ({ ok: true, status: 200, ms })));
  if (errorRate > state.plan.values.maxErrorRate) failures.push(`error rate ${errorRate.toFixed(4)} exceeds ${state.plan.values.maxErrorRate}`);
  if ((aggregate.latencyMs.p95 ?? Infinity) > state.plan.values.maxP95Ms) failures.push(`aggregate p95 ${aggregate.latencyMs.p95}ms exceeds ${state.plan.values.maxP95Ms}ms`);
  if (operations.guide && (operations.guide.latencyMs.p95 ?? Infinity) > state.plan.values.maxAiP95Ms) failures.push(`AI p95 ${operations.guide.latencyMs.p95}ms exceeds ${state.plan.values.maxAiP95Ms}ms`);
  if (state.plan.aiMode === "real" && state.plan.values.maxAiCalls > 0 && !operations.guide?.requests) failures.push("no real AI request completed");
  if (state.ai.quotaStopped) failures.push("production AI quota exhausted before the run completed");
  if (!cleanup.ok) failures.push("cleanup verification failed");
  if (cleanup.manifestPersisted === false) failures.push("final cleanup manifest persistence failed");
  if (cleanup.targetLockReleased === false) failures.push("active-user target lock release failed");
  if (!state.peakActiveUsers) failures.push("no virtual user authenticated");
  return { outcome: failures.length ? "FAIL" : "PASS", failures, errorRate, aggregateLatencyMs: aggregate.latencyMs };
}

async function writeReports(plan, result) {
  const directory = resolve(plan.reportDir);
  await mkdir(directory, { recursive: true });
  const stamp = result.startedAt.replaceAll(":", "-").replaceAll(".", "-");
  const base = `active-user-${stamp}-${plan.runId.slice(0, 8)}`;
  const jsonPath = resolve(directory, `${base}.json`);
  const markdownPath = resolve(directory, `${base}.md`);
  const documents = renderReportDocuments(result);
  await writeFile(jsonPath, documents.json, "utf8");
  await writeFile(markdownPath, documents.markdown, "utf8");
  return { jsonPath, markdownPath };
}

export function renderReportDocuments(result) {
  const sanitizedResult = sanitizeReport(result);
  return {
    json: `${JSON.stringify(sanitizedResult, null, 2)}\n`,
    markdown: markdownReport(sanitizedResult),
  };
}

export async function cleanupActiveUserManifest(path, { environment, targetLockDirectory } = {}) {
  const manifestPath = resolve(path);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const startedAtMs = Date.parse(manifest?.startedAt);
  const updatedAtMs = Date.parse(manifest?.updatedAt);
  if (manifest?.schemaVersion !== 1 || typeof manifest.runId !== "string" || !manifest.plan || !Number.isFinite(startedAtMs) || !Number.isFinite(updatedAtMs) || updatedAtMs < startedAtMs) {
    throw new Error("cleanup manifest is invalid");
  }
  const args = {
    mode: "cleanup",
    targetName: manifest.plan.target,
    profileName: manifest.plan.profile,
    aiMode: manifest.plan.aiMode,
    reportDir: dirname(manifestPath),
    manifestPath,
    overrides: Object.fromEntries([
      "virtualUsers", "rampSeconds", "durationSeconds", "thinkMinMs", "thinkMaxMs", "aiPercent",
      "maxAiCalls", "aiConcurrency", "maxErrorRate", "maxP95Ms", "maxAiP95Ms",
    ].map((key) => [key, manifest.plan[key]])),
  };
  const plan = resolveActiveUserPlan(args, { runId: manifest.runId });
  if (manifest.plan.supabaseProjectRef !== plan.seedPlan.target.projectRef ||
      manifest.plan.stressDatasetRunId !== plan.seedPlan.runId ||
      manifest.plan.appUrl !== plan.target.appUrl) {
    throw new Error("cleanup manifest target mismatch");
  }
  if (!Array.isArray(manifest.plannedUserIds) || !Array.isArray(manifest.baselineReservations) || !Array.isArray(manifest.threads) || !Array.isArray(manifest.pendingThreads)) {
    throw new Error("cleanup manifest ledger is invalid");
  }
  const expectedUserIds = Array.from({ length: plan.values.virtualUsers }, (_, index) => stressUserId(plan.seedPlan.runId, index + 1));
  if (manifest.plannedUserIds.length !== expectedUserIds.length || manifest.plannedUserIds.some((id, index) => id !== expectedUserIds[index])) {
    throw new Error("cleanup manifest user ledger mismatch");
  }
  const plannedUserIds = new Set(expectedUserIds);
  const ordinalByUserId = new Map(expectedUserIds.map((id, index) => [id, index + 1]));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const validThreadLedger = (row, requireId) => {
    const ordinal = ordinalByUserId.get(row?.userId);
    return Boolean(ordinal && (!requireId || uuid.test(row.id || "")) && row.titleMarker === `[stress:${plan.runId}:${ordinal}]` && /^[0-9a-f]{64}$/.test(row.titleHash || ""));
  };
  if (manifest.baselineReservations.some((row) => {
        const createdAtMs = Date.parse(row?.createdAt);
        return !uuid.test(row?.id || "") || !plannedUserIds.has(row?.userId) || !Number.isFinite(createdAtMs) || createdAtMs > updatedAtMs + 60_000;
      }) ||
      manifest.threads.some((row) => !validThreadLedger(row, true)) ||
      manifest.pendingThreads.some((row) => !validThreadLedger(row, false))) {
    throw new Error("cleanup manifest ownership ledger mismatch");
  }
  const env = environment || requiredCleanupEnvironment(plan);
  const state = {
    plan,
    env,
    manifestPath,
    manifestWrite: Promise.resolve(),
    writeManifest: writeAtomicJson,
    startedAt: manifest.startedAt,
    plannedUserIds: expectedUserIds,
    baselineReservations: new Map(manifest.baselineReservations.map((row) => [row.id, { userId: row.userId, createdAt: row.createdAt }])),
    createdThreads: new Map(manifest.threads.map((row) => [row.id, { userId: row.userId, titleMarker: row.titleMarker, titleHash: row.titleHash }])),
    pendingThreads: new Map(manifest.pendingThreads.map((row, index) => [`${row.userId}:${index}`, { userId: row.userId, titleMarker: row.titleMarker, titleHash: row.titleHash }])),
  };
  state.targetLock = await claimTargetLock(plan, { cleanup: true, lockDirectory: targetLockDirectory });
  state.serviceClient = createClient(env.supabaseUrl, env.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const cleanup = await cleanupRun(state, { allowAlreadyDeleted: true });
  await finalizeCleanup(state, cleanup, plan);
  const outcome = cleanup.ok && cleanup.manifestPersisted && cleanup.targetLockReleased ? "PASS" : "FAIL";
  return { runId: plan.runId, outcome, cleanup, manifestPath };
}

export async function executeActiveUserPlan(plan, { environment, pricing, manifestWriter = writeAtomicJson, targetLockDirectory } = {}) {
  const env = environment || requiredEnvironment(plan);
  const control = new AbortController();
  const state = {
    plan,
    env,
    control,
    metrics: null,
    activeUsers: 0,
    peakActiveUsers: 0,
    iterations: 0,
    stopReason: null,
    ai: {
      calls: 0,
      budgetUsed: 0,
      disabled: false,
      quotaStopped: false,
      waveStarted: false,
      models: new Set(),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      usageComplete: true,
      estimatedCostUsd: 0,
      costComplete: true,
    },
    createdThreads: new Map(),
    pendingThreads: new Map(),
    sessions: [],
    plannedUserIds: Array.from({ length: plan.values.virtualUsers }, (_, index) => stressUserId(plan.seedPlan.runId, index + 1)),
    manifestPath: cleanupManifestPath(plan),
    manifestWrite: Promise.resolve(),
    writeManifest: manifestWriter,
  };
  state.metrics = new Metrics((metrics) => {
    if (metrics.total >= 100 && metrics.failed / metrics.total > plan.values.maxErrorRate * 2 && !control.signal.aborted) {
      state.stopReason = `early stop: error rate ${(metrics.failed / metrics.total).toFixed(4)} exceeded twice the limit`;
      control.abort();
    }
  });
  state.aiSemaphore = new Semaphore(plan.values.aiConcurrency);
  state.serviceClient = createClient(env.supabaseUrl, env.serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  state.pricing = pricing ?? (plan.aiMode === "real" ? await fetchPricing() : new Map());
  const startedAt = new Date().toISOString();
  state.startedAt = startedAt;
  state.targetLock = await claimTargetLock(plan, { lockDirectory: targetLockDirectory });

  const stopForSignal = (name) => {
    state.stopReason ||= `received ${name}`;
    control.abort();
  };
  const onSigint = () => stopForSignal("SIGINT");
  const onSigterm = () => stopForSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let production;
  try {
    production = await fetchBuildInfo(state, env.appUrl);
    state.baselineReservations = await listReservations(state.serviceClient, state.plannedUserIds);
    await persistCleanupManifest(state);
  } catch (error) {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await releaseTargetLock(state.targetLock, plan.runId).catch(() => {});
    throw error;
  }
  emit("started", { runId: plan.runId, productionSha: production.commitSha, plan: publicActiveUserPlan(plan) });

  const progress = setInterval(() => emit("progress", {
    runId: plan.runId,
    activeUsers: state.activeUsers,
    peakActiveUsers: state.peakActiveUsers,
    operations: state.metrics.total,
    failures: state.metrics.failed,
    aiCalls: state.ai.calls,
  }), 10000);

  const globalStart = Date.now();
  const globalEnd = globalStart + (plan.values.rampSeconds + plan.values.durationSeconds) * 1000;
  try {
    const virtualUsers = Array.from({ length: plan.values.virtualUsers }, (_, index) => runVirtualUser(state, index, globalStart, globalEnd));
    await Promise.all([...virtualUsers, runAiWave(state, globalStart)]);
  } finally {
    clearInterval(progress);
  }

  const endedAt = new Date().toISOString();
  const cleanup = await cleanupRun(state);
  await finalizeCleanup(state, cleanup, plan);
  const operations = state.metrics.summaries();
  const verdict = determineOutcome(state, operations, cleanup);
  const elapsedSeconds = Math.max(0.001, (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000);
  const result = {
    schemaVersion: 1,
    runId: plan.runId,
    startedAt,
    endedAt,
    outcome: verdict.outcome,
    failures: verdict.failures,
    stopReason: state.stopReason,
    plan: publicActiveUserPlan(plan),
    production,
    stats: {
      peakActiveUsers: state.peakActiveUsers,
      iterations: state.iterations,
      operations: state.metrics.total,
      failures: state.metrics.failed,
      errorRate: Number(verdict.errorRate.toFixed(6)),
      throughputPerSecond: Number((state.metrics.total / elapsedSeconds).toFixed(2)),
      aggregateLatencyMs: verdict.aggregateLatencyMs,
    },
    operations,
    ai: {
      calls: state.ai.calls,
      quotaStopped: state.ai.quotaStopped,
      models: [...state.ai.models].sort(),
      usage: state.ai.usage,
      usageComplete: state.ai.usageComplete,
      estimatedCostUsd: state.ai.costComplete ? Number(state.ai.estimatedCostUsd.toFixed(8)) : null,
      costComplete: state.ai.costComplete,
    },
    cleanup,
    errorSamples: state.metrics.errors,
  };
  const artifacts = await writeReports(plan, result);
  result.artifacts = { ...artifacts, cleanupManifestPath: state.manifestPath };
  emit("completed", { outcome: result.outcome, runId: plan.runId, artifacts, stats: result.stats, ai: result.ai, cleanup });
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseActiveUserArgs(argv);
  if (args.mode === "cleanup") {
    const result = await cleanupActiveUserManifest(args.manifestPath);
    emit("cleanup-completed", result);
    if (result.outcome !== "PASS") process.exitCode = 1;
    return result;
  }
  const plan = resolveActiveUserPlan(args);
  emit("plan", publicActiveUserPlan(plan));
  if (plan.mode === "dry-run") return publicActiveUserPlan(plan);
  const result = await executeActiveUserPlan(plan);
  if (result.outcome !== "PASS") process.exitCode = 1;
  return result;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  throw new Error("Retired pre-bot test fixture: direct execution is forbidden");
  if (false) main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "failed", message: String(error.message || error).slice(0, 300) })}\n`);
    process.exitCode = 1;
  });
}
