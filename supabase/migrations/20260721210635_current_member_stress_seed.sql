-- Private, ledgered stress-data support for the current member schema.
-- Public RPCs are callable only by service_role; private tables are never Data API exposed.

create table private.member_stress_runs (
  id uuid primary key,
  dataset_version text not null,
  target_ref text not null,
  member_count integer not null check (member_count between 1 and 100000),
  login_count integer not null check (login_count between 0 and member_count),
  config_hash text not null check (config_hash ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('ledgered', 'applying', 'applied', 'verified', 'removing', 'removed')),
  protected_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz,
  removed_at timestamptz
);

create table private.member_stress_ledger (
  run_id uuid not null references private.member_stress_runs(id) on delete restrict,
  ordinal integer not null check (ordinal > 0),
  user_id uuid not null,
  email text not null,
  login_capable boolean not null,
  created_at timestamptz not null default now(),
  primary key (run_id, ordinal),
  unique (run_id, user_id),
  unique (run_id, email)
);

create index if not exists member_messages_user_id_idx on public.member_messages(user_id);
create index if not exists member_rights_progress_user_id_idx on public.member_rights_progress(user_id);

revoke all on table private.member_stress_runs, private.member_stress_ledger from public, anon, authenticated, service_role;

create or replace function private.member_stress_uuid(p_value text)
returns uuid
language sql
immutable
strict
set search_path = ''
as $$
  select (
    substr(digest, 1, 8) || '-' ||
    substr(digest, 9, 4) || '-4' ||
    substr(digest, 14, 3) || '-a' ||
    substr(digest, 18, 3) || '-' ||
    substr(digest, 21, 12)
  )::uuid
  from (select pg_catalog.md5(p_value) as digest) value;
$$;

create or replace function private.member_stress_user_id(p_run_id uuid, p_ordinal integer)
returns uuid
language sql
immutable
strict
set search_path = ''
as $$
  select private.member_stress_uuid(p_run_id::text || ':user:' || p_ordinal::text);
$$;

create or replace function private.member_stress_email(p_run_id uuid, p_ordinal integer)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select 'stress-' || substr(replace(p_run_id::text, '-', ''), 1, 8) || '-' ||
    lpad(p_ordinal::text, 6, '0') || '@loadtest.example.com';
$$;

create or replace function private.member_stress_authorize(p_target_ref text, p_confirm_token text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'member stress RPC requires service_role';
  end if;
  if p_target_ref <> 'productionprojectref' then
    raise exception 'member stress target mismatch';
  end if;
  if p_confirm_token <> 'SEED_CURRENT_MEMBER_STRESS' then
    raise exception 'member stress confirmation mismatch';
  end if;
end;
$$;

create or replace function private.member_stress_protected_snapshot(p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(snapshot) order by snapshot.email, snapshot.id), '[]'::jsonb)
  from (
    select
      users.id,
      lower(users.email) as email,
      (select count(*) from public.member_profiles rows where rows.id = users.id) as profiles,
      (select count(*) from public.member_notifications rows where rows.user_id = users.id) as notifications,
      (select count(*) from public.member_conversations rows where rows.user_id = users.id) as conversations,
      (select count(*) from public.member_messages rows where rows.user_id = users.id) as messages,
      (select count(*) from public.member_cases rows where rows.user_id = users.id) as cases,
      (select count(*) from public.member_rights_progress rows where rows.user_id = users.id) as rights_progress,
      (select count(*) from public.member_action_log rows where rows.user_id = users.id) as action_log
    from auth.users users
    where coalesce(users.raw_app_meta_data ->> 'member_stress_run_id', '') <> p_run_id::text
  ) snapshot;
$$;

