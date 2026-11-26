-- CR-084 Dues settlement and reconciliation completion.
--
-- This is intentionally an additive, provider-independent database boundary:
-- no tenant, account, user, credential, provider request, or payment is made
-- by the migration. Stripe secrets remain server-only; only opaque account,
-- session, event, and idempotency identifiers are retained.

begin;

set local lock_timeout = '5s';

alter table public.dues_provider_connections
  add column if not exists disconnect_lease_owner uuid,
  add column if not exists disconnect_lease_epoch integer not null default 0,
  add column if not exists disconnect_lease_expires_at timestamptz;

create unique index if not exists dues_stripe_payment_reference_once
  on public.dues_ledger_events (organization_id, external_reference)
  where event_kind = 'payment' and payment_method = 'stripe' and external_reference is not null;

create index if not exists dues_checkout_reconciliation_claim_idx
  on public.dues_checkout_reservations (state, reconcile_after, created_at, id)
  where state in ('creating', 'open', 'cancel_requested', 'reconciling');

create or replace function private.dues_checkout_request_hash(
  p_reservation_id uuid,
  p_account_id text,
  p_idempotency_key text,
  p_amount_cents integer,
  p_currency text,
  p_description text,
  p_success_url text,
  p_cancel_url text
)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(
      p_reservation_id::text || pg_catalog.chr(10)
      || p_account_id || pg_catalog.chr(10)
      || p_idempotency_key || pg_catalog.chr(10)
      || p_amount_cents::text || pg_catalog.chr(10)
      || p_currency || pg_catalog.chr(10)
      || p_description || pg_catalog.chr(10)
      || p_success_url || pg_catalog.chr(10)
      || p_cancel_url,
      'UTF8'
    ), 'sha256'),
    'hex'
  )
$function$;

-- A member cannot record a manual payment, waiver, or adjustment while an
-- active hosted checkout reserves the exact same balance. The Stripe
-- settlement path is the sole exception and is service-only.
create or replace function private.dues_reject_competing_checkout_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.event_kind in ('payment', 'waiver', 'credit_adjustment', 'debit_adjustment')
     and new.payment_method is distinct from 'stripe'
     and exists (
       select 1
       from public.dues_checkout_reservations reservation
       where reservation.organization_id = new.organization_id
         and reservation.obligation_id = new.obligation_id
         and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required')
     ) then
    raise exception 'dues checkout reservation active' using errcode = '55000';
  end if;
  return new;
end;
$function$;

drop trigger if exists dues_reject_competing_checkout_mutation on public.dues_ledger_events;
create trigger dues_reject_competing_checkout_mutation
  before insert on public.dues_ledger_events
  for each row execute function private.dues_reject_competing_checkout_mutation();

-- A selected financial identity is retained only while the authenticated user
-- has that exact current grant. Live accounts do not self-select a hat: a
-- single financial grant is provisioned from trusted organization changes, and
-- a dual grant requires an explicit service-side operator assignment.
create or replace function public.get_my_dues_financial_identity_choices()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  selected text;
  choices jsonb;
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues MFA required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(hat), '[]'::jsonb) into choices
  from (
    select hat
    from unnest(array['admin', 'vp']) hat
    where private.has_organization_role(org, array[hat])
    order by hat
  ) eligible;
  select selection.selected_hat into selected
  from private.dues_financial_identity_selections selection
  where selection.organization_id = org and selection.user_id = (select auth.uid());
  if selected is not null and not (choices ? selected) then
    delete from private.dues_financial_identity_selections
    where organization_id = org and user_id = (select auth.uid());
    selected := null;
  end if;
  return pg_catalog.jsonb_build_object('choices', choices, 'selectedHat', selected);
end;
$function$;

