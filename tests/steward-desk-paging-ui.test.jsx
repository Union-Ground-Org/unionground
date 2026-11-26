// Steward desk paging UI (UB-DESK-01): the four desk queues render their
// seeded first page, then hand control to usePagedQueue — server-side search
// (debounced), filter chips, sort toggle, a keyset "Load more", and the
// honest "showing N of M" line whenever the screen holds less than the true
// filtered total. The thread dialog owns its own message history through the
// thread-message pager. Old api doubles without the pager methods must keep
// rendering the seeded rows (the hook adopts the seed with a null fetcher).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StewardView } from "../src/views/StewardView.jsx";
import { QueuePager } from "../src/components/QueuePager.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { afterRenderingUpdate, enableFocusFixup } from "./helpers/focusFixup.js";

const baseDesk = {
  caseload: [],
  caseloadUnavailable: false,
  caseloadTruncated: false,
  caseUpdatesUnavailable: false,
  queue: [],
  queueCursor: null,
  queueTotal: 0,
  threads: [],
  threadsCursor: null,
  threadsTotal: 0,
  broadcasts: [],
  broadcastsCursor: null,
  broadcastsTotal: 0,
  formsInbox: [],
  formsCursor: null,
  formsTotal: 0,
  formTemplateVersions: [],
  kpis: { openRequests: 0, membersCovered: 12, awaitingReply: 0, broadcasts30d: 0 },
};

const queueRows = [
  { id: "r1", memberName: "Ada Union", memberInitials: "AU", lessonLabel: "Weingarten rights", status: "requested", createdAt: "2026-08-07T10:00:00Z" },
  { id: "r2", memberName: "Renata Cole", memberInitials: "RC", lessonLabel: "", status: "acknowledged", createdAt: "2026-08-06T10:00:00Z" },
];

const emptyPage = { rows: [], nextCursor: null, total: 0 };

function makeApi(desk) {
  return {
    loadDesk: vi.fn().mockResolvedValue(desk),
    triage: vi.fn(), reply: vi.fn(), publish: vi.fn(), retract: vi.fn(),
    startFormReview: vi.fn(), approveForm: vi.fn(), returnForm: vi.fn(),
    approveAndOpenCase: vi.fn(), scan: vi.fn(),
    loadRequests: vi.fn().mockResolvedValue(emptyPage),
    loadThreads: vi.fn().mockResolvedValue(emptyPage),
    loadForms: vi.fn().mockResolvedValue(emptyPage),
    loadBroadcasts: vi.fn().mockResolvedValue(emptyPage),
    loadThreadMessages: vi.fn().mockResolvedValue({ messages: [], earlierCursor: null, total: 0 }),
  };
}

function renderDesk(desk, api = makeApi(desk)) {
  const utils = render(<StewardView data={{ member: { initials: "SO" }, events: [] }} api={api} onNotice={() => {}} />);
  return { api, ...utils };
}

const requestsSection = () => document.getElementById("steward-requests");

