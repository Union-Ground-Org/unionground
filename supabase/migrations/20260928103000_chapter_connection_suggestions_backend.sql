-- REQ-UG-CONNECTION-SUGGESTIONS-20260927 (backend persistence half).
--
-- Opt-in CHAPTER / LOCAL connection recommendations. A chapter team publishes
-- an organizational profile (public location, sector, declared issue agenda,
-- offered team expertise, organizational local/union identity); every other
-- tenant's chapter team reads the published registry through one keyset-paged
-- RPC and a matching engine (outside this migration) ranks candidates against
-- the reader's own published profile. No person is ever a suggestion.
--
-- What this migration installs:
--
--   * private.chapter_connection_profiles: one row per chapter; the editable
--     draft AND its publication state (draft / published / withdrawn), the
--     opt-in consent record (version, time, hat) and a 180-day publication
--     expiry. Only organizational metadata, declared interests and team
--     capabilities are accepted; the input parser refuses every unknown field,
--     so aggregate counts, source summaries and person names cannot be smuggled
--     in. Declared issues are stored separately from analyzed aggregates and
--     labelled by origin on the way out;
--   * private.chapter_connection_registry_epoch: one singleton counter that
--     every publication, re-publication and withdrawal increments. The registry
--     reader hands out a snapshot token bound to the epoch and refuses a token
--     whose epoch has moved, so a paged scan is all-or-nothing;
--   * private.chapter_connection_hides: reciprocal pair exclusion. A chapter
--     that hides a candidate is also hidden from that candidate;
--   * private.chapter_connection_source_tags: the reviewed-source boundary. A
--     reviewer with real read authority over an EXISTING, FINALIZED grievance
--     (public.member_cases, resolved), survey response
--     (public.organization_survey_sessions, submitted) or feedback pulse
--     (public.organization_pulse_events, responded) attaches canonical issue
--     taxonomy keys to it. The server derives the contributor identity and the
--     occurrence time from the source row; the client supplies neither. Nothing
--     here trusts a client-provided count;
--   * private.chapter_connection_aggregate_runs / _issue_aggregates: once per
--     chapter per fixed previous calendar quarter (UTC), confirmed tags are
--     aggregated: each distinct contributor counts once per topic across all
--     sources; a topic is published only with at least 25 contributors AND a
--     safe complement (at least 25 other contributors in the window, or none);
--     the result is a coarse band (some / many / most), never a count, and the
--     run is frozen: it is never recomputed for that quarter;
--   * seven authenticated RPCs (below). Every one derives the organization from
--     private.mi1_require_selected_organization (authentication, MFA, active
--     membership), validates p_selected_hat null-safely as an EXACT granted
--     role (organization grant through private.has_organization_role, or a
--     chapter-scoped grant on the target chapter through
--     private.member_has_chapter_role), and checks that the target chapter
--     belongs to the caller's organization before anything else is revealed.
--     Reads admit the five staff hats; writes admit advisor / admin / vp.
--
-- Boundaries kept: private tables FORCE row level security and carry no client
-- grant; every routine is SECURITY DEFINER with an empty search_path; grants go
-- to authenticated only; no organization, chapter or user is seeded; no
-- external AI; no raw source data leaves the tenant (the registry publishes the
-- profile projection only, and audit rows are content-free). The actor of every
-- write is the organization_audit_ledger row's actor_user_id; no new table
-- carries an auth.users column except the source-tag contributor, which is
-- reviewed in private.account_lifecycle_manifest and leaves with the account.
--
-- Hosted application: SAMPLE first, then production, in a later hosted window.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Bounded vocabularies
-- ---------------------------------------------------------------------------

create function private.chapter_connection_issue_keys()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array[
    'staffing', 'scheduling', 'pay', 'benefits', 'safety', 'discipline',
    'discrimination', 'workload', 'training', 'contract-enforcement'
  ]::text[];
$function$;

create function private.chapter_connection_sector_keys()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array[
    'healthcare', 'education', 'public-services', 'transportation', 'logistics',
    'manufacturing', 'hospitality', 'retail', 'construction', 'nonprofit', 'care', 'other'
  ]::text[];
$function$;

-- Expertise a chapter team offers is keyed by the same issue taxonomy the
-- declared agenda uses, so a peer's need on a topic can be matched against a
-- chapter's offered help on that topic. Team capabilities, never a person.
create function private.chapter_connection_expertise_keys()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select private.chapter_connection_issue_keys();
$function$;

-- A bounded key list: not null, at most p_max entries, every entry drawn from
-- the vocabulary, no null entry and no repeat.
create function private.chapter_connection_keys_valid(p_keys text[], p_allowed text[], p_max integer)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_keys is not null
    and pg_catalog.cardinality(p_keys) <= p_max
    and pg_catalog.array_position(p_keys, null) is null
    and p_keys <@ p_allowed
    and pg_catalog.cardinality(p_keys) = (
      select pg_catalog.count(distinct key) from pg_catalog.unnest(p_keys) as key
    );
$function$;

revoke all on function private.chapter_connection_issue_keys() from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_sector_keys() from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_expertise_keys() from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_keys_valid(text[], text[], integer) from public, anon, authenticated, service_role;

comment on function private.chapter_connection_issue_keys() is
  'Canonical issue taxonomy for chapter connection profiles and reviewed-source tags. Closed list; widening it is a reviewed migration.';
comment on function private.chapter_connection_sector_keys() is
  'Bounded sector vocabulary for chapter connection profiles.';
comment on function private.chapter_connection_expertise_keys() is
  'Bounded chapter-team expertise vocabulary: help a chapter team offers to peers, never a person.';

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table private.chapter_connection_registry_epoch (
  singleton boolean primary key default true check (singleton),
  epoch bigint not null default 1
    constraint chapter_connection_registry_epoch_positive check (epoch >= 1),
  changed_at timestamptz not null default pg_catalog.now()
);

alter table private.chapter_connection_registry_epoch enable row level security;
alter table private.chapter_connection_registry_epoch force row level security;
revoke all on table private.chapter_connection_registry_epoch from public, anon, authenticated, service_role;

insert into private.chapter_connection_registry_epoch (singleton) values (true)
on conflict (singleton) do nothing;

comment on table private.chapter_connection_registry_epoch is
  'Singleton counter incremented by every chapter connection publication, re-publication, withdrawal and analyzed-aggregate freeze that changes published content. list_chapter_connection_profiles binds its snapshot token to the epoch and refuses a token whose epoch has moved.';

