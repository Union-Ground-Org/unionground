import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BusyButton } from "../../../components/BusyControls.jsx";
import { runBusyWrite } from "../../../lib/busyWrite.js";
import { StateBlock } from "../../../components/Primitives.jsx";
import { FlowValue } from "../../../components/FlowValue.jsx";
import { ArrivalCount, ChartArrival, arriveAt } from "../../../components/ChartArrival.jsx";
import { RoutedTabLink, useRoutedTab } from "../../../components/WorkspacePages.jsx";
import {
  ANALYTICS_DESK_TABS,
  ANALYTICS_SECTION_IDS,
  ANALYTICS_SECTIONS,
  ANALYTICS_STATS_TABS,
  ANALYTICS_WORKSPACE_VIEWS,
} from "../contract.js";
import { composeAnalyticsCore } from "../dashboard.js";
import { useLang } from "../../../lib/LanguageContext.jsx";
import {
  AnalyticsExplorerPanel,
  AnalyticsStudioPanel,
  ChapterChartsPanel,
  OrganizationHealthPanel,
} from "./AnalyticsParityPanels.jsx";
import { UsageDigestPanel } from "./UsageDigestPanel.jsx";
import { PulseChartStudio } from "../../pulse/ui/PulseSavedCharts.jsx";
import "../analyticsCore.css";

// member_cases allows only these two tokens. Reuse the existing cases.status*
// catalogue entries. Any other bucket name stays as stored so it remains readable.
const CASE_STATUS_LABEL_KEYS = new Map([
  ["active", "cases.statusActive"],
  ["resolved", "cases.statusResolved"],
]);

function caseStatusLabel(token, t) {
  const key = CASE_STATUS_LABEL_KEYS.get(token);
  return key ? t(key) : token;
}

