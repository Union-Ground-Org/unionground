import { capturedAppClientFixture } from "./capturedAppClientFixture.js";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { MEMBER_HOME_BOOTSTRAP_RESOURCE, memberHomeBootstrapRequested } from "../../src/lib/memberHomeBootstrap.js";

// The backend freezes a response when transport starts, not when it completes.
// This is essential: reading current server rows at completion hides stale epochs.
const backend = vi.hoisted(() => {
  const state = { session: null, loader: null, pending: [], operations: [], rows: {}, hold: false, subscribers: [], feeds: [], liveSequences: new Map() };
  const user = (id) => ({ id, email: `${id}@example.test` });
  const controlled = new Set(["table:member_rights_progress", "table:member_notifications", "table:member_conversations", "table:member_guide_threads", "rpc:get_member_rewards_summary"]);
  const rowFor = (resource, member) => resource === "table:member_profiles"
    ? { id: member.id, first_name: member.id === "model-a" ? "Model" : `Identity ${member.id}`, full_name: member.id, initials: "MT", language: "en", chapter_id: "chapter-model" }
    : resource === "rpc:get_member_rewards_summary" ? { totalPoints: 100 }
      : state.rows[resource] ?? (resource.startsWith("rpc:") ? null : []);
  const execute = (resource, loader = state.loader, member = state.session?.user, args = undefined) => {
    if (resource === MEMBER_HOME_BOOTSTRAP_RESOURCE) {
      // One transport carries the requested reads: one operation per requested
      // resource, each frozen now, all settled together. A held or failing
      // requested read holds or fails the whole call, as the SQL function would.
      const requested = memberHomeBootstrapRequested(args);
      const immediate = !requested.some((item) => (state.hold && controlled.has(item)) || state.holdResource === item);
      const parts = requested.map((item) => ({
        immediate, resource: item, loader, epoch: loader?.inspect().get(item)?.epoch ?? 0,
        data: structuredClone(rowFor(item, member)), liveSequence: state.liveSequences.get(loader) ?? 0, batch: true,
      }));
      state.operations.push(...parts);
      const payload = () => Object.fromEntries([["user_id", member.id], ...parts.map((part) => [part.resource.slice("table:".length), structuredClone(part.data)])]);
      if (requested.includes(state.fail)) return Promise.resolve({ data: null, error: { message: "model failure" } });
      if (immediate) return Promise.resolve({ data: payload(), error: null });
      return new Promise(resolve => state.pending.push({ resource, loader, parts, payload, resolve }));
    }
    const row = rowFor(resource, member);
    const operation = { immediate: !(state.hold && controlled.has(resource)) && state.holdResource !== resource, resource, loader, epoch: loader?.inspect().get(resource)?.epoch ?? 0, data: structuredClone(row), liveSequence: state.liveSequences.get(loader) ?? 0 };
    state.operations.push(operation);
    if (state.fail === resource) return Promise.resolve({ data: null, error: { message: "model failure" } });
    if (operation.immediate) return Promise.resolve({ data: operation.data, error: null });
    return new Promise(resolve => state.pending.push({ ...operation, resolve }));
  };
  const client = {
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => execute(`table:${table}`, null).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    // Direct App reads and checked writers are outside the member cache.
    // Record their transports without inventing registry entries. Only the
    // scoped client's calls below have a real data-loader owner.
    rpc: (name, args) => execute(`rpc:${name}`, null, state.session?.user, args),
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange(callback) { state.auth = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }) },
    },
    channel(name) {
      const channel = {
        on(_type, filter, callback) { state.feeds.push({ name, filter, callback }); return channel; },
        subscribe(callback) { state.subscribers.push(callback); state.namedSubscribers[name] = callback; return channel; },
        unsubscribe() {},
      };
      return channel;
    },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  const scopedClient = (member, loader) => ({
    ...client,
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => execute(`table:${table}`, loader(), member).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: (name, args) => execute(`rpc:${name}`, loader(), member, args),
  });
  return { state, client, user, scopedClient };
});
vi.mock("../../src/lib/supabase.js", async original => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, appSupabase: backend.client,
  createCapturedAppSessionRpcClient: () => capturedAppClientFixture(backend.client),
}));
vi.mock("../../src/lib/memberSessionLoader.js", async original => {
  const implementation = await original();
  return { ...implementation, createMemberSessionLoader(...args) {
    let loader;
    loader = implementation.createMemberSessionLoader(backend.scopedClient(args[1], () => loader), args[1], { ...args[2], concurrency: 8 });
    backend.state.loader = loader;
    return loader;
  } };
});

export const coverage = { routes: { today: 0, rights: 0, messages: 0, events: 0 }, events: Array(11).fill(0), ui: {}, successiveWrites: 0 };
export const cover = name => { coverage.ui[name] = (coverage.ui[name] ?? 0) + 1; };
vi.mock("../../src/lib/guideApi.js", () => ({ requestGuideReply: async () => {
  if (backend.state.holdReply) return new Promise(resolve => { backend.state.replyPending = resolve; });
  return { answer: "Saved model answer", sources: [] };
} }));
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
export async function flush(work = () => {}) { await act(async () => { work(); await pause(); }); }
export function random(seed) {
  // Mulberry32 mixes high and low bits before scaling, so adjacent choices
  // do not inherit LCG parity/modulo correlation.
  let state = seed >>> 0;
  return (limit) => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return Math.floor(((value ^ (value >>> 14)) >>> 0) / 4294967296 * limit);
  };
}
export function go(view) {
  window.history.pushState({}, "", view === "today" ? "/m" : `/m/${view}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
beforeEach(() => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert model backend")));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m");
  Object.assign(backend.state, {
    session: { user: backend.user("model-a"), access_token: "model-token" },
    loader: null, pending: [], operations: [], hold: false, holdResource: null, fail: null, holdReply: false, replyPending: null, subscribers: [], namedSubscribers: {}, feeds: [], liveSequences: new Map(),
    rows: {
      "rpc:get_my_mfa_requirement": { required: false, enrolled: false },
      "table:member_rights_lessons": [{ id: "lesson", label: "Model lesson", title: "Model lesson", steps: ["One"], order_index: 1 }],
      "table:member_rights_progress": [{ lesson_id: "lesson", completed_steps: [] }],
      "table:member_guide_threads": [{ id: "guide", title: "Retained model conversation" }],
      "table:member_guide_messages": [{ id: "answer", thread_id: "guide", role: "assistant", body: "Retained model answer" }],
      "table:member_notifications": [{ id: "notice", title: "Model notice", read_at: null, created_at: "2026-09-06T12:00:00Z" }],
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

export { backend };
