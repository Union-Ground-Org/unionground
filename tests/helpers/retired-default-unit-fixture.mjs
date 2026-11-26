import { assertDisposableProofUrl } from "../../scripts/run-required-db-proofs.mjs";

// Only the exact empty default-unit rows made
// by this rollback fixture are accounted for. The historical removal function
// and its unknown-dependency 55000 refusal are never changed.
export async function removeReviewedDefaultUnitFixtureRows(client, chapterIds) {
  const target = new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
  if (client.host !== target.hostname || Number(client.port) !== Number(target.port)) throw new Error("Retired unit fixture target mismatch");
  if (!Array.isArray(chapterIds) || chapterIds.some(id => typeof id !== "string" || !id)) throw new Error("Exact chapter fixture identifiers required");
  await client.query("savepoint reviewed_default_unit_fixture");
  const reviewed = (await client.query("select id,chapter_id from private.chapter_units where chapter_id=any($1::text[]) and is_default order by id",[chapterIds])).rows;
  const ids = reviewed.map(row => row.id);
  const used = await client.query(`select exists(select 1 from private.chapter_unit_members where unit_id=any($1::uuid[]))
    or exists(select 1 from private.chapter_role_scopes where unit_id=any($1::uuid[]))
    or exists(select 1 from private.organization_steward_unit_assignments where unit_id=any($1::uuid[])) as occupied`,[ids]);
  if (used.rows[0].occupied) throw new Error("Reviewed fixture default unit is no longer empty");
  const removed = await client.query("delete from private.chapter_units where id=any($1::uuid[]) and chapter_id=any($2::text[]) and is_default",[ids,chapterIds]);
  if (removed.rowCount !== reviewed.length) throw new Error("Reviewed fixture unit identifiers changed");
  await client.query("release savepoint reviewed_default_unit_fixture");
  return reviewed;
}
