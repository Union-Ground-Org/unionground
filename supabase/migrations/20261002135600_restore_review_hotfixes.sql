-- Harden tenant boundaries and preserve existing feature behavior.
--
--   H1  SEC-UG-COMPASS-ORG-POLICY-ENFORCEMENT-20261002
--       Compass resolves its quota organization like
--       private.mi1_w2_selected_organization (selected chapter, else the single
--       active organization membership; ambiguous or unresolved refuses), and
--       uses that id for the reservation, every dispatch phase and the context
--       envelope. Dispatch re-checks the organization switch and role caps in
--       every phase; a pause is terminal. The reward bonus applies to the
--       platform entitlement before the organization cap and the 200 ceiling;
--       an organization cap of 0 is a hard stop.
--   H2  SEC-UG-INTEGRATION-OFF-NOT-ENFORCED-20261002
--       An integration whose provider status is not configured/connected stops:
--       API-key authentication refuses, and both webhook claim paths suppress
--       queued and retryable deliveries instead of sending them. Credentials
--       stay stored for reactivation.
--   H3  SEC-UG-ENGAGEMENT-EMAIL-REVOKED-RECIPIENT-20261002
--       The lease-time payload re-checks active membership and the broadcast or
--       survey audience; a recipient who lost access is suppressed terminally.
--   H4  BUG-UG-IDEMPOTENCY-KEY-REPLAY-20261002
--       Staff onboarding changes and Site Guide saves claim their key first,
--       bound to organization, actor, target, operation and payload hash.
--   H5  BUG-UG-SWEEP-TENANT-STARVATION-20261002
--       Switched-off organizations leave the survey and live-poll sweeps before
--       LIMIT; the survey sweep orders by a durable per-survey cursor.
--   H6  SEC-UG-EXPORT-CASE-TENANCY-20261002
--       The filtered export's cases come from the case's own organization and
--       chapter, with restricted cases only when the exporter may read them.
--   H7  BUG-UG-HOME-TAKEOVER-ORG-SCOPE-20261002
--       A conversation records the organization it was opened in, stamped
--       from the creating sender's selected organization. The Home takeover
--       shows only a steward message from a conversation of the selected
--       organization; a conversation without one stays out.
--   H8  BUG-UG-STEWARD-DEADLINE-SWEEP-UNBOUNDED-20261002
--       The staff deadline sweep reads bounded keyset batches of due work only,
--       with switched-off organizations excluded in the WHERE, through the
--       shared settings helpers.
--   H10 SEC-UG-PASSWORD-GRANT-THROTTLE-BYPASS-20261002
--       A Supabase Auth password-verification-attempt hook throttles failed
--       attempts per account for every password grant.
--   H11 REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002
--       The quarterly "give to view" gate is
--       enforced on the member report reads through one private helper.
--
-- Every re-declared function keeps its search_path, MFA and role checks, its
-- case-graph first statement and its grants. No shipped migration is edited.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ===========================================================================
-- H1. Compass organization policy
-- ===========================================================================

-- The quota organization for a user id, with the selected-organization rule
-- of private.mi1_w2_selected_organization: the selected chapter's
-- organization, else the single active organization membership. 'none' means
-- the user holds no active organization membership (the platform policy
-- alone applies); 'ambiguous' and 'unresolved' are refused by every caller.
create function private.compass_quota_organization(
  p_user_id uuid,
  out organization_id uuid,
  out resolution text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  selected_chapter text;
  membership_count integer;
  only_organization uuid;
begin
  organization_id := null;
  resolution := 'none';
  if p_user_id is null then
    return;
  end if;
  select p.chapter_id into selected_chapter
  from public.member_profiles p
  where p.id = p_user_id;
  if selected_chapter is not null then
    organization_id := private.member_organization_for(p_user_id);
    if organization_id is not null then
      resolution := 'selected';
      return;
    end if;
  end if;
  select pg_catalog.count(distinct membership.organization_id)::integer,
         pg_catalog.min(membership.organization_id::text)::uuid
    into membership_count, only_organization
  from public.organization_memberships membership
  join public.organizations organization
    on organization.id = membership.organization_id
   and organization.status = 'active'
  where membership.user_id = p_user_id
    and membership.status = 'active';
  if membership_count = 0 then
    resolution := 'none';
  elsif selected_chapter is not null then
    -- A selected chapter that does not resolve is refused, never replaced by
    -- another membership.
    resolution := 'unresolved';
  elsif membership_count = 1 then
    organization_id := only_organization;
    resolution := 'selected';
  else
    resolution := 'ambiguous';
  end if;
end;
$function$;

revoke all on function private.compass_quota_organization(uuid) from public, anon, authenticated, service_role;

comment on function private.compass_quota_organization(uuid) is
  'SEC-UG-COMPASS-ORG-POLICY-ENFORCEMENT-20261002: Compass quota organization for a user id with the private.mi1_w2_selected_organization rule (selected chapter, else the single active organization membership). resolution none = no active membership; ambiguous and unresolved are refused.';

-- The strictest organization cap of the caller's roles in the organization
-- (members use the member cap). A null organization reads the default cap.
create function private.compass_organization_cap(p_user_id uuid, p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.min(private.organization_limit(p_organization_id, 'limits.ai_assistant.hourly_' || r.role))
    from public.organization_role_grants r
    where r.user_id = p_user_id
      and r.organization_id = p_organization_id
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ), private.organization_limit(p_organization_id, 'limits.ai_assistant.hourly_member'))
$function$;

revoke all on function private.compass_organization_cap(uuid, uuid) from public, anon, authenticated, service_role;

