-- UB-WKL-01: the member UI labels these aggregates as chapter averages, so
-- both the anonymity floor and the returned values must use the caller's
-- chapter. A caller without a chapter receives the same under-threshold shape;
-- it must never fall back to a deployment-wide aggregate.

create or replace function public.get_workload_stats()
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare
  caller        uuid        := (select auth.uid());
  caller_chapter uuid;
  loc_now       timestamp   := (now() at time zone 'America/New_York');
  q_start_local timestamp   := pg_catalog.date_trunc('quarter', loc_now) - interval '3 months';
  q_end_local   timestamp   := pg_catalog.date_trunc('quarter', loc_now);
  q_start       timestamptz := q_start_local at time zone 'America/New_York';
  q_end         timestamptz := q_end_local at time zone 'America/New_York';
  period_label  text := (pg_catalog.date_part('year', q_start_local))::int::text
                        || '-Q' || (pg_catalog.date_part('quarter', q_start_local))::int::text;
  n_sub  integer;
  K constant integer := 25;
  cats   jsonb;
  tiles  jsonb;
  band   text;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;

  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minSubmitters', K, 'period', period_label, 'generatedAt', now());
  end if;

  select pg_catalog.count(*) into n_sub from (
    select distinct on (l.user_id) l.id
    from public.member_workload_logs l
    join public.member_profiles p on p.id = l.user_id
    where p.chapter_id = caller_chapter
      and l.created_at >= q_start and l.created_at < q_end
    order by l.user_id, l.created_at desc
  ) s;

  if n_sub < K then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minSubmitters', K, 'period', period_label, 'generatedAt', now());
  end if;

  band := case when n_sub >= 100 then '100+' when n_sub >= 50 then '50-99' else '25-49' end;

  with latest as (
    select distinct on (l.user_id)
      l.priority, l.pending, l.unread_docs, l.todos, l.referrals, l.ce_activities,
      l.assistance_requests, l.aged_cases, l.employment, l.ot_hours
    from public.member_workload_logs l
    join public.member_profiles p on p.id = l.user_id
    where p.chapter_id = caller_chapter
      and l.created_at >= q_start and l.created_at < q_end
    order by l.user_id, l.created_at desc
  ),
  w as (
    select
      least(priority, 150) p, least(pending, 150) pe, least(unread_docs, 150) ud,
      least(todos, 150) td, least(referrals, 150) rf, least(ce_activities, 150) ce,
      least(assistance_requests, 150) ar, least(aged_cases, 150) ag,
      employment emp, least(ot_hours, 40) oth
    from latest
  )
  select
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('key', 'priority',            'avg', pg_catalog.round(pg_catalog.avg(p))),
      pg_catalog.jsonb_build_object('key', 'pending',             'avg', pg_catalog.round(pg_catalog.avg(pe))),
      pg_catalog.jsonb_build_object('key', 'unread_docs',         'avg', pg_catalog.round(pg_catalog.avg(ud))),
      pg_catalog.jsonb_build_object('key', 'todos',               'avg', pg_catalog.round(pg_catalog.avg(td))),
      pg_catalog.jsonb_build_object('key', 'referrals',           'avg', pg_catalog.round(pg_catalog.avg(rf))),
      pg_catalog.jsonb_build_object('key', 'ce_activities',       'avg', pg_catalog.round(pg_catalog.avg(ce))),
      pg_catalog.jsonb_build_object('key', 'assistance_requests', 'avg', pg_catalog.round(pg_catalog.avg(ar))),
      pg_catalog.jsonb_build_object('key', 'aged_cases',          'avg', pg_catalog.round(pg_catalog.avg(ag)))
    ),
    pg_catalog.jsonb_build_object(
      'pctFullTime', pg_catalog.round(100.0 * pg_catalog.avg((emp = 'full_time')::int) / 10.0) * 10,
      'pctPartTime', pg_catalog.round(100.0 * pg_catalog.avg((emp = 'part_time')::int) / 10.0) * 10,
      'avgOtHours',  pg_catalog.round(pg_catalog.avg(oth)::numeric, 1))
  into cats, tiles
  from w;

  return pg_catalog.jsonb_build_object(
    'enoughData', true, 'period', period_label, 'generatedAt', now(),
    'submittersBand', band, 'categories', cats, 'tiles', tiles);
end $$;

revoke all on function public.get_workload_stats() from public, anon;
grant execute on function public.get_workload_stats() to authenticated;
