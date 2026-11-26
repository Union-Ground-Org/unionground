-- REQ-UG-SCIM-PROVISIONING-20261001
--
-- Restore-everything campaign, (: SCIM
-- directory sync is back in scope as an unset activation). The "SaaS
-- ship-complete bar" keeps it inside the Invitation-only accounts contract:
-- SCIM provisions through invitations and deprovisioning revokes memberships.
--
-- Old app: de7df4b57c^:supabase/migrations/0752_integration_registry.sql:63-75
-- (scim_tokens with expiry/revocation, issued from
-- app/dashboard/admin/integrations/registry-actions.ts:300-353, 90-day tokens)
-- shipped token custody only; it never served a SCIM endpoint. CR-094 kept the
-- custody model behind SCIM_SHIP_GATE = 'disabled_enterprise_later'
-- (src/features/integrations/scim.js). There was no switch, so this lane
-- registers features.integrations.scim with default OFF: the old effective
-- production behavior was "no directory sync", and activation stays the
-- customer's choice.
--
-- What this migration adds (served by api/scim.js under /scim/v2):
--   * three settings: features.integrations.scim (off), and the per-token
--     request rate and per-organization daily invitation budget;
--   * scim_tokens gains a label, display prefix, expiry, revocation and last
--     use. Only the SHA-256 digest of a token is stored; the plaintext is shown
--     once in the browser that generated it, as for customer API keys;
--   * public.scim_users / scim_groups / scim_group_members: the directory the
--     identity provider pushes. organization_id is derived from the token by
--     the service RPCs and is deliberately not a foreign key, so these mirror
--     tables stay outside the account case graph: they reference no account
--     and no membership row. Every person-affecting write goes through the
--     existing invitation and membership tables under their own locks;
--   * provisioning (private.scim_reconcile_user):
--       - no account yet  -> an ordinary 'provision' invitation into the
--         organization's SCIM default chapter, emailed by api/scim.js through
--         the same Resend path and accept link as an admin invitation;
--       - a REVOKED former member of this organization who is active nowhere
--         -> a 'reactivation' invitation (the 20260927100000 path);
--       - an active member here -> linked, nothing is created;
--       - anything else (an account in another organization, an invitation
--         from another organization) -> needs_admin; nothing is created;
--     The starting role is null unless an organization ADMIN mapped one of
--     the person's SCIM groups to steward, coordinator or advisor. SCIM never
--     grants admin or vp and never changes an existing member's roles;
--   * deprovisioning (active=false or DELETE) revokes pending invitations for
--     the address in this organization and revokes the organization
--     membership with the same writes as public.revoke_member_chapter_membership
--     (chapter memberships, chapter roles, the organization membership, the
--     selected chapter), refusing the organization's last admin. The account
--     itself is never deleted or suspended: account lifecycle stays the
--     member's own;
--   * admin RPCs (organization admin + MFA; vp may read) and service-role RPCs
--     for the endpoint. The token RPC charges private.auth_attempt_check per
--     token per minute.
--
-- Production stays empty: the only rows written are platform definitions.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Settings (W1-SETTINGS registry contract)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- No old flag: de7df4b57c^ shipped SCIM token custody only (0752:63-75) and
  -- CR-094 kept SCIM_SHIP_GATE = 'disabled_enterprise_later'. Effective old
  -- production behavior = off.
  ('features.integrations.scim', 'boolean', 'SCIM directory provisioning',
   'Lets your identity provider invite, update and deprovision members through the SCIM 2.0 endpoint using an organization token.',
   'false', null, null, null, 310, 'integrations', false),
  -- New bound (no old endpoint existed): two requests a second per token.
  ('limits.integrations.scim_requests_per_minute', 'integer', 'SCIM requests per minute',
   'Most SCIM requests one token may make in a minute before the endpoint answers 429 and the provider retries.',
   '120', 10, 1200, null, 320, 'integrations', false),
  -- New bound: the admin desk allows 50 invitations per chapter per day.
  ('limits.integrations.scim_invitations_per_day', 'integer', 'SCIM invitations per day',
   'Most invitations SCIM provisioning may send for the organization in one day. Later requests wait for the next day.',
   '200', 1, 2000, null, 330, 'integrations', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Token custody and the SCIM provider row
-- ---------------------------------------------------------------------------

do $empty_custody$
begin
  -- No path ever inserted a row (comment of 20260822020000). Refuse to bolt
  -- an expiry onto a token whose origin nobody can explain.
  if exists (select 1 from public.scim_tokens) then
    raise exception 'scim_tokens is expected to be empty before SCIM provisioning ships';
  end if;
end;
$empty_custody$;

alter table public.scim_tokens
  add column label text not null
    constraint scim_tokens_label_bounded check (
      pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 80 and label !~ '[[:cntrl:]]'),
  add column token_prefix text not null
    constraint scim_tokens_prefix_shape check (token_prefix ~ '^ug_scim_[0-9a-f]{4}$'),
  add column expires_at timestamptz not null,
  add column revoked_at timestamptz,
  add column last_used_at timestamptz;

create unique index scim_tokens_token_hash_key on public.scim_tokens (token_hash);
create index scim_tokens_organization_created_idx on public.scim_tokens (organization_id, created_at desc);

comment on table public.scim_tokens is
  'Organization-scoped SCIM bearer tokens. Only the SHA-256 digest is stored; the plaintext is shown once to the issuing organization admin. Written only by public.issue_scim_token / public.revoke_scim_token and read by the service-role public.scim_authenticate.';

-- SCIM used to be pinned to status 'disabled'. Its row now records the
-- organization's SCIM default chapter and whether a live token exists.
alter table public.organization_integrations
  drop constraint organization_integrations_scim_disabled;

-- ---------------------------------------------------------------------------
-- 3. Directory mirror tables
-- ---------------------------------------------------------------------------

create table public.scim_users (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  user_name text not null
    constraint scim_users_user_name_shape check (
      user_name = pg_catalog.lower(pg_catalog.btrim(user_name))
      and pg_catalog.char_length(user_name) between 3 and 254
      and user_name ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  external_id text
    constraint scim_users_external_id_bounded check (
      external_id is null or (pg_catalog.char_length(external_id) between 1 and 255 and external_id !~ '[[:cntrl:]]')),
  given_name text
    constraint scim_users_given_name_bounded check (
      given_name is null or (pg_catalog.char_length(given_name) between 1 and 80 and given_name !~ '[[:cntrl:]]')),
  family_name text
    constraint scim_users_family_name_bounded check (
      family_name is null or (pg_catalog.char_length(family_name) between 1 and 80 and family_name !~ '[[:cntrl:]]')),
  display_name text
    constraint scim_users_display_name_bounded check (
      display_name is null or (pg_catalog.char_length(display_name) between 1 and 120 and display_name !~ '[[:cntrl:]]')),
  active boolean not null default true,
  locale text not null default 'en' constraint scim_users_locale check (locale in ('en', 'es')),
  provisioning_state text not null default 'pending'
    constraint scim_users_provisioning_state check (provisioning_state in (
      'pending', 'invited', 'active', 'reactivation_invited', 'needs_admin', 'deprovisioned')),
  state_reason text
    constraint scim_users_state_reason check (state_reason is null or state_reason in (
      'account_in_other_organization', 'invited_elsewhere', 'last_organization_admin',
      'no_default_chapter', 'user_name_changed')),
  invitation_id uuid,
  -- Immutable account identity; retained even after Auth deletes the account.
  -- No Auth FK: the directory mirror is outside the account/case graph.
  auth_user_id uuid,
  version integer not null default 1 constraint scim_users_version_positive check (version >= 1),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint scim_users_organization_user_name_key unique (organization_id, user_name)
);

create index scim_users_organization_external_id_idx
  on public.scim_users (organization_id, external_id) where external_id is not null;
create index scim_users_organization_state_idx
  on public.scim_users (organization_id, provisioning_state);

comment on table public.scim_users is
  'Directory mirror of the people an organization''s identity provider pushed over SCIM. userName is the invitation address. Rows reference no account: provisioning acts through member_invitations and the membership tables. organization_id is derived from the bearer token by service-role RPCs and carries no declared reference (organizations are never deleted).';

create table public.scim_groups (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  display_name text not null
    constraint scim_groups_display_name_bounded check (
      pg_catalog.char_length(pg_catalog.btrim(display_name)) between 1 and 120 and display_name !~ '[[:cntrl:]]'),
  external_id text
    constraint scim_groups_external_id_bounded check (
      external_id is null or (pg_catalog.char_length(external_id) between 1 and 255 and external_id !~ '[[:cntrl:]]')),
  mapped_role text
    constraint scim_groups_mapped_role check (mapped_role is null or mapped_role in ('steward', 'coordinator', 'advisor')),
  version integer not null default 1 constraint scim_groups_version_positive check (version >= 1),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp()
);

-- SCIM advertises caseExact:false for Group.displayName. Preserve spelling
-- for display while enforcing the same case-insensitive equality as filters.
create unique index scim_groups_organization_display_name_key
  on public.scim_groups (organization_id, pg_catalog.lower(display_name));

comment on table public.scim_groups is
  'SCIM groups pushed by the identity provider. mapped_role is written only by an organization admin (public.set_scim_group_role); the provider can never set it, so a group grants no staff role unless an admin mapped one.';
comment on column public.scim_groups.mapped_role is
  'Starting role for new SCIM invitations of this group''s members (steward, coordinator or advisor). Null grants nothing. Admin-only writer.';

create table public.scim_group_members (
  group_id uuid not null,
  user_id uuid not null,
  organization_id uuid not null,
  primary key (group_id, user_id)
);

create index scim_group_members_user_idx on public.scim_group_members (user_id);

comment on table public.scim_group_members is
  'SCIM group membership as pushed by the identity provider. Both ends belong to the same organization (checked by the service RPC that writes it); the user and group delete RPCs remove their rows here, so the mirror declares no reference into the account case graph.';

alter table public.scim_users enable row level security;
alter table public.scim_groups enable row level security;
alter table public.scim_group_members enable row level security;

create policy mfa_assurance on public.scim_users
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.scim_users is
  'Restrictive floor shared by every MI1 table: no authenticated session below the MFA bar sees a row. There is no permissive policy and no client grant, so the SCIM directory is reachable only through the SECURITY DEFINER admin and service RPCs.';
create policy mfa_assurance on public.scim_groups
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.scim_groups is
  'Restrictive floor shared by every MI1 table: no authenticated session below the MFA bar sees a row. There is no permissive policy and no client grant, so SCIM groups are reachable only through the SECURITY DEFINER admin and service RPCs.';
create policy mfa_assurance on public.scim_group_members
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.scim_group_members is
  'Restrictive floor shared by every MI1 table: no authenticated session below the MFA bar sees a row. There is no permissive policy and no client grant, so SCIM group membership is reachable only through the SECURITY DEFINER admin and service RPCs.';

revoke all on public.scim_users from public, anon, authenticated;
revoke all on public.scim_groups from public, anon, authenticated;
revoke all on public.scim_group_members from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Private helpers
-- ---------------------------------------------------------------------------

create function private.scim_require_service()
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

revoke all on function private.scim_require_service() from public, anon, authenticated, service_role;

-- Integration-plane guard (admin or vp, MFA). Writes demand organization admin.
create function private.scim_admin_organization(p_write boolean)
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

revoke all on function private.scim_admin_organization(boolean) from public, anon, authenticated, service_role;

create function private.scim_default_chapter(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select c.id
  from public.organization_integrations i
  join public.chapters c
    on c.id = i.default_settings ->> 'defaultChapterId'
   and c.organization_id = i.organization_id
  where i.organization_id = p_organization_id
    and i.provider = 'scim';
$function$;

revoke all on function private.scim_default_chapter(uuid) from public, anon, authenticated, service_role;

create function private.scim_mapped_role(p_scim_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  -- Highest of the mapped roles in the product's staff order
  -- (steward < coordinator < advisor; admin and vp are never mappable).
  select g.mapped_role
  from public.scim_group_members m
  join public.scim_groups g on g.id = m.group_id
  where m.user_id = p_scim_user_id and g.mapped_role is not null
  order by pg_catalog.array_position(array['steward', 'coordinator', 'advisor'], g.mapped_role) desc
  limit 1;
$function$;

revoke all on function private.scim_mapped_role(uuid) from public, anon, authenticated, service_role;

create function private.scim_user_json(p_row public.scim_users)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'externalId', p_row.external_id,
    'userName', p_row.user_name,
    'givenName', p_row.given_name,
    'familyName', p_row.family_name,
    'displayName', p_row.display_name,
    'active', p_row.active,
    'locale', p_row.locale,
    'state', p_row.provisioning_state,
    'stateReason', p_row.state_reason,
    'version', p_row.version,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at
  );
$function$;

revoke all on function private.scim_user_json(public.scim_users) from public, anon, authenticated, service_role;

create function private.scim_group_json(p_row public.scim_groups, p_include_members boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'externalId', p_row.external_id,
    'displayName', p_row.display_name,
    'version', p_row.version,
    'createdAt', p_row.created_at,
    'updatedAt', p_row.updated_at,
    'members', case when p_include_members then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'value', u.id,
        'display', coalesce(u.display_name, u.user_name)
      ) order by u.user_name)
      from public.scim_group_members m
      join public.scim_users u on u.id = m.user_id and u.organization_id = p_row.organization_id
      where m.group_id = p_row.id
    ), '[]'::jsonb) else null end
  );
