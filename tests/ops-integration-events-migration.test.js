// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("ops_integration_events");
const code = stripComments(sql);
const leastPrivilege = stripComments(loadMigrationSql("ops_integration_least_privilege"));

describe("operational integration audit migration", () => {
  it("stores sanitized incident and delivery metadata without raw payload columns", () => {
    expect(code).toContain("create table public.ops_integration_incidents");
    expect(code).toContain("create table public.ops_integration_deliveries");
    expect(code).toContain("source_event_id text not null");
    expect(code).not.toMatch(/\b(payload|request_body|raw_body|email_address|recipient)\b/i);
  });

  it("enforces hashed fingerprints and bounded lifecycle values", () => {
    expect(code).toContain("fingerprint ~ '^[a-f0-9]{64}$'");
    expect(code).toContain("source_event_id ~ '^[a-f0-9]{64}$'");
    expect(code).toContain("lifecycle in ('failure', 'recovery')");
    expect(code).toContain("status in ('processing', 'processed', 'failed')");
  });

  it("keeps both tables service-role-only with RLS and the MFA restrictive policy", () => {
    for (const table of ["ops_integration_incidents", "ops_integration_deliveries"]) {
      expect(code).toContain(`alter table public.${table} enable row level security`);
      expect(code).toContain(`create policy mfa_assurance on public.${table}`);
      expect(code).toContain(`revoke all on table public.${table} from public, anon, authenticated`);
      expect(code).toContain(`grant select, insert, update on table public.${table} to service_role`);
      expect(leastPrivilege).toContain(`revoke all on table public.${table} from service_role`);
      expect(leastPrivilege).toContain(`grant select, insert, update on table public.${table} to service_role`);
    }
  });
});
