-- SEC-UG-UNION-CATALOG-CLAIM-ANTI-TAKEOVER-20260925 / REQ-UG-UNION-CATALOG-CLAIMS-AND-VERIFICATION-20260925
--
-- Phase 3a database half: an existing organization's claim to be a union
-- catalog listing (or an organization the catalog lacks), the verification
-- ladder that decides it, and the verified state on the organization's Phase
-- 4a placement row.
--
-- Owner decisions in force (2026-09-25): D1 (the catalog stays separate: no
-- foreign key from any private.catalog_* table outward); D2a (the creator
-- decides structure in Phase 4a, so verification never creates structure);
-- D2b (a registrable email domain unique to one active catalog entry approves
-- automatically); D2c (a placement starts self-reported and shows the verified
-- mark only after a claim is verified; a wrong claim is undone by the
-- verifier); D2d-D2g (~9:35 PM ET: organizations are created openly at signup
-- by a separate change, so verification never creates an organization; any
-- rung of the ladder suffices: the domain match, the platform verifier, the
-- verified parent union's admins, or a verified sister chapter's handshake;
-- stewards and members inside the organization are a signal, not a
-- verification; an unverified organization is isolated, and
-- private.organization_is_verified() is the predicate that isolation work
-- uses; verification state and placement are public on landing pages). The
-- product owner acts as the app's verifier in a personal capacity. Adopted as
-- defaults pending owner confirmation: D3 (accepted methods, contested claims
-- and claims in an election window are held, mail-back is available), D11 (no
-- sub-unit claims) and D17 (claimant details deleted 90 days after the
-- decision).
--
-- Boundaries:
--   * four new private tables (platform_operators, catalog_claim_blocked_domains,
--     organization_claims, catalog_review_events), RLS enabled and forced, no
--     policy, no client grant;
--   * the Phase 4a table private.organization_catalog_placements is extended by
--     ALTER only: identity_catalog_key, verified_claim_id and verified_at, and a
--     widened verification_status. The verified mark is verified_at being set;
--   * claim writers are service-role RPCs that name their acting user,
--     because auth.uid() is null under the service role; every platform
--     verifier RPC also requires an active platform operator with
--     claim_verification. The one authenticated writer is the vouch of a
--     verified parent or sister organization's MFA admin;
--   * no function creates an organization, an Auth user, a membership, a
--     role grant or a chapter;
--   * undo revokes the claim, clears verified_at and detaches the placement; it
--     never deletes or suspends the organization or the account;
--   * verifier and automatic decisions reach the tenant ledger without a user
--     id; attribution stays in private.catalog_review_events, which no function
--     updates or deletes;
--   * public.chapter_union_org_bindings is neither read nor written, and its
--     tenant-issued "verified" status never feeds the verified mark;
--   * one anonymous read returns an active organization's public
--     verification state and catalog placement by slug, and no member data
--     (D2f landing pages).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------------ tables

create table private.platform_operators (
  user_id uuid not null,
  capabilities text[] not null,
  granted_note text not null,
  granted_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz,
  constraint platform_operators_pkey primary key (user_id),
  constraint platform_operators_user_id_fkey foreign key (user_id)
    references auth.users (id) on delete cascade,
  constraint platform_operators_capabilities_check
    check (pg_catalog.cardinality(capabilities) >= 1 and capabilities <@ array['claim_verification']::text[]),
  constraint platform_operators_granted_note_check
    check (pg_catalog.char_length(pg_catalog.btrim(granted_note)) between 1 and 240 and granted_note !~ '[[:cntrl:]]'),
  constraint platform_operators_revocation_ordered
    check (revoked_at is null or revoked_at >= granted_at)
);

comment on table private.platform_operators is
  'Platform operators and their capabilities. claim_verification lets a named person decide union catalog claims through the service-role verifier RPCs. No seed row; written only by public.set_platform_operator.';

alter table private.platform_operators enable row level security;
alter table private.platform_operators force row level security;
revoke all on table private.platform_operators from public, anon, authenticated, service_role;

create table private.catalog_claim_blocked_domains (
  domain text not null,
  list text not null,
  constraint catalog_claim_blocked_domains_pkey primary key (domain),
  constraint catalog_claim_blocked_domains_domain_check
    check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           and pg_catalog.char_length(domain) <= 253),
  constraint catalog_claim_blocked_domains_list_check
    check (list in ('consumer', 'hosting', 'family'))
);

comment on table private.catalog_claim_blocked_domains is
  'Email domains that never approve a claim automatically: consumer mail, hosting and social platforms, and union family national domains. Database copy of config/catalog-blocked-email-domains.json and config/catalog-family-domains.json.';

alter table private.catalog_claim_blocked_domains enable row level security;
alter table private.catalog_claim_blocked_domains force row level security;
revoke all on table private.catalog_claim_blocked_domains from public, anon, authenticated, service_role;

-- Seeded from config/catalog-blocked-email-domains.json (consumer, hosting) and
-- config/catalog-family-domains.json (every family domain); a domain in two
-- lists keeps the first of consumer, hosting, family. 102 rows.
insert into private.catalog_claim_blocked_domains (domain, list) values
  ('aim.com', 'consumer'),
  ('aol.com', 'consumer'),
  ('att.net', 'consumer'),
  ('atlanticbb.net', 'consumer'),
  ('bellsouth.net', 'consumer'),
  ('centurylink.net', 'consumer'),
  ('centurytel.net', 'consumer'),
  ('charter.net', 'consumer'),
  ('comcast.net', 'consumer'),
  ('comcastbiz.net', 'consumer'),
  ('cox-internet.com', 'consumer'),
  ('cox.net', 'consumer'),
  ('earthlink.net', 'consumer'),
  ('email.com', 'consumer'),
  ('embarqmail.com', 'consumer'),
  ('frontier.com', 'consumer'),
  ('frontiernet.net', 'consumer'),
  ('fuse.net', 'consumer'),
  ('gamail.com', 'consumer'),
  ('gmail.com', 'consumer'),
  ('gmx.com', 'consumer'),
  ('gmx.net', 'consumer'),
  ('googlemail.com', 'consumer'),
  ('hotmail.com', 'consumer'),
  ('icloud.com', 'consumer'),
  ('inbox.com', 'consumer'),
  ('juno.com', 'consumer'),
  ('live.com', 'consumer'),
  ('mac.com', 'consumer'),
  ('mail.com', 'consumer'),
  ('me.com', 'consumer'),
  ('msn.com', 'consumer'),
  ('netscape.net', 'consumer'),
  ('netzero.net', 'consumer'),
  ('optonline.net', 'consumer'),
  ('outlook.com', 'consumer'),
  ('prodigy.net', 'consumer'),
  ('proton.me', 'consumer'),
  ('protonmail.com', 'consumer'),
  ('q.com', 'consumer'),
  ('qwestoffice.net', 'consumer'),
  ('rocketmail.com', 'consumer'),
  ('roadrunner.com', 'consumer'),
  ('rr.com', 'consumer'),
  ('sbcglobal.net', 'consumer'),
  ('snet.net', 'consumer'),
  ('suddenlink.net', 'consumer'),
  ('swbell.net', 'consumer'),
  ('twc.com', 'consumer'),
  ('twcbc.com', 'consumer'),
  ('verizon.net', 'consumer'),
  ('windstream.net', 'consumer'),
  ('yahoo.com', 'consumer'),
  ('yahooo.com', 'consumer'),
  ('ymail.com', 'consumer'),
  ('zoho.com', 'consumer'),
  ('zoominternet.net', 'consumer'),
  ('blogspot.com', 'hosting'),
  ('bsky.app', 'hosting'),
  ('carrd.co', 'hosting'),
  ('facebook.com', 'hosting'),
  ('flow.page', 'hosting'),
  ('github.io', 'hosting'),
  ('godaddysites.com', 'hosting'),
  ('google.com', 'hosting'),
  ('instagram.com', 'hosting'),
  ('jimdo.com', 'hosting'),
  ('linkedin.com', 'hosting'),
  ('linktr.ee', 'hosting'),
  ('netlify.app', 'hosting'),
  ('onmicrosoft.com', 'hosting'),
  ('site123.me', 'hosting'),
  ('squarespace.com', 'hosting'),
  ('threads.net', 'hosting'),
  ('tiktok.com', 'hosting'),
  ('twitter.com', 'hosting'),
  ('unionactive.com', 'hosting'),
  ('vercel.app', 'hosting'),
  ('webflow.io', 'hosting'),
  ('weebly.com', 'hosting'),
  ('wix.com', 'hosting'),
  ('wixsite.com', 'hosting'),
  ('wordpress.com', 'hosting'),
  ('x.com', 'hosting'),
  ('yolasite.com', 'hosting'),
  ('youtube.com', 'hosting'),
  ('aflcio.org', 'family'),
  ('afscme.org', 'family'),
  ('aft.org', 'family'),
  ('alpa.org', 'family'),
  ('carpenters.org', 'family'),
  ('nflpa.com', 'family'),
  ('ibew.org', 'family'),
  ('teamster.org', 'family'),
  ('nea.org', 'family'),
  ('sagaftra.org', 'family'),
  ('seiu.org', 'family'),
  ('thesoc.org', 'family'),
  ('ttd.org', 'family'),
  ('uaw.org', 'family'),
  ('ufcw.org', 'family'),
  ('usw.org', 'family');

create table private.organization_claims (
  id uuid not null default extensions.gen_random_uuid(),
  catalog_key text,
  unlisted_name text,
  unlisted_city text,
  unlisted_state text,
  organization_id uuid,
  claimant_user_id uuid,
  claimant_name text,
  claimant_title text,
  claimant_email text,
  statement text,
  claimant_email_scope text not null,
  locale text not null,
  attestation_version text not null,
  attested_at timestamptz not null,
  confirm_token_hash text,
  confirm_expires_at timestamptz,
  email_confirmed_at timestamptz,
  status text not null default 'awaiting_email',
  hold_reason text,
  signals jsonb not null default '{}'::jsonb,
  verification_method text,
  verifier_kind text,
  vouching_organization_id uuid,
  auto_approved boolean not null default false,
  reviewed_by uuid,
  reviewed_at timestamptz,
  reason_code text,
  review_note text,
  closed_at timestamptz,
  revoked_at timestamptz,
  mailback_code_hmac text,
  mailback_issued_at timestamptz,
  mailback_expires_at timestamptz,
  mailback_attempts smallint not null default 0,
  personal_data_purged_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_claims_pkey primary key (id),
  constraint organization_claims_catalog_key_fkey foreign key (catalog_key)
    references private.catalog_organizations (catalog_key),
  constraint organization_claims_unlisted_name_check
    check (pg_catalog.char_length(pg_catalog.btrim(unlisted_name)) between 3 and 200 and unlisted_name !~ '[[:cntrl:]]'),
  constraint organization_claims_unlisted_city_check
    check (pg_catalog.char_length(unlisted_city) <= 120 and unlisted_city !~ '[[:cntrl:]]'),
  constraint organization_claims_unlisted_state_check
    check (unlisted_state ~ '^[A-Z]{2}$'),
  constraint organization_claims_one_target
    check (pg_catalog.num_nonnulls(catalog_key, unlisted_name) = 1),
  constraint organization_claims_unlisted_paired
    check (unlisted_name is not null or (unlisted_city is null and unlisted_state is null)),
  constraint organization_claims_organization_id_fkey foreign key (organization_id)
    references public.organizations (id) on update cascade on delete set null,
  constraint organization_claims_claimant_user_id_fkey foreign key (claimant_user_id)
    references auth.users (id) on delete set null,
  constraint organization_claims_claimant_name_check
    check (pg_catalog.char_length(pg_catalog.btrim(claimant_name)) between 2 and 120 and claimant_name !~ '[[:cntrl:]]'),
  constraint organization_claims_claimant_title_check
    check (pg_catalog.char_length(pg_catalog.btrim(claimant_title)) between 1 and 120 and claimant_title !~ '[[:cntrl:]]'),
  constraint organization_claims_claimant_email_check
    check (pg_catalog.char_length(claimant_email) between 3 and 254
           and claimant_email = pg_catalog.lower(claimant_email)
           and claimant_email ~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'),
  constraint organization_claims_statement_check
    check (pg_catalog.char_length(statement) <= 1000),
  constraint organization_claims_claimant_email_scope_check
    check (claimant_email_scope ~ '^[0-9a-f]{64}$'),
  constraint organization_claims_personal_data_present
    check (personal_data_purged_at is not null
           or (claimant_name is not null and claimant_title is not null and claimant_email is not null)),
  constraint organization_claims_locale_check
    check (locale in ('en', 'es')),
  constraint organization_claims_attestation_version_check
    check (attestation_version = 'claim-attest/1'),
  constraint organization_claims_confirm_token_hash_check
    check (confirm_token_hash ~ '^[0-9a-f]{64}$'),
  constraint organization_claims_status_check
    check (status in ('awaiting_email', 'under_review', 'held', 'approved', 'rejected', 'expired', 'revoked')),
  constraint organization_claims_hold_reason_check
    check (hold_reason in ('contested', 'election_period', 'awaiting_mailback', 'awaiting_callback')),
  constraint organization_claims_hold_paired
    check ((status = 'held') = (hold_reason is not null)),
  constraint organization_claims_awaiting_shape
    check (status <> 'awaiting_email' or (confirm_token_hash is not null and confirm_expires_at is not null)),
  constraint organization_claims_confirmed_shape
    check (status in ('awaiting_email', 'expired') or email_confirmed_at is not null),
  constraint organization_claims_signals_shape
    check (pg_catalog.jsonb_typeof(signals) = 'object'
           and pg_catalog.pg_column_size(signals) <= 2048
           and signals - array['domainMatch', 'domainReason', 'competingClaims', 'electionWindow',
                               'targetVerifiedElsewhere', 'officePhoneAvailable', 'stewardCount',
                               'memberCount'] = '{}'::jsonb),
  constraint organization_claims_verification_method_check
    check (verification_method in ('official_domain_email', 'published_office_callback', 'olms_address_mailback',
                                   'written_authorization', 'parent_body_confirmation', 'sibling_handshake')),
  constraint organization_claims_verifier_kind_check
    check (verifier_kind in ('domain', 'platform_operator', 'parent_organization', 'sibling_organization')),
  constraint organization_claims_verifier_method_paired
    check ((verifier_kind is distinct from 'domain' or verification_method = 'official_domain_email')
           and (verifier_kind is distinct from 'parent_organization' or verification_method = 'parent_body_confirmation')
           and ((verifier_kind = 'sibling_organization') = (verification_method is not distinct from 'sibling_handshake'))),
  constraint organization_claims_vouching_organization_id_fkey foreign key (vouching_organization_id)
    references public.organizations (id) on update cascade on delete set null,
  constraint organization_claims_reviewed_by_fkey foreign key (reviewed_by)
    references auth.users (id) on delete set null,
  constraint organization_claims_reason_code_check
    check (reason_code ~ '^[a-z_]{3,40}$'),
  constraint organization_claims_review_note_check
    check (pg_catalog.char_length(review_note) <= 500 and review_note !~ '[[:cntrl:]]'),
  constraint organization_claims_decided_shape
    check (status not in ('approved', 'rejected', 'revoked') or (reviewed_at is not null and closed_at is not null)),
  constraint organization_claims_approved_method
    check (status not in ('approved', 'revoked') or (verification_method is not null and verifier_kind is not null)),
  constraint organization_claims_auto_shape
    check (auto_approved = (verifier_kind is not distinct from 'domain')
           and (not auto_approved or catalog_key is not null)),
  constraint organization_claims_revoked_shape
    check ((status = 'revoked') = (revoked_at is not null)),
  constraint organization_claims_mailback_code_hmac_check
    check (mailback_code_hmac ~ '^[0-9a-f]{64}$'),
  constraint organization_claims_mailback_attempts_check
    check (mailback_attempts between 0 and 5)
);

create unique index organization_claims_one_open_idx
  on private.organization_claims (claimant_email_scope,
    (coalesce(catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(unlisted_name)))))
  where status in ('awaiting_email', 'under_review', 'held');
