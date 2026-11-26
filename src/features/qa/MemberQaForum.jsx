import { useOrganizationTranslator } from "../../lib/LanguageContext.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { canAcceptQaAnswer, canAskQaQuestion, canFollowUpOnQa, canOfficialReplyOnQa, canVoteOnQa } from "./authorization.js";
import { QA_MAX_BODY_LENGTH, QA_MAX_TITLE_LENGTH, QA_MIN_BODY_LENGTH, QA_MIN_TITLE_LENGTH } from "./contract.js";
import { qaCountKey, qaStatusLabel, qaText } from "./copy.js";
import { qaLengthHint, qaLengthMet } from "./lengthRule.js";
import { messageVisibilityCatalogue } from "../../lib/i18n/messageVisibility.js";
import { projectQaListItem } from "./store.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

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

const quietButton = {
  ...buttonStyle,
  background: "transparent",
  color: "var(--ink, inherit)",
  border: "1px solid var(--control-border, var(--sg-color-border))",
};

// #9460: a held post button looks held, not full colour with a pointer.
export const blockedButton = {
  ...buttonStyle,
  background: "var(--disabled)",
  color: "var(--disabled-foreground)",
  cursor: "not-allowed",
};

// #9460: a field's unmet minimum, beside it and in its aria-describedby; not
// an alert, which would repeat per keystroke (#9452). The polite live region
// is always mounted and fills once, when typed text reaches the minimum; it
// has no status role, so a screen's own status notice stays the only one.
export function LengthHint({ id, text, value, lang }) {
  return (
    <>
      {text && <p className="bevoice-composer__note" id={id}>{text}</p>}
      <p className="sr-only" aria-live="polite" aria-atomic="true" id={`${id}-met`}>{text || !value.trim() ? "" : qaLengthMet(lang)}</p>
    </>
  );
}

export function lengthProps(hint, id, value, others = "") {
  return {
    "aria-describedby": [hint ? id : value.trim() && `${id}-met`, others].filter(Boolean).join(" ") || undefined,
    "aria-invalid": (hint !== "" && value.trim() !== "") || undefined,
  };
}

function statusChip(lang, status) {
  return (
    <span className="cwk-chip" data-qa-status={status}>
      {status === "open" ? qaText(lang, "waiting") : qaStatusLabel(lang, status)}
    </span>
  );
}

