import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  LEADERSHIP_TIMELINE_KINDS,
  ORGANIZATION_CHART_KINDS,
  ORGANIZATION_NODE_KINDS,
  ORGANIZATION_SEAT_STATUSES,
  RELATIONSHIP_KINDS,
  TOPIC_PROGRESS_STATES,
  neuroMapEnabled,
  neuroMapReadOn,
} from "../features/organizationIntelligence/contract.js";
import { seatMarkers } from "../features/orgChart/model.js";
import {
  createWiredOrganizationIntelligenceAdapter,
  useOrganizationIntelligenceActor,
} from "../lib/organizationIntelligenceWiring.js";
import { createOrganizationIntelligenceAdapter } from "../features/organizationIntelligence/adapter.js";
import { normalizeOrganizationIntelligenceActor } from "../features/organizationIntelligence/authorization.js";
import { ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT } from "../features/organizationIntelligence/preview.js";
import { localeFor } from "../lib/i18n/format.js";
import "../features/organizationIntelligence/organization-intelligence.css";
import { useOrganizationTranslator } from "../lib/LanguageContext.jsx";
import { ConnectionSuggestions } from "../features/connectionSuggestions/ConnectionSuggestions.jsx";
import { DerivedGraphPanel } from "../features/organizationIntelligence/DerivedGraphPanel.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite, useBusyScope } from "../lib/busyWrite.js";

// Every label reads from the shared catalogue under orgIntel.*; an enum is
// stored as its identifier and only its displayed label is localized.
const enumLabel = (tr, group, value) => tr(`${group}.${value}`);

const initialNode = { id: "", chartKind: "agency", nodeKind: "organization", parentId: "", chapterId: "", label: "", subtitle: "", positionX: 0, positionY: 0, sortOrder: 0, seatStatus: "unconfirmed", vacant: false, seatTouched: false, statusChosen: false };
// Fields whose change makes the server drop a seat's confirmation
// (private.organization_chart_node_seat_status_guard). The form shows the same
// reset before saving, so what the administrator sees is what is stored.
const SEAT_CONTENT_FIELDS = new Set(["chartKind", "nodeKind", "label", "subtitle", "parentId", "vacant"]);
const initialRelationship = { id: "", sourceId: "", targetId: "", kind: "works_with", strength: 3 };
const initialTopic = { memberId: "", topicKey: "", topicLabel: "", state: "introduced", progress: 0 };
// Today's LOCAL calendar day. Kept local rather than importing
// src/lib/taskSchedule.js, which would pull this view into the task-only
// consumer graph (tests/ci-web-task-impact.test.js).
function localToday() {
  const now = new Date();
  const pad = (part) => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
// Built per form reset so the default is today's LOCAL calendar day, not the
// UTC date captured at import time.
function makeInitialTimeline() {
  return { id: "", chapterId: "", kind: "leadership_term", title: "", detail: "", effectiveOn: localToday(), endedOn: "", amountCents: "", amountBasis: "", sourceLabel: "", sourceAsOf: "" };
}
function formatUsd(amountCents, lang) {
  return new Intl.NumberFormat(localeFor(lang), { style: "currency", currency: "USD" }).format(amountCents / 100);
}
function formatCount(value, lang) {
  return new Intl.NumberFormat(localeFor(lang)).format(value);
}

function Field({ label, children }) {
  return <label className="oi-field"><span>{label}</span>{children}</label>;
}

function Status({ model, loading, tr, onRetry }) {
  if (loading) return <div className="oi-state" role="status">{tr("loading")}</div>;
  if (model?.state === "ready") return null;
  const message = model?.state === "empty" ? tr("empty")
    : model?.state === "unauthorized" ? tr("unauthorized")
      : model?.state === "unset" ? tr("unwired") : tr("error");
  return <div className="oi-state" role="status"><p>{message}</p><button type="button" className="oi-button oi-button--secondary" onClick={onRetry}>{tr("retry")}</button></div>;
}

function Tree({ nodes, tr, onEdit, depth = 0 }) {
  if (!nodes.length && depth === 0) return <p className="oi-empty">{tr("noRows")}</p>;
  return <ul className="oi-tree" data-depth={depth}>{nodes.map((node) => (
    <li key={node.id}>
      <div className="oi-tree__node">
        <span className="oi-badge">{enumLabel(tr, "nodeKind", node.nodeKind)}</span>
        <strong>{node.label}</strong>{node.subtitle && <small>{node.subtitle}</small>}
        {seatMarkers(node).map((marker) => <span key={marker} className="oi-badge">{marker === "vacant" ? tr("vacantSeat") : enumLabel(tr, "seatStatus", marker)}</span>)}
        {onEdit && <button type="button" className="oi-link" onClick={() => onEdit({ ...node, seatTouched: false, statusChosen: false })}>{tr("edit")}</button>}
      </div>
      {node.children?.length > 0 && <Tree nodes={node.children} tr={tr} onEdit={onEdit} depth={depth + 1} />}
    </li>
  ))}</ul>;
}

export const MAX_CHART_AXIS_PX = 2400;

export function normalizedPositions(nodes) {
  const xValues = nodes.map((node) => Number(node.positionX || 0));
  const yValues = nodes.map((node) => Number(node.positionY || 0));
  const xMin = Math.min(...xValues, 0); const xMax = Math.max(...xValues, 0);
  const yMin = Math.min(...yValues, 0); const yMax = Math.max(...yValues, 0);
  return new Map(nodes.map((node, index) => {
    const fallbackX = 16 + ((index % 4) * 22);
    const fallbackY = 14 + (Math.floor(index / 4) * 24);
    const x = xMax === xMin ? fallbackX : 18 + (((Number(node.positionX || 0) - xMin) / (xMax - xMin)) * 64);
    const y = yMax === yMin ? fallbackY : 12 + (((Number(node.positionY || 0) - yMin) / (yMax - yMin)) * 64);
    return [node.id, { x, y }];
  }));
}

export function chartAxisSpan(positions, axis, spacing, floor) {
  const values = [...new Set([...positions.values()].map((point) => point[axis]))].sort((a, b) => a - b);
  const gaps = values.slice(1).map((value, index) => value - values[index]);
  const raw = Math.ceil(spacing * 100 / Math.min(...gaps, 100));
  const span = Number.isFinite(raw) ? raw : MAX_CHART_AXIS_PX;
  return Math.min(MAX_CHART_AXIS_PX, Math.max(floor, span));
}

// Scroll position that puts the root in the middle of the visible frame,
// clamped to the canvas. A frame at least as wide as the canvas stays at 0.
export function chartRootScrollLeft(rootX, canvasWidth, frameWidth) {
  return Math.max(0, Math.min(canvasWidth - frameWidth, Math.round((rootX / 100) * canvasWidth - frameWidth / 2)));
}

// The expanded canvas is usually wider than its card, and it used to open
// scrolled to its left edge with the root off-screen. Open centred on the
// root once the frame has a width; the result says whether the chart
// scrolls sideways (BUG-UG-WEB-ORG-CHART-OPENS-ON-EMPTY-CANVAS-20261002).
// The member Org structure chart uses it too (#9534).
export function useChartRootCentring(frame, rootX, width) {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return undefined;
    let previousWidth = 0;
    const measure = () => {
      const visible = element.clientWidth;
      if (!visible) return;
      setOverflowing(width > visible + 1);
      if (rootX == null) return;
      const centre = rootX / 100 * width;
      const containsRoot = (frameWidth) => centre - 75 >= element.scrollLeft
        && centre + 75 <= element.scrollLeft + frameWidth;
      // Keep a visible root in view across reflow, but retain a user's pan
      // away from it and ignore height-only observer notifications.
      if (!previousWidth || (visible !== previousWidth && containsRoot(previousWidth) && !containsRoot(visible))) {
        element.scrollLeft = chartRootScrollLeft(rootX, width, visible);
      }
      previousWidth = visible;
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame, rootX, width]);
  return overflowing;
}

