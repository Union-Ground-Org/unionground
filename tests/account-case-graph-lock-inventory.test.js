// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import {keyAssuranceMigrationPath} from '../scripts/lib/key-assurance-delivery.mjs';
const keyAssuranceMigration=readFileSync(keyAssuranceMigrationPath,'utf8');
import { describe, expect, it } from 'vitest';
import { reviewedReadAdmission, sharedReadEntry } from '../scripts/account-case-graph-inventory.mjs';
import { acquisition, authBookkeepingAccessSequence, authBookkeepingAccessTargets, authBookkeepingChildTables, authBookkeepingCoveredUsersFirst, authBookkeepingExemptions, authBookkeepingExclusiveAfterGate, authBookkeepingFunctionIssues, authUserCoveredColumns, caseGraphWrappedSource, codeOnly, deriveRelations, expectedAuthUsersTriggerDefinition, foreignKeyMigrationDigest, foreignKeyRelevance, normalizeForeignKeyRow, referenceColumns, reviewedForeignKeys, rowKeyArgumentIssues, rowKeyArguments, rowKeyAuthColumns, rowKeyColumns, plainRowKeyTables, helperFirst, inventoryIssues, parseFunctions, readMigrationFunctions, reviewedGraph, runAuthBookkeepingDriftControls } from '../scripts/account-case-graph-inventory.mjs';

const functions = readMigrationFunctions('supabase/migrations');
const authAdoptionMigration = readFileSync('supabase/migrations/20261027011927_auth_2121_case_graph_adoption.sql', 'utf8');
const authRowKeyRepairMigration = readFileSync('supabase/migrations/20261028131832_auth_recovery_scim_row_key_user_lock.sql', 'utf8');
const announcementsMigration = readFileSync('supabase/migrations/20261029141540_platform_announcements_backend.sql', 'utf8');
const cosmeticsMigration = readFileSync('supabase/migrations/20261029235156_no_cost_cosmetic_rewards.sql', 'utf8');
const unitCommitteeMigration = readFileSync('supabase/migrations/20261102005607_unit_committee_scoped_access.sql', 'utf8');
const financeMigration = readFileSync('supabase/migrations/20261102014446_chapter_treasurer_financial_duties.sql', 'utf8');
// The organization-backed assignment has ordinary graph gates.
const stewardUnitRequirementMigration = readFileSync('supabase/migrations/' + readdirSync('supabase/migrations').find(name => name.endsWith('_stewards_require_unit_with_carry_over.sql')), 'utf8');
//: the per-unit settings tables join the graph through their chapter, organization and account keys.
const perUnitSettingsMigration = readFileSync('supabase/migrations/' + readdirSync('supabase/migrations').find(name => name.endsWith('_per_unit_settings.sql')), 'utf8');
//: the account-security email queue joins the graph through user_id.
const accountNoticeMailMigration = readFileSync('supabase/migrations/' + readdirSync('supabase/migrations').find(name => name.endsWith('_account_recovery_notice_mail_and_reset_lock_timeout.sql')), 'utf8');
const perUnitSettingsTables = ['private.chapter_unit_setting_defaults', 'private.unit_setting_audit', 'private.unit_setting_overrides'];
const unitCommitteeGraphTables = ['private.chapter_access_policies', 'private.chapter_role_settings', 'private.chapter_committees', 'private.chapter_unit_members', 'private.chapter_committee_members', 'private.chapter_role_scopes', 'private.member_draft_steward_shares'];

describe('platform participation writer admission', () => {
  it('keeps the latest participation rewrite gated before its declaration initializers', () => {
    const fn = functions.find(entry => entry.name === 'public.toggle_digital_action_participation' && entry.arity === 3);
    expect(fn).toBeDefined();
    expect(helperFirst(fn.source)).toBe(true);
  });
});

