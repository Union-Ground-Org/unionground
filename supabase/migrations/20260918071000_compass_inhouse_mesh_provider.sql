-- REQ-UG-AI-PROVIDER-INHOUSE-MESH-20260912 and
-- REQ-UG-MESH-ANONYMIZATION-STANDARD-20260912.
-- Contract: docs/superpowers/specs/2026-09-15-inhouse-ai-mesh-contract.md
-- ( owner confirmations 2026-09-16).
--
-- 1. The Union Ground-operated provider is the in-house mesh: gateway
--    'union-ground-mesh', model alias 'union-ground/compass-mesh:v<n>'. The
--    third-party route and model become unrepresentable in the policy row.
-- 2. An agency may enable exactly one contracted connector (Gemini, Claude or
--    GPT) on organization_integrations; its key lives only in Vault.
-- 3. reserve/authorize accept the mesh or a connected connector, under the
--    same kill switch, attestation, ceilings and advisory lock.
-- 4. Agency-level aggregated usage: weekly org-level counters with no member
--    column, a public aggregate store with a hard user_count > 100 floor, and
--    removal in the same transaction that archives the organization.
--
-- No attestation is seeded and Compass stays disabled. The previous
-- attestation rows name the retired gateway and can never match the new
-- policy, so the mesh needs a fresh MFA-verified attestation before dispatch.

begin;

-- ---------------------------------------------------------------------------
-- 1. Policy singleton: the mesh is the only Union Ground-operated provider.
-- ---------------------------------------------------------------------------

alter table public.compass_ai_policy
  drop constraint compass_ai_policy_gateway_check;
alter table public.compass_ai_policy
  drop constraint compass_ai_policy_model_check;
alter table public.compass_ai_policy
  alter column gateway set default 'union-ground-mesh';
alter table public.compass_ai_policy
  alter column model set default 'union-ground/compass-mesh:v1';

update public.compass_ai_policy
set gateway = 'union-ground-mesh',
    model = 'union-ground/compass-mesh:v1',
    updated_at = pg_catalog.now()
where id = true;

alter table public.compass_ai_policy
  add constraint compass_ai_policy_gateway_check
  check (gateway = 'union-ground-mesh');
alter table public.compass_ai_policy
  add constraint compass_ai_policy_model_check
  check (model ~ '^union-ground/compass-mesh:v[0-9]+$');

comment on table public.compass_ai_policy is
  'Singleton describing the Union Ground-operated Compass provider: the in-house mesh only. Agency connectors are per-organization rows on organization_integrations and never appear here.';

-- ---------------------------------------------------------------------------
-- 2. Agency connector catalog on organization_integrations.
-- ---------------------------------------------------------------------------

alter table public.organization_integrations
  drop constraint organization_integrations_provider_check;
alter table public.organization_integrations
  add constraint organization_integrations_provider_check check (provider in (
    'twilio', 'google_calendar', 'microsoft_calendar', 'constant_contact',
    'cba_ingest', 'google_drive', 'customer_webhooks', 'customer_api', 'scim',
    'ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt'
  ));

-- A connector row is well-formed only when: chapter overrides and
-- chapter-owned accounts are off; and, while connected, the Vault reference
-- and every required default_settings key are present with a vendor-shaped
-- model identifier. Endpoints are fixed in code, never stored.
alter table public.organization_integrations
  add constraint organization_integrations_ai_connector_rules check (
    provider not like 'ai\_connector\_%'
    or (
      allow_chapter_overrides = false
      and allow_chapter_owned_accounts = false
      and (
        status <> 'connected'
        or (
          credential_ref is not null
          and default_settings ? 'model'
          and default_settings ? 'enabledAt'
          and default_settings ? 'enabledBy'
          and default_settings ? 'attestation'
          and (default_settings ->> 'termsAcknowledged') = 'true'
          and (
            (provider = 'ai_connector_gemini' and (default_settings ->> 'model') ~ '^gemini-[a-z0-9.-]{1,60}$')
            or (provider = 'ai_connector_claude' and (default_settings ->> 'model') ~ '^claude-[a-z0-9-]{1,60}$')
            or (provider = 'ai_connector_gpt' and (default_settings ->> 'model') ~ '^(gpt|o)[a-z0-9.-]{1,60}$')
          )
        )
      )
    )
  );

create unique index organization_integrations_one_connected_ai_connector_idx
  on public.organization_integrations (organization_id)
  where provider like 'ai\_connector\_%' and status = 'connected';

