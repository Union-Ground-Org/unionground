import { WORKLOAD_CATEGORY_KEYS, workloadCategoryLayout } from "./workloadCategories.js";
import { t as catalogueText } from "./i18n.js";
import { canonicalWorkloadValues, visibleWorkloadFields, workloadValueProblems, workloadValuesError } from "./workloadValues.js";

export { canonicalWorkloadValues, visibleWorkloadFields, workloadValueProblems, workloadValuesError };

export const WORKLOAD_CONFIGURATION_RESOURCE = "rpc:get_organization_workload_configuration";
export const WORKLOAD_FIELD_TYPES = ["number", "text", "date", "boolean", "select"];
export const WORKLOAD_PERIODS = ["week", "month", "quarter"];

// Stable keys are data identities. Labels, units and types belong to a version.
export function defaultWorkloadDefinition(categories = null) {
  const field = (key, type, label, extra = {}) => ({ key, type, label, kind: "field", required: false, visible: true, retired: false, unit: "", summary: "none", options: [], ...extra });
  return {
    title: "Workload log", period: "month", statuses: ["logged"],
    fields: [
      ...workloadCategoryLayout(categories).map(({ key, visible }) => field(key, "number", `workload.cat.${key}`, { kind: "category", visible, unit: "count", summary: "sum" })),
      field("weeklyAssigned", "number", "workload.weeklyAssigned"),
      field("employment", "select", "Employment", { options: ["full_time", "part_time"] }),
      field("ptHours", "number", "workload.ptHours", { unit: "hours" }),
      field("onPlan", "boolean", "workload.onPlan"),
      field("otWorked", "boolean", "workload.otWorked"),
      field("otHours", "number", "workload.otHours", { unit: "hours" }),
      field("leaveType", "select", "Leave", { options: ["sick_leave", "annual_leave", "lwop", "fmla", "admin_leave", "comp_time"] }),
      field("leaveTiming", "select", "Leave timing", { options: ["planned", "unplanned"] }),
      field("noIntake", "boolean", "workload.noIntake"),
      field("halfDay", "boolean", "workload.halfDay"),
      field("workedOn", "date", "workload.workedOn"),
      field("hoursWorked", "number", "workload.hoursWorked", { unit: "hours", summary: "sum" }),
      field("note", "text", "Note"),
    ],
  };
}

// The original fields store codes and English defaults; members read them from
// the catalogue in their language. Admin-written text shows exactly as typed.
const DEFAULT_TEXT_KEYS = {
  title: { "Workload log": "workload.config.default.title" },
  status: { logged: "workload.config.default.logged" },
  label: { employment: ["Employment", "workload.config.default.employment"], leaveType: ["Leave", "workload.leave"], leaveTiming: ["Leave timing", "workload.config.default.leaveTiming"], note: ["Note", "workload.config.default.note"] },
  unit: { count: "workload.config.unit.count", hours: "workload.config.unit.hours" },
  choice: {
    full_time: "workload.fullTime", part_time: "workload.partTime", sick_leave: "workload.leaveSick", annual_leave: "workload.leaveAnnual",
    lwop: "workload.leaveLwop", fmla: "workload.leaveFmla", admin_leave: "workload.leaveAdmin", comp_time: "workload.leaveComp",
    planned: "workload.planned", unplanned: "workload.unplanned",
  },
};
const ORIGINAL_FIELD_KEYS = new Set(defaultWorkloadDefinition().fields.map((f) => f.key));
const catalogueOr = (key, text, lang) => key ? catalogueText(lang, key) : text;
export const workloadFieldLabel = (field, lang) => field.label.startsWith("workload.") ? catalogueText(lang, field.label)
  : catalogueOr(DEFAULT_TEXT_KEYS.label[field.key]?.[0] === field.label && DEFAULT_TEXT_KEYS.label[field.key][1], field.label, lang);
export const workloadTitleText = (definition, lang) => catalogueOr(DEFAULT_TEXT_KEYS.title[definition.title], definition.title, lang);
export const workloadStatusText = (status, lang) => catalogueOr(Object.hasOwn(DEFAULT_TEXT_KEYS.status, status) && DEFAULT_TEXT_KEYS.status[status], status, lang);
export const workloadUnitText = (field, lang) => catalogueOr(ORIGINAL_FIELD_KEYS.has(field.key) && Object.hasOwn(DEFAULT_TEXT_KEYS.unit, field.unit) && DEFAULT_TEXT_KEYS.unit[field.unit], field.unit, lang);
export const workloadChoiceText = (field, option, lang) => catalogueOr(ORIGINAL_FIELD_KEYS.has(field.key) && Object.hasOwn(DEFAULT_TEXT_KEYS.choice, option) && DEFAULT_TEXT_KEYS.choice[option], option, lang);
export function workloadValueText(field, value, lang) {
  if (typeof value === "boolean") return catalogueText(lang, value ? "workload.config.yes" : "workload.config.no");
  return field.type === "select" ? workloadChoiceText(field, value, lang) : String(value);
}
export const emptyWorkloadDraft = (definition) => ({
  values: Object.fromEntries(visibleWorkloadFields(definition).filter((f) => f.type === "boolean").map((f) => [f.key, false])),
  status: definition.statuses[0],
});
export const hasOriginalWorkloadCounts = (entry) => WORKLOAD_CATEGORY_KEYS.every((key) => Number.isFinite(entry.counts?.[key]));

