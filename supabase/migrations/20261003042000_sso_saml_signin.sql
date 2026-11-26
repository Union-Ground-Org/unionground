-- REQ-UG-SSO-SIGNIN-20261001
--
-- Restore-everything campaign, (: SSO is
-- back in scope as an unset activation). The "SaaS ship-complete bar":
-- per-organization sign-in through Supabase Auth SSO, inside the
-- Invitation-only accounts contract, so SSO signs in ONLY people who already
-- hold an invitation or membership in that organization. There is no
-- just-in-time membership by domain and SSO never creates an account.
--
-- Old app: de7df4b57c^ had no enterprise SSO. Its "SSO" was Google OAuth
-- (lib/union-ground/guide.ts:259 "magic link (email OTP) + Google SSO +
-- passkey") and a design mock (components/design-session/sg-onboarding-screens.tsx:248).
-- No flag existed, so features.security.sso starts OFF: the old effective
-- production behavior had no per-organization identity provider.
--
-- How Supabase Auth SSO is used (supabase/auth internal/api/samlacs.go,
-- external.go, models/linking.go):
--   * SAML 2.0 only. Each provider is its own account-linking domain
--     ("sso:<provider id>"), so a SAML sign-in never auto-links to an existing
--     account; with signups disabled (GOTRUE_DISABLE_SIGNUP, the invitation-
--     only contract) a first SAML sign-in with no identity is refused.
--   * GoTrue signs a person in through SAML only when auth.identities already
--     holds (provider = 'sso:<provider id>', provider_id = SAML NameID) for
--     that person's account. This migration is the only writer of such rows
--     (private.sso_link_identity), and only for an account that already
--     exists AND holds an active membership in, or a live invitation from,
--     the organization that owns the provider, AND whose email domain the
--     organization proved it controls (DNS TXT) AND while the organization's
--     switch is on and its provider is registered. Every other row is removed
--     by private.sso_unlink_ineligible (the sign-in lookup, the admin actions
--     and a ten-minute pg_cron sweep).
--   * Supabase custom OIDC providers are not used: they share the default
--     linking domain and would link any account with the same verified email
--     across every organization, which a tenant-controlled provider must
--     never be able to do.
--
-- Tables are RPC-only (RLS + the restrictive MFA floor, no client grants) and
-- declare no reference into the account case graph; the organization is
-- derived from the admin session or, for service RPCs, from the
-- admin-authorized route that called them.
--
-- Production stays empty: the only rows written are platform definitions.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Setting (W1-SETTINGS registry contract)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- No old flag: de7df4b57c^ had Google OAuth only (lib/union-ground/guide.ts:259)
  -- and no enterprise SAML. Effective old production behavior = off.
  ('features.security.sso', 'boolean', 'Single sign-on (SAML)',
   'Lets invited people and members sign in through your organization''s SAML identity provider. Email and password sign-in keeps working.',
   'false', null, null, null, 410, 'security', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.organization_sso_connections (
  organization_id uuid primary key,
  metadata_url text
    constraint organization_sso_connections_metadata_url_shape check (
      metadata_url is null or (pg_catalog.char_length(metadata_url) between 12 and 2000
        and metadata_url ~ '^https://[^[:space:]]+$')),
  metadata_xml text
    constraint organization_sso_connections_metadata_xml_bounded check (
      metadata_xml is null or (pg_catalog.char_length(metadata_xml) between 40 and 200000
        and pg_catalog.ltrim(metadata_xml) like '<%')),
  attribute_mapping jsonb not null default '{}'::jsonb
    constraint organization_sso_connections_mapping_object check (pg_catalog.jsonb_typeof(attribute_mapping) = 'object'),
  status text not null default 'draft'
    constraint organization_sso_connections_status check (status in ('draft', 'registered', 'error')),
  gotrue_provider_id uuid,
  idp_entity_id text
    constraint organization_sso_connections_entity_bounded check (
      idp_entity_id is null or pg_catalog.char_length(idp_entity_id) between 1 and 1024),
  needs_registration boolean not null default true,
  last_error_code text
    constraint organization_sso_connections_error_code check (
      last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{1,63}$'),
  registered_at timestamptz,
  last_test_status text
    constraint organization_sso_connections_test_status check (last_test_status is null or last_test_status in ('ok', 'failed')),
  last_test_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint organization_sso_connections_one_metadata check (metadata_url is null or metadata_xml is null)
);

create unique index organization_sso_connections_provider_key
  on public.organization_sso_connections (gotrue_provider_id) where gotrue_provider_id is not null;

comment on table public.organization_sso_connections is
  'One SAML identity-provider connection per organization. gotrue_provider_id is the Supabase Auth SSO provider registered by api/sso-admin.js; the organization switch features.security.sso, a verified domain and this row together decide whether private.sso_link_identity may link an account.';

create table public.organization_sso_domains (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  domain text not null
    constraint organization_sso_domains_domain_shape check (
      domain = pg_catalog.lower(domain)
      and pg_catalog.char_length(domain) between 4 and 253
      and domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  verification_token text not null
    constraint organization_sso_domains_token_shape check (verification_token ~ '^[0-9a-f]{32}$'),
  verified_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint organization_sso_domains_organization_domain_key unique (organization_id, domain)
);

-- A domain can be proven by one organization only.
create unique index organization_sso_domains_verified_domain_key
  on public.organization_sso_domains (domain) where verified_at is not null;

comment on table public.organization_sso_domains is
  'Email domains an organization claims for SAML sign-in. A domain counts only after api/sso-admin.js found the DNS TXT record _union-ground-sso.<domain> = union-ground-sso=<verification_token>; one organization per verified domain.';

alter table public.organization_sso_connections enable row level security;
alter table public.organization_sso_domains enable row level security;

create policy mfa_assurance on public.organization_sso_connections
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_sso_connections is
  'Restrictive floor shared by every MI1 table: no authenticated session below the MFA bar sees a row. There is no permissive policy and no client grant, so SSO connections are reachable only through the SECURITY DEFINER admin and service RPCs.';
create policy mfa_assurance on public.organization_sso_domains
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.organization_sso_domains is
  'Restrictive floor shared by every MI1 table: no authenticated session below the MFA bar sees a row. There is no permissive policy and no client grant, so SSO domains are reachable only through the SECURITY DEFINER admin and service RPCs.';

revoke all on public.organization_sso_connections from public, anon, authenticated;
revoke all on public.organization_sso_domains from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Private helpers
-- ---------------------------------------------------------------------------

create function private.sso_require_service()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.sso_require_service() from public, anon, authenticated, service_role;

create function private.sso_admin_organization(p_write boolean)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.mi1_require_integration_admin();
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_write and not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

revoke all on function private.sso_admin_organization(boolean) from public, anon, authenticated, service_role;

-- True when an account may be signed in by an organization's identity
-- provider: the account exists, is confirmed and live, its email domain is
-- verified for the organization, and it holds an active membership in, or a
-- live invitation from, that organization.
create function private.sso_account_eligible(p_organization_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from auth.users u
    join public.organization_sso_domains d
      on d.organization_id = p_organization_id
     and d.verified_at is not null
     and d.domain = pg_catalog.split_part(pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))), '@', 2)
    where u.id = p_user_id
      and u.deleted_at is null
      and u.email_confirmed_at is not null
      and coalesce(u.is_sso_user, false) = false
      and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
      and (
        exists (
          select 1 from public.organization_memberships om
          where om.organization_id = p_organization_id and om.user_id = u.id and om.status = 'active')
        or exists (
          select 1 from public.member_invitations i
          join public.chapters c on c.id = i.chapter_id and c.organization_id = p_organization_id
          where i.normalized_email = pg_catalog.lower(pg_catalog.btrim(u.email))
            and i.status in ('pending', 'accepting')
            and i.expires_at > pg_catalog.clock_timestamp())
      )
  );
$function$;

revoke all on function private.sso_account_eligible(uuid, uuid) from public, anon, authenticated, service_role;

-- The organization's live provider id, or null when SSO cannot sign anyone in.
create function private.sso_active_provider(p_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select c.gotrue_provider_id
  from public.organization_sso_connections c
  join public.organizations o on o.id = c.organization_id and o.status = 'active'
  where c.organization_id = p_organization_id
    and c.status = 'registered'
    and c.gotrue_provider_id is not null
    and private.organization_feature_enabled(p_organization_id, 'features.security.sso');
$function$;

revoke all on function private.sso_active_provider(uuid) from public, anon, authenticated, service_role;

-- Links (or keeps) the SAML identity of an eligible account. The SAML NameID
-- the identity provider sends must be the person's email address in lower
-- case; that is the identity GoTrue looks up.
create function private.sso_link_identity(p_organization_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
declare
  provider_uuid uuid;
  address text;
begin
  provider_uuid := private.sso_active_provider(p_organization_id);
  if provider_uuid is null or not private.sso_account_eligible(p_organization_id, p_user_id) then
    return false;
  end if;
  select pg_catalog.lower(pg_catalog.btrim(u.email)) into address from auth.users u where u.id = p_user_id;
  if exists (
    select 1 from auth.identities i
    where i.provider = 'sso:' || provider_uuid::text and i.provider_id = address and i.user_id <> p_user_id
  ) then
    -- The identity belongs to another account: never move it.
    return false;
  end if;
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (
    address, p_user_id,
    pg_catalog.jsonb_build_object('sub', address, 'email', address, 'email_verified', true,
      'linked_by', 'union_ground_sso'),
    'sso:' || provider_uuid::text, pg_catalog.now(), pg_catalog.now())
  on conflict (provider_id, provider) do nothing;
  return true;
end;
end;
$function$;

revoke all on function private.sso_link_identity(uuid, uuid) from public, anon, authenticated, service_role;

-- Removes SAML identities that may no longer sign anyone in: the provider is
-- not an active organization provider any more, or the account is no longer
-- eligible for that organization. GoTrue rewrites identity_data on every SAML
-- sign-in, so ownership is decided by the provider column: with signups
-- disabled, GoTrue cannot create an 'sso:' identity itself, and every one that
-- exists for a registered organization provider was linked here. Bounded and
-- idempotent. Returns the number of identities removed.
create function private.sso_unlink_ineligible(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
declare
  removed integer := 0;
begin
  with stale as (
    select i.id
    from auth.identities i
    join public.organization_sso_connections c
      on c.gotrue_provider_id is not null and i.provider = 'sso:' || c.gotrue_provider_id::text
    where (
        private.sso_active_provider(c.organization_id) is distinct from c.gotrue_provider_id
        or not private.sso_account_eligible(c.organization_id, i.user_id)
        or i.provider_id is distinct from (
          select pg_catalog.lower(pg_catalog.btrim(u.email)) from auth.users u where u.id = i.user_id)
      )
    limit greatest(1, least(coalesce(p_limit, 500), 5000))
  )
  delete from auth.identities i using stale where i.id = stale.id;
  get diagnostics removed = row_count;
  return removed;
end;
end;
$function$;

revoke all on function private.sso_unlink_ineligible(integer) from public, anon, authenticated, service_role;

comment on function private.sso_unlink_ineligible(integer) is
  'Bounded pg_cron target (sso-identity-link-sweep, every ten minutes) and admin-action follow-up: removes Union Ground-linked SAML identities whose organization switched SSO off, deregistered its provider, lost the email domain, or no longer holds the account as a member or invitee.';

create function private.sso_control_json(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'enabled', private.organization_feature_enabled(p_organization_id, 'features.security.sso'),
    'canManage', private.has_organization_role(p_organization_id, array['admin']),
    'active', private.sso_active_provider(p_organization_id) is not null,
    'connection', (
      select pg_catalog.jsonb_build_object(
        'metadataUrl', c.metadata_url,
        'hasMetadataXml', c.metadata_xml is not null,
        'attributeMapping', c.attribute_mapping,
        'status', c.status,
        'providerRegistered', c.gotrue_provider_id is not null,
        'needsRegistration', c.needs_registration,
        'idpEntityId', c.idp_entity_id,
        'registeredAt', c.registered_at,
        'lastErrorCode', c.last_error_code,
        'lastTestStatus', c.last_test_status,
        'lastTestAt', c.last_test_at)
      from public.organization_sso_connections c where c.organization_id = p_organization_id),
    'domains', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', d.id, 'domain', d.domain, 'verified', d.verified_at is not null,
        'verifiedAt', d.verified_at, 'lastCheckedAt', d.last_checked_at,
        'recordName', '_union-ground-sso.' || d.domain,
        'recordValue', 'union-ground-sso=' || d.verification_token
      ) order by d.domain)
      from public.organization_sso_domains d where d.organization_id = p_organization_id), '[]'::jsonb),
    'linkedAccounts', (
      select pg_catalog.count(*) from auth.identities i
      join public.organization_sso_connections c
        on c.organization_id = p_organization_id and 'sso:' || c.gotrue_provider_id::text = i.provider)
  );
