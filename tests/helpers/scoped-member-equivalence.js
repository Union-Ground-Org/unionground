import assert from "node:assert/strict";
import { assertDisposableProofUrl } from "../../scripts/run-required-db-proofs.mjs";

// Keep this oracle independent of the optimized set body. Nov 12
// ruling requires the original enumeration filtered by the unchanged scalar
// predicate, including full EXCEPT comparisons in both directions.
export const SCOPED_MEMBER_ROLES = Object.freeze([
  "steward", "coordinator", "advisor", "admin", "vp", "secretary", "records", "treasurer", "unknown", null,
]);
const comparison = `with enumeration as materialized (
  select scope.chapter_id,candidate.user_id
  from private.steward_assignment_scopes((select auth.uid()),null) scope
  cross join lateral (
    select member_id as user_id from private.chapter_unit_member_ids(scope.unit_id,scope.chapter_id) member_id
    union
    select m.user_id from public.member_chapter_memberships m
      where scope.legacy_chapter_coverage and m.chapter_id=scope.chapter_id and m.status='active'
    union
    select m.user_id from private.chapter_committee_members m
      where m.committee_id=scope.committee_id and m.chapter_id=scope.chapter_id
  ) candidate
  where scope.user_id=(select auth.uid()) and scope.role=$1
), evaluated as materialized (
  select enumeration.*,private.chapter_scoped_role_allows(chapter_id,$1,user_id,false) allowed
  from enumeration
), reference as materialized (
  select distinct user_id from evaluated where allowed
), installed as materialized (
  select user_id from private.chapter_scoped_member_ids($1) member(user_id)
)
select
  array(select user_id from (select user_id from reference except select user_id from installed) missing order by user_id) missing,
  array(select user_id from (select user_id from installed except select user_id from reference) added order by user_id) added,
  (select count(*)::integer from reference) reference_count,
  (select count(*)::integer from installed) installed_count,
  (select count(*)::integer from evaluated where allowed is not true) rejected_candidates`;

export async function assertScopedMemberEquivalence(client, label, roles = SCOPED_MEMBER_ROLES) {
  const target = new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
  if (client.connectionParameters.host !== target.hostname || Number(client.connectionParameters.port) !== Number(target.port)) {
    throw new Error("Scoped-member oracle differs from the owned disposable target");
  }
  const role = (await client.query("select current_user as role")).rows[0].role;
  const timeout = (await client.query("select current_setting('statement_timeout') as timeout")).rows[0].timeout;
  // Both helpers remain private. Preserve the caller JWT while invoking them
  // as their owner; no client EXECUTE privilege or policy is changed. The
  // scalar oracle evaluates every candidate (30,006 on the sample-skew desk,
  // about 11 s alone and past 45 s beside the parallel proof files), so it
  // gets its own limit. On a failure the savepoint restores role and limit,
  // and the oracle's own error is reported, not a later aborted statement.
  await client.query("savepoint scoped_member_equivalence");
  const observations = [];
  try {
    await client.query("reset role");
    await client.query("set local statement_timeout = '120s'");
    for (const requestedRole of roles) {
      const result = (await client.query(comparison, [requestedRole])).rows[0];
      assert.deepEqual({ missing: result.missing, added: result.added }, { missing: [], added: [] }, `${label}: ${requestedRole}`);
      assert.equal(result.installed_count, result.reference_count, `${label}: ${requestedRole} duplicate member`);
      observations.push({ role: requestedRole, ...result });
    }
  } catch (error) {
    await client.query("rollback to savepoint scoped_member_equivalence");
    await client.query("release savepoint scoped_member_equivalence");
    throw error;
  }
  await client.query('set local role "' + role.replaceAll('"', '""') + '"');
  await client.query("select set_config('statement_timeout', $1, true)", [timeout]);
  await client.query("release savepoint scoped_member_equivalence");
  return observations;
}
