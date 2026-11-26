-- REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118
--
-- Project decision, November 18, 2026, 2:33 PM ET (option b): an invite request
-- from a person is answered by passing it to an existing organization's
-- administrators, who send the member invitation. Only an organization's
-- administrators invite members, as today; the platform operator creates no
-- account, no invitation and no organization.
--
-- 1. public.member_requests accepts a second kind of invitation suggestion:
--    one an intake_review operator passed on from a stored invite request.
--    It names the request (intake_submission_id) instead of a requesting
--    member, so requester_user_id is NULL on it and only on it. It is decided
--    exactly like a member's suggestion: it lands under Requests with the
--    people who may invite into the organization's default chapter, and
--    approving it creates the invitation through
--    public.approve_member_request_invitation (the invitation page's own
--    checks, limits and answers). The request's row cascades: a confirmed
--    stop of the address deletes the suggestion with it.
-- 2. private.intake_review_events records each pass ('pass'): the operator,
--    the request, the organization, the suggestion and the status move.
-- 3. Three service-only functions, each behind the intake_review operator
--    session check: a bounded organization search (name prefix, at most 20
--    active organizations), the pass itself, and the passes of up to 100
--    listed requests so the queue can show where each one went.
--
-- Nothing here opens signup or creates an account, an organization or an
-- invitation.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = pg_catalog, public;

-- Refuse unreviewed installed definitions before any schema or body change.
do $predecessors$
declare entry record;
begin
  for entry in select * from (values
    ('public.stop_public_interest(text,text,text,text,text,text)', 'bb16eb57c2cf44d8a6e99cb95f692051'),
    ('public.confirm_public_interest_stop(text,text)', '33f13e21e9ea03fcd4558a04da674c7e'),
    ('private.member_request_json(public.member_requests)', '665b32075ee4e66a7e1208942643e44b')
  ) reviewed(signature, definition_md5) loop
    if pg_catalog.md5(pg_catalog.pg_get_functiondef(entry.signature::regprocedure))
       is distinct from entry.definition_md5 then
      raise exception 'unreviewed intake predecessor: %', entry.signature using errcode='55000';
    end if;
  end loop;
end;
$predecessors$;

-- ------------------------------------------------- 1. the passed-on suggestion

alter table public.member_requests
  add column intake_submission_id uuid
    references public.public_interest_submissions(id) on update cascade on delete cascade;

alter table public.member_requests
  alter column requester_user_id drop not null;

-- A member's request names its member; a passed-on invite request names the
-- stored request instead, and is always an invitation suggestion.
alter table public.member_requests
  add constraint member_requests_requester_or_intake check (
    (intake_submission_id is null and requester_user_id is not null)
    or (intake_submission_id is not null and requester_user_id is null
      and kind = 'invitation_suggestion')
  );

-- The person's own note from the invite form is up to 1,000 characters; a
-- member's note stays at 500.
alter table public.member_requests
  drop constraint member_requests_note_bounded;
alter table public.member_requests
  add constraint member_requests_note_bounded check (
    note is null or (pg_catalog.char_length(note) between 1
        and case when intake_submission_id is null then 500 else 1000 end
      and note !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')
  );

-- One pass of a request to an organization, whatever its later decision.
create unique index member_requests_one_intake_pass_idx
  on public.member_requests (intake_submission_id, organization_id)
  where intake_submission_id is not null;

comment on column public.member_requests.intake_submission_id is
  'REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118: the stored invite request an intake_review operator passed to this organization (requester_user_id is NULL then). Deleted with that request, so a confirmed stop removes it.';

-- The request projection says whether a suggestion came from Union Ground's
-- intake queue, so Requests can say so instead of naming a member.
create or replace function private.member_request_json(p_row public.member_requests)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'kind', p_row.kind,
    'chapterId', p_row.chapter_id,
    'inviteeName', p_row.invitee_name,
    'inviteeEmail', p_row.invitee_email,
    'requestedRole', p_row.requested_role,
    'note', p_row.note,
    'status', p_row.status,
    'createdAt', p_row.created_at,
    'decidedAt', p_row.decided_at,
    'fromIntake', p_row.intake_submission_id is not null
  );
$function$;

revoke all on function private.member_request_json(public.member_requests)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------- 2. the pass in the intake ledger

alter table private.intake_review_events
  drop constraint intake_review_events_action_check;
