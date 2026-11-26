begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Refuse to overwrite an independently changed reader or gate implementation.
do $predecessors$
declare changed text;
begin
  select expected.signature into changed
  from (values
    ('private.mi1_write_tenant_audit(uuid,text,jsonb)', '0d998787130ac190e7cd76c0a0c98f87'),
    ('public.get_organization_analytics_snapshot()', '67823cdfbd6158625b80d73ff46f38ff'),
    ('public.get_organization_analytics_workspace()', '02725eca26abfc3f9e57a96c328f0580'),
    ('public.get_organization_coordination_extensions()', '9f0c98aed3d1926817ecf9e8fa604451'),
    ('private.lock_message_lifecycle()', '67ed01d2a82e55bc8dd3d32d8504e6ac'),
    ('public.get_member_message_actions(text,uuid)', '09d03e5901dcc8a1e0d543e86e790ba9'),
    ('public.get_member_message_reply_counts(text,uuid[])', '55f6376e8806ba88a2952784093e27af'),
    ('public.get_member_message_replies(text,uuid,uuid,timestamp with time zone,uuid,integer)', '0098f8a0b0a108899424f8e1f7038ca7'),
    ('private.lock_case_graph_statement()', 'b7924693e59b8cd14c736f6ad23356e5'),
    ('private.lock_case_graph_row_keys()', 'f68bdf1000ce4b1070c83b5568de7a83')
  ) expected(signature, source_md5)
  left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(expected.signature)
  where pg_catalog.md5(p.prosrc) is distinct from expected.source_md5
  limit 1;
  if changed is not null then
    raise exception 'lifecycle read admission predecessor changed: %', changed;
  end if;
end;
$predecessors$;

-- Read admission holds both global gates in shared mode for the transaction.
-- All ordinary writers retain the existing exclusive lifecycle-before-graph
-- order. No caller-controlled setting can select the read branch.
create function private.lifecycle_read_admitted()
returns boolean language sql volatile security definer set search_path = ''
as $function$
  select exists (
    select 1 from pg_catalog.pg_locks l
    where l.pid = pg_catalog.pg_backend_pid() and l.locktype = 'advisory'
      and l.granted and l.mode = 'ShareLock' and l.objsubid = 1
      and l.classid = ((pg_catalog.hashtextextended('message-lifecycle-global', 0) >> 32) & 4294967295)::oid
      and l.objid = (pg_catalog.hashtextextended('message-lifecycle-global', 0) & 4294967295)::oid
  ) and exists (
    select 1 from pg_catalog.pg_locks l
    where l.pid = pg_catalog.pg_backend_pid() and l.locktype = 'advisory'
      and l.granted and l.mode = 'ShareLock' and l.objsubid = 2
      and l.classid = 509 and l.objid = 700
  );
$function$;
revoke all on function private.lifecycle_read_admitted() from public, anon, authenticated, service_role;

create function private.lock_case_graph_read()
returns void language plpgsql volatile security definer set search_path = ''
as $function$
declare previous_lock_timeout text;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'message preservation requires read committed isolation' using errcode = '40001';
  end if;
  previous_lock_timeout := pg_catalog.current_setting('lock_timeout');
  if previous_lock_timeout::interval = interval '0 seconds'
     or previous_lock_timeout::interval > interval '3 seconds' then
    perform pg_catalog.set_config('lock_timeout', '3s', true);
  end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('message-lifecycle-global', 0));
  perform pg_catalog.pg_advisory_xact_lock_shared(509, 700);
  perform pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
end;
$function$;
revoke all on function private.lock_case_graph_read() from public, anon, authenticated, service_role;