create unique index organization_claims_one_open_per_org_idx
  on private.organization_claims (organization_id)
  where status in ('awaiting_email', 'under_review', 'held');
create unique index organization_claims_confirm_token_idx
  on private.organization_claims (confirm_token_hash)
  where confirm_token_hash is not null;
create index organization_claims_catalog_key_idx
  on private.organization_claims (catalog_key, status)
  where catalog_key is not null;
create index organization_claims_organization_id_idx
  on private.organization_claims (organization_id);
create index organization_claims_claimant_user_id_idx
  on private.organization_claims (claimant_user_id);
create index organization_claims_reviewed_by_idx
  on private.organization_claims (reviewed_by);
create index organization_claims_vouching_organization_id_idx
  on private.organization_claims (vouching_organization_id);
create index organization_claims_queue_idx
  on private.organization_claims (status, created_at);
create index organization_claims_purge_idx
  on private.organization_claims (closed_at)
  where personal_data_purged_at is null;

comment on table private.organization_claims is
  'An existing organization''s claims to be a union catalog listing (or an organization the catalog lacks), their email confirmation and their verification by any rung of the ladder (domain, platform verifier, verified parent union, verified sister chapter). Claimant name, title, email, note and mail-back fields are deleted 90 days after the decision (7 days after an unconfirmed claim expires; an open claim never decided expires and is purged 90 days after submission). Service-role RPCs only.';

alter table private.organization_claims enable row level security;
alter table private.organization_claims force row level security;
revoke all on table private.organization_claims from public, anon, authenticated, service_role;

create table private.catalog_review_events (
  id uuid not null default extensions.gen_random_uuid(),
  event_type text not null,
  actor_kind text not null,
  actor_user_id uuid,
  subject_kind text not null,
  claim_id uuid,
  organization_id uuid,
  subject_user_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint catalog_review_events_pkey primary key (id),
  constraint catalog_review_events_event_type_check
    check (event_type in ('claim_submitted', 'claim_confirmed', 'claim_auto_approved', 'claim_held', 'claim_released',
                          'claim_mailback_issued', 'claim_mailback_failed', 'claim_approved', 'claim_rejected',
                          'claim_expired', 'claim_revoked', 'claim_vouched', 'placement_verified',
                          'placement_detached', 'operator_granted', 'operator_revoked')),
  constraint catalog_review_events_actor_kind_check
    check (actor_kind in ('claimant', 'organization_admin', 'verifier', 'system')),
  constraint catalog_review_events_actor_user_id_fkey foreign key (actor_user_id)
    references auth.users (id) on delete set null,
  constraint catalog_review_events_subject_kind_check
    check (subject_kind in ('claim', 'placement', 'operator')),
  constraint catalog_review_events_claim_id_fkey foreign key (claim_id)
    references private.organization_claims (id),
  constraint catalog_review_events_organization_id_fkey foreign key (organization_id)
    references public.organizations (id) on update cascade on delete set null,
  constraint catalog_review_events_subject_user_id_fkey foreign key (subject_user_id)
    references auth.users (id) on delete set null,
  constraint catalog_review_events_metadata_shape
    check (pg_catalog.jsonb_typeof(metadata) = 'object'
           and pg_catalog.pg_column_size(metadata) <= 1024
           and metadata - array['catalogKey', 'fromStatus', 'toStatus', 'method', 'holdReason', 'reasonCode',
                                'autoApproved', 'domainMatch', 'count', 'verificationStatus', 'rowDeleted',
                                'verifierKind', 'relationship'] = '{}'::jsonb),
  constraint catalog_review_events_idempotency_key unique (idempotency_key)
);

create index catalog_review_events_claim_created_idx
  on private.catalog_review_events (claim_id, created_at);
create index catalog_review_events_organization_created_idx
  on private.catalog_review_events (organization_id, created_at);
create index catalog_review_events_actor_user_id_idx
  on private.catalog_review_events (actor_user_id);
create index catalog_review_events_subject_user_id_idx
  on private.catalog_review_events (subject_user_id);

comment on table private.catalog_review_events is
  'Append-only platform history of union catalog claims, verified placements and the operator roster. Metadata carries codes and keys only, never a name, email, phone, note or unlisted text. No function updates or deletes a row.';

alter table private.catalog_review_events enable row level security;
alter table private.catalog_review_events force row level security;
revoke all on table private.catalog_review_events from public, anon, authenticated, service_role;

-- ------------------------------------------------ Phase 4a placement: verification columns

alter table private.organization_catalog_placements
  add column identity_catalog_key text,
  add column verified_claim_id uuid,
  add column verified_at timestamptz,
  add constraint organization_catalog_placements_identity_catalog_key_fkey foreign key (identity_catalog_key)
    references private.catalog_organizations (catalog_key),
  add constraint organization_catalog_placements_verified_claim_id_fkey foreign key (verified_claim_id)
    references private.organization_claims (id),
  drop constraint organization_catalog_placements_verification_status_check,
  add constraint organization_catalog_placements_verification_status_check
    check (verification_status in ('self_reported', 'verified')),
  drop constraint organization_catalog_placements_something_placed,
  add constraint organization_catalog_placements_something_placed
    check (parent_catalog_key is not null or unlisted_parent_name is not null or identity_unlisted
           or identity_catalog_key is not null),
  add constraint organization_catalog_placements_verified_shape
    check ((verification_status = 'verified') = (verified_at is not null)
           and (verified_at is not null) = (verified_claim_id is not null)),
  add constraint organization_catalog_placements_identity_verified
    check (identity_catalog_key is null or verification_status = 'verified'),
  add constraint organization_catalog_placements_identity_one
    check (not (identity_catalog_key is not null and identity_unlisted)),
  add constraint organization_catalog_placements_parent_not_self
    check (parent_catalog_key is null or identity_catalog_key is null or parent_catalog_key <> identity_catalog_key);

create unique index organization_catalog_placements_identity_catalog_key_idx
  on private.organization_catalog_placements (identity_catalog_key)
  where identity_catalog_key is not null;
create index organization_catalog_placements_verified_claim_id_idx
  on private.organization_catalog_placements (verified_claim_id)
  where verified_claim_id is not null;

comment on column private.organization_catalog_placements.identity_catalog_key is
  'The catalog listing this organization was verified as. Set only from an approved claim; a catalog identity is never self-reported, and one listing is the verified identity of at most one organization.';
comment on column private.organization_catalog_placements.verified_at is
  'The verified mark: set when a claim for this organization is approved, cleared only by the verifier''s undo.';

-- ------------------------------------------------ case-graph gates and lifecycle manifest

create trigger a00_case_graph_lock before insert or update or delete on private.platform_operators
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.platform_operators
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on private.organization_claims
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_claims
for each row execute function private.lock_case_graph_row_keys('{claimant_user_id},{reviewed_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on private.catalog_review_events
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.catalog_review_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id},{subject_user_id}', '');

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, exclusion_reason, note, reviewed_at)
values
  ('private', 'platform_operators', 'user_id', 'cascade', 'excluded_with_reason',
   null, 'auth_user_fk',
   'Platform verifier privilege registry; a capability grant is not caller-owned portable content.',
   'Installed action is ON DELETE CASCADE: a deleted account loses its operator capability with it.',
   current_date),
  ('private', 'organization_claims', 'claimant_user_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk',
   'Platform verification evidence; claimant personal fields are purged after 90 days.',
   'Installed action is ON DELETE SET NULL; the claim record outlives the requesting admin account without its personal fields.',
   current_date),
  ('private', 'organization_claims', 'reviewed_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk',
   'Platform verification evidence; claimant personal fields are purged after 90 days.',
   'Installed action is ON DELETE SET NULL; the decision outlives the verifying operator or vouching admin account.',
   current_date),
  ('private', 'catalog_review_events', 'actor_user_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk',
   'Platform verification evidence; claimant personal fields are purged after 90 days.',
   'Installed action is ON DELETE SET NULL; the append-only history outlives the acting account.',
   current_date),
  ('private', 'catalog_review_events', 'subject_user_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk',
   'Platform verification evidence; claimant personal fields are purged after 90 days.',
   'Installed action is ON DELETE SET NULL; operator roster history outlives the operator account.',
   current_date);

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private'
  and table_name in ('platform_operators', 'organization_claims', 'catalog_review_events')
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

do $assert_organization_claims_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after union catalog claims';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after union catalog claims';
  end if;
end;
$assert_organization_claims_trigger_review$;

-- ------------------------------------------------ rate limits (shared public-interest limiter)

alter table private.public_interest_submission_limits
  drop constraint public_interest_submission_limits_operation_check;

alter table private.public_interest_submission_limits
  add constraint public_interest_submission_limits_operation_check
  check (operation in (
    'network-15m',
    'email-interest-day',
    'stop-network-15m',
    'stop-email-day',
    'claim-network-hour',
    'claim-email-day',
    'claim-org-day',
    'claim-confirm-network-15m'
  ));

create or replace function private.consume_public_interest_submission_limit(
  p_scope_hash text,
  p_operation text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row private.public_interest_submission_limits%rowtype;
  moment timestamptz := clock_timestamp();
begin
  if p_scope_hash is null
     or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_operation not in (
       'network-15m',
       'email-interest-day',
       'stop-network-15m',
       'stop-email-day',
       'claim-network-hour',
       'claim-email-day',
       'claim-org-day',
       'claim-confirm-network-15m'
     )
     or p_limit < 1
     or p_window <= interval '0 seconds' then
    raise exception 'invalid public interest rate limit' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-interest-rate:' || p_operation || ':' || p_scope_hash,
      509
    )
  );

  select * into current_row
  from private.public_interest_submission_limits
  where scope_hash = p_scope_hash and operation = p_operation
  for update;

  if not found then
    insert into private.public_interest_submission_limits
      (scope_hash, operation, window_started_at, request_count)
    values (p_scope_hash, p_operation, moment, 1);
    return true;
  end if;

  if current_row.window_started_at + p_window <= moment then
    update private.public_interest_submission_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash and operation = p_operation;
    return true;
  end if;

  if current_row.request_count >= p_limit then
    return false;
  end if;

  update private.public_interest_submission_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash and operation = p_operation;
  return true;
end;
$$;

revoke all on function private.consume_public_interest_submission_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------ mail-back key (Vault)

-- A random project-local key for the mail-back code HMAC. Vault keeps it
-- encrypted; this migration records only its name. The code itself is never
-- stored or returned.
do $$
begin
  if not exists (
    select 1
    from vault.secrets
    where name = 'organization-claim-mailback-v1'
  ) then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'hex'),
      'organization-claim-mailback-v1',
      'Project-local HMAC key for union catalog claim mail-back codes.'
    );
  end if;
end;
$$;

-- ------------------------------------------------ private helpers

