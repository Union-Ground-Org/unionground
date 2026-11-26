import { migrateLegacyStewardFixtures } from "../tests/helpers/steward-unit-fixtures.js";
import { proveCaseGraphInventory, reviewedGraph, runAuthBookkeepingDriftControls } from './account-case-graph-inventory.mjs';
import { proveCatalogueWriterEntry, proveConcurrentGrantRevocation, proveMidGrantRevocation, proveOverlappingIdentityDeletion } from './account-lifecycle-concurrency-proof.mjs';
import { proveRetainedAuthorization, proveTriggerNegativeControls, proveRetainedWriterBoundaries, proveAdditionalRetainedReads, proveRetainedDefinerInventory } from './account-lifecycle-retention-proof.mjs';
// BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831: proves the schema-wide
// account-lifecycle manifest against a real local Postgres. Three things a
// migration text pin cannot prove on its own:
//   1. No restrictive (RESTRICT/NO ACTION) foreign key anywhere in the full
//      ON DELETE CASCADE closure rooted at auth.users is missing from the
//      manifest, on the ACTUAL current schema — not a hand-picked sample.
//   2. Deleting a user represented across every disposition category
//      (cascade, pseudonymize with a NOT NULL column, pseudonymize with two
//      columns on the same table) succeeds in one transaction and leaves the
//      expected residue.
//   3. The independently discovered direct auth.users ownership inventory,
//      regardless of delete action, exactly matches the reviewed manifest in
//      both directions, including explicit exclusions.
//   4. Every canonical row maps to a versioned hand-shaped export domain, and
//      every generic domain uses the independently pinned safe-column list.
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";
import { reviewedForeignKeys } from './account-case-graph-inventory.mjs';
import { reviewedOwnershipIdentityKeys } from './lib/key-assurance-count-pins.mjs';

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  deleting: "50900500-0000-4000-8000-000000000001",
  member: "50900500-0000-4000-8000-000000000002",
  organization: "50900500-0000-4000-8000-000000000003",
  question: "50900500-0000-4000-8000-000000000004",
  otherQuestion: "50900500-0000-4000-8000-000000000005",
  case: "50900500-0000-4000-8000-000000000006",
  session: "50900500-0000-4000-8000-000000000007",
  sensitiveCase: "50900500-0000-4000-8000-000000000008",
  space: "50900500-0000-4000-8000-000000000009",
  unauthorizedStaff: "50900500-0000-4000-8000-000000000010",
  authorizedStaff: "50900500-0000-4000-8000-000000000011",
  unauthorizedSession: "50900500-0000-4000-8000-000000000012",
  authorizedSession: "50900500-0000-4000-8000-000000000013",
  chapter: "lifecycle-proof",
};

// 346 since 20260924170000/20260924170200 added organization_structure_imports.actor_user_id,
// member_conversations.steward_user_id and steward_contact_preferences.steward_user_id.
// 347 since 20260925110300 added member_case_updates.author_user_id.
// 348 since 20260925230000 added chapter_contact_log_versions.changed_by.
// 349 since 20260925980000 added member_event_checkin_attempts.user_id.
// 350 since 20260928103000 added chapter_connection_source_tags.contributor_user_id.
// 353 since governed learning adds platform grants, home preferences and audit actors.
// 358 since 20260930040000 added platform_operators.user_id, organization_claims.claimant_user_id
// and .reviewed_by, and catalog_review_events.actor_user_id and .subject_user_id.
// +1: 20261001002000 adds the dedicated compass_platform_operators.user_id.
// +4: connected workflows add organizer, opt-in and contact-link identity keys.
// +1: the verified-key session registry owns its auth.users cascade key.
// +1: 20261002133000 adds member_home_return_marks.user_id (one last-active date).
// +2: 20261002140000 adds casework_retaliation_flags.created_by and .reviewed_by
// (REQ-UG-ULP-FILING-DEADLINE-20261001).
// +1: 20261003033000 adds channel_here_reminder_deliveries.recipient_id.
// +1: 20261003040000 adds private.member_pin_credentials.user_id (member PIN sign-in).
// +1: 20261003034000 adds chapter_space_notification_settings.user_id (channel controls).
// -2: 20261003070000 drops organization_poms_sources.created_by and
// organization_poms_evidence.created_by with their tables (POMS removal).
// +1: 20261008100000 adds member_profile_details.user_id (member work and contact details).
// +1: 20261009000500 adds steward_private_reminders.owner_id (steward private reminders).
// +44: Union Ground's lifecycle migrations (20261014001000-009000) add 44
// single-column auth.users keys; 20261014014000 gives each one a reviewed
// manifest row (cascade for the worker's own records, pseudonymize for actor
// and assignment attribution on shared campaign records).
// +3: platform announcements own publisher grants, mute preferences and audit attribution.
// +2: 20261029150000 adds organization_start_guide_state.backup_user_id and
// organization_start_spokespeople.user_id (the org-start guide's named backup
// and spokespeople).
// +3: 20261029235156 adds free_cosmetic_awards.user_id/granted_by and free_cosmetic_selections.user_id.
// +1: 20261030010000 adds staff_onboarding_progress.user_id (staff feature
// guide progress).
// +3: 20261030214501 adds chapter_records.approved_by and
// ballot_nominations.nominated_by/seconded_by (minutes approval, nominations).
// +2: 20261030224501 adds chapter_seniority_entries.user_id and
// chapter_bid_entries.user_id (a member's seniority entry and bids).
// +1: 20261030234501 adds member_appointment_notes.steward_id (a steward's
// private booking notes).
// +2: 20261030235900 adds member_requests.requester_user_id/decided_by
// (invitation suggestions and role requests).
// +2: 20261101224749 adds chapter_handshake_offers.created_by and
// chapter_partner_invitation_requests.created_by (standing handshake offers).
// +4: #6682's unit/committee scoped-access migration.
// +1: 20261102001534 adds pulse_saved_charts.owner_id (authored specs/pins).
// +1: #6688's Treasurer financial-duties migration.
// +5: 20261104110000 (#6944) holds a practised event delete for undo:
// learning_held_member_events.organizer_id, the held RSVP and contact consent
// user_id, and the held contact link organizer_id/participant_id.
const EXPECTED_OWNERSHIP_IDENTITY_KEYS = reviewedOwnershipIdentityKeys(reviewedForeignKeys.foreign_keys);
const EXPECTED_OWNERSHIP_IDENTITY_FKS = EXPECTED_OWNERSHIP_IDENTITY_KEYS.length;
// +4: 20261003051000 adds chapter_leadership_claims.claimant_user_id/decided_by and
// member_ballots.target_officer_id/removal_outcome_recorded_by.
// +4: 20261003053000 adds task_checkoff_lists.created_by and task_checkoff_entries
// .member_user_id, .assigned_steward_id and .actioned_by (member check-off lists).
// 15 since 20260924170000 reviewed organization_chart_nodes_user_membership_fkey
// (pseudonymize user_id): an imported member's position detaches, never blocks deletion.
// +12: 20261014014000 reviews Union Ground's eight membership-scoped organizer
// keys (pseudonymize) and four same-worker participation source keys (cascade).
// +1 (28) since 20261123044100 (#9610) reviewed demo_seed_case_deadline_writes_case_id_fkey
// (cascade): the demo seed's case-deadline proof lives exactly as long as its case.
// +1 (29) since 20261123111000 (#9610 unit 2) reviewed demo_seed_step_deadline_writes_case_id_fkey
// (cascade): the demo seed's step-deadline proof lives exactly as long as its case.
const EXPECTED_TRANSITIVE_RESTRICTIVE_FK_REVIEWS = 29;

