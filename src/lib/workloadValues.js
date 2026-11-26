// Catalogue-free workload value checks, shared by the web app and the native
// app (which must not import the web catalogue). The database validates again.
import { WORKLOAD_CATEGORY_KEYS } from "./workloadCategories.js";

export const visibleWorkloadFields = (definition) => definition.fields.filter((f) => f.visible && !f.retired);

// An explicit no-overtime answer is a measured zero. No answer stays unknown.
// Keep unknown keys intact so validation still rejects them, even when blank.
export function canonicalWorkloadValues(definition, values) {
  const fields = visibleWorkloadFields(definition);
  const clean = Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    !fields.some((f) => f.key === key) || (value !== "" && value != null)));
  if (clean.otWorked === false && clean.otHours === undefined && fields.some((f) => f.key === "otHours")) clean.otHours = 0;
  return clean;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
// BUG-UG-NATIVE-WORKLOAD-LOG-SAVE-REFUSAL-NAMES-NO-FIELD-20261118
//: a refused save names every field that needs a change and the rule
// it broke, so the form can say what to fix beside each field. A field gets
// one problem, the first of its rules it breaks; the cross-field rules follow
// in field order. workloadValuesError below is the first of these problems.
// A Map, so a configured key such as constructor or toString never reads an
// inherited property as a limit.
const WHOLE_NUMBER_LIMITS = new Map([["ptHours", 80], ["otHours", 99]]);
function wholeNumberLimit(key) {
  if ([...WORKLOAD_CATEGORY_KEYS, "weeklyAssigned"].includes(key)) return 300;
  return WHOLE_NUMBER_LIMITS.get(key) ?? null;
}
function workloadFieldProblem(f, v, legacy) {
  const empty = v === undefined || v === null || v === "";
  if (empty) return f.required ? { rule: "required" } : null;
  const textLimit = legacy && f.key === "note" ? 4000 : 500;
  // The checks the database makes again, each exactly as before .
  const basic = f.type === "number" && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1000000) ? "number"
    : f.type === "text" && (typeof v !== "string" || [...v].length > textLimit || v.includes(String.fromCharCode(0))) ? "textLength"
      : f.type === "date" && !validDate(v) ? "date"
        : (f.type === "boolean" && typeof v !== "boolean") || (f.type === "select" && !f.options.includes(v)) ? "choice" : null;
  const whole = wholeNumberLimit(f.key);
  const wholeBroken = whole !== null && (!Number.isInteger(v) || v > whole);
  const dayBroken = f.key === "hoursWorked" && (v > 24 || !Number.isInteger(v * 4));
  const futureBroken = f.key === "workedOn" && v > new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (!basic && !wholeBroken && !dayBroken && !futureBroken) return null;
  // Name the rule that tells the member what to type.
  if (whole !== null && (wholeBroken || basic === "number")) return { rule: "wholeNumber", limit: whole };
  if (f.key === "hoursWorked" && (dayBroken || basic === "number")) return { rule: "dayHours", limit: 24 };
  if (basic === "number") return { rule: "number", limit: 1000000 };
  if (basic === "textLength") return { rule: "textLength", limit: textLimit };
  if (basic) return { rule: basic };
  return { rule: "futureDate" };
}

export function workloadValueProblems(definition, values, status, legacy = false) {
  if (!definition.statuses.includes(status) || !values || Array.isArray(values) || typeof values !== "object") return { form: "status", fields: [] };
  const fields = visibleWorkloadFields(definition);
  if (Object.keys(values).some((key) => !fields.some((f) => f.key === key))) return { form: "unknown", fields: [] };
  values = canonicalWorkloadValues(definition, values);
  const problems = [];
  for (const f of fields) {
    // Own answers only: an empty field keyed constructor, valueOf or toString
    // is empty, not the inherited Object.prototype function .
    const problem = workloadFieldProblem(f, Object.hasOwn(values, f.key) ? values[f.key] : undefined, legacy);
    if (problem) problems.push({ key: f.key, ...problem });
  }
  const add = (key, rule) => { if (!problems.some((p) => p.key === key)) problems.push({ key, rule }); };
  if (values.otWorked === true && !(values.otHours > 0)) add("otHours", "overtimeHoursNeeded");
  if (values.otWorked === false && values.otHours > 0) add("otHours", "overtimeNotMarked");
  if (values.employment === "part_time" && values.ptHours == null) add("ptHours", "partTimeHoursNeeded");
  if (values.leaveType && !values.leaveTiming) add("leaveTiming", "leaveTimingNeeded");
  if (problems.length) return { form: null, fields: problems };
  return { form: new TextEncoder().encode(JSON.stringify(values)).length > (legacy ? 24000 : 3500) ? "size" : null, fields: [] };
}

export function workloadValuesError(definition, values, status, legacy = false) {
  const { form, fields } = workloadValueProblems(definition, values, status, legacy);
  return form ?? fields[0]?.key ?? null;
}
