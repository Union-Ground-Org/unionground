-- SEC-UG-PUBLIC-INTEREST-ABUSE-20260813: move the anonymous contact
-- write behind a same-origin server seam. The server supplies only an opaque
-- HMAC network bucket; neither a raw network address nor an extra copy of the
-- submitted email is retained in the limiter.

create table private.public_interest_submission_limits (
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('network-15m', 'email-interest-day')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope_hash, operation)
);

revoke all on private.public_interest_submission_limits
  from public, anon, authenticated, service_role;

create function private.consume_public_interest_submission_limit(
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
     or p_operation not in ('network-15m', 'email-interest-day')
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

-- Expand phase: atomically harden the legacy signature without removing it.
-- Already-open browser bundles still call this overload directly, so it must
-- remain available until the same-origin API bundle has deployed and aged
-- through its grace window. A later contract migration removes it.
create or replace function public.submit_public_interest(
  p_email text,
  p_name text,
  p_interest text,
  p_locale text,
  p_source text,
  p_website text
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
  legacy_scope_hash text := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to('public-interest-legacy-global-v1', 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  email_scope_hash text;
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
  payload_invalid boolean;
begin
  -- Keep automated trap traffic out of both the queue and limiter table.
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;

  -- The database cannot recover a trustworthy caller network for this legacy
  -- anonymous overload. Use one deliberately coarse transitional bucket so
  -- stale clients remain usable while anonymous row growth is bounded.
  network_allowed := private.consume_public_interest_submission_limit(
    legacy_scope_hash, 'network-15m', 60, interval '15 minutes'
  );

  payload_invalid := char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or (normalized_name is not null and char_length(normalized_name) > 100)
    or p_interest is null or p_interest not in ('chapter_updates', 'public_meetings', 'union_news')
    or p_locale is null or p_locale not in ('en', 'es')
    or p_source is distinct from 'public-landing';

  if network_allowed and not payload_invalid then
    email_scope_hash := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          normalized_email || pg_catalog.chr(31) || p_interest,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    if private.consume_public_interest_submission_limit(
      email_scope_hash, 'email-interest-day', 3, interval '1 day'
    ) then
      -- Existing consent and workflow state belong to the prior submitter. An
      -- anonymous retry gets the same response but cannot rewrite or reopen it.
      insert into public.public_interest_submissions (
        email, name, interest, locale, source
      ) values (
        normalized_email, normalized_name, p_interest, p_locale, p_source
      )
      on conflict (email, interest) do nothing;
    end if;
  end if;

  -- Once the network bucket has been touched, every outcome reaches the same
  -- bounded terminal cleanup. No later lock acquisition can form a cycle.
  delete from private.public_interest_submission_limits as stale
  where stale.ctid in (
    select candidate.ctid
    from private.public_interest_submission_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash <> legacy_scope_hash
      and (email_scope_hash is null or candidate.scope_hash <> email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  );

  return pg_catalog.jsonb_build_object('accepted', true);
end;
$$;

revoke all on function public.submit_public_interest(text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_public_interest(text, text, text, text, text, text)
  to anon, authenticated, service_role;

comment on table private.public_interest_submission_limits is
  'Opaque durable rate buckets for the same-origin public-interest submission seam.';
comment on function public.submit_public_interest(text, text, text, text, text, text) is
  'Transitional anonymous public-interest compatibility shim: global and per-intent limits, uniform response, and non-mutating duplicates; remove after the service seam grace window.';