-- Mirrors hostOf() in scripts/union-catalog/privacy-filter.mjs: the lowercase
-- host of an http(s) URL without its scheme, credentials, port, path or a
-- leading "www.".
create function private.catalog_url_host(p_url text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select nullif(
    pg_catalog.regexp_replace(
      pg_catalog.lower(pg_catalog.substring(p_url, '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]*)')),
      '^www\.', ''),
    '')
$function$;

revoke all on function private.catalog_url_host(text) from public, anon, authenticated, service_role;

comment on function private.catalog_url_host(text) is
  'Non-executable mirror of hostOf() in scripts/union-catalog/privacy-filter.mjs.';

-- Mirrors registrableDomain() in scripts/union-catalog/privacy-filter.mjs. The
-- suffix array equals MULTI_LABEL_SUFFIXES there (an offline test compares
-- them).
create function private.catalog_registrable_domain(p_host text)
returns text
language sql
immutable
strict
set search_path = ''
as $function$
  with host as (
    select pg_catalog.regexp_replace(pg_catalog.lower(p_host), '\.$', '') as value
  ), parts as (
    select host.value,
           pg_catalog.string_to_array(host.value, '.') as labels,
           pg_catalog.cardinality(pg_catalog.string_to_array(host.value, '.')) as n
      from host
  )
  select case
    when parts.value = '' or parts.value ~ '^[0-9.]+$' or pg_catalog.strpos(parts.value, ':') > 0 then null
    when parts.n < 2 then null
    when parts.n >= 3
         and (parts.labels[parts.n - 1] || '.' || parts.labels[parts.n]) = any (array[
           'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'org.au', 'net.au', 'co.nz', 'org.nz', 'com.mx', 'co.za'
         ]::text[])
      then pg_catalog.array_to_string(parts.labels[parts.n - 2:parts.n], '.')
    when parts.n >= 3 and parts.labels[parts.n] = 'us' and pg_catalog.char_length(parts.labels[parts.n - 1]) = 2
      then pg_catalog.array_to_string(parts.labels[parts.n - 2:parts.n], '.')
    else pg_catalog.array_to_string(parts.labels[parts.n - 1:parts.n], '.')
  end
  from parts
$function$;

revoke all on function private.catalog_registrable_domain(text) from public, anon, authenticated, service_role;

comment on function private.catalog_registrable_domain(text) is
  'Non-executable mirror of registrableDomain() in scripts/union-catalog/privacy-filter.mjs (an eTLD+1 approximation without a public-suffix dependency).';

-- The automatic-approval signals for one claim. domainMatch is true only when
-- the confirmed email's registrable domain is the target listing's own website
-- domain, that domain belongs to no other active listing (through an
-- organization website, a sub-unit website or a contact website or email), the
-- mailbox is on no consumer, hosting or family domain, and the listing is an
-- official-site record researched within 18 months (a site on a subdomain of
-- a wider registrable domain matches only mail on that host). domainReason
-- names the first failing rule. stewardCount and memberCount (the requesting
-- organization's own stewards and active members) are a signal for the
-- verifier, never a verification by themselves. Nothing returned is a name or
-- an address.
create function private.catalog_claim_domain_signals(p_claim_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  claim private.organization_claims%rowtype;
  target private.catalog_organizations%rowtype;
  email_host text;
  email_domain text;
  target_host text;
  target_domain text;
  reason text;
  owners text[];
  competing integer;
  election boolean;
  verified_elsewhere boolean;
  office_phone boolean;
  steward_count integer;
  member_count integer;
begin
  select * into claim from private.organization_claims as c where c.id = p_claim_id;
  if not found then
    return null;
  end if;

  competing := 0;
  election := false;
  verified_elsewhere := false;
  office_phone := false;

  select pg_catalog.count(*)::integer into member_count
    from public.organization_memberships as m
   where m.organization_id = claim.organization_id
     and m.status = 'active';
  select pg_catalog.count(distinct g.user_id)::integer into steward_count
    from public.organization_role_grants as g
    join public.organization_memberships as m
      on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
   where g.organization_id = claim.organization_id
     and g.role = 'steward';

  if claim.catalog_key is null then
    reason := 'unlisted';
  else
    select * into target from private.catalog_organizations as o where o.catalog_key = claim.catalog_key;

    select pg_catalog.count(*)::integer into competing
      from private.organization_claims as other
     where other.catalog_key = claim.catalog_key
       and other.id <> claim.id
       and (other.status in ('under_review', 'held')
            or (other.status = 'approved' and other.organization_id is not null));
    election := target.next_election_on is not null
      and target.next_election_on between current_date - 30 and current_date + 90;
    verified_elsewhere := exists (
      select 1 from private.organization_catalog_placements as p
       where p.identity_catalog_key = claim.catalog_key
         and p.organization_id is distinct from claim.organization_id);
    office_phone := exists (
      select 1 from private.catalog_contacts as contact
       where contact.catalog_key = claim.catalog_key
         and contact.contact_kind = 'phone'
         and contact.retired_release_id is null);

    email_host := pg_catalog.lower(pg_catalog.split_part(coalesce(claim.claimant_email, ''), '@', 2));
    email_domain := private.catalog_registrable_domain(nullif(email_host, ''));

    if email_domain is null then
      reason := 'no_domain';
    elsif exists (
      select 1 from private.catalog_claim_blocked_domains as blocked
       where email_host = blocked.domain
          or pg_catalog.right(email_host, pg_catalog.char_length(blocked.domain) + 1) = '.' || blocked.domain
          or email_domain = blocked.domain
          or pg_catalog.right(email_domain, pg_catalog.char_length(blocked.domain) + 1) = '.' || blocked.domain) then
      reason := 'blocked_domain';
    elsif target.retired_release_id is not null or target.duplicate_of is not null then
      reason := 'target_inactive';
    elsif target.confidence is distinct from 'official_site'
          or target.researched_on is null
          or target.researched_on < current_date - 548 then
      reason := 'target_stale';
    else
      target_host := private.catalog_url_host(target.website);
      target_domain := private.catalog_registrable_domain(target_host);
      if target_domain is distinct from email_domain then
        reason := 'domain_mismatch';
      elsif target_host is distinct from target_domain
            and email_host is distinct from target_host
            and pg_catalog.right(email_host, pg_catalog.char_length(target_host) + 1) is distinct from '.' || target_host then
        -- The listing's site sits on a subdomain of a wider registrable domain
        -- (an employer's or a school district's): only mail on that site's own
        -- host speaks for the listing.
        reason := 'subdomain_site';
      else
        select pg_catalog.array_agg(distinct owner.catalog_key) into owners
          from (
            select o.catalog_key
              from private.catalog_organizations as o
             where o.retired_release_id is null
               and o.duplicate_of is null
               and o.website is not null
               and private.catalog_registrable_domain(private.catalog_url_host(o.website)) = email_domain
            union
            select s.catalog_key
              from private.catalog_subunits as s
              join private.catalog_organizations as o on o.catalog_key = s.catalog_key
             where s.retired_release_id is null
               and o.retired_release_id is null
               and o.duplicate_of is null
               and s.website is not null
               and private.catalog_registrable_domain(private.catalog_url_host(s.website)) = email_domain
            union
            select contact.catalog_key
              from private.catalog_contacts as contact
              join private.catalog_organizations as o on o.catalog_key = contact.catalog_key
             where contact.retired_release_id is null
               and o.retired_release_id is null
               and o.duplicate_of is null
               and contact.contact_kind in ('website', 'email')
               and private.catalog_registrable_domain(
                     case when contact.contact_kind = 'email'
                          then nullif(pg_catalog.lower(pg_catalog.split_part(contact.value, '@', 2)), '')
                          else private.catalog_url_host(contact.value) end) = email_domain
          ) as owner;
        if owners is distinct from array[claim.catalog_key] then
          reason := 'domain_shared';
        end if;
      end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'domainMatch', reason is null,
    'domainReason', reason,
    'competingClaims', competing,
    'electionWindow', election,
    'targetVerifiedElsewhere', verified_elsewhere,
    'officePhoneAvailable', office_phone,
    'stewardCount', steward_count,
    'memberCount', member_count
  );
end;
$function$;

revoke all on function private.catalog_claim_domain_signals(uuid) from public, anon, authenticated, service_role;

comment on function private.catalog_claim_domain_signals(uuid) is
  'Non-executable automatic-approval signals for one union catalog claim: domainMatch and the first failing domainReason, competing claims, election window, verified elsewhere, office phone, and the organization''s own steward and member counts (a signal, never a verification). Returns no name or address.';

-- Refuses anyone who is not an active platform operator with claim_verification.
create function private.organization_claim_require_operator(p_operator_user_id uuid, p_operator_session_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_operator_user_id is null or p_operator_session_id is null
     or exists (
       select 1 from private.member_mfa_recovery_locks as recovery
        where recovery.user_id = p_operator_user_id)
     or not exists (
       select 1 from auth.sessions as session
       left join private.member_mfa_reset_boundaries as boundary
         on boundary.user_id = session.user_id
        where session.id = p_operator_session_id
          and session.user_id = p_operator_user_id
          and session.aal = 'aal2'
          and (session.not_after is null or session.not_after > pg_catalog.now())
          and session.created_at > coalesce(boundary.invalid_before, '-infinity'::timestamptz))
     or not exists (
       select 1 from auth.mfa_factors as factor
        where factor.user_id = p_operator_user_id and factor.status = 'verified')
     or not exists (
       select 1 from auth.users as u
        where u.id = p_operator_user_id
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
     or not exists (
       select 1 from private.platform_operators as operator
        where operator.user_id = p_operator_user_id
          and operator.revoked_at is null
          and 'claim_verification' = any (operator.capabilities)) then
    raise exception 'claim verifier required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.organization_claim_require_operator(uuid, uuid) from public, anon, authenticated, service_role;

comment on function private.organization_claim_require_operator(uuid, uuid) is
  'Non-executable verifier check: raises 42501 unless the named user is an active platform operator with claim_verification whose account is neither banned nor deleted, with a live AAL2 session, a verified factor, no recovery lock and a session newer than the reset boundary.';

-- The Vault-keyed HMAC of a mail-back code, bound to its claim.
create function private.organization_claim_mailback_hmac(p_claim_id uuid, p_code text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  mailback_secret text;
begin
  select secret.decrypted_secret into mailback_secret
    from vault.decrypted_secrets as secret
   where secret.name = 'organization-claim-mailback-v1'
   limit 1;
  if coalesce(pg_catalog.char_length(mailback_secret), 0) < 32 then
    raise exception 'claim mail-back secret unavailable' using errcode = '55000';
  end if;
  return pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to('organization-claim-mailback-v1:' || p_claim_id::text || ':' || p_code, 'UTF8'),
      pg_catalog.convert_to(mailback_secret, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
end;
$function$;

revoke all on function private.organization_claim_mailback_hmac(uuid, text) from public, anon, authenticated, service_role;

comment on function private.organization_claim_mailback_hmac(uuid, text) is
  'Non-executable Vault-keyed HMAC of a union catalog claim mail-back code; the code is never stored.';

-- Moves every other open claim on a listing to held/contested (A5.3).
create function private.organization_claim_hold_contested(
  p_catalog_key text,
  p_except_claim_id uuid,
  p_actor_kind text,
  p_actor_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item record;
  moved integer;
begin
  perform private.lock_case_graph(array[p_actor_user_id], array[]::uuid[]);
  moved := 0;
  if p_catalog_key is null then
    return moved;
  end if;
  for item in
    select c.id, c.status, c.organization_id
      from private.organization_claims as c
     where c.catalog_key = p_catalog_key
       and c.id is distinct from p_except_claim_id
       and (c.status = 'under_review' or (c.status = 'held' and c.hold_reason <> 'contested'))
     order by c.id
     for update
  loop
    update private.organization_claims
       set status = 'held', hold_reason = 'contested', updated_at = pg_catalog.now()
     where id = item.id;
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_held', p_actor_kind, p_actor_user_id, 'claim', item.id, item.organization_id,
      pg_catalog.jsonb_build_object('catalogKey', p_catalog_key, 'fromStatus', item.status,
                                    'toStatus', 'held', 'holdReason', 'contested'),
      extensions.gen_random_uuid()
    );
    moved := moved + 1;
  end loop;
  return moved;
end;
$function$;

revoke all on function private.organization_claim_hold_contested(text, uuid, text, uuid)
  from public, anon, authenticated, service_role;

comment on function private.organization_claim_hold_contested(text, uuid, text, uuid) is
  'Non-executable contest rule: moves every other open claim on a catalog listing to held/contested with a claim_held event. Never touches an approved claim or a verified placement.';

-- Writes the verified state of an approved claim on the organization's
-- placement row (inserting an identity-only row when Phase 4a's
-- card never created one), leaving 4a's parent columns untouched.
create function private.organization_claim_verify_placement(
  p_claim_id uuid,
  p_actor_kind text,
  p_actor_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  claim private.organization_claims%rowtype;
  prior_status text;
begin
  perform private.lock_case_graph(array[p_actor_user_id], array[]::uuid[]);
  select * into claim from private.organization_claims as c where c.id = p_claim_id;
  if not found or claim.status <> 'approved' or claim.organization_id is null then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;

  select p.verification_status into prior_status
    from private.organization_catalog_placements as p
   where p.organization_id = claim.organization_id
   for update;
  if prior_status = 'verified' then
    raise exception 'organization already verified' using errcode = '23505';
  end if;
  if claim.catalog_key is not null and exists (
    select 1 from private.organization_catalog_placements as p
     where p.identity_catalog_key = claim.catalog_key) then
    raise exception 'catalog identity already verified' using errcode = '23505';
  end if;
  if claim.catalog_key is not null and exists (
    select 1 from private.organization_catalog_placements as p
     where p.organization_id = claim.organization_id
       and p.parent_catalog_key = claim.catalog_key) then
    raise exception 'placement parent is the claimed listing' using errcode = '22023';
  end if;

  insert into private.organization_catalog_placements as p (
    organization_id, identity_catalog_key, identity_unlisted, verification_status,
    verified_claim_id, verified_at, updated_at
  ) values (
    claim.organization_id, claim.catalog_key, claim.catalog_key is null, 'verified',
    claim.id, pg_catalog.now(), pg_catalog.now()
  )
  on conflict (organization_id) do update
    set identity_catalog_key = excluded.identity_catalog_key,
        identity_unlisted = excluded.identity_unlisted,
        verification_status = 'verified',
        verified_claim_id = excluded.verified_claim_id,
        verified_at = excluded.verified_at,
        updated_at = pg_catalog.now();

  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
  ) values (
    'placement_verified', p_actor_kind, p_actor_user_id, 'placement', claim.id, claim.organization_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'catalogKey', claim.catalog_key,
      'fromStatus', coalesce(prior_status, 'unset'),
      'toStatus', 'verified',
      'verificationStatus', 'verified',
      'verifierKind', claim.verifier_kind)),
    extensions.gen_random_uuid()
  );

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    claim.organization_id, 'administration', 'organization_catalog_placement_verified', 'update',
    null, 'organization', claim.organization_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'organizationId', claim.organization_id,
      'entityType', 'catalog_organization',
      'entityId', coalesce(claim.catalog_key, 'unlisted'),
      'fromStatus', coalesce(prior_status, 'unset'),
      'toStatus', 'verified',
      'reasonCode', claim.verifier_kind
    )
  );
end;
$function$;

revoke all on function private.organization_claim_verify_placement(uuid, text, uuid)
  from public, anon, authenticated, service_role;

comment on function private.organization_claim_verify_placement(uuid, text, uuid) is
  'Non-executable writer of the verified placement state for an approved claim. Sets identity_catalog_key (or identity_unlisted), verified_claim_id and verified_at; never changes the self-reported parent. The tenant ledger row carries no user id.';

-- The verifier-facing state of one claim, shared by the verifier RPCs and
-- their idempotent replays.
create function private.organization_claim_review_result(p_claim_id uuid, p_idempotent boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  claim private.organization_claims%rowtype;
begin
  select * into claim from private.organization_claims as c where c.id = p_claim_id;
  if not found then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'claimId', claim.id,
    'status', claim.status,
    'holdReason', claim.hold_reason,
    'next', case when claim.status = 'approved' then 'notify_approved' end,
    'email', claim.claimant_email,
    'locale', claim.locale,
    'idempotent', p_idempotent
  );
end;
$function$;

revoke all on function private.organization_claim_review_result(uuid, boolean)
  from public, anon, authenticated, service_role;

comment on function private.organization_claim_review_result(uuid, boolean) is
  'Non-executable projection of a claim for the verifier RPCs: status, hold reason, the next step, and the email and locale the decision notice goes to.';

-- The isolation predicate (D2e). True exactly when the organization's
-- placement carries the verified mark. Later RLS and read-scope work (sister
-- chapters, the parent body, other tenants' members) keys on this one
-- function; this migration rewrites no existing policy. Executable by
-- authenticated like private.has_organization_role, so a policy expression
-- can call it.
create function private.organization_is_verified(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from private.organization_catalog_placements as p
      join public.organizations as o on o.id = p.organization_id
     where p.organization_id = p_organization_id
       and p.verified_at is not null
       and o.status = 'active')
$function$;

revoke all on function private.organization_is_verified(uuid) from public, anon, authenticated, service_role;
grant execute on function private.organization_is_verified(uuid) to authenticated;

comment on function private.organization_is_verified(uuid) is
  'Isolation predicate: true exactly when the organization is active and its placement has verified_at set. An unverified organization must not see sister chapters, its parent body or any other organization''s members; later RLS work uses this predicate. Changes no policy by itself.';

-- How a verified organization (catalog identity p_voucher_key) relates to a
-- claim. 'parent': p_voucher_key is an olms_parent or parent_body parent of
-- the claimed listing in the public record. For an unlisted claim (no
-- listing, so no edge) the claiming organization's self-reported parent
-- stands in, but only when p_voucher_key is itself a public-record parent
-- body (the parent of some listing through such an edge): a local cannot
-- vouch as anyone's parent. A listed claim never uses the self-reported
-- parent: anyone can type one. 'sibling': a listed claim and the voucher share
-- a parent_body parent (the same intermediate body; an olms_parent is usually
-- the whole national, which is not a sister relationship); an unlisted claim
-- has no public-record parent and so no sister. Regional, state and federation
-- bodies never count. Otherwise null.
--
-- The exporter resolves parent_body labels only against an exact, unique
-- catalog-name match. The sister rung uses those retained parent keys;
-- unresolved label-only edges cannot establish a vouching relationship.
create function private.organization_claim_vouch_relationship(p_claim_id uuid, p_voucher_key text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  claim private.organization_claims%rowtype;
  claim_parents text[];
  claim_sibling_parents text[];
  voucher_parents text[];
begin
  select * into claim from private.organization_claims as c where c.id = p_claim_id;
  if not found or p_voucher_key is null or claim.catalog_key is not distinct from p_voucher_key then
    return null;
  end if;

  if claim.catalog_key is not null then
    select coalesce(pg_catalog.array_agg(distinct e.parent_key), array[]::text[]),
           coalesce(pg_catalog.array_agg(distinct e.parent_key) filter (where e.edge_kind = 'parent_body'), array[]::text[])
      into claim_parents, claim_sibling_parents
      from private.catalog_edges as e
     where e.child_key = claim.catalog_key
       and e.parent_key is not null
       and e.retired_release_id is null
       and e.edge_kind in ('olms_parent', 'parent_body');
  else
    select coalesce(pg_catalog.array_agg(p.parent_catalog_key), array[]::text[]) into claim_parents
      from private.organization_catalog_placements as p
     where p.organization_id = claim.organization_id
       and p.parent_catalog_key is not null
       and exists (
         select 1 from private.catalog_edges as e
          where e.parent_key = p.parent_catalog_key
            and e.retired_release_id is null
            and e.edge_kind in ('olms_parent', 'parent_body'));
    claim_sibling_parents := array[]::text[];
  end if;

  if p_voucher_key = any (claim_parents) then
    return 'parent';
  end if;

  select coalesce(pg_catalog.array_agg(distinct e.parent_key), array[]::text[]) into voucher_parents
    from private.catalog_edges as e
   where e.child_key = p_voucher_key
     and e.parent_key is not null
     and e.retired_release_id is null
     and e.edge_kind = 'parent_body';

  if claim_sibling_parents && voucher_parents then
    return 'sibling';
  end if;
  return null;
end;
$function$;

revoke all on function private.organization_claim_vouch_relationship(uuid, text)
  from public, anon, authenticated, service_role;

comment on function private.organization_claim_vouch_relationship(uuid, text) is
  'Non-executable ladder relationship between a verified organization''s catalog identity and a claim: parent (public-record olms_parent or parent_body edge; for an unlisted claim, its self-reported parent when that is a public-record parent body) or sibling (a listed claim sharing a public-record parent_body parent).';

-- ------------------------------------------------ submit and confirm

create function public.submit_organization_claim(
  p_scope_hash text,
  p_email_scope_hash text,
  p_catalog_key text,
  p_unlisted jsonb,
  p_claimant jsonb,
  p_attestation jsonb,
  p_locale text,
  p_confirm_token_hash text,
  p_requesting_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  moment timestamptz;
  clean_claimant_name text;
  clean_claimant_title text;
  clean_claimant_email text;
  clean_claimant_statement text;
  clean_unlisted_name text;
  clean_unlisted_city text;
  clean_unlisted_state text;
  allowed boolean;
  target_normalized text;
  new_claim_id uuid;
begin
  perform private.lock_case_graph(array[p_requesting_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  moment := clock_timestamp();

  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_confirm_token_hash is null or p_confirm_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid confirmation token' using errcode = '22023';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  if p_attestation is null or p_attestation is distinct from
       '{"version":"claim-attest/1","officer":true,"verifyFirst":true,"noPersonalData":true,"notEmployer":true}'::jsonb then
    raise exception 'attestation required' using errcode = '22023';
  end if;

  -- Exactly one target: a catalog key, or an unlisted organization.
  if pg_catalog.num_nonnulls(p_catalog_key, p_unlisted) <> 1 then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_catalog_key is not null and p_catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_unlisted is not null then
    if pg_catalog.jsonb_typeof(p_unlisted) is distinct from 'object'
       or p_unlisted - array['name', 'city', 'state'] <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(p_unlisted -> 'name') is distinct from 'string'
       or (p_unlisted ? 'city' and pg_catalog.jsonb_typeof(p_unlisted -> 'city') not in ('string', 'null'))
       or (p_unlisted ? 'state' and pg_catalog.jsonb_typeof(p_unlisted -> 'state') not in ('string', 'null')) then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
    clean_unlisted_name := pg_catalog.btrim(p_unlisted ->> 'name');
    clean_unlisted_city := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'city', '')), '');
    clean_unlisted_state := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'state', '')), '');
    -- The unlisted name is shown to a vouching organization's admins, so it
    -- gets 4a's placement-name filter: no email, link or phone number.
    if pg_catalog.char_length(clean_unlisted_name) not between 3 and 200
       or clean_unlisted_name ~ '[[:cntrl:]]'
       or clean_unlisted_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(clean_unlisted_name, '@') > 0
       or pg_catalog.strpos(clean_unlisted_name, '://') > 0
       or pg_catalog.regexp_replace(clean_unlisted_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'
       or (clean_unlisted_city is not null and (pg_catalog.char_length(clean_unlisted_city) > 120 or clean_unlisted_city ~ '[[:cntrl:]]'
           or pg_catalog.strpos(clean_unlisted_city, '@') > 0
           or pg_catalog.strpos(clean_unlisted_city, '://') > 0
           or pg_catalog.regexp_replace(clean_unlisted_city, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'))
       or (clean_unlisted_state is not null and clean_unlisted_state !~ '^[A-Z]{2}$') then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
  end if;

  -- The claimant: exactly name, title, email and statement, all strings.
  if pg_catalog.jsonb_typeof(p_claimant) is distinct from 'object'
     or (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_claimant) as k)
          is distinct from array['email', 'name', 'statement', 'title']
     or pg_catalog.jsonb_typeof(p_claimant -> 'name') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'title') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'email') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'statement') <> 'string' then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;
  clean_claimant_name := pg_catalog.btrim(p_claimant ->> 'name');
  clean_claimant_title := pg_catalog.btrim(p_claimant ->> 'title');
  clean_claimant_email := pg_catalog.btrim(p_claimant ->> 'email');
  clean_claimant_statement := nullif(pg_catalog.btrim(p_claimant ->> 'statement'), '');
  if pg_catalog.char_length(clean_claimant_name) not between 2 and 120 or clean_claimant_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_title) not between 1 and 120 or clean_claimant_title ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_email) not between 3 and 254
     or clean_claimant_email <> pg_catalog.lower(clean_claimant_email)
     or clean_claimant_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
     or pg_catalog.char_length(coalesce(clean_claimant_statement, '')) > 1000 then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;

  -- The requesting admin of an existing organization (organizations are
  -- created at signup, never by a claim).
  if p_requesting_user_id is null or p_organization_id is null then
    raise exception 'claim requester invalid' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.organizations as o
        where o.id = p_organization_id and o.status = 'active')
     or not exists (
       select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id
          and m.user_id = p_requesting_user_id
          and m.status = 'active')
     or not exists (
       select 1 from public.organization_role_grants as g
        where g.organization_id = p_organization_id
          and g.user_id = p_requesting_user_id
          and g.role = 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Limits, then silent refusals. Every refusal answers exactly like success.
  allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'claim-network-hour', 5, interval '1 hour');
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'claim-email-day', 3, interval '1 day');
  end if;
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      pg_catalog.encode(extensions.digest('organization-claim-org:' || p_organization_id::text, 'sha256'), 'hex'),
      'claim-org-day', 3, interval '1 day');
  end if;

  if allowed then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(p_catalog_key, 'unlisted'), 509));
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || p_organization_id::text, 509));

    target_normalized := coalesce(p_catalog_key, 'unlisted:' || pg_catalog.lower(clean_unlisted_name));

    -- A claim whose confirmation deadline has passed is lapsed even before the
    -- daily sweep runs: expire it here, exactly as the sweep would, so it never
    -- blocks this organization or this listing.
    with lapsed as (
      update private.organization_claims as c
         set status = 'expired',
             confirm_token_hash = null,
             closed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where c.status = 'awaiting_email'
         and c.confirm_expires_at <= pg_catalog.now()
         and (c.organization_id = p_organization_id
              or coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized)
      returning c.id, c.organization_id, c.catalog_key
    )
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    )
    select 'claim_expired', 'system', null, 'claim', lapsed.id, lapsed.organization_id,
           pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
             'catalogKey', lapsed.catalog_key, 'fromStatus', 'awaiting_email', 'toStatus', 'expired')),
           extensions.gen_random_uuid()
      from lapsed;

    if p_catalog_key is not null and not exists (
         select 1 from private.catalog_organizations as o
          where o.catalog_key = p_catalog_key
            and o.retired_release_id is null
            and o.duplicate_of is null) then
      allowed := false;
    elsif (select pg_catalog.count(*)
             from private.organization_claims as c
            where coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
              and c.status in ('awaiting_email', 'under_review', 'held')) >= 20 then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.claimant_email_scope = p_email_scope_hash
            and coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.organization_id = p_organization_id
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif private.organization_is_verified(p_organization_id) then
      allowed := false;
    elsif exists (
         select 1 from private.public_interest_suppressions as suppression
          where suppression.suppression_scope_hash = private.public_interest_suppression_scope(clean_claimant_email)) then
      allowed := false;
    end if;
  end if;

  if allowed then
    insert into private.organization_claims (
      catalog_key, unlisted_name, unlisted_city, unlisted_state,
      organization_id, claimant_user_id,
      claimant_name, claimant_title, claimant_email, statement, claimant_email_scope,
      locale, attestation_version, attested_at, confirm_token_hash, confirm_expires_at, status
    ) values (
      p_catalog_key, clean_unlisted_name, clean_unlisted_city, clean_unlisted_state,
      p_organization_id, p_requesting_user_id,
      clean_claimant_name, clean_claimant_title, clean_claimant_email, clean_claimant_statement, p_email_scope_hash,
      p_locale, 'claim-attest/1', pg_catalog.now(), p_confirm_token_hash, pg_catalog.now() + interval '24 hours',
      'awaiting_email'
    )
    returning id into new_claim_id;

    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_submitted', 'organization_admin',
      p_requesting_user_id, 'claim', new_claim_id, p_organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', p_catalog_key, 'toStatus', 'awaiting_email')),
      extensions.gen_random_uuid()
    );

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      p_organization_id, 'administration', 'organization_catalog_verification_requested', 'create',
      p_requesting_user_id, 'organization', p_organization_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', p_organization_id,
        'entityType', 'catalog_organization',
        'entityId', coalesce(p_catalog_key, 'unlisted'),
        'toStatus', 'awaiting_email'
      )
    );
  end if;

  delete from private.public_interest_submission_limits as stale
  where stale.ctid in (
    select candidate.ctid
    from private.public_interest_submission_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  );

  return pg_catalog.jsonb_build_object('accepted', true, 'deliver', allowed);