-- This private helper is also called by the organization membership/grant
-- triggers below. It auto-provisions only exactly one current financial grant;
-- a valid service-assigned dual-grant selection is retained, while a revoked
-- or otherwise invalid identity is removed immediately.
create or replace function private.dues_sync_financial_identity_for_context(
  p_organization_id uuid,
  p_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  hats text[];
  selected text;
begin
  if p_organization_id is null or p_user_id is null then
    return false;
  end if;
  select coalesce(
    array_agg(role_grant.role order by role_grant.role)
      filter (where role_grant.role in ('admin', 'vp')),
    array[]::text[]
  ) into hats
  from public.organization_memberships membership
  left join public.organization_role_grants role_grant
    on role_grant.organization_id = membership.organization_id
   and role_grant.user_id = membership.user_id
  where membership.organization_id = p_organization_id
    and membership.user_id = p_user_id
    and membership.status = 'active';

  select selection.selected_hat into selected
  from private.dues_financial_identity_selections selection
  where selection.organization_id = p_organization_id and selection.user_id = p_user_id;

  if cardinality(hats) = 1 then
    insert into private.dues_financial_identity_selections (
      organization_id, user_id, selected_hat, selected_by, reset_reason
    ) values (
      p_organization_id, p_user_id, hats[1], null, 'single-grant-provisioned'
    ) on conflict (organization_id, user_id) do update
      set selected_hat = excluded.selected_hat, selected_at = now(),
          selected_by = null, reset_reason = excluded.reset_reason;
    return true;
  end if;

  if selected is not null and not (selected = any(hats)) then
    delete from private.dues_financial_identity_selections
    where organization_id = p_organization_id and user_id = p_user_id;
  end if;
  return false;
end;
$function$;

-- A service caller supplies the exact organization and a target identity.
-- It cannot broaden an assignment across every organization a person belongs
-- to, and it cannot assign a role that is not currently granted there.
create or replace function public.set_dues_financial_identity_for_context(
  p_organization_id uuid,
  p_user_id uuid,
  p_selected_hat text,
  p_reset_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_organization_id is null or p_user_id is null or p_selected_hat not in ('admin', 'vp')
     or p_reset_reason is null or p_reset_reason !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'invalid financial identity context' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role_grant
      on role_grant.organization_id = membership.organization_id
     and role_grant.user_id = membership.user_id
     and role_grant.role = p_selected_hat
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
  ) then
    raise exception 'financial identity grant unavailable' using errcode = '42501';
  end if;
  insert into private.dues_financial_identity_selections (
    organization_id, user_id, selected_hat, selected_by, reset_reason
  ) values (
    p_organization_id, p_user_id, p_selected_hat, null, p_reset_reason
  ) on conflict (organization_id, user_id) do update
    set selected_hat = excluded.selected_hat, selected_at = now(),
        selected_by = null, reset_reason = excluded.reset_reason;
  perform private.mi1_write_tenant_audit(
    p_organization_id,
    'dues_financial_identity_assigned',
    pg_catalog.jsonb_build_object('selectedHat', p_selected_hat, 'source', 'service')
  );
  return pg_catalog.jsonb_build_object('organizationId', p_organization_id, 'selectedHat', p_selected_hat);
end;
$function$;

create or replace function public.provision_dues_financial_identity_for_active_context(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  organization_key uuid;
  inserted_count integer := 0;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'invalid user' using errcode = '22023';
  end if;
  for organization_key in
    select membership.organization_id
    from public.organization_memberships membership
    where membership.user_id = p_user_id and membership.status = 'active'
  loop
    if private.dues_sync_financial_identity_for_context(organization_key, p_user_id) then
      inserted_count := inserted_count + 1;
    end if;
  end loop;
  return inserted_count;
end;
$function$;

create or replace function private.sync_dues_financial_identity_from_organization_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    perform private.dues_sync_financial_identity_for_context(old.organization_id, old.user_id);
    return old;
  end if;
  perform private.dues_sync_financial_identity_for_context(new.organization_id, new.user_id);
  return new;
end;
$function$;

drop trigger if exists dues_financial_identity_membership_upsert on public.organization_memberships;
create trigger dues_financial_identity_membership_upsert
  after insert or update of status on public.organization_memberships
  for each row execute function private.sync_dues_financial_identity_from_organization_change();
drop trigger if exists dues_financial_identity_membership_delete on public.organization_memberships;
create trigger dues_financial_identity_membership_delete
  after delete on public.organization_memberships
  for each row execute function private.sync_dues_financial_identity_from_organization_change();
drop trigger if exists dues_financial_identity_role_upsert on public.organization_role_grants;
create trigger dues_financial_identity_role_upsert
  after insert or update on public.organization_role_grants
  for each row execute function private.sync_dues_financial_identity_from_organization_change();
drop trigger if exists dues_financial_identity_role_delete on public.organization_role_grants;
create trigger dues_financial_identity_role_delete
  after delete on public.organization_role_grants
  for each row execute function private.sync_dues_financial_identity_from_organization_change();

select private.dues_sync_financial_identity_for_context(membership.organization_id, membership.user_id)
from public.organization_memberships membership
where membership.status = 'active';

-- Every live financial mutation must match the server-assigned identity; a
-- role grant alone is deliberately insufficient and a route cannot select it.
create or replace function private.dues_require_financial_hat(p_selected_hat text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues financial role or MFA required' using errcode = '42501';
  end if;
  if p_selected_hat not in ('admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat])
     or not exists (
       select 1 from private.dues_financial_identity_selections selection
       where selection.organization_id = org
         and selection.user_id = (select auth.uid())
         and selection.selected_hat = p_selected_hat
     ) then
    raise exception 'dues financial identity or MFA required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create or replace function public.cancel_dues_checkout_reservation(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  reservation public.dues_checkout_reservations%rowtype;
begin
  if org is null or (select auth.uid()) is null or p_reservation_id is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues MFA required' using errcode = '42501';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id
    and row.organization_id = org
    and row.requested_by = (select auth.uid())
  for update;
  if not found then
    raise exception 'dues checkout unavailable' using errcode = '42501';
  end if;
  if reservation.state in ('settled', 'released', 'attention_required') then
    return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', reservation.state, 'idempotent', true);
  end if;
  update public.dues_checkout_reservations
  set state = 'cancel_requested', reconcile_after = now(), updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'cancel_requested', 'idempotent', false);
end;
$function$;

-- Canonical preparation happens immediately before egress. It derives the
-- allowed origin server-side and replaces the earlier pre-provider placeholder
-- hash so every direct and replayed checkout has identical immutable fields.
create or replace function public.prepare_dues_checkout_reservation(
  p_reservation_id uuid,
  p_surface text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
  origin text;
  prepared_success_url text;
  prepared_cancel_url text;
  prepared_request_hash text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_surface = 'demo' then origin := 'https://demo.example.com';
  elsif p_surface = 'saas' then origin := 'https://app.example.invalid';
  else raise exception 'invalid dues checkout surface' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id
  for update;
  if not found or reservation.state <> 'creating' or reservation.stripe_session_id is not null then
    raise exception 'dues checkout preparation refused' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.dues_provider_connections connection
    where connection.organization_id = reservation.organization_id
      and connection.state = 'ready' and connection.charges_enabled
      and connection.stripe_account_id = reservation.connected_account_id
  ) then
    raise exception 'dues provider unavailable' using errcode = '55000';
  end if;
  prepared_success_url := origin || '/m/dues?payment=success';
  prepared_cancel_url := origin || '/m/dues?payment=cancel';
  prepared_request_hash := private.dues_checkout_request_hash(
    reservation.id, reservation.connected_account_id, reservation.provider_idempotency_key,
    reservation.reserved_cents, reservation.checkout_currency, reservation.receipt_description,
    prepared_success_url, prepared_cancel_url
  );
  update public.dues_checkout_reservations
  set success_url = prepared_success_url, cancel_url = prepared_cancel_url, request_hash = prepared_request_hash,
      reconcile_after = now(), updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object(
    'reservationId', reservation.id,
    'accountId', reservation.connected_account_id,
    'idempotencyKey', reservation.provider_idempotency_key,
    'amountCents', reservation.reserved_cents,
    'currency', reservation.checkout_currency,
    'description', reservation.receipt_description,
    'successUrl', prepared_success_url,
    'cancelUrl', prepared_cancel_url,
    'requestHash', prepared_request_hash
  );
end;
$function$;

drop function if exists public.finalize_dues_checkout_reservation(uuid, text, text, timestamptz, integer, uuid);
create function public.finalize_dues_checkout_reservation(
  p_reservation_id uuid,
  p_stripe_session_id text,
  p_hosted_checkout_url text,
  p_stripe_expires_at timestamptz,
  p_lease_epoch integer default 0,
  p_lease_owner uuid default null,
  p_lease_kind text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_stripe_session_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_hosted_checkout_url !~ '^https://[^[:space:]#]+$'
     or p_stripe_expires_at is null or p_stripe_expires_at <= now() - interval '5 minutes' then
    raise exception 'dues checkout finalization refused' using errcode = '22023';
  end if;
  select * into reservation from public.dues_checkout_reservations row where row.id = p_reservation_id for update;
  if not found then raise exception 'dues checkout unavailable' using errcode = '42501'; end if;
  if reservation.state = 'open' and reservation.stripe_session_id = p_stripe_session_id then
    return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'open', 'hostedCheckoutUrl', reservation.hosted_checkout_url, 'idempotent', true);
  end if;
  if reservation.state = 'creating' then
    if p_lease_epoch <> 0 or p_lease_owner is not null or p_lease_kind is not null
       or reservation.reconcile_lease_owner is not null or reservation.stripe_session_id is not null then
      raise exception 'dues checkout lease stale' using errcode = '42501';
    end if;
  elsif reservation.state = 'reconciling' then
    if p_lease_epoch <> reservation.reconcile_lease_epoch
       or p_lease_owner is distinct from reservation.reconcile_lease_owner
       or p_lease_kind is distinct from reservation.reconcile_lease_kind
       or reservation.reconcile_lease_kind <> 'ordinary'
       or reservation.reconcile_lease_expires_at <= now() then
      raise exception 'dues checkout lease stale' using errcode = '42501';
    end if;
  else
    raise exception 'dues checkout finalization refused' using errcode = '42501';
  end if;
  update public.dues_checkout_reservations
  set state = 'open', stripe_session_id = p_stripe_session_id,
      hosted_checkout_url = p_hosted_checkout_url,
      expires_at = least(reservation.expires_at, p_stripe_expires_at),
      reconcile_lease_owner = null, reconcile_lease_expires_at = null,
      reconcile_lease_kind = null, reconcile_after = p_stripe_expires_at,
      updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'open', 'hostedCheckoutUrl', p_hosted_checkout_url, 'idempotent', false);
end;
$function$;

drop function if exists public.fail_dues_checkout_reservation(uuid, text, integer, uuid);
create function public.fail_dues_checkout_reservation(
  p_reservation_id uuid,
  p_failure_class text,
  p_lease_epoch integer default 0,
  p_lease_owner uuid default null,
  p_lease_kind text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare reservation public.dues_checkout_reservations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or nullif(pg_catalog.btrim(coalesce(p_failure_class, '')), '') is null
     or pg_catalog.char_length(p_failure_class) > 80 then
    raise exception 'dues checkout failure refused' using errcode = '22023';
  end if;
  select * into reservation from public.dues_checkout_reservations row where row.id = p_reservation_id for update;
  if not found then raise exception 'dues checkout unavailable' using errcode = '42501'; end if;
  if (reservation.state = 'creating' and p_lease_epoch = 0 and p_lease_owner is null and p_lease_kind is null and reservation.stripe_session_id is null)
     or (reservation.state = 'reconciling' and reservation.reconcile_lease_epoch = p_lease_epoch
       and reservation.reconcile_lease_owner is not distinct from p_lease_owner
       and reservation.reconcile_lease_kind is not distinct from p_lease_kind
       and reservation.reconcile_lease_kind = 'ordinary' and reservation.reconcile_lease_expires_at > now()
       and reservation.stripe_session_id is null) then
    update public.dues_checkout_reservations
    set state = 'released', definitive_failure_class = p_failure_class,
        reconcile_lease_owner = null, reconcile_lease_expires_at = null,
        reconcile_lease_kind = null, updated_at = now()
    where id = reservation.id;
    return;
  end if;
  raise exception 'dues checkout lease stale' using errcode = '42501';
end;
$function$;

create or replace function private.dues_settle_stripe_checkout(
  p_reservation_id uuid,
  p_stripe_session_id text,
  p_payment_intent text,
  p_observed_account_id text,
  p_amount_cents integer,
  p_currency text,
  p_client_reference_id text,
  p_metadata_reservation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
  obligation public.dues_obligations%rowtype;
  existing public.dues_ledger_events%rowtype;
  receipt text;
  balance integer;
  reference text := 'stripe-session:' || p_stripe_session_id;
begin
  if p_stripe_session_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or (p_payment_intent is not null and p_payment_intent !~ '^[A-Za-z0-9_:-]{3,255}$')
     or p_observed_account_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_amount_cents is null or p_amount_cents <= 0
     or p_currency <> 'usd'
     or p_client_reference_id <> p_reservation_id::text
     or p_metadata_reservation_id <> p_reservation_id::text then
    raise exception 'invalid Stripe settlement' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id and row.stripe_session_id = p_stripe_session_id
  for update;
  if not found then raise exception 'dues checkout settlement unavailable' using errcode = '42501'; end if;
  if reservation.connected_account_id <> p_observed_account_id
     or reservation.reserved_cents <> p_amount_cents
     or reservation.checkout_currency <> p_currency then
    raise exception 'dues Stripe settlement mismatch' using errcode = '22023';
  end if;
  select * into existing
  from public.dues_ledger_events event
  where event.organization_id = reservation.organization_id
    and event.external_reference = reference
  for update;
  if found then
    if existing.obligation_id <> reservation.obligation_id or existing.event_kind <> 'payment'
       or existing.payment_method <> 'stripe' then
      raise exception 'dues Stripe settlement conflict' using errcode = '22023';
    end if;
    update public.dues_checkout_reservations
    set state = 'settled', reconcile_lease_owner = null, reconcile_lease_expires_at = null,
        reconcile_lease_kind = null, definitive_failure_class = null, updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'receiptNumber', existing.receipt_number, 'idempotent', true);
  end if;
  select * into obligation
  from public.dues_obligations row
  where row.organization_id = reservation.organization_id and row.id = reservation.obligation_id
  for update;
  if not found then raise exception 'dues obligation unavailable' using errcode = '42501'; end if;
  balance := private.dues_balance_cents(reservation.organization_id, reservation.obligation_id);
  if balance <> reservation.reserved_cents then
    raise exception 'dues checkout balance changed' using errcode = '55000';
  end if;
  receipt := private.dues_receipt_number(reservation.organization_id, current_date);
  insert into public.dues_ledger_events (
    organization_id, obligation_id, event_kind, amount_cents, effective_on,
    reason, payment_method, external_reference, receipt_number, idempotency_key, created_by
  ) values (
    reservation.organization_id, reservation.obligation_id, 'payment', reservation.reserved_cents, current_date,
    'Stripe Checkout settlement', 'stripe', reference, receipt,
    'dues-stripe-session:' || p_stripe_session_id, null
  ) returning * into existing;
  update public.dues_checkout_reservations
  set state = 'settled', reconcile_lease_owner = null, reconcile_lease_expires_at = null,
      reconcile_lease_kind = null, definitive_failure_class = null, updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'receiptNumber', receipt, 'idempotent', false);
end;
$function$;

create or replace function public.settle_dues_stripe_event(
  p_stripe_event_id text,
  p_reservation_id uuid,
  p_stripe_session_id text,
  p_payment_intent text,
  p_event_type text,
  p_stripe_account_id text,
  p_amount_cents integer,
  p_currency text,
  p_client_reference_id text,
  p_metadata_reservation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  recorded public.dues_stripe_events%rowtype;
  result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_stripe_event_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_stripe_session_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_event_type not in ('checkout.session.completed', 'checkout.session.async_payment_succeeded') then
    raise exception 'invalid Stripe event' using errcode = '22023';
  end if;
  insert into public.dues_stripe_events (stripe_event_id, reservation_id)
  values (p_stripe_event_id, p_reservation_id)
  on conflict (stripe_event_id) do nothing;
  if not found then
    select * into recorded from public.dues_stripe_events event where event.stripe_event_id = p_stripe_event_id;
    if recorded.reservation_id <> p_reservation_id then
      raise exception 'Stripe event reservation conflict' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('idempotent', true);
  end if;
  result := private.dues_settle_stripe_checkout(
    p_reservation_id,
    p_stripe_session_id,
    p_payment_intent,
    p_stripe_account_id,
    p_amount_cents,
    p_currency,
    p_client_reference_id,
    p_metadata_reservation_id
  );
  return result || pg_catalog.jsonb_build_object('idempotentEvent', false);
end;
$function$;

create or replace function public.reconcile_dues_checkout_reservation(
  p_reservation_id uuid,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_lease_kind text,
  p_session_status text,
  p_payment_status text,
  p_payment_intent text,
  p_observed_account_id text,
  p_amount_cents integer,
  p_currency text,
  p_client_reference_id text,
  p_metadata_reservation_id text,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
  result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_kind not in ('ordinary', 'disconnect')
     or p_session_status not in ('open', 'complete', 'expired', 'canceled', 'retention_expired', 'provider_error', 'unknown')
     or p_payment_status not in ('paid', 'unpaid', 'no_payment_required', 'unknown', 'provider_error', 'provider_unavailable', 'provider_not_found', 'provider_rate_limited', 'provider_auth_refused', 'provider_refused', 'invalid_checkout_request', 'provider_malformed')
     or p_observed_at is null then
    raise exception 'invalid dues checkout observation' using errcode = '22023';
  end if;
  select * into reservation from public.dues_checkout_reservations row where row.id = p_reservation_id for update;
  if not found or reservation.state <> 'reconciling'
     or reservation.reconcile_lease_epoch <> p_lease_epoch
     or reservation.reconcile_lease_owner is distinct from p_lease_owner
     or reservation.reconcile_lease_kind is distinct from p_lease_kind
     or reservation.reconcile_lease_expires_at <= now() then
    raise exception 'dues checkout lease stale' using errcode = '42501';
  end if;
  if p_session_status = 'complete' and p_payment_status = 'paid' then
    return private.dues_settle_stripe_checkout(
      reservation.id,
      reservation.stripe_session_id,
      p_payment_intent,
      p_observed_account_id,
      p_amount_cents,
      p_currency,
      p_client_reference_id,
      p_metadata_reservation_id
    );
  end if;
  if p_session_status in ('expired', 'canceled') then
    update public.dues_checkout_reservations
    set state = 'released', definitive_failure_class = case when p_lease_kind = 'disconnect' then 'provider_disconnected' else 'checkout_' || p_session_status end,
        reconcile_lease_owner = null, reconcile_lease_expires_at = null,
        reconcile_lease_kind = null, updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'released');
  end if;
  if p_session_status = 'retention_expired' then
    update public.dues_checkout_reservations
    set state = 'attention_required', definitive_failure_class = 'stripe_replay_retention_elapsed',
        reconcile_lease_owner = null, reconcile_lease_expires_at = null,
        reconcile_lease_kind = null, updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'attention_required');
  end if;
  if reservation.expires_at <= now() then
    update public.dues_checkout_reservations
    set state = case when reservation.stripe_session_id is null then 'attention_required' else 'released' end,
        definitive_failure_class = case when reservation.stripe_session_id is null then 'checkout_unconfirmed_at_retention' else 'checkout_expired' end,
        reconcile_lease_owner = null, reconcile_lease_expires_at = null,
        reconcile_lease_kind = null, updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', case when reservation.stripe_session_id is null then 'attention_required' else 'released' end);
  end if;
  if p_session_status = 'open' and p_lease_kind = 'ordinary' then
    update public.dues_checkout_reservations
    set state = 'open', reconcile_lease_owner = null, reconcile_lease_expires_at = null,
        reconcile_lease_kind = null, reconcile_after = reservation.expires_at, updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'open');
  end if;
  update public.dues_checkout_reservations
  set state = 'reconciling', reconcile_lease_owner = null, reconcile_lease_expires_at = null,
      reconcile_lease_kind = null, reconcile_after = now() + interval '5 minutes', updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'reconciling');
