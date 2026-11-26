-- CR-088: organization-scoped Constant Contact activation, sync, and analytics.
--
-- Clean-room adaptation of approved donor baseline
-- donor-baseline-20260721. This migration rejects the
-- donor's global token tables, branch authorization, raw provider payloads,
-- and direct client writes. Production remains valid with zero organizations
-- and no configured provider credentials.

set local lock_timeout = '5s';

create table private.constant_contact_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null check (pg_catalog.char_length(code_verifier) between 43 and 128),
  redirect_uri text not null check (redirect_uri in (
    'https://app.example.invalid/api/constant-contact-oauth',
    'https://demo.example.com/api/constant-contact-oauth'
  )),
  browser_binding_hash text not null check (browser_binding_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now()
);

create table private.constant_contact_oauth_tokens (
  organization_id uuid primary key references public.organizations(id) on update cascade on delete cascade,
  secret_ref uuid not null unique,
  account_label text not null default 'Connected account'
    check (pg_catalog.char_length(account_label) between 1 and 120 and account_label !~ '[[:cntrl:]]'),
  scope text not null default '' check (pg_catalog.char_length(scope) <= 2000),
  status text not null default 'connected' check (status in ('connected', 'error', 'revoked')),
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default pg_catalog.now(),
  last_sync_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_-]{1,64}$'),
  updated_at timestamptz not null default pg_catalog.now()
);

revoke all on table private.constant_contact_oauth_states from public, anon, authenticated, service_role;
revoke all on table private.constant_contact_oauth_tokens from public, anon, authenticated, service_role;

alter table public.integration_jobs
  drop constraint if exists integration_jobs_job_kind_check;
alter table public.integration_jobs
  add constraint integration_jobs_job_kind_check check (job_kind in (
    'provider_health', 'connection_probe', 'webhook_deliver', 'webhook_retry',
    'constant_contact_sync'
  ));

create table public.constant_contact_sync_requests (
  job_id uuid primary key references public.integration_jobs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  limit_count integer not null check (limit_count between 1 and 25),
  created_at timestamptz not null default pg_catalog.now()
);

create table public.constant_contact_member_analytics (
  organization_id uuid not null,
  member_id uuid not null,
  provider_contact_id text,
  contact_status text not null check (contact_status in ('active', 'deleted', 'unsubscribed', 'not_found', 'unknown')),
  list_count integer not null default 0 check (list_count between 0 and 100000),
  tag_count integer not null default 0 check (tag_count between 0 and 100000),
  sends_count integer not null default 0 check (sends_count between 0 and 1000000),
  opens_count integer not null default 0 check (opens_count between 0 and 1000000),
  clicks_count integer not null default 0 check (clicks_count between 0 and 1000000),
  bounces_count integer not null default 0 check (bounces_count between 0 and 1000000),
  optouts_count integer not null default 0 check (optouts_count between 0 and 1000000),
  forwards_count integer not null default 0 check (forwards_count between 0 and 1000000),
  last_activity_at timestamptz,
  synced_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, member_id),
  foreign key (organization_id, member_id)
    references public.organization_memberships (organization_id, user_id) on delete cascade,
  constraint constant_contact_provider_contact_bounded check (
    provider_contact_id is null
    or (pg_catalog.char_length(provider_contact_id) between 1 and 200 and provider_contact_id !~ '[[:cntrl:]]')
  )
);

create index constant_contact_member_analytics_activity_idx
  on public.constant_contact_member_analytics (organization_id, last_activity_at desc nulls last, member_id);

create table public.constant_contact_sync_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  job_id uuid not null unique references public.integration_jobs(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  source text not null check (source in ('cron', 'manual')),
  status text not null check (status in ('success', 'warning', 'failed')),
  processed_count integer not null default 0 check (processed_count between 0 and 25),
  matched_count integer not null default 0 check (matched_count between 0 and 25),
  not_found_count integer not null default 0 check (not_found_count between 0 and 25),
  failed_count integer not null default 0 check (failed_count between 0 and 25),
  error_code text check (error_code is null or error_code ~ '^[a-z0-9_-]{1,64}$'),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint constant_contact_sync_run_counts check (
    matched_count + not_found_count + failed_count <= processed_count
  )
);

