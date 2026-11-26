-- SEC-UG-NATIVE-LEADER-GATES-USE-TEN-WHERE-THE-ORGANIZATION-FLOOR-IS-25-20261115 (#8768).
--
-- The organization privacy floor for aggregate reads is at least 25 people
-- (20261104073000_privacy_floor_25_server_side.sql), but the phone's leader
-- screens decided what to show with a fixed ten, and the one server count
-- built for them, public.get_admin_chapter_form_states, withheld only below
-- ten. A leader on the phone could see figures for a group of 10 to 24 that
-- the web withholds. The decision (Sun Nov 15, 2026): the phone follows the organization
-- floor everywhere, as the web does.
--
--   1. public.get_my_mobile_staff_scope, which the phone reads before and
--      after every leader screen load, also returns the selected
--      organization's privacyFloor (limits.analytics.anonymity_floor) and
--      chapterHealthFloor (limits.analytics.chapter_health_cohort_floor),
--      both through private.organization_limit, which never returns less
--      than 25. With no selected organization both are null and the phone
--      withholds every figure. Everything else in the body is unchanged
--      from 20260902050000.
--   2. public.get_admin_chapter_form_states withholds the whole result when
--      any state has fewer different people than the chapter organization's
--      anonymity floor, in place of the fixed ten. Authority checks, the
--      latest-100 window and the result shape are unchanged from
--      20261110074159.
--
-- No grant, policy or table changes: create or replace keeps both
-- functions' existing EXECUTE grants.
--
-- Apply order: after 20261113135000; it depends on no migration after
-- 20261110074159.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the predecessors so a concurrent change is not lost.
do $assert_native_leader_floor_predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_my_mobile_staff_scope()'::pg_catalog.regprocedure))
      <> '198bd9ddcde4f856e5d2c2057fa9c98c' then
    raise exception 'Unreviewed native staff scope predecessor: integrate current Main before reporting the organization floor';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_admin_chapter_form_states(text)'::pg_catalog.regprocedure))
      <> '2b631719fb46ddabea1a1ea0e5600b45' then
    raise exception 'Unreviewed admin form states predecessor: integrate current Main before applying the organization floor';
  end if;
end;
$assert_native_leader_floor_predecessors$;

-- 1. The native staff scope reports the organization floors.
create or replace function public.get_my_mobile_staff_scope()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  selected_organization_id uuid := private.current_mobile_staff_organization();
  selected_chapter_id text := private.current_member_chapter();
  roles jsonb := '[]'::jsonb;
  chapter_roles jsonb := '[]'::jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authenticated session required' using errcode = '42501';
  end if;
  if (
       (
         selected_organization_id is not null
         and private.staff_mfa_required(selected_organization_id)
       )
       or (
         selected_organization_id is null
         and private.staff_mfa_required()
       )
     )
     and not private.has_second_factor(caller) then
    return pg_catalog.jsonb_build_object(
      'organizationId', selected_organization_id,
      'roles', roles,
      'chapterRoles', chapter_roles,
      'staffAuthorized', false
    );
  end if;
  select coalesce(pg_catalog.jsonb_agg(role_grant.role order by role_grant.role), '[]'::jsonb)
  into roles
  from public.organization_role_grants role_grant
  join public.organization_memberships membership
    on membership.organization_id = role_grant.organization_id
   and membership.user_id = role_grant.user_id
   and membership.status = 'active'
  where role_grant.organization_id = selected_organization_id
    and role_grant.user_id = caller;

  -- Chapter roles remain valid for active legacy chapters that predate the
  -- organization model. For organization-backed chapters, bind the selected
  -- chapter to the same active organization resolved above.
  select coalesce(pg_catalog.jsonb_agg(role_chapter.role order by role_chapter.role), '[]'::jsonb)
  into chapter_roles
  from public.member_role_chapters role_chapter
  join public.member_chapter_memberships membership
    on membership.user_id = role_chapter.user_id
   and membership.chapter_id = role_chapter.chapter_id
   and membership.status = 'active'
  join public.chapters chapter
    on chapter.id = role_chapter.chapter_id
  left join public.organizations organization
    on organization.id = chapter.organization_id
  where role_chapter.user_id = caller
    and role_chapter.chapter_id = selected_chapter_id
    and (
      (chapter.organization_id is null and selected_organization_id is null)
      or (
        chapter.organization_id = selected_organization_id
        and organization.status = 'active'
      )
    );

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'roles', roles,
    'chapterRoles', chapter_roles,
    'staffAuthorized', (
      pg_catalog.jsonb_array_length(roles) > 0
      or pg_catalog.jsonb_array_length(chapter_roles) > 0
    ),
    -- The floors the server holds for this organization's aggregates, so the
    -- phone's leader screens withhold exactly what the web withholds. No
    -- organization, no floor: the phone then withholds every figure.
    'privacyFloor', case when selected_organization_id is not null
      then private.organization_limit(selected_organization_id, 'limits.analytics.anonymity_floor') end,
    'chapterHealthFloor', case when selected_organization_id is not null
      then private.organization_limit(selected_organization_id, 'limits.analytics.chapter_health_cohort_floor') end
  );
end;
$function$;

-- 2. The admin Pulse form-state count withholds below the organization floor.
create or replace function public.get_admin_chapter_form_states(p_chapter_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  chapter_org uuid;
  privacy_floor integer;
  small_state boolean;
  states jsonb;
begin
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select c.organization_id into chapter_org from public.chapters c where c.id = p_chapter_id;
  -- One refusal for a chapter that does not exist, sits in another or the
  -- platform organization, or that the caller does not administer.
  if chapter_org is null
     or chapter_org is distinct from private.current_member_organization()
     or not private.organization_is_union(chapter_org)
     or (private.staff_mfa_required(chapter_org) and not private.has_second_factor(caller))
     or not (private.has_organization_role(chapter_org, array['admin'])
       or private.member_has_chapter_role(p_chapter_id, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  privacy_floor := private.organization_limit(chapter_org, 'limits.analytics.anonymity_floor');
  with latest as (
    select f.status, f.user_id
    from public.member_forms f
    join public.member_profiles p on p.id = f.user_id
    where p.chapter_id = p_chapter_id
    order by f.updated_at desc, f.id
    limit 100
  ), grouped as (
    select l.status, pg_catalog.count(*)::integer as forms, pg_catalog.count(distinct l.user_id)::integer as people
    from latest l
    group by l.status
  )
  select coalesce(pg_catalog.bool_or(g.people < privacy_floor), false),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('status', g.status, 'count', g.forms) order by g.status), '[]'::jsonb)
  into small_state, states
  from grouped g;
  if small_state or privacy_floor is null then
    return pg_catalog.jsonb_build_object('withheld', true, 'states', null);
  end if;
  return pg_catalog.jsonb_build_object('withheld', false, 'states', states);
end;
$function$;
comment on function public.get_admin_chapter_form_states(text) is
  'SEC-UG-NATIVE-LEADER-GATES-USE-TEN-WHERE-THE-ORGANIZATION-FLOOR-IS-25-20261115: the admin Pulse Forms card. Latest 100 forms of the chapter''s current members counted by state; withheld whole when any state has fewer different people than the organization anonymity floor (never below 25). States and counts only.';

commit;
