// @vitest-environment node
//
// SEC-UG-APPOINTMENT-MUTATION-AUTHORIZATION-EVALUATES-THE-CALLER-CHAPTER-INSTEAD-OF-THE-APPOINTMENT-CHAPTER-20260921
//
// Cancel, reschedule and outcome must authorize the steward arm against the
// appointment's chapter, not the caller's selected chapter.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseGraphWrappedSource, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260925030000_appointment_authorization_consolidation";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const originalSql = loadMigrationSql("20260801120000_steward_appointments");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const CHAPTER_PREDICATE = "private.member_has_chapter_role(appt.chapter_id, array['steward'])";
const CALLER_CHAPTER_PREDICATE = "public.member_has_role(array['steward'])";

const SIGNATURES = [
  {
    name: "public.cancel_appointment",
    sig: "public.cancel_appointment(p_id uuid)",
    predecessor: "6e55d3c81b3e386ba78fd88e236dcac1cf1f75f73e47449d5cf9ebce67d7115f",
    live: "048c985837bf45ec6495955399f857f29c14d311372cf91604880df4eb1acac4",
  },
  {
    name: "public.reschedule_appointment",
    sig: "public.reschedule_appointment(p_id uuid, p_starts_at timestamp with time zone)",
    predecessor: "3e0719424e7425d5c18cfb94d04d3164d999b3116f996bfa532701befeccae31",
    live: "c8a7502db198a3eded8b5d8afb06326f49303bb0208f68a4ce37964918153acb",
  },
  {
    name: "public.mark_appointment_outcome",
    sig: "public.mark_appointment_outcome(p_id uuid, p_outcome text)",
    predecessor: "6bab40787bc945f8f82abb7d0b72711240bc3df9b9f342d5d4e1876ca64453e2",
    live: "eebd538cafcd12fdd17cf68dc2e6c9de8233925ce70f8fed1e7c64318bdc5674",
  },
];

function replacedBody(source, file) {
  const functions = parseFunctions(source, file);
  return (name) => {
    const fn = functions.find((entry) => entry.name === name);
    expect(fn, `${name} must be declared in ${file}`).toBeTruthy();
    return fn;
  };
}

