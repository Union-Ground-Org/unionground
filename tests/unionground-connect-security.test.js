import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(
  join(
    root,
    "supabase",
    "migrations",
    "20261014005000_unionground_public_connect_intake.sql",
  ),
  "utf8",
);

describe("public connect persistence boundary", () => {
  it("stores only encrypted payload material in a private schema", () => {
    expect(sql).toContain("create table private.unionground_connect_requests");
    const tableDefinition = sql.match(
      /create table private\.unionground_connect_requests \(([\s\S]*?)\n\);/,
    )?.[1] || "";
    for (const column of [
      "payload_ciphertext",
      "payload_iv",
      "payload_auth_tag",
      "payload_digest",
      "key_version",
      "expires_at",
    ]) {
      expect(sql).toContain(column);
    }
    for (const forbidden of [
      "employer_name",
      "workplace_name",
      "coworker",
      "support_count",
      "card_count",
      "allegation",
      "narrative",
      "notes text",
    ]) {
      expect(tableDefinition.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("exposes one service-role-only idempotent, rate-limited writer", () => {
    expect(sql).toContain("create or replace function public.submit_unionground_connect_request");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).not.toContain("pg_catalog.coalesce");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("request id already used");
    expect(sql).toContain("attempt_count < 30");
    expect(sql).toContain("accepted_count < 5");
    expect(sql).toContain("unionground_connect_rate_buckets_expiry_idx");
    expect(sql).toContain("'reason', 'rate-limit'");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("interval '30 days'");
    expect(sql).toContain("purge_expired_unionground_connect_requests");
    expect(sql).toContain("get diagnostics v_requests = row_count");
    expect(sql).toContain("get diagnostics v_buckets = row_count");
  });

  it("revokes browser and service-role table access", () => {
    for (const table of [
      "private.unionground_connect_requests",
      "private.unionground_connect_rate_buckets",
    ]) {
      expect(sql).toContain(`revoke all on table ${table}`);
      expect(sql).toContain(`alter table ${table} enable row level security`);
      expect(sql).toContain(`alter table ${table} force row level security`);
    }
    expect(sql).toContain("from public, anon, authenticated, service_role");
  });
});
