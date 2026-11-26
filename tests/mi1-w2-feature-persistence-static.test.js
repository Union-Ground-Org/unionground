// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  fnBody,
  loadMigrationSql,
  migrationNames,
  stripComments,
} from "./helpers/migration.js";
import {
  expectMi1OrganizationRlsContract,
  MI1_W2_FEATURE_PERSISTENCE_RLS_TABLES,
} from "./helpers/mi1Contract.js";

const FRAGMENT = "20260826151000_mi1_w2_feature_persistence";
const sql = loadMigrationSql(FRAGMENT);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function body(name) {
  return stripComments(fnBody(sql, name));
}

const CASEWORK_RETIREMENT = "20260917133000_casework_procedures_retire_w2";
const CATALOG_HANDOFF_RETIREMENT = "20260917051000_retire_dormant_catalog_handoff_reads";

// The RPCs this migration created that are still in scripts/db-contract.json.
// Only these may carry body, definer, search-path or tenant-authority pins.
const LIVE_SESSION_RPCS = [
  "public.save_organization_survey_draft",
  "public.publish_organization_survey",
  "public.close_organization_survey",
  "public.reopen_organization_survey",
  "public.set_organization_survey_privacy_floor",
  "public.save_organization_survey_session",
  "public.submit_organization_survey_session",
  "public.list_knowledge_ingest_sources",
  "public.get_knowledge_ingest_source",
  "public.retry_knowledge_ingest_source",
  "public.clear_knowledge_ingest_source_chunks",
  "public.get_knowledge_embedding_activation",
  "public.list_steward_library_files",
  "public.prepare_steward_library_upload",
  "public.complete_steward_library_upload",
  "public.download_steward_library_file",
  "public.review_steward_library_file",
  "public.publish_steward_file_to_catalog",
  "public.download_resource_catalog_item",
  "public.initiate_member_handoff",
  "public.acknowledge_member_handoff",
  "public.decline_member_handoff",
  "public.cancel_member_handoff",
  "public.list_member_handoffs",
  "public.search_handoff_stewards",
];

// The fourteen RPCs this migration created that the two retirement migrations
// dropped. They are gone from the live contract, so the only thing this file
// may say about them is that they are absent.
const RETIRED_W2_RPCS = [
  ["public.get_organization_case_flow_snapshot", CASEWORK_RETIREMENT],
  ["public.request_case_deadline_change", CASEWORK_RETIREMENT],
  ["public.review_case_deadline_change", CASEWORK_RETIREMENT],
  ["public.patch_case_checklist", CASEWORK_RETIREMENT],
  ["public.advance_case_step", CASEWORK_RETIREMENT],
  ["public.set_case_restriction", CASEWORK_RETIREMENT],
  ["public.acknowledge_case_alert", CASEWORK_RETIREMENT],
  ["public.escalate_unacknowledged_case_alerts", CASEWORK_RETIREMENT],
  ["public.upsert_case_reminder", CASEWORK_RETIREMENT],
  ["public.dispose_case_reminder", CASEWORK_RETIREMENT],
  ["public.list_resource_catalog", CATALOG_HANDOFF_RETIREMENT],
  ["public.get_resource_catalog_item", CATALOG_HANDOFF_RETIREMENT],
  ["public.get_steward_library_file", CATALOG_HANDOFF_RETIREMENT],
  ["public.get_member_steward_relationship", CATALOG_HANDOFF_RETIREMENT],
];

// The private case-visibility gate the retired case RPCs shared; 20260917133000
// dropped it with them.
const RETIRED_W2_CASE_GATE = ["private.mi1_w2_require_visible_case", CASEWORK_RETIREMENT];

// The private helpers whose bodies this file pins.
const PINNED_PRIVATE_HELPERS = [
  "private.can_read_restricted_case",
  "private.mi1_w2_download_knowledge_file",
  "private.mi1_w2_replace_survey_questions",
  "private.mi1_w2_resolve_handoff",
  "private.mi1_w2_write_audit",
];

