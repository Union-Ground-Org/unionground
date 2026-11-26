-- BUG-UG-INVITE-CHAPTER-LOCKED-TO-CURRENT-CHAPTER-20261003
--
-- An organization admin can choose the chapter an invitee joins.
--
-- Until now every invitation RPC was bound to the inviter's SELECTED chapter:
-- create refused any other p_chapter_id, and the list, resend, revoke and
-- delivery-record RPCs only saw rows of that chapter. In the Harrow Bay pilot
-- (October 3, 2026) invitees therefore landed in the Local's chapter and their
-- own chapter membership had to be granted by hand afterwards.
--
-- This migration keeps the desk gate unchanged (private.require_member_
-- invitation_admin_chapter(): an admin of the selected chapter, re-verified
-- under the organization-role -> member lock order) and replaces "the selected
-- chapter" with "a chapter the caller administers in the selected
-- organization" on every invitation path:
--
--   * private.member_invitation_chapter_administrable(p_chapter_id): the target
--     chapter belongs to the organization of the caller's selected chapter AND
--     private.member_has_chapter_role(target, admin). member_has_chapter_role
--     already requires the target chapter to be in the selected organization,
--     with an active membership there, and counts an organization admin as an
--     admin of every chapter they belong to; the explicit organization check
--     restates the tenant boundary here so this rule cannot widen if that
--     helper ever does.
--   * public.create_member_invitation and public.create_former_member_invitation
--     accept such a target chapter; the row, the per-chapter daily limit and the
--     audit use the target chapter.
--   * public.get_member_invitations lists invitations of every administrable
--     chapter (p_limit per chapter), names each row's chapter and returns the
--     administrable chapters ('chapters') so the desk can offer exactly those.
--     'chapter' (the selected chapter) is unchanged.
--   * public.resend_member_invitation, public.revoke_member_invitation and
--     public.record_member_invitation_delivery act on an invitation of any
--     administrable chapter, so every invitation the caller may create is one
--     the caller may also manage. Any other id keeps the uniform no-op answer.
--
-- Unchanged: who counts as an admin (no President or officer-title rights),
-- the selected workspace chapter (nothing here switches it), MFA and the
-- organization-admin requirement for former-member re-invitations, rate-limit
-- amounts, accept/claim paths, grants.
begin;

create function private.member_invitation_chapter_administrable(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_profiles p
    join public.chapters selected on selected.id = p.chapter_id
    join public.chapters target on target.id = p_chapter_id
    where p.id = (select auth.uid())
      and selected.organization_id is not null
      and target.organization_id = selected.organization_id
  ) and private.member_has_chapter_role(p_chapter_id, array['admin']);
$function$;

revoke all on function private.member_invitation_chapter_administrable(text)
  from public, anon, authenticated, service_role;

comment on function private.member_invitation_chapter_administrable(text) is
  'True when the target chapter is in the organization of the caller''s selected chapter and the caller holds the admin chapter role for it. Invitation RPCs call it after the desk gate.';

create or replace function public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  target_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_role text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_initial_role, ''))), '');
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- Any chapter the caller administers in the selected organization; the
  -- desk gate above already holds the organization-role lock for it.
  if caller_chapter is null
     or not private.member_invitation_chapter_administrable(target_chapter) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- Count before duplicate/existing-account branches. Those branches must not
  -- be a free unbounded address-probing endpoint.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_admin_hourly'), interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || target_chapter, 'chapter-day', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_chapter_daily'), interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es')
     or (clean_role is not null and clean_role not in ('steward', 'coordinator', 'advisor')) then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     clean_role, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', clean_role, 'locale', clean_locale,
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;

