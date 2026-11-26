// BUG-UG-CLOSED-POLL-PROMISES-RESULTS-20261106: Voting never shows
// pulse results, yet an answered poll that had closed still said "chapter
// results share after close". The closed-poll line lives here, English and
// Spanish together, outside the locale barrels: any edit to src/lib/i18n.js or
// src/lib/i18n/es.js reads as a published legal change to the release guard.
// An open answered poll keeps the barrel's voting.pulseRecorded line.
export const pollRecordedCopy = Object.freeze({
  en: Object.freeze({ closed: "\"{label}\" recorded · this poll has closed." }),
  es: Object.freeze({ closed: "\"{label}\" registrado · esta encuesta ya cerró." }),
});

export function closedPollRecordedLine(language, label) {
  const copy = pollRecordedCopy[language === "es" ? "es" : "en"];
  return copy.closed.replace("{label}", String(label ?? ""));
}
