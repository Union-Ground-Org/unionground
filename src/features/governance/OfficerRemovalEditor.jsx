import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { languageLoaded, loadLanguage, t as translate } from "../../lib/i18n.js";
import { BusyButton, BusyFieldset, BusyInput, BusySelect } from "../../components/BusyControls.jsx";
import { returnFocusAfterModal } from "../../lib/useTransitionPresence.js";

// REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001: the staff editor for an officer
// removal ballot (old app/dashboard/voting/create-ballot-form.tsx, ballot type
// "controller_removal"). Staff choose an officer the server lists for the
// ballot's scope, give a reason of at least 10 characters, and the usual
// bilingual titles, close time and quorum. The two options are fixed by the
// server. save_officer_removal_ballot_draft re-checks every field.
export function emptyRemovalDraft(scope = "chapter") {
  const close = new Date(Date.now() + (7 * 86400000));
  close.setMinutes(close.getMinutes() - close.getTimezoneOffset());
  return {
    id: "", scope, targetUserId: "", reason: "", titleEn: "", titleEs: "",
    bodyEn: "", bodyEs: "", closesAt: close.toISOString().slice(0, 16), quorumTarget: 1,
    titlesTouched: false,
  };
}

export function removalDraftFromCampaign(campaign, detail) {
  const close = new Date(campaign.closesAt);
  close.setMinutes(close.getMinutes() - close.getTimezoneOffset());
  return {
    id: campaign.id, scope: campaign.scope, targetUserId: detail?.targetUserId || "",
    reason: detail?.reason || "", titleEn: campaign.titleEn || "", titleEs: campaign.titleEs || "",
    bodyEn: campaign.bodyEn || "", bodyEs: campaign.bodyEs || "", closesAt: close.toISOString().slice(0, 16),
    quorumTarget: Number(campaign.quorumTarget) || 1, titlesTouched: true,
  };
}

function removalRoleKey(role, scope) {
  return role === "vp" && scope === "chapter" ? "officerRemoval.role.chapterLead" : `officerRemoval.role.${role}`;
}

export function defaultRemovalTitles(target, scope) {
  if (!target) return { titleEn: "", titleEs: "" };
  const titleIn = (lang) => translate(lang, "officerRemoval.titleDefault", {
    name: target.name,
    role: translate(lang, removalRoleKey(target.role, scope)),
  });
  // The Spanish catalogue is fetched on demand (the editor asks for it on
  // mount). Without it translate("es") answers in English, and that English
  // would be saved as the Spanish title; leave the field for staff instead.
  return { titleEn: titleIn("en").slice(0, 160), titleEs: languageLoaded("es") ? titleIn("es").slice(0, 160) : "" };
}

// An officer chosen before the Spanish catalogue arrived left the default
// Spanish title blank. Once Spanish is here, fill it, unless staff have
// written a title themselves. With no catalogue the field stays blank: it is
// required (3 to 160 characters), so the browser will not submit it and
// save_officer_removal_ballot_draft refuses it; staff type the Spanish title.
function withDefaultSpanishTitle(draft, targets) {
  if (draft.titlesTouched || draft.titleEs || !draft.targetUserId) return draft;
  const { titleEs } = defaultRemovalTitles((targets || []).find((item) => item.userId === draft.targetUserId), draft.scope);
  return titleEs ? { ...draft, titleEs } : draft;
}