describe('reviewed shared read admission', () => {
  it('requires the exact reviewed name and body, including the audit INSERT guard', () => {
    for (const name of Object.keys(reviewedReadAdmission)) {
      const fn = functions.find(entry => entry.name === name);
      expect(sharedReadEntry(fn), name).toBe(true);
      expect(sharedReadEntry({ ...fn, name: 'public.unreviewed_writer' })).toBe(false);
      expect(sharedReadEntry({ ...fn, source: fn.source + '\nperform 1;' })).toBe(false);
    }
    const gate = functions.find(entry => entry.name === 'private.lock_case_graph_row_keys');
    expect(sharedReadEntry({ ...gate, source: gate.source.replace("tg_op = 'INSERT'", 'true') })).toBe(false);
  });
});
const scopeMigration = readFileSync('supabase/migrations/20261003065000_compass_scope_path_resolver.sql', 'utf8');
const embeddingMigration = readFileSync('supabase/migrations/20260930030000_compass_hybrid_retrieval_pgvector.sql', 'utf8');
const learningContentMigration = readFileSync('supabase/migrations/20260928233000_governed_learning_content.sql', 'utf8');
const procedureMigration = readFileSync('supabase/migrations/20260917133000_casework_procedures_retire_w2.sql', 'utf8');
const retiredTables = [...procedureMigration.matchAll(/^drop table (public\.case_\w+);/gm)].map(match => match[1]);
const procedureTables = ['public.casework_procedures', 'public.casework_procedure_steps', 'public.organization_holidays'];
// REQ-UG-POMS-FUNCTION-REMOVAL-20261003 dropped the three POMS tables and their gates.
const pomsRemovalMigration = readFileSync('supabase/migrations/20261003070000_poms_function_removal.sql', 'utf8');
const retiredPomsTables = [...pomsRemovalMigration.matchAll(/^drop table (public\.organization_poms_\w+);/gm)].map(match => match[1]);
const platformAiMigration = readFileSync('supabase/migrations/20261001002000_compass_platform_fireworks_failover.sql','utf8');
const manifest = readFileSync('supabase/migrations/20260907150000_account_lifecycle_manifest.sql','utf8');
const historyMigration = readFileSync('supabase/migrations/20260917143000_casework_case_history.sql','utf8');
const wrappers = readFileSync('supabase/migrations/20260907151000_account_deletion_finalization_reconciliation.sql','utf8');
const encMigration = readFileSync('supabase/migrations/20260906190000_sensitive_content_envelopes.sql','utf8');
const encLockMigration = readFileSync('supabase/migrations/20260907152000_sensitive_content_lock_order.sql','utf8');
const messageLifecycleMigration = readFileSync('supabase/migrations/20260907122000_retire_dormant_channel_controls.sql','utf8');
const authBookkeepingMigration = readFileSync('supabase/migrations/20260912002000_auth_bookkeeping_lock_scope.sql','utf8');
const verificationIdentityMigration = readFileSync('supabase/migrations/20260917141000_chapter_verification_identity.sql','utf8');
// Lane 5.6 added public.casework_macros to the graph closure; the manifest that
// carries every other table's gate pair is shipped, so its pair lives here.
const macroMigration = readFileSync('supabase/migrations/20260917144000_casework_macros_case_note_mentions.sql','utf8');
const orgImportMigration = readFileSync('supabase/migrations/20260924170000_organization_structure_import.sql','utf8');
const stewardRosterMigration = readFileSync('supabase/migrations/20260924170200_member_steward_roster_and_contact.sql','utf8');
const caseNoteAuthorMigration = readFileSync('supabase/migrations/20260925110300_case_note_author_attribution.sql','utf8');
const contactLogHistoryMigration = readFileSync('supabase/migrations/20260925230000_chapter_contact_log_immutable_history.sql','utf8');
const catalogPlacementMigration = readFileSync('supabase/migrations/20260925960000_catalog_organization_self_placement.sql','utf8');
// REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: the organization-keyed
// Site Guide copy table and its a00/z99 gates.
const siteGuideMigration = readFileSync('supabase/migrations/20261002122000_site_guide.sql','utf8');
const chapterConnectionMigration = readFileSync('supabase/migrations/20260928103000_chapter_connection_suggestions_backend.sql', 'utf8');
const checkinAttemptMigration = readFileSync('supabase/migrations/20260925980000_event_checkin_code_attempt_bound.sql','utf8');
const connectedWorkflowMigration = readFileSync('supabase/migrations/20261001020000_connected_workflow_shortcuts.sql','utf8');
// REQ-UG-ULP-FILING-DEADLINE-20261001 adds public.casework_retaliation_flags.
const ulpDeadlineMigration = readFileSync('supabase/migrations/20261002140000_casework_ulp_filing_deadline.sql','utf8');
const remindHereRoutingMigration = readFileSync('supabase/migrations/20261003033000_remind_here_and_steward_email_routing.sql','utf8');
const catalogClaimsMigration = readFileSync('supabase/migrations/20260930040000_union_catalog_claims_verification.sql','utf8');
// REQ-UG-REACTIVATION-WELCOME-BACK-20261001: one last-active date per account.
const homeReturnMigration = readFileSync('supabase/migrations/20261002133000_member_home_reactivation.sql','utf8');
const automationRecipeDefaultsMigration = readFileSync('supabase/migrations/20261003030000_automation_recipe_defaults.sql','utf8');
const memberPinMigration = readFileSync('supabase/migrations/20261003040000_member_pin_signin.sql','utf8');
const channelControlsMigration = readFileSync('supabase/migrations/20261003034000_channel_controls_restored.sql','utf8');
// Restore lane L7b: the pre-meeting notice and trusted-source health tables.
const automationRestoreMigration = readFileSync('supabase/migrations/20261003050000_automation_minutes_exports_retention_sources.sql','utf8');
const governanceMigration = readFileSync('supabase/migrations/20261003051000_governance_leadership_recovery_and_officer_removal.sql','utf8');
const integrationsRestoreMigration = readFileSync('supabase/migrations/20261003053000_integrations_wallet_calendar_drive_checkoff.sql','utf8');
const switchLimitsMigration = readFileSync('supabase/migrations/20261003058000_switch_limits_caps_floors_lockouts.sql','utf8');
const eventEmailMigration = readFileSync('supabase/migrations/20261007023000_authorized_event_notification_email.sql','utf8');
const profileDetailsMigration = readFileSync('supabase/migrations/20261008100000_member_profile_details.sql','utf8');
const stewardRemindersMigration = readFileSync('supabase/migrations/20261009000500_steward_case_title_and_private_reminders.sql','utf8');
const workplaceRosterMigration = readFileSync('supabase/migrations/20261008232000_member_workplace_roster.sql','utf8');
// Union Ground's organizing lifecycle tables join the account graph and
// carry their a00/z99 gates in one migration (2026-10-14 reconciliation).
const unionGroundCaseGraphMigration = readFileSync('supabase/migrations/20261014012000_unionground_account_case_graph.sql','utf8');
const trainingRetentionMigration = readFileSync('supabase/migrations/20261027060200_compass_training_retention.sql','utf8');
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP3-20261029 gates the org-start guide's backup and spokespeople.
const orgStartGuideMigration = readFileSync('supabase/migrations/20261029150000_organization_start_guide.sql','utf8');
// REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029 gates the staff feature guides' per-person progress.
const staffGuidesMigration = readFileSync('supabase/migrations/20261030010000_staff_onboarding_guides.sql','utf8');
const memberRequestsMigration = readFileSync('supabase/migrations/20261030235900_member_requests.sql','utf8');
// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030 gates the organization's own blank HTML forms.
const orgFormsMigration = readFileSync('supabase/migrations/20261030201500_organization_form_documents.sql','utf8');
const chapterUnitsMigration = readFileSync('supabase/migrations/20261030201200_chapter_units_and_local_profile.sql','utf8');
// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: ballot nominations and the minutes approver.
const nominationsMigration = readFileSync('supabase/migrations/20261030214501_ballot_nominations_and_minutes_approval.sql','utf8');
// REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: the chapter
// seniority list, bid windows and bids, each with entry gates.
const seniorityMigration = readFileSync('supabase/migrations/20261030224501_chapter_seniority_and_bids.sql','utf8');
// REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: a steward's private booking notes.
const bookingNotesMigration = readFileSync('supabase/migrations/20261030234501_personal_reminders_booking_details_and_notes.sql','utf8');
const pulseLayoutMigration = readFileSync('supabase/migrations/20261113148000_pulse_layout_store.sql','utf8');
const savedChartsMigration = readFileSync('supabase/migrations/20261102001534_pulse_saved_charts.sql','utf8');
const weeklyHistoryMigration = readFileSync('supabase/migrations/20261102175905_pulse_weekly_history.sql','utf8');
const pulseNoticePollMigration = readFileSync('supabase/migrations/20261121035100_pulse_notice_poll_reads.sql','utf8');
//: the demo seed's case-deadline ledger, a child of member_cases.
const caseDeadlineLedgerMigration = readFileSync('supabase/migrations/20261123044100_demo_seed_case_deadline_writes.sql','utf8');
//  unit 2: the demo seed's step-deadline ledger, a child of member_cases.
const stepDeadlineLedgerMigration = readFileSync('supabase/migrations/20261123111000_demo_seed_step_deadline_writes.sql','utf8');
const workloadCategoriesMigration = readFileSync('supabase/migrations/20261103131500_workload_category_labels_visibility_order.sql','utf8');
const workloadConfigurationMigration = readFileSync('supabase/migrations/20261105192000_organization_workload_configuration.sql','utf8');
const learningPeriodMigration = readFileSync('supabase/migrations/20261103163000_learning_period_engine.sql','utf8');
const learningMessagesMigration = readFileSync('supabase/migrations/20261104111500_learning_period_messages_notices_invites_exports.sql','utf8');
// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104 gates the onboarding skip reasons, a member_onboarding_plans child.
const onboardingAdminGapsMigration = readFileSync('supabase/migrations/20261104090000_onboarding_admin_server_gaps.sql','utf8');
const learningEventsMigration = readFileSync('supabase/migrations/20261104110000_learning_period_events.sql','utf8');
//  found by its name, not its stamp, which is fixed when it reaches the migration line.
const crossChapterPeerMigration = readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(name => name.endsWith('_cross_chapter_peer_contact.sql'))}`,'utf8');
//  found by its name, not its stamp, which is fixed when it reaches the migration line.
const peerBlockMigration = readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(name => name.endsWith('_peer_conversation_leave_and_block.sql'))}`,'utf8');
//  found by its name, not its stamp, which is fixed when it reaches the migration line.
const memberReferralMigration = readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(name => name.endsWith('_member_referral_attribution.sql'))}`,'utf8');
//  found by its name, not its stamp: the waiting referral payouts.
const memberReferralPayoutMigration = readFileSync(`supabase/migrations/${readdirSync('supabase/migrations').find(name => name.endsWith('_referral_over_weekly_cap_waits_for_a_later_week.sql'))}`,'utf8');
// REQ-UG-INVITE-AND-STANDING-HANDSHAKE-FOR-PARTNERS-NOT-YET-ON-PLATFORM-20261031 gates standing offers and partner invitation requests.
const partnerOffersMigration = readFileSync('supabase/migrations/20261101224749_standing_handshake_offers.sql','utf8');
const botVisibilityMigration = readFileSync('supabase/migrations/20261023050348_bot_organization_directory_visibility.sql','utf8');
const messageLifecycleEntries = [...messageLifecycleMigration.slice(
  messageLifecycleMigration.indexOf('do $entry_gates$'),
  messageLifecycleMigration.indexOf('$entry_gates$;', messageLifecycleMigration.indexOf('do $entry_gates$')),
).matchAll(/\('([\w.]+)\([^'\n]*\)', '([a-f0-9]{32})'\)/g)].map((match) => ({
  name: match[1],
  sourceMd5: match[2],
}));
const messageLifecycleTransformations = messageLifecycleEntries.flatMap(({ name, sourceMd5 }) => functions.historical
  .filter((fn) => fn.name === name && createHash('md5').update(fn.source).digest('hex') === sourceMd5)
  .map((fn) => ({
    name,
    sourceMd5,
    sourceSha256: fn.sourceSha256,
    resultSource(source) {
      const directive = source.includes('#variable_conflict use_variable') ? '#variable_conflict use_variable\n' : '';
      const inner = source.replace('#variable_conflict use_variable', '').replace(/[ \n\r\t;]+$/, '');
      return `${directive}\nbegin\n  perform private.lock_message_lifecycle();\n${inner};\nend;\n`;
    },
  })));
const sourceReplacementTransformations = [
  {
    name: 'public.casework_submit_retaliation_report',
    sourceSha256: '7057c577ec9a162877b77fb3d6e24e2615008390a69538effb331dac96be32e2',
    resultSource(source) {
      let definition = source.replace(
        'insert into public.casework_retaliation_reports(organization_id',
        'insert into public.casework_retaliation_reports(id, organization_id',
      ).replace(
        'values (v_case.organization_id, v_case.chapter_id, (select auth.uid()), v_case.id, p_incident_at',
        'values (p_idempotency_key, v_case.organization_id, v_case.chapter_id, (select auth.uid()), v_case.id, p_incident_at',
      );
      definition = definition.replace(
        "on conflict (organization_id, reporter_user_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key\n  returning * into v_row;",
        "on conflict (organization_id, reporter_user_id, idempotency_key) do nothing\n  returning * into v_row;\n  if not found then select * into strict v_row from public.casework_retaliation_reports where organization_id = v_case.organization_id and reporter_user_id = (select auth.uid()) and idempotency_key = p_idempotency_key; end if;",
      );
      return definition;
    },
  },
  ...['private.demo_seed_apply_member_support', 'private.demo_seed_apply_casework'].map((name) => ({
    name,
    sourceSha256: functions.historical.find((fn) => fn.name === name).sourceSha256,
    resultSource(source) {
      let definition = source.replace('begin\n', "begin\n  perform set_config('app.sensitive_seed_ticket', coalesce((select id::text from private.sensitive_write_tickets where operation='demo_seed' and arguments=jsonb_build_object('lane',p_lane,'runId',p_run_id) and expires_at>clock_timestamp() order by expires_at desc limit 1),''),true);\n");
      if (name === 'private.demo_seed_apply_member_support') {
        definition = definition.replace(`(array[
        'Request for a consistent start-time adjustment during the current schedule cycle.',
        'Request for equipment that supports the essential duties of the position.',
        'Request to review a workspace change and an effective implementation date.',
        'Request to document a leave-related schedule and the return-to-work plan.'
      ])[1 + (n % 4)]`, "'[encrypted]'").replace("'Written disposition recorded after the interactive review.'", "'[encrypted]'");
      } else {
        for (const text of [
          'The member participated in a protected workplace discussion and requested representation.',
          'A schedule or assignment changed soon after the protected activity.',
          'Document the sequence and review available safeguards.',
          'The member chose to pause this fictional report after receiving support.',
        ]) definition = definition.replace(`'${text}'`, "'[encrypted]'");
        definition = definition.replace("'Management contact ' || (1 + (case_row.ordinal % 10))", "'[encrypted]'")
          .replace('report.management_person', "('Management contact ' || (1 + (seed.ordinal % 10)))")
          .replace('from public.casework_retaliation_reports report', "from public.casework_retaliation_reports report join generate_series(1,120) seed(ordinal) on report.id=private.member_stress_uuid(p_run_id::text || ':casework:retaliation-report:' || seed.ordinal)")
          .replace("pg_catalog.md5(pattern_row.chapter_id || ':' || pattern_row.person_key)", 'pattern_id::text')
          .replace('      pattern_row.subject_label,', "      '[encrypted]',");
      }
      definition = definition.replace('  return result;', "  perform set_config('app.sensitive_seed_ticket','',true);\n  return result;");
      return definition;
    },
  })),
];
const check = (fs = functions, sql = wrappers) => inventoryIssues(
  fs,
  sql,
  reviewedGraph.exceptions,
  reviewedForeignKeys.foreign_keys,
  [...sourceReplacementTransformations, ...messageLifecycleTransformations],
);

describe('case graph transaction entry inventory', () => {
  it('admits only the pinned input-only cosmetic initializer while retaining the first graph gate', () => {
    const fn = functions.find(entry => entry.name === 'public.grant_free_cosmetic');
    expect(fn.sourceSha256).toBe(reviewedGraph.pure_initializers[fn.name].source_sha256);
    expect(helperFirst(fn.source)).toBe(true);
    for (const source of [
      fn.source.replace("btrim(coalesce(p_reason,''))", 'private.current_member_organization()'),
      fn.source.replace("btrim(coalesce(p_reason,''))", "(select full_name from public.member_profiles limit 1)"),
      fn.source.replace('award uuid;', 'award uuid := extensions.gen_random_uuid();'),
      fn.source.replace('  perform private.lock_case_graph(array[auth.uid(),p_user_id],array[]::uuid[]);', ''),
    ]) expect(helperFirst(source)).toBe(false);
  });

  it.each(['public.set_compass_ai_enabled', 'public.set_compass_ai_role_limit', 'public.attest_compass_ai_provider', 'public.release_member_ai_request'])('keeps the replacement %s gated before evaluated declarations and mutations', name => {
    const latest = parseFunctions(platformAiMigration).find(fn => fn.name === name);
    expect(latest).toBeDefined();
    expect(helperFirst(latest.source)).toBe(true);
  });

  it('covers current lifecycle/casework functions and transitive writers with source-pinned exceptions', () => {
    expect(check()).toEqual([]);
    // 77 since 20260918201000 added private.casework_macro_audience, the one
    // casework_macros audience predicate
    // (BUG-UG-CASE-MACRO-WRITE-AUDIENCE-WIDER-THAN-READ-20260917). It is a
    // read-only composition of two existing role helpers: no relation of its
    // own, no row acquisition, no case graph DML.
    // +1: 20260918202000_casework_case_export_audit re-emits the read-only
    // public.list_casework_audit_events to add the cases_exported kind, and a
    // casework-named migration file owns every definition it carries.
    // +3: 20260918203000 / 20260918204000 (UX-UG-CASE-HISTORY-ORG-STAFF-UNNAMED-ACTORS-20260917,
    // SYS-UG-CASEWORK-RECORD-VERSIONS-RETENTION-20260917) rewrite the
    // public.casework_case_history pin and add three reviewed exceptions.
    // +1: 20260919010000 owns private.casework_audit_event_kinds and rewrites
    // the list_casework_audit_events pin to the CHECK-derived reader
    // (BUG-UG-CASEWORK-AUDIT-READER-KIND-VOCABULARY-DRIFT-20260918).
    // 20260924170200 rewrites that same read-only exception (count unchanged)
    // so the coordinator parent-case visibility conjunct stays in the pin.
    // -1: 20260925000100 re-emits public.list_organization_job_health to widen
    // its job catalogue (OPS-UG-CRON-HEALTH-MIRROR-OMITS-SIX-JOBS-20260921).
    // The routine's newest definition no longer lives in a lifecycle- or
    // casework-named migration and still writes nothing, so it leaves this
    // inventory's scope entirely and its reviewed exception would be unused. A
    // future definition that acquires or writes re-enters as a writer, where
    // the missing-helper rule applies without an exception.
    // +2: 20260924190100 adds the read-only reminder delivery helpers
    // private.casework_reminder_owner_can_read and
    // private.casework_reminder_next_occurrence
    // (BUG-UG-CASEWORK-REMINDERS-NEVER-FIRE-20260920).
    // +1: 20260925620100 adds the read-only private.casework_checklist_template_audience
    // (BUG-UG-CHECKLIST-TEMPLATE-WRITE-AUDIENCE-NOT-SUBSET-READ-AUDIENCE-CHAPTER-20260921).
    // +5: 20261002140000 adds the read-only ULP deadline readers
    // private.casework_ulp_thresholds, private.casework_retaliation_flag_json,
    // public.casework_list_case_retaliation_flags, public.casework_list_ulp_deadlines
    // and the member Home read public.get_my_case_ulp_summary
    // (REQ-UG-ULP-FILING-DEADLINE-20261001).
    // +1: 20261002140000 re-emits the read-only public.list_organization_job_health
    // catalog into a casework migration to monitor casework-ulp-deadline-tick.
    // +3: 20261002141000 adds the detector's read-only helpers
    // private.casework_retaliation_severity, private.casework_retaliation_confidence
    // and private.casework_retaliation_adverse_events (REQ-UG-RETALIATION-TIMING-DETECTOR-20261001).
    // +1: 20261002145000 adds the read-only public.casework_suggest_case_strength
    // (REQ-UG-STRENGTH-ANALYZER-AUTO-SCORING-20261001).
    // Retiring demo_seed_function_parity_status removes its read-only exception.
    // +1: 20261027100000 adds the read-only private.casework_safety_retaliation_route
    // (BUG-UG-CASEWORK-SAFETY-RETALIATION-30-DAY-DEADLINE-20261022).
    // +1: 20261031031052 adds the read-only public.casework_desk_case_details,
    // the case desk's bounded read (no lock, no access record, no case DML).
    //  retains the touch utility's original lack of graph acquisition;
    // its reviewed tuple/notice-ledger body runs under the statement gate.
    // +1: 20261113142500 re-emits the member_cases trigger
    // private.mi1_bind_case_owner in a casework migration; it only
    // reads the owner's chapter and shapes NEW, under the statement gate.
    // +1: 20261117091100 adds the service-role public.claim_scheduled_job_alerts
    //: it reads organization_job_runs and locks and writes only its own
    // private alert tables, outside the case graph.
    // +5: 20261123141000 ( slice 3) is named for casework, so its
    // read-only Pulse helpers enter this scope: the three SQL gates and
    // projections run only after their callers' graph gate, and the restated
    // option lists (pulse_ready_chart_options, pulse_layout_options) write
    // nothing and lock no row. +1 ( round 1): the immutable
    // private.pulse_contribution_groups reads no table at all. +1 (
    // final): the immutable private.pulse_total_groups reads no table either.
    expect(Object.keys(reviewedGraph.exceptions)).toHaveLength(105);
    expect(reviewedGraph.exceptions['public.list_casework_audit_events'].source_sha256)
      .toBe('218ba654d2d163ff2c4cd214c58729a472d90d969c47c946635b4c6bc65fe6a6');
    expect(reviewedGraph.exceptions['public.member_account_deletion_has_terminal_audit']).toEqual({
      reason: 'Read-only terminal deletion-audit evidence check; no row acquisitions or case graph DML.',
      source_sha256: '7b8b865a9719e80377e81baa538a4afd0b4622e4e19f3e0a0591c418877b1949',
    });
    for (const exception of Object.values(reviewedGraph.exceptions)) expect(exception.reason.length).toBeGreaterThan(30);
  });
  it('keeps record-version capture on its regular first gate', () => {
    const name = 'private.capture_casework_record_version';
    const fn = functions.find(candidate => candidate.name === name);
    expect(helperFirst(fn.source)).toBe(true);
    expect(reviewedGraph.exceptions[name]).toBeUndefined();
  });
  it('pins the touch utility to its original lock behaviour plus deadline retirement', () => {
    const name = 'private.touch_member_case_updated_at';
    const original = parseFunctions(readFileSync('supabase/migrations/20260907150000_account_lifecycle_manifest.sql', 'utf8'), 'original').find(fn => fn.name === name).source;
    const reset = `  if new.deadline is distinct from old.deadline then
    new.deadline_notice_1_sent_at := null;
    new.deadline_notice_3_sent_at := null;
    new.deadline_notice_7_sent_at := null;
    delete from private.staff_deadline_notice_marks
     where source = 'member_case' and deadline_id = old.id;
  end if;
