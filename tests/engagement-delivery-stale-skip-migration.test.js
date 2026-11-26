// @vitest-environment node
//
// BUG-UG-ENGAGEMENT-DELIVERY-SENDS-WEEKS-LATE-MAIL-ON-ACTIVATION-20261117 (#9050)
//
// 20261117133000 restates public.claim_engagement_delivery_batch,
// public.complete_engagement_delivery, public.queue_organization_survey_reminders
// and private.run_survey_operations_sweep. The static half pins that each
// restated body is its reviewed predecessor plus only the stale sweep, the
// closed-survey outcome and the remindable skip reasons; tests/engagement-delivery-stale-skip-db.test.js runs
// them on a disposable database.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const MIGRATION = read("supabase/migrations/20261117133000_engagement_delivery_skip_stale_and_closed_survey.sql");

function body(sql, declaration) {
  const start = sql.indexOf(declaration);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf("as $function$", start) + "as $function$".length;
  return sql.slice(open, sql.indexOf("$function$", open));
}

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
// 20260907151000 wrapped the 20260828034122 claim in the case-graph lock at
// apply time (its $wrapper$ step), so the reviewed predecessor is that text.
const CASE_GRAPH_WRAPPER = "\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n";
const claimBefore = `${CASE_GRAPH_WRAPPER}${body(read("supabase/migrations/20260828034122_member_engagement_completion.sql"), "create function public.claim_engagement_delivery_batch(")}end;\n`;
const completeBefore = body(read("supabase/migrations/20261002135600_restore_review_hotfixes.sql"), "create or replace function public.complete_engagement_delivery(");
const claimAfter = body(MIGRATION, "create or replace function public.claim_engagement_delivery_batch(");
const completeAfter = body(MIGRATION, "create or replace function public.complete_engagement_delivery(");
const remindersBefore = body(read("supabase/migrations/20261030203001_campaign_draft_delete_and_live_poll_meeting.sql"), "create or replace function public.queue_organization_survey_reminders(");
const remindersAfter = body(MIGRATION, "create or replace function public.queue_organization_survey_reminders(");
const sweepBefore = body(read("supabase/migrations/20261030203001_campaign_draft_delete_and_live_poll_meeting.sql"), "create or replace function private.run_survey_operations_sweep(");
const sweepAfter = body(MIGRATION, "create or replace function private.run_survey_operations_sweep(");
const SWEEP_MARK = [
  "          and delivery.state in ('queued', 'sent', 'failed') and delivery.escalation_state = 'none';\n",
  `          and (
            delivery.state in ('queued', 'sent', 'failed')
            -- Ended only because its email was too late or its survey was
            -- closed at the time (20261117133000): still remindable.
            or (delivery.state = 'suppressed' and delivery.last_error_code in ('skipped_stale', 'skipped_survey_closed'))
          )
          and delivery.escalation_state = 'none';
`,
];
const SWEEP_PICK = [
  "            and delivery.state in ('queued', 'sent', 'failed')\n",
  `            and (
              delivery.state in ('queued', 'sent', 'failed')
              or (delivery.state = 'suppressed' and delivery.last_error_code in ('skipped_stale', 'skipped_survey_closed'))
            )
`,
];
const REMINDABLE_BEFORE = "      and d.state in ('queued', 'sent', 'failed')\n";
const REMINDABLE_AFTER = `      and (
        d.state in ('queued', 'sent', 'failed')
        -- A delivery that only ended because its email was too late or its
        -- survey was closed at the time is remindable again while the
        -- survey is open (checked above).
        or (d.state = 'suppressed' and d.last_error_code in ('skipped_stale', 'skipped_survey_closed'))
      )
`;

const STALE_DECLARATION = `  -- A fixed duration between instants: 14 days of 24 hours, independent of
  -- the session time zone and daylight saving time.
  stale_before timestamptz := pg_catalog.now() - pg_catalog.make_interval(hours => 336);
`;
const SWEEP_START = "  -- Mail more than 14 days past its due time is never sent";
const SWEEP_END = "    and delivery.state in ('queued', 'leased', 'failed');\n";
const CANDIDATE_CUTOFF = "      and outbox.available_at >= stale_before\n";

