// @vitest-environment node
//
// BUG-UG-ORGANIZATION-CHAPTERLESS-ADMIN-VP-LOCKED-OUT-INTEGRATION-CONTROL-RPC-20260921
//
// An organization-only admin or VP — an active organization membership and an
// organization_role_grants row, no member_chapter_memberships — passed
// private.has_organization_role() and every sibling surface, but the
// integration control plane resolved its tenant through the chapter-bound
// private.mi1_require_selected_organization() and refused the same caller with
// 'active organization membership required'.
//
// Static half: pins the forward migration's resolver, the retained admin/vp
// gate, and the fact that list_organization_integrations now shares the guard.
// Live half (SUPABASE_DB_URL on the disposable loopback target): the
// chapterless admin reads the providers, a chapterless non-admin is still
// refused, two active organizations still fail closed, a selected chapter
// still wins, and no other tenant's row is ever returned.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "integration_control_chapterless_organization_admin";
const sql = stripComments(loadMigrationSql(MIGRATION));

describe("chapterless integration admin migration (static)", () => {
  it("sorts after the caller-completion projection migration it was written against", () => {
    expect(findMigrationName(MIGRATION) > "20260921221000_organization_coordination_caller_completion_projection.sql").toBe(true);
  });

  it("resolves the control-plane tenant the way has_organization_role already does", () => {
    const guard = fnBody(sql, "private.mi1_require_integration_admin()");
    expect(guard).toContain("private.current_mobile_staff_organization()");
    // The chapter-bound resolver is the defect; it must not come back.
    expect(guard).not.toContain("private.mi1_require_selected_organization()");
    expect(guard).not.toContain("private.current_member_organization()");
    // Nothing about the authorization decision moves: still MFA, still an
    // active tenant, still an organization admin/vp grant.
    expect(guard).toContain("private.mfa_satisfied()");
    expect(guard).toContain("active organization membership required");
    expect(guard).toContain("private.has_organization_role(org, array['admin', 'vp'])");
    expect(guard).toContain("security definer");
    expect(guard).toContain("set search_path = ''");
    expect(guard).toContain("stable");
    // A tenant key is never an argument, so it can never be a wildcard.
    expect(guard).not.toMatch(/p_organization_id/);
  });

  it("puts the single inlined reader back on the shared guard without widening its projection", () => {
    const reader = fnBody(sql, "public.list_organization_integrations()");
    expect(reader).toContain("private.mi1_require_integration_admin()");
    expect(reader).not.toContain("private.mi1_require_selected_organization()");
    expect(reader).toContain("private.mfa_satisfied()");
    expect(reader).toContain("private.has_organization_role(org, array['admin', 'vp'])");
    expect(reader).toContain("where i.organization_id = org");
    expect(reader).toContain("hasCredentialRef");
    expect(reader).not.toContain("credential_ref,");
  });

  it("keeps the guard unexecutable and the reader authenticated-only", () => {
    expect(sql).toContain("revoke all on function private.mi1_require_integration_admin()\n  from public, anon, authenticated, service_role;");
    expect(sql).not.toMatch(/grant execute on function private\.mi1_require_integration_admin/);
    expect(sql).toContain("revoke all on function public.list_organization_integrations()\n  from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.list_organization_integrations() to authenticated;");
    expect(sql).not.toMatch(/grant execute on function public\.list_organization_integrations\(\) to (anon|service_role)/);
  });
});

const ID = {
  orgA: "50922100-0000-4000-8000-000000000001",
  orgB: "50922100-0000-4000-8000-000000000002",
  chapterA: "chapterless-integration-proof-a",
  chapterlessAdmin: "50922100-0000-4000-8000-000000000101",
  chapterlessMember: "50922100-0000-4000-8000-000000000102",
  dualOrganizationAdmin: "50922100-0000-4000-8000-000000000103",
  chapteredAdmin: "50922100-0000-4000-8000-000000000104",
  orgBAdmin: "50922100-0000-4000-8000-000000000105",
};

