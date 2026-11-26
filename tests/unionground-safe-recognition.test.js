import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(
  join(root, "supabase", "migrations", "20261014003000_unionground_safe_recognition.sql"),
  "utf8",
);
const api = readFileSync(join(root, "src", "lib", "memberApi.js"), "utf8");

function body(start, end) {
  return sql.slice(sql.indexOf(start), end ? sql.indexOf(end, sql.indexOf(start)) : sql.length);
}

const safeKinds = [
  "training_complete",
  "orientation_complete",
  "peer_outreach_complete",
  "committee_commitment_complete",
  "commitment_complete",
];

describe("safe recognition final state", () => {
  it("retires point minting without deleting historical point events", () => {
    expect(sql).toContain("drop trigger if exists member_action_log_award_points");
    expect(sql).toContain("drop function if exists private.award_member_points()");
    expect(sql).toMatch(/update public\.member_point_rules\s+set points = 0/i);
    expect(sql).toContain("member_point_rules_points_retired_check");
    expect(sql).toMatch(/update public\.form_templates\s+set points = 0/i);
    expect(sql).toContain("form_templates_points_retired_check");
    expect(sql).not.toMatch(/delete\s+from\s+public\.member_point_events/i);
    expect(sql).not.toMatch(/insert\s+into\s+public\.member_point_events/i);
  });

  it("removes client action-log writes and makes form points permanently zero", () => {
    expect(sql).toContain("drop policy if exists member_action_log_insert_own");
    expect(sql).toContain("drop policy if exists member_action_log_update_own");
    expect(sql).toContain("revoke all on public.member_action_log from public, anon, authenticated");
    expect(sql).toContain("grant select on public.member_action_log to authenticated");
    const formPoints = body("create or replace function private.form_points", "revoke all on function private.form_points");
    expect(formPoints).toContain("select 0");
    expect(formPoints).toContain("security invoker");
  });

  it("allow-lists only five voluntary capacity-building recognitions", () => {
    for (const kind of safeKinds) expect(sql).toContain(`'${kind}'`);
    for (const unsafe of ["case", "vote", "survey", "steward", "message", "workload", "checkin", "scan"]) {
      const ruleInsert = body("insert into public.member_recognition_rules", "create table public.member_recognition_events");
      expect(ruleInsert).not.toContain(`'${unsafe}'`);
    }
    expect(sql).toContain("participation source is not eligible for recognition");
    expect(sql).toContain("verified_by <> user_id");
  });

  it("enforces UTC-stable per-kind and global caps with atomic counters", () => {
    const cap = body("create function private.enforce_member_recognition_cap", "alter table public.member_recognition_rules enable row level security");
    expect(cap).toContain("at time zone 'UTC'");
    expect(cap).toContain("new.verified_at");
    expect(sql).toContain("default pg_catalog.statement_timestamp()");
    expect(sql).toContain("create table private.member_recognition_week_totals");
    expect(sql).toContain("create table private.member_recognition_week_kind_totals");
    expect(cap).toContain("on conflict (user_id, week_start_utc) do update");
    expect(cap).toContain("where totals.used_count < 10");
    expect(cap).toContain("where kinds.used_count < kind_cap");
    expect(cap).toContain("returning used_count into total_after");
    expect(cap).toContain("returning used_count into kind_after");
    expect(cap).not.toContain("count(*)");
    expect(cap).not.toContain("pg_advisory_xact_lock");
    expect(sql).toMatch(/create trigger member_recognition_events_enforce_cap\s+after insert/i);
    expect(sql).toContain("member_recognition_events_enforce_cap");
  });

  it("uses only an existing chapter-bound participation record and writes audit", () => {
    const record = body("create function public.record_member_recognition", "create function public.get_member_recognition_summary");
    expect(record).toContain("r.role in ('steward', 'organizer', 'coordinator')");
    expect(record).toContain("r.chapter_id = p.chapter_id");
    expect(record).toContain("from public.member_role_chapters r");
    expect(record).toContain("join public.member_chapter_memberships m");
    expect(record).toContain("and m.status = 'active'");
    expect(record).toContain("private.member_has_chapter_role(");
    expect(record).not.toContain("public.member_roles");
    expect(record).toContain("self-recognition is not allowed");
    expect(record).toContain("private.mfa_satisfied()");
    expect(record).toContain("p_participation_event_id uuid");
    expect(record).toContain("from public.member_participation_events pe");
    expect(record).toContain("participation.chapter_id <> caller_chapter");
    expect(record).not.toContain("insert into public.member_participation_events");
    expect(record).toContain("participation.canonical_completion_id");
    expect(record).toContain("on conflict (participation_event_id) do nothing");
    expect(record).toContain("using errcode = '40001'");
    expect(record).toContain("'changed', false");
    expect(record).toContain("union_lifecycle_audit_events");
  });

  it("structurally binds recognition identity, chapter, kind, and source to participation", () => {
    expect(sql).toContain("participation_event_id uuid not null unique");
    expect(sql).toContain("canonical_completion_id uuid not null unique");
    expect(sql).toContain("member_recognition_events_participation_fkey");
    expect(sql).toMatch(/foreign key \(\s*participation_event_id,\s*user_id,\s*chapter_id,\s*recognition_kind,\s*source_kind,\s*source_id,\s*canonical_completion_id\s*\)/i);
    expect(sql).toContain("member_recognition_events_member_scope_fkey");
    expect(sql).toContain("member_recognition_events_verifier_scope_fkey");
    expect(sql).toContain("unique (user_id, chapter_id, recognition_kind, source_kind, source_id)");
  });

  it("keeps recognition member-readable and browser-nonwritable", () => {
    for (const table of ["member_recognition_rules", "member_recognition_events"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toMatch(new RegExp(`create policy mfa_assurance on public\\.${table}[\\s\\S]*?as restrictive`, "i"));
      expect(sql).not.toMatch(new RegExp(`grant\\s+[^;]*(insert|update|delete)[^;]*on(?:\\s+table)?\\s+public\\.${table}`, "i"));
    }
    expect(sql).toContain("member_recognition_events_select_own");
    expect(sql).toContain("using ((select auth.uid()) = user_id)");
    expect(sql).toMatch(
      /grant select \(\s*id,\s*user_id,\s*recognition_kind,\s*source_label,\s*occurred_at,\s*verified_at\s*\) on public\.member_recognition_events to authenticated/i,
    );
    expect(sql).not.toContain("grant select on public.member_recognition_events to authenticated");
  });

  it("never derives recognition from retired point tables or generic attendance", () => {
    const summary = body("create function public.get_member_recognition_summary", "-- Compatibility for older clients");
    expect(summary).toContain("not private.mfa_satisfied()");
    expect(summary).toContain("using errcode = '42501'");
    expect(summary).toContain("from public.member_recognition_events");
    expect(summary).toContain("from public.member_participation_events");
    for (const rung of ["learn", "attend", "volunteer", "organize", "lead"]) {
      expect(summary).toContain(`'${rung}'`);
    }
    expect(summary).not.toContain("member_point_events");
    expect(summary).not.toContain("member_action_log");
  });

  it("neutralizes the legacy summary and pins function ACLs", () => {
    const legacy = body("create or replace function public.get_member_rewards_summary", "revoke all on function private.enforce_member_recognition_cap");
    expect(legacy).toContain("'totalPoints', 0");
    expect(legacy).toContain("'retired', true");
    // Keeps Union Ground's reply keys so its client parses the neutral reply.
    for (const key of ["tierNumber", "tierName", "nextTierName", "pointsToGo", "weekStreak", "actionsYtd"]) {
      expect(legacy).toContain(`'${key}'`);
    }
    expect(sql).toContain("revoke all on function public.get_member_rewards_summary() from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.get_member_rewards_summary() to authenticated");
  });

  it("removes action-log writes from all member client flows", () => {
    for (const fn of ["sendMemberMessage", "createMemberCase", "submitBallot", "submitSurvey", "saveRightsProgress", "requestSteward"]) {
      const start = api.indexOf(`export async function ${fn}`);
      const next = api.indexOf("export async function", start + 1);
      const fnBody = api.slice(start, next === -1 ? api.length : next);
      expect(fnBody).not.toContain("member_action_log");
      expect(fnBody).not.toContain("logAction");
    }
    expect(api).not.toContain("export async function logAction");
  });
});
