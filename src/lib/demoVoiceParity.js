const bilingual = (en, es) => ({ en, es });


export const DEMO_SURVEY_QUESTIONS = [];
export const DEMO_SURVEY_SECTIONS = [];


const VOICE_LABELS = {
  workload: bilingual("Workload", "Carga de trabajo"),
  priorities: bilingual("Priorities", "Prioridades"),
  "follow-up": bilingual("Follow-up", "Seguimiento"),
  active: bilingual("Active", "Activa"),
  draft: bilingual("Draft", "Borrador"),
  scheduled: bilingual("Scheduled", "Programada"),
  live: bilingual("Live", "En vivo"),
  closed: bilingual("Closed", "Cerrada"),
  archived: bilingual("Archived", "Archivada"),
  quarterly: bilingual("Quarterly", "Trimestral"),
  general: bilingual("General", "General"),
  priority: bilingual("Priority", "Prioridad"),
  reserved: bilingual("Reserved", "Reservada"),
  pool: bilingual("Pool", "Banco"),
  published: bilingual("Published", "Publicada"),
  rejected: bilingual("Rejected", "Rechazada"),
  answered: bilingual("Answered", "Respondida"),
  open: bilingual("Open", "Abierta"),
  yes: bilingual("Yes", "Sí"),
  no: bilingual("No", "No"),
  maybe: bilingual("Maybe", "Quizás"),
  quarter: bilingual("This quarter", "Este trimestre"),
  year: bilingual("Rolling year", "Último año"),
  all: bilingual("All responses", "Todas las respuestas"),
};


export function voiceText(value, lang = "en") {
  if (typeof value === "string") return value;
  return value?.[lang] || value?.en || "";
}


// Identity and display stay separate: the reader's own authorship is a flag,
// never a display literal, so no English "You" can survive a lang="es"
// render and no label wording change can move the owner-gated controls.
export function viewerAuthor() {
  return { viewer: true };
}


export function voiceAuthoredByViewer(author) {
  if (author === "You") return true;
  return Boolean(author && typeof author === "object" && author.viewer === true);
}


export function voiceJoinedOptions(options, lang = "en") {
  return (Array.isArray(options) ? options : [])
    .map((option) => voiceText(option, lang))
    .join(" · ");
}


export function voiceAuthorName(author, lang = "en", viewerLabel = "You") {
  if (voiceAuthoredByViewer(author)) return viewerLabel;
  if (typeof author === "string") return author;
  return voiceText(author?.name, lang);
}


// Write the reader's edit back into a bilingual seed without flattening it:
// a bilingual value keeps its inactive language and updates the active one,
// so the edit form can pre-fill with (and save) plain resolved strings.
export function voiceEditedCopy(original, edited, lang = "en") {
  if (original && typeof original === "object") {
    if (lang !== "en" && lang !== "es") throw new RangeError("Unsupported voice language");
    return lang === "es" ? { ...original, es: edited } : { ...original, en: edited };
  }
  return edited;
}


export function voiceLabel(token, lang = "en") {
  return voiceText(VOICE_LABELS[token], lang) || token;
}


export function voiceOptionLabel(item, lang = "en") {
  return voiceText(item?.label, lang);
}
export function readDemoVoiceState(){ throw new Error('The shared demo has been retired.'); }
export function writeDemoVoiceState(_state){ throw new Error('The shared demo has been retired.'); }


export function visibleSurveyQuestions(section, answers) {
  return DEMO_SURVEY_QUESTIONS.filter((question) => {
    if (question.section !== section) return false;
    if (!question.branch) return true;
    return question.branch.values.includes(answers[question.branch.questionId]);
  });
}


export function surveySectionComplete(section, answers) {
  return visibleSurveyQuestions(section, answers).every((question) => {
    if (!question.required) return true;
    const answer = answers[question.id];
    return Array.isArray(answer)
      ? answer.length > 0
      : String(answer ?? "").trim().length > 0;
  });
}


// The sample studio teaches the product's rule: no released group under 25
// (Lovable audit APP-STEWARD-07), so the minimum group size never goes below it.
export const VOICE_PRIVACY_FLOOR = 25;

export function clampPrivacyThreshold(value) {
  const number = Number(value);
  return Math.min(
    50,
    Math.max(VOICE_PRIVACY_FLOOR, Number.isFinite(number) && number > 0 ? number : VOICE_PRIVACY_FLOOR),
  );
}


function reportSnapshot(survey, range = "quarter") {
  const responses = survey.rangeResponses?.[range] ?? survey.responses;
  const completionRate =
    survey.audience > 0 ? Math.round((responses / survey.audience) * 100) : 0;
  return { responses, audience: survey.audience, completionRate, range };
}


export function resultReadiness(survey, range = "quarter") {
  const snapshot = reportSnapshot(survey, range);
  const threshold = clampPrivacyThreshold(survey.threshold);
  const smallestGroup = snapshot.responses >= 27 ? 27 : snapshot.responses;
  return {
    ...snapshot,
    threshold,
    smallestGroup,
    ready: snapshot.responses >= threshold && smallestGroup >= threshold,
  };
}


export function prioritizeWeeklyQuestions(questions, selectedId) {
  return questions.map((question) => {
    if (question.id === selectedId) return { ...question, state: "priority" };
    return question.state === "priority"
      ? { ...question, state: "reserved" }
      : question;
  });
}


export function selectWeightedWeeklyQuestion(questions, random = Math.random) {
  const eligible = questions.filter(
    (item) => !["priority", "published", "rejected"].includes(item.state),
  );
  if (!eligible.length) return null;
  const total = eligible.reduce(
    (sum, item) => sum + Math.max(1, item.score),
    0,
  );
  let target = Math.min(0.999999, Math.max(0, random())) * total;
  for (const item of eligible) {
    target -= Math.max(1, item.score);
    if (target < 0) return item;
  }
  return eligible[eligible.length - 1];
}


export function exportVoiceReport(
  format,
  state,
  surveyId = state.surveys[0]?.id,
  range = "quarter",
) {
  const survey =
    state.surveys.find((item) => item.id === surveyId) || state.surveys[0];
  if (!survey) return "";
  // An export is a release too: a report still under the floor has none.
  if (!resultReadiness(survey, range).ready) return "";
  const snapshot = reportSnapshot(survey, range);
  const rows = [
    ["Survey", survey.title],
    ["Range", voiceLabel(range, "en")],
    ["Responses", snapshot.responses],
    ["Audience", snapshot.audience],
    ["Privacy threshold", clampPrivacyThreshold(survey.threshold)],
    ["Completion rate", `${snapshot.completionRate}%`],
  ];
  const separator = format === "xlsx" ? "\t" : ",";
  const text = rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
        .join(separator),
    )
    .join("\n");
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  )
    return text;
  const blob = new Blob([text], {
    type:
      format === "xlsx" ? "application/vnd.ms-excel" : "text/csv;charset=utf-8",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `member-voice-report.${format === "xlsx" ? "xls" : "csv"}`;
  link.click();
  URL.revokeObjectURL(link.href);
  return text;
}
