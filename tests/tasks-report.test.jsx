import { StrictMode } from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { localeFor, t as translate } from "../src/lib/i18n.js";
import { easternDay } from "../src/lib/easternTime.js";
import { TasksReport, buildReportCsv, customRangeInverted, windowBounds } from "../src/views/TasksReport.jsx";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { loadChapterTaskReport } from "../src/lib/memberApi.js";

const stateWrites = vi.hoisted(() => ({ active: false, calls: [] }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal();
  return {
    ...react,
    useState(initial) {
      const [value, setValue] = react.useState(initial);
      const trackedSetValue = react.useCallback((next) => {
        if (stateWrites.active) stateWrites.calls.push(next);
        return setValue(next);
      }, [setValue]);
      return [value, trackedSetValue];
    },
  };
});

// The fifth view: fed by ONE chapter_task_report(from,to) call, window named
// in the header, counts-only CSV, median suppressed under five finished, and
// removed work counted instead of hidden.

const t = (key, vars) => translate("en", key, vars);

const REPORT = {
  chapterId: "wor",
  from: "2000-01-01",
  to: "2026-07-28",
  generatedAt: "2026-07-28T12:00:00Z",
  totals: {
    total: 10,
    done: 6,
    open: 4,
    blocked: 1,
    overdue: 2,
    milestones: 1,
    median_days_to_done: 4.25,
    done_late: 2,
  },
  deletedCount: 3,
  byMonth: [{ month: "2026-06", done: 2 }, { month: "2026-07", done: 4 }],
  byWorkstream: [{ name: "Chapter", total: 6, done: 4, blocked: 1 }, { name: "Organizing", total: 4, done: 2, blocked: 0 }],
  byPerson: [{ name: "Priya Shah", total: 5, done: 4, overdue: 1 }, { name: "—", total: 5, done: 2, overdue: 1 }],
};

function renderReport(overrides = {}) {
  const props = {
    t,
    lang: "en",
    chapterName: "Harborview Care United",
    onLoadReport: vi.fn(async () => structuredClone(REPORT)),
    ...overrides,
  };
  render(<TasksReport {...props} />);
  return props;
}

