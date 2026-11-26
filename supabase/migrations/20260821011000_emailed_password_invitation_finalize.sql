-- Provisioned email + emailed-password completion.
-- The API creates an invitation-labelled, banned Auth identity, delivers a
-- high-entropy password, prepares the database identity, unbans Auth, and then
-- consumes the invitation. PostgreSQL never receives or stores the password.

set local lock_timeout = '5s';

alter table public.member_invitations
  drop constraint member_invitations_failure_code_check;
alter table public.member_invitations
  add constraint member_invitations_failure_code_check check (
    failure_code is null or failure_code in (
      'provider_unavailable', 'auth_unavailable', 'finalize_failed', 'unsafe_auth_state'
    )
  );

-- A prepared acceptance deliberately binds the exact Auth identity while the
-- token remains on its short recovery lease. The original state constraint
-- predated this prepare/activate/complete split and required auth_user_id null
-- for every accepting row.
alter table public.member_invitations
  drop constraint member_invitations_state_check;
alter table public.member_invitations
  add constraint member_invitations_state_check check (
    (status = 'pending' and token_hash is not null and auth_user_id is null)
    or (status = 'accepting' and token_hash is not null and accepting_at is not null)
    or (status = 'accepted' and token_hash is null and accepted_at is not null)
    or (status in ('revoked', 'superseded', 'delivery_failed', 'expired') and token_hash is null)
  );

create or replace function public.get_member_invitation_recovery_user(
  p_invitation_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  invitation_row public.member_invitations%rowtype;
  user_row record;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status = 'accepting';
  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  select u.id, u.email_confirmed_at,
         u.raw_app_meta_data ->> 'union_ground_provisioning' as provisioning
  into user_row
  from auth.users u
  where u.raw_user_meta_data ->> 'union_base_invitation_id' = invitation_row.id::text
    and pg_catalog.lower(u.email) = invitation_row.normalized_email
    and (invitation_row.auth_user_id is null or u.id = invitation_row.auth_user_id)
  order by u.created_at desc
  limit 1;
  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'found', true,
    'userId', user_row.id,
    'confirmed', user_row.email_confirmed_at is not null,
    'provisioning', user_row.provisioning
  );
end;
$function$;

create or replace function public.finalize_member_invitation(
  p_invitation_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status = 'accepting'
  for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = p_auth_user_id
      and pg_catalog.lower(u.email) = invitation_row.normalized_email
      and u.raw_user_meta_data ->> 'union_base_invitation_id' = invitation_row.id::text
      and u.raw_user_meta_data ->> 'chapter_id' = invitation_row.chapter_id
      and u.raw_app_meta_data ->> 'union_ground_provisioning' = 'pending'
      and u.banned_until > pg_catalog.clock_timestamp()
  ) or not exists (
    select 1
    from public.member_profiles p
    where p.id = p_auth_user_id and p.chapter_id = invitation_row.chapter_id
  ) or not exists (
    select 1
    from public.member_chapter_memberships m
    where m.user_id = p_auth_user_id
      and m.chapter_id = invitation_row.chapter_id
      and m.status = 'active'
  ) then
    raise exception 'invitation identity mismatch' using errcode = '22023';
  end if;

  if invitation_row.initial_role is not null then
    insert into public.member_roles (user_id, role, chapter_id, granted_by)
    values (
      p_auth_user_id, invitation_row.initial_role,
      invitation_row.chapter_id, invitation_row.invited_by
    )
    on conflict (user_id, role) do nothing;
    insert into public.member_role_chapters
      (user_id, role, chapter_id, granted_by)
    values (
      p_auth_user_id, invitation_row.initial_role,
      invitation_row.chapter_id, invitation_row.invited_by
    )
    on conflict (user_id, role, chapter_id) do nothing;
  end if;

  update public.member_invitations
  set auth_user_id = p_auth_user_id, failure_code = null
  where id = invitation_row.id;

  return pg_catalog.jsonb_build_object('prepared', true, 'userId', p_auth_user_id);
end;
$function$;

create or replace function public.complete_member_invitation_activation(
  p_invitation_id uuid,
  p_auth_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and status = 'accepting'
    and auth_user_id = p_auth_user_id
  for update;
  if not found then
    raise exception 'invitation unavailable' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.users u
    where u.id = p_auth_user_id
      and pg_catalog.lower(u.email) = invitation_row.normalized_email
      and u.raw_user_meta_data ->> 'union_base_invitation_id' = invitation_row.id::text
      and u.raw_user_meta_data ->> 'chapter_id' = invitation_row.chapter_id
      and u.raw_app_meta_data ->> 'union_ground_provisioning' = 'active'
      and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
  ) or not exists (
    select 1
    from public.member_chapter_memberships m
    where m.user_id = p_auth_user_id
      and m.chapter_id = invitation_row.chapter_id
      and m.status = 'active'
  ) or (
    invitation_row.initial_role is not null and not exists (
      select 1
      from public.member_role_chapters rc
      where rc.user_id = p_auth_user_id
        and rc.role = invitation_row.initial_role
        and rc.chapter_id = invitation_row.chapter_id
    )
  ) then
    raise exception 'invitation activation mismatch' using errcode = '22023';
  end if;

  update public.member_invitations
  set status = 'accepted', token_hash = null,
      accepted_at = pg_catalog.clock_timestamp(), failure_code = null
  where id = invitation_row.id;

  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, null, 'invite_accepted',
    pg_catalog.jsonb_build_object(
      'chapterId', invitation_row.chapter_id,
      'initialRole', invitation_row.initial_role,
      'deliveryVersion', invitation_row.delivery_version,
      'credentialDelivery', 'emailed-password'
    )
  );
  return pg_catalog.jsonb_build_object('accepted', true, 'userId', p_auth_user_id);
end;
$function$;

create or replace function public.fail_member_invitation_accept(
  p_invitation_id uuid,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_failure_code not in (
    'provider_unavailable', 'auth_unavailable', 'finalize_failed', 'unsafe_auth_state'
  ) then
    raise exception 'invalid failure class' using errcode = '22023';
  end if;
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id and status = 'accepting'
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;

  update public.member_invitations
  set status = 'delivery_failed', token_hash = null,
      failure_code = p_failure_code, expires_at = pg_catalog.clock_timestamp()
  where id = invitation_row.id;
  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, null, 'invite_delivery_failed',
    pg_catalog.jsonb_build_object(
      'chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version,
      'failureClass', p_failure_code
    )
  );
  return pg_catalog.jsonb_build_object('recorded', true);
end;
$function$;

revoke all on function public.finalize_member_invitation(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_member_invitation_recovery_user(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_member_invitation_activation(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_member_invitation_accept(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_member_invitation(uuid, uuid) to service_role;
grant execute on function public.get_member_invitation_recovery_user(uuid) to service_role;
grant execute on function public.complete_member_invitation_activation(uuid, uuid) to service_role;
grant execute on function public.fail_member_invitation_accept(uuid, text) to service_role;

comment on function public.finalize_member_invitation(uuid, uuid) is
  'Prepares only a banned, invitation-owned emailed-password identity and its active chapter membership while leaving the one-use invitation recoverable. Password bytes never cross this function.';
comment on function public.complete_member_invitation_activation(uuid, uuid) is
  'Consumes an invitation only after the exact prepared Auth identity is active, unbanned, chapter-enrolled, and role-enrolled.';
comment on function public.get_member_invitation_recovery_user(uuid) is
  'Returns only the exact invitation-labelled Auth identity and its pending/active provisioning state so a stale lease can delete pending or complete active without issuing another password.';

notify pgrst, 'reload schema';
