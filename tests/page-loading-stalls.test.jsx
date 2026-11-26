import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChapterBudgetPanel } from "../src/components/ChapterBudgetPanel.jsx";
import { InstitutionalRecordsPanel } from "../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { knowledgeFallbackSignature, useAccessibleKnowledgeArticles } from "../src/features/knowledge/useAccessibleKnowledgeArticles.js";
import { createMemberSupportAdapter } from "../src/features/memberSupport/index.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { SHELL_LOAD_DEADLINE_MS } from "../src/lib/loadDeadline.js";
import { MEMBER_REQUEST_CONCURRENCY, createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { OrgStructureView } from "../src/views/OrgStructureView.jsx";

// REQ-UG-PAGE-LOADING-STALLS-20261030 (swarm finding 3): pages sat on
// "Loading Union Ground…" and desk loading lines for 4-10 seconds, and some
// never finished. These pin each source the investigation found.

const sensitive = vi.hoisted(() => ({ rpc: null }));
vi.mock("../src/lib/sensitiveContentApi.js", () => ({
  sensitiveContentRpc: (...args) => sensitive.rpc(...args),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  sensitive.rpc = null;
});

const never = () => new Promise(() => {});
const article = (id, version = 1) => ({
  id, slug: id, title: id, chapterId: "c", status: "published", verifiedBy: "v", verifiedAt: "2026-10-01T00:00:00Z",
  version, updatedAt: `2026-10-0${version}T00:00:00Z`, orderIndex: 0,
});
const withLang = (node) => <LanguageProvider lang="en">{node}</LanguageProvider>;

function knowledgeClient(respond) {
  const calls = [];
  return {
    calls,
    rpc(name, args) {
      const call = { name, args, signal: null };
      calls.push(call);
      return { abortSignal(signal) { call.signal = signal; return respond(call); } };
    },
  };
}

describe("complete chapter knowledge index on /m/search", () => {
  it("keeps one request when a projection rebuilds the same fallback articles", async () => {
    let resolve;
    const client = knowledgeClient(() => new Promise((yes) => { resolve = yes; }));
    const { result, rerender } = renderHook((props) => useAccessibleKnowledgeArticles(props), {
      initialProps: { client, fallbackArticles: [article("a")], publishedOnly: true, scopeKey: "m:o:c" },
    });
    expect(result.current.phase).toBe("loading");
    // Every member-data projection hands over a new array with the same rows.
    for (let pass = 0; pass < 5; pass += 1) {
      rerender({ client, fallbackArticles: [article("a")], publishedOnly: true, scopeKey: "m:o:c" });
    }
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].signal.aborted).toBe(false);
    await act(async () => { resolve({ data: [{ id: "a", slug: "a", title: "Remote", chapter_id: "c", status: "published", verified_by: "v", verified_at: "2026-10-01T00:00:00Z", order_index: 0 }], error: null }); });
    expect(result.current.phase).toBe("ready");
    expect(result.current.articles.map((item) => item.title)).toEqual(["Remote"]);
  });

  it("refetches when the fallback articles really change", async () => {
    const client = knowledgeClient(() => Promise.resolve({ data: [], error: null }));
    const { result, rerender } = renderHook((props) => useAccessibleKnowledgeArticles(props), {
      initialProps: { client, fallbackArticles: [article("a")], scopeKey: "s" },
    });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    rerender({ client, fallbackArticles: [article("a", 2)], scopeKey: "s" });
    await waitFor(() => expect(client.calls).toHaveLength(2));
    expect(knowledgeFallbackSignature([article("a")])).not.toBe(knowledgeFallbackSignature([article("a", 2)]));
    expect(knowledgeFallbackSignature([article("a")])).toBe(knowledgeFallbackSignature([article("a")]));
  });

  it("turns a request that never answers into an error, and Try again asks once more", async () => {
    let answer = never;
    const client = knowledgeClient(() => answer());
    const { result } = renderHook(() => useAccessibleKnowledgeArticles({ client, fallbackArticles: [article("a")], deadlineMs: 30 }));
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(client.calls[0].signal.aborted).toBe(true);
    expect(result.current.articles.map((item) => item.id)).toEqual(["a"]);
    answer = () => Promise.resolve({ data: [], error: null });
    act(() => { result.current.retry(); });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(client.calls).toHaveLength(2);
  });
});

