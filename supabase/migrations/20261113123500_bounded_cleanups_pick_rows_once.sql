-- BUG-UG-BOUNDED-CLEANUPS-CAN-TOUCH-EVERY-ROW-IN-ONE-CALL-20261113 (#8605)
--
-- Append-only replacement of the fourteen live functions that bound a cleanup
-- or batch with "where key in (select key ... limit N for update skip locked)".
-- The LIMIT did not bound the work: when the table's statistics say it is
-- empty, the planner runs the statement as a nested-loop semi-join with the
-- locking subquery on the inner side and no Materialize, re-runs it for every
-- outer row, and each re-run skips the rows this statement already deleted or
-- updated and returns the next ones, so one call touched every qualifying row
-- (one call of consume_member_invitation_accept_limit deleted 201 windows, not
-- 200).
--
-- Each affected statement now selects its keys once into a MATERIALIZED WITH
-- query (at most N keys, the same order, filters and lock mode) and deletes or
-- updates exactly that set. A WITH query that locks rows is never inlined, so
-- the existing "with candidates as (... for update skip locked)" batches in
-- the retention, claim and worker-lease functions already ran once and are
-- left as they are. Nothing else in any function changes: each body below is
-- its latest definition, named beside it, with only that edit.

begin;

-- public.consume_member_invitation_accept_limit: latest definition 20260907153000_member_invitation_accept_limit_pruning.sql; 1 limited locking subquery materialized.
create or replace function public.consume_member_invitation_accept_limit(p_scope_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_row private.member_invitation_accept_limits%rowtype;
  moment timestamptz := clock_timestamp();
  cap constant integer := 20;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-rate:' || p_scope_hash, 509)
  );

  -- At most one transaction takes prune row locks, and the maintenance mutex
  -- never waits. The scope lock comes first so lookup and maintenance share a
  -- single acyclic lock order across concurrent acceptance requests.
  if pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-prune', 509)
  ) then
    with picked as materialized (
      select candidate.ctid as row_key
      from private.member_invitation_accept_limits as candidate
      where candidate.window_started_at <= moment - interval '15 minutes'
      order by candidate.window_started_at, candidate.scope_hash
      limit 200
      for update skip locked
    )
    delete from private.member_invitation_accept_limits as stale
    where stale.ctid in (select picked.row_key from picked);
  end if;

  select * into current_row
  from private.member_invitation_accept_limits
  where scope_hash = p_scope_hash
  for update;

  if not found then
    insert into private.member_invitation_accept_limits
      (scope_hash, window_started_at, request_count)
    values (p_scope_hash, moment, 1);
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.window_started_at + interval '15 minutes' <= moment then
    update private.member_invitation_accept_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash;
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.request_count >= cap then
    return pg_catalog.jsonb_build_object('allowed', false, 'remaining', 0);
  end if;
  update private.member_invitation_accept_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash;
  return pg_catalog.jsonb_build_object(
    'allowed', true, 'remaining', cap - current_row.request_count - 1
  );
end;
$$;

-- public.consume_member_invitation_accept_limit_for_token: latest definition 20261003058000_switch_limits_caps_floors_lockouts.sql; 1 limited locking subquery materialized.
create or replace function public.consume_member_invitation_accept_limit_for_token(
  p_scope_hash text, p_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  current_row private.member_invitation_accept_limits%rowtype;
  moment timestamptz := clock_timestamp();
  accept_org uuid;
  scope_key text;
  cap integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or (p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_token_hash is not null then
    select c.organization_id into accept_org
    from public.member_invitations i
    join public.chapters c on c.id = i.chapter_id
    where i.token_hash = p_token_hash and i.status = 'pending';
  end if;
  cap := private.organization_limit(accept_org, 'limits.security.invitation_accept_per_15_minutes');
  scope_key := case when accept_org is null then p_scope_hash else
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      p_scope_hash || ':' || accept_org::text, 'UTF8')), 'hex') end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-rate:' || scope_key, 509)
  );
  -- Keep the reviewed non-waiting, bounded prune and lock order.
  if pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-prune', 509)
  ) then
    with picked as materialized (
      select candidate.ctid as row_key
      from private.member_invitation_accept_limits as candidate
      where candidate.window_started_at <= moment - interval '15 minutes'
      order by candidate.window_started_at, candidate.scope_hash
      limit 200
      for update skip locked
    )
    delete from private.member_invitation_accept_limits as stale
    where stale.ctid in (select picked.row_key from picked);
  end if;
  select * into current_row
  from private.member_invitation_accept_limits
  where scope_hash = scope_key
  for update;
  if not found then
    insert into private.member_invitation_accept_limits
      (scope_hash, window_started_at, request_count)
    values (scope_key, moment, 1);
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.window_started_at + interval '15 minutes' <= moment then
    update private.member_invitation_accept_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = scope_key;
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.request_count >= cap then
    return pg_catalog.jsonb_build_object('allowed', false, 'remaining', 0);
  end if;
  update private.member_invitation_accept_limits
  set request_count = request_count + 1
  where scope_hash = scope_key;
  return pg_catalog.jsonb_build_object(
    'allowed', true, 'remaining', cap - current_row.request_count - 1
  );
