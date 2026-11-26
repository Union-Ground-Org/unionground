import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody } from "./helpers/migration.js";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260829023000_mi1_automation_control_room.sql",
), "utf8");

describe("CR-108 automation control migration", () => {
  it("creates tenant-keyed RLS stores with no seeded organization or definitions", () => {
    const schemaAndPrivateFunctions = migration.slice(0, migration.indexOf(
      "create function public.save_organization_automation_definition",
    ));
    for (const table of ["settings", "definitions", "runs", "effects"]) {
      expect(migration).toContain(`create table public.organization_automation_${table}`);
      expect(migration).toContain(`alter table public.organization_automation_${table} enable row level security`);
      expect(migration).toContain(`organization_automation_${table}_operator_select`);
      expect(migration).toContain(`grant select on public.organization_automation_${table} to authenticated`);
    }
    expect(migration).not.toMatch(/insert into public\.organizations\s*\(/i);
    expect(schemaAndPrivateFunctions).not.toMatch(/insert into public\.organization_automation_definitions\s*\([^)]*\)\s*values/i);
  });

  it("keeps direct browser writes revoked and every public mutation behind exact RPC grants", () => {
    expect(migration).toContain("revoke all on public.organization_automation_definitions from public, anon, authenticated, service_role");
    expect(migration).toContain("revoke truncate, references, trigger, maintain on public.organization_automation_definitions from service_role");
    expect(migration).toContain("create function private.cr108_require_operator()");
    expect(migration).toContain("private.has_organization_role(organization_id, array['admin', 'vp'])");
    expect(migration).toContain("if not private.mfa_satisfied() then");
    for (const fn of [
      "get_organization_automation_control_room()",
      "set_organization_automation_enabled(boolean, text)",
      "set_organization_automation_safety_cap(integer)",
      "preview_organization_automation_run(uuid)",
      "execute_organization_automation_run(uuid, text)",
      "rollback_organization_automation_run(uuid, text)",
    ]) {
      expect(migration).toContain(`grant execute on function public.${fn} to authenticated`);
    }
  });

  it("enforces typed confirmation, capped execution, preview expiry, and human-preserving rollback", () => {
    expect(migration).toContain("'ENABLE AUTOMATION'");
    expect(migration).toContain("'PAUSE AUTOMATION'");
    expect(migration).toContain("'RUN ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8))");
    expect(migration).toContain("'ROLL BACK ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8))");
    expect(migration).toContain("run_row.completed_at < pg_catalog.now() - interval '15 minutes'");
    expect(migration).toContain("max_effects_per_run between 1 and 50");
    expect(migration).toContain("task_row.updated_at > task_row.created_at + interval '5 seconds'");
    expect(migration).toContain("task_row.title is distinct from effect_row.task_title");
    expect(migration).toContain("task_row.description <> ''");
    expect(migration).toContain("task_row.priority is distinct from effect_row.task_priority");
    expect(migration).toContain("select pg_catalog.count(*) from public.chapter_task_activity");
    expect(migration).toContain("status = final_status");
  });

  it("creates only fixed privacy-safe Standard Tasks and deduplicates active source effects", () => {
    expect(migration).toContain("'Review overdue work'");
    expect(migration).toContain("'Prepare for a case deadline'");
    expect(migration).toContain("'Assign case ownership'");
    expect(migration).toContain("new.description <> ''");
    expect(migration).toContain("new.assignee_id is not null");
    expect(migration).toContain("new.start_date is not null");
    expect(migration).toContain("new.due_date is not null");
    expect(migration).toContain("organization_automation_effects_active_source_idx");
    expect(migration).toContain("task_id uuid unique references public.chapter_tasks(id) on delete set null");
    expect(migration).toContain("planned_task_id survives the shared 90-day task purge");
    expect(migration).not.toContain("service_role_key");
  });

  it("installs a bounded pg_cron dispatcher without exposing its private functions", () => {
    const dispatcher = fnBody(migration, "private.run_due_organization_automations");
    expect(migration).toContain("create function private.run_due_organization_automations(p_limit integer default 25)");
    expect(migration).toContain("for update of d skip locked");
    expect(dispatcher).toContain("pg_advisory_xact_lock");
    expect(dispatcher.indexOf("pg_advisory_xact_lock")).toBeLessThan(dispatcher.indexOf("for update of d skip locked"));
    expect(migration).toContain("'organization-automation-tick'");
    expect(migration).toContain("'11 * * * *'");
    expect(migration).toContain("select private.run_due_organization_automations(25);");
    expect(migration).toContain("revoke all on function private.run_due_organization_automations(integer) from public, anon, authenticated, service_role");
  });

  it("reports the full candidate count while keeping created effects capped", () => {
    const counter = fnBody(migration, "private.cr108_candidate_count");
    expect(counter).toContain("return total::integer");
    expect(counter).not.toContain("least(total, 10000)");
  });
});
