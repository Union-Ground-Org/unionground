-- public.union_orgs — the partner-organization registry behind the chapter
-- handshake (REQ-UG-UNION-ATLAS-REGISTRY-20260726).
--
-- WHY THIS TABLE EXISTS
-- GAP-701..704 "Agencies & coalitions" exists only in the design mockup
-- (public/design/Union Ground Site.dc.html:4077). Its "+ Start a handshake"
-- button is an unbound placeholder and its three partner orgs are string
-- literals: `Local 888 · UFCW`, `MTA — Educators`, `1199 New England`. All
-- three are real rows in the USUnions Union Atlas. This table is what turns
-- those literals into an evidence-backed lookup. It does NOT build the
-- handshake itself — no chapter_handshakes table, no picker, no request
-- lifecycle. This migration unblocks that work; a follow-on spec does it.
--
-- TERMINOLOGY HAZARD — READ BEFORE JOINING ANYTHING TO THIS TABLE
-- 20260726000000 shipped `chapter_agency_roster`. That "agency" is a
-- fictional public EMPLOYER department (Care, Family, Benefits, Health, Rehab,
-- Public Health, Youth), carried in chapters.region — internal org structure. A `union_org` is the opposite
-- axis: an EXTERNAL labor organization. The two must never be conflated, and
-- nothing in this migration references chapters.
--
-- SOURCE AND PROVENANCE
-- USUnions-Union-Atlas `data/union-atlas.json.gz` -> `.directory[]`, 20,699
-- rows, every row carrying all 23 source keys (verified by key-frequency
-- count — there are no sparse keys, only null values). Loaded by
-- scripts/load-union-orgs.mjs, NOT by this migration: a 20,699-row INSERT
-- would be a ~25 MB versioned file replayed on every branch reset, and it
-- could not express a refresh.
--
-- atlas_manifest_sha is the provenance column and is why the handshake can
-- claim "evidence-backed". It stores data/manifest.json#sha256 — the SHA-256
-- of the exact gzip payload a row came from. Without it a refreshed row is
-- indistinguishable from a hand-edited one.
--
-- SHAPE DECISIONS, each grounded in a count over the real data
--   * parent_* is FLATTENED from the nested `parent` object, and
--     parent_olms_file_number is deliberately NOT a self-FK: 194 rows have no
--     parent at all, and the dataset contains locals whose parent is not
--     itself a directory row. An FK would reject them at load.
--   * membership.latest.{count,year} flatten to members_latest /
--     members_latest_year (1,145 rows have no latest reading); the full series
--     stays as jsonb.
--   * level is CHECK-constrained to the four observed values
--     (local 17637, intermediate 1510, unknown 1405, national 147).
--   * geocode_precision is null for 1,647 rows — 'address' 15,243 and
--     'zcta' 3,809 are the only non-null values, and 15243+3809 = 19,052 =
--     the manifest's geocodedUnions. The CHECK admits null.
--   * sector_tags is text[] rather than jsonb: it is a flat string list
--     (16,326 rows empty, max length 11) and array containment is what a
--     filter will want.
--   * first_loaded_at is set on INSERT and never touched by the loader's
--     ON CONFLICT DO UPDATE. That is deliberate: re-running the loader over
--     unchanged data must leave it alone, which makes it a real idempotency
--     signal rather than decoration.
--
-- PRIVACY
-- Public read is correct and is bounded by the Atlas's own privacy boundary
-- (docs/UNION_ATLAS_DATA.md:48-61), which admits only public OLMS filings,
-- official NLRB case records, and attributed research, and excludes rosters,
-- personal contact details, and street addresses post-geocoding. No member
-- data touches this table.
--
-- PRIVILEGES — the non-obvious part
-- 20260726010000 fixed the stock default ACL at the source, so tables created
-- by postgres are now born `arwd` for anon and authenticated — TRUNCATE,
-- REFERENCES, TRIGGER and MAINTAIN are already excluded. The revoke this
-- table needs is therefore INSERT/UPDATE/DELETE, NOT the four-bit revoke that
-- older migrations in this tree perform. Verified against pg_default_acl
-- rather than assumed.
--
-- ROLLBACK (copy-paste):
--   drop table if exists public.union_orgs;
--   -- pg_trgm is left installed; dropping it would break any other index
--   -- that later adopts it.
--   notify pgrst, 'reload schema';

set local lock_timeout = '5s';

-- Search is by name fragment — a picker's user types "1199" or "UFCW", not a
-- prefix. Trigram is the right index for that and tsvector is not.
create extension if not exists pg_trgm with schema extensions;

