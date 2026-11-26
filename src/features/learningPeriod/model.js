// REQ-UG-LEARNING-PERIOD-BANNER-HISTORY-UNDO-UI-20261103 (#6947):
// the pure half of the learning-period screens, shared by web and the native
// app. It holds no copy: each surface passes its own translator, so the native
// graph never reaches the web catalogue (tests/mi1-member-qa-mobile-wiring.test.js). It reads the payloads of get_organization_learning_period and
// list_my_learning_history (supabase/migrations/20261103163000_learning_period_engine.sql)
// and decides what a line, a banner and a badge say. The server stays the
// authority: a line offered Undo here can still be refused, and the refusal's
// reason is shown on that line.
import { dateTimeFormatCore } from "../../lib/i18n/format.js";

/**
 * @typedef {object} LearningPeriod
 * @property {string | null} organizationId
 * @property {boolean} used
 * @property {boolean} running
 * @property {string | null} periodId
 * @property {number | null} lengthDays
 * @property {string | null} startsAt
 * @property {string | null} endsAt
 * @property {string | null} endedEarlyAt
 * @property {string | null} closedAt
 * @property {string | null} endAt
 * @property {boolean} isAdmin
 */
/**
 * @typedef {object} LearningEntry
 * @property {string} id
 * @property {string} actionKind
 * @property {string} domain
 * @property {string} disposition
 * @property {string | null} targetTable
 * @property {string | null} targetId
 * @property {string | null} parentEntryId
 * @property {string} state
 * @property {number} version
 * @property {string} createdAt
 * @property {string | null} undoneAt
 * @property {string | null} keptAt
 * @property {boolean} sent
 * @property {boolean} undoable
 */
/** @typedef {{ running: boolean, entries: LearningEntry[] }} LearningHistory */

// The ended notice stays on the banner for two weeks after the end.
const ENDED_NOTICE_MS = 14 * 24 * 60 * 60 * 1000;

function time(value) {
  const parsed = typeof value === "string" || value instanceof Date ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value) {
  return typeof value === "string" && value ? value : null;
}

/**
 * The period payload, or null when it is not one.
 * @param {any} payload
 * @returns {LearningPeriod | null}
 */
export function normalizePeriod(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const endedEarlyAt = text(payload.endedEarlyAt);
  const endsAt = text(payload.endsAt);
  return {
    organizationId: text(payload.organizationId),
    used: payload.used === true,
    running: payload.running === true,
    periodId: text(payload.periodId),
    lengthDays: Number.isInteger(payload.lengthDays) ? payload.lengthDays : null,
    startsAt: text(payload.startsAt),
    endsAt,
    endedEarlyAt,
    closedAt: text(payload.closedAt),
    endAt: endedEarlyAt ?? endsAt,
    isAdmin: payload.isAdmin === true,
  };
}

// unused, running or ended. The clock check mirrors the server's: a period
// whose end has passed reads as ended even before the end job closes it.
/**
 * @param {LearningPeriod | null} period
 * @param {number} [now]
 * @returns {"unused" | "running" | "ended"}
 */
export function periodPhase(period, now = Date.now()) {
  if (!period || !period.used) return "unused";
  const end = time(period.endAt);
  if (period.running && end !== null && now < end) return "running";
  return "ended";
}

// "Tuesday, November 17 at 9:14 AM ET". The end is an Eastern instant
// (#7649, #7654, #7661), not the device zone. Intl applies New York's
// standard or daylight offset for that date. The label is the literal ET.
// src/lib/easternTimestamp.js is still on open PR #7652, so the zone and
// the label are inlined here with the same America/New_York option and the
// same trailing ET. An explicit non-Eastern zone stays unlabeled.
const EASTERN_TIME_ZONE = "America/New_York";

/**
 * @param {string | null | undefined} value
 * @param {string} lang
 * @param {(key: string, vars?: Record<string, string | number>) => string} t
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatPeriodWhen(value, lang, t, timeZone = EASTERN_TIME_ZONE) {
  const at = time(value);
  if (at === null) return "";
  const date = new Date(at);
  const day = dateTimeFormatCore(lang, { weekday: "long", month: "long", day: "numeric", timeZone }).format(date);
  const clock = dateTimeFormatCore(lang, { hour: "numeric", minute: "2-digit", timeZone }).format(date);
  const labeled = timeZone === EASTERN_TIME_ZONE ? `${clock} ET` : clock;
  return t("learningPeriod.when", { day, time: labeled });
}

/**
 * Whether the banner shows at all, and which line.
 * @param {LearningPeriod | null} period
 * @param {number} [now]
 * @returns {{ phase: "running" | "ended", when: string | null, isAdmin: boolean } | null}
 */
