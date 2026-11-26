-- REQ-UG-MEMBER-ASKS-THEIR-UNION-TO-JOIN-20261118
--
-- Request, November 18, 2026: a member whose union is not on Union Ground has
-- no way to ask for it. The public page /ask-your-union takes that request.
--
-- 1. The request is a fourth row shape in public.public_interest_submissions
--    (source 'ask-your-union', interest 'ask_your_union'), written only by the
--    service-only public.submit_ask_your_union_request behind the same durable
--    limits, Vault-keyed suppression check and lock as the join and invite
--    requests. A confirmed stop already deletes every row for the address, so
--    it deletes these too. The shape holds organization_id NULL, so no tenant
--    reader returns one.
-- 2. Three columns carry what only this shape has: the catalog key of a union
--    picked in the directory, the line the member typed about whom at the
--    union should hear of it, and whether the member allows their name to be
--    mentioned. The contact line is read by a person; nothing mails it.
-- 3. The platform operator's intake queue (20261118160000) gains the kind
--    'union': the three queue helpers name it, so list, export, status and
--    note reach these rows, and the summary counts them per day and per
--    union. The per-union counts carry a campaign code and a catalog key
--    only, never a name or an address, so the summary stays counts only.
--    List and export also take a whole campaign code as the search text,
--    so the code the summary shows finds exactly that union's requests.
--
-- Nothing here opens signup or creates an account, organization or
-- invitation, and nothing here sends mail.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------- 1. the row shape

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_interest_check;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_interest_check
  check (interest in ('chapter_updates', 'public_meetings', 'union_news', 'request_to_join', 'request_invite', 'ask_your_union'));

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_source_check;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_source_check
  check (source in ('public-landing', 'request-to-join', 'request-invite', 'ask-your-union'));

alter table public.public_interest_submissions
  add column union_catalog_key text,
  add column union_contact text,
  add column share_name boolean;

comment on column public.public_interest_submissions.union_catalog_key is
  'Ask your union only: the public catalog key of the union the member picked in the directory, checked against the live catalog when stored; NULL when the name was typed.';
comment on column public.public_interest_submissions.union_contact is
  'Ask your union only: the line the member typed about whom at the union should hear of the request. Read by a person; never mailed automatically.';
comment on column public.public_interest_submissions.share_name is
  'Ask your union only: whether the member allows Union Ground to mention their name to the union. False unless the member turned it on.';
comment on column public.public_interest_submissions.organization_name is
  'Request to join, request an invite or ask your union: the organization the requester typed or picked. Never a claim about any affiliation of the operator.';
comment on column public.public_interest_submissions.campaign_code is
  'Request to join: short non-identifying campaign token from the followed link; no analytics or UTM parsing. Ask your union: the server-derived code that groups the requests for one union.';

-- One shape per source. The three ask-your-union columns are NULL everywhere else.
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
        and union_catalog_key is null
        and union_contact is null
        and share_name is null
      when source = 'request-invite' then
        interest = 'request_invite'
        and name is not null
        and char_length(name) between 2 and 120
        and organization_name is not null
        and char_length(organization_name) between 2 and 160
        and (note is null or char_length(note) between 1 and 1000)
        and role is null
        and size_band is null
        and state is null
        and phone is null
        and campaign_code is null
        and union_catalog_key is null
        and union_contact is null
        and share_name is null
      when source = 'ask-your-union' then
        interest = 'ask_your_union'
        -- Union Ground's own lead, never an organization's: the tenant reader
        -- matches on organization_id, so it can never return one.
        and organization_id is null
        and name is not null
        and char_length(name) between 2 and 120
        and organization_name is not null
        and char_length(organization_name) between 2 and 160
        and (union_catalog_key is null or union_catalog_key ~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$')
        and (union_contact is null or char_length(union_contact) between 1 and 300)
        and share_name is not null
        and (note is null or char_length(note) between 1 and 1000)
        and campaign_code is not null
        and campaign_code ~ '^m-[a-z0-9][a-z0-9-]{0,29}$'
        and role is null
        and size_band is null
        and state is null
        and phone is null
      else
        interest not in ('request_to_join', 'request_invite', 'ask_your_union')
        and organization_name is null
        and role is null
        and size_band is null
        and state is null
        and phone is null
        and note is null
        and campaign_code is null
        and union_catalog_key is null
        and union_contact is null
        and share_name is null
    end
  );

-- The per-union count reads the requests for one campaign code.
create index public_interest_submissions_ask_your_union_code_idx
  on public.public_interest_submissions (campaign_code)
  where source = 'ask-your-union' and organization_id is null;

