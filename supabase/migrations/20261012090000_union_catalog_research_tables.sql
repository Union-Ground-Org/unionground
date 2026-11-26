-- REQ-UG-UNION-CATALOG-RESEARCH-EXPORT-TRANSLATOR-20261012
--
-- Two research release tables for the public-record union catalog, the
-- owner-authorized step 2 of the tiered research export flow (owner decision
-- of 2026-10-12, about 2:05 AM ET). scripts/union-catalog/
-- translate-research-export.mjs turns the union-directory research export
-- into a complete union-catalog-release/1 snapshot: the seven content tables
-- of a pinned accepted base release, unchanged, plus these two tables.
--
--   * private.catalog_research_facts: one row per name-free research fact
--     about a public document or structure page, under the kind the research
--     projection typed (union-directory-research-export/1): URL, host, title
--     (none in export v1), kind, as-of date, the research evidence tier (1
--     kept by R1 typing but not R1 to R4 eligible, with any ur-* unresolved
--     codes; 2 eligible under R1 to R4) and the packet digest it came from. A fact
--     names its subject (catalog_key) only when the research chain's issuer
--     binding is `bound`; otherwise it lists unconfirmed publisher candidates.
--   * private.catalog_research_categories: Tier 3, one row per category
--     observation of the versioned Q9 category gate
--     (usability_contract_v5.category_gate), a captured publication or
--     checked and not published, never a per-fact row.
--
-- evidence_tier is the research chain's tier. It is not the `tier` column of
-- catalog_organizations, which means organization level.
--
-- Boundaries, as for every private.catalog_* table: no person-level data (no
-- quote, label, value, holder, name, email or phone column exists; the
-- translator refuses an export carrying one), RLS enabled and forced with no
-- policy and no grant, written only through catalog_staging and
-- private.catalog_activate_release by the owner-connected loader, retired and
-- never deleted, and nothing here points outside the private.catalog_*
-- tables. The anonymous catalog RPCs do not read these tables; the only read
-- path is public.get_union_catalog_research_draft, a service-role RPC for an
-- active platform operator (the claim verifier capability, AAL2 session),
-- which feeds the operator-only research draft view. Nothing here reaches the
-- public /union-directory route.
--
-- catalog_staging learns the two table names, and
-- private.catalog_activate_release is replaced with a body that also applies
-- and retires research rows and counts them in its live-equals-staged check.
-- A release without research tables retires every live research row, since a
-- release is a complete snapshot; the loader's plan and load refuse a
-- research release that would retire any row it does not withdraw on purpose.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------- research facts

create table private.catalog_research_facts (
  fact_key text not null
    constraint catalog_research_facts_fact_key_check check (fact_key ~ '^rf-[0-9a-f]{32}$'),
  evidence_tier smallint not null
    constraint catalog_research_facts_evidence_tier_check check (evidence_tier in (1, 2)),
  binding text not null
    constraint catalog_research_facts_binding_check check (binding in ('bound', 'unconfirmed')),
  catalog_key text,
  publisher_candidates text[] not null default '{}'
    constraint catalog_research_facts_publisher_candidates_check check (
      cardinality(publisher_candidates) <= 50
      and array_position(publisher_candidates, null) is null
      and (cardinality(publisher_candidates) = 0
           or array_to_string(publisher_candidates, ' ')
              ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})( (olms-[0-9]{1,9}|ug-[a-z0-9]{10}))*$')),
  fact_kind text not null
    constraint catalog_research_facts_fact_kind_check check (fact_kind in ('contract', 'governance', 'document', 'form',
      'grievance', 'parent', 'sub_unit', 'jurisdiction', 'merger', 'bargaining_unit')),
  title text
    constraint catalog_research_facts_title_check check (char_length(btrim(title)) between 1 and 300 and title !~ '[[:cntrl:]]'),
  url text not null
    constraint catalog_research_facts_url_check check (url ~ '^https?://' and char_length(url) <= 2000),
  url_host text not null
    constraint catalog_research_facts_url_host_check check (char_length(url_host) between 1 and 253),
  as_of date,
  unresolved text[] not null default '{}'
    constraint catalog_research_facts_unresolved_check check (
      cardinality(unresolved) <= 10
      and array_position(unresolved, null) is null
      and (cardinality(unresolved) = 0
           or array_to_string(unresolved, ' ') ~ '^ur-[0-9a-f]{12}( ur-[0-9a-f]{12})*$')),
  source_sha256 text not null
    constraint catalog_research_facts_source_sha256_check check (source_sha256 ~ '^[0-9a-f]{64}$'),
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_research_facts_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_research_facts_pkey primary key (fact_key),
  constraint catalog_research_facts_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key),
  constraint catalog_research_facts_bound_names_subject check ((binding = 'bound') = (catalog_key is not null)),
  constraint catalog_research_facts_unbound_has_candidate check (catalog_key is not null or cardinality(publisher_candidates) >= 1),
  constraint catalog_research_facts_tier_reasons check (evidence_tier = 1 or cardinality(unresolved) = 0)
);

