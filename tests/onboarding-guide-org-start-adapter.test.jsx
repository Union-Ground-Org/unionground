// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029: the org-start
// guide's shell hook (src/features/onboardingGuideEngine/orgStartAdapter.js).
// It reads once per screen change and on window focus, drops a stale answer,
// forgets the payload when the session or organization changes, never throws
// into the page, and keeps the guide a writer hands back.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrganizationStartGuide } from "../src/features/onboardingGuideEngine/orgStartAdapter.js";

const ACTIVE = { state: "active", organizationName: "Tamarack Valley" };
const LIVE = { state: "live", organizationName: "Tamarack Valley" };

function clientWith(answers) {
  // Each rpc call takes the next answer; a function answer runs with the args.
  const queue = [...answers];
  const rpc = vi.fn(async (name, args) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next(name, args);
    if (next instanceof Error) return { data: null, error: { message: next.message, code: "42501" } };
    return { data: next, error: null };
  });
  return { rpc };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("useOrganizationStartGuide", () => {
  it("reads nothing while disabled and answers no payload", async () => {
    const client = clientWith([ACTIVE]);
    const { result } = renderHook(() => useOrganizationStartGuide({ client, enabled: false, scope: "u1:o1", refreshKey: "today" }));
    await waitFor(() => expect(result.current.payload).toBeNull());
    expect(client.rpc).not.toHaveBeenCalled();
    expect(await result.current.reviewSwitches()).toBeNull();
    expect(await result.current.saveContacts({ backupUserId: null, spokespersonUserIds: [] })).toBeNull();
    expect(await result.current.celebrate()).toBeNull();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("reads nothing without a client", async () => {
    const { result } = renderHook(() => useOrganizationStartGuide({ client: null, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    await waitFor(() => expect(result.current.payload).toBeNull());
    expect(await result.current.reload()).toBeUndefined();
    expect(await result.current.celebrate()).toBeNull();
  });

  it("reads the guide once enabled, again on a screen change and again on window focus", async () => {
    const client = clientWith([ACTIVE]);
    const { result, rerender } = renderHook((props) => useOrganizationStartGuide(props), { initialProps: { client, enabled: true, scope: "u1:o1", refreshKey: "today" } });
    await waitFor(() => expect(result.current.payload).toEqual(ACTIVE));
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("get_organization_start_guide");
    rerender({ client, enabled: true, scope: "u1:o1", refreshKey: "admin" });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(2));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(3));
    expect(result.current.payload).toEqual(ACTIVE);
  });

  it("stops listening for focus once disabled", async () => {
    const client = clientWith([ACTIVE]);
    const { result, rerender } = renderHook((props) => useOrganizationStartGuide(props), { initialProps: { client, enabled: true, scope: "u1:o1", refreshKey: "today" } });
    await waitFor(() => expect(result.current.payload).toEqual(ACTIVE));
    rerender({ client, enabled: false, scope: "u1:o1", refreshKey: "today" });
    await waitFor(() => expect(result.current.payload).toBeNull());
    const calls = client.rpc.mock.calls.length;
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(client.rpc.mock.calls.length).toBe(calls);
  });

  it("shows nothing when the read fails or throws, and never throws into the page", async () => {
    const failing = clientWith([new Error("staff role and MFA required")]);
    const { result } = renderHook(() => useOrganizationStartGuide({ client: failing, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    await waitFor(() => expect(failing.rpc).toHaveBeenCalledTimes(1));
    expect(result.current.payload).toBeNull();
    const throwing = { rpc: vi.fn(async () => { throw new Error("network"); }) };
    const second = renderHook(() => useOrganizationStartGuide({ client: throwing, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    await waitFor(() => expect(throwing.rpc).toHaveBeenCalledTimes(1));
    expect(second.result.current.payload).toBeNull();
  });

  it("forgets the payload the moment the session or organization changes, then reads for the new one", async () => {
    const client = clientWith([ACTIVE]);
    const { result, rerender } = renderHook((props) => useOrganizationStartGuide(props), { initialProps: { client, enabled: true, scope: "u1:o1", refreshKey: "today" } });
    await waitFor(() => expect(result.current.payload).toEqual(ACTIVE));
    const later = clientWith([LIVE]);
    rerender({ client: later, enabled: true, scope: "u2:o1", refreshKey: "today" });
    // The old payload belongs to the old scope: not shown for the new one.
    expect(result.current.payload).toBeNull();
    await waitFor(() => expect(result.current.payload).toEqual(LIVE));
  });

  it("drops a slow earlier read when a newer read has already answered", async () => {
    const slow = deferred();
    const answers = [() => slow.promise, { data: LIVE, error: null }];
    const rpc = vi.fn(async () => { const next = answers.shift(); return typeof next === "function" ? next() : next; });
    const client = { rpc };
    const { result, rerender } = renderHook((props) => useOrganizationStartGuide(props), { initialProps: { client, enabled: true, scope: "u1:o1", refreshKey: "today" } });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    rerender({ client, enabled: true, scope: "u1:o1", refreshKey: "admin" });
    await waitFor(() => expect(result.current.payload).toEqual(LIVE));
    await act(async () => { slow.resolve({ data: ACTIVE, error: null }); });
    expect(result.current.payload).toEqual(LIVE);
  });

  it("keeps the guide a writer hands back and passes the writers' arguments", async () => {
    const client = clientWith([(name, args) => {
      if (name === "get_organization_start_guide") return { data: ACTIVE, error: null };
      if (name === "mark_organization_start_switches_reviewed") return { data: { ...ACTIVE, reviewed: true }, error: null };
      if (name === "save_organization_start_contacts") return { data: { ...ACTIVE, contacts: args }, error: null };
      if (name === "acknowledge_organization_start_celebration") return { data: { state: "done" }, error: null };
      return { data: null, error: { message: `unexpected ${name}` } };
    }]);
    const { result } = renderHook(() => useOrganizationStartGuide({ client, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    await waitFor(() => expect(result.current.payload).toEqual(ACTIVE));
    let answer;
    await act(async () => { answer = await result.current.reviewSwitches(); });
    expect(answer).toEqual({ ...ACTIVE, reviewed: true });
    expect(result.current.payload).toEqual({ ...ACTIVE, reviewed: true });
    await act(async () => { answer = await result.current.saveContacts({ backupUserId: "b", spokespersonUserIds: ["s1"] }); });
    expect(client.rpc).toHaveBeenCalledWith("save_organization_start_contacts", { p_backup_user_id: "b", p_spokesperson_user_ids: ["s1"] });
    expect(result.current.payload.contacts).toEqual({ p_backup_user_id: "b", p_spokesperson_user_ids: ["s1"] });
    await act(async () => { answer = await result.current.celebrate(); });
    expect(answer).toEqual({ state: "done" });
    expect(result.current.payload).toEqual({ state: "done" });
  });

  it("lets a failed write reach the caller and keeps the last good payload", async () => {
    const client = clientWith([(name) => (name === "get_organization_start_guide"
      ? { data: ACTIVE, error: null }
      : { data: null, error: { message: "organization administrator and MFA required", code: "42501" } })]);
    const { result } = renderHook(() => useOrganizationStartGuide({ client, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    await waitFor(() => expect(result.current.payload).toEqual(ACTIVE));
    await expect(result.current.reviewSwitches()).rejects.toMatchObject({ code: "42501" });
    expect(result.current.payload).toEqual(ACTIVE);
  });

  it.each([
    ["ready", { data: ACTIVE, error: null }, ACTIVE],
    ["failed", { data: null, error: { message: "offline" } }, null],
  ])("settles the pending guide read to %s after a write is refused", async (phase, response, payload) => {
    const read = deferred();
    const client = clientWith([(name) => name === "get_organization_start_guide"
      ? read.promise
      : { data: null, error: { message: "write refused", code: "42501" } }]);
    const { result } = renderHook(() => useOrganizationStartGuide({ client, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    expect(result.current.phase).toBe("loading");
    await expect(result.current.reviewSwitches()).rejects.toMatchObject({ code: "42501" });
    await act(async () => { read.resolve(response); });
    expect(result.current).toMatchObject({ phase, payload });
  });

  it("uses the successful write and drops the older pending read", async () => {
    const read = deferred();
    const client = clientWith([(name) => name === "get_organization_start_guide"
      ? read.promise : { data: LIVE, error: null }]);
    const { result } = renderHook(() => useOrganizationStartGuide({ client, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    await act(async () => { await result.current.reviewSwitches(); });
    await act(async () => { read.resolve({ data: ACTIVE, error: null }); });
    expect(result.current).toMatchObject({ phase: "ready", payload: LIVE });
  });

  it("drops a slow write's answer when a newer read has already answered", async () => {
    const slowWrite = deferred();
    const client = clientWith([(name) => (name === "get_organization_start_guide" ? { data: LIVE, error: null } : slowWrite.promise)]);
    const { result } = renderHook(() => useOrganizationStartGuide({ client, enabled: true, scope: "u1:o1", refreshKey: "today" }));
    await waitFor(() => expect(result.current.payload).toEqual(LIVE));
    let pending;
    act(() => { pending = result.current.celebrate(); });
    await act(async () => { await result.current.reload(); });
    await act(async () => { slowWrite.resolve({ data: { state: "done" }, error: null }); await pending; });
    expect(result.current.payload).toEqual(LIVE);
  });
});
