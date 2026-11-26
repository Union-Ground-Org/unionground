// REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: the website Pulse
// reads the same server functions as the app (#6692): pulse_chart_options,
// preview_pulse_chart and the saved-chart RPCs. The server tests every cell
// against the organization floor (never under ten) before it returns rows; this
// module only validates what came back. It never adds, subtracts or derives a
// figure, so no small-cohort number can be computed in the browser.
//
// The browser releases no aggregate group under 25 (the product's stated rule,
// Lovable audit APP-STEWARD-07; REQ-UNIONGROUND-LOVABLE-AUDIT-WEBAPP-FIXES-
// 20261103): PULSE_FLOOR is that release floor, for cards and CSV alike, even
// when an organization has lowered its own limit toward the server's minimum
// of ten (PULSE_SERVER_MINIMUM, which only checks the read's contract).
import { csvEscape } from "../../lib/caseExport.js";
import { dateTimeFormatCore } from "../../lib/i18n/format.js";

export const PULSE_FLOOR = 25;
const PULSE_SERVER_MINIMUM = 10;
const PULSE_MEASURES = Object.freeze(["my_actions", "published_actions", "meeting_turnout", "visible_cases"]);
export const PULSE_FORMS = Object.freeze(["bars", "line", "stack", "meter", "table"]);
export const PULSE_PERIODS = Object.freeze(["3m", "6m", "12m"]);
const PULSE_BREAKDOWNS = Object.freeze(["month", "meeting", "unit"]);
export const PULSE_CASE_TYPES = Object.freeze(["Discipline", "Scheduling", "Telework", "Safety", "Pay", "Other"]);
const PULSE_SCOPES = Object.freeze(["personal", "chapter", "organization"]);
const PULSE_HATS = Object.freeze(["member", "steward", "coordinator", "advisor", "vp", "president", "secretary", "admin", "treasurer"]);

