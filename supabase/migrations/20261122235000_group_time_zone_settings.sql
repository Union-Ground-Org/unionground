-- REQ-UG-TIME-ZONES-PER-GROUP-20261122, part 3: setting and
-- reading a group's time zone. Placeholder stamp; renamed to the real one
-- before its final gate round.
--
-- Part 2 (20261122203127) stored a zone on organizations, chapters and units
-- and gave the database private.group_time_zone to read it. This migration
-- adds the one way to set a zone and the one read the web and phone apps
-- make, both behind the same held switch
-- (features.governance.group_time_zones), and repairs the day-start helper.
--
-- 1. public.set_group_time_zone(chapter, unit, zone) sets the organization's
--    zone (no chapter, no unit), a chapter's own zone, or a unit's own zone.
--    A null zone on a chapter or a unit clears it, so it takes the level
--    above again; an organization always has one. Who may: an organization
--    admin for the organization, and whoever may manage that chapter's units
--    (private.chapter_unit_manageable) for a chapter or a unit. The zone must
--    be a region name exactly as the server's list spells it. A chapter or
--    unit that is missing or in another organization gets the same refusal as
--    one the caller may not manage. Each change writes one row of
--    public.organization_configuration_audit with the group, the old zone and
--    the new one. While the switch is held every call is refused.
--
-- 2. Nothing can know where a new organization is, so its zone starts as the
--    column default and public.organizations.time_zone_confirmed_at stays
--    null until an admin sets it once. The apps ask an admin of an
--    organization with no confirmation to confirm its zone. (Part 2 said the
--    creation paths would each take a zone and the default would go; one
--    confirm step does the same for all five creation paths without
--    rewriting them.)
--
-- 3. public.get_group_time_zones() answers the caller's organization: its
--    zone and whether it is confirmed, and each chapter and unit with its own
--    zone and the zone it works on. While the switch is held it answers only
--    {released: false}, so the apps draw nothing and read New York's zone as
--    before.
--
-- 4. private.local_day_start ( from the final gate round
--    of part 2): a day whose start is a clock jump across midnight had no
--    start (America/Toronto, March 31, 1919: 11:30 PM became 12:30 AM).
--    Between two clock changes a zone keeps one offset, so a day can begin
--    only where an offset calls it midnight or at a change itself. The
--    candidates are now both, and the earliest candidate that is on the day
--    is its start. zoneMidnight in src/lib/zoneTime.js works the same way.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The helper is replaced from its only definition (20261122203127); refuse a
-- database where it has changed since.
do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
       where p.oid = 'private.local_day_start(text,date)'::regprocedure)
     is distinct from '5864d2db376294177de944dd1ba3de42' then
    raise exception 'unreviewed predecessor: private.local_day_start' using errcode = '55000';
  end if;
end
$preflight$;

create or replace function private.local_day_start(p_time_zone text, p_day date)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $function$
declare
  nominal timestamptz;
  sample timestamptz;
  sample_offset interval;
  previous_at timestamptz;
  previous_offset interval;
  low bigint;
  high bigint;
  middle bigint;
  candidates timestamptz[] := array[]::timestamptz[];
  first_instant timestamptz;
begin
  if p_time_zone is null or p_day is null then
    return null;
  end if;
  nominal := p_day::timestamp at time zone p_time_zone;
  for sample in
    select s.at
      from pg_catalog.generate_series(nominal - interval '27 hours', nominal + interval '3 hours', interval '1 hour') s(at)
  loop
    sample_offset := (sample at time zone p_time_zone) - (sample at time zone 'UTC');
    candidates := candidates || ((p_day::timestamp - sample_offset) at time zone 'UTC');
    if previous_offset is not null and previous_offset <> sample_offset then
      -- The change is somewhere in this hour, on a whole second: halve down to it.
      low := pg_catalog.date_part('epoch', previous_at)::bigint;
      high := pg_catalog.date_part('epoch', sample)::bigint;
      while high - low > 1 loop
        middle := low + (high - low) / 2;
        if (pg_catalog.to_timestamp(middle) at time zone p_time_zone) - (pg_catalog.to_timestamp(middle) at time zone 'UTC') = previous_offset then
          low := middle;
        else
          high := middle;
        end if;
      end loop;
      candidates := candidates || pg_catalog.to_timestamp(high);
    end if;
    previous_at := sample;
    previous_offset := sample_offset;
  end loop;
  select min(candidate.at) into first_instant
    from pg_catalog.unnest(candidates) candidate(at)
   where (candidate.at at time zone p_time_zone)::date = p_day;
  return first_instant;
