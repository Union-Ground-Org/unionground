-- SEC-UG-OPEN-SIGNUP-TENANT-BOUNDARY-20260925
--
-- Self-created organizations start unverified and walled off.
--
-- (2026-09-25), confirmed on 2026-09-29 with signup kept
-- closed until the owner opens the signup period, lets a signed-in person
-- with a confirmed email and no organization create one. This file adds the
-- database half:
--
--   * a verification state on public.organizations: self_serve_created_at is
--     set only by public.create_my_organization, verified_at only by the later
--     verification writer. Operator-provisioned organizations (bootstrap,
--     seeders) keep both null and count as verified.
--     private.organization_clears_signup_boundary(uuid) is the one predicate
--     for this boundary; a null or unknown id does not clear it. It is
--     separate from 20260930040000's private.organization_is_verified(uuid)
--     (the catalog claim's verified mark), which this file leaves unchanged
--     and calls: a self-created organization whose claim is verified clears
--     the boundary (: verification only unlocks);
--   * public.create_my_organization writes the same seven shell rows as
--     bootstrap_first_organization, in the same order, plus one
--     organization_audit_ledger row with ids only. The slug and the default
--     chapter id are generated here, never supplied by the client. The
--     organization name is the only free text; the default chapter takes it
--     and follows the same name rules. Refusals
--     that must be counted (name taken, limits) return a status instead of
--     raising, so the limiter charge commits; a name collision never exposes
--     unique-violation detail. bootstrap_first_organization is unchanged;
--   * one trigger function, private.enforce_unverified_organization_boundary,
--     on the binding, handshake, coordination, network, directory, chapter
--     connection profile and hide, public site, dues-provider and invitation
--     tables. It covers RPC and direct
--     writes alike, so no hash-pinned RPC is re-emitted. An unverified
--     organization keeps everything inside its own walls and nothing that
--     reaches another organization, the public or payments; its invitations
--     are capped at 20 per 24 hours and 200 in total;
--   * three read conjuncts: directory discovery of other organizations, other
--     organizations' verified registry bindings and other chapters' published
--     connection profiles need a verified viewer;
--   * public.request_chapter_connection_handshake, re-emitted, answers an
--     unverified organization with the not-onboarded refusal before the
--     connection registry is read;
--   * public.set_chapter_connection_hidden, re-emitted, refuses an unverified
--     organization's hide before the target's publication is read;
--   * public.request_chapter_handshake, re-emitted, answers an unverified
--     organization's staff with the not-onboarded refusal before any
--     registry binding is read;
--   * private.open_signup_period, the switch that keeps signup closed until
--     the owner opens it. Until then
--     create_my_organization answers closed and the route limiter raises;
--   * private.open_signup_limits, a hashed fixed-window limiter, with two
--     service-role RPCs for the server signup route. It holds 64-hex hashes
--     only, is pruned opportunistically on later limiter calls (rows older
--     than 2 days, up to 200 per call) and has no Auth identity column.
--
-- The column addition itself (self_serve_created_at, verified_at and their
-- check) ships in 20260930040100_self_serve_organization_shell_column.sql,
-- which applies first in its own short transaction; this file starts with
-- the column comments.
--
-- GoTrue signup stays disabled; accounts come only from the server route.
-- public.grant_member_chapter_membership is not re-emitted here: since
-- 20260927100000 it already admits only an active member of the chapter's
-- organization, so a grant never brings anyone into an organization.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

comment on column public.organizations.self_serve_created_at is
  'Set only by public.create_my_organization. Null for operator-provisioned organizations, which count as verified.';
comment on column public.organizations.verified_at is
  'Set only by the Phase 3a verification writer. Null means a self-created organization is unverified.';

create function private.organization_clears_signup_boundary(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_organization_id is not null and exists (
    select 1 from public.organizations o
    where o.id = p_organization_id
      and (o.self_serve_created_at is null
           or o.verified_at is not null
           or private.organization_is_verified(o.id)));
$function$;

revoke all on function private.organization_clears_signup_boundary(uuid)
  from public, anon, authenticated, service_role;
-- The chapter_union_org_bindings read policy evaluates this predicate as the
-- invoking role, so authenticated keeps EXECUTE (the private schema is not
-- exposed through the API).
grant execute on function private.organization_clears_signup_boundary(uuid) to authenticated;

comment on function private.organization_clears_signup_boundary(uuid) is
  'True for operator-provisioned organizations and for self-created organizations once verified (verified_at set, or a verified catalog claim per private.organization_is_verified); false for unverified self-created organizations and for a null or unknown id.';

-- ---------------------------------------------------------------------------
-- Signup period: closed until the owner opens it
-- ---------------------------------------------------------------------------

-- Owner decision (2026-09-29): open signup is built, but it stays closed until
-- the owner opens the signup period. One row holds the opening time. No row,
-- a null opens_at or an opens_at still in the future means closed. There is
-- no client grant; the owner opens or closes it with SQL
create table private.open_signup_period (
  singleton boolean primary key default true check (singleton),
  opens_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now()
);

alter table private.open_signup_period enable row level security;
alter table private.open_signup_period force row level security;
revoke all on private.open_signup_period from public, anon, authenticated, service_role;

comment on table private.open_signup_period is
  'Open signup switch: signup is open only once the single row has an opens_at at or before now. No row means closed. No client grant; changed only with SQL by the owner.';

create function private.open_signup_is_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select p.opens_at <= pg_catalog.now() from private.open_signup_period p where p.singleton),
    false);
