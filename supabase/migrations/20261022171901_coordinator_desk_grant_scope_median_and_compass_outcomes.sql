-- BUG-UG-COORDINATOR-DESK-GRANT-SCOPE-MEDIAN-AND-COMPASS-OUTCOMES-20261022
--
-- 20261022053100 (#5554) let the coordinator desk's queue, KPIs and open-case
-- tiles include a case the caller holds an active casework_access_grants row
-- for while public.staff_can_see_user(member, 'coordinator') admits them
-- (the member's chapter moved to the caller's organization). Two readers on the
-- same screens kept the old organization-and-chapter bound:
--   public.casework_dashboard_median_days_per_step (20260917142000): a granted
--     case counted in the open-by-step tile, while its step changes were
--     missing from the median tile;
--   public.get_compass_staff_data_context (20261003055000): byOutcome sat
--     beside the widened get_coordinator_kpis totals but kept the old bound,
--     so a resolved granted case raised resolved and resolutionRate and was
--     absent from byOutcome.
--
-- Repair. Each keeps its tenant bound and adds the same alternative as
-- 20261022053100: the case is one the caller holds an active, unrevoked grant
-- for, and staff_can_see_user admits the caller for its member. Both still
-- filter every case through private.casework_staff_can_access, the median
-- keeps its 90-day window and calculation, and every other line is
-- unchanged. Signatures, security mode, grants and result shapes are
-- unchanged (create or replace keeps the ACL). Each installed body is
-- md5-guarded before it is replaced. Hosted application needs the owner's
-- separate go-ahead.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  installed text;
begin
  select array[
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
        where p.oid = 'public.casework_dashboard_median_days_per_step()'::regprocedure),
      (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
        where p.oid = 'public.get_compass_staff_data_context(text[])'::regprocedure)
    ]::text into strict installed;
  -- Reviewed predecessors, in order: 20260917142000 and 20261003055000.
  if installed is distinct from '{0b595f19662ec7e662e3b9e3d82e1e6d,b7db0023bf2af19e9795e92a16b5a284}' then
    raise exception 'unreviewed coordinator desk reader predecessor: %', installed
      using errcode = '55000';
  end if;
end
$predecessor$;