end;
end;
$function$;

-- public.consume_membership_card_verification_nonce: latest definition 20261013133000_membership_card_nonce_service_only.sql; 1 limited locking subquery materialized.
create or replace function public.consume_membership_card_verification_nonce(
  p_nonce text,
  p_origin_surface text,
  p_expires_at timestamptz
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  moment timestamptz := pg_catalog.clock_timestamp();
  -- Hard ceiling on live (unexpired) rows. EXECUTE is granted only to
  -- service_role and the server verifier calls this only after a signed
  -- membership-card token has verified, so a burst now needs valid signed
  -- tokens. The ceiling stays as a second bound: the maintenance step below
  -- removes at most 200 already-expired rows per call, and 20000 rows of
  -- (22-character nonce, short surface label, timestamp) are roughly 1-2 MiB of
  -- heap plus index together, far above any legitimate five-minute
  -- verification rate and far below a size that threatens the database. At or
  -- above the ceiling the function fails closed: no row is inserted and it
  -- returns the same false that a replay returns, so the refusal discloses
  -- nothing, no legitimate code is ever recorded as consumed when it was not,
  -- and the backlog drains without operator action as the parked rows expire.
  live_nonce_cap constant bigint := 20000;
  live_nonce_count bigint;
  inserted_count bigint;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'server verifier required' using errcode = '42501';
  end if;
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{22}$'
     or p_origin_surface is null or p_origin_surface not in ('saas', 'demo')
     or p_expires_at is null then
    raise exception 'invalid verification nonce' using errcode = '22023';
  end if;

  -- One non-waiting maintainer removes at most 200 old opaque rows per call.
  if pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('membership-card-verification-nonce-prune', 509)
  ) then
    with picked as materialized (
      select candidate.ctid as row_key
      from private.membership_card_verification_nonces as candidate
      where candidate.expires_at <= moment
      order by candidate.expires_at, candidate.origin_surface, candidate.nonce
      limit 200
      for update skip locked
    )
    delete from private.membership_card_verification_nonces as stale
    where stale.ctid in (select picked.row_key from picked);
  end if;

  -- The signed token already caps its own five-minute life against the issuing
  -- node's clock, and the route re-checks that cap before calling here. This
  -- upper bound therefore exists to stop any caller from parking long-lived
  -- rows, not to re-date a legitimate code: it allows one minute of
  -- node-to-database clock skew rather than failing a genuine first check
  -- closed and indistinguishably from a replay.
  if p_expires_at <= moment or p_expires_at > moment + interval '6 minutes' then
    return false;
  end if;

  -- Bounded live-row ceiling; see live_nonce_cap above. The subquery stops at
  -- the ceiling so the check costs at most one capped scan of the expiry index
  -- rather than a full count, and it is evaluated after the prune so reclaimed
  -- space counts towards the caller.
  select pg_catalog.count(*) into live_nonce_count
  from (
    select 1
    from private.membership_card_verification_nonces as live
    where live.expires_at > moment
    limit live_nonce_cap
  ) as capped;
  if live_nonce_count >= live_nonce_cap then
    return false;
  end if;

  insert into private.membership_card_verification_nonces
    (nonce, origin_surface, expires_at)
  values (p_nonce, p_origin_surface, p_expires_at)
  on conflict (origin_surface, nonce) do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$function$;

