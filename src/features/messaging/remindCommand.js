// `/remind` composer command (REQ-UG-REMIND-HERE-20261001).
//
// Restored from the old app's pure parser
// (de7df4b57c^:app/dashboard/messages/remind-command.ts, V2 order 33). Web
// (src/views/ProductHubView.jsx) and native (apps/mobile/app/channel/[id].tsx)
// share this file, so both clients accept exactly the same grammar:
//
//   /remind here in <N><m|h|d> <text>          /remind here in 20m stand-down review
//   /remind here tomorrow [time] <text>        /remind here tomorrow 9am file the report
//   /remind here on YYYY-MM-DD [time] <text>   /remind here on 2026-07-01 14:30 contract vote
//   /remind me ...                             same time grammar, a personal reminder
//   /remind help                               usage
//
// Time tokens accept `9am`, `12pm`, `9:30am`, `14:30`, `09:00`. The tomorrow
// and on-date forms default to 9:00 local time. The parser runs on the
// member's device, so wall-clock times resolve in the member's own time zone
// (the JS engine applies the real UTC offset, DST included, for that date) and
// the resolved instant is what the server receives. The server re-checks the
// instant against its own clock and bounds.
//
// Any draft that starts with `/remind` returns a structured result and must
// never be sent as a chat message.

export const REMIND_MAX_NOTE_LENGTH = 500;

/** Inclusive scheduling horizon, mirroring the server's one-year bound. */
const REMIND_MAX_HORIZON_MS = 364 * 24 * 60 * 60 * 1000;

/** Minimum lead so a request's own flight time cannot make a pick "past". */
const REMIND_MIN_LEAD_MS = 60 * 1000;

const COMMAND_RE = /^\/remind(?:\s|$)/i;
const IN_RE = /^in\s+(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i;
const ON_RE = /^on\s+(\d{4})-(\d{2})-(\d{2})\b/i;
const TOMORROW_RE = /^tomorrow\b/i;
// A time token must be unambiguous: `H:MM` (optionally am/pm) or `H(am|pm)`.
// A bare number like `9` is note text, not a time.
const TIME_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)?(?=\s|$)|^(\d{1,2})\s*(am|pm)(?=\s|$)/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const DEFAULT_TIME = { hour: 9, minute: 0 };

/** True when the draft starts with the /remind command word. */
export function isRemindCommand(text) {
  return COMMAND_RE.test(String(text ?? "").trim());
}

function unitKey(raw) {
  const first = raw[0].toLowerCase();
  return first === "m" ? "m" : first === "h" ? "h" : "d";
}

function error(code, detail = null) {
  return { kind: "error", code, detail };
}

function takeTimeToken(text) {
  const match = TIME_RE.exec(text);
  if (!match) return { time: null, rest: text };
  let hour;
  let minute;
  let meridiem;
  if (match[1] !== undefined) {
    hour = Number(match[1]);
    minute = Number(match[2]);
    meridiem = match[3]?.toLowerCase();
  } else {
    hour = Number(match[4]);
    minute = 0;
    meridiem = match[5]?.toLowerCase();
  }
  const token = match[0].trim();
  if (minute > 59) return { error: token };
  if (meridiem) {
    if (hour < 1 || hour > 12) return { error: token };
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return { error: token };
  }
  return { time: { hour, minute }, rest: text.slice(match[0].length).trim() };
}

function noteOrError(raw, target, remindAt, now) {
  const note = raw.trim();
  if (!note) return error("missing_note");
  if (note.length > REMIND_MAX_NOTE_LENGTH) return error("note_too_long");
  if (remindAt.getTime() < now.getTime() + REMIND_MIN_LEAD_MS) return error("past");
  if (remindAt.getTime() - now.getTime() > REMIND_MAX_HORIZON_MS) return error("too_far");
  return { kind: "reminder", target, remindAt, note };
}