// busy (record 8435): the host's save is running. Cancel, the officer choice
// and Save stay focusable as pending controls and refuse activation; the
// host's save takes its own synchronous lock (CampaignsView runBusyWrite).
export function OfficerRemovalEditor({ draft, setDraft, canManageUnion, canManageChapter = true, busy, error = "", loadTargets, onCancel, onSave }) {
  const { t } = useLang();
  const titleRef = useRef(null);
  const [targets, setTargets] = useState(null);
  const [targetsFailed, setTargetsFailed] = useState(false);
  // defaultRemovalTitles needs the Spanish table for the default Spanish title.
  // Choosing an officer while it is missing asks again (a new attempt), so a
  // load that failed earlier gets another try.
  const [spanishReady, setSpanishReady] = useState(() => languageLoaded("es"));
  const [spanishAttempt, setSpanishAttempt] = useState(0);
  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    if (spanishReady) return undefined;
    let active = true;
    loadLanguage("es").then((ok) => { if (active && ok) setSpanishReady(true); });
    return () => { active = false; };
  }, [spanishReady, spanishAttempt]);
  useEffect(() => {
    if (spanishReady && targets) setDraft((current) => withDefaultSpanishTitle(current, targets));
  }, [spanishReady, targets, setDraft]);
  useEffect(() => {
    let active = true;
    setTargets(null);
    setTargetsFailed(false);
    Promise.resolve(loadTargets(draft.scope))
      .then((result) => { if (active) setTargets(Array.isArray(result?.items) ? result.items : []); })
      .catch(() => { if (active) setTargetsFailed(true); });
    return () => { active = false; };
  }, [draft.scope, loadTargets]);

  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const chooseTarget = (userId) => {
    if (!languageLoaded("es")) setSpanishAttempt((count) => count + 1);
    setDraft((current) => {
      const target = (targets || []).find((item) => item.userId === userId);
      return current.titlesTouched
        ? { ...current, targetUserId: userId }
        : { ...current, targetUserId: userId, ...defaultRemovalTitles(target, current.scope) };
    });
  };
  const setTitle = (key, value) => setDraft((current) => ({ ...current, [key]: value, titlesTouched: true }));
  const submit = (event) => {
    event.preventDefault();
    onSave({ ...withDefaultSpanishTitle(draft, targets), closesAt: new Date(draft.closesAt).toISOString() });
  };

  return (
    <form className="cam-editor" onSubmit={submit} aria-busy={busy} data-testid="officer-removal-editor">
      <div className="cam-editor__head">
        <div><p className="cam-kicker">{t("officerRemoval.badge")}</p><h2 ref={titleRef} tabIndex="-1">{t("officerRemoval.editorTitle")}</h2></div>
        <BusyButton className="cam-btn cam-btn--quiet" type="button" onClick={onCancel} pending={busy}>{t("campaigns.cancel")}</BusyButton>
      </div>
      <p className="cam-help">{t("officerRemoval.editorSub")}</p>
      <fieldset className="cam-fieldset"><legend>{t("campaigns.editor.typeScope")}</legend>
        <div className="cam-choice-row">
          {canManageChapter && <label><BusyInput type="radio" name="removal-scope" checked={draft.scope === "chapter"} onChange={() => setDraft((current) => ({ ...current, scope: "chapter", targetUserId: "" }))} pending={busy} disabled={Boolean(draft.id)} /> {t("campaigns.scope.chapter")}</label>}
          {canManageUnion && <label><BusyInput type="radio" name="removal-scope" checked={draft.scope === "union"} onChange={() => setDraft((current) => ({ ...current, scope: "union", targetUserId: "" }))} pending={busy} disabled={Boolean(draft.id)} /> {t("campaigns.scope.union")}</label>}
        </div>
        <label className="cam-field"><span>{t("officerRemoval.target")}</span>
          <BusySelect value={draft.targetUserId} onChange={(event) => chooseTarget(event.target.value)} required pending={busy} disabled={targets === null}>
            <option value="">{t("officerRemoval.targetPlaceholder")}</option>
            {(targets || []).map((item) => <option key={item.userId} value={item.userId}>{item.name} · {t(removalRoleKey(item.role, draft.scope))}</option>)}
          </BusySelect>
        </label>
        {targetsFailed && <p className="cam-help" role="alert">{t("officerRemoval.targetsFailed")}</p>}
        {targets && targets.length === 0 && <p className="cam-help">{t("officerRemoval.targetsEmpty")}</p>}
        <label className="cam-field"><span>{t("officerRemoval.reason")}</span>
          <textarea value={draft.reason} onChange={(event) => set("reason", event.target.value)} readOnly={busy} minLength="10" maxLength="1000" required />
        </label>
        <p className="cam-help">{t("officerRemoval.options")}</p>
      </fieldset>
      <BusyFieldset className="cam-fieldset" pending={busy}><legend>{t("campaigns.editor.copy")}</legend>
        <div className="cam-grid">
          <label className="cam-field"><span>{t("campaigns.titleEn")}</span><input value={draft.titleEn} onChange={(event) => setTitle("titleEn", event.target.value)} minLength="3" maxLength="160" required /></label>
          <label className="cam-field"><span>{t("campaigns.titleEs")}</span><input value={draft.titleEs} onChange={(event) => setTitle("titleEs", event.target.value)} minLength="3" maxLength="160" required /></label>
          <label className="cam-field"><span>{t("campaigns.bodyEn")}</span><textarea value={draft.bodyEn} onChange={(event) => set("bodyEn", event.target.value)} maxLength="1000" /></label>
          <label className="cam-field"><span>{t("campaigns.bodyEs")}</span><textarea value={draft.bodyEs} onChange={(event) => set("bodyEs", event.target.value)} maxLength="1000" /></label>
        </div>
      </BusyFieldset>
      <BusyFieldset className="cam-fieldset" pending={busy}><legend>{t("campaigns.editor.timing")}</legend>
        <div className="cam-grid cam-grid--timing">
          <label className="cam-field"><span>{t("campaigns.closesAt")}</span><input type="datetime-local" value={draft.closesAt} onChange={(event) => set("closesAt", event.target.value)} required /></label>
          <label className="cam-field"><span>{t("campaigns.quorum")}</span><input type="number" value={draft.quorumTarget} min="1" max="1000000" onChange={(event) => set("quorumTarget", event.target.value)} required /></label>
        </div>
      </BusyFieldset>
      <div className="cam-actions cam-actions--sticky">
        {error && <p className="cam-feedback cam-feedback--error" role="alert">{error}</p>}
        <BusyButton className="cam-btn cam-btn--go" type="submit" pending={busy}>{busy ? t("campaigns.saving") : t("campaigns.saveDraft")}</BusyButton>
      </div>
    </form>
  );
}

