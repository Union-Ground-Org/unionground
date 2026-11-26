import { buildXlsxWorkbook, XLSX_MIME } from "../../lib/xlsxWorkbook.js";

// REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001: CSV and XLSX survey
// exports for real organizations, built in the browser from
// export_organization_survey_window(). The server already refused any window
// below the privacy floor; these helpers only shape the rows it returned. A
// question answered by fewer people than the floor comes back withheld, with
// its answers left out of every response row
// (REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104).

function answerText(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(answerText).filter(Boolean).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// A cell a spreadsheet would read as a formula gets an apostrophe in CSV. XLSX
// stores every text cell as an inline string, which is never evaluated.
function csvCell(value) {
  const text = answerText(value).replace(/\r\n?/g, "\n");
  const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function surveyExportTables(payload, t) {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const responses = Array.isArray(payload?.responses) ? payload.responses : [];
  const summary = [
    [t("engagement.export.survey"), payload?.title ?? ""],
    [t("engagement.export.from"), payload?.from ?? ""],
    [t("engagement.export.to"), payload?.to ?? ""],
    [t("engagement.export.responses"), Number(payload?.responseCount ?? responses.length)],
    [t("engagement.export.privacyFloor"), Number(payload?.privacyMinResponses ?? 0)],
    [t("engagement.export.generated"), payload?.generatedAt ?? ""],
    [],
    [t("engagement.export.question"), t("engagement.export.answered"), t("engagement.export.answer"), t("engagement.export.count")],
  ];
  for (const question of questions) {
    const distribution = Array.isArray(question.distribution) ? question.distribution : [];
    if (question.withheld) {
      summary.push([question.label, t("engagement.questionWithheld", { minimum: Number(payload?.privacyMinResponses ?? 0) }), "", ""]);
      continue;
    }
    if (!distribution.length) summary.push([question.label, Number(question.answered ?? 0), "", ""]);
    distribution.forEach((bucket, index) => summary.push([
      index === 0 ? question.label : "",
      index === 0 ? Number(question.answered ?? 0) : "",
      answerText(bucket.value),
      Number(bucket.count ?? 0),
    ]));
  }
  const header = [t("engagement.export.response"), t("engagement.export.submitted"), ...questions.map((question) => question.label)];
  const rows = responses.map((response) => [
    response.responseId, response.submittedAt,
    ...questions.map((question) => answerText(response.answers?.[question.id])),
  ]);
  return { summary, responses: [header, ...rows] };
}

export function surveyExportCsv(payload, t) {
  return surveyExportTables(payload, t).responses.map((row) => row.map(csvCell).join(",")).join("\n");
}

export function surveyExportXlsx(payload, t) {
  const { summary, responses } = surveyExportTables(payload, t);
  return buildXlsxWorkbook([
    { name: t("engagement.export.summarySheet"), rows: summary },
    { name: t("engagement.export.responsesSheet"), rows: responses },
  ]);
}

export function surveyExportFileName(title, format) {
  const base = String(title || "survey").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "survey";
  return `${base}_results.${format === "xlsx" ? "xlsx" : "csv"}`;
}

export function downloadSurveyExport(payload, format, t) {
  const xlsx = format === "xlsx";
  const body = xlsx ? surveyExportXlsx(payload, t) : surveyExportCsv(payload, t);
  const href = URL.createObjectURL(new Blob([body], { type: xlsx ? XLSX_MIME : "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = surveyExportFileName(payload?.title, format);
  anchor.click();
  URL.revokeObjectURL(href);
}
