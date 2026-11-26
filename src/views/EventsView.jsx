import { eventDisplayDate, eventModelLabels, compareEventSchedule } from "../lib/eventModel.js";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "../components/Primitives.jsx";
import { CheckinQrCode } from "../components/CheckinQrCode.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { dateTimeFormat, localeFor } from "../lib/i18n.js";
import { buildIcsCalendar, downloadEventIcs } from "../lib/ics.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { useSourceReference } from "../features/automation/useSourceReference.js";
import { QuorumLine, useEventQuorum } from "../components/EventQuorum.jsx";
import { BusyButton } from "../components/BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useCalendarFeed } from "../lib/useCalendarFeed.js";

// Wave 2b restyle: Union Base prototype pg.events parity (mevents-* CSS).
// The page renders its own in-page header (the prototype's .ph block); the
// global mobile top bar mounts above every view, so no ScreenHeader here.
// App still passes onProfile/onAssistant (unchanged caller contract); they are
// deliberately not destructured because the top-bar chrome now owns both.
// All RSVP + QR check-in machinery (check-in codes, offline-safe guards) is
// preserved verbatim from the previous version — this is a restyle around it.

// Day-number + month-abbr for the prototype's date block, derived from the
// event's real startsAt — never from seed copy.
function datePartsFor(event, lang) {
  if (!event.startsAt && !event.eventDate) return null;
  const when = eventDisplayDate(event);
  if (Number.isNaN(when.getTime())) return null;
  return {
    day: new Intl.DateTimeFormat(localeFor(lang), { timeZone: event.eventDate ? undefined : "America/New_York", day: "numeric" }).format(when),
    month: new Intl.DateTimeFormat(localeFor(lang), { timeZone: event.eventDate ? undefined : "America/New_York", month: "short" }).format(when),
  };
}

// "June 2026" line under the page title, from the next real event. Spanish
// month names come back lowercase ("junio de 2026"); sentence-case the first
// letter so the header reads as a title in both locales.
function monthHeadline(event, lang) {
  if (!event?.startsAt && !event?.eventDate) return "";
  const when = eventDisplayDate(event);
  if (Number.isNaN(when.getTime())) return "";
  const label = new Intl.DateTimeFormat(localeFor(lang), { timeZone: event.eventDate ? undefined : "America/New_York", month: "long", year: "numeric" }).format(when);
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
}

// Union Ground has no public events: every meeting belongs to its own
// campaign, so a stray public flag never widens the label past it.
function eventScopeLabel(event, t) {
  return t("mevents.scopeChapter", { chapter: event.chapterName || "" });
}

// Union Ground has no points economy, so no check-in names a point award.
const pts = Object.freeze({});

// The server issues check-in codes (request_event_checkin_token) and accepts
// door codes (check_in_to_event) only from 2 hours before to 4 hours after an
// event's start. Outside that window both controls would only earn a refusal,
// so they are not offered; before it opens the card says when it will.
const CHECKIN_OPENS_BEFORE_MS = 2 * 60 * 60 * 1000;
const CHECKIN_CLOSES_AFTER_MS = 4 * 60 * 60 * 1000;
const CHECKIN_OPENS_FORMAT = Object.freeze({ weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// The demo's events always sit days ahead and its check-in handlers accept any
// code, so the demo turns the window off; and a page left open must change
// state when a window opens or closes, so the view re-renders at the next
// boundary of any upcoming event.
const CheckinClockContext = createContext({ enforced: true, now: null });

function nextCheckinBoundary(events, now) {
  let next = Infinity;
  for (const event of events) {
    const start = new Date(event?.startsAt ?? "").getTime();
    if (Number.isNaN(start)) continue;
    for (const edge of [start - CHECKIN_OPENS_BEFORE_MS, start + CHECKIN_CLOSES_AFTER_MS + 1]) {
      if (edge > now && edge < next) next = edge;
    }
  }
  return next;
}

function useCheckinClock(events, enforced) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enforced) return undefined;
    const wait = nextCheckinBoundary(events, Date.now()) - Date.now();
    if (!Number.isFinite(wait)) return undefined;
    // setTimeout holds at most about 24.8 days; a later edge re-arms on the next render.
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(wait, 0), 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [events, enforced, now]);
  return now;
}