$function$;

revoke all on function private.scim_group_json(public.scim_groups, boolean) from public, anon, authenticated, service_role;

-- Revokes one account's membership in one organization with the writes of
-- public.revoke_member_chapter_membership (20260822010000, installed with the
-- case-graph and message-lifecycle preamble), applied to every active chapter
-- of that organization. member_admin_audit attributes rows through a human
-- actor (assign_member_admin_audit_organization refuses an actorless tenant
-- row) and organization_audit_events requires one, so the tenant record of a
-- SCIM deprovision is one actorless organization_audit_ledger row
-- (membership.scim_deprovisioned, reasonCode scim_deprovision, the number of
-- chapters revoked), the same system-actor shape scheduled retention uses. Returns 'revoked', 'not_member' or
-- 'last_organization_admin' (the organization's only admin is never removed).
create function private.scim_revoke_organization_membership(p_organization_id uuid, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
declare
  chapter_row record;
  replacement_chapter text;
  revoked_chapters integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || p_organization_id::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || p_user_id::text, 0));

  if not exists (
    select 1 from public.organization_memberships om
    where om.organization_id = p_organization_id and om.user_id = p_user_id
  ) then
    -- An unlinked address in another tenant grants no authority over its sessions.
    return 'not_member';
  end if;

  if exists (select 1 from public.organization_memberships m
       where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active')
     and exists (
       select 1 from public.organization_role_grants g
       where g.organization_id = p_organization_id and g.user_id = p_user_id and g.role = 'admin'
     )
     and (
       select pg_catalog.count(*) from public.organization_role_grants g
       join public.organization_memberships m on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
       where g.organization_id = p_organization_id and g.role = 'admin'
     ) <= 1 then
    return 'last_organization_admin';
  end if;

  for chapter_row in
    select m.chapter_id
    from public.member_chapter_memberships m
    join public.chapters c on c.id = m.chapter_id
    where m.user_id = p_user_id and m.status = 'active' and c.organization_id = p_organization_id
    order by m.chapter_id
  loop
    revoked_chapters := revoked_chapters + 1;
    update public.member_chapter_memberships
    set status = 'revoked', revoked_at = pg_catalog.clock_timestamp(), pinned = false
    where user_id = p_user_id and chapter_id = chapter_row.chapter_id and status = 'active';
    delete from public.member_role_chapters
    where user_id = p_user_id and chapter_id = chapter_row.chapter_id;
  end loop;

  delete from public.member_roles r
  where r.user_id = p_user_id and r.chapter_id is not null
    and exists (select 1 from public.chapters c where c.id = r.chapter_id and c.organization_id = p_organization_id)
    and not exists (
      select 1 from public.member_role_chapters rc
      where rc.user_id = r.user_id and rc.role = r.role
    );

  delete from public.organization_role_grants
  where organization_id = p_organization_id and user_id = p_user_id;
  delete from public.member_roles r
  where r.user_id = p_user_id and r.chapter_id is null
    and not exists (select 1 from public.organization_role_grants g
      join public.organization_memberships m on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
      where g.user_id = r.user_id and g.role = r.role);

  -- Auth's own statement trigger takes its bookkeeping lock after the graph gate.
  delete from auth.sessions where user_id = p_user_id;
  delete from private.member_pin_sessions where user_id = p_user_id;

  update public.organization_memberships
  set status = 'revoked', revoked_at = pg_catalog.clock_timestamp()
  where organization_id = p_organization_id and user_id = p_user_id and status = 'active';

  if exists (
    select 1 from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    where p.id = p_user_id and c.organization_id = p_organization_id
  ) then
    select m.chapter_id into replacement_chapter
    from public.member_chapter_memberships m
    where m.user_id = p_user_id and m.status = 'active'
    order by m.last_selected_at desc nulls last, m.joined_at, m.chapter_id
    limit 1;
    update public.member_profiles set chapter_id = replacement_chapter where id = p_user_id;
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'membership', 'membership.scim_deprovisioned', 'revoke', null,
    'membership', p_user_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('organizationId', p_organization_id, 'userId', p_user_id,
      'status', 'revoked', 'reasonCode', 'scim_deprovision', 'count', revoked_chapters)
  );
  return 'revoked';
