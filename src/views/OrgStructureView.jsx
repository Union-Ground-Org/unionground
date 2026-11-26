import "../lib/i18n/features/csvExportsStrings.js";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Download, Network, Printer } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { countKey } from "../lib/i18n.js";
import { formatCalendarDay } from "../lib/i18n/zonedDates.js";
import { withLoadDeadline } from "../lib/loadDeadline.js";
import { getMemberOrganizationStructure } from "../lib/memberApi.js";
import { PageHeader } from "../components/PageHeader.jsx";
import { StateBlock } from "../components/Primitives.jsx";
import { chartAxisSpan, normalizedPositions, useChartRootCentring } from "./OrganizationIntelligenceView.jsx";
import {
  SEAT_FILTERS,
  branchIds,
  buildOrgChartCsv,
  buildOutline,
  easternToday,
  effectiveSeatStatus,
  initiallyExpanded,
  matchesSeatFilter,
  seatMarkers,
} from "../features/orgChart/model.js";

// The member's read-only view of the agency and union charts (owner order
// 2026-09-22). It is the same data the staff Organization map renders, but it
// arrives through a different door: get_member_organization_structure() is
// scoped to the caller's own organization AND chapter, projects only the
// structural reports_to edge, and has no write path at all. Nothing here is an
// editor, so none of the staff view's commit machinery is imported — only its
// two exported layout functions, so both surfaces place a node the same way.
//
// Edges arrive as node-id pairs the server already resolved. The client never
// sees a participant identity, so it cannot draw a line to a person it is not
// allowed to name.

const CHART_KINDS = ["agency", "union"];

function matches(node, query) {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [node.label, node.subtitle, node.badge, node.chipLabel, node.reportsToLabel]
    .filter(Boolean).join(" ").toLowerCase().includes(needle);
}

// The source's own provenance line, when the import carried one. It is data,
// not copy: an organization that imported nothing shows nothing here. Its
// date is a day, read "Jul 20, 2026" in the reader's language, never the raw
// "2026-07-20" (#9530); a value that is not a calendar day shows as stored.
// A seat's review date is read the same way (#9892).
function calendarDay(value, lang) {
  return value ? formatCalendarDay(value, lang) || value : "";
}

function sourceLine(charts, lang) {
  for (const chart of charts) {
    for (const node of chart.nodes) {
      if (node.sourceLabel) return [node.sourceLabel, calendarDay(node.sourceAsOf, lang)].filter(Boolean).join(" · ");
    }
  }
  return null;
}

// The chart canvas, read-only: the staff view's node is a button that opens an
// editor, this one selects a node for the detail panel and nothing else.
function SeatMarkers({ node, today, t }) {
  const markers = seatMarkers(node, today);
  if (!markers.length) return null;
  return (
    <span className="orgstructure-markers">
      {markers.map((marker) => (
        <span key={marker} className={`orgstructure-marker orgstructure-marker--${marker}`}>{t(`orgStructure.marker_${marker}`)}</span>
      ))}
    </span>
  );
}

