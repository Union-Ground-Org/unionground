-- SAMPLE desktop chapter rail. The catalog crosses chapter boundaries only
-- for an authenticated member of the isolated union-demo seed lane. A real
-- organization has no private.uniondemo_runs row, so the same function on the
-- SaaS database returns an empty array and cannot widen tenant access.

create function private.sample_chapter_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  sample_run uuid;
  catalog jsonb;
begin
  if caller is null
     or caller_org is null
     or not private.is_organization_member(caller_org) then
    return '[]'::jsonb;
  end if;

  select run.id
  into sample_run
  from private.uniondemo_runs run
  where run.state in ('applied', 'verified')
    and exists (
      select 1
      from private.uniondemo_chapters seeded
      join public.chapters chapter on chapter.id = seeded.chapter_id
      where seeded.run_id = run.id
        and chapter.organization_id = caller_org
    )
  order by run.updated_at desc, run.id
  limit 1;

  if sample_run is null then
    return '[]'::jsonb;
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', chapter.id,
    'name', chapter.name,
    'region', chapter.region,
    'memberCount', (
      select pg_catalog.count(distinct chapter_member.user_id)::integer
      from public.member_chapter_memberships chapter_member
      join public.organization_memberships organization_member
        on organization_member.user_id = chapter_member.user_id
       and organization_member.organization_id = caller_org
       and organization_member.status = 'active'
      where chapter_member.chapter_id = chapter.id
        and chapter_member.status = 'active'
    ),
    'staffCount', (
      select pg_catalog.count(distinct chapter_staff.user_id)::integer
      from public.member_chapter_memberships chapter_staff
      join public.organization_memberships organization_staff
        on organization_staff.user_id = chapter_staff.user_id
       and organization_staff.organization_id = caller_org
       and organization_staff.status = 'active'
      where chapter_staff.chapter_id = chapter.id
        and chapter_staff.status = 'active'
        and private.organization_member_roles(
          chapter_staff.user_id,
          caller_org,
          chapter.id
        ) <> '[]'::jsonb
    )
  ) order by seeded.chapter_index), '[]'::jsonb)
  into catalog
  from private.uniondemo_chapters seeded
  join public.chapters chapter on chapter.id = seeded.chapter_id
  where seeded.run_id = sample_run
    and chapter.organization_id = caller_org;

  return catalog;
end;
$function$;

revoke all on function private.sample_chapter_catalog()
  from public, anon, authenticated, service_role;
grant execute on function private.sample_chapter_catalog()
  to authenticated;

create function public.get_sample_chapter_catalog()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select private.sample_chapter_catalog();
$function$;

revoke all on function public.get_sample_chapter_catalog()
  from public, anon, authenticated, service_role;
grant execute on function public.get_sample_chapter_catalog()
  to authenticated;

comment on function public.get_sample_chapter_catalog() is
  'SAMPLE-only seeded chapter catalog. Returns [] unless the caller belongs to an applied or verified union-demo run; never widens a real tenant.';
