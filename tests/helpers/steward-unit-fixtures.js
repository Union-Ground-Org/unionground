import { assertDisposableProofUrl } from "../../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./migration.js";

// Old broad grants are represented by
// the actual migration backfill, not a new runtime way to create carry-over.
// Call only after an owned disposable fixture has finished creating its real scopes.
export async function migrateLegacyStewardFixtures(client) {
  const url = new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
  const parameters = client.connectionParameters;
  if (parameters.host !== url.hostname || Number(parameters.port) !== Number(url.port)) {
    throw new Error("Steward fixture client differs from the owned disposable target");
  }
  const written = await client.query("select pg_current_xact_id_if_assigned() is not null as written");
  if (!written.rows[0].written) throw new Error("Steward backfill fixture requires an existing written rollback transaction");
  const sql = loadMigrationSql("stewards_require_unit_with_carry_over");
  const backfill = sql.split("-- BEGIN MIGRATION-ONLY BACKFILL (retained verbatim for the rollback proof).")[1]?.split("-- END MIGRATION-ONLY BACKFILL.")[0];
  if (!backfill) throw new Error("Actual steward migration backfill is unavailable");
  const previous = (await client.query("select current_user as role,current_setting('request.jwt.claims',true) as claims")).rows[0];
  await client.query("savepoint legacy_steward_fixture");
  try {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
    // Flush fixture writes before ALTER TABLE too.
    const pending = await client.query(`select quote_ident(n.nspname)||'.'||quote_ident(c.conname) as name
      from pg_catalog.pg_constraint c join pg_catalog.pg_namespace n on n.oid=c.connamespace
      where c.conrelid in ('private.chapter_role_scopes'::regclass,'private.organization_steward_unit_assignments'::regclass)
        and c.condeferrable order by c.oid`);
    for (const { name } of pending.rows) await client.query("set constraints " + name + " immediate");
    await client.query("set constraints all deferred");
    await client.query("alter table private.chapter_role_scopes disable trigger a01_reject_carry_over_insert");
    await client.query("alter table private.organization_steward_unit_assignments disable trigger a01_reject_organization_assignment_insert");
    await client.query(backfill);
    // Flush the deferred events before restoring either guard (5:50 ruling).
    await client.query("set constraints all immediate");
    await client.query("alter table private.chapter_role_scopes enable trigger a01_reject_carry_over_insert");
    await client.query("alter table private.organization_steward_unit_assignments enable trigger a01_reject_organization_assignment_insert");
    await client.query("drop table pg_temp.c69_default_unit_chapters,pg_temp.c69_legacy_stewards");
    await client.query("set constraints all deferred");
    await client.query("select set_config('request.jwt.claims',$1,true)", [previous.claims ?? ""]);
    await client.query('set local role "'+previous.role.replaceAll('"','""')+'"');
    await client.query("release savepoint legacy_steward_fixture");
  } catch (error) {
    await client.query("rollback to savepoint legacy_steward_fixture");
    await client.query("release savepoint legacy_steward_fixture");
    throw error;
  }
}

// New grants get an actual unit; no carry-over bit is accepted or restored.
export async function scopeFixtureSteward(client, user, chapter, unit = null) {
  assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const selected = unit ?? (await client.query("select id from private.chapter_units where chapter_id=$1 order by is_default desc,id limit 1", [chapter])).rows[0]?.id;
  if (!selected) throw new Error("A steward fixture needs an existing chapter unit");
  await client.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values($1,$2,'steward',$3) on conflict(user_id,chapter_id,role) do update set unit_id=excluded.unit_id,committee_id=null,legacy_chapter_coverage=false", [user,chapter,selected]);
  return selected;
}

// A few concurrency fixtures commit setup so other connections can see it.
// Model the historical grant and its actual
// backfill atomically, including when this fixture connection is autocommit.
export async function legacyStewardFixtureWrite(client, sql, args) {
  const url=new URL(assertDisposableProofUrl(process.env.SUPABASE_DB_URL));
  if(client.connectionParameters.host!==url.hostname || Number(client.connectionParameters.port)!==Number(url.port)) throw new Error("Fixture target mismatch");
  if(!/^insert into public\.organization_role_grants\b/i.test(sql.trim()) || !sql.includes("'steward'")) throw new Error("Expected a historical steward fixture grant");
  const written=(await client.query("select pg_current_xact_id_if_assigned() is not null as written")).rows[0].written;
  if(!written) await client.query("begin");
  try {
    const result=await client.query(sql,args);
    await migrateLegacyStewardFixtures(client);
    if(!written) await client.query("commit");
    return result;
  } catch(error) {
    if(!written) await client.query("rollback");
    throw error;
  }
}