create index catalog_research_facts_catalog_key_idx on private.catalog_research_facts (catalog_key)
  where retired_release_id is null;
create index catalog_research_facts_candidates_idx on private.catalog_research_facts
  using gin (publisher_candidates) where retired_release_id is null;

comment on table private.catalog_research_facts is
  'Name-free research facts about public documents and structure pages of catalog organizations (URL, host, title, kind, as-of date, research evidence tier 1 or 2, ur-* unresolved codes, packet digest). catalog_key is set only when the research issuer binding is bound; otherwise publisher_candidates lists unconfirmed catalog keys. evidence_tier is not the organization-level tier. Loaded only by the reviewed catalog loader; rows are retired, never deleted.';

alter table private.catalog_research_facts enable row level security;
alter table private.catalog_research_facts force row level security;
revoke all on table private.catalog_research_facts from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- research categories

create table private.catalog_research_categories (
  category_key text not null
    constraint catalog_research_categories_category_key_check check (category_key ~ '^rc-[0-9a-f]{32}$'),
  catalog_key text not null,
  evidence_tier smallint not null
    constraint catalog_research_categories_evidence_tier_check check (evidence_tier = 3),
  category text not null
    constraint catalog_research_categories_category_check check (category ~ '^[a-z][a-z0-9_]{2,63}$'),
  outcome text not null
    constraint catalog_research_categories_outcome_check check (outcome in ('captured_publication', 'checked_not_published')),
  gate_contract text not null
    constraint catalog_research_categories_gate_contract_check check (gate_contract = 'usability_contract_v5.category_gate'),
  evaluated_on date not null,
  first_release_id uuid not null,
  last_release_id uuid not null,
  retired_release_id uuid,
  content_sha256 text not null
    constraint catalog_research_categories_content_sha256_check check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_research_categories_pkey primary key (category_key),
  constraint catalog_research_categories_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key)
);

create index catalog_research_categories_catalog_key_idx on private.catalog_research_categories (catalog_key)
  where retired_release_id is null;

comment on table private.catalog_research_categories is
  'Tier 3 research observations: one row per catalog organization and category evaluated by the versioned Q9 category gate (usability_contract_v5.category_gate), a captured publication or checked and not published. Never per-fact rows. Loaded only by the reviewed catalog loader; rows are retired, never deleted.';

alter table private.catalog_research_categories enable row level security;
alter table private.catalog_research_categories force row level security;
revoke all on table private.catalog_research_categories from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- staging

alter table private.catalog_staging drop constraint catalog_staging_table_name_check;
alter table private.catalog_staging add constraint catalog_staging_table_name_check
  check (table_name in ('organizations', 'edges', 'subunits', 'seat_outlines', 'contacts', 'documents',
    'document_subunits', 'research_facts', 'research_categories'));

-- ---------------------------------------------------------------- releases

-- A research release's load markers (scripts/load-union-catalog.mjs): the
-- base artifact its content rows are carried from, and the release that was
-- active when it loaded, which activation rechecks. They are columns, not
-- counts keys, because public.get_union_catalog_status returns counts to
-- anon; for the same reason the loader keeps the research_* rollups off it.
alter table private.catalog_releases
  add column research_base_sha256 text
    constraint catalog_releases_research_base_sha256_check check (research_base_sha256 ~ '^[0-9a-f]{64}$'),
  add column research_loaded_over uuid,
  add constraint catalog_releases_research_markers_check
    check ((research_base_sha256 is null) = (research_loaded_over is null));

-- ---------------------------------------------------------------- activation