$function$;

revoke all on function private.sso_control_json(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Admin RPCs (Integrations > Single sign-on)
-- ---------------------------------------------------------------------------

create function public.get_sso_control()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.sso_admin_organization(false);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.sso_control_json(org);
end;
$function$;

revoke all on function public.get_sso_control() from public, anon, authenticated, service_role;
grant execute on function public.get_sso_control() to authenticated;

comment on function public.get_sso_control() is
  'SAML single sign-on setup state for the caller''s organization (admin or vp, MFA): switch, connection, domains with their DNS verification record, and the number of linked accounts.';

create function public.save_sso_connection(p_metadata_url text, p_metadata_xml text, p_attribute_mapping jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
  clean_url text := nullif(pg_catalog.btrim(coalesce(p_metadata_url, '')), '');
  clean_xml text := nullif(pg_catalog.btrim(coalesce(p_metadata_xml, '')), '');
  mapping jsonb := coalesce(p_attribute_mapping, '{}'::jsonb);
  mapping_key text;
begin
  org := private.sso_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if (clean_url is null) = (clean_xml is null)
     or (clean_url is not null and (pg_catalog.char_length(clean_url) > 2000 or clean_url !~ '^https://[^[:space:]]+$'))
     or (clean_xml is not null and (pg_catalog.char_length(clean_xml) > 200000 or clean_xml not like '<%'))
     or pg_catalog.jsonb_typeof(mapping) <> 'object' then
    raise exception 'invalid sso connection' using errcode = '22023';
  end if;
  for mapping_key in select pg_catalog.jsonb_object_keys(mapping) loop
    if mapping_key not in ('email', 'givenName', 'familyName', 'displayName')
       or pg_catalog.jsonb_typeof(mapping -> mapping_key) <> 'string'
       or pg_catalog.char_length(mapping ->> mapping_key) not between 1 and 200
       or (mapping ->> mapping_key) ~ '[[:cntrl:]]' then
      raise exception 'invalid sso connection' using errcode = '22023';
    end if;
  end loop;
  insert into public.organization_sso_connections (organization_id, metadata_url, metadata_xml, attribute_mapping, status, needs_registration)
  values (org, clean_url, clean_xml, mapping, 'draft', true)
  on conflict (organization_id) do update
    set metadata_url = excluded.metadata_url,
        metadata_xml = excluded.metadata_xml,
        attribute_mapping = excluded.attribute_mapping,
        needs_registration = true,
        updated_at = pg_catalog.clock_timestamp();
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'sso_saml', 'action', 'connection_saved'));
  return private.sso_control_json(org);
