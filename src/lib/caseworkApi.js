import { sensitiveContentRpc } from "./sensitiveContentApi.js";
import { MemberApiError } from "./memberApi.js";

// Stable outcome vocabulary stored on
// public.casework_step_transitions.outcome for case-board moves; the shared
// case history still reads it. Rows written before this key hold a translated
// sentence ("Moved on the case board." / "Movido en el tablero de casos.")
// and are left as-is: the column is free text by contract, and readers pass
// unknown values through verbatim. A backfill is not proposed because a
// migration during the in-flight B1 merge chain would collide with its
// ordering, and the historical sentences remain readable as prose.
const CASEWORK_BOARD_MOVE_OUTCOME = "board_move";

const CASEWORK_OUTCOME_I18N_KEYS = Object.freeze({
  [CASEWORK_BOARD_MOVE_OUTCOME]: "caseworkOutcome.board_move",
});

export function formatCaseworkOutcome(outcome, t) {
  if (outcome == null) return "";
  const stored = String(outcome);
  // Own-property lookup only. A plain object inherits Object.prototype, so a
  // user-typed outcome of "__proto__", "constructor" or "toString" would
  // otherwise resolve to an inherited member, reach t() as a non-string and
  // make React refuse to render the step-transition row. Unknown values —
  // user-typed prose and rows written before the key vocabulary — must come
  // back verbatim, and a translation that is not a string is not usable copy.
  if (!Object.hasOwn(CASEWORK_OUTCOME_I18N_KEYS, stored)) return stored;
  const translated = t(CASEWORK_OUTCOME_I18N_KEYS[stored]);
  return typeof translated === "string" ? translated : stored;
}

function unwrap(result, label) {
  if (result?.error) throw new MemberApiError(label, {
    ...result.error,
    message: result.error.message || "request failed",
  });
  return result?.data ?? null;
}

async function actorId(client) {
  const auth = unwrap(await client.auth.getUser(), "Load actor");
  if (!auth?.user?.id) throw new Error("Authenticated actor required");
  return auth.user.id;
}

async function list(query, label) {
  const rows = unwrap(await query, label);
  return Array.isArray(rows) ? rows : [];
}

export async function loadCaseworkCase(client, caseId) {
  if (!caseId) throw new Error("Case id required");
  const scope = unwrap(await client
    .from("member_cases")
    .select("id,organization_id,chapter_id,title,is_restricted,restriction_reason,restricted_at,restricted_by,status,case_type")
    .eq("id", caseId)
    .single(), "Load casework scope");

  // Union Ground issues have no grievance procedure (owner decision,
  // 2026-10-13), so the step transitions and the step-generated checklists
  // are not read: nothing in the product writes them.
  const [strength, deadlines, alerts, management, retaliation, links, reminders, accessGrants] = await Promise.all([
    list(client.from("casework_strength_analyses").select("id,score,band,inputs,recommendations,analyzed_by,created_at").eq("case_id", caseId).order("created_at", { ascending: false }).limit(25), "Load strength history"),
    list(client.from("casework_deadlines").select("id,kind,label,due_at,status,reminder_at,reminder_sent_at,created_by,created_at,updated_at").eq("case_id", caseId).order("due_at"), "Load deadlines"),
    list(client.from("casework_alerts").select("id,kind,severity,message,status,escalation_due_at,escalated_at,resolved_at,created_at,casework_alert_acknowledgements(id,acknowledged_by,note,created_at)").eq("case_id", caseId).order("created_at", { ascending: false }), "Load alerts"),
    list(client.from("casework_management_entries").select("id,occurred_at,category,summary,created_at,casework_management_people(id,display_name,title,workplace),casework_management_addenda(id,body,created_by,created_at)").eq("case_id", caseId).order("occurred_at", { ascending: false }), "Load management behavior"),
    loadMemberRetaliationReports(client, caseId),
    list(client.from("casework_entity_links").select("id,target_kind,target_id,target_case_id,relationship,note,created_at").eq("source_case_id", caseId).order("created_at"), "Load case links"),
    list(client.from("casework_reminders").select("id,title,remind_at,recurrence,status,last_fired_at,completed_at,created_at,updated_at").eq("case_id", caseId).order("remind_at"), "Load reminders"),
    list(client.from("casework_access_grants").select("id,grantee_user_id,granted_by,granted_at,revoked_at,revoked_by").eq("case_id", caseId).order("granted_at", { ascending: false }), "Load restricted-case grants"),
  ]);

  const deadlineIds = deadlines.map((row) => row.id);
  const extensions = deadlineIds.length
    ? await list(client.from("casework_deadline_extensions").select("id,deadline_id,previous_due_at,requested_due_at,reason,status,decided_by,decided_at,decision_note,created_at").in("deadline_id", deadlineIds).order("created_at"), "Load deadline extensions")
    : [];
  const extensionsByDeadline = Object.groupBy
    ? Object.groupBy(extensions, (row) => row.deadline_id)
    : extensions.reduce((groups, row) => ({ ...groups, [row.deadline_id]: [...(groups[row.deadline_id] || []), row] }), {});

  // REQ-UG-GC-ESCALATION-FLAGS-20261001: coordinator badges. Only case
  // staff may read them; anyone else (or an older database) shows none.
  const escalation = await loadCaseworkEscalationFlags(client, caseId);
  const flagsByDeadline = new Map((escalation?.flags || []).map((flag) => [flag.deadlineId, flag]));

  return {
    scope,
    strength,
    deadlines: deadlines.map((row) => ({
      ...row,
      extensions: extensionsByDeadline[row.id] || [],
      escalation: flagsByDeadline.has(row.id) ? { reason: flagsByDeadline.get(row.id).reason, dueHours: escalation.dueHours } : null,
    })),
    alerts,
    management,
    retaliation,
    links,
    reminders,
    accessGrants,
  };
}

