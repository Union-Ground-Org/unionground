-- OPS-UG-DUES-OAUTH-READY-CONNECTION-RECOVERY-NO-AUDIT-20260918: the
-- ready-connection branch of public.get_pending_dues_stripe_oauth_exchange
-- quarantines a legacy recorded exchange without writing the tenant audit
-- event the ambiguous branch writes. After 20260918080000 the only operator
-- trace of that quarantine is last_error_class on a private table. Re-emit the
-- function so a ready-connection quarantine that actually matched a row writes
-- dues_stripe_oauth_recovery_required with reason superseded_by_ready_connection.
-- An ordinary lookup for an already-ready connection with nothing in flight
-- writes no audit event. Return shape {'state':'none'} and the ready
-- connection row are unchanged. No table, constraint, policy or grant changes.

begin;

set local lock_timeout = '5s';

-- 20260918080000 replaced the 20260917131000 body and re-pinned the live
-- digest to 7caa2b9f…; that is the only body this repair may supersede.
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
  if digest is distinct from '7caa2b9f9eaf09432f9bb239785438a9e741edce042121447cbbc120bfbb21bd' then
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
    -- FOUND is the quarantine UPDATE, not the ready-connection EXISTS. An
    -- ordinary lookup for an already-ready connection with nothing in flight
    -- must not write a tenant audit event.
    if found then
      perform private.mi1_write_tenant_audit(
        p_organization_id,
        'dues_stripe_oauth_recovery_required',
        pg_catalog.jsonb_build_object('requestedBy', p_requested_by, 'reason', 'superseded_by_ready_connection')
      );
    end if;
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
  'Service-only lookup for one durably exchanged, unconsumed Stripe account. Recovery branches copy the legacy account id onto exchanged_account_id, clear the constrained legacy pair, stamp recovery_required_at, and write the same recovery row public.record_dues_stripe_oauth_recovery_account writes. A ready-connection quarantine that matched a row also writes dues_stripe_oauth_recovery_required with reason superseded_by_ready_connection; a ready lookup with nothing in flight writes no audit event.';

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
  if digest is distinct from '0dd809feef3c32f2ea88877bd5498e1875004368d9512f5499e76d4852867ee7' then
    raise exception 'get_pending_dues_stripe_oauth_exchange source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
