-- UB-RGT-05: Compass provider governance. This migration is inert on arrival:
-- the singleton starts disabled and there is deliberately NO attestation seed.
-- An MFA-enrolled, AAL2 admin must attest the live provider contract and then
-- enable Compass through audited RPCs before any request can reserve a slot.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Exact provider policy, strict per-role limits, and append-only evidence.
-- ---------------------------------------------------------------------------

create table public.compass_ai_policy (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  gateway text not null default 'vercel-ai-gateway'
    check (gateway = 'vercel-ai-gateway'),
  model text not null default 'google/gemini-3-flash'
    check (model = 'google/gemini-3-flash'),
  zero_data_retention boolean not null default true check (zero_data_retention),
  disallow_prompt_training boolean not null default true check (disallow_prompt_training),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.compass_ai_policy
  (id, enabled, gateway, model, zero_data_retention, disallow_prompt_training)
values
  (true, false, 'vercel-ai-gateway', 'google/gemini-3-flash', true, true);

create table public.compass_ai_role_limits (
  role text primary key
    check (role in ('member', 'steward', 'coordinator', 'advisor', 'admin', 'vp')),
  hourly_limit integer not null check (hourly_limit between 0 and 200),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.compass_ai_role_limits (role, hourly_limit) values
  ('member', 20),
  ('steward', 20),
  ('coordinator', 20),
  ('advisor', 20),
  ('admin', 20),
  ('vp', 20);

create table public.compass_ai_provider_attestations (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence_no bigint generated always as identity,
  status text not null check (status in ('verified', 'revoked')),
  gateway text not null check (pg_catalog.char_length(gateway) between 1 and 80),
  model text not null check (pg_catalog.char_length(model) between 1 and 120),
  zero_data_retention boolean not null check (zero_data_retention),
  disallow_prompt_training boolean not null check (disallow_prompt_training),
  evidence_ref text not null check (pg_catalog.char_length(evidence_ref) between 1 and 500),
  expires_at timestamptz,
  attested_by uuid not null,
  created_at timestamptz not null default now(),
  check (
    (status = 'verified' and expires_at is not null and expires_at > created_at)
    or (status = 'revoked')
  ),
  constraint compass_ai_provider_attestations_sequence_key unique (sequence_no)
);

alter table public.member_ai_requests
  add column compass_role text
    check (compass_role in ('member', 'steward', 'coordinator', 'advisor', 'admin', 'vp')),
  add column compass_limit integer check (compass_limit between 0 and 200),
  add column dispatch_authorized_at timestamptz,
  add constraint member_ai_requests_compass_governance_pair_check
    check ((compass_role is null) = (compass_limit is null));

alter table public.compass_ai_policy enable row level security;
alter table public.compass_ai_policy force row level security;
alter table public.compass_ai_role_limits enable row level security;
alter table public.compass_ai_role_limits force row level security;
alter table public.compass_ai_provider_attestations enable row level security;
alter table public.compass_ai_provider_attestations force row level security;

create policy mfa_assurance on public.compass_ai_policy
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.compass_ai_role_limits
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.compass_ai_provider_attestations
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.compass_ai_policy from public, anon, authenticated;
revoke all on table public.compass_ai_role_limits from public, anon, authenticated;
revoke all on table public.compass_ai_provider_attestations from public, anon, authenticated;

-- All changes join the existing immutable admin trail. Evidence references
-- remain in the dedicated attestation table; the shared audit stores only
-- bounded configuration facts, never member/provider content.
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
                    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
                    'set_staff_mfa_policy', 'set_compass_ai_enabled',
                    'set_compass_ai_role_limit', 'attest_compass_ai_provider'));

-- ---------------------------------------------------------------------------
-- 2. MFA-enrolled admin read and audited mutations.
-- ---------------------------------------------------------------------------

