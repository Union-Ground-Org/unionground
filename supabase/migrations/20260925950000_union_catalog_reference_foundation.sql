-- REQ-UG-UNION-CATALOG-REFERENCE-FOUNDATION-20260924
--
-- Phase 2a, database half, of the union catalog design
-- (docs/superpowers/specs/2026-09-24-union-catalog-prefilled-organizations-design.md
-- sections 2.2, 2.6, 4.6 and 6.1 to 6.6).
--
-- Ten private tables hold the privacy-filtered public-record catalog of labor
-- organizations: one row per release, the seven content tables a release
-- carries, a coverage summary recomputed at activation, and a staging table
-- that holds a loaded release's rows until it is activated, so a load never
-- changes what readers see. They carry no person data of any kind (the
-- exporter's allow-list drops every person field before a release exists)
-- and no tenant data. No migration or seed writes a row:
-- scripts/load-union-catalog.mjs loads a release through the database-owner
-- connection, behind assertExactTarget.
--
-- Every table enables and forces row level security, has no policy and no
-- grant, and revokes everything from public, anon, authenticated and
-- service_role, as private.public_interest_suppressions does. Reads go only
-- through three bounded, anonymous security definer RPCs; activation goes only
-- through private.catalog_activate_release. The foreign keys stay among the
-- private.catalog_* tables: union_org_id is a soft link to public.union_orgs,
-- and nothing here points at auth.users, public.organizations or any other
-- table in the account case graph. No trigger is defined.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------- releases

create table private.catalog_releases (
  id uuid not null default extensions.gen_random_uuid(),
  label text not null
    constraint catalog_releases_label_check check (label ~ '^[0-9]{8}-[0-9]{2}$'),
  status text not null default 'staged'
    constraint catalog_releases_status_check check (status in ('staged', 'active', 'retired', 'failed')),
  schema_version text not null
    constraint catalog_releases_schema_version_check check (schema_version = 'union-catalog-release/1'),
  filter_version text not null
    constraint catalog_releases_filter_version_check check (filter_version ~ '^privacy-filter/[0-9]{1,3}$'),
  source_sha256 text not null
    constraint catalog_releases_source_sha256_check check (source_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 text not null
    constraint catalog_releases_artifact_sha256_check check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  source_built_at timestamptz not null,
  counts jsonb not null
    constraint catalog_releases_counts_check check (jsonb_typeof(counts) = 'object' and pg_column_size(counts) <= 4096),
  drop_report jsonb not null default '{}'::jsonb
    constraint catalog_releases_drop_report_check check (pg_column_size(drop_report) <= 16384),
  activation_diff jsonb not null default '{}'::jsonb
    constraint catalog_releases_activation_diff_check check (pg_column_size(activation_diff) <= 4096),
  loaded_at timestamptz not null default pg_catalog.now(),
  verified_at timestamptz,
  verified_sha256 text
    constraint catalog_releases_verified_sha256_check check (verified_sha256 ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  constraint catalog_releases_pkey primary key (id),
  constraint catalog_releases_label_key unique (label)
);

create unique index catalog_releases_one_active on private.catalog_releases ((true)) where status = 'active';

comment on table private.catalog_releases is
  'One row per loaded union catalog release (label, hashes, counts, a counts-only drop report and activation diff, and the time and staged-row digest of the last catalog:verify that matched its staged rows to the artifact; retiring a release or failing its verify clears both). At most one row is active. Written only by the owner-connected loader and private.catalog_activate_release.';

alter table private.catalog_releases enable row level security;
alter table private.catalog_releases force row level security;
revoke all on table private.catalog_releases from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- organizations

create table private.catalog_organizations (
  catalog_key text not null
    constraint catalog_organizations_catalog_key_check check (catalog_key ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$'),
  olms_file_number integer
    constraint catalog_organizations_olms_file_number_check check (olms_file_number > 0),
  union_org_id text
    constraint catalog_organizations_union_org_id_check check (char_length(union_org_id) between 1 and 200 and union_org_id !~ '[[:cntrl:]]'),
  origin text not null default 'research'
    constraint catalog_organizations_origin_check check (origin in ('research', 'contribution')),
  name text not null
    constraint catalog_organizations_name_check check (char_length(btrim(name)) between 2 and 200 and name !~ '[[:cntrl:]]'),
  aka text[] not null default '{}'
    constraint catalog_organizations_aka_check check (cardinality(aka) <= 20),
  family text
    constraint catalog_organizations_family_check check (char_length(family) <= 40),
  designation text
    constraint catalog_organizations_designation_check check (char_length(designation) <= 160),
  local_number text
    constraint catalog_organizations_local_number_check check (char_length(local_number) <= 20),
  tier text not null
    constraint catalog_organizations_tier_check check (tier in ('national', 'regional', 'state', 'local', 'sub_local')),
  org_type_label text
    constraint catalog_organizations_org_type_label_check check (char_length(org_type_label) <= 120),
  sector text
    constraint catalog_organizations_sector_check check (sector in ('public', 'private', 'mixed')),
  industries text[] not null default '{}',
  occupations text[] not null default '{}',
  trades text[] not null default '{}',
  city text,
  state text
    constraint catalog_organizations_state_check check (state ~ '^[A-Z]{2}$'),
  zip5 text
    constraint catalog_organizations_zip5_check check (zip5 ~ '^[0-9]{5}$'),
  census_region text,
  census_division text,
  latitude numeric(7,4),
  longitude numeric(7,4),
  geo_precision text
    constraint catalog_organizations_geo_precision_check check (geo_precision in ('zip', 'city', 'state')),
  website text
    constraint catalog_organizations_website_check check (website ~ '^https?://' and char_length(website) <= 500),
  members_reported integer
    constraint catalog_organizations_members_reported_check check (members_reported >= 0),
  members_fiscal_year smallint,
  structure_note text
    constraint catalog_organizations_structure_note_check check (char_length(structure_note) <= 3000),
  election_term_years smallint
    constraint catalog_organizations_election_term_years_check check (election_term_years between 1 and 10),
  next_election_on date,
  bylaws_url text
    constraint catalog_organizations_bylaws_url_check check (bylaws_url ~ '^https://' and char_length(bylaws_url) <= 1000),
  confidence text not null
    constraint catalog_organizations_confidence_check check (confidence in ('official_site', 'secondary', 'olms_filing', 'not_found', 'unreviewed')),
  researched_on date,
  source_urls text[] not null default '{}'
    constraint catalog_organizations_source_urls_check check (cardinality(source_urls) <= 150),
  duplicate_of text,
  search_text text not null
    constraint catalog_organizations_search_text_check check (char_length(search_text) <= 4000),
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_organizations_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_organizations_pkey primary key (catalog_key),
  constraint catalog_organizations_olms_file_number_key unique (olms_file_number),
  constraint catalog_organizations_duplicate_of_fkey foreign key (duplicate_of)
    references private.catalog_organizations (catalog_key),
  constraint catalog_organizations_coords_paired check ((latitude is null) = (longitude is null)),
  constraint catalog_organizations_members_paired check ((members_reported is null) = (members_fiscal_year is null)),
  constraint catalog_organizations_key_agrees check (olms_file_number is null or catalog_key = 'olms-' || olms_file_number)
);

create index catalog_org_name_trgm_idx on private.catalog_organizations
  using gin (name extensions.gin_trgm_ops) where retired_release_id is null;
create index catalog_org_facets_idx on private.catalog_organizations (state, family, tier)
  where retired_release_id is null;
create index catalog_organizations_duplicate_of_idx on private.catalog_organizations (duplicate_of);

comment on table private.catalog_organizations is
  'Public-record labor organizations from a union catalog release, keyed by a stable catalog key. No person data. union_org_id is a soft link to public.union_orgs. Rows are retired, never deleted. Read only through the union catalog RPCs.';

alter table private.catalog_organizations enable row level security;
alter table private.catalog_organizations force row level security;
revoke all on table private.catalog_organizations from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- edges

create table private.catalog_edges (
  edge_key text not null,
  child_key text not null,
  parent_key text,
  parent_label text
    constraint catalog_edges_parent_label_check check (char_length(parent_label) between 2 and 300),
  edge_kind text not null
    constraint catalog_edges_edge_kind_check check (edge_kind in ('olms_parent', 'parent_body', 'regional_body', 'state_body', 'state_federation')),
  certainty text not null
    constraint catalog_edges_certainty_check check (certainty in ('filed', 'confirmed', 'inferred', 'split')),
  source_url text
    constraint catalog_edges_source_url_check check (source_url ~ '^https?://' and char_length(source_url) <= 1000),
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_edges_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_edges_pkey primary key (edge_key),
  constraint catalog_edges_child_key_fkey foreign key (child_key)
    references private.catalog_organizations (catalog_key),
  constraint catalog_edges_parent_key_fkey foreign key (parent_key)
    references private.catalog_organizations (catalog_key),
  constraint catalog_edges_parent_present check (parent_key is not null or parent_label is not null),
  constraint catalog_edges_not_self check (parent_key is distinct from child_key)
);

create index catalog_edges_child_key_idx on private.catalog_edges (child_key);
create index catalog_edges_parent_key_idx on private.catalog_edges (parent_key);

comment on table private.catalog_edges is
  'Hierarchy edges between catalog organizations (or to a named body with no catalog row) from a union catalog release. Rows are retired, never deleted. Read only through the union catalog RPCs.';

alter table private.catalog_edges enable row level security;
alter table private.catalog_edges force row level security;
revoke all on table private.catalog_edges from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- sub-units

create table private.catalog_subunits (
  subunit_key text not null
    constraint catalog_subunits_subunit_key_check check (subunit_key ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})~[a-z_]{3,20}-[0-9a-f]{12}$'),
  catalog_key text not null,
  parent_subunit_key text,
  kind text not null
    constraint catalog_subunits_kind_check check (kind in ('chapter', 'unit', 'bargaining_unit', 'retiree_chapter', 'local', 'district',
      'division', 'region', 'sector', 'department', 'council', 'committee', 'other')),
  kind_label text not null
    constraint catalog_subunits_kind_label_check check (char_length(kind_label) between 1 and 60),
  name text not null
    constraint catalog_subunits_name_check check (char_length(btrim(name)) between 1 and 200),
  location text
    constraint catalog_subunits_location_check check (char_length(location) <= 200),
  employer text
    constraint catalog_subunits_employer_check check (char_length(employer) <= 300),
  members integer
    constraint catalog_subunits_members_check check (members >= 0),
  members_source text
    constraint catalog_subunits_members_source_check check (char_length(members_source) <= 300),
  density_note text
    constraint catalog_subunits_density_note_check check (char_length(density_note) <= 200),
  website text
    constraint catalog_subunits_website_check check (website ~ '^https?://' and char_length(website) <= 500),
  election_note text
    constraint catalog_subunits_election_note_check check (char_length(election_note) <= 300),
  structure_note text
    constraint catalog_subunits_structure_note_check check (char_length(structure_note) <= 1000),
  confidence text not null
    constraint catalog_subunits_confidence_check check (confidence in ('official_site', 'secondary', 'olms_filing', 'not_found', 'unreviewed')),
  source_url text not null
    constraint catalog_subunits_source_url_check check (source_url ~ '^https?://' and char_length(source_url) <= 1000),
  as_of date,
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_subunits_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_subunits_pkey primary key (subunit_key),
  constraint catalog_subunits_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key),
  constraint catalog_subunits_parent_subunit_key_fkey foreign key (parent_subunit_key)
    references private.catalog_subunits (subunit_key)
);

create index catalog_subunits_catalog_key_idx on private.catalog_subunits (catalog_key);
create index catalog_subunits_parent_subunit_key_idx on private.catalog_subunits (parent_subunit_key);

comment on table private.catalog_subunits is
  'Sub-units (chapters, units, bargaining units and similar) of catalog organizations from a union catalog release. No person data; contacts of sub-units are never stored here. Rows are retired, never deleted.';

alter table private.catalog_subunits enable row level security;
alter table private.catalog_subunits force row level security;
revoke all on table private.catalog_subunits from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- seat outlines

create table private.catalog_seat_outlines (
  outline_key text not null,
  catalog_key text not null,
  subunit_key text,
  seat_class text not null
    constraint catalog_seat_outlines_seat_class_check check (seat_class in ('officer', 'board', 'steward', 'delegate')),
  title text not null
    constraint catalog_seat_outlines_title_check check (char_length(btrim(title)) between 1 and 120),
  listed integer not null
    constraint catalog_seat_outlines_listed_check check (listed >= 0),
  vacant integer not null default 0
    constraint catalog_seat_outlines_vacant_check check (vacant between 0 and listed),
  source_url text not null
    constraint catalog_seat_outlines_source_url_check check (source_url ~ '^https?://' and char_length(source_url) <= 1000),
  as_of date,
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_seat_outlines_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_seat_outlines_pkey primary key (outline_key),
  constraint catalog_seat_outlines_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key),
  constraint catalog_seat_outlines_subunit_key_fkey foreign key (subunit_key)
    references private.catalog_subunits (subunit_key)
);

create index catalog_seat_outlines_catalog_key_idx on private.catalog_seat_outlines (catalog_key);
create index catalog_seat_outlines_subunit_key_idx on private.catalog_seat_outlines (subunit_key);

comment on table private.catalog_seat_outlines is
  'Seat outlines (class, title, listed and vacant counts) of catalog organizations and sub-units. Deliberately has no holder column. Rows are retired, never deleted.';

alter table private.catalog_seat_outlines enable row level security;
alter table private.catalog_seat_outlines force row level security;
revoke all on table private.catalog_seat_outlines from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- contacts

create table private.catalog_contacts (
  contact_key text not null,
  catalog_key text not null,
  contact_kind text not null
    constraint catalog_contacts_contact_kind_check check (contact_kind in ('website', 'social', 'email', 'phone', 'office_address')),
  value text not null
    constraint catalog_contacts_value_check check (char_length(value) between 3 and 500),
  label text
    constraint catalog_contacts_label_check check (char_length(label) <= 80),
  basis text not null
    constraint catalog_contacts_basis_check check (basis in ('own_site', 'family_national_site')),
  source_url text not null
    constraint catalog_contacts_source_url_check check (source_url ~ '^https?://' and char_length(source_url) <= 1000),
  as_of date,
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_contacts_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_contacts_pkey primary key (contact_key),
  constraint catalog_contacts_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key)
);

