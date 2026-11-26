import { WorksiteSurveyReport } from "../../components/WorksiteSurveyReport.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { localeFor } from "../../lib/i18n.js";
import { formatGroupMoment } from "../../lib/i18n/zonedDates.js";
import { useRoutedTab, RoutedTabLink } from "../../components/WorkspacePages.jsx";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BarChart3, Bot, ClipboardList, Mail, Radio, Settings2, Users } from "lucide-react";
import { localDateTimeInputValue } from "../../lib/localDateTime.js";
import { revealCurrentInStrip, revealFocusedInStrip } from "../../lib/stripReveal.js";
import { rpcErrorText } from "../../lib/rpcErrorText.js";
import { useModalIsolation } from "../../lib/useModalIsolation.js";
import { BusyButton, BusyInput, BusySelect } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { downloadJson, engagementApi, loadEngagementDeliveryStatus, requestPollDraft } from "./api.js";
import { downloadSurveyExport } from "./surveyExport.js";
import { SURVEY_AUTHORING_LIMITS, SURVEY_REPORT_MINIMUM, parseSurveyOptionLines, surveyDraftProblem, surveyOptionLinesText, surveySaveFailureNotice, surveySaveRefusal } from "./surveyAuthoring.js";
import { DEFAULT_PULSE_CONTEXT, PULSE_CONTEXTS, isProductPulseContext, pulseContextLabelKey } from "./contextualPulse.js";
import { ISSUE_DRAFT_PARAM, readIssueDraft } from "../issueIntelligence/model.js";
import "./engagement.css";

function statusLabel(t, state) {
  const key = `engagement.state.${state}`;
  const label = t(key);
  return label === key ? t("engagement.state.unknown") : label;
}

function taskReasonLabel(t, reason) {
  const key = `engagement.reason.${reason}`;
  const label = t(key);
  return label === key ? reason.replaceAll("_", " ") : label;
}

function surveyAnswerLabel(value) {
  if (typeof value === "string") return value.trim() || "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(surveyAnswerLabel).join(", ") : "—";
  return "—";
}

const QUARTER = `${new Date().getFullYear()}-Q${Math.floor(new Date().getMonth() / 3) + 1}`;

function newSurveyDraft(t) {
  return {
    title: "", description: "", privacyMinResponses: 3,
    cadence: "quarterly", periodKey: QUARTER,
    questions: [newSurveyQuestion(0, t)],
  };
}

