-- REQ-UG-MULTI-UNIT-SETUP-GUIDE-20261109 (#7674)
--
-- A staff feature guide step that walks a chapter lead through a multi-unit
-- chapter: create the units, give every steward one, and learn what a unit
-- keeps private and what stewards share chapter-wide. Applied recommendation:
-- a guide for the lead's own chapter, never the
-- organization start guide (project decision 2.4 keeps that one organization
-- only), with facts read for that chapter only.
--
-- 1. The step ids admin.units and vp.units join the staff guide allowlist, so
--    the card can be marked seen, closed with Got it and opened again.
-- 2. private.staff_onboarding_chapter_units(org, roles): for a caller who holds
--    the admin or vp hat and leads the selected chapter of the selected
--    organization (private.member_has_chapter_role, which also admits an
--    organization admin or vp), that chapter's units (kind unit) other than its
--    default unit, its stewards (chapter steward grants and organization
--    stewards assigned to one of its units, each person once) and how many of
--    those are not in one of those units. Since #7663 (20261113115000) every chapter
--    has a default unit holding every member not placed in another unit, and
--    every steward has a unit, so counting the default unit would mark the step
--    done before any setup. Decision:
--    the step counts units other than the default one, and a steward counts as
--    set up when placed in one of them. Nothing about another chapter or the
--    organization is read. Null for everyone else.
--    The same people already see every one of these grants and units in the
--    chapter access workspace (private.chapter_access_leadership).
-- 3. public.get_staff_onboarding_guide() answers it as chapterUnits; the key is
--    absent when the helper answers null.
-- 4. public.complete_staff_onboarding_step() refuses a units step: it finishes
--    from the chapter's facts, never from a click.
--
-- The predecessor bodies (20261030010000) were compared with
-- pg_get_functiondef on a database built from Main before this re-emission;
-- no later migration rewrote them, and the guard below refuses to apply if one
-- has since.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
-- pg_catalog alone resolves names exactly as an empty path does (it is always searched first).
set local search_path = pg_catalog;

-- Each re-emitted function must still be the reviewed 20261030010000 body.
do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.staff_onboarding_step_known(text)'))) is distinct from 'b191b96d2ca13fbc53d9df4c186f4fa9' then
    raise exception 'unreviewed predecessor: private.staff_onboarding_step_known' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_staff_onboarding_guide()'))) is distinct from '8c76fd75f608171da0bb34585d1ff7a0' then
    raise exception 'unreviewed predecessor: public.get_staff_onboarding_guide' using errcode='55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.complete_staff_onboarding_step(text, text)'))) is distinct from '9cbb7c4d83ede2874e4a819e99a0188c' then
    raise exception 'unreviewed predecessor: public.complete_staff_onboarding_step' using errcode='55000';
  end if;
end;
$predecessors$;