function parseTomorrow(afterTarget, target, now) {
  const token = takeTimeToken(afterTarget.replace(TOMORROW_RE, "").trim());
  if ("error" in token) return error("invalid_time", token.error);
  const time = token.time ?? DEFAULT_TIME;
  const remindAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, time.hour, time.minute, 0, 0);
  return noteOrError(token.rest, target, remindAt, now);
}

function parseOnDate(afterTarget, onMatch, target, now) {
  const year = Number(onMatch[1]);
  const month = Number(onMatch[2]);
  const day = Number(onMatch[3]);
  const token = takeTimeToken(afterTarget.slice(onMatch[0].length).trim());
  if ("error" in token) return error("invalid_time", token.error);
  const time = token.time ?? DEFAULT_TIME;
  const remindAt = new Date(year, month - 1, day, time.hour, time.minute, 0, 0);
  // Calendar overflow (2026-02-30 rolls into March) is refused, not shifted.
  if (remindAt.getFullYear() !== year || remindAt.getMonth() !== month - 1 || remindAt.getDate() !== day) {
    return error("invalid_date", `${onMatch[1]}-${onMatch[2]}-${onMatch[3]}`);
  }
  return noteOrError(token.rest, target, remindAt, now);
}

/**
 * Parse a `/remind …` draft.
 *
 * @param {string} input the composer draft
 * @param {Date} now the device clock
 * @returns {null
 *   | { kind: 'help' }
 *   | { kind: 'reminder', target: 'here' | 'me', remindAt: Date, note: string }
 *   | { kind: 'error', code: string, detail: string | null }}
 *   null when the draft is not a /remind command and should be sent normally.
 */
export function parseRemindCommand(input, now = new Date()) {
  const trimmed = String(input ?? "").trim();
  if (!COMMAND_RE.test(trimmed)) return null;
  const rest = trimmed.replace(/^\/remind\s*/i, "").trim();
  if (rest === "" || /^help(?:\s|$)/i.test(rest)) return { kind: "help" };
  const targetMatch = /^(me|here)(?:\s|$)/i.exec(rest);
  if (!targetMatch) return error("missing_target");
  const target = targetMatch[1].toLowerCase();
  const afterTarget = rest.slice(targetMatch[0].length).trim();
  if (!afterTarget) return error("missing_time");

  const inMatch = IN_RE.exec(afterTarget);
  if (inMatch) {
    const amount = Number(inMatch[1]);
    if (amount < 1) return error("missing_time");
    const remindAt = new Date(now.getTime() + amount * UNIT_MS[unitKey(inMatch[2])]);
    return noteOrError(afterTarget.slice(inMatch[0].length), target, remindAt, now);
  }
  if (TOMORROW_RE.test(afterTarget)) return parseTomorrow(afterTarget, target, now);
  const onMatch = ON_RE.exec(afterTarget);
  if (onMatch) return parseOnDate(afterTarget, onMatch, target, now);
  return error("missing_time");
}

/** English usage text; native prints it as is, web localizes by error code. */
export const REMIND_USAGE_EN = [
  "/remind here in 20m <what>",
  "/remind here tomorrow 9am <what>",
  "/remind here on 2026-07-01 14:30 <what>",
].join("\n");

const ERROR_TEXT_EN = Object.freeze({
  missing_target: 'Start with "/remind here".',
  missing_time: 'Add a time: "in 20m", "tomorrow 9am" or "on 2026-07-01".',
  missing_note: "Add what to remind the channel staff about.",
  note_too_long: `Keep the reminder under ${REMIND_MAX_NOTE_LENGTH} characters.`,
  past: "That time has passed. Pick a future time.",
  too_far: "Reminders can be set up to a year ahead.",
  invalid_time: "That time is not valid.",
  invalid_date: "That date is not valid.",
  me_not_here: 'In a channel, "/remind here" reminds the channel staff. To remind only yourself, use "Remind me…" on a message.',
});

/** English text for a parse error code (native is English-only). */
export function remindErrorTextEn(code) {
  return ERROR_TEXT_EN[code] ?? ERROR_TEXT_EN.missing_time;
}