create or replace function private.catalog_activate_release(p_label text)
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
  research_loaded_over uuid;
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

  -- A research release carries its base's content rows unchanged and was
  -- checked at load against the live rows of the release then active
  -- (catalog:load records its id in research_loaded_over). It may
  -- replace only that release: if another release was activated since, its
  -- corrections or research rows would be overwritten or retired unchecked.
  -- A retired target is a deliberate rollback to a snapshot that was live,
  -- verified again, under the withdrawal guard below; it is not rechecked.
  select r.research_loaded_over into research_loaded_over from private.catalog_releases as r where r.id = target_id;
  if target_status = 'staged'
     and research_loaded_over is not null
     and research_loaded_over is distinct from (
       select r.id from private.catalog_releases as r where r.status = 'active') then
    raise exception 'catalog research release was loaded over a release that is no longer active; load it again' using errcode = '22023';
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

  -- research_facts
  insert into private.catalog_research_facts as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_research_facts,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'research_facts'
  on conflict (fact_key) do update
     set evidence_tier = excluded.evidence_tier,
         binding = excluded.binding,
         catalog_key = excluded.catalog_key,
         publisher_candidates = excluded.publisher_candidates,
         fact_kind = excluded.fact_kind,
         title = excluded.title,
         url = excluded.url,
         url_host = excluded.url_host,
         as_of = excluded.as_of,
         unresolved = excluded.unresolved,
         source_sha256 = excluded.source_sha256,
         last_release_id = excluded.last_release_id,
         retired_release_id = null,
         content_sha256 = excluded.content_sha256
   where t.content_sha256 is distinct from excluded.content_sha256
      or t.retired_release_id is not null;

  -- research_categories
  insert into private.catalog_research_categories as t
  select r.*
    from private.catalog_staging as s
    cross join lateral pg_catalog.jsonb_populate_record(
      null::private.catalog_research_categories,
      s.content || pg_catalog.jsonb_build_object(
        'first_release_id', target_id, 'last_release_id', target_id, 'retired_release_id', null, 'content_sha256', s.content_sha256)
    ) as r
   where s.release_id = target_id
     and s.table_name = 'research_categories'
  on conflict (category_key) do update
     set catalog_key = excluded.catalog_key,
         evidence_tier = excluded.evidence_tier,
         category = excluded.category,
         outcome = excluded.outcome,
         gate_contract = excluded.gate_contract,
         evaluated_on = excluded.evaluated_on,
         last_release_id = excluded.last_release_id,
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

  -- A release without research tables retires every live research row: a
  -- release is a complete snapshot of everything it carries.
  update private.catalog_research_facts as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'research_facts' and s.row_key = t.fact_key);

  update private.catalog_research_categories as t
     set retired_release_id = target_id
   where t.retired_release_id is null
     and not exists (
       select 1 from private.catalog_staging as s
        where s.release_id = target_id and s.table_name = 'research_categories' and s.row_key = t.category_key);

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
      union all
      select 'research_facts', pg_catalog.count(*) from private.catalog_research_facts as t where t.retired_release_id is null
      union all
      select 'research_categories', pg_catalog.count(*) from private.catalog_research_categories as t where t.retired_release_id is null
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
  -- Research counts appear only when research rows were involved, so the
  -- diff of a release without research tables keeps its earlier shape.
  if exists (select 1 from private.catalog_staging as s
              where s.release_id = target_id and s.table_name in ('research_facts', 'research_categories'))
     or exists (select 1 from private.catalog_research_facts as f where f.retired_release_id = target_id)
     or exists (select 1 from private.catalog_research_categories as c where c.retired_release_id = target_id) then
    diff := diff || pg_catalog.jsonb_build_object(
      'researchFactsAdded', (select pg_catalog.count(*) from private.catalog_research_facts as f
                              where f.first_release_id = target_id and f.retired_release_id is null),
      'researchFactsRetired', (select pg_catalog.count(*) from private.catalog_research_facts as f
                                where f.retired_release_id = target_id),
      'researchCategoriesAdded', (select pg_catalog.count(*) from private.catalog_research_categories as c
                                   where c.first_release_id = target_id and c.retired_release_id is null),
      'researchCategoriesRetired', (select pg_catalog.count(*) from private.catalog_research_categories as c
                                     where c.retired_release_id = target_id)
    );
  end if;

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
  'Activates one verified union catalog release in one transaction (the staged rows must still match the digest catalog:verify stored): applies its staged rows, research rows included, to the live tables (insert, update changed, retire absent) under the withdrawal guard, retires the active release (clearing its verify stamp), marks this one active, recomputes private.catalog_coverage, records a counts-only diff and drops the staging rows of every release but this one and the one it retired. No Data API role may call it; only the owner-connected loader does.';

-- ---------------------------------------------------------------- research draft read path

