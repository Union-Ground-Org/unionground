// @vitest-environment node
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// BUG-UG-CRON-JOB-HEALTH-SYNC-LOCK-STALL-20260908. Static pins can show the
// text of the incremental window; only a live apply shows that the per-minute
// mirror really stops rescanning fourteen days of pg_cron history under the
// case-graph row trigger. Everything below runs inside one transaction that is
// rolled back, so the disposable catalogue keeps no synthetic history.
const live = process.env.RUN_CRON_JOB_HEALTH_SYNC_DB_TESTS === "1" ? describe : describe.skip;

const SYNC = "select private.sync_organization_job_runs_from_cron_history() as changed";
const JOB = "member-messaging-dispatch";
// pg_cron run ids are bigints; a random high block keeps the synthetic rows
// away from anything the disposable stack's own scheduler may have written.
const base = 3_000_000_000 + randomInt(1, 900_000) * 1000;
const runId = (offset) => base + offset;
const mirrorId = (offset) => `cron:${runId(offset)}`;

async function insertHistory(client, offset, { status = "succeeded", startedAgo = "0 seconds" } = {}) {
  await client.query(`
    insert into cron.job_run_details (
      jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
    )
    select j.jobid, $1::bigint, 1, current_database(), current_user, 'select 1', $2::text, 'proof',
      clock_timestamp() - $3::interval, clock_timestamp() - $3::interval + interval '10 milliseconds'
    from cron.job j where j.jobname = $4
  `, [runId(offset), status, startedAgo, JOB]);
}

async function mirrored(client, offset) {
  const { rows } = await client.query(
    "select status, failure_code, redacted_summary from public.organization_job_runs where run_id = $1 and organization_id is null",
    [mirrorId(offset)],
  );
  return rows[0] ?? null;
}