describe("knowledge index edge cases", () => {
  it("signs a missing or partial fallback without throwing", () => {
    expect(knowledgeFallbackSignature(null)).toBe("[]");
    expect(knowledgeFallbackSignature("not a list")).toBe("[]");
    expect(knowledgeFallbackSignature([{ id: "a" }, null])).toBe(JSON.stringify([["a", null, null, null], [null, null, null, null]]));
  });

  it("treats a non-list fallback as no fallback and still loads the snapshot", async () => {
    const client = knowledgeClient(() => Promise.resolve({ data: [], error: null }));
    const { result } = renderHook(() => useAccessibleKnowledgeArticles({ client, fallbackArticles: "nope" }));
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.articles).toEqual([]);
  });

  it("drops a failure that lands after the page moved on", async () => {
    let reject;
    const client = knowledgeClient(() => new Promise((_, no) => { reject = no; }));
    const { result, unmount } = renderHook(() => useAccessibleKnowledgeArticles({ client, fallbackArticles: [] }));
    expect(result.current.phase).toBe("loading");
    unmount();
    await act(async () => { reject(new Error("late")); });
    expect(client.calls[0].signal.aborted).toBe(true);
  });
});

describe("member support desk on /m/support", () => {
  const member = {
    userId: "11111111-1111-4111-8111-111111111111",
    selectedOrganizationId: "22222222-2222-4222-8222-222222222222",
    membershipStatus: "active",
    selectedHat: "member",
  };

  it("ends a snapshot that never answers in the retryable error state", async () => {
    sensitive.rpc = never;
    const adapter = createMemberSupportAdapter({ rpc: vi.fn() }, { loadDeadlineMs: 30 });
    await expect(adapter.load(member)).resolves.toMatchObject({ state: "error" });
  });

  it("defaults to the shell deadline", async () => {
    vi.useFakeTimers();
    sensitive.rpc = never;
    const settled = vi.fn();
    createMemberSupportAdapter({ rpc: vi.fn() }).load(member).then(settled);
    await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ state: "error" }));
  });
});

describe("org structure on /m/org-structure", () => {
  it("shows Try again after a read that never answers and recovers on it", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(never);
    render(withLang(<OrgStructureView loader={loader} />));
    expect(screen.getByText("Loading your organization structure…")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    loader.mockResolvedValueOnce({ organizationId: "o", chapterId: "c", charts: [] });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("records and budgets on /m/organize/record", () => {
  it("reads the minutes notices and meetings together, not one after the other", async () => {
    const started = [];
    const client = {
      rpc: vi.fn((name) => {
        started.push(name);
        if (name === "get_institutional_records_workspace") {
          return Promise.resolve({ data: { canManage: true, canExport: false, contacts: [], roster: [], exportRuns: [], records: [] }, error: null });
        }
        return never();
      }),
    };
    render(withLang(<InstitutionalRecordsPanel client={client} canStaff />));
    await waitFor(() => expect(started).toHaveLength(3));
    expect(started[0]).toBe("get_institutional_records_workspace");
  });

  it("ends a records workspace read that never answers in the error card", async () => {
    vi.useFakeTimers();
    const client = { rpc: vi.fn(never) };
    render(withLang(<InstitutionalRecordsPanel client={client} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS); });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("ends a budget access read that never answers in the error line", async () => {
    vi.useFakeTimers();
    const client = { rpc: vi.fn(never) };
    render(withLang(<ChapterBudgetPanel client={client} scope={{ organizationId: "o", chapterId: "c" }} />));
    expect(screen.getByText("Loading budget access…")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(SHELL_LOAD_DEADLINE_MS); });
    expect(screen.queryByText("Loading budget access…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

describe("route reads behind \"Loading Union Ground…\"", () => {
  function timedClient(latency) {
    let active = 0;
    const stats = { requests: 0, maximumActive: 0 };
    const respond = () => {
      stats.requests += 1;
      active += 1;
      stats.maximumActive = Math.max(stats.maximumActive, active);
      return new Promise((resolve) => setTimeout(() => { active -= 1; resolve({ data: [], error: null }); }, latency));
    };
    const query = new Proxy({}, { get(_target, key) {
      if (key === "then") return (resolve, reject) => respond().then(resolve, reject);
      return () => query;
    } });
    return { stats, client: { from: () => query, rpc: () => ({ abortSignal() { return this; }, then: (resolve, reject) => respond().then(resolve, reject) }) } };
  }

  it("sends eight reads at a time, so the steward route clears in half the round trips", async () => {
    expect(MEMBER_REQUEST_CONCURRENCY).toBe(8);
    vi.useFakeTimers();
    const latency = 300;
    const { client, stats } = timedClient(latency);
    const loader = createMemberSessionLoader(client, { id: "member" }, { loadDeadlineMs: 60_000 });
    let done = false;
    loader.loadRoute("steward").then(() => { done = true; });
    let elapsed = 0;
    while (!done && elapsed < 20_000) {
      await vi.advanceTimersByTimeAsync(latency);
      elapsed += latency;
    }
    loader.dispose();
    expect(done).toBe(true);
    expect(stats.maximumActive).toBe(8);
    // At four at a time the same reads took 15 round trips (4.5 s at 300 ms).
    expect(elapsed / latency).toBeLessThanOrEqual(Math.ceil(stats.requests / 8) + 1);
    expect(elapsed).toBeLessThan(3_000);
  });
});
