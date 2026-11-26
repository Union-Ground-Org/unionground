import { useEffect, useMemo, useRef, useState } from "react";
import { Lightbulb, Trash2 } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { countKey, dateTimeFormat } from "../lib/i18n.js";
import { caseTypeLabel } from "../lib/caseRowLine.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import "../lib/i18n/features/csvExportsStrings.js";
import { csvEscape } from "../lib/caseExport.js";
import { WORKLOAD_CATEGORY_KEYS } from "../lib/workloadCategories.js";
import { hasOriginalWorkloadCounts } from "../lib/workloadConfiguration.js";
import { MemberReportCard } from "../features/analytics/ui/MemberReportCard.jsx";
import { healthBandThresholds } from "../lib/configurableThresholds.js";
import AltPageKpis from "../alt/AltPageKpis.jsx";
import { Icon as AltIcon } from "../alt/icons.jsx";
import { TakePartHero } from "../alt/takepart/TakePartHero.jsx";
import { BarChart, DataTable, HBars } from "../alt/takepart/charts.jsx";
import { UnionStatistics } from "../alt/takepart/UnionStatistics.jsx";
import { quorumTurnoutText } from "../lib/quorumTurnout.js";
import { ArrivalCount, ChartArrival, arriveAt } from "../components/ChartArrival.jsx";
import "../lib/i18n/features/altTakePartStrings.js";

// "My reports" (prototype page id `mreports`): a personal analytics dashboard
// of the member's own stats, rendered as a customizable card grid with a
// build-a-chart composer and a per-card drill-in detail panel. Every figure on
// this screen is derived from data the app already loads for this member —
// weekly goal + day activity, voting participation (plan items), action
// counts, cases, workload logs, and learning progress. There is no points or
// tier card: Union Ground has no points economy. Nothing here is invented:
// where the prototype shows a series the client payload does not carry
// (per-kind action breakdown), the card degrades to the real figures it does
// have.

// Match the member namespacing used by the device-parity rail preferences.
// A missing identity gets no persistent fallback rather than a shared key.
function memberReportStorageKey(memberId, key) {
  return typeof memberId === "string" && memberId ? `sg:member:${memberId}:reports:${key}` : null;
}

function readStored(key, fallback) {
  try {
    if (!key) return fallback;
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    if (!key) return;
    if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable (private mode); the layout just stops persisting.
  }
}

const ROW_COLORS = ["var(--green)", "var(--gold)", "var(--terra)", "var(--sg-color-case)"];

// Bars scale 6..36px against the series max, exactly like the prototype's
// `_sparkOf`; `valText` overrides the numeric value in tooltips/history (the
// weekly-goal spark shows ✓/— instead of 1/0).
function sparkOf(points, bg) {
  const max = Math.max(...points.map((point) => point.v), 1);
  return points.map((point) => ({
    v: point.v,
    h: Math.round(6 + (30 * point.v) / max),
    bg,
    label: point.label,
    val: point.valText ?? String(point.v),
    tip: `${point.label} · ${point.valText ?? point.v}`,
  }));
}

