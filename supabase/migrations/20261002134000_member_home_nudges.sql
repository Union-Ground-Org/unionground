-- REQ-UG-HOME-NUDGES-20261001
--
-- Restore-everything campaign,. The old app nudged members two
-- ways, and this restores both in ONE Home slot that shows at most one nudge:
--   * passkey registration (de7df4b57c^:components/passkey-register-nudge.tsx,
--     mounted for every signed-in member without a passkey at
--     app/dashboard/layout.tsx:167-168 and app/m/layout.tsx:87; eligible 10
--     minutes after sign-in, suppressed until the welcome tour was dismissed by
--     commit d26c1051c7, compacted by 4172d0c5b2, "Not now" snoozes it);
--   * onboarding incomplete (components/home/member-onboarding-nudge.tsx,
--     rendered unconditionally at components/home/member-home-shell.tsx:339:
--     "Complete your onboarding - Step N of M").
--
-- public.get_member_home_nudges() tells Home which nudges the organization
-- allows and the member's onboarding progress, and offers none while the
-- guided first run is active ('s public.get_member_onboarding_guide:
-- progressiveDisclosureActive / onboardingComplete, read when installed). The server enforces both
-- switches (and the existing features.passkey_enrollment setting for the
-- passkey nudge). Whether the member already has a passkey is read on the
-- device from GoTrue's own passkey list, never stored here; dismissals and
-- snoozes are device-local too. No table, column or per-user log is added.
--
-- Defaults (old effective production values, D2):
--   features.home.passkey_nudge   on  (no flag; layout.tsx:167 rendered it for
--                                     every member without a passkey)
--   features.home.onboarding_nudge on (no flag; member-home-shell.tsx:339)
--   limits.home.nudge_snooze_days  28 (de7df4b57c^:lib/reminders/reminder-policy.ts:3
--                                     REMINDER_DISMISS_COOLDOWN_MS = 28 days)

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.home.passkey_nudge', 'boolean', 'Passkey nudge on Home',
   'Suggest adding a passkey to members who have none, when passkey enrollment is on. Shown one nudge at a time, never during the welcome tour.',
   'true'::jsonb, null, null, null, 1340, 'home', true),
  ('features.home.onboarding_nudge', 'boolean', 'Onboarding nudge on Home',
   'Remind members with an unfinished onboarding checklist to continue it. Shown one nudge at a time, never during the welcome tour.',
   'true'::jsonb, null, null, null, 1341, 'home', true),
  ('limits.home.nudge_snooze_days', 'integer', 'Snooze a dismissed Home nudge (days)',
   'Days a Home nudge stays hidden on a device after the member chooses Not now.',
   '28'::jsonb, 1, 365, null, 1342, 'home', true)
on conflict (key) do nothing;

create function public.get_member_home_nudges()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  passkey_allowed boolean;
  onboarding jsonb := null;
  total_steps integer;
  done_steps integer;
  plan_status text;
  plan_steps uuid[];
  guide jsonb;
  guided boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  -- The guided first run owns the moment (old commit d26c1051c7: the welcome
  -- tour and a nudge never compete). 's public.get_member_onboarding_guide
  -- reports it (progressiveDisclosureActive, or its guide card showing an
  -- unfinished checklist); while it is active no nudge is offered. If that
  -- function is absent or refuses, the guide is treated as inactive. Looked
  -- up by name so this migration does not depend on L3's landing order.
  if pg_catalog.to_regprocedure('public.get_member_onboarding_guide()') is not null then
    begin
      execute 'select public.get_member_onboarding_guide()' into guide;
    exception when others then
      guide := null;
    end;
  end if;
  guided := coalesce((guide->>'progressiveDisclosureActive')::boolean, false)
    or (coalesce((guide->>'showHud')::boolean, false) and (guide->>'onboardingComplete') = 'false');
  if guided then
    return pg_catalog.jsonb_build_object(
      'passkey', false,
      'onboarding', null,
      'guidedFirstRun', true,
      'snoozeDays', private.organization_limit(org, 'limits.home.nudge_snooze_days')
    );
  end if;

  passkey_allowed := private.organization_feature_enabled(org, 'features.home.passkey_nudge')
    and private.organization_feature_enabled(org, 'features.passkey_enrollment');

  if private.organization_feature_enabled(org, 'features.home.onboarding_nudge') then
    select p.status, p.completed_step_ids into plan_status, plan_steps
    from public.member_onboarding_plans p
    where p.organization_id = org and p.member_user_id = caller;
    if found and plan_status <> 'completed' then
      select pg_catalog.count(*)::integer,
             pg_catalog.count(*) filter (where s.id = any(coalesce(plan_steps, array[]::uuid[])))::integer
      into total_steps, done_steps
      from public.organization_onboarding_steps s
      where s.organization_id = org and s.active;
      if total_steps > 0 and done_steps < total_steps then
        onboarding := pg_catalog.jsonb_build_object('completed', done_steps, 'total', total_steps);
      end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'passkey', coalesce(passkey_allowed, false),
    'onboarding', onboarding,
    'guidedFirstRun', false,
    'snoozeDays', private.organization_limit(org, 'limits.home.nudge_snooze_days')
  );
end;
$function$;

revoke all on function public.get_member_home_nudges() from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_nudges() to authenticated;

comment on function public.get_member_home_nudges() is
  'REQ-UG-HOME-NUDGES-20261001: MFA-guarded; which Home nudges the caller''s organization allows (passkey nudge requires features.passkey_enrollment) and the caller''s own onboarding progress, plus the snooze length. Reads only the caller''s own onboarding plan.';

notify pgrst, 'reload schema';

commit;
