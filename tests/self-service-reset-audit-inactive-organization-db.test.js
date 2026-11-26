// @vitest-environment node
//
// BUG-UG-SELF-SERVICE-RESET-LEAVES-NO-AUDIT-ROW-FOR-SUSPENDED-ORGANIZATION-MEMBER-20261112
// (#8552) on a disposable database. A completed self-service reset writes its
// member_admin_audit row (record_self_service_password_reset, under the
// service role) even when the member's selected organization is suspended or
// their organization membership ended: unscoped, the member as actor and
// target. Only that row, with its one boolean detail, passes the trigger's
// active-organization rule; every other row still gets 42501.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationSql } from "./helpers/migration.js";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const sql = loadMigrationSql("self_service_reset_audit_for_inactive_organization");

describe("self-service reset audit migration", () => {
  it("passes the real hosted transaction guard", () => {
    expect(sourceTransactionProblem(sql)).toBeNull();
  });
  it("pins its predecessor and refreshes the trigger's account lifecycle review row", () => {
    expect(sql).toContain("unreviewed predecessor: private.assign_member_admin_audit_organization");
    expect(sql).toContain("object_name = 'assign_member_admin_audit_organization()'");
    expect(sql).toContain("do update set definition_hash = excluded.definition_hash");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a self-service reset leaves an audit row whatever the organization's state, on a disposable database", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "self-service-reset-audit-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function inTransaction(body) {
    await client.query("begin");
    try {
      return await body();
    } finally {
      await client.query("rollback");
    }
  }

  async function member(state) {
    const user = randomUUID();
    await client.query("insert into auth.users(id,email,created_at) values ($1,$2,now())", [user, `${user}@reset-audit.invalid`]);
    if (state === "no chapter") return { user, organization: null };
    const organization = randomUUID();
    const chapter = `reset-audit-${organization}`;
    await client.query("insert into public.organizations(id,slug,name,status) values ($1,$2,$3,'active')",
      [organization, `rsa-${organization}`, `Reset Audit ${organization}`]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Proof',$1,'proof',$2,9992)", [chapter, organization]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [organization, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
    if (state === "suspended") await client.query("update public.organizations set status = 'suspended' where id = $1", [organization]);
    if (state === "membership ended") {
      await client.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [organization, user]);
    }
    return { user, organization };
  }

  async function recordReset(user, enrolled) {
    await client.query("savepoint reset_audit");
    try {
      await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
      await client.query("set local role service_role");
      const answer = (await client.query("select public.record_self_service_password_reset($1,$2) as ok", [user, enrolled])).rows[0].ok;
      await client.query("reset role");
      await client.query("release savepoint reset_audit");
      return answer;
    } catch (error) {
      await client.query("rollback to savepoint reset_audit");
      await client.query("reset role");
      return error.code;
    }
  }

  const rows = async (user) => (await client.query(
    "select actor, action, target_user, organization_id, detail from public.member_admin_audit where target_user = $1", [user])).rows;

  it("keeps the active organization on the row of a member of an active organization, and an orphan's row unscoped", () => inTransaction(async () => {
    const active = await member("active");
    expect(await recordReset(active.user, true)).toBe(true);
    expect(await rows(active.user)).toEqual([{ actor: active.user, action: "self_service_password_reset", target_user: active.user,
      organization_id: active.organization, detail: { twoStepEnrolled: true } }]);
    const orphan = await member("no chapter");
    expect(await recordReset(orphan.user, false)).toBe(true);
    expect(await rows(orphan.user)).toEqual([{ actor: orphan.user, action: "self_service_password_reset", target_user: orphan.user,
      organization_id: null, detail: { twoStepEnrolled: false } }]);
  }));

  for (const state of ["suspended", "membership ended"]) {
    it(`writes exactly one unscoped row for a member whose organization ${state === "suspended" ? "is suspended" : "membership ended"}`, () => inTransaction(async () => {
      for (const enrolled of [true, false]) {
        const { user } = await member(state);
        expect(await recordReset(user, enrolled)).toBe(true);
        expect(await rows(user)).toEqual([{ actor: user, action: "self_service_password_reset", target_user: user,
          organization_id: null, detail: { twoStepEnrolled: enrolled } }]);
      }
    }));
  }

  it("still refuses every other row from a member of a suspended organization", () => inTransaction(async () => {
    const { user, organization } = await member("suspended");
    const other = (await member("active")).user;
    const attempt = async ({ action = "self_service_password_reset", detail = { twoStepEnrolled: true }, target = user,
      role = "service_role", organizationId = null } = {}) => {
      await client.query("savepoint other_row");
      try {
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role })]);
        await client.query("insert into public.member_admin_audit (actor, action, target_user, detail, organization_id) values ($1,$2,$3,$4,$5)",
          [user, action, target, detail, organizationId]);
        return "written";
      } catch (error) {
        return error.code;
      } finally {
        await client.query("rollback to savepoint other_row");
      }
    };
    expect(await attempt()).toBe("written");
    expect(await attempt({ detail: {} })).toBe("42501");
    expect(await attempt({ detail: { twoStepEnrolled: "true" } })).toBe("42501");
    expect(await attempt({ detail: { twoStepEnrolled: true, note: "x" } })).toBe("42501");
    expect(await attempt({ target: other })).toBe("42501");
    expect(await attempt({ role: "authenticated" })).toBe("42501");
    expect(await attempt({ organizationId: organization })).toBe("42501");
    expect(await attempt({ action: "admin_mfa_reset" })).toBe("42501");
    // #8491's row keeps its own exact shape.
    expect(await attempt({ action: "mfa_recovery_code_used", detail: {} })).toBe("written");
    expect(await attempt({ action: "mfa_recovery_code_used", detail: { twoStepEnrolled: true } })).toBe("42501");
  }));
});