create index constant_contact_sync_runs_org_time_idx
  on public.constant_contact_sync_runs (organization_id, finished_at desc, id desc);

alter table public.constant_contact_sync_requests enable row level security;
alter table public.constant_contact_member_analytics enable row level security;
alter table public.constant_contact_sync_runs enable row level security;
create policy mfa_assurance on public.constant_contact_sync_requests
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.constant_contact_member_analytics
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.constant_contact_sync_runs
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
revoke all on table public.constant_contact_sync_requests from public, anon, authenticated;
revoke all on table public.constant_contact_member_analytics from public, anon, authenticated;
revoke all on table public.constant_contact_sync_runs from public, anon, authenticated;

create function private.constant_contact_require_service()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.constant_contact_require_service()
  from public, anon, authenticated, service_role;

create function public.begin_constant_contact_oauth(
  p_state_hash text,
  p_code_verifier text,
  p_redirect_uri text,
  p_browser_binding_hash text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_state_hash !~ '^[0-9a-f]{64}$'
     or p_browser_binding_hash !~ '^[0-9a-f]{64}$'
     or pg_catalog.char_length(coalesce(p_code_verifier, '')) not between 43 and 128
     or p_redirect_uri not in (
       'https://app.example.invalid/api/constant-contact-oauth',
       'https://demo.example.com/api/constant-contact-oauth'
     )
     or p_expires_at <= pg_catalog.now()
     or p_expires_at > pg_catalog.now() + interval '11 minutes' then
    raise exception 'invalid oauth request' using errcode = '22023';
  end if;
  delete from private.constant_contact_oauth_states where expires_at <= pg_catalog.now();
  insert into private.constant_contact_oauth_states (
    state_hash, organization_id, requested_by, code_verifier, redirect_uri,
    browser_binding_hash, expires_at
  ) values (
    p_state_hash, org, (select auth.uid()), p_code_verifier, p_redirect_uri,
    p_browser_binding_hash, p_expires_at
  );
  insert into public.organization_integrations (organization_id, provider, status)
  values (org, 'constant_contact', 'requested')
  on conflict (organization_id, provider) do update
    set status = case
      when public.organization_integrations.status = 'connected' then 'connected'
      else 'requested'
    end,
    updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'constant_contact', 'status', 'oauth_started'
  ));
  return pg_catalog.jsonb_build_object('ok', true);
end;
$function$;

create function public.claim_constant_contact_oauth_state(
  p_state_hash text,
  p_browser_binding_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  state private.constant_contact_oauth_states%rowtype;
begin
  perform private.constant_contact_require_service();
  delete from private.constant_contact_oauth_states source
  where source.state_hash = p_state_hash
    and source.browser_binding_hash = p_browser_binding_hash
    and source.expires_at > pg_catalog.now()
  returning source.* into state;
  if not found then
    raise exception 'invalid oauth state' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', state.organization_id,
    'requestedBy', state.requested_by,
    'codeVerifier', state.code_verifier,
    'redirectUri', state.redirect_uri
  );
end;
$function$;

