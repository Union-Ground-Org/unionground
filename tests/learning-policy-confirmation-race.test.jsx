import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { afterEach, expect, it, vi } from "vitest";
import { LearningLearnArea } from "../src/features/learningContent/LearningLearnArea.jsx";
import { useLearningPolicy } from "../src/features/learningContent/hooks.js";
import { learningContentCopy } from "../src/lib/i18n/learningContent.js";

afterEach(cleanup);
const tr = learningContentCopy("en");
const scope = { organizationId: "org", chapterId: "chapter" };
const initial = {
  ...scope, quotesEnabled: true, lessonsEnabled: true, homeHidden: true,
  canManage: false, isPlatformOwner: false, version: "before-restore",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it.each(["success", "failure"])("keeps Learn's confirmed restore when an older policy read returns %s", async (outcome) => {
  const oldRead = deferred();
  let policyReads = 0;
  const client = { rpc: vi.fn((name) => {
    if (name === "get_learning_policy") {
      return ++policyReads === 1 ? Promise.resolve({ data: initial, error: null }) : oldRead.promise;
    }
    if (name === "set_learning_home_hidden") return Promise.resolve({ data: { homeHidden: false }, error: null });
    if (name === "list_learning_content") return Promise.resolve({ data: { items: [], hasMore: false }, error: null });
    throw new Error(`Unexpected RPC ${name}`);
  }) };
  render(<LearningLearnArea client={client} session={{ user: { id: "member" } }} organizationId="org" chapterId="chapter" locale="en" />);
  await screen.findByRole("button", { name: tr("library.showOnHome") });
  act(() => window.dispatchEvent(new Event("focus")));
  expect(policyReads).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: tr("library.showOnHome") }));
  await screen.findByText(tr("library.restored"));
  await act(async () => {
    oldRead.resolve(outcome === "success"
      ? { data: initial, error: null }
      : { data: null, error: { code: "XX000", message: "Pre-save read failed" } });
    await oldRead.promise;
  });
  expect(screen.queryByText(tr("library.restored"))).not.toBeNull();
  expect(screen.queryByRole("button", { name: tr("library.showOnHome") })).toBeNull();
  expect(screen.queryByText(tr("library.error"))).toBeNull();
});

it("starts a fresh read after confirmation and keeps it over the retired response", async () => {
  const oldRead = deferred();
  const freshRead = deferred();
  const api = { getPolicy: vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise) };
  const { result } = renderHook(() => useLearningPolicy(api, scope, { poll: false }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let oldRun;
  act(() => { oldRun = result.current.refresh(); });
  act(() => result.current.confirm({ homeHidden: false }));
  let freshRun;
  let joined;
  act(() => {
    freshRun = result.current.refresh();
    joined = result.current.refresh();
  });
  expect(api.getPolicy).toHaveBeenCalledTimes(3);
  expect(freshRun).not.toBe(oldRun);
  expect(joined).toBe(freshRun);
  const fresh = { ...initial, homeHidden: false, quotesEnabled: false, version: "after-restore" };
  await act(async () => { freshRead.resolve(fresh); await freshRun; });
  await act(async () => { oldRead.resolve(initial); await oldRun; });
  expect(result.current.policy).toEqual(fresh);
  expect(result.current.status).toBe("ready");
});

it("deduplicates ordinary concurrent refreshes and applies their answer", async () => {
  const pending = deferred();
  const api = { getPolicy: vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise) };
  const { result } = renderHook(() => useLearningPolicy(api, scope, { poll: false }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let first;
  let second;
  act(() => { first = result.current.refresh(); second = result.current.refresh(); });
  expect(first).toBe(second);
  expect(api.getPolicy).toHaveBeenCalledTimes(2);
  const refreshed = { ...initial, homeHidden: false, version: "fresh" };
  await act(async () => { pending.resolve(refreshed); await first; });
  expect(result.current.policy).toEqual(refreshed);
  expect(result.current.refreshCount).toBe(2);
});

it("still clears policy when a read issued after confirmation fails", async () => {
  const failure = new Error("Current policy unavailable");
  const api = { getPolicy: vi.fn().mockResolvedValueOnce(initial).mockRejectedValueOnce(failure) };
  const { result } = renderHook(() => useLearningPolicy(api, scope, { poll: false }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  act(() => result.current.confirm({ homeHidden: false }));
  await act(async () => result.current.refresh());
  expect(result.current.status).toBe("error");
  expect(result.current.policy).toBeNull();
  expect(result.current.error).toBe(failure);
});

// Show on home keeps focus under pending and restores
// once from one tick.
it("restores Learn on home once when Show on home is activated twice in one tick, keeping it focused", async () => {
  const restore = vi.fn(async () => ({ data: { homeHidden: false }, error: null }));
  const client = { rpc: vi.fn((name, args) => {
    if (name === "get_learning_policy") return Promise.resolve({ data: initial, error: null });
    if (name === "set_learning_home_hidden") return restore(args);
    if (name === "list_learning_content") return Promise.resolve({ data: { items: [], hasMore: false }, error: null });
    throw new Error(`Unexpected RPC ${name}`);
  }) };
  render(<LearningLearnArea client={client} session={{ user: { id: "member" } }} organizationId="org" chapterId="chapter" locale="en" />);
  const show = await screen.findByRole("button", { name: tr("library.showOnHome") });
  await expectOneWriteFromOneTick(restore, [() => fireEvent.click(show), () => fireEvent.click(show)]);
  cleanup();
  render(<LearningLearnArea client={client} session={{ user: { id: "member" } }} organizationId="org" chapterId="chapter" locale="en" />);
  await expectHeldWriteFocus(restore, await screen.findByRole("button", { name: tr("library.showOnHome") }));
});
