begin;

-- Once the OAuth code has been exchanged, the Stripe account ID is durable and
-- the code must never be replayed. A later authorized Connect start can finish
-- that one recorded exchange after a process/browser interruption. The lookup
-- is service-only, exact to the already-authorized organization, user, and
-- server-assigned financial identity supplied by the handler.
create or replace function public.get_pending_dues_stripe_oauth_exchange(
  p_organization_id uuid,
  p_requested_by uuid,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate_count integer;
  account_id text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_organization_id is null
     or p_requested_by is null
     or p_selected_hat not in ('admin', 'vp') then
    raise exception 'dues Stripe exchange recovery refused' using errcode = '42501';
  end if;

  -- A ready connection is already the organization’s current explicit choice.
  -- Never let an older recorded exchange overwrite it during a later start.
  if exists (
    select 1 from public.dues_provider_connections connection
    where connection.organization_id = p_organization_id
      and connection.state = 'ready'
  ) then
    update private.dues_stripe_oauth_states state
      set recovery_required_at = coalesce(state.recovery_required_at, now())
    where state.organization_id = p_organization_id
      and state.requested_by = p_requested_by
      and state.selected_hat = p_selected_hat
      and state.consumed_at is null
      and state.recovery_required_at is null
      and state.exchange_started_at is not null
      and state.exchange_account_id is not null
      and state.exchange_recorded_at is not null;
    return pg_catalog.jsonb_build_object('state', 'none');
  end if;

  select count(*), min(state.exchange_account_id)
    into candidate_count, account_id
  from private.dues_stripe_oauth_states state
  where state.organization_id = p_organization_id
    and state.requested_by = p_requested_by
    and state.selected_hat = p_selected_hat
    and state.consumed_at is null
    and state.recovery_required_at is null
    and state.exchange_started_at is not null
    and state.exchange_account_id is not null
    and state.exchange_recorded_at is not null;

  if candidate_count = 0 then
    return pg_catalog.jsonb_build_object('state', 'none');
  end if;

  if candidate_count <> 1 then
    update private.dues_stripe_oauth_states state
      set recovery_required_at = coalesce(state.recovery_required_at, now())
    where state.organization_id = p_organization_id
      and state.requested_by = p_requested_by
      and state.selected_hat = p_selected_hat
      and state.consumed_at is null
      and state.recovery_required_at is null
      and state.exchange_started_at is not null
      and state.exchange_account_id is not null
      and state.exchange_recorded_at is not null;

    update public.dues_provider_connections
      set state = 'attention_required',
          last_error_class = 'oauth_recorded_exchange_ambiguous',
          updated_at = now()
    where organization_id = p_organization_id
      and state <> 'ready';

    perform private.mi1_write_tenant_audit(
      p_organization_id,
      'dues_stripe_oauth_recovery_required',
      pg_catalog.jsonb_build_object('requestedBy', p_requested_by, 'reason', 'recorded_exchange_ambiguous')
    );
    return pg_catalog.jsonb_build_object('state', 'attention_required');
  end if;

  return pg_catalog.jsonb_build_object('state', 'recorded', 'accountId', account_id);
end;
$function$;

-- This does not exchange an OAuth code. It can only finalize exactly one
-- account that the callback had already durably recorded for this same
-- organization, requester, and server-assigned financial identity.
create or replace function public.resume_dues_stripe_oauth_exchange(
  p_organization_id uuid,
  p_requested_by uuid,
  p_selected_hat text,
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
declare
  saved private.dues_stripe_oauth_states%rowtype;
  candidate_count integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_organization_id is null
     or p_requested_by is null
     or p_selected_hat not in ('admin', 'vp')
     or p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'dues Stripe exchange recovery refused' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.dues_provider_connections connection
    where connection.organization_id = p_organization_id
      and connection.state = 'ready'
  ) then
    raise exception 'dues Stripe recorded exchange superseded' using errcode = '42501';
  end if;

  select count(*) into candidate_count
  from private.dues_stripe_oauth_states state
  where state.organization_id = p_organization_id
    and state.requested_by = p_requested_by
    and state.selected_hat = p_selected_hat
    and state.exchange_account_id = p_account_id
    and state.consumed_at is null
    and state.recovery_required_at is null
    and state.exchange_started_at is not null
    and state.exchange_recorded_at is not null;
  if candidate_count <> 1 then
    raise exception 'dues Stripe recorded exchange unavailable' using errcode = '42501';
  end if;

  select * into saved
  from private.dues_stripe_oauth_states state
  where state.organization_id = p_organization_id
    and state.requested_by = p_requested_by
    and state.selected_hat = p_selected_hat
    and state.exchange_account_id = p_account_id
    and state.consumed_at is null
    and state.recovery_required_at is null
    and state.exchange_started_at is not null
    and state.exchange_recorded_at is not null
  for update;
  if saved.state_hash is null then
    raise exception 'dues Stripe recorded exchange unavailable' using errcode = '42501';
  end if;

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

  update private.dues_stripe_oauth_states
    set consumed_at = now()
  where state_hash = saved.state_hash;

  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_connected',
    pg_catalog.jsonb_build_object('requestedBy', saved.requested_by, 'oauthStateFinalized', true, 'resumedRecordedExchange', true)
  );
  return pg_catalog.jsonb_build_object('state', 'ready');
end;
$function$;

revoke all on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text),
  public.resume_dues_stripe_oauth_exchange(uuid, uuid, text, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text),
  public.resume_dues_stripe_oauth_exchange(uuid, uuid, text, text, text, boolean, boolean)
  to service_role;

notify pgrst, 'reload schema';

commit;
