// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSessionGuard,
  isAssuranceDowngrade,
  needsAssuranceRefresh,
  sessionAssuranceLevel,
  sortNewestFirst,
  sortOldestFirst,
  unreadCount,
} from "../src/lib/sessionGuard.js";

const row = (id, createdAt, readAt = null) => ({ id, created_at: createdAt, read_at: readAt });

describe("identity binding", () => {
  it("bumps the generation and resets state on a real identity change", () => {
    const guard = createSessionGuard();
    expect(guard.beginSession("a")).toBe(true);
    const first = guard.generation;
    expect(guard.beginSession("b")).toBe(true);
    expect(guard.generation).toBeGreaterThan(first);
    expect(guard.currentUserId).toBe("b");
  });

  it("does not bump on a token refresh, so the screen is not cleared hourly", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const generation = guard.generation;
    expect(guard.beginSession("a")).toBe(false);
    expect(guard.generation).toBe(generation);
  });

  it("treats sign-out as an identity change", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    expect(guard.beginSession(null)).toBe(true);
    expect(guard.currentUserId).toBeNull();
  });

  it("is idempotent when getSession resolves after onAuthStateChange already fired", () => {
    const guard = createSessionGuard();
    expect(guard.beginSession("a")).toBe(true);
    expect(guard.beginSession("a")).toBe(false);
    expect(guard.generation).toBe(1);
  });
});

function jwt(aal) {
  const payload = Buffer.from(JSON.stringify({ aal })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("same-user assurance transitions", () => {
  const session = (id, token) => ({ user: { id }, access_token: token });

  it("refreshes assurance for initial, identity, and token changes only", () => {
    const first = session("a", jwt("aal1"));
    expect(needsAssuranceRefresh(null, first)).toBe(true);
    expect(needsAssuranceRefresh(first, first)).toBe(false);
    expect(needsAssuranceRefresh(first, session("a", first.access_token))).toBe(false);
    expect(needsAssuranceRefresh(first, session("a", jwt("aal2")))).toBe(true);
    expect(needsAssuranceRefresh(first, session("b", first.access_token))).toBe(true);
    expect(needsAssuranceRefresh(first, null)).toBe(false);
  });

  it("detects only aal2 to non-aal2 token downgrades", () => {
    const assured = session("a", jwt("aal2"));
    expect(sessionAssuranceLevel(assured)).toBe("aal2");
    expect(isAssuranceDowngrade(assured, session("a", jwt("aal1")))).toBe(true);
    expect(isAssuranceDowngrade(assured, session("a", "invalid"))).toBe(true);
    expect(isAssuranceDowngrade(session("a", jwt("aal1")), session("a", jwt("aal2")))).toBe(false);
    expect(isAssuranceDowngrade(assured, session("b", jwt("aal1")))).toBe(false);
    expect(isAssuranceDowngrade(assured, assured)).toBe(false);
  });

  it("invalidates in-flight work while retaining the same identity", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const ticket = guard.beginRequest("a");
    expect(guard.invalidateSecurityContext("a")).toBe(true);
    expect(guard.currentUserId).toBe("a");
    expect(guard.canCommit(ticket)).toBe(false);
  });
});

// THE regression test for the cross-identity render. A slow mutation keeps its
// own binding to a refresh created under member A; if that binding reads the
// CURRENT generation when it finally runs, it stamps B's generation onto A's
// fetch and passes its own check.
describe("a stale caller cannot commit under a new identity", () => {
  it("refuses to start work for a user who is no longer current", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.beginSession("b");
    // The mutation's continuation still holds A's session object.
    expect(guard.beginRequest("a")).toBeNull();
  });

  it("refuses to commit work that started before the identity changed", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const ticket = guard.beginRequest("a");
    guard.beginSession("b");
    expect(guard.canCommit(ticket)).toBe(false);
  });

  it("refuses to commit when the same user signs back in as a new generation", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const ticket = guard.beginRequest("a");
    guard.beginSession(null);
    guard.beginSession("a");
    expect(guard.canCommit(ticket)).toBe(false);
  });

  it("never commits a null ticket", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    expect(guard.canCommit(null)).toBe(false);
  });
});