-- public.begin_union_document_contribution: latest definition 20261027183700_union_document_outreach_codes_and_notify_preference.sql; 1 limited locking subquery materialized.
create or replace function public.begin_union_document_contribution(
  p_email text,
  p_organization_name text,
  p_affiliation text,
  p_state text,
  p_contact_name text,
  p_contact_role text,
  p_notes text,
  p_blank_forms_attested boolean,
  p_permission_granted boolean,
  p_files jsonb,
  p_receipt_hash text,
  p_website text,
  p_scope_hash text,
  p_email_scope_hash text,
  p_outreach_code text,
  p_outreach_choice integer,
  p_notify_via text,
  p_notify_phone text,
  p_notify_mail_address text
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
  affiliation text := nullif(pg_catalog.btrim(coalesce(p_affiliation, '')), '');
  contact_name text := nullif(pg_catalog.btrim(coalesce(p_contact_name, '')), '');
  notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  files jsonb := case when pg_catalog.jsonb_typeof(p_files) = 'array' then p_files else '[]'::jsonb end;
  normalized_code text := nullif(pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_outreach_code, ''), '[[:space:]-]', '', 'g')), '');
  notify_phone text := nullif(pg_catalog.btrim(coalesce(p_notify_phone, '')), '');
  notify_mail_address text := nullif(pg_catalog.btrim(pg_catalog.replace(coalesce(p_notify_mail_address, ''), pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10))), '');
  moment timestamptz := clock_timestamp();
  derived_suppression_scope_hash text;
  suppressed boolean;
  new_contribution_id uuid;
  stored_files jsonb;
  payload_invalid boolean;
  code_row private.union_outreach_codes%rowtype;
  stored_code text;
  chosen jsonb;
  chosen_body_id text;
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
    return pg_catalog.jsonb_build_object('accepted', true, 'stored', false, 'files', '[]'::jsonb);
  end if;

  payload_invalid := char_length(normalized_email) > 254
    or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or normalized_email ~ '[[:cntrl:]]'
    or organization_name is null
    or char_length(organization_name) not between 2 and 160
    or organization_name ~ '[[:cntrl:]]'
    or (affiliation is not null and (char_length(affiliation) > 160 or affiliation ~ '[[:cntrl:]]'))
    or contact_name is null
    or char_length(contact_name) not between 2 and 120
    or contact_name ~ '[[:cntrl:]]'
    or p_contact_role is null or p_contact_role not in ('officer', 'staff', 'steward', 'member', 'other')
    or p_state is null
    or p_state <> all (array[
      'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN',
      'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH',
      'NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT',
      'VT','VA','WA','WV','WI','WY','AS','GU','MP','PR','VI','outside-us'
    ]::text[])
    or (notes is not null and char_length(notes) > 2000)
    or p_blank_forms_attested is not true
    or p_permission_granted is not true
    or p_receipt_hash is null or p_receipt_hash !~ '^[0-9a-f]{64}$'
    or (normalized_code is not null and normalized_code !~ '^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$')
    or (p_outreach_choice is not null and (normalized_code is null or p_outreach_choice not between 1 and 1000))
    or p_notify_via is null or p_notify_via not in ('email', 'text', 'mail')
    or (p_notify_via = 'text') <> (notify_phone is not null)
    or (notify_phone is not null and notify_phone !~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$')
    or (p_notify_via = 'mail') <> (notify_mail_address is not null)
    or (notify_mail_address is not null and (
      char_length(notify_mail_address) not between 10 and 300
      or pg_catalog.translate(notify_mail_address, pg_catalog.chr(10), '') ~ '[[:cntrl:]]'
    ))
    or pg_catalog.jsonb_array_length(files) not between 1 and 40
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(files) as entry(value)
      where pg_catalog.jsonb_typeof(entry.value) <> 'object'
        or pg_catalog.jsonb_typeof(entry.value -> 'name') is distinct from 'string'
        or char_length(pg_catalog.btrim(entry.value ->> 'name')) not between 1 and 160
        or (entry.value ->> 'name') ~ '[/\\]'
        or (entry.value ->> 'name') ~ '[[:cntrl:]]'
        or coalesce(entry.value ->> 'kind', '') not in ('contract', 'bylaws', 'grievance-form', 'other-form', 'other')
        or coalesce(entry.value ->> 'mime', '') not in (
          'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        or pg_catalog.jsonb_typeof(entry.value -> 'size') is distinct from 'number'
        -- The cast runs only on a value the pattern admitted: OR operands
        -- have no guaranteed evaluation order.
        or case when (entry.value ->> 'size') ~ '^[1-9][0-9]{0,7}$'
             then (entry.value ->> 'size')::bigint > 10485760
             else true end
    );
  -- The server validates every field first, so an invalid payload here is a
  -- caller defect, not a visitor's typo: refuse it before any limit is spent.
  if payload_invalid then
    raise exception 'invalid contribution' using errcode = '22023';
  end if;

  -- An unknown code is stored as no code, exactly as the lookup answers it.
  if normalized_code is not null then
    select * into code_row
    from private.union_outreach_codes as candidate
    where candidate.code = normalized_code;
    if found then
      stored_code := code_row.code;
      if p_outreach_choice is not null then
        chosen := code_row.orgs -> (p_outreach_choice - 1);
        if pg_catalog.jsonb_typeof(chosen -> 'display_name') = 'string' then
          chosen_body_id := chosen ->> 'body_id';
          organization_name := pg_catalog.left(chosen ->> 'display_name', 160);
        end if;
      end if;
    end if;
  end if;

  if not private.consume_public_interest_submission_limit(
    p_scope_hash, 'network-15m', 10, interval '15 minutes'
  ) or not private.consume_public_interest_submission_limit(
    p_email_scope_hash, 'email-interest-day',
    case when code_row.kind = 'shared' then 25 else 5 end, interval '1 day'
  ) then
    return pg_catalog.jsonb_build_object('accepted', false, 'refusal', 'rate-limited');
  end if;

  derived_suppression_scope_hash := private.public_interest_suppression_scope(normalized_email);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-interest-suppression:' || derived_suppression_scope_hash,
      509
    )
  );

  -- A stopped address is recorded, never answered differently: the visitor
  -- chose to send these documents, and the answer must not reveal the ledger.
  suppressed := exists (
    select 1
    from private.public_interest_suppressions as suppression
    where suppression.suppression_scope_hash = derived_suppression_scope_hash
  );

  insert into public.union_document_contributions (
    organization_name, affiliation, state, contact_name, contact_role, contact_email,
    notes, blank_forms_attested, permission_granted, file_count, receipt_hash, contact_suppressed,
    outreach_code, outreach_body_id, notify_via, notify_phone, notify_mail_address
  ) values (
    organization_name, affiliation, p_state, contact_name, p_contact_role, normalized_email,
    pg_catalog.replace(notes, pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)), true, true, pg_catalog.jsonb_array_length(files), p_receipt_hash, suppressed,
    stored_code, chosen_body_id, p_notify_via, notify_phone, notify_mail_address
  )
  returning id into new_contribution_id;

  with entries as (
    select entry.value, entry.ordinality::smallint as position, pg_catalog.gen_random_uuid() as file_id
    from pg_catalog.jsonb_array_elements(files) with ordinality as entry(value, ordinality)
  ), inserted as (
    insert into public.union_document_contribution_files (
      id, contribution_id, position, object_path, original_name, declared_kind, mime, size_bytes
    )
    select e.file_id, new_contribution_id, e.position,
      new_contribution_id::text || '/' || e.file_id::text,
      pg_catalog.btrim(e.value ->> 'name'), e.value ->> 'kind', e.value ->> 'mime', (e.value ->> 'size')::integer
    from entries e
    returning id, position, object_path
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fileId', inserted.id, 'position', inserted.position, 'objectPath', inserted.object_path
    ) order by inserted.position), '[]'::jsonb)
  into stored_files
  from inserted;

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
    'accepted', true, 'stored', true, 'contributionId', new_contribution_id, 'files', stored_files
  );
