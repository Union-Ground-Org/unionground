// @vitest-environment node
// Text tripwires over the task-file reconciliation migration (20260805150000)
// and the wired copies of its surface (db contract, vercel cron backstop).
// The load-bearing pin is a NEGATIVE one: nothing in this migration may delete
// storage.objects rows in SQL — a SQL delete removes only the catalog row and
// strands the object's bytes in the backing store beyond the reach of any
// sweep. Only /api/task-files-reconcile's Storage API call deletes both.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("chapter_task_files_reconciliation");
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

describe("apply order", () => {
  it("lands after the hardening pass so its remove_chapter_task_file is the final word", () => {
    const hardening = findMigrationName("chapter_task_files_hardening");
    const reconciliation = findMigrationName("chapter_task_files_reconciliation");
    expect(reconciliation > hardening).toBe(true);
  });
});

describe("remove_chapter_task_file re-emission", () => {
  const body = stripComments(fnBody(sql, "public.remove_chapter_task_file"));

  it("no longer deletes storage.objects in SQL", () => {
    expect(body).not.toMatch(/delete\s+from\s+storage\.objects/i);
  });

  it("keeps the registration-row delete, the staff gate and the activity trail", () => {
    expect(body).toContain("delete from public.chapter_task_files where id = file_row.id");
    expect(body).toContain("member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(body).toContain("'file_removed'");
    expect(body).toContain("for update of f");
  });
});

describe("reconcile_chapter_task_files", () => {
  const body = stripComments(fnBody(sql, "public.reconcile_chapter_task_files"));

  it("is service-role only", () => {
    expect(code).toContain(
      "revoke all on function public.reconcile_chapter_task_files(integer) from public, anon, authenticated",
    );
    expect(code).toContain(
      "grant execute on function public.reconcile_chapter_task_files(integer) to service_role",
    );
  });

  it("never deletes storage.objects in SQL anywhere in the migration", () => {
    expect(code).not.toMatch(/delete\s+from\s+storage\.objects/i);
  });

  it("deletes stale rows only past the 24h grace and fails closed when the bucket looks blind", () => {
    expect(body).toContain("interval '24 hours'");
    expect(body).toContain("if stale_candidates > 0 and visible_objects = 0 then");
    expect(body).toContain("get diagnostics removed_rows = row_count");
  });

  it("reports orphans with a settle grace and a hard page cap", () => {
    expect(body).toContain("interval '1 hour'");
    expect(body).toContain("least(greatest(coalesce(p_max_orphan_objects, 0), 0), 500)");
    expect(body).toContain("'orphanTotal', orphan_total");
  });

  it("pins the empty search path", () => {
    expect(body).toContain("set search_path = ''");
  });
});

describe("tick plumbing", () => {
  it("stays inert until the URL and the vault secret both exist", () => {
    expect(code).toContain("c.files_reconcile_url is not null");
    expect(code).toContain("s.name = 'notifications-dispatch-secret'");
  });

  it("guards scheduling on pg_cron and pg_net availability", () => {
    expect(code).toContain("from pg_catalog.pg_available_extensions where name = 'pg_cron'");
    expect(code).toContain("from pg_catalog.pg_available_extensions where name = 'pg_net'");
  });

  it("runs after the daily task purge so purge-orphaned objects are swept the same morning", () => {
    expect(code).toContain("'task-files-reconcile-tick'");
    expect(code).toContain("'37 4 * * *'");
    const maintenance = contract.cron.find((job) => job.jobname === "task-maintenance-daily");
    expect(maintenance.schedule).toBe("17 4 * * *");
  });

  it("locks the tick table away from every client role", () => {
    expect(code).toContain(
      "revoke all on private.task_file_reconcile_ticks from public, anon, authenticated, service_role",
    );
  });

  it("constrains the URL column to https", () => {
    expect(code).toContain("add column if not exists files_reconcile_url text");
    expect(code).toContain("files_reconcile_url ~ '^https://[[:graph:]]+$'");
  });
});

describe("wired copies", () => {
  it("the db contract pins the cron job, the control column and the RPC's exposure", () => {
    const tick = contract.cron.find((job) => job.jobname === "task-files-reconcile-tick");
    expect(tick?.schedule).toBe("37 4 * * *");
    expect(contract.controlPlane.columns).toContain("files_reconcile_url");
    const fn = contract.functions.find(
      (entry) => entry.sig === "public.reconcile_chapter_task_files(p_max_orphan_objects integer, p_expected_deleted_objects jsonb)",
    );
    expect(fn?.exec).toBe("service_role");
    const remove = contract.functions.find(
      (entry) => entry.sig === "public.remove_chapter_task_file(p_file_id uuid)",
    );
    // The contract must not still expect the SQL storage delete the
    // re-emission removed.
    expect(JSON.stringify(remove.bodyContains)).not.toMatch(/storage\.objects/);
    // ...and must actively FORBID its return, live, in both functions (sol
    // 2026-08-05: positive needles alone let a later redefinition restore the
    // byte-stranding delete unnoticed).
    expect(remove.bodyForbids).toContain("delete from storage.objects");
    expect(fn.bodyForbids).toContain("delete from storage.objects");
  });

  it("the db contract pins the tick's command and the tick tables' zero-privilege ACLs", () => {
    const tick = contract.cron.find((job) => job.jobname === "task-files-reconcile-tick");
    // jobname+schedule say nothing about what runs; the command pins are what
    // stop a kept slot from POSTing the Vault bearer somewhere else.
    expect(tick.commandContains).toContain("c.files_reconcile_url is not null");
    // 20261019100000: the dedicated bearer wins; the legacy name is only the
    // fallback that keeps an already-configured environment unchanged.
    expect(tick.commandContains).toContain("v.name in ('task-files-reconcile-secret', 'notifications-dispatch-secret')");
    expect(tick.commandContains).toContain("order by (v.name = 'task-files-reconcile-secret') desc");
    for (const table of ["private.task_file_reconcile_ticks", "private.notification_dispatch_ticks"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const grant = contract.tableGrants.find((e) => e.table === table && e.role === role);
        expect(grant?.privileges).toBe("");
      }
    }
  });

  it("vercel keeps a daily cron backstop pointing at the endpoint", () => {
    expect(vercel.crons.some((entry) => entry.path === "/api/task-files-reconcile")).toBe(true);
    expect(vercel.functions["api/task-files-reconcile.js"]).toBeTruthy();
  });
});
