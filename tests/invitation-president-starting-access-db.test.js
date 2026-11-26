// @vitest-environment node
//
// REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006
//
// Owner decision, October 8, 2026 (question 7, option A): officer titles are
// display labels only, President can be chosen when inviting, and chapter
// authority stays separate from organization-wide tools. 20261008122000 lets
// an administrator of the target chapter start an invitee as President; the
// accepted invitation makes them President of that chapter only, which is the
// grant that chapter's administrator can already make after joining. Two
// fictional tenants (Harbor Workers Local 7, Ridge Transit Local 9); every
// refusal has an allowed control in the same transaction; every row is
// rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261008122000_invitation_president_starting_access";
const CREATE = "public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const HASH = (pair) => pair.repeat(32);

describe("President as invitation starting access (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const create = stripComments(fnBody(sql, CREATE));

  it("is one atomic migration that widens the stored role set by vp only", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("drop constraint member_invitations_initial_role_check;");
    expect(sql).toContain("check (initial_role is null or initial_role in ('steward', 'coordinator', 'advisor', 'vp'));");
    expect(create).toContain("clean_role not in ('steward', 'coordinator', 'advisor', 'vp')");
    // Admin is still never a starting access.
    expect(sql).not.toMatch(/initial_role in \([^)]*'admin'/);
    expect(create).not.toMatch(/clean_role[^;]{0,300}'admin'/);
  });

  it("keeps every other create rule: the inviter gate, the admin-only starting access and the rate limits", () => {
    expect(create).toContain("caller_chapter text := private.require_member_invitation_inviter_chapter();");
    expect(create).toContain("as_admin := private.member_invitation_chapter_administrable(target_chapter);");
    expect(create).toContain("if not as_admin and (clean_role is not null\n     or not private.member_invitation_chapter_presided(target_chapter)) then");
    expect(create.indexOf("if not as_admin")).toBeLessThan(create.indexOf("consume_member_invitation_admin_limit"));
    expect(create).toContain("interval '15 minutes'");
    expect(sql).toContain("revoke all on function public.create_member_invitation(text, text, text, text, text, text)\n  from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.create_member_invitation(text, text, text, text, text, text)\n  to authenticated;");
    // Nothing else is re-emitted: accept, SCIM and the organization-wide grant stay as they were.
    for (const untouched of ["finalize_member_invitation", "scim_mapped_role", "set_member_organization_role", "organization_role_grants"]) {
      expect(sql).not.toContain(untouched);
    }
  });

  it("pins the widened constraint and create body in the database contract", () => {
    const check = contract.constraints.find((row) => row.name === "member_invitations_initial_role_check");
    for (const role of ["steward", "coordinator", "advisor", "admin", "vp", "secretary", "records", "treasurer"]) {
      expect(check.defContains.join(" ")).toContain(`'${role}'::text`);
    }
    // Unit-required creation lives in the seven-argument core.
    const pinned = contract.functions.find((row) => row.sig === CREATE.replace("p_token_hash text)","p_token_hash text, p_unit_id uuid)"));
    expect(pinned.bodyContains).toContain("clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp', 'admin', 'secretary', 'records', 'treasurer')");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("President as invitation starting access on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "invitation-president-starting-access-rollback-proof" });
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

  async function holder(t, role, chapter) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.orgA, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
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
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "" };
    }
  }

  const invitee = () => `invitee-${randomUUID()}@example.invalid`;
  const create = (chapter, role, hash, email = invitee()) => capture(
    "select public.create_member_invitation($1,'Proof Invitee',$2,$3,'en',$4) as v", [email, chapter, role, hash]);

  it("lets a chapter administrator start an invitee as President of that chapter only", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.hhs);
      const email = invitee();
      await actAs(admin);
      const created = await create(t.hhs, "vp", HASH("a1"), email);
      const adminRole = await create(t.hhs, "admin", HASH("a2"));
      const otherOrg = await create(t.other, "vp", HASH("a3"));
      await asOwner();

      expect(created.ok, created.message).toBe(true);
      expect(adminRole.ok, adminRole.message).toBe(true);
      expect(otherOrg).toMatchObject({ ok: false, code: "42501" });
      const id = created.value.invitationId;
      expect((await client.query("select chapter_id, initial_role from public.member_invitations where id=$1", [id])).rows[0])
        .toEqual({ chapter_id: t.hhs, initial_role: "vp" });

      // Accept: the invitee account the activation path prepares, then the
      // service-role finalize that turns initial_role into a role row.
      const user = randomUUID();
      await client.query("update public.member_invitations set status='accepting', accepting_at=now() where id=$1", [id]);
      await client.query(
        `insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,banned_until)
         values ($1,$2,$3::jsonb,'{"union_ground_provisioning":"pending"}'::jsonb, now() + interval '1 hour')`,
        [user, email, JSON.stringify({ union_base_invitation_id: id, chapter_id: t.hhs })]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, t.hhs]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, t.hhs]);
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
      const finalized = await capture("select public.finalize_member_invitation($1,$2) as v", [id, user]);
      await asOwner();

      expect(finalized.ok, finalized.message).toBe(true);
      expect((await client.query("select role, chapter_id from public.member_role_chapters where user_id=$1", [user])).rows)
        .toEqual([{ role: "vp", chapter_id: t.hhs }]);
      // Chapter authority only: no organization-wide grant of any role.
      expect((await client.query("select count(*)::int as n from public.organization_role_grants where user_id=$1", [user])).rows[0].n).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("still refuses a chapter President any starting access, President included", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const president = await holder(t, "vp", t.hhs);
      await actAs(president);
      const asPresident = await create(t.hhs, "vp", HASH("b1"));
      const control = await create(t.hhs, null, HASH("b2"));
      await asOwner();

      expect(asPresident).toMatchObject({ ok: false, code: "42501", message: "invitation not permitted" });
      expect(control.ok, control.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("stores President in the table and nothing outside the starting-access set", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.hhs);
      const insert = (role, hash) => capture(
        `insert into public.member_invitations (normalized_email, full_name, first_name, initials, chapter_id, initial_role, locale, token_hash, status, delivery_version, invited_by, expires_at)
         values ($1,'Proof Invitee','Proof','PI',$2,$3,'en',$4,'pending',1,$5, now() + interval '15 minutes') returning initial_role as v`,
        [invitee(), t.hhs, role, hash, admin]);
      const vp = await insert("vp", HASH("c1"));
      const adminRow = await insert("admin", HASH("c2"));
      expect(vp).toMatchObject({ ok: true, value: "vp" });
      expect(adminRow).toMatchObject({ ok: true, value: "admin" });
      const unsupported = await insert("unsupported", HASH("c3"));
      expect(unsupported).toMatchObject({ ok: false, code: "23514" });
    } finally {
      await client.query("rollback");
    }
  });
});
