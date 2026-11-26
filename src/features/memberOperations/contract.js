export const MEMBER_OPERATIONS_DONOR = Object.freeze({
  baseline: "donor-baseline-20260721",
  disposition: "port_adapt",
  screenedPaths: Object.freeze([
    "app/dashboard/settings/import/actions.ts",
    "app/dashboard/settings/import/csv-importer.tsx",
    "app/dashboard/messages/member-handoff-section.tsx",
    "pre-cutover member administration routes",
    "pre-cutover welcome campaign and outbox routes",
    "pre-cutover weekly-question pool and selection actions",
  ]),
  rejected: Object.freeze([
    "request-supplied tenant identity",
    "service-role browser paths",
    "legacy credentials, project identifiers, dependencies, and migration history",
    "legacy agency-as-tenant authorization",
    "PIN and self-signup welcome flows",
    "arbitrary role assignment through imports",
    "partial imports reported as success",
    "fictional production tenants, users, campaigns, or cases",
    "raw member, grievance, email, or CSV content in logs",
  ]),
});

export const MEMBER_OPERATIONS_RPCS = Object.freeze({
  workspace: "get_member_operations_workspace",
  directory: "get_member_operations_directory",
  profile: "get_member_operational_profile",
  saveProfile: "save_member_operational_profile",
  bulkUpdateProfiles: "bulk_update_member_operational_profiles",
  welcomeWorkspace: "get_welcome_campaign_workspace",
  welcomeEnrollments: "list_welcome_campaign_enrollments",
  saveWelcomeCampaign: "save_welcome_campaign",
  saveWelcomeStep: "save_welcome_campaign_step",
  enrollWelcome: "enroll_member_in_welcome_campaign",
  transitionWelcome: "transition_member_welcome_enrollment",
  queueWelcome: "queue_due_welcome_messages",
  importWorkspace: "get_member_import_workspace",
  importBatches: "list_member_import_batches",
  stageImport: "stage_member_operations_import",
  validateImport: "validate_member_operations_import",
  commitImport: "commit_member_operations_import",
  discardImport: "discard_member_operations_import",
});

export const OPERATIONAL_PROFILE_FIELDS = Object.freeze([
  "memberNumber",
  "jobTitle",
  "department",
  "workLocation",
  "hireDate",
  "membershipClass",
  "preferredLanguage",
  "administrativeNotes",
]);

export const MEMBER_IMPORT_FIELDS = Object.freeze([
  "member_id",
  "email",
  "member_number",
  "job_title",
  "department",
  "work_location",
  "hire_date",
  "membership_class",
  "preferred_language",
  "administrative_notes",
]);

export const GRIEVANCE_IMPORT_FIELDS = Object.freeze([
  "member_id",
  "member_email",
  "chapter_id",
  "reference",
  "title",
  "deadline",
  "articles",
]);

export const EMPTY_MEMBER_OPERATIONS_WORKSPACE = Object.freeze({
  state: "empty",
  organizationId: null,
  directory: Object.freeze({ items: Object.freeze([]), nextCursor: null }),
  campaigns: Object.freeze([]),
  imports: Object.freeze([]),
  importsNextCursor: null,
  deliveryConfigured: false,
});