end;
end;
$function$;

revoke all on function private.scim_revoke_organization_membership(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Withdraws every open (pending) invitation for one address in one
-- organization, with the content-free audit row the admin desk writes.
create function private.scim_revoke_pending_invitations(p_organization_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  revoked_row public.member_invitations%rowtype;
begin
  for revoked_row in
    update public.member_invitations i
    set status = 'revoked', token_hash = null, revoked_at = pg_catalog.clock_timestamp()
    where i.normalized_email = p_email
      and i.status = 'pending'
      and i.chapter_id in (select c.id from public.chapters c where c.organization_id = p_organization_id)
    returning i.*
  loop
    perform private.audit_member_invitation(
      revoked_row.id, revoked_row.chapter_id, null, 'invite_revoked',
      pg_catalog.jsonb_build_object('chapterId', revoked_row.chapter_id, 'source', 'scim'));
  end loop;
end;
end;
$function$;

revoke all on function private.scim_revoke_pending_invitations(uuid, text) from public, anon, authenticated, service_role;

-- Brings one SCIM user to its provisioned state. Returns the invitation the
-- endpoint must email ({send:true,...}) or {send:false}.
create function private.scim_reconcile_user(p_scim_user_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  scim_row public.scim_users%rowtype;
  account uuid;
  default_chapter text;
  mapped text;
  live_invitation public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
  invitation_row public.member_invitations%rowtype;
  profile_row public.member_profiles%rowtype;
  outcome text;
  clean_hash text;
  full_name text;
  first_name text;
  initials text;
  next_state text;
  next_reason text;
  result jsonb := '{"send": false}'::jsonb;
begin
  select * into scim_row from public.scim_users where id = p_scim_user_id for update;
  if not found then
    raise exception 'scim user not found' using errcode = 'P0002';
  end if;
  clean_hash := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || scim_row.user_name, 509));

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = scim_row.user_name
      and status = 'pending'
      and expires_at <= pg_catalog.clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, null, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version, 'source', 'scim'));
  end loop;

  account := scim_row.auth_user_id;
  if account is null and scim_row.invitation_id is not null then
    select i.auth_user_id into account from public.member_invitations i
    where i.id = scim_row.invitation_id
      and i.chapter_id in (select c.id from public.chapters c where c.organization_id = scim_row.organization_id);
  end if;
  if account is null then
    select u.id into account from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = scim_row.user_name
      and u.deleted_at is null
    order by u.is_sso_user, u.created_at limit 1;
  end if;
  if account is not null then
    if not exists (select 1 from auth.users u where u.id = account and u.deleted_at is null) then
      raise exception 'scim bound account unavailable' using errcode = '23514';
    end if;
    if scim_row.auth_user_id is null and exists (
      select 1 from public.organization_memberships m
      where m.organization_id = scim_row.organization_id and m.user_id = account
    ) then
      update public.scim_users set auth_user_id = account where id = scim_row.id;
      scim_row.auth_user_id := account;
    end if;
  end if;

  if scim_row.active and scim_row.state_reason = 'user_name_changed'
     and (account is null or not exists (select 1 from auth.users u
       where u.id = account and pg_catalog.lower(pg_catalog.btrim(u.email)) = scim_row.user_name)) then
    -- Sticky until the member's sign-in address matches the new userName.
    return result;
  end if;

  if not scim_row.active then
    -- Deprovision: no live invitation for this address may remain in this
    -- organization, and the membership is revoked.
    perform private.scim_revoke_pending_invitations(scim_row.organization_id, scim_row.user_name);
    if account is null and (scim_row.state_reason = 'user_name_changed'
       or scim_row.provisioning_state in ('active', 'reactivation_invited')) then
      raise exception 'scim account binding unresolved' using errcode = '23514';
    end if;
    if account is not null then
      perform private.scim_revoke_pending_invitations(scim_row.organization_id,
        (select pg_catalog.lower(u.email) from auth.users u where u.id = account));
    end if;
    next_state := 'deprovisioned';
    next_reason := null;
    if account is not null then
      outcome := private.scim_revoke_organization_membership(scim_row.organization_id, account);
      if outcome = 'last_organization_admin' then
        raise exception 'last organization admin cannot be deprovisioned' using errcode = '23514';
      end if;
      if exists (select 1 from public.organization_memberships m
        where m.organization_id = scim_row.organization_id and m.user_id = account and m.status = 'active') then
        raise exception 'scim account deprovisioning incomplete' using errcode = '23514';
      end if;
    end if;
    update public.scim_users
    set provisioning_state = next_state, state_reason = next_reason
    where id = scim_row.id;
    return result;
  end if;

  if account is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member-chapter:' || account::text, 0));
    if exists (
      select 1 from public.organization_memberships om
      where om.organization_id = scim_row.organization_id and om.user_id = account and om.status = 'active'
    ) then
      update public.scim_users set provisioning_state = 'active', state_reason = null where id = scim_row.id;
      return result;
    end if;
  end if;

  select i.* into live_invitation
  from public.member_invitations i
  where i.normalized_email = scim_row.user_name and i.status in ('pending', 'accepting')
  order by i.created_at desc
  limit 1;
  if found then
    if exists (
      select 1 from public.chapters c
      where c.id = live_invitation.chapter_id and c.organization_id = scim_row.organization_id
    ) then
      -- An invitation this endpoint issued is still open: keep its starting
      -- role in line with the admin's current group mapping until it is used.
      if live_invitation.id = scim_row.invitation_id
         and live_invitation.status = 'pending'
         and live_invitation.kind = 'provision' then
        mapped := private.scim_mapped_role(scim_row.id);
        if live_invitation.initial_role is distinct from mapped then
          update public.member_invitations set initial_role = mapped where id = live_invitation.id;
        end if;
      end if;
      update public.scim_users
      set provisioning_state = case when live_invitation.kind = 'reactivation' then 'reactivation_invited' else 'invited' end,
          state_reason = null,
          invitation_id = live_invitation.id
      where id = scim_row.id;
    else
      update public.scim_users
      set provisioning_state = 'needs_admin', state_reason = 'invited_elsewhere'
      where id = scim_row.id;
    end if;
    return result;
  end if;

  default_chapter := private.scim_default_chapter(scim_row.organization_id);
  if default_chapter is null then
    update public.scim_users
    set provisioning_state = 'needs_admin', state_reason = 'no_default_chapter'
    where id = scim_row.id;
    return result;
  end if;

  if account is not null then
    -- Reactivation only for a REVOKED former member of this organization who
    -- is active nowhere (the 20260927100000 eligibility); anything else is an
    -- account this endpoint must not touch.
    select * into profile_row from public.member_profiles p where p.id = account;
    if profile_row.id is null
       or not exists (
         select 1 from public.organization_memberships om
         where om.organization_id = scim_row.organization_id and om.user_id = account and om.status = 'revoked')
       or exists (
         select 1 from public.organization_memberships other
         where other.user_id = account and other.status = 'active') then
      update public.scim_users
      set provisioning_state = 'needs_admin', state_reason = 'account_in_other_organization'
      where id = scim_row.id;
      return result;
    end if;
  end if;

  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invitation token required' using errcode = '22023';
  end if;
  if not private.auth_attempt_check('scim-invitations', scim_row.organization_id::text,
      private.organization_limit(scim_row.organization_id, 'limits.integrations.scim_invitations_per_day'),
      interval '1 day') then
    raise exception 'scim invitation limit' using errcode = 'P0001', detail = 'scim:invitation_limit';
  end if;

  if account is not null then
    insert into public.member_invitations
      (normalized_email, full_name, first_name, initials, chapter_id,
       initial_role, locale, token_hash, status, delivery_version, invited_by,
       expires_at, kind)
    values
      (scim_row.user_name, profile_row.full_name, profile_row.first_name, profile_row.initials, default_chapter,
       null, scim_row.locale, clean_hash, 'pending', 1, null,
       pg_catalog.clock_timestamp() + interval '15 minutes', 'reactivation')
    returning * into invitation_row;
    perform private.audit_member_invitation(
      invitation_row.id, default_chapter, null, 'reinvite_requested',
      pg_catalog.jsonb_build_object('chapterId', default_chapter, 'organizationId', scim_row.organization_id,
        'deliveryVersion', invitation_row.delivery_version, 'source', 'scim'));
    next_state := 'reactivation_invited';
  else
    full_name := coalesce(
      nullif(scim_row.display_name, ''),
      nullif(pg_catalog.btrim(coalesce(scim_row.given_name, '') || ' ' || coalesce(scim_row.family_name, '')), ''),
      pg_catalog.split_part(scim_row.user_name, '@', 1));
    if pg_catalog.char_length(full_name) < 2 then
      full_name := pg_catalog.rpad(full_name, 2, '.');
    end if;
    full_name := pg_catalog.left(full_name, 120);
    first_name := pg_catalog.left(coalesce(nullif(scim_row.given_name, ''),
      (pg_catalog.regexp_split_to_array(full_name, '[[:space:]]+'))[1]), 80);
    initials := pg_catalog.upper(
      pg_catalog.left(first_name, 1)
      || coalesce(pg_catalog.left(nullif(scim_row.family_name, ''), 1), ''));
    mapped := private.scim_mapped_role(scim_row.id);
    insert into public.member_invitations
      (normalized_email, full_name, first_name, initials, chapter_id,
       initial_role, locale, token_hash, status, delivery_version, invited_by,
       expires_at, kind)
    values
      (scim_row.user_name, full_name, first_name, initials, default_chapter,
       mapped, scim_row.locale, clean_hash, 'pending', 1, null,
       pg_catalog.clock_timestamp() + interval '15 minutes', 'provision')
    returning * into invitation_row;
    perform private.audit_member_invitation(
      invitation_row.id, default_chapter, null, 'invite_requested',
      pg_catalog.jsonb_build_object('chapterId', default_chapter, 'initialRole', mapped,
        'locale', scim_row.locale, 'deliveryVersion', invitation_row.delivery_version, 'source', 'scim'));
    next_state := 'invited';
  end if;

  update public.scim_users
  set provisioning_state = next_state, state_reason = null, invitation_id = invitation_row.id
  where id = scim_row.id;

  return pg_catalog.jsonb_build_object(
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'email', invitation_row.normalized_email,
    'locale', invitation_row.locale
  );