function useCheckinWindow(event) {
  const { enforced } = useContext(CheckinClockContext);
  if (event.checkInOffered !== true || (event.eventKind && event.eventKind !== "meeting")) return { state: "not_offered" };
  return enforced ? checkinWindow(event) : { state: "open" };
}

function checkinWindow(event, now = Date.now()) {
  const start = new Date(event?.startsAt ?? "").getTime();
  // Without a start time the client cannot judge; leave the decision to the server.
  if (Number.isNaN(start)) return { state: "open" };
  if (now < start - CHECKIN_OPENS_BEFORE_MS) return { state: "before", opensAt: start - CHECKIN_OPENS_BEFORE_MS };
  if (now > start + CHECKIN_CLOSES_AFTER_MS) return { state: "closed" };
  return { state: "open" };
}

function CheckinWindowNote({ window: checkin }) {
  const { t, lang } = useLang();
  if (checkin.state === "open") return null;
  const text = checkin.state === "not_offered"
    ? t("mevents.noCheckIn")
    : checkin.state === "before"
    ? t("mevents.checkInOpensAt", { time: dateTimeFormat(lang, CHECKIN_OPENS_FORMAT).format(checkin.opensAt) })
    : t("mevents.checkInClosed");
  return <p className="mevents-row__summary">{text}</p>;
}

// A cancelled event is still listed (so the member sees WHAT was cancelled)
// but never offers RSVP/check-in — the server guards refuse those writes, so a
// live control is a promise the product breaks. Mirrors the mobile
// LiveLivedInScreens gate, which keys off the same cancelled_at projection.
function eventIsCancelled(event) {
  return event?.cancelledAt != null;
}

