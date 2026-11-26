import { loadMemberApp, loadMemberRealtimeGap } from "./memberApi.js";
import { SHELL_LOAD_DEADLINE_MS, withLoadDeadline } from "./loadDeadline.js";
import { captureSanitizedDiagnostic } from "./deferredObservability.js";
import { STAFF_TOOL_ROLES } from "./staffPlanes.js";
import { WORKLOAD_CATEGORY_RESOURCE } from "./workloadCategories.js";
import { WORKLOAD_CONFIGURATION_RESOURCE } from "./workloadConfiguration.js";
import {
  MEMBER_HOME_BOOTSTRAP_RESOURCE,
  MEMBER_HOME_BOOTSTRAP_RPC,
  memberHomeBootstrapArguments,
  memberHomeBootstrapQueries,
  memberHomeBootstrapRows,
} from "./memberHomeBootstrap.js";

// 4 -> 8 on 2026-10-30 for REQ-UG-PAGE-LOADING-STALLS-20261030. The
// queue, not the database, set the cold-load time: a route's reads went out in
// waves of four, so the steward route (58 reads) waited 15 round trips and
// search (76 reads) 19 before "Loading Union Ground…" cleared — 4.5 s and
// 5.7 s at a 300 ms round trip. Supabase answers over HTTP/2, so eight reads
// share one connection; the read count per route is unchanged.
export const MEMBER_REQUEST_CONCURRENCY = 8;
// 33 -> 34 on 2026-09-22 for REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922.
// The Find-my-steward card is default-on and always visible on Home, so its
// roster is boot data, not a lazy panel: deferring it would put a spinner on
// the member's most common action. The cost is exactly one additional Home-only
// read at concurrency 4. Raise this again only for the same kind of reason —
// a new always-visible Home surface — and never to absorb an accidental fetch.
// 34 -> 35 on 2026-10-01 for REQ-UG-ULP-FILING-DEADLINE-20261001: a legal
// filing deadline on the member's own case is always-visible Home data (lane
// L4 ranks "What matters for you now" on it), so its one self-only summary read
// is boot data for the same reason as the steward roster above.
// 35 -> 18 on 2026-10-28 for PERF-UG-COLD-HOME-BOOTSTRAP-ONE-CALL-20261028:
// the eighteen plain table reads of the cold Home plan arrive in one
// get_member_home_bootstrap call (memberHomeBootstrap.js). The owner's ruling
// of October 28, 2026 allows lowering the count when the same consumer data
// still reaches the route: the batch carries every row the replaced reads
// carried, and a read whose query shape differs still goes to its own table.
// 18 -> 19 on 2026-11-11 for BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111:
// Home's "open surveys" count and "What matters for you now" read the
// organization surveys open to the member (get_member_engagement_snapshot),
// always-visible Home data of the same kind as the two raises above; without
// it Home said "0 open surveys" while Voice listed one.
// The organization surveys open to the member (Home, Voting, VP) are read
// again on a route visit once the cached copy is this old.
export const ENGAGEMENT_SNAPSHOT_RESOURCE = "rpc:get_member_engagement_snapshot";
export const ENGAGEMENT_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;
// Union Ground keeps its own member loader (loadMemberApp in memberApi.js):
// 35 -> 30 because ULP filing deadlines are left out, and with no points
// economy Home no longer reads point rules, reward tiers, reward effects or
// chapter cards; it reads the verified participation week instead of the
// retired action log. The ceiling stays exact so a stray read shows.
export const MEMBER_COLD_HOME_REQUEST_CEILING = 30;
export const MEMBER_BOOT_THROUGH_SUBSCRIBED_REQUEST_CEILING = 32;

const resources = (...names) => names;

const SHELL_RESOURCES = resources(
  "table:member_profiles",
  "table:member_notifications",
  "table:member_roles",
  "table:chapters",
  // DesktopRail is part of the shell on every authenticated route. Its case
  // and draft-form badges must not depend on whichever feature happened to
  // run first, and steward badge counts are likewise shell data (the loader
  // still calls the role-gated RPC only after it has confirmed the role).
  "table:member_cases",
  "table:member_forms",
  "rpc:get_staff_mfa_standing",
  "rpc:get_steward_badge_counts",
  "rpc:get_my_chapter_memberships",
  "rpc:get_member_organization_configuration",
);

// Successful member writes can advance the participation week and the
// "actions this year" count independently of their route (Union Ground has
// no points to award). Evict these cross-route aggregates on every mutation
// refresh, while leaving unrelated feature and overlay caches intact.
const SHARED_MUTATION_RESOURCES = resources(
  "table:member_participation_events",
  "rpc:get_member_rewards_summary",
  "table:member_reward_tiers",
);

const HOME_RESOURCES = resources(
  "table:member_broadcasts",
  "table:member_broadcast_receipts",
  "table:member_cases",
  "table:member_case_updates",
  "table:member_ballots",
  "table:member_surveys",
  "table:member_survey_responses",
  "table:member_rights_lessons",
  "table:member_rights_progress",
  "table:member_participation_events",
  "table:member_ballot_receipts",
  "table:member_events",
  "table:member_event_rsvps",
  "table:member_event_checkins",
  "table:chapter_tasks",
  "table:chapter_task_assignments",
  "rpc:list_chapter_task_assignees",
  "rpc:get_member_rewards_summary",
  "rpc:get_chapter_standing",
  "rpc:get_ballot_tally",
  // Find my steward: the Home card's roster. Read on Home and, for its
  // Stewards figure, the alternate shell's My chapter page (hub below).
  "rpc:get_member_chapter_stewards",
  // BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110:
  // open step deadlines on the member's own cases; "What matters for you now"
  // ranks on the earlier of a step deadline and the case's own deadline.
  "table:casework_deadlines",
  // BUG-UG-OPEN-SURVEY-UNREACHABLE-FROM-HOME-AND-PHONE-20261111: the
  // organization surveys open to the member, which Home counts and ranks.
  "rpc:get_member_engagement_snapshot",
);