-- Active organization for an arbitrary user id: the same projection as
-- private.current_member_organization() without the auth.uid() binding, for
-- service-role governance paths that act on behalf of an authenticated member.
create function private.member_organization_for(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.organization_id
  from public.member_profiles p
  join public.chapters c on c.id = p.chapter_id
  join public.organizations o
    on o.id = c.organization_id
   and o.status = 'active'
  join public.member_chapter_memberships cm
    on cm.user_id = p.id
   and cm.chapter_id = c.id
   and cm.status = 'active'
  join public.organization_memberships om
    on om.organization_id = c.organization_id
   and om.user_id = p.id
   and om.status = 'active'
  where p.id = p_user_id
    and c.organization_id is not null
$$;

revoke all on function private.member_organization_for(uuid) from public, anon, authenticated, service_role;

-- Enabling a connector: MFA-verified integration admin, vendor-shaped model,
-- key stored only in Vault, one connected connector per organization, tenant
-- audit event. Disabling deletes the Vault secret.
create function public.enable_organization_ai_connector(
  p_provider text,
  p_model text,
  p_api_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
  caller uuid;
  model text;
  previous_secret uuid;
  secret_id uuid;
  model_ok boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.mi1_require_integration_admin();
  caller := (select auth.uid());
  model := pg_catalog.btrim(coalesce(p_model, ''));
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_provider not in ('ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt') then
    raise exception 'unknown AI connector' using errcode = '22023';
  end if;
  model_ok := case p_provider
    when 'ai_connector_gemini' then model ~ '^gemini-[a-z0-9.-]{1,60}$'
    when 'ai_connector_claude' then model ~ '^claude-[a-z0-9-]{1,60}$'
    else model ~ '^(gpt|o)[a-z0-9.-]{1,60}$' end;
  if not model_ok then raise exception 'model identifier does not match the vendor rule' using errcode = '22023'; end if;
  if p_api_key is null or pg_catalog.char_length(p_api_key) not between 16 and 512
     or p_api_key ~ '[[:space:][:cntrl:]]' then
    raise exception 'invalid connector key' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));

  -- One connected connector per organization: any other connector row is
  -- disabled first and its secret removed.
  for previous_secret in
    select i.credential_ref::uuid
    from public.organization_integrations i
    where i.organization_id = org
      and i.provider like 'ai\_connector\_%'
      and i.credential_ref is not null
  loop
    delete from vault.secrets where id = previous_secret;
  end loop;
  update public.organization_integrations
  set status = 'disabled', credential_ref = null, updated_at = pg_catalog.now()
  where organization_id = org and provider like 'ai\_connector\_%';

  secret_id := vault.create_secret(
    p_api_key, 'ai-connector-' || org::text || '-' || p_provider || '-' || pg_catalog.gen_random_uuid()::text,
    'Agency-contracted AI connector key'
  );
  insert into public.organization_integrations (
    organization_id, provider, status, account_owner, allow_chapter_overrides,
    allow_chapter_owned_accounts, allowed_chapter_override_keys, default_settings, credential_ref
  ) values (
    org, p_provider, 'connected', 'organization', false, false, '{}'::text[],
    pg_catalog.jsonb_build_object(
      'model', model,
      'enabledAt', pg_catalog.now(),
      'enabledBy', caller,
      'termsAcknowledged', true,
      'attestation', 'The agency contracts and manages this connector; its retention and training terms are the agency''s responsibility, not Union Ground''s.'
    ),
    secret_id::text
  )
  on conflict (organization_id, provider) do update
    set status = 'connected',
        account_owner = 'organization',
        allow_chapter_overrides = false,
        allow_chapter_owned_accounts = false,
        allowed_chapter_override_keys = '{}'::text[],
        default_settings = excluded.default_settings,
        credential_ref = excluded.credential_ref,
        updated_at = pg_catalog.now();
  -- organization_audit_events_metadata_keys admits no 'model' key; the model
  -- is recorded on the row's default_settings and in this RPC's return value.
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'status', 'connected'
  ));
  return pg_catalog.jsonb_build_object('provider', p_provider, 'status', 'connected', 'model', model);
end;
$$;

