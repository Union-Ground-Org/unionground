import { useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";

const REVIEW_STATUSES = new Set(["draft", "submitted", "changes_requested", "approved"]);
const EXECUTION_STATUSES = new Set(["draft", "active", "paused", "archived"]);

export function AutomationReviewPanel({ definition, access = {}, busy, onSubmit, onApprove, onRequestChanges }) {
  const { t } = useLang();
  const [note, setNote] = useState("");
  const trimmedNote = note.trim();
  const reviewStatus = REVIEW_STATUSES.has(definition.reviewStatus) ? definition.reviewStatus : "draft";
  const executionStatus = EXECUTION_STATUSES.has(definition.status) ? definition.status : "draft";
  return <section className="automation-review" aria-labelledby="automation-review-title">
    <div className="automation-review__heading"><div><p className="automation-discover__eyebrow">{t("automation.governed.handoff")}</p><h3 id="automation-review-title">{t("automation.review.execution")}</h3></div><div className="automation-review__badges"><span>{t("automation.review")}: {t(`automation.reviewStatus.${reviewStatus}`)}</span><span>{t("automation.execution")}: {t(`automation.execStatus.${executionStatus}`)}</span></div></div>
    <p>{t("automation.review.boundToVersion", { version: definition.version })}</p>
    {definition.reviewNote && <blockquote><p>{definition.reviewNote}</p></blockquote>}
    {definition.canSubmit && <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy} onClick={onSubmit}>{t("automation.review.submitVersion", { version: definition.version })}</BusyButton>}
    {access.canApprove && definition.canReview && <div className="automation-review__actions">
      {definition.submittedBySelf && <p role="status">{t("automation.review.selfReviewAllowed")}</p>}
      <label className="xus-field">{t("automation.review.note")}<textarea className="xus-input" rows="3" maxLength="500" value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="xus-btnrow">
        <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy} onClick={() => onApprove(trimmedNote || null)}>{t("automation.review.approveVersion", { version: definition.version })}</BusyButton>
        <BusyButton className="xus-btn" type="button" pending={busy} disabled={!trimmedNote} disabledReason={t("automation.review.noteRequired")} onClick={() => onRequestChanges(trimmedNote)}>{t("automation.request.changes")}</BusyButton>
      </div>
    </div>}
    {!access.canApprove && definition.reviewStatus === "submitted" && <p role="status">{t("automation.review.awaitingApproval")}</p>}
    {definition.reviewStatus === "approved" && <p role="status">{t("automation.review.approvedNeedsActivation")}</p>}
  </section>;
}
