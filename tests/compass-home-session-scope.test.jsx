import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCompassHomeContent } from "../src/features/compass/useCompassHomeContent.js";

// React silently ignores writes after unmount. Observe the real hook's setter
// calls before forwarding them to React so cleanup regressions remain visible.
const stateWrites = vi.hoisted(() => ({ observer: null }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useState(initialValue) {
      const [value, setValue] = actual.useState(initialValue);
      const observedSetValue = actual.useCallback((nextValue) => {
        stateWrites.observer?.(nextValue);
        setValue(nextValue);
      }, [setValue]);
      return [value, observedSetValue];
    },
  };
});
afterEach(() => { stateWrites.observer = null; });

const answer = { id: "answer-a", answer: "Private saved answer" };
const counts = { enabled: true, staff: [{ id: "overdue-cases", count: 2, urgent: false }], member: [] };
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const context = (client, scopeKey = "session-a", offersOn = true, nudgesOn = true) => ({ client, scopeKey, offersOn, nudgesOn });
function pendingContent() {
  const pins = deferred(), nudges = deferred();
  const client = { rpc: vi.fn(name => {
    if (name === "list_compass_pinned_answers") return pins.promise;
    if (name === "get_compass_nudges") return nudges.promise;
    throw new Error(`Unexpected RPC: ${name}`);
  }) };
  return { pins, nudges, client };
}
async function settle(request, outcome, data) {
  await act(async () => {
    if (outcome === "success") request.resolve({ data, error: null });
    else request.reject(new Error("unavailable"));
  });
}
describe("Compass Home authenticated session scope", () => {
  it("loads pins and nudges only after a full member context is available", async () => {
    const client = { rpc: vi.fn(name => Promise.resolve({ data: name === "list_compass_pinned_answers" ? [answer] : counts, error: null })) };
    const { result, rerender } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client, null) });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(result.current.pins).toEqual([]);
    rerender(context(client));
    await waitFor(() => expect(result.current.pins[0]?.answer).toBe(answer.answer));
    expect(result.current.nudges.staff).toEqual(counts.staff);
  });
  it("hides already loaded content immediately on restricted-session entry and while member boot is pending", async () => {
    const client = { rpc: vi.fn(name => Promise.resolve({ data: name === "list_compass_pinned_answers" ? [answer] : counts, error: null })) };
    const { result, rerender } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client) });
    await waitFor(() => expect(result.current.pins).toHaveLength(1));
    rerender(context(client, null));
    expect(result.current.pins).toEqual([]);
    expect(result.current.nudges).toEqual({ staff: [], member: [] });
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });
  it("discards both late responses from a former account", async () => {
    const oldPins = deferred(), oldNudges = deferred();
    const client = { rpc: vi.fn().mockReturnValueOnce(oldPins.promise).mockReturnValueOnce(oldNudges.promise).mockResolvedValueOnce({ data: [], error: null }).mockResolvedValueOnce({ data: { enabled:true,staff:[],member:[] }, error:null }) };
    const { result, rerender } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client) });
    rerender(context(client, "session-b"));
    await act(async () => { oldPins.resolve({ data:[answer],error:null }); oldNudges.resolve({ data:counts,error:null }); });
    expect(result.current.pins).toEqual([]);
    expect(result.current.nudges).toEqual({ staff: [], member: [] });
  });
  it("discards an in-flight answer when a restricted session begins", async () => {
    const pending = deferred();
    const client = { rpc: vi.fn().mockReturnValue(pending.promise) };
    const { result, rerender } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client, "session-a", true, false) });
    rerender(context(client, null, false, false));
    await act(async () => { pending.resolve({ data:[answer],error:null }); });
    expect(result.current.pins).toEqual([]);
  });
  it("keeps switched-off content hidden and never loads it", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: [answer], error: null }) };
    const { result, rerender } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client, "session-a", false, false) });
    expect(client.rpc).not.toHaveBeenCalled();
    rerender(context(client, "session-a", true, false));
    await waitFor(() => expect(result.current.pins).toHaveLength(1));
    rerender(context(client, "session-a", false, false));
    expect(result.current.pins).toEqual([]);
    expect(result.current.nudges).toEqual({ staff: [], member: [] });
  });
  it("reports pins unavailable without changing the nudges fallback", async () => {
    const client = { rpc: vi.fn().mockRejectedValue(new Error("unavailable")) };
    const { result } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client) });
    await act(async () => { await result.current.refreshPins(); });
    expect(result.current.pinsFailed).toBe(true);
    expect(result.current.pins).toEqual([]);
    expect(result.current.nudges).toEqual({ staff: [], member: [] });
  });
  it("keeps a newer pin refresh when an older request completes last", async () => {
    const first = deferred();
    const client = { rpc: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce({ data: [{ id:"new",answer:"Current answer" }], error:null }) };
    const { result } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client, "session-a", true, false) });
    await act(async () => { await result.current.refreshPins(); });
    await act(async () => { first.resolve({ data:[answer],error:null }); });
    expect(result.current.pins.map(pin=>pin.answer)).toEqual(["Current answer"]);
  });
  it.each(["success", "rejection"])("observes pin and nudge state writes on mounted %s", async (outcome) => {
    const { pins, nudges, client } = pendingContent();
    const writes = vi.fn();
    stateWrites.observer = writes;
    const { result } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client) });
    expect(client.rpc.mock.calls).toEqual([["list_compass_pinned_answers"], ["get_compass_nudges"]]);
    expect(writes).not.toHaveBeenCalled();

    await settle(pins, outcome, [answer]);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenLastCalledWith({ scopeKey: "session-a", pins: result.current.pins, failed: outcome === "rejection" });
    expect(result.current.pins).toHaveLength(outcome === "success" ? 1 : 0);

    await settle(nudges, outcome, counts);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(writes).toHaveBeenLastCalledWith({ scopeKey: "session-a", nudges: result.current.nudges });
    expect(result.current.nudges.staff).toEqual(outcome === "success" ? counts.staff : []);
  });
  it.each(["success", "rejection"])("discards late pin and nudge %s without attempting state writes after unmount", async (outcome) => {
    const { pins, nudges, client } = pendingContent();
    const writes = vi.fn();
    stateWrites.observer = writes;
    const { unmount } = renderHook(props => useCompassHomeContent(props), { initialProps: context(client) });
    expect(client.rpc.mock.calls).toEqual([["list_compass_pinned_answers"], ["get_compass_nudges"]]);
    expect(writes).not.toHaveBeenCalled();
    unmount();

    await settle(pins, outcome, [answer]);
    expect(writes, "late pin response must not call a state setter").not.toHaveBeenCalled();
    await settle(nudges, outcome, counts);
    expect(writes, "late nudge response must not call a state setter").not.toHaveBeenCalled();
  });
});