create or replace function private.staff_onboarding_step_known(p_step_id text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_step_id = any (array[
    'steward.casework', 'steward.messages', 'steward.settings', 'steward.role-switch',
    'coordinator.casework', 'coordinator.messages', 'coordinator.settings', 'coordinator.role-switch',
    'advisor.chapter-health', 'advisor.messages', 'advisor.settings', 'advisor.role-switch',
    'admin.people', 'admin.units', 'admin.messages', 'admin.settings', 'admin.role-switch',
    'vp.leadership', 'vp.units', 'vp.messages', 'vp.settings', 'vp.role-switch'
  ]);
$function$;

revoke all on function private.staff_onboarding_step_known(text) from public, anon, authenticated, service_role;

-- The selected chapter's unit setup for its lead, or null: the caller must
-- hold admin or vp (p_roles, from private.staff_onboarding_roles()) and lead
-- that chapter, and the chapter must belong to the selected organization.
create function private.staff_onboarding_chapter_units(p_organization_id uuid, p_roles jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  selected_chapter text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or p_organization_id is null then
    return null;
  end if;
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(coalesce(p_roles, '[]'::jsonb)) held
    where held->>'role' in ('admin', 'vp')
  ) then
    return null;
  end if;
  selected_chapter := private.current_member_chapter();
  if selected_chapter is null
     or not exists (select 1 from public.chapters c where c.id = selected_chapter and c.organization_id = p_organization_id)
     or not private.member_has_chapter_role(selected_chapter, array['admin', 'vp']) then
    return null;
  end if;
  -- A chapter's stewards are its chapter steward grants and the organization
  -- stewards assigned to one of its units (#7663 keeps both; the chapter access
  -- workspace lists both), each person once. A steward is set up when placed
  -- in one of the chapter's units other than its default one, by either route.
  return (
    with chapter_stewards as (
      select r.user_id from public.member_role_chapters r
       where r.chapter_id = selected_chapter and r.role = 'steward'
      union
      select a.user_id from private.organization_steward_unit_assignments a
       where a.chapter_id = selected_chapter and a.organization_id = p_organization_id and a.role = 'steward'
    ), placed as (
      select s.user_id from private.chapter_role_scopes s
        join private.chapter_units u on u.id = s.unit_id and u.chapter_id = s.chapter_id
       where s.chapter_id = selected_chapter and s.role = 'steward' and u.kind = 'unit' and not u.is_default
      union
      select a.user_id from private.organization_steward_unit_assignments a
        join private.chapter_units u on u.id = a.unit_id and u.chapter_id = a.chapter_id
       where a.chapter_id = selected_chapter and a.organization_id = p_organization_id and a.role = 'steward'
         and u.kind = 'unit' and not u.is_default
    )
    select pg_catalog.jsonb_build_object(
      'chapterId', selected_chapter,
      'units', (select pg_catalog.count(*)::integer from private.chapter_units u
        where u.chapter_id = selected_chapter and u.kind = 'unit' and not u.is_default),
      'stewards', (select pg_catalog.count(*)::integer from chapter_stewards),
      'stewardsWithoutUnit', (select pg_catalog.count(*)::integer from chapter_stewards cs
        where not exists (select 1 from placed p where p.user_id = cs.user_id))
    )
  );
end;
$function$;

revoke all on function private.staff_onboarding_chapter_units(uuid, jsonb) from public, anon, authenticated, service_role;

create or replace function public.get_staff_onboarding_guide()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  roles jsonb;
  units jsonb;
begin
  -- Case-graph gate first, like every reader and writer of an identity-linked table.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null then
    raise exception 'authenticated session required' using errcode = '42501';
  end if;
  -- Without two-step sign-in the caller learns nothing, not even their roles.
  if not private.mfa_satisfied() then
    return pg_catalog.jsonb_build_object('state', 'hidden');
  end if;
  roles := private.staff_onboarding_roles();
  org := private.current_mobile_staff_organization();
  if org is null or pg_catalog.jsonb_array_length(roles) = 0 then
    return pg_catalog.jsonb_build_object('state', 'hidden');
  end if;
  if not private.organization_feature_enabled(org, 'features.guidance_onboarding.feature_guides') then
    return pg_catalog.jsonb_build_object('state', 'off', 'organizationId', org);
  end if;
  -- The selected chapter's unit setup, for its lead only (absent otherwise).
  units := private.staff_onboarding_chapter_units(org, roles);
  return pg_catalog.jsonb_build_object(
    'state', 'active',
    'organizationId', org,
    'roles', roles,
    'steps', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'stepId', p.step_id,
        'seenAt', p.seen_at,
        'gotAt', p.got_at,
        'reopenedAt', p.reopened_at,
        'completedAt', p.completed_at
      ) order by p.step_id)
      from private.staff_onboarding_progress p
      where p.organization_id = org and p.user_id = caller
    ), '[]'::jsonb)
  ) || case when units is null then '{}'::jsonb else pg_catalog.jsonb_build_object('chapterUnits', units) end;
end;
$function$;

create or replace function public.complete_staff_onboarding_step(p_step_id text, p_idempotency_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
begin
  -- Case-graph gate first, like every writer of an identity-linked table.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  if not private.mfa_satisfied() then
    raise exception 'staff role and two-step sign-in required' using errcode = '42501';
  end if;
  org := private.staff_onboarding_write_scope(p_step_id);
  if pg_catalog.split_part(p_step_id, '.', 2) = 'role-switch' then
    raise exception 'a role switch is marked seen, not completed' using errcode = '22023';
  end if;
  -- The units step finishes from the chapter's units and steward grants.
  if pg_catalog.split_part(p_step_id, '.', 2) = 'units' then
    raise exception 'the units step finishes from the chapter, not completed' using errcode = '22023';
  end if;
  if p_idempotency_key is null or pg_catalog.char_length(p_idempotency_key) not between 1 and 100 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  -- The first completion is kept; a later or repeated one changes nothing.
  insert into private.staff_onboarding_progress as p
    (organization_id, user_id, step_id, completed_at, completion_key, updated_at)
  values (org, caller, p_step_id, pg_catalog.now(), p_idempotency_key, pg_catalog.now())
  on conflict (organization_id, user_id, step_id) do update
    set completed_at = coalesce(p.completed_at, excluded.completed_at),
        completion_key = coalesce(p.completion_key, excluded.completion_key),
        updated_at = case when p.completed_at is null then pg_catalog.now() else p.updated_at end;
  return public.get_staff_onboarding_guide();
end;
$function$;

revoke all on function public.get_staff_onboarding_guide() from public, anon, authenticated, service_role;
revoke all on function public.complete_staff_onboarding_step(text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_staff_onboarding_guide() to authenticated;
grant execute on function public.complete_staff_onboarding_step(text, text) to authenticated;

comment on function public.get_staff_onboarding_guide() is
  'Staff feature guides for the caller: staff roles held in the selected organization (organization grants and the selected chapter''s roles, staff two-step rule applied), per-person guide progress, and, for the selected chapter''s admin or vp lead only, chapterUnits (its units, stewards and stewards without a unit). Others get {"state":"hidden"}; {"state":"off"} when the organization turned feature guides off.';
comment on function public.complete_staff_onboarding_step(text, text) is
  'Records the real first action of a staff feature guide for a role the caller holds. The first completion is kept; a repeated call changes nothing. A role switch and the units step are refused (seen only; finished from the chapter). Answers with the guide.';

notify pgrst, 'reload schema';

commit;
