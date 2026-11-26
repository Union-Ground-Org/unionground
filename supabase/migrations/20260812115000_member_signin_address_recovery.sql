-- UB-IDN-02: operator-assisted sign-in-address recovery.
--
-- PostgreSQL owns authorization, serialization, rates and the durable audit.
-- The server owns the supported GoTrue Admin calls. Only a SHA-256 digest of
-- the proposed address crosses into this ledger; current/proposed plaintext
-- addresses remain exclusively in Auth and the one server request.

create table private.member_signin_recoveries (
  id uuid primary key default extensions.gen_random_uuid(),
  actor uuid not null references auth.users(id) on delete cascade,
  target_user uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  new_email_hash text not null check (new_email_hash ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason in ('lost_inbox', 'address_retired')),
  status text not null default 'changing' check (status in ('changing', 'completed', 'failed')),
  failure_code text check (failure_code is null or failure_code in ('auth_unavailable', 'address_unavailable', 'auth_mismatch')),
  attempts integer not null default 1 check (attempts between 1 and 20),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  check (
    (status = 'changing' and failure_code is null and completed_at is null)
    or (status = 'completed' and failure_code is null and completed_at is not null)
    or (status = 'failed' and failure_code is not null and completed_at is null)
  )
);

create unique index member_signin_recoveries_one_changing_target_idx
  on private.member_signin_recoveries (target_user)
  where status = 'changing';
create index member_signin_recoveries_actor_created_idx
  on private.member_signin_recoveries (actor, created_at desc);

create table private.member_signin_recovery_limits (
  scope_key text not null,
  operation text not null check (operation in ('admin-hour', 'target-day')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope_key, operation)
);

revoke all on private.member_signin_recoveries from public;
revoke all on private.member_signin_recoveries from anon;
revoke all on private.member_signin_recoveries from authenticated;
revoke all on private.member_signin_recoveries from service_role;
revoke all on private.member_signin_recovery_limits from public;
revoke all on private.member_signin_recovery_limits from anon;
revoke all on private.member_signin_recovery_limits from authenticated;
revoke all on private.member_signin_recovery_limits from service_role;

alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in (
    'grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
    'recover_signin_address', 'recover_signin_address_failed'
  ));

create function private.consume_member_signin_recovery_limit(
  p_scope_key text,
  p_operation text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row private.member_signin_recovery_limits%rowtype;
  moment timestamptz := clock_timestamp();
begin
  if p_scope_key is null or p_operation not in ('admin-hour', 'target-day')
     or p_limit < 1 or p_window <= interval '0 seconds' then
    raise exception 'invalid recovery rate limit' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-signin-recovery-rate:' || p_scope_key || ':' || p_operation, 509)
  );
  select * into current_row
  from private.member_signin_recovery_limits
  where scope_key = p_scope_key and operation = p_operation
  for update;

  if not found then
    insert into private.member_signin_recovery_limits
      (scope_key, operation, window_started_at, request_count)
    values (p_scope_key, p_operation, moment, 1);
    return true;
  end if;
  if current_row.window_started_at + p_window <= moment then
    update private.member_signin_recovery_limits
    set window_started_at = moment, request_count = 1
    where scope_key = p_scope_key and operation = p_operation;
    return true;
  end if;
  if current_row.request_count >= p_limit then
    return false;
  end if;
  update private.member_signin_recovery_limits
  set request_count = request_count + 1
  where scope_key = p_scope_key and operation = p_operation;
  return true;
end;
$$;

revoke all on function private.consume_member_signin_recovery_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

create function public.admin_search_recovery_members(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  if caller_chapter is null or pg_catalog.char_length(needle) < 2 then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id,
      'fullName', s.full_name,
      'initials', s.initials,
      'memberSince', s.member_since,
      'roles', coalesce((
        select pg_catalog.jsonb_agg(r.role order by r.role)
        from public.member_roles r where r.user_id = s.id
      ), '[]'::jsonb)
    ) order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since
      from public.member_profiles p
      where p.chapter_id = caller_chapter
        and p.id <> caller
        and p.full_name ilike '%' || needle || '%' escape '\'
      order by p.full_name, p.id
      limit 20
    ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_search_recovery_members(text) from public, anon, authenticated, service_role;
grant execute on function public.admin_search_recovery_members(text) to authenticated;

