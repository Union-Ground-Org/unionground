-- Making hand-entered local officials easy:
--   1. exact places  - the worker records each member's town, township,
--                      county and school district (Census GEOIDs); officers
--                      pick from places where members actually live
--   2. sharing       - an exact place entered by one chapter serves every
--                      chapter's members
--   3. member flags  - "something's wrong here" reaches the officers without
--                      the member's name
--   4. review stamp  - so stale entries can be nudged and marked checked
--
-- Ported from civic-data-resolver migrations/009_local_made_easier.sql. Host
-- deviations: p_org is the host chapter id (text); the civic_org_member_ids
-- and civic_org_display_name seam functions already exist
-- (20260922210200); trigger functions live in private; officer RPCs
-- re-state the MFA floor; read policies keep a single permissive SELECT
-- policy per table.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 1 ---------------------------------------------------------------------------
create table public.civic_places (
  geoid text primary key,
  kind text not null check (kind in ('place', 'county_subdivision', 'county', 'school_district')),
  name text not null,
  state text not null check (state ~ '^[A-Z]{2}$'),
  source text not null,
  retrieved_at timestamptz not null
);

create table public.civic_user_places (
  user_id uuid not null,
  geoid text not null references public.civic_places(geoid),
  resolved_at timestamptz not null,
  primary key (user_id, geoid)
);
create index civic_user_places_geoid_idx on public.civic_user_places (geoid);

-- "Looked, found nothing" must be recordable, or an unmatchable address is
-- re-sent to the geocoder every night forever.
alter table public.civic_member_addresses add column places_checked_at timestamptz;

alter table public.civic_local_jurisdictions add column place_geoid text references public.civic_places(geoid);
alter table public.civic_local_jurisdictions add column shared boolean not null default true;
alter table public.civic_local_jurisdictions add column reviewed_at timestamptz not null default now();
-- An exact place needs no ZIP or city list.
alter table public.civic_local_jurisdictions drop constraint civic_local_jurisdictions_matchable;
alter table public.civic_local_jurisdictions add constraint civic_local_jurisdictions_matchable
  check (place_geoid is not null or cardinality(match_zips) + cardinality(match_cities) > 0);
create unique index civic_local_jurisdictions_one_per_place
  on public.civic_local_jurisdictions (org_id, place_geoid) where place_geoid is not null;

create or replace function private.civic_local_jurisdiction_clean()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.match_zips := array(select distinct btrim(zip) from unnest(new.match_zips) zip where btrim(zip) <> '');
  new.match_cities := array(select distinct lower(regexp_replace(btrim(city), '\s+', ' ', 'g'))
                            from unnest(new.match_cities) city where btrim(city) <> '');
  if exists (select 1 from unnest(new.match_zips) zip where zip !~ '^[0-9]{5}$') then
    raise exception 'ZIP codes must be five digits' using errcode = '22023';
  end if;
  if new.place_geoid is null and cardinality(new.match_zips) + cardinality(new.match_cities) = 0 then
    raise exception 'pick a place, or give at least one ZIP code or city' using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

-- A new address means new places and new officials: drop the old places,
-- district links and quarantine result the moment it changes, and release
-- any instant-lookup claim taken for the old address, so a moved member
-- never keeps (or writes to) their old officials, never stays falsely
-- quarantined, and can claim an immediate lookup for the new address.
-- SECURITY DEFINER because members cannot delete these worker-owned rows.
create or replace function private.civic_member_address_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  if (new.line1, new.line2, new.city, new.state, new.postal_code)
     is distinct from (old.line1, old.line2, old.city, old.state, old.postal_code) then
    new.civic_lookup_status := 'needs_lookup';
    new.places_checked_at := null;
    new.lookup_requested_at := null;
    delete from public.civic_user_places where user_id = new.user_id;
    delete from public.civic_user_districts where user_id = new.user_id;
    delete from public.civic_quarantine where user_id = new.user_id;
  end if;
  return new;
end;
$function$;

