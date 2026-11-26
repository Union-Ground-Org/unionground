import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StewardView } from "../src/views/StewardView.jsx";

const baseDesk = {
  queue: [], threads: [], formsInbox: [], broadcasts: [], caseload: [],
  kpis: { openRequests: 0, membersCovered: 12, awaitingReply: 0, broadcasts30d: 0 },
};
const queues = [
  { key: "requests", rows: "queue", api: "loadRequests", toolbar: "Filter worker requests", chip: "Open", params: { status: "open", search: "", sort: "newest" }, defaults: { status: "all", search: "", sort: "newest" } },
  { key: "forms", rows: "formsInbox", api: "loadForms", toolbar: "Filter forms", chip: "Submitted", params: { status: "submitted", search: "", sort: "oldest" }, defaults: { status: "all", search: "", sort: "oldest" } },
  { key: "threads", rows: "threads", api: "loadThreads", toolbar: "Filter conversations", chip: "Awaiting reply", params: { filter: "awaiting", search: "" }, defaults: { filter: "all", search: "" } },
  { key: "broadcasts", rows: "broadcasts", api: "loadBroadcasts", toolbar: "Filter broadcasts", chip: "Active", params: { filter: "active", search: "" }, defaults: { filter: "all", search: "" } },
];
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function row(id) {
  return { id, memberName: id, memberInitials: "TM", title: id, status: "submitted", templateKey: "grievance", answers: {},
    createdAt: "2026-10-06T12:00:00Z", submittedAt: "2026-10-06T12:00:00Z", updatedAt: "2026-10-06T12:00:00Z", publishedAt: "2026-10-06T12:00:00Z", retracted: true };
}
function page(id, total = 1, nextCursor = null) { return { rows: [row(id)], total, nextCursor }; }
async function setup(queue) {
  const failedDesk = { ...baseDesk, [`${queue.key}Unavailable`]: true };
  const api = { loadDesk: vi.fn().mockResolvedValue(failedDesk), [queue.api]: vi.fn() };
  const view = (currentApi) => <StewardView data={{ member: {}, events: [] }} api={currentApi} onNotice={vi.fn()} />;
  const rendered = render(view(api));
  const toolbar = await screen.findByRole("group", { name: queue.toolbar });
  const panel = toolbar.closest("section");
  expect(within(panel).getByRole("alert")).toHaveTextContent("This list could not be loaded.");
  expect(panel.querySelector(".cwk-count")).toBeNull();
  return { api, toolbar, panel, failedDesk, view, ...rendered };
}