// Independent of the SQL manifest rows: this verifier-owned map is the
// mechanical bridge from every `canonical` classification to an actual v1
// hand-shaped response path AND the installed caller-ownership predicate that
// feeds it. A table name appearing somewhere in the exporter is not coverage.
const CANONICAL_EXPORT_V1 = new Map([
  ["private.cross_chapter_peer_mutes.user_id", {
    domain: "peerContact.crossChapterMutes",
    coverageNeedles: ["from private.cross_chapter_peer_mutes mute where mute.user_id = caller"],
  }],
  ["private.member_peer_blocks.blocker_id", {
    domain: "peerContact.blocks",
    coverageNeedles: ["from private.member_peer_blocks block where block.blocker_id = caller"],
  }],
  ["public.chapter_governance_requests.requester_id", {
    domain: "support.dataRequests",
    coverageNeedles: ["from public.chapter_governance_requests g where g.requester_id = caller"],
  }],
  ["public.chapter_space_members.user_id", {
    domain: "chapterParticipation.spaceMemberships",
    coverageNeedles: ["from public.chapter_space_members m where m.user_id = caller"],
  }],
  ["public.chapter_task_assignments.assignee_id", {
    domain: "chapterParticipation.taskAssignments",
    coverageNeedles: ["from public.chapter_task_assignments a where a.assignee_id = caller"],
  }],
  ["public.chapter_task_files.uploaded_by", {
    domain: "additionalDomains.chapter_task_files",
    coverageNeedles: ["from public.chapter_task_files file where file.uploaded_by = caller"],
  }],
  ["public.chapter_task_messages.recipient_id", {
    domain: "chapterParticipation.taskMessages",
    coverageNeedles: ["from public.chapter_task_messages m where m.sender_id = caller or m.recipient_id = caller"],
  }],
  ["public.chapter_task_messages.sender_id", {
    domain: "chapterParticipation.taskMessages",
    coverageNeedles: ["from public.chapter_task_messages m where m.sender_id = caller or m.recipient_id = caller"],
  }],
  ["public.meeting_attendance.user_id", {
    domain: "additionalDomains.meeting_attendance",
    coverageNeedles: ["from public.meeting_attendance attendance where attendance.user_id = caller"],
  }],
  ["public.meeting_minutes_dispatches.recipient_id", {
    domain: "additionalDomains.meeting_minutes_dispatches",
    coverageNeedles: ["from public.meeting_minutes_dispatches dispatch where dispatch.recipient_id = caller"],
  }],
  ["public.member_action_log.user_id", {
    domain: "activity.actions",
    coverageNeedles: ["from public.member_action_log a where a.user_id = caller"],
  }],
  ["public.member_ai_requests.user_id", {
    domain: "compass.requestHistory",
    coverageNeedles: ["from public.member_ai_requests r where r.user_id = caller"],
  }],
  ["public.member_appointments.user_id", {
    domain: "support.appointments",
    coverageNeedles: ["from public.member_appointments a where a.user_id = caller"],
  }],
  ["public.member_ballot_receipts.user_id", {
    domain: "participation.ballotReceipts",
    coverageNeedles: ["from public.member_ballot_receipts r where r.user_id = caller"],
  }],
  ["public.member_case_files.user_id", {
    domain: "additionalDomains.member_case_files",
    coverageNeedles: ["from public.member_case_files file where file.user_id = caller"],
  }],
  ["public.member_case_updates.user_id", {
    domain: "cases[].updates",
    coverageNeedles: ["from public.member_case_updates u where u.case_id = c.id and u.user_id = caller"],
  }],
  ["public.member_cases.user_id", {
    domain: "cases",
    coverageNeedles: ["from public.member_cases c where c.user_id = caller"],
  }],
  ["public.member_conversations.user_id", {
    domain: "conversations",
    coverageNeedles: ["from public.member_conversations c where c.user_id = caller"],
  }],
  ["public.member_event_checkins.user_id", {
    domain: "participation.eventCheckins",
    coverageNeedles: ["from public.member_event_checkins c where c.user_id = caller"],
  }],
  ["public.member_event_rsvps.user_id", {
    domain: "participation.eventRsvps",
    coverageNeedles: ["from public.member_event_rsvps r where r.user_id = caller"],
  }],
  ["public.member_form_files.uploaded_by", {
    domain: "additionalDomains.member_form_files",
    coverageNeedles: [
      "from public.member_form_files file where file.uploaded_by = caller",
      "where form.id = file.form_id and form.user_id = caller",
    ],
  }],
  ["public.member_forms.user_id", {
    domain: "forms",
    coverageNeedles: ["from public.member_forms f where f.user_id = caller"],
  }],
  ["public.member_guide_messages.user_id", {
    domain: "compass.threads[].messages",
    coverageNeedles: ["from public.member_guide_messages m where m.thread_id = t.id and m.user_id = caller"],
  }],
  ["public.member_guide_threads.user_id", {
    domain: "compass.threads",
    coverageNeedles: ["from public.member_guide_threads t where t.user_id = caller"],
  }],
  ["public.member_intake_reports.reporter_id", {
    domain: "support.intakeReports",
    coverageNeedles: ["from public.member_intake_reports i where i.reporter_id = caller"],
  }],
  // 20261104111500 (learning period, slice 6): a message whose own-message
  // removal is held during the period is hidden from every reader, the
  // export included, until it is undone or redacted.
  ["public.member_messages.sender_id", {
    domain: "conversations[].messages",
    coverageNeedles: ["from public.member_messages m where m.conversation_id = c.id and m.learning_removal_held_at is null and (m.user_id = caller or m.sender_id = caller)"],
  }],
  ["public.member_messages.user_id", {
    domain: "conversations[].messages",
    coverageNeedles: ["from public.member_messages m where m.conversation_id = c.id and m.learning_removal_held_at is null and (m.user_id = caller or m.sender_id = caller)"],
  }],
  ["public.member_notifications.user_id", {
    domain: "notifications",
    coverageNeedles: ["from public.member_notifications n where n.user_id = caller"],
  }],
  ["public.member_peer_contact_requests.recipient_id", {
    domain: "peerContact.requests",
    coverageNeedles: ["from public.member_peer_contact_requests r where r.requester_id = caller or r.recipient_id = caller"],
  }],
  ["public.member_peer_contact_requests.requester_id", {
    domain: "peerContact.requests",
    coverageNeedles: ["from public.member_peer_contact_requests r where r.requester_id = caller or r.recipient_id = caller"],
  }],
  ["public.member_peer_conversations.user_high", {
    domain: "peerContact.conversations",
    coverageNeedles: ["from public.member_peer_conversations c where c.user_low = caller or c.user_high = caller"],
  }],
  ["public.member_peer_conversations.user_low", {
    domain: "peerContact.conversations",
    coverageNeedles: ["from public.member_peer_conversations c where c.user_low = caller or c.user_high = caller"],
  }],
  ["public.member_peer_messages.sender_id", {
    domain: "peerContact.conversations[].messages",
    coverageNeedles: [
      "from public.member_peer_messages m where m.conversation_id = conversation.id",
      "from public.member_peer_conversations c where c.user_low = caller or c.user_high = caller",
    ],
  }],
  ["public.member_point_events.user_id", {
    domain: "activity.points",
    coverageNeedles: ["from public.member_point_events p where p.user_id = caller"],
  }],
  ["public.member_profiles.id", {
    domain: "account.profile",
    coverageNeedles: ["from public.member_profiles p where p.id = caller"],
  }],
  ["public.member_qa_questions.author_user_id", {
    domain: "additionalDomains.member_qa_questions",
    coverageNeedles: ["from public.member_qa_questions question where question.author_user_id = caller"],
  }],
  ["public.member_qa_replies.author_user_id", {
    domain: "additionalDomains.member_qa_replies",
    coverageNeedles: ["from public.member_qa_replies reply where reply.author_user_id = caller"],
  }],
  ["public.member_reward_grants.user_id", {
    domain: "activity.rewards",
    coverageNeedles: ["from public.member_reward_grants r where r.user_id = caller"],
  }],
  ["public.member_rights_progress.user_id", {
    domain: "participation.rightsProgress",
    coverageNeedles: ["from public.member_rights_progress r where r.user_id = caller"],
  }],
  ["public.member_roles.user_id", {
    domain: "account.roles",
    coverageNeedles: ["from public.member_roles r where r.user_id = caller"],
  }],
  ["public.member_scheduled_messages.actor_id", {
    domain: "additionalDomains.member_scheduled_messages",
    coverageNeedles: ["from public.member_scheduled_messages message where message.actor_id = caller"],
  }],
  ["public.member_steward_requests.user_id", {
    domain: "support.stewardRequests",
    coverageNeedles: ["from public.member_steward_requests r where r.user_id = caller"],
  }],
  ["public.member_survey_responses.user_id", {
    domain: "participation.surveyResponses",
    coverageNeedles: ["from public.member_survey_responses s where s.user_id = caller"],
  }],
  ["public.member_workload_logs.user_id", {
    domain: "activity.workload",
    coverageNeedles: ["from public.member_workload_logs workload where workload.user_id = caller"],
  }],
]);

