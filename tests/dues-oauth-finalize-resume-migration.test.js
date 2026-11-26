import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20260831210909_mi1_dues_oauth_finalize_resume.sql", "utf8");

describe("Dues recorded OAuth finalize resume migration", () => {
  it("resumes only one recorded exchange under service-role control", () => {
    for (const needle of [
      "public.get_pending_dues_stripe_oauth_exchange",
      "public.resume_dues_stripe_oauth_exchange",
      "state.exchange_account_id is not null",
      "candidate_count <> 1",
      "recovery_required_at",
      "resumedRecordedExchange",
      "to service_role",
    ]) expect(sql).toContain(needle);
  });

  it("keeps an ambiguous recorded exchange in explicit recovery instead of choosing one", () => {
    expect(sql).toContain("oauth_recorded_exchange_ambiguous");
    expect(sql).toContain("dues_stripe_oauth_recovery_required");
    expect(sql).toContain("state = 'attention_required'");
  });
});
