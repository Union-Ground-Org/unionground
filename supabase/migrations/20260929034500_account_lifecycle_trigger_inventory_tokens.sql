-- BUG-UG-ACCOUNT-LIFECYCLE-TRIGGER-INVENTORY-TIMEOUT-20260928
-- Cache lexical identifiers once per function instead of evaluating a regex
-- for every reachable parent/child pair. PostgreSQL word characters are
-- alphanumeric characters and underscore. Comments and literals deliberately
-- remain in the conservative reachability graph. Non-word function names keep
-- the original regex verbatim, including its existing metacharacter semantics.
-- This changes neither review hashes nor the fail-closed inventory assertion.
-- Hosted application requires its own reviewed, authorized rollout window.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'private.account_lifecycle_trigger_surface()'::regprocedure)
      is distinct from '600ef4b345a4c324a350e48dc1228cc8' then
    raise exception 'account lifecycle trigger inventory predecessor changed';
  end if;
end;
$predecessor$;

create or replace function private.account_lifecycle_trigger_surface()
returns table(kind text, schema_name text, table_name text, object_name text, definition_hash text)
language sql stable security definer set search_path = '' as $function$
  with recursive roots as (
    select 'trigger'::text kind, n.nspname::text schema_name, c.relname::text table_name,
      t.tgname::text object_name, t.tgfoid function_oid,
      pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text as definition
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid=t.tgrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname in ('public','private','auth')
    union all
    select 'rule', n.nspname, c.relname, r.rulename, 0::oid,
      pg_catalog.pg_get_ruledef(r.oid) || ':' || r.ev_enabled::text
    from pg_catalog.pg_rewrite r
    join pg_catalog.pg_class c on c.oid=r.ev_class
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where r.rulename <> '_RETURN' and n.nspname in ('public','private','auth')
  ), app_functions as materialized (
    select p.oid, n.nspname::text schema_name, p.proname::text object_name, p.prosrc,
      array(select distinct token[1] from pg_catalog.regexp_matches(p.prosrc, '[[:alnum:]_]+', 'g') token) referenced_identifiers,
      pg_catalog.pg_get_function_identity_arguments(p.oid) arguments,
      pg_catalog.pg_get_functiondef(p.oid) definition
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private','auth') and p.prokind='f'
      and not exists (select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
  ), reachable(oid) as (
    select f.oid from app_functions f where exists (
      select 1 from roots r where r.function_oid=f.oid
        or (r.kind='rule' and r.definition ~ ('\m' || f.object_name || '\M'))
    )
    union
    select child.oid from reachable parent
    join app_functions f on f.oid=parent.oid
    join app_functions child on case when child.object_name ~ '^[[:alnum:]_]+$' then child.object_name = any(f.referenced_identifiers) else f.prosrc ~ ('\m' || child.object_name || '\M') end
  )
  select kind, schema_name, table_name, object_name, pg_catalog.md5(definition) from roots
  union all
  select 'function', f.schema_name, '', f.object_name || '(' || f.arguments || ')', pg_catalog.md5(f.definition)
  from reachable join app_functions f on f.oid=reachable.oid;
$function$;
revoke all on function private.account_lifecycle_trigger_surface() from public, anon, authenticated, service_role;

do $inventory$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;
commit;
