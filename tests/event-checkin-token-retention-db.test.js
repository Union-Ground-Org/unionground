// @vitest-environment node
//
// OPS-UG-EVENT-CHECKIN-TOKENS-NO-RETENTION-20260921.
//
// private.member_event_checkin_tokens had no retention rule: every steward scan
// left a permanent row pairing member, event, scanner and timestamp, and every
// abandoned 90-second token stayed forever. The static pins for the migration
// text live in tests/events-scan-checkin.test.js and the job-health copies in
// tests/cron-job-health-sync-migration.test.js; this file is the live half
// (disposable loopback only, one rolled-back transaction): the sweep removes
// only rows well past expiry, leaves the attendance record, cannot be run by a
// client role, is scheduled, and its runs are admitted by the job-health mirror.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { migrationNames } from "./helpers/migration.js";

const NAME = "20260925620400_member_event_checkin_token_retention.sql";
const PURGE = "private.purge_expired_member_event_checkin_tokens()";

describe("event check-in token retention migration", () => {
  it("applies after the token store it purges", () => {
    const names = migrationNames();
    expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf("20260723140000_member_event_scan_checkin.sql"));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the nightly sweep purges stale check-in tokens and keeps attendance", () => {
  let client;
  const id = Object.fromEntries(["org", "steward", "member", "old", "abandoned", "recent", "live"].map((key) => [key, randomUUID()]));
  const suffix = id.org.slice(0, 8);
  const chapter = `checkin-retention-${suffix}`;
  const event = `checkin-retention-event-${suffix}`;

  async function tokenIds() {
    const result = await client.query(
      "select id from private.member_event_checkin_tokens where event_id = $1 order by id",
      [event],
    );
    return result.rows.map((row) => row.id).sort();
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "event-checkin-token-retention-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query(
      "insert into auth.users (id, email) values ($1, $3), ($2, $4)",
      [id.steward, id.member, `${id.steward}@example.invalid`, `${id.member}@example.invalid`],
    );
    await client.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)",
      [id.org, chapter, id.steward],
    );
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 96001)",
      [chapter, id.org],
    );
    await client.query(
      `insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id)
       values ($1, 'Retention proof event', now() - interval '60 days', 'Hall', '', $2, 96001, $3)`,
      [event, `SG-${suffix}`.toUpperCase(), chapter],
    );
    // One row per retention outcome. Tokens live 90 seconds, so "expired 31 days
    // ago" is a consumed scan or an abandoned request from a month back.
    await client.query(
      `insert into private.member_event_checkin_tokens (id, event_id, user_id, token_hash, expires_at, consumed_at, consumed_by)
       values ($1, $5, $6, md5(random()::text), now() - interval '31 days', now() - interval '31 days', $7),
              ($2, $5, $6, md5(random()::text), now() - interval '31 days', null, null),
              ($3, $5, $6, md5(random()::text), now() - interval '2 days', now() - interval '2 days', $7),
              ($4, $5, $6, md5(random()::text), now() + interval '90 seconds', null, null)`,
      [id.old, id.abandoned, id.recent, id.live, event, id.member, id.steward],
    );
    await client.query(
      "insert into public.member_event_checkins (event_id, user_id, scanned_by) values ($1, $2, $3)",
      [event, id.member, id.steward],
    );
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("deletes only tokens more than 30 days past expiry", async () => {
    expect(await tokenIds()).toEqual([id.old, id.abandoned, id.recent, id.live].sort());
    const purged = await client.query(`select ${PURGE} as removed`);
    expect(purged.rows[0].removed).toBeGreaterThanOrEqual(2);
    expect(await tokenIds()).toEqual([id.recent, id.live].sort());
  });

  it("leaves member_event_checkins as the durable attendance record", async () => {
    const attendance = await client.query(
      "select scanned_by from public.member_event_checkins where event_id = $1 and user_id = $2",
      [event, id.member],
    );
    expect(attendance.rows).toEqual([{ scanned_by: id.steward }]);
  });

  it("converges: a second run in the same night finds nothing of this fixture left", async () => {
    await client.query(`select ${PURGE}`);
    expect(await tokenIds()).toEqual([id.recent, id.live].sort());
  });

  it("is a definer no client role can execute", async () => {
    const acl = await client.query(
      `select p.prosecdef,
              has_function_privilege('anon', p.oid, 'execute') anon,
              has_function_privilege('authenticated', p.oid, 'execute') authenticated,
              has_function_privilege('service_role', p.oid, 'execute') service_role,
              p.proconfig
         from pg_proc p where p.oid = to_regprocedure($1)`,
      [PURGE],
    );
    expect(acl.rows[0]).toMatchObject({ prosecdef: true, anon: false, authenticated: false, service_role: false });
    expect(acl.rows[0].proconfig).toContain("search_path=\"\"");
  });

  it("is scheduled nightly and its runs are admitted by the job-health mirror", async () => {
    const cron = await client.query("select to_regnamespace('cron') is not null as present");
    if (cron.rows[0].present) {
      const job = await client.query(
        "select schedule, command, active from cron.job where jobname = 'event-checkin-token-retention'",
      );
      expect(job.rows).toEqual([{
        schedule: "53 4 * * *",
        command: "select private.purge_expired_member_event_checkin_tokens();",
        active: true,
      }]);
    }
    const mirror = await client.query(
      `select pg_get_functiondef(to_regprocedure('private.sync_organization_job_runs_from_cron_history()')) mirror,
              pg_get_functiondef(to_regprocedure('public.list_organization_job_health()')) catalog`,
    );
    expect(mirror.rows[0].mirror).toContain("'event-checkin-token-retention'");
    expect(mirror.rows[0].catalog).toContain("'event-checkin-token-retention'");
    await client.query("savepoint job_run");
    await client.query(
      `insert into public.organization_job_runs (organization_id, job_name, run_id, status, started_at)
       values (null, 'event-checkin-token-retention', $1, 'completed', now())`,
      [`proof:${id.org}`],
    );
    await client.query("rollback to savepoint job_run");
  });
});