create function public.get_compass_ai_governance()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  attestation_ready boolean := false;
begin
  if caller is null
     or not public.member_has_role(array['admin'])
     or not private.has_second_factor(caller)
     or not private.mfa_satisfied() then
    raise exception 'MFA-verified admin role required' using errcode = '42501';
  end if;

  select p.* into policy
  from public.compass_ai_policy p
  where p.id = true;

  if policy.id is null then
    raise exception 'Compass AI policy unavailable' using errcode = '55000';
  end if;

  select a.* into latest_attestation
  from public.compass_ai_provider_attestations a
  where a.gateway = policy.gateway
    and a.model = policy.model
    and a.zero_data_retention = policy.zero_data_retention
    and a.disallow_prompt_training = policy.disallow_prompt_training
  order by sequence_no desc
  limit 1;

  attestation_ready := latest_attestation.id is not null
    and latest_attestation.status = 'verified'
    and latest_attestation.expires_at > now();

  return pg_catalog.jsonb_build_object(
    'enabled', policy.enabled,
    'gateway', policy.gateway,
    'model', policy.model,
    'requiredZeroDataRetention', policy.zero_data_retention,
    'requiredDisallowPromptTraining', policy.disallow_prompt_training,
    'attestationReady', attestation_ready,
    'latestAttestation', case when latest_attestation.id is null then null else
      pg_catalog.jsonb_build_object(
        'id', latest_attestation.id,
        'status', latest_attestation.status,
        'evidenceRef', latest_attestation.evidence_ref,
        'expiresAt', latest_attestation.expires_at,
        'attestedBy', latest_attestation.attested_by,
        'createdAt', latest_attestation.created_at
      ) end,
    'roleLimits', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('role', l.role, 'hourlyLimit', l.hourly_limit)
        order by case l.role
          when 'member' then 1 when 'steward' then 2 when 'coordinator' then 3
          when 'advisor' then 4 when 'admin' then 5 else 6 end
      )
      from public.compass_ai_role_limits l
    ), '[]'::jsonb),
    'attestations', coalesce((
      select pg_catalog.jsonb_agg(entry.item order by entry.sequence_no desc)
      from (
        select a.sequence_no, pg_catalog.jsonb_build_object(
          'id', a.id,
          'status', a.status,
          'gateway', a.gateway,
          'model', a.model,
          'evidenceRef', a.evidence_ref,
          'expiresAt', a.expires_at,
          'attestedBy', a.attested_by,
          'actorName', p.full_name,
          'createdAt', a.created_at
        ) as item
        from public.compass_ai_provider_attestations a
        left join public.member_profiles p on p.id = a.attested_by
        order by a.sequence_no desc
        limit 20
      ) entry
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.get_compass_ai_governance() from public, anon;
grant execute on function public.get_compass_ai_governance() to authenticated;

create function public.set_compass_ai_enabled(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  changed boolean := false;
begin
  if caller is null
     or not public.member_has_role(array['admin'])
     or not private.has_second_factor(caller)
     or not private.mfa_satisfied() then
    raise exception 'MFA-verified admin role required' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'enabled state required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  select p.* into policy
  from public.compass_ai_policy p
  where p.id = true
  for update;
  if policy.id is null then
    raise exception 'Compass AI policy unavailable' using errcode = '55000';
  end if;

  if p_enabled then
    select a.* into latest_attestation
    from public.compass_ai_provider_attestations a
    where a.gateway = policy.gateway
      and a.model = policy.model
      and a.zero_data_retention = policy.zero_data_retention
      and a.disallow_prompt_training = policy.disallow_prompt_training
    order by sequence_no desc
    limit 1;

    if latest_attestation.id is null
       or not (latest_attestation.status = 'verified'
               and latest_attestation.expires_at > now()) then
      raise exception 'current provider attestation required' using errcode = '55000';
    end if;
  end if;

  update public.compass_ai_policy
  set enabled = p_enabled, updated_at = now(), updated_by = caller
  where id = true and enabled is distinct from p_enabled;
  changed := found;

  if changed then
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'set_compass_ai_enabled',
            pg_catalog.jsonb_build_object('enabled', p_enabled,
                                          'gateway', policy.gateway,
                                          'model', policy.model));
  end if;

  return pg_catalog.jsonb_build_object('enabled', p_enabled, 'changed', changed);
end;
$$;

revoke all on function public.set_compass_ai_enabled(boolean) from public, anon;
grant execute on function public.set_compass_ai_enabled(boolean) to authenticated;

create function public.set_compass_ai_role_limit(p_role text, p_hourly_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  normalized_role text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_role, '')));
  previous_limit integer;
  changed boolean := false;
begin
  if caller is null
     or not public.member_has_role(array['admin'])
     or not private.has_second_factor(caller)
     or not private.mfa_satisfied() then
    raise exception 'MFA-verified admin role required' using errcode = '42501';
  end if;
  if normalized_role not in ('member', 'steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'unknown Compass role' using errcode = '22023';
  end if;
  if p_hourly_limit is null or p_hourly_limit < 0 or p_hourly_limit > 200 then
    raise exception 'hourly limit must be between 0 and 200' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  select l.hourly_limit into previous_limit
  from public.compass_ai_role_limits l
  where l.role = normalized_role
  for update;
  if not found then
    raise exception 'Compass role configuration unavailable' using errcode = '55000';
  end if;

  update public.compass_ai_role_limits
  set hourly_limit = p_hourly_limit, updated_at = now(), updated_by = caller
  where role = normalized_role and hourly_limit is distinct from p_hourly_limit;
  changed := found;

  if changed then
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'set_compass_ai_role_limit',
            pg_catalog.jsonb_build_object('role', normalized_role,
                                          'previousLimit', previous_limit,
                                          'hourlyLimit', p_hourly_limit));
  end if;

  return pg_catalog.jsonb_build_object('role', normalized_role,
                                       'hourlyLimit', p_hourly_limit,
                                       'changed', changed);
