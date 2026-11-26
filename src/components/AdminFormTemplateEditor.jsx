import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { FileText } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { compareTemplateRowPrecedence } from "../lib/formTemplates.js";
import { AUTOFILL_KINDS } from "../lib/formAutofill.js";
import { WorkspaceCardTitle } from "./WorkspacePages.jsx";
import { rpcRefusalKey } from "../lib/rpcErrorText.js";

const FIELD_TYPES = ["text", "textarea", "date", "select", "radio", "checkbox", "multiselect", "number"];
const CHOICE_TYPES = new Set(["select", "radio", "multiselect"]);
const TEMPLATE_LIMITS = Object.freeze({ steps: 12, fields: 30, options: 40 });
const LENGTH_TYPES = new Set(["text", "textarea"]);
const FIELD_KEY_MAX_LENGTH = 61;
const OPTION_VALUE_MAX_LENGTH = 60;

// Spanish is optional (REQ-UG-FORM-BUILDER-SPANISH-OPTIONAL-20261006).
// The registry still stores a non-empty Spanish string, so a blank one is saved
// as the English text, which is what members reading Spanish would see anyway
// (formTemplates.js pickLang falls back to English). Stored Spanish reopens
// exactly as saved: a copy of the English is indistinguishable from a real
// translation that happens to match ("No", "Email"), so the editor never
// blanks it. While a Spanish box holds exactly the English text, an English
// edit carries it along in plain sight, so a saved copy of the English never
// goes stale behind a corrected English question (gate round 2 on PR 4070);
// typing different Spanish ends that.
function savedSpanish(pair) {
  return pair.es.trim() || pair.en.trim();
}

function withEnglish(pair, en) {
  return { en, es: pair.es !== "" && pair.es === pair.en ? en : pair.es };
}

// Client-only list identity. It lets a reorder move the focused control with
// the item. normalizedDraft never copies it into the saved payload.
let editorItemSequence = 0;
function nextEditorId(kind) {
  editorItemSequence += 1;
  return `${kind}-${editorItemSequence}`;
}

function emptyField() {
  return {
    editorId: nextEditorId("field"),
    key: "",
    type: "text",
    label: { en: "", es: "" },
    required: false,
    maxLength: 200,
  };
}

function emptyStep() {
  return { editorId: nextEditorId("step"), title: { en: "", es: "" }, fields: [emptyField()] };
}

function withEditorIdentity(schema) {
  return {
    ...schema,
    steps: schema.steps.map((step) => ({
      ...step,
      editorId: nextEditorId("step"),
      fields: step.fields.map((field) => ({
        ...field,
        editorId: nextEditorId("field"),
      })),
    })),
  };
}

function emptyTemplate() {
  return {
    key: "",
    labelEn: "",
    labelEs: "",
    blurbEn: "",
    blurbEs: "",
    icon: "",
    sort: 0,
    active: true,
    fieldSchema: { steps: [emptyStep()] },
  };
}

function draftFromRow(row) {
  return {
    key: row.key,
    labelEn: row.label_en || "",
    labelEs: row.label_es || "",
    blurbEn: row.blurb_en || "",
    blurbEs: row.blurb_es || "",
    icon: row.icon || "",
    sort: Number(row.sort) || 0,
    active: Boolean(row.active),
    fieldSchema: withEditorIdentity(structuredClone(row.field_schema)),
  };
}

function registryGroups(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const group = byKey.get(row.key) || [];
    group.push(row);
    byKey.set(row.key, group);
  }
  return [...byKey.entries()]
    .map(([key, versions]) => {
      // An organization's own version outranks a newer platform seed (FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022).
      const ordered = [...versions].sort(compareTemplateRowPrecedence);
      return { key, versions: ordered, latest: ordered.at(-1) };
    })
    .sort((a, b) => Number(a.latest.sort) - Number(b.latest.sort) || a.key.localeCompare(b.key));
}

function moveItem(items, from, direction) {
  const to = from + direction;
  if (to < 0 || to >= items.length) return items;
  const next = [...items];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

function validateDraft(draft, t) {
  const labelEn = draft.labelEn.trim();
  if (!labelEn || Array.from(labelEn).length > 120) return t("admin.templates.validationLabelEn");
  const steps = draft.fieldSchema.steps || [];
  if (!steps.length) return t("admin.templates.validationStep");
  const seen = new Set();
  for (const step of steps) {
    if (!step.fields?.length) return t("admin.templates.validationField");
    for (const field of step.fields) {
      if (seen.has(field.key)) return t("admin.templates.validationDuplicate", { key: field.key });
      seen.add(field.key);
      if (CHOICE_TYPES.has(field.type) && !field.options?.length) return t("admin.templates.validationOption", { key: field.key });
    }
  }
  return "";
}

function focusUsable(element) {
  if (!element?.isConnected || element.disabled) return false;
  if (typeof element.focus !== "function") return false;
  element.focus();
  return true;
}

function refBucket(map, key) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { current: null };
    map.set(key, bucket);
  }
  return bucket;
}

