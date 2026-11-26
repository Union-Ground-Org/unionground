// @vitest-environment node
//
// BUG-UG-NOTIFICATIONS-DISPATCH-TICK-DUPLICATE-REQUEST-ID-AFTER-RESTART-20260915
// After a Postgres restart pg_net's request-id sequence can resume below ids
// already stored in the three tick ledgers. A plain insert then unique-violates
// and rolls back the queued POST. The live half seeds those tables above the
// current sequence and runs each cron.job command; the static half pins the
// migration and db-contract needles so the suite still guards the SQL without a
// database URL.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const JOBS = [
  {
    jobname: "notifications-dispatch-tick",
    table: "private.notification_dispatch_ticks",
  },
  {
    jobname: "integration-webhooks-dispatch-tick",
    table: "private.integration_webhook_dispatch_ticks",
  },
  {
    jobname: "task-files-reconcile-tick",
    table: "private.task_file_reconcile_ticks",
  },
];

const PROOF_URL = "https://127.0.0.1:9/waveb4-pg-net-tick-proof";
const PROOF_SECRET = "waveb4-pg-net-tick-proof-secret-value";
const SEED_SPAN = 256n;

const sql = stripComments(loadMigrationSql("pg_net_tick_request_id_idempotency"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("pg_net tick request-id idempotency migration", () => {
  it("sorts after the native push enqueue repair it was written against and reschedules every pg_net tick insert", () => {
    expect(findMigrationName("pg_net_tick_request_id_idempotency") > "20260913031500_native_push_enqueue_repair.sql").toBe(true);
    for (const { jobname, table } of JOBS) {
      expect(sql).toContain(`'${jobname}'`);
      expect(sql).toContain(`insert into ${table} (request_id)`);
      expect(sql).toContain("on conflict (request_id) do update set created_at = excluded.created_at");
    }
    expect(sql).toContain("'*/5 * * * *'");
    expect(sql).toContain("'37 4 * * *'");
    expect(sql.split("on conflict (request_id) do update set created_at = excluded.created_at").length).toBe(4);
    expect(sql).toContain("create or replace function public.get_notification_dispatch_health()");
    expect(sql).toContain("r.created >= t.created_at");
  });

  it("pins the live cron commands so a later reschedule cannot drop ON CONFLICT", () => {
    for (const { jobname } of JOBS) {
      const tick = contract.cron.find((job) => job.jobname === jobname);
      expect(tick?.commandContains, jobname).toContain("on conflict (request_id) do update");
    }
    const health = contract.functions.find((entry) => entry.sig === "public.get_notification_dispatch_health()");
    expect(health?.bodyContains).toEqual(expect.arrayContaining([
      "left join net._http_response r",
      "r.id = t.request_id",
      "r.created >= t.created_at",
    ]));
    expect(health?.bodyMd5, "health RPC digest must be pinned from the live definition").toMatch(/^[0-9a-f]{32}$/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("pg_net tick inserts survive a request-id sequence reset", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "pg-net-tick-request-id-proof",
    });
    await client.connect();
    const extensions = await client.query(`
      select
        pg_catalog.to_regnamespace('cron') is not null as cron,
        pg_catalog.to_regnamespace('net') is not null as net
    `);
    if (!extensions.rows[0].cron || !extensions.rows[0].net) {
      throw new Error("the disposable stack must provide pg_cron and pg_net for this proof");
    }
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("runs each scheduled tick command against a ledger pre-seeded above pg_net's sequence", async () => {
    const scheduled = await client.query(
      "select jobname, command from cron.job where jobname = any($1::text[])",
      [JOBS.map((job) => job.jobname)],
    );
    expect(scheduled.rows.map((row) => row.jobname).sort()).toEqual(JOBS.map((job) => job.jobname).sort());
    for (const row of scheduled.rows) {
      expect(row.command.toLowerCase()).toContain("on conflict (request_id) do update");
    }

    await client.query("delete from vault.secrets where name = any($1::text[])", [
      ["notifications-dispatch-secret", "integration-webhooks-dispatch-secret"],
    ]);
    await client.query("select vault.create_secret($1, 'notifications-dispatch-secret', 'waveb4 tick proof')", [PROOF_SECRET]);
    await client.query("select vault.create_secret($1, 'integration-webhooks-dispatch-secret', 'waveb4 tick proof')", [PROOF_SECRET]);
    await client.query(
      "update private.notification_controls set dispatch_url = $1, files_reconcile_url = $1 where id",
      [PROOF_URL],
    );
    await client.query(
      "update private.integration_webhook_dispatch_controls set dispatch_url = $1 where id",
      [PROOF_URL],
    );

    const probe = await client.query(
      `select net.http_post(
         url := $1,
         headers := jsonb_build_object('Content-Type', 'application/json'),
         body := '{}'::jsonb,
         timeout_milliseconds := 1000
       ) as request_id`,
      [PROOF_URL],
    );
    const current = BigInt(probe.rows[0].request_id);
    const seedFrom = current + 1n;
    const seedTo = current + SEED_SPAN;
    for (const { table } of JOBS) {
      await client.query(
        `insert into ${table} (request_id, created_at)
         select seed.id, now() - interval '2 hours'
         from generate_series($1::bigint, $2::bigint) as seed(id)
         on conflict (request_id) do update set created_at = now() - interval '2 hours'`,
        [seedFrom.toString(), seedTo.toString()],
      );
    }

    const colliding = seedFrom.toString();
    await client.query("savepoint expected_collision");
    let collision;
    try {
      await client.query(
        "insert into private.notification_dispatch_ticks (request_id) values ($1)",
        [colliding],
      );
    } catch (error) {
      collision = error;
    }
    await client.query("rollback to savepoint expected_collision");
    expect(collision?.code, "plain tick insert must unique-violate inside the seeded window").toBe("23505");

    for (const row of scheduled.rows) {
      await client.query(row.command);
    }

    for (const { table } of JOBS) {
      const fresh = await client.query(
        `select request_id, created_at
         from ${table}
         where created_at > now() - interval '1 hour'
           and request_id between $1::bigint and $2::bigint
         order by created_at desc, request_id desc
         limit 1`,
        [seedFrom.toString(), seedTo.toString()],
      );
      expect(fresh.rows, `${table} must record a tick inside the seeded collision window`).toHaveLength(1);
    }

    const health = (await client.query("select public.get_notification_dispatch_health() as value")).rows[0].value;
    const freshHealth = (health.ticks || []).filter((tick) => {
      const id = BigInt(tick.requestId);
      return id >= seedFrom && id <= seedTo;
    });
    expect(freshHealth.length, "dispatch health RPC must report the refreshed notification tick").toBeGreaterThan(0);
  }, 30000);

  it("does not report a prior pg_net response as the refreshed tick's health", async () => {
    const reusedId = "424242424242";
    await client.query(
      `insert into private.notification_dispatch_ticks (request_id, created_at)
       values ($1::bigint, now() - interval '30 minutes')
       on conflict (request_id) do update set created_at = now() - interval '30 minutes'`,
      [reusedId],
    );
    await client.query(
      `insert into net._http_response (id, status_code, timed_out, error_msg, created)
       values ($1::bigint, 418, false, 'stale-prior-response', now() - interval '30 minutes')`,
      [reusedId],
    );
    await client.query(
      `insert into private.notification_dispatch_ticks (request_id)
       values ($1::bigint)
       on conflict (request_id) do update set created_at = excluded.created_at`,
      [reusedId],
    );

    const health = (await client.query("select public.get_notification_dispatch_health() as value")).rows[0].value;
    const ticks = (health.ticks || []).filter((tick) => String(tick.requestId) === reusedId);
    expect(ticks, "health must list the refreshed tick once, not a duplicated stale join").toHaveLength(1);
    expect(ticks[0].status, "stale response must not be treated as the new dispatch").not.toBe(418);
    expect(ticks[0].error, "stale error_msg must not be treated as the new dispatch").not.toBe("stale-prior-response");
  });
});
