// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { loadCalendarOAuthStatus, startCalendarOAuth } from "../src/lib/calendarOAuthClient.js";
import { SHELL_LOAD_DEADLINE_MS } from "../src/lib/loadDeadline.js";

afterEach(() => { vi.useRealTimers(); });
const session = { data: { session: { access_token: "controlled-jwt" } }, error: null };
const client = () => ({ auth: { getSession: vi.fn().mockResolvedValue(session) } });
const call = (kind, auth, fetcher) => kind === "status"
  ? loadCalendarOAuthStatus(auth, fetcher) : startCalendarOAuth(auth, "google", fetcher);

it.each(["status", "start"])("bounds stalled %s headers and aborts transport", async (kind) => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise(() => {}));
  let outcome;
  call(kind, client(), fetcher).then((result) => { outcome = result; }, (error) => { outcome = error; });
  await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS);
  expect(outcome).toMatchObject({ name: "TimeoutError" });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["status", "start"])("keeps the %s deadline active while JSON stalls", async (kind) => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) });
  let outcome;
  call(kind, client(), fetcher).then((result) => { outcome = result; }, (error) => { outcome = error; });
  await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS);
  expect(outcome).toMatchObject({ name: "TimeoutError" });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});

it.each(["status", "start"])("bounds a stalled %s session read", async (kind) => {
  vi.useFakeTimers();
  const auth = { auth: { getSession: () => new Promise(() => {}) } };
  const fetcher = vi.fn();
  let outcome;
  call(kind, auth, fetcher).then((result) => { outcome = result; }, (error) => { outcome = error; });
  await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS);
  expect(outcome).toMatchObject({ name: "TimeoutError" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("does not POST after a session resolves beyond the deadline", async () => {
  vi.useFakeTimers();
  let resolveSession;
  const auth = { auth: { getSession: () => new Promise((resolve) => { resolveSession = resolve; }) } };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  let outcome;
  startCalendarOAuth(auth, "google", fetcher).catch((error) => { outcome = error; });
  await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS);
  resolveSession(session);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({ name: "TimeoutError" });
});

it("cannot deliver an authorization URL after an expired body read", async () => {
  vi.useFakeTimers();
  let resolveBody;
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => new Promise((resolve) => { resolveBody = resolve; }) });
  const navigate = vi.fn();
  startCalendarOAuth(client(), "google", fetcher).then(navigate, () => {});
  await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS);
  resolveBody({ ok: true, authorizationUrl: "https://accounts.google.com/" });
  await vi.advanceTimersByTimeAsync(0);
  expect(navigate).not.toHaveBeenCalled();
});

it("clears the timer after success without cancelling the completed request", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  await loadCalendarOAuthStatus(client(), fetcher);
  expect(vi.getTimerCount()).toBe(0);
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
});