function newSurveyQuestion(index, t) {
  return {
    clientKey: `question-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${index}`}`,
    type: "paragraph", label: "", required: index === 0, options: [],
    sectionKey: `section-${index + 1}`, sectionTitle: index === 0 ? t("engagement.experience") : "",
    branchParentKey: "", branchValue: "", maxSelections: null,
  };
}

function normalizeSurveyDraft(initial, t) {
  if (!initial) return newSurveyDraft(t);
  return {
    ...newSurveyDraft(t),
    ...initial,
    questions: (initial.questions || []).map((question, index) => ({
      ...newSurveyQuestion(index, t),
      ...question,
      clientKey: question.clientKey || question.id || `question-${index}`,
      branchParentKey: question.branchParentKey || "",
      options: Array.isArray(question.options) ? question.options : [],
      // The options box edits this raw text; options is parsed from it, so a
      // typed line break or space survives until the next keystroke.
      optionsText: surveyOptionLinesText(Array.isArray(question.options) ? question.options : []),
    })),
  };
}

// REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001: the rules the
// weekly selection policy accepts; weighted_random is the old app's draw.
const WEEKLY_PRIORITY_RULES = ["weighted_random", "support_then_oldest"];

function newPollDraft() {
  return {
    title: "", description: "", eligibility: "organization",
    resultsVisibility: "after_close", scheduledAt: "", opensAt: "", closesAt: "",
    quorumTarget: "", options: [{ label: "" }, { label: "" }],
  };
}

function SurveyEditor({ initial, client, chapters = [], onDone, onNotice }) {
  const { t } = useLang();
  const [draft, setDraft] = useState(() => normalizeSurveyDraft(initial, t));
  // REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: the audience and
  // the answer window were stored by the server and set by no control. The
  // window is edited in local time and sent as an instant.
  const [answerWindow, setAnswerWindow] = useState(() => ({ opens: localDateTimeValue(initial?.opensAt), closes: localDateTimeValue(initial?.closesAt) }));
  const chapterChoices = (chapters || []).filter((chapter) => chapter?.id);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const updateQuestion = (index, key, value) => set("questions", draft.questions.map((question, at) => at === index ? { ...question, [key]: value } : question));
  const updateQuestionOptions = (index, text) => set("questions", draft.questions.map((question, at) => at === index ? { ...question, optionsText: text, options: parseSurveyOptionLines(text) } : question));
  const updateQuestionType = (index, type) => setDraft((current) => {
    const changedKey = current.questions[index].clientKey;
    const remainsSelectable = !["text", "paragraph"].includes(type);
    return {
      ...current,
      questions: current.questions.map((question, at) => {
        if (at === index) {
          const options = ["text", "paragraph"].includes(type)
            ? []
            : type === "yes_no" && question.options.length !== 2 ? [] : question.options;
          return { ...question, type, options, optionsText: options === question.options ? question.optionsText : "", maxSelections: type === "checkbox" ? question.maxSelections : null };
        }
        return !remainsSelectable && question.branchParentKey === changedKey
          ? { ...question, branchParentKey: "", branchValue: "" }
          : question;
      }),
    };
  });
  const moveQuestion = (index, offset) => {
    const target = index + offset;
    if (target < 0 || target >= draft.questions.length) return;
    const questions = [...draft.questions];
    [questions[index], questions[target]] = [questions[target], questions[index]];
    set("questions", questions);
  };
  function save(event, publish = false) {
    return runBusyWrite(busyWriteRef, "survey", () => saveNow(event, publish), event);
  }

  async function saveNow(event, publish = false) {
    event.preventDefault();
    const payload = {
      ...(draft.id ? { id: draft.id } : {}),
      // The save rewrites chapter_id on every call: always send the audience
      // the editor shows (no chapter is the whole organization).
      chapterId: draft.chapterId || null,
      title: draft.title.trim(), description: draft.description.trim(),
      privacyMinResponses: Number(draft.privacyMinResponses),
      // optionsText is editor state only; options carries the parsed list.
      questions: draft.questions.map(({ optionsText: _optionsText, ...question }, sortIndex) => ({ ...question, sortIndex, label: question.label.trim() })),
    };
    // A draft the database would refuse names its question, field and reason
    // here instead of round-tripping to a bare HTTP 400.
    const problem = surveyDraftProblem(payload);
    if (problem) {
      onNotice(surveySaveFailureNotice(t, problem), true);
      return;
    }
    const windowProblem = surveyWindowProblem(answerWindow, publish);
    if (windowProblem) {
      onNotice(t(windowProblem), true);
      return;
    }
    setBusy(true);
    try {
      const operations = {
        cadence: draft.cadence,
        periodKey: draft.cadence === "quarterly" ? draft.periodKey : null,
        operationsState: publish ? "ready" : "draft",
        opensAt: isoFromLocal(answerWindow.opens),
        closesAt: isoFromLocal(answerWindow.closes),
        // Keep the owner and review date the operations form set; the RPC
        // rewrites every operations field it is given.
        ownerUserId: draft.ownerUserId || null,
        reviewDueAt: draft.reviewDueAt || null,
        readinessDueAt: draft.readinessDueAt || null,
      };
      if (publish) {
        // One atomic RPC: status and operating configuration commit or roll
        // back together, so a failure notice can never describe a survey that
        // is already live to members.
        await engagementApi.publishSurvey(client, payload, operations);
      } else {
        const saved = await engagementApi.saveSurveyDraft(client, payload);
        await engagementApi.configureSurvey(client, saved.id, operations);
      }
      onNotice(publish ? t("engagement.surveyPublished") : t("engagement.surveySaved"));
      await onDone();
    } catch (error) {
      // 23505 is the quarterly period pre-check (or the unique index itself);
      // name the conflict in catalogue copy instead of echoing the database.
      if (publish && error?.code === "23505") onNotice(t("engagement.surveyPeriodConflict", { period: draft.periodKey }), true);
      else onNotice(surveySaveFailureNotice(t, surveySaveRefusal(error)), true);
    }
    finally { setBusy(false); }
  }
  return <form className="eng-card eng-editor" onSubmit={save}>
    <div className="eng-card__head"><div><span className="eng-kicker">{t("engagement.longForm")}</span><h3>{draft.id ? t("engagement.editSurvey") : t("engagement.newSurvey")}</h3></div><button type="button" className="eng-link" onClick={onDone}>{t("engagement.cancel")}</button></div>
    <div className="eng-grid">
      <label className="eng-field"><span>{t("engagement.title")}</span><input required minLength="3" maxLength="200" value={draft.title} onChange={(event) => set("title", event.target.value)} /></label>
      <label className="eng-field"><span>{t("engagement.cadence")}</span><select value={draft.cadence} onChange={(event) => set("cadence", event.target.value)}><option value="quarterly">{t("engagement.quarterly")}</option><option value="one_off">{t("engagement.oneOff")}</option></select></label>
      {draft.cadence === "quarterly" && <label className="eng-field"><span>{t("engagement.periodKey")}</span><input required pattern="[A-Za-z0-9._:\-]+" value={draft.periodKey} onChange={(event) => set("periodKey", event.target.value)} /></label>}
      <label className="eng-field"><span>{t("engagement.privacyFloor")}</span><input type="number" min="3" max="50" value={draft.privacyMinResponses} aria-describedby="survey-editor-floor-hint" onChange={(event) => set("privacyMinResponses", event.target.value)} /></label>
      <p className="eng-field eng-field--wide eng-field__hint" id="survey-editor-floor-hint">{t("engagement.privacyFloorReportMinimum", { minimum: SURVEY_REPORT_MINIMUM })}</p>
      <label className="eng-field"><span>{t("engagement.surveyAudience")}</span><select value={draft.chapterId || ""} onChange={(event) => set("chapterId", event.target.value || null)}><option value="">{t("engagement.surveyAudienceOrganization")}</option>{chapterChoices.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name || chapter.id}</option>)}{draft.chapterId && !chapterChoices.some((chapter) => chapter.id === draft.chapterId) && <option value={draft.chapterId}>{t("engagement.surveyAudienceSavedChapter")}</option>}</select></label>
      <label className="eng-field"><span>{t("engagement.starts")}</span><input type="datetime-local" value={answerWindow.opens} onChange={(event) => setAnswerWindow((current) => ({ ...current, opens: event.target.value }))} /></label>
      <label className="eng-field"><span>{t("engagement.surveyCloses")}</span><input type="datetime-local" value={answerWindow.closes} onChange={(event) => setAnswerWindow((current) => ({ ...current, closes: event.target.value }))} /></label>
      <p className="eng-field eng-field--wide eng-field__hint">{t("engagement.surveyWindowHelp")} {t("engagement.surveyRemindersHelp")}</p>
      <label className="eng-field eng-field--wide"><span>{t("engagement.description")}</span><textarea rows="3" maxLength="4000" value={draft.description} onChange={(event) => set("description", event.target.value)} /></label>
    </div>
    <div className="eng-editor__questions"><div className="eng-card__head"><div><h4>{t("engagement.questionsSections")}</h4><p>{t("engagement.questionsHelp")}</p></div><button type="button" className="eng-btn eng-btn--quiet" onClick={() => set("questions", [...draft.questions, newSurveyQuestion(draft.questions.length, t)])}>{t("engagement.addQuestion")}</button></div>
      {draft.questions.map((question, index) => {
        const possibleParents = draft.questions.slice(0, index).filter((candidate) => ["radio", "checkbox", "dropdown", "scale", "rating", "yes_no"].includes(candidate.type));
        const parent = possibleParents.find((candidate) => candidate.clientKey === question.branchParentKey);
        const parentOptions = parent?.type === "yes_no" && !(parent.options || []).length ? ["yes", "no"] : ["scale", "rating"].includes(parent?.type) && !(parent.options || []).length ? [1, 2, 3, 4, 5] : (parent?.options || []);
        return <fieldset className="eng-question-editor" key={question.clientKey}>
        <legend>{t("engagement.questionNumber", { number: index + 1 })}</legend>
        <div className="eng-question-editor__order"><button type="button" className="eng-link" disabled={index === 0} onClick={() => moveQuestion(index, -1)}>{t("engagement.moveUp")}</button><button type="button" className="eng-link" disabled={index === draft.questions.length - 1} onClick={() => moveQuestion(index, 1)}>{t("engagement.moveDown")}</button></div>
        <label className="eng-field"><span>{t("engagement.prompt")}</span><input required maxLength="400" value={question.label} onChange={(event) => updateQuestion(index, "label", event.target.value)} /></label>
        <div className="eng-grid"><label className="eng-field"><span>{t("engagement.type")}</span><select value={question.type} onChange={(event) => updateQuestionType(index, event.target.value)}><option value="paragraph">{t("engagement.longAnswer")}</option><option value="text">{t("engagement.shortAnswer")}</option><option value="radio">{t("engagement.oneChoice")}</option><option value="checkbox">{t("engagement.multipleChoice")}</option><option value="dropdown">{t("engagement.dropdown")}</option><option value="scale">{t("engagement.scale")}</option><option value="rating">{t("engagement.rating")}</option><option value="yes_no">{t("engagement.yesNo")}</option></select></label><label className="eng-field"><span>{t("engagement.sectionKey")}</span><input required pattern="[A-Za-z0-9._:\-]+" value={question.sectionKey || ""} onChange={(event) => updateQuestion(index, "sectionKey", event.target.value)} /></label><label className="eng-field eng-field--wide"><span>{t("engagement.sectionTitle")}</span><input maxLength="200" value={question.sectionTitle || ""} onChange={(event) => updateQuestion(index, "sectionTitle", event.target.value)} /></label></div>
        {["radio", "checkbox", "dropdown", "scale", "rating"].includes(question.type) && <label className="eng-field"><span>{t("engagement.optionsLines")}{["scale", "rating"].includes(question.type) ? t("engagement.blankScale") : ""}</span><textarea rows="3" required={["radio", "checkbox", "dropdown"].includes(question.type)} value={question.optionsText ?? surveyOptionLinesText(question.options)} onChange={(event) => updateQuestionOptions(index, event.target.value)} /></label>}
        {question.type === "checkbox" && <label className="eng-field"><span>{t("engagement.maximumSelections")}</span><input type="number" min="1" max={(question.options || []).length || 1} value={question.maxSelections || ""} onChange={(event) => updateQuestion(index, "maxSelections", event.target.value ? Number(event.target.value) : null)} /></label>}
        {possibleParents.length > 0 && <div className="eng-grid eng-branch"><label className="eng-field"><span>{t("engagement.showAfter")}</span><select value={question.branchParentKey || ""} onChange={(event) => set("questions", draft.questions.map((item, at) => at === index ? { ...item, branchParentKey: event.target.value, branchValue: "" } : item))}><option value="">{t("engagement.alwaysShow")}</option>{possibleParents.map((candidate) => <option key={candidate.clientKey} value={candidate.clientKey}>{t("engagement.branchQuestion", { number: draft.questions.indexOf(candidate) + 1, label: candidate.label || t("engagement.untitled") })}</option>)}</select></label>{question.branchParentKey && <label className="eng-field"><span>{t("engagement.answerEquals")}</span>{parentOptions.length ? <select required value={question.branchValue || ""} onChange={(event) => updateQuestion(index, "branchValue", event.target.value)}><option value="">{t("engagement.chooseAnswer")}</option>{parentOptions.map((option) => { const value = typeof option === "object" ? option.value ?? option.label : option; const label = parent?.type === "yes_no" && !(parent.options || []).length ? t(`engagement.${value}`) : typeof option === "object" ? option.label ?? option.value : option; return <option key={String(value)} value={String(value)}>{label}</option>; })}</select> : <input required maxLength="200" value={question.branchValue || ""} onChange={(event) => updateQuestion(index, "branchValue", event.target.value)} />}</label>}</div>}
        <label className="eng-check"><input type="checkbox" checked={Boolean(question.required)} onChange={(event) => updateQuestion(index, "required", event.target.checked)} /> {t("engagement.required")}</label>
        {draft.questions.length > 1 && <button type="button" className="eng-link eng-link--danger" onClick={() => set("questions", draft.questions.filter((_, at) => at !== index))}>{t("engagement.removeQuestion")}</button>}
      </fieldset>;})}
    </div>
    <div className="eng-actions"><BusyButton type="submit" className="eng-btn eng-btn--quiet" pending={busy}>{t("engagement.saveDraft")}</BusyButton><BusyButton type="button" className="eng-btn" pending={busy} onClick={(event) => save(event, true)}>{t("engagement.publishSurvey")}</BusyButton></div>
  </form>;
}

// A flagged response is read through get_organization_survey_review_detail
// before the review state can change: the select only renders once the
// answers have been shown. Below the survey's privacy floor the server
// answers "collecting" with no answers (SEC-UG-SURVEY-REVIEW-PRIVACY-
// FLOOR-20261001), and the row says so instead of offering triage.
function SurveyReviewRow({ review, client, onNotice, onUpdate }) {
  const { t, lang } = useLang();
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  async function readResponse() {
    setLoading(true);
    try { setDetail(await engagementApi.loadSurveyReview(client, review.sessionId)); }
    catch { onNotice(t("engagement.responseLoadFailed"), true); }
    finally { setLoading(false); }
  }
  if (detail?.state === "collecting") {
    return <p className="eng-row">{t("engagement.reviewCollecting", { count: detail.responseCount ?? 0, minimum: detail.privacyMinResponses ?? 3 })}</p>;
  }
  const answers = Array.isArray(detail?.answers) ? detail.answers : [];
  return <div>
    <div className="eng-row"><span><strong>{statusLabel(t, review.state)}</strong><small>{review.followUpDueAt ? t("engagement.followUpDate", { date: new Date(review.followUpDueAt).toLocaleDateString(localeFor(lang)) }) : t("engagement.noFollowUp")}</small></span>{detail
      ? <select aria-label={t("engagement.reviewState")} value={review.state} onChange={(event) => onUpdate(event.target.value)}><option value="unreviewed">{t("engagement.unreviewed")}</option><option value="assigned">{t("engagement.assigned")}</option><option value="follow_up">{t("engagement.followUp")}</option><option value="resolved">{t("engagement.resolved")}</option><option value="dismissed">{t("engagement.dismissed")}</option></select>
      : <button type="button" className="eng-link" disabled={loading || !review.sessionId} onClick={readResponse}>{t("engagement.readResponse")}</button>}</div>
    {detail && (answers.length
      ? answers.map((answer, index) => <div className="eng-row" key={answer.questionId || index}><span><strong>{answer.label}</strong><small>{surveyAnswerLabel(answer.value)}</small></span></div>)
      : <p>{t("engagement.responseNoAnswers")}</p>)}
  </div>;
}

// The operations fields configure_organization_survey_operations rewrites on
// every call, read from the staff snapshot so one form never clears another's.
export function surveyOperationsFields(survey) {
  return {
    cadence: survey?.cadence || "one_off",
    periodKey: survey?.cadence === "quarterly" ? survey?.periodKey || null : null,
    operationsState: survey?.operationsState || "draft",
    opensAt: survey?.opensAt || null,
    closesAt: survey?.closesAt || null,
    ownerUserId: survey?.ownerUserId || null,
    reviewDueAt: survey?.reviewDueAt || null,
    readinessDueAt: (survey?.tasks || []).find((task) => task?.reason === "readiness")?.dueAt || null,
  };
}

function localDateTimeValue(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isoFromLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The answer window the database accepts (opens_at < closes_at), checked here
// so the author reads which field to change; a published survey's close time
// must still be ahead.
export function surveyWindowProblem({ opens = "", closes = "" } = {}, publish = false, now = Date.now()) {
  const opensAt = isoFromLocal(opens);
  const closesAt = isoFromLocal(closes);
  if ((opens && !opensAt) || (closes && !closesAt)) return "engagement.surveyWindowInvalid";
  if (opensAt && closesAt && Date.parse(opensAt) >= Date.parse(closesAt)) return "engagement.surveyWindowOrder";
  if (publish && closesAt && Date.parse(closesAt) <= now) return "engagement.surveyClosesPast";
  return null;
}

// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 (inventory A2): the
// privacy floor after publish, the survey owner and the review and readiness
// due dates had write paths and no control.
// BUG-UG-WEB-ENGAGEMENT-SURVEYS-UNPAGED-20261002: unsaved values and
// the open panel are mirrored into the survey list's draft store, so a card
// that leaves the page (a filter change) comes back as it was left. A save that
// succeeds clears its fields from the store.
function SurveyOperationSettings({ survey, members, busy, onSaveFloor, onSaveOperations, draft = null, onDraft = () => {} }) {
  const { t } = useLang();
  const fields = surveyOperationsFields(survey);
  const [floor, setFloor] = useState(draft?.floor ?? String(survey.privacyMinResponses ?? 3));
  const [owner, setOwner] = useState(draft?.owner ?? (fields.ownerUserId || ""));
  const [reviewDue, setReviewDue] = useState(draft?.reviewDue ?? localDateTimeValue(fields.reviewDueAt));
  const [readinessDue, setReadinessDue] = useState(draft?.readinessDue ?? localDateTimeValue(fields.readinessDueAt));
  // Only unsaved edits live here; an untouched field follows the survey's
  // saved window, so an editor save is never overwritten by a stale copy.
  const [opensEdit, setOpensEdit] = useState(draft?.opens ?? null);
  const [closesEdit, setClosesEdit] = useState(draft?.closes ?? null);
  const opens = opensEdit ?? localDateTimeValue(fields.opensAt);
  const closes = closesEdit ?? localDateTimeValue(fields.closesAt);
  // A survey can stay open past its close time (closeout due); the close must
  // be ahead only when this form changes it, so owner and due-date saves still
  // work on an expired window.
  const windowProblem = surveyWindowProblem({ opens, closes }, survey.status === "open" && closesEdit !== null);
  const [initiallyOpen] = useState(Boolean(draft?.settingsOpen));
  // REQ-UG-STALE-OR-CONTRADICTORY-STATE-AFTER-SAVE-20261030: the
  // control follows the saved owner when a reload changes it and nothing is
  // being edited, and a saved owner missing from the member list is still
  // shown as chosen; a select whose value has no option shows "No owner".
  const savedOwner = fields.ownerUserId || "";
  const shownSavedOwner = useRef(savedOwner);
  useEffect(() => {
    if (shownSavedOwner.current === savedOwner) return;
    shownSavedOwner.current = savedOwner;
    if (draft?.owner === undefined) setOwner(savedOwner);
  }, [savedOwner, draft?.owner]);
  const ownerListed = !owner || (members || []).some((member) => member.id === owner);
  const edit = (setter, key) => (event) => { setter(event.target.value); onDraft({ [key]: event.target.value }); };
  const floorNumber = Number(floor);
  const { privacyMin: min, privacyMax: max } = SURVEY_AUTHORING_LIMITS;
  const floorValid = Number.isInteger(floorNumber) && floorNumber >= min && floorNumber <= max;
  const floorChanged = floorNumber !== survey.privacyMinResponses;
  const floorRange = t("engagement.privacyFloorRange", { min, max });
  const rangeId = `survey-floor-range-${survey.id}`;
  const minimumId = `survey-floor-hint-${survey.id}`;
  // Keep the reason stable so BusyButton can track and announce each refused press.
  const invalidFloorReason = useMemo(() => <span id={rangeId}>{floorRange}</span>, [rangeId, floorRange]);
  const floorReason = !floorValid ? invalidFloorReason : !floorChanged ? t("engagement.privacyFloorUnchanged") : null;
  return <details className="eng-details" open={initiallyOpen || undefined} onToggle={(event) => onDraft({ settingsOpen: event.currentTarget.open })}><summary>{t("engagement.operationsSettings")}</summary>
    <div className="eng-grid">
      <div className="eng-field">
        <label className="eng-field"><span>{t("engagement.privacyFloor")}</span><input type="number" inputMode="numeric" min={min} max={max} step="1" value={floor} aria-invalid={!floorValid || undefined} aria-describedby={`${rangeId} ${minimumId}`} onChange={edit(setFloor, "floor")} /></label>
        {(floorValid || busy) && <small className="eng-field__hint" id={rangeId}>{floorRange}</small>}
      </div>
      <div>
        <BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} disabled={!floorValid || !floorChanged} disabledReason={floorReason} onClick={async () => { if (await onSaveFloor(floorNumber)) onDraft({ floor: undefined }); }}>{t("engagement.savePrivacyFloor")}</BusyButton>
      </div>
      <p className="eng-field eng-field--wide eng-field__hint" id={minimumId}>{t("engagement.privacyFloorReportMinimum", { minimum: SURVEY_REPORT_MINIMUM })}</p>
    </div>
    <div className="eng-grid">
      <label className="eng-field"><span>{t("engagement.surveyOwner")}</span><select value={owner} onChange={edit(setOwner, "owner")}><option value="">{t("engagement.noOwner")}</option>{!ownerListed && <option value={owner}>{t("engagement.savedOwner")}</option>}{(members || []).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
      <label className="eng-field"><span>{t("engagement.readinessDue")}</span><input type="datetime-local" value={readinessDue} onChange={edit(setReadinessDue, "readinessDue")} /></label>
      <label className="eng-field"><span>{t("engagement.reviewDue")}</span><input type="datetime-local" value={reviewDue} onChange={edit(setReviewDue, "reviewDue")} /></label>
      {survey.status !== "closed" && <><label className="eng-field"><span>{t("engagement.starts")}</span><input type="datetime-local" value={opens} onChange={edit(setOpensEdit, "opens")} /></label>
      <label className="eng-field"><span>{t("engagement.surveyCloses")}</span><input type="datetime-local" value={closes} aria-invalid={Boolean(windowProblem) || undefined} onChange={edit(setClosesEdit, "closes")} /></label></>}
      {survey.status !== "closed" && windowProblem && <p className="eng-field eng-field--wide" role="alert">{t(windowProblem)}</p>}
      <BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} disabled={(survey.status !== "closed" && Boolean(windowProblem))} onClick={async () => { if (await onSaveOperations({ ...fields, ownerUserId: owner || null, reviewDueAt: isoFromLocal(reviewDue), readinessDueAt: isoFromLocal(readinessDue), ...(survey.status !== "closed" ? { opensAt: opensEdit === null ? fields.opensAt : isoFromLocal(opensEdit), closesAt: closesEdit === null ? fields.closesAt : isoFromLocal(closesEdit) } : {}) })) { setOpensEdit(null); setClosesEdit(null); onDraft({ owner: undefined, reviewDue: undefined, readinessDue: undefined, opens: undefined, closes: undefined }); } }}>{t("engagement.saveOperations")}</BusyButton>
    </div>
  </details>;
}

// REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001: the derived
// attention for one survey (coverage escalation, low-response follow-up and
// reminder cadence), worded from configured day thresholds only.
function SurveyAttention({ attention }) {
  const { t, lang } = useLang();
  if (!attention) return null;
  const lines = [];
  const escalation = attention.escalation;
  if (escalation) {
    lines.push(<p key="escalation" className={`eng-attention eng-attention--${escalation.level}`}><strong>{t(`engagement.level.${escalation.level}`)}</strong> {t(`engagement.escalation.${escalation.reason}`, { days: escalation.thresholdDays ?? 0 })}</p>);
  }
  if (attention.lowResponse) {
    lines.push(<p key="low" className="eng-attention">{t(attention.lowResponse.state === "no_responses" ? "engagement.followUpNoResponses" : "engagement.followUpLowResponses", { threshold: attention.lowResponse.threshold })}</p>);
  }
  if (attention.reminder) {
    const when = formatGroupMoment(attention.reminder.dueAt, lang);
    lines.push(<p key="reminder" className="eng-attention">{attention.reminder.due ? t("engagement.reminderDue") : t("engagement.reminderScheduled", { date: when })} {t(attention.reminder.scheduledSending ? "engagement.reminderAutoSend" : "engagement.reminderManualSend")}</p>);
  }
  return lines.length ? <div className="eng-attention-list">{lines}</div> : null;
}

function dayBoundary(value, endOfDay) {
  return value ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}`).toISOString() : null;
}

