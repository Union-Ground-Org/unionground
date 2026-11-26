-- SEC-UG-PUBLIC-INTEREST-ABUSE-20260813 Fable follow-up: replace the
-- stable unsalted email-interest digest with a server-keyed HMAC, prune stale
-- limiter rows, and keep the RPC service-only. The API separately normalizes
-- IPv6 privacy addresses to /64 before producing p_scope_hash.

create index public_interest_submission_limits_window_idx
  on private.public_interest_submission_limits (window_started_at);

-- The intermediate unkeyed service overload is not used by either deployed
-- browser generation. Remove it if a partial environment ever created it,
-- while retaining the six-argument compatibility shim until the separate
-- post-deploy contract migration.
drop function if exists public.submit_public_interest(text, text, text, text, text, text, text);

create function public.submit_public_interest(
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

  -- The same-origin endpoint rejects honeypots before invoking this RPC. Keep
  -- the database check ahead of maintenance as defense in depth so even a
  -- service-role caller cannot turn honeypot traffic into cleanup work.
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
      insert into public.public_interest_submissions (
        email, name, interest, locale, source
      ) values (
        normalized_email, normalized_name, p_interest, p_locale, p_source
      )
      on conflict (email, interest) do nothing;
    end if;
  end if;

  -- Both limiter windows are at most one day, so rows older than two days can
  -- never affect a current decision. Make this the transaction's final
  -- lock-taking statement: SKIP LOCKED keeps pruning non-waiting, and no later
  -- limiter or submission lock can form a cycle with the rows deleted here.
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
  'Service-only public-interest write with keyed scopes, bounded durable limits, uniform responses, and non-mutating duplicates.';