export async function loadCaseworkEscalationFlags(client, caseId) {
  try {
    const { data, error } = await client.rpc("casework_get_escalation_flags", { p_case_id: caseId });
    if (error || !data || data.caseId !== caseId || data.enabled !== true || !Array.isArray(data.flags)
      || !Number.isSafeInteger(data.dueHours)) return null;
    return {
      dueHours: data.dueHours,
      flags: data.flags.filter((flag) => flag && typeof flag.deadlineId === "string" && ["overdue", "critical_deadline"].includes(flag.reason)),
    };
  } catch {
    return null;
  }
}

export async function scoreCaseworkCase(client, caseId, inputs) {
  return unwrap(await client.rpc("casework_score_case", {
    p_case_id: caseId,
    p_inputs: inputs,
    p_idempotency_key: crypto.randomUUID(),
  }), "Score case");
}

export async function setCaseworkRestriction(client, caseId, restricted, reason = "") {
  return unwrap(await client.rpc("casework_set_restriction", {
    p_case_id: caseId,
    p_restricted: Boolean(restricted),
    p_reason: reason,
  }), "Set case restriction");
}

export async function grantCaseworkAccess(client, caseId, granteeUserId, reason = "") {
  return unwrap(await client.rpc("casework_grant_access", {
    p_case_id: caseId,
    p_grantee_user_id: granteeUserId,
    p_reason: reason,
  }), "Grant case access");
}

export async function revokeCaseworkAccess(client, grantId) {
  return unwrap(await client.rpc("casework_revoke_access", { p_grant_id: grantId }), "Revoke case access");
}

export async function createCaseworkDeadline(client, scope, fields) {
  // SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920:
  // the definer routine is the only creation route, so the deadline and its
  // deadline_created audit row are written in one transaction.
  return unwrap(await client.rpc("casework_create_deadline", {
    p_case_id: scope.id,
    p_kind: fields.kind,
    p_label: fields.label.trim(),
    p_due_at: fields.dueAt,
    p_reminder_at: fields.reminderAt || null,
  }), "Create deadline");
}

// REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006: the
// title and the case_renamed audit row are written in one transaction. The
// reason is a closed code (clearer_title, member_request, correct_error, other).
export async function renameCaseworkCase(client, caseId, title, reason) {
  return unwrap(await client.rpc("casework_rename_case", {
    p_case_id: caseId,
    p_title: title.trim(),
    p_reason: reason,
  }), "Rename case");
}

// Owner answer 11=A: the steward's own private reminders. Every routine returns
// the caller's full list in the selected organization and nobody else's.
export async function listStewardPrivateReminders(client) {
  return unwrap(await client.rpc("steward_list_private_reminders"), "Load private reminders");
}