function buildCards(data, t, lang) {
  const metrics = data.metrics ?? {};
  const rewards = data.rewards ?? null;
  const weekly = data.weekly ?? null;
  const weekDays = Array.isArray(data.weekDays) ? data.weekDays : [];
  const planItems = Array.isArray(data.planItems) ? data.planItems : [];
  const lessons = data.rights?.lessonRecords ?? [];
  const entries = (data.workload?.entries ?? []).filter(hasOriginalWorkloadCounts);
  const cards = [];
  const byMetric = {};

  if (weekly && weekly.goal != null && weekDays.length) {
    const remaining = Math.max(0, (weekly.goal ?? 0) - (weekly.done ?? 0));
    cards.push({
      key: "weekly",
      title: t("reports.weeklyTitle"),
      tag: t("reports.tagThisWeek"),
      big: `${weekly.done ?? 0}/${weekly.goal ?? 0}`,
      delta: remaining === 0 ? t("reports.weeklyMet") : t("reports.weeklyToGo", { count: remaining }),
      sub: t("reports.weeklySub"),
      spark: sparkOf(weekDays.map((day) => ({ v: day.active ? 1 : 0, label: day.label, valText: day.active ? "✓" : "—" })), "var(--gold)"),
      sparkFrom: weekDays[0]?.label ?? "",
      sparkTo: weekDays[weekDays.length - 1]?.label ?? "",
    });
  }

  const votable = planItems.filter((item) => item.kind === "ballot" || item.kind === "pulse");
  if (votable.length) {
    const isCast = (item) => Boolean(item.selectedOption || item.receiptCode);
    const ballots = votable.filter((item) => item.kind === "ballot");
    const pulses = votable.filter((item) => item.kind === "pulse");
    const cast = votable.filter(isCast).length;
    const rows = [];
    if (ballots.length) {
      const done = ballots.filter(isCast).length;
      rows.push({ label: t("reports.rowBallots"), w: Math.round((100 * done) / ballots.length), val: `${done}/${ballots.length}`, color: "var(--green)" });
    }
    if (pulses.length) {
      const done = pulses.filter(isCast).length;
      rows.push({ label: t("reports.rowPulses"), w: Math.round((100 * done) / pulses.length), val: `${done}/${pulses.length}`, color: "var(--gold)" });
    }
    const card = {
      key: "votes",
      title: t("reports.votingTitle"),
      tag: t("reports.tagRecent"),
      big: t("reports.votingBig", { cast, total: votable.length }),
      delta: `${Math.round((100 * cast) / votable.length)}%`,
      sub: t("reports.votingSub"),
      rows: rows.length ? rows : null,
    };
    cards.push(card);
    byMetric.votes = card;
  }

  if (metrics.tasksDone != null || rewards?.actionsYtd != null) {
    const week = metrics.tasksDone ?? 0;
    const ytd = rewards?.actionsYtd ?? null;
    const card = {
      key: "actions",
      title: t("reports.actionsTitle"),
      tag: ytd != null ? t("reports.tagYtd") : t("reports.tag7d"),
      big: String(ytd ?? week),
      delta: week > 0 ? `▲ ${week}` : "",
      sub: t("reports.actionsSub"),
      big7d: String(week),
      bigYtd: ytd != null ? String(ytd) : null,
    };
    cards.push(card);
    byMetric.actions = card;
  }

  if (metrics.caseTypes) {
    const caseTypes = metrics.caseTypes ?? [];
    const max = Math.max(...caseTypes.map((item) => item.value), 1);
    cards.push({
      key: "cases",
      title: t("reports.casesTitle"),
      tag: t("reports.tagAllTime"),
      big: t(countKey("reports.casesBigOpen", metrics.openCases ?? 0), { count: metrics.openCases ?? 0 }),
      delta: t("reports.casesDelta", { count: metrics.resolvedCases ?? 0 }),
      sub: t("reports.casesSub"),
      rows: caseTypes.length
        ? caseTypes.map((item, index) => ({ label: caseTypeLabel(item.label, t), w: Math.round((100 * item.value) / max), val: String(item.value), color: ROW_COLORS[index % ROW_COLORS.length] }))
        : null,
      foot: t("reports.casesFoot", { count: metrics.casesHandled ?? 0 }),
    });
  }

  if (entries.length) {
    // Logged workload — the member's own private ledger entries. Each bar is
    // one submitted log's total item count; entries arrive newest-first.
    const totals = entries.map((entry) => WORKLOAD_CATEGORY_KEYS.reduce((sum, key) => sum + entry.counts[key], 0));
    const recent = entries.slice(0, 8).map((entry, index) => {
      const date = new Date(entry.createdAt || "");
      const label = Number.isNaN(date.getTime()) ? "" : dateTimeFormat(lang, { month: "short", day: "numeric", timeZone: "America/New_York" }).format(date);
      return { entry, label, total: totals[index] };
    }).reverse();
    const average = totals.reduce((sum, value) => sum + value, 0) / totals.length;
    const card = {
      key: "hours",
      title: t("reports.workloadTitle"),
      tag: t("reports.tagPerLog"),
      big: Number.isInteger(average) ? String(average) : average.toFixed(1),
      delta: t("reports.workloadDelta", { count: entries.length }),
      sub: t("reports.workloadSub"),
      spark: sparkOf(recent.map((row) => ({ v: row.total, label: row.label })), "var(--terra)"),
      sparkFrom: recent[0]?.label ?? "",
      sparkTo: t("reports.latest"),
      foot: t("reports.workloadFoot"),
    };
    cards.push(card);
    byMetric.hours = card;
  }

  if (lessons.length) {
    const totalSteps = lessons.reduce((sum, lesson) => sum + (lesson.steps?.length ?? 0), 0);
    const doneSteps = lessons.reduce((sum, lesson) => sum + Math.min(lesson.completedSteps?.length ?? 0, lesson.steps?.length ?? 0), 0);
    cards.push({
      key: "learn",
      title: t("reports.learnTitle"),
      tag: t("reports.tagGuides"),
      big: `${totalSteps ? Math.round((100 * doneSteps) / totalSteps) : 0}%`,
      delta: "",
      sub: t("reports.learnSub"),
      rows: lessons.slice(0, 5).map((lesson) => {
        const steps = lesson.steps?.length ?? 0;
        const pct = steps ? Math.round((100 * Math.min(lesson.completedSteps?.length ?? 0, steps)) / steps) : 0;
        return { label: lesson.label, w: pct, val: pct >= 100 ? "✓" : pct > 0 ? `${pct}%` : "—", color: pct >= 100 ? "var(--green)" : "var(--gold)" };
      }),
    });
  }

  const builderMetrics = [
    byMetric.actions && { id: "actions", label: t("reports.mActions") },
    byMetric.votes && { id: "votes", label: t("reports.mVotes") },
    byMetric.hours && { id: "hours", label: t("reports.mWorkload") },
  ].filter(Boolean);

  return { cards, byMetric, builderMetrics };
}