function StructureCanvas({ nodes, edges, label, selectedId, onSelect, today, t }) {
  const frame = useRef(null);
  const positions = normalizedPositions(nodes);
  const width = chartAxisSpan(positions, "x", 180, 480);
  const height = chartAxisSpan(positions, "y", 150, Math.max(280, 160 + Math.ceil(nodes.length / 4) * 110));
  // #9534: a canvas wider than its frame opened at its left edge, often on
  // empty space with the root off to the right. It opens centred on the
  // outline's first root, as the staff chart does.
  const rootId = useMemo(() => buildOutline(nodes).roots[0]?.id, [nodes]);
  const openingX = positions.get(rootId ?? nodes[0]?.id)?.x;
  useChartRootCentring(frame, openingX, width);
  if (!nodes.length) return null;
  return (
    <div ref={frame} className="oi-map-scroll" style={{ height }} role="group" aria-label={label}>
      <div className="oi-map oi-map--chart" style={{ minWidth: width, minHeight: height }}>
        <svg className="oi-map__lines" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
          {edges.flatMap((edge) => {
            const from = positions.get(edge.sourceId);
            const to = positions.get(edge.targetId);
            return from && to ? [<line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />] : [];
          })}
        </svg>
        {nodes.map((node) => {
          const point = positions.get(node.id);
          return (
            <button
              key={node.id}
              type="button"
              className="oi-map__node"
              aria-pressed={selectedId === node.id}
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
              onClick={() => onSelect(node)}
            >
              <span>{t(`orgStructure.nodeKind_${node.nodeKind}`)}</span>
              <strong>{node.label}</strong>
              {node.subtitle && <small>{node.subtitle}</small>}
              {/* A vacant, unknown, unconfirmed or stale seat is marked wherever
                  it appears, never read as a confirmed, filled seat. */}
              <SeatMarkers node={node} today={today} t={t} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Parent/child outline with disclosure buttons, the reference charts'
// expand/collapse baseline. Nodes whose parent is filtered out or lives outside
// the caller's scope are rendered at the root rather than dropped: an omitted
// parent is the normal result of chapter scoping, and hiding its children would
// silently shrink the member's own structure.
function StructureOutline({ nodes, selectedId, onSelect, expanded, forceOpen, onToggle, today, t, label }) {
  const { roots, children } = useMemo(() => buildOutline(nodes), [nodes]);
  const listId = useId();
  const renderList = (items, depth, id) => (
    <ul className="orgstructure-tree" id={id} aria-label={depth === 0 ? label : undefined}>
      {items.map((node) => {
        const kids = children.get(node.id) ?? [];
        const open = kids.length > 0 && (forceOpen || expanded.has(node.id));
        const childListId = `${listId}-${node.id}`;
        return (
          <li key={node.id}>
            <div className="orgstructure-tree__row">
              {kids.length > 0 ? (
                <button
                  type="button"
                  className="orgstructure-tree__toggle"
                  aria-expanded={open}
                  aria-controls={open ? childListId : undefined}
                  aria-label={t(countKey(open ? "orgStructure.collapseBranch" : "orgStructure.expandBranch", kids.length), { label: node.label, count: kids.length })}
                  onClick={() => onToggle(node.id)}
                >
                  <span aria-hidden="true">{open ? "−" : "+"}</span>
                </button>
              ) : <span className="orgstructure-tree__spacer" aria-hidden="true" />}
              <button type="button" className="orgstructure-tree__node" aria-pressed={selectedId === node.id} onClick={() => onSelect(node)}>
                <strong>{node.label}</strong>
                {node.subtitle && <small>{node.subtitle}</small>}
                <SeatMarkers node={node} today={today} t={t} />
              </button>
            </div>
            {open && renderList(kids, depth + 1, childListId)}
          </li>
        );
      })}
    </ul>
  );
  return renderList(roots, 0, listId);
}

function downloadText(text, filename) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof document === "undefined") return false;
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

export function OrgStructureView({ client = null, structure: provided = null, loader = null, desktop = false, focus = null, scopeLabels = null }) {
  const { t, lang } = useLang();
  const [structure, setStructure] = useState(provided);
  const [state, setState] = useState(provided ? "ready" : "loading");
  const [query, setQuery] = useState("");
  const [chartKind, setChartKind] = useState("union");
  const [selected, setSelected] = useState(null);
  const [seatFilter, setSeatFilter] = useState("all");
  const [expansion, setExpansion] = useState({ chart: null, ids: new Set() });
  const [attempt, setAttempt] = useState(0);
  const [printing, setPrinting] = useState(false);
  const searchId = useId();
  const filterId = useId();
  const today = easternToday();

  useEffect(() => {
    if (provided) {
      setStructure(provided);
      setState("ready");
      return undefined;
    }
    const load = loader ?? (client ? () => getMemberOrganizationStructure(client) : null);
    if (!load) {
      setState("ready");
      return undefined;
    }
    let live = true;
    setState("loading");
    // A read that never answers ends in the error state after the shell
    // deadline, where Try again asks once more (REQ-UG-PAGE-LOADING-STALLS-20261030).
    withLoadDeadline(Promise.resolve().then(load))
      .then((value) => { if (live) { setStructure(value); setState("ready"); } })
      .catch(() => { if (live) { setStructure(null); setState("error"); } });
    return () => { live = false; };
  }, [attempt, client, loader, provided]);

  const charts = useMemo(() => {
    const byKind = new Map((structure?.charts ?? []).map((chart) => [chart.chartKind, chart]));
    return CHART_KINDS.map((kind) => byKind.get(kind) ?? { chartKind: kind, nodes: [], edges: [] });
  }, [structure]);

  // A Search result names the officer it matched: open the union chart with
  // that node selected and its name in the filter, once per result opened.
  const focusKey = focus?.nodeId ? `${focus.nodeId}:${focus.nonce ?? ""}` : "";
  const [appliedFocus, setAppliedFocus] = useState("");
  useEffect(() => {
    if (!focusKey || appliedFocus === focusKey || !structure) return;
    const node = (structure.charts ?? []).find((chart) => chart.chartKind === "union")?.nodes?.find((item) => item.id === focus.nodeId);
    setAppliedFocus(focusKey);
    if (!node) return;
    setChartKind("union");
    setQuery(node.label ?? "");
    setSelected(node);
  }, [appliedFocus, focus, focusKey, structure]);

  const active = charts.find((chart) => chart.chartKind === chartKind) ?? charts[0];
  // Each chart opens with the organization's own collapse hints applied,
  // decided during render so a chart never paints fully closed first.
  if (expansion.chart !== active) setExpansion({ chart: active, ids: initiallyExpanded(active.nodes) });
  const expanded = expansion.chart === active ? expansion.ids : initiallyExpanded(active.nodes);
  const setExpanded = (update) => setExpansion((current) => ({
    chart: active,
    ids: typeof update === "function" ? update(current.chart === active ? current.ids : initiallyExpanded(active.nodes)) : update,
  }));
  const visibleNodes = useMemo(
    () => active.nodes.filter((node) => matches(node, query) && matchesSeatFilter(node, seatFilter, today)),
    [active, query, seatFilter, today],
  );
  // Printing opens every branch: the print stylesheet hides the canvas and the
  // disclosure controls, so a closed branch would drop its positions from the
  // page. The state is flushed before the print snapshot is taken.
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
  // A search or a seat filter shows every match, so nothing it found is hidden
  // inside a closed branch.
  const forceOpen = printing || Boolean(query.trim()) || seatFilter !== "all";
  const toggleBranch = (id) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const downloadChart = () => {
    const csv = buildOrgChartCsv({
      chart: active,
      lang,
      organizationId: structure?.organizationId ?? null,
      chapterId: structure?.chapterId ?? null,
      labels: {
        chart: t(`orgStructure.chart_${active.chartKind}`),
        headers: ["organization", "chapter", "chart", "level", "path", "position", "kind", "chartDetail", "reportsTo", "seatStatus", "vacant", "reviewedOn", "source", "sourceAsOf"].map((key) => t(`csvExports.${key}`)),
        kind: (kind) => ["organization", "division", "chapter", "team", "role", "person"].includes(kind) ? t(`orgStructure.nodeKind_${kind}`) : kind,
        status: (status) => t(`orgStructure.status_${status}`),
        yes: t("orgStructure.exportYes"),
        no: t("orgStructure.exportNo"),
      },
      today,
    });
    downloadText(csv, `org-chart-${active.chartKind}-${today}.csv`);
  };
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => active.edges.filter((edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)),
    [active, visibleIds],
  );
  const detail = selected && visibleIds.has(selected.id) ? selected : null;
  const total = charts.reduce((sum, chart) => sum + chart.nodes.length, 0);
  const source = sourceLine(charts, lang);
  const matchingLabels = scopeLabels?.organizationId && structure?.organizationId === scopeLabels.organizationId
    && structure.chapterId === scopeLabels.chapterId ? scopeLabels : null;

  if (state === "ready" && total === 0) {
    const organizationName = matchingLabels?.organizationName;
    const chapterName = matchingLabels?.chapterName;
    const scope = (organizationName || chapterName) && (
      <>
        {organizationName && <span>{t("orgStructure.nodeKind_organization")}: {organizationName}</span>}
        {organizationName && chapterName && <br />}
        {chapterName && <span>{t("orgStructure.nodeKind_chapter")}: {chapterName}</span>}
      </>
    );
    return (
      <section className="screen member-empty-page" aria-labelledby="orgstructure-title" data-mi1-surface="member-org-structure">
        <PageHeader titleId="orgstructure-title" title={t("orgStructure.title")} purpose={t("orgStructure.subtitle")} />
        <StateBlock title={t("orgStructure.empty")} hint={scope} />
      </section>
    );
  }

  return (
    <section
      className={`screen orgstructure${desktop ? " orgstructure--desktop" : ""}`}
      aria-labelledby="orgstructure-title"
      data-mi1-surface="member-org-structure"
    >
      <header className="orgstructure__head">
        <span className="orgstructure__icon" aria-hidden="true"><Network size={20} /></span>
        <div>
          <h1 id="orgstructure-title">{t("orgStructure.title")}</h1>
          <p>{t("orgStructure.subtitle")}</p>
        </div>
      </header>

      {state === "loading" && <p className="orgstructure__status">{t("orgStructure.loading")}</p>}
      {state === "error" && <>
        <p className="orgstructure__status" role="alert">{t("orgStructure.error")}</p>
        <button type="button" className="dialog-secondary" onClick={() => setAttempt((value) => value + 1)}>{t("app.tryAgain")}</button>
      </>}

      {state === "ready" && total > 0 && (
        <>
          <div className="orgstructure__controls">
            {/* Pressed buttons, not the ARIA tab roles. These filter ONE
                region and implement no roving-tabindex keyboard model, and
                tests/aria-tab-sweep.test.js refuses a tab role that promises
                a keyboard model the control does not have. */}
            <div className="orgstructure__kinds" role="group" aria-label={t("orgStructure.chartKinds")}>
              {CHART_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  id={`orgstructure-kind-${kind}`}
                  aria-pressed={chartKind === kind}
                  aria-controls="orgstructure-panel"
                  className={chartKind === kind ? "is-active" : undefined}
                  onClick={() => { setChartKind(kind); setSelected(null); }}
                >
                  {t(`orgStructure.chart_${kind}`)}
                </button>
              ))}
            </div>
            <label className="orgstructure__search orgstructure__search--name" htmlFor={searchId}>
              <span>{t("orgStructure.searchLabel")}</span>
              <input
                id={searchId}
                type="search"
                value={query}
                placeholder={t("orgStructure.searchPlaceholder")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="orgstructure__search" htmlFor={filterId}>
              <span>{t("orgStructure.filterLabel")}</span>
              <select id={filterId} value={seatFilter} onChange={(event) => setSeatFilter(event.target.value)}>
                {SEAT_FILTERS.map((filter) => <option key={filter} value={filter}>{t(`orgStructure.filter_${filter}`)}</option>)}
              </select>
            </label>
          </div>
          <div className="orgstructure__actions">
            <button type="button" onClick={() => setExpanded(branchIds(active.nodes))}>{t("orgStructure.expandAll")}</button>
            <button type="button" onClick={() => setExpanded(new Set())}>{t("orgStructure.collapseAll")}</button>
            <button type="button" onClick={() => { flushSync(() => setPrinting(true)); window.print(); }}><Printer size={16} aria-hidden="true" />{t("orgStructure.print")}</button>
            <button type="button" onClick={downloadChart}><Download size={16} aria-hidden="true" />{t("orgStructure.download")}</button>
          </div>
          <dl className="orgstructure__legend" aria-label={t("orgStructure.legendLabel")}>
            {["vacant", "unconfirmed", "unknown", "stale"].map((marker) => (
              <div key={marker}>
                <dt><span className={`orgstructure-marker orgstructure-marker--${marker}`}>{t(`orgStructure.marker_${marker}`)}</span></dt>
                <dd>{t(`orgStructure.markerHelp_${marker}`)}</dd>
              </div>
            ))}
          </dl>

          <div
            className="orgstructure__panel"
            role="region"
            id="orgstructure-panel"
            aria-labelledby={`orgstructure-kind-${active.chartKind}`}
          >
            {visibleNodes.length === 0 ? (
              <p className="orgstructure__empty">
                {query ? t("orgStructure.noMatches") : seatFilter !== "all" ? t("orgStructure.noFilterMatches") : t("orgStructure.emptyChart")}
              </p>
            ) : (
              <>
                <p className="orgstructure__count" aria-live="polite">
                  {t("orgStructure.count", { nodes: visibleNodes.length, edges: visibleEdges.length })}
                </p>
                <StructureCanvas
                  nodes={visibleNodes}
                  edges={visibleEdges}
                  label={t(`orgStructure.chart_${active.chartKind}`)}
                  selectedId={detail?.id ?? null}
                  onSelect={setSelected}
                  today={today}
                  t={t}
                />
                <StructureOutline
                  nodes={visibleNodes}
                  selectedId={detail?.id ?? null}
                  onSelect={setSelected}
                  expanded={expanded}
                  forceOpen={forceOpen}
                  onToggle={toggleBranch}
                  today={today}
                  t={t}
                  label={t("orgStructure.hierarchyLabel", { chart: t(`orgStructure.chart_${active.chartKind}`) })}
                />
              </>
            )}
            {detail && (
              <aside className="orgstructure__detail" aria-label={t("orgStructure.detailLabel")}>
                <h2>{detail.label}</h2>
                <dl>
                  <div><dt>{t("orgStructure.detailKind")}</dt><dd>{t(`orgStructure.nodeKind_${detail.nodeKind}`)}</dd></div>
                  {detail.subtitle && <div><dt>{t("orgStructure.detailSubtitle")}</dt><dd>{detail.subtitle}</dd></div>}
                  {detail.badge && <div><dt>{t("orgStructure.detailArea")}</dt><dd>{detail.badge}</dd></div>}
                  {detail.roleClass && <div><dt>{t("orgStructure.detailRoleClass")}</dt><dd>{detail.roleClass}</dd></div>}
                  {detail.chipLabel && <div><dt>{t("orgStructure.detailUnit")}</dt><dd>{detail.chipLabel}</dd></div>}
                  {/* The source's free-text reporting line. It is never coerced
                      into a parent edge, so it is shown as what it is. */}
                  {detail.reportsToLabel && <div><dt>{t("orgStructure.detailReportsTo")}</dt><dd>{detail.reportsToLabel}</dd></div>}
                  <div><dt>{t("orgStructure.detailStatus")}</dt><dd>{t(`orgStructure.status_${effectiveSeatStatus(detail, today)}`)}</dd></div>
                  {detail.vacant && <div><dt>{t("orgStructure.detailSeat")}</dt><dd>{t("orgStructure.detailVacant")}</dd></div>}
                  {detail.seatStatusReviewedOn && <div><dt>{t("orgStructure.detailReviewed")}</dt><dd>{calendarDay(detail.seatStatusReviewedOn, lang)}</dd></div>}
                  {detail.sourceLabel && <div><dt>{t("orgStructure.detailSource")}</dt><dd>{[detail.sourceLabel, calendarDay(detail.sourceAsOf, lang)].filter(Boolean).join(" · ")}</dd></div>}
                </dl>
                <button type="button" className="orgstructure__detail-close" onClick={() => setSelected(null)}>
                  {t("orgStructure.detailClose")}
                </button>
              </aside>
            )}
          </div>
          {/* Read-only by construction, and it says so: a member holds no write
              grant on the chart tables and the projection RPC has no write
              path, so there is no control here to offer. */}
          {source && <p className="orgstructure__source">{t("orgStructure.source", { source })}</p>}
          <p className="orgstructure__note">{t("orgStructure.readOnlyNote")}</p>
        </>
      )}
    </section>
  );
}
