// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findMigrationName,
  loadMigrationSql,
  stripComments,
} from "./helpers/migration.js";

const exactHeadRepairName = findMigrationName("20260831223000_mi1_dues_exact_head_repairs");
const coveringIndexesName = findMigrationName("20260901165000_dues_foreign_key_covering_indexes");
const coveringIndexes = loadMigrationSql("20260901165000_dues_foreign_key_covering_indexes");

describe("CR-084 Dues foreign-key covering indexes", () => {
  it("runs after the reviewed exact-head repair and covers every common advisory", () => {
    expect(exactHeadRepairName < coveringIndexesName).toBe(true);

    const expectedIndexes = [
      ["private.dues_checkout_recovery_audit", "organization_id"],
      ["private.dues_checkout_recovery_audit", "reservation_id"],
      ["private.dues_financial_identity_selections", "selected_by"],
      ["private.dues_financial_identity_selections", "user_id"],
      ["private.dues_stripe_oauth_states", "organization_id"],
      ["private.dues_stripe_oauth_states", "requested_by"],
      ["public.dues_assessment_batches", "created_by"],
      ["public.dues_assessment_batches", "organization_id, chapter_id"],
      ["public.dues_checkout_reservations", "requested_by"],
      ["public.dues_checkout_reservations", "organization_id, obligation_id"],
      ["public.dues_ledger_events", "created_by"],
      ["public.dues_notification_deliveries", "notification_id"],
      ["public.dues_notification_deliveries", "reminder_attempt_id"],
      ["public.dues_obligations", "organization_id, chapter_id"],
      ["public.dues_reminder_attempts", "created_by"],
      ["public.dues_stripe_events", "reservation_id"],
    ];

    const executable = stripComments(coveringIndexes).replace(/\s+/g, " ");
    for (const [table, columns] of expectedIndexes) {
      expect(executable).toMatch(
        new RegExp(
          `create index if not exists \\w+ on ${table.replace(".", "\\.")} \\(${columns.replace(", ", ",\\s*")}\\)`,
          "i",
        ),
      );
    }
  });

  it("guards every SAMPLE-only relation while covering its five advisories", () => {
    const executable = stripComments(coveringIndexes).replace(/\s+/g, " ");
    expect(executable).toContain("to_regclass('private.demo_seed_installation_bindings') is not null");
    expect(executable).toContain("binding.project_ref = 'sampledemoprojectref'");
    expect(executable).toContain("binding.system_identifier = control.system_identifier::numeric");
    expect(executable).toContain("binding.database_oid = database.oid");
    expect(executable).toContain("if not is_sample_installation then return; end if");
    expect(executable).toContain("to_regclass('private.dues_sample_seed_ledger') is not null");
    expect(executable).toContain("to_regclass('private.dues_sample_seed_runs') is not null");
    expect(executable).toContain(
      "create trigger demo_seed_binding_ensure_dues_indexes after insert or update of system_identifier, database_oid on private.demo_seed_installation_bindings",
    );
    expect(executable.match(/perform private\.ensure_dues_sample_seed_covering_indexes\(\)/g)).toHaveLength(2);
    expect(executable).toContain("security definer set search_path = ''");
    expect(executable).toContain(
      "revoke all on function private.ensure_dues_sample_seed_covering_indexes() from public, anon, authenticated, service_role",
    );

    for (const [table, column] of [
      ["private.dues_sample_seed_ledger", "assessment_event_id"],
      ["private.dues_sample_seed_ledger", "settlement_event_id"],
      ["private.dues_sample_seed_ledger", "reminder_attempt_id"],
      ["private.dues_sample_seed_runs", "featured_subject_id"],
      ["private.dues_sample_seed_runs", "organization_id"],
    ]) {
      expect(executable).toMatch(
        new RegExp(
          `create index if not exists \\w+ on ${table.replace(".", "\\.")} \\(${column}\\)`,
          "i",
        ),
      );
    }
  });

  it("is data-neutral and cannot activate a provider or seed a record", () => {
    const executable = stripComments(coveringIndexes);
    expect(executable).not.toMatch(
      /\binsert\s+into\b|\bupdate\s+[\w."']+\s+set\b|\bdelete\s+from\b|\btruncate(?:\s+table)?\s+[\w."]/i,
    );
    expect(executable).not.toMatch(/\b(?:stripe|provider).*\b(?:connect|activate)\b/i);
    expect(executable).not.toMatch(/demo_seed_apply|authorize_dues_sample_seed/i);
    expect(createHash("sha256").update(coveringIndexes).digest("hex")).toBe(
      "48e49f70938b58522b661d7265557a44c37907d79ded5e68e62af5aeccfbcd6e",
    );
  });
});
