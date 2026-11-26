-- REQ-UG-LM2-TRANSPARENCY-20261012: LM-2, LM-3 and LM-4 financial
-- summaries from the OLMS public yearly data, as union catalog release tables.
--
-- Boundaries:
--   * public-record aggregates only: one row per OLMS file number and year
--     covered, no per-officer or per-employee row (owner question 2 default),
--     and no organization name: names come from public.union_orgs;
--   * every row, every bulk-file source record and every precomputed peer
--     benchmark carries its provenance record with the named CHECK
--     (docs/conventions/provenance.md);
--   * no migration, seed or console writes these tables: only
--     scripts/union-catalog/load-lm2-summaries.mjs, as the database owner,
--     and it refuses every hosted target until project decision D1;
--   * no client grant and no policy; members and leaders read through the two
--     RPCs below, for the OLMS filer their own chapter is verified as
--     (public.chapter_union_org_bindings status 'verified');
--   * retired rows (absent from the latest release) are kept and never read.

begin;

set local lock_timeout = '5s';

create table private.catalog_lm2_sources (
  provenance_id text primary key check (provenance_id ~ '^prov-[0-9a-f]{64}$'),
  provenance pg_catalog.jsonb not null,
  constraint catalog_lm2_sources_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  ),
  first_release_label text not null check (first_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  last_release_label text not null check (last_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  retired_release_label text check (retired_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  constraint catalog_lm2_sources_id_matches check (provenance ->> 'provenance_id' = provenance_id)
);

create table private.catalog_lm2_summaries (
  olms_file_number integer not null check (olms_file_number > 0),
  year_covered smallint not null check (year_covered between 2000 and 2100),
  form_type text not null check (form_type in ('LM-2', 'LM-3', 'LM-4')),
  rpt_id bigint not null check (rpt_id > 0),
  aff_abbr text check (aff_abbr ~ '^[A-Za-z0-9&./ -]{1,20}$'),
  state text check (state ~ '^[A-Z0-9]{2}$'),
  size_band text check (size_band in ('under-100', '100-499', '500-999', '1000-4999', '5000-24999', '25000-plus')),
  period_from date,
  period_to date,
  members integer check (members >= 0),
  total_receipts numeric(16, 2),
  total_disbursements numeric(16, 2),
  total_assets numeric(16, 2),
  total_liabilities numeric(16, 2),
  net_assets numeric(16, 2),
  dues_receipts numeric(16, 2),
  fees_receipts numeric(16, 2),
  dues_and_fees_receipts numeric(16, 2),
  officer_disbursements_gross numeric(16, 2),
  employee_disbursements_gross numeric(16, 2),
  per_capita_tax_disbursements numeric(16, 2),
  lm2_functional jsonb check (lm2_functional is null or jsonb_typeof(lm2_functional) = 'object'),
  receipts_per_member numeric(16, 2),
  dues_and_fees_per_member numeric(16, 2),
  schedule_totals_missing boolean not null default false,
  provenance pg_catalog.jsonb not null,
  constraint catalog_lm2_summaries_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  ),
  first_release_label text not null check (first_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  last_release_label text not null check (last_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  retired_release_label text check (retired_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  provenance_id text generated always as (provenance ->> 'provenance_id') stored,
  primary key (olms_file_number, year_covered, provenance_id)
);

create unique index catalog_lm2_summaries_live_idx
  on private.catalog_lm2_summaries (olms_file_number, year_covered)
  where retired_release_label is null;

create index catalog_lm2_summaries_peer_idx
  on private.catalog_lm2_summaries (year_covered, aff_abbr, size_band)
  where retired_release_label is null;

create table private.catalog_lm2_peer_benchmarks (
  year_covered smallint not null check (year_covered between 2000 and 2100),
  aff_abbr text not null check (aff_abbr ~ '^[A-Za-z0-9&./ -]{1,20}$'),
  size_band text not null check (size_band in ('under-100', '100-499', '500-999', '1000-4999', '5000-24999', '25000-plus')),
  peers integer not null check (peers >= 5),
  stats jsonb not null check (jsonb_typeof(stats) = 'object'),
  provenance pg_catalog.jsonb not null,
  constraint catalog_lm2_peer_benchmarks_provenance_complete check (
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  ),
  first_release_label text not null check (first_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  last_release_label text not null check (last_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  retired_release_label text check (retired_release_label ~ '^[0-9]{8}-[0-9]{2}$'),
  provenance_id text generated always as (provenance ->> 'provenance_id') stored,
  primary key (year_covered, aff_abbr, size_band, provenance_id)
);

create unique index catalog_lm2_benchmarks_live_idx
  on private.catalog_lm2_peer_benchmarks (year_covered, aff_abbr, size_band)
  where retired_release_label is null;

alter table private.catalog_lm2_sources enable row level security;
alter table private.catalog_lm2_sources force row level security;
alter table private.catalog_lm2_summaries enable row level security;
alter table private.catalog_lm2_summaries force row level security;
alter table private.catalog_lm2_peer_benchmarks enable row level security;
alter table private.catalog_lm2_peer_benchmarks force row level security;
revoke all on private.catalog_lm2_sources from public, anon, authenticated, service_role;
revoke all on private.catalog_lm2_summaries from public, anon, authenticated, service_role;
revoke all on private.catalog_lm2_peer_benchmarks from public, anon, authenticated, service_role;

comment on table private.catalog_lm2_sources is
  'REQ-UG-LM2-TRANSPARENCY-20261012: the OLMS yearly bulk files and their member files, one provenance record each; loaded only by scripts/union-catalog/load-lm2-summaries.mjs.';
comment on table private.catalog_lm2_summaries is
  'REQ-UG-LM2-TRANSPARENCY-20261012: per-filer LM-2/LM-3/LM-4 aggregates by OLMS file number and year covered, each with its computed provenance record; no person rows, no names. Loaded only by scripts/union-catalog/load-lm2-summaries.mjs.';
comment on table private.catalog_lm2_peer_benchmarks is
  'REQ-UG-LM2-TRANSPARENCY-20261012: quartiles of per-member figures for filers of one affiliation and size band in one year (five or more peers), each with its computed provenance record.';

-- The OLMS filer the caller's own chapter is verified as, if any.
create function private.lm2_caller_filer()
returns table (olms_file_number integer, union_name text, affiliation text)
language sql
stable
security definer
set search_path = ''
as $function$
  select u.olms_file_number, u.name, u.affiliation
    from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    join public.chapter_union_org_bindings b on b.chapter_id = c.id and b.status = 'verified'
    join public.union_orgs u on u.id = b.union_org_id
   where p.id = (select auth.uid())
     and c.organization_id = private.current_member_organization()
   limit 1;
$function$;

-- One summary row as the client reads it, with the source records it cites.
create function private.lm2_summary_json(s private.catalog_lm2_summaries)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'yearCovered', s.year_covered,
    'formType', s.form_type,
    'rptId', s.rpt_id,
    'affAbbr', s.aff_abbr,
    'sizeBand', s.size_band,
    'periodFrom', s.period_from,
    'periodTo', s.period_to,
    'members', s.members,
    'totalReceipts', s.total_receipts,
    'totalDisbursements', s.total_disbursements,
    'totalAssets', s.total_assets,
    'totalLiabilities', s.total_liabilities,
    'netAssets', s.net_assets,
    'duesReceipts', s.dues_receipts,
    'feesReceipts', s.fees_receipts,
    'duesAndFeesReceipts', s.dues_and_fees_receipts,
    'officerDisbursementsGross', s.officer_disbursements_gross,
    'employeeDisbursementsGross', s.employee_disbursements_gross,
    'perCapitaTaxDisbursements', s.per_capita_tax_disbursements,
    'lm2Functional', s.lm2_functional,
    'receiptsPerMember', s.receipts_per_member,
    'duesAndFeesPerMember', s.dues_and_fees_per_member,
    'scheduleTotalsMissing', s.schedule_totals_missing,
    'provenance', s.provenance,
    'sourceRecords', coalesce((
      select pg_catalog.jsonb_agg(src.provenance order by src.provenance_id)
        from private.catalog_lm2_sources src
       where src.provenance_id in (select pg_catalog.jsonb_array_elements_text(s.provenance -> 'derived_from'))
    ), '[]'::jsonb)
  );
$function$;

create function public.get_my_lm2_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  filer record;
begin
  perform private.member_pin_require_full_session();
  -- Without a selected organization there is no chapter-bound filer to read.
  if private.current_member_organization() is null then
    return pg_catalog.jsonb_build_object('status', 'unbound');
  end if;
  org := private.mi1_require_selected_organization();
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into filer from private.lm2_caller_filer();
  if filer.olms_file_number is null then
    return pg_catalog.jsonb_build_object('status', 'unbound');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'filer', pg_catalog.jsonb_build_object(
      'olmsFileNumber', filer.olms_file_number, 'name', filer.union_name, 'affiliation', filer.affiliation
    ),
    'years', coalesce((
      select pg_catalog.jsonb_agg(private.lm2_summary_json(s) order by s.year_covered desc)
        from private.catalog_lm2_summaries s
       where s.olms_file_number = filer.olms_file_number
         and s.retired_release_label is null
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.get_lm2_peer_benchmark(p_year integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  filer record;
  own private.catalog_lm2_summaries;
  bench private.catalog_lm2_peer_benchmarks;
begin
  perform private.member_pin_require_full_session();
  -- Without a selected organization there is no chapter-bound filer to read.
  if private.current_member_organization() is null then
    return pg_catalog.jsonb_build_object('status', 'unbound');
  end if;
  org := private.mi1_require_selected_organization();
  if not private.has_organization_role(org, array['coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into filer from private.lm2_caller_filer();
  if filer.olms_file_number is null then
    return pg_catalog.jsonb_build_object('status', 'unbound');
  end if;
  select s.* into own
    from private.catalog_lm2_summaries s
   where s.olms_file_number = filer.olms_file_number
     and s.retired_release_label is null
     and (p_year is null or s.year_covered = p_year)
   order by s.year_covered desc
   limit 1;
  if own.olms_file_number is null then
    return pg_catalog.jsonb_build_object('status', 'no_filing');
  end if;
  select b.* into bench
    from private.catalog_lm2_peer_benchmarks b
   where b.year_covered = own.year_covered
     and b.aff_abbr = own.aff_abbr
     and b.size_band = own.size_band
     and b.retired_release_label is null;
  return pg_catalog.jsonb_build_object(
    'status', case when bench.year_covered is null then 'no_peer_group' else 'ok' end,
    'filer', pg_catalog.jsonb_build_object(
      'olmsFileNumber', filer.olms_file_number, 'name', filer.union_name, 'affiliation', filer.affiliation
    ),
    'own', private.lm2_summary_json(own),
    'benchmark', case when bench.year_covered is null then null else pg_catalog.jsonb_build_object(
      'yearCovered', bench.year_covered,
      'affAbbr', bench.aff_abbr,
      'sizeBand', bench.size_band,
      'peers', bench.peers,
      'stats', bench.stats,
      'provenance', bench.provenance,
      'sourceRecords', coalesce((
        select pg_catalog.jsonb_agg(src.provenance order by src.provenance_id)
          from private.catalog_lm2_sources src
         where src.provenance_id in (select pg_catalog.jsonb_array_elements_text(bench.provenance -> 'derived_from'))
      ), '[]'::jsonb)
    ) end
  );
end;
$function$;

revoke all on function private.lm2_caller_filer() from public, anon, authenticated, service_role;
revoke all on function private.lm2_summary_json(private.catalog_lm2_summaries) from public, anon, authenticated, service_role;
revoke all on function public.get_my_lm2_summary() from public, anon, authenticated, service_role;
revoke all on function public.get_lm2_peer_benchmark(integer) from public, anon, authenticated, service_role;
grant execute on function public.get_my_lm2_summary() to authenticated;
grant execute on function public.get_lm2_peer_benchmark(integer) to authenticated;

commit;
