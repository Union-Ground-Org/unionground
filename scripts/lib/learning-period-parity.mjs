// REQ-UG-LEARNING-PERIOD-ENGINE-20261103 (#6940): the learning
// period parity check. A table becomes "covered" when a learning_action_kinds
// row names it. Every function that writes a covered table must journal the
// write through private.learning_journal_append with a kind registered for
// that table, and no client role may keep a direct INSERT, UPDATE or DELETE
// grant on it (a direct write could never be journalled). The engine itself
// and the reversing handlers are the only exceptions.
import { readdirSync, readFileSync } from "node:fs";
import { parseFunctions } from "../account-case-graph-inventory.mjs";
import { maskSqlCommentsAndLiterals, stripSqlComments } from "./sql-text.mjs";

const KINDS_INSERT = /insert\s+into\s+private\.learning_action_kinds\s*\(([^)]*)\)\s*values\s*/gi;

// The statement's values up to its closing semicolon, outside quoted text.
function statementValues(sql, from) {
  let quoted = false;
  for (let index = from; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'") {
      if (quoted && sql[index + 1] === "'") { index += 1; continue; }
      quoted = !quoted;
    } else if (char === ";" && !quoted) return sql.slice(from, index);
  }
  return sql.slice(from);
}
const ENGINE = new Set([
  "private.learning_journal_append",
  "private.close_learning_period",
  "private.finish_learning_period",
  "public.undo_my_learning_action",
  // Slice 6 (20261104111500): the close step's finishing of held revokes.
  "private.learning_finish_held_messages",
]);

