// @vitest-environment node
//
// SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920
//
// Deadline and alert creation were direct authenticated INSERTs that left no
// public.casework_audit_events row, and the procedure deadline
// casework_advance_step inserts left none either. The definer routines are now
// the only client creation route, the direct privilege is gone, the procedure
// route writes the same deadline_created row, the macro route still writes
// exactly one alert_created row, and each creation's metadata is derived or
// drawn from a closed vocabulary.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20260925550200_casework_deadline_alert_creation_audit.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const clientApi = readFileSync(new URL("../src/lib/caseworkApi.js", import.meta.url), "utf8");

describe("casework deadline and alert creation audit (static)", () => {
  it("pins SELECT-only grants, the retired write policies and the browser's RPC route", () => {
    expect(migration).toContain("'cases_exported','deadline_created'");
    expect(migration).toContain("revoke insert on public.casework_deadlines from authenticated;");
    expect(migration).toContain("revoke insert on public.casework_alerts from authenticated;");
    expect(migration).toContain("drop policy if exists casework_deadlines_staff_write on public.casework_deadlines;");
    expect(migration).toContain("drop policy if exists casework_alerts_create on public.casework_alerts;");
    expect(migration).toContain("create policy casework_deadlines_staff_read on public.casework_deadlines");
    // The gate order every casework_audit_events writer keeps: the case graph
    // lock precedes the MFA gate, the authorization read and every row it takes.
    for (const routine of ["casework_create_deadline", "casework_create_alert"]) {
      const body = migration.slice(migration.indexOf(`create or replace function public.${routine}(`));
      expect(body.indexOf("private.lock_case_graph(array[auth.uid()], array[p_case_id])"))
        .toBeLessThan(body.indexOf("private.casework_require_mfa()"));
      expect(body.indexOf("private.casework_require_mfa()"))
        .toBeLessThan(body.indexOf("private.casework_staff_can_access(v_case.id)"));
    }
    // The label and the message are staff-authored free text and are recorded
    // nowhere in the audit rows.
    expect(migration).not.toMatch(/jsonb_build_object\([^)]*'label'/);
    expect(migration).not.toMatch(/jsonb_build_object\([^)]*'message'/);
    for (const table of ["casework_deadlines", "casework_alerts"]) {
      expect(contract.tableGrants).toContainEqual({
        table: `public.${table}`,
        role: "authenticated",
        privileges: "SELECT",
      });
    }
    expect(contract.policies.filter((entry) => entry.table === "casework_deadlines").map((entry) => [entry.name, entry.cmd]).sort())
      // 20261028210000 merged casework_deadlines_read and _staff_read into one
      // permissive SELECT policy (the OR of both).
      .toEqual([["casework_deadlines_select", "r"]]);
    expect(contract.policies.filter((entry) => entry.table === "casework_alerts").map((entry) => [entry.name, entry.cmd]))
      .toEqual([["casework_alerts_read", "r"]]);
    expect(clientApi).toContain('client.rpc("casework_create_deadline"');
    expect(clientApi).toContain('client.rpc("casework_create_alert"');
    expect(clientApi).not.toContain('client.from("casework_deadlines").insert(');
    expect(clientApi).not.toContain('client.from("casework_alerts").insert(');
  });
});