end;
$$;

revoke all on function public.set_compass_ai_role_limit(text, integer) from public, anon;
grant execute on function public.set_compass_ai_role_limit(text, integer) to authenticated;

create function public.attest_compass_ai_provider(
  p_evidence_ref text,
  p_expires_at timestamptz,
  p_confirm_zero_data_retention boolean,
  p_confirm_disallow_prompt_training boolean,
  p_status text default 'verified'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  policy public.compass_ai_policy%rowtype;
  attestation_id uuid;
  normalized_evidence text := pg_catalog.btrim(coalesce(p_evidence_ref, ''));
  normalized_status text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, '')));
  effective_expiry timestamptz;
begin
  if caller is null
     or not public.member_has_role(array['admin'])
     or not private.has_second_factor(caller)
     or not private.mfa_satisfied() then
    raise exception 'MFA-verified admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(normalized_evidence) < 1
     or pg_catalog.char_length(normalized_evidence) > 500 then
    raise exception 'evidence reference must be 1 to 500 characters' using errcode = '22023';
  end if;
  if normalized_status not in ('verified', 'revoked') then
    raise exception 'unknown attestation status' using errcode = '22023';
  end if;
  if normalized_status = 'verified' then
    if p_confirm_zero_data_retention is not true
       or p_confirm_disallow_prompt_training is not true then
      raise exception 'both provider controls must be confirmed' using errcode = '22023';
    end if;
    if p_expires_at is null
       or p_expires_at <= now() + interval '5 minutes'
       or p_expires_at > now() + interval '90 days' then
      raise exception 'attestation expiry must be within 90 days' using errcode = '22023';
    end if;
    effective_expiry := p_expires_at;
  else
    effective_expiry := null;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  select p.* into policy
  from public.compass_ai_policy p
  where p.id = true
  for update;
  if policy.id is null
     or not (policy.zero_data_retention is true
             and policy.disallow_prompt_training is true) then
    raise exception 'Compass AI policy unavailable' using errcode = '55000';
  end if;

  insert into public.compass_ai_provider_attestations
    (status, gateway, model, zero_data_retention, disallow_prompt_training,
     evidence_ref, expires_at, attested_by)
  values
    (normalized_status, policy.gateway, policy.model, policy.zero_data_retention,
     policy.disallow_prompt_training, normalized_evidence, effective_expiry, caller)
  returning id into attestation_id;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'attest_compass_ai_provider',
          pg_catalog.jsonb_build_object('attestationId', attestation_id,
                                        'status', normalized_status,
                                        'gateway', policy.gateway,
                                        'model', policy.model,
                                        'expiresAt', effective_expiry));

  return pg_catalog.jsonb_build_object('id', attestation_id,
                                       'status', normalized_status,
                                       'expiresAt', effective_expiry);
end;
$$;

revoke all on function public.attest_compass_ai_provider(text, timestamptz, boolean, boolean, text) from public, anon;
grant execute on function public.attest_compass_ai_provider(text, timestamptz, boolean, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Service-only reservation and final dispatch authorization.
-- ---------------------------------------------------------------------------

create function public.reserve_compass_ai_request(
  p_user_id uuid,
  p_gateway text,
  p_model text,
  p_zero_data_retention boolean,
  p_disallow_prompt_training boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  reservation_id uuid;
  assigned_role_count integer := 0;
  configured_role_count integer := 0;
  effective_role text;
  effective_limit integer;
  recent_user_count integer;
  recent_global_count integer;
begin
  if p_user_id is null
     or not exists (select 1 from public.member_profiles p where p.id = p_user_id) then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'member_unavailable');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  select p.* into policy
  from public.compass_ai_policy p
  where p.id = true;

  if policy.id is null
     or not (p_zero_data_retention is true
             and p_disallow_prompt_training is true)
     or p_gateway is distinct from policy.gateway
     or p_model is distinct from policy.model
     or not (policy.zero_data_retention is true
             and policy.disallow_prompt_training is true) then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'config');
  end if;
  if policy.enabled is not true then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'disabled');
  end if;

  select a.* into latest_attestation
  from public.compass_ai_provider_attestations a
  where a.gateway = policy.gateway
    and a.model = policy.model
    and a.zero_data_retention = policy.zero_data_retention
    and a.disallow_prompt_training = policy.disallow_prompt_training
  order by sequence_no desc
  limit 1;

  if latest_attestation.id is null
     or not (latest_attestation.status = 'verified'
             and latest_attestation.expires_at > now()) then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'unattested');
  end if;

  select pg_catalog.count(*)::integer into assigned_role_count
  from public.member_roles r
  where r.user_id = p_user_id
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');

  if assigned_role_count = 0 then
    select l.role, l.hourly_limit into effective_role, effective_limit
    from public.compass_ai_role_limits l
    where l.role = 'member';
    configured_role_count := case when found then 1 else 0 end;
    if configured_role_count <> 1 then
      return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
    end if;
  else
    select pg_catalog.count(*)::integer into configured_role_count
    from public.member_roles r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');

    if configured_role_count <> assigned_role_count then
      return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
    end if;

    select l.role, l.hourly_limit into effective_role, effective_limit
    from public.member_roles r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    order by l.hourly_limit asc,
      case l.role when 'steward' then 1 when 'coordinator' then 2
        when 'advisor' then 3 when 'admin' then 4 else 5 end
    limit 1;
  end if;

  if effective_role is null or effective_limit is null then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
  end if;

  delete from public.member_ai_requests
  where created_at < now() - interval '2 hours';

  select pg_catalog.count(*)::integer into recent_user_count
  from public.member_ai_requests
  where user_id = p_user_id
    and created_at >= now() - interval '1 hour';
  if recent_user_count >= effective_limit then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'role',
                                         'role', effective_role, 'limit', effective_limit);
  end if;

  select pg_catalog.count(*)::integer into recent_global_count
  from public.member_ai_requests
  where created_at >= now() - interval '1 hour';
  if recent_global_count >= 200 then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'shared');
  end if;

  insert into public.member_ai_requests (user_id, compass_role, compass_limit)
  values (p_user_id, effective_role, effective_limit)
  returning id into reservation_id;

  return pg_catalog.jsonb_build_object('id', reservation_id, 'cause', null,
                                       'role', effective_role, 'limit', effective_limit);
