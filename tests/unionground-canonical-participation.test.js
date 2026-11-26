import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(
  join(root, "supabase", "migrations", "20261014002000_unionground_canonical_participation_sources.sql"),
  "utf8",
);

function body(start, end) {
  const from = sql.indexOf(start);
  return sql.slice(from, end ? sql.indexOf(end, from) : sql.length);
}

const sourceTables = [
  "member_learning_sessions",
  "member_learning_assignments",
  "member_capacity_commitments",
  "member_participation_completions",
];

describe("canonical participation sources", () => {
  it("keys member scope to Union Ground's chapter memberships", () => {
    const code = sql.replace(/^\s*--.*$/gm, "");
    expect(code).not.toMatch(/member_profiles\(id, chapter_id\)/);
    expect(code.match(/references public\.member_chapter_memberships\(user_id, chapter_id\)/g)?.length).toBeGreaterThanOrEqual(9);
    // "Member belongs to the chapter" is an active membership, not the
    // member's currently selected chapter.
    expect(code).not.toMatch(/from public\.member_profiles p\s+where p\.id = p_user_id and p\.chapter_id = scope_chapter/);
    expect(code.match(/select 1 from public\.member_chapter_memberships m\s+where m\.user_id = p_user_id\s+and m\.chapter_id = scope_chapter\s+and m\.status = 'active'/g)).toHaveLength(2);
  });

  it("uses typed consent-bound sources and one immutable completion receipt", () => {
    for (const table of sourceTables) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`'public.${table}'::regclass`);
      expect(sql).not.toMatch(new RegExp(
        `grant\\s+[^;]*(insert|update|delete|select)[^;]*on(?:\\s+table)?\\s+public\\.${table}[^;]*to\\s+(anon|authenticated)`,
        "i",
      ));
    }
    expect(sql).toContain("num_nonnulls(learning_assignment_id, capacity_commitment_id) = 1");
    expect(sql).toContain("member_participation_completions_learning_source_fkey");
    expect(sql).toContain("member_participation_completions_commitment_source_fkey");
    expect(sql).toContain("member_participation_events_canonical_completion_fkey");
    expect(sql).toContain("member_participation_events_canonical_source_check");
    expect(sql).toContain("verified participation is immutable");
  });

  it("requires explicit member consent before a source can complete", () => {
    const assignment = body(
      "create table public.member_learning_assignments",
      "create unique index member_learning_assignments_response_request_idx",
    );
    const commitment = body(
      "create table public.member_capacity_commitments",
      "create unique index member_capacity_commitments_response_request_idx",
    );
    expect(assignment).toContain("status in ('offered', 'accepted', 'declined', 'completed')");
    expect(assignment).toContain("responded_at is not null");
    expect(assignment).toContain("verified_at is null or verified_at >= responded_at");
    expect(commitment).toContain("status in ('offered', 'accepted', 'declined', 'in_progress', 'completed')");
    expect(commitment).toContain("responded_at is not null");
    expect(commitment).toContain("started_at is not null");
    expect(commitment).toContain("started_at is null or started_at >= responded_at");
    expect(commitment).toContain("verified_at is null or verified_at >= responded_at");
  });

  it("derives every ladder fact server-side and rejects self-verification", () => {
    for (const [kind, activity, rung] of [
      ["orientation", "orientation_complete", "learn"],
      ["training", "training_complete", "learn"],
      ["meeting", "meeting_verified", "attend"],
      ["leadership_training", "leadership_training_complete", "lead"],
      ["peer_outreach", "peer_outreach_complete", "organize"],
      ["committee", "committee_commitment_complete", "organize"],
      ["voluntary", "commitment_complete", "volunteer"],
    ]) {
      expect(sql).toContain(`when '${kind}' then '${activity}'`);
      expect(sql).toContain(`'${rung}'`);
    }
    for (const fn of ["verify_learning_completion", "verify_capacity_commitment"]) {
      const fnBody = body(`function public.${fn}`, "$$;");
      expect(fnBody).toContain("private.mfa_satisfied()");
      expect(fnBody).toContain("self-verification is not allowed");
      expect(fnBody).toContain("member_participation_completions");
      expect(fnBody).toContain("member_participation_events");
      expect(fnBody).toContain("union_lifecycle_audit_events");
      expect(fnBody).toContain("pg_catalog.clock_timestamp()");
    }
  });

  it("keeps all writers bounded, MFA-gated, idempotent, and explicitly exposed", () => {
    const functions = [
      "create_learning_session",
      "assign_learning_session",
      "respond_learning_assignment",
      "verify_learning_completion",
      "offer_capacity_commitment",
      "respond_capacity_commitment",
      "start_capacity_commitment",
      "verify_capacity_commitment",
      "get_member_participation_sources",
    ];
    for (const fn of functions) {
      const fnBody = body(`function public.${fn}`, "$$;");
      expect(fnBody).toContain("security definer");
      expect(fnBody).toContain("set search_path = ''");
      expect(fnBody).toContain("private.mfa_satisfied()");
      expect(sql).toMatch(new RegExp(`revoke all on function public\\.${fn}\\(`));
      expect(sql).toMatch(new RegExp(`grant execute on function public\\.${fn}\\(`));
    }
    expect(sql).toContain("on conflict (created_by, request_id) do nothing");
    expect(sql).toContain("on conflict (offered_by, request_id) do nothing");
    expect(sql).toContain("using errcode = '40001'");
  });

  it("binds every replay to the original request and returns the full receipt", () => {
    const assign = body(
      "create function public.assign_learning_session",
      "create function public.respond_learning_assignment",
    );
    expect(assign).toContain("Resolve the idempotency key first");
    expect(assign).toContain("learning assignment already exists");

    for (const [start, end, requestColumn, error] of [
      [
        "create function public.respond_learning_assignment",
        "create function public.verify_learning_completion",
        "response_request_id",
        "already answered by a different request",
      ],
      [
        "create function public.verify_learning_completion",
        "-- Safe member projection",
        "completion_request_id",
        "already completed by a different request",
      ],
      [
        "create function public.respond_capacity_commitment",
        "create function public.start_capacity_commitment",
        "response_request_id",
        "already answered by a different request",
      ],
      [
        "create function public.verify_capacity_commitment",
        "-- 5. Function exposure",
        "completion_request_id",
        "already completed by a different request",
      ],
    ]) {
      const fnBody = body(start, end);
      expect(fnBody).toContain(`${requestColumn} is distinct from p_request_id`);
      expect(fnBody).toContain(error);
    }

    for (const fn of ["verify_learning_completion", "verify_capacity_commitment"]) {
      const fnBody = body(`function public.${fn}`, "$$;");
      expect(fnBody).toContain("where e.canonical_completion_id = completion_id");
      expect(fnBody.match(/'participationEventId'/g)).toHaveLength(3);
    }

    const startCommitment = body(
      "create function public.start_capacity_commitment",
      "create function public.verify_capacity_commitment",
    );
    expect(startCommitment.indexOf("commitment.status = 'in_progress'")).toBeLessThan(
      startCommitment.indexOf("commitment.revision <> p_expected_revision"),
    );
    expect(startCommitment).toContain(
      "p_expected_revision not in (commitment.revision, commitment.revision - 1)",
    );
  });

  it("captures verification after consent locks and normalizes request-key conflicts", () => {
    for (const fn of ["verify_learning_completion", "verify_capacity_commitment"]) {
      const fnBody = body(`function public.${fn}`, "$$;");
      expect(fnBody).toContain("verified_time timestamptz;");
      expect(fnBody).toContain("verified_time := pg_catalog.clock_timestamp()");
      expect(fnBody).not.toContain("verified_time timestamptz := pg_catalog.statement_timestamp()");
    }
    for (const [fn, conflict] of [
      ["respond_learning_assignment", "different learning response"],
      ["verify_learning_completion", "different learning completion"],
      ["respond_capacity_commitment", "different commitment response"],
      ["verify_capacity_commitment", "different commitment completion"],
    ]) {
      expect(body(`function public.${fn}`, "$$;")).toContain(conflict);
    }
  });
});
