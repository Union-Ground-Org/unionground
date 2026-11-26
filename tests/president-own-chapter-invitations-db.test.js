// @vitest-environment node
//
// BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003
//
// Owner decision, October 4, 2026: a chapter President may invite people into
// their own chapter only, as plain members. 20261004040000 admits the
// chapter-scoped vp role at the invitation desk; an admin keeps every existing
// right. Two fictional tenants (Harbor Workers Local 7, Ridge Transit Local 9);
// every refusal has an allowed control in the same transaction; every row is
// rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261004040000_president_own_chapter_invitations";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const HASH = (pair) => pair.repeat(32);

describe("President own-chapter invitations (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("adds one atomic migration whose President check is chapter-scoped and tenant-bound", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const presided = stripComments(fnBody(sql, "private.member_invitation_chapter_presided(p_chapter_id text)"));
    expect(presided).toContain("private.member_has_chapter_role(p_chapter_id, array['vp'])");
    expect(presided).toContain("rc.user_id = p.id and rc.chapter_id = target.id and rc.role = 'vp'");
    expect(presided).toContain("target.organization_id = selected.organization_id");
    expect(presided).not.toContain("organization_role_grants");
    for (const helper of ["private.member_invitation_chapter_presided(text)", "private.require_member_invitation_inviter_chapter()"]) {
      expect(sql).toContain(`revoke all on function ${helper}\n  from public, anon, authenticated, service_role;`);
      expect(sql).not.toContain(`grant execute on function ${helper}`);
    }
  });

  it("keeps the admin gate's locks and re-verification, and lets a President create only plain-member invitations", () => {
    const gate = stripComments(fnBody(sql, "private.require_member_invitation_inviter_chapter()"));
    expect(gate).toMatch(/begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    expect(gate.indexOf("'organization-role:' || selected_org::text")).toBeLessThan(gate.indexOf("locked_chapter is distinct from selected_chapter"));
    expect(gate).toContain("or private.member_invitation_chapter_presided(locked_chapter)) then");
    const create = stripComments(fnBody(sql, "public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)"));
    expect(create).toContain("if not as_admin and (clean_role is not null\n     or not private.member_invitation_chapter_presided(target_chapter)) then");
    expect(create.indexOf("if not as_admin")).toBeLessThan(create.indexOf("consume_member_invitation_admin_limit"));
    // The former-member path is not re-emitted: it stays behind the admin gate.
    expect(sql).not.toContain("function public.create_former_member_invitation");
  });

  it("pins both helpers in the database contract", () => {
    const presided = contract.functions.find((row) => row.sig === "private.member_invitation_chapter_presided(p_chapter_id text)");
    expect(presided).toMatchObject({ secdef: true, exec: "" });
    const gate = contract.functions.find((row) => row.sig === "private.require_member_invitation_inviter_chapter()");
    expect(gate).toMatchObject({ secdef: true, exec: "" });
    // Unit-required creation lives in the seven-argument core.
    const create = contract.functions.find((row) => row.sig.startsWith("public.create_member_invitation(") && row.sig.includes("p_unit_id uuid"));
    expect(create.bodyContains).toContain("private.require_member_invitation_inviter_chapter()");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("President own-chapter invitations on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "president-own-chapter-invitations-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  const fixtureUnits = new Map();

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
       values ($1,'Harbor Local',$1,'proof',$4,9951), ($2,'HHS Chapter',$2,'proof',$4,9952), ($3,'Ridge Chapter',$3,'proof',$5,9953)`,
      [local, hhs, other, orgA, orgB]);
    // Choose a real unit for every steward invitation.
    for (const row of (await client.query("select chapter_id,id from private.chapter_units where chapter_id=any($1::text[])", [[local,hhs,other]])).rows) fixtureUnits.set(row.chapter_id,row.id);
    return { orgA, orgB, local, hhs, other };
  }

  async function person({ chapter, organization, memberships = [chapter] }) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    for (const membership of memberships) {
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, membership]);
    }
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return id;
  }

  async function holder(t, role, chapter, { selected = chapter, memberships = [chapter], organizationGrant = false } = {}) {
    const id = await person({ chapter: selected, organization: t.orgA, memberships: [...new Set([selected, ...memberships])] });
    if (organizationGrant) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)", [t.orgA, id, role]);
    } else {
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
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "" };
    }
  }

  // Retain every desk refusal with a valid explicit unit.
  const create = (chapter, role, hash) => role === "steward" ? capture(
    "select public.create_member_invitation($1,'Proof Invitee',$2,$3,'en',$4,$5) as v", [`invitee-${randomUUID()}@example.invalid`, chapter, role, hash, fixtureUnits.get(chapter)]) : capture(
    "select public.create_member_invitation($1,'Proof Invitee',$2,$3,'en',$4) as v", [`invitee-${randomUUID()}@example.invalid`, chapter, role, hash]);
  const list = () => capture("select public.get_member_invitations(50) as v", []);
  const resend = (id, hash) => capture("select public.resend_member_invitation($1,$2) as v", [id, hash]);
  const revoke = (id) => capture("select public.revoke_member_invitation($1) as v", [id]);
  const record = (id, version, outcome) => capture("select public.record_member_invitation_delivery($1,$2,$3) as v", [id, version, outcome]);
  const row = async (id) => (await client.query("select chapter_id, status, initial_role, delivery_version from public.member_invitations where id=$1", [id])).rows[0];
  const selectedChapter = async (id) => (await client.query("select chapter_id from public.member_profiles where id=$1", [id])).rows[0].chapter_id;

  it("lets a chapter President invite a plain member into their chapter and manage it", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const president = await holder(t, "vp", t.hhs);
      await actAs(president);
      const created = await create(t.hhs, null, HASH("a1"));
      const listed = await list();
      const recorded = created.ok ? await record(created.value.invitationId, 1, "sent") : null;
      const resent = created.ok ? await resend(created.value.invitationId, HASH("a2")) : null;
      const revoked = resent?.ok ? await revoke(resent.value.invitationId) : null;
      await asOwner();

      expect(created.ok, created.message).toBe(true);
      expect(await row(created.value.invitationId)).toMatchObject({ chapter_id: t.hhs, initial_role: null });
      expect(listed.ok, listed.message).toBe(true);
      expect(listed.value.chapters).toEqual([{ id: t.hhs, name: "HHS Chapter", grantsAccess: false }]);
      expect(listed.value.items.map((item) => item.id)).toEqual([created.value.invitationId]);
      expect(recorded.value).toEqual({ recorded: true });
      expect(resent.value).toMatchObject({ accepted: true, send: true, deliveryVersion: 2 });
      expect(revoked.value).toEqual({ accepted: true, revoked: true });
      expect(await selectedChapter(president)).toBe(t.hhs);
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a President any starting access, another chapter, another organization and the former-member path", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const president = await holder(t, "vp", t.hhs);
      await actAs(president);
      const withAccess = await create(t.hhs, "steward", HASH("b1"));
      const otherChapter = await create(t.local, null, HASH("b2"));
      const otherOrg = await create(t.other, null, HASH("b3"));
      const former = await capture("select public.create_former_member_invitation($1,$2,'en',$3) as v", [`former-${randomUUID()}@example.invalid`, t.hhs, HASH("b4")]);
      const control = await create(t.hhs, null, HASH("b5"));
      await asOwner();

      for (const refused of [withAccess, otherChapter, otherOrg]) {
        expect(refused).toMatchObject({ ok: false, code: "42501", message: "invitation not permitted" });
      }
      expect(former).toMatchObject({ ok: false, code: "42501" });
      expect(control.ok, control.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("hides an admin's staff-access invitation from the President but shares plain-member ones", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.hhs);
      const president = await holder(t, "vp", t.hhs);
      await actAs(admin);
      const staffInvite = await create(t.hhs, "steward", HASH("c1"));
      const memberInvite = await create(t.hhs, null, HASH("c2"));
      await asOwner();
      expect(staffInvite.ok, staffInvite.message).toBe(true);
      expect(memberInvite.ok, memberInvite.message).toBe(true);

      await actAs(president);
      const listed = await list();
      const resentStaff = await resend(staffInvite.value.invitationId, HASH("c3"));
      const recordedStaff = await record(staffInvite.value.invitationId, 1, "failed");
      const revokedStaff = await revoke(staffInvite.value.invitationId);
      const revokedMember = await revoke(memberInvite.value.invitationId);
      await asOwner();

      expect(listed.value.items.map((item) => item.id)).toEqual([memberInvite.value.invitationId]);
      expect(resentStaff.value).toEqual({ accepted: true, send: false });
      expect(recordedStaff.value).toEqual({ recorded: false });
      expect(revokedStaff.value).toEqual({ accepted: true, revoked: false });
      expect(await row(staffInvite.value.invitationId)).toMatchObject({ status: "pending", initial_role: "steward", delivery_version: 1 });
      expect(revokedMember.value).toEqual({ accepted: true, revoked: true });
    } finally {
      await client.query("rollback");
    }
  });

  // Design pin changed by #6561 (REQ-UNIONGROUND-INVITE-RIGHTS-AND-ACCESS-
  // REQUESTS-20261030; Oct 29-30 swarm finding 26, MAIN ruling Oct 30, 2026):
  // an organization-wide President invites plain members directly, with the
  // same form and limits as a chapter President. Starting access stays
  // admin-only.
  it("treats an organization-wide vp grant as President of its organization's chapters, plain members only", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgVp = await holder(t, "vp", t.hhs, { organizationGrant: true });
      const president = await holder(t, "vp", t.hhs);
      await actAs(orgVp);
      const invited = await create(t.hhs, null, HASH("d1"));
      const listed = await list();
      const staffRefused = await create(t.hhs, "steward", HASH("d3"));
      await asOwner();
      await actAs(president);
      const control = await create(t.hhs, null, HASH("d2"));
      await asOwner();

      expect(invited.ok, invited.message).toBe(true);
      expect(listed.ok, listed.message).toBe(true);
      expect(staffRefused).toMatchObject({ ok: false, code: "42501" });
      expect(control.ok, control.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("keeps an admin's rights: any administered chapter and any starting access, with grantsAccess listed", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await holder(t, "admin", t.local, { memberships: [t.local, t.hhs] });
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [admin, t.hhs]);
      await actAs(admin);
      const staff = await create(t.hhs, "steward", HASH("e1"));
      const listed = await list();
      await asOwner();

      expect(staff.ok, staff.message).toBe(true);
      expect(listed.value.chapters).toEqual([
        { id: t.local, name: "Harbor Local", grantsAccess: true },
        { id: t.hhs, name: "HHS Chapter", grantsAccess: true },
      ]);
    } finally {
      await client.query("rollback");
    }
  });
});