describe.each(queues)("$key queue recovery", (queue) => {
  it("shows a successful filtered page and preserves its pagination after the initial queue failed", async () => {
    const { api, toolbar, panel } = await setup(queue);
    const first = deferred();
    const more = deferred();
    const cursor = { id: "next-page" };
    api[queue.api].mockReturnValueOnce(first.promise).mockReturnValueOnce(more.promise);
    fireEvent.click(within(toolbar).getByRole("button", { name: queue.chip }));
    expect(api[queue.api]).toHaveBeenLastCalledWith({ ...queue.params, cursor: null });
    await act(async () => first.resolve(page("Filtered member", 2, cursor)));
    expect(within(panel).getByText("Filtered member")).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(within(panel).getByText("Showing 1 of 2")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Load more" }));
    expect(api[queue.api]).toHaveBeenLastCalledWith({ ...queue.params, cursor });
    await act(async () => more.resolve(page("Next member", 2)));
    expect(within(panel).getByText("Filtered member")).toBeInTheDocument();
    expect(within(panel).getByText("Next member")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Load more" })).toBeNull();
    expect(api.loadDesk).toHaveBeenCalledTimes(1);
  });

  it("retries the failed queue itself, keeps a refused page unavailable, and recovers on a later retry", async () => {
    const { api, panel } = await setup(queue);
    const denied = deferred();
    const recovered = deferred();
    api[queue.api].mockReturnValueOnce(denied.promise).mockReturnValueOnce(recovered.promise);
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(api[queue.api]).toHaveBeenCalledTimes(1);
    await act(async () => denied.reject(Object.assign(new Error("denied"), { code: "42501" })));
    expect(within(panel).getByRole("alert")).toHaveTextContent("This list could not be loaded.");
    expect(panel.querySelector(".cwk-count")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    await act(async () => recovered.resolve(page("Recovered member")));
    expect(within(panel).getByText("Recovered member")).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(api.loadDesk).toHaveBeenCalledTimes(1);
  });

  // A queue that recovered through a filter must not
  // fall back onto the failed desk seed when its controls return to defaults.
  it("fetches the default view instead of re-showing the failed seed after a filtered recovery", async () => {
    const { api, toolbar, panel } = await setup(queue);
    const filtered = deferred();
    const defaults = deferred();
    api[queue.api].mockReturnValueOnce(filtered.promise).mockReturnValueOnce(defaults.promise);
    fireEvent.click(within(toolbar).getByRole("button", { name: queue.chip }));
    await act(async () => filtered.resolve(page("Filtered member")));
    fireEvent.click(within(toolbar).getByRole("button", { name: "All" }));
    expect(api[queue.api]).toHaveBeenCalledTimes(2);
    expect(api[queue.api]).toHaveBeenLastCalledWith({ ...queue.defaults, cursor: null });
    await act(async () => defaults.resolve(page("Default member")));
    expect(within(panel).getByText("Default member")).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(api.loadDesk).toHaveBeenCalledTimes(1);
  });

  // A later full-desk reload that soft-fails this
  // section again must not blank rows the queue already recovered.
  it("refetches instead of blanking a recovered queue when a later desk reload fails that section again", async () => {
    const { api, toolbar, panel, rerender, view, failedDesk } = await setup(queue);
    const filtered = deferred();
    const defaults = deferred();
    const again = deferred();
    api[queue.api].mockReturnValueOnce(filtered.promise).mockReturnValueOnce(defaults.promise).mockReturnValueOnce(again.promise);
    fireEvent.click(within(toolbar).getByRole("button", { name: queue.chip }));
    await act(async () => filtered.resolve(page("Filtered member")));
    fireEvent.click(within(toolbar).getByRole("button", { name: "All" }));
    await act(async () => defaults.resolve(page("Default member")));
    const nextDesk = deferred();
    rerender(view({ ...api, loadDesk: vi.fn(() => nextDesk.promise) }));
    await act(async () => nextDesk.resolve({ ...failedDesk }));
    expect(api[queue.api]).toHaveBeenCalledTimes(3);
    expect(api[queue.api]).toHaveBeenLastCalledWith({ ...queue.defaults, cursor: null });
    await act(async () => again.resolve(page("Reloaded member")));
    expect(within(panel).getByText("Reloaded member")).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("hides the count while a recovering queue has nothing to count yet", async () => {
    const { api, panel } = await setup(queue);
    const pending = deferred();
    api[queue.api].mockReturnValueOnce(pending.promise);
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(panel.querySelector(".cwk-count")).toBeNull();
    await act(async () => pending.resolve(page("Recovered member", 3)));
    expect(panel.querySelector(".cwk-count")).toHaveTextContent("3");
  });

  it("adopts a later healthy full desk update while the queue is still on its defaults", async () => {
    const { api, rerender, view, panel } = await setup(queue);
    const next = deferred();
    rerender(view({ ...api, loadDesk: vi.fn(() => next.promise) }));
    await act(async () => next.resolve({ ...baseDesk, [queue.rows]: [row("Fresh desk member")] }));
    expect(within(panel).getByText("Fresh desk member")).toBeInTheDocument();
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(api[queue.api]).not.toHaveBeenCalled();
  });

  it("does not overwrite a newer filter with a late full desk or an older filtered page", async () => {
    const { api, rerender, view, panel, toolbar, failedDesk } = await setup(queue);
    const oldPage = deferred();
    const nextDesk = deferred();
    const freshPage = deferred();
    api[queue.api].mockReturnValueOnce(oldPage.promise).mockReturnValueOnce(freshPage.promise);
    fireEvent.click(within(toolbar).getByRole("button", { name: queue.chip }));
    rerender(view({ ...api, loadDesk: vi.fn(() => nextDesk.promise) }));
    // The full desk was fetched with default params; it cannot replace a
    // filtered page, even if that old/default queue failed again.
    await act(async () => nextDesk.resolve({ ...failedDesk }));
    expect(api[queue.api]).toHaveBeenCalledTimes(2);
    expect(api[queue.api]).toHaveBeenLastCalledWith({ ...queue.params, cursor: null });
    await act(async () => freshPage.resolve(page("Newest filtered member")));
    await act(async () => oldPage.resolve(page("Stale filtered member")));
    expect(within(panel).getByText("Newest filtered member")).toBeInTheDocument();
    expect(within(panel).queryByText("Stale filtered member")).toBeNull();
    expect(within(panel).queryByRole("alert")).toBeNull();
  });
});
