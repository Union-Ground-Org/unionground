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
    "20261014008000_unionground_bargaining_writers.sql",
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

function functionBody(name, schema = "public") {
  const start = `create function ${schema}.${name}`;
  const startAt = sql.indexOf(start);
  expect(startAt, `${start} missing`).toBeGreaterThanOrEqual(0);
  const bodyStart = sql.indexOf("as $$", startAt);
  expect(bodyStart, `${name} body missing`).toBeGreaterThan(startAt);
  const endAt = sql.indexOf("\n$$;", bodyStart);
  expect(endAt, `${name} terminator missing`).toBeGreaterThan(bodyStart);
  return sql.slice(startAt, endAt + 4);
}

const writers = [
  "open_organizing_bargaining_cycle",
  "transition_organizing_bargaining_cycle",
  "create_organizing_bargaining_proposal",
  "transition_organizing_bargaining_proposal",
  "schedule_organizing_bargaining_session",
  "record_organizing_bargaining_session_outcome",
  "record_organizing_ratification",
  "correct_organizing_ratification",
  "record_organizing_first_contract",
];

describe("Union Ground bargaining writer security", () => {
  it("creates separate immutable aggregate evidence records under RLS", () => {
    for (const table of [
      "organizing_bargaining_ratifications",
      "organizing_bargaining_ratification_corrections",
      "organizing_first_contracts",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).not.toMatch(
        new RegExp(`grant\\s+[^;]*(select|insert|update|delete)[^;]*public\\.${table}`),
      );
    }
    expect(sql).toContain("decision_method in ('vote', 'not_required')");
    expect(sql).toContain("computed_outcome");
    expect(sql).toContain("organizing_bargaining_ratifications_derived_outcome_check");
    expect(sql).toContain("execution_authorized boolean generated always as");
    expect(sql).toContain("verification_status = 'source_recorded_fully_signed'");
    expect(sql).toContain("verified_signatory_count = expected_signatory_count");
    expect(sql).toContain("organizing_first_contracts_ratification_scope_fkey");
    expect(sql).toContain("organizing_bargaining_proposals_document_scope_key");
    expect(sql).toContain("organizing_bargaining_ratifications_append_only");
    expect(sql).toContain("organizing_bargaining_ratification_corrections_append_only");
    expect(sql).toContain("organizing_first_contracts_append_only");
    expect(sql).toContain("bargaining evidence is append-only");
    expect(sql).not.toMatch(/\b(voter_id|member_id|individual_vote|ballot_choice)\b/);
  });

  it("requires reset-safe AAL2 and a verified TOTP factor", () => {
    const strict = section(
      "create function private.bargaining_strict_mfa_satisfied",
      "comment on function private.bargaining_strict_mfa_satisfied",
    );
    expect(strict).toContain("private.mfa_satisfied()");
    expect(strict).toContain("claims ->> 'aal' <> 'aal2'");
    expect(strict).toContain("auth.sessions");
    expect(strict).toContain("s.id = session_claim::uuid");
    expect(strict).toContain("s.factor_id");
    expect(strict).toContain("auth.mfa_factors");
    expect(strict).toContain("f.status = 'verified'");
    expect(strict).toContain("f.factor_type = 'totp'");
    expect(strict).toContain("s.aal = 'aal2'");
    expect(strict).toContain("s.not_after is null or s.not_after > pg_catalog.clock_timestamp()");
    // Union Ground's account-lifecycle protocol: only its gated Auth
    // bookkeeping functions may hold Auth tuples, so this read takes no row
    // lock (scripts/account-case-graph-review.json lists no review for it).
    expect(strict).not.toMatch(/\bfor\s+(share|update|key\s+share|no\s+key\s+update)\b/);
    expect(strict).toContain("volatile");
  });

  it("requires an active assignment for organizers and coordinators", () => {
    const helper = section(
      "create function private.lock_bargaining_campaign_writer",
      "create function private.bargaining_request_fingerprint",
    );
    expect(helper).toContain("a.status = 'active'");
    expect(helper).toContain("r.role = 'coordinator'");
    expect(helper).toContain("a.assignment_role = 'coordinator'");
    expect(helper).toContain("r.role = 'organizer'");
    expect(helper).toContain("a.assignment_role in ('lead_organizer', 'organizer')");
    expect(helper).toContain("not p_coordinator_only");
    expect(helper).toContain("for share of p, r, a, m;");
    // Union Ground's chapter grant, active membership, and role predicate.
    expect(helper).toContain("join public.member_role_chapters r");
    expect(helper).toContain("join public.member_chapter_memberships m");
    expect(helper).toContain("and m.status = 'active'");
    expect(helper).toContain("private.member_has_chapter_role(");
    expect(sql.replace(/^\s*--.*$/gm, "")).not.toMatch(/public\.member_roles\b/);
  });

  it("gives every writer a stable request lock, replay receipt, and optimistic revision", () => {
    for (const writer of writers) {
      const body = functionBody(writer);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      const resetLock = body.indexOf("'unionground:mfa-reset:'");
      const requestLock = body.indexOf("'unionground:lifecycle-request:");
      expect(resetLock, writer).toBeGreaterThan(0);
      expect(requestLock, writer).toBeGreaterThan(resetLock);
      expect(body).toContain("where a.actor_id = caller");
      expect(body).toContain("request_fingerprint is distinct from fingerprint");
      expect(body).toContain("'changed', false");
      expect(body).toContain("using errcode = '40001'");
      expect(body).toContain("union_lifecycle_audit_events");
    }
  });

  it("keeps proposal content immutable and session state canonical", () => {
    const immutable = section(
      "create function private.preserve_bargaining_proposal_snapshot",
      "create trigger organizing_bargaining_proposals_preserve_snapshot",
    );
    for (const field of [
      "new.topic is distinct from old.topic",
      "new.title is distinct from old.title",
      "new.member_summary is distinct from old.member_summary",
      "new.internal_notes is distinct from old.internal_notes",
      "new.parent_proposal_id is distinct from old.parent_proposal_id",
      "new.record_kind is distinct from old.record_kind",
      "new.included_proposal_ids is distinct from old.included_proposal_ids",
      "new.document_sha256 is distinct from old.document_sha256",
    ]) {
      expect(immutable).toContain(field);
    }
    expect(sql).toContain("p_status not in ('held', 'cancelled')");
    expect(sql).not.toContain("p_status not in ('completed'");
    expect(sql).toContain("organizing_bargaining_sessions_status_shape_check");
    expect(sql).toContain("status = 'held'\n        and ends_at is not null");
    expect(sql).toContain("status = 'cancelled'\n        and ends_at is null\n        and member_update = ''\n        and outcome_reason is not null");
    const sessionOutcome = functionBody("record_organizing_bargaining_session_outcome");
    expect(sessionOutcome).toContain("a held session requires a verified bargaining start");
    expect(sessionOutcome).toContain("session_row.starts_at");
    expect(sessionOutcome).toContain("cycle.bargaining_started_on::timestamp at time zone 'utc'");
  });

  it("binds ratification to an immutable whole-agreement package", () => {
    const createProposal = functionBody("create_organizing_bargaining_proposal");
    const transitionProposal = functionBody("transition_organizing_bargaining_proposal");
    const ratification = functionBody("record_organizing_ratification");
    expect(sql).toContain("record_kind text not null default 'article'");
    expect(sql).toContain("record_kind = 'agreement_package'");
    expect(sql).toContain("included_proposal_ids uuid[] not null");
    expect(sql).toContain("document_sha256 is not null");
    expect(sql).toContain("document_sha256 ~ '^[0-9a-f]{64}$'");
    expect(createProposal).toContain("agreement package contains an ineligible proposal version");
    expect(createProposal).toContain("included.status = 'accepted'");
    expect(createProposal).toContain("current_article.status = 'accepted'");
    expect(transitionProposal).toContain("proposal.record_kind <> 'agreement_package'");
    expect(transitionProposal).toContain("proposal.record_kind = 'agreement_package'");
    expect(transitionProposal).toContain("p_next_status in ('accepted', 'rejected')");
    expect(transitionProposal).toContain("formal proposal status requires active bargaining chronology");
    expect(transitionProposal).toContain("included.presented_on > coalesce");
    expect(transitionProposal).toContain("unresolved_article.status not in");
    expect(ratification).toContain("proposal.document_sha256 is distinct from normalized_agreement_sha");
    expect(ratification).toContain("included.status <> 'accepted'");
    expect(ratification).toContain("included.presented_on > proposal.presented_on");
    expect(ratification).toContain("p_held_on < proposal.presented_on");
    expect(ratification).toContain("p_held_on < current_result.held_on");
    expect(ratification).toContain("unresolved_article.status not in");
    expect(sql).toContain("agreement_proposal_id,\n      cycle_id,\n      campaign_id,\n      chapter_id,\n      agreement_sha256");
    expect(sql).toContain("chapter_id,\n      document_sha256");
  });

  it("canonicalizes replay timestamps independently of request timezone", () => {
    expect(sql).toContain("create function private.bargaining_canonical_instant");
    for (const writer of [
      "open_organizing_bargaining_cycle",
      "transition_organizing_bargaining_cycle",
      "schedule_organizing_bargaining_session",
      "record_organizing_bargaining_session_outcome",
    ]) {
      expect(functionBody(writer)).toContain("private.bargaining_canonical_instant");
    }
  });

  it("server-computes vote results without inventing a rule", () => {
    const ratification = functionBody("record_organizing_ratification");
    expect(ratification).toContain("p_threshold_numerator");
    expect(ratification).toContain("p_threshold_denominator");
    expect(ratification).toContain("p_approval_comparator");
    expect(ratification).toContain("p_invalid_count");
    expect(ratification).toContain("p_approval_denominator");
    expect(ratification).toContain("p_quorum_required_count");
    expect(ratification).toContain("p_approve_count::bigint * p_threshold_denominator::bigint");
    expect(ratification).toContain("computed_outcome := 'indeterminate'");
    expect(ratification).toContain("p_source_reported_outcome");
    expect(ratification).not.toContain("approval_threshold_bps");
    expect(sql).toContain("organizing_bargaining_ratifications_derived_outcome_check");
    expect(sql).toContain("approve_count::bigint * threshold_denominator::bigint");
  });

  it("keeps correction evidence append-only and detaches corrected authority", () => {
    const correction = functionBody("correct_organizing_ratification");
    expect(correction).toContain("p_reason_code = 'wrong_agreement'");
    expect(correction).toContain("set status = 'withdrawn'");
    expect(correction).toContain("current_ratification_id = null");
    expect(correction).toContain("ratification_integrity_hold = true");
    expect(correction).toContain("not prior.execution_authorized");
    expect(correction).toContain("prior.agreement_proposal_id = ratification.agreement_proposal_id");
    expect(correction).toContain("prior.agreement_sha256 = ratification.agreement_sha256");
    expect(correction).toContain("prior_proposal.status = 'tentative_agreement'");
    expect(correction).toContain("child.parent_proposal_id = prior_proposal.id");
    expect(sql).toContain("organizing_bargaining_cycles_current_ratification_fkey");
    expect(sql).toContain("organizing_bargaining_cycles_reject_corrected_ratification");
    expect(sql).toContain("organizing_bargaining_corrections_detach_current");
  });

  it("guards campaign first-contract stages with typed records", () => {
    const guard = section(
      "create function private.enforce_typed_first_contract_stages",
      "create trigger organizing_campaigns_typed_first_contract_stages",
    );
    expect(guard).toContain("new.stage = 'first_contract'");
    expect(guard).toContain("new.status <> 'active'");
    expect(guard).toContain("organizing_bargaining_ratifications");
    expect(guard).toContain("r.execution_authorized");
    expect(guard).toContain("new.stage = 'established'");
    expect(guard).toContain("organizing_first_contracts");
    expect(guard).toContain("f.verification_status = 'source_recorded_fully_signed'");
    expect(sql).toContain("before insert or update of stage, status, outcome on public.organizing_campaigns");
    expect(sql).toContain("do $typed_stage_preflight$");
    expect(sql).toContain("unsupported first-contract campaign stages");
    expect(sql).toContain("unsupported established campaign stages");
  });

  it("projects no agendas, notes, minutes, evidence references, hashes, or tallies", () => {
    const workspace = section(
      "create function public.get_bargaining_workspace",
      "-- 7. staff-verified external ratification",
    );
    expect(workspace).toContain("'summary', s.member_update");
    expect(workspace).toContain("'staff_recorded_external_aggregate'");
    expect(workspace).toContain("'canrecordsessionoutcome'");
    expect(workspace).toContain("'canadvancetoratification'");
    expect(workspace).toContain("'canmarktentativeagreement'");
    expect(workspace).toContain("'canrecordfirstcontract'");
    expect(workspace).toContain("pending_session.status = 'scheduled'");
    expect(workspace).toContain("when r.decision_method = 'vote' and r.eligible_count < 5");
    expect(workspace).toContain("then 'suppressed'");
    expect(workspace).toContain("if aggregate_view then");
    for (const sensitive of [
      "s.agenda",
      "p.internal_notes",
      "s.internal_minutes",
      "source_reference",
      "source_sha256",
      "agreement_sha256",
    ]) {
      expect(workspace).not.toContain(sensitive);
    }
    for (const tallyKey of [
      "eligiblecount",
      "ballotscast",
      "approvecount",
      "rejectcount",
      "abstaincount",
      "invalidcount",
    ]) {
      expect(workspace).not.toContain(`'${tallyKey}'`);
    }
  });

  it("exposes only the exact authenticated RPC surface", () => {
    for (const writer of [...writers, "get_bargaining_workspace"]) {
      expect(sql).toMatch(
        new RegExp(`revoke all on function public\\.${writer}\\([\\s\\S]*?from public, anon, authenticated, service_role;`),
      );
      expect(sql).toMatch(
        new RegExp(`grant execute on function public\\.${writer}\\([\\s\\S]*?to authenticated;`),
      );
    }
  });
});