end;
end;
$function$;

revoke all on function public.save_sso_connection(text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_sso_connection(text, text, jsonb) to authenticated;

create function public.add_sso_domain(p_domain text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
  clean_domain text := pg_catalog.lower(pg_catalog.rtrim(pg_catalog.btrim(coalesce(p_domain, '')), '.'));
begin
  org := private.sso_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_domain) not between 4 and 253
     or clean_domain !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' then
    raise exception 'invalid sso domain' using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from public.organization_sso_domains d where d.organization_id = org) >= 10 then
    raise exception 'too many sso domains' using errcode = 'P0001', detail = 'sso:domain_limit';
  end if;
  if exists (select 1 from public.organization_sso_domains d where d.domain = clean_domain and d.verified_at is not null and d.organization_id <> org) then
    raise exception 'sso domain verified elsewhere' using errcode = 'P0001', detail = 'sso:domain_taken';
  end if;
  insert into public.organization_sso_domains (organization_id, domain, verification_token)
  values (org, clean_domain, pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'))
  on conflict (organization_id, domain) do nothing;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'sso_saml', 'action', 'domain_added', 'host', clean_domain));
  return private.sso_control_json(org);
end;
end;
$function$;

revoke all on function public.add_sso_domain(text) from public, anon, authenticated, service_role;
grant execute on function public.add_sso_domain(text) to authenticated;