function ChartCanvas({ nodes, rootId, label, tr, onEdit }) {
  const frame = useRef(null);
  const positions = normalizedPositions(nodes);
  // Preserve the saved coordinate ratios, expanding the canvas instead of
  // squeezing five columns of full-size controls into a narrow chart card.
  // Tiny but valid normalized gaps must not expand into multi-million-pixel canvases.
  const width = chartAxisSpan(positions, "x", 180, 480);
  const height = chartAxisSpan(positions, "y", 150, Math.max(280, 160 + Math.ceil(nodes.length / 4) * 110));
  // Older data can have cards but no outline root. Open on a card either way.
  const openingX = positions.get(rootId ?? nodes[0]?.id)?.x;
  const overflowing = useChartRootCentring(frame, openingX, width);
  if (!nodes.length) return null;
  return <>{overflowing && <p className="oi-map-hint">{tr("chartScrollHint")}</p>}<div ref={frame} className="oi-map-scroll" style={{ height }} role="group" aria-label={tr("chartLayout", { chart: label })}><div className="oi-map oi-map--chart" style={{ minWidth: width, minHeight: height }}>
    <svg className="oi-map__lines" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">{nodes.flatMap((node) => {
      const from = node.parentId ? positions.get(node.parentId) : null; const to = positions.get(node.id);
      return from && to ? [<line key={`${node.parentId}-${node.id}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />] : [];
    })}</svg>
    {nodes.map((node) => { const point = positions.get(node.id); return <button key={node.id} type="button" className="oi-map__node" style={{ left: `${point.x}%`, top: `${point.y}%` }} onClick={() => onEdit?.(node)}><span>{enumLabel(tr, "nodeKind", node.nodeKind)}</span><strong>{node.label}</strong>{node.subtitle && <small>{node.subtitle}</small>}</button>; })}
  </div></div></>;
}

// The Neuro Map used to place every organization member on one ellipse, so a
// 5,000-member organization drew a solid black ring
// (BUG-UG-WEB-NEURO-MAP-DRAWS-EVERYONE-ON-ONE-RING-20261002). It now
// draws only people who have a relationship, up to this cap: two people per
// relationship, so a hundred relationships always draw whole. Past the cap the
// legend says how many are hidden, and the search draws one person with
// everyone within two steps of them. Up to eight people sit on one ring; more
// go on a grid of rows that never overlap, inside a frame that scrolls down.
// Everyone else, and every relationship, stays reachable in the paged lists
// under the map.
export const RELATIONSHIP_MAP_CAP = 200;
export const RELATIONSHIP_RING_MAX = 8;
export const RELATIONSHIP_FOCUS_STEPS = 2;
const RING_RX = 32;
const RING_RY = 38;
const RING_PILL_MIN_PX = 88;
const RING_PILL_MAX_PERCENT = 30;
const GRID_CELL_MIN_PX = 150;
const GRID_GAP_PX = 12;
const GRID_PAD_PX = 16;
const GRID_PILL_MIN_PX = 54;
const FOCUS_MATCHES = 8;
// Names match without accents, case or extra spacing, so "jose" finds "José"
// and "maria garcia" finds "María  García".
export const foldName = (value, locale) => sameNameKey(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase(locale);
// Two labels that differ only in Unicode normalization (NFC or NFD "í") or in
// inner spacing read the same aloud, so they are one name
// (BUG-UG-NEURO-MAP-SAME-NAME-UNICODE-SPACING-20261008).
//
// Zero-width characters that carry no meaning (U+200B, U+2060, U+FEFF) read as
// nothing, so they are removed BEFORE whitespace is collapsed: JavaScript's \s
// matches U+FEFF, which would turn "Ana<FEFF>Marie" into "Ana Marie"
// (BUG-UG-NEURO-MAP-SEARCH-SHOULD-INSERT-SPACE-INVISIBLE-ZERO-20261013).
// U+200C and U+200D stay: they are meaningful in Persian and emoji sequences.
function sameNameKey(label) {
  return String(label || "").normalize("NFC").replace(/[\u200B\u2060\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

// What tells apart people whose labels read the same, keyed by person id: the
// role when there is one, then "n of k" among everyone sharing the label in
// person-id order. The ordinal is unique within the label and ends every
// detail, so two Focus buttons never read alike, and it does not move when a
// relationship edit reorders the map. A label nobody else has gets no entry.
export function sameNameDetails(people, tr, lang) {
  const byLabel = new Map();
  for (const person of people) {
    const key = sameNameKey(person.label);
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(person);
  }
  const details = new Map();
  for (const group of byLabel.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    ordered.forEach((person, index) => {
      const ordinal = tr("sameNameOrdinal", { n: formatCount(index + 1, lang), total: formatCount(group.length, lang) });
      details.set(person.id, [String(person.roleLabel || "").trim(), ordinal].filter(Boolean).join(", "));
    });
  }
  return details;
}

// The Focus button name for every person. A label can equal another person's
// generated name (a member literally labelled "Ana Ruiz (Member, 1 of 2)"),
// so any name that still repeats gets the person's id appended until no two
// differ (BUG-UG-NEURO-MAP-GENERATED-LABEL-COLLISION-20261008).
export function focusButtonNames(people, tr, lang) {
  const details = sameNameDetails(people, tr, lang);
  const names = new Map(people.map((person) => [person.id, details.has(person.id)
    ? tr("focusOnDetail", { name: person.label, detail: details.get(person.id) })
    : tr("focusOn", { name: person.label })]));
  for (let round = 0; round < people.length; round += 1) {
    const seen = new Map();
    for (const name of names.values()) seen.set(name, (seen.get(name) || 0) + 1);
    const repeated = [...names].filter(([, name]) => seen.get(name) > 1);
    if (!repeated.length) break;
    for (const [id, name] of repeated) names.set(id, `${name} (${id})`);
  }
  return names;
}

// Who the map draws, in drawing order. Without a focus: the most connected
// person, then the people closest to them along the strongest relationships
// (breadth first), then the next most connected person not yet reached, until
// the cap. With a focus: that person, then everyone within
// RELATIONSHIP_FOCUS_STEPS of them, nearest and strongest first, until the
// cap. People without a relationship are never drawn. `people` lists everyone
// who has a relationship, most connected first, for the focus search; `reach`
// is how many people the walk found before the cap.
export function relationshipMapSample(graph, { cap = RELATIONSHIP_MAP_CAP, focus = null } = {}) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const links = new Map();
  for (const edge of graph.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]]) {
      if (!links.has(from)) links.set(from, []);
      links.get(from).push({ id: to, strength: edge.strength });
    }
  }
  const total = (id) => links.get(id).reduce((sum, link) => sum + link.strength, 0);
  const people = graph.nodes.filter((node) => links.has(node.id)).sort((a, b) => links.get(b.id).length - links.get(a.id).length
    || total(b.id) - total(a.id) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  const rank = new Map(people.map((node, index) => [node.id, index]));
  const order = [];
  const depth = new Map();
  const walk = (startId, steps) => {
    depth.set(startId, 0);
    order.push(startId);
    for (const queue = [startId]; queue.length;) {
      const id = queue.shift();
      if (depth.get(id) >= steps) continue;
      const next = [...links.get(id)].sort((a, b) => b.strength - a.strength || rank.get(a.id) - rank.get(b.id));
      for (const link of next) {
        if (depth.has(link.id)) continue;
        depth.set(link.id, depth.get(id) + 1);
        order.push(link.id);
        queue.push(link.id);
      }
    }
  };
  const focused = links.has(focus) ? byId.get(focus) : null;
  if (focused) walk(focused.id, RELATIONSHIP_FOCUS_STEPS);
  else {
    for (const person of people) {
      // A new component needs two places so its first person has a drawn
      // line; inside one component every later person follows a drawn one.
      if (cap - order.length < 2) break;
      if (!depth.has(person.id)) walk(person.id, Infinity);
    }
  }
  const drawn = order.slice(0, cap);
  const shown = new Set(drawn);
  return {
    nodes: drawn.map((id) => byId.get(id)),
    edges: graph.edges.filter((edge) => shown.has(edge.source) && shown.has(edge.target)),
    connected: people.length,
    people,
    focus: focused,
    reach: order.length,
  };
}

function ringPoint(index, count) {
  const angle = ((Math.PI * 2) / count) * index - Math.PI / 2;
  return { x: 50 + Math.cos(angle) * RING_RX, y: 50 + Math.sin(angle) * RING_RY };
}

// Pills that share a row of the ring must not touch. Seven people put the two
// lowest pills 27.8% of the width apart, closer than the 30% pill; every other
// ring keeps the stylesheet width.
export function ringPillWidth(count) {
  let nearest = Infinity;
  for (let a = 0; a < count; a += 1) {
    for (let b = a + 1; b < count; b += 1) {
      const p = ringPoint(a, count);
      const q = ringPoint(b, count);
      if (Math.abs(p.y - q.y) < 0.01) nearest = Math.min(nearest, Math.abs(p.x - q.x));
    }
  }
  return Math.min(RING_PILL_MAX_PERCENT, nearest - 2);
}

// Leave a gap between the tallest rendered pills and keep the top/bottom
// pills inside the map. Names and font sizes can change their measured height.
export function relationshipMapHeight(count, pillHeight = RING_PILL_MIN_PX) {
  const paddedHeight = pillHeight + 8;
  const contained = paddedHeight / (1 - 2 * RING_RY / 100);
  const separated = count < 3 ? 0 : paddedHeight / ((RING_RY / 100) * (1 - Math.cos((Math.PI * 2) / count)));
  return Math.max(440, Math.ceil(contained), Math.ceil(separated));
}

// Rows of equal cells for more people than one ring holds; odd rows run right
// to left so people discovered together stay side by side around the turns.
// Pill centres are percentages of the map, like the ring's; the height fits
// every row at the tallest measured pill, so pills never cover each other.
export function relationshipGridLayout(count, width, pillHeight) {
  const columns = Math.max(2, Math.floor(width / GRID_CELL_MIN_PX));
  const rows = Math.ceil(count / columns);
  const cell = pillHeight + GRID_GAP_PX;
  const height = rows * cell + GRID_PAD_PX * 2;
  const positions = Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns);
    const column = row % 2 ? columns - 1 - (index % columns) : index % columns;
    return { x: ((column + 0.5) * 100) / columns, y: ((GRID_PAD_PX + (row + 0.5) * cell) * 100) / height };
  });
  return { columns, rows, height, positions, pillWidth: `calc(${100 / columns}% - ${GRID_GAP_PX}px)` };
}

function RelationshipCanvas({ graph, tr, lang }) {
  const [focus, setFocus] = useState(null);
  const [query, setQuery] = useState("");
  const [matchLimit, setMatchLimit] = useState(FOCUS_MATCHES);
  const sample = useMemo(() => relationshipMapSample(graph, { focus }), [graph, focus]);
  const nodes = sample.nodes;
  const map = useRef(null);
  const frame = useRef(null);
  const hintId = useId();
  const legendId = useId();
  const [measured, setMeasured] = useState({ width: 0, pillHeight: 0, overflowing: false });
  useLayoutEffect(() => {
    const element = map.current;
    if (!element) return undefined;
    const pills = [...element.querySelectorAll(".oi-map__person")];
    const measure = () => {
      // The frame's outer width: a provisional layout's scrollbar must not
      // narrow the width the column count is chosen from.
      const next = {
        width: frame.current ? frame.current.offsetWidth : element.clientWidth,
        pillHeight: Math.max(0, ...pills.map((pill) => pill.getBoundingClientRect().height)),
        overflowing: Boolean(frame.current) && frame.current.scrollHeight > frame.current.clientHeight + 1,
      };
      setMeasured((previous) => (previous.width === next.width && previous.pillHeight === next.pillHeight
        && previous.overflowing === next.overflowing) ? previous : next);
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    pills.forEach((pill) => observer.observe(pill));
    // A height-only resize changes whether the frame scrolls without
    // resizing the map or a pill, so the frame itself is watched too.
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, [nodes]);
  // Focusing puts the chosen person in the first cell. The frame stays
  // mounted while the new layout is still a grid, so a frame the user had
  // scrolled would keep showing lower rows with that person out of view.
  // choose() also scrolls to the top itself: choosing the person already in
  // focus changes nothing this effect depends on.
  useLayoutEffect(() => {
    if (frame.current) frame.current.scrollTop = 0;
  }, [focus]);
  if (!nodes.length) return null;
  const ring = nodes.length <= RELATIONSHIP_RING_MAX;
  const grid = ring ? null : relationshipGridLayout(nodes.length, measured.width, Math.max(GRID_PILL_MIN_PX, measured.pillHeight));
  const positions = new Map(nodes.map((node, index) => [node.id, ring ? ringPoint(index, nodes.length) : grid.positions[index]]));
  const minHeight = ring ? relationshipMapHeight(nodes.length, Math.max(RING_PILL_MIN_PX, measured.pillHeight)) : grid.height;
  const pillWidth = ring ? `min(132px, ${ringPillWidth(nodes.length)}%)` : null;
  const locale = localeFor(lang);
  const needle = foldName(query.trim(), locale);
  const matching = needle ? sample.people.filter((person) => foldName(person.label, locale).includes(needle)) : [];
  const matches = matching.slice(0, matchLimit);
  const focusNames = focusButtonNames(sample.people, tr, lang);
  const choose = (id) => {
    setFocus(id);
    setQuery("");
    setMatchLimit(FOCUS_MATCHES);
    if (frame.current) frame.current.scrollTop = 0;
  };
  const count = (value) => formatCount(value, lang);
  const legend = sample.focus
    ? tr(nodes.length < sample.reach ? "mapFocusedCapped" : "mapFocused", { name: sample.focus.label, shown: count(nodes.length - 1), reach: count(sample.reach - 1) })
    : nodes.length < sample.connected
      ? tr("mapCapped", { shown: count(nodes.length), connected: count(sample.connected), hidden: count(sample.connected - nodes.length) })
      : nodes.length < graph.nodes.length ? tr("mapConnected", { shown: count(nodes.length) }) : null;
  const canvas = <div ref={map} className={`oi-map oi-map--relationships${ring ? "" : " oi-map--grid"}`} style={{ minHeight }} role="img" aria-label={tr(sample.edges.length === 1 ? "relationshipMapOne" : "relationshipMap", { people: nodes.length, count: sample.edges.length })} aria-describedby={legend ? legendId : undefined}>
    <svg className="oi-map__lines" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">{sample.edges.map((edge) => { const from = positions.get(edge.source); const to = positions.get(edge.target); return <line key={edge.id} x1={from.x} y1={from.y} x2={to.x} y2={to.y} strokeWidth={Math.max(1, edge.strength / 2)} />; })}</svg>
    {nodes.map((node) => { const point = positions.get(node.id); return <div className={`oi-map__person${node.id === sample.focus?.id ? " oi-map__person--focus" : ""}`} key={node.id} style={{ left: `${point.x}%`, top: `${point.y}%`, width: ring ? pillWidth : grid.pillWidth }}><strong>{node.label}</strong>{node.roleLabel && <small>{node.roleLabel}</small>}</div>; })}
  </div>;
  return <>
    {sample.connected > RELATIONSHIP_RING_MAX && <form className="oi-map-search" role="search" onSubmit={(event) => { event.preventDefault(); if (matches[0]) choose(matches[0].id); }}>
      <Field label={tr("focusSearch")}><input type="search" value={query} aria-describedby={hintId} onChange={(event) => { setQuery(event.target.value); setMatchLimit(FOCUS_MATCHES); }} /></Field>
      <p id={hintId}>{tr("focusSearchHint")}</p>
      {matches.length > 0 && <ul className="oi-map-matches" aria-label={tr("focusMatches")}>{matches.map((person) => <li key={person.id}><button type="button" className="oi-button oi-button--secondary" onClick={() => choose(person.id)}>{focusNames.get(person.id)}</button></li>)}</ul>}
      {matching.length > matches.length && <div className="oi-actions"><button type="button" className="oi-link" onClick={() => setMatchLimit(matchLimit + FOCUS_MATCHES)}>{tr("moreMatches", { count: count(Math.min(FOCUS_MATCHES, matching.length - matches.length)) })}</button></div>}
      {needle && !matches.length && <p role="status">{tr("focusNoMatch", { query: query.trim() })}</p>}
      {sample.focus && <div className="oi-actions"><button type="button" className="oi-link" onClick={() => setFocus(null)}>{tr("showEveryone")}</button></div>}
    </form>}
    {ring ? canvas : <>
      {measured.overflowing && <p className="oi-map-hint">{tr("mapScrollHint")}</p>}
      <div ref={frame} className="oi-map-frame" role="region" aria-label={tr("mapFrame")} tabIndex={0}>{canvas}</div>
    </>}
    {legend && <p id={legendId} className="oi-map-hint">{legend}</p>}
  </>;
}

// One page of a long list with Previous and Next. Only the current page is in
// the document: an organization's whole roster as chips made the Neuro Map
// page hundreds of thousands of pixels tall
// (BUG-UG-WEB-ORG-MAP-RELATIONSHIPS-LISTS-EVERY-PERSON-20261002).
export const LIST_PAGE_SIZE = 25;

function PagedList({ items, label, tr, lang, children }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / LIST_PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const start = current * LIST_PAGE_SIZE;
  return <>
    {children(items.slice(start, start + LIST_PAGE_SIZE))}
    {pages > 1 && <nav className="oi-pager" aria-label={label}>
      <button type="button" className="oi-button oi-button--secondary" aria-disabled={current === 0} onClick={() => { if (current > 0) setPage(current - 1); }}>{tr("previousPage")}</button>
      <span role="status">{tr("pageRange", { start: formatCount(start + 1, lang), end: formatCount(Math.min(items.length, start + LIST_PAGE_SIZE), lang), total: formatCount(items.length, lang) })}</span>
      <button type="button" className="oi-button oi-button--secondary" aria-disabled={current + 1 === pages} onClick={() => { if (current + 1 < pages) setPage(current + 1); }}>{tr("nextPage")}</button>
    </nav>}
  </>;
}

function ChartEditor({ model, actor, adapter, tr, busy, commit }) {
  const [form, setForm] = useState(initialNode);
  // A content change (vacancy included, as in the server guard) drops an
  // existing seat back to unconfirmed unless the administrator chose a status
  // in this edit. Only that choice keeps a status; the vacancy box alone only
  // routes the save through the seat writer.
  const invalidate = (value, key, next) => {
    if (SEAT_CONTENT_FIELDS.has(key) && value.id && !value.statusChosen && value.seatStatus !== "unconfirmed") next.seatStatus = "unconfirmed";
    return next;
  };
  const set = (key) => (event) => setForm((value) => invalidate(value, key, { ...value, [key]: event.target.value }));
  const setSeat = (key) => (event) => setForm((value) => (key === "vacant"
    ? invalidate(value, key, { ...value, vacant: event.target.checked, seatTouched: true })
    : { ...value, seatStatus: event.target.value, seatTouched: true, statusChosen: true }));
  const parentOptions = model.charts.nodes.filter((node) => node.chartKind === form.chartKind && node.id !== form.id);
  return <div className="oi-split">
    <div className="oi-chart-grid">
      {ORGANIZATION_CHART_KINDS.map((kind) => <section className="oi-card" key={kind}>
        <div className="oi-card__heading"><h3>{tr(kind)}</h3><span>{model.charts.nodes.filter((node) => node.chartKind === kind).length}</span></div>
        <ChartCanvas nodes={model.charts.nodes.filter((node) => node.chartKind === kind)} rootId={model.charts.byKind[kind][0]?.id} label={tr(kind)} tr={tr} onEdit={model.writeAllowed ? setForm : null} />
        <Tree nodes={model.charts.byKind[kind]} tr={tr} onEdit={model.writeAllowed ? setForm : null} />
      </section>)}
    </div>
    {model.writeAllowed ? <form className="oi-form oi-card" onSubmit={(event) => { event.preventDefault(); commit(async () => {
      try {
        return await adapter.saveChartNode({ actor, ...form });
      } catch (error) {
        // Partial success: keep the saved ID and the chosen seat state so a
        // retry completes this node rather than creating a duplicate.
        if (error?.chartNodeSaved?.id) {
          setForm((value) => ({ ...value, id: error.chartNodeSaved.id, seatTouched: true }));
          error.noticeKey = "seatStatusSaveError";
          error.reloadAfterError = true;
        }
        throw error;
      }
    }, () => setForm(initialNode)); }}>
      <h3>{form.id ? tr("edit") : tr("addNode")}</h3>
      <div className="oi-form__grid">
        <Field label={tr("chart")}><select value={form.chartKind} onChange={set("chartKind")}>{ORGANIZATION_CHART_KINDS.map((kind) => <option key={kind} value={kind}>{tr(kind)}</option>)}</select></Field>
        <Field label={tr("kind")}><select value={form.nodeKind} onChange={set("nodeKind")}>{ORGANIZATION_NODE_KINDS.map((kind) => <option key={kind} value={kind}>{enumLabel(tr, "nodeKind", kind)}</option>)}</select></Field>
        <Field label={tr("label")}><input required maxLength={160} value={form.label} onChange={set("label")} /></Field>
        <Field label={tr("subtitle")}><input maxLength={240} value={form.subtitle || ""} onChange={set("subtitle")} /></Field>
        <Field label={tr("parent")}><select value={form.parentId || ""} onChange={set("parentId")}><option value="">{tr("root")}</option>{parentOptions.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></Field>
        <Field label={tr("x")}><input type="number" min="-10000" max="10000" value={form.positionX} onChange={set("positionX")} /></Field>
        <Field label={tr("y")}><input type="number" min="-10000" max="10000" value={form.positionY} onChange={set("positionY")} /></Field>
        <Field label={tr("order")}><input type="number" min="-100000" max="100000" value={form.sortOrder} onChange={set("sortOrder")} /></Field>
        <Field label={tr("seatStatusLabel")}><select value={form.seatStatus || "unconfirmed"} onChange={setSeat("seatStatus")}>{ORGANIZATION_SEAT_STATUSES.map((status) => <option key={status} value={status}>{enumLabel(tr, "seatStatus", status)}</option>)}</select></Field>
        <label className="oi-field oi-field--check"><input type="checkbox" checked={form.vacant === true} onChange={setSeat("vacant")} /><span>{tr("vacantSeat")}</span></label>
      </div>
      <p className="oi-hint">{tr("seatStatusHint")}</p>
      <div className="oi-actions"><BusyButton pending={busy} className="oi-button" type="submit">{busy ? tr("saving") : tr("save")}</BusyButton>{form.id && <button className="oi-button oi-button--secondary" type="button" onClick={() => setForm(initialNode)}>{tr("cancel")}</button>}</div>
    </form> : <p className="oi-callout">{tr("writeLocked")}</p>}
  </div>;
}

function RelationshipEditor({ model, actor, adapter, tr, lang = "en", busy, commit, client = null }) {
  const [edge, setEdge] = useState(initialRelationship);
  const [topic, setTopic] = useState(initialTopic);
  const nodes = model.relationships.nodes;
  const names = new Map(nodes.map((node) => [node.id, node.label]));
  const setEdgeValue = (key) => (event) => setEdge((value) => ({ ...value, [key]: event.target.value }));
  const setTopicValue = (key) => (event) => setTopic((value) => ({ ...value, [key]: event.target.value }));
  return <div className="oi-split">
    <div className="oi-card">
      <div className="oi-card__heading"><h3>{tr("relationships")}</h3><span>{tr("relationshipCount", { count: model.relationships.edges.length })}</span></div>
      <RelationshipCanvas graph={model.relationships} tr={tr} lang={lang} />
      {/* Relationship rows come first; people last, one page at a time. */}
      {model.relationships.edges.length ? <PagedList items={model.relationships.edges} label={tr("relationshipPages")} tr={tr} lang={lang}>{(page) => <ul className="oi-edge-list">{page.map((item) => <li key={item.id}><span>{names.get(item.source)}</span><strong>{enumLabel(tr, "relationshipKind", item.kind)} · {item.strength}/5</strong><span>{names.get(item.target)}</span></li>)}</ul>}</PagedList> : <p className="oi-empty">{tr("noRows")}</p>}
      <PagedList items={model.relationships.topics} label={tr("topicPages")} tr={tr} lang={lang}>{(page) => page.map((item) => <div className="oi-progress" key={`${item.memberId}-${item.topicKey}`}><div><strong>{names.get(item.memberId)}</strong><span>{item.topicLabel} · {enumLabel(tr, "topicState", item.state)}</span></div><progress max="100" value={item.progress}>{item.progress}%</progress></div>)}</PagedList>
      <PagedList items={nodes} label={tr("peoplePages")} tr={tr} lang={lang}>{(page) => <div className="oi-people">{page.map((node) => <span className="oi-person" key={node.id}><strong>{node.label}</strong>{node.roleLabel && <small>{node.roleLabel}</small>}</span>)}</div>}</PagedList>
      {/* REQ-UG-NEURO-MAP-DERIVED-GRAPH-20261001: derived connections and
          automatic topic readiness, read-only; "Keep as relationship" copies a
          derived connection into the manual form below. */}
      <DerivedGraphPanel client={client} hat={actor?.selectedHat || null} names={names} tr={tr} canKeep={model.writeAllowed} refreshKey={model.generatedAt}
        onKeep={(item) => setEdge({ id: "", sourceId: item.source, targetId: item.target, kind: "works_with", strength: item.strength })} />
    </div>
    {model.writeAllowed ? <div className="oi-editor-stack">
      <form className="oi-form oi-card" onSubmit={(event) => { event.preventDefault(); commit(() => adapter.saveRelationship({ actor, ...edge }), () => setEdge(initialRelationship)); }}>
        <h3>{tr("addRelationship")}</h3><div className="oi-form__grid">
          <Field label={tr("source")}><select required value={edge.sourceId} onChange={setEdgeValue("sourceId")}><option value="" />{nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></Field>
          <Field label={tr("target")}><select required value={edge.targetId} onChange={setEdgeValue("targetId")}><option value="" />{nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></Field>
          <Field label={tr("kind")}><select value={edge.kind} onChange={setEdgeValue("kind")}>{RELATIONSHIP_KINDS.map((kind) => <option key={kind} value={kind}>{enumLabel(tr, "relationshipKind", kind)}</option>)}</select></Field>
          <Field label={tr("strength")}><input type="number" min="1" max="5" value={edge.strength} onChange={setEdgeValue("strength")} /></Field>
        </div><BusyButton pending={busy} disabled={nodes.length < 2} className="oi-button" type="submit">{busy ? tr("saving") : tr("save")}</BusyButton>
      </form>
      <form className="oi-form oi-card" onSubmit={(event) => { event.preventDefault(); commit(() => adapter.saveTopicProgress({ actor, ...topic }), () => setTopic(initialTopic)); }}>
        <h3>{tr("addTopic")}</h3><div className="oi-form__grid">
          <Field label={tr("member")}><select required value={topic.memberId} onChange={setTopicValue("memberId")}><option value="" />{nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}</select></Field>
          <Field label={tr("topicKey")}><input required pattern="[a-z0-9][a-z0-9_\-]{0,79}" value={topic.topicKey} onChange={setTopicValue("topicKey")} /></Field>
          <Field label={tr("topicLabel")}><input required maxLength={160} value={topic.topicLabel} onChange={setTopicValue("topicLabel")} /></Field>
          <Field label={tr("state")}><select value={topic.state} onChange={setTopicValue("state")}>{TOPIC_PROGRESS_STATES.map((state) => <option key={state} value={state}>{enumLabel(tr, "topicState", state)}</option>)}</select></Field>
          <Field label={tr("progress")}><input type="number" min="0" max="100" value={topic.progress} onChange={setTopicValue("progress")} /></Field>
        </div><BusyButton pending={busy} disabled={!nodes.length} className="oi-button" type="submit">{busy ? tr("saving") : tr("save")}</BusyButton>
      </form>
    </div> : <p className="oi-callout">{tr("writeLocked")}</p>}
  </div>;
}

function TimelineEditor({ model, actor, adapter, tr, lang = "en", busy, commit }) {
  const [form, setForm] = useState(makeInitialTimeline);
  const set = (key) => (event) => setForm((value) => ({ ...value, [key]: event.target.value }));
  return <div className="oi-split">
    <div className="oi-card oi-timeline">{model.timeline.length ? model.timeline.map((item) => <article key={item.id}>
      <time dateTime={item.effectiveOn}>{item.effectiveOn}</time><div><span className="oi-badge">{enumLabel(tr, "timelineKind", item.kind)}</span><h3>{item.title}</h3>{item.detail && <p>{item.detail}</p>}{item.amountCents != null && <p className="oi-money">{formatUsd(item.amountCents, lang)} · {item.amountBasis}</p>}{item.sourceLabel && <small>{item.sourceLabel} · {item.sourceAsOf}</small>}</div>
    </article>) : <p className="oi-empty">{tr("noRows")}</p>}</div>
    {model.writeAllowed ? <form className="oi-form oi-card" onSubmit={(event) => { event.preventDefault(); commit(() => adapter.saveTimelineEvent({ actor, ...form, amountCents: form.amountCents === "" ? null : Math.round(Number(form.amountCents) * 100) }), () => setForm(makeInitialTimeline())); }}>
      <h3>{tr("addTimeline")}</h3><div className="oi-form__grid">
        <Field label={tr("kind")}><select value={form.kind} onChange={set("kind")}>{LEADERSHIP_TIMELINE_KINDS.map((kind) => <option key={kind} value={kind}>{enumLabel(tr, "timelineKind", kind)}</option>)}</select></Field>
        <Field label={tr("label")}><input required maxLength={180} value={form.title} onChange={set("title")} /></Field>
        <Field label={tr("detail")}><textarea maxLength={2000} value={form.detail} onChange={set("detail")} /></Field>
        <Field label={tr("effective")}><input required type="date" value={form.effectiveOn} onChange={set("effectiveOn")} /></Field>
        <Field label={tr("ended")}><input type="date" value={form.endedOn} onChange={set("endedOn")} /></Field>
        {form.kind === "payroll_snapshot" && <><Field label={tr("amount")}><input required type="number" min="0" step="0.01" value={form.amountCents} onChange={set("amountCents")} /></Field><Field label={tr("basis")}><input required maxLength={80} value={form.amountBasis} onChange={set("amountBasis")} /></Field><Field label={tr("sourceLabel")}><input required maxLength={180} value={form.sourceLabel} onChange={set("sourceLabel")} /></Field><Field label={tr("sourceAsOf")}><input required type="date" value={form.sourceAsOf} onChange={set("sourceAsOf")} /></Field></>}
      </div><BusyButton pending={busy} className="oi-button" type="submit">{busy ? tr("saving") : tr("save")}</BusyButton>
    </form> : <p className="oi-callout">{tr("writeLocked")}</p>}
  </div>;
}

function actorScopeFields(actor) {
  const roles = [...actor.organizationRoles].sort();
  return [
    actor.organizationId || "",
    actor.chapterId || "",
    actor.selectedHat,
    actor.userId || "",
    roles.join(","),
    actor.membershipStatus,
    actor.mfaSatisfied ? "1" : "0",
  ];
}

export function deriveOrganizationIntelligenceRequestScope({ actor, scopedActor, adapter, client, preview }, previous = null) {
  const normalizedActor = normalizeOrganizationIntelligenceActor(actor);
  const normalizedScopedActor = normalizeOrganizationIntelligenceActor(scopedActor);
  const actorInputKey = JSON.stringify(actorScopeFields(normalizedActor));
  const scopedActorKey = JSON.stringify(actorScopeFields(normalizedScopedActor));
  const actorInputChanged = previous !== null && previous.actorInputKey !== actorInputKey;
  const waitingForScopedActor = actorInputKey !== scopedActorKey
    && ((actorInputChanged && scopedActor === previous.scopedActorSource)
      || (previous?.waitingForScopedActor && scopedActor === previous.staleScopedActor));
  const activeActor = waitingForScopedActor ? normalizedActor : normalizedScopedActor;
  const adapterGeneration = previous
    && previous.adapter === adapter
    && previous.client === client
    && previous.preview === preview
    ? previous.adapterGeneration
    : (previous?.adapterGeneration ?? -1) + 1;
  return Object.freeze({
    actor: activeActor,
    adapter,
    client,
    preview,
    adapterGeneration,
    actorInputKey,
    scopedActorSource: scopedActor,
    staleScopedActor: waitingForScopedActor ? (previous?.staleScopedActor || scopedActor) : null,
    waitingForScopedActor,
    key: JSON.stringify([adapterGeneration, actorScopeFields(activeActor)]),
  });
}

export function OrganizationIntelligenceView({ actor, client, lang = "en", preview = false, adapter: adapterOverride, organizationConfiguration = null }) {
  const t = useOrganizationTranslator(lang);
  const tr = useCallback((key, vars) => t(`orgIntel.${key}`, vars), [t]);
  const scopedActor = useOrganizationIntelligenceActor(client, actor);
  const previewSnapshot = useRef(ORGANIZATION_INTELLIGENCE_PREVIEW_SNAPSHOT);
  const adapter = useMemo(() => adapterOverride || (preview ? createOrganizationIntelligenceAdapter({
    fetchIntelligence: async () => previewSnapshot.current,
    saveChartNode: async ({ actor: _actor, ...input }) => {
      const current = previewSnapshot.current;
      previewSnapshot.current = { ...current, chartNodes: [...current.chartNodes.filter((row) => row.id !== input.id), { ...input, id: input.id || `preview-node-${Date.now()}` }] };
    },
    saveRelationship: async ({ actor: _actor, ...input }) => {
      const current = previewSnapshot.current;
      previewSnapshot.current = { ...current, relationships: [...current.relationships.filter((row) => row.id !== input.id), { ...input, id: input.id || `preview-relationship-${Date.now()}` }] };
    },
    saveTopicProgress: async ({ actor: _actor, ...input }) => {
      const current = previewSnapshot.current;
      previewSnapshot.current = { ...current, topicProgress: [...current.topicProgress.filter((row) => row.memberId !== input.memberId || row.topicKey !== input.topicKey), input] };
    },
    saveTimelineEvent: async ({ actor: _actor, ...input }) => {
      const current = previewSnapshot.current;
      previewSnapshot.current = { ...current, timeline: [...current.timeline.filter((row) => row.id !== input.id), { ...input, id: input.id || `preview-timeline-${Date.now()}` }] };
    },
  }) : createWiredOrganizationIntelligenceAdapter(client)), [adapterOverride, client, preview]);
  const [model, setModel] = useState(null);
  const [routedTab, setTab] = useRoutedTab("organizationMap", "charts");
  // With the Neuro Map switched off its tab is not offered, and a link that
  // names it lands on the first tab that is (#8437). The snapshot is read on
  // every load, so it wins over the configuration, which arrived with the
  // page and can lag a change to the switch.
  const neuroMapOn = model?.neuroMapEnabled ?? neuroMapEnabled(organizationConfiguration);
  const subtitle = neuroMapReadOn(model?.neuroMapEnabled, organizationConfiguration) ? tr("sub") : tr("subWithoutNeuroMap");
  const tabs = [["charts", tr("charts")], ["relationships", tr("relationships")], ["timeline", tr("timeline")], ["connections", tr("connections")]]
    .filter(([key]) => key !== "relationships" || neuroMapOn);
  const tab = tabs.some(([key]) => key === routedTab) ? routedTab : tabs[0][0];
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [notice, setNotice] = useState("");
  const requestToken = useRef(0);
  const requestScopeRef = useRef(null);
  const requestScope = deriveOrganizationIntelligenceRequestScope(
    { actor, scopedActor, adapter, client, preview },
    requestScopeRef.current,
  );
  requestScopeRef.current = requestScope;
  const requestKey = requestScope.key;
  const scopedActorRef = useRef(requestScope.actor);
  scopedActorRef.current = requestScope.actor;
  const [renderedRequestKey, setRenderedRequestKey] = useState(requestKey);
  const requestKeyRef = useRef(requestKey);
  if (renderedRequestKey !== requestKey) {
    setRenderedRequestKey(requestKey);
    requestToken.current += 1;
    setModel(null);
    setNotice("");
    setLoading(true);
    setBusy(false);
  }
  requestKeyRef.current = requestKey;
  // Record 8435: busy is cleared above whenever the request scope changes, so
  // the chart lock lives for one scope activation (A to B and back to A is a
  // new one) and a late answer from an earlier activation changes nothing.
  const busyScope = useBusyScope(requestKey);
  const load = useCallback(async (startedRequestKey) => {
    const boundRequestKey = typeof startedRequestKey === "string" ? startedRequestKey : requestKeyRef.current;
    if (requestKeyRef.current !== boundRequestKey) return;
    const token = ++requestToken.current;
    setLoading(true);
    const next = await adapter.loadIntelligence({ actor: scopedActorRef.current });
    if (requestKeyRef.current !== boundRequestKey || token !== requestToken.current) return;
    setModel(next);
    setLoading(false);
  }, [adapter]);
  useEffect(() => {
    load();
    return () => { requestToken.current += 1; };
  }, [load, requestKey]);
  const commit = (operation, reset) => runBusyWrite(busyWriteRef, `chart:${busyScope.generation}`, () => commitNow(operation, reset));
  const commitNow = async (operation, reset) => {
    const startedRequestKey = requestKeyRef.current;
    const startedGeneration = busyScope.generation;
    const stale = () => !busyScope.isCurrent(startedGeneration);
    setBusy(true);
    setNotice("");
    try {
      await operation();
      if (stale()) return;
      reset?.();
      await load(startedRequestKey);
      if (stale()) return;
      setNotice(tr("saved"));
    } catch (error) {
      if (stale()) return;
      if (error?.reloadAfterError) await load(startedRequestKey).catch(() => {});
      if (stale()) return;
      setNotice(tr(error?.noticeKey || "saveError"));
    } finally {
      if (!stale()) setBusy(false);
    }
  };
  const visibleModel = renderedRequestKey === requestKey ? model : null;
  return <section className="oi-shell" aria-label={tr("workspace")} data-mi1-surface="organization-intelligence">
    <header className="oi-hero"><p>{tr("eyebrow")}</p><h1>{t("nav.organizationMap")}</h1><span>{subtitle}</span></header>
    <Status model={visibleModel} loading={loading} tr={tr} onRetry={load} />
    {visibleModel?.state === "ready" && <><div className="oi-tabs" role="group" aria-label={tr("title")}>{tabs.map(([key, label]) => <RoutedTabLink group="organizationMap" value={key} key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</RoutedTabLink>)}</div>
      {notice && <p className="oi-notice" role="status">{notice}</p>}
      {tab === "charts" && <ChartEditor model={visibleModel} actor={requestScope.actor} adapter={adapter} tr={tr} busy={busy} commit={commit} />}
      {tab === "relationships" && <RelationshipEditor model={visibleModel} actor={requestScope.actor} adapter={adapter} tr={tr} lang={lang} busy={busy} commit={commit} client={preview || adapterOverride ? null : client} />}
      {tab === "timeline" && <TimelineEditor model={visibleModel} actor={requestScope.actor} adapter={adapter} tr={tr} lang={lang} busy={busy} commit={commit} />}
      {tab === "connections" && <ConnectionSuggestions key={requestKey} client={client} actor={requestScope.actor} preview={preview} lang={lang} organizationConfiguration={organizationConfiguration} />}
    </>}
  </section>;
}