function SurveyOperations({ survey, client, members = [], onUpdated, onNotice, onEdit, attention = null, exportsEnabled = true, draft = null, onDraft = () => {} }) {
  const { t, lang } = useLang();
  // Several writes can run on one card at once (Mark done
  // and the review state are not held by busy), so busy counts the writes in
  // flight; the first to finish no longer frees the card while another runs.
  const [inFlight, setInFlight] = useState(0);
  const busy = inFlight > 0;
  const setBusy = (on) => setInFlight((count) => (on ? count + 1 : Math.max(0, count - 1)));
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [report, setReport] = useState(null);
  const [range, setRange] = useState(draft?.range ?? { from: "", to: "" });
  const editRange = (key) => (event) => { const next = { ...range, [key]: event.target.value }; setRange(next); onDraft({ range: next }); };
  // BUG-UG-STAFF-ENGAGEMENT-WITHHELD-TOTALS-20261028: the snapshot
  // returns coverage null where it withholds the totals; that is not zero.
  const coverageWithheld = survey.coverage === null;
  const coverage = survey.coverage || {};
  // Only the operations whose controls show busy take the lock; a task or
  // review update still runs alongside them, as it did (record 8435).
  function lockedAct(work, message) {
    return runBusyWrite(busyWriteRef, "survey-ops", () => act(work, message));
  }

  async function act(work, message) {
    setBusy(true);
    try { await work(); onNotice(message); await onUpdated(); return true; }
    catch { onNotice(t("engagement.surveyOperationFailed"), true); return false; }
    finally { setBusy(false); }
  }
  function showReport() {
    return runBusyWrite(busyWriteRef, "survey-ops", () => showReportNow());
  }

  async function showReportNow() {
    setBusy(true);
    try {
      // The undated report is the existing read; a date range uses the
      // windowed report, whose privacy floor applies inside the range.
      setReport(exportsEnabled && (range.from || range.to)
        ? await engagementApi.loadSurveyReportWindow(client, survey.id, dayBoundary(range.from, false), dayBoundary(range.to, true))
        : await engagementApi.loadSurveyReport(client, survey.id));
    }
    catch { onNotice(t("engagement.reportFailed"), true); }
    finally { setBusy(false); }
  }
  // REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001: CSV/XLSX for the
  // chosen date range; the server refuses a range below the privacy floor.
  function exportReport(format) {
    return runBusyWrite(busyWriteRef, "survey-ops", () => exportReportNow(format));
  }

  // #9895: Export JSON takes the same busy lock and notices as CSV and XLSX,
  // so a refused or failed export says so instead of doing nothing.
  function exportJson() {
    return runBusyWrite(busyWriteRef, "survey-ops", () => exportReportNow("json"));
  }

  async function exportReportNow(format) {
    setBusy(true);
    try {
      if (format === "json") downloadJson(`survey-${survey.id}.json`, await engagementApi.exportSurvey(client, survey.id));
      else downloadSurveyExport(await engagementApi.exportSurveyWindow(client, survey.id, dayBoundary(range.from, false), dayBoundary(range.to, true), format), format, t);
      onNotice(t("engagement.exportDownloaded"));
    } catch (error) {
      // The JSON export takes no range and its server function never refuses
      // below the floor (it returns the report unavailable, with no
      // responses), so the range sentence is only for CSV and XLSX.
      onNotice(t(format !== "json" && /privacy floor/i.test(error?.message || "") ? "engagement.exportBelowFloor" : "engagement.exportFailed"), true);
    } finally { setBusy(false); }
  }
  return <article className="eng-card eng-ops-card">
    <div className="eng-card__head"><div><span className="eng-kicker">{survey.cadence === "quarterly" ? t("engagement.quarterly") : t("engagement.oneOff")}{survey.periodKey ? ` · ${survey.periodKey}` : ""}</span><h3 id={`eng-survey-${survey.id}`} tabIndex={-1}>{survey.title}</h3></div><span className={`eng-status eng-status--${survey.status}`}>{statusLabel(t, survey.status)}</span></div>
    {coverageWithheld
      ? <p className="eng-row">{t("engagement.coverageWithheld")}</p>
      : <div className="eng-metrics"><div><span>{t("engagement.responses")}</span><strong>{survey.reviewLane?.responseCount ?? 0}</strong></div><div><span>{t("engagement.audience")}</span><strong>{coverage.total || 0}</strong></div><div><span>{t("engagement.sent")}</span><strong>{coverage.sent || 0}</strong></div><div><span>{t("engagement.engaged")}</span><strong>{coverage.engaged || 0}</strong></div><div><span>{t("engagement.failed")}</span><strong>{coverage.failed || 0}</strong></div></div>}
    {survey.closesAt && <p className="eng-row">{t(survey.status === "closed" ? "engagement.surveyClosedAt" : "engagement.surveyClosesAt", { date: formatGroupMoment(survey.closesAt, lang) })}</p>}
    <SurveyAttention attention={attention} />
    <div className="eng-actions">
      {survey.status === "draft" && <button type="button" className="eng-btn eng-btn--quiet" onClick={() => onEdit(survey)}>{t("engagement.edit")}</button>}
      {survey.status === "open" && <><BusyButton type="button" className="eng-btn" pending={busy} onClick={() => lockedAct(() => engagementApi.prepareDistribution(client, survey.id), t("engagement.distributionQueued"))}>{t("engagement.distribute")}</BusyButton><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={() => lockedAct(() => engagementApi.queueReminders(client, survey.id), t("engagement.remindersQueued"))}>{t("engagement.remind")}</BusyButton><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={showReport}>{t("engagement.report")}</BusyButton><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={() => lockedAct(() => engagementApi.closeSurvey(client, survey.id), t("engagement.surveyClosed"))}>{t("engagement.close")}</BusyButton></>}
      {survey.status === "closed" && <BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={() => lockedAct(() => engagementApi.reopenSurvey(client, survey.id), t("engagement.surveyReopened"))}>{t("engagement.reopen")}</BusyButton>}
    </div>
    {survey.status !== "draft" && <WorksiteSurveyReport surveyId={survey.id} client={client} />}
    <SurveyOperationSettings survey={survey} members={members} busy={busy} draft={draft} onDraft={onDraft}
      onSaveFloor={(value) => lockedAct(() => engagementApi.setSurveyPrivacyFloor(client, survey.id, value), t("engagement.privacyFloorSaved"))}
      onSaveOperations={(operations) => lockedAct(() => engagementApi.configureSurvey(client, survey.id, operations), t("engagement.operationsSaved"))} />
    {(survey.tasks || []).length > 0 && <details className="eng-details"><summary>{t("engagement.reviewTasks")}</summary>{survey.tasks.map((task) => <div className="eng-row" key={task.id}><span><strong>{taskReasonLabel(t, task.reason)}</strong><small>{statusLabel(t, task.status)}</small></span>{task.status !== "done" && <button type="button" className="eng-link" onClick={() => act(() => engagementApi.updateSurveyTask(client, task.id, { ...task, status: "done" }), t("engagement.taskCompleted"))}>{t("engagement.markDone")}</button>}</div>)}</details>}
    {survey.status !== "draft" && survey.reviewLane?.state === "collecting" && <p className="eng-row">{t("engagement.reviewCollecting", { count: survey.reviewLane.responseCount ?? 0, minimum: survey.reviewLane.privacyMinResponses ?? survey.privacyMinResponses ?? 3 })}</p>}
    {(survey.reviews || []).length > 0 && <details className="eng-details"><summary>{t("engagement.reviewLane", { count: survey.reviews.length })}</summary>{survey.reviews.map((review) => <SurveyReviewRow key={review.id} review={review} client={client} onNotice={onNotice} onUpdate={(state) => act(() => engagementApi.updateSurveyReview(client, review.id, { ...review, state }), t("engagement.reviewUpdated"))} />)}</details>}
    {report && <div className="eng-report"><div className="eng-card__head"><h4>{t("engagement.surveyReport")}</h4><div className="eng-actions">{exportsEnabled && <><BusyButton type="button" className="eng-link" pending={busy} disabled={!report.available} onClick={() => exportReport("csv")}>{t("engagement.exportCsv")}</BusyButton><BusyButton type="button" className="eng-link" pending={busy} disabled={!report.available} onClick={() => exportReport("xlsx")}>{t("engagement.exportXlsx")}</BusyButton></>}<BusyButton type="button" className="eng-link" pending={busy} onClick={exportJson}>{t("engagement.exportJson")}</BusyButton></div></div>{exportsEnabled && <div className="eng-grid eng-report-range"><label className="eng-field"><span>{t("engagement.reportFrom")}</span><input type="date" value={range.from} onChange={editRange("from")} /></label><label className="eng-field"><span>{t("engagement.reportTo")}</span><input type="date" value={range.to} onChange={editRange("to")} /></label><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={showReport}>{t("engagement.applyRange")}</BusyButton></div>}{report.available ? <>{report.questions.map((question) => <div className="eng-row" key={question.id}><span><strong>{question.label}</strong><small>{question.withheld ? t("engagement.questionWithheld", { minimum: report.privacyMinResponses }) : t("engagement.answerCount", { count: question.answered })}</small></span><span>{question.distribution?.map((bucket) => `${surveyAnswerLabel(bucket.value)}: ${bucket.count}`).join(" · ")}</span></div>)}</> : <p>{t("engagement.aggregation", { minimum: report.privacyMinResponses, count: report.responseCount })}</p>}</div>}
  </article>;
}