// A custom card re-renders a base metric's REAL data in the picked shape. A
// chart kind the metric cannot honestly support falls back to the nearest one
// it can (a metric with no per-week series client-side renders its breakdown
// for "bars over time"). The tag always names the true window the
// figures cover — the range pick only switches scope where a real value for
// that scope exists (actions: 7 days vs YTD).
function materializeCustom(custom, byMetric, t) {
  const base = byMetric[custom.metric];
  if (!base) return null;
  let kind = custom.kind;
  if (kind === "spark" && !base.spark) kind = base.rows ? "rows" : "stat";
  if (kind === "rows" && !base.rows) kind = base.spark ? "spark" : "stat";
  let big = base.big;
  let windowTag = base.tag;
  if (custom.metric === "actions") {
    if (custom.range === "recent" && base.big7d != null) {
      big = base.big7d;
      windowTag = t("reports.tag7d");
    } else if (custom.range !== "recent" && base.bigYtd != null) {
      big = base.bigYtd;
      windowTag = t("reports.tagYtd");
    }
  }
  return {
    key: custom.id,
    custom: true,
    title: base.title,
    tag: `${windowTag} · ${t("reports.customTag")}`,
    big,
    delta: base.delta,
    sub: t("reports.customSub"),
    spark: kind === "spark" ? base.spark : null,
    sparkFrom: base.sparkFrom,
    sparkTo: base.sparkTo,
    rows: kind === "rows" ? base.rows : null,
    foot: null,
  };
}

// The global mobile top bar (App shell) now carries the logo, role line, bell
// and avatar for every member view, so this screen no longer renders a
// ScreenHeader of its own — it opens with the prototype's in-page `.ph` block
// (title + one-line subtitle on the left, the Customize button on the right),
// which reads correctly under the mobile bar and inside the desktop rail shell.
export function NumbersView({ alt = false, onOpenHome = null, data, onSavePreferences = null, onExport = null, statsClient = null }) {
  const memberId = data?.member?.id ?? null;
  return <MemberNumbersView key={memberId || "no-member"} alt={alt} onOpenHome={onOpenHome} data={data} memberId={memberId} onSavePreferences={onSavePreferences} onExport={onExport} statsClient={statsClient} />;
}

// The alternate shell paints with its own palette (design.css): the classic
// row and spark colours map onto the prototype's chart colours.
const ALT_COLORS = { "var(--green)": "var(--ug-hero)", "var(--gold)": "var(--ug-act)", "var(--terra)": "var(--ug-terra)", "var(--sg-color-case)": "var(--ug-case)" };
const altColor = (color) => ALT_COLORS[color] ?? "var(--ug-hero)";

