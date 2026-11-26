-- REQ-UG-REQUEST-TO-JOIN-PAGE-20261017: the public "Request to join"
-- page (project decisions of October 17, 2026: free pilot, invitation only,
-- English only, call to action "request to join").
--
-- An officer or staff lead of a labor organization asks for an invitation to
-- Union Ground. The request lands in the existing landing table
-- public.public_interest_submissions as a new row shape (source
-- 'request-to-join', interest 'request_to_join') so that every existing
-- protection keeps applying without a second copy of it:
--   * the Vault-keyed suppression ledger is checked before the write and a
--     confirmed stop (public.confirm_public_interest_stop) deletes the request
--     row with every other row for that address;
--   * the same durable limiter buckets ('network-15m', 'email-interest-day')
--     bound the write; the day bucket is keyed by email and interest, so the
--     landing form's own allowance is untouched;
--   * the row keeps organization_id NULL, so the tenant-scoped reader
--     public.list_public_interest_leads never returns it to any organization.
--
-- Nothing here opens signup: a stored request grants nothing, and an invitation
-- is still sent by the operator (scripts/invite-organization-founder.mjs).
--
-- Owner read path: today a NULL-organization lead is readable by no tenant and
-- the only staff read path is tenant-scoped. The two service-role functions
-- below are the owner's read and status path (scripts/join-requests.mjs,
-- the operator runbook). Every list and every status change
-- writes one row to private.join_request_access_events.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------- 1. the request-to-join row shape

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_interest_check;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_interest_check
  check (interest in ('chapter_updates', 'public_meetings', 'union_news', 'request_to_join'));

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_source_check;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_source_check
  check (source in ('public-landing', 'request-to-join'));

alter table public.public_interest_submissions
  add column organization_name text,
  add column role text,
  add column size_band text,
  add column state text,
  add column phone text,
  add column note text,
  add column campaign_code text;

-- A request-to-join row carries the organization fields; a landing row never
-- does. The campaign code is a short, non-identifying token taken from the
-- link the requester followed (no analytics, no UTM parsing).
alter table public.public_interest_submissions
  add constraint public_interest_submissions_request_to_join_shape check (
    case
      when source = 'request-to-join' then
        interest = 'request_to_join'
        and locale = 'en'
        and organization_name is not null
        and char_length(organization_name) between 2 and 160
        and role in ('officer', 'staff', 'steward', 'member', 'other')
        and size_band in ('under-100', '100-499', '500-1999', '2000-9999', '10000-plus')
        and (state ~ '^[A-Z]{2}$' or state = 'outside-us')
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

comment on column public.public_interest_submissions.organization_name is
  'Request to join only: the organization the requester typed. Never a claim about any affiliation of the operator.';
comment on column public.public_interest_submissions.campaign_code is
  'Request to join only: short non-identifying campaign token from the followed link; no analytics or UTM parsing.';

-- ------------------------------------------------- 2. the owner access ledger

create table private.join_request_access_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.now(),
  actor text not null check (char_length(actor) between 2 and 80),
  action text not null check (action in ('list', 'status')),
  status_filter text check (status_filter is null or status_filter in ('new', 'contacted', 'closed')),
  row_count integer check (row_count is null or row_count >= 0),
  request_id uuid,
  from_status text check (from_status is null or from_status in ('new', 'contacted', 'closed')),
  to_status text check (to_status is null or to_status in ('new', 'contacted', 'closed')),
  constraint join_request_access_events_shape check (
    (action = 'list'
      and row_count is not null
      and request_id is null and from_status is null and to_status is null)
    or
    (action = 'status'
      and request_id is not null and from_status is not null and to_status is not null
      and row_count is null and status_filter is null)
  )
);

alter table private.join_request_access_events enable row level security;
alter table private.join_request_access_events force row level security;
revoke all on private.join_request_access_events from public, anon, authenticated, service_role;

comment on table private.join_request_access_events is
  'Audit of every owner list and status change of request-to-join rows. Written only by the two service-role functions; no client grant.';

-- ------------------------------------------------- 3. the public write (service role only)

create function public.submit_join_request(
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
    or p_size_band is null
    or p_size_band not in ('under-100', '100-499', '500-1999', '2000-9999', '10000-plus')
    or p_state is null
    or p_state <> all (array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
      'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
      'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
      'VT','VA','WA','WV','WI','WY','AS','GU','MP','PR','VI','outside-us'
    ]::text[])
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
          organization_name, p_role, p_size_band, p_state, phone, note, campaign_code
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
  'Service-only request-to-join write: same durable limits, Vault-keyed suppression check and transaction lock as the landing form; one request per address; uniform accepted answer, stored flag for the server only.';

