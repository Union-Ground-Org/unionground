// REQ-UG-CASEWORK-CONSOLE-54-CASE-DASHBOARDS-20260917.
//
// The tiles exist to answer questions about the whole chapter, so the two
// things worth regressing are: the numbers are the SERVER's (the component
// never re-derives a count), and every tile is a working deep link into the
// filtered case list with the exact query names lane 5.2's list reads.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseDashboards } from "../src/components/CaseDashboards.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { loadCaseDashboards } from "../src/lib/caseworkApi.js";

// One fixture, deliberately not round: the ninth-day deadline proves the
// window, the two overdue kinds prove the per-kind bars, and the unassigned row
// proves the explicit remainder rather than a silent gap.
const AGGREGATES = {
  dueSoon: [
    { daysOut: 0, deadlineCount: 2, caseCount: 2 },
    { daysOut: 3, deadlineCount: 1, caseCount: 1 },
    { daysOut: 6, deadlineCount: 4, caseCount: 3 },
  ],
  overdue: [
    { kind: "response", deadlineCount: 5, caseCount: 4, oldestDueAt: "2026-08-02T12:00:00Z" },
    { kind: "follow_up", deadlineCount: 1, caseCount: 1, oldestDueAt: "2026-09-01T12:00:00Z" },
  ],
  byAssignee: [
    { role: "steward", userId: "user-steward-1", name: "Priya Chandran", caseCount: 6 },
    { role: "coordinator", userId: "user-coord-1", name: "Jordan Patel", caseCount: 4 },
    { role: "unassigned", userId: null, name: "", caseCount: 2 },
  ],
};

// Union Ground issues have no grievance procedure (owner decision,
// 2026-10-13), so the by-step and median-days-per-step tiles are gone. A
// payload that still carries those rows (an older loader, a cached response)
// must not bring them back.
const WITH_LEGACY_STEP_ROWS = {
  ...AGGREGATES,
  byStep: [
    { step: "Step 2", caseCount: 7 },
    { step: "Step 1", caseCount: 3 },
  ],
  medianDays: [{ step: "Step 1", medianDays: 4.5, transitionCount: 12 }],
};

const TILE_TITLES = ["Deadlines due in the next 7 days", "Overdue deadlines", "Open issues per assignee"];

const EMPTY = { dueSoon: [], overdue: [], byAssignee: [] };

function renderDashboards({
  data = AGGREGATES,
  lang = "en",
  caseListPath = "/m/coordinator/cases/queue",
  onNotice,
  loader,
  lookaheadDays,
} = {}) {
  const api = { loadCaseDashboards: loader || vi.fn().mockResolvedValue(data) };
  const view = render(
    <LanguageProvider lang={lang}>
      <CaseDashboards api={api} caseListPath={caseListPath} onNotice={onNotice} lookaheadDays={lookaheadDays} />
    </LanguageProvider>,
  );
  return { ...view, api };
}

