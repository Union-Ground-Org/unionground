// @vitest-environment node
// BUG-UG-AUTH-RECOVERY-SCIM-ROW-KEY-LOCK-ARGUMENTS-20261027 (#6155).
// Replays the applied Auth adoption and its forward repair on a disposable
// PostgreSQL over the installed lock_case_graph and lock_case_graph_row_keys
// bodies, then reads this backend's pg_locks for the user advisory locks. The
// adoption alone is the negative control: the common graph lock is held but
// no user lock is, which an inventory text match could not show.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { parseFunctions, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";

const read = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const adoption = read("20261027011927_auth_2121_case_graph_adoption");
const repair = read("20261028131832_auth_recovery_scim_row_key_user_lock");
const installed = readMigrationFunctions("supabase/migrations");
const latest = name => installed.find(entry => entry.name === name).source;
// The row-key helper the adoption and this repair were applied under. Since
// #6356 the installed helper also decodes the braced form, which would make
// the adoption's own gates lock the user and void the negative control.
const appliedRowKeys = parseFunctions(read("20261021020656_concurrent_telemetry_lifecycle_admission"))
  .find(entry => entry.name === "private.lock_case_graph_row_keys").source;

const U1 = "00000000-0000-4000-8000-000000006155";
const U2 = "00000000-0000-4000-8000-000000006156";
const FACTOR = "00000000-0000-4000-8000-0000000061f0";
const PROVIDER = "00000000-0000-4000-8000-0000000061a0";
const ROW = "00000000-0000-4000-8000-0000000061b0";
const relations = {
  "auth.mfa_recovery_code_sets": user => [
    "insert into auth.mfa_recovery_code_sets(id, user_id, mfa_factor_id) values($1, $2, $3)", [ROW, user, FACTOR]],
  "auth.scim_users": user => [
    "insert into auth.scim_users(id, sso_provider_id, user_id) values($1, $2, $3)", [ROW, PROVIDER, user]],
};

