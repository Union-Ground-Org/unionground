-- BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106 (#7279)
--
-- public.get_member_onboarding_guide (20261002120000) treated every
-- member-only account with no onboarding plan as a member at the start of
-- the program. Automatic enrollment (20261002121000) deliberately never
-- backfills existing members ("real prod members must not be retro-nagged"),
-- so a long-standing member has no plan and was badged New Member with 0 of
-- N steps, a guide card above every member page and the trimmed menu. On
-- SAMPLE that was 15 of the 17 member-only Tamarack accounts, for example a
-- member since 2020.
--
-- Now a member who joined before the organization switched on its
-- onboarding program, and has not chosen the guide, is an established
-- member and gets no guide: no card, no badge, no spotlight, the full menu.
-- "Switched on" is the earliest created_at of any onboarding step the
-- organization ever wrote, active or not: turning a step off or on never
-- moves it, so a member who joined after the program started keeps an
-- unfinished guide (steps are deleted only with the whole organization,
-- plans included). "Joined before" is either the organization membership
-- created before that moment, or a member-since year
-- (public.member_profiles.member_since; blank when unknown) before that
-- moment's year. "Chosen the guide" is a plan the member started themselves
-- (start_member_onboarding_plan records them as assigned_by, or, on a plan
-- that already existed, its 'started' event), one a staff member assigned or
-- started, or one with progress. The untouched plan automatic
-- enrollment gives every new app membership (assigned_by null, not_started)
-- is not a choice, so a long-standing member who signs up for the app later
-- is not badged either. A member who joined on or after that moment is
-- guided as before. The payload reports the decision as establishedMember.
--
-- Everything else is the 20261002120000 definition unchanged: SECURITY
-- DEFINER, empty search_path, reads only the caller's own rows in the
-- session-derived organization, writes nothing, staff never reduced.
--
-- public.get_member_home_nudges (20261002134000) offered its Home onboarding
-- reminder for any unfinished plan once the guide was quiet, so an
-- established member with an untouched automatic plan was still prompted to
-- "finish onboarding". It now reads establishedMember from the same guide
-- answer and offers no onboarding reminder to an established member; the
-- passkey reminder and everything else are unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.get_member_onboarding_guide()
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
  chose_guide boolean;
  program_configured boolean;
  program_started_at timestamptz;
  membership_created_at timestamptz;
  member_since_year integer;
  established boolean := false;
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

  select p.status, p.completed_step_ids, p.assigned_by is not null or p.status <> 'not_started'
    or exists (select 1 from public.member_support_events e where e.organization_id = org and e.entity_type = 'onboarding_plan' and e.entity_id = p.id and e.event_type = 'started')
  into plan_status, plan_completed_ids, chose_guide
  from public.member_onboarding_plans p
  where p.organization_id = org and p.member_user_id = caller;
  enrolled := plan_status is not null;
  chose_guide := coalesce(chose_guide, false);
  plan_completed_ids := coalesce(plan_completed_ids, '{}'::uuid[]);

  -- An established member: joined before the program was switched on and
  -- has not chosen the guide. A plan they start themselves, or one staff
  -- assign, puts them back in the guide.
  if program_configured and not chose_guide then
    -- Every step ever written, active or not, so toggling steps never moves
    -- the start.
    select pg_catalog.min(s.created_at) into program_started_at
    from public.organization_onboarding_steps s
    where s.organization_id = org;
    select m.created_at into membership_created_at
    from public.organization_memberships m
    where m.organization_id = org and m.user_id = caller;
    select p.member_since into member_since_year
    from public.member_profiles p
    where p.id = caller;
    established := coalesce(membership_created_at < program_started_at, false)
      or coalesce(member_since_year < pg_catalog.date_part('year', program_started_at)::integer, false);
  end if;

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
  applies := member_only and program_configured and any_switch and not established;

  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'applies', applies,
    'memberOnly', member_only,
    'programConfigured', program_configured,
    'enrolled', enrolled,
    'establishedMember', established,
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
  'REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the caller''s own onboarding guide state (stage, next step, spotlight, badge, onboardingComplete, progressiveDisclosureActive) from the organization''s existing onboarding checklist and the five guidance_onboarding switches. Read-only. BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106: a member who joined before the program was switched on and has not chosen the guide is an established member and gets no guide (establishedMember).';

create or replace function public.get_member_home_nudges()
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
  established boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  -- The guided first run owns the moment (old commit d26c1051c7: the welcome
  -- tour and a nudge never compete). The public.get_member_onboarding_guide()
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
  -- BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106: the guide's
  -- established member is not prompted to finish onboarding either.
  established := coalesce((guide->>'establishedMember')::boolean, false);

  passkey_allowed := private.organization_feature_enabled(org, 'features.home.passkey_nudge')
    and private.organization_feature_enabled(org, 'features.passkey_enrollment');

  if not established and private.organization_feature_enabled(org, 'features.home.onboarding_nudge') then
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
  'REQ-UG-HOME-NUDGES-20261001: MFA-guarded; which Home nudges the caller''s organization allows (passkey nudge requires features.passkey_enrollment) and the caller''s own onboarding progress, plus the snooze length. Reads only the caller''s own onboarding plan. BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106: no onboarding reminder for the guide''s established member.';

notify pgrst, 'reload schema';

commit;
