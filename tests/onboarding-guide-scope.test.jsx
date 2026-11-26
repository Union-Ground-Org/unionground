import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INACTIVE_GUIDE } from "../src/lib/onboardingGuide.js";
import { useMemberOnboardingGuide } from "../src/lib/useMemberOnboardingGuide.js";

const payload = (id) => ({
  state: "ready", applies: true, progressiveDisclosureActive: true,
  showHud: true, nextStep: { id, title: `Step for ${id}` },
});
function pendingGuide() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve: data => resolve({ data, error: null }) };
}
const scope = { enabled: true, memberId: "member", organizationId: "org-a", chapterId: "chapter-a", refreshKey: "hub" };
beforeEach(() => localStorage.clear());

describe("onboarding guide scope ownership", () => {
  it("hides the old organization on every render and reloads on the unchanged hub view", async () => {
    const replacement = pendingGuide();
    const client = { rpc: vi.fn().mockResolvedValueOnce({ data: payload("step-a"), error: null }).mockReturnValueOnce(replacement.promise) };
    const observed = [];
    const hook = renderHook(props => {
      const value = useMemberOnboardingGuide(props);
      observed.push({ organizationId: props.organizationId, guide: value.guide });
      return value;
    }, { initialProps: { ...scope, client } });
    await act(async () => {});
    expect(hook.result.current.guide.nextStep.id).toBe("step-a");
    act(() => hook.result.current.setShowAll(true));

    hook.rerender({ ...scope, client, organizationId: "org-b" });
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(hook.result.current.guide).toBe(INACTIVE_GUIDE);
    expect(observed.filter(row => row.organizationId === "org-b").every(row => row.guide === INACTIVE_GUIDE)).toBe(true);
    expect(hook.result.current.showAll).toBe(true);
    await act(async () => replacement.resolve(payload("step-b")));
    expect(hook.result.current.guide.nextStep.id).toBe("step-b");
    expect(client.rpc).toHaveBeenLastCalledWith("get_member_onboarding_guide");
  });

  it("also reloads when only the selected chapter changes", async () => {
    const client = { rpc: vi.fn().mockResolvedValueOnce({ data: payload("chapter-a"), error: null }).mockResolvedValueOnce({ data: payload("chapter-b"), error: null }) };
    const hook = renderHook(props => useMemberOnboardingGuide(props), { initialProps: { ...scope, client } });
    await act(async () => {});
    hook.rerender({ ...scope, client, chapterId: "chapter-b" });
    expect(hook.result.current.guide).toBe(INACTIVE_GUIDE);
    await act(async () => {});
    expect(hook.result.current.guide.nextStep.id).toBe("chapter-b");
  });

  it("ignores an old scope response that arrives after the replacement", async () => {
    const previous = pendingGuide();
    const next = pendingGuide();
    const client = { rpc: vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise) };
    const hook = renderHook(props => useMemberOnboardingGuide(props), { initialProps: { ...scope, client } });
    hook.rerender({ ...scope, client, organizationId: "org-b" });
    await act(async () => next.resolve(payload("new")));
    expect(hook.result.current.guide.nextStep.id).toBe("new");
    await act(async () => previous.resolve(payload("old")));
    expect(hook.result.current.guide.nextStep.id).toBe("new");
  });

  it("fails open after the replacement scope read fails", async () => {
    const client = { rpc: vi.fn().mockResolvedValueOnce({ data: payload("old"), error: null }).mockRejectedValueOnce(new Error("offline")) };
    const hook = renderHook(props => useMemberOnboardingGuide(props), { initialProps: { ...scope, client } });
    await act(async () => {});
    hook.rerender({ ...scope, client, organizationId: "org-b" });
    await act(async () => {});
    expect(hook.result.current.guide).toBe(INACTIVE_GUIDE);
    expect(hook.result.current.guide.progressiveDisclosureActive).toBe(false);
  });

  it("keeps the current guide during ordinary same-scope refresh", async () => {
    const refresh = pendingGuide();
    const client = { rpc: vi.fn().mockResolvedValueOnce({ data: payload("first"), error: null }).mockReturnValueOnce(refresh.promise) };
    const hook = renderHook(props => useMemberOnboardingGuide(props), { initialProps: { ...scope, client } });
    await act(async () => {});
    hook.rerender({ ...scope, client, refreshKey: "today" });
    expect(hook.result.current.guide.nextStep.id).toBe("first");
    await act(async () => refresh.resolve(payload("refreshed")));
    expect(hook.result.current.guide.nextStep.id).toBe("refreshed");
  });
});
