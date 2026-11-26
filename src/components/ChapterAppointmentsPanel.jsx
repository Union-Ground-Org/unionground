import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BusyButton, BusyInput, BusySelect } from "./BusyControls.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { rpcErrorTextStrict } from "../lib/rpcErrorText.js";

function appointmentTimeRange(startsAt, endsAt, lang) {
  return `${formatEasternTimestamp(startsAt, lang, { weekday: "short" }).text} – ${formatEasternTimestamp(endsAt, lang, { weekday: "short" }).text}`;
}

export function ChapterAppointmentsPanel({ api, onNotice = () => {} }) {
  const { t, lang } = useLang();
  const [rows, setRows] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  // Error states keep the raw refusal plus a catalogue fallback key and are
  // translated during render (see errorText below): storing translated copy
  // would freeze the notice in the language that was active when the failure
  // happened, so an in-place language switch would leave a stale-language
  // alert on an otherwise re-translated panel.
  const [loadError, setLoadError] = useState(null);
  const [moreError, setMoreError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const candidateScope = useMemo(() => ({ api, appointmentId: openId }), [api, openId]);
  const activeCandidateScope = useRef(null);
  const candidateGeneration = useRef(0);
  const [loadedCandidateScope, setLoadedCandidateScope] = useState(null);
  const [loadedCandidates, setCandidates] = useState(null);
  const [loadedCandidateError, setCandidateError] = useState(null);
  const candidates = loadedCandidateScope === candidateScope ? loadedCandidates : null;
  const candidateError = loadedCandidateScope === candidateScope ? loadedCandidateError : null;
  const [selectedId, setSelectedId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const writeInFlight = useRef(false);
  const formRef = useRef(null);
  const reassignButtons = useRef(new Map());
  const returnFocusId = useRef(null);

  useLayoutEffect(() => {
    activeCandidateScope.current = candidateScope;
    setSelectedId("");
    setConfirmed(false);
    return () => {
      activeCandidateScope.current = null;
      candidateGeneration.current += 1;
    };
  }, [candidateScope]);

  useEffect(() => {
    if (openId) {
      formRef.current?.focus();
      return;
    }
    if (!returnFocusId.current) return;
    const appointmentId = returnFocusId.current;
    returnFocusId.current = null;
    reassignButtons.current.get(appointmentId)?.focus();
  }, [openId]);

  const load = useCallback(async ({ after = null, append = false } = {}) => {
    setLoading(true);
    if (append) setMoreError(null);
    else setLoadError(null);
    try {
      const page = await api.loadChapterAppointments({ cursor: after });
      setRows((current) => append ? [...current, ...page.rows] : page.rows);
      setCursor(page.nextCursor);
      setTotal((current) => page.total ?? current ?? 0);
    } catch (error) {
      // A refused read arrives as raw database policy text; the alert must
      // stay catalogue copy in the member's own language.
      const failure = { error, fallbackKey: "appointmentSupervision.loadError" };
      if (append) setMoreError(failure);
      else setLoadError(failure);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const loadCandidates = useCallback(async (appointmentId) => {
    if (activeCandidateScope.current !== candidateScope || appointmentId !== candidateScope.appointmentId) return;
    const generation = ++candidateGeneration.current;
    setLoadedCandidateScope(candidateScope);
    setCandidates(null);
    setCandidateError(null);
    setSelectedId("");
    setConfirmed(false);
    try {
      const rows = await api.loadChapterAppointmentCandidates(appointmentId);
      if (activeCandidateScope.current === candidateScope && generation === candidateGeneration.current) setCandidates(rows);
    } catch (error) {
      if (activeCandidateScope.current !== candidateScope || generation !== candidateGeneration.current) return;
      setCandidates([]);
      setCandidateError({ error, fallbackKey: "appointmentSupervision.candidateError" });
    }
  }, [api, candidateScope]);

  useEffect(() => { if (openId) void loadCandidates(openId); }, [loadCandidates, openId]);

  function openReassignment(appointmentId) {
    returnFocusId.current = appointmentId;
    setOpenId(appointmentId);
    setSelectedId("");
    setConfirmed(false);
    setSaveError(null);
  }

  function closeReassignment() {
    if (saving) return;
    activeCandidateScope.current = null;
    candidateGeneration.current += 1;
    setOpenId(null);
    setCandidates(null);
    setCandidateError(null);
    setSelectedId("");
    setConfirmed(false);
    setSaveError(null);
  }

  async function submitReassignment(event) {
    event.preventDefault();
    if (!openId || !selectedId || !confirmed || writeInFlight.current) return;
    writeInFlight.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await api.reassignChapterAppointment(openId, selectedId);
      setOpenId(null);
      setCandidates(null);
      setSelectedId("");
      setConfirmed(false);
      await load();
      onNotice(t("appointmentSupervision.success"));
    } catch (error) {
      setSaveError({ error, fallbackKey: "appointmentSupervision.failure" });
    } finally {
      writeInFlight.current = false;
      setSaving(false);
    }
  }

  const errorText = (failure) => failure
    ? rpcErrorTextStrict(t, failure.error, t(failure.fallbackKey))
    : "";
  const loadErrorText = errorText(loadError);
  const moreErrorText = errorText(moreError);
  const candidateErrorText = errorText(candidateError);
  const saveErrorText = errorText(saveError);

  return (
    <section className="chapter-appts" aria-labelledby="chapter-appts-title">
      <header className="chapter-appts__head">
        <div>
          <h2 id="chapter-appts-title">{t("appointmentSupervision.title")}</h2>
          <p>{t("appointmentSupervision.privacy")}</p>
        </div>
        <p className="chapter-appts__timezone">
          {t("settings.zoneNewYork")} (ET)
        </p>
      </header>

      {loadError && rows.length === 0 ? (
        <div className="chapter-appts__alert" role="alert">
          <p>{loadErrorText}</p>
          <button type="button" onClick={() => load()}>{t("appointmentSupervision.retry")}</button>
        </div>
      ) : null}

      {loading && rows.length === 0 && !loadError ? (
        <p className="chapter-appts__state" role="status">{t("appointmentSupervision.loading")}</p>
      ) : null}

      {!loading && !loadError && rows.length === 0 ? (
        <p className="chapter-appts__state">{t("appointmentSupervision.empty")}</p>
      ) : null}

      {rows.length > 0 ? (
        <ul className="chapter-appts__list">
          {rows.map((appointment) => {
            const canReassign = appointment.status === "confirmed"
              && Date.parse(appointment.startsAt) > Date.now();
            const formOpen = openId === appointment.id;
            return (
              <li key={appointment.id}>
                <article className="chapter-appts__row" aria-label={appointment.memberName}>
                  <div className="chapter-appts__meta">
                    <p><span>{t("appointmentSupervision.member")}</span><strong>{appointment.memberName}</strong></p>
                    <p><span>{t("appointmentSupervision.type")}</span><strong>{t(`appointmentSupervision.type.${appointment.appointmentType}`)}</strong></p>
                    <p><span>{t("appointmentSupervision.duration")}</span><strong>{t("appointmentSupervision.minutes", { minutes: appointment.durationMinutes })}</strong></p>
                    <p><span>{t("appointmentSupervision.time")}</span><strong>{appointmentTimeRange(appointment.startsAt, appointment.endsAt, lang)}</strong></p>
                    <p><span>{t("appointmentSupervision.status")}</span><strong>{t(`appointmentSupervision.status.${appointment.status}`)}</strong></p>
                    <p><span>{t("appointmentSupervision.steward")}</span><strong>{appointment.stewardName}</strong></p>
                  </div>

                  {canReassign && !formOpen ? (
                    <button
                      ref={(node) => {
                        if (node) reassignButtons.current.set(appointment.id, node);
                        else reassignButtons.current.delete(appointment.id);
                      }}
                      className="chapter-appts__reassign"
                      type="button"
                      onClick={() => openReassignment(appointment.id)}
                    >
                      {t("appointmentSupervision.reassign")}
                    </button>
                  ) : null}

                  {formOpen ? (
                    <form
                      className="chapter-appts__form"
                      aria-label={t("appointmentSupervision.formLabel", { name: appointment.memberName })}
                      ref={formRef}
                      tabIndex="-1"
                      onSubmit={submitReassignment}
                    >
                      {candidates === null ? (
                        <p role="status">{t("appointmentSupervision.candidateLoading")}</p>
                      ) : null}
                      {candidateError ? (
                        <div className="chapter-appts__inline-alert" role="alert">
                          <p>{candidateErrorText}</p>
                          <BusyButton type="button" pending={saving} onClick={() => loadCandidates(appointment.id)}>
                            {t("appointmentSupervision.candidateRetry")}
                          </BusyButton>
                        </div>
                      ) : null}
                      {candidates?.length === 0 && !candidateError ? (
                        <p className="chapter-appts__state">{t("appointmentSupervision.candidateEmpty")}</p>
                      ) : null}
                      {candidates?.length ? (
                        <label>
                          <span>{t("appointmentSupervision.selectLabel")}</span>
                          <BusySelect required value={selectedId} pending={saving} onChange={(event) => setSelectedId(event.target.value)}>
                            <option value="">{t("appointmentSupervision.selectPrompt")}</option>
                            {candidates.map((candidate) => (
                              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                            ))}
                          </BusySelect>
                        </label>
                      ) : null}
                      <label className="chapter-appts__confirm">
                        <BusyInput
                          type="checkbox"
                          checked={confirmed}
                          pending={saving} disabled={!candidates?.length}
                          onChange={(event) => setConfirmed(event.target.checked)}
                        />
                        <span>{t("appointmentSupervision.confirm")}</span>
                      </label>
                      {saveError ? <p className="chapter-appts__save-error" role="alert">{saveErrorText}</p> : null}
                      <div className="chapter-appts__actions">
                        <BusyButton type="button" pending={saving} onClick={closeReassignment}>
                          {t("appointmentSupervision.cancel")}
                        </BusyButton>
                        <BusyButton type="submit" pending={saving} disabled={!selectedId || !confirmed}>
                          {saving ? t("appointmentSupervision.saving") : t("appointmentSupervision.save")}
                        </BusyButton>
                      </div>
                    </form>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      ) : null}

      {rows.length > 0 && total != null ? (
        <p className="chapter-appts__showing" role="status">
          {t("appointmentSupervision.showing", { shown: rows.length, total })}
        </p>
      ) : null}
      {moreError ? <p className="chapter-appts__save-error" role="alert">{moreErrorText}</p> : null}
      {cursor && (total == null || rows.length < total) ? (
        <button className="chapter-appts__more" type="button" disabled={loading} onClick={() => load({ after: cursor, append: true })}>
          {loading ? t("appointmentSupervision.loadingMore") : t("appointmentSupervision.loadMore")}
        </button>
      ) : null}
    </section>
  );
}
