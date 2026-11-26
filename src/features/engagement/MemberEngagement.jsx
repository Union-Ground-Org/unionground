import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRing, CheckCircle2, ClipboardList, Radio, Sparkles } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { engagementApi, subscribeToLivePolls } from "./api.js";
import { BusyButton, BusyFieldset, BusyInput, BusySelect, BusyTextarea } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { isOfflineError } from "../../lib/outbox.js";
import { useLearningUndone } from "../learningPeriod/undoneSignal.js";
// The Native App Reads The Web Surveys: The survey
// answer model is shared with apps/mobile, so option reading and branch
// visibility live in surveyModel.js rather than in this component.
import { SURVEY_TEXT_LIMITS, optionLabel, optionValue, pruneHiddenAnswers, visibleQuestions } from "./surveyModel.js";
import "./engagement.css";

// Members do not receive postgres_changes for after_close rows until they are
// closed, or for staff_only rows at all (organization_live_polls_member_read).
// Re-fetch the security-definer snapshot on this budget while any live poll is
// scheduled, and while an open staff_only poll still needs a close observation.
export const SCHEDULED_POLL_REFRESH_MS = 20_000;

function needsSnapshotRefresh(snapshot) {
  return (snapshot?.livePolls || []).some((poll) => {
    if (poll.state === "scheduled") return true;
    return poll.state === "open" && poll.resultsVisibility === "staff_only";
  });
}

function pollStateLabel(t, state) {
  const key = `engagement.state.${state}`;
  const label = t(key);
  return label === key ? t("engagement.state.unknown") : label;
}

function moduleLabel(t, module) {
  const key = `engagement.member.module.${module}`;
  const label = t(key);
  return label === key ? module[0].toUpperCase() + module.slice(1) : label;
}

function sourceKindLabel(t, sourceKind) {
  const key = `engagement.member.sourceKind.${sourceKind}`;
  const label = t(key);
  return label === key ? sourceKind : label;
}

//  W5-8: a refused survey save says why. The server's reply is matched
// whole and never shown; an unknown reply keeps the neutral line.
const SURVEY_REFUSAL_KEYS = new Map([
  ["survey session already submitted", "engagement.member.surveyAlreadySubmitted"],
  ["not found", "engagement.member.surveyClosed"],
  ["answer is not an available option", "engagement.member.surveyAnswerUnavailable"],
]);
// A blank required text answer is refused as "invalid text answer".
const SURVEY_MISSING_REPLIES = new Set(["required survey questions are missing", "invalid text answer"]);

function serverReply(error) {
  const message = String(error?.message || "");
  return message.slice(message.lastIndexOf(": ") + 1).trim();
}

function unanswered(value) {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "string" && value.trim() === "";
}