// This second independent pin prevents a migration author from quietly adding
// a raw column to an `additional_domains` manifest row. Ordering is meaningful
// because it is also the stable response-object key order.
const SAFE_ADDITIONAL_V1 = new Map([
  // #8927: caller-only chapter layout; keys, array order and pins, no figures.
  ["private.pulse_layouts.owner_id", ["owner_id", "organization_id", "chapter_id", "entries"]],
  // #6676: only the caller's own expense/reimbursement and its recorded decision.
  ["private.chapter_financial_requests.subject_id", ["id", "organization_id", "chapter_id", "subject_id", "kind", "title", "description", "amount", "currency", "status", "decision_note", "revision", "created_at", "decided_at"]],
  // #6665 exports only the subject's own unit/committee membership and role
  // scope identifiers; no peer roster, case identifier or draft text.
  ["private.chapter_unit_members.user_id", ["user_id", "chapter_id", "unit_id"]],
  ["private.chapter_committee_members.user_id", ["user_id", "chapter_id", "committee_id"]],
  // Upstream decision of November 10, 2026: export only the subject's assignment metadata.
  ["private.chapter_role_scopes.user_id", ["user_id", "chapter_id", "role", "unit_id", "committee_id", "legacy_chapter_coverage"]],
  // #8772: only the referring member's own waiting payout: a random award key
  // and when it started waiting; it names no other member.
  ["private.member_referral_payouts_waiting.referrer_user_id", ["award_key", "referrer_user_id", "waiting_since"]],
  ["private.organization_steward_unit_assignments.user_id", ["organization_id", "user_id", "role", "chapter_id", "unit_id", "legacy_chapter_coverage"]],
  ["private.pulse_saved_charts.owner_id", ["id", "owner_id", "organization_id", "chapter_id", "title", "spec", "scope", "pinned", "home", "deleted_at", "created_at", "updated_at"]],
  ["public.chapter_channel_poll_votes.user_id", ["poll_id", "option_id", "user_id", "created_at", "updated_at"]],
  ["public.chapter_space_notification_settings.user_id", ["organization_id", "space_id", "user_id", "notification_level", "muted", "muted_until", "keywords", "updated_at"]],
  ["public.chapter_task_watchers.user_id", ["user_id", "task_id", "chapter_id", "created_at"]],
  ["public.chapter_thread_posts.author_id", ["id", "thread_id", "chapter_id", "author_id", "body", "parent_post_id", "created_at", "edited_at", "deleted_at", "author_name", "author_initials", "author_role", "body_es"]],
  ["public.chapter_threads.created_by", ["id", "space_id", "chapter_id", "title", "kind", "status", "created_by", "task_id", "case_id", "resolved_at", "created_at", "updated_at"]],
  ["public.compass_message_briefings.requested_by", ["id", "organization_id", "requested_by", "source_kind", "target_id", "summary", "action_items", "created_at"]],
  ["public.compass_workspace_preferences.user_id", ["organization_id", "user_id", "module_order", "hidden_modules", "updated_at"]],
  // 20261027060200: caller-owned optional training consent; organization-control
  // attribution (enabled_by) remains excluded from the member's portable data.
  ["private.compass_training_member_consents.user_id", ["organization_id", "user_id", "enabled", "notice_version", "updated_at"]],
  // The expiry-filtered exporter returns only the caller's training text and
  // provenance. Internal request_id and provider/credential data stay excluded.
  ["private.compass_training_samples.user_id", ["id", "organization_id", "user_id", "kind", "prompt", "response", "notice_version", "created_at", "expires_at"]],
  ["public.member_ballot_votes.user_id", ["ballot_id", "option_id", "user_id", "submitted_at"]],
  ["public.member_broadcast_receipts.user_id", ["broadcast_id", "user_id", "read_at"]],
  // 20261014014000: a Union Ground worker's own participation history. The
  // verifying, assigning or offering organizer's identity is never exported.
  ["public.member_capacity_commitments.user_id", ["id", "user_id", "chapter_id", "commitment_kind", "activity_kind", "rung", "title", "status", "responded_at", "started_at", "completed_at", "verified_at", "created_at"]],
  ["public.member_chapter_memberships.user_id", ["user_id", "chapter_id", "status", "pinned", "last_selected_at", "joined_at", "revoked_at", "compass_unit_keys", "compass_scope_verification", "display_title", "budget_office"]],
  // 20260929090000: consent to organizer contact, and the metadata-only bindings of delivered private messages to an event (no message text; the words stay in public.member_messages).
  ["private.member_event_contact_links.participant_id", ["message_id", "event_id", "organizer_id", "participant_id", "sender_role", "created_at"]],
  ["private.member_event_contact_opt_ins.user_id", ["event_id", "user_id", "organizer_id", "opted_in_at"]],
  ["public.member_learning_assignments.user_id", ["id", "session_id", "user_id", "chapter_id", "learning_kind", "activity_kind", "rung", "status", "responded_at", "completed_at", "verified_at", "created_at"]],
  ["public.member_emergency_checklists.member_user_id", ["id", "organization_id", "member_user_id", "scenario", "status", "completed_steps", "notes", "alerted_at", "resolved_at", "created_at", "updated_at"]],
  ["public.member_message_reactions.actor_id", ["id", "actor_id", "source_kind", "private_message_id", "channel_post_id", "task_message_id", "reaction", "created_at"]],
  ["public.member_message_reminders.owner_id", ["id", "owner_id", "source_kind", "private_message_id", "channel_post_id", "task_message_id", "source_ref", "audience", "note", "title", "repeat_rule", "time_zone", "remind_at", "status", "snooze_count", "completed_at", "created_at", "delivered_at", "updated_at"]],
  ["public.member_message_resources.added_by", ["id", "message_id", "document_id", "added_by", "created_at"]],
  ["public.member_membership_periods.user_id", ["id", "user_id", "chapter_id", "joined_on", "left_on", "date_precision", "status", "end_reason", "source_kind", "verified_at", "created_at"]],
  ["public.member_onboarding_steps.user_id", ["id", "membership_period_id", "user_id", "chapter_id", "step_key", "due_on", "status", "source_kind", "completed_at", "created_at"]],
  ["public.member_participation_completions.user_id", ["id", "user_id", "chapter_id", "activity_kind", "rung", "learning_assignment_id", "capacity_commitment_id", "occurred_at", "verified_at", "created_at"]],
  ["public.member_participation_events.user_id", ["id", "user_id", "chapter_id", "rung", "activity_kind", "source_kind", "occurred_at", "created_at"]],
  // 20261008100000: the member's own work and contact details and who they chose to share them with.
  // 20261031130301 adds form_autofill (the member's ask/always/never answer for form autofill).
  ["public.member_profile_details.user_id", ["user_id", "pronouns", "job_title", "worksite", "phone", "details_visibility", "phone_visibility", "updated_at", "shift", "classification", "form_autofill"]],
  ["public.member_qa_votes.user_id", ["organization_id", "user_id", "question_id", "reply_id", "created_at"]],
  ["public.member_recognition_events.user_id", ["id", "user_id", "chapter_id", "recognition_kind", "source_kind", "source_label", "occurred_at", "verified_at", "created_at"]],
  ["public.member_report_preferences.user_id", ["user_id", "config", "updated_at"]],
  ["public.member_reward_tier_attainment.user_id", ["user_id", "highest_tier", "attained_at", "updated_at"]],
  ["public.member_saved_messages.owner_id", ["id", "owner_id", "source_kind", "private_message_id", "channel_post_id", "task_message_id", "saved_at"]],
  ["public.member_weekly_question_promotions.user_id", ["question_id", "reward_grant_id", "organization_id", "chapter_id", "user_id", "promoted_at"]],
  ["public.member_weekly_question_supports.user_id", ["question_id", "user_id", "created_at"]],
  ["public.member_weekly_questions.user_id", ["id", "chapter_id", "user_id", "week_start", "body", "options", "editorial_state", "published_survey_id", "created_at", "updated_at"]],
  ["public.organization_engagement_events.user_id", ["organization_id", "user_id", "chapter_id", "event_type", "source_id", "occurred_at"]],
  ["public.organization_live_poll_votes.voter_user_id", ["organization_id", "poll_id", "option_id", "voter_user_id", "created_at", "updated_at"]],
  ["public.organization_memberships.user_id", ["organization_id", "user_id", "status", "created_at", "revoked_at"]],
  ["public.organization_pulse_events.user_id", ["id", "organization_id", "prompt_id", "user_id", "context_key", "state", "response_value", "shown_at", "responded_at", "updated_at"]],  // 20260924170200: a steward's own sharing choices and the contact values they entered.
  ["public.steward_contact_preferences.steward_user_id", ["steward_user_id", "share_email", "share_phone", "contact_email", "contact_phone", "updated_at"]],
  // 20261009000500: the steward's own private pre-filing reminder (title, date and the case it was attached to).
  // 20261030224501: the member's own seniority entry (with their question) and bids.
  ["private.chapter_seniority_entries.user_id", ["id", "organization_id", "chapter_id", "user_id", "seniority_date", "classification", "tie_break_note", "question_note", "question_status", "questioned_at", "answer_note", "answered_at", "created_at", "updated_at"]],
  ["private.chapter_bid_entries.user_id", ["id", "window_id", "user_id", "choice", "award", "recorded_at", "awarded_at"]],
  ["private.steward_private_reminders.owner_id", ["id", "owner_id", "organization_id", "title", "remind_on", "case_id", "attached_at", "created_at", "updated_at"]],
]);

const UNSAFE_GENERIC_COLUMN = /(token|secret|password|object_name|bucket_id|provider|idempotency_key)/;

function assert(value, message) {
  if (!value) throw new Error(message);
}

function rowKey(row) {
  return `${row.schema_name}.${row.table_name}.${row.user_column}`;
}

function sameColumns(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((column, index) => column === expected[index]);
}

function exportPathExists(root, path) {
  let nodes = [root];
  const parts = path.split(".");
  for (let index = 0; index < parts.length; index += 1) {
    const arrayPart = parts[index].endsWith("[]");
    const key = parts[index].replace(/\[\]$/, "");
    const values = nodes
      .filter((node) => node && typeof node === "object" && Object.prototype.hasOwnProperty.call(node, key))
      .map((node) => node[key]);
    if (values.length === 0) return false;
    if (!arrayPart) {
      nodes = values;
      continue;
    }
    if (values.some((value) => !Array.isArray(value))) return false;
    nodes = values.flat();
    // An empty collection still establishes this versioned domain. Source
    // coverage is separately tied to the installed function definition.
    if (nodes.length === 0 && index < parts.length - 1) return true;
  }
  return true;
}

async function asRole(client, role, claims = {}) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role, ...claims })]);
  await client.query(`set local role ${role}`);
}

