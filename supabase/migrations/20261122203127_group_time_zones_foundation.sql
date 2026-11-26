-- REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), part 2: the
-- foundation. Placeholder stamp; renamed to the real one at its turn in the
-- migration line.
--
-- Project decision of November 22, 2026 (docs/contracts/time-zones-per-group.md):
-- every group works in its own time zone, a person takes the zone of their
-- lowest-level group, and Eastern is never the default for anyone outside
-- Eastern. This migration adds where a zone is stored and the one way to read
-- it. It rewrites no existing function, so nothing a person sees changes.
--
-- Where a zone is stored. Three levels carry one, as a named region:
--   public.organizations.time_zone      every organization has one
--   public.chapters.time_zone           null means the organization's
--   private.chapter_units.time_zone     null means the chapter's
-- Each carries a check that the value is a region name (Area/Place, never an
-- abbreviation such as EST or an offset such as -05:00) that this server's
-- time zone data knows, so "at time zone" never raises on a stored zone. The
-- check asks Postgres itself, not private.iana_timezone_names: that copy may
-- lack a region the server has (its reader falls back to the catalog), and a
-- foreign key to it would join these tables to every graph the product pins
-- by foreign key. The functions that set a zone (part 3) hold the exact
-- spelling to the list.
--
-- Every existing organization is in New York's zone, which is what every
-- function works out today; chapters and units start with none of their own.
-- New organizations take the column default until part 3 makes the zone a
-- required, prefilled field of every creation path and removes the default.
--
-- The switch. features.governance.group_time_zones is created held with no
-- date. While it is held, private.group_time_zone answers New York's zone for
-- every group whatever is stored, exactly as before this migration; stored
-- zones are kept, untouched. It is released only after the test grid of the
-- contract passes.
--
-- The helpers are private, security definer with an empty search path, and no
-- API role executes them; they are called by functions that already check the
-- caller. private.group_time_zone takes the organization together with the
-- chapter and unit and refuses (22023) a chapter that is not in that
-- organization or a unit that is not in that chapter, so a zone lookup can
-- never read another organization's row.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.organizations
  add column time_zone text not null default 'America/New_York' -- fixed-zone: every existing organization is here; part 3 removes the default
  constraint organizations_time_zone_region check (
    time_zone ~ '^[A-Z][A-Za-z_]*(/[A-Za-z0-9_+-]+)+$'
    and (timestamptz '2000-01-01 00:00:00+00' at time zone time_zone) is not null);
alter table public.chapters
  add column time_zone text
  constraint chapters_time_zone_region check (
    time_zone is null
    or (time_zone ~ '^[A-Z][A-Za-z_]*(/[A-Za-z0-9_+-]+)+$'
        and (timestamptz '2000-01-01 00:00:00+00' at time zone time_zone) is not null));
alter table private.chapter_units
  add column time_zone text
  constraint chapter_units_time_zone_region check (
    time_zone is null
    or (time_zone ~ '^[A-Z][A-Za-z_]*(/[A-Za-z0-9_+-]+)+$'
        and (timestamptz '2000-01-01 00:00:00+00' at time zone time_zone) is not null));

comment on column public.organizations.time_zone is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the organization''s time zone as a named region. Chapters and units with none of their own take it. Read it only through private.group_time_zone, which answers New York''s zone while the group-zone switch is held.';
comment on column public.chapters.time_zone is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the chapter''s own time zone as a named region; null takes the organization''s. Read it only through private.group_time_zone.';
comment on column private.chapter_units.time_zone is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the unit''s or worksite''s own time zone as a named region; null takes the chapter''s. Read it only through private.group_time_zone.';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible, organization_editable, release_at)
values
  ('features.governance.group_time_zones', 'boolean', 'Group time zones',
   'Platform-wide. Carries the release time of group time zones: until then every organization, chapter and unit is worked out in New York''s zone as before, whatever zone is stored. Organizations cannot change it.',
   'true', null, null, null, 60, 'governance', false, false, 'infinity');

