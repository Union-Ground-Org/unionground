// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { caseGraphWrappedSource, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const migrationName = "20260912002000_auth_bookkeeping_lock_scope.sql";
const sql = loadMigrationSql("auth_bookkeeping_lock_scope");
const executable = stripComments(sql);
const normalized = executable.replace(/\s+/g, " ").trim().toLowerCase();
const dbContract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const previousSources = [
  loadMigrationSql("g5_mobile_attachment_two_phase"),
  loadMigrationSql("demo_seed_casework_repeat_apply_repair"),
];
const columns = [
  "id", "instance_id", "aud", "role", "email", "phone", "deleted_at", "banned_until",
  "is_sso_user", "is_anonymous", "raw_user_meta_data", "email_change", "phone_change",
];
const eventClause = `before insert or delete or update of ${columns.join(", ")} on auth.users`;
const exemptTables = [
  "auth.sessions", "auth.refresh_tokens", "auth.one_time_tokens", "auth.mfa_amr_claims",
  "auth.mfa_challenges", "auth.identities",
];
const sharedTables = ["auth.users", ...exemptTables];
const explicitFunctions = [
  "public.claim_mfa_recovery_code",
  "public.prepare_mfa_recovery_signout",
  "public.revoke_my_session",
  "public.presg_demo_prepare_reapply",
  "public.uniondemo_prepare_reapply",
];

function priorSource(name) {
  return previousSources.flatMap(source => parseFunctions(source)).filter(fn => fn.name === name).at(-1)?.source;
}

