// @vitest-environment node
//
// SEC-UG-UNIT-STEWARD-OPENS-CHAPTER-WIDE-VOTE-CAMPAIGNS-20261115 (#8941)
//
// A steward limited to one unit (#7663) may not create, edit, open, close or
// delete a chapter-wide ballot or pulse, and the staff campaign list shows them
// none they could not manage. Chapter leadership, chapter-wide staff and
// carry-over stewards keep what they have. A refusal for a campaign the caller
// may not manage reads exactly like a missing campaign. The staff registry
// also answers canManageChapter, so the web page offers a unit-limited steward
// no chapter-wide authoring (record #8950's work, gate finding r1s1).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("vote_campaign_scope_honours_unit_limit");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const definitionOf = (source, name) => {
  const start = source.search(new RegExp(`create or replace function ${name.replace(".", "\\.")}\\(`, "i"));
  if (start < 0) return null;
  const end = source.indexOf("$function$;", start);
  return source.slice(start, end + "$function$".length) + "\n";
};
const PREDECESSOR_MD5 = "c639a78817232b6eeb13dc7dadfa2015";
const REGISTRY_PREDECESSOR_MD5 = "a7c1ebb592a4a03a1c0f21c922f8db4c";
const bodyOf = (definition) => definition.slice(definition.indexOf("$function$") + "$function$".length, definition.lastIndexOf("$function$"));
const OPTIONS = JSON.stringify([
  { labelEn: "Yes option", labelEs: "Opción sí" },
  { labelEn: "No option", labelEs: "Opción no" },
]);

