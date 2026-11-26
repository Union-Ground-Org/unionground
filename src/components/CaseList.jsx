import { BusyButton, BusyInput } from "./BusyControls.jsx";
import { prepareBusyWrite, useBusyScope } from "../lib/busyWrite.js";
import { createSortedRowModel, flexRender, rowSortingFeature, sortFn_alphanumeric, sortFn_text, tableFeatures, useTable } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { caseTypeLabel } from "../lib/caseRowLine.js";
import { workspacePageForLocation } from "../lib/workspacePages.js";
import { useWorkspace, workspaceHref } from "./WorkspacePages.jsx";

// Shared case list for the coordinator queue and the steward caseload.
//
// URL contract. Every facet is its own flat query parameter so another plane
// can deep-link into a filtered list by writing the parameter it means —
// ?deadline=overdue&assignee=Sam%20Okafor — instead of having to reproduce an
// encoded blob. The dashboards lane (5.4) links with exactly these names.
// Sorting and the selected saved view carry their own keys. Unknown parameters
// are preserved so the routed-tab helpers, ?demo, ?embed, and ?case deep links
// survive a filter change. There is no step facet or column: Union Ground
// issues have no grievance procedure (owner decision, 2026-10-13), so a saved
// view or link naming ?step= is ignored.
const CASE_LIST_FILTERS = Object.freeze(["caseType", "assignee", "deadline", "status", "chapter"]);
const EMPTY_FILTERS = Object.freeze(Object.fromEntries(CASE_LIST_FILTERS.map((key) => [key, ""])));
const SORT_COLUMNS = Object.freeze(["member", "title", "deadline", "status"]);
const DEFAULT_SORT = Object.freeze([{ id: "deadline", desc: false }]);
const QUERY_SORT = "caseSort";
const QUERY_VIEW = "caseView";
// 7d/30d are the canonical spellings shared with the dashboards lane; the
// verbose spellings are accepted so a link written either way still lands.
const DEADLINE_WINDOWS = Object.freeze(["overdue", "7d", "30d", "none"]);
const DEADLINE_ALIASES = Object.freeze({ "7days": "7d", "30days": "30d", week: "7d", month: "30d" });
const MAX_FACET_VALUE = 160;

function safeObject(value, fallback) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

function normaliseDeadline(value) {
  const raw = String(value || "").trim().toLowerCase();
  const mapped = DEADLINE_ALIASES[raw] || raw;
  return DEADLINE_WINDOWS.includes(mapped) ? mapped : "";
}

function normaliseFilters(source) {
  const input = safeObject(source, {});
  return Object.fromEntries(CASE_LIST_FILTERS.map((key) => {
    if (key === "deadline") return [key, normaliseDeadline(input[key])];
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    return [key, value.slice(0, MAX_FACET_VALUE)];
  }));
}

// Table 9 bundles only the features a table registers. Every column sorts
// strings, so the default 'auto' sort resolves to one of these two, exactly
// as Table 8 chose them.
const TABLE_FEATURES = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});

function normaliseSorting(source) {
  const entry = Array.isArray(source) ? source[0] : null;
  if (!entry || !SORT_COLUMNS.includes(entry.id)) return [{ ...DEFAULT_SORT[0] }];
  return [{ id: entry.id, desc: Boolean(entry.desc) }];
}

// Reads the list state a URL describes. Exported so the planes and the tests
// can round-trip a link without mounting the table.
export function readCaseListUrl(search = window.location.search) {
  const params = new URLSearchParams(search);
  const [id = "", direction = ""] = String(params.get(QUERY_SORT) || "").split(":");
  return {
    filters: normaliseFilters(Object.fromEntries(CASE_LIST_FILTERS.map((key) => [key, params.get(key)]))),
    sorting: normaliseSorting([{ id, desc: direction === "desc" }]),
    viewId: (params.get(QUERY_VIEW) || "").slice(0, MAX_FACET_VALUE),
  };
}

