// @vitest-environment node
//
// BUG-UG-CASE-MACRO-WRITE-AUDIENCE-WIDER-THAN-READ-20260917
//
// public.casework_macros shipped with three separate statements of one
// audience (20260917144000): the casework_macros_staff_read policy, the
// organization gate inside public.casework_list_macros(), and the chapter
// branch of public.casework_save_macro. The write branch tested
// private.member_has_chapter_role alone, which a public.member_role_chapters
// coordinator satisfies with no public.organization_role_grants row; both read
// statements lead with private.has_organization_role, which nothing but a
// grant row satisfies. That coordinator authored a macro, watched the editor
// reload an empty list, and had no way to open, edit, deactivate or delete the
// row they had just written.
//
// 20260918201000 narrows the write to the read and states the audience once as
// private.casework_macro_audience(organization, chapter, authorship). The
// offline half pins that text and the db-contract entries, so the SQL stays
// guarded without a database. The live half is the part that matters: a
// subset claim between two predicates is only ever proved by evaluating both
// against the same actors, and this defect is precisely one that reads correct
// in isolation — each of the three statements is defensible on its own.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("casework_macro_audience_predicate"));
const flat = sql.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const databaseIt = process.env.RUN_CASEWORK_MACRO_AUDIENCE_DB_TESTS === "1" ? it : it.skip;

const READ_ROLES = "array['steward','coordinator','advisor','admin','vp']";
const AUDIENCE_SIG = "private.casework_macro_audience(p_organization_id uuid, p_chapter_id text, p_authorship boolean)";

// The catalog spelling of the one predicate, as pg_policy renders it. All four
// policies are now this call and nothing else (the two write policies that
// stamp authorship also keep their created_by term).
const READ_CALL = "private.casework_macro_audience(organization_id, chapter_id, false)";
const WRITE_CALL = "private.casework_macro_audience(organization_id, chapter_id, true)";
const AUTHORSHIP_STAMP = "(created_by = ( SELECT auth.uid() AS uid))";

