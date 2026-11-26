-- UB-HUB-02: generated member export, fail-closed self-service deletion, and
-- account-deletion semantics that do not destroy chapter records or another
-- member's appointment. The trusted HTTP endpoint owns the GoTrue Admin call;
-- PostgreSQL owns caller authorization, one-time claim, and bounded evidence.

set local lock_timeout = '5s';

create table private.member_account_lifecycle_secret (
  id boolean primary key default true check (id),
  secret bytea not null check (pg_catalog.length(secret) = 32)
);

insert into private.member_account_lifecycle_secret (id, secret)
values (true, extensions.gen_random_bytes(32));

create table private.member_account_deletions (
  id uuid primary key default extensions.gen_random_uuid(),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('authorized', 'processing', 'completed', 'failed')),
  authorized_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  finalized_at timestamptz,
  failure_code text check (failure_code is null or char_length(failure_code) <= 64),
  check (expires_at > authorized_at),
  check ((status = 'authorized' and claimed_at is null and finalized_at is null)
      or (status = 'processing' and claimed_at is not null and finalized_at is null)
      or (status in ('completed', 'failed') and finalized_at is not null))
);

create unique index member_account_deletions_one_active_subject
  on private.member_account_deletions(subject_hash)
  where status in ('authorized', 'processing');

create table private.member_account_lifecycle_audit (
  id bigint generated always as identity primary key,
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  event_type text not null check (event_type in (
    'export_generated', 'deletion_authorized', 'deletion_claimed',
    'deletion_completed', 'deletion_failed')),
  record_count integer check (record_count is null or record_count between 0 and 1000000),
  created_at timestamptz not null default now()
);

revoke all on private.member_account_lifecycle_secret from public, anon, authenticated, service_role;
revoke all on private.member_account_deletions from public, anon, authenticated, service_role;
revoke all on private.member_account_lifecycle_audit from public, anon, authenticated, service_role;

create function private.member_lifecycle_subject_hash(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.hmac(
      pg_catalog.convert_to(p_user_id::text, 'UTF8'),
      secret.secret,
      'sha256'),
    'hex')
  from private.member_account_lifecycle_secret secret
  where secret.id
$$;

revoke all on function private.member_lifecycle_subject_hash(uuid) from public, anon, authenticated, service_role;