const MESSAGE_RESOURCES = resources(
  "table:member_conversations",
  "table:member_messages",
  "table:member_conversation_summaries",
  "table:chapter_space_reads",
  "table:member_broadcasts",
  "table:member_broadcast_receipts",
  "table:chapter_spaces",
  "table:chapter_threads",
  "table:chapter_thread_posts",
  "table:chapter_task_messages",
  "table:chapter_documents",
  "rpc:list_member_message_reactions",
  "table:member_saved_messages",
  "table:member_scheduled_messages",
  "table:member_message_reminders",
  "table:member_message_resources",
  "rpc:list_member_message_activity",
  "rpc:list_reward_peer_contact",
  "rpc:list_channel_here_reminders",
);

const VOTING_RESOURCES = resources(
  "table:member_ballots",
  "table:member_surveys",
  "table:member_survey_responses",
  "table:member_ballot_receipts",
  "rpc:get_ballot_tally",
  // The Voting header counts the organization surveys open to the member too.
  "rpc:get_member_engagement_snapshot",
  // REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: a poll
  // suggestion goes into the member's existing direct steward conversation,
  // so a cold Voting load must know it (opening a second one is refused).
  "table:member_conversations",
);

const RIGHTS_RESOURCES = resources(
  "table:member_rights_lessons",
  "table:member_rights_progress",
  "table:member_steward_requests",
);

const EVENT_RESOURCES = resources(
  "table:member_events",
  "table:member_event_rsvps",
  "table:member_event_checkins",
);

// BUG-UG-ALT-MEMBER-PAGES-COLD-LOAD-MISSING-DATA-20261102: the
// alternate shell's record feed (src/alt/recordIndex.js recordItems) reads
// broadcasts, events, ballots and the member's case notes. All updates is
// built from it, and the Events calendar draws it, so a cold load of either
// must read every source or the page shows only what Home happened to load.
const RECORD_FEED_RESOURCES = resources(
  "table:member_broadcasts",
  "table:member_broadcast_receipts",
  "table:member_ballots",
  "table:member_ballot_receipts",
  "table:member_case_updates",
);

const CASE_RESOURCES = resources(
  "table:member_cases",
  "table:member_case_updates",
  "table:member_case_files",
  // My cases shows a case's earliest open step deadline (#7979).
  "table:casework_deadlines",
);

// #9173: a peer.message notice means the other participant wrote, so the
// cached two-person conversations are stale.
const PEER_MESSAGE_RESOURCES = resources("rpc:list_reward_peer_contact");

// #7195: a case.resolved notice means a coordinator resolved the member's own
// case, so the cached case projection (status, and with it the resolved-only
// outcome block) is stale. Both the live arrival and opening the notice
// re-read the case resources (#9173: and a peer.message notice the two-person
// conversations); every other notice refreshes nothing here.
export function notificationRefreshResources(row) {
  if (row?.copy_key === "case.resolved") return CASE_RESOURCES;
  if (row?.copy_key === "peer.message") return PEER_MESSAGE_RESOURCES;
  return [];
}

const NUMBERS_RESOURCES = resources(
  "table:member_participation_events",
  "table:member_cases",
  "table:member_workload_logs",
  "rpc:get_member_rewards_summary",
  "rpc:get_workload_stats",
  "rpc:get_my_report_preferences",
  "rpc:get_my_analytics_report_card",
  "rpc:get_chapter_standing",
);

const WORKLOAD_RESOURCES = resources(
  "table:member_workload_logs",
  "rpc:get_workload_stats",
  "rpc:get_workload_reminder_preferences",
  // REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103.
  WORKLOAD_CATEGORY_RESOURCE,
  WORKLOAD_CONFIGURATION_RESOURCE,
);

const FORM_RESOURCES = resources(
  "table:member_forms",
  "table:member_form_cosigners",
  "table:form_template_registry",
  "table:member_form_files",
  "rpc:cosign_invite_preview",
);

// Union Ground acknowledges contributions without points: the Rewards
// route renders the safe-recognition summary, its voluntary rules, and the
// member's own verified events. Weekly questions and consent-based peer
// contact stay in this domain because their writes are declared against it.
const RECOGNITION_RESOURCES = resources(
  "rpc:get_member_recognition_summary",
  "table:member_recognition_rules",
  "table:member_recognition_events",
);

const REWARD_RESOURCES = resources(
  ...RECOGNITION_RESOURCES,
  "rpc:list_weekly_questions",
  "rpc:list_reward_peer_contact",
);

export const MEMBER_GUIDE_HISTORY_RESOURCES = Object.freeze(resources(
  "table:member_guide_threads",
  "table:member_guide_messages",
));

export const MEMBER_GUIDE_RESOURCES = Object.freeze(resources(
  ...MEMBER_GUIDE_HISTORY_RESOURCES,
  "rpc:list_weekly_questions",
));

export const MEMBER_SEARCH_PROJECTION_KEYS = Object.freeze([
  "cases",
  "conversations",
  "broadcasts",
  "events",
  "appointments",
  "planItems",
  "rights",
  "forms",
  "formTemplates",
  "formTemplateVersions",
  "kbArticles",
  "notifications",
  "guideThreads",
  "recognitionCatalog",
  "chapterStewards",
]);

export const MEMBER_BOARD_RESOURCES = Object.freeze(resources(
  "table:chapter_tasks", "table:chapter_workstreams",
  "rpc:list_chapter_task_dependencies", "table:chapter_task_subtasks",
  "table:chapter_task_watchers", "table:chapter_task_assignments",
));

const TASK_RESOURCES = resources(
  "table:chapter_tasks",
  "table:chapter_task_messages",
  "table:chapter_task_subtasks",
  "table:chapter_task_watchers",
  "table:chapter_task_comments",
  "table:chapter_task_attachments",
  "table:chapter_task_activity",
  "table:chapter_task_assignments",
  "table:chapter_task_files",
  "table:chapter_task_template_details",
  "table:chapter_workstreams",
  "rpc:list_chapter_task_assignees",
  "rpc:list_chapter_task_dependencies",
  "rpc:list_chapter_task_templates",
  "rpc:list_chapter_task_template_reviewers",
);

