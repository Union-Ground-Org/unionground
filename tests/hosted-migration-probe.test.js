// @vitest-environment node
// Synthetic SQL only: no historical git blobs (CI uses a blob:none clone).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeHostedMigration } from "../scripts/lib/hosted-migration-probe.mjs";
import { grantProbeStep } from "../scripts/grant-probe-step.mjs";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";

const pinnedMd5 = "17d3a68a42a1fede74bbf07ae490a369";
const FILE = "20990101000000_hosted_probe.sql";
const fixture = `begin;
do $guard$ begin
  if md5(pg_get_functiondef('public.hosted_probe_predecessor()'::regprocedure)) <> '${pinnedMd5}' then
    raise exception using errcode='55000', message='unreviewed predecessor: public.hosted_probe_predecessor';
  end if;
end $guard$;
create table public.hosted_probe_applied (id int);
commit;
`;

describe.runIf(postgresBin)("hosted migration rehearsal", () => {
  let db;
  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    await db.client.query(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);
      create role hosted_probe_restricted;
      create role hosted_probe_history_writer;
      create schema private;
      create table private.account_lifecycle_trigger_review (kind text, schema_name text, table_name text, object_name text, definition_hash text);
      create table private.notification_controls (id boolean, files_reconcile_url text, dispatch_url text);
      create schema cron;
      create table cron.job (jobid bigint, jobname text, schedule text, command text, username text, active boolean, database text);
      create schema vault;
      create table vault.secrets (name text);
      grant usage on schema supabase_migrations, private, cron, vault to hosted_probe_history_writer;
      grant select, insert on supabase_migrations.schema_migrations to hosted_probe_history_writer;
      grant select on private.account_lifecycle_trigger_review, cron.job, vault.secrets to hosted_probe_history_writer;
      grant execute on function pg_catalog.pg_control_system() to hosted_probe_history_writer;
      create type public.hosted_probe_row as (id int);
      create function public.hosted_probe_predecessor() returns hosted_probe_row
        language sql as $$select null::public.hosted_probe_row$$;`);
  });
  afterAll(async () => { await db?.close(); });

  it("catches the pinned composite-return digest that the CLI's default path accepts", async () => {
    await db.client.query("begin");
    try {
      await db.client.query(fixture.replace(/^begin;/, "").replace(/commit;\n$/, ""));
      expect((await db.client.query("select to_regclass('public.hosted_probe_applied') is not null as applied")).rows[0].applied).toBe(true);
    } finally { await db.client.query("rollback"); }
    await expect(probeHostedMigration(db.client, fixture, FILE)).rejects.toMatchObject({
      code: "55000", message: "unreviewed predecessor: public.hosted_probe_predecessor",
    });
    expect((await db.client.query("select to_regclass('public.hosted_probe_applied') as applied")).rows[0].applied).toBeNull();
  });

  it("accepts a canonical migration path and rolls every change back", async () => {
    const fixed = fixture.replace("begin;", "begin;\nset local search_path = pg_catalog, public;");
    expect(await probeHostedMigration(db.client, fixed, FILE)).toBeGreaterThanOrEqual(0);
    expect((await db.client.query("select to_regclass('public.hosted_probe_applied') as applied")).rows[0].applied).toBeNull();
    expect((await db.client.query("show search_path")).rows[0].search_path).toBe('"$user", public');
  });

  it("also catches unqualified composite types independently of the digest guard", async () => {
    await expect(probeHostedMigration(db.client, `begin;
create function public.hosted_probe_unqualified() returns hosted_probe_row language sql as $$select null$$;
commit;\n`, FILE)).rejects.toMatchObject({ code: "42704" });
    expect((await db.client.query("select to_regprocedure('public.hosted_probe_unqualified()') as fn")).rows[0].fn).toBeNull();
  });

  it("uses the hosted isolation, empty path and timeouts, keeping literals intact", async () => {
    await probeHostedMigration(db.client, `BEGIN;
DO $body$ BEGIN
  IF current_schemas(false) <> '{}'::name[] OR current_setting('transaction_isolation') <> 'read committed'
    OR current_setting('lock_timeout')::interval <> interval '5 seconds' OR current_setting('statement_timeout')::interval <> interval '60 seconds' THEN
    RAISE EXCEPTION 'wrapper mismatch';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
    AND relation='supabase_migrations.schema_migrations'::regclass AND mode='ShareRowExclusiveLock' AND granted) THEN
    RAISE EXCEPTION 'history lock missing';
  END IF;
  PERFORM 'commit;';
END $body$;
COMMIT;\n`, FILE);
  });

  it("rolls back partial writes on a SQL error and leaves the connection usable", async () => {
    await expect(probeHostedMigration(db.client, "begin;\ncreate table public.hosted_probe_applied(id int); select 1/0;\ncommit;\n", FILE))
      .rejects.toMatchObject({ code: "22012" });
    expect((await db.client.query("select to_regclass('public.hosted_probe_applied') as applied")).rows[0].applied).toBeNull();
  });

  it("appends the exact source, resets session settings and reads history before rolling back", async () => {
    const source = "begin;\nset local search_path=public; set local statement_timeout='1s'; select 1;\ncommit;\n";
    let readBack = false;
    const client = { query: async (...args) => {
      const result = await db.client.query(...args);
      if (args[0].startsWith("select version,name,statements")) {
        readBack = true;
        expect(result.rows).toEqual([{ version: "20990101000000", name: "hosted_probe", statements: [source] }]);
        const { rows: [settings] } = await db.client.query("select current_schemas(false)::text[] as path, current_setting('statement_timeout') as timeout");
        expect(settings).toEqual({ path: [], timeout: "1min" });
      }
      return result;
    } };
    await probeHostedMigration(client, source, FILE);
    expect(readBack).toBe(true);
    expect((await db.client.query("select count(*)::int as n from supabase_migrations.schema_migrations")).rows[0].n).toBe(0);
  });

  it("rejects altered history source bytes and rolls back (ledger 389 item 1)", async () => {
    const client = { query: async (...args) => {
      const result = await db.client.query(...args);
      if (args[0].startsWith("select version,name,statements")) result.rows[0].statements = ["altered source"];
      return result;
    } };
    await expect(probeHostedMigration(client, "begin;\nselect 1;\ncommit;\n", FILE))
      .rejects.toThrow("hosted migration history read-back mismatch");
    expect((await db.client.query("select count(*)::int as n from supabase_migrations.schema_migrations")).rows[0].n).toBe(0);
  });

  it("reads the hosted lifecycle/state CTE and hashes before, after and after rollback (ledger 389 item 3)", async () => {
    const observed = [];
    const client = { query: async (...args) => {
      const result = await db.client.query(...args);
      if (args[0].startsWith("with inlined_surface")) observed.push(result.rows[0]);
      return result;
    } };
    await probeHostedMigration(client, "begin;\ncreate table public.hosted_probe_applied(id int);\ncommit;\n", FILE);
    expect(observed).toHaveLength(3);
    expect(observed[0].state.history_count).toBe(0);
    expect(observed[1].state.history_count).toBe(1);
    expect(observed[1].state.relations.some(row => row.n === "public.hosted_probe_applied")).toBe(true);
    expect(observed[1].state_sha256).not.toBe(observed[0].state_sha256);
    expect(observed[2]).toEqual(observed[0]);
  });

  it("rejects a role that can append/read history but cannot read post-body state", async () => {
    let readHistory = false;
    const client = { query: async (...args) => {
      const result = await db.client.query(...args);
      if (args[0].startsWith("select version,name,statements")) readHistory = true;
      return result;
    } };
    await expect(probeHostedMigration(client, "begin;\nset local role hosted_probe_history_writer;\ncommit;\n", FILE))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for table notification_controls" });
    expect(readHistory).toBe(true);
    expect((await db.client.query("select current_user as role")).rows[0].role).toBe("postgres");
    expect((await db.client.query("select count(*)::int as n from supabase_migrations.schema_migrations")).rows[0].n).toBe(0);
  });

  it("rejects a missing state hash or changed rollback digest and leaves the connection usable", async () => {
    for (const fault of ["missing", "changed"]) {
      let reads = 0;
      const client = { query: async (...args) => {
        const result = await db.client.query(...args);
        if (args[0].startsWith("with inlined_surface") && ++reads === 3) result.rows[0].state_sha256 = fault === "missing" ? null : "0".repeat(64);
        return result;
      } };
      await expect(probeHostedMigration(client, "begin;\nselect 1;\ncommit;\n", FILE))
        .rejects.toThrow(fault === "missing" ? "hosted migration state hash missing" : "hosted migration rollback state mismatch");
      expect((await db.client.query("select 1 as ready")).rows[0].ready).toBe(1);
    }
  });

  it("rejects a body that leaves a role unable to perform the hosted history append", async () => {
    await expect(probeHostedMigration(db.client, "begin;\nset local role hosted_probe_restricted;\ncommit;\n", FILE))
      .rejects.toMatchObject({ code: "42501" });
    expect((await db.client.query("select current_user as role")).rows[0].role).toBe("postgres");
  });

  it("checks added-list membership and preserves the named failure prefix", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "hosted-probe-step-"));
    mkdirSync(join(workdir, "grant-probe-held-back"));
    const path = join(workdir, "grant-probe-held-back", FILE);
    writeFileSync(path, "begin;\nselect 1;\ncommit;\n");
    const client = { connect: vi.fn(async () => {}), end: vi.fn(async () => {}), query: vi.fn(db.client.query.bind(db.client)) };
    const mocked = vi.spyOn(pg, "Client").mockImplementation(function () { return client; });
    const env = { CI_DB_WORKDIR: workdir, SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55672/postgres", CI_DB_GRANT_PROBE_ADDED: "" };
    try {
      await expect(grantProbeStep("hosted", env, FILE)).rejects.toThrow("hosted probe requires one added migration filename");
      expect(client.query).not.toHaveBeenCalled();
      writeFileSync(path, fixture);
      await expect(grantProbeStep("hosted", { ...env, CI_DB_GRANT_PROBE_ADDED: FILE }, FILE)).rejects.toMatchObject({
        message: expect.stringMatching(/^Hosted migration probe \d{14}_/), cause: expect.objectContaining({ code: "55000" }),
      });
    } finally { mocked.mockRestore(); rmSync(workdir, { recursive: true, force: true }); }
  });
});

it("refuses transaction escape before issuing any query", async () => {
  const client = { query: () => { throw new Error("must not connect"); } };
  await expect(probeHostedMigration(client, "begin;\nselect 1; commit; select 2;\ncommit;\n", FILE))
    .rejects.toThrow(/hosted migration source:/);
});

it("refuses the hosted history delimiter even when it appears inside a SQL literal", async () => {
  const client = { query: () => { throw new Error("must not connect"); } };
  await expect(probeHostedMigration(client, "begin;\nselect '$src_late2d$';\ncommit;\n", FILE)).rejects.toThrow(/reserved \$src_late2d\$ delimiter/);
});

it.each([undefined, "", "../20990101000000_escape.sql", "20990101000000.sql", "hosted_probe.sql", "20990101000000_upperCase.sql"])("refuses an absent or invalid filename before any query (ledger 389 item 2): %s", async file => {
  const client = { query: vi.fn(() => { throw new Error("must not query"); }) };
  await expect(probeHostedMigration(client, "begin;\nselect 1;\ncommit;\n", file)).rejects.toThrow("hosted migration requires its filename");
  expect(client.query).not.toHaveBeenCalled();
});
