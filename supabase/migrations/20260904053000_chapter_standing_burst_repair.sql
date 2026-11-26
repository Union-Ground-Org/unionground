-- Keep the member bootstrap's chapter-standing read inside one points-ledger
-- pass. The prior function walked the same chapter/quarter population once to
-- count the cohort and again to count members ahead of the caller. During a
-- multi-viewport SAMPLE audit, those repeated scans multiply beside the rest
-- of the member boot fanout. A quarter-leading covering index also prevents a
-- three-year ledger from being visited just to isolate one frozen quarter.

set local statement_timeout = '30s';

-- Deliberately omit IF NOT EXISTS: a same-named manual/partial index with a
-- different definition must abort the migration instead of recording a false
-- successful repair.
create index member_point_events_occurred_user_cover_idx
  on public.member_point_events (occurred_at, user_id) include (points);

create or replace function public.get_chapter_standing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  k constant integer := 25;
  q_end timestamptz;
  q_start timestamptz;
  period_label text;
  cohort integer;
  my_total bigint;
  ahead integer;
  pct numeric;
  standing text;
  cohort_band text;
begin
  if caller is null or not (select private.mfa_satisfied()) then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select chapter_id into caller_chapter
  from public.member_profiles
  where id = caller;

  q_end := pg_catalog.date_trunc('quarter', now() at time zone 'America/New_York') at time zone 'America/New_York';
  q_start := (pg_catalog.date_trunc('quarter', now() at time zone 'America/New_York') - interval '3 months') at time zone 'America/New_York';
  period_label := pg_catalog.to_char(q_start at time zone 'America/New_York', 'YYYY "Q"Q');

  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minCohort', k, 'period', period_label, 'generatedAt', now());
  end if;

  -- MATERIALIZED is load-bearing: each aggregate below reads the compact
  -- per-member result, while the event table and profile join execute once.
  with member_totals as materialized (
    select e.user_id, pg_catalog.sum(e.points)::bigint as total
    from public.member_point_events e
    join public.member_profiles p on p.id = e.user_id
    where p.chapter_id = caller_chapter
      and e.occurred_at >= q_start
      and e.occurred_at < q_end
    group by e.user_id
  ), ranked as (
    select total,
      coalesce(
        pg_catalog.max(total) filter (where user_id = caller) over (),
        0::bigint
      ) as caller_total
    from member_totals
  )
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.max(caller_total), 0)::bigint,
    pg_catalog.count(*) filter (where total > caller_total)::integer
  into cohort, my_total, ahead
  from ranked;

  if cohort < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minCohort', k, 'period', period_label, 'generatedAt', now());
  end if;

  pct := ahead::numeric / cohort;
  standing := case
    when my_total = 0 then 'active'
    when pct < 0.10 then 'top10'
    when pct < 0.25 then 'top25'
    when pct < 0.50 then 'topHalf'
    else 'active'
  end;
  cohort_band := case
    when cohort >= 100 then '100+'
    when cohort >= 50 then '50-99'
    else '25-49'
  end;

  return pg_catalog.jsonb_build_object(
    'enoughData', true,
    'period', period_label,
    'cohortBand', cohort_band,
    'standingBand', standing,
    'generatedAt', now());
end;
$$;

revoke all on function public.get_chapter_standing() from public, anon;
grant execute on function public.get_chapter_standing() to authenticated;