// Trim English copy before deriving the Spanish fallback, just as
// memberApi.upsertFormTemplate trims a live save; an untrimmed English
// label beside its trimmed Spanish copy would no longer match on reload and
// stop following English edits (BUG-UG-DEMO-FORM-TEMPLATE-UNTRIMMED-ENGLISH-20261008).
function normalizedDraft(draft) {
  return {
    ...draft,
    labelEn: draft.labelEn.trim(),
    blurbEn: draft.blurbEn.trim(),
    labelEs: savedSpanish({ en: draft.labelEn, es: draft.labelEs }),
    blurbEs: savedSpanish({ en: draft.blurbEn, es: draft.blurbEs }),
    sort: Number(draft.sort),
    fieldSchema: {
      // Rebuild each step and field so editorId stays out of the payload.
      steps: draft.fieldSchema.steps.map((step) => ({
        title: { en: step.title.en.trim(), es: savedSpanish(step.title) },
        fields: step.fields.map((field) => {
          const clean = {
            key: field.key.trim(),
            type: field.type,
            label: { en: field.label.en.trim(), es: savedSpanish(field.label) },
            required: Boolean(field.required),
          };
          if (LENGTH_TYPES.has(field.type)) clean.maxLength = Number(field.maxLength);
          // A profile autofill hint set on the field survives an edit
          // (REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030).
          if (AUTOFILL_KINDS.includes(field.autofill)) clean.autofill = field.autofill;
          if (CHOICE_TYPES.has(field.type)) {
            clean.options = field.options.map((option) => ({
              value: option.value.trim(),
              label: { en: option.label.en.trim(), es: savedSpanish(option.label) },
            }));
          }
          return clean;
        }),
      })),
    },
  };
}

function TemplateAddButton({ busy, count, max, helpId, description, label, ariaLabel, limitReached, onAdd }) {
  const capped = count >= max;
  return <div>
    <BusyButton type="button" className="ftm-btn" pending={busy} disabled={capped}
      aria-label={ariaLabel} aria-describedby={helpId} onClick={onAdd}>{label}</BusyButton>
    <p className="ftm-help" id={helpId} role="status">{description}{capped && ` ${limitReached}`}</p>
  </div>;
}

