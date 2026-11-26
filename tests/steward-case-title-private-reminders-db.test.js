// @vitest-environment node
//
// REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006.
//
// 20261009000500_steward_case_title_and_private_reminders adds
// public.casework_rename_case and the steward's private reminders (owner
// answer 11=A). Only a live apply shows who may rename a case, that each real
// rename leaves one closed-vocabulary audit row, and that a private reminder is
// read, attached and deleted by its own steward and nobody else.
//
// Everything runs inside one transaction that is rolled back, so the shared
// disposable catalogue keeps none of these fixtures.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("steward case title and private reminders", () => {
  let client;
  let ids;

  const as = async (user) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ role: "authenticated", sub: user, session_id: ids.sessions[user], aal: "aal2" })]);
    await client.query("set local role authenticated");
  };

  const refused = async (statement, params, expected) => {
    await client.query("savepoint probe");
    let caught;
    try { await client.query(statement, params); } catch (error) { caught = error; }
    finally { await client.query("rollback to savepoint probe"); await client.query("release savepoint probe"); }
    expect(caught?.code, caught?.message).toBe(expected);
  };

  const rename = (caseId, title, reason = "clearer_title") =>
    client.query("select public.casework_rename_case($1,$2,$3) value", [caseId, title, reason]);
  const list = async () => (await client.query("select public.steward_list_private_reminders() value")).rows[0].value;
  const save = async (title, remindOn, caseId = null) =>
    (await client.query("select public.steward_save_private_reminder($1,$2::date,$3) value", [title, remindOn, caseId])).rows[0].value;

  const asOwner = async (statement, params = []) => {
    await client.query("reset role");
    const result = await client.query(statement, params);
    return result.rows;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "steward-case-title-private-reminders-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    ids = Object.fromEntries([
      "orgA", "orgB", "steward", "otherSteward", "coordinator", "member", "outsider",
      "caseOne", "caseTwo", "caseOther",
    ].map((key) => [key, randomUUID()]));
    ids.chapterA = `title-proof-a-${ids.orgA}`;
    ids.chapterB = `title-proof-b-${ids.orgB}`;
    ids.sessions = {};

    for (const [org, chapter, people] of [
      [ids.orgA, ids.chapterA, [[ids.coordinator, ["admin", "coordinator"]], [ids.steward, ["steward"]], [ids.otherSteward, ["steward"]], [ids.member, []]]],
      [ids.orgB, ids.chapterB, [[ids.outsider, ["admin", "coordinator", "steward"]]]],
    ]) {
      const [firstUser] = people[0];
      for (const [user] of people) {
        ids.sessions[user] = randomUUID();
        await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
        await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids.sessions[user], user]);
        await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic title factor','totp','verified',now(),now())", [randomUUID(), user]);
      }
      await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `title-proof-${org}`, firstUser]);
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9902)", [chapter, org]);
      await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
      for (const [user, roles] of people) {
        await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
        await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
        await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, `Title Proof ${user.slice(0, 8)}`]);
        for (const role of roles) {
          await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [org, user, role]);
          await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
          await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
        }
      }
    }
    // caseOne is assigned to the steward; caseTwo to nobody; caseOther lives in
    // the second organization.
    await client.query(
      "insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id) values($1,$2,$3,'On March 3 my supervisor told me that','other','Intake','active',$4)",
      [ids.caseOne, ids.member, `TITLEREF-${ids.caseOne.slice(0, 8)}`, ids.steward]);
    await client.query(
      "insert into public.member_cases(id,user_id,reference,title,case_type,step,status) values($1,$2,$3,'Unassigned case','other','Intake','active')",
      [ids.caseTwo, ids.member, `TITLEREF-${ids.caseTwo.slice(0, 8)}`]);
    await client.query(
      "insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id) values($1,$2,$3,'Other organization case','other','Intake','active',$2)",
      [ids.caseOther, ids.outsider, `TITLEREF-${ids.caseOther.slice(0, 8)}`]);
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  });

  it("lets the assigned steward rename a case with one closed-vocabulary audit row per real change", async () => {
    await as(ids.steward);
    const { rows: [{ value }] } = await rename(ids.caseOne, "  Lift #4 overtime denial  ", "member_request");
    expect(value).toEqual({ caseId: ids.caseOne, title: "Lift #4 overtime denial", changed: true });
    expect((await rename(ids.caseOne, "Lift #4 overtime denial")).rows[0].value.changed).toBe(false);
    const audits = await asOwner(
      "select actor_user_id, event_type, entity_type, entity_id, organization_id, metadata from public.casework_audit_events where case_id=$1 and event_type='case_renamed'",
      [ids.caseOne]);
    expect(audits).toEqual([{
      actor_user_id: ids.steward, event_type: "case_renamed", entity_type: "case", entity_id: ids.caseOne,
      organization_id: ids.orgA,
      metadata: { reason: "member_request", titleLength: 23, previousTitleLength: 37 },
    }]);
    expect((await asOwner("select title from public.member_cases where id=$1", [ids.caseOne]))[0].title).toBe("Lift #4 overtime denial");
  });

  it("refuses bad titles and reasons, and every caller who cannot work the case", async () => {
    await as(ids.steward);
    await refused("select public.casework_rename_case($1,$2,'other')", [ids.caseOne, "   "], "22023");
    await refused("select public.casework_rename_case($1,$2,'other')", [ids.caseOne, "x".repeat(201)], "22023");
    await refused("select public.casework_rename_case($1,'Fine title',$2)", [ids.caseOne, "because I said so"], "22023");
    await refused("select public.casework_rename_case($1,'Fine title','other')", [ids.caseTwo], "P0002");
    await refused("select public.casework_rename_case($1,'Fine title','other')", [ids.caseOther], "P0002");
    for (const user of [ids.otherSteward, ids.member, ids.outsider]) {
      await as(user);
      await refused("select public.casework_rename_case($1,'Fine title','other')", [ids.caseOne], "P0002");
    }
    // The coordinator-admin of the organization can work the case and rename it.
    await as(ids.coordinator);
    expect((await rename(ids.caseOne, "x".repeat(200))).rows[0].value.changed).toBe(true);
  });

  it("keeps a private reminder before a case exists and shows it to its steward only", async () => {
    await as(ids.steward);
    expect(await list()).toEqual([]);
    const saved = await save("  Grievance filing window closes ", "2026-10-16");
    expect(saved).toEqual([expect.objectContaining({ title: "Grievance filing window closes", remindOn: "2026-10-16", caseId: null, caseReference: null })]);
    const reminderId = saved[0].id;
    for (const user of [ids.otherSteward, ids.coordinator, ids.outsider]) {
      await as(user);
      expect(await list()).toEqual([]);
      await refused("select public.steward_attach_private_reminder($1,null)", [reminderId], "P0002");
      await refused("select public.steward_delete_private_reminder($1)", [reminderId], "P0002");
    }
    await as(ids.member);
    await refused("select public.steward_list_private_reminders()", [], "42501");
    await refused("select public.steward_save_private_reminder('Note','2026-10-16'::date,null)", [], "42501");
    // No client grant on the table itself.
    await refused("select * from private.steward_private_reminders", [], "42501");
    await as(ids.steward);
    await refused("select * from private.steward_private_reminders", [], "42501");
    await refused("select public.steward_save_private_reminder('','2026-10-16'::date,null)", [], "22023");
    await refused("select public.steward_save_private_reminder('Note',null,null)", [], "22023");
  });

  it("rejects non-finite and unsupported dates without persisting them, and accepts both bounds", async () => {
    await as(ids.steward);
    const before = await list();
    for (const date of ["10000-01-01", "infinity", "-infinity", "0001-12-31 BC"]) {
      await refused("select public.steward_save_private_reminder('Invalid date',$1::date,null)", [date], "22023");
      expect(await list()).toEqual(before);
    }
    for (const date of ["0001-01-01", "9999-12-31"]) {
      const saved = await save("Boundary date", date);
      const row = saved.find(item => item.title === "Boundary date");
      expect(row.remindOn).toBe(date);
      await client.query("select public.steward_delete_private_reminder($1)", [row.id]);
    }
    expect(await list()).toEqual(before);
  });

  it("attaches only to a case its steward can work in the same organization", async () => {
    await as(ids.steward);
    const [{ id }] = await list();
    await refused("select public.steward_attach_private_reminder($1,$2)", [id, ids.caseTwo], "P0002");
    await refused("select public.steward_attach_private_reminder($1,$2)", [id, ids.caseOther], "P0002");
    const attached = (await client.query("select public.steward_attach_private_reminder($1,$2) value", [id, ids.caseOne])).rows[0].value;
    expect(attached).toEqual([expect.objectContaining({ id, caseId: ids.caseOne, caseReference: `TITLEREF-${ids.caseOne.slice(0, 8)}` })]);
    await refused("select public.steward_save_private_reminder('Other case','2026-10-20'::date,$1)", [ids.caseOther], "P0002");
    // Attaching shares nothing: the coordinator who can work the same case still sees no reminder.
    await as(ids.coordinator);
    expect(await list()).toEqual([]);
    // The export carries the reminder to its steward only.
    const exported = await asOwner("select private.account_lifecycle_export_additional_domains($1) value", [ids.steward]);
    expect(exported[0].value.steward_private_reminders).toEqual([expect.objectContaining({ id, owner_id: ids.steward, title: "Grievance filing window closes", case_id: ids.caseOne })]);
    const others = await asOwner("select private.account_lifecycle_export_additional_domains($1) value", [ids.coordinator]);
    expect(others[0].value.steward_private_reminders).toEqual([]);
  });

  it("detaches when the case is deleted and leaves with its steward", async () => {
    await asOwner("savepoint detach");
    await asOwner("delete from public.member_cases where id=$1", [ids.caseOne]);
    expect(await asOwner("select case_id from private.steward_private_reminders where owner_id=$1", [ids.steward])).toEqual([{ case_id: null }]);
    await asOwner("rollback to savepoint detach");
    await as(ids.steward);
    const [{ id }] = await list();
    expect((await client.query("select public.steward_delete_private_reminder($1) value", [id])).rows[0].value).toEqual([]);
    await save("Second reminder", "2026-11-01");
    await asOwner("select set_config('request.jwt.claims','',true)");
    expect((await asOwner("select count(*)::int n from private.steward_private_reminders where owner_id=$1", [ids.steward]))[0].n).toBe(1);
    await asOwner("delete from auth.users where id=$1", [ids.steward]);
    expect((await asOwner("select count(*)::int n from private.steward_private_reminders where owner_id=$1", [ids.steward]))[0].n).toBe(0);
  });
});
