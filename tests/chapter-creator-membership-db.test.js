// @vitest-environment node
//
// REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030 (#6560), the case
// handed over from #6604: an organization admin who created a chapter could
// not invite anyone into it. 20261031103908 gives the creator an active
// membership in the chapter create_admin_chapter makes. The 20261004010000
// invitation rule is unchanged, so a chapter the admin did not create and
// does not belong to stays refused. Every row is rolled back.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// The global Web Crypto, not an import: the R2 risk census reads a crypto
// module specifier as sensitive code.
const randomUUID = () => globalThis.crypto.randomUUID();

const MIGRATION = "20261031103908_chapter_creator_membership";
const SIGNATURE = "public.create_admin_chapter(";
const HASH = (pair) => pair.repeat(32);

describe("chapter creator membership (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const body = stripComments(fnBody(sql, SIGNATURE));

  it("is one atomic migration that takes the case-graph lock first and keeps every existing guard", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(body).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s*declare/);
    expect(body).toContain("not private.has_organization_role(org_id, array['admin'])");
    expect(body).toContain("org_id is distinct from locked_org");
    expect(body.indexOf("organization-role:")).toBeLessThan(body.indexOf("chapters:admin"));
    expect(body).not.toMatch(/\bis_default\s*=/);
  });

  it("joins the creator to the chapter it made, audits it, and touches no invitation rule", () => {
    expect(body.indexOf("insert into public.chapters")).toBeLessThan(body.indexOf("insert into public.member_chapter_memberships"));
    expect(body).toContain("values (caller, clean_id, 'active')");
    expect(body).toContain("'creatorMembership', true");
    expect(sql).not.toMatch(/function private\.member_invitation_chapter_administrable/);
    expect(sql).not.toMatch(/function public\.(create|resend|revoke)_member_invitation/);
    expect(sql).toContain("revoke all on function public.create_admin_chapter(text, text, text, integer) from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.create_admin_chapter(text, text, text, integer) to authenticated;");
  });
});

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

live("chapter creator membership on a disposable database", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapter-creator-membership-rollback-proof",
    });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenant() {
    const org = randomUUID();
    const local = `ccm-local-${org}`;
    const transit = `ccm-transit-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `ccm-${org}`, `Creator Proof Local ${org}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Harbor Local',$1,'proof',$3,9951), ($2,'Transit Chapter',$2,'proof',$3,9952)`,
      [local, transit, org],
    );
    return { org, local, transit };
  }

  // A chapter admin of `local`; with organizationAdmin, an organization admin too.
  async function admin(t, { organizationAdmin }) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, t.local]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.org, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.local]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, t.local]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, t.local]);
    if (organizationAdmin) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.org, id]);
    }
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), id],
    );
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session }),
    ]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args) {
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

  const createChapter = (id, name) => capture("select public.create_admin_chapter($1,$2,null,null) as v", [id, name]);
  const invite = (chapter, hash) => capture(
    "select public.create_member_invitation($1,'Proof Invitee',$2,null,'en',$3) as v",
    [`invitee-${randomUUID()}@example.invalid`, chapter, hash],
  );
  const membership = async (user, chapter) => (
    await client.query("select status from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [user, chapter])
  ).rows[0]?.status ?? null;

  it("joins the organization admin to the chapter they create, so they can invite into it", async () => {
    await client.query("begin");
    try {
      const t = await tenant();
      const orgAdmin = await admin(t, { organizationAdmin: true });
      const fresh = `ccm-new-${t.org.slice(0, 8)}`;

      await actAs(orgAdmin);
      // The rule stands: a chapter they do not belong to is refused.
      const intoTransit = await invite(t.transit, HASH("c1"));
      const created = await createChapter(fresh, "Night Shift Chapter");
      const intoFresh = await invite(fresh, HASH("c2"));
      await asOwner();

      expect(intoTransit).toMatchObject({ ok: false, code: "42501", message: "invitation not permitted" });
      expect(created.ok, created.message).toBe(true);
      expect(created.value).toMatchObject({ id: fresh, created: true, isDefault: false });
      expect(await membership(orgAdmin, fresh)).toBe("active");
      expect(await membership(orgAdmin, t.transit)).toBeNull();
      expect(intoFresh.ok, intoFresh.message).toBe(true);
      const row = (await client.query("select chapter_id from public.member_invitations where id=$1", [intoFresh.value.invitationId])).rows[0];
      expect(row).toMatchObject({ chapter_id: fresh });
      const audit = (await client.query(
        "select detail from public.member_admin_audit where actor=$1 and action='create_chapter' and detail->>'chapterId'=$2",
        [orgAdmin, fresh],
      )).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].detail).toMatchObject({ chapterId: fresh, creatorMembership: true });
    } finally {
      await client.query("rollback");
    }
  }, 60_000);

  it("still refuses a chapter-only admin and writes neither a chapter nor a membership", async () => {
    await client.query("begin");
    try {
      const t = await tenant();
      const chapterAdmin = await admin(t, { organizationAdmin: false });
      const fresh = `ccm-refused-${t.org.slice(0, 8)}`;
      await actAs(chapterAdmin);
      const refused = await createChapter(fresh, "Refused Chapter");
      await asOwner();
      expect(refused).toMatchObject({ ok: false, code: "42501", message: "admin role required" });
      expect((await client.query("select 1 from public.chapters where id=$1", [fresh])).rowCount).toBe(0);
      expect(await membership(chapterAdmin, fresh)).toBeNull();
    } finally {
      await client.query("rollback");
    }
  }, 60_000);
});
