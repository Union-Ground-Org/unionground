-- Hand-entered local officials (mayors, councils, school boards).
--
-- Ported from civic-data-resolver migrations/008_local_officials.sql. A
-- chapter's officers enter a JURISDICTION (with the ZIP codes and/or city
-- names it covers) and the OFFICIALS who serve it; a member whose saved
-- address matches sees them alongside everyone else. Kept out of
-- civic_districts/civic_user_districts on purpose: the worker replaces a
-- member's district links as a set on every resolve and would erase
-- hand-entered rows. The worker never touches these tables.
--
-- Host deviations: org_id is the host chapter id (text, no foreign key; see
-- 20260922210100); the matchability check is named
-- civic_local_jurisdictions_matchable from the start so the next migration
-- can replace it by name; the clean-up trigger function lives in private;
-- read and write policies are split per command so no role/action pair
-- carries two permissive policies.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.civic_local_jurisdictions (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  name text not null check (length(btrim(name)) between 2 and 120),
  kind text not null check (kind in ('city', 'borough', 'township', 'county', 'school_district', 'special_district', 'other')),
  state text not null check (state ~ '^[A-Z]{2}$'),
  match_zips text[] not null default '{}',
  match_cities text[] not null default '{}',
  created_by uuid,
  updated_at timestamptz not null default now(),
  -- A jurisdiction nobody can match is a mistake.
  constraint civic_local_jurisdictions_matchable
    check (cardinality(match_zips) + cardinality(match_cities) > 0),
  constraint civic_local_jurisdictions_match_bounds
    check (cardinality(match_zips) <= 200 and cardinality(match_cities) <= 50),
  unique (org_id, state, name)
);

-- Array CHECKs cannot use subqueries; normalise and validate the elements here.
create function private.civic_local_jurisdiction_clean()
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
  if cardinality(new.match_zips) + cardinality(new.match_cities) = 0 then
    raise exception 'give at least one ZIP code or city' using errcode = '22023';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;
revoke all on function private.civic_local_jurisdiction_clean() from public, anon, authenticated, service_role;

create trigger civic_local_jurisdiction_clean
before insert or update on public.civic_local_jurisdictions
for each row execute function private.civic_local_jurisdiction_clean();

create table public.civic_local_officials (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references public.civic_local_jurisdictions(id) on delete cascade,
  office text not null check (length(btrim(office)) between 2 and 80),
  full_name text not null check (length(btrim(full_name)) between 2 and 120),
  party text check (party is null or length(party) <= 40),
  email text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (phone is null or phone ~ '^[0-9+(). x-]{7,25}$'),
  -- Officers type these and members click them: http(s) only, so a
  -- javascript: or data: URL can never become a link.
  contact_form_url text check (contact_form_url is null or contact_form_url ~* '^https?://[^\s]+$'),
  website text check (website is null or website ~* '^https?://[^\s]+$'),
  term_end date,
  is_current boolean not null default true,
  created_by uuid,
  updated_at timestamptz not null default now()
);

create index civic_local_officials_jurisdiction_idx
  on public.civic_local_officials (jurisdiction_id) where is_current;

-- The same read surface the app already uses, with local officials appended.
-- Same columns, same order; their key is 'local:<id>'.
create or replace view public.civic_member_officials_keyed
with (security_invoker = on) as
select mo.user_id, mo.ocd_id, mo.district_level, mo.state, mo.district_name, mo.district_number, mo.map_version,
       mo.district_valid_to, mo.office, mo.full_name, mo.party, mo.email, mo.phone, mo.contact_form_url, mo.website,
       mo.photo_url, mo.social, mo.external_ids, mo.term_end, mo.official_source, mo.resolved_at, mo.level_rank,
       mo.resolution_stale,
       coalesce('bioguide:' || nullif(mo.external_ids->>'bioguide', ''),
                'openstates:' || nullif(mo.external_ids->>'openstates', '')) as official_key
from public.civic_member_officials mo
union all
select a.user_id, 'local:' || j.id, 'local', j.state, j.name, null, 'manual',
       null::date, o.office, o.full_name, o.party, o.email, o.phone, o.contact_form_url, o.website,
       null, '{}'::jsonb, jsonb_build_object('local', o.id), o.term_end, 'manual', o.updated_at, 6,
       false,
       'local:' || o.id
from public.civic_member_addresses a
join public.civic_local_jurisdictions j
  on j.state = a.state
 and (left(a.postal_code, 5) = any (j.match_zips)
      or lower(regexp_replace(btrim(a.city), '\s+', ' ', 'g')) = any (j.match_cities))