live("cron job-health sync is incremental under the case-graph row trigger", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "cron-job-health-sync-proof",
    });
    await client.connect();
    const { rows } = await client.query("select pg_catalog.to_regnamespace('cron') is not null as present");
    if (!rows[0].present) throw new Error("the disposable stack must provide pg_cron for this proof");
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    // Validate the deployed optimization as well as its historical semantics.
    const routine = await client.query(`
      select proconfig from pg_catalog.pg_proc
      where oid = 'private.sync_organization_job_runs_from_cron_history()'::regprocedure
    `);
    expect(routine.rows[0].proconfig).toContain("jit=off");
    const indexes = await client.query(`
      select indexname from pg_catalog.pg_indexes
      where schemaname = 'public' and tablename = 'organization_job_runs'
        and indexname in ('organization_job_runs_cron_latest_idx', 'organization_job_runs_cron_open_idx')
    `);
    expect(indexes.rows).toHaveLength(2);
    // The disposable stack's own pg_cron launcher writes cron.job_run_details
    // rows every minute for allowlisted jobs, and the routine scans all of
    // them. Holding this lock for the proof's transaction blocks those writes
    // (they resume when the transaction rolls back), so every exact count
    // below is deterministic instead of racing a minute boundary.
    await client.query("lock table cron.job_run_details in share row exclusive mode");
    // Anchor the incremental window at "now": the newest mirrored cron start
    // decides where the next tick resumes, so the proof owns that anchor.
    await insertHistory(client, 0, { startedAgo: "1 second" });
    await client.query(SYNC);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("mirrors new history inside the window and reports how many rows changed", async () => {
    await insertHistory(client, 1, { startedAgo: "5 minutes" });
    await insertHistory(client, 2, { status: "running", startedAgo: "2 minutes" });
    const { rows } = await client.query(SYNC);
    expect(rows[0].changed).toBe(2);
    expect(await mirrored(client, 1)).toEqual({ status: "completed", failure_code: null, redacted_summary: null });
    expect(await mirrored(client, 2)).toEqual({ status: "in_progress", failure_code: null, redacted_summary: null });
  });

  it("performs no row work on a repeated tick: candidates already mirrored never reach the BEFORE INSERT trigger", async () => {
    // Instrument the retained BEFORE INSERT row path inside this rolled-back
    // transaction. Candidates whose mirrored outcome already matches are
    // filtered out before the insert, so a repeated tick must show zero
    // inserts, zero updates AND zero row-trigger invocations even though the
    // three synthetic rows are still inside the window.
    await client.query("savepoint instrumented");
    await client.query("create table pg_temp.proof_trigger_hits (hits integer not null)");
    await client.query("insert into pg_temp.proof_trigger_hits values (0)");
    await client.query(`
      create function private.cron_job_health_sync_proof_count_hit()
      returns trigger language plpgsql set search_path = '' as $$
      begin update pg_temp.proof_trigger_hits set hits = hits + 1; return new; end;
      $$
    `);
    await client.query(`
      create trigger a01_cron_job_health_sync_proof before insert on public.organization_job_runs
      for each row execute function private.cron_job_health_sync_proof_count_hit()
    `);
    const { rows } = await client.query(SYNC);
    const hits = (await client.query("select hits from pg_temp.proof_trigger_hits")).rows[0].hits;
    const { rows: window } = await client.query(`
      select count(*)::int as candidates
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname = $1 and d.runid = any($2::bigint[])
    `, [JOB, [runId(0), runId(1), runId(2)]]);
    expect(rows[0].changed).toBe(0);
    expect(window[0].candidates).toBe(3);
    expect(hits).toBe(0);
    // And a changed candidate is the only row that reaches the trigger.
    await client.query(
      "update cron.job_run_details set return_message = 'proof', status = 'failed', end_time = clock_timestamp() where runid = $1",
      [runId(1)],
    );
    const { rows: again } = await client.query(SYNC);
    expect(again[0].changed).toBe(1);
    expect((await client.query("select hits from pg_temp.proof_trigger_hits")).rows[0].hits).toBe(1);
    await client.query("rollback to savepoint instrumented");
  });

  it("propagates an outcome change for a run that was in progress at the previous tick", async () => {
    await client.query(
      "update cron.job_run_details set status = 'failed', end_time = clock_timestamp() where runid = $1",
      [runId(2)],
    );
    const { rows } = await client.query(SYNC);
    expect(rows[0].changed).toBe(1);
    expect(await mirrored(client, 2)).toEqual({
      status: "failed",
      failure_code: "cron_failed",
      redacted_summary: "Scheduled command failed.",
    });
  });

  it("does not rescan history older than the two-hour look-back once the mirror is anchored", async () => {
    await insertHistory(client, 3, { startedAgo: "3 hours" });
    const { rows } = await client.query(SYNC);
    expect(rows[0].changed).toBe(0);
    expect(await mirrored(client, 3)).toBeNull();
  });

  it("still lands a completion for a run mirrored as in progress whose start left the look-back", async () => {
    await client.query("savepoint late_completion");
    // Mirror a run that started five hours ago while it was still running.
    await insertHistory(client, 6, { status: "running", startedAgo: "5 hours" });
    await client.query(
      "update public.organization_job_runs set started_at = clock_timestamp() - interval '5 hours' where run_id = $1",
      [mirrorId(0)],
    );
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%' and started_at > clock_timestamp() - interval '4 hours'");
    expect((await client.query(SYNC)).rows[0].changed).toBeGreaterThanOrEqual(1);
    expect(await mirrored(client, 6)).toEqual({ status: "in_progress", failure_code: null, redacted_summary: null });
    // The mirror moves on for three hours, then the old run finally finishes.
    await insertHistory(client, 7, { startedAgo: "1 second" });
    await client.query(SYNC);
    await client.query(
      "update cron.job_run_details set status = 'succeeded', end_time = clock_timestamp() where runid = $1",
      [runId(6)],
    );
    const { rows } = await client.query(SYNC);
    expect(rows[0].changed).toBe(1);
    expect(await mirrored(client, 6)).toEqual({ status: "completed", failure_code: null, redacted_summary: null });
    await client.query("rollback to savepoint late_completion");
  });

  it("keeps every mirror read bounded on a large retained mirror", async () => {
    // BUG-UG-CRON-HEALTH-MIRROR-LIFECYCLE-LOCK-HOLD-20261007. Production
    // held the lifecycle gate ~47 s while the old existing-row join walked the
    // whole mirror. An unchanged tick must cost the same whether 20,000 or
    // 40,000 retained runs sit outside the window: no sequential scan, and heap
    // tuples, index entries and buffer requests on the mirror and every one of
    // its indexes stay small and do not grow with the retained volume. This
    // transaction's own statistics count them, including index-only walks.
    await client.query("savepoint large_mirror");
    const seed = async (from) => {
      await client.query(`
        insert into public.organization_job_runs (organization_id, job_name, run_id, status, started_at, finished_at)
        select null, $1, 'cron:' || ($2::bigint + i)::text, 'completed',
          clock_timestamp() - interval '3 days' - i * interval '1 second',
          clock_timestamp() - interval '3 days' - i * interval '1 second' + interval '10 milliseconds'
        from generate_series($3::bigint, $3::bigint + 19999) as i
      `, [JOB, base, from]);
      await client.query(`
        insert into cron.job_run_details (
          jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
        )
        select j.jobid, $2::bigint + i, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof',
          clock_timestamp() - interval '3 days' - i * interval '1 second',
          clock_timestamp() - interval '3 days' - i * interval '1 second' + interval '10 milliseconds'
        from cron.job j cross join generate_series($3::bigint, $3::bigint + 19999) as i where j.jobname = $1
      `, [JOB, base, from]);
      // Fresh statistics also invalidate this session's cached plans.
      await client.query("analyze public.organization_job_runs");
      await client.query("analyze cron.job_run_details");
    };
    const reads = async () => (await client.query(`
      select pg_catalog.pg_stat_get_xact_numscans(c.oid)::int as seq_scans,
        (pg_catalog.pg_stat_get_xact_tuples_returned(c.oid) + pg_catalog.pg_stat_get_xact_tuples_fetched(c.oid))::int as heap_tuples,
        coalesce((select sum(pg_catalog.pg_stat_get_xact_tuples_returned(i.indexrelid)) from pg_catalog.pg_index i
          where i.indrelid = c.oid), 0)::int as index_entries,
        (pg_catalog.pg_stat_get_xact_blocks_fetched(c.oid) + coalesce((select sum(pg_catalog.pg_stat_get_xact_blocks_fetched(i.indexrelid))
          from pg_catalog.pg_index i where i.indrelid = c.oid), 0))::int as blocks
      from pg_catalog.pg_class c where c.oid = 'public.organization_job_runs'::regclass
    `)).rows[0];
    const tickCost = async () => {
      await client.query(SYNC);
      const before = await reads();
      const { rows } = await client.query(SYNC);
      const after = await reads();
      expect(rows[0].changed).toBe(0);
      return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
    };
    // Production runs the routine's statements as cached generic plans, where
    // the old join chose a full-mirror walk; force that plan shape here.
    await client.query("set local plan_cache_mode = force_generic_plan");
    await seed(100000);
    const small = await tickCost();
    await seed(200000);
    const large = await tickCost();
    // The absolute ceiling is a tenth of the seeded volume: the live CI stack's
    // own recent runs sit in the window and each costs a lookup (CI read 205
    // index entries), while a walk of the retained mirror reads 20,000 or more.
    for (const cost of [small, large]) {
      expect(cost.seq_scans).toBe(0);
      expect(cost.heap_tuples).toBeLessThan(2000);
      expect(cost.index_entries).toBeLessThan(2000);
      expect(cost.blocks).toBeLessThan(2000);
    }
    // Doubling the retained mirror adds 20,000 rows; a full walk of any
    // index or the heap would add at least that many reads here.
    expect(Math.abs(large.heap_tuples - small.heap_tuples)).toBeLessThan(10);
    expect(Math.abs(large.index_entries - small.index_entries)).toBeLessThan(10);
    expect(Math.abs(large.blocks - small.blocks)).toBeLessThan(10);
    await client.query("rollback to savepoint large_mirror");
  });

  it("catches a cold mirror up in bounded oldest-first ticks without skipping runs or late completions", async () => {
    // A cold mirror once wrote fourteen days of history in one transaction
    // while holding the lifecycle gate. Each tick now mirrors at most 2,000
    // pending runs, oldest start first with ties broken by run id. The
    // newest-start watermark therefore never passes a run left pending.
    await client.query("savepoint cold_catch_up");
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
    // Fourteen-day-style history the mirror has never seen: one in-progress
    // run older than everything, then 2,500 runs whose starts repeat in groups
    // of ten, so equal start times straddle the 2,000-row batch boundary.
    const late = 300000;
    await insertHistory(client, late, { status: "running", startedAgo: "11 days" });
    await client.query(`
      insert into cron.job_run_details (
        jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
      )
      select j.jobid, $2::bigint + 300001 + i, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof',
        clock_timestamp() - interval '10 days' + (i / 10) * interval '1 second',
        clock_timestamp() - interval '10 days' + (i / 10) * interval '1 second' + interval '10 milliseconds'
      from cron.job j cross join generate_series(0, 2499) as i where j.jobname = $1
    `, [JOB, base]);
    const pendingRuns = async () => (await client.query(`
      select count(*)::int as n from cron.job_run_details d
      where d.runid between $1 and $2
        and not exists (select 1 from public.organization_job_runs m
          where m.organization_id is null and m.job_name = $3 and m.run_id = 'cron:' || d.runid::text)
    `, [runId(300001), runId(302500), JOB])).rows[0].n;
    // First tick: the oldest 2,000 pending runs, the old open run first.
    expect((await client.query(SYNC)).rows[0].changed).toBe(2000);
    expect(await mirrored(client, late)).toEqual({ status: "in_progress", failure_code: null, redacted_summary: null });
    expect(await pendingRuns()).toBe(501);
    // Every mirrored backlog run sorts before every one still pending.
    const order = (await client.query(`
      with backlog as (
        select d.start_time, d.runid, exists (select 1 from public.organization_job_runs m
          where m.organization_id is null and m.job_name = $3 and m.run_id = 'cron:' || d.runid::text) as done
        from cron.job_run_details d where d.runid between $1 and $2
      )
      select (select max(array[extract(epoch from start_time), runid::numeric]) from backlog where done)
        < (select min(array[extract(epoch from start_time), runid::numeric]) from backlog where not done) as ordered
    `, [runId(300001), runId(302500), JOB])).rows[0];
    expect(order.ordered).toBe(true);
    // The old run completes mid catch-up. It is the oldest pending change, so
    // the next tick lands it together with the rest of the backlog.
    await client.query(
      "update cron.job_run_details set status = 'succeeded', end_time = clock_timestamp() where runid = $1",
      [runId(late)],
    );
    // Later ticks finish the backlog and then go quiet.
    const later = [];
    for (let tick = 0; tick < 3; tick += 1) later.push((await client.query(SYNC)).rows[0].changed);
    expect(later[0]).toBeGreaterThanOrEqual(502);
    expect(later[0]).toBeLessThanOrEqual(2000);
    expect(later.at(-1)).toBe(0);
    expect(await mirrored(client, late)).toEqual({ status: "completed", failure_code: null, redacted_summary: null });
    expect(await pendingRuns()).toBe(0);
    await client.query("rollback to savepoint cold_catch_up");
  });

  it("restarts an interrupted catch-up tick idempotently", async () => {
    await client.query("savepoint restart");
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
    await client.query(`
      insert into cron.job_run_details (
        jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
      )
      select j.jobid, $2::bigint + 400001 + i, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof',
        clock_timestamp() - interval '9 days' + i * interval '1 second',
        clock_timestamp() - interval '9 days' + i * interval '1 second' + interval '10 milliseconds'
      from cron.job j cross join generate_series(0, 2199) as i where j.jobname = $1
    `, [JOB, base]);
    const snapshot = async () => (await client.query(
      "select count(*)::int as n, max(run_id) as last from public.organization_job_runs where organization_id is null and run_id like 'cron:%'",
    )).rows[0];
    // A tick that dies before commit leaves nothing behind; the rerun does the same work.
    await client.query("savepoint aborted_tick");
    const aborted = (await client.query(SYNC)).rows[0].changed;
    const abortedState = await snapshot();
    await client.query("rollback to savepoint aborted_tick");
    expect((await snapshot()).n).toBe(0);
    const rerun = (await client.query(SYNC)).rows[0].changed;
    expect(rerun).toBe(aborted);
    expect(rerun).toBe(2000);
    expect(await snapshot()).toEqual(abortedState);
    await client.query("rollback to savepoint restart");
  });

  it("never reaches past the fourteen-day floor even when no history was mirrored yet", async () => {
    await client.query("savepoint unanchored");
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
    await insertHistory(client, 4, { startedAgo: "13 days" });
    await insertHistory(client, 5, { startedAgo: "15 days" });
    const { rows } = await client.query(SYNC);
    expect(rows[0].changed).toBeGreaterThanOrEqual(1);
    expect(await mirrored(client, 4)).toEqual({ status: "completed", failure_code: null, redacted_summary: null });
    expect(await mirrored(client, 5)).toBeNull();
    await client.query("rollback to savepoint unanchored");
  });
});

