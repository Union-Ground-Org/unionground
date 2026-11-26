-- MI1 exact-head review repairs: preserve legacy organization-wide staff
-- authority during the explicit tenant-role cutover and make the legacy
-- authorization helper consume those explicit grants.

set local lock_timeout = '5s';

-- A NULL chapter_id was the historical organization-wide sentinel. Copy only
-- those global rows into each active organization membership. Chapter-local
-- role mappings remain chapter-local and are deliberately not widened.
with migrated as (
  insert into public.organization_role_grants (
    organization_id,
    user_id,
    role,
    granted_by,
    granted_at
  )
  select
    membership.organization_id,
    legacy.user_id,
    legacy.role,
    legacy.granted_by,
    legacy.granted_at
  from public.member_roles legacy
  join public.organization_memberships membership
    on membership.user_id = legacy.user_id
   and membership.status = 'active'
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
  where legacy.chapter_id is null
  on conflict (organization_id, user_id, role) do nothing
  returning organization_id, user_id, role, granted_by
)
insert into public.organization_audit_events (
  organization_id,
  event_type,
  actor_user_id,
  idempotency_key,
  metadata
)
select
  migrated.organization_id,
  'organization_role_granted',
  migrated.granted_by,
  extensions.gen_random_uuid(),
  pg_catalog.jsonb_build_object(
    'organizationId', migrated.organization_id::text,
    'userId', migrated.user_id::text,
    'role', migrated.role
  )
from migrated
-- Historical rows may predate actor attribution. Do not invent an actor for
-- immutable audit evidence; the append-only migration remains the provenance
-- for those unattributed rows.
where migrated.granted_by is not null;

create or replace function public.member_has_role(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null then false
    when not (select private.mfa_satisfied()) then false
    when not exists (
      select 1
      from public.member_profiles p
      join public.chapters selected on selected.id = p.chapter_id
      join public.organizations selected_org
        on selected_org.id = selected.organization_id
       and selected_org.status = 'active'
      join public.member_chapter_memberships cm
        on cm.user_id = p.id
       and cm.chapter_id = selected.id
       and cm.status = 'active'
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = selected.organization_id
       and om.status = 'active'
      where p.id = (select auth.uid())
        and selected.organization_id is not null
        and (
          exists (
            select 1
            from public.organization_role_grants organization_role
            where organization_role.organization_id = selected.organization_id
              and organization_role.user_id = p.id
              and organization_role.role = any(p_roles)
          )
          or exists (
            select 1
            from public.member_role_chapters chapter_role
            where chapter_role.user_id = p.id
              and chapter_role.chapter_id = selected.id
              and chapter_role.role = any(p_roles)
          )
        )
    ) and not exists (
      select 1
      from public.member_profiles p
      left join public.chapters selected on selected.id = p.chapter_id
      join public.member_roles legacy_role
        on legacy_role.user_id = p.id
       and legacy_role.role = any(p_roles)
      where p.id = (select auth.uid())
        and (select private.current_member_organization()) is null
        and (selected.id is null or selected.organization_id is null)
        and (
          legacy_role.chapter_id is null
          or exists (
            select 1
            from public.member_role_chapters chapter_role
            join public.member_chapter_memberships membership
              on membership.user_id = chapter_role.user_id
             and membership.chapter_id = chapter_role.chapter_id
            join public.chapters mapped on mapped.id = chapter_role.chapter_id
            where chapter_role.user_id = legacy_role.user_id
              and chapter_role.role = legacy_role.role
              and mapped.organization_id is null
              and membership.status = 'active'
              and chapter_role.chapter_id = p.chapter_id
          )
        )
    ) then false
    when not (select private.staff_mfa_required()) then true
    else (select private.has_second_factor((select auth.uid())))
  end;
$function$;

revoke all on function public.member_has_role(text[])
  from public, anon, authenticated, service_role;
grant execute on function public.member_has_role(text[])
  to authenticated, service_role;
comment on function public.member_has_role(text[]) is
  'Selected-tenant staff-role check. Accepts explicit organization-wide grants or an active selected-chapter mapping, preserves quarantined ownerless legacy behavior, and enforces the tenant MFA policy.';

notify pgrst, 'reload schema';