// The initial load and the SUBSCRIBED gap refetch run under ONE identity and
// finish in either order.
describe("out-of-order responses", () => {
  it("lets the newer response win when it finishes first", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const initial = guard.beginRequest("a");
    const refetch = guard.beginRequest("a");
    expect(guard.canCommit(refetch)).toBe(true);
    // The older initial load finishing afterwards must not overwrite it.
    expect(guard.canCommit(initial)).toBe(false);
  });

  it("commits in order when responses arrive in order", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const first = guard.beginRequest("a");
    const second = guard.beginRequest("a");
    expect(guard.canCommit(first)).toBe(true);
    expect(guard.canCommit(second)).toBe(true);
  });

  it("rejects a replayed ticket", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const ticket = guard.beginRequest("a");
    expect(guard.canCommit(ticket)).toBe(true);
    expect(guard.canCommit(ticket)).toBe(false);
  });
});

describe("realtime rows arriving during a load", () => {
  it("keeps a row that arrived after the load's snapshot", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.beginRequest("a");
    guard.noteRealtimeRow(row("new", "2026-07-23T12:00:00Z"));
    // The load's snapshot predates the row.
    const merged = guard.mergeNotifications([row("old", "2026-07-23T11:00:00Z")]);
    expect(merged.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("keeps a row that arrived while data was still null", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeRow(row("early", "2026-07-23T12:00:00Z"));
    expect(guard.mergeNotifications([]).map((r) => r.id)).toEqual(["early"]);
  });

  it("retires a buffered row once a load result contains it", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeRow(row("x", "2026-07-23T12:00:00Z"));
    expect(guard.pendingCount).toBe(1);
    guard.mergeNotifications([row("x", "2026-07-23T12:00:00Z")]);
    expect(guard.pendingCount).toBe(0);
  });

  it("does not duplicate a row present in both sources", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeRow(row("x", "2026-07-23T12:00:00Z"));
    const merged = guard.mergeNotifications([row("x", "2026-07-23T12:00:00Z"), row("y", "2026-07-23T11:00:00Z")]);
    expect(merged.filter((r) => r.id === "x")).toHaveLength(1);
  });

  it("drops the buffer on an identity change so rows never cross members", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeRow(row("a-row", "2026-07-23T12:00:00Z"));
    guard.beginSession("b");
    expect(guard.pendingCount).toBe(0);
    expect(guard.mergeNotifications([])).toEqual([]);
  });

  it("ignores a row with no id rather than buffering a hole", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    expect(guard.noteRealtimeRow({ created_at: "2026-07-23T12:00:00Z" })).toBe(false);
    expect(guard.pendingCount).toBe(0);
  });
});

describe("board events arriving during a full refresh", () => {
  it("returns only events newer than the request snapshot", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeBoardEvent({ id: "before" });
    const ticket = guard.beginRequest("a");
    guard.noteRealtimeBoardEvent({ id: "after-1" });
    guard.noteRealtimeBoardEvent({ id: "after-2" });
    expect(guard.boardEventsSince(ticket).map((event) => event.id)).toEqual(["after-1", "after-2"]);
  });

  it("never exposes a previous identity's board events", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    const ticket = guard.beginRequest("a");
    guard.noteRealtimeBoardEvent({ id: "private" });
    guard.beginSession("b");
    expect(guard.boardEventsSince(ticket)).toEqual([]);
  });
});

describe("realtime task messages arriving during a load", () => {
  const message = (id, createdAt) => ({ id, taskId: "t1", createdAt });

  it("keeps and orders a task message that arrived after the load snapshot", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeTaskMessage(message("new", "2026-07-23T12:00:00Z"));
    const merged = guard.mergeTaskMessages([message("old", "2026-07-23T11:00:00Z")]);
    expect(merged.map((item) => item.id)).toEqual(["old", "new"]);
  });

  it("deduplicates a task message present in realtime and the refetch", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeTaskMessage(message("same", "2026-07-23T12:00:00Z"));
    const merged = guard.mergeTaskMessages([message("same", "2026-07-23T12:00:00Z")]);
    expect(merged).toHaveLength(1);
    expect(guard.pendingTaskMessageCount).toBe(0);
  });

  it("drops buffered task messages on identity change", () => {
    const guard = createSessionGuard();
    guard.beginSession("a");
    guard.noteRealtimeTaskMessage(message("private", "2026-07-23T12:00:00Z"));
    guard.beginSession("b");
    expect(guard.pendingTaskMessageCount).toBe(0);
    expect(guard.mergeTaskMessages([])).toEqual([]);
  });
});