describe("the report view", () => {
  it("loads once on open — all time, both bounds null — and names its window", async () => {
    const props = renderReport();
    await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(1));
    expect(props.onLoadReport).toHaveBeenCalledWith(null, null);
    // The header names the window (distinct from the control that picked it).
    await waitFor(() => expect(document.querySelector(".tasks-report__window")).toHaveTextContent("All time"));
    // The figures: finished, still open, finished late, median. ("Finished"
    // also captions each breakdown column, hence getAllByText.)
    expect(screen.getAllByText("Finished").length).toBeGreaterThan(0);
    expect(screen.getByText("Still open")).toBeInTheDocument();
    expect(screen.getByText("Finished late")).toBeInTheDocument();
    expect(screen.getByText("Median days to done")).toBeInTheDocument();
    expect(screen.getByText("4.3")).toBeInTheDocument(); // 4.25 rounded to 1dp
    // Removed work is a visible explanation, not a smaller silent total.
    expect(screen.getByText("3 removed from the board in this window")).toBeInTheDocument();
  });

  it("exposes month and workstream bars as named progress values", async () => {
    renderReport();
    await screen.findByText("All time");
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(4);
    expect(screen.getByRole("progressbar", { name: "2026-06" })).toHaveAttribute("aria-valuemin", "0");
    expect(screen.getByRole("progressbar", { name: "2026-06" })).toHaveAttribute("aria-valuemax", "4");
    expect(screen.getByRole("progressbar", { name: "2026-06" })).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByRole("progressbar", { name: "Chapter" })).toHaveAttribute("aria-valuemax", "6");
    expect(screen.getByRole("progressbar", { name: "Chapter" })).toHaveAttribute("aria-valuenow", "4");
  });

  it("prints the By-person finished cell from done, not assigned total", async () => {
    renderReport();
    await screen.findByText("All time");
    const personRow = [...document.querySelectorAll(".tasks-breakdown__row--person")]
      .find((row) => row.textContent.includes("Priya Shah"));
    expect(personRow.querySelector("b")).toHaveTextContent("4");
    const chapterRow = [...document.querySelectorAll(".tasks-breakdown__row")]
      .find((row) => row.querySelector("strong")?.textContent === "Chapter");
    expect(chapterRow.querySelector("b")).toHaveTextContent("4");
  });

  it("uses section headings one level under the Report tab title", async () => {
    renderReport();
    await screen.findByText("All time");
    for (const name of ["Completion by month", "By workstream", "By person"]) {
      expect(screen.getByRole("heading", { level: 3, name })).toBeInTheDocument();
    }
    expect(document.querySelector(".tasks-report .tasks-breakdown h2")).toBeNull();
  });

  it("sends dates for This year", async () => {
    const props = renderReport();
    await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "This year" }));
    await waitFor(() => expect(props.onLoadReport).toHaveBeenLastCalledWith(`${easternDay(new Date()).slice(0, 4)}-01-01`, null));
  });

  // Gate stage 190 (r1s1/r2s1): the server ends the default range on the
  // Eastern day. At 10:30 PM Eastern on December 31 a UTC device is already
  // in the new year; "This year" must still start on the Eastern year, or the
  // range arrives inverted. "Last quarter" is the Eastern quarter before.
  it("takes This year and Last quarter from the Eastern day on a device in another zone", async () => {
    const priorZone = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-01T03:30:00Z"));
    try {
      expect(new Date().getFullYear()).toBe(2027);
      const props = renderReport();
      await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "This year" }));
      await waitFor(() => expect(props.onLoadReport).toHaveBeenLastCalledWith("2026-01-01", null));
      fireEvent.click(screen.getByRole("button", { name: "Last quarter" }));
      await waitFor(() => expect(props.onLoadReport).toHaveBeenLastCalledWith("2026-07-01", "2026-09-30"));
    } finally {
      vi.useRealTimers();
      if (priorZone === undefined) delete process.env.TZ;
      else process.env.TZ = priorZone;
    }
  });

  it("suppresses the median under five finished tasks", async () => {
    const thin = structuredClone(REPORT);
    thin.totals.done = 4;
    renderReport({ onLoadReport: vi.fn(async () => thin) });
    expect(await screen.findByText("Too few finished tasks to time")).toBeInTheDocument();
    expect(screen.queryByText("4.3")).not.toBeInTheDocument();
  });

  it("says honestly when nothing finished, never a 0% ring", async () => {
    const empty = structuredClone(REPORT);
    empty.totals.done = 0;
    empty.byMonth = [];
    renderReport({ onLoadReport: vi.fn(async () => empty) });
    expect(await screen.findByText(/Nothing finished through/)).toBeInTheDocument();
    expect(screen.queryByText("Completion by month")).not.toBeInTheDocument();
  });

  it("names the failure instead of rendering an empty report", async () => {
    renderReport({ onLoadReport: vi.fn(async () => { throw new Error("42501"); }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("The report could not be loaded. Try again.");
  });

  // UX-UG-TASKS-REPORT-WINDOW-SENTINEL-20260920: the RPC fills a null
  // start with 2000-01-01; the banner names the window that was REQUESTED,
  // so an unbounded start is never printed as that sentinel date.
  it("names a blank Custom submit All time, never the 2000-01-01 sentinel", async () => {
    const props = renderReport();
    await screen.findByText("All time");
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(2));
    expect(props.onLoadReport).toHaveBeenLastCalledWith(null, null);
    await waitFor(() => expect(document.querySelector(".tasks-report__window")).toHaveTextContent("All time"));
    expect(document.querySelector(".tasks-report").textContent).not.toMatch(/2000/);
  });

  it("names a Custom window with only an end date as everything through that date", async () => {
    const props = renderReport({
      onLoadReport: vi.fn(async (from, to) => ({ ...structuredClone(REPORT), to: to || REPORT.to })),
    });
    await screen.findByText("All time");
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await waitFor(() => expect(props.onLoadReport).toHaveBeenLastCalledWith(null, "2026-06-30"));
    await waitFor(() => expect(document.querySelector(".tasks-report__window"))
      .toHaveTextContent("Everything through Jun 30, 2026 — what finished, and how long it took."));
    expect(document.querySelector(".tasks-report").textContent).not.toMatch(/2000/);
  });

  it("counts the Eastern quarter before, across a year start and inside a year", () => {
    // 11 PM Eastern on March 31 is already April 1 in UTC.
    expect(windowBounds("quarter", {}, new Date("2027-04-01T03:00:00Z"))).toEqual(["2026-10-01", "2026-12-31"]);
    expect(windowBounds("quarter", {}, new Date("2027-05-15T16:00:00Z"))).toEqual(["2027-01-01", "2027-03-31"]);
    expect(windowBounds("year", {}, new Date("2027-01-01T04:59:00Z"))).toEqual(["2026-01-01", null]);
    expect(windowBounds("year", {}, new Date("2027-01-01T05:00:00Z"))).toEqual(["2027-01-01", null]);
    expect(windowBounds("all", {})).toEqual([null, null]);
  });

  it("sends both Custom dates the person typed", async () => {
    const props = renderReport();
    await screen.findByText("All time");
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-04-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await waitFor(() => expect(props.onLoadReport).toHaveBeenLastCalledWith("2026-04-01", "2026-06-30"));
  });

  it("says the report could not load when no loader is wired, and asks for nothing", async () => {
    render(<TasksReport t={t} lang="en" chapterName="Cedar Ridge Care Services" />);
    expect(await screen.findByText(t("tasks.reportError"))).toBeInTheDocument();
  });

  it("says nothing finished through the end date on an empty all-time report", async () => {
    const empty = structuredClone(REPORT);
    empty.totals.done = 0;
    empty.byMonth = [];
    renderReport({ onLoadReport: vi.fn(async () => empty) });
    expect(await screen.findByText("Nothing finished through Jul 28, 2026.")).toBeInTheDocument();
    expect(document.querySelector(".tasks-report").textContent).not.toMatch(/2000/);
  });
});