end;
$function$;

comment on function private.local_day_start(text, date) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the first instant whose date in the zone is the day: the earliest of each offset''s midnight and each clock change around the day that is on the day. Not always midnight; null for a date the zone never had.';

alter table public.organizations
  add column time_zone_confirmed_at timestamptz;

comment on column public.organizations.time_zone_confirmed_at is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: when an organization admin set the organization''s time zone through public.set_group_time_zone; null while the zone is still the starting value nobody has confirmed.';

-- What a zone must be to be set: a region name, spelled exactly as this
-- server lists it, and never a fixed offset under another name (Etc/GMT+12,
-- Etc/UTC, SystemV/EST5), which keeps no region's clock. The copied list answers first; a region it lacks is looked
-- up in the catalog, as the member focus zone does (20261027070000).
create function private.time_zone_region_known(p_time_zone text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_time_zone is not null
     and p_time_zone ~ '^[A-Z][A-Za-z_]*(/[A-Za-z0-9_+-]+)+$'
     and p_time_zone !~ '^(Etc|SystemV)/'
     and (exists (select 1 from private.iana_timezone_names known where known.name = p_time_zone)
          or exists (select 1 from pg_catalog.pg_timezone_names listed where listed.name = p_time_zone));
$function$;

-- The caller's organization as the apps read it: every chapter and unit with
-- its own zone and the zone it works on. Called only after the caller's
-- organization is resolved and the switch is known to be released.
create function private.group_time_zones_payload(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'released', true,
    'organization', pg_catalog.jsonb_build_object(
      'timeZone', o.time_zone,
      'confirmed', o.time_zone_confirmed_at is not null,
      'confirmedAt', o.time_zone_confirmed_at,
      'canChange', private.has_organization_role(o.id, array['admin'])),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'chapterId', c.id,
          'name', c.name,
          'ownTimeZone', c.time_zone,
          'timeZone', coalesce(c.time_zone, o.time_zone),
          'canChange', private.has_organization_role(o.id, array['admin']) or private.chapter_unit_manageable(c.id))
        order by c.order_index, c.name, c.id)
        from public.chapters c
       where c.organization_id = o.id), '[]'::jsonb),
    'units', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'unitId', u.id,
          'chapterId', u.chapter_id,
          'name', u.name,
          'ownTimeZone', u.time_zone,
          'timeZone', coalesce(u.time_zone, c.time_zone, o.time_zone))
        order by c.order_index, c.name, pg_catalog.lower(u.name), u.id)
        from private.chapter_units u
        join public.chapters c on c.id = u.chapter_id and c.organization_id = o.id
       where u.organization_id = o.id), '[]'::jsonb))
    from public.organizations o
   where o.id = p_organization_id;
$function$;

create function public.get_group_time_zones()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null or not (select private.mfa_satisfied()) then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- The organization as staff resolve it, so an organization admin who is in
  -- no chapter is answered too (20260902050000).
  org := private.current_mobile_staff_organization();
  if org is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  -- Held: the apps draw nothing and keep New York's zone.
  if not private.group_time_zones_released(org) then
    return pg_catalog.jsonb_build_object('released', false);
  end if;
  return private.group_time_zones_payload(org);
end;
$function$;

