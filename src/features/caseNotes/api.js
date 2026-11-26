// Dated case notes and the steward deadline list
// (REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030).
//
// Merged migrations are applied after the web deploy, so each call tolerates
// the routines not existing yet: callers show an "available soon" state.
import { MemberApiError } from "../../lib/memberApiError.js";
export { easternDay } from "../../lib/easternCalendar.js";

const MISSING_ROUTINE = new Set(["PGRST202", "42883"]);

export function routineMissing(error) {
  return MISSING_ROUTINE.has(error?.code);
}

export function todayIso(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function noteDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : null;
}

export async function addStewardCaseNote(client, caseId, body, occurredOn) {
  const { data, error } = await client.rpc("steward_add_case_note", {
    p_case_id: caseId,
    p_body: String(body ?? "").trim(),
    p_occurred_on: noteDate(occurredOn),
  });
  if (error) throw new MemberApiError("Add case note", error);
  return data;
}

// { state: "ready", rows, truncated } | { state: "unavailable", rows: [] }.
// The routine returns { rows, truncated }; truncated is true when more than
// the 100 rows it returns are open.
export async function listStewardCaseDeadlines(client) {
  const { data, error } = await client.rpc("list_steward_case_deadlines");
  if (error) {
    if (routineMissing(error)) return { state: "unavailable", rows: [] };
    throw new MemberApiError("Case deadlines", error);
  }
  return { state: "ready", rows: Array.isArray(data?.rows) ? data.rows : [], truncated: data?.truncated === true };
}
