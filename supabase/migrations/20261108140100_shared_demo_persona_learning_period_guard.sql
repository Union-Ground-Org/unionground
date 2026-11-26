-- BUG-UG-SHARED-DEMO-PERSONA-CAN-START-DEMO-LEARNING-PERIOD-20261108 (#7557)
-- The SAMPLE demo entry (api/demo-session.js) hands every visitor the same six
-- fictional Tamarack persona accounts and raises the staff personas to aal2
-- with their own authenticator, so the Admin persona passes the start and
-- end-early checks of 20261103163000. The 20261107163700 guard left the
-- learning period open as reversible content, but it is not reversible: an
-- organization gets one period, it cannot be restarted, and ending it early
-- is final. A visitor in the Admin hat could therefore start or end the demo
-- organization's only period for every later visitor, from the web desk, the
-- native Account screen or a hand-made request.
--
-- Both functions now refuse a shared persona session (the same
-- private.is_shared_demo_persona_user set the 20261107120000 and
-- 20261107163700 guards use) with 42501 and hint shared-demo-account, after
-- the existing administrator check. Every other caller is unchanged: real
-- organization administrators, and the same operator override
-- (set local union_ground.shared_demo_persona_maintenance = 'on') lifts the
-- refusal for one transaction. The bodies are otherwise the 20261103163000
-- definitions, the only ones on Main. Reading the period, the practice
-- history and Undo stay open to the personas.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.start_organization_learning_period(p_length_days integer default 14)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  period uuid;
  started timestamptz := pg_catalog.now();
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied()
     or (select auth.jwt() ->> 'aal') is distinct from 'aal2'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role with verified sign-in required' using errcode = '42501';
  end if;
  if private.is_shared_demo_persona_user(caller)
     and coalesce(pg_catalog.current_setting('union_ground.shared_demo_persona_maintenance', true), '') <> 'on' then
    raise exception 'the shared demo learning period cannot be started or ended from a demo account'
      using errcode = '42501', hint = 'shared-demo-account';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'learning period unavailable for this organization' using errcode = '42501';
  end if;
  if p_length_days is null or p_length_days not in (7, 14) then
    raise exception 'invalid learning period length' using errcode = '22023';
  end if;
  insert into private.organization_learning_periods (organization_id, length_days, starts_at, ends_at, started_by)
  values (org, p_length_days, started, started + pg_catalog.make_interval(hours => p_length_days * 24), caller)
  on conflict (organization_id) do nothing
  returning id into period;
  if period is null then
    raise exception 'learning period already used' using errcode = '55000';
  end if;
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'learning_period_started', 'settings_change', caller,
    'learning_period', period::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('periodId', period, 'lengthDays', p_length_days)
  );
  return private.organization_learning_period_payload(org);
end;
end;
$function$;
revoke all on function public.start_organization_learning_period(integer) from public, anon, authenticated, service_role;
grant execute on function public.start_organization_learning_period(integer) to authenticated;

create or replace function public.end_organization_learning_period_early()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  period private.organization_learning_periods%rowtype;
  ending timestamptz;
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied()
     or (select auth.jwt() ->> 'aal') is distinct from 'aal2'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role with verified sign-in required' using errcode = '42501';
  end if;
  if private.is_shared_demo_persona_user(caller)
     and coalesce(pg_catalog.current_setting('union_ground.shared_demo_persona_maintenance', true), '') <> 'on' then
    raise exception 'the shared demo learning period cannot be started or ended from a demo account'
      using errcode = '42501', hint = 'shared-demo-account';
  end if;
  select * into period from private.organization_learning_periods p where p.organization_id = org for update;
  ending := pg_catalog.clock_timestamp();
  if not found or period.closed_at is not null or period.ended_early_at is not null
     or ending >= period.ends_at or ending < period.starts_at then
    raise exception 'learning period not running' using errcode = '55000';
  end if;
  update private.organization_learning_periods p
  set ended_early_at = ending, ended_early_by = caller
  where p.id = period.id;
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'learning_period_ended_early', 'settings_change', caller,
    'learning_period', period.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('periodId', period.id)
  );
  perform private.finish_learning_period(period.id);
  return private.organization_learning_period_payload(org);
end;
end;
$function$;
revoke all on function public.end_organization_learning_period_early() from public, anon, authenticated, service_role;
grant execute on function public.end_organization_learning_period_early() to authenticated;

do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after the shared demo learning-period guard';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
