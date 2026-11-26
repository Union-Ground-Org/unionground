import { useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { configuredWorkloadCsv, defaultWorkloadDefinition, workloadFieldLabel, workloadPersonalSummary, workloadEntryPeriod, workloadStatusText, workloadUnitText, workloadValueText } from "../lib/workloadConfiguration.js";
import { WorkloadConfiguredEntry } from "./WorkloadConfiguredEntry.jsx";

// Legacy entries have no version: show their original fixed field meanings.
export function withWorkloadHistoryDefinition(entry) {
  if (entry.configurationSnapshot?.definition) return entry;
  return { ...entry, configurationSnapshot: { version: 0, definition: defaultWorkloadDefinition() }, status: "logged", values: { ...entry.counts, ...(entry.workedOn ? { workedOn: entry.workedOn } : {}), ...(entry.hoursWorked != null ? { hoursWorked: entry.hoursWorked } : {}), ...(entry.note ? { note: entry.note } : {}) } };
}

export function WorkloadConfiguredHistory({ entries, onSave, unitContext = null, requireUnitContext = false }) {
  const { t, lang } = useLang();
  const [status, setStatus] = useState("");
  const [period, setPeriod] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [editing, setEditing] = useState(null);
  const rows = entries.map(withWorkloadHistoryDefinition);
  const statuses = [...new Set(rows.map((e) => e.status))];
  const periods = [...new Set(rows.map((e) => workloadEntryPeriod(e)).filter(Boolean))];
  const fields = [...new Map(rows.flatMap((e) => e.configurationSnapshot.definition.fields.map((f) => [f.key, f]))).values()];
  const filtered = rows.filter((e) => (!status || e.status === status)
    && (!period || workloadEntryPeriod(e) === period)
    && (!fieldKey || Object.hasOwn(e.values || {}, fieldKey)));
  const summary = workloadPersonalSummary(filtered);
  const editConfiguration = (entry) => {
    const original = entry.configurationSnapshot;
    if (!unitContext?.effective?.configuration) {
      // No unit context (per-unit settings held, or a chapter without units):
      // the edit goes through the ordinary save, whatever unit the row names
      // (gate stage 184 r3s4).
      const { unitId: _unitId, ...ordinary } = original;
      return ordinary;
    }
    const current = unitContext.effective.configuration;
    // The chosen unit supplies context for an old unbound row, never its
    // original fields, values or version. A bound row keeps its own unit:
    // the snapshot's, else the one its settings_scope was stamped with when an
    // older snapshot was first edited (ledger 231).
    const boundUnitId = Object.hasOwn(original, "unitId") ? original.unitId : entry.unitPinned ? entry.unitId ?? null : undefined;
    if (boundUnitId === null) {
      // Bound to the chapter itself (ledger 238): the unit save reads a null
      // unit as the member's current unit and the row's stamp then refuses
      // it ("work belongs to another unit"), so the edit keeps the chapter
      // binding through the ordinary save, which leaves the stamp as it is.
      const { unitId: _unitId, ...ordinary } = original;
      return ordinary;
    }
    return { ...original, actorId: unitContext.actorId, chapterId: unitContext.chapterId,
      organizationId: original.organizationId || current.organizationId,
      unitId: boundUnitId === undefined ? unitContext.unitId : boundUnitId,
      settingsRevision: original.settingsRevision || current.settingsRevision };
  };
  function download() {
    const url = URL.createObjectURL(new Blob([configuredWorkloadCsv(filtered)], { type: "text/csv;charset=utf-8;" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "workload-log.csv";
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
  }
  return <section className="mwl-body xus-form">
    <h2 className="mwl-cardtitle">{t("workload.config.personalReport")}</h2>
    <div className="workload-configured-fields">
      <label className="xus-field"><span>{t("workload.config.status")}</span><select className="xus-input" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t("workload.config.all")}</option>{statuses.map((s) => <option key={s} value={s}>{workloadStatusText(s, lang)}</option>)}</select></label>
      <label className="xus-field"><span>{t("workload.config.period")}</span><select className="xus-input" value={period} onChange={(e) => setPeriod(e.target.value)}><option value="">{t("workload.config.all")}</option>{periods.map((p) => <option key={p}>{p}</option>)}</select></label>
      <label className="xus-field"><span>{t("workload.config.field")}</span><select className="xus-input" value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}><option value="">{t("workload.config.all")}</option>{fields.map((f) => <option value={f.key} key={f.key}>{workloadFieldLabel(f, lang)}</option>)}</select></label>
    </div>
    <p className="xus-note">{t("workload.config.summaryRule")}</p>
    <ul>{summary.map((s) => <li key={s.key}>{s.unitName ? `${s.unitName} · ` : ""}{s.period} · {t("workload.config.version", { version: s.version })} · {workloadFieldLabel(s.field, lang)}: {Number(s.value.toFixed(2))} {workloadUnitText(s.field, lang)}</li>)}</ul>
    <button className="mwl-btn mwl-btn--ghost" type="button" disabled={!filtered.length} onClick={download}>{t("workload.downloadCsv")}</button>
    {!filtered.length && <p>{t("workload.histEmpty")}</p>}
    <div className="mwl-histlist">{filtered.map((entry) => <article className="mwl-card mwl-histrow" key={entry.id}>
      <strong>{entry.dateLabel} · {workloadStatusText(entry.status, lang)} · {t("workload.config.version", { version: entry.configurationSnapshot.version })}</strong>
      <dl>{entry.configurationSnapshot.definition.fields.filter((f) => Object.hasOwn(entry.values || {}, f.key)).map((f) => <div key={f.key}><dt>{workloadFieldLabel(f, lang)}{f.unit ? ` (${workloadUnitText(f, lang)})` : ""}</dt><dd>{workloadValueText(f, entry.values[f.key], lang)}</dd></div>)}</dl>
      {entry.meta && entry.configurationSnapshot.version === 0 && <span>{entry.meta}</span>}
      <span>#{entry.receipt}</span>
      {(entry.unitName || entry.configurationSnapshot?.unitName) && <span>{entry.unitName || entry.configurationSnapshot?.unitName}</span>}
      {onSave && entry.configurationSnapshot.organizationId && <button className="mwl-btn mwl-btn--ghost" type="button" disabled={requireUnitContext && !unitContext?.effective} onClick={() => setEditing(entry.id)}>{t("workload.config.edit")}</button>}
      {editing === entry.id && (!requireUnitContext || unitContext?.effective) && <WorkloadConfiguredEntry key={`${entry.id}:${unitContext?.unitId}`} configuration={editConfiguration(entry)} entry={entry} onCancel={() => setEditing(null)} onSave={async (values) => { const result = await onSave(values); if (result) setEditing(null); return result; }} />}
    </article>)}</div>
  </section>;
}
