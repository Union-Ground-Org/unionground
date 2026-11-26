import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forbiddenSupabaseRefsIn } from "./lib/sibling-deny-list.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
  join(root, "supabase/migrations/20260828210000_mi1_casework_suite.sql"),
  "utf8",
);

const required = [
  "casework_strength_analyses",
  "casework_bargaining_workspaces",
  "casework_bargaining_proposals",
  "casework_bargaining_events",
  "casework_deadlines",
  "casework_deadline_extensions",
  "casework_checklists",
  "casework_step_transitions",
  "casework_access_grants",
  "casework_alerts",
  "casework_alert_acknowledgements",
  "casework_management_entries",
  "casework_management_addenda",
  "casework_retaliation_reports",
  "casework_retaliation_patterns",
  "casework_intake_drafts",
  "casework_entity_links",
  "casework_reminders",
];

const failures = [];
for (const table of required) {
  if (!migration.includes(`create table public.${table}`)) failures.push(`missing table ${table}`);
  if (!migration.includes(`alter table public.${table} enable row level security`)) failures.push(`missing RLS ${table}`);
}
for (const blocked of ["service_role", ...forbiddenSupabaseRefsIn(migration), "branch_id is null", "revoke all on all tables in schema public"]) {
  if (migration.toLowerCase().includes(blocked)) failures.push(`blocked donor/global pattern: ${blocked}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `FAIL: ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`PASS: ${required.length} casework persistence families verified.`);
