-- Chapter standing (design tile: "#4 CHAPTER RANK") — DELIBERATELY NOT AN
-- ORDINAL RANK. This is the one place the implementation refuses the design.
--
-- An ordinal rank is a comparison oracle over ledgers four migrations keep
-- own-row-only: the price list is world-readable, the mint deterministic, so
-- "#4 of N" hands a member a subtraction machine against their neighbours'
-- point totals; ties disclose exact equality; #1 is unique by construction;
-- and "of N" publishes chapter activation drift. The P4c workload pre-mortem
-- caught exactly this class (window differencing) and its fix is inherited
-- here wholesale:
--
--   * K = 25 cohort floor — below it the RPC says only enoughData:false;
--   * BANDS, not ordinals — top10 / top25 / topHalf / active;
--   * banded cohort size, never N;
--   * the window is the LAST COMPLETE QUARTER (America/New_York), frozen, so
--     acting and re-checking moves nothing until the quarter closes;
--   * no member ids, no totals, no fallback to an org-wide cohort.
--
-- MFA-gated like every other definer read (private.mfa_satisfied), invoked
-- directly because standing is a member self-read, not a role surface.

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
  my_total integer;
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

  select count(distinct e.user_id)::integer into cohort
  from public.member_point_events e
  join public.member_profiles p on p.id = e.user_id
  where p.chapter_id = caller_chapter
    and e.occurred_at >= q_start
    and e.occurred_at < q_end;

  if cohort < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minCohort', k, 'period', period_label, 'generatedAt', now());
  end if;

  select coalesce(sum(e.points), 0)::integer into my_total
  from public.member_point_events e
  where e.user_id = caller
    and e.occurred_at >= q_start
    and e.occurred_at < q_end;

  select count(*)::integer into ahead
  from (
    select e.user_id
    from public.member_point_events e
    join public.member_profiles p on p.id = e.user_id
    where p.chapter_id = caller_chapter
      and e.occurred_at >= q_start
      and e.occurred_at < q_end
    group by e.user_id
    having sum(e.points) > my_total
  ) better;

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
