-- Run after the organization intelligence migration inside a disposable or
-- explicitly rolled-back transaction. No tenant, user, or fixture is created.

do $contract$
begin
  if pg_catalog.has_table_privilege('authenticated', 'public.organization_chart_nodes', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.organization_relationships', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.digital_actions', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.digital_action_participants', 'select') then
    raise exception 'authenticated retained a forbidden direct table grant';
  end if;

  if not pg_catalog.has_function_privilege(
    'authenticated', 'public.get_organization_intelligence_snapshot(text)', 'execute'
  ) or not pg_catalog.has_function_privilege(
    'authenticated', 'public.get_collective_actions(text,integer,integer)', 'execute'
  ) then
    raise exception 'authenticated is missing an exact RPC grant';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'digital_action_participants'
      and policyname = 'mfa_assurance' and permissive = 'RESTRICTIVE'
  ) then
    raise exception 'participant identities are missing restrictive MFA policy';
  end if;
end;
$contract$;

set local role authenticated;

do $contract$
begin
  begin
    perform public.get_organization_intelligence_snapshot('advisor');
    raise exception 'anonymous staff intelligence unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;

  begin
    perform public.get_collective_actions('member');
    raise exception 'anonymous collective actions unexpectedly succeeded';
  exception when insufficient_privilege then
    null;
  end;
end;
$contract$;

reset role;
