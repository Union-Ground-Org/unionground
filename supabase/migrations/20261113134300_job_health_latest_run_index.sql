-- BUG-UG-ADMIN-JOB-HEALTH-READ-EXCEEDS-STATEMENT-TIMEOUT-20261115 (#8916)
--
-- public.list_organization_job_health() (20261109225800) finds each monitored
-- job's latest run with a LATERAL
--   where run.job_name = catalog.job_name
--     and (run.organization_id is null or run.organization_id = org)
--   order by run.started_at desc limit 1
-- No index orders a job's runs by started_at: the only index that leads with
-- job_name is the (job_name, run_id, organization_id) unique key, so each of
-- the 40 lookups read and sorted that job's whole history. On Production
-- (552k rows, 181 MB of real scheduled-job history) the read took 8.07 s
-- against the authenticated role's 8 s statement_timeout and the admin Job
-- health page failed. With (job_name, started_at desc) each lookup descends
-- the index for its job and stops at the first row that passes the
-- organization filter, so the cost no longer grows with the table.
--
-- The function is not restated: its LATERAL already has the shape this index
-- serves. No routine, grant, policy, constraint or row changes here.
--
-- LIVE APPLY (Production): before this migration is applied, build the index
-- concurrently on a direct connection, outside any transaction, as its own
-- statement:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS organization_job_runs_job_latest_idx
--     ON public.organization_job_runs (job_name, started_at DESC);
-- then require pg_index.indisvalid and indisready for that exact name and
-- definition; IF NOT EXISTS alone cannot validate an existing same-name index,
-- and an invalid one is dropped (DROP INDEX CONCURRENTLY) and rebuilt by hand.
-- CONCURRENTLY cannot run inside a transaction block, so the migration below
-- keeps the one-transaction convention of 20261014170000: an ordinary CREATE
-- INDEX takes a SHARE lock and blocks writers (the scheduled jobs that record
-- their runs every minute) for the length of the build. After the concurrent
-- pre-build the hosted migration is a no-op; on SAMPLE and disposable stacks it
-- is a bounded plain build. lock_timeout caps the wait for the SHARE lock so
-- writers never queue behind a long wait; statement_timeout caps the build.
begin;
set local lock_timeout = '1s';
set local statement_timeout = '60s';

create index if not exists organization_job_runs_job_latest_idx
  on public.organization_job_runs (job_name, started_at desc);

commit;
