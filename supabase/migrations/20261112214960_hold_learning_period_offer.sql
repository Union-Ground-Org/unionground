-- REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112 (#8581).
--
-- Project decision, November 12, 2026, about 10:36 PM ET: every function on the
-- weekly release calendar is turned off and invisible until its release day
-- (docs/contracts/staged-feature-releases.md). The learning period with undo
-- is on the calendar but had no switch, so nothing could hold it. This adds
-- one, already held, and makes the two entry points honour it:
--
--   * features.guidance_onboarding.learning_period: boolean, platform-only,
--     default on, not member-visible, created held (release_at 'infinity', no
--     date yet). Held, it reads false for every organization through
--     private.organization_feature_enabled (20261112061000).
--   * public.get_organization_learning_period(): while the switch is off it
--     returns null unless the organization's period is running now. The web
--     app and the iPhone and Android apps already draw nothing on a null read
--     (no offer, no Start, no banner, no Settings entry), so the installed
--     store builds follow the hold with no new build.
--   * public.start_organization_learning_period(integer): while the switch is
--     off it refuses with the refusal an organization the period is not
--     available to already gets.
--
-- A period that is already running keeps working until it ends: the read
-- still returns it, and end early, the practice history and undo are not
-- changed here. Undo is the safety part and never waits for a calendar.
-- When release_at passes, with no deploy, both functions behave as before.
-- The bodies are otherwise the newest definitions on Main: the read from
-- 20261103163000, the start from 20261108140100.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_organization_learning_period()'::regprocedure) <> 'c82cbf0bd7671f93f9234f180f8aeae3' then
    raise exception 'unreviewed predecessor: public.get_organization_learning_period()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.start_organization_learning_period(integer)'::regprocedure) <> '852a4d679d0995702067b626936e1b5b' then
    raise exception 'unreviewed predecessor: public.start_organization_learning_period(integer)' using errcode = '55000';
  end if;
end;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. The switch, held from the moment it exists.
-- ---------------------------------------------------------------------------
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable, release_at)
values
  ('features.guidance_onboarding.learning_period', 'boolean', 'Learning period with undo',
   'Platform-wide. Carries the release time of the learning period offer: until then no organization is offered one or can start one. A period already running keeps working. Organizations cannot change it.',
   'true', null, null, null, 2440, 'guidance_onboarding', false, false, 'infinity');

-- ---------------------------------------------------------------------------
-- 2. The read every learning period surface draws from.
-- ---------------------------------------------------------------------------
create or replace function public.get_organization_learning_period()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_mobile_staff_organization();
  if org is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  -- Held: nothing to show, unless the organization's period runs now.
  if private.organization_feature_enabled(org, 'features.guidance_onboarding.learning_period') is not true
     and private.learning_period_running(org) is null then
    return null;
  end if;
  return private.organization_learning_period_payload(org);
end;
$function$;
revoke all on function public.get_organization_learning_period() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_learning_period() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The start.
-- ---------------------------------------------------------------------------
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
  if not private.organization_is_union(org)
     or private.organization_feature_enabled(org, 'features.guidance_onboarding.learning_period') is not true then
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

do $review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review incomplete after the learning period hold';
  end if;
end;
$review$;
notify pgrst, 'reload schema';
commit;
