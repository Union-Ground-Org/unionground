import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { csvEscape } from "../lib/caseExport.js";
import { addEasternDays, easternDay } from "../lib/easternTime.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { localeFor } from "../lib/i18n.js";
import { ArrivalCount, ChartArrival, arriveAt } from "../components/ChartArrival.jsx";

// The staff report: all-time numbers without an all-time read. ONE
// chapter_task_report(from, to) RPC call returns one JSON row of aggregates —
// the phone never carries the task table to count it, and the report never
// joins the app-load path. Deliberately a different KIND of number than the
// Progress view, and the copy says so: Progress is "the last 60 days — what
// is moving right now"; this is "{from} to {to} — what finished, and how long
// it took".

const WINDOW_IDS = ["all", "year", "quarter", "custom"];

// The presets count the Eastern year and quarter, the same day the server's
// default end uses (private.eastern_day), whatever zone the device is in. A
// device-local year would start "This year" on January 1 of a year Eastern
// time has not reached, and the range would arrive inverted.
// Exported for direct tests.
export function windowBounds(windowKey, custom, now = new Date()) {
  if (windowKey === "year") {
    return [`${easternDay(now).slice(0, 4)}-01-01`, null];
  }
  if (windowKey === "quarter") {
    const today = easternDay(now);
    const year = Number(today.slice(0, 4));
    const quarterMonth = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3;
    const previousMonth = quarterMonth === 0 ? 9 : quarterMonth - 3;
    const previousYear = quarterMonth === 0 ? year - 1 : year;
    const monthStart = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}-01`;
    return [monthStart(previousYear, previousMonth), addEasternDays(monthStart(year, quarterMonth), -1)];
  }
  if (windowKey === "custom") return [custom.from || null, custom.to || null];
  return [null, null];
}

// #9462 (W6-16): the server refuses a range whose start is after its end
// ("report range is inverted"). Checked here, when both dates are set, so the
// page says so before asking. An empty end is the server's to fill, so a start
// after that day is left to the server's answer, never decided here.
// Exported for direct tests.
export function customRangeInverted(custom) {
  if (!custom.from || !custom.to) return false;
  return dayOrdinal(custom.to) < dayOrdinal(custom.from);
}

// A date input's value as one comparable number, year first, so a five-digit
// year sorts after 9999 (the strings would not).
function dayOrdinal(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return (year * 100 + month) * 100 + day;
}

// What a failed report read can actually say. The RPC's 42501 "authentication
// required" means no signed-in user reached it OR the second step is not met,
// so it asks to sign in again and finish the second step, never claiming the
// session ended; its other 42501s refuse this account (not staff, no chapter,
// a private organization); 22023 "report range is inverted" is the range.
// Anything else stays the plain could-not-load line.
function reportFailureKey(error) {
  const message = String(error?.message ?? "");
  if (error?.code === "42501" && /authentication required/i.test(message)) return "tasks.reportSignIn";
  if (error?.code === "42501") return "tasks.reportNotPermitted";
  if (error?.code === "22023" && /report range is inverted/i.test(message)) return "tasks.reportRangeInverted";
  return "tasks.reportError";
}

function formatDay(value, lang) {
  if (!value) return "";
  return new Intl.DateTimeFormat(localeFor(lang), { year: "numeric", month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function csvCell(value) {
  return csvEscape(value);
}

// One header per exported measure. totals writes done_late, byWorkstream
// writes blocked, byPerson writes overdue; a section that has no value for
// a named measure leaves that cell empty rather than reusing the name.
const REPORT_CSV_COLUMNS = ["section", "name", "total", "done", "done_late", "blocked", "overdue"];

function reportCsvRow(cells) {
  return REPORT_CSV_COLUMNS.map((key) => cells[key] ?? "");
}

// COUNTS ONLY, by design (Account Lifecycle precedent): the export names its
// window, generation time and chapter, and carries no task titles, no
// descriptions, and nothing from the private task conversations. A steward
// who needs the detail has the board. Exported for direct tests.
export function buildReportCsv(report, chapterName) {
  const totals = report.totals || {};
  const rows = [
    ["chapter", chapterName],
    ["from", report.from || ""],
    ["to", report.to || ""],
    ["generated", report.generatedAt || ""],
    [],
    REPORT_CSV_COLUMNS,
    reportCsvRow({
      section: "totals",
      name: "all",
      total: totals.total ?? 0,
      done: totals.done ?? 0,
      done_late: totals.done_late ?? 0,
    }),
    reportCsvRow({
      section: "removed",
      name: "",
      total: report.deletedCount ?? 0,
    }),
    ...(report.byMonth || []).map((row) => reportCsvRow({
      section: "byMonth",
      name: row.month,
      done: row.done,
    })),
    ...(report.byWorkstream || []).map((row) => reportCsvRow({
      section: "byWorkstream",
      name: row.name,
      total: row.total,
      done: row.done,
      blocked: row.blocked,
    })),
    ...(report.byPerson || []).map((row) => reportCsvRow({
      section: "byPerson",
      name: row.name,
      total: row.total,
      done: row.done,
      overdue: row.overdue,
    })),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function TasksReport({ t, lang, chapterName, onLoadReport }) {
  const [windowKey, setWindowKey] = useDeviceParityState("tasks.report.windowKey", "all");
  const [custom, setCustom] = useDeviceParityState("tasks.report.custom", { from: "", to: "" });
  // The payload settles with the window it was requested for, so the banner
  // and the figures can never disagree — including All-time painted over a
  // stale non-all-time read that finished late. `from`/`to` are the REQUESTED
  // bounds: a null start is unbounded, and the RPC fills it with a 2000-01-01
  // sentinel the banner must never print.
  const [report, setReport] = useState(null); // { windowKey, from, to, data }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Shown beside the From and To fields; the report is not asked for.
  const [rangeInverted, setRangeInverted] = useState(false);
  // Two window chips can be pressed before either read settles. A monotonic
  // token makes every abandoned read a no-op: it can neither clear loading,
  // nor overwrite a newer report, nor raise the failure card over a report
  // that already arrived.
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (key, customBounds) => {
    if (!onLoadReport) {
      setError(t("tasks.reportError"));
      return;
    }
    const [from, to] = windowBounds(key, customBounds);
    const token = ++requestRef.current;
    setLoading(true);
    setError("");
    setRangeInverted(false);
    try {
      const data = await onLoadReport(from, to);
      if (!mountedRef.current || token !== requestRef.current) return;
      setReport({ windowKey: key, from, to, data });
    } catch (failure) {
      if (!mountedRef.current || token !== requestRef.current) return;
      setError(t(reportFailureKey(failure)));
    } finally {
      if (mountedRef.current && token === requestRef.current) setLoading(false);
    }
  }, [onLoadReport, t]);

  // Mount-once by ref guard: the parent hands a fresh callback identity on
  // every App re-render (a toast expiring is enough), and a dependency-driven
  // re-run would silently reset a windowed report to All-time while the
  // window chip stayed pressed.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    // On demand means when the view is OPENED — never on app load.
    load("all", { from: "", to: "" });
  }, [load]);

  function pickWindow(key) {
    setWindowKey(key);
    setRangeInverted(false);
    if (key !== "custom") load(key, custom);
  }

  function download() {
    if (!report) return;
    const csv = buildReportCsv(report.data, chapterName);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "chapter-work-report.csv";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  const data = report?.data || null;
  const totals = data?.totals || {};
  const finished = totals.done ?? 0;
  const monthMax = Math.max(1, ...(data?.byMonth || []).map((row) => row.done));
  // The banner names the window the SETTLED payload belongs to — the chip
  // that launched a since-abandoned read may already be un-pressed.
  const unboundedStart = report ? report.from == null : false;
  const windowLabel = !report
    ? ""
    : unboundedStart
      ? (report.to == null
        ? t("tasks.reportAllTime")
        : t("tasks.reportThrough", { to: formatDay(data.to, lang) }))
      : t("tasks.reportWindow", { from: formatDay(data.from, lang), to: formatDay(data.to, lang) });

  return (
    <section className="tasks-report" aria-label={t("tasks.view.report")}>
      <div className="tasks-report__controls" role="group" aria-label={t("tasks.view.report")}>
        {WINDOW_IDS.map((key) => (
          <button className="task-owned"
            key={key}
            type="button"
            aria-pressed={windowKey === key}
            aria-busy={loading && windowKey === key ? true : undefined}
            onClick={() => pickWindow(key)}
          >
            {t(`tasks.report${key === "all" ? "AllTime" : key === "year" ? "ThisYear" : key === "quarter" ? "LastQuarter" : "Custom"}`)}
          </button>
        ))}
      </div>
      {windowKey === "custom" && (
        <form
          className="tasks-report__custom"
          onSubmit={(event) => {
            event.preventDefault();
            if (customRangeInverted(custom)) { setRangeInverted(true); return; }
            load("custom", custom);
          }}
        >
          <label className="task-owned">{t("tasks.reportFrom")}<input className="task-owned" type="date" value={custom.from} aria-invalid={rangeInverted || undefined} aria-describedby={rangeInverted ? "tasks-report-range-error" : undefined} onChange={(event) => { setRangeInverted(false); setError(""); setCustom((current) => ({ ...current, from: event.target.value })); }} /></label>
          <label className="task-owned">{t("tasks.reportTo")}<input className="task-owned" type="date" value={custom.to} aria-invalid={rangeInverted || undefined} aria-describedby={rangeInverted ? "tasks-report-range-error" : undefined} onChange={(event) => { setRangeInverted(false); setError(""); setCustom((current) => ({ ...current, to: event.target.value })); }} /></label>
          <button type="submit" className="dialog-primary">{t("tasks.reportApply")}</button>
          {rangeInverted && <p id="tasks-report-range-error" className="tasks-error" role="alert">{t("tasks.reportRangeInverted")}</p>}
        </form>
      )}

      {loading && <p className="tasks-report__note" role="status">{t("tasks.reportLoading")}</p>}
      {error && <p className="tasks-error" role="alert">{error}</p>}

      {report && !loading && !error && (
        <>
          {/* A report with an unnamed window is worthless six months later. */}
          <p className="tasks-report__window">{windowLabel}</p>

          <div className="tasks-summary" aria-label={t("tasks.view.report")}>
            <article className="tasks-summary__metric"><strong className="task-owned">{finished}</strong><span className="task-owned">{t("tasks.reportFinished")}</span></article>
            <article className="tasks-summary__metric"><strong className="task-owned">{totals.open ?? 0}</strong><span className="task-owned">{t("tasks.reportOpen")}</span></article>
            <article className="tasks-summary__metric"><strong className="task-owned">{totals.done_late ?? 0}</strong><span className="task-owned">{t("tasks.reportLate")}</span></article>
            <article className="tasks-summary__metric">
              {/* A median of two numbers is not a statistic, and someone will
                  quote it in a meeting — suppressed under five finished. */}
              {finished >= 5 && totals.median_days_to_done != null
                ? <strong className="task-owned">{Math.round(Number(totals.median_days_to_done) * 10) / 10}</strong>
                : <strong className="tasks-report__thin task-owned">{t("tasks.reportThin")}</strong>}
              <span className="task-owned">{t("tasks.reportMedian")}</span>
            </article>
          </div>

          {finished === 0 ? (
            <div className="tasks-empty">
              <p>{unboundedStart
                ? t("tasks.reportEmptyThrough", { to: formatDay(data.to, lang) })
                : t("tasks.reportEmpty", { from: formatDay(data.from, lang), to: formatDay(data.to, lang) })}</p>
            </div>
          ) : (
            <ChartArrival as="section" name="tasks:report:month" className="tasks-breakdown">
              <header><h3>{t("tasks.reportByMonth")}</h3><span>{t("tasks.reportFinished")}</span></header>
              {(data.byMonth || []).map((row, index) => (
                <div className="tasks-breakdown__row" key={row.month}>
                  <span><strong>{row.month}</strong></span>
                  <i role="progressbar" aria-label={row.month} aria-valuemin={0} aria-valuemax={monthMax} aria-valuenow={row.done}><span className="arrive-meter" style={arriveAt(index, { width: `${Math.round((row.done / monthMax) * 100)}%` })} /></i>
                  <b><ArrivalCount value={row.done} index={index} /></b>
                </div>
              ))}
            </ChartArrival>
          )}

          <ChartArrival as="section" name="tasks:report:workstream" className="tasks-breakdown">
            <header><h3>{t("tasks.byWorkstream")}</h3><span>{t("tasks.reportFinished")}</span></header>
            {(data.byWorkstream || []).map((row, index) => (
              <div className="tasks-breakdown__row" key={row.name}>
                <span><strong>{row.name}</strong><small>{row.done}/{row.total} {t("tasks.complete")}</small></span>
                <i role="progressbar" aria-label={row.name} aria-valuemin={0} aria-valuemax={row.total} aria-valuenow={row.done}><span className="arrive-meter" style={arriveAt(index, { width: `${row.total ? Math.round((row.done / row.total) * 100) : 0}%` })} /></i>
                <b><ArrivalCount value={row.done} index={index} /></b>
              </div>
            ))}
          </ChartArrival>

          <section className="tasks-breakdown">
            {/* Grouped on assignee_name server-side: someone who has since
                left the chapter still did the work; "—" is unassigned. */}
            <header><h3>{t("tasks.reportByPerson")}</h3><span>{t("tasks.reportFinished")}</span></header>
            {(data.byPerson || []).map((row) => (
              <div className="tasks-breakdown__row tasks-breakdown__row--person" key={row.name}>
                <span className="tasks-person"><i>{row.name.slice(0, 2).toUpperCase()}</i><span><strong>{row.name}</strong><small>{row.done}/{row.total} {t("tasks.complete")}</small></span></span>
                <b>{row.done}</b>
              </div>
            ))}
          </section>

          {/* Removed work is counted, not hidden: a total that looks too small
              gets a visible explanation rather than reading as data loss. */}
          <p className="tasks-report__note">{t("tasks.reportRemoved", { count: data.deletedCount ?? 0 })}</p>

          <div className="tasks-report__export">
            <button type="button" className="dialog-primary" onClick={download}>
              <Download size={16} /> {t("tasks.reportExport")}
            </button>
            <p className="tasks-report__note">{t("tasks.reportExportNote")}</p>
          </div>
        </>
      )}
    </section>
  );
}
