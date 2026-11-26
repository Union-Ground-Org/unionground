-- REQ-UG-INTAKE-QUEUE-STORE-INVITE-REQUESTS-AND-OPERATOR-READ-20261118
--
-- Owner request, November 18, 2026: one place to see the people who asked
-- Union Ground for updates, for an invite or to join, and to act on them.
-- Project decisions the same day: the queue lives in the app for platform
-- operators, and invite requests are stored (the support email stays).
--
-- 1. Invite requests are stored. /request-invite rows land in
--    public.public_interest_submissions as a third row shape (source
--    'request-invite', interest 'request_invite') through the service-only
--    public.submit_invite_request, behind the same durable limits,
--    Vault-keyed suppression check and lock as the join request. A confirmed
--    stop already deletes every row for the address, so it deletes these too.
-- 2. Every row gains the operator's follow-up fields: the status 'invited',
--    a private operator note and the time of the last status change.
-- 3. private.platform_operators accepts the capability 'intake_review'.
--    public.set_platform_operator_intake_review grants and revokes it, and
--    public.set_platform_operator keeps any other capability when it grants
--    or revokes claim_verification.
-- 4. The operator's queue: list, summary, export, status and note, each a
--    service-only function that requires an intake_review operator on a live
--    aal2 or verified-key session with a verified factor (the same session
--    rule as the claim verifier), reads only rows with organization_id NULL
--    (an organization's own leads stay that organization's), and writes one
--    private.intake_review_events row for every list, export, status and
--    note change. The summary returns counts only and is not logged.
--
-- Nothing here opens signup or creates an account, organization or
-- invitation.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------- 1. the row shapes and follow-up fields

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_interest_check;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_interest_check
  check (interest in ('chapter_updates', 'public_meetings', 'union_news', 'request_to_join', 'request_invite'));

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_source_check;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_source_check
  check (source in ('public-landing', 'request-to-join', 'request-invite'));

alter table public.public_interest_submissions
  drop constraint public_interest_submissions_status_check;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_status_check
  check (status in ('new', 'contacted', 'invited', 'closed'));

-- The invite form takes a name of up to 120 characters (api/_lib/inviteRequest.js).
alter table public.public_interest_submissions
  drop constraint public_interest_submissions_name_bounded;
alter table public.public_interest_submissions
  add constraint public_interest_submissions_name_bounded check (
    name is null or char_length(name) between 1 and 120
  );

alter table public.public_interest_submissions
  add column operator_note text,
  add column operator_note_updated_at timestamptz,
  add column status_changed_at timestamptz;

alter table public.public_interest_submissions
  add constraint public_interest_submissions_operator_note_bounded check (
    operator_note is null
    or (char_length(operator_note) between 1 and 2000
      and pg_catalog.translate(operator_note, pg_catalog.chr(10) || pg_catalog.chr(9), '') !~ '[[:cntrl:]]')
  );

comment on column public.public_interest_submissions.operator_note is
  'Platform operator follow-up note on a Union Ground lead (organization_id NULL). Deleted with the row by a confirmed stop.';
comment on column public.public_interest_submissions.status_changed_at is
  'When the platform operator last changed the status; NULL until the first change.';

-- One shape per source. A landing row carries none of the request fields.
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
      else
        interest not in ('request_to_join', 'request_invite')
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
  'Request to join or request an invite: the organization the requester typed. Never a claim about any affiliation of the operator.';

create index public_interest_submissions_union_ground_queue_idx
  on public.public_interest_submissions (source, status, last_submitted_at desc, id)
  where organization_id is null;

-- The join-request owner ledger keeps working when a row is Invited.
alter table private.join_request_access_events
  drop constraint join_request_access_events_status_filter_check,
  drop constraint join_request_access_events_from_status_check,
  drop constraint join_request_access_events_to_status_check;
