// BUG-UG-SIGN-OUT-EVERYWHERE-OTHER-DEVICE-STALE-20261103 (#6885): the
// check that notices a session revoked from another device.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_REVOCATION_CHECK_INTERVAL_MS,
  SESSION_REVOCATION_CHECK_MIN_GAP_MS,
  SESSION_REVOCATION_VERIFY_TIMEOUT_MS,
  sessionRevocationWatchApplies,
  watchSessionRevocation,
} from "../src/lib/sessionRevocationWatch.js";

const token = (sessionId) => `header.${btoa(JSON.stringify({ session_id: sessionId }))}.sig`;
const SESSION = { access_token: token("10000000-0000-4000-8000-000000000001"), refresh_token: "r1", user: { id: "u1" } };
const REVOKED = { error: Object.assign(new Error("gone"), { status: 403, code: "session_not_found" }) };
const LIVE = { data: { user: SESSION.user }, error: null };

function harness({ answer = REVOKED, session = SESSION, verifyImpl = null } = {}) {
  let clock = 1_000_000;
  let current = session;
  const target = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const verify = vi.fn(verifyImpl ?? (async () => (typeof answer === "function" ? answer() : answer)));
  const onRevoked = vi.fn(async () => {});
  const watch = watchSessionRevocation({ getSession: () => current, verify, onRevoked, target, doc, now: () => clock });
  return {
    watch, verify, onRevoked, target, doc,
    advance(ms) { clock += ms; },
    setSession(next) { current = next; },
  };
}

