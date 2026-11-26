import { useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { AUTOMATION_TRIGGER_METADATA, AUTOMATION_ACTION_METADATA, AUTOMATION_THRESHOLD_MAX_DAYS, automationThresholdMinimum, isAutomationCapabilityAvailable, validateAutomationDefinitionSpec } from "./capabilities.js";
import { AutomationPager } from "./AutomationRecipeLibrary.jsx";
import { automationConditionLabel } from "./automationUiLabels.js";
import { BusyButton, BusyFieldset } from "../../components/BusyControls.jsx";

function ScopeChoice({ kind, value, onChange, options, label, loading }) {
  const { t } = useLang();
  return <label className="xus-field">{label}<select className="xus-input" value={value || ""} disabled={loading} onChange={(event) => onChange(event.target.value)} required={kind !== "chapters"}>
    <option value="">{kind === "chapters" ? t("automation.all.authorized.chapters") : t("automation.choose.authorized.person")}</option>
    {value && !options.some((option) => option.id === value) && <option value={value}>{t("automation.builder.selectionNeedsRevalidation")}</option>}
    {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
  </select></label>;
}

export function AutomationGuidedBuilder({ draft, setDraft, capabilities, api, session, busy, onSave, onCancel }) {
  const { lang, t } = useLang();
  const [step, setStep] = useState(0);
  const [invalid, setInvalid] = useState(null);
  const [scopeChapters, setScopeChapters] = useState(null);
  const [scopePeople, setScopePeople] = useState(null);
  const [chaptersState, setChaptersState] = useState("loading");
  const [peopleState, setPeopleState] = useState("loading");
  const [chapterPage, setChapterPage] = useState(1);
  const [peoplePage, setPeoplePage] = useState(1);
  const [peopleSearch, setPeopleSearch] = useState("");
  const form = useRef(null);
  const legend = useRef(null);
  const dayWindowField = useRef(null);
  const stepMoved = useRef(false);
  const trigger = AUTOMATION_TRIGGER_METADATA.find((item) => item.id === draft.triggerKind);
  const usesDayWindow = trigger?.thresholdMode !== "none";
  const minimumDays = automationThresholdMinimum(draft.triggerKind);
  const dayWindowRule = t("automation.builder.dayWindowRule", { min: minimumDays, max: AUTOMATION_THRESHOLD_MAX_DAYS });
  const sourceConstraint = useRef(draft.conditions?.sourceId ? trigger?.source : null);
  const action = AUTOMATION_ACTION_METADATA.find((item) => item.id === draft.actionKind);
  const steps = [t("automation.builder.stepWhen"), t("automation.only.if"), t("automation.then"), t("automation.schedule"), t("automation.how.review.title")];
  const conditions = draft.conditions || {};
  const actionConfig = draft.actionConfig || {};
  const personKind = draft.actionKind === "assign_task" ? "assignees" : "recipients";
  const statuses = trigger?.statuses || [];
  const compatibleActions = AUTOMATION_ACTION_METADATA.filter((item) => item.sources.includes(trigger?.source));
  const installed = isAutomationCapabilityAvailable(capabilities, draft.triggerKind, draft.actionKind);
  const legacy = capabilities?.schemaVersion !== 2;
  const { version, ...draftSpec } = draft;
  const valid = validateAutomationDefinitionSpec({ ...draftSpec, schemaVersion: 2, thresholdDays: Number(draft.thresholdDays), ...(version ? { expectedVersion: version } : {}) }, { allowIncomplete: false }).ok;
  const local = (value) => value?.[lang] || value?.en || "";
  const setCondition = (key, value) => setDraft((current) => {
    const next = { ...current.conditions };
    if (value) next[key] = value; else delete next[key];
    return { ...current, conditions: next };
  });
  function changeTrigger(value) {
    const nextTrigger = AUTOMATION_TRIGGER_METADATA.find((item) => item.id === value);
    if (!nextTrigger || (sourceConstraint.current && nextTrigger.source !== sourceConstraint.current)) return;
    setDraft((current) => {
      const previousTrigger = AUTOMATION_TRIGGER_METADATA.find((item) => item.id === current.triggerKind);
      // A source-bound draft may select another predicate in the same workflow,
      // but must never silently turn one authorized record into a population.
      if (current.conditions?.sourceId && previousTrigger?.source !== nextTrigger.source) return current;
      const conditions = Object.fromEntries(Object.entries(current.conditions || {}).filter(([key, value]) => {
        if (!nextTrigger.conditions.includes(key)) return false;
        if (key === "status") return nextTrigger.statuses.includes(value);
        if (key === "deadlineKind") return nextTrigger.deadlineKinds.includes(value);
        if (key === "assignment" && nextTrigger.id === "unassigned_task") return value === "unassigned";
        if (key === "sourceId") return previousTrigger?.source === nextTrigger.source;
        return true;
      }));
      const keepAction = AUTOMATION_ACTION_METADATA.find((item) => item.id === current.actionKind)?.sources.includes(nextTrigger.source);
      return { ...current, triggerKind: value, thresholdDays: nextTrigger.thresholdMode === "none" ? "0" : current.thresholdDays, conditions, actionKind: keepAction ? current.actionKind : "create_standard_task", actionConfig: keepAction ? current.actionConfig : {} };
    });
    setChapterPage(1); setPeoplePage(1); setPeopleSearch("");
  }

  // The chapter list (Only if step) and the people list (Then step) each keep their
  // own page and search: paging or searching one must never change what the other requests.
  useEffect(() => {
    let active = true;
    setChaptersState("loading");
    setScopeChapters(null);
    if (!api.getScopeOptions) { setChaptersState("unavailable"); return; }
    Promise.resolve(api.getScopeOptions(session, { source: trigger?.source, chapterId: conditions.chapterId, search: "", page: chapterPage, pageSize: 6 }))
      .then((result) => { if (active) { setScopeChapters(result.ok ? result.data?.chapters ?? null : null); setChaptersState(result.ok ? "ready" : "unavailable"); } })
      .catch(() => { if (active) setChaptersState("unavailable"); });
    return () => { active = false; };
  }, [api, session, trigger?.source, conditions.chapterId, chapterPage]);

  useEffect(() => {
    let active = true;
    setPeopleState("loading");
    setScopePeople(null);
    if (!api.getScopeOptions) { setPeopleState("unavailable"); return; }
    Promise.resolve(api.getScopeOptions(session, { source: trigger?.source, chapterId: conditions.chapterId, search: peopleSearch, page: peoplePage, pageSize: 6 }))
      .then((result) => { if (active) { setScopePeople(result.ok ? result.data?.[personKind] ?? null : null); setPeopleState(result.ok ? "ready" : "unavailable"); } })
      .catch(() => { if (active) setPeopleState("unavailable"); });
    return () => { active = false; };
  }, [api, session, trigger?.source, conditions.chapterId, personKind, peoplePage, peopleSearch]);

  // Announce the new step after Continue or Back; opening the builder keeps focus where it was.
  useEffect(() => {
    if (!stepMoved.current) return;
    stepMoved.current = false;
    legend.current?.focus();
  }, [step]);

  function advance(event) {
    event.preventDefault();
    if (step === 0 && (draft.name.trim().length < 3 || draft.name.trim().length > 80)) { setInvalid("required"); form.current?.querySelector("input")?.focus(); return; }
    if (step === 2 && !validateAutomationDefinitionSpec({ ...draftSpec, schemaVersion: 2, thresholdDays: Number(draft.thresholdDays) }, { allowIncomplete: true }).ok) { setInvalid("required"); form.current?.querySelector("select")?.focus(); return; }
    if (!form.current?.checkValidity()) {
      const field = form.current?.querySelector("input:invalid, select:invalid, textarea:invalid");
      setInvalid(field && field === dayWindowField.current ? "dayWindow" : "required");
      field?.focus();
      return;
    }
    setInvalid(null);
    if (step === 4) { if (installed && valid) onSave(); return; }
    stepMoved.current = true;
    setStep((current) => current + 1);
  }
  const personKey = draft.actionKind === "assign_task" ? "assigneeId" : "recipientId";
  const people = scopePeople;
  const selectedPerson = people?.rows?.find((item) => item.id === actionConfig[personKey]);
  const selectedChapter = scopeChapters?.rows?.find((item) => item.id === conditions.chapterId);
  return <section className="automation-pages__body" aria-labelledby="automation-builder-title">
    <div><h2 id="automation-builder-title">{draft.id ? t("automation.edit.automation") : t("automation.build.automation")}</h2>
      <p>{t("automation.builder.unsavedDraftNote")}</p></div>
    <ol className="automation-pages__steps" aria-label={t("automation.setup.progress")}>{steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined}>{index + 1}. {label}</li>)}</ol>
    <form ref={form} className="automation-pages__builder" onSubmit={advance} noValidate>
      <BusyFieldset pending={busy}><legend ref={legend} tabIndex={-1}>{steps[step]}</legend>
        {step === 0 && <>
          <label className="xus-field">{t("automation.name")}<input className="xus-input" aria-label={t("automation.name")} aria-invalid={invalid === "required" || undefined} value={draft.name} minLength={3} maxLength={80} required aria-describedby="automation-name-help" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /><small id="automation-name-help">{t("automation.builder.nameHelp")}</small></label>
          <label className="xus-field">{t("automation.when.happens")}<select className="xus-input" value={draft.triggerKind} required aria-describedby={sourceConstraint.current ? "automation-bound-source-help" : undefined} onChange={(event) => changeTrigger(event.target.value)}>
            {AUTOMATION_TRIGGER_METADATA.filter((item) => !sourceConstraint.current || item.source === sourceConstraint.current).map((item) => <option key={item.id} value={item.id} disabled={!isAutomationCapabilityAvailable(capabilities, item.id, "create_standard_task")}>{local(item.label)}</option>)}
          </select></label>
          {sourceConstraint.current && <p id="automation-bound-source-help">{t("automation.builder.sourceBound")}</p>}
          {!installed && <p id="automation-builder-unavailable" role="status">{t("automation.builder.capabilityMissing")}</p>}
        </>}
        {step === 1 && <>
          <label className="xus-field">{t("automation.day.threshold")}
            <input ref={dayWindowField} className="xus-input" aria-label={t("automation.day.threshold")}
              type="number" min={minimumDays} max={AUTOMATION_THRESHOLD_MAX_DAYS} step="1" required
              value={draft.thresholdDays} disabled={!usesDayWindow}
              aria-invalid={invalid === "dayWindow" || undefined} aria-describedby="automation-threshold-help"
              onChange={({ currentTarget }) => {
                const { value, validity } = currentTarget;
                if (invalid === "dayWindow" && validity.valid) setInvalid(null);
                setDraft((current) => ({ ...current, thresholdDays: value }));
              }} />
            <small id="automation-threshold-help">
              {usesDayWindow ? <>
                {invalid === "dayWindow" ? <span className="automation-pages__error" role="alert">{dayWindowRule}</span> : dayWindowRule}
                {" "}{t("automation.builder.dayWindowHelp")}
              </> : t("automation.builder.noDayWindow")}
            </small>
          </label>
          <p>{trigger?.source === "event" ? t("automation.builder.eventTimeHelp") : t("automation.builder.dayWindowUtcHelp")}</p>
          {!legacy && statuses.length > 0 && <label className="xus-field">{t("automation.source.status")}<select className="xus-input" value={conditions.status || ""} onChange={(event) => setCondition("status", event.target.value)}><option value="">{t("automation.any.eligible.status")}</option>{statuses.map((status) => <option key={status} value={status}>{t(`automation.status.${status}`)}</option>)}</select></label>}
          {!legacy && trigger?.source === "task" && trigger.conditions.includes("priority") && <label className="xus-field">{t("automation.source.task.priority")}<select className="xus-input" value={conditions.priority || ""} onChange={(event) => setCondition("priority", event.target.value)}><option value="">{t("automation.any.eligible.priority")}</option>{["low", "medium", "high"].map((value) => <option key={value} value={value}>{automationConditionLabel(value, lang)}</option>)}</select></label>}
          {!legacy && trigger?.source === "task" && trigger.conditions.includes("assignment") && <label className="xus-field">{t("automation.source.task.assignment")}<select className="xus-input" value={conditions.assignment || ""} onChange={(event) => setCondition("assignment", event.target.value)}><option value="">{draft.triggerKind === "unassigned_task" ? t("automation.unassigned.tasks.only") : t("automation.any.eligible.assignment")}</option>{(draft.triggerKind === "unassigned_task" ? ["unassigned"] : ["assigned", "unassigned"]).map((value) => <option key={value} value={value}>{automationConditionLabel(value, lang)}</option>)}</select></label>}
          {draft.triggerKind === "casework_deadline" && <label className="xus-field">{t("automation.deadline.kind")}<select className="xus-input" value={conditions.deadlineKind || ""} onChange={(event) => setCondition("deadlineKind", event.target.value)}><option value="">{t("automation.all.deadline.kinds")}</option>{["filing", "response", "hearing", "appeal", "follow_up"].map((value) => <option key={value} value={value}>{t(`automation.deadline.${value}`)}</option>)}</select></label>}
          {!legacy && <ScopeChoice kind="chapters" label={t("automation.chapter.task.board")} value={conditions.chapterId} onChange={(value) => { setCondition("chapterId", value); setChapterPage(1); setPeoplePage(1); }} options={scopeChapters?.rows || []} loading={chaptersState !== "ready"} />}
          {scopeChapters && <AutomationPager {...scopeChapters} onChange={setChapterPage} />}
          {conditions.sourceId && <p>{t("automation.builder.selectedSourceLimit")}</p>}
          {chaptersState !== "ready" && <p role="status">{chaptersState === "loading" ? t("automation.loading.authorized.scope") : t("automation.builder.chapterChoicesUnavailable")}</p>}
        </>}
        {step === 2 && <>
          <label className="xus-field">{t("automation.then.do")}<select className="xus-input" value={draft.actionKind} onChange={(event) => setDraft((current) => ({ ...current, actionKind: event.target.value, actionConfig: {} }))}>{compatibleActions.map((item) => <option key={item.id} value={item.id} disabled={!isAutomationCapabilityAvailable(capabilities, draft.triggerKind, item.id)}>{local(item.label)}</option>)}</select></label>
          {draft.actionKind === "create_standard_task" && <><p>{t("automation.builder.createTaskHelp")}</p><label className="xus-field">{t("automation.task.priority")}<select className="xus-input" value={draft.taskPriority} onChange={(event) => setDraft((current) => ({ ...current, taskPriority: event.target.value }))}><option value="low">{t("automation.low")}</option><option value="medium">{t("automation.medium")}</option><option value="high">{t("automation.high")}</option></select></label></>}
          {draft.actionKind === "raise_task_priority" && <label className="xus-field">{t("automation.raise.priority")}<select className="xus-input" required value={actionConfig.priority || ""} onChange={(event) => setDraft((current) => ({ ...current, actionConfig: { priority: event.target.value } }))}><option value="">{t("automation.choose.priority")}</option><option value="medium">{t("automation.medium")}</option><option value="high">{t("automation.high")}</option></select></label>}
          {["assign_task", "notify_in_app"].includes(draft.actionKind) && <>
            <label className="xus-field">{t("automation.search.authorized.people")}<input type="search" className="xus-input" value={peopleSearch} onChange={(event) => { setPeopleSearch(event.target.value); setPeoplePage(1); }} /></label>
            <ScopeChoice kind={personKind} label={draft.actionKind === "assign_task" ? t("automation.assign") : t("automation.notify.app")} value={actionConfig[personKey]} onChange={(value) => setDraft((current) => ({ ...current, actionConfig: { [personKey]: value } }))} options={people?.rows || []} loading={peopleState !== "ready"} />
            {people && <AutomationPager {...people} onChange={setPeoplePage} />}
            {peopleState === "unavailable" && <p role="status">{t("automation.builder.peopleChoicesUnavailable")}</p>}
          </>}
          <p>{draft.actionKind === "notify_in_app" ? t("automation.builder.notifyInAppOnly") : t("automation.builder.undoFieldMatch")}</p>
        </>}
        {step === 3 && <>
          <label className="xus-field">{t("automation.evaluate")}<select className="xus-input" value={draft.cadence} onChange={(event) => setDraft((current) => ({ ...current, cadence: event.target.value }))}><option value="hourly">{t("automation.hourly")}</option><option value="daily">{t("automation.daily")}</option><option value="weekly">{t("automation.weekly")}</option></select></label>
          <p>{t("automation.builder.schedulerCadenceNote")}</p>
        </>}
        {step === 4 && <><p>{t("automation.builder.checkThenSave")}</p>{!valid && <p className="automation-pages__error" role="alert">{t("automation.builder.settingsIncomplete")}</p>}</>}
      </BusyFieldset>
      {invalid === "required" && <p className="automation-pages__error" role="alert">{t("automation.builder.requiredField")}</p>}
      <aside className="automation-pages__summary" aria-label={t("automation.workflow.summary")}><h3>{draft.name || t("automation.untitled.draft")}</h3><dl className="automation-pages__facts">
        <dt>{t("automation.when")}</dt><dd>{local(trigger?.label)}</dd><dt>{t("automation.conditions")}</dt><dd>{t("automation.thresholdDays", { days: draft.thresholdDays })}{conditions.status ? ` · ${automationConditionLabel(conditions.status, lang)}` : ""}{conditions.deadlineKind ? ` · ${automationConditionLabel(conditions.deadlineKind, lang)}` : ""}{conditions.priority ? ` · ${t("automation.priority")}: ${automationConditionLabel(conditions.priority, lang)}` : ""}{conditions.assignment ? ` · ${automationConditionLabel(conditions.assignment, lang)}` : ""}</dd>
        <dt>{t("automation.population")}</dt><dd>{conditions.chapterId ? selectedChapter?.label || t("automation.builder.chapterNeedsRevalidation") : t("automation.all.authorized.chapters")}{conditions.sourceId ? t("automation.selected.source.only") : ""}</dd>
        <dt>{t("automation.action")}</dt><dd>{local(action?.label)}</dd><dt>{t("automation.destination")}</dt><dd>{["assign_task", "notify_in_app"].includes(draft.actionKind) ? selectedPerson?.label || (actionConfig[personKey] ? t("automation.builder.personNeedsRevalidation") : t("automation.choose.person")) : t("automation.builder.destinationBoard")}</dd>
        <dt>{t("automation.schedule")}</dt><dd>{draft.cadence === "hourly" ? t("automation.hourly") : draft.cadence === "weekly" ? t("automation.weekly") : t("automation.daily")}</dd>
      </dl></aside>
      <div className="xus-btnrow"><BusyButton className="xus-btn" type="button" pending={busy} disabled={step === 0} onClick={() => { stepMoved.current = true; setStep((current) => current - 1); setInvalid(null); }}>{t("automation.back")}</BusyButton><BusyButton className="xus-btn xus-btn--go" type="submit" pending={busy} disabled={!installed || step === 4 && !valid} aria-describedby={!installed ? "automation-builder-unavailable" : undefined}>{step === 4 ? t("automation.save.draft") : t("automation.continue")}</BusyButton><BusyButton className="xus-btn" type="button" pending={busy} onClick={onCancel}>{t("automation.discard.draft")}</BusyButton></div>
    </form>
  </section>;
}
