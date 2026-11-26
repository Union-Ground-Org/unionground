import { useEffect, useRef, useState } from "react";
import { BusyButton, BusyInput, BusySelect } from "./BusyControls.jsx";
import { prepareBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { canonicalWorkloadValues, emptyWorkloadDraft, visibleWorkloadFields, workloadChoiceText, workloadFieldLabel, workloadStatusText, workloadTitleText, workloadUnitText, workloadValueProblems } from "../lib/workloadConfiguration.js";
import "./workloadConfiguration.css";

// BUG-UG-NATIVE-WORKLOAD-LOG-SAVE-REFUSAL-NAMES-NO-FIELD-20261118
// (#9101), the website half: a refused save says beside each field what to
// change, from the shared rules (src/lib/workloadValues.js), as the phone does.
const CROSS_FIELD_RULES = new Set(["overtimeHoursNeeded", "overtimeNotMarked", "partTimeHoursNeeded", "leaveTimingNeeded"]);
function workloadProblemText(problem, field, t, lang) {
  if (problem.rule === "required" && field.type === "date") return t("workload.config.rule.requiredDate");
  const limit = problem.limit === undefined ? "" : problem.limit.toLocaleString(lang);
  return t(`workload.config.rule.${problem.rule}`, { limit });
}

function WorkloadConfiguredFields({ definition, values, onChange, pending = false, legacy = false, prefix = "workload-configured", problems = {} }) {
  const { t, lang } = useLang();
  return <div className="workload-configured-fields">
    {visibleWorkloadFields(definition).map((field) => {
      const label = workloadFieldLabel(field, lang);
      const id = `${prefix}-${field.key}`;
      // Own answers only, so an empty field keyed constructor or toString shows empty (#9123).
      const value = Object.hasOwn(values, field.key) ? values[field.key] : undefined;
      // Own entries only, so a field keyed constructor or toString has no note unless one was set.
      const problem = Object.hasOwn(problems, field.key) ? problems[field.key] : undefined;
      const invalid = problem ? { "aria-invalid": true, "aria-describedby": `${id}-problem` } : {};
      // The note sits beside its field, outside the label, so the field's name
      // stays its name and the note is read as its description.
      return <div className="workload-configured-field" key={field.key}><label className="xus-field" htmlFor={id}>
        <span>{label}{field.required ? " *" : ""}{field.unit ? ` (${workloadUnitText(field, lang)})` : ""}</span>
        {field.type === "select"
          ? <BusySelect id={id} {...invalid} className="xus-input" required={field.required} pending={pending} value={value ?? ""} onChange={(e) => onChange(field.key, e.target.value)}>
            <option value="">{t("workload.config.choose")}</option>{field.options.map((o) => <option key={o} value={o}>{workloadChoiceText(field, o, lang)}</option>)}
          </BusySelect>
          : field.type === "boolean"
            ? <BusyInput id={id} {...invalid} type="checkbox" pending={pending} checked={value === true} onChange={(e) => onChange(field.key, e.target.checked)} />
            : <BusyInput id={id} {...invalid} className="xus-input" pending={pending} type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
              step={field.type === "number" ? "any" : undefined} min={field.type === "number" ? 0 : undefined} maxLength={field.type === "text" ? (legacy && field.key === "note" ? 4000 : 500) : undefined}
              required={field.required} value={value ?? ""} onChange={(e) => onChange(field.key, field.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />}
      </label>
      {problem && <span id={`${id}-problem`} className="mwl-error">{workloadProblemText(problem, field, t, lang)}</span>}</div>;
    })}
  </div>;
}

export function WorkloadConfiguredEntry({ configuration, onSave, entry = null, onCancel = null, preview = false, draft, onDraftChange, onBusyChange }) {
  const { t, lang } = useLang();
  const definition = configuration.definition;
  const [localDraft, setLocalDraft] = useState(() => entry ? { values: entry.values, status: entry.status } : emptyWorkloadDraft(definition));
  const { values, status } = draft || localDraft;
  const setDraft = onDraftChange || setLocalDraft;
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [message, setMessage] = useState(null);
  const [problems, setProblems] = useState({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange?.(false); }; }, [onBusyChange]);
  const change = (key, value) => {
    setDraft((old) => ({ ...old, values: { ...old.values, [key]: value } })); setMessage(null);
    setProblems((old) => Object.fromEntries(Object.entries(old).filter(([field, problem]) => field !== key && !CROSS_FIELD_RULES.has(problem.rule))));
  };
  // Validation starts no write, so it stays synchronous: a corrected submit
  // right after a refused one goes through. Only the write takes the lock.
  function save(event) {
    return prepareBusyWrite(busyWriteRef, "entry", () => {
      event.preventDefault();
      const clean = canonicalWorkloadValues(definition, values);
      const checked = workloadValueProblems(definition, clean, status, configuration.version === 0);
      setProblems(Object.fromEntries(checked.fields.map((problem) => [problem.key, problem])));
      if (checked.fields.length) {
        setMessage({ error: true, key: "workload.config.fieldsToFix", fields: checked.fields.map((problem) => problem.key) }); return undefined;
      }
      if (checked.form) { setMessage({ error: true, key: checked.form === "size" ? "workload.config.tooLong" : "workload.config.invalidValues" }); return undefined; }
      return () => saveNow(clean);
    }, event);
  }

  async function saveNow(clean) {
    setBusy(true); onBusyChange?.(true); setMessage(null);
    try {
      const result = await onSave({ organizationId: configuration.organizationId, configurationVersion: configuration.version, values: clean, status, entryId: entry?.id,
        ...(Object.hasOwn(configuration, "unitId") ? { unitId: configuration.unitId, settingsRevision: configuration.settingsRevision, actorId: configuration.actorId, chapterId: configuration.chapterId } : {}),
      });
      if (!result || !mounted.current) return;
      if (!entry) setDraft(emptyWorkloadDraft(definition));
      setMessage({ error: false, key: "workload.config.entrySaved" });
    } catch (error) {
      if (!mounted.current) return;
      setMessage({ error: true, key: error?.details === "workload_configuration_changed" ? "workload.config.changed" : error?.details === "workload_daily_limit" ? "rpcError.workload_daily_limit" : "workload.submitFailed" });
    } finally { if (mounted.current) { setBusy(false); onBusyChange?.(false); } }
  }
  const messageText = message && t(message.key, message.fields ? {
    fields: message.fields.map((key) => visibleWorkloadFields(definition).find((field) => field.key === key)).filter(Boolean).map((field) => workloadFieldLabel(field, lang)).join(", "),
  } : undefined);
  return <form className="mwl-card xus-form workload-configured-form" onSubmit={save}>
    <h2 className="mwl-cardtitle">{workloadTitleText(definition, lang)} · {t("workload.config.version", { version: configuration.version })}</h2>
    <WorkloadConfiguredFields definition={definition} values={canonicalWorkloadValues(definition, values)} onChange={change} pending={busy} legacy={configuration.version === 0} prefix={preview ? "workload-preview" : entry?.id || "workload-entry"} problems={problems} />
    <label className="xus-field"><span>{t("workload.config.status")}</span>
      <BusySelect className="xus-input" value={status} pending={busy} onChange={(e) => setDraft((old) => ({ ...old, status: e.target.value }))}>{definition.statuses.map((s) => <option key={s} value={s}>{workloadStatusText(s, lang)}</option>)}</BusySelect>
    </label>
    {!preview && <div className="workload-configured-actions">
      <BusyButton className="mwl-btn mwl-btn--go" pending={busy} type="submit">{busy ? t("auth.working") : t(entry ? "workload.config.saveEdit" : "workload.submitCta")}</BusyButton>
      {onCancel && <BusyButton className="mwl-btn mwl-btn--ghost" type="button" pending={busy} onClick={onCancel}>{t("workload.config.cancel")}</BusyButton>}
    </div>}
    {message && <p role={message.error ? "alert" : "status"} className={message.error ? "mwl-error" : "mwl-success"}>{messageText}</p>}
  </form>;
}
