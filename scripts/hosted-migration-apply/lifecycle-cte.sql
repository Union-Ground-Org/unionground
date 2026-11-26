with inlined_surface(kind,schema_name,table_name,object_name,definition_hash) as materialized (
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
  from reachable join app_functions f on f.oid=reachable.oid
),
inlined_issues(schema_name,table_name,trigger_name,inventory_issue) as materialized (
select coalesce(c.schema_name,r.schema_name), coalesce(c.table_name,r.table_name),
    coalesce(c.object_name,r.object_name), 'unreviewed-referential-action-trigger'::text
  from inlined_surface c
  full join private.account_lifecycle_trigger_review r
    on r.kind=c.kind and r.schema_name=c.schema_name and r.table_name=c.table_name and r.object_name=c.object_name
  where c.definition_hash is distinct from r.definition_hash
)