$function$;

revoke all on function private.open_signup_is_open()
  from public, anon, authenticated, service_role;

comment on function private.open_signup_is_open() is
  'True once the owner has opened the signup period (private.open_signup_period.opens_at at or before now). Not executable by any client role.';

-- ---------------------------------------------------------------------------
-- Hashed limiter for the server signup route and organization creation
-- ---------------------------------------------------------------------------

create table private.open_signup_limits (
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in
    ('network-hour', 'network-day', 'email-day', 'confirm-network-hour', 'user-create-day')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope_hash, operation)
);

alter table private.open_signup_limits enable row level security;
alter table private.open_signup_limits force row level security;
revoke all on private.open_signup_limits from public, anon, authenticated, service_role;

comment on table private.open_signup_limits is
  'Fixed-window counters for open signup and organization creation. Scopes are 64-hex hashes only. Rows are pruned opportunistically on later limiter calls (rows older than 2 days, up to 200 per call). No client grant; written only by private.consume_open_signup_limit_internal.';

create function private.consume_open_signup_limit_internal(p_scope_hash text, p_operation text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  max_requests integer;
  window_length interval;
  current_row private.open_signup_limits%rowtype;
begin
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid signup limit' using errcode = '22023';
  end if;
  case coalesce(p_operation, '')
    when 'network-hour' then
      max_requests := 5;
      window_length := interval '1 hour';
    when 'network-day' then
      max_requests := 20;
      window_length := interval '24 hours';
    when 'email-day' then
      max_requests := 3;
      window_length := interval '24 hours';
    when 'confirm-network-hour' then
      max_requests := 10;
      window_length := interval '1 hour';
    when 'user-create-day' then
      max_requests := 3;
      window_length := interval '24 hours';
    else
      raise exception 'invalid signup limit' using errcode = '22023';
  end case;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('open-signup-limit:' || p_scope_hash || ':' || p_operation, 509));

  delete from private.open_signup_limits stale
  where stale.ctid in (
    select old.ctid from private.open_signup_limits old
    where old.window_started_at < pg_catalog.now() - interval '2 days'
    limit 200);

  select * into current_row
  from private.open_signup_limits l
  where l.scope_hash = p_scope_hash and l.operation = p_operation
  for update;

  if not found then
    insert into private.open_signup_limits (scope_hash, operation, window_started_at, request_count)
    values (p_scope_hash, p_operation, pg_catalog.now(), 1);
    return true;
  end if;

  if current_row.window_started_at <= pg_catalog.now() - window_length then
    update private.open_signup_limits l
    set window_started_at = pg_catalog.now(), request_count = 1
    where l.scope_hash = p_scope_hash and l.operation = p_operation;
    return true;
  end if;

  if current_row.request_count >= max_requests then
    return false;
  end if;

  update private.open_signup_limits l
  set request_count = l.request_count + 1
  where l.scope_hash = p_scope_hash and l.operation = p_operation;
  return true;