function SurveyQuestion({ question, value, onChange, pending, t }) {
  const id = `eng-q-${question.id}`;
  const options = Array.isArray(question.options) ? question.options : [];
  if (question.type === "paragraph" || question.type === "text") {
    const Element = question.type === "paragraph" ? BusyTextarea : BusyInput;
    return <label className="eng-field" htmlFor={id}>
      <span>{question.label}{question.required ? " *" : ""}</span>
      <Element id={id} rows={question.type === "paragraph" ? 4 : undefined} required={question.required} maxLength={question.type === "paragraph" ? SURVEY_TEXT_LIMITS.paragraph : SURVEY_TEXT_LIMITS.text} value={value ?? ""} pending={pending} onChange={(event) => onChange(event.target.value)} />
    </label>;
  }
  if (question.type === "scale" || question.type === "rating") {
    const scale = options.length ? options : [1, 2, 3, 4, 5];
    return <BusyFieldset className="eng-fieldset" pending={pending}>
      <legend>{question.label}{question.required ? " *" : ""}</legend>
      <div className="eng-choice-row">
        {scale.map((option) => <label key={String(optionValue(option))}>
          <input type="radio" name={id} required={question.required} checked={String(value ?? "") === String(optionValue(option))} onChange={() => onChange(optionValue(option))} />
          <span>{optionLabel(option)}</span>
        </label>)}
      </div>
    </BusyFieldset>;
  }
  if (question.type === "checkbox") {
    const selected = Array.isArray(value) ? value : [];
    return <BusyFieldset className="eng-fieldset" pending={pending}>
      <legend>{question.label}{question.required ? " *" : ""}</legend>
      <div className="eng-options">
        {options.map((option) => {
          const next = optionValue(option);
          const checked = selected.some((item) => String(item) === String(next));
          const atLimit = question.maxSelections && selected.length >= question.maxSelections;
          return <label key={String(next)}><input type="checkbox" checked={checked} disabled={!checked && atLimit} onChange={() => onChange(checked ? selected.filter((item) => String(item) !== String(next)) : [...selected, next])} /> <span>{optionLabel(option)}</span></label>;
        })}
      </div>
      {question.maxSelections && <small>{t("engagement.member.chooseUpTo", { count: question.maxSelections })}</small>}
    </BusyFieldset>;
  }
  if (question.type === "dropdown") {
    return <label className="eng-field" htmlFor={id}><span>{question.label}{question.required ? " *" : ""}</span><BusySelect id={id} required={question.required} value={value ?? ""} pending={pending} onChange={(event) => onChange(event.target.value || undefined)}><option value="">{t("engagement.chooseAnswer")}</option>{options.map((option) => <option key={String(optionValue(option))} value={String(optionValue(option))}>{optionLabel(option)}</option>)}</BusySelect></label>;
  }
  const choices = question.type === "yes_no" && !options.length
    ? [{ value: "yes", label: t("engagement.yes") }, { value: "no", label: t("engagement.no") }]
    : options;
  return <BusyFieldset className="eng-fieldset" pending={pending}>
    <legend>{question.label}{question.required ? " *" : ""}</legend>
    <div className="eng-options">
      {choices.map((option) => <label key={String(optionValue(option))}>
        <input type="radio" name={id} required={question.required} checked={String(value ?? "") === String(optionValue(option))} onChange={() => onChange(optionValue(option))} />
        <span>{optionLabel(option)}</span>
      </label>)}
    </div>
  </BusyFieldset>;
}

