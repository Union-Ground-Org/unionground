import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStewardDesk } from "../src/lib/memberApi.js";
import { StewardView } from "../src/views/StewardView.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";

afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

const summary = { queue: [], threads: [], broadcasts: [], formsInbox: [], caseload: [],
  kpis: { openRequests: 7, membersCovered: 38, awaitingReply: 2, broadcasts30d: 3 } };

function tableResult(result) {
  const chain = new Proxy({}, { get: (_, key) => key === "then"
    ? (...args) => Promise.resolve(result).then(...args) : () => chain });
  return chain;
}

describe("Committee worker initial overview reads", () => {
  it("finishes the overview without starting hidden desk queues or an unnecessary fallback count", async () => {
    const rpc = vi.fn((name) => Promise.resolve({ data: name === "get_steward_desk_kpis"
      ? [{ open_requests: 7, awaiting_reply: 2, broadcasts_30d: 3 }]
      : name === "get_steward_chapter_member_count" ? 38 : [], error: null }));
    const from = vi.fn(() => tableResult({ data: [], error: null }));
    const desk = await loadStewardDesk({ rpc, from }, { overviewOnly: true });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["get_steward_desk_kpis", "get_steward_chapter_member_count"]);
    expect(from).not.toHaveBeenCalled();
    expect(desk.kpis).toEqual(summary.kpis);
  });

  it("loads a fallback count only after the campaign count fails and keeps unavailable KPIs honest", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "57014" } });
    const select = vi.fn(() => tableResult({ data: [], count: 19, error: null }));
    const from = vi.fn(() => ({ select }));
    const desk = await loadStewardDesk({ rpc, from }, { overviewOnly: true });
    expect(desk.kpis).toEqual({ openRequests: null, membersCovered: 19, membersCoveredIsEstimate: true, awaitingReply: null, broadcasts30d: null, unavailable: true });
    expect(from).toHaveBeenCalledExactlyOnceWith("member_profiles");
    expect(select).toHaveBeenCalledExactlyOnceWith("id", { count: "estimated", head: true });
  });


  it("clears a failed legacy fallback when refreshed rows carry their own scoped counts", async () => {
    const initial = { ...summary, broadcasts: [{ id: "b1", title: "Campaign notice", body: "Read the notice.",
      publishedAt: "2026-11-01T12:00:00Z", retracted: false, readCount: null }] };
    const fallback = vi.fn().mockRejectedValue(new Error("temporarily unavailable"));
    const api = { loadDesk: vi.fn().mockResolvedValue(initial), getBroadcastReadCounts: fallback };
    const tree = (reader) => <StewardView data={{ member: {}, events: [] }} api={reader} onNotice={vi.fn()} />;
    const view = render(tree(api));
    await screen.findByText("Read counts for the newest broadcasts could not be loaded.");
    expect(fallback).toHaveBeenCalledTimes(1);
    view.rerender(tree({ ...api, loadDesk: vi.fn().mockResolvedValue({ ...initial,
      broadcasts: [{ ...initial.broadcasts[0], readCount: 4 }] }) }));
    await screen.findByText("Read by 4 workers", { exact: false });
    // Row adoption commits before the passive effect clears the old fallback error.
    await waitFor(() => expect(screen.queryByText("Read counts for the newest broadcasts could not be loaded.")).toBeNull());
  });


  it.each(["case", "thread"])("keeps the complete reader for a direct %s link to the overview", async (target) => {
    const path = `/m/steward?${target}=record-a`;
    window.history.replaceState({}, "", path);
    const loadDesk = vi.fn().mockResolvedValue(summary);
    render(<WorkspacePages view="steward" hat="steward" location={path} navigate={vi.fn()}>
      <StewardView data={{ member: {}, events: [] }} api={{ loadDesk }} onNotice={vi.fn()} />
    </WorkspacePages>);
    await screen.findByText("7 open requests · 38 worker profiles you can see");
    expect(loadDesk).toHaveBeenCalledExactlyOnceWith({ overviewOnly: false });
  });
});
