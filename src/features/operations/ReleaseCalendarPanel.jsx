import { CalendarClock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusyButton } from "../../components/BusyControls.jsx";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog.jsx";
import { formatEasternInstant } from "../../lib/easternTime.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { settingLabel } from "../../lib/organizationSettingsAdmin.js";
import { RELEASE_REASON_MAX, createReleaseCalendarApi, oneLineReason, releaseState } from "./releaseCalendar.js";

// Release calendar (#9039): every switch with a release time and its state,
// the database clock and the newest release audit rows, for a stepped-up
// platform operator only. Release and Hold (#9077), each confirmed with a
// reason, change Production and then SAMPLE together through the server
// route; the screen sets no release date of its own (dates stay with the
// release command). The answer names a partial failure and the sync step. The
// list is read again after a change, on Refresh and whenever the page becomes
// visible, so a release time that passed or a command-line change shows
// without reloading.
//
// After a partial, unconfirmed or uncertain change (the answer was lost, and
// Production may have committed) the switch keeps the button the notice tells
// the operator to press again (a "follow-up"), even once the list shows
// Production at the target, until a press of that switch reads back the same
// on both sites. Follow-ups are kept per switch and action, so an unfinished
// second switch or an uncertain opposite action never takes its button away.
// The reason is one line, as the route requires, and a reason that was not
// saved on both sites is kept,
// per switch and action, for the next press. A saved press clears both actions
// of its switch. When the button that opened the dialog is gone after the
// list is read again, focus moves to the notice instead of the page.
const CHANGES_SHOWN = 10;
const NOTICE_ROLES = Object.freeze({ saved: "status", partial: "alert", unconfirmed: "alert", uncertain: "alert", differs: "alert", invalid: "alert", sampleNeverHeld: "alert", refused: "alert", unavailable: "status", error: "alert" });
const FOLLOW_UP = new Set(["partial", "unconfirmed", "uncertain"]);
const actionKey = (key, action) => JSON.stringify([key, action]);
const withEntry = (map, key, value) => new Map(map).set(key, value);
const withoutSwitch = (map, key) => {
  const next = new Map(map);
  next.delete(actionKey(key, "release"));
  next.delete(actionKey(key, "hold"));
  return next;
};