function SurveyFlow({ client, survey, onUpdated, onNotice }) {
  const { t } = useLang();
  const [answers, setAnswers] = useState(survey.session?.answers || {});
  const visible = useMemo(() => visibleQuestions(survey, answers), [survey, answers]);
  const sections = useMemo(() => {
    const result = [];
    for (const question of visible) {
      const key = question.sectionKey || "main";
      let section = result.find((item) => item.key === key);
      if (!section) {
        section = {
          key,
          // An author-authored section title is data; only the fallback is chrome.
          title: question.sectionTitle
            || (result.length ? t("engagement.member.sectionNumber", { number: result.length + 1 }) : t("engagement.member.sectionDefault")),
        };
        result.push(section);
      }
    }
    return result.length ? result : [{ key: "main", title: t("engagement.member.sectionDefault") }];
  }, [visible, t]);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  // The last refused save or submit, shown beside the buttons.
  const [problem, setProblem] = useState(null);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const activeSectionIndex = Math.min(sectionIndex, sections.length - 1);
  const questions = visible.filter((question) => (question.sectionKey || "main") === sections[activeSectionIndex]?.key);
  const submitted = survey.session?.status === "submitted";

  function save(nextIndex = sectionIndex) {
    return runBusyWrite(busyWriteRef, "survey", () => saveNow(nextIndex));
  }

  // Recomputed each render: an answered or hidden question drops out.
  const sectionOf = (question) => sections.findIndex((section) => section.key === (question.sectionKey || "main"));
  const stillMissing = visible.filter((question) => question.required && unanswered(answers[question.id]));

  // A refusal names its cause; a lost reply is told as unconfirmed.
  function refusal(error, fallbackKey) {
    const reply = serverReply(error);
    if (error?.code && SURVEY_MISSING_REPLIES.has(reply)) {
      if (stillMissing.length) {
        setSectionIndex(Math.max(0, sectionOf(stillMissing[0])));
        return { missing: true };
      }
      if (reply !== "invalid text answer") return { key: "engagement.member.surveyRequiredMissing" };
    }
    if (error?.code && SURVEY_REFUSAL_KEYS.has(reply)) return { key: SURVEY_REFUSAL_KEYS.get(reply) };
    if (!error?.code && isOfflineError(error)) return { key: "engagement.member.surveyUnconfirmed" };
    return { key: fallbackKey };
  }

  async function saveNow(nextIndex = sectionIndex) {
    setBusy(true);
    setProblem(null);
    onNotice("");
    try {
      await engagementApi.saveSurveySession(client, survey.id, pruneHiddenAnswers(survey, answers));
      setSectionIndex(nextIndex);
      onNotice(t("engagement.member.progressSaved"));
      await onUpdated();
    } catch (error) { setProblem(refusal(error, "engagement.surveyProgressFailed")); }
    finally { setBusy(false); }
  }

  function submit(event) {
    return runBusyWrite(busyWriteRef, "survey", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    onNotice("");
    try {
      await engagementApi.submitSurveySession(client, survey.id, pruneHiddenAnswers(survey, answers));
      onNotice(t("engagement.member.surveySubmitted"));
      await onUpdated();
    } catch (error) { setProblem(refusal(error, "engagement.surveySubmitFailed")); }
    finally { setBusy(false); }
  }

  return <form className="eng-card eng-survey" id={`eng-survey-${survey.id}`} onSubmit={submit}>
    <div className="eng-card__head"><div><span className="eng-kicker">{survey.cadence === "quarterly" ? survey.periodKey || t("engagement.member.quarterlyKicker") : t("engagement.member.surveyKicker")}</span><h3 tabIndex={-1}>{survey.title}</h3></div>{submitted && <CheckCircle2 aria-label={t("engagement.member.submittedIcon")} />}</div>
    {survey.description && <p>{survey.description}</p>}
    {submitted ? <p className="eng-success">{t("engagement.member.responseComplete")}</p> : <>
      {sections.length > 1 && <div className="eng-step" aria-label={t("engagement.member.sectionsLabel")}><span>{t("engagement.member.sectionProgress", { current: activeSectionIndex + 1, total: sections.length })}</span><strong>{sections[activeSectionIndex]?.title}</strong></div>}
      {questions.map((question) => <SurveyQuestion key={question.id} question={question} value={answers[question.id]} pending={busy} t={t} onChange={(value) => setAnswers((current) => {
        const next = { ...current };
        if (value === undefined) delete next[question.id];
        else next[question.id] = value;
        return next;
      })} />)}
      {problem && !(problem.missing && !stillMissing.length) && <div className="eng-notice eng-notice--error" role="alert">
        {problem.missing
          ? <><p>{t("engagement.member.requiredMissing")}</p><ul>{stillMissing.map((question) => <li key={question.id}>{t("engagement.member.requiredQuestion", { question: question.label, section: sections[sectionOf(question)]?.title })}</li>)}</ul></>
          : <p>{t(problem.key)}</p>}
      </div>}
      <div className="eng-actions">
        {activeSectionIndex > 0 && <BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={() => setSectionIndex((value) => value - 1)}>{t("engagement.member.back")}</BusyButton>}
        {activeSectionIndex < sections.length - 1
          ? <BusyButton type="button" className="eng-btn" pending={busy} onClick={() => save(activeSectionIndex + 1)}>{busy ? t("engagement.member.saving") : t("engagement.member.saveAndContinue")}</BusyButton>
          : <><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={() => save()}>{busy ? t("engagement.member.saving") : t("engagement.member.saveForLater")}</BusyButton><BusyButton type="submit" className="eng-btn" pending={busy}>{busy ? t("engagement.member.submitting") : t("engagement.member.submitSurvey")}</BusyButton></>}
      </div>
    </>}
  </form>;
}

function PulsePrompt({ client, prompt, onUpdated, onNotice }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  function respond(value, dismiss = false) {
    return runBusyWrite(busyWriteRef, "pulse", () => respondNow(value, dismiss));
  }

  async function respondNow(value, dismiss = false) {
    setBusy(true);
    try {
      await engagementApi.respondPulse(client, prompt.eventId, value, dismiss);
      onNotice(dismiss ? t("engagement.member.promptDismissed") : t("engagement.member.responseSaved"));
      await onUpdated();
    } catch { onNotice(t("engagement.responseFailed"), true); }
    finally { setBusy(false); }
  }
  return <article className="eng-card eng-pulse"><span className="eng-kicker">{t("engagement.member.pulseKicker")}</span><h3>{prompt.question}</h3><div className="eng-choice-row">{prompt.options.map((option) => <BusyButton type="button" className="eng-chip" key={String(optionValue(option))} pending={busy} onClick={() => respond(optionValue(option))}>{optionLabel(option)}</BusyButton>)}</div><BusyButton type="button" className="eng-link" pending={busy} onClick={() => respond(null, true)}>{t("engagement.member.notNow")}</BusyButton></article>;
}

function LivePoll({ client, poll, onUpdated, onNotice }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const rosterEligible = poll.eligibility !== "roster" || poll.attendance?.eligible === true;
  //  (W5-18): the server sends attendance as null when this member has no
  // roster row, so only a poll that carries the field has said where they stand.
  const rosterKnown = poll.eligibility === "roster" && poll.attendance !== undefined;
  const requiresCheckIn = typeof poll.canCheckIn === "boolean"
    ? poll.canCheckIn
    : poll.eligibility === "roster" && rosterEligible && !poll.attendance?.checkedInAt;
  function act(work, message) {
    return runBusyWrite(busyWriteRef, "poll", () => actNow(work, message));
  }

  async function actNow(work, message) {
    setBusy(true);
    try { await work(); onNotice(message); await onUpdated(); }
    catch { onNotice(t("engagement.pollUpdateFailed"), true); }
    finally { setBusy(false); }
  }
  return <article className="eng-card eng-live-poll">
    <div className="eng-card__head"><div><span className="eng-kicker"><Radio size={14} /> {poll.state === "open" ? t("engagement.member.pollLiveNow") : pollStateLabel(t, poll.state)}</span><h3>{poll.title}</h3></div><span className="eng-count">{t("engagement.voteCount", { count: poll.voteCount })}</span></div>
    {poll.description && <p>{poll.description}</p>}
    {poll.state === "scheduled" && <div className="eng-actions"><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busy} onClick={() => act(() => engagementApi.rsvpLivePoll(client, poll.id, "yes"), t("engagement.member.rsvpSaved"))}>{t("engagement.member.rsvpGoing")}</BusyButton></div>}
    {poll.state === "open" && requiresCheckIn && <BusyButton type="button" className="eng-btn" pending={busy} onClick={() => act(() => engagementApi.checkInLivePoll(client, poll.id), t("engagement.member.checkedIn"))}>{t("engagement.member.checkInToVote")}</BusyButton>}
    {/*  (W5-18): a roster poll that leaves this member off its roster says so, instead of a choiceless card. */}
    {poll.state === "open" && rosterKnown && !rosterEligible && !requiresCheckIn && <p className="eng-roster-note" role="status">{t("engagement.member.notOnRoster")}</p>}
    {poll.state === "open" && rosterEligible && !requiresCheckIn && <div className="eng-options">{poll.options.map((option) => <label key={option.id}><BusyInput type="radio" name={`live-${poll.id}`} checked={poll.selectedOptionId === option.id} pending={busy} onChange={() => act(() => engagementApi.castLivePollVote(client, poll.id, option.id), t("engagement.member.voteSaved"))} /><span>{option.label}</span></label>)}</div>}
    {poll.results.length > 0 && <div className="eng-results" aria-label={t("engagement.member.pollResults")}>{poll.results.map((result) => <div key={result.optionId || result.id}><span>{result.label}</span><strong>{result.votes}</strong></div>)}</div>}
  </article>;
}