describe("vote campaign unit limit migration (static)", () => {
  it("passes the hosted transaction guard and replaces only the scope predicate and the staff registry", () => {
    expect(sourceTransactionProblem(sql)).toBeNull();
    const replaced = [...stripComments(sql).matchAll(/create or replace function ([a-z_.]+)\(/gi)].map((match) => match[1]);
    expect(replaced).toEqual(["private.can_manage_vote_scope", "public.get_staff_vote_campaigns"]);
    expect(stripComments(sql)).not.toMatch(/\b(drop|create)\s+policy\b/i);
    expect(stripComments(sql)).not.toMatch(/grant\s+execute/i);
  });

  it("guards the reviewed predecessor body before replacing it", () => {
    expect(sql).toContain(`pg_catalog.to_regprocedure('private.can_manage_vote_scope(text)'))) is distinct from '${PREDECESSOR_MD5}'`);
    expect(sql).toContain(`pg_catalog.to_regprocedure('public.get_staff_vote_campaigns(text, integer, jsonb)'))) is distinct from '${REGISTRY_PREDECESSOR_MD5}'`);
    expect(sql.indexOf("$predecessors$")).toBeLessThan(sql.indexOf("CREATE OR REPLACE FUNCTION private.can_manage_vote_scope"));
    // The guards hash pg_get_functiondef text; the file fixes its own path first.
    expect(sql.indexOf("set local search_path=pg_catalog,public,extensions;")).toBeLessThan(sql.indexOf("$predecessors$"));
  });

  it("adds only canManageChapter to the staff registry read", () => {
    const now = bodyOf(definitionOf(sql, "public.get_staff_vote_campaigns"));
    const before = bodyOf(definitionOf(loadMigrationSql("staff_vote_campaigns_paged_registry_read").replace(/create function public\.get_staff_vote_campaigns\(/i, "CREATE OR REPLACE FUNCTION public.get_staff_vote_campaigns("), "public.get_staff_vote_campaigns"));
    const added = "    -- #8941: false for a steward limited to one unit, so a client offers no\n    -- chapter-wide authoring the save would refuse.\n    'canManageChapter', caller_chapter is not null and coalesce(private.can_manage_vote_scope(caller_chapter), false),\n";
    expect(now).toContain(added);
    expect(now.replace(added, "")).toBe(before);
    const entry = contract.functions.find((row) => row.sig === "public.get_staff_vote_campaigns(p_state text, p_limit integer, p_cursor jsonb)");
    expect(entry.bodyMd5).toBe(createHash("md5").update(definitionOf(sql, "public.get_staff_vote_campaigns")).digest("hex"));
    expect(entry.bodyContains).toContain("'canManageChapter', caller_chapter is not null and coalesce(private.can_manage_vote_scope(caller_chapter), false)");
  });

  it("withdraws the legacy row's chapter reach under a unit limit and keeps the union branch", () => {
    const definition = definitionOf(sql, "private.can_manage_vote_scope");
    const [union, chapter] = definition.split(/\n\s+else p_chapter_id = private\.current_member_chapter\(\)/);
    expect(chapter).toBeTruthy();
    expect(union).toContain("r.role in ('admin', 'vp')");
    expect(union).toContain("r.chapter_id is null)");
    expect(union).toContain("private.has_organization_role(");
    expect(union).not.toContain("steward_assignment_scopes");
    expect(chapter).toMatch(/from public\.member_roles r[\s\S]+and not exists \(\s+select 1 from private\.steward_assignment_scopes\(\(select auth\.uid\(\)\), p_chapter_id\) scope\s+where scope\.role = r\.role\s+and not scope\.legacy_chapter_coverage\)\)/);
    expect(chapter).toContain("or private.member_has_chapter_role(");
    expect(sql).toContain("revoke all on function private.can_manage_vote_scope(text) from public, anon, authenticated;");
  });

  it("pins the new body in the database contract", () => {
    const definition = definitionOf(sql, "private.can_manage_vote_scope");
    const entry = contract.functions.find((row) => row.sig === "private.can_manage_vote_scope(p_chapter_id text)");
    expect(entry.bodyMd5).toBe(createHash("md5").update(definition).digest("hex"));
    expect(entry.exec).toBe("");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "private.steward_assignment_scopes((select auth.uid()), p_chapter_id) scope",
      "and not scope.legacy_chapter_coverage",
      "private.member_has_chapter_role(",
    ]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("unit-limited stewards and chapter-wide vote campaigns on an owned rollback database", () => {
  let db, f;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (name) => {
    await owner(); const p = f.people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: p.id, session_id: p.session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  };
  const one = async (query, args = []) => (await db.query(query, args)).rows[0]?.v;
  const attempt = async (query, args = []) => {
    await db.query("savepoint vote_unit_attempt"); let error = null, value;
    try { value = (await db.query(query, args)).rows[0]?.v; } catch (caught) { error = caught; }
    await db.query(error ? "rollback to savepoint vote_unit_attempt" : "release savepoint vote_unit_attempt");
    if (error) await db.query("release savepoint vote_unit_attempt");
    return error ? { refused: { code: error.code, message: error.message } } : { value };
  };
  const save = (kind, id = null) => attempt(
    "select public.save_vote_campaign_draft($1,$2,'chapter','Fictional chapter vote','Votación ficticia',now() + interval '7 days',$3,'Chapter-wide','Todo el capítulo',$4::jsonb) v",
    [kind, id, kind === "ballot" ? 5 : null, OPTIONS],
  );
  const listed = async () => {
    const { value, refused } = await attempt("select public.get_staff_vote_campaigns() v");
    return refused ? refused : (value.campaigns ?? []).map((row) => row.id);
  };
  const canManageChapter = async () => (await attempt("select public.get_staff_vote_campaigns() v")).value?.canManageChapter;
  const act = (fn, kind, id) => attempt(`select public.${fn}($1,$2) v`, [kind, id]);

  // A campaign owned by the chapter's vp: one draft and one open of each kind.
  const leadershipCampaigns = async () => {
    await as("vp");
    const out = {};
    for (const kind of ["ballot", "pulse"]) {
      out[kind] = { draft: (await save(kind)).value.id, open: (await save(kind)).value.id };
      expect((await act("publish_vote_campaign", kind, out[kind].open)).value.state).toBe("open");
    }
    return out;
  };

  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "vote-campaign-unit-limit-rollback-proof" });
    await db.connect(); await db.query("begin"); await db.query("set constraints all deferred");
    f = { org: randomUUID(), foreignOrg: randomUUID(), unitA: randomUUID(), people: {} };
    f.chapter = "vote-unit-" + f.org; f.foreign = "vote-unit-" + f.foreignOrg;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Votes'),($2::uuid,$2::text,'Ridge Fictional Votes')", [f.org, f.foreignOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9971),($3,$3,$3,$4,9972)", [f.chapter, f.org, f.foreign, f.foreignOrg]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Garage A')", [f.unitA, f.org, f.chapter]);
    for (const name of ["admin", "vp", "coordinator", "unit", "carry", "orgCarry", "member", "foreign"]) {
      const id = randomUUID(), session = randomUUID(), foreign = name === "foreign"; f.people[name] = { id, session };
      const org = foreign ? f.foreignOrg : f.org, chapter = foreign ? f.foreign : f.chapter;
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, id + "@example.invalid"]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, "Fictional " + name]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      const chapterRole = { admin: "admin", vp: "vp", coordinator: "coordinator", foreign: "admin" }[name];
      if (chapterRole) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, chapterRole, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, chapterRole, chapter]);
      }
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin'),($3,$4,'admin')", [f.org, f.people.admin.id, f.foreignOrg, f.people.foreign.id]);
    // Both chapter stewards are granted the way the app grants them since
    // #7663: a chapter steward role limited to Garage A.
    await as("admin");
    for (const name of ["unit", "carry"]) await one("select public.set_member_access_role($1,$2,'steward',true,$3,null) v", [f.people[name].id, f.chapter, f.unitA]);
    // Fixture only, inside a URL-guarded rolled-back transaction: runtime
    // callers cannot set the #7663 carry-over mark, which the migration gave
    // stewards who held chapter-wide coverage before it.
    await owner();
    await db.query("set constraints all immediate");
    await db.query("alter table private.chapter_role_scopes disable trigger a01_reject_carry_over_update");
    await db.query("update private.chapter_role_scopes set legacy_chapter_coverage=true where user_id=$1 and chapter_id=$2 and role='steward'", [f.people.carry.id, f.chapter]);
    await db.query("alter table private.chapter_role_scopes enable trigger a01_reject_carry_over_update");
    // The assignment references the steward grant, and the grant needs the
    // assignment (deferred check), so both go in deferred and are checked
    // before the insert guard is restored.
    await db.query("alter table private.organization_steward_unit_assignments disable trigger a01_reject_organization_assignment_insert");
    await db.query("set constraints all deferred");
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')", [f.org, f.people.orgCarry.id]);
    await db.query("insert into private.organization_steward_unit_assignments(organization_id,user_id,chapter_id,unit_id,legacy_chapter_coverage) values($1,$2,$3,$4,true)", [f.org, f.people.orgCarry.id, f.chapter, f.unitA]);
    await db.query("set constraints all immediate");
    await db.query("alter table private.organization_steward_unit_assignments enable trigger a01_reject_organization_assignment_insert");
    await db.query("set constraints all deferred");
    const scopes = (await db.query("select user_id,legacy_chapter_coverage from private.chapter_role_scopes where chapter_id=$1 and role='steward' order by legacy_chapter_coverage", [f.chapter])).rows;
    expect(scopes).toEqual([{ user_id: f.people.unit.id, legacy_chapter_coverage: false }, { user_id: f.people.carry.id, legacy_chapter_coverage: true }]);
    expect((await db.query("select count(*)::int n from public.member_roles where user_id=$1 and role='steward' and chapter_id=$2", [f.people.unit.id, f.chapter])).rows[0].n).toBe(1);
  });
  afterEach(async () => { if (db) { await db.query("rollback"); await db.end(); } });

  it("refuses the unit-limited steward in each of the five functions, for ballots and pulses", async () => {
    const theirs = await leadershipCampaigns();
    await as("unit");
    for (const kind of ["ballot", "pulse"]) {
      const noScope = { refused: { code: "42501", message: "campaign scope unavailable" } };
      expect(await save(kind)).toEqual(noScope);
      const missing = `${kind}-${randomUUID()}`;
      const notFound = { refused: { code: "22023", message: "campaign not found" } };
      // Each refusal for a campaign they may not manage reads as a missing one
      // (the draft save refuses the chapter scope before it looks up the row).
      expect(await save(kind, missing)).toEqual(noScope);
      expect(await save(kind, theirs[kind].draft)).toEqual(noScope);
      for (const fn of ["publish_vote_campaign", "delete_vote_campaign_draft"]) {
        expect(await act(fn, kind, missing)).toEqual(notFound);
        expect(await act(fn, kind, theirs[kind].draft)).toEqual(notFound);
      }
      expect(await act("close_vote_campaign", kind, missing)).toEqual(notFound);
      expect(await act("close_vote_campaign", kind, theirs[kind].open)).toEqual(notFound);
    }
    expect(await listed()).toEqual([]);
    expect(await canManageChapter()).toBe(false);
    await owner();
    const states = (await db.query(
      "select campaign_state s from public.member_ballots where id=any($1) union all select campaign_state from public.member_surveys where id=any($1)",
      [[theirs.ballot.draft, theirs.ballot.open, theirs.pulse.draft, theirs.pulse.open]],
    )).rows.map((row) => row.s).sort();
    expect(states).toEqual(["draft", "draft", "open", "open"]);
  });

  it("admitted the same steward before this change (the predecessor body)", async () => {
    const predecessor = definitionOf(loadMigrationSql("vote_campaign_authority_organization_grants"), "private.can_manage_vote_scope");
    await owner();
    await db.query(predecessor.replace(/\n$/, ";"));
    expect(await one("select md5(pg_get_functiondef(to_regprocedure('private.can_manage_vote_scope(text)'))) v")).toBe(PREDECESSOR_MD5);
    await as("unit");
    const id = (await save("ballot")).value?.id;
    expect(id).toBeTruthy();
    expect(await listed()).toEqual([id]);
    expect((await act("publish_vote_campaign", "ballot", id)).value.state).toBe("open");
  });

  it("keeps chapter leadership, chapter-wide staff and carry-over stewards managing chapter campaigns", async () => {
    for (const name of ["admin", "vp", "coordinator", "carry", "orgCarry"]) {
      await as(name);
      expect(await canManageChapter(), `${name} canManageChapter`).toBe(true);
      for (const kind of ["ballot", "pulse"]) {
        const saved = await save(kind);
        expect(saved.refused, `${name} ${kind} save`).toBeUndefined();
        const id = saved.value.id;
        expect((await save(kind, id)).value?.id, `${name} ${kind} edit`).toBe(id);
        expect(await listed(), `${name} list`).toContain(id);
        expect((await act("publish_vote_campaign", kind, id)).value?.state, `${name} ${kind} publish`).toBe("open");
        expect((await act("close_vote_campaign", kind, id)).refused, `${name} ${kind} close`).toBeUndefined();
        const draft = (await save(kind)).value.id;
        expect((await act("delete_vote_campaign_draft", kind, draft)).refused, `${name} ${kind} delete`).toBeUndefined();
      }
    }
    // The carry-over steward also manages a campaign leadership created.
    const theirs = await leadershipCampaigns();
    await as("carry");
    expect(await listed()).toEqual(expect.arrayContaining([theirs.ballot.draft, theirs.ballot.open, theirs.pulse.draft, theirs.pulse.open]));
    expect((await act("close_vote_campaign", "ballot", theirs.ballot.open)).refused).toBeUndefined();
  });

  it("refuses a plain member and another organization", async () => {
    const theirs = await leadershipCampaigns();
    await as("member");
    expect(await save("ballot")).toEqual({ refused: { code: "42501", message: "staff role required" } });
    expect((await listed()).code).toBe("42501");
    expect((await act("publish_vote_campaign", "ballot", theirs.ballot.draft)).refused.code).toBe("42501");
    await as("foreign");
    expect(await listed()).toEqual([]);
    // Their own chapter, not this one: the flag never reaches across organizations.
    expect(await canManageChapter()).toBe(true);
    const notFound = { refused: { code: "22023", message: "campaign not found" } };
    expect(await save("ballot", theirs.ballot.draft)).toEqual(notFound);
    expect(await act("publish_vote_campaign", "ballot", theirs.ballot.draft)).toEqual(notFound);
    expect(await act("close_vote_campaign", "pulse", theirs.pulse.open)).toEqual(notFound);
    expect(await act("delete_vote_campaign_draft", "pulse", theirs.pulse.draft)).toEqual(notFound);
  });
});
