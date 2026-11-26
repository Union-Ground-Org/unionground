// @mentions on case notes (lane 5.6). The model is the one chapter task
// comments already use -- an explicit list of user ids travels beside the
// body, and the server re-checks every id against the case's own chapter --
// because a server that had to re-parse "@Ana" out of free text would have to
// guess which Ana, and guessing wrong notifies the wrong person.
//
// What is new here is the text side: the author types "@" and the composer
// completes a full name into the body, so the note still reads like a
// sentence to somebody with no directory in front of them, and the reader's
// renderer can mark the same names.

const NAME_CHARS = "\\p{L}\\p{M}0-9'’.\\-";

// The token under the caret: an "@" that opens a word, then at most two
// further whitespace-separated parts (three parts in all). "@Maria de Cruz"
// sits inside that window. Past that, the caret is not inside a mention, so
// a half-typed name cannot swallow the rest of a paragraph.
const ACTIVE_MENTION = new RegExp(
  `(^|\\s)@([${NAME_CHARS}]*(?:[ \\u00a0][${NAME_CHARS}]+){0,2}[ \\u00a0]?)$`,
  "u",
);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns null when the caret is not inside a mention, so the picker can stay
// closed rather than filtering on a query nobody typed.
export function activeMentionQuery(body, caret = null) {
  const text = String(body ?? "");
  const position = caret == null ? text.length : Math.max(0, Math.min(caret, text.length));
  const match = ACTIVE_MENTION.exec(text.slice(0, position));
  if (!match) return null;
  return { query: match[2].trim(), start: position - match[2].length - 1, end: position };
}

export function filterMentionCandidates(candidates, query) {
  const needle = String(query || "").trim().toLowerCase();
  const people = candidates || [];
  if (!needle) return people;
  return people.filter((person) => String(person?.fullName || "").toLowerCase().includes(needle));
}

// Completing writes the whole name back into the body and leaves one trailing
// space, so the author keeps typing instead of hunting for the caret.
export function completeMention(body, caret, fullName) {
  const text = String(body ?? "");
  const active = activeMentionQuery(text, caret);
  const name = String(fullName || "").trim();
  if (!active || !name) return { body: text, caret: caret ?? text.length };
  const inserted = `@${name} `;
  return {
    body: text.slice(0, active.start) + inserted + text.slice(active.end),
    caret: active.start + inserted.length,
  };
}

// Preserve selected identities only for untouched text. Independent common
// prefixes/suffixes deliberately widen an ambiguous edit (e.g. deleting one
// of two identical names): losing a selection is safer than moving it to the
// wrong occurrence. The author can select that person again.
export function reconcileMentionSelections(previousBody, body, selections) {
  if (previousBody === body) return selections;
  let prefix = 0;
  let suffix = 0;
  while (prefix < Math.min(previousBody.length, body.length) && previousBody[prefix] === body[prefix]) prefix += 1;
  while (suffix < Math.min(previousBody.length, body.length)
    && previousBody[previousBody.length - suffix - 1] === body[body.length - suffix - 1]) suffix += 1;
  const delta = body.length - previousBody.length;
  const start = Math.min(prefix, previousBody.length - suffix, body.length - suffix);
  const end = Math.max(previousBody.length - suffix, prefix + Math.max(0, -delta));
  return selections.flatMap((selection) => {
    if (selection.end <= start) return [selection];
    if (selection.start >= end) return [{ ...selection, start: selection.start + delta, end: selection.end + delta }];
    return [];
  });
}

// Typed names count only when unambiguous. Explicit picker selections carry
// the recipient id and text range, so directory order never decides identity.
// Longest-first tokenization still prevents a shorter name stealing a match.
export function matchMentionCandidates(body, candidates, selections = []) {
  const named = new Set(
    mentionSegments(body, candidates, selections)
      .filter((segment) => segment.kind === "mention")
      .map((segment) => segment.userId),
  );
  return (candidates || [])
    .filter((person) => person?.userId && named.has(person.userId))
    .map((person) => person.userId);
}

// Reading side. Longest names first so "@Ana Ruiz" is one mention rather than
// "@Ana" followed by stray text, and unknown ids are simply not marked -- a
// mentioned member the reader may not see stays plain text instead of leaking
// a name the reader was never shown.
export function mentionSegments(body, mentions, selections = []) {
  const text = String(body ?? "");
  const people = (mentions || [])
    .filter((person) => person?.userId && String(person?.fullName || "").trim())
    .sort((a, b) => b.fullName.length - a.fullName.length);
  if (!text || people.length === 0) return text ? [{ kind: "text", text }] : [];

  const pattern = new RegExp(
    `@(${people.map((person) => escapeRegExp(person.fullName.trim())).join("|")})(?![${NAME_CHARS}])`,
    "gu",
  );
  const segments = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    const sameName = people.filter((entry) => entry.fullName.trim() === match[1]);
    const selected = selections.find((entry) => entry.start === match.index
      && entry.end === match.index + match[0].length && entry.fullName === match[1]);
    const person = selected
      ? sameName.find((entry) => entry.userId === selected.userId)
      : new Set(sameName.map((entry) => entry.userId)).size === 1 ? sameName[0] : null;
    segments.push(person
      ? { kind: "mention", text: match[0], userId: person.userId, fullName: person.fullName }
      : { kind: "text", text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
