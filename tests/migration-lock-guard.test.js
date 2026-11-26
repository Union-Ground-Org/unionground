// @vitest-environment node
//
// Six migrations opened with `set local lock_timeout = '5s'`, and every one of
// them was a no-op. The Supabase CLI applies each migration file outside an
// explicit transaction, so SET LOCAL has no transaction to be local to: Postgres
// raises `WARNING (25P01): SET LOCAL can only be used in transaction blocks` and
// discards the setting. Nothing failed, so nothing was noticed — the warning
// only surfaced when the migrations were finally run against a real local stack
// on 2026-07-26.
//
// The guarantee that was silently missing is spelled out in
// 20260723205000_notification_constraint_validation.sql: "fail fast and let the
// operator re-run rather than sit in a lock queue in front of application
// traffic." Without an effective lock_timeout, a migration that cannot get its
// lock waits forever, and because Postgres queues later lock requests behind a
// waiter, it takes the table's normal traffic down with it.
//
// These assertions are text-level on purpose. A migration's lock behaviour
// cannot be observed after the fact from a migrated database — by the time you
// could query it, the apply has already either blocked or not.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .map((name) => ({
    name,
    // Comments are stripped before matching so that the explanatory comments
    // added alongside the fix — which necessarily quote "SET LOCAL" — cannot
    // themselves trip the assertion.
    sql: readFileSync(join(migrationsDir, name), "utf8")
      .replace(/\r\n/g, "\n")
      .replace(/^\s*--.*$/gm, ""),
  }));

