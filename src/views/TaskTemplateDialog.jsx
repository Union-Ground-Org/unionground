import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckSquare2, Pencil, Save, ShieldCheck, X } from "lucide-react";
import {
  nextTemplateSteps,
  recommendedStatusForStep,
  taskTemplateValuesFromDetails,
  templateFieldsToPayload,
  validateTaskTemplateValues,
} from "../lib/taskTemplates.js";
import { useModalIsolation } from "../lib/useModalIsolation.js";
import { BusyButton, BusyInput, BusySelect } from "../components/BusyControls.jsx";
import { prepareBusyWrite, runBusyWrite } from "../lib/busyWrite.js";
import { returnFocusAfterModal } from "../lib/useTransitionPresence.js";
import { UnitWorkflowChoice, useUnitWorkflow } from "../features/chapterAccess/UnitWorkflowChoice.jsx";
import { unitSettingChoices } from "../lib/unitSettings.js";
import { limitTaskTitle } from "../lib/taskTitle.js";

function localized(value, lang) {
  return value?.[lang] || value?.en || "";
}

function optionLabel(t, value) {
  const translated = t(`taskTemplates.option.${value}`);
  return translated === `taskTemplates.option.${value}` ? value.replaceAll("_", " ") : translated;
}

const PRIORITY_COPY = {
  low: "tasks.priorityLow",
  medium: "tasks.priorityMedium",
  high: "tasks.priorityHigh",
};