end;
end;
$function$;

revoke all on function private.scim_reconcile_user(uuid, text) from public, anon, authenticated, service_role;

-- Keeps the provider row honest: configured while a live token and a default
-- chapter exist, unset otherwise. Call after taking the case-graph gate.
create function private.scim_refresh_provider_status(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  update public.organization_integrations i
  set status = case
        when private.scim_default_chapter(p_organization_id) is not null
          and exists (
            select 1 from public.scim_tokens t
            where t.organization_id = p_organization_id and t.revoked_at is null
              and t.expires_at > pg_catalog.clock_timestamp())
        then 'configured' else 'unset' end,
      updated_at = pg_catalog.now()
  where i.organization_id = p_organization_id and i.provider = 'scim';
end;
$function$;

revoke all on function private.scim_refresh_provider_status(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Admin RPCs (Integrations > SCIM)
-- ---------------------------------------------------------------------------

create function public.get_scim_control()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  org := private.scim_admin_organization(false);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'enabled', private.organization_feature_enabled(org, 'features.integrations.scim'),
    'canManage', private.has_organization_role(org, array['admin']),
    'defaultChapterId', private.scim_default_chapter(org),
    'requestsPerMinute', private.organization_limit(org, 'limits.integrations.scim_requests_per_minute'),
    'invitationsPerDay', private.organization_limit(org, 'limits.integrations.scim_invitations_per_day'),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
      from public.chapters c where c.organization_id = org
    ), '[]'::jsonb),
    'tokens', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'label', t.label, 'tokenPrefix', t.token_prefix, 'createdAt', t.created_at,
        'expiresAt', t.expires_at, 'revokedAt', t.revoked_at, 'lastUsedAt', t.last_used_at
      ) order by t.created_at desc)
      from (select * from public.scim_tokens t where t.organization_id = org order by t.created_at desc limit 20) t
    ), '[]'::jsonb),
    'groups', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'displayName', g.display_name, 'mappedRole', g.mapped_role,
        'memberCount', (select pg_catalog.count(*) from public.scim_group_members m where m.group_id = g.id)
      ) order by g.display_name)
      from (select * from public.scim_groups g where g.organization_id = org order by g.display_name limit 200) g
    ), '[]'::jsonb),
    'users', (
      select pg_catalog.jsonb_build_object(
        'total', pg_catalog.count(*),
        'invited', pg_catalog.count(*) filter (where u.provisioning_state = 'invited'),
        'active', pg_catalog.count(*) filter (where u.provisioning_state = 'active'),
        'reactivationInvited', pg_catalog.count(*) filter (where u.provisioning_state = 'reactivation_invited'),
        'needsAdmin', pg_catalog.count(*) filter (where u.provisioning_state = 'needs_admin'),
        'deprovisioned', pg_catalog.count(*) filter (where u.provisioning_state = 'deprovisioned'))
      from public.scim_users u where u.organization_id = org
    ),
    'attention', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'userName', u.user_name, 'stateReason', u.state_reason, 'updatedAt', u.updated_at
      ) order by u.updated_at desc)
      from (select * from public.scim_users u
            where u.organization_id = org and u.provisioning_state = 'needs_admin'
            order by u.updated_at desc limit 25) u
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_scim_control() from public, anon, authenticated, service_role;
grant execute on function public.get_scim_control() to authenticated;