// Older migrations that still open with a bare
// `set local lock_timeout = '5s';` outside any transaction block, so their
// guard is the same silent no-op this file was written to stop. Other tests
// pin that exact text, so they are recorded here as inherited debt rather
// than rewritten (2026-10-14). The list may only shrink: every entry must
// still exist and still carry the no-op, so fixing one forces its removal,
// and any file not listed here fails the guard.
const INHERITED_NOOP_LOCK_GUARDS = new Set([
  "20260725000000_atomic_member_write_rpcs.sql",
  "20260725120000_member_write_sole_writer_revokes.sql",
  "20260725150000_points_mint_rebind_message_steward.sql",
  "20260725160000_bound_rights_progress_completed_steps.sql",
  "20260725170000_mfa_guard_event_rpcs.sql",
  "20260725180000_mfa_guard_form_rpcs.sql",
  "20260725190000_mfa_guard_cosign_rpcs.sql",
  "20260725200000_mfa_guard_capability_rpcs.sql",
  "20260725210000_quorum_composite_fk.sql",
  "20260725220000_truncate_revoke_client_tables.sql",
  "20260725230000_steward_award_on_acknowledgment.sql",
  "20260726000000_chapter_agency_roster_and_stress_enrichment.sql",
  "20260726010000_reftrigger_maintain_revoke_client_tables.sql",
  "20260726030000_steward_requests_insert_column_scope.sql",
  "20260726164045_union_orgs_registry.sql",
  "20260728220954_cosign_decline_cooldown.sql",
  "20260728221544_notification_copy_sweep.sql",
  "20260728221658_tasks_notification_topic.sql",
  "20260801033000_broadcast_locale.sql",
  "20260801034500_member_reward_grants.sql",
  "20260801040000_reward_mfa_assurance.sql",
  "20260801120000_steward_appointments.sql",
  "20260801170000_kanban_task_numbers_and_realtime.sql",
  "20260801230000_kanban_task_dependencies.sql",
  "20260802041359_kanban_phase3_subtasks_watchers.sql",
  "20260802041915_kanban_phase3_subtasks_created_by_index.sql",
  "20260803213833_kanban_sol_deferrals.sql",
  "20260803214829_chapter_task_multi_assignees.sql",
  "20260812091000_staff_mfa_policy.sql",
  "20260812092000_intake_triage_conversion.sql",
  "20260812113000_compass_ai_governance.sql",
  "20260812140000_staff_campaign_authoring.sql",
  "20260812160000_reward_economy_effects.sql",
  "20260812170000_chapter_scoped_events.sql",
  "20260812180000_member_account_lifecycle.sql",
  "20260812190000_official_form_delivery.sql",
  "20260812200000_unified_messaging_restoration.sql",
  "20260812201000_steward_email_intake.sql",
  "20260812202000_messaging_deletion_integrity.sql",
  "20260812203000_workload_notification_kind.sql",
  "20260812203100_workload_intelligence.sql",
  "20260812204000_chapter_appointment_supervision.sql",
  "20260812205000_specialized_task_templates.sql",
  "20260812222529_form_filing_concurrency.sql",
  "20260812233000_member_peer_contact_reward.sql",
  "20260813022500_stress_notification_egress_guard.sql",
  "20260813140000_stress_workload_notification_reconciliation.sql",
  "20260813170000_post_integration_service_health.sql",
  "20260821010000_mobile_multichapter_identity.sql",
  "20260821011000_emailed_password_invitation_finalize.sql",
  "20260821012000_mobile_ship_complete_workflows.sql",
  "20260821013000_member_password_reissue.sql",
  "20260821014000_mobile_authorization_repair.sql",
  "20260821131000_mobile_org_wide_role_projection.sql",
  "20260822010000_mi1_organization_scope_foundation.sql",
  "20260822020000_mi1_w1_feature_persistence.sql",
  "20260824233000_uniondemo_org_seed.sql",
  "20260826140000_chapter_record_publication_and_broadcast_audience.sql",
  "20260826150000_steward_desk_setwise_visibility.sql",
  "20260826151000_mi1_w2_feature_persistence.sql",
  "20260826152000_mi1_integration_control_repairs.sql",
  "20260826153000_public_chapter_hierarchy.sql",
  "20260826155000_mi1_append_only_review_repairs.sql",
  "20260826158000_mi1_role_transition_and_contract_repairs.sql",
  "20260826160000_presg_demo_seed.sql",
  "20260826162000_demo_seed_function_parity.sql",
  "20260827180000_mi1_contract_clause_quickref.sql",
  "20260828021500_mi1_member_access_history.sql",
  "20260828073000_mi1_calendar_freebusy_oauth.sql",
  "20260828210000_mi1_casework_suite.sql",
  "20260828230000_mi1_analytics_parity_five.sql",
  "20260828231000_mi1_organization_coordination.sql",
  "20260828232000_mi1_organization_coordination_workflows.sql",
  "20260828233000_mi1_coordination_decisions_public_microsites.sql",
  "20260828234000_mi1_coordination_pagination_demo_seed.sql",
  "20260828235000_mi1_organization_coordination_hardening.sql",
  "20260828240000_auth_configuration_operations.sql",
  "20260828241000_demo_seed_auth_operations_repair.sql",
  "20260829001900_demo_seed_voice_completion.sql",
  "20260829002000_organization_intelligence_collective_actions.sql",
  "20260829002100_organization_intelligence_demo_seed.sql",
  "20260829020000_member_engagement_empty_tenant_boundary.sql",
  "20260829023000_mi1_automation_control_room.sql",
  "20260829024000_organization_intelligence_seed_conflict_repair.sql",
  "20260829030000_member_support_programs.sql",
  "20260829031000_organization_intelligence_visible_graph_seed_repair.sql",
  "20260829043000_mi1_knowledge_library_completion.sql",
  "20260829044000_mi1_knowledge_library_sample_activation.sql",
  "20260829235900_demo_seed_voice_operations_completion.sql",
  "20260830011500_demo_seed_knowledge_page_recomposition.sql",
  "20260830030000_demo_seed_voice_operations_completion_repair.sql",
  "20260830050000_demo_seed_casework_completion.sql",
  "20260830060000_institutional_records_completion.sql",
  "20260830070000_demo_seed_analytics_completion.sql",
  "20260830145000_sample_chapter_catalog_scale.sql",
  "20260830160000_member_operations_completion.sql",
  "20260830161000_member_operations_demo_seed.sql",
  "20260830170000_administrative_evidence_workflows.sql",
  "20260830180000_mi1_retention_engine.sql",
  "20260830220404_administrative_evidence_desk_scale.sql",
  "20260830233000_constant_contact_integration.sql",
  "20260831205804_mi1_dues_notification_delivery.sql",
  "20260901080000_member_password_reissue_attempt_lease.sql",
  "20260901102000_integration_jobs_provider_kind_union_repair.sql",
  "20260901102500_provider_foreign_key_covering_indexes.sql",
  "20260901165000_dues_foreign_key_covering_indexes.sql",
  "20260901201000_g3_native_member_journey_boundaries.sql",
  "20260902050000_g4_native_staff_authorization_depth.sql",
  "20260903030000_cba_ingestion_completion.sql",
  "20260903031000_calendar_import_completion.sql",
  "20260903032000_optional_provider_demo_parity.sql",
  "20260903033000_knowledge_article_snapshot.sql",
  "20260903034000_knowledge_selected_chapter_scope.sql",
  "20260903035000_calendar_scope_upgrade_status.sql",
  "20260903036000_knowledge_collection_review_snapshot.sql",
  "20260903040000_knowledge_collection_chapter_snapshot.sql",
]);

