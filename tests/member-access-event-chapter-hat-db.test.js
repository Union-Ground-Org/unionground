// @vitest-environment node
//
// BUG-UG-ACCESS-LOG-WRITE-NARROWER-THAN-CASE-READ-20260920
//
// public.record_member_access_event gated on private.has_organization_role and
// derived actor_role from public.organization_role_grants alone, while the case
// reads it accompanies gate on public.member_has_role, which also admits a
// public.member_role_chapters hat in the caller's selected chapter. A chapter-hat
// coordinator or steward listed their cases and was refused 42501 on every open.
//
// 20260924160300 widens the writer to exactly that population. The offline half
// pins the migration text (including the case-graph lock as the first
// statement) and the db-contract needles; the live half runs every actor through
// both public.member_has_role and the writer and requires them to agree.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("member_access_event_chapter_hat_audience"));
const flat = sql.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const databaseIt = process.env.RUN_MEMBER_ACCESS_EVENT_AUDIENCE_DB_TESTS === "1" ? it : it.skip;

const WRITER_SIG = "public.record_member_access_event(p_expected_organization_id uuid, p_subject_user_id uuid, p_action text, p_entity_type text, p_entity_id text)";
const ROLES = "array['steward', 'coordinator', 'advisor', 'admin', 'vp']";

describe("member access event chapter-hat audience migration", () => {
  it("sorts after the comparison base and keeps the case-graph lock as the writer's first statement", () => {
    expect(findMigrationName("member_access_event_chapter_hat_audience")
      > "20260922210600_civic_privacy_export_deletion.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    const body = flat.slice(flat.indexOf("as $function$") + "as $function$".length);
    // The outer block takes the lock before the declaration initializers run
    // (the expected-organization guard, the selected-chapter read), exactly as
    // the 20260907151000 installation wrapper arranged it.
    expect(body.startsWith(" begin perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]); declare org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);")).toBe(true);
    expect(flat).toContain("security definer set search_path = ''");
  });

  it("admits the organization-grant path unchanged or a selected-chapter hat in the same organization, before the subject read", () => {
    expect(flat).toContain(
      `if not ( private.has_organization_role( org, ${ROLES} ) or ( selected_chapter is not null`
      + " and exists ( select 1 from public.chapters chapter where chapter.id = selected_chapter and chapter.organization_id = org )"
      + ` and private.member_has_chapter_role( selected_chapter, ${ROLES} ) ) ) then raise exception 'not authorized' using errcode = '42501';`,
    );
    expect(flat.indexOf("raise exception 'not authorized'"))
      .toBeLessThan(flat.indexOf("membership.user_id = p_subject_user_id"));
    // Role derivation reads the same two sources with the unchanged precedence.
    expect(flat).toContain("from public.member_role_chapters rc");
    expect(flat).toContain("and rc.chapter_id = selected_chapter");
    expect(flat).toContain("order by case hat.role when 'admin' then 1 when 'vp' then 2 when 'coordinator' then 3 when 'advisor' then 4 when 'steward' then 5 else 6 end limit 1;");
    // The shared helpers are composed, never rewritten.
    expect(flat).not.toContain("create or replace function private.member_has_chapter_role");
    expect(flat).not.toContain("create or replace function private.has_organization_role");
    expect(flat).not.toContain("create or replace function public.member_has_role");
  });

  it("pins the widened audience and the lock in the database contract", () => {
    const currentSql = stripComments(loadMigrationSql("unit_stewards_member_data_per_member"));
    const entry = contract.functions.find((fn) => fn.sig === WRITER_SIG);
    expect(entry).toBeTruthy();
    expect(entry.secdef).toBe(true);
    expect(entry.exec).toBe("authenticated");
    for (const needle of [
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);",
      "and private.member_has_chapter_staff_grant(",
      "from public.member_role_chapters rc",
      "and rc.chapter_id = selected_chapter",
      "and chapter.organization_id = org",
    ]) expect(entry.bodyContains).toContain(needle);
    for (const needle of entry.bodyContains) expect(currentSql).toContain(needle);
  });
});