create function public.complete_constant_contact_oauth(
  p_organization_id uuid,
  p_requested_by uuid,
  p_refresh_token text,
  p_scope text,
  p_account_label text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  secret_id uuid;
  old_ref uuid;
  clean_label text := coalesce(nullif(pg_catalog.btrim(p_account_label), ''), 'Connected account');
begin
  perform private.constant_contact_require_service();
  if p_organization_id is null or p_requested_by is null
     or pg_catalog.char_length(coalesce(p_refresh_token, '')) not between 20 and 4096
     or pg_catalog.char_length(coalesce(p_scope, '')) > 2000
     or pg_catalog.char_length(clean_label) > 120 then
    raise exception 'invalid oauth completion' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_requested_by
      and membership.status = 'active'
      and role.role in ('admin', 'vp')
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select token.secret_ref into old_ref
  from private.constant_contact_oauth_tokens token
  where token.organization_id = p_organization_id
  for update;
  secret_id := vault.create_secret(
    p_refresh_token,
    'constant-contact-' || p_organization_id::text || '-' || extensions.gen_random_uuid()::text,
    'Organization-owned Constant Contact OAuth refresh token'
  );
  insert into private.constant_contact_oauth_tokens (
    organization_id, secret_ref, account_label, scope, status, connected_by
  ) values (
    p_organization_id, secret_id, clean_label, coalesce(p_scope, ''), 'connected', p_requested_by
  ) on conflict (organization_id) do update
    set secret_ref = excluded.secret_ref,
        account_label = excluded.account_label,
        scope = excluded.scope,
        status = 'connected',
        connected_by = excluded.connected_by,
        connected_at = pg_catalog.now(),
        last_error_code = null,
        updated_at = pg_catalog.now();
  insert into public.organization_integrations (
    organization_id, provider, status, account_owner, default_settings, credential_ref
  ) values (
    p_organization_id, 'constant_contact', 'connected', 'organization',
    pg_catalog.jsonb_build_object('accountLabel', clean_label, 'scope', coalesce(p_scope, '')),
    secret_id::text
  ) on conflict (organization_id, provider) do update
    set status = 'connected', account_owner = 'organization',
        default_settings = excluded.default_settings,
        credential_ref = excluded.credential_ref,
        last_error_code = null,
        updated_at = pg_catalog.now();
  if old_ref is not null and old_ref is distinct from secret_id then
    delete from vault.secrets where id = old_ref;
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'integration_provider_changed', p_requested_by,
    extensions.gen_random_uuid(), pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id, 'provider', 'constant_contact',
      'status', 'connected', 'action', 'oauth_completed'
    )
  );
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'connected');
end;
$function$;

create function public.list_constant_contact_control()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'status', coalesce((select integration.status from public.organization_integrations integration
      where integration.organization_id = org and integration.provider = 'constant_contact'), 'unset'),
    'connected', exists (select 1 from private.constant_contact_oauth_tokens token
      where token.organization_id = org and token.status = 'connected'),
    'accountLabel', (select token.account_label from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'scope', (select token.scope from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'lastSyncAt', (select token.last_sync_at from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'lastErrorCode', (select token.last_error_code from private.constant_contact_oauth_tokens token
      where token.organization_id = org),
    'memberCount', (select pg_catalog.count(*) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org),
    'activeContactCount', (select pg_catalog.count(*) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org and analytics.contact_status = 'active'),
    'sendCount', (select coalesce(pg_catalog.sum(analytics.sends_count), 0) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org),
    'openCount', (select coalesce(pg_catalog.sum(analytics.opens_count), 0) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org),
    'clickCount', (select coalesce(pg_catalog.sum(analytics.clicks_count), 0) from public.constant_contact_member_analytics analytics
      where analytics.organization_id = org)
  );
end;
$function$;

create function public.list_constant_contact_sync_runs(p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  page_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', run.id, 'jobId', run.job_id, 'source', run.source,
      'status', run.status, 'processedCount', run.processed_count,
      'matchedCount', run.matched_count, 'notFoundCount', run.not_found_count,
      'failedCount', run.failed_count, 'errorCode', run.error_code,
      'startedAt', run.started_at, 'finishedAt', run.finished_at
    ) order by run.finished_at desc, run.id desc)
    from (
      select source.* from public.constant_contact_sync_runs source
      where source.organization_id = org
      order by source.finished_at desc, source.id desc limit page_limit
    ) run
  ), '[]'::jsonb);
end;
$function$;

create function public.list_constant_contact_analytics(p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  page_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'memberId', analytics.member_id,
      'memberName', coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Member'),
      'contactStatus', analytics.contact_status,
      'listCount', analytics.list_count, 'tagCount', analytics.tag_count,
      'sendsCount', analytics.sends_count, 'opensCount', analytics.opens_count,
      'clicksCount', analytics.clicks_count, 'bouncesCount', analytics.bounces_count,
      'optoutsCount', analytics.optouts_count, 'forwardsCount', analytics.forwards_count,
      'lastActivityAt', analytics.last_activity_at, 'syncedAt', analytics.synced_at
    ) order by analytics.last_activity_at desc nulls last, analytics.member_id)
    from (
      select source.* from public.constant_contact_member_analytics source
      where source.organization_id = org
      order by source.last_activity_at desc nulls last, source.member_id
      limit page_limit
    ) analytics
    left join public.member_profiles profile on profile.id = analytics.member_id
  ), '[]'::jsonb);