-- Only these reviewed reader bodies change admission. Authorization, PIN/MFA,
-- tenant predicates, redaction, audit payloads and privileges stay byte-identical.
CREATE OR REPLACE FUNCTION private.mi1_write_tenant_audit(p_organization_id uuid, p_event_type text, p_metadata jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not private.lifecycle_read_admitted() then
    perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  end if;

declare
  request_role text := coalesce((select auth.jwt() ->> 'role'), '');
  audit_actor uuid := (select auth.uid());
  audit_actor_text text;
begin
  if p_organization_id is null or not exists (
    select 1
    from public.organizations organization
    where organization.id = p_organization_id
  ) then
    raise exception 'audit organization unavailable' using errcode = '42501';
  end if;
  if request_role <> 'service_role'
     and p_organization_id is distinct from private.current_member_organization() then
    raise exception 'audit organization is derived from the session' using errcode = '42501';
  end if;
  if request_role = 'service_role' then
    audit_actor_text := coalesce(
      nullif(p_metadata ->> 'requestedBy', ''),
      nullif(p_metadata ->> 'userId', '')
    );
    if audit_actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      audit_actor := audit_actor_text::uuid;
    elsif p_event_type = 'dues_checkout_attention_resolved'
       and coalesce(p_metadata ->> 'reservationId', '')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select reservation.requested_by into audit_actor
      from public.dues_checkout_reservations reservation
      where reservation.organization_id = p_organization_id
        and reservation.id = (p_metadata ->> 'reservationId')::uuid;
    end if;
    if audit_actor is null or not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = audit_actor
    ) then
      raise exception 'service audit actor unavailable' using errcode = '42501';
    end if;
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id,
    p_event_type,
    audit_actor,
    extensions.gen_random_uuid(),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
