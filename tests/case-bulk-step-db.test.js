// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_CASE_BULK_STEP_DB_TESTS === "1" ? it : it.skip;
const noDeadline = { kind: "none", count: 0, from: "step_entry" };

async function seed(db) {
  const ids = Object.fromEntries([
    "org", "staff", "member", "session", "factor",
    "one", "two", "three", "invalid", "stale", "peerOne", "peerTwo", "denied",
  ].map((key) => [key, randomUUID()]));
  ids.chapter = `bulk-step-${ids.org}`;

  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'bulk-step-staff@example.invalid','{}'),($2,'bulk-step-member@example.invalid','{}')", [ids.staff, ids.member]);
  await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,'Bulk step proof',$3)", [ids.org, `bulk-step-${ids.org}`, ids.staff]);
  await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,'Bulk step chapter',$1,$2,false,9900)", [ids.chapter, ids.org]);
  await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active'),($1,$3,'active')", [ids.org, ids.staff, ids.member]);
  await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$3,'active'),($2,$3,'active')", [ids.staff, ids.member, ids.chapter]);
  await db.query("update public.member_profiles set chapter_id=$2 where id=any($1::uuid[])", [[ids.staff, ids.member], ids.chapter]);
  await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [ids.staff, ids.chapter]);
  await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)", [ids.staff, ids.chapter]);
  await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [ids.org, ids.staff]);
  await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids.org]);
  await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids.session, ids.staff]);
  await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Bulk step factor','totp','verified',now(),now())", [ids.factor, ids.staff]);

  for (const key of ["one", "two", "three", "invalid", "stale", "peerOne", "peerTwo", "denied"]) {
    await db.query(
      "insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,steward_user_id,created_at,is_restricted,restriction_reason,restricted_at,restricted_by) values($1,$2,$3,$4,$5,'Bulk transition proof','Grievance','intake','active',$6,'2026-09-17 14:00+00',$7,$8,case when $7 then now() else null end,case when $7 then $9::uuid else null end)",
      [ids[key], ids.member, ids.org, ids.chapter, `BULK-${key}`, key === "denied" ? null : ids.staff, key === "denied", key === "denied" ? "Restricted proof case" : null, ids.staff],
    );
  }

  await asStaff(db, ids);
  await db.query("select public.casework_save_procedure(null,null,'Grievance','Bulk procedure',$1::jsonb,null)", [JSON.stringify([
    { key: "intake", label: "Intake", deadline_rule: noDeadline },
    { key: "review", label: "Review due", deadline_rule: { kind: "calendar_days", count: 2, from: "filing" } },
    { key: "finish", label: "Finish", deadline_rule: noDeadline, terminal: true },
  ])]);
  return ids;
}

async function asStaff(db, ids) {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: ids.staff, session_id: ids.session, aal: "aal2" })]);
  await db.query("set local role authenticated");
}

async function refuse(db, statement, values, expectedCode) {
  const savepoint = `bulk_refusal_${randomUUID().replaceAll("-", "")}`;
  await db.query(`savepoint ${savepoint}`);
  let caught;
  try { await db.query(statement, values); } catch (error) { caught = error; }
  finally {
    await db.query(`rollback to savepoint ${savepoint}`);
    await db.query(`release savepoint ${savepoint}`);
  }
  expect(caught?.code, caught?.message).toBe(expectedCode);
  return caught;
}

databaseIt("advances a bulk selection through one audited procedure transition per accessible case", async () => {
  const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "lane56-bulk-step-proof" });
  await db.connect();
  await db.query("begin");
  try {
    const ids = await seed(db);
    const firstBatch = [ids.one, ids.two, ids.three];
    for (const caseId of firstBatch) {
      await db.query("select public.casework_advance_step($1,'intake','review','Bulk review completed',$2)", [caseId, randomUUID()]);
    }

    await db.query("reset role");
    expect((await db.query("select count(*)::int n from public.casework_step_transitions where case_id=any($1::uuid[])", [firstBatch])).rows[0].n).toBe(3);
    expect((await db.query("select count(*)::int n from public.casework_audit_events where case_id=any($1::uuid[]) and event_type='step_advanced'", [firstBatch])).rows[0].n).toBe(3);
    const deadlines = (await db.query("select case_id,label,due_at from public.casework_deadlines where case_id=any($1::uuid[]) and kind='procedure' order by case_id", [firstBatch])).rows;
    expect(deadlines).toHaveLength(3);
    expect(deadlines.every((row) => row.label === "Review due" && row.due_at.toISOString() === "2026-09-20T03:59:59.000Z")).toBe(true);

    await asStaff(db, ids);
    await refuse(db, "select public.casework_advance_step($1,'intake','finish','Invalid skip',$2)", [ids.invalid, randomUUID()], "22023");
    await refuse(db, "select public.casework_advance_step($1,'review','finish','Stale expected step',$2)", [ids.stale, randomUUID()], "PT409");
    await db.query("reset role");
    expect((await db.query("select id,step from public.member_cases where id=any($1::uuid[]) order by id", [[ids.invalid, ids.stale]])).rows.map((row) => row.step)).toEqual(["intake", "intake"]);

    // The client loop continues after a per-case refusal. One restricted case
    // is deliberately not assigned to this coordinator; its P0002 is retained
    // while both accessible peers still advance.
    await asStaff(db, ids);
    const accessBatch = [ids.peerOne, ids.denied, ids.peerTwo];
    const outcomes = [];
    for (const [index, caseId] of accessBatch.entries()) {
      const savepoint = `access_case_${index}`;
      await db.query(`savepoint ${savepoint}`);
      try {
        await db.query("select public.casework_advance_step($1,'intake','review','Access-scoped bulk review',$2)", [caseId, randomUUID()]);
        await db.query(`release savepoint ${savepoint}`);
        outcomes.push({ caseId, advanced: true });
      } catch (error) {
        await db.query(`rollback to savepoint ${savepoint}`);
        await db.query(`release savepoint ${savepoint}`);
        outcomes.push({ caseId, advanced: false, code: error.code, message: error.message });
      }
    }
    expect(outcomes).toEqual([
      { caseId: ids.peerOne, advanced: true },
      expect.objectContaining({ caseId: ids.denied, advanced: false, code: "P0002" }),
      { caseId: ids.peerTwo, advanced: true },
    ]);
    await db.query("reset role");
    const steps = new Map((await db.query("select id,step from public.member_cases where id=any($1::uuid[])", [accessBatch])).rows.map((row) => [row.id, row.step]));
    expect(steps.get(ids.peerOne)).toBe("review");
    expect(steps.get(ids.peerTwo)).toBe("review");
    expect(steps.get(ids.denied)).toBe("intake");
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}, 30000);
