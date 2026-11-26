import { useRoutedTab, RoutedTabLink } from "../components/WorkspacePages.jsx";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Check,
  ChevronRight,
  Download,
  Play,
  Plus,
  Radio,
  Send,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Users,
} from "lucide-react";
import {
  clampPrivacyThreshold,
  VOICE_PRIVACY_FLOOR,
  exportVoiceReport,
  prioritizeWeeklyQuestions,
  readDemoVoiceState,
  resultReadiness,
  selectWeightedWeeklyQuestion,
  voiceJoinedOptions,
  voiceLabel,
  voiceText,
  writeDemoVoiceState,
} from "../lib/demoVoiceParity.js";
import { t as translate } from "../lib/i18n.js";
import { useVoiceLiveNotice } from "../lib/voiceLiveNotice.js";
import { ChartArrival, arriveAt } from "./ChartArrival.jsx";

const TABS = ["surveys", "operations", "weekly", "live", "insights"];
// The `value` is the stored draft token — branching, the options field, and
// saved drafts all compare against it, so it never changes with the language.
// `labelKey` is the only half the reader sees, so it goes through the
// catalogue instead of showing the raw token
// (UX-UG-VOICE-STUDIO-QUESTION-TYPE-OPTIONS-RAW-TOKENS-20260920).
const QUESTION_TYPES = [
  { value: "text", labelKey: "voiceDemo.questionType.text" },
  { value: "radio", labelKey: "voiceDemo.questionType.radio" },
  { value: "checkbox", labelKey: "voiceDemo.questionType.checkbox" },
  { value: "dropdown", labelKey: "voiceDemo.questionType.dropdown" },
  { value: "scale", labelKey: "voiceDemo.questionType.scale" },
  { value: "yes/no", labelKey: "voiceDemo.questionType.yesNo" },
];

function firstCommaOption(options) {
  return options.split(",")[0].trim();
}

function newSurveyDraft(lang) {
  const q1Options = translate(lang, "voiceDemo.seedIssueFirstOptions");
  return {
    title: "",
    owner: "Sam Okafor",
    kind: "general",
    sections: [
      {
        id: "section-1",
        title: translate(lang, "voiceDemo.seedMemberPriorities"),
        questions: [
          {
            id: "draft-q1",
            prompt: translate(lang, "voiceDemo.seedIssueFirstPrompt"),
            type: "radio",
            required: true,
            options: q1Options,
          },
          {
            id: "draft-q2",
            prompt: translate(lang, "voiceDemo.seedTellUsMore"),
            type: "text",
            required: false,
            branchQuestion: "draft-q1",
            branchValue: firstCommaOption(q1Options),
          },
        ],
      },
    ],
  };
}

function StudioButton({ children, primary = false, ...props }) {
  return (
    <button
      type="button"
      className={primary ? "voice-demo-primary" : "voice-demo-secondary"}
      {...props}
    >
      {children}
    </button>
  );
}