// ---------------------------------------------------------------------------
// Live fixture: one organization with two chapters, one foreign organization.
// ---------------------------------------------------------------------------
// [name, org key, selected chapter key, extra chapters, org grant roles, [chapter key, role] hats, verified factor]
const PEOPLE = [
  ["admin", "orgA", "chapterA", [], ["admin"], [["chapterA", "steward"]], true],
  ["chapterCoordinator", "orgA", "chapterA", [], [], [["chapterA", "coordinator"]], true],
  ["chapterSteward", "orgA", "chapterA", [], [], [["chapterA", "steward"]], true],
  ["noHat", "orgA", "chapterA", [], [], [], true],
  // A coordinator hat in a sibling chapter the caller is not selected into.
  ["unselectedHat", "orgA", "chapterA", ["chapterA2"], [], [["chapterA2", "coordinator"]], true],
  // A chapter hat with no second factor while the organization requires one.
  ["noFactor", "orgA", "chapterA", [], [], [["chapterA", "coordinator"]], false],
  ["subject", "orgA", "chapterA", [], [], [], false],
  ["outsider", "orgB", "chapterB", [], ["admin"], [["chapterB", "admin"]], true],
];

async function seed(client) {
  const ids = { orgA: randomUUID(), orgB: randomUUID() };
  ids.chapterA = `access-hat-a-${ids.orgA}`;
  ids.chapterA2 = `access-hat-a2-${ids.orgA}`;
  ids.chapterB = `access-hat-b-${ids.orgB}`;
  for (const [name] of PEOPLE) {
    ids[name] = randomUUID();
    ids[`${name}Session`] = randomUUID();
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [ids[name], `${ids[name]}@example.invalid`]);
  }
  for (const [org, owner, chapters] of [["orgA", "admin", ["chapterA", "chapterA2"]], ["orgB", "outsider", ["chapterB"]]]) {
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids[org], `access-hat-${ids[org]}`, ids[owner]]);
    for (const chapter of chapters) {
      await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9902)", [ids[chapter], ids[org]]);
    }
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids[org]]);
  }
  for (const [name, org, chapter, extraChapters, orgRoles, hats, factor] of PEOPLE) {
    const user = ids[name];
    await client.query(
      "insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),$3)",
      [ids[`${name}Session`], user, factor ? "aal2" : "aal1"],
    );
    if (factor) {
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic access hat factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids[org], user]);
    for (const key of [chapter, ...extraChapters]) {
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids[key]]);
    }
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, ids[chapter], `Access Hat ${name}`]);
    for (const role of orgRoles) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [ids[org], user, role]);
    }
    for (const [key, role] of hats) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids[key]]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, ids[key]]);
    }
  }
  return ids;
}

async function withFixture(run) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  await client.query("begin");
  try {
    const ids = await seed(client);
    const aal = Object.fromEntries(PEOPLE.map(([name, , , , , , factor]) => [ids[name], factor ? "aal2" : "aal1"]));
    const sessions = Object.fromEntries(PEOPLE.map(([name]) => [ids[name], ids[`${name}Session`]]));
    let savepoint = 0;
    const as = async (user) => {
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claims',$1,true)",
        [JSON.stringify({ role: "authenticated", sub: user, session_id: sessions[user], aal: aal[user] })]);
      await client.query("set local role authenticated");
    };
    // Run one writer call as `user`; the row it wrote is read back as the
    // superuser before the savepoint is rolled back.
    const record = async (user, { org = ids.orgA, subject = ids.subject, action = "viewed_case", entity = "case", entityId = "case-access-hat-1" } = {}) => {
      const label = `access_hat_${++savepoint}`;
      await client.query(`savepoint ${label}`);
      try {
        await as(user);
        const hasRole = (await client.query(
          "select public.member_has_role(array['steward','coordinator','advisor','admin','vp']) v")).rows[0].v;
        let result;
        try {
          const saved = (await client.query(
            "select public.record_member_access_event($1,$2,$3,$4,$5) v", [org, subject, action, entity, entityId])).rows[0].v;
          await client.query("reset role");
          const row = (await client.query(
            "select actor_role, actor_user_id, organization_id from public.member_access_events where id=$1", [saved.id])).rows[0];
          result = { ok: true, hasRole, row };
        } catch (error) {
          result = { ok: false, hasRole, code: error.code, message: error.message };
        }
        return result;
      } finally {
        await client.query(`rollback to savepoint ${label}`);
        await client.query(`release savepoint ${label}`);
        await client.query("reset role");
      }
    };
    await run({ client, ids, record });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

