-- PERF-UG-ACCOUNT-LIFECYCLE-CASE-SCOPE-GRANTS-SCAN-20261014
-- Use the same UUID input semantics as the old predicate without rewriting
-- historic authorization inputs. Only the immutable index projection is
-- canonicalized: uppercase, braces and omitted/extra hyphens still match.
-- Invalid UUID inputs continue to fail closed, including during index build.
-- This immutable projection is part of the index definition; changing its
-- semantics requires rebuilding the index.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Refuse to overwrite an intervening or still-unlocked trigger revision.
do $precondition$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'private.capture_account_lifecycle_auth_scope()'::regprocedure)
      is distinct from 'f0e7313967c69e69f8d2b4a51f685548' then
    raise exception 'retained grants migration requires the reviewed capture trigger';
  end if;
end;
$precondition$;

create function private.account_lifecycle_grant_lookup(p_grants jsonb)
returns jsonb language sql immutable parallel safe set search_path = '' as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'grantee_user_id', (g->>'grantee_user_id')::uuid::text)), '[]'::jsonb)
  from pg_catalog.jsonb_array_elements(p_grants) g;
$function$;
revoke all on function private.account_lifecycle_grant_lookup(jsonb) from public, anon, authenticated, service_role;

create index account_lifecycle_case_scope_grants_lookup_idx
  on private.account_lifecycle_case_scope
  using gin (private.account_lifecycle_grant_lookup(grants) jsonb_path_ops);

create or replace function private.capture_account_lifecycle_auth_scope()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare c public.member_cases;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform 1 from public.member_profiles where id = old.id for update;
  update private.account_lifecycle_case_scope set owner_chapter_id =
    (select chapter_id from public.member_profiles where id = old.id)
  where owner_id = old.id;
  for c in select * from public.member_cases where user_id = old.id order by id for update loop
    perform 1 from public.casework_access_grants where case_id = c.id order by id for update;
    insert into private.account_lifecycle_case_scope
    values (c.id, c.organization_id, c.chapter_id, c.user_id,
      (select chapter_id from public.member_profiles where id = old.id),
      c.steward_user_id, c.coordinator_user_id, c.is_restricted, '[]'::jsonb)
    on conflict (case_id) do update set owner_chapter_id = excluded.owner_chapter_id;
  end loop;
  -- Mirror auth FK actions on inputs retained from earlier case deletions.
  -- A later account re-provision using the same UUID must not resurrect an
  -- assignment, owner-self path or cascaded access grant from a former identity.
  update private.account_lifecycle_case_scope retained
  set owner_id = case when retained.owner_id = old.id then null else retained.owner_id end,
      steward_user_id = case when retained.steward_user_id = old.id then null else retained.steward_user_id end,
      coordinator_user_id = case when retained.coordinator_user_id = old.id then null else retained.coordinator_user_id end,
      grants = coalesce((select jsonb_agg(g) from pg_catalog.jsonb_array_elements(retained.grants) g
        where (g->>'grantee_user_id')::uuid is distinct from old.id), '[]'::jsonb)
  where retained.owner_id = old.id or retained.steward_user_id = old.id or retained.coordinator_user_id = old.id
    or private.account_lifecycle_grant_lookup(retained.grants)
      @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('grantee_user_id', old.id::text));
  return old;
end;
$function$;


-- Pin the changed trigger and its new reachable helper, retaining every other
-- review. Read their exact definitions directly rather than traversing the
-- whole application graph just to refresh these two entries.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select 'function', 'private', '', p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
  pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
from pg_catalog.pg_proc p
where p.oid in ('private.capture_account_lifecycle_auth_scope()'::regprocedure,
  'private.account_lifecycle_grant_lookup(jsonb)'::regprocedure)
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

commit;
