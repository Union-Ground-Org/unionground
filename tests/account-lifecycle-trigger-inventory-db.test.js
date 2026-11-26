// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";

// The historical reference query's own statement budget (see surface()).
const REFERENCE_MS = runnerTimeout(180_000);

const original = readFileSync(new URL("../supabase/migrations/20260907150000_account_lifecycle_manifest.sql", import.meta.url), "utf8")
  .split("create function private.account_lifecycle_trigger_surface()")[1].split("$function$")[1];
// The reviewed predecessor (cached lexical identifiers, 20260929034500) and the current
// candidate, which walks those references as a materialized edge list (#8458).
const predecessor = readFileSync(new URL("../supabase/migrations/20260929034500_account_lifecycle_trigger_inventory_tokens.sql", import.meta.url), "utf8")
  .split("as $function$")[1].split("$function$")[0];
const migration = readFileSync(new URL("../supabase/migrations/20261112231000_account_lifecycle_trigger_surface_edge_plan.sql", import.meta.url), "utf8");
const candidate = migration.split("as $function$")[1].split("$function$")[0];
const transactionBody = migration.replace(/^begin;$/m, "").replace(/^commit;$/m, "");
const signature = "returns table(kind text, schema_name text, table_name text, object_name text, definition_hash text) language sql stable security definer set search_path = ''";
const md5 = (value) => createHash("md5").update(value).digest("hex");