end;
$$;

-- public.request_public_interest_stop: latest definition 20260925990000_public_interest_stop_confirmation.sql; 2 limited locking subqueries materialized.
create or replace function public.request_public_interest_stop(
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

  with picked as materialized (
    select candidate.token_hash as row_key
    from private.public_interest_stop_confirmations as candidate
    where candidate.expires_at < moment
      and candidate.token_hash <> p_token_hash
    order by candidate.expires_at
    limit 200
    for update skip locked
  )
  delete from private.public_interest_stop_confirmations as stale
  where stale.token_hash in (select picked.row_key from picked);

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
    'accepted', network_allowed and email_allowed and not payload_invalid,
    'pending', pending
  );
end;
$$;

-- public.confirm_public_interest_stop: latest definition 20260925990000_public_interest_stop_confirmation.sql; 1 limited locking subquery materialized.
create or replace function public.confirm_public_interest_stop(
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

  with picked as materialized (
    select candidate.token_hash as row_key
    from private.public_interest_stop_confirmations as candidate
    where candidate.expires_at < moment
      and candidate.token_hash <> clean_hash
    order by candidate.expires_at
    limit 200
    for update skip locked
  )
  delete from private.public_interest_stop_confirmations as stale
  where stale.token_hash in (select picked.row_key from picked);

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

-- public.submit_join_request: latest definition 20261021044810_request_to_join_optional_size_state.sql; 1 limited locking subquery materialized.
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

  return pg_catalog.jsonb_build_object('accepted', true, 'stored', stored);
end;
$$;

-- public.submit_organization_claim: latest definition 20261028080000_platform_organization_boundary.sql; 1 limited locking subquery materialized.
create or replace function public.submit_organization_claim(
  p_scope_hash text,
  p_email_scope_hash text,
  p_catalog_key text,
  p_unlisted jsonb,
  p_claimant jsonb,
  p_attestation jsonb,
  p_locale text,
  p_confirm_token_hash text,
  p_requesting_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  moment timestamptz;
  clean_claimant_name text;
  clean_claimant_title text;
  clean_claimant_email text;
  clean_claimant_statement text;
  clean_unlisted_name text;
  clean_unlisted_city text;
  clean_unlisted_state text;
  allowed boolean;
  target_normalized text;
  new_claim_id uuid;
begin
  perform private.lock_case_graph(array[p_requesting_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  moment := clock_timestamp();

  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_confirm_token_hash is null or p_confirm_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid confirmation token' using errcode = '22023';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'invalid locale' using errcode = '22023';
  end if;
  if p_attestation is null or p_attestation is distinct from
       '{"version":"claim-attest/1","officer":true,"verifyFirst":true,"noPersonalData":true,"notEmployer":true}'::jsonb then
    raise exception 'attestation required' using errcode = '22023';
  end if;

  -- Exactly one target: a catalog key, or an unlisted organization.
  if pg_catalog.num_nonnulls(p_catalog_key, p_unlisted) <> 1 then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_catalog_key is not null and p_catalog_key !~ '^(olms-[0-9]{1,9}|ug-[a-z0-9]{10})$' then
    raise exception 'claim target invalid' using errcode = '22023';
  end if;
  if p_unlisted is not null then
    if pg_catalog.jsonb_typeof(p_unlisted) is distinct from 'object'
       or p_unlisted - array['name', 'city', 'state'] <> '{}'::jsonb
       or pg_catalog.jsonb_typeof(p_unlisted -> 'name') is distinct from 'string'
       or (p_unlisted ? 'city' and pg_catalog.jsonb_typeof(p_unlisted -> 'city') not in ('string', 'null'))
       or (p_unlisted ? 'state' and pg_catalog.jsonb_typeof(p_unlisted -> 'state') not in ('string', 'null')) then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
    clean_unlisted_name := pg_catalog.btrim(p_unlisted ->> 'name');
    clean_unlisted_city := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'city', '')), '');
    clean_unlisted_state := nullif(pg_catalog.btrim(coalesce(p_unlisted ->> 'state', '')), '');
    -- The unlisted name is shown to a vouching organization's admins, so it
    -- gets 4a's placement-name filter: no email, link or phone number.
    if pg_catalog.char_length(clean_unlisted_name) not between 3 and 200
       or clean_unlisted_name ~ '[[:cntrl:]]'
       or clean_unlisted_name !~ '[[:alnum:]]'
       or pg_catalog.strpos(clean_unlisted_name, '@') > 0
       or pg_catalog.strpos(clean_unlisted_name, '://') > 0
       or pg_catalog.regexp_replace(clean_unlisted_name, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'
       or (clean_unlisted_city is not null and (pg_catalog.char_length(clean_unlisted_city) > 120 or clean_unlisted_city ~ '[[:cntrl:]]'
           or pg_catalog.strpos(clean_unlisted_city, '@') > 0
           or pg_catalog.strpos(clean_unlisted_city, '://') > 0
           or pg_catalog.regexp_replace(clean_unlisted_city, '[[:space:]().+/_\u2010-\u2015\u2212\uFF0D-]', '', 'g') ~ '[[:digit:]]{7,}'))
       or (clean_unlisted_state is not null and clean_unlisted_state !~ '^[A-Z]{2}$') then
      raise exception 'claim target invalid' using errcode = '22023';
    end if;
  end if;

  -- The claimant: exactly name, title, email and statement, all strings.
  if pg_catalog.jsonb_typeof(p_claimant) is distinct from 'object'
     or (select pg_catalog.array_agg(k order by k) from pg_catalog.jsonb_object_keys(p_claimant) as k)
          is distinct from array['email', 'name', 'statement', 'title']
     or pg_catalog.jsonb_typeof(p_claimant -> 'name') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'title') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'email') <> 'string'
     or pg_catalog.jsonb_typeof(p_claimant -> 'statement') <> 'string' then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;
  clean_claimant_name := pg_catalog.btrim(p_claimant ->> 'name');
  clean_claimant_title := pg_catalog.btrim(p_claimant ->> 'title');
  clean_claimant_email := pg_catalog.btrim(p_claimant ->> 'email');
  clean_claimant_statement := nullif(pg_catalog.btrim(p_claimant ->> 'statement'), '');
  if pg_catalog.char_length(clean_claimant_name) not between 2 and 120 or clean_claimant_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_title) not between 1 and 120 or clean_claimant_title ~ '[[:cntrl:]]'
     or pg_catalog.char_length(clean_claimant_email) not between 3 and 254
     or clean_claimant_email <> pg_catalog.lower(clean_claimant_email)
     or clean_claimant_email !~ '^[^@[:space:][:cntrl:]]+@[^@[:space:][:cntrl:]]+$'
     or pg_catalog.char_length(coalesce(clean_claimant_statement, '')) > 1000 then
    raise exception 'claimant invalid' using errcode = '22023';
  end if;

  -- The requesting admin of an existing organization (organizations are
  -- created at signup, never by a claim).
  if p_requesting_user_id is null or p_organization_id is null then
    raise exception 'claim requester invalid' using errcode = '22023';
  end if;
  if not exists (
       select 1 from public.organizations as o
        where o.id = p_organization_id and o.status = 'active' and o.kind = 'union')
     or not exists (
       select 1 from public.organization_memberships as m
        where m.organization_id = p_organization_id
          and m.user_id = p_requesting_user_id
          and m.status = 'active')
     or not exists (
       select 1 from public.organization_role_grants as g
        where g.organization_id = p_organization_id
          and g.user_id = p_requesting_user_id
          and g.role = 'admin') then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Limits, then silent refusals. Every refusal answers exactly like success.
  allowed := private.consume_public_interest_submission_limit(
    p_scope_hash, 'claim-network-hour', 5, interval '1 hour');
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      p_email_scope_hash, 'claim-email-day', 3, interval '1 day');
  end if;
  if allowed then
    allowed := private.consume_public_interest_submission_limit(
      pg_catalog.encode(extensions.digest('organization-claim-org:' || p_organization_id::text, 'sha256'), 'hex'),
      'claim-org-day', 3, interval '1 day');
  end if;

  if allowed then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-target:' || coalesce(p_catalog_key, 'unlisted'), 509));
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('union-catalog-claim-org:' || p_organization_id::text, 509));

    target_normalized := coalesce(p_catalog_key, 'unlisted:' || pg_catalog.lower(clean_unlisted_name));

    -- A claim whose confirmation deadline has passed is lapsed even before the
    -- daily sweep runs: expire it here, exactly as the sweep would, so it never
    -- blocks this organization or this listing.
    with lapsed as (
      update private.organization_claims as c
         set status = 'expired',
             confirm_token_hash = null,
             closed_at = pg_catalog.now(),
             updated_at = pg_catalog.now()
       where c.status = 'awaiting_email'
         and c.confirm_expires_at <= pg_catalog.now()
         and (c.organization_id = p_organization_id
              or coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized)
      returning c.id, c.organization_id, c.catalog_key
    )
    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    )
    select 'claim_expired', 'system', null, 'claim', lapsed.id, lapsed.organization_id,
           pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
             'catalogKey', lapsed.catalog_key, 'fromStatus', 'awaiting_email', 'toStatus', 'expired')),
           extensions.gen_random_uuid()
      from lapsed;

    if p_catalog_key is not null and not exists (
         select 1 from private.catalog_organizations as o
          where o.catalog_key = p_catalog_key
            and o.retired_release_id is null
            and o.duplicate_of is null
            and (private.catalog_registry_identity_visible(o.union_org_id)
              or private.organization_owns_fictional_registry(p_organization_id, o.union_org_id))) then
      allowed := false;
    elsif (select pg_catalog.count(*)
             from private.organization_claims as c
            where coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
              and c.status in ('awaiting_email', 'under_review', 'held')) >= 20 then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.claimant_email_scope = p_email_scope_hash
            and coalesce(c.catalog_key, 'unlisted:' || pg_catalog.lower(pg_catalog.btrim(c.unlisted_name))) = target_normalized
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif exists (
         select 1 from private.organization_claims as c
          where c.organization_id = p_organization_id
            and c.status in ('awaiting_email', 'under_review', 'held')) then
      allowed := false;
    elsif private.organization_is_verified(p_organization_id) then
      allowed := false;
    elsif exists (
         select 1 from private.public_interest_suppressions as suppression
          where suppression.suppression_scope_hash = private.public_interest_suppression_scope(clean_claimant_email)) then
      allowed := false;
    end if;
  end if;

  if allowed then
    insert into private.organization_claims (
      catalog_key, unlisted_name, unlisted_city, unlisted_state,
      organization_id, claimant_user_id,
      claimant_name, claimant_title, claimant_email, statement, claimant_email_scope,
      locale, attestation_version, attested_at, confirm_token_hash, confirm_expires_at, status
    ) values (
      p_catalog_key, clean_unlisted_name, clean_unlisted_city, clean_unlisted_state,
      p_organization_id, p_requesting_user_id,
      clean_claimant_name, clean_claimant_title, clean_claimant_email, clean_claimant_statement, p_email_scope_hash,
      p_locale, 'claim-attest/1', pg_catalog.now(), p_confirm_token_hash, pg_catalog.now() + interval '24 hours',
      'awaiting_email'
    )
    returning id into new_claim_id;

    insert into private.catalog_review_events (
      event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
    ) values (
      'claim_submitted', 'organization_admin',
      p_requesting_user_id, 'claim', new_claim_id, p_organization_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'catalogKey', p_catalog_key, 'toStatus', 'awaiting_email')),
      extensions.gen_random_uuid()
    );

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      p_organization_id, 'administration', 'organization_catalog_verification_requested', 'create',
      p_requesting_user_id, 'organization', p_organization_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', p_organization_id,
        'entityType', 'catalog_organization',
        'entityId', coalesce(p_catalog_key, 'unlisted'),
        'toStatus', 'awaiting_email'
      )
    );
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

  return pg_catalog.jsonb_build_object('accepted', true, 'deliver', allowed);