// BUG-UG-TASKS-REPORT-STALE-WINDOW-READ-20260920: two chips pressed before
// either read settles must settle on the LAST window chosen — the abandoned
// read can neither paint its figures, nor rename the banner, nor raise the
// failure card over a report that already arrived.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reportWithDone(done, overrides = {}) {
  const report = structuredClone(REPORT);
  report.totals.done = done;
  return { ...report, ...overrides };
}

// The Eastern quarter before the current Eastern one, as the view counts it.
function lastQuarterBounds() {
  const today = easternDay(new Date());
  const year = Number(today.slice(0, 4));
  const quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  const [startYear, startQuarter] = quarter === 0 ? [year - 1, 3] : [year, quarter - 1];
  const start = `${startYear}-${String(startQuarter * 3 + 1).padStart(2, "0")}-01`;
  const lastMonth = startQuarter * 3 + 3;
  const lastDay = new Date(Date.UTC(startYear, lastMonth, 0)).getUTCDate();
  return [start, `${startYear}-${String(lastMonth).padStart(2, "0")}-${lastDay}`];
}

const formatDayLabel = (value) =>
  new Intl.DateTimeFormat(localeFor("en"), { year: "numeric", month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));

const windowBanner = () => document.querySelector(".tasks-report__window");
const finishedFigure = () => document.querySelector(".tasks-summary__metric strong");

function renderWithDeferredLoads() {
  const pending = [];
  const onLoadReport = vi.fn(() => {
    const d = deferred();
    pending.push(d);
    return d.promise;
  });
  const view = render(<TasksReport t={t} lang="en" chapterName="Harborview Care United" onLoadReport={onLoadReport} />);
  return { onLoadReport, pending, view };
}