end;
$function$;

create function public.confirm_organization_claim(
  p_token_hash text,
  p_scope_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  found_id uuid;
  found_key text;
  found_org uuid;
  claim private.organization_claims%rowtype;
  claim_signals jsonb;
  contested boolean;
  approve boolean;
  next_step text;
  outcome_status text;
  outcome_hold text;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid confirmation' using errcode = '22023';
  end if;

  if not private.consume_public_interest_submission_limit(
       p_scope_hash, 'claim-confirm-network-15m', 20, interval '15 minutes') then
    return pg_catalog.jsonb_build_object('accepted', true, 'next', null);
  end if;

  select c.id, c.catalog_key, c.organization_id into found_id, found_key, found_org
    from private.organization_claims as c
   where c.confirm_token_hash = p_token_hash;
  if not found then
    return pg_catalog.jsonb_build_object('accepted', true, 'next', null);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(found_key, 'unlisted'), 509));
  if found_org is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || found_org::text, 509));
  end if;

  select * into claim from private.organization_claims as c where c.id = found_id for update;
  if not found
     or claim.status <> 'awaiting_email'
     or claim.confirm_token_hash is distinct from p_token_hash
     or claim.confirm_expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('accepted', true, 'next', null);
  end if;

  update private.organization_claims
     set confirm_token_hash = null,
         email_confirmed_at = pg_catalog.now(),
         status = 'under_review',
         updated_at = pg_catalog.now()
   where id = claim.id;

  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
  ) values (
    'claim_confirmed', 'organization_admin', claim.claimant_user_id, 'claim', claim.id, claim.organization_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'catalogKey', claim.catalog_key, 'fromStatus', 'awaiting_email', 'toStatus', 'under_review')),
    extensions.gen_random_uuid()
  );

  claim_signals := private.catalog_claim_domain_signals(claim.id);

  contested := claim.catalog_key is not null and (
    exists (
      select 1 from private.organization_claims as other
       where other.catalog_key = claim.catalog_key
         and other.id <> claim.id
         and (other.status in ('under_review', 'held')
              or (other.status = 'approved' and other.organization_id is not null)))
    or exists (
      select 1 from private.organization_catalog_placements as p
       where p.identity_catalog_key = claim.catalog_key));

  approve := not contested
    and coalesce((claim_signals ->> 'domainMatch')::boolean, false)
    and not coalesce((claim_signals ->> 'electionWindow')::boolean, false)
    and not coalesce((claim_signals ->> 'targetVerifiedElsewhere')::boolean, false)
    and claim.organization_id is not null
    and exists (
      select 1 from public.organizations as o
       where o.id = claim.organization_id and o.status = 'active')
    and not exists (
      select 1 from private.organization_catalog_placements as p
       where p.organization_id = claim.organization_id
         and p.verified_at is not null)
    and not exists (
      select 1 from private.organization_catalog_placements as p
       where p.organization_id = claim.organization_id
         and p.parent_catalog_key = claim.catalog_key);

  if contested then
    outcome_status := 'held';
    outcome_hold := 'contested';
  elsif approve then
    outcome_status := 'approved';
  elsif coalesce((claim_signals ->> 'electionWindow')::boolean, false) then
    outcome_status := 'held';
    outcome_hold := 'election_period';
  else
    outcome_status := 'under_review';
  end if;

  if outcome_status = 'approved' then
    update private.organization_claims
       set status = 'approved',
           auto_approved = true,
           verification_method = 'official_domain_email',
           verifier_kind = 'domain',
           reviewed_by = null,
           reviewed_at = pg_catalog.now(),
           closed_at = pg_catalog.now(),
           signals = claim_signals,
           updated_at = pg_catalog.now()
     where id = claim.id;
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_auto_approved', 'system', null, 'claim', claim.id, claim.organization_id,
      pg_catalog.jsonb_build_object(
        'catalogKey', claim.catalog_key, 'fromStatus', 'under_review', 'toStatus', 'approved',
        'method', 'official_domain_email', 'autoApproved', true, 'domainMatch', true,
        'verifierKind', 'domain'),
      extensions.gen_random_uuid()
    );
    perform private.organization_claim_verify_placement(claim.id, 'system', null);
    next_step := 'notify_approved';
  else
    update private.organization_claims
       set status = outcome_status,
           hold_reason = outcome_hold,
           signals = claim_signals,
           updated_at = pg_catalog.now()
     where id = claim.id;
    if outcome_status = 'held' then
      insert into private.catalog_review_events (
        event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
      ) values (
        'claim_held', 'system', null, 'claim', claim.id, claim.organization_id,
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'catalogKey', claim.catalog_key, 'fromStatus', 'under_review', 'toStatus', 'held',
          'holdReason', outcome_hold,
          'domainMatch', coalesce((claim_signals ->> 'domainMatch')::boolean, false))),
        extensions.gen_random_uuid()
      );
    end if;
  end if;

  if contested or outcome_status = 'approved' then
    perform private.organization_claim_hold_contested(claim.catalog_key, claim.id, 'system', null);
  end if;

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'next', next_step,
    'claimId', claim.id,
    'email', claim.claimant_email,
    'locale', claim.locale
  );