end;
$function$;

create function public.disconnect_constant_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  secret_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  delete from private.constant_contact_oauth_tokens token
  where token.organization_id = org
  returning token.secret_ref into secret_id;
  delete from private.constant_contact_oauth_states state
  where state.organization_id = org;
  if secret_id is not null then delete from vault.secrets where id = secret_id; end if;
  update public.organization_integrations
  set status = 'revoked', credential_ref = null, last_error_code = null,
      updated_at = pg_catalog.now()
  where organization_id = org and provider = 'constant_contact';
  update public.integration_jobs
  set status = 'skipped', error_code = 'connection_revoked', updated_at = pg_catalog.now()
  where organization_id = org and provider = 'constant_contact'
    and job_kind = 'constant_contact_sync' and status = 'queued';
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'constant_contact', 'status', 'revoked',
    'action', 'disconnect'
  ));
  return public.list_constant_contact_control();
end;
$function$;

create function public.enqueue_constant_contact_sync(p_limit_count integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  job_id uuid := extensions.gen_random_uuid();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_limit_count not between 1 and 25 then
    raise exception 'invalid sync limit' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.constant_contact_oauth_tokens token
    join public.organization_integrations integration
      on integration.organization_id = token.organization_id and integration.provider = 'constant_contact'
    where token.organization_id = org and token.status = 'connected' and integration.status = 'connected'
  ) then
    raise exception 'provider not connected' using errcode = 'P0002';
  end if;
  insert into public.integration_jobs (
    id, organization_id, provider, job_kind, status, idempotency_key
  ) values (
    job_id, org, 'constant_contact', 'constant_contact_sync', 'queued',
    'constant-contact:' || job_id::text
  );
  insert into public.constant_contact_sync_requests (
    job_id, organization_id, requested_by, limit_count
  ) values (job_id, org, (select auth.uid()), p_limit_count);
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'constant_contact', 'status', 'sync_queued',
    'action', 'sync'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'jobId', job_id, 'status', 'queued');
end;
$function$;

create function public.enqueue_due_constant_contact_sync()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  job_id uuid := extensions.gen_random_uuid();
begin
  perform private.constant_contact_require_service();
  select token.organization_id into org
  from private.constant_contact_oauth_tokens token
  join public.organization_integrations integration
    on integration.organization_id = token.organization_id
   and integration.provider = 'constant_contact'
  where token.status = 'connected' and integration.status = 'connected'
    and not exists (
      select 1 from public.integration_jobs pending
      where pending.organization_id = token.organization_id
        and pending.provider = 'constant_contact'
        and pending.job_kind = 'constant_contact_sync'
        and pending.status in ('queued', 'running')
    )
  order by token.last_sync_at asc nulls first, token.organization_id
  for update of token skip locked
  limit 1;
  if org is null then
    return pg_catalog.jsonb_build_object('ok', true, 'skipped', 'no_due_connection');
  end if;
  insert into public.integration_jobs (
    id, organization_id, provider, job_kind, status, idempotency_key
  ) values (
    job_id, org, 'constant_contact', 'constant_contact_sync', 'queued',
    'constant-contact-cron:' || job_id::text
  );
  insert into public.constant_contact_sync_requests (
    job_id, organization_id, requested_by, limit_count
  ) values (job_id, org, null, 25);
  return pg_catalog.jsonb_build_object('ok', true, 'jobId', job_id, 'status', 'queued');
end;
$function$;