create function public.begin_member_signin_recovery(
  p_target_user uuid,
  p_new_email_hash text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  target_chapter text;
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_new_email_hash, '')));
  clean_reason text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_reason, '')));
  operation_row private.member_signin_recoveries%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_target_user is null or p_target_user = caller then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  select p.chapter_id into target_chapter from public.member_profiles p where p.id = p_target_user;
  if caller_chapter is null or target_chapter is distinct from caller_chapter then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$'
     or clean_reason not in ('lost_inbox', 'address_retired') then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  if not private.consume_member_signin_recovery_limit(
    'admin:' || caller::text, 'admin-hour', 5, interval '1 hour'
  ) or not private.consume_member_signin_recovery_limit(
    'target:' || p_target_user::text, 'target-day', 3, interval '1 day'
  ) then
    raise exception 'recovery rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-signin-recovery-target:' || p_target_user::text, 509)
  );
  select * into operation_row
  from private.member_signin_recoveries
  where target_user = p_target_user and status = 'changing'
  for update;

  if found then
    if operation_row.actor = caller
       and operation_row.new_email_hash = clean_hash
       and operation_row.reason = clean_reason then
      update private.member_signin_recoveries
      set attempts = least(attempts + 1, 20), updated_at = clock_timestamp()
      where id = operation_row.id;
      return pg_catalog.jsonb_build_object(
        'accepted', true, 'operationId', operation_row.id, 'retry', true
      );
    end if;
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  -- Do not reveal whether the proposed address belongs to an Auth user or a
  -- still-live invitation. The endpoint maps every branch to generic copy.
  if exists (
    select 1 from auth.users u
    where u.email is not null
      and pg_catalog.encode(
        extensions.digest(pg_catalog.lower(pg_catalog.btrim(u.email)), 'sha256'), 'hex'
      ) = clean_hash
  ) or exists (
    select 1 from public.member_invitations i
    where i.status in ('pending', 'accepting')
      and pg_catalog.encode(extensions.digest(i.normalized_email, 'sha256'), 'hex') = clean_hash
  ) then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  insert into private.member_signin_recoveries
    (actor, target_user, chapter_id, new_email_hash, reason)
  values (caller, p_target_user, caller_chapter, clean_hash, clean_reason)
  returning * into operation_row;

  return pg_catalog.jsonb_build_object(
    'accepted', true, 'operationId', operation_row.id, 'retry', false
  );
end;
$$;

revoke all on function public.begin_member_signin_recovery(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_member_signin_recovery(uuid, text, text) to authenticated;

create function public.finalize_member_signin_recovery(
  p_operation_id uuid,
  p_sessions_revoked boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  operation_row private.member_signin_recoveries%rowtype;
  auth_hash text;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_operation_id is null or p_sessions_revoked is not true then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  select * into operation_row
  from private.member_signin_recoveries
  where id = p_operation_id
  for update;
  if not found or operation_row.actor <> caller or operation_row.status <> 'changing' then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  if caller_chapter is distinct from operation_row.chapter_id
     or not exists (
       select 1 from public.member_profiles p
       where p.id = operation_row.target_user and p.chapter_id = operation_row.chapter_id
     ) then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;

  select pg_catalog.encode(
    extensions.digest(pg_catalog.lower(pg_catalog.btrim(u.email)), 'sha256'), 'hex'
  ) into auth_hash
  from auth.users u
  where u.id = operation_row.target_user and u.email is not null;
  if auth_hash is distinct from operation_row.new_email_hash then
    raise exception 'recovery unavailable' using errcode = '22023';
  end if;

  update private.member_signin_recoveries
  set status = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = operation_row.id;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (
    caller,
    'recover_signin_address',
    operation_row.target_user,
    pg_catalog.jsonb_build_object(
      'operationId', operation_row.id,
      'reason', operation_row.reason,
      'sessionsRevoked', true
    )
  );

  return pg_catalog.jsonb_build_object('completed', true, 'operationId', operation_row.id);
end;
$$;

revoke all on function public.finalize_member_signin_recovery(uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_member_signin_recovery(uuid, boolean) to authenticated;

create function public.fail_member_signin_recovery(
  p_operation_id uuid,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_failure text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_failure_code, '')));
  operation_row private.member_signin_recoveries%rowtype;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if clean_failure not in ('auth_unavailable', 'address_unavailable', 'auth_mismatch') then
    raise exception 'invalid recovery failure' using errcode = '22023';
  end if;
  select * into operation_row
  from private.member_signin_recoveries
  where id = p_operation_id
  for update;
  if not found or operation_row.actor <> caller or operation_row.status <> 'changing' then
    raise exception 'recovery unavailable' using errcode = '42501';
  end if;

  update private.member_signin_recoveries
  set status = 'failed', failure_code = clean_failure, updated_at = clock_timestamp()
  where id = operation_row.id;

  insert into public.member_admin_audit (actor, action, target_user, detail)
  values (
    caller,
    'recover_signin_address_failed',
    operation_row.target_user,
    pg_catalog.jsonb_build_object(
      'operationId', operation_row.id,
      'reason', operation_row.reason,
      'failureCode', clean_failure
    )
  );

  return pg_catalog.jsonb_build_object('completed', false, 'operationId', operation_row.id);
end;
$$;

revoke all on function public.fail_member_signin_recovery(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fail_member_signin_recovery(uuid, text) to authenticated;

comment on function public.begin_member_signin_recovery(uuid, text, text) is
  'UB-IDN-02 admin+MFA same-chapter authorization and digest-only serialized recovery claim.';
comment on function public.finalize_member_signin_recovery(uuid, boolean) is
  'UB-IDN-02 exact Auth digest proof and mandatory target-session revocation before audit completion.';