// Writers that never act for a person, so there is nobody whose practice
// action they could be: automations (preview-only during a period from slice
// 6 on), retention and purge jobs, derived-column refreshes, and the
// operator-run demo and production-residue seeders. Each needs a reason.
export const SYSTEM_WRITERS = Object.freeze({
  "private.automation_v2_execute": "Organization automation run, not a person's action.",
  "private.automation_v2_rollback_actions": "Organization automation rollback, not a person's action.",
  "private.cr108_execute_run": "Organization automation run, not a person's action.",
  "public.rollback_organization_automation_run": "Organization automation rollback, not a person's action.",
  "private.issue_new_member_starter_items": "System onboarding items for a new member.",
  "private.perform_organization_retention_run": "Retention job.",
  "private.purge_deleted_chapter_tasks": "The 90-day purge of deleted tasks.",
  "private.refresh_task_assignee_names": "Refreshes a derived display name.",
  "public.presg_demo_remove_batch": "Operator-run demo seed removal.",
  "public.presg_demo_seed_channels": "Operator-run demo seed.",
  "public.uniondemo_remove_batch": "Operator-run demo seed removal.",
  "public.uniondemo_seed_channels": "Operator-run demo seed.",
  "public.production_residue_remove_batch": "Operator-run production residue removal.",
  // Task file bookkeeping: an upload is journalled when it is confirmed and
  // becomes visible, never while it is still pending or aborted; the
  // reconciler and finalizer finish removals someone already requested.
  "public.begin_chapter_task_file_upload": "Reserves a pending upload that nobody sees until it is confirmed.",
  "public.abort_chapter_task_file_upload": "Discards the caller's own pending upload that never became visible.",
  "public.reconcile_chapter_task_files": "File reconciler run by the service, finishing requested removals.",
  "public.finalize_chapter_task_file_removal": "Finalizer run by the service after the bytes are destroyed.",
  // Board structure, not a change to one task: these rename or fold a whole
  // workstream across every card in it. Renaming back is the remedy, and the
  // merge is deliberately irreversible behind its own confirmation.
  "public.rename_chapter_workstream": "Renames a workstream on every card in it; renaming back is the remedy.",
  "public.merge_chapter_workstreams": "Folds one workstream into another behind its own confirmation; irreversible by design.",
  // Cases (20261104075000): the deadline-notice sweep stamps a notice it
  // sent; the demo, seed and stress tools are operator-run; case file
  // bookkeeping mirrors the task files'; the sensitive envelope is key
  // handling, which the design excludes from undo.
  "private.case_deadline_notice_sweep": "Deadline-notice sweep stamping the notice it sent.",
  "private.demo_seed_apply_casework": "Operator-run demo seed.",
  "private.demo_seed_apply_function_parity": "Operator-run demo seed.",
  "private.demo_seed_remove_casework": "Operator-run demo seed removal.",
  "public.member_stress_enrich_batch": "Operator-run stress fixture.",
  // Membership, roles and settings (#6946).
  "private.handle_new_member": "Creates a new account's profile and first chapter at sign-up.",
  "private.finalize_due_chapter_leadership_claims": "Scheduled job finishing chapter leadership claims whose waiting period ended.",
  "private.scim_revoke_organization_membership": "SCIM deprovisioning sent by the organization's identity provider; SCIM is excluded from undo.",
  "public.apply_engagement_email_unsubscribe": "A one-click email unsubscribe link, followed without a signed-in session.",
  "public.presg_demo_apply_batch": "Operator-run demo seed.",
  "public.presg_demo_enrich_batch": "Operator-run demo seed.",
  "public.uniondemo_apply_batch": "Operator-run demo seed.",
  "public.uniondemo_enrich_batch": "Operator-run demo seed.",
  "private.demo_seed_apply_analytics": "Operator-run demo seed.",
  "private.demo_seed_remove_analytics": "Operator-run demo seed removal.",
  "private.demo_seed_apply_auth_operations": "Operator-run demo seed.",
  "private.demo_seed_remove_auth_operations": "Operator-run demo seed removal.",
  "private.demo_seed_apply_organization_coordination": "Operator-run demo seed.",
  "private.demo_seed_remove_organization_coordination": "Operator-run demo seed removal.",
  "public.begin_member_case_file_upload": "Reserves a pending upload that nobody sees until it is confirmed.",
  "public.abort_member_case_file_upload": "Discards the caller's own pending upload that never became visible.",
  "public.finalize_member_case_file_removal": "Finalizer run by the service after the bytes are destroyed.",
  "public.set_sensitive_case_envelope": "Key handling; excluded from undo by design.",
  // Events and live polls (#6944): the reminder sweep stamps when it sent a
  // reminder; the poll recount and the scheduled open and close follow from
  // the poll's own settings and votes; the rest are operator-run seeders.
  "private.event_notice_sweep": "Event reminder job; it only stamps that the reminder went out.",
  "private.recalculate_organization_live_poll": "Recounts a poll's votes and results; derived, not a person's action.",
  "private.run_due_live_poll_transitions": "Opens and closes polls on their saved schedule.",
  "public.presg_demo_seed_org": "Operator-run demo seed.",
  "public.uniondemo_seed_org": "Operator-run demo seed.",
  "public.uniondemo_topup_upcoming_events": "Operator-run demo seed top-up.",
  // Messages, notices, invitations, exports and automations
  // (20261104111500): delivery workers, retention and account-closure
  // paths, the invitee's own acceptance steps, the platform operator's
  // founder invitations, SCIM provisioning, and operator-run seeds.
  "private.dispatch_due_member_messaging": "Delivers due scheduled messages and reminders; the scheduling was the person's action.",
  "private.dispatch_due_here_reminders": "Delivers due reminders; setting the reminder was the person's action.",
  "private.dispatch_due_workflow_reminders": "Delivers due workflow reminders; setting the reminder was the person's action.",
  "private.redact_member_message_row": "The one body-destruction path; every person-facing caller journals its own removal.",
  "private.redact_member_scheduled_message_row": "Retention's destruction of an undelivered scheduled copy.",
  "private.guard_member_message_destruction": "Deletion guard that redacts and cancels copies when a conversation is deleted.",
  "private.preserve_member_messages_on_account_delete": "Account closure: redacts and detaches the closed account's messages.",
  "private.civic_delete_for_deleted_identities": "Account closure: removes a deleted identity's civic drafts.",
  "private.run_due_organization_automations": "The automation scheduler; during a period it only records practice previews.",
  "private.automation_seed_default_recipes": "Seeds the organization's default automation recipes, switched off.",
  "private.expire_member_invitation_email": "#9273: system maintenance expires only time-expired pending invitations with a NULL audit actor; no person's practice action owns the expiry, and undo must never revive an expired link.",
  "public.claim_member_invitation": "The invitee opening their link, not the inviter's action.",
  "public.accept_former_member_invitation": "The invitee accepting, not the inviter's action.",
  "public.complete_member_invitation_activation": "The invitee's activation finishing, not the inviter's action.",
  "public.fail_member_invitation_accept": "The invitee's failed acceptance attempt, not the inviter's action.",
  "public.finalize_member_invitation": "The invitee's acceptance finishing, not the inviter's action.",
  "public.record_member_invitation_delivery": "The email worker recording the delivery outcome.",
  "public.record_member_sent_invitation_delivery": "The email route recording the delivery outcome of a member's own invitation (#8171).",
  "public.record_organization_founder_invitation_delivery": "The email worker recording a founder invitation's delivery outcome.",
  "public.create_organization_founder_invitation": "Platform operator inviting a new organization's founder; the platform organization has no learning period.",
  "public.resend_organization_founder_invitation": "Platform operator resending a founder invitation; the platform organization has no learning period.",
  "private.scim_reconcile_user": "SCIM directory provisioning, not a person's action.",
  "private.scim_revoke_pending_invitations": "SCIM directory deprovisioning, not a person's action.",
  "public.scim_record_invitation_delivery": "The email worker recording a SCIM invitation's delivery outcome.",
  "public.claim_organization_export_deliveries": "The export delivery worker claiming ready files.",
  "public.complete_organization_export_delivery": "The export delivery worker recording a delivery.",
  "private.demo_seed_remove_function_parity": "Operator-run demo seed removal.",
  "private.demo_seed_institutional_records_from_evidence": "Operator-run demo seed.",
  "private.demo_seed_remove_institutional_records": "Operator-run demo seed removal.",
  "private.demo_seed_remove_organization_intelligence": "Operator-run demo seed removal.",
  // Case workflow (20261104123000): the reminder and deadline sweeps stamp a
  // notice they sent; the reverse transition is written by an undo itself.
  "private.casework_fire_due_reminders": "Reminder sweep stamping the reminder it fired.",
  "private.casework_sweep_deadline_reminders": "Deadline-reminder sweep stamping the notice it sent.",
  "private.learning_reverse_transition": "Written by an undo, which is the journal's own work.",
  // Own preferences (20261105182000): the workload reminder sweep stamps the
  // reminder it sent and the next one due, never the person's choice.
  "private.workload_reminder_sweep": "Reminder sweep stamping the reminder it sent and the next one due.",
});

