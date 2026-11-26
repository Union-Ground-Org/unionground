-- BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003
--
-- Owner decision, October 4, 2026 (12:55 PM ET): "Yes, into their own chapter
-- only." A chapter President may invite people into a chapter they preside
-- over, as plain members. Until now every invitation RPC required the admin
-- chapter role, so the Harrow Bay Local had to grant org-wide Admin.
--
-- A chapter President is a member_role_chapters row with role 'vp' for that
-- chapter, held with an active membership in the selected organization (the
-- same scope private.member_has_chapter_role applies). An organization-wide
-- vp grant alone does not make anyone the President of a chapter.
--
--   * private.member_invitation_chapter_presided(p_chapter_id): the caller is
--     the President of that chapter in the selected organization.
--   * private.require_member_invitation_inviter_chapter(): the desk gate of
--     private.require_member_invitation_admin_chapter() (same locks and
--     re-verification) that also admits the President of the selected chapter.
--   * create: an admin keeps every existing right (any administered chapter,
--     any starting access); a President may invite only into a presided
--     chapter and only with no starting access.
--   * list, resend, revoke and delivery record: a President sees and manages
--     only plain-member invitations (no starting access, kind provision) in a
--     presided chapter. Admin visibility is unchanged.
--
-- Unchanged: admin behavior and target-chapter rule (20261004010000), the
-- former-member re-invitation (organization admin only, still behind the
-- admin desk gate), rate limits, accept and claim paths, grants.
--
-- Hosted application: SAMPLE first, then production; needs its own owner
-- authorization (not part of the October 4 three-migration grant).

begin;

create function private.member_invitation_chapter_presided(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.member_has_chapter_role(p_chapter_id, array['vp'])
    and exists (
      select 1
      from public.member_profiles p
      join public.chapters selected on selected.id = p.chapter_id
      join public.chapters target on target.id = p_chapter_id
      join public.member_role_chapters rc
        on rc.user_id = p.id and rc.chapter_id = target.id and rc.role = 'vp'
      where p.id = (select auth.uid())
        and selected.organization_id is not null
        and target.organization_id = selected.organization_id
    );
$function$;

revoke all on function private.member_invitation_chapter_presided(text)
  from public, anon, authenticated, service_role;

comment on function private.member_invitation_chapter_presided(text) is
  'True when the caller holds the chapter-scoped vp (President) role for the target chapter, with an active membership, in the organization of the caller''s selected chapter. An organization-wide vp grant alone does not count.';

create function private.require_member_invitation_inviter_chapter()
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  selected_chapter text;
  selected_org uuid;
  locked_chapter text;
  locked_org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  selected_chapter := private.current_member_chapter();
  select c.organization_id into selected_org
  from public.chapters c
  where c.id = selected_chapter;
  if caller is null
     or selected_chapter is null
     or selected_org is null
     or not (private.member_has_chapter_role(selected_chapter, array['admin'])
             or private.member_invitation_chapter_presided(selected_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || selected_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id, c.organization_id into locked_chapter, locked_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if locked_chapter is distinct from selected_chapter
     or locked_org is distinct from selected_org
     or not (private.member_has_chapter_role(locked_chapter, array['admin'])
             or private.member_invitation_chapter_presided(locked_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return locked_chapter;
end;
$function$;

revoke all on function private.require_member_invitation_inviter_chapter()
  from public, anon, authenticated, service_role;

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
  caller_chapter text := private.require_member_invitation_inviter_chapter();
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
  as_admin boolean;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- An admin may invite into any chapter they administer in the selected
  -- organization. A chapter President may invite only into a chapter they
  -- preside over, and only as a plain member (owner decision, October 4,
  -- 2026). The desk gate above already holds the organization-role lock.
  as_admin := private.member_invitation_chapter_administrable(target_chapter);
  if not as_admin and (clean_role is not null
     or not private.member_invitation_chapter_presided(target_chapter)) then
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
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 100));
  chapter_name text;
  caller_org uuid;
  administrable text[];
  presided text[];
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id, c.name, c.organization_id into caller_chapter, chapter_name, caller_org
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null or caller_org is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- Chapters the caller administers (every invitation, any starting access)
  -- and, separately, chapters the caller presides over without administering
  -- them (plain-member invitations only).
  select coalesce(pg_catalog.array_agg(c.id order by c.order_index, c.name, c.id), array[]::text[])
    into administrable
  from public.chapters c
  where c.organization_id = caller_org
    and private.member_invitation_chapter_administrable(c.id);
  select coalesce(pg_catalog.array_agg(c.id order by c.order_index, c.name, c.id), array[]::text[])
    into presided
  from public.chapters c
  where c.organization_id = caller_org
    and not (c.id = any(administrable))
    and private.member_invitation_chapter_presided(c.id);

  return pg_catalog.jsonb_build_object(
    'chapter', pg_catalog.jsonb_build_object('id', caller_chapter, 'name', chapter_name),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', c.id, 'name', c.name,
          'grantsAccess', c.id = any(administrable))
        order by c.order_index, c.name, c.id)
      from public.chapters c
      where c.id = any(administrable) or c.id = any(presided)
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
      from pg_catalog.unnest(administrable || presided) as a(chapter_id)
      cross join lateral (
        select i.*, c.name as chapter_name
        from public.member_invitations i
        join public.chapters c on c.id = i.chapter_id
        where i.chapter_id = a.chapter_id and i.status <> 'superseded'
          and (a.chapter_id = any(administrable)
               or (i.initial_role is null and i.kind = 'provision'))
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
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
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
    and (private.member_invitation_chapter_administrable(chapter_id)
         or (initial_role is null and kind = 'provision'
             and private.member_invitation_chapter_presided(chapter_id)))
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
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
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
    and (private.member_invitation_chapter_administrable(chapter_id)
         or (initial_role is null and kind = 'provision'
             and private.member_invitation_chapter_presided(chapter_id)))
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
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  invitation_row public.member_invitations%rowtype;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
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
    and (private.member_invitation_chapter_administrable(chapter_id)
         or (initial_role is null and kind = 'provision'
             and private.member_invitation_chapter_presided(chapter_id)))
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
