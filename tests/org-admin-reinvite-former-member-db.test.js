// @vitest-environment node
//
// REQ-UG-ORG-ADMIN-REINVITE-FORMER-MEMBER-20260926
//
// An organization admin can re-add a former member by invitation.
// 20260927100000 adds public.create_former_member_invitation (organization
// admin + MFA, eligibility = revoked in this organization and active nowhere,
// account still exists), public.accept_former_member_invitation (service
// role: re-activates the membership and adds the invited chapter, no account
// and no role created) and removes the former-member branch from
// public.grant_member_chapter_membership.
//
// The live cases use two fictional tenants: Example Workers Local 1 (the
// admin's organization) and Example Transit Local 2. Every refusal has a
// same-organization control that must still succeed, so a check that refuses
// everything cannot pass. Every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, latestFnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const MIGRATION = "org_admin_reinvite_former_member";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const HASH = (pair) => pair.repeat(32);

function latestFunction(signature) {
  const migration = [...migrationFiles()].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${signature.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, signature));
}

describe("organization admin re-invitation of a former member (static)", () => {
  it("adds the reactivation kind, the two RPCs and the audit actions in one atomic migration after the tenant check", () => {
    const name = findMigrationName(MIGRATION);
    expect(name).toBe("20260927100000_org_admin_reinvite_former_member.sql");
    expect(name > "20260925965000_member_recovery_and_chapter_grant_tenant_check.sql").toBe(true);
    const sql = stripComments(loadMigrationSql(MIGRATION));
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("check (kind in ('provision', 'reactivation'))");
    expect(sql).toContain("check (kind = 'provision' or initial_role is null)");
    expect(sql).toContain("'invite_expired', 'reinvite_requested', 'reinvite_accepted'");
    expect(sql).toContain("grant execute on function public.create_former_member_invitation(text, text, text, text)\n  to authenticated;");
    expect(sql).toContain("grant execute on function public.accept_former_member_invitation(uuid)\n  to service_role;");
  });

  it("gates the re-invitation on the organization admin role with MFA and the revoked-here / active-nowhere target", () => {
    const create = latestFunction("public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)");
    expect(create).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(/);
    expect(create).toContain("caller_chapter text := private.require_member_invitation_admin_chapter();");
    expect(create).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(create).toContain("not private.has_organization_role(target_org, array['admin'])");
    // BUG-UG-INVITE-CHAPTER-LOCKED-TO-CURRENT-CHAPTER-20261003: any
    // chapter the caller administers in the selected organization.
    expect(create).toContain("or not private.member_invitation_chapter_administrable(p_chapter_id) then");
    expect(create).not.toContain("p_chapter_id is distinct from caller_chapter");
    expect(create.indexOf("private.has_organization_role")).toBeLessThan(create.indexOf("consume_member_invitation_admin_limit"));
    // Re-authorized after the organization-role lock: the second role check
    // sits after the lock and before any row is expired or inserted.
    const orgLock = create.indexOf("'organization-role:' || target_org::text");
    const reauth = create.indexOf("locked_org is distinct from target_org");
    expect(orgLock).toBeGreaterThan(-1);
    expect(reauth).toBeGreaterThan(orgLock);
    expect(create.indexOf("private.has_organization_role", reauth)).toBeGreaterThan(reauth);
    const cleanup = create.indexOf("perform private.expire_member_invitation_email(clean_email)");
    expect(cleanup).toBeGreaterThan(reauth);
    expect(create.indexOf("private.has_organization_role", reauth)).toBeLessThan(cleanup);
    expect(create).toContain("and om.status = 'revoked'");
    expect(create).toContain("where other.user_id = target_user and other.status = 'active'");
    expect(create).toContain("'reactivation')");
    expect(create).toContain("'reinvite_requested'");
    expect(create).toContain("'priorRevokedAt', prior_revoked_at");
    // Content-free audit: never the address, the name or free text.
    const audit = create.slice(create.indexOf("'reinvite_requested'"), create.indexOf("return pg_catalog.jsonb_build_object(\n    'accepted', true,\n    'send', true"));
    expect(audit).not.toMatch(/clean_email|full_name|first_name|p_email/);
    // No starting role and no account creation on this path.
    expect(create).not.toContain("initial_role in (");
    expect(create).not.toContain("insert into auth.users");
  });

  it("completes a reactivation without creating an account and refuses a membership that changed", () => {
    const accept = latestFunction("public.accept_former_member_invitation(p_invitation_id uuid)");
    expect(accept).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'");
    expect(accept).toContain("and kind = 'reactivation'");
    expect(accept).toContain("for update");
    expect(accept.indexOf("'organization-role:' || target_org::text")).toBeLessThan(accept.indexOf("'member-chapter:' || target_user::text"));
    expect(accept).toContain("set status = 'active', revoked_at = null");
    expect(accept).toContain("insert into public.member_chapter_memberships");
    expect(accept).toContain("'reinvite_accepted'");
    expect(accept).not.toContain("insert into auth.users");
    expect(accept).not.toContain("insert into public.member_roles");
    expect((accept.match(/raise exception 'invitation unavailable' using errcode = '22023'/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it("carries the kind through a resend and lets the service role read a committed reactivation", () => {
    const resend = latestFunction("public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)");
    // 20261022171700 (UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018) also
    // carries the source, so a resent roster invitation keeps its 7-day link.
    expect(resend).toContain("replaces_id, expires_at, kind, source)");
    expect(resend).toContain("case when old_row.source = 'roster' then interval '7 days' else interval '15 minutes' end,\n     old_row.kind, old_row.source)");
    // Resend admits a chapter President too, for plain-member invitations only.
    expect(resend).toContain("caller_chapter text := private.require_member_invitation_inviter_chapter();");
    expect(resend).toContain("and (private.member_invitation_chapter_administrable(chapter_id)");
    const outcome = latestFunction("public.get_former_member_invitation_outcome(p_invitation_id uuid)");
    expect(outcome).toContain("<> 'service_role'");
    expect(outcome).toContain("kind = 'reactivation'");
    expect(outcome).toContain("invitation_row.status = 'accepted' and invitation_row.auth_user_id is not null");
    expect(outcome).not.toContain("normalized_email");
    const sql = stripComments(loadMigrationSql(MIGRATION));
    expect(sql).toContain("grant execute on function public.get_former_member_invitation_outcome(uuid)\n  to service_role;");
  });

  it("removes the former-member branch from the chapter grant and returns the kind from the claim", () => {
    const grant = latestFunction("public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)");
    expect(grant).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(/);
    expect(grant).toContain("perform private.lock_message_lifecycle();");
    expect(grant).toContain("om.organization_id = target_org");
    expect(grant).toContain("and om.status = 'active'");
    expect(grant).not.toContain("om.status = 'revoked'");
    expect(grant).not.toContain("insert into public.organization_memberships");
    const claim = latestFunction("public.claim_member_invitation(p_token_hash text)");
    expect(claim).toContain("'kind', invitation_row.kind");
    const reader = stripComments(latestFnBody("list_member_invitation_audit"));
    expect(reader).toContain("'reinvite_requested', 'reinvite_accepted'");
  });

  it("pins the new surface in the database contract", () => {
    const create = contract.functions.find((row) => row.sig === "public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)");
    expect(create).toMatchObject({ exec: "authenticated", secdef: true });
    expect(create.bodyContains).toContain("private.mfa_satisfied()");
    expect(create.bodyContains).toContain("private.has_organization_role(target_org, array['admin'])");
    expect(create.bodyContains).toContain("private.require_member_invitation_admin_chapter()");
    expect(create.bodyContains).toContain("locked_org is distinct from target_org");
    const resend = contract.functions.find((row) => row.sig === "public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)");
    expect(resend.bodyContains).toContain("old_row.kind");
    const outcome = contract.functions.find((row) => row.sig === "public.get_former_member_invitation_outcome(p_invitation_id uuid)");
    expect(outcome).toMatchObject({ exec: "service_role", secdef: true });
    const accept = contract.functions.find((row) => row.sig === "public.accept_former_member_invitation(p_invitation_id uuid)");
    expect(accept).toMatchObject({ exec: "service_role", secdef: true });
    const grant = contract.functions.find((row) => row.sig === "public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)");
    expect(grant.bodyContains).toContain("and om.status = 'active'");
    expect(grant.bodyContains).not.toContain("other.organization_id <> target_org");
    const actions = contract.constraints.find((row) => row.name === "member_invitation_audit_action_check");
    expect(actions.defContains).toEqual(expect.arrayContaining(["'reinvite_requested'::text", "'reinvite_accepted'::text"]));
    expect(contract.constraints.find((row) => row.name === "member_invitations_kind_check")).toBeDefined();
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("organization admin re-invitation of a former member on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({
      connectionString: process.env.SUPABASE_DB_URL,
      application_name: "org-admin-reinvite-former-member-rollback-proof",
    });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const chapterA = `ewl1-a-${orgA}`;
    const chapterA2 = `ewl1-b-${orgA}`;
    const chapterB = `etl2-a-${orgB}`;
    await client.query(
      "insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `ewl1-${orgA}`, `Example Workers Local 1 ${orgA}`, orgB, `etl2-${orgB}`, `Example Transit Local 2 ${orgB}`],
    );
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,$1,$1,'proof',$4,9931), ($2,$2,$2,'proof',$4,9932), ($3,$3,$3,'proof',$5,9933)`,
      [chapterA, chapterA2, chapterB, orgA, orgB],
    );
    return { orgA, orgB, chapterA, chapterA2, chapterB };
  }

  async function person({ chapter = null, organization = null, chapterMembership = chapter, email = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, email ?? `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    if (organization) {
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
        [organization, id],
      );
    }
    if (chapterMembership) {
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
        [id, chapterMembership],
      );
    }
    return id;
  }

  // A member whose last chapter in the organization was removed: the
  // organization row is revoked, the chapter row is revoked.
  async function formerMember(t, { alsoActiveIn = null } = {}) {
    const id = await person({ chapter: null, organization: t.orgA, chapterMembership: t.chapterA });
    await client.query(
      "update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2",
      [id, t.chapterA],
    );
    await client.query(
      "update public.organization_memberships set status='revoked', revoked_at=now() - interval '3 days' where organization_id=$1 and user_id=$2",
      [t.orgA, id],
    );
    if (alsoActiveIn) {
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",
        [alsoActiveIn, id],
      );
    }
    return id;
  }

  async function chapterAdmin(t, { organizationAdmin = false, chapter = t.chapterA } = {}) {
    const id = await person({ chapter, organization: t.orgA });
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapter]);
    if (organizationAdmin) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, id]);
    }
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), id],
    );
    return id;
  }

  async function steward(t) {
    const id = await person({ chapter: t.chapterA, organization: t.orgA });
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [id, t.chapterA]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [id, t.chapterA]);
    return id;
  }

  async function actAs(userId, aal = "aal2") {
    const session = randomUUID();
    await client.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())",
      [session, userId, aal],
    );
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal, session_id: session }),
    ]);
    await client.query("set local role authenticated");
  }

  async function actAsService() {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    await client.query("set local role service_role");
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
      return { ok: true, row: result.rows[0], code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, row: null, code: error.code || "", message: error.message || "" };
    }
  }

  // Every audit row of one case is written inside its single transaction, so
  // created_at (default now()) ties, and a read through the (invitation_id,
  // created_at, id) index orders the tie by random id. cmin, the command that
  // inserted the row within this transaction, is the order they were written.
  const auditOrder = "order by created_at, cmin::text::bigint";
  const emailOf = async (id) => (await client.query("select email from auth.users where id=$1", [id])).rows[0].email;
  const invite = (email, chapter, hash) => capture(
    "select public.create_former_member_invitation($1,$2,'en',$3) as v", [email, chapter, hash],
  );

  it("lets an organization admin with MFA re-invite a former member and writes a content-free audit row naming the prior revocation", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await chapterAdmin(t, { organizationAdmin: true });
      const former = await formerMember(t);
      const formerEmail = await emailOf(former);

      await actAs(orgAdmin);
      const created = await invite(formerEmail, t.chapterA, HASH("a1"));
      await asOwner();
      expect(created.ok, created.message).toBe(true);
      expect(created.row.v).toMatchObject({ accepted: true, send: true });
      const invitationId = created.row.v.invitationId;
      expect(invitationId).toMatch(/^[0-9a-f-]{36}$/);

      const row = (await client.query(
        `select kind, status, initial_role, token_hash, chapter_id, invited_by, normalized_email,
                extract(epoch from (expires_at - clock_timestamp()))::int as remaining
           from public.member_invitations where id = $1`, [invitationId],
      )).rows[0];
      expect(row).toMatchObject({ kind: "reactivation", status: "pending", initial_role: null, token_hash: HASH("a1"), chapter_id: t.chapterA, invited_by: orgAdmin, normalized_email: formerEmail });
      expect(row.remaining).toBeGreaterThan(880);

      const audit = (await client.query(
        `select action, actor, chapter_id, detail from public.member_invitation_audit where invitation_id = $1 ${auditOrder}`, [invitationId],
      )).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: "reinvite_requested", actor: orgAdmin, chapter_id: t.chapterA });
      expect(audit[0].detail).toMatchObject({ chapterId: t.chapterA, organizationId: t.orgA, deliveryVersion: 1 });
      expect(typeof audit[0].detail.priorRevokedAt).toBe("string");
      expect(Object.keys(audit[0].detail).sort()).toEqual(["chapterId", "deliveryVersion", "locale", "organizationId", "priorRevokedAt"]);
      expect(JSON.stringify(audit[0].detail)).not.toContain("@");

      // Nothing about the membership changes until acceptance.
      const membership = (await client.query(
        "select status from public.organization_memberships where organization_id=$1 and user_id=$2", [t.orgA, former],
      )).rows[0];
      expect(membership.status).toBe("revoked");
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a chapter admin, a steward and an AAL1 organization admin, and answers no-send for an ineligible address", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await chapterAdmin(t, { organizationAdmin: true });
      const onlyChapterAdmin = await chapterAdmin(t);
      const stewardId = await steward(t);
      const former = await formerMember(t);
      const formerEmail = await emailOf(former);
      const activeElsewhere = await formerMember(t, { alsoActiveIn: t.orgB });
      const activeElsewhereEmail = await emailOf(activeElsewhere);
      const colleague = await person({ chapter: t.chapterA, organization: t.orgA });
      const colleagueEmail = await emailOf(colleague);
      const outsider = await person({ chapter: t.chapterB, organization: t.orgB });
      const outsiderEmail = await emailOf(outsider);

      await actAs(onlyChapterAdmin);
      const chapterAdminRefused = await invite(formerEmail, t.chapterA, HASH("b1"));
      await asOwner();
      await actAs(stewardId);
      const stewardRefused = await invite(formerEmail, t.chapterA, HASH("b2"));
      await asOwner();
      await actAs(orgAdmin, "aal1");
      const aal1Refused = await invite(formerEmail, t.chapterA, HASH("b3"));
      await asOwner();
      await actAs(orgAdmin);
      const otherOrgChapter = await invite(formerEmail, t.chapterB, HASH("b4"));
      const siblingChapter = await invite(formerEmail, t.chapterA2, HASH("b4b"));
      const activeElsewhereNoSend = await invite(activeElsewhereEmail, t.chapterA, HASH("b5"));
      const stillActiveNoSend = await invite(colleagueEmail, t.chapterA, HASH("b6"));
      const neverMemberNoSend = await invite(outsiderEmail, t.chapterA, HASH("b7"));
      const noAccountNoSend = await invite(`nobody-${randomUUID()}@example.invalid`, t.chapterA, HASH("b8"));
      const control = await invite(formerEmail, t.chapterA, HASH("b9"));
      await asOwner();

      expect(chapterAdminRefused).toMatchObject({ ok: false, code: "42501", message: "organization admin role required" });
      // The desk gate refuses a steward before the organization role is read.
      expect(stewardRefused).toMatchObject({ ok: false, code: "42501", message: "admin role required" });
      // At AAL1 the desk gate itself refuses (the chapter-admin role check
      // carries the second-factor requirement), as for every invitation write;
      // the explicit mfa check behind it is the same refusal for anyone who
      // passes the desk with a stale assurance level.
      expect(aal1Refused).toMatchObject({ ok: false, code: "42501", message: "admin role required" });
      expect(otherOrgChapter).toMatchObject({ ok: false, code: "42501", message: "organization admin role required" });
      // A sibling chapter of the same organization is refused too: every
      // invitation write (list, delivery record, resend, revoke) is scoped to
      // the desk's own chapter, so a row elsewhere would be one nobody could
      // administer.
      expect(siblingChapter).toMatchObject({ ok: false, code: "42501", message: "invitation not permitted" });
      for (const noSend of [activeElsewhereNoSend, stillActiveNoSend, neverMemberNoSend, noAccountNoSend]) {
        expect(noSend.ok, noSend.message).toBe(true);
        expect(noSend.row.v).toEqual({ accepted: true, send: false });
      }
      expect(control.ok, control.message).toBe(true);
      expect(control.row.v).toMatchObject({ accepted: true, send: true });

      const rows = (await client.query(
        "select normalized_email from public.member_invitations where token_hash = any($1::text[]) or normalized_email = any($2::text[])",
        [["b1", "b2", "b3", "b4", "b4b", "b5", "b6", "b7", "b8", "b9"].map(HASH), [formerEmail, activeElsewhereEmail, colleagueEmail, outsiderEmail]],
      )).rows;
      expect(rows.map((r) => r.normalized_email)).toEqual([formerEmail]);
    } finally {
      await client.query("rollback");
    }
  });

  it("re-activates the membership and adds the chapter on acceptance without creating an account or a role", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await chapterAdmin(t, { organizationAdmin: true });
      const former = await formerMember(t);
      const formerEmail = await emailOf(former);
      await actAs(orgAdmin);
      const created = await invite(formerEmail, t.chapterA, HASH("c1"));
      await asOwner();
      const invitationId = created.row.v.invitationId;
      const usersBefore = (await client.query("select count(*)::int as n from auth.users")).rows[0].n;

      await actAsService();
      const claim = await capture("select public.claim_member_invitation($1) as v", [HASH("c1")]);
      expect(claim.ok, claim.message).toBe(true);
      expect(claim.row.v).toMatchObject({ available: true, kind: "reactivation", invitationId });
      const accepted = await capture("select public.accept_former_member_invitation($1) as v", [invitationId]);
      const replay = await capture("select public.accept_former_member_invitation($1) as v", [invitationId]);
      await asOwner();
      expect(accepted.ok, accepted.message).toBe(true);
      expect(accepted.row.v).toEqual({ accepted: true, reactivated: true, userId: former });
      expect(replay).toMatchObject({ ok: false, code: "22023", message: "invitation unavailable" });

      const state = (await client.query(
        `select (select status from public.organization_memberships where organization_id=$1 and user_id=$2) as org_status,
                (select revoked_at from public.organization_memberships where organization_id=$1 and user_id=$2) as org_revoked_at,
                (select status from public.member_chapter_memberships where user_id=$2 and chapter_id=$3) as chapter_status,
                (select chapter_id from public.member_profiles where id=$2) as selected,
                (select count(*)::int from public.member_roles where user_id=$2) as roles,
                (select count(*)::int from auth.users) as users,
                (select status from public.member_invitations where id=$4) as invitation_status,
                (select token_hash from public.member_invitations where id=$4) as token_hash,
                (select auth_user_id from public.member_invitations where id=$4) as auth_user_id`,
        [t.orgA, former, t.chapterA, invitationId],
      )).rows[0];
      expect(state).toMatchObject({ org_status: "active", org_revoked_at: null, chapter_status: "active", selected: t.chapterA, roles: 0, users: usersBefore, invitation_status: "accepted", token_hash: null, auth_user_id: former });

      // After the commit the service role can read the outcome; the spent
      // token no longer claims.
      await actAsService();
      const outcome = await capture("select public.get_former_member_invitation_outcome($1) as v", [invitationId]);
      const reclaim = await capture("select public.claim_member_invitation($1) as v", [HASH("c1")]);
      await asOwner();
      expect(outcome.ok, outcome.message).toBe(true);
      expect(outcome.row.v).toEqual({ accepted: true });
      expect(reclaim.row.v).toEqual({ available: false });

      const audit = (await client.query(
        `select action, actor, detail from public.member_invitation_audit where invitation_id = $1 ${auditOrder}`, [invitationId],
      )).rows;
      expect(audit.map((r) => r.action)).toEqual(["reinvite_requested", "invite_claimed", "reinvite_accepted"]);
      expect(audit[2].actor).toBeNull();
      expect(audit[2].detail).toMatchObject({ chapterId: t.chapterA, organizationId: t.orgA, deliveryVersion: 1 });
      expect(typeof audit[2].detail.priorRevokedAt).toBe("string");
      expect(JSON.stringify(audit[2].detail)).not.toContain("@");
    } finally {
      await client.query("rollback");
    }
  });

  it("records delivery, resends as a reactivation and revokes from the same desk that issued it", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await chapterAdmin(t, { organizationAdmin: true });
      const former = await formerMember(t);
      const formerEmail = await emailOf(former);
      await actAs(orgAdmin);
      const created = await invite(formerEmail, t.chapterA, HASH("e1"));
      expect(created.ok, created.message).toBe(true);
      const invitationId = created.row.v.invitationId;
      const recorded = await capture(
        "select public.record_member_invitation_delivery($1,$2,'sent') as v", [invitationId, created.row.v.deliveryVersion],
      );
      const resent = await capture("select public.resend_member_invitation($1,$2) as v", [invitationId, HASH("e2")]);
      await asOwner();
      expect(recorded.ok, recorded.message).toBe(true);
      expect(recorded.row.v).toEqual({ recorded: true });
      expect(resent.ok, resent.message).toBe(true);
      expect(resent.row.v).toMatchObject({ accepted: true, send: true, deliveryVersion: 2, normalizedEmail: formerEmail });
      const replacementId = resent.row.v.invitationId;
      // Both rows use transaction-stable now(), so created_at ties here.
      // Request original then replacement explicitly; retain every field check.
      const rows = (await client.query(
        "select id, kind, status, initial_role, replaces_id from public.member_invitations where id = any($1::uuid[]) order by array_position($1::uuid[], id)",
        [[invitationId, replacementId]],
      )).rows;
      expect(rows).toEqual([
        { id: invitationId, kind: "reactivation", status: "superseded", initial_role: null, replaces_id: null },
        { id: replacementId, kind: "reactivation", status: "pending", initial_role: null, replaces_id: invitationId },
      ]);

      // The replacement is still a reactivation for the acceptance path.
      await actAsService();
      const claim = await capture("select public.claim_member_invitation($1) as v", [HASH("e2")]);
      await asOwner();
      expect(claim.row.v).toMatchObject({ available: true, kind: "reactivation", invitationId: replacementId, initialRole: null });

      const audit = (await client.query(
        `select action from public.member_invitation_audit where invitation_id = any($1::uuid[]) ${auditOrder}`, [[invitationId, replacementId]],
      )).rows.map((r) => r.action);
      expect(audit).toEqual(["reinvite_requested", "invite_sent", "invite_resent", "invite_claimed"]);
    } finally {
      await client.query("rollback");
    }
  });

  it("fails closed at acceptance when the account became active elsewhere, and the chapter grant never re-adds a former member", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await chapterAdmin(t, { organizationAdmin: true });
      const former = await formerMember(t);
      const formerEmail = await emailOf(former);
      await actAs(orgAdmin);
      const created = await invite(formerEmail, t.chapterA, HASH("d1"));
      await asOwner();
      const invitationId = created.row.v.invitationId;
      // Between issue and acceptance the person joined Example Transit Local 2.
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [t.orgB, former],
      );
      await actAsService();
      const claim = await capture("select public.claim_member_invitation($1) as v", [HASH("d1")]);
      const refused = await capture("select public.accept_former_member_invitation($1) as v", [invitationId]);
      await asOwner();
      expect(claim.row.v).toMatchObject({ available: true, kind: "reactivation" });
      expect(refused).toMatchObject({ ok: false, code: "22023", message: "invitation unavailable" });
      const state = (await client.query(
        `select (select status from public.organization_memberships where organization_id=$1 and user_id=$2) as org_status,
                (select count(*)::int from public.member_chapter_memberships where user_id=$2 and chapter_id=$3 and status='active') as chapter_rows,
                (select status from public.member_invitations where id=$4) as invitation_status`,
        [t.orgA, former, t.chapterA, invitationId],
      )).rows[0];
      expect(state).toEqual({ org_status: "revoked", chapter_rows: 0, invitation_status: "accepting" });
      // Not accepted: the outcome reader says so, and only to the service role.
      await actAsService();
      const outcome = await capture("select public.get_former_member_invitation_outcome($1) as v", [invitationId]);
      await asOwner();
      expect(outcome.row.v).toEqual({ accepted: false });
      await actAs(orgAdmin);
      const outcomeAsAdmin = await capture("select public.get_former_member_invitation_outcome($1) as v", [invitationId]);
      await asOwner();
      expect(outcomeAsAdmin.ok).toBe(false);
      expect(outcomeAsAdmin.code).toBe("42501");

      // The grant, from the organization admin's own desk, still refuses a
      // revoked former member (no membership elsewhere this time).
      const lapsed = await formerMember(t);
      await actAs(orgAdmin);
      const grantRefused = await capture("select public.grant_member_chapter_membership($1,$2) as v", [lapsed, t.chapterA2]);
      await asOwner();
      expect(grantRefused).toMatchObject({ ok: false, code: "22023", message: "membership target unavailable" });
      const untouched = (await client.query(
        "select status from public.organization_memberships where organization_id=$1 and user_id=$2", [t.orgA, lapsed],
      )).rows[0];
      expect(untouched.status).toBe("revoked");
    } finally {
      await client.query("rollback");
    }
  });
});
