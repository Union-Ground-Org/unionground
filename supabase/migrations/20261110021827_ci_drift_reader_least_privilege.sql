-- SEC-UG-CI-DRIFT-READER-CRON-READ-VIEW-20261109 (#7872; review X7-S1).
-- ci_drift_reader is the Production login behind the production-db
-- environment's SUPABASE_DB_URL (created Nov 9, 2026 outside the migrations).
-- It held BYPASSRLS and USAGE on the cron schema so
-- scripts/verify-db-contract.mjs could read every cron.job row, and SET
-- membership in authenticated so the task-comment null-caller probe could
-- switch to it. Together they let code holding the secret open a read-write
-- transaction and schedule cron jobs, delete cron.job_run_details rows, or act
-- as authenticated; default_transaction_read_only is a session default, not a
-- privilege boundary.
--
-- This migration gives the contract check the cron columns it compares through
-- one definer function, then removes all three.
--
-- Review finding: the reader keeps USAGE on schema private and PostgreSQL's
-- default PUBLIC TEMP, so it could attach a PUBLIC-executable definer trigger
-- (private.award_member_points) to its own temporary table and make an implicit
-- cast of its own run as the trigger's owner. Every SECURITY DEFINER function
-- the reader could execute was measured on a disposable replay: that trigger and
-- private.member_receipt_code(), both in knownGaps.publicExecuteOnPrivateFunctions.
-- Neither needs a client grant (a trigger fires without EXECUTE; the receipt
-- code is called only by the definer private.issue_ballot_receipt), so both
-- lose PUBLIC and client EXECUTE, and the role block below refuses to commit
-- if the reader can still execute any definer function but the drift read.
--
-- The role exists only on Production: on a local, SAMPLE or disposable database the role block below
-- does nothing, and the function is created with no grant at all. Re-running
-- it is harmless. Where the role exists, the block raises instead of
-- committing if BYPASSRLS, cron USAGE or any role membership survives (for
-- example a membership granted by another grantor, which REVOKE would only
-- warn about).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- The cron.job columns verify-db-contract.mjs compares. Owned by postgres, it
-- reads the jobs postgres sees; it returns metadata only and changes nothing.
-- Gate r1s1: the body names no type. With search_path = '' PostgreSQL still
-- resolves an unqualified type name in the session's temporary schema first, so
-- a caller holding TEMP could plant pg_temp.text as a domain whose CHECK would
-- run as this function's owner. The cron.job columns are already text and
-- boolean, so the body needs no cast; the return types are resolved once, here,
-- and written schema-qualified.
create or replace function private.ci_drift_cron_jobs()
returns table (jobname pg_catalog.text, schedule pg_catalog.text, active pg_catalog.bool, command pg_catalog.text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select j.jobname, j.schedule, j.active, j.command
    from cron.job j
   order by j.jobname, j.jobid
$fn$;

revoke all on function private.ci_drift_cron_jobs() from public, anon, authenticated, service_role;
-- Union Ground dropped private.award_member_points() with the points economy
-- (20261014003000); revoke only where it still exists.
do $award_points_revoke$
begin
  if pg_catalog.to_regprocedure('private.award_member_points()') is not null then
    revoke all on function private.award_member_points() from public, anon, authenticated, service_role;
  end if;
end;
$award_points_revoke$;
revoke all on function private.member_receipt_code() from public, anon, authenticated, service_role;

do $drift_reader$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ci_drift_reader') then
    return;
  end if;

  alter role ci_drift_reader nobypassrls;
  revoke usage on schema cron from ci_drift_reader;
  revoke authenticated from ci_drift_reader;
  -- On a function ALL is exactly EXECUTE; spelled ALL because the conventions
  -- check reads an "execute" token in a DO body as dynamic SQL.
  grant all on function private.ci_drift_cron_jobs() to ci_drift_reader;

  if (select r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = 'ci_drift_reader') then
    raise exception 'ci_drift_reader still has BYPASSRLS';
  end if;
  if pg_catalog.has_schema_privilege('ci_drift_reader', 'cron', 'USAGE') then
    raise exception 'ci_drift_reader still has USAGE on schema cron';
  end if;
  if exists (
    select 1 from pg_catalog.pg_auth_members m
     where m.member = (select r.oid from pg_catalog.pg_roles r where r.rolname = 'ci_drift_reader')
  ) then
    raise exception 'ci_drift_reader is still a member of another role';
  end if;
  if not pg_catalog.has_function_privilege('ci_drift_reader', 'private.ci_drift_cron_jobs()', 'EXECUTE') then
    raise exception 'ci_drift_reader cannot execute private.ci_drift_cron_jobs()';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef
       and p.oid <> 'private.ci_drift_cron_jobs()'::pg_catalog.regprocedure
       and pg_catalog.has_schema_privilege('ci_drift_reader', n.oid, 'USAGE')
       and pg_catalog.has_function_privilege('ci_drift_reader', p.oid, 'EXECUTE')
  ) then
    raise exception 'ci_drift_reader can still execute a SECURITY DEFINER function other than private.ci_drift_cron_jobs()';
  end if;
end
$drift_reader$;

commit;
