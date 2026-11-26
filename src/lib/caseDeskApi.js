// The alternate shell's case desk reads (REQ-UG-ALT-CASE-DESK-SERVER-READS-20261030).
// Three bounded reads the desk's views need beside the steward and coordinator
// desk loaders, each under the server's own authorization:
//   loadDeskCaseDetails  casework_desk_case_details: opened and closing dates,
//                        the outcome where the caller already reads it, open
//                        contract clocks with their step rule, hearings and
//                        the settle/reopen history. It writes no access
//                        record, so the desk can draw every case before one
//                        is opened.
//   loadStewardCaseloadPage  the steward window past the desk's 200 active and
//                        50 closed cases, on the same assignee predicate.
//   loadDeskCaseNotes    a case's notes past the 20 the desk read carries,
//                        newest first, under the notes' own RLS.
// fieldNoteTemplates reads an organization's note wording out of the case
// macros it already lists (their add_note actions), so a field note can start
// from it without running the macro.

export const DESK_DETAILS_BATCH = 100;
export const STEWARD_CASE_PAGE = 100;
export const DESK_NOTE_PAGE = 20;
const LATEST_UPDATES_BATCH = 40;
const LATEST_UPDATES_PER_CASE = 20;
const STEWARD_CASE_SELECT = "id,user_id,chapter_id,reference,title,deadline,case_type,articles,step,status,updated_at,assigned_at,coordinator_name,created_at";

export class CaseDeskReadError extends Error {
  constructor(label, cause) {
    super(`${label} failed`);
    this.name = "CaseDeskReadError";
    this.code = cause?.code ?? null;
    this.cause = cause;
  }
}

const rows = (result, label) => {
  if (result?.error) throw new CaseDeskReadError(label, result.error);
  return Array.isArray(result?.data) ? result.data : [];
};
const list = (value) => (Array.isArray(value) ? value : []);
const RULE_KINDS = ["business_days", "calendar_days"];
const RULE_FROM = ["step_entry", "filing", "incident"];

// A configured step's deadline rule, or null when the clock was not set by
// one (a hand-entered deadline) or the rule is "no deadline".
function shapeRule(rule) {
  if (!rule || !RULE_KINDS.includes(rule.kind) || !RULE_FROM.includes(rule.from)) return null;
  const count = Number(rule.count);
  return Number.isSafeInteger(count) && count >= 0 ? { kind: rule.kind, count, from: rule.from } : null;
}

export function shapeDeskCaseDetails(row) {
  const outcome = row?.outcome && typeof row.outcome === "object" ? row.outcome : null;
  return {
    openedAt: row?.openedAt ?? null,
    closedAt: row?.closedAt ?? null,
    outcome: outcome ? { outcome: outcome.outcome ?? "", summary: outcome.summary ?? "", recordedAt: outcome.recordedAt ?? null } : null,
    clocks: list(row?.clocks).filter((clock) => clock?.id && clock.dueAt).map((clock) => ({
      id: clock.id,
      kind: clock.kind ?? "",
      label: clock.label ?? "",
      dueAt: clock.dueAt,
      status: clock.status ?? "active",
      stepLabel: clock.stepLabel ?? "",
      rule: shapeRule(clock.rule),
    })),
    hearings: list(row?.hearings).filter((hearing) => hearing?.id && hearing.dueAt).map((hearing) => ({
      id: hearing.id, label: hearing.label ?? "", dueAt: hearing.dueAt, status: hearing.status ?? "active",
    })),
    statusEvents: list(row?.statusEvents).filter((event) => event?.at).map((event) => ({
      at: event.at,
      from: event.from ?? null,
      to: event.to ?? null,
      actorRole: event.actorRole ?? null,
      actorName: event.actorName ?? "",
      byYou: event.byYou === true,
    })),
  };
}

// Details for every case id given, keyed by case id. Ids the caller cannot
// work are simply absent from the result.
export async function loadDeskCaseDetails(client, caseIds) {
  const ids = [...new Set(list(caseIds).filter(Boolean))];
  const batches = Array.from({ length: Math.ceil(ids.length / DESK_DETAILS_BATCH) }, (_, index) => ids.slice(index * DESK_DETAILS_BATCH, (index + 1) * DESK_DETAILS_BATCH));
  const results = await Promise.all(batches.map((batch) => client.rpc("casework_desk_case_details", { p_case_ids: batch })));
  const details = new Map();
  for (const result of results) {
    for (const row of rows(result, "Case desk details")) if (row?.caseId) details.set(row.caseId, shapeDeskCaseDetails(row));
  }
  return details;
}