comment on function private.compass_organization_cap(uuid, uuid) is
  'SEC-UG-COMPASS-ORG-POLICY-ENFORCEMENT-20261002: the organization hourly Compass cap for a user (strictest role cap, else the member cap). 0 is a hard stop. Reservation and dispatch apply it after the reward bonus: least(200, platform + bonus, cap).';

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

  quota_organization uuid;
  quota_resolution text;
  organization_cap integer;
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
  -- The quota organization uses the selected-organization rule, so chapterless
  -- staff stay under their organization's switch and caps. An ambiguous or
  -- unresolved organization context is refused; a user with no active
  -- organization membership stays under the platform policy alone.
  select q.organization_id, q.resolution into quota_organization, quota_resolution
  from private.compass_quota_organization(p_user_id) q;
  if quota_resolution in ('ambiguous', 'unresolved') then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'organization');
  end if;
  if quota_organization is not null
     and not private.organization_feature_enabled(quota_organization, 'features.ai_assistant.enabled') then
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

  -- The reward bonus raises the platform entitlement only. The organization
  -- cap and the 200 ceiling then bound the result; a cap of 0 stops Compass
  -- for that role exactly like the organization switch.
  organization_cap := private.compass_organization_cap(p_user_id, quota_organization);
  if organization_cap is null or organization_cap <= 0 then
    return pg_catalog.jsonb_build_object('id', null, 'cause', 'disabled');
  end if;
  effective_limit := least(
    200,
    effective_limit + private.compass_ai_reward_quota_bonus(p_user_id),
    organization_cap
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
                                       'role', effective_role, 'limit', effective_limit,
                                       'organization_id', quota_organization);
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

  quota_organization uuid;
  quota_resolution text;
  organization_cap integer;
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

  select q.organization_id, q.resolution into quota_organization, quota_resolution
  from private.compass_quota_organization(p_user_id) q;

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
     or quota_resolution in ('ambiguous', 'unresolved')
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
  -- The organization switch is re-read in EVERY phase (embedding, primary and
  -- failover). A pause is a terminal refusal, never a reason to fail over.
  if quota_organization is not null
     and not private.organization_feature_enabled(quota_organization, 'features.ai_assistant.enabled') then
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

  -- Same final calculation as the reservation: the reward bonus on the
  -- platform entitlement, then the current organization cap and the ceiling.
  -- A cap lowered to 0 after the reservation stops the dispatch.
  organization_cap := private.compass_organization_cap(p_user_id, quota_organization);
  if organization_cap is null or organization_cap <= 0 then
    return pg_catalog.jsonb_build_object('authorized', false, 'cause', 'disabled');
  end if;
  effective_limit := least(
    200,
    effective_limit + private.compass_ai_reward_quota_bonus(p_user_id),
    organization_cap
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

-- The context envelope carries the same organization id the reservation and
-- dispatch use, so api/_lib/compassContext.js compares like with like.
create or replace function private.compass_context_organization()
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  org uuid;
  resolution text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then raise exception 'sign in required' using errcode = '42501'; end if;
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  select q.organization_id, q.resolution into org, resolution
  from private.compass_quota_organization((select auth.uid())) q;
  if resolution in ('ambiguous', 'unresolved') then
    raise exception 'organization context required' using errcode = '42501';
  end if;
  return org;
end;
$$;
revoke all on function private.compass_context_organization() from public, anon, service_role;
grant execute on function private.compass_context_organization() to authenticated;

-- ===========================================================================
-- H2. A turned-off integration stops
-- ===========================================================================

-- Effective provider status, as the integration page shows it
-- (src/features/integrations/controlPlane.js ENABLED_ORG_STATUSES).
create function private.integration_provider_enabled(p_organization_id uuid, p_provider text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.organization_integrations i
    where i.organization_id = p_organization_id
      and i.provider = p_provider
      and i.status in ('configured', 'connected')
  )
$function$;

revoke all on function private.integration_provider_enabled(uuid, text) from public, anon, authenticated, service_role;

comment on function private.integration_provider_enabled(uuid, text) is
  'SEC-UG-INTEGRATION-OFF-NOT-ENFORCED-20261002: true only while the organization''s provider status is configured or connected (the integration page''s effective on).';

-- Queued and retryable deliveries of a turned-off webhook integration are
-- suppressed (skipped) rather than left to send later. In-flight leases are
-- not touched; the stored signing secret stays for reactivation.
create function private.suppress_disabled_integration_webhook_deliveries()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  suppressed integer;
begin
  with stopped as (
    update public.integration_webhook_deliveries d
    set status = 'skipped', error_code = 'integration_disabled',
        lease_expires_at = null, next_attempt_at = null
    where d.attempt_count < 5
      and (d.status in ('queued', 'failed')
           or (d.status = 'sending' and d.lease_expires_at <= pg_catalog.now()))
      and not private.integration_provider_enabled(d.organization_id, 'customer_webhooks')
    returning d.id, d.organization_id
  ), stopped_jobs as (
    update public.integration_jobs j
    set status = 'skipped', error_code = 'integration_disabled', updated_at = pg_catalog.now()
    from stopped
    where j.organization_id = stopped.organization_id
      and j.idempotency_key = 'delivery:' || stopped.id::text
      and j.status in ('queued', 'running', 'failed')
    returning j.id
  )
  select pg_catalog.count(*)::integer into suppressed from stopped;
  return suppressed;
end;
end;
$function$;

revoke all on function private.suppress_disabled_integration_webhook_deliveries() from public, anon, authenticated, service_role;

comment on function private.suppress_disabled_integration_webhook_deliveries() is
  'SEC-UG-INTEGRATION-OFF-NOT-ENFORCED-20261002: marks queued, failed-retryable and lease-expired deliveries of organizations whose customer_webhooks provider is off as skipped (error integration_disabled) with their jobs, so they are never sent.';

create or replace function public.authenticate_integration_api_key(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  matched public.integration_api_keys%rowtype;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then return null; end if;
  select k.* into matched
  from public.integration_api_keys k
  join public.organizations o on o.id = k.organization_id and o.status = 'active'
  where k.key_hash = p_key_hash and k.revoked_at is null
    -- A turned-off customer API refuses every stored key until reactivated.
    and private.integration_provider_enabled(k.organization_id, 'customer_api')
  for update of k;
  if not found then return null; end if;
  update public.integration_api_keys set last_used_at = pg_catalog.now() where id = matched.id;
  return pg_catalog.jsonb_build_object(
    'keyId', matched.id,
    'organizationId', matched.organization_id,
    'name', matched.name
  );
end;
end;
$function$;

create or replace function public.claim_integration_webhook_deliveries(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.mi1_reap_expired_webhook_final_attempts();
  perform private.suppress_disabled_integration_webhook_deliveries();
  with candidates as (
    select d.id from public.integration_webhook_deliveries d
    join public.integration_webhooks w on w.id = d.webhook_id and w.organization_id = d.organization_id
    where w.active and w.secret_ref is not null and d.attempt_count < 5 and (
      (d.status in ('queued', 'failed') and coalesce(d.next_attempt_at, d.created_at) <= pg_catalog.now())
      or (d.status = 'sending' and d.lease_expires_at <= pg_catalog.now())
    )
      and private.integration_provider_enabled(d.organization_id, 'customer_webhooks')
    order by coalesce(d.next_attempt_at, d.created_at), d.id
    limit greatest(1, least(coalesce(p_limit, 10), 25)) for update of d skip locked
  ), claimed as (
    update public.integration_webhook_deliveries d
    set status = 'sending', attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '10 minutes',
        next_attempt_at = null, error_code = null
    from candidates where d.id = candidates.id
    returning d.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', d.id, 'attemptCount', d.attempt_count, 'url', w.url,
    'eventName', d.event_name, 'eventId', d.event_id, 'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) order by d.created_at, d.id), '[]'::jsonb) into result
  from claimed d join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;
  update public.integration_jobs j set status = 'running', updated_at = pg_catalog.now()
  where exists (
    select 1 from pg_catalog.jsonb_array_elements(result) entry
    join public.integration_webhook_deliveries d on d.id = (entry->>'deliveryId')::uuid
    where j.organization_id = d.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text
  );
  return result;
end;
end;
$function$;

revoke all on function public.claim_integration_webhook_deliveries(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_integration_webhook_deliveries(integer) to service_role;

create or replace function public.claim_integration_webhook_delivery(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare claimed jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.mi1_reap_expired_webhook_final_attempts();
  perform private.suppress_disabled_integration_webhook_deliveries();
  with candidate as (
    select d.id from public.integration_webhook_deliveries d
    join public.integration_webhooks w on w.id = d.webhook_id and w.organization_id = d.organization_id
    where d.id = p_delivery_id and w.active and w.secret_ref is not null and (
      (d.status in ('queued', 'failed') and coalesce(d.next_attempt_at, d.created_at) <= pg_catalog.now())
      or (d.status = 'sending' and d.lease_expires_at <= pg_catalog.now() and d.attempt_count < 5)
    ) and d.attempt_count < 5
      and private.integration_provider_enabled(d.organization_id, 'customer_webhooks')
    for update of d skip locked
  ), claimed_delivery as (
    update public.integration_webhook_deliveries d
    set status = 'sending', attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '10 minutes',
        next_attempt_at = null, error_code = null
    from candidate where d.id = candidate.id returning d.*
  )
  select pg_catalog.jsonb_build_object(
    'deliveryId', d.id, 'attemptCount', d.attempt_count, 'url', w.url,
    'eventName', d.event_name, 'eventId', d.event_id, 'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) into claimed
  from claimed_delivery d join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;
  if claimed is not null then
    update public.integration_jobs j set status = 'running', updated_at = pg_catalog.now()
    from public.integration_webhook_deliveries d
    where d.id = (claimed->>'deliveryId')::uuid
      and j.organization_id = d.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text;
  end if;
  return claimed;
end;
end;
$function$;

revoke all on function public.claim_integration_webhook_delivery(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_integration_webhook_delivery(uuid) to service_role;

-- ===========================================================================
-- H3. Engagement email re-checks the recipient at lease time
-- ===========================================================================

-- False only when the recipient no longer holds an active membership in the
-- row's organization, or the broadcast / survey still exists and its audience
-- (organization-wide, or the recipient's chapter) no longer includes them.
-- The same predicates the enqueue paths used (20261002021000).
create function private.engagement_delivery_recipient_eligible(
  p_organization_id uuid,
  p_recipient_user_id uuid,
  p_source_kind text,
  p_source_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = p_recipient_user_id
        and membership.status = 'active'
        and membership.revoked_at is null
    )
    and case p_source_kind
      when 'broadcast' then not exists (
        select 1
        from public.member_broadcasts broadcast
        left join public.member_profiles profile on profile.id = p_recipient_user_id
        where broadcast.id = p_source_id
          and broadcast.organization_id = p_organization_id
          and broadcast.audience_scope <> 'organization'
          and profile.chapter_id is distinct from broadcast.chapter_id
      )
      when 'survey' then not exists (
        select 1
        from public.organization_surveys survey
        left join public.member_profiles profile on profile.id = p_recipient_user_id
        where survey.id::text = p_source_id
          and survey.organization_id = p_organization_id
          and survey.chapter_id is not null
          and profile.chapter_id is distinct from survey.chapter_id
      )
      else true
    end
$function$;

revoke all on function private.engagement_delivery_recipient_eligible(uuid, uuid, text, text) from public, anon, authenticated, service_role;

comment on function private.engagement_delivery_recipient_eligible(uuid, uuid, text, text) is
  'SEC-UG-ENGAGEMENT-EMAIL-REVOKED-RECIPIENT-20261002: lease-time recipient check for engagement email: an active organization membership and, for a broadcast or survey, the current audience.';

create or replace function public.get_engagement_delivery_payload(
  p_delivery_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  row public.engagement_delivery_outbox%rowtype;
  email text;
  title text;
  body text;
  action_path text;
  category text;
  unsubscribe_token text;
begin
  select * into row from public.engagement_delivery_outbox
  where id = p_delivery_id and state = 'leased' and lease_token = p_lease_token
    and lease_expires_at >= pg_catalog.now();
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  -- The member may have opted out after this row was queued.
  if private.engagement_email_opted_out(row.recipient_user_id, row.delivery_kind) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_opted_out');
  end if;
  -- Enqueue-time eligibility does not authorize a later send: a recipient who
  -- lost the membership or left the audience gets nothing, terminally.
  if not private.engagement_delivery_recipient_eligible(
    row.organization_id, row.recipient_user_id, row.source_kind, row.source_id
  ) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_access_revoked');
  end if;
  category := private.engagement_email_category(row.delivery_kind);
  unsubscribe_token := private.engagement_email_unsubscribe_token(row.recipient_user_id, category);
  select user_row.email into email from auth.users user_row where user_row.id = row.recipient_user_id;
  if row.source_kind = 'broadcast' then
    select broadcast.title, broadcast.body, '/m/messages?broadcast=' || row.source_id into title, body, action_path
    from public.member_broadcasts broadcast where broadcast.id = row.source_id
      and broadcast.organization_id = row.organization_id and broadcast.retracted_at is null;
  elsif row.source_kind = 'survey' then
    select survey.title, case row.delivery_kind when 'survey_reminder'
      then 'A survey is still waiting for your response in Union Ground.'
      else 'A survey is ready for you in Union Ground.' end,
      '/m/voice?survey=' || row.source_id into title, body, action_path
    from public.organization_surveys survey where survey.id = row.source_id::uuid
      and survey.organization_id = row.organization_id and survey.status = 'open';
  else
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.member_welcome_enrollments enrollment
    join public.organization_memberships membership
      on membership.organization_id = enrollment.organization_id
      and membership.user_id = enrollment.member_user_id
    where enrollment.id = pg_catalog.split_part(row.source_id, ':', 1)::uuid
      and enrollment.organization_id = row.organization_id and enrollment.member_user_id = row.recipient_user_id
      and enrollment.state in ('active','completed')
      and membership.status = 'active' and membership.revoked_at is null;
  end if;
  if email is null or title is null or unsubscribe_token is null then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'available', true, 'email', email, 'locale', row.locale,
    'subject', title, 'body', body, 'path', action_path,
    'category', category, 'transactional', false,
    'unsubscribeToken', unsubscribe_token
  );
end;
$function$;

create or replace function public.complete_engagement_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_error_code text default null,
  p_retry_after_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  row public.engagement_delivery_outbox%rowtype;
  suppress boolean;
  next_state text;
  claimed_code text;
begin
  if not p_success and pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, ''))) !~ '^[a-z0-9._:-]{1,80}$' then
    raise exception 'bounded error code required' using errcode = '22023';
  end if;
  if p_retry_after_seconds not between 60 and 86400 then
    raise exception 'invalid retry delay' using errcode = '22023';
  end if;
  select * into row from public.engagement_delivery_outbox outbox
  where outbox.id = p_delivery_id and outbox.state = 'leased' and outbox.lease_token = p_lease_token
  for update;
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  -- An opted-out or no-longer-eligible recipient is terminal, never a retry.
  -- The dispatcher's claim is believed only when the database agrees.
  claimed_code := pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, '')));
  suppress := not p_success and (
    (claimed_code = 'recipient_opted_out'
      and private.engagement_email_opted_out(row.recipient_user_id, row.delivery_kind))
    or (claimed_code in ('recipient_opted_out', 'recipient_access_revoked')
      and not private.engagement_delivery_recipient_eligible(
        row.organization_id, row.recipient_user_id, row.source_kind, row.source_id))
  );
  next_state := case when p_success then 'sent' when suppress then 'suppressed' else 'failed' end;
  update public.engagement_delivery_outbox outbox
  set state = next_state,
      sent_at = case when p_success then pg_catalog.now() else null end,
      last_error_code = case when p_success then null else claimed_code end,
      available_at = case when p_success or suppress then outbox.available_at else pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_after_seconds) end,
      lease_token = null, lease_expires_at = null, updated_at = pg_catalog.now()
  where outbox.id = row.id
  returning * into row;
  if row.source_kind = 'survey' then
    update public.organization_survey_deliveries
    set state = next_state,
        attempt_count = row.attempt_count,
        last_attempt_at = pg_catalog.now(),
        sent_at = case when p_success then coalesce(sent_at, pg_catalog.now()) else sent_at end,
        last_error_code = row.last_error_code,
        updated_at = pg_catalog.now()
    where survey_id = row.source_id::uuid and recipient_user_id = row.recipient_user_id;
  end if;
  return pg_catalog.jsonb_build_object('id', row.id, 'state', row.state);
end;
end;
$function$;

-- ===========================================================================
-- H4. Idempotency keys are claimed before the mutation
-- ===========================================================================

-- Receipt payload: the operation target plus a SHA-256 of the canonical
-- request. private.mi1_w2_operation_receipts is keyed by organization,
-- operation and key, and its view binds every row to auth.uid(), so a key is
-- bound to organization, actor, target, operation and payload together.
create function private.idempotent_request_payload(p_target text, p_request jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'target', p_target,
    'payloadSha256', pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(coalesce(p_request, 'null'::jsonb)::text, 'UTF8'), 'sha256'),
      'hex'
    )
  )