const client = new Client({ connectionString: databaseUrl, application_name: "account-lifecycle-manifest-proof" });
try {
  await client.connect();
  await proveCaseGraphInventory(client);
  await client.query('begin');
  let missingRootDetected = false;
  try {
    await client.query('drop trigger a00_case_graph_lock on auth.mfa_factors');
    await proveCaseGraphInventory(client);
  } catch (error) {
    missingRootDetected = error.message.includes('relation closure or BEFORE STATEMENT gate changed');
  } finally {
    await client.query('rollback');
  }
  assert(missingRootDetected, 'missing indirect trigger-root gate must fail the installed inventory');
  console.log('PASS: missing indirect trigger-root statement gate is detected');
  for (const [mutation, expected] of [
    ['drop trigger a00_case_graph_lock on public.member_handoffs', 'relation closure or BEFORE STATEMENT'],
    ["create or replace trigger z99_case_graph_keys before insert or update or delete on public.member_steward_relationships for each row execute function private.lock_case_graph_row_keys('member_user_id', '')", 'Implicit FK row-key gate'],
    ["create table public.lifecycle_new_identity_reference(id uuid references auth.users(id))", 'Implicit FK acquisition catalogue'],
  ]) {
    await client.query('begin');
    let detected = false;
    try {
      await client.query(mutation);
      await proveCaseGraphInventory(client);
    } catch (error) { detected = error.message.includes(expected); }
    finally { await client.query('rollback'); }
    assert(detected, `implicit acquisition mutation must be detected: ${expected}`);
  }
  console.log('PASS: implicit FK catalogue, handoff statement and recipient row-key mutations are detected');
  const authBookkeepingDrifts = [
    ['drop trigger a01_auth_bookkeeping_shared on auth.sessions', 'Auth bookkeeping shared trigger', 'missing shared trigger'],
    ['alter table auth.sessions disable trigger a01_auth_bookkeeping_shared', 'Auth bookkeeping shared trigger', 'disabled shared trigger'],
    ["create trigger zz_unreviewed_auth_trigger before insert on auth.sessions for each statement execute function private.lock_auth_bookkeeping_shared()", 'Auth bookkeeping shared trigger', 'unexpected exempt-relation trigger'],
    ["create or replace trigger a00_case_graph_lock before insert or delete or update of id,instance_id,aud,role,email,phone,deleted_at,banned_until,is_sso_user,is_anonymous,email_change,phone_change on auth.users for each statement execute function private.lock_case_graph_statement_auth()", 'auth.users', 'missing covered users column'],
    ['drop trigger a01_auth_bookkeeping_exclusive on auth.oauth_clients', 'users/client trigger', 'missing OAuth client exclusive trigger'],
    ['drop trigger a00_case_graph_lock on auth.oauth_clients', 'users/client trigger', 'missing OAuth client graph gate before the exclusive lock'],
    ['drop trigger a00_case_graph_lock on auth.sso_providers', 'users/client trigger', 'missing SSO provider graph gate before the SCIM cascade'],
    ['drop trigger a01_auth_bookkeeping_exclusive on auth.sso_providers', 'users/client trigger', 'missing SSO provider exclusive bookkeeping lock'],
    ['drop trigger a00_case_graph_lock on auth.mfa_recovery_code_sets', 'Case graph relation closure', 'missing recovery-set statement gate'],
    ['drop trigger z99_case_graph_keys on auth.mfa_recovery_code_sets', 'Implicit FK row-key gate', 'missing recovery-set identity gate'],
    ['drop trigger a00_case_graph_lock on auth.mfa_recovery_codes', 'Case graph relation closure', 'missing recovery-code statement gate'],
    ['drop trigger z99_case_graph_keys on auth.mfa_recovery_codes', 'Implicit FK row-key gate', 'missing recovery-code row gate'],
    ['drop trigger a00_case_graph_lock on auth.scim_users', 'Case graph relation closure', 'missing SCIM identity statement gate'],
    ['drop trigger z99_case_graph_keys on auth.scim_users', 'Implicit FK row-key gate', 'missing SCIM identity row gate'],
    // #6155: the helper reads '{user_id}' as the field "{user_id}" and locks no user.
    ["create or replace trigger z99_case_graph_keys before insert or update or delete on auth.mfa_recovery_code_sets for each row execute function private.lock_case_graph_row_keys('{user_id}', '')", 'Implicit FK row-key gate', 'brace-wrapped recovery-set identity argument'],
    ["create or replace trigger z99_case_graph_keys before insert or update or delete on auth.scim_users for each row execute function private.lock_case_graph_row_keys('{user_id}', '')", 'Implicit FK row-key gate', 'brace-wrapped SCIM identity argument'],
    ["create or replace trigger a00_case_graph_lock before delete on auth.oauth_clients for each statement execute function private.lock_auth_bookkeeping_exclusive()", 'users/client trigger', 'OAuth client gate replaced by a second exclusive acquisition'],
    ["create or replace function private.lock_auth_bookkeeping_shared() returns trigger language plpgsql security definer set search_path='' as 'begin perform pg_catalog.pg_advisory_xact_lock(509,701); return null; end'", 'lock function changed', 'shared function changed to exclusive'],
    ["create function public.unreviewed_auth_locker() returns void language plpgsql security definer set search_path='' as 'begin perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]); perform 1 from auth.sessions for update; end'", 'unreviewed gated Auth bookkeeping function', 'new unreviewed G_A function'],
    ["create or replace function public.revoke_my_session(p_session_handle text) returns jsonb language plpgsql security definer set search_path='' as 'begin perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]); perform 1 from auth.sessions for update; return null; end'", 'lacks immediate exclusive lock', 'G_A exclusive moved after preamble'],
  ];
  const adminUrl = new URL(databaseUrl);
  adminUrl.username = 'supabase_admin';
  const authDriftClient = new Client({ connectionString: adminUrl.toString(), application_name: 'auth-bookkeeping-negative-controls' });
  await authDriftClient.connect();
  // pg_get_triggerdef(oid, true) omits the schema of a relation already on the
  // search path, and supabase_admin's role default puts auth there. Adopt the
  // proof connection's search path so a control differs from the real proof by
  // its mutation alone; otherwise every control "detects" the same unrelated
  // rendering difference and none of them proves anything.
  await authDriftClient.query("select set_config('search_path', $1, false)",
    [(await client.query('show search_path')).rows[0].search_path]);
  const authDriftFailures = await runAuthBookkeepingDriftControls(authDriftClient, authBookkeepingDrifts);
  assert(authDriftFailures.length === 0,
    `Auth bookkeeping drift must be detected by the verifier: ${authDriftFailures.join('; ')}`);
  await authDriftClient.end();
  console.log('PASS: Auth bookkeeping trigger, function, column and G_A negative controls are detected');
  await client.query("begin");
  const unmanaged = await client.query("select * from private.account_lifecycle_unmanaged_restrictive_fks()");
  assert(unmanaged.rows.length === 0, `unmanaged restrictive FKs in the auth.users cascade closure found: ${JSON.stringify(unmanaged.rows)}`);

  const transitiveReviews = (await client.query(`
    select parent_schema_name, parent_table_name, schema_name, table_name,
      constraint_name, delete_disposition, set_null_columns, review_reason
    from private.account_lifecycle_transitive_fk_manifest
    order by parent_schema_name, parent_table_name, schema_name, table_name, constraint_name
  `)).rows;
  assert(transitiveReviews.length === EXPECTED_TRANSITIVE_RESTRICTIVE_FK_REVIEWS,
    `expected ${EXPECTED_TRANSITIVE_RESTRICTIVE_FK_REVIEWS} reviewed restrictive edges below auth.users, found ${transitiveReviews.length}`);
  assert(transitiveReviews.every((row) => typeof row.review_reason === "string" && row.review_reason.trim().length > 0),
    "every retained or cascaded transitive edge must carry an explicit reviewed classification reason");

  const unmanagedAtEveryDepth = (await client.query(`
    with recursive cascade_nodes as (
      select 'auth.users'::regclass as relation_oid, 0::integer as depth,
        array['auth.users'::regclass] as relation_path
      union all
      select con.conrelid, cascade_nodes.depth + 1, cascade_nodes.relation_path || con.conrelid
      from cascade_nodes
      join pg_catalog.pg_constraint con
        on con.contype = 'f' and con.confrelid = cascade_nodes.relation_oid and con.confdeltype = 'c'
      where not con.conrelid = any(cascade_nodes.relation_path)
    )
    select cascade_nodes.depth + 1 as depth, con.conname
    from cascade_nodes
    join pg_catalog.pg_constraint con
      on con.contype = 'f'
     and con.confrelid = cascade_nodes.relation_oid
     and con.confdeltype in ('a', 'r')
    where cascade_nodes.depth > 0
    order by 1, 2
  `)).rows;
  assert(unmanagedAtEveryDepth.length === 0,
    `restrictive FK remains below auth.users at one or more cascade depths: ${JSON.stringify(unmanagedAtEveryDepth)}`);

  // Negative controls prove the deletion manifest is bidirectional. It must
  // detect a reviewed FK whose action regresses, a stale review after the FK
  // disappears, a second constraint on one reviewed column, and an entirely
  // missing review for a new restrictive FK.
  await expectInventoryIssue(client, "action-mismatch", `
    alter table public.organization_welcome_campaigns
      drop constraint organization_welcome_campaigns_created_by_fkey;
    alter table public.organization_welcome_campaigns
      add constraint organization_welcome_campaigns_created_by_fkey
      foreign key (created_by) references auth.users(id) on delete restrict;
  `, "public", "organization_welcome_campaigns", "created_by");
  await expectInventoryIssue(client, "stale-review", `
    alter table public.organization_welcome_campaigns
      drop constraint organization_welcome_campaigns_created_by_fkey;
  `, "public", "organization_welcome_campaigns", "created_by");
  await expectInventoryIssue(client, "duplicate-constraint", `
    alter table public.organization_welcome_campaigns
      add constraint organization_welcome_campaigns_created_by_duplicate_proof
      foreign key (created_by) references auth.users(id) on delete set null;
  `, "public", "organization_welcome_campaigns", "created_by");
  await expectInventoryIssue(client, "missing-review", `
    create table public.account_lifecycle_unreviewed_fk_control (
      actor_user_id uuid references auth.users(id) on delete restrict
    );
  `, "public", "account_lifecycle_unreviewed_fk_control", "actor_user_id");
  await expectInventoryIssue(client, "action-mismatch", `
    alter table public.casework_audit_events
      drop constraint casework_audit_events_case_id_organization_id_chapter_id_fkey;
    alter table public.casework_audit_events
      add constraint casework_audit_events_case_id_organization_id_chapter_id_fkey
      foreign key (case_id, organization_id, chapter_id) references public.member_cases(id, organization_id, chapter_id) on delete restrict;
  `, "public", "casework_audit_events", "case_id");
  // The transitive missing-review row reports the constraint's full column
  // list, so this control uses a single-column reviewed FK.
  await expectInventoryIssue(client, "missing-review", `
    alter table public.member_case_assignment_audit
      drop constraint member_case_assignment_audit_case_id_fkey;
    alter table public.member_case_assignment_audit
      add constraint member_case_assignment_audit_case_id_fkey
      foreign key (case_id) references public.member_cases(id) on delete restrict;
    delete from private.account_lifecycle_transitive_fk_manifest
    where schema_name = 'public'
      and table_name = 'member_case_assignment_audit'
      and constraint_name = 'member_case_assignment_audit_case_id_fkey';
  `, "public", "member_case_assignment_audit", "case_id");

  await proveRetainedDefinerInventory(client);

  const unmanagedExports = await client.query("select * from private.account_lifecycle_unmanaged_export_fks()");
  assert(unmanagedExports.rows.length === 0,
    `export ownership inventory drift found: ${JSON.stringify(unmanagedExports.rows)}`);

  await expectExportInventoryIssue(client, "missing-review", `
    update private.account_lifecycle_manifest
       set export_inventory_basis = null,
           export_disposition = 'not_applicable',
           export_projection = null,
           export_projection_version = null,
           export_domain = null,
           export_columns = null,
           exclusion_reason = null
     where schema_name = 'public'
       and table_name = 'chapter_thread_posts'
       and user_column = 'author_id';
  `, "public", "chapter_thread_posts", "author_id");

  const catalogCandidates = (await client.query(`
    select n.nspname as schema_name, c.relname as table_name, a.attname as user_column
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.unnest(con.conkey) with ordinality as k(attnum, ord) on true
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and n.nspname in ('public', 'private')
      and pg_catalog.array_length(con.conkey, 1) = 1
    order by 1, 2, 3
  `)).rows;
  assert(catalogCandidates.length === EXPECTED_OWNERSHIP_IDENTITY_FKS,
    `expected ${EXPECTED_OWNERSHIP_IDENTITY_FKS} independently discovered ownership identity FKs, found ${catalogCandidates.length}`);
  assert(JSON.stringify(catalogCandidates.map(row => `${row.schema_name}.${row.table_name}.${row.user_column}`).sort())
    === JSON.stringify(EXPECTED_OWNERSHIP_IDENTITY_KEYS),
    'installed ownership FK identities must exactly match the reviewed source FK inventory');

  const reviewedCandidates = (await client.query(`
    select schema_name, table_name, user_column, export_disposition,
      export_projection, export_projection_version, export_domain,
      export_columns, exclusion_reason
    from private.account_lifecycle_manifest
    where export_inventory_basis = 'auth_user_fk'
    order by 1, 2, 3
  `)).rows;
  assert(reviewedCandidates.length === EXPECTED_OWNERSHIP_IDENTITY_FKS,
    `expected ${EXPECTED_OWNERSHIP_IDENTITY_FKS} reviewed ownership rows, found ${reviewedCandidates.length}`);
  assert(JSON.stringify(reviewedCandidates.map(rowKey)) === JSON.stringify(catalogCandidates.map(rowKey)),
    "reviewed ownership inventory must exactly equal the independently discovered direct auth.users FK inventory");

  const exclusions = reviewedCandidates.filter((row) => row.export_disposition === "excluded_with_reason");
  assert(exclusions.length > 0, "ownership review must retain explicit exclusions rather than hiding omitted relations");
  for (const row of exclusions) {
    assert(typeof row.exclusion_reason === "string" && row.exclusion_reason.trim().length > 0,
      `${rowKey(row)} exclusion must state a reviewed reason`);
  }

  const canonicalRows = (await client.query(`
    select schema_name, table_name, user_column, export_projection_version, export_domain
    from private.account_lifecycle_manifest
    where export_disposition = 'included' and export_projection = 'canonical'
    order by 1, 2, 3
  `)).rows;
  assert(canonicalRows.length === CANONICAL_EXPORT_V1.size,
    `canonical v1 map has ${CANONICAL_EXPORT_V1.size} entries but manifest has ${canonicalRows.length}`);

  const exportDefinitions = (await client.query(`
    select pg_catalog.pg_get_functiondef('public.get_member_data_export()'::regprocedure)
      || E'\n'
      || pg_catalog.pg_get_functiondef('private.member_data_export_without_peer_contact()'::regprocedure) as source
  `)).rows[0].source;
  const installedExportSource = exportDefinitions.toLowerCase().replace(/\s+/g, " ");
  for (const row of canonicalRows) {
    const key = rowKey(row);
    const mapping = CANONICAL_EXPORT_V1.get(key);
    assert(mapping, `${key} is labeled canonical without an independent v1 domain mapping`);
    assert(row.export_projection_version === 1, `${key} must use canonical export projection version 1`);
    assert(row.export_domain === mapping.domain,
      `${key} maps to ${row.export_domain}, expected canonical v1 domain ${mapping.domain}`);
    for (const coverageNeedle of mapping.coverageNeedles) {
      assert(installedExportSource.includes(coverageNeedle),
        `${key} canonical v1 path is not backed by installed caller-owned projection: ${coverageNeedle}`);
    }
  }
  for (const key of CANONICAL_EXPORT_V1.keys()) {
    assert(canonicalRows.some((row) => rowKey(row) === key),
      `${key} is pinned by the canonical v1 verifier but missing from the manifest`);
  }

  const additionalRows = (await client.query(`
    select schema_name, table_name, user_column, export_projection_version,
      export_domain, export_columns
    from private.account_lifecycle_manifest
    where export_disposition = 'included' and export_projection = 'additional_domains'
    order by 1, 2, 3
  `)).rows;
  assert(additionalRows.length === SAFE_ADDITIONAL_V1.size,
    `safe additional v1 map has ${SAFE_ADDITIONAL_V1.size} entries but manifest has ${additionalRows.length}`);
  for (const row of additionalRows) {
    const key = rowKey(row);
    const expectedColumns = SAFE_ADDITIONAL_V1.get(key);
    assert(expectedColumns, `${key} is generically exported without an independent safe-column review`);
    assert(row.export_projection_version === 1, `${key} must use generic export projection version 1`);
    assert(row.export_domain === `additionalDomains.${row.table_name}`,
      `${key} has unexpected generic export domain ${row.export_domain}`);
    assert(sameColumns(row.export_columns, expectedColumns),
      `${key} safe columns drifted: ${JSON.stringify(row.export_columns)} versus ${JSON.stringify(expectedColumns)}`);
    for (const column of row.export_columns) {
      assert(!UNSAFE_GENERIC_COLUMN.test(column)
        && !["recipient_id", "recorded_by", "failure_reason"].includes(column),
      `${key} exposes unsafe generic column ${column}`);
    }
  }
  for (const key of SAFE_ADDITIONAL_V1.keys()) {
    assert(additionalRows.some((row) => rowKey(row) === key),
      `${key} is pinned by the safe additional v1 verifier but missing from the manifest`);
  }

  await client.query(
    "insert into public.organizations (id, slug, name) values ($1, 'lifecycle-manifest-proof-org', 'Lifecycle Manifest Proof Org')",
    [ids.organization],
  );
  await client.query(
    `insert into public.chapters (id, name, region, order_index, organization_id, slug)
     values ($1, 'Lifecycle Manifest Proof Chapter', 'Local proof', 509, $2, 'lifecycle-manifest-proof-chapter')`,
    [ids.chapter, ids.organization],
  );
  await client.query(
    `insert into auth.users (id, email) values
       ($1, 'lifecycle-deleting@example.invalid'),
       ($2, 'lifecycle-member@example.invalid'),
       ($3, 'lifecycle-unauthorized-staff@example.invalid'),
       ($4, 'lifecycle-authorized-staff@example.invalid')`,
    [ids.deleting, ids.member, ids.unauthorizedStaff, ids.authorizedStaff],
  );
  await client.query("update public.member_profiles set chapter_id = $1 where id = any($2::uuid[])", [
    ids.chapter,
    [ids.deleting, ids.member, ids.unauthorizedStaff, ids.authorizedStaff],
  ]);
  const proofProfiles = (await client.query(
    "select id, chapter_id from public.member_profiles where id = any($1::uuid[]) order by id",
    [[ids.deleting, ids.member, ids.unauthorizedStaff, ids.authorizedStaff]],
  )).rows;
  assert(proofProfiles.length === 4 && proofProfiles.every((row) => row.chapter_id === ids.chapter),
    `lifecycle proof identities must use the isolated organization chapter: ${JSON.stringify(proofProfiles)}`);
  await client.query("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now())", [ids.session, ids.deleting]);
  await client.query(
    "insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now()), ($3, $4, 'aal2', now())",
    [ids.unauthorizedSession, ids.unauthorizedStaff, ids.authorizedSession, ids.authorizedStaff],
  );
  await client.query(
    `insert into public.organization_memberships (organization_id, user_id, status)
     values ($1, $2, 'active'), ($1, $3, 'active')`,
    [ids.organization, ids.unauthorizedStaff, ids.authorizedStaff],
  );
  await client.query(
    `insert into public.member_chapter_memberships (user_id, chapter_id, status)
     values ($1, $3, 'active'), ($2, $3, 'active')`,
    [ids.unauthorizedStaff, ids.authorizedStaff, ids.chapter],
  );
  await client.query(
    `insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
     values (true, $1, false, $2)`,
    [ids.organization, ids.deleting],
  );
  await client.query(
    `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
     values ($1, $2, 'steward', $3), ($1, $4, 'coordinator', $3)`,
    [ids.organization, ids.unauthorizedStaff, ids.deleting, ids.authorizedStaff],
  );
  // Upstream decision of November 10, 2026: this retained-authority fixture is pre-migration.
  await migrateLegacyStewardFixtures(client);

  // Cascade disposition: the relationship's essential subject is gone, so the
  // row itself must disappear, not survive with a null steward.
  await client.query(
    `insert into public.member_steward_relationships (organization_id, chapter_id, member_user_id, steward_user_id)
     values ($1, $2, $3, $4)`,
    [ids.organization, ids.chapter, ids.member, ids.deleting],
  );

  // Pseudonymize disposition, single NOT NULL column that had to be relaxed.
  const campaignId = (await client.query(
    `insert into public.organization_welcome_campaigns (organization_id, name, created_by)
     values ($1, 'Lifecycle proof campaign', $2) returning id`,
    [ids.organization, ids.deleting],
  )).rows[0].id;

  // Pseudonymize disposition, two independently-managed columns on one table.
  const actionId = (await client.query(
    `insert into public.digital_actions (organization_id, action_kind, title, summary, created_by, updated_by)
     values ($1, 'petition', 'Lifecycle proof action', 'proof', $2, $2) returning id`,
    [ids.organization, ids.deleting],
  )).rows[0].id;

  // Trigger/CHECK-sensitive historical rows must all survive deletion of a
  // staff attribution identity. The substantive state lives under a different
  // member, so a cascade of the member-owned case cannot conceal a broken SET
  // NULL action.
  const sensitiveCase = (await client.query(
    `insert into public.member_cases (
       id, user_id, reference, title, case_type,
       is_restricted, restriction_reason, restricted_at, restricted_by,
       created_at, updated_at
     ) values (
       $1, $2, 'LIFECYCLE-PROOF-SENSITIVE', 'Sensitive lifecycle history', 'grievance',
       true, 'Lifecycle restriction remains historical', now(), $3,
       now() - interval '1 day', now() - interval '1 day'
     ) returning id, organization_id, chapter_id, restricted_at::text as restricted_at`,
    [ids.sensitiveCase, ids.member, ids.deleting],
  )).rows[0];
  assert(sensitiveCase.organization_id === ids.organization && sensitiveCase.chapter_id === ids.chapter,
    `sensitive history case must retain isolated ownership: ${JSON.stringify(sensitiveCase)}`);

  const caseworkAuditId = (await client.query(
    `insert into public.casework_audit_events (
       organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata
     ) values ($1, $2, $3, $4, 'deadline_requested', 'deadline_extension', extensions.gen_random_uuid(), '{"proof":"attribution"}'::jsonb)
     returning id, created_at::text as created_at`,
    [sensitiveCase.organization_id, sensitiveCase.chapter_id, sensitiveCase.id, ids.deleting],
  )).rows[0];

  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.member, role: "authenticated" })]);
  await client.query(
    `insert into public.chapter_spaces (id, chapter_id, name, description, created_by)
     values ($1, $2, 'Lifecycle proof space', 'Local rollback-only proof', $3)`,
    [ids.space, sensitiveCase.chapter_id, ids.member],
  );
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ids.deleting, role: "authenticated" })]);
  const poll = (await client.query(
    `insert into public.chapter_channel_polls (space_id, question)
     values ($1, 'Does referential detachment retain this poll?')
     returning id, updated_at::text as updated_at`,
    [ids.space],
  )).rows[0];
  await client.query("select set_config('request.jwt.claims', '{}', true)");

  const accessGrant = (await client.query(
    `insert into public.casework_access_grants (
       case_id, organization_id, chapter_id, grantee_user_id, granted_by,
       reason, revoked_at, revoked_by
     ) values ($1, $2, $3, $4, $4, 'Lifecycle access grant history', now(), $5)
     returning id, revoked_at::text as revoked_at`,
    [sensitiveCase.id, sensitiveCase.organization_id, sensitiveCase.chapter_id, ids.member, ids.deleting],
  )).rows[0];

  const deadline = (await client.query(
    `insert into public.casework_deadlines (
       case_id, organization_id, chapter_id, kind, label, due_at, created_by
     ) values ($1, $2, $3, 'filing', 'Lifecycle proof deadline', now() + interval '1 day', $4)
     returning id, due_at::text as due_at`,
    [sensitiveCase.id, sensitiveCase.organization_id, sensitiveCase.chapter_id, ids.member],
  )).rows[0];
  const extension = (await client.query(
    `insert into public.casework_deadline_extensions (
       deadline_id, organization_id, requested_by, previous_due_at,
       requested_due_at, reason, status, decided_by, decided_at, idempotency_key
     ) values (
       $1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 day', 'Lifecycle extension history',
       'approved', $5, now(), extensions.gen_random_uuid()
     ) returning id, decided_at::text as decided_at`,
    [deadline.id, sensitiveCase.organization_id, ids.member, deadline.due_at, ids.deleting],
  )).rows[0];

  const checklist = (await client.query(
    `insert into public.casework_checklists (
       case_id, organization_id, chapter_id, step, title, created_by
     ) values ($1, $2, $3, 'Intake', 'Lifecycle proof checklist', $4)
     returning id`,
    [sensitiveCase.id, sensitiveCase.organization_id, sensitiveCase.chapter_id, ids.member],
  )).rows[0];
  const checklistItem = (await client.query(
    `insert into public.casework_checklist_items (
       checklist_id, organization_id, label, position, completed_at, completed_by
     ) values ($1, $2, 'Retain completion history', 0, now(), $3)
     returning id, completed_at::text as completed_at`,
    [checklist.id, sensitiveCase.organization_id, ids.deleting],
  )).rows[0];

  // Relaxed CHECKs retain pseudonymized history, but must not let application
  // writes manufacture actorless restricted/revoked/decided/completed state.
  for (const [label, statement, values] of [
    [
      "restricted case insert",
      `insert into public.member_cases (
         id, user_id, reference, title, case_type,
         is_restricted, restriction_reason, restricted_at
       ) values ($1, $2, 'LIFECYCLE-ACTORLESS-CONTROL', 'Actorless control', 'grievance',
         true, 'Actorless restricted state must fail closed', now())`,
      ["50900500-0000-4000-8000-000000000010", ids.member],
    ],
    [
      "revoked grant insert",
      `insert into public.casework_access_grants (
         case_id, organization_id, chapter_id, grantee_user_id, granted_by,
         reason, revoked_at
       ) values ($1, $2, $3, $4, $4, 'Actorless revocation control', now())`,
      [sensitiveCase.id, sensitiveCase.organization_id, sensitiveCase.chapter_id, ids.member],
    ],
    [
      "deadline decision insert",
      `insert into public.casework_deadline_extensions (
         deadline_id, organization_id, requested_by, previous_due_at,
         requested_due_at, reason, status, decided_at, idempotency_key
       ) values ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '2 days',
         'Actorless deadline decision control', 'approved', now(), extensions.gen_random_uuid())`,
      [deadline.id, sensitiveCase.organization_id, ids.member, deadline.due_at],
    ],
    [
      "completed checklist insert",
      `insert into public.casework_checklist_items (
         checklist_id, organization_id, label, position, completed_at
       ) values ($1, $2, 'Actorless completion control', 1, now())`,
      [checklist.id, sensitiveCase.organization_id],
    ],
  ]) {
    await expectSqlState(client, label, statement, values, "23514");
  }

  const sensitiveHistoryIds = {
    caseworkAudit: caseworkAuditId.id,
    poll: poll.id,
    restrictedCase: sensitiveCase.id,
    accessGrant: accessGrant.id,
    extension: extension.id,
    checklistItem: checklistItem.id,
  };
  const sensitiveHistoryBefore = await readSensitiveHistory(client, sensitiveHistoryIds);

  // Every direct ordinary attribution clearing attempt must fail. Relaxing a
  // paired CHECK alone would otherwise let privileged application code forge
  // the same shape as a referential action.
  // casework_audit_events carries no append-only trigger (the retired W2
  // deadline audit table did), so it is proven below through the SET NULL
  // detachment path rather than through an ordinary-clearing refusal.
  for (const [label, statement, values] of [
    ["chapter_channel_polls", "update public.chapter_channel_polls set created_by = null where id = $1", [poll.id]],
    ["member_cases", "update public.member_cases set restricted_by = null where id = $1", [sensitiveCase.id]],
    ["casework_access_grants", "update public.casework_access_grants set revoked_by = null where id = $1", [accessGrant.id]],
    ["casework_deadline_extensions", "update public.casework_deadline_extensions set decided_by = null where id = $1", [extension.id]],
    ["casework_checklist_items", "update public.casework_checklist_items set completed_by = null where id = $1", [checklistItem.id]],
  ]) {
    await expectOrdinaryAttributionClearingRefusal(client, label, statement, values);
  }

  // Export domains: a chained Q&A thread, a weekly-question support of
  // another member's question, a private Compass briefing, and a case file.
  const questionId = (await client.query(
    `insert into public.member_qa_questions (id, organization_id, chapter_id, author_user_id, title, body)
     values ($1, $2, 'lifecycle-proof', $3, 'Lifecycle proof question', 'Lifecycle proof question body content') returning id`,
    [ids.question, ids.organization, ids.deleting],
  )).rows[0].id;
  const replyId = (await client.query(
    `insert into public.member_qa_replies (organization_id, question_id, author_user_id, kind, body)
     values ($1, $2, $3, 'official', 'Lifecycle proof reply body content') returning id`,
    [ids.organization, questionId, ids.deleting],
  )).rows[0].id;
  await client.query(
    `insert into public.member_qa_votes (organization_id, user_id, reply_id) values ($1, $2, $3)`,
    [ids.organization, ids.deleting, replyId],
  );

  await client.query(
    `insert into public.member_weekly_questions (id, chapter_id, user_id, week_start, body)
     values ($1, 'lifecycle-proof', $2, current_date, 'other member''s weekly question')`,
    [ids.otherQuestion, ids.member],
  );
  await client.query(
    `insert into public.member_weekly_question_supports (question_id, user_id) values ($1, $2)`,
    [ids.otherQuestion, ids.deleting],
  );

  await client.query(
    `insert into public.compass_message_briefings (organization_id, requested_by, source_kind, target_id, summary)
     values ($1, $2, 'private', extensions.gen_random_uuid(), 'lifecycle proof briefing summary')`,
    [ids.organization, ids.deleting],
  );

  await client.query(
    `insert into public.member_cases (id, user_id, reference, title, case_type)
     values ($1, $2, 'LIFECYCLE-PROOF-1', 'Lifecycle proof case', 'grievance')`,
    [ids.case, ids.deleting],
  );
  await client.query(
    `insert into public.member_case_files (case_id, user_id, object_name, filename, mime_type, size_bytes, uploaded_by)
     values ($1, $2, 'lifecycle-proof/object.pdf', 'object.pdf', 'application/pdf', 1024, $2)`,
    [ids.case, ids.deleting],
  );

  // This is the regression that direct-only FK discovery missed: the account
  // being deleted owns this case. The case itself cascades from auth.users,
  // while its deadline and casework histories must remain truthful evidence
  // with their now-deleted parent references detached. The actor is the other
  // fixture member so the assertions distinguish case detachment from direct
  // auth-attribution pseudonymization.
  const ownedCase = (await client.query(
    `insert into public.member_cases (
       user_id, reference, title, case_type, coordinator_user_id,
       is_restricted, restriction_reason, restricted_at, restricted_by
     ) values (
       $1, 'LIFECYCLE-OWNER-TRANSITIVE', 'Owned transitive lifecycle case', 'grievance', $2,
       true, 'Owned-case retained history remains restricted', now(), $1
     )
     returning id, organization_id, chapter_id`,
    [ids.deleting, ids.authorizedStaff],
  )).rows[0];
  const managementPerson = (await client.query(
    `insert into public.casework_management_people (
       organization_id, chapter_id, display_name, created_by
     ) values ($1, $2, 'Lifecycle retained scope manager', $3) returning id`,
    [ownedCase.organization_id, ownedCase.chapter_id, ids.deleting],
  )).rows[0];
  const ownedManagementEntry = (await client.query(
    `insert into public.casework_management_entries (
       management_person_id, case_id, organization_id, chapter_id, occurred_at,
       category, summary, created_by
     ) values ($1, $2, $3, $4, now(), 'retaliation',
       'Restricted management summary must retain its original reader scope.', $5)
     returning id`,
    [managementPerson.id, ownedCase.id, ownedCase.organization_id, ownedCase.chapter_id, ids.deleting],
  )).rows[0];
  const ownedManagementAddendum = (await client.query(
    `insert into public.casework_management_addenda (entry_id, organization_id, body, created_by)
     values ($1, $2, 'Restricted management addendum retains the entry reader scope.', $3)
     returning id`,
    [ownedManagementEntry.id, ownedCase.organization_id, ids.deleting],
  )).rows[0];
  const ownedRetaliationId = "50900500-0000-4000-8000-000000000021";
  const envelope = (field, dataVersion) => ({
    organization: ownedCase.organization_id,
    record: ownedRetaliationId,
    field,
    purpose: "casework_retaliation_reports",
    schema: "1",
    payload: {},
    wrappedKey: {},
    keyVersion: "proof",
    dataVersion,
  });
  await client.query("select set_config('app.sensitive_maintenance','on',true), set_config('app.sensitive_envelopes',$1,true)", [JSON.stringify({
    management_person: envelope("management_person", "50900500-0000-4000-8000-000000000022"),
    protected_activity: envelope("protected_activity", "50900500-0000-4000-8000-000000000023"),
    adverse_action: envelope("adverse_action", "50900500-0000-4000-8000-000000000024"),
    requested_support: envelope("requested_support", "50900500-0000-4000-8000-000000000025"),
  })]);
  const ownedRetaliationReport = (await client.query(
    `insert into public.casework_retaliation_reports (
       id, organization_id, chapter_id, reporter_user_id, case_id, incident_at,
       management_person, protected_activity, adverse_action, requested_support, idempotency_key
     ) values ($1, $2, $3, $4, $5, now(), '[encrypted]', '[encrypted]', '[encrypted]', '[encrypted]', extensions.gen_random_uuid())
     returning id`,
    [ownedRetaliationId, ownedCase.organization_id, ownedCase.chapter_id, ids.deleting, ownedCase.id],
  )).rows[0];
  await client.query("select set_config('app.sensitive_maintenance','off',true), set_config('app.sensitive_envelopes','',true)");
  const ownedAssignmentAudit = (await client.query(
    `insert into public.member_case_assignment_audit (
       case_id, actor_id, actor_name, before_assignment, after_assignment
     ) values ($1, $2, 'Lifecycle authorized coordinator',
       '{"coordinator":null}'::jsonb, '{"coordinator":"assigned"}'::jsonb)
     returning id`,
    [ownedCase.id, ids.authorizedStaff],
  )).rows[0];
  const ownedCaseworkAudit = (await client.query(
    `insert into public.casework_audit_events (
       organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata
     ) values ($1, $2, $3, $4, 'deadline_requested', 'deadline_change', extensions.gen_random_uuid(), '{"proof":"owned-case"}'::jsonb)
     returning id`,
    [ownedCase.organization_id, ownedCase.chapter_id, ownedCase.id, ids.member],
  )).rows[0];
  const ownedDeadline = (await client.query(
    `insert into public.casework_deadlines (
       case_id, organization_id, chapter_id, kind, label, due_at, created_by
     ) values ($1, $2, $3, 'filing', 'Owned-case retained extension parent', now() + interval '3 days', $4)
     returning id, due_at::text as due_at`,
    [ownedCase.id, ownedCase.organization_id, ownedCase.chapter_id, ids.deleting],
  )).rows[0];
  const ownedExtension = (await client.query(
    `insert into public.casework_deadline_extensions (
       deadline_id, organization_id, requested_by, previous_due_at,
       requested_due_at, reason, status, decided_by, decided_at, idempotency_key
     ) values (
       $1, $2, $3, $4::timestamptz, $4::timestamptz + interval '1 day',
       'Owned-case extension trail survives with a detached deadline.', 'approved', $5, now(), extensions.gen_random_uuid()
     ) returning id`,
    [ownedDeadline.id, ownedCase.organization_id, ids.deleting, ownedDeadline.due_at, ids.member],
  )).rows[0];

  await client.query(`insert into public.casework_access_grants
    (case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
    values ($1,$2,$3,$4,$5,'Grant alone must never satisfy assignment conjunction.')`,
    [ownedCase.id, ownedCase.organization_id, ownedCase.chapter_id, ids.unauthorizedStaff, ids.authorizedStaff]);
  const retainedProofRows = [ownedManagementEntry.id, ownedManagementAddendum.id, ownedRetaliationReport.id, ownedAssignmentAudit.id];
  await proveRetainedAuthorization(client, ids, retainedProofRows, 'before deletion');
  await proveRetainedWriterBoundaries(client, ids, retainedProofRows, 'before deletion');
  await proveAdditionalRetainedReads(client, ids, ownedCaseworkAudit.id, ownedExtension.id, 'before deletion');
  await proveTriggerNegativeControls(client, ids.deleting);

  // This is the concrete pre-fix leak: both staff identities are chapter
  // stewards, but only the assigned steward may read this restricted case.
  // The same assertions run again after case_id is detached through the real
  // auth.users cascade and RLS policies, rather than through a helper call.
  for (const [reader, sessionId, shouldRead, label] of [
    [ids.unauthorizedStaff, ids.unauthorizedSession, false, "unauthorized chapter staff before deletion"],
    [ids.authorizedStaff, ids.authorizedSession, true, "authorized assigned coordinator before deletion"],
  ]) {
    await assertRetainedCaseRowsVisible(client, reader, ownedManagementEntry.id, ownedManagementAddendum.id,
      ownedRetaliationReport.id, ownedAssignmentAudit.id, sessionId, shouldRead, label);
  }

  await asRole(client, "authenticated", { sub: ids.deleting, aal: "aal2", session_id: ids.session });
  const exported = (await client.query("select public.get_member_data_export() as value")).rows[0].value;
  await client.query("reset role");

  const additional = exported.additionalDomains;
  assert(additional && typeof additional === "object", "export must carry a manifest-driven additionalDomains object");

  const manifestDomains = (await client.query(
    `select table_name from private.account_lifecycle_manifest
     where export_disposition = 'included' and export_projection = 'additional_domains'
     order by table_name`,
  )).rows.map((row) => row.table_name);
  assert(manifestDomains.length === SAFE_ADDITIONAL_V1.size,
    `expected ${SAFE_ADDITIONAL_V1.size} safe generic domains, found ${manifestDomains.length}`);
  for (const table of manifestDomains) {
    assert(Object.prototype.hasOwnProperty.call(additional, table), `additionalDomains is missing manifest domain ${table}`);
    assert(Array.isArray(additional[table]), `additionalDomains.${table} must be an array`);
  }

  for (const [key, mapping] of CANONICAL_EXPORT_V1) {
    assert(exportPathExists(exported, mapping.domain),
      `${key} canonical v1 response path ${mapping.domain} is missing`);
  }

  assert(additional.member_qa_questions.some((row) => row.id === questionId), "export must include the caller's own Q&A question");
  assert(additional.member_qa_replies.some((row) => row.id === replyId), "export must include the caller's own Q&A reply");
  assert(additional.member_qa_votes.length === 1, "export must include the caller's own Q&A vote");
  assert(additional.member_weekly_question_supports.some((row) => row.question_id === ids.otherQuestion),
    "export must include the caller's support of another member's weekly question");
  assert(additional.compass_message_briefings.length === 1, "export must include the caller's own private Compass briefing");
  assert(additional.member_case_files.length === 1, "export must include a file attached to the caller's own case");
  const exportedCaseFile = additional.member_case_files[0];
  for (const unsafeField of ["bucket_id", "object_name", "user_id", "uploaded_by"]) {
    assert(!Object.prototype.hasOwnProperty.call(exportedCaseFile, unsafeField),
      `privacy-safe case-file projection must omit ${unsafeField}`);
  }
  const exportedQuestion = additional.member_qa_questions.find((row) => row.id === questionId);
  assert(exportedQuestion, "canonical Q&A projection must include the caller's question");
  for (const unsafeField of ["author_user_id", "idempotency_key"]) {
    assert(!Object.prototype.hasOwnProperty.call(exportedQuestion, unsafeField),
      `privacy-safe Q&A projection must omit ${unsafeField}`);
  }
  assert(typeof exported.peerContact === "object" && exported.peerContact !== null,
    "the pre-existing single-audit peerContact wrapper must survive folding in additionalDomains");

  // The irreversible operation: transactionally delete a user represented in
  // every disposition category and every export domain fixture above.
  await client.query("reset role");
  await client.query("delete from auth.users where id = $1", [ids.deleting]);

  await proveRetainedAuthorization(client, ids, retainedProofRows, 'after deletion');
  await proveRetainedWriterBoundaries(client, ids, retainedProofRows, 'after deletion');
  await proveAdditionalRetainedReads(client, ids, ownedCaseworkAudit.id, ownedExtension.id, 'after deletion');

  const relationship = await client.query(
    "select count(*)::int n from public.member_steward_relationships where organization_id = $1 and member_user_id = $2",
    [ids.organization, ids.member],
  );
  assert(relationship.rows[0].n === 0, "cascade disposition must remove the steward relationship, not leave a null steward");

  const campaign = (await client.query("select created_by from public.organization_welcome_campaigns where id = $1", [campaignId])).rows[0];
  assert(campaign && campaign.created_by === null, "pseudonymize disposition must retain the campaign with attribution cleared");

  const action = (await client.query("select created_by, updated_by from public.digital_actions where id = $1", [actionId])).rows[0];
  assert(action && action.created_by === null && action.updated_by === null,
    "pseudonymize disposition must clear both attribution columns on the same table");

  const sensitiveHistoryAfter = await readSensitiveHistory(client, sensitiveHistoryIds);
  assert(isDeepStrictEqual(sensitiveHistoryAfter, sensitiveHistoryBefore),
    `referential detachment must preserve every non-actor field: ${JSON.stringify({ sensitiveHistoryBefore, sensitiveHistoryAfter })}`);

  const sensitiveHistoryDetached = (await client.query(`
    select
      exists(select 1 from public.casework_audit_events where id = $1 and actor_user_id is null) as casework_audit_ok,
      exists(select 1 from public.chapter_channel_polls where id = $2 and created_by is null) as poll_ok,
      exists(select 1 from public.member_cases where id = $3 and restricted_by is null and is_restricted) as restriction_ok,
      exists(select 1 from public.casework_access_grants where id = $4 and revoked_by is null and revoked_at is not null) as access_grant_ok,
      exists(select 1 from public.casework_deadline_extensions where id = $5 and decided_by is null and status = 'approved' and decided_at is not null) as extension_ok,
      exists(select 1 from public.casework_checklist_items where id = $6 and completed_by is null and completed_at is not null) as checklist_ok
  `, [
    sensitiveHistoryIds.caseworkAudit,
    sensitiveHistoryIds.poll,
    sensitiveHistoryIds.restrictedCase,
    sensitiveHistoryIds.accessGrant,
    sensitiveHistoryIds.extension,
    sensitiveHistoryIds.checklistItem,
  ])).rows[0];
  assert(Object.values(sensitiveHistoryDetached).every(Boolean),
    `every trigger/CHECK-sensitive historical row must survive with only its actor detached: ${JSON.stringify(sensitiveHistoryDetached)}`);

  const question = await client.query("select 1 from public.member_qa_questions where id = $1", [questionId]);
  assert(question.rows.length === 0, "the caller's own Q&A question is already ON DELETE CASCADE and must be removed with the account, not blocked");

  const ownedCaseResidue = (await client.query(`
    select
      not exists(select 1 from public.member_cases where id = $1) as owner_case_cascaded,
      exists(select 1 from public.casework_audit_events where id = $3 and case_id is null and actor_user_id = $2) as casework_audit_retained,
      exists(select 1 from public.casework_deadline_extensions where id = $4 and deadline_id is null and requested_by is null and decided_by = $2) as deadline_extension_retained,
      exists(select 1 from public.member_cases where id = $5 and user_id = $2) as other_member_case_untouched,
      exists(select 1 from public.casework_management_entries where id = $6 and case_id is null) as management_entry_detached,
      exists(select 1 from public.casework_management_addenda where id = $7) as management_addendum_retained,
      exists(select 1 from public.casework_retaliation_reports where id = $8 and case_id is null and reporter_user_id is null) as retaliation_report_detached,
      exists(select 1 from public.member_case_assignment_audit where id = $9 and case_id is null) as assignment_audit_detached,
      exists(select 1 from private.account_lifecycle_history_scope h join private.account_lifecycle_case_scope c on c.case_id=h.case_id where h.kind='management_entry' and h.record_id = $6::text and c.coordinator_user_id=$10 and c.steward_user_id is distinct from $11) as management_scope_preserved,
      exists(select 1 from private.account_lifecycle_history_scope h join private.account_lifecycle_case_scope c on c.case_id=h.case_id where h.kind='retaliation_report' and h.record_id = $8::text and c.coordinator_user_id=$10 and c.steward_user_id is distinct from $11) as retaliation_scope_preserved,
      exists(select 1 from private.account_lifecycle_history_scope h join private.account_lifecycle_case_scope c on c.case_id=h.case_id where h.kind='assignment_audit' and h.record_id = $9::text and c.coordinator_user_id=$10 and c.steward_user_id is distinct from $11) as assignment_scope_preserved
  `, [
    ownedCase.id,
    ids.member,
    ownedCaseworkAudit.id,
    ownedExtension.id,
    sensitiveCase.id,
    ownedManagementEntry.id,
    ownedManagementAddendum.id,
    ownedRetaliationReport.id,
    ownedAssignmentAudit.id,
    ids.authorizedStaff,
    ids.unauthorizedStaff,
  ])).rows[0];
  assert(Object.values(ownedCaseResidue).every(Boolean),
    `owner-case delete must cascade essential rows and retain only detached transitive history: ${JSON.stringify(ownedCaseResidue)}`);

  for (const [reader, sessionId, shouldRead, label] of [
    [ids.unauthorizedStaff, ids.unauthorizedSession, false, "unauthorized chapter staff after deletion"],
    [ids.authorizedStaff, ids.authorizedSession, true, "authorized assigned coordinator after deletion"],
  ]) {
    await assertRetainedCaseRowsVisible(client, reader, ownedManagementEntry.id, ownedManagementAddendum.id,
      ownedRetaliationReport.id, ownedAssignmentAudit.id, sessionId, shouldRead, label);
  }
  await client.query("reset role");
  await expectSqlState(client, "ordinary assignment-audit UPDATE after detached case",
    "update public.member_case_assignment_audit set actor_name = 'forged' where id = $1", [ownedAssignmentAudit.id], "42501");
  await expectSqlState(client, "ordinary assignment-audit DELETE after detached case",
    "delete from public.member_case_assignment_audit where id = $1", [ownedAssignmentAudit.id], "42501");

  assert((await client.query("select count(*)::int n from auth.users where id = $1", [ids.member])).rows[0].n === 1,
    "deletion must not remove another account");

  await client.query("delete from auth.users where id=$1", [ids.unauthorizedStaff]);
  await assertRetainedCaseRowsVisible(client, ids.authorizedStaff, ownedManagementEntry.id, ownedManagementAddendum.id,
    ownedRetaliationReport.id, ownedAssignmentAudit.id, ids.authorizedSession, true, "authorized reader after subsequent account deletion");

  // A later deletion must apply the live case's FK semantics to retained
  // inputs too. Re-provisioning that UUID must not resurrect old assignments.
  await client.query("delete from auth.users where id=$1", [ids.authorizedStaff]);
  await client.query("insert into auth.users(id,email) values ($1,'lifecycle-reprovisioned@example.invalid')",[ids.authorizedStaff]);
  await client.query("update public.member_profiles set chapter_id=$1 where id=$2",[ids.chapter,ids.authorizedStaff]);
  await client.query("insert into auth.sessions(id,user_id,aal,created_at) values ($1,$2,'aal2',now())",[ids.authorizedSession,ids.authorizedStaff]);
  await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",[ids.organization,ids.authorizedStaff]);
  await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')",[ids.authorizedStaff,ids.chapter]);
  await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'coordinator',$3)",[ids.organization,ids.authorizedStaff,ids.member]);
  await assertRetainedCaseRowsVisible(client, ids.authorizedStaff, ownedManagementEntry.id, ownedManagementAddendum.id,
    ownedRetaliationReport.id, ownedAssignmentAudit.id, ids.authorizedSession, false, "reprovisioned deleted reader has no retained assignment or grant");

  await client.query("rollback");
  const residue = await client.query("select count(*)::int n from auth.users where id = any($1::uuid[])", [[
    ids.deleting, ids.member, ids.unauthorizedStaff, ids.authorizedStaff,
  ]]);
  assert(residue.rows[0].n === 0, "rollback-only proof must leave no identity fixtures");
  for (const graphRace of ['addendum', 'withdrawal', 'revokingStaff', 'handoff', 'survey']) {
    for (const deletionFirst of [false, true]) {
      await proveConcurrentGrantRevocation(client, databaseUrl, { graphRace, deletionFirst });
    }
  }
  await proveCatalogueWriterEntry(client, databaseUrl, reviewedGraph.tables);
  await proveConcurrentGrantRevocation(client, databaseUrl);
  await proveMidGrantRevocation(client, databaseUrl);
  await proveOverlappingIdentityDeletion(client, databaseUrl);
  const triggerIssues = await client.query("select * from private.account_lifecycle_referential_action_trigger_issues()");
  assert(triggerIssues.rows.length === 0, `reviewed lifecycle FK actions have an unreviewed blocking trigger: ${JSON.stringify(triggerIssues.rows)}`);
  console.log(`PASS: zero unmanaged restrictive FKs plus action-mismatch, stale-review, duplicate-constraint, and missing-review negative controls; ${EXPECTED_OWNERSHIP_IDENTITY_FKS} direct identity relations across every delete action exactly match the bidirectional reviewed export inventory, including the SET NULL ownership-hide regression; retained management, addendum, retaliation, and assignment-audit histories preserve fail-closed pre-deletion reader scope through real RLS; ordinary audit UPDATE/DELETE remain 42501; every lifecycle referential-action trigger is enumerated; fixture transaction rolled back cleanly.`);
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}

