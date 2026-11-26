-- REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001 (restore-everything lane
-- L11a, Compass).
--
-- Staff can ask Compass data questions: case outcomes and win rates, caseload
-- and deadlines, membership totals, organization health and bargaining. The
-- old app (git ref de7df4b57c^) gave the chat model staff-only tools:
--   lib/claude/tools/index.ts:83-99        staff tool set (grievance stats,
--                                          org health, engagement trends,
--                                          bargaining summaries)
--   lib/claude/tools/grievance-tools.ts    get_grievance_stats: counts by
--                                          status/step and a bounded outcome
--                                          bucket, never the narrative
--   lib/claude/tools/member-tools.ts       get_member_stats: aggregate counts
--   lib/claude/tools/analytics-tools.ts    get_org_health_summary, trends
--   lib/claude/tools/bargaining-tools.ts   proposal status counts, expiry
-- Those tools read whole tables with the caller's client. Here the model never
-- calls anything: /api/guide (mode staff_data) reads this one context RPC as
-- the caller, keeps only numbers and bounded labels, and then dispatches
-- through the same governed Compass path (reservation, organization switch,
-- attestation, mesh first, Fireworks failover with organization isolation).
--
-- public.get_compass_staff_data_context(p_topics) takes the case-graph
-- identity lock first (it transitively calls case-graph writers such as the
-- analytics snapshot's tenant audit), then gates: signed in with MFA; the
-- Compass organization (private.member_organization_for, the quota
-- organization the dispatch gate binds); a staff role there (organization
-- grant or chapter staff role); and both organization switches on. Members are
-- refused 42501; a switch that is off refuses 55000; topics are a closed set.
-- Every figure then comes from an EXISTING tenant-scoped aggregate RPC run as
-- the caller (auth.uid() is unchanged inside a definer), which applies its own
-- role and visibility checks: casework_dashboard_* and get_coordinator_kpis
-- (private.casework_staff_can_access), get_organization_analytics_snapshot
-- (cohorts at or above its privacy floor of 25 only),
-- get_chapter_health_portfolio (chapters the caller may manage). Two counts are
-- computed here under the source's own predicates, applied explicitly: the
-- recorded outcome bucket (member_case_outcomes.outcome) under
-- get_coordinator_kpis' tenant and visibility bounds, only after that
-- coordinator-only call succeeded; and bargaining workspace and proposal
-- status under the casework_bargaining_*_staff policy predicate. No title,
-- body, summary, note, name or person identifier is returned. A topic the
-- caller has no access to comes back {"unavailable": true}.
--
-- Default OFF: the old staff tools existed only inside the chat, and the old
-- master gate claude_enabled was 'false' in production
-- (de7df4b57c^ supabase/migrations/0023_claude_ai.sql:153,
-- 0404_align_claude_widget_flags_to_master_gate.sql,
-- 0406_realign_claude_flags_and_enable_workload_tracker.sql).

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.ai_assistant.staff_data_answers', 'boolean', 'Compass answers from your numbers',
   'Let staff ask Compass about case outcomes, caseload, membership, health and bargaining. Only totals they can already see are used; never for members.',
   'false', null, null, null, 200, 'ai_assistant', true)
on conflict (key) do nothing;

create function public.get_compass_staff_data_context(p_topics text[])
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
      -- the caller's organization and chapter; visibility:
      -- private.casework_staff_can_access per case), reached only after that
      -- coordinator-only call succeeded. The bucket is the closed outcome
      -- vocabulary, never the summary.
      select coalesce(pg_catalog.jsonb_object_agg(counted.outcome, counted.total), '{}'::jsonb) into tally
      from (
        select outcome_row.outcome, pg_catalog.count(*) as total
        from public.member_case_outcomes outcome_row
        join public.member_cases case_row on case_row.id = outcome_row.case_id
        where case_row.organization_id = org
          and case_row.chapter_id = chapter
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

revoke all on function public.get_compass_staff_data_context(text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_compass_staff_data_context(text[]) to authenticated;

comment on function public.get_compass_staff_data_context(text[]) is
  'REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001: staff-only, switch-gated aggregate context for Compass data answers. Figures come from existing tenant-scoped aggregate RPCs run as the caller, or counts under those RPCs'' or the source policies'' own predicates; no text fields or person identifiers.';

notify pgrst, 'reload schema';

commit;
