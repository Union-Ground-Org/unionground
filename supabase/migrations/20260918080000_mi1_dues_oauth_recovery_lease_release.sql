-- BUG-UG-DUES-OAUTH-RECOVERY-LAST-ERROR-CLASS-AND-LEASE-20260917: the two
-- recovery branches of public.get_pending_dues_stripe_oauth_exchange quarantine
-- a dues OAuth state row in 'attention_required' but write only five of the
-- seven columns public.record_dues_stripe_oauth_recovery_account
-- (20260831223000) writes for that same documented state. The row is therefore
-- left with a stale or null last_error_class — the column operators read to
-- tell recovery reasons apart — a callback lease that outlives the state it
-- belonged to, and a reconcile_after that was never re-armed. Re-emit the
-- function so both branches match the canonical writer field for field. No
-- table, constraint, policy or grant changes here.

begin;

set local lock_timeout = '5s';

-- 20260917131000 replaced the 20260907151000-wrapped body and re-pinned the
-- ledger to 3a343c15…; that is the only body this repair may supersede. A
-- fresh install reaches it through 20260831210909 -> 20260907151000 (wrap) ->
-- 20260917131000, so no earlier digest is admitted here.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '3a343c15230e0532835ea1ab71e8ba2e5a3a4ceeb86bfd7802b20f08c300bffa' then
    raise exception 'unreviewed get_pending_dues_stripe_oauth_exchange predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
      set exchanged_account_id = coalesce(state.exchanged_account_id, state.exchange_account_id),
          recovery_required_at = coalesce(state.recovery_required_at, now()),
          exchange_account_id = null,
          exchange_recorded_at = null,
          callback_state = 'attention_required',
          last_error_class = 'oauth_exchange_recovery_required',
          callback_lease_owner = null,
          callback_lease_expires_at = null,
          reconcile_after = now()
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
      set exchanged_account_id = coalesce(state.exchanged_account_id, state.exchange_account_id),
          recovery_required_at = coalesce(state.recovery_required_at, now()),
          exchange_account_id = null,
          exchange_recorded_at = null,
          callback_state = 'attention_required',
          last_error_class = 'oauth_exchange_recovery_required',
          callback_lease_owner = null,
          callback_lease_expires_at = null,
          reconcile_after = now()
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
end;
$function$;

revoke all on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)
  to service_role;

comment on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text) is
  'Service-only lookup for one durably exchanged, unconsumed Stripe account. Recovery branches copy the legacy account id onto exchanged_account_id, clear the constrained legacy pair, stamp recovery_required_at, and write the same recovery row public.record_dues_stripe_oauth_recovery_account writes: last_error_class = oauth_exchange_recovery_required, no callback lease, reconcile_after re-armed.';

-- Re-pin the 20260907151000 installation-wrapper ledger to this inner source.
-- Fresh installs still wrap the original 20260831210909 body first; 20260917131000
-- then replaces the wrapped routine and this file replaces it again. The
-- wrap-time hash stays in 20260917131000 so a later unreviewed edit of that
-- original inner source still fails closed.
do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '7caa2b9f9eaf09432f9bb239785438a9e741edce042121447cbbc120bfbb21bd' then
    raise exception 'get_pending_dues_stripe_oauth_exchange source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
