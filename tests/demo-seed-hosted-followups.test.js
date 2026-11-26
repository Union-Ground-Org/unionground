// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const verification = stripComments(loadMigrationSql("20260826163000_demo_seed_verify_typed_notifications.sql"));
const chapters = stripComments(loadMigrationSql("20260826164000_demo_seed_parity_chapter_count.sql"));
const snapshots = stripComments(loadMigrationSql("20260826165000_demo_seed_cross_lane_snapshot.sql"));
const indexes = stripComments(loadMigrationSql("20260826166000_demo_seed_evidence_fk_indexes.sql"));
const verifierAcl = stripComments(loadMigrationSql("20260826167000_demo_seed_verify_base_acl.sql"));
const serverIdentity = stripComments(loadMigrationSql("20260826168000_demo_seed_server_identity_guard.sql"));

// Pin the whole equality clause. This migration also compares unrelated counters with zero.
function outboundDeliveryZeroClauses(sql) {
  return sql.match(/\(result\s*->>\s*'outbound_deliveries'\)::bigint\s*=\s*0/g) ?? [];
}

describe("hosted SAMPLE seed follow-ups", () => {
  it("treats provider delivery rows—not typed in-app rows—as the outbound boundary", () => {
    const presg = fnBody(verification, "public.presg_demo_verify");
    const uniondemo = fnBody(verification, "public.uniondemo_verify");
    expect(outboundDeliveryZeroClauses(presg)).toHaveLength(1);
    expect(outboundDeliveryZeroClauses(uniondemo)).toHaveLength(1);
    expect(outboundDeliveryZeroClauses(verification)).toHaveLength(2);
    expect(verification).not.toContain("'typed_notification_kinds')::bigint = 0");
    expect(verification).toContain("grant execute on function public.presg_demo_verify(uuid, text) to service_role");
    expect(verification).toContain("grant execute on function public.uniondemo_verify(uuid, text) to service_role");
  });

  it("derives Union Demo chapter cardinality from the per-run map", () => {
    expect(chapters).toContain("from private.uniondemo_chapters");
    expect(chapters).toContain("where run_id = p_run_id");
    expect(chapters).toContain("union demo run has no seeded chapters");
    expect(chapters).not.toContain("select chapter_count");
  });

  it("keeps both synthetic lanes outside the real-row snapshot", () => {
    for (const marker of ["uniondemo_run_id", "presg_demo_run_id", "member_stress_run_id"]) {
      expect(snapshots).toContain(`'${marker}'`);
    }
    expect(snapshots).toContain("create or replace function private.presg_demo_protected_snapshot");
  });

  it("covers both seed-evidence foreign-key columns", () => {
    expect(indexes).toContain("on private.demo_seed_function_evidence (function_id)");
    expect(indexes).toContain("on private.demo_seed_page_evidence (surface)");
  });

  it("keeps moved verifier implementations unreachable from every API role", () => {
    expect(verifierAcl).toContain("private.presg_demo_verify_pre_function_parity(uuid, text)");
    expect(verifierAcl).toContain("private.uniondemo_verify_pre_function_parity(uuid, text)");
    expect(verifierAcl).toContain("from public, anon, authenticated, service_role");
  });

  it("binds authorization to server identity instead of trusting the target argument", () => {
    expect(serverIdentity).toContain("create table private.demo_seed_installation_bindings");
    expect(serverIdentity).toContain("pg_catalog.pg_control_system()");
    expect(serverIdentity).toContain("pg_catalog.current_database()");
    expect(serverIdentity).toContain("presg demo database identity is not bound to SAMPLE");
    expect(serverIdentity).toContain("union demo database identity is not bound to SAMPLE");
    expect(serverIdentity).toContain("security definer");
    expect(serverIdentity).not.toMatch(/insert\s+into\s+private\.demo_seed_installation_bindings/i);
  });
});
