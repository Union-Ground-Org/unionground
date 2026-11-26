-- REQ-UG-PLATFORM-AI-PROVIDERS-20260930
-- Owner-approved mesh first, centrally managed Fireworks failover. No provider
-- is enabled, credential adopted, operator granted or attestation seeded here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Dedicated registry: the separate catalog-claim operator migration is not a
-- prerequisite for AI rollout. Account deletion removes this capability.
create table private.compass_platform_operators (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_note text not null check (pg_catalog.char_length(pg_catalog.btrim(granted_note)) between 1 and 240),
  granted_at timestamptz not null default pg_catalog.now(),
  revoked_at timestamptz
);
alter table private.compass_platform_operators enable row level security;
alter table private.compass_platform_operators force row level security;
revoke all on table private.compass_platform_operators from public, anon, authenticated, service_role;
create trigger a00_case_graph_lock before insert or update or delete on private.compass_platform_operators
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.compass_platform_operators
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, exclusion_reason, note, reviewed_at)
values ('private', 'compass_platform_operators', 'user_id', 'cascade', 'excluded_with_reason',
  null, 'auth_user_fk', 'Platform AI capability registry, not caller-owned portable content.',
  'ON DELETE CASCADE removes AI operator authority with the account.', current_date);
insert into private.account_lifecycle_trigger_review(kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger' and schema_name = 'private' and table_name = 'compass_platform_operators'
  and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');

create table private.compass_platform_fireworks (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  model text not null default 'accounts/fireworks/models/gpt-oss-120b'
    check (model ~ '^accounts/fireworks/models/[a-z0-9.-]{1,80}$'),
  credential_ref uuid,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default pg_catalog.now(),
  check (not enabled or credential_ref is not null)
);
insert into private.compass_platform_fireworks (id) values (true);
alter table private.compass_platform_fireworks enable row level security;
alter table private.compass_platform_fireworks force row level security;
revoke all on table private.compass_platform_fireworks from public, anon, authenticated, service_role;

-- Scope snapshots deliberately are not FKs: deleting/changing an organization
-- must invalidate the request, never rewrite its original authorization scope.
alter table public.member_ai_requests
  add column compass_organization_id uuid,
  add column compass_gateway text,
  add column compass_model text,
  add column embedding_authorized_at timestamptz,
  add column failover_authorized_at timestamptz,
  add column failover_revision bigint,
  add column failover_model text;

create function private.compass_platform_operator()
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(
    private.mfa_satisfied() and private.has_second_factor((select auth.uid()))
    and exists (
      select 1 from private.compass_platform_operators o
      join auth.users u on u.id = o.user_id
      join auth.sessions s on s.user_id = u.id
      left join private.member_mfa_reset_boundaries b on b.user_id = u.id
      where o.user_id = (select auth.uid()) and o.revoked_at is null
        and u.deleted_at is null and (u.banned_until is null or u.banned_until <= pg_catalog.now())
        and s.id::text = (select auth.jwt() ->> 'session_id') and s.aal = 'aal2'
        and (s.not_after is null or s.not_after > pg_catalog.now())
        and s.created_at > coalesce(b.invalid_before, '-infinity'::timestamptz)
        and not exists (select 1 from private.member_mfa_recovery_locks l where l.user_id = u.id)
    ), false)
$$;
revoke all on function private.compass_platform_operator() from public, anon, authenticated, service_role;

create function public.set_compass_platform_operator(p_user_id uuid, p_active boolean, p_note text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or p_active is null or p_note is null
    or pg_catalog.char_length(pg_catalog.btrim(p_note)) not between 1 and 240
    or p_note ~ '[[:cntrl:]]' then
    raise exception 'operator invalid' using errcode = '22023';
  end if;
  if p_active then
    insert into private.compass_platform_operators(user_id, granted_note)
    values (p_user_id, pg_catalog.btrim(p_note))
    on conflict (user_id) do update set granted_note = excluded.granted_note,
      granted_at = pg_catalog.now(), revoked_at = null;
  else
    update private.compass_platform_operators set revoked_at = pg_catalog.now() where user_id = p_user_id;
  end if;
  insert into public.member_admin_audit(actor, action, target_user, detail)
  values (null, case when p_active then 'grant_role' else 'revoke_role' end, p_user_id,
    pg_catalog.jsonb_build_object('role', 'platform_ai_operator'));
end;
$$;
revoke all on function public.set_compass_platform_operator(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.set_compass_platform_operator(uuid, boolean, text) to service_role;

create function public.get_compass_platform_ai()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare config private.compass_platform_fireworks%rowtype;
  attestation public.compass_ai_provider_attestations%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'sign in required' using errcode = '42501'; end if;
  select * into config from private.compass_platform_fireworks where id;
  select * into attestation from public.compass_ai_provider_attestations
    where gateway = 'union-ground-fireworks' and model = config.model order by sequence_no desc limit 1;
  return pg_catalog.jsonb_build_object(
    'primary', 'union-ground-mesh', 'fallback', 'union-ground-fireworks', 'model', config.model,
    'enabled', config.enabled and config.credential_ref is not null
      and coalesce(attestation.status = 'verified' and attestation.expires_at > pg_catalog.now(), false),
    'canManage', private.compass_platform_operator(),
    'attestationExpiresAt', attestation.expires_at);
end;
$$;
revoke all on function public.get_compass_platform_ai() from public, anon, service_role;
grant execute on function public.get_compass_platform_ai() to authenticated;

-- Install one reference and append an attestation. Both secure key entry and
-- explicit adoption call this non-executable helper under the global lock.
create function private.install_compass_fireworks(p_model text, p_secret uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare previous uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  select credential_ref into previous from private.compass_platform_fireworks where id for update;
  update private.compass_platform_fireworks set enabled = true, model = p_model, credential_ref = p_secret,
    revision = revision + 1, updated_at = pg_catalog.now() where id;
  insert into public.compass_ai_provider_attestations
    (status, gateway, model, zero_data_retention, disallow_prompt_training, evidence_ref, expires_at, attested_by)
  values ('verified', 'union-ground-fireworks', p_model, true, true,
    'Platform operator confirms Fireworks open-model chat-completions terms; optional prompt logging disabled. https://docs.fireworks.ai/guides/security_compliance/data_handling',
    pg_catalog.now() + interval '30 days', (select auth.uid()));
  insert into public.member_admin_audit(actor, action, detail)
  values ((select auth.uid()), 'attest_compass_ai_provider',
    pg_catalog.jsonb_build_object('gateway', 'union-ground-fireworks', 'model', p_model, 'status', 'verified'));
  if previous is not null and previous is distinct from p_secret then delete from vault.secrets where id = previous; end if;
end;
$$;
revoke all on function private.install_compass_fireworks(text, uuid) from public, anon, authenticated, service_role;

create function public.configure_compass_platform_fireworks(p_model text, p_api_key text, p_terms_acknowledged boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare secret_id uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.compass_platform_operator() then raise exception 'MFA-verified platform AI operator required' using errcode = '42501'; end if;
  if p_terms_acknowledged is not true or p_model is null
    or p_model !~ '^accounts/fireworks/models/[a-z0-9.-]{1,80}$'
    or p_api_key is null or pg_catalog.char_length(p_api_key) not between 16 and 512
    or p_api_key ~ '[[:space:][:cntrl:]]' then raise exception 'configuration invalid' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  secret_id := vault.create_secret(p_api_key, 'compass-platform-fireworks-' || pg_catalog.gen_random_uuid()::text,
    'Union Ground centrally managed Fireworks failover');
  perform private.install_compass_fireworks(p_model, secret_id);
  return public.get_compass_platform_ai();
end;
$$;
revoke all on function public.configure_compass_platform_fireworks(text, text, boolean) from public, anon, service_role;
grant execute on function public.configure_compass_platform_fireworks(text, text, boolean) to authenticated;

create function public.adopt_compass_platform_fireworks(p_organization_id uuid, p_terms_acknowledged boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare connector public.organization_integrations%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.compass_platform_operator() then raise exception 'MFA-verified platform AI operator required' using errcode = '42501'; end if;
  -- Adoption is explicit and limited to an organization the operator also
  -- administers. A platform role is not permission to take a customer's key.
  if p_terms_acknowledged is not true or p_organization_id is distinct from private.mi1_require_integration_admin() then
    raise exception 'connector adoption not authorized' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  select * into connector from public.organization_integrations
    where organization_id = p_organization_id and provider = 'ai_connector_fireworks'
      and status = 'connected' and credential_ref is not null for update;
  if connector.id is null or not exists (select 1 from vault.secrets where id = connector.credential_ref::uuid) then
    raise exception 'connector unavailable' using errcode = '55000';
  end if;
  perform private.install_compass_fireworks(connector.default_settings ->> 'model', connector.credential_ref::uuid);
  update public.organization_integrations set status = 'disabled', credential_ref = null, updated_at = pg_catalog.now()
    where id = connector.id;
  perform private.mi1_write_tenant_audit(p_organization_id, 'integration_provider_changed',
    pg_catalog.jsonb_build_object('organizationId', p_organization_id, 'provider', 'ai_connector_fireworks', 'status', 'disabled'));
  return public.get_compass_platform_ai();
end;
$$;
revoke all on function public.adopt_compass_platform_fireworks(uuid, boolean) from public, anon, service_role;
grant execute on function public.adopt_compass_platform_fireworks(uuid, boolean) to authenticated;

create function public.disable_compass_platform_fireworks()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare config private.compass_platform_fireworks%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.compass_platform_operator() then raise exception 'MFA-verified platform AI operator required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  select * into config from private.compass_platform_fireworks where id for update;
  update private.compass_platform_fireworks set enabled = false, credential_ref = null,
    revision = revision + 1, updated_at = pg_catalog.now() where id;
  if config.credential_ref is not null then delete from vault.secrets where id = config.credential_ref; end if;
  insert into public.compass_ai_provider_attestations
    (status, gateway, model, zero_data_retention, disallow_prompt_training, evidence_ref, attested_by)
  values ('revoked', 'union-ground-fireworks', config.model, true, true, 'Platform operator disabled Fireworks failover', (select auth.uid()));
  insert into public.member_admin_audit(actor, action, detail)
  values ((select auth.uid()), 'attest_compass_ai_provider',
    pg_catalog.jsonb_build_object('gateway', 'union-ground-fireworks', 'model', config.model, 'status', 'revoked'));
  return public.get_compass_platform_ai();
end;
$$;
revoke all on function public.disable_compass_platform_fireworks() from public, anon, service_role;
grant execute on function public.disable_compass_platform_fireworks() to authenticated;

create or replace function public.resolve_compass_ai_provider(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('gateway', gateway, 'model', model)
  from public.compass_ai_policy where id and p_user_id is not null
$$;

create or replace function private.compass_ai_provider_permitted(
  p_user_id uuid, p_gateway text, p_model text, p_policy_gateway text, p_policy_model text
)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce(p_user_id is not null and p_gateway = 'union-ground-mesh'
    and p_gateway = p_policy_gateway and p_model = p_policy_model, false)
$$;

-- Governance function replacements follow. Existing role/reward/global cap
-- calculations remain intact; the scope and dispatch stages are added below.

create or replace function public.enable_organization_ai_connector(p_provider text, p_model text, p_api_key text)
returns jsonb language plpgsql security definer set search_path = ''
as $$ begin
  if not private.mfa_satisfied() then raise exception 'MFA required' using errcode = '42501'; end if;
  if p_provider is null or p_model is null or p_api_key is null then
    raise exception 'provider parameters required' using errcode = '22023';
  end if;
  raise exception 'AI providers are managed centrally by Union Ground' using errcode = '42501';
end $$;

create or replace function public.reserve_compass_ai_request(
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
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
declare
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  reservation_id uuid;
  
  quota_organization uuid := private.member_organization_for(p_user_id);
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
     or not private.compass_ai_provider_permitted(p_user_id, p_gateway, p_model, policy.gateway, policy.model)
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
  from public.organization_role_grants r
  where r.user_id = p_user_id
    and r.organization_id = quota_organization
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
    from public.organization_role_grants r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
    and r.organization_id = quota_organization
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');
    if configured_role_count <> assigned_role_count then
      return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
    end if;

    select l.role, l.hourly_limit into effective_role, effective_limit
    from public.organization_role_grants r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
    and r.organization_id = quota_organization
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    order by l.hourly_limit asc,
      case l.role when 'steward' then 1 when 'coordinator' then 2
        when 'advisor' then 3 when 'admin' then 4 else 5 end
    limit 1;
  end if;

  if effective_role is null or effective_limit is null then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');
  end if;

  
  
  
  effective_limit := least(
    200,
    effective_limit + private.compass_ai_reward_quota_bonus(p_user_id)
  );

  delete from public.member_ai_requests
  where created_at < now() - interval '2 hours';

  select pg_catalog.count(*)::integer into recent_user_count
  from public.member_ai_requests
  where user_id = p_user_id
    and created_at >= now() - interval '1 hour';
  if recent_user_count >= effective_limit then
    perform private.mesh_usage_bump(p_user_id, 'compass_rate_limited');
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'role',
                                         'role', effective_role, 'limit', effective_limit);
  end if;

  select pg_catalog.count(*)::integer into recent_global_count
  from public.member_ai_requests
  where created_at >= now() - interval '1 hour';
  if recent_global_count >= 200 then
    perform private.mesh_usage_bump(p_user_id, 'compass_rate_limited');
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'shared');
  end if;

  insert into public.member_ai_requests (user_id, compass_role, compass_limit, compass_organization_id, compass_gateway, compass_model)
  values (p_user_id, effective_role, effective_limit, quota_organization, p_gateway, p_model)
  returning id into reservation_id;

  return pg_catalog.jsonb_build_object('id', reservation_id, 'cause', null,
                                       'role', effective_role, 'limit', effective_limit);
end;
end;
$$;

create or replace function private.compass_ai_dispatch_gate(
  p_request_id uuid,
  p_user_id uuid,
  p_gateway text,
  p_model text,
  p_zero_data_retention boolean,
  p_disallow_prompt_training boolean,
  p_phase text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
declare
  request_row public.member_ai_requests%rowtype;
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  
  quota_organization uuid := private.member_organization_for(p_user_id);
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
     or p_phase not in ('embedding', 'primary', 'failover')
     or request_row.created_at < pg_catalog.now() - interval '5 minutes'
     or request_row.compass_gateway is distinct from p_gateway
     or request_row.compass_model is distinct from p_model
     or request_row.compass_organization_id is distinct from quota_organization
     or (p_phase in ('embedding', 'primary') and request_row.dispatch_authorized_at is not null)
     or (p_phase = 'embedding' and request_row.embedding_authorized_at is not null)
     or (p_phase = 'failover' and (request_row.dispatch_authorized_at is null or request_row.failover_authorized_at is not null))
     or not exists (select 1 from auth.users u where u.id = p_user_id and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= pg_catalog.now())) then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'reservation');
  end if;

  select p.* into policy
  from public.compass_ai_policy p
  where p.id = true;
  if policy.id is null
     or not (p_zero_data_retention is true
             and p_disallow_prompt_training is true)
     or not private.compass_ai_provider_permitted(p_user_id, p_gateway, p_model, policy.gateway, policy.model)
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
  from public.organization_role_grants r
  where r.user_id = p_user_id
    and r.organization_id = quota_organization
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
    from public.organization_role_grants r
    join public.compass_ai_role_limits l on l.role = r.role
    where r.user_id = p_user_id
    and r.organization_id = quota_organization
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');
    if configured_role_count <> assigned_role_count then
      return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'role_unconfigured');
    end if;
  end if;

  
  
  effective_limit := least(
    200,
    effective_limit + private.compass_ai_reward_quota_bonus(p_user_id)
  );

  select pg_catalog.count(*)::integer into recent_user_count
  from public.member_ai_requests
  where user_id = p_user_id
    and created_at >= now() - interval '1 hour';
  if effective_limit is null or recent_user_count > effective_limit then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'role');
  end if;

  if p_phase = 'primary' then
    update public.member_ai_requests set dispatch_authorized_at = now(), compass_limit = effective_limit
      where id = request_row.id;
    perform private.mesh_usage_bump(p_user_id, 'compass_requests');
  elsif p_phase = 'embedding' then
    update public.member_ai_requests set embedding_authorized_at = now() where id = request_row.id;
  end if;

  
  
  return pg_catalog.jsonb_build_object('authorized', true, 'cause', null,
                                       'evidence_ref', latest_attestation.evidence_ref, 'organization_id', quota_organization);
end;
end;
$$;
revoke all on function private.compass_ai_dispatch_gate(uuid, uuid, text, text, boolean, boolean, text) from public, anon, authenticated, service_role;

create or replace function public.authorize_compass_ai_dispatch(p_request_id uuid, p_user_id uuid, p_gateway text, p_model text, p_zero_data_retention boolean, p_disallow_prompt_training boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  return private.compass_ai_dispatch_gate(p_request_id, p_user_id, p_gateway, p_model, p_zero_data_retention, p_disallow_prompt_training, 'primary');
end;
$$;
revoke all on function public.authorize_compass_ai_dispatch(uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.authorize_compass_ai_dispatch(uuid, uuid, text, text, boolean, boolean) to service_role;

create or replace function public.authorize_compass_ai_embedding(p_request_id uuid, p_user_id uuid, p_gateway text, p_model text, p_zero_data_retention boolean, p_disallow_prompt_training boolean)
returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  return private.compass_ai_dispatch_gate(p_request_id, p_user_id, p_gateway, p_model, p_zero_data_retention, p_disallow_prompt_training, 'embedding');
end;
$$;
revoke all on function public.authorize_compass_ai_embedding(uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.authorize_compass_ai_embedding(uuid, uuid, text, text, boolean, boolean) to service_role;

create or replace function public.get_compass_ai_governance()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  attestation_ready boolean := false;
begin
  if not private.compass_platform_operator() then
    raise exception 'MFA-verified platform AI operator required' using errcode = '42501';
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

create or replace function public.set_compass_ai_enabled(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  changed boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  changed := false;
  if not private.compass_platform_operator() then
    raise exception 'MFA-verified platform AI operator required' using errcode = '42501';
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

create or replace function public.set_compass_ai_role_limit(p_role text, p_hourly_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
  normalized_role text;
  previous_limit integer;
  changed boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  normalized_role := pg_catalog.lower(pg_catalog.btrim(coalesce(p_role, '')));
  changed := false;
  if not private.compass_platform_operator() then
    raise exception 'MFA-verified platform AI operator required' using errcode = '42501';
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

create or replace function public.attest_compass_ai_provider(
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
  caller uuid;
  policy public.compass_ai_policy%rowtype;
  attestation_id uuid;
  normalized_evidence text;
  normalized_status text;
  effective_expiry timestamptz;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  normalized_evidence := pg_catalog.btrim(coalesce(p_evidence_ref, ''));
  normalized_status := pg_catalog.lower(pg_catalog.btrim(coalesce(p_status, '')));
  if not private.compass_platform_operator() then
    raise exception 'MFA-verified platform AI operator required' using errcode = '42501';
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

create function public.authorize_compass_ai_failover(p_request_id uuid, p_user_id uuid, p_cause text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  request_row public.member_ai_requests%rowtype;
  config private.compass_platform_fireworks%rowtype;
  attestation public.compass_ai_provider_attestations%rowtype;
  gate jsonb;
  secret_value text;
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if p_cause is null or p_cause not in ('transport', 'timeout', 'temporary_http') then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'outage');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  select * into request_row from public.member_ai_requests
    where id = p_request_id and user_id = p_user_id for update;
  gate := private.compass_ai_dispatch_gate(p_request_id, p_user_id, request_row.compass_gateway,
    request_row.compass_model, true, true, 'failover');
  if (gate ->> 'authorized') is distinct from 'true' then return gate; end if;
  select * into config from private.compass_platform_fireworks where id;
  if config.enabled is not true or config.credential_ref is null then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'fallback_unconfigured');
  end if;
  select * into attestation from public.compass_ai_provider_attestations
    where gateway = 'union-ground-fireworks' and model = config.model
      and zero_data_retention is true and disallow_prompt_training is true
    order by sequence_no desc limit 1;
  if attestation.id is null or attestation.status <> 'verified' or attestation.expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'unattested');
  end if;
  select decrypted_secret into secret_value from vault.decrypted_secrets where id = config.credential_ref;
  if secret_value is null or pg_catalog.char_length(secret_value) not between 16 and 512 then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'fallback_unconfigured');
  end if;
  update public.member_ai_requests set failover_authorized_at = pg_catalog.now(),
    failover_revision = config.revision, failover_model = config.model where id = p_request_id;
  return pg_catalog.jsonb_build_object('authorized', true, 'gateway', 'union-ground-fireworks',
    'model', config.model, 'api_key', secret_value,
    'isolation_scope', coalesce(request_row.compass_organization_id, p_user_id));
end;
$$;
revoke all on function public.authorize_compass_ai_failover(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.authorize_compass_ai_failover(uuid, uuid, text) to service_role;

-- Once a paid fallback was dispatched its quota remains spent, including a
-- timeout or an invalid response. Never let failures create unlimited retries.
create or replace function public.release_member_ai_request(p_request_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare deleted_count integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if p_request_id is null then return false; end if;
  delete from public.member_ai_requests where id = p_request_id and failover_authorized_at is null;
  get diagnostics deleted_count = row_count;
  return deleted_count = 1;
end;
$$;

-- Hold the identity lock while INVOKER context reads preserve RLS.
create function private.compass_context_organization()
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'sign in required' using errcode = '42501'; end if;
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  return private.member_organization_for((select auth.uid()));
end;
$$;
revoke all on function private.compass_context_organization() from public, anon, service_role;
grant execute on function private.compass_context_organization() to authenticated;

create function public.get_compass_ai_context(p_kind text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  org uuid := private.compass_context_organization();
  data jsonb; campaign jsonb; official jsonb; address jsonb; bill jsonb;
begin
  if p_kind = 'portal' then
    data := public.get_member_guide_context();
  elsif p_kind = 'lexical' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), '[]'::jsonb) into data
    from public.search_member_kb(p_args ->> 'p_query', 4) r;
  elsif p_kind = 'hybrid' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), '[]'::jsonb) into data
    from public.search_member_kb_hybrid(p_args ->> 'p_query', (p_args ->> 'p_embedding')::extensions.vector, 4) r;
  elsif p_kind = 'briefing' then
    data := public.get_message_briefing_context(p_args ->> 'p_source_kind', (p_args ->> 'p_target_id')::uuid);
  elsif p_kind = 'civic' then
    select pg_catalog.jsonb_build_object('id', c.id, 'topic', c.topic, 'summary', c.summary,
      'talking_points', c.talking_points, 'union_position', c.union_position, 'bill_key', c.bill_key,
      'target_offices', c.target_offices) into campaign
    from public.civic_campaigns c where c.id = (p_args ->> 'campaignId')::uuid and c.status = 'active';
    select pg_catalog.jsonb_build_object('full_name', o.full_name, 'office', o.office) into official
    from public.civic_member_officials_keyed o
    where o.user_id = (select auth.uid()) and o.official_key = p_args ->> 'officialKey' limit 1;
    select pg_catalog.jsonb_build_object('city', a.city, 'state', a.state) into address
    from public.civic_member_addresses a limit 1;
    select pg_catalog.jsonb_build_object('identifier', b.identifier, 'title', b.title) into bill
    from public.civic_bills b where b.bill_key = campaign ->> 'bill_key' limit 1;
    data := pg_catalog.jsonb_build_object('campaign', campaign, 'official', official,
      'address', coalesce(address, '{}'::jsonb), 'bill', bill);
  else raise exception 'context kind invalid' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('organization_id', org, 'data', data);
end;
$$;
revoke all on function public.get_compass_ai_context(text, jsonb) from public, anon, service_role;
grant execute on function public.get_compass_ai_context(text, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