export async function saveStewardPrivateReminder(client, { title, remindOn, caseId = null }) {
  return unwrap(await client.rpc("steward_save_private_reminder", {
    p_title: title.trim(),
    p_remind_on: remindOn,
    p_case_id: caseId,
  }), "Save private reminder");
}

export async function attachStewardPrivateReminder(client, reminderId, caseId) {
  return unwrap(await client.rpc("steward_attach_private_reminder", {
    p_reminder_id: reminderId,
    p_case_id: caseId,
  }), "Attach private reminder");
}

export async function deleteStewardPrivateReminder(client, reminderId) {
  return unwrap(await client.rpc("steward_delete_private_reminder", { p_reminder_id: reminderId }), "Delete private reminder");
}

export async function requestCaseworkDeadlineExtension(client, deadlineId, requestedDueAt, reason) {
  return unwrap(await client.rpc("casework_request_deadline_extension", {
    p_deadline_id: deadlineId,
    p_requested_due_at: requestedDueAt,
    p_reason: reason,
    p_idempotency_key: crypto.randomUUID(),
  }), "Request deadline extension");
}

export async function decideCaseworkDeadlineExtension(client, extensionId, decision, note = "") {
  return unwrap(await client.rpc("casework_decide_deadline_extension", {
    p_extension_id: extensionId,
    p_decision: decision,
    p_note: note || null,
  }), "Decide deadline extension");
}

export async function createCaseworkAlert(client, scope, fields) {
  // Same audited creation route as createCaseworkDeadline; the alert and its
  // alert_created audit row are written together.
  return unwrap(await client.rpc("casework_create_alert", {
    p_case_id: scope.id,
    p_kind: fields.kind,
    p_severity: fields.severity,
    p_message: fields.message.trim(),
    p_escalation_due_at: fields.escalationDueAt || null,
  }), "Create case alert");
}

export async function acknowledgeCaseworkAlert(client, alertId, note = "") {
  return unwrap(await client.rpc("casework_acknowledge_alert", {
    p_alert_id: alertId,
    p_note: note || null,
  }), "Acknowledge case alert");
}

// REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103: creation is the
// journalled RPC, so a practice reminder can be undone; the owner is the caller.
export async function createCaseworkReminder(client, scope, fields) {
  return unwrap(await client.rpc("create_my_case_reminder", {
    p_case_id: scope.id,
    p_title: fields.title.trim(),
    p_remind_at: fields.remindAt,
    p_recurrence: fields.recurrence || "none",
  }), "Create case reminder");
}

export async function logCaseworkManagementBehavior(client, caseId, fields) {
  return unwrap(await client.rpc("casework_log_management_behavior", {
    p_case_id: caseId,
    p_display_name: fields.displayName,
    p_title: fields.title || null,
    p_workplace: fields.workplace || null,
    p_occurred_at: fields.occurredAt,
    p_category: fields.category,
    p_summary: fields.summary,
  }), "Log management behavior");
}

// REQ-UG-CONFIGURABLE-THRESHOLDS-20261001: entries about each named
// manager inside the organization's management behavior window (old default 90
// days), across every case the caller's casework RLS already lets them read.
const MANAGEMENT_WINDOW_PAGE_SIZE = 1000;
const MANAGEMENT_WINDOW_ROW_LIMIT = 5000;
export async function loadCaseworkManagementWindow(client, personIds, windowDays) {
  const ids = [...new Set((personIds || []).filter((value) => typeof value === "string" && value))].slice(0, 50);
  const days = Number.isInteger(windowDays) && windowDays > 0 ? windowDays : 90;
  if (ids.length === 0) return {};
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const counts = Object.fromEntries(ids.map((personId) => [personId, 0]));
  let after = null;
  let scanned = 0;
  for (;;) {
    let query = client.from("casework_management_entries")
      .select("id,management_person_id")
      .in("management_person_id", ids)
      .gte("occurred_at", since)
      .order("id", { ascending: true })
      .limit(Math.min(MANAGEMENT_WINDOW_PAGE_SIZE, MANAGEMENT_WINDOW_ROW_LIMIT + 1 - scanned));
    if (after !== null) query = query.gt("id", after);
    const rows = await list(query, "Load management behavior window");
    // A short page can be the API's own lower row cap. Only an empty page
    // proves completion; the extra row at the bound detects truncation.
    if (!rows.length) return counts;
    scanned += rows.length;
    if (scanned > MANAGEMENT_WINDOW_ROW_LIMIT) throw new Error("Management behavior window exceeds its row limit");
    const next = rows.at(-1)?.id;
    if (typeof next !== "string" || (after !== null && next <= after)) {
      throw new Error("Management behavior window could not be read completely");
    }
    for (const row of rows) if (Object.hasOwn(counts, row.management_person_id)) counts[row.management_person_id] += 1;
    after = next;
  }
}

