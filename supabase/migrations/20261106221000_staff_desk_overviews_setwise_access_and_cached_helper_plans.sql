-- BUG-UG-VP-AND-ADVISOR-DESK-OVERVIEW-TIMEOUT-AT-SCALE-20261106 (#7206).
-- In an organization of about 1,000 accounts the VP desk's get_vp_overview
-- passed the 30 s statement limit and the advisor desk's get_advisor_overview
-- took 16.8 s on SAMPLE; other staff load reads that carry the same generated
-- access wrappers (20261102005607) grow the same way. Two causes, two parts,
-- no change in rows, columns, order or refusals:
--
-- A. The generated member_profiles wrapper filtered every profile in the
--    database with private.chapter_member_readable(id), up to five
--    public.staff_can_see_user calls each. As in #7170 (20261106130000), the
--    predicate becomes its set-wise equivalent: the caller's own row or
--    private.staff_visible_member_ids for the same five roles, once per
--    statement. Only that predicate changes in the five functions below.
-- B. The member_cases wrappers (chapter_case_staff_readable and friends) run
--    once per case, and each run calls caller-only helpers such as
--    current_member_organization and mfa_satisfied several times. These are
--    SQL-language functions that PostgreSQL 17 cannot inline (security
--    definer), so every nested call re-planned its query. The eleven hottest
--    helpers keep their exact single query, signature, volatility, owner,
--    search_path and grants, and now run it from PL/pgSQL, whose plans are
--    cached for the session. Each query returns at most one row (a primary or
--    unique key lookup, or one expression), so return (query) answers exactly
--    what the SQL function answered.
begin;

-- Replace only the exact predecessors installed on Main.
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_vp_overview()'::regprocedure)) <> 'e3a92e112ac439c233e5bdf4151030fc' then raise exception 'unreviewed predecessor: public.get_vp_overview()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and table_name='' and object_name='get_vp_overview()' and definition_hash<>'e3a92e112ac439c233e5bdf4151030fc') then raise exception 'stale trigger receipt: public.get_vp_overview()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_advisor_overview()'::regprocedure)) <> '1125eeb0ee6045aec218e650d891bc67' then raise exception 'unreviewed predecessor: public.get_advisor_overview()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and table_name='' and object_name='get_advisor_overview()' and definition_hash<>'1125eeb0ee6045aec218e650d891bc67') then raise exception 'stale trigger receipt: public.get_advisor_overview()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_intake_triage_owners()'::regprocedure)) <> 'e5d60d0020983119e89b92b957b31bf7' then raise exception 'unreviewed predecessor: public.list_intake_triage_owners()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and table_name='' and object_name='list_intake_triage_owners()' and definition_hash<>'e5d60d0020983119e89b92b957b31bf7') then raise exception 'stale trigger receipt: public.list_intake_triage_owners()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_vp_case_reviews()'::regprocedure)) <> '68e6c4f5cca9b0052e2d2cacb198e2b0' then raise exception 'unreviewed predecessor: public.list_vp_case_reviews()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and table_name='' and object_name='list_vp_case_reviews()' and definition_hash<>'68e6c4f5cca9b0052e2d2cacb198e2b0') then raise exception 'stale trigger receipt: public.list_vp_case_reviews()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.list_member_case_assignment_candidates(uuid)'::regprocedure)) <> 'e9517a6cdcc6b55aeaf662bd148c8047' then raise exception 'unreviewed predecessor: public.list_member_case_assignment_candidates(uuid)' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and table_name='' and object_name='list_member_case_assignment_candidates(p_case_id uuid)' and definition_hash<>'e9517a6cdcc6b55aeaf662bd148c8047') then raise exception 'stale trigger receipt: public.list_member_case_assignment_candidates(uuid)' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.current_member_organization()'::regprocedure)) <> 'b53dd743e9944493fd782108caabd748' then raise exception 'unreviewed predecessor: private.current_member_organization()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='current_member_organization()' and definition_hash<>'b53dd743e9944493fd782108caabd748') then raise exception 'stale trigger receipt: private.current_member_organization()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.mfa_satisfied()'::regprocedure)) <> 'd1de92e3a663705e65c7e415d41bb693' then raise exception 'unreviewed predecessor: private.mfa_satisfied()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='mfa_satisfied()' and definition_hash<>'d1de92e3a663705e65c7e415d41bb693') then raise exception 'stale trigger receipt: private.mfa_satisfied()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.current_member_chapter()'::regprocedure)) <> '66d2119d4ba08a84c9ed80636a81237f' then raise exception 'unreviewed predecessor: private.current_member_chapter()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='current_member_chapter()' and definition_hash<>'66d2119d4ba08a84c9ed80636a81237f') then raise exception 'stale trigger receipt: private.current_member_chapter()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.current_mobile_staff_organization()'::regprocedure)) <> '8f97a9b44bc230128e76003346532ae8' then raise exception 'unreviewed predecessor: private.current_mobile_staff_organization()' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='current_mobile_staff_organization()' and definition_hash<>'8f97a9b44bc230128e76003346532ae8') then raise exception 'stale trigger receipt: private.current_mobile_staff_organization()' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.has_organization_role(uuid,text[])'::regprocedure)) <> '7fb91c8babd2807267998737fae080f3' then raise exception 'unreviewed predecessor: private.has_organization_role(uuid,text[])' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='has_organization_role(p_organization_id uuid, p_roles text[])' and definition_hash<>'7fb91c8babd2807267998737fae080f3') then raise exception 'stale trigger receipt: private.has_organization_role(uuid,text[])' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.member_has_chapter_role(text,text[])'::regprocedure)) <> 'a7f9b69a6b35a6ef692dd0c1db81b65b' then raise exception 'unreviewed predecessor: private.member_has_chapter_role(text,text[])' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='member_has_chapter_role(p_chapter_id text, p_roles text[])' and definition_hash<>'a7f9b69a6b35a6ef692dd0c1db81b65b') then raise exception 'stale trigger receipt: private.member_has_chapter_role(text,text[])' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.has_second_factor(uuid)'::regprocedure)) <> '743461b0970d3c075c8655c6bf5bd6fe' then raise exception 'unreviewed predecessor: private.has_second_factor(uuid)' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='has_second_factor(p_user uuid)' and definition_hash<>'743461b0970d3c075c8655c6bf5bd6fe') then raise exception 'stale trigger receipt: private.has_second_factor(uuid)' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.staff_mfa_required(uuid)'::regprocedure)) <> '8023ed7f14a32040ec5ae92ed8d8041a' then raise exception 'unreviewed predecessor: private.staff_mfa_required(uuid)' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='staff_mfa_required(p_organization_id uuid)' and definition_hash<>'8023ed7f14a32040ec5ae92ed8d8041a') then raise exception 'stale trigger receipt: private.staff_mfa_required(uuid)' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.staff_can_see_user(uuid,text)'::regprocedure)) <> '76927b15d5364508afd5a5edadea5b14' then raise exception 'unreviewed predecessor: public.staff_can_see_user(uuid,text)' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and table_name='' and object_name='staff_can_see_user(p_target uuid, p_role text)' and definition_hash<>'76927b15d5364508afd5a5edadea5b14') then raise exception 'stale trigger receipt: public.staff_can_see_user(uuid,text)' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.actor_has_chapter_staff_role(uuid,text)'::regprocedure)) <> 'ed0b9613c428626340cc995378b13fcc' then raise exception 'unreviewed predecessor: private.actor_has_chapter_staff_role(uuid,text)' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='actor_has_chapter_staff_role(p_actor uuid, p_chapter text)' and definition_hash<>'ed0b9613c428626340cc995378b13fcc') then raise exception 'stale trigger receipt: private.actor_has_chapter_staff_role(uuid,text)' using errcode='55000'; end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.actor_role_covers_member(uuid,text,text,uuid,boolean)'::regprocedure)) <> '0342ae038bb3a24f9f4c33c53ee639be' then raise exception 'unreviewed predecessor: private.actor_role_covers_member(uuid,text,text,uuid,boolean)' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='private' and table_name='' and object_name='actor_role_covers_member(p_actor uuid, p_chapter text, p_role text, p_target uuid, p_grievance boolean)' and definition_hash<>'0342ae038bb3a24f9f4c33c53ee639be') then raise exception 'stale trigger receipt: private.actor_role_covers_member(uuid,text,text,uuid,boolean)' using errcode='55000'; end if;
end;
$preflight$;

