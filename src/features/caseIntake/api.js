// Case intake and case details (REQ-UG-STEWARD-CASEWORK-GAPS-20261030).
//
// public.open_member_case files a member's own case with its details, or a
// case a steward, coordinator or admin opens for a member in their scope (a
// steward opener becomes the case steward). claim_member_case lets a steward
// take an unassigned case; list_unassigned_chapter_cases lists those.
//
// Merged migrations are applied to the database after the web deploy, so
// every read and write here tolerates the routines and columns not existing
// yet: the member's intake falls back to create_member_case without the new
// details, and the steward panels report themselves unavailable.

import { MemberApiError } from "../../lib/memberApiError.js";

const MISSING_ROUTINE = new Set(["PGRST202", "42883"]);
const MISSING_COLUMN = new Set(["42703", "PGRST204"]);

export function routineMissing(error) {
  return MISSING_ROUTINE.has(error?.code);
}

function text(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function date(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : null;
}

export function caseIntakeArguments(fields = {}) {
  return {
    p_member_id: fields.memberId || null,
    p_title: String(fields.title ?? "").trim(),
    p_case_type: fields.caseType,
    p_articles: String(fields.articles ?? "").trim(),
    p_deadline: date(fields.deadline),
    p_description: text(fields.description),
    p_incident_date: date(fields.incidentDate),
    p_remedy_sought: text(fields.remedySought),
    p_filing_status: ["informal", "filed"].includes(fields.filingStatus) ? fields.filingStatus : null,
    p_assign_self: fields.assignSelf !== false,
  };
}

export async function openMemberCase(client, fields) {
  const args = caseIntakeArguments(fields);
  const { data, error } = await client.rpc("open_member_case", args);
  if (!error) return data;
  // Sent once (#8960, BUG-UG-WRITE-RESENT-WITH-FEWER-ARGUMENTS-AFTER-A-MISSING-FUNCTION-20261116): a refusal, a missing
  // function included, is the answer. The old fallback to create_member_case
  // ran through the shared client as whoever was signed in by then and filed
  // this intake as that member's case. open_member_case is on every database
  // since 20261030204500.
  throw new MemberApiError(args.p_member_id ? "Open case" : "Create case", error);
}

export async function claimMemberCase(client, caseId) {
  const { data, error } = await client.rpc("claim_member_case", { p_case_id: caseId });
  if (error) throw new MemberApiError("Take case", error);
  return data;
}

// { state: "ready", rows } | { state: "unavailable" } (routine not deployed).
export async function listUnassignedChapterCases(client) {
  const { data, error } = await client.rpc("list_unassigned_chapter_cases");
  if (error) {
    if (routineMissing(error)) return { state: "unavailable", rows: [] };
    throw new MemberApiError("Cases waiting for a steward", error);
  }
  return { state: "ready", rows: Array.isArray(data) ? data : [] };
}

export async function searchCaseMembers(client, query) {
  const { data, error } = await client.rpc("list_case_member_candidates", { p_query: String(query ?? "").trim() });
  if (error) throw new MemberApiError("Member search", error);
  return Array.isArray(data) ? data : [];
}

// The case details are a separate read so a database without the new columns
// cannot break the case list that already loads; null means "not available".
export async function loadMemberCaseDetails(client, caseId) {
  const { data, error } = await client.from("member_cases")
    .select("id,description,incident_date,remedy_sought,filing_status")
    .eq("id", caseId)
    .maybeSingle();
  if (error) {
    if (MISSING_COLUMN.has(error.code) || /column .* does not exist/i.test(error.message || "")) return null;
    throw new MemberApiError("Case details", error);
  }
  if (!data) return null;
  return {
    description: data.description ?? null,
    incidentDate: data.incident_date ?? null,
    remedySought: data.remedy_sought ?? null,
    filingStatus: data.filing_status ?? null,
  };
}
