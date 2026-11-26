// @vitest-environment node
//
// UX-UG-PRESIDENT-VP-AUTOMATION-APPROVER-OFFERED-APPOINTMENT-RECIPE-20260921
//
// A President (vp) is an automation approver, but appointment sources are
// visible only to a coordinator, advisor or admin whose home chapter holds the
// appointment. A vp-activated appointment automation therefore ran with an
// authority that could see no appointment, and matched nothing on every tick.
// 20260925630600 refuses that activation with a named reason and advertises
// appointmentSupervision on the workspace. The static half compares the
// re-declared bodies with their predecessors. The live half drives
// save -> submit -> approve -> activate as a President and as a supervising
// admin on a disposable database inside one rolled-back transaction, then runs
// the real scheduler with no JWT.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20260925630600_automation_appointment_recipe_supervision.sql";
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

describe("automation appointment supervision (static)", () => {
  it("adds only the activation refusal to the status writer", () => {
    const predecessor = bodyOf(read("supabase/migrations/20260911070000_automation_shared_intelligence_v3.sql"), "create or replace function public.set_organization_automation_definition_status(");
    const body = bodyOf(migration, "create or replace function public.set_organization_automation_definition_status(");
    const refusal = body.slice(body.indexOf("  -- Scheduled runs execute with updated_by"), body.indexOf("  end if;\n  perform private.cr108_record_audit(") + "  end if;\n".length);
    expect(refusal).toContain("and saved.trigger_kind in ('appointment_upcoming', 'appointment_followup')");
    expect(refusal).toContain("and not private.automation_v3_appointment_supervisor(actor, org, saved.conditions ->> 'chapterId') then");
    expect(refusal).toContain("raise exception 'appointment supervision required' using errcode = '42501';");
    expect(body.replace(refusal, "")).toBe(predecessor);
    expect(body.trimStart().startsWith("declare")).toBe(true);
    expect(body).toContain("begin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n  actor := (select auth.uid());");
  });

  it("adds only the appointmentSupervision flag to the workspace payload", () => {
    const predecessor = bodyOf(read("supabase/migrations/20260924181000_automation_workspace_tenant_predicate.sql"), "create or replace function public.mi1_get_automation_workspace()");
    const body = bodyOf(migration, "create or replace function public.mi1_get_automation_workspace()");
    const flag = "    'appointmentSupervision', private.automation_v3_appointment_supervisor(actor, org, null),\n";
    expect(body).toContain(flag);
    expect(body.replace(flag, "")).toBe(predecessor);
  });

  it("guards both predecessors and keeps the helper out of client reach", () => {
    const guard = migration.indexOf("do $predecessor$");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(migration.indexOf("create or replace function"));
    expect(migration).toContain("'0489bfc69ad751d2515da41014e6dfb514cf29d689be94238c6e8bfab12adf4f'");
    expect(migration).toContain("'39910ef64553434b60365c6d994624f0c93823a3464272bf47c359ccad839158'");
    expect(migration).toContain("revoke all on function private.automation_v3_appointment_supervisor(uuid, uuid, text)\n  from public, anon, authenticated, service_role;");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("automation appointment supervision on a disposable database", () => {
  let db;
  const f = {
    org: randomUUID(), vp: randomUUID(), admin: randomUUID(), member: randomUUID(), steward: randomUUID(),
  };
  f.home = `appt-supervision-home-${f.org.slice(0, 8)}`;
  f.other = `appt-supervision-other-${f.org.slice(0, 8)}`;
  const sessions = new Map();

  async function as(userId, statement, values = []) {
    await db.query("savepoint appointment_supervision");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessions.get(userId), aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint appointment_supervision");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint appointment_supervision");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  async function ok(userId, statement, values = []) {
    const result = await as(userId, statement, values);
    expect(result, result.message).toMatchObject({ code: "" });
    return result.rows[0]?.v;
  }

  // save -> submit -> approve at the exact version; returns the approved row.
  async function approvedAppointmentDefinition(userId, conditions = {}) {
    const saved = await ok(userId, "select public.mi1_save_automation_definition_v2($1::jsonb) v", [JSON.stringify({
      schemaVersion: 2, name: `Appointment prep ${randomUUID().slice(0, 8)}`, triggerKind: "appointment_upcoming",
      thresholdDays: 2, taskPriority: "medium", cadence: "daily", conditions,
      actionKind: "create_standard_task", actionConfig: {},
    })]);
    await ok(userId, "select public.mi1_submit_automation_definition($1,$2) v", [saved.id, saved.version]);
    await ok(userId, "select public.mi1_review_automation_definition($1,$2,'approve',null) v", [saved.id, saved.version]);
    return saved;
  }

  async function activate(userId, definition) {
    return as(userId, "select public.set_organization_automation_definition_status($1,'active',$2) v", [definition.id, definition.version]);
  }

  async function status(definition) {
    return (await db.query("select status, updated_by from public.organization_automation_definitions where id=$1", [definition.id])).rows[0];
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "automation-appointment-supervision-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const people = [f.vp, f.admin, f.member, f.steward];
    for (const id of people) await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$2,'Appointment supervision proof org',$3)", [f.org, `appt-supervision-${f.org.slice(0, 8)}`, f.admin]);
    for (const [chapter, order] of [[f.home, 92571], [f.other, 92572]]) {
      await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,$3)", [chapter, f.org, order]);
    }
    for (const id of people) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, f.home]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, f.home]);
      const session = randomUUID();
      sessions.set(id, session);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    for (const [id, role] of [[f.vp, "vp"], [f.admin, "admin"], [f.steward, "steward"]]) {
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$4)", [f.org, id, role, f.admin]);
    }
    await db.query(
      `insert into public.member_appointments(user_id,steward_id,chapter_id,appointment_type,duration_minutes,starts_at,ends_at,status,routed_via)
       values ($1,$2,$3,'office_hours',30,now()+interval '1 day',now()+interval '1 day'+interval '30 minutes','confirmed','steward')`,
      [f.member, f.steward, f.home],
    );
    await ok(f.admin, "select public.set_organization_automation_enabled(true,'ENABLE AUTOMATION') v");
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("the workspace advertises appointment supervision per session", async () => {
    const vp = await ok(f.vp, "select public.mi1_get_automation_workspace() v");
    const admin = await ok(f.admin, "select public.mi1_get_automation_workspace() v");
    expect(vp.access).toMatchObject({ canApprove: true });
    expect(vp.appointmentSupervision).toBe(false);
    expect(admin.appointmentSupervision).toBe(true);
  });

  it("a President cannot activate an appointment automation and is told why", async () => {
    const definition = await approvedAppointmentDefinition(f.vp);
    const refused = await activate(f.vp, definition);
    expect(refused.code).toBe("42501");
    expect(refused.message).toBe("appointment supervision required");
    expect(await status(definition)).toMatchObject({ status: "draft" });
  });

  it("an admin cannot activate one scoped to a chapter other than their home chapter", async () => {
    const definition = await approvedAppointmentDefinition(f.admin, { chapterId: f.other });
    const refused = await activate(f.admin, definition);
    expect(refused.code).toBe("42501");
    expect(refused.message).toBe("appointment supervision required");
    expect(await status(definition)).toMatchObject({ status: "draft" });
  });

  it("a supervising admin activates one and the scheduler, with no JWT, selects the appointment", async () => {
    await db.query("savepoint supervised_activation");
    try {
      const definition = await approvedAppointmentDefinition(f.admin);
      const activated = await activate(f.admin, definition);
      expect(activated, activated.message).toMatchObject({ code: "" });
      expect(await status(definition)).toEqual({ status: "active", updated_by: f.admin });
      await db.query("select set_config('request.jwt.claims','',true)");
      await db.query("select private.run_due_organization_automations(50)");
      const runs = (await db.query(
        "select mode, status, candidates_count, failure_code from public.organization_automation_runs where definition_id=$1",
        [definition.id],
      )).rows;
      expect(runs).toHaveLength(1);
      // Candidate selection is what supervision governs; the effect itself is out of scope here.
      expect(runs[0]).toMatchObject({ mode: "scheduled", candidates_count: 1 });
    } finally {
      await db.query("rollback to savepoint supervised_activation");
    }
  });

  it("pausing and archiving an appointment automation are not gated on supervision", async () => {
    await db.query("savepoint pause_archive");
    try {
      const definition = await approvedAppointmentDefinition(f.admin);
      expect(await activate(f.admin, definition)).toMatchObject({ code: "" });
      const paused = await as(f.vp, "select public.set_organization_automation_definition_status($1,'paused',$2) v", [definition.id, definition.version]);
      expect(paused, paused.message).toMatchObject({ code: "" });
      const archived = await as(f.vp, "select public.set_organization_automation_definition_status($1,'archived',$2) v", [definition.id, definition.version]);
      expect(archived, archived.message).toMatchObject({ code: "" });
    } finally {
      await db.query("rollback to savepoint pause_archive");
    }
  });
});
