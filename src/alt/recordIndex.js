// The member's own record as the prototype's day-indexed world
// (REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030). The prototype's
// timeline, calendar and marquee read UG.world.updates and meetings, sample
// rows typed win, action, meeting, vote and bargaining. Here the same widgets
// read only what the member's snapshot already holds: broadcasts (updates),
// events (meetings, deadlines and date-only entries, each keeping its kind),
// ballots (votes) and notes on the member's own cases.
// Nothing is invented; a type with no rows simply has no marks. Each item
// carries the chapter its row names, for the All updates chapter filter
// (REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030): null when the row
// went to the whole organization or names none, undefined when the snapshot
// does not say (broadcasts and case notes; the page reads those itself).

import { notePreview } from "../lib/notePreview.js";

export const RECORD_TYPES = ["update", "event", "vote", "case"];

// Mark colours from the design's palette (components.js MARK_COL). Marks
// carry white text and sit on the white track and the panel, so each is a
// design colour that holds 4.5:1 against white and 3:1 against the panel:
// the action gold (2.3:1) and the win green (4.3:1) give way to their
// design text variants.
export const RECORD_COLOR = {
  update: "var(--ug-act-text)",
  event: "var(--ug-case)",
  vote: "var(--ug-purple)",
  case: "var(--ug-green-text)",
};

const DAY = 86_400_000;

function at(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" || !value) return null;
  // A civil date (YYYY-MM-DD) is local noon of that day, as homeFeed.js reads it.
  const civil = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = civil ? new Date(Number(civil[1]), Number(civil[2]) - 1, Number(civil[3]), 12) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function dayKey(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function recordItems(data) {
  const items = [];
  for (const row of data?.broadcasts ?? []) {
    const when = at(row.publishedAt);
    if (when) items.push({ type: "update", id: `update-${row.id}`, chapterId: row.chapterId, title: row.title || "", sub: row.sender || "", at: when, source: row });
  }
  for (const row of data?.events ?? []) {
    if (row.cancelledAt) continue;
    const when = at(row.startsAt) ?? at(row.eventDate);
    // The event keeps its own kind: only a "meeting" can be attended.
    if (when) items.push({ type: "event", kind: row.eventKind ?? "meeting", id: `event-${row.id}`, chapterId: row.chapterId, title: row.title || "", sub: [row.chapterName, row.location].filter(Boolean).join(" · "), at: when, source: row });
  }
  for (const row of data?.planItems ?? []) {
    if (row.kind !== "ballot") continue;
    const when = at(row.closesAt);
    if (when) items.push({ type: "vote", id: `vote-${row.id}`, chapterId: row.chapterId, title: row.title || "", sub: row.meta || "", at: when, source: row });
  }
  for (const item of data?.cases ?? []) {
    for (const update of item.updates ?? []) {
      const when = at(update.created_at);
      if (when) items.push({ type: "case", id: `case-${item.id}-${update.id}`, chapterId: item.chapterId, title: item.title || item.reference || "", sub: notePreview(update.body), at: when, source: item });
    }
  }
  return items.sort((left, right) => left.at - right.at);
}

// Where a record mark or card opens (BUG-UG-ALT-UPDATES-CARDS-OPEN-NOTHING-20261102):
// an update opens its own broadcast, as the Now page does; an open ballot opens
// its choice dialog; a closed ballot, which the choice dialog refuses, opens
// Votes on the past ballots that list its result.
export function recordTarget(item) {
  const source = item?.source ?? {};
  if (item?.type === "event") return { navigate: ["events", `/m/events?event=${encodeURIComponent(source.id)}`] };
  if (item?.type === "update") return { broadcastId: source.id };
  if (item?.type === "vote") return source.closed ? { navigate: ["voting", "/m/voting/past"] } : { planItem: source };
  return { navigate: ["cases", "/m/cases", { view: "cases", caseId: source.id }] };
}

// Items grouped by local calendar day (components.js C.dayIndex).
export function dayIndex(items) {
  const map = new Map();
  for (const item of items) {
    const key = dayKey(item.at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Range presets by content width (components.js C.tlDaysForViewport).
export function timelineDaysFor(width) {
  return width < 760 ? 30 : width < 1080 ? 60 : 90;
}

export function itemsInLastDays(items, days, now = new Date()) {
  const end = dayKey(now) + DAY;
  const start = end - days * DAY;
  return items.filter((item) => item.at.getTime() >= start && item.at.getTime() < end);
}

export { DAY };