describe("steward desk paged queues", () => {
  it("renders the effect-seeded pager, appends the next keyset page, and guards the double click", async () => {
    const desk = { ...baseDesk, queue: queueRows, queueCursor: { createdAt: "2026-08-06T10:00:00Z", id: "r2" }, queueTotal: 5 };
    const api = makeApi(desk);
    let resolveMore;
    api.loadRequests = vi.fn(() => new Promise((resolve) => { resolveMore = resolve; }));
    renderDesk(desk, api);
    // The cursor lands one commit after the desk (usePagedQueue adopts the
    // seed in an effect), so the button must be awaited, not queried
    // synchronously — the coordinator-view effect-seeded cursor pattern.
    const more = await screen.findByRole("button", { name: "Load more" });
    expect(screen.getByText("Showing 2 of 5")).toBeInTheDocument();
    expect(requestsSection()).toHaveAttribute("data-load-state", "ready");
    expect(requestsSection()).not.toHaveAttribute("aria-busy");
    fireEvent.click(more);
    expect(api.loadRequests).toHaveBeenCalledWith({ status: "all", search: "", sort: "newest", cursor: { createdAt: "2026-08-06T10:00:00Z", id: "r2" } });
    // While the page is in flight the button is pending (focusable, announced
    // unavailable) — a second click is a no-op, not a second request.
    const pending = screen.getByRole("button", { name: "Loading…" });
    expect(pending).toBeEnabled();
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(requestsSection()).toHaveAttribute("data-load-state", "loading");
    expect(requestsSection()).not.toHaveAttribute("aria-busy");
    fireEvent.click(pending);
    expect(api.loadRequests).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveMore({ rows: [{ id: "r3", memberName: "Casey Third", memberInitials: "CT", lessonLabel: "", status: "requested", createdAt: "2026-08-05T10:00:00Z" }], nextCursor: null, total: 5 });
    });
    // The page APPENDS — the seeded rows stay on screen with the new one.
    expect(await screen.findByText("Casey Third")).toBeInTheDocument();
    expect(requestsSection()).toHaveAttribute("data-load-state", "ready");
    expect(requestsSection()).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("Ada Union")).toBeInTheDocument();
    // The cursor is spent.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("debounces the search box into a server refetch with cursor reset", async () => {
    const desk = { ...baseDesk, queue: queueRows, queueTotal: 2 };
    const { api } = renderDesk(desk);
    await screen.findByText("Ada Union");
    // Several queues share the same search placeholder — scope to the
    // requests panel.
    const box = within(requestsSection()).getByRole("searchbox", { name: "Search by worker name…" });
    fireEvent.change(box, { target: { value: "jordan" } });
    // Not immediate: the 250ms debounce has to elapse first.
    expect(api.loadRequests).not.toHaveBeenCalled();
    await waitFor(() => expect(api.loadRequests).toHaveBeenCalledWith({ status: "all", search: "jordan", sort: "newest", cursor: null }));
  });

  it("refetches on a filter chip, replaces the rows, and shows the filtered empty state", async () => {
    const desk = { ...baseDesk, queue: queueRows, queueTotal: 2 };
    const { api } = renderDesk(desk);
    await screen.findByText("Ada Union");
    const toolbar = screen.getByRole("group", { name: "Filter worker requests" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(api.loadRequests).toHaveBeenCalledWith({ status: "open", search: "", sort: "newest", cursor: null }));
    // Rows are REPLACED by the (empty) response, and the empty state is the
    // no-matches copy — never the requestsEmpty onboarding line, which would
    // claim a quiet chapter instead of a filtered miss.
    expect(await screen.findByText("No matches for this search or filter.")).toBeInTheDocument();
    expect(screen.queryByText("Ada Union")).toBeNull();
    expect(screen.queryByText(/No worker requests yet/)).toBeNull();
  });

  it("toggles the sort and refetches oldest-first", async () => {
    const desk = { ...baseDesk, queue: queueRows, queueTotal: 2 };
    const { api } = renderDesk(desk);
    await screen.findByText("Ada Union");
    // The forms toolbar also carries a sort toggle (defaulting to oldest) —
    // scope to the requests panel.
    fireEvent.click(within(requestsSection()).getByRole("button", { name: "Newest first" }));
    expect(within(requestsSection()).getByRole("button", { name: "Oldest first" })).toBeInTheDocument();
    await waitFor(() => expect(api.loadRequests).toHaveBeenCalledWith({ status: "all", search: "", sort: "oldest", cursor: null }));
  });

  it("loads the thread dialog's newest window through the pager and prepends earlier pages", async () => {
    const desk = {
      ...baseDesk,
      // The paged thread row carries NO messages field — the dialog owns its
      // history now.
      threads: [{ id: "t1", memberName: "Devon Pratt", memberInitials: "DP", preview: "Latest note", updatedAt: "2026-08-05T12:00:00Z", awaitingReply: true }],
      threadsTotal: 1,
    };
    const newestPage = {
      messages: [
        { id: "m8", sender_kind: "member", sender_name: "Devon Pratt", body: "message eight", created_at: "2026-08-05T10:00:00Z" },
        { id: "m9", sender_kind: "steward", sender_name: "Sam Ortiz", body: "message nine", created_at: "2026-08-05T11:00:00Z" },
        { id: "m10", sender_kind: "member", sender_name: "Devon Pratt", body: "message ten", created_at: "2026-08-05T12:00:00Z" },
      ],
      earlierCursor: { createdAt: "2026-08-05T10:00:00Z", id: "m8" },
      total: 10,
    };
    const earlierPage = {
      messages: [
        { id: "m6", sender_kind: "member", sender_name: "Devon Pratt", body: "message six", created_at: "2026-08-05T08:00:00Z" },
        { id: "m7", sender_kind: "steward", sender_name: "Sam Ortiz", body: "message seven", created_at: "2026-08-05T09:00:00Z" },
      ],
      earlierCursor: null,
      total: 10,
    };
    const api = makeApi(desk);
    api.loadThreadMessages = vi.fn((id, opts) => Promise.resolve(opts?.cursor ? earlierPage : newestPage));
    renderDesk(desk, api);
    fireEvent.click(await screen.findByRole("button", { name: /Devon Pratt/ }));
    const dialogEl = await screen.findByRole("dialog");
    const dialog = within(dialogEl);
    expect(api.loadThreadMessages).toHaveBeenCalledWith("t1");
    expect(await dialog.findByText("message ten")).toBeInTheDocument();
    expect(dialog.getByText("message eight")).toBeInTheDocument();
    // A window is always disclosed as one, with the thread's TRUE size.
    expect(dialog.getByText("Showing the latest 3 of 10 messages.")).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Load earlier messages" }));
    expect(api.loadThreadMessages).toHaveBeenLastCalledWith("t1", { cursor: { createdAt: "2026-08-05T10:00:00Z", id: "m8" } });
    expect(await dialog.findByText("message six")).toBeInTheDocument();
    // Earlier messages PREPEND — the rendered order stays chronological.
    const bodies = [...dialogEl.querySelectorAll(".thread-message p")].map((node) => node.textContent);
    expect(bodies).toEqual(["message six", "message seven", "message eight", "message nine", "message ten"]);
    // The walk reached the top of the thread: the earlier button is gone.
    expect(dialog.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
  });

  it("degrades to the seeded rows when the api double predates the pager methods", async () => {
    const desk = { ...baseDesk, queue: queueRows, queueCursor: { createdAt: "2026-08-06T10:00:00Z", id: "r2" }, queueTotal: 5 };
    // A pre-paging double: loadDesk and the action methods only.
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk),
      triage: vi.fn(), reply: vi.fn(), publish: vi.fn(), retract: vi.fn(),
      startFormReview: vi.fn(), approveForm: vi.fn(), returnForm: vi.fn(),
      approveAndOpenCase: vi.fn(), scan: vi.fn(),
    };
    renderDesk(desk, api);
    // The hook adopts the seed with a null fetcher — the rows render.
    expect(await screen.findByText("Ada Union")).toBeInTheDocument();
    expect(screen.getByText("Renata Cole")).toBeInTheDocument();
    // The seed's cursor may still render a Load more button, but with no
    // fetcher the loadMore guard makes the click a no-op — no crash, rows stay.
    const more = screen.queryByRole("button", { name: "Load more" });
    if (more) fireEvent.click(more);
    expect(screen.getByText("Ada Union")).toBeInTheDocument();
  });
});