end;
$function$;

-- Retention expiry is intentionally not a silent release: only an authorized
-- service operator who has independently confirmed the provider is unpaid may
-- release the reservation. Paid outcomes remain webhook/reconciliation-only,
-- where the immutable account, amount, currency, and reservation references
-- are verified before the ledger can move.
create or replace function public.resolve_dues_checkout_attention(
  p_reservation_id uuid,
  p_outcome text,
  p_evidence_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
  evidence_digest text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_reservation_id is null
     or p_outcome <> 'provider_confirmed_unpaid'
     or p_evidence_reference !~ '^[A-Za-z0-9._:/-]{8,160}$' then
    raise exception 'invalid dues checkout attention resolution' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id
    and row.state = 'attention_required'
    and row.definitive_failure_class in (
      'stripe_replay_retention_elapsed', 'checkout_unconfirmed_at_retention'
    )
  for update;
  if not found then
    raise exception 'dues checkout attention unavailable' using errcode = '42501';
  end if;
  evidence_digest := pg_catalog.encode(
    extensions.digest(p_evidence_reference::bytea, 'sha256'), 'hex'
  );
  update public.dues_checkout_reservations
  set state = 'released', definitive_failure_class = 'operator_confirmed_unpaid',
      reconcile_lease_owner = null, reconcile_lease_expires_at = null,
      reconcile_lease_kind = null, updated_at = now()
  where id = reservation.id;
  perform private.mi1_write_tenant_audit(
    reservation.organization_id,
    'dues_checkout_attention_resolved',
    pg_catalog.jsonb_build_object(
      'outcome', p_outcome,
      'evidenceDigest', evidence_digest
    )
  );
  return pg_catalog.jsonb_build_object('reservationId', reservation.id, 'state', 'released');
end;
$function$;

create or replace function private.dues_claim_checkout_reconciliations(
  p_limit integer,
  p_worker_id uuid,
  p_disconnect boolean
)
returns table (
  reservation_id uuid,
  account_id text,
  idempotency_key text,
  amount_cents integer,
  currency text,
  description text,
  success_url text,
  cancel_url text,
  request_hash text,
  stripe_session_id text,
  state text,
  replay_until timestamptz,
  lease_epoch integer,
  lease_owner uuid,
  lease_kind text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 25 or p_worker_id is null then
    raise exception 'invalid dues reconciliation claim' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select reservation.id, reservation.state as prior_state
    from public.dues_checkout_reservations reservation
    join public.dues_provider_connections connection
      on connection.organization_id = reservation.organization_id
     and ((p_disconnect and connection.state = 'disconnecting') or (not p_disconnect and connection.state = 'ready'))
    where reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling')
      and reservation.reconcile_attempt_count < 25
      and (reservation.reconcile_lease_expires_at is null or reservation.reconcile_lease_expires_at <= now())
      and (
        (p_disconnect and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling'))
        or (reservation.state = 'creating' and reservation.created_at <= now() - interval '30 seconds')
        or reservation.state = 'cancel_requested'
        or (reservation.state = 'open' and reservation.expires_at <= now())
        or (reservation.state = 'reconciling' and reservation.reconcile_after <= now())
      )
    order by reservation.reconcile_after asc, reservation.created_at asc, reservation.id asc
    for update of reservation skip locked
    limit p_limit
  ), leased as (
    update public.dues_checkout_reservations reservation
    set state = 'reconciling', reconcile_lease_epoch = reservation.reconcile_lease_epoch + 1,
        reconcile_lease_owner = p_worker_id, reconcile_lease_expires_at = now() + interval '2 minutes',
        reconcile_lease_kind = case when p_disconnect then 'disconnect' else 'ordinary' end,
        reconcile_attempt_count = reservation.reconcile_attempt_count + 1, updated_at = now()
    from candidates
    where reservation.id = candidates.id
    returning reservation.*, candidates.prior_state
  )
  select leased.id, leased.connected_account_id, leased.provider_idempotency_key,
    leased.reserved_cents, leased.checkout_currency, leased.receipt_description,
    leased.success_url, leased.cancel_url, leased.request_hash, leased.stripe_session_id,
    leased.prior_state as state, leased.stripe_idempotency_replay_until, leased.reconcile_lease_epoch,
    leased.reconcile_lease_owner, leased.reconcile_lease_kind
  from leased;
end;
$function$;

create or replace function public.claim_dues_checkout_reconciliations(p_limit integer, p_worker_id uuid)
returns table (
  reservation_id uuid, account_id text, idempotency_key text, amount_cents integer,
  currency text, description text, success_url text, cancel_url text, request_hash text,
  stripe_session_id text, state text, replay_until timestamptz, lease_epoch integer,
  lease_owner uuid, lease_kind text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  return query select * from private.dues_claim_checkout_reconciliations(p_limit, p_worker_id, false);
end;
$function$;

create or replace function public.claim_dues_stripe_disconnect_reconciliations(p_limit integer, p_worker_id uuid)
returns table (
  reservation_id uuid, account_id text, idempotency_key text, amount_cents integer,
  currency text, description text, success_url text, cancel_url text, request_hash text,
  stripe_session_id text, state text, replay_until timestamptz, lease_epoch integer,
  lease_owner uuid, lease_kind text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  return query select * from private.dues_claim_checkout_reconciliations(p_limit, p_worker_id, true);
end;
$function$;

create or replace function public.claim_dues_stripe_disconnect_accounts(p_limit integer, p_worker_id uuid)
returns table (account_id text, lease_epoch integer, lease_owner uuid)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 25 or p_worker_id is null then
    raise exception 'invalid dues disconnect claim' using errcode = '22023';
  end if;
  -- An unresolved provider observation needs an operator rather than a blind
  -- deauthorization. This preserves the account ID only in the restricted
  -- provider table so settlement can still be investigated safely.
  update public.dues_provider_connections connection
  set state = 'attention_required', last_error_class = 'checkout_attention_required', updated_at = now()
  where connection.state = 'disconnecting'
    and exists (
      select 1 from public.dues_checkout_reservations reservation
      where reservation.organization_id = connection.organization_id
        and reservation.state = 'attention_required'
    );
  return query
  with candidates as (
    select connection.organization_id
    from public.dues_provider_connections connection
    where connection.state = 'disconnecting'
      and connection.stripe_account_id is not null
      and (connection.disconnect_lease_expires_at is null or connection.disconnect_lease_expires_at <= now())
      and not exists (
        select 1 from public.dues_checkout_reservations reservation
        where reservation.organization_id = connection.organization_id
          and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required')
      )
    order by connection.updated_at asc, connection.organization_id
    for update skip locked
    limit p_limit
  ), leased as (
    update public.dues_provider_connections connection
    set disconnect_lease_epoch = connection.disconnect_lease_epoch + 1,
        disconnect_lease_owner = p_worker_id,
        disconnect_lease_expires_at = now() + interval '2 minutes', updated_at = now()
    from candidates
    where connection.organization_id = candidates.organization_id
    returning connection.*
  )
  select leased.stripe_account_id, leased.disconnect_lease_epoch, leased.disconnect_lease_owner
  from leased;
end;
$function$;

create or replace function public.complete_dues_stripe_disconnect(
  p_account_id text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_outcome text,
  p_failure_class text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare connection public.dues_provider_connections%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_outcome not in ('disconnected', 'attention_required') then
    raise exception 'invalid dues disconnect completion' using errcode = '22023';
  end if;
  select * into connection
  from public.dues_provider_connections row
  where row.stripe_account_id = p_account_id
  for update;
  if not found or connection.state <> 'disconnecting'
     or connection.disconnect_lease_epoch <> p_lease_epoch
     or connection.disconnect_lease_owner is distinct from p_lease_owner
     or connection.disconnect_lease_expires_at <= now() then
    raise exception 'dues disconnect lease stale' using errcode = '42501';
  end if;
  if p_outcome = 'disconnected' then
    if exists (
      select 1 from public.dues_checkout_reservations reservation
      where reservation.organization_id = connection.organization_id
        and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required')
    ) then
      raise exception 'dues disconnect has active checkout' using errcode = '55000';
    end if;
    update public.dues_provider_connections
    set state = 'disconnected', stripe_account_id = null, account_label = null,
        charges_enabled = false, payouts_enabled = false, disconnected_at = now(),
        last_error_class = null, disconnect_lease_owner = null,
        disconnect_lease_expires_at = null, updated_at = now()
    where organization_id = connection.organization_id;
    return pg_catalog.jsonb_build_object('state', 'disconnected');
  end if;
  update public.dues_provider_connections
  set state = 'attention_required', last_error_class = nullif(pg_catalog.left(p_failure_class, 80), ''),
      disconnect_lease_owner = null, disconnect_lease_expires_at = null, updated_at = now()
  where organization_id = connection.organization_id;
  return pg_catalog.jsonb_build_object('state', 'attention_required');
end;
$function$;

create or replace function private.dues_provider_projection(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'state', connection.state,
      'checkoutAvailable', connection.state = 'ready' and connection.charges_enabled,
      'accountLabel', connection.account_label,
      'attention', connection.last_error_class
    )
    from public.dues_provider_connections connection
    where connection.organization_id = p_organization_id
  ), pg_catalog.jsonb_build_object('state', 'unset', 'checkoutAvailable', false, 'accountLabel', null, 'attention', null))
$function$;

-- The read models retain their original RLS-scoped subject and staff checks;
-- this revision only makes the optional provider state honest and includes the
-- assessment title required by the native/web receipt surfaces.
create or replace function public.get_my_dues_workspace(
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  member_subject uuid;
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues MFA required' using errcode = '42501';
  end if;
  select subject.id into member_subject
  from public.dues_member_subjects subject
  where subject.organization_id = org and subject.user_id = (select auth.uid());
  if member_subject is null then
    raise exception 'dues subject provisioning incomplete' using errcode = '55000';
  end if;
  return (
    with page as (
      select obligation.*, batch.title as assessment_title,
        coalesce((
          select sum(case event.event_kind
            when 'payment' then event.amount_cents
            when 'waiver' then event.amount_cents
            when 'credit_adjustment' then event.amount_cents
            when 'debit_adjustment' then -event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as settled_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'payment')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as paid_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'waiver')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as waived_cents,
        coalesce((
          select sum(case event.event_kind
            when 'credit_adjustment' then -event.amount_cents
            when 'debit_adjustment' then event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as adjustment_cents
      from public.dues_obligations obligation
      join public.dues_assessment_batches batch
        on batch.organization_id = obligation.organization_id and batch.id = obligation.batch_id
      where obligation.organization_id = org and obligation.member_subject_id = member_subject
        and (p_after_id is null or obligation.id > p_after_id)
      order by obligation.id asc
      limit limit_value + 1
    ), visible as (
      select * from page order by id asc limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready', 'staff', false,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from visible), 0),
        'overdueCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from visible where due_on < current_date), 0),
        'collectedCents', coalesce((select sum(paid_cents) from visible), 0), 'memberCount', 1
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', id, 'assessmentTitle', assessment_title, 'issuedCents', issued_cents,
          'settledCents', settled_cents, 'balanceCents', greatest(issued_cents - settled_cents, 0), 'dueOn', due_on,
          'standing', case
            when issued_cents - settled_cents <= 0 and waived_cents > 0 and paid_cents = 0 then 'waived'
            when issued_cents - settled_cents <= 0 then 'paid'
            when paid_cents > 0 or waived_cents > 0 or adjustment_cents < 0 then 'partial'
            when due_on < current_date then 'overdue'
            else 'open'
          end,
          'events', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', event.id, 'kind', event.event_kind, 'amountCents', event.amount_cents,
            'effectiveOn', event.effective_on, 'receiptNumber', event.receipt_number, 'paymentMethod', event.payment_method
          ) order by event.effective_on desc, event.id desc)
          from public.dues_ledger_events event
          where event.organization_id = org and event.obligation_id = visible.id), '[]'::jsonb)
        ) order by id) from visible), '[]'::jsonb),
        'nextCursor', (select id from page order by id asc offset limit_value limit 1)
      ),
      'chapters', '[]'::jsonb, 'provider', private.dues_provider_projection(org)
    )
  );