create table if not exists public.union_orgs (
  id                       text primary key,
  olms_file_number         integer not null unique,
  name                     text not null,
  affiliation              text,
  designation              text,
  local_number             text,
  level                    text not null
                             check (level in ('local', 'intermediate', 'unknown', 'national')),
  parent_olms_file_number  integer,
  parent_affiliation       text,
  parent_name              text,
  sector_public_private    text
                             check (sector_public_private in ('private', 'public', 'mixed')),
  sector_tags              text[] not null default '{}',
  city                     text,
  state                    text,
  zip                      text,
  latitude                 double precision,
  longitude                double precision,
  geocode_precision        text
                             check (geocode_precision in ('address', 'zcta')),
  geocode_match_type       text
                             check (geocode_match_type in ('Exact', 'Non_Exact')),
  website                  text,
  members_latest           integer,
  members_latest_year      smallint,
  membership_history       jsonb not null default '[]'::jsonb,
  finances                 jsonb,
  public_record_coverage   jsonb,
  sources                  jsonb not null default '[]'::jsonb,
  enrichment_status        text not null
                             check (enrichment_status in ('enriched', 'no_web_presence')),
  source_updated_at        timestamptz,
  atlas_manifest_sha       text not null,
  first_loaded_at          timestamptz not null default pg_catalog.now(),

  -- Coordinates are either both present or both absent; a half-geocoded row
  -- would silently sort to the middle of the ocean.
  constraint union_orgs_coords_paired
    check ((latitude is null) = (longitude is null)),
  -- A latest membership reading is meaningless without its year.
  constraint union_orgs_members_year_paired
    check ((members_latest is null) = (members_latest_year is null))
);

comment on table public.union_orgs is
  'Partner-organization registry for the chapter handshake, imported from the USUnions Union Atlas. External labor organizations — NOT the Massachusetts employers carried in chapters.region / chapter_agency_roster.';
comment on column public.union_orgs.atlas_manifest_sha is
  'data/manifest.json#sha256 of the Atlas gzip payload this row was loaded from. Provenance for the handshake''s evidence claim.';
comment on column public.union_orgs.parent_olms_file_number is
  'Deliberately NOT a foreign key: 194 rows have no parent and some parents are not themselves directory rows.';
comment on column public.union_orgs.first_loaded_at is
  'Set on INSERT only; the loader''s ON CONFLICT DO UPDATE must never touch it, so an unchanged re-run leaves it stable.';

-- The two filters a picker leads with.
create index if not exists union_orgs_state_idx on public.union_orgs (state);
create index if not exists union_orgs_affiliation_idx on public.union_orgs (affiliation);
-- The "near my chapter" approximation. Distance sort over lat/long is
-- deferred — 504 geocoded Massachusetts rows do not need PostGIS.
create index if not exists union_orgs_state_city_idx on public.union_orgs (state, city);
-- Fragment search on name.
create index if not exists union_orgs_name_trgm_idx
  on public.union_orgs using gin (name extensions.gin_trgm_ops);

alter table public.union_orgs enable row level security;

drop policy if exists union_orgs_public_read on public.union_orgs;
create policy union_orgs_public_read
  on public.union_orgs
  for select to anon, authenticated
  using (true);

-- The MFA step-up boundary. Every RLS-enabled table in public carries this
-- restrictive policy, but it was applied by a DO loop at migration time, so a
-- table created by a LATER migration — like this one — silently lacks it.
-- scripts/db-contract.json#policyCoverage.restrictiveOnEveryRlsTable is the
-- only thing that can see the omission; no offline test can. Adding it here
-- rather than waiting for the next sweep.
--
-- This is a step-up gate, not a lockout: private.mfa_satisfied() returns true
-- at aal2, and otherwise true for any user with no verified TOTP factor. Only
-- an enrolled-but-not-stepped-up user is held out, exactly as on chapters and
-- member_kb_articles. anon is unaffected — the policy names authenticated
-- only, which is what keeps the registry publicly readable.
drop policy if exists mfa_assurance on public.union_orgs;
create policy mfa_assurance
  on public.union_orgs
  as restrictive
  for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

-- Born `arwd` (see PRIVILEGES above). Strip the writes; the loader runs as
-- service_role, which keeps its full default set.
revoke insert, update, delete on public.union_orgs from anon, authenticated;
grant select on public.union_orgs to anon, authenticated;

notify pgrst, 'reload schema';
