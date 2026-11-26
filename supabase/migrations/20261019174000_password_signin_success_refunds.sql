-- BUG-UG-SIGNIN-THROTTLE-COUNTS-SUCCESSFUL-SIGNINS-20261018
-- Reserve before GoTrue so concurrent failures retain the existing caps.
-- A successful grant refunds only its own charge in each original window.
-- Existing consume callers and the password-verification hook are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.password_signin_reservations (
  id uuid primary key default gen_random_uuid(),
  network_hash text not null,
  email_hash text not null,
  network_window timestamptz not null,
  email_window timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index password_signin_reservations_created_idx
  on private.password_signin_reservations (created_at);
alter table private.password_signin_reservations enable row level security;
alter table private.password_signin_reservations force row level security;
revoke all on private.password_signin_reservations from public, anon, authenticated, service_role;

create function public.reserve_password_signin_attempt(p_email text, p_network text)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  key_secret bytea;
  network_digest text;
  email_digest text;
  reservation uuid;
begin
  -- Performs the existing role/input checks, limits, locking and pruning.
  if not public.consume_password_signin_attempt(p_email, p_network) then
    return '{"allowed":false}'::jsonb;
  end if;
  select secret into strict key_secret from private.auth_attempt_throttle_key where id;
  network_digest := pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(
    'password-signin-network:' || p_network, 'UTF8'), key_secret, 'sha256'), 'hex');
  email_digest := pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(
    'password-signin-email:' || pg_catalog.lower(pg_catalog.btrim(p_email)), 'UTF8'), key_secret, 'sha256'), 'hex');

  -- The two bucket locks acquired by consume stay held until this commits.
  insert into private.password_signin_reservations
    (network_hash, email_hash, network_window, email_window)
  select network_digest, email_digest, n.window_started_at, e.window_started_at
  from private.auth_attempt_throttle n, private.auth_attempt_throttle e
  where n.scope = 'password-signin-network' and n.key_hash = network_digest
    and e.scope = 'password-signin-email' and e.key_hash = email_digest
  returning id into strict reservation;

  -- Failed/abandoned reservations expire with their counters; bounded cleanup.
  delete from private.password_signin_reservations r where r.id in (
    select old.id from private.password_signin_reservations old
    where old.created_at < pg_catalog.clock_timestamp() - interval '2 days'
    limit 200 for update skip locked
  );
  return pg_catalog.jsonb_build_object('allowed', true, 'reservation', reservation);
end;
$function$;

create function public.refund_password_signin_attempt(p_reservation uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $function$
declare
  receipt private.password_signin_reservations%rowtype;
  bucket record;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  delete from private.password_signin_reservations where id = p_reservation
  returning * into receipt;
  if not found then return false; end if;

  -- Same lock order as consume. Deleting the receipt makes retries harmless.
  for bucket in select * from (values
    ('password-signin-network', receipt.network_hash, receipt.network_window, 1),
    ('password-signin-email', receipt.email_hash, receipt.email_window, 2)
  ) as buckets(scope, key_hash, window_started_at, ordinal) order by ordinal
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'auth-attempt-throttle:' || bucket.scope || ':' || bucket.key_hash, 509));
    -- Never refund a window opened after the reservation, even after pruning.
    delete from private.auth_attempt_throttle t
    where t.scope = bucket.scope and t.key_hash = bucket.key_hash
      and t.window_started_at = bucket.window_started_at and t.attempt_count = 1;
    update private.auth_attempt_throttle t set attempt_count = t.attempt_count - 1
    where t.scope = bucket.scope and t.key_hash = bucket.key_hash
      and t.window_started_at = bucket.window_started_at and t.attempt_count > 1;
  end loop;
  return true;
end;
$function$;

revoke all on function public.reserve_password_signin_attempt(text, text) from public, anon, authenticated, service_role;
revoke all on function public.refund_password_signin_attempt(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_password_signin_attempt(text, text) to service_role;
grant execute on function public.refund_password_signin_attempt(uuid) to service_role;
comment on table private.password_signin_reservations is
  'One-use password throttle refunds. Only keyed digests and original window timestamps; no addresses or credentials. Unrefunded rows pruned after two days, at most 200 per allowed reservation.';
comment on function public.reserve_password_signin_attempt(text, text) is
  'Service-only reservation using the unchanged password network/address caps. Returns a one-use refund id only when both buckets admit the attempt.';
comment on function public.refund_password_signin_attempt(uuid) is
  'Service-only refund after a successful password grant. Idempotent and bound to both original windows; never clears previous failures or the Auth hook lockout.';
commit;