const PRODUCT_RESOURCES = resources(
  "table:chapter_spaces",
  "table:chapter_threads",
  "table:chapter_thread_posts",
  "table:member_intake_reports",
  "table:chapter_documents",
  "table:chapter_records",
  "table:chapter_handshakes",
  "table:chapter_governance_requests",
  "table:chapter_union_org_bindings",
  "table:member_kb_articles",
  "rpc:list_intake_triage_owners",
);

export const MEMBER_ROUTE_RESOURCES = Object.freeze({
  today: HOME_RESOURCES,
  // A plain member has no task conversations, so the inbox loading gate must
  // not pay for the staff-only board. createMemberSessionLoader adds the task
  // resources back after the shell has established an authorized staff role.
  messages: MESSAGE_RESOURCES,
  // My Reports renders ballot/pulse activity, rights progress, and workload
  // history in addition to its report RPCs. A cold deep-link therefore needs
  // those source rows just as an eager boot did.
  numbers: [
    ...NUMBERS_RESOURCES,
    ...VOTING_RESOURCES,
    ...RIGHTS_RESOURCES,
    ...WORKLOAD_RESOURCES,
  ],
  voting: VOTING_RESOURCES,
  voice: MEMBER_GUIDE_RESOURCES,
  cases: CASE_RESOURCES,
  rights: RIGHTS_RESOURCES,
  events: [...EVENT_RESOURCES, ...RECORD_FEED_RESOURCES],
  updates: [...EVENT_RESOURCES, ...RECORD_FEED_RESOURCES],
  appointments: resources("rpc:get_my_appointments"),
  settings: [
    ...EVENT_RESOURCES,
    ...FORM_RESOURCES,
    "rpc:get_workload_reminder_preferences",
  ],
  workload: WORKLOAD_RESOURCES,
  forms: FORM_RESOURCES,
  rewards: REWARD_RESOURCES,
  // SearchView and the global command palette both delegate their data reads
  // to buildSearchIndex. Keep its transitive consumers here, including the
  // overlay-owned Guide history and DB-backed form-template titles.
  search: [
    ...HOME_RESOURCES,
    ...MESSAGE_RESOURCES,
    ...RIGHTS_RESOURCES,
    ...PRODUCT_RESOURCES,
    ...TASK_RESOURCES,
    ...MEMBER_GUIDE_RESOURCES,
    ...FORM_RESOURCES,
    // buildSearchIndex lists the voluntary recognition rules.
    "table:member_recognition_rules",
    "rpc:get_my_appointments",
  ],
  // The alternate shell's My chapter figures count upcoming meetings and the
  // chapter's stewards, so a cold hub load reads both rather than show 0.
  hub: [...PRODUCT_RESOURCES, ...MESSAGE_RESOURCES, ...TASK_RESOURCES, ...REWARD_RESOURCES, ...EVENT_RESOURCES, "rpc:get_member_chapter_stewards"],
  tasks: [...TASK_RESOURCES, ...FORM_RESOURCES, ...MESSAGE_RESOURCES],
  // The steward and advisor workload panels name categories the way the
  // organization's applied workload configuration does.
  steward: [...TASK_RESOURCES, ...FORM_RESOURCES, ...MESSAGE_RESOURCES, ...CASE_RESOURCES, ...EVENT_RESOURCES, ...PRODUCT_RESOURCES, WORKLOAD_CONFIGURATION_RESOURCE],
  coordinator: [...TASK_RESOURCES, ...FORM_RESOURCES, ...MESSAGE_RESOURCES, ...CASE_RESOURCES, ...PRODUCT_RESOURCES],
  advisor: [...TASK_RESOURCES, ...PRODUCT_RESOURCES, ...NUMBERS_RESOURCES, WORKLOAD_CONFIGURATION_RESOURCE],
  admin: [...TASK_RESOURCES, ...PRODUCT_RESOURCES, ...NUMBERS_RESOURCES],
  // Campaigns & priorities lists the organization surveys open to the viewer.
  vp: [...TASK_RESOURCES, ...PRODUCT_RESOURCES, ...NUMBERS_RESOURCES, "rpc:get_member_engagement_snapshot"],
});

// Preserve loadMemberApp's existing failure contract: its original core reads
// throw, while additive reads expose their established unavailable/fallback
// projections. A transport failure is still recorded for every resource; only
// a required core failure without a snapshot blocks the route.
const REQUIRED_MEMBER_RESOURCES = new Set(resources(
  "table:member_profiles", "table:member_notifications",
  "table:member_conversations", "table:member_messages",
  "table:member_broadcasts", "table:member_broadcast_receipts",
  "table:member_cases", "table:member_case_updates",
  "table:member_ballots", "table:member_surveys", "table:member_survey_responses",
  "table:member_rights_lessons", "table:member_rights_progress",
  "table:member_steward_requests", "table:member_guide_threads",
  "table:member_guide_messages",
));

function routeResources(view) {
  return new Set([...SHELL_RESOURCES, ...(MEMBER_ROUTE_RESOURCES[view] ?? [])]);
}

export function memberResourcesForRoute(view, { staff = false } = {}) {
  const planned = routeResources(view);
  if (view === "messages" && staff) {
    for (const resource of TASK_RESOURCES) planned.add(resource);
  }
  return [...planned];
}