export function bannerState(period, now = Date.now()) {
  const phase = periodPhase(period, now);
  if (phase === "running") return { phase, when: period.endAt, isAdmin: period.isAdmin };
  if (phase === "ended") {
    const end = time(period.closedAt) ?? time(period.endAt);
    if (end !== null && now - end <= ENDED_NOTICE_MS) return { phase, when: period.endAt, isAdmin: false };
  }
  return null;
}

/**
 * One history entry, or null when the row is not one.
 * @param {any} row
 * @returns {LearningEntry | null}
 */
function normalizeEntry(row) {
  if (!row || typeof row !== "object") return null;
  if (!text(row.id) || !text(row.actionKind) || !text(row.state) || !Number.isSafeInteger(row.version) || time(row.createdAt) === null) return null;
  return {
    id: row.id,
    actionKind: row.actionKind,
    domain: text(row.domain) ?? "other",
    disposition: text(row.disposition) ?? "excluded",
    targetTable: text(row.targetTable),
    targetId: text(row.targetId),
    parentEntryId: text(row.parentEntryId),
    state: row.state,
    version: row.version,
    createdAt: row.createdAt,
    undoneAt: text(row.undoneAt),
    keptAt: text(row.keptAt),
    sent: row.sent === true,
    undoable: row.undoable === true,
  };
}

/**
 * @param {any} payload
 * @returns {LearningHistory | null}
 */
export function normalizeHistory(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.entries)) return null;
  const entries = /** @type {LearningEntry[]} */ (payload.entries.map(normalizeEntry).filter(Boolean));
  return { running: payload.running === true, entries };
}

// What each permanent kind's line says (#7182): "sent" when it went out to
// other people, "final" when something was destroyed or ended for good, and
// "kept" when it was recorded and kept without anything going out. Every
// permanent kind in private.learning_action_kinds is listed
// (tests/learning-period-history-lines.test.js); one that is not reads as
// kept, which never claims that something went out.
export const PERMANENT_STATUS = Object.freeze({
  analytics_export_request: "sent",
  ballot_nominations_export_request: "sent",
  case_export_request: "sent",
  coordination_export_request: "sent",
  digital_action_export_request: "sent",
  member_directory_export_request: "sent",
  organization_export_request: "sent",
  survey_export_request: "sent",
  task_comment: "sent",
  task_message: "sent",
  broadcast_publish: "sent",
  civic_message_send: "sent",
  conversation_start: "sent",
  coordination_message_send: "sent",
  digital_action_join: "sent",
  invitation_send: "sent",
  message_edit: "sent",
  message_send: "sent",
  peer_message_send: "sent",
  thread_post: "sent",
  task_file_remove: "final",
  case_file_remove: "final",
  message_remove: "final",
  broadcast_retract: "final",
  chapter_membership_revoke_final: "final",
  task_template_update: "kept",
  automation_definition_save: "kept",
  case_outcome_kept: "kept",
  casework_macro_save_kept: "kept",
  live_poll_edit: "kept",
  live_poll_meeting: "kept",
  live_poll_transition: "kept",
  retaliation_report_submit: "kept",
  retaliation_report_withdraw: "kept",
  retaliation_pattern_note: "kept",
  digital_action_leave: "kept",
});

function permanentStatus(kind) {
  return Object.hasOwn(PERMANENT_STATUS, kind) ? PERMANENT_STATUS[kind] : "kept";
}

function later(a, b) {
  const ta = time(a.createdAt);
  const tb = time(b.createdAt);
  return ta > tb || (ta === tb && a.id > b.id);
}

// The undo chain undo_my_learning_action builds, for the confirmation: the
// entry, your later active entries on the same targets, and every entry of a
// bulk action one of them belongs to. History lists only your own entries,
// so every row here is already yours.
/**
 * @param {string} entryId
 * @param {LearningEntry[]} entries
 * @returns {LearningEntry[]}
 */
export function undoChain(entryId, entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (!byId.has(entryId)) return [];
  const chain = new Set([entryId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...chain]) {
      const current = byId.get(id);
      if (!current) continue;
      for (const other of entries) {
        if (chain.has(other.id)) continue;
        const sameTargetLater = other.state === "active" && other.targetTable && other.targetTable === current.targetTable
          && other.targetId === current.targetId && later(other, current);
        const child = other.state === "active" && other.parentEntryId === current.id;
        const parent = other.id === current.parentEntryId;
        if (sameTargetLater || child || parent) { chain.add(other.id); grew = true; }
      }
    }
  }
  return [...chain].map((id) => byId.get(id)).sort((a, b) => (later(a, b) ? -1 : 1));
}

// What the confirmation lists: how many later steps go with this one, and
// which permanent actions on the same targets stay sent.
/**
 * @param {string} entryId
 * @param {LearningEntry[]} entries
 * @returns {{ laterSteps: number, staysSent: LearningEntry[] }}
 */