revoke all on function public.enable_organization_ai_connector(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.enable_organization_ai_connector(text, text, text) to authenticated;

create function public.disable_organization_ai_connector(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
  secret_id uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.mi1_require_integration_admin();
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_provider not in ('ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt') then
    raise exception 'unknown AI connector' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  select i.credential_ref::uuid into secret_id
  from public.organization_integrations i
  where i.organization_id = org and i.provider = p_provider;
  update public.organization_integrations
  set status = 'disabled', credential_ref = null, updated_at = pg_catalog.now()
  where organization_id = org and provider = p_provider;
  if secret_id is not null then delete from vault.secrets where id = secret_id; end if;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'status', 'disabled'
  ));
  return pg_catalog.jsonb_build_object('provider', p_provider, 'status', 'disabled');
end;
$$;

revoke all on function public.disable_organization_ai_connector(text) from public, anon, authenticated, service_role;
grant execute on function public.disable_organization_ai_connector(text) to authenticated;

-- Provider resolution for one request. Default is the mesh; an organization
-- with exactly one connected connector is routed to it with the Vault-resolved
-- key. Service role only: the key crosses only the server boundary.
create function public.resolve_compass_ai_provider(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid;
  policy public.compass_ai_policy%rowtype;
  connector public.organization_integrations%rowtype;
  connector_key text;
begin
  select p.* into policy from public.compass_ai_policy p where p.id = true;
  if p_user_id is null or policy.id is null then
    return pg_catalog.jsonb_build_object('gateway', null, 'model', null);
  end if;
  org := private.member_organization_for(p_user_id);
  if org is not null then
    select i.* into connector
    from public.organization_integrations i
    where i.organization_id = org
      and i.provider like 'ai\_connector\_%'
      and i.status = 'connected'
      and i.credential_ref is not null
    limit 1;
    if connector.id is not null then
      select s.decrypted_secret into connector_key
      from vault.decrypted_secrets s
      where s.id = connector.credential_ref::uuid;
      -- A connected connector whose secret is missing or no longer decrypts
      -- fails closed: the organization chose its own provider, so the mesh
      -- must never be substituted silently.
      return pg_catalog.jsonb_build_object(
        'gateway', connector.provider,
        'model', connector.default_settings ->> 'model',
        'api_key', connector_key
      );
    end if;
  end if;
  return pg_catalog.jsonb_build_object('gateway', policy.gateway, 'model', policy.model);
end;
$$;

revoke all on function public.resolve_compass_ai_provider(uuid) from public, anon, authenticated;
grant execute on function public.resolve_compass_ai_provider(uuid) to service_role;

-- Does p_gateway/p_model name a provider this organization may use right now?
-- The mesh must match the policy singleton; a connector must be this
-- organization's connected row with the same model.
create function private.compass_ai_provider_permitted(
  p_user_id uuid,
  p_gateway text,
  p_model text,
  p_policy_gateway text,
  p_policy_model text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid;
begin
  if p_gateway is null or p_model is null then return false; end if;
  if p_gateway = 'union-ground-mesh' then
    if p_gateway <> p_policy_gateway or p_model <> p_policy_model then return false; end if;
    org := private.member_organization_for(p_user_id);
    -- An organization with a connected connector is never served by the mesh,
    -- even when the connector's key is unavailable.
    return org is null or not exists (
      select 1 from public.organization_integrations i
      where i.organization_id = org
        and i.provider like 'ai\_connector\_%'
        and i.status = 'connected'
    );
  end if;
  if p_gateway not in ('ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt') then
    return false;
  end if;
  org := private.member_organization_for(p_user_id);
  if org is null then return false; end if;
  return exists (
    select 1
    from public.organization_integrations i
    where i.organization_id = org
      and i.provider = p_gateway
      and i.status = 'connected'
      and i.credential_ref is not null
      and (i.default_settings ->> 'model') = p_model
  );
end;
$$;

revoke all on function private.compass_ai_provider_permitted(uuid, text, text, text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Agency-level aggregation standard: weekly org-level counters (no member
--    column), a floor-enforced public aggregate store, lifecycle removal.
-- ---------------------------------------------------------------------------

-- These three stores hold organization-level aggregates only. They carry no
-- foreign key into the account/case graph by design: the graph lock protocol
-- (20260907150000) governs member-identifying rows, and nothing here is one.
-- Referential hygiene is enforced by the require-active trigger on write and
-- by the organization lifecycle triggers below on archive and delete.
create table private.mesh_agency_usage_counters (
  organization_id uuid not null,
  period_start date not null,
  metric text not null,
  value bigint not null default 0 check (value >= 0),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, period_start, metric),
  constraint mesh_agency_usage_counters_metric_check check (metric in (
    'compass_requests', 'compass_answered', 'compass_no_source', 'compass_rate_limited',
    'topic_rights', 'topic_contract', 'topic_benefits', 'topic_organizing', 'topic_other'
  )),
  constraint mesh_agency_usage_counters_weekly_check check (
    period_start = (pg_catalog.date_trunc('week', period_start::timestamp))::date
  )
);

revoke all on table private.mesh_agency_usage_counters from public, anon, authenticated, service_role;

comment on table private.mesh_agency_usage_counters is
  'Weekly organization-level Compass counters. No member, device, session or free-text column exists here by design; the row is the aggregation unit.';

create table public.mesh_agency_usage_aggregates (
  organization_id uuid not null,
  period_start date not null,
  metric text not null,
  value bigint not null check (value >= 0),
  user_count integer not null,
  computed_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, period_start, metric),
  constraint mesh_agency_usage_aggregates_metric_check check (metric in (
    'compass_requests', 'compass_answered', 'compass_no_source', 'compass_rate_limited', 'active_users',
    'topic_rights', 'topic_contract', 'topic_benefits', 'topic_organizing', 'topic_other'
  )),
  constraint mesh_agency_usage_aggregates_floor_check check (user_count > 100),
  constraint mesh_agency_usage_aggregates_weekly_check check (
    period_start = (pg_catalog.date_trunc('week', period_start::timestamp))::date
  )
);

alter table public.mesh_agency_usage_aggregates enable row level security;
alter table public.mesh_agency_usage_aggregates force row level security;
revoke all on table public.mesh_agency_usage_aggregates from public, anon, authenticated;
create policy mfa_assurance on public.mesh_agency_usage_aggregates
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.mesh_agency_usage_aggregates is
  'Restrictive MFA assurance on the agency-level aggregate store; every direct grant is revoked and reads go through get_mesh_agency_usage_aggregates().';

comment on table public.mesh_agency_usage_aggregates is
  'Agency-level aggregated, anonymized Compass usage. Weekly periods only, user_count > 100 enforced by CHECK, no member-identifiable column, removed when the organization is archived. Readable only through get_mesh_agency_usage_aggregates().';

-- Writes are blocked for any organization that is not active, and archiving
-- removes every row in the same transaction.
create function private.mesh_agency_usage_require_active_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.organizations o where o.id = new.organization_id and o.status = 'active'
  ) then
    raise exception 'mesh usage rows require an active organization' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.mesh_agency_usage_require_active_organization() from public, anon, authenticated, service_role;

