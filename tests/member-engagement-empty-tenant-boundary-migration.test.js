import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260829020000_member_engagement_empty_tenant_boundary.sql",
  ),
  "utf8",
).toLowerCase();

describe("member engagement empty-tenant boundary migration", () => {
  it("keeps the tenant-scoped implementations private and inaccessible", () => {
    for (const statement of [
      "alter function public.evaluate_contextual_pulse(text, text) set schema private",
      "alter function public.heartbeat_member_presence(text) set schema private",
      "alter function public.get_member_engagement_snapshot() set schema private",
      "revoke all on function private.engagement_evaluate_contextual_pulse_scoped(text, text)",
      "revoke all on function private.engagement_heartbeat_member_presence_scoped(text)",
      "revoke all on function private.engagement_member_snapshot_scoped()",
    ]) {
      expect(migration).toContain(statement);
    }
  });

  it("returns honest empty results without creating fictional state", () => {
    expect(migration.match(/if org is null then/g)).toHaveLength(3);
    expect(migration).toContain("return null;");
    expect(migration).toContain("'status', 'unavailable', 'lastseenat', null");
    for (const key of [
      "'surveys', '[]'::jsonb",
      "'pulseprompts', '[]'::jsonb",
      "'livepolls', '[]'::jsonb",
      "'actions', '[]'::jsonb",
      "'keywordhits', '[]'::jsonb",
      "'briefings', '[]'::jsonb",
    ]) {
      expect(migration).toContain(key);
    }
    expect(migration).not.toMatch(/\binsert\s+into\b/);
  });

  it("preserves authentication, MFA, membership, and least-privilege gates", () => {
    expect(migration.match(/actor is null/g)).toHaveLength(3);
    expect(migration.match(/private\.mfa_satisfied\(\)/g)).toHaveLength(3);
    expect(migration.match(/private\.is_organization_member\(org\)/g)).toHaveLength(3);
    expect(migration).toContain(
      "revoke all on function public.evaluate_contextual_pulse(text, text)",
    );
    expect(migration).toContain(
      "revoke all on function public.heartbeat_member_presence(text)",
    );
    expect(migration).toContain(
      "revoke all on function public.get_member_engagement_snapshot()",
    );
    expect(migration.match(/from public, anon, authenticated, service_role/g)).toHaveLength(6);
    expect(migration.match(/to authenticated;/g)).toHaveLength(3);
    expect(migration).toContain("notify pgrst, 'reload schema'");
  });
});
