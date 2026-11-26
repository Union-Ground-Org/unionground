// @vitest-environment node
//
// BUG-UG-INVITE-STARTING-ACCESS-NO-OFFICER-TITLES-20261003
//
// Owner decision, October 4, 2026: officer titles are a display title plus
// separately assigned access. 20261004050000 adds a display-only title to a
// chapter membership that an admin of that chapter sets; a title must grant
// nothing. Two fictional tenants; every refusal has an allowed control; every
// row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261004050000_member_chapter_display_titles";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member chapter display titles (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("adds a bounded display-only column, one audited admin setter and the directory field in one migration", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("add column display_title text;");
    expect(sql).toContain("pg_catalog.char_length(display_title) between 1 and 60");
    expect(sql).not.toMatch(/grant\s+update[^;]*member_chapter_memberships/i);
    const setter = stripComments(fnBody(sql, "public.set_member_chapter_display_title(p_user_id uuid, p_chapter_id text, p_title text)"));
    expect(setter).toMatch(/begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    expect(setter).toContain("if caller is null\n     or not private.mfa_satisfied()\n     or not private.member_invitation_chapter_administrable(p_chapter_id) then");
    expect(setter).toContain("'set_chapter_display_title'");
    expect(setter).not.toMatch(/insert into public\.member_role|organization_role_grants/);
    expect(sql).toContain("'set_chapter_display_title'\n  ));");
  });

  // REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006 adds
  // the member's own-chapter leadership roster, which shows the title and
  // decides nothing. REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030
  // moves that roster's predicate into private.chapter_leadership_people: a
  // titled officer is listed, so members of the chapter may write to them and
  // they may publish their own email or phone to those members. It still
  // grants no role and no read of anyone else's data.
  it("is never read for an access decision: only the setter, the directory and leadership readers and the account export mention it", () => {
    const mentions = new Set();
    for (const { name, sql: text } of migrationFiles()) {
      const code = stripComments(text);
      if (!code.includes("display_title")) continue;
      for (const match of code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/g)) {
        const body = fnBody(text, match[1]);
        if (body && stripComments(body).includes("display_title")) mentions.add(match[1]);
      }
      expect(code, name).not.toMatch(/create policy[^;]*display_title/i);
    }
    expect([...mentions].sort()).toEqual([
      "private.account_lifecycle_export_member_chapter_memberships",
      "private.chapter_leadership_people",
      // Learning-period undo state and its reversal of the setter's own
      // change (#6946); neither decides access.
      "private.learning_membership_state",
      "private.learning_undo_chapter_membership",
      "public.export_member_directory_csv",
      "public.get_admin_member_directory",
      "public.get_chapter_leadership",
      // #7666 shows it beside a cross-chapter peer's name; the access level decides.
      "public.list_cross_chapter_peers",
      "public.set_member_chapter_display_title",
    ]);
    expect(sql).toMatch(/set export_columns = array\[[^\]]*'compass_scope_verification','display_title'\]::text\[\]/);
  });

  it("pins the setter and the directory field in the database contract", () => {
    const setter = contract.functions.find((row) => row.sig === "public.set_member_chapter_display_title(p_user_id uuid, p_chapter_id text, p_title text)");
    expect(setter).toMatchObject({ secdef: true, exec: "authenticated" });
    const directory = contract.functions.find((row) => row.sig.startsWith("public.get_admin_member_directory("));
    expect(directory.bodyContains).toContain("'displayTitle', s.display_title");
    // The editor is offered only where the setter's own chapter check passes.
    expect(directory.bodyContains).toContain("'displayTitleEditable', private.member_invitation_chapter_administrable(s.chapter_id)");
    // The audit vocabulary itself is pinned by the migration (above) and by
    // tests/admin-audit-text.test.jsx, which reads the latest constraint.
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member chapter display titles on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "member-chapter-display-titles-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const local = `hwl7-local-${orgA}`;
    const hhs = `hwl7-hhs-${orgA}`;
    const other = `rtl9-a-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `hwl7-${orgA}`, `Harbor Workers Local 7 ${orgA}`, orgB, `rtl9-${orgB}`, `Ridge Transit Local 9 ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Harbor Local',$1,'proof',$4,9961), ($2,'HHS Chapter',$2,'proof',$4,9962), ($3,'Ridge Chapter',$3,'proof',$5,9963)`,
      [local, hhs, other, orgA, orgB]);
    return { orgA, orgB, local, hhs, other };
  }

  async function person(t, chapter, { organization = t.orgA, role = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
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

  async function capture(statement, args) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, rows: result.rowCount, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, rows: 0, code: error.code || "", message: error.message || "" };
    }
  }

  const setTitle = (user, chapter, title) => capture("select public.set_member_chapter_display_title($1,$2,$3) as v", [user, chapter, title]);
  const titleOf = async (user, chapter) => (await client.query("select display_title from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [user, chapter])).rows[0].display_title;
  const access = async (user) => (await client.query(
    `select (select pg_catalog.count(*) from public.member_roles where user_id=$1)::int as roles,
            (select pg_catalog.count(*) from public.member_role_chapters where user_id=$1)::int as chapter_roles,
            (select pg_catalog.count(*) from public.organization_role_grants where user_id=$1)::int as org_roles`, [user])).rows[0];

  it("lets a chapter admin set and clear a title that grants nothing, with an audit row and the directory field", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await person(t, t.hhs, { role: "admin" });
      const member = await person(t, t.hhs);
      const before = await access(member);

      await actAs(admin);
      const set = await setTitle(member, t.hhs, "  Secretary-Treasurer  ");
      const directory = await capture("select public.get_admin_member_directory('', null, null, 50) as v", []);
      await asOwner();
      expect(set.ok, set.message).toBe(true);
      expect(set.value).toEqual({ updated: true, displayTitle: "Secretary-Treasurer" });
      expect(await titleOf(member, t.hhs)).toBe("Secretary-Treasurer");
      expect(directory.value.items.find((item) => item.userId === member)).toMatchObject({ displayTitle: "Secretary-Treasurer", displayTitleEditable: true, roles: [] });
      expect(await access(member)).toEqual(before);

      // The member's account export carries the title with the membership.
      const exported = (await client.query("select private.account_lifecycle_export_member_chapter_memberships($1) as v", [member])).rows[0].v;
      expect(exported).toEqual([expect.objectContaining({ chapter_id: t.hhs, display_title: "Secretary-Treasurer" })]);
      const columns = (await client.query("select export_columns from private.account_lifecycle_manifest where table_name='member_chapter_memberships'")).rows[0].export_columns;
      expect(Object.keys(exported[0]).sort()).toEqual([...columns].sort());

      // The holder of a title gains no role check.
      await actAs(member);
      await client.query("reset role");
      const roleChecks = (await client.query(
        "select bool_or(private.member_has_chapter_role($1, array[r])) as any from unnest(array['steward','coordinator','advisor','admin','vp']) r", [t.hhs])).rows[0].any;
      await asOwner();
      expect(roleChecks).toBe(false);

      const audit = (await client.query(
        "select action, actor, target_user, detail from public.member_admin_audit where target_user=$1 order by created_at", [member])).rows;
      expect(audit).toEqual([expect.objectContaining({ action: "set_chapter_display_title", actor: admin, target_user: member })]);
      expect(audit[0].detail).toEqual({ chapterId: t.hhs, title: "Secretary-Treasurer", previousTitle: null });

      await actAs(admin);
      const cleared = await setTitle(member, t.hhs, "");
      await asOwner();
      expect(cleared.value).toEqual({ updated: true, displayTitle: null });
      expect(await titleOf(member, t.hhs)).toBeNull();
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses everyone but an admin of that chapter, invalid titles and non-members", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await person(t, t.hhs, { role: "admin" });
      const otherAdmin = await person(t, t.local, { role: "admin" });
      const orgAdmin = await person(t, t.local, { role: "admin" });
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, orgAdmin]);
      const president = await person(t, t.hhs, { role: "vp" });
      const steward = await person(t, t.hhs, { role: "steward" });
      const member = await person(t, t.hhs);
      const foreignMember = await person(t, t.other, { organization: t.orgB });

      const refusals = [];
      // An organization admin sees the HHS member in the directory but is not
      // a member of that chapter, so the row is not editable and a save fails.
      await actAs(orgAdmin);
      const orgDirectory = await capture("select public.get_admin_member_directory('', null, null, 50) as v", []);
      await asOwner();
      expect(orgDirectory.value.items.find((item) => item.userId === member)).toMatchObject({ chapterId: t.hhs, displayTitleEditable: false });
      for (const actor of [president, steward, member, otherAdmin, orgAdmin]) {
        await actAs(actor);
        refusals.push(await setTitle(member, t.hhs, "Secretary-Treasurer"));
        await asOwner();
      }
      await actAs(admin);
      const tooLong = await setTitle(member, t.hhs, "x".repeat(61));
      const control = await setTitle(member, t.hhs, "Trustee\u0007");
      const notMember = await setTitle(foreignMember, t.hhs, "Trustee");
      const foreignChapter = await setTitle(foreignMember, t.other, "Trustee");
      const allowed = await setTitle(member, t.hhs, "Trustee");
      await asOwner();
      await actAs(member);
      const direct = await capture("update public.member_chapter_memberships set display_title='President' where user_id=$1 and chapter_id=$2", [member, t.hhs]);
      await asOwner();

      for (const refused of refusals) expect(refused).toMatchObject({ ok: false, code: "42501", message: "admin role required" });
      expect(tooLong).toMatchObject({ ok: false, code: "22023" });
      expect(control).toMatchObject({ ok: false, code: "22023" });
      expect(notMember).toMatchObject({ ok: false, code: "22023", message: "membership not found" });
      expect(foreignChapter).toMatchObject({ ok: false, code: "42501" });
      expect(direct).toMatchObject({ ok: false, code: "42501" });
      expect(allowed.ok, allowed.message).toBe(true);
      expect(await titleOf(member, t.hhs)).toBe("Trustee");
    } finally {
      await client.query("rollback");
    }
  });
});
