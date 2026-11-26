import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  MessageCircleQuestion,
  Plus,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
} from "lucide-react";
import {
  DEMO_SURVEY_SECTIONS,
  prioritizeWeeklyQuestions,
  readDemoVoiceState,
  surveySectionComplete,
  viewerAuthor,
  visibleSurveyQuestions,
  voiceAuthoredByViewer,
  voiceAuthorName,
  voiceEditedCopy,
  voiceJoinedOptions,
  voiceLabel,
  voiceOptionLabel,
  voiceText,
  writeDemoVoiceState,
} from "../lib/demoVoiceParity.js";
import { useOrganizationTranslator } from "../lib/LanguageContext.jsx";
import { BusyButton } from "./BusyControls.jsx";
import { QA_MIN_BODY_LENGTH, QA_MIN_TITLE_LENGTH } from "../features/qa/contract.js";

// The demo's own minimums (#9460 W3b-14: named on screen, never typed twice).
const DEMO_WEEKLY_MIN_LENGTH = 10;
const DEMO_WEEKLY_MIN_OPTIONS = 2;
const DEMO_REPLY_MIN_LENGTH = 4;
import { useVoiceLiveNotice } from "../lib/voiceLiveNotice.js";

function SurveyQuestion({ question, answer, onChange, lang, disabled = false }) {
  const t = useOrganizationTranslator(lang);
  const required = question.required === true;
  const label = (
    <span>
      {voiceText(question.prompt, lang)}
      {required && <span aria-hidden="true"> *</span>}
      {required && (
        <>
          {" "}
          <span className="visually-hidden">{t("voiceDemo.required")}</span>
        </>
      )}
    </span>
  );
  if (question.type === "text")
    return (
      <label className="voice-demo-field">
        {label}
        <textarea
          rows="3"
          required={required}
          value={answer || ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  if (question.type === "dropdown")
    return (
      <label className="voice-demo-field">
        {label}
        <select
          required={required}
          value={answer || ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{t("voiceDemo.chooseOne")}</option>
          {question.options.map((item) => (
            <option key={item.value} value={item.value}>
              {voiceOptionLabel(item, lang)}
            </option>
          ))}
        </select>
      </label>
    );
  if (question.type === "scale")
    return (
      <fieldset className="voice-demo-fieldset">
        <legend>{label}</legend>
        <div className="voice-demo-scale">
          {[1, 2, 3, 4, 5].map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={question.id}
                required={required}
                checked={Number(answer) === value}
                disabled={disabled}
                onChange={() => onChange(value)}
              />
              <span>{value}</span>
            </label>
          ))}
        </div>
        <div className="voice-demo-scale__ends">
          <span>{t("voiceDemo.notManageable")}</span>
          <span>{t("voiceDemo.veryManageable")}</span>
        </div>
      </fieldset>
    );
  if (question.type === "yesno")
    return (
      <fieldset className="voice-demo-fieldset">
        <legend>{label}</legend>
        <div className="voice-demo-choice-row">
          {["yes", "no"].map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={question.id}
                required={required}
                checked={answer === value}
                disabled={disabled}
                onChange={() => onChange(value)}
              />
              {voiceLabel(value, lang)}
            </label>
          ))}
        </div>
      </fieldset>
    );
  if (question.type === "checkbox")
    return (
      // Native required on each box would demand every option; the legend's
      // hidden "Required" word names the group instead.
      <fieldset className="voice-demo-fieldset">
        <legend>{label}</legend>
        <div className="voice-demo-choice-grid">
          {question.options.map((item) => (
            <label key={item.value}>
              <input
                type="checkbox"
                checked={(answer || []).includes(item.value)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...(answer || []), item.value]
                      : (answer || []).filter((value) => value !== item.value),
                  )
                }
              />
              {voiceOptionLabel(item, lang)}
            </label>
          ))}
        </div>
      </fieldset>
    );
  return (
    <fieldset className="voice-demo-fieldset">
      <legend>{label}</legend>
      <div className="voice-demo-choice-grid">
        {question.options.map((item) => (
          <label key={item.value}>
            <input
              type="radio"
              name={question.id}
              required={required}
              checked={answer === item.value}
              disabled={disabled}
              onChange={() => onChange(item.value)}
            />
            {voiceOptionLabel(item, lang)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function quarterlyWorkloadScore(answers) {
  for (const section of DEMO_SURVEY_SECTIONS) {
    const question = visibleSurveyQuestions(section, {}).find(
      (item) => item.type === "scale",
    );
    if (!question) continue;
    const value = Number(answers?.[question.id]);
    if (Number.isInteger(value) && value >= 1 && value <= 5) return value;
  }
  return null;
}

function quarterlyPrioritiesCount(answers) {
  for (const section of DEMO_SURVEY_SECTIONS) {
    const question = visibleSurveyQuestions(section, {}).find(
      (item) => item.type === "checkbox",
    );
    if (!question) continue;
    const value = answers?.[question.id];
    if (Array.isArray(value)) return value.length;
  }
  return null;
}

const INSIGHT_UNAVAILABLE = "\u2014";

export function DemoVoiceMember({ lang = "en", showWeeklyFacade = true }) {
  const t = useOrganizationTranslator(lang);
  const [state, setState] = useState(readDemoVoiceState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [qaSearch, setQaSearch] = useState("");
  const qaSearchRef = useRef(null);
  const [qaDraft, setQaDraft] = useState("");
  const [qaBody, setQaBody] = useState("");
  const [qaEditing, setQaEditing] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState({});
  const [weeklyDraft, setWeeklyDraft] = useState("");
  const [weeklyOptions, setWeeklyOptions] = useState(["", ""]);
  const { notice, publishNotice } = useVoiceLiveNotice();

  useEffect(() => {
    const sync = (event) => setState(event.detail);
    window.addEventListener("unionground:demo-voice-change", sync);
    return () =>
      window.removeEventListener("unionground:demo-voice-change", sync);
  }, []);

  const commit = (update, message = "") => {
    const next =
      typeof update === "function" ? update(stateRef.current) : update;
    stateRef.current = next;
    setState(next);
    writeDemoVoiceState(next);
    publishNotice(message);
  };

  const quarterly = state.quarterly;
  const section = DEMO_SURVEY_SECTIONS[quarterly.currentSection];
  const questions = visibleSurveyQuestions(section, quarterly.answers);
  const canContinue = surveySectionComplete(section, quarterly.answers);
  const workloadScore = quarterlyWorkloadScore(quarterly.answers);
  const prioritiesCount = quarterlyPrioritiesCount(quarterly.answers);
  const progress = quarterly.completed
    ? 100
    : Math.round(
        (quarterly.currentSection / DEMO_SURVEY_SECTIONS.length) * 100,
      );
  const filteredQa = useMemo(
    () =>
      state.qa.filter((item) =>
        `${voiceText(item.title, lang)} ${voiceText(item.body, lang)}`
          .toLowerCase()
          .includes(qaSearch.toLowerCase()),
      ),
    [state.qa, qaSearch, lang],
  );

  const answerQuestion = (id, value) =>
    commit((current) =>
      current.quarterly.completed
        ? current
        : {
            ...current,
            quarterly: {
              ...current.quarterly,
              answers: { ...current.quarterly.answers, [id]: value },
            },
          },
    );
  const continueSurvey = () => {
    if (!canContinue) return;
    if (quarterly.currentSection < DEMO_SURVEY_SECTIONS.length - 1) {
      commit(
        (current) => ({
          ...current,
          quarterly: {
            ...current.quarterly,
            currentSection: current.quarterly.currentSection + 1,
          },
        }),
        // A submitted check-in is read-only: paging through it saves nothing.
        quarterly.completed ? "" : t("voiceDemo.progressSavedInThisPreview"),
      );
      return;
    }
    if (quarterly.completed) {
      setSurveyOpen(false);
      return;
    }
    commit(
      (current) => ({
        ...current,
        quarterly: {
          ...current.quarterly,
          completed: true,
          submittedAt: new Date().toISOString(),
        },
      }),
      t("voiceDemo.quarterlyCheckInSubmittedYourPersonal"),
    );
    setSurveyOpen(false);
  };

  const supportWeekly = (id) => {
    const item = state.weeklyQuestions.find((question) => question.id === id);
    if (!item) return;
    commit(
      (current) => ({
        ...current,
        weeklyQuestions: current.weeklyQuestions.map((question) =>
          question.id === id
            ? {
                ...question,
                supported: !question.supported,
                score: question.score + (question.supported ? -1 : 1),
              }
            : question,
        ),
      }),
      t(item.supported ? "voiceDemo.supportRemoved" : "voiceDemo.supportAdded",
      ),
    );
  };
  const promoteWeekly = (id) => {
    if (state.promotionCredits < 1) return;
    commit(
      (current) => ({
        ...current,
        promotionCredits: current.promotionCredits - 1,
        weeklyQuestions: prioritizeWeeklyQuestions(
          current.weeklyQuestions.map((item) =>
            item.id === id ? { ...item, promoted: true } : item,
          ),
          id,
        ),
      }),
      t("voiceDemo.promotionUsedThisQuestionIsNow"),
    );
  };
  const submitWeekly = (event) => {
    event.preventDefault();
    const options = weeklyOptions
      .map((option) => option.trim())
      .filter(Boolean);
    if (weeklyDraft.trim().length < DEMO_WEEKLY_MIN_LENGTH || options.length < DEMO_WEEKLY_MIN_OPTIONS) return;
    commit(
      (current) => ({
        ...current,
        weeklyQuestions: [
          ...current.weeklyQuestions,
          {
            id: `weekly-${Date.now()}`,
            body: weeklyDraft.trim(),
            options,
            state: "pool",
            score: 1,
            supported: true,
            promoted: false,
          },
        ],
      }),
      t("voiceDemo.questionAndAnswerOptionsAddedTo"),
    );
    setWeeklyDraft("");
    setWeeklyOptions(["", ""]);
  };

  const voteQa = (questionId, replyId = null) =>
    commit((current) => ({
      ...current,
      qa: current.qa.map((question) => {
        if (question.id !== questionId) return question;
        if (!replyId)
          return {
            ...question,
            voted: !question.voted,
            votes: question.votes + (question.voted ? -1 : 1),
          };
        return {
          ...question,
          replies: question.replies.map((reply) =>
            reply.id === replyId
              ? {
                  ...reply,
                  voted: !reply.voted,
                  votes: reply.votes + (reply.voted ? -1 : 1),
                }
              : reply,
          ),
        };
      }),
    }));
  const acceptReply = (questionId, replyId) =>
    commit(
      (current) => ({
        ...current,
        qa: current.qa.map((question) =>
          question.id === questionId
            ? { ...question, status: "answered", acceptedReplyId: replyId }
            : question,
        ),
      }),
      t("voiceDemo.acceptedAnswerUpdated"),
    );
  const submitQa = (event) => {
    event.preventDefault();
    if (qaDraft.trim().length < QA_MIN_TITLE_LENGTH || qaBody.trim().length < QA_MIN_BODY_LENGTH) return;
    commit(
      (current) => ({
        ...current,
        qa: [
          {
            id: `qa-${Date.now()}`,
            title: qaDraft.trim(),
            body: qaBody.trim(),
            author: viewerAuthor(),
            votes: 0,
            voted: false,
            status: "open",
            acceptedReplyId: null,
            replies: [],
          },
          ...current.qa,
        ],
      }),
      t("voiceDemo.questionPostedToTheChapterQ"),
    );
    setQaDraft("");
    setQaBody("");
  };
  const saveQaEdit = (event) => {
    event.preventDefault();
    if (!qaEditing?.title.trim() || !qaEditing?.body.trim()) return;
    commit(
      (current) => ({
        ...current,
        qa: current.qa.map((question) =>
          question.id === qaEditing.id
            ? {
                ...question,
                title: voiceEditedCopy(
                  question.title,
                  qaEditing.title.trim(),
                  lang,
                ),
                body: voiceEditedCopy(
                  question.body,
                  qaEditing.body.trim(),
                  lang,
                ),
              }
            : question,
        ),
      }),
      t("voiceDemo.yourQuestionWasUpdated"),
    );
    setQaEditing(null);
  };
  const deleteQa = (id) =>
    commit(
      (current) => ({
        ...current,
        qa: current.qa.filter((question) => question.id !== id),
      }),
      t("voiceDemo.yourQuestionWasRemovedFromThe"),
    );
  const submitReply = (event, questionId) => {
    event.preventDefault();
    const body = replyDrafts[questionId]?.trim();
    if (!body || body.length < DEMO_REPLY_MIN_LENGTH) return;
    commit(
      (current) => ({
        ...current,
        qa: current.qa.map((question) =>
          question.id === questionId
            ? {
                ...question,
                replies: [
                  ...question.replies,
                  {
                    id: `reply-${Date.now()}`,
                    author: viewerAuthor(),
                    body,
                    votes: 0,
                    voted: false,
                  },
                ],
              }
            : question,
        ),
      }),
      t("voiceDemo.replyPosted"),
    );
    setReplyDrafts((current) => ({ ...current, [questionId]: "" }));
  };

  return (
    <section
      className="voice-demo-member"
      aria-labelledby="voice-demo-member-title"
      data-voice-capabilities="CR-001 CR-002 CR-005 CR-011 CR-012 CR-014 CR-018"
    >
      <div className="voice-demo-section-head">
        <div>
          <p className="voice-demo-kicker">
            {t("voiceDemo.memberVoice")}
          </p>
          <h2 id="voice-demo-member-title">
            {t("voiceDemo.yourFeedbackWorkspace")}
          </h2>
        </div>
        <span className="voice-demo-preview-chip">
          {t("voiceDemo.sampleInteractions")}
        </span>
      </div>

      <article
        className={`voice-demo-quarterly${quarterly.completed ? " voice-demo-quarterly--complete" : ""}`}
      >
        <div className="voice-demo-quarterly__copy">
          <span className="voice-demo-icon" aria-hidden="true">
            {quarterly.completed ? (
              <Check size={18} />
            ) : (
              <ShieldCheck size={18} />
            )}
          </span>
          <div>
            <p className="voice-demo-kicker">{quarterly.quarter}</p>
            <h3>{voiceText(quarterly.title, lang)}</h3>
            <p>
              {quarterly.completed
                ? t("voiceDemo.submittedPersonalChartsAndWorkloadTrends")
                : t("voiceDemo.completeTheConfidentialCheckInTo")}
            </p>
          </div>
        </div>
        <div
          className="voice-demo-progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={progress}
          aria-label={t("voiceDemo.percentComplete", { progress })}
        >
          <span style={{ "--voice-progress": `${progress}%` }} />
        </div>
        {quarterly.completed && (
          <div className="voice-demo-personal-insights">
            <div>
              <strong>
                {workloadScore == null
                  ? INSIGHT_UNAVAILABLE
                  : `${workloadScore}/5`}
              </strong>
              <span>{t("voiceDemo.workloadBalance")}</span>
            </div>
            <div>
              <strong>
                {prioritiesCount == null
                  ? INSIGHT_UNAVAILABLE
                  : String(prioritiesCount)}
              </strong>
              <span>
                {t("voiceDemo.prioritiesShared")}
              </span>
            </div>
            <div>
              <strong>{t("voiceDemo.private")}</strong>
              <span>
                {t("voiceDemo.memberLevelAnswers")}
              </span>
            </div>
          </div>
        )}
        <div className="voice-demo-actions">
          <span>
            {t("voiceDemo.instrumentSummary", { count: quarterly.totalQuestions, sections: DEMO_SURVEY_SECTIONS.length })}
          </span>
          <button
            type="button"
            className="voice-demo-primary"
            onClick={() => setSurveyOpen((open) => !open)}
          >
            {quarterly.completed
              ? t("voiceDemo.reviewAnswers")
              : surveyOpen
                ? t("voiceDemo.closeSurvey")
                : t("voiceDemo.continueSurvey")}
          </button>
        </div>
      </article>

      {surveyOpen && (
        <section
          className="voice-demo-survey"
          aria-labelledby="voice-demo-survey-title"
        >
          <header>
            <div>
              <p className="voice-demo-kicker">
                {t("voiceDemo.sectionOf", { current: quarterly.currentSection + 1, total: DEMO_SURVEY_SECTIONS.length })}
              </p>
              <h3 id="voice-demo-survey-title">{voiceLabel(section, lang)}</h3>
            </div>
            <span>
              {questions.length} {t("voiceDemo.shownNow")}
            </span>
          </header>
          <div className="voice-demo-question-list">
            {questions.map((question) => (
              <SurveyQuestion
                key={question.id}
                question={question}
                answer={quarterly.answers[question.id]}
                onChange={(value) => answerQuestion(question.id, value)}
                lang={lang}
                disabled={quarterly.completed}
              />
            ))}
          </div>
          <footer>
            <button
              type="button"
              className="voice-demo-secondary"
              disabled={quarterly.currentSection === 0}
              onClick={() =>
                commit((current) => ({
                  ...current,
                  quarterly: {
                    ...current.quarterly,
                    currentSection: Math.max(
                      0,
                      current.quarterly.currentSection - 1,
                    ),
                  },
                }))
              }
            >
              <ChevronLeft size={17} />
              {t("voiceDemo.back")}
            </button>
            <p>
              {t("voiceDemo.requiredQuestionsAreMarkedWithAn")}
            </p>
            <button
              type="button"
              className="voice-demo-primary"
              disabled={!canContinue}
              onClick={continueSurvey}
            >
              {quarterly.currentSection < DEMO_SURVEY_SECTIONS.length - 1
                ? t(quarterly.completed ? "voiceDemo.continueSurvey" : "voiceDemo.saveAndContinue")
                : t(quarterly.completed ? "voiceDemo.closeSurvey" : "voiceDemo.submitCheckIn")}
              <ChevronRight size={17} />
            </button>
          </footer>
        </section>
      )}

      {state.microPoll.status === "open" && (
        <aside
          className="voice-demo-micro"
          aria-labelledby="voice-demo-micro-title"
        >
          <div>
            <p className="voice-demo-kicker">
              {t("voiceDemo.quickCheck")}
            </p>
            <h3 id="voice-demo-micro-title">
              {t("voiceDemo.wasThisVoiceWorkspaceEasyTo")}
            </h3>
          </div>
          <div className="voice-demo-actions">
            {[
              { value: "yes", label: t("voiceDemo.yes") },
              { value: "mostly", label: t("voiceDemo.mostly") },
              { value: "not-yet", label: t("voiceDemo.notYet") },
            ].map((choice) => (
              <button
                key={choice.value}
                type="button"
                className="voice-demo-secondary"
                onClick={() =>
                  commit(
                    (current) => ({
                      ...current,
                      microPoll: {
                        status: "answered",
                        answer: choice.value,
                      },
                    }),
                    t("voiceDemo.thanksYourResponseWasRecordedIn"),
                  )
                }
              >
                {choice.label}
              </button>
            ))}
            <button
              type="button"
              className="voice-demo-text-button"
              onClick={() =>
                commit((current) => ({
                  ...current,
                  microPoll: { status: "dismissed", answer: null },
                }))
              }
            >
              {t("voiceDemo.notNow")}
            </button>
          </div>
        </aside>
      )}

      {showWeeklyFacade && (
        <section
          className="voice-demo-panel"
          aria-labelledby="voice-demo-weekly-title"
        >
          <div className="voice-demo-section-head">
            <div>
              <p className="voice-demo-kicker">
                {t("voiceDemo.weeklyQuestionPool")}
              </p>
              <h3 id="voice-demo-weekly-title">
                {t("voiceDemo.helpChooseTheNextPoll")}
              </h3>
            </div>
            <span className="voice-demo-credit">
              <Sparkles size={15} />
              {state.promotionCredits}{" "}
              {t(state.promotionCredits === 1 ? "voiceDemo.promotionCredit" : "voiceDemo.promotionCredits")}
            </span>
          </div>
          <form className="voice-demo-weekly-form" onSubmit={submitWeekly}>
            <label className="voice-demo-field voice-demo-field--grow">
              <span>
                {t("voiceDemo.proposedWeeklyQuestion")}
              </span>
              <input
                value={weeklyDraft}
                minLength="10"
                maxLength="180"
                onChange={(event) => setWeeklyDraft(event.target.value)}
                placeholder={t("voiceDemo.askOneClearQuestion")}
              />
            </label>
            {weeklyOptions.map((option, index) => (
              <label key={index} className="voice-demo-field">
                <span>
                  {t("voiceDemo.answerOptionN", { n: index + 1 })}
                </span>
                <input
                  value={option}
                  maxLength="80"
                  onChange={(event) =>
                    setWeeklyOptions((current) =>
                      current.map((item, at) =>
                        at === index ? event.target.value : item,
                      ),
                    )
                  }
                />
              </label>
            ))}
            <button
              type="button"
              className="voice-demo-secondary"
              disabled={weeklyOptions.length >= 5}
              onClick={() => setWeeklyOptions((current) => [...current, ""])}
            >
              <Plus size={16} />
              {t("voiceDemo.addOption")}
            </button>
            <BusyButton
              type="submit"
              className="voice-demo-primary"
              disabled={
                weeklyDraft.trim().length < DEMO_WEEKLY_MIN_LENGTH ||
                weeklyOptions.filter((option) => option.trim()).length < DEMO_WEEKLY_MIN_OPTIONS
              }
              disabledReason={t("voiceDemo.weeklyNeeds", { count: DEMO_WEEKLY_MIN_LENGTH, options: DEMO_WEEKLY_MIN_OPTIONS })}
            >
              {t("voiceDemo.submitToPool")}
            </BusyButton>
          </form>
          <div className="voice-demo-weekly-list">
            {state.weeklyQuestions.map((question) => (
              <article key={question.id}>
                <div>
                  <span className="voice-demo-status">
                    {voiceLabel(question.state, lang)}
                  </span>
                  <h4>{voiceText(question.body, lang)}</h4>
                  <p>{voiceJoinedOptions(question.options, lang)}</p>
                </div>
                <div className="voice-demo-actions">
                  <button
                    type="button"
                    className="voice-demo-secondary"
                    aria-pressed={question.supported}
                    onClick={() => supportWeekly(question.id)}
                  >
                    <ThumbsUp size={16} />
                    {question.supported
                      ? t("voiceDemo.supported")
                      : t("voiceDemo.support")}{" "}
                    · {question.score}
                  </button>
                  {!question.promoted && question.state !== "priority" && (
                    <button
                      type="button"
                      className="voice-demo-primary"
                      disabled={state.promotionCredits < 1}
                      onClick={() => promoteWeekly(question.id)}
                    >
                      <Sparkles size={16} />
                      {t("voiceDemo.usePromotion")}
                    </button>
                  )}
                  {question.promoted && (
                    <span className="voice-demo-success">
                      <Check size={15} />
                      {t("voiceDemo.promoted")}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section
        className="voice-demo-panel"
        aria-labelledby="voice-demo-qa-title"
      >
        <div className="voice-demo-section-head">
          <div>
            <p className="voice-demo-kicker">
              {t("voiceDemo.chapterQA")}
            </p>
            <h3 id="voice-demo-qa-title">
              {t("voiceDemo.askOnceFindTheAnswerLater")}
            </h3>
          </div>
          <MessageCircleQuestion size={22} aria-hidden="true" />
        </div>
        <form className="voice-demo-qa-form" onSubmit={submitQa}>
          <label className="voice-demo-field">
            <span>{t("voiceDemo.questionTitle")}</span>
            <input
              value={qaDraft}
              minLength={QA_MIN_TITLE_LENGTH}
              maxLength="120"
              onChange={(event) => setQaDraft(event.target.value)}
            />
          </label>
          <label className="voice-demo-field">
            <span>{t("voiceDemo.details")}</span>
            <textarea
              rows="2"
              value={qaBody}
              minLength={QA_MIN_BODY_LENGTH}
              maxLength="500"
              onChange={(event) => setQaBody(event.target.value)}
            />
          </label>
          <BusyButton
            type="submit"
            className="voice-demo-primary"
            disabled={qaDraft.trim().length < QA_MIN_TITLE_LENGTH || qaBody.trim().length < QA_MIN_BODY_LENGTH}
            disabledReason={t("voiceDemo.qaNeeds", { title: QA_MIN_TITLE_LENGTH, body: QA_MIN_BODY_LENGTH })}
          >
            {t("voiceDemo.postQuestion")}
          </BusyButton>
        </form>
        <label className="voice-demo-search">
          <span>
            {t("voiceDemo.searchChapterQA")}
          </span>
          <input
            ref={qaSearchRef}
            type="search"
            value={qaSearch}
            onChange={(event) => setQaSearch(event.target.value)}
            placeholder={t("voiceDemo.tryOvertimeOrBreaks")}
          />
        </label>
        <div className="voice-demo-qa-list">
          {filteredQa.map((question) => (
            <article key={question.id}>
              {qaEditing?.id === question.id ? (
                <form className="voice-demo-qa-edit" onSubmit={saveQaEdit}>
                  <label className="voice-demo-field">
                    <span>
                      {t("voiceDemo.questionTitle")}
                    </span>
                    <input
                      value={qaEditing.title}
                      onChange={(event) =>
                        setQaEditing((current) => ({
                          ...current,
                          title: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="voice-demo-field">
                    <span>{t("voiceDemo.details")}</span>
                    <textarea
                      rows="2"
                      value={qaEditing.body}
                      onChange={(event) =>
                        setQaEditing((current) => ({
                          ...current,
                          body: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <div className="voice-demo-actions">
                    <button
                      type="button"
                      className="voice-demo-secondary"
                      onClick={() => setQaEditing(null)}
                    >
                      {t("voiceDemo.cancel")}
                    </button>
                    <button type="submit" className="voice-demo-primary">
                      {t("voiceDemo.saveChanges")}
                    </button>
                  </div>
                </form>
              ) : (
                <header>
                  <div>
                    <span
                      className={`voice-demo-status${question.status === "answered" ? " voice-demo-status--success" : ""}`}
                    >
                      {voiceLabel(question.status, lang)}
                    </span>
                    <h4>{voiceText(question.title, lang)}</h4>
                    <p>{voiceText(question.body, lang)}</p>
                    {voiceAuthoredByViewer(question.author) && (
                      <div className="voice-demo-actions voice-demo-actions--start">
                        <button
                          type="button"
                          className="voice-demo-text-button"
                          onClick={() =>
                            setQaEditing({
                              id: question.id,
                              title: voiceText(question.title, lang),
                              body: voiceText(question.body, lang),
                            })
                          }
                        >
                          {t("voiceDemo.edit")}
                        </button>
                        <button
                          type="button"
                          className="voice-demo-text-button"
                          onClick={() => deleteQa(question.id)}
                        >
                          {t("voiceDemo.delete")}
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="voice-demo-vote"
                    aria-pressed={question.voted}
                    // The icon is hidden and the count alone is not a name. The
                    // name stays the same when pressed: aria-pressed carries the state.
                    aria-label={t("voiceDemo.voteForQuestion", {
                      title: voiceText(question.title, lang),
                      count: question.votes,
                    })}
                    onClick={() => voteQa(question.id)}
                  >
                    <ThumbsUp size={16} />
                    {question.votes}
                  </button>
                </header>
              )}
              <div className="voice-demo-replies">
                {question.replies.map((reply) => (
                  <div
                    key={reply.id}
                    className={
                      question.acceptedReplyId === reply.id
                        ? "voice-demo-reply--accepted"
                        : ""
                    }
                  >
                    <p>
                      <strong>
                        {voiceAuthorName(
                          reply.author,
                          lang,
                          t("voiceDemo.you"),
                        )}
                      </strong>
                      {voiceText(reply.body, lang)}
                    </p>
                    <div className="voice-demo-actions">
                      <button
                        type="button"
                        className="voice-demo-text-button"
                        aria-pressed={reply.voted}
                        // Several replies share a question, so the name carries the
                        // byline author and the reply text.
                        aria-label={t("voiceDemo.voteForReply", {
                          author: voiceAuthorName(
                            reply.author,
                            lang,
                            t("voiceDemo.you"),
                          ),
                          body: voiceText(reply.body, lang),
                          count: reply.votes,
                        })}
                        onClick={() => voteQa(question.id, reply.id)}
                      >
                        {t("voiceDemo.helpful")} · {reply.votes}
                      </button>
                      {voiceAuthoredByViewer(question.author) && (
                        <button
                          type="button"
                          className="voice-demo-text-button"
                          onClick={() => acceptReply(question.id, reply.id)}
                        >
                          {question.acceptedReplyId === reply.id
                            ? t("voiceDemo.acceptedAnswer")
                            : t("voiceDemo.acceptAnswer")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="voice-demo-reply-form"
                onSubmit={(event) => submitReply(event, question.id)}
              >
                <label className="voice-demo-field">
                  <span>
                    {t("voiceDemo.replyToTitle", {
                      title: voiceText(question.title, lang),
                    })}
                  </span>
                  <input
                    value={replyDrafts[question.id] || ""}
                    minLength="4"
                    maxLength="400"
                    onChange={(event) =>
                      setReplyDrafts((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                  />
                </label>
                <BusyButton
                  type="submit"
                  className="voice-demo-secondary"
                  disabled={(replyDrafts[question.id] || "").trim().length < DEMO_REPLY_MIN_LENGTH}
                  disabledReason={t("voiceDemo.replyNeeds", { count: DEMO_REPLY_MIN_LENGTH })}
                >
                  {t("voiceDemo.postReply")}
                </BusyButton>
              </form>
            </article>
          ))}
          {/* Rendered empty from the first paint so the no-match message is
              announced when it appears, not lost to a region that mounted in
              the same update. */}
          <div className="voice-demo-qa-empty" role="status">
            {qaSearch && filteredQa.length === 0 && (
              <>
                <p>{t("voiceDemo.noQuestionsMatchSearch")}</p>
                <button
                  type="button"
                  className="voice-demo-secondary"
                  onClick={() => {
                    setQaSearch("");
                    qaSearchRef.current?.focus();
                  }}
                >
                  {t("voiceDemo.clearSearch")}
                </button>
              </>
            )}
          </div>
        </div>
      </section>
      <p className="voice-demo-live" aria-live="polite" aria-atomic="true">
        {notice.text}
        {notice.token ? <span className="sr-only">{notice.token}</span> : null}
      </p>
    </section>
  );
}