end;
$function$;

-- ------------------------------------------------ verifier decisions

create function public.review_organization_claim(
  p_claim_id uuid,
  p_operator_user_id uuid,
  p_decision text,
  p_verification_method text,
  p_hold_reason text,
  p_reason_code text,
  p_note text,
  p_mailback_code text,
  p_idempotency_key uuid,
  p_operator_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  replay record;
  found_key text;
  found_org uuid;
  claim private.organization_claims%rowtype;
  claim_signals jsonb;
  contested boolean;
  note text;
  attempts integer;
begin
  perform private.lock_case_graph(array[p_operator_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select e.claim_id, e.event_type, e.metadata into replay
    from private.catalog_review_events as e
   where e.idempotency_key = p_idempotency_key;
  if found then
    if replay.claim_id is distinct from p_claim_id
       or replay.event_type not in ('claim_released', 'claim_held', 'claim_rejected', 'claim_approved', 'claim_mailback_failed')
       or not (replay.event_type = any (case p_decision
             when 'approve' then array['claim_approved', 'claim_mailback_failed']
             when 'reject' then array['claim_rejected']
             when 'hold' then array['claim_held']
             when 'release' then array['claim_released']
             else array[]::text[] end)) then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    if replay.event_type = 'claim_mailback_failed' then
      return pg_catalog.jsonb_build_object(
        'claimId', p_claim_id, 'approved', false, 'reason', 'mailback_mismatch',
        'attemptsLeft', greatest(0, 5 - coalesce((replay.metadata ->> 'count')::integer, 5)),
        'idempotent', true);
    end if;
    return private.organization_claim_review_result(p_claim_id, true);
  end if;

  if p_decision is null or p_decision not in ('approve', 'reject', 'hold', 'release') then
    raise exception 'decision invalid' using errcode = '22023';
  end if;
  note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  if note is not null and (pg_catalog.char_length(note) > 500 or note ~ '[[:cntrl:]]') then
    raise exception 'note invalid' using errcode = '22023';
  end if;

  select c.catalog_key, c.organization_id into found_key, found_org
    from private.organization_claims as c
   where c.id = p_claim_id;
  if not found then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(found_key, 'unlisted'), 509));
  if found_org is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || found_org::text, 509));
  end if;
  select * into claim from private.organization_claims as c where c.id = p_claim_id for update;

  if p_decision = 'release' then
    if claim.status <> 'held' then
      raise exception 'claim state' using errcode = '22023';
    end if;
    update private.organization_claims
       set status = 'under_review', hold_reason = null, updated_at = pg_catalog.now()
     where id = claim.id;
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_released', 'verifier', p_operator_user_id, 'claim', claim.id, claim.organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', claim.catalog_key, 'fromStatus', 'held', 'toStatus', 'under_review',
        'holdReason', claim.hold_reason)),
      p_idempotency_key
    );
    return private.organization_claim_review_result(claim.id, false);
  end if;

  if claim.status not in ('under_review', 'held') then
    raise exception 'claim state' using errcode = '22023';
  end if;

  if p_decision = 'hold' then
    if p_hold_reason is null
       or p_hold_reason not in ('contested', 'election_period', 'awaiting_mailback', 'awaiting_callback') then
      raise exception 'hold reason invalid' using errcode = '22023';
    end if;
    update private.organization_claims
       set status = 'held', hold_reason = p_hold_reason, updated_at = pg_catalog.now()
     where id = claim.id;
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_held', 'verifier', p_operator_user_id, 'claim', claim.id, claim.organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', claim.catalog_key, 'fromStatus', claim.status, 'toStatus', 'held',
        'holdReason', p_hold_reason)),
      p_idempotency_key
    );
    return private.organization_claim_review_result(claim.id, false);
  end if;

  if p_decision = 'reject' then
    if p_reason_code is null or p_reason_code not in (
         'not_verified', 'contested_other_claimant', 'claimant_withdrew', 'duplicate',
         'out_of_scope', 'mailback_failed', 'no_response') then
      raise exception 'reason code invalid' using errcode = '22023';
    end if;
    update private.organization_claims
       set status = 'rejected',
           hold_reason = null,
           reason_code = p_reason_code,
           review_note = note,
           reviewed_by = p_operator_user_id,
           reviewed_at = pg_catalog.now(),
           closed_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = claim.id;
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_rejected', 'verifier', p_operator_user_id, 'claim', claim.id, claim.organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', claim.catalog_key, 'fromStatus', claim.status, 'toStatus', 'rejected',
        'reasonCode', p_reason_code)),
      p_idempotency_key
    );
    return private.organization_claim_review_result(claim.id, false);
  end if;

  -- approve
  if p_verification_method is null or p_verification_method not in (
       'official_domain_email', 'published_office_callback', 'olms_address_mailback',
       'written_authorization', 'parent_body_confirmation') then
    raise exception 'verification method invalid' using errcode = '22023';
  end if;
  -- A retired or merged listing cannot be verified by any rung.
  if claim.catalog_key is not null and not exists (
       select 1 from private.catalog_organizations as o
        where o.catalog_key = claim.catalog_key
          and o.retired_release_id is null
          and o.duplicate_of is null) then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;
  if claim.catalog_key is not null and exists (
       select 1 from private.organization_catalog_placements as p
        where p.identity_catalog_key = claim.catalog_key
          and p.organization_id is distinct from claim.organization_id) then
    raise exception 'catalog identity already verified' using errcode = '23505';
  end if;
  if claim.organization_id is null
     or not exists (
       select 1 from public.organizations as o
        where o.id = claim.organization_id and o.status = 'active') then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;
  if exists (
       select 1 from private.organization_catalog_placements as p
        where p.organization_id = claim.organization_id
          and p.verified_at is not null) then
    raise exception 'organization already verified' using errcode = '23505';
  end if;

  claim_signals := private.catalog_claim_domain_signals(claim.id);
  if p_verification_method = 'official_domain_email'
     and not coalesce((claim_signals ->> 'domainMatch')::boolean, false) then
    raise exception 'domain not verified' using errcode = '22023';
  end if;

  contested := claim.hold_reason = 'contested' or (claim.catalog_key is not null and (
    exists (
      select 1 from private.organization_claims as other
       where other.catalog_key = claim.catalog_key
         and other.id <> claim.id
         and (other.status in ('under_review', 'held')
              or (other.status = 'approved' and other.organization_id is not null)))
    or exists (
      select 1 from private.organization_catalog_placements as p
       where p.identity_catalog_key = claim.catalog_key)));
  if contested and p_verification_method not in ('written_authorization', 'parent_body_confirmation') then
    raise exception 'contested claim needs written authorization' using errcode = '22023';
  end if;

  if p_verification_method = 'olms_address_mailback' then
    if p_mailback_code is null or p_mailback_code !~ '^[0-9A-HJKMNP-TV-Z]{10}$' then
      raise exception 'mail-back code invalid' using errcode = '22023';
    end if;
    if claim.mailback_code_hmac is null or claim.mailback_expires_at <= pg_catalog.now() then
      raise exception 'mail-back code unavailable' using errcode = '22023';
    end if;
    if private.organization_claim_mailback_hmac(claim.id, p_mailback_code) is distinct from claim.mailback_code_hmac then
      attempts := claim.mailback_attempts + 1;
      update private.organization_claims
         set mailback_attempts = attempts,
             mailback_code_hmac = case when attempts >= 5 then null else mailback_code_hmac end,
             updated_at = pg_catalog.now()
       where id = claim.id;
      insert into private.catalog_review_events (
        event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
      ) values (
        'claim_mailback_failed', 'verifier', p_operator_user_id, 'claim', claim.id, claim.organization_id,
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'catalogKey', claim.catalog_key, 'count', attempts)),
        p_idempotency_key
      );
      return pg_catalog.jsonb_build_object(
        'claimId', claim.id, 'approved', false, 'reason', 'mailback_mismatch',
        'attemptsLeft', greatest(0, 5 - attempts), 'idempotent', false);
    end if;
  end if;

  update private.organization_claims
     set status = 'approved',
         hold_reason = null,
         verification_method = p_verification_method,
         verifier_kind = 'platform_operator',
         reviewed_by = p_operator_user_id,
         reviewed_at = pg_catalog.now(),
         closed_at = pg_catalog.now(),
         review_note = note,
         signals = claim_signals,
         updated_at = pg_catalog.now()
   where id = claim.id;
  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
  ) values (
    'claim_approved', 'verifier', p_operator_user_id, 'claim', claim.id, claim.organization_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'catalogKey', claim.catalog_key, 'fromStatus', claim.status, 'toStatus', 'approved',
      'method', p_verification_method, 'autoApproved', false, 'verifierKind', 'platform_operator',
      'domainMatch', coalesce((claim_signals ->> 'domainMatch')::boolean, false))),
    p_idempotency_key
  );

  perform private.organization_claim_verify_placement(claim.id, 'verifier', p_operator_user_id);
  perform private.organization_claim_hold_contested(claim.catalog_key, claim.id, 'verifier', p_operator_user_id);

  return private.organization_claim_review_result(claim.id, false);
end;
$function$;

create function public.issue_organization_claim_mailback(
  p_claim_id uuid,
  p_operator_user_id uuid,
  p_code text,
  p_idempotency_key uuid,
  p_operator_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  replay record;
  found_key text;
  found_org uuid;
  claim private.organization_claims%rowtype;
begin
  perform private.lock_case_graph(array[p_operator_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select e.claim_id, e.event_type into replay
    from private.catalog_review_events as e
   where e.idempotency_key = p_idempotency_key;
  if found then
    if replay.claim_id is distinct from p_claim_id or replay.event_type <> 'claim_mailback_issued' then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return private.organization_claim_review_result(p_claim_id, true);
  end if;

  if p_code is null or p_code !~ '^[0-9A-HJKMNP-TV-Z]{10}$' then
    raise exception 'mail-back code invalid' using errcode = '22023';
  end if;

  select c.catalog_key, c.organization_id into found_key, found_org
    from private.organization_claims as c
   where c.id = p_claim_id;
  if not found then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(found_key, 'unlisted'), 509));
  if found_org is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || found_org::text, 509));
  end if;
  select * into claim from private.organization_claims as c where c.id = p_claim_id for update;

  if claim.status not in ('under_review', 'held') or claim.catalog_key is null then
    raise exception 'claim state' using errcode = '22023';
  end if;
  if claim.mailback_issued_at is not null and claim.mailback_issued_at > pg_catalog.now() - interval '7 days' then
    raise exception 'mail-back code recently issued' using errcode = '22023';
  end if;

  update private.organization_claims
     set mailback_code_hmac = private.organization_claim_mailback_hmac(claim.id, p_code),
         mailback_issued_at = pg_catalog.now(),
         mailback_expires_at = pg_catalog.now() + interval '45 days',
         mailback_attempts = 0,
         status = 'held',
         hold_reason = 'awaiting_mailback',
         updated_at = pg_catalog.now()
   where id = claim.id;
  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
  ) values (
    'claim_mailback_issued', 'verifier', p_operator_user_id, 'claim', claim.id, claim.organization_id,
    pg_catalog.jsonb_build_object(
      'catalogKey', claim.catalog_key, 'fromStatus', claim.status, 'toStatus', 'held',
      'holdReason', 'awaiting_mailback'),
    p_idempotency_key
  );
  return private.organization_claim_review_result(claim.id, false);
end;
$function$;

-- Verifier undo (ruling 4): the claim becomes revoked, verified_at is cleared
-- and the placement is detached. The organization, its account, memberships,
-- role grant and chapter are never touched.
-- The one writer that withdraws a verification: the claim becomes revoked,
-- the placement loses verified_at and its catalog identity (the row goes only
-- when nothing self-reported remains), and every parent or sister claim the
-- organization vouched for is withdrawn in turn with reason parent_changed,
-- down the tree. Called by the verifier undo and by 4a's set and clear when a
-- vouched organization changes or clears its parent. Organizations, accounts,
-- memberships and grants are never touched. Returns the dependent claim ids.
create function private.organization_claim_withdraw(
  p_claim_id uuid,
  p_reason_code text,
  p_actor_kind text,
  p_actor_user_id uuid,
  p_idempotency_key uuid,
  p_note text
)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $function$
declare
  found_key text;
  found_org uuid;
  claim private.organization_claims%rowtype;
  placement private.organization_catalog_placements%rowtype;
  row_deleted boolean;
  dependent record;
  dependents uuid[];