describe("member access event audience, live", () => {
  databaseIt("lets a chapter-hat coordinator and a chapter-hat steward log a case open with their own hat", async () => {
    await withFixture(async ({ ids, record }) => {
      const coordinator = await record(ids.chapterCoordinator);
      expect(coordinator).toMatchObject({ ok: true, hasRole: true, row: { actor_role: "coordinator", actor_user_id: ids.chapterCoordinator, organization_id: ids.orgA } });
      const steward = await record(ids.chapterSteward, { action: "viewed_profile", entity: "member", entityId: null });
      expect(steward).toMatchObject({ ok: true, hasRole: true, row: { actor_role: "steward", actor_user_id: ids.chapterSteward } });
    });
  }, 60_000);

  databaseIt("keeps the organization admin path and applies precedence over the combined hats", async () => {
    await withFixture(async ({ ids, record }) => {
      // The admin also holds a chapter steward hat; admin still wins.
      expect(await record(ids.admin)).toMatchObject({ ok: true, hasRole: true, row: { actor_role: "admin" } });
    });
  }, 60_000);

  databaseIt("refuses a caller with no hat before the subject read, and a hat in an unselected chapter", async () => {
    await withFixture(async ({ ids, record }) => {
      // A subject outside the organization would otherwise say 'subject not
      // authorized'; the no-hat refusal must come first and disclose nothing.
      const stranger = randomUUID();
      expect(await record(ids.noHat, { subject: stranger })).toMatchObject({ ok: false, hasRole: false, code: "42501", message: "not authorized" });
      expect(await record(ids.unselectedHat, { subject: stranger })).toMatchObject({ ok: false, hasRole: false, code: "42501", message: "not authorized" });
      // The foreign admin cannot write into another organization.
      expect(await record(ids.outsider, { org: ids.orgA })).toMatchObject({ ok: false, code: "42501" });
    });
  }, 60_000);

  databaseIt("still enforces the organization's staff second-factor policy on a chapter hat", async () => {
    await withFixture(async ({ ids, record }) => {
      expect(await record(ids.noFactor)).toMatchObject({ ok: false, hasRole: false, code: "42501", message: "not authorized" });
    });
  }, 60_000);

  databaseIt("keeps the existing input refusals for a newly admitted chapter hat", async () => {
    await withFixture(async ({ ids, record }) => {
      expect(await record(ids.chapterCoordinator, { subject: ids.chapterCoordinator })).toMatchObject({ ok: false, code: "22023", message: "cannot record self access" });
      expect(await record(ids.chapterCoordinator, { subject: ids.outsider })).toMatchObject({ ok: false, code: "42501", message: "not authorized" });
      expect(await record(ids.chapterCoordinator, { action: "viewed_case", entity: "member" })).toMatchObject({ ok: false, code: "22023", message: "invalid entity" });
      expect(await record(ids.chapterCoordinator, { entityId: "x".repeat(81) })).toMatchObject({ ok: false, code: "22023", message: "invalid entity" });
      expect(await record(ids.chapterCoordinator, { org: ids.orgB })).toMatchObject({ ok: false, code: "42501" });
    });
  }, 60_000);

  databaseIt("admits exactly the actors public.member_has_role admits in the selected organization", async () => {
    await withFixture(async ({ ids, record }) => {
      const observed = {};
      for (const [name] of PEOPLE.filter(([name]) => name !== "subject" && name !== "outsider")) {
        const result = await record(ids[name]);
        observed[name] = result.ok;
        expect(result.ok, `${name}: writer admission must equal member_has_role`).toBe(result.hasRole);
      }
      expect(observed).toEqual({
        admin: true, chapterCoordinator: true, chapterSteward: true,
        noHat: false, unselectedHat: false, noFactor: false,
      });
    });
  }, 60_000);
});
