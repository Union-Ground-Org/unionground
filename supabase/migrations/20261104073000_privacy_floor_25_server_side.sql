-- REQ-UG-PRIVACY-FLOOR-25-SERVER-SIDE-20261104 (#7010).
--
-- The web app releases no aggregate group under 25 (#6998, Lovable audit
-- APP-STEWARD-07), but the server still let an organization lower its
-- analytics anonymity limit to ten (20261003058000: minimum 10) and its chapter
-- health cohort floor to five (default 10), and answered aggregate reads at
-- that floor. Exports and other clients that call the RPCs directly still got
-- groups of 10 to 24. This delivery holds 25 on the server:
--
--   1. Both registry rows, limits.analytics.anonymity_floor and
--      limits.analytics.chapter_health_cohort_floor, now have minimum 25 and
--      default 25, so set_organization_setting, update_organization_setting
--      and reset_organization_setting (all through
--      private.write_organization_setting and private.setting_value_valid)
--      refuse 24 or less with 22023 and a reset lands on 25.
--   2. EXISTING ROWS RAISED: every stored organization value of either key
--      under 25 is raised to 25 here, before the check below is added. Each
--      raised row gets an organization_configuration_audit row
--      (setting_updated, no actor, previous and new value), so an
--      organization's configuration history shows the change.
--   3. public.organization_setting_values gets a check constraint, so no
--      writer, including a direct table write, can store either key under 25.
--   4. private.organization_limit returns at least 25 for both keys whatever
--      the stored value or registry default. Every aggregate RPC reads its
--      floor through this helper: get_organization_analytics_workspace
--      (datasets, chapter health and the privacyThreshold and
--      chapterHealthFloor it reports to the browser),
--      get_organization_analytics_snapshot (and so the export counts it
--      issues), private.pulse_chart_values (preview_pulse_chart,
--      list_pulse_charts and the read_pulse_chart CSV export),
--      get_pulse_history and take_pulse_weekly_snapshots,
--      get_chapter_health_portfolio, get_member_union_statistics,
--      get_bargaining_survey_results, the usage digests and the workload
--      reads. Their bodies are unchanged.
--   5. public.get_steward_pulse_people was the one aggregate read with a
--      literal floor of ten for its chapter and local groups; it now reads
--      the organization floor through the same helper. The steward level
--      (the steward's own assigned members, by name) is unchanged.
--   6. public.get_organization_analytics_workspace gated chapter health only
--      by the chapter's current membership, so a snapshot recorded when the
--      chapter had 24 people (its score, drivers and trend points) became
--      visible once a 25th member joined. Each snapshot is now also gated by
--      the cohort it recorded (chapter_health_snapshots.member_count): the
--      latest score and drivers, every trend point, the organization chapter
--      health dataset and each chapter's health-trend dataset rows.
--      get_chapter_health_portfolio already gated each snapshot this way.
--
-- Apply order: after 20261104030000_learning_period_case_records.sql (#7000,
-- open at the time of writing). Nothing here depends on it.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the predecessors so a concurrent change is not lost.
do $assert_privacy_floor_predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.organization_limit(uuid,text)'::pg_catalog.regprocedure))
      <> 'c72f679227a26b16aa57c68b648c99d6' then
    raise exception 'Unreviewed organization limit predecessor: integrate current Main before holding the privacy floor at 25';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_steward_pulse_people(text)'::pg_catalog.regprocedure))
      <> '141d3959e2eaf15234eb3d940d6b046e' then
    raise exception 'Unreviewed steward Pulse People predecessor: integrate current Main before holding the privacy floor at 25';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_workspace()'::pg_catalog.regprocedure))
      <> '705523ffb7ed8d313cb2dcfc184344b3' then
    raise exception 'Unreviewed analytics workspace predecessor: integrate current Main before holding the privacy floor at 25';
  end if;
end;
$assert_privacy_floor_predecessors$;

-- 1. Registry bounds and defaults.
update public.platform_setting_definitions
set minimum = 25,
  default_value = '25'::jsonb,
  description = 'Minimum distinct people required before analytics cells and their complements are published. Never below 25.'
where key = 'limits.analytics.anonymity_floor';

update public.platform_setting_definitions
set minimum = 25,
  default_value = '25'::jsonb,
  description = 'Minimum chapter membership before a health snapshot and trend are shown. Never below 25.'
where key = 'limits.analytics.chapter_health_cohort_floor';

do $assert_privacy_floor_definitions$
begin
  if (select pg_catalog.count(*) from public.platform_setting_definitions d
      where d.key in ('limits.analytics.anonymity_floor', 'limits.analytics.chapter_health_cohort_floor')
        and d.value_kind = 'integer' and d.minimum = 25 and d.default_value = '25'::jsonb) <> 2 then
    raise exception 'privacy floor registry rows were not raised to 25';
  end if;
end;
$assert_privacy_floor_definitions$;

-- 2. Raise stored organization values under 25, with an audit row for each.
with previous as (
  select v.organization_id, v.setting_key, v.value
  from public.organization_setting_values v
  where v.setting_key in ('limits.analytics.anonymity_floor', 'limits.analytics.chapter_health_cohort_floor')
    and case when pg_catalog.jsonb_typeof(v.value) <> 'number' then true
      else (v.value #>> '{}')::numeric < 25 end
  for update
), raised as (
  update public.organization_setting_values v
  set value = '25'::jsonb, updated_at = pg_catalog.clock_timestamp()
  from previous p
  where v.organization_id = p.organization_id and v.setting_key = p.setting_key
  returning v.organization_id, v.setting_key, p.value as previous_value
)
insert into public.organization_configuration_audit
  (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
select r.organization_id, null, 'setting_updated', r.setting_key, r.previous_value, '25'::jsonb, pg_catalog.clock_timestamp()
from raised r;

-- 3. No stored value of either key under 25, whoever writes it.
alter table public.organization_setting_values
  add constraint organization_setting_values_privacy_floor_25 check (
    case
      when setting_key not in ('limits.analytics.anonymity_floor', 'limits.analytics.chapter_health_cohort_floor') then true
      when pg_catalog.jsonb_typeof(value) <> 'number' then false
      else (value #>> '{}')::numeric >= 25
    end
  );

-- 4. The helper every aggregate RPC reads its floor through.
create or replace function private.organization_limit(p_organization_id uuid, p_key text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  configured integer := (private.organization_setting_effective(p_organization_id, p_key, 'integer') #>> '{}')::integer;
begin
  -- No stored value or registry default releases an aggregate group under 25.
  if p_key in ('limits.analytics.anonymity_floor', 'limits.analytics.chapter_health_cohort_floor') then
    return greatest(configured, 25);
  end if;
  return configured;
end;
$function$;

-- 5. Steward Pulse People: chapter and local groups use the organization
-- floor. Everything else in the body is unchanged from 20261101020040.
CREATE OR REPLACE FUNCTION public.get_steward_pulse_people(p_level text DEFAULT 'steward'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  selected_chapter text := private.current_member_chapter();
  privacy_floor integer;
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
  privacy_floor := private.organization_limit(org, 'limits.analytics.anonymity_floor');

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
    'level', p_level, 'floor', privacy_floor, 'generatedAt', pg_catalog.now(),
    'members', case when p_level = 'steward' then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', id, 'name', full_name, 'score', score,
        'scoreHidden', not pulse_score_visible, 'lastActivity', last_activity
      ) order by full_name, id) from scored
    ), '[]'::jsonb) else '[]'::jsonb end,
    'groups', case when p_level <> 'steward' then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', chapter_id, 'name', chapter_name,
        'count', case when members >= privacy_floor then members else null end,
        'score', case when members >= privacy_floor and scored_members >= privacy_floor then score else null end,
        'withheld', members < privacy_floor
      ) order by chapter_name, chapter_id) from groups
    ), '[]'::jsonb) else '[]'::jsonb end
  ) into result;
  return result;