describe("the report view under stale window reads", () => {
  it("settles on the last window pressed when reads finish out of order", async () => {
    const { pending } = renderWithDeferredLoads();
    // The baseline all-time read (fired on open) settles first.
    await act(async () => { pending[0].resolve(reportWithDone(6)); });
    await waitFor(() => expect(windowBanner()).toHaveTextContent("All time"));
    fireEvent.click(screen.getByRole("button", { name: "This year" }));
    // The in-flight chip is announced busy but stays enabled for keyboards.
    const yearChip = screen.getByRole("button", { name: "This year" });
    expect(yearChip).toHaveAttribute("aria-busy", "true");
    expect(yearChip).not.toHaveAttribute("disabled");
    fireEvent.click(screen.getByRole("button", { name: "Last quarter" }));
    expect(pending).toHaveLength(3);
    // The quarter read settles first; the older year read settles LAST.
    const [from, to] = lastQuarterBounds();
    await act(async () => { pending[2].resolve(reportWithDone(9, { from, to })); });
    await act(async () => { pending[1].resolve(reportWithDone(7, { from: `${new Date().getFullYear()}-01-01`, to: null })); });
    expect(windowBanner()).toHaveTextContent(`${formatDayLabel(from)} to ${formatDayLabel(to)}`);
    // The figures are the quarter's, not the late-finishing year's.
    expect(finishedFigure()).toHaveTextContent("9");
  });

  it("a stale rejection cannot raise the failure card over a live report", async () => {
    const { pending } = renderWithDeferredLoads();
    await act(async () => { pending[0].resolve(reportWithDone(6)); });
    await waitFor(() => expect(windowBanner()).toHaveTextContent("All time"));
    fireEvent.click(screen.getByRole("button", { name: "This year" }));
    fireEvent.click(screen.getByRole("button", { name: "Last quarter" }));
    // The second read settles; the first read then REJECTS while stale.
    await act(async () => { pending[2].resolve(reportWithDone(9)); });
    await act(async () => { pending[1].reject(new Error("network")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(windowBanner()).not.toBeNull();
    expect(finishedFigure()).toHaveTextContent("9");
  });

  it("All-time stays All-time when a stale dated read settles late", async () => {
    const { pending } = renderWithDeferredLoads();
    await act(async () => { pending[0].resolve(reportWithDone(6)); });
    await waitFor(() => expect(windowBanner()).toHaveTextContent("All time"));
    fireEvent.click(screen.getByRole("button", { name: "This year" }));
    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    // The All-time read settles; the stale dated read settles LAST.
    await act(async () => { pending[2].resolve(reportWithDone(6)); });
    await act(async () => { pending[1].resolve(reportWithDone(7, { from: "2026-01-01", to: null })); });
    expect(windowBanner()).toHaveTextContent("All time");
    expect(finishedFigure()).toHaveTextContent("6");
  });

  it("paints the report under StrictMode's mount/unmount/remount effect pass", async () => {
    const onLoadReport = vi.fn(async () => reportWithDone(6));
    render(<StrictMode><TasksReport t={t} lang="en" chapterName="Harborview Care United" onLoadReport={onLoadReport} /></StrictMode>);
    await waitFor(() => expect(windowBanner()).toHaveTextContent("All time"));
    expect(finishedFigure()).toHaveTextContent("6");
  });

  it.each(["resolve", "reject"])("does not attempt state writes after unmount when a read %s settles", async outcome => {
    const { pending, view } = renderWithDeferredLoads();
    expect(pending).toHaveLength(1);
    view.unmount();
    // React silently discards unmounted writes. Observe setter attempts while
    // forwarding to real React, rather than relying on its console warnings.
    stateWrites.calls = [];
    stateWrites.active = true;
    try {
      await act(async () => {
        if (outcome === "resolve") pending[0].resolve(reportWithDone(6));
        else pending[0].reject(new Error("late report failure"));
      });
      expect(stateWrites.calls).toEqual([]);
    } finally {
      stateWrites.active = false;
    }
  });
});

// FIX-UG-PAGE-TASKS-REPORT-20260910: /m/tasks/report failed the browser
// campaign with PR1815_UNEXPECTED_WRITE_OR_MISSING_BACKEND at 390 in both
// themes. The page's mount is the one call above, and the runner refused it
// because chapter_task_report was missing from the reviewed read inventory --
// so the two halves of the code, "no write on mount" and "at least one
// allowlisted backend read", are asserted here against the real data path
// (src/lib/memberApi.js) and the runner's own classifier, not a restatement
// of either.
describe("the report view reaches the backend only through its one read", () => {
  // chapter_task_report is a STABLE read; anything else the view issued would
  // be a request outside the reviewed read inventory.
  const READ_RPC_NAMES = ["chapter_task_report"];
  const classify = (name) => (READ_RPC_NAMES.includes(name) ? "read" : "block");

  function recordingClient() {
    const calls = [];
    return [calls, { rpc: async (name, args) => { calls.push({ name, args }); return { data: structuredClone(REPORT), error: null }; } }];
  }

  it("mounts on exactly one backend call, and it is the read", async () => {
    const [calls, client] = recordingClient();
    renderReport({ onLoadReport: (from, to) => loadChapterTaskReport(client, from, to) });
    await screen.findByText("All time");
    expect(calls).toEqual([{ name: "chapter_task_report", args: { p_from: null, p_to: null } }]);
    expect(calls.map((call) => classify(call.name, call.args))).toEqual(["read"]);
  });

  it("keeps the window control and the export read-only as well", async () => {
    const [calls, client] = recordingClient();
    renderReport({ onLoadReport: (from, to) => loadChapterTaskReport(client, from, to) });
    await screen.findByText("All time");
    fireEvent.click(screen.getByRole("button", { name: "This year" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    // The CSV is built from the report already in hand; exporting reaches the
    // backend for nothing, and certainly writes nothing.
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: revoke }));
    try {
      fireEvent.click(screen.getByRole("button", { name: /Download this report/ }));
    } finally { vi.unstubAllGlobals(); }
    expect(revoke).toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => classify(call.name, call.args) === "read")).toBe(true);
    expect(calls.every((call) => call.name === "chapter_task_report")).toBe(true);
  });
});

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsvRows(csv) {
  return csv.split("\r\n").map(parseCsvLine);
}

function cellByHeader(rows, section, name, column) {
  const header = rows.find((row) => row[0] === "section");
  expect(header, "CSV header row").toBeDefined();
  const columnAt = header.indexOf(column);
  expect(columnAt, `header ${column}`).toBeGreaterThan(-1);
  const sectionAt = header.indexOf("section");
  const nameAt = header.indexOf("name");
  const data = rows.find((row) => row[sectionAt] === section && row[nameAt] === name);
  expect(data, `${section}/${name}`).toBeDefined();
  return data[columnAt];
}

describe("the CSV export", () => {
  it("carries counts only, and names its chapter, window and generation time", () => {
    const csv = buildReportCsv(REPORT, "Harborview Care United");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("chapter,Harborview Care United");
    expect(lines[1]).toBe("from,2000-01-01");
    expect(lines[2]).toBe("to,2026-07-28");
    expect(lines[3]).toBe("generated,2026-07-28T12:00:00Z");
    const rows = parseCsvRows(csv);
    expect(cellByHeader(rows, "totals", "all", "total")).toBe("10");
    expect(cellByHeader(rows, "totals", "all", "done")).toBe("6");
    expect(cellByHeader(rows, "totals", "all", "done_late")).toBe("2");
    expect(cellByHeader(rows, "removed", "", "total")).toBe("3");
    expect(cellByHeader(rows, "removed", "", "done")).toBe("");
    expect(cellByHeader(rows, "byMonth", "2026-07", "done")).toBe("4");
    expect(cellByHeader(rows, "byMonth", "2026-07", "total")).toBe("");
    expect(cellByHeader(rows, "byWorkstream", "Chapter", "total")).toBe("6");
    expect(cellByHeader(rows, "byWorkstream", "Chapter", "done")).toBe("4");
    expect(cellByHeader(rows, "byWorkstream", "Chapter", "blocked")).toBe("1");
    expect(cellByHeader(rows, "byPerson", "Priya Shah", "total")).toBe("5");
    expect(cellByHeader(rows, "byPerson", "Priya Shah", "done")).toBe("4");
    expect(cellByHeader(rows, "byPerson", "Priya Shah", "overdue")).toBe("1");
    // Counts only: no column exists for titles, descriptions or messages, and
    // nothing but the aggregate names above appears in the export.
    expect(csv).not.toMatch(/title|description|message|body/i);
  });

  it("prints each measure under the header that names it", () => {
    const distinct = structuredClone(REPORT);
    distinct.totals.done_late = 5;
    distinct.byWorkstream = [{ name: "Contract Enforcement", total: 12, done: 7, blocked: 3 }];
    distinct.byPerson = [{ name: "Priya Shah", total: 5, done: 4, overdue: 0 }];
    const rows = parseCsvRows(buildReportCsv(distinct, "Harborview Care United"));
    expect(cellByHeader(rows, "totals", "all", "done_late")).toBe("5");
    expect(cellByHeader(rows, "totals", "all", "blocked")).toBe("");
    expect(cellByHeader(rows, "totals", "all", "overdue")).toBe("");
    expect(cellByHeader(rows, "byWorkstream", "Contract Enforcement", "blocked")).toBe("3");
    expect(cellByHeader(rows, "byWorkstream", "Contract Enforcement", "done_late")).toBe("");
    expect(cellByHeader(rows, "byWorkstream", "Contract Enforcement", "overdue")).toBe("");
    expect(cellByHeader(rows, "byPerson", "Priya Shah", "overdue")).toBe("0");
    expect(cellByHeader(rows, "byPerson", "Priya Shah", "done_late")).toBe("");
    expect(cellByHeader(rows, "byPerson", "Priya Shah", "blocked")).toBe("");
    const header = rows.find((row) => row[0] === "section");
    expect(header).not.toContain("late_or_overdue");
  });

  it("escapes a workstream name that would break a row", () => {
    const tricky = structuredClone(REPORT);
    tricky.byWorkstream = [{ name: 'Contract "2026", phase 1', total: 1, done: 1, blocked: 0 }];
    const csv = buildReportCsv(tricky, "Harborview Care United");
    const rows = parseCsvRows(csv);
    expect(cellByHeader(rows, "byWorkstream", 'Contract "2026", phase 1', "name")).toBe('Contract "2026", phase 1');
    expect(cellByHeader(rows, "byWorkstream", 'Contract "2026", phase 1', "total")).toBe("1");
    expect(cellByHeader(rows, "byWorkstream", 'Contract "2026", phase 1', "done")).toBe("1");
    expect(cellByHeader(rows, "byWorkstream", 'Contract "2026", phase 1', "blocked")).toBe("0");
    expect(csv).toContain('"Contract ""2026"", phase 1"');
  });
});

// SEC-UG-TASKS-REPORT-CSV-FORMULA-INJECTION-20260920: every text cell
// goes through the shared spreadsheet-text guard before RFC 4180 quoting.
function parseReportCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function reportCsvNameCell(csv, section, namePrefix) {
  const line = csv.split("\r\n").find((row) => row.startsWith(`${section},`));
  expect(line, `${section} row`).toBeDefined();
  const cells = parseReportCsvLine(line);
  expect(cells[1].startsWith(namePrefix) || cells[1] === namePrefix, `${section} name ${cells[1]}`).toBe(true);
  return cells[1];
}

describe("the CSV export spreadsheet-text guard", () => {
  it("prefixes a workstream name that would start a spreadsheet formula", () => {
    const tricky = structuredClone(REPORT);
    tricky.byWorkstream = [{ name: "=1+1", total: 1, done: 1, blocked: 0 }];
    const csv = buildReportCsv(tricky, "Harborview Care United");
    expect(csv).toContain("'=1+1");
    expect(csv).not.toContain(",=1+1,");
    expect(reportCsvNameCell(csv, "byWorkstream", "'=1+1")).toBe("'=1+1");
  });

  it("prefixes person names and leading whitespace the same way", () => {
    const atSign = structuredClone(REPORT);
    atSign.byPerson = [{ name: "@payroll", total: 1, done: 1, overdue: 0 }];
    expect(buildReportCsv(atSign, "Harborview Care United")).toContain("'@payroll");
    expect(buildReportCsv(atSign, "Harborview Care United")).not.toContain(",@payroll,");

    const plus = structuredClone(REPORT);
    plus.byWorkstream = [{ name: "+overtime", total: 1, done: 1, blocked: 0 }];
    expect(buildReportCsv(plus, "Harborview Care United")).toContain("'+overtime");
    expect(buildReportCsv(plus, "Harborview Care United")).not.toContain(",+overtime,");

    const minus = structuredClone(REPORT);
    minus.byPerson = [{ name: "-lead", total: 1, done: 1, overdue: 0 }];
    expect(buildReportCsv(minus, "Harborview Care United")).toContain("'-lead");
    expect(buildReportCsv(minus, "Harborview Care United")).not.toContain(",-lead,");

    const spaced = structuredClone(REPORT);
    spaced.byWorkstream = [{ name: " =1+1", total: 1, done: 1, blocked: 0 }];
    expect(reportCsvNameCell(buildReportCsv(spaced, "Harborview Care United"), "byWorkstream", "' =1+1")).toBe("' =1+1");
  });

  it("prefixes the chapter name too", () => {
    const csv = buildReportCsv(REPORT, "=cmd");
    expect(csv.split("\r\n")[0]).toBe("chapter,'=cmd");
    expect(csv).not.toContain("chapter,=cmd");
  });

  it("keeps the guard inside RFC 4180 quotes when the value also needs quoting", () => {
    const tricky = structuredClone(REPORT);
    tricky.byWorkstream = [{ name: '=1+1,"x', total: 1, done: 1, blocked: 0 }];
    const csv = buildReportCsv(tricky, "Harborview Care United");
    expect(csv).toContain(`"'=1+1,""x"`);
    const line = csv.split("\r\n").find((row) => row.startsWith("byWorkstream,"));
    const cells = parseReportCsvLine(line);
    expect(cells[1]).toBe(`'=1+1,"x`);
    expect(cells[2]).toBe("1");
  });

  it("leaves counts and ISO dates byte-identical", () => {
    const csv = buildReportCsv(REPORT, "Harborview Care United");
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("from,2000-01-01");
    expect(lines[2]).toBe("to,2026-07-28");
    expect(lines[3]).toBe("generated,2026-07-28T12:00:00Z");
    const totals = lines.find((line) => line.startsWith("totals,"));
    expect(totals).toMatch(/^totals,all,10,6,2/);
    expect(totals).not.toMatch(/'/);
    const workstream = lines.find((line) => line.startsWith("byWorkstream,Chapter,"));
    expect(workstream).toMatch(/^byWorkstream,Chapter,6,4,/);
    expect(workstream).not.toMatch(/'/);
    const person = lines.find((line) => line.startsWith("byPerson,Priya Shah,"));
    expect(person).toMatch(/^byPerson,Priya Shah,5,4,/);
    expect(person).not.toMatch(/'/);
  });
});

// #9462 (W6-16): a Custom range whose From is after its To was sent to the
// server, refused ("report range is inverted", 22023) and shown as "The report
// could not be loaded. Try again."; a refusal for the account read the same.
describe("the report view names what it can know about a failed report", () => {
  const RANGE = "The From date must be on or before the To date.";
  async function openCustom(props) {
    await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
  }

  it("says From must be on or before To beside the fields and does not ask for the report", async () => {
    const props = renderReport();
    await openCustom(props);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-06-30" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(RANGE);
    expect(alert.closest("form")).toBe(screen.getByLabelText("From").closest("form"));
    expect(screen.getByLabelText("From")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("From")).toHaveAttribute("aria-describedby", alert.id);
    expect(screen.queryByText("The report could not be loaded. Try again.")).not.toBeInTheDocument();
    expect(props.onLoadReport).toHaveBeenCalledTimes(1);
    // Fixing either date clears the line, and the report is asked for.
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-07-01" } });
    expect(screen.queryByText(RANGE)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await waitFor(() => expect(props.onLoadReport).toHaveBeenLastCalledWith("2026-06-30", "2026-07-01"));
  });

  it("decides only a range with both dates; an empty To is left to the server", () => {
    expect(customRangeInverted({ from: "2026-06-02", to: "2026-06-01" })).toBe(true);
    expect(customRangeInverted({ from: "2999-01-01", to: "" })).toBe(false);
    expect(customRangeInverted({ from: "", to: "2026-01-01" })).toBe(false);
    expect(customRangeInverted({ from: "2026-06-01", to: "2026-06-01" })).toBe(false);
  });

  it("asks the server for a From date with an empty To, whatever the person's own day is", async () => {
    const props = renderReport();
    await openCustom(props);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2999-01-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    await waitFor(() => expect(props.onLoadReport).toHaveBeenLastCalledWith("2999-01-01", null));
    expect(screen.queryByText(RANGE)).not.toBeInTheDocument();
  });

  it("clears the range line when a preset is chosen and when another report is asked for", async () => {
    const props = renderReport();
    await openCustom(props);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-06-30" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByText(RANGE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "This year" }));
    expect(screen.queryByText(RANGE)).not.toBeInTheDocument();
    await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(2));
    // Back on Custom, the inverted pair is still typed; the line returns only on Run report.
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.queryByText(RANGE)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByText(RANGE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(RANGE)).not.toBeInTheDocument();
  });

  it("says the range when the server refuses it as inverted", async () => {
    const props = renderReport({ onLoadReport: vi.fn(async (from) => {
      if (from) throw new MemberApiError("Load report", { code: "22023", message: "report range is inverted" });
      return structuredClone(REPORT);
    }) });
    await openCustom(props);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Run report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(RANGE);
    // #9699 second read (P2): editing a date clears the server's range answer too.
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-05-01" } });
    expect(screen.queryByText(RANGE)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("compares the two dates as dates, so a five-digit year is after 9999", () => {
    // #9699 second read (P3): as strings "10000-01-01" sorts before "9999-12-31".
    expect(customRangeInverted({ from: "9999-12-31", to: "10000-01-01" })).toBe(false);
    expect(customRangeInverted({ from: "10000-01-01", to: "9999-12-31" })).toBe(true);
  });

  it("says the account cannot open the report when the server refuses it (42501)", async () => {
    renderReport({ onLoadReport: vi.fn(async () => { throw new MemberApiError("Load report", { code: "42501", message: "staff role required" }); }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("This account can't open the campaign work report.");
  });

  // #9699 second read (P1): chapter_task_report raises 42501 "authentication
  // required" for no user AND for a signed-in session whose second step is not
  // met, so the line never says the session ended.
  it("asks a signed-in person refused 42501 authentication required to sign in again and finish the second step", async () => {
    renderReport({ onLoadReport: vi.fn(async () => { throw new MemberApiError("Load report", { code: "42501", message: "authentication required" }); }) });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The report could not be loaded. Sign in again, and complete the second step if it asks, then run the report.");
    expect(alert).not.toHaveTextContent(/signed out/i);
    expect(alert).not.toHaveTextContent("This account can't open the campaign work report.");
    expect(translate("es", "tasks.reportSignIn")).toBe("No se pudo cargar el informe. Vuelve a iniciar sesión y completa el segundo paso si te lo pide; luego genera el informe.");
  });

  it("keeps the plain line for a failure it cannot name", async () => {
    renderReport({ onLoadReport: vi.fn(async () => { throw new MemberApiError("Load report", { code: "", message: "TypeError: Failed to fetch" }); }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("The report could not be loaded. Try again.");
  });

  it("says both in Spanish", async () => {
    const es = (key, vars) => translate("es", key, vars);
    const props = renderReport({ t: es, lang: "es" });
    await waitFor(() => expect(props.onLoadReport).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: es("tasks.reportCustom") }));
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-06-30" } });
    fireEvent.change(screen.getByLabelText("Hasta"), { target: { value: "2026-06-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Generar informe" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("La fecha Desde debe ser igual o anterior a la fecha Hasta.");
    expect(es("tasks.reportNotPermitted")).toBe("Esta cuenta no puede abrir el informe de trabajo de la campaña.");
  });
});
