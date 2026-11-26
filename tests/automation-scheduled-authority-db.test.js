// @vitest-environment node
//
// OPS-UG-AUTOMATION-SCHEDULED-AUTHORITY-DEPENDS-ON-LAST-EDITOR-20260921
//
// A scheduled automation run has no initiator. Its authority is therefore the
// definition's updated_by, the approver who last activated it. Once that person
// stopped being an active Admin/President operator, every tick raised
// 'operator unavailable' and the dispatcher stored failure_code
// 'internal_error', with no signal anywhere in the v3 workspace.
// 20260925630300 names the failure 'operator_unavailable' and restores
// dependencyReady for approvers. The static half compares the re-declared
// bodies with their predecessors. The live half demotes the activating admin
// and runs the real dispatcher with no JWT, as pg_cron does, on a disposable
// database inside one rolled-back transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20260925630300_automation_scheduled_authority_named_failure.sql";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read(MIGRATION);

function bodyOf(sql, declaration) {
  const start = sql.indexOf(declaration);
  expect(start, declaration).toBeGreaterThan(-1);
  const open = sql.indexOf("as $function$", start) + "as $function$".length;
  const close = sql.indexOf("$function$;", open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

describe("automation scheduled authority (static)", () => {
  it("changes only the dispatcher's failure code for the operator refusal", () => {
    const predecessor = bodyOf(read("supabase/migrations/20260911070000_automation_shared_intelligence_v3.sql"), "create or replace function private.run_due_organization_automations(");
    const body = bodyOf(migration, "create or replace function private.run_due_organization_automations(");
    const before = "      update public.organization_automation_runs set status = 'failed', failure_code = 'internal_error', completed_at = pg_catalog.now() where id = run_id;\n";
    expect(predecessor).toContain(before);
    const start = body.indexOf("      -- A scheduled run has no initiator");
    const end = body.indexOf("       where id = run_id;\n") + "       where id = run_id;\n".length;
    const replacement = body.slice(start, end);
    expect(replacement).toContain("when sqlstate = '42501' and sqlerrm = 'operator unavailable' then 'operator_unavailable'");
    expect(replacement).toContain("else 'internal_error'");
    expect(body.replace(replacement, before)).toBe(predecessor);
    expect(body.trimStart().startsWith("begin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBe(true);
  });

  it("adds dependencyReady to the definition projection for approvers only", () => {
    const declaration = "create or replace function private.automation_v3_definition_json(\n  d public.organization_automation_definitions,\n  p_actor uuid,\n  p_org uuid,\n  p_approver boolean\n)";
    const predecessor = bodyOf(read("supabase/migrations/20260924181000_automation_workspace_tenant_predicate.sql"), declaration);
    const body = bodyOf(migration, declaration);
    const start = body.indexOf("  ) || case\n");
    const end = body.indexOf("  end;\nend;") + "  end;\n".length;
    const added = body.slice(start, end);
    expect(added).toContain("when approver then pg_catalog.jsonb_build_object(");
    expect(added).toContain("'dependencyReady', coalesce(private.automation_v2_operator(d.updated_by, p_org), false)");
    expect(added).toContain("else '{}'::jsonb");
    expect(body.replace(added, "  );\n")).toBe(predecessor);
  });

  it("guards both predecessors and admits exactly one new failure code", () => {
    const guard = migration.indexOf("do $predecessor$");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(migration.indexOf("create or replace function"));
    expect(migration).toContain("'b81a4805adf0889b4f680fe6504cd1d01aa526ac3c2e04be53440a9d13dddeff'");
    expect(migration).toContain("'5282e18414dce96305533409a40d3710b89cbda921aaf976e618f8f4320aed15'");
    expect(migration).toContain("failure_code in ('disabled', 'definition_changed', 'effect_write_failed', 'internal_error', 'operator_unavailable')");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("automation scheduled authority on a disposable database", () => {
  let db;
  const f = { org: randomUUID(), activator: randomUUID(), approver: randomUUID(), steward: randomUUID() };
  f.chapter = `sched-authority-${f.org.slice(0, 8)}`;
  const sessions = new Map();
  let definition;
  let firstRun;

  async function as(userId, statement, values = []) {
    await db.query("savepoint scheduled_authority");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessions.get(userId), aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint scheduled_authority");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint scheduled_authority");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  async function ok(userId, statement, values = []) {
    const result = await as(userId, statement, values);
    expect(result, result.message).toMatchObject({ code: "" });
    return result.rows[0]?.v;
  }

  // Every run in this transaction shares one now(), so runs are told apart by
  // id: a tick returns only the runs it created.
  async function tick() {
    const before = (await db.query("select id from public.organization_automation_runs where definition_id=$1", [definition.id])).rows.map((row) => row.id);
    await db.query("select set_config('request.jwt.claims','',true)");
    await db.query("select private.run_due_organization_automations(50)");
    return (await db.query(
      "select mode, status, failure_code from public.organization_automation_runs where definition_id=$1 and not (id = any($2::uuid[]))",
      [definition.id, before],
    )).rows;
  }

  async function workspaceDefinition(userId) {
    const workspace = await ok(userId, "select public.mi1_get_automation_workspace() v");
    return workspace.definitions.find((row) => row.id === definition.id);
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "automation-scheduled-authority-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const people = [f.activator, f.approver, f.steward];
    for (const id of people) await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$2,'Scheduled authority proof org',$3)", [f.org, `sched-authority-${f.org.slice(0, 8)}`, f.activator]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,92573)", [f.chapter, f.org]);
    for (const id of people) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, f.chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, f.chapter]);
      const session = randomUUID();
      sessions.set(id, session);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    for (const [id, role] of [[f.activator, "admin"], [f.approver, "admin"], [f.steward, "steward"]]) {
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$4)", [f.org, id, role, f.activator]);
    }
    await ok(f.activator, "select public.set_organization_automation_enabled(true,'ENABLE AUTOMATION') v");
    const saved = await ok(f.activator, "select public.mi1_save_automation_definition_v2($1::jsonb) v", [JSON.stringify({
      schemaVersion: 2, name: "Scheduled authority proof", triggerKind: "overdue_task", thresholdDays: 1,
      taskPriority: "medium", cadence: "daily", conditions: {}, actionKind: "create_standard_task", actionConfig: {},
    })]);
    await ok(f.activator, "select public.mi1_submit_automation_definition($1,$2) v", [saved.id, saved.version]);
    await ok(f.activator, "select public.mi1_review_automation_definition($1,$2,'approve',null) v", [saved.id, saved.version]);
    await ok(f.activator, "select public.set_organization_automation_definition_status($1,'active',$2) v", [saved.id, saved.version]);
    definition = saved;
    // The activating admin is demoted; their updated_by stamp remains the
    // definition's only scheduled authority.
    await db.query("delete from public.organization_role_grants where organization_id=$1 and user_id=$2", [f.org, f.activator]);
    firstRun = await tick();
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("a tick whose scheduled authority was demoted fails with the named reason, not internal_error", () => {
    expect(firstRun).toEqual([{ mode: "scheduled", status: "failed", failure_code: "operator_unavailable" }]);
  });

  it("the workspace shows an approver that the definition's scheduled authority is not ready", async () => {
    const row = await workspaceDefinition(f.approver);
    expect(row).toMatchObject({ status: "active", dependencyReady: false });
  });

  it("staff who cannot approve do not learn another person's operator state", async () => {
    const row = await workspaceDefinition(f.steward);
    if (row) expect(row).not.toHaveProperty("dependencyReady");
    const own = await ok(f.steward, "select public.mi1_get_automation_workspace() v");
    expect(own.definitions.every((item) => !Object.hasOwn(item, "dependencyReady"))).toBe(true);
  });

  it("activating it again as a current approver restores the authority and the next tick runs", async () => {
    await db.query("savepoint reactivate");
    try {
      await ok(f.approver, "select public.set_organization_automation_definition_status($1,'active',$2) v", [definition.id, definition.version]);
      expect(await workspaceDefinition(f.approver)).toMatchObject({ dependencyReady: true });
      const runs = await tick();
      expect(runs).toHaveLength(1);
      expect(runs[0].mode).toBe("scheduled");
      expect(runs[0].status, JSON.stringify(runs[0])).not.toBe("failed");
      expect(runs[0].failure_code, JSON.stringify(runs[0])).toBeNull();
    } finally {
      await db.query("rollback to savepoint reactivate");
    }
  });

  it("the failure code check admits operator_unavailable and still refuses an unknown code", async () => {
    await db.query("savepoint unknown_code");
    try {
      await expect(db.query(
        "update public.organization_automation_runs set failure_code='mystery' where definition_id=$1", [definition.id],
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await db.query("rollback to savepoint unknown_code");
    }
  });
});