revoke all on function public.create_member_invitation(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_member_invitation(text, text, text, text, text, text)
  to authenticated;

create or replace function public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  -- The same desk gate as every other invitation write: a chapter admin of the
  -- selected chapter, resolved under the organization-role -> member lock
  -- order. The target chapter must then be one the caller administers in the
  -- selected organization, the same rule the list, delivery record, resend and
  -- revoke RPCs apply, so whoever can issue this invitation can also manage it.
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  target_org uuid;
  locked_org uuid;
  target_user uuid;
  prior_revoked_at timestamptz;
  profile_row public.member_profiles%rowtype;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
begin
  -- Organization admin only, with the second factor every admin membership
  -- write demands. private.has_organization_role already carries the MFA
  -- step-up; the explicit check keeps the refusal the same when it is absent.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;
  if caller_chapter is null
     or not private.member_invitation_chapter_administrable(p_chapter_id) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- Count before the eligibility branches: an ineligible address must not be a
  -- free unbounded probing endpoint. Same persisted buckets as the ordinary
  -- invitation, so one admin's budget is one budget.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', 10, interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || p_chapter_id, 'chapter-day', 50, interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  -- Re-derive and re-authorize under the tenant lock, as the grant and
  -- set_member_organization_role do: a request that queued behind a role
  -- revocation must not expire or issue invitations with the authority it had
  -- before the lock was granted.
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is distinct from target_org
     or not private.mfa_satisfied()
     or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  -- Eligibility: exactly one live account owns the address, it has a profile,
  -- its membership in THIS organization is revoked, and it is active in no
  -- organization. Anything else (no account, never a member here, active
  -- here or elsewhere, a live invitation already out) returns the uniform
  -- accepted/no-send outcome and writes nothing.
  select u.id into target_user
  from auth.users u
  where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
  order by u.created_at
  limit 1;
  if target_user is null then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || target_user::text, 0));
  select * into profile_row from public.member_profiles p where p.id = target_user;
  select om.revoked_at into prior_revoked_at
  from public.organization_memberships om
  where om.organization_id = target_org
    and om.user_id = target_user
    and om.status = 'revoked';
  if not found
     or profile_row.id is null
     or exists (
       select 1 from public.organization_memberships other
       where other.user_id = target_user and other.status = 'active'
     )
     or exists (
       select 1 from public.member_invitations i
       where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
     ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, kind)
  values
    (clean_email, profile_row.full_name, profile_row.first_name, profile_row.initials, p_chapter_id,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes', 'reactivation')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, p_chapter_id, caller, 'reinvite_requested',
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id,
      'organizationId', target_org, 'priorRevokedAt', prior_revoked_at,
      'locale', clean_locale, 'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;

revoke all on function public.create_former_member_invitation(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_former_member_invitation(text, text, text, text)
  to authenticated;

create or replace function public.get_member_invitations(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 100));
  chapter_name text;
  caller_org uuid;
  administrable text[];
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id, c.name, c.organization_id into caller_chapter, chapter_name, caller_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null or caller_org is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- Every chapter of the selected organization the caller administers: the
  -- chapters the desk may invite into, and whose invitations it may manage.
  select coalesce(pg_catalog.array_agg(c.id order by c.order_index, c.name, c.id), array[]::text[])
    into administrable
  from public.chapters c
  where c.organization_id = caller_org
    and private.member_invitation_chapter_administrable(c.id);

  return pg_catalog.jsonb_build_object(
    'chapter', pg_catalog.jsonb_build_object('id', caller_chapter, 'name', chapter_name),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name)
        order by c.order_index, c.name, c.id)
      from public.chapters c
      where c.id = any(administrable)
    ), '[]'::jsonb),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'kind', s.kind,
        'normalizedEmail', s.normalized_email,
        'fullName', s.full_name,
        'chapterId', s.chapter_id,
        'chapterName', s.chapter_name,
        'initialRole', s.initial_role,
        'locale', s.locale,
        'status', case when s.status = 'pending' and s.expires_at <= clock_timestamp()
                  then 'expired' else s.status end,
        'deliveryVersion', s.delivery_version,
        'expiresAt', s.expires_at,
        'createdAt', s.created_at
      ) order by s.created_at desc, s.id)
      -- The cap applies per chapter, as it did when the desk saw one chapter:
      -- a busy chapter must not push another chapter's actionable rows out.
      from pg_catalog.unnest(administrable) as a(chapter_id)
      cross join lateral (
        select i.*, c.name as chapter_name
        from public.member_invitations i
        join public.chapters c on c.id = i.chapter_id
        where i.chapter_id = a.chapter_id and i.status <> 'superseded'
        order by i.created_at desc, i.id
        limit cap
      ) s
    ), '[]'::jsonb)
  );
