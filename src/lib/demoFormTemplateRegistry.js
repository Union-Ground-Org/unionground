// Pure in-memory twin of the versioning behavior in upsert_form_template and
// the two active-state RPCs. It never touches Supabase; App keeps the returned
// rows only for the lifetime of the demo session.
import { cloneDemoFormTemplates } from "../data/demoData.js";

export function upsertDemoFormTemplate(rows, fields, timestamp = new Date().toISOString()) {
  const labelEn = typeof fields.labelEn === "string" ? fields.labelEn.trim() : "";
  if (!labelEn || Array.from(labelEn).length > 120) throw new Error("English label must contain 1–120 characters.");
  const current = cloneDemoFormTemplates(rows || []);
  for (const row of current) {
    if (row.key === fields.key && row.active) row.active = false;
  }
  const version = Math.max(
    0,
    ...current.filter((row) => row.key === fields.key).map((row) => Number(row.version) || 0),
  ) + 1;
  const saved = {
    key: fields.key,
    version,
    label_en: labelEn,
    label_es: fields.labelEs,
    blurb_en: fields.blurbEn || null,
    blurb_es: fields.blurbEs || null,
    icon: fields.icon || null,
    // Mirrors the safe-recognition constraint: a form template never carries points.
    points: 0,
    active: fields.active,
    sort: fields.sort,
    field_schema: structuredClone(fields.fieldSchema),
    created_at: timestamp,
    updated_at: timestamp,
  };
  return {
    rows: [...current, saved],
    result: { key: fields.key, version, active: fields.active },
  };
}

export function setDemoFormTemplateActive(rows, key, active) {
  const versions = (rows || []).filter((row) => row.key === key);
  if (!versions.length) throw new Error("template not found");
  const latestVersion = Math.max(...versions.map((row) => Number(row.version) || 0));
  const current = cloneDemoFormTemplates(rows);
  for (const row of current) {
    if (row.key === key && Number(row.version) === latestVersion) row.active = active;
  }
  return {
    rows: current,
    result: { key, active },
  };
}