join public.civic_local_officials o on o.jurisdiction_id = j.id and o.is_current;

alter table public.civic_local_jurisdictions enable row level security;
alter table public.civic_local_officials enable row level security;

create policy mfa_assurance on public.civic_local_jurisdictions
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_local_officials
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

-- Members read what their own chapter curated; its officers write it.
create policy civic_local_jurisdictions_read on public.civic_local_jurisdictions
  for select to authenticated
  using (public.civic_is_org_member(org_id) or public.civic_is_org_officer(org_id));
create policy civic_local_jurisdictions_officer_insert on public.civic_local_jurisdictions
  for insert to authenticated
  with check (public.civic_is_org_officer(org_id));
create policy civic_local_jurisdictions_officer_update on public.civic_local_jurisdictions
  for update to authenticated
  using (public.civic_is_org_officer(org_id))
  with check (public.civic_is_org_officer(org_id));
create policy civic_local_jurisdictions_officer_delete on public.civic_local_jurisdictions
  for delete to authenticated
  using (public.civic_is_org_officer(org_id));

create policy civic_local_officials_read on public.civic_local_officials
  for select to authenticated
  using (exists (
    select 1 from public.civic_local_jurisdictions jurisdiction
    where jurisdiction.id = jurisdiction_id
      and (public.civic_is_org_member(jurisdiction.org_id) or public.civic_is_org_officer(jurisdiction.org_id))));
create policy civic_local_officials_officer_insert on public.civic_local_officials
  for insert to authenticated
  with check (exists (
    select 1 from public.civic_local_jurisdictions jurisdiction
    where jurisdiction.id = jurisdiction_id and public.civic_is_org_officer(jurisdiction.org_id)));
create policy civic_local_officials_officer_update on public.civic_local_officials
  for update to authenticated
  using (exists (
    select 1 from public.civic_local_jurisdictions jurisdiction
    where jurisdiction.id = jurisdiction_id and public.civic_is_org_officer(jurisdiction.org_id)))
  with check (exists (
    select 1 from public.civic_local_jurisdictions jurisdiction
    where jurisdiction.id = jurisdiction_id and public.civic_is_org_officer(jurisdiction.org_id)));
create policy civic_local_officials_officer_delete on public.civic_local_officials
  for delete to authenticated
  using (exists (
    select 1 from public.civic_local_jurisdictions jurisdiction
    where jurisdiction.id = jurisdiction_id and public.civic_is_org_officer(jurisdiction.org_id)));

revoke all on public.civic_local_jurisdictions, public.civic_local_officials from public, anon, authenticated;
grant all on public.civic_local_jurisdictions, public.civic_local_officials to service_role;
grant select, insert, update, delete on public.civic_local_jurisdictions, public.civic_local_officials to authenticated;
grant select on public.civic_member_officials_keyed to authenticated;

comment on policy mfa_assurance on public.civic_local_jurisdictions is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_local_officials is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy civic_local_jurisdictions_read on public.civic_local_jurisdictions is
  'Admits members and officers of the entering chapter to its local jurisdictions; exact-place entries marked shared are readable by every signed-in member so one entry serves every chapter living there.';
comment on policy civic_local_jurisdictions_officer_insert on public.civic_local_jurisdictions is
  'Admits only officers of the chapter to enter local jurisdictions for it.';
comment on policy civic_local_jurisdictions_officer_update on public.civic_local_jurisdictions is
  'Admits only officers of the jurisdiction''s chapter to edit it, keeping it within a chapter they run.';
comment on policy civic_local_jurisdictions_officer_delete on public.civic_local_jurisdictions is
  'Admits only officers of the jurisdiction''s chapter to delete it.';
comment on policy civic_local_officials_read on public.civic_local_officials is
  'Admits readers of the parent jurisdiction (its chapter''s members and officers, or everyone for a shared exact place) to the local officials who serve it.';
comment on policy civic_local_officials_officer_insert on public.civic_local_officials is
  'Admits only officers of the jurisdiction''s chapter to enter local officials for it.';
comment on policy civic_local_officials_officer_update on public.civic_local_officials is
  'Admits only officers of the jurisdiction''s chapter to edit its local officials.';
comment on policy civic_local_officials_officer_delete on public.civic_local_officials is
  'Admits only officers of the jurisdiction''s chapter to delete its local officials.';

notify pgrst, 'reload schema';

commit;