async function expectInventoryIssue(pgClient, issue, mutationSql, schemaName, tableName, userColumn) {
  const savepoint = `sp_inventory_${issue.replace(/-/g, "_")}`;
  await pgClient.query(`savepoint ${savepoint}`);
  try {
    await pgClient.query(mutationSql);
    const rows = (await pgClient.query(
      `select inventory_issue
       from private.account_lifecycle_unmanaged_restrictive_fks()
       where schema_name = $1 and table_name = $2 and user_column = $3`,
      [schemaName, tableName, userColumn],
    )).rows;
    assert(rows.length === 1 && rows[0].inventory_issue === issue,
      `${issue} negative control returned ${JSON.stringify(rows)}`);
  } finally {
    await pgClient.query(`rollback to savepoint ${savepoint}`);
    await pgClient.query(`release savepoint ${savepoint}`);
  }
}

async function expectExportInventoryIssue(pgClient, issue, mutationSql, schemaName, tableName, userColumn) {
  const savepoint = `sp_export_inventory_${issue.replace(/-/g, "_")}`;
  await pgClient.query(`savepoint ${savepoint}`);
  try {
    await pgClient.query(mutationSql);
    const rows = (await pgClient.query(
      `select inventory_issue
       from private.account_lifecycle_unmanaged_export_fks()
       where schema_name = $1 and table_name = $2 and user_column = $3`,
      [schemaName, tableName, userColumn],
    )).rows;
    assert(rows.length === 1 && rows[0].inventory_issue === issue,
      `${issue} export negative control returned ${JSON.stringify(rows)}`);
  } finally {
    await pgClient.query(`rollback to savepoint ${savepoint}`);
    await pgClient.query(`release savepoint ${savepoint}`);
  }
}