function WorkspaceActions({ client, snapshot, onUpdated, onNotice }) {
  const { t } = useLang();
  const [busyId, setBusyId] = useState("");
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const modules = snapshot.workspace?.moduleOrder || ["inbox", "surveys", "tasks", "cases"];
  const [hidden, setHidden] = useState(snapshot.workspace?.hiddenModules || []);
  // A re-read workspace (: an undo of a workspace change) replaces the
  // unsaved checkboxes, so Save cannot send the undone choice back.
  const savedHidden = JSON.stringify(snapshot.workspace?.hiddenModules || []);
  const adoptedHidden = useRef(savedHidden);
  useEffect(() => {
    if (savedHidden === adoptedHidden.current) return;
    adoptedHidden.current = savedHidden;
    setHidden(JSON.parse(savedHidden));
  }, [savedHidden]);
  function decide(id, decision) {
    return runBusyWrite(busyWriteRef, `action:${id}`, () => decideNow(id, decision));
  }

  async function decideNow(id, decision) {
    setBusyId(id);
    try { await engagementApi.decideAction(client, id, decision); onNotice(decision === "confirm" ? t("engagement.member.taskCreated") : t("engagement.member.suggestionDismissed")); await onUpdated(); }
    catch { onNotice(t("engagement.compassActionFailed"), true); }
    finally { setBusyId(""); }
  }
  return <section className="eng-stack" aria-labelledby="eng-workspace-title"><div className="eng-section-head"><div><span className="eng-kicker">{t("engagement.member.compassKicker")}</span><h2 id="eng-workspace-title">{t("engagement.member.compassTitle")}</h2></div><Sparkles /></div>
    {(snapshot.actions || []).map((action) => <article className="eng-card eng-action" key={action.id}><div><strong>{action.title}</strong><p>{t("engagement.member.actionExplainer", { kind: sourceKindLabel(t, action.sourceKind) })}</p></div><div className="eng-actions"><BusyButton type="button" className="eng-btn eng-btn--quiet" pending={busyId === action.id} onClick={() => decide(action.id, "reject")}>{t("engagement.member.dismissAction")}</BusyButton><BusyButton type="button" className="eng-btn" pending={busyId === action.id} onClick={() => decide(action.id, "confirm")}>{t("engagement.member.createTask")}</BusyButton></div></article>)}
    {!(snapshot.actions || []).length && <p className="eng-card">{t("engagement.member.noActions")}</p>}
    <details className="eng-card eng-details"><summary>{t("engagement.member.customizeHome")}</summary><p>{t("engagement.member.customizeHelp")}</p><div className="eng-member-grid">{modules.map((module) => <label key={module}><input type="checkbox" checked={!hidden.includes(module)} onChange={(event) => setHidden((current) => event.target.checked ? current.filter((item) => item !== module) : [...current, module])} /> {moduleLabel(t, module)}</label>)}</div><button type="button" className="eng-btn eng-btn--quiet" onClick={async () => { try { await engagementApi.saveWorkspace(client, modules, hidden); onNotice(t("engagement.member.workspaceSaved")); await onUpdated(); } catch { onNotice(t("engagement.workspaceSaveFailed"), true); } }}>{t("engagement.member.saveWorkspace")}</button></details>
  </section>;
}

