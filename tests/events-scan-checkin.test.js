// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: private.award_member_points, whose sixth and current
// generation this migration writes -- the five earlier ones are still in the
// tree and still pinned by other files.

const sql = loadMigrationSql("member_event_scan_checkin");

// OPS-UG-EVENT-CHECKIN-TOKENS-NO-RETENTION-20260921 adds the retention sweep
// the token store shipped without; its pins live here because the window is only
// defensible against the 90-second token life this migration establishes.
const retentionName = "20260925620400_member_event_checkin_token_retention.sql";
const retention = stripComments(loadMigrationSql("member_event_checkin_token_retention"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("scan check-in migration security invariants", () => {
  it("keeps the token table private and explicitly revoked", () => {
    expect(sql).toContain("create table private.member_event_checkin_tokens");
    expect(sql).toContain("revoke all on private.member_event_checkin_tokens from public, anon, authenticated");
    expect(sql, "no grant may exist on the token table").not.toMatch(/grant [^;]*on private\.member_event_checkin_tokens/);
  });

  it("stores only the token hash, never the plaintext", () => {
    const mint = fnBody(sql, "public.request_event_checkin_token(p_event_id text)");
    expect(mint).toContain("pg_catalog.encode(extensions.digest(plain, 'sha256'), 'hex')");
    expect(mint, "the insert must write the hash column").toContain("token_hash");
  });

  it("hides scanned_by behind a column-scoped re-grant", () => {
    expect(sql).toContain("revoke select on public.member_event_checkins from authenticated");
    expect(sql).toContain("grant select (event_id, user_id, checked_in_at) on public.member_event_checkins to authenticated");
    expect(sql, "scanned_by must not appear in any client grant").not.toMatch(/grant select \([^)]*scanned_by[^)]*\)/);
  });

  it("widens the action_kind CHECK to the exact live superset plus scan", () => {
    expect(sql).toContain("check (action_kind in ('seed', 'vote', 'survey', 'rights', 'case', 'message', 'steward', 'rsvp', 'checkin', 'workload', 'form', 'scan'))");
  });

  it("seeds the scan rule at the documented value and weekly cap", () => {
    expect(sql).toContain("('scan', 'Check a member in at an event', 15, 20)");
  });

  it("re-creates the award trigger with the live workload + form branches intact", () => {
    const award = fnBody(sql, "private.award_member_points()");
    // Anchors carried over from the live body — losing any of these would
    // reopen the varied-prefix re-mint hole for that kind.
    expect(award).toContain("pg_catalog.left(new.action_key, 5) = 'vote-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 8) = 'checkin-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 9) = 'workload-'");
    expect(award).toContain("pg_catalog.left(new.action_key, 5) = 'form-'");
    expect(award, "the per-template form award must survive the rewrite").toContain("award_points := private.form_points(v_template)");
  });

  it("anchors the scan branch: prefix, fixed-length lowercase uuid, separator, entity backing", () => {
    const award = fnBody(sql, "private.award_member_points()");
    expect(award).toContain("pg_catalog.left(new.action_key, 5) = 'scan-'");
    // Case-SENSITIVE uuid class: an uppercase spelling of the same uuid would
    // otherwise be a distinct, equally-backed action_key (uuid casts are
    // case-insensitive) — the exact duplicate-mint hole the anchors close.
    expect(award).toContain("~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    expect(award, "the regex must not be case-insensitive").not.toContain("~* '^[0-9a-f]{8}");
    expect(award).toContain("pg_catalog.substr(new.action_key, 42, 1) = '-'");
    expect(award).toContain("where scanned_by = new.user_id");
    expect(award).toContain("and user_id = (pg_catalog.substr(new.action_key, 6, 36))::uuid");
    expect(award).toContain("and event_id = pg_catalog.substr(new.action_key, 43)");
  });

  it("mints tokens definer-side, window-gated, single active token per member+event", () => {
    const mint = fnBody(sql, "public.request_event_checkin_token(p_event_id text)");
    expect(mint).toContain("security definer");
    expect(mint).toContain("set search_path = ''");
    expect(mint).toContain("ev_starts - interval '2 hours'");
    expect(mint).toContain("ev_starts + interval '4 hours'");
    expect(mint).toContain("delete from private.member_event_checkin_tokens");
    expect(mint).toContain("interval '90 seconds'");
  });

  it("gates the scanner on the steward role and rejects reuse, expiry, and self-scans", () => {
    const scan = fnBody(sql, "public.scan_event_checkin(p_event_id text, p_token text)");
    expect(scan).toContain("security definer");
    expect(scan).toContain("set search_path = ''");
    expect(scan).toContain("not public.member_has_role(array['steward'])");
    expect(scan).toContain("for update");
    expect(scan).toContain("this code has already been used");
    expect(scan).toContain("this code has expired");
    expect(scan).toContain("you cannot scan your own check-in code");
  });

  it("reads awarded points back from member_point_events so the response never lies", () => {
    const scan = fnBody(sql, "public.scan_event_checkin(p_event_id text, p_token text)");
    // A row_count-based number would report +15 on a capped or unbacked scan;
    // the truthful source is what the trigger actually minted.
    expect(scan).toContain("from public.member_point_events");
    expect(scan).toContain("'memberAwardedPoints', member_points");
    expect(scan).toContain("'scannerAwardedPoints', scanner_points");
  });

  it("grants both RPCs to authenticated only (steward gate is in-body)", () => {
    expect(sql).toContain("revoke all on function public.request_event_checkin_token(text) from public, anon");
    expect(sql).toContain("revoke all on function public.scan_event_checkin(text, text) from public, anon");
    expect(sql).toContain("grant execute on function public.request_event_checkin_token(text) to authenticated");
    expect(sql).toContain("grant execute on function public.scan_event_checkin(text, text) to authenticated");
  });
});

describe("check-in token retention sweep", () => {
  it("applies after the token store it purges", () => {
    const names = migrationNames();
    expect(names.indexOf(retentionName))
      .toBeGreaterThan(names.indexOf("20260723140000_member_event_scan_checkin.sql"));
  });

  it("purges only rows well past expiry and leaves the attendance record alone", () => {
    const purge = fnBody(retention, "private.purge_expired_member_event_checkin_tokens()");
    expect(purge).toContain("delete from private.member_event_checkin_tokens");
    expect(purge).toContain("candidate.expires_at < pg_catalog.now() - interval '30 days'");
    // The durable attendance row and its scanned_by attribution must survive the
    // sweep: only the short-lived capability is retention-bound.
    expect(purge, "the sweep must not touch member_event_checkins")
      .not.toContain("member_event_checkins");
    // Bounded bite: this table carries the case-graph statement/row gates, whose
    // global advisory lock is held for the whole purge transaction.
    expect(purge).toContain("limit 20000");
    expect(purge).toContain("for update skip locked");
    expect(purge).toContain("get diagnostics removed = row_count;");
  });

  it("keeps the sweep internal: definer, empty search path, no client execute", () => {
    const purge = fnBody(retention, "private.purge_expired_member_event_checkin_tokens()");
    expect(purge).toContain("security definer");
    expect(purge).toContain("set search_path = ''");
    expect(retention).toContain(
      "revoke all on function private.purge_expired_member_event_checkin_tokens()\n"
      + "  from public, anon, authenticated, service_role;");
    expect(retention, "no role may be granted the purge")
      .not.toMatch(/grant [^;]*on function private\.purge_expired_member_event_checkin_tokens/);
  });

  it("schedules the sweep idempotently, only where pg_cron exists", () => {
    expect(retention).toContain("pg_catalog.to_regnamespace('cron') is not null");
    expect(retention).toContain("'event-checkin-token-retention',");
    expect(retention).toContain("'53 4 * * *',");
    expect(retention).toContain("'select private.purge_expired_member_event_checkin_tokens();'");
    expect(retention).toContain("exception when unique_violation then null;");
  });

  it("pins the job in the DB contract so verify:db proves it is installed", () => {
    const entry = contract.cron.find((job) => job.jobname === "event-checkin-token-retention");
    expect(entry, "the cron pin must exist").toBeDefined();
    expect(entry.schedule).toBe("53 4 * * *");
    expect(entry.active).toBe(true);
    expect(entry.commandContains).toContain("private.purge_expired_member_event_checkin_tokens");
    // The pin and the migration must name the same schedule, or verify:db would
    // pass against a job the reviewed migration never wrote.
    expect(retention).toContain(`'${entry.schedule}',`);
  });
});