create index catalog_contacts_catalog_key_idx on private.catalog_contacts (catalog_key);

comment on table private.catalog_contacts is
  'Organization-level public contacts (website, social, role mailbox, office phone or address from the organization''s own site). Never a person''s contact. Rows are retired, never deleted.';

alter table private.catalog_contacts enable row level security;
alter table private.catalog_contacts force row level security;
revoke all on table private.catalog_contacts from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- documents

create table private.catalog_documents (
  document_key text not null
    constraint catalog_documents_document_key_check check (document_key ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})~[0-9a-f]{16}$'),
  catalog_key text not null,
  doc_kind text not null
    constraint catalog_documents_doc_kind_check check (doc_kind in ('contract', 'bylaws', 'form', 'newsletter', 'handbook', 'other')),
  title text not null
    constraint catalog_documents_title_check check (char_length(btrim(title)) between 1 and 300),
  title_derived boolean not null default false,
  url text not null
    constraint catalog_documents_url_check check (url ~ '^https://' and char_length(url) <= 2000),
  url_host text not null
    constraint catalog_documents_url_host_check check (char_length(url_host) <= 253),
  as_of date,
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_documents_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_documents_pkey primary key (document_key),
  constraint catalog_documents_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key),
  constraint catalog_documents_key_agrees check (split_part(document_key, '~', 1) = catalog_key)
);