end;
$function$;

-- public.submit_public_event_rsvp: latest definition 20261028080000_platform_organization_boundary.sql; 1 limited locking subquery materialized.
create or replace function public.submit_public_event_rsvp(
  p_event_id text, p_email text, p_name text, p_locale text,
  p_source text, p_website text, p_scope_hash text, p_email_scope_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  event_org uuid;
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  event_scope_hash text;
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
  email_allowed boolean := false;
  event_allowed boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then return pg_catalog.jsonb_build_object('accepted', true); end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if pg_catalog.char_length(coalesce(p_event_id, '')) not between 1 and 128
     or pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (normalized_name is not null and pg_catalog.char_length(normalized_name) > 100)
     or p_source is distinct from 'public-event-rsvp'
     or p_locale is null or p_locale not in ('en', 'es') then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  network_allowed := private.consume_public_event_rsvp_limit(p_scope_hash, 'network-15m', 20, interval '15 minutes');
  if network_allowed then
    select r.organization_id into event_org from public.public_site_records r
    where r.id = p_event_id and r.is_published and r.kind = 'meeting' and r.organization_id is not null
      and coalesce(r.ends_at, r.starts_at) >= now()
      and private.organization_visible_in_directory(r.organization_id)
      and private.organization_is_union(r.organization_id);
  end if;
  if network_allowed and event_org is not null then
    email_allowed := private.consume_public_event_rsvp_limit(
      p_email_scope_hash, 'email-event-day', 3, interval '1 day'
    );
  end if;
  if network_allowed and email_allowed then
    event_scope_hash := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(event_org::text || ':' || p_event_id, 'UTF8'), 'sha256'), 'hex'
    );
    event_allowed := private.consume_public_event_rsvp_limit(event_scope_hash, 'event-day', 500, interval '1 day');
  end if;
  if network_allowed and email_allowed and event_allowed then
    insert into public.public_event_rsvps (organization_id, event_id, email, name, locale)
    values (event_org, p_event_id, normalized_email, normalized_name, p_locale)
    on conflict (event_id, email) do nothing;
  end if;
  with picked as materialized (
    select candidate.ctid as row_key from private.public_event_rsvp_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash <> all(pg_catalog.array_remove(
        array[p_scope_hash, p_email_scope_hash, event_scope_hash]::text[], null
      ))
    order by candidate.window_started_at limit 200 for update skip locked
  )
  delete from private.public_event_rsvp_limits as stale
  where stale.ctid in (select picked.row_key from picked);
  return pg_catalog.jsonb_build_object('accepted', true);
