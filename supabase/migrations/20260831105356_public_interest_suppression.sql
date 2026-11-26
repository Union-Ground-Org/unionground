-- FIX-UG-PUBLIC-LEGAL-ACCURACY-20260816: retain a durable, global stop
-- record for public-interest email. Both submit and stop take the same
-- transaction lock, so a concurrent or later anonymous submit cannot recreate
-- a row after the stop commits. The stop record intentionally retains only a
-- project-local Vault-keyed HMAC and the minimum audit fields needed to honor
-- that choice. The key never enters the browser, Vercel environment,
-- application tables, a plaintext backup dump, or a caller-supplied RPC
-- argument.

alter table private.public_interest_submission_limits
  drop constraint public_interest_submission_limits_operation_check;

alter table private.public_interest_submission_limits
  add constraint public_interest_submission_limits_operation_check
  check (operation in (
    'network-15m',
    'email-interest-day',
    'stop-network-15m',
    'stop-email-day'
  ));

create or replace function private.consume_public_interest_submission_limit(
  p_scope_hash text,
  p_operation text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row private.public_interest_submission_limits%rowtype;
  moment timestamptz := clock_timestamp();
begin
  if p_scope_hash is null
     or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_operation not in (
       'network-15m',
       'email-interest-day',
       'stop-network-15m',
       'stop-email-day'
     )
     or p_limit < 1
     or p_window <= interval '0 seconds' then
    raise exception 'invalid public interest rate limit' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-interest-rate:' || p_operation || ':' || p_scope_hash,
      509
    )
  );

  select * into current_row
  from private.public_interest_submission_limits
  where scope_hash = p_scope_hash and operation = p_operation
  for update;

  if not found then
    insert into private.public_interest_submission_limits
      (scope_hash, operation, window_started_at, request_count)
    values (p_scope_hash, p_operation, moment, 1);
    return true;
  end if;

  if current_row.window_started_at + p_window <= moment then
    update private.public_interest_submission_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash and operation = p_operation;
    return true;
  end if;

  if current_row.request_count >= p_limit then
    return false;
  end if;

  update private.public_interest_submission_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash and operation = p_operation;
  return true;
end;
$$;

revoke all on function private.consume_public_interest_submission_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

create table private.public_interest_suppressions (
  suppression_scope_hash text primary key check (suppression_scope_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (source = 'public-landing'),
  locale text not null check (locale in ('en', 'es')),
  created_at timestamptz not null default now(),
  last_requested_at timestamptz not null default now()
);

alter table private.public_interest_suppressions enable row level security;

revoke all on private.public_interest_suppressions
  from public, anon, authenticated, service_role;

comment on table private.public_interest_suppressions is
  'Private global public-interest suppression ledger keyed by a Vault-backed HMAC; no raw email or browser-role access.';

-- A random project-local key gives each production or SAMPLE database its own
-- opaque suppression namespace. Vault persists it encrypted, including in
-- backups, while this migration records only the stable name. The guard is
-- idempotent for local contract proof and restore tooling.
do $$
begin
  if not exists (
    select 1
    from vault.secrets
    where name = 'public-interest-suppression-v1'
  ) then
    perform vault.create_secret(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'hex'),
      'public-interest-suppression-v1',
      'Project-local HMAC key for the private public-interest suppression ledger.'
    );
  end if;
end;
$$;

