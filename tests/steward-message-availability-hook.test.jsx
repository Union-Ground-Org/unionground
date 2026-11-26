// BUG-UG-HOME-GUIDE-NAMES-PAUSED-STEWARD-20261103 (#6876), gate
// rounds 1 and 2: the steward-message answer belongs to one member in one
// chapter of one organization, is read only while something needs it, is
// re-read on member-data refreshes and on a new session token, and keeps the
// last settled answer while a re-read runs.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { STEWARD_AVAILABILITY_REFRESH_MS, useStewardMessageAvailability } from "../src/lib/useStewardMessageAvailability.js";

const USER = "00000000-0000-4000-8000-000000006876";
const live = { isCurrent: () => true, run: (work) => Promise.resolve().then(work) };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(initial, read) {
  let clock = 1_000_000;
  const capture = vi.fn(() => live);
  const now = () => clock;
  const hook = renderHook((props) => useStewardMessageAvailability({ read, capture, now, ...props }), { initialProps: initial });
  return { ...hook, capture, advance: (ms) => { clock += ms; } };
}

const base = { sessionUserId: USER, memberId: USER, chapterId: "ash-local", organizationId: "org-a", refreshKey: 0, assuranceKey: "token-1" };
const settle = () => act(async () => {});

describe("useStewardMessageAvailability", () => {
  it("reads once the member's data is in and returns the answer", async () => {
    const read = vi.fn(async () => false);
    const { result, capture } = setup(base, read);
    await settle();
    expect(result.current).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(USER);
  });

  it("reads nothing until something needs the answer, then reads", async () => {
    const read = vi.fn(async () => true);
    const { result, rerender } = setup({ ...base, needed: false }, read);
    await settle();
    expect(read).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    rerender({ ...base, needed: true });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });

  it("clears the answer on a chapter switch, reads again, and drops the old chapter's late answer", async () => {
    const first = deferred();
    const second = deferred();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = setup(base, read);
    await settle();
    rerender({ ...base, chapterId: "ash-hhs" });
    expect(result.current).toBeNull();
    await act(async () => { first.resolve(false); });
    // The old chapter's "no steward" must not land on the new chapter.
    expect(result.current).toBeNull();
    await act(async () => { second.resolve(true); });
    expect(result.current).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("clears and reads again when the organization changes", async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result, rerender } = setup(base, read);
    await settle();
    expect(result.current).toBe(false);
    rerender({ ...base, organizationId: "org-b" });
    expect(result.current).toBeNull();
    await settle();
    expect(result.current).toBe(true);
  });

  it("re-reads on a member-data refresh once the refresh window has passed, keeping the last answer meanwhile", async () => {
    const reread = deferred();
    const read = vi.fn().mockResolvedValueOnce(false).mockReturnValueOnce(reread.promise);
    const { result, rerender, advance } = setup(base, read);
    await settle();
    expect(result.current).toBe(false);
    // A refresh inside the window reuses the answer.
    rerender({ ...base, refreshKey: 1 });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    advance(STEWARD_AVAILABILITY_REFRESH_MS);
    rerender({ ...base, refreshKey: 2 });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    // The steward finished two-step sign-in; until the re-read lands, the last answer stays.
    expect(result.current).toBe(false);
    await act(async () => { reread.resolve(true); });
    expect(result.current).toBe(true);
  });

  it("does not re-read when Messages opens again in the same scope, even after an unknown answer", async () => {
    const read = vi.fn(async () => null);
    const { rerender } = setup(base, read);
    await settle();
    rerender({ ...base, needed: false });
    rerender({ ...base, needed: true });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("joins a re-read already running instead of starting another", async () => {
    const pending = deferred();
    const read = vi.fn().mockReturnValueOnce(pending.promise);
    const { rerender, advance } = setup(base, read);
    await settle();
    advance(STEWARD_AVAILABILITY_REFRESH_MS);
    rerender({ ...base, refreshKey: 1 });
    rerender({ ...base, refreshKey: 2 });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(true); });
  });

  it("retries a failed read on the next refresh and re-reads at once on a new token (aal1 to aal2)", async () => {
    // Before the second factor the RPC refuses, so the answer is unknown.
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result, rerender, advance } = setup(base, read);
    await settle();
    expect(result.current).toBeNull();
    advance(STEWARD_AVAILABILITY_REFRESH_MS);
    rerender({ ...base, refreshKey: 1 });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(true);
    // Inside the refresh window, a new session token still re-reads.
    rerender({ ...base, refreshKey: 1, assuranceKey: "token-2" });
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current).toBe(false);
  });

  it("keeps the last answer when a re-read fails or rejects", async () => {
    const read = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(null);
    const { result, rerender, advance, capture } = setup(base, read);
    await settle();
    advance(STEWARD_AVAILABILITY_REFRESH_MS);
    rerender({ ...base, refreshKey: 1 });
    await settle();
    expect(result.current).toBe(false);
    capture.mockReturnValueOnce({ isCurrent: () => true, run: () => Promise.reject(new Error("transport")) });
    advance(STEWARD_AVAILABILITY_REFRESH_MS);
    rerender({ ...base, refreshKey: 2 });
    await settle();
    expect(result.current).toBe(false);
    // The rejected read released the slot, so the next refresh reads again.
    read.mockResolvedValueOnce(true);
    advance(STEWARD_AVAILABILITY_REFRESH_MS);
    rerender({ ...base, refreshKey: 3 });
    await settle();
    expect(result.current).toBe(true);
  });

  it("uses the real clock by default, so a refresh right after a read reuses it", async () => {
    const read = vi.fn(async () => true);
    const capture = () => live;
    const { result, rerender } = renderHook((props) => useStewardMessageAvailability({ read, capture, ...props }), { initialProps: base });
    await settle();
    rerender({ ...base, refreshKey: 1 });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });

  it("stays unknown with no read in the fixture app, before the member's data, or for a superseded identity", async () => {
    const read = vi.fn(async () => false);
    setup({ ...base, skip: true }, read);
    setup({ ...base, memberId: null }, read);
    setup({ ...base, sessionUserId: null }, read);
    await settle();
    expect(read).not.toHaveBeenCalled();
    const superseded = { isCurrent: () => false, run: async () => undefined };
    const hook = renderHook(() => useStewardMessageAvailability({ ...base, read, capture: () => superseded }));
    await settle();
    expect(hook.result.current).toBeNull();
  });
});