begin
  perform private.lock_case_graph(array[p_actor_user_id], array[]::uuid[]);
  dependents := array[]::uuid[];
  select c.catalog_key, c.organization_id into found_key, found_org
    from private.organization_claims as c
   where c.id = p_claim_id;
  if not found then
    return dependents;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(found_key, 'unlisted'), 509));
  if found_org is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || found_org::text, 509));
  end if;
  select * into claim from private.organization_claims as c where c.id = p_claim_id for update;
  if claim.status <> 'approved' then
    return dependents;
  end if;

  update private.organization_claims
     set status = 'revoked',
         revoked_at = pg_catalog.now(),
         closed_at = pg_catalog.now(),
         reason_code = p_reason_code,
         -- After the D17 purge nothing re-purges this row, so a late note is
         -- not kept.
         review_note = case when claim.personal_data_purged_at is null then coalesce(p_note, review_note) end,
         updated_at = pg_catalog.now()
   where id = claim.id;
  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
  ) values (
    'claim_revoked', p_actor_kind, p_actor_user_id, 'claim', claim.id, claim.organization_id,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'catalogKey', claim.catalog_key, 'fromStatus', 'approved', 'toStatus', 'revoked',
      'reasonCode', p_reason_code)),
    p_idempotency_key
  );

  select * into placement
    from private.organization_catalog_placements as p
   where p.verified_claim_id = claim.id
   for update;
  if found then
    row_deleted := placement.parent_catalog_key is null
      and placement.unlisted_parent_name is null
      and not placement.identity_unlisted;
    if row_deleted then
      delete from private.organization_catalog_placements as p
       where p.organization_id = placement.organization_id;
    else
      update private.organization_catalog_placements
         set verified_at = null,
             verified_claim_id = null,
             verification_status = 'self_reported',
             identity_catalog_key = null,
             updated_at = pg_catalog.now()
       where organization_id = placement.organization_id;
    end if;

    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'placement_detached', p_actor_kind, p_actor_user_id, 'placement', claim.id, placement.organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', placement.identity_catalog_key, 'fromStatus', 'verified',
        'toStatus', case when row_deleted then 'cleared' else 'self_reported' end,
        'verificationStatus', 'self_reported', 'rowDeleted', row_deleted, 'reasonCode', p_reason_code)),
      extensions.gen_random_uuid()
    );

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      placement.organization_id, 'administration', 'organization_catalog_placement_verification_revoked', 'update',
      null, 'organization', placement.organization_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', placement.organization_id,
        'entityType', 'catalog_organization',
        'entityId', coalesce(placement.identity_catalog_key, 'unlisted'),
        'fromStatus', 'verified',
        'toStatus', case when row_deleted then 'cleared' else 'self_reported' end,
        'reasonCode', p_reason_code
      )
    );
  end if;

  if claim.organization_id is not null then
    for dependent in
      select c.id
        from private.organization_claims as c
       where c.vouching_organization_id = claim.organization_id
         and c.status = 'approved'
         and c.verifier_kind in ('parent_organization', 'sibling_organization')
       order by c.id
    loop
      dependents := dependents || dependent.id || private.organization_claim_withdraw(
        dependent.id, 'parent_changed', p_actor_kind, p_actor_user_id, extensions.gen_random_uuid(), null);
    end loop;
  end if;
  return dependents;
end;
$function$;

revoke all on function private.organization_claim_withdraw(uuid, text, text, uuid, uuid, text)
  from public, anon, authenticated, service_role;

comment on function private.organization_claim_withdraw(uuid, text, text, uuid, uuid, text) is
  'Non-executable writer that withdraws an approved claim''s verification (claim revoked, verified_at and the catalog identity cleared, the placement detached) and, recursively, every parent or sister claim the organization vouched for (reason parent_changed). Keeps organizations and accounts.';

create function public.revoke_organization_claim(
  p_claim_id uuid,
  p_operator_user_id uuid,
  p_reason_code text,
  p_note text,
  p_idempotency_key uuid,
  p_operator_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  replay record;
  found_key text;
  found_org uuid;
  claim private.organization_claims%rowtype;
  note text;
  dependents uuid[];
begin
  perform private.lock_case_graph(array[p_operator_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select e.claim_id, e.event_type into replay
    from private.catalog_review_events as e
   where e.idempotency_key = p_idempotency_key;
  if found then
    if replay.claim_id is distinct from p_claim_id or replay.event_type <> 'claim_revoked' then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    select * into claim from private.organization_claims as c where c.id = p_claim_id;
    return pg_catalog.jsonb_build_object(
      'claimId', claim.id, 'organizationId', claim.organization_id,
      'email', claim.claimant_email, 'locale', claim.locale, 'idempotent', true);
  end if;

  if p_reason_code is null or p_reason_code not in (
       'wrong_claimant', 'wrong_organization', 'authority_withdrawn', 'fraud_suspected') then
    raise exception 'reason code invalid' using errcode = '22023';
  end if;
  note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  if note is not null and (pg_catalog.char_length(note) > 500 or note ~ '[[:cntrl:]]') then
    raise exception 'note invalid' using errcode = '22023';
  end if;

  select c.catalog_key, c.organization_id into found_key, found_org
    from private.organization_claims as c
   where c.id = p_claim_id;
  if not found then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(found_key, 'unlisted'), 509));
  if found_org is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || found_org::text, 509));
  end if;
  select * into claim from private.organization_claims as c where c.id = p_claim_id for update;
  if claim.status <> 'approved' then
    raise exception 'claim state' using errcode = '22023';
  end if;

  dependents := private.organization_claim_withdraw(
    claim.id, p_reason_code, 'verifier', p_operator_user_id, p_idempotency_key, note);

  return pg_catalog.jsonb_build_object(
    'claimId', claim.id, 'organizationId', claim.organization_id,
    'email', claim.claimant_email, 'locale', claim.locale,
    'dependentClaimIds', pg_catalog.to_jsonb(dependents), 'idempotent', false);
end;
$function$;

-- ------------------------------------------------ verifier roster

create function public.set_platform_operator(
  p_user_id uuid,
  p_active boolean,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  replay record;
  note text;
  current_row private.platform_operators%rowtype;
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select e.subject_user_id, e.event_type into replay
    from private.catalog_review_events as e
   where e.idempotency_key = p_idempotency_key;
  if found then
    if replay.subject_user_id is distinct from p_user_id
       or replay.event_type not in ('operator_granted', 'operator_revoked')
       or replay.event_type is distinct from (
            case p_active when true then 'operator_granted' when false then 'operator_revoked' end) then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'active', replay.event_type = 'operator_granted', 'idempotent', true);
  end if;

  if p_user_id is null or p_active is null then
    raise exception 'operator invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users as u where u.id = p_user_id) then
    raise exception 'operator unavailable' using errcode = '22023';
  end if;
  select * into current_row from private.platform_operators as o where o.user_id = p_user_id for update;

  if p_active then
    note := pg_catalog.btrim(coalesce(p_note, ''));
    if pg_catalog.char_length(note) not between 1 and 240 or note ~ '[[:cntrl:]]' then
      raise exception 'note invalid' using errcode = '22023';
    end if;
    if current_row.user_id is null then
      insert into private.platform_operators (user_id, capabilities, granted_note)
      values (p_user_id, array['claim_verification'], note);
    else
      update private.platform_operators
         set capabilities = array['claim_verification'],
             granted_note = note,
             granted_at = pg_catalog.now(),
             revoked_at = null
       where user_id = p_user_id;
    end if;
  else
    if current_row.user_id is null then
      raise exception 'operator unavailable' using errcode = '22023';
    end if;
    update private.platform_operators
       set revoked_at = pg_catalog.now()
     where user_id = p_user_id
       and revoked_at is null;
  end if;

  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, subject_user_id, metadata, idempotency_key
  ) values (
    case when p_active then 'operator_granted' else 'operator_revoked' end,
    'system', null, 'operator', p_user_id, '{}'::jsonb, p_idempotency_key
  );

  return pg_catalog.jsonb_build_object('userId', p_user_id, 'active', p_active, 'idempotent', false);
end;
$function$;

-- ------------------------------------------------ verifier CLI reads

create function public.list_organization_claims(
  p_operator_user_id uuid,
  p_status text,
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
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);
  page := coalesce(p_page, 1);
  if page not between 1 and 40 then
    raise exception 'page invalid' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in (
       'awaiting_email', 'under_review', 'held', 'approved', 'rejected', 'expired', 'revoked') then
    raise exception 'status invalid' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'page', page,
    'claims', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'claimId', listed.id,
        'status', listed.status,
        'holdReason', listed.hold_reason,
        'catalogKey', listed.catalog_key,
        'targetName', listed.target_name,
        'unlisted', listed.catalog_key is null,
        'createdAt', listed.created_at,
        'confirmedAt', listed.email_confirmed_at,
        'signals', listed.signals,
        'autoApproved', listed.auto_approved,
        'verifierKind', listed.verifier_kind,
        'vouchingOrganizationId', listed.vouching_organization_id
      ) order by listed.created_at, listed.id)
      from (
        select c.id, c.status, c.hold_reason, c.catalog_key, o.name as target_name,
               c.created_at, c.email_confirmed_at, c.signals, c.auto_approved, c.verifier_kind,
               c.vouching_organization_id
          from private.organization_claims as c
          left join private.catalog_organizations as o on o.catalog_key = c.catalog_key
         where p_status is null or c.status = p_status
         order by c.created_at, c.id
         limit 25 offset (page - 1) * 25
      ) as listed
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.get_organization_claim(
  p_operator_user_id uuid,
  p_claim_id uuid,
  p_operator_session_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  claim private.organization_claims%rowtype;
  target jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.organization_claim_require_operator(p_operator_user_id, p_operator_session_id);
  select * into claim from private.organization_claims as c where c.id = p_claim_id;
  if not found then
    raise exception 'claim unavailable' using errcode = '22023';
  end if;

  if claim.catalog_key is not null then
    select pg_catalog.jsonb_build_object(
      'name', o.name, 'city', o.city, 'state', o.state, 'website', o.website,
      'confidence', o.confidence, 'researchedOn', o.researched_on, 'nextElectionOn', o.next_election_on,
      'active', o.retired_release_id is null and o.duplicate_of is null,
      'officePhone', (
        select contact.value from private.catalog_contacts as contact
         where contact.catalog_key = o.catalog_key
           and contact.contact_kind = 'phone'
           and contact.retired_release_id is null
         order by contact.contact_key
         limit 1))
      into target
      from private.catalog_organizations as o
     where o.catalog_key = claim.catalog_key;
  end if;

  return pg_catalog.jsonb_build_object(
    'claimId', claim.id,
    'status', claim.status,
    'holdReason', claim.hold_reason,
    'catalogKey', claim.catalog_key,
    'target', target,
    'unlisted', case when claim.unlisted_name is null then null else pg_catalog.jsonb_build_object(
      'name', claim.unlisted_name, 'city', claim.unlisted_city, 'state', claim.unlisted_state) end,
    'organizationId', claim.organization_id,
    'organizationName', (select o.name from public.organizations as o where o.id = claim.organization_id),
    'claimant', case when claim.personal_data_purged_at is not null then null else pg_catalog.jsonb_build_object(
      'name', claim.claimant_name, 'title', claim.claimant_title,
      'email', claim.claimant_email, 'statement', claim.statement) end,
    'locale', claim.locale,
    'createdAt', claim.created_at,
    'confirmedAt', claim.email_confirmed_at,
    'signals', claim.signals,
    'verificationMethod', claim.verification_method,
    'verifierKind', claim.verifier_kind,
    'vouchingOrganizationId', claim.vouching_organization_id,
    'autoApproved', claim.auto_approved,
    'reviewedAt', claim.reviewed_at,
    'reasonCode', claim.reason_code,
    'reviewNote', claim.review_note,
    'closedAt', claim.closed_at,
    'mailback', pg_catalog.jsonb_build_object(
      'issuedAt', claim.mailback_issued_at, 'expiresAt', claim.mailback_expires_at,
      'attempts', claim.mailback_attempts, 'active', claim.mailback_code_hmac is not null),
    'personalDataPurgedAt', claim.personal_data_purged_at,
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'type', e.event_type, 'actorKind', e.actor_kind, 'at', e.created_at,
        'method', e.metadata ->> 'method', 'holdReason', e.metadata ->> 'holdReason',
        'reasonCode', e.metadata ->> 'reasonCode', 'toStatus', e.metadata ->> 'toStatus'
      ) order by e.created_at, e.id)
      from private.catalog_review_events as e
      where e.claim_id = claim.id
    ), '[]'::jsonb)
  );
end;
$function$;

-- ------------------------------------------------ the admin verification read

create function public.get_organization_catalog_verification(
  p_selected_hat text,
  p_expected_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  placement private.organization_catalog_placements%rowtype;
  verified_identity jsonb;
  open_claim jsonb;
begin
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into placement
    from private.organization_catalog_placements as p
   where p.organization_id = org;
  if found and placement.verified_at is not null then
    if placement.identity_catalog_key is not null then
      verified_identity := pg_catalog.jsonb_build_object(
        'kind', 'catalog',
        'catalogKey', placement.identity_catalog_key,
        'name', (select o.name from private.catalog_organizations as o
                  where o.catalog_key = placement.identity_catalog_key));
    else
      verified_identity := pg_catalog.jsonb_build_object(
        'kind', 'unlisted',
        'catalogKey', null,
        'name', (select o.name from public.organizations as o where o.id = org));
    end if;
  end if;

  select pg_catalog.jsonb_build_object(
           'state', case when c.status = 'awaiting_email' then 'awaiting_email' else 'in_review' end,
           'catalogKey', c.catalog_key)
    into open_claim
    from private.organization_claims as c
   where c.organization_id = org
     and c.status in ('awaiting_email', 'under_review', 'held')
   order by c.created_at desc
   limit 1;

  return pg_catalog.jsonb_build_object(
    'verification', pg_catalog.jsonb_build_object(
      'status', case when verified_identity is not null then 'verified' else 'self_reported' end,
      'identity', verified_identity,
      'verifiedAt', case when verified_identity is not null then placement.verified_at end),
    'openClaim', open_claim
  );
end;
$function$;

-- ------------------------------------------------ the ladder: parent union and sister chapter

-- Open claims a verified organization's admin may vouch for: claims under
-- review whose target is its child (parent) or its sister chapter (sibling).
-- Returns public-record facts and the claiming organization's name only; no
-- claimant, email, statement or signal.
create function public.list_vouchable_organization_claims(
  p_selected_hat text,
  p_expected_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  voucher_key text;
begin
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- A banned or deleted account, or an organization that is no longer
  -- active, never acts as a verifier.
  if exists (
       select 1 from auth.users as u
        where u.id = (select auth.uid())
          and (u.deleted_at is not null or u.banned_until > pg_catalog.now()))
     or not exists (
       select 1 from public.organizations as o
        where o.id = org and o.status = 'active') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- The list shows other tenants' pending claims, so it takes the same
  -- step-up as the vouch it feeds: aal2 always, and an enrolled verified
  -- factor where the organization's policy requires staff MFA.
  if coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2'
     or (private.staff_mfa_required(org) and not private.has_second_factor((select auth.uid()))) then
    raise exception 'mfa required' using errcode = '42501';
  end if;

  select p.identity_catalog_key into voucher_key
    from private.organization_catalog_placements as p
    join private.organization_claims as verified_by on verified_by.id = p.verified_claim_id
    join private.catalog_organizations as own_listing on own_listing.catalog_key = p.identity_catalog_key
   where p.organization_id = org
     and p.verified_at is not null
     and verified_by.verifier_kind is distinct from 'sibling_organization'
     and own_listing.retired_release_id is null
     and own_listing.duplicate_of is null;
  if voucher_key is null then
    return pg_catalog.jsonb_build_object('claims', '[]'::jsonb);
  end if;

  return pg_catalog.jsonb_build_object('claims', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'claimId', candidate.id,
      'relationship', candidate.relationship,
      'catalogKey', candidate.catalog_key,
      'targetName', candidate.target_name,
      'unlisted', candidate.catalog_key is null,
      'organizationName', candidate.organization_name,
      'confirmedAt', candidate.email_confirmed_at
    ) order by candidate.email_confirmed_at, candidate.id)
    from (
      select related.*
        from (
          select c.id, c.catalog_key, c.email_confirmed_at,
                 coalesce(target.name, c.unlisted_name) as target_name,
                 claimant_org.name as organization_name,
                 private.organization_claim_vouch_relationship(c.id, voucher_key) as relationship
            from private.organization_claims as c
            join public.organizations as claimant_org
              on claimant_org.id = c.organization_id and claimant_org.status = 'active'
            left join private.catalog_organizations as target on target.catalog_key = c.catalog_key
           where c.status = 'under_review'
             and c.organization_id <> org
             and (c.catalog_key is null or (
               target.retired_release_id is null
               and target.duplicate_of is null
               and not coalesce(target.next_election_on between current_date - 30 and current_date + 90, false)))
             and not exists (
               select 1 from private.organization_catalog_placements as own
                where own.organization_id = c.organization_id
                  and (own.verified_at is not null or own.parent_catalog_key = c.catalog_key))
             -- The vouch's contest refusal: nothing is offered on a listing
             -- another organization holds or another open claim contests.
             and (c.catalog_key is null or (
               not exists (
                 select 1 from private.organization_catalog_placements as elsewhere
                  where elsewhere.identity_catalog_key = c.catalog_key)
               and not exists (
                 select 1 from private.organization_claims as other
                  where other.catalog_key = c.catalog_key
                    and other.id <> c.id
                    and (other.status in ('under_review', 'held')
                         or (other.status = 'approved' and other.organization_id is not null)))))
             and c.claimant_user_id is distinct from (select auth.uid())
             and not exists (
               select 1 from public.organization_memberships as m
                where m.organization_id = c.organization_id
                  and m.user_id = (select auth.uid())
                  and m.status = 'active')
        ) as related
       where related.relationship is not null
       order by related.email_confirmed_at, related.id
       limit 200
    ) as candidate
  ), '[]'::jsonb));
