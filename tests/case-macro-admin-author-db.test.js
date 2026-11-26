// @vitest-environment node
//
// BUG-UG-CASEWORK-MACRO-ACTIONS-REJECT-ADMIN-AUTHORS-20260921
//
// Only an organization admin/VP may author an organization-wide macro, and
// casework_apply_macro admits them, but its add_note and assign delegates ask
// for a narrower hat. Against a disposable database this proves that an
// admin-only or VP-only author's add_note or assign macro is refused before any
// write with one 42501 naming the coordinator role (never part-way through the
// batch), that their macros of the other kinds still run, and that a
// coordinator's macro still goes through the delegates.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// One organization and chapter: an admin and a VP with no coordinator grant, a
// coordinator, a steward (an assign target) and two cases owned by a member.
async function seed(client) {
  const ids = Object.fromEntries([
    "org", "admin", "vp", "coordinator", "steward", "member",
    "adminSession", "vpSession", "coordinatorSession", "stewardSession", "memberSession",
    "caseOne", "caseTwo",
  ].map((key) => [key, randomUUID()]));
  ids.chapter = `macro-author-${ids.org}`;
  const people = [
    [ids.admin, ids.adminSession, ["admin"]],
    [ids.vp, ids.vpSession, ["vp"]],
    [ids.coordinator, ids.coordinatorSession, ["coordinator"]],
    [ids.steward, ids.stewardSession, ["steward"]],
    [ids.member, ids.memberSession, []],
  ];
  for (const [user, session] of people) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic macro factor','totp','verified',now(),now())", [randomUUID(), user]);
  }
  await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `macro-author-${ids.org}`, ids.admin]);
  await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9900)", [ids.chapter, ids.org]);
  await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids.org]);
  for (const [user, , roles] of people) {
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids.chapter]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, ids.chapter, `Macro Author ${user.slice(0, 8)}`]);
    for (const role of roles) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids.org, user, role]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids.chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids.chapter]);
    }
  }
  for (const caseId of [ids.caseOne, ids.caseTwo]) {
    await client.query(
      "insert into public.member_cases(id,user_id,reference,title,case_type,step,status) values($1,$2,$3,'Synthetic macro case','other','Intake','active')",
      [caseId, ids.member, `AUTHOR-${caseId.slice(0, 8)}`]);
  }
  return ids;
}

async function withFixture(run) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  await client.query("begin");
  try {
    const ids = await seed(client);
    const sessions = {
      [ids.admin]: ids.adminSession,
      [ids.vp]: ids.vpSession,
      [ids.coordinator]: ids.coordinatorSession,
      [ids.steward]: ids.stewardSession,
      [ids.member]: ids.memberSession,
    };
    const as = async (user, role = "authenticated") => {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({ role, sub: user, session_id: sessions[user], aal: "aal2" })]);
      await client.query(`set local role ${role}`);
    };
    let savepoint = 0;
    const refused = async (statement, params) => {
      const label = `macro_author_${++savepoint}`;
      await client.query(`savepoint ${label}`);
      let caught;
      try { await client.query(statement, params); } catch (error) { caught = error; }
      finally { await client.query(`rollback to savepoint ${label}`); await client.query(`release savepoint ${label}`); }
      expect(caught, "statement should have been refused").toBeDefined();
      return caught;
    };
    const count = async (sql, params) => {
      await as(ids.admin, "postgres");
      return (await client.query(sql, params)).rows[0].n;
    };
    await run(client, ids, { as, refused, count });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

const NOTE_MACRO = JSON.stringify([
  { kind: "add_note", body: "Macro recorded the intake call." },
  { kind: "add_alert", alertKind: "deadline", severity: "warning", message: "Macro flagged the intake clock." },
]);

const OTHER_MACRO = JSON.stringify([
  { kind: "add_alert", alertKind: "deadline", severity: "warning", message: "Macro flagged the intake clock." },
  { kind: "set_status", status: "resolved" },
]);

const apply = "select public.casework_apply_macro($1,$2::uuid[],$3) value";
const save = "select public.casework_save_macro(null,null,$1,$2::jsonb,true) value";