function analyticsCopy(t) {
  return {
    title: t("analytics.title"),
    sub: t("analytics.sub"),
    empty: t("analytics.empty"),
    emptyTitle: t("analytics.emptyTitle"),
    unauthorized: t("analytics.unauthorized"),
    unauthorizedTitle: t("analytics.unauthorizedTitle"),
    mfaRequired: t("analytics.mfaRequired"),
    mfaTitle: t("analytics.mfaTitle"),
    unset: t("analytics.unset"),
    unsetTitle: t("analytics.unsetTitle"),
    error: t("analytics.error"),
    errorTitle: t("analytics.errorTitle"),
    timedOut: t("analytics.timedOut"),
    timedOutTitle: t("analytics.timedOutTitle"),
    readSafe: t("analytics.readSafe"),
    errorHint: t("analytics.errorHint"),
    workspaceTimedOut: t("analytics.workspaceTimedOut"),
    workspaceTimedOutTitle: t("analytics.workspaceTimedOutTitle"),
    workspaceError: t("analytics.workspaceError"),
    workspaceErrorTitle: t("analytics.workspaceErrorTitle"),
    workspaceUnavailable: t("analytics.workspaceUnavailable"),
    workspaceUnavailableTitle: t("analytics.workspaceUnavailableTitle"),
    sectionsLabel: t("analytics.sectionsLabel"),
    sections: Object.fromEntries(ANALYTICS_SECTION_IDS.map((id) => [id, t(`analytics.sections.${id}`)])),
    viewLabel: t("analytics.viewLabel"),
    tileHidden: t("analytics.tileHidden"),
    tileHiddenSmallChapter: t("analytics.tileHiddenSmallChapter"),
    tileIncompleteCases: t("analytics.tileIncompleteCases"),
    tileHiddenStewards: t("analytics.tileHiddenStewards"),
    tileNoCaseGroups: t("analytics.tileNoCaseGroups"),
    tileScope: (count, total) => t("analytics.tileScope", { count, total }),
    retry: t("analytics.retry"),
    loading: t("analytics.loading"),
    export: t("analytics.export"),
    exportDenied: t("analytics.exportDenied"),
    exported: t("analytics.exported"),
    exporting: t("analytics.exporting"),
    exportError: t("analytics.exportError"),
    preview: t("analytics.preview"),
    protected: t("analytics.protected"),
    insightsProtected: t("analytics.insightsProtected"),
    heatmapHidden: t("analytics.heatmapHidden"),
    heatmapHiddenShort: t("analytics.heatmapHiddenShort"),
    noFindings: t("analytics.noFindings"),
    noAttendance: t("analytics.noAttendance"),
    sourceUnavailable: t("analytics.sourceUnavailable"),
    tabs: Object.fromEntries(ANALYTICS_DESK_TABS.map((id) => [id, t(`analytics.tabs.${id}`)])),
    statsTabs: Object.fromEntries(ANALYTICS_STATS_TABS.map((id) => [id, t(`analytics.statsTabs.${id}`)])),
    openCases: t("analytics.openCases"),
    resolvedCases: t("analytics.resolvedCases"),
    resolutionRate: t("analytics.resolutionRate"),
    stewards: t("analytics.stewards"),
    openPerSteward: t("analytics.openPerSteward"),
    chapters: t("analytics.chapters"),
    chapter: t("analytics.chapter"),
    caseCategory: t("analytics.caseCategory"),
    cases: t("analytics.cases"),
    byStatus: t("analytics.byStatus"),
    status: t("analytics.status"),
    averageOpen: t("analytics.averageOpen"),
    activeMembers: t("analytics.activeMembers"),
    new90: t("analytics.new90"),
    band: t("analytics.band"),
    count: t("analytics.count"),
    noRows: t("analytics.noRows"),
    statsSuite: t("analytics.statsSuite"),
    portalUsage: t("analytics.portalUsage"),
    views: t("analytics.views"),
    dailyActors: t("analytics.dailyActors"),
    weeklyActors: t("analytics.weeklyActors"),
    monthlyActors: t("analytics.monthlyActors"),
    path: t("analytics.path"),
    correlationInsights: t("analytics.correlationInsights"),
    grievance: t("analytics.grievance"),
    solidarity: t("analytics.solidarity"),
    engagementScoring: t("analytics.engagementScoring"),
    chapterMean: t("analytics.chapterMean"),
    scoreBands: t("analytics.scoreBands"),
    score: t("analytics.score"),
    attendanceTitle: t("analytics.attendanceTitle"),
    events: t("analytics.events"),
    checkIns: t("analytics.checkIns"),
    average: t("analytics.average"),
    best: t("analytics.best"),
    event: t("analytics.event"),
    overviewLabel: t("analytics.overviewLabel"),
    suppressed: t("analytics.suppressed"),
    insightTitles: {
      attendance_vs_cases: t("analytics.insightTitles.attendance_vs_cases"),
      engagement_vs_attendance: t("analytics.insightTitles.engagement_vs_attendance"),
      usage_vs_engagement: t("analytics.insightTitles.usage_vs_engagement"),
    },
    insightPositive: {
      attendance_vs_cases: t("analytics.insightPositive.attendance_vs_cases"),
      engagement_vs_attendance: t("analytics.insightPositive.engagement_vs_attendance"),
      usage_vs_engagement: t("analytics.insightPositive.usage_vs_engagement"),
    },
    insightNegative: {
      attendance_vs_cases: t("analytics.insightNegative.attendance_vs_cases"),
      engagement_vs_attendance: t("analytics.insightNegative.engagement_vs_attendance"),
      usage_vs_engagement: t("analytics.insightNegative.usage_vs_engagement"),
    },
  };
}

// A stat tile never shows a dash (BUG-UNIONGROUND-WEB-ANALYTICS-STAT-TILES-SHOW-
// ONLY-A-DASH-20261002): it shows the figure, or says what is missing and what
// would show it. `scope` names a figure that covers only part of the
// organization.
function StatTile({ label, value, scope = null, missing = null, copy }) {
  const shown = value != null && value !== "";
  return (
    <article className="mi1-ana-tile">
      <div className="mi1-ana-tile__label">{label}</div>
      {shown
        ? <div className="mi1-ana-tile__value"><FlowValue value={value} /></div>
        : <p className="mi1-ana-tile__missing">{missing || copy.tileHidden}</p>}
      {shown && scope && <p className="mi1-ana-tile__scope">{scope}</p>}
    </article>
  );
}

