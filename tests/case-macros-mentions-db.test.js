// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_CASE_MACRO_DB_TESTS === "1" ? it : it.skip;

// One fixture serves all three proofs: two organizations, a chapter each, a
// coordinating admin and a steward in the first, an admin in the second, and
// two cases owned by a member of the first chapter.
async function seed(client) {
  const ids = Object.fromEntries([
    "orgA", "orgB", "admin", "steward", "member", "outsider",
    "adminSession", "stewardSession", "memberSession", "outsiderSession",
    "caseOne", "caseTwo",
  ].map((key) => [key, randomUUID()]));
  ids.chapterA = `macro-proof-a-${ids.orgA}`;
  ids.chapterB = `macro-proof-b-${ids.orgB}`;

  for (const [org, chapter, people] of [
    [ids.orgA, ids.chapterA, [[ids.admin, ids.adminSession, ["admin", "coordinator"]], [ids.steward, ids.stewardSession, ["steward"]], [ids.member, ids.memberSession, []]]],
    [ids.orgB, ids.chapterB, [[ids.outsider, ids.outsiderSession, ["admin", "coordinator"]]]],
  ]) {
    const [firstUser] = people[0];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic macro factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `macro-proof-${org}`, firstUser]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9900)", [chapter, org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
    for (const [user, , roles] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, `Macro Proof ${user.slice(0, 8)}`]);
      for (const role of roles) {
        await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [org, user, role]);
        await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
        await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
      }
    }
  }
  // The steward is assignable, so it is also a legitimate mention target.
  await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing", [ids.steward, ids.chapterA]);
  for (const caseId of [ids.caseOne, ids.caseTwo]) {
    await client.query(
      "insert into public.member_cases(id,user_id,reference,title,case_type,step,status) values($1,$2,$3,'Synthetic macro case','other','Intake','active')",
      [caseId, ids.member, `MACRO-${caseId.slice(0, 8)}`]);
  }
  return ids;
}