$function$;

revoke all on function private.idempotent_request_payload(text, jsonb) from public, anon, authenticated, service_role;

comment on function private.idempotent_request_payload(text, jsonb) is
  'BUG-UG-IDEMPOTENCY-KEY-REPLAY-20261002: receipt payload {target, payloadSha256} for private.member_operations_replay; an identical replay returns the stored result, any other reuse of the key raises 22023.';

create or replace function public.staff_update_member_onboarding_plan(
  p_plan_id uuid,
  p_action text,
  p_step_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  declare
    org uuid := private.member_support_selected_organization();
    plan record;
    step_ok boolean;
    completed uuid[];
    remaining integer;
    next_status text;
    request_payload jsonb;
    cached jsonb;
    result jsonb;
  begin
    if not private.member_support_is_staff(org) then
      raise exception 'staff role and MFA required' using errcode = '42501';
    end if;
    if not private.organization_feature_enabled(org, 'features.guidance_onboarding.staff_step_overrides') then
      raise exception 'staff onboarding changes are turned off for this organization' using errcode = '42501';
    end if;
    if p_action is null or p_action not in ('complete', 'skip', 'reset') or p_idempotency_key is null then
      raise exception 'invalid onboarding change' using errcode = '22023';
    end if;
    select * into plan from public.member_onboarding_plans
    where id = p_plan_id and organization_id = org
    for update;
    if plan.id is null then
      raise exception 'onboarding plan not found' using errcode = '22023';
    end if;
    perform private.lock_case_graph(array[plan.member_user_id], array[]::uuid[]);

    -- Claim the key before anything changes: an identical replay returns the
    -- original result without mutating; any other reuse raises 22023.
    request_payload := private.idempotent_request_payload(plan.id::text, pg_catalog.jsonb_build_object(
      'planId', plan.id, 'action', p_action,
      'stepId', case when p_action = 'reset' then null else p_step_id end
    ));
    cached := private.member_operations_replay(org, 'staff_update_member_onboarding_plan', p_idempotency_key, request_payload);
    if cached is not null then
      return cached;
    end if;

    if p_action = 'reset' then
      update public.member_onboarding_plans set
        completed_step_ids = '{}',
        status = 'not_started',
        started_at = null,
        completed_at = null,
        updated_at = pg_catalog.now()
      where id = plan.id;
      perform private.member_support_record_event(extensions.gen_random_uuid(), org, plan.member_user_id, 'onboarding_plan', plan.id, 'progress_reset');
      result := pg_catalog.jsonb_build_object('id', plan.id, 'status', 'not_started', 'completedStepIds', '[]'::jsonb);
      perform private.member_operations_store_receipt(org, 'staff_update_member_onboarding_plan', p_idempotency_key, request_payload, result);
      return result;
    end if;

    select exists (
      select 1 from public.organization_onboarding_steps s
      where s.id = p_step_id and s.organization_id = org and s.active
    ) into step_ok;
    if not step_ok then
      raise exception 'onboarding step not found' using errcode = '22023';
    end if;
    completed := array(select distinct value from pg_catalog.unnest(plan.completed_step_ids || p_step_id) value);
    select pg_catalog.count(*) into remaining from public.organization_onboarding_steps s
    where s.organization_id = org and s.active and not (s.id = any(completed));
    next_status := case when remaining = 0 then 'completed' else 'in_progress' end;
    update public.member_onboarding_plans set
      completed_step_ids = completed,
      status = next_status,
      started_at = coalesce(started_at, pg_catalog.now()),
      completed_at = case when remaining = 0 then coalesce(completed_at, pg_catalog.now()) else null end,
      updated_at = pg_catalog.now()
    where id = plan.id;
    -- The event id is fresh: the receipt carries idempotency, so a second
    -- staff member's own key can never silently drop this audit row.
    perform private.member_support_record_event(
      extensions.gen_random_uuid(), org, plan.member_user_id, 'onboarding_plan', plan.id,
      case when p_action = 'skip' then 'step_skipped' else 'step_completed' end
    );
    result := pg_catalog.jsonb_build_object('id', plan.id, 'status', next_status, 'completedStepIds', pg_catalog.to_jsonb(completed));
    perform private.member_operations_store_receipt(org, 'staff_update_member_onboarding_plan', p_idempotency_key, request_payload, result);
    return result;
  end;
end;
$function$;

revoke all on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid) to authenticated;

