// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";

const migrations = migrationFiles();
const allSql = stripComments(migrations.map(({ sql }) => sql).join("\n"));

function latestFunction(signature) {
  const migration = [...migrations].reverse().find(({ sql }) => (
    stripComments(sql).toLowerCase().includes(`function ${signature.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, signature));
}

describe("MFA reset invalidates already-issued access tokens", () => {
  it("records a durable reset boundary through a caller-authorized RPC", () => {
    // Break caught: an authorization-only reset RPC lets factor deletion make
    // every still-live AAL1 JWT satisfy the no-factor branch.
    expect(allSql).toContain("private.member_mfa_reset_boundaries");
    const begin = latestFunction("public.begin_mfa_reset(p_user_id uuid)");
    expect(begin).toContain("public.member_has_role(array['admin'])");
    expect(begin).toContain("p_user_id = caller");
    expect(begin).toContain("insert into private.member_mfa_reset_boundaries");
    expect(begin).toContain("pg_catalog.clock_timestamp()");
  });

  it("requires a current Auth session created after the latest reset boundary", () => {
    // Break caught: deleting the auth.sessions lookup or the created_at
    // comparison makes a signed-out or pre-reset JWT valid until expiry.
    const predicate = latestFunction("private.mfa_satisfied()");
    expect(predicate).toMatch(/auth\.jwt\(\)\s*->>\s*'session_id'/);
    expect(predicate).toContain("from auth.sessions session");
    expect(predicate).toContain("session.user_id = claims.user_id");
    expect(predicate).toMatch(/session\.created_at > coalesce\(\s*boundary\.invalid_before/);
    expect(predicate.indexOf("from auth.sessions session"))
      .toBeLessThan(predicate.indexOf("when claims.aal = 'aal2' then true"));
  });

  it("denies every session while a one-time recovery is between preparation and finalization", () => {
    // Break caught: deleting the last TOTP factor before a durable recovery
    // lock exists makes the original AAL1 JWT satisfy the no-factor branch.
    const predicate = latestFunction("private.mfa_satisfied()");
    expect(predicate).toContain("private.member_mfa_recovery_locks");
    expect(predicate).toContain("recovery.user_id = claims.user_id");
    expect(predicate.indexOf("private.member_mfa_recovery_locks"))
      .toBeLessThan(predicate.indexOf("when claims.aal = 'aal2' then true"));
  });

  it("lets an authorized administrator recover a stranded self-recovery lock without reopening old sessions", () => {
    // The self-service endpoint can fail after installing its durable lock.
    // Administrator reset is the fail-closed liveness path: establish the
    // newer session boundary under the target member lock, invalidate the
    // abandoned claim, then release only that member's recovery lock.
    const begin = latestFunction("public.begin_mfa_reset(p_user_id uuid)");
    const memberLock = begin.indexOf("pg_catalog.hashtext('member-sessions:' || p_user_id::text)");
    const boundary = begin.indexOf("insert into private.member_mfa_reset_boundaries");
    const invalidateClaim = begin.indexOf("update public.mfa_recovery_codes");
    const releaseRecovery = begin.indexOf("delete from private.member_mfa_recovery_locks");

    expect(memberLock).toBeGreaterThan(-1);
    expect(boundary).toBeGreaterThan(memberLock);
    expect(invalidateClaim).toBeGreaterThan(boundary);
    expect(releaseRecovery).toBeGreaterThan(invalidateClaim);
    expect(begin).toContain("where user_id = p_user_id");
    expect(begin).toContain("and used_at is null");
    expect(begin).toContain("claim_session_handle = null");
  });
});
