-- REQ-UG-PLATFORM-AI-CARD-STATUS-20261017
-- Renew the platform Fireworks attestation without rotating the key, and tell
-- the card whether failover is configured apart from whether it is authorized.
--
-- Until now the only way to extend the 30-day Fireworks attestation was to
-- re-enter the API key through configure_compass_platform_fireworks, which
-- rotates the Vault secret. The MFA-verified platform operator can now append
-- a fresh verified attestation for the configured model, up to 90 days out,
-- under the same global lock, confirmations and audit row as setup. Nothing
-- else changes: the credential reference, revision and model stay as they
-- are, and get_compass_platform_ai keeps reading the newest attestation.
--
-- The term is a day count and the expiry is computed on the database clock
-- (gate round 1): a client-supplied instant drifted past the strict
-- now() + 90 days bound whenever the browser clock ran a little fast.
--
-- get_compass_platform_ai gains `configured` (gate round 1, Grok and):
-- `enabled` folds attestation validity in, so once the attestation expired the
-- card lost the renewal control at exactly the moment it was needed and could
-- only offer key re-entry. `configured` is true while the key is on record and
-- failover is switched on, whatever the attestation says.

begin;

create or replace function public.get_compass_platform_ai()
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
    'configured', config.enabled and config.credential_ref is not null,
    'canManage', private.compass_platform_operator(),
    'attestationExpiresAt', attestation.expires_at);
end;
$$;

create function public.renew_compass_platform_fireworks_attestation(
  p_days integer,
  p_confirm_zero_data_retention boolean,
  p_confirm_disallow_prompt_training boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare config private.compass_platform_fireworks%rowtype;
  previous public.compass_ai_provider_attestations%rowtype;
  renewed_until timestamptz;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if not private.compass_platform_operator() then raise exception 'MFA-verified platform AI operator required' using errcode = '42501'; end if;
  if p_confirm_zero_data_retention is not true or p_confirm_disallow_prompt_training is not true then
    raise exception 'both provider controls must be confirmed' using errcode = '22023';
  end if;
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'attestation term must be between 1 and 90 days' using errcode = '22023';
  end if;
  renewed_until := pg_catalog.now() + pg_catalog.make_interval(days => p_days);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  select * into config from private.compass_platform_fireworks where id for update;
  -- Renewal extends an existing authorization; it never creates one.
  if not config.enabled or config.credential_ref is null
     or not exists (select 1 from vault.secrets where id = config.credential_ref) then
    raise exception 'platform failover is not configured' using errcode = '55000';
  end if;
  select * into previous from public.compass_ai_provider_attestations
    where gateway = 'union-ground-fireworks' and model = config.model and status = 'verified'
    order by sequence_no desc limit 1;
  insert into public.compass_ai_provider_attestations
    (status, gateway, model, zero_data_retention, disallow_prompt_training, evidence_ref, expires_at, attested_by)
  values ('verified', 'union-ground-fireworks', config.model, true, true,
    coalesce(previous.evidence_ref,
      'Platform operator renewal: Fireworks open-model chat-completions terms; optional prompt logging disabled. https://docs.fireworks.ai/guides/security_compliance/data_handling'),
    renewed_until, (select auth.uid()));
  insert into public.member_admin_audit(actor, action, detail)
  values ((select auth.uid()), 'attest_compass_ai_provider',
    pg_catalog.jsonb_build_object('gateway', 'union-ground-fireworks', 'model', config.model, 'status', 'verified',
      'renewal', true, 'days', p_days, 'expiresAt', renewed_until));
  return public.get_compass_platform_ai();
end;
$$;
revoke all on function public.renew_compass_platform_fireworks_attestation(integer, boolean, boolean) from public, anon, service_role;
grant execute on function public.renew_compass_platform_fireworks_attestation(integer, boolean, boolean) to authenticated;

notify pgrst, 'reload schema';
commit;
