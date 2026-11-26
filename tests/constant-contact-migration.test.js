// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260830233000_constant_contact_integration.sql", import.meta.url),
  "utf8",
);

describe("Constant Contact persistence contract", () => {
  it("keeps OAuth state and token metadata private and refresh tokens in Vault", () => {
    expect(migration).toContain("create table private.constant_contact_oauth_states");
    expect(migration).toContain("create table private.constant_contact_oauth_tokens");
    expect(migration).toContain("vault.create_secret");
    expect(migration).toContain("vault.decrypted_secrets");
    expect(migration).not.toMatch(/\baccess_token\b/i);
    expect(migration).not.toMatch(/\braw_payload\b/i);
    expect(migration).not.toMatch(/create table public\.constant_contact[^;]*\bemail\b/is);
  });

  it("fails closed for service-only RPCs and denies direct client table access", () => {
    expect(migration).toContain("if coalesce((select auth.role()), '') <> 'service_role' then");
    for (const table of [
      "constant_contact_sync_requests",
      "constant_contact_member_analytics",
      "constant_contact_sync_runs",
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from public, anon, authenticated`);
    }
    expect(migration).toContain("revoke all on function private.constant_contact_require_service()");
  });

  it("derives organization scope from the authenticated caller or claimed job", () => {
    expect(migration).toContain("private.mi1_require_integration_admin()");
    expect(migration).toContain("member outside job organization");
    expect(migration).toContain("source.organization_id = org");
    expect(migration).not.toMatch(/p_organization_id uuid[\s\S]{0,300}enqueue_constant_contact_sync/i);
    expect(migration).toContain("p_processed_count > 25");
    expect(migration).toContain("p_limit_count not between 1 and 25");
    expect(migration).toContain("create function public.enqueue_due_constant_contact_sync()");
    expect(migration).toContain("order by token.last_sync_at asc nulls first");
    expect(migration).toContain("order by analytics.synced_at asc nulls first");
    expect(migration).toContain("delete from private.constant_contact_oauth_states state");
  });
});
