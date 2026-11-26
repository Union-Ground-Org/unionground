import { useEffect, useId, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { WorkspaceSection } from "./WorkspacePages.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { WORKLOAD_DEFINITION_LIMITS, WORKLOAD_FIELD_TYPES, WORKLOAD_PERIODS, defaultWorkloadDefinition, workloadDefinitionProblem, workloadFieldLabel } from "../lib/workloadConfiguration.js";
import { WorkloadConfiguredEntry } from "./WorkloadConfiguredEntry.jsx";
import "../lib/i18n/features/workloadConfigurationEditorStrings.js";

// Keep the typed text while editing so a space before the next word survives;
// the draft always holds the trimmed list, and blur shows its normal form.
function CommaListInput({ value, onChange, "aria-invalid": invalid, "aria-describedby": describedBy }) {
  const [text, setText] = useState(null);
  return <input aria-invalid={invalid} aria-describedby={describedBy} className="xus-input" value={text ?? value.join(", ")} onBlur={() => setText(null)}
    onChange={(e) => { setText(e.target.value); onChange(e.target.value.split(",").map((s) => s.trim())); }} />;
}

export function WorkloadConfigurationCard({ chapterScoped = false, api, onNotice }) {
  const { t, lang } = useLang();
  const problemId = useId();
  const [server, setServer] = useState(null);
  const [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [failed, setFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    if (chapterScoped) return;
    let live = true;
    async function load() {
      try {
        const payload = await api.loadWorkloadConfiguration();
        if (live && payload) {
          setServer(payload);
          setDraft(payload.definition);
          setLoadFailed(false);
        }
      } catch {
        if (live) setLoadFailed(true);
      }
    }
    void load();
    return () => { live = false; };
  }, [api, chapterScoped, loadAttempt]);
  if (chapterScoped) return null;
  const change = (next) => { setDraft(next); setPreview(false); setFailed(false); };
  const fieldChange = (index, patch) => change({ ...draft, fields: draft.fields.map((f, i) => i === index ? { ...f, ...patch } : f) });
  function move(index, step) {
    const fields = [...draft.fields];
    [fields[index], fields[index + step]] = [fields[index + step], fields[index]];
    change({ ...draft, fields });
  }
  function addField() {
    let n = 1; while (draft.fields.some((f) => f.key === `custom_${n}`)) n += 1;
    change({ ...draft, fields: [...draft.fields, { key: `custom_${n}`, label: t("workload.config.newField"), type: "number", kind: "field", required: false, visible: true, retired: false, unit: "", summary: "none", options: [] }] });
  }
  function apply() {
    return runBusyWrite(busyWriteRef, "configuration", () => applyNow());
  }

  async function applyNow() {
    setBusy(true); setFailed(false);
    try {
      const result = await api.saveWorkloadConfiguration(draft, server.version, server.organizationId);
      if (!result) return;
      setServer(result); setDraft(result.definition); setPreview(false);
      onNotice?.(t("workload.config.applied"));
    } catch { setFailed(true); setPreview(false); } finally { setBusy(false); }
  }
  const problem = draft ? workloadDefinitionProblem(draft) : null;
  const labelFor = (field) => typeof field?.label === "string" && field.label.trim() ? workloadFieldLabel(field, lang) : field?.key;
  const namedField = (key) => labelFor(draft.fields.find((field) => field.key === key)
    ?? defaultWorkloadDefinition().fields.find((field) => field.key === key));
  const reason = problem ? t(`workloadEditor.${problem.reason}`, {
    ...WORKLOAD_DEFINITION_LIMITS,
    field: problem.dependent ? namedField(problem.dependent) : labelFor(draft.fields?.[problem.index]),
    related: problem.controller ? namedField(problem.controller) : undefined,
    number: problem.index === undefined ? undefined : problem.index + 1,
  }) : null;
  const problemAttributes = (control, index) => problem?.control === control && problem.index === index
    ? { "aria-invalid": true, "aria-describedby": problemId }
    : {};
  const problemMessage = <p id={problemId} className="xus-note xus-note--error">{reason}</p>;
  return <WorkspaceSection name="admin-labels"><article className={`${PLANE_CARD_CLASS} xus-card workload-configuration-settings`} id="admin-workload-configuration">
    <header className="xus-cardhead"><div className="xus-cardhead__copy"><h2 className="xus-cardttl">{t("workload.config.title")}</h2><p className="xus-cardsub">{t("workload.config.description")}</p></div></header>
    <div className="xus-cardbody xus-form">
      {failed && <p className="xus-note xus-note--error" role="alert">{t("workload.config.failed")}</p>}
      {loadFailed && <>
        <p role="alert" className="xus-note xus-note--error">{t("workloadEditor.loadFailed")}</p>
        <button type="button" className="xus-btn" onClick={() => { setLoadFailed(false); setLoadAttempt((attempt) => attempt + 1); }}>{t("app.tryAgain")}</button>
      </>}
      {!draft ? !loadFailed && <p role="status">{t("workload.config.loading")}</p> : !server.canEdit ? <p>{t("workload.config.adminOnly")}</p> : <>
        <p className="xus-note">{t("workload.config.limits")}</p>
        <p className="xus-note">{t("workload.config.nativeLimit")}</p>
        <p className="xus-note">{t("workload.config.collectiveCategories")}</p>
        <p className="xus-note">{t("workload.config.historyRule")}</p>
        <label className="xus-field"><span>{t("workload.config.formTitle")}</span><input {...problemAttributes("title")} className="xus-input" value={draft.title} maxLength={WORKLOAD_DEFINITION_LIMITS.label} onChange={(e) => change({ ...draft, title: e.target.value })} /></label>
        {problem?.control === "title" && problemMessage}
        <label className="xus-field"><span>{t("workload.config.period")}</span><select {...problemAttributes("period")} className="xus-input" value={draft.period} onChange={(e) => change({ ...draft, period: e.target.value })}>{WORKLOAD_PERIODS.map((p) => <option value={p} key={p}>{t(`workload.config.period.${p}`)}</option>)}</select></label>
        {problem?.control === "period" && problemMessage}
        <label className="xus-field"><span>{t("workload.config.statuses")}</span><CommaListInput {...problemAttributes("statuses")} value={draft.statuses} onChange={(statuses) => change({ ...draft, statuses })} /></label>
        {problem?.control === "statuses" && problemMessage}
        <ol className="xus-workload-list">
          {draft.fields.map((field, index) => <li key={field.key} className="workload-definition-field">
            <strong>{index + 1}. {workloadFieldLabel(field, lang)} <small>({field.key})</small></strong>
            <div className="workload-configured-fields">
              <label className="xus-field"><span>{t("workload.config.label")}</span><input {...problemAttributes("label", index)} className="xus-input" aria-label={`${t("workload.config.label")} ${field.key}`} value={workloadFieldLabel(field, lang)} maxLength={WORKLOAD_DEFINITION_LIMITS.label} onChange={(e) => fieldChange(index, { label: e.target.value })} /></label>
              <label className="xus-field"><span>{t("workload.config.type")}</span><select {...problemAttributes("type", index)} className="xus-input" value={field.type} disabled={defaultWorkloadDefinition().fields.some((f) => f.key === field.key)} aria-label={`${t("workload.config.type")} ${field.key}`} onChange={(e) => fieldChange(index, { type: e.target.value, kind: "field", summary: "none", options: e.target.value === "select" ? [t("workload.config.option")] : [] })}>{WORKLOAD_FIELD_TYPES.map((type) => <option key={type}>{type}</option>)}</select></label>
              <label className="xus-field"><span>{t("workload.config.kind")}</span><select {...problemAttributes("kind", index)} className="xus-input" value={field.kind} disabled={defaultWorkloadDefinition().fields.some((f) => f.key === field.key && f.type !== "number")} onChange={(e) => fieldChange(index, { kind: e.target.value, ...(e.target.value === "category" ? { type: "number" } : {}) })}><option value="field">{t("workload.config.field")}</option><option value="category">{t("workload.config.category")}</option></select></label>
              <label className="xus-field"><span>{t("workload.config.unit")}</span><input {...problemAttributes("unit", index)} className="xus-input" value={field.unit} disabled={defaultWorkloadDefinition().fields.some((f) => f.key === field.key)} maxLength={WORKLOAD_DEFINITION_LIMITS.unit} onChange={(e) => fieldChange(index, { unit: e.target.value })} /></label>
              <label className="xus-field"><span>{t("workload.config.summary")}</span><select {...problemAttributes("summary", index)} className="xus-input" value={field.summary} disabled={field.type !== "number"} onChange={(e) => fieldChange(index, { summary: e.target.value })}>{["none", "sum", "average"].map((s) => <option value={s} key={s}>{t(`workload.config.summary.${s}`)}</option>)}</select></label>
              {field.type === "select" && <label className="xus-field"><span>{t("workload.config.options")}</span><CommaListInput {...problemAttributes("options", index)} value={field.options} onChange={(options) => fieldChange(index, { options })} /></label>}
            </div>
            {problem?.index === index && problemMessage}
            <div className="workload-configured-actions">
              {["required", "visible", "retired"].map((flag) => <label key={flag} className="xus-field xus-field--check"><input {...problemAttributes(flag, index)} type="checkbox" checked={field[flag]} aria-label={`${t(`workload.config.${flag}`)} ${field.key}`} onChange={(e) => fieldChange(index, { [flag]: e.target.checked, ...((flag === "retired" && e.target.checked) || (flag === "visible" && !e.target.checked) ? { required: false } : {}) })} />{t(`workload.config.${flag}`)}</label>)}
              <button type="button" className="xus-btn" disabled={index === 0} aria-label={`${t("workload.config.up")} ${field.key}`} onClick={() => move(index, -1)}>↑</button>
              <button type="button" className="xus-btn" disabled={index === draft.fields.length - 1} aria-label={`${t("workload.config.down")} ${field.key}`} onClick={() => move(index, 1)}>↓</button>
            </div>
          </li>)}
        </ol>
        <BusyButton className="xus-btn" type="button" pending={busy} disabled={draft.fields.length >= WORKLOAD_DEFINITION_LIMITS.fields} onClick={addField}>{t("workload.config.add")}</BusyButton>
        {/* One polite announcement of the current first problem, so a reason
            that appears or changes while focus stays in a field is heard. */}
        <p className="sr-only" role="status" data-workload-problem="">{reason}</p>
        <div className="workload-configured-actions">
          <BusyButton className="xus-btn" type="button" pending={busy} disabled={Boolean(problem)} disabledReason={reason} onClick={() => setPreview(true)}>{t("workload.config.preview")}</BusyButton>
          <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy} disabled={!preview || Boolean(problem)}
            disabledReason={reason ?? t("workloadEditor.previewFirst")} onClick={apply}>{busy ? t("auth.working") : t("workload.config.apply")}</BusyButton>
        </div>
        {preview && <section aria-label={t("workload.config.preview")}><WorkloadConfiguredEntry key={JSON.stringify(draft)} configuration={{ ...server, definition: draft, version: server.version + 1 }} preview /></section>}
        <details><summary>{t("workload.config.history")}</summary><ul>{(server.history || []).map((v) => <li key={v.version}><details><summary>{t("workload.config.version", { version: v.version })} · {v.createdAt}</summary><pre className="workload-version-definition">{JSON.stringify(v.definition, null, 2)}</pre></details></li>)}</ul></details>
      </>}
    </div>
  </article></WorkspaceSection>;
}
