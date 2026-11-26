-- Actions YTD for the desktop dashboard tile (design: "41 ACTIONS YTD").
--
-- Ninth generation of get_member_rewards_summary: the live body is carried
-- byte-equivalent (read back from production via pg_get_functiondef on
-- 2026-07-28, project productionprojectref) plus ONE new aggregate and ONE
-- new jsonb key. No schema change, no new index: the count is a range scan
-- on member_point_events_user_occurred_idx (user_id, occurred_at desc).
--
-- DECISION (owner review): the count reads member_point_events — the PAID
-- ledger — not member_action_log. member_point_events is trigger-only
-- (20260721223851 revokes all writes from authenticated), so the tile is
-- unforgeable; member_action_log grants INSERT to authenticated, so a tile
-- fed from it would be self-reported. The cost of honesty here: actions past
-- a weekly cap earn no point event and therefore do not count. 'seed' rows
-- never reach member_point_events (no rule row pays them), so no seed filter
-- is needed on this ledger.
--
-- The year boundary is the org's year (America/New_York), computed once as a
-- timestamptz bound so the comparison stays a plain index range on
-- occurred_at rather than an expression over the column.

create or replace function public.get_member_rewards_summary()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  total integer;
  tier_row record;
  next_row record;
  streak integer;
  ytd integer;
  year_start timestamptz;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select coalesce(sum(points), 0) into total
  from public.member_point_events
  where user_id = caller;

  select tier, name, min_points into tier_row
  from public.member_reward_tiers
  where min_points <= total
  order by min_points desc
  limit 1;

  select name, min_points into next_row
  from public.member_reward_tiers
  where min_points > total
  order by min_points asc
  limit 1;

  with action_weeks as (
    select distinct pg_catalog.date_trunc('week', occurred_at) as wk
    from public.member_action_log
    where user_id = caller
      and action_kind <> 'seed'
  ), anchored as (
    select wk, pg_catalog.row_number() over (order by wk desc) as rn,
      max(wk) over () as anchor
    from action_weeks
  )
  select count(*) into streak
  from anchored
  where anchor >= pg_catalog.date_trunc('week', now()) - interval '7 days'
    and wk = anchor - ((rn - 1) * interval '7 days');

  year_start := pg_catalog.date_trunc('year', now() at time zone 'America/New_York') at time zone 'America/New_York';

  select count(*) into ytd
  from public.member_point_events
  where user_id = caller
    and occurred_at >= year_start;

  return pg_catalog.jsonb_build_object(
    'totalPoints', total,
    'tierNumber', coalesce(tier_row.tier, 1),
    'tierName', coalesce(tier_row.name, 'Member'),
    'nextTierName', next_row.name,
    'pointsToGo', case when next_row.min_points is null then null else next_row.min_points - total end,
    'weekStreak', coalesce(streak, 0),
    'actionsYtd', coalesce(ytd, 0)
  );
end;
$$;
