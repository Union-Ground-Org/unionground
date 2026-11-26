-- Operator founder invitations: how a new organization starts while accounts
-- are invitation-only (owner direction 2026-10-02).
--
-- Since 2026-10-01 nothing on the web site, the apps or the API creates an
-- account except an invitation, and an invitation can only bring a person into
-- an organization that already exists. The operator bootstrap creates an
-- organization only on an empty database, and the self-serve path stays
-- closed until the owner opens public signup. This file lets the Union Ground
-- operator start a further organization by inviting its founder:
--
--   * public.member_invitations.kind gains 'founder'. A founder invitation is
--     created only here, by the service role, with no inviter (invited_by
--     null) and no starting chapter role. Acceptance runs the ordinary
--     provision path in api/accept-invitation.js unchanged;
--   * public.create_organization_founder_invitation creates the organization
--     (operator-provisioned: self_serve_created_at stays null, so it is not
--     behind the self-serve boundary), its staff-MFA policy, its default
--     chapter (named after the organization) and the founder's pending
--     invitation, plus one ledger row with ids only. Name and address
--     refusals return a status and create nothing. Replays are idempotent by
--     key;
--   * public.record_organization_founder_invitation_delivery and
--     public.resend_organization_founder_invitation are the service-role
--     twins of the chapter admin's delivery and resend RPCs, limited to
--     operator-issued founder invitations. A resend is refused once the
--     organization has an administrator;
--   * private.grant_founder_organization_admin, an AFTER UPDATE trigger on
--     member_invitations, makes the founder an organization administrator in
--     the same transaction that marks an operator-issued founder invitation
--     accepted. A founder-kind row that a chapter admin resends carries that
--     admin as inviter, so its acceptance grants nothing.
--
-- The pinned invitation routines (create, claim, finalize, activation,
-- chapter-admin delivery and resend) are not re-emitted. All four new
-- routines take the case-graph gate first. Nothing here creates an account,
-- a member or any member activity. Service role only; no client role can
-- reach any of it.
--
-- Hosted application: SAMPLE first, then production, in an owner-approved
-- hosted window.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_invitations
  drop constraint member_invitations_kind_check,
  add constraint member_invitations_kind_check
    check (kind in ('provision', 'reactivation', 'founder'));

comment on column public.member_invitations.kind is
  'provision: acceptance creates a new account. reactivation: acceptance re-activates the revoked organization membership of the account that already owns the address; no account or starting role is created. founder: an operator-issued invitation (invited_by null) whose acceptance creates the account and makes it the organization''s first administrator.';

-- ---------------------------------------------------------------------------
-- Create the organization and its founder's invitation
-- ---------------------------------------------------------------------------

