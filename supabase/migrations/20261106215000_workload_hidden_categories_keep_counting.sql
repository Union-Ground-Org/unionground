-- BUG-UG-WORKLOAD-CONFIGURATION-EMPTIES-COLLECTIVE-STATS-20261106 (#7180).
-- Fix forward after 20261105192000; restamped by from 20261106140000
-- so it sorts after every migration admitted ahead of it.
-- A configured entry stores a hidden, retired or unanswered original category
-- as unknown (NULL). Both collective readers required all eight categories,
-- so hiding one category, or a member skipping one, removed the entry from
-- the 25-person cohort and turned the chapter's Stats tab and staff trends
-- off. An entry now qualifies when it measured at least one original
-- category (custom-only entries still never count), and each category is
-- aggregated only over measured values and published only when at least 25
-- contributors measured it, the rule the employment and overtime tiles
-- already use. Unknown values are never capped into 150 or turned into zero.
-- Staff trends report too few weeks when no category has two publishable
-- weekly points. Only category keys are returned; labels and visibility
-- stay client-side.
-- The employment and overtime rules are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.get_workload_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  loc_now timestamp := (pg_catalog.now() at time zone 'America/New_York');
  q_start_local timestamp := pg_catalog.date_trunc('quarter', loc_now) - interval '3 months';
  q_end_local timestamp := pg_catalog.date_trunc('quarter', loc_now);
  q_start timestamptz := q_start_local at time zone 'America/New_York';
  q_end timestamptz := q_end_local at time zone 'America/New_York';
  period_label text := pg_catalog.date_part('year', q_start_local)::int::text
    || '-Q' || pg_catalog.date_part('quarter', q_start_local)::int::text;
  n_sub integer;
  k constant integer := 25;
  cats jsonb;
  tiles jsonb;
  band text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Quarterly "give to view": a locked member gets no workload statistics.
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'quarterly_survey_gate', 'locked', true,
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'chapter_unavailable',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select pg_catalog.count(*) into n_sub from (
    select distinct on (w.user_id) w.id
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) < 8
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ) s;

  if n_sub < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'anonymity_floor',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  band := case when n_sub >= 100 then '100+' when n_sub >= 50 then '50-99' else '25-49' end;

  with latest as (
    select distinct on (w.user_id)
      w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
      w.ce_activities, w.assistance_requests, w.aged_cases,
      w.employment, case when w.ot_hours is not null then least(w.ot_hours, 40) end as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) < 8
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ), values_by_key as (
    select v.key, v.ord, least(v.value, 150)::numeric as value
    from latest l
    cross join lateral (values
      ('priority', 1, l.priority), ('pending', 2, l.pending),
      ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
      ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
      ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
    ) v(key, ord, value)
    where v.value is not null
  ), metrics as (
    select key, ord,
      pg_catalog.round(pg_catalog.avg(value)) as avg,
      pg_catalog.percentile_disc(0.5) within group (order by value) as median,
      pg_catalog.percentile_disc(0.9) within group (order by value) as p90
    from values_by_key group by key, ord
    having pg_catalog.count(*) >= k
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', key, 'avg', avg, 'median', median, 'p90', p90) order by ord), '[]'::jsonb)
  into cats from metrics;

  with latest as (
    select distinct on (w.user_id) w.employment, case when w.ot_hours is not null then least(w.ot_hours, 40) end as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) < 8
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  )
  select pg_catalog.jsonb_build_object(
    'pctFullTime', case when pg_catalog.count(employment) >= k then pg_catalog.round(100.0 * pg_catalog.avg((employment = 'full_time')::int) / 10.0) * 10 end,
    'pctPartTime', case when pg_catalog.count(employment) >= k then pg_catalog.round(100.0 * pg_catalog.avg((employment = 'part_time')::int) / 10.0) * 10 end,
    'avgOtHours', case when pg_catalog.count(ot_hours) >= k then pg_catalog.round(pg_catalog.avg(ot_hours)::numeric, 1) end)
  into tiles from latest;

  return pg_catalog.jsonb_build_object(
    'enoughData', true, 'period', period_label, 'generatedAt', pg_catalog.now(),
    'submittersBand', band, 'categories', cats, 'tiles', tiles);
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_steward_workload_intelligence(p_weeks integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  weeks integer := greatest(2, least(coalesce(p_weeks, 12), 52));
  eligible_points integer := 0;
  trends jsonb := '[]'::jsonb;
  balancing jsonb;
  reason text;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'available', false, 'reason', 'chapter_unavailable', 'eligibleWeeks', 0,
      'categories', '[]'::jsonb, 'rebalancing', pg_catalog.jsonb_build_object('stewards', '[]'::jsonb, 'suggestions', '[]'::jsonb));
  end if;
  if not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  balancing := private.workload_rebalancing(caller_chapter);

  with latest_weekly as materialized (
    select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
      pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
      w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
      w.ce_activities, w.assistance_requests, w.aged_cases
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) < 8
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
      and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
    order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
  ), eligible_weeks as materialized (
    select week_start
    from latest_weekly
    group by week_start
    having pg_catalog.count(distinct user_id) >= 25
  )
  select pg_catalog.count(*) into eligible_points from eligible_weeks;

  if eligible_points >= 2 then
    with latest_weekly as materialized (
      select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
        pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
        w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
        w.ce_activities, w.assistance_requests, w.aged_cases
      from public.member_workload_logs w
      join public.member_profiles p on p.id = w.user_id
      where p.chapter_id = caller_chapter
      and pg_catalog.num_nulls(w.priority, w.pending, w.unread_docs, w.todos, w.referrals, w.ce_activities, w.assistance_requests, w.aged_cases) < 8
      and (w.employment is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'employment' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.ot_hours is not null or exists (select 1
        from pg_catalog.jsonb_array_elements(w.workload_configuration -> 'definition' -> 'fields') f(value)
        where f.value ->> 'key' = 'otHours' and (not (f.value ->> 'visible')::boolean or (f.value ->> 'retired')::boolean)))
      and (w.workload_configuration is null or w.workload_configuration ->> 'organizationId' = (select c.organization_id::text from public.chapters c where c.id = caller_chapter))
        and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
      order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
    ), eligible as (
      select week_start from latest_weekly group by week_start
      having pg_catalog.count(distinct user_id) >= 25
    ), weekly_categories as (
      -- least() ignores NULL, so unknown values are removed before the cap.
      select l.week_start, v.key, v.ord, pg_catalog.avg(least(v.value, 150))::numeric as value
      from latest_weekly l join eligible e using (week_start)
      cross join lateral (values
        ('priority', 1, l.priority), ('pending', 2, l.pending),
        ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
        ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
        ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
      ) v(key, ord, value)
      where v.value is not null
      group by l.week_start, v.key, v.ord
      having pg_catalog.count(*) >= 25
    ), regression as (
      select key, ord, pg_catalog.count(*)::integer as points,
        pg_catalog.regr_slope(value, extract(epoch from week_start) / 604800.0)::numeric as slope,
        (pg_catalog.array_agg(value order by week_start desc))[1] as latest
      from weekly_categories group by key, ord
      having pg_catalog.count(*) >= 2
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', key, 'points', points,
      'slope', pg_catalog.round(slope, 2),
      'latest', pg_catalog.round(latest, 1),
      'forecast4Weeks', pg_catalog.round(greatest(latest + slope * 4, 0), 1)) order by ord)
    into trends from regression;
    -- Weeks can each clear the floor while no single category has two
    -- publishable weekly points; that is still too few weeks for a trend.
    if trends is null then reason := 'insufficient_weeks'; end if;
  else
    reason := case when eligible_points = 0 then 'anonymity_floor' else 'insufficient_weeks' end;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', reason is null,
    'reason', reason,
    'eligibleWeeks', eligible_points,
    'categories', coalesce(trends, '[]'::jsonb),
    'rebalancing', balancing,
    'generatedAt', pg_catalog.now());
end;
$function$;

commit;
