-- REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001 (CR-082)
--
-- Restores three pieces of the old onboarding oversight on top of the CURRENT
-- checklist (public.organization_onboarding_steps + public.member_onboarding_plans):
--
-- 1. Automatic enrollment. Old 0691_onboarding_auto_assign.sql put an AFTER
--    INSERT trigger on public.members that gave every new member a starter
--    checklist row (current_step 0, nothing completed, started_at NULL) and
--    deliberately backfilled nobody ("real prod members must not be
--    retro-nagged"). Here: when an organization membership becomes active
--    (insert, or revoked -> active), the member is enrolled in that
--    organization's own admin-authored onboarding plan with status
--    not_started. It assigns the checklist only: no case, message,
--    notification, rights progress, task or action-log row is created, and
--    nothing happens when the organization has no active step. Existing
--    members are never backfilled.
--    Default ON by (2026-10-01), as the old default was.
--    The SaaS ship-complete bar says new invited or provisioned accounts
--    start empty, and the current contract recorded "no account trigger
--    invents a plan" (scripts/db-contract.json, start_member_onboarding_plan).
--    rules that assigning the organization's own checklist
--    is not invented content, so enrollment is on by default and an
--    organization admin can turn it off with
--    features.guidance_onboarding.auto_enroll_onboarding.
-- 2. Stalled flag. Old app/dashboard/onboarding/page.tsx:48,131 flagged a
--    member under 50% done more than onboarding_alert_days (default 14) after
--    assignment. Restored as limits.guidance_onboarding.stalled_after_days (14)
--    and limits.guidance_onboarding.stalled_below_percent (50) behind
--    features.guidance_onboarding.stalled_flag (no old flag, so default ON).
-- 3. Staff complete / skip / reset of a member's steps. Old
--    app/dashboard/onboarding/actions.ts (resetProgress, skipStep) let
--    stewards and admins act on any member's progress. Restored as one
--    audited RPC behind features.guidance_onboarding.staff_step_overrides
--    (no old flag, so default ON). Every action records a
--    member_support_events row with the acting staff member and the member.
--
-- Boundaries kept: every RPC is SECURITY DEFINER with an empty search_path,
-- resolves the organization from the session
-- (private.member_support_selected_organization(), MFA included) and requires
-- the member-support staff roles. A plan outside the caller's organization is
-- "not found". Writers take the case-graph gate like every member-support
-- writer.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.guidance_onboarding.auto_enroll_onboarding', 'boolean', 'Enroll new members in onboarding',
   'When a membership becomes active, assign the organization''s onboarding checklist (assignment only, nothing else is created).',
   'true', null, null, null, 1250, 'guidance_onboarding', false),
  ('features.guidance_onboarding.stalled_flag', 'boolean', 'Flag stalled onboarding',
   'Mark members whose onboarding has stalled in the staff onboarding roster.',
   'true', null, null, null, 1260, 'guidance_onboarding', false),
  ('limits.guidance_onboarding.stalled_after_days', 'integer', 'Stalled after (days)',
   'Days after onboarding was assigned before a member under the progress threshold is flagged as stalled.',
   '14', 1, 365, null, 1270, 'guidance_onboarding', false),
  ('limits.guidance_onboarding.stalled_below_percent', 'integer', 'Stalled below (percent complete)',
   'A member below this share of completed onboarding steps after the waiting period is flagged as stalled.',
   '50', 1, 100, null, 1280, 'guidance_onboarding', false),
  ('features.guidance_onboarding.staff_step_overrides', 'boolean', 'Staff can complete, skip or reset steps',
   'Let stewards and admins complete, skip or reset a member''s onboarding steps. Every change is audited.',
   'true', null, null, null, 1290, 'guidance_onboarding', false)
on conflict (key) do nothing;

alter table public.member_support_events
  drop constraint member_support_events_event_type_check;
alter table public.member_support_events
  add constraint member_support_events_event_type_check check (event_type in (
    'saved', 'alerted', 'created', 'transitioned', 'withdrawn', 'configured',
    'started', 'step_completed', 'note_added', 'goal_saved',
    'step_skipped', 'progress_reset', 'auto_enrolled'
  ));

-- ---------------------------------------------------------------------------
-- 1. Automatic enrollment when a membership becomes active.
-- ---------------------------------------------------------------------------

create function private.auto_enroll_member_onboarding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  enabled boolean;
  plan_id uuid;
