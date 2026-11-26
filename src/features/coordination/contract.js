export const COORDINATION_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  disposition: "port_adapt",
  rejected: Object.freeze([
    "agency-as-tenant authorization",
    "caller-supplied organization scope",
    "browser service-role clients",
    "donor project identifiers or migration history",
    "fictional production tenants and users",
    "protected record copies in messages, tasks, or exports",
  ]),
});

export const COORDINATION_RPCS = Object.freeze({
  snapshot: "get_organization_coordination_snapshot",
  recordsPage: "list_organization_coordination_records",
  messagesPage: "list_organization_coordination_messages",
  networkAccessEvents: "list_organization_network_access_events",
  extensions: "get_organization_coordination_extensions",
  create: "create_organization_coordination_record",
  join: "join_organization_coordination_record",
  transition: "transition_organization_coordination_record",
  respond: "respond_organization_coordination_invitation",
  message: "send_organization_coordination_message",
  resource: "share_organization_coordination_resource",
  export: "run_organization_coordination_export",
  exportPayload: "get_organization_coordination_export_payload",
  outreach: "record_organization_coordination_outreach",
  profile: "upsert_organization_network_profile",
  permission: "set_organization_network_permission",
  inviteOrganization: "invite_organization_coordination_participant",
  respondParticipant: "respond_organization_coordination_participant",
  respondResource: "respond_organization_coordination_resource",
  sharedDocument: "get_organization_coordination_shared_document",
  assignParticipant: "assign_organization_coordination_participant",
  coalitionDecisions: "get_organization_coalition_decisions",
  proposeCoalitionDecision: "propose_organization_coalition_decision",
  voteCoalitionDecision: "vote_organization_coalition_decision",
  reviewMergeMatch: "review_organization_merge_match",
  executeMerge: "execute_organization_merge_plan",
  micrositeEditor: "get_public_chapter_microsite_editor",
  saveChapterProfile: "upsert_public_chapter_profile",
  saveMicrositeSection: "upsert_public_chapter_microsite_section",
  saveMicrositePage: "upsert_public_chapter_microsite_page",
  attachPublicPageDocument: "attach_public_chapter_page_document",
  takeOverPublicPage: "take_over_public_chapter_page",
  recommendCoverage: "recommend_organization_coverage",
});

export const COORDINATION_KINDS = Object.freeze([
  "mission",
  "mission_objective",
  "network_link",
  "network_conversation",
  "network_request",
  "network_export_schedule",
  "handshake_workspace_item",
  "coalition",
  "coalition_campaign",
  "coalition_work_item",
  "merger_plan",
  "microsite_page",
  "coverage_schedule",
  "coverage_override",
  "committee",
  "mobilization_campaign",
  "mobilization_cohort",
]);

export const COORDINATION_STAFF_HATS = Object.freeze([
  "steward",
  "coordinator",
  "advisor",
  "admin",
  "vp",
]);

// The hats each role-gated RPC admits, copied from the last migration definition
// of that function. canManageCoordination admits every staff hat, so a control
// whose RPC names a narrower set must be gated on this table instead.
export const COORDINATION_INTENT_ROLES = Object.freeze({
  inviteOrganization: Object.freeze(["coordinator", "admin", "vp"]),
  respondParticipant: Object.freeze(["coordinator", "admin", "vp"]),
  outreach: Object.freeze(["steward", "coordinator", "admin", "vp"]),
  // The four export/profile/permission mutations whose RPCs narrow
  // has_organization_role(..., array['coordinator','admin','vp']) — a steward or
  // advisor hat passes canManageCoordination but the server refuses these with
  // 42501, so the desk must not render the controls for those hats at all.
  runExport: Object.freeze(["coordinator", "admin", "vp"]),
  downloadExport: Object.freeze(["coordinator", "admin", "vp"]),
  saveProfile: Object.freeze(["coordinator", "admin", "vp"]),
  setPermission: Object.freeze(["coordinator", "admin", "vp"]),
});

// The formats run_organization_coordination_export accepts
// (supabase/migrations/20260828235000_mi1_organization_coordination_hardening.sql):
// anything else is refused server-side with 22023, so the adapter validates
// against the same set before sending p_format.
export const COORDINATION_EXPORT_FORMATS = Object.freeze(["csv", "json"]);