end;
$function$;

-- The parent-union and sister-chapter rungs (D2e, D2g). An MFA admin of a
-- verified organization approves, in one call, up to 50 claims under review
-- that its catalog identity is the parent of (parent_body_confirmation) or a
-- sister of (sibling_handshake). Any rung suffices. A held claim (contested,
-- election window, mail-back, callback) is never vouchable: it stays with the
-- platform verifier. Every claim in the call must qualify, or nothing is
-- written.
create function public.vouch_for_organization_claims(
  p_selected_hat text,
  p_expected_organization_id uuid,
  p_claim_ids uuid[],
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  voucher_key text;
  replay record;
  claim private.organization_claims%rowtype;
  relationship text;
  claim_id uuid;
  approved jsonb;
  first_event boolean;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- A banned or deleted account, or an organization that is no longer
  -- active, never acts as a verifier.
  if exists (
       select 1 from auth.users as u
        where u.id = (select auth.uid())
          and (u.deleted_at is not null or u.banned_until > pg_catalog.now()))
     or not exists (
       select 1 from public.organizations as o
        where o.id = org and o.status = 'active') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Vouching changes another tenant's trust, so it needs aal2 even where the
  -- organization has switched staff MFA off, and an enrolled verified factor
  -- where its policy requires staff MFA.
  if coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2'
     or (private.staff_mfa_required(org) and not private.has_second_factor((select auth.uid()))) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select e.actor_user_id, e.event_type, e.claim_id into replay
    from private.catalog_review_events as e
   where e.idempotency_key = p_idempotency_key;
  if found then
    -- The key is stored on the lowest claim id of the first call, and a
    -- replay must name the same claims, all vouched by this organization.
    if replay.actor_user_id is distinct from (select auth.uid()) or replay.event_type <> 'claim_vouched'
       or replay.claim_id is distinct from (
            select x from pg_catalog.unnest(p_claim_ids) as x order by x limit 1)
       or exists (
            select 1 from pg_catalog.unnest(p_claim_ids) as x
             where not exists (
               select 1 from private.organization_claims as c
                where c.id = x and c.vouching_organization_id = org)) then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('approved', coalesce((
      select pg_catalog.jsonb_agg(c.id order by c.id)
        from private.organization_claims as c
       where c.id = any (p_claim_ids) and c.vouching_organization_id = org and c.status = 'approved'
    ), '[]'::jsonb), 'idempotent', true);
  end if;

  if p_claim_ids is null
     or pg_catalog.cardinality(p_claim_ids) not between 1 and 50
     or array_position(p_claim_ids, null) is not null
     or (select pg_catalog.count(distinct x) from pg_catalog.unnest(p_claim_ids) as x) <> pg_catalog.cardinality(p_claim_ids) then
    raise exception 'claims invalid' using errcode = '22023';
  end if;

  -- Only an organization verified other than by a sister's handshake may
  -- vouch, so a handshake never chains into further handshakes.
  select p.identity_catalog_key into voucher_key
    from private.organization_catalog_placements as p
    join private.organization_claims as verified_by on verified_by.id = p.verified_claim_id
    join private.catalog_organizations as own_listing on own_listing.catalog_key = p.identity_catalog_key
   where p.organization_id = org
     and p.verified_at is not null
     and verified_by.verifier_kind is distinct from 'sibling_organization'
     and own_listing.retired_release_id is null
     and own_listing.duplicate_of is null;
  if voucher_key is null then
    raise exception 'verified catalog identity required' using errcode = '42501';
  end if;

  approved := '[]'::jsonb;
  first_event := true;
  foreach claim_id in array (select pg_catalog.array_agg(x order by x) from pg_catalog.unnest(p_claim_ids) as x) loop
    select * into claim from private.organization_claims as c where c.id = claim_id;
    if not found then
      raise exception 'claim not vouchable' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(claim.catalog_key, 'unlisted'), 509));
    if claim.organization_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('union-catalog-claim-org:' || claim.organization_id::text, 509));
    end if;
    select * into claim from private.organization_claims as c where c.id = claim_id for update;

    -- Not the voucher's own organization, not a claim the vouching admin
    -- filed or belongs to (a handshake needs two parties), and still an
    -- active, unverified organization.
    if claim.status <> 'under_review'
       or claim.organization_id is null
       or claim.organization_id = org
       or claim.claimant_user_id is not distinct from (select auth.uid())
       or exists (
         select 1 from public.organization_memberships as m
          where m.organization_id = claim.organization_id
            and m.user_id = (select auth.uid())
            and m.status = 'active')
       or not exists (
         select 1 from public.organizations as o
          where o.id = claim.organization_id and o.status = 'active')
       or exists (
         select 1 from private.organization_catalog_placements as p
          where p.organization_id = claim.organization_id
            and p.verified_at is not null) then
      raise exception 'claim not vouchable' using errcode = '22023';
    end if;
    -- The listing must still be active and outside an election window, as
    -- for the other rungs.
    if claim.catalog_key is not null and (
         not exists (
           select 1 from private.catalog_organizations as o
            where o.catalog_key = claim.catalog_key
              and o.retired_release_id is null
              and o.duplicate_of is null)
         or coalesce((private.catalog_claim_domain_signals(claim.id) ->> 'electionWindow')::boolean, false)) then
      raise exception 'claim not vouchable' using errcode = '22023';
    end if;
    if claim.catalog_key is not null and (
         exists (
           select 1 from private.organization_catalog_placements as p
            where p.identity_catalog_key = claim.catalog_key)
         or exists (
           select 1 from private.organization_claims as other
            where other.catalog_key = claim.catalog_key
              and other.id <> claim.id
              and (other.status in ('under_review', 'held')
                   or (other.status = 'approved' and other.organization_id is not null)))) then
      raise exception 'claim not vouchable' using errcode = '22023';
    end if;
    relationship := private.organization_claim_vouch_relationship(claim.id, voucher_key);
    if relationship is null then
      raise exception 'claim not vouchable' using errcode = '22023';
    end if;

    update private.organization_claims
       set status = 'approved',
           hold_reason = null,
           verification_method = case when relationship = 'parent' then 'parent_body_confirmation' else 'sibling_handshake' end,
           verifier_kind = case when relationship = 'parent' then 'parent_organization' else 'sibling_organization' end,
           vouching_organization_id = org,
           reviewed_by = (select auth.uid()),
           reviewed_at = pg_catalog.now(),
           closed_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = claim.id;
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_vouched', 'organization_admin', (select auth.uid()), 'claim', claim.id, claim.organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', claim.catalog_key, 'fromStatus', 'under_review', 'toStatus', 'approved',
        'method', case when relationship = 'parent' then 'parent_body_confirmation' else 'sibling_handshake' end,
        'verifierKind', case when relationship = 'parent' then 'parent_organization' else 'sibling_organization' end,
        'relationship', relationship, 'autoApproved', false)),
      case when first_event then p_idempotency_key else extensions.gen_random_uuid() end
    );
    first_event := false;

    perform private.organization_claim_verify_placement(claim.id, 'organization_admin', (select auth.uid()));

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'administration', 'organization_catalog_claim_vouched', 'update',
      (select auth.uid()), 'organization', org::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', org,
        'entityType', 'catalog_organization',
        'entityId', coalesce(claim.catalog_key, 'unlisted'),
        'fromStatus', 'under_review',
        'toStatus', 'approved',
        'reasonCode', relationship
      )
    );
    approved := approved || pg_catalog.to_jsonb(claim.id);
  end loop;

  return pg_catalog.jsonb_build_object('approved', approved, 'idempotent', false);
end;
$function$;

-- ------------------------------------------------ the public landing read (D2f)

-- Anonymous, public-record-safe verification state of one active
-- organization by slug: its name, whether it is verified and as which
-- listing, and its self-reported placement under a catalog parent. No
-- member, admin, claimant, verifier or method is returned, and an unlisted
-- parent's free-text name is not shown (it needs moderation first). An
-- unknown or inactive slug and a malformed one read the same.
create function public.get_organization_public_verification(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  organization public.organizations%rowtype;
  placement private.organization_catalog_placements%rowtype;
  identity jsonb;
  parent jsonb;
begin
  if p_slug is null or p_slug !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  select * into organization
    from public.organizations as o
   where o.slug = p_slug
     and o.status = 'active';
  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  select * into placement
    from private.organization_catalog_placements as p
   where p.organization_id = organization.id;
  if found and placement.verified_at is not null then
    identity := case
      when placement.identity_catalog_key is not null then pg_catalog.jsonb_build_object(
        'kind', 'catalog',
        'catalogKey', placement.identity_catalog_key,
        'name', (select o.name from private.catalog_organizations as o
                  where o.catalog_key = placement.identity_catalog_key))
      else pg_catalog.jsonb_build_object('kind', 'unlisted') end;
  end if;
  if found and placement.parent_catalog_key is not null then
    parent := pg_catalog.jsonb_build_object(
      'kind', 'catalog',
      'catalogKey', placement.parent_catalog_key,
      'name', (select o.name from private.catalog_organizations as o
                where o.catalog_key = placement.parent_catalog_key),
      'selfReported', true);
  elsif found and placement.unlisted_parent_name is not null then
    parent := pg_catalog.jsonb_build_object('kind', 'unlisted', 'selfReported', true);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'organization', pg_catalog.jsonb_build_object('name', organization.name, 'slug', organization.slug),
    'verification', pg_catalog.jsonb_build_object(
      'status', case when identity is not null then 'verified' else 'self_reported' end,
      'identity', identity,
      'verifiedOn', case when identity is not null then (placement.verified_at at time zone 'America/New_York')::date end),
    'placement', parent
  );
end;
$function$;

-- ------------------------------------------------ retention (D17 default)

create function private.purge_organization_claim_personal_data()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare removed integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Unconfirmed claims expire at their 24-hour deadline; open claims never
  -- decided (under review or held) expire 90 days after submission (C10
  -- default, owner may override). Expired is terminal and blocks nothing.
  with expiring as (
    select c.id, c.status as from_status
      from private.organization_claims as c
     where (c.status = 'awaiting_email' and c.confirm_expires_at < pg_catalog.now())
        or (c.status in ('under_review', 'held') and c.created_at < pg_catalog.now() - interval '90 days')
     limit 2000
     for update skip locked
  ), expired as (
    update private.organization_claims as c
       set status = 'expired',
           hold_reason = null,
           confirm_token_hash = null,
           closed_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
      from expiring
     where c.id = expiring.id
    returning c.id, c.organization_id, c.catalog_key, expiring.from_status
  )
  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
  )
  select 'claim_expired', 'system', null, 'claim', expired.id, expired.organization_id,
         pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
           'catalogKey', expired.catalog_key, 'fromStatus', expired.from_status, 'toStatus', 'expired')),
         extensions.gen_random_uuid()
    from expired;

  update private.organization_claims as c
     set claimant_name = null,
         claimant_title = null,
         claimant_email = null,
         statement = null,
         review_note = null,
         mailback_code_hmac = null,
         mailback_issued_at = null,
         mailback_expires_at = null,
         personal_data_purged_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where c.ctid in (
     select candidate.ctid
       from private.organization_claims as candidate
      where candidate.personal_data_purged_at is null
        and candidate.status in ('approved', 'rejected', 'expired', 'revoked')
        and (candidate.closed_at < pg_catalog.now()
               - case when candidate.status = 'expired' then interval '7 days' else interval '90 days' end
             -- An open claim expired at 90 days is purged in the same run.
             or (candidate.status = 'expired' and candidate.created_at < pg_catalog.now() - interval '90 days'))
      limit 2000
      for update skip locked
   );
  get diagnostics removed = row_count;
  return removed;
end;
$function$;

revoke all on function private.purge_organization_claim_personal_data()
  from public, anon, authenticated, service_role;

comment on function private.purge_organization_claim_personal_data() is
  'Internal bounded retention sweep (D17 default): expires unconfirmed claims after 24 hours and open claims never decided 90 days after submission (C10 default), then deletes claimant name, title, email, note and mail-back fields 7 days after an unconfirmed claim expires, when an open claim expires at 90 days, or 90 days after a decision. Keeps the claim record, its target and decision codes. No client role can execute it.';

do $schedule$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.schedule(
      'organization-claim-retention',
      '41 5 * * *',
      'select private.purge_organization_claim_personal_data();'
    );
  end if;
exception when unique_violation then null;
end;
$schedule$;