create function public.remove_sso_domain(p_domain_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
  removed public.organization_sso_domains%rowtype;
begin
  org := private.sso_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  delete from public.organization_sso_domains d
  where d.id = p_domain_id and d.organization_id = org
  returning d.* into removed;
  if removed.id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if removed.verified_at is not null then
    update public.organization_sso_connections
    set needs_registration = true, updated_at = pg_catalog.clock_timestamp()
    where organization_id = org;
  end if;
  perform private.sso_unlink_ineligible(5000);
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'sso_saml', 'action', 'domain_removed', 'host', removed.domain));
  return private.sso_control_json(org);
end;
end;
$function$;

revoke all on function public.remove_sso_domain(uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_sso_domain(uuid) to authenticated;

-- The payload api/sso-admin.js needs for a privileged step it performs with
-- the service key (DNS check, provider registration, test, removal). The
-- route calls this with the admin's own session first, so only an
-- organization admin with MFA ever starts one.
create function public.begin_sso_admin_action()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.sso_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'enabled', private.organization_feature_enabled(org, 'features.security.sso'),
    'connection', (
      select pg_catalog.jsonb_build_object(
        'metadataUrl', c.metadata_url,
        'metadataXml', c.metadata_xml,
        'attributeMapping', c.attribute_mapping,
        'providerId', c.gotrue_provider_id,
        'status', c.status)
      from public.organization_sso_connections c where c.organization_id = org),
    'domains', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', d.id, 'domain', d.domain, 'token', d.verification_token, 'verified', d.verified_at is not null)
        order by d.domain)
      from public.organization_sso_domains d where d.organization_id = org), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.begin_sso_admin_action() from public, anon, authenticated, service_role;