function actorHelpers(client, ids) {
  const sessions = {
    [ids.admin]: ids.adminSession,
    [ids.steward]: ids.stewardSession,
    [ids.member]: ids.memberSession,
    [ids.outsider]: ids.outsiderSession,
  };
  const as = async (user, role = "authenticated") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ role, sub: user, session_id: sessions[user], aal: "aal2" })]);
    await client.query(`set local role ${role}`);
  };
  let savepoint = 0;
  const refused = async (statement, params, expected) => {
    const label = `macro_refused_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    let caught;
    try { await client.query(statement, params); } catch (error) { caught = error; }
    finally { await client.query(`rollback to savepoint ${label}`); await client.query(`release savepoint ${label}`); }
    expect(caught?.code, caught?.message).toBe(expected);
    return caught.message;
  };
  return { as, refused };
}

async function withFixture(run) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  await client.query("begin");
  try {
    const ids = await seed(client);
    await run(client, ids, actorHelpers(client, ids));
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

const MACRO_ACTIONS = JSON.stringify([
  { kind: "advance_step", step: "Step 1", outcome: "Filed at step one by macro" },
  { kind: "add_note", body: "Macro filed this case at step one." },
  { kind: "add_alert", alertKind: "deadline", severity: "warning", message: "Macro flagged the step-one clock." },
]);

databaseIt("scopes macro authorship to admins and macro reads to the owning organization", async () => {
  await withFixture(async (client, ids, { as, refused }) => {
    await as(ids.admin);
    const saved = (await client.query(
      "select public.casework_save_macro(null,null,'Step one packet',$1::jsonb,true) value", [MACRO_ACTIONS])).rows[0].value;
    expect(saved).toMatchObject({ name: "Step one packet", chapterId: null, active: true });

    // A macro whose action list does not match the shape is refused by the
    // routine, not by a constraint the client can never see.
    await refused("select public.casework_save_macro(null,null,'Bad',$1::jsonb,true)",
      [JSON.stringify([{ kind: "advance_step", step: "S", outcome: "x" }])], "22023");
    await refused("select public.casework_save_macro(null,null,'Bad',$1::jsonb,true)",
      [JSON.stringify([{ kind: "teleport" }])], "22023");

    // A steward of the same organization reads it and cannot write one.
    await as(ids.steward);
    expect((await client.query("select count(*)::int n from public.casework_macros")).rows[0].n).toBe(1);
    await refused("select public.casework_save_macro(null,null,'Steward macro',$1::jsonb,true)", [MACRO_ACTIONS], "42501");

    // The second organization's admin sees nothing and cannot apply it.
    // Inaccessible and missing macros share the same refusal (#9243).
    await as(ids.outsider);
    expect((await client.query("select count(*)::int n from public.casework_macros")).rows[0].n).toBe(0);
    await refused("select public.casework_apply_macro($1,$2::uuid[],$3)",
      [saved.id, [ids.caseOne], randomUUID()], "P0002");

    // The member is not staff at all.
    await as(ids.member);
    expect((await client.query("select count(*)::int n from public.casework_macros")).rows[0].n).toBe(0);
    await refused("insert into public.casework_macros(organization_id,chapter_id,name,actions,active,created_by) values($1,null,'Member macro',$2::jsonb,true,$3)",
      [ids.orgA, MACRO_ACTIONS, ids.member], "42501");
  });
});

databaseIt("applies every macro action through its own audited routine, once per batch key", async () => {
  await withFixture(async (client, ids, { as }) => {
    await as(ids.admin);
    const macro = (await client.query(
      "select public.casework_save_macro(null,null,'Step one packet',$1::jsonb,true) value", [MACRO_ACTIONS])).rows[0].value;
    const batch = randomUUID();
    const cases = [ids.caseOne, ids.caseTwo];

    const first = (await client.query("select public.casework_apply_macro($1,$2::uuid[],$3) value", [macro.id, cases, batch])).rows[0].value;
    expect(first).toMatchObject({ caseCount: 2, actionsApplied: 6, actionsSkipped: 0 });

    await as(ids.admin, "postgres");
    // One audit row per action per case, and the evidence each routine writes.
    expect((await client.query("select count(*)::int n from public.casework_audit_events where event_type='macro_applied' and case_id = any($1::uuid[])", [cases])).rows[0].n).toBe(6);
    expect((await client.query("select count(*)::int n from public.casework_step_transitions where case_id = any($1::uuid[])", [cases])).rows[0].n).toBe(2);
    expect((await client.query("select count(*)::int n from public.member_case_updates where case_id = any($1::uuid[])", [cases])).rows[0].n).toBe(2);
    expect((await client.query("select count(*)::int n from public.casework_alerts where case_id = any($1::uuid[])", [cases])).rows[0].n).toBe(2);
    // The step really moved, and it moved through casework_advance_step.
    expect((await client.query("select distinct step from public.member_cases where id = any($1::uuid[])", [cases])).rows.map((row) => row.step)).toEqual(["Step 1"]);
    const kinds = (await client.query("select metadata->>'kind' kind, count(*)::int n from public.casework_audit_events where event_type='macro_applied' and case_id = any($1::uuid[]) group by 1 order by 1", [cases])).rows;
    expect(kinds).toEqual([{ kind: "add_alert", n: 2 }, { kind: "add_note", n: 2 }, { kind: "advance_step", n: 2 }]);

    // A retried batch is the same batch: no second note, no second alert.
    await as(ids.admin);
    const replay = (await client.query("select public.casework_apply_macro($1,$2::uuid[],$3) value", [macro.id, cases, batch])).rows[0].value;
    expect(replay).toMatchObject({ actionsApplied: 0, actionsSkipped: 6 });
    await as(ids.admin, "postgres");
    expect((await client.query("select count(*)::int n from public.casework_audit_events where event_type='macro_applied' and case_id = any($1::uuid[])", [cases])).rows[0].n).toBe(6);
    expect((await client.query("select count(*)::int n from public.member_case_updates where case_id = any($1::uuid[])", [cases])).rows[0].n).toBe(2);
    expect((await client.query("select count(*)::int n from public.casework_alerts where case_id = any($1::uuid[])", [cases])).rows[0].n).toBe(2);
  });
});

databaseIt("keeps an organization's macros when the authoring administrator deletes their account", async () => {
  await withFixture(async (client, ids, { as }) => {
    await as(ids.admin);
    const macro = (await client.query(
      "select public.casework_save_macro(null,null,'Step one packet',$1::jsonb,true) value", [MACRO_ACTIONS])).rows[0].value;

    await as(ids.admin, "postgres");
    // The reviewed disposition and the installed referential action are the
    // same fact stated twice: ON DELETE SET NULL ('n'), reviewed as
    // 'pseudonymize' in the account-lifecycle manifest, and carried in the
    // bidirectional ownership inventory. A RESTRICT action here would block
    // account deletion outright (BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831),
    // and CASCADE would take the organization's macro library with the author.
    expect((await client.query(
      "select confdeltype from pg_catalog.pg_constraint where conname='casework_macros_created_by_fkey'")).rows[0].confdeltype).toBe("n");
    expect((await client.query(`select delete_disposition, export_disposition, export_inventory_basis
      from private.account_lifecycle_manifest
      where schema_name='public' and table_name='casework_macros' and user_column='created_by'`)).rows[0])
      .toEqual({ delete_disposition: "pseudonymize", export_disposition: "excluded_with_reason", export_inventory_basis: "auth_user_fk" });
    expect((await client.query("select count(*)::int n from private.account_lifecycle_unmanaged_restrictive_fks()")).rows[0].n).toBe(0);
    // Both case-graph gates this migration installs are reviewed as well. That
    // surface sweep is a whole-catalogue walk that takes tens of seconds, so it
    // stays where it already runs: the zero-issue assertion in
    // tests/auth-bookkeeping-lock-scope-db.test.js, and the DO block this
    // migration executes before it commits.
    expect((await client.query(`select count(*)::int n from private.account_lifecycle_trigger_review
      where kind='trigger' and schema_name='public' and table_name='casework_macros'`)).rows[0].n).toBe(2);
    expect((await client.query("select created_by from public.casework_macros where id=$1", [macro.id])).rows[0].created_by).toBe(ids.admin);

    // The organization keeps an administrator: deleting its last one is
    // refused by an unrelated guard, and this proof is about the macro's
    // attribution, not that guard.
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
      [ids.orgA, ids.steward]);
    await client.query("delete from auth.users where id=$1", [ids.admin]);

    const surviving = (await client.query(
      "select organization_id, name, active, created_by from public.casework_macros where id=$1", [macro.id])).rows;
    expect(surviving).toHaveLength(1);
    expect(surviving[0]).toMatchObject({ organization_id: ids.orgA, name: "Step one packet", active: true, created_by: null });
    // The macro is still readable by the organization's remaining staff: the
    // deletion pseudonymized the attribution, it did not retire the row.
    expect((await client.query(
      "select count(*)::int n from public.casework_macros where organization_id=$1 and active", [ids.orgA])).rows[0].n).toBe(1);
  });
}, 60_000);

databaseIt("binds case-note mentions to the case chapter, notifies them, and refuses a member-stamped list", async () => {
  await withFixture(async (client, ids, { as, refused }) => {
    await as(ids.admin);
    const candidates = (await client.query("select public.list_case_note_mention_candidates($1) value", [ids.caseOne])).rows[0].value;
    expect(candidates.map((person) => person.userId)).toContain(ids.steward);
    expect(candidates.map((person) => person.userId)).not.toContain(ids.outsider);

    const note = (await client.query("select public.casework_add_case_note($1,$2,$3::uuid[]) value",
      [ids.caseOne, "Handing this to @Macro Proof for the step-one packet.", [ids.steward]])).rows[0].value;
    expect(note.mentionedUserIds).toEqual([ids.steward]);

    // Somebody outside the case's chapter is not a mention target.
    await refused("select public.casework_add_case_note($1,$2,$3::uuid[])",
      [ids.caseOne, "Pulling in an outsider.", [ids.outsider]], "23514");

    await as(ids.admin, "postgres");
    expect((await client.query("select mentioned_user_ids from public.member_case_updates where id=$1", [note.id])).rows[0].mentioned_user_ids).toEqual([ids.steward]);
    // Scoped to the casework kind: seeding an authenticator leaves the
    // steward a security notice of its own.
    const notified = (await client.query("select title, body, kind from public.member_notifications where user_id=$1 and kind='cases'", [ids.steward])).rows;
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toContain("mentioned you");
    // Shoulder test: the lock screen names the author, never the case.
    expect(notified[0].title + notified[0].body).not.toMatch(/MACRO-|Synthetic macro case/);
    expect((await client.query("select count(*)::int n from public.casework_audit_events where case_id=$1 and event_type='note_mentioned'", [ids.caseOne])).rows[0].n).toBe(1);

    // The timeline RPC is the desk's only read path, so the chip lives or
    // dies here. It is security invoker: the coordinator's own profile reach
    // names the steward, and the member -- who can read the same note -- gets
    // an empty array and sees the body exactly as the coordinator typed it.
    await as(ids.admin);
    const staffTimeline = (await client.query(
      "select id, mentions from public.list_case_latest_updates($1::uuid[], 20)", [[ids.caseOne]])).rows;
    const staffRow = staffTimeline.find((row) => row.id === note.id);
    expect(staffRow.mentions).toEqual([{ userId: ids.steward, fullName: `Macro Proof ${ids.steward.slice(0, 8)}` }]);

    // The member owns the case and may still write a note -- but not a mention.
    await as(ids.member);
    const memberTimeline = (await client.query(
      "select id, body, mentions from public.list_case_latest_updates($1::uuid[], 20)", [[ids.caseOne]])).rows;
    const memberRow = memberTimeline.find((row) => row.id === note.id);
    expect(memberRow.body).toContain("@Macro Proof");
    expect(memberRow.mentions).toEqual([]);

    // The member's own note goes through add_my_case_update since 20261104075000.
    await client.query("select public.add_my_case_update($1, 'Member note')", [ids.caseOne]);
    await refused("insert into public.member_case_updates(case_id,user_id,body,mentioned_user_ids) values($1,$2,'Member mention',$3::uuid[])",
      [ids.caseOne, ids.member, [ids.steward]], "42501");
  });
});