function TemplateForm({ draft, mode, busy, saveError, onChange, onCancel, onSubmit, t }) {
  const limitId = useId();
  const stepCount = draft.fieldSchema.steps.length;
  const limitReached = t("admin.templates.limitReached");
  const headingRef = useRef(null);
  const formRef = useRef(null);
  const pendingReorderFocus = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, []);
  useLayoutEffect(() => {
    const pending = pendingReorderFocus.current;
    if (!pending) return;
    pendingReorderFocus.current = null;
    const target = formRef.current?.querySelector(
      `[data-reorder-target="${CSS.escape(pending.editorId)}"][data-reorder-direction="${pending.direction}"]`,
    );
    if (target instanceof HTMLButtonElement && !target.disabled) target.focus();
  }, [draft]);

  const setValue = (key, value) => onChange((current) => ({ ...current, [key]: value }));
  const setEnglish = (enKey, esKey, value) => onChange((current) => {
    const pair = withEnglish({ en: current[enKey], es: current[esKey] }, value);
    return { ...current, [enKey]: pair.en, [esKey]: pair.es };
  });
  const setSteps = (update) => onChange((current) => ({
    ...current,
    fieldSchema: { ...current.fieldSchema, steps: update(current.fieldSchema.steps) },
  }));
  const updateStep = (stepIndex, update) => setSteps((steps) => steps.map((step, index) => (
    index === stepIndex ? update(step) : step
  )));
  const updateField = (stepIndex, fieldIndex, update) => updateStep(stepIndex, (step) => ({
    ...step,
    fields: step.fields.map((field, index) => (index === fieldIndex ? update(field) : field)),
  }));

  // The direction just used is disabled once the item reaches that end, and a
  // disabled focused button drops focus to the document. Hand it to the moved
  // item's other reorder control; otherwise keep the control that was used.
  const rememberReorderFocus = (editorId, direction, nextIndex, length) => {
    const activated = direction < 0 ? "up" : "down";
    const directionUnavailable = direction < 0 ? nextIndex === 0 : nextIndex === length - 1;
    pendingReorderFocus.current = {
      editorId,
      direction: directionUnavailable ? (activated === "up" ? "down" : "up") : activated,
    };
  };
  const reorderSteps = (stepIndex, direction) => {
    const steps = draft.fieldSchema.steps;
    const nextIndex = stepIndex + direction;
    if (nextIndex < 0 || nextIndex >= steps.length) return;
    rememberReorderFocus(steps[stepIndex].editorId, direction, nextIndex, steps.length);
    setSteps((current) => moveItem(current, stepIndex, direction));
  };
  const reorderFields = (stepIndex, fieldIndex, direction) => {
    const fields = draft.fieldSchema.steps[stepIndex].fields;
    const nextIndex = fieldIndex + direction;
    if (nextIndex < 0 || nextIndex >= fields.length) return;
    rememberReorderFocus(fields[fieldIndex].editorId, direction, nextIndex, fields.length);
    updateStep(stepIndex, (current) => ({
      ...current,
      fields: moveItem(current.fields, fieldIndex, direction),
    }));
  };

  return (
    <form ref={formRef} className="ftm-editor" onSubmit={onSubmit} aria-busy={busy}>
      <div className="ftm-editor__head">
        <div>
          <p className="ftm-kicker">{t("admin.templates.editorKicker")}</p>
          <h3 ref={headingRef} tabIndex="-1" className="ftm-editor__title">
            {t(mode === "create" ? "admin.templates.newTitle" : "admin.templates.editTitle")}
          </h3>
          {mode === "edit" && <p className="ftm-help">{t("admin.templates.versionHelp")}</p>}
        </div>
        <BusyButton type="button" className="ftm-btn ftm-btn--quiet" onClick={onCancel} pending={busy}>
          {t("admin.templates.cancelEditing")}
        </BusyButton>
      </div>

      <fieldset className="ftm-fieldset">
        <legend>{t("admin.templates.identity")}</legend>
        <div className="ftm-grid ftm-grid--meta">
          <label className="ftm-field">
            <span>{t("admin.templates.key")}</span>
            <input aria-label={t("admin.templates.key")} value={draft.key} onChange={(event) => setValue("key", event.target.value)} required pattern="[a-z][a-z0-9_]{2,49}" maxLength="50" readOnly={mode === "edit"} />
            <small>{t("admin.templates.keyHelp")}</small>
          </label>
          <label className="ftm-field">
            <span>{t("admin.templates.icon")}</span>
            <input value={draft.icon} onChange={(event) => setValue("icon", event.target.value)} maxLength="8" />
          </label>
          <label className="ftm-field">
            <span>{t("admin.templates.sort")}</span>
            <input type="number" value={draft.sort} onChange={(event) => setValue("sort", event.target.value)} min="0" max="9999" required />
          </label>
        </div>
        <label className="ftm-check">
          <input type="checkbox" checked={draft.active} onChange={(event) => setValue("active", event.target.checked)} />
          <span>{t("admin.templates.acceptStarts")}</span>
        </label>
      </fieldset>

      <fieldset className="ftm-fieldset">
        <legend>{t("admin.templates.memberCopy")}</legend>
        <p className="ftm-help">{t("admin.templates.spanishOptional")}</p>
        <div className="ftm-grid">
          <label className="ftm-field"><span>{t("admin.templates.labelEn")}</span><input value={draft.labelEn} onChange={(event) => setEnglish("labelEn", "labelEs", event.target.value)} maxLength="120" required /></label>
          <label className="ftm-field"><span>{t("admin.templates.labelEs")}</span><input value={draft.labelEs} onChange={(event) => setValue("labelEs", event.target.value)} maxLength="120" /></label>
          <label className="ftm-field"><span>{t("admin.templates.blurbEn")}</span><textarea value={draft.blurbEn} onChange={(event) => setEnglish("blurbEn", "blurbEs", event.target.value)} maxLength="400" /></label>
          <label className="ftm-field"><span>{t("admin.templates.blurbEs")}</span><textarea value={draft.blurbEs} onChange={(event) => setValue("blurbEs", event.target.value)} maxLength="400" /></label>
        </div>
      </fieldset>

      <div className="ftm-schema-head">
        <div>
          <h4>{t("admin.templates.schemaTitle")}</h4>
          <p>{t("admin.templates.schemaHelp")}</p>
        </div>
        <TemplateAddButton busy={busy} count={stepCount} max={TEMPLATE_LIMITS.steps} helpId={`${limitId}-steps`}
          description={t("admin.templates.stepLimit", { count: stepCount, max: TEMPLATE_LIMITS.steps })}
          label={t("admin.templates.addStep")} limitReached={limitReached}
          onAdd={() => setSteps((steps) => [...steps, emptyStep()])} />
      </div>

      <div className="ftm-steps">
        {draft.fieldSchema.steps.map((step, stepIndex) => (
          <fieldset className="ftm-step" key={step.editorId}>
            <legend>{t("admin.templates.step", { count: stepIndex + 1 })}</legend>
            <div className="ftm-order" role="group" aria-label={t("admin.templates.stepOrder", { count: stepIndex + 1 })}>
              <BusyButton type="button" className="ftm-icon-btn" aria-label={t("admin.templates.moveStepUp", { count: stepIndex + 1 })} data-reorder-target={step.editorId} data-reorder-direction="up" pending={busy} disabled={stepIndex === 0} onClick={() => reorderSteps(stepIndex, -1)}>↑</BusyButton>
              <BusyButton type="button" className="ftm-icon-btn" aria-label={t("admin.templates.moveStepDown", { count: stepIndex + 1 })} data-reorder-target={step.editorId} data-reorder-direction="down" pending={busy} disabled={stepIndex === draft.fieldSchema.steps.length - 1} onClick={() => reorderSteps(stepIndex, 1)}>↓</BusyButton>
              <BusyButton type="button" className="ftm-btn ftm-btn--danger-quiet" pending={busy} disabled={stepCount === 1} aria-describedby={stepCount === 1 ? `${limitId}-steps` : undefined} onClick={() => setSteps((steps) => steps.filter((_, index) => index !== stepIndex))}>{t("admin.templates.removeStep")}</BusyButton>
            </div>
            <div className="ftm-grid">
              <label className="ftm-field"><span>{t("admin.templates.stepTitleEn", { count: stepIndex + 1 })}</span><input value={step.title.en} onChange={(event) => updateStep(stepIndex, (current) => ({ ...current, title: withEnglish(current.title, event.target.value) }))} required /></label>
              <label className="ftm-field"><span>{t("admin.templates.stepTitleEs", { count: stepIndex + 1 })}</span><input value={step.title.es} onChange={(event) => updateStep(stepIndex, (current) => ({ ...current, title: { ...current.title, es: event.target.value } }))} /></label>
            </div>

            <div className="ftm-fields">
              {step.fields.map((field, fieldIndex) => (
                <fieldset className="ftm-field-card" key={field.editorId}>
                  <legend>{t("admin.templates.field", { count: fieldIndex + 1 })}</legend>
                  <div className="ftm-order" role="group" aria-label={t("admin.templates.fieldOrder", { count: fieldIndex + 1 })}>
                    <BusyButton type="button" className="ftm-icon-btn" aria-label={t("admin.templates.moveFieldUp", { count: fieldIndex + 1 })} data-reorder-target={field.editorId} data-reorder-direction="up" pending={busy} disabled={fieldIndex === 0} onClick={() => reorderFields(stepIndex, fieldIndex, -1)}>↑</BusyButton>
                    <BusyButton type="button" className="ftm-icon-btn" aria-label={t("admin.templates.moveFieldDown", { count: fieldIndex + 1 })} data-reorder-target={field.editorId} data-reorder-direction="down" pending={busy} disabled={fieldIndex === step.fields.length - 1} onClick={() => reorderFields(stepIndex, fieldIndex, 1)}>↓</BusyButton>
                    <BusyButton type="button" className="ftm-btn ftm-btn--danger-quiet" pending={busy} disabled={step.fields.length === 1} aria-describedby={step.fields.length === 1 ? `${limitId}-${step.editorId}-fields` : undefined} onClick={() => updateStep(stepIndex, (current) => ({ ...current, fields: current.fields.filter((_, index) => index !== fieldIndex) }))}>{t("admin.templates.removeField")}</BusyButton>
                  </div>
                  <div className="ftm-grid ftm-grid--field">
                    <div className="ftm-field">
                      <label className="ftm-field"><span>{t("admin.templates.fieldKey", { step: stepIndex + 1, count: fieldIndex + 1 })}</span>
                        <input value={field.key} onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, key: event.target.value }))} pattern={`[a-z][a-z0-9_]{1,${FIELD_KEY_MAX_LENGTH - 1}}`} maxLength={FIELD_KEY_MAX_LENGTH} aria-describedby={`${field.editorId}-key-help`} required />
                      </label>
                      <small id={`${field.editorId}-key-help`}>{t("admin.templates.fieldKeyHelp", { max: FIELD_KEY_MAX_LENGTH })}</small>
                    </div>
                    <label className="ftm-field"><span>{t("admin.templates.fieldType", { step: stepIndex + 1, count: fieldIndex + 1 })}</span>
                      <select value={field.type} onChange={(event) => updateField(stepIndex, fieldIndex, (current) => {
                        const type = event.target.value;
                        const next = { ...current, type };
                        if (LENGTH_TYPES.has(type)) next.maxLength = Number(current.maxLength) || 200;
                        else delete next.maxLength;
                        if (CHOICE_TYPES.has(type)) next.options = current.options || [];
                        else delete next.options;
                        return next;
                      })}>
                        {FIELD_TYPES.map((type) => <option value={type} key={type}>{t(`admin.templates.type.${type}`)}</option>)}
                      </select>
                    </label>
                    <label className="ftm-field"><span>{t("admin.templates.fieldLabelEn", { step: stepIndex + 1, count: fieldIndex + 1 })}</span><input value={field.label.en} onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, label: withEnglish(current.label, event.target.value) }))} required /></label>
                    <label className="ftm-field"><span>{t("admin.templates.fieldLabelEs", { step: stepIndex + 1, count: fieldIndex + 1 })}</span><input value={field.label.es} onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, label: { ...current.label, es: event.target.value } }))} /></label>
                    {LENGTH_TYPES.has(field.type) && <label className="ftm-field"><span>{t("admin.templates.maxLength")}</span><input type="number" value={field.maxLength} min="1" max="4000" required onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, maxLength: event.target.value }))} /></label>}
                  </div>
                  <label className="ftm-check"><input type="checkbox" checked={field.required} onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, required: event.target.checked }))} /><span>{t("admin.templates.required")}</span></label>

                  {CHOICE_TYPES.has(field.type) && (
                    <div className="ftm-options">
                      <div className="ftm-options__head">
                        <strong>{t("admin.templates.options")}</strong>
                        <TemplateAddButton busy={busy} count={field.options?.length ?? 0} max={TEMPLATE_LIMITS.options}
                          helpId={`${limitId}-${field.editorId}-options`}
                          description={t("admin.templates.optionLimit", { count: field.options?.length ?? 0, max: TEMPLATE_LIMITS.options })}
                          label={t("admin.templates.addOption")} ariaLabel={t("admin.templates.addOptionAria", { count: fieldIndex + 1 })}
                          limitReached={limitReached}
                          onAdd={() => updateField(stepIndex, fieldIndex, (current) => ({
                            ...current,
                            options: [...(current.options || []), { value: "", label: { en: "", es: "" } }],
                          }))} />
                      </div>
                      {(field.options || []).map((option, optionIndex) => (
                        <div className="ftm-option" key={`option-${optionIndex}`}>
                          <div className="ftm-field">
                            <label className="ftm-field"><span>{t("admin.templates.optionValue", { field: fieldIndex + 1, count: optionIndex + 1 })}</span>
                              <input value={option.value} required pattern={`[a-z0-9_\\-]{1,${OPTION_VALUE_MAX_LENGTH}}`} maxLength={OPTION_VALUE_MAX_LENGTH} aria-describedby={`${field.editorId}-option-${optionIndex}-help`} onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, options: current.options.map((item, index) => index === optionIndex ? { ...item, value: event.target.value } : item) }))} />
                            </label>
                            <small id={`${field.editorId}-option-${optionIndex}-help`}>{t("admin.templates.optionValueHelp", { max: OPTION_VALUE_MAX_LENGTH })}</small>
                          </div>
                          <label className="ftm-field"><span>{t("admin.templates.optionLabelEn", { field: fieldIndex + 1, count: optionIndex + 1 })}</span><input value={option.label.en} required onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, options: current.options.map((item, index) => index === optionIndex ? { ...item, label: withEnglish(item.label, event.target.value) } : item) }))} /></label>
                          <label className="ftm-field"><span>{t("admin.templates.optionLabelEs", { field: fieldIndex + 1, count: optionIndex + 1 })}</span><input value={option.label.es} onChange={(event) => updateField(stepIndex, fieldIndex, (current) => ({ ...current, options: current.options.map((item, index) => index === optionIndex ? { ...item, label: { ...item.label, es: event.target.value } } : item) }))} /></label>
                          <BusyButton type="button" className="ftm-icon-btn ftm-icon-btn--danger" aria-label={t("admin.templates.removeOption", { count: optionIndex + 1 })} pending={busy} onClick={() => updateField(stepIndex, fieldIndex, (current) => ({ ...current, options: current.options.filter((_, index) => index !== optionIndex) }))}>×</BusyButton>
                        </div>
                      ))}
                    </div>
                  )}
                </fieldset>
              ))}
            </div>
            <TemplateAddButton busy={busy} count={step.fields.length} max={TEMPLATE_LIMITS.fields}
              helpId={`${limitId}-${step.editorId}-fields`}
              description={t("admin.templates.fieldLimit", { count: step.fields.length, max: TEMPLATE_LIMITS.fields })}
              label={t("admin.templates.addField")} limitReached={limitReached}
              onAdd={() => updateStep(stepIndex, (current) => ({ ...current, fields: [...current.fields, emptyField()] }))} />
          </fieldset>
        ))}
      </div>

      <div className="ftm-actions">
        <BusyButton type="submit" className="ftm-btn ftm-btn--primary" pending={busy}>{t(busy ? "admin.templates.saving" : "admin.templates.save")}</BusyButton>
        <div className="ftm-save-feedback" role="alert" aria-atomic="true">
          {saveError && <p className="ftm-feedback ftm-feedback--error">{saveError}</p>}
        </div>
        <BusyButton type="button" className="ftm-btn ftm-btn--quiet" onClick={onCancel} pending={busy}>{t("admin.templates.cancelEditing")}</BusyButton>
      </div>
    </form>
  );
}

