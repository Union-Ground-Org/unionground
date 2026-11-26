-- BUG-UG-PULSE-SCORE-OPT-OUT-DROPS-ANALYTICS-ROSTER-ROW-20261102 (#6774).
--
-- 20261101020040 made public.get_organization_analytics_workspace drop a
-- member's whole roster row when they turn off "show my Pulse score"
-- (member_profiles.pulse_score_visible), and 20261102005607 kept that filter.
-- The switch promises the opposite: "Your name remains on their authorized
-- member list"; only the score and last activity are hidden, as
-- public.get_steward_pulse_people already does.
--
-- The row now stays (name, chapter, active and overdue cases). For a hidden
-- member other than the caller, participationScore, profileReadiness,
-- followThrough, overallScore and lastActivityAt are null, scoreHidden is
-- true, and attention is 'urgent' for an overdue case and otherwise null,
-- because its other bands are drawn from activity. The hidden member's
-- engagement events are not read. Everything else in the body is unchanged
-- from 20261102005607 (diff against its lines 5213-5506).

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

-- Pin the predecessor so a concurrent change to the workspace is not lost.
do $assert_analytics_workspace_predecessor$
begin
  if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc
      where oid = 'public.get_organization_analytics_workspace()'::pg_catalog.regprocedure)
      <> '64fe09b0443ba0ffd2aec27402fa0e5e' then
    raise exception 'Unreviewed analytics workspace predecessor: integrate current Main before keeping hidden-score rows';
  end if;
end;
$assert_analytics_workspace_predecessor$;

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
$function$
;

-- create or replace keeps the existing grants unchanged.

-- The workspace is on the reviewed account-lifecycle call graph; record its
-- new definition, and refuse to commit if the review is left incomplete.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select s.kind,s.schema_name,s.table_name,s.object_name,s.definition_hash from private.account_lifecycle_trigger_surface() s
where s.kind = 'function' and s.schema_name = 'public' and s.object_name = 'get_organization_analytics_workspace()'
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash = excluded.definition_hash;

do $assert_analytics_workspace_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after keeping hidden-score rows';
  end if;
end;
$assert_analytics_workspace_trigger_review$;

commit;