// A11Y-UG-QUEUE-PAGER-SILENT-FAILURES-20260920: a failed page is announced
// through a live region, and after a failed load-more the recovery button is
// named as a retry while it still walks the same keyset cursor.
describe("QueuePager failure announcements", () => {
  const cursor = { createdAt: "2026-08-06T10:00:00Z", id: "r2" };
  const pagerQuery = (overrides = {}) => ({
    rows: queueRows, total: 5, cursor, loading: false, error: null, moreError: null,
    retry: vi.fn(), loadMore: vi.fn(), ...overrides,
  });
  const renderPager = (query, lang = "en") => render(<LanguageProvider lang={lang}><QueuePager query={query} /></LanguageProvider>);

  it.each([
    ["en", "This list could not be loaded.", "Try again"],
    ["es", "No se pudo cargar esta lista.", "Reintentar"],
  ])("announces a first-page failure as an alert (%s)", (lang, failed, retryName) => {
    const query = pagerQuery({ rows: [], total: null, cursor: null, error: new Error("boom") });
    renderPager(query, lang);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(failed);
    fireEvent.click(within(alert).getByRole("button", { name: retryName }));
    expect(query.retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["en", "This list could not be loaded.", "Try again", "Load more"],
    ["es", "No se pudo cargar esta lista.", "Reintentar", "Cargar más"],
  ])("announces a load-more failure and names the recovery button as a retry (%s)", (lang, failed, retryName, loadMoreName) => {
    const query = pagerQuery({ moreError: new Error("boom") });
    renderPager(query, lang);
    expect(screen.getByRole("alert")).toHaveTextContent(failed);
    expect(screen.queryByRole("button", { name: loadMoreName })).toBeNull();
    const retry = screen.getByRole("button", { name: retryName });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    // Same handler, same retained cursor — rows are not dropped.
    expect(query.loadMore).toHaveBeenCalledTimes(1);
    expect(query.retry).not.toHaveBeenCalled();
    expect(query.cursor).toBe(cursor);
  });

  it("keeps the in-flight retry pending with the loading name", () => {
    renderPager(pagerQuery({ moreError: new Error("boom"), loading: true }));
    // Pending, not natively disabled: the loading Show more keeps focus (record 8435).
    expect(screen.getByRole("button", { name: "Loading…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Loading…" })).toHaveAttribute("aria-disabled", "true");
  });

  // Record 8435: Load more keeps keyboard focus while its own page loads, as
  // a browser would otherwise move it to the page when the button disables.
  it("keeps Load more focused and pending while its page loads, and refuses a second press", async () => {
    enableFocusFixup();
    const query = pagerQuery();
    const view = renderPager(query);
    const more = screen.getByRole("button", { name: "Load more" });
    more.focus();
    fireEvent.click(more);
    expect(query.loadMore).toHaveBeenCalledTimes(1);
    view.rerender(<LanguageProvider lang="en"><QueuePager query={{ ...query, loading: true }} /></LanguageProvider>);
    await act(async () => { await afterRenderingUpdate(); });
    const pending = screen.getByRole("button", { name: "Loading…" });
    expect(pending).toBe(more);
    expect(pending).toBeEnabled();
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending).toHaveFocus();
    fireEvent.click(pending);
    expect(query.loadMore).toHaveBeenCalledTimes(1);
    view.rerender(<LanguageProvider lang="en"><QueuePager query={{ ...query, rows: [...queueRows, { ...queueRows[0], id: "r9" }], loading: false }} /></LanguageProvider>);
    await act(async () => { await afterRenderingUpdate(); });
    expect(screen.getByRole("button", { name: "Load more" })).toHaveFocus();
  });

  it("renders no alert on a healthy tail and keeps the Load more name", () => {
    const query = pagerQuery();
    renderPager(query);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(query.loadMore).toHaveBeenCalledTimes(1);
  });
});
