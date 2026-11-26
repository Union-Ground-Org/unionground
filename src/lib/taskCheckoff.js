import { MemberApiError } from "./memberApiError.js";

// Member check-off lists on Standard Tasks (REQ-UG-COOP-CHECKOFF-LISTS-20261001).
//
// Restores the old lib/tasks/coop-tasks.ts helpers that the UI needs. The
// distribution and the check-off rules themselves run in the database
// (public.create_task_checkoff_list / public.set_task_checkoff_entry); this
// module only reads progress and explains a refusal.

export const CHECKOFF_MODES = Object.freeze(["manual", "split_even", "split_random", "shared"]);
const CHECKOFF_STATUSES = Object.freeze(["pending", "done", "unreachable", "follow_up"]);
export const CHECKOFF_FILTERS = Object.freeze(["all", ...CHECKOFF_STATUSES]);

const DENIALS = Object.freeze([
  "stale",
  "list_closed",
  "reset_requires_manager",
  "assigned_to_other",
  "already_actioned",
  "follow_up_owned_by_other",
  "manager_required",
  "assignment_scope",
]);

/** Map a database refusal ("checkoff:<reason>") to a stable reason key. */
export function checkoffDenialReason(error) {
  const match = /checkoff:([a-z_]+)/.exec(String(error?.message || ""));
  if (match && DENIALS.includes(match[1])) return match[1];
  if (/turned off/.test(String(error?.message || ""))) return "disabled";
  return "failed";
}

/**
 * The old evaluateCheckoff(), used only to decide which buttons a row shows;
 * public.set_task_checkoff_entry enforces the same rules.
 */
export function evaluateCheckoff({ actorId, isManager, listStatus, entry, nextStatus }) {
  if (listStatus === "closed" && !isManager) return { allowed: false, reason: "list_closed" };
  if (nextStatus === "pending" && !isManager) return { allowed: false, reason: "reset_requires_manager" };
  if (isManager) return { allowed: true };
  if (entry?.assignedStewardId && entry.assignedStewardId !== actorId) return { allowed: false, reason: "assigned_to_other" };
  if (entry?.status === "done" || entry?.status === "unreachable") return { allowed: false, reason: "already_actioned" };
  if (entry?.status === "follow_up" && entry.actionedBy !== actorId) return { allowed: false, reason: "follow_up_owned_by_other" };
  return { allowed: true };
}

/**
 * Overall and per-steward completion, as the old progress view rolled it up:
 * a row credits its assigned steward, otherwise (shared lists) whoever
 * actioned it; untouched shared rows sit in the unassigned bucket.
 */
export function checkoffProgress(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const empty = (stewardId, name) => ({ stewardId, name, total: 0, pending: 0, done: 0, unreachable: 0, followUp: 0, completed: 0 });
  const tally = (bucket, status) => {
    bucket.total += 1;
    if (status === "done") bucket.done += 1;
    else if (status === "unreachable") bucket.unreachable += 1;
    else if (status === "follow_up") bucket.followUp += 1;
    else bucket.pending += 1;
    if (status === "done" || status === "unreachable") bucket.completed += 1;
  };
  const overall = empty(null, "");
  const buckets = new Map();
  for (const row of rows) {
    tally(overall, row?.status);
    const stewardId = row?.assignedStewardId || (row?.status !== "pending" ? row?.actionedBy : null) || null;
    const name = row?.assignedStewardId ? row?.assignedStewardName : row?.status !== "pending" ? row?.actionedByName : "";
    const key = stewardId || "";
    if (!buckets.has(key)) buckets.set(key, empty(stewardId, name || ""));
    tally(buckets.get(key), row?.status);
  }
  const perSteward = [...buckets.values()].sort((left, right) => {
    if (!left.stewardId) return 1;
    if (!right.stewardId) return -1;
    return String(left.name).localeCompare(String(right.name));
  });
  return { ...overall, perSteward };
}

export function filterCheckoffEntries(entries, filter) {
  const rows = Array.isArray(entries) ? entries : [];
  return filter && filter !== "all" ? rows.filter((row) => row?.status === filter) : rows;
}

// Keeps the server code (MemberApiError) and adds the stable refusal reason.
function unwrap({ data, error }, label) {
  if (!error) return data;
  const failure = new MemberApiError(label, error);
  failure.reason = checkoffDenialReason(error);
  throw failure;
}

export async function loadTaskCheckoff(client, taskId) {
  return unwrap(await client.rpc("get_task_checkoff_list", { p_task_id: taskId }), "Member check-off list");
}

export async function loadTaskCheckoffCandidates(client, taskId) {
  return unwrap(await client.rpc("list_task_checkoff_candidates", { p_task_id: taskId }), "Member check-off roster");
}

export async function createTaskCheckoff(client, { taskId, mode, memberIds, stewardIds = [], manual = {} }) {
  if (!CHECKOFF_MODES.includes(mode)) {
    const failure = new Error("invalid mode");
    failure.reason = "failed";
    throw failure;
  }
  return unwrap(await client.rpc("create_task_checkoff_list", {
    p_task_id: taskId,
    p_mode: mode,
    p_member_ids: memberIds,
    p_steward_ids: mode === "split_even" || mode === "split_random" ? stewardIds : [],
    p_manual: mode === "manual" ? manual : {},
  }), "Create member check-off list");
}

export async function setTaskCheckoffEntry(client, { entryId, status, note = "", expectedStatus }) {
  return unwrap(await client.rpc("set_task_checkoff_entry", {
    p_entry_id: entryId,
    p_status: status,
    p_note: String(note || "").trim().slice(0, 500),
    p_expected_status: expectedStatus,
  }), "Member check-off");
}

export async function setTaskCheckoffListStatus(client, taskId, status) {
  return unwrap(await client.rpc("set_task_checkoff_list_status", { p_task_id: taskId, p_status: status }), "Member check-off list status");
}
