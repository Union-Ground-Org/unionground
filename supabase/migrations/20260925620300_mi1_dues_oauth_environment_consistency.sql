-- SEC-UG-DUES-STRIPE-OAUTH-ENVIRONMENT-CONSISTENCY-20260921:
-- public.complete_dues_stripe_oauth_callback validated the callback lease, the
-- owner, the organization, the requester and the exchanged account id, then
-- wrote state='ready' without ever reading exchanged_livemode. The 6-arg
-- exchange writer retains that indicator (20260831211500), and
-- public.save_dues_stripe_oauth_state admits exactly two redirect_uri values,
-- so the approved callback surface — and therefore the one Stripe environment
-- that surface is served by — is already a deterministic function of the row.
-- Re-emit the completion function so a token exchanged in the other
-- environment can never become a ready provider connection. No table,
-- constraint, policy or grant changes here; the exchange writer, the defer and
-- fail writers and the resume path are untouched.

begin;

set local lock_timeout = '5s';

-- 20260907151000 wrapped the 20260831211500 inner source 862a0538… in the
-- case-graph entry gate, and that wrapped body is the only predecessor this
-- repair may supersede. A fresh install still wraps the original inner source
-- first; this file then replaces the wrapped routine. The wrap-time hash stays
-- in 20260907151000 so a later unreviewed edit of that original inner source
-- still fails closed.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.complete_dues_stripe_oauth_callback(text, integer, uuid, uuid, uuid, text, text, boolean, boolean)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'd807a6fe1262f1cdf3f668c7020f462ea7239d79a0572d8279c998a525405013' then
    raise exception 'unreviewed complete_dues_stripe_oauth_callback predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.complete_dues_stripe_oauth_callback(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_organization_id uuid,
  p_requested_by uuid,
  p_account_id text,
  p_account_label text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  saved private.dues_stripe_oauth_states%rowtype;
  approved_livemode boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'dues Stripe callback completion refused' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
  for update;
  if not found or saved.callback_state not in ('processing', 'exchanged')
     or saved.callback_lease_epoch <> p_lease_epoch
     or saved.callback_lease_owner is distinct from p_lease_owner
     or saved.callback_lease_expires_at <= now()
     or saved.organization_id <> p_organization_id
     or saved.requested_by <> p_requested_by
     or saved.exchanged_account_id is distinct from p_account_id then
    raise exception 'dues Stripe callback lease stale' using errcode = '42501';
  end if;
  -- Each approved callback surface is served by exactly one Stripe
  -- environment: the demo origin runs on the SAMPLE test keys, the SaaS origin
  -- on the live keys. The retained redirect_uri is therefore the approved
  -- environment, and a token the provider exchanged in the other one is
  -- refused here rather than stored as a ready connection. A redirect_uri
  -- outside the two the state writer admits has no approved environment and is
  -- refused for the same reason. This is the last gate before 'ready', so it
  -- also covers a lease resumed after the exchange was already recorded.
  approved_livemode := case saved.redirect_uri
    when 'https://app.example.invalid/api/dues-stripe-connect' then true
    when 'https://demo.example.com/api/dues-stripe-connect' then false
  end;
  if approved_livemode is null
     or coalesce(saved.exchanged_livemode, false) is distinct from approved_livemode then
    raise exception 'dues Stripe callback environment mismatch' using errcode = '22023';
  end if;
  insert into public.dues_provider_connections (
    organization_id, state, stripe_account_id, account_label,
    charges_enabled, payouts_enabled, connected_at, updated_at
  ) values (
    p_organization_id, 'ready', p_account_id,
    nullif(pg_catalog.left(coalesce(p_account_label, ''), 120), ''),
    coalesce(p_charges_enabled, false), coalesce(p_payouts_enabled, false),
    now(), now()
  )
  on conflict (organization_id) do update
    set state = 'ready',
        stripe_account_id = excluded.stripe_account_id,
        account_label = excluded.account_label,
        charges_enabled = excluded.charges_enabled,
        payouts_enabled = excluded.payouts_enabled,
        connected_at = now(),
        disconnected_at = null,
        updated_at = now(),
        last_error_class = null;
  update private.dues_stripe_oauth_states
  set callback_state = 'completed',
      completed_at = now(),
      consumed_at = now(),
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      last_error_class = null
  where state_hash = saved.state_hash;
  perform private.mi1_write_tenant_audit(
    p_organization_id,
    'dues_stripe_connected',
    pg_catalog.jsonb_build_object('requestedBy', p_requested_by)
  );
  return pg_catalog.jsonb_build_object('state', 'ready');
end;
end;
$function$;

revoke all on function public.complete_dues_stripe_oauth_callback(text, integer, uuid, uuid, uuid, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.complete_dues_stripe_oauth_callback(text, integer, uuid, uuid, uuid, text, text, boolean, boolean)
  to service_role;

comment on function public.complete_dues_stripe_oauth_callback(text, integer, uuid, uuid, uuid, text, text, boolean, boolean) is
  'Service-only completion of one leased dues Stripe OAuth callback. Beyond the lease, owner, organization, requester and exchanged-account guards it requires the exchanged environment indicator to match the environment of the approved callback surface retained on the state row; a mismatch, or a redirect_uri with no approved environment, raises 22023 and leaves no ready connection.';

do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.complete_dues_stripe_oauth_callback(text, integer, uuid, uuid, uuid, text, text, boolean, boolean)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'f9994bb747af6f595d3cf52982bda47f109446d2263617cba43cd355956b761e' then
    raise exception 'complete_dues_stripe_oauth_callback source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
