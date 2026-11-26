-- REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001
--
-- Restores the old dashboard onboarding guide (de7df4b57c^:lib/dashboard/
-- onboarding-guide.ts) on top of the CURRENT onboarding checklist
-- (public.organization_onboarding_steps + public.member_onboarding_plans,
-- CR-082, 20260829030000 / 20260924200000). No second checklist is created.
--
-- While a member-only account (no staff role in the organization) has not
-- finished its organization's onboarding checklist, the guide can:
--   * feature drip      - stage the guidance to one clear next step;
--   * HUD tooltips      - show the stage card with the next step;
--   * spotlight         - mark the next destination in the navigation;
--   * progressive nav   - show only the core member navigation until the
--                         checklist is complete (the client always offers a
--                         visible "Show everything" escape hatch);
--   * badges            - New Member -> Momentum -> Ready to Roll.
--
-- Defaults. Default ON by (2026-10-01); old app default was
-- off. The old app read each switch with getBoolean(settings, key, false)
-- (de7df4b57c^:lib/dashboard/onboarding-guide.ts:33-37; keys at
-- lib/settings/settings-keys.ts:177-181) and no old migration ever seeded
-- feature_drip_enabled, hud_tooltips_enabled, spotlight_enabled,
-- progressive_disclosure_enabled or badge_achievements_enabled, so the old
-- effective production default of every switch was OFF. They start ON here
-- and an organization admin can turn any of them off from Feature switches &
-- limits.
--
-- Signal for other surfaces ( home nudges): public.get_member_onboarding_guide
-- returns `onboardingComplete` and `progressiveDisclosureActive`.
--
-- Boundaries kept:
--   * the RPC is SECURITY DEFINER with an empty search_path, reads only the
--     caller's own plan in the session-derived organization
--     (private.member_support_selected_organization(), the same resolution
--     every member-support RPC uses, MFA included), and writes nothing;
--   * staff accounts are never reduced: the guide applies to member-only
--     accounts, matching the old `isMember` gate (de7df4b57c^:lib/dashboard/
--     view-model.ts loadDashboardSignals);
--   * an organization with no active onboarding step gets no guide (old:
--     `if (onboardingSteps.length === 0) return null`).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.guidance_onboarding.feature_drip', 'boolean', 'Feature drip',
   'While a member is onboarding, guide them one clear next step at a time instead of every feature at once.',
   'true', null, null, null, 1200, 'guidance_onboarding', true),
  ('features.guidance_onboarding.hud_tooltips', 'boolean', 'Onboarding guide card',
   'Show members a guide card with their onboarding stage and next step until the checklist is complete.',
   'true', null, null, null, 1210, 'guidance_onboarding', true),
  ('features.guidance_onboarding.spotlight', 'boolean', 'Next-step spotlight',
   'Highlight the navigation item that holds a member''s next onboarding step.',
   'true', null, null, null, 1220, 'guidance_onboarding', true),
  ('features.guidance_onboarding.progressive_disclosure', 'boolean', 'Guided navigation for new members',
   'Show only core navigation until a member finishes onboarding. Members can always choose Show everything.',
   'true', null, null, null, 1230, 'guidance_onboarding', true),
  ('features.guidance_onboarding.badge_achievements', 'boolean', 'Onboarding badges',
   'Show New Member, Momentum and Ready to Roll badges as a member moves through onboarding.',
   'true', null, null, null, 1240, 'guidance_onboarding', true)
on conflict (key) do nothing;

