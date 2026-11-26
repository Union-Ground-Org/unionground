import { expect } from "vitest";

import { requireRlsTables } from "../../scripts/lib/db-contract-tables.mjs";

export const MI1_ORGANIZATION_RLS_TABLES = [
  "organizations",
  "organization_memberships",
  "organization_role_grants",
  "organization_audit_events",
];

export const MI1_W1_FEATURE_PERSISTENCE_RLS_TABLES = [
  "member_qa_questions",
  "member_qa_replies",
  "member_qa_votes",
  "organization_page_views",
  "organization_engagement_events",
  "organization_analytics_exports",
  "pay_scale_grades",
  "pay_scale_steps",
  "organization_integrations",
  "chapter_integration_overrides",
  "integration_jobs",
  "integration_webhooks",
  "integration_webhook_deliveries",
  "integration_api_keys",
  "scim_tokens",
  "organization_audit_ledger",
  "organization_job_runs",
  "organization_job_acknowledgements",
  "public_event_rsvps",
];

export const MI1_PUBLIC_CHAPTER_HIERARCHY_RLS_TABLES = [
  "public_chapter_sections",
  "public_chapter_pages",
];

const MI1_W1_FEATURE_SELECT_TABLES = new Set([
  "pay_scale_grades",
  "pay_scale_steps",
  "organization_audit_ledger",
]);

export const MI1_CLAUSE_QUICKREF_RLS_TABLES = [
  "contract_clauses",
];

export const MEMBER_ENGAGEMENT_RLS_TABLES = [
  "organization_survey_tasks",
  "organization_survey_deliveries",
  "organization_survey_reviews",
  "organization_pulse_prompts",
  "organization_pulse_events",
  "organization_live_polls",
  "organization_live_poll_options",
  "organization_live_poll_votes",
  "organization_live_poll_attendance",
  "engagement_delivery_outbox",
  "member_presence",
  "chapter_space_controls",
  "chapter_space_preferences",
  "chapter_space_keyword_monitors",
  "chapter_space_keyword_hits",
  "compass_message_briefings",
  "compass_workspace_preferences",
  "compass_workspace_actions",
];

export const MI1_ACCESS_HISTORY_RLS_TABLES = [
  "member_access_events",
];

export const MI1_ANALYTICS_PARITY_RLS_TABLES = [
  "organization_analytics_layouts",
  "organization_analytics_layout_events",
];

export const MI1_CASEWORK_RLS_TABLES = [
  "casework_access_grants",
  "casework_strength_analyses",
  "casework_bargaining_workspaces",
  "casework_bargaining_proposals",
  "casework_bargaining_events",
  "casework_deadlines",
  "casework_deadline_extensions",
  "casework_checklist_templates",
  "casework_checklists",
  "casework_checklist_items",
  "casework_step_transitions",
  "casework_alerts",
  "casework_alert_acknowledgements",
  "casework_management_people",
  "casework_management_entries",
  "casework_management_addenda",
  "casework_retaliation_reports",
  "casework_retaliation_patterns",
  "casework_retaliation_pattern_reports",
  "casework_retaliation_pattern_notes",
  "casework_intake_drafts",
  "casework_entity_links",
  "casework_reminders",
  "casework_audit_events",
  // REQ-UG-ULP-FILING-DEADLINE-20261001 (20261002140000): RPC-only flags.
  "casework_retaliation_flags",
];

export const ORGANIZATION_INTELLIGENCE_RLS_TABLES = [
  "organization_chart_nodes",
  "organization_relationships",
  "organization_topic_progress",
  "organization_timeline_events",
  "digital_actions",
  "digital_action_participants",
  "digital_action_exports",
  "organization_intelligence_audit_events",
];

export const MI1_AUTH_CONFIGURATION_RLS_TABLES = [
  "platform_setting_definitions",
  "organization_setting_values",
  "organization_label_overrides",
  "organization_configuration_audit",
  "mfa_recovery_code_sets",
  "mfa_recovery_codes",
  "organization_failed_login_attempts",
];