export const COORDINATION_TABS = Object.freeze([
  Object.freeze({ id: "missions", label: "Missions", kinds: Object.freeze(["mission", "mission_objective"]) }),
  Object.freeze({ id: "network", label: "Network", kinds: Object.freeze(["network_link", "network_conversation", "network_request"]) }),
  Object.freeze({ id: "coalitions", label: "Coalitions", staffOnly: true, kinds: Object.freeze(["coalition", "coalition_campaign", "coalition_work_item"]) }),
  Object.freeze({ id: "operations", label: "Operations", staffOnly: true, kinds: Object.freeze(["network_export_schedule", "handshake_workspace_item", "merger_plan"]) }),
  Object.freeze({ id: "chapter", label: "Chapter", kinds: Object.freeze(["microsite_page", "coverage_schedule", "coverage_override", "committee"]) }),
  Object.freeze({ id: "mobilize", label: "Mobilize", staffOnly: true, kinds: Object.freeze(["mobilization_campaign", "mobilization_cohort"]) }),
]);

// The 10 model fields of `get_organization_coordination_extensions` the desk
// consumes. That RPC also projects `pageAttachments`, which no tab renders and
// no reachable intent writes, so the desk does not declare it
// (DEBT-UG-COORDINATION-PAGE-ATTACHMENT-DEAD-WIRING-20260920): a field in
// this list must have a rendering surface, or the per-intent map below
// overstates what the desk actually shows. That RPC is a read by name only:
// its body INSERTs a ('directory_viewed','allowed') row into
// public.organization_network_access_events before it returns this
// projection (supabase/migrations/20260828232000_mi1_organization_coordination_
// workflows.sql), so it is a write and must never run just because a page
// mounted. The desk mounts on the read-only snapshot alone and asks for these
// fields once, on an explicit member request — any actor who can read the desk,
// staff or not — which is also what makes the audit row true: somebody chose to
// look at the partner directory.
export const COORDINATION_EXTENSION_FIELDS = Object.freeze([
  "directory",
  "permissions",
  "invitations",
  "badges",
  "recentActivity",
  "organizationParticipants",
  "userParticipants",
  "mergeMatches",
  "mergeJobs",
  "mobilizationProgress",
]);

// Every `run()` intent on the coordination view must appear here so a newly
// added mutation cannot inherit a writing directory refresh by default. The
// arrays name the COORDINATION_EXTENSION_FIELDS that intent's RPC can change;
// an empty list means the mutation owns none of them and must not re-issue
// get_organization_coordination_extensions (and therefore must not write a
// directory_viewed row).
export const COORDINATION_MUTATION_EXTENSION_TOUCH = Object.freeze({
  create: Object.freeze([]),
  join: Object.freeze(["organizationParticipants", "userParticipants"]),
  transition: Object.freeze(["badges", "recentActivity"]),
  respond: Object.freeze(["invitations"]),
  message: Object.freeze([]),
  runExport: Object.freeze([]),
  downloadExport: Object.freeze([]),
  outreach: Object.freeze(["mobilizationProgress"]),
  saveProfile: Object.freeze(["directory"]),
  setPermission: Object.freeze(["permissions"]),
  resource: Object.freeze([]),
  respondResource: Object.freeze([]),
  inviteOrganization: Object.freeze([]),
  respondParticipant: Object.freeze(["invitations"]),
  assignParticipant: Object.freeze(["organizationParticipants", "userParticipants"]),
  proposeCoalitionDecision: Object.freeze([]),
  voteCoalitionDecision: Object.freeze([]),
  reviewMergeMatch: Object.freeze(["mergeMatches"]),
  executeMerge: Object.freeze(["mergeJobs"]),
  saveChapterProfile: Object.freeze([]),
  saveMicrositeSection: Object.freeze([]),
  saveMicrositePage: Object.freeze([]),
  attachPublicPageDocument: Object.freeze([]),
  takeOverPublicPage: Object.freeze([]),
});

export function coordinationIntentTouchesExtensions(intent) {
  const fields = COORDINATION_MUTATION_EXTENSION_TOUCH[intent];
  return Array.isArray(fields) && fields.length > 0;
}