create table private.chapter_connection_profiles (
  chapter_id text primary key
    references public.chapters(id) on update cascade on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete cascade,
  kind text not null default 'chapter'
    constraint chapter_connection_profiles_kind_check check (kind in ('chapter', 'local')),
  location_country text not null
    constraint chapter_connection_profiles_country_check check (location_country ~ '^[A-Z]{2}$'),
  location_state text
    constraint chapter_connection_profiles_state_check check (location_state ~ '^[A-Z]{2,3}$'),
  location_metro text
    constraint chapter_connection_profiles_metro_check check (
      pg_catalog.char_length(pg_catalog.btrim(location_metro)) between 2 and 80
      and location_metro !~ '[[:cntrl:]]'
      and location_metro ~ '[[:alpha:]]'
      and location_metro !~ '[[:digit:]]{5,}'
      and pg_catalog.strpos(location_metro, '@') = 0
      and pg_catalog.strpos(location_metro, '://') = 0
    ),
  sector_keys text[] not null default '{}'
    constraint chapter_connection_profiles_sector_keys_check
    check (private.chapter_connection_keys_valid(sector_keys, private.chapter_connection_sector_keys(), 5)),
  expertise_offered text[] not null default '{}'
    constraint chapter_connection_profiles_expertise_check
    check (private.chapter_connection_keys_valid(expertise_offered, private.chapter_connection_expertise_keys(), 10)),
  declared_issue_keys text[] not null default '{}'
    constraint chapter_connection_profiles_declared_issues_check
    check (private.chapter_connection_keys_valid(declared_issue_keys, private.chapter_connection_issue_keys(), 10)),
  declared_local_key text
    constraint chapter_connection_profiles_declared_local_key_check
    check (declared_local_key ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$'),
  declared_union_family_key text
    constraint chapter_connection_profiles_declared_union_family_key_check
    check (declared_union_family_key ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  share_analyzed_issues boolean not null default false,
  publication_status text not null default 'draft'
    constraint chapter_connection_profiles_publication_status_check
    check (publication_status in ('draft', 'published', 'withdrawn')),
  publication_version integer not null default 0
    constraint chapter_connection_profiles_publication_version_check check (publication_version >= 0),
  published_at timestamptz,
  expires_at timestamptz,
  withdrawn_at timestamptz,
  consent_version integer
    constraint chapter_connection_profiles_consent_version_check check (consent_version >= 1),
  consent_recorded_at timestamptz,
  consent_hat text
    constraint chapter_connection_profiles_consent_hat_check check (consent_hat in ('advisor', 'admin', 'vp')),
  profile_revision integer not null default 1
    constraint chapter_connection_profiles_profile_revision_check check (profile_revision >= 1),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint chapter_connection_profiles_publication_coherent check (
    (publication_status = 'draft'
      and published_at is null and expires_at is null)
    or (publication_status = 'published'
      and published_at is not null
      and expires_at = published_at + interval '180 days'
      and publication_version >= 1
      and consent_version is not null and consent_recorded_at is not null and consent_hat is not null)
    or (publication_status = 'withdrawn'
      and withdrawn_at is not null
      and published_at is null and expires_at is null
      and publication_version >= 1)
  )
);

create index chapter_connection_profiles_published_idx
  on private.chapter_connection_profiles (chapter_id)
  where publication_status = 'published';

create index chapter_connection_profiles_organization_idx
  on private.chapter_connection_profiles (organization_id);

alter table private.chapter_connection_profiles enable row level security;
alter table private.chapter_connection_profiles force row level security;
revoke all on table private.chapter_connection_profiles from public, anon, authenticated, service_role;

comment on table private.chapter_connection_profiles is
  'One opt-in connection profile per chapter: organizational location, bounded sector keys, declared issue agenda, offered team expertise, declared (unverified) organizational local/union keys, publication state with 180-day expiry and the consent record. No client grant; read and written only through the chapter connection RPCs. The acting staff member is on the organization_audit_ledger row.';

create table private.chapter_connection_hides (
  chapter_id text not null
    references public.chapters(id) on update cascade on delete cascade,
  hidden_chapter_id text not null
    references public.chapters(id) on update cascade on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (chapter_id, hidden_chapter_id),
  constraint chapter_connection_hides_distinct check (chapter_id <> hidden_chapter_id)
);

create index chapter_connection_hides_hidden_idx
  on private.chapter_connection_hides (hidden_chapter_id);

create index chapter_connection_hides_organization_idx
  on private.chapter_connection_hides (organization_id);

alter table private.chapter_connection_hides enable row level security;
alter table private.chapter_connection_hides force row level security;
revoke all on table private.chapter_connection_hides from public, anon, authenticated, service_role;

comment on table private.chapter_connection_hides is
  'A chapter''s decision to hide a published candidate. Exclusion is reciprocal: the registry omits a pair when either side hid the other. No client grant.';

create table private.chapter_connection_source_tags (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete cascade,
  chapter_id text not null
    references public.chapters(id) on update cascade on delete cascade,
  source_kind text not null
    constraint chapter_connection_source_tags_kind_check
    check (source_kind in ('grievance', 'survey', 'feedback')),
  case_id uuid
    references public.member_cases(id) on delete cascade,
  survey_session_id uuid
    references public.organization_survey_sessions(id) on delete cascade,
  pulse_event_id uuid
    references public.organization_pulse_events(id) on delete cascade,
  source_id uuid generated always as (coalesce(case_id, survey_session_id, pulse_event_id)) stored,
  topic_key text not null
    constraint chapter_connection_source_tags_topic_check
    check (topic_key = any (private.chapter_connection_issue_keys())),
  contributor_user_id uuid not null
    references auth.users(id) on delete cascade,
  source_occurred_at timestamptz not null,
  status text not null default 'confirmed'
    constraint chapter_connection_source_tags_status_check check (status in ('confirmed', 'removed')),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint chapter_connection_source_tags_one_source check (
    (source_kind = 'grievance' and case_id is not null and survey_session_id is null and pulse_event_id is null)
    or (source_kind = 'survey' and survey_session_id is not null and case_id is null and pulse_event_id is null)
    or (source_kind = 'feedback' and pulse_event_id is not null and case_id is null and survey_session_id is null)
  ),
  constraint chapter_connection_source_tags_source_topic_key unique (source_kind, source_id, topic_key)
);

create index chapter_connection_source_tags_window_idx
  on private.chapter_connection_source_tags (chapter_id, source_occurred_at)
  where status = 'confirmed';
create index chapter_connection_source_tags_case_idx
  on private.chapter_connection_source_tags (case_id) where case_id is not null;
create index chapter_connection_source_tags_session_idx
  on private.chapter_connection_source_tags (survey_session_id) where survey_session_id is not null;
create index chapter_connection_source_tags_pulse_idx
  on private.chapter_connection_source_tags (pulse_event_id) where pulse_event_id is not null;
create index chapter_connection_source_tags_contributor_idx
  on private.chapter_connection_source_tags (contributor_user_id);
create index chapter_connection_source_tags_organization_idx
  on private.chapter_connection_source_tags (organization_id);

alter table private.chapter_connection_source_tags enable row level security;
alter table private.chapter_connection_source_tags force row level security;
revoke all on table private.chapter_connection_source_tags from public, anon, authenticated, service_role;

comment on table private.chapter_connection_source_tags is
  'Reviewer-attached canonical issue taxonomy keys on existing finalized tenant source records (resolved grievance, submitted survey response, responded feedback pulse). The contributor identity and occurrence time are derived by the server from the source row and are tenant-private aggregation inputs only; they are never published. No client grant.';

-- Account lifecycle inventory: the contributor column hangs from auth.users.
-- A tag is a reviewer's classification of a record the member's own export
-- already covers (case, survey session, pulse event); the tag row records
-- nothing the member authored, so it is excluded from the export with a
-- reason, and it leaves with the account (ON DELETE CASCADE).
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_inventory_basis, exclusion_reason, note)
values ('private', 'chapter_connection_source_tags', 'contributor_user_id', 'cascade',
  'excluded_with_reason', 'auth_user_fk',
  'A reviewer''s taxonomy classification of a source record whose content the member''s export already carries; the tag row records nothing the member authored and is a tenant-private aggregation input.',
  'Installed action is ON DELETE CASCADE; the tag leaves with the account and with its source record.');

create table private.chapter_connection_aggregate_runs (
  chapter_id text not null
    references public.chapters(id) on update cascade on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete cascade,
  period_key text not null
    constraint chapter_connection_aggregate_runs_period_key_check check (period_key ~ '^[0-9]{4}Q[1-4]$'),
  period_starts_at timestamptz not null,
  period_ends_at timestamptz not null,
  frozen_at timestamptz not null default pg_catalog.now(),
  published_topic_count integer not null default 0
    constraint chapter_connection_aggregate_runs_topic_count_check check (published_topic_count between 0 and 10),
  primary key (chapter_id, period_key),
  constraint chapter_connection_aggregate_runs_window_order check (period_starts_at < period_ends_at)
);

alter table private.chapter_connection_aggregate_runs enable row level security;
alter table private.chapter_connection_aggregate_runs force row level security;
revoke all on table private.chapter_connection_aggregate_runs from public, anon, authenticated, service_role;

comment on table private.chapter_connection_aggregate_runs is
  'One frozen aggregation per chapter per fixed previous calendar quarter (UTC). Its existence is the freeze: the quarter is never recomputed. Carries the count of published TOPICS (at most ten), never a contributor count. No client grant.';

create table private.chapter_connection_issue_aggregates (
  chapter_id text not null,
  period_key text not null,
  topic_key text not null
    constraint chapter_connection_issue_aggregates_topic_check
    check (topic_key = any (private.chapter_connection_issue_keys())),
  band text not null
    constraint chapter_connection_issue_aggregates_band_check check (band in ('some', 'many', 'most')),
  primary key (chapter_id, period_key, topic_key),
  foreign key (chapter_id, period_key)
    references private.chapter_connection_aggregate_runs (chapter_id, period_key)
    on update cascade on delete cascade
);

alter table private.chapter_connection_issue_aggregates enable row level security;
alter table private.chapter_connection_issue_aggregates force row level security;
revoke all on table private.chapter_connection_issue_aggregates from public, anon, authenticated, service_role;

comment on table private.chapter_connection_issue_aggregates is
  'Coarse published band per qualifying topic of a frozen quarterly run: some / many / most. A topic qualifies only with at least 25 distinct contributors and a safe complement (at least 25 others in the window, or none). Never a count. No client grant.';

-- Account case-graph coordination: every table above except the epoch
-- singleton hangs from public.organizations / public.chapters (and the tag
-- table from auth.users and public.member_cases), so each joins the lock graph
-- like every other organization child. The row-key triggers name the identity
-- and case columns each table actually carries.
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_connection_profiles
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_connection_profiles
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger a00_case_graph_lock before insert or update or delete on private.chapter_connection_hides
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_connection_hides
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger a00_case_graph_lock before insert or update or delete on private.chapter_connection_source_tags
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_connection_source_tags
for each row execute function private.lock_case_graph_row_keys('{contributor_user_id}', '{case_id}');

create trigger a00_case_graph_lock before insert or update or delete on private.chapter_connection_aggregate_runs
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_connection_aggregate_runs
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger a00_case_graph_lock before insert or update or delete on private.chapter_connection_issue_aggregates
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_connection_issue_aggregates
for each row execute function private.lock_case_graph_row_keys('', '');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private'
  and table_name in (
    'chapter_connection_profiles', 'chapter_connection_hides', 'chapter_connection_source_tags',
    'chapter_connection_aggregate_runs', 'chapter_connection_issue_aggregates'
  )
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_chapter_connection_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after chapter connection suggestions';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after chapter connection suggestions';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after chapter connection suggestions';
  end if;
end;
$assert_chapter_connection_trigger_review$;

-- ---------------------------------------------------------------------------
-- 3. Private helpers (no client EXECUTE)
-- ---------------------------------------------------------------------------

-- Publication lifetime and consent text version, stated once.
create function private.chapter_connection_publication_days()
returns integer
language sql
immutable
set search_path = ''
as $function$
  select 180;
$function$;

create function private.chapter_connection_consent_version()
returns integer
language sql
immutable
set search_path = ''
as $function$
  select 1;
$function$;

-- The organization a chapter belongs to, or null for an unknown or
-- quarantined (organization-less) chapter.
create function private.chapter_connection_chapter_organization(p_chapter_id text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select c.organization_id
  from public.chapters c
  where c.id = p_chapter_id;
$function$;

-- Whether the caller holds p_selected_hat EXACTLY, either as an organization
-- grant (private.has_organization_role carries the staff MFA step-up) or as a
-- chapter-scoped grant on the target chapter (private.member_has_chapter_role),
-- and whether that hat is one this call admits. Null-safe: a null or unknown
-- hat is false, never an error.
create function private.chapter_connection_hat_allows(
  p_organization_id uuid,
  p_selected_hat text,
  p_chapter_id text,
  p_allowed_hats text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_selected_hat is null
      or p_selected_hat <> all (p_allowed_hats)
      or p_organization_id is null
      or not private.mfa_satisfied()
      then false
    when private.has_organization_role(p_organization_id, array[p_selected_hat]) then true
    when p_chapter_id is not null
      and private.chapter_connection_chapter_organization(p_chapter_id) = p_organization_id
      and private.member_has_chapter_role(p_chapter_id, array[p_selected_hat])
      then true
    else false
  end;
$function$;

create function private.chapter_connection_require_hat(
  p_organization_id uuid,
  p_selected_hat text,
  p_chapter_id text,
  p_allowed_hats text[]
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.chapter_connection_hat_allows(p_organization_id, p_selected_hat, p_chapter_id, p_allowed_hats) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
end;
$function$;

-- The target chapter must exist inside the caller's organization. Unknown,
-- quarantined and foreign chapters share one refusal.
create function private.chapter_connection_require_chapter(p_organization_id uuid, p_chapter_id text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  clean text;
begin
  clean := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  if clean is null
     or private.chapter_connection_chapter_organization(clean) is distinct from p_organization_id then
    raise exception 'chapter outside organization' using errcode = '42501';
  end if;
  return clean;
end;
$function$;

-- Organizational local / union identity for a chapter. A VERIFIED catalog
-- binding (public.chapter_union_org_bindings.status = 'verified', the existing
-- validated binding) wins: the local key is the OLMS file number in catalog
-- form and the family key is the bound organization's affiliation, normalized.
-- Otherwise the chapter's explicitly declared organizational keys are used and
-- marked 'declared' (unverified). Nothing is ever inferred, and no key names a
-- person.
create function private.chapter_connection_identity(
  p_chapter_id text,
  p_declared_local_key text,
  p_declared_union_family_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  verified record;
  family text;
begin
  select u.olms_file_number, u.affiliation into verified
  from public.chapter_union_org_bindings b
  join public.union_orgs u on u.id = b.union_org_id
  where b.chapter_id = p_chapter_id
    and b.status = 'verified';
  if found then
    family := nullif(pg_catalog.left(pg_catalog.btrim(
      pg_catalog.regexp_replace(pg_catalog.lower(coalesce(verified.affiliation, '')), '[^a-z0-9]+', '-', 'g'),
      '-'), 40), '');
    return pg_catalog.jsonb_build_object(
      'localKey', 'olms-' || verified.olms_file_number::text,
      'localKeySource', 'verified',
      'unionFamilyKey', family,
      'unionFamilyKeySource', case when family is null then null else 'verified' end
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'localKey', p_declared_local_key,
    'localKeySource', case when p_declared_local_key is null then null else 'declared' end,
    'unionFamilyKey', p_declared_union_family_key,
    'unionFamilyKeySource', case when p_declared_union_family_key is null then null else 'declared' end
  );
end;
$function$;

-- The fixed previous calendar quarter, in UTC: the only window aggregates are
-- ever computed over.
create function private.chapter_connection_previous_quarter()
returns table (period_key text, starts_at timestamptz, ends_at timestamptz)
language sql
stable
set search_path = ''
as $function$
  select
    pg_catalog.to_char(q.starts_at at time zone 'UTC', 'YYYY"Q"Q') as period_key,
    q.starts_at,
    q.ends_at
  from (
    select
      (pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'UTC') - interval '3 months') at time zone 'UTC' as starts_at,
      pg_catalog.date_trunc('quarter', pg_catalog.now() at time zone 'UTC') at time zone 'UTC' as ends_at
  ) q;
$function$;

-- Coarse band -> the strength the matching engine consumes. Declared agenda
-- items carry strength 1 and always sort ahead of analyzed bands.
create function private.chapter_connection_band_strength(p_band text)
returns numeric
language sql
immutable
set search_path = ''
as $function$
  select case p_band
    when 'some' then 0.25
    when 'many' then 0.50
    when 'most' then 0.75
    else null
  end;
$function$;

-- issuePriorities for one profile: declared keys (strength 1, origin
-- 'declared') merged with the latest frozen analyzed bands when the chapter
-- opted to share them (origin 'analyzed', band, periodKey). A key present in
-- both keeps the declared strength and carries the analyzed band.
create function private.chapter_connection_issue_priorities(p_row private.chapter_connection_profiles)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  with declared as (
    select key from pg_catalog.unnest(p_row.declared_issue_keys) as key
  ),
  analyzed as (
    select a.topic_key as key, a.band, a.period_key
    from private.chapter_connection_issue_aggregates a
    where p_row.share_analyzed_issues
      and a.chapter_id = p_row.chapter_id
      and a.period_key = (
        select pg_catalog.max(r.period_key)
        from private.chapter_connection_aggregate_runs r
        where r.chapter_id = p_row.chapter_id
      )
  ),
  merged as (
    select
      coalesce(d.key, a.key) as key,
      d.key is not null as declared,
      a.band,
      a.period_key
    from declared d
    full join analyzed a on a.key = d.key
  )
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'key', m.key,
      'strength', case when m.declared then 1.0 else private.chapter_connection_band_strength(m.band) end,
      'origin', case when m.declared then 'declared' else 'analyzed' end,
      'band', m.band,
      'periodKey', m.period_key
    ))
    order by (case when m.declared then 0 else 1 end), private.chapter_connection_band_strength(m.band) desc nulls last, m.key
  ), '[]'::jsonb)
  from merged m;
$function$;

-- The published profile projection: exactly the contract the matching engine
-- reads, plus identityProvenance so a declared (unverified) organizational key
-- is never mistaken for a verified one. No counts, no source rows, no people.
create function private.chapter_connection_profile_projection(
  p_row private.chapter_connection_profiles,
  p_display_name text
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  identity jsonb;
begin
  identity := private.chapter_connection_identity(
    p_row.chapter_id, p_row.declared_local_key, p_row.declared_union_family_key);
  return pg_catalog.jsonb_build_object(
    'id', p_row.chapter_id,
    'kind', p_row.kind,
    'displayName', p_display_name,
    'profileRevision', p_row.profile_revision,
    'publication', pg_catalog.jsonb_build_object(
      'status', p_row.publication_status,
      'version', p_row.publication_version,
      'publishedAt', p_row.published_at,
      'expiresAt', p_row.expires_at
    ),
    'location', pg_catalog.jsonb_build_object(
      'country', p_row.location_country,
      'state', p_row.location_state,
      'metro', p_row.location_metro
    ),
    'sectorKeys', pg_catalog.to_jsonb(p_row.sector_keys),
    'issuePriorities', private.chapter_connection_issue_priorities(p_row),
    'expertiseOffered', pg_catalog.to_jsonb(p_row.expertise_offered),
    'localKey', identity -> 'localKey',
    'unionFamilyKey', identity -> 'unionFamilyKey',
    'identityProvenance', pg_catalog.jsonb_build_object(
      'localKey', identity -> 'localKeySource',
      'unionFamilyKey', identity -> 'unionFamilyKeySource'
    ),
    'sourceAsOf', p_row.updated_at
  );
end;
$function$;

-- Shared response of the workspace read and every profile write.
create function private.chapter_connection_workspace(
  p_organization_id uuid,
  p_chapter_id text,
  p_can_publish boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $function$
declare
  row_data private.chapter_connection_profiles%rowtype;
  chapter_name text;
  has_row boolean;
  quarter record;
  latest_period text;
  latest_frozen_at timestamptz;
  profile jsonb;
  draft jsonb;
  analysis jsonb;
begin
  select c.name into chapter_name from public.chapters c where c.id = p_chapter_id;
  select * into row_data
  from private.chapter_connection_profiles p
  where p.chapter_id = p_chapter_id and p.organization_id = p_organization_id;
  has_row := found;

  profile := case
    when has_row
      and row_data.publication_status = 'published'
      and row_data.expires_at > pg_catalog.now()
    then private.chapter_connection_profile_projection(row_data, chapter_name)
    else null
  end;

  draft := case when has_row then pg_catalog.jsonb_build_object(
    'kind', row_data.kind,
    'location', pg_catalog.jsonb_build_object(
      'country', row_data.location_country,
      'state', row_data.location_state,
      'metro', row_data.location_metro
    ),
    'sectorKeys', pg_catalog.to_jsonb(row_data.sector_keys),
    'expertiseOffered', pg_catalog.to_jsonb(row_data.expertise_offered),
    'declaredIssueKeys', pg_catalog.to_jsonb(row_data.declared_issue_keys),
    'declaredLocalKey', row_data.declared_local_key,
    'declaredUnionFamilyKey', row_data.declared_union_family_key,
    'shareAnalyzedIssues', row_data.share_analyzed_issues,
    'profileRevision', row_data.profile_revision,
    'publication', pg_catalog.jsonb_build_object(
      'status', row_data.publication_status,
      'version', row_data.publication_version,
      'publishedAt', row_data.published_at,
      'expiresAt', row_data.expires_at,
      'withdrawnAt', row_data.withdrawn_at,
      'expired', row_data.publication_status = 'published' and row_data.expires_at <= pg_catalog.now()
    ),
    'consent', pg_catalog.jsonb_build_object(
      'version', row_data.consent_version,
      'recordedAt', row_data.consent_recorded_at,
      'hat', row_data.consent_hat
    ),
    'updatedAt', row_data.updated_at
  ) else null end;

  select * into quarter from private.chapter_connection_previous_quarter();
  select r.period_key, r.frozen_at into latest_period, latest_frozen_at
  from private.chapter_connection_aggregate_runs r
  where r.chapter_id = p_chapter_id
  order by r.period_key desc
  limit 1;
  analysis := pg_catalog.jsonb_build_object(
    'nextPeriodKey', quarter.period_key,
    'nextPeriodFrozen', exists (
      select 1 from private.chapter_connection_aggregate_runs r
      where r.chapter_id = p_chapter_id and r.period_key = quarter.period_key
    ),
    'latest', case when latest_period is null then null else pg_catalog.jsonb_build_object(
      'periodKey', latest_period,
      'frozenAt', latest_frozen_at,
      'topics', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', a.topic_key, 'band', a.band) order by a.topic_key)
        from private.chapter_connection_issue_aggregates a
        where a.chapter_id = p_chapter_id and a.period_key = latest_period
      ), '[]'::jsonb)
    ) end
  );

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'chapterId', p_chapter_id,
    'chapterName', chapter_name,
    'profile', profile,
    'draft', draft,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name) order by c.order_index, c.name, c.id)
      from public.chapters c
      where c.organization_id = p_organization_id
    ), '[]'::jsonb),
    'canPublish', coalesce(p_can_publish, false),
    'hiddenChapterIds', coalesce((
      select pg_catalog.jsonb_agg(h.hidden_chapter_id order by h.hidden_chapter_id)
      from private.chapter_connection_hides h
      where h.chapter_id = p_chapter_id
    ), '[]'::jsonb),
    'analysis', analysis,
    'taxonomy', pg_catalog.jsonb_build_object(
      'issueKeys', pg_catalog.to_jsonb(private.chapter_connection_issue_keys()),
      'sectorKeys', pg_catalog.to_jsonb(private.chapter_connection_sector_keys()),
      'expertiseKeys', pg_catalog.to_jsonb(private.chapter_connection_expertise_keys()),
      'bands', pg_catalog.jsonb_build_array('some', 'many', 'most'),
      'consentVersion', private.chapter_connection_consent_version(),
      'publicationDays', private.chapter_connection_publication_days()
    )
  );