end;
$$;

revoke all on function public.reserve_compass_ai_request(uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.reserve_compass_ai_request(uuid, text, text, boolean, boolean) to service_role;

create function public.authorize_compass_ai_dispatch(
  p_request_id uuid,
  p_user_id uuid,
  p_gateway text,
  p_model text,
  p_zero_data_retention boolean,
  p_disallow_prompt_training boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.member_ai_requests%rowtype;
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  assigned_role_count integer := 0;
  configured_role_count integer := 0;
  effective_limit integer;
  recent_user_count integer;
begin
  if p_request_id is null or p_user_id is null then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'reservation');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-ai-global', 509)
  );

  select r.* into request_row
  from public.member_ai_requests r
  where r.id = p_request_id and r.user_id = p_user_id
  for update;
  if request_row.id is null
     or request_row.compass_role is null
     or request_row.compass_limit is null
     or request_row.dispatch_authorized_at is not null then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'reservation');
  end if;

  select p.* into policy
  from public.compass_ai_policy p
  where p.id = true;
  if policy.id is null
     or not (p_zero_data_retention is true
             and p_disallow_prompt_training is true)
     or p_gateway is distinct from policy.gateway
     or p_model is distinct from policy.model
     or not (policy.zero_data_retention is true
             and policy.disallow_prompt_training is true) then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'config');
  end if;
  if policy.enabled is not true then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'disabled');
  end if;

  select a.* into latest_attestation
  from public.compass_ai_provider_attestations a
  where a.gateway = policy.gateway
    and a.model = policy.model
    and a.zero_data_retention = policy.zero_data_retention
    and a.disallow_prompt_training = policy.disallow_prompt_training
  order by sequence_no desc
  limit 1;
  if latest_attestation.id is null
     or not (latest_attestation.status = 'verified'
             and latest_attestation.expires_at > now()) then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'unattested');
  end if;

  select pg_catalog.count(*)::integer into assigned_role_count
  from public.member_roles r
  where r.user_id = p_user_id
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');
  if assigned_role_count = 0 then
    select l.hourly_limit into effective_limit
    from public.compass_ai_role_limits l where l.role = 'member';
    configured_role_count := case when found then 1 else 0 end;
    if configured_role_count <> 1 then
      return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'role_unconfigured');
    end if;
  else
    select pg_catalog.count(*)::integer, pg_catalog.min(l.hourly_limit)
      into configured_role_count, effective_limit
    from public.member_roles r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');
    if configured_role_count <> assigned_role_count then
      return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'role_unconfigured');
    end if;
  end if;

  select pg_catalog.count(*)::integer into recent_user_count
  from public.member_ai_requests
  where user_id = p_user_id
    and created_at >= now() - interval '1 hour';
  if effective_limit is null or recent_user_count > effective_limit then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'role');
  end if;

  update public.member_ai_requests
  set dispatch_authorized_at = now(),
      compass_limit = effective_limit
  where id = request_row.id;

  return pg_catalog.jsonb_build_object('authorized', true, 'cause', null);
end;
$$;

revoke all on function public.authorize_compass_ai_dispatch(uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.authorize_compass_ai_dispatch(uuid, uuid, text, text, boolean, boolean) to service_role;
