import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BusyButton, BusySelect } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";
import { LEGAL_HOLD_REASONS } from "../features/messaging/bodyLifecycle.js";

export function ConversationLegalHoldControls({ conversationId, api, onNotice, onChange }) {
  const { t, lang } = useLang();
  // Preservation order (legal hold). `status` is the server's answer for THIS
  // caller — whether the conversation is held, and whether the caller may
  // change that — so the controls below never guess from a client-side role.
  const [legalHold, setLegalHold] = useState({ status: null, loading: Boolean(api?.loadLegalHold), error: false });
  const [holdAction, setHoldAction] = useState(null);
  const [holdReason, setHoldReason] = useState(LEGAL_HOLD_REASONS[0]);
  const [holdBusy, setHoldBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const triggerRef = useRef(null);
  const reasonSelectRef = useRef(null);
  const releaseConfirmRef = useRef(null);
  const previousHoldActionRef = useRef(holdAction);
  const conversationIdRef = useRef(conversationId);
  // Place/Release unmounts the focused trigger; cancel unmounts the confirm.
  // Move focus with the unmount so it never falls to document.body. A layout
  // effect moves it in the same commit, so a failed place/release (which
  // commits after an await) never shows the trigger while focus is on the body.
  useLayoutEffect(() => {
    const previous = previousHoldActionRef.current;
    previousHoldActionRef.current = holdAction;
    if (previous === holdAction) return;
    if (holdAction === "place") reasonSelectRef.current?.focus();
    else if (holdAction === "release") releaseConfirmRef.current?.focus();
    else triggerRef.current?.focus();
  }, [holdAction]);
  const loadLegalHold = useCallback(async () => {
    if (!api?.loadLegalHold) return;
    // Keep the known status while reloading so a post-action reload never
    // collapses the panel to a loading-only paragraph.
    setLegalHold((current) => ({ status: current.status, loading: true, error: false }));
    try {
      const status = await api.loadLegalHold(conversationId);
      setLegalHold({ status, loading: false, error: !status });
    } catch {
      setLegalHold({ status: null, loading: false, error: true });
    }
  }, [api, conversationId]);

  useEffect(() => {
    if (conversationIdRef.current !== conversationId) {
      conversationIdRef.current = conversationId;
      setLegalHold({ status: null, loading: Boolean(api?.loadLegalHold), error: false });
      setHoldAction(null);
    }
    void loadLegalHold();
  }, [loadLegalHold, conversationId, api]);

  function placeHold(event) {
    return runBusyWrite(busyWriteRef, "hold", () => placeHoldNow(event), event);
  }

  async function placeHoldNow(event) {
    event.preventDefault();
    if (holdBusy || !api?.placeLegalHold) return;
    setHoldBusy(true);
    try {
      const result = await api.placeLegalHold(conversationId, holdReason);
      if (result?.held !== true) throw new Error("hold-not-confirmed");
      setHoldAction(null);
      onNotice(t("steward.legalHoldPlaced"));
      onChange?.(conversationId, true);
      // Optimistically show the hold that was just confirmed so the in-flight
      // reload agrees with the completed action instead of contradicting it.
      setLegalHold((current) => current.status
        ? { status: { ...current.status, held: true, reasonCode: holdReason }, loading: current.loading, error: false }
        : current);
      await loadLegalHold();
    } catch {
      // The action ended without a confirmed change; return focus to the trigger.
      setHoldAction(null);
      onNotice(t("steward.legalHoldFailed"));
    } finally {
      setHoldBusy(false);
    }
  }

  function releaseHold() {
    return runBusyWrite(busyWriteRef, "hold", () => releaseHoldNow());
  }

  async function releaseHoldNow() {
    if (holdBusy || !api?.releaseLegalHold) return;
    setHoldBusy(true);
    try {
      const result = await api.releaseLegalHold(conversationId);
      setHoldAction(null);
      // released:false is the server's "there was nothing to release", which
      // is news (someone else got there first), not a failure.
      onNotice(t(result?.released === false ? "steward.legalHoldReleaseNoop" : "steward.legalHoldReleased"));
      onChange?.(conversationId, false);
      // A noop ("nothing to release") changed nothing, so only the confirmed
      // release optimistically clears the held marker during the reload.
      if (result?.released !== false) {
        setLegalHold((current) => current.status
          ? { status: { ...current.status, held: false }, loading: current.loading, error: false }
          : current);
      }
      await loadLegalHold();
    } catch {
      setHoldAction(null);
      onNotice(t("steward.legalHoldFailed"));
    } finally {
      setHoldBusy(false);
    }
  }

  return <>
      {/* Loading-only paragraph for the genuine first load; reloads keep the known status rendered. */}
      {legalHold.loading && !legalHold.status && <p role="status">{t("app.loading")}</p>}
      {legalHold.error && (
        <p className="cwk-empty" role="status">
          {t("steward.legalHoldUnavailable")}{" "}
          <button className="cwk-btn cwk-btn--ghost" type="button" onClick={loadLegalHold}>{t("steward.tryAgain")}</button>
        </p>
      )}
      {legalHold.status?.held && (
        <p className="cwk-empty cwk-legal-hold" role="status" data-testid="legal-hold-marker">
          <span className="cwk-chip cwk-chip--rest">{t("steward.legalHoldChip")}</span>{" "}
          {legalHold.status.reasonCode
            ? t("steward.legalHoldActiveReason", {
              reason: t(`steward.legalHoldReason.${legalHold.status.reasonCode}`),
              date: legalHold.status.placedAt ? new Date(legalHold.status.placedAt).toLocaleDateString(localeFor(lang)) : "",
            })
            : t("steward.legalHoldActive")}
        </p>
      )}
      {/* Place / release are admin-only. The server said so (`canManage`) —
          the RPCs re-check the admin grant, the MFA boundary and the tenant. */}
      {legalHold.status?.canManage && !legalHold.error && !holdAction && (
        <div className="cwk-actions">
          <BusyButton
            ref={triggerRef}
            type="button"
            className="cwk-btn cwk-btn--ghost"
            pending={holdBusy}
            onClick={() => setHoldAction(legalHold.status.held ? "release" : "place")}
          >
            {legalHold.status.held ? t("steward.legalHoldRelease") : t("steward.legalHoldPlace")}
          </BusyButton>
        </div>
      )}
      {holdAction === "place" && (
        <form className="stack-form" aria-label={t("steward.legalHoldPlace")} onSubmit={placeHold}>
          <p>{t("steward.legalHoldPlaceConfirm")}</p>
          <label>{t("steward.legalHoldReason")}
            <BusySelect ref={reasonSelectRef} value={holdReason} onChange={(event) => setHoldReason(event.target.value)} pending={holdBusy}>
              {LEGAL_HOLD_REASONS.map((reason) => <option key={reason} value={reason}>{t(`steward.legalHoldReason.${reason}`)}</option>)}
            </BusySelect>
          </label>
          <div className="cwk-actions">
            <BusyButton className="cwk-btn cwk-btn--green" pending={holdBusy}>{t("steward.legalHoldPlaceGo")}</BusyButton>
            <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={holdBusy} onClick={() => setHoldAction(null)}>{t("tasks.cancel")}</BusyButton>
          </div>
        </form>
      )}
      {holdAction === "release" && (
        <div className="stack-form" role="group" aria-label={t("steward.legalHoldRelease")}>
          <p>{t("steward.legalHoldReleaseConfirm")}</p>
          <div className="cwk-actions">
            <BusyButton ref={releaseConfirmRef} type="button" className="cwk-btn cwk-btn--green" pending={holdBusy} onClick={releaseHold}>{t("steward.legalHoldReleaseGo")}</BusyButton>
            <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={holdBusy} onClick={() => setHoldAction(null)}>{t("tasks.cancel")}</BusyButton>
          </div>
        </div>
      )}
  </>;
}