export function DemoVoiceStudio({ lang = "en" }) {
  const [state, setState] = useState(readDemoVoiceState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const [tab, setTab] = useRoutedTab("studio", "surveys");
  const { notice, publishNotice } = useVoiceLiveNotice();
  const [draft, setDraft] = useState(null);
  const [selectedSurveyId, setSelectedSurveyId] = useState("survey-quarterly");
  const [readiness, setReadiness] = useState({
    audience: true,
    translations: true,
    threshold: true,
    owner: true,
  });
  const [reportRange, setReportRange] = useState("quarter");
  const [operationTasks, setOperationTasks] = useState([
    { id: "task-owner", label: "Owner review", done: true },
    {
      id: "task-followup",
      label: "Follow up on flagged responses",
      done: false,
    },
    { id: "task-close", label: "Prepare close report", done: false },
  ]);
  const selectedSurvey =
    state.surveys.find((survey) => survey.id === selectedSurveyId) ||
    state.surveys[0];

  useEffect(() => {
    const sync = (event) => setState(event.detail);
    window.addEventListener("unionground:demo-voice-change", sync);
    return () =>
      window.removeEventListener("unionground:demo-voice-change", sync);
  }, []);

  // The countdown owns one interval for the whole live window. Only the poll
  // status is a dependency: depending on secondsRemaining tore the interval
  // down and armed a new one on every tick, so the clock drifted by the
  // re-arm latency once per second. The tick reads the current seconds from
  // the state ref and persists outside any setState updater, and the closing
  // tick flips the status, which is what clears the interval.
  useEffect(() => {
    if (state.livePoll.status !== "live") return undefined;
    const timer = window.setInterval(() => {
      const current = stateRef.current;
      if (current.livePoll.status !== "live") return;
      const nextSeconds = Math.max(0, current.livePoll.secondsRemaining - 1);
      const next = {
        ...current,
        livePoll: {
          ...current.livePoll,
          secondsRemaining: nextSeconds,
          status: nextSeconds === 0 ? "closed" : "live",
        },
      };
      stateRef.current = next;
      setState(next);
      writeDemoVoiceState(next);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.livePoll.status]);

  const commit = (update, message = "") => {
    const next =
      typeof update === "function" ? update(stateRef.current) : update;
    stateRef.current = next;
    setState(next);
    writeDemoVoiceState(next);
    publishNotice(message);
  };

  const draftQuestionCount = useMemo(
    () =>
      draft?.sections.reduce(
        (count, section) => count + section.questions.length,
        0,
      ) || 0,
    [draft],
  );
  const distributionReady = Object.values(readiness).every(Boolean);
  const report = resultReadiness(selectedSurvey, reportRange);
  const checkedIn = state.livePoll.roster.filter(
    (person) => person.checkedIn,
  ).length;
  const totalVotes = state.livePoll.votes.reduce(
    (sum, count) => sum + count,
    0,
  );
  // Ballot content locks once any vote exists, whatever the status (Lovable
  // audit APP-STEWARD-07): a prompt or option edited beside cast votes would
  // change what those votes mean.
  const livePollRunning = ["live", "archived"].includes(state.livePoll.status);
  const livePollLocked = livePollRunning || totalVotes > 0;

  const updateDraftQuestion = (sectionId, questionId, fields) =>
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              questions: section.questions.map((question) =>
                question.id === questionId
                  ? { ...question, ...fields }
                  : question,
              ),
            }
          : section,
      ),
    }));
  const addQuestion = (sectionId) =>
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              questions: [
                ...section.questions,
                {
                  id: `draft-q${Date.now()}`,
                  prompt: "",
                  type: "text",
                  required: false,
                  options: "",
                },
              ],
            }
          : section,
      ),
    }));
  const saveDraft = () => {
    if (!draft?.title.trim() || draftQuestionCount < 1) return;
    const questions = draft.sections.reduce(
      (count, section) => count + section.questions.length,
      0,
    );
    commit(
      (current) => ({
        ...current,
        surveys: [
          ...current.surveys,
          {
            id: `survey-${Date.now()}`,
            title: draft.title.trim(),
            kind: draft.kind,
            state: "draft",
            owner: draft.owner,
            questions,
            sections: draft.sections.length,
            responses: 0,
            rangeResponses: { quarter: 0, year: 0, all: 0 },
            audience: 313,
            threshold: VOICE_PRIVACY_FLOOR,
            distributed: false,
            reminderCount: 0,
          },
        ],
      }),
      translate(lang, "voiceDemo.surveyDraftSavedToTheSample"),
    );
    setDraft(null);
  };

  const aiDraft = () => {
    const aiQ1Options = translate(lang, "voiceDemo.aiSafetyQ1Options");
    setDraft({
      ...newSurveyDraft(lang),
      title: translate(lang, "voiceDemo.aiSafetyTitle"),
      kind: "general",
      sections: [
        {
          id: "section-ai",
          title: translate(lang, "voiceDemo.aiSafetySection"),
          questions: [
            {
              id: "ai-q1",
              prompt: translate(lang, "voiceDemo.aiSafetyQ1Prompt"),
              type: "radio",
              required: true,
              options: aiQ1Options,
            },
            {
              id: "ai-q2",
              prompt: translate(lang, "voiceDemo.aiSafetyQ2Prompt"),
              type: "dropdown",
              required: true,
              options: translate(lang, "voiceDemo.aiSafetyQ2Options"),
            },
            {
              id: "ai-q3",
              prompt: translate(lang, "voiceDemo.aiSafetyQ3Prompt"),
              type: "text",
              required: false,
              options: "",
              branchQuestion: "ai-q1",
              branchValue: firstCommaOption(aiQ1Options),
            },
          ],
        },
      ],
    });
    publishNotice(
      translate(lang, "voiceDemo.compassCreatedAStructuredDraftReview"),
    );
  };

  const moveResponse = (lane, index) => {
    const order = ["first", "ready", "followup"];
    const nextLane = order[Math.min(order.indexOf(lane) + 1, order.length - 1)];
    if (nextLane === lane) return;
    commit(
      (current) => {
        const item = current.responseLanes[lane][index];
        return {
          ...current,
          responseLanes: {
            ...current.responseLanes,
            [lane]: current.responseLanes[lane].filter((_, at) => at !== index),
            [nextLane]: [...current.responseLanes[nextLane], item],
          },
        };
      },
      translate(lang, "voiceDemo.responseMovedToTheNextReview"),
    );
  };

  const updateSurvey = (fields, message = "") =>
    commit(
      (current) => ({
        ...current,
        surveys: current.surveys.map((survey) =>
          survey.id === selectedSurvey.id ? { ...survey, ...fields } : survey,
        ),
      }),
      message,
    );
  const updateWeekly = (id, fields, message) =>
    commit(
      (current) => ({
        ...current,
        weeklyQuestions: current.weeklyQuestions.map((question) =>
          question.id === id ? { ...question, ...fields } : question,
        ),
      }),
      message,
    );
  const prioritizeWeekly = (id, message) =>
    commit(
      (current) => ({
        ...current,
        weeklyQuestions: prioritizeWeeklyQuestions(current.weeklyQuestions, id),
      }),
      message,
    );
  const updateLive = (fields, message = "") =>
    commit(
      (current) => ({
        ...current,
        livePoll: { ...current.livePoll, ...fields },
      }),
      message,
    );
  const draftLivePoll = () =>
    updateLive(
      {
        title: translate(lang, "voiceDemo.livePollDraftTitle"),
        options: [
          translate(lang, "voiceDemo.livePollOptionStaffing"),
          translate(lang, "voiceDemo.livePollOptionScheduling"),
          translate(lang, "voiceDemo.livePollOptionPay"),
        ],
        votes: [0, 0, 0],
        status: "scheduled",
        secondsRemaining: 120,
      },
      translate(lang, "voiceDemo.compassDraftedAMeetingPollAnd"),
    );

  return (
    <section
      className="voice-demo-studio"
      aria-labelledby="voice-demo-studio-title"
      data-voice-capabilities="CR-003 CR-004 CR-005 CR-006 CR-007 CR-008 CR-009 CR-010 CR-013 CR-015 CR-016 CR-017 CR-019"
    >
      <div className="voice-demo-section-head">
        <div>
          <p className="voice-demo-kicker">
            {translate(lang, "voiceDemo.voiceOperations")}
          </p>
          <h2 id="voice-demo-studio-title">
            {translate(lang, "voiceDemo.surveyAndMeetingStudio")}
          </h2>
          <p>
            {translate(lang, "voiceDemo.prepareDistributeReviewAndReportWithout")}
          </p>
        </div>
        <span className="voice-demo-preview-chip">
          {translate(lang, "voiceDemo.sampleControls")}
        </span>
      </div>
      <div
        className="voice-demo-tabs"
        role="group"
        aria-label={translate(lang, "voiceDemo.voiceStudioSections")}
      >
        {TABS.map((key) => (
          <RoutedTabLink group="studio" value={key}
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            {translate(lang, `voiceDemo.tab.${key}`)}
          </RoutedTabLink>
        ))}
      </div>

      {tab === "surveys" && (
        <div className="voice-demo-studio-grid">
          <section
            className="voice-demo-panel"
            aria-labelledby="voice-demo-registry-title"
          >
            <div className="voice-demo-section-head">
              <div>
                <p className="voice-demo-kicker">
                  {translate(lang, "voiceDemo.reusableInstruments")}
                </p>
                <h3 id="voice-demo-registry-title">
                  {translate(lang, "voiceDemo.surveyRegistry")}
                </h3>
              </div>
              <StudioButton primary onClick={() => setDraft(newSurveyDraft(lang))}>
                <Plus size={16} />
                {translate(lang, "voiceDemo.newSurvey")}
              </StudioButton>
            </div>
            <div className="voice-demo-survey-list">
              {state.surveys.map((survey) => (
                <article key={survey.id}>
                  <div>
                    <span
                      className={`voice-demo-status${survey.state === "active" ? " voice-demo-status--success" : ""}`}
                    >
                      {voiceLabel(survey.state, lang)}
                    </span>
                    <h4>{survey.title}</h4>
                    <p>
                      {voiceLabel(survey.kind, lang)} · {survey.sections}{" "}
                      {translate(lang, "voiceDemo.sections")} · {survey.questions}{" "}
                      {translate(lang, "voiceDemo.questions")}
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>{translate(lang, "voiceDemo.owner")}</dt>
                      <dd>{survey.owner}</dd>
                    </div>
                    <div>
                      <dt>{translate(lang, "voiceDemo.responses")}</dt>
                      <dd>{survey.responses}</dd>
                    </div>
                  </dl>
                  <StudioButton
                    onClick={() => {
                      setSelectedSurveyId(survey.id);
                      setTab("operations");
                    }}
                  >
                    {translate(lang, "voiceDemo.openOperations")}
                    <ChevronRight size={16} />
                  </StudioButton>
                </article>
              ))}
            </div>
          </section>
          <section className="voice-demo-panel voice-demo-ai-card">
            <Sparkles size={22} aria-hidden="true" />
            <div>
              <p className="voice-demo-kicker">Guide</p>
              <h3>
                {translate(lang, "voiceDemo.startFromAnApprovedDraft")}
              </h3>
              <p>
                {translate(lang, "voiceDemo.describeTheIntentThenReviewThe")}
              </p>
            </div>
            <StudioButton primary onClick={aiDraft}>
              {translate(lang, "voiceDemo.draftASafetySurvey")}
            </StudioButton>
          </section>
        </div>
      )}

      {tab === "surveys" && draft && (
        <section
          className="voice-demo-builder"
          aria-labelledby="voice-demo-builder-title"
        >
          <header>
            <div>
              <p className="voice-demo-kicker">
                {translate(lang, "voiceDemo.draftEditor")}
              </p>
              <h3 id="voice-demo-builder-title">
                {draft.title ||
                  translate(lang, "voiceDemo.untitledSurvey")}
              </h3>
            </div>
            <span>
              {draftQuestionCount} {translate(lang, "voiceDemo.questions")}
            </span>
          </header>
          <div className="voice-demo-builder-meta">
            <label className="voice-demo-field">
              <span>{translate(lang, "voiceDemo.surveyTitle")}</span>
              <input
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
              />
            </label>
            <label className="voice-demo-field">
              <span>{translate(lang, "voiceDemo.owner")}</span>
              <select
                value={draft.owner}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    owner: event.target.value,
                  }))
                }
              >
                <option>Sam Okafor</option>
                <option>Taylor Brooks</option>
                <option>Priya Nair</option>
              </select>
            </label>
            <label className="voice-demo-field">
              <span>{translate(lang, "voiceDemo.instrument")}</span>
              <select
                value={draft.kind}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    kind: event.target.value,
                  }))
                }
              >
                <option value="general">
                  {translate(lang, "voiceDemo.generalSurvey")}
                </option>
                <option value="quarterly">
                  {translate(lang, "voiceDemo.quarterlyTemplate")}
                </option>
              </select>
            </label>
          </div>
          {draft.sections.map((section, sectionIndex) => (
            <section className="voice-demo-builder-section" key={section.id}>
              <label className="voice-demo-field">
                <span>
                  {translate(lang, "voiceDemo.sectionN", { n: sectionIndex + 1 })}
                </span>
                <input
                  value={section.title}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      sections: current.sections.map((item) =>
                        item.id === section.id
                          ? { ...item, title: event.target.value }
                          : item,
                      ),
                    }))
                  }
                />
              </label>
              {section.questions.map((question, index) => (
                <article key={question.id}>
                  <span className="voice-demo-question-number">
                    {index + 1}
                  </span>
                  <label className="voice-demo-field voice-demo-field--grow">
                    <span>{translate(lang, "voiceDemo.question")}</span>
                    <input
                      value={question.prompt}
                      onChange={(event) =>
                        updateDraftQuestion(section.id, question.id, {
                          prompt: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="voice-demo-field">
                    <span>{translate(lang, "voiceDemo.type")}</span>
                    <select
                      value={question.type}
                      onChange={(event) =>
                        updateDraftQuestion(section.id, question.id, {
                          type: event.target.value,
                        })
                      }
                    >
                      {QUESTION_TYPES.map(({ value, labelKey }) => (
                        <option key={value} value={value}>
                          {translate(lang, labelKey)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="voice-demo-check">
                    <input
                      type="checkbox"
                      checked={question.required}
                      onChange={(event) =>
                        updateDraftQuestion(section.id, question.id, {
                          required: event.target.checked,
                        })
                      }
                    />
                    {translate(lang, "voiceDemo.required")}
                  </label>
                  {!["text", "scale", "yes/no"].includes(question.type) && (
                    <label className="voice-demo-field voice-demo-field--wide">
                      <span>
                        {translate(lang, "voiceDemo.optionsSeparatedByCommas")}
                      </span>
                      <input
                        value={question.options || ""}
                        onChange={(event) =>
                          updateDraftQuestion(section.id, question.id, {
                            options: event.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                  <label className="voice-demo-field">
                    <span>{translate(lang, "voiceDemo.showAfter")}</span>
                    <select
                      value={question.branchQuestion || ""}
                      onChange={(event) =>
                        updateDraftQuestion(section.id, question.id, {
                          branchQuestion: event.target.value,
                        })
                      }
                    >
                      <option value="">{translate(lang, "voiceDemo.always")}</option>
                      {section.questions.slice(0, index).map((prior) => (
                        <option key={prior.id} value={prior.id}>
                          {prior.prompt || prior.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {question.branchQuestion && (
                    <label className="voice-demo-field">
                      <span>
                        {translate(lang, "voiceDemo.whenAnswerIs")}
                      </span>
                      <input
                        value={question.branchValue || ""}
                        onChange={(event) =>
                          updateDraftQuestion(section.id, question.id, {
                            branchValue: event.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                </article>
              ))}
              <StudioButton onClick={() => addQuestion(section.id)}>
                <Plus size={16} />
                {translate(lang, "voiceDemo.addQuestion")}
              </StudioButton>
            </section>
          ))}
          <div className="voice-demo-actions">
            <StudioButton
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  sections: [
                    ...current.sections,
                    {
                      id: `section-${Date.now()}`,
                      title: translate(lang, "voiceDemo.newSection"),
                      questions: [],
                    },
                  ],
                }))
              }
            >
              <Plus size={16} />
              {translate(lang, "voiceDemo.addSection")}
            </StudioButton>
            <StudioButton onClick={() => setDraft(null)}>
              {translate(lang, "voiceDemo.cancel")}
            </StudioButton>
            <StudioButton
              primary
              disabled={!draft.title.trim() || draftQuestionCount < 1}
              onClick={saveDraft}
            >
              {translate(lang, "voiceDemo.saveDraft")}
            </StudioButton>
          </div>
        </section>
      )}

      {tab === "operations" && (
        <div className="voice-demo-operations">
          <section className="voice-demo-panel">
            <div className="voice-demo-section-head">
              <div>
                <p className="voice-demo-kicker">
                  {translate(lang, "voiceDemo.selectedSurvey")}
                </p>
                <h3>{selectedSurvey.title}</h3>
              </div>
              <select
                aria-label={translate(lang, "voiceDemo.selectSurvey")}
                value={selectedSurvey.id}
                onChange={(event) => setSelectedSurveyId(event.target.value)}
              >
                {state.surveys.map((survey) => (
                  <option key={survey.id} value={survey.id}>
                    {survey.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="voice-demo-operation-grid">
              <label className="voice-demo-field">
                <span>
                  {translate(lang, "voiceDemo.assignedOwner")}
                </span>
                <select
                  value={selectedSurvey.owner}
                  onChange={(event) =>
                    updateSurvey(
                      { owner: event.target.value },
                      translate(lang, "voiceDemo.surveyOwnerReassigned"),
                    )
                  }
                >
                  <option>Sam Okafor</option>
                  <option>Taylor Brooks</option>
                  <option>Priya Nair</option>
                </select>
              </label>
              <div className="voice-demo-readiness">
                <h4>
                  {translate(lang, "voiceDemo.distributionReadiness")}
                </h4>
                {Object.entries(readiness).map(([key, checked]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) =>
                        setReadiness((current) => ({
                          ...current,
                          [key]: event.target.checked,
                        }))
                      }
                    />
                    {translate(lang, `voiceDemo.readiness.${key}`)}
                  </label>
                ))}
              </div>
              <div className="voice-demo-distribution">
                <h4>
                  {translate(lang, "voiceDemo.distributionHistory")}
                </h4>
                <p>
                  {selectedSurvey.distributed
                    ? translate(lang, "voiceDemo.sentToAudience", { audience: selectedSurvey.audience, reminders: selectedSurvey.reminderCount })
                    : translate(lang, "voiceDemo.notDistributedYet")}
                </p>
                <div className="voice-demo-actions">
                  <StudioButton
                    primary
                    disabled={!distributionReady || selectedSurvey.distributed}
                    onClick={() =>
                      updateSurvey(
                        { distributed: true, state: "active" },
                        translate(lang, "voiceDemo.surveyDistributedToTheSampleAudience"),
                      )
                    }
                  >
                    <Send size={16} />
                    {translate(lang, "voiceDemo.distribute")}
                  </StudioButton>
                  <StudioButton
                    disabled={!selectedSurvey.distributed}
                    onClick={() =>
                      updateSurvey(
                        { reminderCount: selectedSurvey.reminderCount + 1 },
                        translate(lang, "voiceDemo.reminderRunRecordedIncompleteCoverageIs"),
                      )
                    }
                  >
                    {translate(lang, "voiceDemo.sendReminder")}
                  </StudioButton>
                  <StudioButton
                    disabled={selectedSurvey.state !== "active"}
                    onClick={() =>
                      updateSurvey(
                        { state: "closed" },
                        translate(lang, "voiceDemo.surveyDeactivatedAndMovedToReporting"),
                      )
                    }
                  >
                    {translate(lang, "voiceDemo.deactivate")}
                  </StudioButton>
                </div>
              </div>
            </div>
            <div className="voice-demo-task-strip">
              <h4>
                {translate(lang, "voiceDemo.generatedReviewWork")}
              </h4>
              {operationTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  aria-pressed={task.done}
                  onClick={() =>
                    setOperationTasks((current) =>
                      current.map((item) =>
                        item.id === task.id
                          ? { ...item, done: !item.done }
                          : item,
                      ),
                    )
                  }
                >
                  <span>{task.done ? <Check size={15} /> : null}</span>
                  {translate(lang, {
                    "Owner review": "voiceDemo.task.ownerReview",
                    "Follow up on flagged responses": "voiceDemo.task.followUpFlagged",
                    "Prepare close report": "voiceDemo.task.prepareCloseReport",
                  }[task.label])}
                </button>
              ))}
            </div>
          </section>
          <section className="voice-demo-panel">
            <div className="voice-demo-section-head">
              <div>
                <p className="voice-demo-kicker">
                  {translate(lang, "voiceDemo.humanResponseReview")}
                </p>
                <h3>{translate(lang, "voiceDemo.responseLanes")}</h3>
              </div>
              <span>
                {Object.values(state.responseLanes).flat().length}{" "}
                {translate(lang, "voiceDemo.flagged")}
              </span>
            </div>
            <div className="voice-demo-lanes">
              {[
                ["first", translate(lang, "voiceDemo.firstResponse")],
                ["ready", translate(lang, "voiceDemo.reviewReady")],
                ["followup", translate(lang, "voiceDemo.followUp")],
              ].map(([key, label]) => (
                <section key={key}>
                  <h4>
                    {label}
                    <span>{state.responseLanes[key].length}</span>
                  </h4>
                  {state.responseLanes[key].map((item, index) => (
                    <article key={item.id}>
                      <strong>{item.label}</strong>
                      <p>{item.issue}</p>
                      <small>{item.age}</small>
                      {key !== "followup" && (
                        <StudioButton onClick={() => moveResponse(key, index)}>
                          {translate(lang, "voiceDemo.moveForward")}
                          <ChevronRight size={15} />
                        </StudioButton>
                      )}
                    </article>
                  ))}
                </section>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "weekly" && (
        <section className="voice-demo-panel">
          <div className="voice-demo-section-head">
            <div>
              <p className="voice-demo-kicker">
                {translate(lang, "voiceDemo.governedWeeklyCadence")}
              </p>
              <h3>
                {translate(lang, "voiceDemo.questionPoolAndPrioritySlot")}
              </h3>
            </div>
            <StudioButton
              disabled={
                !state.weeklyQuestions.some(
                  (item) =>
                    !["priority", "published", "rejected"].includes(item.state),
                )
              }
              onClick={() => {
                const chosen = selectWeightedWeeklyQuestion(
                  state.weeklyQuestions,
                );
                if (chosen)
                  prioritizeWeekly(
                    chosen.id,
                    translate(lang, "voiceDemo.weightedChose", {
                      body: voiceText(chosen.body, lang),
                    }),
                  );
              }}
            >
              <Sparkles size={16} />
              {translate(lang, "voiceDemo.runWeightedSelection")}
            </StudioButton>
          </div>
          <div className="voice-demo-weekly-admin">
            {state.weeklyQuestions.map((question) => (
              <article key={question.id}>
                <div>
                  <span
                    className={`voice-demo-status${question.state === "priority" ? " voice-demo-status--success" : ""}`}
                  >
                    {voiceLabel(question.state, lang)}
                  </span>
                  <h4>{voiceText(question.body, lang)}</h4>
                  <p>
                    {voiceJoinedOptions(question.options, lang)} · {question.score}{" "}
                    {translate(lang, "voiceDemo.support2")}
                  </p>
                </div>
                <div className="voice-demo-actions">
                  <StudioButton
                    onClick={() =>
                      updateWeekly(
                        question.id,
                        { state: "reserved" },
                        translate(lang, "voiceDemo.questionReservedForEditorialReview"),
                      )
                    }
                  >
                    {translate(lang, "voiceDemo.reserve")}
                  </StudioButton>
                  <StudioButton
                    onClick={() =>
                      prioritizeWeekly(
                        question.id,
                        translate(lang, "voiceDemo.questionMovedIntoThePrioritySlot"),
                      )
                    }
                  >
                    {translate(lang, "voiceDemo.prioritize")}
                  </StudioButton>
                  <StudioButton
                    primary
                    onClick={() =>
                      updateWeekly(
                        question.id,
                        { state: "published" },
                        translate(lang, "voiceDemo.questionPublishedAsTheNextSample"),
                      )
                    }
                  >
                    {translate(lang, "voiceDemo.publish")}
                  </StudioButton>
                  <StudioButton
                    onClick={() =>
                      updateWeekly(
                        question.id,
                        { state: "rejected" },
                        translate(lang, "voiceDemo.questionRejectedWithItsHistoryRetained"),
                      )
                    }
                  >
                    {translate(lang, "voiceDemo.reject")}
                  </StudioButton>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === "live" && (
        <div
          className={`voice-demo-live-grid${state.livePoll.projector ? " voice-demo-live-grid--projector" : ""}`}
        >
          <section className="voice-demo-panel">
            <div className="voice-demo-section-head">
              <div>
                <p className="voice-demo-kicker">
                  {translate(lang, "voiceDemo.meetingPoll")}
                </p>
                <h3>{state.livePoll.title}</h3>
              </div>
              <span
                className={`voice-demo-status${state.livePoll.status === "live" ? " voice-demo-status--live" : ""}`}
              >
                {voiceLabel(state.livePoll.status, lang)}
              </span>
            </div>
            {totalVotes > 0 && (
              <p className="voice-demo-note" role="note">
                {translate(lang, "voiceDemo.pollLockedVotes", { count: totalVotes })}
              </p>
            )}
            <div className="voice-demo-live-editor">
              <label className="voice-demo-field voice-demo-field--grow">
                <span>
                  {translate(lang, "voiceDemo.pollPrompt")}
                </span>
                <input
                  disabled={livePollLocked}
                  value={state.livePoll.title}
                  onChange={(event) =>
                    updateLive({ title: event.target.value })
                  }
                />
              </label>
              <label className="voice-demo-field">
                <span>{translate(lang, "voiceDemo.scheduledFor")}</span>
                <input
                  type="datetime-local"
                  disabled={livePollLocked}
                  value={state.livePoll.scheduledFor}
                  onChange={(event) =>
                    updateLive({ scheduledFor: event.target.value })
                  }
                />
              </label>
              {state.livePoll.options.map((option, index) => (
                <label className="voice-demo-field" key={index}>
                  <span>
                    {translate(lang, "voiceDemo.optionN", { n: index + 1 })}
                  </span>
                  <input
                    disabled={livePollLocked}
                    value={option}
                    onChange={(event) =>
                      updateLive({
                        options: state.livePoll.options.map((item, at) =>
                          at === index ? event.target.value : item,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <div className="voice-demo-actions">
                <StudioButton disabled={livePollRunning} onClick={draftLivePoll}>
                  <Sparkles size={16} />
                  {translate(lang, "voiceDemo.draftPollWithCompass")}
                </StudioButton>
                <StudioButton
                  disabled={livePollLocked}
                  onClick={() =>
                    updateLive(
                      { status: "scheduled" },
                      translate(lang, "voiceDemo.meetingPollScheduled"),
                    )
                  }
                >
                  {translate(lang, "voiceDemo.saveSchedule")}
                </StudioButton>
              </div>
            </div>
            <div className="voice-demo-live-clock">
              <Radio size={20} aria-hidden="true" />
              <strong
                role="timer"
                aria-label={translate(lang, "voiceDemo.livePollCountdown")}
              >
                {String(
                  Math.floor(state.livePoll.secondsRemaining / 60),
                ).padStart(2, "0")}
                :{String(state.livePoll.secondsRemaining % 60).padStart(2, "0")}
              </strong>
              <span>
                {totalVotes} {translate(lang, "voiceDemo.votes")}
              </span>
            </div>
            <ChartArrival name="voice-demo:live-poll" className="voice-demo-results">
              {state.livePoll.options.map((option, index) => {
                const percent = totalVotes
                  ? Math.round((state.livePoll.votes[index] / totalVotes) * 100)
                  : 0;
                return (
                  <div key={`${option}-${index}`}>
                    <span>
                      <strong>{option}</strong>
                      <b>
                        {state.livePoll.votes[index]} · {percent}%
                      </b>
                    </span>
                    <i>
                      <span className="arrive-x" style={arriveAt(index, { "--voice-result": `${percent}%` })} />
                    </i>
                  </div>
                );
              })}
            </ChartArrival>
            <div className="voice-demo-actions">
              <StudioButton
                primary
                disabled={
                  state.livePoll.status === "live" ||
                  state.livePoll.status === "archived"
                }
                onClick={() =>
                  updateLive(
                    {
                      status: "live",
                      secondsRemaining: state.livePoll.secondsRemaining || 90,
                    },
                    translate(lang, "voiceDemo.livePollActivatedResultsUpdateAs"),
                  )
                }
              >
                <Play size={16} />
                {translate(lang, "voiceDemo.activate")}
              </StudioButton>
              <StudioButton
                disabled={state.livePoll.status !== "live"}
                onClick={() =>
                  updateLive(
                    {
                      votes: state.livePoll.votes.map(
                        (count, index) =>
                          count + (index === 0 ? 2 : index === 1 ? 1 : 0),
                      ),
                    },
                    translate(lang, "voiceDemo.threeSampleVotesArrivedInReal"),
                  )
                }
              >
                {translate(lang, "voiceDemo.simulateLiveVotes")}
              </StudioButton>
              <StudioButton
                disabled={state.livePoll.status !== "live"}
                onClick={() =>
                  updateLive(
                    { status: "closed" },
                    translate(lang, "voiceDemo.pollClosedNoMoreVotesAre"),
                  )
                }
              >
                {translate(lang, "voiceDemo.close")}
              </StudioButton>
              <StudioButton
                disabled={state.livePoll.status !== "closed"}
                onClick={() =>
                  updateLive(
                    { status: "archived" },
                    translate(lang, "voiceDemo.pollArchivedWithTheMeetingRecord"),
                  )
                }
              >
                {translate(lang, "voiceDemo.archive")}
              </StudioButton>
              <StudioButton
                onClick={() =>
                  updateLive({ projector: !state.livePoll.projector })
                }
              >
                {state.livePoll.projector
                  ? translate(lang, "voiceDemo.exitProjector")
                  : translate(lang, "voiceDemo.projectorView")}
              </StudioButton>
            </div>
          </section>
          <section className="voice-demo-panel">
            <div className="voice-demo-section-head">
              <div>
                <p className="voice-demo-kicker">
                  {translate(lang, "voiceDemo.eligibilityAndAttendance")}
                </p>
                <h3>{translate(lang, "voiceDemo.meetingRoster")}</h3>
              </div>
              <span className="voice-demo-credit">
                <Users size={15} />
                {checkedIn}/{state.livePoll.roster.length}{" "}
                {translate(lang, "voiceDemo.checkedIn")}
              </span>
            </div>
            <div className="voice-demo-checkin-code">
              <span>{translate(lang, "voiceDemo.checkInCode")}</span>
              <strong>736 218</strong>
              <small>
                {translate(lang, "voiceDemo.checkInCodeShownForTheTour")}
              </small>
            </div>
            <div className="voice-demo-roster">
              {state.livePoll.roster.map((person) => (
                <article key={person.id}>
                  <div>
                    <strong>{person.name}</strong>
                    <span>
                      {translate(lang, "voiceDemo.rsvp")}:{" "}
                      {voiceLabel(person.rsvp, lang)}
                    </span>
                  </div>
                  <StudioButton
                    disabled={person.checkedIn}
                    onClick={() =>
                      commit(
                        (current) => ({
                          ...current,
                          livePoll: {
                            ...current.livePoll,
                            roster: current.livePoll.roster.map((item) =>
                              item.id === person.id
                                ? { ...item, checkedIn: true }
                                : item,
                            ),
                          },
                        }),
                        translate(lang, "voiceDemo.checkedInManually", { name: person.name }),
                      )
                    }
                  >
                    {person.checkedIn ? (
                      <>
                        <Check size={16} />
                        {translate(lang, "voiceDemo.present")}
                      </>
                    ) : (
                      <>
                        <UserCheck size={16} />
                        {translate(lang, "voiceDemo.checkIn")}
                      </>
                    )}
                  </StudioButton>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === "insights" && (
        <div className="voice-demo-insights">
          <section className="voice-demo-panel">
            <div className="voice-demo-section-head">
              <div>
                <p className="voice-demo-kicker">
                  {translate(lang, "voiceDemo.privacyAwareReporting")}
                </p>
                <h3>{selectedSurvey.title}</h3>
              </div>
              <BarChart3 size={22} aria-hidden="true" />
            </div>
            <div className="voice-demo-report-controls">
              <label className="voice-demo-field">
                <span>{translate(lang, "voiceDemo.dateRange")}</span>
                <select
                  value={reportRange}
                  onChange={(event) => setReportRange(event.target.value)}
                >
                  <option value="quarter">
                    {translate(lang, "voiceDemo.thisQuarter")}
                  </option>
                  <option value="year">
                    {translate(lang, "voiceDemo.rollingYear")}
                  </option>
                  <option value="all">
                    {translate(lang, "voiceDemo.allResponses")}
                  </option>
                </select>
              </label>
              <label className="voice-demo-field">
                <span>
                  {translate(lang, "voiceDemo.minimumGroupSize")}
                </span>
                <input
                  type="number"
                  min={VOICE_PRIVACY_FLOOR}
                  max="50"
                  value={clampPrivacyThreshold(selectedSurvey.threshold)}
                  onChange={(event) =>
                    updateSurvey({
                      threshold: clampPrivacyThreshold(event.target.value),
                    })
                  }
                />
              </label>
              <label className="voice-demo-field">
                <span>{translate(lang, "voiceDemo.survey")}</span>
                <select
                  value={selectedSurvey.id}
                  onChange={(event) => setSelectedSurveyId(event.target.value)}
                >
                  {state.surveys.map((survey) => (
                    <option value={survey.id} key={survey.id}>
                      {survey.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {report.ready ? (
              <div className="voice-demo-chart">
                <div>
                  <strong>{report.responses}</strong>
                  <span>{translate(lang, "voiceDemo.responses2")}</span>
                </div>
                <div>
                  <strong>{report.completionRate}%</strong>
                  <span>{translate(lang, "voiceDemo.completion")}</span>
                </div>
                <div>
                  <strong>{report.smallestGroup}</strong>
                  <span>
                    {translate(lang, "voiceDemo.smallestReleasedGroup")}
                  </span>
                </div>
              </div>
            ) : (
              <div className="voice-demo-withheld" role="status">
                <ShieldCheck size={22} />
                <div>
                  <strong>
                    {translate(lang, "voiceDemo.breakdownWithheld")}
                  </strong>
                  <p>
                    {translate(lang, "voiceDemo.smallestGroup", { smallest: report.smallestGroup, threshold: clampPrivacyThreshold(selectedSurvey.threshold) })}
                  </p>
                </div>
              </div>
            )}
            <div className="voice-demo-actions">
              <StudioButton
                disabled={!report.ready}
                onClick={() => {
                  exportVoiceReport(
                    "csv",
                    state,
                    selectedSurvey.id,
                    reportRange,
                  );
                  publishNotice(
                    translate(lang, "voiceDemo.csvReportDownloaded"),
                  );
                }}
              >
                <Download size={16} />
                CSV
              </StudioButton>
              <StudioButton
                disabled={!report.ready}
                onClick={() => {
                  exportVoiceReport(
                    "xlsx",
                    state,
                    selectedSurvey.id,
                    reportRange,
                  );
                  publishNotice(
                    translate(lang, "voiceDemo.spreadsheetReportDownloaded"),
                  );
                }}
              >
                <Download size={16} />
                XLSX
              </StudioButton>
              <StudioButton
                disabled={!report.ready}
                onClick={() =>
                  publishNotice(
                    translate(lang, "voiceDemo.printableReport", { range: voiceLabel(reportRange, lang) }),
                  )
                }
              >
                {translate(lang, "voiceDemo.prepareReport")}
              </StudioButton>
            </div>
          </section>
        </div>
      )}

      <p className="voice-demo-live" aria-live="polite" aria-atomic="true">
        {notice.text}
        {notice.token ? <span className="sr-only">{notice.token}</span> : null}
      </p>
    </section>
  );
}