alter table private.intake_review_events
  add constraint intake_review_events_action_check
  check (action in ('operator_granted', 'operator_revoked', 'list', 'export', 'status', 'note', 'pass'));

alter table private.intake_review_events
  add column organization_id uuid,
  add column member_request_id uuid;

alter table private.intake_review_events
  drop constraint intake_review_events_shape;
alter table private.intake_review_events
  add constraint intake_review_events_shape check (
    (action in ('operator_granted', 'operator_revoked')
      and actor_user_id is null and subject_user_id is not null and idempotency_key is not null
      and kind_filter is null and status_filter is null and searched is null and row_count is null
      and submission_id is null and from_status is null and to_status is null
      and organization_id is null and member_request_id is null)
    or
    (action in ('list', 'export')
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and searched is not null and row_count is not null
      and submission_id is null and from_status is null and to_status is null
      and organization_id is null and member_request_id is null)
    or
    (action = 'status'
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and submission_id is not null and from_status is not null and to_status is not null
      and kind_filter is null and status_filter is null and searched is null and row_count is null
      and organization_id is null and member_request_id is null)
    or
    (action = 'note'
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and submission_id is not null
      and kind_filter is null and status_filter is null and searched is null and row_count is null
      and from_status is null and to_status is null
      and organization_id is null and member_request_id is null)
    or
    (action = 'pass'
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and submission_id is not null and organization_id is not null and member_request_id is not null
      and from_status is not null and to_status is not null
      and kind_filter is null and status_filter is null and searched is null and row_count is null)
  );

comment on column private.intake_review_events.organization_id is
  'pass: the organization the invite request was passed to.';
comment on column private.intake_review_events.member_request_id is
  'pass: the invitation suggestion the pass created in public.member_requests.';

-- ------------------------------------------------- 3. the operator's functions (service role only)

-- The organization's default chapter, where a passed-on suggestion lands.
create function private.intake_pass_chapter(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select c.id
  from public.chapters c
  where c.organization_id = p_organization_id and c.is_default
  order by c.order_index, c.id
  limit 1
$function$;

revoke all on function private.intake_pass_chapter(uuid) from public, anon, authenticated, service_role;

create function private.intake_pass_json(p_row public.member_requests)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'submissionId', p_row.intake_submission_id,
    'organizationId', p_row.organization_id,
    'organizationName', (select o.name from public.organizations o where o.id = p_row.organization_id),
    'chapterName', (select c.name from public.chapters c where c.id = p_row.chapter_id),
    'status', p_row.status,
    'passedAt', p_row.created_at,
    'decidedAt', p_row.decided_at
  )
$function$;

revoke all on function private.intake_pass_json(public.member_requests) from public, anon, authenticated, service_role;

-- Active organizations whose name starts with the typed text (2 to 120
-- characters, case-insensitive), at most 20, by name. Only organizations
-- with a default chapter are listed: a pass lands there. Organization names
-- only; not logged.
create function public.search_intake_pass_organizations(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_prefix text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  prefix text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_prefix, '')));
  found_rows jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if pg_catalog.char_length(prefix) not between 2 and 120 or prefix ~ '[[:cntrl:]]' then
    raise exception 'invalid search' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', picked.id, 'name', picked.name)
           order by picked.sort_name, picked.id), '[]'::jsonb)
    into found_rows
  from (
    select o.id, o.name, pg_catalog.lower(o.name) as sort_name
    from public.organizations o
    where o.status = 'active'
      and pg_catalog.starts_with(pg_catalog.lower(o.name), prefix)
      and private.intake_pass_chapter(o.id) is not null
    order by pg_catalog.lower(o.name), o.id
    limit 20
  ) picked;

  return pg_catalog.jsonb_build_object('organizations', found_rows);
end;
$function$;