create or replace function public.save_site_guide(
  p_title text,
  p_intro text,
  p_help_title text,
  p_help_body text,
  p_sections jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  declare
    org uuid := private.mi1_w2_selected_organization();
    clean_title text := nullif(pg_catalog.btrim(coalesce(p_title, '')), '');
    clean_intro text := nullif(pg_catalog.btrim(coalesce(p_intro, '')), '');
    clean_help_title text := nullif(pg_catalog.btrim(coalesce(p_help_title, '')), '');
    clean_help_body text := nullif(pg_catalog.btrim(coalesce(p_help_body, '')), '');
    clean_sections jsonb := '{}'::jsonb;
    section_key text;
    section_value jsonb;
    section_body text;
    section_steps jsonb;
    step text;
    clean_steps jsonb;
    fields text[] := '{}'::text[];
    request_payload jsonb;
    cached jsonb;
    result jsonb;
  begin
    if not private.has_organization_role(org, array['admin']) then
      raise exception 'admin role required' using errcode = '42501';
    end if;
    if p_idempotency_key is null then
      raise exception 'invalid site guide' using errcode = '22023';
    end if;
    if p_sections is not null and pg_catalog.jsonb_typeof(p_sections) <> 'object' then
      raise exception 'invalid site guide' using errcode = '22023';
    end if;
    if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(coalesce(p_sections, '{}'::jsonb))) > 20 then
      raise exception 'invalid site guide' using errcode = '22023';
    end if;
    for section_key, section_value in select key, value from pg_catalog.jsonb_each(coalesce(p_sections, '{}'::jsonb)) loop
      if section_key !~ '^[a-z][a-z0-9_-]{1,39}$' or pg_catalog.jsonb_typeof(section_value) <> 'object'
        or exists (select 1 from pg_catalog.jsonb_object_keys(section_value) k where k not in ('body', 'steps')) then
        raise exception 'invalid site guide' using errcode = '22023';
      end if;
      section_body := null;
      if section_value ? 'body' and pg_catalog.jsonb_typeof(section_value -> 'body') <> 'null' then
        if pg_catalog.jsonb_typeof(section_value -> 'body') <> 'string' then
          raise exception 'invalid site guide' using errcode = '22023';
        end if;
        section_body := nullif(pg_catalog.btrim(section_value ->> 'body'), '');
        if section_body is not null and (pg_catalog.char_length(section_body) > 1200
          or pg_catalog.regexp_replace(section_body, '[\n]', '', 'g') ~ '[[:cntrl:]]') then
          raise exception 'invalid site guide' using errcode = '22023';
        end if;
      end if;
      clean_steps := '[]'::jsonb;
      section_steps := section_value -> 'steps';
      if section_steps is not null and pg_catalog.jsonb_typeof(section_steps) <> 'null' then
        if pg_catalog.jsonb_typeof(section_steps) <> 'array' or pg_catalog.jsonb_array_length(section_steps) > 6 then
          raise exception 'invalid site guide' using errcode = '22023';
        end if;
        for step in select pg_catalog.btrim(value) from pg_catalog.jsonb_array_elements_text(section_steps) loop
          if step = '' then continue; end if;
          if pg_catalog.char_length(step) > 220 or step ~ '[[:cntrl:]]' then
            raise exception 'invalid site guide' using errcode = '22023';
          end if;
          clean_steps := clean_steps || pg_catalog.to_jsonb(step);
        end loop;
      end if;
      if section_body is not null or pg_catalog.jsonb_array_length(clean_steps) > 0 then
        clean_sections := clean_sections || pg_catalog.jsonb_build_object(section_key,
          pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'body', section_body,
            'steps', case when pg_catalog.jsonb_array_length(clean_steps) > 0 then clean_steps end
          )));
      end if;
    end loop;

    -- Claim the key before the copy changes: an identical replay returns the
    -- original result without writing; any other reuse raises 22023.
    request_payload := private.idempotent_request_payload(org::text, pg_catalog.jsonb_build_object(
      'title', p_title, 'intro', p_intro, 'helpTitle', p_help_title,
      'helpBody', p_help_body, 'sections', p_sections
    ));
    cached := private.member_operations_replay(org, 'save_site_guide', p_idempotency_key, request_payload);
    if cached is not null then
      return cached;
    end if;

    if clean_title is not null then fields := fields || 'title'::text; end if;
    if clean_intro is not null then fields := fields || 'intro'::text; end if;
    if clean_help_title is not null then fields := fields || 'helpTitle'::text; end if;
    if clean_help_body is not null then fields := fields || 'helpBody'::text; end if;
    if clean_sections <> '{}'::jsonb then fields := fields || 'sections'::text; end if;

    if pg_catalog.cardinality(fields) = 0 then
      -- Nothing left to override: the organization is back on the defaults.
      delete from private.organization_site_guide_copy where organization_id = org;
    else
      insert into private.organization_site_guide_copy (organization_id, title, intro, help_title, help_body, sections, updated_at)
      values (org, clean_title, clean_intro, clean_help_title, clean_help_body, clean_sections, pg_catalog.now())
      on conflict (organization_id) do update set
        title = excluded.title,
        intro = excluded.intro,
        help_title = excluded.help_title,
        help_body = excluded.help_body,
        sections = excluded.sections,
        updated_at = excluded.updated_at;
    end if;

    -- The ledger row is written in the same transaction as the copy, always:
    -- its own key is fresh because the receipt above carries idempotency.
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'administration', 'site_guide_copy_changed', 'settings_change',
      (select auth.uid()), 'organization', org::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'fieldsChanged', pg_catalog.to_jsonb(fields),
        'reasonCode', case when pg_catalog.cardinality(fields) = 0 then 'restored_defaults' else 'copy_saved' end
      )
    );

    result := pg_catalog.jsonb_build_object('saved', true, 'restoredDefaults', pg_catalog.cardinality(fields) = 0, 'fields', pg_catalog.to_jsonb(fields));
    perform private.member_operations_store_receipt(org, 'save_site_guide', p_idempotency_key, request_payload, result);
    return result;
  end;
end;
$function$;

