import { ANALYTICS_COHORT_FLOOR } from "./contract.js";
import { authorizeAnalyticsAccess } from "./authorization.js";
import { DEFAULT_HEALTH_BANDS, healthBand } from "../../lib/configurableThresholds.js";

export const ANALYTICS_PARITY_TABS = Object.freeze([
  "health",
  "explorer",
  "studio",
  "chapter_charts",
]);

export const ANALYTICS_CHART_TYPES = Object.freeze([
  "bar",
  "stacked_bar",
  "line",
  "area",
  "table",
]);

export const ANALYTICS_LAYOUT_SCOPES = Object.freeze([
  "personal",
  "chapter",
  "organization",
]);

export const ANALYTICS_LAYOUT_PAGE_SIZE = 15;
export const ANALYTICS_EXPLORER_PAGE_SIZE = 25;

function paginateAnalyticsRows(rows, requestedPage, pageSize) {
  const collection = Array.isArray(rows) ? rows : [];
  const pageCount = Math.max(1, Math.ceil(collection.length / pageSize));
  const numericPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0;
  const page = Math.min(Math.max(0, numericPage), pageCount - 1);
  const start = page * pageSize;
  return {
    items: collection.slice(start, start + pageSize),
    page,
    pageCount,
    total: collection.length,
  };
}

export function paginateAnalyticsLayouts(layouts, requestedPage = 0) {
  return paginateAnalyticsRows(layouts, requestedPage, ANALYTICS_LAYOUT_PAGE_SIZE);
}

export function paginateAnalyticsMembers(members, requestedPage = 0) {
  return paginateAnalyticsRows(members, requestedPage, ANALYTICS_EXPLORER_PAGE_SIZE);
}

export const MEMBER_REPORT_CARD_COMPONENTS = Object.freeze([
  "participation",
  "profileReadiness",
  "followThrough",
]);

const ATTENTION_ORDER = Object.freeze({ urgent: 0, support: 1, watch: 2, steady: 3 });

function numberInRange(value, min = 0, max = 100) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function boundedText(value, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeAttention(value) {
  return Object.hasOwn(ATTENTION_ORDER, value) ? value : "steady";
}

export function normalizeMemberReportCard(reportCard) {
  if (!reportCard || typeof reportCard !== "object" || Array.isArray(reportCard)) {
    return { state: "empty", generatedAt: null, overall: null, components: [], signals: [] };
  }
  const components = MEMBER_REPORT_CARD_COMPONENTS.map((id) => ({
    id,
    score: numberInRange(reportCard[id]),
  })).filter((item) => item.score != null);
  const overall = numberInRange(reportCard.overall);
  if (overall == null || components.length === 0) {
    return { state: "empty", generatedAt: null, overall: null, components: [], signals: [] };
  }
  return {
    state: "ready",
    generatedAt: boundedText(reportCard.generatedAt, 64) || null,
    overall,
    components,
    signals: Array.isArray(reportCard.signals)
      ? reportCard.signals.slice(0, 8).flatMap((signal) => {
        const label = boundedText(signal?.label, 80);
        const value = Number(signal?.value);
        return label && Number.isFinite(value) ? [{ label, value: Math.max(0, Math.round(value)) }] : [];
      })
      : [],
  };
}

// REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: the old app's five health tiers
// (critical/concerning/moderate/healthy/excellent at 24/44/64/84,
// 0024_tier1_polish.sql:56-59), adjustable per organization through
// limits.analytics.health_*_max. Pass healthBandThresholds(configuration).
export function analyticsScoreBand(score, thresholds = DEFAULT_HEALTH_BANDS) {
  const value = numberInRange(score);
  if (value == null) return "not_ready";
  return healthBand(value, thresholds);
}

export function validateAnalyticsChartSpec(spec, datasets = []) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const datasetIds = new Set(datasets.map((dataset) => dataset.id));
  const datasetId = boundedText(spec.datasetId, 80);
  const chartType = boundedText(spec.chartType, 32);
  if (!datasetIds.has(datasetId) || !ANALYTICS_CHART_TYPES.includes(chartType)) return null;
  return {
    datasetId,
    chartType,
    title: boundedText(spec.title, 80),
  };
}