end;
$function$;

revoke all on function private.consume_open_signup_limit_internal(text, text)
  from public, anon, authenticated, service_role;

comment on function private.consume_open_signup_limit_internal(text, text) is
  'Charges one request against a fixed-window open signup limit (limits fixed per operation). Returns false when the window is full. Not executable by any client role.';

create function public.consume_open_signup_limit(p_scope_hash text, p_operation text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_operation is not distinct from 'user-create-day' then
    raise exception 'invalid signup limit' using errcode = '22023';
  end if;
  -- Both signup routes call this first, so a closed period answers them
  -- before any budget is charged or any address is looked up.
  if not private.open_signup_is_open() then
    raise exception 'signup closed' using errcode = '55000';
  end if;
  return private.consume_open_signup_limit_internal(p_scope_hash, p_operation);
end;
$function$;

revoke all on function public.consume_open_signup_limit(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_open_signup_limit(text, text) to service_role;

comment on function public.consume_open_signup_limit(text, text) is
  'Service-role limiter for the server signup route (network and email scopes, hashed by the caller). Raises signup closed (55000) until the owner opens the signup period. Organization creation limits are not reachable through it.';

create function public.open_signup_email_available(p_email_hash text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  clean_hash text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  clean_hash := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email_hash, '')));
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid email hash' using errcode = '22023';
  end if;
  return not exists (
    select 1 from auth.users u
    where u.email is not null
      and pg_catalog.encode(
        extensions.digest(pg_catalog.lower(pg_catalog.btrim(u.email)), 'sha256'), 'hex') = clean_hash
  ) and not exists (
    select 1 from public.member_invitations i
    where i.status in ('pending', 'accepting')
      and pg_catalog.encode(extensions.digest(i.normalized_email, 'sha256'), 'hex') = clean_hash
  );
end;
$function$;

revoke all on function public.open_signup_email_available(text)
  from public, anon, authenticated, service_role;
grant execute on function public.open_signup_email_available(text) to service_role;

comment on function public.open_signup_email_available(text) is
  'Service-role check for the server signup route: false when the hashed address already has an account or a pending invitation.';

-- ---------------------------------------------------------------------------
-- Self-serve organization shell
-- ---------------------------------------------------------------------------