create function public.set_group_time_zone(p_chapter_id text, p_unit_id uuid, p_time_zone text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  clean_chapter text;
  clean_zone text;
  previous_zone text;
  level text;
begin
  -- The case-graph gate comes first, as in every writer of public.chapters
  -- (scripts/account-case-graph-inventory.mjs helperFirst).
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  clean_chapter := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  clean_zone := nullif(pg_catalog.btrim(coalesce(p_time_zone, '')), '');
  if caller is null or not (select private.mfa_satisfied()) then
    raise exception 'time zone role required' using errcode = '42501';
  end if;
  org := private.current_mobile_staff_organization();
  -- One refusal for a held switch, a caller with no organization, a group
  -- that is missing or in another organization, and a group the caller may
  -- not manage, so the answer says nothing about the group.
  if org is null or not private.group_time_zones_released(org) then
    raise exception 'time zone role required' using errcode = '42501';
  end if;
  if clean_chapter is null then
    if p_unit_id is not null or not private.has_organization_role(org, array['admin']) then
      raise exception 'time zone role required' using errcode = '42501';
    end if;
    level := 'organization';
  else
    -- An organization admin manages every chapter of the organization, in a
    -- chapter or not; otherwise whoever may manage the chapter's units.
    if not exists (select 1 from public.chapters c where c.id = clean_chapter and c.organization_id = org)
       or not (private.has_organization_role(org, array['admin']) or private.chapter_unit_manageable(clean_chapter))
       or (p_unit_id is not null and not exists (
             select 1 from private.chapter_units u
              where u.id = p_unit_id and u.chapter_id = clean_chapter and u.organization_id = org)) then
      raise exception 'time zone role required' using errcode = '42501';
    end if;
    level := case when p_unit_id is null then 'chapter' else 'unit' end;
  end if;
  if (clean_zone is null and level = 'organization')
     or (clean_zone is not null and not private.time_zone_region_known(clean_zone)) then
    raise exception 'time zone must be a region the server knows, such as America/Chicago' using errcode = '22023';
  end if;
  if level = 'organization' then
    select o.time_zone into previous_zone from public.organizations o where o.id = org for update;
    update public.organizations o
       set time_zone = clean_zone, time_zone_confirmed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.now()
     where o.id = org;
  elsif level = 'chapter' then
    select c.time_zone into previous_zone from public.chapters c where c.id = clean_chapter and c.organization_id = org for update;
    -- Nothing changed: no update and no audit row.
    if previous_zone is not distinct from clean_zone then
      return private.group_time_zones_payload(org);
    end if;
    update public.chapters c set time_zone = clean_zone where c.id = clean_chapter and c.organization_id = org;
  else
    select u.time_zone into previous_zone from private.chapter_units u where u.id = p_unit_id and u.organization_id = org for update;
    if previous_zone is not distinct from clean_zone then
      return private.group_time_zones_payload(org);
    end if;
    update private.chapter_units u set time_zone = clean_zone, updated_at = pg_catalog.now()
     where u.id = p_unit_id and u.chapter_id = clean_chapter and u.organization_id = org;
  end if;
  insert into public.organization_configuration_audit
    (organization_id, actor_user_id, action, item_key, previous_value, new_value, created_at)
  values (org, caller, 'setting_updated', 'time_zone.' || level,
    pg_catalog.jsonb_build_object('chapterId', clean_chapter, 'unitId', p_unit_id, 'timeZone', previous_zone),
    pg_catalog.jsonb_build_object('chapterId', clean_chapter, 'unitId', p_unit_id, 'timeZone', clean_zone),
    pg_catalog.clock_timestamp());
  return private.group_time_zones_payload(org);
end;
$function$;

revoke all on function private.time_zone_region_known(text) from public, anon, authenticated, service_role;
revoke all on function private.group_time_zones_payload(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_group_time_zones() from public, anon, authenticated, service_role;
revoke all on function public.set_group_time_zone(text, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.get_group_time_zones() to authenticated;
grant execute on function public.set_group_time_zone(text, uuid, text) to authenticated;

comment on function private.time_zone_region_known(text) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: whether a value is a time zone region name spelled exactly as this server lists it (never an abbreviation, an offset or a fixed-offset name such as Etc/GMT+12).';
comment on function private.group_time_zones_payload(uuid) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: an organization''s zone and each chapter''s and unit''s own zone and the zone it works on. Called by public.get_group_time_zones and public.set_group_time_zone after they resolve the caller''s organization.';
comment on function public.get_group_time_zones() is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: the caller''s organization, chapters and units with their time zones, after the two-step check; only {released: false} while features.governance.group_time_zones is held.';
comment on function public.set_group_time_zone(text, uuid, text) is
  'REQ-UG-TIME-ZONES-PER-GROUP-20261122: set the organization''s zone (an organization admin), or set or clear a chapter''s or a unit''s own zone (whoever may manage that chapter''s units), in the caller''s organization, after the two-step check. One audit row per change; none when a chapter''s or unit''s zone is unchanged. Refused while features.governance.group_time_zones is held.';

commit;
