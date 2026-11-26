import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BusyButton, BusyInput } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";

// REQ-UG-MEETING-QUORUM-COUNTS-20261030: a meeting's quorum and the
// members checked in toward it, shown to staff and members alike. The read
// (get_member_event_quorum) returns two numbers per meeting and nothing about
// who checked in. While a meeting is under way the count re-reads every
// QUORUM_REFRESH_MS, so it follows check-ins at the door.
export const QUORUM_REFRESH_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;

// A meeting counts as under way from an hour before it starts until four
// hours after (or its end, when later): the check-in window.
function meetingWindow(event) {
  const starts = Date.parse(event?.startsAt ?? "");
  if (!Number.isFinite(starts)) return null;
  return { opens: starts - HOUR_MS, closes: Math.max(Date.parse(event?.endsAt ?? "") || 0, starts + 4 * HOUR_MS) };
}

export function meetingUnderWay(event, now = Date.now()) {
  const span = meetingWindow(event);
  return Boolean(span) && now >= span.opens && now <= span.closes;
}

// The next moment at which any of the meetings opens or closes its window,
// or null when none ever will again.
export function nextQuorumBoundary(events, now = Date.now()) {
  let next = null;
  for (const event of events || []) {
    const span = meetingWindow(event);
    if (!span) continue;
    const at = span.opens > now ? span.opens : span.closes >= now ? span.closes + 1 : null;
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}

// setTimeout fires at once for a delay past 2^31 - 1 ms; a far boundary is
// re-checked at least daily instead.
const MAX_WAKE_MS = 24 * HOUR_MS;

export function useEventQuorum(load, events) {
  const [byId, setById] = useState(() => new Map());
  const [clock, setClock] = useState(0);
  const meetings = (events || []).filter((event) => event?.id && (!event.eventKind || event.eventKind === "meeting"));
  const key = meetings.map((event) => event.id).join("|");
  const now = Date.now();
  const liveKey = meetings.filter((event) => meetingUnderWay(event, now)).map((event) => event.id).join("|");
  const boundary = nextQuorumBoundary(meetings, now);
  // Each read takes a ticket; a meeting keeps the answer of the newest read
  // that asked about it, so a slow full read cannot undo a newer live one.
  const sequence = useRef(0);
  const applied = useRef(new Map());
  const mounted = useRef(true);
  const read = useCallback(async (requested) => {
    if (typeof load !== "function" || !requested.length) return;
    const ticket = ++sequence.current;
    let next;
    let failed = false;
    try {
      next = await load(requested);
    } catch {
      failed = true;
    }
    if (!mounted.current || (!failed && !(next instanceof Map))) return;
    const fresh = requested.filter((id) => (applied.current.get(id) ?? 0) < ticket);
    if (!fresh.length) return;
    for (const id of fresh) applied.current.set(id, ticket);
    setById((current) => {
      const merged = new Map(current);
      for (const id of fresh) {
        if (failed) {
          const previous = current.get(id);
          if (previous && !previous.stale) merged.set(id, { ...previous, stale: true });
        } else if (next.has(id)) merged.set(id, next.get(id));
        else merged.delete(id);
      }
      return merged;
    });
  }, [load]);
  const refresh = useCallback(() => read(key ? key.split("|") : []), [read, key]);
  useEffect(() => { void refresh(); }, [refresh]);
  // While a meeting is under way its count re-reads, so it follows the door.
  useEffect(() => {
    if (!liveKey) return undefined;
    const timer = setInterval(() => { void read(liveKey.split("|")); }, QUORUM_REFRESH_MS);
    return () => clearInterval(timer);
  }, [read, liveKey]);
  // Re-render when a window opens or closes, so a desk left open before a
  // meeting starts its live re-reads on time and stops them afterwards.
  useEffect(() => {
    if (boundary === null) return undefined;
    const timer = setTimeout(() => setClock((tick) => tick + 1), Math.min(Math.max(boundary - Date.now(), 0), MAX_WAKE_MS));
    return () => clearTimeout(timer);
  }, [boundary, clock]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Only the ids that are meetings now: an event edited into a deadline (or
  // dropped from the list) loses its cached count at once, and a late read
  // that still names it cannot bring the count back.
  const current = useMemo(() => {
    const wanted = new Set(key ? key.split("|") : []);
    return new Map([...byId].filter(([id]) => wanted.has(id)));
  }, [byId, key]);
  useEffect(() => {
    const wanted = new Set(key ? key.split("|") : []);
    setById((cached) => ([...cached.keys()].every((id) => wanted.has(id))
      ? cached : new Map([...cached].filter(([id]) => wanted.has(id)))));
  }, [key]);
  return { byId: current, refresh };
}

export function QuorumLine({ status, className = "" }) {
  const { t } = useLang();
  if (!status || !Number.isInteger(status.quorum)) return null;
  const vars = { present: status.checkedIn, quorum: status.quorum };
  return <p className={className} role="status" aria-live="polite">
    {t(status.checkedIn >= status.quorum ? "eventQuorum.reached" : "eventQuorum.count", vars)}
    {status.stale ? <>{". "}{t("eventQuorum.stale")}</> : null}
  </p>;
}

// Staff only: set or clear the quorum of one meeting.
export function QuorumEditor({ event, quorum = null, onSave, pending = false }) {
  const { t } = useLang();
  const inputId = useId();
  const [value, setValue] = useState(Number.isInteger(quorum) ? String(quorum) : "");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  // A newly read quorum replaces the draft in the same render, so the field
  // never shows a stale figure next to the count line (an effect lagged a
  // task behind it).
  const [shownQuorum, setShownQuorum] = useState(quorum);
  if (shownQuorum !== quorum) {
    setShownQuorum(quorum);
    setValue(Number.isInteger(quorum) ? String(quorum) : "");
  }
  const text = value.trim();
  const number = text === "" ? null : Number(text);
  const valid = number === null || (Number.isInteger(number) && number >= 1 && number <= 100_000);
  const changed = number !== (Number.isInteger(quorum) ? quorum : null);

  function save(submitEvent) {
    return runBusyWrite(busyWriteRef, "quorum", () => saveNow(submitEvent), submitEvent);
  }

  async function saveNow(submitEvent) {
    submitEvent.preventDefault();
    if (busy || !valid || !changed) return;
    setBusy(true); setError("");
    try {
      await onSave(event.id, number);
    } catch {
      setError("eventQuorum.failed");
    } finally {
      setBusy(false);
    }
  }

  return <form className="xus-quorum-form" onSubmit={save}>
    <label className="xus-field" htmlFor={inputId}><span>{t("eventQuorum.label")}</span></label>
    <BusyInput id={inputId} className="xus-input" type="number" inputMode="numeric" min="1" max="100000" step="1" value={value}
      aria-invalid={!valid || undefined} aria-describedby={`${inputId}-help`} pending={busy || pending}
      onChange={(change) => setValue(change.target.value)} />
    <small className="xus-note" id={`${inputId}-help`}>{t(valid ? "eventQuorum.help" : "eventQuorum.invalid")}</small>
    {error && <p className="xus-note xus-note--error" role="alert">{t(error)}</p>}
    <BusyButton type="submit" className="xus-btn" pending={busy || pending} disabled={!valid || !changed}
      aria-label={t("eventQuorum.saveNamed", { title: event.title })}>{t("eventQuorum.save")}</BusyButton>
  </form>;
}