end;
$function$;

-- Normalize one bounded key list out of the profile payload: null or absent is
-- empty; otherwise a JSON array of strings, lower-cased and trimmed, each drawn
-- from the vocabulary, no repeats, at most p_max. Anything else is refused
-- with the caller's label.
create function private.chapter_connection_normalize_keys(
  p_value jsonb,
  p_allowed text[],
  p_max integer,
  p_label text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
declare
  keys text[] := array[]::text[];
  element jsonb;
  key text;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then
    return keys;
  end if;
  if pg_catalog.jsonb_typeof(p_value) <> 'array' then
    raise exception '% invalid', p_label using errcode = '22023';
  end if;
  for element in select value from pg_catalog.jsonb_array_elements(p_value) loop
    if pg_catalog.jsonb_typeof(element) <> 'string' then
      raise exception '% invalid', p_label using errcode = '22023';
    end if;
    key := pg_catalog.lower(pg_catalog.btrim(element #>> '{}'));
    keys := pg_catalog.array_append(keys, key);
  end loop;
  if not private.chapter_connection_keys_valid(keys, p_allowed, p_max) then
    raise exception '% invalid', p_label using errcode = '22023';
  end if;
  return keys;
end;
$function$;

-- The bounded input schema of save_chapter_connection_profile. Only these
-- fields exist; every other key, every wrong type and every out-of-vocabulary
-- value is refused. Returns the normalized shape the writer stores.
create function private.chapter_connection_parse_profile(p_profile jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  field text;
  kind text;
  location jsonb;
  country text;
  state text;
  metro text;
  sector_keys text[];
  expertise text[];
  declared_issues text[];
  declared_local text;
  declared_family text;
  share_analyzed boolean;
  catalog_parent jsonb;
begin
  if p_profile is null or pg_catalog.jsonb_typeof(p_profile) <> 'object' then
    raise exception 'profile must be an object' using errcode = '22023';
  end if;
  for field in select key from pg_catalog.jsonb_object_keys(p_profile) as key loop
    if field <> all (array[
      'kind', 'location', 'sectorKeys', 'expertiseOffered', 'declaredIssueKeys',
      'declaredLocalKey', 'declaredUnionFamilyKey', 'shareAnalyzedIssues'
    ]) then
      raise exception 'unknown profile field: %', field using errcode = '22023';
    end if;
  end loop;

  kind := coalesce(nullif(pg_catalog.btrim(coalesce(p_profile ->> 'kind', '')), ''), 'chapter');
  if (p_profile ? 'kind' and pg_catalog.jsonb_typeof(p_profile -> 'kind') not in ('string', 'null'))
     or kind not in ('chapter', 'local') then
    raise exception 'profile kind invalid' using errcode = '22023';
  end if;

  location := p_profile -> 'location';
  if location is null or pg_catalog.jsonb_typeof(location) <> 'object' then
    raise exception 'profile location required' using errcode = '22023';
  end if;
  for field in select key from pg_catalog.jsonb_object_keys(location) as key loop
    if field <> all (array['country', 'state', 'metro']) then
      raise exception 'unknown location field: %', field using errcode = '22023';
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(location -> 'country') is distinct from 'string' then
    raise exception 'location country invalid' using errcode = '22023';
  end if;
  country := pg_catalog.upper(pg_catalog.btrim(location ->> 'country'));
  if country !~ '^[A-Z]{2}$' then
    raise exception 'location country invalid' using errcode = '22023';
  end if;
  if location ? 'state' and pg_catalog.jsonb_typeof(location -> 'state') not in ('string', 'null') then
    raise exception 'location state invalid' using errcode = '22023';
  end if;
  state := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(location ->> 'state', ''))), '');
  if state is not null and state !~ '^[A-Z]{2,3}$' then
    raise exception 'location state invalid' using errcode = '22023';
  end if;
  if location ? 'metro' and pg_catalog.jsonb_typeof(location -> 'metro') not in ('string', 'null') then
    raise exception 'location metro invalid' using errcode = '22023';
  end if;
  metro := nullif(pg_catalog.btrim(coalesce(location ->> 'metro', '')), '');
  if metro is not null and (
       pg_catalog.char_length(metro) not between 2 and 80
       or metro ~ '[[:cntrl:]]'
       or metro !~ '[[:alpha:]]'
       or metro ~ '[[:digit:]]{5,}'
       or pg_catalog.strpos(metro, '@') > 0
       or pg_catalog.strpos(metro, '://') > 0) then
    raise exception 'location metro invalid' using errcode = '22023';
  end if;

  sector_keys := private.chapter_connection_normalize_keys(
    p_profile -> 'sectorKeys', private.chapter_connection_sector_keys(), 5, 'sector keys');
  expertise := private.chapter_connection_normalize_keys(
    p_profile -> 'expertiseOffered', private.chapter_connection_expertise_keys(), 10, 'expertise keys');
  declared_issues := private.chapter_connection_normalize_keys(
    p_profile -> 'declaredIssueKeys', private.chapter_connection_issue_keys(), 10, 'declared issue keys');

  if p_profile ? 'declaredLocalKey' and pg_catalog.jsonb_typeof(p_profile -> 'declaredLocalKey') not in ('string', 'null') then
    raise exception 'declared local key invalid' using errcode = '22023';
  end if;
  declared_local := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_profile ->> 'declaredLocalKey', ''))), '');
  if declared_local is not null then
    if declared_local !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
      raise exception 'declared local key invalid' using errcode = '22023';
    end if;
    -- A declared local must name a catalog organization when the union catalog
    -- is installed: an organizational identity, never a free-text label.
    -- Unknown, retired and duplicate keys share one refusal.
    catalog_parent := private.organization_catalog_parent(declared_local);
    if pg_catalog.to_regclass('private.catalog_organizations') is not null
       and not coalesce((catalog_parent ->> 'active')::boolean, false) then
      raise exception 'declared local key unavailable' using errcode = '22023';
    end if;
  end if;

  if p_profile ? 'declaredUnionFamilyKey' and pg_catalog.jsonb_typeof(p_profile -> 'declaredUnionFamilyKey') not in ('string', 'null') then
    raise exception 'declared union family key invalid' using errcode = '22023';
  end if;
  declared_family := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_profile ->> 'declaredUnionFamilyKey', ''))), '');
  if declared_family is not null and declared_family !~ '^[a-z0-9][a-z0-9-]{0,39}$' then
    raise exception 'declared union family key invalid' using errcode = '22023';
  end if;

  if p_profile ? 'shareAnalyzedIssues' and pg_catalog.jsonb_typeof(p_profile -> 'shareAnalyzedIssues') not in ('boolean', 'null') then
    raise exception 'share analyzed issues must be boolean' using errcode = '22023';
  end if;
  share_analyzed := coalesce((p_profile ->> 'shareAnalyzedIssues')::boolean, false);

  return pg_catalog.jsonb_build_object(
    'kind', kind,
    'country', country,
    'state', state,
    'metro', metro,
    'sectorKeys', pg_catalog.to_jsonb(sector_keys),
    'expertiseOffered', pg_catalog.to_jsonb(expertise),
    'declaredIssueKeys', pg_catalog.to_jsonb(declared_issues),
    'declaredLocalKey', declared_local,
    'declaredUnionFamilyKey', declared_family,
    'shareAnalyzedIssues', share_analyzed
  );