describe("ordering and counting", () => {
  it("sorts newest first regardless of arrival order", () => {
    const sorted = sortNewestFirst([
      row("mid", "2026-07-23T11:00:00Z"),
      row("new", "2026-07-23T12:00:00Z"),
      row("old", "2026-07-23T10:00:00Z"),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts a row with a missing or unparseable timestamp last instead of scrambling the list", () => {
    const sorted = sortNewestFirst([
      row("broken", "not-a-date"),
      row("missing", undefined),
      row("good", "2026-07-23T12:00:00Z"),
    ]);
    expect(sorted[0].id).toBe("good");
  });

  it("sorts task messages oldest first", () => {
    const sorted = sortOldestFirst([
      { id: "new", createdAt: "2026-07-23T12:00:00Z" },
      { id: "old", createdAt: "2026-07-23T10:00:00Z" },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["old", "new"]);
  });

  // Incrementing a running counter drifts as soon as a row arrives twice or
  // arrives already read; deriving it from the list cannot.
  it("derives the unread count from the list rather than accumulating", () => {
    expect(unreadCount([row("a", "x"), row("b", "x", "2026-07-23T12:00:00Z")])).toBe(1);
    expect(unreadCount([])).toBe(0);
    expect(unreadCount(null)).toBe(0);
  });
});

// App forces demo mode under vitest (`import.meta.env.MODE === "test"` at
// src/App.jsx), so the real-session guard wiring cannot be reached through a
// render from here and these are source tripwires, not behavioural proof.
//
// What they can and cannot do is worth stating plainly, because an exact-text
// pin fails for two unrelated reasons and the failure looks identical: the
// wiring was removed (a real regression), or someone reflowed a line (noise).
// So every pin below is a whitespace-tolerant regex on the INVARIANT — the
// guard call, the early return, the dependency list — and never on incidental
// identifier or formatting choices. The one place an argument IS load-bearing
// (refresh must bind to the identity the call was made FOR, never to the
// ambient `session`) is asserted as a negative, which survives a rename.
//
// The behavioural versions of these — mount the member shell against a stubbed
// auth client, emit TOKEN_REFRESHED, assert the shell is not torn down and a
// stale response cannot commit — belong in tests/App.test.jsx behind a
// non-"test" MODE stub, and remain uncovered.
describe("App wiring", () => {
  const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");

  it("gates every load through beginRequest/canCommit", () => {
    expect(app).toMatch(/guardRef\.current\.beginRequest\(/);
    expect(app).toMatch(/if\s*\(\s*!\s*guardRef\.current\.canCommit\(\s*ticket\s*\)\s*\)\s*return;/);
  });

  // Binding the ticket to the ambient `session` instead of the session the call
  // was made for is the cross-identity render bug the guard exists to prevent,
  // so it is pinned as a prohibition rather than as one spelling of the fix.
  it("binds each load's ticket to the session passed in, not the current one", () => {
    expect(app).not.toMatch(/beginRequest\(\s*session\??\.user\??\.id\s*\)/);
  });

  // The same-user assurance pin, restated for the
  // realtime effect: a downgrade bumps the guard generation, and the channel
  // effect is keyed on that generation, so it re-subscribes under the new token.
  it("restarts Realtime with the new token after a same-user assurance change", () => {
    expect(app).toMatch(/\[demoActive, session\?\.user\?\.id, sessionGeneration, canUseStaffTools/);
    expect(app).toMatch(/isAssuranceDowngrade\(previousSession, nextSession\)[\s\S]{0,200}invalidateSecurityContext\(/);
  });

  it("delegates realtime row ordering and authoritative reconciliation to the resource registry", () => {
    expect(app).toContain('noteLive("table:member_notifications", row)');
    expect(app).toContain('noteLive("table:chapter_task_messages", row)');
    expect(app).toContain("loaderFor(activeSession).reconcileRealtime()");
    expect(app).not.toContain("guardRef.current.mergeNotifications(");
  });

  // The demo session is now derived from the fixtures, which arrive over a
  // dynamic import (they are not in the member bundle), so the id comes off the
  // resolved fixtures rather than a module-level constant. Both demo entry
  // paths — the sign-in button and a cold ?demo=1 boot — must still bump the
  // guard before painting fixture data over a live read that is still in
  // flight.
  //
  // enterDemo goes through beginSessionGeneration rather than calling
  // beginSession directly: entering the demo IS an identity transition, so it
  // owes the same member-scoped clear-down (Compass draft, search focus, open
  // dialogs) as a sign-in. The cold-boot effect is the one remaining direct
  // call — it runs before any of that state can exist. There is no in-app
  // demo EXIT any more (Wave 1,: the Exit demo
  // option is removed); leaving the demo is a full page load without ?demo=1,
  // which boots a fresh generation by construction — so the old
  // beginSessionGeneration(null) call has no site left, and exitDemo staying
  // gone is part of this contract.
  it("routes demo transitions through the same guard", () => {
    expect(app.match(/beginSession(Generation)?\(fixtures\.member\.id\)/g)).toHaveLength(2);
    expect(app).toContain("beginSessionGeneration(fixtures.member.id)");
    expect(app).toContain("guardRef.current.beginSession(fixtures.member.id)");
    expect(app).not.toContain("function exitDemo");
    const entry = app.slice(app.indexOf("async function enterDemo"), app.indexOf("function switchHat"));
    expect(entry).toContain("selectedStaffHatRef.current = DEFAULT_SAMPLE_HAT");
    expect(entry).toContain("setSelectedStaffHat(DEFAULT_SAMPLE_HAT)");
  });

  // The clear-down list is the whole point of routing through
  // beginSessionGeneration: the Compass draft is member-authored free text
  // about their own discipline or grievance, and leaving it behind hands it to
  // the next identity on a shared device.
  it("clears member-scoped overlay state on every identity change", () => {
    const body = app.slice(app.indexOf("const beginSessionGeneration = useCallback"));
    const guarded = body.slice(0, body.indexOf("return guardRef.current.generation;"));
    expect(body).toContain("const beginSessionGeneration = useCallback");
    for (const call of [
      "setAssistantOpen(false)",
      'setAssistantDraft("")',
      "setSearchFocus(null)",
      "setGuideOpen(false)",
      "setTourOpen(false)",
      "if (nextUserId) setLoading(true)",
    ]) {
      expect(guarded, `beginSessionGeneration must ${call}`).toContain(call);
    }
  });

  it("keeps no parallel generation bookkeeping that could drift from the guard", () => {
    expect(app).not.toContain("sessionGenerationRef");
    expect(app).not.toContain("currentUserIdRef");
  });

  // The auth listener replaced the older acceptAuthSession
  // funnel; the same guarantees are pinned on the listener itself.
  it("closes assurance before installing every real auth session", () => {
    const listener = app.slice(app.indexOf("supabase.auth.onAuthStateChange("), app.indexOf("const onStorage = (event) =>"));
    expect(listener).toMatch(/setMfaRequired\(\s*null\s*\)/);
    expect(listener).toMatch(/sessionRef\.current\s*=\s*nextSession/);
    expect(listener.indexOf("setMfaRequired(null)")).toBeLessThan(listener.lastIndexOf("setSession(nextSession)"));
  });

  it("clears and invalidates cached data on an assurance downgrade", () => {
    const listener = app.slice(app.indexOf("supabase.auth.onAuthStateChange("), app.indexOf("const onStorage = (event) =>"));
    expect(listener).toMatch(/isAssuranceDowngrade\(\s*previousSession,\s*nextSession\s*\)/);
    expect(listener).toMatch(/guardRef\.current\.invalidateSecurityContext\(/);
    expect(listener).toMatch(/clearSessionScopedStateRef\.current\(\)/);
    const clear = app.slice(app.indexOf("function clearSessionScopedState()"), app.indexOf("const clearSessionScopedStateRef"));
    expect(clear).toContain("setData(null)");
    expect(clear).toContain("setActivePlan(null)");
  });
});


it("operation scopes guard success, rejection, nested writes and same-user new sign-ins", async () => {
  const guard = createSessionGuard();
  guard.beginSession("a");
  const operation = guard.captureOperation("a");
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const writes = [];
  const work = operation.run(async () => {
    await operation.wait(pending);
    writes.push("private");
  });
  guard.beginSession("b");
  guard.beginSession("a");
  resolve();
  await expect(work).resolves.toBeUndefined();
  expect(writes).toEqual([]);
  expect(operation.isCurrent()).toBe(false);
  await expect(operation.run(() => writes.push("stale callback"))).resolves.toBeUndefined();
  expect(writes).toEqual([]);
  const current = guard.captureOperation("a");
  const error = new Error("current failure");
  await expect(current.run(() => current.wait(Promise.reject(error)))).rejects.toBe(error);
});


it("a distinct sign-in by the same user retires operations while a token refresh preserves them", () => {
  const guard = createSessionGuard();
  guard.beginSession("a");
  const operation = guard.captureOperation("a");
  expect(guard.beginSession("a")).toBe(false);
  expect(operation.isCurrent()).toBe(true);
  expect(guard.beginSession("a", { newSignIn: true })).toBe(true);
  expect(operation.isCurrent()).toBe(false);
});