export async function addCaseworkManagementAddendum(client, entryId, body) {
  return unwrap(await client.rpc("casework_add_management_addendum", {
    p_entry_id: entryId,
    p_body: body,
  }), "Add management addendum");
}

export async function linkCaseworkCases(client, sourceCaseId, targetCaseId, relationship, note = "") {
  return unwrap(await client.rpc("casework_link_cases", {
    p_source_case_id: sourceCaseId,
    p_target_case_id: targetCaseId,
    p_relationship: relationship,
    p_note: note || null,
  }), "Link cases");
}

export async function setCaseworkReminderStatus(client, reminderId, action, remindAt = null) {
  return unwrap(await client.rpc("casework_set_reminder_status", {
    p_reminder_id: reminderId,
    p_action: action,
    p_remind_at: remindAt,
  }), "Update reminder");
}

export async function loadCaseworkHub(client, chapterId) {
  if (!chapterId) throw new Error("Chapter id required");
  const workspaces = await list(client.from("casework_bargaining_workspaces")
    .select("id,organization_id,chapter_id,title,status,starts_at,created_at,updated_at")
    .eq("chapter_id", chapterId).order("updated_at", { ascending: false }).limit(50), "Load bargaining workspaces");
  const workspaceIds = workspaces.map((row) => row.id);
  const [proposals, events, drafts, patterns] = await Promise.all([
    workspaceIds.length ? list(client.from("casework_bargaining_proposals").select("id,workspace_id,side,title,body,status,response_due_at,position,created_at,updated_at").in("workspace_id", workspaceIds).order("position").order("updated_at", { ascending: false }), "Load bargaining proposals") : [],
    workspaceIds.length ? list(client.from("casework_bargaining_events").select("id,workspace_id,proposal_id,event_type,body,pulse,created_at").in("workspace_id", workspaceIds).order("created_at", { ascending: false }).limit(300), "Load bargaining timeline") : [],
    list(client.from("casework_intake_drafts").select("id,chapter_id,member_user_id,case_id,payload,revision,created_at,updated_at").eq("chapter_id", chapterId).order("updated_at", { ascending: false }).limit(50), "Load intake drafts"),
    sensitiveContentRpc(client, "list_patterns", { chapterId }).then((result) => unwrap(result, "Load retaliation patterns")),
  ]);
  return {
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      proposals: proposals.filter((row) => row.workspace_id === workspace.id),
      events: events.filter((row) => row.workspace_id === workspace.id),
    })),
    drafts,
    patterns,
  };
}

// The bargaining table alone (sessions and their proposals), for
// the alternate shell's Bargaining page
// (REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030). RLS opens these
// tables to the chapter's stewards, coordinators, advisors, admins and VPs
// only, so any other reader gets no sessions, never an error.
const BARGAINING_WORKSPACE_HISTORY_LIMIT = 50;
const BARGAINING_WORKSPACE_COLUMNS = "id,organization_id,chapter_id,title,status,starts_at,created_at,updated_at";
const BARGAINING_PROPOSAL_PAGE_SIZE = 1000;
const BARGAINING_PROPOSAL_ROW_LIMIT = 5000;

function byProposalPosition(a, b) {
  return (a.position ?? 0) - (b.position ?? 0)
    || (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0)
    || String(a.id).localeCompare(String(b.id));
}

// The page shows proposals.length as an exact count, so the read pages by id
// past the API's row cap rather than trusting one unpaged response.
async function loadBargainingProposals(client, workspaceIds) {
  const rows = [];
  let after = null;
  for (;;) {
    let query = client.from("casework_bargaining_proposals")
      .select("id,workspace_id,side,title,status,response_due_at,position,created_at,updated_at")
      .in("workspace_id", workspaceIds)
      .order("id", { ascending: true })
      .limit(Math.min(BARGAINING_PROPOSAL_PAGE_SIZE, BARGAINING_PROPOSAL_ROW_LIMIT + 1 - rows.length));
    if (after !== null) query = query.gt("id", after);
    const page = await list(query, "Load bargaining proposals");
    // A short page can be the API's own lower row cap. Only an empty page
    // proves completion; the extra row at the bound detects truncation.
    if (!page.length) return rows.sort(byProposalPosition);
    rows.push(...page);
    if (rows.length > BARGAINING_PROPOSAL_ROW_LIMIT) throw new Error("Bargaining proposals exceed their row limit");
    const next = page.at(-1)?.id;
    if (typeof next !== "string" || (after !== null && next <= after)) {
      throw new Error("Bargaining proposals could not be read completely");
    }
    after = next;
  }
}

