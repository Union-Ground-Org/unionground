// @vitest-environment node
//
// REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006
//
// 20261008091000 adds public.get_chapter_leadership(): the caller's own
// chapter's officers (display titles), its President and administrators
// (chapter-scoped roles), and the organization's administrators. Name, title
// and those roles only. Two fictional tenants; every refusal has an allowed
// control; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261008091000_chapter_leadership_roster";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("chapter leadership roster (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const body = stripComments(fnBody(sql, "public.get_chapter_leadership()"));

  it("is one self-scoped, MFA- and full-session-guarded reader with no arguments", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("stable");
    expect(body).toMatch(/^create function public\.get_chapter_leadership\(\)\s+returns jsonb/);
    expect(body).toContain("perform private.member_pin_require_full_session();");
    expect(body).toContain("if caller is null or not private.mfa_satisfied() or caller_org is null then");
    // The chapter is the caller's own, and only while their membership is active.
    expect(body).toContain("from public.member_profiles p where p.id = caller;");
    expect(body).toMatch(/cm\.user_id = caller\s+and cm\.status = 'active'/);
    expect(body).toContain("c.organization_id = caller_org");
    expect(sql).toContain("revoke all on function public.get_chapter_leadership() from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_chapter_leadership() to authenticated;");
    expect(sql).not.toMatch(/create (table|policy|trigger)|alter table|insert into|update public|delete from/i);
  });

  it("returns name, title and the three roles only, never contact or other role data", () => {
    const keys = [...body.matchAll(/'(\w+)', ranked\./g)].map((match) => match[1]);
    expect(keys).toEqual(["id", "name", "title", "president", "administrator", "organizationAdministrator"]);
    expect(body).not.toMatch(/\b(email|phone|member_since|initials|steward_contact_preferences|member_profile_details)\b/);
    // President and chapter administrator are chapter-scoped role rows; an
    // organization-wide vp grant is not a chapter Presidency.
    expect(body).toMatch(/rc\.chapter_id = caller_chapter\s+and rc\.role = 'vp'/);
    expect(body).toMatch(/rc\.chapter_id = caller_chapter\s+and rc\.role = 'admin'/);
    expect(body).not.toMatch(/g\.role = 'vp'/);
    expect(body).toContain("limit 100");
  });

  it("pins the reader in the database contract", () => {
    expect(contract.functions.find((row) => row.sig === "public.get_chapter_leadership()")).toMatchObject({ secdef: true, exec: "authenticated" });
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter leadership roster on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "chapter-leadership-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const main = `cpl-main-${orgA}`;
    const east = `cpl-east-${orgA}`;
    const other = `pkt-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `cpl-${orgA}`, `Copperline Library Workers ${orgA}`, orgB, `pkt-${orgB}`, `Port Kinsey Transit ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Main Branch',$1,'proof',$4,9981), ($2,'Eastside Branch',$2,'proof',$4,9982), ($3,'Depot',$3,'proof',$5,9983)`,
      [main, east, other, orgA, orgB]);
    return { orgA, orgB, main, east, other };
  }

  async function person(t, chapter, { organization = t.orgA, role = null, name = null, title = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, name ?? `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,display_title) values ($1,$2,'active',$3) on conflict do nothing", [id, chapter, title]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    }
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args = []) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "" };
    }
  }

  const leadershipAs = async (userId) => {
    await actAs(userId);
    const result = await capture("select public.get_chapter_leadership() as v");
    await asOwner();
    return result;
  };

  it("lists the chapter's officers, President, administrators and the organization's administrators, and nobody else", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const president = await person(t, t.main, { role: "vp", name: "Dolores Whitcombe" });
      const officer = await person(t, t.main, { name: "Samuel Adeyemi", title: "Secretary-Treasurer" });
      const chapterAdmin = await person(t, t.main, { role: "admin", name: "Callum Reyes" });
      const orgAdmin = await person(t, t.east, { name: "Nadia Farouk" });
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, orgAdmin]);
      const orgWideVp = await person(t, t.main, { name: "Statewide Officer" });
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'vp')", [t.orgA, orgWideVp]);
      const steward = await person(t, t.main, { role: "steward", name: "Pete Halvorsen" });
      const eastAdmin = await person(t, t.east, { role: "admin", name: "East Admin" });
      const eastOfficer = await person(t, t.east, { name: "East Officer", title: "Trustee" });
      const foreignAdmin = await person(t, t.other, { organization: t.orgB, role: "admin", name: "Foreign Admin" });
      const member = await person(t, t.main, { name: "Imani Clarke" });

      const roster = await leadershipAs(member);
      // 20261030203100: every listed person can be messaged by this member and
      // has shared no contact channel.
      const reachable = { canMessage: true, treasurer: false, contact: { email: null, phone: null } };
      expect(roster.ok, roster.message).toBe(true);
      expect(roster.value).toMatchObject({ chapterId: t.main, chapterName: "Main Branch" });
      expect(roster.value.people).toEqual([
        { id: president, name: "Dolores Whitcombe", title: null, president: true, administrator: false, organizationAdministrator: false, ...reachable },
        { id: officer, name: "Samuel Adeyemi", title: "Secretary-Treasurer", president: false, administrator: false, organizationAdministrator: false, ...reachable },
        { id: chapterAdmin, name: "Callum Reyes", title: null, president: false, administrator: true, organizationAdministrator: false, ...reachable },
        { id: orgAdmin, name: "Nadia Farouk", title: null, president: false, administrator: false, organizationAdministrator: true, ...reachable },
      ]);
      const listed = roster.value.people.map((row) => row.id);
      for (const absent of [orgWideVp, steward, eastAdmin, eastOfficer, foreignAdmin, member]) expect(listed).not.toContain(absent);

      // An Eastside member sees Eastside's leadership and the organization's
      // administrators, never Main Branch's.
      const eastMember = await person(t, t.east, { name: "East Member" });
      const east = await leadershipAs(eastMember);
      expect(east.value.people.map((row) => row.id).sort()).toEqual([eastAdmin, eastOfficer, orgAdmin].sort());

      // The other organization's member sees only their own chapter.
      const foreignMember = await person(t, t.other, { organization: t.orgB, name: "Foreign Member" });
      const foreign = await leadershipAs(foreignMember);
      expect(foreign.value.people.map((row) => row.id)).toEqual([foreignAdmin]);
    } finally {
      await client.query("rollback");
    }
  });

  it("drops a person whose membership ended and refuses a caller with no active chapter or no session", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const officer = await person(t, t.main, { name: "Former Officer", title: "Trustee" });
      const member = await person(t, t.main, { name: "Imani Clarke" });
      const lapsed = await person(t, t.main, { name: "Lapsed Member" });

      expect((await leadershipAs(member)).value.people.map((row) => row.id)).toEqual([officer]);
      await client.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [officer, t.main]);
      expect((await leadershipAs(member)).value.people).toEqual([]);

      // A lapsed member has no organization (private.current_member_organization()
      // needs an active chapter membership), so the read is refused outright.
      await client.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [lapsed, t.main]);
      expect(await leadershipAs(lapsed)).toMatchObject({ ok: false, code: "42501" });

      await client.query("set local role anon");
      const anonymous = await capture("select public.get_chapter_leadership() as v");
      await asOwner();
      expect(anonymous).toMatchObject({ ok: false, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });
});