end;
$function$;

-- Registry epoch bump: called by every write that changes published content.
create function private.chapter_connection_bump_epoch()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  next_epoch bigint;
begin
  update private.chapter_connection_registry_epoch
  set epoch = epoch + 1, changed_at = pg_catalog.clock_timestamp()
  where singleton
  returning epoch into next_epoch;
  if next_epoch is null then
    insert into private.chapter_connection_registry_epoch (singleton, epoch)
    values (true, 2)
    returning epoch into next_epoch;
  end if;
  return next_epoch;
end;
$function$;

-- Content-free tenant audit row for every chapter connection write. Metadata
-- is bounded to the ledger's key allowlist; it never carries a source id, a
-- topic, a person or a count of contributors.
create function private.chapter_connection_audit(
  p_organization_id uuid,
  p_chapter_id text,
  p_event_type text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'administration', p_event_type, 'update', (select auth.uid()),
    'chapter', p_chapter_id, extensions.gen_random_uuid(),
    pg_catalog.jsonb_strip_nulls(
      coalesce(p_metadata, '{}'::jsonb) || pg_catalog.jsonb_build_object('chapterId', p_chapter_id)
    )
  );
end;
$function$;

-- How many audit rows of one event type this chapter produced in 24 hours:
-- the persisted throttle every chapter connection write consults.
create function private.chapter_connection_recent_events(
  p_organization_id uuid,
  p_chapter_id text,
  p_event_type text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.count(*)::integer
  from public.organization_audit_ledger l
  where l.organization_id = p_organization_id
    and l.entity_type = 'chapter'
    and l.entity_id = p_chapter_id
    and l.event_type = p_event_type
    and l.occurred_at > pg_catalog.now() - interval '24 hours';
$function$;

revoke all on function private.chapter_connection_publication_days() from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_consent_version() from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_chapter_organization(text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_hat_allows(uuid, text, text, text[]) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_require_hat(uuid, text, text, text[]) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_require_chapter(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_identity(text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_previous_quarter() from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_band_strength(text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_issue_priorities(private.chapter_connection_profiles) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_profile_projection(private.chapter_connection_profiles, text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_workspace(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_normalize_keys(jsonb, text[], integer, text) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_parse_profile(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_bump_epoch() from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_audit(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.chapter_connection_recent_events(uuid, text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Authenticated RPCs
-- ---------------------------------------------------------------------------

-- The chapter team's workspace: the current source profile (published
-- projection or null), the editable draft, the organization's chapters, the
-- caller's publish authority, hidden candidates, the analyzed-aggregate state
-- and the vocabularies. The source chapter is the caller's selected chapter
-- unless p_chapter_id names another chapter of the same organization.
create function public.get_chapter_connection_workspace(
  p_selected_hat text,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
begin
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(
    org, coalesce(nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), ''), private.current_member_chapter()));
  perform private.chapter_connection_require_hat(
    org, p_selected_hat, chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);
  return private.chapter_connection_workspace(
    org, chapter,
    private.chapter_connection_hat_allows(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']));
end;
$function$;

-- Save the chapter's connection profile and publish it (p_publish = true) or
-- keep it unpublished (p_publish = false; a published profile is withdrawn).
-- Accepts ONLY the bounded organizational schema parsed above. Publishing
-- records the opt-in consent (version, time, hat), starts a new 180-day
-- publication and increments the publication version and the registry epoch.
create function public.save_chapter_connection_profile(
  p_selected_hat text,
  p_chapter_id text,
  p_profile jsonb,
  p_publish boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  parsed jsonb;
  existing private.chapter_connection_profiles%rowtype;
  prior_status text;
  next_status text;
  next_version integer;
  moment timestamptz;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);
  if p_publish is null then
    raise exception 'publish flag required' using errcode = '22023';
  end if;
  parsed := private.chapter_connection_parse_profile(p_profile);

  if private.chapter_connection_recent_events(org, chapter, 'chapter_connection_profile_saved') >= 30 then
    raise exception 'profile change limit' using errcode = '22023';
  end if;

  select * into existing
  from private.chapter_connection_profiles p
  where p.chapter_id = chapter
  for update;
  prior_status := case when found then existing.publication_status else 'unset' end;
  next_status := case
    when p_publish then 'published'
    when prior_status = 'published' then 'withdrawn'
    when prior_status = 'withdrawn' then 'withdrawn'
    else 'draft'
  end;
  next_version := coalesce(existing.publication_version, 0)
    + case when next_status = 'published' then 1 else 0 end;
  moment := pg_catalog.now();

  insert into private.chapter_connection_profiles as p (
    chapter_id, organization_id, kind, location_country, location_state, location_metro,
    sector_keys, expertise_offered, declared_issue_keys, declared_local_key,
    declared_union_family_key, share_analyzed_issues,
    publication_status, publication_version, published_at, expires_at, withdrawn_at,
    consent_version, consent_recorded_at, consent_hat,
    profile_revision, created_at, updated_at
  ) values (
    chapter, org, parsed ->> 'kind', parsed ->> 'country', parsed ->> 'state', parsed ->> 'metro',
    coalesce(array(select pg_catalog.jsonb_array_elements_text(parsed -> 'sectorKeys')), array[]::text[]),
    coalesce(array(select pg_catalog.jsonb_array_elements_text(parsed -> 'expertiseOffered')), array[]::text[]),
    coalesce(array(select pg_catalog.jsonb_array_elements_text(parsed -> 'declaredIssueKeys')), array[]::text[]),
    parsed ->> 'declaredLocalKey',
    parsed ->> 'declaredUnionFamilyKey',
    coalesce((parsed ->> 'shareAnalyzedIssues')::boolean, false),
    next_status, next_version,
    case when next_status = 'published' then moment end,
    case when next_status = 'published' then moment + (private.chapter_connection_publication_days() * interval '1 day') end,
    case when next_status = 'withdrawn' then moment end,
    case when next_status = 'published' then private.chapter_connection_consent_version() end,
    case when next_status = 'published' then moment end,
    case when next_status = 'published' then p_selected_hat end,
    1, moment, moment
  )
  on conflict (chapter_id) do update
    set organization_id = excluded.organization_id,
        kind = excluded.kind,
        location_country = excluded.location_country,
        location_state = excluded.location_state,
        location_metro = excluded.location_metro,
        sector_keys = excluded.sector_keys,
        expertise_offered = excluded.expertise_offered,
        declared_issue_keys = excluded.declared_issue_keys,
        declared_local_key = excluded.declared_local_key,
        declared_union_family_key = excluded.declared_union_family_key,
        share_analyzed_issues = excluded.share_analyzed_issues,
        publication_status = excluded.publication_status,
        publication_version = excluded.publication_version,
        published_at = excluded.published_at,
        expires_at = excluded.expires_at,
        withdrawn_at = case
          when excluded.publication_status = 'withdrawn' then coalesce(p.withdrawn_at, excluded.withdrawn_at)
          else null
        end,
        consent_version = case
          when excluded.publication_status = 'published' then excluded.consent_version
          else p.consent_version
        end,
        consent_recorded_at = case
          when excluded.publication_status = 'published' then excluded.consent_recorded_at
          else p.consent_recorded_at
        end,
        consent_hat = case
          when excluded.publication_status = 'published' then excluded.consent_hat
          else p.consent_hat
        end,
        profile_revision = p.profile_revision + 1,
        updated_at = excluded.updated_at;

  if prior_status = 'published' or next_status = 'published' then
    perform private.chapter_connection_bump_epoch();
  end if;

  perform private.chapter_connection_audit(org, chapter, 'chapter_connection_profile_saved',
    pg_catalog.jsonb_build_object(
      'fromStatus', prior_status,
      'toStatus', next_status,
      'version', next_version,
      'reasonCode', case
        when next_status = 'published' then 'published'
        when prior_status = 'published' then 'withdrawn'
        else 'saved'
      end
    ));

  return private.chapter_connection_workspace(org, chapter, true);
end;
$function$;

-- Immediate withdrawal of a published profile. Withdrawing an unpublished
-- profile changes nothing and writes nothing.
create function public.withdraw_chapter_connection_profile(
  p_selected_hat text,
  p_chapter_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  existing private.chapter_connection_profiles%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);

  select * into existing
  from private.chapter_connection_profiles p
  where p.chapter_id = chapter
  for update;
  if not found or existing.publication_status <> 'published' then
    return private.chapter_connection_workspace(org, chapter, true);
  end if;

  update private.chapter_connection_profiles p
  set publication_status = 'withdrawn',
      published_at = null,
      expires_at = null,
      withdrawn_at = pg_catalog.now(),
      profile_revision = p.profile_revision + 1,
      updated_at = pg_catalog.now()
  where p.chapter_id = chapter;

  perform private.chapter_connection_bump_epoch();
  perform private.chapter_connection_audit(org, chapter, 'chapter_connection_profile_saved',
    pg_catalog.jsonb_build_object(
      'fromStatus', 'published',
      'toStatus', 'withdrawn',
      'version', existing.publication_version,
      'reasonCode', 'withdrawn'
    ));

  return private.chapter_connection_workspace(org, chapter, true);
end;
$function$;

-- Hide (or unhide) one published candidate from this chapter. Only a chapter
-- that is currently a published candidate of another organization can be
-- hidden, so the write is not a chapter-id oracle; unhiding needs no target
-- check. The exclusion is reciprocal on read.
create function public.set_chapter_connection_hidden(
  p_selected_hat text,
  p_chapter_id text,
  p_target_chapter_id text,
  p_hidden boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  target text;
  changed integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);
  if p_hidden is null then
    raise exception 'hidden flag required' using errcode = '22023';
  end if;
  target := nullif(pg_catalog.btrim(coalesce(p_target_chapter_id, '')), '');
  if target is null or target = chapter then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  if private.chapter_connection_recent_events(org, chapter, 'chapter_connection_hidden_changed') >= 100 then
    raise exception 'hide change limit' using errcode = '22023';
  end if;

  if p_hidden then
    if not exists (
      select 1
      from private.chapter_connection_profiles p
      where p.chapter_id = target
        and p.organization_id <> org
        and p.publication_status = 'published'
        and p.expires_at > pg_catalog.now()
    ) then
      raise exception 'target chapter unavailable' using errcode = '22023';
    end if;
    insert into private.chapter_connection_hides (chapter_id, hidden_chapter_id, organization_id)
    values (chapter, target, org)
    on conflict (chapter_id, hidden_chapter_id) do nothing;
    get diagnostics changed = row_count;
  else
    delete from private.chapter_connection_hides h
    where h.chapter_id = chapter and h.hidden_chapter_id = target;
    get diagnostics changed = row_count;
  end if;

  perform private.chapter_connection_audit(org, chapter, 'chapter_connection_hidden_changed',
    pg_catalog.jsonb_build_object(
      'operation', case when p_hidden then 'hide' else 'unhide' end,
      'count', changed
    ));

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'targetChapterId', target,
    'hidden', p_hidden,
    'changed', changed > 0,
    'hiddenChapterIds', coalesce((
      select pg_catalog.jsonb_agg(h.hidden_chapter_id order by h.hidden_chapter_id)
      from private.chapter_connection_hides h
      where h.chapter_id = chapter
    ), '[]'::jsonb)
  );
end;
$function$;

-- The reviewed-source boundary. Replaces the set of confirmed canonical topic
-- keys on ONE existing, finalized tenant source record the caller may read:
--   grievance : public.member_cases, status 'resolved', in this organization
--               and chapter, readable through private.casework_can_read AND
--               clearing private.member_case_visible_to_caller (restriction);
--               contributor = the case member, occurred = last case update;
--   survey    : public.organization_survey_sessions, status 'submitted', in
--               this organization, on a survey of this chapter (or an
--               organization-wide survey answered by an active member of this
--               chapter), readable by organization staff (the survey review
--               gate, private.engagement_require_staff); contributor = the
--               respondent, occurred = submitted_at;
--   feedback  : public.organization_pulse_events, state 'responded', in this
--               organization, on a prompt of this chapter (or an
--               organization-wide prompt answered by an active member of this
--               chapter), readable by organization staff; contributor = the
--               responding member, occurred = responded_at.
-- Unknown, foreign, unfinalized and unreadable sources share one refusal. The
-- client never supplies a contributor, a time or a count.
create function public.set_chapter_connection_source_tags(
  p_selected_hat text,
  p_chapter_id text,
  p_source_kind text,
  p_source_id uuid,
  p_topic_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  kind text;
  topics text[];
  contributor uuid;
  occurred_at timestamptz;
  source_chapter text;
  source_status text;
  confirmed integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);

  kind := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_kind, '')));
  if kind not in ('grievance', 'survey', 'feedback') then
    raise exception 'source kind invalid' using errcode = '22023';
  end if;
  if p_source_id is null then
    raise exception 'source record unavailable' using errcode = '22023';
  end if;
  topics := coalesce(array(
    select pg_catalog.lower(pg_catalog.btrim(key))
    from pg_catalog.unnest(coalesce(p_topic_keys, array[]::text[])) as key
  ), array[]::text[]);
  if pg_catalog.array_position(coalesce(p_topic_keys, array[]::text[]), null) is not null
     or not private.chapter_connection_keys_valid(topics, private.chapter_connection_issue_keys(), 10) then
    raise exception 'topic keys invalid' using errcode = '22023';
  end if;

  if kind = 'grievance' then
    select c.user_id, c.updated_at, c.status into contributor, occurred_at, source_status
    from public.member_cases c
    where c.id = p_source_id
      and c.organization_id = org
      and c.chapter_id = chapter;
    if not found
       or source_status <> 'resolved'
       or not private.casework_can_read(p_source_id)
       or not private.member_case_visible_to_caller(p_source_id) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  elsif kind = 'survey' then
    perform private.engagement_require_staff(org);
    select s.respondent_user_id, s.submitted_at, s.status, v.chapter_id
      into contributor, occurred_at, source_status, source_chapter
    from public.organization_survey_sessions s
    join public.organization_surveys v on v.id = s.survey_id
    where s.id = p_source_id
      and s.organization_id = org;
    if not found
       or source_status <> 'submitted'
       or occurred_at is null
       or not (
         source_chapter = chapter
         or (source_chapter is null and exists (
           select 1 from public.member_chapter_memberships m
           where m.user_id = contributor and m.chapter_id = chapter and m.status = 'active'
         ))
       ) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  else
    perform private.engagement_require_staff(org);
    select e.user_id, e.responded_at, e.state, pr.chapter_id
      into contributor, occurred_at, source_status, source_chapter
    from public.organization_pulse_events e
    join public.organization_pulse_prompts pr on pr.id = e.prompt_id
    where e.id = p_source_id
      and e.organization_id = org;
    if not found
       or source_status <> 'responded'
       or occurred_at is null
       or not (
         source_chapter = chapter
         or (source_chapter is null and exists (
           select 1 from public.member_chapter_memberships m
           where m.user_id = contributor and m.chapter_id = chapter and m.status = 'active'
         ))
       ) then
      raise exception 'source record unavailable' using errcode = '22023';
    end if;
  end if;

  update private.chapter_connection_source_tags t
  set status = 'removed', updated_at = pg_catalog.now()
  where t.source_kind = kind
    and t.source_id = p_source_id
    and t.status = 'confirmed'
    and t.topic_key <> all (topics);

  insert into private.chapter_connection_source_tags as t (
    organization_id, chapter_id, source_kind, case_id, survey_session_id, pulse_event_id,
    topic_key, contributor_user_id, source_occurred_at, status
  )
  select
    org, chapter, kind,
    case when kind = 'grievance' then p_source_id end,
    case when kind = 'survey' then p_source_id end,
    case when kind = 'feedback' then p_source_id end,
    key, contributor, occurred_at, 'confirmed'
  from pg_catalog.unnest(topics) as key
  on conflict (source_kind, source_id, topic_key) do update
    set status = 'confirmed',
        chapter_id = excluded.chapter_id,
        contributor_user_id = excluded.contributor_user_id,
        source_occurred_at = excluded.source_occurred_at,
        updated_at = pg_catalog.now();

  select pg_catalog.count(*)::integer into confirmed
  from private.chapter_connection_source_tags t
  where t.source_kind = kind and t.source_id = p_source_id and t.status = 'confirmed';

  perform private.chapter_connection_audit(org, chapter, 'chapter_connection_source_tags_changed',
    pg_catalog.jsonb_build_object(
      'entityType', kind,
      'operation', 'set',
      'count', confirmed
    ));

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'sourceKind', kind,
    'sourceId', p_source_id,
    'topicKeys', pg_catalog.to_jsonb(topics),
    'occurredAt', occurred_at,
    'periodKey', pg_catalog.to_char(occurred_at at time zone 'UTC', 'YYYY"Q"Q')
  );
end;
$function$;

-- Freeze the chapter's analyzed issue aggregates for the fixed previous
-- calendar quarter. Each distinct contributor counts once per topic across
-- every source kind; a topic is published only with at least 25 contributors
-- and a safe complement (at least 25 other contributors in the window, or
-- none). Bands only, never counts. A quarter already frozen is returned as it
-- was frozen; it is never recomputed. Publishing a band changes the registry
-- content only when the chapter's profile is published and opted to share
-- analyzed issues, and only then does the epoch move.
create function public.freeze_chapter_connection_issue_aggregates(
  p_selected_hat text,
  p_chapter_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  quarter record;
  already boolean;
  topic_count integer;
  frozen_at timestamptz;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);

  select * into quarter from private.chapter_connection_previous_quarter();

  select r.frozen_at, r.published_topic_count into frozen_at, topic_count
  from private.chapter_connection_aggregate_runs r
  where r.chapter_id = chapter and r.period_key = quarter.period_key
  for update;
  already := found;

  if not already then
    frozen_at := pg_catalog.now();
    insert into private.chapter_connection_aggregate_runs
      (chapter_id, organization_id, period_key, period_starts_at, period_ends_at, frozen_at, published_topic_count)
    values (chapter, org, quarter.period_key, quarter.starts_at, quarter.ends_at, frozen_at, 0);

    insert into private.chapter_connection_issue_aggregates (chapter_id, period_key, topic_key, band)
    select
      chapter,
      quarter.period_key,
      per_topic.topic_key,
      -- Band by share of the window's contributors: at most a third, at most
      -- two thirds, or more. Integer arithmetic, so a boundary share lands on
      -- the same band the client-side preview assigns it.
      case
        when per_topic.contributors * 3 <= total.contributors then 'some'
        when per_topic.contributors * 3 <= total.contributors * 2 then 'many'
        else 'most'
      end
    from (
      select t.topic_key, pg_catalog.count(distinct t.contributor_user_id) as contributors
      from private.chapter_connection_source_tags t
      where t.chapter_id = chapter
        and t.organization_id = org
        and t.status = 'confirmed'
        and t.source_occurred_at >= quarter.starts_at
        and t.source_occurred_at < quarter.ends_at
      group by t.topic_key
    ) per_topic
    cross join (
      select pg_catalog.count(distinct t.contributor_user_id) as contributors
      from private.chapter_connection_source_tags t
      where t.chapter_id = chapter
        and t.organization_id = org
        and t.status = 'confirmed'
        and t.source_occurred_at >= quarter.starts_at
        and t.source_occurred_at < quarter.ends_at
    ) total
    where per_topic.contributors >= 25
      and (total.contributors - per_topic.contributors >= 25
           or total.contributors - per_topic.contributors = 0);
    get diagnostics topic_count = row_count;

    update private.chapter_connection_aggregate_runs r
    set published_topic_count = topic_count
    where r.chapter_id = chapter and r.period_key = quarter.period_key;

    if exists (
      select 1 from private.chapter_connection_profiles p
      where p.chapter_id = chapter
        and p.publication_status = 'published'
        and p.share_analyzed_issues
    ) then
      perform private.chapter_connection_bump_epoch();
    end if;

    perform private.chapter_connection_audit(org, chapter, 'chapter_connection_aggregates_frozen',
      pg_catalog.jsonb_build_object(
        'entityType', 'aggregate_period',
        'entityId', quarter.period_key,
        'operation', 'freeze',
        'count', topic_count
      ));
  end if;

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'periodKey', quarter.period_key,
    'periodStartsAt', quarter.starts_at,
    'periodEndsAt', quarter.ends_at,
    'frozenAt', frozen_at,
    'alreadyFrozen', already,
    'topics', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', a.topic_key, 'band', a.band) order by a.topic_key)
      from private.chapter_connection_issue_aggregates a
      where a.chapter_id = chapter and a.period_key = quarter.period_key
    ), '[]'::jsonb)
  );
end;
$function$;

-- The published registry, keyset-paged by chapter id, for the matching engine.
-- Every eligible candidate across every other organization: published, not
-- expired at the snapshot instant, in an active organization, not the
-- caller's organization, and not hidden by or hiding the caller's chapter.
-- The first call (null token) opens a snapshot bound to the current registry
-- epoch and instant; later pages must present that token, and a token whose
-- epoch moved (a publication or withdrawal happened) or that is older than an
-- hour is refused, so a scan is all-or-nothing. No first-N cap: the caller
-- pages until complete is true.
create function public.list_chapter_connection_profiles(
  p_selected_hat text,
  p_after_id text default null,
  p_limit integer default 250,
  p_snapshot_token text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  viewer_chapter text;
  cap integer;
  current_epoch bigint;
  token_epoch bigint;
  snapshot_at timestamptz;
  token text;
  after_id text;
  rows_out jsonb;
  fetched integer;
  last_id text;
begin
  org := private.mi1_require_selected_organization();
  viewer_chapter := private.chapter_connection_require_chapter(org, private.current_member_chapter());
  perform private.chapter_connection_require_hat(
    org, p_selected_hat, viewer_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  cap := least(greatest(coalesce(p_limit, 250), 1), 500);
  after_id := nullif(pg_catalog.btrim(coalesce(p_after_id, '')), '');

  select e.epoch into current_epoch from private.chapter_connection_registry_epoch e where e.singleton;
  current_epoch := coalesce(current_epoch, 1);

  if p_snapshot_token is null then
    snapshot_at := pg_catalog.now();
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
  end if;
  token := current_epoch::text || ':' || pg_catalog.floor(extract(epoch from snapshot_at))::bigint::text;

  select
    coalesce(pg_catalog.jsonb_agg(page.item order by page.chapter_id collate "C"), '[]'::jsonb),
    pg_catalog.count(*)::integer,
    pg_catalog.max(page.chapter_id collate "C")
  into rows_out, fetched, last_id
  from (
    select
      p.chapter_id,
      private.chapter_connection_profile_projection(p, c.name) as item
    from private.chapter_connection_profiles p
    join public.chapters c on c.id = p.chapter_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active'
    where p.publication_status = 'published'
      and p.expires_at > snapshot_at
      and p.organization_id <> org
      and (after_id is null or p.chapter_id collate "C" > after_id collate "C")
      and not exists (
        select 1 from private.chapter_connection_hides h
        where (h.chapter_id = viewer_chapter and h.hidden_chapter_id = p.chapter_id)
           or (h.chapter_id = p.chapter_id and h.hidden_chapter_id = viewer_chapter)
      )
    order by p.chapter_id collate "C"
    limit cap + 1
  ) page;

  if fetched > cap then
    -- Drop the look-ahead row: the page is the first cap rows in order.
    rows_out := (
      select coalesce(pg_catalog.jsonb_agg(elem.value order by elem.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(rows_out) with ordinality as elem
      where elem.ordinality <= cap
    );
    last_id := rows_out -> (cap - 1) ->> 'id';
  end if;

  return pg_catalog.jsonb_build_object(
    'snapshotToken', token,
    'snapshotAt', snapshot_at,
    'rows', rows_out,
    'nextCursor', case when fetched > cap then last_id else null end,
    'complete', fetched <= cap
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Grants: authenticated only, nothing else
-- ---------------------------------------------------------------------------

revoke all on function public.get_chapter_connection_workspace(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.save_chapter_connection_profile(text, text, jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.withdraw_chapter_connection_profile(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_chapter_connection_hidden(text, text, text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.set_chapter_connection_source_tags(text, text, text, uuid, text[])
  from public, anon, authenticated, service_role;
revoke all on function public.freeze_chapter_connection_issue_aggregates(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_chapter_connection_profiles(text, text, integer, text)
  from public, anon, authenticated, service_role;

grant execute on function public.get_chapter_connection_workspace(text, text) to authenticated;
grant execute on function public.save_chapter_connection_profile(text, text, jsonb, boolean) to authenticated;
grant execute on function public.withdraw_chapter_connection_profile(text, text) to authenticated;
grant execute on function public.set_chapter_connection_hidden(text, text, text, boolean) to authenticated;
grant execute on function public.set_chapter_connection_source_tags(text, text, text, uuid, text[]) to authenticated;
grant execute on function public.freeze_chapter_connection_issue_aggregates(text, text) to authenticated;
grant execute on function public.list_chapter_connection_profiles(text, text, integer, text) to authenticated;

comment on function public.get_chapter_connection_workspace(text, text) is
  'Staff read of the chapter connection workspace: current published profile (or null), editable draft, organization chapters, canPublish, hidden candidates, analyzed-aggregate state and vocabularies. Selected organization + MFA; exact granted hat (steward, coordinator, advisor, admin or vp); chapter must belong to the organization. Writes nothing.';
comment on function public.save_chapter_connection_profile(text, text, jsonb, boolean) is
  'Advisor/admin/vp write of a chapter connection profile from a bounded organizational schema (kind, location, sectorKeys, expertiseOffered, declaredIssueKeys, declared organizational keys, shareAnalyzedIssues); every other field is refused. p_publish records opt-in consent and a 180-day publication, increments the version and the registry epoch; false keeps it unpublished (a published profile is withdrawn). Thirty saves per chapter per 24 hours. Audited content-free.';
comment on function public.withdraw_chapter_connection_profile(text, text) is
  'Advisor/admin/vp immediate withdrawal of a published chapter connection profile; increments the registry epoch. Withdrawing an unpublished profile changes nothing.';
comment on function public.set_chapter_connection_hidden(text, text, text, boolean) is
  'Advisor/admin/vp hide or unhide of one currently published candidate chapter of another organization. Exclusion is reciprocal on read. One hundred changes per chapter per 24 hours. Audited content-free.';
comment on function public.set_chapter_connection_source_tags(text, text, text, uuid, text[]) is
  'Advisor/admin/vp reviewer boundary: replace the confirmed canonical issue tags on one existing finalized source record (resolved grievance, submitted survey response, responded feedback pulse) the caller may read. Contributor and occurrence time are derived from the source row; the client supplies neither and no count. Audited content-free.';
comment on function public.freeze_chapter_connection_issue_aggregates(text, text) is
  'Advisor/admin/vp freeze of the chapter''s analyzed issue aggregates for the fixed previous calendar quarter (UTC): distinct contributors once per topic across sources, published only with at least 25 contributors and a safe complement, as coarse bands and never counts. A frozen quarter is never recomputed.';
comment on function public.list_chapter_connection_profiles(text, text, integer, text) is
  'Staff keyset-paged read of every published, unexpired candidate profile of every other active organization, minus reciprocal hides. The snapshot token binds the scan to the registry epoch and instant; a moved epoch or an hour-old token is refused. Returns profile projections only: no counts, no source rows, no people.';

notify pgrst, 'reload schema';

commit;