export const MI1_COORDINATION_RLS_TABLES = [
  "organization_coordination_records",
  "organization_coordination_organization_participants",
  "organization_coordination_user_participants",
  "organization_coordination_events",
  "organization_coordination_messages",
  "organization_coordination_resources",
  "organization_coordination_export_runs",
  "organization_coordination_outreach_events",
  "organization_merge_remap_events",
  "organization_network_directory_profiles",
  "organization_network_permission_grants",
  "organization_network_access_events",
  "organization_mission_badges",
  "organization_merge_match_reviews",
  "organization_merge_jobs",
  "organization_coordination_page_attachments",
  "organization_coalition_decisions",
  "organization_coalition_decision_votes",
  "public_chapter_page_attachments",
  "public_chapter_page_takeovers",
];

export const MI1_AUTOMATION_CONTROL_RLS_TABLES = [
  "organization_automation_settings",
  "organization_automation_definitions",
  "organization_automation_runs",
  "organization_automation_effects",
];

export const MI1_KNOWLEDGE_LIBRARY_RLS_TABLES = [
  "knowledge_collections",
  "knowledge_collection_items",
];

// REQ-UG-DOCUMENT-CONVERSION-PROVENANCE-20260904.
export const KNOWLEDGE_CONVERSION_PROVENANCE_RLS_TABLES = [
  "organization_knowledge_conversions",
];

export const MI1_RETENTION_RLS_TABLES = [
  "organization_retention_policies",
  "organization_retention_runs",
];

export const OPTIONAL_PROVIDER_COMPLETION_RLS_TABLES = [
  "member_calendar_import_events",
];

export const INSTITUTIONAL_RECORDS_RLS_TABLES = [
  "chapter_record_versions",
  "meeting_attendance",
  "meeting_minutes_dispatches",
  "chapter_contact_log",
  "chapter_contact_log_versions",
  "organization_data_export_runs",
  "member_weekly_question_promotions",
];

// 20261003070000 dropped the three POMS tables this list also held
// (REQ-UG-POMS-FUNCTION-REMOVAL-20261003); Field Notes and Action Lab stay.
export const ADMINISTRATIVE_EVIDENCE_RLS_TABLES = [
  "organization_field_note_sources",
  "organization_field_note_blocks",
  "organization_field_note_packets",
  "organization_object_action_runs",
];

export const MI1_W2_FEATURE_PERSISTENCE_RLS_TABLES = [
  "organization_surveys",
  "organization_survey_questions",
  "organization_survey_sessions",
  "organization_survey_answers",
  "case_deadline_changes",
  "case_deadline_audit",
  "case_checklist_progress",
  "case_step_transitions",
  "case_generated_work",
  "case_restrictions",
  "case_restriction_access",
  "case_alerts",
  "case_alert_acknowledgements",
  "case_reminders",
  "organization_knowledge_files",
  "organization_knowledge_sources",
  "organization_knowledge_chunks",
  "member_steward_relationships",
  "member_handoffs",
];

// Historical migration membership stays above; these relations no longer exist.
export const RETIRED_W2_CASE_TABLES = MI1_W2_FEATURE_PERSISTENCE_RLS_TABLES.filter((table) => table.startsWith("case_"));
export const CASEWORK_PROCEDURE_RLS_TABLES = ["casework_procedures", "casework_procedure_steps", "organization_holidays"];

export const MEMBER_SUPPORT_RLS_TABLES = [
  "member_emergency_checklists",
  "member_accommodation_requests",
  "organization_hr_directory",
  "member_hr_contacts",
  "organization_onboarding_steps",
  "member_onboarding_plans",
  "member_mentorship_pairs",
  "member_mentorship_notes",
  "member_mentorship_goals",
  "member_support_events",
];

export const MEMBER_OPERATIONS_RLS_TABLES = [
  "weekly_question_selection_policies",
  "organization_member_operational_profiles",
  "organization_welcome_campaigns",
  "organization_welcome_campaign_steps",
  "member_welcome_enrollments",
  "organization_import_batches",
  "organization_import_rows",
];

export const CONSTANT_CONTACT_RLS_TABLES = [
  "constant_contact_sync_requests",
  "constant_contact_member_analytics",
  "constant_contact_sync_runs",
];