begin
  -- Case-graph gate first, like every writer of an account-lifecycle table.
  -- The membership statement trigger already holds it, so this is reentrant.
  perform private.lock_case_graph(array[new.user_id], array[]::uuid[]);
  if new.status <> 'active' or (tg_op = 'UPDATE' and old.status = 'active') then
    return new;
  end if;
  -- The switch is read straight from the registry (override, else default),
  -- the settings helper's own answer, kept inline so this trigger's
  -- account-lifecycle review does not pin the helper's body.
  select coalesce(v.value, d.default_value) = 'true'::jsonb into enabled
  from public.platform_setting_definitions d
  left join public.organization_setting_values v
    on v.organization_id = new.organization_id and v.setting_key = d.key
  where d.key = 'features.guidance_onboarding.auto_enroll_onboarding';
  if not coalesce(enabled, false) then
    return new;
  end if;
  if not exists (
    select 1 from public.organization_onboarding_steps s
    where s.organization_id = new.organization_id and s.active
  ) then
    return new;
  end if;
  insert into public.member_onboarding_plans (id, organization_id, member_user_id, assigned_by)
  values (extensions.gen_random_uuid(), new.organization_id, new.user_id, null)
  on conflict (organization_id, member_user_id) do nothing
  returning id into plan_id;
  if plan_id is not null then
    insert into public.member_support_events (
      id, organization_id, actor_user_id, member_user_id, entity_type, entity_id, event_type
    ) values (
      extensions.gen_random_uuid(), new.organization_id, null, new.user_id, 'onboarding_plan', plan_id, 'auto_enrolled'
    );
  end if;
  return new;
end;
$function$;

revoke all on function private.auto_enroll_member_onboarding() from public, anon, authenticated, service_role;

create trigger auto_enroll_member_onboarding
  after insert or update of status on public.organization_memberships
  for each row execute function private.auto_enroll_member_onboarding();

-- ---------------------------------------------------------------------------
-- 2. Staff oversight roster with the stalled flag.
-- ---------------------------------------------------------------------------

create function public.get_member_onboarding_oversight()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_support_selected_organization();
  stalled_enabled boolean;
  stalled_days integer;
  stalled_percent integer;
  total_steps integer;
begin
  if not private.member_support_is_staff(org) then
    raise exception 'staff role and MFA required' using errcode = '42501';
  end if;
  stalled_enabled := private.organization_feature_enabled(org, 'features.guidance_onboarding.stalled_flag');
  stalled_days := private.organization_limit(org, 'limits.guidance_onboarding.stalled_after_days');
  stalled_percent := private.organization_limit(org, 'limits.guidance_onboarding.stalled_below_percent');
  select pg_catalog.count(*)::integer into total_steps
  from public.organization_onboarding_steps s
  where s.organization_id = org and s.active;

  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'stalledFlagEnabled', stalled_enabled,
    'stalledAfterDays', stalled_days,
    'stalledBelowPercent', stalled_percent,
    'staffOverridesEnabled', private.organization_feature_enabled(org, 'features.guidance_onboarding.staff_step_overrides'),
    'autoEnrollEnabled', private.organization_feature_enabled(org, 'features.guidance_onboarding.auto_enroll_onboarding'),
    'totalSteps', total_steps,
    'steps', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', s.id, 'title', s.title, 'position', s.position) order by s.position, s.id)
      from public.organization_onboarding_steps s
      where s.organization_id = org and s.active
    ), '[]'::jsonb),
    'members', coalesce((
      select pg_catalog.jsonb_agg(row_json order by stalled desc, updated_at desc)
      from (
        select
          pg_catalog.jsonb_build_object(
            'planId', p.id,
            'memberUserId', p.member_user_id,
            'memberLabel', private.member_support_member_label(p.member_user_id),
            'status', p.status,
            'completedStepIds', coalesce((
              select pg_catalog.jsonb_agg(s.id order by s.position, s.id)
              from public.organization_onboarding_steps s
              where s.organization_id = org and s.active and s.id = any(p.completed_step_ids)
            ), '[]'::jsonb),
            'completedSteps', done.completed,
            'percentComplete', done.percent,
            'assignedAt', p.created_at,
            'autoEnrolled', p.assigned_by is null,
            'stalled', flagged.stalled
          ) row_json,
          flagged.stalled,
          p.updated_at
        from public.member_onboarding_plans p
        cross join lateral (
          select
            pg_catalog.count(*)::integer completed,
            case when total_steps = 0 then 100
              else (pg_catalog.count(*) * 100 / total_steps)::integer end percent
          from public.organization_onboarding_steps s
          where s.organization_id = org and s.active and s.id = any(p.completed_step_ids)
        ) done
        cross join lateral (
          select coalesce(stalled_enabled, false)
            and p.status <> 'completed'
            and total_steps > 0
            and done.percent < stalled_percent
            and p.created_at < pg_catalog.now() - pg_catalog.make_interval(days => stalled_days) stalled
        ) flagged
        where p.organization_id = org
        order by flagged.stalled desc, p.updated_at desc
        limit 500
      ) roster
    ), '[]'::jsonb),
    'memberCount', (select pg_catalog.count(*) from public.member_onboarding_plans p where p.organization_id = org)
  );