export async function loadCaseworkBargainingTable(client, chapterId) {
  if (!chapterId) throw new Error("Chapter id required");
  const history = await list(client.from("casework_bargaining_workspaces")
    .select(BARGAINING_WORKSPACE_COLUMNS)
    .eq("chapter_id", chapterId).order("updated_at", { ascending: false }).limit(BARGAINING_WORKSPACE_HISTORY_LIMIT), "Load bargaining workspaces");
  // A full history window of newer closed sessions can hide an older open
  // one, which the page must still lead with. It sorts after the window.
  const open = history.length >= BARGAINING_WORKSPACE_HISTORY_LIMIT && history.every((row) => row.status === "closed")
    ? await list(client.from("casework_bargaining_workspaces")
      .select(BARGAINING_WORKSPACE_COLUMNS)
      .eq("chapter_id", chapterId).neq("status", "closed").order("updated_at", { ascending: false }).limit(1), "Load open bargaining workspace")
    : [];
  const workspaces = [...history, ...open.filter((row) => !history.some((seen) => seen.id === row.id))];
  const workspaceIds = workspaces.map((row) => row.id);
  const proposals = workspaceIds.length ? await loadBargainingProposals(client, workspaceIds) : [];
  return workspaces.map((workspace) => ({
    ...workspace,
    proposals: proposals.filter((row) => row.workspace_id === workspace.id),
  }));
}

export async function createCaseworkBargainingWorkspace(client, chapterId, title, startsAt = null) {
  return unwrap(await client.rpc("casework_create_bargaining_workspace", {
    p_chapter_id: chapterId,
    p_title: title,
    p_starts_at: startsAt,
  }), "Create bargaining workspace");
}

export async function addCaseworkBargainingProposal(client, workspaceId, fields) {
  return unwrap(await client.rpc("casework_add_bargaining_proposal", {
    p_workspace_id: workspaceId,
    p_side: fields.side,
    p_title: fields.title,
    p_body: fields.body,
    p_response_due_at: fields.responseDueAt || null,
  }), "Add bargaining proposal");
}

export async function transitionCaseworkBargainingProposal(client, proposalId, expectedStatus, nextStatus, responseDueAt = null) {
  return unwrap(await client.rpc("casework_transition_bargaining_proposal", {
    p_proposal_id: proposalId,
    p_expected_status: expectedStatus,
    p_next_status: nextStatus,
    p_response_due_at: responseDueAt,
  }), "Transition bargaining proposal");
}

export async function addCaseworkBargainingEvent(client, workspaceId, eventType, body, pulse = null) {
  return unwrap(await client.rpc("casework_add_bargaining_event", {
    p_workspace_id: workspaceId,
    p_event_type: eventType,
    p_body: body,
    p_pulse: pulse,
  }), "Add bargaining timeline event");
}

export async function setCaseworkBargainingStatus(client, workspaceId, expectedStatus, nextStatus) {
  return unwrap(await client.rpc("casework_set_bargaining_status", {
    p_workspace_id: workspaceId,
    p_expected_status: expectedStatus,
    p_next_status: nextStatus,
  }), "Update bargaining session");
}

export async function saveCaseworkIntakeDraft(client, fields) {
  return unwrap(await client.rpc("casework_save_intake_draft", {
    p_draft_id: fields.id || null,
    p_chapter_id: fields.chapterId,
    p_member_user_id: fields.memberUserId || null,
    p_case_id: fields.caseId || null,
    p_payload: fields.payload,
    p_expected_revision: fields.revision || 0,
  }), "Save intake draft");
}

export async function scanCaseworkRetaliationPatterns(client, chapterId) {
  return unwrap(await sensitiveContentRpc(client, "casework_scan_retaliation_patterns", { p_chapter_id: chapterId }), "Scan retaliation patterns");
}

