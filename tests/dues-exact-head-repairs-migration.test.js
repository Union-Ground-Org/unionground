// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20260831223000_mi1_dues_exact_head_repairs.sql", "utf8");

describe("Dues exact-head repair migration", () => {
  it("lets service-only Dues operations write tenant audit while preserving the session boundary", () => {
    expect(sql).toContain("create or replace function private.mi1_write_tenant_audit");
    expect(sql).toContain("request_role <> 'service_role'");
    expect(sql).toContain("p_organization_id is distinct from private.current_member_organization()");
    expect(sql).toContain("from public.organizations organization");
    expect(sql).toContain("'requestedBy', saved.requested_by");
    expect(sql).toContain("service audit actor unavailable");
  });

  it("retains an exchanged account before provider deauthorization recovery", () => {
    expect(sql).toContain("public.record_dues_stripe_oauth_recovery_account");
    expect(sql).toContain("auth.jwt() ->> 'role'");
    expect(sql).toContain("saved.callback_lease_epoch <> p_lease_epoch");
    expect(sql).toContain("saved.callback_lease_owner is distinct from p_lease_owner");
    expect(sql).toContain("exchanged_account_id = p_account_id");
    expect(sql).not.toContain("set exchange_account_id = p_account_id");
    expect(sql).toContain("grant execute on function public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text) to service_role");
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });

  it("keeps the live readiness account ID on a service-only exact-context seam", () => {
    expect(sql).toContain("public.read_dues_stripe_account_for_test");
    expect(sql).toContain("membership.organization_id = p_organization_id");
    expect(sql).toContain("membership.user_id = p_requested_by");
    expect(sql).toContain("role_grant.role = p_selected_hat");
    expect(sql).toContain("'organizationId', org");
    expect(sql).toContain("grant execute on function public.read_dues_stripe_account_for_test(uuid, uuid, text) to service_role");
    expect(sql).not.toContain("grant execute on function public.read_dues_stripe_account_for_test(uuid, uuid, text) to authenticated");
  });
});