create function public.claim_constant_contact_sync_job(p_job_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.integration_jobs%rowtype;
  request public.constant_contact_sync_requests%rowtype;
  token private.constant_contact_oauth_tokens%rowtype;
  plaintext text;
begin
  perform private.constant_contact_require_service();
  select source.* into job
  from public.integration_jobs source
  where source.provider = 'constant_contact'
    and source.job_kind = 'constant_contact_sync'
    and source.status = 'queued'
    and (p_job_id is null or source.id = p_job_id)
  order by source.created_at, source.id
  for update skip locked limit 1;
  if not found then return null; end if;
  select source.* into request from public.constant_contact_sync_requests source where source.job_id = job.id;
  select source.* into token from private.constant_contact_oauth_tokens source
  where source.organization_id = job.organization_id and source.status = 'connected';
  if request.job_id is null or token.organization_id is null then
    update public.integration_jobs set status = 'failed', attempt_count = attempt_count + 1,
      error_code = 'credential_unavailable', updated_at = pg_catalog.now() where id = job.id;
    return pg_catalog.jsonb_build_object('terminal', true, 'jobId', job.id);
  end if;
  select secret.decrypted_secret into plaintext from vault.decrypted_secrets secret where secret.id = token.secret_ref;
  if plaintext is null then
    update public.integration_jobs set status = 'failed', attempt_count = attempt_count + 1,
      error_code = 'credential_unavailable', updated_at = pg_catalog.now() where id = job.id;
    return pg_catalog.jsonb_build_object('terminal', true, 'jobId', job.id);
  end if;
  update public.integration_jobs set status = 'running', attempt_count = attempt_count + 1,
    updated_at = pg_catalog.now() where id = job.id;
  return pg_catalog.jsonb_build_object(
    'jobId', job.id, 'organizationId', job.organization_id,
    'limitCount', request.limit_count, 'refreshToken', plaintext, 'scope', token.scope
  );
end;
$function$;

create function public.list_constant_contact_sync_members(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  page_limit integer;
begin
  perform private.constant_contact_require_service();
  select job.organization_id, request.limit_count into org, page_limit
  from public.integration_jobs job
  join public.constant_contact_sync_requests request on request.job_id = job.id
  where job.id = p_job_id and job.provider = 'constant_contact'
    and job.job_kind = 'constant_contact_sync' and job.status = 'running';
  if org is null then raise exception 'job not found' using errcode = 'P0002'; end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'memberId', member.user_id, 'email', pg_catalog.lower(pg_catalog.btrim(users.email))
    ) order by member.user_id)
    from (
      select membership.user_id
      from public.organization_memberships membership
      join auth.users user_source on user_source.id = membership.user_id
      left join public.constant_contact_member_analytics analytics
        on analytics.organization_id = membership.organization_id
       and analytics.member_id = membership.user_id
      where membership.organization_id = org and membership.status = 'active'
        and user_source.email is not null
        and pg_catalog.char_length(pg_catalog.btrim(user_source.email)) between 3 and 254
      order by analytics.synced_at asc nulls first, membership.user_id limit page_limit
    ) member
    join auth.users users on users.id = member.user_id
  ), '[]'::jsonb);
end;
$function$;

