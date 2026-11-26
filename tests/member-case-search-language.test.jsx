// BUG-UG-CASE-SEARCH-DEADLINE-LANGUAGE-20261020: loaded case-search
// deadline labels follow a language switch without a second search.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemberCaseSearch } from "../src/features/cases/useMemberCaseSearch.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const ROW = { case_id: "case-1", reference: "GR-1", title: "Overtime", headline: "<b>overtime</b> pay", case_type: "grievance", step: "Step 1", deadline: "2026-11-03", rank: 0.5 };

function client(rows = [ROW]) {
  const rpc = vi.fn(() => ({
    abortSignal() { return this; },
    then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
  }));
  return { rpc };
}

const label = (lang) => (value) => `${lang}:${value}`;

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
}

describe("useMemberCaseSearch deadline labels", () => {
  it("relabels loaded deadlines when only the language changes, with one search", async () => {
    vi.useFakeTimers();
    const supabase = client();
    const hook = renderHook(({ lang }) => useMemberCaseSearch({
      client: supabase, query: "overtime", formatDeadline: (value) => label(lang)(value),
    }), { initialProps: { lang: "en" } });
    await settle();
    expect(hook.result.current.phase).toBe("ready");
    expect(hook.result.current.entries.map((entry) => entry.meta)).toEqual(["en:2026-11-03"]);

    hook.rerender({ lang: "es" });
    await settle();
    expect(hook.result.current.entries.map((entry) => entry.meta)).toEqual(["es:2026-11-03"]);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("does not search again or loop when the formatter is a new function on every render", async () => {
    vi.useFakeTimers();
    const supabase = client();
    const hook = renderHook(() => useMemberCaseSearch({
      client: supabase, query: "overtime", formatDeadline: (value) => `x:${value}`,
    }));
    await settle();
    for (let index = 0; index < 5; index += 1) hook.rerender();
    await settle();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(hook.result.current.entries).toHaveLength(1);
  });

  it("still fences a stale query, keeps the debounce, and reports a failure with no rows", async () => {
    vi.useFakeTimers();
    const supabase = client();
    const hook = renderHook(({ query }) => useMemberCaseSearch({ client: supabase, query, formatDeadline: label("en") }),
      { initialProps: { query: "over" } });
    hook.rerender({ query: "overtime" });
    expect(hook.result.current.phase).toBe("loading");
    expect(hook.result.current.entries).toEqual([]);
    await settle();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc.mock.calls[0][1]).toMatchObject({ p_query: "overtime" });

    const failing = { rpc: vi.fn(() => ({ abortSignal() { return this; }, then(resolve) { return Promise.resolve({ data: null, error: { message: "down" } }).then(resolve); } })) };
    const broken = renderHook(() => useMemberCaseSearch({ client: failing, query: "pay", formatDeadline: label("en") }));
    await settle();
    expect(broken.result.current.phase).toBe("error");
    expect(broken.result.current.entries).toEqual([]);
  });
  it("stays idle without a query or client, and falls back to the raw deadline without a formatter", async () => {
    vi.useFakeTimers();
    const supabase = client();
    const idle = renderHook(() => useMemberCaseSearch({ client: supabase, query: null }));
    await settle();
    expect(idle.result.current).toMatchObject({ phase: "idle", entries: [] });
    expect(supabase.rpc).not.toHaveBeenCalled();

    const plain = renderHook(() => useMemberCaseSearch({ client: supabase, query: "overtime" }));
    await settle();
    expect(plain.result.current.entries.map((entry) => entry.meta)).toEqual(["2026-11-03"]);
  });

  it("drops an answer or a failure that lands after the search was superseded or abandoned", async () => {
    vi.useFakeTimers();
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    const lateOk = { rpc: vi.fn(() => ({ abortSignal() { return this; }, then(resolve, reject) { return slow.then(() => ({ data: [ROW], error: null })).then(resolve, reject); } })) };
    const hook = renderHook(({ query }) => useMemberCaseSearch({ client: lateOk, query, formatDeadline: label("en") }), { initialProps: { query: "overtime" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    hook.unmount();
    await act(async () => { release(); await slow; });

    let fail;
    const slowFail = new Promise((resolve) => { fail = resolve; });
    const lateError = { rpc: vi.fn(() => ({ abortSignal() { return this; }, then(resolve, reject) { return slowFail.then(() => ({ data: null, error: { message: "down" } })).then(resolve, reject); } })) };
    const abandoned = renderHook(() => useMemberCaseSearch({ client: lateError, query: "pay", formatDeadline: label("en") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    abandoned.unmount();
    await act(async () => { fail(); await slowFail; });
    expect(lateOk.rpc).toHaveBeenCalledTimes(1);
    expect(lateError.rpc).toHaveBeenCalledTimes(1);
  });
});