// Every tile only exists after the aggregate read resolves, so the helper
// waits rather than letting each test remember to.
function tile(name) {
  return screen.findByRole("figure", { name });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/m/coordinator/cases/dashboards");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("case dashboards", () => {
  it("draws three tiles from the server aggregates and reads them exactly once", async () => {
    const { api } = renderDashboards();
    expect(await screen.findByRole("heading", { name: "Issue dashboards" })).toBeInTheDocument();
    for (const title of TILE_TITLES) expect(await tile(title)).toBeInTheDocument();
    expect(screen.getAllByRole("figure")).toHaveLength(3);
    expect(api.loadCaseDashboards).toHaveBeenCalledTimes(1);
  });

  it("draws no by-step or median-per-step tile, even from a payload that still carries those rows", async () => {
    const { container } = renderDashboards({ data: WITH_LEGACY_STEP_ROWS });
    for (const title of TILE_TITLES) expect(await tile(title)).toBeInTheDocument();
    expect(screen.getAllByRole("figure")).toHaveLength(3);
    expect(screen.queryByRole("figure", { name: "Open issues by step" })).toBeNull();
    expect(screen.queryByRole("figure", { name: "Median days per step" })).toBeNull();
    expect(screen.queryByText(/Step [12]/)).toBeNull();
    expect([...container.querySelectorAll("a")].filter((link) => /[?&]step=/.test(link.getAttribute("href")))).toEqual([]);
  });

  it("totals from the returned rows rather than from a loaded page of cases", async () => {
    renderDashboards();
    // 2 + 1 + 4, the sum of the rows the server sent, not the length of a list.
    expect(await within(await tile("Deadlines due in the next 7 days")).findByText("7 deadlines")).toBeInTheDocument();
    expect(within(await tile("Overdue deadlines")).getByText("6 deadlines")).toBeInTheDocument();
  });

  it("deep-links each tile into the filtered case list with the agreed query names", async () => {
    renderDashboards();
    expect(within(await tile("Deadlines due in the next 7 days")).getByRole("link"))
      .toHaveAttribute("href", "/m/coordinator/cases/queue?deadline=7d");

    const overdue = within(await tile("Overdue deadlines")).getAllByRole("link");
    expect(overdue[0]).toHaveAttribute("href", "/m/coordinator/cases/queue?deadline=overdue&kind=response");
    expect(overdue[1]).toHaveAttribute("href", "/m/coordinator/cases/queue?deadline=overdue&kind=follow_up");

    const assignees = within(await tile("Open issues per assignee")).getAllByRole("link");
    expect(assignees[0]).toHaveAttribute("href", "/m/coordinator/cases/queue?assignee=user-steward-1&role=steward");
    expect(assignees[0]).toHaveAccessibleName("Open the 6 issues assigned to Priya Chandran");
    // The unassigned remainder is a filter of its own, never an empty assignee.
    expect(assignees[2]).toHaveAttribute("href", "/m/coordinator/cases/queue?assignee=none&role=unassigned");
    expect(assignees[2]).toHaveAccessibleName("Open the 2 issues with no assignee");
  });

  it("aims the same tiles at the caller's own list, so the steward plane is not the coordinator queue", async () => {
    renderDashboards({ caseListPath: "/m/steward" });
    expect(within(await tile("Deadlines due in the next 7 days")).getByRole("link")).toHaveAttribute("href", "/m/steward?deadline=7d");
    const assignees = within(await tile("Open issues per assignee")).getAllByRole("link");
    expect(assignees[0]).toHaveAttribute("href", "/m/steward?assignee=user-steward-1&role=steward");
  });

  it("carries the demo context through a deep link instead of dropping the caller out of SAMPLE", async () => {
    window.history.replaceState({}, "", "/m/coordinator/cases/dashboards?demo=1");
    renderDashboards();
    const assignees = within(await tile("Open issues per assignee")).getAllByRole("link");
    expect(assignees[0]).toHaveAttribute("href", "/m/coordinator/cases/queue?assignee=user-steward-1&role=steward&demo=1");
  });

  it("keeps every chart's data table in the accessibility tree before the toggle is pressed", async () => {
    const { container } = renderDashboards();
    await screen.findByRole("heading", { name: "Open issues per assignee" });
    const assigneeTile = await tile("Open issues per assignee");
    const table = within(assigneeTile).getByRole("table");
    // Visually hidden, not display:none — a table that only exists after a
    // click is a table a screen reader cannot find.
    expect(table.closest(".cdash-chart__data")).toHaveClass("visually-hidden");
    expect(within(table).getByRole("rowheader", { name: "Priya Chandran" })).toBeInTheDocument();
    expect(within(table).getByText("6")).toBeInTheDocument();
    expect(table).toHaveAccessibleName("Data table: Open issues per assignee");
    expect(container.querySelectorAll(".cdash-chart__data table")).toHaveLength(3);
    // The overdue aggregate's oldest missed due date is only readable here.
    const overdueTable = within(await tile("Overdue deadlines")).getByRole("table");
    expect(within(overdueTable).getByRole("columnheader", { name: "Oldest due" })).toBeInTheDocument();
    const responseRow = within(overdueTable).getByRole("rowheader", { name: "Response" }).closest("tr");
    expect(within(responseRow).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["5", "4", "Aug 2, 2026"]);
  });

  it("un-hides the data table on screen when the toggle is pressed, and re-hides it", async () => {
    renderDashboards();
    const assigneeTile = await tile("Open issues per assignee");
    const toggle = await within(assigneeTile).findByRole("button", { name: "Show the data table" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(within(assigneeTile).getByRole("button", { name: "Hide the data table" })).toHaveAttribute("aria-expanded", "true");
    expect(within(assigneeTile).getByRole("table").closest(".cdash-chart__data")).not.toHaveClass("visually-hidden");
    fireEvent.click(within(assigneeTile).getByRole("button", { name: "Hide the data table" }));
    expect(within(assigneeTile).getByRole("table").closest(".cdash-chart__data")).toHaveClass("visually-hidden");
  });

  // REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: the window is the
  // organization's deadline lookahead, which the due-soon RPC also reads.
  it("draws the organization's configured lookahead and links the matching list window", async () => {
    const { container } = renderDashboards({ lookaheadDays: 14 });
    await screen.findByRole("heading", { name: "Deadlines due in the next 14 days" });
    expect(container.querySelectorAll(".cdash-columns__slot")).toHaveLength(14);
    expect(within(await tile("Deadlines due in the next 14 days")).getByRole("link"))
      .toHaveAttribute("href", expect.stringContaining("deadline=30d"));
  });

  it("falls back to the seven-day window for an out-of-range lookahead", async () => {
    const { container } = renderDashboards({ lookaheadDays: 400 });
    await screen.findByRole("heading", { name: "Deadlines due in the next 7 days" });
    expect(container.querySelectorAll(".cdash-columns__slot")).toHaveLength(7);
  });

  it("draws all seven days of the window, including the days with no deadline", async () => {
    const { container } = renderDashboards();
    await screen.findByRole("heading", { name: "Deadlines due in the next 7 days" });
    expect(container.querySelectorAll(".cdash-columns__slot")).toHaveLength(7);
    // A quiet day is drawn as a quiet day; omitting it would make two very
    // different weeks look identical.
    expect(container.querySelectorAll('.cdash-columns__bar[data-empty="true"]')).toHaveLength(4);
    const rows = within(await tile("Deadlines due in the next 7 days")).getAllByRole("row");
    expect(rows).toHaveLength(8);
    expect(within(rows[1]).getByRole("rowheader")).toHaveTextContent("Today");
    expect(within(rows[2]).getByRole("rowheader")).toHaveTextContent("Tomorrow");
  });

  it("opens a tile inside the workspace on a plain click and leaves a modified click to the browser", async () => {
    const navigate = vi.fn();
    const api = { loadCaseDashboards: vi.fn().mockResolvedValue(AGGREGATES) };
    render(
      <LanguageProvider lang="en">
        <WorkspacePages view="coordinator" location="/m/coordinator/cases/dashboards" navigate={navigate} hat="coordinator">
          <CaseDashboards api={api} caseListPath="/m/coordinator/cases/queue" />
        </WorkspacePages>
      </LanguageProvider>,
    );
    const assignees = within(await tile("Open issues per assignee")).getAllByRole("link");
    // The workspace router's own delegated handler claims hash links only, so
    // without this the tile would reload the whole application.
    fireEvent.click(assignees[0]);
    expect(navigate).toHaveBeenCalledWith("coordinator", "/m/coordinator/cases/queue?assignee=user-steward-1&role=steward", null, { replace: false });

    navigate.mockClear();
    fireEvent.click(assignees[1], { metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("states a refusal and offers a retry when the aggregate read fails", async () => {
    const onNotice = vi.fn();
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(AGGREGATES);
    renderDashboards({ loader, onNotice });
    expect(await screen.findByRole("alert")).toHaveTextContent("The issue dashboards are unavailable.");
    // No zeros: a failed read must not be drawn as an empty chapter.
    expect(screen.queryByRole("figure")).toBeNull();
    expect(onNotice).toHaveBeenCalledWith("The issue dashboards are unavailable.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Open issues per assignee" })).toBeInTheDocument();
  });

  it("says a window is empty rather than drawing an empty chart", async () => {
    const { container } = renderDashboards({ data: EMPTY });
    await screen.findByRole("heading", { name: "Issue dashboards" });
    // Two of the three say so in words. The third is the seven-day window,
    // which is a window whether or not anything falls in it: a quiet week is
    // seven empty columns, and saying "nothing to chart" would hide that the
    // week was actually looked at.
    expect(container.querySelectorAll(".cdash-chart__empty")).toHaveLength(2);
    expect(within(await tile("Overdue deadlines")).getByText("Nothing to chart in this window yet.")).toBeInTheDocument();
    expect(within(await tile("Open issues per assignee")).getByText("Nothing to chart in this window yet.")).toBeInTheDocument();
    expect(container.querySelectorAll('.cdash-columns__bar[data-empty="true"]')).toHaveLength(7);
    // Nothing to tabulate means no table and no toggle, not an empty grid.
    expect(screen.queryAllByRole("table")).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: "Show the data table" })).toHaveLength(1);
  });

  it("renders the whole section in Spanish, values and chrome alike", async () => {
    renderDashboards({ lang: "es" });
    expect(await screen.findByRole("heading", { name: "Paneles de asuntos" })).toBeInTheDocument();
    const dueTile = screen.getByRole("figure", { name: "Plazos que vencen en los próximos 7 días" });
    expect(within(dueTile).getByText("7 plazos")).toBeInTheDocument();
    const assigneeTile = screen.getByRole("figure", { name: "Asuntos abiertos por persona asignada" });
    expect(within(assigneeTile).getAllByRole("link")[0]).toHaveAccessibleName("Abrir los 6 asuntos asignados a Priya Chandran");
    expect(within(assigneeTile).getByRole("rowheader", { name: "Priya Chandran" }).closest("tr")).toHaveTextContent("Comité");
    const overdueTile = screen.getByRole("figure", { name: "Plazos vencidos" });
    expect(within(overdueTile).getByRole("rowheader", { name: "Respuesta" })).toBeInTheDocument();
    expect(screen.getAllByRole("figure")).toHaveLength(3);
  });

  it("keeps the loaded tiles and states staleness once in place when a refresh fails", async () => {
    const onNotice = vi.fn();
    const loader = vi.fn()
      .mockResolvedValueOnce(AGGREGATES)
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(AGGREGATES);
    renderDashboards({ loader, onNotice });
    const assigneeTile = await tile("Open issues per assignee");
    const links = within(assigneeTile).getAllByRole("link").length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboards" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The dashboards could not be refreshed. These figures are from the last successful read.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("The issue dashboards are unavailable.")).toBeNull();
    expect(onNotice).not.toHaveBeenCalled();
    expect(within(screen.getByRole("figure", { name: "Open issues per assignee" })).getAllByRole("link")).toHaveLength(links);
    expect(screen.getAllByRole("figure")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboards" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(loader).toHaveBeenCalledTimes(3);
    expect(screen.getAllByRole("figure")).toHaveLength(3);
  });

  it("re-reads on demand without leaving the tiles blank in between", async () => {
    const loader = vi.fn().mockResolvedValue(AGGREGATES);
    renderDashboards({ loader });
    await screen.findByRole("heading", { name: "Open issues per assignee" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboards" }));
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Open issues per assignee" })).toBeInTheDocument();
  });
});

describe("loadCaseDashboards", () => {
  function rpcClient(responses) {
    return { rpc: vi.fn(async (name) => responses[name]) };
  }

  const ROWS = {
    casework_dashboard_deadlines_due_soon: { data: [{ days_out: 0, deadline_count: "2", case_count: "2" }], error: null },
    casework_dashboard_overdue_deadlines: { data: [{ kind: "response", deadline_count: "5", case_count: "4", oldest_due_at: "2026-08-02T12:00:00Z" }], error: null },
    casework_dashboard_open_cases_by_assignee: { data: [{ assignee_role: "unassigned", assignee_user_id: null, assignee_name: null, case_count: "2" }], error: null },
  };

  // The by-step and median-days-per-step aggregates still exist in the inert
  // schema; the client answers them too, so a call would be visible.
  const WITH_STEP_RPCS = {
    ...ROWS,
    casework_dashboard_open_cases_by_step: { data: [{ step: "Step 2", case_count: "7" }], error: null },
    casework_dashboard_median_days_per_step: { data: [{ step: "Step 1", median_days: "4.50", transition_count: "12" }], error: null },
  };

  it("calls the three aggregates and nothing else, passing no scope of its own", async () => {
    const client = rpcClient(WITH_STEP_RPCS);
    await loadCaseDashboards(client);
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(Object.keys(ROWS));
    // Every call is argument-free: the scope is the caller's, decided in the
    // database, never a chapter id the browser could substitute.
    for (const call of client.rpc.mock.calls) expect(call).toHaveLength(1);
  });

  it("turns PostgREST's numeric strings into numbers so a chart never scales by text", async () => {
    const result = await loadCaseDashboards(rpcClient(WITH_STEP_RPCS));
    expect(Object.keys(result)).toEqual(["dueSoon", "overdue", "byAssignee"]);
    expect(result.dueSoon).toEqual([{ daysOut: 0, deadlineCount: 2, caseCount: 2 }]);
    expect(result.overdue).toEqual([{ kind: "response", deadlineCount: 5, caseCount: 4, oldestDueAt: "2026-08-02T12:00:00Z" }]);
    expect(result.byAssignee).toEqual([{ role: "unassigned", userId: null, name: "", caseCount: 2 }]);
  });

  it("raises the refusal instead of returning a partially drawn dashboard", async () => {
    const denied = {
      ...ROWS,
      casework_dashboard_overdue_deadlines: { data: null, error: { code: "42501", message: "chapter staff role required" } },
    };
    await expect(loadCaseDashboards(rpcClient(denied))).rejects.toMatchObject({ code: "42501" });
  });
});