describe("migration lock guards", () => {
  it("finds migrations to check", () => {
    expect(migrations.length).toBeGreaterThan(50);
  });

  // SET LOCAL is only a no-op outside a transaction block. Union Ground's
  // later migrations open their own `begin; ... commit;` and set the guard
  // inside it, which is correct and is the form Postgres documents; those
  // stay. Any SET LOCAL lock_timeout that is not preceded by an explicit
  // BEGIN (or that is never committed) is the silent no-op this test exists
  // to catch.
  it("never sets lock_timeout with SET LOCAL outside an explicit transaction", () => {
    const opensTransaction = /^\s*(begin|start\s+transaction)(\s+(transaction|work))?\s*;/im;
    const commits = /^\s*(commit|end)(\s+(transaction|work))?\s*;/im;
    const offenders = migrations
      .filter((migration) => {
        const setLocal = /\bset\s+local\s+lock_timeout\b/i.exec(migration.sql);
        if (!setLocal) return false;
        const before = migration.sql.slice(0, setLocal.index);
        const after = migration.sql.slice(setLocal.index);
        return !opensTransaction.test(before) || !commits.test(after);
      })
      .map((migration) => migration.name);

    expect(offenders.filter((name) => !INHERITED_NOOP_LOCK_GUARDS.has(name))).toEqual([]);
    // The inherited list only shrinks: a fixed or deleted file must leave it.
    expect([...INHERITED_NOOP_LOCK_GUARDS].filter((name) => !offenders.includes(name))).toEqual([]);
    expect(INHERITED_NOOP_LOCK_GUARDS.size).toBeLessThanOrEqual(116);
    for (const name of INHERITED_NOOP_LOCK_GUARDS) {
      expect(name < "20261014000000", `${name} is not an inherited Union Ground migration`).toBe(true);
    }
  });

  it("keeps the guard on every migration that already had one", () => {
    // The six files below are the ones whose authors decided a lock wait was a
    // production hazard worth bounding. Losing the guard should be a deliberate,
    // visible act, not a silent deletion during an unrelated edit.
    const guarded = [
      "20260723205000_notification_constraint_validation.sql",
      "20260724030000_mfa_assurance_boundary.sql",
      "20260724034000_mfa_predicate_scope_and_capability_rpcs.sql",
      "20261014002000_unionground_canonical_participation_sources.sql",
      "20261014004000_unionground_disable_legacy_stress.sql",
      "20260724120000_mfa_admin_visibility_and_enrol_alert.sql",
    ];

    for (const name of guarded) {
      const migration = migrations.find((candidate) => candidate.name === name);
      expect(migration, `${name} is missing`).toBeDefined();
      expect(migration.sql, `${name} lost its lock_timeout guard`).toMatch(
        /^\s*set\s+lock_timeout\s*=\s*'5s'\s*;/m,
      );
    }
  });
});