// Mutation declarations describe affected domains at the call site, never the
// page visible when an asynchronous write finishes. Domain sets deliberately
// include transitive aggregates and shell badges.
const MUTATION_DOMAINS = Object.freeze({
  bookAppointment: "appointments",
  cancelAppointment: "appointments",
  rescheduleAppointment: "appointments",
  submitEventRsvp: "events",
  checkInToEvent: "events",
  rotateCalendarFeedToken: "events",
  revokeCalendarFeedToken: "events",
  submitWeeklyQuestion: "rewards",
  boostWeeklyQuestion: "rewards",
  promoteWeeklyQuestion: "rewards",
  submitWorkloadLog: "workload",
  setWorkloadReminderPreferences: "workload",
  createChapterTask: "tasks",
  createChapterTaskFromTemplate: "tasks",
  convertChapterTaskToTemplate: "tasks",
  updateChapterTaskTemplateDetails: "tasks",
  createChapterTaskFromSource: "tasks",
  updateChapterTask: "tasks",
  setChapterTaskAssignees: "tasks",
  moveChapterTask: "tasks",
  softDeleteChapterTask: "tasks",
  restoreChapterTask: "tasks",
  createChapterTaskDependency: "tasks",
  deleteChapterTaskDependency: "tasks",
  createChapterTaskSubtask: "tasks",
  deleteChapterTaskSubtask: "tasks",
  watchChapterTask: "tasks",
  unwatchChapterTask: "tasks",
  insertChapterWorkstream: "tasks",
  sendChapterTaskMessage: "tasks",
  addChapterTaskComment: "tasks",
  addChapterTaskFile: "tasks",
  removeChapterTaskFile: "tasks",
  addChapterTaskAttachment: "tasks",
  removeChapterTaskAttachment: "tasks",
  addMemberCaseFile: "cases",
  removeMemberCaseFile: "cases",
  createMemberCase: "cases",
  updateMemberCase: "cases",
  addCaseUpdate: "cases",
  sendMemberMessage: "messages",
  startMemberConversation: "messages",
  markConversationRead: "messages",
  markBroadcastRead: "messages",
  publishMemberBroadcast: "messages",
  createChapterSpace: "hub",
  updateChapterSpaceContent: "hub",
  createChapterThread: "hub",
  sendChapterThreadPost: "hub",
  createMemberIntake: "hub",
  triageMemberIntake: "hub",
  convertMemberIntake: "hub",
  createChapterDocument: "hub",
  updateChapterDocumentContent: "hub",
  saveChapterKnowledgeArticle: "hub",
  retireChapterKnowledgeArticle: "hub",
  createChapterRecord: "hub",
  updateChapterRecordContent: "hub",
  createChapterHandshake: "hub",
  updateChapterHandshakeStatus: "hub",
  createGovernanceRequest: "hub",
  saveFormDraft: "forms",
  submitForm: "forms",
  discardFormDraft: "forms",
  signMemberForm: "forms",
  addMemberFormFile: "forms",
  removeMemberFormFile: "forms",
  inviteCosigner: "forms",
  respondToCosign: "forms",
  withdrawCosign: "forms",
  updateMemberSettings: "shell",
  updateMemberProfile: "shell",
  markNotificationsRead: "shell",
  submitBallot: "voting",
  submitSurvey: "voting",
  saveRightsProgress: "rights",
  requestSteward: "rights",
  saveGuideExchange: "voice",
});

export function memberMutationResources(...operations) {
  const names = new Set([...SHELL_RESOURCES, ...SHARED_MUTATION_RESOURCES]);
  for (const operation of operations) {
    const domain = MUTATION_DOMAINS[operation];
    if (!domain) throw new Error(`Missing member mutation resource declaration: ${operation}`);
    for (const resource of MEMBER_ROUTE_RESOURCES[domain] ?? []) names.add(resource);
  }
  return [...names];
}

function stableKey(resource, calls) {
  return JSON.stringify([resource, calls]);
}

function createQueue(limit) {
  let active = 0;
  const waiting = [];
  const drain = () => {
    while (active < limit && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    drain();
  });
}

function executeQuery(client, table, calls) {
  let query = client.from(table);
  for (const [method, args] of calls) query = query[method](...args);
  if (table === "chapter_governance_requests") {
    // Data rights must settle before the whole-route deadline. Bound the
    // transport inside the registry so timeout is a cached, retryable failure,
    // and a late response cannot overwrite the next request's snapshot.
    const controller = new AbortController();
    return withLoadDeadline(Promise.resolve(query.abortSignal(controller.signal)), 5_000)
      .finally(() => controller.abort());
  }
  return Promise.resolve(query);
}

// The registry owns transport state, independently of navigation. Query variants
// (for example one tally per ballot) live inside their resource's epoch.
function scopedClient(allowed, read, auth) {
  return {
    // The sealed-form transport (sensitiveContentRpc) bears the member's own
    // session token, so the scoped client forwards that one read of the
    // underlying client and nothing else of its auth surface (#5827 final).
    auth: { getSession: () => auth.getSession() },
    from(table) {
      const resource = `table:${table}`;
      const calls = [];
      let proxy;
      proxy = new Proxy(function queryBuilder() {}, {
        get(_target, property) {
          if (["then", "catch", "finally"].includes(property)) {
            const promise = read(resource, calls, allowed);
            return promise[property].bind(promise);
          }
          return (...args) => { calls.push([property, args]); return proxy; };
        },
      });
      return proxy;
    },
    rpc(name, args) {
      return read(`rpc:${name}`, [["rpc", [args ?? null]]], allowed);
    },
  };
}