end;
$function$;
CREATE OR REPLACE FUNCTION public.get_organization_analytics_snapshot()
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
  period_end timestamptz := pg_catalog.date_trunc('month', generated);
  period_start timestamptz := pg_catalog.date_trunc('month', generated) - interval '6 months';
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  attendance_start timestamptz := generated - interval '180 days';
  result jsonb;
  snapshot_id uuid := extensions.gen_random_uuid();
  published_rows integer;
  withheld_rows integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  result := pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'label', c.name,
        'memberCount', case when member_totals.value >= privacy_threshold
          then (pg_catalog.floor(member_totals.value / 5.0) * 5)::integer else null end,
        'memberCountSuppressed', member_totals.value < privacy_threshold,
        'stewardCount', case when steward_totals.value >= privacy_threshold
          and member_totals.value - steward_totals.value >= privacy_threshold
          then (pg_catalog.floor(steward_totals.value / 5.0) * 5)::integer else null end,
        'stewardCountSuppressed', steward_totals.value < privacy_threshold
          or member_totals.value - steward_totals.value < privacy_threshold
      ) order by c.name, c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value from public.member_chapter_memberships m
        where m.chapter_id = c.id and m.status = 'active'
      ) member_totals
      cross join lateral (
        select pg_catalog.count(distinct rc.user_id) as value
        from public.member_role_chapters rc
        join public.member_chapter_memberships m
          on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
        where rc.chapter_id = c.id and rc.role = 'steward'
      ) steward_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'chapterId', counted.chapter_id, 'status', counted.status,
        'step', counted.step_bucket, 'workplaceKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.status, counted.case_type, counted.step_bucket)
      from (
        select cs.chapter_id, cs.status,
          case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket,
          cs.case_type, pg_catalog.count(distinct cs.user_id) as person_count
        from public.member_cases cs
        where cs.organization_id = org and cs.chapter_id is not null
          and cs.created_at >= period_start and cs.created_at < period_end
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(distinct cs.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    -- OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
    -- ( AUTHENTICATED PAGE-VIEW PRODUCER):
    -- public.record_workspace_page_view fills organization_page_views and
    -- writes one page_view engagement event per (person, path, minute). A
    -- (path, hat, day) total is published, rounded down to 5, only when it is
    -- itself at least privacy_threshold and at least privacy_threshold
    -- distinct people viewed that path that day (the page_view events carry
    -- the path before '|'), so a request total never stands in for a small
    -- person cohort.
    'usageViews', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'path', v.path, 'hat', v.hat, 'day', v.day,
        'count', (pg_catalog.floor(v.view_count / 5.0) * 5)::integer
      ) order by v.day, v.path, v.hat)
      from public.organization_page_views v
      where v.organization_id = org
        and v.day > ((generated - interval '30 days') at time zone 'UTC')::date
        and v.day <= (generated at time zone 'UTC')::date
        and v.view_count >= privacy_threshold
        and (
          select pg_catalog.count(distinct e.user_id)
          from public.organization_engagement_events e
          where e.organization_id = org and e.event_type = 'page_view'
            and e.occurred_at >= (v.day::timestamp at time zone 'UTC')
            and e.occurred_at < ((v.day + 1)::timestamp at time zone 'UTC')
            and pg_catalog.split_part(e.source_id, '|', 1) = v.path
        ) >= privacy_threshold
    ), '[]'::jsonb),
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        -- Distinct people with any engagement event (page views included) in
        -- the last day / 7 days / 30 days, rounded down to 5. Nested windows
        -- permit complement differencing, so an outer window is published only
        -- when the people it adds over the nearest published inner window also
        -- clear the floor.
        'dau', case when windows.dau_ok then (pg_catalog.floor(windows.dau / 5.0) * 5)::integer else null end,
        'wau', case when windows.wau_ok then (pg_catalog.floor(windows.wau / 5.0) * 5)::integer else null end,
        'mau', case when windows.mau_ok then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', not windows.dau_ok,
          'wau', not windows.wau_ok,
          'mau', not windows.mau_ok
        )
      ) from (
        select gated.dau, gated.wau, gated.mau, gated.dau_ok, gated.wau_ok,
          gated.mau >= privacy_threshold
            and case
              when gated.wau_ok then gated.mau - gated.wau >= privacy_threshold
              when gated.dau_ok then gated.mau - gated.dau >= privacy_threshold
              else true
            end as mau_ok
        from (
          select counted.dau, counted.wau, counted.mau,
            counted.dau >= privacy_threshold as dau_ok,
            counted.wau >= privacy_threshold
              and (counted.dau < privacy_threshold or counted.wau - counted.dau >= privacy_threshold) as wau_ok
          from (
            select
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '1 day') as dau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '7 days') as wau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '30 days') as mau
            from public.organization_engagement_events where organization_id = org
          ) counted
        ) gated
      ) windows
    ),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', c.id,
        'openCases', case when case_totals.value >= privacy_threshold and case_totals.minimum_cell >= privacy_threshold
          then (pg_catalog.floor(case_totals.value / 5.0) * 5)::integer else null end,
        'openCasesSuppressed', case_totals.value < privacy_threshold or case_totals.minimum_cell < privacy_threshold,
        -- Share of recorded roster slots marked present over 180 days; guests
        -- are not on the roster. Published only when both the attending and
        -- the non-attending cohorts clear the person floor, so the rate cannot
        -- disclose a small absent cohort by complement.
        'attendanceRate', case when attendance_totals.present_people >= privacy_threshold
          and attendance_totals.missed_people >= privacy_threshold
          and attendance_totals.roster_rows > 0
          then pg_catalog.round(100.0 * attendance_totals.present_rows / attendance_totals.roster_rows, 0)
          else null end,
        -- Mean per-member engagement score (the client taxonomy's caps and
        -- weights, 180 days) over the chapter's active members.
        'engagementMean', case when engagement_totals.members >= privacy_threshold
          then pg_catalog.round(engagement_totals.mean_score, 1) else null end,
        -- Page-view totals are not person-level, so chapter portal use is the
        -- rounded 30-day distinct-person cohort of active members seen online.
        'usageViews', case when usage_totals.value >= privacy_threshold
          then (pg_catalog.floor(usage_totals.value / 5.0) * 5)::integer else null end
      ) order by c.id)
      from public.chapters c
      cross join lateral (
        select totals.value, minima.minimum_cell
        from (
          select pg_catalog.count(distinct cs.user_id) as value
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
            and cs.created_at >= period_start and cs.created_at < period_end
        ) totals
        cross join (
          select coalesce(pg_catalog.min(cell.cell_people), 0) as minimum_cell
          from (
            select pg_catalog.count(distinct cs.user_id) as cell_people
            from public.member_cases cs
            where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
              and cs.created_at >= period_start and cs.created_at < period_end
            group by cs.case_type, case when cs.step in ('Intake', 'intake') then 0 else 2 end
          ) cell
        ) minima
      ) case_totals
      cross join lateral (
        select
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status <> 'present') as missed_people,
          pg_catalog.count(*) as roster_rows,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_rows
        from public.meeting_attendance ma
        join public.chapter_records r on r.id = ma.record_id and r.chapter_id = ma.chapter_id
        where ma.chapter_id = c.id
          and ma.attendance_status in ('present', 'absent', 'excused')
          and r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
      ) attendance_totals
      cross join lateral (
        select pg_catalog.count(*) as members,
          coalesce(pg_catalog.avg(coalesce(scored.score, 0)), 0) as mean_score
        from public.member_chapter_memberships m
        left join (
          select per_type.user_id,
            least(100, pg_catalog.sum(least(per_type.event_count::numeric / weights.cap, 1) * weights.weight)) as score
          from (
            select e.user_id, e.event_type, pg_catalog.count(*) as event_count
            from public.organization_engagement_events e
            where e.organization_id = org and e.chapter_id = c.id
              and e.occurred_at >= generated - interval '180 days'
            group by e.user_id, e.event_type
          ) per_type
          join (values
            ('meeting_check_in', 10, 30),
            ('qa_contribution', 15, 25),
            ('poll_vote', 5, 10),
            ('survey_response', 3, 10),
            ('event_rsvp', 8, 15),
            ('authorized_contact', 5, 10)
          ) as weights(event_type, cap, weight) on weights.event_type = per_type.event_type
          group by per_type.user_id
        ) scored on scored.user_id = m.user_id
        where m.chapter_id = c.id and m.status = 'active'
      ) engagement_totals
      cross join lateral (
        select pg_catalog.count(distinct p.user_id) as value
        from public.member_presence p
        join public.member_chapter_memberships m
          on m.user_id = p.user_id and m.chapter_id = c.id and m.status = 'active'
        where p.organization_id = org and p.last_seen_at >= generated - interval '30 days'
      ) usage_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'heatmapPoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'kind', 'grievance', 'rowKey', counted.chapter_id,
        'colKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.case_type)
      from (
        with scoped as (
          select cs.user_id, cs.chapter_id, cs.case_type, cs.status,
            case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id is not null
            and cs.created_at >= period_start and cs.created_at < period_end
        ), totals as (
          select scoped.chapter_id, scoped.case_type,
            pg_catalog.count(distinct scoped.user_id) as person_count
          from scoped group by scoped.chapter_id, scoped.case_type
        ), minima as (
          select cells.chapter_id, cells.case_type, pg_catalog.min(cells.cell_people) as minimum_cell
          from (
            select scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket,
              pg_catalog.count(distinct scoped.user_id) as cell_people
            from scoped
            group by scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket
          ) cells
          group by cells.chapter_id, cells.case_type
        )
        select totals.chapter_id, totals.case_type, totals.person_count
        from totals join minima using (chapter_id, case_type)
        where totals.person_count >= privacy_threshold and minima.minimum_cell >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', counted.chapter_id,
        'eventType', counted.event_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.event_type)
      from (
        select e.chapter_id, e.event_type, pg_catalog.count(distinct e.user_id) as person_count
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
        group by e.chapter_id, e.event_type
        having pg_catalog.count(distinct e.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementHistogram', pg_catalog.jsonb_build_object(
      'organizationId', org, 'privacyThreshold', privacy_threshold
    ),
    -- One row per recorded meeting in the last 180 days (newest 200). Counts
    -- are distinct people (one attendance row per record and member), rounded
    -- down to 5 and withheld below the person floor. The roster (rsvpGoing) is
    -- published only when the non-attending cohort also clears the floor, so
    -- rsvpGoing minus checkIns cannot disclose a small absent cohort.
    'attendanceEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'id', counted.record_id, 'chapterId', counted.chapter_id,
        'startsAt', counted.occurred_at,
        'checkIns', case when counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.present_people / 5.0) * 5)::integer else null end,
        'rsvpGoing', case when counted.present_people >= privacy_threshold
          and counted.roster_people - counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.roster_people / 5.0) * 5)::integer else null end
      ) order by counted.occurred_at desc, counted.record_id)
      from (
        select r.id as record_id, r.chapter_id, r.occurred_at,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(*) filter (where ma.attendance_status in ('present', 'absent', 'excused')) as roster_people
        from public.chapter_records r
        join public.chapters c on c.id = r.chapter_id and c.organization_id = org
        join public.meeting_attendance ma on ma.record_id = r.id and ma.chapter_id = r.chapter_id
        where r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
        group by r.id, r.chapter_id, r.occurred_at
        order by r.occurred_at desc, r.id
        limit 200
      ) counted
    ), '[]'::jsonb),
    'attendanceCohorts', pg_catalog.jsonb_build_object(
      'organizationId', org, 'firstTime', null, 'repeat', null, 'suppressed', true
    )
  );
  -- Server-derived export counts for this issued snapshot: every published
  -- row, and the rows that carry at least one withheld (null) measure.
  select pg_catalog.count(*)::integer,
    (pg_catalog.count(*) filter (where exists (
      select 1 from pg_catalog.jsonb_each(published.value) field
      where field.value = 'null'::jsonb
    )))::integer
  into published_rows, withheld_rows
  from pg_catalog.jsonb_array_elements(
    (result -> 'chapters') || (result -> 'cases') || (result -> 'series')
      || (result -> 'heatmapPoints') || (result -> 'engagementCounts')
      || (result -> 'attendanceEvents')
  ) published;
  result := result || pg_catalog.jsonb_build_object('snapshotId', snapshot_id);
  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surface', 'organization_analytics_snapshot',
    'entityId', snapshot_id, 'rowCount', published_rows, 'suppressedCount', withheld_rows
  ));
  return result;
