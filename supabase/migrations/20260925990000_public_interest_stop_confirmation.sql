-- SEC-UG-PUBLIC-INTEREST-SUPPRESSION-CONFIRMATION-20260921:
-- public.stop_public_interest suppressed an address the moment the public
-- landing form posted it, so anyone who knew an address could silence it.
-- (PLAN.md section 13), SINGLE-USE EMAIL CONFIRMATION:
--   * a public "stop contacting me" request takes effect only after the
--     requester opens a single-use, time-limited (24 h) confirmation link sent
--     to the submitted address;
--   * until then nothing is suppressed: the request path never touches the
--     suppression ledger or the subscription rows;
--   * public responses stay non-enumerating: the same response whether or not
--     the address exists, and one refusal payload for an unknown, expired or
--     already-used token.
-- The pending row keeps the normalized address for at most 24 hours because
-- the confirmation must still remove the address's subscriptions, and the
-- ledger itself stays HMAC-only: the confirm step derives the Vault-keyed
-- digest inside PostgreSQL exactly as the immediate stop function does. The
-- token reaches PostgreSQL only as its SHA-256 digest; the serverless boundary
-- generates the secret, emails the link and never stores it.
-- public.stop_public_interest is kept unchanged as the operator-verified path
-- the public endpoint no
-- longer calls it.

begin;

set local lock_timeout = '5s';

-- ------------------------------------------------- 1. the pending confirmation
--
-- One row per emailed link. It exists from the request until the link is used
-- (the row is deleted inside the confirmation) or until it expires (pruned by
-- the two functions below, bounded per call). Definer-only: no client role can
-- read which addresses asked to stop.
create table private.public_interest_stop_confirmations (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  normalized_email text not null check (
    char_length(normalized_email) <= 254
    and normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  locale text not null check (locale in ('en', 'es')),
  source text not null check (source = 'public-landing'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint public_interest_stop_confirmations_window_check check (expires_at > created_at)
);

alter table private.public_interest_stop_confirmations enable row level security;
alter table private.public_interest_stop_confirmations force row level security;
revoke all on table private.public_interest_stop_confirmations from public, anon, authenticated, service_role;

create index public_interest_stop_confirmations_expires_idx
  on private.public_interest_stop_confirmations (expires_at);

comment on table private.public_interest_stop_confirmations is
  'Pending public-interest stop confirmations: one SHA-256 token digest per emailed single-use link, the normalized address it must suppress, and a 24-hour expiry. Deleted on confirmation or pruned after expiry; no browser-role access.';

-- ------------------------------------------------- 2. the request (no suppression)
--
-- Same service-only boundary, honeypot, rate scopes and payload rules as
-- public.stop_public_interest, but the only write is the pending row. The
-- returned payload does not depend on whether the address is subscribed or
-- already suppressed.
create function public.request_public_interest_stop(
  p_email text,
  p_locale text,
  p_source text,
  p_website text,
  p_scope_hash text,
  p_email_scope_hash text,
  p_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
  email_allowed boolean := false;
  payload_invalid boolean;
  pending boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid confirmation token digest' using errcode = '22023';
  end if;

  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true, 'pending', false);
  end if;

  network_allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'stop-network-15m', 20, interval '15 minutes'
  );
  if network_allowed then
    email_allowed := private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'stop-email-day', 3, interval '1 day'
    );
  end if;

  payload_invalid := char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or p_locale is null or p_locale not in ('en', 'es')
    or p_source is distinct from 'public-landing';

  if network_allowed and email_allowed and not payload_invalid then
    insert into private.public_interest_stop_confirmations (
      token_hash, normalized_email, locale, source, created_at, expires_at
    ) values (
      p_token_hash, normalized_email, p_locale, p_source, moment, moment + interval '24 hours'
    );
    pending := true;
  end if;

  delete from private.public_interest_stop_confirmations as stale
  where stale.token_hash in (
    select candidate.token_hash
    from private.public_interest_stop_confirmations as candidate
    where candidate.expires_at < moment
      and candidate.token_hash <> p_token_hash
    order by candidate.expires_at
    limit 200
    for update skip locked
  );

  delete from private.public_interest_submission_limits as stale
  where stale.ctid in (
    select candidate.ctid
    from private.public_interest_submission_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  );

  return pg_catalog.jsonb_build_object(
    'accepted', network_allowed and email_allowed and not payload_invalid,
    'pending', pending
  );