create function public.create_my_organization(
  p_name text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid;
  clean_name text;
  new_slug text;
  new_chapter text;
  org_id uuid;
  user_scope text;
  replay record;
begin
  caller := (select auth.uid());
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.users u
    where u.id = caller
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and not coalesce(u.is_anonymous, false)
      and (u.banned_until is null or u.banned_until <= pg_catalog.now())
  ) then
    raise exception 'email confirmation required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.member_profiles p where p.id = caller) then
    raise exception 'account not ready' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- A replay runs before the membership check: the first call made the
  -- caller a member of the new organization.
  select l.event_type, l.actor_user_id, l.organization_id, l.metadata ->> 'chapterId' as chapter_id
    into replay
    from public.organization_audit_ledger l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.event_type = 'organization_self_created' and replay.actor_user_id = caller then
      return pg_catalog.jsonb_build_object(
        'status', 'created',
        'organizationId', replay.organization_id,
        'chapterId', replay.chapter_id,
        'slug', (select o.slug from public.organizations o where o.id = replay.organization_id),
        'idempotent', true);
    end if;
    raise exception 'idempotency key reused' using errcode = '22023';
  end if;

  -- Nothing is created until the owner opens the signup period. Not a
  -- counted outcome: it charges no limit.
  if not private.open_signup_is_open() then
    return pg_catalog.jsonb_build_object('status', 'closed');
  end if;

  if exists (
    select 1 from public.organization_memberships om
    where om.user_id = caller and om.status = 'active'
  ) then
    raise exception 'organization membership exists' using errcode = '22023';
  end if;

  -- The organization name is the only free text at signup; the default
  -- chapter takes the same name and is renamed later in the setup review.
  -- Other organizations can see it, so it follows the rules the Phase 4a
  -- placement applies to an unlisted parent name. Collapse every whitespace
  -- run to one space first, then trim, so a tab or newline at either end
  -- never survives into the stored name.
  clean_name := pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.normalize(coalesce(p_name, ''), 'NFKC'), '[[:space:]]+', ' ', 'g'));
  if pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_name !~ '[[:alnum:]]'
     -- Invisible and format characters (zero-width, bidirectional controls,
     -- variation selectors, fillers) never appear in a name.
     or clean_name ~ '[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]'
     or pg_catalog.strpos(clean_name, '@') > 0
     or pg_catalog.strpos(clean_name, '://') > 0
     or pg_catalog.regexp_replace(clean_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}' then
    raise exception 'invalid organization' using errcode = '22023';
  end if;

  -- Counted outcomes return a status instead of raising, so the charge
  -- commits with the call.
  user_scope := pg_catalog.encode(
    extensions.digest('open-signup-user:' || caller::text, 'sha256'), 'hex');
  if not private.consume_open_signup_limit_internal(user_scope, 'user-create-day') then
    return pg_catalog.jsonb_build_object('status', 'limit_reached');
  end if;

  if exists (
    select 1 from public.organizations o
    where o.created_by = caller and o.self_serve_created_at is not null
  ) then
    return pg_catalog.jsonb_build_object('status', 'limit_reached');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('open-signup:platform', 509));
  if (select pg_catalog.count(*) from public.organizations o
      where o.self_serve_created_at > pg_catalog.now() - interval '24 hours') >= 100 then
    return pg_catalog.jsonb_build_object('status', 'unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-name:' || pg_catalog.lower(clean_name), 509));
  if exists (
    select 1 from public.organizations o
    where pg_catalog.lower(o.name) = pg_catalog.lower(clean_name)
  ) then
    return pg_catalog.jsonb_build_object('status', 'name_unavailable');
  end if;

  new_slug := 'u-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  new_chapter := 'c-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  if exists (select 1 from public.organizations o where o.slug = new_slug)
     or exists (select 1 from public.chapters c where c.id = new_chapter or c.slug = new_chapter) then
    new_slug := 'u-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
    new_chapter := 'c-' || pg_catalog.substr(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'), 1, 10);
  end if;

  begin
    insert into public.organizations (slug, name, status, created_by, self_serve_created_at)
    values (new_slug, clean_name, 'active', caller, pg_catalog.now())
    returning id into org_id;

    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, org_id, true, caller);

    insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
    values (new_chapter, clean_name, null, true, 1, org_id, new_chapter);

    insert into public.organization_memberships (organization_id, user_id, status)
    values (org_id, caller, 'active');

    insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
    values (org_id, caller, 'admin', caller);

    insert into public.member_chapter_memberships (user_id, chapter_id, status, last_selected_at)
    values (caller, new_chapter, 'active', pg_catalog.now())
    on conflict (user_id, chapter_id) do update
      set status = 'active', revoked_at = null, last_selected_at = pg_catalog.now();

    update public.member_profiles
    set chapter_id = new_chapter
    where id = caller;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org_id, 'administration', 'organization_self_created', 'create', caller,
      'organization', org_id::text, p_idempotency_key,
      pg_catalog.jsonb_build_object(
        'organizationId', org_id::text,
        'chapterId', new_chapter,
        'userId', caller::text,
        'status', 'unverified')
    );
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('status', 'name_unavailable');
  end;

  return pg_catalog.jsonb_build_object(
    'status', 'created',
    'organizationId', org_id,
    'chapterId', new_chapter,
    'slug', new_slug,
    'idempotent', false);
end;
end;
$function$;