-- A. Set-wise member_profiles access predicate.
CREATE OR REPLACE FUNCTION public.get_vp_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  -- Fail closed: no selected organization or chapter means no tenant to
  -- report on, never a database-wide scan.
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  if caller_org is null or caller_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter;

  select pg_catalog.count(*)
  into active_grievances
  from (select access_row.* from public.member_cases access_row where (private.chapter_case_leadership_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and c.organization_id = caller_org
    and c.chapter_id = caller_chapter;

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
    and b.campaign_state <> 'draft'
    and b.organization_id = caller_org
    and (b.chapter_id is null or b.chapter_id = caller_chapter)
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'reference', s.reference,
      'title', s.title,
      'step', s.step,
      'deadline', s.deadline,
      'memberName', s.member_name)), '[]'::jsonb)
  into attention
  from (
    select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_leadership_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
    where c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
      and c.organization_id is not null
      and c.chapter_id is not null
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter
    order by c.deadline
    limit 6
  ) s;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary)), '[]'::jsonb)
  into upcoming
  from (
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      and private.member_can_access_event_scope(ev.chapter_id, ev.is_public, ev.is_public_across_agencies)
    order by ev.starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
      where p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$function$
;

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
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where (caller_chapter is null or p.chapter_id = caller_chapter)
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
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
$function$
;

CREATE OR REPLACE FUNCTION public.list_intake_triage_owners()
 RETURNS TABLE(user_id uuid, full_name text, initials text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  return query
  select p.id, p.full_name, p.initials
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter
    and exists (
      select 1
      from public.member_roles r
      where r.user_id = p.id
        and r.role = any(array['steward', 'coordinator'])
    )
  order by p.full_name, p.id;
end
$function$
;

CREATE OR REPLACE FUNCTION public.list_vp_case_reviews()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role with MFA required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by r.chapter_id
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'caseId', v.case_id,
    'reviewedAt', v.reviewed_at,
    'reviewedBy', v.reviewed_by,
    'reviewerName', p.full_name,
    'caseReference', c.reference,
    'caseTitle', private.case_row_title(c.id),
    'topicShown', private.case_row_topic_shown(c.id),
    'caseType', c.case_type,
    'caseStep', c.step
  ) order by v.reviewed_at desc), '[]'::jsonb)
  into payload
  from public.member_vp_case_reviews v
  join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = v.reviewed_by
  join (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c on c.id = v.case_id
  where v.chapter_id = caller_chapter;

  return payload;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.list_member_case_assignment_candidates(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  case_owner uuid;
  case_chapter text;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role and MFA required' using errcode = '42501';
  end if;

  select c.user_id, p.chapter_id into case_owner, case_chapter
  from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
  join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
  where c.id = p_case_id;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not public.staff_can_see_user(case_owner, 'coordinator') then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', eligible.user_id,
      'fullName', eligible.full_name,
      'roles', eligible.roles
    ) order by eligible.full_name, eligible.user_id)
    from (
      select r.user_id, p.full_name,
             pg_catalog.jsonb_agg(r.role order by r.role) as roles
      from public.member_roles r
      join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = r.user_id
      where r.role in ('steward', 'coordinator')
        and (r.chapter_id is null or r.chapter_id = case_chapter)
      group by r.user_id, p.full_name
      order by p.full_name, r.user_id
      limit 200
    ) eligible
  ), '[]'::jsonb);
