import { MemberApiError } from "./memberApi.js";
import { accessScope } from "./chapterAccessScope.js";
import { buildXlsxWorkbook, XLSX_MIME } from "./xlsxWorkbook.js";

function unwrap(result, operation) {
  if (result?.error) throw new MemberApiError(operation, {
    ...result.error,
    message: result.error.message || "request failed",
  });
  return result?.data;
}

export async function loadInstitutionalRecordsWorkspace(client) {
  return unwrap(await client.rpc("get_institutional_records_workspace"), "Load institutional records");
}

// The chapter's meetings a minutes record can be attached to, read from the
// events desk RPC (staff of the chapter only). Anything but a list is treated
// as unreadable, so the panel offers no meeting control rather than crashing.
export async function loadMeetingsForMinutes(client) {
  const meetings = unwrap(await client.rpc("get_admin_events"), "Load meetings");
  return Array.isArray(meetings) ? meetings : null;
}

export async function attachMinutesToMeeting(client, recordId, eventId) {
  return unwrap(await client.rpc("attach_minutes_to_meeting", {
    p_record_id: recordId,
    p_event_id: eventId || null,
  }), "Attach minutes to meeting");
}

// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: a minutes
// record's approval of the version the approver was shown. Its location is
// saved with the record itself (saveInstitutionalRecord below).

export async function setChapterMinutesApproval(client, recordId, expectedVersion, approved) {
  return unwrap(await client.rpc("set_chapter_minutes_approval", {
    p_record_id: recordId,
    p_expected_version: expectedVersion,
    p_approved: Boolean(approved),
  }), "Save minutes approval");
}

// The chapter members checked in to the meeting a minutes record is attached to.
export async function loadMinutesMeetingCheckins(client, recordId) {
  const result = unwrap(await client.rpc("get_minutes_meeting_checkins", { p_record_id: recordId }), "Load meeting check-ins");
  return Array.isArray(result?.checkedIn) ? result.checkedIn : [];
}

function recordArgs(fields) {
  return {
    p_record_id: fields.recordId || null,
    p_title: fields.title.trim(),
    p_body: fields.body.trim(),
    p_occurred_at: fields.occurredAt,
    p_visibility: fields.visibility || "chapter",
    p_action: fields.action || "save",
    p_pinned: Boolean(fields.pinned),
    p_gap_note: fields.gapNote?.trim() || null,
    p_expected_version: fields.expectedVersion || null,
    p_attendance: fields.attendance || [],
  };
}

export async function saveInstitutionalRecord(client, fields) {
  const scoped = Object.hasOwn(fields, "accessScope") || Boolean(fields.expectedChapter);
  const scope = accessScope(fields.accessScope);
  const payload = {
    ...recordArgs(fields),
    p_record_type: fields.recordType,
    ...(scoped ? { p_access_unit_id: scope.unitId || null, p_access_committee_id: scope.committeeId || null,
      p_expected_chapter: fields.expectedChapter || null, p_expected_organization: fields.expectedOrganization || null } : {}),
  };
  return unwrap(await (scoped
    ? client.rpc("save_scoped_institutional_record", payload)
    : client.rpc("save_institutional_record", payload)), "Save institutional record");
}

// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: minutes and
// their location in one version-checked transaction, so a refused save
// (a newer version, a validation failure) writes no location either.
export async function saveChapterMinutes(client, fields) {
  return unwrap(await client.rpc("save_chapter_minutes", {
    ...recordArgs(fields),
    p_location: String(fields.location ?? "").trim() || null,
  }), "Save minutes");
}

// REQ-UG-MINUTES-PRE-EVENT-DISPATCH-20261001: the chapter's pre-meeting
// minutes notices, its upcoming meetings and the organization switch.
export async function loadMinutesPreEventNotices(client) {
  return unwrap(await client.rpc("get_minutes_pre_event_notices"), "Load pre-meeting notices");
}

export async function saveMinutesPreEventNotice(client, fields) {
  const hours = fields.hoursBefore === "" || fields.hoursBefore == null ? null : Number(fields.hoursBefore);
  if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 336)) {
    throw new Error("Pre-meeting notice must be between 1 and 336 hours before the meeting");
  }
  return unwrap(await client.rpc("save_minutes_pre_event_notice", {
    p_record_id: fields.recordId,
    p_event_id: fields.eventId,
    p_audience: fields.audience,
    p_hours_before: Number.isInteger(hours) ? hours : null,
  }), "Save pre-meeting notice");
}

export async function clearMinutesPreEventNotice(client, recordId) {
  return unwrap(await client.rpc("clear_minutes_pre_event_notice", { p_record_id: recordId }), "Remove pre-meeting notice");
}

export async function saveChapterContactLog(client, fields) {
  return unwrap(await client.rpc("save_chapter_contact_log", {
    p_contact_id: fields.contactId || null,
    p_contact_kind: fields.contactKind,
    p_channel: fields.channel,
    p_purpose: fields.purpose.trim(),
    p_summary: fields.summary.trim(),
    p_outcome: fields.outcome?.trim() || null,
    p_occurred_at: fields.occurredAt,
    p_follow_up_at: fields.followUpAt || null,
    p_subject_user_id: fields.subjectUserId || null,
    p_case_id: fields.caseId || null,
    p_task_id: fields.taskId || null,
    p_archive: Boolean(fields.archive),
  }), "Save contact log");
}

export async function requestOrganizationExport(client, fields) {
  return unwrap(await client.rpc("request_filtered_organization_export", {
    p_domains: fields.domains,
    p_format: fields.format,
    p_from: fields.from || null,
    p_to: fields.to || null,
  }), "Build organization export");
}

function csvCell(value) {
  const text = (value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/\r\n?/g, "\n");
  const spreadsheetSafe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
}

// REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001: the same flattened
// table the CSV uses, one header row then one row per exported record.
export function organizationExportTable(result) {
  const keys = [...new Set((result.rows || []).flatMap((row) => Object.keys(row.values || {})))].sort();
  return [
    ["domain", "occurredAt", ...keys],
    ...(result.rows || []).map((row) => [row.domain, row.occurredAt, ...keys.map((key) => {
      const value = row.values?.[key];
      return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
    })]),
  ];
}

export function serializeOrganizationExport(result) {
  if (result.format === "json") return JSON.stringify({
    receiptId: result.receiptId,
    generatedAt: new Date().toISOString(),
    expiresAt: result.expiresAt,
    domains: result.domains,
    rows: result.rows,
  }, null, 2);
  const keys = [...new Set((result.rows || []).flatMap((row) => Object.keys(row.values || {})))].sort();
  const header = ["domain", "occurredAt", ...keys].map(csvCell).join(",");
  const lines = (result.rows || []).map((row) => [row.domain, row.occurredAt, ...keys.map((key) => row.values?.[key])].map(csvCell).join(","));
  return [header, ...lines].join("\n");
}

export function downloadOrganizationExport(result) {
  const xlsx = result.format === "xlsx";
  const body = xlsx
    ? buildXlsxWorkbook([{ name: "Export", rows: organizationExportTable(result) }])
    : serializeOrganizationExport(result);
  const extension = xlsx ? "xlsx" : result.format === "json" ? "json" : "csv";
  const type = xlsx ? XLSX_MIME : extension === "json" ? "application/json" : "text/csv;charset=utf-8";
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `union-ground-export-${result.receiptId}.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}