-- The operator-only research draft view. Without a key it lists, 25 to a
-- page, the live primary organizations that research rows name, with counts
-- by evidence tier; with a key it returns that organization's facts (bound to
-- it, or naming it as an unconfirmed publisher candidate), 50 to a page, and
-- its Tier 3 category observations. Every fact says its tier and whether its
-- subject is bound or only a candidate. Titles pass catalog_scrub_text.
create function public.get_union_catalog_research_draft(
  p_operator_user_id uuid,
  p_catalog_key text,
  p_page integer,
  p_operator_session_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  page integer;
  release_label text;
  organization record;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);
  page := coalesce(p_page, 1);
  if page not between 1 and 2000 then
    raise exception 'page invalid' using errcode = '22023';
  end if;
  select r.label into release_label from private.catalog_releases as r where r.status = 'active';

  if p_catalog_key is null then
    return pg_catalog.jsonb_build_object(
      'page', page,
      'releaseLabel', release_label,
      'organizations', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'catalogKey', listed.catalog_key,
          'name', listed.name,
          'state', listed.state,
          'tier1', listed.tier1,
          'tier2', listed.tier2,
          'unconfirmed', listed.unconfirmed,
          'categories', listed.categories
        ) order by listed.name, listed.catalog_key)
        from (
          select o.catalog_key, o.name, o.state,
                 (select pg_catalog.count(*) from private.catalog_research_facts as f
                   where f.retired_release_id is null and f.catalog_key = o.catalog_key and f.evidence_tier = 1) as tier1,
                 (select pg_catalog.count(*) from private.catalog_research_facts as f
                   where f.retired_release_id is null and f.catalog_key = o.catalog_key and f.evidence_tier = 2) as tier2,
                 (select pg_catalog.count(*) from private.catalog_research_facts as f
                   where f.retired_release_id is null and f.catalog_key is null
                     and f.publisher_candidates @> array[o.catalog_key]) as unconfirmed,
                 (select pg_catalog.count(*) from private.catalog_research_categories as c
                   where c.retired_release_id is null and c.catalog_key = o.catalog_key) as categories
            from private.catalog_organizations as o
           where o.retired_release_id is null
             and o.duplicate_of is null
             and (exists (select 1 from private.catalog_research_facts as f
                           where f.retired_release_id is null
                             and (f.catalog_key = o.catalog_key
                                  or (f.catalog_key is null and f.publisher_candidates @> array[o.catalog_key])))
                  or exists (select 1 from private.catalog_research_categories as c
                              where c.retired_release_id is null and c.catalog_key = o.catalog_key))
           order by o.name, o.catalog_key
           limit 25 offset (page - 1) * 25
        ) as listed
      ), '[]'::jsonb)
    );
  end if;

  if p_catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'catalog key invalid' using errcode = '22023';
  end if;
  select o.catalog_key, o.name, o.state, o.tier
    into organization
    from private.catalog_organizations as o
   where o.catalog_key = p_catalog_key
     and o.retired_release_id is null
     and o.duplicate_of is null;
  if organization.catalog_key is null then
    raise exception 'catalog key invalid' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'page', page,
    'releaseLabel', release_label,
    'organization', pg_catalog.jsonb_build_object(
      'catalogKey', organization.catalog_key, 'name', organization.name,
      'state', organization.state, 'level', organization.tier),
    'facts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'factKey', listed.fact_key,
        'evidenceTier', listed.evidence_tier,
        'subject', case when listed.catalog_key = p_catalog_key then 'bound' else 'candidate' end,
        'otherCandidates', pg_catalog.cardinality(listed.publisher_candidates)
                             - case when p_catalog_key = any (listed.publisher_candidates) then 1 else 0 end,
        'kind', listed.fact_kind,
        'title', private.catalog_scrub_text(listed.title),
        'url', listed.url,
        'host', listed.url_host,
        'asOf', listed.as_of,
        'unresolved', pg_catalog.to_jsonb(listed.unresolved)
      ) order by listed.evidence_tier desc, listed.fact_kind, listed.fact_key)
      from (
        select f.fact_key, f.evidence_tier, f.catalog_key, f.publisher_candidates, f.fact_kind, f.title,
               f.url, f.url_host, f.as_of, f.unresolved
          from private.catalog_research_facts as f
         where f.retired_release_id is null
           and (f.catalog_key = p_catalog_key
                or (f.catalog_key is null and f.publisher_candidates @> array[p_catalog_key]))
         order by f.evidence_tier desc, f.fact_kind, f.fact_key
         limit 50 offset (page - 1) * 50
      ) as listed
    ), '[]'::jsonb),
    'categories', case when page > 1 then '[]'::jsonb else coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'categoryKey', c.category_key,
        'evidenceTier', c.evidence_tier,
        'category', c.category,
        'outcome', c.outcome,
        'gateContract', c.gate_contract,
        'evaluatedOn', c.evaluated_on
      ) order by c.category, c.category_key)
        from private.catalog_research_categories as c
       where c.retired_release_id is null
         and c.catalog_key = p_catalog_key
    ), '[]'::jsonb) end
  );
end;
$function$;

revoke all on function public.get_union_catalog_research_draft(uuid, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.get_union_catalog_research_draft(uuid, text, integer, uuid) to service_role;

comment on function public.get_union_catalog_research_draft(uuid, text, integer, uuid) is
  'Operator-only research draft read path: service role carrying an active platform operator (claim_verification, AAL2 session). Lists organizations with live research rows and their counts by evidence tier, or returns one organization''s research facts (each with its evidence tier and whether its subject is bound or only an unconfirmed publisher candidate) and Tier 3 category observations. Never person data; not part of the public catalog.';

notify pgrst, 'reload schema';

commit;
