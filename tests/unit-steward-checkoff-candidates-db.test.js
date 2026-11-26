// @vitest-environment node
// #9307: candidate names and ids follow the shared member-data boundary.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl, PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { codeOnly, helperFirst } from "../scripts/account-case-graph-inventory.mjs";
import { fnBody, loadMigrationSql, migrationFiles } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";
import { offlinePostgres } from "./tamarack-postgres-helper.mjs";

const STEM = "unit_steward_checkoff_candidates_per_member";
const NAME = "public.list_task_checkoff_candidates";
const predecessor = fnBody(loadMigrationSql("integrations_wallet_calendar_drive_checkoff"), NAME);
const PAYLOAD = "private.task_checkoff_payload";
const GETTER = "public.get_task_checkoff_list";
const CREATOR = "public.create_task_checkoff_list";
const ACTOR = "private.task_checkoff_actor_can_see_member";
const originals = {
  [NAME]: predecessor,
  [PAYLOAD]: fnBody(loadMigrationSql("integrations_wallet_calendar_drive_checkoff"), PAYLOAD),
  [GETTER]: fnBody(loadMigrationSql("integrations_wallet_calendar_drive_checkoff"), GETTER),
  [CREATOR]: fnBody(loadMigrationSql("learning_period_tasks"), CREATOR),
};
const signatures = { [NAME]: "uuid", [PAYLOAD]: "uuid,uuid", [GETTER]: "uuid", [CREATOR]: "uuid,text,uuid[],uuid[],jsonb" };
const source = (sql) => sql.split("$function$")[1];
const md5 = (text) => createHash("md5").update(text).digest("hex");
const filter = `      and (
        broad_roster
        or cm.user_id = any(visible_members)
      )
`;
const broadSetup = `  broad_roster := private.member_has_chapter_role(scope.chapter_id, array['steward','coordinator','advisor','admin','vp'])
    or private.chapter_organization_role_allowed(scope.chapter_id, array['steward','coordinator','advisor','admin','vp']);
`;