alter table private.join_request_access_events
  add constraint join_request_access_events_status_filter_check
    check (status_filter is null or status_filter in ('new', 'contacted', 'invited', 'closed')),
  add constraint join_request_access_events_from_status_check
    check (from_status is null or from_status in ('new', 'contacted', 'invited', 'closed')),
  add constraint join_request_access_events_to_status_check
    check (to_status is null or to_status in ('new', 'contacted', 'invited', 'closed'));

-- ------------------------------------------------- 2. the intake review ledger

create table private.intake_review_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default pg_catalog.now(),
  action text not null check (action in ('operator_granted', 'operator_revoked', 'list', 'export', 'status', 'note')),
  actor_user_id uuid,
  subject_user_id uuid,
  idempotency_key uuid unique,
  kind_filter text check (kind_filter is null or kind_filter in ('updates', 'join', 'invite')),
  status_filter text check (status_filter is null or status_filter in ('new', 'contacted', 'invited', 'closed')),
  searched boolean,
  row_count integer check (row_count is null or row_count >= 0),
  submission_id uuid,
  from_status text check (from_status is null or from_status in ('new', 'contacted', 'invited', 'closed')),
  to_status text check (to_status is null or to_status in ('new', 'contacted', 'invited', 'closed')),
  constraint intake_review_events_shape check (
    (action in ('operator_granted', 'operator_revoked')
      and actor_user_id is null and subject_user_id is not null and idempotency_key is not null
      and kind_filter is null and status_filter is null and searched is null and row_count is null
      and submission_id is null and from_status is null and to_status is null)
    or
    (action in ('list', 'export')
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and searched is not null and row_count is not null
      and submission_id is null and from_status is null and to_status is null)
    or
    (action = 'status'
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and submission_id is not null and from_status is not null and to_status is not null
      and kind_filter is null and status_filter is null and searched is null and row_count is null)
    or
    (action = 'note'
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and submission_id is not null
      and kind_filter is null and status_filter is null and searched is null and row_count is null
      and from_status is null and to_status is null)
  )
);

alter table private.intake_review_events enable row level security;
alter table private.intake_review_events force row level security;
revoke all on private.intake_review_events from public, anon, authenticated, service_role;
revoke all on sequence private.intake_review_events_id_seq from public, anon, authenticated, service_role;

comment on table private.intake_review_events is
  'Audit of every intake_review operator grant, revoke, list, export, status and note change. Never holds a note body or an address. Written only by the service-role definer functions; no client grant.';

-- ------------------------------------------------- 3. the operator capability

alter table private.platform_operators
  drop constraint platform_operators_capabilities_check;
alter table private.platform_operators
  add constraint platform_operators_capabilities_check
  check (pg_catalog.cardinality(capabilities) >= 1
    and capabilities <@ array['claim_verification', 'intake_review']::text[]);

