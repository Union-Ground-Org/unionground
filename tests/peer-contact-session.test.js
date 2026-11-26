import { createClient, processLock } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it } from "vitest";
import { PeerSessionChanged, createSessionPeerContactApi } from "../src/lib/peerContactSession.js";

// SEC-UG-PRIVATE-MESSAGE-SEND-GOES-OUT-UNDER-WHOEVER-IS-SIGNED-IN-20261119
// (#9203): every private two-person write on the website carries the session
// of the person who started it. The real pinned Supabase client and an auth
// lock (no network: the transport is intercepted, the tokens are synthetic).
// The shared client is signed in as the officer; an account change to the
// member starts and is held on its /auth/v1/user answer while the officer's
// write is made. Before the repair each writer used the shared client, waited
// on the lock and left with the member's token (R-9202-RESULT.md, A1).
const URL_BASE = "https://peer-session-web-test.invalid";
const KEY = "sb_publishable_test";
const officer = "7f3a1b2c-9d8e-4c5f-a6b7-0e1d2c3b4a59";
const member = "1c4e7a90-3b2d-4f6e-8a1c-5d9b0e7f2a36";
const encode = (value) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (sub) => [encode({ alg: "HS256", typ: "JWT" }), encode({ sub, exp: 9999999999, role: "authenticated" }), "sig0"].join(".");
const officerToken = jwt(officer);
const memberToken = jwt(member);
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// #9229 round 1 (r1s3): the same person's later tokens.
const jwtFor = (sub, exp, nonce) => [encode({ alg: "HS256", typ: "JWT" }), encode({ sub, exp, role: "authenticated", nonce }), "sig0"].join(".");
const refreshedToken = jwtFor(officer, 9999999999, "refreshed");
const officerAgainToken = jwtFor(officer, 9999999999, "signed-in-again");

let requests;
let refreshes;
let memberUser;
let memberUserAsked;
let captured;
let shared;

async function transport(input, init) {
  const url = String(input);
  const authorization = new Headers(init?.headers).get("Authorization");
  if (url.endsWith("/auth/v1/user")) {
    if (authorization === `Bearer ${memberToken}`) { memberUserAsked.resolve(); return memberUser.promise; }
    return json({ id: officer, aud: "authenticated", role: "authenticated" });
  }
  if (url.includes("/auth/v1/token")) {
    refreshes += 1;
    return json({ access_token: refreshedToken, refresh_token: "refresh-officer-2", token_type: "bearer", expires_in: 3600, user: { id: officer, aud: "authenticated", role: "authenticated" } });
  }
  requests.push({ url, authorization, body: init?.body ? JSON.parse(String(init.body)) : null });
  if (url.endsWith("/rpc/list_reward_peer_contact")) return json({ available: true, conversations: [] });
  return json({ message: { id: "m-1", sentByMe: true, body: "Hello", createdAt: "2026-11-19T10:00:00.000Z" }, requested: true, accepted: true, created: 1, conversation: { id: "c-1" }, conversations: [] });
}

