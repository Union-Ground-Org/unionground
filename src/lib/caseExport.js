import "./i18n/features/csvExportsStrings.js";
import { caseStepLabel } from "./caseHistoryValue.js";

// Client-side CSV export for the casework lists (lane 5.6). The rows are
// already in the browser — the export is the visible/filtered slice exactly as
// rendered, so no new server read and no new authorization surface is created.

// Same escape the analytics export uses: RFC 4180 quoting plus the leading
// formula guard, because a case title starting with "=" is a spreadsheet
// injection the moment somebody opens the file.
export function csvEscape(value) {
  const raw = value == null ? "" : String(value);
  const text = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll("\"", "\"\"")}"`;
  return text;
}

// SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917. The desk cap, shared
// with public.casework_record_case_export, which refuses the same numbers. A
// visible-slice export is bounded here because the desk loader's window is not:
// 500 rows is several screens of caseload and far more than any single review a
// coordinator performs by hand, so an ordinary export is untouched while "take
// the whole caseload" becomes a refusal that has to be repeated deliberately
// and is audited each time. A selection export keeps the smaller
// caseSelection.js SELECTION_LIMIT, which is also the only scope whose case ids
// are written into the audit row.
export const CASE_EXPORT_LIMIT = 500;

// The columns the coordinator queue and the steward caseload actually render:
// reference and title in the row body, member, due and status in the row's
// meta strip. Deadlines export as the stored ISO date, not the localized
// label, so the file sorts and re-imports. Union Ground issues carry no
// grievance step (owner decision, 2026-10-13), so none is exported.
export const CASE_EXPORT_COLUMNS = Object.freeze([
  { key: "reference", labelKey: "caseBulk.colReference" },
  { key: "memberName", labelKey: "caseBulk.colMember" },
  { key: "title", labelKey: "caseBulk.colTitle" },
  { key: "deadline", labelKey: "gq.colDue" },
  { key: "status", labelKey: "coordinator.factStatus" },
]);

// Every exported key is a field the desk already painted for this actor on the
// card the row came from: reference and title in the row body, member, due
// and status in the meta strip (src/components/CaseList.jsx). The export
// reads nothing the actor was not already shown, so it cannot widen disclosure;
// tests/case-bulk-selection.test.jsx pins the key set against that list.
export const CASE_RENDERED_ROW_FIELDS = Object.freeze([
  "reference", "memberName", "title", "deadline", "status",
]);

export function serializeCaseCsv(rows, columns, t) {
  const header = columns.map((column) => csvEscape(t(column.labelKey))).join(",");
  const lines = [header];
  for (const row of rows || []) {
    lines.push(columns.map((column) => {
      const value = row?.[column.key] ?? "";
      if (column.key === "step") return csvEscape(caseStepLabel(value, t));
      if (column.key === "status" && ["active", "resolved"].includes(value)) return csvEscape(t(`csvExports.${value}`));
      return csvEscape(value);
    }).join(","));
  }
  // Trailing newline: a file whose last record has no terminator makes some
  // importers drop or merge it.
  return `${lines.join("\r\n")}\r\n`;
}

// Local calendar date, not UTC: a coordinator exporting at 9pm ET wants the
// day they are living in on the filename.
export function caseExportFilename(prefix, now = new Date()) {
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  return `${prefix}-${date}.csv`;
}

// Returns the filename so the caller can announce it. A browserless caller
// (tests, SSR) gets the payload back without touching the DOM.
export function downloadCaseCsv(rows, columns, t, { prefix = "cases", now = new Date(), doc = null } = {}) {
  const body = serializeCaseCsv(rows, columns, t);
  const filename = caseExportFilename(prefix, now);
  const target = doc || (typeof document === "undefined" ? null : document);
  if (!target || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return { filename, body, downloaded: false };
  }
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = target.createElement("a");
  link.href = url;
  link.download = filename;
  target.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking on the next tick keeps Safari from cancelling the download it
  // has only just been handed.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { filename, body, downloaded: true };
}
