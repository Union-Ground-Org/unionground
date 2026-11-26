// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260826155000_mi1_append_only_review_repairs");
const code = stripComments(sql);

function body(name) {
  return stripComments(fnBody(sql, name));
}

// This file pins several functions this migration first introduces, but a
// later migration is free to redefine them. body() above only ever reads the
// 20260826155000 copy, so a pin built on it goes stale silently the moment a
// later migration changes the live definition; it keeps passing while
// describing a function that no longer exists in the effective schema. This
// resolves the same name from whichever migration DECLARES IT LAST, mirroring
// the pattern in mfa-reset-session-boundary-migration.test.js.
function latestFunction(name) {
  const migration = [...migrationFiles()].reverse().find(({ sql: candidate }) => (
    stripComments(candidate).toLowerCase().includes(`function ${name.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${name}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, name));
}

describe("MI1 append-only exact-head review repairs", () => {
  it("pins case ownership to the immutable case tenant", () => {
    const resolver = body("private.mi1_w2_case_organization");
    expect(resolver).toContain("select mc.organization_id");
    expect(resolver).toContain("public.member_cases mc");
    expect(resolver).not.toContain("public.member_profiles");
    expect(resolver).not.toContain("public.chapters");
  });

  it("keeps member follow-ups in the unanswered officer queue", () => {
    const followUp = latestFunction("public.reply_member_qa_follow_up");
    expect(followUp).toContain("'follow_up'");
    expect(followUp).toContain("question.author_user_id is distinct from (select auth.uid())");
    expect(followUp).toContain("set status = 'open', accepted_reply_id = null, updated_at = pg_catalog.now()");
    expect(followUp).not.toContain("status = case");
    const accept = latestFunction("public.accept_member_qa_answer");
    expect(accept).toContain("r.kind = 'official'");
  });

  it("bounds survey JSON mutation cardinality", () => {
    expect(code).toContain("organization_survey_questions_options_bounded");
    expect(code).toContain("organization_survey_answers_value_bounded");
    expect(code).toContain("pg_catalog.pg_column_size(options) <= 65536");
    expect(code).toContain("pg_catalog.pg_column_size(value) <= 65536");
  });

  it("retires the case checklist patch RPC instead of leaving its bounds live but unpinned", () => {
    // 20260826155000 introduced the cardinality-bound checklist patch RPC, but
    // 20260917133000 drops it outright with no replacement (see the w2
    // procedure retirement). Pinning the dropped body's bounds would describe
    // a function that no longer exists in the effective schema, so this pins
    // the drop itself instead.
    const retirement = stripComments(loadMigrationSql("20260917133000_casework_procedures_retire_w2"));
    expect(retirement).toContain("drop function public.patch_case_checklist(uuid, jsonb);");
  });

  it("reaps an expired final webhook attempt before either claim path", () => {
    const reaper = body("private.mi1_reap_expired_webhook_final_attempts");
    expect(reaper).toContain("d.attempt_count >= 5");
    expect(reaper).toContain("lease_expired_after_max_attempts");
    expect(reaper).toContain("last_delivery_status = 'dead'");
    expect(latestFunction("public.claim_integration_webhook_deliveries"))
      .toContain("private.mi1_reap_expired_webhook_final_attempts()");
    expect(latestFunction("public.claim_integration_webhook_delivery"))
      .toContain("private.mi1_reap_expired_webhook_final_attempts()");
  });

  it("scopes handoff idempotency keys to the selected organization", () => {
    expect(code).toContain("unique (organization_id, idempotency_key)");
    const initiate = body("public.initiate_member_handoff");
    expect(initiate).toContain("where organization_id = org and idempotency_key = p_idempotency_key");
    expect(initiate).not.toContain("existing.organization_id is distinct from org");
  });

  it("preserves retry idempotency in the final effective function definition", () => {
    const retry = body("public.retry_knowledge_ingest_source");
    expect(retry).toContain("idempotency key required");
    expect(retry).toContain("pg_advisory_xact_lock");
    expect(retry).toContain("receipt.operation = 'retry_knowledge_ingest_source'");
    expect(retry).toContain("cached_request is distinct from request_payload");
    expect(retry).toContain("values (org, 'retry_knowledge_ingest_source', p_idempotency_key, request_payload, result)");
    expect(retry).not.toContain("perform p_idempotency_key");
  });
});
