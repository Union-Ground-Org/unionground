// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921 (owner ruling
// 2026-09-25, SINGLE-USE EMAIL CONFIRMATION): a public stop request takes
// effect only after the requester opens a single-use, 24-hour link; until
// then nothing is suppressed; public responses stay non-enumerating. These
// pins read the migration text; the live behaviour is
// tests/public-interest-stop-confirmation-db.test.js.
const NAME = "20260925990000_public_interest_stop_confirmation";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const predecessor = stripComments(loadMigrationSql("20260831105356_public_interest_suppression"));
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
const REQUEST = "public.request_public_interest_stop(p_email text, p_locale text, p_source text, p_website text, p_scope_hash text, p_email_scope_hash text, p_token_hash text)";
const CONFIRM = "public.confirm_public_interest_stop(p_token_hash text, p_scope_hash text)";

function fn(source, name, file = `${NAME}.sql`) {
  const entry = parseFunctions(source, file).find((row) => row.name === name);
  expect(entry, name).toBeTruthy();
  return stripComments(entry.source);
}

describe("public-interest stop confirmation migration", () => {
  it("runs as one forward-only transaction after the suppression migration it extends", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260831105356_public_interest_suppression").toBe(true);
    expect(code).toContain("notify pgrst, 'reload schema';");
  });

  it("keeps the pending row definer-only, digest-keyed, 24-hour bounded and never browser-readable", () => {
    const table = code.slice(
      code.indexOf("create table private.public_interest_stop_confirmations"),
      code.indexOf("comment on table private.public_interest_stop_confirmations"),
    );
    expect(table).toContain("token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$')");
    expect(table).toContain("normalized_email text not null check (");
    expect(table).toContain("locale text not null check (locale in ('en', 'es'))");
    expect(table).toContain("source text not null check (source = 'public-landing')");
    expect(table).toContain("expires_at timestamptz not null");
    expect(table).toContain("constraint public_interest_stop_confirmations_window_check check (expires_at > created_at)");
    expect(table).toContain("alter table private.public_interest_stop_confirmations enable row level security;");
    expect(table).toContain("alter table private.public_interest_stop_confirmations force row level security;");
    expect(table).toContain("revoke all on table private.public_interest_stop_confirmations from public, anon, authenticated, service_role;");
    expect(code).not.toMatch(/grant\s+[^;]+on\s+(table\s+)?private\.public_interest_stop_confirmations/i);
    expect(code).not.toMatch(/create policy[^;]*public_interest_stop_confirmations/i);
    expect(table).toContain("on private.public_interest_stop_confirmations (expires_at)");
  });

  it("makes the request record only the pending digest under the stop limits and suppress nothing", () => {
    const source = fn(sql, "public.request_public_interest_stop");
    const order = [
      "if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then",
      "if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then",
      "if pg_catalog.btrim(coalesce(p_website, '')) <> '' then",
      "p_scope_hash, 'stop-network-15m', 20, interval '15 minutes'",
      "p_email_scope_hash, 'stop-email-day', 3, interval '1 day'",
      "p_source is distinct from 'public-landing'",
      "insert into private.public_interest_stop_confirmations (",
      "p_token_hash, normalized_email, p_locale, p_source, moment, moment + interval '24 hours'",
      "delete from private.public_interest_stop_confirmations as stale",
      "delete from private.public_interest_submission_limits as stale",
      "'accepted', network_allowed and email_allowed and not payload_invalid",
    ];
    let last = -1;
    for (const needle of order) {
      const at = source.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }
    // Nothing is suppressed until the link is used: the request touches
    // neither the ledger nor the subscription rows, and never reads them.
    expect(source).not.toContain("public_interest_suppressions");
    expect(source).not.toContain("public_interest_submissions ");
    expect(source).not.toContain("public.public_interest_submissions");
    expect(source).not.toContain("public_interest_suppression_scope");
    expect(code).toMatch(/revoke all on function public\.request_public_interest_stop\(text, text, text, text, text, text, text\)\s+from public, anon, authenticated, service_role;/);
    expect(code).toMatch(/grant execute on function public\.request_public_interest_stop\(text, text, text, text, text, text, text\)\s+to service_role;/);
  });

  it("makes the confirmation single-use, time-limited, uniformly refused and identical in effect to the immediate stop", () => {
    const source = fn(sql, "public.confirm_public_interest_stop");
    const order = [
      "if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then",
      "p_scope_hash, 'stop-network-15m', 20, interval '15 minutes'",
      "return pg_catalog.jsonb_build_object('confirmed', false, 'refusal', 'rate-limited');",
      "if clean_hash !~ '^[0-9a-f]{64}$' then",
      "where token_hash = clean_hash\n  for update;",
      "if not found then",
      "if pending_row.expires_at <= moment then",
      "delete from private.public_interest_stop_confirmations where token_hash = clean_hash;",
      "derived_suppression_scope_hash := private.public_interest_suppression_scope(pending_row.normalized_email);",
      "'public-interest-suppression:' || derived_suppression_scope_hash",
      "insert into private.public_interest_suppressions (",
      "on conflict (suppression_scope_hash) do update",
      "delete from public.public_interest_submissions\n  where email = pending_row.normalized_email;",
      "delete from private.public_interest_stop_confirmations\n  where normalized_email = pending_row.normalized_email;",
      "return pg_catalog.jsonb_build_object('confirmed', true);",
    ];
    let last = -1;
    for (const needle of order) {
      const at = source.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }
    // Unknown, expired and consumed tokens share one refusal payload.
    expect(source.match(/return pg_catalog\.jsonb_build_object\('confirmed', false, 'refusal', 'unavailable'\);/g)).toHaveLength(3);
    // The suppression effect is the immediate stop function's, verbatim.
    const immediate = fn(predecessor, "public.stop_public_interest", "20260831105356.sql");
    for (const shared of [
      "insert into private.public_interest_suppressions (",
      "suppression_scope_hash, source, locale, created_at, last_requested_at",
      "on conflict (suppression_scope_hash) do update",
      "set last_requested_at = excluded.last_requested_at;",
      "delete from public.public_interest_submissions",
    ]) {
      expect(immediate).toContain(shared);
      expect(source).toContain(shared);
    }
    expect(code).toMatch(/revoke all on function public\.confirm_public_interest_stop\(text, text\)\s+from public, anon, authenticated, service_role;/);
    expect(code).toMatch(/grant execute on function public\.confirm_public_interest_stop\(text, text\)\s+to service_role;/);
  });

  it("leaves the immediate stop function as the operator-verified path and pins the new objects in the contract", () => {
    expect(code).not.toContain("function public.stop_public_interest");
    expect(code).not.toContain("drop function");
    const functions = Object.fromEntries(contract.functions.map((entry) => [entry.sig, entry]));
    expect(functions[REQUEST]).toMatchObject({ secdef: true, exec: "service_role" });
    expect(functions[CONFIRM]).toMatchObject({ secdef: true, exec: "service_role" });
    expect(functions[REQUEST].bodyContains).toContain("insert into private.public_interest_stop_confirmations (");
    expect(functions[CONFIRM].bodyContains).toContain("delete from private.public_interest_stop_confirmations where token_hash = clean_hash;");
    expect(functions["public.stop_public_interest(p_email text, p_locale text, p_source text, p_website text, p_scope_hash text, p_email_scope_hash text)"])
      .toMatchObject({ exec: "service_role" });
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual({ table: "private.public_interest_stop_confirmations", role, privileges: "" });
    }
    expect(contract.constraints.find((entry) => entry.table === "private.public_interest_stop_confirmations" && entry.name === "public_interest_stop_confirmations_window_check"))
      .toMatchObject({ convalidated: true, defContains: ["expires_at > created_at"] });
  });

  it("registers the live proof with its case floor", () => {
    expect(PROOF_FILES).toContain("tests/public-interest-stop-confirmation-db.test.js");
  });
});
