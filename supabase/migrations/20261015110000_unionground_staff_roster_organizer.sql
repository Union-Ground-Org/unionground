-- Union Ground: the Organizer hat on the staff roster and in the admin
-- role counts.
--
-- Organizers hold the internal role id 'organizer' in
-- public.member_role_chapters (20261014001000 widened the chapter-role checks
-- and public.set_member_chapter_role to accept it). They see who signed cards,
-- so they are staff for every purpose that protects that data:
--
--   * Staff roster. public.get_staff_roster() lists everyone for whom
--     private.organization_member_roles() returns a role, and that helper
--     reads every member_role_chapters row whatever its role id, so an
--     Organizer with an active chapter and organization membership is already
--     listed with roles ["organizer"]. The function is not redefined here;
--     tests/unionground-staff-roster-db.test.js pins the listing.
--   * Admin role counts. public.get_admin_org_structure() counted five named
--     roles (steward, coordinator, advisor, admin, vp). Organizers were part
--     of staffCount but had no roleCounts entry, so the admin overview could
--     not show how many Organizers a campaign has. It gains an 'organizer'
--     count below; everything else is the installed single-pass definition
--     from 20260918070000 unchanged.
--   * Staff two-step sign-in stays required. Lifecycle writers authorize
--     through private.member_has_chapter_role(), which refuses a role holder
--     without a second factor while the organization requires staff MFA, and
--     public.get_staff_mfa_standing() treats any member_role_chapters row,
--     'organizer' included, as a staff hat, so an Organizer is told to enroll
--     instead of being silently refused. Neither function changes here.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.get_admin_org_structure()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  chapters_json jsonb;
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  with scoped_chapter as (
    select c.id, c.name, c.region, c.is_default, c.order_index
    from public.chapters c
    where c.organization_id = caller_org
      and (org_admin or c.id = caller_chapter)
  ),
  active_member as (
    -- One row per active chapter membership whose holder is an active member
    -- of the caller's organization: the population every count is drawn from.
    select cm.chapter_id, cm.user_id
    from public.member_chapter_memberships cm
    join scoped_chapter sc on sc.id = cm.chapter_id
    join public.organization_memberships om
      on om.user_id = cm.user_id
     and om.organization_id = caller_org
     and om.status = 'active'
    where cm.status = 'active'
  ),
  member_role as (
    -- Organization-wide grants apply in every chapter; chapter roles apply in
    -- the chapter they name. Mirrors private.organization_member_roles().
    select am.chapter_id, am.user_id, g.role
    from active_member am
    join public.organization_role_grants g
      on g.user_id = am.user_id
     and g.organization_id = caller_org
    union
    select am.chapter_id, am.user_id, rc.role
    from active_member am
    join public.member_role_chapters rc
      on rc.user_id = am.user_id
     and rc.chapter_id = am.chapter_id
  ),
  chapter_count as (
    select sc.id,
      (select pg_catalog.count(distinct am.user_id)::integer from active_member am where am.chapter_id = sc.id) as member_count,
      (select pg_catalog.count(distinct mr.user_id)::integer from member_role mr where mr.chapter_id = sc.id) as staff_count,
      (select pg_catalog.count(distinct mr.user_id)::integer from member_role mr where mr.chapter_id = sc.id and mr.role = 'steward') as steward_count,
      (select pg_catalog.count(distinct mr.user_id)::integer from member_role mr where mr.chapter_id = sc.id and mr.role = 'organizer') as organizer_count,
      (select pg_catalog.count(distinct mr.user_id)::integer from member_role mr where mr.chapter_id = sc.id and mr.role = 'coordinator') as coordinator_count,
      (select pg_catalog.count(distinct mr.user_id)::integer from member_role mr where mr.chapter_id = sc.id and mr.role = 'advisor') as advisor_count,
      (select pg_catalog.count(distinct mr.user_id)::integer from member_role mr where mr.chapter_id = sc.id and mr.role = 'admin') as admin_count,
      (select pg_catalog.count(distinct mr.user_id)::integer from member_role mr where mr.chapter_id = sc.id and mr.role = 'vp') as vp_count
    from scoped_chapter sc
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', sc.id,
    'name', sc.name,
    'region', sc.region,
    'isDefault', sc.is_default,
    'orderIndex', sc.order_index,
    'memberCount', cc.member_count,
    'staffCount', cc.staff_count,
    'roleCounts', pg_catalog.jsonb_build_object(
      'steward', cc.steward_count,
      'organizer', cc.organizer_count,
      'coordinator', cc.coordinator_count,
      'advisor', cc.advisor_count,
      'admin', cc.admin_count,
      'vp', cc.vp_count
    )
  ) order by sc.order_index, sc.name, sc.id), '[]'::jsonb)
  into chapters_json
  from scoped_chapter sc
  join chapter_count cc on cc.id = sc.id;

  return pg_catalog.jsonb_build_object(
    'scope', case when org_admin then 'organization' else 'chapter' end,
    'chapterId', case when org_admin then null else caller_chapter end,
    'canCreateChapter', org_admin,
    'chapters', chapters_json
  );
end;
$function$;

revoke all on function public.get_admin_org_structure()
  from public, anon, authenticated;
grant execute on function public.get_admin_org_structure()
  to authenticated;

notify pgrst, 'reload schema';
commit;