// One more page of the steward's own caseload: the same assignee-scoped
// predicate and order as the steward desk's windows (UB-CASE-05), with the id
// as the final tiebreak so pages never overlap. `offset` is how many rows of
// this status the desk already holds; one extra row proves another page.
export async function loadStewardCaseloadPage(client, { status = "active", offset = 0, limit = STEWARD_CASE_PAGE } = {}) {
  const session = await client.auth?.getSession?.();
  if (session?.error) throw new CaseDeskReadError("Steward session", session.error);
  const uid = session?.data?.session?.user?.id ?? null;
  if (!uid) throw new CaseDeskReadError("Steward session", null);
  const size = Math.min(Math.max(Number(limit) || STEWARD_CASE_PAGE, 1), STEWARD_CASE_PAGE);
  const from = Math.max(Number(offset) || 0, 0);
  let query = client.from("member_cases").select(STEWARD_CASE_SELECT)
    .eq("steward_user_id", uid).neq("user_id", uid).eq("status", status === "resolved" ? "resolved" : "active");
  query = status === "resolved"
    ? query.order("updated_at", { ascending: false })
    : query.order("deadline", { ascending: true, nullsFirst: false }).order("updated_at", { ascending: false });
  const page = rows(await query.order("id", { ascending: true }).range(from, from + size), "Steward caseload page");
  const shown = page.slice(0, size);
  const memberIds = [...new Set(shown.map((item) => item.user_id).filter(Boolean))];
  const caseIds = shown.map((item) => item.id);
  const [profilesResult, updateResults] = await Promise.all([
    memberIds.length ? client.from("member_profiles").select("id,full_name,initials").in("id", memberIds) : { data: [], error: null },
    Promise.all(Array.from({ length: Math.ceil(caseIds.length / LATEST_UPDATES_BATCH) }, (_, index) =>
      client.rpc("list_case_latest_updates", { p_case_ids: caseIds.slice(index * LATEST_UPDATES_BATCH, (index + 1) * LATEST_UPDATES_BATCH), p_per_case: LATEST_UPDATES_PER_CASE }))),
  ]);
  const namesUnavailable = Boolean(profilesResult.error);
  const profileById = new Map(list(profilesResult.data).map((row) => [row.id, row]));
  const updatesUnavailable = updateResults.some((result) => result.error);
  const updatesByCase = new Map();
  const totals = new Map();
  if (!updatesUnavailable) {
    for (const row of updateResults.flatMap((result) => list(result.data))) {
      if (!updatesByCase.has(row.case_id)) updatesByCase.set(row.case_id, []);
      updatesByCase.get(row.case_id).push({ id: row.id, body: row.body, createdAt: row.created_at, mentions: row.mentions || [] });
      totals.set(row.case_id, Number(row.total_count) || 0);
    }
  }
  return {
    cases: shown.map((item) => ({
      id: item.id,
      subjectUserId: item.user_id,
      memberName: namesUnavailable ? "Name unavailable" : profileById.get(item.user_id)?.full_name || "Member",
      memberInitials: namesUnavailable ? "?" : profileById.get(item.user_id)?.initials || "M",
      memberNameUnavailable: namesUnavailable,
      reference: item.reference,
      title: item.title,
      caseType: item.case_type,
      articles: item.articles,
      step: item.step,
      status: item.status,
      deadline: item.deadline,
      updatedAt: item.updated_at,
      assignedAt: item.assigned_at,
      createdAt: item.created_at,
      coordinatorName: item.coordinator_name,
      chapterId: item.chapter_id || "",
      updates: updatesByCase.get(item.id) || [],
      updatesTotal: totals.get(item.id) ?? 0,
      updatesUnavailable,
      review: null,
    })),
    hasMore: page.length > size,
    updatesUnavailable,
  };
}

// PostgREST filter values holding ":" or "+" are quoted.
const quoted = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// A case's notes older than `before` (the oldest note the desk shows), newest
// first, on the (created_at, id) keyset so notes written in one instant are
// never skipped. One extra row proves an older page.
export async function loadDeskCaseNotes(client, caseId, { before = null, limit = DESK_NOTE_PAGE } = {}) {
  if (!caseId) throw new CaseDeskReadError("Case notes", null);
  const size = Math.min(Math.max(Number(limit) || DESK_NOTE_PAGE, 1), 50);
  let query = client.from("member_case_updates").select("id,body,created_at").eq("case_id", caseId);
  if (before?.createdAt && before?.id) {
    query = query.or(`created_at.lt.${quoted(before.createdAt)},and(created_at.eq.${quoted(before.createdAt)},id.lt.${quoted(before.id)})`);
  }
  const page = rows(await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(size + 1), "Case notes");
  return {
    notes: page.slice(0, size).map((row) => ({ id: row.id, body: row.body ?? "", createdAt: row.created_at, mentions: [] })),
    hasMore: page.length > size,
  };
}

// The note wording of an organization's active case macros: each add_note
// action is one template, named after its macro.
export function fieldNoteTemplates(macros) {
  return list(macros)
    .filter((macro) => macro?.id && macro.active !== false)
    .flatMap((macro) => list(macro.actions)
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action?.kind === "add_note" && typeof action.body === "string" && action.body.trim())
      .map(({ action, index }) => ({ id: `${macro.id}:${index}`, name: String(macro.name ?? "").trim(), body: action.body.trim() })));
}

export function createCaseDeskApi(client) {
  return {
    loadDetails: (caseIds) => loadDeskCaseDetails(client, caseIds),
    loadCaseloadPage: (options) => loadStewardCaseloadPage(client, options),
    loadCaseNotes: (caseId, options) => loadDeskCaseNotes(client, caseId, options),
  };
}