describe("casework macro audience predicate migration", () => {
  it("sorts after the comparison base's newest migration and takes a bounded lock", () => {
    expect(findMigrationName("casework_macro_audience_predicate")
      > "20260918071000_compass_inhouse_mesh_provider.sql").toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("set local statement_timeout = '60s';");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("notify pgrst, 'reload schema';");
  });

  it("states the audience exactly once, in the shape of the helpers it composes", () => {
    expect(flat.match(/create or replace function private\.casework_macro_audience\(/g)).toHaveLength(1);
    expect(flat).toContain(
      "create or replace function private.casework_macro_audience( p_organization_id uuid,"
      + " p_chapter_id text, p_authorship boolean default false ) returns boolean language sql"
      + " stable security definer set search_path = ''",
    );
    // Authorship is the read expression conjoined with one further term, never
    // an alternative to it: that conjunction is what makes write a subset of
    // read by construction rather than by comment.
    expect(flat).toContain(
      `select private.has_organization_role(p_organization_id, ${READ_ROLES})`
      + ` and (p_chapter_id is null or private.member_has_chapter_role(p_chapter_id, ${READ_ROLES}))`
      + " and (not coalesce(p_authorship, false)"
      + " or case when p_chapter_id is null"
      + " then private.has_organization_role(p_organization_id, array['admin','vp'])"
      + " else private.member_has_chapter_role(p_chapter_id, array['coordinator','admin','vp']) end);",
    );
    // An RLS policy expression runs as the querying role, so the read policy
    // needs the authenticated grant; nothing else may reach it.
    expect(flat).toContain(
      "revoke all on function private.casework_macro_audience(uuid, text, boolean)"
      + " from public, anon, authenticated, service_role;",
    );
    expect(flat).toContain(
      "grant execute on function private.casework_macro_audience(uuid, text, boolean) to authenticated;",
    );
    // The two shared role helpers are correct for their own callers and are
    // used repository-wide; this repair composes them and never rewrites them.
    expect(flat).not.toContain("create or replace function private.member_has_chapter_role");
    expect(flat).not.toContain("create or replace function private.has_organization_role");
  });

  it("routes both read statements through the predicate and re-writes the rationale comment", () => {
    expect(flat).toContain(
      `alter policy casework_macros_staff_read on public.casework_macros using (${READ_CALL});`,
    );
    // The organization short-circuit is the policy's own leading conjunct,
    // reached through the same function with a null chapter.
    expect(flat).toContain(
      "if v_org is null or not private.casework_macro_audience(v_org, null, false) then return '[]'::jsonb; end if;",
    );
    expect(flat).toContain(
      "where m.organization_id = v_org and private.casework_macro_audience(m.organization_id, m.chapter_id, false)",
    );
    // Neither read statement writes the audience out by hand any more.
    expect(flat).not.toContain(`not private.has_organization_role(v_org, ${READ_ROLES})`);
    expect(flat).not.toContain(`private.member_has_chapter_role(m.chapter_id, ${READ_ROLES})`);
    const comment = flat.match(
      /comment on policy casework_macros_staff_read on public\.casework_macros is '([^']|'')+';/,
    );
    expect(comment, "the read policy's rationale must be rewritten").toBeTruthy();
    expect(comment[0]).toContain("private.casework_macro_audience");
    expect(comment[0]).not.toContain("the write audience is a subset of the read audience above");
  });

  it("narrows every write path to the authorship branch while keeping the per-command split", () => {
    // casework_save_macro: the scope branches resolve the organization only;
    // one call decides the admission, and it carries the hint the client maps
    // to translated copy.
    expect(flat).toContain("if not private.casework_macro_audience(v_org, v_chapter, true) then");
    expect(flat).toContain("using errcode = '42501', hint = 'casework_macro_audience';");
    expect(flat).not.toContain(
      "if not private.member_has_chapter_role(v_chapter, array['coordinator','admin','vp']) then",
    );
    // The three write policies keep their commands, their roles and their
    // authorship stamp. ALTER, not DROP/CREATE: the split itself is out of
    // scope and byte-equivalent to the FOR ALL policy it replaced.
    expect(flat).toContain(
      `alter policy casework_macros_admin_insert on public.casework_macros with check ( created_by = (select auth.uid()) and ${WRITE_CALL} );`,
    );
    expect(flat).toContain(
      `alter policy casework_macros_admin_update on public.casework_macros using (${WRITE_CALL})`
      + ` with check ( created_by = (select auth.uid()) and ${WRITE_CALL} );`,
    );
    expect(flat).toContain(
      `alter policy casework_macros_admin_delete on public.casework_macros using (${WRITE_CALL});`,
    );
    expect(flat).not.toContain("drop policy");
    expect(flat).not.toContain("create policy");
    // created_by's disposition is.3 and is not this repair's
    // to change.
    expect(flat).not.toContain("on delete");
    expect(flat).not.toContain("account_lifecycle_manifest");
  });

  it("pins the predicate and the four re-stated policy expressions in the database contract", () => {
    const fn = contract.functions.find((entry) => entry.sig === AUDIENCE_SIG);
    expect(fn, "the new predicate needs a db-contract entry").toBeTruthy();
    expect(fn.secdef).toBe(true);
    expect(fn.exec).toBe("authenticated");
    const policies = new Map(contract.policies
      .filter((entry) => entry.table === "casework_macros")
      .map((entry) => [entry.name, entry]));
    expect(policies.get("casework_macros_staff_read").qual).toBe(READ_CALL);
    expect(policies.get("casework_macros_admin_insert").withCheck).toBe(`(${AUTHORSHIP_STAMP} AND ${WRITE_CALL})`);
    expect(policies.get("casework_macros_admin_update").qual).toBe(WRITE_CALL);
    expect(policies.get("casework_macros_admin_update").withCheck).toBe(`(${AUTHORSHIP_STAMP} AND ${WRITE_CALL})`);
    expect(policies.get("casework_macros_admin_delete").qual).toBe(WRITE_CALL);
  });

  // DEBT-UG-CASEWORK-MACRO-WRITE-POLICIES-UNREACHABLE-20260921: the three
  // write policies above never evaluate. The client holds SELECT alone and the
  // only writer is a security-definer routine, so the contract says so rather
  // than inviting a reader to trust the policies as the guard.
  it("keeps the client grant SELECT-only and records the write policies as defence in depth", () => {
    const grantStatements = loadMigrationSql("casework_macros_case_note_mentions");
    const grants = stripComments(grantStatements).replace(/\s+/g, " ")
      .match(/(?:grant|revoke) [^;]* on table public\.casework_macros (?:to|from) [^;]*;/g);
    expect(grants).toEqual([
      "revoke all on table public.casework_macros from public, anon, authenticated;",
      "grant select on table public.casework_macros to authenticated;",
    ]);
    // No later migration widens it.
    const mentions = findMigrationName("casework_macros_case_note_mentions");
    const widened = migrationFiles()
      .filter((file) => file.name > mentions)
      .filter((file) => /grant [^;]* on (?:table )?public\.casework_macros\b/.test(stripComments(file.sql).replace(/\s+/g, " ")))
      .map((file) => file.name);
    expect(widened).toEqual([]);
    // The no-re-stamp guarantee lives in the routine: its update never assigns
    // created_by, so an edit keeps the original author.
    const update = flat.match(/update public\.casework_macros set [^;]*;/g);
    expect(update).toHaveLength(1);
    expect(update[0]).not.toContain("created_by");
    for (const name of ["casework_macros_admin_insert", "casework_macros_admin_update", "casework_macros_admin_delete"]) {
      const entry = contract.policies.find((policy) => policy.table === "casework_macros" && policy.name === name);
      expect(entry.note, `${name} must be recorded as unreachable`).toContain("Defence in depth only");
      expect(entry.note).toContain("DEBT-UG-CASEWORK-MACRO-WRITE-POLICIES-UNREACHABLE-20260921");
    }
  });
});