end;
$function$
;

-- B. Caller and visibility helpers: same query, cached plan.
CREATE OR REPLACE FUNCTION private.current_member_organization()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select c.organization_id
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  join public.organizations o
    on o.id = c.organization_id
   and o.status = 'active'
  join public.member_chapter_memberships cm
    on cm.user_id = p.id
   and cm.chapter_id = c.id
   and cm.status = 'active'
  join public.organization_memberships om
    on om.organization_id = c.organization_id
   and om.user_id = p.id
   and om.status = 'active'
  where p.id = (select auth.uid())
    and c.organization_id is not null
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.mfa_satisfied()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select case
    when claims.user_id is null then false
    when coalesce(claims.session_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    when exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = claims.user_id) then false
    when not exists (
      select 1 from auth.sessions session
      left join private.member_mfa_reset_boundaries boundary on boundary.user_id = session.user_id
      where session.id = claims.session_id::uuid and session.user_id = claims.user_id
        and session.created_at > coalesce(boundary.invalid_before,'-infinity'::timestamptz)
    ) then false
    when claims.key_uv then claims.aal = 'aal2' and private.verified_key_session(claims.user_id,claims.session_id::uuid)
    when claims.aal = 'aal2' then true
    else not private.member_mfa_required(claims.user_id) and not exists (select 1 from auth.mfa_factors factor where factor.user_id = claims.user_id and factor.status = 'verified' and factor.factor_type = 'totp')
  end from (
    select (select auth.uid()) as user_id, (select auth.jwt()->>'session_id') as session_id,
      (select auth.jwt()->>'aal') as aal, coalesce((select auth.jwt()->'ug_key_uv') = 'true'::jsonb,false) as key_uv
  ) claims
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.current_member_chapter()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select p.chapter_id
  from public.member_profiles p
  where p.id = (select auth.uid())
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.current_mobile_staff_organization()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select case
    when private.current_member_chapter() is not null
      then private.current_member_organization()
    else (
      select case when pg_catalog.count(*) = 1
        then pg_catalog.min(candidate.organization_id::text)::uuid
        else null
      end
      from (
        select distinct membership.organization_id
        from public.organization_memberships membership
        join public.organizations organization
          on organization.id = membership.organization_id
         and organization.status = 'active'
        where membership.user_id = (select auth.uid())
          and membership.status = 'active'
      ) candidate
    )
  end
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.has_organization_role(p_organization_id uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select case
    when (select auth.uid()) is null or p_organization_id is null then false
    when not (select private.mfa_satisfied()) then false
    when p_organization_id is distinct from (select private.current_mobile_staff_organization()) then false
    when not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = (select auth.uid())
        and membership.status = 'active'
    ) then false
    when not exists (
      select 1
      from public.organization_role_grants role_grant
      where role_grant.organization_id = p_organization_id
        and role_grant.user_id = (select auth.uid())
        and role_grant.role = any(p_roles)
    ) then false
    when not (select private.staff_mfa_required(p_organization_id)) then true
    else (select private.has_second_factor((select auth.uid())))
  end
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.member_has_chapter_role(p_chapter_id text, p_roles text[])
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select (select auth.uid()) is not null
    and (select private.mfa_satisfied())
    and exists (
    select 1
    from public.chapters c
    where c.id = p_chapter_id
      and (
        (
          c.organization_id is not null
          and c.organization_id = (select private.current_member_organization())
          and exists (
            select 1
            from public.organization_memberships om
            where om.user_id = (select auth.uid())
              and om.organization_id = c.organization_id
              and om.status = 'active'
          )
          and exists (
            select 1
            from public.member_chapter_memberships m
            where m.user_id = (select auth.uid())
              and m.chapter_id = c.id
              and m.status = 'active'
          )
          and (
            not private.staff_mfa_required(c.organization_id)
            or private.has_second_factor((select auth.uid()))
          )
          and (
            private.has_organization_role(c.organization_id, p_roles)
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships m
                on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
              where rc.user_id = (select auth.uid())
                and rc.role = any(p_roles)
                and not exists(select 1 from private.chapter_role_scopes scope where scope.user_id=rc.user_id and scope.chapter_id=rc.chapter_id and scope.role=rc.role)
                and rc.chapter_id = c.id
                and m.status = 'active'
            )
          )
        )
        or (
          c.organization_id is null
          and (select private.current_member_organization()) is null
          and public.member_has_role(p_roles)
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = (select auth.uid())
              and r.role = any(p_roles)
              and (
                r.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters rc
                  join public.member_chapter_memberships m
                    on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                  where rc.user_id = r.user_id
                    and rc.role = r.role
                    and not exists(select 1 from private.chapter_role_scopes scope where scope.user_id=rc.user_id and scope.chapter_id=rc.chapter_id and scope.role=rc.role)
                    and rc.chapter_id = p_chapter_id
                    and m.status = 'active'
                )
              )
          )
        )
      )
  )
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.has_second_factor(p_user uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select exists (select 1 from auth.mfa_factors factor where factor.user_id = p_user
    and factor.status = 'verified' and factor.factor_type = any(private.challengeable_factor_types()))
  or case when p_user = (select auth.uid())
    and (select auth.jwt()->>'aal') = 'aal2'
    and (select auth.jwt()->'ug_key_uv') = 'true'::jsonb
    and coalesce((select auth.jwt()->>'session_id'),'') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then private.verified_key_session(p_user,(select auth.jwt()->>'session_id')::uuid)
    else false end
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.staff_mfa_required(p_organization_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select case
    when p_organization_id is null then true
    else coalesce((
      select p.require_staff_mfa
      from public.org_security_policy p
      where p.organization_id = p_organization_id
    ), true)
  end
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.staff_can_see_user(p_target uuid, p_role text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select case
    when (select auth.uid()) is null or p_target is null or p_role is null or p_role not in ('steward','coordinator','advisor','admin','vp') then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.member_profiles target
      join public.chapters target_chapter on target_chapter.id = target.chapter_id
      where target.id = p_target
        and (
          (
            target_chapter.organization_id is not null
            and target_chapter.organization_id = (select private.current_member_organization())
            and (
              private.has_organization_role(target_chapter.organization_id, array[p_role])
              or private.member_has_chapter_role(target_chapter.id, array[p_role])
              or exists(select 1 from private.chapter_role_scopes scope where scope.user_id=(select auth.uid()) and scope.role=p_role and private.chapter_scoped_role_allows(scope.chapter_id,p_role,p_target,false))
            )
          )
          or (
            target_chapter.organization_id is null
            and (select private.current_member_organization()) is null
            and exists (
              select 1
              from public.member_profiles caller_profile
              left join public.chapters caller_chapter
                on caller_chapter.id = caller_profile.chapter_id
              where caller_profile.id = (select auth.uid())
                and (caller_chapter.id is null or caller_chapter.organization_id is null)
            )
            and (
              not (select private.staff_mfa_required())
              or (select private.has_second_factor((select auth.uid())))
            )
            and exists (
              select 1
              from public.member_roles r
              where r.user_id = (select auth.uid())
                and r.role = p_role
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships m
                      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                    join public.chapters mapped on mapped.id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = target.chapter_id
                      and mapped.organization_id is null
                      and m.status = 'active'
                  )
                )
            )
          )
        )
    )
  end
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.actor_has_chapter_staff_role(p_actor uuid, p_chapter text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select exists (
    select 1
    from public.chapters c
    where c.id = p_chapter
      and (
        (
          c.organization_id is not null
          and exists (
            select 1
            from public.organizations o
            where o.id = c.organization_id
              and o.status = 'active'
          )
          and exists (
            select 1
            from public.organization_memberships om
            where om.organization_id = c.organization_id
              and om.user_id = p_actor
              and om.status = 'active'
          )
          and (
            exists (
              select 1 from public.organization_role_grants g
              where g.organization_id = c.organization_id
                and g.user_id = p_actor
                and g.role = any(array['steward','coordinator','advisor','admin','vp'])
            )
            or exists (
              select 1
              from public.member_role_chapters rc
              join public.member_chapter_memberships cm
                on cm.user_id = rc.user_id
               and cm.chapter_id = rc.chapter_id
               and cm.status = 'active'
              where rc.user_id = p_actor
                and rc.chapter_id = c.id
                and rc.role = any(array['steward','coordinator','advisor','admin','vp'])
            )
          )
          and (
            not private.staff_mfa_required(c.organization_id)
            or private.has_second_factor(p_actor)
          )
        )
        or (
          c.organization_id is null
          and exists (
            select 1
            from public.member_profiles actor_profile
            left join public.chapters actor_chapter
              on actor_chapter.id = actor_profile.chapter_id
            where actor_profile.id = p_actor
              and (actor_chapter.id is null or actor_chapter.organization_id is null)
          )
          and exists (
            select 1
            from public.member_roles r
            where r.user_id = p_actor
              and r.role = any(array['steward','coordinator','advisor','admin','vp'])
              and (r.chapter_id is null or r.chapter_id = c.id)
          )
          and (
            not private.staff_mfa_required()
            or private.has_second_factor(p_actor)
          )
        )
      )
  )
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.actor_role_covers_member(p_actor uuid, p_chapter text, p_role text, p_target uuid, p_grievance boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return (
select exists(select 1 from public.chapters c
    join public.organizations organization on organization.id=c.organization_id and organization.status='active'
    join public.organization_memberships actor_org on actor_org.organization_id=c.organization_id and actor_org.user_id=p_actor and actor_org.status='active'
    left join public.organization_memberships target_org on target_org.organization_id=c.organization_id and target_org.user_id=p_target and target_org.status='active'
    left join public.member_chapter_memberships target on target.chapter_id=c.id and target.user_id=p_target and target.status='active'
    where c.id=p_chapter
      and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor(p_actor))
      and (p_target is null or (target_org.user_id is not null and target.user_id is not null)) and (
      exists(select 1 from public.organization_role_grants r where r.organization_id=c.organization_id and r.user_id=p_actor and r.role=p_role)
      or exists(select 1 from public.member_role_chapters r
        join public.member_chapter_memberships actor on actor.user_id=r.user_id and actor.chapter_id=r.chapter_id and actor.status='active'
        left join private.chapter_role_scopes scope on scope.user_id=r.user_id and scope.chapter_id=r.chapter_id and scope.role=r.role
        where r.user_id=p_actor and r.chapter_id=c.id and r.role=p_role and (
          scope.user_id is null
          or exists(select 1 from private.chapter_unit_members m where m.unit_id=scope.unit_id and m.chapter_id=c.id and m.user_id=p_target)
          or exists(select 1 from private.chapter_committees committee
            join private.chapter_committee_members m on m.committee_id=committee.id and m.chapter_id=committee.chapter_id
            where committee.id=scope.committee_id and committee.chapter_id=c.id and m.user_id=p_target
              and committee.starts_on<=current_date and (committee.ends_on is null or committee.ends_on>=current_date)
              and (not p_grievance or committee.grievance_access))))))
  );
end;
$function$
;

-- Grants are unchanged by create or replace. A function the account-lifecycle
-- trigger surface reaches keeps a current receipt; absent receipts stay absent.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid = any (array[
    'public.get_vp_overview()',
    'public.get_advisor_overview()',
    'public.list_intake_triage_owners()',
    'public.list_vp_case_reviews()',
    'public.list_member_case_assignment_candidates(uuid)',
    'private.current_member_organization()',
    'private.mfa_satisfied()',
    'private.current_member_chapter()',
    'private.current_mobile_staff_organization()',
    'private.has_organization_role(uuid,text[])',
    'private.member_has_chapter_role(text,text[])',
    'private.has_second_factor(uuid)',
    'private.staff_mfa_required(uuid)',
    'public.staff_can_see_user(uuid,text)',
    'private.actor_has_chapter_staff_role(uuid,text)',
    'private.actor_role_covers_member(uuid,text,text,uuid,boolean)'
   ]::regprocedure[])
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';

commit;
