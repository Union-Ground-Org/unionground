// PERF-UG-COLD-HOME-BOOTSTRAP-ONE-CALL-20261028
//
// The eighteen plain cold-Home table reads that public.get_member_home_bootstrap
// returns in one call (supabase/migrations/20261028150000_member_home_bootstrap.sql).
// Each entry is the exact query chain loadMemberApp (memberApi.js) issues for
// that table, in the form the session loader records it: [method, args] pairs.
// The loader serves a read from the batch only when its chain equals the one
// registered here, so a changed select, filter, order or limit in memberApi.js
// stops matching and falls back to that table's own read. The budget test then
// fails the operation count, which is the signal to change all three together:
// memberApi.js, this file and the SQL function (whose database proof replays
// these chains through PostgREST and compares the rows).
const ACTION_LOG_WINDOW_MS = 7 * 86400000;

export const MEMBER_HOME_BOOTSTRAP_RPC = "get_member_home_bootstrap";
export const MEMBER_HOME_BOOTSTRAP_RESOURCE = `rpc:${MEMBER_HOME_BOOTSTRAP_RPC}`;

const MEMBER_CASE_COLUMNS = "id,user_id,reference,title,deadline,case_type,articles,step,status,created_at,updated_at,steward_name,coordinator_name,time_zone";
// The option embeds are assembled, not written as `table(columns)`:
// tests/quorum-composite-fk.test.js allows exactly one literal ballots->options
// and surveys->options embed in the source tree, the parent read in
// memberApi.js. The assembled string is byte-equal to that read's select, and
// the budget test's drift guard proves it against the chain memberApi issues.
const embed = (table, columns) => `${table}(${columns})`;
const MEMBER_BALLOT_COLUMNS = `id,title,title_es,body,body_es,closes_at,active,order_index,quorum_target,chapter_id,campaign_state,published_at,closed_at,${embed("member_ballot_options", "id,ballot_id,label,label_es,order_index")}`;
const MEMBER_SURVEY_COLUMNS = `id,title,title_es,body,body_es,closes_at,active,order_index,chapter_id,campaign_state,published_at,closed_at,${embed("member_survey_options", "id,survey_id,label,label_es,order_index")}`;

const actionLogSince = (queryNowMs) => new Date(queryNowMs - ACTION_LOG_WINDOW_MS).toISOString();
const tableName = (resource) => resource.slice("table:".length);

// The call fetches only the resources named in p_resources, so a refresh
// that needs five reads does not pay for eighteen.
export function memberHomeBootstrapArguments(queryNowMs, resources) {
  return { p_action_log_since: actionLogSince(queryNowMs), p_resources: resources.map(tableName) };
}

// The resources a call asked for, read back from its arguments (test backends
// answer only those, as the function does).
export function memberHomeBootstrapRequested(args) {
  return (Array.isArray(args?.p_resources) ? args.p_resources : []).map((name) => `table:${name}`);
}

export function memberHomeBootstrapQueries(userId, queryNowMs) {
  const self = ["eq", ["user_id", userId]];
  const since = actionLogSince(queryNowMs);
  return {
    // The member loader bounds this newest-first read at 200 rows; the batch
    // returns up to 1000 newest first, and memberHomeBootstrapRows keeps the
    // first 200, so a batched read answers exactly what the direct read would.
    "table:member_notifications": [["select", ["*"]], self, ["order", ["created_at", { ascending: false }]], ["limit", [200]]],
    "table:member_roles": [["select", ["role"]], self],
    "table:chapters": [["select", ["id,name"]], ["order", ["order_index"]]],
    // Bounded at 200 newest first like the loader's read (the batch returns up
    // to 1000 newest first and is sliced to the bound).
    "table:member_cases": [["select", [MEMBER_CASE_COLUMNS]], self, ["order", ["updated_at", { ascending: false }]], ["limit", [200]]],
    // member_case_updates is not batched: the loader reads the newest 1000
    // (so a long history never loses its latest notes), while the batch
    // function returns the oldest 1000; the loader's own read answers it.
    "table:member_broadcasts": [["select", ["id,sender,title,body,published_at,locale,audience_scope"]], ["is", ["retracted_at", null]], ["order", ["published_at", { ascending: false }]], ["limit", [50]]],
    "table:member_broadcast_receipts": [["select", ["broadcast_id,read_at"]], self],
    "table:member_ballots": [["select", [MEMBER_BALLOT_COLUMNS]], ["order", ["order_index"]]],
    "table:member_surveys": [["select", [MEMBER_SURVEY_COLUMNS]], ["order", ["order_index"]]],
    "table:member_survey_responses": [["select", ["survey_id,option_id"]], self],
    "table:member_rights_lessons": [["select", ["*"]], ["order", ["order_index"]]],
    "table:member_rights_progress": [["select", ["lesson_id,completed_steps"]], self],
    "table:member_action_log": [["select", ["action_key,action_kind,occurred_at"]], self, ["gte", ["occurred_at", since]], ["order", ["occurred_at"]]],
    "table:member_ballot_receipts": [["select", ["ballot_id,receipt_code,issued_at"]], self],
    "table:member_event_rsvps": [["select", ["event_id,status"]], self],
    "table:member_event_checkins": [["select", ["event_id"]], self],
    "table:member_point_rules": [["select", ["action_kind,label,points,weekly_cap"]], ["order", ["points", { ascending: false }]]],
    "table:member_reward_tiers": [["select", ["tier,name,min_points"]], ["order", ["tier"]]],
  };
}

export const MEMBER_HOME_BOOTSTRAP_RESOURCES = Object.freeze(Object.keys(memberHomeBootstrapQueries("", 0)));

// Each batched resource's client row bound, read from its own query.
const QUERY_LIMITS = Object.freeze(Object.fromEntries(Object.entries(memberHomeBootstrapQueries("", 0))
  .flatMap(([resource, calls]) => calls.filter(([method]) => method === "limit").map(([, [count]]) => [resource, count]))));

// The rows the payload holds for one resource, or null when the payload is not
// this member's or does not carry that array. Null means "read it yourself".
export function memberHomeBootstrapRows(payload, resource, userId) {
  if (payload?.user_id !== userId) return null;
  const rows = payload[tableName(resource)];
  if (!Array.isArray(rows)) return null;
  const limit = QUERY_LIMITS[resource];
  return limit ? rows.slice(0, limit) : rows;
}
