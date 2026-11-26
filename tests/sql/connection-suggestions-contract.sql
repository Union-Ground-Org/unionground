-- Run after 20260928103000_chapter_connection_suggestions_backend inside a
-- disposable or explicitly rolled-back transaction. No tenant, user, or
-- fixture is created. tests/connection-suggestions-migration.test.js executes
-- this file against the disposable proof database inside a savepoint.

do $contract$
declare
  private_table text;
  rpc text;
  forced boolean;
begin
  -- Every private table: FORCE row level security, no client privilege at all.
  foreach private_table in array array[
    'private.chapter_connection_registry_epoch',
    'private.chapter_connection_profiles',
    'private.chapter_connection_hides',
    'private.chapter_connection_source_tags',
    'private.chapter_connection_aggregate_runs',
    'private.chapter_connection_issue_aggregates'
  ] loop
    select c.relrowsecurity and c.relforcerowsecurity into forced
    from pg_catalog.pg_class c
    where c.oid = private_table::regclass;
    if not coalesce(forced, false) then
      raise exception '% does not force row level security', private_table;
    end if;
    if pg_catalog.has_table_privilege('authenticated', private_table, 'select, insert, update, delete, truncate, references, trigger')
       or pg_catalog.has_table_privilege('anon', private_table, 'select, insert, update, delete, truncate, references, trigger')
       or pg_catalog.has_table_privilege('service_role', private_table, 'select, insert, update, delete, truncate, references, trigger') then
      raise exception '% retained a forbidden direct table grant', private_table;
    end if;
    if exists (
      select 1 from pg_catalog.pg_policies p
      where p.schemaname || '.' || p.tablename = private_table
    ) then
      raise exception '% carries a policy; the connection tables are definer-only', private_table;
    end if;
  end loop;

  -- Every RPC, by name so a later repair that widens a signature stays
  -- covered: authenticated only.
  for rpc in
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'get_chapter_connection_workspace', 'save_chapter_connection_profile',
        'withdraw_chapter_connection_profile', 'set_chapter_connection_hidden',
        'set_chapter_connection_source_tags', 'freeze_chapter_connection_issue_aggregates',
        'list_chapter_connection_profiles'
      )
  loop
    if not pg_catalog.has_function_privilege('authenticated', rpc, 'execute') then
      raise exception 'authenticated is missing the exact RPC grant on %', rpc;
    end if;
    if pg_catalog.has_function_privilege('anon', rpc, 'execute')
       or pg_catalog.has_function_privilege('service_role', rpc, 'execute') then
      raise exception '% is executable by a role other than authenticated', rpc;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_proc p
      where p.oid = rpc::regprocedure
        and p.prosecdef
        and exists (
          select 1 from pg_catalog.unnest(p.proconfig) as setting
          where setting in ('search_path=', 'search_path=""')
        )
    ) then
      raise exception '% is not a SECURITY DEFINER routine with an empty search_path', rpc;
    end if;
  end loop;

  -- Every private helper: no client execute at all.
  for rpc in
    select p.oid::regprocedure::text
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname like 'chapter_connection_%'
  loop
    if pg_catalog.has_function_privilege('authenticated', rpc, 'execute')
       or pg_catalog.has_function_privilege('anon', rpc, 'execute')
       or pg_catalog.has_function_privilege('service_role', rpc, 'execute') then
      raise exception 'private helper % is executable by a client role', rpc;
    end if;
  end loop;

  -- The registry epoch singleton exists exactly once.
  if (select pg_catalog.count(*) from private.chapter_connection_registry_epoch) <> 1 then
    raise exception 'registry epoch singleton is missing or duplicated';
  end if;

  -- The one auth.users column is reviewed in the account lifecycle manifest,
  -- and every graph table carries its case-graph gate pair. (The schema-wide
  -- inventories themselves are asserted by the migration at apply time; they
  -- take minutes and are not re-run here.)
  if not exists (
    select 1 from private.account_lifecycle_manifest m
    where m.schema_name = 'private'
      and m.table_name = 'chapter_connection_source_tags'
      and m.user_column = 'contributor_user_id'
      and m.delete_disposition = 'cascade'
      and m.export_disposition = 'excluded_with_reason'
  ) then
    raise exception 'source tag contributor column is not reviewed in the lifecycle manifest';
  end if;
  foreach private_table in array array[
    'private.chapter_connection_profiles',
    'private.chapter_connection_hides',
    'private.chapter_connection_source_tags',
    'private.chapter_connection_aggregate_runs',
    'private.chapter_connection_issue_aggregates'
  ] loop
    if (select pg_catalog.count(*) from pg_catalog.pg_trigger t
        where t.tgrelid = private_table::regclass
          and t.tgname in ('a00_case_graph_lock', 'z99_case_graph_keys')) <> 2 then
      raise exception '% is missing its case-graph gate pair', private_table;
    end if;
  end loop;
end;
$contract$;

-- An authenticated session with no JWT claims is refused by every RPC before
-- it can learn anything (authentication required / not authorized, 42501).
set local role authenticated;

do $contract$
begin
  begin
    perform public.get_chapter_connection_workspace('admin');
    raise exception 'anonymous workspace read unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.list_chapter_connection_profiles('admin');
    raise exception 'anonymous registry read unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.save_chapter_connection_profile('admin', 'x', '{}'::jsonb, true);
    raise exception 'anonymous profile save unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.withdraw_chapter_connection_profile('admin', 'x');
    raise exception 'anonymous withdrawal unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.set_chapter_connection_hidden('admin', 'x', 'y', true);
    raise exception 'anonymous hide unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.set_chapter_connection_source_tags('admin', 'x', 'grievance', '00000000-0000-4000-8000-000000000000'::uuid, array['pay']);
    raise exception 'anonymous source tagging unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.freeze_chapter_connection_issue_aggregates('admin', 'x');
    raise exception 'anonymous aggregate freeze unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  -- The private tables are unreachable directly.
  begin
    perform 1 from private.chapter_connection_profiles;
    raise exception 'authenticated read the private profile table directly';
  exception when insufficient_privilege then
    null;
  end;
end;
$contract$;

reset role;