-- The export is assembled wholly under caller identity. Explicit projections
-- intentionally omit token hashes, push endpoints/keys, factor/session data,
-- and co-signer invitation addresses. Nothing below reads another account's
-- email address.
create function public.get_member_data_export()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  exported jsonb;
  records integer := 0;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object('schemaVersion', 1,
    'generatedAt', now(),
    'account', pg_catalog.jsonb_build_object(
      'userId', caller,
      'email', (select u.email from auth.users u where u.id = caller),
      'profile', coalesce((
        select pg_catalog.jsonb_build_object(
          'firstName', p.first_name, 'fullName', p.full_name,
          'initials', p.initials, 'roleLine', p.role_line,
          'memberSince', p.member_since, 'language', p.language,
          'chapterId', p.chapter_id, 'createdAt', p.created_at,
          'updatedAt', p.updated_at)
        from public.member_profiles p where p.id = caller
      ), '{}'::jsonb),
      'roles', coalesce((select pg_catalog.jsonb_agg(r.role order by r.role)
        from public.member_roles r where r.user_id = caller), '[]'::jsonb)
    ),
    'notifications', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind,
      'readAt', n.read_at, 'createdAt', n.created_at) order by n.created_at)
      from public.member_notifications n where n.user_id = caller), '[]'::jsonb),
    'conversations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'title', c.title, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'senderKind', m.sender_kind, 'senderName', m.sender_name,
        'body', m.body, 'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)
        from public.member_messages m where m.conversation_id = c.id and m.user_id = caller), '[]'::jsonb)
      ) order by c.created_at) from public.member_conversations c where c.user_id = caller), '[]'::jsonb),
    'cases', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'reference', c.reference, 'title', c.title, 'deadline', c.deadline,
      'caseType', c.case_type, 'articles', c.articles, 'step', c.step,
      'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'updates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'body', u.body, 'createdAt', u.created_at) order by u.created_at)
        from public.member_case_updates u where u.case_id = c.id and u.user_id = caller), '[]'::jsonb)
      ) order by c.created_at) from public.member_cases c where c.user_id = caller), '[]'::jsonb),
    'forms', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'templateKey', f.template_key, 'templateVersion', f.template_version,
      'status', f.status, 'answers', f.answers, 'step', f.step,
      'reviewNote', f.review_note, 'reviewedAt', f.reviewed_at,
      'submittedAt', f.submitted_at, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
      'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'status', c.status, 'invitedAt', c.invited_at, 'respondedAt', c.responded_at)
        order by c.invited_at) from public.member_form_cosigners c where c.form_id = f.id), '[]'::jsonb)
      ) order by f.created_at) from public.member_forms f where f.user_id = caller), '[]'::jsonb),
    'participation', pg_catalog.jsonb_build_object(
      'ballotReceipts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ballotId', r.ballot_id, 'receiptCode', r.receipt_code,
        'counted', r.counted, 'issuedAt', r.issued_at) order by r.issued_at)
        from public.member_ballot_receipts r where r.user_id = caller), '[]'::jsonb),
      'surveyResponses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'surveyId', s.survey_id, 'optionId', s.option_id, 'submittedAt', s.submitted_at)
        order by s.submitted_at) from public.member_survey_responses s where s.user_id = caller), '[]'::jsonb),
      'rightsProgress', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lessonId', r.lesson_id, 'completedSteps', r.completed_steps, 'updatedAt', r.updated_at)
        order by r.updated_at) from public.member_rights_progress r where r.user_id = caller), '[]'::jsonb),
      'eventRsvps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', r.event_id, 'status', r.status, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_event_rsvps r where r.user_id = caller), '[]'::jsonb),
      'eventCheckins', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', c.event_id, 'checkedInAt', c.checked_in_at) order by c.checked_in_at)
        from public.member_event_checkins c where c.user_id = caller), '[]'::jsonb)
    ),
    'support', pg_catalog.jsonb_build_object(
      'stewardRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'lessonId', r.lesson_id, 'status', r.status,
        'createdAt', r.created_at, 'acknowledgedAt', r.acknowledged_at, 'closedAt', r.closed_at)
        order by r.created_at) from public.member_steward_requests r where r.user_id = caller), '[]'::jsonb),
      'appointments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'chapterId', a.chapter_id, 'appointmentType', a.appointment_type,
        'durationMinutes', a.duration_minutes, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
        'status', a.status, 'routedVia', a.routed_via, 'reasonCategory', a.reason_category,
        'createdAt', a.created_at, 'updatedAt', a.updated_at) order by a.created_at)
        from public.member_appointments a where a.user_id = caller), '[]'::jsonb),
      'intakeReports', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id, 'chapterId', i.chapter_id, 'category', i.category, 'title', i.title,
        'details', i.details, 'status', i.status, 'createdAt', i.created_at, 'updatedAt', i.updated_at)
        order by i.created_at) from public.member_intake_reports i where i.reporter_id = caller), '[]'::jsonb),
      'dataRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'chapterId', g.chapter_id, 'requestType', g.request_type,
        'details', g.details, 'status', g.status, 'response', g.response,
        'createdAt', g.created_at, 'updatedAt', g.updated_at) order by g.created_at)
        from public.chapter_governance_requests g where g.requester_id = caller), '[]'::jsonb)
    ),
    'compass', pg_catalog.jsonb_build_object(
      'threads', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'title', t.title, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
        'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', m.id, 'role', m.role, 'body', m.body, 'sources', m.sources, 'createdAt', m.created_at)
          order by m.created_at) from public.member_guide_messages m
          where m.thread_id = t.id and m.user_id = caller), '[]'::jsonb)) order by t.created_at)
        from public.member_guide_threads t where t.user_id = caller), '[]'::jsonb),
      'requestHistory', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'createdAt', r.created_at, 'role', r.compass_role,
        'limit', r.compass_limit, 'dispatchAuthorizedAt', r.dispatch_authorized_at)
        order by r.created_at) from public.member_ai_requests r where r.user_id = caller), '[]'::jsonb)
    ),
    'activity', pg_catalog.jsonb_build_object(
      'points', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', p.action_key, 'actionKind', p.action_kind,
        'points', p.points, 'occurredAt', p.occurred_at) order by p.occurred_at)
        from public.member_point_events p where p.user_id = caller), '[]'::jsonb),
      'rewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'itemKey', r.item_key, 'status', r.status, 'source', r.source,
        'reason', r.reason, 'note', r.note, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_reward_grants r where r.user_id = caller), '[]'::jsonb),
      'workload', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(w) - 'user_id' order by w.created_at)
        from public.member_workload_logs w where w.user_id = caller), '[]'::jsonb),
      'actions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', a.action_key, 'actionKind', a.action_kind, 'occurredAt', a.occurred_at)
        order by a.occurred_at) from public.member_action_log a where a.user_id = caller), '[]'::jsonb)
    ),
    'chapterParticipation', pg_catalog.jsonb_build_object(
      'spaceMemberships', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', m.space_id, 'role', m.role, 'notificationLevel', m.notification_level,
        'joinedAt', m.joined_at) order by m.joined_at)
        from public.chapter_space_members m where m.user_id = caller), '[]'::jsonb),
      'taskAssignments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'taskId', a.task_id, 'chapterId', a.chapter_id, 'position', a.position, 'assignedAt', a.assigned_at)
        order by a.assigned_at) from public.chapter_task_assignments a where a.assignee_id = caller), '[]'::jsonb),
      'taskComments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'taskId', c.task_id, 'chapterId', c.chapter_id,
        'body', c.body, 'createdAt', c.created_at) order by c.created_at)
        from public.chapter_task_comments c where c.author_id = caller), '[]'::jsonb),
      'taskMessages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'taskId', m.task_id, 'chapterId', m.chapter_id,
        'direction', case when m.sender_id = caller then 'sent' else 'received' end,
        'body', m.body, 'createdAt', m.created_at) order by m.created_at)
        from public.chapter_task_messages m where m.sender_id = caller or m.recipient_id = caller), '[]'::jsonb)
    )
  ) into exported;

  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(value)), 0)::integer
    into records
  from pg_catalog.jsonb_each(exported) section
  where pg_catalog.jsonb_typeof(value) = 'array';

  insert into private.member_account_lifecycle_audit (subject_hash, event_type, record_count)
  values (private.member_lifecycle_subject_hash(caller), 'export_generated', records);

  return exported || pg_catalog.jsonb_build_object('topLevelRecordCount', records);