end;
end;
$function$;

-- public.reserve_password_signin_attempt: latest definition 20261019174000_password_signin_success_refunds.sql; 1 limited locking subquery materialized.
create or replace function public.reserve_password_signin_attempt(p_email text, p_network text)
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
  with picked as materialized (
    select old.id as row_key from private.password_signin_reservations old
    where old.created_at < pg_catalog.clock_timestamp() - interval '2 days'
    limit 200 for update skip locked
  )
  delete from private.password_signin_reservations r where r.id in (select picked.row_key from picked);
  return pg_catalog.jsonb_build_object('allowed', true, 'reservation', reservation);
end;
$function$;

-- public.reconcile_pending_account_deletions: latest definition 20260907151000_account_deletion_finalization_reconciliation.sql inside the case-graph gate 20260907151000 wraps it in; 2 limited locking subqueries materialized.
create or replace function public.reconcile_pending_account_deletions(p_limit integer default 25)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  reconciled integer := 0;
  current_key_fingerprint text;
  key_snapshot bytea;
  installed_source_md5 text;
  installed_contract_valid boolean;
  request private.member_account_deletions%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  -- The absence arm is safe only while both inputs to the pseudonym are the
  -- same ones that produced each durable request. A missing key or a changed
  -- helper is global: no request in the database can be evaluated, so the run
  -- fails closed. A per-request key-fingerprint mismatch is NOT global -- it
  -- strands only that one request -- so it must never abort the run for every
  -- other request (see the per-row parking step below).
  -- One immutable snapshot supplies EVERY hash and fingerprint in this call.
  select secret.secret, pg_catalog.encode(extensions.digest(secret.secret, 'sha256'), 'hex')
    into key_snapshot, current_key_fingerprint
    from private.member_account_lifecycle_secret secret
   where secret.id
     and pg_catalog.length(secret.secret) = 32;
  select pg_catalog.md5(p.prosrc),
         p.prosecdef
           and p.provolatile = 's'
           and p.proconfig @> array['search_path=""']::text[]
    into installed_source_md5, installed_contract_valid
    from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure('private.member_lifecycle_subject_hash(uuid)');
  if key_snapshot is null
     or installed_source_md5 is distinct from '331e256ef56ee61c13fd1b4e82ae0b1b'
     or installed_contract_valid is distinct from true then
    raise exception 'account lifecycle subject-hash contract unavailable or changed' using errcode = '55000';
  end if;

  -- Per-row fail-closed, not whole-table. A request whose durable key
  -- fingerprint no longer matches the installed key cannot have its absence
  -- arm evaluated honestly, so it is parked: it stays visibly `processing`,
  -- keeps its null finalized_at, gains no audit event, and is never completed.
  -- The visible `subject-key-rotated` failure_code is what an operator reads.
  -- Parking one
  -- stranded request must not disable reconciliation for every other request,
  -- including requests that already carry an auth_deleted_at marker and never
  -- need the subject hash at all.
  with picked as materialized (
     select stranded.id as row_key
       from private.member_account_deletions stranded
      where stranded.status in ('authorized', 'processing')
        and stranded.auth_deleted_at is null
        and stranded.subject_hash_key_fingerprint is distinct from current_key_fingerprint
        and stranded.failure_code is distinct from 'subject-key-rotated'
      limit 100
      for update skip locked
   )
  update private.member_account_deletions parked
     set failure_code = 'subject-key-rotated'
   where parked.id in (select picked.row_key from picked);

  -- If the original key is restored, the park marker is stale evidence and is
  -- withdrawn before the candidate scan runs.
  with picked as materialized (
     select recovered.id as row_key
       from private.member_account_deletions recovered
      where recovered.status in ('authorized', 'processing')
        and recovered.failure_code = 'subject-key-rotated'
        and recovered.subject_hash_key_fingerprint = current_key_fingerprint
      limit 100
      for update skip locked
   )
  update private.member_account_deletions restored
     set failure_code = null
   where restored.id in (select picked.row_key from picked);

  for request in
    select candidate.*
    from private.member_account_deletions candidate
    where candidate.status = 'processing'
      and (
        candidate.auth_deleted_at is not null
        or (
          candidate.subject_hash_key_fingerprint = current_key_fingerprint
          and not exists (
            select 1
            from auth.users u
            where pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(u.id::text, 'UTF8'), key_snapshot, 'sha256'), 'hex') = candidate.subject_hash
          )
        )
      )
    order by coalesce(candidate.auth_deleted_at, candidate.claimed_at)
    limit least(greatest(coalesce(p_limit, 25), 0), 25)
    for update skip locked
  loop
    update private.member_account_deletions
       set status = 'completed',
           auth_deleted_at = coalesce(request.auth_deleted_at, now()),
           finalized_at = now(),
           failure_code = null
     where id = request.id;
    insert into private.member_account_lifecycle_audit (subject_hash, event_type)
    values (request.subject_hash, 'deletion_completed');
    reconciled := reconciled + 1;
  end loop;
  return reconciled;