end;
$function$;

create or replace function public.get_dues_workspace(
  p_query text default null,
  p_status text default null,
  p_due_on date default null,
  p_after_id uuid default null,
  p_limit integer default 25,
  p_selected_hat text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  query_value text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if query_value is not null and pg_catalog.char_length(query_value) > 120 then
    raise exception 'dues search too long' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('open', 'partial', 'overdue', 'paid', 'waived') then
    raise exception 'invalid dues status' using errcode = '22023';
  end if;
  return (
    with calculated as (
      select obligation.*, batch.title as assessment_title, subject.user_id,
        coalesce(profile.full_name, 'Member') as member_label,
        coalesce((
          select sum(case event.event_kind
            when 'payment' then event.amount_cents
            when 'waiver' then event.amount_cents
            when 'credit_adjustment' then event.amount_cents
            when 'debit_adjustment' then -event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as settled_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'payment')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as paid_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'waiver')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as waived_cents,
        coalesce((
          select sum(case event.event_kind
            when 'credit_adjustment' then -event.amount_cents
            when 'debit_adjustment' then event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id and event.obligation_id = obligation.id
        ), 0) as adjustment_cents
      from public.dues_obligations obligation
      join public.dues_assessment_batches batch
        on batch.organization_id = obligation.organization_id and batch.id = obligation.batch_id
      join public.dues_member_subjects subject
        on subject.organization_id = obligation.organization_id and subject.id = obligation.member_subject_id
      left join public.member_profiles profile on profile.id = subject.user_id
      where obligation.organization_id = org
    ), classified as (
      select *, case
        when issued_cents - settled_cents <= 0 and waived_cents > 0 and paid_cents = 0 then 'waived'
        when issued_cents - settled_cents <= 0 then 'paid'
        when paid_cents > 0 or waived_cents > 0 or adjustment_cents < 0 then 'partial'
        when due_on < current_date then 'overdue'
        else 'open'
      end as standing
      from calculated
    ), page as (
      select * from classified
      where (p_after_id is null or id > p_after_id)
        and (p_due_on is null or due_on = p_due_on)
        and (p_status is null or standing = p_status)
        and (query_value is null or member_label ilike '%' || query_value || '%' escape '\'
          or assessment_title ilike '%' || query_value || '%' escape '\')
      order by id asc
      limit limit_value + 1
    ), visible as (
      select * from page order by id asc limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready', 'staff', true,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from calculated), 0),
        'overdueCents', coalesce((select sum(greatest(issued_cents - settled_cents, 0)) from calculated where due_on < current_date), 0),
        'collectedCents', coalesce((select sum(paid_cents) from calculated), 0),
        'memberCount', (select count(distinct member_subject_id) from calculated)
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', id, 'memberSubjectId', member_subject_id,
          'memberLabel', member_label, 'assessmentTitle', assessment_title,
          'issuedCents', issued_cents, 'settledCents', settled_cents,
          'balanceCents', greatest(issued_cents - settled_cents, 0), 'dueOn', due_on,
          'standing', standing, 'chapterId', chapter_id
        ) order by id) from visible), '[]'::jsonb),
        'nextCursor', (select id from page order by id asc offset limit_value limit 1)
      ),
      'chapters', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', chapter.id, 'name', chapter.name) order by chapter.name)
        from public.chapters chapter where chapter.organization_id = org), '[]'::jsonb),
      'provider', private.dues_provider_projection(org)
    )
  );