export const DUES_RLS_TABLES = [
  "dues_member_subjects",
  "dues_assessment_batches",
  "dues_obligations",
  "dues_ledger_events",
  "dues_receipt_counters",
  "dues_reminder_attempts",
  "dues_notification_deliveries",
  "dues_provider_connections",
  "dues_checkout_reservations",
  "dues_stripe_events",
];

// SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904. 20260907121000 adds one
// RLS-enabled public table: the conversation-scoped preservation order that
// suspends every redaction path. It is named here rather than folded into the
// constant above so the count below stays an explicit sum of reviewed tables.
export const MESSAGE_BODY_LIFECYCLE_RLS_TABLES = [
  "member_message_legal_holds",
];
export const SENSITIVE_TRANSPORT_RLS_TABLES = ["sensitive_case_chunks"];
export const COMPASS_HYBRID_RLS_TABLES = ["member_kb_article_embeddings"];
// REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 (20261003034000): the RPC-only
// per-member channel notification settings (level, mute, keyword alerts).
export const CHANNEL_CONTROLS_RLS_TABLES = ["chapter_space_notification_settings"];

// Member profile details (20261008100000,
// REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006): one
// RPC-only table with RLS and the mfa_assurance floor.
export const MEMBER_PROFILE_DETAILS_RLS_TABLES = ["member_profile_details"];
// REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001 (20261003051000): the RPC-only
// chapter leadership claims (pending, granted, rejected, withdrawn, lapsed).
export const GOVERNANCE_RLS_TABLES = ["chapter_leadership_claims"];
// Civic advocacy merge-back (2026-09-22): worker-written civic data plus the
// member/officer tables; every one carries the mfa_assurance floor.
export const CIVIC_ADVOCACY_RLS_TABLES = [
  "civic_bills",
  "civic_campaigns",
  "civic_district_aliases",
  "civic_districts",
  "civic_local_flags",
  "civic_local_jurisdictions",
  "civic_local_officials",
  "civic_member_addresses",
  "civic_member_messages",
  "civic_official_ratings",
  "civic_official_votes",
  "civic_officials",
  "civic_places",
  "civic_quarantine",
  "civic_roll_calls",
  "civic_user_district_changes",
  "civic_user_districts",
  "civic_user_places",
  "resolver_runs",
];

// Organization-structure import and member steward contact (20260924170000,
// 20260924170200): RPC-only tables, each with RLS and the mfa_assurance floor.
export const ORGANIZATION_STRUCTURE_RLS_TABLES = [
  "organization_chart_node_contacts",
  "organization_chart_node_notes",
  "organization_chart_node_metrics",
  "organization_chart_cross_references",
  "organization_reference_sections",
  "organization_reference_blocks",
  "organization_structure_imports",
  "steward_contact_preferences",
];

// SCIM directory mirror (20261003041000, REQ-UG-SCIM-PROVISIONING-20261001):
// RPC-only tables, each with RLS and the mfa_assurance floor.
export const SCIM_DIRECTORY_RLS_TABLES = [
  "scim_users",
  "scim_groups",
  "scim_group_members",
];

// SAML single sign-on (20261003042000, REQ-UG-SSO-SIGNIN-20261001):
// RPC-only tables, each with RLS and the mfa_assurance floor.
export const SSO_CONNECTION_RLS_TABLES = [
  "organization_sso_connections",
  "organization_sso_domains",
];