describe("MI1 W2 feature persistence reserved migration", () => {
  it("is the only 20260826151000 file and records the reserved CLI name", () => {
    const matches = migrationNames().filter((name) => name.startsWith("20260826151000"));
    expect(matches).toEqual(["20260826151000_mi1_w2_feature_persistence.sql"]);
    expect(sql).toContain("npx supabase migration new mi1_w2_feature_persistence");
    expect(sql).toContain("CLI 2.109.1");
  });

  it("does not replay donor migrations or seed an organization", () => {
    for (const rejected of ["0304", "0311", "0633", "0752", "public.members", "public.branches"]) {
      expect(code).not.toContain(rejected);
    }
    expect(code).not.toMatch(/insert into public\.organizations\b/i);
    expect(code).not.toMatch(/insert into auth\.users\b/i);
  });

  it("creates every second-wave table with RLS, revoke-all, and no anon grants", () => {
    for (const table of MI1_W2_FEATURE_PERSISTENCE_RLS_TABLES) {
      expect(code).toContain(`create table public.${table}`);
      expect(code).toContain(`alter table public.${table} enable row level security`);
      expect(code).toContain(`'${table}'`);
    }
    expect(code).toContain("revoke all on public.%I from public, anon, authenticated");
    expect(code).not.toMatch(/grant (select|insert|update|delete) on public\.\w+ to anon/i);
    expect(code).not.toMatch(/grant (select|insert|update|delete) on public\.(organization_surveys|case_deadline_audit|organization_knowledge_files|member_handoffs) to authenticated/i);
  });

  it("keeps deadline history append-only and knowledge paths off the wire", () => {
    expect(code).toContain("organization history is append-only");
    expect(code).toContain("create trigger case_deadline_audit_append_only");
    expect(body("public.prepare_steward_library_upload")).toContain("org/' || org::text");
    expect(body("public.prepare_steward_library_upload")).toContain("jsonb_build_object('uploadId', created, 'fileId', created, 'storageHandle', handle)");
    expect(body("public.download_steward_library_file")).toContain("mi1_w2_download_knowledge_file");
    expect(body("private.mi1_w2_download_knowledge_file")).toContain("'href'");
    expect(body("private.mi1_w2_download_knowledge_file")).not.toContain("storage_path");
    expect(body("public.get_knowledge_embedding_activation")).toContain("optional_activation_unset");
    expect(body("public.get_knowledge_embedding_activation")).toContain("'connected', false");
  });

  it("makes every knowledge mutation idempotent without polluting read-only getters", () => {
    expect(code).toContain("create table private.mi1_w2_operation_receipts");
    expect(code).toContain("primary key (organization_id, operation, idempotency_key)");
    expect(code).toContain("request_payload jsonb not null");
    expect(code).toContain("revoke all on table private.mi1_w2_operation_receipts from public, anon, authenticated, service_role");

    for (const [name, operation] of [
      ["public.retry_knowledge_ingest_source", "retry_knowledge_ingest_source"],
      ["public.clear_knowledge_ingest_source_chunks", "clear_knowledge_ingest_source_chunks"],
      ["public.complete_steward_library_upload", "complete_steward_library_upload"],
      ["public.publish_steward_file_to_catalog", "publish_steward_file_to_catalog"],
    ]) {
      const mutation = body(name);
      expect(mutation, name).toContain("idempotency key required");
      expect(mutation, name).toContain("pg_advisory_xact_lock");
      expect(mutation, name).toContain(`receipt.operation = '${operation}'`);
      expect(mutation, name).toContain("cached_request is distinct from request_payload");
      expect(mutation, name).toContain(`values (org, '${operation}', p_idempotency_key, request_payload, result)`);
    }

    expect(body("public.get_knowledge_ingest_source")).not.toContain("p_idempotency_key");
  });
});

