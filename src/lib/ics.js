// Minimal iCalendar (RFC 5545) writer, shared by the client "Add to calendar"
// download (EventsView) and the authenticated subscribe feed (api/calendar.js).
// Pure and dependency-free on purpose: both bundles (Vite and the Vercel
// function bundler) inline it without pulling in a calendar library.

function icsEscape(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 §3.1: content lines longer than 75 octets are folded with CRLF
// followed by a single space; the space counts toward the continuation
// line's 75. Measured in UTF-8 octets and split on code points so a
// multi-byte character is never cut in half.
const utf8 = new TextEncoder();

function foldIcsLine(line) {
  if (utf8.encode(line).length <= 75) return line;
  const folded = [];
  let current = "";
  let octets = 0;
  for (const ch of line) {
    const width = utf8.encode(ch).length;
    if (octets + width > 75) {
      folded.push(current);
      current = " ";
      octets = 1;
    }
    current += ch;
    octets += width;
  }
  folded.push(current);
  return folded.join("\r\n");
}

function icsDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

// An unset end is omitted. Date-only entries use RFC 5545 DATE values.
export function formatIcsEvent(event, { durationHours = null, now = new Date() } = {}) {
  const dateOnly = event.eventDate ?? event.event_date;
  const start = new Date(event.startsAt ?? event.starts_at);
  const endsAt = event.endsAt ?? event.ends_at;
  const end = endsAt ? new Date(endsAt) : durationHours == null ? null : new Date(start.getTime() + durationHours * 3600000);
  return [
    "BEGIN:VEVENT",
    `UID:${icsEscape(event.id)}@unionground.invalid`,
    `DTSTAMP:${icsDate(now)}`,
    dateOnly ? `DTSTART;VALUE=DATE:${dateOnly.replace(/-/g, '')}` : `DTSTART:${icsDate(start)}`,
    ...(!dateOnly && end ? [`DTEND:${icsDate(end)}`] : []),
    `SUMMARY:${icsEscape(event.title)}`,
    `LOCATION:${icsEscape(event.location)}`,
    `DESCRIPTION:${icsEscape(event.summary)}`,
    "END:VEVENT",
  ].map(foldIcsLine).join("\r\n");
}

export function buildIcsCalendar(events, { calName = "Union Ground", now = new Date() } = {}) {
  // VEVENT blocks come back from formatIcsEvent already folded and CRLF-joined,
  // so only the calendar-level lines get folded here.
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UnionGround//Union Workspace//EN",
    foldIcsLine(`X-WR-CALNAME:${icsEscape(calName)}`),
    "CALSCALE:GREGORIAN",
    // Appointments may carry a real duration; events may leave the end unset.
    ...events.map((event) => formatIcsEvent(event, { now, durationHours: event.durationHours ?? null })),
    "END:VCALENDAR",
  ].join("\r\n");
}

// Browser-side per-event download: build a one-event calendar and hand it to
// the browser as a file. No backend call — works even for an event the member
// has not RSVP'd to.
export function downloadEventIcs(event, doc = document) {
  const blob = new Blob([buildIcsCalendar([event])], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = `${String(event.id || "event").replace(/[^a-zA-Z0-9_-]/g, "")}.ics`;
  doc.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
