// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("20260826157000_mi1_fable_review_repairs");

describe("MI1 Fable exact-head repair definitions", () => {
  it("claims only sendable webhooks without exceeding the attempt ceiling", () => {
    const claim = fnBody(sql, "public.claim_integration_webhook_deliveries");
    expect(claim).toContain("w.secret_ref is not null");
    expect(claim).toContain("d.attempt_count < 5");
    expect(claim).toContain("interval '10 minutes'");
    expect(claim).toContain("for update of d skip locked");
  });

  it("projects integration dispatch and bounded failure detail into job health", () => {
    const list = fnBody(sql, "public.list_organization_job_health");
    expect(list).toContain("integration-webhooks-dispatch-tick");
    expect(list).toContain("'redactedSummary', r.redacted_summary");
    expect(list).toContain("'durationMs'");
  });

  it("treats only terminal cron failure as failed", () => {
    expect(sql).toContain("when 'failed' then 'failed' else 'in_progress'");
    expect(sql).toContain("case when d.status = 'failed' then 'cron_failed' end");
  });

  it("uses compare-and-set acceptance against the loaded question version", () => {
    const accept = fnBody(sql, "public.accept_member_qa_answer");
    expect(accept).toContain("p_expected_updated_at timestamptz");
    expect(accept).toContain("question.updated_at is distinct from p_expected_updated_at");
    expect(accept).toContain("stale question; reload required");
    expect(sql).toContain("drop function if exists public.accept_member_qa_answer(uuid, uuid, boolean)");
  });

  it("serializes reply idempotency and records follow-up unacceptance", () => {
    const official = fnBody(sql, "public.reply_member_qa_official");
    const followUp = fnBody(sql, "public.reply_member_qa_follow_up");
    expect(official).toContain("deleted_at is null for update");
    expect(official.indexOf("for update")).toBeLessThan(official.indexOf("idempotency_key = p_idempotency_key"));
    expect(followUp).toContain("deleted_at is null for update");
    expect(followUp).toContain("previous_accepted_reply_id := question.accepted_reply_id");
    expect(followUp).toContain("'qa_answer_unaccepted'");
  });
});