end;
$$;

revoke all on function public.request_public_interest_stop(text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.request_public_interest_stop(text, text, text, text, text, text, text)
  to service_role;

comment on function public.request_public_interest_stop(text, text, text, text, text, text, text) is
  'Service-only same-origin stop REQUEST: records one pending single-use confirmation (24 h) keyed by the SHA-256 digest of the emailed token and suppresses nothing. Same limits and uniform response as the immediate stop function.';

-- ------------------------------------------------- 3. the confirmation (suppresses)
--
-- The digest of the clicked token selects the pending row under a row lock;
-- an unknown, expired or already-used digest returns the same refusal. A
-- successful confirmation performs exactly what public.stop_public_interest
-- performs (ledger upsert under the suppression advisory lock, subscription
-- removal) and then deletes every pending row for that address so no raw
-- address outlives its purpose.
create function public.confirm_public_interest_stop(
  p_token_hash text,
  p_scope_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  moment timestamptz := clock_timestamp();
  pending_row private.public_interest_stop_confirmations%rowtype;
  derived_suppression_scope_hash text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;

  if not private.consume_public_interest_submission_limit(
    p_scope_hash, 'stop-network-15m', 20, interval '15 minutes'
  ) then
    return pg_catalog.jsonb_build_object('confirmed', false, 'refusal', 'rate-limited');
  end if;

  delete from private.public_interest_stop_confirmations as stale
  where stale.token_hash in (
    select candidate.token_hash
    from private.public_interest_stop_confirmations as candidate
    where candidate.expires_at < moment
      and candidate.token_hash <> clean_hash
    order by candidate.expires_at
    limit 200
    for update skip locked
  );

  if clean_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('confirmed', false, 'refusal', 'unavailable');
  end if;

  select * into pending_row
  from private.public_interest_stop_confirmations
  where token_hash = clean_hash
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('confirmed', false, 'refusal', 'unavailable');
  end if;
  if pending_row.expires_at <= moment then
    delete from private.public_interest_stop_confirmations where token_hash = clean_hash;
    return pg_catalog.jsonb_build_object('confirmed', false, 'refusal', 'unavailable');
  end if;

  derived_suppression_scope_hash := private.public_interest_suppression_scope(pending_row.normalized_email);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-interest-suppression:' || derived_suppression_scope_hash,
      509
    )
  );

  insert into private.public_interest_suppressions (
    suppression_scope_hash, source, locale, created_at, last_requested_at
  ) values (
    derived_suppression_scope_hash, pending_row.source, pending_row.locale, moment, moment
  )
  on conflict (suppression_scope_hash) do update
  set last_requested_at = excluded.last_requested_at;

  delete from public.public_interest_submissions
  where email = pending_row.normalized_email;

  delete from private.public_interest_stop_confirmations
  where normalized_email = pending_row.normalized_email;

  return pg_catalog.jsonb_build_object('confirmed', true);
end;
$$;

revoke all on function public.confirm_public_interest_stop(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.confirm_public_interest_stop(text, text)
  to service_role;

comment on function public.confirm_public_interest_stop(text, text) is
  'Service-only stop CONFIRMATION: the SHA-256 digest of a clicked single-use link selects its pending row; unknown, expired and already-used digests share one refusal. On success it writes the Vault-keyed suppression, removes the address''s public-interest subscriptions and deletes every pending row for that address.';

notify pgrst, 'reload schema';

commit;