// Writes the state back over whatever query the page already carries, so an
// unrelated parameter (?demo, ?embed, ?case) is never dropped by a facet edit.
export function caseListSearch(state, search = window.location.search) {
  const params = new URLSearchParams(search);
  const filters = normaliseFilters(state?.filters);
  for (const key of CASE_LIST_FILTERS) {
    if (filters[key]) params.set(key, filters[key]);
    else params.delete(key);
  }
  const [sort] = normaliseSorting(state?.sorting);
  if (sort.id === DEFAULT_SORT[0].id && sort.desc === DEFAULT_SORT[0].desc) params.delete(QUERY_SORT);
  else params.set(QUERY_SORT, `${sort.id}:${sort.desc ? "desc" : "asc"}`);
  if (state?.viewId) params.set(QUERY_VIEW, state.viewId);
  else params.delete(QUERY_VIEW);
  return params.toString();
}

function writeCaseListUrl(state) {
  const query = caseListSearch(state);
  const url = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  // replaceState, not pushState: a facet is a refinement of the page the
  // member is already on, and the routed-tab helpers own the history stack.
  window.history.replaceState(window.history.state, "", url);
}

// Day-granular buckets. A deadline is a calendar date, so the comparison is
// made at local noon against local midnight today — never a UTC instant that
// would flip a due-today case to overdue for anyone west of Greenwich.
function deadlineWindow(deadline, now = new Date()) {
  if (!deadline) return "none";
  const due = new Date(`${String(deadline).slice(0, 10)}T12:00:00`);
  if (!Number.isFinite(due.getTime())) return "none";
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days < 0) return "overdue";
  if (days <= 7) return "7d";
  if (days <= 30) return "30d";
  return "later";
}

// The assignee facet keys on the user id the loader exposes, never on the
// display name: two stewards called "J. Rivera" are two people, and the
// ?assignee=<id> link lane 5.4 writes has to keep them apart. A loader that
// carries no id (the demo hat, the member-app case shape) still keys on the
// name, which is the best identity that data has. A loader that carries no
// assignee at all — the steward desk, where every row is the reader's own
// case and the only name on the row is the case's COORDINATOR — yields an
// empty key, and the facet hides itself rather than filter by the wrong
// person (lane review finding #8).
function assigneeKey(row) {
  return row.assigneeId || row.assigneeName || row.stewardUserId || row.stewardName || "";
}

function assigneeLabel(row) {
  return row.assigneeName || row.stewardName || assigneeKey(row);
}

function facetValue(row, field, now) {
  if (field === "assignee") return assigneeKey(row);
  if (field === "chapter") return row.chapterName || row.chapterId || "";
  if (field === "deadline") return deadlineWindow(row.deadline, now);
  if (field === "caseType") return row.caseType || "";
  return row[field] || "";
}

// The label a facet option shows when the option's VALUE is an opaque key.
function facetOptionLabel(row, field) {
  return field === "assignee" ? assigneeLabel(row) : "";
}

function matchesExcept(row, filters, skip, now) {
  return CASE_LIST_FILTERS.every((field) => {
    if (field === skip || !filters[field]) return true;
    return facetValue(row, field, now) === filters[field];
  });
}

// openstatus data-table-filters (MIT) is the reference for the pattern: each
// facet counts the rows the OTHER facets already admit, so a member can see
// what a refinement would cost before making it.
function facetOptions(rows, field, filters, now) {
  const counts = new Map();
  for (const row of rows) {
    if (!matchesExcept(row, filters, field, now)) continue;
    const value = facetValue(row, field, now);
    if (!value) continue;
    const entry = counts.get(value) || { count: 0, label: facetOptionLabel(row, field) };
    entry.count += 1;
    counts.set(value, entry);
  }
  if (field === "deadline") {
    return DEADLINE_WINDOWS.filter((value) => counts.has(value) || filters.deadline === value)
      .map((value) => ({ value, count: counts.get(value)?.count || 0, label: "" }));
  }
  const selected = filters[field];
  if (selected && !counts.has(selected)) counts.set(selected, { count: 0, label: "" });
  return [...counts.entries()]
    .map(([value, entry]) => ({ value, count: entry.count, label: entry.label }))
    .sort((a, b) => (a.label || a.value).localeCompare(b.label || b.value));
}