// A template key is for the people who wire forms to other records, not for a
// reader scanning the list: it stays one click away
// (UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122).
export function TemplateKeyDetails({ summary, name, label }) {
  return (
    <details className="ftm-card__key">
      <summary aria-label={name}>{summary}</summary>
      <p>{label}</p>
    </details>
  );
}

export function AdminFormTemplateEditor({ api, demo = false }) {
  const { t, lang } = useLang();
  const apiRef = useRef(api);
  apiRef.current = api;
  const sectionRef = useRef(null);
  const createButtonRef = useRef(null);
  const editorOpenerRef = useRef(null);
  const editorReturnRef = useRef(null);
  const editButtonRefs = useRef(new Map());
  const confirmOpenerRef = useRef(null);
  const confirmSurfaceRef = useRef(null);
  const rowFocusRequestRef = useRef(null);
  const rowActionRefs = useRef(new Map());
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [savedTemplate, setSavedTemplate] = useState(null);
  const [draft, setDraft] = useState(null);
  const draftRevision = useRef(0);
  const loadRequest = useRef(0);
  const [mode, setMode] = useState("create");
  const [busy, setBusy] = useState("");
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [confirmKey, setConfirmKey] = useState("");

  const load = useCallback(async ({ quiet = false } = {}) => {
    const request = ++loadRequest.current;
    if (!quiet) setLoading(true);
    setLoadError("");
    try {
      const nextRows = await apiRef.current.loadFormTemplates();
      if (request === loadRequest.current) setRows(nextRows);
    } catch {
      // RPC/PostgREST details can contain policy names or database structure.
      // Keep the admin-facing state localized and non-enumerating; the API
      // wrappers still propagate exact errors to diagnostics and tests.
      if (request === loadRequest.current) setLoadError(t("admin.templates.loadFailed"));
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  // Save disables the opener until the request settles. Focus it once it is
  // enabled again, or the section if that button is no longer connected.
  useLayoutEffect(() => {
    if (draft || busy) return;
    const opener = editorReturnRef.current;
    if (!opener) return;
    editorReturnRef.current = null;
    const saved = editorOpenerRef.current;
    const successor = saved?.kind === "create"
      ? createButtonRef.current
      : saved?.kind === "edit"
        ? editButtonRefs.current.get(saved.key)?.current ?? null
        : null;
    if (!focusUsable(opener)) {
      if (!focusUsable(successor)) focusUsable(sectionRef.current);
    }
  }, [draft, busy]);

  useLayoutEffect(() => {
    if (!confirmKey) return;
    confirmSurfaceRef.current?.focus();
  }, [confirmKey]);

  // Deactivation disables the opener, and success replaces it with Reactivate.
  // Focus the same control once it is enabled, or the button that took its place.
  useLayoutEffect(() => {
    if (confirmKey || busy) return;
    const request = rowFocusRequestRef.current;
    if (!request) return;
    rowFocusRequestRef.current = null;
    const successor = rowActionRefs.current.get(request.key)?.current ?? null;
    if (!focusUsable(request.opener)) focusUsable(successor);
  }, [confirmKey, busy]);

  const groups = registryGroups(rows || []);
  const savedByHeader = savedTemplate && (loading || loadError || !groups.some(({ key }) => key === savedTemplate.openerKey));
  const updateDraft = (update) => {
    draftRevision.current += 1;
    setSaveError("");
    setDraft(update);
  };
  const closeEditor = () => {
    editorReturnRef.current = editorOpenerRef.current?.element ?? null;
    updateDraft(null);
    setActionError("");
  };
  const beginCreate = (event) => {
    editorOpenerRef.current = { kind: "create", key: null, element: event.currentTarget };
    setActionError("");
    setNotice("");
    setSavedTemplate(null);
    setMode("create");
    updateDraft(emptyTemplate());
  };
  const beginEdit = (row, event) => {
    editorOpenerRef.current = { kind: "edit", key: row.key, element: event.currentTarget };
    setActionError("");
    setNotice("");
    setSavedTemplate(null);
    setMode("edit");
    updateDraft(draftFromRow(row));
  };

  function save(event) {
    return runBusyWrite(busyWriteRef, "template", () => saveNow(event), event);
  }

  async function saveNow(event) {
    event.preventDefault();
    if (busy) return;
    const validationError = validateDraft(draft, t);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    const revision = draftRevision.current;
    const openerKey = editorOpenerRef.current?.key;
    setBusy("save");
    setSaveError("");
    setActionError("");
    setNotice("");
    try {
      await apiRef.current.upsertFormTemplate(normalizedDraft(draft));
    } catch (error) {
      if (draftRevision.current === revision) setSaveError(t(rpcRefusalKey(error, "admin.templates.saveFailed")));
      return;
    } finally {
      setBusy("");
    }
    if (draftRevision.current === revision) {
      closeEditor();
      setSavedTemplate({ openerKey, messageKey: demo ? "admin.templates.savedDemo" : "admin.templates.saved" });
    }
    void load({ quiet: true });
  }

  function toggle(row) {
    return runBusyWrite(busyWriteRef, "template", () => toggleNow(row));
  }

  async function toggleNow(row) {
    if (busy) return;
    setConfirmKey("");
    setBusy(`toggle:${row.key}`);
    setActionError("");
    setNotice("");
    setSavedTemplate(null);
    try {
      if (row.active) await apiRef.current.deactivateFormTemplate(row.key);
      else await apiRef.current.reactivateFormTemplate(row.key);
      setNotice(t(row.active ? "admin.templates.deactivated" : "admin.templates.reactivated"));
      await load({ quiet: true });
    } catch {
      setActionError(t("admin.templates.actionFailed"));
    } finally {
      setBusy("");
    }
  }

  return (
    <section ref={sectionRef} id="admin-form-templates" className="ftm-section role-section-target" tabIndex="-1" aria-labelledby="admin-form-templates-title">
      <header className="ftm-section__head">
        <div>
          <p className="ftm-kicker">{t("admin.templates.kicker")}</p>
          <WorkspaceCardTitle outline id="admin-form-templates-title">{t("admin.templates.title")}</WorkspaceCardTitle>
          <p>{t("admin.templates.sub")}</p>
        </div>
        <BusyButton type="button" className="ftm-btn ftm-btn--primary" ref={createButtonRef} onClick={beginCreate} pending={Boolean(busy)}>{t("admin.templates.new")}</BusyButton>
      </header>

      <div role="status" aria-atomic="true" className="ftm-save-feedback">
        {savedByHeader && <p className="ftm-feedback ftm-feedback--success">{t(savedTemplate.messageKey)}</p>}
      </div>
      {demo && <p className="ftm-demo-note">{t("admin.templates.demo")}</p>}
      {notice && <p className="ftm-feedback ftm-feedback--success" role="status">{notice}</p>}
      {actionError && <p className="ftm-feedback ftm-feedback--error" role="alert">{actionError}</p>}

      {draft && <TemplateForm draft={draft} mode={mode} busy={busy === "save"} saveError={saveError} onChange={updateDraft} onCancel={closeEditor} onSubmit={save} t={t} />}

      {loading && <div className="ftm-state" aria-live="polite"><span className="ftm-spinner" aria-hidden="true" />{t("admin.templates.loading")}</div>}
      {!loading && loadError && (
        <div className="ftm-state ftm-state--error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="ftm-btn" onClick={() => load()}>{t("app.tryAgain")}</button>
        </div>
      )}
      {!loading && !loadError && groups.length === 0 && <p className="ftm-state">{t("admin.templates.empty")}</p>}
      {!loading && !loadError && groups.length > 0 && (
        <div className="ftm-list" role="list" aria-label={t("admin.templates.listLabel")}>
          {groups.map(({ key, latest, versions }) => {
            const title = (lang === "es" ? latest.label_es : latest.label_en) || latest.label_en || key;
            const description = (lang === "es" ? latest.blurb_es : latest.blurb_en) || "";
            const toggling = busy === `toggle:${key}`;
            return (
              <article className="ftm-card" role="listitem" key={key} aria-busy={toggling}>
                <div className="ftm-card__icon" aria-hidden="true"><FileText size={20} /></div>
                <div className="ftm-card__main">
                  <div className="ftm-card__titleline">
                    <h3>{title}</h3>
                    <span className={`ftm-status ${latest.active ? "ftm-status--active" : "ftm-status--inactive"}`}>{t(latest.active ? "admin.templates.active" : "admin.templates.inactive")}</span>
                  </div>
                  {description && <p className="ftm-card__description">{description}</p>}
                  <p className="ftm-card__meta">
                    {/* The step/field summary keys also print a points figure,
                        and Union Ground has no points economy, so only the
                        version line shows until points-free copy exists. */}
                    <span>{t(versions.length === 1 ? "admin.templates.versionMetaOne" : "admin.templates.versionMeta", { version: latest.version, count: versions.length })}</span>
                  </p>
                  <TemplateKeyDetails summary={t("admin.templates.technicalDetails")} name={t("admin.templates.technicalDetailsAria", { title })} label={t("admin.templates.keyValue", { key })} />
                </div>
                <div className="ftm-card__actions">
                  <BusyButton type="button" className="ftm-btn" ref={refBucket(editButtonRefs.current, key)} pending={Boolean(busy)} onClick={(event) => beginEdit(latest, event)}>{t("admin.templates.edit")}</BusyButton>
                  <div role="status" aria-atomic="true" className="ftm-save-feedback">
                    {savedTemplate?.openerKey === key && <p className="ftm-feedback ftm-feedback--success">{t(savedTemplate.messageKey)}</p>}
                  </div>
                  {latest.active ? (
                    <BusyButton type="button" className="ftm-btn ftm-btn--danger-quiet" ref={refBucket(rowActionRefs.current, key)} pending={Boolean(busy)} aria-label={t("admin.templates.deactivateAria", { title })} onClick={(event) => { confirmOpenerRef.current = event.currentTarget; setConfirmKey(key); }}>{t("admin.templates.deactivate")}</BusyButton>
                  ) : (
                    <BusyButton type="button" className="ftm-btn ftm-btn--primary" ref={refBucket(rowActionRefs.current, key)} pending={Boolean(busy)} aria-label={t("admin.templates.reactivateAria", { title })} onClick={() => toggle(latest)}>{t(toggling ? "admin.templates.updating" : "admin.templates.reactivate")}</BusyButton>
                  )}
                </div>
                {confirmKey === key && (
                  <div ref={confirmSurfaceRef} className="ftm-confirm" role="group" tabIndex={-1} aria-label={t("admin.templates.deactivateConfirmAria", { title })}>
                    <p>{t("admin.templates.deactivateConfirm", { title })}</p>
                    <div>
                      <BusyButton type="button" className="ftm-btn ftm-btn--danger" pending={Boolean(busy)} onClick={() => { rowFocusRequestRef.current = { opener: confirmOpenerRef.current, key }; void toggle(latest); }}>{t(toggling ? "admin.templates.updating" : "admin.templates.confirmDeactivate")}</BusyButton>
                      <BusyButton type="button" className="ftm-btn" pending={Boolean(busy)} onClick={() => { rowFocusRequestRef.current = { opener: confirmOpenerRef.current, key }; setConfirmKey(""); }}>{t("admin.cancel")}</BusyButton>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