create trigger mesh_agency_usage_counters_require_active
before insert or update on private.mesh_agency_usage_counters
for each row execute function private.mesh_agency_usage_require_active_organization();

create trigger mesh_agency_usage_aggregates_require_active
before insert or update on public.mesh_agency_usage_aggregates
for each row execute function private.mesh_agency_usage_require_active_organization();

-- After reactivation the aggregate starts again from the first FULL week:
-- counting_from is the next Monday, and every bump before it is discarded.
create table private.mesh_agency_usage_start (
  organization_id uuid primary key,
  counting_from date not null,
  constraint mesh_agency_usage_start_weekly_check check (
    counting_from = (pg_catalog.date_trunc('week', counting_from::timestamp))::date
  )
);

revoke all on table private.mesh_agency_usage_start from public, anon, authenticated, service_role;

create function private.mesh_agency_usage_end_retention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'archived' and old.status is distinct from 'archived' then
    delete from public.mesh_agency_usage_aggregates where organization_id = new.id;
    delete from private.mesh_agency_usage_counters where organization_id = new.id;
  elsif new.status = 'active' and old.status is distinct from 'active' then
    insert into private.mesh_agency_usage_start (organization_id, counting_from)
    values (new.id, (pg_catalog.date_trunc('week', pg_catalog.now()::timestamp) + interval '7 days')::date)
    on conflict (organization_id) do update set counting_from = excluded.counting_from;
  end if;
  return new;
end;
$$;

revoke all on function private.mesh_agency_usage_end_retention() from public, anon, authenticated, service_role;

create trigger organizations_mesh_agency_usage_end_retention
after update of status on public.organizations
for each row execute function private.mesh_agency_usage_end_retention();

create function private.mesh_agency_usage_forget_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.mesh_agency_usage_aggregates where organization_id = old.id;
  delete from private.mesh_agency_usage_counters where organization_id = old.id;
  delete from private.mesh_agency_usage_start where organization_id = old.id;
  return old;
end;
$$;

revoke all on function private.mesh_agency_usage_forget_organization() from public, anon, authenticated, service_role;

