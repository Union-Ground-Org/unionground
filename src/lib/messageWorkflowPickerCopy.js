// BUG-UG-MESSAGES-LAYOUT-PICKER-DESIGN-DOC-WORDING-20261106: the
// Messages layout picker read like a design document ("Tradeoff:", "the
// clearest all-purpose mental model."). The replacement wording lives here,
// English and Spanish together, outside the locale barrels: any edit to
// src/lib/i18n.js or src/lib/i18n/es.js reads as a published legal change to
// the release guard. The old keys stay in the barrels, unread, until a release
// can remove them; every other picker line still comes from the barrels.
export const messageWorkflowPickerCopy = Object.freeze({
  en: Object.freeze({
    conLabel: "Keep in mind:",
    pro: Object.freeze({ "people-spaces-work": "everyday messages, grouped by who and where." }),
  }),
  es: Object.freeze({
    conLabel: "Ten en cuenta:",
    pro: Object.freeze({ "people-spaces-work": "los mensajes de cada día, agrupados por persona y lugar." }),
  }),
});

export function messageWorkflowPickerCopyFor(language) {
  return messageWorkflowPickerCopy[language === "es" ? "es" : "en"];
}
