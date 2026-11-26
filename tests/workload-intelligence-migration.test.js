// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// a guard below and this file stays green.
//
// Superseded here: the caller gate inside
// public.get_steward_workload_intelligence (r.user_id = caller / r.role in
// (...) / r.chapter_id is null or r.chapter_id = caller_chapter). Those three
// fragments describe migration 20260812203100 only.
// 20260901162845_sample_staff_rpc_tenant_authorization replaced them with
// private.member_has_chapter_role(caller_chapter, array[...]). The gate in
// force is pinned by tests/sample-staff-rpc-tenant-authorization.test.js.

const kindMigration = loadMigrationSql("20260812203000");
const workloadMigration = loadMigrationSql("20260812203100");
const code = stripComments(workloadMigration).toLowerCase();

describe("workload notification metadata lock", () => {
  it("keeps the kind constraint swap alone in the reserved metadata migration", () => {
    expect(findMigrationName("20260812203000")).toBe("20260812203000_workload_notification_kind.sql");
    expect(kindMigration).toContain("drop constraint if exists member_notifications_kind_check");
    expect(kindMigration).toContain("'appointments', 'workload'");
    expect(kindMigration).toMatch(/member_notifications_kind_check[\s\S]*not valid/i);
    expect(stripComments(kindMigration)).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(stripComments(kindMigration)).not.toMatch(/create\s+table/i);
  });
});

describe("private workload reminder preferences", () => {
  it("is an RPC-only table with no client or service-role table privileges", () => {
    expect(workloadMigration).toContain("create table private.workload_reminder_preferences");
    expect(workloadMigration).toContain("primary key references auth.users(id) on delete cascade");
    expect(workloadMigration).toContain("revoke all on table private.workload_reminder_preferences from public, anon, authenticated, service_role");
    expect(code).not.toMatch(/grant[^;]*on\s+(table\s+)?private\.workload_reminder_preferences/);
  });

  it("stores only a closed cadence and timezone vocabulary and defaults off", () => {
    const tableDefinition = stripComments(workloadMigration).match(
      /create table private\.workload_reminder_preferences \(([\s\S]*?)\n\);/i,
    )?.[1] ?? "";
    expect(tableDefinition).toContain("enabled boolean not null default false");
    expect(tableDefinition).toContain("'weekday_daily', 'weekly', 'biweekly', 'monthly', 'quarterly'");
    for (const zone of ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Puerto_Rico"]) {
      expect(tableDefinition).toContain(`'${zone}'`);
    }
    expect(tableDefinition).not.toMatch(/\bemail\b/i);
  });

  it("loads defaults without creating a preference row and gates both self RPCs on MFA", () => {
    const getBody = stripComments(fnBody(workloadMigration, "public.get_workload_reminder_preferences"));
    const setBody = stripComments(fnBody(workloadMigration, "public.set_workload_reminder_preferences"));
    expect(getBody).toContain("not private.mfa_satisfied()");
    expect(setBody).toContain("not private.mfa_satisfied()");
    expect(getBody).not.toMatch(/insert\s+into/i);
    expect(getBody).toContain("'enabled', false");
    expect(setBody).toContain("pg_advisory_xact_lock");
    expect(setBody).toContain("for update");
    expect(setBody).toContain("existing.next_due_at > pg_catalog.now()");
    expect(setBody).toContain("private.next_workload_reminder_at");
  });

  it("fails closed on null schedule inputs before timezone arithmetic", () => {
    const body = stripComments(fnBody(workloadMigration, "private.next_workload_reminder_at"));
    expect(body).toContain("p_cadence is null");
    expect(body).toContain("p_weekday is null");
    expect(body).toContain("p_local_hour is null");
    expect(body).toContain("p_timezone is null");
    expect(body).toContain("order by candidate_day");
  });
});

