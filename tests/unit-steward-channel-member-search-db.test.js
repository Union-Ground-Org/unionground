// @vitest-environment node
//
// SEC-UG-UNIT-STEWARD-CHANNEL-SEARCH-SHOWS-OTHER-UNITS-MEMBERS-20261115 (#8850)
//
// public.search_chapter_space_members and public.list_channel_mention_candidates
// gave a steward limited to one unit the whole chapter's members, name and id,
// including members of another unit who are not in the channel. Since #8589 a
// steward limited to a unit sees only their own unit's members. Both functions
// now take the member set from private.staff_visible_member_ids, the helper the
// member_profiles row policy uses, so the unit steward's answers follow it.
//
// Fixture: one chapter with two units and one chapter-wide channel. Steward A
// is limited to unit A (set through the product's own set_member_access_role);
// the wide steward has no unit limit (the #8589 carry-over, written by the
// actual migration backfill); the chapter coordinator and the organization
// administrator lead. Member B is in unit B and not in the channel; member B
// inside is in unit B and a member of the channel. Every probe runs in one
// transaction that is rolled back. Fictional names only.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const STEM = "unit_steward_channel_member_search_unit_scope";
const VISIBLE = "private.staff_visible_member_ids(readable_role)";

describe("unit steward channel member search (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("replaces both functions behind their predecessor digests with the shared visibility helper", () => {
    expect(findMigrationName(STEM) > "20261113131000").toBe(true);
    expect(migration).toContain("set local search_path = pg_catalog;");
    expect(migration).toMatch(/create or replace function public\.search_chapter_space_members\(/i);
    expect(migration).toMatch(/create or replace function public\.list_channel_mention_candidates\(/i);
    expect(migration).toContain("unreviewed search_chapter_space_members predecessor");
    expect(migration).toContain("unreviewed list_channel_mention_candidates predecessor");
    expect(migration.split(VISIBLE)).toHaveLength(3);
    // No second version of the unit rule, and no new grant.
    expect(migration).not.toMatch(/chapter_role_scopes|chapter_unit_has_member|chapter_unit_members/);
    expect(migration).not.toMatch(/\bgrant\b/i);
  });

  it("pins both functions in the database contract and drops them from the #8850 difference entry", () => {
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8")).functions;
    for (const sig of [
      "public.search_chapter_space_members(p_space_id uuid, p_query text, p_limit integer)",
      "public.list_channel_mention_candidates(p_space_id uuid, p_query text, p_limit integer)",
    ]) {
      const entry = contract.find((row) => row.sig === sig);
      expect(entry?.bodyContains, sig).toContain(VISIBLE);
      expect(entry?.bodyMd5, sig).toMatch(/^[0-9a-f]{32}$/);
    }
    const differences = JSON.parse(readFileSync(new URL("../config/non-interference/expected-differences.json", import.meta.url), "utf8"));
    expect(JSON.stringify(differences)).not.toMatch(/search_chapter_space_members|list_channel_mention_candidates/);
    // Only the steward directory inside the mention list is shared, and only
    // for the unit neighbour; the search is shared for no neighbour.
    const shared = JSON.parse(readFileSync(new URL("../config/non-interference/shared.json", import.meta.url), "utf8")).functions;
    expect(shared.list_channel_mention_candidates?.pairs).toEqual(["unit"]);
    expect(shared).not.toHaveProperty("search_chapter_space_members");
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/unit-steward-channel-member-search-db.test.js");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const PEOPLE = [
  ["admin", "Quarry Admin"],
  ["lead", "Quarry Lead"],
  ["stewardA", "Quarry Steward A"],
  ["crossSteward", "Quarry Cross Steward"],
  ["wide", "Quarry Wide Steward"],
  ["memberA", "Quarry Member A"],
  ["plainA", "Quarry Plain A"],
  ["memberB", "Quarry Member B"],
  ["insideB", "Quarry Inside B"],
];
const SEARCH = "select public.search_chapter_space_members($1, 'quarry', 50) v";
const MENTION = "select public.list_channel_mention_candidates($1, 'quarry', 10) v";

live("unit steward channel member search on a disposable database", () => {
  let db;
  const f = { people: {} };

  async function as(name) {
    await db.query("reset role");
    const person = f.people[name];
    await db.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify({ sub: person.id, session_id: person.session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  }
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims', '', true)"); };
  // One call as a person, rolled back: { ok, value } or { ok: false, code, message }.
  async function attempt(name, sql, args = []) {
    await db.query("savepoint attempt");
    try {
      await as(name);
      const value = (await db.query(sql, args)).rows[0]?.v;
      await owner();
      await db.query("rollback to savepoint attempt");
      return { ok: true, value };
    } catch (error) {
      await db.query("rollback to savepoint attempt");
      await owner();
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const nameOf = (id) => PEOPLE.find(([key]) => f.people[key].id === id)?.[0] ?? id;
  async function searched(name) {
    const result = await attempt(name, SEARCH, [f.space]);
    expect(result.ok, `${name}: ${result.message}`).toBe(true);
    return result.value.map((row) => nameOf(row.userId)).sort();
  }
  async function mentioned(name) {
    const result = await attempt(name, MENTION, [f.space]);
    expect(result.ok, `${name}: ${result.message}`).toBe(true);
    return result.value.map((row) => nameOf(row.id)).sort();
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "unit-steward-channel-member-search-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    const ids = (await db.query("select pg_catalog.array_agg(gen_random_uuid()) v from generate_series(1, $1)", [PEOPLE.length * 2 + 4])).rows[0].v;
    [f.org, f.unitA, f.unitB, f.space] = ids.splice(0, 4);
    f.chapter = `unit-channel-${f.org}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Quarry Local')", [f.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Quarry Main',$1,$2,9992)", [f.chapter, f.org]);
    for (const [name, fullName] of PEOPLE) {
      const [id, session] = ids.splice(0, 2);
      f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, f.chapter, fullName]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values(gen_random_uuid(),$1,'totp','verified',now(),now())", [id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, f.chapter]);
    }
    for (const [name, role] of [["stewardA", "steward"], ["crossSteward", "steward"], ["wide", "steward"], ["lead", "coordinator"]]) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [f.people[name].id, role, f.chapter]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [f.people[name].id, role, f.chapter]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [f.org, f.people.admin.id]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Quarry Shop'),($2,$3,$4,'Quarry Yard')", [f.unitA, f.unitB, f.org, f.chapter]);
    // The wide steward's chapter-wide
    // coverage is the actual migration's carry-over, never a runtime bypass.
    await migrateLegacyStewardFixtures(db);
    await as("admin");
    for (const [name, unit] of [["stewardA", f.unitA], ["memberA", f.unitA], ["plainA", f.unitA], ["wide", f.unitB], ["memberB", f.unitB], ["insideB", f.unitB], ["crossSteward", f.unitB]]) {
      await db.query("select public.set_chapter_access_member($1,$2,$3,null,true)", [f.chapter, f.people[name].id, unit]);
    }
    // The cross steward covers unit A but personally belongs to unit B.
    for (const name of ["stewardA", "crossSteward"]) {
      await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.people[name].id, f.chapter, f.unitA]);
    }
    await owner();
    // A chapter-wide channel the coordinator created; member B inside is one of
    // its members, and member A has posted in it.
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: f.people.lead.id, role: "authenticated" })]);
    await db.query("insert into public.chapter_spaces(id,name,visibility) values($1,'Quarry floor','chapter')", [f.space]);
    const thread = (await db.query("insert into public.chapter_threads(space_id,title,kind) values($1,'Quarry thread','topic') returning id", [f.space])).rows[0].id;
    await owner();
    await db.query("insert into public.chapter_space_members(space_id,user_id,role) values($1,$2,'member')", [f.space, f.people.insideB.id]);
    await as("memberA");
    await db.query("insert into public.chapter_thread_posts(thread_id,body) values($1,'Fictional shift note')", [thread]);
    await owner();
    const scopes = (await db.query("select user_id, unit_id, legacy_chapter_coverage from private.chapter_role_scopes where chapter_id=$1 and role='steward'", [f.chapter])).rows;
    for (const name of ["stewardA", "crossSteward"]) expect(scopes.find((row) => row.user_id === f.people[name].id), name).toMatchObject({ unit_id: f.unitA, legacy_chapter_coverage: false });
    expect(scopes.find((row) => row.user_id === f.people.wide.id)).toMatchObject({ legacy_chapter_coverage: true });
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    try { await db.query("rollback"); } finally { await db.end(); }
  });

  it("limits the unit steward's channel search to their own unit", async () => {
    expect(await searched("stewardA")).toEqual(["memberA", "plainA", "stewardA"]);
  });

  it("lets a steward who covers another unit than their own still find themselves, and no one else of their own unit", async () => {
    // Gate round 1 (stage 218): the caller's own profile is always searchable,
    // as the member_profiles row policy allows; their personal unit is not.
    expect(await searched("crossSteward")).toEqual(["crossSteward", "memberA", "plainA", "stewardA"]);
  });

  it("never offers the cross steward themselves or their own unit's members outside the channel as mentions", async () => {
    const names = await mentioned("crossSteward");
    expect(names).not.toContain("crossSteward");
    expect(names).not.toContain("memberB");
    for (const name of ["memberA", "plainA", "lead", "insideB"]) expect(names, name).toContain(name);
  });

  it("keeps the chapter-wide search for the coordinator, the administrator and the steward with no unit limit", async () => {
    // Everyone in the chapter except the channel's creator and its members.
    const chapterWide = ["admin", "crossSteward", "memberA", "memberB", "plainA", "stewardA", "wide"];
    for (const name of ["lead", "admin", "wide"]) expect(await searched(name), name).toEqual(chapterWide);
  });

  it("still refuses an ordinary member the search, with the same error", async () => {
    const result = await attempt("plainA", SEARCH, [f.space]);
    expect(result).toMatchObject({ ok: false, code: "42501", message: "staff role required" });
  });

  it("offers the unit steward no other unit's member who is outside the channel", async () => {
    const names = await mentioned("stewardA");
    expect(names).not.toContain("memberB");
    // Their own unit, the channel's creator and members, and channel authors stay.
    for (const name of ["memberA", "plainA", "lead", "insideB"]) expect(names, name).toContain(name);
  });

  it("keeps chapter staff for the unit steward exactly as an ordinary member gets them", async () => {
    const member = await mentioned("plainA");
    const steward = await mentioned("stewardA");
    for (const name of member.filter((name) => name !== "stewardA")) expect(steward, name).toContain(name);
    // The unit-B steward is in the published steward directory for both.
    expect(member).toContain("wide");
    expect(member).not.toContain("memberB");
    expect(member).not.toContain("insideB");
    expect(member).toContain("memberA");
  });

  it("keeps the whole chapter's readers for the coordinator, the administrator and the steward with no unit limit", async () => {
    const everyone = PEOPLE.map(([key]) => key);
    for (const name of ["lead", "admin", "wide"]) {
      expect(await mentioned(name), name).toEqual(everyone.filter((key) => key !== name).sort());
    }
  });
});