end;
$function$;

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'integration-webhooks-dispatch-tick', 'notifications-dispatch-tick',
    'notifications-expiry-sweep', 'deadline-notices-tick',
    'ballot-notices-tick', 'event-notices-tick', 'appointment-reminders-tick',
    'member-messaging-dispatch', 'workload-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent',
    'task-files-reconcile-tick', 'task-maintenance-daily',
    'dues-stripe-reconcile-tick'
  ));

-- Platform reconciliation has no tenant owner. Record only a bounded run ID,
-- stable status, and redacted error class so Job Health can expose execution
-- evidence without storing any Stripe or member material.
create or replace function public.record_dues_reconcile_job_run(
  p_run_id text,
  p_status text,
  p_failure_class text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_run_id !~ '^[A-Za-z0-9:_-]{8,160}$'
     or p_status not in ('in_progress', 'completed', 'failed')
     or (p_failure_class is not null and p_failure_class !~ '^[a-z0-9_-]{1,80}$') then
    raise exception 'invalid dues reconciliation run' using errcode = '22023';
  end if;
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  ) values (
    null, 'dues-stripe-reconcile-tick', p_run_id, p_status, now(),
    case when p_status = 'in_progress' then null else now() end,
    case when p_status = 'failed' then p_failure_class else null end,
    case when p_status = 'failed' then 'Dues Stripe reconciliation failed.' else 'Dues Stripe reconciliation recorded.' end
  )
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status,
        finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary;
