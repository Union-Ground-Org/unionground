-- Restore an ordinary member's own rewards summary after the staff-MFA
-- hardening added restrictive policies to the backing ledgers. The definer
-- boundary is deliberately parameterless and derives every member-scoped read
-- from auth.uid(); callers cannot select another member or raw ledger rows.

create or replace function public.get_member_rewards_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  total integer;
  current_tier smallint;
  tier_row record;
  next_row record;
  streak integer;
  ytd integer;
  year_start timestamptz;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.sum(points), 0) into total
  from public.member_point_events where user_id = caller;
  current_tier := private.member_tier_of(caller);

  select tier, name, min_points into tier_row
  from public.member_reward_tiers where tier = current_tier;
  select tier, name, min_points into next_row
  from public.member_reward_tiers where tier > current_tier order by tier limit 1;

  with action_weeks as (
    select distinct pg_catalog.date_trunc('week', occurred_at) as wk
    from public.member_action_log
    where user_id = caller and action_kind <> 'seed'
  ), anchored as (
    select wk, pg_catalog.row_number() over (order by wk desc) as rn,
      pg_catalog.max(wk) over () as anchor from action_weeks
  )
  select pg_catalog.count(*) into streak from anchored
  where anchor >= pg_catalog.date_trunc('week', now()) - interval '7 days'
    and wk = anchor - ((rn - 1) * interval '7 days');

  year_start := pg_catalog.date_trunc('year', now() at time zone 'America/New_York') at time zone 'America/New_York';
  select pg_catalog.count(*) into ytd from public.member_point_events
  where user_id = caller and occurred_at >= year_start;

  return pg_catalog.jsonb_build_object(
    'totalPoints', total,
    'tierNumber', coalesce(tier_row.tier, 1),
    'tierName', coalesce(tier_row.name, 'Member'),
    'nextTierName', next_row.name,
    'pointsToGo', case when next_row.min_points is null then null else greatest(0, next_row.min_points - total) end,
    'weekStreak', coalesce(streak, 0),
    'actionsYtd', coalesce(ytd, 0)
  );
end;
$$;

revoke all on function public.get_member_rewards_summary() from public, anon, authenticated;
grant execute on function public.get_member_rewards_summary() to authenticated;
grant execute on function public.get_member_rewards_summary() to service_role;
