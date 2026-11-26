-- BUG-UG-SCIM-RECONCILE-REWRITES-DESK-INVITATION-STARTING-ROLE-20261008
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.scim_reconcile_user(p_scim_user_id uuid, p_token_hash text)
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
      -- A matching id can be an adopted desk invitation. Require the retained
      -- SCIM issuance audit as well: deleting a desk inviter sets invited_by
      -- to null but must never transfer role ownership to the directory.
      if live_invitation.id = scim_row.invitation_id
         and live_invitation.status = 'pending'
         and live_invitation.kind = 'provision'
         and live_invitation.invited_by is null
         and exists (
           select 1 from public.member_invitation_audit a
           where a.invitation_id = live_invitation.id
             and a.chapter_id = live_invitation.chapter_id
             and a.action = 'invite_requested'
             and a.detail ->> 'source' = 'scim'
         ) then
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

commit;