-- Same body as 20260930040000 except that a grant adds claim_verification to
-- an active row's other capabilities, and a revoke of a row that holds
-- another capability removes only claim_verification.
create or replace function public.set_platform_operator(
  p_user_id uuid,
  p_active boolean,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  replay record;
  note text;
  current_row private.platform_operators%rowtype;
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select e.subject_user_id, e.event_type into replay
    from private.catalog_review_events as e
   where e.idempotency_key = p_idempotency_key;
  if found then
    if replay.subject_user_id is distinct from p_user_id
       or replay.event_type not in ('operator_granted', 'operator_revoked')
       or replay.event_type is distinct from (
            case p_active when true then 'operator_granted' when false then 'operator_revoked' end) then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'active', replay.event_type = 'operator_granted', 'idempotent', true);
  end if;

  if p_user_id is null or p_active is null then
    raise exception 'operator invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users as u where u.id = p_user_id) then
    raise exception 'operator unavailable' using errcode = '22023';
  end if;
  select * into current_row from private.platform_operators as o where o.user_id = p_user_id for update;

  if p_active then
    note := pg_catalog.btrim(coalesce(p_note, ''));
    if pg_catalog.char_length(note) not between 1 and 240 or note ~ '[[:cntrl:]]' then
      raise exception 'note invalid' using errcode = '22023';
    end if;
    if current_row.user_id is null then
      insert into private.platform_operators (user_id, capabilities, granted_note)
      values (p_user_id, array['claim_verification'], note);
    elsif current_row.revoked_at is null then
      update private.platform_operators
         set capabilities = case
               when 'claim_verification' = any (current_row.capabilities) then current_row.capabilities
               else current_row.capabilities || 'claim_verification'::text
             end,
             granted_note = note,
             granted_at = pg_catalog.now()
       where user_id = p_user_id;
    else
      update private.platform_operators
         set capabilities = array['claim_verification'],
             granted_note = note,
             granted_at = pg_catalog.now(),
             revoked_at = null
       where user_id = p_user_id;
    end if;
  else
    if current_row.user_id is null then
      raise exception 'operator unavailable' using errcode = '22023';
    end if;
    if current_row.revoked_at is null
       and pg_catalog.array_remove(current_row.capabilities, 'claim_verification') <> array[]::text[] then
      update private.platform_operators
         set capabilities = pg_catalog.array_remove(current_row.capabilities, 'claim_verification')
       where user_id = p_user_id;
    else
      update private.platform_operators
         set revoked_at = pg_catalog.now()
       where user_id = p_user_id
         and revoked_at is null;
    end if;
  end if;

  insert into private.catalog_review_events (
    event_type, actor_kind, actor_user_id, subject_kind, subject_user_id, metadata, idempotency_key
  ) values (
    case when p_active then 'operator_granted' else 'operator_revoked' end,
    'system', null, 'operator', p_user_id, '{}'::jsonb, p_idempotency_key
  );

  return pg_catalog.jsonb_build_object('userId', p_user_id, 'active', p_active, 'idempotent', false);
end;
$function$;