function MemberNumbersView({ alt = false, onOpenHome = null, data, memberId, onSavePreferences = null, onExport = null, statsClient = null }) {
  // `lang` is the language the shell has loaded and is rendering, not the
  // member's saved one: when the Spanish chunk failed the shell stays English,
  // and the report card (which keeps its own label table) must stay English too.
  const { t, lang } = useLang();
  const serverPrefs = data.reportPreferences || {};
  const reportPreferencesUnavailable = data.reportPreferencesUnavailable === true;
  const hiddenKey = memberReportStorageKey(memberId, "hidden");
  const customKey = memberReportStorageKey(memberId, "custom");
  const [edit, setEdit] = useDeviceParityState("numbers.edit", false);
  // The server-owned payload wins over stale device storage. localStorage is
  // only the rollout fallback when the preferences RPC is absent. Once the RPC
  // answered, null means no saved layout (#7027: an undo can remove the only
  // one), so the page seeds the default layout and the mirroring effects below
  // overwrite the device copy, which may still hold the undone layout.
  const deviceFallback = data.reportPreferences === undefined || reportPreferencesUnavailable;
  const [hidden, setHidden] = useState(() => Object.fromEntries((serverPrefs.hidden || (deviceFallback ? Object.keys(readStored(hiddenKey, {})) : [])).map((key) => [key, true])));
  const [custom, setCustom] = useState(() => serverPrefs.custom || (deviceFallback ? readStored(customKey, []) : []));
  const [order, setOrder] = useState(() => serverPrefs.order || []);
  // The state above is seeded once, so a newer saved layout arriving later
  // (a reload, or a projection after a save elsewhere) must replace it, or the
  // page keeps showing the order from before the save. Our own save hands back
  // the same layout, which compares equal and changes nothing.
  const serverPrefsKey = data.reportPreferences ? JSON.stringify(data.reportPreferences) : "";
  const appliedPrefsKey = useRef(serverPrefsKey);
  // A view seeded from the device copy (the read failed or the RPC is absent)
  // has applied no saved layout, but may still show the one an undo removed.
  const deviceSeeded = useRef(deviceFallback);
  // While this view's own saves are in flight, an arriving layout is the echo
  // of an older save, not news: adopting it would undo edits queued after it.
  const pendingSaves = useRef(0);
  // A saved layout that goes away (#7027: an undo of the change that first
  // saved it) leaves no saved layout: the page shows the default one rather
  // than device storage, which only mirrors the layout being taken back.
  const savedLayoutGone = data.reportPreferences === null && !reportPreferencesUnavailable;
  useEffect(() => {
    if (pendingSaves.current > 0) return;
    if (!serverPrefsKey) {
      if (!savedLayoutGone || (!appliedPrefsKey.current && !deviceSeeded.current)) return;
      appliedPrefsKey.current = "";
      deviceSeeded.current = false;
      setHidden({});
      setCustom([]);
      setOrder([]);
      return;
    }
    if (serverPrefsKey === appliedPrefsKey.current) return;
    appliedPrefsKey.current = serverPrefsKey;
    deviceSeeded.current = false;
    const next = JSON.parse(serverPrefsKey);
    setHidden(Object.fromEntries((next.hidden || []).map((key) => [key, true])));
    setCustom(next.custom || []);
    setOrder(next.order || []);
  }, [serverPrefsKey, savedLayoutGone]);
  const [detailKey, setDetailKey] = useDeviceParityState("numbers.detailKey", null);
  const [pick, setPick] = useDeviceParityState("numbers.pick", { metric: "", kind: "spark", range: "recent" });
  const [saveError, setSaveError] = useState("");
  // Alternate shell: which cards show their table view (the prototype's
  // "Show table" switch on every chart).
  const [altTables, setAltTables] = useState({});
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    writeStored(hiddenKey, hidden);
  }, [hidden, hiddenKey]);
  useEffect(() => {
    writeStored(customKey, custom);
  }, [custom, customKey]);

  const { cards, byMetric, builderMetrics } = useMemo(() => buildCards(data, t, lang), [data, t, lang]);

  const customCards = custom.map((item) => materializeCustom(item, byMetric, t)).filter(Boolean);
  const unorderedCards = [...cards, ...customCards];
  const orderIndex = new Map(order.map((key, index) => [key, index]));
  const allCards = [...unorderedCards].sort((a, b) => (orderIndex.get(a.key) ?? 999) - (orderIndex.get(b.key) ?? 999));
  const visibleCards = allCards.filter((card) => !hidden[card.key]);
  const hiddenCards = allCards.filter((card) => hidden[card.key]);
  const detail = detailKey ? allCards.find((card) => card.key === detailKey) : null;

  const activeMetric = builderMetrics.some((metric) => metric.id === pick.metric) ? pick.metric : builderMetrics[0]?.id;
  const kinds = [
    ["spark", t("reports.kindSpark")],
    ["rows", t("reports.kindRows")],
    ["stat", t("reports.kindStat")],
  ];
  const ranges = [
    ["recent", t("reports.rangeRecent")],
    ["ytd", t("reports.rangeYtd")],
    ["all", t("reports.rangeAll")],
  ];

  async function persist(nextHidden = hidden, nextCustom = custom, nextOrder = order) {
    const config = { order: nextOrder, hidden: Object.keys(nextHidden).filter((key) => nextHidden[key]), custom: nextCustom };
    appliedPrefsKey.current = JSON.stringify(config);
    writeStored(hiddenKey, nextHidden);
    writeStored(customKey, nextCustom);
    try {
      if (reportPreferencesUnavailable) {
        setSaveError(t("reports.saveFailed"));
        return;
      }
      if (onSavePreferences) {
        pendingSaves.current += 1;
        saveQueue.current = saveQueue.current.catch(() => {}).then(() => onSavePreferences(config))
          .finally(() => { pendingSaves.current -= 1; });
        await saveQueue.current;
      }
      setSaveError("");
    }
    catch (error) { setSaveError(error?.message || t("reports.saveFailed")); }
  }

  function hideCard(card) {
    const next = { ...hidden, [card.key]: true };
    setHidden(next);
    persist(next, custom, order);
    if (detailKey === card.key) setDetailKey(null);
  }

  function showCard(key) {
    const next = { ...hidden };
    delete next[key];
    setHidden(next);
    persist(next, custom, order);
  }

  function deleteCustom(card) {
    const nextCustom = custom.filter((item) => item.id !== card.key);
    const nextOrder = order.filter((key) => key !== card.key);
    const nextHidden = { ...hidden }; delete nextHidden[card.key];
    setCustom(nextCustom); setOrder(nextOrder); setHidden(nextHidden);
    persist(nextHidden, nextCustom, nextOrder);
  }

  function addChart() {
    if (!activeMetric) return;
    const item = { id: `c-${Date.now()}`, metric: activeMetric, kind: pick.kind, range: pick.range };
    const nextCustom = [...custom, item];
    const nextOrder = [...order.filter((key) => key !== item.id), item.id];
    setCustom(nextCustom);
    setOrder(nextOrder);
    persist(hidden, nextCustom, nextOrder);
  }

  function moveCard(key, delta) {
    const keys = allCards.map((card) => card.key);
    const index = keys.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= keys.length) return;
    [keys[index], keys[target]] = [keys[target], keys[index]];
    setOrder(keys);
    persist(hidden, custom, keys);
  }

  function exportReports() {
    const rows = visibleCards.map((card) => ({ key: card.key, title: card.title, period: card.tag, value: card.big, detail: card.sub }));
    if (onExport) { onExport(rows); return; }
    // Spreadsheet programs execute cells beginning =,+,-,@ as formulas, and
    // they strip leading whitespace first, so " =cmd" is a formula too. CSV is
    // data, never code: this export shares the one escape the casework and
    // analytics exports use rather than keeping a private guard that can drift
    // away from it.
    const csv = [["key", "title", "period", "value", "detail"].map((key) => t(`csvExports.${key}`)), ...rows.map((row) => Object.values(row))]
      .map((row) => row.map(csvEscape).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "my-reports.csv"; anchor.click(); URL.revokeObjectURL(url);
  }

  function dropCard(event, card) {
    event.preventDefault();
    const source = event.dataTransfer.getData("text/report-key");
    const keys = allCards.map((item) => item.key);
    const from = keys.indexOf(source); const to = keys.indexOf(card.key);
    if (from >= 0 && to >= 0 && from !== to) { keys.splice(to, 0, keys.splice(from, 1)[0]); setOrder(keys); persist(hidden, custom, keys); }
  }

  function openCard(card) {
    if (!edit) setDetailKey(card.key);
  }

  const detailHistory = detail
    ? detail.spark
      ? [...detail.spark].reverse().map((bar) => ({ label: bar.label, val: bar.val }))
      : (detail.rows ?? []).map((row) => ({ label: row.label, val: row.val }))
    : [];

  function renderCard(card) {
    return (
      <ChartArrival
        as="article"
        name={`reports:card:${card.key}`}
        key={card.key}
        className={`reports-card${edit ? "" : " reports-card--open"}`}
        draggable={edit}
        onDragStart={edit ? (event) => event.dataTransfer.setData("text/report-key", card.key) : undefined}
        onDragOver={edit ? (event) => event.preventDefault() : undefined}
        onDrop={edit ? (event) => dropCard(event, card) : undefined}
      >
        {!edit && (
          <button
            type="button"
            className="reports-card__open"
            aria-label={card.title}
            onClick={() => openCard(card)}
          />
        )}
        {edit && (
          <div className="reports-card__edit-actions">
          <button type="button" aria-label={t("reports.moveUp", { title: card.title })} onClick={() => moveCard(card.key, -1)}>↑</button>
          <button type="button" aria-label={t("reports.moveDown", { title: card.title })} onClick={() => moveCard(card.key, 1)}>↓</button>
          {card.custom && <button type="button" aria-label={t("reports.deleteChart", { title: card.title })} onClick={() => deleteCustom(card)}><Trash2 size={15} aria-hidden="true" /></button>}
          <button
            type="button"
            className="reports-card__hide"
            title={t("reports.hideCard")}
            aria-label={t("reports.hideCard")}
            onClick={(event) => {
              event.stopPropagation();
              hideCard(card);
            }}
          >
            ✕
          </button>
          </div>
        )}
        <header className="reports-card__head"><span>{card.title}</span><small>{card.tag}</small></header>
        <div className="reports-card__big">
          <strong><ArrivalCount value={card.big} /></strong>
          {card.delta ? <span>{card.delta}</span> : null}
        </div>
        <p className="reports-card__sub">{card.sub}</p>
        {card.spark ? (
          <>
            <div className="reports-spark">
              {card.spark.map((bar, index) => (
                <span key={index} className="arrive-y" title={bar.tip} style={arriveAt(index, { height: `${bar.h}px`, background: bar.bg })} />
              ))}
            </div>
            <div className="reports-spark__axis"><span>{card.sparkFrom}</span><span>{card.sparkTo}</span></div>
          </>
        ) : null}
        {card.rows ? (
          <div className="reports-rows">
            {card.rows.map((row, index) => (
              <div key={row.label} className="reports-row">
                <span className="reports-row__label">{row.label}</span>
                <span className="reports-row__track"><span className="arrive-x" style={arriveAt(index, { width: `${row.w}%`, background: row.color })} /></span>
                <span className="reports-row__val"><ArrivalCount value={row.val} index={index} /></span>
              </div>
            ))}
          </div>
        ) : null}
        {card.foot ? <div className="reports-card__foot">{card.foot}</div> : null}
      </ChartArrival>
    );
  }

  // ── alternate shell: the prototype's Statistics page (pages/stats.js) ──
  // Its hero, figures row and chart panels, each with a table view, drawn
  // from the SAME cards, layout preferences and handlers as above (customize,
  // hide, restore, reorder, build, export). Ballot turnout is the member's own
  // ballots against quorum. The prototype's union-wide panels (wins by month,
  // grievance outcomes, the chapter table) read get_member_union_statistics
  // under the organization's anonymity floor (UnionStatistics.jsx).
  if (alt) {
    const planItems = Array.isArray(data.planItems) ? data.planItems : [];
    const turnout = planItems
      .filter((item) => item.kind === "ballot" && item.quorum?.quorumTarget)
      .map((item) => {
        const pct = Math.round((100 * item.quorum.totalVotes) / item.quorum.quorumTarget);
        return { label: item.title, w: pct, val: `${pct}%`, color: item.closed ? "var(--ug-hero)" : "var(--ug-purple)", votes: quorumTurnoutText(t, item.quorum) };
      });
    const tableHead = [t("altTakePart.statsTableItem"), t("altTakePart.statsTableValue")];
    const tableToggle = (key) => (
      <button
        type="button"
        className="ug-btn ug-btn-soft ug-btn-xs ug-ta-on-panel"
        aria-expanded={Boolean(altTables[key])}
        aria-controls={`ug-report-table-${key}`}
        onClick={() => setAltTables((current) => ({ ...current, [key]: !current[key] }))}
      >
        {altTables[key] ? t("altTakePart.hideTable") : t("altTakePart.showTable")}
      </button>
    );
    const reportPanel = (card) => {
      const history = card.spark ? card.spark.map((bar) => [bar.label, bar.val]) : (card.rows ?? []).map((row) => [row.label, row.val]);
      return (
        <article
          key={card.key}
          className={`ug-panel ug-ta-report${edit ? " ug-ta-editing" : ""}`}
          aria-labelledby={`ug-report-${card.key}`}
          draggable={edit}
          onDragStart={edit ? (event) => event.dataTransfer.setData("text/report-key", card.key) : undefined}
          onDragOver={edit ? (event) => event.preventDefault() : undefined}
          onDrop={edit ? (event) => dropCard(event, card) : undefined}
        >
          <div className="ug-tl-head ug-ta-report-head">
            <h2 id={`ug-report-${card.key}`}>{card.title}</h2>
            <div className="ug-tl-tools">
              <span className="ug-tag ug-t-win">{card.tag}</span>
              {edit ? (
                <span className="ug-ta-edit">
                  <button type="button" className="ug-icon-btn" aria-label={t("reports.moveUp", { title: card.title })} onClick={() => moveCard(card.key, -1)}><AltIcon name="up" /></button>
                  <button type="button" className="ug-icon-btn" aria-label={t("reports.moveDown", { title: card.title })} onClick={() => moveCard(card.key, 1)}><AltIcon name="down" /></button>
                  {card.custom ? <button type="button" className="ug-icon-btn" aria-label={t("reports.deleteChart", { title: card.title })} onClick={() => deleteCustom(card)}><Trash2 size={16} aria-hidden="true" /></button> : null}
                  <button type="button" className="ug-icon-btn" aria-label={t("reports.hideCard")} title={t("reports.hideCard")} onClick={() => hideCard(card)}><AltIcon name="x" /></button>
                </span>
              ) : history.length ? tableToggle(card.key) : null}
            </div>
          </div>
          <ChartArrival name={`reports:alt:${card.key}:big`} className="ug-ta-big"><b className="ug-tnum"><ArrivalCount value={card.big} /></b>{card.delta ? <span>{card.delta}</span> : null}</ChartArrival>
          <p className="ug-ta-muted">{card.sub}</p>
          {card.spark ? <BarChart name={`reports:alt:${card.key}:spark`} bars={card.spark} color={altColor(card.spark[0]?.bg)} label={card.title} showAxis={card.spark.every((bar) => bar.val === String(bar.v))} /> : null}
          {card.rows ? <HBars name={`reports:alt:${card.key}:rows`} rows={card.rows.map((row) => ({ ...row, color: altColor(row.color) }))} /> : null}
          {history.length ? <div id={`ug-report-table-${card.key}`} hidden={!altTables[card.key]}><DataTable head={tableHead} rows={history} /></div> : null}
          {card.foot ? <div className="ug-note ug-ta-gap"><AltIcon name="info" /><span>{card.foot}</span></div> : null}
        </article>
      );
    };
    const pickRow = (id, label, choices, current, onPick) => (
      <div className="ug-ta-build-row">
        <span className="ug-ta-build-l" id={`ug-build-${id}`}>{label}</span>
        <div className="ug-chips ug-ta-chips" role="group" aria-labelledby={`ug-build-${id}`}>
          {choices.map(([value, text]) => (
            <button key={value} type="button" className="ug-chip" aria-pressed={current === value} onClick={() => onPick(value)}>{text}</button>
          ))}
        </div>
      </div>
    );

    return (
      <div className="ug-ta-page ug-ta-stats">
        <TakePartHero
          crumb={t("reports.title")}
          lead={t("altTakePart.statsH1Lead")}
          accent={t("altTakePart.statsH1Accent")}
          lede={t("altTakePart.statsLede")}
          onOpenHome={onOpenHome}
        >
          <div className="ug-btn-row ug-ta-hero-tools">
            <button type="button" className={`ug-btn ug-btn-sm ${edit ? "ug-btn-dark" : "ug-btn-soft"}`} onClick={() => setEdit((value) => !value)}>
              {edit ? t("reports.doneEditing") : t("reports.customize")}
            </button>
            <button type="button" className="ug-btn ug-btn-soft ug-btn-sm" onClick={exportReports}><AltIcon name="download" />{t("reports.export")}</button>
          </div>
        </TakePartHero>
        <AltPageKpis view="numbers" data={data} />
        <section className="ug-wrap ug-ta-stack" aria-label={t("reports.title")}>
          {edit ? (
            <div className="ug-note ug-warn ug-ta-editbar">
              <AltIcon name="edit" />
              <span>
                <b>{t("reports.customizing")}</b> {t("reports.customizingHint")}
                {hiddenCards.length ? (
                  <span className="ug-chips ug-ta-chips ug-ta-restore">
                    {hiddenCards.map((card) => (
                      <button key={card.key} type="button" className="ug-chip" aria-label={t("reports.restore", { title: card.title })} onClick={() => showCard(card.key)}><AltIcon name="plus" />{card.title}</button>
                    ))}
                  </span>
                ) : null}
                {saveError ? <span className="ug-ta-err" role="alert">{saveError}</span> : null}
              </span>
            </div>
          ) : null}
          <div className="ug-legacy ug-ta-legacy"><MemberReportCard value={data.reportCard} lang={lang} healthBands={healthBandThresholds(data.organizationConfiguration)} /></div>
          {visibleCards.length > 0
            ? <div className="ug-grid-2 ug-ta-reports">{visibleCards.map(reportPanel)}</div>
            : <div className="ug-empty"><b>{t("altTakePart.statsAllHiddenTitle")}</b>{t("reports.allHidden")}</div>}
          <div className="ug-panel ug-ta-report" aria-labelledby="ug-stats-turnout">
            <div className="ug-tl-head ug-ta-report-head">
              <h2 id="ug-stats-turnout">{t("altTakePart.statsTurnoutTitle")}</h2>
              {turnout.length ? <div className="ug-tl-tools">{tableToggle("turnout")}</div> : null}
            </div>
            <p className="ug-ta-muted ug-ta-gap-b">{t("altTakePart.statsTurnoutSub")}</p>
            {turnout.length ? (
              <>
                <HBars name="reports:alt:turnout" rows={turnout} />
                <div id="ug-report-table-turnout" hidden={!altTables.turnout}>
                  <DataTable head={[t("altTakePart.statsTurnoutVote"), t("altTakePart.statsTurnoutPct"), t("altTakePart.statsTurnoutVotes")]} rows={turnout.map((row) => [row.label, row.val, row.votes])} />
                </div>
              </>
            ) : <div className="ug-empty ug-ta-empty"><b>{t("altTakePart.statsNotYet")}</b>{t("altTakePart.statsTurnoutEmpty")}</div>}
          </div>
          <UnionStatistics client={statsClient} />
          {builderMetrics.length > 0 ? (
            <div className="ug-panel ug-ta-report" aria-labelledby="ug-stats-build">
              <h2 id="ug-stats-build">{t("reports.buildTitle")}</h2>
              <p className="ug-ta-muted ug-ta-gap-b">{t("reports.buildSub")}</p>
              {pickRow("metric", t("reports.metric"), builderMetrics.map((metric) => [metric.id, metric.label]), activeMetric, (value) => setPick((previous) => ({ ...previous, metric: value })))}
              {pickRow("chart", t("reports.chart"), kinds, pick.kind, (value) => setPick((previous) => ({ ...previous, kind: value })))}
              {pickRow("range", t("reports.range"), ranges, pick.range, (value) => setPick((previous) => ({ ...previous, range: value })))}
              <button type="button" className="ug-btn ug-btn-dark ug-btn-sm ug-ta-gap" onClick={addChart}><AltIcon name="plus" />{t("reports.addChart")}</button>
            </div>
          ) : null}
          <div className="ug-note"><AltIcon name="info" /><span>{t("altTakePart.statsHowWeCount")}</span></div>
        </section>
      </div>
    );
  }

  return (
    <div className="screen screen--reports">
      <div className="reports-body">
        <header className="reports-lead">
          <div className="reports-lead__copy">
            <h1 className="reports-lead__title">{t("reports.title")}</h1>
            <p>{t("reports.subtitle")}</p>
          </div>
          <button type="button" className={`reports-customize${edit ? " is-on" : ""}`} onClick={() => setEdit((value) => !value)}>
            {edit ? t("reports.doneEditing") : `⚙ ${t("reports.customize")}`}
          </button>
          <button type="button" className="reports-customize" onClick={exportReports}>{t("reports.export")}</button>
        </header>
        {edit && (
          <div className="reports-editbar">
            <b>{t("reports.customizing")}</b> {t("reports.customizingHint")}
            {hiddenCards.map((card) => (
              <button key={card.key} type="button" className="reports-editbar__chip" aria-label={t("reports.restore", { title: card.title })} onClick={() => showCard(card.key)}>＋ {card.title}</button>
            ))}
            {saveError && <span role="alert">{saveError}</span>}
          </div>
        )}
        {!detail && <MemberReportCard value={data.reportCard} lang={lang} healthBands={healthBandThresholds(data.organizationConfiguration)} />}
        {detail ? (
          <ChartArrival as="section" name={`reports:detail:${detail.key}`} className="reports-detail">
            <button type="button" className="reports-detail__back" onClick={() => setDetailKey(null)}><span aria-hidden="true">‹ </span>{t("reports.allReports")}</button>
            <div className="reports-detail__head"><strong>{detail.title}</strong><small>{detail.tag}</small></div>
            <div className="reports-detail__big">
              <strong><ArrivalCount value={detail.big} /></strong>
              {detail.delta ? <span>{detail.delta}</span> : null}
            </div>
            <p className="reports-detail__sub">{detail.sub}</p>
            {detail.spark ? (
              <div className="reports-detail__spark">
                {detail.spark.map((bar, index) => (
                  <span key={index} className="arrive-y" title={bar.tip} style={arriveAt(index, { height: `${Math.round(bar.h * 2.6)}px`, background: bar.bg })} />
                ))}
              </div>
            ) : null}
            {detail.rows ? (
              <div className="reports-rows reports-rows--detail">
                {detail.rows.map((row, index) => (
                  <div key={row.label} className="reports-row">
                    <span className="reports-row__label">{row.label}</span>
                    <span className="reports-row__track"><span className="arrive-x" style={arriveAt(index, { width: `${row.w}%`, background: row.color })} /></span>
                    <span className="reports-row__val"><ArrivalCount value={row.val} index={index} /></span>
                  </div>
                ))}
              </div>
            ) : null}
            {detailHistory.length > 0 && (
              <div className="reports-detail__history">
                <span className="reports-detail__label">{t("reports.history")}</span>
                {detailHistory.map((row, index) => (
                  <div key={`${row.label}-${index}`} className="reports-detail__hrow"><span>{row.label}</span><span>{row.val}</span></div>
                ))}
              </div>
            )}
            {detail.foot ? <div className="reports-detail__foot"><Lightbulb size={16} aria-hidden="true" /> {detail.foot}</div> : null}
          </ChartArrival>
        ) : (
          <>
            {builderMetrics.length > 0 && (
              <section className="reports-builder">
                <strong>{t("reports.buildTitle")}</strong>
                <p>{t("reports.buildSub")}</p>
                <div className="reports-builder__rows">
                  <div className="reports-builder__row">
                    <span className="reports-builder__label">{t("reports.metric")}</span>
                    {builderMetrics.map((metric) => (
                      <button key={metric.id} type="button" aria-pressed={activeMetric === metric.id} className={`reports-pill${activeMetric === metric.id ? " is-on" : ""}`} onClick={() => setPick((previous) => ({ ...previous, metric: metric.id }))}>{metric.label}</button>
                    ))}
                  </div>
                  <div className="reports-builder__row">
                    <span className="reports-builder__label">{t("reports.chart")}</span>
                    {kinds.map(([id, label]) => (
                      <button key={id} type="button" aria-pressed={pick.kind === id} className={`reports-pill${pick.kind === id ? " is-on" : ""}`} onClick={() => setPick((previous) => ({ ...previous, kind: id }))}>{label}</button>
                    ))}
                  </div>
                  <div className="reports-builder__row">
                    <span className="reports-builder__label">{t("reports.range")}</span>
                    {ranges.map(([id, label]) => (
                      <button key={id} type="button" aria-pressed={pick.range === id} className={`reports-pill${pick.range === id ? " is-on is-on--gold" : ""}`} onClick={() => setPick((previous) => ({ ...previous, range: id }))}>{label}</button>
                    ))}
                    <button type="button" className="reports-add" onClick={addChart}>＋ {t("reports.addChart")}</button>
                  </div>
                </div>
              </section>
            )}
            {visibleCards.length > 0 ? (
              <div className="reports-grid">{visibleCards.map(renderCard)}</div>
            ) : (
              <p className="reports-empty">{t("reports.allHidden")}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