create function public.create_organization_founder_invitation(
  p_organization_name text,
  p_email text,
  p_full_name text,
  p_locale text,
  p_token_hash text,
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
  clean_name text;
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_full text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  new_slug text;
  new_chapter text;
  org_id uuid;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
  replay record;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select l.event_type, l.organization_id,
         l.metadata ->> 'chapterId' as chapter_id,
         l.metadata ->> 'entityId' as invitation_id
    into replay
    from public.organization_audit_ledger l
   where l.idempotency_key = p_idempotency_key;
  if found then
    if replay.event_type = 'organization_founder_invited' then
      return pg_catalog.jsonb_build_object(
        'status', 'invited',
        'organizationId', replay.organization_id,
        'chapterId', replay.chapter_id,
        'invitationId', replay.invitation_id,
        'send', false,
        'idempotent', true);
    end if;
    raise exception 'idempotency key reused' using errcode = '22023';
  end if;

  -- The same organization-name rules as public.create_my_organization.
  clean_name := pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.normalize(coalesce(p_organization_name, ''), 'NFKC'), '[[:space:]]+', ' ', 'g'));
  if pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_name !~ '[[:alnum:]]'
     or clean_name ~ '[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯︀-️﻿]'
     or pg_catalog.strpos(clean_name, '@') > 0
     or pg_catalog.strpos(clean_name, '://') > 0
     or pg_catalog.regexp_replace(clean_name, '[[:space:]().+/_‐-―−－-]', '', 'g') ~ '[[:digit:]]{7,}' then
    raise exception 'invalid founder invitation' using errcode = '22023';
  end if;

  -- The same invitee rules as public.create_member_invitation.
  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_full) not between 2 and 120
     or clean_full ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid founder invitation' using errcode = '22023';
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_full, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509));
  -- As in create_member_invitation: a pending invitation past its expiry is
  -- expired first, because member_invitations_one_live_email_idx still
  -- counts it.
  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= pg_catalog.clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, null, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  -- A founder must be new to Union Ground: an existing account or a live
  -- invitation for the address refuses before anything is created.
  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email
      and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('status', 'email_unavailable');
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
    insert into public.organizations (slug, name, status, created_by)
    values (new_slug, clean_name, 'active', null)
    returning id into org_id;

    insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by)
    values (true, org_id, true, null);

    insert into public.chapters (id, name, region, is_default, order_index, organization_id, slug)
    values (new_chapter, clean_name, null, true, 1, org_id, new_chapter);
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('status', 'name_unavailable');
  end;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, kind)
  values
    (clean_email, clean_full, clean_first, clean_initials, new_chapter,
     null, clean_locale, clean_hash, 'pending', 1, null,
     pg_catalog.clock_timestamp() + interval '15 minutes', 'founder')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, new_chapter, null, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', new_chapter,
      'kind', 'founder', 'locale', clean_locale,
      'deliveryVersion', invitation_row.delivery_version)
  );

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org_id, 'administration', 'organization_founder_invited', 'create', null,
    'organization', org_id::text, p_idempotency_key,
    pg_catalog.jsonb_build_object(
      'organizationId', org_id::text,
      'chapterId', new_chapter,
      'entityType', 'invitation',
      'entityId', invitation_row.id::text,
      'status', 'invited')
  );

  return pg_catalog.jsonb_build_object(
    'status', 'invited',
    'organizationId', org_id,
    'chapterId', new_chapter,
    'slug', new_slug,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at,
    'send', true,
    'idempotent', false);
end;
end;
$function$;

revoke all on function public.create_organization_founder_invitation(text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.create_organization_founder_invitation(text, text, text, text, text, uuid)
  to service_role;

comment on function public.create_organization_founder_invitation(text, text, text, text, text, uuid) is
  'Service-role operator start of a new organization while accounts are invitation-only: creates the operator-provisioned organization, its staff-MFA policy and default chapter, and the founder''s 15-minute founder invitation (no inviter, no chapter role), plus one ledger row with ids only. An existing account or live invitation for the address answers email_unavailable and a taken name answers name_unavailable, creating nothing. Idempotent by key.';

-- ---------------------------------------------------------------------------
-- Delivery outcome of a founder invitation
-- ---------------------------------------------------------------------------

create function public.record_organization_founder_invitation_delivery(
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
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'failed') then
    raise exception 'invalid delivery outcome' using errcode = '22023';
  end if;

  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and kind = 'founder'
    and invited_by is null
    and delivery_version = p_delivery_version
  for update;
  if not found or invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;

  if p_outcome = 'sent' then
    update public.member_invitations
    set sent_at = pg_catalog.clock_timestamp()
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_sent',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
  else
    update public.member_invitations
    set status = 'delivery_failed', token_hash = null,
        expires_at = pg_catalog.clock_timestamp(), failure_code = 'provider_unavailable'
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_delivery_failed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version,
        'failureClass', 'provider_unavailable')
    );
  end if;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
end;
$function$;

