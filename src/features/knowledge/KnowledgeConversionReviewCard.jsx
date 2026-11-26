import { useState } from "react";
import { BadgeCheck } from "lucide-react";
import { Card, Empty, Status } from "./knowledgeWorkspacePrimitives.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";

function conversionReviewState(conversion) {
  if (conversion?.reviewStatus === "rejected") return "rejected";
  if (conversion?.reviewStatus === "approved" || conversion?.reviewedAt) return "approved";
  if (conversion?.outcome === "failed") return "failed";
  return "pending";
}

// One key per state, so every state resolves through the same lookup and none
// of them can fall through to an unstyled bare string.
const STATE_LABEL_KEY = Object.freeze({
  pending: "knowledge.conversionPending",
  approved: "knowledge.conversionReviewed",
  failed: "knowledge.conversionFailed",
  rejected: "knowledge.conversionRejected",
});

export function KnowledgeConversionReviewCard({
  conversions = [],
  working = false,
  reviewColumnsAvailable = true,
  hasMore = false,
  onApprove,
  onReject,
  onLoadMore,
}) {
  const { t } = useLang();
  const [denyingId, setDenyingId] = useState("");
  const [reason, setReason] = useState("");

  function beginDenial(conversion) {
    setDenyingId(conversion.id);
    setReason("");
  }

  function cancelDenial() {
    setDenyingId("");
    setReason("");
  }

  async function confirmDenial(conversion) {
    const trimmed = reason.trim();
    if (!trimmed) return;
    const result = await onReject?.(conversion, trimmed);
    if (result !== false) cancelDenial();
  }

  return (
    <Card title={t("knowledge.conversions")} sub={t("knowledge.conversionsSub")} icon={BadgeCheck}>
      {/* Inside the card body, which is what <Card> renders around these
          children: only the header and the body carry the card's 16px gutter,
          so a paragraph outside them renders flush against the card border. */}
      {!reviewColumnsAvailable ? (
        <p
          id="knowledge-conversion-deny-unavailable"
          className="knowledge-workspace__hint"
          role="status"
        >
          {t("knowledge.denyConversionUnavailable")}
        </p>
      ) : null}
      {conversions.length === 0 ? (
        // An empty list with a further page behind it means the needs-review
        // section is clear, not that the ledger is empty -- an empty page ends
        // its section, so `hasMore` here can only be the unread settled
        // section. Claiming "nothing has been recorded" over a full ledger was
        // the copy half of the same defect as hiding the control below.
        <Empty>{hasMore ? t("knowledge.conversionNonePending") : t("knowledge.conversionEmpty")}</Empty>
      ) : (
        <ul className="knowledge-workspace__resource-list">
          {conversions.map((conversion) => {
            const state = conversionReviewState(conversion);
            const denying = denyingId === conversion.id;
            return (
              <li key={conversion.id}>
                <div>
                  <strong>{t("knowledge.conversionAttempt", { count: conversion.attempt })}</strong>
                  {/* One status treatment for all four states. Styling only
                      the refusal read as an inconsistency inside a single
                      list, and left the other three as bare text. */}
                  <Status>{t(STATE_LABEL_KEY[state])}</Status>
                  {state === "rejected" && conversion.rejectionReason ? (
                    <p>{t("knowledge.conversionRejectedReason", { reason: conversion.rejectionReason })}</p>
                  ) : null}
                  {conversion.errorCode ? <p className="knowledge-workspace__error">{conversion.errorCode}</p> : null}
                  {denying ? (
                    <label>
                      {t("knowledge.rejectionReason")}
                      <textarea
                        maxLength={280}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        required
                      />
                    </label>
                  ) : null}
                </div>
                <div className="knowledge-workspace__actions">
                  {state === "pending" || state === "failed" ? (
                    denying ? (
                      <>
                        <BusyButton
                          type="button"
                          className="hub2-btn hub2-btn--ghost"
                          pending={working}
                          onClick={cancelDenial}
                        >
                          {t("knowledge.cancelDenial")}
                        </BusyButton>
                        <BusyButton
                          type="button"
                          className="hub2-btn hub2-btn--danger"
                          pending={working} disabled={!reason.trim()}
                          onClick={() => confirmDenial(conversion)}
                        >
                          {t("knowledge.confirmDenial")}
                        </BusyButton>
                      </>
                    ) : (
                      <>
                        {state === "pending" ? (
                          <BusyButton
                            type="button"
                            className="hub2-btn hub2-btn--primary"
                            pending={working}
                            onClick={() => onApprove?.(conversion)}
                          >
                            {t("knowledge.approveConversion")}
                          </BusyButton>
                        ) : null}
                        <BusyButton
                          type="button"
                          className="hub2-btn hub2-btn--ghost"
                          pending={working} disabled={!reviewColumnsAvailable}
                          aria-describedby={reviewColumnsAvailable ? undefined : "knowledge-conversion-deny-unavailable"}
                          onClick={() => beginDenial(conversion)}
                        >
                          {t("knowledge.denyConversion")}
                        </BusyButton>
                      </>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {/* OUTSIDE the emptiness branch above, deliberately. The needs-review
          section is the first page and it is empty exactly when there is no
          outstanding work, which is the steady state; nesting this control in
          the non-empty branch made every settled decision ever recorded
          unreachable from the only surface that reviews them. */}
      {hasMore ? (
        <div className="knowledge-workspace__actions">
          <BusyButton
            type="button"
            className="hub2-btn hub2-btn--ghost"
            pending={working}
            onClick={() => onLoadMore?.()}
          >
            {t("knowledge.conversionLoadMore")}
          </BusyButton>
        </div>
      ) : null}
    </Card>
  );
}