// The case dashboards (5.4) are the exact-count surface these windowed numbers
// defer to. The coordinator plane reaches them as a routed tab; the steward
// plane mounts the same tiles inside its own caseload page, so there is no
// second steward destination to send anyone to. The affordance is therefore
// derived from the ROUTE REGISTRY, never from a hand-written fragment: until
// the dashboards route is registered the copy says the surface is not on this
// build and no link is rendered, so nothing promises a destination that does
// not exist.
const COORDINATOR_DASHBOARDS_PATH = "/m/coordinator/cases/dashboards";

function facetOptionText(t, countsWindowed, label, count) {
  return t(countsWindowed ? "caseListWindow.optionWithCount" : "caseList.optionWithCount", { label, count });
}

function caseDashboardsPath(plane) {
  if (plane !== "coordinator") return "";
  return workspacePageForLocation(COORDINATOR_DASHBOARDS_PATH) ? COORDINATOR_DASHBOARDS_PATH : "";
}

function CaseDashboardsLink({ plane, t }) {
  const workspace = useWorkspace();
  const destination = caseDashboardsPath(plane);
  if (!destination) return null;
  return (
    <a
      className="case-list__control case-list__btn"
      href={workspaceHref(destination)}
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!workspace?.open) return;
        event.preventDefault();
        workspace.open(destination);
      }}
    >
      {t("caseListWindow.dashboardsLink")}
    </a>
  );
}

function CaseListFacet({ field, value, options, labelFor, onChange, t, countsWindowed }) {
  const id = `case-list-facet-${field}`;
  return (
    <p className="case-list__facet">
      <label htmlFor={id}>{t(`caseList.filter${field[0].toUpperCase()}${field.slice(1)}`)}</label>
      <select id={id} className="case-list__control" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t("caseList.all")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {facetOptionText(t, countsWindowed, option.label || labelFor(option.value), option.count)}
          </option>
        ))}
      </select>
    </p>
  );
}

// Saved views are private presentation state. The switcher only appears when
// the plane supplies the whole adapter — an isolated render or a plane without
// the RPCs shows the list without inventing a persistence surface.
const SAVED_VIEW_REFUSALS = new Set(["22023", "23505", "42501"]);