export async function reviewCaseworkRetaliationPattern(client, patternId, status, disposition, note = "") {
  return unwrap(await client.rpc("casework_review_retaliation_pattern", {
    p_pattern_id: patternId,
    p_status: status,
    p_disposition: disposition || null,
    p_note: note || null,
  }), "Review retaliation pattern");
}

export async function loadMemberRetaliationReports(client, caseId) {
  const reports = [];
  let cursor = null;
  const seen = new Set();
  do {
    const page = unwrap(await sensitiveContentRpc(client, "list_retaliation", { caseId, cursor }), "Load retaliation reports");
    reports.push(...page.reports);
    cursor = page.nextCursor;
    if (cursor) {
      const key = JSON.stringify(cursor);
      if (seen.has(key)) throw new Error("Retaliation pagination did not advance");
      seen.add(key);
    }
  } while (cursor);
  return reports;
}

export async function loadCaseworkHistory(client, options = {}) {
  const userId = await actorId(client);
  const page = Math.max(0, Number(options.page) || 0);
  const pageSize = 50;
  let query = client.from("member_cases")
    .select("id,user_id,reference,title,case_type,status,deadline,is_restricted,updated_at", { count: "exact" })
    .eq("steward_user_id", userId)
    .order("updated_at", { ascending: false });
  if (options.status && options.status !== "all") query = query.eq("status", options.status);
  if (options.caseType) query = query.eq("case_type", options.caseType);

  if (options.restricted === "restricted") query = query.eq("is_restricted", true);
  if (options.restricted === "standard") query = query.eq("is_restricted", false);
  if (options.search) {
    const term = options.search.replaceAll("%", "").replaceAll(",", "").trim();
    if (term) query = query.or(`reference.ilike.%${term}%,title.ilike.%${term}%`);
  }
  const result = await query.range(page * pageSize, ((page + 1) * pageSize) - 1);
  const rows = unwrap(result, "Load case history") || [];
  const userIds = [...new Set(rows.map((row) => row.user_id).filter(Boolean))];
  const profiles = userIds.length
    ? await list(client.from("member_profiles").select("id,full_name,initials").in("id", userIds), "Load case-history members")
    : [];
  const byId = new Map(profiles.map((row) => [row.id, row]));
  return {
    rows: rows.map((row) => ({ ...row, member: byId.get(row.user_id) || null })),
    total: Number(result.count) || rows.length,
    page,
    pageSize,
  };
}

export async function submitCaseworkRetaliationReport(client, fields) {
  return unwrap(await sensitiveContentRpc(client, "casework_submit_retaliation_report", {
    p_case_id: fields.caseId,
    p_incident_at: fields.incidentAt,
    p_management_person: fields.managementPerson,
    p_protected_activity: fields.protectedActivity,
    p_adverse_action: fields.adverseAction,
    p_requested_support: fields.requestedSupport || null,
    p_idempotency_key: crypto.randomUUID(),
  }), "Submit retaliation report");
}

export async function withdrawCaseworkRetaliationReport(client, reportId, reason) {
  return unwrap(await sensitiveContentRpc(client, "casework_withdraw_retaliation_report", {
    p_report_id: reportId,
    p_reason: reason,
  }), "Withdraw retaliation report");
}

export async function bulkUpdateCaseworkCases(client, caseIds, expectedStatus, fields) {
  return unwrap(await client.rpc("casework_bulk_update_cases", {
    p_case_ids: caseIds,
    p_expected_status: expectedStatus,
    p_next_status: fields.status || null,
    // Union Ground issues carry no grievance step, so the batch RPC's step
    // parameter is always null.
    p_next_step: null,
    p_idempotency_key: crypto.randomUUID(),
  }), "Bulk update cases");
}

// Whether the member's own case is moved by its representative (#7980): the
// same predicate update_my_member_case refuses on, so the case window shows
// read-only status and deadline for an assignment it cannot see by name.
export async function getMyCaseManaged(client, caseId) {
  return unwrap(await client.rpc("get_my_member_case_managed", { p_case_id: caseId }), "Case edit access") === true;
}

