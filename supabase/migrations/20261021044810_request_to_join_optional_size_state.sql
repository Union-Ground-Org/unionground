-- CONTENT-UG-JOIN-FORM-SALES-TONE-20261018: organization size and
-- state become optional on the public "Request to join" form, end to end.
-- A union leader making first contact is no longer made to pick both before
-- sending. When given, each must still be one of the existing values.
--
-- 1. The request-to-join row shape allows a null size_band and state (a
--    landing row still carries neither). Existing rows already satisfy it.
-- 2. public.submit_join_request is replaced with the same signature, grants,
--    service-role check, limits, suppression check and lock; the only change
--    is that an empty size or state is stored as null instead of refused.
--
-- Nothing else changes: no new column, grant, table or client access.

begin;

-- ------------------------------------------------- 1. the row shape

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_request_to_join_shape;

alter table public.public_interest_submissions
  add constraint public_interest_submissions_request_to_join_shape check (
    case
      when source = 'request-to-join' then
        interest = 'request_to_join'
        and locale = 'en'
        and organization_name is not null
        and char_length(organization_name) between 2 and 160
        and role in ('officer', 'staff', 'steward', 'member', 'other')
        and (size_band is null
          or size_band in ('under-100', '100-499', '500-1999', '2000-9999', '10000-plus'))
        and (state is null or state ~ '^[A-Z]{2}$' or state = 'outside-us')
        and (phone is null or char_length(phone) between 7 and 30)
        and (note is null or char_length(note) between 1 and 1000)
        and (campaign_code is null or campaign_code ~ '^[a-z0-9][a-z0-9-]{0,31}$')
      else
        interest <> 'request_to_join'
        and organization_name is null
        and role is null
        and size_band is null
        and state is null
        and phone is null
        and note is null
        and campaign_code is null
    end
  );

-- ------------------------------------------------- 2. the public write (service role only)

create or replace function public.submit_join_request(
  p_email text,
  p_organization_name text,
  p_role text,
  p_size_band text,
  p_state text,
  p_phone text,
  p_note text,
  p_campaign_code text,
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
  organization_name text := nullif(pg_catalog.btrim(coalesce(p_organization_name, '')), '');
  phone text := nullif(pg_catalog.btrim(coalesce(p_phone, '')), '');
  note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  campaign_code text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_campaign_code, ''))), '');
  -- Size and state are optional; an empty value is stored as null.
  size_band_value text := nullif(pg_catalog.btrim(coalesce(p_size_band, '')), '');
  state_value text := nullif(pg_catalog.btrim(coalesce(p_state, '')), '');
  moment timestamptz := clock_timestamp();
  derived_suppression_scope_hash text;
  network_allowed boolean;
  payload_invalid boolean;
  stored boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;

  -- Honeypot submissions receive the same answer without a row or a limit hit.
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true, 'stored', false);
  end if;

  network_allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 20, interval '15 minutes'
  );

  payload_invalid := char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or normalized_email ~ '[[:cntrl:]]'
    or organization_name is null
    or char_length(organization_name) not between 2 and 160
    or p_role is null or p_role not in ('officer', 'staff', 'steward', 'member', 'other')
    or (size_band_value is not null
      and size_band_value not in ('under-100', '100-499', '500-1999', '2000-9999', '10000-plus'))
    or (state_value is not null and state_value <> all (array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
      'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
      'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
      'VT','VA','WA','WV','WI','WY','AS','GU','MP','PR','VI','outside-us'
    ]::text[]))
    or (phone is not null and char_length(phone) not between 7 and 30)
    or (note is not null and char_length(note) > 1000)
    or (campaign_code is not null and campaign_code !~ '^[a-z0-9][a-z0-9-]{0,31}$');

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

      -- A stopped address stores nothing and learns nothing. A second request
      -- from the same address changes nothing: the first request stands and
      -- the operator answers it by email.
      if not exists (
        select 1
        from private.public_interest_suppressions as suppression
        where suppression.suppression_scope_hash = derived_suppression_scope_hash
      ) then
        insert into public.public_interest_submissions (
          email, name, interest, locale, source,
          organization_name, role, size_band, state, phone, note, campaign_code
        ) values (
          normalized_email, null, 'request_to_join', 'en', 'request-to-join',
          organization_name, p_role, size_band_value, state_value, phone, note, campaign_code
        )
        on conflict (email, interest) do nothing;
        stored := found;
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

  return pg_catalog.jsonb_build_object('accepted', true, 'stored', stored);
end;
$$;

revoke all on function public.submit_join_request(text, text, text, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_join_request(text, text, text, text, text, text, text, text, text, text, text)
  to service_role;

comment on function public.submit_join_request(text, text, text, text, text, text, text, text, text, text, text) is
  'Service-only request-to-join write: same durable limits, Vault-keyed suppression check and transaction lock as the landing form; one request per address; size and state optional (empty stored as null); uniform accepted answer, stored flag for the server only.';

notify pgrst, 'reload schema';

commit;