end;
end;
$function$;
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
begin
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
          and private.casework_staff_can_access(cs.id)
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
$function$;
CREATE OR REPLACE FUNCTION public.get_organization_coordination_extensions()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph_read();

declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  staff boolean;
  merger_staff boolean;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if organization is null then
    return pg_catalog.jsonb_build_object(
      'state', 'empty', 'organizationId', null,
      'directory', '[]'::jsonb, 'permissions', '[]'::jsonb,
      'invitations', '[]'::jsonb, 'badges', '[]'::jsonb,
      'recentActivity', '[]'::jsonb, 'organizationParticipants', '[]'::jsonb,
      'userParticipants', '[]'::jsonb, 'mergeMatches', '[]'::jsonb,
      'mergeJobs', '[]'::jsonb, 'pageAttachments', '[]'::jsonb,
      'mobilizationProgress', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(organization) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  staff := private.organization_coordination_is_staff(organization);
  merger_staff := private.has_organization_role(organization, array['admin','vp']);

  insert into public.organization_network_access_events (
    actor_organization_id, subject_organization_id, actor_user_id,
    action, outcome
  )
  select organization, profile.organization_id, caller,
    'directory_viewed', 'allowed'
  from public.organization_network_directory_profiles profile
  where profile.organization_id <> organization
    and private.organization_network_can_discover(profile.organization_id)
  order by profile.organization_id
  limit 100;

  return pg_catalog.jsonb_build_object(
    'state', 'ready', 'organizationId', organization,
    'directory', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', profile.organization_id,
        'displayName', profile.display_name,
        'summary', profile.summary,
        'visibility', profile.visibility,
        'contactMode', profile.contact_mode,
        'parentOrganizationId', profile.parent_organization_id,
        'updatedAt', profile.updated_at
      ) order by profile.display_name, profile.organization_id)
      from public.organization_network_directory_profiles profile
      where private.organization_network_can_discover(profile.organization_id)
    ), '[]'::jsonb),
    'permissions', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', permission.id,
        'networkRecordId', permission.network_record_id,
        'grantorOrganizationId', permission.grantor_organization_id,
        'granteeOrganizationId', permission.grantee_organization_id,
        'capability', permission.capability,
        'status', permission.status,
        'updatedAt', coalesce(permission.revoked_at, permission.granted_at)
      ) order by permission.capability, permission.granted_at desc)
      from public.organization_network_permission_grants permission
      where permission.grantor_organization_id = organization
        or permission.grantee_organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end,
    'invitations', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', participant.record_id,
        'title', item.title,
        'kind', item.kind,
        'role', participant.role,
        'invitedAt', participant.created_at
      ) order by participant.created_at desc, participant.id desc)
      from public.organization_coordination_organization_participants participant
      join public.organization_coordination_records item
        on item.id = participant.record_id
      where participant.organization_id = organization
        and participant.status = 'invited'
    ), '[]'::jsonb) else '[]'::jsonb end,
    'badges', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'missionId', badge.mission_id,
        'alias', badge.privacy_alias,
        'badge', badge.badge_key,
        'awardedAt', badge.awarded_at
      ) order by badge.awarded_at desc, badge.badge_key)
      from public.organization_mission_badges badge
      where private.organization_coordination_can_read(badge.mission_id)
    ), '[]'::jsonb),
    'recentActivity', coalesce((
      select pg_catalog.jsonb_agg(activity.item order by activity.created_at desc)
      from (
        select event.created_at,
          pg_catalog.jsonb_build_object(
            'recordId', event.record_id,
            'type', event.event_type,
            'fromStatus', event.from_status,
            'toStatus', event.to_status,
            'pointsDelta', event.points_delta,
            'createdAt', event.created_at
          ) as item
        from public.organization_coordination_events event
        where private.organization_coordination_can_read(event.record_id)
        order by event.created_at desc, event.id desc limit 100
      ) activity
    ), '[]'::jsonb),
    'organizationParticipants', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', participant.record_id,
        'organizationId', participant.organization_id,
        'role', participant.role,
        'status', participant.status,
        'updatedAt', participant.updated_at
      ) order by participant.updated_at desc, participant.id desc)
      from public.organization_coordination_organization_participants participant
      where private.organization_coordination_can_read(participant.record_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'userParticipants', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', participant.record_id,
        'alias', participant.privacy_alias,
        'role', participant.role,
        'status', participant.status,
        'points', participant.points,
        'self', participant.user_id = caller
      ) order by participant.updated_at desc, participant.id desc)
      from public.organization_coordination_user_participants participant
      where private.organization_coordination_can_read(participant.record_id)
        and (staff or participant.user_id = caller)
    ), '[]'::jsonb),
    'mergeMatches', case when merger_staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', review.id, 'planId', review.plan_id,
        'sourceUserId', review.source_user_id,
        'targetUserId', review.target_user_id,
        'decision', review.decision, 'reviewedAt', review.reviewed_at
      ) order by review.created_at, review.id)
      from public.organization_merge_match_reviews review
      where private.organization_coordination_can_read(review.plan_id)
    ), '[]'::jsonb) else '[]'::jsonb end,
    'mergeJobs', case when merger_staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', job.id, 'planId', job.plan_id,
        'sourceOrganizationId', job.source_organization_id,
        'targetOrganizationId', job.target_organization_id,
        'status', job.status,
        'approvedMatchCount', job.approved_match_count,
        'requestedAt', job.requested_at,
        'completedAt', job.completed_at
      ) order by job.requested_at desc, job.id desc)
      from public.organization_merge_jobs job
      where job.source_organization_id = organization
        or job.target_organization_id = organization
    ), '[]'::jsonb) else '[]'::jsonb end,
    'pageAttachments', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', attachment.id, 'pageId', attachment.page_id,
        'documentId', attachment.chapter_document_id,
        'label', attachment.label, 'attachedAt', attachment.attached_at
      ) order by attachment.attached_at, attachment.id)
      from public.organization_coordination_page_attachments attachment
      where private.organization_coordination_can_read(attachment.page_id)
    ), '[]'::jsonb),
    'mobilizationProgress', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'campaignId', campaign.id,
        'title', campaign.title,
        'totalOutreach', campaign.total_outreach,
        'reached', campaign.reached,
        'committed', campaign.committed,
        'attended', campaign.attended
      ) order by campaign.title, campaign.id)
      from (
        select record.id, record.title,
          pg_catalog.count(outreach.id)::integer as total_outreach,
          pg_catalog.count(outreach.id) filter (where outreach.disposition = 'reached')::integer as reached,
          pg_catalog.count(outreach.id) filter (where outreach.disposition = 'committed')::integer as committed,
          pg_catalog.count(outreach.id) filter (where outreach.disposition = 'attended')::integer as attended
        from public.organization_coordination_records record
        left join public.organization_coordination_outreach_events outreach
          on outreach.campaign_id = record.id
        where record.organization_id = organization
          and record.kind = 'mobilization_campaign'
        group by record.id, record.title
      ) campaign
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
end;
$function$;
CREATE OR REPLACE FUNCTION public.get_member_message_actions(p_source_kind text, p_message_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

begin
  perform private.lock_case_graph_read();
  declare caller uuid := (select auth.uid()); message public.member_messages%rowtype; editable boolean := false;
  begin
    if caller is null or private.mfa_satisfied() is not true
       or p_source_kind is null or p_source_kind not in ('private', 'channel')
       or private.can_read_message_source(caller, p_source_kind,
         case when p_source_kind = 'private' then p_message_id end,
         case when p_source_kind = 'channel' then p_message_id end, null) is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if p_source_kind = 'private' then
      select * into message from public.member_messages where id = p_message_id;
      editable := message.sender_id = caller and message.redacted_at is null
        and message.created_at > pg_catalog.clock_timestamp() - interval '15 minutes'
        and private.member_message_under_legal_hold(message.conversation_id) is false
        and not exists (select 1 from public.member_messages later
          where later.conversation_id = message.conversation_id
            and (later.created_at, later.id) > (message.created_at, message.id));
    end if;
    return pg_catalog.jsonb_build_object(
      'canEdit', coalesce(editable, false),
      'saved', exists (select 1 from public.member_saved_messages s where s.owner_id = caller
        and s.source_kind = p_source_kind and coalesce(s.private_message_id, s.channel_post_id) = p_message_id),
      'reminders', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', r.id, 'remindAt', r.remind_at) order by r.remind_at, r.id)
        from public.member_message_reminders r where r.owner_id = caller and r.status = 'pending'
          and r.source_kind = p_source_kind and coalesce(r.private_message_id, r.channel_post_id) = p_message_id), '[]'::jsonb),
      'reactions', coalesce((select pg_catalog.jsonb_agg(r.reaction order by r.reaction)
        from public.member_message_reactions r where r.actor_id = caller and r.source_kind = p_source_kind
          and coalesce(r.private_message_id, r.channel_post_id) = p_message_id), '[]'::jsonb));
  end;