end;
$function$;

revoke all on function private.dues_checkout_request_hash(uuid, text, text, integer, text, text, text, text),
  private.dues_reject_competing_checkout_mutation(),
  private.dues_sync_financial_identity_for_context(uuid, uuid),
  private.sync_dues_financial_identity_from_organization_change(),
  private.dues_require_financial_hat(text),
  private.dues_settle_stripe_checkout(uuid, text, text, text, integer, text, text, text),
  private.dues_claim_checkout_reconciliations(integer, uuid, boolean),
  private.dues_provider_projection(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.set_dues_financial_identity_for_context(uuid, uuid, text, text),
  public.provision_dues_financial_identity_for_active_context(uuid),
  public.prepare_dues_checkout_reservation(uuid, text),
  public.finalize_dues_checkout_reservation(uuid, text, text, timestamptz, integer, uuid, text),
  public.fail_dues_checkout_reservation(uuid, text, integer, uuid, text),
  public.settle_dues_stripe_event(text, uuid, text, text, text, text, integer, text, text, text),
  public.reconcile_dues_checkout_reservation(uuid, integer, uuid, text, text, text, text, text, integer, text, text, text, timestamptz),
  public.resolve_dues_checkout_attention(uuid, text, text),
  public.claim_dues_checkout_reconciliations(integer, uuid),
  public.claim_dues_stripe_disconnect_reconciliations(integer, uuid),
  public.claim_dues_stripe_disconnect_accounts(integer, uuid),
  public.complete_dues_stripe_disconnect(text, integer, uuid, text, text),
  public.record_dues_reconcile_job_run(text, text, text)
  from public, anon, authenticated;

revoke all on function public.set_my_dues_financial_identity(text)
  from public, anon, authenticated;

revoke all on function public.get_my_dues_financial_identity_choices(),
  public.cancel_dues_checkout_reservation(uuid),
  public.get_my_dues_workspace(uuid, integer),
  public.get_dues_workspace(text, text, date, uuid, integer, text)
  from public, anon;

create policy mfa_assurance on public.dues_assessment_batches
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_receipt_counters
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_member_subjects
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_obligations
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_ledger_events
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_reminder_attempts
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_notification_deliveries
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_stripe_events
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_checkout_reservations
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.dues_provider_connections
  as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

grant execute on function public.get_my_dues_financial_identity_choices(),
  public.cancel_dues_checkout_reservation(uuid),
  public.get_my_dues_workspace(uuid, integer),
  public.get_dues_workspace(text, text, date, uuid, integer, text)
  to authenticated;

grant execute on function public.set_dues_financial_identity_for_context(uuid, uuid, text, text),
  public.provision_dues_financial_identity_for_active_context(uuid),
  public.prepare_dues_checkout_reservation(uuid, text),
  public.finalize_dues_checkout_reservation(uuid, text, text, timestamptz, integer, uuid, text),
  public.fail_dues_checkout_reservation(uuid, text, integer, uuid, text),
  public.settle_dues_stripe_event(text, uuid, text, text, text, text, integer, text, text, text),
  public.reconcile_dues_checkout_reservation(uuid, integer, uuid, text, text, text, text, text, integer, text, text, text, timestamptz),
  public.resolve_dues_checkout_attention(uuid, text, text),
  public.claim_dues_checkout_reconciliations(integer, uuid),
  public.claim_dues_stripe_disconnect_reconciliations(integer, uuid),
  public.claim_dues_stripe_disconnect_accounts(integer, uuid),
  public.complete_dues_stripe_disconnect(text, integer, uuid, text, text),
  public.record_dues_reconcile_job_run(text, text, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