export function undoSummary(entryId, entries) {
  const chain = undoChain(entryId, entries);
  const requested = chain.find((entry) => entry.id === entryId);
  if (!requested) return { laterSteps: 0, staysSent: [] };
  const targets = new Set(chain.filter((entry) => entry.targetTable).map((entry) => `${entry.targetTable}:${entry.targetId}`));
  const staysSent = entries.filter((entry) => entry.disposition === "permanent" && permanentStatus(entry.actionKind) === "sent"
    && targets.has(`${entry.targetTable}:${entry.targetId}`) && later(entry, requested));
  return { laterSteps: chain.length - 1, staysSent };
}

// The line's status and, when Undo is not offered, the reason. A refusal the
// server gave on an earlier attempt (refusals: entry id -> reason key) wins
// over the offer until the history is read again.
/**
 * @param {{ id: string, state: string, disposition: string, actionKind: string, undoable: boolean }} entry
 * @param {{ running?: boolean, refusals?: Map<string, string> | null }} [options]
 * @returns {{ status: string, reasonKey: string | null }}
 */
export function entryStatus(entry, { running = false, refusals = null } = {}) {
  if (entry.state === "undone") return { status: "undone", reasonKey: null };
  if (entry.disposition === "permanent") return { status: permanentStatus(entry.actionKind), reasonKey: null };
  if (entry.disposition === "excluded") return { status: "refused", reasonKey: "learningPeriod.reason.excluded" };
  if (entry.state === "kept") return { status: "kept", reasonKey: null };
  const refused = refusals?.get?.(entry.id);
  if (refused) return { status: "refused", reasonKey: refused };
  if (!running) return { status: "refused", reasonKey: "learningPeriod.reason.ended" };
  if (entry.undoable) return { status: "available", reasonKey: null };
  return { status: "refused", reasonKey: "learningPeriod.reason.noLonger" };
}

// The server's refusal, as the reason the line shows. Unknown failures read
// as "nothing changed", which is what a rolled-back undo means.
/**
 * @param {unknown} error
 * @returns {string}
 */
export function undoRefusalReason(error) {
  const failure = /** @type {{ message?: unknown, code?: unknown } | null} */ (error);
  const message = String(failure?.message ?? "").toLowerCase();
  const code = String(failure?.code ?? "");
  if (message.includes("someone else has changed")) return "learningPeriod.reason.changedByOther";
  if (message.includes("changed since your practice action")) return "learningPeriod.reason.changed";
  if (message.includes("learning entry changed")) return "learningPeriod.reason.stale";
  if (message.includes("learning period has ended")) return "learningPeriod.reason.ended";
  if (message.includes("no longer be undone") || message.includes("handler unavailable")) return "learningPeriod.reason.noLonger";
  if (message.includes("not found") || code === "P0002") return "learningPeriod.reason.noLonger";
  if (code === "42501" || message.includes("legal hold") || message.includes("permission")) return "learningPeriod.reason.notAllowed";
  return "learningPeriod.reason.failed";
}

// What a line calls its action. Every journalled kind has a line of its own
// (tests/learning-period-history-lines.test.js); one that somehow lacks it
// reads by its domain. A translator answers an unknown key with the key
// itself, which is how a missing line is told apart.
/**
 * @param {{ actionKind: string, domain: string }} entry
 * @param {(key: string, vars?: Record<string, string | number>) => string} t
 * @returns {string}
 */
export function kindText(entry, t) {
  const key = `learningPeriod.kind.${entry.actionKind}`;
  const own = t(key);
  if (own !== key) return own;
  const domainKey = `learningPeriod.domain.${entry.domain}`;
  const domainText = t(domainKey);
  const domain = domainText !== domainKey ? domainText : t("learningPeriod.domain.other");
  return t("learningPeriod.kind.fallback", { domain });
}

// The Practice badge for a flag from private.learning_practice_flags:
// "practice" (created during the period; it stays after the end) or
// "practice_edit" (changed during it; only while it runs). The badge never
// names who acted unless the viewer is that person.
/**
 * @param {string | null | undefined} flag
 * @param {{ running?: boolean, mine?: boolean }} [options]
 * @returns {{ tone: string, labelKey: string, titleKey: string } | null}
 */
export function practiceBadge(flag, { running = false, mine = false } = {}) {
  if (flag === "practice") return { tone: "practice", labelKey: "learningPeriod.badge.practice", titleKey: "learningPeriod.badge.practiceLabel" };
  if (flag === "practice_edit" && running) {
    const key = mine ? "learningPeriod.badge.editMine" : "learningPeriod.badge.edit";
    return { tone: "edit", labelKey: key, titleKey: key };
  }
  return null;
}