export const WORKLOAD_DEFINITION_LIMITS = Object.freeze({
  label: 80, statuses: 12, status: 40, fields: 32, key: 40, unit: 24, choices: 20, choice: 60,
});

const limits = WORKLOAD_DEFINITION_LIMITS;
const fieldKeyPattern = new RegExp(`^[a-z][a-zA-Z0-9_]{0,${limits.key - 1}}$`);
const safeLabel = (value, max = limits.label) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[<>\p{Cc}]/u.test(value);

export function workloadDefinitionProblem(definition) {
  if (!definition || !safeLabel(definition.title)) return { section: "definition", reason: "title", control: "title" };
  if (!WORKLOAD_PERIODS.includes(definition.period)) return { section: "definition", reason: "period", control: "period" };
  const { statuses, fields } = definition;
  if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > limits.statuses) {
    return { section: "statuses", reason: "statusCount", control: "statuses" };
  }
  if (new Set(statuses).size !== statuses.length) return { section: "statuses", reason: "statusDuplicate", control: "statuses" };
  if (statuses.some((status) => !safeLabel(status, limits.status))) return { section: "statuses", reason: "statusText", control: "statuses" };
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > limits.fields) return { section: "fields", reason: "fieldCount" };

  const originals = defaultWorkloadDefinition().fields;
  const keys = new Set();
  for (const [index, f] of fields.entries()) {
    const fieldProblem = (reason, control) => ({ section: "fields", reason, control, index });
    if (!f || !fieldKeyPattern.test(f.key) || keys.has(f.key)) return fieldProblem("fieldKey");
    if (!safeLabel(f.label)) return fieldProblem("fieldLabel", "label");
    if (!WORKLOAD_FIELD_TYPES.includes(f.type)) return fieldProblem("fieldType", "type");
    // Main's order: kind, the three flags' types, a numeric category, then
    // a required field that is hidden or retired.
    if (!["category", "field"].includes(f.kind)) return fieldProblem("fieldKind", "kind");
    // The editor writes these flags and options as true/false and a list; any
    // other shape came from stored data that no control on the card can fix.
    if ([f.required, f.visible, f.retired].some((v) => typeof v !== "boolean")) return fieldProblem("fieldData");
    if (f.kind === "category" && f.type !== "number") return fieldProblem("fieldKind", "kind");
    if (f.required && (!f.visible || f.retired)) return fieldProblem("fieldVisibility", "required");
    if (typeof f.unit !== "string" || f.unit.length > limits.unit || /[<>\p{Cc}]/u.test(f.unit)) return fieldProblem("fieldUnit", "unit");
    if (!["none", "sum", "average"].includes(f.summary) || (f.summary !== "none" && f.type !== "number")) return fieldProblem("fieldSummary", "summary");
    if (!Array.isArray(f.options)) return fieldProblem("fieldData");
    if (f.type === "select") {
      if (f.options.length < 1 || f.options.length > limits.choices) return fieldProblem("choiceCount", "options");
      if (new Set(f.options).size !== f.options.length) return fieldProblem("choiceDuplicate", "options");
      if (f.options.some((option) => !safeLabel(option, limits.choice))) return fieldProblem("choiceText", "options");
    }
    keys.add(f.key);
    const original = originals.find((item) => item.key === f.key);
    if (original && (f.type !== original.type || f.unit !== original.unit)) return fieldProblem("originalTypeOrUnit");
    if (original && f.type === "select" && f.options.some((option) => !original.options.includes(option))) return fieldProblem("originalChoices", "options");
  }
  const visible = visibleWorkloadFields(definition);
  for (const [controller, dependent] of [["employment", "ptHours"], ["otWorked", "otHours"], ["leaveType", "leaveTiming"]]) {
    if (visible.some((f) => f.key === controller && (controller !== "employment" || f.options.includes("part_time")))
      && !visible.some((f) => f.key === dependent)) {
      // Point at a control that can fix it: show or reactivate the dependent
      // field when the form has it, otherwise hide the controlling field.
      const dependentIndex = fields.findIndex((f) => f.key === dependent);
      const paired = { section: "fields", controller, dependent };
      if (dependentIndex < 0) {
        return { ...paired, reason: "pairedMissing", control: "visible", index: fields.findIndex((f) => f.key === controller) };
      }
      if (fields[dependentIndex].retired) {
        // Retired and hidden needs both boxes changed; say both.
        const reason = fields[dependentIndex].visible ? "pairedRetired" : "pairedRetiredHidden";
        return { ...paired, reason, control: "retired", index: dependentIndex };
      }
      return { ...paired, reason: "pairedVisibility", control: "visible", index: dependentIndex };
    }
  }
  return visible.length ? null : { section: "visible", reason: "needVisible" };
}

