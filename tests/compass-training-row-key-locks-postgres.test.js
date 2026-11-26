// @vitest-environment node
// BUG-UG-COMPASS-TRAINING-ROW-KEY-TRIGGER-ARGUMENTS-20261026 (#6058).
// The three Compass training row-key gates pass braced field names
// ('{enabled_by}', '{user_id}'). Organization archive cleanup supplies no user
// IDs to lock_case_graph and relies on these row triggers, so each must take
// its identity lock. The gates are replayed verbatim from their migration over
// the predecessor helper (negative control: graph lock only) and over the
// helper the migrations install last (#6405), and this backend's pg_locks is
// read for the identity advisory locks.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";
import { parseFunctions, readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";

const read = name => readFileSync(new URL(`../supabase/migrations/${name}.sql`, import.meta.url), "utf8");
const COMPASS = "20261027060200_compass_training_retention";
const predecessor = parseFunctions(read("20261021020656_concurrent_telemetry_lifecycle_admission"))
  .find(entry => entry.name === "private.lock_case_graph_row_keys").source;
const installed = readMigrationFunctions("supabase/migrations");
const current = installed.find(entry => entry.name === "private.lock_case_graph_row_keys").source;
const lockCaseGraph = installed.find(entry => entry.name === "private.lock_case_graph").source;
const gate = table => {
  const statement = read(COMPASS).match(new RegExp(`create trigger z99_case_graph_keys before insert or update or delete on ${table.replace(".", "\\.")}\\nfor each row execute function private\\.lock_case_graph_row_keys\\('[^']*', '[^']*'\\);`));
  if (!statement) throw new Error(`no row-key gate for ${table} in ${COMPASS}`);
  return statement[0];
};
// Each relation, the identity column its gate names, and a one-row insert.
const ORG = "00000000-0000-4000-8000-000006058000";
const ROW = "00000000-0000-4000-8000-000006058001";
const U1 = "00000000-0000-4000-8000-000006058002";
const U2 = "00000000-0000-4000-8000-000006058003";
const RELATIONS = {
  "private.compass_training_organization_consents": { column: "enabled_by", key: "organization_id",
    insert: user => ["insert into private.compass_training_organization_consents(organization_id, enabled_by) values($1, $2)", [ORG, user]] },
  "private.compass_training_member_consents": { column: "user_id", key: "organization_id",
    insert: user => ["insert into private.compass_training_member_consents(organization_id, user_id) values($1, $2)", [ORG, user]] },
  "private.compass_training_samples": { column: "user_id", key: "id",
    insert: user => ["insert into private.compass_training_samples(id, organization_id, user_id) values($1, $2, $3)", [ROW, ORG, user]] },
};
const gates = Object.keys(RELATIONS).map(gate);

describe.skipIf(!postgresBin)("Compass training row-key gates take identity locks in isolated PostgreSQL", () => {
  let db;
  const sql = (text, values) => db.client.query(text, values);
  // pg_locks splits a bigint advisory key into classid (high) and objid (low).
  const held = async ids => (await sql(`select id::text from pg_catalog.unnest($1::uuid[]) id
    where exists(select 1 from pg_catalog.pg_locks l where l.pid = pg_catalog.pg_backend_pid()
      and l.locktype = 'advisory' and l.granted and l.objsubid = 1
      and ((l.classid::bigint << 32) | l.objid::bigint)
        = pg_catalog.hashtextextended('case-graph-auth:' || id::text, 509)) order by 1`, [ids])).rows.map(row => row.id);
  const commonHeld = async () => (await sql(`select count(*)::int n from pg_catalog.pg_locks
    where pid = pg_catalog.pg_backend_pid() and locktype = 'advisory' and granted
      and classid = 509 and objid = 700 and objsubid = 2 and mode = 'ExclusiveLock'`)).rows[0].n === 1;
  const probe = async statement => {
    await sql("begin");
    try {
      await sql(...statement);
      return { common: await commonHeld(), users: await held([U1, U2]) };
    } finally { await sql("rollback"); }
  };
  const installHelper = source => sql(`create or replace function private.lock_case_graph_row_keys() returns trigger
    language plpgsql security definer set search_path = '' as $function$${source}$function$`);

  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    // Only the relations and the lifecycle admission hooks are stubbed; the
    // graph lock is the body the migrations install last.
    await sql(`
      create schema private; create schema auth;
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      create function auth.role() returns text language sql stable as $$select 'service_role'::text$$;
      create function private.lock_message_lifecycle() returns void language plpgsql as 'begin end';
      create function private.lifecycle_read_admitted() returns boolean language sql as 'select false';
      create function private.lifecycle_telemetry_admitted() returns boolean language sql as 'select false';
      create function private.lock_case_graph(p_auth_ids uuid[], p_case_ids uuid[]) returns void
        language plpgsql security definer set search_path = '' as $function$${lockCaseGraph}$function$;
      create table private.compass_training_organization_consents(organization_id uuid primary key, enabled_by uuid);
      create table private.compass_training_member_consents(organization_id uuid not null, user_id uuid not null,
        primary key(organization_id, user_id));
      create table private.compass_training_samples(id uuid primary key, organization_id uuid not null, user_id uuid not null);
    `);
    await installHelper(predecessor);
    for (const statement of gates) await sql(statement);
  }, 120000);
  afterAll(async () => { await db?.close(); });

  it("replays the three Compass gates in their braced migration form", () => {
    expect(gates.map(statement => statement.match(/row_keys\(('[^)]*)\)/)[1])).toEqual(["'{enabled_by}', ''", "'{user_id}', ''", "'{user_id}', ''"]);
  });

  it("over the predecessor helper they hold the graph lock but no identity lock (negative control)", async () => {
    for (const [table, relation] of Object.entries(RELATIONS)) {
      expect(await probe(relation.insert(U1)), table).toEqual({ common: true, users: [] });
    }
  });

  it("over the installed helper each gate locks OLD and NEW identities on insert, update and delete", async () => {
    expect(current).not.toBe(predecessor);
    await installHelper(current);
    for (const [table, { column, key, insert }] of Object.entries(RELATIONS)) {
      const id = key === "id" ? ROW : ORG;
      expect(await probe(insert(U1)), `${table} insert`).toEqual({ common: true, users: [U1] });
      await sql(...insert(U1));
      try {
        expect(await probe([`update ${table} set ${column} = $1 where ${key} = $2`, [U2, id]]), `${table} update`)
          .toEqual({ common: true, users: [U1, U2] });
        expect(await probe([`delete from ${table} where ${key} = $1`, [id]]), `${table} delete`)
          .toEqual({ common: true, users: [U1] });
      } finally { await sql(`delete from ${table} where ${key} = $1`, [id]); }
    }
  });
});
