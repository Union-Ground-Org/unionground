-- SEC-UG-COMPASS-QUOTA-ORGANIZATION-ROLE-SCOPE-20260921
--
-- reserve_compass_ai_request and the authorize_compass_ai_dispatch recheck
-- (both last defined in 20260918071000_compass_inhouse_mesh_provider) chose the
-- member's Compass quota tier from account-global public.member_roles rows, so
-- a role held only in one organization set the tier in every other one. Both
-- now count only public.organization_role_grants rows in the member's selected
-- organization (private.member_organization_for, the helper the same provider
-- check already uses). A member with no selected organization gets the member
-- tier. Everything else is the 20260918071000 body verbatim: the case-graph
-- first gate, the global advisory lock, provider and attestation checks, the
-- strictest-cap rule, the reward bonus, and the shared 200/hour ceiling.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  reservation_id uuid;
  -- Quota roles are the grants held in the member's selected organization.
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

  -- This executes while the global advisory lock is held. The hook is
  -- server-owned and bounded, so a reward can raise only the member's role
  -- allowance and can never exceed or bypass the shared 200/hour ceiling.
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

  insert into public.member_ai_requests (user_id, compass_role, compass_limit)
  values (p_user_id, effective_role, effective_limit)
  returning id into reservation_id;

  return pg_catalog.jsonb_build_object('id', reservation_id, 'cause', null,
                                       'role', effective_role, 'limit', effective_limit);
end;
end;
$$;

revoke all on function public.reserve_compass_ai_request(uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.reserve_compass_ai_request(uuid, text, text, boolean, boolean) to service_role;

create or replace function public.authorize_compass_ai_dispatch(
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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  request_row public.member_ai_requests%rowtype;
  policy public.compass_ai_policy%rowtype;
  latest_attestation public.compass_ai_provider_attestations%rowtype;
  -- Quota roles are the grants held in the member's selected organization.
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
     or request_row.dispatch_authorized_at is not null then
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

  -- Recompute under the same lock immediately before dispatch. Revoking the
  -- reward after reservation therefore fails closed against the base limit.
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

  update public.member_ai_requests
  set dispatch_authorized_at = now(),
      compass_limit = effective_limit
  where id = request_row.id;

  perform private.mesh_usage_bump(p_user_id, 'compass_requests');

  -- The verified attestation's evidence reference carries the attested model
  -- digest; the server compares the mesh proof header against it.
  return pg_catalog.jsonb_build_object('authorized', true, 'cause', null,
                                       'evidence_ref', latest_attestation.evidence_ref);
end;
end;
$$;

revoke all on function public.authorize_compass_ai_dispatch(uuid, uuid, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.authorize_compass_ai_dispatch(uuid, uuid, text, text, boolean, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