function normalizeMember(row, organizationId) {
  if (!row || row.organizationId !== organizationId) return null;
  const id = boundedText(row.id, 80);
  const name = boundedText(row.name, 120);
  const chapterId = boundedText(row.chapterId, 80);
  if (!id || !name || !chapterId) return null;
  // A member who hid their Pulse score (#6774) keeps the row; no score is
  // shown or derived, and only an overdue case sets their attention.
  const scoreHidden = row.scoreHidden === true;
  const participation = scoreHidden ? null : numberInRange(row.participationScore);
  const profileReadiness = scoreHidden ? null : numberInRange(row.profileReadiness);
  const followThrough = scoreHidden ? null : numberInRange(row.followThrough);
  const scores = [participation, profileReadiness, followThrough].filter((value) => value != null);
  const suppliedOverall = scoreHidden ? null : numberInRange(row.overallScore);
  const overall = suppliedOverall ?? (scores.length
    ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)
    : null);
  return {
    id,
    name,
    chapterId,
    chapterName: boundedText(row.chapterName, 120) || chapterId,
    participationScore: participation,
    profileReadiness,
    followThrough,
    overallScore: overall,
    attention: scoreHidden && row.attention !== "urgent" ? null : normalizeAttention(row.attention),
    scoreHidden,
    activeCases: Math.max(0, Math.round(Number(row.activeCases) || 0)),
    overdueCases: Math.max(0, Math.round(Number(row.overdueCases) || 0)),
    lastActivityAt: scoreHidden ? null : boundedText(row.lastActivityAt, 64) || null,
  };
}

function normalizeChapterHealth(row, organizationId, healthFloor = ANALYTICS_COHORT_FLOOR) {
  if (!row || row.organizationId !== organizationId) return null;
  const chapterId = boundedText(row.chapterId, 80);
  if (!chapterId) return null;
  const memberCount = Math.max(0, Math.round(Number(row.memberCount) || 0));
  const protectedCohort = row.protected === true || memberCount < healthFloor;
  return {
    chapterId,
    chapterName: boundedText(row.chapterName, 120) || chapterId,
    memberCount: protectedCohort ? null : memberCount,
    protected: protectedCohort,
    score: protectedCohort ? null : numberInRange(row.score),
    drivers: protectedCohort || !row.drivers || typeof row.drivers !== "object"
      ? null
      : Object.fromEntries(Object.entries(row.drivers).flatMap(([key, value]) => {
        const score = numberInRange(value);
        return score == null ? [] : [[boundedText(key, 48), score]];
      })),
    trend: protectedCohort || !Array.isArray(row.trend)
      ? []
      : row.trend.slice(-36).flatMap((point) => {
        const measuredOn = boundedText(point?.measuredOn, 32);
        const score = numberInRange(point?.score);
        return measuredOn && score != null ? [{ measuredOn, score }] : [];
      }),
  };
}

function normalizeDataset(dataset, organizationId) {
  if (!dataset || dataset.organizationId !== organizationId) return null;
  const id = boundedText(dataset.id, 80);
  const label = boundedText(dataset.label, 120);
  if (!id || !label) return null;
  return {
    id,
    label,
    description: boundedText(dataset.description, 240),
    scope: ANALYTICS_LAYOUT_SCOPES.includes(dataset.scope) ? dataset.scope : "organization",
    chapterId: boundedText(dataset.chapterId, 80) || null,
    rows: Array.isArray(dataset.rows) ? dataset.rows.slice(0, 200).flatMap((row) => {
      const rowLabel = boundedText(row?.label, 120);
      const value = Number(row?.value);
      const secondaryValue = Number(row?.secondaryValue);
      if (!rowLabel || !Number.isFinite(value)) return [];
      return [{
        label: rowLabel,
        value: Math.round(value * 100) / 100,
        secondaryValue: Number.isFinite(secondaryValue) ? Math.round(secondaryValue * 100) / 100 : null,
      }];
    }) : [],
  };
}

function normalizeLayout(layout, organizationId, datasets) {
  if (!layout || layout.organizationId !== organizationId) return null;
  const id = boundedText(layout.id, 80);
  const name = boundedText(layout.name, 80);
  const scope = boundedText(layout.scope, 32);
  if (!id || !name || !ANALYTICS_LAYOUT_SCOPES.includes(scope)) return null;
  const spec = validateAnalyticsChartSpec(layout.spec, datasets);
  if (!spec) return null;
  return {
    id,
    name,
    organizationId,
    scope,
    chapterId: boundedText(layout.chapterId, 80) || null,
    spec,
    canEdit: layout.canEdit === true,
    updatedAt: boundedText(layout.updatedAt, 64) || null,
  };
}

