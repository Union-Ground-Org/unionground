-- REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029
--
-- Onboarding guide engine port, step 4 of 4: guide 2, "Per feature", for the
-- five staff keys (steward, grievance coordinator, chapter advisor, chapter
-- administrator, leadership). Project decisions (October 29, 2026, "i want it
-- all fully built functional and switched on"; Batch E decision 2.2 "Yes,
-- follow the hat"): a staff feature guide follows the hat worn, whether the
-- role is held at organization or chapter scope, and is switched on.
--
-- 1. No new switch: staff guides ride features.guidance_onboarding.
--    feature_guides (port step 3, default on, organization editable), as the
--    prototype's staff features did. An organization that turns it off stops
--    feature guides for every hat.
-- 2. private.staff_onboarding_progress: one row per person, organization and
--    step, where a step is a (role, feature) guide of the client catalogue
--    (src/features/onboardingGuideEngine/staffGuides.js) or a role's first
--    switch. It is kept apart from the member checklist (Batch E addendum A2):
--    no member reader counts it, so a staff row never changes a member's guide.
--    Private schema, no table grants; the user reference is in the
--    account-lifecycle manifest.
-- 3. public.get_staff_onboarding_guide(): the caller's staff roles in the
--    selected organization (organization grants and the selected chapter's
--    roles, the same projection as get_my_mobile_staff_scope, which also
--    applies the organization's staff two-step rule) and their guide
--    progress. Each public function checks two-step sign-in itself
--    (private.mfa_satisfied, REQ-UG-DEFINER-MFA-AUDIT). Anyone holding no
--    staff role, or without two-step sign-in, gets {"state":"hidden"}.
-- 4. Writers, each SECURITY DEFINER with an empty search_path, each answering
--    with the guide after the write, each only for a role the caller holds:
--    complete_staff_onboarding_step(p_step_id, p_idempotency_key) records the
--    real first action (the first completion is kept; a repeated key changes
--    nothing), mark_staff_onboarding_step(p_step_id, p_mark) records the card
--    seen, closed with Got it, or opened again from the list.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.staff_onboarding_progress (
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id text not null,
  seen_at timestamptz,
  got_at timestamptz,
  reopened_at timestamptz,
  completed_at timestamptz,
  completion_key text,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, user_id, step_id),
  constraint staff_onboarding_progress_step_shape
    check (step_id ~ '^(steward|coordinator|advisor|admin|vp)\.[a-z][a-z-]{0,39}$'),
  constraint staff_onboarding_progress_key_length
    check (completion_key is null or pg_catalog.char_length(completion_key) between 1 and 100)
);

revoke all on table private.staff_onboarding_progress from public, anon, authenticated, service_role;

-- The table references auth.users, so it joins the account case graph: every
-- write takes the graph lock, and each row locks its identity key.
create trigger a00_case_graph_lock before insert or update or delete on private.staff_onboarding_progress
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.staff_onboarding_progress
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_projection,
   export_inventory_basis, export_projection_version, export_domain, export_columns, exclusion_reason, note, reviewed_at)
values
  ('private', 'staff_onboarding_progress', 'user_id', 'cascade', 'excluded_with_reason', null,
   'auth_user_fk', null, null, null,
   'Which onboarding guides a staff member has seen or finished: timestamps of product guidance, with no content the person wrote.',
   'Installed action is ON DELETE CASCADE; the guide progress leaves with the account.', date '2026-10-29');

comment on table private.staff_onboarding_progress is
  'REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP4-20261029: per-person staff feature guide progress (seen, Got it, reopened, first action done), apart from the member checklist. Read and written only through the staff onboarding guide functions.';

-- The step ids the client catalogue defines, one per (role, feature) guide,
-- plus each role's first switch. Anything else is refused.
create function private.staff_onboarding_step_known(p_step_id text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_step_id = any (array[
    'steward.casework', 'steward.messages', 'steward.settings', 'steward.role-switch',
    'coordinator.casework', 'coordinator.messages', 'coordinator.settings', 'coordinator.role-switch',
    'advisor.chapter-health', 'advisor.messages', 'advisor.settings', 'advisor.role-switch',
    'admin.people', 'admin.messages', 'admin.settings', 'admin.role-switch',
    'vp.leadership', 'vp.messages', 'vp.settings', 'vp.role-switch'
  ]);
$function$;

revoke all on function private.staff_onboarding_step_known(text) from public, anon, authenticated, service_role;

-- The caller's staff roles in the selected organization as
-- [{role, scope}], from the same projection native staff authorization
-- uses. Empty without a session, without two-step sign-in, or when the
-- organization's staff two-step rule is not met.
create function private.staff_onboarding_roles()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  scope jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    return '[]'::jsonb;
  end if;
  scope := public.get_my_mobile_staff_scope();
  if coalesce((scope->>'staffAuthorized')::boolean, false) is not true or scope->>'organizationId' is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', held.role, 'scope', held.scope)
      order by pg_catalog.array_position(array['steward','coordinator','advisor','admin','vp'], held.role))
    from (
      select role_name as role,
             case when bool_or(source = 'organization') then 'organization' else 'chapter' end as scope
      from (
        select pg_catalog.jsonb_array_elements_text(coalesce(scope->'roles', '[]'::jsonb)) as role_name, 'organization' as source
        union all
        select pg_catalog.jsonb_array_elements_text(coalesce(scope->'chapterRoles', '[]'::jsonb)), 'chapter'
      ) granted
      where role_name in ('steward','coordinator','advisor','admin','vp')
      group by role_name
    ) held
  ), '[]'::jsonb);