// The outcome a coordinator recorded on the member's own case (#7195), under
// the owner's select policy on member_case_outcomes; null until one exists.
export async function loadMyCaseOutcome(client, caseId) {
  if (!caseId) throw new Error("Case id required");
  const [row] = await list(client.from("member_case_outcomes").select("outcome,summary,recorded_at,updated_at").eq("case_id", caseId).limit(1), "Load outcome");
  return row ? { outcome: row.outcome, summary: row.summary, recordedAt: row.recorded_at, updatedAt: row.updated_at } : null;
}

// Case dashboards (REQ-UG-CASEWORK-CONSOLE-54-CASE-DASHBOARDS-20260917).
//
// Three aggregates, one round trip each, all scoped server-side. The client's
// only job is to name the numbers: it never sees a case row, and it could not
// derive these counts if it wanted to — the queue it holds is one keyset page.
// The by-step and median-days-per-step aggregates are not read: Union
// Ground issues have no grievance procedure (owner decision, 2026-10-13).
export async function loadCaseDashboards(client) {
  const [dueSoon, overdue, assignees] = await Promise.all([
    client.rpc("casework_dashboard_deadlines_due_soon"),
    client.rpc("casework_dashboard_overdue_deadlines"),
    client.rpc("casework_dashboard_open_cases_by_assignee"),
  ]);
  const rows = (result, label) => {
    const data = unwrap(result, label);
    return Array.isArray(data) ? data : [];
  };
  return {
    dueSoon: rows(dueSoon, "Deadlines due soon")
      .map((row) => ({
        daysOut: Number(row.days_out),
        deadlineCount: Number(row.deadline_count),
        caseCount: Number(row.case_count),
      })),
    overdue: rows(overdue, "Overdue deadlines")
      .map((row) => ({
        kind: row.kind,
        deadlineCount: Number(row.deadline_count),
        caseCount: Number(row.case_count),
        oldestDueAt: row.oldest_due_at || null,
      })),
    byAssignee: rows(assignees, "Open cases by assignee")
      .map((row) => ({
        role: row.assignee_role,
        userId: row.assignee_user_id || null,
        name: row.assignee_name || "",
        caseCount: Number(row.case_count),
      })),
  };
}

// Preserve the server timestamp verbatim: converting it through Date would lose
// PostgreSQL microseconds and can skip events at a page boundary.
export async function loadCaseHistory(client, caseId, { limit = 50, before = null } = {}) {
  if (!caseId) throw new Error("Case id required");
  const pageSize = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 50));
  const result = await client.rpc("casework_case_history", {
    p_case_id: caseId, p_limit: pageSize, p_before: before,
  });
  // The timeline clears authorized rows on an HTTP refusal (401/403/404) even
  // when the gateway sent no PostgREST code, so keep the response status.
  if (result?.error) {
    const error = new MemberApiError("Load case timeline", { ...result.error, message: result.error.message || "request failed" });
    error.status = result.status ?? null;
    throw error;
  }
  const rows = Array.isArray(result?.data) ? result.data : [];
  return { rows, nextBefore: rows.length >= pageSize ? rows.at(-1).at : null };
}

// REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001: steward email that
// automatic routing attached to this case. Staff-only; the RPC re-checks that
// the caller can open the case and refuses everyone else.
export async function loadCaseStewardEmails(client, caseId) {
  if (!caseId) throw new Error("Case id required");
  return list(client.rpc("list_case_steward_emails", { p_case_id: caseId }), "Load case steward email");
}

// Lane 5.6. Macros are organization property, so the list read is an RPC
// rather than a table select: the routine resolves the caller's organization
// itself instead of trusting a client-supplied id.
export async function listCaseworkMacros(client) {
  const rows = unwrap(await client.rpc("casework_list_macros", {}), "List case macros");
  return Array.isArray(rows) ? rows : [];
}

// BUG-UG-CASE-MACRO-WRITE-AUDIENCE-WIDER-THAN-READ-20260917.
// 20260918201000 narrowed macro authorship to the macro's own read audience,
// so public.casework_save_macro can now refuse a save that used to be accepted:
// a coordinator whose hat comes from public.member_role_chapters alone, with no
// public.organization_role_grants row, used to author a macro they could never
// list. That refusal carries this HINT, which is the only thing distinguishing
// it from the other 42501 the routine raises ("macro scope cannot change"). The
// hint is a stable server token, never displayed; the editor maps it to
// translated copy.
export const CASEWORK_MACRO_AUDIENCE_HINT = "casework_macro_audience";

