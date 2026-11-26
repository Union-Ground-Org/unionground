-- Exact-head Dues repairs: retain the provider account on the OAuth
-- compensation path before attempting deauthorization. No credential or
-- OAuth token is stored; only the provider's non-secret account identifier.

begin;

set local lock_timeout = '5s';

-- Dues completion, recovery, and reconciliation RPCs are service-only and
-- already bind their organization under locked provider/ledger rows. Preserve
-- the original session-derived rule for every non-service caller while
-- allowing those exact service operations to append their tenant audit row.
create or replace function private.mi1_write_tenant_audit(
  p_organization_id uuid,
  p_event_type text,
  p_metadata jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  request_role text := coalesce((select auth.jwt() ->> 'role'), '');
  audit_actor uuid := (select auth.uid());
  audit_actor_text text;
begin
  if p_organization_id is null or not exists (
    select 1
    from public.organizations organization
    where organization.id = p_organization_id
  ) then
    raise exception 'audit organization unavailable' using errcode = '42501';
  end if;
  if request_role <> 'service_role'
     and p_organization_id is distinct from private.current_member_organization() then
    raise exception 'audit organization is derived from the session' using errcode = '42501';
  end if;
  if request_role = 'service_role' then
    audit_actor_text := coalesce(
      nullif(p_metadata ->> 'requestedBy', ''),
      nullif(p_metadata ->> 'userId', '')
    );
    if audit_actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      audit_actor := audit_actor_text::uuid;
    elsif p_event_type = 'dues_checkout_attention_resolved'
       and coalesce(p_metadata ->> 'reservationId', '')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select reservation.requested_by into audit_actor
      from public.dues_checkout_reservations reservation
      where reservation.organization_id = p_organization_id
        and reservation.id = (p_metadata ->> 'reservationId')::uuid;
    end if;
    if audit_actor is null or not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = audit_actor
    ) then
      raise exception 'service audit actor unavailable' using errcode = '42501';
    end if;
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id,
    p_event_type,
    audit_actor,
    extensions.gen_random_uuid(),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$function$;

create or replace function public.defer_dues_stripe_oauth_callback(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_failure_class text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_failure_class !~ '^[a-z0-9_-]{1,80}$' then
    raise exception 'dues Stripe callback defer refused' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
  for update;
  if not found or saved.callback_lease_epoch <> p_lease_epoch
     or saved.callback_lease_owner is distinct from p_lease_owner
     or saved.callback_lease_expires_at is null
     or saved.callback_lease_expires_at <= now() then
    raise exception 'dues Stripe callback lease stale' using errcode = '42501';
  end if;
  update private.dues_stripe_oauth_states
  set callback_state = case when exchanged_account_id is null then 'attention_required' else 'exchanged' end,
      last_error_class = p_failure_class,
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      reconcile_after = now() + interval '5 minutes',
      consumed_at = case when exchanged_account_id is null then now() else consumed_at end
  where state_hash = saved.state_hash;
  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_oauth_deferred',
    pg_catalog.jsonb_build_object(
      'requestedBy', saved.requested_by,
      'failureClass', p_failure_class
    )
  );
end;
$function$;

create or replace function public.fail_dues_stripe_oauth_callback(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_failure_class text,
  p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_failure_class !~ '^[a-z0-9_-]{1,80}$'
     or p_outcome not in ('refused', 'attention_required') then
    raise exception 'dues Stripe callback failure refused' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
  for update;
  if not found or saved.callback_lease_epoch <> p_lease_epoch
     or saved.callback_lease_owner is distinct from p_lease_owner
     or saved.callback_lease_expires_at is null
     or saved.callback_lease_expires_at <= now() then
    raise exception 'dues Stripe callback lease stale' using errcode = '42501';
  end if;
  update private.dues_stripe_oauth_states
  set callback_state = p_outcome,
      last_error_class = p_failure_class,
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      consumed_at = now()
  where state_hash = saved.state_hash;
  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_oauth_failed',
    pg_catalog.jsonb_build_object(
      'requestedBy', saved.requested_by,
      'failureClass', p_failure_class,
      'outcome', p_outcome
    )
  );
end;
$function$;