// BUG-UG-WEB-ENGAGEMENT-SURVEYS-UNPAGED-20261002: the tab drew every
// survey as a full card (420 surveys made a 130,000px page). The snapshot now
// carries the first page (open, then draft, then closed), the server's counts
// by status and a cursor; the status filter and Show more read further pages
// from get_staff_engagement_surveys. A snapshot without counts (a database
// that has not applied 20261003046000) still holds every survey, so the same
// filter and pages run over it locally. Unsaved settings, a report range and
// an open settings panel are kept per survey, so a filter change or the reload
// after an action never discards them; Show more moves focus to the first new
// card, and a reload re-reads as many rows as are on screen.
const SURVEY_FILTERS = ["all", "open", "draft", "closed"];
const SURVEY_PAGE = 20;
const SURVEY_STATUS_RANK = { open: 0, draft: 1, closed: 2 };

function localSurveyPage(all, filter, offset, limit) {
  const ordered = all
    .map((survey, index) => ({ survey, index }))
    .sort((a, b) => ((SURVEY_STATUS_RANK[a.survey.status] ?? 3) - (SURVEY_STATUS_RANK[b.survey.status] ?? 3)) || (a.index - b.index))
    .map(({ survey }) => survey);
  const matching = filter === "all" ? ordered : ordered.filter((survey) => survey.status === filter);
  const end = offset + limit;
  const counts = { all: all.length, open: 0, draft: 0, closed: 0 };
  for (const survey of all) if (survey.status in SURVEY_STATUS_RANK) counts[survey.status] += 1;
  return { surveys: matching.slice(offset, end), cursor: end < matching.length ? end : null, counts };
}

function firstSurveyPage(snapshot) {
  const surveys = Array.isArray(snapshot.surveys) ? snapshot.surveys : [];
  return snapshot.surveyCounts
    ? { filter: "all", surveys, cursor: snapshot.surveyCursor || null, counts: snapshot.surveyCounts }
    : { filter: "all", ...localSurveyPage(surveys, "all", 0, SURVEY_PAGE) };
}

async function readSurveyPages(client, filter, minimum, after) {
  let surveys = [];
  let cursor = after;
  let counts = null;
  do {
    const page = await engagementApi.loadStaffSurveys(client, {
      status: filter === "all" ? null : filter,
      after: cursor,
      limit: Math.min(100, Math.max(SURVEY_PAGE, minimum - surveys.length)),
    });
    surveys = surveys.concat(Array.isArray(page?.surveys) ? page.surveys : []);
    cursor = page?.nextCursor || null;
    counts = page?.counts || counts;
  } while (cursor && surveys.length < minimum);
  return { surveys, cursor, counts };
}

function SurveyList({ snapshot, client, onUpdated, onNotice, onEdit, attention }) {
  const { t } = useLang();
  const [list, setList] = useState(() => firstSurveyPage(snapshot));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [drafts] = useState(() => new Map());
  const listRef = useRef(list);
  const request = useRef(0);
  const focusId = useRef("");
  const appliedSnapshot = useRef(snapshot);
  // Synced during the commit, not after it: Show more is enabled in the same
  // render that adds the rows, and a click before passive effects ran would
  // otherwise read the previous page's cursor and fetch that page again.
  useLayoutEffect(() => { listRef.current = list; }, [list]);
  const show = useCallback(async (filter, minimum, append, focusNew = true) => {
    const ticket = request.current + 1;
    request.current = ticket;
    const current = listRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const all = Array.isArray(snapshot.surveys) ? snapshot.surveys : [];
      const next = snapshot.surveyCounts
        ? await readSurveyPages(client, filter, minimum, append ? current.cursor : null)
        : localSurveyPage(all, filter, append ? current.cursor : 0, Math.max(minimum, SURVEY_PAGE));
      if (ticket !== request.current) return;
      if (append && focusNew && next.surveys[0]) focusId.current = next.surveys[0].id;
      setList({ ...next, filter, counts: next.counts || current.counts, surveys: append ? current.surveys.concat(next.surveys) : next.surveys });
    } catch {
      if (ticket === request.current) setFailed(true);
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [client, snapshot]);
  useEffect(() => {
    if (appliedSnapshot.current === snapshot) return;
    appliedSnapshot.current = snapshot;
    const { filter, surveys } = listRef.current;
    if (snapshot.surveyCounts && filter === "all" && surveys.length <= (snapshot.surveys || []).length) {
      request.current += 1;
      setLoading(false);
      setFailed(false);
      setList(firstSurveyPage(snapshot));
      return;
    }
    show(filter, Math.max(surveys.length, SURVEY_PAGE), false);
  }, [snapshot, show]);
  useEffect(() => {
    if (!focusId.current) return;
    document.getElementById(`eng-survey-${focusId.current}`)?.focus();
    focusId.current = "";
  }, [list]);
  const counts = list.counts || {};
  const total = counts[list.filter] ?? list.surveys.length;
  return <>
    <div className="eng-choice-row" role="group" aria-label={t("engagement.surveyFilter")}>{SURVEY_FILTERS.map((value) => <button type="button" className="eng-chip" key={value} aria-pressed={list.filter === value} onClick={() => { if (list.filter !== value || loading || failed) show(value, SURVEY_PAGE, false); }}>{t(`engagement.surveyFilter.${value}`)} <span className="eng-chip__count">{counts[value] ?? 0}</span></button>)}</div>
    {list.surveys.length === 0 && !loading && <p className="eng-state">{t("engagement.surveysEmptyFilter")}</p>}
    {list.surveys.map((survey) => <SurveyOperations key={survey.id} survey={survey} client={client} members={snapshot.members || []} onUpdated={onUpdated} onNotice={onNotice} onEdit={onEdit} attention={attention?.bySurvey[survey.id] || null} exportsEnabled={attention?.exports !== false} draft={drafts.get(survey.id) || null} onDraft={(patch) => drafts.set(survey.id, { ...drafts.get(survey.id), ...patch })} />)}
    {list.surveys.length > 0 && <p className="eng-survey-total" role="status">{t("engagement.surveysShowing", { shown: list.surveys.length, total })}</p>}
    {failed && <p className="eng-notice eng-notice--error" role="alert">{t("engagement.surveysLoadFailed")}</p>}
    {list.cursor != null && <button type="button" className="eng-btn eng-btn--quiet" disabled={loading} onClick={() => show(list.filter, SURVEY_PAGE, true)}>{loading ? t("engagement.surveysLoadingMore") : t("engagement.surveysShowMore")}</button>}
  </>;
}

function meetingLabel(meeting, lang) {
  const when = meeting?.startsAt ? new Date(meeting.startsAt) : null;
  return when && !Number.isNaN(when.getTime()) ? `${meeting.title} · ${formatGroupMoment(meeting.startsAt, lang)}` : String(meeting?.title || "");
}

function LivePollEditor({ client, session, members, chapters, meetings = null, onDone, onNotice, autoSchedule = true }) {
  const { t, lang } = useLang();
  const [draft, setDraft] = useState(newPollDraft());
  // REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: the meeting the
  // poll is taken at, chosen from events, not people.
  const [meetingId, setMeetingId] = useState("");
  // Once the poll is created, a retry updates it instead of creating another.
  const [savedPollId, setSavedPollId] = useState(null);
  const [topic, setTopic] = useState("");
  const [selectedMembers, setSelectedMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const chapterChoices = (chapters || []).filter((chapter) => chapter?.id);
  const resolvedChapter = draft.chapterId || chapterChoices[0]?.id || "";
  const resolvedChapterLabel = chapterChoices.find((chapter) => chapter.id === resolvedChapter)?.name || resolvedChapter;
  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const setEligibility = (value) => setDraft((current) => ({
    ...current,
    eligibility: value,
    ...(value === "chapter" && !current.chapterId && chapterChoices[0]?.id ? { chapterId: chapterChoices[0].id } : {}),
  }));
  function aiDraft() {
    return runBusyWrite(busyWriteRef, "poll", () => aiDraftNow());
  }

  async function aiDraftNow() {
    setBusy(true);
    try { const result = await requestPollDraft(session, topic); setDraft((current) => ({ ...current, ...result.draft })); onNotice(t("engagement.compassReady")); }
    catch { onNotice(t("engagement.compassFailed"), true); }
    finally { setBusy(false); }
  }
  function save(event) {
    return runBusyWrite(busyWriteRef, "poll", () => saveNow(event), event);
  }

  async function saveNow(event) {
    event.preventDefault(); setBusy(true);
    try {
      const payload = {
        ...draft,
        scheduledAt: draft.scheduledAt ? new Date(draft.scheduledAt).toISOString() : null,
        opensAt: draft.opensAt ? new Date(draft.opensAt).toISOString() : null,
        closesAt: draft.closesAt ? new Date(draft.closesAt).toISOString() : null,
        quorumTarget: draft.quorumTarget || null,
        options: draft.options.map((option) => ({ label: option.label.trim() })),
      };
      if (draft.eligibility === "chapter") payload.chapterId = resolvedChapter;
      else delete payload.chapterId;
      if (savedPollId) payload.id = savedPollId;
      const saved = await engagementApi.saveLivePoll(client, payload);
      setSavedPollId(saved.id);
      if (draft.eligibility === "roster") await engagementApi.setLivePollRoster(client, saved.id, selectedMembers);
      if (meetingId) {
        try { await engagementApi.setLivePollMeeting(client, saved.id, meetingId); }
        catch {
          onNotice(t("engagement.pollMeetingFailed"), true);
          return;
        }
      }
      onNotice(t("engagement.pollSaved")); await onDone();
    } catch (error) {
      const refusedChapter = /chapter scope requires a specific chapter/i.test(error.message || "");
      onNotice(refusedChapter ? t("engagement.pollChapterRequired") : t("engagement.pollSaveFailed"), true);
    }
    finally { setBusy(false); }
  }
  return <form className="eng-card eng-editor" onSubmit={save}>
    <div className="eng-card__head"><div><span className="eng-kicker">{t("engagement.meetingPoll")}</span><h3>{t("engagement.authorPoll")}</h3></div><button className="eng-link" type="button" onClick={onDone}>{t("engagement.cancel")}</button></div>
    <div className="eng-ai-draft"><Bot /><label className="eng-field"><span>{t("engagement.draftCompass")}</span><input value={topic} maxLength="500" placeholder={t("engagement.pollTopic")} onChange={(event) => setTopic(event.target.value)} /></label><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} disabled={!topic.trim()} onClick={aiDraft}>{t("engagement.createDraft")}</BusyButton></div>
    <div className="eng-grid"><label className="eng-field"><span>{t("engagement.question")}</span><input required maxLength="240" value={draft.title} onChange={(event) => set("title", event.target.value)} /></label><label className="eng-field"><span>{t("engagement.eligibility")}</span><select value={draft.eligibility} onChange={(event) => setEligibility(event.target.value)}><option value="organization">{t("engagement.organization")}</option><option value="chapter">{t("engagement.chapter")}</option><option value="roster">{t("engagement.meetingRoster")}</option></select></label><label className="eng-field eng-field--wide"><span>{t("engagement.context")}</span><textarea rows="2" value={draft.description} onChange={(event) => set("description", event.target.value)} /></label><label className="eng-field"><span>{t("engagement.results")}</span><select value={draft.resultsVisibility} onChange={(event) => set("resultsVisibility", event.target.value)}><option value="live">{t("engagement.live")}</option><option value="after_close">{t("engagement.afterClose")}</option><option value="staff_only">{t("engagement.staffOnly")}</option></select></label><label className="eng-field"><span>{t("engagement.starts")}</span><input type="datetime-local" value={draft.opensAt} onChange={(event) => set("opensAt", event.target.value)} /></label><label className="eng-field"><span>{t("engagement.closes")}</span><input type="datetime-local" value={draft.closesAt} onChange={(event) => set("closesAt", event.target.value)} /></label></div>
    <p>{t(autoSchedule ? "engagement.pollScheduleHelp" : "engagement.pollScheduleManual")}</p>
    {Array.isArray(meetings?.events) && <label className="eng-field"><span>{t("engagement.pollMeeting")}</span><select value={meetingId} onChange={(event) => setMeetingId(event.target.value)}><option value="">{t("engagement.pollNoMeeting")}</option>{meetings.events.map((meeting) => <option key={meeting.id} value={meeting.id}>{meetingLabel(meeting, lang)}</option>)}</select>{meetings.events.length === 0 && <small className="eng-field__hint">{t("engagement.pollNoMeetings")}</small>}</label>}
    {draft.eligibility === "chapter" && <><label className="eng-field"><span>{t("engagement.chapter")}</span>{chapterChoices.length > 0 ? <select required value={resolvedChapter} onChange={(event) => set("chapterId", event.target.value)}>{chapterChoices.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name || chapter.id}</option>)}</select> : <p role="status">{t("engagement.pollChapterRequired")}</p>}</label>{chapterChoices.length > 0 && <p>{t("engagement.pollChapterReach", { chapter: resolvedChapterLabel })}</p>}</>}
    <div className="eng-options">{draft.options.map((option, index) => <label key={`poll-option-${index}`}><span>{index + 1}</span><input aria-label={t("engagement.optionNumber", { number: index + 1 })} required value={option.label} onChange={(event) => set("options", draft.options.map((item, at) => at === index ? { label: event.target.value } : item))} /></label>)}<button type="button" className="eng-link" onClick={() => set("options", [...draft.options, { label: "" }])}>{t("engagement.addOption")}</button></div>
    {draft.eligibility === "roster" && <fieldset className="eng-fieldset"><legend>{t("engagement.eligibleRoster")}</legend><div className="eng-member-grid">{members.map((member) => <label key={member.id}><input type="checkbox" checked={selectedMembers.includes(member.id)} onChange={(event) => setSelectedMembers((current) => event.target.checked ? [...current, member.id] : current.filter((id) => id !== member.id))} /> {member.name}</label>)}</div></fieldset>}
    <BusyButton type="submit" className="eng-btn" pending={busy}>{t("engagement.savePoll")}</BusyButton>
  </form>;
}