describe("Auth bookkeeping advisory lock migration", () => {
  it("runs after the complete lifecycle lock chain", () => {
    const names = migrationNames();
    const index = names.indexOf(migrationName);
    expect(index).toBeGreaterThan(-1);
    for (const earlier of [
      "20260907150000_account_lifecycle_manifest.sql",
      "20260907151000_account_deletion_finalization_reconciliation.sql",
      "20260907152000_sensitive_content_lock_order.sql",
      "20260907153000_member_invitation_accept_limit_pruning.sql",
      "20260908170000_cron_job_health_sync_incremental.sql",
    ]) expect(names.indexOf(earlier)).toBeLessThan(index);
  });

  it("is transactional top-level SQL and never names the generated confirmed_at column", () => {
    expect(normalized.startsWith("begin;")).toBe(true);
    expect(normalized.endsWith("commit;")).toBe(true);
    expect(executable).not.toMatch(/\bdo\s+\$/i);
    expect(executable).not.toMatch(/\bexecute\s+\$[a-z0-9_]*\$/i);
    expect(normalized).not.toContain("confirmed_at");
  });

  it("defines the shared, exclusive, and gate-then-exclusive trigger functions exactly", () => {
    const functions = new Map(parseFunctions(sql).map(fn => [fn.name, fn.source.replace(/\s+/g, " ").trim().toLowerCase()]));
    expect(functions.get("private.lock_auth_bookkeeping_shared")).toBe(
      "begin perform pg_catalog.pg_advisory_xact_lock_shared(509, 701); return null; end;",
    );
    expect(functions.get("private.lock_auth_bookkeeping_exclusive")).toBe(
      "begin perform pg_catalog.pg_advisory_xact_lock(509, 701); return null; end;",
    );
    expect(functions.get("private.lock_case_graph_statement_auth")).toBe(
      "begin perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]); perform pg_catalog.pg_advisory_xact_lock(509, 701); return null; end;",
    );
    for (const name of ["lock_auth_bookkeeping_shared", "lock_auth_bookkeeping_exclusive", "lock_case_graph_statement_auth"]) {
      expect(normalized).toContain(`revoke all on function private.${name}() from public, anon, authenticated, service_role;`);
    }
    expect(normalized.indexOf("lock_case_graph(array[]::uuid[], array[]::uuid[])")).toBeLessThan(
      normalized.indexOf("pg_catalog.pg_advisory_xact_lock(509, 701)", normalized.indexOf("create function private.lock_case_graph_statement_auth")),
    );
  });

  it("column-scopes all three auth.users gates and orders a00 before a01", () => {
    for (const [name, each, fn] of [
      ["a00_case_graph_lock", "statement", "private.lock_case_graph_statement_auth()"],
      ["z99_case_graph_keys", "row", "private.lock_case_graph_row_keys('id', '')"],
      ["message_lifecycle_statement", "statement", "private.lock_message_lifecycle_statement()"],
    ]) {
      expect(normalized).toContain(`drop trigger if exists ${name} on auth.users;`);
      expect(normalized).toContain(`create trigger ${name} ${eventClause} for each ${each} execute function ${fn};`);
    }
    expect("a00_case_graph_lock" < "a01_auth_bookkeeping_shared").toBe(true);
    expect((normalized.match(/before insert or delete or update of/g) || [])).toHaveLength(3);
  });

  it("removes both gates from six relations and installs all seven shared statement triggers", () => {
    for (const table of exemptTables) {
      expect(normalized).toContain(`drop trigger if exists a00_case_graph_lock on ${table};`);
      expect(normalized).toContain(`drop trigger if exists z99_case_graph_keys on ${table};`);
      expect(normalized).toContain(`create trigger a01_auth_bookkeeping_shared before insert or update or delete on ${table} for each statement execute function private.lock_auth_bookkeeping_shared();`);
    }
    for (const table of sharedTables) {
      expect(normalized).toContain(`on ${table} for each statement execute function private.lock_auth_bookkeeping_shared();`);
    }
    expect((normalized.match(/create trigger a01_auth_bookkeeping_shared/g) || [])).toHaveLength(7);
  });

  it("gates oauth client deletion before its exclusive bookkeeping trigger", () => {
    // The DELETE cascade reaches auth.oauth_authorizations and auth.oauth_consents,
    // which keep a00_case_graph_lock. Taking (509, 701) before the graph gate
    // would let the deleter own it while waiting for the gate a covered
    // auth.users statement already holds.
    expect(normalized).toContain("create trigger a00_case_graph_lock before delete on auth.oauth_clients for each statement execute function private.lock_case_graph_statement();");
    expect(normalized).toContain("create trigger a01_auth_bookkeeping_exclusive before delete on auth.oauth_clients for each statement execute function private.lock_auth_bookkeeping_exclusive();");
    expect(normalized.indexOf("create trigger a00_case_graph_lock before delete on auth.oauth_clients"))
      .toBeLessThan(normalized.indexOf("create trigger a01_auth_bookkeeping_exclusive before delete on auth.oauth_clients"));
    expect("a00_case_graph_lock" < "a01_auth_bookkeeping_exclusive").toBe(true);
    expect(normalized).not.toContain("a00_case_graph_lock before insert or update or delete on auth.oauth_clients");
    expect(normalized).not.toContain("z99_case_graph_keys on auth.oauth_clients");
    expect(normalized).not.toContain("a01_auth_bookkeeping_shared before insert or update or delete on auth.oauth_clients");
  });

  it("changes each direct child locker and uncovered users writer by the one exclusive line", () => {
    const migrated = parseFunctions(sql);
    for (const name of explicitFunctions) {
      const source = migrated.find(fn => fn.name === name)?.source;
      expect(source).toBeTruthy();
      const gate = "  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n";
      const exclusive = "  perform pg_catalog.pg_advisory_xact_lock(509, 701);\n";
      expect(source.startsWith(`\nbegin\n${gate}${exclusive}`)).toBe(true);
      expect(source.replace(exclusive, "")).toBe(caseGraphWrappedSource(priorSource(name)));
      expect(source.indexOf(exclusive)).toBeLessThan(source.search(/\b(?:from|update|delete from) auth\./i));
    }
  });

  it("reconciles retired, replacement, and new trigger/function review rows from the catalogue", () => {
    expect(normalized).toContain("delete from private.account_lifecycle_trigger_review");
    expect(normalized).toContain("insert into private.account_lifecycle_trigger_review");
    expect(normalized).toContain("from private.account_lifecycle_trigger_surface()");
    for (const table of ["sessions", "refresh_tokens", "one_time_tokens", "mfa_amr_claims", "mfa_challenges", "identities", "oauth_clients", "users"]) {
      expect(normalized).toContain(`'${table}'`);
    }
    for (const object of ["a00_case_graph_lock", "z99_case_graph_keys", "message_lifecycle_statement", "a01_auth_bookkeeping_shared", "a01_auth_bookkeeping_exclusive"]) {
      expect(normalized).toContain(`'${object}'`);
    }
    expect(normalized).not.toMatch(/account_lifecycle_trigger_review[\s\S]{0,500}'[a-f0-9]{32}'/);
  });

  it("does not replace the existing case-graph or message-lifecycle lock functions", () => {
    expect(normalized).not.toMatch(/(?:create|alter)\s+(?:or replace\s+)?function\s+private\.(?:lock_case_graph\(|lock_case_graph_statement\(|lock_case_graph_row_keys\(|lock_message_lifecycle)/);
    const triggerRelations = [...normalized.matchAll(/(?:drop|create) trigger [\s\S]*?\bon\s+(auth\.[a-z0-9_]+)/g)].map(match => match[1]);
    expect(new Set(triggerRelations)).toEqual(new Set(["auth.users", ...exemptTables, "auth.oauth_clients"]));
  });

  it("pins database contracts and exact required-proof arithmetic", () => {
    for (const [sig, needle] of [
      ["private.lock_auth_bookkeeping_shared()", "pg_advisory_xact_lock_shared(509, 701)"],
      ["private.lock_auth_bookkeeping_exclusive()", "pg_advisory_xact_lock(509, 701)"],
      ["private.lock_case_graph_statement_auth()", "private.lock_case_graph(array[]::uuid[], array[]::uuid[])"],
      ["public.revoke_my_session(p_session_handle text)", "pg_advisory_xact_lock(509, 701)"],
    ]) expect(dbContract.functions).toContainEqual(expect.objectContaining({ sig, secdef: true, bodyContains: expect.arrayContaining([needle]) }));
    const liveProof = readFileSync(new URL("./auth-bookkeeping-lock-scope-db.test.js", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../scripts/run-required-db-proofs.mjs", import.meta.url), "utf8");
    const cases = (liveProof.match(/^\s{2}it\(/gm) || []).length;
    expect(cases).toBeGreaterThanOrEqual(12);
    expect(liveProof).not.toMatch(/\b(it|describe)\.(skip|only|todo)\(/);
    expect(PROOF_FILES).toContain("tests/auth-bookkeeping-lock-scope-db.test.js");
    expect(runner).toContain('RUN_AUTH_BOOKKEEPING_LOCK_SCOPE_DB_TESTS: "1"');
    // 127 proofs on Main at the merge base of this lane: the 105 it branched
    // from plus the private-upload currency projection, the hosted
    // sensitive-RPC grant regression, twelve steward desk scale-latency cases,
    // the connected automation behaviour proof, the SAMPLE lineage carrier,
    // the shared automation intelligence proof and the five membership-card
    // nonce cases.
    expect(PROOF_FILES).toContain("tests/pg-net-tick-request-id-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-attachment-lifecycle-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-child-row-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/coordinator-case-write-restriction-gate-db.test.js");
    expect(PROOF_FILES).toContain("tests/chapter-verification-identity-db.test.js");
    expect(PROOF_FILES).toContain("tests/case-history-db.test.js");
    expect(PROOF_FILES).toContain("tests/coordinator-queue-tenant-scope-db.test.js");
    expect(PROOF_FILES).toContain("tests/casework-audit-reader-kinds-db.test.js");
    expect(PROOF_FILES).toContain("tests/dues-oauth-recovery-account-check-db.test.js");
    expect(PROOF_FILES).toContain("tests/public-chapter-microsite-direct-dml-db.test.js");
    expect(PROOF_FILES).toContain("tests/casework-reminders-direct-dml-db.test.js");
    expect(PROOF_FILES).toContain("tests/public-site-chapter-parent-delete-db.test.js");
    expect(PROOF_FILES).toContain("tests/vote-campaign-authority-db.test.js");
    expect(PROOF_FILES).toContain("tests/chapter-task-report-window-db.test.js");
    expect(PROOF_FILES).toContain("tests/live-poll-roster-eligibility-db.test.js");
    expect(PROOF_FILES).toContain("tests/survey-publish-atomicity-db.test.js");
    // The runner discovers tests/*-db.test.js files by name; pin that this
    // proof is planned.
    expect(PROOF_FILES).toContain("tests/auth-bookkeeping-lock-scope-db.test.js");
  });
});
