// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { assertDisposableProfileUrl } from "../scripts/dev/steward-desk-scale-profile.mjs";
import { fnBody, migrationNames, loadMigrationSql, stripComments } from "./helpers/migration.js";

const migrationName = "20260909080000_steward_desk_scale_latency.sql";
const source = loadMigrationSql("steward_desk_scale_latency");
const executable = stripComments(source);
const helper = fnBody(executable, "private.visible_member_broadcast_ids");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("steward desk scale latency migration", () => {
  it("applies after the current cron repair; the parallel Auth bookkeeping lock migration was re-timestamped to land after it", () => {
    const names = migrationNames();
    expect(names.indexOf(migrationName)).toBeGreaterThan(names.indexOf("20260908170000_cron_job_health_sync_incremental.sql"));
  });

  it("is top-level SQL and retains the private SECURITY DEFINER, empty-search-path ACL boundary", () => {
    expect(executable).not.toMatch(/\bdo\s+\$/i);
    expect(helper).toContain("stable");
    expect(helper).toContain("security definer");
    expect(helper).toContain("set search_path = ''");
    expect(executable).toContain("revoke all on function private.visible_member_broadcast_ids()");
    expect(executable).toContain("from public, anon, authenticated, service_role");
    expect(executable).toContain("grant execute on function private.visible_member_broadcast_ids()");
    expect(executable).toContain("to authenticated, service_role");
  });

  it("materializes the exact broadcast authorization facts before the policy's set membership check", () => {
    for (const needle of [
      "with caller as materialized",
      "active_chapters as materialized",
      "private.mfa_satisfied()",
      "private.current_member_organization()",
      "private.is_organization_member(private.current_member_organization())",
      "membership.status = 'active'",
      "broadcast.audience_scope = 'organization'",
      "broadcast.chapter_id in (select active_chapters.chapter_id from active_chapters)",
    ]) expect(helper).toContain(needle);
    expect(executable).toContain("using (id in (select private.visible_member_broadcast_ids()))");
  });

  it("keeps the public KPI invoker and role boundary intact", () => {
    const kpis = fnBody(executable, "public.get_steward_desk_kpis");
    expect(kpis).toContain("security invoker");
    expect(kpis).toContain("public.member_has_role(array['steward'])");
    expect(kpis).toContain("from public.member_conversations conversation");
    expect(kpis).toContain("order by message.created_at desc, message.id desc");
    expect(kpis).toContain("broadcast.organization_id = desk_org");
  });

  it("updates the helper's db-contract pins and promotes both six-case live scale distributions", () => {
    const entry = contract.functions.find((item) => item.sig === "private.visible_member_broadcast_ids()");
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated,service_role" });
    for (const pin of entry.bodyContains) expect(helper).toContain(pin);
    const live = readFileSync(new URL("./steward-desk-scale-latency-db.test.js", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../scripts/run-required-db-proofs.mjs", import.meta.url), "utf8");
    const cases = (live.match(/^\s{2}it\(/gm) || []).length;
    // #6682 adds one scoped-access latency case beside the six.
    expect(cases).toBe(7);
    expect(live).toContain("live.each([");
    expect(live).toContain('distribution: "balanced"');
    expect(live).toContain('distribution: "sample-skew"');
    expect(PROOF_FILES).toContain("tests/steward-desk-scale-latency-db.test.js");
    expect(runner).toContain('RUN_STEWARD_DESK_SCALE_DB_TESTS: "1"');
    // 107 proofs on Main before this delivery: the 105 this lane branched from,
    // plus the private-upload currency projection case (a new proof FILE, pinned
    // below) and the hosted sensitive-RPC grant regression (a new CASE inside an
    // existing file, so it has no filename to pin). Then both six-case scale distributions.
    expect(PROOF_FILES).toContain("tests/private-upload-currency-canary-db.test.js");
    expect(PROOF_FILES).toContain("tests/connected-automation-v2-db.test.js");
    expect(PROOF_FILES).toContain("tests/automation-shared-intelligence-v3-db.test.js");
    // The membership-card single-use nonce proof adds five more required cases,
    // counting its anonymous live-row allocation ceiling proof.
    expect(PROOF_FILES).toContain("tests/membership-card-single-use-db.test.js");
    // Merged with BUG-UG-AUTH-BOOKKEEPING-CASE-GRAPH-LOCK-20260908, whose
    // live Auth lock-scope proof contributes 15 further required cases.
    expect(PROOF_FILES).toContain("tests/auth-bookkeeping-lock-scope-db.test.js");
    expect(PROOF_FILES).toContain("tests/pg-net-tick-request-id-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-attachment-lifecycle-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-child-row-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/coordinator-case-write-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/dues-oauth-recovery-row-shape-db.test.js");
    expect(PROOF_FILES).toContain("tests/dues-oauth-recovery-account-check-db.test.js");
    expect(PROOF_FILES).toContain("tests/chapter-verification-identity-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-history-db.test.js");
    expect(PROOF_FILES).toContain("tests/coordinator-queue-tenant-scope-db.test.js");
    expect(PROOF_FILES).toContain("tests/casework-audit-reader-kinds-db.test.js");
    expect(PROOF_FILES).toContain("tests/public-chapter-microsite-direct-dml-db.test.js");
    expect(PROOF_FILES).toContain("tests/casework-reminders-direct-dml-db.test.js");
    expect(PROOF_FILES).toContain("tests/public-site-chapter-parent-delete-db.test.js");
    expect(PROOF_FILES).toContain("tests/vote-campaign-authority-db.test.js");
    expect(PROOF_FILES).toContain("tests/chapter-task-report-window-db.test.js");
    expect(PROOF_FILES).toContain("tests/live-poll-roster-eligibility-db.test.js");
    expect(PROOF_FILES).toContain("tests/survey-publish-atomicity-db.test.js");
    // The runner discovers tests/*-db.test.js files by name; pin that this
    // proof is planned.
    expect(PROOF_FILES).toContain("tests/steward-desk-scale-latency-db.test.js");
  });

  it("retains the unchanged chapter-role dependency pin and refuses non-disposable profiler targets", () => {
    const staffVisible = contract.functions.find((item) => item.sig === "private.staff_visible_member_ids(p_role text)");
    expect(staffVisible.bodyContains).toContain("public.member_role_chapters");
    expect(assertDisposableProfileUrl("postgresql://postgres:postgres@127.0.0.1:55362/postgres"))
      .toBe("postgresql://postgres:postgres@127.0.0.1:55362/postgres");
    expect(() => assertDisposableProfileUrl("postgresql://postgres:postgres@not-local.example.invalid:5432/postgres"))
      .toThrow(/owned disposable loopback/);
    expect(() => assertDisposableProfileUrl("postgresql://postgres:postgres@127.0.0.1:55362/postgres?port=54422"))
      .toThrow(/routing overrides/);
  });
});