describe("check-off candidate member boundary (static)", () => {
  it("adds only the shared member predicate before ordering and the existing 500-member cap", () => {
    const replacement = fnBody(loadMigrationSql(STEM), NAME);
    expect(source(replacement).replace(filter, "").replace("  broad_roster boolean;\n", "")
      .replace("  visible_members uuid[];\n", "").replace(broadSetup, "")
      .replace(/ {2}if not broad_roster then\n[\s\S]*? {2}end if;\n/, "")).toBe(source(predecessor));
    expect(source(replacement)).toContain(filter);
    // #9454 round 1 (r1s2): every staff role's canonical set, as the payload
    // and creator use; no task-chapter grant gate drops another chapter's role.
    expect(replacement).toContain("from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) held(role)\n    ) admitted;");
    expect(replacement).not.toMatch(/member_has_chapter_staff_grant|has_organization_role\(scope\.organization_id/);
    expect(replacement).not.toContain("private.chapter_staff_member_allowed(scope.chapter_id, cm.user_id,");
    expect(replacement.indexOf(filter)).toBeLessThan(replacement.indexOf("limit 500"));
    expect(replacement.replace("create or replace", "create").split("as $function$")[0])
      .toBe(predecessor.split("as $function$")[0]);
  });

  it("pins the newest Main predecessor, keeps the refusal entry and registers the proof", () => {
    const files = migrationFiles().filter(({ sql }) => new RegExp(`create (?:or replace )?function ${NAME.replaceAll(".", "\\.")}\\(`, "i").test(sql));
    expect(files.map(({ name }) => name)).toEqual([
      "20261003053000_integrations_wallet_calendar_drive_checkoff.sql",
      expect.stringContaining(STEM),
    ]);
    const migration = loadMigrationSql(STEM);
    expect(migration).toContain(md5(source(predecessor)));
    expect(migration).toContain("pg_catalog.to_regprocedure('public.list_task_checkoff_candidates(uuid)')");
    expect(migration).toContain("errcode = '55000'");
    expect(codeOnly(migration)).not.toMatch(/\bgrant\b/i);
    expect(migration.match(/\brevoke\b/gi)).toHaveLength(1);
    expect(migration).toContain(`revoke all on function ${ACTOR}(uuid,text,uuid)\n  from public, anon, authenticated, service_role;`);
    expect(sourceTransactionProblem(migration)).toBeNull();
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    expect(contract.functions.find(({ sig }) => sig === `${NAME}(p_task_id uuid)`).sourceMd5)
      .toBe(md5(source(fnBody(migration, NAME))));
    const unreachable = JSON.parse(readFileSync(new URL("../config/non-interference/unreachable.json", import.meta.url), "utf8"));
    expect(unreachable.functions["list_task_checkoff_candidates(p_task_id uuid)"].authenticated)
      .toEqual(["42501 not authorized", "55000 member check-off lists are turned off"]);
    expect(PROOF_FILES).toContain("tests/unit-steward-checkoff-candidates-db.test.js");
  });

  it("filters existing-list entries by the canonical member rule without widening organization stewards", () => {
    const body = source(fnBody(loadMigrationSql(STEM), PAYLOAD));
    expect(body).toContain("private.caller_unit_limited_in_chapter(access_scope.chapter_id)");
    expect(body).toContain("private.chapter_organization_role_allowed(access_scope.chapter_id,");
    expect(body).toContain("visible_members as materialized (");
    expect(body).toContain("select private.staff_visible_member_ids(readable_role)");
    expect(body).toContain("or e.member_user_id in (select member_id from visible_members)");
    expect(body).not.toMatch(/caller_may_see_member|staff_can_see_user|chapter_staff_member_allowed/);
    expect(body.slice(body.indexOf("\n  select case"), body.indexOf("where e.task_id = l.task_id"))).toBe(
      source(originals[PAYLOAD]).slice(0, source(originals[PAYLOAD]).indexOf("where e.task_id = l.task_id")),
    );
    // The public getter continues through the shared payload: no extra response
    // field, no second task-level ACL, and no lost PIN/MFA/feature behavior.
    expect(loadMigrationSql(STEM)).not.toMatch(/create or replace function public\.get_task_checkoff_list/);
  });

  it("refuses hidden/nonmember ids before list, activity or learning writes while preserving the newest creator", () => {
    const body = source(fnBody(loadMigrationSql(STEM), CREATOR));
    expect(helperFirst(body)).toBe(true);
    for (const name of [NAME, CREATOR]) {
      const code = codeOnly(source(fnBody(loadMigrationSql(STEM), name)));
      expect(code.slice(0, code.indexOf("begin"))).not.toMatch(/:=|\bdefault\b/);
      const entry = code.slice(code.indexOf("begin") + 5).trimStart()
        .replace(/^perform private\.lock_case_graph\([^;]*;\s*/, "");
      expect(entry).toMatch(/^perform private\.member_pin_require_full_session\(\);/);
    }
    expect(body.indexOf("assignments := '{}'::jsonb;")).toBeGreaterThan(body.indexOf("private.member_pin_require_full_session()"));
    expect(body.indexOf("assignments := '{}'::jsonb;")).toBeGreaterThan(body.indexOf("member check-off lists are turned off"));
    const firstWrite = body.indexOf("insert into private.task_checkoff_lists");
    expect(body.indexOf("cm.user_id = any(caller_visible_members)")).toBeLessThan(firstWrite);
    expect(body.indexOf("into steward_eligible")).toBeLessThan(body.indexOf("foreach next_member"));
    expect(body).not.toMatch(/private\.(caller_may_see_member|task_checkoff_actor_can_see_member)\(/);
    expect(body.indexOf("if member_scope_limited then")).toBeLessThan(firstWrite);
    expect(body).toContain("raise exception 'not authorized' using errcode = '42501';");
    expect(body).toContain("private.chapter_organization_role_allowed(scope.chapter_id,");
    for (const needle of ["private.lock_case_graph(", "private.member_pin_require_full_session()", "private.learning_checkoff_journal(", "private.learning_journal_append("])
      expect(body).toContain(needle);
  });

  it("guards all four newest predecessors and pins all three replacement sources plus the unchanged getter", () => {
    const migration = loadMigrationSql(STEM);
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    for (const [name, original] of Object.entries(originals)) {
      expect(migration).toContain(md5(source(original)));
      expect(migration).toContain(`pg_catalog.to_regprocedure('${name}(${signatures[name]})')`);
      const entry = contract.functions.find(({ sig }) => sig.startsWith(`${name}(`));
      expect(entry.sourceMd5).toBe(md5(source(name === GETTER ? original : fnBody(migration, name))));
    }
  });

  it("evaluates broad grants once and pins an actor-based private check before every assignment write", () => {
    const sql = loadMigrationSql(STEM);
    expect(source(fnBody(sql, NAME))).toContain(broadSetup);
    const payload = source(fnBody(sql, PAYLOAD));
    expect(payload).toContain("with access_scope as materialized (");
    expect(payload).toContain("from private.task_checkoff_lists access_scope where access_scope.task_id = p_task_id");
    expect(payload).toContain("cross join access_scope where not broad_roster");
    const actor = fnBody(sql, ACTOR);
    expect(actor).toMatch(/stable\nsecurity definer\nset search_path = ''/);
    expect(source(actor)).not.toMatch(/auth\.uid|set_config|current_member_organization/);
    // #9454 round 1 (r1s1/r2s1): carry-over scopes count, as in the canonical
    // chapter_scoped_member_ids, in both the helper and the creator's cache.
    expect(actor).toContain("and (assignment.legacy_chapter_coverage");
    expect(actor).not.toMatch(/not assignment\.legacy_chapter_coverage/);
    expect(source(fnBody(sql, CREATOR))).toContain("where assignment.legacy_chapter_coverage");
    expect(source(fnBody(sql, CREATOR))).not.toMatch(/not assignment\.legacy_chapter_coverage/);
    expect(actor).toContain("target_context.organization_id = chapter.organization_id");
    expect(actor).toContain("scope_chapter.organization_id = chapter.organization_id");
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    expect(contract.functions.find(({ sig }) => sig.startsWith(`${ACTOR}(`))).toMatchObject({ exec: "", secdef: true, sourceMd5: md5(source(actor)) });
    const creator = source(fnBody(sql, CREATOR));
    expect(creator.indexOf("checkoff:assignment_scope")).toBeLessThan(creator.indexOf("insert into private.task_checkoff_lists"));
    expect(creator).toContain("assignment_counts[candidate.position::integer]");
  });
});

// The offline database checks the real migration guard/metadata/ACL, without
// pretending that a reduced schema proves the product's authorization helpers.
describe("check-off predecessor guard on socket-only PostgreSQL", () => {
  let database;
  let db;
  beforeAll(async () => {
    database = await offlinePostgres();
    db = database.client;
    await db.query("create role authenticated; create role anon; create role service_role");
    // SQL-language functions resolve relation/function types at CREATE time.
    // These signatures only allow the real payload to compile; this metadata
    // suite never invokes them or treats them as an authorization proof.
    await db.query(`create schema private; create schema auth;
      create table private.task_checkoff_lists(task_id uuid,chapter_id text,assignment_mode text,status text,created_by uuid,created_at timestamptz);
      create table private.task_checkoff_entries(id uuid,task_id uuid,member_user_id uuid,assigned_steward_id uuid,status text,note text,actioned_by uuid,actioned_at timestamptz,position integer);
      create table public.member_profiles(id uuid,full_name text,chapter_id text);
      create table public.chapters(id text,organization_id uuid);
      create table public.organizations(id uuid,status text);
      create table public.organization_memberships(organization_id uuid,user_id uuid,status text);
      create table public.member_chapter_memberships(chapter_id text,user_id uuid,status text);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create function private.has_organization_role(uuid,text[]) returns boolean language sql as $$select false$$;
      create function private.member_has_chapter_role(text,text[]) returns boolean language sql as $$select false$$;
      create function private.chapter_organization_role_allowed(text,text[]) returns boolean language sql as $$select false$$;
      create function private.caller_unit_limited_in_chapter(text) returns boolean language sql as $$select false$$;
      create function private.caller_may_see_member(uuid) returns boolean language sql as $$select false$$;
      create function private.staff_visible_member_ids(text) returns setof uuid language sql as $$select null::uuid where false$$;
      create function private.actor_has_chapter_staff_role(uuid,text) returns boolean language sql as $$select false$$;
      create function private.actor_role_covers_member(uuid,text,text,uuid,boolean) returns boolean language sql as $$select false$$;
      create function private.steward_assignment_scopes(uuid,text) returns table(chapter_id text,role text,unit_id uuid,committee_id uuid,legacy_chapter_coverage boolean)
        language sql as $$select null::text,null::text,null::uuid,null::uuid,false where false$$;
      create table public.organization_role_grants(organization_id uuid,user_id uuid,role text);
      create table private.chapter_committees(id uuid,chapter_id text,starts_on date,ends_on date);
      create table private.chapter_committee_members(committee_id uuid,chapter_id text,user_id uuid);
      create function private.chapter_unit_member_ids(uuid,text) returns setof uuid language sql as $$select null::uuid where false$$;
      create function private.staff_mfa_required(uuid) returns boolean language sql as $$select false$$;
      create function private.has_second_factor(uuid) returns boolean language sql as $$select false$$;
      create function private.eastern_day() returns date language sql as $$select current_date$$;`);
    for (const [name, original] of Object.entries(originals)) {
      await db.query(original);
      await db.query(`revoke all on function ${name}(${signatures[name]}) from public,anon,authenticated,service_role`);
      if (name.startsWith("public.")) await db.query(`grant execute on function ${name}(${signatures[name]}) to authenticated`);
    }
  }, 120_000);
  afterAll(async () => { await database?.close(); });

  const metadata = async () => (await db.query(`select oid,proacl::text,prosecdef,provolatile,proconfig,prorettype,proargnames
    from pg_catalog.pg_proc where oid=any($1::regprocedure[]) order by oid`,
  [Object.keys(originals).map((name) => `${name}(${signatures[name]})`)])).rows;

  it("accepts the original and preserves signature, stability, security mode, search path and ACL", async () => {
    const before = await metadata();
    await db.query(loadMigrationSql(STEM));
    expect(await metadata()).toEqual(before);
    expect((await db.query(`select pg_catalog.md5(prosrc) digest,prosecdef,provolatile,proconfig
      from pg_catalog.pg_proc where oid='${ACTOR}(uuid,text,uuid)'::regprocedure`)).rows[0]).toEqual({
      digest: md5(source(fnBody(loadMigrationSql(STEM), ACTOR))), prosecdef: true, provolatile: "s", proconfig: ['search_path=""'],
    });
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await db.query(`select has_function_privilege($1,'${ACTOR}(uuid,text,uuid)','execute') v`, [role])).rows[0].v).toBe(false);
    }
    expect((await db.query(`select count(*)::int n from pg_catalog.pg_proc p cross join lateral pg_catalog.aclexplode(p.proacl) acl
      where p.oid='${ACTOR}(uuid,text,uuid)'::regprocedure and acl.grantee=0`)).rows[0].n).toBe(0);
    for (const [name, original] of Object.entries(originals)) {
      const body = (await db.query("select prosrc from pg_catalog.pg_proc where oid=$1::regprocedure", [`${name}(${signatures[name]})`])).rows[0].prosrc;
      expect(body).toBe(source(name === GETTER ? original : fnBody(loadMigrationSql(STEM), name)));
      await db.query(original.replace(/^create function/, "create or replace function"));
    }
    await db.query(`drop function ${ACTOR}(uuid,text,uuid)`);
  });

  it.each(
    Object.keys(originals).flatMap((name) => ["body", "missing", "security", "path", "volatility"].map((kind) => [name, kind])),
  )("refuses %s %s drift before replacement", async (name, kind) => {
    await db.query("begin");
    try {
      const sig = `${name}(${signatures[name]})`;
      if (kind === "body") await db.query(originals[name].replace(/^create function/, "create or replace function").replace("as $function$", "as $function$\n-- Unreviewed body drift."));
      if (kind === "missing") await db.query(`drop function ${sig}`);
      if (kind === "security") await db.query(`alter function ${sig} security invoker`);
      if (kind === "path") await db.query(`alter function ${sig} set search_path = public`);
      if (kind === "volatility") await db.query(`alter function ${sig} ${name === CREATOR ? "stable" : "volatile"}`);
      await expect(db.query(loadMigrationSql(STEM))).rejects.toMatchObject({ code: "55000", message: `unreviewed ${name} predecessor` });
    } finally {
      await db.query("rollback");
    }
  });

  it("refuses an already-existing unreviewed actor helper", async () => {
    await db.query(`create function ${ACTOR}(uuid,text,uuid) returns boolean language sql as $$select false$$`);
    await expect(db.query(loadMigrationSql(STEM))).rejects.toMatchObject({ code: "55000", message: `unreviewed ${ACTOR} already exists` });
    await db.query("rollback");
    await db.query(`drop function ${ACTOR}(uuid,text,uuid)`);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("check-off candidates with real caller scopes on an owned disposable database", () => {
  let db;
  const people = ["admin", "vp", "coordinator", "advisor", "chapterAdmin", "wide", "unitSteward", "own", "other", "secondary", "foreign"];
  const f = Object.fromEntries([...people, ...people.map((key) => `${key}Session`), "org", "foreignOrg", "unitA", "unitB"].map((key) => [key, randomUUID()]));
  const chapter = `checkoff-${f.org}`;
  const foreignChapter = `checkoff-${f.foreignOrg}`;
  let task;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (key) => {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f[key], session_id: f[`${key}Session`], role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  };
  const candidates = async (key) => {
    await as(key);
    const rows = (await db.query(`select ${NAME}($1) v`, [task])).rows[0].v.members;
    await owner();
    return rows;
  };
  const keys = (rows) => rows.map(({ id }) => people.find((key) => f[key] === id)).sort();
  const listedKeys = (payload) => keys(payload.list.entries.map(({ memberUserId }) => ({ id: memberUserId })));
  const rosterIds = () => people.filter((key) => key !== "foreign").map((key) => f[key]);
  const getList = async (key, target = task) => {
    await as(key);
    const value = (await db.query(`select ${GETTER}($1) v`, [target])).rows[0].v;
    await owner();
    return value;
  };
  const createList = async (key, memberIds, target = task) => {
    await as(key);
    const value = (await db.query(`select ${CREATOR}($1,'shared',$2::uuid[],array[]::uuid[],null) v`, [target, memberIds])).rows[0].v;
    await owner();
    return value;
  };
  const newTask = async () => {
    await as("admin");
    await db.query("reset role");
    const id = (await db.query("insert into public.chapter_tasks(chapter_id,title,created_by,updated_by,workstream) values($1,'Fictional outreach',$2,$2,'General') returning id", [chapter, f.admin])).rows[0].id;
    await owner();
    return id;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "unit-steward-checkoff-rollback-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await releaseCalendarHolds(db);
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Quarry'),($2::uuid,$2::text,'Fictional Ridge')", [f.org, f.foreignOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9970),($3,$3,$3,$4,9971)", [chapter, f.org, foreignChapter, f.foreignOrg]);
    for (const key of people) {
      const ch = key === "foreign" ? foreignChapter : chapter;
      const org = key === "foreign" ? f.foreignOrg : f.org;
      await db.query("insert into auth.users(id,email) values($1,$2)", [f[key], `${f[key]}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [f[key], ch, `Fictional ${key}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [f[`${key}Session`], f[key]]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), f[key]]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, f[key]]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f[key], ch]);
    }
    // Broad staff previously included active secondary chapter memberships;
    // the per-member oracle follows the selected profile chapter instead.
    const secondChapter = `secondary-${f.org}`;
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9972)", [secondChapter, f.org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.secondary, secondChapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.secondary, secondChapter]);
    for (const [key, role] of [["unitSteward", "steward"], ["wide", "steward"], ["coordinator", "coordinator"], ["advisor", "advisor"], ["chapterAdmin", "admin"]]) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [f[key], role, chapter]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [f[key], role, chapter]);
    }
    for (const role of ["admin", "vp"]) await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)", [f.org, f[role], role]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Shop A'),($2,$3,$4,'Shop B')", [f.unitA, f.unitB, f.org, chapter]);
    await migrateLegacyStewardFixtures(db);
    await as("admin");
    for (const [key, unit] of [["unitSteward", f.unitA], ["own", f.unitA], ["other", f.unitB]]) {
      await db.query("select public.set_chapter_access_member($1,$2,$3,null,true)", [chapter, f[key], unit]);
    }
    await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.unitSteward, chapter, f.unitA]);
    await owner();
    const scopes = (await db.query("select user_id,unit_id,legacy_chapter_coverage from private.chapter_role_scopes where chapter_id=$1 and role='steward'", [chapter])).rows;
    expect(scopes.find(({ user_id }) => user_id === f.unitSteward)).toMatchObject({ unit_id: f.unitA, legacy_chapter_coverage: false });
    expect(scopes.find(({ user_id }) => user_id === f.wide)).toMatchObject({ legacy_chapter_coverage: true });
    await db.query("insert into public.organization_setting_values(organization_id,setting_key,value) values($1,'features.tasks.coop_checkoff_lists','true'::jsonb) on conflict(organization_id,setting_key) do update set value=excluded.value", [f.org]);
    await db.query("insert into public.chapter_workstreams(chapter_id,name) values($1,'General') on conflict do nothing", [chapter]);
    // Direct client INSERT was retired by learning-period tasks. Seed as the
    // fixture owner while retaining the creator claims required by triggers.
    task = await newTask();
    // The broader steward's list deliberately contains all ten chapter members,
    // rather than letting the unit caller's own creation hide the read defect.
    expect(listedKeys(await createList("wide", rosterIds()))).toHaveLength(10);
  }, 120_000);
  afterAll(async () => { if (db) { try { await db.query("rollback"); } finally { await db.end(); } } });

  it("includes own-unit members and excludes other-unit names and ids", async () => {
    const rows = await candidates("unitSteward");
    expect(keys(rows)).toEqual(["own", "unitSteward"]);
    expect(rows.find(({ id }) => id === f.unitSteward).steward).toBe(true);
    expect(rows.find(({ id }) => id === f.own).steward).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(f.other);
    expect(JSON.stringify(rows)).not.toContain("Fictional other");
    await as("unitSteward");
    expect((await db.query("select public.staff_can_see_user($1,'steward') own, public.staff_can_see_user($2,'steward') other", [f.own, f.other])).rows[0]).toEqual({ own: true, other: false });
    await owner();
  });

  it("reproduces the original unit-steward leak with the same fixtures before the repaired answer", async () => {
    const after = await candidates("unitSteward");
    await db.query("savepoint original_unit_answer");
    try {
      await db.query(predecessor.replace("create function", "create or replace function"));
      const before = await candidates("unitSteward");
      expect(keys(before)).toEqual(people.filter((person) => person !== "foreign").sort());
      expect(keys(before)).toContain("other");
    } finally {
      await owner();
      await db.query("rollback to savepoint original_unit_answer");
      await db.query("release savepoint original_unit_answer");
    }
    expect(keys(after)).toEqual(["own", "unitSteward"]);
  });

  it.each(["wide", "coordinator", "advisor", "chapterAdmin", "admin", "vp"])("preserves %s's exact predecessor answer", async (key) => {
    const after = await candidates(key);
    expect(keys(after)).toEqual(people.filter((person) => person !== "foreign").sort());
    await db.query("savepoint predecessor_answer");
    try {
      await db.query(predecessor.replace("create function", "create or replace function"));
      expect(await candidates(key)).toEqual(after);
    } finally {
      await owner();
      await db.query("rollback to savepoint predecessor_answer");
      await db.query("release savepoint predecessor_answer");
    }
  });

  it("never includes a foreign member and refuses a foreign caller", async () => {
    for (const key of ["unitSteward", "admin"]) expect(keys(await candidates(key))).not.toContain("foreign");
    await db.query("savepoint foreign_refusal");
    await as("foreign");
    await expect(db.query(`select ${NAME}($1)`, [task])).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint foreign_refusal");
    await owner();
    await db.query("release savepoint foreign_refusal");
  });

  it("shows only two admitted entries from a broader steward's ten-member list", async () => {
    const after = await getList("unitSteward");
    expect(listedKeys(after)).toEqual(["own", "unitSteward"]);
    expect(JSON.stringify(after)).not.toContain(f.other);
    expect(JSON.stringify(after)).not.toContain("Fictional other");
    await db.query("savepoint original_payload");
    try {
      await db.query(originals[PAYLOAD].replace("create function", "create or replace function"));
      expect(listedKeys(await getList("unitSteward"))).toHaveLength(10);
    } finally {
      await owner();
      await db.query("rollback to savepoint original_payload");
      await db.query("release savepoint original_payload");
    }
  });

  it("matches the old member set for two steward units with an overlapping member", async () => {
    await db.query("savepoint overlapping_units");
    try {
      // One steward assignment per chapter is the real product constraint.
      // Give this steward a second chapter/unit; own belongs to both units.
      const secondChapter = `secondary-${f.org}`;
      const secondUnit = randomUUID();
      await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Second steward unit')",
        [secondUnit, f.org, secondChapter]);
      for (const key of ["unitSteward", "own", "other"]) {
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
          [f[key], secondChapter]);
      }
      await as("admin");
      for (const key of ["unitSteward", "own", "other", "secondary"]) {
        await db.query("select public.set_chapter_access_member($1,$2,$3,null,true)",
          [secondChapter, f[key], secondUnit]);
      }
      await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)",
        [f.unitSteward, secondChapter, secondUnit]);
      await owner();
      expect((await db.query(`select count(*)::int n from private.steward_assignment_scopes($1,null)
        where role='steward' and not legacy_chapter_coverage`, [f.unitSteward])).rows[0].n).toBe(2);
      expect((await db.query(`select count(*)::int n from private.chapter_unit_members
        where user_id=$1 and unit_id=any($2::uuid[])`, [f.own, [f.unitA, secondUnit]])).rows[0].n).toBe(2);
      await as("unitSteward");
      // The unchanged scalar predicate is the previous payload's oracle.
      await db.query("reset role");
      const oldSet = keys((await db.query(`select e.member_user_id id from private.task_checkoff_entries e
        where e.task_id=$1 and private.caller_may_see_member(e.member_user_id)`, [task])).rows);
      expect(oldSet).toEqual(["other", "own", "secondary", "unitSteward"]);
      await owner();
      const actual = listedKeys(await getList("unitSteward"));
      expect(actual).toEqual(oldSet);
      expect(actual.filter((key) => key === "own")).toHaveLength(1);
      expect(actual).not.toContain("wide");
      expect(actual).not.toContain("foreign");
    } finally {
      await owner();
      await db.query("rollback to savepoint overlapping_units");
      await db.query("release savepoint overlapping_units");
    }
  });

  it.each(["wide", "coordinator", "advisor", "chapterAdmin", "admin", "vp"])("preserves %s's exact existing-list JSON", async (key) => {
    const after = await getList(key);
    expect(listedKeys(after)).toHaveLength(10);
    await db.query("savepoint broad_payload");
    try {
      await db.query(originals[PAYLOAD].replace("create function", "create or replace function"));
      expect(await getList(key)).toEqual(after);
    } finally {
      await owner();
      await db.query("rollback to savepoint broad_payload");
      await db.query("release savepoint broad_payload");
    }
  });

  it("allows the unit steward to create a list containing only admitted members", async () => {
    await db.query("savepoint allowed_create");
    try {
      const target = await newTask();
      expect(listedKeys(await createList("unitSteward", [f.own, f.unitSteward], target))).toEqual(["own", "unitSteward"]);
    } finally {
      await owner();
      await db.query("rollback to savepoint allowed_create");
      await db.query("release savepoint allowed_create");
    }
  });

  // This snapshot proves rollback state only; static ordering above proves
  // authorization precedes writes. A failed statement would roll back writes.
  it.each(["other", "foreign", "nonexistent"])("refuses %s with 42501 and retains the rollback state", async (member) => {
    const target = await newTask();
    const snapshot = async () => (await db.query(`select
      (select count(*) from private.task_checkoff_lists where task_id=$1) lists,
      (select count(*) from private.task_checkoff_entries where task_id=$1) entries,
      (select count(*) from public.chapter_task_activity where task_id=$1) activity,
      (select count(*) from private.learning_action_journal) journal`, [target])).rows[0];
    const before = await snapshot();
    await db.query("savepoint denied_create");
    let denied;
    try {
      await createList("unitSteward", [f.own, member === "nonexistent" ? randomUUID() : f[member]], target);
    } catch (error) {
      denied = { code: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint denied_create");
      await owner();
      await db.query("release savepoint denied_create");
    }
    expect(denied).toEqual({ code: "42501", message: "not authorized" });
    expect(await snapshot()).toEqual(before);
  });

  it.each(["wide", "coordinator", "advisor", "chapterAdmin", "admin", "vp"])("preserves %s's broader list creation and legacy invalid-member error", async (key) => {
    const target = await newTask();
    const withoutGeneratedIds = (value) => ({ ...value, list: {
      ...value.list, entries: value.list.entries.map((entry) => { const copy = { ...entry }; delete copy.id; return copy; }),
    } });
    await db.query("savepoint repaired_creation");
    const after = await createList(key, rosterIds(), target);
    expect(listedKeys(after)).toHaveLength(10);
    await db.query("rollback to savepoint repaired_creation");
    await db.query("release savepoint repaired_creation");
    await db.query("savepoint original_creation");
    try {
      await db.query(originals[CREATOR]);
      expect(withoutGeneratedIds(await createList(key, rosterIds(), target))).toEqual(withoutGeneratedIds(after));
    } finally {
      await owner();
      await db.query("rollback to savepoint original_creation");
      await db.query("release savepoint original_creation");
    }
    await db.query("savepoint broad_invalid");
    let denied;
    try { await createList(key, [randomUUID()], target); }
    catch (error) { denied = { code: error.code, message: error.message }; }
    finally {
      await db.query("rollback to savepoint broad_invalid");
      await owner();
      await db.query("release savepoint broad_invalid");
    }
    expect(denied).toEqual({ code: "22023", message: "one or more members are not active in this chapter" });
  });

  it("still refuses the foreign caller an existing list", async () => {
    await db.query("savepoint foreign_list");
    await as("foreign");
    await expect(db.query(`select ${GETTER}($1)`, [task])).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint foreign_list");
    await owner();
    await db.query("release savepoint foreign_list");
  });

  it("does not let a raw organization steward grant bypass the explicit unit assignment", async () => {
    await db.query("savepoint organization_steward");
    try {
      // Represent the historical organization grant with its real migration
      // backfill, then narrow both chapters through the current product RPCs.
      // The backfill also preserves authority in the secondary member's
      // selected chapter; narrowing only the main chapter leaves that valid.
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')", [f.org, f.unitSteward]);
      await migrateLegacyStewardFixtures(db);
      await as("unitSteward");
      expect((await db.query("select public.staff_can_see_user($1,'steward') v", [f.secondary])).rows[0].v).toBe(true);
      const secondaryChapter = `secondary-${f.org}`;
      const emptyUnitName = "Fictional empty secondary scope";
      await as("admin");
      await db.query("select public.save_chapter_unit(null,$1,$2,'unit',null)", [secondaryChapter, emptyUnitName]);
      await owner();
      const emptyUnit = (await db.query("select id from private.chapter_units where chapter_id=$1 and name=$2", [secondaryChapter, emptyUnitName])).rows[0].id;
      await as("admin");
      await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.unitSteward, chapter, f.unitA]);
      await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.unitSteward, secondaryChapter, emptyUnit]);
      await owner();
      expect((await db.query(`select chapter_id,unit_id,legacy_chapter_coverage
        from private.steward_assignment_scopes($1,null) where role='steward' order by chapter_id`, [f.unitSteward])).rows).toEqual([
        { chapter_id: chapter, unit_id: f.unitA, legacy_chapter_coverage: false },
        { chapter_id: secondaryChapter, unit_id: emptyUnit, legacy_chapter_coverage: false },
      ]);
      await as("unitSteward");
      expect((await db.query(`select public.staff_can_see_user($1,'steward') own,
        public.staff_can_see_user($2,'steward') other, public.staff_can_see_user($3,'steward') secondary`,
      [f.own, f.other, f.secondary])).rows[0]).toEqual({ own: true, other: false, secondary: false });
      await owner();
      expect(keys(await candidates("unitSteward"))).toEqual(["own", "unitSteward"]);
      expect(listedKeys(await getList("unitSteward"))).toEqual(["own", "unitSteward"]);
      await db.query("savepoint organization_hidden_create");
      await as("unitSteward");
      await expect(db.query(`select ${CREATOR}($1,'shared',$2::uuid[],array[]::uuid[],null)`, [task, [f.other]]))
        .rejects.toMatchObject({ code: "42501", message: "not authorized" });
      await db.query("rollback to savepoint organization_hidden_create");
      await owner();
      await db.query("release savepoint organization_hidden_create");
    } finally {
      await owner();
      await db.query("rollback to savepoint organization_steward");
      await db.query("release savepoint organization_steward");
    }
  });

  const assignedList = async (mode, memberIds, stewardIds, manual, target) => {
    await as("admin");
    const value = (await db.query(`select ${CREATOR}($1,$2,$3::uuid[],$4::uuid[],$5::jsonb) v`,
      [target, mode, memberIds, stewardIds, JSON.stringify(manual)])).rows[0].v;
    await owner();
    return value;
  };

  it.each(["manual", "split_even", "split_random"])("refuses %s assigning a unit-B member solely to the unit-A steward", async (mode) => {
    const target = await newTask();
    await db.query("savepoint invalid_assignment");
    let error;
    try { await assignedList(mode, [f.other], [f.unitSteward], { [f.other]: f.unitSteward }, target); }
    catch (failure) { error = failure; }
    finally {
      await db.query("rollback to savepoint invalid_assignment"); await owner(); await db.query("release savepoint invalid_assignment");
    }
    expect(error?.code).toBe("22023");
    expect(error?.message).toMatch(/^checkoff:assignment_scope:/);
  });

  it.each(["manual", "split_even", "split_random"])("keeps every %s assignment visible to its actual steward", async (mode) => {
    await db.query("savepoint valid_assignment");
    try {
      const target = await newTask();
      const result = await assignedList(mode, [f.own, f.other, f.unitSteward], [f.unitSteward, f.wide],
        { [f.own]: f.unitSteward, [f.other]: f.wide, [f.unitSteward]: f.unitSteward }, target);
      expect(result.list.entries).toHaveLength(3);
      expect(result.list.entries.find(({ memberUserId }) => memberUserId === f.other).assignedStewardId).toBe(f.wide);
      for (const entry of result.list.entries.filter(({ assignedStewardId }) => assignedStewardId === f.unitSteward))
        expect([f.own, f.unitSteward]).toContain(entry.memberUserId);
      const ownView = await getList("unitSteward", target);
      const ownEntryIds = ownView.list.entries.map(({ id }) => id);
      const assigned = result.list.entries.filter(({ assignedStewardId }) => assignedStewardId === f.unitSteward);
      expect(assigned.length).toBeGreaterThan(0);
      for (const entry of assigned) expect(ownEntryIds).toContain(entry.id);
    } finally {
      await owner(); await db.query("rollback to savepoint valid_assignment"); await db.query("release savepoint valid_assignment");
    }
  });

  it("includes and flags a steward whose personal unit differs from their assigned unit", async () => {
    await db.query("savepoint cross_unit_self");
    try {
      await as("admin");
      await db.query("select public.set_chapter_access_member($1,$2,$3,null,true)", [chapter, f.unitSteward, f.unitB]);
      await owner();
      const scope = (await db.query("select unit_id,legacy_chapter_coverage from private.chapter_role_scopes where user_id=$1 and chapter_id=$2 and role='steward'", [f.unitSteward, chapter])).rows[0];
      expect(scope).toEqual({ unit_id: f.unitA, legacy_chapter_coverage: false });
      const rows = await candidates("unitSteward");
      expect(keys(rows)).toEqual(["own", "unitSteward"]);
      expect(rows.find(({ id }) => id === f.unitSteward).steward).toBe(true);
      const target = await newTask();
      await as("unitSteward");
      const saved = (await db.query(`select ${CREATOR}($1,'split_even',$2::uuid[],$3::uuid[],'{}'::jsonb) v`,
        [target, [f.own, f.unitSteward], [f.unitSteward]])).rows[0].v;
      expect(listedKeys(saved)).toEqual(["own", "unitSteward"]);
      await owner();
    } finally {
      await owner(); await db.query("rollback to savepoint cross_unit_self"); await db.query("release savepoint cross_unit_self");
    }
  });

  // #9454 round 1: the creator and the scalar helper once shared an omission,
  // so every pair is also compared with the canonical set itself:
  // private.staff_visible_member_ids for the actor (claims only, owner role),
  // the set the actor's own getter filters by, plus self.
  const canonicalVisible = async (actorKey, member) => {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f[actorKey], session_id: f[`${actorKey}Session`], role: "authenticated", aal: "aal2" })]);
    const visible = (await db.query(`select $1::uuid = $2::uuid or $2::uuid in (
      select private.staff_visible_member_ids(role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) role) visible`,
    [f[actorKey], member])).rows[0].visible;
    await owner();
    return visible;
  };

  it("matches the canonical set and the scalar actor oracle pair by pair for unit, default, organization, committee, carry-over and other-chapter-role scopes", async () => {
    await db.query("savepoint eligibility_matrix");
    try {
      const defaultUnit = (await db.query("select id from private.chapter_units where chapter_id=$1 and is_default", [chapter])).rows[0].id;
      const committee = randomUUID();
      await db.query(`insert into private.chapter_committees(id,chapter_id,name,purpose,starts_on,ends_on)
        values($1,$2,'Fictional oracle committee','Assignment differential proof',private.eastern_day()-1,private.eastern_day()+1)`, [committee, chapter]);
      const secondChapter = `secondary-${f.org}`;
      for (const variant of ["chapter unit", "default unit", "organization unit", "committee", "carry-over in another chapter", "role in another chapter"]) {
        await db.query("savepoint eligibility_variant");
        try {
          let actor = f.unitSteward;
          let actorKey = "unitSteward";
          await as("admin");
          if (variant === "default unit") {
            await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [actor, chapter, defaultUnit]);
            await db.query("select public.set_chapter_access_member($1,$2,$3,null,false)", [chapter, f.secondary, defaultUnit]);
            await owner();
            expect((await db.query("select count(*)::int n from private.chapter_unit_members where chapter_id=$1 and user_id=$2", [chapter, f.secondary])).rows[0].n).toBe(0);
          } else if (variant === "organization unit") {
            // Remove the chapter grant first, then use the real migration to
            // create an organization-backed assignment and narrow its unit.
            await db.query("select public.set_member_access_role($1,$2,'steward',false,null,null)", [actor, chapter]);
            await owner();
            // Check this completed role removal before adding the historical
            // organization grant whose assignments the backfill will create.
            await db.query("set constraints all immediate");
            await db.query("set constraints all deferred");
            await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')", [f.org, actor]);
            await migrateLegacyStewardFixtures(db);
            await as("admin");
            await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [actor, chapter, f.unitA]);
            await owner();
            expect((await db.query(`select unit_id,legacy_chapter_coverage from private.organization_steward_unit_assignments
              where user_id=$1 and chapter_id=$2`, [actor, chapter])).rows[0])
              .toEqual({ unit_id: f.unitA, legacy_chapter_coverage: false });
          } else if (variant === "committee") {
            actor = f.coordinator;
            actorKey = "coordinator";
            await db.query("select public.set_chapter_access_member($1,$2,null,$3,true)", [chapter, f.own, committee]);
            await db.query("select public.set_member_access_role($1,$2,'coordinator',true,null,$3)", [actor, chapter, committee]);
          } else if (variant === "carry-over in another chapter") {
            // r1s1/r2s1: unit A in the task chapter plus a migrated carry-over
            // steward grant in a second chapter of the same organization, where
            // "other" (unit B, task chapter selected) is also an active member.
            await owner();
            await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$3,'active'),($2,$3,'active')", [actor, f.other, secondChapter]);
            await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2)", [actor, secondChapter]);
            await migrateLegacyStewardFixtures(db);
            expect((await db.query("select legacy_chapter_coverage from private.chapter_role_scopes where user_id=$1 and chapter_id=$2 and role='steward'", [actor, secondChapter])).rows)
              .toEqual([{ legacy_chapter_coverage: true }]);
            expect(await canonicalVisible(actorKey, f.other)).toBe(true);
          } else if (variant === "role in another chapter") {
            // r1s2: a chapter-wide coordinator grant in secondary's selected chapter.
            await owner();
            await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [actor, secondChapter]);
            await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [actor, secondChapter]);
            await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)", [actor, secondChapter]);
            expect(await canonicalVisible(actorKey, f.secondary)).toBe(true);
          }
          await owner();
          const target = await newTask();
          const outcomes = [];
          const canonicalMembers = [];
          for (const member of rosterIds()) {
            await as("admin"); await db.query("reset role");
            const expected = (await db.query(`select ${ACTOR}($1,$2,$3) allowed`, [actor, chapter, member])).rows[0].allowed;
            await owner();
            const canonical = await canonicalVisible(actorKey, member);
            expect(expected, `${variant}: helper vs canonical for ${member}`).toBe(canonical);
            if (canonical) canonicalMembers.push(member);
            await db.query("savepoint eligibility_pair");
            let accepted = false;
            try {
              const result = await assignedList("manual", [member], [actor], { [member]: actor }, target);
              expect(result.list.entries).toHaveLength(1);
              expect(result.list.entries[0]).toMatchObject({ memberUserId: member, assignedStewardId: actor });
              accepted = true;
            } catch (error) {
              expect(error.code, `${variant} ${member}: ${error.message}`).toBe("22023");
              expect(error.message).toMatch(/^checkoff:assignment_scope:/);
            } finally {
              await db.query("rollback to savepoint eligibility_pair"); await owner(); await db.query("release savepoint eligibility_pair");
            }
            expect(accepted, `${variant}: ${actor} -> ${member}`).toBe(expected);
            outcomes.push(accepted);
          }
          expect(outcomes).toContain(true);
          expect(outcomes).toContain(false);
          // The builder offers exactly the canonical members of the task chapter.
          expect(keys(await candidates(actorKey)), `${variant}: candidates`).toEqual(keys(canonicalMembers.map((id) => ({ id }))));
          if (variant === "carry-over in another chapter") {
            expect(canonicalMembers).toContain(f.other);
            for (const mode of ["split_even", "split_random"]) {
              await db.query("savepoint carry_over_split");
              try {
                const result = await assignedList(mode, [f.other], [actor], { [f.other]: actor }, target);
                expect(result.list.entries).toEqual([expect.objectContaining({ memberUserId: f.other, assignedStewardId: actor })]);
                expect(listedKeys(await getList(actorKey, target))).toEqual(["other"]);
              } finally {
                await db.query("rollback to savepoint carry_over_split"); await owner(); await db.query("release savepoint carry_over_split");
              }
            }
          }
          if (variant === "role in another chapter") expect(canonicalMembers).toContain(f.secondary);
        } finally {
          await owner(); await db.query("rollback to savepoint eligibility_variant"); await db.query("release savepoint eligibility_variant");
        }
      }
    } finally {
      await owner(); await db.query("rollback to savepoint eligibility_matrix"); await db.query("release savepoint eligibility_matrix");
    }
  });

  it("refuses a task assignment authorized only through a unit in another organization", async () => {
    await db.query("savepoint two_organization_assignment");
    try {
      const unit = randomUUID();
      for (const key of ["unitSteward", "other"]) {
        await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.foreignOrg, f[key]]);
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f[key], foreignChapter]);
      }
      await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Foreign assigned unit')", [unit, f.foreignOrg, foreignChapter]);
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.foreignOrg, f.foreign]);
      await as("foreign");
      for (const key of ["unitSteward", "other"]) {
        await db.query("select public.set_chapter_access_member($1,$2,$3,null,true)", [foreignChapter, f[key], unit]);
      }
      await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.unitSteward, foreignChapter, unit]);
      await as("unitSteward");
      await db.query("reset role");
      expect((await db.query(`select private.actor_role_covers_member($1,$2,'steward',$3,false) foreign_authority,
        private.caller_may_see_member($3) visible, ${ACTOR}($1,$4,$3) assignable`,
      [f.unitSteward, foreignChapter, f.other, chapter])).rows[0]).toEqual({ foreign_authority: true, visible: false, assignable: false });
      await owner();
      const target = await newTask();
      await db.query("savepoint denied_foreign_assignment");
      let denied;
      try { await assignedList("manual", [f.other], [f.unitSteward], { [f.other]: f.unitSteward }, target); }
      catch (error) { denied = error; }
      finally {
        await db.query("rollback to savepoint denied_foreign_assignment"); await owner(); await db.query("release savepoint denied_foreign_assignment");
      }
      expect(denied?.code).toBe("22023");
      expect(denied?.message).toMatch(/^checkoff:assignment_scope:/);
      expect(listedKeys(await getList("unitSteward"))).toEqual(["own", "unitSteward"]);
    } finally {
      await owner(); await db.query("rollback to savepoint two_organization_assignment"); await db.query("release savepoint two_organization_assignment");
    }
  });

  it("checks the passed actor independently of the caller's JWT and refuses foreign targets", async () => {
    await as("admin"); await db.query("reset role");
    expect((await db.query(`select ${ACTOR}($1,$2,$3) own,${ACTOR}($1,$2,$4) other,${ACTOR}($1,$2,$1) self,${ACTOR}($1,$2,$5) foreign_member`,
      [f.unitSteward, chapter, f.own, f.other, f.foreign])).rows[0]).toEqual({ own: true, other: false, self: true, foreign_member: false });
    await as("unitSteward"); await db.query("reset role");
    expect((await db.query(`select ${ACTOR}($1,$2,$3) broad`, [f.wide, chapter, f.other])).rows[0].broad).toBe(true);
    await owner();
  });

  it.each(["manual", "split_even"])("preserves the original %s distribution for broad assignees", async (mode) => {
    const target = await newTask();
    const members = [f.own, f.other, f.unitSteward, f.secondary];
    const manual = { [f.own]: f.wide, [f.other]: f.coordinator, [f.unitSteward]: f.wide, [f.secondary]: f.coordinator };
    const withoutIds = (value) => ({ ...value, list: { ...value.list, entries: value.list.entries.map((entry) => {
      const copy = { ...entry }; delete copy.id; return copy;
    }) } });
    await db.query("savepoint broad_distribution");
    const repaired = await assignedList(mode, members, [f.wide, f.coordinator], manual, target);
    await db.query("rollback to savepoint broad_distribution"); await db.query("release savepoint broad_distribution");
    await db.query("savepoint original_distribution");
    try {
      await db.query(originals[CREATOR]);
      expect(withoutIds(await assignedList(mode, members, [f.wide, f.coordinator], manual, target))).toEqual(withoutIds(repaired));
    } finally {
      await owner(); await db.query("rollback to savepoint original_distribution"); await db.query("release savepoint original_distribution");
    }
  });

  it("retains an assignee's independently granted authority in the member's selected chapter", async () => {
    await db.query("savepoint other_chapter_authority");
    try {
      const selected = (await db.query("select chapter_id from public.member_profiles where id=$1", [f.secondary])).rows[0].chapter_id;
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [f.unitSteward, selected]);
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.unitSteward, selected]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'coordinator',$2)", [f.unitSteward, selected]);
      await as("unitSteward");
      expect((await db.query("select public.staff_can_see_user($1,'coordinator') visible", [f.secondary])).rows[0].visible).toBe(true);
      await owner();
      expect((await db.query(`select ${ACTOR}($1,$2,$3) visible`, [f.unitSteward, chapter, f.secondary])).rows[0].visible).toBe(true);
      await owner();
      const target = await newTask();
      await assignedList("manual", [f.secondary], [f.unitSteward], { [f.secondary]: f.unitSteward }, target);
      expect(listedKeys(await getList("unitSteward", target))).toEqual(["secondary"]);
      // r1s2: the builder offers the same member the creator accepts.
      expect(keys(await candidates("unitSteward"))).toContain("secondary");
    } finally {
      await owner(); await db.query("rollback to savepoint other_chapter_authority"); await db.query("release savepoint other_chapter_authority");
    }
  });
});
