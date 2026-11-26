-- BUG-UG-ADVISOR-OVERVIEW-OWNERLESS-STEWARD-PLATFORM-MEMBERSHIP-20261028
--
-- 20261028080000 counts a steward role row in public.get_advisor_overview
-- only when the steward holds an active union membership or no active
-- platform membership. A chapter-scoped steward on a legacy chapter with no
-- owning organization, whose only active membership is the platform's, was
-- dropped although private.member_has_chapter_role still recognizes the role,
-- so the chapter's advisor saw stewardCount 0 and atRisk.unstaffed true.
--
-- A role row on an ownerless chapter (organization_id NULL) is now counted
-- without the membership test. Union-owned chapter rows and organization-wide
-- (NULL chapter) rows keep it: member_roles holds one row per user and role,
-- and revoke_member_chapter_membership keeps its chapter_id while another
-- chapter mapping remains, so a steward revoked from a union chapter whose
-- only remaining authority is a platform chapter still names that union
-- chapter and must stay uncounted. The grant and revoke helpers refuse a
-- chapter with no owning organization, so that stale row cannot arise there.
-- Platform-owned chapter rows stay dropped. Every other line of the
-- function, its grants and its platform refusal are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('advisor', 'admin')
  order by case r.role when 'advisor' then 0 else 1 end
  limit 1;

  select pg_catalog.count(*)
  into members_covered
  from public.member_profiles p
  where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.organization_is_platform(c.organization_id)
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < current_date)
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- An org-wide steward (NULL chapter role row) covers every chapter, so it
  -- counts toward any caller's scope. A role on an ownerless chapter has no
  -- organization to place it, so only union-owned and org-wide rows are
  -- placed by membership.
  select pg_catalog.count(distinct r.user_id)
  into steward_count
  from public.member_roles r
  where r.role = 'steward'
    and not private.chapter_belongs_to_platform(r.chapter_id)
    and (exists (select 1 from public.chapters c
        where c.id = r.chapter_id and c.organization_id is null)
      or exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_union(m.organization_id))
      or not exists (select 1 from public.organization_memberships m
        where m.user_id = r.user_id and m.status = 'active' and private.organization_is_platform(m.organization_id)))
    and (caller_chapter is null or r.chapter_id is null or r.chapter_id = caller_chapter);

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
    and not private.organization_is_platform(b.organization_id)
  order by b.closes_at desc
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
revoke all on function public.get_advisor_overview() from public, anon, authenticated, service_role;
grant execute on function public.get_advisor_overview() to authenticated;

insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
where kind='function' and schema_name='public' and object_name = 'get_advisor_overview()'
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;
do $inventory$
begin
  if exists(select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;

notify pgrst, 'reload schema';
commit;
