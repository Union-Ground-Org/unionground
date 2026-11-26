import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Dialog } from "../../components/Dialog.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n.js";
import { leadershipFailureReason } from "../../lib/governanceApi.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001. The old chapter page offered
// "Claim chapter control" when every chapter admin and steward had been
// inactive for six months (de7df4b57c^ chapter-page-client.tsx:178-210). The
// server decides eligibility (get_chapter_leadership_recovery); this card only
// renders what it returns: the offer, the pending claim with its cooling-off
// date, or the outcome of a recent claim. Anything else renders nothing, and a
// failed read renders nothing too (the claim is never offered on a guess).
const OUTCOME_KEYS = Object.freeze({
  granted: ["leadership.grantedTitle", "leadership.grantedBody"],
  rejected: ["leadership.rejectedTitle", "leadership.rejectedBody"],
  lapsed: ["leadership.lapsedTitle", "leadership.lapsedBody"],
  withdrawn: ["leadership.withdrawnTitle", null],
});

export function ChapterLeadershipRecoveryCard({ api, onOpenSettings = null }) {
  const { t, lang } = useLang();
  const [state, setState] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!api?.load) return;
    try {
      setState(await api.load());
    } catch {
      setState(null);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  if (!state || state.available !== true) return null;
  const claim = state.claim && typeof state.claim === "object" ? state.claim : null;
  if (!claim && state.eligible !== true) return null;

  function run(action) {
    return runBusyWrite(busyWriteRef, "recovery", () => runNow(action));
  }

  async function runNow(action) {
    setBusy(true);
    setError("");
    try {
      await action();
      setConfirming(false);
      await load();
    } catch (failure) {
      setError(t(`leadership.error.${leadershipFailureReason(failure)}`));
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (claim?.status === "pending") {
    body = <>
      <h3 className="leadership-card__title">{t("leadership.pendingTitle")}</h3>
      <p>{t("leadership.pendingBody", { date: formatDateTimeWithZone(claim.effectiveAt, lang) })}</p>
      <div className="leadership-card__actions">
        <BusyButton type="button" className="hub2-btn" pending={busy} onClick={() => run(() => api.withdraw(claim.id))}>
          {busy ? t("leadership.withdrawing") : t("leadership.withdraw")}
        </BusyButton>
      </div>
    </>;
  } else if (claim && OUTCOME_KEYS[claim.status] && state.eligible !== true) {
    const [titleKey, bodyKey] = OUTCOME_KEYS[claim.status];
    body = <>
      <h3 className="leadership-card__title">{t(titleKey)}</h3>
      {bodyKey && <p>{t(bodyKey)}</p>}
      {claim.status === "rejected" && claim.decisionNote && <p>{t("leadership.rejectedNote", { note: claim.decisionNote })}</p>}
    </>;
  } else if (state.eligible === true) {
    body = <>
      <h3 className="leadership-card__title">{t("leadership.title")}</h3>
      <p>{t("leadership.body", { months: state.inactivityMonths })}</p>
      <p>{t("leadership.review", { hours: state.coolingOffHours })}</p>
      {state.mfaAssured === true ? (
        <div className="leadership-card__actions">
          <button type="button" className="hub2-btn hub2-btn--primary" onClick={() => { setError(""); setConfirming(true); }}>
            {t("leadership.claim")}
          </button>
        </div>
      ) : (
        <>
          <p className="leadership-card__note">{t("leadership.mfaNeeded")}</p>
          {onOpenSettings && <div className="leadership-card__actions">
            <button type="button" className="hub2-btn" onClick={onOpenSettings}>{t("leadership.openSettings")}</button>
          </div>}
        </>
      )}
    </>;
  } else {
    return null;
  }

  return (
    <section className="hub2-panel leadership-card" aria-label={t("leadership.title")} data-testid="chapter-leadership-recovery">
      <div className="leadership-card__row">
        <span className="leadership-card__icon" aria-hidden="true"><ShieldCheck size={18} /></span>
        <div className="leadership-card__copy">
          {body}
          {error && <p className="leadership-card__error" role="alert">{error}</p>}
        </div>
      </div>
      {confirming && (
        <Dialog title={t("leadership.confirmTitle")} onClose={() => setConfirming(false)} beforeClose={() => !busy} closeBlocked={busy} closeOperationKey={state.chapterId}>
          <p>{t("leadership.confirmBody", { chapter: state.chapterName || state.chapterId, hours: state.coolingOffHours })}</p>
          {error && <p className="leadership-card__error" role="alert">{error}</p>}
          <div className="leadership-card__actions">
            <BusyButton type="button" className="hub2-btn" pending={busy} onClick={() => setConfirming(false)}>{t("leadership.cancel")}</BusyButton>
            <BusyButton type="button" className="hub2-btn hub2-btn--primary" pending={busy} onClick={() => run(() => api.claim(state.chapterId))}>
              {busy ? t("leadership.claiming") : t("leadership.claim")}
            </BusyButton>
          </div>
        </Dialog>
      )}
    </section>
  );
}
