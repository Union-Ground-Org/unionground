import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import { useWorkspace, workspaceHref } from "./WorkspacePages.jsx";
import { DEFAULT_DEADLINE_LOOKAHEAD, MAX_DEADLINE_LOOKAHEAD } from "../lib/configurableThresholds.js";

// Case dashboards — three server-computed tiles, one component, two planes.
// The open-by-step and median-days-per-step tiles and the ULP deadline list
// are left out: Union Ground issues have no grievance procedure and no
// legal filing deadline (owner decision, 2026-10-13).
//
// The shadcn/ui chart PATTERN, without the charting engine. The pattern is the
// part that matters here: one ChartContainer owns the frame, the caption, the
// CSS-variable series colour and the accessible data table, and the individual
// marks are its children. What is NOT adopted is Recharts, and that is a
// measurement rather than a preference. config/web-performance-budgets.json
// caps dist/assets at 4,400,000 raw and 1,150,000 gzip bytes of JavaScript and
// CSS. This branch builds at 4,327,016 raw / 1,142,147 gzip — 72,984 raw and
// 7,853 gzip bytes of headroom. A probe build of these same five tiles against
// recharts@3.10.1 (BarChart, LineChart, ResponsiveContainer, axes, grid and
// tooltip) measured 4,711,103 raw / 1,253,480 gzip: 311,103 raw and 103,480
// gzip bytes OVER the ceiling, so `npm run perf:web` cannot pass with it in the
// tree. Lazy loading does not help — the budget weighs every emitted asset, not
// the entry graph. Adopting Recharts therefore needs a reviewed budget change
// first; it is registered in .lane/FINDINGS.md rather than forced in here.
//
// The marks below are HTML boxes and one small SVG, and the whole tab is a
// 9,354 raw / 2,942 gzip byte lazy chunk. The series colours are audited tokens
// (--case-chart-1..5 in src/styles.css, measured in scripts/contrast-audit.mjs
// against --card in every theme scope including the dark night-shift one).
//
// Every tile is a deep link into the filtered case list, using the query
// parameter names lane 5.2's list reads: ?deadline=overdue|7d, ?assignee=. The path itself is the caller's, because the coordinator's list
// and the steward's caseload are different pages of the same data.

// Only the issue deadline kinds Union Ground offers (no legal filing,
// hearing or appeal deadline); any other kind reads as the generic "kind".
const KIND_KEYS = {
  response: "caseDash.kindResponse",
  follow_up: "caseDash.kindFollowUp",
};

const ROLE_KEYS = {
  steward: "caseDash.roleSteward",
  coordinator: "caseDash.roleCoordinator",
  unassigned: "caseDash.roleUnassigned",
};

function dayLabel(daysOut, t) {
  if (daysOut <= 0) return t("caseDash.dueToday");
  if (daysOut === 1) return t("caseDash.dueTomorrow");
  return t("caseDash.dueInDays", { count: daysOut });
}

function linkTo(basePath, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return workspaceHref(query ? `${basePath}?${query}` : basePath);
}

/**
 * Tiles are real links — a middle click, a Cmd-click and a copied address all
 * have to keep working — but a plain left click must stay inside the app. The
 * workspace router's own delegated handler only claims hash links, so every
 * tile carries the same explicit modifier-aware handler the other in-app
 * anchors use.
 */
function useTileNavigation() {
  const workspace = useWorkspace();
  return useCallback((event, href) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!workspace?.open) return;
    event.preventDefault();
    workspace.open(href);
  }, [workspace]);
}

/**
 * The chart frame: heading, caption, the marks, and the data table every chart
 * owes a screen-reader or a keyboard user who cannot read a bar.
 *
 * The table is rendered always and hidden visually, so it is in the
 * accessibility tree whether or not the toggle has been pressed; the toggle
 * un-hides it on screen for anyone who would rather read the numbers. A table
 * that only exists after a click is a table an assistive technology cannot find.
 */
