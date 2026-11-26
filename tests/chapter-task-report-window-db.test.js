// @vitest-environment node
//
// BUG-UG-TASKS-REPORT-WINDOW-DROPS-UNDATED-AND-LATE-FINISHERS-20260920
//
// Text pins can show the repaired predicate. Only a live apply proves that an
// undated task, a late finisher due before the window, and a completion after
// p_to each land in the installed RPC's totals and byMonth the way the report
// names the window.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migration = readFileSync(
  new URL("../supabase/migrations/20260922013000_chapter_task_report_window_repair.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("chapter_task_report window repair (static)", () => {
  it("shares the completion bound and keeps the due-date disjunction", () => {
    expect(migration).toContain(
      "and (t.done_at is null or t.done_at::date between range_from and range_to)",
    );
    expect(migration).toContain(
      "and (t.due_date is null or t.done_at::date between range_from and range_to or t.due_date >= range_from)",
    );
    expect(migration).not.toMatch(/t\.done_at is null or t\.done_at::date >= range_from/);
    const entry = contract.functions.find(
      (item) => item.sig === "public.chapter_task_report(p_from date, p_to date)",
    );
    // #8563 moved the same predicates onto the Eastern day.
    expect(entry.bodyContains).toContain(
      "(t.done_at is null or private.eastern_day(t.done_at) between range_from and range_to)",
    );
    expect(entry.bodyContains).toContain(
      "(t.due_date is null or private.eastern_day(t.done_at) between range_from and range_to or t.due_date >= range_from)",
    );
  });
});

const ID = {
  org: "50902114-0000-4000-8000-000000000001",
  staff: "50902114-0000-4000-8000-000000000101",
  session: "50902114-0000-4000-8000-000000000201",
  undatedOpen: "50902114-0000-4000-8000-000000000301",
  undatedDone: "50902114-0000-4000-8000-000000000302",
  lateFinisher: "50902114-0000-4000-8000-000000000303",
  afterEndDated: "50902114-0000-4000-8000-000000000304",
  afterEndUndated: "50902114-0000-4000-8000-000000000305",
};
const CHAPTER = "task-report-window";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter_task_report window repair on a disposable database", () => {
  let db;

  async function asStaff(statement, values = []) {
    await db.query("savepoint task_report_window");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID.staff,
        role: "authenticated",
        session_id: ID.session,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint task_report_window");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint task_report_window");
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapter-task-report-window-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      "insert into auth.users(id,email) values($1,'task-report-staff@example.invalid')",
      [ID.staff],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'task-report-window-org','Task report window',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9921)",
      [CHAPTER, ID.org],
    );
    await db.query(
      "insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)",
      [ID.org],
    );
    await db.query(
      "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
      [ID.staff, CHAPTER],
    );
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ID.staff, CHAPTER]);
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",
      [ID.session, ID.staff],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values(gen_random_uuid(),$1,'task-report-totp','totp','verified',now(),now())`,
      [ID.staff],
    );
    await db.query(
      "insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)",
      [CHAPTER, ID.staff],
    );
    await db.query("set local session_replication_role = replica");
    await db.query(
      `insert into public.chapter_tasks
         (id, chapter_id, task_number, title, status, workstream, start_date, due_date, done_at, created_at, created_by, updated_by, deleted_at)
       values
         ($1,$6,1,'Undated open','to_do','General','2026-05-01',null,null,'2026-05-01 12:00:00+00',$7,$7,null),
         ($2,$6,2,'Undated done','done','General','2026-05-01',null,'2026-05-15 12:00:00+00','2026-05-01 12:00:00+00',$7,$7,null),
         ($3,$6,3,'Late finisher','done','General','2026-02-01','2026-03-01','2026-05-20 12:00:00+00','2026-02-01 12:00:00+00',$7,$7,null),
         ($4,$6,4,'Dated after end','done','General','2026-06-01','2026-06-15','2026-07-10 12:00:00+00','2026-06-01 12:00:00+00',$7,$7,null),
         ($5,$6,5,'Undated after end','done','General','2026-06-01',null,'2026-07-10 12:00:00+00','2026-06-01 12:00:00+00',$7,$7,null)`,
      [
        ID.undatedOpen,
        ID.undatedDone,
        ID.lateFinisher,
        ID.afterEndDated,
        ID.afterEndUndated,
        CHAPTER,
        ID.staff,
      ],
    );
    await db.query("set local session_replication_role = origin");
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("counts undated work and in-window late finishers, and refuses completions after the named end", async () => {
    const report = await asStaff(
      "select public.chapter_task_report($1::date, $2::date) as value",
      ["2026-04-01", "2026-06-30"],
    );
    expect(report.code).toBe("");
    const value = report.rows[0].value;
    expect(value.from).toBe("2026-04-01");
    expect(value.to).toBe("2026-06-30");
    expect(Number(value.totals.total)).toBe(3);
    expect(Number(value.totals.done)).toBe(2);
    expect(Number(value.totals.open)).toBe(1);
    expect(value.byMonth.map((row) => row.month)).toEqual(["2026-05"]);
    expect(Number(value.byMonth[0].done)).toBe(2);
  });
});