create function public.rotate_constant_contact_refresh_token(
  p_job_id uuid,
  p_refresh_token text,
  p_scope text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  old_ref uuid;
  next_ref uuid;
begin
  perform private.constant_contact_require_service();
  if pg_catalog.char_length(coalesce(p_refresh_token, '')) not between 20 and 4096
     or pg_catalog.char_length(coalesce(p_scope, '')) > 2000 then
    raise exception 'invalid token rotation' using errcode = '22023';
  end if;
  select job.organization_id into org from public.integration_jobs job
  where job.id = p_job_id and job.provider = 'constant_contact'
    and job.job_kind = 'constant_contact_sync' and job.status = 'running';
  if org is null then raise exception 'job not found' using errcode = 'P0002'; end if;
  select token.secret_ref into old_ref from private.constant_contact_oauth_tokens token
  where token.organization_id = org for update;
  next_ref := vault.create_secret(
    p_refresh_token,
    'constant-contact-' || org::text || '-' || extensions.gen_random_uuid()::text,
    'Rotated organization-owned Constant Contact OAuth refresh token'
  );
  update private.constant_contact_oauth_tokens
  set secret_ref = next_ref, scope = coalesce(nullif(p_scope, ''), scope),
      updated_at = pg_catalog.now() where organization_id = org;
  update public.organization_integrations
  set credential_ref = next_ref::text,
      default_settings = pg_catalog.jsonb_set(default_settings, '{scope}', pg_catalog.to_jsonb(coalesce(nullif(p_scope, ''), ''))),
      updated_at = pg_catalog.now()
  where organization_id = org and provider = 'constant_contact';
  if old_ref is not null and old_ref is distinct from next_ref then delete from vault.secrets where id = old_ref; end if;
end;
$function$;

create function public.record_constant_contact_sync_result(
  p_job_id uuid,
  p_member_id uuid,
  p_provider_contact_id text,
  p_contact_status text,
  p_list_count integer,
  p_tag_count integer,
  p_sends_count integer,
  p_opens_count integer,
  p_clicks_count integer,
  p_bounces_count integer,
  p_optouts_count integer,
  p_forwards_count integer,
  p_last_activity_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  perform private.constant_contact_require_service();
  select job.organization_id into org from public.integration_jobs job
  where job.id = p_job_id and job.provider = 'constant_contact'
    and job.job_kind = 'constant_contact_sync' and job.status = 'running';
  if org is null or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = org and membership.user_id = p_member_id
      and membership.status = 'active'
  ) then raise exception 'member outside job organization' using errcode = '42501'; end if;
  insert into public.constant_contact_member_analytics (
    organization_id, member_id, provider_contact_id, contact_status,
    list_count, tag_count, sends_count, opens_count, clicks_count,
    bounces_count, optouts_count, forwards_count, last_activity_at, synced_at
  ) values (
    org, p_member_id, nullif(pg_catalog.btrim(coalesce(p_provider_contact_id, '')), ''),
    p_contact_status, p_list_count, p_tag_count, p_sends_count, p_opens_count,
    p_clicks_count, p_bounces_count, p_optouts_count, p_forwards_count,
    p_last_activity_at, pg_catalog.now()
  ) on conflict (organization_id, member_id) do update
    set provider_contact_id = excluded.provider_contact_id,
        contact_status = excluded.contact_status,
        list_count = excluded.list_count, tag_count = excluded.tag_count,
        sends_count = excluded.sends_count, opens_count = excluded.opens_count,
        clicks_count = excluded.clicks_count, bounces_count = excluded.bounces_count,
        optouts_count = excluded.optouts_count, forwards_count = excluded.forwards_count,
        last_activity_at = excluded.last_activity_at, synced_at = excluded.synced_at;
end;
$function$;

create function public.complete_constant_contact_sync_job(
  p_job_id uuid,
  p_processed_count integer,
  p_matched_count integer,
  p_not_found_count integer,
  p_failed_count integer,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job public.integration_jobs%rowtype;
  request public.constant_contact_sync_requests%rowtype;
  next_job_status text;
  run_status text;
  clean_error text := nullif(pg_catalog.btrim(coalesce(p_error_code, '')), '');
begin
  perform private.constant_contact_require_service();
  if p_processed_count is null or p_matched_count is null
     or p_not_found_count is null or p_failed_count is null
     or least(p_processed_count, p_matched_count, p_not_found_count, p_failed_count) < 0
     or p_processed_count > 25
     or p_matched_count + p_not_found_count + p_failed_count > p_processed_count
     or (clean_error is not null and clean_error !~ '^[a-z0-9_-]{1,64}$') then
    raise exception 'invalid sync result' using errcode = '22023';
  end if;
  select source.* into job from public.integration_jobs source
  where source.id = p_job_id and source.provider = 'constant_contact'
    and source.job_kind = 'constant_contact_sync' and source.status = 'running'
  for update;
  if not found then raise exception 'job not found' using errcode = 'P0002'; end if;
  select source.* into request from public.constant_contact_sync_requests source where source.job_id = p_job_id;
  next_job_status := case when clean_error is not null and p_matched_count = 0 then 'failed' else 'success' end;
  run_status := case
    when next_job_status = 'failed' then 'failed'
    when p_failed_count > 0 or p_not_found_count > 0 or clean_error is not null then 'warning'
    else 'success'
  end;
  update public.integration_jobs
  set status = next_job_status, processed_count = p_processed_count,
      error_code = clean_error, updated_at = pg_catalog.now()
  where id = p_job_id;
  insert into public.constant_contact_sync_runs (
    organization_id, job_id, requested_by, source, status,
    processed_count, matched_count, not_found_count, failed_count,
    error_code, started_at, finished_at
  ) values (
    job.organization_id, job.id, request.requested_by,
    case when request.requested_by is null then 'cron' else 'manual' end,
    run_status, p_processed_count, p_matched_count, p_not_found_count,
    p_failed_count, clean_error, job.updated_at, pg_catalog.now()
  );
  update private.constant_contact_oauth_tokens
  set last_sync_at = pg_catalog.now(), last_error_code = clean_error,
      status = case when clean_error = 'credential_rejected' then 'error' else status end,
      updated_at = pg_catalog.now()
  where organization_id = job.organization_id;
  update public.organization_integrations
  set last_job_status = next_job_status, last_error_code = clean_error,
      status = case when clean_error = 'credential_rejected' then 'degraded' else status end,
      updated_at = pg_catalog.now()
  where organization_id = job.organization_id and provider = 'constant_contact';
  return pg_catalog.jsonb_build_object(
    'ok', next_job_status = 'success', 'jobId', job.id, 'status', run_status,
    'processed', p_processed_count, 'matched', p_matched_count,
    'notFound', p_not_found_count, 'failed', p_failed_count,
    'errorCode', clean_error
  );
end;
$function$;

revoke all on function public.begin_constant_contact_oauth(text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_constant_contact_oauth_state(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_constant_contact_oauth(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_constant_contact_control()
  from public, anon, authenticated, service_role;
revoke all on function public.list_constant_contact_sync_runs(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.list_constant_contact_analytics(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.disconnect_constant_contact()
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_constant_contact_sync(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.enqueue_due_constant_contact_sync()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_constant_contact_sync_job(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_constant_contact_sync_members(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.rotate_constant_contact_refresh_token(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_constant_contact_sync_result(
  uuid, uuid, text, text, integer, integer, integer, integer, integer,
  integer, integer, integer, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.complete_constant_contact_sync_job(
  uuid, integer, integer, integer, integer, text
) from public, anon, authenticated, service_role;

grant execute on function public.begin_constant_contact_oauth(text, text, text, text, timestamptz) to authenticated;
grant execute on function public.list_constant_contact_control() to authenticated;
grant execute on function public.list_constant_contact_sync_runs(integer) to authenticated;
grant execute on function public.list_constant_contact_analytics(integer) to authenticated;
grant execute on function public.disconnect_constant_contact() to authenticated;
grant execute on function public.enqueue_constant_contact_sync(integer) to authenticated;

grant execute on function public.claim_constant_contact_oauth_state(text, text) to service_role;
grant execute on function public.complete_constant_contact_oauth(uuid, uuid, text, text, text) to service_role;
grant execute on function public.enqueue_due_constant_contact_sync() to service_role;
grant execute on function public.claim_constant_contact_sync_job(uuid) to service_role;
grant execute on function public.list_constant_contact_sync_members(uuid) to service_role;
grant execute on function public.rotate_constant_contact_refresh_token(uuid, text, text) to service_role;
grant execute on function public.record_constant_contact_sync_result(
  uuid, uuid, text, text, integer, integer, integer, integer, integer,
  integer, integer, integer, timestamptz
) to service_role;
grant execute on function public.complete_constant_contact_sync_job(
  uuid, integer, integer, integer, integer, text
) to service_role;

comment on table private.constant_contact_oauth_tokens is
  'Organization-scoped Constant Contact OAuth metadata. Refresh tokens remain only in Supabase Vault.';
comment on table public.constant_contact_member_analytics is
  'Privacy-minimized organization-scoped Constant Contact engagement counts. No email address or raw provider event is stored.';
comment on table public.constant_contact_sync_runs is
  'Sanitized bounded Constant Contact sync ledger for organization administrators.';
