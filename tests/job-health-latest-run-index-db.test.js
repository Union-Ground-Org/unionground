// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { latestFnBody, loadMigrationSql, migrationFiles, migrationNames, stripComments } from "./helpers/migration.js";

// BUG-UG-ADMIN-JOB-HEALTH-READ-EXCEEDS-STATEMENT-TIMEOUT-20261115 (#8916).
//
// public.list_organization_job_health() finds each monitored job's latest run
// with a LATERAL ordered by started_at desc, limit 1. Before this repair no
// index ordered a job's runs by started_at, so each of the 40 lookups read and
// sorted that job's whole history; on Production's 552k rows the read ran past
// the authenticated role's 8 s statement_timeout and the admin page failed.
// The offline half pins the index, its contract entry and the function shape it
// serves. The live half (disposable loopback only) loads a few thousand runs per
// job inside a rolled-back transaction and requires the planner to descend the
// new index for every job, touching a bounded number of buffers. On Main's
// catalogue the same plan sorts each job's history and fails both checks;
// neither check reads a clock.
const REPAIR = "20261113134300_job_health_latest_run_index";
const INDEX = "organization_job_runs_job_latest_idx";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const repair = stripComments(loadMigrationSql(REPAIR)).toLowerCase().replace(/\s+/g, " ").trim();

describe("job health latest-run index (static)", () => {
  it("adds only the (job_name, started_at desc) index, in one bounded transaction", () => {
    expect(repair).toBe(
      "begin; set local lock_timeout = '1s'; set local statement_timeout = '60s'; " +
        `create index if not exists ${INDEX} on public.organization_job_runs (job_name, started_at desc); commit;`,
    );
    const raw = loadMigrationSql(REPAIR);
    expect(raw).toContain("LIVE APPLY");
    expect(raw).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX}`);
    expect(raw).toContain("CONCURRENTLY cannot run inside a transaction block");
  });

  it("sorts after the migration that last defined the function", () => {
    const names = migrationNames();
    expect(names.indexOf(`${REPAIR}.sql`)).toBeGreaterThan(names.indexOf("20261109225800_stagger_cron_starts_and_dispatch_minutes.sql"));
  });

  it("keeps the live function in the LATERAL shape the index serves", () => {
    const body = latestFnBody("public.list_organization_job_health").replace(/\s+/g, " ");
    expect(body).toContain(
      "left join lateral ( select * from public.organization_job_runs run where run.job_name = catalog.job_name " +
        "and (run.organization_id is null or run.organization_id = org) order by run.started_at desc limit 1 ) r on true",
    );
    expect(body).toMatch(/security definer set search_path = ''/i);
  });

  it("is never dropped by a later migration", () => {
    const later = migrationFiles().filter((file) => file.name > `${REPAIR}.sql`);
    for (const file of later) expect(stripComments(file.sql)).not.toMatch(new RegExp(`drop\\s+index[^;]*${INDEX}`, "i"));
  });

  it("is pinned in the database contract so verify:db reads it from the catalogue", () => {
    const entry = contract.indexes.find((row) => row.name === INDEX);
    expect(entry?.table).toBe("organization_job_runs");
    expect(entry?.defContains).toEqual(["USING btree (job_name, started_at DESC)"]);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("job health finds each job's latest run by an index descent", () => {
  const PER_JOB = 2000;
  let client;
  let org;
  let query;
  let jobs;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "job-health-latest-run-index-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");
    const { rows: present } = await client.query("select pg_catalog.to_regclass($1) is not null as ok", [`public.${INDEX}`]);
    expect(present[0].ok).toBe(true);
    org = randomUUID();
    // The function body as installed; its organization variable becomes $1.
    const { rows } = await client.query("select prosrc from pg_catalog.pg_proc where oid = 'public.list_organization_job_health()'::regprocedure");
    const source = rows[0].prosrc;
    query = source.slice(source.indexOf("select pg_catalog.jsonb_agg"), source.lastIndexOf("), '[]'::jsonb)")).replace(/\borg\b/g, "$1::uuid");
    jobs = [...source.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)].map((match) => match[1]);
    expect(jobs.length).toBeGreaterThanOrEqual(40);
    // A long platform history per job, written in time order so each job's
    // runs are spread across the heap, newest last. Rolled back afterwards.
    await client.query(
      `insert into public.organization_job_runs (organization_id, job_name, run_id, status, started_at, finished_at)
       select null, job, 'index-proof:' || ordinal, 'completed',
              now() - ((${PER_JOB} - ordinal / $2::int) * interval '1 minute'),
              now() - ((${PER_JOB} - ordinal / $2::int) * interval '1 minute') + interval '1 second'
       from generate_series(0, ${PER_JOB} * $2::int - 1) as ordinal,
            lateral (select ($1::text[])[ordinal % $2::int + 1] as job) picked`,
      [jobs, jobs.length],
    );
    await client.query("analyze public.organization_job_runs");
  }, 180000);

  afterAll(async () => {
    try {
      await client?.query("rollback").catch(() => {});
      await client?.query("analyze public.organization_job_runs").catch(() => {});
    } finally {
      await client?.end();
    }
  });

  it("plans every lookup on the new index and never sorts a job's history", async () => {
    const { rows } = await client.query(`explain (costs off) ${query}`, [org]);
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan).toContain(`Index Scan using ${INDEX} on organization_job_runs run`);
    expect(plan).toMatch(/Index Cond: \(job_name = /);
    expect(plan).not.toMatch(/Sort Key: run\.started_at DESC/);
  });

  it("touches a bounded number of buffers however long each job's history is", async () => {
    const { rows } = await client.query(`explain (analyze, buffers, timing off, format json) ${query}`, [org]);
    const root = rows[0]["QUERY PLAN"][0].Plan;
    const touched = root["Shared Hit Blocks"] + root["Shared Read Blocks"];
    // About five pages per job (index descent, one heap row, the acknowledgement
    // probe). Main's plan reads every one of the jobs x 2,000 runs here.
    expect(touched).toBeLessThan(jobs.length * 20);
  });
});