// ---------------------------------------------------------------------------
// Live fixture
// ---------------------------------------------------------------------------
//
// One organization with six actors, one chapter, and a second organization to
// supply the foreign one. The actor this record is about is `chapterOnly`: an
// active organization membership, an active chapter membership, a
// public.member_role_chapters coordinator row and deliberately NO
// public.organization_role_grants row.
const ACTORS = ["admin", "chapterOnly", "advisor", "steward", "member", "outsider"];

async function seed(client) {
  const ids = Object.fromEntries([
    ...ACTORS, ...ACTORS.map((name) => `${name}Session`), "orgA", "orgB",
  ].map((key) => [key, randomUUID()]));
  ids.chapterA = `macro-audience-a-${ids.orgA}`;
  ids.chapterB = `macro-audience-b-${ids.orgB}`;

  // [user, organization, chapter, organization_role_grants roles, member_role_chapters roles]
  const people = [
    [ids.admin, ids.orgA, ids.chapterA, ["admin"], ["admin"]],
    // The record's actor. The chapter coordinator hat exists only as a
    // member_role_chapters row; no organization role grant backs it.
    [ids.chapterOnly, ids.orgA, ids.chapterA, [], ["coordinator"]],
    [ids.advisor, ids.orgA, ids.chapterA, ["advisor"], ["advisor"]],
    [ids.steward, ids.orgA, ids.chapterA, ["steward"], ["steward"]],
    [ids.member, ids.orgA, ids.chapterA, [], []],
    [ids.outsider, ids.orgB, ids.chapterB, ["admin"], ["admin"]],
  ];

  for (const [org, chapter, owner] of [[ids.orgA, ids.chapterA, ids.admin], [ids.orgB, ids.chapterB, ids.outsider]]) {
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [owner, `${owner}@example.invalid`]);
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [org, `macro-audience-${org}`, owner]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9901)", [chapter, org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [org]);
  }

  for (const [user, org, chapter, orgRoles, chapterRoles] of people) {
    const exists = (await client.query("select 1 from auth.users where id=$1", [user])).rowCount;
    if (!exists) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
    }
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [ids[`${ACTORS.find((name) => ids[name] === user)}Session`], user]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic macro audience factor','totp','verified',now(),now())", [randomUUID(), user]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user, chapter, `Macro Audience ${user.slice(0, 8)}`]);
    for (const role of orgRoles) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [org, user, role]);
    }
    for (const role of chapterRoles) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3) on conflict do nothing", [user, role, chapter]);
    }
  }
  return ids;
}