export function ReleaseCalendarPanel({ client, api: injectedApi = null }) {
  const { t, lang } = useLang();
  const api = useMemo(() => injectedApi ?? createReleaseCalendarApi(client), [client, injectedApi]);
  const [calendar, setCalendar] = useState({ state: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  // Per switch and action: whether it still needs to finish on both sites,
  // and its unsaved reason draft.
  const [followUps, setFollowUps] = useState(() => new Map());
  const [drafts, setDrafts] = useState(() => new Map());
  const sequence = useRef(0);
  const mounted = useRef(true);
  const noticeRef = useRef(null);
  const focusAfterChange = useRef(false);

  const load = useCallback(async () => {
    const requestId = ++sequence.current;
    setRefreshing(true);
    try {
      const next = await api.read();
      if (mounted.current && requestId === sequence.current) setCalendar(next);
    } finally {
      if (mounted.current && requestId === sequence.current) setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const onVisible = () => {
      if (globalThis.document?.visibilityState === "visible") void load();
    };
    globalThis.document?.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      globalThis.document?.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const labels = useMemo(() => {
    const byKey = new Map((calendar.switches ?? []).map((row) => [row.key, row]));
    return (key) => settingLabel(t, byKey.get(key) ?? { key });
  }, [calendar.switches, t]);
  const when = (value) => formatEasternInstant(value, lang) ?? value;
  const describe = (releaseAt, held) => {
    if (releaseAt === null || releaseAt === undefined) return t("operations.releaseCalendar.state.none");
    if (releaseAt === "infinity") return t("operations.releaseCalendar.state.held_no_date");
    return t(held ? "operations.releaseCalendar.state.dated" : "operations.releaseCalendar.state.released", { when: when(releaseAt) });
  };
  // An audit row's times, held or released as of that change.
  const describeAt = (releaseAt, at) => {
    if (releaseAt === "infinity" || releaseAt === null || releaseAt === undefined) return describe(releaseAt, true);
    return describe(releaseAt, at ? Date.parse(releaseAt) > Date.parse(at) : false);
  };
  const changes = (calendar.changes ?? []).slice(0, CHANGES_SHOWN);
  const actionWord = (action) => t(`operations.releaseCalendar.action.${action}`);

  // The list was read again after a change: if the button that opened the
  // dialog went with it, focus would fall to the page, so the notice takes it.
  useEffect(() => {
    if (!focusAfterChange.current || refreshing) return;
    focusAfterChange.current = false;
    const active = globalThis.document?.activeElement;
    if (!active || active === globalThis.document.body) noticeRef.current?.focus();
  }, [calendar, refreshing]);

  const open = (key, action) => {
    setPending({ key, action });
    setReason(drafts.get(actionKey(key, action)) ?? "");
  };
  const keepDraft = () => { if (pending && reason.trim()) setDrafts((map) => withEntry(map, actionKey(pending.key, pending.action), reason)); };
  const close = () => { if (!saving) { keepDraft(); setPending(null); } };
  const confirm = async () => {
    const trimmed = reason.trim();
    if (!pending || !trimmed || saving) return;
    const { key, action } = pending;
    setSaving(true);
    try {
      const { outcome } = await api.change({ key, action, reason: trimmed });
      if (!mounted.current) return;
      setNotice({ outcome, key, action });
      // An uncertain opposite action may have written nothing: keep both until
      // a saved press confirms that this switch agrees on both sites.
      if (FOLLOW_UP.has(outcome)) setFollowUps((map) => withEntry(map, actionKey(key, action), true));
      else if (outcome === "saved") setFollowUps((map) => withoutSwitch(map, key));
      setDrafts((map) => (outcome === "saved" ? withoutSwitch(map, key) : withEntry(map, actionKey(key, action), reason)));
      setPending(null);
      focusAfterChange.current = true;
    } finally {
      if (mounted.current) setSaving(false);
    }
    void load();
  };
  const offers = (row, state, action) => (action === "release" ? state !== "released" : state !== "held_no_date")
    || followUps.has(actionKey(row.key, action));
  const retry = <BusyButton type="button" className="xus-btn" pending={refreshing} onClick={() => void load()}>{t("operations.releaseCalendar.retry")}</BusyButton>;

  return (
    <article id="admin-release-calendar" className="plane-card xus-card role-section-target" tabIndex="-1" data-testid="release-calendar">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><CalendarClock size={18} /></span>
        <div className="xus-cardhead__copy">
          <h3 className="xus-cardttl">{t("operations.releaseCalendar.title")}</h3>
          <p className="xus-cardsub">{t("operations.releaseCalendar.sub")}</p>
        </div>
      </header>

      {calendar.state === "loading" && <div className="xus-cardbody"><p className="xus-note">{t("operations.releaseCalendar.loading")}</p></div>}
      {calendar.state === "error" && <div className="xus-cardbody xus-inline"><p className="xus-note" role="alert">{t("operations.releaseCalendar.error")}</p>{retry}</div>}
      {calendar.state === "refused" && <div className="xus-cardbody xus-inline"><p className="xus-note" role="status">{t("operations.releaseCalendar.refused")}</p>{retry}</div>}
      {calendar.state === "unavailable" && <div className="xus-cardbody"><p className="xus-note">{t("operations.releaseCalendar.unavailable")}</p></div>}
      {calendar.state === "empty" && <div className="xus-cardbody"><p className="xus-note">{t("operations.releaseCalendar.empty")}</p></div>}

      {(calendar.state === "ready" || calendar.state === "empty") && (
        <div className="xus-cardbody xus-inline">
          <p className="xus-note" data-testid="release-calendar-clock">{t("operations.releaseCalendar.databaseTime", { when: when(calendar.now) })}</p>
          <BusyButton type="button" className="xus-btn" pending={refreshing} onClick={() => void load()}>{t("operations.releaseCalendar.refresh")}</BusyButton>
        </div>
      )}

      {notice && (
        <div className="xus-cardbody">
          <p ref={noticeRef} tabIndex="-1" className="xus-note" role={NOTICE_ROLES[notice.outcome] ?? "alert"} data-testid="release-calendar-notice" data-outcome={notice.outcome}>
            {t(`operations.releaseCalendar.outcome.${notice.outcome}`, { label: labels(notice.key), action: actionWord(notice.action) })}
          </p>
        </div>
      )}

      {calendar.state === "ready" && calendar.switches.map((row) => {
        const state = releaseState(row);
        return (
          <div key={row.key} className="xus-arow" data-release-key={row.key} data-release-state={state}>
            <p className="xus-atext">
              <strong>{labels(row.key)}</strong> · {describe(row.releaseAt, row.held)}
              <br /><small><code>{row.key}</code></small>
            </p>
            <div className="xus-inline">
              {offers(row, state, "release") && (
                <BusyButton type="button" className="xus-btn" pending={saving && pending?.key === row.key} aria-label={t("operations.releaseCalendar.releaseNamed", { label: labels(row.key) })} onClick={() => open(row.key, "release")}>
                  {actionWord("release")}
                </BusyButton>
              )}
              {offers(row, state, "hold") && (
                <BusyButton type="button" className="xus-btn" pending={saving && pending?.key === row.key} aria-label={t("operations.releaseCalendar.holdNamed", { label: labels(row.key) })} onClick={() => open(row.key, "hold")}>
                  {actionWord("hold")}
                </BusyButton>
              )}
            </div>
          </div>
        );
      })}

      {calendar.state === "ready" && (
        <div className="xus-cardbody xus-cardbody--divided">
          <p className="xus-note" data-testid="release-calendar-command">{t("operations.releaseCalendar.useCommand")}</p>
          <h4 className="xus-eyebrow">{t("operations.releaseCalendar.changesTitle")}</h4>
          {changes.length === 0 && <p className="xus-note">{t("operations.releaseCalendar.changesEmpty")}</p>}
          {changes.length > 0 && (
            <ul className="xus-list" data-testid="release-calendar-changes">
              {changes.map((change) => (
                <li key={change.id}>
                  <small className="xus-atime">{change.at ? when(change.at) : t("operations.audit.timeUnavailable")}</small>{" "}
                  {t("operations.releaseCalendar.change", {
                    label: labels(change.key),
                    from: describeAt(change.previousReleaseAt, change.at),
                    to: describeAt(change.releaseAt, change.at),
                    who: change.byYou ? t("operations.releaseCalendar.byYou") : change.actorName ?? t("operations.releaseCalendar.byOperator"),
                    reason: change.reason,
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {pending && (
        <ConfirmActionDialog
          eyebrow={t("operations.releaseCalendar.title")}
          title={t(`operations.releaseCalendar.confirm.${pending.action}.title`, { label: labels(pending.key) })}
          effects={[
            t(`operations.releaseCalendar.confirm.${pending.action}.effect`),
            t("operations.releaseCalendar.confirm.bothSites"),
            t("operations.releaseCalendar.confirm.audit"),
          ]}
          affected={t("operations.releaseCalendar.confirm.affected")}
          undo={t(`operations.releaseCalendar.confirm.${pending.action}.undo`)}
          confirmLabel={t(`operations.releaseCalendar.confirm.${pending.action}.button`)}
          busy={saving}
          busyLabel={t("operations.releaseCalendar.confirm.saving")}
          confirmDisabled={!reason.trim()}
          onConfirm={() => void confirm()}
          onClose={close}
        >
          <label className="xus-field">
            {t("operations.releaseCalendar.confirm.reason")}
            <input
              type="text"
              className="xus-input"
              data-testid="release-calendar-reason"
              required
              maxLength={RELEASE_REASON_MAX}
              value={reason}
              onChange={(event) => setReason(oneLineReason(event.target.value))}
            />
          </label>
        </ConfirmActionDialog>
      )}
    </article>
  );
}