-- Monitoring: organization-claim-retention joins the four copies of the monitored
-- set (the job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20260925620400 with only that name added.

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
    'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
    'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
    'event-checkin-token-retention',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention',
    'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
    'notifications-expiry-sweep',
    'organization-claim-retention',
    'organization-automation-tick',
    'task-files-reconcile-tick', 'task-maintenance-daily',
    'union-ground-organization-retention', 'weekly-question-selection-tick',
    'workload-reminders-tick'
  ));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  with candidate as (
    select j.jobname as job_name,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in (
      'appointment-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick', 'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep',
      'organization-claim-retention',
      'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ) and (d.start_time >= window_start or d.runid = any(open_runs))
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, c.job_name, c.run_id, c.status, c.started_at, c.finished_at,
    c.failure_code, c.redacted_summary
  from candidate c
  left join public.organization_job_runs mirrored
    on mirrored.job_name = c.job_name
   and mirrored.run_id = c.run_id
   and mirrored.organization_id is null
  where mirrored.id is null
     or mirrored.status is distinct from c.status
     or mirrored.finished_at is distinct from c.finished_at
     or mirrored.failure_code is distinct from c.failure_code
     or mirrored.redacted_summary is distinct from c.redacted_summary
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array[
      'account-deletion-reconcile-tick', 'appointment-reminders-tick',
      'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
      'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
      'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep',
      'organization-claim-retention',
      'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ]) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

-- ------------------------------------------------ Phase 4a placement RPCs, re-emitted

-- 4a's set and clear are re-emitted from 20260925960000_catalog_organization_self_placement.sql with these
-- changes and nothing else. clear refuses a verified row ("placement verified"):
-- only the verifier undoes a verification. set no longer resets
-- verification_status on update (4a's upsert wrote 'self_reported', which would
-- break a verified row's shape check), refuses to flip identity_unlisted while
-- the row is verified, lets a row with a verified catalog identity drop its
-- self-reported parent (the identity keeps it placed), and logs the kept
-- status as toStatus. A parent equal to the verified identity fails
-- organization_catalog_placements_parent_not_self.

create or replace function public.set_organization_catalog_placement(
  p_selected_hat text,
  p_expected_organization_id uuid,
  p_parent_catalog_key text,
  p_unlisted_parent_name text,
  p_unlisted_parent_state text,
  p_identity_unlisted boolean,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  parent_key text;
  parent_name text;
  parent_state text;
  identity_only boolean;
  parent jsonb;
  prior_status text;
  prior_identity_unlisted boolean;
  prior_identity_key text;
  prior_parent_key text;
  prior_claim_id uuid;
  prior_verifier_kind text;
  withdraw boolean;
  replay record;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A replay is the same key, organization and operation: a key first spent
  -- on a clear is not a replay of a set.
  select l.organization_id, l.event_type, l.metadata ->> 'reasonCode' as reason_code into replay
    from public.organization_audit_ledger as l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.organization_id is distinct from org
       or replay.event_type is distinct from 'organization_catalog_placement_changed'
       or replay.reason_code is not distinct from 'cleared' then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return private.organization_catalog_placement_state(org);
  end if;

  parent_key := nullif(pg_catalog.btrim(p_parent_catalog_key), '');
  parent_name := nullif(pg_catalog.btrim(p_unlisted_parent_name), '');
  parent_state := nullif(pg_catalog.btrim(p_unlisted_parent_state), '');
  identity_only := coalesce(p_identity_unlisted, false);

  if parent_key is not null and parent_name is not null then
    raise exception 'placement parent ambiguous' using errcode = '22023';
  end if;
  if parent_state is not null and parent_name is null then
    raise exception 'placement state needs name' using errcode = '22023';
  end if;
  select p.verification_status, p.identity_unlisted, p.identity_catalog_key
    into prior_status, prior_identity_unlisted, prior_identity_key
    from private.organization_catalog_placements as p
   where p.organization_id = org;
  -- A parent-union or sister vouch pins the parent: changing the parent key
  -- withdraws that verification (reason parent_changed). Domain and platform
  -- verifications do not rest on the parent and are kept.
  select p.parent_catalog_key, p.verified_claim_id, c.verifier_kind
    into prior_parent_key, prior_claim_id, prior_verifier_kind
    from private.organization_catalog_placements as p
    left join private.organization_claims as c on c.id = p.verified_claim_id
   where p.organization_id = org;
  withdraw := coalesce(prior_status = 'verified'
    and prior_verifier_kind in ('parent_organization', 'sibling_organization')
    and parent_key is distinct from prior_parent_key, false);
  if parent_key is null and parent_name is null and not identity_only
     and (prior_identity_key is null or withdraw) then
    raise exception 'placement empty' using errcode = '22023';
  end if;
  if parent_name is not null and (
       pg_catalog.char_length(parent_name) not between 3 and 200
       or parent_name ~ '[[:cntrl:]]'
       or parent_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(parent_name, '@') > 0
       or pg_catalog.strpos(parent_name, '://') > 0
       or pg_catalog.regexp_replace(parent_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}') then
    raise exception 'placement name invalid' using errcode = '22023';
  end if;
  if parent_state is not null and parent_state !~ '^[A-Z]{2}$' then
    raise exception 'placement state invalid' using errcode = '22023';
  end if;
  if parent_key is not null then
    if parent_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
      raise exception 'placement target unavailable' using errcode = '22023';
    end if;
    parent := private.organization_catalog_parent(parent_key);
    if not coalesce((parent ->> 'active')::boolean, false) then
      raise exception 'placement target unavailable' using errcode = '22023';
    end if;
  end if;

  if (select pg_catalog.count(*)
        from public.organization_audit_ledger as l
       where l.organization_id = org
         and l.event_type = 'organization_catalog_placement_changed'
         and l.occurred_at > pg_catalog.now() - interval '24 hours') >= 10 then
    raise exception 'placement change limit' using errcode = '22023';
  end if;

  if withdraw then
    perform private.organization_claim_withdraw(
      prior_claim_id, 'parent_changed', 'organization_admin', (select auth.uid()),
      extensions.gen_random_uuid(), null);
    select p.verification_status, p.identity_unlisted, p.identity_catalog_key
      into prior_status, prior_identity_unlisted, prior_identity_key
      from private.organization_catalog_placements as p
     where p.organization_id = org;
  end if;

  if prior_status = 'verified' and identity_only is distinct from prior_identity_unlisted then
    raise exception 'placement verified' using errcode = '22023';
  end if;

  -- An existing row is updated in place: an INSERT's proposed row is checked
  -- against the CHECKs before ON CONFLICT, so a verified identity-only row
  -- dropping its parent would fail organization_catalog_placements_something_placed.
  if prior_status is not null then
    update private.organization_catalog_placements
       set parent_catalog_key = parent_key,
           unlisted_parent_name = parent_name,
           unlisted_parent_state = parent_state,
           identity_unlisted = identity_only,
           updated_at = pg_catalog.now()
     where organization_id = org;
  else
    insert into private.organization_catalog_placements as p (
      organization_id, parent_catalog_key, unlisted_parent_name, unlisted_parent_state,
      identity_unlisted, verification_status, placed_at, updated_at
    ) values (
      org, parent_key, parent_name, parent_state, identity_only, 'self_reported',
      pg_catalog.now(), pg_catalog.now()
    )
    on conflict (organization_id) do update
      set parent_catalog_key = excluded.parent_catalog_key,
          unlisted_parent_name = excluded.unlisted_parent_name,
          unlisted_parent_state = excluded.unlisted_parent_state,
          identity_unlisted = excluded.identity_unlisted,
          updated_at = pg_catalog.now();
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'organization_catalog_placement_changed', 'update',
    (select auth.uid()), 'organization', org::text, p_idempotency_key,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'entityType', case when parent_key is not null then 'catalog_organization' else 'unlisted' end,
      'entityId', parent_key,
      'fromStatus', coalesce(prior_status, 'unset'),
      'toStatus', coalesce(prior_status, 'self_reported'),
      'reasonCode', case when parent_key is not null or parent_name is not null then 'parent_set'
                         when identity_only then 'identity_unlisted'
                         else 'parent_cleared' end
    ))
  );

  return private.organization_catalog_placement_state(org);
end;
$function$;

create or replace function public.clear_organization_catalog_placement(
  p_selected_hat text,
  p_expected_organization_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  prior_status text;
  prior_claim_id uuid;
  prior_verifier_kind text;
  replay record;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A replay is the same key, organization and operation: a key first spent
  -- on a set is not a replay of a clear.
  select l.organization_id, l.event_type, l.metadata ->> 'reasonCode' as reason_code into replay
    from public.organization_audit_ledger as l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.organization_id is distinct from org
       or replay.event_type is distinct from 'organization_catalog_placement_changed'
       or replay.reason_code is distinct from 'cleared' then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return private.organization_catalog_placement_state(org);
  end if;

  select p.verification_status, p.verified_claim_id, c.verifier_kind
    into prior_status, prior_claim_id, prior_verifier_kind
    from private.organization_catalog_placements as p
    left join private.organization_claims as c on c.id = p.verified_claim_id
   where p.organization_id = org;
  if not found then
    return pg_catalog.jsonb_build_object('placement', null);
  end if;
  -- Only the verifier undoes a domain or platform verification; clearing the
  -- placement of an organization verified by a parent or sister vouch
  -- withdraws that verification (reason parent_changed).
  if prior_status = 'verified'
     and coalesce(prior_verifier_kind, '') not in ('parent_organization', 'sibling_organization') then
    raise exception 'placement verified' using errcode = '22023';
  end if;

  if (select pg_catalog.count(*)
        from public.organization_audit_ledger as l
       where l.organization_id = org
         and l.event_type = 'organization_catalog_placement_changed'
         and l.occurred_at > pg_catalog.now() - interval '24 hours') >= 10 then
    raise exception 'placement change limit' using errcode = '22023';
  end if;

  if prior_status = 'verified' then
    perform private.organization_claim_withdraw(
      prior_claim_id, 'parent_changed', 'organization_admin', (select auth.uid()),
      extensions.gen_random_uuid(), null);
  end if;

  delete from private.organization_catalog_placements as p
   where p.organization_id = org;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'organization_catalog_placement_changed', 'update',
    (select auth.uid()), 'organization', org::text, p_idempotency_key,
    pg_catalog.jsonb_build_object(
      'fromStatus', prior_status,
      'toStatus', 'cleared',
      'reasonCode', 'cleared'
    )
  );

  return pg_catalog.jsonb_build_object('placement', null);
end;
$function$;

-- ------------------------------------------------ grants

revoke all on function public.submit_organization_claim(text, text, text, jsonb, jsonb, jsonb, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_organization_claim(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.review_organization_claim(uuid, uuid, text, text, text, text, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.issue_organization_claim_mailback(uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.revoke_organization_claim(uuid, uuid, text, text, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_platform_operator(uuid, boolean, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_organization_claims(uuid, text, integer, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_organization_claim(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_organization_catalog_verification(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_vouchable_organization_claims(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.vouch_for_organization_claims(text, uuid, uuid[], uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_organization_public_verification(text)
  from public, anon, authenticated, service_role;

grant execute on function public.submit_organization_claim(text, text, text, jsonb, jsonb, jsonb, text, text, uuid, uuid)
  to service_role;
grant execute on function public.confirm_organization_claim(text, text) to service_role;
grant execute on function public.review_organization_claim(uuid, uuid, text, text, text, text, text, text, uuid, uuid)
  to service_role;
grant execute on function public.issue_organization_claim_mailback(uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function public.revoke_organization_claim(uuid, uuid, text, text, uuid, uuid) to service_role;
grant execute on function public.set_platform_operator(uuid, boolean, text, uuid) to service_role;
grant execute on function public.list_organization_claims(uuid, text, integer, uuid) to service_role;
grant execute on function public.get_organization_claim(uuid, uuid, uuid) to service_role;
grant execute on function public.get_organization_catalog_verification(text, uuid) to authenticated;
grant execute on function public.list_vouchable_organization_claims(text, uuid) to authenticated;
grant execute on function public.vouch_for_organization_claims(text, uuid, uuid[], uuid) to authenticated;
grant execute on function public.get_organization_public_verification(text) to anon, authenticated, service_role;

comment on function public.submit_organization_claim(text, text, text, jsonb, jsonb, jsonb, text, text, uuid, uuid) is
  'Service-role claim submission by an existing organization''s admin: we are this union catalog listing, or an organization the catalog lacks. Rate-limited; every refusal answers like success. Never returns a claim id or status.';
comment on function public.confirm_organization_claim(text, text) is
  'Service-role email confirmation of a claim: computes the domain signals, applies the contest rule, then approves automatically on a unique own-domain match, holds, or queues for the verifier. The result goes to the API only.';
comment on function public.review_organization_claim(uuid, uuid, text, text, text, text, text, text, uuid, uuid) is
  'Verifier decision on a claim (approve, reject, hold, release). Requires the service role and a named active platform operator with claim_verification. A wrong mail-back code is counted and committed rather than raised.';
comment on function public.issue_organization_claim_mailback(uuid, uuid, text, uuid, uuid) is
  'Verifier issue of a mail-back code: stores only its Vault-keyed HMAC, valid 45 days, five attempts, at most one issue per claim per 7 days.';
comment on function public.revoke_organization_claim(uuid, uuid, text, text, uuid, uuid) is
  'Verifier undo of an approved claim: revokes it, clears verified_at and detaches the placement. Never deletes or suspends the organization, its account, memberships, role grant or chapter.';
comment on function public.set_platform_operator(uuid, boolean, text, uuid) is
  'Service-role grant or revocation of the claim_verification capability. The only writer of private.platform_operators.';
comment on function public.list_organization_claims(uuid, text, integer, uuid) is
  'Verifier claim queue, 25 per page, without claimant personal data.';
comment on function public.get_organization_claim(uuid, uuid, uuid) is
  'Verifier view of one claim, including claimant details until they are purged, the target listing''s public facts and the event timeline.';
comment on function public.get_organization_catalog_verification(text, uuid) is
  'Admin read of the organization''s verified catalog identity and any open verification request. MFA-guarded; verified exactly when verified_at is set; never returns a claimant, verifier, method or hold reason.';
comment on function public.list_vouchable_organization_claims(text, uuid) is
  'Admin read, for a verified organization, of the claims under review it may vouch for as the parent union or a sister chapter. Public-record facts and the claiming organization''s name only.';
comment on function public.vouch_for_organization_claims(text, uuid, uuid[], uuid) is
  'The parent-union and sister-chapter rungs of the verification ladder: an MFA admin of a verified organization approves up to 50 of its children''s or sisters'' claims under review in one call. Held and contested claims stay with the platform verifier; all or nothing.';
comment on function public.get_organization_public_verification(text) is
  'Anonymous landing-page read by slug: organization name, verification state and verified listing, and the self-reported catalog parent. No member, admin, claimant or verifier data.';

notify pgrst, 'reload schema';

commit;