describe("bounded aggregate intelligence", () => {
  it("adds chapter-scoped median and p90 values without an exact contributor count", () => {
    const body = stripComments(fnBody(workloadMigration, "public.get_workload_stats"));
    expect(body).toContain("private.current_member_chapter()");
    expect(body).toContain("p.chapter_id = caller_chapter");
    expect(body).toContain("percentile_disc(0.5)");
    expect(body).toContain("percentile_disc(0.9)");
    expect(body).toContain("'median'");
    expect(body).toContain("'p90'");
    expect(body).toContain("k constant integer := 25");
    expect(body).not.toContain("'submitterCount'");
    expect(body).not.toContain("'contributorCount'");
  });

  it("uses 25 distinct chapter members per week and withholds regression below two eligible weeks", () => {
    const body = stripComments(fnBody(workloadMigration, "public.get_steward_workload_intelligence"));
    expect(body).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(body).toContain("private.current_member_chapter()");
    expect(body).toContain("p.chapter_id = caller_chapter");
    expect(body).toContain("count(distinct user_id) >= 25");
    expect(body).toContain("regr_slope");
    expect(body).toContain("+ slope * 4");
    expect(body).toContain("if eligible_points >= 2 then");
    expect(body).toContain("'available', eligible_points >= 2");
    expect(body).not.toContain("contributorCount");
    expect(body).not.toContain("memberName");
  });

  it("records the 20260812203100 role and chapter gate that 20260901162845 replaced", () => {
    // What migration 20260812203100 installed.
    // 20260901162845_sample_staff_rpc_tenant_authorization replaced this
    // inline member_roles join with
    // private.member_has_chapter_role(caller_chapter, array[...]). The gate
    // in force is pinned by tests/sample-staff-rpc-tenant-authorization.test.js.
    const body = stripComments(fnBody(workloadMigration, "public.get_steward_workload_intelligence"));
    expect(body).toContain("r.user_id = caller");
    expect(body).toContain("r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')");
    expect(body).toContain("r.chapter_id is null or r.chapter_id = caller_chapter");
  });

  it("builds rebalancing only from chapter operational assignments, never private logs", () => {
    const body = stripComments(fnBody(workloadMigration, "private.workload_rebalancing"));
    expect(body).toContain("public.member_cases c");
    expect(body).toContain("c.status = 'active'");
    expect(body).toContain("p.chapter_id = p_chapter");
    expect(body).toContain("limit 50");
    expect(body).toContain("limit 10");
    expect(body).not.toContain("member_workload_logs");
    for (const forbidden of ["title", "reference", "case_type", "articles", "note"]) {
      expect(body).not.toMatch(new RegExp(`'${forbidden}'`));
    }
  });
});

describe("workload receipts and idempotent reminders", () => {
  it("records closed event metadata and keeps it non-writable", () => {
    expect(workloadMigration).toContain("workload_event text");
    expect(workloadMigration).toContain("workload_event = 'receipt'");
    expect(workloadMigration).toContain("workload_event = 'reminder'");
    expect(workloadMigration).toContain("workload_receipt_code ~ '^[0-9a-f]{8}$'");
    expect(workloadMigration).toContain("grant update (read_at) on public.member_notifications to authenticated");
    expect(code).not.toMatch(/grant\s+update\s*\([^)]*workload_event/);
  });

  it("creates the receipt atomically from the submitted row through bilingual notification copy", () => {
    const body = stripComments(fnBody(workloadMigration, "public.submit_workload_log"));
    expect(body).toContain("private.notify_workload_event");
    expect(body).toContain("'receipt'");
    expect(body).toContain("rcode");
    expect(workloadMigration).toContain("'workload.receipt', 'en'");
    expect(workloadMigration).toContain("'workload.receipt', 'es'");
    expect(workloadMigration).toContain("'workload.reminder', 'en'");
    expect(workloadMigration).toContain("'workload.reminder', 'es'");
  });

  it("claims shoulder-safe event metadata but never notification-authored text", () => {
    const body = stripComments(fnBody(workloadMigration, "public.claim_notification_deliveries"));
    expect(body).toContain("'event', n.workload_event");
    expect(body).toContain("'receiptCode', n.workload_receipt_code");
    expect(body).not.toContain("n.title");
    expect(body).not.toContain("n.body");
    expect(body).toContain("n.kind = 'workload' and n.workload_event = 'receipt'");
    expect(body).toContain("private.member_focus_blocks");
  });

  it("keeps receipts outside the nudge cap while reminders remain ordinary nudges", () => {
    const body = stripComments(fnBody(workloadMigration, "private.enqueue_notification_deliveries"));
    expect(body).toContain("new.kind = 'workload' and new.workload_event = 'receipt'");
    expect(body).toContain("not transactional_receipt");
    expect(body).toContain("max_per_recipient_week constant integer := 5");
    expect(body).toContain("pref_value := prefs -> new.kind");
  });

  it("locks and advances due preferences in the same transaction as one notification", () => {
    const body = stripComments(fnBody(workloadMigration, "private.workload_reminder_sweep"));
    expect(body).toContain("for update skip locked");
    expect(body).toContain("private.next_workload_reminder_at");
    expect(body).toContain("private.notify_workload_event");
    expect(body).toContain("'reminder'");
    expect(body).toContain("last_sent_at = pg_catalog.now()");
    expect(body).not.toContain("pref.next_due_at +");
  });

  it("installs the reminder cron only when pg_cron exists", () => {
    expect(workloadMigration).toContain("pg_catalog.to_regnamespace('cron') is null");
    expect(workloadMigration).toContain("'workload-reminders-tick'");
    expect(workloadMigration).toContain("select private.workload_reminder_sweep()");
  });
});
