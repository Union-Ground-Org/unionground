import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/Dialog.jsx";
import { EmptyState } from "../components/Primitives.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { dateTimeFormat, localeFor } from "../lib/i18n.js";
import { downloadEventIcs } from "../lib/ics.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { useSourceReference } from "../features/automation/useSourceReference.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { BusyButton } from "../components/BusyControls.jsx";
import { NoStewardNote } from "../components/NoStewardNote.jsx";
import { noStewardNamed } from "../lib/stewardConversations.js";
import { runBusyWrite } from "../lib/busyWrite.js";

// Member side of steward appointments (REQ-UG-STEWARD-APPOINTMENTS-20260801).
// The booking flow borrows Cal.com's shape — pick a type and length, pick an
// open time, confirm — but every instant on screen came from the server's slot
// engine. Display clocks use Eastern time in the member's language; this view
// never computes availability.

const TYPES = ["office_hours", "grievance_followup", "onboarding", "contract_questions"];
const DURATIONS = [20, 30, 45];
const REASONS = ["general", "pay", "benefits", "scheduling", "safety", "discipline", "other"];

// YYYY-MM-DD in the DEVICE timezone — the member's "today", which is what the
// server expects p_from/p_to to mean. en-CA is the locale whose short date
// format IS ISO; it is a formatting trick, not a language choice.
function localDateKey(value) {
  return new Date(value).toLocaleDateString("en-CA");
}