function ChartContainer({ title, description, total, columns, rows, empty, children }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const tableId = useId();
  return (
    <figure className="cdash-chart" aria-labelledby={headingId}>
      <figcaption className="cdash-chart__cap">
        <h3 className="cdash-chart__title" id={headingId}>{title}</h3>
        <p className="cdash-chart__sub">{description}</p>
        {total ? <p className="cdash-chart__total">{total}</p> : null}
      </figcaption>
      {rows.length === 0
        ? <p className="cdash-chart__empty">{empty}</p>
        : <div className="cdash-chart__plot">{children}</div>}
      {rows.length > 0 && <button
        type="button"
        className="cdash-chart__toggle"
        aria-expanded={open}
        aria-controls={tableId}
        onClick={() => setOpen((current) => !current)}
      >
        {t(open ? "caseDash.hideTable" : "caseDash.showTable")}
      </button>}
      <div id={tableId} hidden={rows.length === 0} className={open ? "cdash-chart__data" : "cdash-chart__data visually-hidden"}>
        <table>
          <caption>{t("caseDash.tableFor", { title })}</caption>
          <thead>
            <tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {row.cells.map((cell, index) => index === 0
                  ? <th key={row.key} scope="row">{cell}</th>
                  : <td key={`${row.key}-${index}`}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** Horizontal bars. Each bar is the link to the cases it counts. */
function BarChart({ rows, series }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const navigate = useTileNavigation();
  return (
    <ul className="cdash-bars" style={{ "--cdash-series": `var(--case-chart-${series})` }}>
      {rows.map((row) => (
        <li key={row.key} className="cdash-bars__row">
          <a className="cdash-bars__link" href={row.href} aria-label={row.label} onClick={(event) => navigate(event, row.href)}>
            <span className="cdash-bars__name">{row.name}</span>
            <span className="cdash-bars__track">
              <span className="cdash-bars__fill" style={{ width: `${Math.max(2, Math.round((row.value / max) * 100))}%` }} />
            </span>
            <strong className="cdash-bars__value">{row.display}</strong>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Seven vertical columns, one per day of the window. */
function ColumnChart({ rows, series, href, linkLabel }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const navigate = useTileNavigation();
  return (
    <a className="cdash-columns" href={href} aria-label={linkLabel} onClick={(event) => navigate(event, href)} style={{ "--cdash-series": `var(--case-chart-${series})` }}>
      {rows.map((row) => (
        <span key={row.key} className="cdash-columns__slot">
          <span className="cdash-columns__value">{row.value || ""}</span>
          <span className="cdash-columns__bar" data-empty={row.value === 0 ? "true" : undefined} style={{ height: `${row.value === 0 ? 2 : Math.max(6, Math.round((row.value / max) * 100))}%` }} />
          <span className="cdash-columns__label">{row.short}</span>
        </span>
      ))}
    </a>
  );
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + Number(row[field] || 0), 0);
}

// lookaheadDays is the organization's limits.casework.deadline_lookahead_days
// (REQ-UG-CONFIGURABLE-THRESHOLDS-20261001); the due-soon RPC reads the
// same setting server-side, so the chart draws exactly the window it counted.
export function CaseDashboards({ api, caseListPath, onNotice = null, lookaheadDays = DEFAULT_DEADLINE_LOOKAHEAD }) {
  const { lang, t } = useLang();
  const [state, setState] = useState({ loading: true, error: false, data: null });
  // A failed refresh keeps the last good aggregate on screen with an in-place
  // stale notice; only a failed first read gets the full refusal card.
  const loadedRef = useRef(false);
  const numbers = useMemo(() => new Intl.NumberFormat(localeFor(lang)), [lang]);
  const dates = useMemo(() => new Intl.DateTimeFormat(localeFor(lang), { dateStyle: "medium" }), [lang]);

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      setState({ loading: false, error: false, data: await api.loadCaseDashboards() });
      loadedRef.current = true;
    } catch {
      if (loadedRef.current) {
        setState((current) => ({ ...current, loading: false, error: true }));
        return;
      }
      setState({ loading: false, error: true, data: null });
      onNotice?.(t("caseDash.unavailable"));
    }
  }, [api, onNotice, t]);

  useEffect(() => { void load(); }, [load]);

  if (state.loading && !state.data) {
    return (
      <section className="cdash" aria-busy="true">
        <p className="cdash__status" role="status">{t("caseDash.loading")}</p>
      </section>
    );
  }
  if (!state.data) {
    return (
      <section className="cdash">
        <p className="cdash__status" role="alert">{t("caseDash.unavailable")}</p>
        <p className="cdash__status cdash__status--quiet">{t("caseDash.unavailableBody")}</p>
        <button type="button" className="outline-pill" onClick={load}>{t("app.tryAgain")}</button>
      </section>
    );
  }

  const { dueSoon, overdue, byAssignee } = state.data;

  // The lookahead window (seven days by default) always draws one slot per day,
  // including the empty ones: a chart that omits the quiet days makes two
  // different weeks look identical.
  const windowDays = Number.isInteger(lookaheadDays) && lookaheadDays >= 1 && lookaheadDays <= MAX_DEADLINE_LOOKAHEAD
    ? lookaheadDays : DEFAULT_DEADLINE_LOOKAHEAD;
  const dueByDay = Array.from({ length: windowDays }, (_, index) => {
    const row = dueSoon.find((entry) => entry.daysOut === index);
    return {
      key: `due-${index}`,
      value: row ? row.deadlineCount : 0,
      cases: row ? row.caseCount : 0,
      short: dayLabel(index, t),
    };
  });

  return (
    <section className="cdash role-section-target" id="case-dashboards" tabIndex="-1" aria-labelledby="case-dashboards-title">
      <header className="cdash__head">
        <div>
          <span className="cdash__eyebrow">{t("caseDash.eyebrow")}</span>
          <h2 id="case-dashboards-title">{t("caseDash.title")}</h2>
          <p className="cdash__sub">{t("caseDash.sub")}</p>
        </div>
        <button type="button" className="outline-pill" onClick={load} disabled={state.loading}>
          {state.loading ? t("caseDash.loading") : t("caseDash.refresh")}
        </button>
      </header>

      {state.error && <p className="cdash__status" role="alert">{t("caseDash.stale")}</p>}

      <div className="cdash__grid">
        <ChartContainer
          title={t("caseDash.dueTitle", { days: windowDays })}
          description={t("caseDash.dueSub", { days: windowDays })}
          total={t("caseDash.totalDeadlines", { count: numbers.format(sum(dueSoon, "deadlineCount")) })}
          columns={[t("caseDash.colWhen"), t("caseDash.colDeadlines"), t("caseDash.colCases")]}
          rows={dueByDay.map((row) => ({
            key: row.key,
            cells: [row.short, numbers.format(row.value), numbers.format(row.cases)],
          }))}
          empty={t("caseDash.empty")}
        >
          <ColumnChart
            series={2}
            rows={dueByDay}
            href={linkTo(caseListPath, { deadline: windowDays <= 7 ? "7d" : "30d" })}
            linkLabel={t(windowDays <= 7 ? "caseDash.openDue" : "caseDash.openDueMonth")}
          />
        </ChartContainer>

        <ChartContainer
          title={t("caseDash.overdueTitle")}
          description={t("caseDash.overdueSub")}
          total={t("caseDash.totalDeadlines", { count: numbers.format(sum(overdue, "deadlineCount")) })}
          columns={[t("caseDash.colKind"), t("caseDash.colDeadlines"), t("caseDash.colCases"), t("caseDash.colOldest")]}
          rows={overdue.map((row) => ({
            key: `overdue-${row.kind}`,
            // The aggregate returns the oldest missed due date per kind; the
            // table is where it is read, since a bar cannot carry a date.
            cells: [
              t(KIND_KEYS[row.kind] || "caseDash.colKind"),
              numbers.format(row.deadlineCount),
              numbers.format(row.caseCount),
              row.oldestDueAt ? dates.format(new Date(row.oldestDueAt)) : "",
            ],
          }))}
          empty={t("caseDash.empty")}
        >
          <BarChart
            series={4}
            rows={overdue.map((row) => ({
              key: `overdue-${row.kind}`,
              name: t(KIND_KEYS[row.kind] || "caseDash.colKind"),
              value: row.deadlineCount,
              display: numbers.format(row.deadlineCount),
              href: linkTo(caseListPath, { deadline: "overdue", kind: row.kind }),
              label: t("caseDash.openOverdue", { kind: t(KIND_KEYS[row.kind] || "caseDash.colKind") }),
            }))}
          />
        </ChartContainer>

        <ChartContainer
          title={t("caseDash.assigneeTitle")}
          description={t("caseDash.assigneeSub")}
          total={null}
          columns={[t("caseDash.colAssignee"), t("caseDash.colRole"), t("caseDash.colCases")]}
          rows={byAssignee.map((row) => ({
            key: `assignee-${row.role}-${row.userId || "none"}`,
            cells: [row.name || t("caseDash.unassigned"), t(ROLE_KEYS[row.role] || "caseDash.roleUnassigned"), numbers.format(row.caseCount)],
          }))}
          empty={t("caseDash.empty")}
        >
          <BarChart
            series={3}
            rows={byAssignee.map((row) => ({
              key: `assignee-${row.role}-${row.userId || "none"}`,
              name: row.name || t("caseDash.unassigned"),
              value: row.caseCount,
              display: numbers.format(row.caseCount),
              href: linkTo(caseListPath, { assignee: row.userId || "none", role: row.role }),
              label: row.userId
                ? t("caseDash.openAssignee", { count: row.caseCount, name: row.name })
                : t("caseDash.openUnassigned", { count: row.caseCount }),
            }))}
          />
        </ChartContainer>

      </div>
    </section>
  );
}

export default CaseDashboards;