// REQ-UG-LIVE-POLL-SCHEDULED-OPEN-CLOSE-20261001: what the minute scheduler
// will do with this poll, or that it will not, so staff are never surprised.
function livePollScheduleLine(t, lang, poll, autoSchedule) {
  const live = poll.state === "scheduled" || poll.state === "open";
  if (!live || !(poll.opensAt || poll.closesAt)) return "";
  if (!autoSchedule) return t("engagement.pollScheduleManual");
  const when = (value) => formatGroupMoment(value, lang);
  const parts = [];
  if (poll.state === "scheduled" && poll.opensAt) parts.push(t("engagement.pollOpensAutomatically", { date: when(poll.opensAt) }));
  if (poll.closesAt) parts.push(t("engagement.pollClosesAutomatically", { date: when(poll.closesAt) }));
  return parts.join(" ");
}

function LivePollCard({ poll, client, onUpdated, onNotice, onProject, autoSchedule = true, meetings = null }) {
  const { t, lang } = useLang();
  const actions = poll.state === "draft" ? ["schedule", "open"] : poll.state === "scheduled" ? ["open", "cancel"] : poll.state === "open" ? ["close"] : [];
  const scheduleLine = livePollScheduleLine(t, lang, poll, autoSchedule);
  const link = (meetings?.links || []).find((item) => item.pollId === poll.id) || null;
  const linkable = Array.isArray(meetings?.events) && ["draft", "scheduled", "open"].includes(poll.state);
  // The saved link is always an option, so it shows as selected and can be
  // cleared; one outside the caller's chapter is named without its title.
  const choices = linkable ? [...meetings.events, ...(link && !meetings.events.some((meeting) => meeting.id === link.eventId) ? [{ id: link.eventId, title: link.title || t("engagement.pollMeetingHiddenOption"), startsAt: link.title ? link.startsAt : null }] : [])] : [];
  async function tieMeeting(eventId) {
    try { await engagementApi.setLivePollMeeting(client, poll.id, eventId); onNotice(t(eventId ? "engagement.pollMeetingSaved" : "engagement.pollMeetingCleared")); await onUpdated(); }
    catch { onNotice(t("engagement.pollUpdateFailed"), true); }
  }
  const meetingLine = link ? <p className="eng-row">{link.title ? t("engagement.pollMeetingLine", { meeting: meetingLabel(link, lang) }) : t("engagement.pollMeetingHidden")}</p> : null;
  const meetingPicker = linkable ? <label className="eng-field"><span>{t("engagement.pollMeeting")}</span><select value={link?.eventId || ""} aria-label={t("engagement.pollMeetingNamed", { title: poll.title })} onChange={(event) => tieMeeting(event.target.value)}><option value="">{t("engagement.pollNoMeeting")}</option>{choices.map((meeting) => <option key={meeting.id} value={meeting.id}>{meetingLabel(meeting, lang)}</option>)}</select></label> : null;
  return <article className="eng-card"><div className="eng-card__head"><div><span className="eng-kicker"><Radio size={14} /> {statusLabel(t, poll.state)}</span><h3>{poll.title}</h3></div><span className="eng-count">{t("engagement.voteCount", { count: poll.voteCount })}</span></div>{scheduleLine && <p className="eng-poll-schedule">{scheduleLine}</p>}{meetingLine}{meetingPicker}{poll.attendance === null ? <p className="eng-row">{t("engagement.attendanceWithheld")}</p> : <div className="eng-metrics"><div><span>{t("engagement.roster")}</span><strong>{poll.attendance?.roster || 0}</strong></div><div><span>{t("engagement.rsvpYes")}</span><strong>{poll.attendance?.rsvpYes || 0}</strong></div><div><span>{t("engagement.checkedIn")}</span><strong>{poll.attendance?.checkedIn || 0}</strong></div></div>}<div className="eng-actions">{actions.map((action) => <button type="button" className={action === "open" ? "eng-btn" : "eng-btn eng-btn--quiet"} key={action} onClick={async () => { try { await engagementApi.transitionLivePoll(client, poll.id, action); onNotice(t(`engagement.notice.${action}`)); await onUpdated(); } catch { onNotice(t("engagement.pollUpdateFailed"), true); } }}>{t(`engagement.action.${action}`)}</button>)}<button type="button" className="eng-btn eng-btn--quiet" onClick={(event) => onProject(poll, event.currentTarget)}>{t("engagement.projector")}</button></div></article>;
}

