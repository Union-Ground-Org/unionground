-- REQ-UG-INTAKE-QUEUE-FOUNDER-INVITATION-FROM-JOIN-ROW-20261118
-- An intake_review operator on a live stepped-up session uses the existing
-- founder function, unchanged. The email comes only from the join row. The
-- operator-typed name is passed only to that function, never stored in intake
-- or audit. Creation, link and status are atomic; repeats never send twice.
-- The route gates the new name collection/use on its legal release.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Fail closed before any DDL if a reviewed predecessor has changed.
-- pg_get_functiondef qualifies types consistently with the hosted apply.
set local search_path = pg_catalog;
do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.intake_review_row(public.public_interest_submissions)'))) is distinct from 'ae507f9ea38fbfb4c4c45a5df7bf3432' then
    raise exception 'unreviewed predecessor: private.intake_review_row' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.confirm_public_interest_stop(text,text)'))) is distinct from '42c41e4fa5e838e9bb34bcbab999b5b3' then
    raise exception 'unreviewed predecessor: public.confirm_public_interest_stop' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.stop_public_interest(text,text,text,text,text,text)'))) is distinct from '5dfc96add2ebff3a3321d54d6acb66e2' then
    raise exception 'unreviewed predecessor: public.stop_public_interest' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.resend_organization_founder_invitation(uuid,text)'))) is distinct from '2456e4107483ad37c514070002145012' then
    raise exception 'unreviewed predecessor: public.resend_organization_founder_invitation' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.record_organization_founder_invitation_delivery(uuid,integer,text)'))) is distinct from '833f9fbebe94bf0603e7c9df98840ac0' then
    raise exception 'unreviewed predecessor: public.record_organization_founder_invitation_delivery' using errcode = '55000';
  end if;
end;
$predecessor$;

-- Append-only ids, without a foreign key: audit evidence survives deletion of
-- the request or invitation, just like the neighboring pass audit ids.
alter table private.intake_review_events add column invitation_id uuid;
alter table private.intake_review_events drop constraint intake_review_events_action_check;
alter table private.intake_review_events add constraint intake_review_events_action_check
  check (action in ('operator_granted', 'operator_revoked', 'list', 'export', 'status', 'note', 'pass', 'founder_invite'));
alter table private.intake_review_events add constraint intake_review_events_founder_id_shape
  check ((action = 'founder_invite') = (invitation_id is not null));
alter table private.intake_review_events drop constraint intake_review_events_shape;
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
    or
    (action = 'founder_invite'
      and actor_user_id is not null and subject_user_id is null and idempotency_key is null
      and submission_id is not null and organization_id is not null and invitation_id is not null
      and member_request_id is null and from_status is not null and to_status = 'invited'
      and kind_filter is null and status_filter is null and searched is null and row_count is null)
  );

create unique index intake_review_events_one_founder_per_submission
  on private.intake_review_events(submission_id) where action = 'founder_invite';
comment on column private.intake_review_events.invitation_id is
  'Founder invitation issued from this join row; ids only, no contact details. Survives a confirmed stop as audit evidence.';

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
    'createdAt', p_row.created_at,
    'founderInvitation', (
      with recursive invitation_chain as (
        select i.id, i.status, i.expires_at, i.sent_at, i.delivery_version, i.created_at
        from private.intake_review_events e
        join public.member_invitations i on i.id = e.invitation_id
        where e.submission_id = p_row.id and e.action = 'founder_invite'
        union
        select i.id, i.status, i.expires_at, i.sent_at, i.delivery_version, i.created_at
        from public.member_invitations i join invitation_chain c on i.replaces_id = c.id
      )
      select pg_catalog.jsonb_build_object('id', i.id, 'status', i.status,
        'expiresAt', i.expires_at, 'sentAt', i.sent_at)
      from invitation_chain i
      order by i.delivery_version desc, i.created_at desc, i.id desc
      limit 1
    )
  )
$$;


revoke all on function private.intake_review_row(public.public_interest_submissions) from public, anon, authenticated, service_role;