describe("SECURITY DEFINER persistence", () => {
  it("pins every new public definer to an empty search_path and revokes PUBLIC execute", () => {
    for (const name of LIVE_SESSION_RPCS) {
      const fn = body(name);
      expect(fn, name).toMatch(/set search_path = ''/i);
      expect(fn, name).toMatch(/security definer/i);
    }
    expect(code).toContain("revoke all on function public.save_organization_survey_draft(jsonb) from public, anon, authenticated, service_role");
    expect(code).toContain("revoke all on function public.initiate_member_handoff(uuid, uuid, text, uuid) from public, anon, authenticated, service_role");
    expect(code).toContain("grant execute on function public.save_organization_survey_draft(jsonb) to authenticated");
  });

  it("derives tenant authority from the session and never from a caller organization argument", () => {
    for (const name of LIVE_SESSION_RPCS) {
      expect(body(name), name).not.toMatch(/\bp_organization_id\b/);
      expect(body(name), name).toContain("private.mfa_satisfied()");
    }
    expect(code).not.toMatch(/member_roles\.chapter_id is null/i);
    expect(body("private.mi1_w2_write_audit")).toContain("audit organization is derived from the session");
    expect(body("private.can_read_restricted_case")).toContain("array['admin', 'vp']");
    expect(body("public.acknowledge_member_handoff")).toContain("acknowledged");
    expect(body("private.mi1_w2_resolve_handoff")).toContain("member_steward_relationships");
  });

  it("keeps the surviving case-visibility helper inside the existing case-plane boundaries", () => {
    const visibility = body("private.can_read_restricted_case");

    expect(visibility).toContain("mc.steward_user_id = (select auth.uid())");
    expect(visibility).toContain("private.has_organization_role(p_organization_id, array['steward'])");
    expect(visibility).toContain("public.member_has_role(array['steward'])");
    expect(visibility).toContain("public.staff_can_see_user(mc.user_id, 'coordinator')");
    expect(visibility).toContain("private.has_organization_role(p_organization_id, array['admin', 'vp'])");
    expect(visibility).not.toContain("'advisor'");
    expect(visibility).not.toMatch(/when not exists[\s\S]*case_restrictions[\s\S]*then true/);
  });

  it("bounds survey question and option arrays before persisting them", () => {
    const replaceQuestions = body("private.mi1_w2_replace_survey_questions");
    expect(replaceQuestions).toContain("jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) > 200");
    expect(replaceQuestions).toContain("jsonb_array_length(item -> 'options') > 100");
  });
});

describe("db-contract lockstep", () => {
  it("records surviving second-wave tables, RPCs, and current RLS count", () => {
    expectMi1OrganizationRlsContract(contract);
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.save_organization_survey_draft("))).toBe(true);
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.get_organization_case_flow_snapshot("))).toBe(false);
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.prepare_steward_library_upload("))).toBe(true);
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.initiate_member_handoff("))).toBe(true);
    expect(contract.constraints.find((entry) => entry.name === "organization_audit_events_event_type_check")?.defContains)
      .toEqual(expect.arrayContaining(["member_handoff_cancelled"]));
  });

  it("records every RPC the retirement migrations dropped as absent, and only as absent", () => {
    for (const [name, droppedBy] of [...RETIRED_W2_RPCS, RETIRED_W2_CASE_GATE]) {
      expect(contract.functions.some((entry) => entry.sig.startsWith(`${name}(`)), name).toBe(false);
      expect(
        contract.functionsAbsent.some((entry) => entry.sig.startsWith(`${name}(`) && entry.droppedBy === droppedBy),
        name,
      ).toBe(true);
      expect(LIVE_SESSION_RPCS, name).not.toContain(name);
    }
    // Non-vacuous: a survivor of the same migration answers both probes the other way.
    expect(contract.functions.some((entry) => entry.sig.startsWith("public.save_organization_survey_draft("))).toBe(true);
    expect(contract.functionsAbsent.some((entry) => entry.sig.startsWith("public.save_organization_survey_draft("))).toBe(false);
  });

  it("pins behaviour only for routines the live contract still has", () => {
    for (const name of [...LIVE_SESSION_RPCS, ...PINNED_PRIVATE_HELPERS]) {
      expect(contract.functions.some((entry) => entry.sig.startsWith(`${name}(`)), name).toBe(true);
    }
  });
});