create or replace function public.casework_dashboard_median_days_per_step()
returns table (step text, median_days numeric, transition_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  with tenant as (
    select distinct transition.case_id
    from public.casework_step_transitions transition
    where transition.created_at >= pg_catalog.now() - interval '90 days'
      and (
        (transition.organization_id = (select private.current_member_organization())
          and transition.chapter_id = (select private.current_member_chapter()))
        or (
          transition.case_id in (
            select g.case_id
            from public.casework_access_grants g
            where g.grantee_user_id = (select auth.uid())
              and g.revoked_at is null
          )
          and public.staff_can_see_user((select c.user_id from public.member_cases c where c.id = transition.case_id), 'coordinator')
        )
      )
  ),
  visible as (
    select tenant.case_id
    from tenant
    where private.casework_staff_can_access(tenant.case_id)
  ),
  history as (
    select
      transition.case_id,
      transition.from_step,
      transition.created_at,
      lag(transition.created_at) over (
        partition by transition.case_id
        order by transition.created_at, transition.id
      ) as entered_at
    from public.casework_step_transitions transition
    join visible on visible.case_id = transition.case_id
  ),
  measured as (
    select
      history.from_step,
      extract(epoch from (
        history.created_at - coalesce(history.entered_at, opened.created_at)
      )) / 86400.0 as days_in_step
    from history
    join public.member_cases opened on opened.id = history.case_id
    where history.created_at >= pg_catalog.now() - interval '90 days'
  )
  select
    measured.from_step,
    pg_catalog.round(
      (pg_catalog.percentile_cont(0.5) within group (order by measured.days_in_step))::numeric,
      2
    ),
    pg_catalog.count(*)
  from measured
  group by measured.from_step
  order by pg_catalog.count(*) desc, measured.from_step asc;
end;
$function$;

create or replace function public.get_compass_staff_data_context(p_topics text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  chapter text;
  topics text[];
  data jsonb;
  part jsonb;
  tally jsonb;
  snapshot jsonb;
  snapshot_read boolean;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  -- The Compass organization: the quota organization the dispatch gate binds.
  org := private.member_organization_for(caller);
  chapter := private.current_member_chapter();
  if org is null
     or not (
       private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
       or private.actor_has_chapter_staff_role(caller, chapter)
     ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.staff_data_answers') then
    raise exception 'staff data answers are turned off' using errcode = '55000';
  end if;
  data := '{}'::jsonb;
  snapshot_read := false;

  select coalesce(pg_catalog.array_agg(distinct topic order by topic), array[]::text[]) into topics
  from pg_catalog.unnest(coalesce(p_topics, array[]::text[])) topic;
  if pg_catalog.cardinality(topics) not between 1 and 5
     or not topics <@ array['caseload', 'outcomes', 'membership', 'health', 'bargaining'] then
    raise exception 'topics invalid' using errcode = '22023';
  end if;

  if 'caseload' = any(topics) then
    begin
      select pg_catalog.jsonb_build_object(
        'openByStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', s.step, 'cases', s.case_count) order by s.case_count desc, s.step), '[]'::jsonb)
          from public.casework_dashboard_open_cases_by_step() s),
        'overdue', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'kind', o.kind, 'deadlines', o.deadline_count, 'cases', o.case_count,
            'oldestDaysOverdue', pg_catalog.floor(extract(epoch from (pg_catalog.now() - o.oldest_due_at)) / 86400.0)::integer
          ) order by o.kind), '[]'::jsonb)
          from public.casework_dashboard_overdue_deadlines() o),
        'dueSoon', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'daysOut', d.days_out, 'deadlines', d.deadline_count, 'cases', d.case_count) order by d.days_out), '[]'::jsonb)
          from public.casework_dashboard_deadlines_due_soon() d),
        'medianDaysPerStep', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'step', m.step, 'medianDays', m.median_days, 'transitions', m.transition_count) order by m.step), '[]'::jsonb)
          from public.casework_dashboard_median_days_per_step() m)
      ) into part;
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('caseload', part);
  end if;

  if 'outcomes' = any(topics) then
    begin
      part := public.get_coordinator_kpis();
      part := pg_catalog.jsonb_build_object(
        'openCases', part -> 'openCases', 'resolved', part -> 'resolved',
        'resolutionRate', part -> 'resolutionRate', 'inArbitration', part -> 'inArbitration',
        'byStep', part -> 'byStep', 'byArticle', part -> 'byArticle');
      -- Recorded outcomes under get_coordinator_kpis' own two bounds (tenant:
      -- the caller's organization and chapter, or a case the caller holds an
      -- active grant for while staff_can_see_user admits them (20261022171901,
      -- #5748); visibility:
      -- private.casework_staff_can_access per case), reached only after that
      -- coordinator-only call succeeded. The bucket is the closed outcome
      -- vocabulary, never the summary.
      select coalesce(pg_catalog.jsonb_object_agg(counted.outcome, counted.total), '{}'::jsonb) into tally
      from (
        select outcome_row.outcome, pg_catalog.count(*) as total
        from public.member_case_outcomes outcome_row
        join public.member_cases case_row on case_row.id = outcome_row.case_id
        where (
            (case_row.organization_id = org and case_row.chapter_id = chapter)
            or (
              case_row.id in (
                select g.case_id
                from public.casework_access_grants g
                where g.grantee_user_id = (select auth.uid())
                  and g.revoked_at is null
              )
              and public.staff_can_see_user(case_row.user_id, 'coordinator')
            )
          )
          and private.casework_staff_can_access(case_row.id)
        group by outcome_row.outcome
      ) counted;
      part := part || pg_catalog.jsonb_build_object('byOutcome', tally);
    exception when insufficient_privilege then
      part := pg_catalog.jsonb_build_object('unavailable', true);
    end;
    data := data || pg_catalog.jsonb_build_object('outcomes', part);
  end if;

  if 'membership' = any(topics) or 'health' = any(topics) then
    begin
      snapshot := public.get_organization_analytics_snapshot();
      snapshot_read := (snapshot ->> 'organizationId')::uuid is not distinct from org;
    exception when others then
      snapshot_read := false;
    end;
  end if;

  if 'membership' = any(topics) then
    data := data || pg_catalog.jsonb_build_object('membership', case when snapshot_read then
      pg_catalog.jsonb_build_object(
        'privacyThreshold', snapshot -> 'privacyThreshold',
        'chapters', snapshot -> 'chapters',
        'usageWindows', snapshot -> 'usageWindows')
      else pg_catalog.jsonb_build_object('unavailable', true) end);
  end if;

  if 'health' = any(topics) then
    begin
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'chapterId', item ->> 'chapterId', 'label', item ->> 'chapterName',
          'memberCount', item -> 'memberCount', 'score', item -> 'score',
          'drivers', item -> 'drivers',
          'trend', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'measuredOn', point ->> 'measuredOn', 'score', point -> 'score')), '[]'::jsonb)
            from pg_catalog.jsonb_array_elements(coalesce(item -> 'trend', '[]'::jsonb)) point)
        )), '[]'::jsonb) into part
      from pg_catalog.jsonb_array_elements(coalesce(public.get_chapter_health_portfolio(), '[]'::jsonb)) item
      join public.chapters chapter on chapter.id = item ->> 'chapterId' and chapter.organization_id = org;
    exception when insufficient_privilege then
      part := null;
    end;
    data := data || pg_catalog.jsonb_build_object('health', pg_catalog.jsonb_build_object(
      'privacyThreshold', case when snapshot_read then snapshot -> 'privacyThreshold' else null end,
      'chapters', coalesce(part, '[]'::jsonb),
      'series', case when snapshot_read then snapshot -> 'series' else '[]'::jsonb end,
      'chapterLabels', case when snapshot_read then (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', chapter_row ->> 'id', 'label', chapter_row ->> 'label')), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(coalesce(snapshot -> 'chapters', '[]'::jsonb)) chapter_row
      ) else '[]'::jsonb end,
      'engagementCounts', case when snapshot_read then snapshot -> 'engagementCounts' else '[]'::jsonb end,
      'unavailable', part is null and not snapshot_read));
  end if;

  if 'bargaining' = any(topics) then
    -- Status counts over the workspaces the caller could read: the
    -- casework_bargaining_*_staff policy predicate (chapter staff of the
    -- workspace's chapter), applied explicitly. Titles and bodies are never read.
    select pg_catalog.jsonb_build_object(
      'workspacesByStatus', coalesce((
        select pg_catalog.jsonb_object_agg(counted.status, counted.total)
        from (
          select workspace.status, pg_catalog.count(*) as total
          from public.casework_bargaining_workspaces workspace
          where workspace.organization_id = org
            and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by workspace.status
        ) counted), '{}'::jsonb),
      'proposalsBySideAndStatus', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'side', counted.side, 'status', counted.status, 'proposals', counted.total)
          order by counted.side, counted.status)
        from (
          select proposal.side, proposal.status, pg_catalog.count(*) as total
          from public.casework_bargaining_proposals proposal
          join public.casework_bargaining_workspaces workspace
            on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
          where proposal.organization_id = org
            and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          group by proposal.side, proposal.status
        ) counted), '[]'::jsonb),
      'responsesDueWithin7Days', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at >= pg_catalog.now()
          and proposal.response_due_at < pg_catalog.now() + interval '7 days'),
      'responsesOverdue', (
        select pg_catalog.count(*)
        from public.casework_bargaining_proposals proposal
        join public.casework_bargaining_workspaces workspace
          on workspace.id = proposal.workspace_id and workspace.organization_id = proposal.organization_id
        where proposal.organization_id = org
          and private.member_has_chapter_role(workspace.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
          and proposal.status in ('proposed', 'countered')
          and proposal.response_due_at < pg_catalog.now())
    ) into part;
    data := data || pg_catalog.jsonb_build_object('bargaining', part);
  end if;

  return pg_catalog.jsonb_build_object('organization_id', org, 'topics', pg_catalog.to_jsonb(topics), 'data', data);
end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