comment on function public.get_scim_control() is
  'SCIM setup state for the caller''s organization (admin or vp, MFA): the switch, default chapter, token metadata (never digests), groups with their admin-mapped roles, provisioning counts and the people that need an admin.';

create function public.save_scim_settings(p_default_chapter_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
begin
  org := private.scim_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.chapters c where c.id = p_default_chapter_id and c.organization_id = org
  ) then
    raise exception 'chapter outside organization' using errcode = '22023';
  end if;
  insert into public.organization_integrations (organization_id, provider, status, default_settings)
  values (org, 'scim', 'unset', pg_catalog.jsonb_build_object('defaultChapterId', p_default_chapter_id))
  on conflict (organization_id, provider) do update
    set default_settings = pg_catalog.jsonb_build_object('defaultChapterId', p_default_chapter_id),
        updated_at = pg_catalog.now();
  perform private.scim_refresh_provider_status(org);
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'scim', 'chapterId', p_default_chapter_id, 'action', 'default_chapter_set'));
  return public.get_scim_control();
end;
end;
$function$;

revoke all on function public.save_scim_settings(text) from public, anon, authenticated, service_role;
grant execute on function public.save_scim_settings(text) to authenticated;

create function public.issue_scim_token(
  p_label text,
  p_token_hash text,
  p_token_prefix text,
  p_expires_in_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
begin
  org := private.scim_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.integrations.scim') then
    raise exception 'scim provisioning is switched off' using errcode = 'P0001', detail = 'scim:switched_off';
  end if;
  if private.scim_default_chapter(org) is null then
    raise exception 'scim default chapter required' using errcode = 'P0001', detail = 'scim:no_default_chapter';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_label, ''))) not between 1 and 80
     or p_label ~ '[[:cntrl:]]'
     or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_token_prefix, '') !~ '^ug_scim_[0-9a-f]{4}$'
     or p_expires_in_days is null or p_expires_in_days not between 1 and 365 then
    raise exception 'invalid scim token' using errcode = '22023';
  end if;
  if (select pg_catalog.count(*) from public.scim_tokens t
      where t.organization_id = org and t.revoked_at is null and t.expires_at > pg_catalog.clock_timestamp()) >= 5 then
    raise exception 'too many live scim tokens' using errcode = 'P0001', detail = 'scim:token_limit';
  end if;
  insert into public.scim_tokens (organization_id, token_hash, label, token_prefix, expires_at)
  values (org, p_token_hash, pg_catalog.btrim(p_label), p_token_prefix,
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(days => p_expires_in_days));
  perform private.scim_refresh_provider_status(org);
  perform private.mi1_write_tenant_audit(org, 'integration_api_key_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'scim', 'status', 'created', 'name', pg_catalog.btrim(p_label)));
  return public.get_scim_control();
end;
end;
$function$;

revoke all on function public.issue_scim_token(text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.issue_scim_token(text, text, text, integer) to authenticated;

create function public.revoke_scim_token(p_token_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
begin
  org := private.scim_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  update public.scim_tokens
  set revoked_at = pg_catalog.clock_timestamp()
  where id = p_token_id and organization_id = org and revoked_at is null;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform private.scim_refresh_provider_status(org);
  perform private.mi1_write_tenant_audit(org, 'integration_api_key_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'scim', 'status', 'revoked'));
  return public.get_scim_control();
end;
end;
$function$;

revoke all on function public.revoke_scim_token(uuid) from public, anon, authenticated, service_role;
grant execute on function public.revoke_scim_token(uuid) to authenticated;

create function public.set_scim_group_role(p_group_id uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())]::uuid[], array[]::uuid[]);
declare
  org uuid;
  member_row record;
begin
  org := private.scim_admin_organization(true);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_role is not null and p_role not in ('steward', 'coordinator', 'advisor') then
    raise exception 'unsupported role' using errcode = '22023';
  end if;
  update public.scim_groups
  set mapped_role = p_role, updated_at = pg_catalog.clock_timestamp()
  where id = p_group_id and organization_id = org;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- Re-align the starting role of open SCIM invitations of this group.
  for member_row in
    select u.id from public.scim_group_members m
    join public.scim_users u on u.id = m.user_id and u.organization_id = org
    where m.group_id = p_group_id and u.provisioning_state = 'invited' and u.active
  loop
    perform private.scim_reconcile_user(member_row.id, null);
  end loop;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'scim', 'action', 'group_role_mapped', 'role', coalesce(p_role, 'none'),
    'entityId', p_group_id));
  return public.get_scim_control();