export const workloadDefinitionError = (definition) => workloadDefinitionProblem(definition)?.section ?? null;

// Once a version is applied, every view that names the eight original
// categories uses that version's names, order and visibility; null before.
export function configuredWorkloadCategories(configuration, lang) {
  if (!(configuration?.version > 0) || !Array.isArray(configuration.definition?.fields)) return null;
  return visibleWorkloadFields(configuration.definition)
    .filter((f) => f.kind === "category" && WORKLOAD_CATEGORY_KEYS.includes(f.key))
    .map((f) => ({ key: f.key, name: workloadFieldLabel(f, lang) }));
}
// Server rows keyed by category, kept, ordered and named by the configuration.
export const withConfiguredWorkloadCategories = (rows, configured) => configured
  ? configured.flatMap(({ key, name }) => rows.filter((row) => row.key === key).map((row) => ({ ...row, name })))
  : rows;

export function workloadPeriodKey(date, period) {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  if (period === "quarter") return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
  if (period === "week") { d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); }
  return d.toISOString().slice(0, 7);
}

export const workloadEntryPeriod = (entry) => workloadPeriodKey(
  entry.values?.workedOn || entry.workedOn || entry.createdAt?.slice(0, 10), entry.configurationSnapshot.definition.period,
);

// Keep incompatible versions separate: a changed unit/type/label never silently
// changes the interpretation of an earlier measurement.
export function workloadPersonalSummary(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const snapshot = entry.configurationSnapshot;
    if (!snapshot?.definition) continue;
    const period = workloadEntryPeriod(entry);
    for (const field of snapshot.definition.fields.filter((f) => f.summary !== "none" && f.type === "number")) {
      const value = entry.values?.[field.key];
      if (typeof value !== "number") continue;
      const key = `${snapshot.version}:${snapshot.unitId ?? "chapter"}:${snapshot.settingsRevision ?? "legacy"}:${period}:${field.key}`;
      const group = groups.get(key) || { key, version: snapshot.version, unitName: snapshot.unitName, period, field, sum: 0, count: 0 };
      group.sum += value; group.count += 1; groups.set(key, group);
    }
  }
  return [...groups.values()].map((g) => ({ ...g, value: g.field.summary === "average" ? g.sum / g.count : g.sum }));
}

export function configuredWorkloadCsv(entries) {
  const cell = (value) => {
    let text = String(value ?? "");
    if (/^[=+@\-\t\r]/u.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [["created_at", "receipt", "configuration_version", "status", "field_key", "field_label", "type", "unit", "value", "chapter_unit_id", "chapter_unit"]];
  for (const e of entries) {
    for (const f of e.configurationSnapshot?.definition?.fields || []) {
      if (!Object.hasOwn(e.values || {}, f.key)) continue;
      rows.push([e.createdAt, e.receipt, e.configurationSnapshot.version, e.status, f.key, f.label, f.type, f.unit, e.values[f.key], e.configurationSnapshot.unitId ?? e.unitId ?? "", e.configurationSnapshot.unitName ?? e.unitName ?? ""]);
    }
    if (e.meta && e.configurationSnapshot?.version === 0) rows.push([e.createdAt, e.receipt, 0, e.status, "legacy_metadata", "Legacy metadata", "text", "", e.meta, e.unitId ?? "", e.unitName ?? ""]);
  }
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

export function liveWorkloadConfigurationApi({ load, save, guardRef, loaderRef, setData }) {
  return {
    loadWorkloadConfiguration: async () => {
      const operation = guardRef.current.captureOperation();
      const result = await load();
      return operation.isCurrent() ? result : undefined;
    },
    saveWorkloadConfiguration: async (definition, version, organizationId) => {
      const operation = guardRef.current.captureOperation();
      const result = await save(definition, version, organizationId);
      if (!operation.isCurrent()) return undefined;
      loaderRef.current?.invalidateResources([WORKLOAD_CONFIGURATION_RESOURCE]);
      setData((current) => current ? { ...current, workload: { ...current.workload, configuration: result } } : current);
      return result;
    },
  };
}
