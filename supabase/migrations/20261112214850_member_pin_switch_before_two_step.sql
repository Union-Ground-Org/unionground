-- BUG-UG-HELD-MEMBER-PIN-STILL-SHOWS-20261112 (#8586).
--
-- While features.security.member_pin_signin is held for its release day
-- (docs/contracts/staged-feature-releases.md: held means invisible), a member
-- enrolled in two-step sign-in still saw the PIN card on web and native:
-- private.member_pin_ineligibility answered 'mfa_enrolled' before it read the
-- switch, and both screens explain an MFA refusal with a card.
--
-- The switch is now read first, through private.organization_feature_enabled
-- (off for every organization while the key is held), so a member of an
-- organization where PIN sign-in is off or held gets 'disabled_by_organization'
-- whatever their two-step state, the same answer a member without two-step
-- already got there. Installed store builds already hide the card for that
-- answer. Where PIN sign-in is on, every answer is unchanged.
--
-- From 20261003040000 verbatim, except the order of the switch and two-step
-- checks. The function stays a pure read: no lock, no write.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.member_pin_ineligibility(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_user_id is null or not exists (
    select 1 from auth.users u
    where u.id = p_user_id
      and u.deleted_at is null
      and u.email_confirmed_at is not null
      and u.email is not null
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
      and not coalesce(u.is_anonymous, false)
  ) or exists (
    select 1 from private.member_account_deletions d
    where d.subject_hash = private.member_lifecycle_subject_hash(p_user_id)
      and d.status in ('authorized', 'processing')
  ) then
    return 'account_unavailable';
  end if;
  if exists (select 1 from public.organization_role_grants g where g.user_id = p_user_id)
    or exists (select 1 from public.member_roles r where r.user_id = p_user_id)
    or exists (select 1 from public.member_role_chapters rc where rc.user_id = p_user_id)
    or exists (select 1 from private.platform_operators o where o.user_id = p_user_id and o.revoked_at is null)
    or exists (select 1 from private.compass_platform_operators o where o.user_id = p_user_id and o.revoked_at is null)
    or exists (select 1 from private.learning_platform_editors e where e.user_id = p_user_id) then
    return 'staff_role';
  end if;
  -- Before the two-step check: off or held, PIN sign-in names no other cause.
  if exists (
    select 1 from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    where m.user_id = p_user_id and m.status = 'active'
      and not private.organization_feature_enabled(m.organization_id, 'features.security.member_pin_signin')
  ) then
    return 'disabled_by_organization';
  end if;
  if exists (select 1 from auth.mfa_factors f where f.user_id = p_user_id and f.status = 'verified') then
    return 'mfa_enrolled';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    where m.user_id = p_user_id and m.status = 'active'
  ) then
    return 'no_organization';
  end if;
  return null;
end;
$function$;

revoke all on function private.member_pin_ineligibility(uuid) from public, anon, authenticated, service_role;

commit;
