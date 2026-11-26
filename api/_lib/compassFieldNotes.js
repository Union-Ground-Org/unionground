// REQ-UG-FIELD-NOTES-AI-PACKET-20261001
//
// Validates public.get_compass_field_notes_packet_context() output into the
// shape buildFieldNotesPacketMessages accepts: the task title and the selected
// notes with a non-negative day offset and a length-bounded body. Anything
// else in the envelope is ignored.
//
// Minimization happens in api/_lib/compassPrompts.js, where
// buildMessageBriefingMessages already minimizes member-written rows, so there
// is exactly one place that decides what text may cross the provider boundary.
const NOTES_HARD_CAP = 24;
const BODY_MAX = 2000;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function days(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 36_500 ? value : null;
}

export function buildFieldNotesPacketFacts(envelope) {
  const data = object(envelope?.data);
  if (!data || !Array.isArray(data.notes)) throw new Error("field-notes-context-invalid");
  const notes = data.notes.slice(0, NOTES_HARD_CAP).flatMap((row) => {
    const note = object(row);
    const daysAgo = note ? days(note.daysAgo) : null;
    const body = note && typeof note.body === "string" ? note.body.trim() : "";
    return daysAgo === null || !body || body.length > BODY_MAX ? [] : [{ daysAgo, body }];
  });
  const title = typeof data.title === "string" ? data.title.trim().slice(0, 200) : "";
  return title ? { title, notes } : { notes };
}
