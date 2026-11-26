import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCardTitle, WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AdvisorView } from "../src/views/AdvisorView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";
import { CaseMacroEditor } from "../src/components/CaseMacroEditor.jsx";
import { filterCoordinatorFocus } from "../src/lib/memberApi.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// UB-UG-STAFF-DESK-FIRST-CARD-REPEATS-PAGE-TITLE-20261106: on the
// steward, coordinator and advisor desks each focused page showed its title in
// the page band and again as the title of the first card directly below.

const copy = (value) => JSON.parse(JSON.stringify(value));

function onPage(view, path, child) {
  window.history.replaceState({}, "", path);
  return render(
    <LanguageProvider lang="en">
      <WorkspacePages view={view} hat={view} location={window.location.href} navigate={vi.fn()}>{child}</WorkspacePages>
    </LanguageProvider>,
  );
}

afterEach(() => window.history.replaceState({}, "", "/"));

describe("WorkspaceCardTitle", () => {
  it("drops a card title the focused page already names, and keeps any other", () => {
    onPage("advisor", "/m/advisor/workload", <>
      <WorkspaceCardTitle>Collective workplace log</WorkspaceCardTitle>
      <WorkspaceCardTitle>Latest vote turnout</WorkspaceCardTitle>
    </>);
    expect(screen.queryByRole("heading", { name: "Collective workplace log" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Latest vote turnout" })).toBeInTheDocument();
  });

  it("keeps the title on the overview and outside workspace pages", () => {
    onPage("advisor", "/m/advisor", <WorkspaceCardTitle>Collective workplace log</WorkspaceCardTitle>);
    expect(screen.getByRole("heading", { level: 2, name: "Collective workplace log" })).toBeInTheDocument();
    render(<LanguageProvider lang="en"><WorkspaceCardTitle as="span" className="t">Outside</WorkspaceCardTitle></LanguageProvider>);
    expect(screen.getByText("Outside")).toHaveClass("t");
  });

  it("keeps a labelling title in the tree, hidden, so the region keeps its name", () => {
    onPage("advisor", "/m/advisor/workload", <section aria-labelledby="card-title">
      <WorkspaceCardTitle id="card-title">Collective workplace log</WorkspaceCardTitle>
    </section>);
    expect(screen.getByRole("region", { name: "Collective workplace log" })).toBeInTheDocument();
    expect(document.getElementById("card-title")).not.toBeVisible();
    expect(screen.queryByRole("heading", { name: "Collective workplace log" })).toBeNull();
  });
});

describe("advisor desk pages name themselves once", () => {
  const api = () => ({ loadDesk: vi.fn().mockResolvedValue(copy(fallbackData.advisorDesk)) });
  it.each([
    ["/m/advisor/workload", "#advisor-workload", "Collective workplace log"],
    ["/m/advisor/turnout", "#advisor-turnout", "Latest vote turnout"],
    ["/m/advisor/risks", "#advisor-risks", "At-risk signals"],
    ["/m/advisor/leadership", "#advisor-leadership", "Leadership team"],
  ])("%s", async (path, selector, title) => {
    const { container } = onPage("advisor", path, <AdvisorView data={{ member: { initials: "CL" } }} api={api()} />);
    await screen.findByRole("heading", { level: 1, name: title });
    await vi.waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
    const card = container.querySelector(selector);
    expect(screen.getAllByRole("heading", { name: title })).toHaveLength(1);
    expect(within(card).queryByText(title)).toBeNull();
    // The explanatory line stays.
    expect(card.querySelector(".ach-card__sub, .ach-roster-head__sub")?.textContent).toBeTruthy();
  });

  it("keeps every card title without workspace pages", async () => {
    render(<LanguageProvider lang="en"><AdvisorView data={{ member: { initials: "CL" } }} api={api()} /></LanguageProvider>);
    for (const title of ["Collective workplace log", "Latest vote turnout", "At-risk signals", "Leadership team"]) {
      expect(await screen.findByRole("heading", { level: 2, name: title })).toBeInTheDocument();
    }
  });
});

describe("steward desk pages name themselves once", () => {
  const desk = {
    queue: [{ id: "req-1", memberName: "Renata Cole", memberInitials: "RC", lessonLabel: "Weingarten", status: "requested", createdAt: "2026-07-20T14:00:00Z" }],
    threads: [],
    broadcasts: [],
    formsInbox: [],
    caseload: [],
    workloadIntelligence: { available: false, reason: "anonymity_floor" },
    kpis: { openRequests: 1, membersCovered: 38, awaitingReply: 0, broadcasts30d: 0 },
  };
  const api = () => ({
    loadDesk: vi.fn().mockResolvedValue(copy(desk)),
    loadAppointments: vi.fn().mockResolvedValue({ schedule: null, windows: [], upcoming: [], recent: [] }),
    listScheduled: vi.fn().mockResolvedValue([]),
  });

  it.each([
    ["/m/steward/caseload", "#steward-caseload", "Your issues", ".cwk-count"],
    ["/m/steward/requests", "#steward-requests", "Worker requests", ".cwk-count"],
    ["/m/steward/appointments", "#steward-appointments", "One-on-ones", ".cwk-count"],
    ["/m/steward/checkins", "#steward-checkins", "Scan check-ins", ".cwk-card__note"],
    ["/m/steward/broadcasts", "#steward-broadcasts", "Broadcasts", ".cwk-card__note"],
    ["/m/steward/workload", ".cwk-workload", "Workplace log insights", ".cwk-panel__note"],
  ])("%s", async (path, selector, title, kept) => {
    const { container } = onPage("steward", path, <StewardView data={{ member: {} }} api={api()} onNotice={vi.fn()} />);
    await screen.findByRole("heading", { level: 1, name: title });
    await vi.waitFor(() => expect(container.querySelector(`${selector} ${kept}`)).not.toBeNull());
    const card = container.querySelector(selector);
    expect(screen.getAllByRole("heading", { name: title })).toHaveLength(1);
    expect(within(card).queryAllByText(title).filter((node) => !node.closest("[hidden]"))).toEqual([]);
  });

  it("keeps the workload region named after its title leaves the page", async () => {
    onPage("steward", "/m/steward/workload", <StewardView data={{ member: {} }} api={api()} onNotice={vi.fn()} />);
    expect(await screen.findByRole("region", { name: "Workplace log insights" })).toBeInTheDocument();
  });

  it("keeps the card titles without workspace pages", async () => {
    const { container } = render(<LanguageProvider lang="en"><StewardView data={{ member: {} }} api={api()} onNotice={vi.fn()} /></LanguageProvider>);
    await vi.waitFor(() => expect(container.querySelector("#steward-requests")).not.toBeNull());
    expect(within(container.querySelector("#steward-requests")).getByText("Worker requests")).toBeInTheDocument();
  });
});

describe("coordinator desk pages name themselves once", () => {
  const desk = () => copy(fallbackData.coordinatorDesk);
  const api = () => ({
    loadDesk: vi.fn().mockResolvedValue(desk()),
    loadCases: vi.fn(async ({ focus = "all" } = {}) => ({ cases: filterCoordinatorFocus(desk().cases, focus), nextCursor: null })),
  });

  it("keeps a single heading on the upcoming deadlines page", async () => {
    const path = "/m/coordinator/deadlines";
    const title = "Upcoming deadlines";
    onPage("coordinator", path, <CoordinatorView data={{ member: { initials: "JP" } }} api={api()} />);
    const card = await screen.findByRole("region", { name: title });
    expect(within(card).queryByText(title)).toBeNull();
    expect(card.querySelector(".gq-card__chip")?.textContent).toBeTruthy();
    expect(screen.getAllByRole("heading", { name: title })).toHaveLength(1);
  });

  it("drops the Case macros card title on its own page and keeps its help line", async () => {
    onPage("coordinator", "/m/coordinator/macros", <CaseMacroEditor api={{ listMacros: vi.fn().mockResolvedValue([]) }} />);
    const region = await screen.findByRole("region", { name: "Issue macros" });
    expect(screen.queryByRole("heading", { name: "Issue macros" })).toBeNull();
    expect(region.querySelector(".cwk-panel__head p")?.textContent).toBeTruthy();
  });

  it.each([["coordinator"], ["steward"]])("drops the %s Issue work hub card title on its own page and keeps the region named", async (view) => {
    const api = {
      loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [], drafts: [], patterns: [] }),
      loadCaseworkHistory: vi.fn().mockResolvedValue({ rows: [], total: 0, page: 0, pageSize: 50 }),
    };
    onPage(view, `/m/${view}/casework-hub`, <CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} />);
    expect(await screen.findByRole("region", { name: "Issue work hub" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Issue work hub" })).toBeNull();
  });
});
