// REQ-UG-TENANT-ORG-CHART-BASELINE-20261030. Shared, data-free
// helpers for an organization's own chart: seat markers, the hierarchy outline
// and the export. Nothing here carries a node, a person or a structure; every
// chart is the organization's own rows, scoped by the server before they
// arrive.

import { csvCell } from "../organizationIntelligence/export.js";

const SEAT_STATUSES = Object.freeze(["confirmed", "unconfirmed", "unknown", "stale"]);
export const SEAT_FILTERS = Object.freeze(["all", "vacant", "needsReview"]);
const STALE_AFTER_DAYS = 365;
const DAY_MS = 86400000;

export function easternToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayNumber(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate ?? ""));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS : null;
}

// The same rule private.organization_chart_effective_seat_status applies on
// the server: a confirmation older than a year, or one with no review date,
// reads stale. An absent or unrecognized status is unconfirmed, never
// confirmed, so a database that predates the column labels every seat honestly.
export function effectiveSeatStatus(node, today = easternToday()) {
  const status = SEAT_STATUSES.includes(node?.seatStatus) ? node.seatStatus : "unconfirmed";
  if (status !== "confirmed") return status;
  const reviewed = dayNumber(node?.seatStatusReviewedOn);
  const current = dayNumber(today);
  if (reviewed === null || current === null || reviewed < current - STALE_AFTER_DAYS) return "stale";
  return "confirmed";
}

// Every label a seat carries besides its name. Vacancy is independent of the
// status: a confirmed vacancy is still vacant.
export function seatMarkers(node, today) {
  const markers = [];
  if (node?.vacant === true) markers.push("vacant");
  const status = effectiveSeatStatus(node, today);
  if (status !== "confirmed") markers.push(status);
  return markers;
}

export function matchesSeatFilter(node, filter, today) {
  if (filter === "vacant") return node?.vacant === true;
  if (filter === "needsReview") return effectiveSeatStatus(node, today) !== "confirmed";
  return true;
}

// Parent/child outline. A node whose parent is absent (filtered out, or in a
// chapter outside the caller's scope) is a root rather than dropped.
export function buildOutline(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map();
  const roots = [];
  for (const node of nodes) {
    if (node.parentId && ids.has(node.parentId) && node.parentId !== node.id) {
      if (!children.has(node.parentId)) children.set(node.parentId, []);
      children.get(node.parentId).push(node);
    } else {
      roots.push(node);
    }
  }
  return { roots, children };
}

// Branches start open unless the organization marked them collapsed.
export function initiallyExpanded(nodes) {
  const { children } = buildOutline(nodes);
  return new Set(nodes.filter((node) => children.has(node.id) && node.collapsedByDefault !== true).map((node) => node.id));
}

export function branchIds(nodes) {
  const { children } = buildOutline(nodes);
  return new Set(children.keys());
}

// Depth-first rows in outline order, guarding against a malformed cycle.
export function outlineRows(nodes) {
  const { roots, children } = buildOutline(nodes);
  const rows = [];
  const seen = new Set();
  const visit = (node, depth, path) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const nextPath = [...path, node.label];
    rows.push({ node, depth, path: nextPath });
    for (const child of children.get(node.id) ?? []) visit(child, depth + 1, nextPath);
  };
  for (const root of roots) visit(root, 0, []);
  for (const node of nodes) if (!seen.has(node.id)) visit(node, 0, []);
  return rows;
}

// The export is built only from the chart the server already scoped to the
// caller's organization and chapter; it adds no row the page did not receive.
export function buildOrgChartCsv({ chart, organizationId = null, chapterId = null, labels = {}, lang = "en", today = easternToday() }) {
  const nodes = Array.isArray(chart?.nodes) ? chart.nodes : [];
  const header = labels.headers ?? ["Organization", "Chapter", "Chart", "Level", "Path", "Position", "Kind", "Detail", "Reports to", "Seat status", "Vacant", "Reviewed on", "Source", "Source as of"];
  const body = outlineRows(nodes).map(({ node, depth, path }) => [
    organizationId ?? "",
    node.chapterId ?? chapterId ?? "",
    labels.chart ?? chart?.chartKind ?? "",
    String(depth + 1),
    path.join(" > "),
    node.label ?? "",
    (lang === "es" ? labels.kind?.(node.nodeKind) : node.nodeKind) ?? node.nodeKind ?? "",
    node.subtitle ?? "",
    node.reportsToLabel ?? "",
    labels.status?.(effectiveSeatStatus(node, today)) ?? effectiveSeatStatus(node, today),
    node.vacant === true ? (labels.yes ?? "yes") : (labels.no ?? "no"),
    node.seatStatusReviewedOn ?? "",
    node.sourceLabel ?? "",
    node.sourceAsOf ?? "",
  ].map(csvCell).join(","));
  return `${header.map(csvCell).join(",")}\n${body.join("\n")}${body.length ? "\n" : ""}`;
}
