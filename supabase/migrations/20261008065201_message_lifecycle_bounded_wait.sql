begin;

-- Bound admission to the existing global lifecycle gate. Do not replace it
-- with per-tenant locks: direct statements, nested writers and account deletion
-- can discover further Auth/case keys only after admission. The gate remains
-- exclusive and transaction-scoped, ahead of the unchanged case-graph gate.
create or replace function private.lock_message_lifecycle()
returns void language plpgsql volatile security definer set search_path = ''
as $function$
declare previous_lock_timeout text;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'message preservation requires read committed isolation' using errcode = '40001';
  end if;
  previous_lock_timeout := pg_catalog.current_setting('lock_timeout');
  if previous_lock_timeout::interval = interval '0 seconds'
     or previous_lock_timeout::interval > interval '3 seconds' then
    perform pg_catalog.set_config('lock_timeout', '3s', true);
  end if;
  -- Let 55P03 abort the write; the client already renders the busy message.
  -- An error rolls back the local setting with the failed statement/subtransaction.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message-lifecycle-global', 0));
  perform pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
end;
$function$;
revoke all on function private.lock_message_lifecycle() from public, anon, authenticated, service_role;

-- The helper is reachable from the reviewed lifecycle trigger graph. Refresh
-- only this explicitly replaced function, never a snapshot of other entries.
do $review$
declare reviewed integer;
begin
  update private.account_lifecycle_trigger_review
     set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef('private.lock_message_lifecycle()'::regprocedure))
   where kind = 'function' and schema_name = 'private' and table_name = ''
     and object_name = 'lock_message_lifecycle()';
  get diagnostics reviewed = row_count;
  if reviewed <> 1 then
    raise exception 'missing reviewed lifecycle lock helper';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$review$;

commit;