end;

end;
$function$;
CREATE OR REPLACE FUNCTION public.get_member_message_reply_counts(p_source_kind text, p_message_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare caller uuid := (select auth.uid()); message_id uuid; result jsonb := '{}'::jsonb; total bigint;
begin
  perform private.lock_case_graph_read();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_message_ids is null or pg_catalog.cardinality(p_message_ids) > 200 then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  foreach message_id in array p_message_ids loop
    if private.can_read_message_source(caller, p_source_kind,
        case when p_source_kind = 'private' then message_id end,
        case when p_source_kind = 'channel' then message_id end, null) is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if p_source_kind = 'private' then
      select count(*) into total from public.member_messages m
      join public.member_messages parent on parent.id = message_id
      where m.parent_message_id = parent.id and m.conversation_id = parent.conversation_id;
    else
      select count(*) into total from public.chapter_thread_posts p
      join public.chapter_thread_posts parent on parent.id = message_id
      where p.parent_post_id = parent.id and p.thread_id = parent.thread_id and p.deleted_at is null;
    end if;
    result := result || pg_catalog.jsonb_build_object(message_id::text, total);
  end loop;
  return result;
end;

end;
$function$;
CREATE OR REPLACE FUNCTION public.get_member_message_replies(p_source_kind text, p_parent_id uuid, p_target_id uuid, p_after_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare caller uuid := (select auth.uid()); parent jsonb; page jsonb; total bigint; target uuid;
begin
  perform private.lock_case_graph_read();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_target_id is null or p_limit is null or p_limit not between 1 and 100
     or (p_after_at is null) is distinct from (p_after_id is null)
     or private.can_read_message_source(caller, p_source_kind,
       case when p_source_kind = 'private' then p_parent_id end,
       case when p_source_kind = 'channel' then p_parent_id end, null) is not true then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select m.conversation_id into target from public.member_messages m where m.id = p_parent_id;
  else
    select t.space_id into target from public.chapter_thread_posts p
      join public.chapter_threads t on t.id = p.thread_id where p.id = p_parent_id;
  end if;
  if target is distinct from p_target_id then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select pg_catalog.jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
      'author_name', m.sender_name, 'parent_id', m.parent_message_id, 'edited_at', m.edited_at,
      'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason)
      into parent from public.member_messages m where m.id = p_parent_id;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select m.id, m.created_at, pg_catalog.jsonb_build_object('id', m.id, 'body', m.body,
        'created_at', m.created_at, 'author_name', m.sender_name, 'parent_id', m.parent_message_id,
        'edited_at', m.edited_at, 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) value
      from public.member_messages m where m.parent_message_id = p_parent_id and m.conversation_id = target
        and (p_after_at is null or (m.created_at, m.id) > (p_after_at, p_after_id))
      order by m.created_at, m.id limit p_limit + 1
    ) row;
  else
    select pg_catalog.jsonb_build_object('id', p.id, 'body', p.body, 'created_at', p.created_at,
      'author_name', p.author_name, 'parent_id', p.parent_post_id)
      into parent from public.chapter_thread_posts p where p.id = p_parent_id;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select p.id, p.created_at, pg_catalog.jsonb_build_object('id', p.id, 'body', p.body,
        'created_at', p.created_at, 'author_name', p.author_name, 'parent_id', p.parent_post_id) value
      from public.chapter_thread_posts p join public.chapter_thread_posts root on root.id = p_parent_id
      where p.parent_post_id = root.id and p.thread_id = root.thread_id and p.deleted_at is null
        and (p_after_at is null or (p.created_at, p.id) > (p_after_at, p_after_id))
      order by p.created_at, p.id limit p_limit + 1
    ) row;
  end if;
  total := (public.get_member_message_reply_counts(p_source_kind, array[p_parent_id])->>p_parent_id::text)::bigint;
  return pg_catalog.jsonb_build_object('parent', parent, 'replies',
    case when pg_catalog.jsonb_array_length(page) > p_limit then page - p_limit else page end,
    'count', total, 'hasMore', pg_catalog.jsonb_array_length(page) > p_limit);
