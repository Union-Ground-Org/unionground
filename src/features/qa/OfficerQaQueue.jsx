import { useOrganizationTranslator } from "../../lib/LanguageContext.jsx";
import { useEffect, useRef, useState } from "react";
import { canOfficialReplyOnQa, canSeeOfficerQaQueue, hasOfficerGrant, isActiveOrganizationMember } from "./authorization.js";
import { QA_MAX_BODY_LENGTH, QA_MIN_BODY_LENGTH } from "./contract.js";
import { qaLengthHint } from "./lengthRule.js";
import { LengthHint, blockedButton, lengthProps } from "./MemberQaForum.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// BUG-UG-NO-CHAPTER-PAGES-GO-BLANK-OR-BLAME-PERMISSIONS-20261122
// (#9594, D1-14): an officer who passes every queue check except being in a
// chapter (a new organization's founder before its first chapter) is not
// told the role cannot do it; the queue says why it is empty. This only picks
// the words: canSeeOfficerQaQueue stays false, so no question or reply shows.
export function isQaOfficerWithoutChapter(actor) {
  return Boolean(actor && !actor.chapterId
    && isActiveOrganizationMember({ ...actor, chapterId: "any" })
    && hasOfficerGrant(actor));
}

const fieldStyle = {
  width: "100%",
  minHeight: 48,
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid var(--control-border, var(--sg-color-border))",
  borderRadius: 12,
  background: "var(--sg-color-card, var(--card))",
  color: "var(--ink, inherit)",
  font: "inherit",
};

const buttonStyle = {
  minHeight: 48,
  minWidth: 48,
  padding: "0 16px",
  border: 0,
  borderRadius: 12,
  background: "var(--green, var(--primary))",
  color: "var(--primary-foreground, #fff)",
  font: "inherit",
  fontWeight: 800,
  cursor: "pointer",
};

export function OfficerQaQueue({
  lang = "en",
  actor,
  scopeSettled = true,
  questions = [],
  state = "ready",
  error = null,
  notice = null,
  noticeKey = 0,
  onReply,
  onOpen,
  onLoadMore,
  onRetry,
}) {
  const translate = useOrganizationTranslator(lang);
  const t = (key, vars) => translate(`qa.${key}`, vars);
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);
  // Record 8435: official replies share one synchronous lock, as they share
  // busyId, so a second submit before busyId commits is refused.
  const busyWriteRef = useRef(new Set());
  const heading = useRef(null);

  useEffect(() => {
    if (notice) heading.current?.focus();
  }, [notice, noticeKey]);

  if (!canSeeOfficerQaQueue(actor)) {
    // Only a finished membership read proves there is no chapter (OfficerQaView
    // passes scopeSettled); before it, or after it failed, the refusal stays.
    if (scopeSettled && isQaOfficerWithoutChapter(actor)) {
      return (
        <section className="cwk-card" data-qa-surface="officer-queue-no-chapter">
          <p className="cwk-empty" role="note">{translate("steward.qaQueueNoChapter")}</p>
        </section>
      );
    }
    return <p className="bevoice-empty">{t("forbidden")}</p>;
  }

  if (state === "loading") return <p className="bevoice-empty" role="status">{t("loading")}</p>;
  if (state === "error") {
    return (
      <section className="cwk-card">
        <p role="alert">{error || t("unavailable")}</p>
        {onRetry && <button type="button" style={buttonStyle} onClick={onRetry}>{t("retry")}</button>}
      </section>
    );
  }

  return (
    <section className="cwk-card" data-qa-surface="officer-queue">
      <h2 ref={heading} tabIndex="-1" className="cwk-card__title">{t("queueTitle")}</h2>
      <p className="cwk-card__note">{t("queueSub")}</p>
      {notice && <p key={noticeKey} className="cwk-card__note" role="status">{notice}</p>}
      {error && <p className="cwk-card__note" role="alert">{error}</p>}
      {questions.length === 0 ? (
        <p className="cwk-empty">{t("queueEmpty")}</p>
      ) : (
        questions.map((question) => {
          const canReply = canOfficialReplyOnQa(actor, question);
          const draft = drafts[question.id] ?? "";
          const hint = qaLengthHint(lang, draft, QA_MIN_BODY_LENGTH);
          return (
            <article className="cwk-email" key={question.id}>
              <div className="cwk-row__top">
                <strong className="cwk-name">{question.title}</strong>
                <span className="cwk-chip cwk-chip--new">{t("waiting")}</span>
              </div>
              <p className="cwk-email__body">{question.body}</p>
              <p className="cwk-email__from">{question.authorDisplayName}</p>
              {onOpen && (
                <button type="button" className="cwk-btn cwk-btn--ghost" onClick={() => onOpen(question.id)}>
                  {question.title}
                </button>
              )}
              {canReply && onReply && (
                <form
                  className="cwk-form"
                  onSubmit={(event) => runBusyWrite(busyWriteRef, "reply", async () => {
                    event.preventDefault();
                    if (busyId || hint) return;
                    setBusyId(question.id);
                    try {
                      const result = await onReply({ questionId: question.id, body: draft });
                      if (result !== false) setDrafts((current) => ({ ...current, [question.id]: "" }));
                    } finally {
                      setBusyId(null);
                    }
                  }, event)}
                >
                  <label htmlFor={`qa-officer-${question.id}`}>{t("replyOfficial")}</label>
                  <textarea
                    id={`qa-officer-${question.id}`}
                    style={fieldStyle}
                    rows={3}
                    maxLength={QA_MAX_BODY_LENGTH}
                    {...lengthProps(hint, `qa-officer-${question.id}-length`, draft)}
                    value={draft}
                    onChange={(event) => setDrafts((current) => ({ ...current, [question.id]: event.target.value }))}
                    placeholder={t("replyPlaceholder")}
                  />
                  <LengthHint id={`qa-officer-${question.id}-length`} text={hint} value={draft} lang={lang} />
                  <BusyButton type="submit" style={hint ? blockedButton : buttonStyle} pending={busyId === question.id} disabled={Boolean(hint)}>
                    {busyId === question.id ? t("sending") : t("sendReply")}
                  </BusyButton>
                </form>
              )}
            </article>
          );
        })
      )}
      {onLoadMore && (
        <BusyButton type="button" style={buttonStyle} pending={Boolean(busyId)} onClick={onLoadMore}>
          {t("queueMore")}
        </BusyButton>
      )}
    </section>
  );
}