-- The operator's ledger records a list or export filtered to the new kind.
alter table private.intake_review_events
  drop constraint intake_review_events_kind_filter_check;
alter table private.intake_review_events
  add constraint intake_review_events_kind_filter_check
  check (kind_filter is null or kind_filter in ('updates', 'join', 'invite', 'union'));

-- ------------------------------------------------- 2. the ask-your-union write (service role only)

create function public.submit_ask_your_union_request(
  p_email text,
  p_name text,
  p_union_name text,
  p_union_catalog_key text,
  p_union_contact text,
  p_note text,
  p_share_name boolean,
  p_locale text,
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
  requester_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  union_name text := nullif(pg_catalog.btrim(coalesce(p_union_name, '')), '');
  catalog_key text := nullif(pg_catalog.btrim(coalesce(p_union_catalog_key, '')), '');
  contact_line text := nullif(pg_catalog.btrim(coalesce(p_union_contact, '')), '');
  note text := nullif(pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(coalesce(p_note, ''), pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)), pg_catalog.chr(13), pg_catalog.chr(10))), '');
  code text := nullif(pg_catalog.btrim(coalesce(p_campaign_code, '')), '');
  locale_value text := case when p_locale = 'es' then 'es' else 'en' end;
  moment timestamptz := clock_timestamp();
  derived_suppression_scope_hash text;
  network_allowed boolean;
  payload_invalid boolean;
  stored boolean := false;
  notify boolean := false;
  union_request_count integer;
  catalog_profile jsonb;
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
    return pg_catalog.jsonb_build_object('accepted', true, 'stored', false, 'notify', false);
  end if;

  network_allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 20, interval '15 minutes'
  );

  payload_invalid := char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or normalized_email ~ '[[:cntrl:]]'
    or requester_name is null
    or char_length(requester_name) not between 2 and 120
    or requester_name ~ '[[:cntrl:]]'
    or union_name is null
    or char_length(union_name) not between 2 and 160
    or union_name ~ '[[:cntrl:]]'
    or (catalog_key is not null and catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$')
    or (contact_line is not null and (char_length(contact_line) > 300 or contact_line ~ '[[:cntrl:]]'))
    or (note is not null and (char_length(note) > 1000
      or pg_catalog.translate(note, pg_catalog.chr(10), '') ~ '[[:cntrl:]]'))
    or p_share_name is null
    or code is null
    or code !~ '^m-[a-z0-9][a-z0-9-]{0,29}$';

  -- A union picked in the directory must be a live directory entry, and the
  -- name stored for it is the directory's own, never the one the browser
  -- sent: a request cannot attach another name to a real entry, or a key
  -- that names nothing. The public profile read applies the catalog's own
  -- rules (retired and duplicate entries and an inactive release are unknown).
  if network_allowed and not payload_invalid and catalog_key is not null then
    catalog_profile := public.get_union_catalog_profile(catalog_key);
    if (catalog_profile ->> 'found') is distinct from 'true'
       or (catalog_profile #>> '{organization,key}') is distinct from catalog_key then
      payload_invalid := true;
    else
      union_name := nullif(pg_catalog.btrim(pg_catalog.left(
        pg_catalog.btrim(coalesce(catalog_profile #>> '{organization,name}', '')), 160)), '');
      payload_invalid := union_name is null or char_length(union_name) < 2 or union_name ~ '[[:cntrl:]]';
    end if;
  end if;

  if network_allowed and not payload_invalid then
    -- The per-address day cap bounds the team's notifications, not the stored
    -- request: a correction past it still replaces the details on file.
    notify := private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'email-interest-day', 3, interval '1 day'
    );
    derived_suppression_scope_hash := private.public_interest_suppression_scope(normalized_email);
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'public-interest-suppression:' || derived_suppression_scope_hash,
        509
      )
    );

    -- A stopped address stores nothing and learns nothing. A second request
    -- from the same address replaces the stored details and moves it to the
    -- top of the queue. For the same union the operator's status stays; a
    -- repeat that names another union is a new request for that union, so it
    -- goes back to new. The operator's note stays either way.
    if not exists (
      select 1
      from private.public_interest_suppressions as suppression
      where suppression.suppression_scope_hash = derived_suppression_scope_hash
    ) then
      insert into public.public_interest_submissions as on_file (
        email, name, interest, locale, source, organization_name, note,
        campaign_code, union_catalog_key, union_contact, share_name
      ) values (
        normalized_email, requester_name, 'ask_your_union', locale_value, 'ask-your-union',
        union_name, note, code, catalog_key, contact_line, p_share_name
      )
      on conflict (email, interest) do update
        set name = excluded.name,
            organization_name = excluded.organization_name,
            note = excluded.note,
            locale = excluded.locale,
            campaign_code = excluded.campaign_code,
            union_catalog_key = excluded.union_catalog_key,
            union_contact = excluded.union_contact,
            share_name = excluded.share_name,
            status = case when on_file.campaign_code is distinct from excluded.campaign_code
              then 'new' else on_file.status end,
            status_changed_at = case when on_file.campaign_code is distinct from excluded.campaign_code
              then null else on_file.status_changed_at end,
            consent_at = moment,
            last_submitted_at = moment;
      stored := found;

      -- How many members have asked for this union, for the team's
      -- notification only: the browser never receives it.
      if stored then
        select pg_catalog.count(*)::integer
        into union_request_count
        from public.public_interest_submissions as request
        where request.organization_id is null
          and request.source = 'ask-your-union'
          and request.campaign_code = code;
      end if;
    end if;
  end if;

  with picked as materialized (
    select candidate.ctid as row_key
    from private.public_interest_submission_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  )
  delete from private.public_interest_submission_limits as stale
  where stale.ctid in (select picked.row_key from picked);

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'stored', stored,
    'notify', stored and notify,
    'unionRequestCount', union_request_count,
    'unionName', case when stored then union_name end
  );
end;
$$;

revoke all on function public.submit_ask_your_union_request(text, text, text, text, text, text, boolean, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_ask_your_union_request(text, text, text, text, text, text, boolean, text, text, text, text, text)
  to service_role;

comment on function public.submit_ask_your_union_request(text, text, text, text, text, text, boolean, text, text, text, text, text) is
  'Service-only ask-your-union write: same durable limits, Vault-keyed suppression check and transaction lock as the landing form; one stored request per address, refreshed on every repeat and set back to new when the repeat names another union; the per-address day cap only stops further team notifications (notify); uniform accepted answer, with the stored and notify flags, the per-union count and the stored union name for the server only. A picked union must be a live catalog entry and is stored under the name the catalog holds. Sends nothing.';

-- ------------------------------------------------- 3. the operator queue learns the kind

-- Same bodies as 20261118160000 with the fourth kind added.
create or replace function private.intake_review_kind(p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'public-landing' then 'updates'
    when 'request-to-join' then 'join'
    when 'request-invite' then 'invite'
    when 'ask-your-union' then 'union'
  end
$$;

create or replace function private.intake_review_row(p_row public.public_interest_submissions)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'kind', private.intake_review_kind(p_row.source),
    'email', p_row.email,
    'name', p_row.name,
    'topic', case when p_row.source = 'public-landing' then p_row.interest end,
    'locale', p_row.locale,
    'organizationName', p_row.organization_name,
    'role', p_row.role,
    'sizeBand', p_row.size_band,
    'state', p_row.state,
    'phone', p_row.phone,
    'note', p_row.note,
    'campaignCode', p_row.campaign_code,
    'unionCatalogKey', p_row.union_catalog_key,
    'unionContact', p_row.union_contact,
    'shareName', p_row.share_name,
    'status', p_row.status,
    'operatorNote', p_row.operator_note,
    'operatorNoteUpdatedAt', p_row.operator_note_updated_at,
    'statusChangedAt', p_row.status_changed_at,
    'consentAt', p_row.consent_at,
    'lastSubmittedAt', p_row.last_submitted_at,
    'createdAt', p_row.created_at
  )
$$;

create or replace function private.intake_review_filters(p_kind text, p_status text, p_search text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  search_text text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
begin
  if p_kind is not null and p_kind not in ('updates', 'join', 'invite', 'union') then
    raise exception 'invalid kind' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('new', 'contacted', 'invited', 'closed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if search_text is not null and (char_length(search_text) > 120 or search_text ~ '[[:cntrl:]]') then
    raise exception 'invalid search' using errcode = '22023';
  end if;
  return search_text;
end;
$$;

revoke all on function private.intake_review_kind(text) from public, anon, authenticated, service_role;
revoke all on function private.intake_review_row(public.public_interest_submissions) from public, anon, authenticated, service_role;
revoke all on function private.intake_review_filters(text, text, text) from public, anon, authenticated, service_role;

-- Same body as 20261118160000 with the fourth kind in the daily counts and the
-- per-union counts added. Counts only, no contact details and no typed text:
-- a union is named here by its campaign code and, when it was picked in the
-- directory, its public catalog key. The typed name is read through the list.
create or replace function public.intake_request_summary(
  p_operator_user_id uuid,
  p_operator_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  first_day date := today - 89;
  first_instant timestamptz := (first_day::timestamp at time zone 'America/New_York');
  counts jsonb;
  topics jsonb;
  daily jsonb;
  unions jsonb;
  people integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind', c.kind, 'status', c.status, 'count', c.n)
    order by c.kind, c.status), '[]'::jsonb)
  into counts
  from (
    select private.intake_review_kind(s.source) as kind, s.status, pg_catalog.count(*)::integer as n
    from public.public_interest_submissions s
    where s.organization_id is null
    group by 1, 2
  ) c;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('topic', t.interest, 'count', t.n)
    order by t.interest), '[]'::jsonb)
  into topics
  from (
    select s.interest, pg_catalog.count(*)::integer as n
    from public.public_interest_submissions s
    where s.organization_id is null and s.source = 'public-landing'
    group by 1
  ) t;

  select pg_catalog.count(distinct s.email)::integer
  into people
  from public.public_interest_submissions s
  where s.organization_id is null and s.source = 'public-landing';

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'day', d.day, 'updates', d.updates, 'join', d.joins, 'invite', d.invites, 'union', d.unions) order by d.day), '[]'::jsonb)
  into daily
  from (
    select days.day::date as day,
      pg_catalog.count(*) filter (where s.source = 'public-landing')::integer as updates,
      pg_catalog.count(*) filter (where s.source = 'request-to-join')::integer as joins,
      pg_catalog.count(*) filter (where s.source = 'request-invite')::integer as invites,
      pg_catalog.count(*) filter (where s.source = 'ask-your-union')::integer as unions
    from pg_catalog.generate_series(first_day::timestamp, today::timestamp, interval '1 day') as days(day)
    left join public.public_interest_submissions s
      on s.organization_id is null
     and s.created_at >= first_instant
     and (s.created_at at time zone 'America/New_York')::date = days.day::date
    group by days.day
  ) d;

  -- The 50 unions most asked for: how many members asked, how many are still
  -- new, how many allow their name to be mentioned, and how many officer
  -- requests arrived on /join carrying the same campaign code.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'campaignCode', u.campaign_code,
      'unionCatalogKey', u.union_catalog_key,
      'requests', u.requests,
      'new', u.new_requests,
      'mayMentionName', u.may_mention,
      'officerRequests', u.officer_requests,
      'lastRequestedAt', u.last_requested_at
    ) order by u.requests desc, u.last_requested_at desc, u.campaign_code), '[]'::jsonb)
  into unions
  from (
    select g.campaign_code, g.union_catalog_key, g.requests, g.new_requests, g.may_mention, g.last_requested_at,
      (select pg_catalog.count(*)::integer
       from public.public_interest_submissions j
       where j.organization_id is null
         and j.source = 'request-to-join'
         and j.campaign_code = g.campaign_code) as officer_requests
    from (
      select s.campaign_code,
        pg_catalog.max(s.union_catalog_key) as union_catalog_key,
        pg_catalog.count(*)::integer as requests,
        pg_catalog.count(*) filter (where s.status = 'new')::integer as new_requests,
        pg_catalog.count(*) filter (where s.share_name)::integer as may_mention,
        pg_catalog.max(s.last_submitted_at) as last_requested_at
      from public.public_interest_submissions s
      where s.organization_id is null and s.source = 'ask-your-union'
      group by s.campaign_code
      order by pg_catalog.count(*) desc, pg_catalog.max(s.last_submitted_at) desc, s.campaign_code
      limit 50
    ) g
  ) u;

  return pg_catalog.jsonb_build_object(
    'today', today,
    'counts', counts,
    'topics', topics,
    'updatePeople', people,
    'daily', daily,
    'unions', unions
  );
