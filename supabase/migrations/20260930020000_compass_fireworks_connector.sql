-- REQ-UG-COMPASS-ZERO-RETENTION-API-CONNECTOR-20260929
-- Fourth agency-contracted connector: Fireworks AI (OpenAI-compatible chat
-- completions; zero data retention by default for open models, see
-- https://docs.fireworks.ai/guides/security_compliance/data_handling).
-- Same design as the three connectors from 20260918071000: the agency enables
-- it with its own key (Vault only), one connected connector per organization,
-- endpoint fixed in code, vendor-shaped model identifier
-- (accounts/fireworks/models/<id>). The policy singleton, attestations and the
-- mesh path are untouched; nothing is routed anywhere until an organization
-- enables the connector through enable_organization_ai_connector.
begin;

alter table public.organization_integrations
  drop constraint organization_integrations_provider_check;
alter table public.organization_integrations
  add constraint organization_integrations_provider_check check (provider in (
    'twilio', 'google_calendar', 'microsoft_calendar', 'constant_contact',
    'cba_ingest', 'google_drive', 'customer_webhooks', 'customer_api', 'scim',
    'ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt', 'ai_connector_fireworks'
  ));

alter table public.organization_integrations
  drop constraint organization_integrations_ai_connector_rules;
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
            or (provider = 'ai_connector_fireworks' and (default_settings ->> 'model') ~ '^accounts/fireworks/models/[a-z0-9.-]{1,80}$')
          )
        )
      )
    )
  );

create or replace function public.enable_organization_ai_connector(
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
  if p_provider not in ('ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt', 'ai_connector_fireworks') then
    raise exception 'unknown AI connector' using errcode = '22023';
  end if;
  model_ok := case p_provider
    when 'ai_connector_gemini' then model ~ '^gemini-[a-z0-9.-]{1,60}$'
    when 'ai_connector_claude' then model ~ '^claude-[a-z0-9-]{1,60}$'
    when 'ai_connector_fireworks' then model ~ '^accounts/fireworks/models/[a-z0-9.-]{1,80}$'
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

create or replace function public.disable_organization_ai_connector(p_provider text)
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
  if p_provider not in ('ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt', 'ai_connector_fireworks') then
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

create or replace function private.compass_ai_provider_permitted(
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
  if p_gateway not in ('ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt', 'ai_connector_fireworks') then
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

commit;