revoke all on function public.record_organization_founder_invitation_delivery(uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_organization_founder_invitation_delivery(uuid, integer, text)
  to service_role;

comment on function public.record_organization_founder_invitation_delivery(uuid, integer, text) is
  'Service-role twin of record_member_invitation_delivery for operator-issued founder invitations only: sent stamps sent_at; failed ends the invitation (delivery_failed, digest cleared). A stale version or a non-pending row records nothing.';

-- ---------------------------------------------------------------------------
-- Resend a founder invitation that expired or failed
-- ---------------------------------------------------------------------------

create function public.resend_organization_founder_invitation(
  p_invitation_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  org_id uuid;
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid founder invitation' using errcode = '22023';
  end if;

  select * into old_row
  from public.member_invitations
  where id = p_invitation_id and kind = 'founder' and invited_by is null
  for update;
  if not found or old_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'send', false);
  end if;

  -- Once the organization has an administrator, the founder step is over:
  -- the administrator invites everyone else from the admin desk.
  select c.organization_id into org_id from public.chapters c where c.id = old_row.chapter_id;
  if exists (
    select 1 from public.organization_role_grants g
    where g.organization_id = org_id and g.role = 'admin'
  ) then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'send', false);
  end if;

  update public.member_invitations
  set status = 'superseded', token_hash = null, failure_code = null
  where id = old_row.id;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     replaces_id, expires_at, kind)
  values
    (old_row.normalized_email, old_row.full_name, old_row.first_name,
     old_row.initials, old_row.chapter_id, null, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, null, old_row.id,
     pg_catalog.clock_timestamp() + interval '15 minutes', 'founder')
  returning * into new_row;

  perform private.audit_member_invitation(
    new_row.id, new_row.chapter_id, null, 'invite_resent',
    pg_catalog.jsonb_build_object('chapterId', new_row.chapter_id,
      'deliveryVersion', new_row.delivery_version,
      'replacesInvitationId', old_row.id)
  );

  return pg_catalog.jsonb_build_object(
    'status', 'invited',
    'send', true,
    'organizationId', org_id,
    'invitationId', new_row.id,
    'deliveryVersion', new_row.delivery_version,
    'expiresAt', new_row.expires_at,
    'normalizedEmail', new_row.normalized_email,
    'fullName', new_row.full_name,
    'locale', new_row.locale);
end;
end;
$function$;

revoke all on function public.resend_organization_founder_invitation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resend_organization_founder_invitation(uuid, text)
  to service_role;

comment on function public.resend_organization_founder_invitation(uuid, text) is
  'Service-role resend of an operator-issued founder invitation that is pending, expired or failed: supersedes it and issues the next version for 15 minutes. Refused once the organization has an administrator.';

-- ---------------------------------------------------------------------------
-- Acceptance makes the founder an organization administrator
-- ---------------------------------------------------------------------------

create function private.grant_founder_organization_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[new.auth_user_id], array[]::uuid[]);

declare
  org_id uuid;
begin
  select c.organization_id into org_id from public.chapters c where c.id = new.chapter_id;
  if org_id is null or new.auth_user_id is null then
    raise exception 'founder invitation incomplete' using errcode = '22023';
  end if;

  -- handle_new_member made the founder an active member of this organization
  -- when the account was created; the grant's foreign key requires it.
  insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
  values (org_id, new.auth_user_id, 'admin', null)
  on conflict (organization_id, user_id, role) do nothing;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org_id, 'administration', 'organization_founder_admin_granted', 'grant', new.auth_user_id,
    'role_grant', new.auth_user_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'organizationId', org_id::text,
      'chapterId', new.chapter_id,
      'userId', new.auth_user_id::text,
      'role', 'admin',
      'entityType', 'invitation',
      'entityId', new.id::text)
  );
  return null;
end;
end;
$function$;

revoke all on function private.grant_founder_organization_admin()
  from public, anon, authenticated, service_role;

comment on function private.grant_founder_organization_admin() is
  'Trigger: when an operator-issued founder invitation (kind founder, invited_by null) becomes accepted, grants the new account the organization admin role and writes one ledger row with ids only.';

create trigger z50_founder_admin_on_accept
  after update of status on public.member_invitations
  for each row
  when (new.status = 'accepted'
        and old.status is distinct from 'accepted'
        and new.kind = 'founder'
        and new.invited_by is null)
  execute function private.grant_founder_organization_admin();

-- ---------------------------------------------------------------------------
-- Account lifecycle trigger review: Auth deletion rewrites member_invitations
-- through its auth.users foreign keys, so the new trigger and the function it
-- runs are reviewed here, and the review must be complete before commit. The
-- trigger fires only on a status change, which no referential action makes.
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'public' and s.table_name = 'member_invitations'
       and s.object_name = 'z50_founder_admin_on_accept')
   or (s.kind = 'function' and s.schema_name = 'private'
       and s.object_name = 'grant_founder_organization_admin()')
on conflict do nothing;

do $assert_founder_invitation_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after operator founder invitations';
  end if;
end;
$assert_founder_invitation_trigger_review$;

notify pgrst, 'reload schema';

commit;
