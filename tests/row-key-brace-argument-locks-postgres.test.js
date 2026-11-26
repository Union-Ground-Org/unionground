// @vitest-environment node
// SEC-UG-ROW-KEY-TRIGGER-BRACE-ARGUMENTS-TAKE-NO-IDENTITY-LOCK-20261028 (#6356).
// Replays the row-key gates exactly as their migrations emit them, first over
// the predecessor helper (negative control: graph lock only) and then after
// the forward repair migration, and reads this backend's pg_locks for the
// identity and case advisory locks. A bulk statement shows the 256-key bound.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { parseFunctions, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";

const read = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const repair = read("20261028201252_row_key_gate_brace_argument_locks");
const predecessor = parseFunctions(read("20261021020656_concurrent_telemetry_lifecycle_admission"))
  .find(entry => entry.name === "private.lock_case_graph_row_keys").source;
const lockCaseGraph = readMigrationFunctions("supabase/migrations")
  .find(entry => entry.name === "private.lock_case_graph").source;
// The gate statement for a relation, verbatim from the migration that emits it.
const gate = (migration, table) => {
  const statement = read(migration).match(new RegExp(`create trigger z99_case_graph_keys before insert or update or delete on ${table.replace(".", "\\.")}\\nfor each row execute function private\\.lock_case_graph_row_keys\\('[^']*', '[^']*'\\);`));
  if (!statement) throw new Error(`no row-key gate for ${table} in ${migration}`);
  return statement[0];
};
const MANIFEST = "20260907150000_account_lifecycle_manifest";
const gates = [
  gate(MANIFEST, "auth.identities"),
  gate(MANIFEST, "auth.sessions"),
  gate(MANIFEST, "auth.mfa_factors"),
  gate(MANIFEST, "public.casework_alerts"),
  gate("20260924170200_member_steward_roster_and_contact", "public.member_conversations"),
];

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U1 = uuid(6356001);
const U2 = uuid(6356002);
const STEWARD = uuid(6356003);
const CASE = uuid(6356004);
const ORG = uuid(6356005);
const ROW = uuid(6356006);
const inserts = {
  "auth.identities": user => ["insert into auth.identities(id, user_id) values($1, $2)", [ROW, user]],
  "auth.sessions": user => ["insert into auth.sessions(id, user_id) values($1, $2)", [ROW, user]],
  "auth.mfa_factors": user => ["insert into auth.mfa_factors(id, user_id) values($1, $2)", [ROW, user]],
  "public.member_conversations": user => [
    "insert into public.member_conversations(id, steward_user_id, user_id) values($1, $2, $3)", [ROW, STEWARD, user]],
};

