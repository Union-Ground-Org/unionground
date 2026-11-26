// @vitest-environment node

import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("20260813022500_stress_notification_egress_guard"));
const reconciliationSql = stripComments(
  loadMigrationSql("20260813140000_stress_workload_notification_reconciliation"),
);

function functionBody(signature, source = sql) {
  const start = source.indexOf(`create or replace function ${signature}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("synthetic notification egress guard", () => {
  it("drops typed notifications for stable stress-ledger identities before storage", () => {
    const notify = functionBody("private.notify_member(");
    const guardAt = notify.indexOf("from private.member_stress_ledger l");
    const insertAt = notify.indexOf("insert into public.member_notifications");

    expect(notify).toContain("p_kind in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments')");
    expect(notify).toContain("where l.user_id = p_user_id");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(insertAt);
  });

  it("defends the provider queue against typed direct notification inserts", () => {
    const enqueue = functionBody("private.enqueue_notification_deliveries()");
    const guardAt = enqueue.indexOf("from private.member_stress_ledger l");
    const controlsAt = enqueue.indexOf("from private.notification_controls c");
    const deliveryAt = enqueue.indexOf("insert into public.member_notification_deliveries");

    expect(enqueue).toContain("where l.user_id = new.user_id");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(controlsAt);
    expect(guardAt).toBeLessThan(deliveryAt);
  });

  it("does not use a spoofable email suffix as the security boundary", () => {
    expect(sql).not.toMatch(/where[^;]*loadtest\.example\.com/i);
    expect(sql).not.toMatch(/like\s+['"]%@loadtest/i);
  });

  it("quarantines only unclaimed synthetic deliveries and preserves active lease outcomes", () => {
    expect(sql).toContain("set status = 'skipped'");
    expect(sql).toContain("where d.status = 'pending'");
    expect(sql).not.toMatch(/where d\.status in \([^)]*'sending'/);
    expect(sql).toContain("last_error = 'suppressed: synthetic stress account'");
    expect(sql).not.toMatch(/delete\s+from\s+public\.member_notification_deliveries/i);
  });

  it("keeps both definer functions private and on an empty search path", () => {
    expect(sql.match(/security definer\nset search_path = ''/g)).toHaveLength(2);
    expect(sql).toContain("revoke all on function private.notify_member(uuid, text, jsonb, text)");
    expect(sql).toContain("revoke all on function private.enqueue_notification_deliveries()");
  });

  it("re-emits the final queue with both stress suppression and workload receipt semantics", () => {
    const enqueue = functionBody("private.enqueue_notification_deliveries()", reconciliationSql);
    const guardAt = enqueue.indexOf("from private.member_stress_ledger l");
    const controlsAt = enqueue.indexOf("from private.notification_controls c");

    expect(enqueue).toContain("'appointments', 'workload'");
    expect(enqueue).toContain("transactional_receipt boolean := new.kind = 'workload' and new.workload_event = 'receipt'");
    expect(enqueue).toContain("and not transactional_receipt");
    expect(enqueue).toContain("n2.kind = 'workload' and n2.workload_event = 'receipt'");
    expect(enqueue).toContain("where l.user_id = new.user_id");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(controlsAt);
    expect(reconciliationSql).toContain("revoke all on function private.enqueue_notification_deliveries()");
  });

  it("fails closed when a ledger guard is present only inside a SQL comment", () => {
    const guardNeedle = "from private.member_stress_ledger l";
    const bodies = [
      functionBody("private.notify_member("),
      functionBody("private.enqueue_notification_deliveries()"),
      functionBody("private.enqueue_notification_deliveries()", reconciliationSql),
    ];

    for (const body of bodies) {
      expect(body).toContain(guardNeedle);
      const disabled = stripComments(body.replace(guardNeedle, `-- ${guardNeedle}`));
      expect(disabled).not.toContain(guardNeedle);
    }
  });
});
