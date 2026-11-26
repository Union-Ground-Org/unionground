// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// REQ-UG-INVITE-TERMS-AGE-STATE-FORM-CLARITY-20261030: the service-only
// invitation preview read.
const sql = loadMigrationSql("20261030213003_member_invitation_preview");
const code = stripComments(sql);
const preview = stripComments(fnBody(sql, "public.preview_member_invitation"));

describe("the invitation preview read", () => {
  it("is service-role only and granted to nothing else", () => {
    expect(preview).toContain("security definer");
    expect(preview).toContain("set search_path = ''");
    expect(preview).toContain("if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then");
    expect(code).toContain("revoke all on function public.preview_member_invitation(text) from public, anon, authenticated;");
    expect(code).toContain("grant execute on function public.preview_member_invitation(text) to service_role;");
    expect(code).not.toMatch(/grant[^;]*to[^;]*\b(anon|authenticated)\b/iu);
  });

  it("describes only a pending, unexpired invitation and changes nothing", () => {
    expect(preview).toContain("and i.status = 'pending'");
    expect(preview).toContain("and i.expires_at > pg_catalog.clock_timestamp()");
    expect(preview).toContain("return pg_catalog.jsonb_build_object('available', false);");
    expect(preview).not.toMatch(/\b(update|insert|delete)\b|for update|lock_case_graph|audit_member_invitation/iu);
  });

  // An operator-issued founder is accepted as the
  // organization admin (private.grant_founder_organization_admin).
  it("names the role acceptance grants, admin for an operator-issued founder", () => {
    expect(preview).toContain("case when i.kind = 'founder' and i.invited_by is null then 'admin' else i.initial_role end as granted_role");
    expect(preview).toContain("'role', found_row.granted_role");
  });
});
