-- BUG-UG-DUES-OAUTH-RECOVERY-ACCOUNT-CHECK-CONSTRAINT-20260918:
-- public.record_dues_stripe_oauth_recovery_account stamps recovery_required_at
-- without clearing the legacy exchange_account_id / exchange_recorded_at pair,
-- so a 3-arg record_dues_stripe_oauth_exchange row then this writer raises
-- 23514 against check (recovery_required_at is null or exchange_account_id is
-- null). The live callback uses the 6-arg overload, which writes
-- exchanged_account_id; this repair is latent for any service-role caller of
-- the 3-arg writer. Re-emit the function so the same UPDATE that stamps
-- recovery_required_at also clears the constrained pair. No table, constraint,
-- policy or grant changes here; the 6-arg exchange writer is untouched.

begin;

set local lock_timeout = '5s';

-- 20260907151000 wrapped the 20260831223000 inner source 6b857057… and that
-- wrapped body is the only predecessor this repair may supersede. A fresh
-- install still wraps the original inner source first; this file then replaces
-- the wrapped routine. The wrap-time hash stays in 20260907151000 so a later
-- unreviewed edit of that original inner source still fails closed.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '9d891c4ed2e2c858a394c72cad08c1d39bfed55eb3647d185a5e2361d3309b7b' then
    raise exception 'unreviewed record_dues_stripe_oauth_recovery_account predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.record_dues_stripe_oauth_recovery_account(
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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
      exchange_account_id = null,
      exchange_recorded_at = null,
      callback_state = 'attention_required',
      last_error_class = 'oauth_exchange_recovery_required',
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      reconcile_after = now()
  where state_hash = saved.state_hash;
end;
end;
$function$;

revoke all on function public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text)
  to service_role;

comment on function public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text) is
  'Service-only retention of a connected-account identifier before compensating provider deauthorization. The same UPDATE that stamps recovery_required_at clears the constrained legacy exchange_account_id / exchange_recorded_at pair so the row satisfies check (recovery_required_at is null or exchange_account_id is null).';

do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '44ba23ee48aa62bc48b6f8ba1f8bbaf17cea5edd86f4aafb410658541b88ade9' then
    raise exception 'record_dues_stripe_oauth_recovery_account source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
