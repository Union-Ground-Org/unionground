// @vitest-environment node
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { markBroadcastRead, markConversationRead, markNotificationsRead, saveRightsProgress, submitEventRsvp, updateMemberProfile, updateMemberSettings } from "../src/lib/memberApi.js";
import { createMemoryStore, enqueueWrite, replayQueue } from "../src/lib/outbox.js";
import { createMemberOutboxExecutors } from "../src/lib/memberOutboxExecutors.js";

// Fictional sessions only. Exercise the real SDK's lazy request/Auth boundary;
// keep payloads out of assertions and output.
const A = { user: { id: "member-a" }, access_token: "fixture-a" };
const B = { user: { id: "member-b" }, access_token: "fixture-b" };
const asUser = { userId: A.user.id, accessToken: A.access_token };
const writers = {
  rsvp: (client, options) => submitEventRsvp(client, "event-1", "going", options),
  rightsProgress: (client, options) => saveRightsProgress(client, A.user.id, "lesson-1", ["step-1"], options),
  broadcastRead: (client, options) => markBroadcastRead(client, A.user.id, "broadcast-1", options),
  conversationRead: (client, options) => markConversationRead(client, A.user.id, "conversation-1", options),
  notificationsRead: (client, options) => markNotificationsRead(client, A.user.id, options),
  settings: (client, options) => updateMemberSettings(client, A.user.id, { language: "es" }, options),
  profile: (client, options) => updateMemberProfile(client, A.user.id, { fullName: "Fictional Member", firstName: "Fictional", initials: "FM", roleLine: "" }, options),
};

function transport(initial) {
  let current = initial;
  let providerSession;
  const sent = [];
  const paths = [];
  const client = createClient("https://outbox-test.invalid", "fixture-public-key", {
    accessToken: async () => {
      await client.onSdkToken?.();
      return (providerSession ?? current)?.access_token ?? null;
    },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (url, options) => {
      const authorization = new Headers(options.headers).get("Authorization");
      sent.push(authorization);
      paths.push(new URL(url).pathname);
      client.onSent?.();
      return client.respond?.(authorization) ?? new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    } },
  });
  client.auth = { getSession: vi.fn(async () => ({ data: { session: current }, error: null })) };
  return { client, sent, paths, switchTo: (session) => { current = session; }, sdkSession: (session) => { providerSession = session; } };
}

describe.each(Object.entries(writers))("%s offline writer", (kind, write) => {
  it("refuses a replacement account before any request", async () => {
    const io = transport(B);
    let code;
    try { await write(io.client, { asUser }); } catch (error) { code = error.code; }
    expect(code).toBe("SESSION_CHANGED");
    expect(io.sent.length).toBe(0);
  });

  it("pins the checked token across the SDK's later session read", async () => {
    const io = transport(A);
    // The SDK awaits its token provider separately from the actor's read.
    io.sdkSession(B);
    await write(io.client, { asUser });
    expect(io.sent.length).toBe(1);
    expect(io.sent.every((header) => header === `Bearer ${A.access_token}`)).toBe(true);
  });

  it("refuses an absent actor or a signed-out session", async () => {
    for (const [session, pin] of [[A, {}], [null, asUser]]) {
      const io = transport(session);
      let code;
      try { await write(io.client, { asUser: pin }); } catch (error) { code = error.code; }
      expect(code).toBe("SESSION_CHANGED");
      expect(io.sent.length).toBe(0);
    }
  });

  it("uses the same member's refreshed token", async () => {
    const refreshed = { ...A, access_token: "fixture-refreshed" };
    const io = transport(refreshed);
    await write(io.client, { asUser });
    expect(io.sent.length).toBe(1);
    expect(io.sent.every((header) => header === `Bearer ${refreshed.access_token}`)).toBe(true);
  });

  it("keeps the owner's queue and halts without counting a refusal as failed", async () => {
    const io = transport(B);
    const store = createMemoryStore();
    await enqueueWrite(store, A.user.id, { kind, key: "first", args: {} });
    await enqueueWrite(store, A.user.id, { kind, key: "second", args: {} });
    const result = await replayQueue(store, A.user.id, { [kind]: () => write(io.client, { asUser }) }, { stillActing: () => true });
    expect(result).toEqual({ replayed: 0, failed: [], expired: 0, halted: true });
    expect((await store.listEntries(A.user.id)).length).toBe(2);
    expect(io.sent.length).toBe(0);
  });
});

const args = {
  userId: A.user.id, eventId: "event-1", status: "going", lessonId: "lesson-1", completedSteps: ["step-1"],
  broadcastId: "broadcast-1", conversationId: "conversation-1",
  fields: { language: "es", fullName: "Fictional Member", firstName: "Fictional", initials: "FM", roleLine: "" },
};