function ProjectorDialog({ projector, onClose, returnFocusRef: explicitReturnFocusRef, restoreTimerRef }) {
  const { t } = useLang();
  const layerRef = useRef(null);
  const closeRef = useRef(null);
  const returnFocusRef = useRef(typeof document === "undefined" ? null : document.activeElement);
  useModalIsolation(layerRef);

  useEffect(() => {
    const opener = explicitReturnFocusRef?.current || returnFocusRef.current;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      // A command palette opened above the projector claims its Escape first.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(restoreTimerRef?.current);
      const timer = window.setTimeout(() => {
        if (restoreTimerRef && restoreTimerRef.current === timer) restoreTimerRef.current = 0;
        if (typeof document === "undefined") return;
        if (opener?.isConnected && opener !== document.body && opener !== document.documentElement) opener.focus();
        else document.getElementById("main-content")?.focus();
      }, 0);
      if (restoreTimerRef) restoreTimerRef.current = timer;
    };
  }, [explicitReturnFocusRef, onClose, restoreTimerRef]);

  const trapFocus = (event) => {
    if (event.key !== "Tab") return;
    const focusables = [...event.currentTarget.querySelectorAll("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
    const index = focusables.indexOf(document.activeElement);
    if (event.shiftKey ? index <= 0 : index === focusables.length - 1) {
      event.preventDefault();
      focusables[event.shiftKey ? focusables.length - 1 : 0]?.focus();
    }
  };

  return <div ref={layerRef} className="eng-projector-layer" role="dialog" aria-modal="true" aria-labelledby="eng-projector-title" onKeyDown={trapFocus}><section className="eng-projector"><button ref={closeRef} type="button" className="eng-projector__close" onClick={onClose}>{t("engagement.close")}</button><span className="eng-kicker">{t("engagement.livePoll")}</span><h2 id="eng-projector-title">{projector.title}</h2><div className="eng-projector__results">{projector.results.map((result) => <div key={result.optionId || result.id}><span>{result.label}</span><strong>{result.votes}</strong></div>)}</div><p>{t("engagement.projectorStatus", { count: projector.voteCount, state: statusLabel(t, projector.state) })}</p></section></div>;
}

// The prompt's own payload for save_organization_pulse_prompt. The update
// branch rewrites event, question and options, so a pause/resume resends them.
export function pulsePromptPayload(prompt, changes = {}) {
  return {
    ...(prompt?.id ? { id: prompt.id } : {}),
    ...(prompt?.chapterId ? { chapterId: prompt.chapterId } : {}),
    eventKey: prompt?.eventKey,
    question: prompt?.question,
    options: Array.isArray(prompt?.options) ? prompt.options.map((value) => (typeof value === "string" ? value : String(value?.label ?? value?.value ?? ""))).filter(Boolean) : [],
    active: prompt?.active !== false,
    cooldownHours: Number(prompt?.cooldownHours) || 168,
    ...changes,
  };
}

// REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001: a prompt targets one
// of the screens that really ask (the server refuses any other key), named in
// words. A legacy prompt keeps its old key until staff pick a real screen.
function pulseContextName(t, key) {
  const labelKey = pulseContextLabelKey(key);
  return labelKey ? t(labelKey) : t("engagement.pulseContextUnknown", { key: String(key || "") });
}

function PulseContextField({ value, onChange }) {
  const { t } = useLang();
  const selectId = useId();
  const hintId = useId();
  const known = PULSE_CONTEXTS.some((context) => context.key === value);
  return <div className="eng-field">
    <label htmlFor={selectId}>{t("engagement.eventKey")}</label>
    <select id={selectId} required value={value} aria-describedby={hintId} onChange={(event) => onChange(event.target.value)}>
      {!known && <option value={value}>{pulseContextName(t, value)}</option>}
      {PULSE_CONTEXTS.map((context) => <option key={context.key} value={context.key}>{t(pulseContextLabelKey(context.key))}</option>)}
    </select>
    <small id={hintId} className="eng-field__hint">{t(!known ? "engagement.pulseContextHintUnknown" : isProductPulseContext(value) ? "engagement.pulseContextHintProduct" : "engagement.pulseContextHintVoice")}</small>
  </div>;
}

// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 (inventory A3): the
// cooldown (organization_pulse_prompts.cooldown_hours, 1..8760, default 168)
// and the active flag were written as constants; both are now editable, and an
// existing prompt can be edited, paused and resumed.
function PulseEditor({ client, prompt = null, onDone, onNotice }) {
  const { t } = useLang();
  const [eventKey, setEventKey] = useState(prompt?.eventKey || DEFAULT_PULSE_CONTEXT);
  const [question, setQuestion] = useState(prompt?.question || "");
  const [options, setOptions] = useState(() => (prompt ? pulsePromptPayload(prompt).options.join("\n") : `${t("engagement.yes")}\n${t("engagement.no")}`));
  const [cooldownHours, setCooldownHours] = useState(() => String(prompt?.cooldownHours ?? 168));
  const [active, setActive] = useState(prompt ? prompt.active !== false : true);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  async function save(event) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await engagementApi.savePulsePrompt(client, pulsePromptPayload(prompt, {
        eventKey,
        question,
        options: options.split("\n").map((value) => value.trim()).filter(Boolean),
        active,
        cooldownHours: Number(cooldownHours),
      }));
      onNotice(t("engagement.promptSaved"));
      await onDone();
    } catch {
      onNotice(t("engagement.promptSaveFailed"), true);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return <form className="eng-card eng-editor" onSubmit={save}>
    <div className="eng-card__head"><h3>{t("engagement.microPoll")}</h3><button type="button" className="eng-link" onClick={onDone}>{t("engagement.cancel")}</button></div>
    <div className="eng-grid"><PulseContextField value={eventKey} onChange={setEventKey} /><label className="eng-field"><span>{t("engagement.question")}</span><input required maxLength="400" value={question} onChange={(event) => setQuestion(event.target.value)} /></label><label className="eng-field eng-field--wide"><span>{t("engagement.optionsLines")}</span><textarea rows="3" value={options} onChange={(event) => setOptions(event.target.value)} /></label><label className="eng-field"><span>{t("engagement.cooldownHours")}</span><input required type="number" inputMode="numeric" min="1" max="8760" step="1" value={cooldownHours} onChange={(event) => setCooldownHours(event.target.value)} /></label><label className="eng-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> {t("engagement.promptActive")}</label></div>
    <BusyButton type="submit" className="eng-btn" pending={busy} aria-busy={busy || undefined}>{t("engagement.savePrompt")}</BusyButton>
  </form>;
}

function PulsePromptCard({ prompt, client, onEdit, onUpdated, onNotice }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  async function toggle() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await engagementApi.savePulsePrompt(client, pulsePromptPayload(prompt, { active: !prompt.active }));
      onNotice(t(prompt.active ? "engagement.promptPaused" : "engagement.promptResumed"));
      await onUpdated();
    } catch {
      onNotice(t("engagement.promptSaveFailed"), true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return <article className="eng-card" data-pulse-prompt-id={prompt.id}>
    <div className="eng-card__head"><div><span className="eng-kicker">{pulseContextName(t, prompt.eventKey)}</span><h3>{prompt.question}</h3></div><span className="eng-status">{statusLabel(t, prompt.active ? "active" : "paused")}</span></div>
    <p>{t("engagement.pulseCount", { responded: prompt.responded, shown: prompt.shown, hours: prompt.cooldownHours })}</p>
    <div className="eng-actions">
      <BusyButton type="button" className="eng-link" pending={busy} aria-label={t("engagement.editPromptName", { question: prompt.question })} onClick={onEdit}>{t("engagement.editPrompt")}</BusyButton>
      <BusyButton type="button" className="eng-link" pending={busy} aria-busy={busy || undefined} aria-label={t(prompt.active ? "engagement.pausePromptName" : "engagement.resumePromptName", { question: prompt.question })} onClick={toggle}>{t(prompt.active ? "engagement.pausePrompt" : "engagement.resumePrompt")}</BusyButton>
    </div>
  </article>;
}

function ChannelCard({ channel, client, onUpdated, onNotice }) {
  const { t } = useLang();
  const [postingMode, setPostingMode] = useState(channel.postingMode);
  const [slowModeSeconds, setSlowModeSeconds] = useState(channel.slowModeSeconds);
  const [approvalsRequired, setApprovalsRequired] = useState(Boolean(channel.approvalsRequired));
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    setPostingMode(channel.postingMode);
    setSlowModeSeconds(channel.slowModeSeconds);
    setApprovalsRequired(Boolean(channel.approvalsRequired));
  }, [channel]);
  const updateControls = async (changes, message) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if (Object.hasOwn(changes, "postingMode")) setPostingMode(changes.postingMode);
    if (Object.hasOwn(changes, "slowModeSeconds")) setSlowModeSeconds(changes.slowModeSeconds);
    if (Object.hasOwn(changes, "approvalsRequired")) setApprovalsRequired(changes.approvalsRequired);
    try {
      await engagementApi.setChannelControls(client, channel.spaceId, { ...channel, ...changes });
      onNotice(message);
      await onUpdated();
    } catch {
      setPostingMode(channel.postingMode);
      setSlowModeSeconds(channel.slowModeSeconds);
      setApprovalsRequired(Boolean(channel.approvalsRequired));
      onNotice(t("engagement.channelUpdateFailed"), true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const chapter = channel.chapterName || "";
  return <article className="eng-card" aria-label={chapter ? t("engagement.channelCardNamed", { name: channel.name, chapter }) : undefined}><div className="eng-card__head"><div>{chapter && <span className="eng-kicker">{t("engagement.channelChapter", { chapter })}</span>}<h3>{channel.name}</h3></div><Settings2 /></div><div className="eng-grid"><label className="eng-field"><span>{t("engagement.posting")}</span><BusySelect value={postingMode} pending={busy} onChange={(event) => updateControls({ postingMode: event.target.value }, t("engagement.postingUpdated"))}><option value="members">{t("engagement.members")}</option><option value="staff_only">{t("engagement.staffOnly")}</option><option value="read_only">{t("engagement.readOnly")}</option></BusySelect></label><label className="eng-field"><span>{t("engagement.slowSeconds")}</span><BusyInput type="number" min="0" max="86400" value={slowModeSeconds ?? ""} pending={busy} onChange={(event) => setSlowModeSeconds(event.target.value)} onBlur={(event) => updateControls({ slowModeSeconds: event.target.value }, t("engagement.slowUpdated"))} /></label><label className="eng-check"><BusyInput type="checkbox" checked={Boolean(approvalsRequired)} pending={busy} onChange={(event) => updateControls({ approvalsRequired: event.target.checked }, t("engagement.approvalUpdated"))} /> {t("engagement.requireApproval")}</label></div></article>;
}

// BUG-UG-WEB-ENGAGEMENT-CHANNEL-CARDS-OMIT-CHAPTER-20261002: every
// chapter has the same four spaces, so 20 chapters drew 80 cards nobody could
// tell apart. The snapshot now names each space's chapter: the cards sit in one
// collapsible group per chapter (the first open) and each card names its
// chapter. A snapshot without chapters keeps the flat list.
export function ChannelOperations({ channels, client, onUpdated, onNotice }) {
  const { t } = useLang();
  const card = (channel) => <ChannelCard key={channel.spaceId} channel={channel} client={client} onUpdated={onUpdated} onNotice={onNotice} />;
  // An organization with no discussion spaces used to get a blank tab
  // (REQ-UG-SINGLE-SIGHTING-DEFECTS-20261030, finding 79).
  if (!channels.length) return <p className="eng-state">{t("engagement.channelsEmpty")}</p>;
  if (!channels.some((channel) => channel.chapterId)) return <div className="eng-stack">{channels.map(card)}</div>;
  const groups = new Map();
  for (const channel of channels) {
    const key = channel.chapterId || "";
    if (!groups.has(key)) groups.set(key, { key, name: channel.chapterName || t("engagement.channelNoChapter"), channels: [] });
    groups.get(key).channels.push(channel);
  }
  return <div className="eng-stack">{[...groups.values()].map((group, index) => <details className="eng-details eng-channel-group" key={group.key} open={index === 0 || undefined}><summary>{t("engagement.channelChapterGroup", { chapter: group.name, count: group.channels.length })}</summary><div className="eng-stack">{group.channels.map(card)}</div></details>)}</div>;
}

// onSnapshotChanged: every accepted weekly write here can publish, reserve or
// change a survey members answer, so it drops the shell's cached member
// engagement snapshot as the other staff writes do (gate r6s1 on #8260).
function WeeklyEditorial({ client, onNotice, onSnapshotChanged = null }) {
  const { t, lang } = useLang();
  const [items, setItems] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [policy, setPolicy] = useState({ enabled: false, cadenceDays: 7, minimumPoolSize: 3, selectionCount: 1, priorityRule: "weighted_random", nextRunAt: "" });
  const [prioritySlot, setPrioritySlot] = useState(true);
  const [archive, setArchive] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [runResult, setRunResult] = useState(null);
  const [notes, setNotes] = useState({});
  const [floors, setFloors] = useState({});
  const [busyId, setBusyId] = useState("");
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const toggleArchive = () => { setItems(null); setArchive((current) => !current); };
  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const workspace = await engagementApi.loadWeeklySelection(client);
      const current = workspace?.policy || {};
      setPolicy({
        enabled: Boolean(current.enabled),
        cadenceDays: Number(current.cadence_days ?? current.cadenceDays ?? 7),
        minimumPoolSize: Number(current.minimum_pool_size ?? current.minimumPoolSize ?? 3),
        selectionCount: Number(current.selection_count ?? current.selectionCount ?? 1),
        priorityRule: WEEKLY_PRIORITY_RULES.includes(current.priority_rule) ? current.priority_rule : "weighted_random",
        nextRunAt: current.next_run_at || current.nextRunAt || "",
      });
      setPrioritySlot(workspace?.prioritySlot !== false);
      setRunResult(current.last_result || current.lastResult || null);
      if (archive) {
        const page = await engagementApi.loadWeeklySelectionPage(client, "archive");
        setItems(page?.items || []);
        setNextCursor(page?.nextCursor || null);
      } else {
        setItems(workspace?.items || []);
        setNextCursor(workspace?.nextCursor || null);
      }
    }
    catch (error) {
      setLoadFailed(true);
      onNotice(rpcErrorText(t, error, "engagement.weeklyLoadFailed"), true);
    }
  }, [archive, client, onNotice, t]);
  useEffect(() => { load(); }, [load]);
  function act(item, operation, message) {
    return runBusyWrite(busyWriteRef, `item:${item.id}`, () => actNow(item, operation, message));
  }

  async function actNow(item, operation, message) {
    setBusyId(item.id);
    try { await operation(); onNotice(message); onSnapshotChanged?.(); await load(); }
    catch { onNotice(t("engagement.weeklyUpdateFailed"), true); }
    finally { setBusyId(""); }
  }
  function loadOlder() {
    return runBusyWrite(busyWriteRef, "page", () => loadOlderNow());
  }

  async function loadOlderNow() {
    if (!nextCursor) return;
    setBusyId("page");
    try {
      const page = await engagementApi.loadWeeklySelectionPage(client, archive ? "archive" : "active", nextCursor);
      setItems((current) => [...current, ...(page?.items || [])]);
      setNextCursor(page?.nextCursor || null);
    } catch {
      onNotice(t("engagement.olderLoadFailed"), true);
    } finally {
      setBusyId("");
    }
  }
  if (loadFailed) return <section className="eng-state" role="alert"><p>{t("engagement.weeklyLoadFailed")}</p><button type="button" className="eng-btn" onClick={load}>{t("app.tryAgain")}</button><button type="button" className="eng-btn eng-btn--quiet" aria-pressed={archive} onClick={toggleArchive}>{archive ? t("engagement.showActive") : t("engagement.showArchive")}</button></section>;
  if (!items) return <p className="eng-state" role="status">{t("engagement.weeklyLoading")}</p>;
  const visible = items;
  return <div className="eng-stack">
    <form className="eng-card eng-weekly-policy" onSubmit={(event) => runBusyWrite(busyWriteRef, "policy", async () => {
      event.preventDefault(); setBusyId("policy");
      try { await engagementApi.saveWeeklySelectionPolicy(client, policy); onNotice(t("engagement.policySaved")); onSnapshotChanged?.(); await load(); }
      catch { onNotice(t("engagement.policySaveFailed"), true); }
      finally { setBusyId(""); }
    }, event)}>
      <div className="eng-card__head"><div><span className="eng-kicker">{t("engagement.governedSelection")}</span><h3>{t("engagement.weeklyPolicy")}</h3><p>{t("engagement.policyHelp")}</p></div><span className={`eng-status${policy.enabled ? " eng-status--open" : ""}`}>{statusLabel(t, policy.enabled ? "enabled" : "manual")}</span></div>
      <div className="eng-grid"><label className="eng-check"><input type="checkbox" checked={policy.enabled} onChange={(event) => setPolicy((current) => ({ ...current, enabled: event.target.checked }))} /> {t("engagement.enableSelection")}</label><label className="eng-field"><span>{t("engagement.cadenceDays")}</span><input type="number" min="1" max="31" value={policy.cadenceDays} onChange={(event) => setPolicy((current) => ({ ...current, cadenceDays: event.target.value }))} /></label><label className="eng-field"><span>{t("engagement.minimumPool")}</span><input type="number" min="1" max="100" value={policy.minimumPoolSize} onChange={(event) => setPolicy((current) => ({ ...current, minimumPoolSize: event.target.value }))} /></label><label className="eng-field"><span>{t("engagement.questionsReserve")}</span><input type="number" min="1" max="10" value={policy.selectionCount} onChange={(event) => setPolicy((current) => ({ ...current, selectionCount: event.target.value }))} /></label><label className="eng-field"><span>{t("engagement.nextRun")}</span><input type="datetime-local" value={localDateTimeInputValue(policy.nextRunAt)} onChange={(event) => setPolicy((current) => ({ ...current, nextRunAt: event.target.value ? new Date(event.target.value).toISOString() : "" }))} /></label><label className="eng-field"><span>{t("engagement.selectionRule")}</span><select value={policy.priorityRule} onChange={(event) => setPolicy((current) => ({ ...current, priorityRule: event.target.value }))}><option value="weighted_random">{t("engagement.ruleWeightedRandom")}</option><option value="support_then_oldest">{t("engagement.ruleSupportThenOldest")}</option></select></label></div>
      <p>{t(policy.priorityRule === "support_then_oldest" ? "engagement.priorityHelp" : "engagement.priorityHelpWeighted")}</p>
      <p>{t(prioritySlot ? "engagement.prioritySlotOn" : "engagement.prioritySlotOff")}</p>
      {runResult && <p role="status">{t("engagement.lastRun", { selected: runResult.selectedCount ?? runResult.selected_count ?? 0, pool: runResult.poolCount ?? runResult.pool_count ?? 0 })}{runResult.rule === "weighted_random" && runResult.seed ? ` ${t("engagement.lastRunSeed", { seed: runResult.seed })}` : ""}</p>}
      <div className="eng-actions"><BusyButton type="submit" className="eng-btn eng-btn--quiet" pending={busyId === "policy"}>{t("engagement.savePolicy")}</BusyButton><BusyButton type="button" className="eng-btn" pending={busyId === "policy"} disabled={!policy.enabled} onClick={() => runBusyWrite(busyWriteRef, "policy", async () => { setBusyId("policy"); try { const result = await engagementApi.runWeeklySelection(client); setRunResult(result); onNotice(t("engagement.reservedCount", { count: result.selectedCount || 0 })); onSnapshotChanged?.(); await load(); } catch { onNotice(t("engagement.selectionFailed"), true); } finally { setBusyId(""); } })}>{t("engagement.runNow")}</BusyButton></div>
    </form>
    <div className="eng-toolbar"><p>{archive ? t("engagement.archiveHelp") : t("engagement.activeHelp")}</p><button type="button" className="eng-btn eng-btn--quiet" aria-pressed={archive} onClick={toggleArchive}>{archive ? t("engagement.showActive") : t("engagement.showArchive")}</button></div>
    {visible.length === 0 && <p className="eng-card">{archive ? t("engagement.archiveEmpty") : t("engagement.activeEmpty")}</p>}
    {visible.map((item) => <article className="eng-card eng-weekly-editorial" key={item.id}>
    <div className="eng-card__head"><div><span className="eng-kicker">{t("engagement.weekSupport", { date: new Date(`${item.weekStart}T12:00:00`).toLocaleDateString(localeFor(lang)), count: item.score })}</span><h3>{item.body}</h3></div><span className={`eng-status eng-status--${item.editorialState}`}>{statusLabel(t, item.editorialState)}</span></div>
    <div className="eng-choice-row" aria-label={t("engagement.answerOptions")}>{(item.options || []).map((option) => <span className="eng-chip" key={String(option)}>{option}</span>)}</div>
    {item.editorNote && <p><strong>{t("engagement.editorialNote")}</strong> {item.editorNote}</p>}
    {["submitted", "reserved"].includes(item.editorialState) && <><div className="eng-grid"><label className="eng-field"><span>{t("engagement.editorialNoteOptional")}</span><input maxLength="1000" value={notes[item.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} /></label><label className="eng-field"><span>{t("engagement.publicationPrivacy")}</span><input type="number" min="3" max="50" value={floors[item.id] || 5} onChange={(event) => setFloors((current) => ({ ...current, [item.id]: Number(event.target.value) }))} /></label></div><div className="eng-actions"><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busyId === item.id} onClick={() => act(item, () => engagementApi.reviewWeeklyQuestion(client, item.id, "reserved", notes[item.id] || null), t("engagement.questionReserved"))}>{t("engagement.reserve")}</BusyButton><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busyId === item.id} onClick={() => act(item, () => engagementApi.reviewWeeklyQuestion(client, item.id, "submitted", notes[item.id] || null), t("engagement.questionReturned"))}>{t("engagement.return")}</BusyButton><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busyId === item.id} onClick={() => act(item, () => engagementApi.reviewWeeklyQuestion(client, item.id, "archived", notes[item.id] || null), t("engagement.questionArchived"))}>{t("engagement.archive")}</BusyButton><BusyButton type="button" className="eng-btn" pending={busyId === item.id} disabled={!(item.options || []).length} onClick={() => act(item, () => engagementApi.publishWeeklyQuestion(client, item.id, floors[item.id] || 5), t("engagement.weeklyPublished"))}>{t("engagement.publish")}</BusyButton></div></>}
    {item.editorialState === "published" && item.publishedSurveyId && <p><strong>{t("engagement.publishedSurvey")}</strong> {item.publishedSurveyId}</p>}
  </article>)}{nextCursor && <BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busyId === "page"} onClick={loadOlder}>{t("engagement.loadOlder")}</BusyButton>}</div>;
}

