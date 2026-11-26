// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, latestFnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.

const sql = loadMigrationSql("member_calendar_feed");

describe("calendar feed migration security invariants", () => {
  it("keeps cancelled meetings out of the effective subscription resolver", () => {
    const feed = latestFnBody("public.get_calendar_feed_events(");
    expect(feed).toContain("where r.user_id = target and r.status = 'going'\n        and e.cancelled_at is null");
    expect(feed).toContain("private.member_can_access_event_scope_for_user(");
    expect(feed).toContain("calendar feed RPC requires service_role");
  });
  // The single highest-value pin in this file: get_calendar_feed_events is
  // deliberately reachable ONLY via the service-role key held by
  // api/calendar.js. Granting it to authenticated would let any member
  // session brute-force other members' feed tokens directly, bypassing URL
  // secrecy entirely.
  it("keeps the feed resolver service-role-only, with the in-body backstop", () => {
    expect(sql).toContain("revoke all on function public.get_calendar_feed_events(text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.get_calendar_feed_events(text) to service_role");
    expect(sql, "no grant to authenticated may ever exist").not.toMatch(
      /grant execute on function public\.get_calendar_feed_events\(text\) to [^;]*authenticated/,
    );
    const feed = fnBody(sql, "public.get_calendar_feed_events(p_token text)");
    expect(feed).toContain("(select auth.role()) <> 'service_role'");
    expect(feed).toContain("calendar feed RPC requires service_role");
  });

  it("bounds the token length before hashing and folds unknown tokens to valid:false", () => {
    const feed = fnBody(sql, "public.get_calendar_feed_events(p_token text)");
    expect(feed).toContain("pg_catalog.length(p_token) < 32");
    expect(feed).toContain("pg_catalog.length(p_token) > 128");
    expect(feed).toContain("jsonb_build_object('valid', false)");
  });

  it("scopes the feed to the member's own 'going' RSVPs only", () => {
    const feed = fnBody(sql, "public.get_calendar_feed_events(p_token text)");
    expect(feed).toContain("join public.member_event_rsvps r on r.event_id = e.id");
    expect(feed).toContain("where r.user_id = target and r.status = 'going'");
    // The org-wide catalog must not leak through an unscoped select.
    expect(feed, "member_events may only be read through the rsvp join").not.toMatch(/from public\.member_events e\s*(?!\s*join)/);
  });

  it("self-guards rotate and revoke and grants them to authenticated", () => {
    for (const name of ["public.rotate_calendar_feed_token()", "public.revoke_calendar_feed_token()"]) {
      const body = fnBody(sql, name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("(select auth.uid())");
      expect(body).toContain("authentication required");
    }
    expect(sql).toContain("grant execute on function public.rotate_calendar_feed_token() to authenticated");
    expect(sql).toContain("grant execute on function public.revoke_calendar_feed_token() to authenticated");
  });

  it("stores only a sha256 hash and never grants token_hash to clients", () => {
    const hash = fnBody(sql, "private.calendar_feed_token_hash(p_token text)");
    expect(hash).toContain("extensions.digest(p_token, 'sha256')");
    expect(sql).toContain("grant select (user_id, created_at, rotated_at) on public.member_calendar_feed_tokens to authenticated");
    expect(sql, "token_hash must not appear in any client grant").not.toMatch(/grant select \([^)]*token_hash[^)]*\)/);
    const rotate = fnBody(sql, "public.rotate_calendar_feed_token()");
    expect(rotate, "the stored value must be the hash of the plaintext").toContain("private.calendar_feed_token_hash(plain)");
  });

  it("mints high-entropy tokens (24 random bytes, hex)", () => {
    const rotate = fnBody(sql, "public.rotate_calendar_feed_token()");
    expect(rotate).toContain("extensions.gen_random_bytes(24)");
  });

  it("enables RLS with a self-select policy on the token table", () => {
    expect(sql).toContain("alter table public.member_calendar_feed_tokens enable row level security");
    expect(sql).toContain("for select to authenticated using ((select auth.uid()) = user_id)");
  });
});