// Delivery tables whose rows the after-row trigger
// private.learning_journal_sent journals metadata-only (20261104111500): a
// writer that performs only the trigger's operations on the table is covered
// by it. Any other write needs its own journal call or a listed reason, and
// a client grant may stay only when the trigger covers it or it is listed
// here with its reason.
export const TRIGGER_JOURNALLED_TABLES = Object.freeze({
  "public.member_messages": { ops: ["insert"], grants: { "UPDATE (read_at)": "Marking a message read is a receipt, not a learning action." } },
  "public.chapter_thread_posts": { ops: ["insert"] },
  "public.member_peer_messages": { ops: ["insert"] },
  "public.organization_coordination_messages": { ops: ["insert"] },
  // Only retracting changes a published notice; the trigger fires on it.
  "public.member_broadcasts": { ops: ["insert", "update"] },
  // The send is the status change to sent; editing or deleting your own
  // unsent draft sends nothing.
  "public.civic_member_messages": { ops: ["insert", "update"], grants: { "SELECT,DELETE": "Deleting your own unsent draft; nothing went out." } },
  "public.digital_action_participants": { ops: ["insert", "delete"] },
  "public.organization_data_export_runs": { ops: ["insert"] },
  "public.organization_analytics_exports": { ops: ["insert"] },
  "public.organization_coordination_export_runs": { ops: ["insert"] },
  "public.digital_action_exports": { ops: ["insert"] },
});

// One function's write on one covered table that is not a learning action
// of its own, keyed "function|table", with the reason.
export const SIDE_WRITES = Object.freeze({
  "public.edit_member_message|public.member_scheduled_messages": "Keeps the dispatched copy equal to the edited message; the edit is journalled as message_edit.",
  "public.redact_member_message|public.member_scheduled_messages": "Destroys the dispatched copy of a message whose removal it holds or redacts; the removal is journalled on the message.",
  "public.request_filtered_organization_export|public.organization_data_export_runs": "Deletes only the organization's expired runs before adding the requested one, which the trigger journals.",
  "public.request_digital_action_participant_export|public.digital_action_exports": "Deletes only the organization's expired receipts before adding the requested one, which the trigger journals.",
});

