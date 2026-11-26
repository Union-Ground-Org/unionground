// Donor salvage ledger for CR-092 / CR-093 / CR-094.
// Inspected at the donor snapshot archive/pre-clean-room-main-20260721.
// No donor file is copied wholesale. Next.js actions, migrations, and live SCIM
// issuance stay rejected.

export const DONOR_BASELINE_SHA = "donor-baseline-20260721";
export const DONOR_REF = "archive/pre-clean-room-main-20260721";

export const DONOR_REUSE = Object.freeze([
  {
    donorPath: "lib/integrations/control-plane.ts",
    disposition: "reuse_direct",
    destination: "src/features/integrations/controlPlane.js",
    note: "Provider catalog shape, chapter-override merge, and effective-connection resolver. Rekeyed from branch_id to chapterId.",
  },
  {
    donorPath: "lib/integrations/registry.ts",
    disposition: "reuse_direct",
    destination: "src/features/integrations/secrets.js",
    note: "Prefixed secret generation, SHA-256 hashing, display prefix, and hash-stripping sanitizers. Prefixes changed from sg_ to ug_.",
  },
  {
    donorPath: "lib/integrations/registry.ts",
    disposition: "port_adapt",
    destination: "src/features/integrations/webhooks.js",
    note: "Event catalog and URL parsing. HTTPS-only checks replaced with DNS/IP/redirect-safe egress classification.",
  },
  {
    donorPath: "lib/integrations/request-planner.ts",
    disposition: "port_adapt",
    destination: "src/features/integrations/jobs.js",
    note: "Sanitized job-plan envelope only. No vendor-specific planner was ported: Union Ground has no payroll, card-payment or workspace planner.",
  },
  {
    donorPath: "app/dashboard/admin/integrations/registry-client.tsx",
    disposition: "port_adapt",
    destination: "src/features/integrations/IntegrationControlPlane.jsx",
    note: "Admin card anatomy: one-time secret display, webhook event chips, API-key revoke/rotate, disabled SCIM copy.",
  },
]);

export const DONOR_REJECTED = Object.freeze([
  "app/dashboard/admin/integrations/registry-actions.ts — Next.js server actions; caller-supplied organizationId; live SCIM token insert",
  "app/dashboard/admin/integrations/actions.ts — Next.js actions and service-client org passthrough",
  "supabase/migrations/0633_org_chapter_integration_control_plane.sql — donor migration history; branch_id / members / auth_has_org_role",
  "supabase/migrations/0752_integration_registry.sql — donor migration history; live scim_tokens issuance",
  "supabase/migrations/0661_integrations_admin_flag.sql — donor feature-flag table",
  "lib/integrations/adp-dues-import.ts and sibling vendor planners — Union Ground leaves dues out, so no dues import or card-payment planner exists",
  "Union Ground live/SCIM secret prefixes and members.id attribution",
  "NULL branch_id as global authority",
  "HTTPS-only webhook validation without private-IP / metadata / credential / redirect guards",
  "Active SCIM directory synchronization and ordinary-organization token issuance",
]);
