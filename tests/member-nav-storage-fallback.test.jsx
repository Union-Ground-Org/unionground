import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearNavUsageForUser, useNavUsage } from "../src/features/memberHome/useNavUsage.js";
import { emptyNavUsage, navUsageStorageKey, recordNavVisit } from "../src/features/memberHome/navUsage.js";

const member = { userId: "fallback-member", organizationId: "one" };
const denyWrites = () => vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const id of [member.userId, "other-member"]) clearNavUsageForUser(id);
  localStorage.clear();
});

describe("navigation history with unavailable storage", () => {
  it("accumulates failed writes and persists the complete history when storage recovers", () => {
    const write = denyWrites();
    const { result, rerender } = renderHook(props => useNavUsage(props), { initialProps: { ...member, view: "cases" } });
    rerender({ ...member, view: "messages" });
    rerender({ ...member, view: "cases" });
    expect(result.current.weights).toEqual([{ key: "cases", weight: 24 }, { key: "messages", weight: 8 }]);
    write.mockRestore();
    rerender({ ...member, view: "rights" });
    expect(result.current.weights).toEqual([{ key: "cases", weight: 24 }, { key: "messages", weight: 8 }, { key: "rights", weight: 4 }]);
    const restored = renderHook(() => useNavUsage({ ...member }));
    expect(restored.result.current.weights).toEqual(result.current.weights);
  });

  it("retains visits when access to localStorage itself is denied", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    const { result, rerender } = renderHook(props => useNavUsage(props), { initialProps: { ...member, view: "cases" } });
    rerender({ ...member, view: "messages" });
    expect(result.current.weights).toEqual([{ key: "cases", weight: 12 }, { key: "messages", weight: 8 }]);
    act(() => result.current.reset());
    expect(result.current.weights).toEqual([]);
  });

  it("isolates members and organizations, and clears all scopes on sign-out", () => {
    denyWrites();
    const { result, rerender } = renderHook(props => useNavUsage(props), { initialProps: { ...member, view: "cases" } });
    rerender({ ...member, organizationId: "two", view: "messages" });
    expect(result.current.weights).toEqual([{ key: "messages", weight: 8 }]);
    rerender({ ...member, userId: "other-member", view: "rights" });
    expect(result.current.weights).toEqual([{ key: "rights", weight: 4 }]);
    rerender({ ...member, view: null });
    expect(result.current.weights).toEqual([{ key: "cases", weight: 12 }]);
    act(() => clearNavUsageForUser(member.userId));
    expect(result.current.weights).toEqual([]);
    rerender({ ...member, organizationId: "two", view: null });
    expect(result.current.weights).toEqual([]);
    rerender({ ...member, userId: "other-member", view: null });
    expect(result.current.weights).toEqual([{ key: "rights", weight: 4 }]);
    rerender({ ...member, userId: null, view: null });
    expect(result.current.weights).toEqual([]);
  });

  it("does not resurrect stored history when reset cannot remove it", () => {
    const key = navUsageStorageKey(member.userId, member.organizationId);
    localStorage.setItem(key, JSON.stringify(recordNavVisit(emptyNavUsage(), "cases")));
    denyWrites();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    const { result, rerender } = renderHook(props => useNavUsage(props), { initialProps: { ...member, view: "messages" } });
    act(() => result.current.reset());
    expect(result.current.weights).toEqual([]);
    rerender({ ...member, view: "rights" });
    expect(result.current.weights).toEqual([{ key: "rights", weight: 4 }]);
  });

  it("accepts cross-tab storage updates and clear events over the fallback", () => {
    denyWrites();
    const { result, rerender } = renderHook(props => useNavUsage(props), { initialProps: { ...member, view: "cases" } });
    const key = navUsageStorageKey(member.userId, member.organizationId);
    const newValue = JSON.stringify(recordNavVisit(emptyNavUsage(), "voting"));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue })));
    expect(result.current.weights).toEqual([{ key: "voting", weight: 8 }]);
    rerender({ ...member, view: "messages" });
    expect(result.current.weights).toEqual([{ key: "messages", weight: 8 }, { key: "voting", weight: 8 }]);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(result.current.weights).toEqual([]);
  });

  it("keeps demo visits in memory without mixing them into durable history", () => {
    denyWrites();
    const { result, rerender } = renderHook(props => useNavUsage(props), { initialProps: { ...member, persist: false, view: "cases" } });
    rerender({ ...member, persist: false, view: "messages" });
    expect(result.current.weights).toEqual([{ key: "cases", weight: 12 }, { key: "messages", weight: 8 }]);
    rerender({ ...member, persist: true, view: null });
    expect(result.current.weights).toEqual([]);
    rerender({ ...member, persist: true, view: "rights", tracking: false });
    expect(result.current.weights).toEqual([]);
    act(() => result.current.reset());
    expect(result.current.weights).toEqual([]);
  });
});