describe.each(Object.keys(writers))("%s App executor", (kind) => {
  it("captures the actor synchronously and refuses Auth's replacement without dropping the queue", async () => {
    const io = transport(B);
    const executors = createMemberOutboxExecutors(io.client, () => A);
    const store = createMemoryStore();
    await enqueueWrite(store, A.user.id, { kind, key: "one", args });
    const replay = replayQueue(store, A.user.id, executors, { stillActing: () => true });
    expect(await replay).toEqual({ replayed: 0, failed: [], expired: 0, halted: true });
    expect(io.sent.length).toBe(0);
    expect((await store.listEntries(A.user.id)).length).toBe(1);
  });

  it("sends with the checked fresh actor even when the SDK sees a replacement", async () => {
    const fresh = { ...A, access_token: "fixture-fresh-actor" };
    const io = transport(fresh);
    io.sdkSession(B);
    const executors = createMemberOutboxExecutors(io.client, () => A);
    await executors[kind](args);
    expect(io.sent.length).toBe(1);
    expect(io.sent.every((header) => header === `Bearer ${fresh.access_token}`)).toBe(true);
  });

  it("reads the actor when invoked and fails closed without a signed-in actor", async () => {
    const io = transport(A);
    let actor = B;
    const executors = createMemberOutboxExecutors(io.client, () => actor);
    actor = null;
    let code;
    try { await executors[kind](args); } catch (error) { code = error.code; }
    expect(code).toBe("SESSION_CHANGED");
    expect(io.sent.length).toBe(0);
  });

  it("keeps the initiating actor while the Auth lock is pending", async () => {
    const io = transport(A);
    let actor = A;
    let release;
    io.client.auth.getSession.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const executors = createMemberOutboxExecutors(io.client, () => actor);
    const pending = executors[kind](args);
    // An Auth event replaces sessionRef while the cross-tab lock is pending.
    actor = B;
    io.switchTo(B);
    await Promise.resolve();
    release?.({ data: { session: B }, error: null });
    let code;
    try { await pending; } catch (error) { code = error.code; }
    expect(code).toBe("SESSION_CHANGED");
    expect(io.sent.length).toBe(0);
  });
});

// Rights progress is one write: this edition has no client action-log
// (audit) write after it; clients may only read member_action_log.
it("writes only the checked actor's rights progress when the account changes after the request", async () => {
  const io = transport(A);
  io.client.onSent = () => io.switchTo(B);
  await writers.rightsProgress(io.client, { asUser });
  expect(io.paths).toEqual(["/rest/v1/member_rights_progress"]);
  expect(io.sent).toEqual([`Bearer ${A.access_token}`]);
});

describe.each(Object.keys(writers))("%s replay after late JWT expiry", (kind) => {
  it.each([
    ["expiry during the SDK Auth wait", "PGRST301", false],
    ["same-member refresh during the SDK Auth wait", "PGRST303", true],
  ])("retains the queue after %s and retries only for its owner", async (_mechanism, code, refreshDuringWait) => {
    const fresh = { ...A, access_token: "fixture-renewed-owner" };
    const io = transport(A);
    let expires = false;
    let enterAuthWait;
    let releaseAuth;
    const waiting = new Promise((resolve) => { enterAuthWait = resolve; });
    const authLock = new Promise((resolve) => { releaseAuth = resolve; });
    io.client.onSdkToken = async () => {
      io.client.onSdkToken = null;
      enterAuthWait();
      await authLock;
    };
    // The transport rejects only the now-expired checked token. The real SDK
    // still awaits its token provider and preserves the explicit header.
    io.client.respond = (header) => expires && header === `Bearer ${A.access_token}`
      ? new Response(JSON.stringify({ code, message: "JWT expired", details: null, hint: null }),
        { status: 401, headers: { "Content-Type": "application/json" } }) : null;
    const store = createMemoryStore();
    await enqueueWrite(store, A.user.id, { kind, key: "first", args });
    await enqueueWrite(store, A.user.id, { kind, key: "second", args });
    // Keep the App actor snapshot at A even for the replacement attempt, to
    // prove the API's fresh owner validation rather than assume a UI update.
    const executors = createMemberOutboxExecutors(io.client, () => A);
    const replay = () => replayQueue(store, A.user.id, executors, { stillActing: () => true });
    const pending = replay();
    await waiting;
    expires = true;
    if (refreshDuringWait) io.switchTo(fresh);
    releaseAuth();

    expect(await pending).toEqual({ replayed: 0, failed: [], expired: 0, halted: true });
    expect(io.sent.length).toBe(1);
    expect(io.sent[0] === `Bearer ${A.access_token}`).toBe(true);
    expect((await store.listEntries(A.user.id)).length).toBe(2);

    // A different member cannot supply the retry token, even with A's old
    // actor snapshot still in memory. Both owner entries remain untouched.
    io.switchTo(B);
    expect(await replay()).toEqual({ replayed: 0, failed: [], expired: 0, halted: true });
    expect(io.sent.length).toBe(1);
    expect((await store.listEntries(A.user.id)).length).toBe(2);

    io.switchTo(fresh);
    expect(await replay()).toEqual({ replayed: 2, failed: [], expired: 0, halted: false });
    expect(io.sent.length).toBe(3);
    expect(io.sent.slice(1).every((header) => header === `Bearer ${fresh.access_token}`)).toBe(true);
    expect((await store.listEntries(A.user.id)).length).toBe(0);
  });
});