function easternDateKey(value) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dayLabel(key, lang) {
  const when = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat(localeFor(lang), { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(when);
}

function timeLabel(value, lang) {
  return `${dateTimeFormat(lang, { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(value))} ET`;
}

const STATUS_CHIP = {
  confirmed: "mappt-chip--live",
  completed: "mappt-chip--rest",
  cancelled: "mappt-chip--rest",
  no_show: "mappt-chip--warn",
};

export function AppointmentsView({ data, api, onBook, onCancel, onReschedule, renderAutomationLink = null, focus = null, stewardPresence = null }) {
  const { t, lang } = useLang();
  const appointments = data.appointments || [];
  const sourceReference = useSourceReference("appointment", appointments);
  const now = Date.now();
  const upcoming = appointments
    .filter((item) => item.status === "confirmed" && new Date(item.endsAt).getTime() > now)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  // #9886: a cancelled booking whose time has not come
  // is not "Past"; it gets its own Cancelled list, soonest first.
  const cancelled = appointments
    .filter((item) => item.status === "cancelled" && new Date(item.endsAt).getTime() > now)
    .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const past = appointments
    .filter((item) => !(item.status === "confirmed" && new Date(item.endsAt).getTime() > now) && !cancelled.includes(item))
    .sort((a, b) => new Date(b.startsAt) - new Date(a.startsAt));
  const [wizardOpen, setWizardOpen] = useDeviceParityState("appointments.wizardOpen", false);
  const [reschedule, setReschedule] = useDeviceParityState("appointments.reschedule", null);
  // #9595 (D2-20): with no steward named for the reader (stewardPresence) the
  // booking dialog can only end at "No stewards are taking appointments right
  // now", so it is not offered, by the button or by Messages' arrival; the
  // page says so itself and who can name a steward.
  const noSteward = noStewardNamed(stewardPresence);
  // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 64):
  // Messages' "Request a steward" arrives with { request: true } and opens
  // the request straight away, once per arrival. An arrival is used up even
  // when no steward is named, so it cannot open the dialog by itself later
  // when the answer changes (#9595).
  const usedArrival = useRef(null);
  useEffect(() => {
    if (focus?.request !== true || usedArrival.current === focus) return;
    usedArrival.current = focus;
    if (!noSteward) setWizardOpen(true);
  }, [focus, noSteward, setWizardOpen]);
  // A dialog open when the answer becomes a no-steward state is closed, not
  // hidden, so it does not come back by itself if a steward is named later.
  useEffect(() => {
    if (noSteward) setWizardOpen(false);
  }, [noSteward, setWizardOpen]);
  return (
    <div className="screen mappt">
      <header className="mappt-ph">
        <div>
          <h1 className="mappt-title">{t("appt.title")}</h1>
          <p className="mappt-sub">{t("appt.sub")}</p>
        </div>
        {noSteward ? null : (
          <button type="button" className="mappt-btn mappt-btn--gold" onClick={() => setWizardOpen(true)}>
            {t("appt.request")}
          </button>
        )}
      </header>
      <div className="mappt-body">
        {noSteward && (
          <section className="mappt-card">
            <NoStewardNote presence={stewardPresence} />
            <p className="mappt-sub">{t("appt.noStewardBody")}</p>
          </section>
        )}
        {sourceReference.missing && <p role="status">{t("appt.unavailable")}</p>}
        <section className="mappt-card" aria-label={t("appt.upcomingTitle")}>
          <h2 className="mappt-eyebrow">{t("appt.upcomingTitle")}</h2>
          {upcoming.length === 0 && (
            <EmptyState>
              <p>{t(noSteward ? "appt.upcomingEmptyNoSteward" : "appt.upcomingEmpty")}</p>
            </EmptyState>
          )}
          {upcoming.map((item) => (
            <AppointmentRow
              key={item.id}
              item={item}
              automationLink={renderAutomationLink?.(item.id)}
              lang={lang}
              t={t}
              onCancel={onCancel}
              onReschedule={() => setReschedule(item)}
            />
          ))}
          <p className="mappt-tznote">{t("settings.zoneNewYork")} (ET)</p>
        </section>
        {[["appt.cancelledTitle", cancelled], ["appt.pastTitle", past]].map(([titleKey, rows]) => rows.length > 0 && (
          <section className="mappt-card" aria-label={t(titleKey)} key={titleKey}>
            <h2 className="mappt-eyebrow">{t(titleKey)}</h2>
            {rows.map((item) => (
              <div className="mappt-row mappt-row--past" key={item.id} data-automation-source-id={item.id}>
                <div className="mappt-row__main">
                  <span className="mappt-name">{t(`appt.type.${item.type}`)}</span>
                  <span className="mappt-meta">{formatEasternTimestamp(item.startsAt, lang, { weekday: "short" })?.text}{item.endsAt && <> – {formatEasternTimestamp(item.endsAt, lang)?.text}</>} · {item.stewardName}</span>
                  <span className="mappt-meta">{item.place || t("appt.placeMissing")}</span>
                  {renderAutomationLink?.(item.id)}
                </div>
                <span className={`mappt-chip ${STATUS_CHIP[item.status] || "mappt-chip--rest"}`}>
                  {t(`appt.status.${item.status}`)}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
      {wizardOpen && !noSteward && (
        <BookingWizard
          api={api}
          onClose={() => setWizardOpen(false)}
          onBook={async (fields) => {
            const result = await onBook(fields);
            if (result) setWizardOpen(false);
            return result;
          }}
        />
      )}
      {reschedule && (
        <RescheduleDialog
          item={reschedule}
          api={api}
          onClose={() => setReschedule(null)}
          onReschedule={async (startsAt) => {
            const result = await onReschedule(reschedule.id, startsAt);
            if (result) setReschedule(null);
            return result;
          }}
        />
      )}
    </div>
  );
}

// One upcoming appointment. Cancel is a two-tap inline confirm — the second
// tap is the real one, so a mis-tap costs nothing and no browser modal blocks
// the page.
function AppointmentRow({ item, lang, t, onCancel, onReschedule, automationLink = null }) {
  const [confirming, setConfirming] = useDeviceParityState(`appointments.${item.id}.confirmCancel`, false);
  const [busy, setBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());

  function cancel() {
    return runBusyWrite(busyWriteRef, `cancel:${item.id}`, () => cancelNow());
  }

  async function cancelNow() {
    if (busy) return;
    setBusy(true);
    try {
      await onCancel(item.id);
    } catch {
      // Toasted by mutate(); the row keeps its state.
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="mappt-row" data-automation-source-id={item.id}>
      <div className="mappt-datebox" aria-hidden="true">
        <span className="mappt-datebox__day">
          {new Intl.DateTimeFormat(localeFor(lang), { timeZone: "America/New_York", day: "numeric" }).format(new Date(item.startsAt))}
        </span>
        <span className="mappt-datebox__month">
          {new Intl.DateTimeFormat(localeFor(lang), { timeZone: "America/New_York", month: "short" }).format(new Date(item.startsAt))}
        </span>
      </div>
      <div className="mappt-row__main">
        <span className="mappt-name">{t(`appt.type.${item.type}`)}</span>
        <span className="mappt-meta">
          {formatEasternTimestamp(item.startsAt, lang, { weekday: "short" })?.text} – {formatEasternTimestamp(item.endsAt, lang)?.text} · {t("appt.withSteward", { name: item.stewardName })}
        </span>
        <span className="mappt-meta">{item.place || t("appt.placeMissing")}</span>
        <div className="mappt-actions">
          {automationLink}
          {!confirming && (
            <>
              <button type="button" className="mappt-btn mappt-btn--soft" onClick={onReschedule}>{t("appt.reschedule")}</button>
              <button type="button" className="mappt-btn mappt-btn--ghost" onClick={() => setConfirming(true)}>{t("appt.cancel")}</button>
              <button
                type="button"
                className="mappt-btn mappt-btn--ghost"
                onClick={() => downloadEventIcs({
                  id: item.id,
                  startsAt: item.startsAt,
                  title: t(`appt.type.${item.type}`),
                  location: item.place || "",
                  summary: t("appt.icsSummary", { name: item.stewardName }),
                  durationHours: item.durationMinutes / 60,
                })}
              >
                {t("appt.addToCalendar")}
              </button>
            </>
          )}
          {confirming && (
            <>
              <BusyButton type="button" className="mappt-btn mappt-btn--warn" pending={busy} onClick={cancel}>
                {busy ? t("appt.cancelling") : t("appt.cancelConfirm")}
              </BusyButton>
              <BusyButton type="button" className="mappt-btn mappt-btn--ghost" pending={busy} onClick={() => setConfirming(false)}>
                {t("appt.keep")}
              </BusyButton>
            </>
          )}
        </div>
      </div>
      <span className={`mappt-chip ${STATUS_CHIP[item.status] || "mappt-chip--rest"}`}>{t(`appt.status.${item.status}`)}</span>
    </div>
  );
}

// Shared slot picker: fetches two weeks of open instants for a type/duration/
// steward choice and renders them as Eastern-day groups. Used by the booking
// wizard (any steward or a named one) and the reschedule dialog (same steward,
// fixed type).
function SlotPicker({ api, type, duration, stewardId, value, onPick }) {
  const { t, lang } = useLang();
  const [slots, setSlots] = useState(null);
  const [error, setError] = useState("");
  const pickerKey = `appointments.slotPicker.${type}.${duration}.${stewardId || "any"}`;
  const [dayKey, setDayKey] = useDeviceParityState(`${pickerKey}.day`, null);

  useEffect(() => {
    let live = true;
    setSlots(null);
    setError("");
    const from = localDateKey(new Date());
    const to = localDateKey(addDays(new Date(), 13));
    api.slots({ type, duration, from, to, stewardId })
      .then((result) => {
        if (!live) return;
        setSlots(result?.slots || []);
      })
      .catch((err) => {
        if (!live) return;
        setError(err.message || t("appt.slotsFailed"));
      });
    return () => { live = false; };
  }, [api, type, duration, stewardId, t]);

  const byDay = useMemo(() => {
    const groups = new Map();
    for (const slot of slots || []) {
      const key = easternDateKey(slot.startsAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(slot);
    }
    return groups;
  }, [slots]);
  const dayKeys = [...byDay.keys()];
  const activeDay = dayKey && byDay.has(dayKey) ? dayKey : dayKeys[0] || null;

  if (error) return <p className="mappt-alert" role="alert">{error}</p>;
  if (slots === null) return <p className="mappt-loading">{t("appt.slotsLoading")}</p>;
  if (dayKeys.length === 0) return <p className="mappt-alert">{t("appt.slotsEmpty")}</p>;

  return (
    <div className="mappt-picker">
      <div className="mappt-days" role="group" aria-label={t("appt.pickDay")}>
        {dayKeys.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={key === activeDay}
            className={`mappt-day${key === activeDay ? " mappt-day--on" : ""}`}
            onClick={() => setDayKey(key)}
          >
            {dayLabel(key, lang)}
          </button>
        ))}
      </div>
      <div className="mappt-times" aria-label={t("appt.pickTime")}>
        {(byDay.get(activeDay) || []).map((slot) => (
          <button
            key={slot.startsAt}
            type="button"
            aria-pressed={value === slot.startsAt}
            className={`mappt-time${value === slot.startsAt ? " mappt-time--on" : ""}`}
            onClick={() => onPick(slot.startsAt)}
          >
            {timeLabel(slot.startsAt, lang)}
          </button>
        ))}
      </div>
      <p className="mappt-tznote">{t("settings.zoneNewYork")} (ET)</p>
    </div>
  );
}

// get_bookable_stewards' own refusals (no permission; no chapter) keep the
// empty sentence; only a failed read says "could not be loaded".
const STEWARD_REFUSAL_CODES = new Set(["42501", "22023"]);

function BookingWizard({ api, onClose, onBook }) {
  const { t, lang } = useLang();
  const [step, setStep] = useDeviceParityState("appointments.booking.step", 0);
  const [type, setType] = useDeviceParityState("appointments.booking.type", null);
  const [duration, setDuration] = useDeviceParityState("appointments.booking.duration", 30);
  const [stewardId, setStewardId] = useDeviceParityState("appointments.booking.stewardId", null);
  const [stewards, setStewards] = useState(null);
  // Record #9465 (W4-3): a failed steward read is not "no stewards".
  const [stewardsFailed, setStewardsFailed] = useState(false);
  const [stewardsAttempt, setStewardsAttempt] = useState(0);
  const [slot, setSlot] = useDeviceParityState("appointments.booking.slot", null);
  const [reason, setReason] = useDeviceParityState("appointments.booking.reason", "general");
  const [place, setPlace] = useDeviceParityState("appointments.booking.place", "");
  const [busy, setBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [stewardDetails, setStewardDetails] = useState(() => new Map());

  useEffect(() => {
    let live = true;
    setStewardsFailed(false);
    api.stewards()
      .then((rows) => {
        if (!live) return;
        setStewards(rows || []);
        // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030:
        // each steward's booking-hours title, place, audience and first date.
        const ids = (rows || []).map((row) => row.id).filter(Boolean).slice(0, 100);
        if (api.stewardDetails && ids.length) {
          api.stewardDetails(ids)
            .then((details) => { if (live) setStewardDetails(new Map((details || []).map((row) => [row.stewardId, row]))); })
            .catch(() => {});
        }
      })
      .catch((error) => {
        if (!live) return;
        setStewards([]);
        setStewardsFailed(!STEWARD_REFUSAL_CODES.has(String(error?.code ?? "")));
      });
    return () => { live = false; };
  }, [api, stewardsAttempt]);

  function confirm() {
    return runBusyWrite(busyWriteRef, "book", () => confirmNow());
  }

  async function confirmNow() {
    if (busy || !slot) return;
    setBusy(true);
    try {
      await onBook({ type, duration, startsAt: slot, place: place.trim(), stewardId, reason });
    } catch {
      // mutate() already toasted; a stale slot sends the member back a step.
      setSlot(null);
      setStep(1);
    } finally {
      setBusy(false);
    }
  }

  const stewardName = stewardId ? (stewards || []).find((row) => row.id === stewardId)?.name : null;
  const chosenDetails = stewardId ? stewardDetails.get(stewardId) : null;

  return (
    <Dialog eyebrow={t("appt.wizardEyebrow")} title={t("appt.wizardTitle")} onClose={onClose} wide>
      {step === 0 && (
        <div className="mappt-step">
          <h3 className="mappt-steplabel">{t("appt.pickType")}</h3>
          <div className="mappt-typegrid">
            {TYPES.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={type === key}
                className={`mappt-typecard${type === key ? " mappt-typecard--on" : ""}`}
                onClick={() => setType(key)}
              >
                <strong>{t(`appt.type.${key}`)}</strong>
                <span>{t(`appt.typeSub.${key}`)}</span>
              </button>
            ))}
          </div>
          <h3 className="mappt-steplabel">{t("appt.pickDuration")}</h3>
          <div className="mappt-durations">
            {DURATIONS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                aria-pressed={duration === minutes}
                className={`mappt-time${duration === minutes ? " mappt-time--on" : ""}`}
                onClick={() => setDuration(minutes)}
              >
                {t("appt.minutes", { minutes })}
              </button>
            ))}
          </div>
          <h3 className="mappt-steplabel">{t("appt.pickWho")}</h3>
          {stewards === null && <p className="mappt-loading">{t("appt.stewardsLoading")}</p>}
          {stewardsFailed && (
            <div className="mappt-alert" role="alert">
              <p>{t("appt.stewardsFailed")}</p>
              <button
                type="button"
                className="dialog-secondary"
                onClick={() => { setStewards(null); setStewardsFailed(false); setStewardsAttempt((n) => n + 1); }}
              >
                {t("appt.stewardsRetry")}
              </button>
            </div>
          )}
          {stewards !== null && !stewardsFailed && stewards.length === 0 && <p className="mappt-alert">{t("appt.stewardsEmpty")}</p>}
          {stewards !== null && stewards.length > 0 && (
            <div className="mappt-who">
              <button
                type="button"
                aria-pressed={stewardId === null}
                className={`mappt-time${stewardId === null ? " mappt-time--on" : ""}`}
                onClick={() => setStewardId(null)}
              >
                {t("appt.anySteward")}
              </button>
              {stewards.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  aria-pressed={stewardId === row.id}
                  className={`mappt-time${stewardId === row.id ? " mappt-time--on" : ""}`}
                  onClick={() => setStewardId(row.id)}
                >
                  {row.name}
                </button>
              ))}
            </div>
          )}
          {chosenDetails && (chosenDetails.title || chosenDetails.location || chosenDetails.audience || chosenDetails.startsOn) && (
            <p className="mappt-meta" data-booking-details>
              {[chosenDetails.title,
                chosenDetails.location && t("appt.detailsAt", { location: chosenDetails.location }),
                chosenDetails.audience && t("appt.detailsFor", { audience: chosenDetails.audience }),
                chosenDetails.startsOn && t("appt.detailsFrom", { date: chosenDetails.startsOn })].filter(Boolean).join(" · ")}
            </p>
          )}
          <div className="mappt-wizardnav">
            <button
              type="button"
              className="dialog-primary"
              disabled={!type || !stewards?.length}
              onClick={() => { setSlot(null); setStep(1); }}
            >
              {t("appt.next")}
            </button>
          </div>
        </div>
      )}
      {step === 1 && (
        <div className="mappt-step">
          <p className="mappt-summaryline">
            {t(`appt.type.${type}`)} · {t("appt.minutes", { minutes: duration })} · {stewardName || t("appt.anySteward")}
          </p>
          <SlotPicker
            api={api}
            type={type}
            duration={duration}
            stewardId={stewardId}
            value={slot}
            onPick={setSlot}
          />
          <div className="mappt-wizardnav">
            <button type="button" className="dialog-secondary" onClick={() => setStep(0)}>{t("appt.back")}</button>
            <button type="button" className="dialog-primary" disabled={!slot} onClick={() => setStep(2)}>{t("appt.next")}</button>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="mappt-step">
          <h3 className="mappt-steplabel">{t("appt.pickReason")}</h3>
          {/* A bounded category, never a text box: what the meeting is about in
              detail belongs in the meeting, not in calendar data. */}
          <label className="mappt-field">{t("appt.reasonLabel")}
            <select value={reason} onChange={(event) => setReason(event.target.value)}>
              {REASONS.map((key) => (
                <option key={key} value={key}>{t(`appt.reason.${key}`)}</option>
              ))}
            </select>
          </label>
          <label className="mappt-field">{t("appt.placeLabel")}
            <input name="place" value={place} maxLength={300} required
              placeholder={t("appt.placePlaceholder")}
              onChange={(event) => setPlace(event.target.value)} />
          </label>
          <p className="mappt-privacy">{t("appt.privacyNote")}</p>
          <div className="mappt-review">
            <strong>{t(`appt.type.${type}`)}</strong>
            <span>{dayLabel(easternDateKey(slot), lang)} · {timeLabel(slot, lang)} · {t("appt.minutes", { minutes: duration })}</span>
            <span>{stewardName ? t("appt.withSteward", { name: stewardName }) : t("appt.anyStewardNote")}</span>
            <span>{place.trim() || t("appt.placeRequired")}</span>
          </div>
          <div className="mappt-wizardnav">
            <button type="button" className="dialog-secondary" onClick={() => setStep(1)}>{t("appt.back")}</button>
            <BusyButton type="button" className="dialog-primary" pending={busy} disabled={!place.trim()} onClick={confirm}>
              {busy ? t("appt.booking") : t("appt.confirm")}
            </BusyButton>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function RescheduleDialog({ item, api, onClose, onReschedule }) {
  const { t, lang } = useLang();
  const [slot, setSlot] = useDeviceParityState(`appointments.reschedule.${item.id}.slot`, null);
  const [busy, setBusy] = useState(false);
  // A synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());

  function confirm() {
    return runBusyWrite(busyWriteRef, `reschedule:${item.id}`, () => confirmNow());
  }

  async function confirmNow() {
    if (busy || !slot) return;
    setBusy(true);
    try {
      await onReschedule(slot);
    } catch {
      setSlot(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog eyebrow={t("appt.rescheduleEyebrow")} title={t(`appt.type.${item.type}`)} onClose={onClose} wide>
      <p className="mappt-summaryline">
        {t("appt.currently", { date: dayLabel(easternDateKey(item.startsAt), lang), time: timeLabel(item.startsAt, lang) })} · {t("appt.withSteward", { name: item.stewardName })}
      </p>
      {/* Same steward by design: the server refuses a steward change on
          reschedule — that is a cancel plus a fresh booking. */}
      <SlotPicker
        api={api}
        type={item.type}
        duration={item.durationMinutes}
        stewardId={item.stewardId}
        value={slot}
        onPick={setSlot}
      />
      <div className="mappt-wizardnav">
        <button type="button" className="dialog-secondary" onClick={onClose}>{t("appt.keep")}</button>
        <BusyButton type="button" className="dialog-primary" pending={busy} disabled={!slot} onClick={confirm}>
          {busy ? t("appt.rescheduling") : t("appt.rescheduleConfirm")}
        </BusyButton>
      </div>
    </Dialog>
  );
}