const MACRO_ACTIONS = JSON.stringify([
  { kind: "add_note", body: "Macro filed this case at step one." },
]);

function actorHelpers(client, ids) {
  const sessions = Object.fromEntries(ACTORS.map((name) => [ids[name], ids[`${name}Session`]]));
  const as = async (user, role = "authenticated") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ role, sub: user, session_id: sessions[user], aal: "aal2" })]);
    await client.query(`set local role ${role}`);
  };
  let savepoint = 0;
  // Every authorship attempt is rolled back, so the enumeration reads one
  // fixed catalogue no matter which actor ran first. On an accepted save the
  // caller reads its own new row back BEFORE the rollback: that read-back is
  // the end-to-end form of the invariant, and it is the only form that works
  // for an actor whose organization-wide macro lands in their own tenant
  // rather than in the fixture's first organization.
  const attemptSave = async (chapterId, name) => {
    const label = `macro_audience_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      const saved = (await client.query(
        "select public.casework_save_macro(null,$1,$2,$3::jsonb,true) value", [chapterId, name, MACRO_ACTIONS])).rows[0].value;
      const listed = ((await client.query("select public.casework_list_macros() value")).rows[0].value || [])
        .some((macro) => macro.id === saved.id);
      const selected = (await client.query(
        "select count(*)::int n from public.casework_macros where id=$1", [saved.id])).rows[0].n === 1;
      return { accepted: true, code: null, hint: null, listedBack: listed, selectedBack: selected };
    } catch (error) {
      return { accepted: false, code: error.code, hint: error.hint ?? null, listedBack: false, selectedBack: false };
    } finally {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
    }
  };
  return { as, attemptSave };
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

// The two macros every read and write assertion below is made against: one
// organization-wide, one scoped to chapterA, both authored by the organization
// admin so the catalogue exists before anybody else is measured.
async function seedMacros(client, ids, as) {
  await as(ids.admin);
  const orgMacro = (await client.query(
    "select public.casework_save_macro(null,null,'Audience org macro',$1::jsonb,true) value", [MACRO_ACTIONS])).rows[0].value;
  const chapterMacro = (await client.query(
    "select public.casework_save_macro(null,$1,'Audience chapter macro',$2::jsonb,true) value", [ids.chapterA, MACRO_ACTIONS])).rows[0].value;
  return { orgMacro, chapterMacro };
}

describe("casework macro audience, live", () => {
  databaseIt("makes the member_role_chapters-only coordinator's save, list and direct select agree", async () => {
    await withFixture(async (client, ids, { as, attemptSave }) => {
      const { chapterMacro } = await seedMacros(client, ids, as);

      // The two role helpers still disagree — that is not a defect and this
      // repair does not touch them. It is the reason the three audience
      // statements had to be reduced to one.
      await as(ids.chapterOnly);
      const helpers = (await client.query(
        `select private.member_has_chapter_role($1, array['coordinator','admin','vp']) chapter_role,
                private.has_organization_role($2, array['steward','coordinator','advisor','admin','vp']) org_role`,
        [ids.chapterA, ids.orgA])).rows[0];
      expect(helpers).toEqual({ chapter_role: true, org_role: false });

      // Authorship now refuses, and it says why in a way the client can map.
      const attempt = await attemptSave(ids.chapterA, "Chapter hat macro");
      expect(attempt).toMatchObject({ accepted: false, code: "42501", hint: "casework_macro_audience" });

      // ... and the two read paths agree with that refusal: nothing to list,
      // nothing to select, for the same caller in the same session.
      expect((await client.query("select public.casework_list_macros() value")).rows[0].value).toEqual([]);
      expect((await client.query("select count(*)::int n from public.casework_macros")).rows[0].n).toBe(0);
      expect((await client.query("select count(*)::int n from public.casework_macros where id=$1", [chapterMacro.id])).rows[0].n).toBe(0);

      // Nothing was written. The old behaviour accepted the row and then
      // showed the author an empty list; the repair writes no row at all.
      await as(ids.chapterOnly, "postgres");
      expect((await client.query(
        "select count(*)::int n from public.casework_macros where name='Chapter hat macro'")).rows[0].n).toBe(0);
      expect((await client.query(
        "select count(*)::int n from public.casework_audit_events where event_type='macro_saved' and actor_user_id=$1",
        [ids.chapterOnly])).rows[0].n).toBe(0);
    });
  }, 60_000);

  databaseIt("keeps the organization-grant author's macros readable through both read paths", async () => {
    await withFixture(async (client, ids, { as }) => {
      const { orgMacro, chapterMacro } = await seedMacros(client, ids, as);
      // The repair narrows one branch; it must not cost the working path
      // anything. The admin still authors both scopes and still reads both,
      // through the RPC and through the table.
      const listed = (await client.query("select public.casework_list_macros() value")).rows[0].value;
      expect(listed.map((macro) => macro.id).sort()).toEqual([orgMacro.id, chapterMacro.id].sort());
      expect((await client.query("select id from public.casework_macros order by name")).rows.map((row) => row.id).sort())
        .toEqual([orgMacro.id, chapterMacro.id].sort());
      // An edit through the routine still round-trips.
      const edited = (await client.query(
        "select public.casework_save_macro($1,$2,'Audience chapter macro',$3::jsonb,false) value",
        [chapterMacro.id, ids.chapterA, MACRO_ACTIONS])).rows[0].value;
      expect(edited).toMatchObject({ id: chapterMacro.id, active: false });
    });
  }, 60_000);

  databaseIt("refuses every direct client write, leaving casework_save_macro the only writer", async () => {
    await withFixture(async (client, ids, { as }) => {
      const { chapterMacro } = await seedMacros(client, ids, as);
      // The admin passes every write policy, so a refusal here is the missing
      // grant and not RLS: the policies are never reached.
      await as(ids.admin);
      expect((await client.query(
        "select private.casework_macro_audience($1,$2,true) admitted", [ids.orgA, ids.chapterA])).rows[0].admitted).toBe(true);
      const direct = async (statement, params) => {
        await client.query("savepoint direct_macro_write");
        try {
          await client.query(statement, params);
          return { code: null, message: null };
        } catch (error) {
          return { code: error.code, message: error.message };
        } finally {
          await client.query("rollback to savepoint direct_macro_write");
          await client.query("release savepoint direct_macro_write");
        }
      };
      const refused = { code: "42501", message: "permission denied for table casework_macros" };
      expect(await direct(
        "insert into public.casework_macros(organization_id,chapter_id,name,actions,active,created_by) values($1,$2,'Direct macro',$3::jsonb,true,$4)",
        [ids.orgA, ids.chapterA, MACRO_ACTIONS, ids.admin])).toEqual(refused);
      expect(await direct(
        "update public.casework_macros set name='Direct rename' where id=$1", [chapterMacro.id])).toEqual(refused);
      expect(await direct(
        "delete from public.casework_macros where id=$1", [chapterMacro.id])).toEqual(refused);

      // The routine is the guarantee the update policy's created_by term only
      // states: a second authorized editor edits the macro and the original
      // author stays stamped on it.
      await as(ids.admin, "postgres");
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$3)", [ids.orgA, ids.advisor, ids.admin]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids.advisor, ids.chapterA]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids.advisor, ids.chapterA]);
      await as(ids.advisor);
      const edited = (await client.query(
        "select public.casework_save_macro($1,$2,'Edited by a second admin',$3::jsonb,true) value",
        [chapterMacro.id, ids.chapterA, MACRO_ACTIONS])).rows[0].value;
      expect(edited).toMatchObject({ id: chapterMacro.id });
      await as(ids.admin, "postgres");
      expect((await client.query(
        "select name, created_by from public.casework_macros where id=$1", [chapterMacro.id])).rows[0])
        .toEqual({ name: "Edited by a second admin", created_by: ids.admin });
    });
  }, 60_000);

  databaseIt("binds all four installed policies to the one predicate", async () => {
    await withFixture(async (client, ids, { as }) => {
      await as(ids.admin, "postgres");
      const rows = (await client.query(`
        select polname,
               pg_catalog.pg_get_expr(polqual, polrelid) qual,
               pg_catalog.pg_get_expr(polwithcheck, polrelid) with_check
        from pg_catalog.pg_policy
        where polrelid = 'public.casework_macros'::regclass
          and polname <> 'mfa_assurance'
        order by polname`)).rows;
      expect(rows.map((row) => row.polname)).toEqual([
        "casework_macros_admin_delete", "casework_macros_admin_insert",
        "casework_macros_admin_update", "casework_macros_staff_read",
      ]);
      const byName = Object.fromEntries(rows.map((row) => [row.polname, row]));
      // Read: the predicate and nothing else. Writes: the predicate with
      // authorship true, plus the created_by stamp the split already carried.
      expect(byName.casework_macros_staff_read.qual).toBe(READ_CALL);
      expect(byName.casework_macros_staff_read.with_check).toBeNull();
      expect(byName.casework_macros_admin_delete.qual).toBe(WRITE_CALL);
      expect(byName.casework_macros_admin_insert.qual).toBeNull();
      expect(byName.casework_macros_admin_insert.with_check).toBe(`(${AUTHORSHIP_STAMP} AND ${WRITE_CALL})`);
      expect(byName.casework_macros_admin_update.qual).toBe(WRITE_CALL);
      expect(byName.casework_macros_admin_update.with_check).toBe(`(${AUTHORSHIP_STAMP} AND ${WRITE_CALL})`);
      // The table still hands the client no direct write grant, so the three
      // write policies are the statement of authorship, not its only guard.
      const grants = (await client.query(`
        select privilege_type from information_schema.role_table_grants
        where table_schema='public' and table_name='casework_macros' and grantee='authenticated'
        order by privilege_type`)).rows.map((row) => row.privilege_type);
      expect(grants).toEqual(["SELECT"]);
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// The standing enumeration
// ---------------------------------------------------------------------------
//
// A separate describe so it runs live in CI beside the case above. It fails if
// ANY actor is admitted by a write path and refused by a read path, which is
// the invariant the migration's own comment used to assert without proving.
describe("casework macro write admissions are a subset of the read admissions", () => {
  databaseIt("admits no actor to a write path that a read path refuses", async () => {
    await withFixture(async (client, ids, { as, attemptSave }) => {
      const { orgMacro, chapterMacro } = await seedMacros(client, ids, as);
      const scopes = [
        { label: "organization", chapterId: null, macroId: orgMacro.id },
        { label: "chapter", chapterId: ids.chapterA, macroId: chapterMacro.id },
      ];
      const observed = [];

      for (const actor of ACTORS) {
        await as(ids[actor]);
        const listed = new Set(((await client.query("select public.casework_list_macros() value")).rows[0].value || [])
          .map((macro) => macro.id));
        const selected = new Set((await client.query("select id from public.casework_macros")).rows.map((row) => row.id));
        // The organization an organization-wide save would land in. For the
        // five actors of the first organization that is orgA; for the foreign
        // admin it is their own tenant, which is why the read-back rather than
        // the fixture's macro ids is what proves their half.
        // (private.current_mobile_staff_organization() is revoked from every
        // client role, so this comes from the fixture rather than the catalog.)
        const staffOrg = actor === "outsider" ? ids.orgB : ids.orgA;

        for (const scope of scopes) {
          // Read admissions on the fixture's two macros, observed rather than
          // computed: what casework_list_macros() returns, and what a direct
          // select under casework_macros_staff_read returns.
          const listRead = listed.has(scope.macroId);
          const tableRead = selected.has(scope.macroId);
          // The write policies' admission on those same coordinates. The
          // installed-policy case above pins that the three policies ARE this
          // call, so evaluating it as the actor is evaluating them.
          const policyWrite = (await client.query(
            "select private.casework_macro_audience($1,$2,true) admitted", [ids.orgA, scope.chapterId])).rows[0].admitted;
          // casework_save_macro, executed for real and rolled back, with the
          // caller's own read-back of whatever it wrote.
          const save = await attemptSave(scope.chapterId, `Enumerated ${actor} ${scope.label}`);
          // What the routine's own audience call resolves to for the row this
          // actor's save would create.
          const routineWrite = (await client.query(
            "select private.casework_macro_audience($1,$2,true) admitted",
            [scope.chapterId === null ? staffOrg : ids.orgA, scope.chapterId])).rows[0].admitted;

          observed.push({ actor, scope: scope.label, save: save.accepted, policyWrite, listRead, tableRead });

          // The invariant, stated three ways.
          // 1. The two read paths never disagree for the same caller.
          expect(listRead, `${actor}/${scope.label}: the RPC and the table must agree`).toBe(tableRead);
          // 2. A write policy never admits an actor casework_macros_staff_read
          //    refuses, on the same organization and chapter.
          if (policyWrite) {
            expect(tableRead, `${actor}/${scope.label}: a write policy admits an actor casework_macros_staff_read refuses`).toBe(true);
            expect(listRead, `${actor}/${scope.label}: a write policy admits an actor casework_list_macros refuses`).toBe(true);
          }
          // 3. An accepted save is always a row that same caller can list and
          //    select; a refused save is an authorization refusal, never a
          //    crash or a constraint failure.
          if (save.accepted) {
            expect(save.listedBack, `${actor}/${scope.label}: casework_save_macro wrote a row the author cannot list`).toBe(true);
            expect(save.selectedBack, `${actor}/${scope.label}: casework_save_macro wrote a row the author cannot select`).toBe(true);
          } else {
            expect(save.code, `${actor}/${scope.label}: a refused save must be an authorization refusal`).toBe("42501");
          }
          // The routine and the policies state one audience, so they agree on
          // every actor and every scope.
          expect(save.accepted, `${actor}/${scope.label}: the routine and the policies must state one audience`).toBe(routineWrite);
        }
      }

      // The fixture really did exercise both sides of every boundary. Without
      // this the implications above could pass vacuously on a fixture that
      // refused, or admitted, everybody.
      expect(observed.filter((row) => row.save)).not.toHaveLength(0);
      expect(observed.filter((row) => !row.save && row.listRead)).not.toHaveLength(0);
      expect(observed.filter((row) => !row.save && !row.listRead)).not.toHaveLength(0);
      expect(observed.filter((row) => row.policyWrite)).not.toHaveLength(0);
      // The specific shape this record is about: the chapter-hat-only
      // coordinator is refused on both sides now, where the chapter branch of
      // casework_save_macro used to admit them alone.
      expect(observed.filter((row) => row.actor === "chapterOnly")).toEqual([
        { actor: "chapterOnly", scope: "organization", save: false, policyWrite: false, listRead: false, tableRead: false },
        { actor: "chapterOnly", scope: "chapter", save: false, policyWrite: false, listRead: false, tableRead: false },
      ]);
      // The organization admin writes and reads both scopes.
      expect(observed.filter((row) => row.actor === "admin").every((row) => row.save && row.policyWrite && row.listRead)).toBe(true);
      // The advisor and the steward read both scopes and write neither.
      for (const actor of ["advisor", "steward"]) {
        expect(observed.filter((row) => row.actor === actor).every((row) => row.listRead && !row.save && !row.policyWrite)).toBe(true);
      }
      // The member is not staff anywhere.
      expect(observed.filter((row) => row.actor === "member").every((row) => !row.listRead && !row.save && !row.policyWrite)).toBe(true);
      // The foreign admin reads none of this organization's macros and is
      // refused its chapter scope; their organization-wide save lands in their
      // own tenant, where the read-back above proved they can see it.
      expect(observed.filter((row) => row.actor === "outsider").every((row) => !row.listRead && !row.policyWrite)).toBe(true);
      expect(observed.find((row) => row.actor === "outsider" && row.scope === "chapter").save).toBe(false);
    });
  }, 120_000);
});
