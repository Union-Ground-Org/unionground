import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { engagementApi } from "../src/features/engagement/api.js";

// BUG-UG-WEB-ENGAGEMENT-SURVEYS-UNPAGED-20261002.
//
// The Surveys tab drew every survey the snapshot returned as a full card; at
// 420 surveys the page was 130,000px. The tab now shows one page (open, then
// draft, then closed) with a status filter, the server's totals and Show
// more. Paging must not cost staff their unsaved settings, must move focus to
// the new rows, and every survey must stay reachable.

const RANK = { open: 0, draft: 1, closed: 2 };
const client = {};

function makeSurveys(count) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const status = index % 14 === 0 ? "open" : index % 14 <= 3 ? "draft" : "closed";
    return {
      id: `survey-${String(n).padStart(3, "0")}`,
      title: `Survey ${n}`,
      status,
      cadence: "one_off",
      privacyMinResponses: 3,
      updatedAt: new Date(Date.UTC(2026, 8, 1) + (count - index) * 60000).toISOString(),
      coverage: { total: 0, sent: 0, engaged: 0, failed: 0 },
      tasks: [],
      reviews: [],
    };
  });
}

// The keyset contract of get_staff_engagement_surveys, in memory.
function fakeServer(all) {
  const ordered = [...all].sort((a, b) => (RANK[a.status] - RANK[b.status]) || b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  const counts = { all: all.length, open: 0, draft: 0, closed: 0 };
  for (const survey of all) counts[survey.status] += 1;
  const page = ({ status = null, after = null, limit = 20 } = {}) => {
    const matching = status ? ordered.filter((survey) => survey.status === status) : ordered;
    const start = after ? matching.findIndex((survey) => survey.id === after.id) + 1 : 0;
    const surveys = matching.slice(start, start + limit);
    const last = surveys.at(-1);
    return {
      surveys,
      nextCursor: start + limit < matching.length ? { rank: RANK[last.status], updatedAt: last.updatedAt, id: last.id } : null,
      counts,
    };
  };
  const first = page();
  return {
    ordered,
    counts,
    page,
    snapshot: () => ({ surveys: first.surveys, surveyCounts: counts, surveyCursor: first.nextCursor, livePolls: [], channels: [], pulsePrompts: [], members: [] }),
  };
}

const cardIds = () => [...document.querySelectorAll("h3[id^='eng-survey-']")].map((heading) => heading.id.replace("eng-survey-", ""));
const card = (id) => document.getElementById(`eng-survey-${id}`).closest("article");

async function renderSurveys(lang = "en") {
  render(<LanguageProvider lang={lang}><StaffEngagement client={client} /></LanguageProvider>);
  await screen.findByTestId("staff-engagement");
}

beforeEach(() => {
  vi.spyOn(engagementApi, "loadOrganizationSwitches").mockResolvedValue({ switches: {} });
  vi.spyOn(engagementApi, "loadSurveyAttention").mockResolvedValue({ surveys: [], exports: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("staff engagement surveys are paged", () => {
  it("renders one page of 420 surveys with the server totals, a status filter and Show more", async () => {
    const server = fakeServer(makeSurveys(420));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    const loadPage = vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(async (_client, options) => server.page(options));
    await renderSurveys();

    expect(cardIds()).toHaveLength(20);
    expect(cardIds()).toEqual(server.ordered.slice(0, 20).map((survey) => survey.id));
    // Open surveys first: all 30 open ones come before any draft or closed one.
    expect(server.ordered.slice(0, 20).every((survey) => survey.status === "open")).toBe(true);
    const filter = screen.getByRole("group", { name: "Show surveys" });
    expect(within(filter).getByRole("button", { name: "All 420" })).toHaveAttribute("aria-pressed", "true");
    expect(within(filter).getByRole("button", { name: "Open 30" })).toHaveAttribute("aria-pressed", "false");
    expect(within(filter).getByRole("button", { name: "Drafts 90" })).toBeInTheDocument();
    expect(within(filter).getByRole("button", { name: "Closed 300" })).toBeInTheDocument();
    expect(screen.getByText("Showing 20 of 420 surveys")).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Show more surveys" })).toBeEnabled();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("appends the next keyset page and moves focus to its first survey", async () => {
    const server = fakeServer(makeSurveys(420));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    const loadPage = vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(async (_client, options) => server.page(options));
    await renderSurveys();

    fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
    await waitFor(() => expect(cardIds()).toHaveLength(40));
    expect(loadPage).toHaveBeenLastCalledWith(client, { status: null, after: server.snapshot().surveyCursor, limit: 20 });
    expect(cardIds()).toEqual(server.ordered.slice(0, 40).map((survey) => survey.id));
    const firstNew = server.ordered[20].id;
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById(`eng-survey-${firstNew}`)));
    expect(screen.getByText("Showing 40 of 420 surveys")).toBeInTheDocument();
  });

  it("reaches every survey, page by page, and then offers no more", async () => {
    const server = fakeServer(makeSurveys(65));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(async (_client, options) => server.page(options));
    await renderSurveys();
    for (const expected of [40, 60, 65]) {
      fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
      await waitFor(() => expect(cardIds()).toHaveLength(expected));
    }
    expect(cardIds()).toEqual(server.ordered.map((survey) => survey.id));
    expect(new Set(cardIds()).size).toBe(65);
    expect(screen.queryByRole("button", { name: "Show more surveys" })).toBeNull();
    expect(screen.getByText("Showing 65 of 65 surveys")).toBeInTheDocument();
  });

  it("loads the next page when Show more is pressed as soon as the previous page lands", async () => {
    // A MutationObserver callback runs right after React's commit, before
    // passive effects. Show more is enabled in that same commit, so a click
    // there must already see the new cursor, not fetch the same page again.
    const server = fakeServer(makeSurveys(65));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    const loadPage = vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(async (_client, options) => server.page(options));
    await renderSurveys();
    let clickedAt = 0;
    const observer = new MutationObserver(() => {
      if (clickedAt || cardIds().length !== 40) return;
      clickedAt = cardIds().length;
      fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
      await waitFor(() => expect(cardIds()).toHaveLength(60));
    } finally {
      observer.disconnect();
    }
    expect(clickedAt).toBe(40);
    expect(loadPage.mock.calls.map(([, options]) => options.after.id)).toEqual([server.ordered[19].id, server.ordered[39].id]);
    expect(cardIds()).toEqual(server.ordered.slice(0, 60).map((survey) => survey.id));
  });

  it("filters by status on the server with that status's total", async () => {
    const server = fakeServer(makeSurveys(420));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    const loadPage = vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(async (_client, options) => server.page(options));
    await renderSurveys();

    const closed = screen.getByRole("button", { name: "Closed 300" });
    closed.focus();
    fireEvent.click(closed);
    await waitFor(() => expect(closed).toHaveAttribute("aria-pressed", "true"));
    expect(loadPage).toHaveBeenLastCalledWith(client, { status: "closed", after: null, limit: 20 });
    expect(cardIds()).toHaveLength(20);
    expect(cardIds().every((id) => server.ordered.find((survey) => survey.id === id).status === "closed")).toBe(true);
    expect(screen.getByText("Showing 20 of 300 surveys")).toBeInTheDocument();
    expect(document.activeElement).toBe(closed);
  });

  it.each(["closed first", "all first"])("honors returning to All while Closed is pending (%s)", async (order) => {
    const server = fakeServer(makeSurveys(420));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    let releaseClosed;
    let releaseAll;
    const closedPage = new Promise((resolve) => { releaseClosed = () => resolve(server.page({ status: "closed" })); });
    const allPage = new Promise((resolve) => { releaseAll = () => resolve(server.page()); });
    vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation((_client, options) => options.status === "closed" ? closedPage : allPage);
    await renderSurveys();

    fireEvent.click(screen.getByRole("button", { name: "Closed 300" }));
    expect(screen.getByRole("button", { name: "Loading more surveys…" })).toBeDisabled();
    const all = screen.getByRole("button", { name: "All 420" });
    all.focus();
    fireEvent.click(all);
    const releases = order === "closed first" ? [releaseClosed, releaseAll] : [releaseAll, releaseClosed];
    for (const release of releases) await act(async () => { release(); });

    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Closed 300" })).toHaveAttribute("aria-pressed", "false");
    expect(cardIds()).toEqual(server.ordered.slice(0, 20).map((survey) => survey.id));
    expect(screen.getByText("Showing 20 of 420 surveys")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more surveys" })).toBeEnabled();
    expect(document.activeElement).toBe(all);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a card's unsaved settings and open panel across a filter change", async () => {
    const server = fakeServer(makeSurveys(420));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(async (_client, options) => server.page(options));
    await renderSurveys();

    const target = server.ordered[1].id;
    fireEvent.click(within(card(target)).getByText("Owner, due dates and privacy floor"));
    // The browser reports the opened panel with a toggle event on the next task.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    fireEvent.change(within(card(target)).getByLabelText("Privacy floor"), { target: { value: "9" } });

    fireEvent.click(screen.getByRole("button", { name: "Closed 300" }));
    await waitFor(() => expect(document.getElementById(`eng-survey-${target}`)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "All 420" }));
    await waitFor(() => expect(document.getElementById(`eng-survey-${target}`)).not.toBeNull());

    const settings = within(card(target)).getByText("Owner, due dates and privacy floor").closest("details");
    expect(settings.open).toBe(true);
    expect(within(card(target)).getByLabelText("Privacy floor")).toHaveValue(9);
    // Another card was not touched and keeps the server value.
    expect(within(card(server.ordered[2].id)).getByLabelText("Privacy floor")).toHaveValue(3);
  });

  it("re-reads every row on screen after an action, so a later page is not dropped", async () => {
    const server = fakeServer(makeSurveys(420));
    const loadStaff = vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    const loadPage = vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(async (_client, options) => server.page(options));
    vi.spyOn(engagementApi, "closeSurvey").mockResolvedValue({});
    await renderSurveys();
    fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
    await waitFor(() => expect(cardIds()).toHaveLength(40));

    const target = server.ordered[25].id;
    expect(server.ordered[25].status).toBe("open");
    fireEvent.click(within(card(target)).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(loadStaff).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(loadPage).toHaveBeenLastCalledWith(client, { status: null, after: null, limit: 40 }));
    await waitFor(() => expect(cardIds()).toHaveLength(40));
    expect(cardIds()).toContain(target);
  });

  it("pages a snapshot without server counts locally, open first, with no extra read", async () => {
    const all = makeSurveys(45);
    vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: all, livePolls: [], channels: [], pulsePrompts: [], members: [] });
    const loadPage = vi.spyOn(engagementApi, "loadStaffSurveys");
    await renderSurveys();

    expect(cardIds()).toHaveLength(20);
    const openIds = all.filter((survey) => survey.status === "open").map((survey) => survey.id);
    expect(cardIds().slice(0, openIds.length)).toEqual(openIds);
    expect(screen.getByRole("button", { name: "All 45" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
    await waitFor(() => expect(cardIds()).toHaveLength(40));
    fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
    await waitFor(() => expect(cardIds()).toHaveLength(45));
    expect(new Set(cardIds())).toEqual(new Set(all.map((survey) => survey.id)));
    fireEvent.click(screen.getByRole("button", { name: `Drafts ${all.filter((survey) => survey.status === "draft").length}` }));
    await waitFor(() => expect(cardIds().every((id) => all.find((survey) => survey.id === id).status === "draft")).toBe(true));
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("does not leave Show more disabled when a reload replaces a page that was still loading", async () => {
    const server = fakeServer(makeSurveys(420));
    const loadStaff = vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    let release;
    vi.spyOn(engagementApi, "loadStaffSurveys").mockImplementation(() => new Promise((resolve) => { release = () => resolve(server.page({ after: server.snapshot().surveyCursor })); }));
    vi.spyOn(engagementApi, "closeSurvey").mockResolvedValue({});
    await renderSurveys();
    fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Loading more surveys…" })).toBeDisabled());
    fireEvent.click(within(card(server.ordered[0].id)).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(loadStaff).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show more surveys" })).toBeEnabled());
    release();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(cardIds()).toHaveLength(20);
  });

  it("says when a page could not be read and keeps the rows it has", async () => {
    const server = fakeServer(makeSurveys(420));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    vi.spyOn(engagementApi, "loadStaffSurveys").mockRejectedValue(new Error("timeout"));
    await renderSurveys();
    fireEvent.click(screen.getByRole("button", { name: "Show more surveys" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("More surveys could not be loaded.");
    expect(cardIds()).toHaveLength(20);
    expect(screen.getByRole("button", { name: "Show more surveys" })).toBeEnabled();
  });

  it("speaks Spanish", async () => {
    const server = fakeServer(makeSurveys(420));
    vi.spyOn(engagementApi, "loadStaff").mockImplementation(async () => server.snapshot());
    await renderSurveys("es");
    const filter = screen.getByRole("group", { name: "Mostrar encuestas" });
    expect(within(filter).getByRole("button", { name: "Cerradas 300" })).toBeInTheDocument();
    expect(screen.getByText("Se muestran 20 de 420 encuestas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mostrar más encuestas" })).toBeInTheDocument();
  });
});