create function private.public_interest_suppression_scope(p_email text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  suppression_secret text;
begin
  select secret.decrypted_secret into suppression_secret
  from vault.decrypted_secrets secret
  where secret.name = 'public-interest-suppression-v1'
  limit 1;

  if coalesce(pg_catalog.char_length(suppression_secret), 0) < 32 then
    raise exception 'public interest suppression secret unavailable' using errcode = '55000';
  end if;

  return pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to('public-interest-suppression-v1:' || normalized_email, 'UTF8'),
      pg_catalog.convert_to(suppression_secret, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
end;
$$;

revoke all on function private.public_interest_suppression_scope(text)
  from public, anon, authenticated, service_role;

comment on function private.public_interest_suppression_scope(text) is
  'Database-only Vault-keyed HMAC for the private public-interest suppression ledger.';

-- Expand/deploy compatibility: this is the exact eight-argument signature
-- used by the already deployed public-interest endpoint. Keep the digest
-- derivation inside PostgreSQL rather than adding a caller-supplied overload,
-- so old/new revisions and rollback all retain a recorded stop.
create or replace function public.submit_public_interest(
  p_email text,
  p_name text,
  p_interest text,
  p_locale text,
  p_source text,
  p_website text,
  p_scope_hash text,
  p_email_scope_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  moment timestamptz := clock_timestamp();
  derived_suppression_scope_hash text;
  network_allowed boolean;
  payload_invalid boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;

  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;

  network_allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 20, interval '15 minutes'
  );

  payload_invalid := char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or (normalized_name is not null and char_length(normalized_name) > 100)
    or p_interest is null or p_interest not in ('chapter_updates', 'public_meetings', 'union_news')
    or p_locale is null or p_locale not in ('en', 'es')
    or p_source is distinct from 'public-landing';

  if network_allowed and not payload_invalid then
    if private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'email-interest-day', 3, interval '1 day'
    ) then
      derived_suppression_scope_hash := private.public_interest_suppression_scope(normalized_email);
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'public-interest-suppression:' || derived_suppression_scope_hash,
          509
        )
      );

      if not exists (
        select 1
        from private.public_interest_suppressions as suppression
        where suppression.suppression_scope_hash = derived_suppression_scope_hash
      ) then
        insert into public.public_interest_submissions (
          email, name, interest, locale, source
        ) values (
          normalized_email, normalized_name, p_interest, p_locale, p_source
        )
        on conflict (email, interest) do nothing;
      end if;
    end if;
  end if;

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

  return pg_catalog.jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.submit_public_interest(text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_public_interest(text, text, text, text, text, text, text, text)
  to service_role;

comment on function public.submit_public_interest(text, text, text, text, text, text, text, text) is
  'Service-only public-interest write with Vault-keyed global suppression, durable limits, uniform responses, and non-mutating duplicates.';

create function public.stop_public_interest(
  p_email text,
  p_locale text,
  p_source text,
  p_website text,
  p_scope_hash text,
  p_email_scope_hash text
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
  derived_suppression_scope_hash text;
  network_allowed boolean;
  email_allowed boolean := false;
  payload_invalid boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;

  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true);
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
    derived_suppression_scope_hash := private.public_interest_suppression_scope(normalized_email);
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'public-interest-suppression:' || derived_suppression_scope_hash,
        509
      )
    );

    insert into private.public_interest_suppressions (
      suppression_scope_hash, source, locale, created_at, last_requested_at
    ) values (
      derived_suppression_scope_hash, p_source, p_locale, moment, moment
    )
    on conflict (suppression_scope_hash) do update
    set last_requested_at = excluded.last_requested_at;

    delete from public.public_interest_submissions
    where email = normalized_email;
  end if;

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
    'accepted', network_allowed and email_allowed and not payload_invalid
  );
end;
$$;

revoke all on function public.stop_public_interest(text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.stop_public_interest(text, text, text, text, text, text)
  to service_role;

comment on function public.stop_public_interest(text, text, text, text, text, text) is
  'Service-only same-origin stop boundary that atomically writes a Vault-keyed suppression record and removes all public-interest subscriptions for an email address.';

-- Explicitly remove the experimental overloads that accepted the suppression
-- digest from an application caller. They were never part of the deployed
-- contract, but a resilient migration must also repair an interrupted preview
-- or local database where one was created before the Vault-keyed design landed.
drop function if exists public.submit_public_interest(text, text, text, text, text, text, text, text, text);
drop function if exists public.stop_public_interest(text, text, text, text, text, text, text);

notify pgrst, 'reload schema';