end;
end;
$$;

-- private.purge_expired_member_event_checkin_tokens: latest definition 20260925620400_member_event_checkin_token_retention.sql; 1 limited locking subquery materialized.
create or replace function private.purge_expired_member_event_checkin_tokens()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare removed integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  with picked as materialized (
    select candidate.ctid as row_key
    from private.member_event_checkin_tokens as candidate
    where candidate.expires_at < pg_catalog.now() - interval '30 days'
    limit 20000
    for update skip locked
  )
  delete from private.member_event_checkin_tokens as stale
  where stale.ctid in (select picked.row_key from picked);
  get diagnostics removed = row_count;
  return removed;
end;
$function$;

-- private.purge_organization_claim_personal_data: latest definition 20260930040000_union_catalog_claims_verification.sql; 1 limited locking subquery materialized.
create or replace function private.purge_organization_claim_personal_data()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare removed integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Unconfirmed claims expire at their 24-hour deadline; open claims never
  -- decided (under review or held) expire 90 days after submission (C10
  -- default, owner may override). Expired is terminal and blocks nothing.
  with expiring as (
    select c.id, c.status as from_status
      from private.organization_claims as c
     where (c.status = 'awaiting_email' and c.confirm_expires_at < pg_catalog.now())
        or (c.status in ('under_review', 'held') and c.created_at < pg_catalog.now() - interval '90 days')
     limit 2000
     for update skip locked
  ), expired as (
    update private.organization_claims as c
       set status = 'expired',
           hold_reason = null,
           confirm_token_hash = null,
           closed_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
      from expiring
     where c.id = expiring.id
    returning c.id, c.organization_id, c.catalog_key, expiring.from_status
  )
  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, claim_id, organization_id, metadata, idempotency_key
  )
  select 'claim_expired', 'system', null, 'claim', expired.id, expired.organization_id,
         pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
           'catalogKey', expired.catalog_key, 'fromStatus', expired.from_status, 'toStatus', 'expired')),
         extensions.gen_random_uuid()
    from expired;

  with picked as materialized (
     select candidate.ctid as row_key
       from private.organization_claims as candidate
      where candidate.personal_data_purged_at is null
        and candidate.status in ('approved', 'rejected', 'expired', 'revoked')
        and (candidate.closed_at < pg_catalog.now()
               - case when candidate.status = 'expired' then interval '7 days' else interval '90 days' end
             -- An open claim expired at 90 days is purged in the same run.
             or (candidate.status = 'expired' and candidate.created_at < pg_catalog.now() - interval '90 days'))
      limit 2000
      for update skip locked
   )
  update private.organization_claims as c
     set claimant_name = null,
         claimant_title = null,
         claimant_email = null,
         statement = null,
         review_note = null,
         mailback_code_hmac = null,
         mailback_issued_at = null,
         mailback_expires_at = null,
         personal_data_purged_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where c.ctid in (select picked.row_key from picked);
  get diagnostics removed = row_count;
  return removed;
end;
$function$;

-- private.purge_expired_compass_training_samples: latest definition 20261027060200_compass_training_retention.sql; 1 limited locking subquery materialized.
create or replace function private.purge_expired_compass_training_samples() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  with picked as materialized (select id as row_key from private.compass_training_samples where expires_at <= pg_catalog.now() limit 20000 for update skip locked)
  delete from private.compass_training_samples where id in
    (select picked.row_key from picked);
  get diagnostics removed = row_count;
  return removed;
end;
$$;

commit;