end;
end;
$function$;

revoke all on function public.get_member_invitations(integer)
  from public, anon, authenticated;
grant execute on function public.get_member_invitations(integer)
  to authenticated;

create or replace function public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Installed Main carries this routine wrapped by the reviewed case-graph
  -- entry block of 20260907151000 (gate before declaration initializers);
  -- re-emitting it keeps that outer gate.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'resend-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_resend_admin_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- An invitation of any chapter the caller administers in the selected
  -- organization; every other id gets the same no-op answer as a missing one.
  select * into old_row
  from public.member_invitations
  where id = p_invitation_id
    and private.member_invitation_chapter_administrable(chapter_id)
  for update;
  if not found or old_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  if not private.consume_member_invitation_admin_limit(
    'invitation:' || old_row.id::text, 'invitation-resend-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_resend_per_invite_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
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
     old_row.initials, old_row.chapter_id, old_row.initial_role, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, caller, old_row.id,
     clock_timestamp() + interval '15 minutes', old_row.kind)
  returning * into new_row;

  perform private.audit_member_invitation(
    new_row.id, new_row.chapter_id, caller, 'invite_resent',
    pg_catalog.jsonb_build_object('chapterId', new_row.chapter_id,
      'deliveryVersion', new_row.delivery_version,
      'replacesInvitationId', old_row.id)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', new_row.id,
    'deliveryVersion', new_row.delivery_version,
    'expiresAt', new_row.expires_at,
    'normalizedEmail', new_row.normalized_email,
    'fullName', new_row.full_name,
    'locale', new_row.locale
  );
end;
end;
$function$;

revoke all on function public.resend_member_invitation(uuid, text)
  from public, anon, authenticated;
grant execute on function public.resend_member_invitation(uuid, text)
  to authenticated;

create or replace function public.revoke_member_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- An invitation of any chapter the caller administers in the selected
  -- organization; every other id gets the same no-op answer as a missing one.
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and private.member_invitation_chapter_administrable(chapter_id)
  for update;
  if not found or invitation_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'revoked', false);
  end if;

  update public.member_invitations
  set status = 'revoked', token_hash = null, revoked_at = clock_timestamp(),
      failure_code = null
  where id = invitation_row.id;

  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, caller, 'invite_revoked',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version)
  );
  return pg_catalog.jsonb_build_object('accepted', true, 'revoked', true);
end;
end;
$function$;

revoke all on function public.revoke_member_invitation(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_member_invitation(uuid)
  to authenticated;

create or replace function public.record_member_invitation_delivery(
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
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'failed') then
    raise exception 'invalid delivery outcome' using errcode = '22023';
  end if;

  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and private.member_invitation_chapter_administrable(chapter_id)
    and delivery_version = p_delivery_version
  for update;
  if not found or invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;

  if p_outcome = 'sent' then
    update public.member_invitations
    set sent_at = clock_timestamp()
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, caller, 'invite_sent',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
  else
    update public.member_invitations
    set status = 'delivery_failed', token_hash = null,
        expires_at = clock_timestamp(), failure_code = 'provider_unavailable'
    where id = invitation_row.id;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, caller, 'invite_delivery_failed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version,
        'failureClass', 'provider_unavailable')
    );
  end if;
  return pg_catalog.jsonb_build_object('recorded', true);
end;
end;
$function$;

revoke all on function public.record_member_invitation_delivery(uuid, integer, text)
  from public, anon, authenticated;
grant execute on function public.record_member_invitation_delivery(uuid, integer, text)
  to authenticated;

commit;
