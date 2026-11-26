import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGE_WORKFLOW_DEFAULT,
  useMessageWorkflowOnboarding,
  useMessageWorkflowPreference,
} from "../src/lib/messageWorkflow.js";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

function useWorkflow(memberId) {
  const [workflow, choose] = useMessageWorkflowPreference(memberId);
  const [onboarded, complete] = useMessageWorkflowOnboarding(memberId);
  return { workflow, choose, onboarded, complete };
}

function refuseWrites() {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage unavailable", "QuotaExceededError");
  });
}

describe("messaging workflow without writable storage", () => {
  it.each(["attention", "workstreams"])("keeps %s through the first-use completion and mirrors it only to the same member", (choice) => {
    refuseWrites();
    const first = renderHook(() => useWorkflow("member-a"));
    const mirror = renderHook(() => useWorkflow("member-a"));
    const other = renderHook(() => useWorkflow("member-b"));

    act(() => { first.result.current.choose(choice); first.result.current.complete(); });

    expect(first.result.current.workflow).toBe(choice);
    expect(first.result.current.onboarded).toBe(true);
    expect(mirror.result.current.workflow).toBe(choice);
    expect(mirror.result.current.onboarded).toBe(true);
    expect(other.result.current.workflow).toBe(MESSAGE_WORKFLOW_DEFAULT);
    expect(other.result.current.onboarded).toBe(false);
  });

  it("does not restore an older saved workflow after the new choice cannot be stored", () => {
    localStorage.setItem("unionground:messaging-workflow:v1:member-a", "workstreams");
    refuseWrites();
    const hook = renderHook(() => useWorkflow("member-a"));

    act(() => { hook.result.current.choose("attention"); hook.result.current.complete(); });

    expect(hook.result.current.workflow).toBe("attention");
    expect(localStorage.getItem("unionground:messaging-workflow:v1:member-a")).toBe("workstreams");
  });

  it("keeps the choice when storage reads and writes both fail", () => {
    refuseWrites();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Blocked storage"); });
    const hook = renderHook(() => useWorkflow("member-a"));

    act(() => { hook.result.current.choose("attention"); hook.result.current.complete(); });

    expect(hook.result.current.workflow).toBe("attention");
    expect(hook.result.current.onboarded).toBe(true);
  });

  it("does not use one member's unstored choice after the mounted view changes accounts", () => {
    refuseWrites();
    const hook = renderHook(({ memberId }) => useWorkflow(memberId), { initialProps: { memberId: "member-a" } });
    act(() => hook.result.current.choose("attention"));
    hook.rerender({ memberId: "member-b" });

    act(() => hook.result.current.complete());

    expect(hook.result.current.workflow).toBe(MESSAGE_WORKFLOW_DEFAULT);
    expect(hook.result.current.onboarded).toBe(true);
  });

  it("keeps the default when first-use is skipped with storage unavailable", () => {
    refuseWrites();
    const hook = renderHook(() => useWorkflow("member-a"));

    act(() => { hook.result.current.choose(MESSAGE_WORKFLOW_DEFAULT); hook.result.current.complete(); });

    expect(hook.result.current.workflow).toBe(MESSAGE_WORKFLOW_DEFAULT);
    expect(hook.result.current.onboarded).toBe(true);
  });
});