create function public.create_intake_founder_invitation(
  p_operator_user_id uuid, p_operator_session_id uuid, p_id uuid,
  p_organization_name text, p_full_name text, p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  current_row public.public_interest_submissions%rowtype;
  scope_hash text;
  locked_email text;
  existing uuid;
  created jsonb;
  previous_status text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);
  if p_id is null then raise exception 'request id required' using errcode = '22023'; end if;

  -- Read without a row lock, then suppression BEFORE FOR UPDATE, like the
  -- form and stop. Recheck the row after both locks are held.
  select email into locked_email from public.public_interest_submissions
  where id = p_id and organization_id is null;
  if not found then return pg_catalog.jsonb_build_object('invited', false, 'refusal', 'not-found'); end if;
  scope_hash := private.public_interest_suppression_scope(locked_email);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public-interest-suppression:' || scope_hash, 509));
  select * into current_row from public.public_interest_submissions
  where id = p_id and organization_id is null for update;
  if not found or current_row.email is distinct from locked_email then
    return pg_catalog.jsonb_build_object('invited', false, 'refusal', 'not-found');
  end if;
  if current_row.source <> 'request-to-join' then
    return pg_catalog.jsonb_build_object('invited', false, 'refusal', 'not-join');
  end if;
  if exists (select 1 from private.public_interest_suppressions s where s.suppression_scope_hash = scope_hash) then
    return pg_catalog.jsonb_build_object('invited', false, 'refusal', 'stopped');
  end if;
  select e.invitation_id into existing from private.intake_review_events e
  where e.submission_id = p_id and e.action = 'founder_invite';
  if found then
    created := private.intake_review_row(current_row);
    return pg_catalog.jsonb_build_object('invited', true, 'repeated', true, 'send', false,
      'invitationId', coalesce((created #>> '{founderInvitation,id}')::uuid, existing), 'request', created);
  end if;
  if current_row.status = 'closed' then
    return pg_catalog.jsonb_build_object('invited', false, 'refusal', 'closed');
  end if;

  created := public.create_organization_founder_invitation(p_organization_name,
    current_row.email, p_full_name, current_row.locale, p_token_hash, p_id);
  if created ->> 'status' <> 'invited' then
    return pg_catalog.jsonb_build_object('invited', false, 'refusal', created ->> 'status');
  end if;
  previous_status := current_row.status;
  update public.public_interest_submissions set status = 'invited', status_changed_at = pg_catalog.clock_timestamp()
  where id = p_id returning * into current_row;
  insert into private.intake_review_events
    (action, actor_user_id, submission_id, organization_id, invitation_id, from_status, to_status)
  values ('founder_invite', p_operator_user_id, p_id, (created ->> 'organizationId')::uuid,
    (created ->> 'invitationId')::uuid, previous_status, 'invited');
  return created || pg_catalog.jsonb_build_object('invited', true, 'repeated', false,
    'normalizedEmail', current_row.email, 'locale', current_row.locale,
    'organizationName', (select o.name from public.organizations o where o.id = (created ->> 'organizationId')::uuid),
    'request', private.intake_review_row(current_row));
end;
end;
$function$;
revoke all on function public.create_intake_founder_invitation(uuid, uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.create_intake_founder_invitation(uuid, uuid, uuid, text, text, text) to service_role;
comment on function public.create_intake_founder_invitation(uuid, uuid, uuid, text, text, text) is
  'Service-only intake_review operator founder invitation from a join row: existing founder checks, atomic invitation audit link and invited status, suppression before row lock, no repeated send. Typed name passes only to the unchanged founder function. No account created; signup stays closed.';

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
  revoked_invitation record;
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

  -- Revoke the retained intake-issued founder chain even if a previous stop
  -- already removed the intake row. Accepted/accepting accounts are untouched.
  for revoked_invitation in
  with recursive chain(id) as (
    select e.invitation_id
    from private.intake_review_events e
    join public.member_invitations issued on issued.id = e.invitation_id
    where issued.normalized_email = pending_row.normalized_email and e.action = 'founder_invite'
    union
    select i.id from public.member_invitations i join chain c on i.replaces_id = c.id
  ), revoked as (
    update public.member_invitations i
    set status = 'revoked', token_hash = null, revoked_at = moment, failure_code = null
    where i.id in (select id from chain) and i.kind = 'founder' and i.invited_by is null
      and i.status in ('pending', 'delivery_failed', 'expired')
    returning i.id, i.chapter_id, i.delivery_version
  )
  select * from revoked
  loop
    perform private.audit_member_invitation(revoked_invitation.id, revoked_invitation.chapter_id, null, 'invite_revoked',
      pg_catalog.jsonb_build_object('chapterId', revoked_invitation.chapter_id,
        'deliveryVersion', revoked_invitation.delivery_version));
  end loop;

  delete from public.public_interest_submissions
  where email = pending_row.normalized_email;

  delete from private.public_interest_stop_confirmations
  where normalized_email = pending_row.normalized_email;

  return pg_catalog.jsonb_build_object('confirmed', true);
end;
$function$;


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
  revoked_invitation record;
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

    -- Revoke the retained intake-issued founder chain even if a previous stop
    -- already removed the intake row. Accepted/accepting accounts are untouched.
    for revoked_invitation in
    with recursive chain(id) as (
      select e.invitation_id
      from private.intake_review_events e
      join public.member_invitations issued on issued.id = e.invitation_id
      where issued.normalized_email = pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, ''))) and e.action = 'founder_invite'
      union
      select i.id from public.member_invitations i join chain c on i.replaces_id = c.id
    ), revoked as (
      update public.member_invitations i
      set status = 'revoked', token_hash = null, revoked_at = moment, failure_code = null
      where i.id in (select id from chain) and i.kind = 'founder' and i.invited_by is null
        and i.status in ('pending', 'delivery_failed', 'expired')
      returning i.id, i.chapter_id, i.delivery_version
    )
    select * from revoked
    loop
      perform private.audit_member_invitation(revoked_invitation.id, revoked_invitation.chapter_id, null, 'invite_revoked',
        pg_catalog.jsonb_build_object('chapterId', revoked_invitation.chapter_id,
          'deliveryVersion', revoked_invitation.delivery_version));
    end loop;

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

create or replace function public.resend_organization_founder_invitation(
  p_invitation_id uuid,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  org_id uuid;
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid founder invitation' using errcode = '22023';
  end if;

  select * into old_row
  from public.member_invitations
  where id = p_invitation_id and kind = 'founder' and invited_by is null
  for update;
  if not found or old_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'send', false);
  end if;

  -- Every operator-issued founder resend honors the platform stop ledger,
  -- including an accepting invitation whose acceptance failed after a stop.
  -- The graph gate already serializes this predicate with both stop paths.
  if exists (
    select 1 from private.public_interest_suppressions s
    where s.suppression_scope_hash = private.public_interest_suppression_scope(old_row.normalized_email)
  ) then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'send', false);
  end if;

  -- Once the organization has an administrator, the founder step is over:
  -- the administrator invites everyone else from the admin desk.
  select c.organization_id into org_id from public.chapters c where c.id = old_row.chapter_id;
  if exists (
    select 1 from public.organization_role_grants g
    where g.organization_id = org_id and g.role = 'admin'
  ) then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'send', false);
  end if;

  update public.member_invitations
  set status = 'superseded', token_hash = null, failure_code = null
  where id = old_row.id;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     replaces_id, expires_at, kind)
  values
    (old_row.normalized_email, old_row.full_name, old_row.first_name,
     old_row.initials, old_row.chapter_id, null, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, null, old_row.id,
     pg_catalog.clock_timestamp() + interval '15 minutes', 'founder')
  returning * into new_row;

  perform private.audit_member_invitation(
    new_row.id, new_row.chapter_id, null, 'invite_resent',
    pg_catalog.jsonb_build_object('chapterId', new_row.chapter_id,
      'deliveryVersion', new_row.delivery_version,
      'replacesInvitationId', old_row.id)
  );

  return pg_catalog.jsonb_build_object(
    'status', 'invited',
    'send', true,
    'organizationId', org_id,
    'invitationId', new_row.id,
    'deliveryVersion', new_row.delivery_version,
    'expiresAt', new_row.expires_at,
    'normalizedEmail', new_row.normalized_email,
    'fullName', new_row.full_name,
    'locale', new_row.locale);
