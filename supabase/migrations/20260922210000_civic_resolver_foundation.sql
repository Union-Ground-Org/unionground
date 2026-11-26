-- Civic data resolver foundation: districts, officials, member district links,
-- quarantine, the resolver run ledger and the district-change log.
--
-- Ported from civic-data-resolver migrations 001_init.sql,
-- 002_member_officials_view.sql and 003_user_district_changes.sql. The resolver
-- worker (service_role) writes every table here; members only ever read, and
-- only through the policies added in 20260922210200_civic_member_app.sql.
--
-- Host conventions applied at creation rather than in the later RLS file:
-- row-level security is enabled on every table the moment it exists, each
-- table carries the repository-wide restrictive mfa_assurance policy, and
-- every client grant is revoked. Until 20260922210200 adds the member
-- policies and SELECT grants, these tables are service_role only.
--
-- Provenance: every row carries source + source_retrieved_at + map_version.
-- Districts are never hard-deleted; redistricting sets valid_to.
--
-- user_id columns are deliberately bare uuids with no auth.users foreign key,
-- exactly as in the source (the worker may run against a separate store) and
-- as in public.member_saved_views: an auth.users reference would place these
-- tables in the implicit-FK case-graph catalogue. Account deletion is wired
-- explicitly in 20260922210600_civic_privacy_export_deletion.sql.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table public.civic_districts (
  ocd_id text primary key,
  level text not null,
  state text not null,
  name text not null,
  district_number text,
  -- federal 'cd120' = redistricting vintage; 'sld-YYYY' = year the resolver
  -- last OBSERVED the state-legislative mapping, not a redistricting signal.
  map_version text not null,
  valid_from date,
  valid_to date,
  source text not null,
  source_retrieved_at timestamptz not null
);

-- Alias absorption (Google alsoKnownAs, vendor OCD-ID variants).
create table public.civic_district_aliases (
  alias_ocd_id text primary key,
  canonical_ocd_id text not null references public.civic_districts(ocd_id)
);

-- Person-in-seat rows. A grade, a sent message and a vote belong to the
-- person (official_key), never to this row id.
create table public.civic_officials (
  id bigserial primary key,
  ocd_id text not null references public.civic_districts(ocd_id),
  office text not null,
  full_name text not null,
  party text,
  email text,
  phone text,
  contact_form_url text,
  website text,
  photo_url text,
  social jsonb,
  external_ids jsonb,
  term_end date,
  is_current boolean not null default true,
  source text not null,
  source_retrieved_at timestamptz not null,
  unique (ocd_id, office, full_name)
);

create index civic_officials_current_idx
  on public.civic_officials (ocd_id) where is_current;

-- Member to district resolution results, including the member's state
-- division row so the senator join works.
create table public.civic_user_districts (
  user_id uuid not null,
  ocd_id text not null references public.civic_districts(ocd_id),
  address_hash text not null,
  latitude double precision,
  longitude double precision,
  geocode_accuracy real,
  map_version text not null,
  resolver_source text not null,
  resolved_at timestamptz not null,
  primary key (user_id, ocd_id)
);

create index civic_user_districts_hash_idx
  on public.civic_user_districts (user_id, address_hash);

-- Quarantined addresses (PO boxes, low-accuracy geocodes): a reason, never a guess.
create table public.civic_quarantine (
  user_id uuid primary key,
  address_hash text not null,
  reason text not null,
  quarantined_at timestamptz not null
);

-- Run ledger: cost, outcome, alerting substrate and the daily credit guard.
create table public.resolver_runs (
  run_id bigserial primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  vendor text not null,
  attempted integer not null default 0,
  resolved integer not null default 0,
  failed integer not null default 0,
  quarantined integer not null default 0,
  credits_spent integer not null default 0,
  est_cost_usd numeric(8,2) not null default 0,
  status text not null,
  error_summary text
);

-- District-change log: added/removed links on every genuine re-resolve.
-- Deliberately not foreign-keyed on ocd_id: the audit trail must outlive a
-- retired district row.
create table public.civic_user_district_changes (
  id bigserial primary key,
  user_id uuid not null,
  ocd_id text not null,
  map_version text,
  change_type text not null,
  detected_at timestamptz not null
);

create index civic_user_district_changes_recent_idx
  on public.civic_user_district_changes (detected_at desc);
create index civic_user_district_changes_user_idx
  on public.civic_user_district_changes (user_id);

-- The website's integration surface: one relation, one WHERE clause.
-- Senators and statewide executives hang off the state-division row, only
-- current officials appear, and staleness is exposed (resolution_stale)
-- rather than hidden. security_invoker: the caller's own RLS applies.
create view public.civic_member_officials
with (security_invoker = on) as
select
  ud.user_id,
  d.ocd_id,
  d.level as district_level,
  d.state,
  d.name as district_name,
  d.district_number,
  d.map_version,
  d.valid_to as district_valid_to,
  o.office,
  o.full_name,
  o.party,
  o.email,
  o.phone,
  o.contact_form_url,
  o.website,
  o.photo_url,
  o.social,
  o.external_ids,
  o.term_end,
  o.source as official_source,
  ud.resolved_at,
  case o.office
    when 'U.S. Senator' then 1
    when 'U.S. Representative' then 2
    else case d.level
      when 'state_upper' then 3
      when 'state_lower' then 4
      when 'state' then 5
      when 'local' then 6
      else 7
    end
  end as level_rank,
  (ud.map_version is distinct from d.map_version) as resolution_stale
from public.civic_user_districts ud
join public.civic_districts d on d.ocd_id = ud.ocd_id
join public.civic_officials o on o.ocd_id = d.ocd_id and o.is_current;

-- Row-level security and the repository-wide MFA floor on every table.
alter table public.civic_districts enable row level security;
alter table public.civic_district_aliases enable row level security;
alter table public.civic_officials enable row level security;
alter table public.civic_user_districts enable row level security;
alter table public.civic_quarantine enable row level security;
alter table public.resolver_runs enable row level security;
alter table public.civic_user_district_changes enable row level security;

create policy mfa_assurance on public.civic_districts
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_district_aliases
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_officials
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_user_districts
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_quarantine
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.resolver_runs
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.civic_user_district_changes
as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

-- Nothing for signed-out visitors or members yet; the worker is service_role.
revoke all on public.civic_districts, public.civic_district_aliases, public.civic_officials,
  public.civic_user_districts, public.civic_quarantine, public.resolver_runs,
  public.civic_user_district_changes, public.civic_member_officials
  from public, anon, authenticated;
revoke all on sequence public.civic_officials_id_seq, public.resolver_runs_run_id_seq,
  public.civic_user_district_changes_id_seq
  from public, anon, authenticated;
grant all on public.civic_districts, public.civic_district_aliases, public.civic_officials,
  public.civic_user_districts, public.civic_quarantine, public.resolver_runs,
  public.civic_user_district_changes, public.civic_member_officials
  to service_role;
grant usage, select, update on sequence public.civic_officials_id_seq, public.resolver_runs_run_id_seq,
  public.civic_user_district_changes_id_seq
  to service_role;

comment on policy mfa_assurance on public.civic_districts is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_district_aliases is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_officials is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_user_districts is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_quarantine is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.resolver_runs is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';
comment on policy mfa_assurance on public.civic_user_district_changes is
  'Restrictive MFA floor carried by every row-level-secured public table: authenticated access to this civic table stays denied unless the session satisfies the organization assurance policy. It adds no admission of its own.';

notify pgrst, 'reload schema';

commit;