create function public.get_member_onboarding_guide()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  member_only boolean;
  feature_drip boolean;
  hud_tooltips boolean;
  spotlight boolean;
  progressive boolean;
  badges boolean;
  any_switch boolean;
  total_steps integer := 0;
  completed_steps integer := 0;
  plan_status text;
  plan_completed_ids uuid[] := '{}'::uuid[];
  enrolled boolean := false;
  program_configured boolean;
  complete boolean;
  momentum_at integer;
  applies boolean;
  next_step_id uuid;
  next_step_title text;
  stage text;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- The guide is optional chrome: an account the member-support resolution
  -- refuses (no MFA-backed session, no single active organization) gets an
  -- honest "unavailable" answer, never an error that blocks the shell.
  begin
    org := private.member_support_selected_organization();
  exception when insufficient_privilege then
    return pg_catalog.jsonb_build_object(
      'state', 'unavailable', 'applies', false,
      'onboardingComplete', null, 'progressiveDisclosureActive', false
    );
  end;

  feature_drip := private.organization_feature_enabled(org, 'features.guidance_onboarding.feature_drip');
  hud_tooltips := private.organization_feature_enabled(org, 'features.guidance_onboarding.hud_tooltips');
  spotlight := private.organization_feature_enabled(org, 'features.guidance_onboarding.spotlight');
  progressive := private.organization_feature_enabled(org, 'features.guidance_onboarding.progressive_disclosure');
  badges := private.organization_feature_enabled(org, 'features.guidance_onboarding.badge_achievements');
  any_switch := feature_drip or hud_tooltips or spotlight or progressive or badges;
  member_only := not private.member_support_is_staff(org);

  select pg_catalog.count(*)::integer into total_steps
  from public.organization_onboarding_steps s
  where s.organization_id = org and s.active;
  program_configured := total_steps > 0;

  select p.status, p.completed_step_ids into plan_status, plan_completed_ids
  from public.member_onboarding_plans p
  where p.organization_id = org and p.member_user_id = caller;
  enrolled := plan_status is not null;
  plan_completed_ids := coalesce(plan_completed_ids, '{}'::uuid[]);

  -- Only steps that are still active count. A plan the member already
  -- finished stays finished when an admin later adds a step, so a completed
  -- member's full navigation is never taken away again.
  select pg_catalog.count(*)::integer into completed_steps
  from public.organization_onboarding_steps s
  where s.organization_id = org and s.active and s.id = any(plan_completed_ids);
  -- No plan yet is "not complete" (plan_status is null), never an unknown.
  complete := not program_configured
    or coalesce(plan_status = 'completed', false)
    or completed_steps >= total_steps;

  if program_configured and not complete then
    select s.id, s.title into next_step_id, next_step_title
    from public.organization_onboarding_steps s
    where s.organization_id = org and s.active and not (s.id = any(plan_completed_ids))
    order by s.position, s.id
    limit 1;
  end if;

  -- Old stage boundary: Math.max(2, Math.ceil(steps / 3)).
  momentum_at := greatest(2, pg_catalog.ceil(total_steps / 3.0)::integer);
  stage := case
    when complete then 'complete'
    when completed_steps < momentum_at then 'welcome'
    else 'activate'
  end;
  applies := member_only and program_configured and any_switch;

  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'applies', applies,
    'memberOnly', member_only,
    'programConfigured', program_configured,
    'enrolled', enrolled,
    'totalSteps', total_steps,
    'completedSteps', least(completed_steps, total_steps),
    'onboardingComplete', complete,
    'progressiveDisclosureActive', applies and progressive and not complete,
    'stage', stage,
    'nextStep', case when next_step_id is null then null
      else pg_catalog.jsonb_build_object('id', next_step_id, 'title', next_step_title) end,
    'featureDrip', applies and feature_drip,
    'showHud', applies and (hud_tooltips or badges),
    'spotlight', case
      when not (applies and spotlight) then null
      when complete then 'events'
      else 'member-support'
    end,
    'badge', case
      when not (applies and badges) then null
      when complete then 'ready_to_roll'
      when completed_steps >= momentum_at then 'momentum'
      else 'new_member'
    end,
    'switches', pg_catalog.jsonb_build_object(
      'featureDrip', feature_drip,
      'hudTooltips', hud_tooltips,
      'spotlight', spotlight,
      'progressiveDisclosure', progressive,
      'badgeAchievements', badges
    )
  );
end;
$function$;

revoke all on function public.get_member_onboarding_guide() from public, anon, authenticated, service_role;
grant execute on function public.get_member_onboarding_guide() to authenticated;

comment on function public.get_member_onboarding_guide() is
  'REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the caller''s own onboarding guide state (stage, next step, spotlight, badge, onboardingComplete, progressiveDisclosureActive) from the organization''s existing onboarding checklist and the five guidance_onboarding switches. Read-only.';

notify pgrst, 'reload schema';

commit;