function percent(value) {
  return value == null ? null : `${value}%`;
}

function OverviewTiles({ overview, copy }) {
  const scoped = overview.openCases == null ? overview.publishedChapterTotals : null;
  const scope = scoped ? copy.tileScope(scoped.chapters, scoped.of) : null;
  const caseMissing = overview.caseGroups === 0
    ? copy.tileNoCaseGroups
    : overview.publishedChapterTotalsIncomplete ? copy.tileIncompleteCases
      : overview.casesSuppressed ? copy.tileHiddenSmallChapter : null;
  const stewardMissing = overview.stewardsSuppressed ? copy.tileHiddenStewards : null;
  const caseValue = (value) => (overview.caseGroups === 0 ? null : value);
  return (
    <div className="mi1-ana__grid" aria-label={copy.overviewLabel}>
      <StatTile label={copy.openCases} value={caseValue(overview.openCases ?? scoped?.openCases)} scope={scope} missing={caseMissing} copy={copy} />
      <StatTile label={copy.resolvedCases} value={caseValue(overview.resolvedCases ?? scoped?.resolvedCases)} scope={scope} missing={caseMissing} copy={copy} />
      <StatTile label={copy.resolutionRate} value={caseValue(percent(overview.resolutionRate ?? scoped?.resolutionRate))} scope={scope} missing={caseMissing} copy={copy} />
      <StatTile label={copy.stewards} value={overview.stewardCount} missing={stewardMissing} copy={copy} />
      <StatTile label={copy.openPerSteward} value={caseValue(overview.averageOpenPerSteward)} missing={stewardMissing || caseMissing} copy={copy} />
      <StatTile label={copy.chapters} value={overview.chapterCount} copy={copy} />
    </div>
  );
}

// One state block for every non-ready workspace view (health tree, explorer,
// charts studio, chapter charts): the snapshot can be ready while this
// role-scaled read timed out or failed.
function WorkspaceState({ workspace, copy, onRetry }) {
  if (workspace?.reason === "mfa_required") {
    return <StateBlock title={copy.mfaTitle} body={copy.mfaRequired} />;
  }
  if (workspace?.state === "unauthorized" || workspace?.reason === "authorization_required") {
    return <StateBlock title={copy.unauthorizedTitle} body={copy.unauthorized} />;
  }
  if (workspace?.state === "error") {
    const timedOut = workspace.reason === "timed_out";
    return (
      <StateBlock
        kind="error"
        title={timedOut ? copy.workspaceTimedOutTitle : copy.workspaceErrorTitle}
        body={timedOut ? copy.workspaceTimedOut : copy.workspaceError}
        safe={copy.readSafe}
        hint={copy.errorHint}
        actionLabel={onRetry ? copy.retry : null}
        onAction={onRetry}
      />
    );
  }
  return <StateBlock title={copy.workspaceUnavailableTitle} body={copy.workspaceUnavailable} />;
}

// Every non-ready desk state as one StateBlock (BUG-UNIONGROUND-WEB-ANALYTICS-
// THIRD-FAILURE-PANEL-DESIGN-20261002). A timeout, a refusal, two-step sign-in,
// a failure and an empty organization each say what happened
// (BUG-UG-WEB-ANALYTICS-TIMEOUT-WORDED-AS-GENERIC-FAILURE-20261002).
function DeskState({ resolved, copy, onRetry }) {
  if (resolved.state === "empty") return <StateBlock title={copy.emptyTitle} body={copy.empty} />;
  if (resolved.state === "unset") return <StateBlock title={copy.unsetTitle} body={copy.unset} />;
  if (resolved.state === "unauthorized") {
    return resolved.reason === "mfa_required"
      ? <StateBlock title={copy.mfaTitle} body={copy.mfaRequired} />
      : <StateBlock title={copy.unauthorizedTitle} body={copy.unauthorized} />;
  }
  const timedOut = resolved.reason === "timed_out";
  return (
    <StateBlock
      kind="error"
      title={timedOut ? copy.timedOutTitle : copy.errorTitle}
      body={timedOut ? copy.timedOut : copy.error}
      safe={copy.readSafe}
      hint={copy.errorHint}
      actionLabel={onRetry ? copy.retry : null}
      onAction={onRetry}
    />
  );
}