const SESSION_FOR = {
  [ID.chapterlessAdmin]: "50922100-0000-4000-8000-000000000201",
  [ID.chapterlessMember]: "50922100-0000-4000-8000-000000000202",
  [ID.dualOrganizationAdmin]: "50922100-0000-4000-8000-000000000203",
  [ID.chapteredAdmin]: "50922100-0000-4000-8000-000000000204",
  [ID.orgBAdmin]: "50922100-0000-4000-8000-000000000205",
};

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapterless integration admin (disposable database)", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapterless-integration-admin-proof",
    });
    await client.connect();
    await client.query("begin");
    await seed();
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  async function seed() {
    for (const [user, email] of [
      [ID.chapterlessAdmin, "chapterless-admin"],
      [ID.chapterlessMember, "chapterless-member"],
      [ID.dualOrganizationAdmin, "dual-organization-admin"],
      [ID.chapteredAdmin, "chaptered-admin"],
      [ID.orgBAdmin, "org-b-admin"],
    ]) {
      await client.query(
        "insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}'::jsonb)",
        [user, `${email}@example.invalid`],
      );
      await client.query(
        "insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')",
        [SESSION_FOR[user], user],
      );
    }

    for (const [organization, slug] of [[ID.orgA, "chapterless-proof-a"], [ID.orgB, "chapterless-proof-b"]]) {
      await client.query(
        "insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)",
        [organization, slug, ID.chapterlessAdmin],
      );
      // Staff second-factor enrolment is a separate axis from this defect.
      await client.query(
        "insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by) values (true, $1, false, $2)",
        [organization, ID.chapterlessAdmin],
      );
    }

    // Only the control persona gets a chapter; every other caller here is
    // organization-only, which is the whole point of the record.
    await client.query(
      "insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, 'Chapterless Proof A', $1, false, 9911, $2)",
      [ID.chapterA, ID.orgA],
    );

    const memberships = [
      [ID.orgA, ID.chapterlessAdmin],
      [ID.orgA, ID.chapterlessMember],
      [ID.orgA, ID.dualOrganizationAdmin],
      [ID.orgB, ID.dualOrganizationAdmin],
      [ID.orgA, ID.chapteredAdmin],
      [ID.orgB, ID.orgBAdmin],
    ];
    for (const [organization, user] of memberships) {
      await client.query(
        "insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')",
        [organization, user],
      );
    }

    const grants = [
      [ID.orgA, ID.chapterlessAdmin, "admin"],
      [ID.orgA, ID.dualOrganizationAdmin, "admin"],
      [ID.orgB, ID.dualOrganizationAdmin, "admin"],
      [ID.orgA, ID.chapteredAdmin, "vp"],
      [ID.orgB, ID.orgBAdmin, "admin"],
    ];
    for (const [organization, user, role] of grants) {
      await client.query(
        "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)",
        [organization, user, role],
      );
    }

    await client.query(
      "insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')",
      [ID.chapteredAdmin, ID.chapterA],
    );
    await client.query("update public.member_profiles set chapter_id = $1 where id = $2", [ID.chapterA, ID.chapteredAdmin]);

    for (const [organization, provider] of [[ID.orgA, "google_calendar"], [ID.orgA, "twilio"], [ID.orgB, "google_calendar"]]) {
      await client.query(
        "insert into public.organization_integrations (organization_id, provider, status) values ($1, $2, 'configured')",
        [organization, provider],
      );
    }
  }

  async function callAs(userId, statement) {
    await client.query("savepoint chapterless_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId,
        role: "authenticated",
        session_id: SESSION_FOR[userId],
        aal: "aal2",
      })]);
      await client.query("set local role authenticated");
      const result = await client.query(statement);
      await client.query("reset role");
      await client.query("rollback to savepoint chapterless_probe");
      return { code: "", message: "", value: result.rows[0]?.value ?? null };
    } catch (error) {
      await client.query("rollback to savepoint chapterless_probe");
      return { code: error.code || "?", message: error.message || "", value: null };
    }
  }

  const listIntegrations = (userId) => callAs(userId, "select public.list_organization_integrations() as value");
  const providersOf = (value) => (value || []).map((row) => row.provider).sort();

  it("returns the organization's providers to an admin with no chapter membership", async () => {
    // The sibling surface the record compares against already resolves this
    // caller; the control plane now agrees instead of raising 42501.
    const scope = await callAs(ID.chapterlessAdmin, "select public.get_my_mobile_staff_scope() as value");
    expect(scope.value).toMatchObject({ organizationId: ID.orgA, roles: ["admin"], staffAuthorized: true });

    const listed = await listIntegrations(ID.chapterlessAdmin);
    expect(listed.code).toBe("");
    expect(listed.message).not.toContain("active organization membership required");
    expect(providersOf(listed.value)).toEqual(["google_calendar", "twilio"]);
    // Never another tenant's row, and never the credential itself.
    for (const row of listed.value) {
      expect(row.organizationId).toBe(ID.orgA);
      expect(row).not.toHaveProperty("credentialRef");
      expect(row.hasCredentialRef).toBe(false);
    }
  });

  it("extends the same resolution to the rest of the control plane", async () => {
    for (const rpc of [
      "public.list_chapter_integration_overrides()",
      "public.list_integration_webhooks()",
      "public.list_integration_api_keys()",
    ]) {
      const result = await callAs(ID.chapterlessAdmin, `select ${rpc} as value`);
      expect(result.code, rpc).toBe("");
      expect(result.value, rpc).toEqual([]);
    }
  });

  it("still refuses a chapterless member who holds no organization admin or vp grant", async () => {
    const refused = await listIntegrations(ID.chapterlessMember);
    expect(refused.code).toBe("42501");
    expect(refused.message).toContain("not authorized");
  });

  it("still fails closed for a caller with two active organizations and no chapter", async () => {
    const refused = await listIntegrations(ID.dualOrganizationAdmin);
    expect(refused.code).toBe("42501");
    expect(refused.message).toContain("active organization membership required");
  });

  it("keeps a selected chapter authoritative and never crosses tenants", async () => {
    const chaptered = await listIntegrations(ID.chapteredAdmin);
    expect(chaptered.code).toBe("");
    expect(providersOf(chaptered.value)).toEqual(["google_calendar", "twilio"]);

    const other = await listIntegrations(ID.orgBAdmin);
    expect(other.code).toBe("");
    expect(other.value.map((row) => row.organizationId)).toEqual([ID.orgB]);
  });

  it("refuses an unauthenticated caller before any tenant work", async () => {
    await client.query("savepoint chapterless_anon");
    await client.query("select set_config('request.jwt.claims', null, true)");
    await client.query("set local role authenticated");
    await expect(client.query("select public.list_organization_integrations()")).rejects.toThrow(/authentication required/);
    await client.query("rollback to savepoint chapterless_anon");
  });
});