revoke all on function public.search_intake_pass_organizations(uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.search_intake_pass_organizations(uuid, uuid, text) to service_role;

comment on function public.search_intake_pass_organizations(uuid, uuid, text) is
  'REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118: service-only intake_review operator search of active organizations with a default chapter by name prefix (2 to 120 characters), at most 20, names only; not logged.';

-- Passes one stored invite request to an organization's administrators as an
-- invitation suggestion under Requests. Refusals answer without a change:
-- not-found, not-invite (any other kind of row), stopped (the address asked
-- to stop), organization-unavailable (unknown, not active or no default
-- chapter), no-administrator (nobody there may decide it), unsuitable (the
-- stored details do not fit a suggestion). A repeat for the same request and
-- organization answers with the first pass and changes nothing. A pass moves
-- the request to contacted unless it is already invited or closed.
create function public.pass_intake_invite_request(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  current_row public.public_interest_submissions%rowtype;
  existing public.member_requests%rowtype;
  saved public.member_requests%rowtype;
  organization_row public.organizations%rowtype;
  target_chapter text;
  target_chapter_name text;
  previous_status text;
  next_status text;
  scope_hash text;
  request_email text;
  recipient uuid;
  recipient_count integer := 0;
  moment timestamptz := clock_timestamp();
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_id is null then
    raise exception 'request id required' using errcode = '22023';
  end if;
  if p_organization_id is null then
    raise exception 'organization id required' using errcode = '22023';
  end if;

  -- The form and the stop take this address lock before changing its row.
  -- Read without a row lock, acquire that same lock, then read and re-check.
  select email into request_email
  from public.public_interest_submissions
  where id = p_id and organization_id is null;
  if not found then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'not-found');
  end if;

  scope_hash := private.public_interest_suppression_scope(request_email);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public-interest-suppression:' || scope_hash, 509));

  select * into current_row
  from public.public_interest_submissions
  where id = p_id and organization_id is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'not-found');
  end if;
  if current_row.email is distinct from request_email then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'changed');
  end if;
  if current_row.source <> 'request-invite' then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'not-invite');
  end if;
  if exists (
    select 1 from private.public_interest_suppressions as suppression
    where suppression.suppression_scope_hash = scope_hash
  ) then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'stopped');
  end if;

  select * into existing
  from public.member_requests r
  where r.intake_submission_id = p_id and r.organization_id = p_organization_id;
  if found then
    return pg_catalog.jsonb_build_object('passed', true, 'repeated', true,
      'pass', private.intake_pass_json(existing), 'request', private.intake_review_row(current_row));
  end if;

  select * into organization_row
  from public.organizations o
  where o.id = p_organization_id and o.status = 'active';
  target_chapter := case when organization_row.id is not null then private.intake_pass_chapter(organization_row.id) end;
  if organization_row.id is null or target_chapter is null then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'organization-unavailable');
  end if;

  -- Match the invitation decision roles, not just notification recipients:
  -- chapter admins/Presidents and organization admins need active membership
  -- in the target chapter; an organization President may preside across it.
  select pg_catalog.count(*) into recipient_count
  from private.member_request_recipients('invitation_suggestion', organization_row.id, target_chapter) as candidate(user_id)
  join auth.users as candidate_user on candidate_user.id = candidate.user_id
    and candidate_user.deleted_at is null
    and (candidate_user.banned_until is null or candidate_user.banned_until <= moment)
  where exists (
    select 1 from public.member_chapter_memberships as membership
    where membership.user_id = candidate.user_id and membership.chapter_id = target_chapter
      and membership.status = 'active'
  ) or (
    exists (select 1 from public.organization_role_grants as grant_row
      where grant_row.user_id = candidate.user_id and grant_row.organization_id = organization_row.id and grant_row.role = 'vp')
    and exists (select 1 from public.member_chapter_memberships as membership
      join public.chapters as chapter on chapter.id = membership.chapter_id and chapter.organization_id = organization_row.id
      where membership.user_id = candidate.user_id and membership.status = 'active')
  );
  if recipient_count = 0 then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'no-administrator');
  end if;

  -- The stored request already holds the invite form's bounds; anything that
  -- still does not fit a suggestion is refused rather than altered.
  if current_row.name is null
     or pg_catalog.char_length(pg_catalog.btrim(current_row.name)) not between 2 and 120
     or current_row.name ~ '[[:cntrl:]]'
     or current_row.email is distinct from pg_catalog.lower(pg_catalog.btrim(current_row.email))
     or pg_catalog.char_length(current_row.email) not between 3 and 254
     or current_row.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (current_row.note is not null and (pg_catalog.char_length(current_row.note) > 1000
       or current_row.note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')) then
    return pg_catalog.jsonb_build_object('passed', false, 'refusal', 'unsuitable');
  end if;

  insert into public.member_requests (
    organization_id, chapter_id, kind, requester_user_id, invitee_name, invitee_email, note, intake_submission_id
  ) values (
    organization_row.id, target_chapter, 'invitation_suggestion', null,
    pg_catalog.btrim(current_row.name), current_row.email, nullif(pg_catalog.btrim(current_row.note), ''), p_id
  )
  returning * into saved;

  previous_status := current_row.status;
  next_status := case when previous_status in ('invited', 'closed') then previous_status else 'contacted' end;
  if next_status <> previous_status then
    update public.public_interest_submissions
    set status = next_status, status_changed_at = moment
    where id = p_id
    returning * into current_row;
  end if;

  insert into private.intake_review_events
    (action, actor_user_id, submission_id, organization_id, member_request_id, from_status, to_status)
  values ('pass', p_operator_user_id, p_id, organization_row.id, saved.id, previous_status, next_status);

  select c.name into target_chapter_name from public.chapters c where c.id = target_chapter;
  for recipient in
    select * from private.member_request_recipients('invitation_suggestion', organization_row.id, target_chapter)
  loop
    perform private.notify_member(recipient, 'requests.invitation_suggested',
      pg_catalog.jsonb_build_object('member', 'Union Ground', 'chapter', coalesce(target_chapter_name, target_chapter)),
      'general');
  end loop;

  return pg_catalog.jsonb_build_object('passed', true, 'repeated', false,
    'pass', private.intake_pass_json(saved), 'request', private.intake_review_row(current_row));
end;
end;
$function$;

revoke all on function public.pass_intake_invite_request(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.pass_intake_invite_request(uuid, uuid, uuid, uuid) to service_role;

comment on function public.pass_intake_invite_request(uuid, uuid, uuid, uuid) is
  'REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118: service-only intake_review operator pass of one stored invite request (organization_id NULL) to an active organization''s administrators as an invitation suggestion in its default chapter; refuses other kinds, stopped addresses, unavailable organizations and organizations with nobody to decide it; one pass per request and organization; moves the request to contacted (unless invited or closed); one intake_review_events row per pass; notifies the deciders. Creates no account or invitation.';

-- Where each of up to 100 listed requests was passed, newest first per
-- request. Organization names and decision states only; not logged (the
-- list that showed the rows is).
create function public.list_intake_request_passes(
  p_operator_user_id uuid,
  p_operator_session_id uuid,
  p_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_rows jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_ids is null or pg_catalog.cardinality(p_ids) not between 1 and 100 or pg_catalog.array_position(p_ids, null) is not null then
    raise exception 'invalid request ids' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.jsonb_agg(private.intake_pass_json(r) order by r.intake_submission_id, r.created_at desc, r.id),
           '[]'::jsonb)
    into found_rows
  from public.member_requests r
  join public.public_interest_submissions s
    on s.id = r.intake_submission_id and s.organization_id is null
  where r.intake_submission_id = any (p_ids);

  return pg_catalog.jsonb_build_object('passes', found_rows);
end;
$function$;

revoke all on function public.list_intake_request_passes(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.list_intake_request_passes(uuid, uuid, uuid[]) to service_role;

comment on function public.list_intake_request_passes(uuid, uuid, uuid[]) is
  'REQ-UG-INTAKE-QUEUE-SEND-INVITATION-FROM-ROW-20261118: service-only intake_review operator read of where up to 100 Union Ground invite requests were passed (organization, chapter, decision state); not logged.';

notify pgrst, 'reload schema';

-- The stop cascades into member_requests now. After rate and token checks,
-- take the case graph gate before the suppression lock and request deletion.
-- Every other line of Main's bounded-cleanup body is preserved.
create or replace function public.confirm_public_interest_stop(p_token_hash text, p_scope_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
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
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
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
$function$;

revoke all on function public.confirm_public_interest_stop(text, text) from public, anon, authenticated, service_role;
grant execute on function public.confirm_public_interest_stop(text, text) to service_role;

-- The retained service-only immediate stop follows the same gate/suppression
-- order as a pass. Its newest predecessor is 20260831105356_public_interest_suppression.sql;
-- the accepted mutation gains the gate line; ledger 572 also picks stale limit
-- rows once, preserving the rest of the predecessor body.
create or replace function public.stop_public_interest(
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
as $function$
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
    perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
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
    'accepted', network_allowed and email_allowed and not payload_invalid
  );
end;
$function$;

revoke all on function public.stop_public_interest(text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.stop_public_interest(text, text, text, text, text, text)
  to service_role;

commit;