revoke all on function public.save_site_guide(text, text, text, text, jsonb, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_site_guide(text, text, text, text, jsonb, uuid) to authenticated;

-- ===========================================================================
-- H5. Sweep fairness
-- ===========================================================================

alter table public.organization_surveys
  add column operations_swept_at timestamptz;

comment on column public.organization_surveys.operations_swept_at is
  'BUG-UG-SWEEP-TENANT-STARVATION-20261002: when private.run_survey_operations_sweep last processed this survey. The sweep orders by it (never-swept first), so every eligible survey is eventually reached.';

create index organization_surveys_operations_cursor_idx
  on public.organization_surveys (operations_swept_at nulls first, id)
  where status = 'open' or (status = 'closed' and operations_state <> 'complete');

create or replace function private.run_survey_operations_sweep(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := coalesce(p_limit, 100);
  survey public.organization_surveys%rowtype;
  attention jsonb;
  created integer := 0;
  marked integer := 0;
  escalated integer := 0;
  reminders integer := 0;
  step integer;
  actor uuid;
begin
  if cap not between 1 and 500 then
    raise exception 'invalid survey sweep limit' using errcode = '22023';
  end if;
  -- Switched-off organizations are excluded before LIMIT, and the durable
  -- per-survey cursor puts the least recently swept surveys first, so neither
  -- a disabled tenant nor the oldest 100 surveys can starve the rest.
  for survey in
    select candidate.*
    from public.organization_surveys candidate
    where (candidate.status = 'open'
       or (candidate.status = 'closed' and candidate.operations_state <> 'complete'))
      and private.organization_feature_enabled(candidate.organization_id, 'features.engagement_voice.survey_follow_up_automation')
    order by candidate.operations_swept_at nulls first, candidate.id
    for update skip locked
    limit cap
  loop
    update public.organization_surveys
    set operations_swept_at = pg_catalog.now()
    where id = survey.id;
    attention := private.survey_operations_state(survey.id);

    if (attention ->> 'reviewReady')::boolean then
      if private.open_survey_follow_up_task(survey, 'response_review', null) then created := created + 1; end if;
    end if;
    if (attention ->> 'closeoutDue')::boolean then
      if private.open_survey_follow_up_task(survey, 'closeout', null) then created := created + 1; end if;
    end if;
    if (attention #>> '{lowResponse,due}')::boolean then
      if private.open_survey_follow_up_task(survey, 'low_response', null) then created := created + 1; end if;
    end if;
    if attention #>> '{escalation,level}' in ('elevated', 'urgent') then
      if private.open_survey_follow_up_task(survey, 'coverage_escalation', pg_catalog.now()) then created := created + 1; end if;
    end if;

    if survey.status = 'open' then
      -- Reminder cadence: unanswered deliveries become reminder_due once the
      -- survey's reminder date passes, then escalated when a due reminder is
      -- still unanswered after the progress window.
      if (attention #>> '{reminder,due}')::boolean then
        update public.organization_survey_deliveries delivery
        set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
        where delivery.survey_id = survey.id and delivery.engaged_at is null
          and delivery.state in ('queued', 'sent', 'failed') and delivery.escalation_state = 'none';
        get diagnostics step = row_count;
        marked := marked + step;
      end if;
      update public.organization_survey_deliveries delivery
      set escalation_state = 'escalated', updated_at = pg_catalog.now()
      where delivery.survey_id = survey.id and delivery.engaged_at is null
        and delivery.escalation_state = 'reminder_due'
        and delivery.updated_at <= pg_catalog.now() - pg_catalog.make_interval(days => (attention ->> 'progressStaleDays')::integer);
      get diagnostics step = row_count;
      escalated := escalated + step;

      if private.organization_feature_enabled(survey.organization_id, 'features.engagement_voice.survey_scheduled_reminders') then
        with candidates as (
          select delivery.recipient_user_id
          from public.organization_survey_deliveries delivery
          where delivery.survey_id = survey.id and delivery.engaged_at is null
            and delivery.state in ('queued', 'sent', 'failed')
            and delivery.escalation_state in ('reminder_due', 'escalated')
            -- Same producer-side opt-out as the manual Remind button
            -- (20261002021000); the lease-time payload check stays the backstop.
            and not private.engagement_email_opted_out(delivery.recipient_user_id, 'survey_reminder')
            and not exists (
              select 1 from public.engagement_delivery_outbox outbox
              where outbox.delivery_kind = 'survey_reminder' and outbox.source_id = survey.id::text
                and outbox.recipient_user_id = delivery.recipient_user_id
            )
        ), inserted as (
          insert into public.engagement_delivery_outbox (
            organization_id, recipient_user_id, delivery_kind, source_kind, source_id
          )
          select survey.organization_id, candidates.recipient_user_id, 'survey_reminder', 'survey', survey.id::text
          from candidates
          on conflict (delivery_kind, source_id, recipient_user_id) do nothing
          returning recipient_user_id
        )
        select pg_catalog.count(*)::integer into step from inserted;
        if step > 0 then
          reminders := reminders + step;
          actor := coalesce(survey.owner_user_id, survey.created_by);
          if actor is not null then
            insert into public.organization_audit_events (
              organization_id, event_type, actor_user_id, idempotency_key, metadata
            ) values (
              survey.organization_id, 'survey_reminders_queued', actor, extensions.gen_random_uuid(),
              pg_catalog.jsonb_build_object(
                'organizationId', survey.organization_id, 'surveyId', survey.id,
                'userId', actor, 'count', step, 'reasonCode', 'scheduled'
              )
            );
          end if;
        end if;
      end if;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'tasksCreated', created, 'remindersDue', marked, 'escalated', escalated, 'remindersQueued', reminders
  );
end;
end;
$function$;

revoke all on function private.run_survey_operations_sweep(integer)
  from public, anon, authenticated, service_role;

create or replace function private.run_due_live_poll_transitions(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := coalesce(p_limit, 200);
  poll public.organization_live_polls%rowtype;
  next_state text;
  transition_action text;
  opened integer := 0;
  closed integer := 0;
begin
  if cap not between 1 and 1000 then
    raise exception 'invalid live poll scheduler limit' using errcode = '22023';
  end if;
  -- Switched-off organizations are excluded before LIMIT: their due polls
  -- stay for a manual open/close and never occupy the scheduler's batch.
  for poll in
    select candidate.*
    from public.organization_live_polls candidate
    where ((
        candidate.state = 'scheduled'
        and (
          (candidate.opens_at is not null and candidate.opens_at <= pg_catalog.now())
          or (candidate.closes_at is not null and candidate.closes_at <= pg_catalog.now())
        )
      ) or (
        candidate.state = 'open'
        and candidate.closes_at is not null and candidate.closes_at <= pg_catalog.now()
      ))
      and private.organization_feature_enabled(candidate.organization_id, 'features.engagement_voice.live_poll_auto_open_close')
    order by coalesce(candidate.closes_at, candidate.opens_at), candidate.id
    for update skip locked
    limit cap
  loop
    if poll.closes_at is not null and poll.closes_at <= pg_catalog.now() then
      next_state := 'closed';
      transition_action := 'close';
    else
      next_state := 'open';
      transition_action := 'open';
    end if;
    update public.organization_live_polls
    set state = next_state,
        opens_at = case when next_state = 'open' then coalesce(opens_at, pg_catalog.now()) else opens_at end,
        closed_at = case when next_state = 'closed' then pg_catalog.now() else null end,
        updated_at = pg_catalog.now()
    where id = poll.id returning * into poll;
    perform private.recalculate_organization_live_poll(poll.id);
    -- actor_user_id is NOT NULL: the scheduled transition is attributed to the
    -- poll's author, whose schedule authorized it. An authorless poll still
    -- transitions; it is not audited rather than failing the whole tick.
    if poll.created_by is not null then
      insert into public.organization_audit_events (
        organization_id, event_type, actor_user_id, idempotency_key, metadata
      ) values (
        poll.organization_id, 'live_poll_transitioned', poll.created_by, extensions.gen_random_uuid(),
        pg_catalog.jsonb_build_object(
          'organizationId', poll.organization_id, 'pollId', poll.id, 'userId', poll.created_by,
          'status', next_state, 'action', transition_action, 'count', poll.vote_count, 'reasonCode', 'scheduled'
        )
      );
    end if;
    if next_state = 'open' then opened := opened + 1; else closed := closed + 1; end if;
  end loop;
  return pg_catalog.jsonb_build_object('opened', opened, 'closed', closed);
end;
end;
$function$;

revoke all on function private.run_due_live_poll_transitions(integer)
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- H6. The filtered export's cases use the case's own tenancy
-- ===========================================================================

create or replace function public.request_filtered_organization_export(p_domains text[], p_format text default 'csv'::text, p_from timestamp with time zone default null::timestamp with time zone, p_to timestamp with time zone default null::timestamp with time zone, p_idempotency_key uuid default null::uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  clean_domains text[];
  rows jsonb;
  total integer;
  receipt uuid;
  expires timestamptz := pg_catalog.now() + interval '15 minutes';
  prior public.organization_data_export_runs%rowtype;
  recent_requests integer;
begin
  select * into ctx from private.institutional_context(true);
  if not private.has_organization_role(ctx.organization_id, array['admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  delete from public.organization_data_export_runs
  where organization_id = ctx.organization_id and expires_at <= pg_catalog.now();
  select pg_catalog.array_agg(domain order by domain) into clean_domains
  from (
    select distinct pg_catalog.btrim(value) as domain
    from pg_catalog.unnest(coalesce(p_domains, '{}'::text[])) value
  ) selected
  where domain = any(array['members','cases','tasks','minutes','timeline','contacts']::text[]);
  if p_format not in ('csv','json','xlsx')
     or (p_format = 'xlsx' and not private.organization_feature_enabled(ctx.organization_id, 'features.analytics.filtered_export_xlsx'))
     or pg_catalog.cardinality(clean_domains) not between 1 and 6
     or pg_catalog.cardinality(clean_domains) <> pg_catalog.cardinality(p_domains)
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception 'invalid export request' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('filtered-export:' || ctx.organization_id::text, 509)
  );
  if p_idempotency_key is not null then
    select * into prior from public.organization_data_export_runs r
    where r.organization_id = ctx.organization_id and r.requested_by = ctx.caller_id
      and r.idempotency_key = p_idempotency_key and r.expires_at > pg_catalog.now();
    if prior.id is not null and (
      prior.format <> p_format or prior.domains <> clean_domains
      or prior.filters <> pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to))
    ) then
      raise exception 'invalid export request' using errcode = '22023';
    end if;
  end if;
  if prior.id is null then
    select pg_catalog.count(*)::integer into recent_requests
    from public.organization_audit_events e
    where e.organization_id = ctx.organization_id
      and e.event_type = 'organization_export_completed'
      and e.metadata->>'exportType' = 'filtered'
      and e.created_at > pg_catalog.now() - interval '1 hour';
    -- 30 filtered export requests per organization per rolling hour.
    if recent_requests >= 30 then
      raise exception 'export request limit reached: 30 per hour' using errcode = '54000';
    end if;
  end if;

  with export_rows as (
    select 'members'::text as domain, p.created_at as occurred_at,
      pg_catalog.jsonb_build_object(
        'memberId', p.id, 'name', p.full_name, 'memberSince', p.member_since,
        'chapterId', membership.chapter_id
      ) as values
    from public.member_profiles p
    join lateral (
      select cm.chapter_id
      from public.member_chapter_memberships cm
      join public.chapters c on c.id = cm.chapter_id
      where cm.user_id = p.id and cm.status = 'active' and c.organization_id = ctx.organization_id
      order by cm.chapter_id
      limit 1
    ) membership on true
    where 'members' = any(clean_domains)
    union all
    -- A case belongs to its own organization and chapter, never to the
    -- member's current profile placement. Restricted cases are exported only
    -- when the exporter may read them under the casework access rule.
    select 'cases', c.updated_at,
      pg_catalog.jsonb_build_object(
        'caseId', c.id, 'reference', c.reference, 'title', c.title, 'type', c.case_type,
        'step', c.step, 'status', c.status, 'deadline', c.deadline, 'memberId', c.user_id,
        'chapterId', c.chapter_id
      )
    from public.member_cases c
    where 'cases' = any(clean_domains) and c.organization_id = ctx.organization_id
      and (not c.is_restricted or private.casework_staff_can_access(c.id))
    union all
    select 'tasks', t.updated_at,
      pg_catalog.jsonb_build_object(
        'taskId', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
        'workstream', t.workstream, 'dueDate', t.due_date, 'progress', t.progress,
        'blocked', t.blocked, 'chapterId', t.chapter_id
      )
    from public.chapter_tasks t join public.chapters ch on ch.id = t.chapter_id
    where 'tasks' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and t.deleted_at is null
    union all
    select 'minutes', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'title', r.title, 'occurredAt', r.occurred_at,
        'status', r.lifecycle_status, 'visibility', r.visibility, 'version', r.version,
        'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'minutes' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type = 'minutes' and r.archived_at is null
    union all
    select 'timeline', r.occurred_at,
      pg_catalog.jsonb_build_object(
        'recordId', r.id, 'type', r.record_type, 'title', r.title, 'body', r.body,
        'occurredAt', r.occurred_at, 'status', r.lifecycle_status,
        'visibility', r.visibility, 'version', r.version, 'pinned', r.pinned_at is not null,
        'gapNote', r.gap_note, 'chapterId', r.chapter_id
      )
    from public.chapter_records r join public.chapters ch on ch.id = r.chapter_id
    where 'timeline' = any(clean_domains) and ch.organization_id = ctx.organization_id
      and r.record_type in ('decision','milestone') and r.archived_at is null
    union all
    select 'contacts', l.occurred_at,
      pg_catalog.jsonb_build_object(
        'contactId', l.id, 'kind', l.contact_kind, 'channel', l.channel,
        'purpose', l.purpose, 'summary', l.summary, 'outcome', l.outcome,
        'occurredAt', l.occurred_at, 'followUpAt', l.follow_up_at,
        'subjectMemberId', l.subject_user_id, 'caseId', l.case_id, 'taskId', l.task_id,
        'chapterId', l.chapter_id
      )
    from public.chapter_contact_log l
    where 'contacts' = any(clean_domains) and l.organization_id = ctx.organization_id and l.archived_at is null
  ), bounded as (
    select * from export_rows
    where (p_from is null or occurred_at >= p_from)
      and (p_to is null or occurred_at <= p_to)
    order by occurred_at desc, domain, values::text
    limit 10001
  )
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('domain', domain, 'occurredAt', occurred_at, 'values', values) order by occurred_at desc, domain), '[]'::jsonb)
  into total, rows from bounded;

  if total > 10000 then
    raise exception 'export exceeds 10000 rows; narrow the date range or domains' using errcode = '54000';
  end if;

  if prior.id is not null then
    receipt := prior.id;
    expires := prior.expires_at;
  else
  insert into public.organization_data_export_runs (
    organization_id, requested_by, format, domains, filters, row_count, expires_at, idempotency_key
  ) values (
    ctx.organization_id, ctx.caller_id, p_format, clean_domains,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('from', p_from, 'to', p_to)),
    total, expires, p_idempotency_key
  ) returning id into receipt;

  perform private.mi1_w2_write_audit(
    ctx.organization_id,
    'organization_export_completed',
    pg_catalog.jsonb_build_object(
      'exportType', 'filtered',
      'exportFormat', p_format,
      'rowCount', total,
      'status', 'completed'
    )
  );
  end if;

  return pg_catalog.jsonb_build_object(
    'receiptId', receipt, 'format', p_format, 'domains', clean_domains,
    'rowCount', total, 'expiresAt', expires, 'rows', rows
  );
end;
end;
$function$;

-- ===========================================================================
-- H7. The Home takeover message comes from the selected organization
-- ===========================================================================

-- Neither member_conversations nor member_messages recorded an organization,
-- so a sender's CURRENT role grants cannot say which organization a message
-- was sent in (a steward of organizations A and B, or one who moved). The
-- conversation now records it. Null means unknown and never matches.
alter table public.member_conversations
  add column organization_id uuid
    references public.organizations(id) on update cascade on delete restrict;

create index member_conversations_organization_idx
  on public.member_conversations (organization_id)
  where organization_id is not null;

comment on column public.member_conversations.organization_id is
  'BUG-UG-HOME-TAKEOVER-ORG-SCOPE-20261002: the organization the conversation was opened in, '
  'stamped at creation from the creating sender''s selected organization '
  '(private.current_member_organization()) by private.stamp_member_conversation_organization(); '
  'never client-supplied. Null (unknown or ambiguous history) never matches an organization.';

-- Stamped once at creation from the creating sender's selected organization:
-- private.current_member_organization(), the resolver the steward send path
-- (public.send_connected_workflow_message) and the member conversation
-- writers already apply to the caller. Every creation path (the member's
-- general thread, a steward card's thread, a steward's first contact) goes
-- through this trigger, so a signed-in caller can neither choose nor change
-- the organization: an insert takes the resolver's answer whatever the row
-- carried, and an update keeps the stored value. A trusted server context
-- with no signed-in caller (this migration, service jobs, seeds) keeps the
-- value it wrote.
create function private.stamp_member_conversation_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.organization_id := private.current_member_organization();
  else
    new.organization_id := old.organization_id;
  end if;
  return new;
end;
$function$;

revoke all on function private.stamp_member_conversation_organization() from public, anon, authenticated, service_role;

create trigger b10_member_conversations_organization
before insert or update of organization_id on public.member_conversations
for each row execute function private.stamp_member_conversation_organization();

-- Backfill: a conversation gets an organization only when every steward who
-- took part in it (its chosen steward and every steward sender other than the
-- member) together resolve to exactly ONE organization through an
-- organization role, a chapter staff role, a profile chapter or an active
-- membership. Anything else (no steward yet, or two organizations) stays null
-- and never takes over Home. The backfill does not touch updated_at, so
-- thread order is unchanged.
alter table public.member_conversations disable trigger member_conversations_touch_updated_at;

with conversation_stewards as (
  select c.id as conversation_id, c.steward_user_id as steward_id
  from public.member_conversations c
  where c.organization_id is null and c.steward_user_id is not null
  union
  select m.conversation_id, m.sender_id
  from public.member_messages m
  join public.member_conversations c on c.id = m.conversation_id
  where c.organization_id is null
    and m.sender_kind = 'steward'
    and m.sender_id is not null
    and m.sender_id is distinct from c.user_id
),
steward_organizations as (
  select g.user_id as steward_id, g.organization_id
  from public.organization_role_grants g
  union
  select r.user_id, ch.organization_id
  from public.member_roles r
  join public.chapters ch on ch.id = r.chapter_id
  where r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    and ch.organization_id is not null
  union
  select p.id, ch.organization_id
  from public.member_profiles p
  join public.chapters ch on ch.id = p.chapter_id
  where ch.organization_id is not null
  union
  select om.user_id, om.organization_id
  from public.organization_memberships om
  where om.status = 'active'
),
resolved as (
  select cs.conversation_id, (pg_catalog.array_agg(distinct so.organization_id))[1] as organization_id
  from conversation_stewards cs
  join steward_organizations so on so.steward_id = cs.steward_id
  group by cs.conversation_id
  having pg_catalog.count(distinct so.organization_id) = 1
)
update public.member_conversations c
set organization_id = resolved.organization_id
from resolved
where c.id = resolved.conversation_id;

alter table public.member_conversations enable trigger member_conversations_touch_updated_at;

-- Account lifecycle: the new member_conversations trigger and its function
-- join the reviewed referential-action trigger surface. It only sets the new
-- row's organization_id and never blocks a cascade from auth.users.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
  ('function', 'private', '', 'stamp_member_conversation_organization()'),
  ('trigger', 'public', 'member_conversations', 'b10_member_conversations_organization')
) as changed(kind, schema_name, table_name, object_name)
  on surface.kind = changed.kind and surface.schema_name = changed.schema_name
 and surface.table_name = changed.table_name and surface.object_name = changed.object_name;

