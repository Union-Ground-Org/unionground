// The platform operator's client for POST /api/intake-review
// (REQ-UG-INTAKE-QUEUE-PEOPLE-WAITING-ADMIN-PAGE-20261118). The route
// authenticates the bearer token, needs a second factor and answers
// `{ result }`. Every failure is thrown as one plain shape,
// `{ status, error, reason }`, so the page never reads a raw Response. Nothing
// here logs or stores a body.

import { csvEscape } from "../../lib/caseExport.js";

export const INTAKE_REVIEW_PATH = "/api/intake-review";
export const INTAKE_KINDS = Object.freeze(["updates", "invite", "join"]);
export const INTAKE_STATUSES = Object.freeze(["new", "contacted", "invited", "closed"]);
export const INTAKE_TOPICS = Object.freeze(["chapter_updates", "public_meetings", "union_news"]);
export const PAGE_SIZE = 25;
export const NOTE_MAX = 2000;
export const SEARCH_MAX = 120;
// Requests are dated on the Eastern day the server counts them on.
export const EASTERN = "America/New_York";

// The one vocabulary key for a server value, or null for anything the page
// does not know (so it never prints a raw server token).
export function vocabularyKey(list, value) {
  return typeof value === "string" && list.includes(value) ? value : null;
}

// Which failure the page shows. `access` kinds replace the whole page with one
// neutral sentence.
export function intakeFailureKind(error) {
  if (error?.status === 404 && error.error === "not-available") return "demo";
  if (error?.status === 401 || (error?.status === 403 && error.error === "mfa-required")) return "mfa";
  if (error?.status === 403) return "forbidden";
  if (error?.status === 409 && error.error === "refused") return "refused";
  if (error?.status === 0 || error?.status === 503) return "unavailable";
  return "generic";
}

export function isAccessFailure(kind) {
  return kind === "demo" || kind === "mfa" || kind === "forbidden";
}

export async function requestIntakeReview({ fetchImpl = globalThis.fetch, accessToken, action, payload = {} }) {
  let response;
  try {
    response = await fetchImpl(INTAKE_REVIEW_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...payload, action }),
    });
  } catch {
    throw { status: 0, error: "unavailable", reason: null };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw {
      status: response.status,
      error: typeof body?.error === "string" ? body.error : "unavailable",
      reason: typeof body?.reason === "string" ? body.reason : null,
    };
  }
  if (!body || typeof body !== "object" || !body.result || typeof body.result !== "object") {
    throw { status: response.status, error: "unavailable", reason: null };
  }
  return body.result;
}

// The filters the list and the export send: only the ones that are set.
export function intakeFilters({ kind = "", status = "", search = "" } = {}) {
  const out = {};
  if (vocabularyKey(INTAKE_KINDS, kind)) out.kind = kind;
  if (vocabularyKey(INTAKE_STATUSES, status)) out.status = status;
  const text = String(search ?? "").trim();
  if (text) out.search = text.slice(0, SEARCH_MAX);
  return out;
}

// The mail app link for Reply by email: addressed to the person, with a
// subject naming what they asked for. Null when the row has no usable address.
export function replyHref(row, subject) {
  const email = String(row?.email ?? "").trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) return null;
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}`;
}

// Totals per kind and per kind and status from the summary's counts.
export function countsByKind(counts) {
  const out = Object.fromEntries(INTAKE_KINDS.map((kind) => [kind, { total: 0, ...Object.fromEntries(INTAKE_STATUSES.map((s) => [s, 0])) }]));
  for (const row of Array.isArray(counts) ? counts : []) {
    const kind = vocabularyKey(INTAKE_KINDS, row?.kind);
    const status = vocabularyKey(INTAKE_STATUSES, row?.status);
    const n = Number.isInteger(row?.count) && row.count > 0 ? row.count : 0;
    if (!kind || !status) continue;
    out[kind][status] += n;
    out[kind].total += n;
  }
  return out;
}

// The 90-day trend as one number per day: every kind added together.
export function dailyTotals(daily) {
  return (Array.isArray(daily) ? daily : []).map((row) => ({
    day: typeof row?.day === "string" ? row.day.slice(0, 10) : "",
    updates: Number(row?.updates) || 0,
    invite: Number(row?.invite) || 0,
    join: Number(row?.join) || 0,
  })).map((row) => ({ ...row, total: row.updates + row.invite + row.join })).filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day));
}

export const EXPORT_COLUMNS = Object.freeze([
  "kind", "status", "name", "email", "topic", "organizationName", "role", "sizeBand", "state", "phone",
  "note", "operatorNote", "locale", "campaignCode", "createdAt", "lastSubmittedAt", "statusChangedAt",
]);

// The CSV the export downloads: a header row of column names, then the rows
// the server returned for the filters, each cell escaped against spreadsheet
// formula injection.
export function intakeCsv(rows) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of Array.isArray(rows) ? rows : []) {
    lines.push(EXPORT_COLUMNS.map((column) => csvEscape(row?.[column])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

// REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118 (owner
// option b): an invite request is passed to an organization's administrators,
// who decide under Requests whether to send the invitation.
export const PASS_SEARCH_MIN = 2;
export const PASS_SEARCH_LIMIT = 20;
export const PASS_STATUSES = Object.freeze(["pending", "approved", "declined"]);
export const PASS_REFUSALS = Object.freeze(["not-found", "not-invite", "stopped", "organization-unavailable", "no-administrator", "unsuitable", "changed", "privacy-not-released"]);

// The ids whose passes the page asks for: invite rows only, at most 100.
export function inviteRowIds(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.kind === "invite" && typeof row.id === "string").map((row) => row.id).slice(0, 100);
}

function passEntry(row) {
  if (!row || typeof row.submissionId !== "string" || typeof row.organizationId !== "string") return null;
  return {
    submissionId: row.submissionId,
    organizationId: row.organizationId,
    organizationName: typeof row.organizationName === "string" ? row.organizationName : "",
    chapterName: typeof row.chapterName === "string" ? row.chapterName : "",
    status: vocabularyKey(PASS_STATUSES, row.status),
    passedAt: typeof row.passedAt === "string" ? row.passedAt : null,
  };
}

// The `passes` result as { submissionId: [pass, ...] }, newest first.
export function passesBySubmission(result) {
  const out = {};
  for (const entry of (Array.isArray(result?.passes) ? result.passes : []).map(passEntry).filter(Boolean)) {
    (out[entry.submissionId] ||= []).push(entry);
  }
  for (const list of Object.values(out)) list.sort((a, b) => String(b.passedAt).localeCompare(String(a.passedAt)));
  return out;
}

// Adds or replaces one organization's pass, keeping history newest first.
export function withPass(passes, result) {
  const entry = passEntry(result);
  if (!entry) return passes;
  const others = (passes[entry.submissionId] || []).filter((item) => item.organizationId !== entry.organizationId);
  return { ...passes, [entry.submissionId]: [entry, ...others].sort((a, b) => {
    const difference = Date.parse(b.passedAt) - Date.parse(a.passedAt);
    return Number.isFinite(difference) ? difference : 0;
  }) };
}

// The organizations a search found: id and name only, at most 20.
export function passOrganizations(result) {
  return (Array.isArray(result?.organizations) ? result.organizations : [])
    .filter((row) => typeof row?.id === "string" && typeof row.name === "string")
    .slice(0, PASS_SEARCH_LIMIT)
    .map((row) => ({ id: row.id, name: row.name }));
}
