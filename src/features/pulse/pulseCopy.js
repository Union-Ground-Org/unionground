// The website Pulse's words, read from the shared catalogue (src/lib/i18n.js
// and src/lib/i18n/es.js, keys pulse.*). Server explanations arrive in
// English; Spanish readers get the measure's own catalogue line.
const HATS = ["member", "steward", "coordinator", "advisor", "vp", "president", "secretary", "admin", "treasurer"];
const MEASURES = ["my_actions", "published_actions", "meeting_turnout", "visible_cases"];
const KEYS = [
  "title", "sub", "preview", "filters", "period", "level", "unit", "allUnits", "categoriesLabel", "personNote", "latest",
  "loading", "cardLoading", "unavailable", "pageUnavailable", "retry", "locked", "empty", "open", "close", "detail",
  "tableView", "chartView", "download", "downloaded", "downloadError", "noDownload", "labelHeader", "valueHeader",
  "yourCharts", "yourChartsSub", "noCharts", "build", "edit", "remove", "undo", "undone", "removeError", "undoError",
  "pinned", "chartUnavailable", "builder", "builderSub", "chartTitle", "measure", "breakdown", "caseType",
  "anyCaseType", "form", "scope", "pin", "save", "saving", "saved", "saveError", "titleRequired", "cancel",
  "livePreview", "studioLink", "studioLinkSub",
];
const GROUPS = {
  hats: HATS,
  periods: ["3m", "6m", "12m"],
  levels: ["chapter", "local"],
  categories: ["all", "participation", "meetings", "casework"],
  measures: MEASURES,
  countedFrom: MEASURES,
  forms: ["bars", "line", "stack", "meter", "table"],
  breakdowns: ["month", "meeting", "unit"],
  scopes: ["personal", "chapter", "organization"],
};

export function pulseCopy(t) {
  const copy = Object.fromEntries(KEYS.map((key) => [key, t(`pulse.${key}`)]));
  for (const [group, ids] of Object.entries(GROUPS)) {
    copy[group] = Object.fromEntries(ids.map((id) => [id, t(`pulse.${group}.${id}`)]));
  }
  copy.updated = (time) => t("pulse.updated", { time });
  copy.floor = (floor) => t("pulse.floor", { floor });
  copy.withheld = (floor) => t("pulse.withheld", { floor });
  copy.removed = (title) => t("pulse.removed", { title });
  copy.chartLabel = (form, title, count, latest) => (latest
    ? t("pulse.chartLabelLatest", { form, title, count, latest })
    : t("pulse.chartLabel", { form, title, count }));
  return copy;
}

export function pulseCountedFrom(copy, lang, measure, serverText) {
  return lang === "es" ? copy.countedFrom[measure] || serverText : serverText || copy.countedFrom[measure] || "";
}