// The prototype's "Subscribe to chapter events" card. There is no server-side
// iCal feed, so this downloads a real .ics of the member's upcoming events —
// same blob mechanics as downloadEventIcs, just the whole list.
function downloadChapterIcs(events, doc = document) {
  const blob = new Blob([buildIcsCalendar(events)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement("a");
  link.href = url;
  link.download = "chapter-events.ics";
  doc.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function EventsView({ data, onRsvp, onCheckIn, onRequestCheckinCode, onCalendarRotate, onCalendarRevoke, loadCalendarFeedStatus, calendarFeedScope, sessionRestricted = false, renderAutomationLink = null, renderConnectedActions = null, checkinWindowEnforced = true, loadEventQuorum = null }) {
  const { t, lang } = useLang();
  const events = (data.events || []).map((event) => event.startsAt || event.eventDate
    ? { ...event, ...eventModelLabels(event, lang) } : event).sort(compareEventSchedule);
  const checkinNow = useCheckinClock(events, checkinWindowEnforced);
  const sourceReference = useSourceReference("event", events);
  const upcoming = events.filter((item) => item.isPast !== true);
  // REQ-UG-MEETING-QUORUM-COUNTS-20261030: the aggregate count only,
  // for the meetings still ahead; past meetings never take the request.
  const quorum = useEventQuorum(loadEventQuorum, upcoming);
  const past = events.filter((item) => item.isPast === true).sort((a, b) => compareEventSchedule(a, b, -1));
  const [historyOpen, setHistoryOpen] = useState(false);
  const referencedPastEvent = Boolean(sourceReference.requestedId && events.some((row) => row.id === sourceReference.requestedId && row.isPast));
  useEffect(() => { if (referencedPastEvent) setHistoryOpen(true); }, [referencedPastEvent]);
  // The hero and its check-in cards promote the soonest actionable event: a
  // cancelled event must never land there with an active RSVP button.
  const next = upcoming.find((item) => (item.eventKind ?? "meeting") === "meeting" && !eventIsCancelled(item)) || null;
  // cancel_member_event keeps an existing `going` RSVP row; the Your RSVPs
  // card would otherwise list that cancelled event with a green check.
  const going = upcoming.filter((item) => item.rsvpStatus === "going" && !eventIsCancelled(item));
  const headline = monthHeadline(next, lang);

  return (
    <CheckinClockContext.Provider value={{ enforced: checkinWindowEnforced, now: checkinNow }}>
    <CheckinCodeProvider onRequestCode={onRequestCheckinCode}>
      <div className="screen mevents">
      <header className="mevents-ph">
        <div>
          <h1 className="mevents-title">{t("mevents.title")}</h1>
          <p className="mevents-sub">{headline ? `${headline} · ${t("mevents.chapterSub")}` : t("mevents.chapterSub")}</p>
        </div>
      </header>
      <div className="mevents-body">
        {sourceReference.missing && <p role="status">{t("mevents.unavailable")}</p>}
        <div className="mevents-maincol">
          <section className="mevents-list-card" aria-label={t("mevents.listAria")}>
            {upcoming.length === 0 && <EmptyState><p>{t("mevents.empty")}</p></EmptyState>}
            {upcoming.map((event) => (
              <EventRow key={event.id} event={event} onRsvp={onRsvp} onCheckIn={onCheckIn} onRequestCheckinCode={onRequestCheckinCode} automationLink={renderAutomationLink?.(event.id)} connectedActions={renderConnectedActions?.(event)} />
            ))}
          </section>
          {past.length > 0 && (
            // The phone shell keeps the archive behind this disclosure: its
            // home orb is fixed over the bottom of the screen, and an
            // always-expanded history parked past-event rows underneath it.
            // The toggle sits OUTSIDE the history region so it remains
            // reachable while the archive and its source actions are hidden.
            // From 768px up the rail shell has no orb, so the CSS hides the
            // toggle and the history renders open.
            <div className={`mevents-historywrap${historyOpen ? " mevents-historywrap--open" : ""}`}>
              <button
                type="button"
                className="mevents-history__toggle"
                aria-expanded={historyOpen}
                aria-controls="mevents-history"
                onClick={() => setHistoryOpen((open) => !open)}
              >
                <span>{t("mevents.historyTitle")}</span>
                <span className="mevents-history__caret" aria-hidden="true">›</span>
              </button>
              <section className="mevents-history" id="mevents-history" aria-label={t("mevents.historyAria")}>
                <div className="mevents-history__head">
                  <h2>{t("mevents.historyTitle")}</h2>
                  <p>{t("mevents.historyBlurb")}</p>
                </div>
                <div className="mevents-list-card">
                  {past.map((event) => <PastEventRow key={event.id} event={event} automationLink={renderAutomationLink?.(event.id)} connectedActions={renderConnectedActions?.(event)} />)}
                </div>
              </section>
            </div>
          )}
        </div>
        <aside className="mevents-aside">
          {next && <NextUpHero event={next} onRsvp={onRsvp} />}
          {next && !next.checkedIn && (
            <CheckInCard event={next} pts={pts} onCheckIn={onCheckIn} onRequestCheckinCode={onRequestCheckinCode} quorum={quorum.byId.get(next.id)} />
          )}
          {next && next.checkedIn && <CheckedInCard event={next} pts={pts} quorum={quorum.byId.get(next.id)} />}
          {events.length > 0 && <SubscribeCard key={calendarFeedScope} events={events} loadCalendarFeedStatus={sessionRestricted ? null : loadCalendarFeedStatus} onCalendarRotate={onCalendarRotate} onCalendarRevoke={onCalendarRevoke} />}
          {going.length > 0 && <RsvpsCard going={going} />}
        </aside>
      </div>
    </div>
    </CheckinCodeProvider>
    </CheckinClockContext.Provider>
  );
}

function PastEventRow({ event, automationLink = null, connectedActions = null }) {
  const { t, lang } = useLang();
  const parts = datePartsFor(event, lang);
  const meta = [event.dateLabel, event.timeLabel, event.location].filter(Boolean).join(" · ");
  return (
    <article className="mevents-row mevents-row--past" data-automation-source-id={event.id}>
      {automationLink}
      <div className="mevents-row__top">
        <span className="mevents-date" aria-hidden="true">
          {parts ? <><span className="mevents-date__day">{parts.day}</span><span className="mevents-date__mon">{parts.month}</span></> : <span className="mevents-date__day"><CalendarDays size={18} /></span>}
        </span>
        <div className="mevents-row__text">
          <div className="mevents-row__titleline">
            <span className="mevents-row__title">{event.title}</span>
            <span className={`mevents-chip ${event.checkedIn ? "mevents-chip--green" : "mevents-chip--quiet"}`}>
              {event.checkedIn ? t("mevents.attended") : t("mevents.notRecorded")}
            </span>
          </div>
          <div className="mevents-row__meta">{meta}</div>
        </div>
      </div>
      {connectedActions}
    </article>
  );
}

// The RSVP control. Guarded exactly like CheckInForm below, and for the same
// reason: onRsvp is a full round trip (RPC, then a member reload), and until it
// lands the button looked identical to before the tap. On a slow connection
// that reads as "nothing happened", and the impatient second tap fires a
// duplicate rsvp_to_event. The local busy flag disables it until the write
// settles — and catching keeps mutate()'s re-throw, whose toast the member has
// already seen, from escaping as an unhandled rejection.
function RsvpButton({ event, onRsvp, labelKey, variant }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  // Record 8435: an RSVP is locked by its event synchronously.
  const busyWriteRef = useRef(new Set());
  const going = event.rsvpStatus === "going";
  function submit() {
    return runBusyWrite(busyWriteRef, `rsvp:${event.id}`, () => submitNow());
  }
  async function submitNow() {
    if (busy) return;
    setBusy(true);
    try {
      await onRsvp(event.id, going ? "not_going" : "going");
    } catch {
      // Toasted by the parent; the row keeps whatever status it already had.
    } finally {
      setBusy(false);
    }
  }
  if (event.eventKind && event.eventKind !== "meeting") return null;
  if ((event.eventKind || event.endsAt) && event.startsAt && Date.parse(event.startsAt) <= Date.now()) return null;
  // Staff switched RSVP collection off: say so instead of offering a button
  // the server would refuse. A member who already said yes can still withdraw.
  if (event.rsvpOpen === false && !going) return <span className="mevents-chip mevents-chip--quiet">{t("mevents.rsvpClosed")}</span>;
  const className = variant === "hero"
    ? (going ? "mevents-btn mevents-btn--onhero" : "mevents-btn mevents-btn--gold")
    : (going ? "mevents-btn mevents-btn--soft" : "mevents-btn mevents-btn--green");
  return (
    <BusyButton type="button" className={className} aria-pressed={going} pending={busy} onClick={submit}>
      {going ? t("mevents.going") : t(labelKey)}
    </BusyButton>
  );
}

// Prototype right-column "NEXT UP" green panel.
function NextUpHero({ event, onRsvp }) {
  const { t } = useLang();
  const when = [event.dateLabel, event.timeLabel].filter(Boolean).join(" · ");
  return (
    <section className="mevents-hero" aria-label={t("mevents.nextEventAria")}>
      <div className="mevents-hero__top">
        <span className="mevents-hero__when">{when}</span>
        <span className="mevents-chip mevents-chip--nextup">{t("mevents.nextUp")}</span>
      </div>
      <h2 className="mevents-hero__title">{event.title}</h2>
      <p className="mevents-scope mevents-scope--hero">{eventScopeLabel(event, t)}</p>
      {/* Two paragraphs, not one with a <br>: text extraction and assistive
          reading ran "Main Library community roomMonthly membership meeting"
          together (October 6 swarm). */}
      {event.location ? <p className="mevents-hero__body">{event.location}</p> : null}
      {event.summary ? <p className="mevents-hero__body">{event.summary}</p> : null}
      <div className="mevents-hero__actions">
        <RsvpButton event={event} onRsvp={onRsvp} labelKey="mevents.rsvp" variant="hero" />
        <button type="button" className="mevents-btn mevents-btn--onhero" onClick={() => downloadEventIcs(event)}>
          {t("mevents.addToCalendar")}
        </button>
      </div>
    </section>
  );
}

// One list row in the prototype's events card: date block, title + chip, meta,
// RSVP pill, and a real disclosure button standing in for the prototype's
// click-anywhere row (there is no event-detail page). The expanded panel holds
// the preserved check-in / my-code / calendar machinery.
function EventRow({ event, onRsvp, onCheckIn, onRequestCheckinCode, automationLink = null, connectedActions = null }) {
  const { t, lang } = useLang();
  const [open, setOpen] = useDeviceParityState(`events.${event.id}.details`, false);
  const requestedEvent = new URLSearchParams(window.location.search).get("event");
  useEffect(() => { if (requestedEvent === event.id) setOpen(true); }, [event.id, requestedEvent, setOpen]);
  const [showCheckIn, setShowCheckIn] = useDeviceParityState(`events.${event.id}.rowCheckIn`, false);
  const [showCode, setShowCode] = useDeviceParityState(`events.${event.id}.rowCode`, false);
  const checkin = useCheckinWindow(event);
  const canCheckIn = !event.checkedIn && !eventIsCancelled(event) && checkin.state === "open";
  const parts = datePartsFor(event, lang);
  const meta = [event.dateLabel, event.timeLabel, event.location].filter(Boolean).join(" · ");
  return (
    <article className="mevents-row" data-automation-source-id={event.id}>
      {automationLink}
      <div className="mevents-row__top">
        <span className="mevents-date" aria-hidden="true">
          {parts ? (
            <>
              <span className="mevents-date__day">{parts.day}</span>
              <span className="mevents-date__mon">{parts.month}</span>
            </>
          ) : (
            <span className="mevents-date__day"><CalendarDays size={18} /></span>
          )}
        </span>
        <div className="mevents-row__text">
          <div className="mevents-row__titleline">
            <span className="mevents-row__title">{event.title}</span>
            {eventIsCancelled(event) ? (
              <span className="mevents-chip mevents-chip--quiet">{t("mevents.cancelled")}</span>
            ) : event.checkedIn ? (
              <span className="mevents-chip mevents-chip--green">✓ {t("mevents.checkedIn")}</span>
            ) : null}
          </div>
          <div className="mevents-row__meta">{meta}</div>
          {eventIsCancelled(event) && event.cancelledReason && (
            <p className="mevents-row__summary">{t("mevents.cancelledReason", { reason: event.cancelledReason })}</p>
          )}
          <div className="mevents-scope">{eventScopeLabel(event, t)}</div>
        </div>
        {!eventIsCancelled(event) && (
          <RsvpButton event={event} onRsvp={onRsvp} labelKey="mevents.rsvp" />
        )}
        <button
          type="button"
          className="mevents-row__more"
          aria-expanded={open}
          aria-label={t("mevents.toggleDetails", { title: event.title })}
          onClick={() => setOpen((value) => !value)}
        >
          ›
        </button>
      </div>
      {connectedActions}
      {open && (
        <div className="mevents-row__detail">
          {event.summary && <p className="mevents-row__summary">{event.summary}</p>}
          {!event.checkedIn && !eventIsCancelled(event) && <CheckinWindowNote window={checkin} />}
          <div className="mevents-row__actions">
            {canCheckIn && (
              <button type="button" className="mevents-btn mevents-btn--soft" aria-expanded={showCheckIn} onClick={() => setShowCheckIn((value) => !value)}>
                {t("mevents.checkIn")}
              </button>
            )}
            {canCheckIn && onRequestCheckinCode && (
              <button type="button" className="mevents-btn mevents-btn--soft" aria-expanded={showCode} onClick={() => setShowCode((value) => !value)}>
                {t("mevents.myCode")}
              </button>
            )}
            <button type="button" className="mevents-btn mevents-btn--soft" onClick={() => downloadEventIcs(event)}>
              {t("mevents.addToCalendar")}
            </button>
          </div>
          {showCheckIn && canCheckIn && (
            <CheckInForm event={event} onCheckIn={onCheckIn} onDone={() => setShowCheckIn(false)} />
          )}
          {showCode && canCheckIn && (
            <CheckinCodeTile event={event} />
          )}
        </div>
      )}
    </article>
  );
}

// Prototype "At the meeting? Check in" card, wired to the next event. The
// prototype prints the door code itself (seed data); here the member either
// types the posted code (CheckInForm) or mints their own signed code to show
// a steward (CheckinCodeTile).
function CheckInCard({ event, onCheckIn, onRequestCheckinCode, quorum = null }) {
  const { t } = useLang();
  const [showForm, setShowForm] = useDeviceParityState(`events.${event.id}.asideCheckIn`, false);
  const [showCode, setShowCode] = useDeviceParityState(`events.${event.id}.asideCode`, false);
  const checkin = useCheckinWindow(event);
  if (checkin.state !== "open") {
    return (
      <div className="mevents-card mevents-calendar-card">
        <div className="mevents-card__row">
          <span className="mevents-icontile mevents-icontile--green" aria-hidden="true">▣</span>
          <div className="mevents-cardtext">
            <strong>{t(checkin.state === "not_offered" ? "mevents.noCheckIn" : "mevents.checkInTitle")}</strong>
            {checkin.state !== "not_offered" && <CheckinWindowNote window={checkin} />}
            <QuorumLine className="mevents-quorum" status={quorum} />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mevents-card mevents-calendar-card">
      <div className="mevents-card__row">
        <span className="mevents-icontile mevents-icontile--green" aria-hidden="true">▣</span>
        <div className="mevents-cardtext">
          <strong>{t("mevents.checkInTitle")}</strong>
          <small>{t("mevents.checkInBlurb")}</small>
          <QuorumLine className="mevents-quorum" status={quorum} />
        </div>
        <button type="button" className="mevents-btn mevents-btn--green" aria-expanded={showForm} onClick={() => setShowForm((value) => !value)}>
          {t("mevents.checkIn")}
        </button>
      </div>
      {showForm && <CheckInForm event={event} onCheckIn={onCheckIn} onDone={() => setShowForm(false)} />}
      {onRequestCheckinCode && (
        <button type="button" className="mevents-linkbtn" aria-expanded={showCode} onClick={() => setShowCode((value) => !value)}>
          {t("mevents.myCode")}
        </button>
      )}
      {showCode && onRequestCheckinCode && <CheckinCodeTile event={event} />}
    </div>
  );
}

// Prototype "Checked in" confirmation card (success-topped).
function CheckedInCard({ event, quorum = null }) {
  const { t } = useLang();
  return (
    <div className="mevents-card mevents-card--done">
      <div className="mevents-card__row">
        <span className="mevents-icontile mevents-icontile--soft mevents-icontile--round" aria-hidden="true">✅</span>
        <div className="mevents-cardtext">
          <strong>{t("mevents.checkedIn")}</strong>
          <small>{t("mevents.checkedInDone", { title: event.title })}</small>
        </div>
      </div>
      <QuorumLine className="mevents-quorum" status={quorum} />
    </div>
  );
}

function SubscribeCard({ events, loadCalendarFeedStatus, onCalendarRotate, onCalendarRevoke }) {
  const { t } = useLang();
  const { status, link: feedLink, busy, retrying, retry, mint, turnOff, nextActionRef } = useCalendarFeed(loadCalendarFeedStatus, onCalendarRotate, onCalendarRevoke);
  const [announcement, setAnnouncement] = useState("");
  const warningId = useId();
  const replaceWarningId = useId();
  const feedLinkRef = useRef(null);
  const active = status === "active";
  const canReplace = onCalendarRotate && active && !feedLink;
  const showFeedStatus = loadCalendarFeedStatus && status !== "refused";

  useEffect(() => {
    if (feedLink) feedLinkRef.current?.focus();
  }, [feedLink]);

  return (
    <div className="mevents-card mevents-calendar-card">
      <div className="mevents-card__row">
        <span className="mevents-icontile mevents-icontile--soft" aria-hidden="true"><CalendarDays size={18} /></span>
        <div className="mevents-cardtext">
          <strong>{t("mevents.subscribeTitle")}</strong>
          <small>{t("mevents.subscribeBlurb")}</small>
          {showFeedStatus && <small id={warningId}>{t("settings.calendarShareWarning")}</small>}
          {showFeedStatus && <small className={status === "loading" || status === "error" ? undefined : "visually-hidden"} role="status">
            {status === "loading" && t("settings.calendarStatusLoading")}
            {status === "error" && t("settings.calendarStatusFailed")}
          </small>}
          {canReplace && <small id={replaceWarningId}>{t("settings.calendarReplaceWarning")}</small>}
          {feedLink && (
            <>
              <small>{t("settings.calendarOnceWarning")}</small>
              <input
                ref={feedLinkRef}
                className="mevents-feed-link"
                value={feedLink}
                readOnly
                aria-label={t("mevents.liveLinkLabel")}
                onFocus={(event) => event.target.select()}
              />
            </>
          )}
        </div>
        <div className="mevents-row__actions mevents-calendar-actions">
          <button type="button" className="mevents-btn mevents-btn--soft" onClick={() => downloadChapterIcs(events)}>
            {t("mevents.snapshot")}
          </button>
          {(status === "error" || retrying) && (
            <BusyButton type="button" className="mevents-btn mevents-btn--soft" pending={retrying} onClick={retry}>{t("settings.calendarStatusRetry")}</BusyButton>
          )}
          {(canReplace || (onCalendarRotate && status === "inactive")) && (
            <BusyButton ref={active ? undefined : nextActionRef} type="button" className="mevents-btn mevents-btn--green" pending={busy} aria-describedby={canReplace ? `${warningId} ${replaceWarningId}` : warningId} onClick={() => mint(() => setAnnouncement(t("mevents.liveLinkMinted")))}>{t(active ? "settings.calendarReplaceLink" : "mevents.liveLink")}</BusyButton>
          )}
          {onCalendarRevoke && active && (
            <BusyButton ref={nextActionRef} type="button" className="mevents-btn mevents-btn--soft" pending={busy} onClick={(event) => turnOff(event, () => setAnnouncement(t("mevents.liveLinkRevoked")))}>{t("settings.calendarRevoke")}</BusyButton>
          )}
        </div>
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}

function RsvpsCard({ going }) {
  const { t } = useLang();
  return (
    <div className="mevents-card">
      <strong className="mevents-rsvps__title">{t("mevents.yourRsvps")}</strong>
      <ul className="mevents-rsvps__list">
        {going.map((event) => (
          <li key={event.id} className="mevents-rsvps__row">
            <span className="mevents-rsvps__tick" aria-hidden="true">✓</span>
            <span className="mevents-rsvps__label">{[event.title, event.dateLabel].filter(Boolean).join(" · ")}</span>
            {event.checkedIn && <span className="mevents-chip mevents-chip--green">{t("mevents.checkedIn")}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckInForm({ event, onCheckIn, onDone }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  // Record 8435: a check-in is locked by its event synchronously.
  const busyWriteRef = useRef(new Set());
  function submit(submitEvent) {
    return runBusyWrite(busyWriteRef, `checkin:${event.id}`, () => submitNow(submitEvent), submitEvent);
  }
  async function submitNow(submitEvent) {
    submitEvent.preventDefault();
    const code = String(new FormData(submitEvent.currentTarget).get("code") || "").trim();
    if (!code || busy) return;
    setBusy(true);
    try {
      await onCheckIn(event.id, code);
      onDone();
    } catch {
      // mutate() already toasted the failure; leave the form open with the code
      // still in it rather than letting the rejection escape unhandled.
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="mevents-checkin-form" onSubmit={submit}>
      <input className="mevents-input" name="code" placeholder={t("mevents.codePlaceholder")} aria-label={t("mevents.codeAria")} maxLength="15" required />
      <BusyButton className="mevents-btn mevents-btn--green" pending={busy}>{busy ? t("mevents.checkingIn") : pts.checkin != null ? t("mevents.checkInPoints", { points: pts.checkin }) : t("mevents.checkIn")}</BusyButton>
    </form>
  );
}

// The signed check-in code is a property of the EVENT, not of any one tile.
// The soonest event renders both a list-row tile and the aside-card tile, and
// every server mint DELETES the caller's previous unconsumed token for that
// event — so two tile instances minting independently leave one tile showing
// a code the scanner will reject. This provider owns one live token per event
// (one mint, one countdown) shared by every tile for the event.
const CheckinCodeContext = createContext(null);

function CheckinCodeProvider({ onRequestCode, children }) {
  const [entries, setEntries] = useState({});
  const entriesRef = useRef({});
  // eventId -> in-flight mint promise. A second request for the same event
  // while one is open returns the SAME promise instead of starting a second
  // mint: each mint deletes the previous token, so a duplicate mid-flight
  // would kill the code that is about to land.
  const inFlightRef = useRef(new Map());
  // eventIds whose reveal-time auto-mint already ran. The parent rebuilds
  // onRequestCode on every render (toast timers, RSVPs), so the mint-once
  // guard is this ref set, not a callback identity.
  const attemptedRef = useRef(new Set());
  const timersRef = useRef(new Map());

  const patch = useCallback((eventId, fields) => {
    const current = entriesRef.current[eventId] || { code: null, remaining: 0, busy: false };
    const next = { ...entriesRef.current, [eventId]: { ...current, ...fields } };
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const stopCountdown = useCallback((eventId) => {
    const timer = timersRef.current.get(eventId);
    if (timer != null) {
      window.clearInterval(timer);
      timersRef.current.delete(eventId);
    }
  }, []);

  // One countdown per event lives here (not per tile) so every tile for the
  // event ticks together and a tile unmounting never freezes the clock.
  const startCountdown = useCallback((eventId) => {
    stopCountdown(eventId);
    timersRef.current.set(eventId, window.setInterval(() => {
      const entry = entriesRef.current[eventId];
      if (!entry) {
        stopCountdown(eventId);
        return;
      }
      const remaining = Math.max(0, entry.remaining - 1);
      patch(eventId, { remaining });
      if (remaining <= 0) stopCountdown(eventId);
    }, 1000));
  }, [patch, stopCountdown]);

  const request = useCallback(async (eventId) => {
    if (!onRequestCode) return null;
    const existing = inFlightRef.current.get(eventId);
    if (existing) return existing;
    patch(eventId, { busy: true });
    // The mint call is a pure RPC (no member-data refresh); errors surface as
    // a toast via the App-level handler, which then resolves to null here.
    const promise = (async () => {
      try {
        const next = await onRequestCode(eventId);
        if (next?.token) {
          const untilExpiry = Math.round((new Date(next.expiresAt).getTime() - Date.now()) / 1000);
          const remaining = Number.isFinite(untilExpiry) && untilExpiry > 0 ? untilExpiry : next.ttlSeconds || 90;
          patch(eventId, { code: next, remaining, busy: false });
          startCountdown(eventId);
        } else {
          // A null result leaves the button visible, exactly as before.
          patch(eventId, { busy: false });
        }
        return next;
      } catch (error) {
        patch(eventId, { busy: false });
        throw error;
      } finally {
        inFlightRef.current.delete(eventId);
      }
    })();
    inFlightRef.current.set(eventId, promise);
    return promise;
  }, [onRequestCode, patch, startCountdown]);

  // Reveal-time mint for a tile: at most once per event, and only when no
  // live token exists. A second tile mounting for the same event — while the
  // first mint is still in flight or after it landed — reuses that mint/code
  // instead of starting another, so no mount ever invalidates a code another
  // tile is showing.
  const ensure = useCallback((eventId) => {
    if (attemptedRef.current.has(eventId)) return;
    attemptedRef.current.add(eventId);
    if (entriesRef.current[eventId]?.code || inFlightRef.current.has(eventId)) return;
    request(eventId);
  }, [request]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) window.clearInterval(timer);
    timersRef.current.clear();
  }, []);

  return (
    <CheckinCodeContext.Provider value={{ entries, request, ensure }}>
      {children}
    </CheckinCodeContext.Provider>
  );
}

// The signed path: a short-lived single-use code the member shows a steward.
// Presentational only — the token, its countdown and the mint live in the
// shared store above, so every open tile for one event shows the same live
// code.
function CheckinCodeTile({ event }) {
  const { t } = useLang();
  const { entries, request, ensure } = useContext(CheckinCodeContext);
  const entry = entries[event.id] || null;
  const code = entry?.code || null;
  const busy = entry?.busy || false;
  const remaining = entry?.remaining || 0;
  // Live-region copy changes only on ready and expiry. The visible countdown
  // ticks every second outside this string, so AT is not re-read every tick.
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    ensure(event.id);
  }, [event.id, ensure]);

  const mint = useCallback(() => { request(event.id); }, [event.id, request]);

  const token = code?.token || null;
  useEffect(() => {
    if (!token) return undefined;
    setAnnouncement(t("mevents.codeReadyAnnounce", { token }));
    return undefined;
  }, [token, t]);

  useEffect(() => {
    if (!code || remaining > 0) return undefined;
    setAnnouncement(t("mevents.codeExpiredAnnounce"));
    return undefined;
  }, [code, remaining, t]);

  return (
    <div className="mevents-code-tile">
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
      {!code ? (
        <BusyButton type="button" className="mevents-btn mevents-btn--soft" pending={busy} onClick={mint}>{t("mevents.getNewCode")}</BusyButton>
      ) : remaining > 0 ? (
        <>
          <CheckinQrCode token={code.token} label={t("mevents.checkinQrAlt")} />
          <strong className="mevents-code-tile__code">{code.token}</strong>
          <small>{t("mevents.codeExpiresIn", { seconds: remaining })}</small>
          <small>{t("mevents.myCodeBlurb")}</small>
        </>
      ) : (
        <>
          <small>{t("mevents.codeExpired")}</small>
          <BusyButton type="button" className="mevents-btn mevents-btn--soft" pending={busy} onClick={mint}>{t("mevents.getNewCode")}</BusyButton>
        </>
      )}
    </div>
  );
}