revoke all on function public.create_my_organization(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_my_organization(text, uuid) to authenticated;

comment on function public.create_my_organization(text, uuid) is
  'A signed-in person with a confirmed email, a satisfied second-factor state and no active organization creates one unverified organization: the seven bootstrap shell rows plus one ledger row. The organization name is the only free text; the default chapter takes it. Idempotent by key; counted outcomes (limit_reached, unavailable, name_unavailable) return a status, and so does closed (uncounted) until the owner opens the signup period.';

-- ---------------------------------------------------------------------------
-- Write boundary for unverified organizations
-- ---------------------------------------------------------------------------

-- Row values are read through to_jsonb(new), so one function serves every
-- table below. A chapter or organization id that resolves to no organization
-- (legacy rows) is outside this boundary; only an existing, unverified
-- self-created organization is refused.
create function private.enforce_unverified_organization_boundary()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  row_data jsonb;
  subject_org uuid;
  other_org uuid;
begin
  row_data := pg_catalog.to_jsonb(new);

  case tg_table_schema || '.' || tg_table_name
    when 'public.chapter_union_org_bindings' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.chapter_handshakes' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      select c.organization_id into other_org
      from public.chapters c where c.id = row_data ->> 'receiving_chapter_id';
      if (subject_org is not null and not private.organization_clears_signup_boundary(subject_org))
         or (other_org is not null and not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;
      -- A later insert trigger stamps the requesting chapter from the
      -- caller's session, so the caller's own organization is checked too.
      if tg_op = 'INSERT' then
        subject_org := private.current_member_organization();
        if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
          raise exception 'organization verification required' using errcode = '42501';
        end if;
      end if;

    when 'public.organization_coordination_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      other_org := (row_data ->> 'partner_organization_id')::uuid;
      if other_org is not null
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_coordination_organization_participants' then
      other_org := (row_data ->> 'organization_id')::uuid;
      select r.organization_id into subject_org
      from public.organization_coordination_records r
      where r.id = (row_data ->> 'record_id')::uuid;
      -- The owning organization's own participant row stays inside its walls.
      if other_org is distinct from subject_org
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_permission_grants' then
      if not private.organization_clears_signup_boundary((row_data ->> 'grantor_organization_id')::uuid)
         or not private.organization_clears_signup_boundary((row_data ->> 'grantee_organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_directory_profiles' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid)
         and (row_data ->> 'visibility' is distinct from 'private'
              or row_data ->> 'parent_organization_id' is not null) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.public_site_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.dues_stripe_oauth_states', 'public.dues_provider_connections' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.member_invitations' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      -- The a00_case_graph_lock statement trigger already holds the case-graph
      -- lock for this statement, so concurrent invitations count serially.
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        if (select pg_catalog.count(*)
              from public.member_invitations i
              join public.chapters c on c.id = i.chapter_id
             where c.organization_id = subject_org
               and i.created_at > pg_catalog.now() - interval '24 hours') >= 20
           or (select pg_catalog.count(*)
                 from public.member_invitations i
                 join public.chapters c on c.id = i.chapter_id
                where c.organization_id = subject_org) >= 200 then
          raise exception 'invitation rate limited' using errcode = 'P0001';
        end if;
      end if;

    when 'private.chapter_connection_profiles' then
      -- A draft stays inside the organization; a published profile reaches
      -- every other organization's staff.
      if row_data ->> 'publication_status' = 'published'
         and not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.chapter_connection_hides' then
      -- A hide names another organization's published chapter and is
      -- reciprocal, so it changes what that chapter sees.
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    else
      raise exception 'organization boundary not configured' using errcode = '55000';
  end case;

  return new;
end;
$function$;

revoke all on function private.enforce_unverified_organization_boundary()
  from public, anon, authenticated, service_role;

comment on function private.enforce_unverified_organization_boundary() is
  'Row trigger that keeps an unverified self-created organization inside its own walls: no registry binding, handshake, partnered coordination, network grant, listed directory profile, published connection profile or connection hide, public site record or payment connection, and at most 20 invitations per 24 hours and 200 in total.';

create trigger b20_unverified_organization_boundary
before insert or update on public.chapter_union_org_bindings
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on public.chapter_handshakes
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on public.organization_coordination_records
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on public.organization_coordination_organization_participants
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on public.organization_network_permission_grants
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on public.organization_network_directory_profiles
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on public.public_site_records
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert on private.dues_stripe_oauth_states
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on public.dues_provider_connections
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert on public.member_invitations
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on private.chapter_connection_profiles
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary
before insert or update on private.chapter_connection_hides
for each row execute function private.enforce_unverified_organization_boundary();

-- ---------------------------------------------------------------------------
-- Read conjuncts
-- ---------------------------------------------------------------------------

-- R1: another organization's directory profile or permission is discoverable
-- only from a verified organization. An organization always discovers itself.
create or replace function private.organization_network_can_discover(p_subject_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_subject_organization_id is not null
    and private.current_member_organization() is not null
    and (
      p_subject_organization_id = (select private.current_member_organization())
      or (
        private.organization_clears_signup_boundary((select private.current_member_organization()))
        and (
          exists (
            select 1
            from public.organization_network_directory_profiles p
            where p.organization_id = p_subject_organization_id
              and p.visibility = 'directory'
          )
          or private.organization_network_has_permission(
            (select private.current_member_organization()),
            p_subject_organization_id,
            'directory_contact'
          )
        )
      )
    );
$function$;

-- R2: other chapters' verified registry bindings are visible only to staff of
-- a verified organization. The chapter's own binding rows stay visible.
drop policy chapter_union_org_bindings_read_onboarded on public.chapter_union_org_bindings;
create policy chapter_union_org_bindings_read_onboarded
  on public.chapter_union_org_bindings for select to authenticated
  using (
    chapter_id = private.current_member_chapter()
    or (status = 'verified'
      and private.member_has_chapter_role(
        private.current_member_chapter(), array['steward','coordinator','advisor','admin','vp'])
      and private.organization_clears_signup_boundary(private.current_member_organization()))
  );

comment on policy chapter_union_org_bindings_read_onboarded on public.chapter_union_org_bindings is
  'Own chapter binding rows, plus verified bindings of other chapters for staff of a verified organization.';

-- ---------------------------------------------------------------------------
-- Chapter connections: an unverified organization discovers no other chapter
-- ---------------------------------------------------------------------------

-- R3: re-emitted from its latest body (20260928103100) with one added
-- conjunct: staff of an unverified self-created organization get an empty,
-- complete page. The projection names each chapter and its verified registry
-- binding, which R2 already withholds from them. CREATE OR REPLACE keeps the
-- function's ACL.
create or replace function public.list_chapter_connection_profiles(
  p_selected_hat text,
  p_after_id text default null,
  p_limit integer default 250,
  p_snapshot_token text default null,
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
  viewer_chapter text;
  cap integer;
  current_epoch bigint;
  token_epoch bigint;
  snapshot_at timestamptz;
  token text;
  scope_hash text;
  after_id text;
  rows_out jsonb;
  fetched integer;
  last_id text;
begin
  org := private.mi1_require_selected_organization();
  viewer_chapter := private.chapter_connection_require_chapter(org, coalesce(nullif(pg_catalog.btrim(p_chapter_id), ''), private.current_member_chapter()));
  perform private.chapter_connection_require_hat(
    org, p_selected_hat, viewer_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  scope_hash := pg_catalog.md5(org::text || ':' || viewer_chapter || ':' || p_selected_hat);

  cap := least(greatest(coalesce(p_limit, 250), 1), 500);
  after_id := nullif(pg_catalog.btrim(coalesce(p_after_id, '')), '');

  select e.epoch into current_epoch from private.chapter_connection_registry_epoch e where e.singleton;
  current_epoch := coalesce(current_epoch, 1);

  if p_snapshot_token is null then
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()))::double precision);
  else
    if p_snapshot_token !~ '^[0-9]{1,18}:[0-9]{1,12}:[a-f0-9]{32}$' then
      raise exception 'connection registry snapshot token invalid' using errcode = '22023';
    end if;
    token_epoch := pg_catalog.split_part(p_snapshot_token, ':', 1)::bigint;
    snapshot_at := pg_catalog.to_timestamp(pg_catalog.split_part(p_snapshot_token, ':', 2)::double precision);
    if pg_catalog.split_part(p_snapshot_token, ':', 3) <> scope_hash then
      raise exception 'connection registry snapshot scope changed' using errcode = '22023';
    end if;
    if token_epoch <> current_epoch then
      raise exception 'connection registry snapshot changed' using errcode = '22023';
    end if;
    if snapshot_at > pg_catalog.now() + interval '1 minute'
       or snapshot_at < pg_catalog.now() - interval '1 hour' then
      raise exception 'connection registry snapshot expired' using errcode = '22023';
    end if;
  end if;
  token := current_epoch::text || ':' || pg_catalog.floor(extract(epoch from snapshot_at))::bigint::text || ':' || scope_hash;

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
    join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
    join public.organizations o on o.id = p.organization_id and o.status = 'active'
    where p.publication_status = 'published'
      and p.expires_at > snapshot_at
      and p.chapter_id <> viewer_chapter
      and private.organization_clears_signup_boundary(org)
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

-- Re-emitted from its latest body (20260928103100) with one change: an
-- unverified self-created organization is refused a hide before the target's
-- publication is read. The b20 trigger on private.chapter_connection_hides
-- refuses the row as well. CREATE OR REPLACE keeps the function's ACL.
create or replace function public.set_chapter_connection_hidden(
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
  -- An unverified self-created organization cannot hide another chapter. It
  -- gets one answer before any published profile is read, so the answer
  -- never says whether the target is published.
  if p_hidden and not private.organization_clears_signup_boundary(org) then
    raise exception 'organization verification required' using errcode = '42501';
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
      join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
      where p.chapter_id = target
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

-- Re-emitted from 20260928221008 with one change: an unverified self-created
-- organization gets the not-onboarded answer before the registry is read,
-- matching public.request_chapter_handshake below. Every other refusal, lock
-- and write is unchanged, and CREATE OR REPLACE keeps the function's ACL.
create or replace function public.request_chapter_connection_handshake(
  p_selected_hat text,
  p_chapter_id text,
  p_target_chapter_id text,
  p_title text,
  p_purpose text,
  p_data_scope text,
  p_idempotency_key uuid
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
  partner text;
  registry_epoch bigint;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter,
    array['steward','coordinator','advisor','admin','vp']);
  if chapter is distinct from private.current_member_chapter()
     or not private.member_has_chapter_role(chapter, array[p_selected_hat]) then
    raise exception 'select the source chapter before requesting a handshake' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope is null or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  target := nullif(pg_catalog.btrim(coalesce(p_target_chapter_id, '')), '');
  if target is null or target = chapter then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  -- An unverified self-created organization cannot hand-shake: it gets the
  -- legacy not-onboarded answer before any published profile or registry
  -- binding is read, so the answer never depends on the target.
  if not private.organization_clears_signup_boundary(org) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;

  -- Serialize retries before taking the registry lock. The legacy event's
  -- globally unique key remains the durable idempotency authority.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key::text, 509281));
  -- Every eligibility dependency advances this row in the existing registry
  -- triggers. SHARE prevents a withdrawal/hide/rebind/quarantine from
  -- committing between the following fresh read and the legacy request.
  -- Do not take target-row locks: registry writers lock those before epoch.
  select e.epoch into registry_epoch
  from private.chapter_connection_registry_epoch e where e.singleton for share;
  if registry_epoch is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  select b.union_org_id into partner
  from private.chapter_connection_profiles p
  join public.chapters c on c.id = p.chapter_id and c.organization_id = p.organization_id
  join public.organizations o on o.id = p.organization_id and o.status = 'active'
  join public.chapter_union_org_bindings b on b.chapter_id = p.chapter_id and b.status = 'verified'
  join public.union_orgs u on u.id = b.union_org_id
  where p.chapter_id = target
    and p.publication_status = 'published'
    and p.expires_at > pg_catalog.clock_timestamp()
    and not exists (
      select 1 from private.chapter_connection_hides h
      where (h.chapter_id = chapter and h.hidden_chapter_id = target)
         or (h.chapter_id = target and h.hidden_chapter_id = chapter)
    );
  if partner is null then
    raise exception 'target chapter unavailable' using errcode = '22023';
  end if;
  -- union_org_id is UNIQUE in chapter_union_org_bindings. Under the registry
  -- lock the legacy resolver must select this exact receiving chapter.
  return public.request_chapter_handshake(partner, p_title, p_purpose, p_data_scope, p_idempotency_key);
end;
$function$;

-- ---------------------------------------------------------------------------
-- A handshake request from an unverified organization learns nothing
-- ---------------------------------------------------------------------------

-- Re-emitted from its installed, case-graph-wrapped body (20260821012000 as
-- wrapped by 20260907151000) with one change: a caller whose selected
-- organization is an unverified self-created organization gets the existing
-- 'partner is not onboarded' 22023 answer before the registry binding is
-- read. Every other refusal, lock and write is unchanged, and CREATE OR
-- REPLACE keeps the function's ACL.
create or replace function public.request_chapter_handshake(p_partner_org_id text, p_title text, p_purpose text, p_data_scope text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  chapter text := private.current_member_chapter();
  receiving text;
  created public.chapter_handshakes%rowtype;
  prior_event public.chapter_handshake_events%rowtype;
  caller_organization uuid;
begin
  if caller is null or chapter is null
     or not private.member_has_chapter_role(chapter, array['steward','coordinator','advisor','admin','vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title,''))) not between 1 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_purpose,''))) not between 1 and 4000
     or p_data_scope not in ('docs_only','no_member_data','aggregate_only') then
    raise exception 'invalid request' using errcode = '22023';
  end if;
  -- An unverified self-created organization cannot hand-shake, so it gets
  -- the not-onboarded answer before any registry binding is read: the answer
  -- never depends on whether the partner has a verified binding. A legacy
  -- chapter with no organization keeps its previous behaviour.
  caller_organization := private.current_member_organization();
  if caller_organization is not null
     and not private.organization_clears_signup_boundary(caller_organization) then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select b.chapter_id into receiving
  from public.chapter_union_org_bindings b
  where b.union_org_id = p_partner_org_id and b.status = 'verified';
  if receiving is null or receiving = chapter then
    raise exception 'partner is not onboarded for two-sided requests' using errcode = '22023';
  end if;
  select * into prior_event from public.chapter_handshake_events e
  where e.idempotency_key = p_idempotency_key;
  if found then
    select h.* into created from public.chapter_handshakes h
    where h.id = prior_event.handshake_id;
    if prior_event.transition <> 'requested' or prior_event.actor <> caller
       or created.chapter_id <> chapter or created.receiving_chapter_id <> receiving
       or created.partner_org_id <> p_partner_org_id
       or created.title <> pg_catalog.btrim(p_title)
       or created.purpose <> pg_catalog.btrim(p_purpose)
       or created.data_scope <> p_data_scope then
      raise exception 'idempotency key already used' using errcode = '22023';
    end if;
    return pg_catalog.to_jsonb(created);
  end if;
  insert into public.chapter_handshakes
    (chapter_id, receiving_chapter_id, partner_org_id, title, purpose, data_scope,
     status, requested_by, requested_at)
  values (chapter, receiving, p_partner_org_id, pg_catalog.btrim(p_title),
    pg_catalog.btrim(p_purpose), p_data_scope, 'requested', caller, pg_catalog.clock_timestamp())
  returning * into created;
  insert into public.chapter_handshake_events
    (handshake_id, idempotency_key, actor, actor_chapter_id, transition, from_status, to_status)
  values (created.id, p_idempotency_key, caller, chapter, 'requested', 'draft', 'requested');
  perform private.notify_handshake_staff(receiving, 'Partnership request received',
    'An authorized chapter sent a two-sided partnership request for review.');
  return pg_catalog.to_jsonb(created);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Account lifecycle trigger review: the new triggers and every function they
-- reach are reviewed here, and the review must be complete before commit.
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.object_name = 'b20_unverified_organization_boundary')
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
         'enforce_unverified_organization_boundary()',
         'organization_clears_signup_boundary(p_organization_id uuid)',
         'organization_is_verified(p_organization_id uuid)'))
on conflict do nothing;

do $assert_self_serve_organization_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the self-serve organization shell';
  end if;
end;
$assert_self_serve_organization_trigger_review$;

notify pgrst, 'reload schema';

commit;