create or replace function public.member_stress_begin(
  p_run_id uuid,
  p_dataset_version text,
  p_member_count integer,
  p_login_count integer,
  p_config_hash text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_run private.member_stress_runs%rowtype;
  collision_count bigint;
  ledger_count bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_member_count not between 1 and 100000 or p_login_count not between 0 and p_member_count then
    raise exception 'invalid member or login count';
  end if;
  if p_dataset_version <> 'current-member-v1' or p_config_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid dataset version or config hash';
  end if;

  select * into existing_run from private.member_stress_runs where id = p_run_id;
  if found then
    if existing_run.dataset_version <> p_dataset_version
      or existing_run.member_count <> p_member_count
      or existing_run.login_count <> p_login_count
      or existing_run.config_hash <> p_config_hash
      or existing_run.target_ref <> p_target_ref then
      raise exception 'run id already exists with different configuration';
    end if;
    select count(*) into ledger_count from private.member_stress_ledger where run_id = p_run_id;
    if ledger_count <> p_member_count then raise exception 'existing run has incomplete ledger'; end if;
    if existing_run.state = 'removed' then
      select count(*) into collision_count
      from private.member_stress_ledger ledger
      join auth.users users on users.id = ledger.user_id or lower(users.email) = ledger.email
      where ledger.run_id = p_run_id;
      if collision_count <> 0 then raise exception 'restart preflight found existing auth collisions'; end if;
      if exists (select 1 from private.member_stress_runs where id <> p_run_id and state <> 'removed') then
        raise exception 'another member stress run is active';
      end if;
      update private.member_stress_runs
      set state = 'ledgered', protected_snapshot = private.member_stress_protected_snapshot(p_run_id),
        updated_at = now(), verified_at = null, removed_at = null
      where id = p_run_id;
      return jsonb_build_object('run_id', p_run_id, 'state', 'ledgered', 'ledger_rows', ledger_count,
        'resumed', false, 'restarted', true);
    end if;
    return jsonb_build_object('run_id', p_run_id, 'state', existing_run.state, 'ledger_rows', ledger_count, 'resumed', true);
  end if;

  if exists (select 1 from private.member_stress_runs where state <> 'removed') then
    raise exception 'another member stress run is active';
  end if;

  with manifest as (
    select private.member_stress_user_id(p_run_id, ordinal) as user_id,
      private.member_stress_email(p_run_id, ordinal) as email
    from generate_series(1, p_member_count) ordinal
  )
  select count(*) into collision_count
  from manifest
  join auth.users users on users.id = manifest.user_id or lower(users.email) = manifest.email;
  if collision_count <> 0 then raise exception 'preflight found existing auth collisions'; end if;

  insert into private.member_stress_runs (
    id, dataset_version, target_ref, member_count, login_count, config_hash, state, protected_snapshot
  ) values (
    p_run_id, p_dataset_version, p_target_ref, p_member_count, p_login_count, p_config_hash, 'ledgered',
    private.member_stress_protected_snapshot(p_run_id)
  );

  insert into private.member_stress_ledger (run_id, ordinal, user_id, email, login_capable)
  select p_run_id, ordinal, private.member_stress_user_id(p_run_id, ordinal),
    private.member_stress_email(p_run_id, ordinal), ordinal <= p_login_count
  from generate_series(1, p_member_count) ordinal;

  select count(*) into ledger_count from private.member_stress_ledger where run_id = p_run_id;
  if ledger_count <> p_member_count then raise exception 'ledger creation incomplete'; end if;
  return jsonb_build_object('run_id', p_run_id, 'state', 'ledgered', 'ledger_rows', ledger_count, 'resumed', false);
end;
$$;

create or replace function public.member_stress_apply_batch(
  p_run_id uuid,
  p_start_ordinal integer,
  p_batch_count integer,
  p_password text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run private.member_stress_runs%rowtype;
  password_hash text;
  selected_count integer;
  collision_count integer;
  total_users bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then raise exception 'run cannot be applied in state %', run.state; end if;
  if p_start_ordinal < 1 or p_batch_count not between 1 and 5000 then raise exception 'invalid batch range'; end if;

  select count(*) into selected_count from private.member_stress_ledger
  where run_id = p_run_id and ordinal between p_start_ordinal and p_start_ordinal + p_batch_count - 1;
  if selected_count = 0 then raise exception 'empty batch'; end if;

  select count(*) into collision_count
  from private.member_stress_ledger ledger
  join auth.users users on users.id = ledger.user_id or lower(users.email) = ledger.email
  where ledger.run_id = p_run_id
    and ledger.ordinal between p_start_ordinal and p_start_ordinal + p_batch_count - 1
    and (users.id <> ledger.user_id or lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'member_stress_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'batch preflight found non-owned auth rows'; end if;

  if exists (
    select 1 from private.member_stress_ledger
    where run_id = p_run_id and login_capable
      and ordinal between p_start_ordinal and p_start_ordinal + p_batch_count - 1
  ) then
    if char_length(coalesce(p_password, '')) < 24 then raise exception 'stress password is too short'; end if;
    password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  end if;

  update private.member_stress_runs set state = 'applying', updated_at = now() where id = p_run_id and state = 'ledgered';

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous
  )
  select
    '00000000-0000-0000-0000-000000000000'::uuid,
    ledger.user_id, 'authenticated', 'authenticated', ledger.email,
    case when ledger.login_capable then password_hash else '' end,
    now(), '', '', '', '',
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'),
      'member_stress_run_id', p_run_id::text, 'member_stress_ordinal', ledger.ordinal),
    jsonb_build_object('first_name', 'Stress', 'full_name', 'Stress Member ' || lpad(ledger.ordinal::text, 6, '0'),
      'initials', 'SM', 'name', 'Stress Member ' || lpad(ledger.ordinal::text, 6, '0')),
    now(), now(), false, false
  from private.member_stress_ledger ledger
  where ledger.run_id = p_run_id
    and ledger.ordinal between p_start_ordinal and p_start_ordinal + p_batch_count - 1
  on conflict do nothing;

  insert into auth.identities (id, provider_id, user_id, identity_data, provider, created_at, updated_at)
  select
    private.member_stress_uuid(p_run_id::text || ':identity:' || ledger.ordinal::text),
    ledger.user_id::text, ledger.user_id,
    jsonb_build_object('sub', ledger.user_id::text, 'email', ledger.email, 'email_verified', true,
      'phone_verified', false, 'member_stress_run_id', p_run_id::text),
    'email', now(), now()
  from private.member_stress_ledger ledger
  join auth.users users on users.id = ledger.user_id
  where ledger.run_id = p_run_id
    and ledger.ordinal between p_start_ordinal and p_start_ordinal + p_batch_count - 1
  on conflict do nothing;

  select count(*) into total_users from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and users.raw_app_meta_data ->> 'member_stress_run_id' = p_run_id::text;
  if total_users = run.member_count then
    update private.member_stress_runs set state = 'applied', updated_at = now() where id = p_run_id;
  end if;
  return jsonb_build_object('selected', selected_count, 'auth_users', total_users,
    'state', case when total_users = run.member_count then 'applied' else 'applying' end);
end;
$$;

create or replace function public.member_stress_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  run private.member_stress_runs%rowtype;
  result jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'member stress RPC requires service_role'; end if;
  select * into run from private.member_stress_runs where id = p_run_id;
  if not found then raise exception 'unknown member stress run'; end if;
  select jsonb_build_object(
    'run_id', run.id,
    'state', run.state,
    'members_expected', run.member_count,
    'logins_expected', run.login_count,
    'ledger_rows', (select count(*) from private.member_stress_ledger where run_id = p_run_id),
    'auth_users', (select count(*) from auth.users users join private.member_stress_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id),
    'identities', (select count(*) from auth.identities rows join private.member_stress_ledger ledger on ledger.user_id = rows.user_id where ledger.run_id = p_run_id),
    'profiles', (select count(*) from public.member_profiles rows join private.member_stress_ledger ledger on ledger.user_id = rows.id where ledger.run_id = p_run_id),
    'notifications', (select count(*) from public.member_notifications rows join private.member_stress_ledger ledger on ledger.user_id = rows.user_id where ledger.run_id = p_run_id),
    'conversations', (select count(*) from public.member_conversations rows join private.member_stress_ledger ledger on ledger.user_id = rows.user_id where ledger.run_id = p_run_id),
    'messages', (select count(*) from public.member_messages rows join private.member_stress_ledger ledger on ledger.user_id = rows.user_id where ledger.run_id = p_run_id),
    'cases', (select count(*) from public.member_cases rows join private.member_stress_ledger ledger on ledger.user_id = rows.user_id where ledger.run_id = p_run_id),
    'rights_progress', (select count(*) from public.member_rights_progress rows join private.member_stress_ledger ledger on ledger.user_id = rows.user_id where ledger.run_id = p_run_id),
    'action_log', (select count(*) from public.member_action_log rows join private.member_stress_ledger ledger on ledger.user_id = rows.user_id where ledger.run_id = p_run_id),
    'protected_unchanged', run.protected_snapshot = private.member_stress_protected_snapshot(p_run_id)
  ) into result;
  return result;
end;
$$;

create or replace function public.member_stress_verify(p_run_id uuid, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run private.member_stress_runs%rowtype;
  result jsonb;
  matching_passwords bigint;
  passed boolean;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'member stress RPC requires service_role'; end if;
  if char_length(coalesce(p_password, '')) < 24 then raise exception 'stress password is too short'; end if;
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state not in ('applied', 'verified') then raise exception 'run is not fully applied'; end if;
  result := public.member_stress_status(p_run_id);
  select count(*) into matching_passwords
  from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id and ledger.login_capable
    and users.encrypted_password = extensions.crypt(p_password, users.encrypted_password);
  passed :=
    (result ->> 'ledger_rows')::bigint = run.member_count
    and (result ->> 'auth_users')::bigint = run.member_count
    and (result ->> 'identities')::bigint = run.member_count
    and (result ->> 'profiles')::bigint = run.member_count
    and (result ->> 'notifications')::bigint = run.member_count * 3::bigint
    and (result ->> 'conversations')::bigint = run.member_count * 2::bigint
    and (result ->> 'messages')::bigint = run.member_count * 2::bigint
    and (result ->> 'cases')::bigint = run.member_count * 4::bigint
    and (result ->> 'rights_progress')::bigint = run.member_count
    and (result ->> 'action_log')::bigint = run.member_count * 3::bigint
    and matching_passwords = run.login_count
    and (result ->> 'protected_unchanged')::boolean;
  if passed then update private.member_stress_runs set state = 'verified', verified_at = now(), updated_at = now() where id = p_run_id; end if;
  return result || jsonb_build_object('state', case when passed then 'verified' else run.state end,
    'matching_passwords', matching_passwords, 'ok', passed);
end;
$$;

create or replace function public.member_stress_begin_remove(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run private.member_stress_runs%rowtype;
  collision_count bigint;
  remaining bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then return jsonb_build_object('state', 'removed', 'remaining', 0, 'resumed', true); end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified', 'removing') then raise exception 'run cannot be removed'; end if;
  if run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) then
    raise exception 'non-stress user snapshot changed; removal stopped';
  end if;
  select count(*) into collision_count
  from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and (lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'member_stress_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'removal preflight found non-owned auth rows'; end if;
  update private.member_stress_runs set state = 'removing', updated_at = now() where id = p_run_id;
  select count(*) into remaining from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  return jsonb_build_object('state', 'removing', 'remaining', remaining, 'resumed', run.state = 'removing');
end;
$$;

create or replace function public.member_stress_remove_batch(
  p_run_id uuid,
  p_batch_count integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run private.member_stress_runs%rowtype;
  deleted_count bigint;
  remaining bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 5000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then return jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed'); end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  with selected as (
    select users.id
    from auth.users users
    join private.member_stress_ledger ledger on ledger.user_id = users.id
    where ledger.run_id = p_run_id
      and lower(users.email) = ledger.email
      and users.raw_app_meta_data ->> 'member_stress_run_id' = p_run_id::text
    order by ledger.ordinal
    limit p_batch_count
  ), deleted as (
    delete from auth.users users using selected where users.id = selected.id returning users.id
  ) select count(*) into deleted_count from deleted;

  select count(*) into remaining from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  if remaining = 0 then
    if run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) then
      raise exception 'non-stress user snapshot changed during removal';
    end if;
    update private.member_stress_runs set state = 'removed', removed_at = now(), updated_at = now() where id = p_run_id;
  end if;
  return jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
end;
$$;

revoke all on function private.member_stress_uuid(text) from public, anon, authenticated, service_role;
revoke all on function private.member_stress_user_id(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.member_stress_email(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.member_stress_authorize(text, text) from public, anon, authenticated, service_role;
revoke all on function private.member_stress_protected_snapshot(uuid) from public, anon, authenticated, service_role;
revoke all on function public.member_stress_begin(uuid, text, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.member_stress_apply_batch(uuid, integer, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.member_stress_status(uuid) from public, anon, authenticated;
revoke all on function public.member_stress_verify(uuid, text) from public, anon, authenticated;
revoke all on function public.member_stress_begin_remove(uuid, text, text) from public, anon, authenticated;
revoke all on function public.member_stress_remove_batch(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.member_stress_begin(uuid, text, integer, integer, text, text, text) to service_role;
grant execute on function public.member_stress_apply_batch(uuid, integer, integer, text, text, text) to service_role;
grant execute on function public.member_stress_status(uuid) to service_role;
grant execute on function public.member_stress_verify(uuid, text) to service_role;
grant execute on function public.member_stress_begin_remove(uuid, text, text) to service_role;
grant execute on function public.member_stress_remove_batch(uuid, integer, text, text) to service_role;
