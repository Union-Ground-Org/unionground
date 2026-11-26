-- REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006
--
-- Owner decision, October 8, 2026 (11:28 AM ET, question 7, option A):
-- Vice President, Treasurer and Secretary are display titles only (the
-- existing member_chapter_memberships.display_title, 20261004050000), with no
-- new access; President can be chosen when inviting; chapter authority stays
-- separate from organization-wide tools.
--
-- This migration delivers "President can be chosen when inviting": 'vp' joins
-- the invitation starting access an administrator may choose.
--
--   * public.member_invitations.initial_role may now be 'vp'.
--   * public.create_member_invitation accepts 'vp' from an administrator of
--     the target chapter only. A chapter President still invites plain members
--     only (the as_admin rule of 20261004040000 is unchanged).
--
-- No new access path: finalize_member_invitation (20260821011000) already
-- turns initial_role into a member_roles row and a member_role_chapters row
-- for the invitation's chapter, so an invited President is the President of
-- that chapter, exactly what that chapter's administrator can already grant
-- after joining with set_member_chapter_role(..., 'vp', true). It writes no
-- organization_role_grants row: the organization-wide President stays an
-- organization-admin grant on the Access page. SCIM still never maps admin or
-- vp (private.scim_mapped_role is unchanged). Admin is still never a starting
-- access.
--
-- Hosted application: SAMPLE first, then production, in a later hosted stage.

begin;
set local lock_timeout = '5s';

alter table public.member_invitations
  drop constraint member_invitations_initial_role_check;
alter table public.member_invitations
  add constraint member_invitations_initial_role_check
  check (initial_role is null or initial_role in ('steward', 'coordinator', 'advisor', 'vp'));

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
     or (clean_role is not null and clean_role not in ('steward', 'coordinator', 'advisor', 'vp')) then
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

commit;