export function isCaseworkMacroAudienceRefusal(error) {
  return error?.code === "42501" && error?.hint === CASEWORK_MACRO_AUDIENCE_HINT;
}

export async function saveCaseworkMacro(client, macro) {
  return unwrap(await client.rpc("casework_save_macro", {
    p_macro_id: macro.id || null,
    p_chapter_id: macro.chapterId || null,
    p_name: macro.name,
    p_actions: macro.actions,
    p_active: macro.active !== false,
  }), "Save case macro");
}

// One key for the whole batch: the server derives a per-(case, action) key
// from it, so a retry after a dropped response replays nothing.
export async function applyCaseworkMacro(client, macroId, caseIds, idempotencyKey = null) {
  return unwrap(await client.rpc("casework_apply_macro", {
    p_macro_id: macroId,
    p_case_ids: caseIds,
    p_idempotency_key: idempotencyKey || crypto.randomUUID(),
  }), "Apply case macro");
}

// SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917. The receipt for a
// desk CSV export, called before the browser writes the file. Only three things
// travel: the ids of the rows being exported, which scope they came from, and
// the NAMES of the facets that produced a visible-slice export. No facet value,
// no search text, no row content — the routine derives the count, the actor and
// the tenant itself, and refuses above its own caps and for any case the caller
// cannot read.
export async function recordCaseworkCaseExport(client, caseIds, scope, filterKeys = []) {
  return unwrap(await client.rpc("casework_record_case_export", {
    p_case_ids: caseIds,
    p_scope: scope,
    p_filter_keys: filterKeys,
  }), "Record case export");
}

export async function listCaseNoteMentionCandidates(client, caseId) {
  const rows = unwrap(await client.rpc("list_case_note_mention_candidates", { p_case_id: caseId }), "List mention candidates");
  return Array.isArray(rows) ? rows : [];
}

export async function addCaseworkCaseNote(client, caseId, body, mentionIds = []) {
  return unwrap(await client.rpc("casework_add_case_note", {
    p_case_id: caseId,
    p_body: body,
    p_mention_ids: mentionIds,
  }), "Add case note");
}

// The coordinator deadlines card: open procedural clocks on the given cases.
// "missed" stays listed: the minute sweep marks a clock missed at its due time
// (grace 0 by default), and that is the most overdue work on the desk. Row
// access is the casework_deadlines read policy; naming the case ids keeps the
// list to the desk's own cases. Ids go in batches so every loaded case is asked
// about. Each batch reads clocks still ahead (due from now on), soonest first,
// separately from the most recent ones already past, so passed and missed
// clocks that pile up cannot push upcoming clocks out of the bounded read.
const CLOCK_CASE_BATCH = 100;
// Open contract clocks: missed ones stay actionable overdue work. The alternate
// shell's case card reads the same set (the alternate shell's case card).
export const OPEN_CLOCK_STATUSES = Object.freeze(["active", "extended", "missed"]);
export async function listOpenCaseworkDeadlines(client, caseIds, { now = new Date() } = {}) {
  const ids = [...new Set((caseIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const since = new Date(now).toISOString();
  const read = () => client.from("casework_deadlines").select("id,case_id,kind,label,due_at,status");
  const batches = [];
  for (let start = 0; start < ids.length; start += CLOCK_CASE_BATCH) batches.push(ids.slice(start, start + CLOCK_CASE_BATCH));
  const pages = await Promise.all(batches.flatMap((batch) => [
    list(read().in("case_id", batch).in("status", OPEN_CLOCK_STATUSES).gte("due_at", since).order("due_at").limit(200), "Load case deadlines"),
    list(read().in("case_id", batch).in("status", OPEN_CLOCK_STATUSES).lt("due_at", since).order("due_at", { ascending: false }).limit(20), "Load case deadlines"),
  ]));
  return pages.flat()
    .map((row) => ({ id: row.id, caseId: row.case_id, kind: row.kind, label: row.label, dueAt: row.due_at, status: row.status }))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

// BUG-UG-CASEWORK-DEADLINE-REMINDER-AT-NEVER-FIRES-20261001: staff record a
// deadline met or waived, or reopen it (including one the sweep marked missed).
export async function setCaseworkDeadlineStatus(client, deadlineId, status) {
  return unwrap(await client.rpc("casework_set_deadline_status", {
    p_deadline_id: deadlineId,
    p_status: status,
  }), "Update deadline status");
}