// Union Ground's October 14 replay adds 29 lifecycle tables and retires the nine
// unused database demo tables; the supported demo reads the static dataset.
const UNIONGROUND_LIFECYCLE_RLS_TABLES = [
  "union_employers",
  "union_worksites",
  "organizing_campaigns",
  "organizing_campaign_assignments",
  "organizing_stage_events",
  "organizing_work_areas",
  "organizing_workers",
  "organizing_contact_events",
  "organizing_resistance_incidents",
  "organizing_resistance_evidence",
  "organizing_bargaining_cycles",
  "organizing_bargaining_proposals",
  "organizing_bargaining_sessions",
  "member_membership_periods",
  "member_onboarding_steps",
  "member_participation_events",
  "coalition_partners",
  "coalition_handshakes",
  "coalition_commitments",
  "union_lifecycle_audit_events",
  "member_learning_sessions",
  "member_learning_assignments",
  "member_capacity_commitments",
  "member_participation_completions",
  "member_recognition_rules",
  "member_recognition_events",
  "organizing_bargaining_ratifications",
  "organizing_bargaining_ratification_corrections",
  "organizing_first_contracts",
];
const UNIONGROUND_RETIRED_DEMO_TABLES = [
  "demo_members",
  "demo_weekly_summaries",
  "demo_week_days",
  "demo_plan_items",
  "demo_conversations",
  "demo_broadcasts",
  "demo_cases",
  "demo_metrics",
  "demo_rights_lessons",
];


// Share your union's documents (20261022172000,
// REQ-UG-UNION-DOCUMENT-INTAKE-PAGE-20261022): RPC-only tables with no
// client grant, each with RLS and the mfa_assurance floor.
export const DOCUMENT_CONTRIBUTION_RLS_TABLES = [
  "union_document_contributions",
  "union_document_contribution_files",
];

// REQ-UG-ELECTIONS-MINUTES-NOMINATIONS-FORMS-20261030: ballot
// nominations (20261030214501).
export const BALLOT_NOMINATION_RLS_TABLES = ["ballot_nominations"];
// REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030: a
// steward's private booking notes (20261030234501).
export const BOOKING_NOTES_RLS_TABLES = ["member_appointment_notes"];

