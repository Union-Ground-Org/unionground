import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationFile = (name) =>
  readFileSync(join(root, "supabase", "migrations", name), "utf8").toLowerCase();
const sql = readFileSync(
  join(
    root,
    "supabase",
    "migrations",
    "20261014007000_unionground_lifecycle_writer_hardening.sql",
  ),
  "utf8",
).toLowerCase();

function section(start, end) {
  const startAt = sql.indexOf(start);
  expect(startAt, `${start} missing`).toBeGreaterThanOrEqual(0);
  const endAt = end ? sql.indexOf(end, startAt + start.length) : sql.length;
  expect(endAt, `${end} missing`).toBeGreaterThan(startAt);
  return sql.slice(startAt, endAt);
}

describe("Union Ground lifecycle writer hardening", () => {
  it("adds one scoped audit receipt and one resistance create key", () => {
    expect(sql).toContain("add column request_id uuid");
    expect(sql).toContain("add column request_fingerprint text");
    expect(sql).toContain("add column result_revision integer");
    expect(sql).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(sql).toContain(
      "on public.union_lifecycle_audit_events(actor_id, chapter_id, request_id)",
    );
    expect(sql).toContain("where request_id is not null");
    expect(sql).toContain("add column create_request_id uuid");
    expect(sql).toContain("create unique index organizing_resistance_creator_request_key");
    expect(sql).toContain("organizing_resistance_incidents_create_request_check");
    expect(sql).toContain("where create_request_id is not null");
    expect(sql).toContain("'campaign.created.legacy'");
    expect(sql).toContain("'legacyrequest', true");
  });

  it("removes every unsafe legacy overload and exposes only request-bearing writers", () => {
    for (const signature of [
      "transition_organizing_campaign(uuid, integer, text, text)",
      "set_organizing_campaign_status(uuid, integer, text, text, text)",
      "record_resistance_incident(uuid, text, text, text, text, date, timestamptz)",
    ]) {
      expect(sql).toContain(`drop function public.${signature}`);
    }
    for (const signature of [
      "transition_organizing_campaign(\n  uuid, integer, text, uuid, text\n)",
      "set_organizing_campaign_status(\n  uuid, integer, text, uuid, text, text\n)",
      "record_resistance_incident(\n  uuid, text, text, text, text, uuid, text, date, timestamptz, boolean\n)",
    ]) {
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
      expect(sql).toContain(`revoke all on function public.${signature}`);
    }
  });

  it("serializes all campaign writers per caller and holds final authorization rows", () => {
    const helper = section(
      "create function private.lock_lifecycle_campaign_writer",
      "revoke all on function private.lock_lifecycle_campaign_writer",
    );
    expect(helper).toContain("for share of p, r");
    expect(helper).toContain("for share of p, r, a");
    expect(helper.match(/private\.mfa_satisfied\(\)/g)?.length).toBeGreaterThanOrEqual(3);

    for (const [name, end] of [
      ["create or replace function public.create_organizing_campaign", "revoke all on function\n  public.transition_organizing_campaign"],
      ["create function public.transition_organizing_campaign", "create function public.set_organizing_campaign_status"],
      ["create function public.set_organizing_campaign_status", "create function public.record_resistance_incident"],
      ["create function public.record_resistance_incident", "-- the app currently consumes membership"],
    ]) {
      const writer = section(name, end);
      expect(writer).toContain("set search_path = ''");
      const resetLock = writer.indexOf("'unionground:mfa-reset:'");
      const requestLock = writer.indexOf("'unionground:lifecycle-request:");
      expect(resetLock).toBeGreaterThan(0);
      expect(requestLock).toBeGreaterThan(resetLock);
    }
  });

  it("resolves exact replay before revision or terminal-state rejection", () => {
    const transition = section(
      "create function public.transition_organizing_campaign",
      "create function public.set_organizing_campaign_status",
    );
    const status = section(
      "create function public.set_organizing_campaign_status",
      "create function public.record_resistance_incident",
    );
    for (const writer of [transition, status]) {
      expect(writer.indexOf("where a.actor_id = caller")).toBeLessThan(
        writer.indexOf("campaign.revision <> p_expected_revision"),
      );
      expect(writer).toContain("'changed', false");
      expect(writer).toContain("request_fingerprint is distinct from request_fingerprint");
      expect(writer).toContain("using errcode = '40001'");
    }
    expect(status.indexOf("where a.actor_id = caller")).toBeLessThan(
      status.indexOf("campaign.status = 'closed'"),
    );
  });

  it("keeps status edges explicit and permanent close coordinator-only", () => {
    const status = section(
      "create function public.set_organizing_campaign_status",
      "create function public.record_resistance_incident",
    );
    expect(status).toContain("campaign.status = 'active' and p_status in ('paused', 'closed')");
    expect(status).toContain("campaign.status = 'paused' and p_status in ('active', 'closed')");
    expect(status).toContain("campaign already has that status");
    expect(status).toContain("writer_kind <> 'coordinator'");
    expect(status).toContain("closed campaign reason required");
    expect(status).not.toContain("'established'");
  });

  it("fails closed on first-contract entry until typed ratification exists", () => {
    const transition = section(
      "create function public.transition_organizing_campaign",
      "create function public.set_organizing_campaign_status",
    );
    expect(transition).toContain("b.bargaining_started_on is not null");
    expect(transition).toContain("when campaign.stage = 'bargaining' then false");
    expect(transition).not.toContain("if p_next_stage = 'first_contract'");
    expect(transition).toContain(
      "campaign.representation_path = 'voluntary_recognition' and p_next_stage = 'bargaining'",
    );
  });

  it("keeps resistance receipts identity-free and rejects future dates", () => {
    const resistance = section(
      "create function public.record_resistance_incident",
      "-- the app currently consumes membership",
    );
    expect(resistance).toContain("p_occurred_on > current_date");
    expect(resistance).toContain("'legalreviewstatus', legal_review_status");
    const auditMetadata = section(
      "'resistance.reported',\n    'resistance_incident'",
      "p_request_id,\n    request_fingerprint",
    );
    for (const safe of ["reference", "category", "severity", "sourcekind", "legalreviewstatus"]) {
      expect(auditMetadata).toContain(`'${safe}'`);
    }
    for (const unsafe of ["normalized_title", "normalized_summary", "p_summary", "factual_summary"]) {
      expect(auditMetadata).not.toContain(unsafe);
    }
  });

  it("narrows member reads and adds stage/campaign integrity constraints", () => {
    const membershipRevoke = section(
      "revoke select (\n  id,\n  user_id,\n  chapter_id,\n  joined_on",
      ") on public.member_membership_periods from authenticated",
    );
    const onboardingRevoke = section(
      "revoke select (\n  id,\n  membership_period_id,\n  user_id,\n  chapter_id",
      ") on public.member_onboarding_steps from authenticated",
    );
    const membershipGrant = section(
      "grant select (\n  id,\n  joined_on",
      ") on public.member_membership_periods to authenticated",
    );
    const onboardingGrant = section(
      "grant select (\n  id,\n  membership_period_id",
      ") on public.member_onboarding_steps to authenticated",
    );
    for (const sensitive of ["source_kind", "source_id", "verified_by", "end_reason", "chapter_id", "user_id"]) {
      expect(membershipGrant).not.toContain(sensitive);
      expect(onboardingGrant).not.toContain(sensitive);
    }
    for (const sensitive of ["user_id", "chapter_id", "end_reason", "source_kind", "verified_by"]) {
      expect(membershipRevoke).toContain(sensitive);
    }
    for (const sensitive of ["user_id", "chapter_id", "source_kind", "source_id", "verified_by"]) {
      expect(onboardingRevoke).toContain(sensitive);
    }
    expect(sql).toContain("organizing_stage_events_distinct_stage_check");
    expect(sql).toContain("status <> 'closed'");
    expect(sql).toContain("or outcome = 'established'");
    expect(sql).toContain("outcome <> 'established'");
    expect(sql).not.toContain("validate constraint organizing_stage_events_");
    expect(sql).not.toContain("set outcome_reason = null");
  });

  it("holds Union Ground's chapter authority rows through every campaign write", () => {
    const helper = section(
      "create function private.lock_lifecycle_campaign_writer",
      "revoke all on function private.lock_lifecycle_campaign_writer",
    );
    expect(helper).not.toContain("public.member_roles");
    expect(helper.match(/join public\.member_role_chapters r/g)).toHaveLength(2);
    expect(helper.match(/join public\.member_chapter_memberships m/g)).toHaveLength(2);
    expect(helper.match(/and m\.status = 'active'/g)).toHaveLength(2);
    expect(helper).toContain("for share of p, r, m;");
    expect(helper).toContain("for share of p, r, a, m;");
    expect(helper).toContain("private.member_has_chapter_role(p_chapter_id, array['coordinator'])");
    expect(helper).toContain("private.member_has_chapter_role(p_chapter_id, array['organizer'])");
    const create = section(
      "create or replace function public.create_organizing_campaign",
      "revoke all on function\n  public.transition_organizing_campaign",
    );
    expect(create).toContain("for share of p, r, m;");
    expect(create).toContain(
      "private.lifecycle_scope_chapter(array['organizer', 'coordinator']) is distinct from scope_chapter",
    );
    expect(sql.replace(/^\s*--.*$/gm, "")).not.toMatch(/public\.member_roles\b/);
  });

  it("relies on Union Ground's MFA reset boundary instead of a second reset path", () => {
    const code = sql.replace(/^\s*--.*$/gm, "");
    for (const forbidden of [
      "function private.mfa_satisfied",
      "function public.begin_mfa_reset",
      "function public.complete_mfa_reset",
      "function public.record_mfa_reset",
      "function public.rotate_calendar_feed_token",
      "function public.upsert_push_subscription",
      "unionground_member_security_epochs",
      "unionground_mfa_reset_commands",
      "unionground_mfa_reset_requests",
      "alter function",
    ]) {
      expect(code).not.toContain(forbidden);
    }

    const epoch = migrationFile("20261014006000_unionground_mfa_reset_epoch.sql");
    const epochCode = epoch.replace(/^\s*--.*$/gm, "");
    expect(epochCode).not.toContain("function private.mfa_satisfied");
    expect(epochCode).not.toContain("function public.begin_mfa_reset");
    expect(epochCode).not.toContain("member_admin_audit");
    // The migration refuses to apply if Union Ground's boundary is missing or
    // if a second reset path exists.
    expect(epochCode).toContain("pg_catalog.to_regclass('private.member_mfa_reset_boundaries') is null");
    expect(epochCode).toContain("pg_catalog.strpos(predicate, 'private.member_mfa_reset_boundaries') = 0");
    expect(epochCode).toContain("pg_catalog.strpos(predicate, 'auth.sessions') = 0");
    expect(epochCode).toContain("pg_catalog.to_regprocedure('public.begin_mfa_reset(uuid, uuid)') is not null");
    expect(epochCode).toContain("pg_catalog.to_regprocedure('public.complete_mfa_reset(uuid, uuid)') is not null");
    // The calendar feed is a bearer capability that outlives sessions; a reset
    // still revokes it.
    expect(epochCode).toContain("after insert or update of invalid_before on private.member_mfa_reset_boundaries");
    expect(epochCode).toContain("delete from public.member_calendar_feed_tokens");
    expect(epochCode).toContain(
      "revoke all on function private.unionground_revoke_capabilities_on_mfa_reset()\n  from public, anon, authenticated, service_role;",
    );

    // Union Ground's predicate refuses any token whose live session predates
    // the reset boundary (this also covers the same-second case), and its
    // reset never moves the boundary backward.
    const predicate = migrationFile("20261002135500_pin_verified_key_session_assurance.sql");
    const mfa = predicate.slice(predicate.lastIndexOf("function private.mfa_satisfied()"));
    expect(mfa).toContain("private.member_mfa_reset_boundaries");
    expect(mfa).toMatch(/session\.created_at > coalesce\(boundary\.invalid_before,\s*'-infinity'::timestamptz\)/);
    const reset = migrationFile("20260924100000_mfa_reset_chapter_scope_boundary.sql");
    expect(reset).toContain("set invalid_before = greatest(");
    expect(reset).toContain("private.current_member_organization()");
    expect(reset).toContain("an admin cannot reset their own second factor");
  });
});