end;
$$;

create function public.authorize_member_account_deletion(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  session_id_text text := (select auth.jwt() ->> 'session_id');
  subject text;
  plain_token text;
  request_id uuid;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_confirmation <> 'DELETE MY ACCOUNT' then
    raise exception 'confirmation required' using errcode = '42501';
  end if;
  if (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
    raise exception 'recent second-factor verification required' using errcode = '42501';
  end if;
  if session_id_text is null or session_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'recent second-factor verification required' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from auth.sessions s
    join auth.mfa_amr_claims amr on amr.session_id = s.id
    where s.id = session_id_text::uuid
      and s.user_id = caller
      and s.aal = 'aal2'
      and amr.authentication_method in ('totp', 'webauthn')
      and greatest(amr.created_at, amr.updated_at) >= now() - interval '10 minutes'
  ) then
    raise exception 'recent second-factor verification required' using errcode = '42501';
  end if;

  subject := private.member_lifecycle_subject_hash(caller);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-account-delete:' || caller::text, 509));
  update private.member_account_deletions
     set status = 'failed', finalized_at = now(), failure_code = case
       when status = 'authorized' then 'authorization-expired' else 'processing-timeout' end
   where subject_hash = subject
     and ((status = 'authorized' and expires_at <= now())
       or (status = 'processing' and claimed_at < now() - interval '10 minutes'));
  if exists (select 1 from private.member_account_deletions
             where subject_hash = subject and status in ('authorized', 'processing')) then
    raise exception 'deletion already in progress' using errcode = '55000';
  end if;

  plain_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.member_account_deletions (subject_hash, token_hash, status, expires_at)
  values (subject, pg_catalog.encode(extensions.digest(plain_token, 'sha256'), 'hex'),
          'authorized', now() + interval '5 minutes')
  returning id into request_id;
  insert into private.member_account_lifecycle_audit (subject_hash, event_type)
  values (subject, 'deletion_authorized');

  return pg_catalog.jsonb_build_object(
    'requestId', request_id,
    'deletionToken', plain_token,
    'userId', caller,
    'expiresInSeconds', 300);
end;
$$;

create function public.claim_member_account_deletion(p_request_id uuid, p_user_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request private.member_account_deletions%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null or p_user_id is null
     or p_token is null or pg_catalog.length(p_token) <> 64
     or p_token !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('claimed', false);
  end if;
  select * into request
  from private.member_account_deletions
  where id = p_request_id
  for update;
  if not found
     or request.status <> 'authorized'
     or request.expires_at <= now()
     or request.subject_hash <> private.member_lifecycle_subject_hash(p_user_id)
     or request.token_hash <> pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex') then
    return pg_catalog.jsonb_build_object('claimed', false);
  end if;
  update private.member_account_deletions
     set status = 'processing', claimed_at = now()
   where id = p_request_id;
  insert into private.member_account_lifecycle_audit (subject_hash, event_type)
  values (request.subject_hash, 'deletion_claimed');
  return pg_catalog.jsonb_build_object('claimed', true);
end;
$$;

create function public.finalize_member_account_deletion(p_request_id uuid, p_token text, p_succeeded boolean, p_failure_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  request private.member_account_deletions%rowtype;
  normalized_failure text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null or p_token is null or pg_catalog.length(p_token) <> 64
     or p_token !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;
  if p_succeeded is not true then
    normalized_failure := case p_failure_code
      when 'auth-delete-refused' then p_failure_code
      when 'auth-service-unavailable' then p_failure_code
      else 'unknown'
    end;
  end if;
  select * into request
  from private.member_account_deletions
  where id = p_request_id
  for update;
  if not found or request.status <> 'processing'
     or request.token_hash <> pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex') then
    return pg_catalog.jsonb_build_object('recorded', false);
  end if;
  update private.member_account_deletions
     set status = case when p_succeeded is true then 'completed' else 'failed' end,
         finalized_at = now(),
         failure_code = normalized_failure
   where id = p_request_id;
  insert into private.member_account_lifecycle_audit (subject_hash, event_type)
  values (request.subject_hash,
          case when p_succeeded is true then 'deletion_completed' else 'deletion_failed' end);
  return pg_catalog.jsonb_build_object('recorded', true);
end;
$$;

-- The product identity trigger normally makes authorship immutable. A
-- referential ON DELETE SET NULL is also an UPDATE, however, so the old
-- implementation restored the deleted UUID inside the cascade and made the
-- auth-user delete fail. Permit only a nested FK action that is already
-- nulling the author column; ordinary client updates still preserve OLD.
create or replace function private.stamp_product_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_chapter text := private.current_member_chapter();
  detaching_identity boolean := pg_catalog.pg_trigger_depth() > 1;
begin
  if tg_op = 'INSERT' then
    new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('chapter_id', member_chapter));
    if tg_table_name = 'chapter_spaces' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('created_by', auth.uid()));
    elsif tg_table_name = 'chapter_threads' then
      select s.chapter_id into member_chapter from public.chapter_spaces s where s.id = new.space_id;
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('chapter_id', member_chapter, 'created_by', auth.uid()));
    elsif tg_table_name = 'chapter_thread_posts' then
      select t.chapter_id into member_chapter from public.chapter_threads t where t.id = new.thread_id;
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('chapter_id', member_chapter, 'author_id', auth.uid()));
    elsif tg_table_name = 'member_intake_reports' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('reporter_id', auth.uid()));
    elsif tg_table_name in ('chapter_documents', 'chapter_records') then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('created_by', auth.uid()));
    elsif tg_table_name = 'chapter_handshakes' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('requested_by', auth.uid()));
    elsif tg_table_name = 'chapter_governance_requests' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('requester_id', auth.uid()));
    end if;
  else
    new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('chapter_id', old.chapter_id));
    if tg_table_name = 'chapter_spaces' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object(
        'created_by', case when detaching_identity and new.created_by is null and not exists
          (select 1 from auth.users u where u.id = old.created_by) then null else old.created_by end,
        'created_at', old.created_at));
    elsif tg_table_name = 'chapter_threads' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object(
        'space_id', old.space_id,
        'created_by', case when detaching_identity and new.created_by is null and not exists
          (select 1 from auth.users u where u.id = old.created_by) then null else old.created_by end,
        'created_at', old.created_at));
    elsif tg_table_name = 'chapter_thread_posts' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object(
        'thread_id', old.thread_id,
        'author_id', case when detaching_identity and new.author_id is null and not exists
          (select 1 from auth.users u where u.id = old.author_id) then null else old.author_id end,
        'created_at', old.created_at));
    elsif tg_table_name = 'member_intake_reports' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('reporter_id', old.reporter_id, 'created_at', old.created_at));
    elsif tg_table_name in ('chapter_documents', 'chapter_records') then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object(
        'created_by', case when detaching_identity and new.created_by is null and not exists
          (select 1 from auth.users u where u.id = old.created_by) then null else old.created_by end,
        'created_at', old.created_at));
    elsif tg_table_name = 'chapter_handshakes' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object(
        'requested_by', case when detaching_identity and new.requested_by is null and not exists
          (select 1 from auth.users u where u.id = old.requested_by) then null else old.requested_by end,
        'created_at', old.created_at));
    elsif tg_table_name = 'chapter_governance_requests' then
      new := pg_catalog.jsonb_populate_record(new, pg_catalog.jsonb_build_object('requester_id', old.requester_id, 'created_at', old.created_at));
    end if;
  end if;
  return new;
