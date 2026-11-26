-- #9533: Advisor Chapter health uses active chapter and organization
-- memberships for its coverage numerator, as Admin's chapter roster does.
-- Preserve scoped caller visibility, ownerless legacy behavior and all other
-- counts, return keys, function settings and grants.

begin;

set local lock_timeout = '5s';

do $predecessors$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_advisor_overview()'::regprocedure)
     is distinct from 'b3d67ef5d57d82f738b4744bc69c88d0' then
    raise exception 'unreviewed predecessor: public.get_advisor_overview()' using errcode = '55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION public.get_advisor_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid := private.current_member_organization();
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
  mfa_ok boolean := false;
  mobile_org uuid;
  elevated_org uuid;
  chapter_coverage_open boolean := false;
  caller_has_scopes boolean := false;
  staff_chapters text[] := '{}'::text[];
  coordinator_ids uuid[] := '{}'::uuid[];
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The selected workspace, never a NULL legacy role row, sets the scope.
  -- Keep an explicitly selected ownerless legacy chapter isolated as well.
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null or not exists (
    select 1 from public.chapters chapter where chapter.id = caller_chapter
      and chapter.organization_id is not distinct from caller_org
  ) then
    raise exception 'organization or legacy chapter required' using errcode = '42501';
  end if;

  -- Caller-constant half of the staff case read. SQL CASE below stops before
  -- the coordinator and grievance branches when an elevated organization role
  -- already admits the row, which is the desk that was paying once per case.
  mfa_ok := private.mfa_satisfied();
  mobile_org := private.current_mobile_staff_organization();
  if mobile_org is not null
    and private.has_organization_role(mobile_org, array['advisor', 'admin', 'vp']) then
    elevated_org := mobile_org;
  end if;
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );
  select coalesce(pg_catalog.array_agg(chapter.id), '{}'::text[])
    into staff_chapters
  from public.chapters chapter
  where private.actor_has_chapter_staff_role(caller, chapter.id);
  select coalesce(pg_catalog.array_agg(visible.id), '{}'::uuid[])
    into coordinator_ids
  from private.staff_visible_member_ids('coordinator') visible(id);

  if caller_org is null then
    -- Retained ownerless chapters have no organization membership to join.
    select pg_catalog.count(*)
    into members_covered
    from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
    where p.chapter_id = caller_chapter
      and not private.chapter_belongs_to_platform(p.chapter_id);
  else
    -- The owned chapter roster uses the same active memberships as Admin.
    -- Full coverage opens for an elevated organization advisor, admin or vp
    -- admitted by the outer advisor/admin role check, or for an unscoped
    -- advisor or admin in the selected chapter. This includes active secondary
    -- memberships. A scoped caller counts only their own and visible members.
    chapter_coverage_open := coalesce(elevated_org = caller_org, false)
      or private.member_has_chapter_role(caller_chapter, array['advisor','admin']);
    select pg_catalog.count(distinct membership.user_id)
    into members_covered
    from public.member_chapter_memberships membership
    join public.organization_memberships organization_membership
      on organization_membership.user_id = membership.user_id
     and organization_membership.organization_id = caller_org
     and organization_membership.status = 'active'
    where membership.chapter_id = caller_chapter
      and membership.status = 'active'
      and (
        membership.user_id = caller
        or chapter_coverage_open
        or membership.user_id in (
          select private.staff_visible_member_ids(readable_role)
          from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role
        )
      );
  end if;

  with base as materialized (
    select c.status, c.deadline, c.time_zone
    from public.member_cases c
    join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
    where c.organization_id is not distinct from caller_org
      and c.chapter_id = caller_chapter
      and not private.organization_is_platform(c.organization_id)
      and (
        (c.organization_id is null and caller_org is null)
        or (
          c.learning_undone_at is null
          and mfa_ok
          and case
            when c.user_id = caller then true
            when c.organization_id is not null
              and c.chapter_id is not null
              and case
                when c.user_id = caller then true
                when not caller_has_scopes
                  and not exists (
                    select 1 from private.case_identity_privacy privacy
                    where privacy.case_id = c.id
                  )
                  then true
                else private.actor_case_scope_and_identity_allowed(caller, c)
              end
              and case
                when c.chapter_id = any (staff_chapters)
                  and (
                    c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or c.user_id = any (coordinator_ids)
                  )
                  and (
                    not c.is_restricted
                    or c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                when c.organization_id = caller_org
                  and private.actor_role_covers_member(caller, c.chapter_id, 'coordinator', c.user_id, true)
                  and (
                    not c.is_restricted
                    or c.coordinator_user_id = caller
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                else false
              end
              then true
            when c.user_id <> caller
              and not c.is_restricted
              and c.organization_id = caller_org
              and coalesce((select policy.steward_grievances from private.chapter_access_policies policy where policy.chapter_id = c.chapter_id), true)
              and private.chapter_grievance_steward_scope(c.chapter_id, c.user_id)
              and private.member_case_row_visible(c)
              then true
            else false
          end
        )
      )
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < private.local_day(b.time_zone, pg_catalog.now()))
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- Resolve chapter and organization grants through the same live scope
  -- projection as the staff roster. Membership in a second tenant never
  -- transfers a steward grant there.
  if caller_org is not null then
    select pg_catalog.count(*) into steward_count
    from public.organization_memberships membership
    where membership.organization_id = caller_org and membership.status = 'active'
      and private.organization_member_roles(membership.user_id, caller_org, caller_chapter) @> '["steward"]'::jsonb;
  else
    -- No organization-wide NULL role can be attributed to an ownerless
    -- chapter. Its exact chapter steward remains valid, including #6369.
    select pg_catalog.count(distinct r.user_id) into steward_count
    from public.member_roles r
    where r.role = 'steward' and r.chapter_id = caller_chapter;
  end if;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.organization_id is not distinct from caller_org
    and (b.chapter_id = caller_chapter or (caller_org is not null and b.chapter_id is null))
    and b.campaign_state <> 'draft'
    and not private.organization_is_platform(b.organization_id)
  order by b.closes_at desc, b.id
  limit 1;

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$function$;

commit;
