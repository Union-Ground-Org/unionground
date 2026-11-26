// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { offlinePostgres } from "./tamarack-postgres-helper.mjs";

// Exercise the migration's predecessor lookup/control flow on ten catalog
// fixtures. Substitute only expected body digests; keep signatures and lookup
// control flow verbatim.
const filename = "20261018022908_concurrent_lifecycle_read_admission.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${filename}`, import.meta.url), "utf8");
const sourceGuard = migration.match(/do \$predecessors\$[\s\S]*?\$predecessors\$;/)?.[0];
if (!sourceGuard) throw new Error("Lifecycle predecessor guard is missing");
const expected = [...sourceGuard.matchAll(/\('([^']+)', '([a-f0-9]{32})'\)/g)]
  .map(([, signature, digest]) => ({ signature, digest }));
const fixtureBody = "begin null; end";
const fixtureDigest = createHash("md5").update(fixtureBody).digest("hex");
const guard = expected.reduce((sql, { digest }) => sql.replaceAll(`'${digest}'`, `'${fixtureDigest}'`), sourceGuard);

describe("hosted migration name resolution with an empty search_path", () => {
  let database;
  let client;
  beforeAll(async () => {
    database = await offlinePostgres();
    client = database.client;
    await client.query("create schema private; set statement_timeout = '5s'");
  }, 120_000);
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await client.query("rollback; begin; set local search_path = ''");
    for (const { signature } of expected) {
      await client.query(`create function ${signature} returns void language plpgsql as $fixture$${fixtureBody}$fixture$`);
    }
  });

  it("accepts every matching predecessor without relying on public in the path", async () => {
    expect(expected).toHaveLength(10);
    expect((await client.query("show search_path")).rows[0].search_path).toBe('""');
    await client.query(guard);
    for (const { signature } of expected) {
      const result = await client.query("select pg_catalog.md5(prosrc) as digest from pg_catalog.pg_proc where oid = pg_catalog.to_regprocedure($1)", [signature]);
      expect(result.rows).toEqual([{ digest: fixtureDigest }]);
    }
  });

  it.each(expected.map(({ signature }) => signature))("fails closed when %s is absent", async (signature) => {
    await client.query(`drop function ${signature}`);
    await client.query("savepoint refused");
    await expect(client.query(guard)).rejects.toMatchObject({
      code: "P0001", message: `lifecycle read admission predecessor changed: ${signature}`,
    });
    await client.query("rollback to savepoint refused");
    expect((await client.query("select pg_catalog.to_regprocedure($1) as missing", [signature])).rows[0].missing).toBeNull();
  });

  it.each(expected.map(({ signature }) => signature))("fails closed when %s has drifted", async (signature) => {
    await client.query(`create or replace function ${signature} returns void language plpgsql as $fixture$begin null; null; end$fixture$`);
    await client.query("savepoint refused");
    await expect(client.query(guard)).rejects.toMatchObject({
      code: "P0001", message: `lifecycle read admission predecessor changed: ${signature}`,
    });
    await client.query("rollback to savepoint refused");
  });

  it("resolves qualified functions and overloads, and refuses an unqualified predecessor", async () => {
    await client.query("create function public.get_member_message_actions(text) returns void language plpgsql as $$begin null; end$$");
    const result = await client.query(`select
      pg_catalog.to_regprocedure('public.get_member_message_actions(text,uuid)')::oid as original,
      pg_catalog.to_regprocedure('public.get_member_message_actions(text)')::oid as overload,
      pg_catalog.to_regprocedure('get_member_message_actions(text,uuid)') as unqualified`);
    expect(result.rows[0].original).not.toBe(result.rows[0].overload);
    expect(result.rows[0].unqualified).toBeNull();
    // Mutation check: a guard accidentally stripped of its schema must refuse,
    // not silently skip the missing function through NULL comparison semantics.
    const unqualifiedGuard = guard.replace("'public.get_member_message_actions(text,uuid)'", "'get_member_message_actions(text,uuid)'");
    await expect(client.query(unqualifiedGuard)).rejects.toMatchObject({
      code: "P0001", message: "lifecycle read admission predecessor changed: get_member_message_actions(text,uuid)",
    });
  });

  it("resolves qualified regclass names and fails closed for unqualified or missing relations", async () => {
    await client.query("create table public.hosted_path_fixture (id integer)");
    const result = await client.query(`select
      'public.hosted_path_fixture'::pg_catalog.regclass::oid as direct,
      pg_catalog.to_regclass('public.hosted_path_fixture')::oid as lookup,
      pg_catalog.to_regclass('hosted_path_fixture') as unqualified,
      pg_catalog.to_regclass('public.absent_hosted_path_fixture') as missing,
      'pg_catalog.pg_proc'::pg_catalog.regclass::oid as catalog`);
    expect(result.rows[0]).toMatchObject({ unqualified: null, missing: null });
    expect(result.rows[0].direct).toBe(result.rows[0].lookup);
    expect(result.rows[0].catalog).toBeGreaterThan(0);
    for (const name of ["hosted_path_fixture", "public.absent_hosted_path_fixture"]) {
      await client.query("savepoint refused");
      await expect(client.query("select $1::pg_catalog.regclass", [name])).rejects.toMatchObject({ code: "42P01" });
      await client.query("rollback to savepoint refused");
    }
  });
});