function SavedViewSwitcher({ plane, api, state, onApply, onNotice, t, describedBy }) {
  const busyWriteRef = useRef(new Set());
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [views, setViews] = useState([]);
  const [loadState, setLoadState] = useState("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const refreshRequired = useRef(false);
  const reading = loadState === "loading" || loadState === "retrying";
  const appliedDefault = useRef(false);

  const readViews = useCallback(async () => {
    const listed = await api.listSavedViews(plane);
    return Array.isArray(listed) ? listed : [];
  }, [api, plane]);

  function reportLoadFailure() {
    setLoadState("error");
    onNotice?.(t("caseList.viewsUnavailable"));
  }

  useEffect(() => {
    let live = true;
    readViews().then((listed) => {
      if (!live || !mounted.current) return;
      setViews(listed);
      setLoadState("ready");
      if (refreshRequired.current) {
        refreshRequired.current = false;
        setFailure(null);
      }
      // A link that names a view wins everything: deep-linking by id must
      // show that view's definition, not just select it in the switcher.
      // Otherwise a default view is a starting point, not an override: a link
      // that already carries facets wins over the default.
      if (appliedDefault.current) return;
      appliedDefault.current = true;
      if (state.viewId) {
        const linked = listed.find((view) => view.id === state.viewId);
        if (linked) onApply(linked, state);
        return;
      }
      if (Object.values(state.filters).some(Boolean)) return;
      const preferred = listed.find((view) => view.isDefault);
      if (preferred) onApply(preferred, state);
    }).catch(() => { if (live && mounted.current) reportLoadFailure(); });
    return () => { live = false; };
    // Run for the adapter or an explicit retry: running on every state edit would
    // re-apply the default over the member's own refinement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readViews, loadAttempt]);

  const selected = views.find((view) => view.id === state.viewId) || null;

  const select = (id) => {
    const view = views.find((entry) => entry.id === id);
    onApply(view || { id: "", definition: { filters: EMPTY_FILTERS, sorting: DEFAULT_SORT } });
  };

  const writeView = (write, failureKey, unconfirmedKey, onWritten) => async (release) => {
    setBusy(true);
    setFailure(null);
    try {
      let result;
      try {
        result = await write();
      } catch (error) {
        if (mounted.current) {
          const unknown = !SAVED_VIEW_REFUSALS.has(error?.code);
          const key = unknown ? unconfirmedKey : failureKey;
          refreshRequired.current = unknown;
          setFailure({ key, unknown });
          onNotice?.(t(key));
        }
        return;
      }
      if (!mounted.current) return;
      // A successful write and a failed follow-up read are separate results.
      let listed = null;
      try {
        listed = await readViews();
        if (!mounted.current) return;
        setViews(listed);
        setLoadState("ready");
      } catch {
        if (!mounted.current) return;
        reportLoadFailure();
      }
      onWritten(result, listed);
    } finally {
      if (mounted.current) setBusy(false);
      release();
    }
  };

  const save = (event) => prepareBusyWrite(busyWriteRef, "write", () => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy || reading || refreshRequired.current) return;
    const definition = { filters: state.filters, sorting: state.sorting };
    return writeView(
      () => api.saveSavedView({ plane, name: trimmed, definition, isDefault }),
      "caseList.viewSaveFailed",
      "caseList.viewSaveUnconfirmed",
      (saved, listed) => {
        const view = saved?.id
          ? { name: trimmed, definition, isDefault, ...saved }
          : listed?.find((item) => item.name === trimmed);
        if (!listed) {
          if (!view) return;
          setViews((current) => [view, ...current.filter((item) => item.id !== view.id).map((item) => (
            view.isDefault && item.isDefault ? { ...item, isDefault: false } : item
          ))]);
        }
        setName("");
        setIsDefault(false);
        onApply(view || { id: "", definition });
      },
    );
  }, event);

  const remove = () => prepareBusyWrite(busyWriteRef, "write", () => {
    if (!selected || busy || reading || refreshRequired.current) return;
    return writeView(
      () => api.deleteSavedView(selected.id),
      "caseList.viewDeleteFailed",
      "caseList.viewDeleteUnconfirmed",
      (_result, listed) => {
        if (!listed) setViews((current) => current.filter((view) => view.id !== selected.id));
        onApply({ id: "", definition: { filters: state.filters, sorting: state.sorting } });
      },
    );
  });

  function retryLoad() {
    setLoadState("retrying");
    setLoadAttempt((attempt) => attempt + 1);
  }

  return (
    // The description belongs on the SELECT, not on this wrapper: a plain div
    // carries no role, so aria-describedby on it is never announced.
    <div className="case-list__views" data-load-state={loadState}>
      <p className="case-list__facet">
        <label htmlFor="case-list-saved-view">{t("caseList.savedViews")}</label>
        <select id="case-list-saved-view" className="case-list__control" value={selected?.id ?? ""} aria-describedby={describedBy} onChange={(event) => select(event.target.value)}>
          <option value="">{t("caseList.currentView")}</option>
          {views.map((view) => (
            <option key={view.id} value={view.id}>{view.isDefault ? t("caseList.defaultViewName", { name: view.name }) : view.name}</option>
          ))}
        </select>
      </p>
      <form className="case-list__viewform" onSubmit={save}>
        <p className="case-list__facet">
          <label htmlFor="case-list-view-name">{t("caseList.viewName")}</label>
          <input id="case-list-view-name" className="case-list__control" value={name} maxLength={80} readOnly={busy} onChange={(event) => setName(event.target.value)} />
        </p>
        <label className="case-list__default">
          <BusyInput type="checkbox" checked={isDefault} pending={busy} onChange={(event) => setIsDefault(event.target.checked)} />
          <span>{t("caseList.makeDefault")}</span>
        </label>
        <BusyButton type="submit" className="case-list__control case-list__btn" pending={busy || reading} disabled={!name.trim() || failure?.unknown}>{t("caseList.saveView")}</BusyButton>
        {selected && <BusyButton type="button" className="case-list__control case-list__btn case-list__btn--danger" pending={busy || reading} disabled={failure?.unknown} onClick={remove}>{t("caseList.deleteView")}</BusyButton>}
      </form>
      {!onNotice && failure && <p role="alert">{t(failure.key)}</p>}
      {!onNotice && loadState === "error" && <p role="alert">{t("caseList.viewsUnavailable")}</p>}
      {(loadState === "error" || loadState === "retrying" || failure?.unknown) && <BusyButton type="button" className="case-list__control case-list__btn" pending={busy || reading} onClick={retryLoad}>{t(failure?.unknown ? "caseList.refreshSavedViews" : "app.tryAgain")}</BusyButton>}
    </div>
  );
}

export function CaseList({
  plane,
  rows,
  onOpenCase,
  expandedCaseId = null,
  renderDetail = null,
  savedViewsApi = null,
  onNotice = null,
  urgencyOf = null,
  // Lane 5.6 multi-select. The list owns no selection model: a plane that
  // wants checkboxes hands one node per row (renderRowLead) and learns which
  // ids the current page is showing (onVisibleRowsChange), so "select all
  // visible" means the rows the facets, the sort and the window actually left
  // on screen — not the plane's unfiltered array.
  renderRowLead = null,
  onVisibleRowsChange = null,
  // The NAMES of the facets currently narrowing the list, reported for the
  // export receipt (SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917).
  // Names only: a facet VALUE can be a member's id or a case type, and none of
  // that belongs in an audit row.
  onActiveFiltersChange = null,
  countsWindowed = false,
  visibleCount = null,
  canLoadMore = false,
  loadMoreBusy = false,
  moreLabel = null,
  onLoadMore = null,
  className = "",
  emptyLabel = "",
  formatStatus = (value) => value,
  formatDeadline = null,
}) {
  const { t } = useLang();
  const savedViewScope = useMemo(() => ({ api: savedViewsApi, plane }), [savedViewsApi, plane]);
  const { generation: savedViewGeneration } = useBusyScope(savedViewScope);
  const [state, setState] = useState(() => readCaseListUrl());
  // The per-cell renderers below are memoised, and TanStack passes each cell's
  // renderer to React as a component TYPE. A plane that hands this list a fresh
  // inline urgencyOf/format* closure on every one of its own renders would
  // therefore change that type on every render, and React would tear down and
  // rebuild every cell's DOM — dropping row focus and detaching nodes a caller
  // is holding. The closures are read through refs so the column definitions
  // stay stable while still calling the plane's latest function.
  const planeRef = useRef({ urgencyOf, formatStatus, formatDeadline });
  planeRef.current = { urgencyOf, formatStatus, formatDeadline };
  const bodyRef = useRef(null);
  // One clock for the whole render pass so the facet counts and the rows they
  // describe cannot disagree across a midnight boundary mid-render.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(id);
  }, []);

  // Back/forward must repaint the list: the state lives in the URL, so the
  // browser's own navigation is the source of truth after a pop.
  useEffect(() => {
    const sync = () => setState(readCaseListUrl());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const update = useCallback((next, expectedState = null) => {
    setState((previous) => {
      // An initial saved-view read may finish after a filter or navigation
      // update, including one still queued in React. Never replace that edit.
      if (expectedState && previous !== expectedState) return previous;
      const value = typeof next === "function" ? next(previous) : next;
      const settled = { filters: normaliseFilters(value.filters), sorting: normaliseSorting(value.sorting), viewId: value.viewId || "" };
      writeCaseListUrl(settled);
      return settled;
    });
  }, []);

  const applyView = useCallback((view, expectedState = null) => {
    const definition = safeObject(view?.definition, {});
    update({ filters: definition.filters, sorting: definition.sorting, viewId: view?.id || "" }, expectedState);
  }, [update]);

  const setFilter = useCallback((field, value) => {
    // Editing a facet leaves the saved view: the list now shows the member's
    // refinement, and the switcher must not claim otherwise.
    update((current) => ({ ...current, filters: { ...current.filters, [field]: value }, viewId: "" }));
  }, [update]);

  const deadlineLabel = useCallback((value) => t(`caseList.deadline${value === "overdue" ? "Overdue" : value === "7d" ? "7d" : value === "30d" ? "30d" : "None"}`), [t]);
  const labelFor = useCallback((field) => (value) => {
    if (field === "deadline") return deadlineLabel(value);
    if (field === "caseType") return caseTypeLabel(value, t);
    if (field === "status") return planeRef.current.formatStatus(value);
    return value;
  }, [deadlineLabel, t]);

  // The open case always survives the facets. A drilldown, a ?case= deep link,
  // or a docket hop can land on a row a saved view excludes; expanding it out
  // of sight would look like the app swallowed the click.
  const filteredRows = useMemo(
    () => rows.filter((row) => row.id === expandedCaseId
      || CASE_LIST_FILTERS.every((field) => !state.filters[field] || facetValue(row, field, now) === state.filters[field])),
    [expandedCaseId, now, rows, state.filters],
  );

  const columns = useMemo(() => [
    {
      // The member cell carries what the queue row has always carried: the
      // initials avatar (the steward caseload card painted one too) and, when
      // the plane computes urgency, the reason chip that says WHY a case is at
      // the top of the list. Both are restored here rather than in a plane so
      // the two planes cannot drift apart again.
      id: "member",
      accessorFn: (row) => row.memberName || "",
      header: t("caseList.member"),
      cell: (info) => {
        const row = info.row.original;
        const { urgencyOf: urgency } = planeRef.current;
        const reason = urgency ? urgency(row) : null;
        return (
          <span className="case-list__member">
            {row.memberInitials ? <span className="gq-av case-list__av" aria-hidden="true" data-initials={row.memberInitials} /> : null}
            <span className="case-list__identity">
              <strong className="gq-name">{row.memberName}</strong>{" "}
              <small className="gq-ref">{row.reference}</small>
              {reason ? <span className={`gq-reason gq-reason--${reason.tone}`}>{reason.label}</span> : null}
            </span>
          </span>
        );
      },
    },
    {
      id: "title",
      accessorFn: (row) => row.title || "",
      header: t("caseList.case"),
      cell: (info) => <><span className="gq-issue">{info.getValue()}</span><small>{caseTypeLabel(info.row.original.caseType, t)}</small></>,
    },
    {
      // Undated cases sort last in both directions of intent: an empty
      // deadline is not "the most urgent thing in the chapter".
      id: "deadline",
      accessorFn: (row) => (row.deadline ? String(row.deadline).slice(0, 10) : "9999-12-31"),
      header: t("caseList.deadline"),
      cell: (info) => {
        const row = info.row.original;
        const window_ = deadlineWindow(row.deadline, now);
        // The row flag wins when the plane ships one: the coordinator queue
        // computes overdue once at load, and the docket, KPIs, and the old
        // card row all read that same flag. Rows without it (steward desk)
        // fall back to the local day-granular window.
        const overdue = typeof row.overdue === "boolean" ? row.overdue : window_ === "overdue";
        const { formatDeadline: format } = planeRef.current;
        const text = format ? format(row) : row.deadlineLabel || row.deadline || t("caseList.deadlineNone");
        // The overdue flag is text, not just tone: the queue has always read
        // "Overdue"/"Vencido" here, and a colour-only signal fails the
        // contrast covenant anyway.
        return (
          <span className={`gq-due${overdue ? " gq-due--over" : ""}`}>
            {text}
            {overdue && <small className="gq-status gq-status--over">{t("caseList.deadlineOverdue")}</small>}
          </span>
        );
      },
    },
    {
      id: "status",
      accessorFn: (row) => row.status || "",
      header: t("caseList.status"),
      cell: (info) => <span className="gq-status">{planeRef.current.formatStatus(info.getValue())}</span>,
    },
  ], [now, t]);

  const table = useTable({
    features: TABLE_FEATURES,
    data: filteredRows,
    columns,
    state: { sorting: state.sorting },
    onSortingChange: (next) => update((current) => ({
      ...current,
      sorting: typeof next === "function" ? next(current.sorting) : next,
      viewId: "",
    })),
    getRowId: (row) => row.id,
  });

  const sortedRows = table.getRowModel().rows;
  const pageRows = typeof visibleCount === "number" ? sortedRows.slice(0, visibleCount) : sortedRows;
  const remaining = sortedRows.length - pageRows.length;

  // Reported through a joined key rather than the array: pageRows is rebuilt
  // on every render, so an effect keyed on its identity would fire forever.
  const pageRowKey = pageRows.map((row) => row.id).join("\u0000");
  useEffect(() => {
    if (!onVisibleRowsChange) return;
    onVisibleRowsChange(pageRowKey ? pageRowKey.split("\u0000") : []);
  }, [onVisibleRowsChange, pageRowKey]);

  // Roving focus over the row triggers. Home/End reach the ends of the loaded
  // page without a mouse, which is the whole point on a 200-row caseload.
  const focusRow = (index) => {
    const triggers = bodyRef.current?.querySelectorAll(".case-list__open");
    if (!triggers?.length) return;
    const clamped = Math.max(0, Math.min(triggers.length - 1, index));
    triggers[clamped].focus();
  };
  const onRowKeyDown = (event, index) => {
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: pageRows.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    focusRow(moves[event.key]);
  };

  const activeFilters = CASE_LIST_FILTERS.filter((field) => state.filters[field]);
  // Same joined-key discipline as the visible rows above: the derived array is
  // rebuilt on every render, so the effect keys on its text, not its identity.
  const activeFilterKey = activeFilters.join("\u0000");
  useEffect(() => {
    if (!onActiveFiltersChange) return;
    onActiveFiltersChange(activeFilterKey ? activeFilterKey.split("\u0000") : []);
  }, [onActiveFiltersChange, activeFilterKey]);
  // A facet the loaded rows carry no data for is not rendered: an empty
  // "Assignee" select on the steward desk invites a filter that can only ever
  // return nothing, and the old fallback filled it with the case's
  // coordinator, who is not the assignee. A facet whose filter is already set
  // always renders, so a deep link can be cleared from the list it filtered.
  const facets = CASE_LIST_FILTERS
    .map((field) => ({ field, options: facetOptions(rows, field, state.filters, now) }))
    .filter(({ field, options }) => options.length > 0 || state.filters[field]);
  // Counts are computed over the rows this plane has loaded. When that is a
  // window of a larger set, the list says so instead of implying a total.
  const countsNoteId = `case-list-counts-${plane}`;
  // A paged list names both numbers, so "85" never reads as the rows on
  // screen when 30 are (Lovable audit APP-COORDINATOR-03, -04).
  const paged = pageRows.length < sortedRows.length;
  const countKey = countsWindowed
    ? (paged ? "caseList.resultsWindowPaged" : "caseList.resultsWindow")
    : (paged ? "caseList.resultsPaged" : "caseList.results");

  return (
    <section className={`case-list ${className}`.trim()} aria-label={t("caseList.label")} data-plane={plane} data-reactive-depth="panel">
      <header className="case-list__head">
        <div className="case-list__headline">
          <span className="case-list__eyebrow"><SlidersHorizontal size={15} aria-hidden="true" />{t("caseList.label")}</span>
          <p className="case-list__count" role="status">{t(countKey, { count: sortedRows.length, shown: pageRows.length })}</p>
        </div>
        {savedViewsApi?.listSavedViews && savedViewsApi?.saveSavedView && savedViewsApi?.deleteSavedView && (
          <SavedViewSwitcher key={savedViewGeneration} plane={plane} api={savedViewsApi} state={state} onApply={applyView} onNotice={onNotice} t={t} describedBy={countsWindowed ? countsNoteId : undefined} />
        )}
      </header>

      <div className="case-list__facets" role="group" aria-label={t("caseList.filters")} aria-describedby={countsWindowed ? countsNoteId : undefined}>
        {facets.map(({ field, options }) => (
          <CaseListFacet
            key={field}
            field={field}
            value={state.filters[field]}
            options={options}
            labelFor={labelFor(field)}
            onChange={(value) => setFilter(field, value)}
            t={t}
            countsWindowed={countsWindowed}
          />
        ))}
        {activeFilters.length > 0 && (
          <button type="button" className="case-list__control case-list__btn" onClick={() => update((current) => ({ filters: EMPTY_FILTERS, sorting: current.sorting, viewId: "" }))}>
            {t("caseList.clearFilters")}
          </button>
        )}
        {countsWindowed && (
          <p className="case-list__caveat" id={countsNoteId}>
            {t("caseList.countsWindow", { count: rows.length })}
            {" "}
            {t(caseDashboardsPath(plane) ? "caseListWindow.dashboardsSource" : "caseListWindow.dashboardsPending")}
          </p>
        )}
        {countsWindowed && <CaseDashboardsLink plane={plane} t={t} />}
      </div>

      <div className="case-list__scroll">
        <table className="case-list__table">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th key={header.id} scope="col" data-column={header.column.id} aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}>
                      <button type="button" className="case-list__sort" onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === "asc" && <ChevronUp size={14} aria-label={t("caseList.ascending")} />}
                        {sorted === "desc" && <ChevronDown size={14} aria-label={t("caseList.descending")} />}
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody ref={bodyRef}>
            {pageRows.map((row, index) => {
              const item = row.original;
              const open = expandedCaseId === item.id;
              return [
                <tr key={row.id} className={`gq-row case-list__tr${open ? " case-list__tr--open" : ""}`} data-reactive-depth="row">
                  {row.getAllCells().map((cell, cellIndex) => {
                    if (cellIndex !== 0) {
                      return (
                        <td key={cell.id} data-column={cell.column.id} data-label={String(cell.column.columnDef.header)}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    }
                    const trigger = (
                      <button
                        type="button"
                        // gq-row__btn keeps the queue row's established
                        // selector and aria contract reachable through the
                        // new table (docket hops, ?case= links, and the
                        // coordinator regression suite all speak it).
                        className="case-list__open gq-row__btn"
                        data-case-list-row-index={index}
                        aria-expanded={open}
                        aria-label={t("caseList.openCase", { member: item.memberName || "", reference: item.reference || "", title: item.title || "" })}
                        onKeyDown={(event) => onRowKeyDown(event, index)}
                        onClick={() => onOpenCase(item, open)}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </button>
                    );
                    return (
                      <td key={cell.id} data-column={cell.column.id} data-label={String(cell.column.columnDef.header)}>
                        {/* The lead node (lane 5.6's select box) is a sibling
                            of the trigger, never a child: a checkbox inside a
                            button is not operable with a keyboard. A plane
                            that supplies none keeps the original markup. */}
                        {renderRowLead
                          ? <span className="case-list__lead">{renderRowLead(item)}{trigger}</span>
                          : trigger}
                      </td>
                    );
                  })}
                </tr>,
                open && renderDetail
                  ? <tr key={`${row.id}-detail`} className="case-list__detailrow"><td colSpan={columns.length}>{renderDetail(item)}</td></tr>
                  : null,
              ];
            })}
          </tbody>
        </table>
      </div>

      {sortedRows.length === 0 && <p className="case-list__empty gq-empty">{emptyLabel || t("caseList.empty")}</p>}

      {(remaining > 0 || canLoadMore) && onLoadMore && (
        <BusyButton type="button" className="case-list__control case-list__btn case-list__more outline-pill gq-more" pending={loadMoreBusy} onClick={() => onLoadMore(remaining)}>
          {moreLabel ? moreLabel(remaining) : t("caseList.loadMore")}
        </BusyButton>
      )}
    </section>
  );
}