// onSnapshotChanged: told after every accepted staff write here (a survey
// published, closed or reopened, a poll or prompt changed), so the shell drops
// the member engagement snapshot it caches for Home, Voting and VP
// (BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111, gate r4s1 on #8260).
// organizationSnapshot=false: the account holds no organization-wide staff role,
// so the organization-wide snapshot always refuses it (42501); the studio goes straight
// to the chapter-only Weekly pool instead of making a call it knows is refused
// (BUG-UG-STEWARD-SCREENS-CALL-READS-REFUSED-FOR-UNIT-STEWARDS-20261115).
export function StaffEngagement({ client, session, onNotice: announce = () => {}, onSnapshotChanged = null, organizationSnapshot = true }) {
  const { t } = useLang();
  const [snapshot, setSnapshot] = useState(null); const [meetings, setMeetings] = useState(null); const [error, setError] = useState(""); const [tab, setTab] = useRoutedTab("engagement", "surveys"); const [editor, setEditor] = useState(""); const [editingSurvey, setEditingSurvey] = useState(null); const [notice, setNotice] = useState({ text: "", error: false }); const [projector, setProjector] = useState(null); const [deliveryStatus, setDeliveryStatus] = useState(null);
  const projectorReturnFocusRef = useRef(null);
  const projectorRestoreTimerRef = useRef(0);
  const closeProjector = useCallback(() => setProjector(null), []);
  const load = useCallback(async () => {
    if (!client) return;
    try {
      if (!organizationSnapshot) throw Object.assign(new Error("organization staff role required"), { code: "42501" });
      setSnapshot(await engagementApi.loadStaff(client)); setError("");
      // The poll meetings ride beside the snapshot; without them polls render
      // as before (no picker, no meeting line).
      engagementApi.loadLivePollMeetings(client).then(setMeetings, () => setMeetings(null));
    }
    catch (loadError) {
      // Chapter-only staff hats are refused the organization-wide snapshot but
      // may run their own chapter's weekly selection; show only that tab.
      if (loadError?.code === "42501") {
        try { await engagementApi.loadWeeklySelection(client); setSnapshot({ weeklyOnly: true }); setError(""); return; }
        catch { /* keep the snapshot refusal */ }
      }
      setError(t("engagement.unavailable"));
    }
  }, [client, t, organizationSnapshot]);
  const tell = useCallback((text, isError = false) => { setNotice({ text, error: isError }); announce(text); }, [announce]);
  const snapshotChangedRef = useRef(onSnapshotChanged);
  snapshotChangedRef.current = onSnapshotChanged;
  const refreshAfterWrite = useCallback(async () => {
    snapshotChangedRef.current?.();
    await load();
  }, [load]);
  // Every editor open remounts SurveyEditor, which reads `initial` only once.
  const [editorSeq, setEditorSeq] = useState(0);
  const editSurvey = useCallback(async (survey) => {
    // The draft read carries content only; the operations fields come from the
    // staff snapshot so a draft save does not reset them.
    try { setEditingSurvey({ ...(await engagementApi.loadSurveyDraft(client, survey.id)), ...surveyOperationsFields(survey) }); setEditorSeq((seq) => seq + 1); setEditor("survey"); }
    catch { tell(t("engagement.draftLoadFailed"), true); }
  }, [client, tell, t]);
  useEffect(() => { load(); }, [load]);
  // Issue intelligence "Use this draft" (REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001,
  // old /dashboard/polls?draft=): open a new survey prefilled with the plain-text
  // question once the workspace has loaded, then drop the parameter so a reload
  // or Back never reopens it. Nothing is saved until staff save the survey.
  const [issueDraft, setIssueDraft] = useState(() => (typeof window === "undefined" ? null : readIssueDraft(window.location.search)));
  useEffect(() => {
    if (!issueDraft || !snapshot || snapshot.weeklyOnly) return;
    setIssueDraft(null);
    setEditingSurvey({ title: t("issueIntelligence.poll.draftTitle"), questions: [{ type: "paragraph", label: issueDraft, required: true }] });
    setEditorSeq((seq) => seq + 1);
    setEditor("survey");
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(ISSUE_DRAFT_PARAM);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch { /* the editor is already open */ }
    tell(t("issueIntelligence.draftLoaded"));
  }, [issueDraft, snapshot, t, tell]);
  // null while the status read is in flight, so "not activated" is only ever
  // shown for a provider the endpoint actually reported as unset.
  const [deliveryAttempt, setDeliveryAttempt] = useState(0);
  // Organization switches the member-safe configuration read exposes; an
  // unknown or unreadable value keeps the registered default (on).
  const [switches, setSwitches] = useState(null);
  useEffect(() => {
    if (!client) return undefined;
    let active = true;
    engagementApi.loadOrganizationSwitches(client)
      .then((configuration) => { if (active) setSwitches(configuration?.switches && typeof configuration.switches === "object" ? configuration.switches : null); })
      .catch(() => { if (active) setSwitches(null); });
    return () => { active = false; };
  }, [client]);
  const autoSchedule = switches?.["features.engagement_voice.live_poll_auto_open_close"] !== false;
  // REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001: derived survey
  // attention, re-read with every staff snapshot; a refusal shows none.
  const [surveyAttention, setSurveyAttention] = useState(null);
  useEffect(() => {
    if (!client || !snapshot || snapshot.weeklyOnly) return undefined;
    let active = true;
    engagementApi.loadSurveyAttention(client)
      .then((value) => {
        if (!active) return;
        const bySurvey = Object.fromEntries((Array.isArray(value?.surveys) ? value.surveys : []).map((item) => [item.surveyId, item]));
        setSurveyAttention({ exports: value?.exports !== false, bySurvey });
      })
      .catch(() => { if (active) setSurveyAttention(null); });
    return () => { active = false; };
  }, [client, snapshot]);
  useEffect(() => {
    if (tab !== "delivery") return undefined;
    let active = true;
    setDeliveryStatus(null);
    loadEngagementDeliveryStatus(session)
      .then((status) => { if (active) setDeliveryStatus(status); })
      .catch(() => { if (active) setDeliveryStatus({ configured: false, unavailable: true }); });
    return () => { active = false; };
  }, [session, tab, deliveryAttempt]);
  useEffect(() => () => {
    window.clearTimeout(projectorRestoreTimerRef.current);
    projectorRestoreTimerRef.current = 0;
  }, []);
  // #9543: the tab strip scrolls sideways at narrow widths. A tab reached by
  // keyboard, and the current tab when the strip is drawn or the tab changes,
  // is brought fully into the strip by moving the strip only, never the page.
  const tabStripRef = useRef(null);
  const tabStripShown = Boolean(client && !error && snapshot);
  useEffect(() => revealFocusedInStrip(tabStripRef.current), [tabStripShown]);
  useLayoutEffect(() => { revealCurrentInStrip(tabStripRef.current); }, [tabStripShown, tab, snapshot?.weeklyOnly]);
  const tabs = [{ id: "surveys", label: t("engagement.surveys"), icon: ClipboardList }, { id: "weekly", label: t("engagement.weeklyPool"), icon: Radio }, { id: "polls", label: t("engagement.livePolls"), icon: Radio }, { id: "pulse", label: t("engagement.contextual"), icon: BarChart3 }, { id: "delivery", label: t("engagement.delivery"), icon: Mail }, { id: "channels", label: t("engagement.channels"), icon: Users }];
  const weeklyOnly = Boolean(snapshot?.weeklyOnly);
  const visibleTabs = weeklyOnly ? tabs.filter((entry) => entry.id === "weekly") : tabs;
  const activeTab = weeklyOnly ? "weekly" : tab;
  // BUG-UG-ENGAGEMENT-STUDIO-ADDRESSES-ALL-SHOW-WEEKLY-POOL-20261111:
  // a chapter-only staff role is refused the organization snapshot and keeps
  // only the Weekly pool. Every other studio address says so, naming the page
  // the address asked for and who can open it, rather than silently showing
  // the Weekly pool.
  const withheld = weeklyOnly && tab !== "weekly" ? tabs.find((entry) => entry.id === tab) : null;
  if (!client) return null;
  if (error) return <section className="eng-state" role="alert"><p>{error}</p><button type="button" className="eng-btn" onClick={load}>{t("engagement.tryAgain")}</button></section>;
  if (!snapshot) return <p className="eng-state" role="status">{t("engagement.loading")}</p>;
  return <section className="eng-root eng-staff" data-testid="staff-engagement"><div className="eng-section-head"><div><span className="eng-kicker">{t("engagement.operations")}</span><h2>{t("engagement.workspaceTitle")}</h2></div><span className="eng-presence">{t("engagement.onlineCount", { count: snapshot.presence?.online || 0 })}</span></div>{notice.text && <p className={`eng-notice${notice.error ? " eng-notice--error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {weeklyOnly && <p className="eng-notice" role="status" data-testid="engagement-role-limited">{withheld ? t("engagement.roleLimitedPage", { page: withheld.label }) : t("engagement.roleLimited")}</p>}
    <nav ref={tabStripRef} className="eng-tabs" aria-label={t("engagement.workspace")}>{visibleTabs.map(({ id, label, icon: Icon }) => <RoutedTabLink group="engagement" value={id} type="button" key={id} aria-pressed={activeTab === id} onClick={() => { setTab(id); setEditor(""); }}><Icon size={16} />{label}</RoutedTabLink>)}</nav>
    {activeTab === "surveys" && <><div className="eng-toolbar"><p>{t("engagement.surveysHelp")}</p><div className="eng-actions"><button type="button" className="eng-btn" onClick={() => { setEditingSurvey(null); setEditorSeq((seq) => seq + 1); setEditor("survey"); }}>{t("engagement.newSurvey")}</button></div></div>{editor === "survey" && <SurveyEditor key={editorSeq} initial={editingSurvey} client={client} chapters={snapshot.chapters || []} onDone={async () => { setEditor(""); await refreshAfterWrite(); }} onNotice={tell} />}<SurveyList snapshot={snapshot} client={client} onUpdated={refreshAfterWrite} onNotice={tell} onEdit={editSurvey} attention={surveyAttention} /></>}
    {activeTab === "weekly" && <><div className="eng-toolbar"><p>{t("engagement.weeklyHelp")}</p></div><WeeklyEditorial client={client} onNotice={tell} onSnapshotChanged={() => snapshotChangedRef.current?.()} /></>}
    {activeTab === "polls" && <><div className="eng-toolbar"><p>{t("engagement.pollsHelp")}</p><button type="button" className="eng-btn" onClick={() => setEditor("poll")}>{t("engagement.newPoll")}</button></div>{editor === "poll" && <LivePollEditor client={client} session={session} members={snapshot.members || []} chapters={snapshot.chapters || []} meetings={meetings} autoSchedule={autoSchedule} onDone={async () => { setEditor(""); await refreshAfterWrite(); }} onNotice={tell} />}{(snapshot.livePolls || []).map((poll) => <LivePollCard key={poll.id} poll={poll} client={client} meetings={meetings} autoSchedule={autoSchedule} onUpdated={refreshAfterWrite} onNotice={tell} onProject={(nextProjector, opener) => { projectorReturnFocusRef.current = opener; setProjector(nextProjector); }} />)}</>}
    {activeTab === "pulse" && <><div className="eng-toolbar"><p>{t("engagement.pulseHelp")}</p><button type="button" className="eng-btn" onClick={() => setEditor("pulse")}>{t("engagement.newPrompt")}</button></div>{editor === "pulse" && <PulseEditor client={client} onDone={async () => { setEditor(""); await refreshAfterWrite(); }} onNotice={tell} />}{(snapshot.pulsePrompts || []).map((prompt) => (editor === `pulse:${prompt.id}`
      ? <PulseEditor key={prompt.id} client={client} prompt={prompt} onDone={async () => { setEditor(""); await refreshAfterWrite(); }} onNotice={tell} />
      : <PulsePromptCard key={prompt.id} prompt={prompt} client={client} onEdit={() => setEditor(`pulse:${prompt.id}`)} onUpdated={refreshAfterWrite} onNotice={tell} />))}</>}
    {activeTab === "delivery" && <article className="eng-card"><div className="eng-card__head"><div><span className="eng-kicker">{t("engagement.recipientHistory")}</span><h3>{t("engagement.emailQueue")}</h3></div><span className={`eng-status${deliveryStatus?.configured ? " eng-status--open" : ""}`}>{statusLabel(t, !deliveryStatus ? "checking" : deliveryStatus.unavailable ? "unavailable" : deliveryStatus.configured ? "configured" : "notActivated")}</span></div><div className="eng-metrics">{["queued", "leased", "sent", "failed", "suppressed"].map((state) => <div key={state}><span>{statusLabel(t, state)}</span><strong>{snapshot.delivery?.[state] || 0}</strong></div>)}</div>{!deliveryStatus ? <p role="status">{t("engagement.deliveryChecking")}</p> : deliveryStatus.unavailable ? <div className="eng-state" role="alert"><p>{t("engagement.deliveryStatusFailed")}</p><button type="button" className="eng-btn" onClick={() => setDeliveryAttempt((attempt) => attempt + 1)}>{t("engagement.tryAgain")}</button></div> : <p>{deliveryStatus.configured ? t("engagement.deliveryActive") : t("engagement.deliveryInactive")}</p>}</article>}
    {activeTab === "channels" && <ChannelOperations channels={snapshot.channels || []} client={client} onUpdated={refreshAfterWrite} onNotice={tell} />}
    {projector && <ProjectorDialog projector={projector} returnFocusRef={projectorReturnFocusRef} restoreTimerRef={projectorRestoreTimerRef} onClose={closeProjector} />}
  </section>;
}