end;
end;
$function$;

create or replace function public.record_organization_founder_invitation_delivery(
  p_invitation_id uuid,
  p_delivery_version integer,
  p_outcome text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  invitation_row public.member_invitations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'failed') then
    raise exception 'invalid delivery outcome' using errcode = '22023';
  end if;

  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and kind = 'founder'
    and invited_by is null
    and delivery_version = p_delivery_version
  for update;
  if not found or invitation_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;

  if p_outcome = 'sent' then
    update public.member_invitations
    set sent_at = pg_catalog.clock_timestamp()
    where id = invitation_row.id returning * into invitation_row;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_sent',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version)
    );
  else
    update public.member_invitations
    set status = 'delivery_failed', token_hash = null,
        expires_at = pg_catalog.clock_timestamp(), failure_code = 'provider_unavailable'
    where id = invitation_row.id returning * into invitation_row;
    perform private.audit_member_invitation(
      invitation_row.id, invitation_row.chapter_id, null, 'invite_delivery_failed',
      pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
        'deliveryVersion', invitation_row.delivery_version,
        'failureClass', 'provider_unavailable')
    );
  end if;
  return pg_catalog.jsonb_build_object('recorded', true, 'invitation',
    pg_catalog.jsonb_build_object('id', invitation_row.id, 'status', invitation_row.status,
      'expiresAt', invitation_row.expires_at, 'sentAt', invitation_row.sent_at));
end;
end;
$function$;

notify pgrst, 'reload schema';
commit;
