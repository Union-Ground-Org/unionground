-- BUG-UG-DUES-REMINDERS-STOP-AFTER-THE-500-OLDEST-DEBTS-20261122 (#9548).
-- The daily dues reminder planner took the p_limit (500) oldest past-due
-- obligations with a balance, across every organization, and only then let the
-- unique key drop the ones already planned this month. Once more than 500
-- qualified, the same 500 filled every run: obligation 501 and later were never
-- planned, and one organization's old debts crowded out every other
-- organization.
--
-- The planner now leaves out an obligation that already has this month's
-- in-app attempt before it applies its limit, and orders what is left in turns
-- across organizations: each organization's oldest obligation first, then each
-- one's second oldest, and so on. Each run still inserts at most p_limit rows;
-- the next run (the cron's next day, or a retry) starts from the obligations
-- still unplanned this month. Who qualifies, the monthly window, the channel,
-- the limit's bounds, the guards and the grants do not change.
-- Predecessor: 20261113145500 (only its default changed there; body as
-- 20260907151000 installed it).
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.plan_dues_reminder_attempts(integer,date)')
      and pg_catalog.md5(p.prosrc) = '075f0ad53895b228fecb068bc3ef8b16'
      and p.prosecdef and p.provolatile = 'v'
      and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'unreviewed public.plan_dues_reminder_attempts predecessor' using errcode = '55000';
  end if;
end;
$guard$;

-- fixed-zone: the default day is 20261113145500's, unchanged; the cron passes its own p_today and one run spans every organization, so a per-group day (#9446) is not this record's change
CREATE OR REPLACE FUNCTION public.plan_dues_reminder_attempts(p_limit integer, p_today date DEFAULT ((pg_catalog.now() AT TIME ZONE 'America/New_York'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  inserted_count integer;
  reminder_window date;
begin
  -- A case-graph writer (dues_reminder_attempts): the transaction entry gate
  -- comes first, as 20260907151000 installed it for the prior definition.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 500 or p_today is null then
    raise exception 'invalid dues reminder planning limit' using errcode = '22023';
  end if;
  reminder_window := date_trunc('month', p_today)::date;
  -- An obligation already planned this month is left out before the limit, so
  -- a full run never re-reads the same oldest rows (#9548). What is left is
  -- taken in turns across organizations, each one's oldest first, so one
  -- organization's backlog cannot fill a run for the others.
  with candidates as materialized (
    select ranked.organization_id, ranked.id
    from (
      select obligation.organization_id, obligation.id, obligation.due_on,
        pg_catalog.row_number() over (
          partition by obligation.organization_id
          order by obligation.due_on asc, obligation.id asc
        ) as organization_turn
      from public.dues_obligations obligation
      where obligation.due_on < p_today
        and not exists (
          select 1 from public.dues_reminder_attempts attempt
          where attempt.organization_id = obligation.organization_id
            and attempt.obligation_id = obligation.id
            and attempt.policy_window = reminder_window
            and attempt.channel = 'in_app'
        )
        and private.organization_feature_enabled(obligation.organization_id, 'features.notifications.dues_reminders')
        and obligation.due_on <= p_today - private.organization_limit(obligation.organization_id, 'limits.notifications.dues_reminder_days_past_due')
        and private.dues_balance_cents(obligation.organization_id, obligation.id) > 0
    ) ranked
    order by ranked.organization_turn asc, ranked.due_on asc, ranked.id asc
    limit p_limit
  ), inserted as (
    insert into public.dues_reminder_attempts (organization_id, obligation_id, policy_window, channel)
    select organization_id, id, reminder_window, 'in_app'
    from candidates
    on conflict (organization_id, obligation_id, policy_window, channel) do nothing
    returning id
  )
  select count(*) into inserted_count from inserted;
  return inserted_count;
end;
$function$;

-- The account-lifecycle trigger review follows this changed function, as
-- 20261113145500 recorded it.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where surface.kind='function'
  and surface.schema_name='public'
  and pg_catalog.split_part(surface.object_name,'(',1)='plan_dues_reminder_attempts'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

commit;
