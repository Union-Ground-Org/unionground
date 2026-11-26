// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const finalSql = loadMigrationSql("20260826159000_mi1_exact_head_final_repairs");
const cronSql = loadMigrationSql("20260826157000_mi1_fable_review_repairs");

function quotedValues(fragment) {
  return [...fragment.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("MI1 final exact-head repairs", () => {
  it("allows every cron job projected into organization job health", () => {
    // The function is nested inside dynamic DDL, so inspect the uniquely
    // anchored cron predicate rather than treating it as a top-level body.
    const syncList = cronSql.match(/where j\.jobname in \(([\s\S]*?)\) and d\.start_time/i)?.[1] ?? "";
    const checkList = finalSql.match(/check \(job_name in \(([\s\S]*?)\)\);/i)?.[1] ?? "";
    const allowed = new Set(quotedValues(checkList));
    const projected = quotedValues(syncList);

    expect(projected).toContain("integration-webhooks-dispatch-tick");
    expect(projected.length).toBeGreaterThan(0);
    expect(projected.filter((jobName) => !allowed.has(jobName))).toEqual([]);
  });

  it("uses an allowed audit metadata key when a follow-up reopens an accepted answer", () => {
    const followUp = fnBody(finalSql, "public.reply_member_qa_follow_up");
    expect(followUp).toContain("'reasonCode', 'member_follow_up'");
    expect(followUp).not.toMatch(/'reason'\s*,\s*'member_follow_up'/);
    expect(followUp).toContain("'qa_answer_unaccepted'");
  });
});