create or replace function public.get_dues_provider_status(p_selected_hat text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  connection public.dues_provider_connections%rowtype;
begin
  select * into connection
  from public.dues_provider_connections row
  where row.organization_id = org;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'state', coalesce(connection.state, 'unset'),
    'checkoutAvailable', coalesce(connection.state = 'ready' and connection.charges_enabled, false),
    'accountLabel', connection.account_label,
    'attention', connection.last_error_class
  );
end;
$function$;

create function public.read_dues_stripe_account_for_test(
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
  account_id text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_organization_id is null
     or p_requested_by is null
     or p_selected_hat not in ('admin', 'vp') then
    raise exception 'dues Stripe readiness test refused' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    join public.organization_role_grants role_grant
      on role_grant.organization_id = membership.organization_id
     and role_grant.user_id = membership.user_id
     and role_grant.role = p_selected_hat
    where membership.organization_id = p_organization_id
      and membership.user_id = p_requested_by
      and membership.status = 'active'
  ) then
    raise exception 'dues Stripe readiness context unavailable' using errcode = '42501';
  end if;
  select connection.stripe_account_id into account_id
  from public.dues_provider_connections connection
  where connection.organization_id = p_organization_id
    and connection.state = 'ready';
  if account_id is null or account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'dues Stripe readiness account unavailable' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('accountId', account_id);
end;
$function$;

create function public.record_dues_stripe_oauth_recovery_account(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_account_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_state_hash is null
     or p_state_hash !~ '^[a-f0-9]{64}$'
     or p_lease_epoch is null
     or p_lease_epoch < 1
     or p_lease_owner is null
     or p_account_id is null
     or p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'dues Stripe recovery account refused' using errcode = '42501';
  end if;

  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
  for update;

  if not found
     or saved.consumed_at is not null
     or saved.callback_state not in ('processing', 'exchanged')
     or saved.callback_lease_epoch <> p_lease_epoch
     or saved.callback_lease_owner is distinct from p_lease_owner
     or saved.callback_lease_expires_at is null
     or saved.callback_lease_expires_at <= now()
     or (saved.exchange_account_id is not null and saved.exchange_account_id <> p_account_id)
     or (saved.exchanged_account_id is not null and saved.exchanged_account_id <> p_account_id) then
    raise exception 'dues Stripe recovery account unavailable' using errcode = '42501';
  end if;

  update private.dues_stripe_oauth_states
  set exchanged_account_id = p_account_id,
      recovery_required_at = coalesce(recovery_required_at, now()),
      callback_state = 'attention_required',
      last_error_class = 'oauth_exchange_recovery_required',
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      reconcile_after = now()
  where state_hash = saved.state_hash;
end;
$function$;

create or replace function public.resolve_dues_stripe_oauth_recovery(
  p_state_hash text,
  p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved private.dues_stripe_oauth_states%rowtype;
begin
  if p_outcome <> 'authorization_revoked'
     or coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'dues Stripe recovery refused' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
    and row.consumed_at is null
    and row.recovery_required_at is not null
  for update;
  if not found then
    raise exception 'dues Stripe recovery unavailable' using errcode = '42501';
  end if;
  update private.dues_stripe_oauth_states
  set consumed_at = now(),
      completed_at = now(),
      callback_state = 'refused',
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      last_error_class = 'oauth_exchange_authorization_revoked'
  where state_hash = saved.state_hash;
  update public.dues_provider_connections
  set state = 'unset',
      last_error_class = 'oauth_exchange_authorization_revoked',
      updated_at = now()
  where organization_id = saved.organization_id
    and state <> 'ready';
  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_oauth_failed',
    pg_catalog.jsonb_build_object(
      'requestedBy', saved.requested_by,
      'outcome', p_outcome,
      'failureClass', 'oauth_exchange_authorization_revoked'
    )
  );
end;
$function$;

revoke all on function public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text)
  from public, anon, authenticated;
revoke all on function public.read_dues_stripe_account_for_test(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.resolve_dues_stripe_oauth_recovery(text, text)
  from public, anon, authenticated;
grant execute on function public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text) to service_role;
grant execute on function public.read_dues_stripe_account_for_test(uuid, uuid, text) to service_role;
grant execute on function public.resolve_dues_stripe_oauth_recovery(text, text) to service_role;

notify pgrst, 'reload schema';

commit;
