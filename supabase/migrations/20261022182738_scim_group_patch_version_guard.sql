-- BUG-UG-SCIM-CONCURRENT-GROUP-PATCH-LOST-MEMBERS-20261020
-- A SCIM group PATCH reads the group (scim_get_group), applies its operations
-- in the API and replaces the whole member set (scim_upsert_group) in a second
-- call. Two concurrent PATCHes could read the same snapshot and both answer
-- 200 while the later replacement dropped the earlier one's member. The write
-- now takes an optional expected version: on a mismatch it changes nothing and
-- answers version_conflict, and the API re-reads and reapplies.
--
-- The new optional argument means a new signature, so the five-argument
-- function is dropped rather than overloaded (an overload would make
-- five-argument PostgREST calls ambiguous). Five-argument calls (POST, PUT and
-- an API deployed before this migration) keep working through the default.
-- The body is otherwise unchanged from 20261003041000; grants move to the new
-- signature. Stamped after every open migration at filing time.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function public.scim_upsert_group(uuid, uuid, text, text, uuid[]);

create function public.scim_upsert_group(
  p_organization_id uuid,
  p_group_id uuid,
  p_display_name text,
  p_external_id text,
  p_members uuid[],
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  group_row public.scim_groups%rowtype;
  clean_name text := null;
  wanted uuid[];
  affected uuid;
  created boolean := false;
begin
  perform private.scim_require_service();
  clean_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  if pg_catalog.char_length(clean_name) not between 1 and 120 or clean_name ~ '[[:cntrl:]]'
     or pg_catalog.cardinality(coalesce(p_members, array[]::uuid[])) > 5000 then
    raise exception 'invalid scim group' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(distinct m), array[]::uuid[]) into wanted
  from pg_catalog.unnest(coalesce(p_members, array[]::uuid[])) m;
  if exists (
    select 1 from pg_catalog.unnest(wanted) m
    where not exists (select 1 from public.scim_users u where u.id = m and u.organization_id = p_organization_id)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'unknown_member');
  end if;
  if p_group_id is null then
    if exists (select 1 from public.scim_groups g
               where g.organization_id = p_organization_id and pg_catalog.lower(g.display_name) = pg_catalog.lower(clean_name)) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    insert into public.scim_groups (organization_id, display_name, external_id)
    values (p_organization_id, clean_name, nullif(pg_catalog.btrim(coalesce(p_external_id, '')), ''))
    returning * into group_row;
    created := true;
  else
    select * into group_row from public.scim_groups g
    where g.id = p_group_id and g.organization_id = p_organization_id
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    -- A PATCH read the group in an earlier call and applied its operations in
    -- the API, so it names the version it read. If another write landed since,
    -- replacing the member set from that snapshot would drop that write's
    -- changes; the caller re-reads and reapplies instead.
    if p_expected_version is not null and group_row.version <> p_expected_version then
      return pg_catalog.jsonb_build_object('outcome', 'version_conflict', 'version', group_row.version);
    end if;
    if exists (select 1 from public.scim_groups g
               where g.organization_id = p_organization_id and pg_catalog.lower(g.display_name) = pg_catalog.lower(clean_name) and g.id <> group_row.id) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    update public.scim_groups
    set display_name = clean_name,
        external_id = nullif(pg_catalog.btrim(coalesce(p_external_id, '')), ''),
        version = version + 1,
        updated_at = pg_catalog.clock_timestamp()
    where id = group_row.id
    returning * into group_row;
  end if;

  for affected in
    select m.user_id from public.scim_group_members m
    where m.group_id = group_row.id and not (m.user_id = any (wanted))
    union
    select w from pg_catalog.unnest(wanted) w
    where not exists (select 1 from public.scim_group_members m where m.group_id = group_row.id and m.user_id = w)
  loop
    if affected = any (wanted) then
      insert into public.scim_group_members (group_id, user_id, organization_id)
      values (group_row.id, affected, p_organization_id)
      on conflict do nothing;
    else
      delete from public.scim_group_members where group_id = group_row.id and user_id = affected;
    end if;
    if group_row.mapped_role is not null and exists (
      select 1 from public.scim_users u where u.id = affected and u.provisioning_state = 'invited' and u.active
    ) then
      perform private.scim_reconcile_user(affected, null);
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', case when created then 'created' else 'updated' end,
    'group', private.scim_group_json(group_row, true));
end;
end;
$function$;

revoke all on function public.scim_upsert_group(uuid, uuid, text, text, uuid[], integer) from public, anon, authenticated, service_role;
grant execute on function public.scim_upsert_group(uuid, uuid, text, text, uuid[], integer) to service_role;

commit;