end;
$function$;

revoke all on function private.staff_onboarding_roles() from public, anon, authenticated, service_role;

create function public.get_staff_onboarding_guide()
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
  );
end;
$function$;

-- The organization and caller for a write to p_step_id, or an error: the step
-- must be known, its role held by the caller now, and feature guides on.
create function private.staff_onboarding_write_scope(p_step_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  roles jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'authenticated session required' using errcode = '42501';
  end if;
  if p_step_id is null or not private.staff_onboarding_step_known(p_step_id) then
    raise exception 'unknown staff onboarding step' using errcode = '22023';
  end if;
  roles := private.staff_onboarding_roles();
  org := private.current_mobile_staff_organization();
  if org is null or not exists (
    select 1 from pg_catalog.jsonb_array_elements(roles) held
    where held->>'role' = pg_catalog.split_part(p_step_id, '.', 1)
  ) then
    raise exception 'staff role and two-step sign-in required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.guidance_onboarding.feature_guides') then
    raise exception 'feature guides are off for this organization' using errcode = '55000';
  end if;
  return org;
end;
$function$;

revoke all on function private.staff_onboarding_write_scope(text) from public, anon, authenticated, service_role;

create function public.complete_staff_onboarding_step(p_step_id text, p_idempotency_key text)
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

create function public.mark_staff_onboarding_step(p_step_id text, p_mark text)
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
  if p_mark is null or p_mark not in ('seen', 'got', 'reopen') then
    raise exception 'mark must be seen, got or reopen' using errcode = '22023';
  end if;
  if pg_catalog.split_part(p_step_id, '.', 2) = 'role-switch' and p_mark <> 'seen' then
    raise exception 'a role switch is only marked seen' using errcode = '22023';
  end if;
  -- "seen" keeps the first time; Got it and reopen keep the latest.
  insert into private.staff_onboarding_progress as p
    (organization_id, user_id, step_id, seen_at, got_at, reopened_at, updated_at)
  values (
    org, caller, p_step_id,
    case when p_mark = 'seen' then pg_catalog.now() end,
    case when p_mark = 'got' then pg_catalog.now() end,
    case when p_mark = 'reopen' then pg_catalog.now() end,
    pg_catalog.now()
  )
  on conflict (organization_id, user_id, step_id) do update
    set seen_at = case when p_mark = 'seen' then coalesce(p.seen_at, pg_catalog.now()) else p.seen_at end,
        got_at = case when p_mark = 'got' then pg_catalog.now() else p.got_at end,
        reopened_at = case when p_mark = 'reopen' then pg_catalog.now() else p.reopened_at end,
        updated_at = pg_catalog.now();
  return public.get_staff_onboarding_guide();
end;
$function$;

revoke all on function public.get_staff_onboarding_guide() from public, anon, authenticated, service_role;
revoke all on function public.complete_staff_onboarding_step(text, text) from public, anon, authenticated, service_role;
revoke all on function public.mark_staff_onboarding_step(text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_staff_onboarding_guide() to authenticated;
grant execute on function public.complete_staff_onboarding_step(text, text) to authenticated;
grant execute on function public.mark_staff_onboarding_step(text, text) to authenticated;

comment on function public.get_staff_onboarding_guide() is
  'Staff feature guides for the caller: staff roles held in the selected organization (organization grants and the selected chapter''s roles, staff two-step rule applied) and per-person guide progress. Others get {"state":"hidden"}; {"state":"off"} when the organization turned feature guides off.';
comment on function public.complete_staff_onboarding_step(text, text) is
  'Records the real first action of a staff feature guide for a role the caller holds. The first completion is kept; a repeated call changes nothing. Answers with the guide.';
comment on function public.mark_staff_onboarding_step(text, text) is
  'Records a staff feature guide card seen (first time kept), closed with Got it, or opened again, or a role''s first switch seen. Answers with the guide.';

insert into private.account_lifecycle_trigger_review(kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private'
  and table_name = 'staff_onboarding_progress'
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $$ begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the staff onboarding guides';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle manifest is incomplete after the staff onboarding guides';
  end if;
end; $$;

notify pgrst, 'reload schema';

commit;
