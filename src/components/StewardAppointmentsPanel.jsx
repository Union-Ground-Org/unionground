import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { appointmentWindowsError } from "../lib/stewardAvailability.js";
import { withLoadDeadline } from "../lib/loadDeadline.js";
import { CalendarDays } from "lucide-react";
import { Dialog } from "./Dialog.jsx";
import { QueuePager } from "./QueuePager.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { WorkspaceCardTitle } from "./WorkspacePages.jsx";
import { dateTimeFormat, localeFor } from "../lib/i18n.js";
import { usePagedQueue } from "../lib/usePagedQueue.js";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { CALENDAR_OAUTH_AUTHORIZE_URLS } from "../features/calendarFreeBusy/config.js";
import { BOOKING_TIME_ZONES } from "../lib/appointmentDetailsApi.js";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";

// Steward side of appointments (REQ-UG-STEWARD-APPOINTMENTS-20260801):
// the desk panel (upcoming + outcomes + no-show count) and the availability
// editor (weekly windows, notice, buffers, daily cap, blackouts, accepting
// flag). Lives inside StewardView's cwk-* anatomy; loads its own payload like
// useDesk so the member snapshot never carries another member's data.

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const FIRST_PAGE_WAIT_MS = 300;
const OAUTH_STATUS_WAIT_MS = 5_000;
const OAUTH_AUTHORIZE_HOSTS = new Set(
  Object.values(CALENDAR_OAUTH_AUTHORIZE_URLS).map((url) => new URL(url).hostname),
);

// The start endpoint builds the authorization URL, but the panel still fails
// closed: it navigates only to https on a calendar provider host it knows.
function isApprovedAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && OAUTH_AUTHORIZE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function loadOAuthStatusOnce(api, statusPromiseRef) {
  if (statusPromiseRef.current) return statusPromiseRef.current;
  if (typeof api.loadOAuthStatus !== "function") return Promise.resolve(null);
  const pending = Promise.resolve().then(() => api.loadOAuthStatus());
  statusPromiseRef.current = pending;
  pending.then(
    () => { if (statusPromiseRef.current === pending) statusPromiseRef.current = null; },
    () => { if (statusPromiseRef.current === pending) statusPromiseRef.current = null; },
  );
  return pending;
}