async function readSensitiveHistory(pgClient, historyIds) {
  return (await pgClient.query(`
    select pg_catalog.jsonb_build_object(
      'caseworkAudit', (select pg_catalog.to_jsonb(audit_row) - 'actor_user_id' from public.casework_audit_events audit_row where audit_row.id = $1),
      'poll', (select pg_catalog.to_jsonb(poll_row) - 'created_by' from public.chapter_channel_polls poll_row where poll_row.id = $2),
      'restrictedCase', (select pg_catalog.to_jsonb(case_row) - 'restricted_by' from public.member_cases case_row where case_row.id = $3),
      'accessGrant', (select pg_catalog.to_jsonb(grant_row) - 'revoked_by' from public.casework_access_grants grant_row where grant_row.id = $4),
      'extension', (select pg_catalog.to_jsonb(extension_row) - 'decided_by' from public.casework_deadline_extensions extension_row where extension_row.id = $5),
      'checklistItem', (select pg_catalog.to_jsonb(item_row) - 'completed_by' from public.casework_checklist_items item_row where item_row.id = $6)
    ) as value
  `, [
    historyIds.caseworkAudit,
    historyIds.poll,
    historyIds.restrictedCase,
    historyIds.accessGrant,
    historyIds.extension,
    historyIds.checklistItem,
  ])).rows[0].value;
}