describe("engagement delivery stale and closed-survey skip migration (static)", () => {
  it("guards both restated functions behind the digests of the reviewed predecessors", () => {
    const guard = MIGRATION.slice(MIGRATION.indexOf("do $predecessor$"), MIGRATION.indexOf("$predecessor$;"));
    expect(guard).toContain(`('public.claim_engagement_delivery_batch(uuid, integer, integer)', '${sha256(claimBefore)}')`);
    expect(guard).toContain(`('public.complete_engagement_delivery(uuid, uuid, boolean, text, integer)', '${sha256(completeBefore)}')`);
    expect(guard).toContain(`('public.queue_organization_survey_reminders(uuid)', '${sha256(remindersBefore)}')`);
    expect(guard).toContain(`('private.run_survey_operations_sweep(integer)', '${sha256(sweepBefore)}')`);
    expect(guard).toContain("raise exception 'unreviewed % predecessor: %'");
    expect(MIGRATION.indexOf("do $predecessor$")).toBeLessThan(MIGRATION.indexOf("create or replace function"));
  });

  it("measures the 14-day cutoff as 336 hours between instants, never calendar days", () => {
    expect(claimAfter).toContain("stale_before timestamptz := pg_catalog.now() - pg_catalog.make_interval(hours => 336);");
    expect(claimAfter).not.toMatch(/interval\s+'14 days'|days\s*=>|at time zone|America\/New_York/i);
    // The restated survey sweep keeps Main's own escalation window
    // (make_interval(days => progressStaleDays)) unchanged; the cutoff never
    // appears in calendar days anywhere.
    expect(MIGRATION).not.toMatch(/interval\s+'14 days'|days\s*=>\s*14\b|at time zone|America\/New_York/i);
    // Strictly older than the cutoff is stale; exactly at it is still claimed.
    expect(claimAfter).toContain("and outbox.available_at < stale_before");
    expect(claimAfter).toContain("and outbox.available_at >= stale_before");
  });

  it("sweeps only claimable rows it can lock, so overlapping claims are idempotent", () => {
    const sweep = claimAfter.slice(claimAfter.indexOf(SWEEP_START), claimAfter.indexOf(SWEEP_END) + SWEEP_END.length);
    expect(sweep).toContain("outbox.state in ('queued', 'failed')");
    expect(sweep).toContain("or (outbox.state = 'leased' and outbox.lease_expires_at < pg_catalog.now())");
    expect(sweep).toContain("and outbox.attempt_count < 20");
    expect(sweep).toContain("for update skip locked");
    expect(sweep).toContain("set state = 'suppressed', last_error_code = 'skipped_stale'");
    // A survey row follows only while its delivery is still pending.
    expect(sweep).toContain("and delivery.state in ('queued', 'leased', 'failed');");
    expect(sweep).not.toMatch(/::uuid/);
  });

  it("changes nothing else in the claim: the predecessor plus only the sweep and the cutoff", () => {
    const sweepStart = claimAfter.indexOf(SWEEP_START);
    const sweepEnd = claimAfter.indexOf(SWEEP_END) + SWEEP_END.length;
    const stripped = (claimAfter.slice(0, sweepStart) + claimAfter.slice(sweepEnd))
      .replace(STALE_DECLARATION, "")
      .replace(CANDIDATE_CUTOFF, "");
    expect(stripped).toBe(claimBefore);
  });

  it("ends a closed-survey email only when the database agrees, and changes nothing else in completion", () => {
    expect(completeAfter).toContain("survey_closed := not p_success and claimed_code = 'payload_unavailable' and row.source_kind = 'survey'");
    expect(completeAfter).toContain("and survey.status = 'open'");
    expect(completeAfter).toContain("and (survey.closes_at is null or survey.closes_at > pg_catalog.now())");
    expect(completeAfter).toContain("if survey_closed then claimed_code := 'skipped_survey_closed'; end if;");
    const start = completeAfter.indexOf("  -- A survey email the payload refused");
    const end = completeAfter.indexOf("  suppress := survey_closed or (");
    const stripped = (completeAfter.slice(0, start) + completeAfter.slice(end))
      .replace("  survey_closed boolean;\n", "")
      .replace("  suppress := survey_closed or (not p_success and (", "  suppress := not p_success and (")
      .replace("        row.organization_id, row.recipient_user_id, row.source_kind, row.source_id))\n  ));", "        row.organization_id, row.recipient_user_id, row.source_kind, row.source_id))\n  );");
    expect(stripped).toBe(completeBefore);
  });

  it("lets Remind select only the two skip reasons, and changes nothing else in the reminder queue", () => {
    expect(remindersAfter).toContain(REMINDABLE_AFTER);
    // The open-survey check still runs before any candidate is chosen.
    expect(remindersAfter.indexOf("s.status = 'open'")).toBeLessThan(remindersAfter.indexOf("with candidates as"));
    expect(remindersAfter.replace(REMINDABLE_AFTER, REMINDABLE_BEFORE)).toBe(remindersBefore);
  });

  it("lets the scheduled sweep mark and pick only the two skip reasons, and changes nothing else in it", () => {
    for (const [, after] of [SWEEP_MARK, SWEEP_PICK]) expect(sweepAfter.split(after)).toHaveLength(2);
    // Open-survey, unanswered, opt-out and one-reminder-per-member checks stay.
    expect(sweepAfter).toContain("if survey.status = 'open' and (survey.closes_at is null or survey.closes_at > pg_catalog.now()) then");
    expect(sweepAfter).toContain("and not private.engagement_email_opted_out(delivery.recipient_user_id, 'survey_reminder')");
    expect(sweepAfter).toContain("select 1 from public.engagement_delivery_outbox outbox");
    expect(sweepAfter.replace(SWEEP_MARK[1], SWEEP_MARK[0]).replace(SWEEP_PICK[1], SWEEP_PICK[0])).toBe(sweepBefore);
  });

  it("keeps signatures, security mode and search_path, and adds no constraint or grant change", () => {
    for (const fn of [claimAfter, completeAfter, remindersAfter, sweepAfter]) expect(fn.length).toBeGreaterThan(0);
    expect(MIGRATION.match(/security definer\nset search_path = ''\nas \$function\$/g)).toHaveLength(4);
    expect(MIGRATION).not.toMatch(/\b(?:alter table|add constraint|drop constraint|grant |revoke )/i);
    expect(MIGRATION).toMatch(/^begin;$/m);
    expect(MIGRATION).toMatch(/^commit;$/m);
  });
});