create index catalog_documents_catalog_key_idx on private.catalog_documents (catalog_key);

comment on table private.catalog_documents is
  'Links to public documents (contracts, bylaws, forms and similar) of catalog organizations, one row per organization and URL. Metadata only; no document body. Rows are retired, never deleted.';

alter table private.catalog_documents enable row level security;
alter table private.catalog_documents force row level security;
revoke all on table private.catalog_documents from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- document sub-units

create table private.catalog_document_subunits (
  document_key text not null,
  subunit_key text not null,
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_document_subunits_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_document_subunits_pkey primary key (document_key, subunit_key),
  constraint catalog_document_subunits_document_key_fkey foreign key (document_key)
    references private.catalog_documents (document_key),
  constraint catalog_document_subunits_subunit_key_fkey foreign key (subunit_key)
    references private.catalog_subunits (subunit_key)
);

create index catalog_document_subunits_subunit_key_idx on private.catalog_document_subunits (subunit_key);

comment on table private.catalog_document_subunits is
  'Which sub-units a catalog document belongs to; a shared URL keeps every sub-unit it was listed under. Rows are retired, never deleted.';

alter table private.catalog_document_subunits enable row level security;
alter table private.catalog_document_subunits force row level security;
revoke all on table private.catalog_document_subunits from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- coverage

create table private.catalog_coverage (
  catalog_key text not null,
  release_id uuid not null,
  subunits integer not null,
  subunits_with_members integer not null,
  seat_outlines integer not null,
  documents jsonb not null
    constraint catalog_coverage_documents_check check (jsonb_typeof(documents) = 'object'),
  checklist jsonb not null
    constraint catalog_coverage_checklist_check check (jsonb_typeof(checklist) = 'object'),
  band text not null
    constraint catalog_coverage_band_check check (band in ('basic', 'structured', 'deep')),
  demand_band text
    constraint catalog_coverage_demand_band_check check (demand_band in ('10+', '25+', '100+')),
  community_verified_on date,
  last_researched date,
  constraint catalog_coverage_pkey primary key (catalog_key),
  constraint catalog_coverage_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key),
  constraint catalog_coverage_release_id_fkey foreign key (release_id)
    references private.catalog_releases (id)
);

create index catalog_coverage_release_id_idx on private.catalog_coverage (release_id);

comment on table private.catalog_coverage is
  'Per-organization coverage summary (counts, an eight-item checklist and a band) recomputed by private.catalog_activate_release for every live, non-duplicate catalog organization.';

alter table private.catalog_coverage enable row level security;
alter table private.catalog_coverage force row level security;
revoke all on table private.catalog_coverage from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- staging

-- A load writes a release's rows here and nowhere else; the read RPCs never
-- look at this table. private.catalog_activate_release applies exactly one
-- release's staged rows to the live tables, so readers see either the old
-- release or the new one, never a mix, and a release that fails verify is
-- simply never activated. The staging rows of the active release and of the
-- one it retired are kept so a rollback can re-apply them after a fresh
-- verify; activation refuses staged rows that changed after their verify.
create table private.catalog_staging (
  release_id uuid not null,
  table_name text not null
    constraint catalog_staging_table_name_check check (table_name in ('organizations', 'edges', 'subunits', 'seat_outlines',
      'contacts', 'documents', 'document_subunits')),
  row_key text not null
    constraint catalog_staging_row_key_check check (char_length(row_key) between 1 and 400),
  content jsonb not null
    constraint catalog_staging_content_check check (jsonb_typeof(content) = 'object'),
  content_sha256 text not null
    constraint catalog_staging_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_staging_pkey primary key (release_id, table_name, row_key),
  constraint catalog_staging_release_id_fkey foreign key (release_id)
    references private.catalog_releases (id)
);

comment on table private.catalog_staging is
  'The rows of a loaded union catalog release, keyed by release, content table and row key, until private.catalog_activate_release applies them to the live tables. Written only by the owner-connected loader; never read by the read RPCs.';

alter table private.catalog_staging enable row level security;
alter table private.catalog_staging force row level security;
revoke all on table private.catalog_staging from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- scrub helper