// As src/lib/supabase.js createCapturedAppSessionRpcClient builds it: the
// access token is fixed to the captured session, with no auth state of its own.
function createSessionClient(session) {
  captured.push(session.user.id);
  const token = session.access_token;
  return createClient(URL_BASE, KEY, {
    accessToken: async () => token,
    global: { fetch: transport },
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

beforeEach(async () => {
  requests = [];
  refreshes = 0;
  captured = [];
  memberUser = deferred();
  memberUserAsked = deferred();
  shared = createClient(URL_BASE, KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, lock: processLock },
    global: { fetch: transport },
  });
  expect((await shared.auth.setSession({ access_token: officerToken, refresh_token: "refresh-officer" })).error).toBeNull();
});

async function officerApi() {
  const session = (await shared.auth.getSession()).data.session;
  expect(session?.user.id).toBe(officer);
  return createSessionPeerContactApi({ sharedClient: shared, session, createSessionClient });
}

async function holdAccountChange() {
  const replacing = shared.auth.setSession({ access_token: memberToken, refresh_token: "refresh-member" });
  await memberUserAsked.promise;
  return async () => {
    memberUser.resolve(json({ id: member, aud: "authenticated", role: "authenticated" }));
    await replacing;
  };
}

const writers = [
  ["a reply", (api) => api.send("conversation-1", " Bring the overtime list ")],
  ["a contact request", (api) => api.request("UG-0123456789ABCDEF0123")],
  ["an answer to a contact request", (api) => api.respond("request-1", true)],
  ["a first message to an officer", (api) => api.startOfficer(member, "Hello")],
  ["a cross-chapter message", (api) => api.sendCrossChapter([member], "Joint meeting?")],
  ["a block", (api) => api.setBlock("conversation-1", true)],
];

describe("a private two-person write on the website while the account changes", () => {
  it.each(writers)("never sends %s under the next person's token, and refuses it", async (_label, write) => {
    const api = await officerApi();
    const release = await holdAccountChange();
    const pending = write(api);
    pending.catch(() => undefined);
    await release();
    await pending.catch(() => undefined);
    // The defect: the officer's write left with the member's token.
    expect(requests.map((request) => request.authorization)).not.toContain(`Bearer ${memberToken}`);
    expect(requests).toEqual([]);
    await expect(pending).rejects.toBeInstanceOf(PeerSessionChanged);
  });

  it.each(writers)("refuses %s from a page whose person is no longer the one signed in", async (_label, write) => {
    const api = await officerApi();
    await (await holdAccountChange())();
    await expect(write(api)).rejects.toMatchObject({ details: "peer_session_changed" });
    expect(requests).toEqual([]);
  });

  it.each(writers)("sends %s with the starting person's own token when nothing changed", async (_label, write) => {
    await write(await officerApi());
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe(`Bearer ${officerToken}`);
    expect(captured).toEqual([officer]);
  });

  it("sends the trimmed reply to the conversation it was written in", async () => {
    await (await officerApi()).send("conversation-1", " Bring the overtime list ");
    expect(requests[0]).toMatchObject({ url: `${URL_BASE}/rest/v1/rpc/send_reward_peer_message`, body: { p_conversation_id: "conversation-1", p_body: "Bring the overtime list" } });
  });

  it("reads the list through the shared client, and refuses every write with no session", async () => {
    const api = createSessionPeerContactApi({ sharedClient: shared, session: null, createSessionClient });
    await api.list();
    expect(requests.map((request) => request.url)).toEqual([`${URL_BASE}/rest/v1/rpc/list_reward_peer_contact`]);
    for (const [, write] of writers) await expect(write(api)).rejects.toBeInstanceOf(PeerSessionChanged);
    expect(requests).toHaveLength(1);
    expect(captured).toEqual([]);
  });
});

// #9229 round 1 (r1s3): the binding is the person, not the token. Pinning the
// page's own token refused a legitimate write once the same person's token
// was refreshed; now the write goes with the token the check itself read.
describe("a private two-person write on the website after the same person's session changes", () => {
  it.each(writers)("sends %s with the refreshed token, not the page's expiring one", async (_label, write) => {
    // A token inside auth-js's refresh margin: the check's read refreshes it.
    const expiring = jwtFor(officer, Math.floor(Date.now() / 1000) + 30, "expiring");
    const page = (await shared.auth.setSession({ access_token: expiring, refresh_token: "refresh-officer" })).data.session;
    expect(page?.access_token).toBe(expiring);
    await write(createSessionPeerContactApi({ sharedClient: shared, session: page, createSessionClient }));
    expect(refreshes).toBe(1);
    expect(requests.map((request) => request.authorization)).toEqual([`Bearer ${refreshedToken}`]);
    expect(captured).toEqual([officer]);
  });

  it.each(writers)("sends %s after the same person signs in again, with the new session's token", async (_label, write) => {
    const api = await officerApi();
    expect((await shared.auth.setSession({ access_token: officerAgainToken, refresh_token: "refresh-officer-again" })).error).toBeNull();
    await write(api);
    expect(requests.map((request) => request.authorization)).toEqual([`Bearer ${officerAgainToken}`]);
  });
});
