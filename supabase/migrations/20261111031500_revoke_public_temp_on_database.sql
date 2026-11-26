-- SEC-UG-PG-NET-PUBLIC-WRITE-TRIGGER-ESCALATION-20261110 (#8015), partial.
-- supabase_admin owns net.http_request_queue and net._http_response and grants
-- PUBLIC every right on them, TRIGGER included. Any login could therefore attach
-- a trigger whose function lives in its own temporary schema, and the function
-- then ran as postgres on the next queue insert (cron dispatch jobs, the pg_net
-- worker). postgres cannot revoke supabase_admin's grants, but it owns the
-- database, so it can take TEMP away from PUBLIC. That closes the
-- temporary-function path for every role that is not granted TEMP back here.
--
-- TEMP goes back to every role that holds it today, except ci_drift_reader.
-- Migrations cannot run assembled SQL, so the grants are static and guarded by
-- role existence, and the block refuses to commit if any role that had TEMP
-- before would lose it. A hosted role this list does not name stops the apply
-- with its name, rather than losing TEMP silently.
--
-- Still open, and only supabase_admin can close it: a role that can connect
-- keeps TRIGGER on the net tables. It can attach a built-in pg_catalog trigger
-- function with a WHEN clause that runs SQL, and that clause runs as postgres.
-- The support request on #8015 asks supabase_admin to revoke PUBLIC's TRIGGER
-- and write rights on the net tables and PUBLIC USAGE on schema net. The only
-- login we control that can reach the hole is ci_drift_reader; its CONNECT is
-- unchanged (ruling, Nov 10, 2026, 10:09 PM ET).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $public_temp$
declare
  holders pg_catalog.text[];
  lost pg_catalog.text[];
begin
  if pg_catalog.current_database() <> 'postgres' then
    raise exception 'expected database postgres, found %', pg_catalog.current_database();
  end if;

  select pg_catalog.array_agg(r.rolname::pg_catalog.text order by r.rolname)
    into holders
    from pg_catalog.pg_roles r
   where r.rolname !~ '^pg_'
     and not r.rolsuper
     and r.rolname <> 'ci_drift_reader'
     and pg_catalog.has_database_privilege(r.oid, 'postgres', 'TEMPORARY');

  grant temporary on database postgres to postgres;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    grant temporary on database postgres to anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    grant temporary on database postgres to authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant temporary on database postgres to service_role;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then
    grant temporary on database postgres to authenticator;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'dashboard_user') then
    grant temporary on database postgres to dashboard_user;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'pgbouncer') then
    grant temporary on database postgres to pgbouncer;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_auth_admin') then
    grant temporary on database postgres to supabase_auth_admin;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_etl_admin') then
    grant temporary on database postgres to supabase_etl_admin;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_functions_admin') then
    grant temporary on database postgres to supabase_functions_admin;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_privileged_role') then
    grant temporary on database postgres to supabase_privileged_role;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_read_only_user') then
    grant temporary on database postgres to supabase_read_only_user;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_realtime_admin') then
    grant temporary on database postgres to supabase_realtime_admin;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_replication_admin') then
    grant temporary on database postgres to supabase_replication_admin;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_storage_admin') then
    grant temporary on database postgres to supabase_storage_admin;
  end if;

  revoke temporary on database postgres from public;

  if exists (
    select 1
      from pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a
     where d.datname = 'postgres' and a.grantee = 0 and a.privilege_type = 'TEMPORARY'
  ) then
    raise exception 'PUBLIC still holds TEMPORARY on database postgres';
  end if;

  select pg_catalog.array_agg(h order by h)
    into lost
    from pg_catalog.unnest(holders) h
   where not pg_catalog.has_database_privilege(h, 'postgres', 'TEMPORARY');
  if lost is not null then
    raise exception 'these roles would lose TEMPORARY on database postgres: %', lost;
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'ci_drift_reader')
     and pg_catalog.has_database_privilege('ci_drift_reader', 'postgres', 'TEMPORARY') then
    raise exception 'ci_drift_reader still holds TEMPORARY on database postgres';
  end if;
end
$public_temp$;

commit;
