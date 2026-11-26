import { createClient, processLock } from "@supabase/supabase-js";
// REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109 (#7666), Sol early
// read B1: the App built the cross-chapter API before the session was restored
// and kept that signed-out guard, so Send never reached the server and said
// nothing. The real App here mounts signed out, restores the session, opens
// Messages → Other chapters and sends.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { createResponseQueue } from "./helpers/responseQueue.js";

const backend = vi.hoisted(() => {
  const state = { writes: [], controls: null, calls: [], capturedFor: [], boundedFor: [], rows: {}, chapter: "chapter-1", chapterOptions: null };
  const respond = (resource) => {
    const data = resource === "table:member_profiles"
      ? { id: "lead-1", first_name: "Lena", full_name: "Lena Main", initials: "LM", language: "en", chapter_id: state.chapter }
      : (typeof state.rows[resource] === "function" ? state.rows[resource]() : state.rows[resource]) ?? (resource.startsWith("rpc:") ? null : []);
    return Promise.resolve(data).then((value) => ({ data: structuredClone(value), error: null }));
  };
  const client = {
    from(table) {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => respond(`table:${table}`).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: (name, args) => {
      state.calls.push([name, args]);
      if (name === "switch_my_chapter") {
        state.chapter = args.p_chapter_id;
        return Promise.resolve({ data: { chapterId: state.chapter }, error: null });
      }
      return respond(`rpc:${name}`);
    },
    auth: {
      // Resolved after the first render: the App starts signed out.
      getSession: () => new Promise((resolve) => setTimeout(() => resolve({ data: { session: state.session }, error: null }), 20)),
      onAuthStateChange(callback) { state.auth = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }) },
    },
    channel() {
      const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
      return channel;
    },
    removeChannel() {}, realtime: { setAuth() {} },
  };
  return { state, client };
});
vi.mock("../src/lib/supabase.js", async (original) => ({
  ...await original(), appBackendKind: "live", hasAppBackend: true,
  appAuthStorageUnavailable: false, get appSupabase() { return backend.client; },
  verifyCapturedAppSession: async (session) => ({ data: { user: session.user }, error: null }),
  // #9203: a private two-person write goes through a client fixed to the
  // session that started it; the stand-in records whose session that was,
  // and (#9229 r2s2) which clients asked for the shared client's deadline.
  createCapturedAppSessionRpcClient: (session, options) => {
    backend.state.capturedFor.push(session?.user?.id);
    if (options?.boundedTransport === true) backend.state.boundedFor.push(session?.user?.id);
    return createClient(BASE, KEY, { accessToken: async () => session.access_token, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: transport } });
  },
}));
// Exercise App's real chapter-switch and committed refresh callbacks through
// the same public selector boundary the rail and Hub use.
vi.mock("../src/lib/chapterRail.js", async (original) => {
  const implementation = await original();
  return { ...implementation, createLiveChapterSelector(readOptions) {
    backend.state.chapterOptions = readOptions;
    return implementation.createLiveChapterSelector(readOptions);
  } };
});