end;
$function$
;

-- 6. Analytics workspace: each chapter health snapshot is also gated by the
-- cohort it recorded. Everything else in the body is unchanged from
-- 20261102180000.
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
  scoped_actor boolean;
  default_steward_chapters text[];
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

  -- Cached ordinary-steward authorization. The enclosing roster query
  -- already proves the target's active chapter and organization memberships.
  -- Scoped actors, private identities and legacy exceptions use the oracle.
  scoped_actor := exists(select 1 from private.chapter_role_scopes scope where scope.user_id=actor);
  default_steward_chapters := array(
        select ch.id from public.chapters ch
        left join private.chapter_access_policies target_policy on target_policy.chapter_id=ch.id
        where ch.organization_id=org
          and coalesce(target_policy.steward_grievances,true)
          and (not private.staff_mfa_required(ch.organization_id) or private.has_second_factor(actor))
          and (private.has_organization_role(ch.organization_id,array['steward'])
            or private.member_has_chapter_role(ch.id,array['steward'])
            or exists(select 1 from public.member_role_chapters r
              join public.chapters source on source.id=r.chapter_id and source.organization_id=ch.organization_id
              join public.member_chapter_memberships source_member on source_member.chapter_id=r.chapter_id and source_member.user_id=r.user_id and source_member.status='active'
              join private.chapter_access_policies policy on policy.chapter_id=r.chapter_id and policy.steward_breadth='local' and policy.steward_grievances
              where r.user_id=actor and r.role='steward' and private.member_has_chapter_role(r.chapter_id,array['steward'])))
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
  -- Scoped access: the shortcut applies only to an unscoped actor and a case
  -- with no identity privacy, where private.case_scope_and_identity_allowed
  -- is already true; every other case keeps the read oracle below.
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
        'participationScore', case when privacy.shown then least(100, activity.event_count * 10) end,
        'profileReadiness', case when privacy.shown then
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50 end,
        'followThrough', case when privacy.shown then least(100, activity.follow_count * 20) end,
        'overallScore', case when privacy.shown then pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3) end,
        'scoreHidden', not privacy.shown,
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when not privacy.shown then null
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', case when privacy.shown then activity.last_activity end
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      -- #6774: a member who hides their Pulse score keeps their row; only the
      -- activity-derived fields are withheld, and their activity is not read.
      cross join lateral (select p.pulse_score_visible or m.user_id = actor as shown) privacy
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where privacy.shown
          and e.organization_id = org
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
          and case
            when org_case_reader and not scoped_actor
              and cs.chapter_id = any(staff_chapters)
              and (may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters))
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            when not scoped_actor and not cs.is_restricted and cs.user_id<>actor
              and cs.chapter_id=any(default_steward_chapters)
              and not exists(select 1 from private.case_identity_privacy privacy where privacy.case_id=cs.id)
            then true
            else case when may_read_unassigned or cs.steward_user_id=actor or cs.coordinator_user_id=actor
                or cs.chapter_id=any(default_steward_chapters)
              then private.casework_staff_can_read(cs.id) else false end
          end
      ) cases
      where m.status = 'active'
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold
          or (latest.id is not null and latest.member_count < health_threshold),
        'score', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
          then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.member_count >= health_threshold
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
          where s.chapter_id = c.id and s.member_count >= health_threshold
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
            select s.score, s.member_count from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
            and latest.member_count >= health_threshold
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
            from public.chapter_health_snapshots s
            where s.chapter_id = c.id and s.member_count >= greatest(privacy_threshold, health_threshold)
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
$function$
;

-- create or replace keeps the existing grants unchanged.

-- organization_limit, the analytics workspace (and get_steward_pulse_people,
-- if it is reachable) sit on the reviewed account-lifecycle call graph;
-- record the new definitions,
-- and refuse to commit if the review is left incomplete.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash from private.account_lifecycle_trigger_surface() s
where s.kind = 'function'
  and ((s.schema_name = 'private' and s.object_name = 'organization_limit(p_organization_id uuid, p_key text)')
    or (s.schema_name = 'public' and s.object_name in ('get_steward_pulse_people(p_level text)', 'get_organization_analytics_workspace()')))
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash = excluded.definition_hash;

do $assert_privacy_floor_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after holding the privacy floor at 25';
  end if;
end;
$assert_privacy_floor_trigger_review$;

notify pgrst, 'reload schema';

commit;
