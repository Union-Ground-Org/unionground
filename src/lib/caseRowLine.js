// REQ-UG-NEUTRAL-NOTIFICATION-AND-CASE-ROWS-SERVER-COPY-20261104 (#7015):
// a case list row or search hit names the case by its reference, type and
// step, never by its topic; the topic belongs to the case record. The server
// sends the same line in English (private.case_row_line in the row's title);
// this one says the type in the reader's language.
// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
// when the chapter's leadership or the case's own steward turned the topic on
// for this reader, the server says so (topicShown) and its title is the topic.
export const CASE_TYPES = ["Discipline", "Scheduling", "Telework", "Safety", "Pay", "Other"];
const TRANSLATED_TYPES = new Set(CASE_TYPES);

export function caseTypeLabel(value, t) {
  const type = String(value ?? "").trim();
  return TRANSLATED_TYPES.has(type) ? t(`cases.type${type}`) : type;
}

export function caseRowLine({ caseType, step, title, topicShown } = {}, t) {
  const topic = topicShown === true ? String(title ?? "").trim() : "";
  if (topic) return topic;
  const type = String(caseType ?? "").trim();
  const typeLabel = caseTypeLabel(type, t) || t("cases.rowFallback");
  const stepLabel = String(step ?? "").trim();
  return stepLabel ? `${typeLabel} · ${stepLabel}` : typeLabel;
}