// BUG-UG-SAMPLE-STAFF-TWO-STEP-VERIFY-500-LOCK-TIMEOUT-20261106 (#7299). The mirror
// used to take the global lifecycle gate before scanning pg_cron history, so a
// slow scan cancelled every gated writer that queued behind it, including
// GoTrue's auth.mfa_factors statements. With another session holding the gate,
// an idle tick must finish without waiting, and a tick with a changed run must
// still wait for the gate before its upsert.
live("cron job-health sync reads history before the lifecycle gate", () => {
  it("finishes an idle tick while another session holds the gate and waits only to write", async () => {
    const connect = async (name) => {
      const c = new pg.Client({
        connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
        ssl: false,
        application_name: name,
      });
      await c.connect();
      return c;
    };
    const holder = await connect("cron-job-health-sync-gate-holder");
    const ticker = await connect("cron-job-health-sync-gate-ticker");
    try {
      await ticker.query("begin");
      await ticker.query("set local statement_timeout = '30s'");
      await ticker.query("set local lock_timeout = '15s'");
      // Keep the stack's scheduler out and empty the retained history inside
      // this rolled-back transaction: no history row, no candidate, an idle tick.
      await ticker.query("lock table cron.job_run_details in share row exclusive mode");
      await ticker.query("delete from cron.job_run_details");
      await holder.query("begin");
      await holder.query("select private.lock_case_graph(array[]::uuid[], array[]::uuid[])");
      await ticker.query("savepoint idle_tick");
      const { rows } = await ticker.query(SYNC);
      expect(rows[0].changed).toBe(0);
      await ticker.query("release savepoint idle_tick");
      await insertHistory(ticker, 900, { startedAgo: "1 second" });
      await ticker.query("savepoint gated_tick");
      await expect(ticker.query(SYNC)).rejects.toMatchObject({ code: "55P03" });
      await ticker.query("rollback to savepoint gated_tick");
      await holder.query("rollback");
      const { rows: after } = await ticker.query(SYNC);
      expect(after[0].changed).toBe(1);
    } finally {
      await holder.query("rollback").catch(() => {});
      await ticker.query("rollback").catch(() => {});
      await holder.end();
      await ticker.end();
    }
  });
});

// BUG-UG-CRON-MIRROR-READS-WHOLE-CRON-HISTORY-EVERY-MINUTE-20261108 (#7513). The
// mirror filtered cron.job_run_details on its unindexed start_time, so every
// tick read the whole retained history (607,000 rows on SAMPLE). The scan is
// now bounded below by the run id of the newest mirrored run that started more
// than six hours before the window. The previous routine, rebuilt here from its
// migration, and the installed one replay the same seeded history tick by tick
// and must leave the same mirror and report the same counts, including run ids
// out of start order on both sides of the window and the history emptied with
// its ids restarted, and pg_cron's run-id sequence restarted below retained
// history (under the bound, into a gap, and just under the anchor then past
// it) until it climbs back above every retained id; the installed one must
// also read a bounded slice.
const unboundedMirror = "private.cron_mirror_unbounded_proof";
const unboundedSource = (() => {
  const raw = readFileSync(new URL("../supabase/migrations/20261106227000_cron_mirror_reads_before_lifecycle_gate.sql", import.meta.url), "utf8");
  const start = raw.indexOf("create or replace function private.sync_organization_job_runs_from_cron_history()");
  const end = raw.indexOf("$function$;", start) + "$function$;".length;
  if (start === -1 || end < start) throw new Error("the previous mirror definition was not found");
  return raw.slice(start, end).replace("private.sync_organization_job_runs_from_cron_history()", `${unboundedMirror}()`);
})();
// Two allowlisted jobs and the mirror's own, unmirrored job as noise.
const historyJobs = ["member-messaging-dispatch", "live-poll-schedule-tick", "mi1-job-health-sync"];
const MINUTES = 2400;