function ProtectedNote({ surface, copy, anonymityText = copy.protected }) {
  if (!surface || surface.enoughData !== false) return null;
  if (surface.reason === "anonymity_floor") return <p className="mi1-ana__note" role="status">{anonymityText}</p>;
  if (surface.reason === "source_unavailable") return <p className="mi1-ana__note" role="status">{copy.sourceUnavailable}</p>;
  return null;
}

function MetricTable({ rows, nameHeader, valueHeader, copy }) {
  if (!rows?.length) return <p className="mi1-ana__note">{copy.noRows}</p>;
  return (
    <table className="mi1-ana__table">
      <thead>
        <tr>
          <th>{nameHeader}</th>
          <th>{valueHeader || copy.count}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id || row.name || row.label}>
            <td>{row.label || row.name || row.id}</td>
            <td>{row.count ?? row.openCases ?? row.score ?? row.checkIns ?? row.grievances ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function HeatmapLayer({ title, layer, copy }) {
  if (layer?.available === false) return <p className="mi1-ana__note" role="status">{title}: {copy.sourceUnavailable}</p>;
  if (!layer?.rowKeys?.length) return <p className="mi1-ana__note">{copy.noRows}</p>;
  return (
    <article className="plane-card ach-card">
      <h3 className="ach-card__title">{title}</h3>
      <div
        className="mi1-ana-heat"
        role="list"
        aria-label={title}
        style={{ gridTemplateColumns: `repeat(${Math.max(layer.colKeys.length, 1)}, minmax(72px, 1fr))` }}
      >
        {layer.cells.map((cell) => {
          const ratio = !cell.suppressed && layer.maxValue ? cell.value / layer.maxValue : 0;
          const tone = cell.suppressed ? "suppressed" : ratio >= 0.66 ? "hot" : ratio >= 0.33 ? "mid" : "";
          return (
            <div
              key={`${cell.rowKey}-${cell.colKey}`}
              role="listitem"
              aria-label={cell.suppressed ? `${cell.rowKey} / ${cell.colKey}: ${copy.heatmapHidden}` : `${cell.rowKey} / ${cell.colKey}: ${cell.value}`}
              className={`mi1-ana-heat__cell${tone ? ` mi1-ana-heat__cell--${tone}` : ""}`}
              title={cell.suppressed ? copy.heatmapHidden : `${cell.rowKey} / ${cell.colKey}: ${cell.value}`}
            >
              <strong>{cell.suppressed ? copy.heatmapHiddenShort : cell.value}</strong>
              <small>{cell.rowKey} · {cell.colKey}</small>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function downloadAnalyticsExport(payload) {
  if (!payload?.body || typeof document === "undefined"
    || typeof Blob === "undefined" || typeof globalThis.URL?.createObjectURL !== "function") return false;
  const href = globalThis.URL.createObjectURL(new Blob([payload.body], {
    type: payload.format === "json" ? "application/json" : "text/csv;charset=utf-8",
  }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = payload.filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(href), 0);
  return true;
}

function StatsPanel({ stats, tab, copy, t }) {
  if (tab === "overview") return <OverviewTiles overview={stats.overview} copy={copy} />;
  if (tab === "chapters") {
    return (
      <>
        <ProtectedNote surface={stats.chapters} copy={copy} />
        {stats.chapters.enoughData && <MetricTable rows={stats.chapters.rows} nameHeader={copy.chapter} valueHeader={copy.openCases} copy={copy} />}
      </>
    );
  }
  if (tab === "workplaces") {
    return (
      <>
        <ProtectedNote surface={stats.workplaces} copy={copy} />
        {stats.workplaces.enoughData && <MetricTable rows={stats.workplaces.rows} nameHeader={copy.caseCategory} valueHeader={copy.cases} copy={copy} />}
      </>
    );
  }
  if (tab === "cases") {
    // A single sub-floor chapter empties every case breakdown. Without the note
    // the table reads as "no cases yet" instead of "withheld to protect a small
    // cohort". "empty" keeps the table, which says the organization has no cases.
    const casesSuppressed = stats.cases.enoughData === false && stats.cases.reason !== "empty";
    return (
      <>
        <ProtectedNote surface={stats.cases} copy={copy} />
        {!casesSuppressed && (
          <article className="plane-card ach-card">
            <h3 className="ach-card__title">{copy.byStatus}</h3>
            {/* Cases exist but every status bucket is under the cohort floor:
                say so instead of "No rows yet.", which reads as no cases. */}
            {stats.cases.statusFloored ? <p className="mi1-ana__note" role="status">{copy.protected}</p> : (
              <MetricTable
                rows={stats.cases.byStatus?.map((row) => ({
                  ...row,
                  label: caseStatusLabel(row.name, t),
                }))}
                nameHeader={copy.status}
                copy={copy}
              />
            )}
          </article>
        )}
      </>
    );
  }
  if (tab === "stewards") {
    const noCaseGroups = stats.overview.caseGroups === 0;
    const caseMissing = noCaseGroups ? copy.tileNoCaseGroups
      : stats.overview.casesSuppressed ? copy.tileHiddenSmallChapter : null;
    return (
      <div className="mi1-ana__grid">
        <StatTile label={copy.stewards} value={stats.stewards.stewardCount} missing={stats.stewards.suppressed ? copy.tileHiddenStewards : null} copy={copy} />
        <StatTile label={copy.openCases} value={noCaseGroups ? null : stats.stewards.openCases} missing={caseMissing} copy={copy} />
        <StatTile label={copy.averageOpen} value={noCaseGroups ? null : stats.stewards.averageOpenPerSteward} missing={stats.stewards.suppressed ? copy.tileHiddenStewards : caseMissing} copy={copy} />
      </div>
    );
  }
  if (tab === "membership") {
    return (
      <>
        <ProtectedNote surface={stats.membership} copy={copy} />
        {stats.membership.enoughData && (
          <div className="mi1-ana__grid">
            <StatTile label={copy.activeMembers} value={stats.membership.active} copy={copy} />
            <StatTile label={copy.new90} value={stats.membership.newIn90} copy={copy} />
            <StatTile label={copy.band} value={stats.membership.band} copy={copy} />
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <ProtectedNote surface={stats.comparison} copy={copy} />
      {stats.comparison.enoughData && <MetricTable rows={stats.comparison.rows} nameHeader={copy.chapter} valueHeader={copy.openCases} copy={copy} />}
    </>
  );
}

export function AnalyticsCoreDesk({
  model = null,
  snapshot = null,
  workspace = null,
  viewer = null,
  status = null,
  onRetry = null,
  onExport = null,
  onSaveLayout = null,
  onDeleteLayout = null,
  // REQ-UG-AI-USAGE-DIGEST-20261001: the stored usage digests load only
  // when a staff member opens the Usage view, so the desk's own snapshot read
  // is unchanged. Without these the panel renders nothing.
  onLoadUsageDigests = null,
  onRequestUsageDigestWording = null,
  // REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: with a Pulse source
  // the chart view is the app's chart builder over the shared saved-chart
  // specs, and it links to the Pulse explorer.
  pulseApi = null,
  onOpenPulse = null,
}) {
  const { lang, t } = useLang();
  const copy = analyticsCopy(t);
  // One routed level of sections (/m/analytics/<section>) and one selector for
  // the views inside it (BUG-UNIONGROUND-WEB-ANALYTICS-SEVENTEEN-PILLS-IN-TWO-
  // WRAPPING-TRAYS-20261002). Each section remembers its view while the page
  // stays open.
  const [routedSection, setSection] = useRoutedTab("analytics", ANALYTICS_SECTION_IDS[0]);
  const section = ANALYTICS_SECTIONS[routedSection] ? routedSection : ANALYTICS_SECTION_IDS[0];
  const [sectionViews, setSectionViews] = useState(() => Object.fromEntries(
    ANALYTICS_SECTION_IDS.map((id) => [id, ANALYTICS_SECTIONS[id][0]]),
  ));
  const view = sectionViews[section];
  const viewSelectId = useId();
  const [exportNotice, setExportNotice] = useState("");
  const [exporting, setExporting] = useState(false);
  const pageHeading = useRef(null);
  const previousState = useRef(null);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const readyBlank = useRef({ wasReady: false, restoreHeading: false });

  const resolved = useMemo(() => {
    if (model) return model;
    if (status === "loading") return { state: "loading", reason: "loading" };
    return composeAnalyticsCore({ snapshot, workspace, viewer });
  }, [model, snapshot, workspace, viewer, status]);

  const isReady = resolved.state === "ready";
  // Record focus BEFORE React unmounts the ready-only subtree. The error
  // recovery effect below runs after that unmount and cannot tell where
  // focus came from, so it must not steal focus on every ready-to-loading
  // blank. Do not copy PR #2156's keep-the-desk-mounted approach: the
  // [organizationScope] blanking in AnalyticsCoreView is the cross-tenant
  // guard and must stay.
  if (readyBlank.current.wasReady && !isReady && !readyBlank.current.restoreHeading) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    readyBlank.current.restoreHeading = Boolean(active?.closest?.("[data-analytics-ready-subtree]"));
  }
  if (isReady) readyBlank.current.restoreHeading = false;
  readyBlank.current.wasReady = isReady;

  useLayoutEffect(() => {
    if (!readyBlank.current.restoreHeading) return;
    readyBlank.current.restoreHeading = false;
    pageHeading.current?.focus();
  }, [resolved.state]);

  useEffect(() => {
    if (previousState.current === "error" && resolved.state !== "error") pageHeading.current?.focus();
    previousState.current = resolved.state;
  }, [resolved.state]);

  function handleExport() {
    return runBusyWrite(busyWriteRef, "export", () => exportNow());
  }

  async function exportNow() {
    if (exporting) return;
    setExporting(true);
    setExportNotice(copy.exporting);
    try {
      // Production exports must traverse the adapter so the database audit
      // event is written before a file is offered to the browser.
      const result = onExport
        ? await onExport({ format: "csv" })
        : { ok: false, reason: "export_unwired" };
      if (!result.ok) {
        setExportNotice(result.reason === "export_denied" ? copy.exportDenied : copy.exportError);
        return;
      }
      const downloaded = downloadAnalyticsExport(result.payload);
      setExportNotice(downloaded ? copy.exported : copy.exportError);
    } finally {
      setExporting(false);
    }
  }

  const viewLabel = (id) => (ANALYTICS_STATS_TABS.includes(id) ? copy.statsTabs[id] : copy.tabs[id]);
  const pulseStudio = view === "studio" && Boolean(pulseApi);
  const workspaceView = ANALYTICS_WORKSPACE_VIEWS.includes(view) && !pulseStudio;
  const workspaceReady = resolved.workspace?.state === "ready";

  return (
    <div className="screen mi1-ana" aria-busy={resolved.state === "loading" || undefined}>
      <header className="phead mi1-ana__head">
        <div className="phead__copy">
          <h1 ref={pageHeading} tabIndex="-1" className="phead__title">{copy.title}</h1>
          <p className="phead__sub">{copy.sub}</p>
        </div>
        {resolved.state === "ready" && resolved.exportAllowed && (
          <div className="phead__actions" data-analytics-ready-subtree="">
            <BusyButton type="button" className="mi1-ana__button" pending={exporting} onClick={() => void handleExport()}>
              {copy.export}
            </BusyButton>
          </div>
        )}
        {/* An action that cannot be used is one header sentence saying why
            (BUG-UG-WEB-ANALYTICS-EXPORT-NOTE-NO-GUTTER-OUTRANKS-SUBTITLE-20261002). */}
        {resolved.state === "ready" && !resolved.exportAllowed && (
          <p className="mi1-ana__head-note">{copy.exportDenied}</p>
        )}
      </header>

      {resolved.reason === null && resolved.state === "ready" && (resolved.preview || snapshot?.label === "PREVIEW") && (
        <p className="mi1-ana__note">{copy.preview}</p>
      )}

      {resolved.state === "loading" && (
        <p className="mi1-ana__loading" role="status" aria-live="polite">{copy.loading}</p>
      )}
      {resolved.state !== "ready" && resolved.state !== "loading" && (
        <DeskState resolved={resolved} copy={copy} onRetry={resolved.state === "error" ? onRetry : null} />
      )}

      {resolved.state === "ready" && (
        <div className="mi1-ana__ready" data-analytics-ready-subtree="">
          <nav className="mi1-ana__sections" aria-label={copy.sectionsLabel}>
            {ANALYTICS_SECTION_IDS.map((id) => (
              <RoutedTabLink
                key={id}
                group="analytics"
                value={id}
                type="button"
                className="mi1-ana__section"
                aria-pressed={section === id}
                onClick={() => setSection(id)}
              >
                {copy.sections[id]}
              </RoutedTabLink>
            ))}
          </nav>

          <div className="mi1-ana__toolbar">
            <label className="mi1-ana__view-label" htmlFor={viewSelectId}>{copy.viewLabel}</label>
            <select
              id={viewSelectId}
              className="mi1-ana__view"
              value={view}
              onChange={(event) => setSectionViews((current) => ({ ...current, [section]: event.target.value }))}
            >
              {ANALYTICS_SECTIONS[section].map((id) => <option key={id} value={id}>{viewLabel(id)}</option>)}
            </select>
          </div>

          {exportNotice && <p className="mi1-ana__note" role="status">{exportNotice}</p>}

          {section === "stats" && <StatsPanel stats={resolved.stats} tab={view} copy={copy} t={t} />}

          {view === "usage" && (
            <article className="plane-card ach-card">
              <h2 className="ach-card__title">{copy.portalUsage}</h2>
              <div className="mi1-ana__grid">
                <StatTile label={copy.views} value={resolved.usage.totalViews} copy={copy} />
                <StatTile label={copy.dailyActors} value={resolved.usage.dau} copy={copy} />
                <StatTile label={copy.weeklyActors} value={resolved.usage.wau} copy={copy} />
                <StatTile label={copy.monthlyActors} value={resolved.usage.mau} copy={copy} />
              </div>
              <MetricTable rows={resolved.usage.byPath} nameHeader={copy.path} copy={copy} />
              <UsageDigestPanel load={onLoadUsageDigests} onRequestWording={onRequestUsageDigestWording} />
            </article>
          )}

          {view === "insights" && (
            <article className="plane-card ach-card">
              <h2 className="ach-card__title">{copy.correlationInsights}</h2>
              <ProtectedNote surface={resolved.insights} copy={copy} anonymityText={copy.insightsProtected} />
              {resolved.insights.enoughData && resolved.insights.findings.length === 0 && (
                <p className="mi1-ana__note">{copy.noFindings}</p>
              )}
              {resolved.insights.findings?.map((finding) => (
                <section key={finding.id}>
                  <h3>{copy.insightTitles[finding.id] || finding.title}</h3>
                  <p>{(finding.r < 0 ? copy.insightNegative : copy.insightPositive)[finding.id] || finding.description}</p>
                  <p className="mi1-ana__note">r = {finding.r} · n = {finding.n}</p>
                </section>
              ))}
            </article>
          )}

          {view === "heatmaps" && (
            <>
              <HeatmapLayer title={copy.grievance} layer={resolved.heatmaps.grievance} copy={copy} />
              <HeatmapLayer title={copy.solidarity} layer={resolved.heatmaps.solidarity} copy={copy} />
            </>
          )}

          {view === "engagement" && (
            <article className="plane-card ach-card">
              <h2 className="ach-card__title">{copy.engagementScoring}</h2>
              <ProtectedNote surface={resolved.engagement} copy={copy} />
              {resolved.engagement.enoughData && (
                <>
                  <div className="mi1-ana__grid">
                    <StatTile label={copy.chapterMean} value={resolved.engagement.mean} copy={copy} />
                  </div>
                  <ChartArrival name="analytics:score-bands" className="mi1-ana-bars" role="list" aria-label={copy.scoreBands}>
                    {Object.entries(resolved.engagement.histogram).map(([band, cell], index) => {
                      const count = cell?.value ?? 0;
                      const max = Math.max(1, ...Object.values(resolved.engagement.histogram).map((entry) => entry?.value ?? 0));
                      return (
                        <div key={band} className="mi1-ana-bars__row" role="listitem" aria-label={`${band}: ${cell?.suppressed ? copy.suppressed : count}`}>
                          <div>
                            <div>{band}</div>
                            <div className="mi1-ana-bars__track">
                              <span className="mi1-ana-bars__fill arrive-x" style={arriveAt(index, { width: `${Math.round((count / max) * 100)}%` })} />
                            </div>
                          </div>
                          <strong>{cell?.suppressed ? copy.suppressed : <ArrivalCount value={count} index={index} />}</strong>
                        </div>
                      );
                    })}
                  </ChartArrival>
                  <MetricTable rows={resolved.engagement.chapters} nameHeader={copy.chapter} valueHeader={copy.score} copy={copy} />
                </>
              )}
            </article>
          )}

          {view === "attendance" && (
            <article className="plane-card ach-card">
              <h2 className="ach-card__title">{copy.attendanceTitle}</h2>
              {!resolved.attendance.enoughData && (
                <p className="mi1-ana__note">{resolved.attendance.reason === "source_unavailable" ? copy.sourceUnavailable : copy.noAttendance}</p>
              )}
              {resolved.attendance.enoughData && (
                <>
                  <div className="mi1-ana__grid">
                    <StatTile label={copy.events} value={resolved.attendance.totals.events} copy={copy} />
                    <StatTile label={copy.checkIns} value={resolved.attendance.totals.suppressed ? null : resolved.attendance.totals.checkIns} copy={copy} />
                    <StatTile label={copy.average} value={resolved.attendance.totals.suppressed ? null : resolved.attendance.totals.averagePerEvent} copy={copy} />
                    <StatTile label={copy.best} value={resolved.attendance.totals.suppressed ? null : resolved.attendance.totals.bestAttendance} copy={copy} />
                  </div>
                  <ProtectedNote surface={resolved.attendance.cohorts} copy={copy} />
                  <MetricTable rows={resolved.attendance.recent} nameHeader={copy.event} valueHeader={copy.checkIns} copy={copy} />
                </>
              )}
            </article>
          )}

          {workspaceView && !workspaceReady && <WorkspaceState workspace={resolved.workspace} copy={copy} onRetry={onRetry} />}

          {view === "health" && workspaceReady && (
            <OrganizationHealthPanel workspace={resolved.workspace} lang={lang} />
          )}

          {view === "explorer" && workspaceReady && (
            <AnalyticsExplorerPanel workspace={resolved.workspace} lang={lang} />
          )}

          {pulseStudio && (
            <PulseChartStudio api={pulseApi} hat={viewer?.selectedHat || "member"} onOpenPulse={onOpenPulse} />
          )}

          {view === "studio" && !pulseStudio && workspaceReady && (
            <AnalyticsStudioPanel
              workspace={resolved.workspace}
              viewer={viewer}
              lang={lang}
              onSaveLayout={onSaveLayout}
              onDeleteLayout={onDeleteLayout}
            />
          )}

          {view === "chapter_charts" && workspaceReady && (
            <ChapterChartsPanel workspace={resolved.workspace} lang={lang} />
          )}
        </div>
      )}
    </div>
  );
}