function healthTree(members, chapterHealth) {
  const healthByChapter = new Map(chapterHealth.map((chapter) => [chapter.chapterId, chapter]));
  const groups = new Map();
  for (const member of members) {
    const group = groups.get(member.chapterId) || {
      chapterId: member.chapterId,
      chapterName: member.chapterName,
      health: healthByChapter.get(member.chapterId) || null,
      members: [],
    };
    group.members.push(member);
    groups.set(member.chapterId, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    members: group.members.sort((left, right) => (
      (ATTENTION_ORDER[left.attention] ?? 4) - (ATTENTION_ORDER[right.attention] ?? 4)
      || (left.overallScore ?? 101) - (right.overallScore ?? 101)
      || left.name.localeCompare(right.name)
    )),
  })).sort((left, right) => (
    (left.health?.score ?? 101) - (right.health?.score ?? 101)
    || left.chapterName.localeCompare(right.chapterName)
  ));
}

export function composeAnalyticsWorkspace({ workspace = null, viewer = {}, expectedFloor = null } = {}) {
  const gate = authorizeAnalyticsAccess(viewer, workspace?.organizationId);
  if (!gate.ok) return { state: gate.state, reason: gate.reason, members: [], chapters: [], datasets: [], layouts: [] };
  if (!workspace) return { state: "unavailable", reason: "workspace_unwired", members: [], chapters: [], datasets: [], layouts: [] };
  if (workspace.unavailable) return { state: "unavailable", reason: workspace.reason || "workspace_unavailable", members: [], chapters: [], datasets: [], layouts: [] };
  if (workspace.error) return { state: "error", reason: workspace.error, members: [], chapters: [], datasets: [], layouts: [] };
  const floor = Number(workspace.privacyThreshold);
  const healthFloor = Number(workspace.chapterHealthFloor ?? ANALYTICS_COHORT_FLOOR);
  // The workspace's aggregates were computed by the server at the floor it
  // reports, so that raw floor must itself meet the browser's floor of 25
  // and match what the caller expects; a response produced at 10 is never
  // taken as satisfying 25 (Lovable audit APP-STEWARD-07, gate r1s2).
  if (!Number.isInteger(floor) || floor < ANALYTICS_COHORT_FLOOR || floor > 200
      || (expectedFloor != null && floor !== expectedFloor)
      || !Number.isInteger(healthFloor) || healthFloor < 5 || healthFloor > 100) {
    return { state: "unavailable", reason: "privacy_floor_mismatch", members: [], chapters: [], datasets: [], layouts: [] };
  }
  const organizationId = gate.viewer.organizationId;
  const members = Array.isArray(workspace.members)
    ? workspace.members.map((row) => normalizeMember(row, organizationId)).filter(Boolean)
    : [];
  const chapterHealth = Array.isArray(workspace.chapterHealth)
    ? workspace.chapterHealth.map((row) => normalizeChapterHealth(row, organizationId, healthFloor)).filter(Boolean)
    : [];
  // A chapter dataset's rows carry no cohort size of their own, so one is
  // shown only for a chapter this read proves has at least 25 members.
  const provenChapters = new Set(chapterHealth
    .filter((row) => row.memberCount != null && row.memberCount >= ANALYTICS_COHORT_FLOOR)
    .map((row) => row.chapterId));
  const datasets = Array.isArray(workspace.datasets)
    ? workspace.datasets.map((row) => normalizeDataset(row, organizationId))
      .filter((dataset) => dataset && (dataset.scope !== "chapter" || provenChapters.has(dataset.chapterId)))
    : [];
  const layouts = Array.isArray(workspace.layouts)
    ? workspace.layouts.map((row) => normalizeLayout(row, organizationId, datasets)).filter(Boolean)
    : [];
  return {
    state: "ready",
    reason: null,
    organizationId,
    generatedAt: boundedText(workspace.generatedAt, 64) || null,
    members,
    chapters: healthTree(members, chapterHealth),
    chapterHealth,
    datasets,
    layouts,
    chapterCharts: layouts.filter((layout) => layout.scope === "chapter"),
  };
}