describe.skipIf(!postgresBin)("row-key gates take identity and case locks for braced arguments in isolated PostgreSQL", () => {
  let db;
  const sql = (text, values) => db.client.query(text, values);
  // pg_locks splits a bigint advisory key into classid (high) and objid (low).
  const held = async (kind, ids) => (await sql(`select id::text from pg_catalog.unnest($1::uuid[]) id
    where exists(select 1 from pg_catalog.pg_locks l where l.pid = pg_catalog.pg_backend_pid()
      and l.locktype = 'advisory' and l.granted and l.objsubid = 1
      and ((l.classid::bigint << 32) | l.objid::bigint)
        = pg_catalog.hashtextextended('case-graph-${kind}:' || id::text, 509)) order by 1`, [ids])).rows.map(row => row.id);
  const keyLocks = async () => (await sql(`select count(*)::int n from pg_catalog.pg_locks
    where pid = pg_catalog.pg_backend_pid() and locktype = 'advisory' and granted and objsubid = 1`)).rows[0].n;
  const commonHeld = async () => (await sql(`select count(*)::int n from pg_catalog.pg_locks
    where pid = pg_catalog.pg_backend_pid() and locktype = 'advisory' and granted
      and classid = 509 and objid = 700 and objsubid = 2 and mode = 'ExclusiveLock'`)).rows[0].n === 1;
  const inTransaction = async (statements, probe) => {
    await sql("begin");
    try {
      for (const [text, values] of statements) await sql(text, values);
      return await probe();
    } finally { await sql("rollback"); }
  };
  const users = ids => async () => ({ common: await commonHeld(), users: await held("auth", ids) });

  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    // Only the relations and the lifecycle review contract are stubbed; the
    // graph lock is the body Main installs and the row-key helper starts as
    // the predecessor the repair migration's md5 guard expects.
    await sql(`
      create schema private; create schema auth;
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      create function auth.role() returns text language sql stable as $$select 'service_role'::text$$;
      create function private.lock_message_lifecycle() returns void language plpgsql as 'begin end';
      create function private.lifecycle_read_admitted() returns boolean language sql as 'select false';
      create function private.lifecycle_telemetry_admitted() returns boolean language sql as 'select false';
      create function private.lock_case_graph(p_auth_ids uuid[], p_case_ids uuid[]) returns void
        language plpgsql security definer set search_path = '' as $function$${lockCaseGraph}$function$;
      create function private.lock_case_graph_row_keys() returns trigger
        language plpgsql security definer set search_path = '' as $function$${predecessor}$function$;
      create table auth.identities(id uuid primary key, user_id uuid not null);
      create table auth.sessions(id uuid primary key, user_id uuid not null);
      create table auth.mfa_factors(id uuid primary key, user_id uuid not null);
      create table public.member_conversations(id uuid primary key, steward_user_id uuid, user_id uuid not null);
      create table public.casework_alerts(id uuid primary key, created_by uuid, case_id uuid,
        organization_id uuid, chapter_id text);
      create table private.account_lifecycle_trigger_review(kind text, schema_name text, table_name text,
        object_name text, definition_hash text, primary key(kind, schema_name, table_name, object_name));
      create function private.account_lifecycle_trigger_surface()
        returns table(kind text, schema_name text, table_name text, object_name text, definition_hash text)
        language sql as $$select 'function', n.nspname::text, '', p.proname::text || '()', md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = 'lock_case_graph_row_keys'$$;
      insert into private.account_lifecycle_trigger_review select * from private.account_lifecycle_trigger_surface();
      create function private.account_lifecycle_referential_action_trigger_issues() returns setof text
        language sql as $$select s.object_name from private.account_lifecycle_trigger_surface() s
          left join private.account_lifecycle_trigger_review r using (kind, schema_name, table_name, object_name)
          where r.definition_hash is distinct from s.definition_hash$$;
    `);
    for (const statement of gates) await sql(statement);
  }, 120000);
  afterAll(async () => { await db?.close(); });

  it("replays the braced catalogue form for every sampled relation", () => {
    expect(gates.map(statement => statement.match(/row_keys\(('[^)]*)\)/)[1])).toEqual([
      "'{user_id}', ''", "'{user_id}', ''", "'{user_id}', ''",
      "'{created_by}', '{case_id,organization_id,chapter_id}'", "'{steward_user_id},{user_id}', ''"]);
  });

  it("the predecessor helper holds the graph lock but no identity or case lock (negative control)", async () => {
    for (const [table, insert] of Object.entries(inserts)) {
      expect(await inTransaction([insert(U1)], users([U1, STEWARD])), table).toEqual({ common: true, users: [] });
    }
    expect(await inTransaction([["insert into public.casework_alerts values($1, $2, $3, $4, 'chapter-1')", [ROW, U1, CASE, ORG]]],
      async () => ({ users: await held("auth", [U1]), cases: await held("case", [CASE]) }))).toEqual({ users: [], cases: [] });
  });

  it("after the repair every braced gate locks OLD and NEW identities on insert, update and delete", async () => {
    await sql(repair);
    expect((await sql("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
    for (const [table, insert] of Object.entries(inserts)) {
      const expected = table === "public.member_conversations" ? [U1, STEWARD].sort() : [U1];
      expect(await inTransaction([insert(U1)], users([U1, U2, STEWARD])), `${table} insert`).toEqual({ common: true, users: expected });
      await sql(...insert(U1));
      try {
        const moved = table === "public.member_conversations" ? [U1, U2, STEWARD].sort() : [U1, U2];
        expect(await inTransaction([[`update ${table} set user_id = $1 where id = $2`, [U2, ROW]]], users([U1, U2, STEWARD])),
          `${table} update`).toEqual({ common: true, users: moved });
        expect(await inTransaction([[`delete from ${table} where id = $1`, [ROW]]], users([U1, U2, STEWARD])),
          `${table} delete`).toEqual({ common: true, users: expected });
      } finally { await sql(`delete from ${table} where id = $1`, [ROW]); }
    }
  });

  it("a composite case key locks the case id only, never the organization or a text chapter", async () => {
    expect(await inTransaction([["insert into public.casework_alerts values($1, $2, $3, $4, 'chapter-1')", [ROW, U1, CASE, ORG]]],
      async () => ({ users: await held("auth", [U1]), cases: await held("case", [CASE, ORG]) })))
      .toEqual({ users: [U1], cases: [CASE] });
  });

  it("bounds a bulk statement to 256 row-key locks and keeps the exclusive graph lock", async () => {
    const bulk = count => [[`insert into public.member_conversations(id, steward_user_id, user_id)
      select gen_random_uuid(), $1, ('00000000-0000-4000-9000-' || lpad(n::text, 12, '0'))::uuid
      from generate_series(1, $2::int) n`, [STEWARD, count]]];
    // Within the bound: 100 members plus the steward, every key held.
    expect(await inTransaction(bulk(100), async () => ({ common: await commonHeld(), keys: await keyLocks() })))
      .toEqual({ common: true, keys: 101 });
    // Past the bound: each row spends two keys (member and steward), so 128 rows
    // fill the 256-key budget; 1,000 rows complete with 128 members plus the steward.
    const past = await inTransaction(bulk(1000), async () => ({
      common: await commonHeld(), keys: await keyLocks(),
      rows: (await sql("select count(*)::int n from public.member_conversations")).rows[0].n,
    }));
    expect(past.common).toBe(true);
    expect(past.rows).toBe(1000);
    expect(past.keys).toBe(129);
  });

  it("a malformed or negative budget counter takes no further row-key locks", async () => {
    for (const value of ["-1", "x", "9999999"]) {
      expect(await inTransaction([["select pg_catalog.set_config('private.case_graph_row_key_locks', $1, true)", [value]], inserts["auth.sessions"](U1)],
        users([U1])), value).toEqual({ common: true, users: [] });
    }
  });
});