revoke all on function public.set_platform_operator(uuid, boolean, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_platform_operator(uuid, boolean, text, uuid) to service_role;

create function public.set_platform_operator_intake_review(
  p_user_id uuid,
  p_active boolean,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  replay record;
  note text;
  current_row private.platform_operators%rowtype;
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select e.subject_user_id, e.action into replay
    from private.intake_review_events as e
   where e.idempotency_key = p_idempotency_key;
  if found then
    if replay.subject_user_id is distinct from p_user_id
       or replay.action is distinct from (
            case p_active when true then 'operator_granted' when false then 'operator_revoked' end) then
      raise exception 'idempotency key reused' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id, 'active', replay.action = 'operator_granted', 'idempotent', true);
  end if;

  if p_user_id is null or p_active is null then
    raise exception 'operator invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users as u where u.id = p_user_id) then
    raise exception 'operator unavailable' using errcode = '22023';
  end if;
  select * into current_row from private.platform_operators as o where o.user_id = p_user_id for update;

  if p_active then
    note := pg_catalog.btrim(coalesce(p_note, ''));
    if pg_catalog.char_length(note) not between 1 and 240 or note ~ '[[:cntrl:]]' then
      raise exception 'note invalid' using errcode = '22023';
    end if;
    if current_row.user_id is null then
      insert into private.platform_operators (user_id, capabilities, granted_note)
      values (p_user_id, array['intake_review'], note);
    elsif current_row.revoked_at is null then
      update private.platform_operators
         set capabilities = case
               when 'intake_review' = any (current_row.capabilities) then current_row.capabilities
               else current_row.capabilities || 'intake_review'::text
             end,
             granted_note = note,
             granted_at = pg_catalog.now()
       where user_id = p_user_id;
    else
      update private.platform_operators
         set capabilities = array['intake_review'],
             granted_note = note,
             granted_at = pg_catalog.now(),
             revoked_at = null
       where user_id = p_user_id;
    end if;
  else
    if current_row.user_id is null or current_row.revoked_at is not null
       or not ('intake_review' = any (current_row.capabilities)) then
      raise exception 'operator unavailable' using errcode = '22023';
    end if;
    if pg_catalog.array_remove(current_row.capabilities, 'intake_review') <> array[]::text[] then
      update private.platform_operators
         set capabilities = pg_catalog.array_remove(current_row.capabilities, 'intake_review')
       where user_id = p_user_id;
    else
      update private.platform_operators
         set revoked_at = pg_catalog.now()
       where user_id = p_user_id;
    end if;
  end if;

  insert into private.intake_review_events (action, subject_user_id, idempotency_key)
  values (case when p_active then 'operator_granted' else 'operator_revoked' end, p_user_id, p_idempotency_key);

  return pg_catalog.jsonb_build_object('userId', p_user_id, 'active', p_active, 'idempotent', false);
end;
$function$;

revoke all on function public.set_platform_operator_intake_review(uuid, boolean, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_platform_operator_intake_review(uuid, boolean, text, uuid) to service_role;

comment on function public.set_platform_operator_intake_review(uuid, boolean, text, uuid) is
  'Service-only grant or revoke of the intake_review platform operator capability; keeps any other capability; idempotent by key; one intake_review_events row per change.';

-- The claim verifier's session rule with the intake_review capability.
create function private.intake_review_require_operator(p_operator_user_id uuid, p_operator_session_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_operator_user_id is null or p_operator_session_id is null
     or exists (
       select 1 from private.member_mfa_recovery_locks as recovery
        where recovery.user_id = p_operator_user_id)
     or not exists (
       select 1 from auth.sessions as session
       left join private.member_mfa_reset_boundaries as boundary
         on boundary.user_id = session.user_id
        where session.id = p_operator_session_id
          and session.user_id = p_operator_user_id
          and (session.aal = 'aal2' or private.verified_key_session(p_operator_user_id, p_operator_session_id))
          and (session.not_after is null or session.not_after > pg_catalog.now())
          and session.created_at > coalesce(boundary.invalid_before, '-infinity'::timestamptz))
     or (not exists (
       select 1 from auth.mfa_factors as factor
        where factor.user_id = p_operator_user_id and factor.status = 'verified')
       and not private.verified_key_session(p_operator_user_id, p_operator_session_id))
     or not exists (
       select 1 from auth.users as u
        where u.id = p_operator_user_id
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
     or not exists (
       select 1 from private.platform_operators as operator
        where operator.user_id = p_operator_user_id
          and operator.revoked_at is null
          and 'intake_review' = any (operator.capabilities)) then
    raise exception 'intake reviewer required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.intake_review_require_operator(uuid, uuid) from public, anon, authenticated, service_role;

-- ------------------------------------------------- 4. the invite request write (service role only)

create function public.submit_invite_request(
  p_email text,
  p_name text,
  p_organization_name text,
  p_note text,
  p_locale text,
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
  organization_name text := nullif(pg_catalog.btrim(coalesce(p_organization_name, '')), '');
  note text := nullif(pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(coalesce(p_note, ''), pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)), pg_catalog.chr(13), pg_catalog.chr(10))), '');
  locale_value text := case when p_locale = 'es' then 'es' else 'en' end;
  moment timestamptz := clock_timestamp();
  derived_suppression_scope_hash text;
  network_allowed boolean;
  payload_invalid boolean;
  stored boolean := false;
  notify boolean := false;
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
    or organization_name is null
    or char_length(organization_name) not between 2 and 160
    or organization_name ~ '[[:cntrl:]]'
    or (note is not null and (char_length(note) > 1000
      or pg_catalog.translate(note, pg_catalog.chr(10), '') ~ '[[:cntrl:]]'));

  if network_allowed and not payload_invalid then
    -- The per-address day cap bounds the support emails, not the stored
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
    -- top of the queue; the operator's status and note stay.
    if not exists (
      select 1
      from private.public_interest_suppressions as suppression
      where suppression.suppression_scope_hash = derived_suppression_scope_hash
    ) then
      insert into public.public_interest_submissions (
        email, name, interest, locale, source, organization_name, note
      ) values (
        normalized_email, requester_name, 'request_invite', locale_value, 'request-invite',
        organization_name, note
      )
      on conflict (email, interest) do update
        set name = excluded.name,
            organization_name = excluded.organization_name,
            note = excluded.note,
            locale = excluded.locale,
            consent_at = moment,
            last_submitted_at = moment;
      stored := found;
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

  return pg_catalog.jsonb_build_object('accepted', true, 'stored', stored, 'notify', stored and notify);
end;
$$;

revoke all on function public.submit_invite_request(text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_invite_request(text, text, text, text, text, text, text, text)
  to service_role;

comment on function public.submit_invite_request(text, text, text, text, text, text, text, text) is
  'Service-only request-an-invite write: same durable limits, Vault-keyed suppression check and transaction lock as the landing form; one stored request per address, refreshed on every repeat; the per-address day cap only stops further support emails (notify); uniform accepted answer, stored and notify flags for the server only.';

-- ------------------------------------------------- 5. the operator queue (service role only)

-- The kind a row belongs to, from its source.
create function private.intake_review_kind(p_source text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_source
    when 'public-landing' then 'updates'
    when 'request-to-join' then 'join'
    when 'request-invite' then 'invite'
  end
$$;

revoke all on function private.intake_review_kind(text) from public, anon, authenticated, service_role;

create function private.intake_review_row(p_row public.public_interest_submissions)
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
    'status', p_row.status,
    'operatorNote', p_row.operator_note,
    'operatorNoteUpdatedAt', p_row.operator_note_updated_at,
    'statusChangedAt', p_row.status_changed_at,
    'consentAt', p_row.consent_at,
    'lastSubmittedAt', p_row.last_submitted_at,
    'createdAt', p_row.created_at
  )
$$;

revoke all on function private.intake_review_row(public.public_interest_submissions) from public, anon, authenticated, service_role;

-- Validates the shared filters and returns the search text (NULL for none).
create function private.intake_review_filters(p_kind text, p_status text, p_search text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  search_text text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
begin
  if p_kind is not null and p_kind not in ('updates', 'join', 'invite') then
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

revoke all on function private.intake_review_filters(text, text, text) from public, anon, authenticated, service_role;

-- Pages of at most p_limit (1 to 100), newest first, ordered by
-- (last_submitted_at desc, id). The keyset cursor is the last row of the
-- previous page, both parts. Search matches the address, name or
-- organization, case-insensitively, as plain text.
create function public.list_intake_requests(
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
        or pg_catalog.lower(coalesce(s.organization_name, '')) like pattern)
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
  'Service-only intake_review operator read of Union Ground leads (organization_id NULL): one keyset page of at most 100, filters by kind, status and search. Writes one intake_review_events row per call.';

-- Counts only, no contact details: per kind and status, per update topic
-- (rows and distinct people), and new requests per Eastern day for 90 days.
create function public.intake_request_summary(
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
      'day', d.day, 'updates', d.updates, 'join', d.joins, 'invite', d.invites) order by d.day), '[]'::jsonb)
  into daily
  from (
    select days.day::date as day,
      pg_catalog.count(*) filter (where s.source = 'public-landing')::integer as updates,
      pg_catalog.count(*) filter (where s.source = 'request-to-join')::integer as joins,
      pg_catalog.count(*) filter (where s.source = 'request-invite')::integer as invites
    from pg_catalog.generate_series(first_day::timestamp, today::timestamp, interval '1 day') as days(day)
    left join public.public_interest_submissions s
      on s.organization_id is null
     and s.created_at >= first_instant
     and (s.created_at at time zone 'America/New_York')::date = days.day::date
    group by days.day
  ) d;

  return pg_catalog.jsonb_build_object(
    'today', today,
    'counts', counts,
    'topics', topics,
    'updatePeople', people,
    'daily', daily
  );
end;
$$;

revoke all on function public.intake_request_summary(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.intake_request_summary(uuid, uuid) to service_role;

comment on function public.intake_request_summary(uuid, uuid) is
  'Service-only intake_review operator counts of Union Ground leads (organization_id NULL) by kind, status and topic, and new requests per Eastern day for the last 90 days. No contact details; not logged.';

-- Every matching row up to 5,000, newest first, for the operator's CSV.
create function public.export_intake_requests(
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
        or pg_catalog.lower(coalesce(s.organization_name, '')) like pattern)
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
  'Service-only intake_review operator export of up to 5,000 Union Ground leads (organization_id NULL) matching the list filters. Writes one intake_review_events row per call.';

-- One status change under a row lock. p_expected_status, when given, must be
-- the row's current status, so two open pages cannot silently overwrite each
-- other.
create function public.set_intake_request_status(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_id uuid,
  p_status text,
  p_expected_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_row public.public_interest_submissions%rowtype;
  previous_status text;
  moment timestamptz := clock_timestamp();
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_id is null then
    raise exception 'request id required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('new', 'contacted', 'invited', 'closed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_expected_status is not null and p_expected_status not in ('new', 'contacted', 'invited', 'closed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  select * into current_row
  from public.public_interest_submissions
  where id = p_id and organization_id is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'not-found');
  end if;
  if p_expected_status is not null and current_row.status <> p_expected_status then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'changed',
      'request', private.intake_review_row(current_row));
  end if;
  if current_row.status = p_status then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'unchanged',
      'request', private.intake_review_row(current_row));
  end if;
  previous_status := current_row.status;

  update public.public_interest_submissions
  set status = p_status, status_changed_at = moment
  where id = p_id
  returning * into current_row;

  insert into private.intake_review_events (action, actor_user_id, submission_id, from_status, to_status)
  values ('status', p_operator_user_id, p_id, previous_status, p_status);

  return pg_catalog.jsonb_build_object('updated', true, 'request', private.intake_review_row(current_row));
end;
$$;

revoke all on function public.set_intake_request_status(uuid, uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_intake_request_status(uuid, uuid, uuid, text, text) to service_role;

comment on function public.set_intake_request_status(uuid, uuid, uuid, text, text) is
  'Service-only intake_review operator status change of one Union Ground lead (new, contacted, invited, closed) under a row lock, with an optional expected status. Writes one intake_review_events row per change.';

-- The operator's private note. An empty note clears it.
create function public.set_intake_request_note(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_id uuid,
  p_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  current_row public.public_interest_submissions%rowtype;
  note_text text := nullif(pg_catalog.btrim(pg_catalog.replace(pg_catalog.replace(coalesce(p_note, ''), pg_catalog.chr(13) || pg_catalog.chr(10), pg_catalog.chr(10)), pg_catalog.chr(13), pg_catalog.chr(10))), '');
  moment timestamptz := clock_timestamp();
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_id is null then
    raise exception 'request id required' using errcode = '22023';
  end if;
  if note_text is not null and (char_length(note_text) > 2000
      or pg_catalog.translate(note_text, pg_catalog.chr(10) || pg_catalog.chr(9), '') ~ '[[:cntrl:]]') then
    raise exception 'invalid note' using errcode = '22023';
  end if;

  select * into current_row
  from public.public_interest_submissions
  where id = p_id and organization_id is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'not-found');
  end if;
  if current_row.operator_note is not distinct from note_text then
    return pg_catalog.jsonb_build_object('updated', false, 'refusal', 'unchanged',
      'request', private.intake_review_row(current_row));
  end if;

  update public.public_interest_submissions
  set operator_note = note_text, operator_note_updated_at = moment
  where id = p_id
  returning * into current_row;

  insert into private.intake_review_events (action, actor_user_id, submission_id)
  values ('note', p_operator_user_id, p_id);

  return pg_catalog.jsonb_build_object('updated', true, 'request', private.intake_review_row(current_row));
end;
$$;

revoke all on function public.set_intake_request_note(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_intake_request_note(uuid, uuid, uuid, text) to service_role;

comment on function public.set_intake_request_note(uuid, uuid, uuid, text) is
  'Service-only intake_review operator note on one Union Ground lead (up to 2,000 characters; empty clears). Writes one intake_review_events row per change, never the note text.';

notify pgrst, 'reload schema';

commit;