// Writers a person runs that the design keeps outside undo on purpose (#6946):
// creating an organization or chapter, an accepted invitation (the membership
// is then the person's own), an organization membership ending, and choosing
// which chapter you are working in. Each needs a reason.
export const OUTSIDE_UNDO_WRITERS = Object.freeze({
  "public.stop_public_interest": "#9160: an operator-verified platform stop permanently revokes its intake-issued founder chain; no organization practice undo may restore that privacy action or a stopped link.",
  "public.confirm_public_interest_stop": "#9160: a person's confirmed stop permanently removes platform intake and revokes its outstanding founder invitations; organization practice undo must never restore a stopped link. No organization's learning session owns this platform privacy action.",
  "public.bootstrap_first_organization": "Creating the first organization and its founding administrator.",
  "public.create_my_organization": "Creating your organization and its founding administrator.",
  "private.grant_founder_organization_admin": "Accepting a founder invitation; accepted memberships are outside undo.",
  "public.finalize_member_invitation": "Accepting an invitation; accepted memberships are outside undo.",
  "public.accept_former_member_invitation": "Accepting a former-member invitation; accepted memberships are outside undo.",
  "private.apply_member_invitation_unit": "Accepting an invitation that names a unit; accepted memberships are outside undo.",
  "public.create_admin_chapter": "Creating a chapter adds its creator as a member; chapter creation is not a membership change.",
  "private.revoke_organization_role_grants_on_membership_revoke": "Trigger: an ended organization membership takes its organization roles with it; ending it is permanent.",
  "public.switch_my_chapter": "Choosing which of your chapters you are working in; navigation, not a setting undo restores.",
  "public.convert_chapter_task_to_template": "#8211: changing a General task to a specialized type; the type guard keeps specialized types fixed, so an undo could not restore General. The task's own history records the change.",
});

// One write a journalled writer makes on a second covered table, where its
// own entry already carries that state. Keyed "function table".
export const CASCADE_WRITES = Object.freeze({
  "public.revoke_member_chapter_membership public.member_role_chapters": "The membership entry's before-image carries the chapter roles the removal takes away, and its undo grants them back.",
  "public.revoke_member_chapter_membership public.member_profiles": "Moves the person's selected chapter off the removed one; the selection is not restored.",
  "public.grant_member_chapter_membership public.member_profiles": "Selects the granted chapter for someone who had none; its undo moves the selection off again.",
});

// A direct client write grant a covered table keeps for now, with the
// release that lets it go. Writes through it are real actions, not practice.
export const PENDING_DIRECT_GRANTS = Object.freeze({
  "public.member_profiles": "#6946: shipped native builds save language, notification and pulse choices with a direct update; the grant is revoked after the native release that calls update_my_member_profile. The web client already uses it.",
});

// Writers a later learning-period slice journals. Each names its record.
export const PENDING_SLICE_WRITERS = Object.freeze({
  // Saving a procedure is organization configuration that re-keys its cases'
  // steps; it belongs with the settings slice, not to one case's work.
  "public.casework_save_procedure": "#6946 (settings): saving a case procedure is organization configuration.",
});

// Writers whose write to a covered table is part of an action journalled
// under another table's kind. Each needs a reason.
export const COVERED_BY_ROW_KIND = Object.freeze({
  "public.open_member_case": "Opening a case names its first steward as part of creating it; the creation is journalled as case_create (#6942) and undoing it tombstones the whole case.",
});

// A kind may journal one facet of a row under its own target, so its undo
// chain and fingerprint stay apart from the row's other kinds: a case's
// assignment and its restriction (20261104120000) are facets of
// public.member_cases. A writer of the row's table that journals a facet kind
// counts as journalled for that table too; a facet alone never makes the
// row's table covered.
export const LEARNING_FACETS = Object.freeze({
  "public.member_case_assignment_audit": "public.member_cases",
  "private.learning_case_restriction": "public.member_cases",
});

// Split "('a', 'b', null), ('c', ...)" into rows of raw values, keeping
// quoted strings (with doubled quotes) and array[...] literals whole.
function valueRows(text) {
  const rows = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  let row = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      current += char;
      if (char === "'" && text[index + 1] === "'") { current += "'"; index += 1; } else if (char === "'") quoted = false;
      continue;
    }
    if (char === "'") { quoted = true; current += char; continue; }
    if (char === "(" || char === "[") {
      if (depth > 0) current += char;
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]") {
      depth -= 1;
      if (depth > 0) current += char;
      else { row.push(current.trim()); rows.push(row); row = []; current = ""; }
      continue;
    }
    if (char === "," && depth === 1) { row.push(current.trim()); current = ""; continue; }
    if (depth > 0) current += char;
  }
  return rows;
}

