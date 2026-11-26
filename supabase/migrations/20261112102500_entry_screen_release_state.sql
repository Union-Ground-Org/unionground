-- REQ-UG-RELEASE-HOLD-ON-ENTRY-SCREEN-CONTROLS-20261112 (#8465).
--
-- The platform release hold (#8436, 20261112061000) holds organization
-- switches, which are read for a known organization. Three controls appear on
-- the sign-in screens before anyone has an organization: the Apple and Google
-- buttons and the single sign-on control. The owner picked all three for dated
-- releases and ruled that held means invisible
-- (docs/contracts/staged-feature-releases.md).
--
-- 1. Two platform-only boolean definitions, one per provider button the
--    sign-in options route lists. Default on, not organization-editable, not
--    member-visible: they exist only to carry release_at. The existing
--    features.security.sso row carries the single sign-on control's release
--    time; while it is held, private.sso_active_provider already reads the
--    switch as off for every organization, so public.sso_signin_lookup answers
--    { sso: false } exactly as for an address with no provider.
-- 2. public.get_entry_screen_release_state(): whether each of those three keys
--    is released. Needs no organization and no account, reads only those three
--    rows, and is callable with the publishable key (anon). A missing row reads
--    as not released.
--
-- No key is held here: release_at stays null on all three rows.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The two provider definitions
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable)
values
  ('features.identity_providers.apple', 'boolean', 'Sign in with Apple button',
   'Platform-wide. Carries the release time of the Sign in with Apple button on the sign-in screens. Organizations cannot change it.',
   'true', null, null, null, 400, 'security', false, false),
  ('features.identity_providers.google', 'boolean', 'Sign in with Google button',
   'Platform-wide. Carries the release time of the Sign in with Google button on the sign-in screens. Organizations cannot change it.',
   'true', null, null, null, 401, 'security', false, false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The entry screen's release read
-- ---------------------------------------------------------------------------

create function public.get_entry_screen_release_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'apple', coalesce(pg_catalog.bool_or(d.key = 'features.identity_providers.apple'), false),
    'google', coalesce(pg_catalog.bool_or(d.key = 'features.identity_providers.google'), false),
    'sso', coalesce(pg_catalog.bool_or(d.key = 'features.security.sso'), false)
  )
  from public.platform_setting_definitions d
  where d.key in ('features.identity_providers.apple', 'features.identity_providers.google', 'features.security.sso')
    and d.value_kind = 'boolean'
    and (d.release_at is null or d.release_at <= pg_catalog.now());
$function$;

revoke all on function public.get_entry_screen_release_state() from public, anon, authenticated, service_role;
grant execute on function public.get_entry_screen_release_state() to anon, authenticated;

comment on function public.get_entry_screen_release_state() is
  'Sign-in screens (api/auth-signin-options.js, publishable key): whether the Apple button, the Google button and the single sign-on control are released. Reads only features.identity_providers.apple, features.identity_providers.google and features.security.sso; a missing or held row reads false. Names no organization or account and no other switch.';

commit;
