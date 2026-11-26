// @vitest-environment node
//
// SEC-UG-MEMBER-RECOVERY-AND-CHAPTER-GRANT-TENANT-CHECK-20260925
//
// Tenant check missing on two member recovery routines and chapter grant.
// 20260925965000 gives public.grant_member_chapter_membership,
// public.begin_member_signin_recovery and public.begin_member_password_reissue
// the same-organization check the MFA reset boundary (20260924100000) already
// has, and stops private.handle_new_member() from honouring a sign-up metadata
// chapter that belongs to no organization without an invitation.
//
// The live cases use two fictional tenants: an administrator of Example
// Workers Local 1 and members of Example Transit Local 2. Each refusal has a
// same-organization control that must still succeed, so a check that refuses
// everything cannot pass.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const MIGRATION = "member_recovery_and_chapter_grant_tenant_check";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function latestFunction(signature) {
  const migration = [...migrationFiles()].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${signature.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, signature));
}

describe("member recovery and chapter grant tenant check (static)", () => {
  it("re-emits the four routines after the MFA reset boundary, lock first, with the tenant conjuncts", () => {
    const name = findMigrationName(MIGRATION);
    expect(name).toBe("20260925965000_member_recovery_and_chapter_grant_tenant_check.sql");
    expect(name > "20260924100000_mfa_reset_chapter_scope_boundary.sql").toBe(true);
    const sql = stripComments(loadMigrationSql(MIGRATION));
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);

    const grant = latestFunction("public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)");
    expect(grant).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(/);
    expect(grant).toContain("perform private.lock_message_lifecycle();");
    expect(grant).toContain("om.organization_id = target_org");
    // 20260927100000 (REQ-UG-ORG-ADMIN-REINVITE-FORMER-MEMBER-20260926):
    // the grant no longer re-activates an organization membership at all.
    expect(grant).not.toContain("insert into public.organization_memberships");
    expect(grant.indexOf("om.organization_id = target_org"))
      .toBeLessThan(grant.indexOf("insert into public.member_chapter_memberships"));

    const signin = latestFunction("public.begin_member_signin_recovery(p_target_user uuid, p_new_email_hash text, p_reason text)");
    expect(signin).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(/);
    expect(signin).toContain("c.organization_id = private.current_member_organization()");
    expect(signin).toContain("m.chapter_id = caller_chapter");
    expect(signin.indexOf("c.organization_id = private.current_member_organization()"))
      .toBeLessThan(signin.indexOf("consume_member_signin_recovery_limit"));

    const reissue = latestFunction("public.begin_member_password_reissue(p_target_user uuid)");
    expect(reissue).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(/);
    expect(reissue).toContain("tc.organization_id = cc.organization_id");
    expect(reissue.indexOf("tc.organization_id = cc.organization_id"))
      .toBeLessThan(reissue.indexOf("consume_member_signin_recovery_limit"));

    const trigger = latestFunction("private.handle_new_member()");
    expect(trigger).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(/);
    expect(trigger).not.toContain("c.id = member_chapter and c.organization_id is not null");
    expect(trigger).toContain("i.status = 'accepting'");
  });

  it("pins the tenant conjuncts in the database contract", () => {
    const expectations = {
      "public.grant_member_chapter_membership(p_user_id uuid, p_chapter_id text)": "om.organization_id = target_org",
      "public.begin_member_signin_recovery(p_target_user uuid, p_new_email_hash text, p_reason text)":
        "c.organization_id = private.current_member_organization()",
      "public.begin_member_password_reissue(p_target_user uuid)": "tc.organization_id = cc.organization_id",
    };
    for (const [sig, needle] of Object.entries(expectations)) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, sig).toBeDefined();
      expect(entry.bodyContains, sig).toContain(needle);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member recovery and chapter grant tenant check on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({
      connectionString: process.env.SUPABASE_DB_URL,
      application_name: "member-recovery-tenant-check-rollback-proof",
    });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  // Two fictional organizations; every row is rolled back.
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
       values ($1,$1,$1,'proof',$4,9921), ($2,$2,$2,'proof',$4,9922), ($3,$3,$3,'proof',$5,9923)`,
      [chapterA, chapterA2, chapterB, orgA, orgB],
    );
    return { orgA, orgB, chapterA, chapterA2, chapterB };
  }

  async function person({ chapter = null, organization = null, chapterMembership = chapter } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
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

  async function admin(t) {
    const id = await person({ chapter: t.chapterA, organization: t.orgA });
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, id]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, t.chapterA]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, t.chapterA]);
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), id],
    );
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",
      [session, userId],
    );
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
      return { ok: true, row: result.rows[0], code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, row: null, code: error.code || "", message: error.message || "" };
    }
  }

  const emailHash = (email) => createHash("sha256").update(email).digest("hex");

  it("refuses a chapter grant for a member of another organization and leaves their selected chapter alone", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const caller = await admin(t);
      const outsider = await person({ organization: t.orgB });
      const colleague = await person({ chapter: t.chapterA, organization: t.orgA });
      const ghost = randomUUID();
      // A former member of A (organization membership revoked with their last
      // chapter) is NOT added back by a grant since 20260927100000
      // (REQ-UG-ORG-ADMIN-REINVITE-FORMER-MEMBER-20260926: re-entry is an
      // organization admin's invitation); one who is now active in B is not
      // either.
      const former = await person({ chapter: t.chapterA, organization: t.orgA });
      const departed = await person({ chapter: t.chapterB, organization: t.orgB });
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,'revoked',now())",
        [t.orgA, departed],
      );
      await client.query(
        "update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2",
        [t.orgA, former],
      );
      // A former member of both A and B (revoked in each) is refused too: the
      // grant admits only an active member of the chapter's organization.
      const lapsed = await person({ organization: t.orgA });
      await client.query(
        "update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2",
        [t.orgA, lapsed],
      );
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,'revoked',now())",
        [t.orgB, lapsed],
      );

      await actAs(caller);
      const refused = await capture("select public.grant_member_chapter_membership($1,$2) as v", [outsider, t.chapterA]);
      const unknown = await capture("select public.grant_member_chapter_membership($1,$2) as v", [ghost, t.chapterA]);
      const departedRefused = await capture("select public.grant_member_chapter_membership($1,$2) as v", [departed, t.chapterA]);
      const allowed = await capture("select public.grant_member_chapter_membership($1,$2) as v", [colleague, t.chapterA2]);
      const readded = await capture("select public.grant_member_chapter_membership($1,$2) as v", [former, t.chapterA2]);
      const lapsedReadded = await capture("select public.grant_member_chapter_membership($1,$2) as v", [lapsed, t.chapterA2]);
      await asOwner();

      expect(refused).toMatchObject({ ok: false, code: "22023", message: "membership target unavailable" });
      expect(unknown).toMatchObject({ ok: false, code: refused.code, message: refused.message });
      expect(departedRefused).toMatchObject({ ok: false, code: refused.code, message: refused.message });
      expect(readded).toMatchObject({ ok: false, code: refused.code, message: refused.message });
      expect(lapsedReadded).toMatchObject({ ok: false, code: refused.code, message: refused.message });
      expect(allowed.ok).toBe(true);
      expect(allowed.row.v).toMatchObject({ userId: colleague, chapterId: t.chapterA2, active: true });

      const state = await client.query(
        `select (select chapter_id from public.member_profiles where id = $1) as selected,
                (select count(*)::int from public.organization_memberships where user_id = $1 and organization_id = $2) as org_rows,
                (select count(*)::int from public.member_chapter_memberships where user_id = $1 and chapter_id = $3) as chapter_rows`,
        [outsider, t.orgA, t.chapterA],
      );
      expect(state.rows[0]).toEqual({ selected: null, org_rows: 0, chapter_rows: 0 });

      // A refused re-add leaves the revoked organization row and no chapter
      // row; only a grant that went through writes an audit row.
      const restored = await client.query(
        `select (select status from public.organization_memberships where user_id = $1 and organization_id = $2) as org_status,
                (select status from public.member_chapter_memberships where user_id = $1 and chapter_id = $3) as chapter_status`,
        [former, t.orgA, t.chapterA2],
      );
      expect(restored.rows[0]).toEqual({ org_status: "revoked", chapter_status: null });
      const audit = await client.query(
        `select target_user, count(*)::int as n from public.member_admin_audit
         where action = 'grant_chapter_membership' and target_user = any($1::uuid[])
         group by target_user`,
        [[outsider, ghost, departed, colleague, former, lapsed]],
      );
      expect(Object.fromEntries(audit.rows.map((row) => [row.target_user, row.n])))
        .toEqual({ [colleague]: 1 });
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses sign-in recovery for a target whose selected chapter matches but who is not a member of the caller's organization", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const caller = await admin(t);
      // The state a cross-organization chapter row plus a selected chapter
      // would leave behind: active only in the other organization.
      const outsider = await person({ chapter: t.chapterA, organization: t.orgB, chapterMembership: t.chapterA });
      const colleague = await person({ chapter: t.chapterA, organization: t.orgA });
      // Active in both organizations: a whole-account change is refused here.
      const dual = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",
        [t.orgB, dual],
      );
      // Same organization and selected chapter, but no active row in it.
      const noChapterRow = await person({ chapter: t.chapterA, organization: t.orgA, chapterMembership: t.chapterA2 });
      // Chapter row and selected chapter in A, but no organization membership.
      const noOrgRow = await person({ chapter: t.chapterA, chapterMembership: t.chapterA });
      // Organization membership in A revoked; chapter row in A revoked.
      const revokedOrg = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query(
        "update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2",
        [t.orgA, revokedOrg],
      );
      const revokedChapter = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query(
        "update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2",
        [revokedChapter, t.chapterA],
      );
      // Control: a former member of B, now active only in A, is recovered here.
      const formerOfB = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,'revoked',now())",
        [t.orgB, formerOfB],
      );

      await actAs(caller);
      const refused = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [outsider, emailHash(`new-${outsider}@example.invalid`)],
      );
      const dualRefused = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [dual, emailHash(`new-${dual}@example.invalid`)],
      );
      const noRowRefused = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [noChapterRow, emailHash(`new-${noChapterRow}@example.invalid`)],
      );
      const noOrgRefused = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [noOrgRow, emailHash(`new-${noOrgRow}@example.invalid`)],
      );
      const revokedOrgRefused = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [revokedOrg, emailHash(`new-${revokedOrg}@example.invalid`)],
      );
      const revokedChapterRefused = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [revokedChapter, emailHash(`new-${revokedChapter}@example.invalid`)],
      );
      const allowed = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [colleague, emailHash(`new-${colleague}@example.invalid`)],
      );
      const formerOfBAllowed = await capture(
        "select public.begin_member_signin_recovery($1,$2,'lost_inbox') as v",
        [formerOfB, emailHash(`new-${formerOfB}@example.invalid`)],
      );
      await asOwner();

      expect(refused).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(dualRefused).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(noRowRefused).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(noOrgRefused).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(revokedOrgRefused).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(revokedChapterRefused).toMatchObject({ ok: false, code: "42501", message: "recovery unavailable" });
      expect(allowed.ok).toBe(true);
      expect(allowed.row.v).toMatchObject({ accepted: true, retry: false });
      expect(formerOfBAllowed.ok).toBe(true);
      expect(formerOfBAllowed.row.v).toMatchObject({ accepted: true, retry: false });
      const rows = await client.query(
        "select count(*)::int as n from private.member_signin_recoveries where target_user = $1",
        [outsider],
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a password reissue for a target that holds a chapter row but belongs to another organization", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const caller = await admin(t);
      const outsider = await person({ chapter: t.chapterB, organization: t.orgB, chapterMembership: t.chapterB });
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')",
        [outsider, t.chapterA],
      );
      const colleague = await person({ chapter: t.chapterA, organization: t.orgA });
      const dual = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')",
        [t.orgB, dual],
      );
      // Active in A with a chapter A row, but the selected chapter is in B
      // (where the membership was revoked).
      const selectsElsewhere = await person({ chapter: t.chapterB, organization: t.orgA, chapterMembership: t.chapterA });
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,'revoked',now())",
        [t.orgB, selectsElsewhere],
      );

      const noOrgRow = await person({ chapter: t.chapterA, chapterMembership: t.chapterA });
      const revokedOrg = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query(
        "update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2",
        [t.orgA, revokedOrg],
      );
      // Controls: a former member of B, now active only in A; and an A member
      // with no selected chapter (their last chapter elsewhere was removed).
      const formerOfB = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status,revoked_at) values ($1,$2,'revoked',now())",
        [t.orgB, formerOfB],
      );
      const noSelection = await person({ organization: t.orgA, chapterMembership: t.chapterA });

      await actAs(caller);
      const refused = await capture("select public.begin_member_password_reissue($1) as v", [outsider]);
      const revokedOrgRefused = await capture("select public.begin_member_password_reissue($1) as v", [revokedOrg]);
      const formerOfBAllowed = await capture("select public.begin_member_password_reissue($1) as v", [formerOfB]);
      const noSelectionAllowed = await capture("select public.begin_member_password_reissue($1) as v", [noSelection]);
      const noOrgRefused = await capture("select public.begin_member_password_reissue($1) as v", [noOrgRow]);
      const dualRefused = await capture("select public.begin_member_password_reissue($1) as v", [dual]);
      const elsewhereRefused = await capture("select public.begin_member_password_reissue($1) as v", [selectsElsewhere]);
      const allowed = await capture("select public.begin_member_password_reissue($1) as v", [colleague]);
      await asOwner();

      expect(refused).toMatchObject({ ok: false, code: "42501", message: "password reissue unavailable" });
      expect(dualRefused).toMatchObject({ ok: false, code: "42501", message: "password reissue unavailable" });
      expect(elsewhereRefused).toMatchObject({ ok: false, code: "42501", message: "password reissue unavailable" });
      expect(noOrgRefused).toMatchObject({ ok: false, code: "42501", message: "password reissue unavailable" });
      expect(revokedOrgRefused).toMatchObject({ ok: false, code: "42501", message: "password reissue unavailable" });
      expect(allowed.ok).toBe(true);
      expect(allowed.row.v).toMatchObject({ accepted: true, retry: false });
      expect(formerOfBAllowed.ok).toBe(true);
      expect(formerOfBAllowed.row.v).toMatchObject({ accepted: true, retry: false });
      expect(noSelectionAllowed.ok).toBe(true);
      expect(noSelectionAllowed.row.v).toMatchObject({ accepted: true, retry: false });
      const rows = await client.query(
        "select count(*)::int as n from private.member_password_reissues where target_user = $1",
        [outsider],
      );
      expect(rows.rows[0].n).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("ignores a sign-up metadata chapter without an invitation, including one that belongs to no organization", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orphan = `legacy-${randomUUID()}`;
      // Legacy chapters that belong to no organization cannot be written
      // any more; the guard trigger is paused only inside this rolled-back
      // transaction to stage one.
      await client.query("alter table public.chapters disable trigger chapters_forbid_ownerless_write");
      await client.query(
        "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',null,9924)",
        [orphan],
      );
      await client.query("alter table public.chapters enable trigger chapters_forbid_ownerless_write");

      const signup = async (chapter, invitationId = null, id = randomUUID()) => {
        const metadata = { chapter_id: chapter, full_name: "Example Member" };
        if (invitationId) metadata.union_base_invitation_id = invitationId;
        await client.query(
          "insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3::jsonb)",
          [id, `${id}@example.invalid`, JSON.stringify(metadata)],
        );
        const row = await client.query(
          `select p.chapter_id,
                  (select count(*)::int from public.member_chapter_memberships m where m.user_id = p.id) as chapter_rows,
                  (select count(*)::int from public.organization_memberships o where o.user_id = p.id) as org_rows
           from public.member_profiles p where p.id = $1`,
          [id],
        );
        return row.rows[0];
      };

      expect(await signup(orphan)).toEqual({ chapter_id: null, chapter_rows: 0, org_rows: 0 });
      expect(await signup(t.chapterA)).toEqual({ chapter_id: null, chapter_rows: 0, org_rows: 0 });

      // Control: an accepting invitation for the named chapter still places
      // the new account in it and in its organization.
      const inviter = await admin(t);
      const invitation = randomUUID();
      const invitee = randomUUID();
      await client.query(
        `insert into public.member_invitations (
           id, normalized_email, full_name, first_name, initials, chapter_id,
           token_hash, status, invited_by, expires_at, accepting_at
         ) values ($1, $2, 'Example Member', 'Example', 'EM', $3,
           repeat('a', 64), 'accepting', $4, now() + interval '1 hour', now())`,
        [invitation, `${invitee}@example.invalid`, t.chapterA, inviter],
      );
      expect(await signup(t.chapterA, invitation, invitee)).toEqual({ chapter_id: t.chapterA, chapter_rows: 1, org_rows: 1 });
    } finally {
      await client.query("rollback");
    }
  });
});
