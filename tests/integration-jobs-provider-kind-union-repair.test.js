// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findMigrationName,
  loadMigrationSql,
  stripComments,
} from "./helpers/migration.js";

const constantContactName = findMigrationName("20260830233000_constant_contact_integration");
const twilioName = findMigrationName("20260830234000_mi1_twilio_operations");
const repairName = findMigrationName("20260901102000_integration_jobs_provider_kind_union_repair");
const coveringIndexesName = findMigrationName("20260901102500_provider_foreign_key_covering_indexes");
const constantContact = loadMigrationSql("20260830233000_constant_contact_integration");
const twilio = loadMigrationSql("20260830234000_mi1_twilio_operations");
const repair = loadMigrationSql("20260901102000_integration_jobs_provider_kind_union_repair");
const coveringIndexes = loadMigrationSql("20260901102500_provider_foreign_key_covering_indexes");

function jobKinds(sql) {
  const executable = stripComments(sql).replace(/\s+/g, " ");
  const declaration = executable.match(
    /add constraint integration_jobs_job_kind_check check \(job_kind in \(\s*([\s\S]*?)\s*\)\s*\)/i,
  );
  if (!declaration) throw new Error("integration_jobs_job_kind_check declaration not found");
  return [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("shared provider job-kind migration repair", () => {
  it("runs after both provider migrations and preserves their complete closed union", () => {
    expect(constantContactName < twilioName).toBe(true);
    expect(twilioName < repairName).toBe(true);

    expect(jobKinds(constantContact)).toEqual([
      "provider_health",
      "connection_probe",
      "webhook_deliver",
      "webhook_retry",
      "constant_contact_sync",
    ]);
    expect(jobKinds(twilio)).toEqual([
      "provider_health",
      "connection_probe",
      "webhook_deliver",
      "webhook_retry",
      "sms_send",
      "sms_status",
      "sms_consent",
    ]);
    expect(jobKinds(repair)).toEqual([
      "provider_health",
      "connection_probe",
      "webhook_deliver",
      "webhook_retry",
      "constant_contact_sync",
      "sms_send",
      "sms_status",
      "sms_consent",
    ]);
  });

  it("covers every provider and retention foreign-key advisory after the repair", () => {
    expect(repairName < coveringIndexesName).toBe(true);

    const expectedIndexes = [
      ["private.constant_contact_oauth_states", "organization_id"],
      ["private.constant_contact_oauth_states", "requested_by"],
      ["private.constant_contact_oauth_tokens", "connected_by"],
      ["private.member_sms_preferences", "user_id"],
      ["private.twilio_sms_attempts", "job_id"],
      ["public.constant_contact_sync_requests", "organization_id"],
      ["public.constant_contact_sync_requests", "requested_by"],
      ["public.constant_contact_sync_runs", "requested_by"],
      ["public.integration_jobs", "chapter_id"],
      ["public.integration_jobs", "target_user_id"],
      ["public.organization_retention_policies", "updated_by"],
      ["public.organization_retention_runs", "authorized_by"],
      ["public.organization_retention_runs", "requested_by"],
    ];

    const executable = stripComments(coveringIndexes).replace(/\s+/g, " ");
    for (const [table, column] of expectedIndexes) {
      expect(executable).toMatch(
        new RegExp(`create index if not exists \\w+ on ${table.replace(".", "\\.")} \\(${column}\\)`, "i"),
      );
    }
    expect(executable).not.toMatch(/\b(?:insert|update|delete|truncate)\b/i);
    expect(createHash("sha256").update(coveringIndexes).digest("hex")).toBe(
      "75b8e75249b713052dede4842d32b830d79cd054e3be0644b6caaf7a839bb900",
    );
  });

  it("is a data-neutral exact-ledger repair", () => {
    const executable = stripComments(repair);
    expect(executable).toContain("drop constraint if exists integration_jobs_job_kind_check");
    expect(executable).toContain("add constraint integration_jobs_job_kind_check");
    expect(executable).not.toMatch(/\b(?:insert|update|delete|truncate)\b/i);
    expect(createHash("sha256").update(repair).digest("hex")).toBe(
      "7a85d089e271c7d443b55aa51de6a07b1d2dc1de0b6e5fa8ff5d3a50cbe1a73b",
    );
  });
});