end;
end;
$function$;

revoke all on function public.set_scim_group_role(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_scim_group_role(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Service-role RPCs for api/scim.js
-- ---------------------------------------------------------------------------

create function public.scim_authenticate(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  token_row public.scim_tokens%rowtype;
begin
  perform private.scim_require_service();
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select t.* into token_row
  from public.scim_tokens t
  join public.organizations o on o.id = t.organization_id and o.status = 'active'
  where t.token_hash = p_token_hash
    and t.revoked_at is null
    and t.expires_at > pg_catalog.clock_timestamp();
  if not found then
    return null;
  end if;
  if not private.organization_feature_enabled(token_row.organization_id, 'features.integrations.scim') then
    return pg_catalog.jsonb_build_object('state', 'disabled');
  end if;
  if not private.auth_attempt_check('scim-token', token_row.id::text,
      private.organization_limit(token_row.organization_id, 'limits.integrations.scim_requests_per_minute'),
      interval '1 minute') then
    return pg_catalog.jsonb_build_object('state', 'limited');
  end if;
  if token_row.last_used_at is null or token_row.last_used_at < pg_catalog.clock_timestamp() - interval '1 minute' then
    update public.scim_tokens set last_used_at = pg_catalog.clock_timestamp() where id = token_row.id;
  end if;
  return pg_catalog.jsonb_build_object(
    'state', 'ok',
    'organizationId', token_row.organization_id,
    'tokenId', token_row.id
  );
end;
end;
$function$;

revoke all on function public.scim_authenticate(text) from public, anon, authenticated, service_role;
grant execute on function public.scim_authenticate(text) to service_role;

comment on function public.scim_authenticate(text) is
  'Service role only (api/scim.js). Resolves a SCIM bearer-token digest to its organization when the token is live, the organization active and features.integrations.scim on, and charges the per-token request budget. Returns null for an unknown token, {state:disabled} or {state:limited}.';

create function public.scim_list_users(
  p_organization_id uuid,
  p_field text,
  p_value text,
  p_start_index integer,
  p_count integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  start_at integer := greatest(coalesce(p_start_index, 1), 1);
  page integer := least(greatest(coalesce(p_count, 100), 0), 200);
begin
  perform private.scim_require_service();
  if p_field is not null and p_field not in ('userName', 'externalId', 'id') then
    raise exception 'unsupported filter' using errcode = '22023';
  end if;
  return (
    with matched as (
      select u.*
      from public.scim_users u
      where u.organization_id = p_organization_id
        and (p_field is null
          or (p_field = 'userName' and u.user_name = pg_catalog.lower(pg_catalog.btrim(coalesce(p_value, ''))))
          or (p_field = 'externalId' and u.external_id = p_value)
          or (p_field = 'id' and u.id::text = pg_catalog.lower(coalesce(p_value, ''))))
    )
    select pg_catalog.jsonb_build_object(
      'totalResults', (select pg_catalog.count(*) from matched),
      'items', coalesce((
        select pg_catalog.jsonb_agg(private.scim_user_json(page_rows) order by page_rows.created_at, page_rows.id)
        from (select * from matched order by created_at, id offset start_at - 1 limit page) page_rows
      ), '[]'::jsonb))
  );
end;
$function$;

revoke all on function public.scim_list_users(uuid, text, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.scim_list_users(uuid, text, text, integer, integer) to service_role;

create function public.scim_get_user(p_organization_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_row public.scim_users%rowtype;
begin
  perform private.scim_require_service();
  select * into found_row from public.scim_users u
  where u.id = p_user_id and u.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  return private.scim_user_json(found_row);
end;
$function$;

revoke all on function public.scim_get_user(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.scim_get_user(uuid, uuid) to service_role;

-- Create (p_user_id null) or replace a User. p_user carries the normalized
-- fields api/_lib/scim.js produced; p_token_hash is the digest of the
-- invitation secret the endpoint will email if an invitation is created.
create function public.scim_upsert_user(
  p_organization_id uuid,
  p_user_id uuid,
  p_user jsonb,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  user_row public.scim_users%rowtype;
  clean_name text;
  invitation jsonb;
  created boolean := false;
  renamed_account boolean := false;
begin
  perform private.scim_require_service();
  if p_user is null or pg_catalog.jsonb_typeof(p_user) <> 'object' then
    raise exception 'invalid scim user' using errcode = '22023';
  end if;
  clean_name := pg_catalog.lower(pg_catalog.btrim(coalesce(p_user ->> 'userName', '')));
  if p_user_id is null then
    if exists (select 1 from public.scim_users u
               where u.organization_id = p_organization_id and u.user_name = clean_name) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    insert into public.scim_users
      (organization_id, user_name, external_id, given_name, family_name, display_name, active, locale)
    values
      (p_organization_id, clean_name, nullif(p_user ->> 'externalId', ''), nullif(p_user ->> 'givenName', ''),
       nullif(p_user ->> 'familyName', ''), nullif(p_user ->> 'displayName', ''),
       coalesce((p_user ->> 'active')::boolean, true),
       case when p_user ->> 'locale' = 'es' then 'es' else 'en' end)
    returning * into user_row;
    created := true;
  else
    select * into user_row from public.scim_users u
    where u.id = p_user_id and u.organization_id = p_organization_id
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if clean_name <> user_row.user_name and exists (
      select 1 from public.scim_users u
      where u.organization_id = p_organization_id and u.user_name = clean_name and u.id <> user_row.id) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if user_row.auth_user_id is null then
      perform private.scim_reconcile_user(user_row.id, null);
      select * into user_row from public.scim_users where id = user_row.id;
    end if;
    if clean_name <> user_row.user_name then
      if user_row.provisioning_state = 'invited' then
        -- Nobody accepted yet: the old address's open invitation is withdrawn
        -- and the new address is invited below.
        perform private.scim_revoke_pending_invitations(p_organization_id, user_row.user_name);
      elsif user_row.provisioning_state in ('active', 'reactivation_invited') then
        -- An account already holds the old address. SCIM never rewrites a
        -- sign-in address or invites a second account for the same person:
        -- an admin moves the address (sign-in recovery), after which the next
        -- sync matches the account again.
        renamed_account := true;
      end if;
    end if;
    update public.scim_users
    set provisioning_state = case when renamed_account then 'needs_admin' else provisioning_state end,
        state_reason = case when renamed_account then 'user_name_changed' else state_reason end,
        user_name = clean_name,
        external_id = nullif(p_user ->> 'externalId', ''),
        given_name = nullif(p_user ->> 'givenName', ''),
        family_name = nullif(p_user ->> 'familyName', ''),
        display_name = nullif(p_user ->> 'displayName', ''),
        active = coalesce((p_user ->> 'active')::boolean, true),
        locale = case when p_user ->> 'locale' = 'es' then 'es' else 'en' end,
        invitation_id = case when clean_name <> user_row.user_name then null else invitation_id end,
        version = version + 1,
        updated_at = pg_catalog.clock_timestamp()
    where id = user_row.id
    returning * into user_row;
  end if;
  invitation := private.scim_reconcile_user(user_row.id, p_token_hash);
  select * into user_row from public.scim_users where id = user_row.id;
  return pg_catalog.jsonb_build_object(
    'outcome', case when created then 'created' else 'updated' end,
    'user', private.scim_user_json(user_row),
    'invitation', invitation);
end;
end;
$function$;

revoke all on function public.scim_upsert_user(uuid, uuid, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.scim_upsert_user(uuid, uuid, jsonb, text) to service_role;

create function public.scim_delete_user(p_organization_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  user_row public.scim_users%rowtype;
begin
  perform private.scim_require_service();
  select * into user_row from public.scim_users u
  where u.id = p_user_id and u.organization_id = p_organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('deleted', false);
  end if;
  update public.scim_users set active = false where id = user_row.id;
  perform private.scim_reconcile_user(user_row.id, null);
  select * into user_row from public.scim_users where id = user_row.id;
  if user_row.provisioning_state = 'needs_admin' then
    -- The organization's only admin is kept; the directory row stays so the
    -- admin desk shows why the deprovision did not complete.
    return pg_catalog.jsonb_build_object('deleted', false, 'reason', user_row.state_reason);
  end if;
  delete from public.scim_group_members where user_id = user_row.id;
  delete from public.scim_users where id = user_row.id;
  return pg_catalog.jsonb_build_object('deleted', true);
end;
end;
$function$;

revoke all on function public.scim_delete_user(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.scim_delete_user(uuid, uuid) to service_role;

create function public.scim_list_groups(
  p_organization_id uuid,
  p_field text,
  p_value text,
  p_start_index integer,
  p_count integer,
  p_include_members boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  start_at integer := greatest(coalesce(p_start_index, 1), 1);
  page integer := least(greatest(coalesce(p_count, 100), 0), 200);
begin
  perform private.scim_require_service();
  if p_field is not null and p_field not in ('displayName', 'externalId', 'id') then
    raise exception 'unsupported filter' using errcode = '22023';
  end if;
  return (
    with matched as (
      select g.*
      from public.scim_groups g
      where g.organization_id = p_organization_id
        and (p_field is null
          or (p_field = 'displayName' and pg_catalog.lower(g.display_name) = pg_catalog.lower(p_value))
          or (p_field = 'externalId' and g.external_id = p_value)
          or (p_field = 'id' and g.id::text = pg_catalog.lower(coalesce(p_value, ''))))
    )
    select pg_catalog.jsonb_build_object(
      'totalResults', (select pg_catalog.count(*) from matched),
      'items', coalesce((
        select pg_catalog.jsonb_agg(private.scim_group_json(page_rows, coalesce(p_include_members, true))
          order by page_rows.created_at, page_rows.id)
        from (select * from matched order by created_at, id offset start_at - 1 limit page) page_rows
      ), '[]'::jsonb))
  );
end;
$function$;

revoke all on function public.scim_list_groups(uuid, text, text, integer, integer, boolean) from public, anon, authenticated, service_role;
grant execute on function public.scim_list_groups(uuid, text, text, integer, integer, boolean) to service_role;

create function public.scim_get_group(p_organization_id uuid, p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_row public.scim_groups%rowtype;
begin
  perform private.scim_require_service();
  select * into found_row from public.scim_groups g
  where g.id = p_group_id and g.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  return private.scim_group_json(found_row, true);
end;
$function$;

revoke all on function public.scim_get_group(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.scim_get_group(uuid, uuid) to service_role;

-- Create (p_group_id null) or replace a Group including its full member list.
-- Membership changes re-align open SCIM invitations of the affected people;
-- they never change an existing member's roles.
create function public.scim_upsert_group(
  p_organization_id uuid,
  p_group_id uuid,
  p_display_name text,
  p_external_id text,
  p_members uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  group_row public.scim_groups%rowtype;
  clean_name text := null;
  wanted uuid[];
  affected uuid;
  created boolean := false;
begin
  perform private.scim_require_service();
  clean_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  if pg_catalog.char_length(clean_name) not between 1 and 120 or clean_name ~ '[[:cntrl:]]'
     or pg_catalog.cardinality(coalesce(p_members, array[]::uuid[])) > 5000 then
    raise exception 'invalid scim group' using errcode = '22023';
  end if;
  select coalesce(pg_catalog.array_agg(distinct m), array[]::uuid[]) into wanted
  from pg_catalog.unnest(coalesce(p_members, array[]::uuid[])) m;
  if exists (
    select 1 from pg_catalog.unnest(wanted) m
    where not exists (select 1 from public.scim_users u where u.id = m and u.organization_id = p_organization_id)
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'unknown_member');
  end if;
  if p_group_id is null then
    if exists (select 1 from public.scim_groups g
               where g.organization_id = p_organization_id and pg_catalog.lower(g.display_name) = pg_catalog.lower(clean_name)) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    insert into public.scim_groups (organization_id, display_name, external_id)
    values (p_organization_id, clean_name, nullif(pg_catalog.btrim(coalesce(p_external_id, '')), ''))
    returning * into group_row;
    created := true;
  else
    select * into group_row from public.scim_groups g
    where g.id = p_group_id and g.organization_id = p_organization_id
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('outcome', 'not_found');
    end if;
    if exists (select 1 from public.scim_groups g
               where g.organization_id = p_organization_id and pg_catalog.lower(g.display_name) = pg_catalog.lower(clean_name) and g.id <> group_row.id) then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    update public.scim_groups
    set display_name = clean_name,
        external_id = nullif(pg_catalog.btrim(coalesce(p_external_id, '')), ''),
        version = version + 1,
        updated_at = pg_catalog.clock_timestamp()
    where id = group_row.id
    returning * into group_row;
  end if;

  for affected in
    select m.user_id from public.scim_group_members m
    where m.group_id = group_row.id and not (m.user_id = any (wanted))
    union
    select w from pg_catalog.unnest(wanted) w
    where not exists (select 1 from public.scim_group_members m where m.group_id = group_row.id and m.user_id = w)
  loop
    if affected = any (wanted) then
      insert into public.scim_group_members (group_id, user_id, organization_id)
      values (group_row.id, affected, p_organization_id)
      on conflict do nothing;
    else
      delete from public.scim_group_members where group_id = group_row.id and user_id = affected;
    end if;
    if group_row.mapped_role is not null and exists (
      select 1 from public.scim_users u where u.id = affected and u.provisioning_state = 'invited' and u.active
    ) then
      perform private.scim_reconcile_user(affected, null);
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', case when created then 'created' else 'updated' end,
    'group', private.scim_group_json(group_row, true));
end;
end;
$function$;

revoke all on function public.scim_upsert_group(uuid, uuid, text, text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.scim_upsert_group(uuid, uuid, text, text, uuid[]) to service_role;

create function public.scim_delete_group(p_organization_id uuid, p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  group_row public.scim_groups%rowtype;
  affected uuid;
begin
  perform private.scim_require_service();
  select * into group_row from public.scim_groups g
  where g.id = p_group_id and g.organization_id = p_organization_id
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('deleted', false);
  end if;
  for affected in
    delete from public.scim_group_members m where m.group_id = group_row.id returning m.user_id
  loop
    if group_row.mapped_role is not null and exists (
      select 1 from public.scim_users u where u.id = affected and u.provisioning_state = 'invited' and u.active
    ) then
      perform private.scim_reconcile_user(affected, null);
    end if;
  end loop;
  delete from public.scim_groups where id = group_row.id;
  return pg_catalog.jsonb_build_object('deleted', true);
end;
end;
$function$;

revoke all on function public.scim_delete_group(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.scim_delete_group(uuid, uuid) to service_role;

-- The service-role analogue of public.record_member_invitation_delivery for
-- invitations this endpoint created (invited_by is null and a SCIM user in
-- the same organization points at the invitation).
create function public.scim_record_invitation_delivery(
  p_organization_id uuid,
  p_invitation_id uuid,
  p_delivery_version integer,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  invitation_row public.member_invitations%rowtype;
begin
  perform private.scim_require_service();
  if p_outcome not in ('sent', 'failed') then
    raise exception 'invalid delivery outcome' using errcode = '22023';
  end if;
  select i.* into invitation_row
  from public.member_invitations i
  join public.chapters c on c.id = i.chapter_id and c.organization_id = p_organization_id
  where i.id = p_invitation_id
    and i.delivery_version = p_delivery_version
    and i.invited_by is null
    and exists (select 1 from public.scim_users u
                where u.organization_id = p_organization_id and u.invitation_id = i.id)
  for update of i;
  if not found or invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;
  if p_outcome = 'sent' then
    update public.member_invitations set sent_at = pg_catalog.clock_timestamp() where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_sent',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version, 'source', 'scim'));
  else
    update public.member_invitations
    set status = 'delivery_failed', token_hash = null,
        expires_at = pg_catalog.clock_timestamp(), failure_code = 'provider_unavailable'
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_delivery_failed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version, 'failureClass', 'provider_unavailable',
        'source', 'scim'));
  end if;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
end;
$function$;

revoke all on function public.scim_record_invitation_delivery(uuid, uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.scim_record_invitation_delivery(uuid, uuid, integer, text) to service_role;

notify pgrst, 'reload schema';

-- Link at invitation acceptance, before an address change can sever identity.
create function private.scim_bind_accepted_invitation()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[new.auth_user_id], array[]::uuid[]);
  if new.auth_user_id is not null and new.status = 'accepted' then
    update public.scim_users u set auth_user_id = new.auth_user_id, provisioning_state = 'active', state_reason = null
    where u.invitation_id = new.id and u.auth_user_id is null
      and u.active and u.organization_id = (select c.organization_id from public.chapters c where c.id = new.chapter_id);
  end if;
  return null;
end;
$function$;
revoke all on function private.scim_bind_accepted_invitation() from public, anon, authenticated, service_role;
create trigger scim_bind_accepted_invitation after update of status, auth_user_id on public.member_invitations
for each row execute function private.scim_bind_accepted_invitation();

-- The acceptance trigger changes only an active, previously unbound SCIM
-- directory row. A referential SET NULL cannot bind an identity; deletion
-- leaves the immutable Auth UUID in the directory for an explicit error.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'public'
  and s.table_name = 'member_invitations' and s.object_name = 'scim_bind_accepted_invitation')
  or (s.kind = 'function' and s.schema_name = 'private'
  and s.object_name = 'scim_bind_accepted_invitation()')
on conflict do nothing;

do $assert_scim_binding_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after SCIM identity binding';
  end if;
end
$assert_scim_binding_review$;

commit;
