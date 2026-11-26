// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-STORE-INVITE-REQUESTS-AND-OPERATOR-READ-20261118:
// offline pins on what the migration says. The live proof is
// tests/intake-review-db.test.js; the live catalog is scripts/db-contract.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(new URL("../supabase/migrations/20261118160000_intake_review_operator_queue.sql", import.meta.url), "utf8");

function body(name) {
  const plain = SQL.indexOf(`create function ${name}(`);
  const start = plain >= 0 ? plain : SQL.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const ends = ["\n$$;", "\n$function$;"].map((tag) => SQL.indexOf(tag, start)).filter((at) => at > 0);
  return SQL.slice(start, Math.min(...ends));
}

const QUEUE = [
  "public.list_intake_requests",
  "public.intake_request_summary",
  "public.export_intake_requests",
  "public.set_intake_request_status",
  "public.set_intake_request_note",
];
const SERVICE_ONLY = [...QUEUE, "public.submit_invite_request", "public.set_platform_operator_intake_review", "public.set_platform_operator"];

describe("intake review migration", () => {
  it("runs in one transaction", () => {
    expect(SQL).toMatch(/^begin;$/m);
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("checks the service role and then an intake_review operator in every queue function, and reads only rows with no organization", () => {
    for (const name of QUEUE) {
      const text = body(name);
      expect(text, name).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'");
      expect(text.indexOf("intake_review_require_operator"), name).toBeGreaterThan(text.indexOf("service_role"));
      expect(text, name).toContain("organization_id is null");
      expect(text, name).toMatch(/security definer\s+set search_path = ''/);
    }
  });

  it("requires the claim verifier's session rule with the intake_review capability", () => {
    const text = body("private.intake_review_require_operator");
    for (const needle of [
      "private.member_mfa_recovery_locks", "session.aal = 'aal2'", "private.verified_key_session",
      "session.not_after", "boundary.invalid_before", "factor.status = 'verified'", "u.deleted_at is null",
      "u.banned_until", "operator.revoked_at is null", "'intake_review' = any (operator.capabilities)",
      "raise exception 'intake reviewer required' using errcode = '42501'",
    ]) expect(text).toContain(needle);
    expect(text).not.toContain("'claim_verification'");
  });

  it("grants every new public function to the service role only", () => {
    for (const name of SERVICE_ONLY) {
      expect(SQL, name).toMatch(new RegExp(`revoke all on function ${name.replace(".", "\\.")}\\([^)]*\\)\\s+from public, anon, authenticated, service_role;`));
      expect(SQL, name).toMatch(new RegExp(`grant execute on function ${name.replace(".", "\\.")}\\([^)]*\\)\\s+to service_role;`));
    }
    expect(SQL).not.toMatch(/grant [^;]* to (anon|authenticated)/);
    expect(SQL).toContain("revoke all on private.intake_review_events from public, anon, authenticated, service_role;");
    expect(SQL).toContain("alter table private.intake_review_events force row level security;");
  });

  it("stores invite requests behind the landing limits and suppression check, and never changes the operator's status or note", () => {
    const text = body("public.submit_invite_request");
    for (const needle of [
      "'network-15m', 20, interval '15 minutes'", "'email-interest-day', 3, interval '1 day'",
      "private.public_interest_suppressions", "'request_invite', locale_value, 'request-invite'",
      "on conflict (email, interest) do update", "with picked as materialized (",
      "notify := private.consume_public_interest_submission_limit(", "'notify', stored and notify",
    ]) expect(text).toContain(needle);
    // The day cap stops support emails only; it never wraps the store.
    expect(text).not.toMatch(/if private\.consume_public_interest_submission_limit\(\s*p_email_scope_hash/);
    const update = text.slice(text.indexOf("do update"), text.indexOf("stored := found;"));
    expect(update).not.toMatch(/status|operator_note/);
  });

  it("never writes a note body or an address into the ledger", () => {
    expect(SQL).not.toMatch(/insert into private\.intake_review_events \([^)]*(note|email)/);
  });

  it("keeps claim_verification and intake_review from clobbering each other", () => {
    const claim = body("public.set_platform_operator");
    expect(claim).toContain("current_row.capabilities || 'claim_verification'::text");
    expect(claim).toContain("pg_catalog.array_remove(current_row.capabilities, 'claim_verification')");
    const intake = body("public.set_platform_operator_intake_review");
    expect(intake).toContain("current_row.capabilities || 'intake_review'::text");
    expect(intake).toContain("pg_catalog.array_remove(current_row.capabilities, 'intake_review')");
  });
});
