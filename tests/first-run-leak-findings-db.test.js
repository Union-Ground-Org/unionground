// @vitest-environment node
//
// SEC-UG-NON-INTERFERENCE-FIRST-RUN-FINDINGS-20261111 (#8337), items 1
// and 3, on a disposable database. Checks visibility for each caller.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("first-run leak findings on a disposable database", () => {
  let client;
  const sessions = new Map();

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "first-run-leak-findings-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function inTransaction(body) {
    await client.query("begin");
    try {
      return await body();
    } finally {
      await client.query("rollback");
    }
  }

  async function organization(label) {
    const org = randomUUID();
    const chapter = `${label}-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `${label}-${org}`, `Fictional ${label}`]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$2,$1,'proof',$3,9971)",
      [chapter, `Fictional ${label} chapter`, org]);
    return { org, chapter };
  }

  async function person(t, label, { orgRoles = [], chapterRoles = [] } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email,created_at) values ($1,$2,now() - interval '30 days')", [id, `${id}@first-run.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, t.chapter, `Fictional ${label}`]);
    await client.query("insert into public.organization_memberships(user_id,organization_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.org]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.chapter]);
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    sessions.set(id, session);
    for (const role of orgRoles) {
      await client.query("insert into public.organization_role_grants(user_id,organization_id,role) values ($1,$2,$3)", [id, t.org, role]);
    }
    for (const role of chapterRoles) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [id, role, t.chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, t.chapter]);
    }
    return id;
  }

  async function unit(t, label) {
    const id = randomUUID();
    await client.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values ($1,$2,$3,$4)", [id, t.org, t.chapter, `Fictional ${label}`]);
    return id;
  }

  const joinUnit = (t, unitId, user) => client.query(
    "insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values ($1,$2,$3)", [unitId, t.chapter, user]);
  const scopeSteward = (t, unitId, user) => client.query(
    "insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values ($1,$2,'steward',$3)", [user, t.chapter, unitId]);

  // One statement as the given account, inside a savepoint so a refusal leaves
  // the transaction usable.
  async function as(userId, statement, args = []) {
    await client.query("savepoint cell");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: sessions.get(userId) })]);
      await client.query("set local role authenticated");
      const result = await client.query(statement, args);
      await client.query("reset role");
      await client.query("release savepoint cell");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      await client.query("reset role");
      return { ok: false, code: error.code || "", message: error.message || "" };
    }
  }

  // A chapter with two units: a steward limited to each, a member in each, a
  // chapter-wide steward and a plain member.
  async function chapterWithUnits() {
    const t = await organization("units");
    const [one, two] = [await unit(t, "Unit One"), await unit(t, "Unit Two")];
    const people = {
      wide: await person(t, "Chapter Steward", { chapterRoles: ["steward"] }),
      plain: await person(t, "Plain Member"),
      stewardOne: await person(t, "Unit One Steward", { chapterRoles: ["steward"] }),
      memberOne: await person(t, "Unit One Member"),
      stewardTwo: await person(t, "Unit Two Steward", { chapterRoles: ["steward"] }),
      memberTwo: await person(t, "Unit Two Member"),
    };
    for (const user of [people.stewardOne, people.memberOne]) await joinUnit(t, one, user);
    for (const user of [people.stewardTwo, people.memberTwo]) await joinUnit(t, two, user);
    await scopeSteward(t, one, people.stewardOne);
    await scopeSteward(t, two, people.stewardTwo);
    return { t, people };
  }

  it("item 1: a member reads no automation rows, with or without another organization's, and an operator still reads its own", () => inTransaction(async () => {
    const mine = await organization("automation-own");
    const other = await organization("automation-other");
    const admin = await person(mine, "Own Admin", { orgRoles: ["admin"] });
    const member = await person(mine, "Own Member");
    const steward = await person(mine, "Own Steward", { chapterRoles: ["steward"] });
    const otherAdmin = await person(other, "Other Admin", { orgRoles: ["admin"] });
    const read = (user) => as(user, "select pg_catalog.count(*)::int as n from public.organization_automation_definitions");
    for (const user of [member, steward]) expect(await read(user)).toEqual({ ok: true, rows: [{ n: 0 }] });
    await client.query(
      "insert into public.organization_automation_definitions(organization_id,name,trigger_kind,threshold_days,created_by,updated_by) values ($1,'Fictional other rule','overdue_task',3,$2,$2), ($3,'Fictional own rule','overdue_task',3,$4,$4)",
      [other.org, otherAdmin, mine.org, admin]);
    // At 986e81e5 these reads failed with 42501 once any organization had a row.
    for (const user of [member, steward]) expect(await read(user)).toEqual({ ok: true, rows: [{ n: 0 }] });
    for (const table of ["organization_automation_runs", "organization_automation_effects"]) {
      expect(await as(member, `select pg_catalog.count(*)::int as n from public.${table}`)).toEqual({ ok: true, rows: [{ n: 0 }] });
    }
    expect(await read(admin)).toEqual({ ok: true, rows: [{ n: 1 }] });
  }));

  it("item 3: the task assignee list follows unit scope only for a unit-limited steward", () => inTransaction(async () => {
    const { people } = await chapterWithUnits();
    const listed = async (user) => {
      const answer = await as(user, "select user_id from public.list_chapter_task_assignees()");
      expect(answer.ok, answer.message).toBe(true);
      return new Set(answer.rows.map((row) => row.user_id));
    };
    const one = await listed(people.stewardOne);
    expect(one.has(people.stewardOne)).toBe(true);
    expect(one.has(people.memberOne)).toBe(true);
    expect(one.has(people.memberTwo)).toBe(false);
    expect(one.has(people.stewardTwo)).toBe(false);
    for (const user of [people.wide, people.plain]) {
      const all = await listed(user);
      for (const id of Object.values(people)) expect(all.has(id), `${user} sees ${id}`).toBe(true);
    }
  }));

  it("item 3: the workload view's stewards follow unit scope only for a unit-limited steward", () => inTransaction(async () => {
    const { t, people } = await chapterWithUnits();
    await client.query(`insert into public.member_cases(id,user_id,reference,title,case_type,status,deadline,steward_user_id)
      values ($1,$2,'NI-ONE','Fictional unit one case','other','active',current_date + 30,$3),
             ($4,$5,'NI-TWO','Fictional unit two case','other','active',current_date + 30,$6)`,
      [randomUUID(), people.memberOne, people.stewardOne, randomUUID(), people.memberTwo, people.stewardTwo]);
    const stewards = async (user) => {
      const answer = await as(user, "select public.get_steward_workload_intelligence(12) -> 'rebalancing' -> 'stewards' as s");
      expect(answer.ok, answer.message).toBe(true);
      return new Map((answer.rows[0].s ?? []).map((row) => [row.userId, row.activeCases]));
    };
    const limited = await stewards(people.stewardOne);
    expect(limited.has(people.stewardOne)).toBe(true);
    expect(limited.has(people.wide)).toBe(true);
    expect(limited.has(people.stewardTwo)).toBe(false);
    expect(limited.get(people.stewardOne)).toBe(1);
    const wide = await stewards(people.wide);
    for (const id of [people.wide, people.stewardOne, people.stewardTwo]) expect(wide.has(id), id).toBe(true);
    expect(wide.get(people.stewardTwo)).toBe(1);
    expect(t.chapter).toBeTruthy();
  }));

  it("item 3: an organization-wide steward grant wins over a unit scope left from before it", () => inTransaction(async () => {
    const { t, people } = await chapterWithUnits();
    // Promoted to an organization-wide steward; the old Unit Two scope stays.
    await client.query("insert into public.organization_role_grants(user_id,organization_id,role) values ($1,$2,'steward')", [people.stewardTwo, t.org]);
    const answer = await as(people.stewardOne, "select public.get_steward_workload_intelligence(12) -> 'rebalancing' -> 'stewards' as s");
    expect(answer.ok, answer.message).toBe(true);
    const ids = new Set((answer.rows[0].s ?? []).map((row) => row.userId));
    expect(ids.has(people.stewardTwo)).toBe(true);
    expect(ids.has(people.stewardOne)).toBe(true);
  }));
});