end;
$$;

-- Chapter records survive an author's account deletion, but no longer carry a
-- live auth identity. This is an attribution removal, not content deletion.
alter table public.chapter_spaces
  drop constraint chapter_spaces_created_by_fkey,
  alter column created_by drop not null,
  add constraint chapter_spaces_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.chapter_threads
  drop constraint chapter_threads_created_by_fkey,
  alter column created_by drop not null,
  add constraint chapter_threads_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.chapter_thread_posts
  drop constraint chapter_thread_posts_author_id_fkey,
  alter column author_id drop not null,
  add constraint chapter_thread_posts_author_id_fkey foreign key (author_id) references auth.users(id) on delete set null;
alter table public.chapter_documents
  drop constraint chapter_documents_created_by_fkey,
  alter column created_by drop not null,
  add constraint chapter_documents_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.chapter_records
  drop constraint chapter_records_created_by_fkey,
  alter column created_by drop not null,
  add constraint chapter_records_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.chapter_handshakes
  drop constraint chapter_handshakes_requested_by_fkey,
  alter column requested_by drop not null,
  add constraint chapter_handshakes_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete set null;

-- A departing steward cannot cascade-delete another member's booking.
alter table public.member_appointments
  drop constraint member_appointments_steward_id_fkey,
  alter column steward_id drop not null,
  add constraint member_appointments_steward_id_fkey foreign key (steward_id) references auth.users(id) on delete set null;

-- Verified knowledge history is append-only evidence. Keep the UUID values as
-- pseudonymous actor identifiers after auth deletion by detaching the FKs.
alter table public.member_kb_articles
  drop constraint member_kb_articles_created_by_fkey,
  drop constraint member_kb_articles_updated_by_fkey,
  drop constraint member_kb_articles_verified_by_fkey;
alter table public.member_kb_article_revisions
  drop constraint member_kb_article_revisions_changed_by_fkey,
  drop constraint member_kb_article_revisions_verified_by_fkey;

revoke all on function public.get_member_data_export() from public, anon;
revoke all on function public.authorize_member_account_deletion(text) from public, anon;
revoke all on function public.claim_member_account_deletion(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finalize_member_account_deletion(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.get_member_data_export() to authenticated;
grant execute on function public.authorize_member_account_deletion(text) to authenticated;
grant execute on function public.claim_member_account_deletion(uuid, uuid, text) to service_role;
grant execute on function public.finalize_member_account_deletion(uuid, text, boolean, text) to service_role;