end;
$$;

revoke all on function public.intake_request_summary(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.intake_request_summary(uuid, uuid) to service_role;

comment on function public.intake_request_summary(uuid, uuid) is
  'Service-only intake_review operator counts of Union Ground leads (organization_id NULL) by kind, status and topic, new requests per Eastern day for the last 90 days, and the 50 unions members asked for most by campaign code. No contact details and no typed text; not logged.';

-- Same bodies as 20261118160000 with one more search match: a search that is
-- a whole campaign code finds the rows with exactly that code. A code is
-- matched by equality, never as part of a longer one (m-olms-100 does not
-- find m-olms-1001), and is stored in lower case, so the search is lowered.
create or replace function public.list_intake_requests(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_kind text,
  p_status text,
  p_search text,
  p_before timestamptz,
  p_before_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  search_text text;
  pattern text;
  page_size integer := coalesce(p_limit, 50);
  requests_json jsonb;
  fetched integer;
  total integer;
  has_more boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  search_text := private.intake_review_filters(p_kind, p_status, p_search);
  if page_size not between 1 and 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if (p_before is null) <> (p_before_id is null) then
    raise exception 'cursor needs both parts' using errcode = '22023';
  end if;
  pattern := case when search_text is null then null
    else '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
      pg_catalog.lower(search_text), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  -- One statement, one snapshot: the page and whether an older page exists.
  select coalesce(pg_catalog.jsonb_agg(private.intake_review_row(r) order by r.last_submitted_at desc, r.id), '[]'::jsonb)
  into requests_json
  from (
    select s.*
    from public.public_interest_submissions s
    where s.organization_id is null
      and (p_kind is null or private.intake_review_kind(s.source) = p_kind)
      and (p_status is null or s.status = p_status)
      and (pattern is null
        or s.email like pattern
        or pg_catalog.lower(coalesce(s.name, '')) like pattern
        or pg_catalog.lower(coalesce(s.organization_name, '')) like pattern
        or s.campaign_code = pg_catalog.lower(search_text))
      and (p_before is null
        or s.last_submitted_at < p_before
        or (s.last_submitted_at = p_before and s.id > p_before_id))
    order by s.last_submitted_at desc, s.id
    limit page_size + 1
  ) r;

  fetched := pg_catalog.jsonb_array_length(requests_json);
  has_more := fetched > page_size;
  if has_more then
    requests_json := requests_json - page_size;
  end if;
  total := pg_catalog.jsonb_array_length(requests_json);

  insert into private.intake_review_events (action, actor_user_id, kind_filter, status_filter, searched, row_count)
  values ('list', p_operator_user_id, p_kind, p_status, search_text is not null, total);

  return pg_catalog.jsonb_build_object(
    'requests', requests_json,
    'hasMore', has_more,
    'cursorSubmittedAt', case when total > 0 then requests_json -> (total - 1) -> 'lastSubmittedAt' end,
    'cursorId', case when total > 0 then requests_json -> (total - 1) -> 'id' end
  );
end;
$$;

revoke all on function public.list_intake_requests(uuid, uuid, text, text, text, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_intake_requests(uuid, uuid, text, text, text, timestamptz, uuid, integer)
  to service_role;

comment on function public.list_intake_requests(uuid, uuid, text, text, text, timestamptz, uuid, integer) is
  'Service-only intake_review operator read of Union Ground leads (organization_id NULL): one keyset page of at most 100, filters by kind, status and search (part of the address, name or organization, or a whole campaign code). Writes one intake_review_events row per call.';

create or replace function public.export_intake_requests(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_kind text,
  p_status text,
  p_search text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  search_text text;
  pattern text;
  rows_json jsonb;
  fetched integer;
  total integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  search_text := private.intake_review_filters(p_kind, p_status, p_search);
  pattern := case when search_text is null then null
    else '%' || pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
      pg_catalog.lower(search_text), '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  select coalesce(pg_catalog.jsonb_agg(private.intake_review_row(r) order by r.last_submitted_at desc, r.id), '[]'::jsonb)
  into rows_json
  from (
    select s.*
    from public.public_interest_submissions s
    where s.organization_id is null
      and (p_kind is null or private.intake_review_kind(s.source) = p_kind)
      and (p_status is null or s.status = p_status)
      and (pattern is null
        or s.email like pattern
        or pg_catalog.lower(coalesce(s.name, '')) like pattern
        or pg_catalog.lower(coalesce(s.organization_name, '')) like pattern
        or s.campaign_code = pg_catalog.lower(search_text))
    order by s.last_submitted_at desc, s.id
    limit 5001
  ) r;

  fetched := pg_catalog.jsonb_array_length(rows_json);
  if fetched > 5000 then
    rows_json := rows_json - 5000;
  end if;
  total := pg_catalog.jsonb_array_length(rows_json);

  insert into private.intake_review_events (action, actor_user_id, kind_filter, status_filter, searched, row_count)
  values ('export', p_operator_user_id, p_kind, p_status, search_text is not null, total);

  return pg_catalog.jsonb_build_object('requests', rows_json, 'truncated', fetched > 5000);
end;
$$;

revoke all on function public.export_intake_requests(uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.export_intake_requests(uuid, uuid, text, text, text) to service_role;

comment on function public.export_intake_requests(uuid, uuid, text, text, text) is
  'Service-only intake_review operator export of up to 5,000 Union Ground leads (organization_id NULL) matching the list filters, a whole campaign code included. Writes one intake_review_events row per call.';

notify pgrst, 'reload schema';

commit;