// Mock E's category chips. Each measure belongs to one, and its series hue
// follows the category so a card keeps its color in every view.
export const PULSE_CATEGORIES = Object.freeze(["participation", "meetings", "casework"]);
export const PULSE_MEASURE_CATEGORY = Object.freeze({
  my_actions: "participation",
  published_actions: "participation",
  meeting_turnout: "meetings",
  visible_cases: "casework",
});
// The app's validated trio, as CSS custom properties (src/sg-tokens.css); the
// light and dark values are chosen by the workspace theme.
const PULSE_SERIES = Object.freeze(["var(--chart-series-1)", "var(--chart-series-2)", "var(--chart-series-3)"]);
export function pulseSeries(measure) {
  return PULSE_SERIES[Math.max(0, PULSE_CATEGORIES.indexOf(PULSE_MEASURE_CATEGORY[measure]))];
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function count(value) {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function pulseHat(value) {
  return PULSE_HATS.includes(value) ? value : "member";
}

// Mirrors the server's private.pulse_chart_spec field list; anything else is
// refused so a stored spec can never smuggle another selector to the server.
export function pulseChartSpec(value) {
  const row = object(value);
  if (row.version !== 1 || !PULSE_MEASURES.includes(row.measure) || !PULSE_FORMS.includes(row.form)
    || !PULSE_BREAKDOWNS.includes(row.breakdown) || !PULSE_PERIODS.includes(row.period)
    || (row.level !== undefined && row.level !== "chapter" && row.level !== "local")) {
    throw new Error("Chart specification unavailable.");
  }
  return {
    version: 1,
    measure: row.measure,
    breakdown: row.breakdown,
    period: row.period,
    form: row.form,
    ...(row.level ? { level: row.level } : {}),
    ...(text(row.unitID) ? { unitID: text(row.unitID) } : {}),
    ...(PULSE_CASE_TYPES.includes(row.caseType) ? { caseType: row.caseType } : {}),
  };
}

// The figures a server read returned, or none at all. A person's own figures
// (my_actions) are exempt from the floor exactly as on the server; every other
// measure shows rows only when the server says the whole cube cleared it, and
// a returned cell under the floor withholds the card instead of drawing it.
export function pulseChartFigures(value, spec) {
  const row = object(value);
  const person = spec?.measure === "my_actions";
  const floor = Math.max(PULSE_FLOOR, count(row.privacyFloor) ?? PULSE_FLOOR);
  const rows = Array.isArray(row.rows) ? row.rows.map(object).map((item) => ({ label: text(item.label), value: count(item.value) })) : [];
  const locked = row.locked === true;
  const unavailable = !spec || !Array.isArray(row.rows) || !text(row.countedFrom) || rows.length > 400
    || rows.some((item) => !item.label || item.value === null)
    || (!person && !locked && ((row.withheld !== true && row.withheld !== false) || (count(row.privacyFloor) ?? 0) < PULSE_SERVER_MINIMUM));
  const withheld = row.withheld === true || (!person && rows.some((item) => item.value !== null && item.value > 0 && item.value < floor));
  return {
    floor,
    person,
    locked,
    withheld: !unavailable && !locked && withheld,
    unavailable,
    countedFrom: text(row.countedFrom),
    rows: unavailable || withheld || locked ? [] : rows,
  };
}

export function pulseChartOptions(value) {
  const row = object(value);
  const measures = Array.isArray(row.measures) ? PULSE_MEASURES.filter((measure) => row.measures.includes(measure)) : [];
  if (!measures.length) throw new Error("No chart measures could be verified.");
  const levels = Array.isArray(row.levels) && row.levels.includes("local") ? ["chapter", "local"] : ["chapter"];
  const units = Array.isArray(row.units)
    ? row.units.map(object).map((unit) => ({ id: text(unit.id), name: text(unit.name), current: unit.current !== false })).filter((unit) => unit.id && unit.name)
    : [];
  return { measures, levels, units };
}

// A saved chart from list_pulse_charts or read_pulse_chart. A spec the owner
// can no longer read (a revoked role, an older version) stays listed so it can
// be removed, but carries no figures.
export function savedPulseChart(value) {
  const row = object(value);
  if (!/^[0-9a-f-]{36}$/i.test(text(row.id)) || !text(row.title) || !PULSE_SCOPES.includes(row.scope)) {
    throw new Error("Saved chart unavailable.");
  }
  let spec;
  try { spec = pulseChartSpec(row.spec); } catch { spec = null; }
  const figures = row.unavailable === true || !spec ? pulseChartFigures(null, null) : pulseChartFigures(row.figures, spec);
  return {
    id: text(row.id),
    title: text(row.title),
    scope: row.scope,
    spec,
    pinned: row.pinned === true,
    home: row.pinned === true && row.home === true,
    owned: row.owned === true,
    figures,
  };
}

export function savedPulseCharts(value) {
  if (!Array.isArray(value)) throw new Error("Saved charts could not be verified.");
  return value.flatMap((row) => {
    try { return [savedPulseChart(row)]; } catch { return []; }
  });
}

// The explorer's card for one measure under the page filters. The person's own
// sign-ups cannot be narrowed (the server refuses a unit or the local level for
// them), so those filters apply to the aggregate cards only.
export function explorerSpec(measure, filters = {}) {
  const spec = { version: 1, measure, breakdown: "month", period: PULSE_PERIODS.includes(filters.period) ? filters.period : "12m", form: "bars" };
  if (measure === "my_actions") return spec;
  if (filters.level === "local") spec.level = "local";
  if (text(filters.unitID)) spec.unitID = filters.unitID;
  return spec;
}

// The builder's spec, corrected to a combination the server accepts: a
// meeting breakdown only for turnout, a unit breakdown only for an admin, a
// case type only for cases, and nothing but months for the person's own.
export function builderSpec(draft, { hat = "member", options = null } = {}) {
  const measure = PULSE_MEASURES.includes(draft?.measure) && (!options || options.measures.includes(draft.measure)) ? draft.measure : (options?.measures[0] ?? "my_actions");
  const person = measure === "my_actions";
  let breakdown = PULSE_BREAKDOWNS.includes(draft?.breakdown) ? draft.breakdown : "month";
  if (person || (breakdown === "meeting" && measure !== "meeting_turnout") || (breakdown === "unit" && hat !== "admin")) breakdown = "month";
  const spec = {
    version: 1,
    measure,
    breakdown,
    period: PULSE_PERIODS.includes(draft?.period) ? draft.period : "12m",
    form: PULSE_FORMS.includes(draft?.form) ? draft.form : "bars",
  };
  if (!person && draft?.level === "local" && options?.levels.includes("local")) spec.level = "local";
  if (!person && hat === "admin" && text(draft?.unitID) && options?.units.some((unit) => unit.id === draft.unitID)) spec.unitID = draft.unitID;
  if (measure === "visible_cases" && PULSE_CASE_TYPES.includes(draft?.caseType)) spec.caseType = draft.caseType;
  return spec;
}

export function builderScopes(hat, measure) {
  if (measure === "my_actions") return ["personal"];
  return hat === "member" ? ["personal", "chapter"] : [...PULSE_SCOPES];
}

// The newest month a monthly card carries, as returned. Never a sum or a
// difference: the hero figure is one server row.
export function latestRow(figures) {
  return figures?.rows?.length ? figures.rows[figures.rows.length - 1] : null;
}

// CSV of exactly the rows the server cleared. A card that is withheld, locked
// or unverifiable has no download, and a returned cell under the floor (which
// pulseChartFigures already withholds) is refused again here.
export function pulseCsv(figures, { labelHeader = "Label", valueHeader = "Count" } = {}) {
  if (!figures || figures.unavailable || figures.locked || figures.withheld) return null;
  if (!figures.person && figures.rows.some((row) => row.value > 0 && row.value < Math.max(PULSE_FLOOR, figures.floor))) return null;
  return [[labelHeader, valueHeader], ...figures.rows.map((row) => [row.label, String(row.value)])]
    .map((line) => line.map(csvEscape).join(","))
    .join("\r\n") + "\r\n";
}

export function pulseCsvFilename(title, now = new Date()) {
  const slug = text(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "pulse";
  const day = Number.isFinite(now.getTime()) ? now.toISOString().slice(0, 10) : "export";
  return `pulse-${slug}-${day}.csv`;
}

export function pulseUpdated(at, lang = "en") {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) return null;
  return dateTimeFormatCore(lang, { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(at);
}

// "2026-10" reads as "Oct 2026"; any other label (a unit, a meeting) as sent.
export function pulseRowLabel(label, lang = "en") {
  const match = /^(\d{4})-(\d{2})$/.exec(label);
  if (!match) return label;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 15));
  return dateTimeFormatCore(lang, { timeZone: "UTC", month: "short", year: "numeric" }).format(date);
}