// Card lines for a removal ballot: officer, reason, and the recorded outcome
// or (for staff who may record it) the two outcome buttons. Shared by the staff
// registry and the member voting page (canRecord false there).
export function OfficerRemovalSummary({ detail, scope, chapterId, canRecord = false, busy = false, onRecord = null, recordError = "", failedOutcome = "", recordedOutcome = "", announceOutcome = true, focusOutcome = false }) {
  const { t } = useLang();
  const outcomeRef = useRef(null);
  const previousOutcome = useRef(recordedOutcome);
  useEffect(() => {
    if (focusOutcome && previousOutcome.current !== recordedOutcome) returnFocusAfterModal(outcomeRef.current);
    previousOutcome.current = recordedOutcome;
  }, [focusOutcome, recordedOutcome]);
  if (!detail) return null;
  const role = t(removalRoleKey(detail.targetRole, scope ?? (chapterId ? "chapter" : undefined)));
  const outcome = detail.outcome || recordedOutcome;
  return (
    <div className="officer-removal-summary" data-testid="officer-removal-summary">
      <span className="officer-removal-summary__badge">{t("officerRemoval.badge")}</span>
      <p>{t("officerRemoval.targetLine", { name: detail.targetName, role })}</p>
      {detail.reason && <p className="officer-removal-summary__reason">{t("officerRemoval.reasonLine", { reason: detail.reason })}</p>}
      {(canRecord || outcome) && <p className="officer-removal-summary__outcome" ref={outcomeRef} role={canRecord && announceOutcome ? "status" : undefined} tabIndex={recordedOutcome ? -1 : undefined}>
        {outcome && <strong>{t(`officerRemoval.outcome.${outcome}`)}</strong>}
      </p>}
      {!outcome && (canRecord && detail.canRecordOutcome && onRecord ? (
          <div className="officer-removal-summary__record">
            <p className="officer-removal-summary__title">{t("officerRemoval.outcomeTitle")}</p>
            <div className="cam-actions cam-actions--feedback">
              {["removed", "retained"].map((outcome) => (
                <div className="cam-feedback-action" key={outcome}>
                  <BusyButton type="button" className={`cam-btn ${outcome === "removed" ? "cam-btn--close" : "cam-btn--quiet"}`} pending={busy}
                    aria-label={t("officerRemoval.recordNamed", { outcome: t(`officerRemoval.${outcome}`), name: detail.targetName })}
                    onClick={(event) => onRecord(outcome, event.currentTarget)}>
                    {t(`officerRemoval.${outcome}`)}
                  </BusyButton>
                  {recordError && failedOutcome === outcome && <p className="cam-feedback cam-feedback--error" role={announceOutcome ? "alert" : undefined}>{t(recordError)}</p>}
                </div>
              ))}
            </div>
            <p className="cam-help">{t("officerRemoval.outcomeHelp")}</p>
          </div>
        ) : canRecord ? <p className="cam-help">{t("officerRemoval.awaiting")}</p> : null)}
    </div>
  );
}
