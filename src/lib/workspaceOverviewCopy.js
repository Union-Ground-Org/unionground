// BUG-UG-SETTINGS-MORE-SITE-MAP-WORDING-20261106: the workspace
// overview help line read like a site map ("Every tool has its own address").
// Its replacement lives here, English and Spanish together, outside the locale
// barrels: any edit to src/lib/i18n.js or src/lib/i18n/es.js reads as a
// published legal change to the release guard. The old workspace.overviewHelp
// key stays in the barrels, unread, until it can be removed in a release.
export const workspaceOverviewCopy = Object.freeze({
  en: Object.freeze({ help: "Choose a section to see its pages." }),
  es: Object.freeze({ help: "Elige una sección para ver las páginas que contiene." }),
});

export function workspaceOverviewCopyFor(language) {
  return workspaceOverviewCopy[language === "es" ? "es" : "en"];
}