create trigger organizations_mesh_agency_usage_forget
after delete on public.organizations
for each row execute function private.mesh_agency_usage_forget_organization();

-- Bump one weekly counter for the member's organization. Silent no-op when the
-- member has no active organization; never raises into the caller.
create function private.mesh_usage_bump(p_user_id uuid, p_metric text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid := private.member_organization_for(p_user_id);
  week date := (pg_catalog.date_trunc('week', pg_catalog.now()::timestamp))::date;
begin
  if org is null then return; end if;
  if exists (
    select 1 from private.mesh_agency_usage_start s
    where s.organization_id = org and s.counting_from > week
  ) then return; end if;
  insert into private.mesh_agency_usage_counters (organization_id, period_start, metric, value)
  values (org, week, p_metric, 1)
  on conflict (organization_id, period_start, metric) do update
    set value = private.mesh_agency_usage_counters.value + 1,
        updated_at = pg_catalog.now();
exception
  when others then
    return;
end;
$$;

revoke all on function private.mesh_usage_bump(uuid, text) from public, anon, authenticated, service_role;

create function public.record_compass_ai_outcome(p_user_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_outcome not in ('answered', 'no_source') then return; end if;
  perform private.mesh_usage_bump(p_user_id, 'compass_' || p_outcome);
end;
$$;

revoke all on function public.record_compass_ai_outcome(uuid, text) from public, anon, authenticated;
grant execute on function public.record_compass_ai_outcome(uuid, text) to service_role;

-- Weekly job: copy the previous week's counters into the public store for
-- organizations whose active membership exceeds 100; everything else is
-- suppressed (no row), never approximated. Counters older than eight weeks
-- are discarded.
create function private.compute_mesh_agency_usage_aggregates(p_period_start date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  week date := coalesce(
    p_period_start,
    (pg_catalog.date_trunc('week', pg_catalog.now()::timestamp) - interval '7 days')::date
  );
  written integer := 0;
begin
  if week <> (pg_catalog.date_trunc('week', week::timestamp))::date then
    raise exception 'period_start must be the Monday of a week' using errcode = '22023';
  end if;
  -- The group size is the membership that was active at the END of the
  -- reported week, never the membership at the moment the job runs, so a
  -- later joiner cannot lift a 100-user week above the floor.
  with sizes as (
    select om.organization_id, pg_catalog.count(*)::integer as user_count
    from public.organization_memberships om
    join public.organizations o on o.id = om.organization_id and o.status = 'active'
    where om.created_at < (week + interval '7 days')
      and (om.status = 'active' or om.revoked_at >= (week + interval '7 days'))
      and not exists (
        select 1 from private.mesh_agency_usage_start s
        where s.organization_id = om.organization_id and s.counting_from > week
      )
    group by om.organization_id
    having pg_catalog.count(*) > 100
  ),
  rows_to_write as (
    select c.organization_id, c.period_start, c.metric, c.value, s.user_count
    from private.mesh_agency_usage_counters c
    join sizes s on s.organization_id = c.organization_id
    where c.period_start = week
    union all
    select s.organization_id, week, 'active_users', s.user_count::bigint, s.user_count
    from sizes s
  ),
  upserted as (
    insert into public.mesh_agency_usage_aggregates (organization_id, period_start, metric, value, user_count, computed_at)
    select organization_id, period_start, metric, value, user_count, pg_catalog.now()
    from rows_to_write
    on conflict (organization_id, period_start, metric) do update
      set value = excluded.value,
          user_count = excluded.user_count,
          computed_at = excluded.computed_at
    returning 1
  )
  select pg_catalog.count(*)::integer into written from upserted;
  delete from private.mesh_agency_usage_counters
  where period_start < week - interval '56 days';
  return written;
end;
$$;

revoke all on function private.compute_mesh_agency_usage_aggregates(date) from public, anon, authenticated, service_role;

-- Reporting: an organization's MFA-verified integration admin reads only that
-- organization's rows. The floor is already enforced by the table CHECK.
create function public.get_mesh_agency_usage_aggregates()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'periodStart', a.period_start,
      'metric', a.metric,
      'value', a.value,
      'userCount', a.user_count,
      'computedAt', a.computed_at
    ) order by a.period_start desc, a.metric)
    from public.mesh_agency_usage_aggregates a
    where a.organization_id = org
      and a.user_count > 100
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_mesh_agency_usage_aggregates() from public, anon, authenticated, service_role;
grant execute on function public.get_mesh_agency_usage_aggregates() to authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mesh-agency-usage-aggregate-tick';
    perform cron.schedule(
      'mesh-agency-usage-aggregate-tick',
      '10 3 * * 1',
      $job$ select private.compute_mesh_agency_usage_aggregates(); $job$
    );
  end if;
end;
$$;

-- AI connectors are enabled and disabled only through the Vault-backed RPCs
-- above. The generic provider upsert (caller-supplied credential_ref, no Vault
-- lifecycle) refuses them.
create or replace function public.upsert_organization_integration(
  p_provider text,
  p_status text,
  p_account_owner text,
  p_allow_chapter_overrides boolean,
  p_allow_chapter_owned_accounts boolean,
  p_allowed_chapter_override_keys text[],
  p_default_settings jsonb,
  p_credential_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := private.mi1_require_integration_admin();
  next_status text := coalesce(nullif(p_status, ''), 'unset');
  catalog_keys text[] := private.mi1_integration_allowed_chapter_override_keys(p_provider);
  chapter_overrides boolean := coalesce(p_allow_chapter_overrides, false)
    and pg_catalog.cardinality(catalog_keys) > 0;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_provider like 'ai\_connector\_%' then
    raise exception 'AI connectors are enabled through enable_organization_ai_connector' using errcode = '42501';
  end if;
  perform pg_catalog.cardinality(coalesce(p_allowed_chapter_override_keys, '{}'::text[]));
  if p_provider = 'scim' then next_status := 'disabled'; end if;
  if p_provider = 'scim' and p_status in ('connected', 'configured', 'requested') then
    raise exception 'SCIM stays disabled until the enterprise-later gate' using errcode = '42501';
  end if;
  insert into public.organization_integrations (
    organization_id, provider, status, account_owner, allow_chapter_overrides,
    allow_chapter_owned_accounts, allowed_chapter_override_keys, default_settings,
    credential_ref
  ) values (
    org, p_provider, next_status, coalesce(nullif(p_account_owner, ''), 'organization'),
    chapter_overrides, coalesce(p_allow_chapter_owned_accounts, false),
    case when chapter_overrides then catalog_keys else '{}'::text[] end,
    coalesce(p_default_settings, '{}'::jsonb), nullif(p_credential_ref, '')
  )
  on conflict (organization_id, provider) do update
    set status = excluded.status,
        account_owner = excluded.account_owner,
        allow_chapter_overrides = excluded.allow_chapter_overrides,
        allow_chapter_owned_accounts = excluded.allow_chapter_owned_accounts,
        allowed_chapter_override_keys = excluded.allowed_chapter_override_keys,
        default_settings = excluded.default_settings,
        credential_ref = excluded.credential_ref,
        updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'status', next_status
  ));
  return public.list_organization_integrations();
