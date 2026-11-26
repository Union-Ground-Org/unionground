-- REQ-UG-RESERVED-LOCAL-WIDE-ORGANIZATION-20261109 (#7671).
--
-- Project decision of Sept 25, 2026 (D2d, recorded in 20260930040000) stands:
-- organizations are created openly and verification never creates one. The
-- a project decision of Nov 10, 2026, 6:37 AM ET
-- applies it to the local-wide organization:
--
--   * choosing the local-wide option files a claim on the local's catalog
--     entry with a local-wide scope (private.organization_claims.scope). That
--     claim is the request; it goes through the existing confirmation, ladder
--     and platform review, and a second request for the same local is a second
--     claim held beside the first (the existing contested hold), never an
--     overwrite;
--   * the organization is the official local-wide organization only while a
--     local-wide claim of its is approved;
--   * until then (requested, or verification undone) it may hold only the one
--     chapter its creator represents: a guard trigger on public.chapters
--     refuses any further chapter, whichever writer inserts it (moving a
--     chapter in is already refused: a chapter's organization is immutable). Accepting
--     another organization's chapter already needs a verified organization
--     (vouching, 20260930040000), and the public landing read shows a catalog
--     identity only once verified, so neither needs a new rule here;
--   * the admin verification read says "requested" or "official";
--   * the request is accepted only from an organization that holds at most one
--     chapter when it is filed (addendum of 9:21 AM ET): the wrapper locks the
--     organization row before it counts, and the chapter guard takes the same
--     lock before it reads the request, so a chapter added at the same moment
--     is either counted or refused;
--   * platform review sees which claim is local-wide: list_organization_claims
--     and get_organization_claim gain a scope key (live bodies, re-emitted with
--     only that change).
--
-- New objects: the scope column and its checks, two private predicates, the
-- chapter guard, and public.submit_local_wide_organization_claim, a
-- service-role wrapper that files through public.submit_organization_claim
-- unchanged and marks the claim it inserted local-wide in the same
-- transaction. Re-emitted: public.get_organization_catalog_verification
-- (live body; the result gains a localWide key only when it applies). No
-- grant widens; no row becomes readable that was not.

begin;

do $predecessors$ begin
if (select md5(prosrc) from pg_proc where oid='public.list_organization_claims(uuid,text,integer,uuid)'::regprocedure) is distinct from 'ef7b194d7da6800a49bd243a52881c8d' then raise exception 'unreviewed list_organization_claims predecessor' using errcode='55000'; end if;
if (select md5(prosrc) from pg_proc where oid='public.get_organization_claim(uuid,uuid,uuid)'::regprocedure) is distinct from '95e352a0df0b5c1974cb258e3f5642ee' then raise exception 'unreviewed get_organization_claim predecessor' using errcode='55000'; end if;
end; $predecessors$;

alter table private.organization_claims
  add column scope text not null default 'organization',
  add constraint organization_claims_scope_check check (scope in ('organization', 'local_wide')),
  add constraint organization_claims_local_wide_listed check (scope <> 'local_wide' or catalog_key is not null);

comment on column private.organization_claims.scope is
  'organization: a claim to be a catalog listing (Phase 3a). local_wide: the request to be a local''s local-wide organization (#7671); official only while approved.';

create function private.organization_local_wide_official(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from private.organization_claims as c
     where c.organization_id = p_organization_id
       and c.scope = 'local_wide'
       and c.status = 'approved')
$function$;

-- Requested and not official: a local-wide claim awaiting email, in review,
-- held or revoked (verification undone), and none approved.
create function private.organization_local_wide_requested(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from private.organization_claims as c
     where c.organization_id = p_organization_id
       and c.scope = 'local_wide'
       and c.status in ('awaiting_email', 'under_review', 'held', 'revoked'))
    and not private.organization_local_wide_official(p_organization_id)
$function$;

revoke all on function private.organization_local_wide_official(uuid) from public, anon, authenticated, service_role;
revoke all on function private.organization_local_wide_requested(uuid) from public, anon, authenticated, service_role;

create function private.guard_local_wide_requested_chapters()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if new.organization_id is null then
    return new;
  end if;
  -- Lock the organization before reading the request. The local-wide request
  -- takes the same lock before it counts chapters, so this insert either lands
  -- first and is counted there, or waits and then sees the request; two
  -- inserts cannot both see the organization holding none.
  perform 1 from public.organizations as o where o.id = new.organization_id for update;
  if not private.organization_local_wide_requested(new.organization_id) then
    return new;
  end if;
  if exists (select 1 from public.chapters as ch
              where ch.organization_id = new.organization_id and ch.id <> new.id) then
    raise exception 'local-wide organization not verified'
      using errcode = '42501', detail = 'local_wide_requested',
            hint = 'A requested local-wide organization holds one chapter until its claim is verified.';
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_local_wide_requested_chapters() from public, anon, authenticated, service_role;

-- Insert only: a chapter's organization is already immutable
-- ("chapter organization is immutable"), so no chapter can be moved in.
create trigger chapters_local_wide_requested_guard
  before insert on public.chapters
  for each row execute function private.guard_local_wide_requested_chapters();

-- Reviewed trigger surface (account lifecycle inventory): the new chapter
-- guard and the functions it reaches.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and table_name = 'chapters'
        and object_name = 'chapters_local_wide_requested_guard')
   or (kind = 'function' and schema_name = 'private' and object_name in (
        'guard_local_wide_requested_chapters()',
        'organization_local_wide_requested(p_organization_id uuid)',
        'organization_local_wide_official(p_organization_id uuid)'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_local_wide_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the local-wide guard: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_local_wide_lifecycle$;

create function public.submit_local_wide_organization_claim(
  p_scope_hash text,
  p_email_scope_hash text,
  p_catalog_key text,
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
  result jsonb;
begin
  perform private.lock_case_graph(array[p_requesting_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_catalog_key is null or p_organization_id is null then
    raise exception 'local-wide claim needs a catalog entry and an organization' using errcode = '22023';
  end if;
  -- The requester must be an active admin of the organization before anything
  -- about it is read (the same test public.submit_organization_claim makes), so
  -- the chapter count below never answers for an organization the requester
  -- does not run.
  if p_requesting_user_id is null
     or not exists (
       select 1 from public.organizations as o
        where o.id = p_organization_id and o.status = 'active' and o.kind = 'union')
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
  -- Addendum of 9:21 AM ET: only an organization holding at most one chapter
  -- may request. The chapter guard takes this lock before it reads the
  -- request, so a chapter added at the same moment is counted here or refused
  -- there. Refused before anything is written.
  perform 1 from public.organizations as o where o.id = p_organization_id for update;
  if (select pg_catalog.count(*) from public.chapters as ch where ch.organization_id = p_organization_id) > 1 then
    raise exception 'An organization with more than one chapter cannot request to be the local-wide organization.'
      using errcode = '42501', detail = 'local_wide_more_than_one_chapter';
  end if;
  result := public.submit_organization_claim(
    p_scope_hash, p_email_scope_hash, p_catalog_key, null, p_claimant, p_attestation,
    p_locale, p_confirm_token_hash, p_requesting_user_id, p_organization_id);
  -- The claim this call inserted, if any (a silent refusal inserts none).
  update private.organization_claims as c
     set scope = 'local_wide', updated_at = pg_catalog.now()
   where c.confirm_token_hash = p_confirm_token_hash
     and c.organization_id = p_organization_id
     and c.catalog_key = p_catalog_key
     and c.created_at = pg_catalog.now()
     and c.scope = 'organization';
  return result;
end;
$function$;

revoke all on function public.submit_local_wide_organization_claim(text, text, text, jsonb, jsonb, text, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.submit_local_wide_organization_claim(text, text, text, jsonb, jsonb, text, text, uuid, uuid)
  to service_role;

CREATE OR REPLACE FUNCTION public.get_organization_catalog_verification(p_selected_hat text, p_expected_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  placement private.organization_catalog_placements%rowtype;
  verified_identity jsonb;
  open_claim jsonb;
begin
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
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
     and (c.status <> 'awaiting_email' or c.confirm_expires_at > pg_catalog.now())
   order by c.created_at desc
   limit 1;

  -- #7671: a local-wide request reads as requested until a local-wide claim
  -- is approved, then as official; the key is absent otherwise. A requested
  -- organization also gets the local it asked for, so the page can file the
  -- request again after verification was undone.
  return pg_catalog.jsonb_build_object(
    'verification', pg_catalog.jsonb_build_object(
      'status', case when verified_identity is not null then 'verified' else 'self_reported' end,
      'identity', verified_identity,
      'verifiedAt', case when verified_identity is not null then placement.verified_at end),
    'openClaim', open_claim
  ) || case
    when private.organization_local_wide_official(org) then pg_catalog.jsonb_build_object('localWide', 'official')
    when private.organization_local_wide_requested(org) then pg_catalog.jsonb_build_object(
      'localWide', 'requested',
      'localWideCatalogKey', (select c.catalog_key from private.organization_claims as c
                               where c.organization_id = org and c.scope = 'local_wide'
                                 and c.status in ('awaiting_email', 'under_review', 'held', 'revoked')
                               order by c.created_at desc, c.id desc limit 1))
    else '{}'::jsonb end;
end;
$function$;

-- Platform review sees which claim is the local-wide request.
create or replace function public.list_organization_claims(
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
        'vouchingOrganizationId', listed.vouching_organization_id,
        'scope', listed.scope
      ) order by listed.created_at, listed.id)
      from (
        select c.id, c.status, c.hold_reason, c.catalog_key, o.name as target_name,
               c.created_at, c.email_confirmed_at, c.signals, c.auto_approved, c.verifier_kind,
               c.vouching_organization_id, c.scope
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

create or replace function public.get_organization_claim(
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
    'scope', claim.scope,
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

notify pgrst, 'reload schema';

commit;
