// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// DB-free pins over the verify:rpc lane. The lane itself needs a live
// database; these pins keep its wiring and its safety discipline from rotting
// in the DB-free CI path. REQ-UG-RPC-INTEGRATION-TESTS-20260725.

const script = readFileSync(new URL("../scripts/verify-rpc-behaviour.mjs", import.meta.url), "utf8");
// Safety pins match COMMENT-STRIPPED source (house discipline): a comment must
// not be able to satisfy a pin about what the code does.
const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
// The target guard moved out of this script into the module both verify lanes
// import, so the pin below follows it: the caller keeps the call, the module
// keeps the forbidden-ref list, and neither half can be dropped silently.
const guard = readFileSync(new URL("../scripts/lib/assert-exact-target.mjs", import.meta.url), "utf8");
const guardCode = guard.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Union Ground's required workflow is ci.yml (it replaced check.yml); the
// donor repository's task-comment no-fiction CI step is not part of it.
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("verify:rpc wiring", () => {
  it("is an npm script pointing at the probe file", () => {
    expect(pkg.scripts["verify:rpc"]).toBe("node --env-file-if-exists=.env.local scripts/verify-rpc-behaviour.mjs");
  });

  it("is quarantined out of required CI behind the no-fiction tenancy contract", () => {
    // The rollback-only fixtures create fictional auth.users, chapters, and
    // related rows, which the binding no-fiction rule forbids in a required
    // lane. This suite stays runnable only behind an explicit owner exception.
    // TEST-UG-RPC-BEHAVIOUR-NO-FICTION-20260816.
    expect(ci).not.toContain("name: RPC behaviour");
    expect(ci).not.toMatch(/^\s*run:\s*npm run verify:rpc\s*$/m);
  });

  it("fails closed when armed without the explicit owner exception", () => {
    const skipBranch = code.indexOf("if (!connectionString) {");
    const guard = code.indexOf("ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES");
    const target = code.indexOf("assertExactTarget(contract.target, connectionString, {");
    expect(skipBranch).toBeGreaterThan(-1);
    expect(guard, "the owner-authorization guard must exist").toBeGreaterThan(skipBranch);
    expect(target, "the guard must run before target validation and connect").toBeGreaterThan(guard);
  });

  it("is NOT part of npm run check — that chain must stay DB-free for fork PRs", () => {
    expect(pkg.scripts.check).not.toContain("verify:rpc");
  });
});