const unquote = (value) => (/^'.*'$/s.test(value) ? value.slice(1, -1).replace(/''/g, "'") : value.toLowerCase() === "null" ? null : value);

export function learningKinds(sqlTexts) {
  const kinds = [];
  for (const sql of sqlTexts) {
    for (const match of sql.matchAll(KINDS_INSERT)) {
      const columns = match[1].split(",").map((name) => name.trim());
      for (const values of valueRows(statementValues(sql, match.index + match[0].length))) {
        const row = Object.fromEntries(columns.map((name, index) => [name, unquote(values[index] ?? "null")]));
        kinds.push({ actionKind: row.action_kind, targetTable: row.target_table ?? null, disposition: row.disposition, handler: row.handler ?? null });
      }
    }
  }
  return kinds;
}

// A function's identity is its name and input argument types, as PostgreSQL
// keys overloads: argument names, defaults and OUT arguments are dropped.
function signature(sql, fn) {
  const open = sql.indexOf("(", fn.offset);
  let depth = 0;
  let close = open;
  for (; close < sql.length; close += 1) {
    if (sql[close] === "(") depth += 1;
    else if (sql[close] === ")" && (depth -= 1) === 0) break;
  }
  const types = [];
  let current = "";
  depth = 0;
  for (const char of `${sql.slice(open + 1, close)},`) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char !== "," || depth > 0) { current += char; continue; }
    const words = current.replace(/\s+(?:default\b|=)[\s\S]*$/i, "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    current = "";
    if (words[0] === "out") continue;
    if (["in", "inout", "variadic"].includes(words[0])) words.shift();
    if (words.length > 1) words.shift();
    // One spelling per type, so "timestamptz" and "timestamp with time zone"
    // name the same overload (#6944).
    if (words.length) types.push(canonicalType(words.join(" ")));
  }
  return `${fn.name}(${types.join(",")})`;
}

// A slice may hand off to the dispatcher it found installed: it moves that
// function to a new name and delegates every handler it does not list to it
// (20261104111500, 20261104120000). The moved function keeps its body.
const RENAME_FUNCTION = /\balter\s+function\s+((?:public|private)\.[a-z_][a-z0-9_]*)\s*(?:\(([^)]*)\))?\s+rename\s+to\s+([a-z_][a-z0-9_]*)/gi;
const DELEGATION = /\breturn\s+(private\.learning_dispatch[a-z0-9_]*)\s*\(\s*p_handler\s*,/gi;
const DROP_FUNCTION = /\bdrop\s+function\s+(?:if\s+exists\s+)?((?:public|private)\.[a-z_][a-z0-9_]*)\s*(?:\(([^)]*)\))?/gi;
// PostgreSQL spells some types two ways; compare one spelling.
const TYPE_ALIASES = { timestamptz: "timestamp with time zone", timestamp: "timestamp without time zone", int: "integer", int4: "integer", int8: "bigint", bool: "boolean", varchar: "character varying" };
const canonicalType = (type) => TYPE_ALIASES[type] ?? type;
// Input arguments in a drop's list: OUT arguments are not part of the
// identity. Each argument may carry a name, so both readings are kept: the
// whole text as a type, or the text after the first word.
const dropTypes = (list) => list.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part && !/^out\s/.test(part))
  .map((part) => {
    const words = part.replace(/^(?:in|inout|variadic)\s+/, "").split(/\s+/);
    return [words.join(" "), words.slice(1).join(" ")].filter(Boolean).map(canonicalType);
  });

const OPERATIONS = { insert: "insert\\s+into", update: "update", delete: "delete\\s+from" };
const writesWith = (source, table) => Object.entries(OPERATIONS)
  .filter(([, verb]) => new RegExp(`\\b${verb}\\s+${table.replace(".", "\\.")}\\b`, "i").test(source)).map(([op]) => op);
const writes = (source, table) => writesWith(source, table).length > 0;
// The trigger's operations as a migration creates it, or null.
const SENT_TRIGGER = /create\s+trigger\s+z90_learning_journal_sent\s+after\s+([\s\S]*?)\s+on\s+((?:public|private)\.[a-z_]+)\s+for\s+each\s+row\s+execute\s+function\s+private\.learning_journal_sent\(\)/gi;

