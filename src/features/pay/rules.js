// Calculation rules are contract facts, not product defaults. Every nullable
// value stays unset until an organization supplies it or a member enters it
// for this estimate. Donor placeholder rules are rejected; see provenance.js.

export const CALCULATION_RULE_FIELDS = Object.freeze([
  "nightMultiplier",
  "weekendMultiplier",
  "overtimeMultiplier",
  "standbyHourlyCents",
  "hoursPerYear",
  "checksPerYear",
]);

export const UNSET_CALCULATION_RULES = Object.freeze(Object.fromEntries(
  CALCULATION_RULE_FIELDS.map((field) => [field, null]),
));

const HOUR_BUCKETS = Object.freeze([
  "regular",
  "overtime",
  "night",
  "weekend",
  "standby",
]);

export const MAX_HOURS = 10_000;
export const MAX_RAISE_PERCENT = 100;
export const MAX_UNPAID_PERIODS = 104;
export const MAX_RATE_MULTIPLIER = 10;
export const MAX_STANDBY_HOURLY_CENTS = 100_000;
export const MAX_ANNUAL_HOURS = 8784;
export const MAX_PAYCHECKS_PER_YEAR = 366;

export function mergeCalculationRules(overrides = null) {
  if (overrides != null && typeof overrides !== "object") return null;

  const next = { ...UNSET_CALCULATION_RULES };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!CALCULATION_RULE_FIELDS.includes(key)) return null;
    if (value == null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    next[key] = value;
  }

  if ([next.nightMultiplier, next.weekendMultiplier, next.overtimeMultiplier]
    .some((value) => value != null && value > MAX_RATE_MULTIPLIER)) {
    return null;
  }
  if (next.standbyHourlyCents != null
    && (next.standbyHourlyCents > MAX_STANDBY_HOURLY_CENTS || !Number.isInteger(next.standbyHourlyCents))) {
    return null;
  }
  if (next.hoursPerYear != null
    && (!Number.isInteger(next.hoursPerYear) || next.hoursPerYear < 1 || next.hoursPerYear > MAX_ANNUAL_HOURS)) {
    return null;
  }
  if (next.checksPerYear != null
    && (!Number.isInteger(next.checksPerYear) || next.checksPerYear < 1 || next.checksPerYear > MAX_PAYCHECKS_PER_YEAR)) {
    return null;
  }
  return next;
}

export function requiredCalculationRuleFields(hours, raise) {
  const required = [];
  if (hours.overtime > 0) required.push("overtimeMultiplier");
  if (hours.night > 0) required.push("nightMultiplier");
  if (hours.weekend > 0) required.push("weekendMultiplier");
  if (hours.standby > 0) required.push("standbyHourlyCents");
  if (raise.raisePercent != null) required.push("hoursPerYear", "checksPerYear");
  return required;
}

export function missingCalculationRuleFields(rules, requiredFields) {
  return requiredFields.filter((field) => rules[field] == null);
}

export function normalizeHours(hours) {
  if (hours == null) {
    return { regular: 0, overtime: 0, night: 0, weekend: 0, standby: 0 };
  }
  if (typeof hours !== "object") return null;

  const normalized = {};
  for (const bucket of HOUR_BUCKETS) {
    const value = hours[bucket] ?? 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_HOURS) {
      return null;
    }
    normalized[bucket] = value;
  }
  return normalized;
}

export function normalizeRaise(input) {
  if (input == null) return { raisePercent: null, unpaidPayPeriods: 0 };
  const percent = input.raisePercent;
  const periods = input.unpaidPayPeriods ?? 0;
  if (percent == null) {
    if (periods !== 0) return null;
    return { raisePercent: null, unpaidPayPeriods: 0 };
  }
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > MAX_RAISE_PERCENT) {
    return null;
  }
  if (!Number.isInteger(periods) || periods < 0 || periods > MAX_UNPAID_PERIODS) return null;
  return { raisePercent: percent, unpaidPayPeriods: periods };
}

export function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

export function normalizeGrade(grade) {
  if (typeof grade !== "string") return null;
  const next = grade.trim();
  if (next.length < 1 || next.length > 32) return null;
  for (const char of next) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return null;
  }
  return next;
}

export function normalizeStepNumber(step) {
  if (typeof step === "string" && /^s\d{1,2}$/i.test(step.trim())) {
    return Number(step.trim().slice(1));
  }
  if (!Number.isInteger(step) || step < 1 || step > 99) return null;
  return step;
}