async function assertRetainedCaseRowsVisible(pgClient, readerId, entryId, addendumId, reportId, auditId, sessionId, expected, label) {
  await asRole(pgClient, "authenticated", { sub: readerId, aal: "aal2", session_id: sessionId });
  const visibility = (await pgClient.query(`
    select
      exists(select 1 from public.casework_management_entries where id = $1) as management_entry,
      exists(select 1 from public.casework_management_addenda where id = $2) as management_addendum,
      exists(select 1 from public.casework_retaliation_reports where id = $3) as retaliation_report,
      exists(select 1 from public.member_case_assignment_audit where id = $4) as assignment_audit
  `, [entryId, addendumId, reportId, auditId])).rows[0];
  await pgClient.query("reset role");
  assert(Object.values(visibility).every((value) => value === expected),
    `${label} visibility mismatch: ${JSON.stringify(visibility)}`);
}

async function expectSqlState(pgClient, label, statement, values, expectedCode) {
  const savepoint = "sp_actorless_state_control";
  await pgClient.query(`savepoint ${savepoint}`);
  let refusal;
  try {
    await pgClient.query(statement, values);
  } catch (error) {
    refusal = error;
  }
  await pgClient.query(`rollback to savepoint ${savepoint}`);
  await pgClient.query(`release savepoint ${savepoint}`);
  assert(refusal?.code === expectedCode,
    `${label} expected SQLSTATE ${expectedCode}, got ${refusal?.code || refusal?.message || "no refusal"}`);
}

async function expectOrdinaryAttributionClearingRefusal(pgClient, label, statement, values) {
  const savepoint = "sp_ordinary_attribution_clearing";
  await pgClient.query(`savepoint ${savepoint}`);
  let refusal;
  try {
    await pgClient.query(statement, values);
  } catch (error) {
    refusal = error;
  }
  await pgClient.query(`rollback to savepoint ${savepoint}`);
  await pgClient.query(`release savepoint ${savepoint}`);
  assert(refusal?.code === "42501",
    `${label} ordinary attribution clearing expected SQLSTATE 42501, got ${refusal?.code || refusal?.message || "no refusal"}`);
}
