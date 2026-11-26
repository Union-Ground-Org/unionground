-- Keep the SAMPLE chapter catalog bounded when the seeded organization carries
-- tens of thousands of memberships. The original projection called a JSON role
-- helper once for every chapter member; this replacement resolves the same
-- organization-wide and chapter-scoped role sets in two set-based joins.

set local lock_timeout = '5s';

create or replace function private.sample_chapter_catalog()
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

  with seeded_chapters as materialized (
    select
      seeded.chapter_index,
      chapter.id,
      chapter.name,
      chapter.region
    from private.uniondemo_chapters seeded
    join public.chapters chapter on chapter.id = seeded.chapter_id
    where seeded.run_id = sample_run
      and chapter.organization_id = caller_org
  ),
  active_chapter_members as materialized (
    select
      chapter_member.chapter_id,
      chapter_member.user_id
    from public.member_chapter_memberships chapter_member
    join seeded_chapters chapter on chapter.id = chapter_member.chapter_id
    join public.organization_memberships organization_member
      on organization_member.user_id = chapter_member.user_id
     and organization_member.organization_id = caller_org
     and organization_member.status = 'active'
    where chapter_member.status = 'active'
  ),
  member_counts as (
    select member.chapter_id, pg_catalog.count(*)::integer as member_count
    from active_chapter_members member
    group by member.chapter_id
  ),
  staff_members as (
    select member.chapter_id, member.user_id
    from active_chapter_members member
    join public.organization_role_grants role_grant
      on role_grant.organization_id = caller_org
     and role_grant.user_id = member.user_id
    union
    select member.chapter_id, member.user_id
    from active_chapter_members member
    join public.member_role_chapters chapter_role
      on chapter_role.user_id = member.user_id
     and chapter_role.chapter_id = member.chapter_id
  ),
  staff_counts as (
    select staff.chapter_id, pg_catalog.count(*)::integer as staff_count
    from staff_members staff
    group by staff.chapter_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', chapter.id,
    'name', chapter.name,
    'region', chapter.region,
    'memberCount', coalesce(member_count.member_count, 0),
    'staffCount', coalesce(staff_count.staff_count, 0)
  ) order by chapter.chapter_index), '[]'::jsonb)
  into catalog
  from seeded_chapters chapter
  left join member_counts member_count on member_count.chapter_id = chapter.id
  left join staff_counts staff_count on staff_count.chapter_id = chapter.id;

  return catalog;
end;
$function$;

revoke all on function private.sample_chapter_catalog()
  from public, anon, authenticated, service_role;
grant execute on function private.sample_chapter_catalog()
  to authenticated;

comment on function private.sample_chapter_catalog() is
  'Tenant-gated SAMPLE chapter catalog with set-based member and staff aggregates.';
