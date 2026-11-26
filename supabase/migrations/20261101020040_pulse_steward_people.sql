-- REQ-UG-PULSE-STEWARD-THIS-WEEK-CATALOG-AND-OWN-MEMBERS-20261031
-- Existing report-card reads are self-only. This projection reuses their
-- protected-activity formula; it never reads product telemetry or PostHog.
-- No new table and no widened event/profile policy. The preference lives with
-- the member's existing account settings and only its owner can update it.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_profiles
  add column pulse_score_visible boolean not null default true;
grant update (pulse_score_visible) on public.member_profiles to authenticated;
comment on column public.member_profiles.pulse_score_visible is
  'Show my score to my steward. Default on by a project decision of October 31. The steward Pulse projection masks score and activity before returning a hidden member.';

create function public.get_steward_pulse_people(p_level text default 'steward')
returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  selected_chapter text := private.current_member_chapter();
  result jsonb;
begin
  if caller is null or not private.mfa_satisfied()
     or private.member_pin_session_restricted()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward authorization required' using errcode = '42501';
  end if;
  if p_level is null or p_level not in ('steward', 'chapter', 'local') then
    raise exception 'unknown People level' using errcode = '22023';
  end if;
  if org is null or not private.is_organization_member(org)
     or private.organization_is_platform(org) then
    raise exception 'organization authorization required' using errcode = '42501';
  end if;

  -- The shared set-based scope helper is also used by steward desk RLS.
  -- #6665's unit/committee scoping continues through that same helper after
  -- its migration lands. Neither a broad officer role nor a client-supplied
  -- member id can expand this steward population.
  with visible_ids as materialized (
    select * from private.staff_visible_member_ids('steward')
  ), population as materialized (
    select distinct p.id, p.full_name, p.chapter_id, chapter.name as chapter_name,
      p.pulse_score_visible,
      (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end)
        + (case when chapter_member.user_id is not null then 50 else 0 end) as readiness
    from public.member_profiles p
    join visible_ids v on v.staff_visible_member_ids = p.id
    join public.chapters chapter on chapter.id = p.chapter_id and chapter.organization_id = org
    join public.organization_memberships membership on membership.user_id = p.id
      and membership.organization_id = org and membership.status = 'active'
    join public.member_chapter_memberships chapter_member on chapter_member.user_id = p.id
      and chapter_member.chapter_id = p.chapter_id and chapter_member.status = 'active'
    where p.id <> caller and (p_level = 'local' or p.chapter_id = selected_chapter)
  ), activities as materialized (
    select e.user_id, pg_catalog.count(*) as events,
      pg_catalog.max(e.occurred_at) as last_activity,
      pg_catalog.count(*) filter (where e.occurred_at >= pg_catalog.now() - interval '90 days'
        and e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')) as follow_through
    from public.organization_engagement_events e
    join population p on p.id = e.user_id and p.pulse_score_visible
    where e.organization_id = org and e.event_type <> 'page_view'
      and e.occurred_at >= pg_catalog.now() - interval '180 days'
    group by e.user_id
  ), scored as materialized (
    select p.*,
      case when p.pulse_score_visible and a.events > 0 then
        pg_catalog.round((least(100, a.events * 10) + p.readiness + least(100, a.follow_through * 20))::numeric / 3)
      else null end as score,
      case when p.pulse_score_visible then a.last_activity else null end as last_activity
    from population p left join activities a on a.user_id = p.id
  ), groups as (
    select chapter_id, chapter_name, pg_catalog.count(*) as members,
      pg_catalog.count(score) as scored_members, pg_catalog.round(pg_catalog.avg(score)) as score
    from scored group by chapter_id, chapter_name
  )
  select pg_catalog.jsonb_build_object(
    'level', p_level, 'floor', 10, 'generatedAt', pg_catalog.now(),
    'members', case when p_level = 'steward' then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', id, 'name', full_name, 'score', score,
        'scoreHidden', not pulse_score_visible, 'lastActivity', last_activity
      ) order by full_name, id) from scored
    ), '[]'::jsonb) else '[]'::jsonb end,
    'groups', case when p_level <> 'steward' then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', chapter_id, 'name', chapter_name,
        'count', case when members >= 10 then members else null end,
        'score', case when members >= 10 and scored_members >= 10 then score else null end,
        'withheld', members < 10
      ) order by chapter_name, chapter_id) from groups
    ), '[]'::jsonb) else '[]'::jsonb end
  ) into result;
  return result;
end;
$function$;
revoke all on function public.get_steward_pulse_people(text) from public, anon, authenticated, service_role;
grant execute on function public.get_steward_pulse_people(text) to authenticated;
comment on function public.get_steward_pulse_people(text) is
  'Steward-only People projection over the shared steward scope. Only steward level returns people. Chapter and local levels return no identities and withhold groups below ten; a mean additionally requires ten visible scores. Hidden scores and activity never leave the server. Existing case RLS and leadership grievance toggles are unchanged.';


-- A hidden score must not remain readable through the older analytics roster.
-- Pin the predecessor so a concurrent scope/leadership change cannot be lost.
do $assert_pulse_workspace$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'public.get_organization_analytics_workspace()'::regprocedure)
      <> '9cb4997534cd347560c7577747c6ef32' then
    raise exception 'Unreviewed analytics workspace predecessor: integrate current Main before applying Pulse privacy';
  end if;
end;
$assert_pulse_workspace$;

CREATE OR REPLACE FUNCTION public.get_organization_analytics_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  health_threshold integer := private.organization_limit(org, 'limits.analytics.chapter_health_cohort_floor');
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
  org_case_reader boolean;
  staff_chapters text[];
begin
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  -- BUG-UG-SAMPLE-ANALYTICS-PANELS-TIME-OUT-20261030: for an
  -- organization advisor, administrator or leader, every per-case clause of
  -- private.casework_staff_can_access except the chapter staff-role test is
  -- already met by that organization role, so the per-case call (about 16 ms
  -- each at Tamarack scale, one per active case) reduces to membership in
  -- the chapters where private.actor_has_chapter_staff_role holds. Both are
  -- read once here, after lock_case_graph_read, with the same helpers and
  -- arguments the shared predicate uses; every other caller keeps the shared
  -- predicate per case.
  org_case_reader := private.has_organization_role(org, array['advisor','admin','vp']);
  select coalesce(pg_catalog.array_agg(c.id), array[]::text[]) into staff_chapters
  from public.chapters c
  where c.organization_id = org
    and private.actor_has_chapter_staff_role(actor, c.id);

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapterHealthFloor', health_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', least(100, activity.event_count * 10),
        'profileReadiness',
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50,
        'followThrough', least(100, activity.follow_count * 20),
        'overallScore', pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3),
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', activity.last_activity
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.user_id = m.user_id
          -- Preserve train 2a participation semantics: page views are telemetry.
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and (may_read_unassigned or cs.steward_user_id = actor or cs.coordinator_user_id = actor)
          and case
            when org_case_reader then cs.chapter_id = any(staff_chapters)
            else private.casework_staff_can_access(cs.id)
          end
      ) cases
      where m.status = 'active'
        and (p.pulse_score_visible or m.user_id = actor)
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold,
        'score', case when totals.member_count >= health_threshold then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.id is not null
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= health_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s where s.chapter_id = c.id
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$;

commit;
