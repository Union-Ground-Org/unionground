-- TEST-UG-ACCOUNT-LIFECYCLE-MANIFEST-DB-PROOF-TIME-TURNS-ON-PG-PROC-STATISTICS-20261112
-- Once pg_catalog.pg_proc has been analyzed (autovacuum on a disposable
-- stack, always on a hosted project), the planner hashed the recursive step's
-- whole function-by-function join before probing it with the few parent rows:
-- about five million reference checks per step, 0.6 s before ANALYZE and
-- 16 s after on a local disposable stack, run by every inventory assertion
-- and about nine times by the account-lifecycle manifest proof. The step now
-- walks a materialized edge list built once from the cached identifiers, so
-- no statistics state can bring that plan back (0.3 s either way). The edges,
-- the reachable set and every returned row and hash are unchanged, and the
-- review hashes stay valid. Hosted application requires its own reviewed,
-- authorized rollout window.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'private.account_lifecycle_trigger_surface()'::regprocedure)
      is distinct from '7e29c70d8e51f23af89ccd5775ca38cc' then
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
  ), edges as materialized (
    -- The same parent-to-child references as before, as one edge list: a
    -- word-named child joins the parent's cached identifiers by equality, and
    -- only the few non-word names keep the original regex.
    select f.oid parent_oid, child.oid child_oid
    from app_functions f
    cross join lateral pg_catalog.unnest(f.referenced_identifiers) as ident(token)
    join app_functions child on child.object_name = ident.token
    where child.object_name ~ '^[[:alnum:]_]+$'
    union
    select f.oid, child.oid
    from app_functions f
    join app_functions child on child.object_name !~ '^[[:alnum:]_]+$'
      and f.prosrc ~ ('\m' || child.object_name || '\M')
  ), reachable(oid) as (
    select f.oid from app_functions f where exists (
      select 1 from roots r where r.function_oid=f.oid
        or (r.kind='rule' and r.definition ~ ('\m' || f.object_name || '\M'))
    )
    union
    select e.child_oid from reachable parent
    join edges e on e.parent_oid=parent.oid
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
