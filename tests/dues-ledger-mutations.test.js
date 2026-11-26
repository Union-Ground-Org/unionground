import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("supabase/migrations/20260831110100_mi1_dues_ledger_mutations.sql"), "utf8");

describe("dues ledger mutation migration", () => {
  it("issues from one materialized eligibility snapshot and rejects stale previews", () => {
    expect(sql).toContain("with eligible as materialized");
    expect(sql).toContain("p_preview_fingerprint");
    expect(sql).toContain("dues assessment preview changed");
    expect(sql).toContain("on conflict (organization_id, idempotency_key)");
    expect(sql).toContain("dues idempotency payload mismatch");
    expect(sql).not.toMatch(/join public\.member_chapter_memberships chapter_membership\s+on chapter_membership\.user_id = membership\.user_id/);
    expect(sql).toContain("chapter.organization_id = subject.organization_id");
    expect(sql).toContain("chapter_membership.chapter_id = p_chapter_id");
  });

  it("settles only through append-only integer events", () => {
    expect(sql).toContain("for update");
    expect(sql).toContain("dues overpayment rejected");
    expect(sql).toContain("private.dues_receipt_number");
    expect(sql).not.toMatch(/update\s+public\.dues_ledger_events/i);
    expect(sql).not.toMatch(/delete\s+from\s+public\.dues_ledger_events/i);
    expect(sql).toContain("p_event_kind not in ('waiver', 'credit_adjustment', 'debit_adjustment')");
  });

  it("keeps mutations behind the selected financial hat and service dispatch behind service role", () => {
    for (const rpc of [
      "public.issue_dues_assessment_batch",
      "public.record_dues_manual_payment",
      "public.apply_dues_credit_event",
      "public.queue_dues_reminder",
    ]) expect(sql).toContain(rpc);
    expect(sql).toContain("private.dues_require_financial_hat(p_selected_hat)");
    expect(sql).toContain("coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("attempt_count < 25");
  });

  it("keys in-app and outbound reminder delivery to the attempt", () => {
    expect(sql).toContain("dues-reminder:' || attempt.id::text || ':in-app");
    expect(sql).toContain("dues-reminder:' || attempt.id::text || ':email");
    expect(sql).toContain("unique (organization_id, reminder_attempt_id, channel)");
    expect(sql).toContain("lease_epoch = attempt.lease_epoch + 1");
  });
});
