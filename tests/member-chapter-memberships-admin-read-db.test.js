// @vitest-environment node
//
// BUG-UG-CHAPTER-MEMBERSHIP-EXACT-STATE-READ-20261103 (#6874): the
// membership card reads a member's exact chapters through
// public.get_member_chapter_memberships_for_admin. An organization Admin sees
// every active chapter in their organization, a chapter Admin only their
// selected chapter, and every other caller is refused with 42501. Fictional
// tenants; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261103140000_member_chapter_memberships_admin_read";
const SIG = "public.get_member_chapter_memberships_for_admin(uuid)";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member chapter memberships admin read (static)", () => {
  const sql = loadMigrationSql(MIGRATION);
  const body = stripComments(fnBody(sql, "public.get_member_chapter_memberships_for_admin(")).toLowerCase();

  it("runs in one transaction and only reads", () => {
    const code = stripComments(sql);
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(body).toContain("security definer\nstable\nset search_path = ''");
    for (const write of ["insert into", "update public.", "delete from", "perform private.lock_case_graph"]) expect(body).not.toContain(write);
  });

  it("admits only an organization Admin or the selected chapter's Admin, and scopes rows to the caller's organization", () => {
    expect(body).toContain("org_admin boolean := private.has_organization_role(caller_org, array['admin']);");
    expect(body).toContain("or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then\n    raise exception 'admin role required' using errcode = '42501';");
    expect(body).toContain("and c.organization_id = caller_org");
    expect(body).toContain("and (org_admin or c.id = caller_chapter)");
    expect(stripComments(sql)).toContain(`revoke all on function ${SIG}\n  from public, anon, authenticated, service_role;\ngrant execute on function ${SIG}\n  to authenticated;`);
  });

  it("is pinned in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.get_member_chapter_memberships_for_admin(p_user_id uuid)");
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    for (const needle of entry.bodyContains) expect(stripComments(fnBody(sql, "public.get_member_chapter_memberships_for_admin("))).toContain(needle);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member chapter memberships admin read on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "member-chapter-memberships-admin-read-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const north = `qfl-north-${orgA}`;
    const south = `qfl-south-${orgA}`;
    const west = `qfl-west-${orgA}`;
    const other = `lmt-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `qfl-${orgA}`, `Quarry Falls Librarians ${orgA}`, orgB, `lmt-${orgB}`, `Linden Mill Transit ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'North',$1,'proof',$5,9971), ($2,'South',$2,'proof',$5,9972), ($3,'West',$3,'proof',$5,9973), ($4,'Depot',$4,'proof',$6,9974)`,
      [north, south, west, other, orgA, orgB]);
    return { orgA, orgB, north, south, west, other };
  }

  async function person(t, chapter, { organization = t.orgA, roles = [] } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await join(id, chapter, roles);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return id;
  }

  async function join(id, chapter, roles = []) {
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    for (const role of roles) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    }
  }

  async function read(actor, target, { aal = "aal2" } = {}) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [session, actor, aal]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated", aal, session_id: session })]);
    await client.query("set local role authenticated");
    await client.query("savepoint cell");
    let result;
    try {
      const answer = await client.query("select public.get_member_chapter_memberships_for_admin($1) as v", [target]);
      await client.query("release savepoint cell");
      result = { ok: true, value: answer.rows[0].v, code: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      result = { ok: false, value: null, code: error.code || "" };
    }
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
    return result;
  }

  it("gives an organization Admin every chapter, the home flag, per-chapter roles and the last-chapter fact", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await person(t, t.north, { roles: ["admin"] });
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, orgAdmin]);
      const member = await person(t, t.south, { roles: ["steward"] });
      await join(member, t.west, ["coordinator", "advisor"]);
      const single = await person(t, t.west);
      const revoked = await person(t, t.north);
      await join(revoked, t.south);
      await client.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [revoked, t.north]);
      const foreign = await person(t, t.other, { organization: t.orgB });

      const answer = await read(orgAdmin, member);
      expect(answer.ok).toBe(true);
      expect(answer.value).toEqual({
        userId: member,
        scope: "organization",
        chapters: [
          { chapterId: t.south, home: true, lastChapter: false, roles: ["steward"] },
          { chapterId: t.west, home: false, lastChapter: false, roles: ["advisor", "coordinator"] },
        ],
      });
      expect((await read(orgAdmin, single)).value.chapters).toEqual([{ chapterId: t.west, home: true, lastChapter: true, roles: [] }]);
      // A revoked membership is not a chapter they hold, so South is their last.
      expect((await read(orgAdmin, revoked)).value.chapters).toEqual([{ chapterId: t.south, home: false, lastChapter: true, roles: [] }]);
      // Another organization's member is not visible.
      expect((await read(orgAdmin, foreign)).value).toEqual({ userId: foreign, scope: "organization", chapters: [] });
    } finally {
      await client.query("rollback");
    }
  });

  it("gives a chapter Admin their selected chapter only", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const chapterAdmin = await person(t, t.south, { roles: ["admin"] });
      const member = await person(t, t.south, { roles: ["steward"] });
      await join(member, t.west, ["coordinator"]);
      const only = await person(t, t.south);
      const elsewhere = await person(t, t.west);

      expect((await read(chapterAdmin, member)).value).toEqual({
        userId: member,
        scope: "chapter",
        chapters: [{ chapterId: t.south, home: true, lastChapter: false, roles: ["steward"] }],
      });
      expect((await read(chapterAdmin, only)).value.chapters).toEqual([{ chapterId: t.south, home: true, lastChapter: true, roles: [] }]);
      expect((await read(chapterAdmin, elsewhere)).value.chapters).toEqual([]);
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses every caller outside that scope with 42501 and returns nothing", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const member = await person(t, t.south);
      const steward = await person(t, t.south, { roles: ["steward"] });
      const president = await person(t, t.south, { roles: ["vp"] });
      const plain = await person(t, t.north);
      const foreignAdmin = await person(t, t.other, { organization: t.orgB, roles: ["admin"] });
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgB, foreignAdmin]);
      const chapterAdmin = await person(t, t.south, { roles: ["admin"] });

      for (const actor of [steward, president, plain]) {
        expect(await read(actor, member)).toEqual({ ok: false, value: null, code: "42501" });
      }
      // A foreign organization's Admin acts in their own organization, where
      // the member does not belong.
      expect((await read(foreignAdmin, member)).value).toEqual({ userId: member, scope: "organization", chapters: [] });
      // An Admin without a two-step session holds no Admin authority here.
      expect(await read(chapterAdmin, member, { aal: "aal1" })).toEqual({ ok: false, value: null, code: "42501" });
    } finally {
      await client.query("rollback");
    }
  });
});