create or replace function public.civic_withdraw_address()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not (select private.mfa_satisfied()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from public.civic_member_addresses where user_id = caller;
  delete from public.civic_user_districts where user_id = caller;
  delete from public.civic_user_places where user_id = caller;
  delete from public.civic_quarantine where user_id = caller;
  delete from public.civic_user_district_changes where user_id = caller;
end;
$function$;

-- 2 ---------------------------------------------------------------------------
-- Only EXACT places are shared. A ZIP/city match is one chapter's
-- approximation and stays with that chapter.
drop policy civic_local_jurisdictions_read on public.civic_local_jurisdictions;
create policy civic_local_jurisdictions_read on public.civic_local_jurisdictions
  for select to authenticated
  using (public.civic_is_org_member(org_id) or public.civic_is_org_officer(org_id)
         or (shared and place_geoid is not null));

drop policy civic_local_officials_read on public.civic_local_officials;
create policy civic_local_officials_read on public.civic_local_officials
  for select to authenticated
  using (exists (
    select 1 from public.civic_local_jurisdictions jurisdiction
    where jurisdiction.id = jurisdiction_id
      and (public.civic_is_org_member(jurisdiction.org_id) or public.civic_is_org_officer(jurisdiction.org_id)
           or (jurisdiction.shared and jurisdiction.place_geoid is not null))));

-- One entry per place per member: their own chapter's if it has one,
-- otherwise the most recently reviewed shared one. match_exact is appended
-- (views may only grow at the end).
create or replace view public.civic_member_officials_keyed
with (security_invoker = on) as
select mo.user_id, mo.ocd_id, mo.district_level, mo.state, mo.district_name, mo.district_number, mo.map_version,
       mo.district_valid_to, mo.office, mo.full_name, mo.party, mo.email, mo.phone, mo.contact_form_url, mo.website,
       mo.photo_url, mo.social, mo.external_ids, mo.term_end, mo.official_source, mo.resolved_at, mo.level_rank,
       mo.resolution_stale,
       coalesce('bioguide:' || nullif(mo.external_ids->>'bioguide', ''),
                'openstates:' || nullif(mo.external_ids->>'openstates', '')) as official_key,
       true as match_exact
from public.civic_member_officials mo
union all
select m.user_id, 'local:' || m.jurisdiction_id, 'local', m.state, m.name, null, 'manual',
       null::date, o.office, o.full_name, o.party, o.email, o.phone, o.contact_form_url, o.website,
       null, '{}'::jsonb, jsonb_build_object('local', o.id, 'jurisdiction', m.jurisdiction_id), o.term_end, 'manual',
       o.updated_at, 6,
       false,
       'local:' || o.id,
       m.match_exact
from (
  select distinct on (a.user_id, coalesce(j.place_geoid, j.id::text))
         a.user_id, j.id as jurisdiction_id, j.state, j.name, (j.place_geoid is not null) as match_exact
  from public.civic_member_addresses a
  join public.civic_local_jurisdictions j on j.state = a.state and (
        (j.place_geoid is not null and exists (
          select 1 from public.civic_user_places up where up.user_id = a.user_id and up.geoid = j.place_geoid))
     or (j.place_geoid is null and (left(a.postal_code, 5) = any (j.match_zips)
                                    or lower(regexp_replace(btrim(a.city), '\s+', ' ', 'g')) = any (j.match_cities))))
  order by a.user_id, coalesce(j.place_geoid, j.id::text), public.civic_is_org_member(j.org_id) desc, j.reviewed_at desc
) m
join public.civic_local_officials o on o.jurisdiction_id = m.jurisdiction_id and o.is_current;

-- Where this chapter's members live, for the officer's place picker. Counts
-- only, and a place with fewer than three members is not listed at all: "1
-- member in Rushland" names that member, and so would the bare place name.
create function public.civic_member_place_counts(p_org text)
returns table (geoid text, kind text, name text, state text, members bigint, entered_by text,
               officials bigint, own_jurisdiction_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  return query
  select place.geoid, place.kind, place.name, place.state,
         count(distinct user_place.user_id),
         (select public.civic_org_display_name(entry.org_id)
            from public.civic_local_jurisdictions entry
           where entry.place_geoid = place.geoid and (entry.org_id = p_org or entry.shared)
           order by (entry.org_id = p_org) desc, entry.reviewed_at desc
           limit 1),
         (select count(*)
            from public.civic_local_officials official
            join public.civic_local_jurisdictions entry on entry.id = official.jurisdiction_id
           where entry.place_geoid = place.geoid and official.is_current
             and (entry.org_id = p_org or entry.shared)),
         (select entry.id
            from public.civic_local_jurisdictions entry
           where entry.place_geoid = place.geoid and entry.org_id = p_org)
  from public.civic_user_places user_place
  join public.civic_places place on place.geoid = user_place.geoid
  where user_place.user_id in (select public.civic_org_member_ids(p_org))
  group by place.geoid, place.kind, place.name, place.state
  -- A place with fewer than three members is left out entirely: returning the
  -- place while hiding its count would still say where one or two members live.
  having count(distinct user_place.user_id) >= 3
  order by count(distinct user_place.user_id) desc, place.name;
end;
$function$;

-- The distinct officials who represent this chapter's members, for the
-- officer's rating picker: official identity only, never which or how many
-- members they represent. Membership follows civic_org_member_ids (active
-- membership rows plus the selected profile chapter). Runs as the definer,
-- so the security_invoker view reads every member's rows.
create function public.civic_member_officials_for_org(p_org text)
returns table (official_key text, full_name text, office text, party text, state text,
               district_name text, level_rank integer)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  return query
  with eligible as (
    -- Only officials that at least three of the chapter's members share: a
    -- row's presence must not point at the district of one or two members.
    select k.official_key
    from public.civic_member_officials_keyed k
    where k.user_id in (select public.civic_org_member_ids(p_org))
      and k.official_key is not null
    group by k.official_key
    having count(distinct k.user_id) >= 3
  )
  select distinct on (o.official_key)
         o.official_key, o.full_name, o.office, o.party, o.state, o.district_name, o.level_rank
  from public.civic_member_officials_keyed o
  join eligible on eligible.official_key = o.official_key
  where o.user_id in (select public.civic_org_member_ids(p_org))
  order by o.official_key, o.resolved_at desc nulls last;
end;
$function$;

-- 3 ---------------------------------------------------------------------------
create table public.civic_local_flags (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references public.civic_local_jurisdictions(id) on delete cascade,
  official_id uuid references public.civic_local_officials(id) on delete set null,
  user_id uuid not null,
  note text not null check (length(btrim(note)) between 5 and 500),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index civic_local_flags_open_idx on public.civic_local_flags (jurisdiction_id) where status = 'open';

create function private.civic_local_flag_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select count(*) from public.civic_local_flags flag
      where flag.user_id = new.user_id and flag.status = 'open') >= 5 then
    raise exception 'too many open reports' using errcode = '54000';
  end if;
  return new;
end;
$function$;
revoke all on function private.civic_local_flag_limit() from public, anon, authenticated, service_role;

create trigger civic_local_flag_limit
before insert on public.civic_local_flags
for each row execute function private.civic_local_flag_limit();

-- Officers see what was reported, never who reported it.
create function public.civic_local_flags_for_org(p_org text)
returns table (id uuid, jurisdiction_id uuid, jurisdiction_name text, official_id uuid, official_name text,
               note text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied()) or not public.civic_is_org_officer(p_org) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  return query
    select flag.id, entry.id, entry.name, official.id, official.full_name, flag.note, flag.created_at
    from public.civic_local_flags flag
    join public.civic_local_jurisdictions entry on entry.id = flag.jurisdiction_id
    left join public.civic_local_officials official on official.id = flag.official_id
    where entry.org_id = p_org and flag.status = 'open'
    order by flag.created_at;
end;
$function$;

create function public.civic_resolve_local_flag(p_flag uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('resolved', 'dismissed') then
    raise exception 'bad status' using errcode = '22023';
  end if;
  update public.civic_local_flags flag
     set status = p_status, resolved_at = now()
   where flag.id = p_flag
     and exists (
       select 1 from public.civic_local_jurisdictions entry
       where entry.id = flag.jurisdiction_id and public.civic_is_org_officer(entry.org_id));
  if not found then
    raise exception 'officers only' using errcode = '42501';
  end if;
end;
$function$;

-- 4 ---------------------------------------------------------------------------
create function public.civic_mark_jurisdiction_reviewed(p_jurisdiction uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'officers only' using errcode = '42501';
  end if;
  update public.civic_local_jurisdictions entry
     set reviewed_at = now()
   where entry.id = p_jurisdiction and public.civic_is_org_officer(entry.org_id);
  if not found then
    raise exception 'officers only' using errcode = '42501';
  end if;
end;
$function$;

-- security ---------------------------------------------------------------------
alter table public.civic_places enable row level security;
alter table public.civic_user_places enable row level security;
alter table public.civic_local_flags enable row level security;

create policy mfa_assurance on public.civic_places
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_user_places
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_local_flags
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

create policy civic_places_public_read on public.civic_places
  for select to authenticated using (true);
create policy civic_user_places_read_own on public.civic_user_places
  for select to authenticated using (user_id = (select auth.uid()));
create policy civic_local_flags_read_own on public.civic_local_flags
  for select to authenticated using (user_id = (select auth.uid()));
-- A member may only flag a place they can actually see, and a named official
-- must serve that place (so a report can never pair one jurisdiction with
-- another jurisdiction's official).
create policy civic_local_flags_insert_own on public.civic_local_flags
  for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'open'
              and exists (select 1 from public.civic_local_jurisdictions jurisdiction
                          where jurisdiction.id = civic_local_flags.jurisdiction_id
                            and (civic_local_flags.official_id is null
                                 or exists (select 1 from public.civic_local_officials official
                                            where official.id = civic_local_flags.official_id
                                              and official.jurisdiction_id = jurisdiction.id))));

revoke all on public.civic_places, public.civic_user_places, public.civic_local_flags from public, anon, authenticated;
grant all on public.civic_places, public.civic_user_places, public.civic_local_flags to service_role;
grant select on public.civic_places, public.civic_user_places, public.civic_local_flags to authenticated;
grant insert (jurisdiction_id, official_id, user_id, note) on public.civic_local_flags to authenticated;
grant select on public.civic_member_officials_keyed to authenticated;

revoke all on function public.civic_member_place_counts(text) from public, anon;
revoke all on function public.civic_member_officials_for_org(text) from public, anon;
revoke all on function public.civic_local_flags_for_org(text) from public, anon;
revoke all on function public.civic_resolve_local_flag(uuid, text) from public, anon;
revoke all on function public.civic_mark_jurisdiction_reviewed(uuid) from public, anon;
grant execute on function public.civic_member_place_counts(text) to authenticated, service_role;
grant execute on function public.civic_member_officials_for_org(text) to authenticated, service_role;
grant execute on function public.civic_local_flags_for_org(text) to authenticated, service_role;
grant execute on function public.civic_resolve_local_flag(uuid, text) to authenticated, service_role;
grant execute on function public.civic_mark_jurisdiction_reviewed(uuid) to authenticated, service_role;

comment on policy civic_local_jurisdictions_read on public.civic_local_jurisdictions is
  'Admits members and officers of the entering chapter to its local jurisdictions; exact-place entries marked shared are readable by every signed-in member so one entry serves every chapter living there.';
comment on policy civic_local_officials_read on public.civic_local_officials is
  'Admits readers of the parent jurisdiction (its chapter''s members and officers, or everyone for a shared exact place) to the local officials who serve it.';
comment on policy mfa_assurance on public.civic_places is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_user_places is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_local_flags is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy civic_places_public_read on public.civic_places is
  'Admits any signed-in member to read worker-written public-record civic reference data (districts, officials, bills, roll calls, votes or Census places). It holds no member content, and signed-out visitors have no table grant at all.';
comment on policy civic_user_places_read_own on public.civic_user_places is
  'Admits only the member the Census places belong to. The worker writes them; officers see, through civic_member_place_counts, only places that three or more members share, as counts.';
comment on policy civic_local_flags_read_own on public.civic_local_flags is
  'Admits only the member who filed the report. Officers read reports through civic_local_flags_for_org, which never names the reporter.';
comment on policy civic_local_flags_insert_own on public.civic_local_flags is
  'Admits a member to file an open report only in their own name, only against a jurisdiction they can already see, and only naming an official (if any) who serves that jurisdiction.';

notify pgrst, 'reload schema';

commit;
