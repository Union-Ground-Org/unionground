// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const FRAGMENT = "20260826002000_pay_scale_expected_organization_guard";
const sql = loadMigrationSql(FRAGMENT);
const code = stripComments(sql);

function body(name) {
  return stripComments(fnBody(sql, name));
}

describe("Pay write expected-organization guard migration", () => {
  it("has one reserved migration filename", () => {
    expect(migrationNames().filter((name) => name.startsWith("20260826002000"))).toEqual([
      "20260826002000_pay_scale_expected_organization_guard.sql",
    ]);
  });

  it("compares the required intent token to the server-derived organization", () => {
    const guard = body("private.mi1_require_expected_selected_organization");
    expect(guard).toMatch(/security definer/i);
    expect(guard).toMatch(/set search_path = ''/i);
    expect(guard).toContain("org uuid := private.mi1_require_selected_organization()");
    expect(guard).toContain("p_expected_organization_id is null");
    expect(guard).toContain("p_expected_organization_id is distinct from org");
    expect(guard).toContain("pay organization scope changed");
    expect(guard).toContain("errcode = '42501'");
    expect(code).toContain("revoke all on function private.mi1_require_expected_selected_organization(uuid)");
  });

  it("removes both unguarded public write signatures", () => {
    expect(code).toContain("drop function if exists public.upsert_pay_scale_grade(text, text, text, integer, text)");
    expect(code).toContain("drop function if exists public.upsert_pay_scale_step(text, date, integer, integer)");
  });

  it("keeps the expected organization non-authoritative in both writers", () => {
    for (const name of ["public.upsert_pay_scale_grade", "public.upsert_pay_scale_step"]) {
      const writer = body(name);
      expect(writer, name).toMatch(/security definer/i);
      expect(writer, name).toMatch(/set search_path = ''/i);
      expect(writer, name).toContain("org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id)");
      expect(writer, name).toContain("private.mfa_satisfied()");
      expect(writer, name).toContain("private.has_organization_role(org, array['advisor', 'admin', 'vp'])");
      expect(writer, name).toContain("organization_id = org");
      expect(writer, name).toContain("private.mi1_write_tenant_audit(org");
      expect(writer.match(/p_expected_organization_id/g)).toHaveLength(2);
    }
  });

  it("revokes broad execution before granting only the guarded signatures", () => {
    expect(code).toContain(
      "revoke all on function public.upsert_pay_scale_grade(uuid, text, text, text, integer, text)\nfrom public, anon, authenticated, service_role",
    );
    expect(code).toContain(
      "revoke all on function public.upsert_pay_scale_step(uuid, text, date, integer, integer)\nfrom public, anon, authenticated, service_role",
    );
    expect(code).toContain(
      "grant execute on function public.upsert_pay_scale_grade(uuid, text, text, text, integer, text) to authenticated",
    );
    expect(code).toContain(
      "grant execute on function public.upsert_pay_scale_step(uuid, text, date, integer, integer) to authenticated",
    );
  });
});