end;
end;
$function$;

revoke all on function public.upsert_organization_integration(text, text, text, boolean, boolean, text[], jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_organization_integration(text, text, text, boolean, boolean, text[], jsonb, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Governance RPCs: accept the mesh or a connected connector; count usage.
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 5. Account-lifecycle trigger review: the four new lifecycle triggers and the
--    three trigger functions they reach enter the reviewed inventory, so the
--    referential-action surface stays exactly the reviewed one.
-- ---------------------------------------------------------------------------

lock table private.account_lifecycle_trigger_review in share row exclusive mode;

insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
values
  ('trigger', 'private', 'mesh_agency_usage_counters', 'mesh_agency_usage_counters_require_active', 'e1a9a338a084ccc2380682ebe492f631'),
  ('trigger', 'public', 'mesh_agency_usage_aggregates', 'mesh_agency_usage_aggregates_require_active', '1aa0bb108d2445e3254ea25152783895'),
  ('trigger', 'public', 'organizations', 'organizations_mesh_agency_usage_end_retention', 'a2b1b900628c3b659c40a5043c10c271'),
  ('trigger', 'public', 'organizations', 'organizations_mesh_agency_usage_forget', 'bde544cf16eecbf0cd66a9c5cbf47599'),
  ('function', 'private', '', 'mesh_agency_usage_require_active_organization()', '99268d312aadf85c21f2376120d6b9d9'),
  ('function', 'private', '', 'mesh_agency_usage_end_retention()', 'a23ba0191d272f9fb8d9e4b537fcbeff'),
  ('function', 'private', '', 'mesh_agency_usage_forget_organization()', 'dd1c662697585e47c675cceaa1fb7fc3');

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the in-house mesh provider migration';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

notify pgrst, 'reload schema';

commit;
