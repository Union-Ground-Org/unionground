// @vitest-environment node
//
// SEC-UG-CASEWORK-REMINDERS-UNAUDITED-MUTATION-20260919
//
// Reading stays direct. UPDATE/DELETE are denied and the definer status RPC
// remains the only status mutation, including its audit row. Since
// REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 (20261104123000)
// creation is the journalled create_my_case_reminder RPC: direct INSERT is
// revoked too.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const migration = readFileSync(
  new URL("../supabase/migrations/20260920011000_casework_reminders_rpc_only_status.sql", import.meta.url),
  "utf8",
);
const journalled = readFileSync(
  new URL("../supabase/migrations/20261104123000_learning_period_case_workflow.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("casework reminder RPC-only status changes (static)", () => {
  it("pins SELECT only and replaces the FOR ALL policy", () => {
    expect(migration).toContain("revoke update, delete on public.casework_reminders from authenticated");
    expect(migration).toContain("drop policy if exists casework_reminders_owner on public.casework_reminders");
    expect(migration).toContain("create policy casework_reminders_owner_read on public.casework_reminders");
    expect(migration).toContain("for select to authenticated");
    expect(migration).toContain("create policy casework_reminders_owner_create on public.casework_reminders");
    expect(migration).toContain("for insert to authenticated");
    expect(migration).toContain("and status = 'scheduled'");
    expect(migration).toContain("and completed_at is null");
    expect(migration).toContain("and last_fired_at is null");
    expect(journalled).toContain("drop policy if exists casework_reminders_owner_create on public.casework_reminders;");
    expect(journalled).toContain("revoke insert on public.casework_reminders from authenticated;");
    expect(contract.tableGrants).toContainEqual({
      table: "public.casework_reminders",
      role: "authenticated",
      privileges: "SELECT",
    });
    expect(contract.policies.filter((entry) => entry.table === "casework_reminders").map((entry) => [entry.name, entry.cmd]).sort())
      .toEqual([
        ["casework_reminders_owner_read", "r"],
      ]);
  });
});