-- Defense in depth for the prose fields the profile RPC emits (spec F8's
-- free-text set): organization and sub-unit structure notes, the sub-unit
-- name, location, employer, kind label, members source, density note and
-- election note, edge parent labels, seat outline titles, contact labels and
-- document titles. The exporter already refuses a release that carries an
-- email or phone pattern outside a contact value; this returns null for any
-- value that still does. Identity fields (name, aka, designation, org type
-- label, city, parent and child names) and every search row are emitted as
-- loaded and rely on the loader's release privacy gate.
create function private.catalog_scrub_text(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_value is null then null
    when p_value ~* '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}' then null
    when p_value ~* '[a-z0-9._%+-]+\s*[[(]\s*at\s*[])]\s*[a-z0-9-]+\s*([[(]\s*dot\s*[])]|\.)\s*[a-z]{2,}' then null
    when p_value ~* '(^|[^a-z])(mailto|tel|sms):' then null
    when p_value ~ '(?<![[:alnum:]_.])(?<![0-9]-)(\+?1[[:space:].-]?)?(\([0-9]{3}\)[[:space:]]?|[0-9]{3}[[:space:].-]?)[0-9]{3}[[:space:].-][0-9]{4}(?![[:alnum:]_-])' then null
    when p_value ~ '(?<![[:alnum:]_.-])[0-9]{10}(?![[:alnum:]_-])' then null
    else p_value
  end
$function$;

revoke all on function private.catalog_scrub_text(text) from public, anon, authenticated, service_role;

comment on function private.catalog_scrub_text(text) is
  'Returns null for a value carrying an email or phone pattern, otherwise the value. Applied to the prose fields get_union_catalog_profile emits: structure notes, sub-unit name/location/employer/kind label/members source/density note/election note, edge parent labels, seat outline titles, contact labels and document titles. Identity fields and search rows are emitted as loaded.';

-- ---------------------------------------------------------------- read RPCs

create function public.get_union_catalog_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  release_label text;
  release_activated_at timestamptz;
  release_built_at timestamptz;
  release_counts jsonb;
begin
  select r.label, r.activated_at, r.source_built_at, r.counts
    into release_label, release_activated_at, release_built_at, release_counts
    from private.catalog_releases as r
   where r.status = 'active'
   limit 1;
  if release_label is null then
    return pg_catalog.jsonb_build_object(
      'available', false,
      'releaseLabel', null,
      'releasedOn', null,
      'dataAsOf', null,
      'counts', null
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'available', true,
    'releaseLabel', release_label,
    'releasedOn', (release_activated_at at time zone 'America/New_York')::date,
    'dataAsOf', (release_built_at at time zone 'America/New_York')::date,
    -- The loader keeps its bookkeeping (the tenant organization count around
    -- the load and the operator's retire ceiling) in the same jsonb; none of
    -- it is public-record data and none of it leaves the database.
    'counts', release_counts - array['organizationsBefore', 'organizationsAfter', 'allowRetire']::text[]
  );
end;
$function$;

revoke all on function public.get_union_catalog_status() from public, anon, authenticated, service_role;
grant execute on function public.get_union_catalog_status() to anon, authenticated, service_role;

comment on function public.get_union_catalog_status() is
  'Anonymous union catalog status: whether a release is active, its label, its ET activation and data dates, and its public-record row counts. Counts only.';

create function public.search_union_catalog(
  p_query text,
  p_state text,
  p_family text,
  p_tier text,
  p_page integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  query_text text := nullif(pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), '');
  state_filter text := nullif(p_state, '');
  family_filter text := nullif(pg_catalog.btrim(coalesce(p_family, '')), '');
  tier_filter text := nullif(p_tier, '');
  registry_level text;
  number_match text[];
  local_number_filter text;
  text_part text;
  pattern text;
  full_pattern text;
  catalog_live boolean;
  match_count bigint;
  page_rows jsonb;
begin
  if p_query ~ '[[:cntrl:]]' then
    raise exception 'invalid catalog search query' using errcode = '22023';
  end if;
  if query_text is not null and pg_catalog.char_length(query_text) not between 2 and 80 then
    raise exception 'catalog search query must be 2 to 80 characters' using errcode = '22023';
  end if;
  if state_filter is not null and state_filter !~ '^[A-Z]{2}$' then
    raise exception 'invalid catalog search state' using errcode = '22023';
  end if;
  if query_text is null and state_filter is null then
    raise exception 'catalog search needs a query or a state' using errcode = '22023';
  end if;
  if p_family ~ '[[:cntrl:]]' or pg_catalog.char_length(family_filter) > 40 then
    raise exception 'invalid catalog search family' using errcode = '22023';
  end if;
  if tier_filter is not null and tier_filter not in ('national', 'regional', 'state', 'local', 'sub_local') then
    raise exception 'invalid catalog search tier' using errcode = '22023';
  end if;
  if p_page is null or p_page not between 1 and 40 then
    raise exception 'invalid catalog search page' using errcode = '22023';
  end if;

  registry_level := case tier_filter
    when 'national' then 'national'
    when 'regional' then 'intermediate'
    when 'state' then 'intermediate'
    when 'local' then 'local'
    when 'sub_local' then 'local'
  end;

  -- The Phase 1 reading of a query: "Local 600", "lu 12 boston" or a bare
  -- number names a local number; the remaining text (two characters or more)
  -- matches a name, a city or the catalog search text.
  if query_text is not null then
    number_match := pg_catalog.regexp_match(query_text, '^#?([0-9]{1,7})$');
    if number_match is not null then
      local_number_filter := (number_match[1])::integer::text;
    else
      number_match := pg_catalog.regexp_match(query_text,
        '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', 'i');
      if number_match is not null then
        local_number_filter := (number_match[3])::integer::text;
        text_part := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(query_text,
          '(^|\s)(local|lu|lodge|branch|br|chapter|ch|division|div)\s*#?\s*([0-9]{1,7})(?=\s|$)', ' ', 'i'), '\s+', ' ', 'g'));
        full_pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(query_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';
      else
        text_part := query_text;
      end if;
    end if;
    if pg_catalog.char_length(text_part) >= 2 then
      pattern := '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(text_part, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    end if;
  end if;

  catalog_live := exists (select 1 from private.catalog_releases as r where r.status = 'active');

  with matches as (
    select 0 as source_rank, o.name as sort_name, o.catalog_key as sort_key, null::text as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', o.catalog_key,
        'registryOnly', false,
        'name', o.name,
        'family', o.family,
        'designation', o.designation,
        'localNumber', o.local_number,
        'tier', o.tier,
        'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                   when 'state' then 'intermediate' else 'local' end,
        'city', o.city,
        'state', o.state,
        'website', o.website,
        'membersReported', o.members_reported,
        'membersFiscalYear', o.members_fiscal_year,
        'registryId', o.union_org_id
      ) as payload
      from private.catalog_organizations as o
     where catalog_live
       and o.retired_release_id is null
       and o.duplicate_of is null
       and (local_number_filter is null or o.local_number = local_number_filter
            or (full_pattern is not null and o.name ilike full_pattern escape '\'))
       and (pattern is null or o.name ilike pattern escape '\' or o.city ilike pattern escape '\'
            or o.search_text ilike pattern escape '\')
       and (state_filter is null or o.state = state_filter)
       and (family_filter is null or o.family = family_filter)
       and (tier_filter is null or o.tier = tier_filter)
    union all
    select 1 as source_rank, u.name as sort_name, u.id as sort_key, u.parent_name as registry_parent,
      pg_catalog.jsonb_build_object(
        'key', u.id,
        'registryOnly', true,
        'name', u.name,
        'family', u.affiliation,
        'designation', u.designation,
        'localNumber', u.local_number,
        'tier', null,
        'level', u.level,
        'city', u.city,
        'state', u.state,
        'website', u.website,
        'membersReported', u.members_latest,
        'membersFiscalYear', u.members_latest_year,
        'registryId', u.id
      ) as payload
      from public.union_orgs as u
     where (local_number_filter is null or u.local_number = local_number_filter
            or (full_pattern is not null and u.name ilike full_pattern escape '\'))
       and (pattern is null or u.name ilike pattern escape '\' or u.city ilike pattern escape '\'
            or u.affiliation ilike pattern escape '\')
       and (state_filter is null or u.state = state_filter)
       and (family_filter is null or u.affiliation = family_filter)
       and (registry_level is null or u.level = registry_level)
       and (not catalog_live or not exists (
             select 1 from private.catalog_organizations as c
              where c.olms_file_number = u.olms_file_number and c.retired_release_id is null))
  )
  select
    (select pg_catalog.count(*) from (select 1 from matches limit 1001) as capped),
    coalesce((
      select pg_catalog.jsonb_agg(
               -- The "Part of" line. A catalog row: the highest-ranked live
               -- edge that still names something visible, that is its
               -- visible parent (an edge to a retired or duplicate
               -- organization is skipped, as in the profile) or else its
               -- scrubbed label (a label-only edge whose label is scrubbed is
               -- skipped, so a lower-ranked visible parent wins); null when
               -- no edge qualifies. A registry row: the registry's own
               -- parent name, scrubbed the same way.
               page.payload || pg_catalog.jsonb_build_object('parentName', case when page.source_rank = 0 then (
                 select coalesce(parent.name, private.catalog_scrub_text(e.parent_label))
                   from private.catalog_edges as e
                   left join private.catalog_organizations as parent
                     on parent.catalog_key = e.parent_key
                    and parent.retired_release_id is null
                    and parent.duplicate_of is null
                  where e.child_key = page.sort_key
                    and e.retired_release_id is null
                    and (e.parent_key is null or parent.catalog_key is not null)
                    and coalesce(parent.name, private.catalog_scrub_text(e.parent_label)) is not null
                  order by case e.edge_kind when 'olms_parent' then 0 when 'parent_body' then 1 else 2 end, e.edge_key
                  limit 1
               ) else private.catalog_scrub_text(page.registry_parent) end)
               order by page.source_rank, page.sort_name, page.sort_key)
        from (
          select m.source_rank, m.sort_name, m.sort_key, m.registry_parent, m.payload
            from matches as m
           order by m.source_rank, m.sort_name, m.sort_key
           limit 25 offset (p_page - 1) * 25
        ) as page
    ), '[]'::jsonb)
    into match_count, page_rows;

  return pg_catalog.jsonb_build_object(
    'rows', page_rows,
    'page', p_page,
    'pageSize', 25,
    'total', least(match_count, 1000),
    'totalCapped', match_count > 1000,
    'hasNext', p_page < 40 and p_page * 25 < least(match_count, 1000)
  );
end;
$function$;

revoke all on function public.search_union_catalog(text, text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.search_union_catalog(text, text, text, text, integer) to anon, authenticated, service_role;

comment on function public.search_union_catalog(text, text, text, text, integer) is
  'Anonymous union catalog search: active catalog organizations first (each with the parentName of its highest-ranked edge that names a visible parent or an unscrubbed label), then public.union_orgs rows with no live catalog row (registryOnly, parentName from the registry parent name, scrubbed). Needs a 2 to 80 character query or a state; 25 rows a page, at most 40 pages, totals capped at 1,000.';

create function public.get_union_catalog_profile(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization jsonb;
begin
  if p_key is null or p_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'invalid catalog key' using errcode = '22023';
  end if;

  -- Unknown, retired and duplicate keys, and every key while no release is
  -- active, get the same answer.
  select pg_catalog.jsonb_build_object(
      'key', o.catalog_key,
      'olmsFileNumber', o.olms_file_number,
      'registryId', o.union_org_id,
      'origin', o.origin,
      'name', o.name,
      'aka', o.aka,
      'family', o.family,
      'designation', o.designation,
      'localNumber', o.local_number,
      'tier', o.tier,
      'level', case o.tier when 'national' then 'national' when 'regional' then 'intermediate'
                 when 'state' then 'intermediate' else 'local' end,
      'orgTypeLabel', o.org_type_label,
      'sector', o.sector,
      'industries', o.industries,
      'occupations', o.occupations,
      'trades', o.trades,
      'city', o.city,
      'state', o.state,
      'zip5', o.zip5,
      'censusRegion', o.census_region,
      'censusDivision', o.census_division,
      'latitude', o.latitude,
      'longitude', o.longitude,
      'geoPrecision', o.geo_precision,
      'website', o.website,
      'membersReported', o.members_reported,
      'membersFiscalYear', o.members_fiscal_year,
      'structureNote', private.catalog_scrub_text(o.structure_note),
      'electionTermYears', o.election_term_years,
      'nextElectionOn', o.next_election_on,
      'bylawsUrl', o.bylaws_url,
      'confidence', o.confidence,
      'researchedOn', o.researched_on,
      'sourceUrls', o.source_urls
    )
    into organization
    from private.catalog_organizations as o
   where o.catalog_key = p_key
     and o.retired_release_id is null
     and o.duplicate_of is null
     and exists (select 1 from private.catalog_releases as r where r.status = 'active');
  if organization is null then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'organization', organization,
    'parents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.depth, item.edge_kind, item.edge_key)
        from (
          select walked.depth, walked.edge_kind, walked.edge_key,
            pg_catalog.jsonb_build_object(
              'depth', walked.depth,
              'childKey', walked.child_key,
              'parentKey', parent.catalog_key,
              'parentName', parent.name,
              'parentLabel', private.catalog_scrub_text(walked.parent_label),
              'edgeKind', walked.edge_kind,
              'certainty', walked.certainty,
              'sourceUrl', walked.source_url
            ) as payload
            from (
              with recursive chain as (
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url,
                       1 as depth
                  from private.catalog_edges as e
                 where e.child_key = p_key
                   and e.retired_release_id is null
                union
                select e.edge_key, e.child_key, e.parent_key, e.parent_label, e.edge_kind, e.certainty, e.source_url,
                       chain.depth + 1
                  from chain
                  -- The walk continues only through a visible organization.
                  join private.catalog_organizations as via
                    on via.catalog_key = chain.parent_key
                   and via.retired_release_id is null
                   and via.duplicate_of is null
                  join private.catalog_edges as e on e.child_key = via.catalog_key
                 where chain.depth < 8
                   and e.retired_release_id is null
              )
              select distinct on (chain.edge_key)
                     chain.edge_key, chain.child_key, chain.parent_key, chain.parent_label, chain.edge_kind,
                     chain.certainty, chain.source_url, chain.depth
                from chain
               order by chain.edge_key, chain.depth
            ) as walked
            left join private.catalog_organizations as parent
              on parent.catalog_key = walked.parent_key
             and parent.retired_release_id is null
             and parent.duplicate_of is null
           -- An edge to a retired or duplicate organization is left out, as
           -- that organization's own profile is; a label-only edge stays.
           where walked.parent_key is null or parent.catalog_key is not null
           order by walked.depth, walked.edge_kind, walked.edge_key
           limit 100
        ) as item
    ), '[]'::jsonb),
    'children', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.sort_name, item.edge_key)
        from (
          select child.name as sort_name, e.edge_key,
            pg_catalog.jsonb_build_object(
              'key', child.catalog_key,
              'name', child.name,
              'tier', child.tier,
              'localNumber', child.local_number,
              'city', child.city,
              'state', child.state,
              'edgeKind', e.edge_kind,
              'certainty', e.certainty
            ) as payload
            from private.catalog_edges as e
            join private.catalog_organizations as child on child.catalog_key = e.child_key
           where e.parent_key = p_key
             and e.retired_release_id is null
             and child.retired_release_id is null
             and child.duplicate_of is null
           order by child.name, e.edge_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'childrenTotal', (
      select pg_catalog.count(*)
        from private.catalog_edges as e
        join private.catalog_organizations as child on child.catalog_key = e.child_key
       where e.parent_key = p_key
         and e.retired_release_id is null
         and child.retired_release_id is null
         and child.duplicate_of is null
    ),
    'subunits', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.kind, item.name, item.subunit_key)
        from (
          select s.kind, s.name, s.subunit_key,
            pg_catalog.jsonb_build_object(
              'key', s.subunit_key,
              'parentKey', s.parent_subunit_key,
              'kind', s.kind,
              'kindLabel', private.catalog_scrub_text(s.kind_label),
              'name', private.catalog_scrub_text(s.name),
              'location', private.catalog_scrub_text(s.location),
              'employer', private.catalog_scrub_text(s.employer),
              'members', s.members,
              'membersSource', private.catalog_scrub_text(s.members_source),
              'densityNote', private.catalog_scrub_text(s.density_note),
              'website', s.website,
              'electionNote', private.catalog_scrub_text(s.election_note),
              'structureNote', private.catalog_scrub_text(s.structure_note),
              'confidence', s.confidence,
              'sourceUrl', s.source_url,
              'asOf', s.as_of
            ) as payload
            from private.catalog_subunits as s
           where s.catalog_key = p_key
             and s.retired_release_id is null
           order by s.kind, s.name, s.subunit_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'seatOutlines', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.scope, item.seat_class, item.outline_key)
        from (
          select coalesce(so.subunit_key, '') as scope, so.seat_class, so.outline_key,
            pg_catalog.jsonb_build_object(
              'key', so.outline_key,
              'subunitKey', so.subunit_key,
              'seatClass', so.seat_class,
              'title', private.catalog_scrub_text(so.title),
              'listed', so.listed,
              'vacant', so.vacant,
              'sourceUrl', so.source_url,
              'asOf', so.as_of
            ) as payload
            from private.catalog_seat_outlines as so
           where so.catalog_key = p_key
             and so.retired_release_id is null
           order by coalesce(so.subunit_key, ''), so.seat_class, so.outline_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'contacts', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.contact_kind, item.contact_key)
        from (
          select c.contact_kind, c.contact_key,
            pg_catalog.jsonb_build_object(
              'kind', c.contact_kind,
              'value', c.value,
              'label', private.catalog_scrub_text(c.label),
              'basis', c.basis,
              'sourceUrl', c.source_url,
              'asOf', c.as_of
            ) as payload
            from private.catalog_contacts as c
           where c.catalog_key = p_key
             and c.retired_release_id is null
           order by c.contact_kind, c.contact_key
           limit 50
        ) as item
    ), '[]'::jsonb),
    'documents', coalesce((
      select pg_catalog.jsonb_agg(item.payload order by item.doc_kind, item.document_key)
        from (
          select d.doc_kind, d.document_key,
            pg_catalog.jsonb_build_object(
              'key', d.document_key,
              'kind', d.doc_kind,
              'title', private.catalog_scrub_text(d.title),
              'titleDerived', d.title_derived,
              'url', d.url,
              'urlHost', d.url_host,
              'asOf', d.as_of,
              'subunitKeys', coalesce((
                select pg_catalog.jsonb_agg(link.subunit_key order by link.subunit_key)
                  from (
                    select ds.subunit_key
                      from private.catalog_document_subunits as ds
                     where ds.document_key = d.document_key
                       and ds.retired_release_id is null
                     order by ds.subunit_key
                     limit 50
                  ) as link
              ), '[]'::jsonb)
            ) as payload
            from private.catalog_documents as d
           where d.catalog_key = p_key
             and d.retired_release_id is null
           order by d.doc_kind, d.document_key
           limit 500
        ) as item
    ), '[]'::jsonb),
    'coverage', (
      select pg_catalog.jsonb_build_object(
          'band', cov.band,
          'checklist', cov.checklist,
          'subunits', cov.subunits,
          'subunitsWithMembers', cov.subunits_with_members,
          'seatOutlines', cov.seat_outlines,
          'documents', cov.documents,
          'demandBand', cov.demand_band,
          'communityVerifiedOn', cov.community_verified_on,
          'lastResearched', cov.last_researched
        )
        from private.catalog_coverage as cov
       where cov.catalog_key = p_key
    )
  );
end;
$function$;

revoke all on function public.get_union_catalog_profile(text) from public, anon, authenticated, service_role;
grant execute on function public.get_union_catalog_profile(text) to anon, authenticated, service_role;

comment on function public.get_union_catalog_profile(text) is
  'Anonymous union catalog profile for one live catalog key: the organization, parents up to 8 levels (edges to retired or duplicate organizations left out), up to 500 children with childrenTotal, sub-units, seat outlines and documents (totals in coverage), up to 50 contacts, and coverage. Unknown, retired and duplicate keys return {"found": false}.';

-- ---------------------------------------------------------------- activation

create function private.catalog_activate_release(p_label text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_id uuid;
  target_status text;
  target_loaded_at timestamptz;
  target_verified_at timestamptz;
  target_verified_sha256 text;
  staged_sha256 text;
  allow_retire bigint;
  previous_id uuid;
  staged_organizations bigint;
  live_organizations bigint;
  retiring_organizations bigint;
  live_subunits bigint;
  retiring_subunits bigint;
  mismatched_tables text[];
  diff jsonb;
begin
  if p_label is null or p_label !~ '^[0-9]{8}-[0-9]{2}$' then
    raise exception 'invalid catalog release label' using errcode = '22023';
  end if;

  -- One activation at a time. Only private.catalog_* rows are involved.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('union-catalog-activation', 509));

  select r.id, r.status, r.loaded_at, r.verified_at, r.verified_sha256, (r.counts ->> 'allowRetire')::bigint
    into target_id, target_status, target_loaded_at, target_verified_at, target_verified_sha256, allow_retire
    from private.catalog_releases as r
   where r.label = p_label
     for update;
  -- A staged release, or a retired one whose staging rows were kept for a
  -- rollback. Never the active release and never a failed one.
  if target_id is null or target_status not in ('staged', 'retired') then
    raise exception 'catalog release is not staged' using errcode = '22023';
  end if;
  -- catalog:verify stamps verified_at when the staged rows match the
  -- artifact; a later load clears the stamp by moving loaded_at past it, a
  -- failed verify clears it, and retiring a release clears it, so a rollback
  -- is verified again against the current exclusion list and privacy gate.
  if target_verified_at is null or target_verified_at < target_loaded_at then
    raise exception 'catalog release is not verified; run catalog:verify first' using errcode = '22023';
  end if;
  select pg_catalog.count(*)
    into staged_organizations
    from private.catalog_staging as s
   where s.release_id = target_id
     and s.table_name = 'organizations';
  if staged_organizations = 0 then
    raise exception 'catalog release has no staged rows; load it again' using errcode = '22023';
  end if;
  -- The staged rows must be exactly the ones catalog:verify matched: the
  -- digest (sha256 over every staged row's table, key, content hash and a
  -- sha256 of its content, in key order) is recomputed here and compared
  -- with the one verify stored. scripts/load-union-catalog.mjs
  -- (STAGING_DIGEST_SQL) computes the same expression.
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(pg_catalog.string_agg(
           s.table_name || ' ' || s.row_key || ' ' || s.content_sha256 || ' '
             || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(s.content::text, 'UTF8')), 'hex'),
           pg_catalog.chr(10) order by s.table_name, s.row_key), ''), 'UTF8')), 'hex')
    into staged_sha256
    from private.catalog_staging as s
   where s.release_id = target_id;
  if target_verified_sha256 is null or staged_sha256 is distinct from target_verified_sha256 then
    raise exception 'catalog release staged rows changed after catalog:verify; run catalog:verify again' using errcode = '22023';
  end if;

  -- The withdrawal guard (spec section 2.6), enforced where rows actually
  -- retire: more than 3% of live organizations or 10% of live sub-units may
  -- retire only under the ceiling the operator recorded with --allow-retire.
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where not exists (
           select 1 from private.catalog_staging as s
            where s.release_id = target_id and s.table_name = 'organizations' and s.row_key = o.catalog_key))
    into live_organizations, retiring_organizations
    from private.catalog_organizations as o
   where o.retired_release_id is null;
  select pg_catalog.count(*),
         pg_catalog.count(*) filter (where not exists (
           select 1 from private.catalog_staging as s
            where s.release_id = target_id and s.table_name = 'subunits' and s.row_key = u.subunit_key))
    into live_subunits, retiring_subunits
    from private.catalog_subunits as u
   where u.retired_release_id is null;
  if (allow_retire is not null and retiring_organizations + retiring_subunits > allow_retire)
     or (allow_retire is null
         and (retiring_organizations > live_organizations * 0.03 or retiring_subunits > live_subunits * 0.1)) then
    raise exception 'withdrawal guard: % of % live organizations and % of % live sub-units would retire; re-run activate with --allow-retire %',
      retiring_organizations, live_organizations, retiring_subunits, live_subunits, retiring_organizations + retiring_subunits
      using errcode = '22023';
  end if;

  -- Apply the staged set: insert new rows, update rows whose content changed
  -- or that were retired, leave unchanged live rows alone (first_release_id
  -- is never updated), then retire every live row the release does not carry.
  -- organizations
  insert into private.catalog_organizations as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_organizations,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'organizations'
  on conflict (catalog_key) do update
     set olms_file_number = excluded.olms_file_number,
         union_org_id = excluded.union_org_id,
         origin = excluded.origin,
         name = excluded.name,
         aka = excluded.aka,
         family = excluded.family,
         designation = excluded.designation,
         local_number = excluded.local_number,
         tier = excluded.tier,
         org_type_label = excluded.org_type_label,
         sector = excluded.sector,
         industries = excluded.industries,
         occupations = excluded.occupations,
         trades = excluded.trades,
         city = excluded.city,
         state = excluded.state,
         zip5 = excluded.zip5,
         census_region = excluded.census_region,
         census_division = excluded.census_division,
         latitude = excluded.latitude,
         longitude = excluded.longitude,
         geo_precision = excluded.geo_precision,
         website = excluded.website,
         members_reported = excluded.members_reported,
         members_fiscal_year = excluded.members_fiscal_year,
         structure_note = excluded.structure_note,
         election_term_years = excluded.election_term_years,
         next_election_on = excluded.next_election_on,
         bylaws_url = excluded.bylaws_url,
         confidence = excluded.confidence,
         researched_on = excluded.researched_on,
         source_urls = excluded.source_urls,
         duplicate_of = excluded.duplicate_of,
         search_text = excluded.search_text,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- edges
  insert into private.catalog_edges as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_edges,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'edges'
  on conflict (edge_key) do update
     set child_key = excluded.child_key,
         parent_key = excluded.parent_key,
         parent_label = excluded.parent_label,
         edge_kind = excluded.edge_kind,
         certainty = excluded.certainty,
         source_url = excluded.source_url,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- subunits
  insert into private.catalog_subunits as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_subunits,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'subunits'
  on conflict (subunit_key) do update
     set catalog_key = excluded.catalog_key,
         parent_subunit_key = excluded.parent_subunit_key,
         kind = excluded.kind,
         kind_label = excluded.kind_label,
         name = excluded.name,
         location = excluded.location,
         employer = excluded.employer,
         members = excluded.members,
         members_source = excluded.members_source,
         density_note = excluded.density_note,
         website = excluded.website,
         election_note = excluded.election_note,
         structure_note = excluded.structure_note,
         confidence = excluded.confidence,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- seat_outlines
  insert into private.catalog_seat_outlines as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_seat_outlines,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'seat_outlines'
  on conflict (outline_key) do update
     set catalog_key = excluded.catalog_key,
         subunit_key = excluded.subunit_key,
         seat_class = excluded.seat_class,
         title = excluded.title,
         listed = excluded.listed,
         vacant = excluded.vacant,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- contacts
  insert into private.catalog_contacts as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_contacts,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'contacts'
  on conflict (contact_key) do update
     set catalog_key = excluded.catalog_key,
         contact_kind = excluded.contact_kind,
         value = excluded.value,
         label = excluded.label,
         basis = excluded.basis,
         source_url = excluded.source_url,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- documents
  insert into private.catalog_documents as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_documents,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'documents'
  on conflict (document_key) do update
     set catalog_key = excluded.catalog_key,
         doc_kind = excluded.doc_kind,
         title = excluded.title,
         title_derived = excluded.title_derived,
         url = excluded.url,
         url_host = excluded.url_host,
         as_of = excluded.as_of,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- document_subunits
  insert into private.catalog_document_subunits as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_document_subunits,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'document_subunits'
  on conflict (document_key, subunit_key) do update
     set last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;


  update private.catalog_organizations as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'organizations' and s.row_key = t.catalog_key);

  update private.catalog_edges as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'edges' and s.row_key = t.edge_key);

  update private.catalog_subunits as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'subunits' and s.row_key = t.subunit_key);

  update private.catalog_seat_outlines as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'seat_outlines' and s.row_key = t.outline_key);

  update private.catalog_contacts as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'contacts' and s.row_key = t.contact_key);

  update private.catalog_documents as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'documents' and s.row_key = t.document_key);

  update private.catalog_document_subunits as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'document_subunits' and s.row_key = t.document_key || '|' || t.subunit_key);

  select r.id
    into previous_id
    from private.catalog_releases as r
   where r.status = 'active';

  -- The retired release keeps its staging rows for a rollback, but not its
  -- verify stamp: activating it again needs a fresh catalog:verify.
  update private.catalog_releases as r
     set status = 'retired',
         verified_at = null,
         verified_sha256 = null
   where r.status = 'active';

  update private.catalog_releases as r
     set status = 'active',
         activated_at = pg_catalog.now()
   where r.id = target_id;

  delete from private.catalog_coverage as cov
   where cov.catalog_key is not null;

  insert into private.catalog_coverage (
    catalog_key, release_id, subunits, subunits_with_members, seat_outlines, documents, checklist, band, last_researched
  )
  select o.catalog_key,
         target_id,
         coalesce(sub.total, 0),
         coalesce(sub.with_members, 0),
         coalesce(seat.total, 0),
         pg_catalog.jsonb_build_object(
           'contract', coalesce(doc.contracts, 0),
           'bylaws', coalesce(doc.bylaws, 0),
           'form', coalesce(doc.forms, 0),
           'newsletter', coalesce(doc.newsletters, 0),
           'handbook', coalesce(doc.handbooks, 0),
           'other', coalesce(doc.others, 0)
         ),
         pg_catalog.jsonb_build_object(
           'website', o.website is not null,
           'publicContact', coalesce(contact.public_contacts, 0) > 0,
           'structure', coalesce(sub.total, 0) > 0,
           'seats', coalesce(seat.total, 0) > 0,
           'governingDocument', o.bylaws_url is not null or coalesce(doc.bylaws, 0) > 0,
           'contract', coalesce(doc.contracts, 0) > 0,
           'electionCadence', o.election_term_years is not null or o.next_election_on is not null,
           'hierarchy', coalesce(edge.total, 0) > 0
         ),
         case
           when coalesce(sub.total, 0) > 0 and coalesce(doc.total, 0) > 0 and o.members_reported is not null then 'deep'
           when coalesce(sub.total, 0) > 0 or coalesce(seat.total, 0) > 0 then 'structured'
           else 'basic'
         end,
         o.researched_on
    from private.catalog_organizations as o
    left join (
      select s.catalog_key, pg_catalog.count(*) as total,
             pg_catalog.count(*) filter (where s.members is not null) as with_members
        from private.catalog_subunits as s
       where s.retired_release_id is null
       group by s.catalog_key
    ) as sub on sub.catalog_key = o.catalog_key
    left join (
      select so.catalog_key, pg_catalog.count(*) as total
        from private.catalog_seat_outlines as so
       where so.retired_release_id is null
       group by so.catalog_key
    ) as seat on seat.catalog_key = o.catalog_key
    left join (
      select d.catalog_key, pg_catalog.count(*) as total,
             pg_catalog.count(*) filter (where d.doc_kind = 'contract') as contracts,
             pg_catalog.count(*) filter (where d.doc_kind = 'bylaws') as bylaws,
             pg_catalog.count(*) filter (where d.doc_kind = 'form') as forms,
             pg_catalog.count(*) filter (where d.doc_kind = 'newsletter') as newsletters,
             pg_catalog.count(*) filter (where d.doc_kind = 'handbook') as handbooks,
             pg_catalog.count(*) filter (where d.doc_kind = 'other') as others
        from private.catalog_documents as d
       where d.retired_release_id is null
       group by d.catalog_key
    ) as doc on doc.catalog_key = o.catalog_key
    left join (
      select c.catalog_key, pg_catalog.count(*) filter (where c.contact_kind <> 'website') as public_contacts
        from private.catalog_contacts as c
       where c.retired_release_id is null
       group by c.catalog_key
    ) as contact on contact.catalog_key = o.catalog_key
    left join (
      select ends.catalog_key, pg_catalog.count(*) as total
        from (
          select e.child_key as catalog_key from private.catalog_edges as e where e.retired_release_id is null
          union all
          select e.parent_key from private.catalog_edges as e where e.retired_release_id is null and e.parent_key is not null
        ) as ends
       group by ends.catalog_key
    ) as edge on edge.catalog_key = o.catalog_key
   where o.retired_release_id is null
     and o.duplicate_of is null;


  -- The live, non-retired row set must now be exactly the staged set.
  select pg_catalog.array_agg(live.table_name order by live.table_name)
    into mismatched_tables
    from (
      select 'organizations' as table_name, pg_catalog.count(*) as live_rows
        from private.catalog_organizations as t where t.retired_release_id is null
      union all
      select 'edges', pg_catalog.count(*) from private.catalog_edges as t where t.retired_release_id is null
      union all
      select 'subunits', pg_catalog.count(*) from private.catalog_subunits as t where t.retired_release_id is null
      union all
      select 'seat_outlines', pg_catalog.count(*) from private.catalog_seat_outlines as t where t.retired_release_id is null
      union all
      select 'contacts', pg_catalog.count(*) from private.catalog_contacts as t where t.retired_release_id is null
      union all
      select 'documents', pg_catalog.count(*) from private.catalog_documents as t where t.retired_release_id is null
      union all
      select 'document_subunits', pg_catalog.count(*) from private.catalog_document_subunits as t where t.retired_release_id is null
    ) as live
    left join (
      select s.table_name, pg_catalog.count(*) as staged_rows
        from private.catalog_staging as s
       where s.release_id = target_id
       group by s.table_name
    ) as staged on staged.table_name = live.table_name
   where live.live_rows <> coalesce(staged.staged_rows, 0);
  if mismatched_tables is not null then
    raise exception 'catalog activation left % out of step with the staged release', mismatched_tables;
  end if;

  -- Counts only: what this release added, retired and changed.
  diff := pg_catalog.jsonb_build_object(
    'organizationsAdded', (select pg_catalog.count(*) from private.catalog_organizations as o
                            where o.first_release_id = target_id and o.retired_release_id is null),
    'organizationsRetired', (select pg_catalog.count(*) from private.catalog_organizations as o
                              where o.retired_release_id = target_id),
    'organizationsChanged', (select pg_catalog.count(*) from private.catalog_organizations as o
                              where o.last_release_id = target_id and o.first_release_id <> target_id
                                and o.retired_release_id is null),
    'subunitsAdded', (select pg_catalog.count(*) from private.catalog_subunits as s
                       where s.first_release_id = target_id and s.retired_release_id is null),
    'subunitsRetired', (select pg_catalog.count(*) from private.catalog_subunits as s
                         where s.retired_release_id = target_id)
  );

  update private.catalog_releases as r
     set activation_diff = diff
   where r.id = target_id;

  -- Keep the staging rows of this release and of the one it retired (a
  -- rollback re-applies them); every other release must be loaded again.
  delete from private.catalog_staging as s
   where s.release_id <> target_id
     and s.release_id is distinct from previous_id;

  return diff;
end;
$function$;

revoke all on function private.catalog_activate_release(text) from public, anon, authenticated, service_role;

comment on function private.catalog_activate_release(text) is
  'Activates one verified union catalog release in one transaction (the staged rows must still match the digest catalog:verify stored): applies its staged rows to the live tables (insert, update changed, retire absent) under the withdrawal guard, retires the active release (clearing its verify stamp), marks this one active, recomputes private.catalog_coverage, records a counts-only diff and drops the staging rows of every release but this one and the one it retired. No Data API role may call it; only the owner-connected loader does.';

notify pgrst, 'reload schema';

commit;