describe.skipIf(!postgresBin)("Auth recovery-set and SCIM row-key user locks in isolated PostgreSQL", () => {
  let db;
  const sql = (text, values) => db.client.query(text, values);
  // pg_locks splits a bigint advisory key into classid (high) and objid (low).
  const heldUsers = async () => (await sql(`select id::text from pg_catalog.unnest($1::uuid[]) id
    where exists(select 1 from pg_catalog.pg_locks l where l.pid = pg_catalog.pg_backend_pid()
      and l.locktype = 'advisory' and l.granted and l.objsubid = 1
      and ((l.classid::bigint << 32) | l.objid::bigint)
        = pg_catalog.hashtextextended('case-graph-auth:' || id::text, 509)) order by 1`, [[U1, U2]])).rows.map(row => row.id);
  const commonHeld = async () => (await sql(`select count(*)::int n from pg_catalog.pg_locks
    where pid = pg_catalog.pg_backend_pid() and locktype = 'advisory' and granted
      and classid = 509 and objid = 700 and objsubid = 2`)).rows[0].n === 1;
  const inTransaction = async (text, values) => {
    await sql("begin");
    try {
      await sql(text, values);
      return { common: await commonHeld(), users: await heldUsers() };
    } finally { await sql("rollback"); }
  };

  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    // Only the GoTrue relations and the lifecycle review contract are stubbed;
    // the graph lock is the body Main installs.
    await sql(`
      create schema private; create schema auth;
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      create function auth.role() returns text language sql stable as $$select 'service_role'::text$$;
      create function private.lock_message_lifecycle() returns void language plpgsql as 'begin end';
      create function private.lifecycle_read_admitted() returns boolean language sql as 'select false';
      create function private.lifecycle_telemetry_admitted() returns boolean language sql as 'select false';
      create function private.lock_case_graph(p_auth_ids uuid[], p_case_ids uuid[]) returns void
        language plpgsql security definer set search_path = '' as $function$${latest("private.lock_case_graph")}$function$;
      create function private.lock_case_graph_row_keys() returns trigger
        language plpgsql security definer set search_path = '' as $function$${appliedRowKeys}$function$;
      create function private.lock_case_graph_statement() returns trigger language plpgsql as
        'begin perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]); return null; end';
      create function private.lock_auth_bookkeeping_exclusive() returns trigger language plpgsql as 'begin return null; end';
      create table auth.users(id uuid primary key);
      create table auth.mfa_factors(id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade);
      create table auth.mfa_recovery_code_sets(id uuid primary key,
        user_id uuid not null references auth.users(id) on delete cascade,
        mfa_factor_id uuid not null references auth.mfa_factors(id) on delete cascade);
      create table auth.mfa_recovery_codes(id uuid primary key,
        mfa_recovery_code_set_id uuid not null references auth.mfa_recovery_code_sets(id) on delete cascade);
      create table auth.sso_providers(id uuid primary key);
      create table auth.scim_users(id uuid primary key,
        sso_provider_id uuid not null references auth.sso_providers(id) on delete cascade,
        user_id uuid references auth.users(id) on delete cascade);
      create table private.account_lifecycle_trigger_review(kind text, schema_name text, table_name text,
        object_name text, definition_hash text, primary key(kind, schema_name, table_name, object_name));
      create function private.account_lifecycle_trigger_surface()
        returns table(kind text, schema_name text, table_name text, object_name text, definition_hash text)
        language sql as $$select 'trigger', n.nspname::text, c.relname::text, t.tgname::text, md5(pg_get_triggerdef(t.oid))
          from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
          where not t.tgisinternal and n.nspname = 'auth'$$;
      create function private.account_lifecycle_referential_action_trigger_issues() returns setof text
        language sql as $$select s.table_name || '.' || s.object_name from private.account_lifecycle_trigger_surface() s
          left join private.account_lifecycle_trigger_review r using (kind, schema_name, table_name, object_name)
          where r.definition_hash is distinct from s.definition_hash$$;
    `);
    await sql(adoption);
    await sql(`insert into auth.users(id) values('${U1}'), ('${U2}');
      insert into auth.mfa_factors(id, user_id) values('${FACTOR}', '${U1}');
      insert into auth.sso_providers(id) values('${PROVIDER}')`);
  }, 120000);
  afterAll(async () => { await db?.close(); });

  it("the applied adoption holds the common graph lock but no user lock (negative control)", async () => {
    for (const [table, insert] of Object.entries(relations)) {
      expect(await inTransaction(...insert(U1)), table).toEqual({ common: true, users: [] });
    }
  });

  it("the forward repair locks OLD and NEW user_id on insert, update and delete", async () => {
    await sql(repair);
    expect((await sql("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
    for (const [table, insert] of Object.entries(relations)) {
      const triggers = (await sql(`select tgname, pg_get_triggerdef(oid) definition from pg_trigger
        where tgrelid = $1::regclass and not tgisinternal order by tgname`, [table])).rows;
      expect(triggers.map(row => row.tgname), table).toEqual(["a00_case_graph_lock", "z99_case_graph_keys"]);
      expect(triggers[1].definition).toContain("lock_case_graph_row_keys('user_id', '')");

      expect(await inTransaction(...insert(U1)), `${table} insert`).toEqual({ common: true, users: [U1] });
      await sql(...insert(U1));
      try {
        expect(await inTransaction(`update ${table} set user_id = $1 where id = $2`, [U2, ROW]), `${table} update`)
          .toEqual({ common: true, users: [U1, U2] });
        expect(await inTransaction(`delete from ${table} where id = $1`, [ROW]), `${table} delete`)
          .toEqual({ common: true, users: [U1] });
      } finally { await sql(`delete from ${table} where id = $1`, [ROW]); }
    }
  });
});