async function resolveOAuthStatusWithin(pending, reloadExpired) {
  let timeoutId;
  try {
    return await Promise.race([
      // A mount-time request can expire partway through this click's wait.
      // Refresh it once within the same five-second budget, rather than
      // treating its timeout as evidence that a provider is unconfigured.
      pending.catch((error) => error?.name === "TimeoutError" ? reloadExpired() : null).catch(() => null),
      new Promise((resolve) => {
        timeoutId = window.setTimeout(() => resolve(null), OAUTH_STATUS_WAIT_MS);
      }),
    ]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

// Localized weekday names without a hand-kept array: Jan 2023 starts on a
// Sunday, so day (1 + weekday) of that month IS that weekday.
function weekdayName(weekday, lang, width = "long") {
  return new Intl.DateTimeFormat(localeFor(lang), { weekday: width, timeZone: "UTC" })
    .format(new Date(Date.UTC(2023, 0, 1 + weekday)));
}

// Blackout rows carry a Postgres `date` — a calendar day with no instant in
// it. Read back through a local-time formatter, `2036-08-24` lands on UTC
// midnight and renders as the 23rd for every viewer west of Greenwich, so the
// day is both parsed and formatted in UTC and the label names the day the
// steward blocked.
function blackoutDateLabel(value, lang) {
  return dateTimeFormat(lang, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00Z`));
}

function minutesToTimeValue(minutes) {
  if (minutes === null) return "";
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function timeValueToMinutes(value) {
  if (!value) return null;
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

function whenLabel(value, lang) {
  return formatEasternTimestamp(value, lang, { weekday: "short" })?.text || "";
}

function localDateKey(value) {
  return new Date(value).toLocaleDateString("en-CA");
}

function addDays(value, days) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

const OUTCOME_CHIP = { completed: "cwk-chip--live", no_show: "cwk-chip--new", cancelled: "cwk-chip--rest", confirmed: "cwk-chip--rest" };

// The two lists page server-side (sol PR #734 F9) with no search or filter —
// the params objects stay empty, but each queue needs its own stable identity
// so usePagedQueue's paramsEqual adoption never cross-fires.
const UPCOMING_DEFAULTS = {};
const RECENT_DEFAULTS = {};

export function appointmentDeskHasHours(desk) {
  return Array.isArray(desk?.windows) && desk.windows.length > 0;
}

export function appointmentDeskEmptyKey(desk) {
  if (!appointmentDeskHasHours(desk)) return "appt.deskEmpty";
  return desk.schedule?.accepting === false ? "appt.deskEmptyPaused" : "appt.deskEmptyWithHours";
}

export function StewardAppointmentsPanel({ api, onNotice }) {
  const { t, lang } = useLang();
  const [desk, setDesk] = useState(null);
  const [firstPage, setFirstPage] = useState(null);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useDeviceParityState("steward.appointments.editorOpen", false);
  const setupHeading = useId();
  // The editor's opener: "Set availability" while no hours exist, then the
  // Availability bar's button. The first save swaps one for the other, so the
  // dialog returns focus through this ref, which follows whichever is mounted.
  const availabilityButtonRef = useRef(null);
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [rescheduleItem, setRescheduleItem] = useState(null);
  const loadGeneration = useRef(0);
  const retired = useRef(false);
  // Once the timer fires or the desk loads, this mount has used its early read.
  const firstPageAttempt = useRef(null);

  const reload = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => !retired.current && generation === loadGeneration.current;
    try {
      const nextDesk = await withLoadDeadline(() => api.loadAppointments());
      if (!isCurrent()) return;
      const reply = firstPageAttempt.current?.reply;
      firstPageAttempt.current = {};
      const early = reply?.api === api ? reply.page : null;
      setDesk(nextDesk);
      setFirstPage(null);
      setError("");
      const rows = nextDesk?.upcoming ?? [];
      const earlyRows = early?.rows ?? [];
      if (early && (early.total !== (nextDesk?.upcomingTotal ?? rows.length)
        || earlyRows.length !== rows.length || earlyRows.some((row, i) => row.id !== rows[i].id))) {
        // The page read started later. If the snapshots differ, take one fresh
        // grouped snapshot without disturbing the usable desk on failure.
        void Promise.resolve().then(() => withLoadDeadline(() => api.loadAppointments())).then((freshDesk) => {
          if (isCurrent()) setDesk(freshDesk);
        }).catch(() => {
          // swallow-ok: the grouped snapshot is usable if the quiet refresh fails.
        });
      }
      return true;
    } catch {
      if (!isCurrent()) return;
      if (firstPageAttempt.current) firstPageAttempt.current = {};
      setFirstPage(null);
      setError(t("appt.deskLoadFailed"));
      return false;
    }
  }, [api, t]);
  // A committed schedule the refresh could not confirm still belongs on the
  // desk, or a later reopen would resubmit the previous one over it.
  // The same for committed weekly hours, so the desk's empty line and the
  // reopened editor follow what was saved.
  const keepCommittedSchedule = useCallback((schedule, windows = null) => {
    setDesk((current) => current ? {
      ...current,
      schedule: { ...(current.schedule || {}), ...schedule },
      ...(Array.isArray(windows) ? { windows } : {}),
    } : current);
  }, []);

  useEffect(() => {
    retired.current = false;
    let waiting = true;
    // The desk RPC also reads availability, history and counts. On a slow
    // first load, the existing upcoming-page RPC can show bookings sooner.
    // Fast desk replies cancel the extra read.
    const timer = api.loadAppointmentsPage && !firstPageAttempt.current ? setTimeout(async () => {
      const attempt = {};
      firstPageAttempt.current = attempt;
      try {
        const page = await withLoadDeadline(() => api.loadAppointmentsPage({ scope: "upcoming", cursor: null }));
        if (waiting && firstPageAttempt.current === attempt) {
          attempt.reply = { api, page };
          setFirstPage(attempt.reply);
        }
      } catch {
        // The grouped read owns the loading, failure and retry UI.
      }
    }, FIRST_PAGE_WAIT_MS) : null;
    const stopFirstPage = () => {
      waiting = false;
      clearTimeout(timer);
    };
    void reload().then(stopFirstPage);
    return () => {
      stopFirstPage();
      retired.current = true;
      loadGeneration.current += 1;
    };
  }, [api, reload]);

  // One lock per row action, matching the per-key busy set (record 8435).
  function run(work, success, busyKey) {
    return runBusyWrite(busyWriteRef, busyKey, () => runNow(work, success, busyKey));
  }

  async function runNow(work, success, busyKey) {
    if (busyKeys.has(busyKey)) return;
    setBusyKeys((prev) => new Set(prev).add(busyKey));
    try {
      await work();
      await reload();
      onNotice(success);
    } catch {
      onNotice(t("steward.actionFailed"));
    } finally {
      setBusyKeys((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }

  // Paged lists (sol PR #734 F9): the desk payload carries page one of each
  // plus its keyset cursor and TRUE windowed total; the hooks own everything
  // after that. Post-action reload() re-enters seed adoption, so an outcome
  // landing always re-serves fresh server rows. Old api doubles without the
  // pager method degrade to the seeded page (null fetcher never fetches).
  const upcomingSeed = useMemo(() => (desk ? { rows: desk.upcoming || [], cursor: desk.upcomingCursor ?? null, total: desk.upcomingTotal ?? (desk.upcoming || []).length } : null), [desk]);
  const recentSeed = useMemo(() => (desk ? { rows: desk.recent || [], cursor: desk.recentCursor ?? null, total: desk.recentTotal ?? (desk.recent || []).length } : null), [desk]);
  const upcomingFetch = useCallback((opts) => api.loadAppointmentsPage({ scope: "upcoming", cursor: opts.cursor }), [api]);
  const recentFetch = useCallback((opts) => api.loadAppointmentsPage({ scope: "recent", cursor: opts.cursor }), [api]);
  const upcomingQ = usePagedQueue(upcomingSeed, api.loadAppointmentsPage ? upcomingFetch : null, UPCOMING_DEFAULTS);
  const recentQ = usePagedQueue(recentSeed, api.loadAppointmentsPage ? recentFetch : null, RECENT_DEFAULTS);
  const earlyPage = !desk && !error && firstPage?.api === api ? firstPage.page : null;
  const upcoming = desk ? upcomingQ.rows : earlyPage?.rows ?? [];
  const upcomingTotal = desk ? upcomingQ.total ?? upcoming.length : earlyPage?.total;
  const recent = recentQ.rows;
  // The now() partition decides which action set a row offers (cancel before
  // the end, outcome marking after). A minute tick keeps it honest while the
  // panel stays open — without it a meeting that ended on screen kept
  // offering Cancel, which the server refuses (sol PR #736).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const deskHistory = (desk?.stats?.completed30d ?? 0) + (desk?.stats?.noShows30d ?? 0) > 0;

  return (
    <section id="steward-appointments" className="cwk-panel role-section-target" tabIndex="-1" aria-label={t("appt.deskTitle")}>
      <div className="cwk-panel__head">
        <div className="cwk-panel__heading">
          <WorkspaceCardTitle as="span" className="cwk-panel__title">{t("appt.deskTitle")}</WorkspaceCardTitle>
          {/* The TRUE windowed total, not the loaded slice — the count must
              never under-report the desk (sol PR #734 F9). */}
          {upcomingTotal != null && <span className="cwk-count">{upcomingTotal}</span>}
        </div>
        {/* A failed first load leaves desk null, so the loading sentence used
            to sit right above the failure card. The note only speaks while
            there is something true to say (UX-UG-STEWARD-APPOINTMENTS-DESK-LOADING-COPY-UNDER-ERROR-20260920). */}
        {/* #9596 (D3-10): "0 completed · 0 no-shows" over a desk with no
            history read as a record; the line waits until there is one. */}
        {(desk ? deskHistory : !error) && (
          <p className="cwk-panel__note" role={desk ? undefined : "status"}>
            {desk
              ? t("appt.deskSub", { noShows: desk.stats?.noShows30d ?? 0, completed: desk.stats?.completed30d ?? 0 })
              : t("appt.deskLoading")}
          </p>
        )}
      </div>
      {error && (
        <div className="cwk-alert" role="alert">
          <p>{error}</p>
          <button className="cwk-btn cwk-btn--green" type="button" onClick={reload}>{t("steward.tryAgain")}</button>
        </div>
      )}
      {(desk || earlyPage) && (
        <>
          {/* REQ-UG-APPOINTMENTS-EMPTY-STATE-20261102: with no weekly
              hours, setting them is the first task, so the status, what hours
              do and the action sit together instead of a small button at one
              edge and the status at the other. */}
          {desk && (appointmentDeskHasHours(desk) ? <div className="cwk-actions mappt-deskbar">
            <button ref={availabilityButtonRef} className="cwk-btn cwk-btn--soft" type="button" onClick={() => setEditorOpen(true)}>
              {t("appt.editAvailability")}
            </button>
            <span className={`cwk-chip ${desk.schedule?.accepting ? "cwk-chip--live" : "cwk-chip--rest"}`}>
              {desk.schedule
                ? (desk.schedule.accepting ? t("appt.accepting") : t("appt.notAccepting"))
                : t("appt.noScheduleYet")}
            </span>
          </div> : <div className="mappt-setup" role="group" aria-labelledby={setupHeading} aria-describedby={`${setupHeading}-body`}>
            <p className="mappt-setup__title" id={setupHeading}>{t("appt.noScheduleYet")}</p>
            <p className="mappt-setup__body" id={`${setupHeading}-body`}>{t(upcoming.length === 0 && !upcomingQ.error ? "appt.deskEmpty" : "appt.setupBody")}</p>
            <button ref={availabilityButtonRef} className="cwk-btn cwk-btn--green" type="button" onClick={() => setEditorOpen(true)}>{t("appt.setAvailability")}</button>
          </div>)}
          {/* The empty line follows the saved hours: "set weekly hours" only
              while none are saved (REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030). */}
          {appointmentDeskHasHours(desk) && upcoming.length === 0 && !upcomingQ.error && <p className="cwk-empty">{t(appointmentDeskEmptyKey(desk))}</p>}
          {upcoming.map((item) => {
            const ended = new Date(item.endsAt).getTime() <= now;
            return (
              <div className="cwk-row" key={item.id}>
                <span className="cwk-av" aria-hidden="true"><CalendarDays size={17} /></span>
                <div className="cwk-row__main">
                  <div className="cwk-row__top">
                    <span className="cwk-name">{item.memberName}</span>
                    <span className="cwk-chip cwk-chip--rest">{t(`appt.type.${item.type}`)}</span>
                  </div>
                  <div className="cwk-meta">
                    <span className="cwk-time">{whenLabel(item.startsAt, lang)}{item.endsAt && <> – {whenLabel(item.endsAt, lang)}</>}</span>
                    <span className="cwk-note">{t("appt.minutes", { minutes: item.durationMinutes })} · {t(`appt.reason.${item.reasonCategory}`)}</span>
                    <span className="cwk-note">{item.place || t("appt.placeMissing")}</span>
                  </div>
                  {desk && api.loadNotes && <BookingNote api={api} appointmentId={item.id} memberName={item.memberName} />}
                  {desk && <div className="cwk-actions">
                    {ended ? (
                      <>
                        <BusyButton className="cwk-btn cwk-btn--soft" type="button" pending={busyKeys.has(`done-${item.id}`)}
                          onClick={() => run(() => api.markOutcome(item.id, "completed"), t("appt.markedCompleted"), `done-${item.id}`)}>
                          {t("appt.markCompleted")}
                        </BusyButton>
                        <BusyButton className="cwk-btn cwk-btn--ghost" type="button" pending={busyKeys.has(`miss-${item.id}`)}
                          onClick={() => run(() => api.markOutcome(item.id, "no_show"), t("appt.markedNoShow"), `miss-${item.id}`)}>
                          {t("appt.markNoShow")}
                        </BusyButton>
                      </>
                    ) : (
                      <>
                        <button className="cwk-btn cwk-btn--soft" type="button" onClick={() => setRescheduleItem(item)}>
                          {t("appt.proposeTime")}
                        </button>
                        <BusyButton className="cwk-btn cwk-btn--ghost" type="button" pending={busyKeys.has(`cancel-${item.id}`)}
                          onClick={() => run(() => api.cancelAppointment(item.id), t("appt.stewardCancelled"), `cancel-${item.id}`)}>
                          {t("appt.cancel")}
                        </BusyButton>
                      </>
                    )}
                  </div>}
                </div>
              </div>
            );
          })}
          {desk && <QueuePager query={upcomingQ} />}
          {desk && (recent.length > 0 || recentQ.error) && (
            <>
              <p className="cwk-panel__note mappt-recent-head">{t("appt.recentTitle")}</p>
              {recent.map((item) => (
                <div className="cwk-row" key={item.id}>
                  <div className="cwk-row__main">
                    <div className="cwk-row__top">
                      <span className="cwk-name">{item.memberName}</span>
                      <span className={`cwk-chip ${OUTCOME_CHIP[item.status] || "cwk-chip--rest"}`}>{t(`appt.status.${item.status}`)}</span>
                    </div>
                    <div className="cwk-meta">
                      <span className="cwk-time">{whenLabel(item.startsAt, lang)}{item.endsAt && <> – {whenLabel(item.endsAt, lang)}</>}</span>
                      <span className="cwk-note">{t(`appt.type.${item.type}`)}</span>
                      <span className="cwk-note">{item.place || t("appt.placeMissing")}</span>
                    </div>
                    {api.loadNotes && <BookingNote api={api} appointmentId={item.id} memberName={item.memberName} />}
                  </div>
                </div>
              ))}
              <QueuePager query={recentQ} />
            </>
          )}
        </>
      )}
      {editorOpen && desk && (
        <AvailabilityEditor
          desk={desk}
          api={api}
          onNotice={onNotice}
          onSaved={reload}
          onScheduleCommitted={keepCommittedSchedule}
          onClose={() => setEditorOpen(false)}
          returnFocusRef={availabilityButtonRef}
        />
      )}
      {rescheduleItem && (
        <StewardRescheduleDialog item={rescheduleItem} api={api} lang={lang}
          onClose={() => setRescheduleItem(null)}
          onSaved={async () => { await reload(); setRescheduleItem(null); onNotice(t("appt.proposedTime")); }} />
      )}
    </section>
  );
}

function StewardRescheduleDialog({ item, api, lang, onClose, onSaved }) {
  const { t } = useLang();
  const [slots, setSlots] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());

  useEffect(() => {
    let live = true;
    api.slots({ type: item.type, duration: item.durationMinutes,
      from: localDateKey(new Date()), to: localDateKey(addDays(new Date(), 13)) })
      .then((result) => { if (live) setSlots(result?.slots || []); })
      .catch(() => { if (live) { setSlots([]); setError(t("appt.slotsFailed")); } });
    return () => { live = false; };
  }, [api, item, t]);

  function confirm() {
    return runBusyWrite(busyWriteRef, "reschedule", () => confirmNow());
  }

  async function confirmNow() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.rescheduleAppointment(item.id, selected);
      await onSaved();
    } catch {
      setError(t("appt.rescheduleFailed"));
      setBusy(false);
    }
  }

  return (
    <Dialog eyebrow={t("appt.proposeEyebrow")} title={t("appt.proposeTitle", { name: item.memberName })} onClose={onClose} wide>
      <p className="mappt-summaryline">{t(`appt.type.${item.type}`)} · {t("appt.minutes", { minutes: item.durationMinutes })}</p>
      {slots === null && <p className="mappt-loading">{t("appt.slotsLoading")}</p>}
      {error && <p className="mappt-alert" role="alert">{error}</p>}
      {slots?.length === 0 && !error && <p className="mappt-alert">{t("appt.slotsEmpty")}</p>}
      <div className="mappt-times" aria-label={t("appt.pickTime")}>
        {(slots || []).map((slot) => (
          <button key={slot.startsAt} type="button" aria-pressed={selected === slot.startsAt}
            className={`mappt-time${selected === slot.startsAt ? " mappt-time--on" : ""}`}
            onClick={() => setSelected(slot.startsAt)}>{whenLabel(slot.startsAt, lang)}</button>
        ))}
      </div>
      <div className="mappt-wizardnav">
        <button type="button" className="dialog-secondary" onClick={onClose}>{t("appt.keep")}</button>
        <BusyButton type="button" className="dialog-primary" pending={busy} disabled={!selected} onClick={confirm}>
          {busy ? t("appt.rescheduling") : t("appt.rescheduleConfirm")}
        </BusyButton>
      </div>
    </Dialog>
  );
}

function AvailabilityEditor({ desk, api, onNotice, onSaved, onScheduleCommitted = null, onClose, returnFocusRef = null }) {
  const { t, lang } = useLang();
  const providerAvailabilityId = useId();
  const weekdayGroupId = useId();
  const schedule = desk.schedule || {
    timezone: "America/New_York", minNoticeMinutes: 240, bufferBeforeMinutes: 10,
    bufferAfterMinutes: 10, maxPerDay: 6, accepting: true,
  };
  const [windows, setWindows] = useDeviceParityState("steward.appointments.windows", () => (desk.windows || []).map((w) => ({ ...w })));
  const [blackoutStart, setBlackoutStart] = useDeviceParityState("steward.appointments.blackoutStart", "");
  const [blackoutEnd, setBlackoutEnd] = useDeviceParityState("steward.appointments.blackoutEnd", "");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  // UX-UG-AVAILABILITY-EDITOR-OUTCOMES-UNDER-MODAL-BACKDROP-20260920: every
  // outcome that leaves this sheet open belongs inside the Dialog. The app
  // toast is a sibling of the modal tree, so useModalIsolation marks it inert
  // and aria-hidden and the backdrop dims it: sighted stewards saw an
  // unchanged sheet and screen-reader users heard nothing. { tone, text } —
  // "error" renders role="alert", "status" renders role="status".
  const [outcome, setOutcome] = useState(null);
  const outcomeRef = useRef(null);
  useEffect(() => {
    // Save sits at the bottom of a long sheet. Bring a refused/partial save
    // into view and keep keyboard focus inside the dialog.
    if (outcome?.tone === "error") outcomeRef.current?.focus();
  }, [outcome]);
  // REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: the
  // booking hours' title, location, audience note and first date.
  // null while loading, { failed: true } when the read failed (no detail
  // write is sent then, so a save cannot clear what could not be read), or
  // the saved row ({} when none was ever set).
  const [details, setDetails] = useState(null);
  const [detailsAttempt, setDetailsAttempt] = useState(0);
  useEffect(() => {
    if (!api.loadScheduleDetails) { setDetails({}); return undefined; }
    let live = true;
    setDetails(null);
    api.loadScheduleDetails().then((row) => { if (live) setDetails(row || {}); }).catch(() => { if (live) setDetails({ failed: true }); });
    return () => { live = false; };
  }, [api, detailsAttempt]);
  const detailsReady = Boolean(details && !details.failed);
  const [oauthStatus, setOauthStatus] = useState(null);
  const [importStatus, setImportStatus] = useState([]);
  const oauthStatusPromiseRef = useRef(null);
  const oauthStatusReadRef = useRef(null);

  useEffect(() => {
    let live = true;
    let latestStatus = null;
    let readGeneration = 0;
    // Observe every read, including a click's replacement after the mount
    // timeout. It may finish after the bounded click wait; its configured
    // status must still make the committed pending connection reconnectable.
    const read = () => {
      // A Request may finish after the mount read published configuration.
      // Reuse that result even when the click captured an earlier render.
      if (latestStatus) return Promise.resolve(latestStatus);
      const generation = ++readGeneration;
      const pending = loadOAuthStatusOnce(api, oauthStatusPromiseRef);
      pending.then((result) => {
        if (live && generation === readGeneration) {
          latestStatus = result;
          setOauthStatus(result);
        }
      }, () => {
        if (live && generation === readGeneration) setOauthStatus(null);
      });
      return pending;
    };
    oauthStatusReadRef.current = read;
    read();
    return () => {
      live = false;
      oauthStatusReadRef.current = null;
      oauthStatusPromiseRef.current = null;
    };
  }, [api]);

  useEffect(() => {
    if (typeof api.loadImportStatus !== "function") return undefined;
    let live = true;
    api.loadImportStatus().then((result) => {
      if (live) setImportStatus(Array.isArray(result) ? result : []);
    }).catch(() => {
      if (live) setImportStatus([]);
    });
    return () => { live = false; };
  }, [api]);

  function saveSettings(event) {
    return runBusyWrite(busyWriteRef, "availability", () => saveSettingsNow(event), event);
  }

  async function saveSettingsNow(event) {
    event.preventDefault();
    if (busy) return;
    const windowsError = appointmentWindowsError(windows);
    if (windowsError) {
      setOutcome({ tone: "error", text: t(windowsError) });
      return;
    }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setOutcome(null);
    let settingsSaved = false;
    const submitted = {
      timezone: String(form.get("timezone") || "").trim() || null,
      minNoticeMinutes: parseInt(form.get("minNotice"), 10),
      bufferBeforeMinutes: parseInt(form.get("bufferBefore"), 10),
      bufferAfterMinutes: parseInt(form.get("bufferAfter"), 10),
      maxPerDay: parseInt(form.get("maxPerDay"), 10),
      accepting: form.get("accepting") === "on",
    };
    try {
      await api.setSchedule(submitted);
      // The schedule is committed from here on: any later failure keeps it.
      settingsSaved = true;
      if (api.setScheduleDetails && detailsReady) {
        await api.setScheduleDetails({
          title: form.get("bookingTitle"), location: form.get("bookingLocation"),
          audience: form.get("bookingAudience"), startsOn: form.get("bookingStartsOn") || null,
        });
      }
      const savedWindows = windows.map((w) => ({
        weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute,
      }));
      await api.setWindows(savedWindows);
      if ((await onSaved()) !== true) onScheduleCommitted?.(submitted, savedWindows);
      // The only outcome that closes the sheet, so the only one the app toast
      // can still announce.
      onNotice(t("appt.availabilitySaved"));
      onClose();
    } catch (error) {
      // The schedule write committed even though the hours did not: bring the
      // desk up to it before saying so, or a later reopen would resend the old
      // schedule over this commit. reload() reports its own failure; when it
      // could not confirm the desk, keep the committed schedule locally.
      if (settingsSaved && (await onSaved()) !== true) onScheduleCommitted?.(submitted);
      setOutcome({ tone: "error", text: t(settingsSaved ? "appt.availabilityPartiallySaved"
        : error?.code === "42501" ? "appt.availabilityDenied" : "appt.availabilitySaveFailed") });
    } finally {
      setBusy(false);
    }
  }

  function addBlackout() {
    return runBusyWrite(busyWriteRef, "availability", () => addBlackoutNow());
  }

  async function addBlackoutNow() {
    if (busy || !blackoutStart || !blackoutEnd) return;
    setBusy(true);
    setOutcome(null);
    try {
      await api.addBlackout(blackoutStart, blackoutEnd);
      await onSaved();
      setOutcome({ tone: "status", text: t("appt.blackoutAdded") });
      setBlackoutStart("");
      setBlackoutEnd("");
    } catch {
      setOutcome({ tone: "error", text: t("appt.availabilitySaveFailed") });
    } finally {
      setBusy(false);
    }
  }

  function removeBlackout(id) {
    return runBusyWrite(busyWriteRef, "availability", () => removeBlackoutNow(id));
  }

  async function removeBlackoutNow(id) {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      await api.removeBlackout(id);
      await onSaved();
      setOutcome({ tone: "status", text: t("appt.blackoutRemoved") });
    } catch {
      setOutcome({ tone: "error", text: t("appt.availabilitySaveFailed") });
    } finally {
      setBusy(false);
    }
  }

  function toggleConnection(provider, connected) {
    return runBusyWrite(busyWriteRef, "availability", () => toggleConnectionNow(provider, connected));
  }

  async function toggleConnectionNow(provider, connected) {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      let startFailed = false;
      if (connected) await api.removeConnection(provider);
      else {
        await api.requestConnection(provider);
        const readStatus = oauthStatusReadRef.current || (() => Promise.resolve(null));
        const status = await resolveOAuthStatusWithin(
          readStatus(),
          readStatus,
        );
        const providerOAuthConfigured = status?.providers?.[provider]?.configured === true;
        if (providerOAuthConfigured && typeof api.startOAuth === "function") {
          let started;
          try { started = await api.startOAuth(provider); }
          catch { started = { ok: false, error: "catalog_unavailable" }; }
          if (!started?.authorizationUrl) {
            // A configured provider whose start resolves activation_unset (for
            // example no redirect URI on this host) still recorded the supported
            // pending request; only other no-URL results are start failures.
            startFailed = started?.error !== "activation_unset";
          } else if (!isApprovedAuthorizationUrl(started.authorizationUrl)) {
            startFailed = true;
          } else {
            const assign = api.assignOAuthUrl || ((url) => window.location.assign(url));
            assign(started.authorizationUrl);
          }
        }
      }
      await onSaved();
      setOutcome(connected
        ? { tone: "status", text: t("appt.connectionRemoved") }
        : startFailed
          ? { tone: "error", text: t("appt.oauthStartFailed") }
          : { tone: "status", text: t("appt.connectionRequested") });
    } catch {
      setOutcome({ tone: "error", text: t("appt.availabilitySaveFailed") });
    } finally {
      setBusy(false);
    }
  }

  function reconnectConnection(provider) {
    return runBusyWrite(busyWriteRef, "availability", () => reconnectConnectionNow(provider));
  }

  async function reconnectConnectionNow(provider) {
    if (busy) return;
    setBusy(true);
    setOutcome(null);
    try {
      if (typeof api.startOAuth !== "function") {
        throw new Error("reconnect unavailable");
      }
      const started = await api.startOAuth(provider);
      if (!isApprovedAuthorizationUrl(started?.authorizationUrl)) {
        throw new Error("reconnect unavailable");
      }
      const assign = api.assignOAuthUrl || ((url) => window.location.assign(url));
      assign(started.authorizationUrl);
    } catch (error) {
      setOutcome({ tone: "error", text: t(error?.name === "TimeoutError" ? "appt.oauthStartFailed" : "appt.reconnectUnavailable") });
    } finally {
      setBusy(false);
    }
  }

  const connectionFor = (provider) => (desk.connections || []).find((row) => row.provider === provider) || null;

  return (
    <Dialog eyebrow={t("appt.deskTitle")} title={t("appt.editAvailability")} onClose={onClose} wide returnFocusRef={returnFocusRef}>
      {outcome && (
        <p ref={outcomeRef} tabIndex={-1} className="mappt-alert" role={outcome.tone === "error" ? "alert" : "status"}>{outcome.text}</p>
      )}
      <form className="cwk-form" onSubmit={saveSettings}>
        <label className="cwk-form__label mappt-toggle">
          <input type="checkbox" name="accepting" defaultChecked={schedule.accepting} />
          {t("appt.acceptingLabel")}
        </label>
        <label className="cwk-form__label">{t("appt.timezoneLabel")}
          {/* REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030:
              picked from a list, not typed. A zone saved earlier that is not
              on the list stays selectable so a save never changes it. */}
          <select name="timezone" defaultValue={schedule.timezone || "America/New_York"}>
            {schedule.timezone && !BOOKING_TIME_ZONES.some(([zone]) => zone === schedule.timezone) && <option value={schedule.timezone}>{schedule.timezone}</option>}
            {BOOKING_TIME_ZONES.map(([zone, labelKey]) => <option key={zone} value={zone}>{t(labelKey)}</option>)}
          </select>
        </label>
        {api.setScheduleDetails && <ScheduleDetailsFields details={details} onRetry={() => setDetailsAttempt((value) => value + 1)} />}
        <label className="cwk-form__label">{t("appt.minNoticeLabel")}
          <select name="minNotice" defaultValue={String(schedule.minNoticeMinutes)}>
            <option value="60">{t("appt.notice1h")}</option>
            <option value="240">{t("appt.notice4h")}</option>
            <option value="1440">{t("appt.notice1d")}</option>
            <option value="2880">{t("appt.notice2d")}</option>
          </select>
        </label>
        <div className="mappt-pairfields">
          <label className="cwk-form__label">{t("appt.bufferBeforeLabel")}
            <select name="bufferBefore" defaultValue={String(schedule.bufferBeforeMinutes)}>
              {[0, 5, 10, 15, 30].map((m) => <option key={m} value={String(m)}>{t("appt.minutes", { minutes: m })}</option>)}
            </select>
          </label>
          <label className="cwk-form__label">{t("appt.bufferAfterLabel")}
            <select name="bufferAfter" defaultValue={String(schedule.bufferAfterMinutes)}>
              {[0, 5, 10, 15, 30].map((m) => <option key={m} value={String(m)}>{t("appt.minutes", { minutes: m })}</option>)}
            </select>
          </label>
        </div>
        <label className="cwk-form__label">{t("appt.maxPerDayLabel")}
          <select name="maxPerDay" defaultValue={String(schedule.maxPerDay)}>
            {[2, 4, 6, 8, 12].map((m) => <option key={m} value={String(m)}>{m}</option>)}
          </select>
        </label>

        <h3 className="mappt-steplabel">{t("appt.weeklyTitle")}</h3>
        <p className="cwk-panel__note">{t("appt.weeklySub")}</p>
        {WEEKDAYS.map((weekday) => {
          const dayWindows = windows.filter((w) => w.weekday === weekday);
          // The seven blocks repeat four control names between them, so the day
          // has to be part of the accessible tree rather than a decorative
          // label: a named group places every control inside it.
          return (
            <div
              className="mappt-weekday"
              key={weekday}
              role="group"
              aria-labelledby={`${weekdayGroupId}-${weekday}`}
            >
              <div className="mappt-weekday__head">
                <span id={`${weekdayGroupId}-${weekday}`}>{weekdayName(weekday, lang)}</span>
                <button
                  type="button"
                  className="cwk-btn cwk-btn--ghost"
                  onClick={() => setWindows((prev) => [...prev, { weekday, startMinute: 540, endMinute: 720 }])}
                >
                  {t("appt.addWindow")}
                </button>
              </div>
              {dayWindows.length === 0 && <p className="mappt-weekday__off">{t("appt.dayOff")}</p>}
              {dayWindows.map((w) => {
                const index = windows.indexOf(w);
                return (
                  <div className="mappt-windowrow" key={index}>
                    <input
                      type="time"
                      step="900"
                      value={minutesToTimeValue(w.startMinute)}
                      aria-label={t("appt.windowStart")}
                      onChange={(event) => setWindows((prev) => prev.map((row, i) =>
                        i === index ? { ...row, startMinute: timeValueToMinutes(event.target.value) } : row))}
                    />
                    <span aria-hidden="true">–</span>
                    <input
                      type="time"
                      step="900"
                      value={minutesToTimeValue(w.endMinute)}
                      aria-label={t("appt.windowEnd")}
                      onChange={(event) => setWindows((prev) => prev.map((row, i) =>
                        i === index ? { ...row, endMinute: timeValueToMinutes(event.target.value) } : row))}
                    />
                    <button
                      type="button"
                      className="cwk-btn cwk-btn--ghost"
                      aria-label={t("appt.removeWindow")}
                      onClick={() => setWindows((prev) => prev.filter((_, i) => i !== index))}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}

        <h3 className="mappt-steplabel">{t("appt.blackoutTitle")}</h3>
        <p className="cwk-panel__note">{t("appt.blackoutSub")}</p>
        {(desk.blackouts || []).map((row) => {
          const range = t("appt.blackoutRange", {
            start: blackoutDateLabel(row.startDate, lang),
            end: blackoutDateLabel(row.endDate, lang),
          });
          return (
            <div className="mappt-windowrow" key={row.id}>
              <span className="cwk-time">{range}</span>
              <BusyButton
                type="button"
                className="cwk-btn cwk-btn--ghost"
                pending={busy}
                aria-label={t("appt.removeBlackoutNamed", { range })}
                onClick={() => removeBlackout(row.id)}
              >
                {t("appt.removeBlackout")}
              </BusyButton>
            </div>
          );
        })}
        <div className="mappt-windowrow">
          <input type="date" value={blackoutStart} aria-label={t("appt.blackoutStart")} onChange={(event) => setBlackoutStart(event.target.value)} />
          <span aria-hidden="true">→</span>
          <input type="date" value={blackoutEnd} aria-label={t("appt.blackoutEnd")} onChange={(event) => setBlackoutEnd(event.target.value)} />
          <BusyButton type="button" className="cwk-btn cwk-btn--soft" pending={busy} disabled={!blackoutStart || !blackoutEnd} onClick={addBlackout}>
            {t("appt.addBlackout")}
          </BusyButton>
        </div>

        <h3 className="mappt-steplabel">{t("appt.connectionsTitle")}</h3>
        {/* Honest state: 'pending' records the ask; free-busy sync activates
            only after the org provisions the provider OAuth app. */}
        <p className="cwk-panel__note">{t("appt.connectionsSub")}</p>
        {["google", "microsoft"].map((provider) => {
          const row = connectionFor(provider);
          const imported = importStatus.find((item) => item.provider === provider);
          const scopeUpgradeRequired = imported?.scopeUpgradeRequired === true;
          const providerOAuthConfigured = oauthStatus?.providers?.[provider]?.configured === true;
          return (
            <div className="mappt-windowrow" key={provider}>
              <span className="cwk-name">{t(`appt.provider.${provider}`)}</span>
              <span className={`cwk-chip ${row?.status === "active" ? "cwk-chip--live" : "cwk-chip--rest"}`}>
                {row ? t(`appt.connection.${row.status}`) : t("appt.connection.none")}
              </span>
              <span id={`${providerAvailabilityId}-${provider}`} className="cwk-note">
                {t(providerOAuthConfigured ? "appt.oauthProviderConfigured" : "appt.oauthProviderUnavailable", {
                  provider: t(`appt.provider.${provider}`),
                })}
              </span>
              {row?.status === "active" && (
                <span className="cwk-note">
                  {scopeUpgradeRequired
                    ? t("appt.importReconnectRequired", {
                      provider: t(`appt.provider.${provider}`),
                    })
                    : imported?.importStatus === "error"
                    ? t("appt.importFailed", {
                      date: whenLabel(imported.lastImportErrorAt, lang),
                    })
                    : imported?.importStatus === "capacity_exceeded"
                    ? t("appt.importCapacityExceeded")
                    : imported?.lastImportedAt
                    ? t("appt.importSummary", {
                      count: imported.eventCount || 0,
                      date: whenLabel(imported.lastImportedAt, lang),
                    })
                    : t("appt.importPending")}
                </span>
              )}
              {((row?.status === "active" && scopeUpgradeRequired)
                || (row?.status === "pending" && providerOAuthConfigured)) && (
                <BusyButton
                  type="button"
                  className="cwk-btn cwk-btn--soft"
                  pending={busy} disabled={!providerOAuthConfigured || typeof api.startOAuth !== "function"}
                  onClick={() => reconnectConnection(provider)}
                >
                  {t("appt.reconnect")}
                </BusyButton>
              )}
              <BusyButton
                type="button"
                className="cwk-btn cwk-btn--ghost"
                aria-describedby={!row && !providerOAuthConfigured ? `${providerAvailabilityId}-${provider}` : undefined}
                pending={busy}
                onClick={() => toggleConnection(provider, Boolean(row))}
              >
                {row ? t("appt.disconnect") : t("appt.requestConnection")}
              </BusyButton>
            </div>
          );
        })}

        <BusyButton className="cwk-btn cwk-btn--green cwk-btn--wide" type="submit" pending={busy}>
          {busy ? t("appt.saving") : t("appt.saveAvailability")}
        </BusyButton>
      </form>
    </Dialog>
  );
}

// REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: what the
// booking hours are, where, who they are for, and when they start. Keyed on
// the loaded row so the defaults appear once it arrives.
function ScheduleDetailsFields({ details, onRetry }) {
  const { t } = useLang();
  if (details === null) return <p className="cwk-note" role="status">{t("appt.detailsLoading")}</p>;
  if (details.failed) {
    return <div className="cwk-note" role="alert">
      {t("appt.detailsLoadFailed")} <button type="button" className="cwk-btn cwk-btn--ghost" onClick={onRetry}>{t("appt.detailsRetry")}</button>
    </div>;
  }
  return <fieldset className="cwk-form__label" key={JSON.stringify(details)}>
    <legend>{t("appt.detailsLegend")}</legend>
    <label className="cwk-form__label">{t("appt.detailsTitle")}<input name="bookingTitle" maxLength="120" defaultValue={details.title || ""} placeholder={t("appt.detailsTitlePlaceholder")} /></label>
    <label className="cwk-form__label">{t("appt.detailsLocation")}<input name="bookingLocation" maxLength="200" defaultValue={details.location || ""} /></label>
    <label className="cwk-form__label">{t("appt.detailsAudience")}<input name="bookingAudience" maxLength="200" defaultValue={details.audience || ""} /></label>
    <label className="cwk-form__label">{t("appt.detailsStartsOn")}<input type="date" name="bookingStartsOn" defaultValue={details.startsOn || ""} /></label>
    <p className="cwk-note">{t("appt.detailsHelp")}</p>
  </fieldset>;
}

// A steward's private note on one booking: read when opened, saved or cleared
// (blank) on Save. Members never see it.
function BookingNote({ api, appointmentId, memberName }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(null);
  const [state, setState] = useState("idle");
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  // Only a note that loaded can be edited or saved: a blank save clears the
  // stored note, so saving after a failed read would delete it unseen.
  const [loaded, setLoaded] = useState(false);
  async function load() {
    setState("loading");
    setLoaded(false);
    try {
      const notes = await api.loadNotes([appointmentId]);
      const current = notes.get(appointmentId) || "";
      setNote(current); setSaved(current); setLoaded(true); setState("idle");
    } catch { setState("loadFailed"); }
  }
  async function toggle() {
    if (open) { setOpen(false); return; }
    setOpen(true);
    await load();
  }
  function save() {
    return runBusyWrite(busyWriteRef, "note", () => saveNow());
  }

  async function saveNow() {
    if (!loaded) return;
    setState("saving");
    try { await api.setNote(appointmentId, note); setSaved(note.trim()); setState("saved"); }
    catch { setState("saveFailed"); }
  }
  return <div className="cwk-booking-note">
    <button type="button" className="cwk-btn cwk-btn--ghost" aria-expanded={open} aria-label={t("appt.noteToggleNamed", { name: memberName || "" })} onClick={toggle}>{t(saved ? "appt.noteEdit" : "appt.noteAdd")}</button>
    {open && <>
      <label className="cwk-form__label">{t("appt.noteLabel")}<textarea value={note} maxLength="2000" rows="3" disabled={!loaded || state === "loading"} onChange={(event) => { setNote(event.target.value); if (state === "saved") setState("idle"); }} /></label>
      <p className="cwk-note">{t("appt.notePrivate")}</p>
      <BusyButton type="button" className="cwk-btn cwk-btn--soft" pending={state === "saving"} disabled={!loaded || state === "loading"} onClick={save}>{t("appt.noteSave")}</BusyButton>
      {state === "saved" && <p className="cwk-note" role="status">{t("appt.noteSaved")}</p>}
      {(state === "loadFailed" || state === "saveFailed") && <p className="cwk-note" role="alert">{t(state === "loadFailed" ? "appt.noteLoadFailed" : "appt.noteSaveFailed")}</p>}
      {state === "loadFailed" && <button type="button" className="cwk-btn cwk-btn--ghost" onClick={load}>{t("appt.detailsRetry")}</button>}
    </>}
  </div>;
}