// Trailing coalescing window for vote-driven poll UPDATEs. A burst of realtime
// payloads in one tick (or within this budget) must produce one snapshot RPC.
export const LIVE_POLL_VOTE_RELOAD_MS = 50;
// Ceiling on that trailing window. Sustained voting keeps restarting the trailing
// timer, so a burst that never goes quiet still refreshes on this cadence.
export const LIVE_POLL_VOTE_RELOAD_MAX_MS = 1_000;
// States get_member_engagement_snapshot returns to a member; a poll entering one of
// them is newly visible even though it is not on screen yet.
const MEMBER_VISIBLE_POLL_STATES = new Set(["scheduled", "open", "closed"]);

// onSnapshotChanged: told after every accepted write here (a survey saved or
// submitted, a pulse answered, a poll vote), so the shell drops its own cached
// copy of this snapshot; Home counts and ranks the same surveys
// (BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111).
export function MemberEngagement({ client, organizationId = null, onNotice: announce = () => {}, onSnapshotChanged = null }) {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState({ text: "", error: false });
  const { t } = useLang();
  // Read through a ref so a language switch does not change `load` and refetch.
  const tRef = useRef(t);
  tRef.current = t;
  const hasOrganization = Boolean(organizationId);
  const renderedPollIdsRef = useRef(new Set());
  renderedPollIdsRef.current = new Set((snapshot?.livePolls || []).map((poll) => poll.id));
  const organizationIdRef = useRef(organizationId);
  organizationIdRef.current = organizationId;
  const announceRef = useRef(announce);
  const snapshotRef = useRef(null);
  const loadGenerationRef = useRef(0);
  const loadInFlightRef = useRef(null);
  const loadQueuedRef = useRef(false);
  const actionNoticeRef = useRef(0);
  const activeLoadRef = useRef(null);
  announceRef.current = announce;
  snapshotRef.current = snapshot;
  const load = useCallback(() => {
    if (!client || !organizationId || activeLoadRef.current !== load) return Promise.resolve();
    if (loadInFlightRef.current) {
      loadQueuedRef.current = true;
      return loadInFlightRef.current;
    }
    const generation = ++loadGenerationRef.current;
    const requestClient = client;
    const actionNotice = actionNoticeRef.current;
    const pending = (async () => {
      try {
        const next = await engagementApi.loadMember(requestClient);
        if (loadGenerationRef.current !== generation) return;
        snapshotRef.current = next;
        setSnapshot(next);
        setError("");
        setNotice((current) => (current.source === "load" && current.error ? { text: "", error: false } : current));
      } catch {
        if (loadGenerationRef.current !== generation) return;
        const message = tRef.current("engagement.memberUnavailable");
        if (snapshotRef.current) {
          if (actionNoticeRef.current !== actionNotice) return;
          setNotice({ text: message, error: true, source: "load" });
          announceRef.current(message);
        } else {
          setError(message);
        }
      } finally {
        if (loadInFlightRef.current === pending) loadInFlightRef.current = null;
      }
      if (loadQueuedRef.current && loadGenerationRef.current === generation) {
        loadQueuedRef.current = false;
        void load();
      }
    })();
    loadInFlightRef.current = pending;
    return pending;
  }, [client, organizationId]);
  activeLoadRef.current = load;
  const snapshotChangedRef = useRef(onSnapshotChanged);
  snapshotChangedRef.current = onSnapshotChanged;
  const refreshAfterWrite = useCallback(async () => {
    snapshotChangedRef.current?.();
    if (activeLoadRef.current !== load) return;
    const stale = loadInFlightRef.current;
    if (stale) {
      loadQueuedRef.current = true;
      await stale.catch(() => {});
      if (loadInFlightRef.current) return loadInFlightRef.current;
    }
    return load();
  }, [load]);
  useLearningUndone(["own_compass_workspace"], () => { void refreshAfterWrite(); });
  const tell = useCallback((text, errorState = false) => { actionNoticeRef.current += 1; setNotice({ text, error: errorState, source: "action" }); if (text) announce(text); }, [announce]);
  const refreshSnapshot = needsSnapshotRefresh(snapshot);
  // REQ-UG-QUARTERLY-SURVEY-GATE-ENFORCED-20261001: the "give to view"
  // banner links here with ?survey=<id>; bring that survey into view once.
  const surveyLinkHandledRef = useRef(false);
  useEffect(() => {
    if (!snapshot || surveyLinkHandledRef.current) return;
    const requested = new URLSearchParams(globalThis.location?.search || "").get("survey");
    surveyLinkHandledRef.current = true;
    if (!requested) return;
    const form = globalThis.document?.getElementById(`eng-survey-${requested}`);
    if (!form) return;
    form.scrollIntoView?.({ block: "start" });
    form.querySelector("h3")?.focus?.({ preventScroll: true });
  }, [snapshot]);

  useEffect(() => {
    setSnapshot(null);
    setError("");
    load();
    return () => {
      loadGenerationRef.current += 1;
      loadInFlightRef.current = null;
      loadQueuedRef.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!client || !hasOrganization) return undefined;
    engagementApi.evaluatePulse(client, "voice.open", new Date().toISOString().slice(0, 10)).then(load).catch(() => {});
    engagementApi.heartbeat(client).catch(() => {});
    const timer = globalThis.setInterval(() => engagementApi.heartbeat(client, document.hidden ? "away" : "online").catch(() => {}), 60_000);
    let reloadTimer = 0;
    let ceilingTimer = 0;
    const reload = () => {
      globalThis.clearTimeout(reloadTimer);
      globalThis.clearTimeout(ceilingTimer);
      reloadTimer = 0;
      ceilingTimer = 0;
      load();
    };
    const onLivePollChange = (row) => {
      const pollId = row?.id;
      if (!pollId) return;
      const concernsThisMember = renderedPollIdsRef.current.has(pollId)
        || (row.organization_id === organizationIdRef.current && MEMBER_VISIBLE_POLL_STATES.has(row.state));
      if (!concernsThisMember) return;
      if (!ceilingTimer) ceilingTimer = globalThis.setTimeout(reload, LIVE_POLL_VOTE_RELOAD_MAX_MS);
      globalThis.clearTimeout(reloadTimer);
      reloadTimer = globalThis.setTimeout(reload, LIVE_POLL_VOTE_RELOAD_MS);
    };
    const unsubscribe = subscribeToLivePolls(client, onLivePollChange);
    return () => {
      globalThis.clearTimeout(reloadTimer);
      globalThis.clearTimeout(ceilingTimer);
      globalThis.clearInterval(timer);
      unsubscribe();
      engagementApi.heartbeat(client, "offline").catch(() => {});
    };
  }, [client, hasOrganization, load]);
  useEffect(() => {
    if (!client || !hasOrganization || !refreshSnapshot) return undefined;
    const timer = globalThis.setInterval(() => {
      if (document.hidden) return;
      load();
    }, SCHEDULED_POLL_REFRESH_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      globalThis.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [client, hasOrganization, refreshSnapshot, load]);

  if (!client) return null;
  if (!hasOrganization) return <section className="eng-state" role="status" data-testid="member-engagement-empty"><p>{t("engagement.member.noOrganization")}</p></section>;
  if (error) return <section className="eng-state" role="alert"><p>{error}</p><button className="eng-btn" type="button" onClick={load}>{t("engagement.tryAgain")}</button></section>;
  if (!snapshot) return <p className="eng-state" role="status">{t("engagement.member.loading")}</p>;
  const gate = snapshot.quarterlyGate || {};
  return <section className="eng-root" data-testid="member-engagement">
    {notice.text && <p className={`eng-notice${notice.error ? " eng-notice--error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}</p>}
    {gate.required && !gate.completed && <aside className="eng-gate"><ClipboardList /><div><strong>{gate.title || t("engagement.member.gateTitle")}</strong><p>{t("engagement.member.gateBody")}</p></div></aside>}
    {(snapshot.pulsePrompts || []).map((prompt) => <PulsePrompt key={prompt.eventId} client={client} prompt={prompt} onUpdated={refreshAfterWrite} onNotice={tell} />)}
    {(snapshot.livePolls || []).length > 0 && <section className="eng-stack" aria-labelledby="eng-live-title"><div className="eng-section-head"><div><span className="eng-kicker">{t("engagement.member.meetingKicker")}</span><h2 id="eng-live-title">{t("engagement.livePolls")}</h2></div><Radio /></div>{snapshot.livePolls.map((poll) => <LivePoll key={poll.id} client={client} poll={poll} onUpdated={refreshAfterWrite} onNotice={tell} />)}</section>}
    {(snapshot.surveys || []).length > 0 && <section className="eng-stack" aria-labelledby="eng-surveys-title"><div className="eng-section-head"><div><span className="eng-kicker">{t("engagement.member.voiceKicker")}</span><h2 id="eng-surveys-title">{t("engagement.member.surveysTitle")}</h2></div><BellRing /></div>{snapshot.surveys.map((survey) => <SurveyFlow key={survey.id} client={client} survey={survey} onUpdated={refreshAfterWrite} onNotice={tell} />)}</section>}
    <WorkspaceActions client={client} snapshot={snapshot} onUpdated={refreshAfterWrite} onNotice={tell} />
  </section>;
}
