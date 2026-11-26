// @vitest-environment node
// Text tripwires over the notifications-wave migration (20260809020000):
// UB-SET-01 producers, UB-SET-02 weekly nudge cap, UB-SET-04 claim-time
// deferral, UB-CW-05/UB-CON-11 watch alerts, UB-RGT-03 steward ping, plus the
// expire-eligibility repair. The live catalog truth is verify:db's job; these
// pin what the SQL SAYS so a regression in the file is caught offline.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../api/notifications-dispatch.js";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";

const sql = readFileSync(new URL("../supabase/migrations/20260809020000_notifications_wave.sql", import.meta.url), "utf8");
const fixSql = readFileSync(new URL("../supabase/migrations/20260809030000_focus_window_equal_endpoints.sql", import.meta.url), "utf8");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const COPY_KEYS = [
  "deadline.case.days",
  "deadline.case.tomorrow",
  "deadline.case.today",
  "vote.opened",
  "vote.closing",
  "vote.results",
  "event.created",
  "event.reminder",
  "event.rescheduled",
  "task.watched",
  "steward.request.new",
  "steward.request.acknowledged",
];

describe("notifications wave migration", () => {
  it("repairs the expire eligibility list to all seven outbound topics", () => {
    expect(sql).toContain(
      "and n.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments')",
    );
    // The stale five-kind list must not survive anywhere in this file.
    expect(sql).not.toMatch(/not in \('deadlines', 'cases', 'forms', 'votes', 'events'\)\s*$/m);
  });

  it("moves quiet-hours/DND from enqueue-time drop to claim-time deferral", () => {
    expect(sql).toContain("drop trigger apply_member_focus_to_delivery on public.member_notification_deliveries");
    expect(sql).toContain("drop function private.apply_member_focus_to_delivery()");
    expect(sql).toContain("create function private.member_focus_blocks(p_user_id uuid, p_kind text)");
    expect(sql).toContain("and not private.member_focus_blocks(d.user_id, n.kind)");
    // The join must not widen the row locks beyond the delivery table.
    expect(sql).toContain("for update of d skip locked");
    // Urgent semantics and the fail-open timezone branch survive the move.
    expect(sql).toContain("p_kind in ('deadlines', 'cases')");
    expect(sql).toMatch(/when invalid_parameter_value then\s*\n\s*--[^\n]*\n\s*--[^\n]*\n\s*in_quiet_hours := false/);
    // Deferral means the new claim path never writes 'skipped' for focus.
    expect(sql).not.toContain("suppressed: do not disturb");
    expect(sql).not.toContain("suppressed: quiet hours");
  });

  it("reads equal quiet-hour endpoints as a zero-length window, not quiet-all-day", () => {
    // sol finding on the wave: start = end fell into the wrap-around branch,
    // whose predicate is a tautology — 24h suppression until the 48h expiry.
    // The follow-up migration re-emits member_focus_blocks with the guard.
    expect(fixSql).toContain("and profile.quiet_hours_start <> profile.quiet_hours_end then");
    expect(fixSql).toContain("create or replace function private.member_focus_blocks(p_user_id uuid, p_kind text)");
    expect(fixSql).toContain("security definer");
    expect(fixSql).toContain("set search_path = ''");
    expect(fixSql).toContain("revoke all on function private.member_focus_blocks(uuid, text) from public, anon, authenticated, service_role;");
    // The contract pins the guard in the LIVE body too.
    const focus = contract.functions.find((f) => f.sig === "private.member_focus_blocks(p_user_id uuid, p_kind text)");
    expect(focus.bodyContains).toContain("profile.quiet_hours_start <> profile.quiet_hours_end");
  });

  it("implements the five-a-week nudge cap with the urgent bypass", () => {
    expect(sql).toContain("max_per_recipient_week constant integer := 5");
    expect(sql).toContain("'rate limited: weekly nudge cap'");
    // Only non-urgent kinds are counted AND only non-urgent kinds are capped.
    const guards = sql.match(/new\.kind not in \('deadlines', 'cases'\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
    // Counted on the email channel, excluding suppressed rows.
    expect(sql).toContain("and d.channel = 'email'");
    expect(sql).toContain("and d.status <> 'skipped'");
    expect(sql).toContain("interval '7 days'");
    // The three existing caps survive the re-emit.
    expect(sql).toContain("max_per_recipient_hour constant integer := 12");
    expect(sql).toContain("max_per_recipient_day constant integer := 50");
    expect(sql).toContain("max_org_day constant integer := 20000");
  });

  it("declares every producer copy key in both languages", () => {
    for (const key of COPY_KEYS) {
      expect(sql).toContain(`('${key}', 'en',`);
      expect(sql).toContain(`('${key}', 'es',`);
    }
    // Shoulder rule: no template placeholder except {days} enters this copy.
    const placeholders = new Set([...sql.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    placeholders.delete("days");
    placeholders.delete("name"); // task.comment re-emit keeps its {name}
    placeholders.delete("placeholder"); // prose in comments
    expect([...placeholders]).toEqual([]);
  });

  it("gives the three dead switches real producers with the right kinds", () => {
    expect(sql).toContain("'deadline.case.days',");
    expect(sql).toMatch(/'deadline\.case\.days',\s*\n\s*pg_catalog\.jsonb_build_object\('days', r\.days_left::text\), 'deadlines'\)/);
    expect(sql).toContain("perform private.notify_member(m.id, 'vote.opened', '{}'::jsonb, 'votes')");
    expect(sql).toContain("perform private.notify_member(m.id, 'vote.closing', '{}'::jsonb, 'votes')");
    expect(sql).toContain("perform private.notify_member(m.id, 'vote.results', '{}'::jsonb, 'votes')");
    expect(sql).toContain("perform private.notify_member(m.id, 'event.created', '{}'::jsonb, 'events')");
    expect(sql).toContain("perform private.notify_member(m.user_id, 'event.reminder', '{}'::jsonb, 'events')");
    expect(sql).toContain("perform private.notify_member(m.user_id, 'event.rescheduled', '{}'::jsonb, 'events')");
    // Every produced kind already has a dispatcher template — nothing new
    // lands in the queue that templateFor would fail closed on.
    for (const kind of ["deadlines", "votes", "events", "tasks", "cases"]) {
      expect(TEMPLATES[kind]).toBeTruthy();
    }
  });

  it("scopes ballot notices to eligible members and skips receipt holders on closing", () => {
    const eligibility = sql.match(/b\.chapter_id is null or p\.chapter_id = b\.chapter_id/g) ?? [];
    expect(eligibility.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain("(b.chapter_id is null or p.chapter_id = b.chapter_id)");
    expect(sql).toContain("from public.member_ballot_receipts rc");
    // The voterless store stays untouched and no JWT-dependent scoping enters
    // a cron sweep (UB-VOTE-04 / no-JWT rule) — checked on code lines only;
    // the file's comments may name both.
    const codeLines = sql.split("\n").filter((line) => !line.trimStart().startsWith("--"));
    expect(codeLines.some((line) => line.includes("member_ballot_choices"))).toBe(false);
    expect(codeLines.some((line) => line.includes("current_member_chapter"))).toBe(false);
  });

  it("pre-stamps the existing world so the first tick cannot blast history", () => {
    expect(sql).toContain("update public.member_ballots set opened_notice_sent_at = now();");
    expect(sql).toMatch(/set closing_notice_sent_at = now\(\), results_notice_sent_at = now\(\)\s*\n\s*where closes_at <= now\(\) or not active/);
  });

  it("fans watch alerts from the activity stream minus already-notified audiences", () => {
    expect(sql).toContain("create trigger chapter_task_activity_notify_watchers");
    expect(sql).toContain("after insert on public.chapter_task_activity");
    expect(sql).toContain("if new.action = 'created' then");
    expect(sql).toContain("(new.actor_id is null or w.user_id <> new.actor_id)");
    expect(sql).toContain("and not (new.action = 'assignee_changed'");
    expect(sql).toContain("primary_assignee is not distinct from w.user_id");
    expect(sql).toContain("perform private.notify_member(r.user_id, 'task.watched', '{}'::jsonb, 'tasks')");
  });

  it("adds watchers to the comment audience without touching its guards", () => {
    expect(sql).toContain("union all select w.user_id from public.chapter_task_watchers w where w.task_id = task_row.id");
    // The re-emitted body keeps every original guard the contract pins.
    expect(sql).toContain("if caller is null or not private.mfa_satisfied() then");
    expect(sql).toContain("member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(sql).toContain("mentioned member must belong to this chapter");
  });

  it("pings scope-covering stewards on insert and the member on acknowledge", () => {
    expect(sql).toContain("create trigger member_steward_requests_notify_stewards");
    expect(sql).toContain("after insert on public.member_steward_requests");
    expect(sql).toContain("(mr.chapter_id is null or mr.chapter_id = req_chapter)");
    expect(sql).toContain("and mr.user_id <> new.user_id");
    expect(sql).toContain("perform private.notify_member(r.user_id, 'steward.request.new', '{}'::jsonb, 'cases')");
    // Triage re-emit: ack pings the member, self-triage stays silent, and the
    // pinned role gate survives.
    expect(sql).toContain("row_out.user_id <> caller");
    expect(sql).toContain("perform private.notify_member(row_out.user_id, 'steward.request.acknowledged', '{}'::jsonb, 'cases')");
    expect(sql).toContain("member_has_role(array['steward'])");
  });

  it("fences every producer so outbound plumbing cannot fail business writes", () => {
    // Trigger producers + the two event RPC fan-outs + triage ack are all
    // exception-fenced; count the warning branches.
    const warnings = sql.match(/raise warning/g) ?? [];
    expect(warnings.length).toBeGreaterThanOrEqual(7);
  });

  it("schedules the three producer jobs with the guarded pg_cron pattern", () => {
    for (const job of ["deadline-notices-tick", "ballot-notices-tick", "event-notices-tick"]) {
      expect(sql).toContain(`where jobname = '${job}'`);
    }
    expect(sql).toContain("if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then");
  });

  it("keeps every new definer body on the empty search path and revoked", () => {
    for (const fn of [
      "private.member_focus_blocks(uuid, text)",
      "private.case_deadline_notice_sweep()",
      "private.ballot_notice_sweep()",
      "private.event_notice_sweep()",
      "private.notify_chapter_task_watchers()",
      "private.notify_stewards_of_request()",
    ]) {
      expect(sql).toContain(`revoke all on function ${fn} from public, anon, authenticated, service_role;`);
    }
    const secdefs = sql.match(/security definer\s*\nset search_path = ''/g) ?? [];
    expect(secdefs.length).toBeGreaterThanOrEqual(10);
  });

  it("registers the contract entries the sweeps check", () => {
    const triggerNames = contract.triggers.map((t) => t.name);
    expect(triggerNames).toContain("member_steward_requests_notify_stewards");
    expect(triggerNames).toContain("chapter_task_activity_notify_watchers");
    expect(triggerNames).not.toContain("apply_member_focus_to_delivery");
    const award = contract.triggers.find((t) => t.name === "member_steward_requests_award_on_ack");
    // Sole-trigger exclusivity is retired, but the trigger SET stays closed:
    // the live sweep rejects any unlisted additional trigger — a second mint —
    // on member_steward_requests (sol finding on the wave).
    expect(award.exclusive).toBeUndefined();
    // Restricted PIN sessions add the statement guard before steward-contact writes.
    expect(award.exclusiveWith).toEqual(["a00_case_graph_lock", "member_pin_step_up", "member_steward_requests_notify_stewards", "z99_case_graph_keys"]);
    const cronNames = contract.cron.map((c) => c.jobname);
    for (const job of ["deadline-notices-tick", "ballot-notices-tick", "event-notices-tick"]) {
      expect(cronNames).toContain(job);
    }
    const sigs = contract.functions.map((f) => f.sig);
    expect(sigs).toContain("private.member_focus_blocks(p_user_id uuid, p_kind text)");
    expect(sigs).not.toContain("private.apply_member_focus_to_delivery()");
    // This wave added no tables; pin the shared current contract census,
    // including the later chapter-channel read/poll tables and the four MI1
    // organization-boundary tables.
    expectMi1OrganizationRlsContract(contract);
  });

  // The stamp columns ride their tables' EXISTING table-wide SELECT grants
  // (own-row RLS), so a member can read the stamp timestamps on their own
  // cases/ballots — benign delivery metadata. What this pins is narrower:
  // the migration itself grants nothing new for them.
  it("adds stamp columns with no new grant statements", () => {
    for (const col of [
      "deadline_notice_7_sent_at",
      "deadline_notice_3_sent_at",
      "deadline_notice_1_sent_at",
      "opened_notice_sent_at",
      "closing_notice_sent_at",
      "results_notice_sent_at",
      "reminder_notice_sent_at",
    ]) {
      expect(sql).toContain(`add column ${col} timestamptz`);
      // No grant STATEMENT names a stamp column (comments say "ungranted",
      // which a raw regex would false-positive on).
      const grantLines = sql.split("\n").filter((line) => /^\s*grant\b/.test(line));
      expect(grantLines.some((line) => line.includes(col))).toBe(false);
    }
  });
});