export function expectMi1OrganizationRlsContract(contract) {
  const retired = new Set([...RETIRED_W2_CASE_TABLES,
    'chapter_space_preferences', 'chapter_space_keyword_monitors', 'chapter_space_keyword_hits', ...UNIONGROUND_RETIRED_DEMO_TABLES]);
  const tables = [
    ...MI1_ORGANIZATION_RLS_TABLES,
    ...MI1_W1_FEATURE_PERSISTENCE_RLS_TABLES,
    ...MI1_PUBLIC_CHAPTER_HIERARCHY_RLS_TABLES,
    ...MI1_CLAUSE_QUICKREF_RLS_TABLES,
    ...MEMBER_ENGAGEMENT_RLS_TABLES,
    ...MI1_ACCESS_HISTORY_RLS_TABLES,
    ...MI1_ANALYTICS_PARITY_RLS_TABLES,
    ...MI1_CASEWORK_RLS_TABLES,
    ...ORGANIZATION_INTELLIGENCE_RLS_TABLES,
    ...MI1_AUTH_CONFIGURATION_RLS_TABLES,
    ...MI1_COORDINATION_RLS_TABLES,
    ...MI1_AUTOMATION_CONTROL_RLS_TABLES,
    ...MI1_KNOWLEDGE_LIBRARY_RLS_TABLES,
    ...KNOWLEDGE_CONVERSION_PROVENANCE_RLS_TABLES,
    ...MI1_RETENTION_RLS_TABLES,
    ...OPTIONAL_PROVIDER_COMPLETION_RLS_TABLES,
    ...INSTITUTIONAL_RECORDS_RLS_TABLES,
    ...ADMINISTRATIVE_EVIDENCE_RLS_TABLES,
    ...MI1_W2_FEATURE_PERSISTENCE_RLS_TABLES,
    ...CASEWORK_PROCEDURE_RLS_TABLES,
    ...MEMBER_SUPPORT_RLS_TABLES,
    ...MEMBER_OPERATIONS_RLS_TABLES,
    ...CONSTANT_CONTACT_RLS_TABLES,
    ...DUES_RLS_TABLES,
    ...MESSAGE_BODY_LIFECYCLE_RLS_TABLES,
    ...SENSITIVE_TRANSPORT_RLS_TABLES,
    ...COMPASS_HYBRID_RLS_TABLES,
    ...CHANNEL_CONTROLS_RLS_TABLES,
    ...MEMBER_PROFILE_DETAILS_RLS_TABLES,
    ...GOVERNANCE_RLS_TABLES,
    ...CIVIC_ADVOCACY_RLS_TABLES,
    ...ORGANIZATION_STRUCTURE_RLS_TABLES,
    ...SCIM_DIRECTORY_RLS_TABLES,
    ...SSO_CONNECTION_RLS_TABLES,
    ...DOCUMENT_CONTRIBUTION_RLS_TABLES,
    ...BALLOT_NOMINATION_RLS_TABLES,
    ...BOOKING_NOTES_RLS_TABLES,
    ...UNIONGROUND_LIFECYCLE_RLS_TABLES,
  ].filter(table => !retired.has(table));
  const inventory = requireRlsTables(contract, tables);
  for (const table of retired) expect(inventory).not.toContain(`public.${table}`);

  for (const table of MI1_AUTOMATION_CONTROL_RLS_TABLES) {
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "SELECT",
    }));
    for (const role of ["anon", "service_role"]) {
      expect(contract.tableGrants).toContainEqual(expect.objectContaining({
        table: `public.${table}`,
        role,
        privileges: "",
      }));
    }
  }

  for (const table of MI1_ORGANIZATION_RLS_TABLES) {
    expect(
      contract.policies.some((entry) => entry.table === table),
      `${table} must have an explicit contracted policy`,
    ).toBe(true);
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "SELECT",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MI1_W1_FEATURE_PERSISTENCE_RLS_TABLES) {
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: MI1_W1_FEATURE_SELECT_TABLES.has(table) ? "SELECT" : "",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MI1_W2_FEATURE_PERSISTENCE_RLS_TABLES.filter((name) => !RETIRED_W2_CASE_TABLES.includes(name))) {
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MI1_KNOWLEDGE_LIBRARY_RLS_TABLES) {
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of OPTIONAL_PROVIDER_COMPLETION_RLS_TABLES) {
    expect(
      contract.policies.some((entry) => entry.table === table),
      `${table} must have an explicit contracted policy`,
    ).toBe(true);
    for (const role of ["authenticated", "anon", "service_role"]) {
      expect(contract.tableGrants).toContainEqual(expect.objectContaining({
        table: `public.${table}`,
        role,
        privileges: "",
      }));
    }
  }

  for (const table of MI1_CLAUSE_QUICKREF_RLS_TABLES) {
    expect(
      contract.policies.some((entry) => entry.table === table),
      `${table} must have an explicit contracted policy`,
    ).toBe(true);
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "SELECT",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MI1_ACCESS_HISTORY_RLS_TABLES) {
    expect(
      contract.policies.some((entry) => entry.table === table),
      `${table} must have an explicit contracted policy`,
    ).toBe(true);
    // SEC-UG-MEMBER-ACCESS-EVENT-ACTOR-PROJECTION-20260921: the subject
    // reads the feed's columns through a column-scoped grant that withholds
    // actor_user_id, so the table-wide SELECT is gone.
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "",
    }));
    expect(contract.columnGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privilege: "SELECT",
      denied: ["actor_user_id"],
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MI1_COORDINATION_RLS_TABLES) {
    expect(
      contract.policies.some((entry) => entry.table === table),
      `${table} must have an explicit contracted policy`,
    ).toBe(true);
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "SELECT",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MI1_AUTH_CONFIGURATION_RLS_TABLES) {
    expect(
      contract.policies.some((entry) => entry.table === table),
      `${table} must have an explicit contracted policy`,
    ).toBe(true);
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MI1_PUBLIC_CHAPTER_HIERARCHY_RLS_TABLES) {
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "SELECT",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of ORGANIZATION_INTELLIGENCE_RLS_TABLES) {
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }

  for (const table of MEMBER_SUPPORT_RLS_TABLES) {
    expect(
      contract.policies.some((entry) => entry.table === table),
      `${table} must have an explicit contracted policy`,
    ).toBe(true);
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "authenticated",
      privileges: "SELECT",
    }));
    expect(contract.tableGrants).toContainEqual(expect.objectContaining({
      table: `public.${table}`,
      role: "anon",
      privileges: "",
    }));
  }
}