end;

end;
$function$;

-- Audit INSERTs from an admitted reader cannot upgrade the global gates.
-- Direct inserts and all UPDATE/DELETE statements keep the exclusive protocol.
CREATE OR REPLACE FUNCTION private.lock_case_graph_statement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' and tg_table_schema = 'public'
     and tg_table_name in ('organization_audit_events', 'organization_network_access_events')
     and private.lifecycle_read_admitted() then
    return null;
  end if;
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  return null;
end;
$function$;
CREATE OR REPLACE FUNCTION private.lock_case_graph_row_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare auth_ids uuid[]; case_ids uuid[]; row_data jsonb; column_name text;
begin
  if tg_op = 'INSERT' and tg_table_schema = 'public'
     and tg_table_name in ('organization_audit_events', 'organization_network_access_events')
     and private.lifecycle_read_admitted() then
    return new;
  end if;
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  auth_ids := array[]::uuid[];
  case_ids := array[]::uuid[];
  for row_data in select value from pg_catalog.jsonb_array_elements(
    pg_catalog.jsonb_build_array(case when tg_op <> 'INSERT' then pg_catalog.to_jsonb(old) end,
      case when tg_op <> 'DELETE' then pg_catalog.to_jsonb(new) end)) loop
    foreach column_name in array pg_catalog.string_to_array(tg_argv[0], ',') loop
      auth_ids := pg_catalog.array_append(auth_ids, (row_data ->> column_name)::uuid);
    end loop;
    foreach column_name in array pg_catalog.string_to_array(tg_argv[1], ',') loop
      case_ids := pg_catalog.array_append(case_ids, (row_data ->> column_name)::uuid);
    end loop;
  end loop;
  perform private.lock_case_graph(auth_ids, case_ids);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.lock_message_lifecycle()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare previous_lock_timeout text;
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'message preservation requires read committed isolation' using errcode = '40001';
  end if;
  -- Existing writers re-enter in constant time even in large imports with
  -- thousands of identity locks. An uncontended upgrade is safe: this backend
  -- is the only remaining reader. Never WAIT for an upgrade while another
  -- reader exists, because two such upgrades would deadlock.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('message-lifecycle-global', 0)) then
    if private.lifecycle_read_admitted() then
      raise exception 'concurrent lifecycle read cannot upgrade to writer' using errcode = '40001';
    end if;
  end if;
  previous_lock_timeout := pg_catalog.current_setting('lock_timeout');
  if previous_lock_timeout::interval = interval '0 seconds'
     or previous_lock_timeout::interval > interval '3 seconds' then
    perform pg_catalog.set_config('lock_timeout', '3s', true);
  end if;
  -- Let 55P03 abort the write; the client already renders the busy message.
  -- An error rolls back the local setting with the failed statement/subtransaction.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message-lifecycle-global', 0));
  perform pg_catalog.set_config('lock_timeout', previous_lock_timeout, true);
end;
$function$;

-- Refresh only the changed/new functions reached by lifecycle triggers.
-- Existing trigger definitions and every unrelated reviewed body are retained.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and table_name = '' and (
  (schema_name = 'private' and pg_catalog.split_part(object_name, '(', 1) in (
    'lifecycle_read_admitted', 'lock_case_graph_read', 'lock_message_lifecycle',
    'lock_case_graph_statement', 'lock_case_graph_row_keys', 'mi1_write_tenant_audit'))
  or (schema_name = 'public' and pg_catalog.split_part(object_name, '(', 1) in (
    'get_organization_analytics_workspace', 'get_organization_analytics_snapshot',
    'get_organization_coordination_extensions', 'get_member_message_actions',
    'get_member_message_reply_counts', 'get_member_message_replies')))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $inventory$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;
commit;