`;
    const intended = original.replace('  new.updated_at := pg_catalog.now();', reset + '  new.updated_at := pg_catalog.now();');
    const fn = functions.find(candidate => candidate.name === name);
    expect(fn.source).toBe(intended);
    expect(fn.source).not.toContain('perform private.lock_case_graph');
    expect(reviewedGraph.exceptions[name].source_sha256).toBe(createHash('sha256').update(intended).digest('hex'));
  });
  it('checks only the declaration section for initializers before the graph gate', () => {
    const functionRow = {
      name: 'public.declaration_probe', file: 'casework_probe.sql', sourceSha256: 'probe',
      source: `declare value integer;
      begin
        perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
        value := 1;
        begin
          update public.member_cases set status = 'active' where false;
        end;
      end;`,
    };
    expect(helperFirst(functionRow.source)).toBe(true);
    for (const declaration of ['value integer := 1;', 'value integer default 1;']) {
      expect(helperFirst(functionRow.source.replace('value integer;', declaration))).toBe(false);
    }
    expect(check([...functions, functionRow])).not.toContain('initializer precedes helper: public.declaration_probe');
    expect(check([...functions, { ...functionRow, source: functionRow.source.replace('value integer;', 'value integer := 1;') }]))
      .toContain('initializer precedes helper: public.declaration_probe');
  });
  it('derives every transformed pin from retained source bytes and rejects drift', () => {
    for (const entry of [...reviewedGraph.transformed_sources, ...reviewedGraph.historical_transformed_sources]) {
      expect(createHash('sha256').update(entry.source).digest('hex')).toBe(entry.source_sha256);
      const original = entry.source;
      try {
        entry.source += '\n-- drift';
        expect(check()).toContain(`unmatched wrapper source: ${entry.name}`);
      } finally { entry.source = original; }
    }
  });
  it('classifies which migrations can change the captured FK catalogue', () => {
    const fks = [{ child: 'public.case_notes', parent: 'public.member_cases', name: 'case_notes_case_id_fkey' }];
    expect(foreignKeyRelevance('create table public.t (id uuid references public.member_cases(id));', fks)).toBe('references');
    expect(foreignKeyRelevance('alter table public.t add constraint t_fk foreign key (a) references public.u(id);', fks)).toBe('foreign key');
    expect(foreignKeyRelevance('alter table public.case_notes drop constraint case_notes_case_id_fkey;', fks)).toBe('drop constraint case_notes_case_id_fkey');
    expect(foreignKeyRelevance('alter table public.case_notes drop constraint if exists "case_notes_case_id_fkey";', fks)).toBe('drop constraint case_notes_case_id_fkey');
    expect(foreignKeyRelevance('drop table if exists public.scratch, public.case_notes;', fks)).toBe('drop table case_notes');
    expect(foreignKeyRelevance('alter table public.case_notes rename column case_id to parent_id;', fks)).toBe('rename');
    expect(foreignKeyRelevance('alter table public.case_notes alter column case_id type text;', fks)).toBe('alter column case_id type');
    expect(foreignKeyRelevance('alter table public.case_notes drop column case_id;', fks)).toBe('drop column');
    // Cannot change the catalogue: a CHECK constraint swap, an unrelated
    // table drop, a routine re-emit, and a comment that discusses an FK.
    expect(foreignKeyRelevance('alter table public.case_notes drop constraint case_notes_kind_check;', fks)).toBeNull();
    expect(foreignKeyRelevance('drop table if exists public.scratch;', fks)).toBeNull();
    expect(foreignKeyRelevance('create or replace function public.f() returns int language sql as $$ select 1 $$;', fks)).toBeNull();
    expect(foreignKeyRelevance('-- this used to references public.member_cases\nselect 1;', fks)).toBeNull();
    // The real catalogue's own names drive the conditional rules.
    expect(foreignKeyRelevance('alter table public.sensitive_case_chunks drop constraint sensitive_case_chunks_file_id_fkey;')).toBe('drop constraint sensitive_case_chunks_file_id_fkey');
  });
  it('derives implicit acquisitions from a migration-bound FK catalogue', () => {
    // Bound to the migrations that can change the FK catalogue, not to every
    // migration: an unrelated migration PR no longer rewrites this pin. When a
    // migration listed by foreignKeyRelevantMigrations() changes, re-capture
    // foreignKeyCatalogueSql from a fully migrated local database into
    // scripts/account-case-graph-fks.json and set fk_migration_sha256 to
    // foreignKeyMigrationDigest('supabase/migrations').
    expect(foreignKeyMigrationDigest('supabase/migrations')).toBe(reviewedForeignKeys.fk_migration_sha256);
    expect(deriveRelations(reviewedForeignKeys.foreign_keys)).toEqual(reviewedGraph.tables);
    // W2 retirement removes 31 FKs and the configured procedure adds six;
    // 890 since 20260917141000 added chapter_connection_readiness.verified_by
    // (the relation closure is unchanged because requested_by already made
    // that table an auth.users child).
    // 893 / 334 since 20260917143000 (case history) added its audit table.
    // 896 / 335 since lane 5.6 added public.casework_macros and its three
    // foreign keys (organization, chapter, created_by).
    // 908 / 335 since the civic advocacy merge-back (2026-09-22) added twelve
    // foreign keys between civic tables; none of them reaches auth.users.
    // 910 / 335 since SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920 gave
    // member_ballots and member_surveys an organization owner (two foreign keys
    // to public.organizations; both tables were already auth.users children).
    // 929 / 343 since the organization structure import (20260924170000) and
    // the member steward roster (20260924170200) added seventeen and two
    // foreign keys; eight tables join the closure, each with a00/z99 triggers.
    // 930 / 343 since BUG-UG-CASE-HISTORY-STAFF-NOTES-ATTRIBUTED-TO-THE-MEMBER-20260920
    // gave member_case_updates an author_user_id auth.users key (already a
    // closure table).
    // 933 / 344 since 20260925230000 added public.chapter_contact_log_versions
    // and its changed_by, chapter_id, and contact_id foreign keys.
    // 946 / 344 since 20260925950000_union_catalog_reference_foundation added
    // the nine private.catalog_* tables and their thirteen foreign keys among
    // themselves; none reaches the closure.
    // 947 / 344 since the  repair round added private.catalog_staging
    // and its release_id foreign key to private.catalog_releases.
    // 948 / 345 since 20260925960000 added private.organization_catalog_placements
    // and its organization_id foreign key (no auth.users column).
    // 950 / 346 since 20260925980000 (SEC-UG-EVENT-CHECKIN-CODE-UNBOUNDED-GUESSES-20260920)
    // added private.member_event_checkin_attempts with its user_id (auth.users)
    // and event_id (member_events) foreign keys; the table joins the closure
    // with a00/z99 triggers naming user_id.
    // Chapter connection profiles, source tags, hides and frozen aggregates add
    // fourteen foreign keys and five graph relations (disposable catalog capture).
    // 980 / 358 including governed learning; connected additions since 20260929090000 (REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928)
    // added member_events.organizer_id (auth.users), private.member_event_contact_opt_ins
    // (event_id, user_id) and the metadata-only private.member_event_contact_links
    // (message_id, event_id, organizer_id, participant_id): seven foreign keys and two
    // graph relations, each with a00/z99 gates naming the identity columns.
    // Governed learning adds nine FKs and five scoped content/control tables.
    // 986 / 360 includes Main's Compass embedding relation and the claim migration that added private.platform_operators,
    // private.organization_claims and private.catalog_review_events (ten
    // foreign keys, five of them to auth.users) and two verification foreign
    // keys on private.organization_catalog_placements.
    // 995 / 364 since REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001 added
    // private.organization_site_guide_copy and its organization_id foreign key
    // (no auth.users column; a00/z99 gates with no identity column).
    // 996 / 365 since REQ-UG-REACTIVATION-WELCOME-BACK-20261001 added
    // private.member_home_return_marks and its user_id (auth.users) foreign
    // key; the table joins the closure with a00/z99 triggers naming user_id.
    // 998 / 366 since BUG-UG-HOME-TAKEOVER-ORG-SCOPE-20261002 gave
    // member_conversations an organization_id foreign key to
    // public.organizations (already a closure table; no new relation).
    // 1002 / 368 since restore lane L7b added
    // private.meeting_minutes_event_notices (record, event, organization and
    // chapter foreign keys) and private.organization_knowledge_source_health
    // (organization_id): five foreign keys, no auth.users column, a00/z99
    // gates with no identity column.
    // Train 3 review repair adds immutable organization FKs on four member
    // history/counter tables plus the private durable Drive reservation ledger.
    // 1003 / 367 since REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001 and
    // REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001 (20261003051000) added
    // public.chapter_leadership_claims (organization, chapter, claimant_user_id
    // and decided_by foreign keys; the table joins the closure) and
    // member_ballots.target_officer_id / removal_outcome_recorded_by.
    // 1008 / 371 since (20261003053000) added the three organization
    // calendar tables (organization_id only; a00/z99 gates with no identity
    // column) and the two task check-off tables with their four auth.users keys.
    // The verified-key registry adds one more reviewed account-owned relation.
    // 1002 / 367: public.casework_retaliation_flags (REQ-UG-ULP-FILING-DEADLINE-20261001)
    // adds five foreign keys (case, organization, chapter, created_by, reviewed_by) and one relation.
    // 1004 / 368 since REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001 (20261003030000)
    // added public.organization_automation_routing_rules and its organization
    // and chapter foreign keys; no auth.users column, a00/z99 gates name none.
    // 1008 / 369 since 20261003033000 (REQ-UG-REMIND-HERE-20261001,
    // REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001) added the metadata-only
    // private.channel_here_reminder_deliveries (reminder_id, recipient_id; it
    // joins the closure with a00/z99 gates naming recipient_id) and
    // steward_email_intakes.routed_case_id / knowledge_article_id (SET NULL).
    // 1009 / 370 since 20261003040000 (REQ-UG-MEMBER-PIN-SIGNIN-20261001)
    // added private.member_pin_credentials.user_id (auth.users, cascade); the
    // table joins the closure with a00/z99 gates naming user_id.
    // 1012 / 371 since REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 added
    // public.chapter_space_notification_settings (organization, space and
    // user_id foreign keys; the table joins the closure through user_id).
    // Compass scope metadata adds four FKs and one graph relation.
    // -7 FKs / -3 relations since REQ-UG-POMS-FUNCTION-REMOVAL-20261003
    // (20261003070000) dropped organization_poms_sources, organization_poms_ingest_chunks
    // and organization_poms_evidence with their foreign keys.
    // Authorized event email adds one private source table and two cascade FKs.
    // Form template tenant ownership adds form_templates.organization_id
    // (NO ACTION, outside the account graph).
    // Member profile details (20261008100000) add one auth.users cascade FK
    // and its table to the account graph.
    // Steward private reminders (20261009000500) add owner (auth.users),
    // organization and case foreign keys; the table joins the account graph.
    // Union catalog research tables (20261012090000) add two catalog_key FKs
    // to private.catalog_organizations, outside the account graph.
    // Optional Compass training (20261027060200) adds seven installed FKs
    // and its three private account-owned relations, each with entry gates.
    // The /contribute document intake (20261022172000) adds one cascade FK
    // from its file rows to their submission, outside the account graph.
    // GoTrue 2.197 (CLI 2.121) adds six vendor FKs and three Auth descendants.
    // Platform announcements add thirteen FKs and seven private graph relations.
    // The org-start guide adds four FKs and two relations; staff feature guide
    // progress adds two FKs and one relation; free cosmetics add eight FKs and
    // two account-owned graph relations. Chapter units and the local profile
    // add five FKs and three organization-owned graph relations; organization
    // HTML forms add one FK and one relation with no identity column. Ballot
    // nominations add four FKs and one relation, and the minutes approver one FK.
    // The chapter seniority list and bids (20261030224501) add five FKs and
    // three graph relations. Booking notes add two FKs and one relation. Member requests
    // (20261030235900) add four FKs and one relation. Standing handshake offers
    // and partner invitation requests (20261101224749) add ten FKs and two
    // chapter-owned graph relations, each with a creator column. Unit/committee
    // scoped access  adds 24 FKs and seven relations; saved chart specs
    // (20261102001534) three FKs and one relation. Chapter financial documents
    // and requests  add five FKs and two relations. Pulse weekly
    // snapshots  add two FKs and one relation with no identity column.
    // Workload category visibility and order  adds one FK and one
    // organization-owned relation with no identity column.
    // The learning period engine  adds eight FKs and two relations:
    // organization_learning_periods (started_by, ended_early_by) and
    // learning_action_journal (actor_user_id).
    // The onboarding skip reasons  add two FKs (plan, step) and one
    // relation with no identity column. The learning period events slice
    //  adds twelve FKs and five relations: the held event copies and
    // the rows a practised delete holds for undo.
    expect(reviewedForeignKeys.foreign_keys.length).toBeGreaterThan(0);
    // The bot ledger is an additional trigger host of the organization writer;
    // it adds no foreign key but must enter the same graph before row locks.
    // The learning period message slice  seeds civic_member_messages
    // the same way: its sent journal trigger takes the case-graph lock.
    expect(reviewedGraph.tables.length).toBeGreaterThan(0);
    expect(reviewedGraph.seeds).toContain('private.bot_production_marks');
    expect(reviewedGraph.seeds).toContain('public.civic_member_messages');
    expect(wrappers).toContain('alter function public.get_organization_retention_engine() volatile;');
    for (const table of ['public.member_handoffs', 'public.member_steward_relationships', 'public.organization_survey_sessions', 'auth.sessions', 'public.sensitive_case_chunks']) {
      expect(deriveRelations(reviewedForeignKeys.foreign_keys)).toContain(table);
    }
    expect(reviewedForeignKeys.foreign_keys).toContainEqual({
      child: 'public.sensitive_case_chunks',
      parent: 'public.member_case_files',
      name: 'sensitive_case_chunks_file_id_fkey',
      columns: '{file_id}',
      parent_columns: '{id}',
      delete_rule: 'CASCADE',
      update_rule: 'NO ACTION',
    });
    expect(reviewedForeignKeys.foreign_keys.filter(fk => fk.parent === 'auth.users' && ['public.sensitive_case_chunks', 'private.sensitive_write_tickets', 'private.sensitive_retired_objects'].includes(fk.child))).toEqual([]);
    const fks = [...reviewedForeignKeys.foreign_keys, {child:'public.new_identity_writer',parent:'auth.users',columns:['recipient_id'],parent_columns:['id']}];
    const candidate = {name:'public.new_fk_writer',source:'begin insert into public.new_identity_writer values (null); end;',file:'future.sql',sourceSha256:'new'};
    expect(inventoryIssues([...functions,candidate],wrappers,reviewedGraph.exceptions,fks)).toContain('missing first helper: public.new_fk_writer');
    expect(inventoryIssues([...functions,candidate],wrappers,{...reviewedGraph.exceptions,[candidate.name]:{source_sha256:'new',reason:'Reviewed hypothetical exclusion with an implicit Auth acquisition.'}},fks)).toContain('writer cannot be excluded: public.new_fk_writer');
  });
  it('normalizes parsed and raw name[] FK columns to the one stored text encoding', () => {
    // pg returns name[] (OID 1003) as raw text; a text[] cast would parse it.
    // Both must land on the encoding account-case-graph-fks.json stores.
    const raw = { child: 'public.t', parent: 'auth.users', name: 't_fkey', columns: '{user_id,org_id}', parent_columns: '{id,organization_id}', delete_rule: 'CASCADE', update_rule: 'NO ACTION' };
    const parsed = { ...raw, columns: ['user_id', 'org_id'], parent_columns: ['id', 'organization_id'] };
    expect(normalizeForeignKeyRow(parsed)).toEqual(raw);
    expect(JSON.stringify(normalizeForeignKeyRow(parsed))).toBe(JSON.stringify(normalizeForeignKeyRow(raw)));
    expect(referenceColumns([normalizeForeignKeyRow(parsed)], 'public.t', 'auth.users')).toBe(referenceColumns([raw], 'public.t', 'auth.users'));
    expect(normalizeForeignKeyRow({ ...raw, columns: ['odd name', 'a"b', 'NULL'] }).columns).toBe('{"odd name","a\\"b","NULL"}');
    // The reviewed catalogue is already in the stable form.
    expect(reviewedForeignKeys.foreign_keys.map(normalizeForeignKeyRow)).toEqual(reviewedForeignKeys.foreign_keys);
    expect(reviewedForeignKeys.foreign_keys.every(fk => typeof fk.columns === 'string' && typeof fk.parent_columns === 'string')).toBe(true);
    expect(readFileSync('scripts/account-case-graph-inventory.mjs', 'utf8')).toContain('(await client.query(foreignKeyCatalogueSql)).rows.map(normalizeForeignKeyRow)');
  });
  it('freezes the six-relation Auth bookkeeping exemption and every gated Auth accessor', () => {
    expect(authBookkeepingChildTables).toEqual([
      'auth.sessions',
      'auth.refresh_tokens',
      'auth.one_time_tokens',
      'auth.mfa_amr_claims',
      'auth.mfa_challenges',
      'auth.identities',
    ]);
    expect(authUserCoveredColumns).toEqual([
      'id', 'instance_id', 'aud', 'role', 'email', 'phone', 'deleted_at', 'banned_until',
      'is_sso_user', 'is_anonymous', 'raw_user_meta_data', 'email_change', 'phone_change',
    ]);
    expect(authBookkeepingExemptions.lock_key).toEqual([509, 701]);
    expect(authBookkeepingExemptions.shared_trigger_tables).toEqual(['auth.users', ...authBookkeepingChildTables]);
    // The gate trigger sorts before the exclusive trigger, so an OAuth client
    // delete can never own (509, 701) while it waits for the case-graph gate.
    expect(authBookkeepingExemptions.oauth_clients_delete).toMatchObject({
      table: 'auth.oauth_clients', gate_trigger: 'a00_case_graph_lock',
      trigger: 'a01_auth_bookkeeping_exclusive',
    });
    expect(authBookkeepingExemptions.oauth_clients_delete.gate_trigger
      < authBookkeepingExemptions.oauth_clients_delete.trigger).toBe(true);
    expect(authBookkeepingExemptions.oauth_clients_delete.reason.length).toBeGreaterThan(80);
    // private.member_pin_end_sessions since 20261003040000 (D5-3 restricted
    // PIN sessions end with a staff role, a PIN change or removal, or a step-up).
    // REQ-UG-SSO-SIGNIN-20261001 (20261003042000) adds the five SAML
    // identity writers; each takes (509, 701) right after its graph gate.
    // BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003 (20261003061000) adds
    // public.end_member_auth_sessions, the admin recovery session revocation.
    expect(Object.keys(authBookkeepingExemptions.reviewed_gated_auth_functions).sort()).toEqual([
      'private.member_pin_end_sessions', 'private.scim_revoke_organization_membership', 'private.sso_link_identity', 'private.sso_unlink_ineligible',
      'public.claim_mfa_recovery_code', 'public.end_member_auth_sessions',
      'public.prepare_mfa_recovery_signout',
      'public.prepare_password_reset_recovery',
      'public.record_sso_deregistration', 'public.record_sso_registration',
      'public.register_verified_key_session', 'public.revoke_my_session', 'public.revoke_verified_key_session',
      'public.sso_signin_lookup',
          ]);
    for (const entry of authBookkeepingExemptions.child_tables) expect(entry.reason.length).toBeGreaterThan(80);
    const effective = functions.map(fn => {
      const review = authBookkeepingExemptions.reviewed_gated_auth_functions[fn.name];
      if (review?.mode === 'covered-users-first') return { ...fn, source: caseGraphWrappedSource(fn.source) };
      return fn;
    });
    expect(authBookkeepingFunctionIssues(effective)).toEqual([]);
    for (const name of ['public.claim_mfa_recovery_code', 'public.prepare_mfa_recovery_signout', 'public.prepare_password_reset_recovery',
      'public.revoke_my_session',
      'private.member_pin_end_sessions', 'private.scim_revoke_organization_membership', 'private.sso_link_identity', 'private.sso_unlink_ineligible',
      'public.record_sso_registration', 'public.record_sso_deregistration', 'public.sso_signin_lookup',
      'public.end_member_auth_sessions']) {
      expect(authBookkeepingExclusiveAfterGate(effective.find(fn => fn.name === name).source)).toBe(true);
    }
    const newWriter = { name: 'public.new_auth_writer', source: 'begin perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]); insert into auth.one_time_tokens values (null); end;', file: 'future.sql', sourceSha256: 'new' };
    expect(authBookkeepingFunctionIssues([...effective, newWriter])).toContain('unreviewed gated Auth bookkeeping function: public.new_auth_writer');
    const delayed = effective.map(fn => fn.name === 'public.revoke_my_session'
      ? { ...fn, source: fn.source.replace('perform pg_catalog.pg_advisory_xact_lock(509, 701);', 'perform 1;') } : fn);
    expect(authBookkeepingFunctionIssues(delayed)).toContain('gated Auth bookkeeping function lacks immediate exclusive lock: public.revoke_my_session');
    expect(authBookkeepingAccessTargets(effective.find(fn => fn.name === 'public.revoke_my_session').source)).toEqual(['auth.sessions']);
  });
  it('requires the first locked or written Auth access of a covered-users-first function to be the users statement', () => {
    const historicalBatch = functions.historical.find(fn => fn.name === "public.member_stress_apply_batch");
    const batch = { ...historicalBatch, source: caseGraphWrappedSource(historicalBatch.source) };
    const reviews = { ...authBookkeepingExemptions.reviewed_gated_auth_functions, [batch.name]: { mode: "covered-users-first", tables: ["auth.users", "auth.identities"] } };
    const effective = [...functions, batch].map(fn => {
      const review = authBookkeepingExemptions.reviewed_gated_auth_functions[fn.name];
      if (review?.mode === 'covered-users-first') return { ...fn, source: caseGraphWrappedSource(fn.source) };
      return fn;
    });
    // Control: the reviewed batch enters through the covered auth.users INSERT,
    // whose a00 statement trigger takes the gate and then (509, 701).
    expect(authBookkeepingCoveredUsersFirst(batch.source)).toBe(true);
    expect(authBookkeepingAccessSequence(batch.source).map(access => [access.table, access.locked]))
      .toEqual([['auth.users', false], ['auth.identities', false]]);
    expect(authBookkeepingFunctionIssues(effective, reviews)).toEqual([]);
    // A locked read is a tuple acquisition. Placed ahead of the users INSERT it
    // would hold an auth.identities tuple with no bookkeeping lock at all, and
    // checking only the first Auth DML statement let that mutation pass.
    for (const lock of ['for update', 'for no key update', 'for share', 'for key share']) {
      const source = batch.source.replace('  insert into auth.users (',
        `  perform 1 from auth.identities where user_id = p_run_id ${lock};\n  insert into auth.users (`);
      expect(source).not.toBe(batch.source);
      expect(authBookkeepingCoveredUsersFirst(source)).toBe(false);
      expect(authBookkeepingAccessSequence(source)[0]).toMatchObject({ table: 'auth.identities', locked: true });
      const mutated = effective.map(fn => (fn.name === batch.name ? { ...fn, source } : fn));
      expect(authBookkeepingFunctionIssues(mutated, reviews)).toEqual([
        'gated Auth bookkeeping function no longer enters covered auth.users first: public.member_stress_apply_batch',
      ]);
    }
    // An unlocked read still does not hold a tuple and must not be flagged.
    const unlocked = batch.source.replace('  insert into auth.users (',
      '  perform 1 from auth.identities where user_id = p_run_id;\n  insert into auth.users (');
    expect(authBookkeepingCoveredUsersFirst(unlocked)).toBe(true);
    // A covered users DELETE is also a valid entry; its own FROM clause must not
    // be counted as an earlier locked read.
    const removal = functions.historical.find(fn => fn.name === 'public.member_stress_remove_batch');
    expect(authBookkeepingCoveredUsersFirst(removal.source)).toBe(true);
    expect(authBookkeepingAccessSequence(removal.source)).toHaveLength(1);
    // An exempt users UPDATE is not a covered statement and never qualifies.
    expect(authBookkeepingCoveredUsersFirst('begin update auth.users set last_sign_in_at = now(); end;')).toBe(false);
  });
  it('accepts an Auth bookkeeping negative control only when the verifier itself rejects the mutation', async () => {
    const transactions = [];
    const makeClient = (failures = {}) => ({
      query: async (sql) => {
        transactions.push(sql);
        if (failures[sql]) throw new Error(failures[sql]);
        return { rows: [] };
      },
    });
    const verifier = (message) => async () => { if (message) throw new Error(message); };
    const drift = [['drop trigger a01_auth_bookkeeping_exclusive on auth.oauth_clients', 'users/client trigger', 'oauth client trigger']];

    expect(await runAuthBookkeepingDriftControls(makeClient(), drift,
      verifier('Auth bookkeeping users/client trigger changed'))).toEqual([]);
    expect(transactions.filter(sql => sql === 'rollback')).toHaveLength(1);

    expect(await runAuthBookkeepingDriftControls(makeClient(), drift, verifier(null)))
      .toEqual(['oauth client trigger: verifier did not report "users/client trigger"; got no verifier error']);
    expect(await runAuthBookkeepingDriftControls(makeClient(), drift, verifier('Implicit FK row-key gate changed: auth.users')))
      .toEqual(['oauth client trigger: verifier did not report "users/client trigger"; got Implicit FK row-key gate changed: auth.users']);
    // A mutation that cannot be applied, or a denied SET LOCAL ROLE, is a broken
    // control: the verifier never ran, so nothing was proven detectable.
    expect(await runAuthBookkeepingDriftControls(
      makeClient({ [drift[0][0]]: 'must be owner of relation oauth_clients' }), drift,
      verifier('Auth bookkeeping users/client trigger changed'),
    )).toEqual(['oauth client trigger: control never reached the verifier, mutation step failed with must be owner of relation oauth_clients']);
    expect(await runAuthBookkeepingDriftControls(
      makeClient({ 'set local role postgres': 'permission denied to set role "postgres"' }), drift,
      verifier('Auth bookkeeping users/client trigger changed'),
    )).toEqual(['oauth client trigger: control never reached the verifier, role step failed with permission denied to set role "postgres"']);
    expect(transactions.filter(sql => sql === 'rollback')).toHaveLength(5);
    expect(transactions.filter(sql => sql === 'begin')).toHaveLength(5);
  });
  it('captures OLD and NEW Auth/case identities from every catalogue-derived row binding', () => {
    for (const table of reviewedGraph.tables.filter(t => t !== 'private.mi1_w2_operation_receipts' && !authBookkeepingChildTables.includes(t))) {
      const [auth, cases] = rowKeyArguments(reviewedForeignKeys.foreign_keys,table);
      if (table.startsWith('private.free_cosmetic_')) {
        const binding = cosmeticsMigration.match(new RegExp(`on ${table}\\s+for each row execute function private\\.lock_case_graph_row_keys\\('([^']*)',\\s*'([^']*)'\\);`));
        expect(binding, table).not.toBeNull();
        expect(binding[1], table).toBe(auth);
        expect(binding[2], table).toBe(cases);
        continue;
      }
      const migration = ['private.chapter_financial_documents', 'private.chapter_financial_requests'].includes(table) ? financeMigration : unitCommitteeGraphTables.includes(table) ? unitCommitteeMigration : plainRowKeyTables.includes(table)
        ? authRowKeyRepairMigration
        : table === 'auth.mfa_recovery_codes'
        ? authAdoptionMigration
        : procedureTables.includes(table) ? procedureMigration : table === 'auth.users'
        ? authBookkeepingMigration
        : ['public.sensitive_case_chunks', 'public.member_message_legal_holds', 'public.member_messages'].includes(table)
        ? `${encMigration}\n${encLockMigration}`
        // 20260917141000 added a second auth.users reference to this table, so it
        // re-creates the row-key trigger with both identity columns; the manifest
        // still carries the single-column form it shipped with.
        : table === 'public.chapter_connection_readiness'
        ? verificationIdentityMigration
        : table === 'public.casework_macros'
        ? macroMigration
        // 20260924170000 creates the import tables' row-key triggers and
        // re-creates the chart node trigger with the new user_id column;
        // 20260924170200 does the same for steward_user_id.
        : table.startsWith('public.organization_chart_') || table.startsWith('public.organization_reference_') || table === 'public.organization_structure_imports'
        ? orgImportMigration
        : ['public.member_conversations', 'public.steward_contact_preferences'].includes(table)
        ? stewardRosterMigration
        // 20260925110300 re-creates this trigger with the note author column.
        : table === 'public.member_case_updates'
        ? caseNoteAuthorMigration
        : table === 'public.chapter_contact_log_versions'
        ? contactLogHistoryMigration
        : table === 'private.compass_chapter_scope_bindings'
        ? scopeMigration
        : table === 'private.organization_catalog_placements'
        ? catalogPlacementMigration
        : table === 'private.organization_site_guide_copy'
        ? siteGuideMigration
        : table.startsWith('private.chapter_connection_')
        ? chapterConnectionMigration
        // The learning-period journal  shares the prefix, not the migration.
        // The learning-period events slice  holds practised deletes.
        : table === 'private.cross_chapter_peer_mutes'
        ? crossChapterPeerMigration
        : table === 'private.member_peer_blocks'
        ? peerBlockMigration
        : table === 'private.account_notice_mail'
        ? accountNoticeMailMigration
        : table === 'private.member_referrals'
        ? memberReferralMigration
        : table === 'private.member_referral_payouts_waiting'
        ? memberReferralPayoutMigration
        : table.startsWith('private.learning_held_')
        ? learningEventsMigration
        : table.startsWith('private.learning_') && table !== 'private.learning_action_journal'
        ? learningContentMigration
        : table === 'public.member_kb_article_embeddings'
        ? embeddingMigration
        : table === 'private.compass_platform_operators'
        ? platformAiMigration
        : table === 'private.verified_key_sessions'
        ? keyAssuranceMigration
        : table === 'private.member_event_checkin_attempts'
        ? checkinAttemptMigration
        // 20260929090000 gates the two event-contact tables and re-creates the
        // member_events row-key trigger with the new organizer_id column.
        : table.startsWith('private.member_event_contact_') || table === 'public.member_events'
        ? connectedWorkflowMigration
        : ['private.platform_operators', 'private.organization_claims', 'private.catalog_review_events'].includes(table)
        ? catalogClaimsMigration
        : table === 'private.member_home_return_marks'
        ? homeReturnMigration
        : table === 'public.casework_retaliation_flags'
        ? ulpDeadlineMigration
        // REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001 gates its routing table.
        : table === 'public.organization_automation_routing_rules'
        ? automationRecipeDefaultsMigration
        // 20261003033000 gates the here-reminder receipts and re-creates the
        // steward email intake row-key trigger with the routed case key.
        : ['private.channel_here_reminder_deliveries', 'public.steward_email_intakes'].includes(table)
        ? remindHereRoutingMigration
        // 20261003040000 gates the member PIN credential with its user_id.
        : table === 'private.member_pin_credentials'
        ? memberPinMigration
        // REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 gates the per-member
        // channel notification settings on user_id.
        : table === 'public.chapter_space_notification_settings'
        ? channelControlsMigration
        // REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006 gates
        // the member's own profile details on user_id.
        : table === 'public.member_profile_details'
        ? profileDetailsMigration
        // REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006
        // gates the steward's private reminders on owner_id and case_id.
        : table === 'private.steward_private_reminders'
        ? stewardRemindersMigration
        : table === 'private.organization_survey_worksite_releases'
        ? workplaceRosterMigration
        : ['private.meeting_minutes_event_notices', 'private.organization_knowledge_source_health'].includes(table)
        ? automationRestoreMigration
        // 20261003051000 gates the leadership claims and re-creates the
        // member_ballots row-key trigger with the two officer-removal columns.
        : ['public.chapter_leadership_claims', 'public.member_ballots'].includes(table)
        ? governanceMigration
        // Organization calendar and task check-off tables.
        : table.startsWith('private.organization_calendar_') || table.startsWith('private.task_checkoff_') || table === 'private.google_drive_filing_folders'
        ? integrationsRestoreMigration
        : table === 'private.organization_notification_outbound_counters'
        ? switchLimitsMigration
        : table.startsWith('private.compass_training_')
        ? trainingRetentionMigration
        : table.startsWith('private.organization_start_')
        ? orgStartGuideMigration
        : table === 'private.staff_onboarding_progress'
        ? staffGuidesMigration
        : table === 'public.member_requests'
        ? memberRequestsMigration
        : table === 'private.organization_form_documents'
        ? orgFormsMigration
        : ['private.chapter_units', 'private.organization_local_profiles', 'private.member_invitation_units'].includes(table)
        ? chapterUnitsMigration
        : ['public.ballot_nominations', 'public.chapter_records'].includes(table)
        ? nominationsMigration
        : /^private\.chapter_(seniority_entries|bid_windows|bid_entries)$/.test(table)
        ? seniorityMigration
        : table === 'private.organization_steward_unit_assignments'
        ? stewardUnitRequirementMigration
        : perUnitSettingsTables.includes(table)
        ? perUnitSettingsMigration
        : table === 'private.pulse_layouts'
        ? pulseLayoutMigration
        : table === 'public.member_appointment_notes'
        ? bookingNotesMigration
        : table === 'private.pulse_saved_charts'
        ? savedChartsMigration
        : table === 'private.pulse_weekly_snapshots'
        ? weeklyHistoryMigration
        : table === 'private.pulse_release_partitions'
        ? pulseNoticePollMigration
        : table === 'private.demo_seed_case_deadline_writes'
        ? caseDeadlineLedgerMigration
        : table === 'private.demo_seed_step_deadline_writes'
        ? stepDeadlineLedgerMigration
        : table === 'private.organization_workload_categories'
        ? workloadCategoriesMigration
        : table === 'private.organization_workload_configuration_versions'
        ? workloadConfigurationMigration
        : ['private.organization_learning_periods', 'private.learning_action_journal'].includes(table)
        ? learningPeriodMigration
        // The learning period message slice  brings the civic message
        // table into the graph because its sent journal takes the lock.
        : table === 'public.civic_member_messages'
        ? learningMessagesMigration
        : table === 'private.member_onboarding_skip_reasons'
        ? onboardingAdminGapsMigration
        : ['private.chapter_handshake_offers', 'private.chapter_partner_invitation_requests'].includes(table)
        ? partnerOffersMigration
        : table === 'private.member_notification_event_sources'
        ? eventEmailMigration
        // Union Ground's lifecycle tables (2026-10-14 reconciliation) are
        // gated in one migration.
        : unionGroundCaseGraphMigration.includes(`on ${table}\nfor each row execute function`)
        ? unionGroundCaseGraphMigration
        : table === 'private.bot_production_marks'
        ? botVisibilityMigration
        : /^private\.(platform_announcement|platform_organization_follow|organization_platform_announcement)/.test(table)
        ? announcementsMigration
        : `${manifest}
${historyMigration}`;
      expect(migration).toContain(`on ${table}\nfor each row execute function private.lock_case_graph_row_keys('${auth}', '${cases}');`);
    }
    const source = parseFunctions(manifest).find(f=>f.name==='private.lock_case_graph_row_keys').source;
    expect(helperFirst(source)).toBe(true);
    expect(source).toContain('pg_catalog.to_jsonb(old)');
    expect(source).toContain('pg_catalog.to_jsonb(new)');
    expect(source).toContain('perform private.lock_case_graph(auth_ids, case_ids)');
    for (const name of ['public.acknowledge_member_handoff','public.save_organization_survey_session']) expect(reviewedGraph.exceptions[name]).toBeUndefined();
  });
  it('requires bare user_id for the repaired Auth recovery-set and SCIM row-key gates (#6155)', () => {
    expect(plainRowKeyTables).toEqual(['auth.mfa_recovery_code_sets', 'auth.scim_users']);
    for (const table of plainRowKeyTables) {
      // The catalogue form is brace-wrapped; the helper would read it as the
      // JSON field "{user_id}" and lock nothing, as the applied adoption did.
      expect(rowKeyAuthColumns(reviewedForeignKeys.foreign_keys, table)).toBe('{user_id}');
      expect(authAdoptionMigration).toContain(`on ${table}\nfor each row execute function private.lock_case_graph_row_keys('{user_id}', '');`);
      expect(rowKeyArguments(reviewedForeignKeys.foreign_keys, table)).toEqual(['user_id', '']);
      expect(authRowKeyRepairMigration).toContain(`create or replace trigger z99_case_graph_keys before insert or update or delete on ${table}\nfor each row execute function private.lock_case_graph_row_keys('user_id', '');`);
    }
    // DROP TRIGGER needs ownership of the GoTrue-owned tables; replace in place.
    expect(authRowKeyRepairMigration).not.toMatch(/drop trigger|a00_case_graph_lock|lock_case_graph_row_keys\('\{/);
  });
  it('decodes braced row-key arguments to the parent-id column and refuses one that resolves to none (#6356)', () => {
    expect(rowKeyColumns('{created_by},{updated_by}')).toEqual(['created_by', 'updated_by']);
    expect(rowKeyColumns('{case_id,organization_id,chapter_id}')).toEqual(['case_id']);
    expect(rowKeyColumns('user_id')).toEqual(['user_id']);
    expect(rowKeyColumns('')).toEqual([]);
    const fk = (columns, parentColumns, parent = 'auth.users') => ({ child: 'public.x', parent, name: `x_${columns}`, columns, parent_columns: parentColumns });
    expect(rowKeyArgumentIssues([fk('{user_id}', '{id}'), fk('{case_id,organization_id}', '{id,organization_id}', 'public.member_cases')], 'public.x')).toEqual([]);
    expect(rowKeyArgumentIssues([fk('{}', '{}')], 'public.x')).toEqual(["row-key argument resolves to no column: public.x '{}'"]);
    expect(rowKeyArgumentIssues([fk('{organization_id,case_id}', '{organization_id,id}', 'public.member_cases')], 'public.x'))
      .toEqual(['row-key argument column is not a parent id column: public.x.organization_id']);
    const source = functions.find(entry => entry.name === 'private.lock_case_graph_row_keys').source;
    expect(source).toContain("'\\{([^,{}]+)[^{}]*\\}|([^,{}]+)'");
    expect(source).toContain('locks_taken::integer + key_count <= 256');
    expect(source).toContain('perform private.lock_case_graph(auth_ids, case_ids)');
    expect(source).not.toContain('string_to_array(tg_argv');
  });
  it('leaves no braced row-key gate statement on a graph relation that resolves to no parent-id column (#6356)', () => {
    const graph = new Set(reviewedGraph.tables);
    const statements = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).flatMap(file =>
      [...readFileSync(`supabase/migrations/${file}`, 'utf8').matchAll(/ on ([a-z_]+\.[a-z0-9_]+)\s*\nfor each row execute function private\.lock_case_graph_row_keys\('([^']*)', '([^']*)'\)/g)]
        .map(match => ({ file, table: match[1], args: [match[2], match[3]] })));
    const braced = statements.filter(statement => statement.args.some(arg => arg.includes('{')));
    expect(braced.length).toBeGreaterThan(300);
    const unresolved = braced.filter(statement => graph.has(statement.table)).filter(statement => {
      const [auth, cases] = rowKeyArguments(reviewedForeignKeys.foreign_keys, statement.table).map(rowKeyColumns);
      const [installedAuth, installedCases] = statement.args.map(rowKeyColumns);
      return installedAuth.some(column => !auth.includes(column)) || installedCases.some(column => !cases.includes(column))
        || statement.args.some((arg, index) => arg !== '' && [installedAuth, installedCases][index].length === 0);
    });
    expect(unresolved).toEqual([]);
  });
  it('retires the exact W2 graph and admits procedure writers without weakening entry checks', () => {
    expect(retiredTables).toHaveLength(10);
    for (const table of retiredTables) {
      expect(reviewedGraph.seeds).not.toContain(table);
      expect(reviewedGraph.tables).not.toContain(table);
      expect(reviewedForeignKeys.foreign_keys.some(fk => fk.child === table || fk.parent === table)).toBe(false);
    }
    for (const table of procedureTables) expect(reviewedGraph.tables).toContain(table);
    for (const name of ['public.casework_save_procedure', 'public.casework_set_holidays', 'public.casework_advance_step', 'public.coordinator_update_case']) {
      const fn = functions.find(candidate => candidate.name === name);
      expect(helperFirst(fn.source), name).toBe(true);
      expect(reviewedGraph.exceptions[name], name).toBeUndefined();
    }
    expect(reviewedGraph.exceptions['public.get_organization_case_flow_snapshot']).toBeUndefined();
    expect(reviewedGraph.exceptions['private.mi1_w2_normalize_case_step']).toBeUndefined();
  });
  it('requires a common gate before the sorted identity and case keys', () => {
    const helper = functions.find(f=>f.name==='private.lock_case_graph').source;
    expect(codeOnly(helper).trim()).toMatch(/^declare[\s\S]*?\bbegin\s+perform private\.lock_message_lifecycle\(\);/);
    expect(helper).toBe(parseFunctions(encLockMigration).find(f=>f.name==='private.lock_case_graph').source);
    expect(helper.indexOf('pg_advisory_xact_lock(509, 700)')).toBeLessThan(helper.indexOf('for identity_id'));
    expect(helper.indexOf('for identity_id')).toBeLessThan(helper.indexOf('for case_id'));
    expect(helper.match(/where id is not null order by id/g)).toHaveLength(2);
    expect(manifest).toContain('revoke all on function private.lock_case_graph(uuid[], uuid[]) from public, anon, authenticated, service_role');
  });
  it('coordinates direct statements before their target tuples, including Auth deletion', () => {
    const tables = [...`${manifest}\n${historyMigration}\n${encMigration}\n${encLockMigration}\n${procedureMigration}\n${macroMigration}\n${orgImportMigration}\n${stewardRosterMigration}\n${contactLogHistoryMigration}\n${catalogPlacementMigration}\n${checkinAttemptMigration}\n${chapterConnectionMigration}\n${learningContentMigration}\n${connectedWorkflowMigration}\n${embeddingMigration}\n${catalogClaimsMigration}\n${platformAiMigration}\n${siteGuideMigration}\n${homeReturnMigration}\n${keyAssuranceMigration}\n${ulpDeadlineMigration}\n${automationRecipeDefaultsMigration}\n${remindHereRoutingMigration}\n${memberPinMigration}\n${channelControlsMigration}\n${automationRestoreMigration}\n${governanceMigration}\n${integrationsRestoreMigration}\n${switchLimitsMigration}\n${eventEmailMigration}\n${scopeMigration}\n${profileDetailsMigration}\n${stewardRemindersMigration}\n${workplaceRosterMigration}\n${trainingRetentionMigration}\n${orgStartGuideMigration}\n${staffGuidesMigration}\n${orgFormsMigration}\n${botVisibilityMigration}\n${authAdoptionMigration}\n${seniorityMigration}
${announcementsMigration}\n${cosmeticsMigration}\n${chapterUnitsMigration}\n${nominationsMigration}\n${bookingNotesMigration}\n${memberRequestsMigration}\n${partnerOffersMigration}\n${savedChartsMigration}\n${weeklyHistoryMigration}\n${pulseNoticePollMigration}\n${caseDeadlineLedgerMigration}\n${stepDeadlineLedgerMigration}\n${unitCommitteeMigration}\n${financeMigration}\n${workloadCategoriesMigration}\n${workloadConfigurationMigration}\n${learningPeriodMigration}\n${onboardingAdminGapsMigration}\n${learningMessagesMigration}\n${learningEventsMigration}\n${crossChapterPeerMigration}\n${peerBlockMigration}\n${memberReferralMigration}\n${memberReferralPayoutMigration}\n${stewardUnitRequirementMigration}\n${perUnitSettingsMigration}\n${pulseLayoutMigration}\n${accountNoticeMailMigration}\n${unionGroundCaseGraphMigration}`.matchAll(/create trigger a00_case_graph_lock before insert or update or delete on ([\w.]+)\nfor each statement execute function private.lock_case_graph_statement\(\);/g)].map(m=>m[1]).filter(table => !retiredTables.includes(table) && !retiredPomsTables.includes(table)).sort();
    expect(retiredPomsTables).toHaveLength(3);
    expect(tables).toEqual(reviewedGraph.tables);
    expect(tables).toContain('auth.users');
    expect(tables).toContain('private.account_lifecycle_history_scope');
    for (const table of authBookkeepingChildTables) {
      expect(authBookkeepingMigration).toContain(`drop trigger if exists a00_case_graph_lock on ${table};`);
      expect(authBookkeepingMigration).toContain(`drop trigger if exists z99_case_graph_keys on ${table};`);
    }
    expect(authBookkeepingMigration.replace(/\s+/g, ' ').toLowerCase()).toContain(
      expectedAuthUsersTriggerDefinition('a00_case_graph_lock', 'private.lock_case_graph_statement_auth', 'STATEMENT').toLowerCase(),
    );
  });
  it('detects a newly introduced graph writer or indirect caller with an earlier row acquisition', () => {
    for (const source of [
      'begin update public.member_cases set title = title; end;',
      'begin perform 1 from public.member_cases for key share; end;',
      'begin perform 1 from public.member_forms for update; perform public.casework_revoke_access(null); end;',
    ]) expect(check([...functions, {name:'public.new_case_writer',source,file:'future.sql',sourceSha256:'new'}])).toContain('missing first helper: public.new_case_writer');
  });
  it('detects a removed participant, a changed installed source, and a missing wrapper acquisition', () => {
    // assign_member_case now re-emits its gates in its own latest body
    // (20260923220000), so the wrapper-removal probe uses a routine whose
    // gate still comes only from the installation-time wrapper.
    expect(check(functions, wrappers.replace(/\s*\('public.casework_link_cases\([^'\n]*\)', '[a-f0-9]{64}'\),?/,''))).toContain('missing first helper: public.casework_link_cases');
    const revised = functions.map(f=>f.name==='public.assign_member_case' ? {...f,source:'changed',sourceSha256:'changed'} : f);
    revised.historical = functions.historical.map(f=>f.name==='public.assign_member_case' ? {...f,source:'changed',sourceSha256:'changed'} : f);
    expect(check(revised)).toContain('unmatched wrapper source: public.assign_member_case');
    expect(check(functions,wrappers.replace('perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);','perform 1;'))).toContain('wrapper must acquire before original declarations');
  });
  it('detects a changed exception and a direct helper moved behind a row lock', () => {
    const revised = functions.map(f=>f.name==='private.casework_can_read' ? {...f,sourceSha256:'changed'} : f);
    expect(check(revised)).toContain('reviewed exception changed: private.casework_can_read');
    const delayed = functions.map(f=>f.name==='public.casework_revoke_access' ? {...f,source:f.source.replace('begin','begin perform 1 from public.member_cases for update;')} : f);
    expect(check(delayed)).toContain('missing first helper: public.casework_revoke_access');
  });
  it('recognizes all explicit acquisition forms and consumes whole dollar bodies', () => {
    for (const sql of ['for update','for share','for key share','for no key update','lock table public.member_cases','pg_advisory_xact_lock(1)']) expect(acquisition.test(codeOnly(sql))).toBe(true);
    const parsed = parseFunctions('create function public.f() returns void language plpgsql as $body$ begin perform 1; end; $body$;');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseFunctions('create function public.f() returns void language plpgsql as $body$ begin perform 2; end; $body$;')[0].sourceSha256).not.toBe(parsed[0].sourceSha256);
    expect(helperFirst('begin perform 1; perform private.lock_case_graph(null,null); end;')).toBe(false);
  });
});