// Every function's latest definition, by name and input types, after the
// creates, drops and moves (alter function ... rename to) in file order.
function latestFunctions(sqlTexts) {
  const latest = new Map();
  for (const sql of sqlTexts) {
    // Creates and drops in file order: a dropped function is no writer, and
    // one dropped and created again in the same file still is.
    const events = parseFunctions(sql).map((fn) => ({ offset: fn.offset, fn }));
    // Only an executed drop counts: one inside a comment or a quoted string
    // is text (#7033 r1s4).
    const masked = maskSqlCommentsAndLiterals(sql);
    for (const match of masked.matchAll(DROP_FUNCTION)) {
      events.push({ offset: match.index, drop: match[1].toLowerCase(), types: match[2] === undefined ? null : dropTypes(match[2]) });
    }
    for (const match of masked.matchAll(RENAME_FUNCTION)) {
      events.push({ offset: match.index, drop: match[1].toLowerCase(), types: match[2] === undefined ? null : dropTypes(match[2]),
        to: `${match[1].toLowerCase().split(".")[0]}.${match[3].toLowerCase()}` });
    }
    for (const event of events.sort((left, right) => left.offset - right.offset)) {
      if (event.fn) { latest.set(signature(sql, event.fn), { ...event.fn, source: stripSqlComments(event.fn.source) }); continue; }
      for (const [key, fn] of [...latest]) {
        if (fn.name !== event.drop) continue;
        const types = key.slice(fn.name.length + 1, -1).split(",").filter(Boolean).map(canonicalType);
        // A bare name drops every overload; a list drops only the overload
        // whose input types match it, each written with or without a name.
        if (event.types === null || (types.length === event.types.length
          && event.types.every((written, index) => written.some((type) => type === types[index])))) {
          latest.delete(key);
          // A moved function keeps its body under its new name.
          if (event.to) latest.set(event.to + key.slice(fn.name.length), { ...fn, name: event.to });
        }
      }
    }
  }
  return latest;
}