do $assert_conversation_organization_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the conversation organization stamp';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after the conversation organization stamp';
  end if;
end;
$assert_conversation_organization_lifecycle$;

create or replace function public.get_member_home_takeover()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  joined_at timestamptz;
  message_item jsonb;
  broadcast_item jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  if org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  if not private.organization_feature_enabled(org, 'features.home.unread_message_takeover') then
    return pg_catalog.jsonb_build_object('enabled', false, 'message', null, 'broadcast', null);
  end if;

  -- Newest unread steward direct message to the caller in a conversation of
  -- the selected organization (member_conversations.organization_id, stamped
  -- at creation). A conversation without an organization never matches.
  -- Bounded preview: the full thread opens in Messages.
  select pg_catalog.jsonb_build_object(
      'id', m.id,
      'conversationId', m.conversation_id,
      'senderName', m.sender_name,
      'body', pg_catalog.left(m.body, 600),
      'truncated', pg_catalog.char_length(m.body) > 600,
      'createdAt', m.created_at
    )
  into message_item
  from public.member_messages m
  join public.member_conversations c on c.id = m.conversation_id and c.user_id = caller
  where m.user_id = caller
    and c.organization_id = org
    and m.sender_kind = 'steward'
    and m.sender_id is distinct from caller
    and m.read_at is null
    and m.redacted_at is null
  order by m.created_at desc, m.id desc
  limit 1;

  select membership.created_at into joined_at
  from public.organization_memberships membership
  where membership.organization_id = org
    and membership.user_id = caller
    and membership.status = 'active';

  -- Newest unread broadcast the caller can see, published since they joined.
  select pg_catalog.jsonb_build_object(
      'id', b.id,
      'sender', b.sender,
      'title', b.title,
      'body', pg_catalog.left(b.body, 600),
      'truncated', pg_catalog.char_length(b.body) > 600,
      'publishedAt', b.published_at,
      'audience', b.audience_scope
    )
  into broadcast_item
  from public.member_broadcasts b
  where b.id in (select private.visible_member_broadcast_ids())
    and b.organization_id = org
    and b.retracted_at is null
    and b.published_at <= pg_catalog.now()
    and (joined_at is null or b.published_at >= joined_at)
    and not exists (
      select 1 from public.member_broadcast_receipts r
      where r.broadcast_id = b.id and r.user_id = caller
    )
  order by b.published_at desc, b.id desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'message', message_item,
    'broadcast', broadcast_item
  );
end;
$function$;

revoke all on function public.get_member_home_takeover() from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_takeover() to authenticated;

-- ===========================================================================
-- H8. Bounded steward deadline sweep on the shared settings helpers
-- ===========================================================================

create or replace function private.staff_deadline_notice_sweep()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deadline record;
  v_recipient uuid;
  v_sent integer;
  v_read integer;
  v_batch_rows integer;
  v_batch_size integer;
  v_max_rows integer;
  v_after_due date;
  v_after_source text;
  v_after_id uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_sent := 0;
  v_read := 0;
  -- The case-graph lock is held for this transaction, so one run reads at
  -- most v_max_rows due deadlines in keyset batches. Only work that is due
  -- (inside the organization's window and not yet announced at today's
  -- stage) is read; switched-off organizations never enter the scan. Nearer
  -- deadlines come first and the remainder is reached on the next run.
  v_batch_size := 100;
  v_max_rows := 500;
  v_after_due := '-infinity'::date;
  v_after_source := '';
  v_after_id := '00000000-0000-0000-0000-000000000000'::uuid;
  delete from private.staff_deadline_notice_marks mark
   where mark.due_on < current_date - 7;
  loop
    v_batch_rows := 0;
    for v_deadline in
      select candidate.source, candidate.deadline_id, candidate.case_id,
             candidate.organization_id, candidate.owner_id,
             candidate.steward_user_id, candidate.coordinator_user_id,
             candidate.due_on, stage.days, stage.stage
        from (
          select 'member_case'::text as source, c.id as deadline_id, c.id as case_id,
                 c.organization_id, c.user_id as owner_id,
                 c.steward_user_id, c.coordinator_user_id, c.deadline as due_on
            from public.member_cases c
           where c.status = 'active'
             and c.deadline between current_date and current_date + 30
             and (c.steward_user_id is not null or c.coordinator_user_id is not null)
             and private.organization_feature_enabled(c.organization_id, 'features.notifications.steward_deadline_reminders')
          union all
          select 'casework_deadline', d.id, c.id,
                 c.organization_id, c.user_id,
                 c.steward_user_id, c.coordinator_user_id, (d.due_at at time zone 'UTC')::date
            from public.casework_deadlines d
            join public.member_cases c on c.id = d.case_id and c.organization_id = d.organization_id
           where d.status in ('active', 'extended')
             and c.status = 'active'
             and d.due_at >= (current_date::timestamp at time zone 'UTC')
             and d.due_at < ((current_date + 31)::timestamp at time zone 'UTC')
             and (c.steward_user_id is not null or c.coordinator_user_id is not null)
             and private.organization_feature_enabled(c.organization_id, 'features.notifications.steward_deadline_reminders')
        ) candidate
        cross join lateral (
          select candidate.due_on - current_date as days,
                 (case
                    when candidate.due_on - current_date <= 0 then 3
                    when candidate.due_on - current_date = 1 then 2
                    when candidate.due_on - current_date <= least(greatest(coalesce(private.organization_limit(
                      candidate.organization_id, 'limits.notifications.steward_deadline_reminder_days'), 3), 1), 30) then 1
                  end)::smallint as stage
        ) stage
       where stage.stage is not null
         and (candidate.due_on, candidate.source, candidate.deadline_id)
             > (v_after_due, v_after_source, v_after_id)
         and not exists (
           select 1 from private.staff_deadline_notice_marks mark
            where mark.source = candidate.source
              and mark.deadline_id = candidate.deadline_id
              and mark.due_on = candidate.due_on
              and mark.stage >= stage.stage
         )
       order by candidate.due_on, candidate.source, candidate.deadline_id
       limit least(v_batch_size, v_max_rows - v_read)
    loop
      v_batch_rows := v_batch_rows + 1;
      v_read := v_read + 1;
      v_after_due := v_deadline.due_on;
      v_after_source := v_deadline.source;
      v_after_id := v_deadline.deadline_id;
      insert into private.staff_deadline_notice_marks as mark (source, deadline_id, due_on, stage)
      values (v_deadline.source, v_deadline.deadline_id, v_deadline.due_on, v_deadline.stage)
      on conflict (source, deadline_id, due_on) do update
        set stage = excluded.stage, marked_at = pg_catalog.now()
        where mark.stage < excluded.stage;
      if not found then
        continue;
      end if;
      for v_recipient in
        select distinct assignee.user_id
          from (values (v_deadline.steward_user_id), (v_deadline.coordinator_user_id)) as assignee(user_id)
         where assignee.user_id is not null
           -- The case owner already gets the member deadline notice.
           and not (v_deadline.source = 'member_case' and assignee.user_id = v_deadline.owner_id)
      loop
        if private.casework_reminder_owner_can_read(v_recipient, v_deadline.case_id) then
          perform private.notify_member(
            v_recipient,
            case v_deadline.stage when 3 then 'deadline.staff.today' when 2 then 'deadline.staff.tomorrow' else 'deadline.staff.days' end,
            case when v_deadline.stage = 1 then pg_catalog.jsonb_build_object('days', v_deadline.days::text) else '{}'::jsonb end,
            'deadlines');
          v_sent := v_sent + 1;
        end if;
      end loop;
    end loop;
    exit when v_batch_rows < v_batch_size or v_read >= v_max_rows;
  end loop;
  return v_sent;