function TemplateFieldControl({ field, values, errors, assignees, lang, t, pending, onChange }) {
  const uid = useId();
  const label = localized(field.label, lang);
  const help = localized(field.help, lang);
  const describedBy = [help ? `${uid}-help` : null, errors[field.key] ? `${uid}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <label className="task-template-field">
      <span>{label}{field.required && <i aria-hidden="true"> *</i>}</span>
      {field.kind === "enum" ? (
        <BusySelect aria-label={label} aria-describedby={describedBy} value={values[field.key] || ""} aria-invalid={Boolean(errors[field.key])} pending={pending} onChange={(event) => onChange(field.key, event.target.value)}>
          <option value="">—</option>
          {field.options.map((option) => <option key={option} value={option}>{optionLabel(t, option)}</option>)}
        </BusySelect>
      ) : field.kind === "member" ? (
        <BusySelect aria-label={label} aria-describedby={describedBy} value={values[field.key] || ""} aria-invalid={Boolean(errors[field.key])} pending={pending} onChange={(event) => onChange(field.key, event.target.value)}>
          <option value="">—</option>
          {assignees.map((person) => <option key={person.id} value={person.id}>{person.fullName}</option>)}
        </BusySelect>
      ) : (
        <BusyInput aria-label={label} aria-describedby={describedBy} type={field.kind} value={values[field.key] || ""} aria-invalid={Boolean(errors[field.key])} pending={pending} onChange={(event) => onChange(field.key, event.target.value)} />
      )}
      {help && <small id={`${uid}-help`} className="task-template-field__help">{help}</small>}
      {errors[field.key] && <small id={`${uid}-error`} role="alert">{t("taskTemplates.required")}</small>}
    </label>
  );
}

function fieldValueLabel(field, value, assignees, t) {
  if (value == null || value === "") return "—";
  if (field.kind === "member") return assignees.find((person) => person.id === value)?.fullName || "—";
  if (field.kind === "enum") return optionLabel(t, value);
  return value;
}

function firstFocusable(container) {
  return container?.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
}

function trapDialogFocus(event, dialog) {
  if (event.key !== "Tab") return;
  const controls = [...(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]') || [])]
    .filter((node) => !node.hidden && node.getAttribute("aria-hidden") !== "true");
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function TaskTemplateDialog({
  templates: offeredTemplates = [],
  unitSettingsApi = null,
  unitSettingsScope = "",
  unitSettingsMember = null,
  workstreams = [],
  assignees = [],
  lang = "en",
  t,
  onClose,
  onCreate,
  returnFocusRef = null,
  closing = false,
  onTransitionEnd,
}) {
  const workflow = useUnitWorkflow(unitSettingsApi, unitSettingsScope, unitSettingsMember);
  const unitEnabled = unitSettingsApi && !workflow.context?.legacy;
  const checkingTemplates = unitEnabled && workflow.phase === "loading";
  const templates = unitEnabled ? (workflow.ready ? unitSettingChoices(offeredTemplates, workflow.context.effective.templates) : []) : offeredTemplates;
  const uid = useId();
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  const [selectedKey, setSelectedKey] = useState(null);
  const [title, setTitle] = useState("");
  // The list can arrive after the dialog opens (finding 57: the only choice
  // was "—"), so an untouched choice follows the first workstream.
  const [chosenWorkstream, setWorkstream] = useState("");
  const workstream = workstreams.includes(chosenWorkstream) ? chosenWorkstream : (workstreams[0] || "");
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const selected = templates.find((template) => template.key === selectedKey) || null;
  useModalIsolation(backdropRef, { active: true });

  useEffect(() => {
    const returnTarget = returnFocusRef?.current;
    firstFocusable(dialogRef.current)?.focus({ preventScroll: true });
    return () => { returnFocusAfterModal(returnTarget, { preventScroll: true }); };
  }, [returnFocusRef]);

  // TasksView closes the picker with the prototype modal's 200 ms scrim fade
  // (useModalExit, an owner decision): while `closing` it keeps
  // focus and takes no further dismissal or submission.
  function close() {
    if (!busy && !closing) onClose?.();
  }

  function choose(template) {
    setSelectedKey(template.key);
    setValues({});
    setErrors({});
    setSubmitError("");
  }

  function changeField(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  // Validation stays synchronous, so a corrected submit right after a refused
  // one goes through; only the create itself holds the lock.
  function submit(event) {
    return prepareBusyWrite(busyWriteRef, "create", () => {
      event.preventDefault();
      if (!selected || closing) return undefined;
      const validation = validateTaskTemplateValues(selected, values, templates);
      const nextErrors = { ...validation.errors };
      if (!title.trim()) nextErrors.title = t("taskTemplates.required");
      if (!workstream) nextErrors.workstream = t(workstreams.length ? "taskTemplates.required" : "taskTemplates.noWorkstream");
      setErrors(nextErrors);
      setSubmitError("");
      if (Object.values(nextErrors).some(Boolean)) return undefined;
      return () => submitNow();
    }, event);
  }

  async function submitNow() {
    setBusy(true);
    try {
      await onCreate?.({
        templateKey: selected.key,
        title: title.trim(),
        workstream,
        fields: templateFieldsToPayload(selected, values, templates),
        ...(unitEnabled ? { unitId: workflow.context.unitId, actorId: workflow.context.actorId, chapterId: workflow.context.chapterId, organizationId: workflow.context.organizationId } : {}),
      });
      setBusy(false);
    } catch {
      setSubmitError(t("taskTemplates.error"));
      setBusy(false);
    }
  }

  return (
    <div
      ref={backdropRef}
      className="task-editor-backdrop task-template-backdrop"
      role="presentation"
      data-state={closing ? "closing" : undefined}
      onTransitionEnd={onTransitionEnd}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        close();
      }}
    >
      <section
        ref={dialogRef}
        className="task-template-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-intro`}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); close(); return; }
          trapDialogFocus(event, dialogRef.current);
        }}
      >
        <header className="task-template-dialog__header">
          <div>
            <h2 id={`${uid}-title`}>{t("taskTemplates.dialogTitle")}</h2>
            <p id={`${uid}-intro`}>{t("taskTemplates.dialogIntro")}</p>
          </div>
          <BusyButton type="button" className="task-template-iconbutton" aria-label={t("taskTemplates.close")} pending={busy} onClick={close}>
            <X size={20} aria-hidden="true" />
          </BusyButton>
        </header>

        {unitEnabled && <UnitWorkflowChoice workflow={workflow} pending={busy || closing} />}
        {checkingTemplates ? (
          <p className="task-template-dialog__loading" role="status">{t("taskTemplates.loading")}</p>
        ) : unitEnabled && (workflow.phase === "error" || workflow.context?.needsChoice) ? null : templates.length === 0 ? (
          <p className="task-template-dialog__empty" role="status">{t("taskTemplates.unavailable")}</p>
        ) : (
          <>
            <div className="task-template-choices" role="group" aria-label={t("taskTemplates.choose")}>
              {templates.map((template) => (
                <BusyButton
                  key={template.key}
                  type="button"
                  className="task-template-choice"
                  aria-pressed={selectedKey === template.key}
                  pending={busy}
                  onClick={() => choose(template)}
                >
                  <strong>{localized(template.label, lang)}</strong>
                  <span>{localized(template.description, lang)}</span>
                  <span className="task-template-choice__meta">
                    {t(`tasks.status.${template.defaultStatus}`)} · {t(PRIORITY_COPY[template.defaultPriority] || "tasks.priorityMedium")} · {t("taskTemplates.fieldCount", { count: template.fields.length })}
                  </span>
                </BusyButton>
              ))}
            </div>

            {selected && (
              <form className="task-template-form" onSubmit={submit} noValidate>
                <div className="task-template-form__fields">
                  <label className="task-template-field task-template-field--wide">
                    <span>{t("taskTemplates.title")}</span>
                    <BusyInput
                      value={title}
                      aria-invalid={Boolean(errors.title)}
                      aria-describedby={errors.title ? `${uid}-title-error` : undefined}
                      pending={busy}
                      onChange={(event) => { setTitle(limitTaskTitle(event.target.value, title)); setErrors((current) => ({ ...current, title: undefined })); }}
                    />
                    {errors.title && <small id={`${uid}-title-error`} role="alert">{errors.title}</small>}
                  </label>
                  <label className="task-template-field task-template-field--wide">
                    <span>{t("taskTemplates.workstream")}</span>
                    <BusySelect value={workstream} aria-invalid={Boolean(errors.workstream)} aria-describedby={errors.workstream ? `${uid}-workstream-error` : undefined} pending={busy} onChange={(event) => { setWorkstream(event.target.value); setErrors((current) => ({ ...current, workstream: undefined })); }}>
                      {workstreams.length === 0 && <option value="">—</option>}
                      {workstreams.map((name) => <option key={name} value={name}>{name}</option>)}
                    </BusySelect>
                    {errors.workstream && <small id={`${uid}-workstream-error`} role="alert">{errors.workstream}</small>}
                  </label>
                  {selected.fields.map((field) => <TemplateFieldControl
                    key={field.key}
                    field={field}
                    values={values}
                    errors={errors}
                    assignees={assignees}
                    lang={lang}
                    t={t}
                    pending={busy}
                    onChange={changeField}
                  />)}
                </div>

                <aside className="task-template-safety">
                  <ShieldCheck size={20} aria-hidden="true" />
                  <p>{t("taskTemplates.safety")}</p>
                </aside>
                <section className="task-template-checklist" aria-labelledby={`${uid}-checklist`}>
                  <h3 id={`${uid}-checklist`}><CheckSquare2 size={18} aria-hidden="true" /> {t("taskTemplates.checklist")}</h3>
                  <p className="task-template-checklist__start">{t("taskTemplates.startsAt", { step: localized(selected.flow[0]?.label, lang) })}</p>
                  <ul>{selected.checklist.map((item) => <li key={localized(item.label, "en")}>{localized(item.label, lang)}</li>)}</ul>
                </section>
                {submitError && <p className="task-template-form__error" role="alert">{submitError}</p>}
                <footer className="task-template-dialog__actions">
                  <BusyButton type="button" className="task-template-button task-template-button--quiet" pending={busy} onClick={close}>{t("taskTemplates.cancel")}</BusyButton>
                  <BusyButton type="submit" className="task-template-button task-template-button--primary" pending={busy}>
                    {busy ? t("taskTemplates.creating") : t("taskTemplates.create")}
                  </BusyButton>
                </footer>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function TaskTemplatePanel({
  task,
  template,
  details,
  assignees = [],
  lang = "en",
  t,
  onUpdate,
}) {
  const [pendingStep, setPendingStep] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState(() => taskTemplateValuesFromDetails(details));
  const [editErrors, setEditErrors] = useState({});
  const flowTriggerRef = useRef(null);
  const flowRegionRef = useRef(null);
  const editTriggerRef = useRef(null);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const values = useMemo(() => taskTemplateValuesFromDetails(details), [details]);
  const currentStep = template?.flow?.find((step) => step.key === details?.flowStep) || template?.flow?.[0];
  const nextSteps = nextTemplateSteps(template, currentStep?.key);
  const pending = template?.flow?.find((step) => step.key === pendingStep) || null;
  const recommendedStatus = pending ? recommendedStatusForStep(template, pending.key) : null;
  const needsStatusDecision = pending && recommendedStatus && recommendedStatus !== task.status;

  useEffect(() => {
    if (!editing) setEditValues(taskTemplateValuesFromDetails(details));
  }, [details, editing]);

  if (!template || !details) return null;

  function applyFlow(stepKey, applyRecommendedStatus) {
    return runBusyWrite(busyWriteRef, "template", () => applyFlowNow(stepKey, applyRecommendedStatus));
  }

  async function applyFlowNow(stepKey, applyRecommendedStatus) {
    let succeeded = false;
    setBusy(true);
    setError("");
    try {
      await onUpdate?.({
        taskId: task.id,
        fields: {},
        nextFlowStep: stepKey,
        applyRecommendedStatus,
      });
      succeeded = true;
      setPendingStep(null);
    } catch {
      setError(t("taskTemplates.updateError"));
    } finally {
      setBusy(false);
      window.setTimeout(() => {
        const trigger = flowTriggerRef.current;
        const target = succeeded && !trigger?.isConnected ? flowRegionRef.current : trigger;
        target?.focus({ preventScroll: true });
      }, 0);
    }
  }

  function chooseStep(step, trigger) {
    flowTriggerRef.current = trigger;
    const status = recommendedStatusForStep(template, step.key);
    if (!status || status === task.status) {
      applyFlow(step.key, false);
      return;
    }
    setPendingStep(step.key);
  }

  function changeEditField(key, value) {
    setEditValues((current) => ({ ...current, [key]: value }));
    setEditErrors((current) => ({ ...current, [key]: undefined }));
  }

  function cancelPendingStep() {
    setPendingStep(null);
    flowTriggerRef.current?.focus({ preventScroll: true });
  }

  function cancelEditing() {
    setEditing(false);
    setEditValues(values);
    setEditErrors({});
    setError("");
    window.setTimeout(() => editTriggerRef.current?.focus({ preventScroll: true }), 0);
  }

  function saveFields(event) {
    return prepareBusyWrite(busyWriteRef, "template", () => {
      event.preventDefault();
      const payload = templateFieldsToPayload(template, editValues, [template]);
      const validation = validateTaskTemplateValues(template, payload, [template]);
      setEditErrors(validation.errors);
      setError("");
      if (!validation.valid) return undefined;
      return () => saveFieldsNow(payload);
    }, event);
  }

  async function saveFieldsNow(payload) {
    setBusy(true);
    try {
      await onUpdate?.({
        taskId: task.id,
        fields: payload,
        nextFlowStep: null,
        applyRecommendedStatus: false,
      });
      setEditing(false);
      window.setTimeout(() => editTriggerRef.current?.focus({ preventScroll: true }), 0);
    } catch {
      setError(t("taskTemplates.updateError"));
      window.setTimeout(() => editTriggerRef.current?.focus({ preventScroll: true }), 0);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="task-template-panel" aria-labelledby={`task-template-${task.id}`}>
      <header>
        <div>
          <p className="task-template-panel__eyebrow">{t("taskTemplates.detailsTitle")}</p>
          <h3 id={`task-template-${task.id}`}>{localized(template.label, lang)}</h3>
        </div>
        <div className="task-template-panel__actions">
          <span className="task-template-panel__locked"><ShieldCheck size={15} aria-hidden="true" /> {t("taskTemplates.typeLocked")}</span>
          {!editing && <BusyButton ref={editTriggerRef} type="button" className="task-template-button task-template-button--quiet" pending={busy} onClick={() => { setEditValues(values); setEditErrors({}); setError(""); setEditing(true); }}>
            <Pencil size={15} aria-hidden="true" /> {t("taskTemplates.edit")}
          </BusyButton>}
        </div>
      </header>
      {editing ? (
        <form className="task-template-edit" onSubmit={saveFields} noValidate aria-busy={busy}>
          <div className="task-template-form__fields">
            {template.fields.map((field) => <TemplateFieldControl
              key={field.key}
              field={field}
              values={editValues}
              errors={editErrors}
              assignees={assignees}
              lang={lang}
              t={t}
              pending={busy}
              onChange={changeEditField}
            />)}
          </div>
          <div className="task-template-edit__actions">
            <BusyButton type="button" className="task-template-button task-template-button--quiet" pending={busy} onClick={cancelEditing}>{t("taskTemplates.editCancel")}</BusyButton>
            <BusyButton type="submit" className="task-template-button task-template-button--primary" pending={busy}>
              <Save size={15} aria-hidden="true" /> {busy ? t("taskTemplates.saving") : t("taskTemplates.save")}
            </BusyButton>
          </div>
        </form>
      ) : (
        <dl className="task-template-details">
          {template.fields.map((field) => (
            <div key={field.key}>
              <dt>{localized(field.label, lang)}</dt>
              <dd>{fieldValueLabel(field, values[field.key], assignees, t)}</dd>
            </div>
          ))}
        </dl>
      )}
      <section
        ref={flowRegionRef}
        className="task-template-flow"
        tabIndex={-1}
        aria-labelledby={`task-template-flow-${task.id}`}
      >
        <h4 id={`task-template-flow-${task.id}`}>{t("taskTemplates.flowTitle")}</h4>
        <p>{t("taskTemplates.currentStep", { step: localized(currentStep?.label, lang) })}</p>
        <ol className="task-template-flow__steps" aria-label={t("taskTemplates.flowTitle")}>
          {template.flow.map((step) => (
            <li key={step.key} aria-current={step.key === currentStep?.key ? "step" : undefined}>
              {localized(step.label, lang)}
            </li>
          ))}
        </ol>
        {nextSteps.length > 0 ? (
          <div className="task-template-flow__next">
            {nextSteps.map((step) => (
              <BusyButton key={step.key} type="button" pending={busy} disabled={editing} onClick={(event) => chooseStep(step, event.currentTarget)}>
                {t("taskTemplates.nextStep", { step: localized(step.label, lang) })}
                <ArrowRight size={16} aria-hidden="true" />
              </BusyButton>
            ))}
          </div>
        ) : <p className="task-template-flow__complete">{t("taskTemplates.noNext")}</p>}

        {needsStatusDecision && (
          <div
            className="task-template-flow__confirm"
            role="group"
            aria-label={t("taskTemplates.flowConfirm", {
              from: t(`tasks.status.${task.status}`),
              to: t(`tasks.status.${recommendedStatus}`),
            })}
          >
            <p>{t("taskTemplates.flowConfirm", {
              from: t(`tasks.status.${task.status}`),
              to: t(`tasks.status.${recommendedStatus}`),
            })}</p>
            <div>
              <BusyButton type="button" pending={busy} onClick={() => applyFlow(pending.key, false)}>{t("taskTemplates.flowOnly")}</BusyButton>
              <BusyButton type="button" className="task-template-button--primary" pending={busy} onClick={() => applyFlow(pending.key, true)}>{t("taskTemplates.flowAndStatus")}</BusyButton>
              <BusyButton type="button" pending={busy} onClick={cancelPendingStep}>{t("taskTemplates.flowCancel")}</BusyButton>
            </div>
          </div>
        )}
        {busy && <p role="status">{t("taskTemplates.updating")}</p>}
        {error && <p className="task-template-form__error" role="alert">{error}</p>}
      </section>
    </section>
  );
}

// BUG-UG-TASK-TYPE-CHANGE-OPENS-TEMPLATE-CHOOSER-20261111 (#8211):
// changing an existing General task to a specialized type, inside its editor.
// The fields are the template's own, checked the way creation checks them; the
// server repeats every check (convert_chapter_task_to_template).
export function TaskTypeConversionPanel({
  template,
  templates = [],
  assignees = [],
  lang = "en",
  t,
  onConvert,
  onCancel,
}) {
  const uid = useId();
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  if (!template) return null;

  function changeField(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  function submit() {
    return prepareBusyWrite(busyWriteRef, "convert", () => {
      const validation = validateTaskTemplateValues(template, values, templates);
      setErrors(validation.errors);
      setSubmitError("");
      if (Object.values(validation.errors).some(Boolean)) return undefined;
      return () => submitNow();
    });
  }

  async function submitNow() {
    setBusy(true);
    try {
      await onConvert?.({ templateKey: template.key, fields: templateFieldsToPayload(template, values, templates) });
    } catch {
      setSubmitError(t("taskTemplates.convertError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="task-template-panel task-type-conversion" aria-labelledby={`${uid}-title`} aria-busy={busy}>
      <h3 id={`${uid}-title`}>{t("taskTemplates.convertTitle", { type: localized(template.label, lang) })}</h3>
      <p>{t("taskTemplates.convertIntro")}</p>
      {template.fields.map((field) => (
        <TemplateFieldControl key={field.key} field={field} values={values} errors={errors} assignees={assignees} lang={lang} t={t} pending={busy} onChange={changeField} />
      ))}
      {submitError && <p role="alert">{submitError}</p>}
      <div className="task-type-conversion__actions">
        <BusyButton type="button" className="kan-pill" pending={busy} onClick={() => { void submit(); }}>
          {busy ? t("taskTemplates.converting") : t("taskTemplates.convert")}
        </BusyButton>
        <BusyButton type="button" className="kan-pill" pending={busy} onClick={() => onCancel?.()}>
          {t("taskTemplates.convertCancel")}
        </BusyButton>
      </div>
    </section>
  );
}