create function private.group_time_zones_released(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null
     and private.organization_feature_enabled(p_organization_id, 'features.governance.group_time_zones') is true;
$function$;

create function private.group_time_zone(p_organization_id uuid, p_chapter_id text default null, p_unit_id uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization_zone text;
  chapter_zone text;
  unit_zone text;
begin
  select o.time_zone into organization_zone
    from public.organizations o
   where o.id = p_organization_id;
  if not found then
    raise exception 'unknown group' using errcode = '22023';
  end if;
  if p_chapter_id is not null then
    select c.time_zone into chapter_zone
      from public.chapters c
     where c.id = p_chapter_id and c.organization_id = p_organization_id;
    if not found then
      raise exception 'unknown group' using errcode = '22023';
    end if;
  end if;
  if p_unit_id is not null then
    select u.time_zone into unit_zone
      from private.chapter_units u
     where u.id = p_unit_id and u.chapter_id = p_chapter_id and u.organization_id = p_organization_id;
    if not found then
      raise exception 'unknown group' using errcode = '22023';
    end if;
  end if;
  if not private.group_time_zones_released(p_organization_id) then
    return 'America/New_York'; -- fixed-zone: what every group reads until the switch is released
  end if;
  return coalesce(unit_zone, chapter_zone, organization_zone);
end;
$function$;

create function private.local_day(p_time_zone text, p_at timestamptz default pg_catalog.now())
returns date
language sql
stable
set search_path = ''
as $function$
  select (p_at at time zone p_time_zone)::date;
$function$;

-- The first instant whose date in the zone is the day. Not always midnight:
-- Havana's clocks skip it in spring and reach it twice in autumn, and
-- "timestamp at time zone" answers the second of two. It is worked out from
-- the zone's own offsets, whatever their size (Casey station has moved its
-- clock back three hours): each offset the zone used from 27 hours before
-- the day's nominal midnight to three hours after it names one instant as
-- that day's midnight, and the earliest of those that is on the day, with
-- the moment before it on another date, is the start. A day a region skipped
-- altogether (Apia, December 30, 2011) has no start and answers null.
-- zoneMidnight in src/lib/zoneTime.js works it out the same way.
create function private.local_day_start(p_time_zone text, p_day date)
returns timestamptz
language sql
stable
set search_path = ''
as $function$
  with base as (
    select (p_day::timestamp at time zone p_time_zone) as nominal
  ), offsets as (
    select distinct (sample.at at time zone p_time_zone) - (sample.at at time zone 'UTC') as utc_offset
      from base
      cross join lateral pg_catalog.generate_series(
        base.nominal - interval '27 hours', base.nominal + interval '3 hours', interval '1 hour') sample(at)
  ), candidates as (
    select ((p_day::timestamp - offsets.utc_offset) at time zone 'UTC') as at
      from offsets
  )
  select candidates.at
    from candidates
   where (candidates.at at time zone p_time_zone)::date = p_day
     and ((candidates.at - interval '1 microsecond') at time zone p_time_zone)::date <> p_day
   order by candidates.at
   limit 1;
$function$;

revoke all on function private.group_time_zones_released(uuid) from public, anon, authenticated, service_role;
revoke all on function private.group_time_zone(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.local_day(text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.local_day_start(text, date) from public, anon, authenticated, service_role;

comment on function private.group_time_zones_released(uuid) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: whether group time zones are released for the organization (features.governance.group_time_zones, held from its creation).';
comment on function private.group_time_zone(uuid, text, uuid) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the time zone of a group as a named region: the unit''s, else the chapter''s, else the organization''s. Refuses (22023) an unknown organization, a chapter outside it or a unit outside that chapter. Answers New York''s zone for every group while the switch is held. Called by security-definer functions only.';
comment on function private.local_day(text, timestamptz) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the calendar day of an instant, now() by default, in a named zone. Pass private.group_time_zone of the group the item belongs to.';
comment on function private.local_day_start(text, date) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the first instant whose date in the zone is the day; not always midnight where a daylight change skips or repeats it.';

commit;