grant execute on function public.begin_sso_admin_action() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Service-role RPCs (api/sso-admin.js, api/sso-signin.js)
-- ---------------------------------------------------------------------------

create function public.record_sso_domain_check(p_organization_id uuid, p_domain_id uuid, p_verified boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  domain_row public.organization_sso_domains%rowtype;
begin
  perform private.sso_require_service();
  select * into domain_row from public.organization_sso_domains d
  where d.id = p_domain_id and d.organization_id = p_organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sso-domain:' || domain_row.domain, 509));
  if coalesce(p_verified, false) then
    if exists (select 1 from public.organization_sso_domains d
               where d.domain = domain_row.domain and d.verified_at is not null and d.id <> domain_row.id) then
      update public.organization_sso_domains set last_checked_at = pg_catalog.clock_timestamp() where id = domain_row.id;
      return pg_catalog.jsonb_build_object('outcome', 'taken');
    end if;
    update public.organization_sso_domains
    set verified_at = coalesce(verified_at, pg_catalog.clock_timestamp()), last_checked_at = pg_catalog.clock_timestamp()
    where id = domain_row.id;
    update public.organization_sso_connections
    set needs_registration = true, updated_at = pg_catalog.clock_timestamp()
    where organization_id = p_organization_id and domain_row.verified_at is null;
    return pg_catalog.jsonb_build_object('outcome', 'verified');
  end if;
  update public.organization_sso_domains set last_checked_at = pg_catalog.clock_timestamp() where id = domain_row.id;
  return pg_catalog.jsonb_build_object('outcome', case when domain_row.verified_at is null then 'not_found_in_dns' else 'kept' end);
end;
end;
$function$;

revoke all on function public.record_sso_domain_check(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.record_sso_domain_check(uuid, uuid, boolean) to service_role;

create function public.record_sso_registration(
  p_organization_id uuid,
  p_provider_id uuid,
  p_idp_entity_id text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
declare
  connection_row public.organization_sso_connections%rowtype;
begin
  perform private.sso_require_service();
  select * into connection_row from public.organization_sso_connections c
  where c.organization_id = p_organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  if connection_row.gotrue_provider_id is not null and connection_row.gotrue_provider_id is distinct from p_provider_id
     and p_provider_id is not null then
    -- A replaced provider leaves no identity behind.
    delete from auth.identities i where i.provider = 'sso:' || connection_row.gotrue_provider_id::text;
  end if;
  if p_provider_id is null then
    update public.organization_sso_connections
    set status = case when gotrue_provider_id is null then 'error' else status end,
        last_error_code = coalesce(nullif(p_error_code, ''), 'registration_failed'),
        updated_at = pg_catalog.clock_timestamp()
    where organization_id = p_organization_id;
    return pg_catalog.jsonb_build_object('outcome', 'failed');
  end if;
  update public.organization_sso_connections
  set gotrue_provider_id = p_provider_id,
      idp_entity_id = nullif(pg_catalog.left(coalesce(p_idp_entity_id, ''), 1024), ''),
      status = 'registered',
      needs_registration = false,
      last_error_code = null,
      registered_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id;
  return pg_catalog.jsonb_build_object('outcome', 'registered');
end;
end;
$function$;

revoke all on function public.record_sso_registration(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_sso_registration(uuid, uuid, text, text) to service_role;

create function public.record_sso_test(p_organization_id uuid, p_ok boolean, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
begin
  perform private.sso_require_service();
  update public.organization_sso_connections
  set last_test_status = case when coalesce(p_ok, false) then 'ok' else 'failed' end,
      last_test_at = pg_catalog.clock_timestamp(),
      last_error_code = case when coalesce(p_ok, false) then null else coalesce(nullif(p_error_code, ''), 'test_failed') end
  where organization_id = p_organization_id;
  return pg_catalog.jsonb_build_object('recorded', found);
end;
end;
$function$;

revoke all on function public.record_sso_test(uuid, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.record_sso_test(uuid, boolean, text) to service_role;

create function public.record_sso_deregistration(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
declare
  removed integer;
begin
  perform private.sso_require_service();
  delete from auth.identities i
  using public.organization_sso_connections c
  where c.organization_id = p_organization_id and c.gotrue_provider_id is not null
    and i.provider = 'sso:' || c.gotrue_provider_id::text;
  get diagnostics removed = row_count;
  update public.organization_sso_connections
  set gotrue_provider_id = null, idp_entity_id = null, status = 'draft', needs_registration = true,
      registered_at = null, last_test_status = null, last_test_at = null, last_error_code = null,
      updated_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id;
  return pg_catalog.jsonb_build_object('outcome', 'deregistered', 'unlinked', removed);
end;
end;
$function$;

revoke all on function public.record_sso_deregistration(uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_sso_deregistration(uuid) to service_role;

-- Sign-in discovery for api/sso-signin.js. Charges the network and address
-- buckets first, then answers the provider for a verified domain whose
-- organization has SSO on and a registered provider, and (re)links the
-- account behind the address when, and only when, it is eligible. The reply
-- never depends on whether the address has an account.
create function public.sso_signin_lookup(p_email text, p_network text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
declare
  address text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  network text := coalesce(p_network, '');
  org uuid;
  provider_uuid uuid;
  account uuid;
begin
  perform private.sso_require_service();
  if pg_catalog.char_length(address) not between 3 and 254
     or address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or network !~ '^(ipv4:[0-9]{1,3}(\.[0-9]{1,3}){3}|ipv6:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::/64|unknown)$' then
    raise exception 'invalid sso lookup' using errcode = '22023';
  end if;
  if not private.auth_attempt_check('sso-signin-network', network,
      private.organization_limit(null, 'limits.security.signin_attempts_per_ip_hour'), interval '1 hour')
     or not private.auth_attempt_check('sso-signin-email', address,
      private.organization_limit(null, 'limits.security.signin_attempts_per_email_hour'), interval '1 hour') then
    return pg_catalog.jsonb_build_object('limited', true);
  end if;
  select d.organization_id into org
  from public.organization_sso_domains d
  where d.domain = pg_catalog.split_part(address, '@', 2) and d.verified_at is not null;
  provider_uuid := case when org is null then null else private.sso_active_provider(org) end;
  if provider_uuid is null then
    return pg_catalog.jsonb_build_object('sso', false);
  end if;
  select u.id into account
  from auth.users u
  where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = address
    and coalesce(u.is_sso_user, false) = false
    and u.deleted_at is null
  order by u.created_at
  limit 1;
  if account is not null and not private.sso_link_identity(org, account) then
    delete from auth.identities i
    where i.provider = 'sso:' || provider_uuid::text and i.provider_id = address;
  end if;
  return pg_catalog.jsonb_build_object('sso', true, 'providerId', provider_uuid);
end;
end;
$function$;

revoke all on function public.sso_signin_lookup(text, text) from public, anon, authenticated, service_role;
grant execute on function public.sso_signin_lookup(text, text) to service_role;

comment on function public.sso_signin_lookup(text, text) is
  'Service role only (api/sso-signin.js). Charges the platform sign-in network/address buckets, resolves a verified SSO domain to its organization''s live SAML provider and links the address''s account only when it holds an active membership in, or a live invitation from, that organization. Never creates an account; the reply does not reveal whether one exists.';

-- ---------------------------------------------------------------------------
-- 6. Sweep schedule
-- ---------------------------------------------------------------------------

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'sso-identity-link-sweep';
  perform cron.schedule('sso-identity-link-sweep', '*/10 * * * *', 'select private.sso_unlink_ineligible(500)');
end;
$block$;

-- ---------------------------------------------------------------------------
-- 7. Job health: sso-identity-link-sweep joins the four copies of the
-- monitored set (the job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20260930040000 with only that name added.
-- ---------------------------------------------------------------------------

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent',
    'ballot-notices-tick', 'casework-alert-escalation-tick',
    'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick',
    'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick',
    'deadline-notices-tick', 'dues-reminders-dispatch-tick',
    'dues-stripe-reconcile-tick', 'event-checkin-token-retention',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'issue-intelligence-weekly-digest', 'live-poll-schedule-tick',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention',
    'notifications-dispatch-tick', 'notifications-expiry-sweep',
    'organization-automation-tick', 'organization-claim-retention',
    'sso-identity-link-sweep', 'survey-operations-sweep',
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
      'casework-alert-escalation-tick', 'casework-deadline-reminder-tick',
      'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick',
      'casework-ulp-deadline-tick', 'deadline-notices-tick',
      'event-checkin-token-retention', 'event-notices-tick',
      'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest',
      'live-poll-schedule-tick', 'member-messaging-dispatch',
      'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'organization-claim-retention', 'sso-identity-link-sweep',
      'survey-operations-sweep', 'task-files-reconcile-tick',
      'task-maintenance-daily', 'union-ground-organization-retention',
      'weekly-question-selection-tick', 'workload-reminders-tick'
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
      'ballot-choices-mix', 'ballot-choices-mix-recent',
      'ballot-notices-tick', 'casework-alert-escalation-tick',
      'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick',
      'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick',
      'deadline-notices-tick', 'dues-reminders-dispatch-tick',
      'dues-stripe-reconcile-tick', 'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'issue-intelligence-weekly-digest', 'live-poll-schedule-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention',
      'notifications-dispatch-tick', 'notifications-expiry-sweep',
      'organization-automation-tick', 'organization-claim-retention',
      'sso-identity-link-sweep', 'survey-operations-sweep',
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

notify pgrst, 'reload schema';

commit;
