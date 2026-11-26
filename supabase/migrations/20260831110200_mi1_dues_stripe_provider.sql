-- CR-084 optional Stripe Connect boundary. Financial records remain usable
-- without a provider; this migration stores only account identifiers and
-- non-sensitive state. Browser code never receives a provider secret, a
-- tenant id, or a writable connection table.

create table public.dues_provider_connections (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  provider text not null default 'stripe_dues' check (provider = 'stripe_dues'),
  state text not null default 'unset' check (state in ('unset', 'pending', 'ready', 'disconnecting', 'attention_required', 'disconnected')),
  stripe_account_id text unique,
  account_label text,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  last_error_class text,
  connected_at timestamptz,
  disconnected_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (state = 'ready' and stripe_account_id is not null)
    or (state in ('unset', 'pending', 'disconnected') and stripe_account_id is null)
    or state in ('disconnecting', 'attention_required')
  )
);

create table private.dues_financial_identity_selections (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  selected_hat text not null check (selected_hat in ('admin', 'vp')),
  selected_at timestamptz not null default now(),
  selected_by uuid references auth.users(id) on delete set null,
  reset_reason text,
  primary key (organization_id, user_id)
);

create table private.dues_stripe_oauth_states (
  state_hash text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  selected_hat text not null check (selected_hat in ('admin', 'vp')),
  browser_binding_hash text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  exchange_started_at timestamptz,
  exchange_account_id text,
  exchange_recorded_at timestamptz,
  recovery_required_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '10 minutes'),
  check ((exchange_account_id is null) = (exchange_recorded_at is null)),
  check (recovery_required_at is null or exchange_account_id is null)
);

create table public.dues_checkout_reservations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  obligation_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null,
  state text not null default 'creating' check (state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required', 'settled', 'released')),
  reserved_cents integer not null check (reserved_cents > 0),
  checkout_currency text not null default 'usd' check (checkout_currency = 'usd'),
  connected_account_id text not null,
  receipt_description text not null,
  success_url text not null,
  cancel_url text not null,
  request_hash text not null,
  provider_idempotency_key text not null unique,
  stripe_idempotency_replay_until timestamptz not null,
  expires_at timestamptz not null,
  stripe_session_id text unique,
  hosted_checkout_url text,
  definitive_failure_class text,
  reconcile_lease_owner uuid,
  reconcile_lease_epoch integer not null default 0,
  reconcile_lease_expires_at timestamptz,
  reconcile_after timestamptz not null default now(),
  reconcile_attempt_count integer not null default 0,
  reconcile_lease_kind text check (reconcile_lease_kind in ('ordinary', 'disconnect')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, requested_by, idempotency_key),
  foreign key (organization_id, obligation_id) references public.dues_obligations(organization_id, id) on delete restrict,
  check ((stripe_session_id is null) = (hosted_checkout_url is null))
);

create unique index dues_one_active_checkout_per_obligation
  on public.dues_checkout_reservations (organization_id, obligation_id)
  where state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required');

create table public.dues_stripe_events (
  stripe_event_id text primary key,
  reservation_id uuid not null references public.dues_checkout_reservations(id) on delete restrict,
  received_at timestamptz not null default now()
);

alter table public.dues_provider_connections enable row level security;
alter table public.dues_checkout_reservations enable row level security;
alter table public.dues_stripe_events enable row level security;

create policy dues_provider_connections_own_select on public.dues_provider_connections
  for select to authenticated using (organization_id = private.current_member_organization());
create policy dues_checkout_reservations_own_select on public.dues_checkout_reservations
  for select to authenticated using (organization_id = private.current_member_organization() and requested_by = (select auth.uid()));

revoke all on public.dues_provider_connections, public.dues_checkout_reservations, public.dues_stripe_events from public, anon, authenticated;
grant select on public.dues_provider_connections, public.dues_checkout_reservations to authenticated;

create or replace function public.get_my_dues_financial_identity_choices()
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid := private.current_member_organization();
begin
  if org is null or (select auth.uid()) is null then raise exception 'dues authorization required' using errcode = '42501'; end if;
  if not private.mfa_satisfied() then raise exception 'dues MFA required' using errcode = '42501'; end if;
  return pg_catalog.jsonb_build_object('choices', (
    select coalesce(pg_catalog.jsonb_agg(hat), '[]'::jsonb)
    from (select hat from unnest(array['admin', 'vp']) hat where private.has_organization_role(org, array[hat])) eligible
  ), 'selectedHat', (select selected_hat from private.dues_financial_identity_selections where organization_id = org and user_id = (select auth.uid())));