-- ------------------------------------------------- 4. the owner read and status path (service role only)

-- Pages of at most 500, newest first, ordered by (last_submitted_at desc, id).
-- The keyset cursor is the last row of the previous page, both parts: pass its
-- cursorSubmittedAt and cursorId to read the older page, so a queue larger
-- than one page stays reachable through the owner's command and rows that
-- share a timestamp at a page boundary are never skipped.
create function public.list_join_requests(p_status text, p_actor text, p_before timestamptz, p_before_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := nullif(pg_catalog.btrim(coalesce(p_actor, '')), '');
  wanted text := nullif(pg_catalog.btrim(coalesce(p_status, '')), '');
  requests_json jsonb;
  fetched integer;
  total integer;
  has_more boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if actor is null or char_length(actor) not between 2 and 80 then
    raise exception 'actor required' using errcode = '22023';
  end if;
  if wanted is not null and wanted not in ('new', 'contacted', 'closed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'cursor needs both parts' using errcode = '22023';
  end if;

  -- One statement, one snapshot: the page, its last-row cursor and whether an
  -- older page exists all come from these 501 rows, so a concurrent deletion
  -- between statements cannot move the cursor past an unread request.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', request.id,
      'email', request.email,
      'organizationName', request.organization_name,
      'role', request.role,
      'sizeBand', request.size_band,
      'state', request.state,
      'phone', request.phone,
      'note', request.note,
      'campaignCode', request.campaign_code,
      'status', request.status,
      'consentAt', request.consent_at,
      'lastSubmittedAt', request.last_submitted_at,
      'createdAt', request.created_at
    ) order by request.last_submitted_at desc, request.id), '[]'::jsonb)
  into requests_json
  from (
    select s.*
    from public.public_interest_submissions s
    where s.source = 'request-to-join'
      and (wanted is null or s.status = wanted)
      and (p_before is null
        or s.last_submitted_at < p_before
        or (s.last_submitted_at = p_before and s.id > p_before_id))
    order by s.last_submitted_at desc, s.id
    limit 501
  ) request;

  fetched := pg_catalog.jsonb_array_length(requests_json);
  has_more := fetched > 500;
  if has_more then
    requests_json := requests_json - 500;
  end if;
  total := pg_catalog.jsonb_array_length(requests_json);

  insert into private.join_request_access_events (actor, action, status_filter, row_count)
  values (actor, 'list', wanted, total);

  -- The page's last row in page order is the cursor for the next page.
  return pg_catalog.jsonb_build_object(
    'status', wanted,
    'rowCount', total,
    'requests', requests_json,
    'hasMore', has_more,
    'cursorSubmittedAt', case when total > 0 then requests_json -> (total - 1) -> 'lastSubmittedAt' end,
    'cursorId', case when total > 0 then requests_json -> (total - 1) -> 'id' end
  );
end;
$$;

revoke all on function public.list_join_requests(text, text, timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_join_requests(text, text, timestamptz, uuid) to service_role;

comment on function public.list_join_requests(text, text, timestamptz, uuid) is
  'Service-only owner read of request-to-join rows: one page of at most 500 ordered by (last_submitted_at desc, id), optional status filter, two-part keyset cursor. Writes one join_request_access_events row per call.';

create function public.set_join_request_status(p_id uuid, p_status text, p_actor text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor text := nullif(pg_catalog.btrim(coalesce(p_actor, '')), '');
  current_row public.public_interest_submissions%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if actor is null or char_length(actor) not between 2 and 80 then
    raise exception 'actor required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('new', 'contacted', 'closed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_id is null then
    raise exception 'request id required' using errcode = '22023';
  end if;

  select * into current_row
  from public.public_interest_submissions
  where id = p_id and source = 'request-to-join'
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'not-found');
  end if;
  if current_row.status = p_status then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'unchanged', 'status', current_row.status);
  end if;

  update public.public_interest_submissions
  set status = p_status
  where id = p_id;

  insert into private.join_request_access_events (actor, action, request_id, from_status, to_status)
  values (actor, 'status', p_id, current_row.status, p_status);

  return pg_catalog.jsonb_build_object('updated', true, 'id', p_id, 'from', current_row.status, 'status', p_status);
end;
$$;

revoke all on function public.set_join_request_status(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_join_request_status(uuid, text, text) to service_role;

comment on function public.set_join_request_status(uuid, text, text) is
  'Service-only owner status change of one request-to-join row (new, contacted, closed) under a row lock. Writes one join_request_access_events row per change.';

notify pgrst, 'reload schema';

commit;