describe("verify:rpc safety discipline", () => {
  // The one pin that actually protects production: the script must not
  // contain the token that could persist a probe write — not even in a
  // comment, so a "temporary debugging" edit cannot hide behind prose.
  it("never commits, in any spelling, anywhere in the file", () => {
    expect(script).not.toMatch(/commit/i);
  });

  it("skips cleanly without the secret and arms into a hard fail", () => {
    expect(code).toContain("if (!connectionString) {");
    expect(code).toContain("REQUIRE_DB_VERIFY");
    expect(code).toContain("::warning title=verify:rpc skipped::");
    expect(code).toContain("process.exit(0);");
    // The arming rule lives in one shared helper, so it cannot drift per script.
    expect(code).toContain('from "./lib/require-db-verify.mjs"');
    expect(code).toContain("if (requireDbVerify()) {");
  });

  it("guards the exact target project before connecting", () => {
    expect(code).toContain("assertExactTarget(contract.target, connectionString, {");
    expect(code).toContain('from "./lib/assert-exact-target.mjs"');
    expect(guardCode).toContain("forbiddenProjectRefIn(target, haystack)");
    expect(guardCode).toContain("Forbidden legacy Supabase project");
  });

  it("wraps every probe in the rolled-back transaction discipline", () => {
    expect(code).toContain('await client.query("begin")');
    expect(code).toContain('await client.query("rollback")');
    expect(code).toContain("savepoint probe");
    expect(code).toContain("rollback to savepoint probe");
    expect(code, "a residue sweep must prove the rollback").toContain("zero probe residue after rollback");
  });

  it("covers the three filed probe families plus their control arms", () => {
    expect(script).toContain("aal1 with enrolled TOTP is refused (42501)");
    expect(script).toContain("aal2 passes the assurance guard");
    expect(script).toContain("aal1 with no factor passes (non-lockout)");
    expect(script).toContain("null caller is refused (42501)");
    expect(script).toContain("weekly cap exhausted -> backed mint writes 0 point events");
    expect(script).toContain("under the cap the same mint pays 25");
    expect(script).toContain("cross-ballot option refused with 22023");
    expect(script).toContain("invalid option for this ballot");
    expect(script).toContain("valid vote succeeds");
    // Ballot-secrecy generation (20260808230000): the valid vote is asserted
    // end-to-end against the unlinkable-storage shape, and votes are FINAL.
    expect(script).toContain("valid vote returns a non-empty receiptCode");
    expect(script).toContain("vote lands as exactly one anonymous choice row");
    expect(script).toContain("no user-linked vote row is written");
    expect(script).toContain("second vote for the same ballot is refused (22023)");
    expect(script).toContain("your vote is already recorded");
    expect(code).toContain("member_ballot_choices");
    expect(code, "the residue sweep counts the choice store, not the emptied votes table").toContain(
      "select count(*) from public.member_ballot_choices where ballot_id in ('probe-rpc-ballot-a', 'probe-rpc-ballot-b')",
    );
    expect(script).toContain("hard-purged task number is never reused");
    expect(code).toContain("delete from public.chapter_tasks where id = $1");
    expect(code).toContain("Number(secondTask.task_number) > Number(firstTask.task_number)");
    // UB-RGT-02: the live lane must exercise the public invoker function as
    // authenticated users, not merely inspect its SQL text as postgres.
    expect(script).toContain("member sees only same-chapter published chapter-visible document");
    expect(script).toContain("staff sees same-chapter published chapter and staff documents only");
    expect(script).toContain("foreign member sees only their own chapter's published document");
    expect(script).toContain("member search excludes same-chapter published nonmatching document");
    expect(code).toContain("from public.search_member_kb($1, 6)");
    expect(code, "the residue sweep must cover every synthetic library row").toContain(
      "select count(*) from public.chapter_documents where title like 'COMPASS-PROBE-%'",
    );
    // UB-VOTE-05: live authenticated writes, not just migration text, prove
    // each onward target plus the refusal and idempotency boundaries.
    expect(script).toContain("direct intake lifecycle update is column-denied");
    expect(script).toContain("cross-chapter intake owner is refused");
    expect(script).toContain("ordinary member cannot triage intake");
    expect(script).toContain("ordinary member cannot convert intake");
    expect(script).toContain("foreign-chapter intake staff cannot triage");
    expect(script).toContain("foreign-chapter intake staff cannot convert");
    expect(script).toContain("denied intake callers leave reports unchanged");
    expect(script).toContain("same-chapter intake owner triage succeeds");
    expect(script).toContain("converted case belongs to the reporter");
    expect(script).toContain("same-target intake retry is idempotent");
    expect(script).toContain("closed same-target intake retry is idempotent");
    expect(script).toContain("converted intake cannot switch targets");
    expect(script).toContain("intake task keeps sensitive report text off the card");
    expect(script).toContain("intake converts into the selected accessible space");
    expect(code).toContain("zero intake probe residue after rollback");
    // UB-IDN-01 / UB-CON-07: authenticated admin and service-role calls prove
    // the invitation state machine, not only its migration text.
    expect(script).toContain("invitation tables remain RPC-only for authenticated admins");
    expect(script).toContain("ordinary member cannot create an invitation");
    expect(script).toContain("admin cannot create an invitation for another chapter");
    expect(script).toContain("foreign admin cannot create an invitation into the target chapter");
    expect(script).toContain("live duplicate and existing identity return the same accepted no-send outcome");
    expect(script).toContain("foreign admin resend/revoke are anti-enumerating no-ops without mutation");
    expect(script).toContain("serialized claim makes an in-flight invitation unavailable to replay");
    expect(script).toContain("expired invitation claim fails closed and destroys its digest");
    expect(script).toContain("finalize binds the exact Auth identity, chapter profile, and allowlisted role once");
    expect(script).toContain("persisted admin invitation rate limit also counts anti-enumerating no-ops");
    expect(script).toContain("persisted anonymous accept throttle allows twenty attempts then refuses");
    expect(script).toContain("invitation lifecycle audit is populated without email or secret keys");
    expect(code).toContain("zero invitation and rate-limit probe residue after rollback");
    expect(code).toContain("set local role service_role");
    // UB-IDN-02: authenticated calls prove the admin+MFA, same-chapter,
    // serialization, exact-Auth-state, audit-privacy and rollback boundaries.
    expect(script).toContain("sign-in recovery ledger remains private from authenticated admins");
    expect(script).toContain("aal1 admin with enrolled TOTP cannot search recovery targets");
    expect(script).toContain("ordinary member cannot search or begin sign-in recovery");
    expect(script).toContain("foreign admin cannot begin recovery for another chapter");
    expect(script).toContain("admin cannot recover their own sign-in address");
    expect(script).toContain("same-chapter name-only recovery search omits every email");
    expect(script).toContain("denied recovery callers leave no operation or audit mutation");
    expect(script).toContain("exact same-target recovery retry returns one serialized operation");
    expect(script).toContain("recovery cannot finalize before exact Auth digest and session-revocation proof");
    expect(script).toContain("foreign admin cannot finalize another admin's recovery operation");
    expect(script).toContain("exact Auth address plus session revocation finalizes once");
    expect(script).toContain("occupied address is refused without revealing the conflicting identity");
    expect(script).toContain("recovery failure accepts only closed codes and audits without email data");
    expect(script).toContain("persisted recovery limits refuse the sixth admin attempt");
    expect(code).toContain("zero sign-in recovery probe residue after rollback");
    // UB-IDN-05 / UB-SET-05: vendor-session and push fixtures prove the
    // selected revoke and shared-device cleanup boundaries end to end.
    expect(script).toContain("session revocation ledger remains private from authenticated members");
    expect(script).toContain("session-closing barrier remains private from authenticated members");
    expect(script).toContain("aal1 member with enrolled TOTP cannot list device sessions");
    expect(script).toContain("no-factor member sees only current and active remote sessions through opaque handles");
    expect(script).toContain("foreign member session inventory is independently self-scoped");
    expect(script).toContain("push upsert derives the current opaque session binding");
    expect(script).toContain("current, foreign, and malformed session revokes are refused without mutation");
    expect(script).toContain("selected remote revoke removes Auth, refresh, target push, and legacy push atomically");
    expect(script).toContain("exact selected-session replay returns the existing revoked outcome");
    expect(script).toContain("revoked session JWT cannot reuse the device-session definer RPC");
    expect(script).toContain("signout cleanup refuses missing or stale captured account identity before mutation");
    expect(code).toContain("select public.prepare_my_signout('local') as result");
    expect(code).toContain("select public.delete_my_native_push_installation($1) as result");
    expect(code).toContain("omittedSignoutIdentity.code === \"42501\"");
    expect(code).toContain("omittedNativeDeleteIdentity.code === \"42501\"");
    expect(script).toContain("native push deletion returns uniform false for foreign and unknown installations");
    expect(script).toContain("native push deletion removes only the exact caller installation");
    expect(script).toContain("local signout preparation removes current push without revoking Auth itself");
    expect(script).toContain("local signout preserves remote and foreign native installations");
    expect(script).toContain("local signout barrier refuses current-session web and native re-registration");
    expect(script).toContain("local signout barrier preserves registration on another live self session");
    expect(script).toContain("global signout preparation removes every push row before Auth logout");
    expect(script).toContain("global signout removes all caller native installations and preserves foreign installations");
    expect(script).toContain("global signout barrier refuses current and remote self re-registration");
    expect(script).toContain("global signout barrier leaves a foreign live session able to register");
    expect(script).toContain("authorized administrator reset reconciles a stranded self-recovery lock behind a newer session boundary");
    expect(script).toContain("foreign-organization administrator reset is refused without mutating recovery state");
    // The reported name follows the installed catalog: a pre-#2114 catalog does
    // NOT refuse the foreign-organization reset, so the green line must not say
    // it did. BUG-UG-RPC-PROBE-ADMIN-RESET-UNPRIVILEGED-READ-20260917.
    expect(script).toContain("foreign-organization administrator reset still reaches its target (pre-#2114 catalog, expected-to-fail-until-#2114)");
    expect(code).toContain("const foreignOrgCheckName = tenantScopedReset");
    expect(code).toContain("check(foreignOrgCheckName,");
    expect(code).toContain("select public.begin_mfa_reset($1) as result");
    expect(code).toContain("callAsThenObserve");
    expect(code).toContain("insert into public.organizations (id, slug, name, status, created_by)");
    expect(code).toContain("insert into public.chapters");
    expect(code).toContain("insert into public.organization_memberships (organization_id, user_id, status)");
    expect(code).toContain("insert into public.member_chapter_memberships (user_id, chapter_id, status)");
    expect(code).toContain("pg_catalog.pg_get_functiondef('public.begin_mfa_reset(uuid)'::regprocedure)");
    expect(code).toContain("expected-to-fail-until-#2114");
    expect(code).not.toMatch(/update\s+public\.chapters[\s\S]{0,120}organization_id/i);
    expect(code).toContain("insert into public.member_role_chapters (user_id, role, chapter_id) values");
    expect(code).toContain("insert into public.organization_role_grants (organization_id, user_id, role) values");
    expect(code).toContain("insert into public.member_native_push_installations");
    expect(code).toContain("select public.register_my_native_push_installation($1, 'fcm', 'production', $2, $3, $4) as result");
    expect(code).toContain("zero device-session, refresh, web/native push, audit, revocation, and closing-barrier residue after rollback");
    expect(code).toContain("zero focused device-session probe residue after rollback");
    // UB-WKL-03: the local rollback lane compiles and exercises the complete
    // privacy boundary, including adversarial NULL schedules and queue rules.
    expect(script).toContain("workload distribution is chapter-scoped, latest/member, K=25, and band-only");
    expect(script).toContain("workload distribution with fewer than 25 chapter submitters is explicitly unavailable");
    expect(script).toContain("workload intelligence enforces both staff role and enrolled-factor MFA");
    expect(script).toContain("workload intelligence refuses a staff role scoped to another chapter without returning data");
    expect(script).toContain("workload trends use two-plus eligible K=25 weeks and a four-week category forecast");
    expect(script).toContain("workload rebalancing is bounded and contains counts-only staff suggestions");
    expect(script).toContain("workload reminder schedule rejects null cadence, weekday, hour, and timezone");
    expect(script).toContain("identical workload reminder saves preserve the future due instant");
    expect(script).toContain("workload submission atomically creates a generic eight-hex receipt and queued email");
    expect(script).toContain("workload receipt bypasses focus with event-only dispatcher metadata");
    expect(script).toContain("workload reminders respect the five-per-week nudge cap");
    expect(script).toContain("workload topic off preserves in-app history and blocks outbound");
    expect(script).toContain("workload reminder sweep advances once from now without backlog replay");
    expect(code).toContain("zero workload intelligence probe residue after rollback");
    expect(code).toContain("zero focused workload probe residue after rollback");
  });

  it("allows pending migration proof only through a loopback exact-target alias", () => {
    expect(code).toContain("VERIFY_RPC_PENDING_MIGRATION");
    expect(code).toContain("VERIFY_RPC_FOCUS");
    expect(code).toContain("!loopbackTarget");
    expect(code).toContain("one migration basename");
    expect(code).toContain("disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM");
    expect(code).toContain("!pendingMigration || focusedSessionResidue.pending_schema_rolled_back === true");
  });

  it("does not import verify-db-contract.mjs (that module executes at import time)", () => {
    expect(script).not.toMatch(/from\s+["']\.\/verify-db-contract\.mjs["']/);
  });

  it("observes admin-reset reconciliation as the session owner, not as authenticated", () => {
    // BUG-UG-RPC-PROBE-ADMIN-RESET-UNPRIVILEGED-READ-20260917: the three
    // tables are revoked from authenticated, so a CTE that both calls
    // begin_mfa_reset and counts those rows under `set local role authenticated`
    // is permanently 42501 and asserts nothing about the reset.
    const helperAt = code.indexOf("async function callAsThenObserve");
    const helperEnd = code.indexOf("async function callServiceKeeping", helperAt);
    expect(helperAt).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperAt);
    const helper = code.slice(helperAt, helperEnd);
    const authRoleAt = helper.indexOf("set local role authenticated");
    const resetRoleAt = helper.indexOf("reset role");
    const observeAt = helper.indexOf("client.query(observeSql");
    expect(authRoleAt).toBeGreaterThan(-1);
    expect(resetRoleAt).toBeGreaterThan(authRoleAt);
    expect(observeAt).toBeGreaterThan(resetRoleAt);
    expect(helper).toContain("rollback to savepoint probe");
    expect(helper).not.toContain("set local role service_role");

    const begin = "select public.begin_mfa_reset($1) as result";
    const beginAt = code.indexOf(begin);
    expect(beginAt).toBeGreaterThan(helperEnd);
    expect(code.split(begin).length - 1, "same-org and foreign-org arms each call begin_mfa_reset").toBe(2);
    const observeSqlAt = code.indexOf("const recoveryObserveSql");
    expect(observeSqlAt).toBeGreaterThan(helperEnd);
    expect(observeSqlAt).toBeLessThan(beginAt);
    const observeSql = code.slice(observeSqlAt, beginAt);
    expect(observeSql).toContain("from private.member_mfa_recovery_locks");
    expect(observeSql).toContain("from public.mfa_recovery_codes");
    expect(observeSql).toContain("from private.member_mfa_reset_boundaries");
    const secondBeginAt = code.indexOf(begin, beginAt + 1);
    const firstRpc = code.slice(beginAt, secondBeginAt);
    const secondRpcEnd = code.indexOf("foreign-organization administrator reset is refused without mutating recovery state");
    expect(secondRpcEnd).toBeGreaterThan(secondBeginAt);
    const secondRpc = code.slice(secondBeginAt, secondRpcEnd);
    for (const rpc of [firstRpc, secondRpc]) {
      expect(rpc).not.toMatch(/with reset as materialized/);
      expect(rpc).not.toContain("member_mfa_recovery_locks");
      expect(rpc).not.toContain("mfa_recovery_codes");
      expect(rpc).not.toContain("member_mfa_reset_boundaries");
    }
    expect(code).not.toMatch(
      /grant\s+(?:all|select)\b[\s\S]{0,80}(private\.member_mfa_recovery_locks|public\.mfa_recovery_codes|private\.member_mfa_reset_boundaries)/i,
    );
  });
});