describe("steward appointment tenant role matrix", () => {
  it("runs as one forward-only transaction after the wrapped original bodies", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260907151000_account_deletion_finalization_reconciliation").toBe(true);
    // The only ACL statements re-state the existing supervision and helper
    // grants unchanged; none touches the three mutation writers.
    const acl = code.match(/^\s*(grant|revoke)\b[^;]*;/gim) ?? [];
    expect(acl.map((line) => line.trim())).toEqual([
      "revoke all on function private.appointment_stewards_for_chapter(text) from public, anon, authenticated;",
      "revoke all on function public.list_chapter_appointment_reassignment_candidates(uuid) from public, anon;",
      "grant execute on function public.list_chapter_appointment_reassignment_candidates(uuid) to authenticated, service_role;",
      "revoke all on function public.reassign_chapter_appointment(uuid, uuid) from public, anon;",
      "grant execute on function public.reassign_chapter_appointment(uuid, uuid) to authenticated, service_role;",
    ]);
    expect(code).not.toMatch(/\b(create|alter|drop)\s+(table|policy|index|trigger)\b/i);
  });

  it("admits only the reviewed 20260907151000-wrapped 20260801120000 bodies as predecessors", () => {
    const original = replacedBody(originalSql, "20260801120000.sql");
    for (const entry of SIGNATURES) {
      expect(sql).toContain(`if digest is distinct from '${entry.predecessor}' then`);
      const wrapped = caseGraphWrappedSource(original(entry.name).source);
      expect(createHash("sha256").update(wrapped).digest("hex")).toBe(entry.predecessor);
      expect(stripComments(original(entry.name).source)).toContain(CALLER_CHAPTER_PREDICATE);
    }
  });

  it("keeps the installation lock wrapper as the first statement of each replaced body", () => {
    const latest = replacedBody(sql, `${NAME}.sql`);
    for (const entry of SIGNATURES) {
      expect(latest(entry.name).source).toMatch(
        /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
      );
    }
  });

  it("binds cancel, reschedule, and outcome to the appointment chapter rather than the caller chapter", () => {
    const latest = replacedBody(sql, `${NAME}.sql`);
    for (const entry of SIGNATURES) {
      const source = stripComments(latest(entry.name).source);
      expect(source).toContain(CHAPTER_PREDICATE);
      expect(source).not.toContain(CALLER_CHAPTER_PREDICATE);
      expect(source).toContain("private.mfa_satisfied()");
      expect(fnBody(sql, entry.name)).toContain("for update");
    }
    const cancel = stripComments(latest("public.cancel_appointment").source);
    const reschedule = stripComments(latest("public.reschedule_appointment").source);
    expect(cancel).toContain("if caller <> appt.user_id and not private.member_has_chapter_role(appt.chapter_id, array['steward']) then");
    expect(reschedule).toContain("if caller <> appt.user_id and not private.member_has_chapter_role(appt.chapter_id, array['steward']) then");
    expect(cancel).toContain("caller = appt.user_id");
    expect(reschedule).toContain("caller = appt.user_id");
  });

  it("pins the steward arm to appt.chapter_id and never the selected-chapter helper", () => {
    const latest = replacedBody(sql, `${NAME}.sql`);
    for (const entry of SIGNATURES) {
      const source = stripComments(latest(entry.name).source);
      expect(source).not.toMatch(/private\.current_member_chapter\s*\(/);
      expect(source).not.toContain(CALLER_CHAPTER_PREDICATE);
      expect(source).toContain("appt.chapter_id");
      expect(source).toMatch(
        /private\.member_has_chapter_role\(\s*appt\.chapter_id\s*,\s*array\['steward'\]\s*\)/,
      );
    }
  });

  it("re-derives the live source digest from each replaced body and pins it", () => {
    const latest = replacedBody(sql, `${NAME}.sql`);
    for (const entry of SIGNATURES) {
      const fn = latest(entry.name);
      expect(createHash("sha256").update(fn.source).digest("hex")).toBe(fn.sourceSha256);
      expect(fn.sourceSha256).toBe(entry.live);
      expect(sql).toContain(`if digest is distinct from '${entry.live}' then`);
    }
  });

  it("pins the appointment-chapter predicate on each db-contract signature", () => {
    for (const entry of SIGNATURES) {
      const contracted = contract.functions.find((candidate) => candidate.sig === entry.sig);
      expect(contracted, `${entry.sig} must be contracted`).toBeDefined();
      expect(contracted.bodyContains).toContain(CHAPTER_PREDICATE);
      expect(contracted.bodyContains).not.toContain(CALLER_CHAPTER_PREDICATE);
      expect(contracted.bodyForbids).toContain("public.member_has_role(");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("appointment mutation tenant-role matrix on disposable PostgreSQL", () => {
  let client;
  const id = Object.fromEntries(
    ["member", "steward", "memberSession", "stewardSession", "org", "cancel", "reschedule", "outcome"].map(
      (key) => [key, randomUUID()],
    ),
  );
  const chapterA = `amch-a-${id.org}`;
  const chapterB = `amch-b-${id.org}`;
  let replacementStart;

  const asSteward = async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({
        role: "authenticated",
        sub: id.steward,
        session_id: id.stewardSession,
        aal: "aal2",
      }),
    ]);
    await client.query("set local role authenticated");
  };

  const invoke = async (sqlText, params = []) => {
    await client.query("savepoint appt_matrix");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint appt_matrix");
      return { ok: true, value: result.rows[0]?.value ?? result.rows[0] };
    } catch (error) {
      await client.query("rollback to savepoint appt_matrix");
      await client.query("release savepoint appt_matrix");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const withRestore = async (fn) => {
    await client.query("savepoint restore_matrix");
    try {
      await fn();
    } finally {
      await client.query("rollback to savepoint restore_matrix");
      await client.query("release savepoint restore_matrix");
      await asSteward();
    }
  };

  const cancelSql = "select public.cancel_appointment($1) value";
  const rescheduleSql = "select public.reschedule_appointment($1,$2) value";
  const outcomeSql = "select public.mark_appointment_outcome($1,'completed') value";

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "appointment-mutation-chapter-auth-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    for (const [user, session] of [[id.member, id.memberSession], [id.steward, id.stewardSession]]) {
      await client.query(
        "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",
        [user, `${user}@example.invalid`],
      );
      await client.query(
        "insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",
        [session, user],
      );
      await client.query(
        "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic appointment-chapter factor','totp','verified',now(),now())",
        [randomUUID(), user],
      );
    }

    await client.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)",
      [id.org, `amch-${id.org}`, `Appointment chapter ${id.org}`, id.steward],
    );
    await client.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$2,$1,$3,false,9931),($4,$5,$4,$3,false,9932)",
      [chapterA, `Appointment chapter A ${id.org}`, id.org, chapterB, `Appointment chapter B ${id.org}`],
    );
    await client.query(
      "insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)",
      [id.org],
    );

    for (const user of [id.member, id.steward]) {
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
        [id.org, user],
      );
      for (const chapter of [chapterA, chapterB]) {
        await client.query(
          "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
          [user, chapter],
        );
      }
    }
    await client.query(
      "update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1",
      [id.member, chapterA, "Appointment member"],
    );
    await client.query(
      "update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1",
      [id.steward, chapterB, "Appointment steward"],
    );

    await client.query(
      "insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1)",
      [id.steward, chapterB],
    );
    await client.query(
      "insert into public.member_role_chapters(user_id,role,chapter_id,granted_by) values($1,'steward',$2,$1),($1,'steward',$3,$1)",
      [id.steward, chapterA, chapterB],
    );

    await client.query(
      `insert into public.member_appointment_schedules
         (steward_id, timezone, min_notice_minutes, buffer_before_minutes, buffer_after_minutes, max_per_day, accepting)
       values ($1, 'America/New_York', 0, 0, 0, 24, true)`,
      [id.steward],
    );
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await client.query(
        "insert into public.member_appointment_windows(steward_id, weekday, start_minute, end_minute) values($1,$2,0,1440)",
        [id.steward, weekday],
      );
    }

    const future = async (days) => {
      const row = await client.query("select now() + ($1::int * interval '1 day') as starts", [days]);
      return row.rows[0].starts;
    };
    const cancelStart = await future(20);
    const rescheduleStart = await future(21);
    const outcomeStart = (await client.query("select now() - interval '2 hours' as starts")).rows[0].starts;

    for (const [appointmentId, startsAt] of [
      [id.cancel, cancelStart],
      [id.reschedule, rescheduleStart],
      [id.outcome, outcomeStart],
    ]) {
      await client.query(
        `insert into public.member_appointments(
           id, user_id, steward_id, chapter_id, appointment_type, duration_minutes,
           starts_at, ends_at, status, routed_via, reason_category)
         values ($1,$2,$3,$4,'office_hours',30,$5::timestamptz,$5::timestamptz + interval '30 minutes','confirmed','steward','general')`,
        [appointmentId, id.member, id.steward, chapterA, startsAt],
      );
    }

    replacementStart = (await client.query(
      `select slot_start
         from private.appointment_slots_for($1, 30, (now() at time zone 'UTC')::date, (now() at time zone 'UTC')::date + 4)
        where slot_start > now() + interval '1 hour'
        order by slot_start
        limit 1`,
      [id.steward],
    )).rows[0]?.slot_start;
    expect(replacementStart, "slot engine must offer a replacement instant").toBeTruthy();
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("authorizes cancel, reschedule, and outcome on the appointment chapter, then denies all three after that grant is revoked", async () => {
    await asSteward();
    const selected = (await client.query(
      "select chapter_id from public.member_profiles where id = $1",
      [id.steward],
    )).rows[0].chapter_id;
    expect(selected).toBe(chapterB);

    await withRestore(async () => {
      const granted = await invoke(cancelSql, [id.cancel]);
      expect(granted).toMatchObject({ ok: true, value: { id: id.cancel, status: "cancelled" } });
    });
    await withRestore(async () => {
      const rescheduled = await invoke(rescheduleSql, [id.reschedule, replacementStart]);
      expect(rescheduled.ok, rescheduled.message).toBe(true);
      expect(rescheduled.value).toMatchObject({
        status: "confirmed",
        rescheduledFrom: id.reschedule,
      });
    });
    await withRestore(async () => {
      const completed = await invoke(outcomeSql, [id.outcome]);
      expect(completed).toMatchObject({ ok: true, value: { id: id.outcome, status: "completed" } });
    });

    await client.query("reset role");
    await client.query(
      "delete from public.member_role_chapters where user_id = $1 and role = 'steward' and chapter_id = $2",
      [id.steward, chapterA],
    );
    const remaining = (await client.query(
      "select chapter_id from public.member_role_chapters where user_id = $1 and role = 'steward' order by chapter_id",
      [id.steward],
    )).rows.map((row) => row.chapter_id);
    expect(remaining).toEqual([chapterB]);

    await asSteward();
    const cancelledDenied = await invoke(cancelSql, [id.cancel]);
    expect(cancelledDenied).toMatchObject({ ok: false, code: "22023" });
    expect(cancelledDenied.message).toMatch(/appointment unavailable/i);

    const rescheduleDenied = await invoke(rescheduleSql, [id.reschedule, replacementStart]);
    expect(rescheduleDenied).toMatchObject({ ok: false, code: "22023" });
    expect(rescheduleDenied.message).toMatch(/appointment unavailable/i);

    const outcomeDenied = await invoke(outcomeSql, [id.outcome]);
    expect(outcomeDenied).toMatchObject({ ok: false, code: "42501" });
    expect(outcomeDenied.message).toMatch(/steward role required/i);
  });
});
