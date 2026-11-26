// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stripOuterTransaction } from "../scripts/hosted-migration-apply-runner.mjs";
import { loadMigrationSql } from "./helpers/migration.js";
import { offlinePostgres } from "./tamarack-postgres-helper.mjs";

// Exercise the actual migration and hosted wrapper on an isolated catalog.
// Replace only the expected hashes with the fixture predecessors' hashes;
// signatures, guard control flow, declarations and replacement bodies stay real.
describe("handoff migration under the hosted runner's empty search_path", () => {
  let database, client, sql, before;
  const signatures = ["private.mi1_w2_handoff_visible(uuid,public.member_handoffs)", "private.mi1_w2_resolve_handoff(uuid,text)"];
  const metadata = async () => (await client.query(`select p.oid, p.proowner, p.proacl, p.proconfig, p.prosecdef, p.provolatile, p.proleakproof
    from pg_catalog.pg_proc p where p.oid = any($1::pg_catalog.regprocedure[]) order by p.oid`, [signatures])).rows;

  beforeAll(async () => {
    database = await offlinePostgres();
    client = database.client;
    await client.query("create schema auth; create schema private; set statement_timeout = '5s'");
  }, 120_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await client.query(`rollback; begin; set local search_path = pg_catalog, public;
      create table public.member_handoffs (organization_id uuid, initiated_by uuid, to_steward_id uuid, from_steward_id uuid);
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create function private.mi1_w2_handoff_can_oversee(uuid) returns boolean language sql as $$select false$$;
      create function private.mi1_w2_handoff_visible(p_org uuid, p_handoff public.member_handoffs) returns boolean
        language sql stable security definer set search_path = '' as $$select false$$;
      create function private.mi1_w2_resolve_handoff(p_handoff_id uuid, p_action text) returns jsonb
        language plpgsql security definer set search_path = '' as $$begin return '{}'::jsonb; end$$;`);
    sql = loadMigrationSql("handoff_refusal_equal_for_missing_and_invisible");
    const pinned = [...sql.matchAll(/is distinct from '([a-f0-9]{32})'/gu)].map(match => match[1]);
    expect(pinned).toHaveLength(2);
    for (const [index, signature] of signatures.entries()) {
      const { rows: [{ digest }] } = await client.query("select pg_catalog.md5(pg_catalog.pg_get_functiondef($1::pg_catalog.regprocedure)) digest", [signature]);
      sql = sql.replaceAll(pinned[index], digest);
    }
    before = await metadata();
    await client.query("set local search_path = ''");
  });

  it("applies after the hosted runner clears the path and preserves function identity, privileges and empty function paths", async () => {
    expect((await client.query("show search_path")).rows[0].search_path).toBe('""');
    await client.query(stripOuterTransaction(sql));
    expect(await metadata()).toEqual(before);
    expect(before.every(row => row.proconfig.includes('search_path=""'))).toBe(true);
    const { rows: [{ visible }] } = await client.query(`select private.mi1_w2_handoff_visible(
      '00000000-0000-0000-0000-000000000001'::uuid,
      row('00000000-0000-0000-0000-000000000001'::uuid,null,null,null)::public.member_handoffs) visible`);
    expect(visible).toBe(false);
  });

  it.each(signatures)("still refuses an unreviewed predecessor for %s", async signature => {
    const original = (await client.query("select pg_catalog.pg_get_functiondef($1::pg_catalog.regprocedure) definition", [signature])).rows[0].definition;
    await client.query(original.replace("select false", "select true").replace("return '{}'::jsonb", "return '{\"drift\":true}'::jsonb"));
    await expect(client.query(stripOuterTransaction(sql))).rejects.toMatchObject({ code: "55000", message: `unreviewed predecessor: ${signature.split("(")[0]}` });
  });
});
