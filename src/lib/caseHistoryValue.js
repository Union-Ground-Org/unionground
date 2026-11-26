// Case history stores app-authored steps ("Step 2", "Intake"), timestamps,
// closed vocabularies, and structured assessment values beside staff-authored
// prose. Render the structured ones as localized copy. Leave prose verbatim.
// Steps are named by the one shared rule in caseStepName.js.

import { formatCaseworkOutcome } from "./caseworkApi.js";
import { localeFor } from "./i18n/format.js";
import { formatEasternTimestamp } from "./easternTimestamp.js";
import { catalogue } from "./i18n.js";
import { caseStepLabel } from "./caseStepName.js";

export { caseStepLabel };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DEPTH = 3;
const FACTOR_ORDER = Object.freeze(["facts", "documentation", "timeliness", "contract_support", "witnesses"]);
const ENUM_FIELDS = new Set(["status", "kind", "band", "severity", "recurrence", "target_kind"]);

function catalogueValue(key, t) {
  return Object.hasOwn(catalogue.en, key) ? t(key) : "";
}

function joinReadable(parts, lang) {
  const items = parts.filter((part) => part != null && part !== "");
  if (items.length === 0) return "";
  return new Intl.ListFormat(localeFor(lang), { style: "long", type: "conjunction" }).format(items);
}

function formatDateOnly(value, lang) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(localeFor(lang), { dateStyle: "medium" }).format(date);
}

function isTimestampKey(key) {
  return key === "deadline" || key.endsWith("_at");
}

function isPlainObject(item) {
  return item !== null && typeof item === "object" && !Array.isArray(item);
}

function orderedKeys(item, preferred) {
  const preferredSet = new Set(preferred);
  return [
    ...preferred.filter((key) => Object.hasOwn(item, key)),
    ...Object.keys(item).filter((key) => !preferredSet.has(key)),
  ];
}

function fieldLabel(key, t) {
  const known = `caseHistory.field.${key}`;
  if (Object.hasOwn(catalogue.en, known)) return t(known);
  return t("caseHistory.field.other", { field: String(key).replaceAll("_", " ") });
}

function formatPair(label, value, t) {
  return t("caseHistory.value.pair", { label, value });
}

function formatInputs(item, context) {
  const parts = orderedKeys(item, FACTOR_ORDER).map((key) => {
    const named = catalogueValue(`caseHistory.value.factor.${key}`, context.t);
    const label = named || fieldLabel(key, context.t);
    return formatPair(label, formatHistoryValue(item[key], { ...context, key, depth: context.depth + 1 }), context.t);
  });
  return joinReadable(parts, context.lang) || context.t("caseHistory.none");
}

function formatList(item, context) {
  const parts = item.map((entry) => {
    if (context.key === "recommendations" && typeof entry === "string") {
      return catalogueValue(`caseHistory.value.recommendation.${entry}`, context.t) || entry;
    }
    return formatHistoryValue(entry, { ...context, depth: context.depth + 1 });
  });
  return joinReadable(parts, context.lang) || context.t("caseHistory.none");
}

function formatObject(item, context) {
  if (context.depth >= MAX_DEPTH) return context.t("caseHistory.structured");
  if (context.key === "inputs") return formatInputs(item, context);
  const parts = Object.keys(item).map((key) => formatPair(
    fieldLabel(key, context.t),
    formatHistoryValue(item[key], { ...context, key, depth: context.depth + 1 }),
    context.t,
  ));
  return joinReadable(parts, context.lang) || context.t("caseHistory.none");
}

export function formatHistoryValue(item, context) {
  const { key = "", t, lang } = context;
  const depth = context.depth ?? 0;
  if (item == null || item === "") return key === "outcome" ? "" : t("caseHistory.unset");
  if (key === "step" || key === "from_step" || key === "to_step") return String(caseStepLabel(item, t));
  if (key === "deadline" && typeof item === "string" && DATE_ONLY.test(item)) {
    return formatDateOnly(item, lang) || String(item);
  }
  if (isTimestampKey(key) && (typeof item === "string" || item instanceof Date)) {
    const formatted = formatEasternTimestamp(item, lang)?.text;
    if (formatted) return formatted;
  }
  if (typeof item === "boolean") return t(item ? "caseHistory.yes" : "caseHistory.no");
  if (typeof item === "number") return Number.isFinite(item) ? new Intl.NumberFormat(localeFor(lang)).format(item) : t("caseHistory.unset");
  if (Array.isArray(item)) return depth >= MAX_DEPTH ? t("caseHistory.structured") : formatList(item, { ...context, depth });
  if (isPlainObject(item)) return formatObject(item, { ...context, depth });
  if (key === "outcome") return formatCaseworkOutcome(item, t);
  if (ENUM_FIELDS.has(key)) {
    const named = catalogueValue(`caseHistory.value.${key}.${String(item)}`, t);
    if (named) return named;
  }
  return String(item);
}