it("pins the reviewed predecessor and the deployed function contract", () => {
  expect(migration).toContain(`is distinct from '${md5(predecessor)}'`);
  const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
  expect(contract.functions.find((row) => row.sig === "private.account_lifecycle_trigger_surface()"))
    .toEqual({ sig: "private.account_lifecycle_trigger_surface()", secdef: true, exec: "", sourceMd5: md5(candidate) });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
// Every connection a case opens carries this name, and the case's teardown
// ends all of them through a separate connection: a
// Vitest time-out does not cancel an in-flight pg query, so a timed-out case's
// inventory scan or open transaction must not reach the next case.
const APPLICATION = "lifecycle-inventory-proof";
async function endCaseConnections(caseClient) {
  const cleanup = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: `${APPLICATION}-cleanup` });
  await cleanup.connect();
  try {
    await cleanup.query("select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()", [APPLICATION]);
    for (const deadline = Date.now() + runnerTimeout(5_000); ;) {
      const { rows: [{ n }] } = await cleanup.query("select count(*)::integer as n from pg_stat_activity where application_name = $1", [APPLICATION]);
      if (n === 0) break;
      if (Date.now() >= deadline) throw new Error("A case connection outlived its teardown");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await cleanup.end();
  }
  await caseClient?.end().catch(() => {});
}

live("account lifecycle inventory on a disposable database", () => {
  // One connection per case, with the production 60s budget and the original
  // reference function on it; the teardown ends it, which also rolls back the
  // case's transaction.
  beforeEach(async (context) => {
    const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: APPLICATION });
    // A terminated backend reaches an idle client as an 'error' event.
    client.on("error", () => {});
    await client.connect();
    context.db = client;
    await client.query("set statement_timeout = '60s'");
    // pg_temp is excluded from both inventories, so this reference cannot
    // change their application-function graph. Execute the original bytes.
    await client.query(`create function pg_temp.original_trigger_surface() ${signature} as $original$${original}$original$`);
    await client.query("begin");
  });
  afterEach(async (context) => { await endCaseConnections(context.db); });

  async function surface(client, name) {
    const historicalReference = name === "pg_temp.original_trigger_surface";
    // The pre-optimization reference evaluates a regex for every function
    // pair. Keep its original bytes and full-catalog comparison, with a
    // bounded reference-only budget sized to the runner (scripts/lib/
    // runner-timeout.mjs): 180 s ran out on GitHub's ubuntu-24.04 runner (PR
    // run 43153907635, proof shard 1). The savepoint restores the production
    // 60s budget even when the reference query fails.
    if (historicalReference) {
      await client.query("savepoint original_inventory_budget");
      await client.query(`set local statement_timeout = '${REFERENCE_MS}ms'`);
    }
    try {
      return (await client.query(`select * from ${name}() order by kind,schema_name,table_name,object_name,definition_hash`)).rows;
    } finally {
      if (historicalReference) {
        await client.query("rollback to savepoint original_inventory_budget; release savepoint original_inventory_budget");
      }
    }
  }
  async function restorePredecessor(client) {
    await client.query(`create or replace function private.account_lifecycle_trigger_surface() ${signature} as $predecessor$${predecessor}$predecessor$`);
  }

  it("matches every original catalog row and leaves no review mismatches", async ({ db: client }) => {
    expect(await surface(client, "private.account_lifecycle_trigger_surface"))
      .toEqual(await surface(client, "pg_temp.original_trigger_surface"));
    expect((await client.query("show statement_timeout")).rows[0].statement_timeout).toBe("1min");
    expect((await client.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
  }, runnerTimeout(270_000));

  // #8458: once pg_proc was analyzed, the predecessor's recursive step hashed
  // the whole function-by-function join (0.6 s before ANALYZE, 4 to 16 s
  // after on a local stack, over 60 s on a 2-vCPU runner); the edge list takes
  // 0.3 s either way. The ANALYZE is undone with the case's transaction.
  it("keeps the same rows and a fast plan after pg_proc is analyzed", async ({ db: client }) => {
    const before = await surface(client, "private.account_lifecycle_trigger_surface");
    await client.query("analyze pg_catalog.pg_proc");
    await client.query("savepoint analyzed_budget");
    await client.query(`set local statement_timeout = '${runnerTimeout(2_000)}ms'`);
    const started = Date.now();
    const after = await surface(client, "private.account_lifecycle_trigger_surface");
    const elapsed = Date.now() - started;
    await client.query("rollback to savepoint analyzed_budget; release savepoint analyzed_budget");
    expect(after).toEqual(before);
    expect(elapsed).toBeLessThan(runnerTimeout(2_000));
  }, runnerTimeout(120_000));

  it("preserves indirect, cyclic, overloaded, lexical, unusual-name and rule reachability", async ({ db: client }) => {
    await client.query(`
      create table public.ti_inventory_fixture (id integer);
      create function private.ti_leaf() returns integer language sql as 'select 1';
      create function private.ti_leaf(integer) returns integer language sql as 'select 1';
      create function private.ti_parent() returns integer language sql as 'select private.ti_leaf()';
      create function private.ti_cycle_a() returns integer language plpgsql as 'begin return private.ti_cycle_b(); end';
      create function private.ti_cycle_b() returns integer language plpgsql as 'begin return private.ti_cycle_a(); end';
      create function private.ti_comment() returns integer language sql as 'select 1';
      create function private.ti_literal() returns integer language sql as 'select 1';
      create function private."TiMixed"() returns integer language sql as 'select 1';
      create function private."ti.dot"() returns integer language sql as 'select 1';
      create function private."ti-hyphen"() returns integer language sql as 'select 1';
      create function private."ti_éclair"() returns integer language sql as 'select 1';
      create extension hstore with schema private;
      create schema ti_outside;
      create function ti_outside.ti_outside_only() returns integer language sql as 'select 1';
      create function private.ti_unreachable() returns integer language sql as 'select 1';
      create function private.ti_boundary_only() returns integer language sql as 'select 1';
      create function private.ti_rule_only() returns integer language sql as 'select 1';
      create function private.ti_root() returns trigger language plpgsql as $root$
      begin
        -- ti_parent ti_cycle_a ti_comment TiMixed tiXdot ti-hyphen ti_éclair
        -- prefix_ti_boundary_only_suffix hstore_recv ti_outside_only
        perform 'ti_literal';
        return new;
      end;
      $root$;
      create trigger ti_root before insert on public.ti_inventory_fixture for each row execute function private.ti_root();
      create rule ti_rule as on delete to public.ti_inventory_fixture do also select private.ti_rule_only();
    `);
    const observed = await surface(client, "private.account_lifecycle_trigger_surface");
    expect(observed).toEqual(await surface(client, "pg_temp.original_trigger_surface"));
    const names = observed.filter((row) => row.kind === "function").map((row) => row.object_name);
    for (const name of ["ti_leaf()", "ti_leaf(integer)", "ti_parent()", "ti_cycle_a()", "ti_cycle_b()", "ti_comment()", "ti_literal()", "TiMixed()", "ti.dot()", "ti-hyphen()", "ti_éclair()", "ti_rule_only()"])
      expect(names, name).toContain(name);
    expect(names).not.toContain("ti_unreachable()");
    expect(names).not.toContain("ti_boundary_only()");
    expect((await client.query("select count(*)::integer n from pg_proc p join pg_depend d on d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e' where p.pronamespace='private'::regnamespace and p.proname='hstore_recv'")).rows[0].n).toBeGreaterThan(0);
    expect(names.some((name) => name.startsWith("hstore_recv("))).toBe(false);
    expect(names).not.toContain("ti_outside_only()");
    expect(observed.some((row) => row.kind === "rule" && row.object_name === "ti_rule")).toBe(true);
  }, runnerTimeout(270_000));

  it("preserves security settings and denies all application roles", async ({ db: client }) => {
    const { rows: [settings] } = await client.query("select prosecdef,provolatile,proconfig,md5(prosrc) hash from pg_proc where oid='private.account_lifecycle_trigger_surface()'::regprocedure");
    expect(settings).toEqual({ prosecdef: true, provolatile: "s", proconfig: ['search_path=""'], hash: md5(candidate) });
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect((await client.query("select has_function_privilege($1,'private.account_lifecycle_trigger_surface()','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
      await client.query("savepoint denied");
      await client.query(`set local role ${role}`);
      await expect(client.query("select * from private.account_lifecycle_trigger_surface()"))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint denied");
    }
  });

  it("refuses an unexpected predecessor before replacing it", async ({ db: client }) => {
    await client.query(`create or replace function private.account_lifecycle_trigger_surface() ${signature} as $changed$${original}\n-- unexpected drift\n$changed$`);
    await client.query("savepoint apply");
    await expect(client.query(transactionBody)).rejects.toThrow("inventory predecessor changed");
    await client.query("rollback to savepoint apply");
    expect((await client.query("select md5(prosrc) hash from pg_proc where oid='private.account_lifecycle_trigger_surface()'::regprocedure")).rows[0].hash).not.toBe(md5(candidate));
  });

  it("refuses a stale review digest without relaxing the timeout", async ({ db: client }) => {
    await restorePredecessor(client);
    await client.query("update private.account_lifecycle_trigger_review set definition_hash=repeat('0',32) where (kind,schema_name,table_name,object_name)=(select kind,schema_name,table_name,object_name from private.account_lifecycle_trigger_review limit 1)");
    await client.query("savepoint apply");
    await expect(client.query(transactionBody)).rejects.toThrow("inventory differs from review");
    await client.query("rollback to savepoint apply");
    expect((await client.query("select md5(prosrc) hash from pg_proc where oid='private.account_lifecycle_trigger_surface()'::regprocedure")).rows[0].hash).toBe(md5(predecessor));
  }, runnerTimeout(90_000));

  it("applies only from the exact predecessor with the full inventory assertion", async ({ db: client }) => {
    await restorePredecessor(client);
    await client.query(transactionBody);
    expect((await client.query("show statement_timeout")).rows[0].statement_timeout).toBe("1min");
    expect((await client.query("show lock_timeout")).rows[0].lock_timeout).toBe("5s");
    expect((await client.query("select md5(prosrc) hash from pg_proc where oid='private.account_lifecycle_trigger_surface()'::regprocedure")).rows[0].hash).toBe(md5(candidate));
  }, runnerTimeout(90_000));
});