end;
$function$;

revoke all on function private.staff_deadline_notice_sweep() from public, anon, authenticated, service_role;

comment on function private.staff_deadline_notice_sweep() is
  'BUG-UG-STEWARD-DEADLINE-REMINDERS-20261001 / BUG-UG-STEWARD-DEADLINE-SWEEP-UNBOUNDED-20261002: warns the assigned steward and coordinator of each active member_cases.deadline and casework_deadlines due date once per threshold (window, day before, due day). Reads at most 500 due, not-yet-announced deadlines per run in keyset batches of 100, nearest first, with switched-off organizations excluded in the scan; re-checks case access per recipient and names no case.';

-- The sign-in throttle reads its platform-wide limits through the shared
-- settings helper (a null organization reads the definition default, exactly
-- what private.urgent_b_setting_limit(null, ...) returned).
create or replace function public.consume_password_signin_attempt(p_email text, p_network text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  network text := coalesce(p_network, '');
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     or network !~ '^(ipv4:[0-9]{1,3}(\.[0-9]{1,3}){3}|ipv6:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::/64|unknown)$' then
    raise exception 'invalid sign-in attempt' using errcode = '22023';
  end if;
  -- The network bucket is charged first: a network that is already over its
  -- budget does not also spend the address's budget.
  if not private.auth_attempt_check('password-signin-network', network,
      private.organization_limit(null, 'limits.security.signin_attempts_per_ip_hour'),
      interval '1 hour') then
    return false;
  end if;
  return private.auth_attempt_check('password-signin-email', normalized_email,
    private.organization_limit(null, 'limits.security.signin_attempts_per_email_hour'),
    interval '1 hour');
end;
$function$;

revoke all on function public.consume_password_signin_attempt(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_password_signin_attempt(text, text) to service_role;

-- ===========================================================================
-- H10. Password verification attempt hook (every password grant)
-- ===========================================================================

-- Read-only twin of private.auth_attempt_check: true when the bucket already
-- holds p_limit attempts in its current window. Charges nothing.
create function private.auth_attempt_exhausted(
  p_scope text,
  p_key text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  key_secret bytea;
  digest text;
  current_row private.auth_attempt_throttle%rowtype;
begin
  if p_scope is null or p_scope !~ '^[a-z][a-z0-9-]{2,62}$'
     or p_key is null or pg_catalog.char_length(p_key) not between 1 and 512
     or p_limit is null or p_limit < 1
     or p_window is null or p_window < interval '1 second' or p_window > interval '1 day' then
    raise exception 'invalid attempt throttle' using errcode = '22023';
  end if;
  select k.secret into key_secret from private.auth_attempt_throttle_key k where k.id;
  if key_secret is null then
    raise exception 'attempt throttle key unavailable' using errcode = '55000';
  end if;
  digest := pg_catalog.encode(extensions.hmac(
    pg_catalog.convert_to(p_scope || ':' || p_key, 'UTF8'), key_secret, 'sha256'), 'hex');
  select * into current_row
  from private.auth_attempt_throttle t
  where t.scope = p_scope and t.key_hash = digest;
  return found
    and current_row.window_started_at + p_window > pg_catalog.now()
    and current_row.attempt_count >= p_limit;
end;
$function$;

revoke all on function private.auth_attempt_exhausted(text, text, integer, interval)
  from public, anon, authenticated, service_role;

comment on function private.auth_attempt_exhausted(text, text, integer, interval) is
  'SEC-UG-PASSWORD-GRANT-THROTTLE-BYPASS-20261002: read-only check of a private.auth_attempt_check bucket; charges nothing.';

-- Supabase Auth "password verification attempt" hook. GoTrue calls it for
-- every password grant on an existing account with {user_id, valid}, whether
-- the request came through api/auth-password-signin.js or straight to
-- /auth/v1/token?grant_type=password. A wrong password spends one attempt in
-- the account's bucket; once the platform-wide per-account budget
-- (limits.security.signin_attempts_per_email_hour, one-hour window) is spent,
-- every attempt for that account, right or wrong, is refused with GoTrue's own
-- invalid-credentials message, so the answer neither confirms the password nor
-- differs from an unknown account's. The per-network budget cannot be enforced
-- here because the hook carries no client address.
create function public.auth_password_verification_attempt_hook(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  account text := p_event ->> 'user_id';
  attempt_limit integer;
  refused constant jsonb := '{"decision": "reject", "message": "Invalid login credentials", "should_logout_user": false}'::jsonb;
begin
  if account is null or account !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return refused;
  end if;
  account := pg_catalog.lower(account);
  attempt_limit := private.organization_limit(null, 'limits.security.signin_attempts_per_email_hour');
  if (p_event -> 'valid') = 'true'::jsonb then
    if private.auth_attempt_exhausted('password-hook-account', account, attempt_limit, interval '1 hour') then
      return refused;
    end if;
    return '{"decision": "continue"}'::jsonb;
  end if;
  if not private.auth_attempt_check('password-hook-account', account, attempt_limit, interval '1 hour') then
    return refused;
  end if;
  return '{"decision": "continue"}'::jsonb;
end;
$function$;

revoke all on function public.auth_password_verification_attempt_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.auth_password_verification_attempt_hook(jsonb) to supabase_auth_admin;

comment on function public.auth_password_verification_attempt_hook(jsonb) is
  'SEC-UG-PASSWORD-GRANT-THROTTLE-BYPASS-20261002: Supabase Auth password verification attempt hook (executable by supabase_auth_admin only). Throttles failed password attempts per account for every password grant; a spent budget refuses every attempt with the same invalid-credentials message. Enable it on the hosted project:';

-- ===========================================================================
-- H11. Quarterly "give to view" gate, enforced on the member report reads
-- ===========================================================================

-- The one gate rule (20261002100000), for the signed-in caller in an
-- organization: admins pass, the organization switch turns it off, and it
-- locks only while the caller can answer the current quarter's open,
-- in-window, chapter-visible survey and has not submitted it.
create function private.quarterly_survey_gate_state(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := p_organization_id;
  actor uuid := (select auth.uid());
  actor_chapter text := private.current_member_chapter();
  current_period text := pg_catalog.to_char(current_date, 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', current_date)::integer;
  gate_enabled boolean;
  is_admin boolean;
  survey public.organization_surveys%rowtype;
  answerable boolean;
  session_status text;
  completed boolean;
  gate_reason text;
begin
  gate_enabled := private.organization_feature_enabled(org, 'features.engagement_voice.quarterly_survey_gate');
  is_admin := private.has_organization_role(org, array['admin']);

  select * into survey
  from public.organization_surveys s
  where s.organization_id = org
    and s.cadence = 'quarterly'
    and s.period_key = current_period
    and s.status in ('open', 'closed')
  order by case when s.status = 'open' then 0 else 1 end, s.updated_at desc
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'periodKey', current_period, 'surveyId', null, 'required', false,
      'completed', false, 'unlocked', true,
      'reason', case when is_admin then 'admin' when not gate_enabled then 'disabled' else 'no_survey' end,
      'gateEnabled', gate_enabled
    );
  end if;

  answerable := survey.status = 'open'
    and (survey.chapter_id is null or survey.chapter_id = actor_chapter)
    and (survey.opens_at is null or survey.opens_at <= pg_catalog.now())
    and (survey.closes_at is null or survey.closes_at > pg_catalog.now());

  select session.status into session_status
  from public.organization_survey_sessions session
  where session.organization_id = org
    and session.survey_id = survey.id
    and session.respondent_user_id = actor;
  completed := coalesce(session_status = 'submitted', false);

  gate_reason := case
    when is_admin then 'admin'
    when not gate_enabled then 'disabled'
    when completed then 'completed'
    when not answerable then 'unavailable'
    else 'incomplete'
  end;

  return pg_catalog.jsonb_build_object(
    'periodKey', current_period,
    'surveyId', survey.id,
    'title', survey.title,
    'required', answerable,
    'completed', completed,
    'unlocked', gate_reason <> 'incomplete',
    'reason', gate_reason,
    'gateEnabled', gate_enabled,
    'status', coalesce(session_status, 'not_started'),
    'closesAt', survey.closes_at
  );
end;
$function$;

revoke all on function private.quarterly_survey_gate_state(uuid) from public, anon, authenticated, service_role;

comment on function private.quarterly_survey_gate_state(uuid) is
  'REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002: the single quarterly "give to view" rule for the caller in an organization (admin exempt, switch, fail open without an answerable survey). Read by public.get_quarterly_survey_gate and, through private.quarterly_survey_gate_locks_caller, by every gated report read.';

-- True only when the gate locks the signed-in caller right now. Every
-- refusal or missing context fails open: the gated reads keep their own
-- authorization, and the member's survey flow never consults this.
create function private.quarterly_survey_gate_locks_caller()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    return false;
  end if;
  begin
    org := private.engagement_selected_organization();
  exception when insufficient_privilege then
    return false;
  end;
  if org is null or not private.is_organization_member(org) then
    return false;
  end if;
  return (private.quarterly_survey_gate_state(org) ->> 'reason') = 'incomplete';
end;
$function$;

revoke all on function private.quarterly_survey_gate_locks_caller() from public, anon, authenticated, service_role;

comment on function private.quarterly_survey_gate_locks_caller() is
  'REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002: true when the quarterly gate locks the signed-in caller; fails open on any missing context.';

create or replace function public.get_quarterly_survey_gate()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return private.quarterly_survey_gate_state(org);
end;
$function$;

comment on function public.get_quarterly_survey_gate() is
  'Quarterly "give to view" gate (CR-002; server-enforced since REQ-UG-QUARTERLY-SURVEY-GATE-SERVER-ENFORCED-20261002). unlocked=false only when the organization switch features.engagement_voice.quarterly_survey_gate is on, the caller is not an organization admin, and the current quarter''s open, in-window, chapter-visible quarterly survey has no submitted session from the caller. Every other case fails open. The member report reads return a locked payload under the same rule.';

create or replace function public.get_workload_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  loc_now timestamp := (pg_catalog.now() at time zone 'America/New_York');
  q_start_local timestamp := pg_catalog.date_trunc('quarter', loc_now) - interval '3 months';
  q_end_local timestamp := pg_catalog.date_trunc('quarter', loc_now);
  q_start timestamptz := q_start_local at time zone 'America/New_York';
  q_end timestamptz := q_end_local at time zone 'America/New_York';
  period_label text := pg_catalog.date_part('year', q_start_local)::int::text
    || '-Q' || pg_catalog.date_part('quarter', q_start_local)::int::text;
  n_sub integer;
  k constant integer := 25;
  cats jsonb;
  tiles jsonb;
  band text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Quarterly "give to view": a locked member gets no workload statistics.
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'quarterly_survey_gate', 'locked', true,
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'chapter_unavailable',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;

  select pg_catalog.count(*) into n_sub from (
    select distinct on (w.user_id) w.id
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ) s;

  if n_sub < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'anonymity_floor',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  band := case when n_sub >= 100 then '100+' when n_sub >= 50 then '50-99' else '25-49' end;

  with latest as (
    select distinct on (w.user_id)
      w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
      w.ce_activities, w.assistance_requests, w.aged_cases,
      w.employment, least(w.ot_hours, 40) as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ), values_by_key as (
    select v.key, v.ord, least(v.value, 150)::numeric as value
    from latest l
    cross join lateral (values
      ('priority', 1, l.priority), ('pending', 2, l.pending),
      ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
      ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
      ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
    ) v(key, ord, value)
  ), metrics as (
    select key, ord,
      pg_catalog.round(pg_catalog.avg(value)) as avg,
      pg_catalog.percentile_disc(0.5) within group (order by value) as median,
      pg_catalog.percentile_disc(0.9) within group (order by value) as p90
    from values_by_key group by key, ord
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', key, 'avg', avg, 'median', median, 'p90', p90) order by ord)
  into cats from metrics;

  with latest as (
    select distinct on (w.user_id) w.employment, least(w.ot_hours, 40) as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  )
  select pg_catalog.jsonb_build_object(
    'pctFullTime', pg_catalog.round(100.0 * pg_catalog.avg((employment = 'full_time')::int) / 10.0) * 10,
    'pctPartTime', pg_catalog.round(100.0 * pg_catalog.avg((employment = 'part_time')::int) / 10.0) * 10,
    'avgOtHours', pg_catalog.round(pg_catalog.avg(ot_hours)::numeric, 1))
  into tiles from latest;

  return pg_catalog.jsonb_build_object(
    'enoughData', true, 'period', period_label, 'generatedAt', pg_catalog.now(),
    'submittersBand', band, 'categories', cats, 'tiles', tiles);
end;
$function$;

create or replace function public.get_chapter_standing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  k constant integer := 25;
  q_end timestamptz;
  q_start timestamptz;
  period_label text;
  cohort integer;
  my_total bigint;
  ahead integer;
  pct numeric;
  standing text;
  cohort_band text;
begin
  if caller is null or not (select private.mfa_satisfied()) then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select chapter_id into caller_chapter
  from public.member_profiles
  where id = caller;

  q_end := pg_catalog.date_trunc('quarter', now() at time zone 'America/New_York') at time zone 'America/New_York';
  q_start := (pg_catalog.date_trunc('quarter', now() at time zone 'America/New_York') - interval '3 months') at time zone 'America/New_York';
  period_label := pg_catalog.to_char(q_start at time zone 'America/New_York', 'YYYY "Q"Q');

  -- Quarterly "give to view": a locked member gets no chapter standing.
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'quarterly_survey_gate', 'locked', true,
      'minCohort', k, 'period', period_label, 'generatedAt', now());
  end if;

  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minCohort', k, 'period', period_label, 'generatedAt', now());
  end if;

  -- MATERIALIZED is load-bearing: each aggregate below reads the compact
  -- per-member result, while the event table and profile join execute once.
  with member_totals as materialized (
    select e.user_id, pg_catalog.sum(e.points)::bigint as total
    from public.member_point_events e
    join public.member_profiles p on p.id = e.user_id
    where p.chapter_id = caller_chapter
      and e.occurred_at >= q_start
      and e.occurred_at < q_end
    group by e.user_id
  ), ranked as (
    select total,
      coalesce(
        pg_catalog.max(total) filter (where user_id = caller) over (),
        0::bigint
      ) as caller_total
    from member_totals
  )
  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.max(caller_total), 0)::bigint,
    pg_catalog.count(*) filter (where total > caller_total)::integer
  into cohort, my_total, ahead
  from ranked;

  if cohort < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minCohort', k, 'period', period_label, 'generatedAt', now());
  end if;

  pct := ahead::numeric / cohort;
  standing := case
    when my_total = 0 then 'active'
    when pct < 0.10 then 'top10'
    when pct < 0.25 then 'top25'
    when pct < 0.50 then 'topHalf'
    else 'active'
  end;
  cohort_band := case
    when cohort >= 100 then '100+'
    when cohort >= 50 then '50-99'
    else '25-49'
  end;

  return pg_catalog.jsonb_build_object(
    'enoughData', true,
    'period', period_label,
    'cohortBand', cohort_band,
    'standingBand', standing,
    'generatedAt', now());
end;
$$;

create or replace function public.get_my_analytics_report_card()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  event_count integer := 0;
  participation integer := 0;
  profile_readiness integer := 0;
  follow_through integer := 0;
  last_activity timestamptz;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Quarterly "give to view": a locked member gets no report card.
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'locked', true, 'reason', 'quarterly_survey_gate',
      'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;

  select pg_catalog.count(*)::integer, pg_catalog.max(e.occurred_at)
    into event_count, last_activity
  from public.organization_engagement_events e
  where e.organization_id = org
    and e.user_id = caller
    and e.occurred_at >= pg_catalog.now() - interval '180 days';

  if event_count = 0 then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;

  select
    (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end)
    + (case when exists (
        select 1
        from public.member_chapter_memberships m
        join public.chapters c on c.id = m.chapter_id and c.organization_id = org
        where m.user_id = caller and m.status = 'active' and m.chapter_id = p.chapter_id
      ) then 50 else 0 end)
    into profile_readiness
  from public.member_profiles p
  where p.id = caller;

  participation := least(100, event_count * 10);
  select least(100, pg_catalog.count(*)::integer * 20)
    into follow_through
  from public.organization_engagement_events e
  where e.organization_id = org
    and e.user_id = caller
    and e.occurred_at >= pg_catalog.now() - interval '90 days'
    and e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp');

  return pg_catalog.jsonb_build_object(
    'overall', pg_catalog.round((participation + profile_readiness + follow_through)::numeric / 3),
    'participation', participation,
    'profileReadiness', profile_readiness,
    'followThrough', follow_through,
    'generatedAt', pg_catalog.now(),
    'signals', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('label', 'Protected activities (180 days)', 'value', event_count),
      pg_catalog.jsonb_build_object('label', 'Days since last activity', 'value',
        greatest(0, (current_date - last_activity::date)))
    )
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;