live("casework macros applied by organization admin/VP authors (disposable database)", () => {
  for (const author of ["admin", "vp"]) {
    it(`refuses a ${author}-only author's note macro before any write and runs their other macros`, async () => {
      await withFixture(async (client, ids, { as, refused, count }) => {
        const cases = [ids.caseOne, ids.caseTwo];
        await as(ids[author]);
        const noteMacro = (await client.query(save, [`Intake packet ${author}`, NOTE_MACRO])).rows[0].value;
        expect(noteMacro).toMatchObject({ chapterId: null, active: true });

        // One honest refusal naming the role, not 'coordinator role required'
        // after the first case's alert was already written.
        const error = await refused(apply, [noteMacro.id, cases, randomUUID()]);
        expect(error.code).toBe("42501");
        expect(error.message).toBe("adding case notes requires the coordinator role");
        expect(await count("select count(*)::int n from public.casework_audit_events where case_id = any($1::uuid[])", [cases])).toBe(0);
        expect(await count("select count(*)::int n from public.casework_alerts where case_id = any($1::uuid[])", [cases])).toBe(0);
        expect(await count("select count(*)::int n from public.member_case_updates where case_id = any($1::uuid[])", [cases])).toBe(0);

        // The note stays on its coordinator-gated writer; the macro opens no
        // second path to it.
        await as(ids[author]);
        const direct = await refused("select public.coordinator_add_case_note($1,'Direct note')", [ids.caseOne]);
        expect(direct.code).toBe("42501");

        // The kinds the apply gate already admits them for still run.
        const otherMacro = (await client.query(save, [`Flag and close ${author}`, OTHER_MACRO])).rows[0].value;
        const result = (await client.query(apply, [otherMacro.id, cases, randomUUID()])).rows[0].value;
        expect(result).toMatchObject({ caseCount: 2, actionsApplied: 4, actionsSkipped: 0 });
        expect(await count("select count(*)::int n from public.casework_alerts where case_id = any($1::uuid[])", [cases])).toBe(2);
        expect(await count("select count(*)::int n from public.member_cases where id = any($1::uuid[]) and status='resolved'", [cases])).toBe(2);
      });
    }, 60_000);
  }

  it("refuses an admin/VP author's assign macro before any write, and still assigns for a coordinator", async () => {
    await withFixture(async (client, ids, { as, refused, count }) => {
      const cases = [ids.caseOne, ids.caseTwo];
      const assignMacro = JSON.stringify([
        { kind: "add_alert", alertKind: "custom", severity: "info", message: "Macro flagged the handover." },
        { kind: "assign", stewardId: ids.steward, coordinatorId: null },
      ]);
      await as(ids.admin);
      const macro = (await client.query(save, ["Handover", assignMacro])).rows[0].value;
      // assign_member_case scopes its caller with staff_can_see_user(...,
      // 'coordinator'), so neither hat can assign a case anywhere. The refusal
      // comes first, not after the first case's alert was written.
      for (const author of ["admin", "vp"]) {
        await as(ids[author]);
        const error = await refused(apply, [macro.id, cases, randomUUID()]);
        expect(error.code).toBe("42501");
        expect(error.message).toBe("assigning cases requires the coordinator role");
        expect(await count("select count(*)::int n from public.casework_audit_events where case_id = any($1::uuid[])", [cases])).toBe(0);
        expect(await count("select count(*)::int n from public.casework_alerts where case_id = any($1::uuid[])", [cases])).toBe(0);
      }

      await as(ids.coordinator);
      const result = (await client.query(apply, [macro.id, cases, randomUUID()])).rows[0].value;
      expect(result).toMatchObject({ caseCount: 2, actionsApplied: 4 });
      expect(await count("select count(*)::int n from public.member_cases where id = any($1::uuid[]) and steward_user_id=$2", [cases, ids.steward])).toBe(2);
    });
  }, 60_000);

  it("keeps the coordinator delegate for a coordinator applying the same macro", async () => {
    await withFixture(async (client, ids, { as, count }) => {
      await as(ids.admin);
      const macro = (await client.query(save, ["Intake packet", NOTE_MACRO])).rows[0].value;
      await as(ids.coordinator);
      const result = (await client.query(apply, [macro.id, [ids.caseOne], randomUUID()])).rows[0].value;
      expect(result).toMatchObject({ caseCount: 1, actionsApplied: 2 });
      expect(await count("select count(*)::int n from public.member_case_updates where case_id=$1 and author_user_id=$2", [ids.caseOne, ids.coordinator])).toBe(1);
      expect(await count("select count(*)::int n from public.coordinator_case_audit where case_id=$1 and action='note_added' and actor_id=$2", [ids.caseOne, ids.coordinator])).toBe(1);
    });
  }, 60_000);
});
