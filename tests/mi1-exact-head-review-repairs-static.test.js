// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260826156000_mi1_exact_head_review_repairs");
const code = stripComments(sql);

function body(name) {
  return stripComments(fnBody(sql, name));
}

describe("MI1 final exact-head replacement definitions", () => {
  it("serializes desired-state Q&A mutations and audits only state changes", () => {
    const vote = body("public.toggle_member_qa_vote");
    const accept = body("public.accept_member_qa_answer");
    expect(vote).toContain("for update");
    expect(vote).toContain("was_voted is distinct from desired");
    expect(accept).toContain("where id = p_question_id and deleted_at is null for update");
    expect(accept).toContain("was_accepted is distinct from desired");
  });

  it("leases both webhook claim paths beyond the worker deadline and advances their jobs", () => {
    for (const name of [
      "public.claim_integration_webhook_deliveries",
      "public.claim_integration_webhook_delivery",
    ]) {
      const claim = body(name);
      expect(claim).toContain("interval '10 minutes'");
      expect(claim).toContain("public.integration_jobs");
      expect(claim).toContain("private.mi1_reap_expired_webhook_final_attempts()");
    }
  });

  it("rotates a webhook secret under a row lock and deletes prior Vault custody", () => {
    const rotate = body("public.rotate_integration_webhook_secret");
    expect(rotate).toContain("for update");
    expect(rotate).toContain("vault.create_secret");
    expect(rotate).toContain("delete from vault.secrets where id = hook.secret_ref");
    expect(rotate).toContain("'signingSecret', plaintext");
  });

  it("consumes the email RSVP allowance before the shared event allowance", () => {
    const rsvp = body("public.submit_public_event_rsvp");
    expect(rsvp.indexOf("'email-event-day'")).toBeLessThan(rsvp.indexOf("'event-day'"));
    expect(code).toContain("'mi1-public-rsvp-retention', '17 4 * * *'");
    expect(code).toContain("private.purge_expired_public_event_rsvps()");
  });

  it("mirrors actual cron outcomes into the job-health desk on schedule", () => {
    expect(code).toContain("from cron.job_run_details d join cron.job j");
    expect(code).toContain("'mi1-job-health-sync', '* * * * *'");
  });
});