// `idle` is the mounted-but-never-requested state, and it is NOT "empty": empty
// means the backend answered and nothing is there, idle means nothing was asked.
// The desk shows its explicit request control for every state except "ready".
export const EMPTY_COORDINATION_EXTENSIONS = Object.freeze({
  state: "idle",
  organizationId: null,
  directory: Object.freeze([]),
  permissions: Object.freeze([]),
  invitations: Object.freeze([]),
  badges: Object.freeze([]),
  recentActivity: Object.freeze([]),
  organizationParticipants: Object.freeze([]),
  userParticipants: Object.freeze([]),
  mergeMatches: Object.freeze([]),
  mergeJobs: Object.freeze([]),
  mobilizationProgress: Object.freeze([]),
});

// The ONE load outcome a second press can honestly change. The RPC behind this
// projection is not idempotent — its body INSERTs a 'directory_viewed' row — so a
// retry is honest only when the client can prove the call never executed, and
// `unavailable` is the only outcome that proves it: adapter.js derives it solely
// from pre-execution failures (no client at all, or PostgREST answering PGRST202
// from its schema cache without ever calling the function), never from a message
// pattern. Everything else is final for this visit. `mfa_required` and
// `unauthorized` are refusals the same request earns again, `empty` is an answer,
// and the generic `error` is AMBIGUOUS: a dropped connection, a 5xx, or a fault
// raised inside the function body can all arrive after the audit row committed,
// so re-issuing would write a second row while the copy claimed nothing was
// recorded. The desk offers a retry only for the state in this list, and the
// wiring's one-request latch reads the same list, so a state with no retry
// control also cannot be re-issued programmatically.
export const COORDINATION_EXTENSIONS_RETRYABLE_STATES = Object.freeze(["unavailable"]);

// The two outcomes that mean the backend answered and the projection on screen is
// the backend's own. A post-mutation refresh is offered only from these: there is
// nothing to bring up to date before the first answer, and a refusal or an
// ambiguous failure must not be turned into a second writing call by a mutation.
export const COORDINATION_EXTENSIONS_ANSWERED_STATES = Object.freeze(["ready", "empty"]);

// How authoritative this session's organization is, on the actor every
// coordination call is scoped by. `get_organization_coordination_extensions`
// takes no arguments: it resolves the organization server-side from
// private.current_member_organization(), so a call issued while the client still
// holds the organization the route was MOUNTED with can insert a
// 'directory_viewed' row for a different organization and only then be told the
// answer is unauthorized. "pending" is the mount window before
// get_my_chapter_memberships has answered, "unconfirmed" is that discovery having
// failed, and only "resolved" is the server's own answer. The deferred request is
// offered by the desk, and issued by the adapter, in the third case alone.
export const COORDINATION_SESSION_SCOPE_STATES = Object.freeze(["pending", "unconfirmed", "resolved"]);

export const EMPTY_COORDINATION_SNAPSHOT = Object.freeze({
  state: "empty",
  // The staff-only mount projections that did not answer. They ADD to the desk
  // the snapshot already describes, so one of them failing degrades its own
  // panel and is named here; it never turns a ready desk into a whole-page
  // "Coordination is unavailable" (see adapter.load).
  degradedProjections: Object.freeze([]),
  organizationId: null,
  staff: false,
  records: Object.freeze([]),
  nextRecordsCursor: null,
  messages: Object.freeze([]),
  nextMessagesCursor: null,
  resources: Object.freeze([]),
  exportRuns: Object.freeze([]),
  outreach: Object.freeze([]),
  directory: Object.freeze([]),
  permissions: Object.freeze([]),
  networkAccessEvents: Object.freeze([]),
  invitations: Object.freeze([]),
  badges: Object.freeze([]),
  recentActivity: Object.freeze([]),
  organizationParticipants: Object.freeze([]),
  userParticipants: Object.freeze([]),
  mergeMatches: Object.freeze([]),
  mergeJobs: Object.freeze([]),
  coalitionDecisions: Object.freeze([]),
  micrositeEditor: Object.freeze({
    state: "missing",
    chapterCode: null,
    profile: null,
    sections: Object.freeze([]),
    pages: Object.freeze([]),
    attachments: Object.freeze([]),
    takeovers: Object.freeze([]),
  }),
  mobilizationProgress: Object.freeze([]),
});