const flush = async () => { for (let pass = 0; pass < 20; pass += 1) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("watchSessionRevocation", () => {
  it("checks once at start and reports a session the provider proves absent", async () => {
    const h = harness();
    await flush();
    expect(h.verify).toHaveBeenCalledWith(SESSION);
    // The proof goes with the session, so sign-out need not verify again.
    expect(h.onRevoked).toHaveBeenCalledWith(SESSION, REVOKED);
    h.watch.stop();
  });

  it("keeps a failed-load check asked for while a verify runs, and runs it once the gap ends", async () => {
    let release;
    let answer = () => new Promise((resolve) => { release = resolve; });
    const h = harness({ answer: () => answer() });
    // The start check is still in flight when the failed load asks.
    const joined = h.watch.check({ defer: true });
    release(LIVE);
    await expect(joined).resolves.toBe(false);
    expect(h.verify).toHaveBeenCalledTimes(1);
    answer = () => REVOKED;
    h.advance(SESSION_REVOCATION_CHECK_MIN_GAP_MS);
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_MIN_GAP_MS);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.onRevoked).toHaveBeenCalledWith(SESSION, REVOKED);
    h.watch.stop();
  });

  it.each([
    ["a live session", LIVE],
    ["a network failure", { error: Object.assign(new TypeError("Failed to fetch"), { status: 0 }) }],
    ["a generic 403", { error: Object.assign(new Error("forbidden"), { status: 403, code: "42501" }) }],
    ["a server error", { error: Object.assign(new Error("upstream"), { status: 500 }) }],
    ["no answer", undefined],
  ])("leaves the session alone on %s", async (_label, answer) => {
    const h = harness({ answer: () => answer });
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.onRevoked).not.toHaveBeenCalled();
    h.watch.stop();
  });

  it("leaves the session alone when the verifier throws", async () => {
    const h = harness({ answer: () => { throw new Error("client unavailable"); } });
    await expect(h.watch.check({ force: true })).resolves.toBe(false);
    expect(h.onRevoked).not.toHaveBeenCalled();
    h.watch.stop();
  });

  it("does not report a session that a new sign-in replaced while the check ran", async () => {
    let release;
    const h = harness({ answer: () => new Promise((resolve) => { release = resolve; }) });
    h.setSession({ ...SESSION, access_token: token("20000000-0000-4000-8000-000000000002") });
    release(REVOKED);
    await flush();
    expect(h.onRevoked).not.toHaveBeenCalled();
    h.watch.stop();
  });

  it("skips the check with no session", async () => {
    const h = harness({ session: null });
    await expect(h.watch.check({ force: true })).resolves.toBe(false);
    expect(h.verify).not.toHaveBeenCalled();
    h.watch.stop();
  });

  it("checks again on focus and on becoming visible, once per burst", async () => {
    const h = harness({ answer: LIVE });
    await flush();
    h.target.dispatchEvent(new Event("focus"));
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(1);
    h.advance(SESSION_REVOCATION_CHECK_MIN_GAP_MS);
    h.target.dispatchEvent(new Event("focus"));
    h.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(2);
    h.advance(SESSION_REVOCATION_CHECK_MIN_GAP_MS);
    h.doc.visibilityState = "hidden";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(2);
    h.doc.visibilityState = "visible";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(3);
    h.watch.stop();
  });

  it("joins a check already in flight", async () => {
    let release;
    const h = harness({ answer: () => new Promise((resolve) => { release = resolve; }) });
    const joined = h.watch.check({ force: true });
    release(LIVE);
    await expect(joined).resolves.toBe(false);
    expect(h.verify).toHaveBeenCalledTimes(1);
    h.watch.stop();
  });

  it("checks on the interval only while the page is visible", async () => {
    const h = harness({ answer: LIVE });
    await flush();
    h.advance(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(h.verify).toHaveBeenCalledTimes(2);
    h.doc.visibilityState = "hidden";
    h.advance(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    expect(h.verify).toHaveBeenCalledTimes(2);
    h.watch.stop();
  });

  it("stops listening and ignores an answer that lands after stop", async () => {
    let release;
    const h = harness({ answer: () => new Promise((resolve) => { release = resolve; }) });
    h.watch.stop();
    release(REVOKED);
    await flush();
    expect(h.onRevoked).not.toHaveBeenCalled();
    h.advance(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    h.target.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_INTERVAL_MS);
    await expect(h.watch.check({ force: true })).resolves.toBe(false);
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("watches every session with a real access token, SAMPLE included, and exempts only the fixture client", () => {
    expect(sessionRevocationWatchApplies({ session: SESSION })).toBe(true);
    expect(sessionRevocationWatchApplies({ fixtureClient: false, session: SESSION })).toBe(true);
    expect(sessionRevocationWatchApplies({ fixtureClient: true, session: SESSION })).toBe(false);
    // The fixture demo session carries no token.
    expect(sessionRevocationWatchApplies({ session: { user: { id: "demo" } } })).toBe(false);
    expect(sessionRevocationWatchApplies({ session: { ...SESSION, access_token: "" } })).toBe(false);
    expect(sessionRevocationWatchApplies({ session: null })).toBe(false);
    expect(sessionRevocationWatchApplies()).toBe(false);
  });

  it("gives up on a verifier that never answers and lets the next check run", async () => {
    const h = harness({ verifyImpl: () => new Promise(() => {}) });
    const first = h.watch.check({ force: true });
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_VERIFY_TIMEOUT_MS);
    await expect(first).resolves.toBe(false);
    expect(h.onRevoked).not.toHaveBeenCalled();
    h.advance(SESSION_REVOCATION_CHECK_MIN_GAP_MS);
    void h.watch.check();
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(2);
    h.watch.stop();
  });

  it("runs a failed-load check deferred inside the gap once the gap ends, at most once", async () => {
    let answer = LIVE;
    const h = harness({ answer: () => answer });
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(1);
    answer = REVOKED;
    h.advance(10_000);
    await expect(h.watch.check({ defer: true })).resolves.toBe(false);
    void h.watch.check({ defer: true });
    void h.watch.check();
    await flush();
    expect(h.verify).toHaveBeenCalledTimes(1);
    h.advance(SESSION_REVOCATION_CHECK_MIN_GAP_MS - 10_000);
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_MIN_GAP_MS - 10_000);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.onRevoked).toHaveBeenCalledWith(SESSION, REVOKED);
    // A deferral pending at stop never runs.
    h.advance(10_000);
    void h.watch.check({ defer: true });
    h.watch.stop();
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_CHECK_MIN_GAP_MS);
    expect(h.verify).toHaveBeenCalledTimes(2);
  });

  it("treats a verifier that throws synchronously as unknown and releases the check", async () => {
    let calls = 0;
    const h = harness({ verifyImpl: () => { calls += 1; if (calls === 1) throw new Error("client unavailable"); return REVOKED; } });
    await flush();
    expect(h.onRevoked).not.toHaveBeenCalled();
    await expect(h.watch.check({ force: true })).resolves.toBe(true);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(h.onRevoked).toHaveBeenCalledWith(SESSION, REVOKED);
    // A sign-out that fails also releases the check for the next try.
    h.onRevoked.mockRejectedValueOnce(new Error("sign-out failed"));
    await expect(h.watch.check({ force: true })).resolves.toBe(false);
    await expect(h.watch.check({ force: true })).resolves.toBe(true);
    h.watch.stop();
  });

  it("uses the browser window and document by default", async () => {
    const verify = vi.fn(async () => LIVE);
    const watch = watchSessionRevocation({ getSession: () => SESSION, verify, onRevoked: vi.fn() });
    await flush();
    expect(verify).toHaveBeenCalledTimes(1);
    watch.stop();
  });
});