live("cron job-health sync reads only a run-id slice of the history and mirrors what the unbounded scan mirrored", () => {
  let client;
  const historyBase = 4_000_000_000 + randomInt(1, 900_000) * 10_000;

  const cronReads = async () => (await client.query(`
    select pg_catalog.pg_stat_get_xact_numscans(c.oid)::int as seq_scans,
      (pg_catalog.pg_stat_get_xact_tuples_returned(c.oid) + pg_catalog.pg_stat_get_xact_tuples_fetched(c.oid))::int as heap_tuples,
      pg_catalog.pg_stat_get_xact_blocks_fetched(c.oid)::int as blocks
    from pg_catalog.pg_class c where c.oid = 'cron.job_run_details'::regclass
  `)).rows[0];
  const snapshot = async () => (await client.query(`
    select count(*)::int as runs,
      coalesce(md5(string_agg((m.job_name, m.run_id, m.status, m.started_at, m.finished_at, m.failure_code, m.redacted_summary)::text,
        '|' order by m.run_id, m.job_name)), '') as digest
    from public.organization_job_runs m where m.organization_id is null and m.run_id like 'cron:%'
  `)).rows[0];
  // The window and run-id bound exactly as the installed routine derives them.
  const bound = async () => (await client.query(`
    with w as (
      select greatest(coalesce(max(m.started_at), now() - interval '14 days') - interval '2 hours', now() - interval '14 days') as window_start
      from public.organization_job_runs m where m.organization_id is null and m.run_id like 'cron:%'
    )
    select w.window_start, a.runid as floor_runid
    from w left join lateral (
      select substr(m.run_id, 6)::bigint as runid from public.organization_job_runs m
      where m.organization_id is null and m.run_id like 'cron:%' and m.started_at < w.window_start - interval '6 hours'
      order by m.started_at desc limit 1
    ) a on true
  `)).rows[0];
  // 40 hours of minutely runs for three jobs. Ids follow start order with gaps,
  // except that every eleventh minute the first job starts four minutes and
  // seven seconds late (never on another run's start), after runs with higher
  // ids. Some runs failed; some are still running.
  const seedHistory = async () => {
    await client.query(`
      insert into cron.job_run_details (
        jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
      )
      select j.jobid, $1::bigint + m * 10 + jobs.k, 1, current_database(), current_user, 'select 1',
        case when jobs.k = 0 and m % 97 = 0 then 'running' when jobs.k = 1 and m % 13 = 0 then 'failed' else 'succeeded' end,
        'proof', s.start_time,
        case when jobs.k = 0 and m % 97 = 0 then null else s.start_time + interval '10 milliseconds' end
      from (select u.name, (u.ord - 1)::int as k from unnest($2::text[]) with ordinality as u(name, ord)) as jobs
      join cron.job j on j.jobname = jobs.name
      cross join generate_series(0, $3::int - 1) as m
      cross join lateral (select now() - ($3::int - m) * interval '1 minute' + jobs.k * interval '20 seconds'
        + case when jobs.k = 0 and m % 11 = 0 and m < $3::int - 5 then interval '4 minutes 7 seconds' else interval '0 seconds' end
        as start_time) as s
    `, [historyBase, historyJobs, MINUTES]);
    // The retained history behind it: 30,000 older runs, 15 to 29 days old,
    // past the fourteen-day floor, so neither routine ever mirrors them.
    await client.query(`
      insert into cron.job_run_details (
        jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
      )
      select j.jobid, $1::bigint - 60000 + i, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof',
        now() - interval '15 days' - (30000 - i) * interval '40 seconds',
        now() - interval '15 days' - (30000 - i) * interval '40 seconds' + interval '10 milliseconds'
      from cron.job j cross join generate_series(0, 29999) as i where j.jobname = 'member-messaging-dispatch'
    `, [historyBase]);
  };

  const setHighWater = (value) => client.query("select pg_catalog.set_config('proof.cron_high_water', $1::text, true)", [String(value)]);
  const insertRuns = (jobName, runs) => client.query(`
    insert into cron.job_run_details (
      jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
    )
    select j.jobid, r.runid, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof',
      now() - r.ago, now() - r.ago + interval '10 milliseconds'
    from cron.job j cross join unnest($2::bigint[], $3::interval[]) as r(runid, ago)
    where j.jobname = $1
  `, [jobName, runs.map(([runid]) => String(runid)), runs.map(([, ago]) => ago)]);

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "cron-job-health-sync-runid-bound-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    // One backend per scan, so this transaction's own statistics count it.
    await client.query("set local max_parallel_workers_per_gather = 0");
    // Keep the stack's scheduler out and start from an empty history and mirror.
    await client.query("lock table cron.job_run_details in share row exclusive mode");
    await client.query("delete from cron.job_run_details");
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
    // And from no accounting state: the first drained full read builds it.
    await client.query("delete from private.cron_job_health_mirror_state");
    const { rows } = await client.query("select count(*)::int as n from cron.job where jobname = any($1::text[])", [historyJobs]);
    expect(rows[0].n).toBe(historyJobs.length);
    await client.query(unboundedSource);
    // The installed high-water helper reads pg_cron's own run-id sequence. This
    // role may read that sequence but not move it, so inside this rolled-back
    // transaction the helper is replaced by one that returns the sequence
    // state each step sets, starting at or above every seeded id.
    const { rows: real } = await client.query(`
      select private.cron_run_id_high_water() is not distinct from (
        select s.last_value from pg_catalog.pg_sequences s where s.schemaname = 'cron' and s.sequencename = 'runid_seq'
      ) as same
    `);
    expect(real[0].same).toBe(true);
    await client.query(`
      create or replace function private.cron_run_id_high_water() returns bigint language sql stable set search_path = ''
      as $proof$ select nullif(pg_catalog.current_setting('proof.cron_high_water', true), '')::bigint $proof$
    `);
    await setHighWater(historyBase + 60_000_000);
    await seedHistory();
    await client.query("analyze cron.job_run_details");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  // Each step changes the history the same way in both replays, then ticks.
  const steps = [
    { name: "cold catch-up 1" },
    { name: "cold catch-up 2" },
    { name: "cold catch-up 3" },
    // The first clean tick lists the run ids no run holds up to the bound,
    // reading everything once more while it does.
    { name: "accounting caught up" },
    {
      name: "runs out of id order at the window edge and next to the bound, late completions",
      before: async () => {
        const { window_start: windowStart, floor_runid: floorRunid } = await bound();
        expect(floorRunid).not.toBeNull();
        // Inside the window with the lowest new id, then before the window with
        // a higher one (not mirrored); the first free id above the bound (seeded
        // ids leave gaps of seven), inside the window; and a run that started just now with an id below one that
        // started three minutes earlier.
        await client.query(`
          insert into cron.job_run_details (
            jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
          )
          select j.jobid, r.runid, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof', r.start_time,
            r.start_time + interval '10 milliseconds'
          from cron.job j cross join (values
            ($1::bigint + 50000001, $2::timestamptz + interval '2 minutes'),
            ($1::bigint + 50000002, $2::timestamptz - interval '2 minutes'),
            ($3::bigint + 5, $2::timestamptz + interval '1 minute'),
            ($1::bigint + 50000003, now()),
            ($1::bigint + 50000004, now() - interval '3 minutes')
          ) as r(runid, start_time)
          where j.jobname = 'member-messaging-dispatch'
        `, [historyBase, windowStart, floorRunid]);
        // Runs still running, some long before the bound, finish now.
        await client.query(`
          update cron.job_run_details set status = 'succeeded', end_time = now()
          where status = 'running' and runid between $1::bigint and $1::bigint + 50000000
        `, [historyBase]);
      },
    },
    { name: "quiet tick" },
    {
      // The anchor and the newest mirrored run
      // are still in the history when the sequence restarts into the free ids
      // under it.
      name: "sequence restarted into a freed low range with the older history retained",
      before: async () => {
        await setHighWater(3);
        await insertRuns("member-messaging-dispatch", [[1, "4 minutes"], [2, "3 minutes"], [3, "2 minutes"]]);
      },
    },
    { name: "quiet tick after the low restart" },
    {
      // The same, into a free gap between two retained id ranges: older runs
      // keep the ids below it and the anchor the ids above it.
      name: "sequence restarted into a gap between retained id ranges",
      before: async () => {
        await setHighWater(historyBase - 29_990);
        await insertRuns("live-poll-schedule-tick",
          Array.from({ length: 10 }, (_, i) => [historyBase - 29_999 + i, `${100 - i * 10} seconds`]));
      },
    },
    { name: "quiet tick after the gap restart" },
    {
      // Restarted two ids under the anchor,
      // the sequence hands out those two, skips the retained ids from the anchor
      // up (pg_cron cannot log those runs) and passes the anchor while still
      // below the highest retained id. Like 998 and 999 then 1001 and 1002
      // around a retained 1000.
      name: "sequence restarted just under the anchor and allocated past it",
      before: async () => {
        const { floor_runid: floorRunid } = await bound();
        expect(floorRunid).not.toBeNull();
        // Seeded ids sit at offsets 0 to 2 of each block of ten.
        const block = BigInt(floorRunid) - ((BigInt(floorRunid) - BigInt(historyBase)) % 10n);
        const ids = [block - 2n, block - 1n, block + 3n, block + 4n];
        await setHighWater(block + 4n);
        await insertRuns("member-messaging-dispatch", ids.map((id, i) => [id, `${50 - i * 10} seconds`]));
      },
    },
    { name: "quiet tick while the sequence is still under the retained maximum" },
    {
      // After the full-read ticks above, the sequence climbs past every retained
      // id. This tick lists the free ids again (one more full read); then the
      // bound returns, and the runs given low ids are already mirrored.
      name: "sequence back above the highest retained id",
      before: async () => {
        const top = BigInt(historyBase) + 50_000_013n;
        await setHighWater(top);
        await insertRuns("live-poll-schedule-tick", [[top - 2n, "30 seconds"], [top - 1n, "20 seconds"], [top, "10 seconds"]]);
      },
    },
    { name: "quiet tick with the bound back" },
    {
      name: "history emptied and run ids restarted, one id equal to the bound with a different start",
      before: async () => {
        const { floor_runid: floorRunid } = await bound();
        expect(floorRunid).not.toBeNull();
        // The sequence is at the highest id left in the history, so only the
        // start check can drop the bound here.
        await setHighWater(floorRunid);
        await client.query("delete from cron.job_run_details");
        await client.query(`
          insert into cron.job_run_details (
            jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
          )
          select j.jobid, r.runid, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof', r.start_time,
            r.start_time + interval '10 milliseconds'
          from cron.job j cross join (values
            (1::bigint, now() - interval '4 minutes'), (2::bigint, now() - interval '3 minutes'),
            (3::bigint, now() - interval '2 minutes'), ($1::bigint, now() - interval '1 minute')
          ) as r(runid, start_time)
          where j.jobname = 'live-poll-schedule-tick'
        `, [floorRunid]);
      },
    },
    { name: "quiet tick after the restart" },
  ];

  const replay = async (routine) => {
    const results = [];
    for (const step of steps) {
      if (step.before) await step.before();
      const before = await cronReads();
      const changed = (await client.query(`select ${routine}() as changed`)).rows[0].changed;
      const after = await cronReads();
      results.push({
        step: step.name,
        changed,
        mirror: await snapshot(),
        reads: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]])),
      });
    }
    return results;
  };

  it("keeps the hourly reconciliation tick's history read the same size when the retained history grows (#7562)", async () => {
    // The hourly reconciliation probes only the run ids no run held, through
    // the primary key: no sequential scan, no history row read in normal
    // running, and the same cost on a history 30,000 runs larger. The ids
    // seeded at offsets 3 to 9 of every block of ten leave about 2,400 free
    // ranges to probe. It runs first in this group: the cases after it leave
    // rolled-back rows in free ranges, which the probe would step over.
    await client.query("savepoint reconcile_growth");
    const tickCost = async () => {
      const before = await cronReads();
      const { rows } = await client.query(SYNC);
      const after = await cronReads();
      expect(rows[0].changed).toBe(0);
      return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
    };
    const reconcileCost = async () => {
      await client.query("update private.cron_job_health_mirror_state set reconciled_at = now() - interval '61 minutes'");
      const cost = await tickCost();
      // The tick reconciled, and it stayed clean.
      const { rows } = await client.query(
        "select reconciled_at = now() as reconciled, checked_through > 0 as listed from private.cron_job_health_mirror_state",
      );
      expect(rows[0]).toEqual({ reconciled: true, listed: true });
      return cost;
    };
    // Build the accounting: catch up, then list the free ids.
    const build = async () => {
      await client.query("delete from private.cron_job_health_mirror_state");
      for (let tick = 0; tick < 4; tick += 1) await client.query(SYNC);
    };
    await build();
    const small = await reconcileCost();
    await client.query("set local plan_cache_mode = force_generic_plan");
    const smallGeneric = await reconcileCost();
    await client.query("set local plan_cache_mode = auto");
    // 30,000 more retained runs, three to ten days old, then the accounting
    // is rebuilt over the larger history.
    await client.query(`
      insert into cron.job_run_details (
        jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
      )
      select j.jobid, $1::bigint - 30000 + i, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof',
        now() - interval '10 days' + i * interval '20 seconds', now() - interval '10 days' + i * interval '20 seconds' + interval '10 milliseconds'
      from cron.job j cross join generate_series(0, 29999) as i where j.jobname = 'member-messaging-dispatch'
    `, [historyBase]);
    await client.query("analyze cron.job_run_details");
    await build();
    const large = await reconcileCost();
    await client.query("set local plan_cache_mode = force_generic_plan");
    const largeGeneric = await reconcileCost();
    await client.query("set local plan_cache_mode = auto");
    for (const cost of [small, smallGeneric, large, largeGeneric]) {
      expect(cost.seq_scans).toBe(0);
      expect(cost.heap_tuples).toBeLessThan(2000);
      expect(cost.blocks).toBeLessThan(200);
    }
    expect(Math.abs(large.heap_tuples - small.heap_tuples)).toBeLessThan(10);
    expect(Math.abs(largeGeneric.heap_tuples - smallGeneric.heap_tuples)).toBeLessThan(10);
    expect(Math.abs(large.blocks - small.blocks)).toBeLessThan(10);
    await client.query("rollback to savepoint reconcile_growth");
  }, 60_000);

  it("leaves the same mirror and reports the same counts as the unbounded scan, tick by tick", async () => {
    await client.query("savepoint replay");
    const unbounded = await replay(unboundedMirror);
    await client.query("rollback to savepoint replay");
    const bounded = await replay("private.sync_organization_job_runs_from_cron_history");
    await client.query("rollback to savepoint replay");
    const outcome = (results) => results.map(({ step, changed, mirror }) => ({ step, changed, mirror }));
    expect(outcome(bounded)).toEqual(outcome(unbounded));
    // The replay did real work: a 2,000-run catch-up, the edge runs and late
    // completions, the restarted ids, and quiet ticks in between.
    expect(bounded.map((r) => r.changed)).toEqual([2000, 2000, 800, 0, expect.any(Number), 0, 3, 0, 10, 0, 4, 0, 3, 0, 4, 0]);
    expect(bounded[4].changed).toBe(4 + Math.ceil(MINUTES / 97));
    // Once anchored, the installed routine reads a run-id slice through the
    // primary key; the unbounded one reads the whole history every tick.
    const at = (name) => steps.findIndex((step) => step.name === name);
    for (const index of [at("runs out of id order at the window edge and next to the bound, late completions"), at("quiet tick"), at("quiet tick with the bound back")]) {
      expect(bounded[index].reads.seq_scans).toBe(0);
      expect(bounded[index].reads.heap_tuples).toBeLessThan(2000);
      expect(unbounded[index].reads.seq_scans).toBeGreaterThanOrEqual(1);
      expect(unbounded[index].reads.heap_tuples).toBeGreaterThanOrEqual(historyJobs.length * MINUTES + 30000);
    }
    // While the sequence is below the highest retained id the bound is dropped
    // and the whole history is read again, as the unbounded routine does.
    for (let index = at("sequence restarted into a freed low range with the older history retained");
      index <= at("sequence back above the highest retained id"); index += 1) {
      expect(bounded[index].reads.heap_tuples).toBeGreaterThanOrEqual(historyJobs.length * MINUTES + 30000);
    }
  });

  it("mirrors every run of a restart that passed all retained ids before the next tick by the next hourly full read", async () => {
    // The sequence restarts at 2997 and hands
    // out ids through 3012 before the next tick, skipping the retained 3000 (the
    // anchor) and 3010 (the newest mirrored run), which pg_cron cannot log. The
    // anchor matches and the sequence equals the retained maximum, so no check
    // can see the restart and the bound misses 2997 to 2999. The older retained
    // run 1000 keeps the oldest id unchanged, so only the hourly probe of the
    // ids no run held (#7562) finds them, inside the look-back.
    await client.query("savepoint climbed_restart");
    await client.query("delete from cron.job_run_details");
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
    await client.query("delete from private.cron_job_health_mirror_state");
    const id = (n) => BigInt(historyBase) + BigInt(n);
    await setHighWater(id(3010));
    await insertRuns("member-messaging-dispatch", [[id(1000), "20 hours"], [id(3000), "9 hours"], [id(3010), "1 minute"]]);
    // No anchor yet: a full read, recorded as of now. The next tick lists the
    // free ids up to the anchor (reading everything once more).
    expect((await client.query(SYNC)).rows[0].changed).toBe(3);
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    expect((await client.query(
      "select checked_through = $1::bigint as at_anchor, free_runids @> $2::bigint as lists_2998 from private.cron_job_health_mirror_state",
      [String(id(3000)), String(id(2998))],
    )).rows[0]).toEqual({ at_anchor: true, lists_2998: true });
    const marker = async () => (await client.query(
      "select last_full_read_at = now() as now_ from private.cron_job_health_mirror_state where singleton",
    )).rows[0]?.now_ ?? null;
    expect(await marker()).toBe(true);
    const restarted = [];
    for (let n = 2997; n <= 3012; n += 1) if (n !== 3000 && n !== 3010) restarted.push([id(n), "2 minutes"]);
    await insertRuns("member-messaging-dispatch", restarted);
    await setHighWater(id(3012));
    await client.query("savepoint unbounded_reference");
    expect((await client.query(`select ${unboundedMirror}() as changed`)).rows[0].changed).toBe(14);
    const expected = await snapshot();
    await client.query("rollback to savepoint unbounded_reference");
    // Bounded ticks within the hour read no history row under the bound:
    // 2997 to 2999 wait.
    expect((await client.query(SYNC)).rows[0].changed).toBe(11);
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    expect(await snapshot()).not.toEqual(expected);
    // An hour after the last reconciliation, the probe finds runs at ids no
    // run held and the tick reads everything.
    await client.query("update private.cron_job_health_mirror_state set reconciled_at = now() - interval '61 minutes'");
    expect((await client.query(SYNC)).rows[0].changed).toBe(3);
    expect(await snapshot()).toEqual(expected);
    expect(await marker()).toBe(true);
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    await client.query("rollback to savepoint climbed_restart");
  });

  it("keeps a run that had not started when its id was listed probeable until it starts", async () => {
    // Pg_cron logs a run first and sets
    // its start later. Run 2998 is logged with no start when the accounting
    // lists the ids up to the anchor 3000; it must stay in the free list, or
    // the bound (ids above 3000) and every later probe would miss it once it
    // starts. Run 2999 never starts and must not force hourly full reads.
    await client.query("savepoint unstarted_run");
    await client.query("delete from cron.job_run_details");
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
    await client.query("delete from private.cron_job_health_mirror_state");
    const id = (n) => BigInt(historyBase) + BigInt(n);
    await setHighWater(id(3010));
    await insertRuns("member-messaging-dispatch", [[id(1000), "20 hours"], [id(3000), "9 hours"], [id(3010), "1 minute"]]);
    await client.query(`
      insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
      select j.jobid, r.runid, 1, current_database(), current_user, 'select 1', 'starting', null, null, null
      from cron.job j cross join unnest($1::bigint[]) as r(runid) where j.jobname = 'member-messaging-dispatch'
    `, [[String(id(2998)), String(id(2999))]]);
    expect((await client.query(SYNC)).rows[0].changed).toBe(3);
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    const listed = async () => (await client.query(
      "select checked_through = $1::bigint as at_anchor, free_runids @> $2::bigint as lists_2998, free_runids @> $3::bigint as lists_2999 from private.cron_job_health_mirror_state",
      [String(id(3000)), String(id(2998)), String(id(2999))],
    )).rows[0];
    expect(await listed()).toEqual({ at_anchor: true, lists_2998: true, lists_2999: true });
    // 2998 starts a minute ago and fails; 2999 is still waiting.
    await client.query(
      "update cron.job_run_details set status = 'failed', start_time = now() - interval '1 minute', end_time = now() where runid = $1",
      [String(id(2998))],
    );
    await client.query("savepoint unbounded_reference");
    expect((await client.query(`select ${unboundedMirror}() as changed`)).rows[0].changed).toBe(1);
    const expected = await snapshot();
    await client.query("rollback to savepoint unbounded_reference");
    // Within the hour 2998 waits under the bound.
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    // The hourly probe finds the started run and the tick reads everything.
    await client.query("update private.cron_job_health_mirror_state set reconciled_at = now() - interval '61 minutes'");
    expect((await client.query(SYNC)).rows[0].changed).toBe(1);
    expect(await snapshot()).toEqual(expected);
    expect((await client.query(
      "select status, failure_code from public.organization_job_runs where organization_id is null and run_id = $1",
      [`cron:${id(2998)}`],
    )).rows).toEqual([{ status: "failed", failure_code: "cron_failed" }]);
    // The accounting is listed again (one more full read), still listing the
    // unstarted 2999 and no longer 2998.
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    expect(await listed()).toEqual({ at_anchor: true, lists_2998: false, lists_2999: true });
    // A later hourly probe sees only the unstarted 2999: a clean
    // reconciliation, not a full read.
    await client.query(`
      update private.cron_job_health_mirror_state
      set reconciled_at = now() - interval '61 minutes', last_full_read_at = now() - interval '1 day'
    `);
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    expect((await client.query(
      "select reconciled_at = now() as reconciled, last_full_read_at < now() - interval '23 hours' as no_full_read from private.cron_job_health_mirror_state",
    )).rows[0]).toEqual({ reconciled: true, no_full_read: true });
    await client.query("rollback to savepoint unstarted_run");
  });

  it("keeps a held run that is not mirrored yet probeable when its job is added to the list later", async () => {
    // Muse comparison on #7622: the same root cause covers any held run that
    // no candidate read accounted for, for example a run of a job a later
    // migration adds to the hard-coded list. Run 2998 of live-poll-schedule-tick
    // started 30 minutes ago with an id under the anchor 3000, while both
    // routines still left that job out. Once the job is in the list the old
    // routine mirrors it at the next tick; the new one must find it by the
    // next hourly probe instead of never.
    const id = (n) => BigInt(historyBase) + BigInt(n);
    const without = (sql) => {
      const narrowed = sql.replace("'live-poll-schedule-tick', ", "");
      expect(narrowed).not.toBe(sql);
      return narrowed;
    };
    const installed = (await client.query(
      "select pg_catalog.pg_get_functiondef('private.sync_organization_job_runs_from_cron_history()'::regprocedure) as def",
    )).rows[0].def;
    const seed = async () => {
      await client.query("delete from cron.job_run_details");
      await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
      await client.query("delete from private.cron_job_health_mirror_state");
      await setHighWater(id(3010));
      await insertRuns("member-messaging-dispatch", [[id(1000), "20 hours"], [id(3000), "9 hours"], [id(3010), "1 minute"]]);
      await insertRuns("live-poll-schedule-tick", [[id(2998), "30 minutes"]]);
    };
    const play = async (routine, narrowSql, fullSql) => {
      await client.query("savepoint job_added_later");
      await client.query(narrowSql);
      await seed();
      const changed = [];
      for (let tick = 0; tick < 2; tick += 1) changed.push((await client.query(`select ${routine}() as changed`)).rows[0].changed);
      // A later migration adds the job to the list.
      await client.query(fullSql);
      changed.push((await client.query(`select ${routine}() as changed`)).rows[0].changed);
      await client.query("update private.cron_job_health_mirror_state set reconciled_at = now() - interval '61 minutes'");
      changed.push((await client.query(`select ${routine}() as changed`)).rows[0].changed);
      const result = { changed, mirror: await snapshot() };
      await client.query("rollback to savepoint job_added_later");
      return result;
    };
    const unbounded = await play(unboundedMirror, without(unboundedSource), unboundedSource);
    const bounded = await play("private.sync_organization_job_runs_from_cron_history", without(installed), installed);
    expect(unbounded.changed).toEqual([3, 0, 1, 0]);
    // Listed while not mirrored, then found by the hourly probe.
    expect(bounded.changed).toEqual([3, 0, 0, 1]);
    expect(bounded.mirror).toEqual(unbounded.mirror);
  });

  it("reads everything again when the oldest history was deleted and a restart logged runs into it", async () => {
    // #7562: deleting history frees ids the accounting does not list. A
    // purge of the oldest runs moves the oldest id, which the hourly
    // reconciliation compares (one primary key lookup), and the table's
    // delete count, which this transaction cannot move, does the same for a
    // purge anywhere. Here 1000 and 2000 are purged and the restarted sequence
    // logs a run at the freed 2000, which the accounting saw held, and then
    // ids past every retained one.
    await client.query("savepoint purged_restart");
    await client.query("delete from cron.job_run_details");
    await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
    await client.query("delete from private.cron_job_health_mirror_state");
    const id = (n) => BigInt(historyBase) + BigInt(n);
    await setHighWater(id(3010));
    await insertRuns("member-messaging-dispatch",
      [[id(1000), "20 hours"], [id(2000), "15 hours"], [id(3000), "9 hours"], [id(3010), "1 minute"]]);
    expect((await client.query(SYNC)).rows[0].changed).toBe(4);
    expect((await client.query(SYNC)).rows[0].changed).toBe(0);
    await client.query("delete from cron.job_run_details where runid = any($1::bigint[])", [[String(id(1000)), String(id(2000))]]);
    await insertRuns("member-messaging-dispatch", [[id(2000), "2 minutes"], [id(3011), "1 minute"]]);
    await setHighWater(id(3011));
    await client.query("savepoint unbounded_reference");
    expect((await client.query(`select ${unboundedMirror}() as changed`)).rows[0].changed).toBe(2);
    const expected = await snapshot();
    await client.query("rollback to savepoint unbounded_reference");
    // Within the hour only 3011 is above the bound. 2000 is in no listed free
    // range; the moved oldest id makes the hourly tick read everything.
    expect((await client.query(SYNC)).rows[0].changed).toBe(1);
    await client.query("update private.cron_job_health_mirror_state set reconciled_at = now() - interval '61 minutes'");
    expect((await client.query(SYNC)).rows[0].changed).toBe(1);
    expect(await snapshot()).toEqual(expected);
    await client.query("rollback to savepoint purged_restart");
  });

  it("keeps the hourly full read due until a restart backlog larger than one batch has drained", async () => {
    // The sequence restarts at 1 and hands out
    // ids through 3012 before the next tick, skipping the retained 3000 and
    // 3010. The hourly full read then has 2,999 runs under the bound, more than
    // one 2,000-run batch. If it recorded itself after the first batch, the
    // bound would return with 999 runs pending and later ticks would let them
    // leave the look-back. Time moves by shifting every timestamp back, and a
    // higher-id run arrives before each tick. Both routines replay the same
    // ticks and must end with the same mirror, nothing left out.
    const id = (n) => BigInt(historyBase) + BigInt(n);
    const shift = async (minutes) => {
      await client.query("update cron.job_run_details set start_time = start_time - $1::interval, end_time = end_time - $1::interval", [`${minutes} minutes`]);
      await client.query(`
        update public.organization_job_runs set started_at = started_at - $1::interval, finished_at = finished_at - $1::interval
        where organization_id is null and run_id like 'cron:%'
      `, [`${minutes} minutes`]);
      await client.query(`
        update private.cron_job_health_mirror_state
        set last_full_read_at = last_full_read_at - $1::interval, reconciled_at = reconciled_at - $1::interval
      `, [`${minutes} minutes`]);
    };
    const fresh = async (n) => {
      await insertRuns("member-messaging-dispatch", [[id(n), "10 seconds"]]);
      await setHighWater(id(n));
    };
    const ticks = [
      { name: "anchor 3000 nine hours ago and newest 3010 a minute ago, no anchor yet", before: async () => {
        await setHighWater(id(3010));
        await insertRuns("member-messaging-dispatch", [[id(3000), "9 hours"], [id(3010), "1 minute"]]);
      } },
      { name: "the free ids up to the anchor are listed", before: async () => {} },
      { name: "restart at 1 through 3012 before the next tick", before: async () => {
        const runs = [];
        for (let n = 1; n <= 3012; n += 1) if (n !== 3000 && n !== 3010) runs.push([id(n), "30 seconds"]);
        await insertRuns("member-messaging-dispatch", runs);
        await setHighWater(id(3012));
      } },
      { name: "61 minutes later: the hourly full read, first batch", before: async () => { await shift(61); await fresh(3013); } },
      { name: "62 minutes: still due, the backlog drains", before: async () => { await shift(1); await fresh(3014); } },
      { name: "63 minutes: bounded again", before: async () => { await shift(1); await fresh(3015); } },
      // The newer runs move the window: from the 121-minute tick it starts
      // after the restart's runs, so any still pending then are lost for good.
      { name: "120 minutes: bounded", before: async () => { await shift(57); await fresh(3016); } },
      { name: "121 minutes: bounded", before: async () => { await shift(1); await fresh(3017); } },
      { name: "123 minutes: the next hourly full read", before: async () => { await shift(2); await fresh(3018); } },
      { name: "124 minutes: bounded again", before: async () => { await shift(1); await fresh(3019); } },
    ];
    const play = async (routine) => {
      await client.query("savepoint restart_backlog");
      await client.query("delete from cron.job_run_details");
      await client.query("delete from public.organization_job_runs where organization_id is null and run_id like 'cron:%'");
      await client.query("delete from private.cron_job_health_mirror_state");
      const changed = [];
      for (const tick of ticks) {
        await tick.before();
        changed.push((await client.query(`select ${routine}() as changed`)).rows[0].changed);
      }
      const { rows } = await client.query(`
        select count(*)::int as n from cron.job_run_details d
        where not exists (select 1 from public.organization_job_runs m
          where m.organization_id is null and m.job_name = 'member-messaging-dispatch' and m.run_id = 'cron:' || d.runid::text)
      `);
      const result = { changed, mirror: await snapshot(), unmirrored: rows[0].n };
      await client.query("rollback to savepoint restart_backlog");
      return result;
    };
    const unbounded = await play(unboundedMirror);
    const bounded = await play("private.sync_organization_job_runs_from_cron_history");
    expect(unbounded.changed).toEqual([2, 0, 2000, 1011, 1, 1, 1, 1, 1, 1]);
    // 11 above the bound at first, then 2,000 and 1,001 while the probe keeps
    // finding runs at free ids and the full read stays due, then bounded and
    // hourly ticks with only the new run each.
    expect(bounded.changed).toEqual([2, 0, 11, 2000, 1001, 1, 1, 1, 1, 1]);
    expect(bounded.unmirrored).toBe(0);
    expect(bounded.mirror).toEqual(unbounded.mirror);
    // Ids 1 to 3012, the two retained among them, and the seven later runs.
    expect(bounded.mirror.runs).toBe(3012 + 7);
  });

  it("keeps a quiet tick's history read the same size when the retained history grows, under generic plans too", async () => {
    await client.query("savepoint growth");
    for (let tick = 0; tick < 4; tick += 1) await client.query(SYNC);
    const tickCost = async () => {
      const before = await cronReads();
      const { rows } = await client.query(SYNC);
      const after = await cronReads();
      expect(rows[0].changed).toBe(0);
      return Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
    };
    const small = await tickCost();
    // 30,000 more runs, three to ten days old, with ids between the oldest
    // history and the recent one.
    await client.query(`
      insert into cron.job_run_details (
        jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time
      )
      select j.jobid, $1::bigint - 30000 + i, 1, current_database(), current_user, 'select 1', 'succeeded', 'proof',
        now() - interval '10 days' + i * interval '20 seconds', now() - interval '10 days' + i * interval '20 seconds' + interval '10 milliseconds'
      from cron.job j cross join generate_series(0, 29999) as i where j.jobname = 'member-messaging-dispatch'
    `, [historyBase]);
    await client.query("analyze cron.job_run_details");
    const large = await tickCost();
    await client.query("set local plan_cache_mode = force_generic_plan");
    const generic = await tickCost();
    await client.query("set local plan_cache_mode = auto");
    for (const cost of [small, large, generic]) {
      expect(cost.seq_scans).toBe(0);
      expect(cost.heap_tuples).toBeLessThan(2000);
      expect(cost.blocks).toBeLessThan(200);
    }
    expect(Math.abs(large.heap_tuples - small.heap_tuples)).toBeLessThan(10);
    expect(Math.abs(generic.heap_tuples - small.heap_tuples)).toBeLessThan(10);
    expect(Math.abs(large.blocks - small.blocks)).toBeLessThan(10);
    await client.query("rollback to savepoint growth");
  });
});