export function createMemberSessionLoader(client, user, {
  concurrency = MEMBER_REQUEST_CONCURRENCY,
  now = Date.now,
  nowMs,
  isCurrent = () => true,
  loadDeadlineMs = SHELL_LOAD_DEADLINE_MS,
} = {}) {
  if (!client || !user?.id) throw new Error("A Supabase client and member identity are required");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Member request concurrency must be an integer from 1 through 8");
  }
  let disposed = false;
  const active = () => !disposed && isCurrent();
  const registry = new Map();
  const listeners = new Set();
  const confirmations = new Map();
  let revision = 0;
  let liveSequence = 0;
  let projectionStartedAt = null;
  let projectionWatch = null;
  let ballotPublicationWatch = null;
  let ballotPublicationRetries = 0;
  let engagementSnapshotCheckedAt = null;
  let projectedRoles = [];
  const schedule = createQueue(concurrency);
  const currentTime = nowMs == null ? now : () => nowMs;
  if (typeof currentTime !== "function") throw new Error("Member loader clock must be a function");
  // Transport predicates are session-stable; projections always use today's clock.
  const queryNowMs = currentTime();
  const bootstrapKeys = new Map(Object.entries(memberHomeBootstrapQueries(user.id, queryNowMs))
    .map(([resource, calls]) => [resource, stableKey(resource, calls)]));
  // One failed or foreign bootstrap payload ends batching for this loader: the
  // reads it could not serve issue their own requests, as before the batch.
  let bootstrapDisabled = false;
  const changed = () => { if (!active()) return; revision += 1; for (const listener of listeners) listener(); };
  const clearProjectionWatch = () => {
    if (projectionWatch == null) return;
    globalThis.clearTimeout(projectionWatch);
    projectionWatch = null;
  };
  const clearRequestWatch = (request) => {
    if (request.watch == null) return;
    globalThis.clearTimeout(request.watch);
    request.watch = null;
  };
  const clearBallotPublicationWatch = () => {
    if (ballotPublicationWatch == null) return;
    globalThis.clearTimeout(ballotPublicationWatch);
    ballotPublicationWatch = null;
  };
  const VOTING_PUBLICATION_RESOURCES = ["table:member_ballots", "rpc:get_ballot_tally"];
  const BALLOT_PUBLICATION_RETRY_MS = 30 * 1000;
  const BALLOT_PUBLICATION_RETRY_LIMIT = 6;
  const armBallotPublicationWatch = (projection) => {
    // Clock close mutates nothing, so a member who already has Voting (or Home)
    // open never hears a row change. Refetch the tally at the soonest remaining
    // close; a later `vote.*` notification also invalidates these resources.
    clearBallotPublicationWatch();
    const items = Array.isArray(projection?.planItems) ? projection.planItems : [];
    const now = currentTime();
    let soonest = null;
    // `results` is the server's own publication decision. A device clock ahead
    // of the database marks an item closed while the tally is still withheld,
    // and that item arms no close watch — so keep a bounded retry running until
    // the server actually publishes, rather than waiting on the sweep notice.
    let awaitingPublication = false;
    for (const item of items) {
      if (item?.kind !== "ballot") continue;
      const closes = Date.parse(item.closesAt ?? item.closes_at ?? "");
      // A close already in the past arms the bounded retry, not a 0 ms watch
      // that would refetch in a tight loop while the item still reads open.
      if (item.closed || closes <= now) {
        if (!item.results) awaitingPublication = true;
        continue;
      }
      if (!Number.isFinite(closes)) continue;
      if (soonest == null || closes < soonest) soonest = closes;
    }
    if (!awaitingPublication) ballotPublicationRetries = 0;
    let delay = soonest == null ? null : Math.max(0, Math.min(soonest - now + 50, 60 * 60 * 1000));
    if (awaitingPublication && ballotPublicationRetries < BALLOT_PUBLICATION_RETRY_LIMIT) {
      ballotPublicationRetries += 1;
      delay = delay == null ? BALLOT_PUBLICATION_RETRY_MS : Math.min(delay, BALLOT_PUBLICATION_RETRY_MS);
    }
    if (delay == null) return;
    ballotPublicationWatch = globalThis.setTimeout(() => {
      ballotPublicationWatch = null;
      if (!active()) return;
      invalidateResources(VOTING_PUBLICATION_RESOURCES);
    }, delay);
  };
  const armProjectionWatch = () => {
    if (projectionWatch != null || !Number.isFinite(loadDeadlineMs) || loadDeadlineMs <= 0) return;
    projectionWatch = globalThis.setTimeout(() => {
      projectionWatch = null;
      changed();
    }, loadDeadlineMs);
  };
  const entryFor = (resource) => {
    if (!registry.has(resource)) registry.set(resource, {
      epoch: 0, status: "idle", snapshot: new Map(), failure: null,
      requests: new Map(), live: new Map(), confirmedRows: null, ready: false,
    });
    return registry.get(resource);
  };
  const updateStatus = (entry) => {
    const requests = [...entry.requests.values()];
    entry.failure = requests.find((request) => request.failure && !request.withdrawn)?.failure ?? null;
    entry.status = requests.some((request) => request.status === "loading") ? "loading"
      : entry.failure ? "error" : "loaded";
  };
  const resourcesForSessionRoute = (view) => {
    const staff = projectedRoles.some((role) => STAFF_TOOL_ROLES.includes(role));
    return new Set(memberResourcesForRoute(view, { staff }));
  };
  // Notifications have read_at rather than updated_at. A delayed INSERT can
  // carry the original unread row after a reconciliation saw it marked read.
  // Browser read_at can precede database created_at under clock skew: taking
  // the latest timestamp keeps a read from lowering the row version.
  // Equal/unknown versions keep the authoritative snapshot, not arrival order.
  const rowVersion = (row) => Math.max(0, ...[
    row?.updated_at ?? row?.updatedAt,
    row?.read_at,
    row?.created_at ?? row?.createdAt,
  ].map((value) => Date.parse(value ?? "")).filter(Number.isFinite));
  const withLive = (entry, result, after) => {
    if (!Array.isArray(result.data) || !entry.live.size) return result;
    const rows = new Map(result.data.map((row) => [row.id, row]));
    for (const { row, sequence, deleted, authoritative } of entry.live.values()) {
      if (sequence <= after) continue;
      const previous = rows.get(row.id);
      if (deleted) rows.delete(row.id);
      else if (!previous || rowVersion(row) > rowVersion(previous)
        || (authoritative && rowVersion(row) === rowVersion(previous))) rows.set(row.id, row);
    }
    return { ...result, data: [...rows.values()] };
  };
  // A bootstrap batch that cannot serve a request it registered resolves it
  // with this marker: the request is withdrawn and the reads awaiting it see
  // a replaced request, so each issues its own.
  const WITHDRAWN = Symbol("bootstrap-withdrawn");
  const startRequest = (resource, key, run, retried = false) => {
    const entry = entryFor(resource);
    const epoch = entry.epoch;
    const startedAt = liveSequence;
    const request = { status: "loading", failure: null, promise: null, retried, requestedAt: currentTime(), watch: null };
    entry.requests.set(key, request);
    entry.status = "loading";
    // BUG #6799: the route deadline must follow the read, not the projection
    // pass. Every re-projection restarts projectionStartedAt while joining
    // this same in-flight request, so a render after the first timeout fell
    // back to "loading" and no later notice arrived. A request's age only ends
    // when it settles or is invalidated, and its own watch re-renders the route.
    if (Number.isFinite(loadDeadlineMs) && loadDeadlineMs > 0) {
      request.watch = globalThis.setTimeout(() => {
        request.watch = null;
        if (request.status === "loading") changed();
      }, loadDeadlineMs);
    }
    request.promise = Promise.resolve(run())
      .catch((error) => ({ data: null, error }))
      .then((result) => {
        clearRequestWatch(request);
        // Navigation never supersedes resource ownership. Only invalidation
        // can advance this epoch; old responses cannot erase newer requests.
        if (!active() || entry.epoch !== epoch) return result;
        if (result === WITHDRAWN) {
          // Within one epoch nothing else replaces a batch request, so this
          // request is still the resource's only one: it leaves as if the
          // resource had never been asked for.
          entry.requests.delete(key);
          entry.status = entry.ready ? "loaded" : "idle";
          return result;
        }
        request.failure = result?.error ?? null;
        request.httpStatus = result?.status;
        request.status = request.failure ? "error" : "loaded";
        if (request.failure) {
          captureSanitizedDiagnostic({
            kind: "member_session_resource_failure",
            resource,
            code: request.failure.code,
            name: request.failure.name,
          });
        }
        if (!request.failure) {
          entry.snapshot.set(key, withLive(entry, result, startedAt));
          entry.confirmedRows = null;
          entry.ready = true;
          for (const [id, event] of entry.live) if (event.sequence <= startedAt) entry.live.delete(id);
        }
        updateStatus(entry);
        changed();
        return result;
      });
    changed();
    return request;
  };
  // PERF-UG-COLD-HOME-BOOTSTRAP-ONE-CALL-20261028. When a projection pass
  // needs at least two covered reads that have no request in their current
  // epoch, one get_member_home_bootstrap call fetches every idle covered
  // resource (and only those) and registers a request for each under its canonical
  // query key, so the pass's own reads (and a later Home pass) join those
  // requests instead of issuing eighteen. A read with any other query shape
  // never matches a registered key and goes to its own table. Per-resource
  // epochs, live overlay and invalidation apply to each registered request
  // exactly as to a direct read; a failed call or a payload that is not this
  // member's withdraws them all and ends batching for this loader.
  const issueBootstrap = (allowed) => {
    if (bootstrapDisabled || !active()) return;
    const idle = [...bootstrapKeys.keys()].filter((resource) => entryFor(resource).requests.size === 0);
    if (idle.filter((resource) => allowed.has(resource)).length < 2) return;
    const batch = schedule(() => !active() ? { data: null, error: null }
      : client.rpc(MEMBER_HOME_BOOTSTRAP_RPC, memberHomeBootstrapArguments(queryNowMs, idle)))
      .catch((error) => ({ data: null, error }))
      .then((result) => {
        if (!active()) return null;
        const payload = result?.error ? null : result?.data;
        if (idle.every((resource) => memberHomeBootstrapRows(payload, resource, user.id))) return payload;
        bootstrapDisabled = true;
        const failure = result?.error ?? { code: "payload", name: "MemberHomeBootstrapPayload" };
        captureSanitizedDiagnostic({
          kind: "member_home_bootstrap_fallback",
          resource: MEMBER_HOME_BOOTSTRAP_RESOURCE,
          code: failure.code,
          name: failure.name,
        });
        return null;
      });
    for (const resource of idle) {
      startRequest(resource, bootstrapKeys.get(resource), () => batch.then((payload) => {
        const rows = memberHomeBootstrapRows(payload, resource, user.id);
        return rows ? { data: rows, error: null } : WITHDRAWN;
      }));
    }
  };
  const read = async (resource, calls, allowed, retried = false) => {
    if (!active()) return { data: null, error: null };
    const entry = entryFor(resource);
    const key = stableKey(resource, calls);
    // A successful local write is usable even before the first successful
    // read. Keep that evidence separate from authoritative query snapshots.
    const snapshot = () => entry.snapshot.get(key)
      ?? (entry.confirmedRows === null ? null : { data: entry.confirmedRows, error: null });
    // An unrelated projection can consume last-good overlay data, but cannot
    // initiate its requests or inherit its errors.
    if (!allowed.has(resource)) return snapshot()
      ? { ...snapshot(), refreshFailure: entry.failure, freshness: "retained" }
      : { data: resource.startsWith("rpc:") ? null : [], error: null };
    let request = entry.requests.get(key);
    if (!request) {
      request = startRequest(resource, key, () => schedule(() => !active() ? { data: null, error: null } : resource.startsWith("table:")
        ? executeQuery(client, resource.slice(6), calls)
        : client.rpc(resource.slice(4), calls[0][1][0] ?? undefined)), retried);
    }
    await request.promise;
    if (!active()) return { data: null, error: null };
    // If invalidated during the read, join the new epoch (one attempt per
    // query variant); never hand an older response to a projection.
    if (entry.requests.get(key) !== request) return read(resource, calls, allowed);
    // A schema-compatibility probe (eventSchemaCompatibility.js) answers this
    // failure with its own retry. Withdrawing it keeps a recovered probe from
    // surfacing as a route refresh failure ("Load failed") while the retry's
    // own outcome still counts. Non-enumerable: the result shape is unchanged.
    const withdraw = () => {
      if (entry.requests.get(key) !== request || !request.failure || request.withdrawn) return;
      request.withdrawn = true;
      updateStatus(entry);
    };
    if (snapshot()) {
      const retained = { ...snapshot(), refreshFailure: request.failure, freshness: request.failure ? "retained" : "fresh" };
      // A failed refresh that kept earlier rows can be
      // withdrawn too (the member's own task assignments), as a first failure can.
      if (request.failure) Object.defineProperty(retained, "withdraw", { value: withdraw });
      return retained;
    }
    const failed = { data: null, error: request.failure, status: request.httpStatus, refreshFailure: request.failure };
    // An explicit transient-read retry can replace this failed query once per
    // epoch. Concurrent consumers join its replacement; later projection
    // passes retain the exhausted failure instead of starting a retry storm.
    // An old callback joins the current epoch without evicting its request.
    Object.defineProperty(failed, "retry", { value: () => {
      if (entry.requests.get(key) === request && request.failure && !request.retried) {
        entry.requests.delete(key);
        return read(resource, calls, allowed, true);
      }
      return read(resource, calls, allowed);
    } });
    Object.defineProperty(failed, "withdraw", { value: withdraw });
    return failed;
  };
  const invalidateResources = (names) => {
    if (!active()) return;
    for (const resource of new Set(names)) {
      const entry = entryFor(resource);
      entry.epoch += 1;
      // Skipped resources have no request to invalidate. Their known-empty
      // readiness belongs to this identity; the next projection still
      // evaluates role/row predicates and starts any newly needed read.
      entry.status = entry.ready && entry.requests.size === 0 ? "loaded" : "idle";
      entry.failure = null;
      for (const request of entry.requests.values()) clearRequestWatch(request);
      entry.requests.clear();
    }
    changed();
  };
  const hasAuthority = confirmation => confirmation.resources.every(resource => {
    const entry = entryFor(resource);
    return entry.status === "loaded" && entry.snapshot.size > 0 && entry.requests.size > 0
      && [...entry.requests.values()].every(request => request.status === "loaded");
  });
  const load = async (allowed) => {
    projectionStartedAt = currentTime();
    armProjectionWatch();
    issueBootstrap(allowed);
    try {
      return await withLoadDeadline((async () => {
        // Every pass projects the same registry. If a completion, invalidation or
        // live event changes it mid-projection, project again from current epochs.
        // Settled errors stay cached unless a read helper explicitly consumes
        // its single retry; projection passes cannot replenish that budget.
        for (;;) {
          if (!active()) return null;
          const before = revision;
          let projection;
          let failure;
          try {
            projection = await loadMemberApp(scopedClient(allowed, read, client.auth), user, { nowMs: currentTime(), queryNowMs });
          } catch (error) { failure = error; }
          if (!active()) return null;
          if (before !== revision && !failure) continue;
          // Role/row-dependent reads that the plan didn't execute are settled
          // empty resources, not permanently pending route markers.
          for (const resource of allowed) {
            const entry = entryFor(resource);
            if (entry.status === "idle") entry.status = "loaded";
            if (!failure) {
              // Additive failures have an established usable fallback too. A
              // background retry must not unmount a route that already rendered.
              if (entry.status === "loaded" || !REQUIRED_MEMBER_RESOURCES.has(resource)) entry.ready = true;
            }
          }
          if (failure) throw failure;
          if (before !== revision) continue;
          // Retained rows are usable content, never proof of a fresh read. Each
          // confirmation belongs to this session and expires only after all its
          // source resources complete a successful read in the confirming epoch.
          for (const [id, confirmation] of confirmations) {
            if (hasAuthority(confirmation)) confirmations.delete(id);
            else for (const apply of confirmation.writes) projection = apply(projection);
          }
          const nextProjection = { ...projection, resourceRefreshFailures: [...registry].flatMap(([resource, entry]) =>
            entry.failure ? [{ resource, retained: entry.snapshot.size > 0 || entry.confirmedRows !== null, message: entry.failure.message }] : []) };
          projectedRoles = Array.isArray(nextProjection.roles) ? nextProjection.roles : [];
          armBallotPublicationWatch(nextProjection);
          return nextProjection;
        }
      })(), loadDeadlineMs);
    } finally {
      // Success, a settled transport error, and the shared deadline are all
      // terminal. Leaving the watch armed after a reject lets it bump revision
      // later, which re-enters load() against the cached failure.
      clearProjectionWatch();
    }
  };
  const confirmRows = (resource, apply) => {
    if (!active()) return;
    invalidateResources([resource]);
    const entry = entryFor(resource);
    entry.confirmedRows = apply(entry.confirmedRows ?? []);
    for (const [key, snapshot] of entry.snapshot) {
      entry.snapshot.set(key, { ...snapshot, data: apply(snapshot.data ?? []) });
    }
    changed();
  };
  return {
    userId: user.id,
    dispose() {
      disposed = true; clearProjectionWatch(); clearBallotPublicationWatch();
      for (const entry of registry.values()) for (const request of entry.requests.values()) clearRequestWatch(request);
      registry.clear(); listeners.clear(); confirmations.clear();
    },
    get revision() { return revision; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    inspect() {
      return new Map([...registry].map(([resource, entry]) => [resource, {
        epoch: entry.epoch, status: entry.status, snapshot: new Map(entry.snapshot), failure: entry.failure,
      }]));
    },
    stateForRoute(view) {
      const resources = [...resourcesForSessionRoute(view)].map((resource) => ({ resource, entry: entryFor(resource) }));
      const missing = resources.filter(({ entry }) => !entry.ready && entry.snapshot.size === 0 && entry.confirmedRows === null);
      const error = missing.find(({ resource, entry }) => REQUIRED_MEMBER_RESOURCES.has(resource) && entry.status === "error");
      const refreshFailure = resources.find(({ entry }) => (entry.snapshot.size > 0 || entry.confirmedRows !== null) && entry.failure);
      const loading = missing.some(({ entry }) => ["idle", "loading"].includes(entry.status));
      const now = currentTime();
      // A route read that has been in flight past the deadline keeps the route
      // timed out across re-projections; only its answer or Try again (which
      // invalidates it) ends that state.
      const readStalled = missing.some(({ entry }) => [...entry.requests.values()]
        .some((request) => request.status === "loading" && now - request.requestedAt >= loadDeadlineMs));
      const timedOut = loading && (readStalled
        || (projectionStartedAt != null && now - projectionStartedAt >= loadDeadlineMs));
      return { status: timedOut || error ? "error" : loading ? "loading" : "loaded",
        error: timedOut ? "Request timed out" : error?.entry.failure?.message ?? "",
        refreshError: refreshFailure?.entry.failure?.message ?? "" };
    },
    failuresForResources(names) {
      return [...new Set(names)].flatMap(resource => {
        const failure = registry.get(resource)?.failure;
        return failure ? [{ resource, failure }] : [];
      });
    },
    retryFailedResources(names) {
      const failed = [...new Set(names)].filter(resource => registry.get(resource)?.status === "error");
      if (failed.length) invalidateResources(failed);
    },
    reconcileBoard() {
      invalidateResources(MEMBER_BOARD_RESOURCES);
      return load(new Set(MEMBER_BOARD_RESOURCES));
    },
    invalidateAll() { invalidateResources(registry.keys()); },
    invalidateResources,
    confirmProjection(id, resources, apply) {
      if (!active()) return;
      const retained = confirmations.get(id);
      const previous = retained && !hasAuthority(retained) ? retained : null;
      invalidateResources(resources);
      // A later update must see the retained insertion, even when the query
      // snapshot is empty. Replay saved writes in order until authority
      // replaces them; a saved deletion therefore also follows its insertion.
      confirmations.set(id, {
        resources: [...new Set([...(previous?.resources ?? []), ...resources])],
        writes: [...(previous?.writes ?? []), apply],
      });
      changed();
    },
    confirmRows,
    confirmRightsProgress(lessonId, completedSteps) {
      confirmRows("table:member_rights_progress", rows => [
        ...rows.filter(row => row.lesson_id !== lessonId),
        { lesson_id: lessonId, completed_steps: [...completedSteps] },
      ]);
    },
    noteLive(resource, row, { deleted = false, authoritative = false } = {}) {
      if (!active() || !row?.id) return false;
      const entry = entryFor(resource);
      const previous = [entry.live.get(row.id)?.row, ...[...entry.snapshot.values()]
        .flatMap((result) => Array.isArray(result.data) ? result.data.filter((item) => item.id === row.id) : [])];
      if (previous.some((item) => item && (rowVersion(row) < rowVersion(item) || (!authoritative && rowVersion(row) === rowVersion(item))))) return false;
      entry.live.set(row.id, { row, sequence: ++liveSequence, deleted, authoritative });
      for (const [key, snapshot] of entry.snapshot) entry.snapshot.set(key, withLive(entry, snapshot, liveSequence - 1));
      changed();
      // vote.opened / vote.closing / vote.results share kind `votes`. Clock
      // close itself writes no ballot row, so the results notice is the live
      // signal that the tally gate has opened for a member already looking.
      if (resource === "table:member_notifications" && !deleted && row.kind === "votes") {
        invalidateResources(VOTING_PUBLICATION_RESOURCES);
      }
      if (resource === "table:member_notifications" && !deleted && notificationRefreshResources(row).length) {
        invalidateResources(notificationRefreshResources(row));
      }
      return true;
    },
    loadShell() { return load(new Set(SHELL_RESOURCES)); },
    resourcesForRoute(view) { return [...resourcesForSessionRoute(view)]; },
    async loadRoute(view, { force = false } = {}) {
      const allowed = resourcesForSessionRoute(view);
      if (force) invalidateResources([...allowed, ...SHARED_MUTATION_RESOURCES]);
      // The engagement snapshot lists the surveys open now; a survey that
      // opens on schedule after it was cached would otherwise stay missing
      // until something invalidates it (gate r3s1 on #8260). A route that
      // plans it reads it again once it is older than its bound.
      if (allowed.has(ENGAGEMENT_SNAPSHOT_RESOURCE)) {
        const checked = currentTime();
        if (engagementSnapshotCheckedAt != null && checked - engagementSnapshotCheckedAt >= ENGAGEMENT_SNAPSHOT_MAX_AGE_MS) {
          invalidateResources([ENGAGEMENT_SNAPSHOT_RESOURCE]);
          engagementSnapshotCheckedAt = checked;
        } else if (engagementSnapshotCheckedAt == null) engagementSnapshotCheckedAt = checked;
      }
      const projection = await load(allowed);
      // A direct Messages entry can establish the staff role during this same
      // projection. Complete the staff-only task slice before returning in
      // that case; a plain member keeps the smaller loading gate.
      const established = resourcesForSessionRoute(view);
      if ([...established].some((resource) => !allowed.has(resource))) return load(established);
      return projection;
    },
    async reconcileRealtime() {
      const names = ["table:member_notifications", "table:chapter_task_messages"];
      invalidateResources(names);
      for (;;) {
        if (!active()) return null;
        const before = revision;
        const gap = await loadMemberRealtimeGap(scopedClient(new Set(names), read, client.auth), user.id, { queryNowMs });
        if (!active()) return null;
        if (before === revision) return gap;
      }
    },
  };
}

// #7027: the member resources to re-read after an undo took back your own My
// Reports layout or workload reminder (the kinds the practice history names).
export function learningUndoMemberResources(kinds) {
  const resources = new Set();
  if (kinds.includes("own_report_preferences")) resources.add("rpc:get_my_report_preferences");
  if (kinds.includes("own_workload_reminder")) for (const resource of memberMutationResources("setWorkloadReminderPreferences")) resources.add(resource);
  return [...resources];
}