// sqlTexts: migration texts in apply order. grants: table grants
// ({table, role, privileges}) and column grants ({table, role, privilege,
// columns}) as scripts/db-contract.json pins them.
export function learningParityIssues(sqlTexts, grants = [], { triggerTables = TRIGGER_JOURNALLED_TABLES, sideWrites = SIDE_WRITES } = {}) {
  const kinds = learningKinds(sqlTexts);
  const byTable = new Map();
  for (const kind of kinds) {
    if (!kind.targetTable) continue;
    if (!byTable.has(kind.targetTable)) byTable.set(kind.targetTable, new Set());
    byTable.get(kind.targetTable).add(kind.actionKind);
  }
  const latest = latestFunctions(sqlTexts);
  const triggerOps = new Map();
  for (const sql of sqlTexts) {
    for (const match of stripSqlComments(sql).matchAll(SENT_TRIGGER)) {
      triggerOps.set(match[2].toLowerCase(), Object.keys(OPERATIONS).filter((op) => new RegExp(`\\b${op}\\b`, "i").test(match[1])));
    }
  }
  const issues = [];
  for (const [table, own] of byTable) {
    const names = new Set(own);
    for (const [facet, base] of Object.entries(LEARNING_FACETS)) {
      if (base === table) for (const name of byTable.get(facet) ?? []) names.add(name);
    }
    const trigger = Object.hasOwn(triggerTables, table) ? triggerTables[table] : null;
    const covered = trigger ? (triggerOps.get(table) ?? []) : [];
    if (trigger && trigger.ops.some((op) => !covered.includes(op))) {
      issues.push(`${table} is listed as journalled by private.learning_journal_sent on ${trigger.ops.join(", ")} but its trigger covers ${covered.join(", ") || "nothing"}`);
    }
    const coveredOps = trigger ? trigger.ops.filter((op) => covered.includes(op)) : [];
    for (const fn of latest.values()) {
      if (ENGINE.has(fn.name) || Object.hasOwn(SYSTEM_WRITERS, fn.name) || Object.hasOwn(PENDING_SLICE_WRITERS, fn.name)
        || Object.hasOwn(COVERED_BY_ROW_KIND, fn.name)
        || Object.hasOwn(OUTSIDE_UNDO_WRITERS, fn.name) || Object.hasOwn(CASCADE_WRITES, `${fn.name} ${table}`)
        || Object.hasOwn(sideWrites, `${fn.name}|${table}`)
        || fn.name.startsWith("private.learning_undo_") || !writes(fn.source, table)) continue;
      // Every write this function makes on a trigger-journalled table is one the trigger journals.
      if (writesWith(fn.source, table).every((op) => coveredOps.includes(op))) continue;
      // The engine's append, or a domain helper named private.learning_<domain>_journal.
      const journalled = [...fn.source.matchAll(/private\.learning_(?:journal_append|[a-z]+_journal)\s*\(\s*'([a-z0-9_]+)'/gi)].map((match) => match[1]);
      // The casework journal (20261104123000) journals every case history row
      // the action wrote, so it covers every kind its handler reverses and the
      // case kinds it maps case rows to.
      if (/private\.learning_casework_journal\s*\(/i.test(fn.source)) {
        journalled.push("case_create", "case_edit", ...kinds.filter((kind) => kind.handler === "private.learning_undo_casework").map((kind) => kind.actionKind));
      }
      if (!journalled.some((name) => names.has(name))) issues.push(`${fn.name} writes ${table} without journalling a registered learning action`);
    }
    for (const grant of grants) {
      const privileges = grant.privileges ?? grant.privilege ?? "";
      // A column pin with no columns records a grant that was taken away.
      if (grant.columns === "") continue;
      if (grant.table !== table || !["authenticated", "anon"].includes(grant.role) || !/INSERT|UPDATE|DELETE/.test(privileges)) continue;
      const label = `${privileges}${grant.columns ? ` (${grant.columns})` : ""}`;
      const writing = privileges.split(",").map((name) => name.trim().toLowerCase()).filter((name) => Object.hasOwn(OPERATIONS, name));
      if (trigger && (writing.every((op) => coveredOps.includes(op)) || Object.hasOwn(trigger.grants ?? {}, label))) continue;
      if (Object.hasOwn(PENDING_DIRECT_GRANTS, table) && grant.role === "authenticated" && privileges === "UPDATE") continue;
      issues.push(`${grant.role} keeps a direct ${label} grant on ${table}`);
    }
  }
  return [...new Set(issues)].sort();
}

// The dispatcher is static and re-emitted by every slice that adds a
// handler, so a slice merged after another must carry the other's branches.
// Every handler a kinds row names needs a branch in the latest dispatcher.
export function learningDispatchIssues(sqlTexts) {
  const handlers = new Set();
  for (const sql of sqlTexts) {
    for (const match of sql.matchAll(KINDS_INSERT)) {
      const columns = match[1].split(",").map((name) => name.trim());
      const at = columns.indexOf("handler");
      if (at < 0) continue;
      for (const values of valueRows(statementValues(sql, match.index + match[0].length))) {
        const handler = unquote(values[at] ?? "null");
        if (handler) handlers.add(handler);
      }
    }
  }
  // A slice may also hand off: it moves the dispatcher it found installed to
  // a new name and delegates every handler it does not list to it
  // (20261104111500, 20261104120000), so a branch counts when the latest
  // dispatcher or any dispatcher it hands off to has it.
  const latest = latestFunctions(sqlTexts);
  const named = (name) => [...latest.values()].find((fn) => fn.name === name);
  const reaches = (name, branch, seen = new Set()) => {
    const fn = named(name);
    if (!fn || seen.has(name)) return false;
    seen.add(name);
    return fn.source.includes(branch)
      || [...fn.source.matchAll(DELEGATION)].some((match) => reaches(match[1].toLowerCase(), branch, seen));
  };
  return [...handlers].filter((handler) => !reaches("private.learning_dispatch", `when '${handler}' then return ${handler}(p_mode, p_entry);`))
    .map((handler) => `private.learning_dispatch has no branch for ${handler}`).sort();
}

export function repositoryLearningParityIssues(directory = "supabase/migrations", contractPath = "scripts/db-contract.json") {
  const texts = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort().map((file) => readFileSync(`${directory}/${file}`, "utf8"));
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  return [...learningParityIssues(texts, [...(contract.tableGrants ?? []), ...(contract.columnGrants ?? [])]), ...learningDispatchIssues(texts)];
}
