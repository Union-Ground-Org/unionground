-- REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117 (#9038), part 1.
--
-- Sunday release plan, choices 6 and 7 (project decision of November 13, 2026,
-- 1:48 PM ET): the sign-in page ships design 1, and designs 2 to 4 follow
-- behind a switch released by hand, with rotation off; the 3D map on /unions
-- is built behind a switch and released in Neuro Map week. Until now no part
-- of a signed-out page could be held: the only signed-out release read,
-- public.get_entry_screen_release_state() (20261112102500), answers three
-- sign-in controls and nothing else.
--
-- 1. Four platform-only boolean definitions, one per public-page section,
--    created held with no date (release_at 'infinity'), like
--    features.governance.per_unit_settings (#7667). Default on, not
--    organization-editable, not member-visible: they exist only to carry
--    release_at, so scripts/release-calendar.mjs can release each one by hand
--    (public.set_platform_setting_release accepts a key held before).
-- 2. public.get_public_section_release_state(): { released: [...] }, the
--    short names of the public-page sections whose release time has passed,
--    in key order. A held section is not named at all. Needs no organization
--    and no account, reads only features.public_pages.* rows, and is callable
--    with the publishable key (anon), for /api/public-sections.
--
-- Nothing reads a section yet: the designs and the map come in later pull
-- requests of this record, each drawn only when its section is released.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The four section definitions, held from their creation
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable, release_at)
values
  ('features.public_pages.sign_in_design_2', 'boolean', 'Sign-in page, design 2',
   'Platform-wide. Carries the release time of sign-in page design 2. Until then the sign-in page never shows it. Organizations cannot change it.',
   'true', null, null, null, 410, 'general', false, false, 'infinity'),
  ('features.public_pages.sign_in_design_3', 'boolean', 'Sign-in page, design 3',
   'Platform-wide. Carries the release time of sign-in page design 3. Until then the sign-in page never shows it. Organizations cannot change it.',
   'true', null, null, null, 411, 'general', false, false, 'infinity'),
  ('features.public_pages.sign_in_design_4', 'boolean', 'Sign-in page, design 4',
   'Platform-wide. Carries the release time of sign-in page design 4. Until then the sign-in page never shows it. Organizations cannot change it.',
   'true', null, null, null, 412, 'general', false, false, 'infinity'),
  ('features.public_pages.unions_map_3d', 'boolean', 'Find your union, 3D map',
   'Platform-wide. Carries the release time of the 3D map on Find your union (/unions). Until then the page keeps its current map. Organizations cannot change it.',
   'true', null, null, null, 413, 'general', false, false, 'infinity');

-- ---------------------------------------------------------------------------
-- 2. The signed-out section release read
-- ---------------------------------------------------------------------------

create function public.get_public_section_release_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'released',
    coalesce(
      pg_catalog.jsonb_agg(pg_catalog.substr(d.key, 23) order by d.key),
      '[]'::jsonb
    )
  )
  from public.platform_setting_definitions d
  where pg_catalog.starts_with(d.key, 'features.public_pages.')
    and d.value_kind = 'boolean'
    and (d.release_at is null or d.release_at <= pg_catalog.now());
$function$;

revoke all on function public.get_public_section_release_state() from public, anon, authenticated, service_role;
grant execute on function public.get_public_section_release_state() to anon, authenticated;

comment on function public.get_public_section_release_state() is
  'Signed-out pages (api/public-sections.js, publishable key): { released: [...] }, the short names of the public-page sections (features.public_pages.*) whose release time has passed. A held section is not named. Names no organization or account and no other switch.';

-- ---------------------------------------------------------------------------
-- 3. Guard: all four sections exist, held with no date, and the read names
--    none of them
-- ---------------------------------------------------------------------------

do $guard$
declare
  held integer;
begin
  select pg_catalog.count(*) into held
  from public.platform_setting_definitions
  where key in (
      'features.public_pages.sign_in_design_2',
      'features.public_pages.sign_in_design_3',
      'features.public_pages.sign_in_design_4',
      'features.public_pages.unions_map_3d'
    )
    and value_kind = 'boolean'
    and release_at = 'infinity';
  if held <> 4 then
    raise exception 'expected 4 held public-page sections, found %', held using errcode = '55000';
  end if;
  if public.get_public_section_release_state() <> '{"released": []}'::jsonb then
    raise exception 'a public-page section reads released at creation' using errcode = '55000';
  end if;
end;
$guard$;

commit;