const BASE = "https://web-writer-app.invalid";
const KEY = "sb_publishable_test";
const A = "7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59";
const B = "1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36";
const RECORD = "5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10";
const encode = (v) => btoa(JSON.stringify(v)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (sub, aal = "aal2") => `${encode({ alg: "HS256" })}.${encode({ sub, exp: 9999999999, role: "authenticated", session_id: sub, aal })}.sig0`;
const aToken = jwt(A), bToken = jwt(B);
let releaseB, bAsked, askB;
const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
async function transport(input, init) {
  const url = new URL(String(input));
  const bearer = new Headers(init?.headers).get("Authorization");
  const subject = bearer ? JSON.parse(atob(bearer.slice(7).split(".")[1])).sub : A;
  const user = { id: subject, email: "member@example.test", aud: "authenticated", role: "authenticated", factors: backend.state.needsMfa ? [{ id: RECORD, factor_type: "totp", status: "verified" }] : [] };
  if (url.pathname === "/auth/v1/user") {
    if (user.id === B && releaseB) { askB(); return new Promise((resolve) => { releaseB.resolve = () => resolve(json(user)); }); }
    return json(user);
  }
  if (url.pathname.endsWith("/logout")) { backend.state.logouts.push(bearer); return json({}); }
  const name = url.pathname.split("/").at(-1);
  const rpc = url.pathname.includes("/rpc/");
  if (rpc) backend.state.calls.push([name, init?.body ? JSON.parse(init.body) : null]);
  if (["send_member_message", "send_chapter_task_message"].includes(name)) {
    backend.state.writes.push({ name, bearer });
    return json({ id: RECORD, messageId: RECORD, task_id: RECORD, chapter_id: RECORD, sender_id: A, recipient_id: B, body: "A private draft", created_at: "2026-11-19T12:00:00Z" });
  }
  if (name === "member_profiles") return json({ id: user.id, first_name: "A", full_name: "A Member", initials: "AM", language: "en", chapter_id: "chapter-1" });
  const resource = `${rpc ? "rpc" : "table"}:${name}`;
  const value = backend.state.rows[resource] ?? (rpc ? null : []);
  return json(typeof value === "function" ? value() : value);
}
vi.mock("../src/components/MfaSettings.jsx", () => ({
  MfaChallenge: function MfaProbe(props) { backend.state.mfaControls = props; return <div data-testid="mfa-probe" />; },
  MfaEnrollment: function EnrollmentProbe(props) { backend.state.mfaControls = props; return <div data-testid="mfa-probe" />; },
  MfaSettings: () => null,
}));
vi.mock("../src/views/MessagesView.jsx", () => ({ MessagesView: function MessagesProbe(props) { backend.state.controls = props; return <div data-testid="writer-probe" />; } }));
const PEERS = {
  available: true, levels: ["vp"], muted: false, nextOffset: null,
  peers: [{ id: "lead-east", name: "Dana East", title: null, chapters: ["East"], levels: ["vp"] }],
};

beforeEach(async () => {
  vi.stubEnv("MODE", "authenticated-model");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("inert backend")));
  vi.stubGlobal("matchMedia", (query) => ({ matches: query.includes("min-width"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  localStorage.clear(); sessionStorage.clear();
  window.scrollTo = vi.fn(); window.history.replaceState({}, "", "/m/messages");
  Object.assign(backend.state, {
    session: { user: { id: "lead-1", email: "lead-1@example.test" }, access_token: "token" },
    logouts: [], needsMfa: false, mfaControls: null, writes: [], controls: null, calls: [], capturedFor: [], boundedFor: [], chapter: "chapter-1", chapterOptions: null,
    rows: {
      "rpc:get_my_chapter_memberships": [{ chapterId: "chapter-1", organizationId: "org-1", name: "Main", selected: true, roles: ["vp"], organizationRoles: [], chapterRoles: ["vp"] }],
      "rpc:get_member_rewards_summary": { totalPoints: 0 },
      "rpc:list_reward_peer_contact": { available: true, canRequest: false, code: "UG-ABCD", incoming: [], outgoing: [], conversations: [] },
      "rpc:list_cross_chapter_peers": PEERS,
      "rpc:send_cross_chapter_peer_message": {
        created: 1,
        conversations: [{ id: "peer-lead-east", peerName: "Dana East", peerInitials: "DE", updatedAt: "2026-11-10T15:00:00.000Z",
          message: { id: "m-1", sentByMe: true, body: "Joint meeting?", createdAt: "2026-11-10T15:00:00.000Z" } }],
      },
    },
  });
  backend.client = createClient(BASE, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock }, global: { fetch: transport } });
  // Read-only realtime is outside this proof; all Auth/REST writers remain
  // the real pinned SDK and use the intercepted transport above.
  backend.client.channel = () => { const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} }; return channel; };
  backend.client.removeChannel = () => undefined;
  backend.client.realtime.setAuth = async () => undefined;
  releaseB = null;
  bAsked = new Promise((resolve) => { askB = resolve; });
  expect((await backend.client.auth.setSession({ access_token: aToken, refresh_token: "a" })).error).toBeNull();

});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });


const families = [
  ["direct", (props) => props.onSendMessage(RECORD, "A private draft"), "send_member_message"],
  ["task", (props) => props.onSendTaskMessage(RECORD, "A private draft"), "send_chapter_task_message"],
];
it.each(families)("mounted App %s refuses a replacement held at dispatch", async (_label, write) => {
  render(<App />); await screen.findByTestId("writer-probe");
  const composing = backend.state.controls;
  releaseB = {};
  const replacing = backend.client.auth.setSession({ access_token: bToken, refresh_token: "b" });
  await bAsked;
  const pending = write(composing); void Promise.resolve(pending).catch(() => undefined);
  await act(async () => { releaseB.resolve(); releaseB = null; await replacing; await Promise.resolve(pending).catch(() => undefined); });
  expect(backend.state.writes).toEqual([]);
});
it.each(families)("mounted App %s sends with the composing person's token", async (_label, write, rpc) => {
  render(<App />); await screen.findByTestId("writer-probe");
  await act(async () => { await write(backend.state.controls); });
  expect(backend.state.writes).toEqual([{ name: rpc, bearer: `Bearer ${aToken}` }]);
});

it.each(["onSignOut", "onCleared"])("a late A recovery %s cannot sign out or clear the MFA gate of B", async (callback) => {
  backend.state.needsMfa = true;
  await backend.client.auth.setSession({ access_token: jwt(A, "aal1"), refresh_token: "mfa-a" });
  render(<App />); await screen.findByTestId("mfa-probe");
  const old = backend.state.mfaControls;
  await act(async () => { await backend.client.auth.setSession({ access_token: jwt(B, "aal1"), refresh_token: "mfa-b" }); });
  await screen.findByTestId("mfa-probe");
  await act(async () => { await old[callback](); });
  expect((await backend.client.auth.getSession()).data.session.user.id).toBe(B);
  expect(backend.state.logouts).toEqual([]);
  expect(screen.getByTestId("mfa-probe")).toBeInTheDocument();
});