const ID = {
  org: "50901913-0000-4000-8000-000000000001",
  owner: "50901913-0000-4000-8000-000000000101",
  member: "50901913-0000-4000-8000-000000000102",
  session: "50901913-0000-4000-8000-000000000201",
  case: "50901913-0000-4000-8000-000000000301",
  reminder: "50901913-0000-4000-8000-000000000401",
};
const CHAPTER = "reminder-dualwrite-proof";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("casework reminder RPC-only status changes on a disposable database", () => {
  let db;

  async function asOwner(statement, values = []) {
    await db.query("savepoint reminder_direct_dml");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID.owner,
        role: "authenticated",
        session_id: ID.session,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint reminder_direct_dml");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint reminder_direct_dml");
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "casework-reminders-direct-dml-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      "insert into auth.users(id,email) values($1,'reminder-owner@example.invalid'),($2,'reminder-member@example.invalid')",
      [ID.owner, ID.member],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'reminder-proof-org','Reminder proof',$2)",
      [ID.org, ID.owner],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9913)",
      [CHAPTER, ID.org],
    );
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ID.org]);
    for (const userId of [ID.owner, ID.member]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.owner],
    );
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",
      [ID.session, ID.owner],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values(gen_random_uuid(),$1,'reminder-totp','totp','verified',now(),now())`,
      [ID.owner],
    );
    await db.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id)
       values($1,$2,'REMINDER-PROOF','Reminder proof case','other','Intake','active',$3)`,
      [ID.case, ID.member, ID.owner],
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

  it("keeps every explicit reminder writer SECURITY DEFINER and postgres-owned", async () => {
    const signatures = [
      "public.casework_set_reminder_status(uuid,text,timestamp with time zone)",
    ];
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature,p.prosecdef,r.rolname owner
       from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner
       where p.oid=any($1::regprocedure[]) order by 1`,
      [signatures],
    )).rows;
    expect(rows).toHaveLength(signatures.length);
    expect(rows.every((row) => row.prosecdef && row.owner === "postgres")).toBe(true);
    const retired = await db.query(`select to_regprocedure('private.demo_seed_apply_casework(text,uuid)') as apply,
      to_regprocedure('private.demo_seed_remove_casework(text,uuid)') as remove`);
    expect(retired.rows).toEqual([{ apply: null, remove: null }]);
  });

  it("refuses direct INSERTs, whatever lifecycle status they begin in", async () => {
    const attempts = [];
    for (const status of ["scheduled", "completed", "dismissed", "snoozed"]) {
      attempts.push([status, await asOwner(
        `insert into public.casework_reminders(
           id,case_id,organization_id,chapter_id,owner_user_id,title,remind_at,recurrence,status
         ) values($1,$2,$3,$4,$5,$6,now()+interval '1 day','none',$7) returning id`,
        [randomUUID(), ID.case, ID.org, CHAPTER, ID.owner, `Invalid ${status} reminder`, status],
      )]);
    }
    for (const [status, attempt] of attempts) {
      expect(attempt.code, `${status}: ${attempt.message}`).toBe("42501");
      expect(attempt.message).toBe("permission denied for table casework_reminders");
    }
  });

  it("refuses direct INSERTs that pre-populate lifecycle timestamps", async () => {
    const attempts = [];
    for (const column of ["completed_at", "last_fired_at"]) {
      attempts.push([column, await asOwner(
        `insert into public.casework_reminders(
           id,case_id,organization_id,chapter_id,owner_user_id,title,remind_at,recurrence,status,${column}
         ) values($1,$2,$3,$4,$5,$6,now()+interval '1 day','none','scheduled',now()) returning id`,
        [randomUUID(), ID.case, ID.org, CHAPTER, ID.owner, `Invalid ${column} reminder`],
      )]);
    }
    for (const [column, attempt] of attempts) {
      expect(attempt.code, `${column}: ${attempt.message}`).toBe("42501");
      expect(attempt.message).toBe("permission denied for table casework_reminders");
    }
  });

  it("creates through create_my_case_reminder and keeps SELECT for the reminder owner", async () => {
    const inserted = await asOwner(
      `select r.id,r.status,r.title,r.completed_at,r.last_fired_at,r.owner_user_id
       from public.create_my_case_reminder($1,'Call the member',now()+interval '1 day','none') r`,
      [ID.case],
    );
    expect(inserted, inserted.message).toMatchObject({ code: "" });
    ID.reminder = inserted.rows[0].id;
    expect(inserted.rows).toEqual([{
      id: ID.reminder,
      owner_user_id: ID.owner,
      status: "scheduled",
      title: "Call the member",
      completed_at: null,
      last_fired_at: null,
    }]);
    const selected = await asOwner(
      "select id,status,title,completed_at,last_fired_at,owner_user_id from public.casework_reminders where id=$1",
      [ID.reminder],
    );
    expect(selected.rows).toEqual(inserted.rows);
  });

  it("denies direct authenticated INSERT, UPDATE and DELETE with 42501", async () => {
    const privileges = (await db.query(`
      select operation,
        has_table_privilege('authenticated', 'public.casework_reminders', operation) allowed
      from unnest(array['INSERT', 'UPDATE', 'DELETE']::text[]) operation
      order by operation
    `)).rows;
    expect(privileges).toEqual([
      { operation: "DELETE", allowed: false },
      { operation: "INSERT", allowed: false },
      { operation: "UPDATE", allowed: false },
    ]);
    const update = await asOwner("update public.casework_reminders set status='completed' where id=$1", [ID.reminder]);
    expect(update.code, update.message).toBe("42501");
    expect(update.message).toBe("permission denied for table casework_reminders");
    const deletion = await asOwner("delete from public.casework_reminders where id=$1", [ID.reminder]);
    expect(deletion.code, deletion.message).toBe("42501");
    expect(deletion.message).toBe("permission denied for table casework_reminders");
    expect((await db.query("select status from public.casework_reminders where id=$1", [ID.reminder])).rows)
      .toEqual([{ status: "scheduled" }]);
  });

  it("updates through casework_set_reminder_status and appends reminder_changed", async () => {
    const changed = await asOwner(
      "select (public.casework_set_reminder_status($1,'completed',null)).status status",
      [ID.reminder],
    );
    expect(changed, changed.message).toMatchObject({ code: "" });
    expect(changed.rows).toEqual([{ status: "completed" }]);
    const row = await db.query("select status,completed_at is not null completed from public.casework_reminders where id=$1", [ID.reminder]);
    expect(row.rows).toEqual([{ status: "completed", completed: true }]);
    const audit = await db.query(
      "select event_type,entity_type,entity_id,metadata from public.casework_audit_events where entity_id=$1 and event_type='reminder_changed'",
      [ID.reminder],
    );
    expect(audit.rows).toEqual([{
      event_type: "reminder_changed",
      entity_type: "reminder",
      entity_id: ID.reminder,
      metadata: { status: "completed" },
    }]);
  });
});