end;
$function$;

create or replace function public.set_my_dues_financial_identity(p_selected_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid := private.dues_require_financial_hat(p_selected_hat);
begin
  insert into private.dues_financial_identity_selections (organization_id, user_id, selected_hat, selected_by, reset_reason)
  values (org, (select auth.uid()), p_selected_hat, (select auth.uid()), null)
  on conflict (organization_id, user_id) do update set selected_hat = excluded.selected_hat, selected_at = now(), selected_by = excluded.selected_by, reset_reason = null;
  perform private.mi1_write_tenant_audit(org, 'dues_financial_identity_selected', pg_catalog.jsonb_build_object('selectedHat', p_selected_hat));
  return pg_catalog.jsonb_build_object('selectedHat', p_selected_hat);
end;
$function$;

create or replace function public.request_dues_stripe_connection(p_selected_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid := private.dues_require_financial_hat(p_selected_hat);
begin
  insert into public.dues_provider_connections (organization_id, state, updated_at)
  values (org, 'pending', now())
  on conflict (organization_id) do update set state = case when public.dues_provider_connections.state = 'ready' then 'ready' else 'pending' end, updated_at = now(), last_error_class = null;
  return pg_catalog.jsonb_build_object('organizationId', org, 'selectedHat', p_selected_hat);
end;
$function$;

create or replace function public.get_dues_provider_status(p_selected_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid := private.dues_require_financial_hat(p_selected_hat); connection public.dues_provider_connections%rowtype;
begin
  select * into connection from public.dues_provider_connections where organization_id = org;
  return pg_catalog.jsonb_build_object('state', coalesce(connection.state, 'unset'), 'checkoutAvailable', coalesce(connection.state = 'ready' and connection.charges_enabled, false), 'accountLabel', connection.account_label, 'attention', connection.last_error_class);
end;
$function$;

create or replace function public.disconnect_dues_stripe_account(p_selected_hat text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid := private.dues_require_financial_hat(p_selected_hat);
begin
  update public.dues_provider_connections set state = 'disconnecting', updated_at = now(), last_error_class = null where organization_id = org and state in ('ready', 'attention_required');
  return pg_catalog.jsonb_build_object('state', coalesce((select state from public.dues_provider_connections where organization_id = org), 'unset'));
end;
$function$;

create or replace function public.save_dues_stripe_oauth_state(p_state_hash text, p_organization_id uuid, p_requested_by uuid, p_selected_hat text, p_browser_binding_hash text, p_redirect_uri text, p_expires_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if p_state_hash !~ '^[a-f0-9]{64}$' or p_browser_binding_hash !~ '^[a-f0-9]{64}$' or p_selected_hat not in ('admin', 'vp') or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then raise exception 'invalid dues Stripe state' using errcode = '22023'; end if;
  insert into private.dues_stripe_oauth_states (state_hash, organization_id, requested_by, selected_hat, browser_binding_hash, redirect_uri, expires_at) values (p_state_hash, p_organization_id, p_requested_by, p_selected_hat, p_browser_binding_hash, p_redirect_uri, p_expires_at);
end;
$function$;

-- A Connect OAuth code is non-idempotent. This is therefore a durable claim,
-- not an eager consume: state is consumed only after the exchanged account ID
-- has been persisted and the provider connection is finalized. A second claim
-- with an exchange already in flight becomes an explicit recovery state rather
-- than risking a second token exchange or silently orphaning an authorization.
create or replace function public.consume_dues_stripe_oauth_state(p_state_hash text, p_browser_binding_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states
  where state_hash = p_state_hash
    and browser_binding_hash = p_browser_binding_hash
    and consumed_at is null
    and (expires_at > now() or exchange_account_id is not null)
  for update;
  if saved.state_hash is null then raise exception 'dues Stripe state unavailable' using errcode = '42501'; end if;
  if saved.exchange_account_id is not null then
    return pg_catalog.jsonb_build_object(
      'organizationId', saved.organization_id, 'requestedBy', saved.requested_by,
      'selectedHat', saved.selected_hat, 'redirectUri', saved.redirect_uri,
      'stage', 'finalize', 'accountId', saved.exchange_account_id);
  end if;
  if saved.exchange_started_at is not null then
    update private.dues_stripe_oauth_states
    set recovery_required_at = coalesce(recovery_required_at, now())
    where state_hash = saved.state_hash;
    update public.dues_provider_connections
    set state = 'attention_required', last_error_class = 'oauth_exchange_recovery_required', updated_at = now()
    where organization_id = saved.organization_id and state <> 'ready';
    return pg_catalog.jsonb_build_object(
      'organizationId', saved.organization_id, 'requestedBy', saved.requested_by,
      'selectedHat', saved.selected_hat, 'redirectUri', saved.redirect_uri,
      'stage', 'recovery_required');
  end if;
  update private.dues_stripe_oauth_states set exchange_started_at = now() where state_hash = saved.state_hash;
  return pg_catalog.jsonb_build_object(
    'organizationId', saved.organization_id, 'requestedBy', saved.requested_by,
    'selectedHat', saved.selected_hat, 'redirectUri', saved.redirect_uri,
    'stage', 'exchange');
end;
$function$;

create or replace function public.record_dues_stripe_oauth_exchange(
  p_state_hash text,
  p_browser_binding_hash text,
  p_account_id text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'invalid Stripe account' using errcode = '22023';
  end if;
  select * into saved from private.dues_stripe_oauth_states
  where state_hash = p_state_hash and browser_binding_hash = p_browser_binding_hash
    and consumed_at is null and exchange_started_at is not null
  for update;
  if saved.state_hash is null or saved.recovery_required_at is not null then
    raise exception 'dues Stripe exchange recovery required' using errcode = '42501';
  end if;
  if saved.exchange_account_id is not null and saved.exchange_account_id <> p_account_id then
    raise exception 'dues Stripe exchange account conflict' using errcode = '22023';
  end if;
  update private.dues_stripe_oauth_states
  set exchange_account_id = p_account_id, exchange_recorded_at = coalesce(exchange_recorded_at, now())
  where state_hash = saved.state_hash;
  return pg_catalog.jsonb_build_object(
    'organizationId', saved.organization_id, 'requestedBy', saved.requested_by,
    'selectedHat', saved.selected_hat, 'accountId', p_account_id);
end;
$function$;

create or replace function public.finalize_dues_stripe_oauth_state(
  p_state_hash text,
  p_browser_binding_hash text,
  p_account_label text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select * into saved from private.dues_stripe_oauth_states
  where state_hash = p_state_hash and browser_binding_hash = p_browser_binding_hash
    and consumed_at is null and exchange_account_id is not null and recovery_required_at is null
  for update;
  if saved.state_hash is null then raise exception 'dues Stripe state unavailable' using errcode = '42501'; end if;
  insert into public.dues_provider_connections (
    organization_id, state, stripe_account_id, account_label, charges_enabled,
    payouts_enabled, connected_at, updated_at, last_error_class
  ) values (
    saved.organization_id, 'ready', saved.exchange_account_id,
    nullif(pg_catalog.left(p_account_label, 120), ''), coalesce(p_charges_enabled, false),
    coalesce(p_payouts_enabled, false), now(), now(), null
  ) on conflict (organization_id) do update
    set state = 'ready', stripe_account_id = excluded.stripe_account_id,
        account_label = excluded.account_label, charges_enabled = excluded.charges_enabled,
        payouts_enabled = excluded.payouts_enabled, connected_at = now(), updated_at = now(), last_error_class = null;
  update private.dues_stripe_oauth_states set consumed_at = now() where state_hash = saved.state_hash;
  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_connected',
    pg_catalog.jsonb_build_object('requestedBy', saved.requested_by, 'oauthStateFinalized', true)
  );
  return pg_catalog.jsonb_build_object('state', 'ready');
end;
$function$;

-- This service-only recovery terminates an ambiguous exchange only after an
-- authorized operator has confirmed deauthorization outside the product. It
-- never guesses an account ID or retries the non-idempotent OAuth code.
create or replace function public.resolve_dues_stripe_oauth_recovery(
  p_state_hash text,
  p_outcome text
)
returns void language plpgsql security definer set search_path = '' as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if p_outcome <> 'authorization_revoked'
     or coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'dues Stripe recovery refused' using errcode = '42501';
  end if;
  select * into saved from private.dues_stripe_oauth_states
  where state_hash = p_state_hash and consumed_at is null and recovery_required_at is not null
  for update;
  if saved.state_hash is null then raise exception 'dues Stripe recovery unavailable' using errcode = '42501'; end if;
  update private.dues_stripe_oauth_states set consumed_at = now() where state_hash = saved.state_hash;
  update public.dues_provider_connections
  set state = 'unset', last_error_class = 'oauth_exchange_authorization_revoked', updated_at = now()
  where organization_id = saved.organization_id and state <> 'ready';
  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_oauth_recovery_resolved',
    pg_catalog.jsonb_build_object('requestedBy', saved.requested_by, 'outcome', p_outcome)
  );
end;
$function$;

create or replace function public.set_dues_stripe_account(p_organization_id uuid, p_requested_by uuid, p_account_id text, p_account_label text, p_charges_enabled boolean, p_payouts_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then raise exception 'invalid Stripe account' using errcode = '22023'; end if;
  insert into public.dues_provider_connections (organization_id, state, stripe_account_id, account_label, charges_enabled, payouts_enabled, connected_at, updated_at)
  values (p_organization_id, 'ready', p_account_id, nullif(pg_catalog.left(p_account_label, 120), ''), coalesce(p_charges_enabled, true), coalesce(p_payouts_enabled, false), now(), now())
  on conflict (organization_id) do update set state = 'ready', stripe_account_id = excluded.stripe_account_id, account_label = excluded.account_label, charges_enabled = excluded.charges_enabled, payouts_enabled = excluded.payouts_enabled, connected_at = now(), updated_at = now(), last_error_class = null;
  perform private.mi1_write_tenant_audit(p_organization_id, 'dues_stripe_connected', pg_catalog.jsonb_build_object('requestedBy', p_requested_by));
  return pg_catalog.jsonb_build_object('state', 'ready');
end;
$function$;

create or replace function public.create_dues_checkout_reservation(p_obligation_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare org uuid := private.current_member_organization(); subject uuid; obligation public.dues_obligations%rowtype; connection public.dues_provider_connections%rowtype; balance integer; existing public.dues_checkout_reservations%rowtype; reservation public.dues_checkout_reservations%rowtype;
begin
  if org is null or (select auth.uid()) is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$' then raise exception 'invalid dues checkout' using errcode = '22023'; end if;
  if not private.mfa_satisfied() then raise exception 'dues MFA required' using errcode = '42501'; end if;
  select id into subject from public.dues_member_subjects where organization_id = org and user_id = (select auth.uid());
  select * into obligation from public.dues_obligations where organization_id = org and id = p_obligation_id and member_subject_id = subject for update;
  if obligation.id is null then raise exception 'dues obligation unavailable' using errcode = '42501'; end if;
  select * into existing from public.dues_checkout_reservations where organization_id = org and requested_by = (select auth.uid()) and idempotency_key = p_idempotency_key;
  if existing.id is not null then
    if existing.obligation_id <> p_obligation_id then
      raise exception 'dues idempotency payload mismatch' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('reservationId', existing.id, 'state', existing.state, 'hostedCheckoutUrl', existing.hosted_checkout_url, 'idempotent', true);
  end if;
  select * into connection from public.dues_provider_connections where organization_id = org and state = 'ready' and charges_enabled;
  if connection.organization_id is null then raise exception 'dues provider unset' using errcode = '55000'; end if;
  select obligation.issued_cents - coalesce(sum(case event.event_kind when 'payment' then event.amount_cents when 'waiver' then event.amount_cents when 'credit_adjustment' then event.amount_cents when 'debit_adjustment' then -event.amount_cents else 0 end), 0) into balance from public.dues_ledger_events event where event.organization_id = org and event.obligation_id = obligation.id;
  if balance <= 0 then raise exception 'dues obligation settled' using errcode = '22023'; end if;
  insert into public.dues_checkout_reservations (organization_id, obligation_id, requested_by, idempotency_key, reserved_cents, connected_account_id, receipt_description, success_url, cancel_url, request_hash, provider_idempotency_key, stripe_idempotency_replay_until, expires_at)
  values (org, obligation.id, (select auth.uid()), p_idempotency_key, balance, connection.stripe_account_id, 'Dues payment', 'https://app.example.invalid/m/dues?payment=success', 'https://app.example.invalid/m/dues?payment=cancel', pg_catalog.encode(extensions.digest((org::text || obligation.id::text || balance::text || connection.stripe_account_id)::bytea, 'sha256'), 'hex'), 'dues:' || extensions.gen_random_uuid()::text, now() + interval '24 hours', now() + interval '23 hours') returning * into reservation;
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'accountId', reservation.connected_account_id, 'amountCents', reservation.reserved_cents, 'currency', reservation.checkout_currency, 'description', reservation.receipt_description, 'successUrl', reservation.success_url, 'cancelUrl', reservation.cancel_url, 'idempotencyKey', reservation.provider_idempotency_key, 'expiresAt', reservation.expires_at);
end;
$function$;

create or replace function public.finalize_dues_checkout_reservation(p_reservation_id uuid, p_stripe_session_id text, p_hosted_checkout_url text, p_stripe_expires_at timestamptz, p_lease_epoch integer default 0, p_lease_owner uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare reservation public.dues_checkout_reservations%rowtype;
begin
  select * into reservation from public.dues_checkout_reservations where id = p_reservation_id for update;
  if reservation.id is null or (reservation.state = 'open' and reservation.stripe_session_id <> p_stripe_session_id) or (reservation.state not in ('creating', 'reconciling', 'open')) then raise exception 'dues checkout finalization refused' using errcode = '42501'; end if;
  if reservation.state = 'reconciling' and (reservation.reconcile_lease_epoch <> p_lease_epoch or reservation.reconcile_lease_owner is distinct from p_lease_owner or reservation.reconcile_lease_expires_at <= now()) then raise exception 'dues checkout lease stale' using errcode = '42501'; end if;
  update public.dues_checkout_reservations set state = 'open', stripe_session_id = p_stripe_session_id, hosted_checkout_url = p_hosted_checkout_url, expires_at = least(expires_at, p_stripe_expires_at), reconcile_lease_owner = null, reconcile_lease_expires_at = null, reconcile_lease_kind = null, updated_at = now() where id = reservation.id;
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'open', 'hostedCheckoutUrl', p_hosted_checkout_url);
end;
$function$;

create or replace function public.fail_dues_checkout_reservation(p_reservation_id uuid, p_failure_class text, p_lease_epoch integer default 0, p_lease_owner uuid default null)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  update public.dues_checkout_reservations set state = 'released', definitive_failure_class = nullif(pg_catalog.left(p_failure_class, 80), ''), reconcile_lease_owner = null, reconcile_lease_expires_at = null, reconcile_lease_kind = null, updated_at = now() where id = p_reservation_id and ((state = 'creating' and p_lease_epoch = 0 and p_lease_owner is null) or (state = 'reconciling' and reconcile_lease_epoch = p_lease_epoch and reconcile_lease_owner = p_lease_owner and reconcile_lease_expires_at > now()));
end;
$function$;

revoke all on private.dues_financial_identity_selections, private.dues_stripe_oauth_states from public, anon, authenticated;
revoke all on function public.save_dues_stripe_oauth_state(text, uuid, uuid, text, text, text, timestamptz), public.consume_dues_stripe_oauth_state(text, text), public.record_dues_stripe_oauth_exchange(text, text, text), public.finalize_dues_stripe_oauth_state(text, text, text, boolean, boolean), public.resolve_dues_stripe_oauth_recovery(text, text), public.set_dues_stripe_account(uuid, uuid, text, text, boolean, boolean), public.finalize_dues_checkout_reservation(uuid, text, text, timestamptz, integer, uuid), public.fail_dues_checkout_reservation(uuid, text, integer, uuid) from public, anon, authenticated;
revoke all on function public.get_my_dues_financial_identity_choices(), public.set_my_dues_financial_identity(text), public.request_dues_stripe_connection(text), public.get_dues_provider_status(text), public.disconnect_dues_stripe_account(text), public.create_dues_checkout_reservation(uuid, text) from public, anon, authenticated;
grant execute on function public.get_my_dues_financial_identity_choices(), public.request_dues_stripe_connection(text), public.get_dues_provider_status(text), public.disconnect_dues_stripe_account(text), public.create_dues_checkout_reservation(uuid, text) to authenticated;
grant execute on function public.save_dues_stripe_oauth_state(text, uuid, uuid, text, text, text, timestamptz), public.consume_dues_stripe_oauth_state(text, text), public.record_dues_stripe_oauth_exchange(text, text, text), public.finalize_dues_stripe_oauth_state(text, text, text, boolean, boolean), public.resolve_dues_stripe_oauth_recovery(text, text), public.finalize_dues_checkout_reservation(uuid, text, text, timestamptz, integer, uuid), public.fail_dues_checkout_reservation(uuid, text, integer, uuid) to service_role;
