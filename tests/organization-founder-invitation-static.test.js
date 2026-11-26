// @vitest-environment node
// Offline pins for 20261003010000_organization_founder_invitations.sql. The
// live behaviour is proved by tests/organization-founder-invitation-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foreignKeyRelevance, helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "_organization_founder_invitations.sql";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SERVICE_RPCS = [
  "public.create_organization_founder_invitation(text, text, text, text, text, uuid)",
  "public.record_organization_founder_invitation_delivery(uuid, integer, text)",
  "public.resend_organization_founder_invitation(uuid, text)",
];

describe("operator founder invitations migration (static)", () => {
  const name = findMigrationName(MIGRATION);
  const sql = loadMigrationSql(MIGRATION);
  const code = stripComments(sql);
  const functions = parseFunctions(sql, name);

  it("applies after the latest invitation and organization-shell migrations, in one short transaction", () => {
    expect(name).toBe("20261003010000_organization_founder_invitations.sql");
    expect(name > findMigrationName("org_admin_reinvite_former_member")).toBe(true);
    expect(name > findMigrationName("_self_serve_organization_shell.sql")).toBe(true);
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code).toContain("set local statement_timeout = '60s';");
  });

  it("only widens the invitation kind and adds no foreign key", () => {
    expect(code).toContain("check (kind in ('provision', 'reactivation', 'founder'))");
    expect(foreignKeyRelevance(sql)).toBeNull();
    expect(code).not.toMatch(/create table|add column|drop table|drop function/i);
  });

  it("re-emits none of the pinned invitation routines", () => {
    for (const pinned of [
      "create_member_invitation", "claim_member_invitation", "finalize_member_invitation",
      "complete_member_invitation_activation", "record_member_invitation_delivery",
      "resend_member_invitation", "handle_new_member", "create_my_organization", "bootstrap_first_organization",
    ]) {
      expect(code).not.toMatch(new RegExp(`function (public|private)\\.${pinned}\\(`));
    }
  });

  it("takes the case-graph gate first in all four routines", () => {
    expect(functions.map((fn) => fn.name).sort()).toEqual([
      "private.grant_founder_organization_admin",
      "public.create_organization_founder_invitation",
      "public.record_organization_founder_invitation_delivery",
      "public.resend_organization_founder_invitation",
    ]);
    for (const fn of functions) expect(helperFirst(fn.source), fn.name).toBe(true);
    expect(code.match(/security definer\nset search_path = ''\nas \$function\$/g)).toHaveLength(4);
  });

  it("lets only the service role reach the three operator routines, and no role reach the trigger function", () => {
    for (const signature of SERVICE_RPCS) {
      expect(code).toContain(`revoke all on function ${signature}\n  from public, anon, authenticated, service_role;`);
      expect(code).toContain(`grant execute on function ${signature}\n  to service_role;`);
      const body = functions.find((fn) => signature.startsWith(`${fn.name}(`)).source;
      expect(body).toContain("if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then");
    }
    expect(code).toContain("revoke all on function private.grant_founder_organization_admin()\n  from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant execute on function private\.grant_founder_organization_admin/);
    expect(code).not.toMatch(/to (anon|authenticated)\s*;/);
  });

  it("creates an operator-provisioned organization: no creator, no self-serve stamp, staff MFA on", () => {
    const create = functions.find((fn) => fn.name === "public.create_organization_founder_invitation").source;
    expect(create).toContain("insert into public.organizations (slug, name, status, created_by)\n    values (new_slug, clean_name, 'active', null)");
    expect(create).not.toContain("self_serve_created_at");
    expect(create).toContain("values (true, org_id, true, null);");
    expect(create).toContain("'founder')");
    expect(create).toContain("pg_catalog.clock_timestamp() + interval '15 minutes'");
    expect(create).not.toMatch(/insert into (auth\.users|public\.organization_memberships|public\.organization_role_grants|public\.member_profiles)/);
    expect(create).toContain("return pg_catalog.jsonb_build_object('status', 'email_unavailable');");
    expect(create.indexOf("set status = 'expired', token_hash = null")).toBeLessThan(create.indexOf("'email_unavailable'"));
    expect(create).not.toContain("and i.expires_at > pg_catalog.clock_timestamp()");
    expect(create).toContain("return pg_catalog.jsonb_build_object('status', 'name_unavailable');");
  });

  it("grants the administrator role only when an operator-issued founder invitation becomes accepted", () => {
    expect(code).toContain(
      "create trigger z50_founder_admin_on_accept\n  after update of status on public.member_invitations\n  for each row\n"
      + "  when (new.status = 'accepted'\n        and old.status is distinct from 'accepted'\n        and new.kind = 'founder'\n        and new.invited_by is null)\n"
      + "  execute function private.grant_founder_organization_admin();",
    );
    const grant = functions.find((fn) => fn.name === "private.grant_founder_organization_admin").source;
    expect(grant).toContain("values (org_id, new.auth_user_id, 'admin', null)");
    expect(grant).toContain("on conflict (organization_id, user_id, role) do nothing;");
  });

  it("registers the trigger and its function with the account-lifecycle review and asserts it is complete", () => {
    expect(code).toContain("insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)");
    expect(code).toContain("and s.object_name = 'z50_founder_admin_on_accept')");
    expect(code).toContain("and s.object_name = 'grant_founder_organization_admin()')");
    expect(code).toContain("if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then");
    expect(code.indexOf("account_lifecycle_trigger_review")).toBeGreaterThan(code.indexOf("create trigger z50_founder_admin_on_accept"));
  });

  it("refuses a founder resend once the organization has an administrator", () => {
    const resend = functions.find((fn) => fn.name === "public.resend_organization_founder_invitation").source;
    expect(resend).toContain("where id = p_invitation_id and kind = 'founder' and invited_by is null");
    expect(resend.indexOf("g.role = 'admin'")).toBeLessThan(resend.indexOf("set status = 'superseded'"));
  });

  it("is recorded in the database contract", () => {
    for (const signature of [
      "public.create_organization_founder_invitation(p_organization_name text, p_email text, p_full_name text, p_locale text, p_token_hash text, p_idempotency_key uuid)",
      "public.record_organization_founder_invitation_delivery(p_invitation_id uuid, p_delivery_version integer, p_outcome text)",
      "public.resend_organization_founder_invitation(p_invitation_id uuid, p_token_hash text)",
      "private.grant_founder_organization_admin()",
    ]) {
      const entry = contract.functions.find((fn) => fn.sig === signature);
      expect(entry, signature).toBeDefined();
      expect(entry.secdef).toBe(true);
      expect(entry.exec).toBe(signature.startsWith("private.") ? "" : "service_role");
    }
    expect(contract.triggers.find((t) => t.name === "z50_founder_admin_on_accept")).toMatchObject({
      schema: "public", table: "member_invitations", function: "private.grant_founder_organization_admin", timing: "AFTER",
    });
  });
});