const ID = {
  org: "50902209-0000-4000-8000-000000000001",
  steward: "50902209-0000-4000-8000-000000000101",
  member: "50902209-0000-4000-8000-000000000102",
  outsider: "50902209-0000-4000-8000-000000000103",
  stewardSession: "50902209-0000-4000-8000-000000000201",
  outsiderSession: "50902209-0000-4000-8000-000000000202",
  case: "50902209-0000-4000-8000-000000000301",
  procedureCase: "50902209-0000-4000-8000-000000000302",
  procedure: "50902209-0000-4000-8000-000000000401",
  admin: "50902209-0000-4000-8000-000000000104",
  adminSession: "50902209-0000-4000-8000-000000000203",
};
const CHAPTER = "deadline-alert-audit-proof";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework deadline and alert creation audit on a disposable database", () => {
  let db;

  async function as(user, session, statement, values = []) {
    await db.query("savepoint creation_audit");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: user,
        role: "authenticated",
        session_id: session,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint creation_audit");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint creation_audit");
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }
  const asSteward = (statement, values) => as(ID.steward, ID.stewardSession, statement, values);
  const asOutsider = (statement, values) => as(ID.outsider, ID.outsiderSession, statement, values);
  const asAdmin = (statement, values) => as(ID.admin, ID.adminSession, statement, values);
  const auditRows = async (entityId) => (await db.query(
    "select event_type,entity_type,metadata from public.casework_audit_events where entity_id=$1 order by id",
    [entityId],
  )).rows;

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-deadline-alert-creation-audit-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      `insert into auth.users(id,email) values
         ($1,'creation-audit-steward@example.invalid'),
         ($2,'creation-audit-member@example.invalid'),
         ($3,'creation-audit-outsider@example.invalid'),
         ($4,'creation-audit-admin@example.invalid')`,
      [ID.steward, ID.member, ID.outsider, ID.admin],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'creation-audit-org','Creation audit proof',$2)",
      [ID.org, ID.steward],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,2209)",
      [CHAPTER, ID.org],
    );
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ID.org]);
    for (const userId of [ID.steward, ID.member, ID.outsider, ID.admin]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.steward],
    );
    // The outsider carries an aal2 session and a verified factor, so a refusal
    // it receives is the case-access predicate and never the MFA gate.
    // The admin authors and applies the macro (macro authorship is admin-only).
    for (const role of ["admin", "coordinator"]) {
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ID.org, ID.admin, role]);
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [ID.admin, role, CHAPTER]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [ID.admin, role, CHAPTER]);
    }
    for (const [userId, sessionId] of [[ID.steward, ID.stewardSession], [ID.outsider, ID.outsiderSession], [ID.admin, ID.adminSession]]) {
      await db.query(
        "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",
        [sessionId, userId],
      );
      await db.query(
        `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
         values(gen_random_uuid(),$1,'creation-audit-totp','totp','verified',now(),now())`,
        [userId],
      );
    }
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id)
       values($1,$2,'CREATION-AUDIT','Creation audit proof case','other','Intake','active',$3)`,
      [ID.case, ID.member, ID.steward],
    );
    // A second case on an organization procedure whose next step carries a
    // three-calendar-day deadline rule, so casework_advance_step inserts the
    // procedure deadline.
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id)
       values($1,$2,'CREATION-AUDIT-P','Creation audit procedure case','creation-audit-procedure','intake','active',$3)`,
      [ID.procedureCase, ID.member, ID.steward],
    );
    await db.query(
      "insert into public.casework_procedures(id,organization_id,case_type,name,created_by) values($1,$2,'creation-audit-procedure','Creation audit procedure',$3)",
      [ID.procedure, ID.org, ID.admin],
    );
    await db.query(
      `insert into public.casework_procedure_steps(procedure_id,organization_id,position,key,label,deadline_rule,terminal) values
         ($1,$2,0,'intake','Intake','{"kind":"none","count":0,"from":"step_entry"}',false),
         ($1,$2,1,'review','Review response due','{"kind":"calendar_days","count":3,"from":"step_entry"}',false),
         ($1,$2,2,'finish','Finish','{"kind":"none","count":0,"from":"step_entry"}',true)`,
      [ID.procedure, ID.org],
    );

    // #8589 re-final: committed data gives every steward grant its migration

    // assignments; an organization grant reaches only chapters it has one in.

    await migrateLegacyStewardFixtures(db);
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("keeps both creation routines SECURITY DEFINER, postgres-owned and authenticated-only", async () => {
    const signatures = [
      "public.casework_create_deadline(uuid,text,text,timestamp with time zone,timestamp with time zone)",
      "public.casework_create_alert(uuid,text,text,text,timestamp with time zone)",
    ];
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature,p.prosecdef,r.rolname owner,
              has_function_privilege('authenticated',p.oid,'EXECUTE') staff,
              has_function_privilege('anon',p.oid,'EXECUTE') anonymous
       from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner
       where p.oid=any($1::regprocedure[]) order by 1`,
      [signatures],
    )).rows;
    expect(rows).toHaveLength(signatures.length);
    expect(rows.every((row) => row.prosecdef && row.owner === "postgres" && row.staff && !row.anonymous)).toBe(true);
  });

  it("denies the direct authenticated INSERT that skipped the audit row", async () => {
    const privileges = (await db.query(`
      select table_name,
        has_table_privilege('authenticated', 'public.' || table_name, 'INSERT') allowed
      from unnest(array['casework_alerts', 'casework_deadlines']::text[]) table_name
      order by table_name
    `)).rows;
    expect(privileges).toEqual([
      { table_name: "casework_alerts", allowed: false },
      { table_name: "casework_deadlines", allowed: false },
    ]);
    const deadline = await asSteward(
      `insert into public.casework_deadlines(id,case_id,organization_id,chapter_id,kind,label,due_at,created_by)
       values($1,$2,$3,$4,'filing','Unaudited filing deadline',now()+interval '3 days',$5)`,
      [randomUUID(), ID.case, ID.org, CHAPTER, ID.steward],
    );
    expect(deadline.code, deadline.message).toBe("42501");
    expect(deadline.message).toBe("permission denied for table casework_deadlines");
    const alert = await asSteward(
      `insert into public.casework_alerts(id,case_id,organization_id,chapter_id,kind,severity,message,created_by)
       values($1,$2,$3,$4,'deadline','warning','Unaudited alert',$5)`,
      [randomUUID(), ID.case, ID.org, CHAPTER, ID.steward],
    );
    expect(alert.code, alert.message).toBe("42501");
    expect(alert.message).toBe("permission denied for table casework_alerts");
    expect((await db.query("select count(*)::int n from public.casework_deadlines where case_id=$1", [ID.case])).rows)
      .toEqual([{ n: 0 }]);
    expect((await db.query("select count(*)::int n from public.casework_alerts where case_id=$1", [ID.case])).rows)
      .toEqual([{ n: 0 }]);
  });

  it("creates the deadline and exactly one deadline_created row through the RPC", async () => {
    const created = await asSteward(
      `select id,kind,label,created_by,reminder_at
       from public.casework_create_deadline($1,'filing','  File the Step 1 response  ',now()+interval '5 days',null)`,
      [ID.case],
    );
    expect(created, created.message).toMatchObject({ code: "" });
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]).toMatchObject({
      kind: "filing",
      label: "File the Step 1 response",
      created_by: ID.steward,
      reminder_at: null,
    });
    const rows = await auditRows(created.rows[0].id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: "deadline_created", entity_type: "deadline" });
    expect(Object.keys(rows[0].metadata).sort()).toEqual(["dueAt", "kind", "reminderSet"]);
    expect(rows[0].metadata).toMatchObject({ kind: "filing", reminderSet: false });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("Step 1 response");
    expect((await db.query(
      "select case_id,actor_user_id from public.casework_audit_events where entity_id=$1",
      [created.rows[0].id],
    )).rows).toEqual([{ case_id: ID.case, actor_user_id: ID.steward }]);
  });

  it("creates the alert and exactly one alert_created row through the RPC", async () => {
    const created = await asSteward(
      `select id,kind,severity,message,created_by
       from public.casework_create_alert($1,'safety','critical','  Escort the member to the meeting  ',now()+interval '1 day')`,
      [ID.case],
    );
    expect(created, created.message).toMatchObject({ code: "" });
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]).toMatchObject({
      kind: "safety",
      severity: "critical",
      message: "Escort the member to the meeting",
      created_by: ID.steward,
    });
    const rows = await auditRows(created.rows[0].id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: "alert_created", entity_type: "alert" });
    expect(Object.keys(rows[0].metadata).sort()).toEqual(["escalationSet", "kind", "severity"]);
    expect(rows[0].metadata).toMatchObject({ kind: "safety", severity: "critical", escalationSet: true });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("Escort the member");
  });

  it("writes exactly one deadline_created row for the deadline a procedure step advance creates", async () => {
    const advanced = await asSteward(
      "select id from public.casework_advance_step($1,'intake','review','Moved to review',$2)",
      [ID.procedureCase, randomUUID()],
    );
    expect(advanced, advanced.message).toMatchObject({ code: "" });
    const deadlines = (await db.query(
      "select id,kind,label,created_by from public.casework_deadlines where case_id=$1", [ID.procedureCase],
    )).rows;
    expect(deadlines).toEqual([expect.objectContaining({ kind: "procedure", label: "Review response due", created_by: ID.steward })]);
    const rows = (await db.query(
      "select event_type,entity_type,actor_user_id,organization_id,chapter_id,case_id,metadata from public.casework_audit_events where entity_id=$1",
      [deadlines[0].id],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: "deadline_created",
      entity_type: "deadline",
      actor_user_id: ID.steward,
      organization_id: ID.org,
      chapter_id: CHAPTER,
      case_id: ID.procedureCase,
    });
    expect(Object.keys(rows[0].metadata).sort()).toEqual(["dueAt", "kind", "reminderSet"]);
    expect(rows[0].metadata).toMatchObject({ kind: "procedure", reminderSet: false });
    // The step transition keeps its own single step_advanced row.
    expect((await db.query(
      "select count(*)::int n from public.casework_audit_events where case_id=$1 and event_type='step_advanced'", [ID.procedureCase],
    )).rows).toEqual([{ n: 1 }]);
  });

  it("keeps the macro route at exactly one alert_created row per alert", async () => {
    const macro = await asAdmin(
      "select public.casework_save_macro(null,null,'Creation audit alert',$1::jsonb,true) value",
      [JSON.stringify([{ kind: "add_alert", alertKind: "deadline", severity: "warning", message: "Macro flagged the clock." }])],
    );
    expect(macro, macro.message).toMatchObject({ code: "" });
    const applied = await asAdmin(
      "select public.casework_apply_macro($1,$2::uuid[],$3) value",
      [macro.rows[0].value.id, [ID.case], randomUUID()],
    );
    expect(applied, applied.message).toMatchObject({ code: "" });
    const alerts = (await db.query(
      "select id from public.casework_alerts where case_id=$1 and message='Macro flagged the clock.'", [ID.case],
    )).rows;
    expect(alerts).toHaveLength(1);
    const rows = (await db.query(
      "select event_type,actor_user_id from public.casework_audit_events where entity_id=$1 and event_type='alert_created'", [alerts[0].id],
    )).rows;
    expect(rows).toEqual([{ event_type: "alert_created", actor_user_id: ID.admin }]);
  });

  it("gives every escalated alert a creation event before its alert_escalated event", async () => {
    await db.query("update public.casework_alerts set escalation_due_at = now() - interval '1 minute' where case_id=$1", [ID.case]);
    expect((await db.query("select private.casework_escalate_due_alerts(1000) n")).rows[0].n).toBeGreaterThan(0);
    const escalated = (await db.query(
      `select e.entity_id,
              (select min(c.id) from public.casework_audit_events c
                where c.entity_id = e.entity_id and c.event_type = 'alert_created') created_id,
              e.id escalated_id
       from public.casework_audit_events e
       where e.case_id=$1 and e.event_type='alert_escalated'`,
      [ID.case],
    )).rows;
    expect(escalated.length).toBeGreaterThan(0);
    for (const row of escalated) {
      expect(row.created_id, `alert ${row.entity_id} has no alert_created event`).not.toBeNull();
      expect(BigInt(row.created_id) < BigInt(row.escalated_id)).toBe(true);
    }
  });

  it("refuses a case the caller is no staff on and leaves no row behind", async () => {
    const before = (await db.query(
      "select count(*)::int n from public.casework_audit_events where case_id=$1", [ID.case],
    )).rows[0].n;
    const deadline = await asOutsider(
      "select id from public.casework_create_deadline($1,'filing','Outsider deadline',now()+interval '2 days',null)",
      [ID.case],
    );
    expect(deadline.code, deadline.message).toBe("P0002");
    expect(deadline.message).toBe("case not found");
    const alert = await asOutsider(
      "select id from public.casework_create_alert($1,'deadline','info','Outsider alert',null)",
      [ID.case],
    );
    expect(alert.code, alert.message).toBe("P0002");
    expect(alert.message).toBe("case not found");
    expect((await db.query("select count(*)::int n from public.casework_deadlines where case_id=$1", [ID.case])).rows)
      .toEqual([{ n: 1 }]);
    // The RPC-created alert and the macro-created alert.
    expect((await db.query("select count(*)::int n from public.casework_alerts where case_id=$1", [ID.case])).rows)
      .toEqual([{ n: 2 }]);
    expect((await db.query(
      "select count(*)::int n from public.casework_audit_events where case_id=$1", [ID.case],
    )).rows).toEqual([{ n: before }]);
  });
});