end;
$function$;

revoke all on function public.get_member_onboarding_oversight() from public, anon, authenticated, service_role;
grant execute on function public.get_member_onboarding_oversight() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Staff complete / skip / reset with audit.
-- ---------------------------------------------------------------------------

create function public.staff_update_member_onboarding_plan(
  p_plan_id uuid,
  p_action text,
  p_step_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  declare
    org uuid := private.member_support_selected_organization();
    plan record;
    step_ok boolean;
    completed uuid[];
    remaining integer;
    next_status text;
  begin
    if not private.member_support_is_staff(org) then
      raise exception 'staff role and MFA required' using errcode = '42501';
    end if;
    if not private.organization_feature_enabled(org, 'features.guidance_onboarding.staff_step_overrides') then
      raise exception 'staff onboarding changes are turned off for this organization' using errcode = '42501';
    end if;
    if p_action is null or p_action not in ('complete', 'skip', 'reset') or p_idempotency_key is null then
      raise exception 'invalid onboarding change' using errcode = '22023';
    end if;
    select * into plan from public.member_onboarding_plans
    where id = p_plan_id and organization_id = org
    for update;
    if plan.id is null then
      raise exception 'onboarding plan not found' using errcode = '22023';
    end if;
    perform private.lock_case_graph(array[plan.member_user_id], array[]::uuid[]);

    if p_action = 'reset' then
      update public.member_onboarding_plans set
        completed_step_ids = '{}',
        status = 'not_started',
        started_at = null,
        completed_at = null,
        updated_at = pg_catalog.now()
      where id = plan.id;
      perform private.member_support_record_event(p_idempotency_key, org, plan.member_user_id, 'onboarding_plan', plan.id, 'progress_reset');
      return pg_catalog.jsonb_build_object('id', plan.id, 'status', 'not_started', 'completedStepIds', '[]'::jsonb);
    end if;

    select exists (
      select 1 from public.organization_onboarding_steps s
      where s.id = p_step_id and s.organization_id = org and s.active
    ) into step_ok;
    if not step_ok then
      raise exception 'onboarding step not found' using errcode = '22023';
    end if;
    completed := array(select distinct value from pg_catalog.unnest(plan.completed_step_ids || p_step_id) value);
    select pg_catalog.count(*) into remaining from public.organization_onboarding_steps s
    where s.organization_id = org and s.active and not (s.id = any(completed));
    next_status := case when remaining = 0 then 'completed' else 'in_progress' end;
    update public.member_onboarding_plans set
      completed_step_ids = completed,
      status = next_status,
      started_at = coalesce(started_at, pg_catalog.now()),
      completed_at = case when remaining = 0 then coalesce(completed_at, pg_catalog.now()) else null end,
      updated_at = pg_catalog.now()
    where id = plan.id;
    perform private.member_support_record_event(
      p_idempotency_key, org, plan.member_user_id, 'onboarding_plan', plan.id,
      case when p_action = 'skip' then 'step_skipped' else 'step_completed' end
    );
    return pg_catalog.jsonb_build_object('id', plan.id, 'status', next_status, 'completedStepIds', pg_catalog.to_jsonb(completed));
  end;
end;
$function$;

revoke all on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid) to authenticated;

comment on function public.get_member_onboarding_oversight() is
  'REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001: staff onboarding roster for the session organization with the configurable stalled flag.';
comment on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid) is
  'REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001: audited staff complete / skip / reset of a member''s onboarding steps, behind features.guidance_onboarding.staff_step_overrides.';

-- Account-lifecycle definer review: the enrollment trigger and its function
-- are new referential-action surface on public.organization_memberships.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
values
  ('trigger', 'public', 'organization_memberships', 'auto_enroll_member_onboarding', '06911ff1d9cf59cf1e954153c00b4ecb'),
  ('function', 'private', '', 'auto_enroll_member_onboarding()', 'dfc1cf55413562a245a51ae62b0adc20')
on conflict (kind, schema_name, table_name, object_name) do update
set definition_hash = excluded.definition_hash;

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after onboarding auto-enrollment';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

notify pgrst, 'reload schema';

commit;