export function MemberQaForum({
  lang = "en",
  actor,
  questions = [],
  selectedQuestion = null,
  state = "ready",
  error = null,
  notice = null,
  noticeKey = 0,
  onSearch,
  onAsk,
  onOpen,
  onBack,
  onVote,
  onAccept,
  onFollowUp,
  onOfficialReply,
  onRetry,
}) {
  const translate = useOrganizationTranslator(lang);
  const t = (key, vars) => translate(`qa.${key}`, vars);
  // Kept out of qa.js: the native app reads that file, and its strings count
  // against the mobile catalogue budget (tests/mi1-member-qa-mobile-wiring).
  const audience = (messageVisibilityCatalogue[lang] || messageVisibilityCatalogue.en)["visibility.qa"];
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [status, setStatus] = useState("all");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const activeQuestionId = selectedQuestion?.id ?? null;
  const [replyDraft, setReplyDraft] = useState(() => ({ questionId: activeQuestionId, body: "" }));
  // Treat a draft for another question as empty during render. The passive
  // cleanup below may run after the detail becomes interactive, so it must
  // never overwrite input that is already keyed to the current question.
  const reply = replyDraft.questionId === activeQuestionId ? replyDraft.body : "";
  const [busy, setBusy] = useState(false);
  // Record 8435: the forum's writes share one synchronous lock, as they share
  // one busy state, so a second activation before busy commits is refused.
  const busyWriteRef = useRef(new Set());
  const [askOpen, setAskOpen] = useState(false);
  const searchMounted = useRef(false);
  const searchInput = useRef(null);
  const detailHeading = useRef(null);
  const previousQuestionId = useRef(null);

  useEffect(() => {
    const previous = previousQuestionId.current;
    const next = selectedQuestion?.id ?? null;
    previousQuestionId.current = next;
    if (next && next !== previous) detailHeading.current?.focus();
    if (!next && previous) searchInput.current?.focus();
  }, [selectedQuestion?.id]);

  useEffect(() => {
    // A draft belongs to one question. Never carry text into another
    // question after navigation or a stale-load recovery. If the member or
    // officer already typed for the new question, preserve that current-key
    // draft instead of letting delayed cleanup erase it.
    setReplyDraft((current) => current.questionId === activeQuestionId
      ? current
      : { questionId: activeQuestionId, body: "" });
  }, [activeQuestionId]);

  useEffect(() => {
    if (!searchMounted.current) {
      searchMounted.current = true;
      return undefined;
    }
    const timer = globalThis.setTimeout(() => {
      onSearch?.({ query, sort, status });
    }, 250);
    return () => globalThis.clearTimeout(timer);
  }, [onSearch, query, sort, status]);

  const titleHint = qaLengthHint(lang, title, QA_MIN_TITLE_LENGTH);
  const bodyHint = qaLengthHint(lang, body, QA_MIN_BODY_LENGTH);

  const filtered = useMemo(() => {
    // The server/store adapter owns search, status and ordering. Re-filtering
    // its projection here can erase legitimate matches found in official
    // reply bodies that are not present in the truncated list preview.
    return questions.map((question) => (
      question.preview ? question : projectQaListItem(question)
    ));
  }, [questions]);

  function run(action) {
    return runBusyWrite(busyWriteRef, "forum", () => runNow(action));
  }

  async function runNow(action) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") {
    return <p className="bevoice-empty" role="status">{t("loading")}</p>;
  }

  if (state === "error") {
    return (
      <section className="bevoice-card">
        <p role="alert">{error || t("unavailable")}</p>
        {onRetry && <button type="button" style={buttonStyle} onClick={onRetry}>{t("retry")}</button>}
      </section>
    );
  }

  if (selectedQuestion) {
    const canOfficial = canOfficialReplyOnQa(actor, selectedQuestion);
    const canFollow = canFollowUpOnQa(actor) && selectedQuestion.authoredByMe === true;
    const canVote = canVoteOnQa(actor);
    const replyHint = qaLengthHint(lang, reply, QA_MIN_BODY_LENGTH);
    return (
      <article className="bevoice-screen" data-qa-surface="detail">
        {notice && <p key={noticeKey} className="bevoice-composer__note" role="status">{notice}</p>}
        {error && <p className="bevoice-composer__note" role="alert">{error}</p>}
        {onBack && (
          <button type="button" style={quietButton} onClick={onBack}>{t("back")}</button>
        )}
        <header className="bevoice-ph">
          <h1 ref={detailHeading} tabIndex="-1" className="bevoice-ph__title">{selectedQuestion.title}</h1>
          <p className="bevoice-ph__sub">{selectedQuestion.authorDisplayName}</p>
          {statusChip(lang, selectedQuestion.status)}
        </header>
        <p>{selectedQuestion.body}</p>
        <div className="cwk-actions">
          {canVote && onVote && (
            <BusyButton
              type="button"
              style={quietButton}
              aria-pressed={selectedQuestion.votedByMe === true}
              pending={busy}
              onClick={() => run(() => onVote({ targetKind: "question", targetId: selectedQuestion.id, voted: selectedQuestion.votedByMe !== true }))}
            >
              {selectedQuestion.votedByMe ? t("upvoted") : t("upvote")} · {t(qaCountKey("votes", selectedQuestion.upvoteCount), { count: selectedQuestion.upvoteCount ?? 0 })}
            </BusyButton>
          )}
        </div>
        <ol className="bevoice-weekly__list">
          {(selectedQuestion.replies ?? []).filter((item) => !item.deletedAt).map((item) => (
            <li key={item.id} className="bevoice-weekly__row" data-qa-reply-kind={item.kind}>
              <div>
                <p>{item.body}</p>
                <small>
                  {item.kind === "official" ? t("official") : t("followUp")}
                  {item.accepted ? ` · ${t("accepted")}` : ""}
                  {` · ${item.authorDisplayName}`}
                </small>
              </div>
              <div className="cwk-actions">
                {canVote && onVote && (
                  <BusyButton
                    type="button"
                    style={quietButton}
                    aria-pressed={item.votedByMe === true}
                    pending={busy}
                    onClick={() => run(() => onVote({ targetKind: "reply", targetId: item.id, voted: item.votedByMe !== true }))}
                  >
                    {item.votedByMe ? t("upvoted") : t("upvote")}
                  </BusyButton>
                )}
                {item.kind === "official" && canAcceptQaAnswer(actor, selectedQuestion) && onAccept && (
                  <BusyButton
                    type="button"
                    style={buttonStyle}
                    pending={busy}
                    onClick={() => run(() => onAccept({ questionId: selectedQuestion.id, replyId: item.id, accepted: item.accepted !== true }))}
                  >
                    {item.accepted ? t("unaccept") : t("accept")}
                  </BusyButton>
                )}
              </div>
            </li>
          ))}
        </ol>
        {canOfficial && onOfficialReply ? (
          <form
            className="bevoice-composer"
            onSubmit={(event) => {
              event.preventDefault();
              const text = reply.trim();
              if (!text) return;
              run(async () => {
                const result = await onOfficialReply({ questionId: selectedQuestion.id, body: text });
                if (result !== false) {
                  setReplyDraft((current) => current.questionId === activeQuestionId && current.body === reply
                    ? { questionId: activeQuestionId, body: "" }
                    : current);
                }
              });
            }}
          >
            <label htmlFor="qa-official-reply">{t("replyOfficial")}</label>
            <p className="bevoice-composer__note" id="qa-official-reply-audience">{audience}</p>
            <textarea
              id="qa-official-reply"
              {...lengthProps(replyHint, "qa-official-reply-length", reply, "qa-official-reply-audience")}
              style={fieldStyle}
              rows={3}
              maxLength={QA_MAX_BODY_LENGTH}
              value={reply}
              onChange={(event) => setReplyDraft({ questionId: activeQuestionId, body: event.target.value })}
              placeholder={t("replyPlaceholder")}
            />
            <LengthHint id="qa-official-reply-length" text={replyHint} value={reply} lang={lang} />
            <BusyButton type="submit" style={replyHint ? blockedButton : buttonStyle} pending={busy} disabled={Boolean(replyHint)}>
              {busy ? t("sending") : t("sendReply")}
            </BusyButton>
          </form>
        ) : canFollow && onFollowUp ? (
          <form
            className="bevoice-composer"
            onSubmit={(event) => {
              event.preventDefault();
              const text = reply.trim();
              if (!text) return;
              run(async () => {
                const result = await onFollowUp({ questionId: selectedQuestion.id, body: text });
                if (result !== false) {
                  setReplyDraft((current) => current.questionId === activeQuestionId && current.body === reply
                    ? { questionId: activeQuestionId, body: "" }
                    : current);
                }
              });
            }}
          >
            <label htmlFor="qa-follow-up">{t("replyFollowUp")}</label>
            <p className="bevoice-composer__note">{t("memberCannotOfficial")}</p>
            <p className="bevoice-composer__note" id="qa-follow-up-audience">{audience}</p>
            <textarea
              id="qa-follow-up"
              {...lengthProps(replyHint, "qa-follow-up-length", reply, "qa-follow-up-audience")}
              style={fieldStyle}
              rows={3}
              maxLength={QA_MAX_BODY_LENGTH}
              value={reply}
              onChange={(event) => setReplyDraft({ questionId: activeQuestionId, body: event.target.value })}
              placeholder={t("followUpPlaceholder")}
            />
            <LengthHint id="qa-follow-up-length" text={replyHint} value={reply} lang={lang} />
            <BusyButton type="submit" style={replyHint ? blockedButton : buttonStyle} pending={busy} disabled={Boolean(replyHint)}>
              {busy ? t("sending") : t("sendReply")}
            </BusyButton>
          </form>
        ) : (
          <p className="bevoice-composer__note">{t("memberCannotOfficial")}</p>
        )}
      </article>
    );
  }

  return (
    <section className="bevoice-screen" data-qa-surface="list">
      <header className="bevoice-ph">
        <h1 className="bevoice-ph__title">{t("title")}</h1>
        <p className="bevoice-ph__sub">{t("sub")}</p>
      </header>
      {notice && <p key={noticeKey} className="bevoice-composer__note" role="status">{notice}</p>}
      {error && <p className="bevoice-composer__note" role="alert">{error}</p>}
      <div className="bevoice-weekly__head">
        <label htmlFor="qa-search">{t("searchLabel")}</label>
        <input
          ref={searchInput}
          id="qa-search"
          type="search"
          maxLength={120}
          style={fieldStyle}
          value={query}
          placeholder={t("searchPlaceholder")}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <label htmlFor="qa-sort">{t("sortLabel")}</label>
        <select
          id="qa-sort"
          style={fieldStyle}
          value={sort}
          onChange={(event) => {
            setSort(event.target.value);
          }}
        >
          <option value="newest">{t("sortNewest")}</option>
          <option value="votes">{t("sortVotes")}</option>
          <option value="unanswered">{t("sortUnanswered")}</option>
        </select>
        <div role="group" aria-label={t("statusAll")}>
          {["all", "open", "replied", "accepted"].map((value) => (
            <button
              key={value}
              type="button"
              style={quietButton}
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
              }}
            >
              {value === "all" ? t("statusAll") : qaStatusLabel(lang, value)}
            </button>
          ))}
        </div>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{t("results", { count: filtered.length })}</p>
      {canAskQaQuestion(actor) && onAsk && (
        askOpen ? (
          <form
            className="bevoice-composer"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const result = await onAsk({ title, body });
                if (result !== false) {
                  setTitle("");
                  setBody("");
                  setAskOpen(false);
                }
              });
            }}
          >
            <h2>{t("askTitle")}</h2>
            <label htmlFor="qa-title">{t("titleLabel")}</label>
            <input
              id="qa-title"
              style={fieldStyle}
              maxLength={QA_MAX_TITLE_LENGTH}
              minLength={QA_MIN_TITLE_LENGTH}
              {...lengthProps(titleHint, "qa-title-length", title)}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("titlePlaceholder")}
              required
            />
            <LengthHint id="qa-title-length" text={titleHint} value={title} lang={lang} />
            <label htmlFor="qa-body">{t("bodyLabel")}</label>
            <p className="bevoice-composer__note" id="qa-body-audience">{audience}</p>
            <textarea
              id="qa-body"
              {...lengthProps(bodyHint, "qa-body-length", body, "qa-body-audience")}
              style={fieldStyle}
              rows={4}
              maxLength={QA_MAX_BODY_LENGTH}
              minLength={QA_MIN_BODY_LENGTH}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={t("bodyPlaceholder")}
              required
            />
            <LengthHint id="qa-body-length" text={bodyHint} value={body} lang={lang} />
            <div className="bevoice-composer__foot">
              <button type="button" style={quietButton} onClick={() => setAskOpen(false)}>{t("cancel")}</button>
              <BusyButton type="submit" style={titleHint || bodyHint ? blockedButton : buttonStyle} pending={busy} disabled={Boolean(titleHint || bodyHint)}>
                {busy ? t("posting") : t("post")}
              </BusyButton>
            </div>
          </form>
        ) : (
          <button type="button" style={buttonStyle} onClick={() => setAskOpen(true)}>{t("askTitle")}</button>
        )
      )}
      {filtered.length === 0 ? (
        <p className="bevoice-empty">{questions.length === 0 ? t("empty") : t("noneMatch")}</p>
      ) : (
        <div className="bevoice-weekly__list">
          {filtered.map((question) => (
            <article className="bevoice-weekly__row" key={question.id}>
              <button
                type="button"
                style={{ ...quietButton, width: "100%", textAlign: "left" }}
                onClick={() => onOpen?.(question.id)}
              >
                <strong>{question.title}</strong>
                <p>{question.preview}</p>
                <small>
                  {statusChip(lang, question.status)}
                  {` · ${t(qaCountKey("votes", question.upvoteCount), { count: question.upvoteCount ?? 0 })}`}
                  {` · ${t(qaCountKey("replies", question.replyCount), { count: question.replyCount ?? 0 })}`}
                </small>
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
