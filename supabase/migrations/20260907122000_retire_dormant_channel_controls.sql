begin;

-- REQ-UG-ADVANCED-CHANNEL-CONTROLS-20260904 — retire-by-default.
--
-- BINDING DISPOSITION (recorded 2026-09-06; the "Messaging channel
-- controls disposition";).
-- REQ-MI1-CR-097-20260821 closed this same question once WITHOUT a durable
-- disposition, which is why it came back. The disposition is written down this
-- time, and tests/messaging-retired-channel-controls.test.js fails if any
-- future migration, client or script reintroduces a retired capability.
--
--   thread pinning (chapter_threads.pinned_at)          RETIRED
--   per-channel notification levels
--     (chapter_space_members.notification_level)        RETIRED
--   channel mute                                        RETIRED
--   structured mentions and @here                       RETIRED
--   mention search                                      RETIRED
--   keyword alerts / highlighting                       RETIRED
--
-- WHY RETIRE. Both surviving columns were writable by any authenticated member
-- through a PostgREST column grant and read by nothing. A member could set a
-- thread "pinned" that no surface pins, or a channel to "muted" that mutes no
-- notification, and no server-side authorization governed either write. That is
-- the same unaudited-capability class this batch closes on chapter post bodies:
-- a permission with no product behind it is a liability, not a feature. The
-- mute and keyword features also existed in the engagement subsystem. Round 2
-- removes those consumers, RPCs, persisted preferences/monitors/hits and trigger.
--
-- WHAT IT WOULD TAKE TO BRING ONE BACK: server-side authorization, a settings
-- surface on responsive web plus iPhone plus Android, real notification
-- production, deterministic tenant-scoped mute precedence across direct,
-- channel, task and announcement boundaries, and accessibility coverage — the
-- full retention branch of the record. Re-adding a column and a grant is not
-- that, and the guard test says so.
--
-- COLLATERAL. Three live functions referenced the retired columns and are
-- replaced here with the same bodies minus those references. The replacements
-- are generated from the original definitions and pinned byte-for-byte by
-- tests/messaging-retired-channel-controls.test.js, so they cannot drift:
--   private.member_data_export_without_peer_contact()  (dropped notificationLevel;
--       also gains the SEC-UG-MESSAGE-BODY-LIFECYCLE redaction fields, which
--       is why this migration follows 20260907121000 — one replacement, not two)
--   public.presg_demo_seed_channels(uuid, text, text)  (stopped seeding pinned_at)
--   public.uniondemo_seed_channels(uuid, integer, text, text)   (same)
--
-- ROLLBACK (needs a new owner decision reversing the disposition, not just
-- these statements):
--   alter table public.chapter_threads add column pinned_at timestamptz;
--   alter table public.chapter_space_members
--     add column notification_level text not null default 'all'
--     check (notification_level in ('all', 'mentions', 'muted'));
--   -- then restore the three function bodies from 20260812180000 /
--   -- 20260826160000 / 20260824233000 and re-grant the columns.

set local lock_timeout = '5s';

do $$
begin
  if pg_catalog.to_regprocedure('private.redact_member_message_row(uuid, text, uuid)') is null then
    raise exception 'apply 20260907121000_member_message_body_lifecycle first: the export replacement below carries its redaction fields'
      using errcode = '42883';
  end if;
end
$$;

-- 1. Withdraw the client write capability before the columns go, so a session
--    holding an old bundle fails closed rather than erroring on a missing
--    column.
revoke insert, update on public.chapter_threads from authenticated;
grant insert (space_id, title, kind, task_id, case_id, resolved_at) on public.chapter_threads to authenticated;
grant update (title, kind, status, task_id, case_id, resolved_at) on public.chapter_threads to authenticated;

revoke insert, update on public.chapter_space_members from authenticated;
grant insert (space_id, user_id) on public.chapter_space_members to authenticated;

-- chapter_space_members_self_update governed exactly one column: notification_level.
-- With no UPDATE grant left the policy is dead schema of the kind this record exists
-- to remove.
drop policy chapter_space_members_self_update on public.chapter_space_members;

-- 2. Replace the three functions that read or wrote the retired columns.

create or replace function private.member_data_export_without_peer_contact()
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
        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,
        'bodySha256', m.body_sha256, 'originalLength', m.original_length,
        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)
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
        'spaceId', m.space_id, 'role', m.role,
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

create or replace function public.presg_demo_seed_channels(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.presg_demo_runs%rowtype;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
  seed text;
  lead_user uuid;
  author record;
  tasks_seeded boolean := false;
  thread_count bigint;
  post_count bigint;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.presg_demo_runs where id = p_run_id;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied before channels seed (state %)', run.state;
  end if;
  seed := p_run_id::text;
  lead_user := private.presg_demo_user_id(p_run_id, 1);

  -- Spaces: stamp_product_identity resolves the chapter from the acting
  -- member's profile, so the committee lead acts for the create.
  perform private.presg_demo_impersonate(lead_user);
  insert into public.chapter_spaces (id, chapter_id, name, description, created_at, updated_at)
  select private.member_stress_uuid(seed || ':presg:space:' || s.name), 'presg', s.name, s.descr, t0 + interval '40 days', t0 + interval '40 days'
  from (values
    ('General', 'Campaign-wide conversation for every Union Ground supporter.'),
    ('Organizing committee', 'Committee coordination: assessments, assignments, and follow-through.'),
    ('Actions & turnout', 'Planning and turnout threads for every action and meeting.'),
    ('Questions & support', 'No such thing as a silly question. Ask here, a committee member answers.')
  ) s(name, descr)
  on conflict (chapter_id, name) do nothing;

  -- Threads, per deterministic creator so created_by is a real ledgered
  -- identity. Thread timestamps are backdated; the bump trigger will keep
  -- updated_at current, which reads as a live board.
  for author in
    select distinct 1 + private.member_stress_pick(seed || ':presg:thcr:' || t::text,
      run.committee_count) as ordinal
    from generate_series(1, 130) t
  loop
    perform private.presg_demo_impersonate(private.presg_demo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_threads (id, space_id, chapter_id, title, kind, status, resolved_at, created_at, updated_at)
    select
      private.member_stress_uuid(seed || ':presg:thread:' || t::text),
      private.member_stress_uuid(seed || ':presg:space:' ||
        (array['General', 'General', 'Organizing committee', 'Actions & turnout', 'Questions & support'])
          [1 + private.member_stress_pick(seed || ':presg:thsp:' || t::text, 5)]),
      'presg',
      case when t = 1 then 'Read first: how we talk to each other here'
           when t = 2 then 'Campaign timeline and key dates'
           else (array[
        'Why we are organizing',
        'Schedule changes without notice — collect your stories',
        'Committee meeting recap and next steps',
        'Turnout plan for the all-staff meeting',
        'Questions from the overnight shift',
        'Health insurance costs went up again',
        'How card signing works',
        'Your rights in captive-audience meetings',
        'Management response tracker',
        'Welcome, new supporters',
        'Petition language — feedback wanted',
        'House-visit debrief',
        'Break coverage at the day program',
        'What a first contract could fix',
        'Support pledge from local groups',
        'Overtime distribution is not transparent',
        'Preparing for the vote',
        'One-on-one conversation tips',
        'Staffing levels and safety',
        'Mileage reimbursement is months behind',
        'Shout-outs and wins this week',
        'Election filing checklist',
        'After the vote: what comes next',
        'Rumor control — post what you heard'
      ])[1 + private.member_stress_pick(seed || ':presg:thti:' || t::text, 24)]
        || ' · #' || t::text end,
      (array['topic', 'topic', 'topic', 'issue', 'issue', 'decision'])
        [1 + private.member_stress_pick(seed || ':presg:thki:' || t::text, 6)],
      case when private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':presg:thst:' || t::text) < 0.7
        then 'resolved' else 'open' end,
      case when private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':presg:thst:' || t::text) < 0.7
        then t0 + interval '45 days' + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395) + 35) || ' days')::interval
        else null end,
      t0 + interval '45 days' + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395)) || ' days')::interval,
      t0 + interval '45 days' + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395)) || ' days')::interval
    from generate_series(1, 130) t
    where 1 + private.member_stress_pick(seed || ':presg:thcr:' || t::text, run.committee_count) = author.ordinal
    on conflict (id) do nothing;
  end loop;

  -- Posts: ~45 per thread, mostly committee voices with employee replies. The
  -- author plan is derived once into a transaction-scoped table, then written
  -- one author at a time so stamp_product_identity records the real author_id.
  create temp table if not exists presg_post_plan on commit drop as
  select
    private.member_stress_uuid(seed || ':presg:post:' || t::text || ':' || p::text) as id,
    private.member_stress_uuid(seed || ':presg:thread:' || t::text) as thread_id,
    case when private.member_stress_rand(seed || ':presg:powho:' || t::text || ':' || p::text) < 0.72
      then 1 + private.member_stress_pick(seed || ':presg:poc:' || t::text || ':' || p::text, run.committee_count)
      else run.committee_count + 1 + private.member_stress_pick(seed || ':presg:poe:' || t::text || ':' || p::text,
        greatest(run.member_count - run.committee_count, 1))
    end as author_ordinal,
    t0 + interval '45 days'
      + ((private.member_stress_pick(seed || ':presg:thag:' || t::text, 1395)) || ' days')::interval
      + ((p * (1 + private.member_stress_pick(seed || ':presg:posp:' || t::text, 4))) || ' days')::interval
      + ((private.member_stress_pick(seed || ':presg:poh:' || t::text || ':' || p::text, 14)) || ' hours')::interval as created_at,
    (array[
      'Adding my story to this thread — same thing happened on my unit last month.',
      'I can take the second-floor list this week. Who wants to pair up?',
      'We talked about this at the committee meeting; the short version is below.',
      'Three more coworkers said yes after the weekend visits.',
      'Posting the recap so night shift is not left out of the loop.',
      'Remember: on breaks and off the clock, this conversation is protected.',
      'The tracker is updated. Two commitments still open for Thursday.',
      'Management posted a new flyer in the break room. Bring a photo here.',
      'This is exactly the kind of thing a first contract can fix.',
      'Welcome to the new folks in this thread — glad you are here.',
      'I read the petition draft; one sentence needs to be plainer.',
      'Count me in for turnout calls tomorrow evening.',
      'Same on overnights — we have been short two people for weeks.',
      'The community pledge got two more signatures at the farmers market.',
      'Let us keep this thread to facts we can source, and label the rest as rumor.',
      'Great one-on-one today. The tip about listening first really works.'
    ])[1 + private.member_stress_pick(seed || ':presg:pob1:' || t::text || ':' || p::text, 16)]
    || case when private.member_stress_rand(seed || ':presg:pob2:' || t::text || ':' || p::text) < 0.6
      then ' ' || (array[
        'Details in the next committee recap.',
        'Reply here if you can help.',
        'I will follow up on shift tomorrow.',
        'Ping a captain if anything is unclear.',
        'More at Thursday''s meeting.',
        'Thanks everyone — this is how we win.'
      ])[1 + private.member_stress_pick(seed || ':presg:pob3:' || t::text || ':' || p::text, 6)]
      else '' end as body
  from generate_series(1, 130) t
  cross join lateral generate_series(1, 20 + private.member_stress_pick(seed || ':presg:pon:' || t::text, 50)) s(p);

  for author in select distinct author_ordinal as ordinal from pg_temp.presg_post_plan order by 1
  loop
    perform private.presg_demo_impersonate(private.presg_demo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_thread_posts (id, thread_id, chapter_id, author_id, body, created_at)
    select plan.id, plan.thread_id, 'presg', private.presg_demo_user_id(p_run_id, author.ordinal), plan.body, plan.created_at
    from pg_temp.presg_post_plan plan
    where plan.author_ordinal = author.ordinal
    on conflict (id) do nothing;
  end loop;

  -- The committee task board. prepare_chapter_task forces created_at = now()
  -- and makes it immutable, so this is seeded as the LIVE board: start and due
  -- dates carry the four-year spread, statuses carry the mix. Re-runs are
  -- guarded by presence because task numbering is a counter, not a natural key.
  if not exists (select 1 from public.chapter_tasks where chapter_id = 'presg') then
    tasks_seeded := true;
    for author in
      select distinct 1 + private.member_stress_pick(seed || ':presg:tkcr:' || k::text,
        run.committee_count) as ordinal
      from generate_series(1, 90) k
    loop
      perform private.presg_demo_impersonate(private.presg_demo_user_id(p_run_id, author.ordinal));
      insert into public.chapter_tasks (id, chapter_id, title, description, status, priority, workstream,
        assignee_id, start_date, due_date, progress, blocked, milestone, order_index, task_number)
      select
        private.member_stress_uuid(seed || ':presg:task:' || k::text),
        'presg',
        (array[
          'Map the second floor, one conversation at a time',
          'Follow up with the night shift crew',
          'Print window signs and buttons',
          'Confirm the hall booking for the all-staff meeting',
          'Draft the staffing petition text',
          'One-on-ones: transportation team',
          'Update the assessment wall',
          'Prep the captive-audience meeting response',
          'Translate the flyer to Spanish',
          'Refresh the call tree',
          'Welcome packet for new supporters',
          'Collect schedule-change stories',
          'Book childcare for the all-staff meeting',
          'Update the community media list',
          'Collect questions for the legal briefing',
          'Turnout calls for Thursday',
          'Inoculation training plan',
          'Election filing checklist review'
        ])[1 + (k % 18)] || ' · T' || k::text,
        'Campaign task tracked by the organizing committee.',
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5 then 'done'
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.68 then 'in_progress'
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.84 then 'to_do'
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.94 then 'backlog'
             else 'needs_review' end,
        (array['low', 'medium', 'medium', 'high'])[1 + private.member_stress_pick(seed || ':presg:tkpr:' || k::text, 4)],
        (array['General', 'Outreach', 'House visits', 'Meetings & actions', 'Election readiness'])
          [1 + private.member_stress_pick(seed || ':presg:tkws:' || k::text, 5)],
        private.presg_demo_user_id(p_run_id, 1 + private.member_stress_pick(seed || ':presg:tkas:' || k::text, run.committee_count)),
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((30 + private.member_stress_pick(seed || ':presg:tksd:' || k::text, 1370)) || ' days')::interval)::date
          else (pg_catalog.now() - ((private.member_stress_pick(seed || ':presg:tksd:' || k::text, 21)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((9 + private.member_stress_pick(seed || ':presg:tksd:' || k::text, 1370)) || ' days')::interval)::date + 21
          else (pg_catalog.now() + ((3 + private.member_stress_pick(seed || ':presg:tkdd:' || k::text, 24)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.5 then 100
             when private.member_stress_rand(seed || ':presg:tkst:' || k::text) < 0.68
               then 20 + private.member_stress_pick(seed || ':presg:tkpg:' || k::text, 70)
             else 0 end,
        private.member_stress_rand(seed || ':presg:tkbl:' || k::text) < 0.05,
        k % 12 = 0,
        k, 0
      from generate_series(1, 90) g(k)
      where 1 + private.member_stress_pick(seed || ':presg:tkcr:' || k::text, run.committee_count) = author.ordinal;
    end loop;

    insert into public.chapter_task_comments (id, task_id, chapter_id, author_id, body, created_at)
    select
      private.member_stress_uuid(seed || ':presg:tkcm:' || k::text || ':' || c::text),
      private.member_stress_uuid(seed || ':presg:task:' || k::text),
      'presg',
      private.presg_demo_user_id(p_run_id, 1 + private.member_stress_pick(seed || ':presg:tkca:' || k::text || ':' || c::text, run.committee_count)),
      (array[
        'On it — will report back at the next committee meeting.',
        'Done for my floor; two conversations still open on nights.',
        'Blocked until we hear back about the hall. Chasing it.',
        'Handing this to a captain with more contacts on that team.',
        'Numbers updated on the wall chart.',
        'Can someone double-check the Spanish version?'
      ])[1 + private.member_stress_pick(seed || ':presg:tkcb:' || k::text || ':' || c::text, 6)],
      pg_catalog.now() - ((private.member_stress_pick(seed || ':presg:tkct:' || k::text || ':' || c::text, 46) + 1) || ' hours')::interval
    from generate_series(1, 90) g(k)
    cross join lateral generate_series(1, private.member_stress_pick(seed || ':presg:tkcn:' || k::text, 4)) s(c)
    on conflict (id) do nothing;
  end if;

  perform private.presg_demo_sweep_trigger_rows(p_run_id);

  select pg_catalog.count(*) into thread_count from public.chapter_threads where chapter_id = 'presg';
  select pg_catalog.count(*) into post_count from public.chapter_thread_posts where chapter_id = 'presg';
  return jsonb_build_object(
    'spaces', (select pg_catalog.count(*) from public.chapter_spaces where chapter_id = 'presg'),
    'threads', thread_count,
    'posts', post_count,
    'tasks', (select pg_catalog.count(*) from public.chapter_tasks where chapter_id = 'presg'),
    'tasks_seeded_this_call', tasks_seeded);
end;
$$;

create or replace function public.uniondemo_seed_channels(
  p_run_id uuid,
  p_chapter_index integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.uniondemo_runs%rowtype;
  chapter private.uniondemo_chapters%rowtype;
  t0 timestamptz := pg_catalog.now() - interval '1460 days';
  seed text;
  author record;
  tasks_seeded boolean := false;
  thread_count bigint;
  post_count bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied before channels seed (state %)', run.state;
  end if;
  select * into chapter from private.uniondemo_chapters
  where run_id = p_run_id and chapter_index = p_chapter_index;
  if not found then raise exception 'unknown union demo chapter index %', p_chapter_index; end if;
  seed := p_run_id::text || ':ch' || p_chapter_index::text;

  -- Spaces: stamp_product_identity resolves the chapter from the acting
  -- member's profile, so the chapter coordinator (block position 1) acts.
  perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, chapter.first_ordinal));
  insert into public.chapter_spaces (id, chapter_id, name, description, created_at, updated_at)
  select private.member_stress_uuid(seed || ':ud:space:' || s.name), chapter.chapter_id, s.name, s.descr,
    t0 + interval '30 days', t0 + interval '30 days'
  from (values
    ('Workplace issues', 'Ongoing chapter conversations about scheduling, safety, and workload.'),
    ('Steward corner', 'Steward coordination: casework triage, coverage, and training.'),
    ('Actions & turnout', 'Planning and turnout threads for every chapter action and meeting.'),
    ('Contract & bargaining', 'Article questions, enforcement wins, and bargaining updates.')
  ) s(name, descr)
  on conflict (chapter_id, name) do nothing;

  -- Threads, per deterministic creator (a chapter steward) so created_by is a
  -- real ledgered identity.
  for author in
    select distinct chapter.first_ordinal + private.member_stress_pick(seed || ':ud:thcr:' || t::text,
      chapter.steward_count) as ordinal
    from generate_series(1, 40) t
  loop
    perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_threads (id, space_id, chapter_id, title, kind, status, resolved_at, created_at, updated_at)
    select
      private.member_stress_uuid(seed || ':ud:thread:' || t::text),
      private.member_stress_uuid(seed || ':ud:space:' ||
        (array['Workplace issues', 'Workplace issues', 'Steward corner', 'Actions & turnout', 'Contract & bargaining'])
          [1 + private.member_stress_pick(seed || ':ud:thsp:' || t::text, 5)]),
      chapter.chapter_id,
      case when t = 1 then 'Read first: how this chapter uses its channels'
           else (array[
        'Overtime scheduling and notice',
        'Short-notice mandation tracker',
        'Steward coverage for the overnight shift',
        'Turnout plan for the chapter meeting',
        'Telework article questions',
        'Health insurance costs went up again',
        'Grievance clinic debrief',
        'Your rights in investigatory meetings',
        'Management response tracker',
        'Welcome, new members',
        'Bargaining survey — what should lead?',
        'Caseload caps campaign check-in',
        'Break coverage at the day program',
        'Mileage reimbursement is months behind',
        'Shout-outs and wins this week',
        'Safety walkthrough follow-ups',
        'New-steward training questions',
        'Contract enforcement wins thread'
      ])[1 + private.member_stress_pick(seed || ':ud:thti:' || t::text, 18)]
        || ' · #' || t::text end,
      (array['topic', 'topic', 'topic', 'issue', 'issue', 'decision'])
        [1 + private.member_stress_pick(seed || ':ud:thki:' || t::text, 6)],
      case when private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':ud:thst:' || t::text) < 0.7
        then 'resolved' else 'open' end,
      case when private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395) > 240
        and private.member_stress_rand(seed || ':ud:thst:' || t::text) < 0.7
        then t0 + interval '35 days' + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395) + 35) || ' days')::interval
        else null end,
      t0 + interval '35 days' + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395)) || ' days')::interval,
      t0 + interval '35 days' + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395)) || ' days')::interval
    from generate_series(1, 40) t
    where chapter.first_ordinal + private.member_stress_pick(seed || ':ud:thcr:' || t::text, chapter.steward_count) = author.ordinal
    on conflict (id) do nothing;
  end loop;

  -- Posts: ~18 per thread, steward voices with member replies. The author
  -- plan is derived once into a transaction-scoped table, then written one
  -- author at a time so stamp_product_identity records the real author_id.
  create temp table if not exists uniondemo_post_plan on commit drop as
  select
    private.member_stress_uuid(seed || ':ud:post:' || t::text || ':' || p::text) as id,
    private.member_stress_uuid(seed || ':ud:thread:' || t::text) as thread_id,
    case when private.member_stress_rand(seed || ':ud:powho:' || t::text || ':' || p::text) < 0.45
      then chapter.first_ordinal + private.member_stress_pick(seed || ':ud:poc:' || t::text || ':' || p::text, chapter.steward_count)
      else chapter.first_ordinal + chapter.steward_count
        + private.member_stress_pick(seed || ':ud:poe:' || t::text || ':' || p::text,
            greatest(chapter.member_count - chapter.steward_count, 1))
    end as author_ordinal,
    t0 + interval '35 days'
      + ((private.member_stress_pick(seed || ':ud:thag:' || t::text, 1395)) || ' days')::interval
      + ((p * (1 + private.member_stress_pick(seed || ':ud:posp:' || t::text, 5))) || ' days')::interval
      + ((private.member_stress_pick(seed || ':ud:poh:' || t::text || ':' || p::text, 14)) || ' hours')::interval as created_at,
    (array[
      'Adding my unit''s numbers to this thread — same pattern here.',
      'The steward on that floor is tracking it; bring dates and shifts.',
      'We raised this at labor-management; the short version is below.',
      'Three more members signed the enforcement petition this week.',
      'Posting the recap so second shift is not left out of the loop.',
      'Remember: if the meeting could lead to discipline, ask for a steward first.',
      'The tracker is updated. Two commitments still open for Thursday.',
      'Management posted a new memo in the break room. Bring a photo here.',
      'This is exactly what Article 8.3 is for — file it, do not absorb it.',
      'Welcome to the new members in this thread — glad you are here.',
      'I read the survey draft; one question needs to be plainer.',
      'Count me in for turnout calls tomorrow evening.',
      'Same on overnights — we have been short two people for weeks.',
      'The clinic had openings Thursday; a steward will help you file.',
      'Let us keep this thread to facts we can source.',
      'Great meeting tonight — notes and assignments inside.'
    ])[1 + private.member_stress_pick(seed || ':ud:pob1:' || t::text || ':' || p::text, 16)]
    || case when private.member_stress_rand(seed || ':ud:pob2:' || t::text || ':' || p::text) < 0.6
      then ' ' || (array[
        'Details in the next chapter briefing.',
        'Reply here if you can help.',
        'I will follow up on shift tomorrow.',
        'Ping a steward if anything is unclear.',
        'More at Thursday''s meeting.',
        'Thanks everyone — this is how we win.'
      ])[1 + private.member_stress_pick(seed || ':ud:pob3:' || t::text || ':' || p::text, 6)]
      else '' end as body
  from generate_series(1, 40) t
  cross join lateral generate_series(1, 8 + private.member_stress_pick(seed || ':ud:pon:' || t::text, 20)) s(p);

  for author in select distinct author_ordinal as ordinal from pg_temp.uniondemo_post_plan order by 1
  loop
    perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, author.ordinal));
    insert into public.chapter_thread_posts (id, thread_id, chapter_id, author_id, body, created_at)
    select plan.id, plan.thread_id, chapter.chapter_id, private.uniondemo_user_id(p_run_id, author.ordinal),
      plan.body, plan.created_at
    from pg_temp.uniondemo_post_plan plan
    where plan.author_ordinal = author.ordinal
    on conflict (id) do nothing;
  end loop;
  drop table if exists uniondemo_post_plan;

  -- The chapter task board. prepare_chapter_task forces created_at = now()
  -- and makes it immutable, so this is seeded as the LIVE board: start and due
  -- dates carry the four-year spread, statuses carry the mix. Re-runs are
  -- guarded by presence because task numbering is a counter, not a natural key.
  if not exists (select 1 from public.chapter_tasks where chapter_id = chapter.chapter_id) then
    tasks_seeded := true;
    for author in
      select distinct chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkcr:' || k::text,
        chapter.steward_count) as ordinal
      from generate_series(1, 45) k
    loop
      perform private.uniondemo_impersonate(private.uniondemo_user_id(p_run_id, author.ordinal));
      insert into public.chapter_tasks (id, chapter_id, title, description, status, priority, workstream,
        assignee_id, start_date, due_date, progress, blocked, milestone, order_index, task_number)
      select
        private.member_stress_uuid(seed || ':ud:task:' || k::text),
        chapter.chapter_id,
        (array[
          'Prepare the chapter meeting',
          'Publish the weekly briefing',
          'Phone-bank lapsed members',
          'Audit steward coverage map',
          'Draft the bargaining survey',
          'Update rights one-pagers',
          'Schedule the grievance clinic',
          'Verify event check-in codes',
          'Refresh the new-member packet',
          'Plan the caseload-relief action',
          'Translate member notices',
          'Reconcile RSVP lists',
          'Prep labor-management agenda',
          'Collect mandation stories',
          'Update the steward contact roster'
        ])[1 + (k % 15)] || ' · T' || k::text,
        'Chapter operations task tracked by the steward team.',
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5 then 'done'
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.68 then 'in_progress'
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.84 then 'to_do'
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.94 then 'backlog'
             else 'needs_review' end,
        (array['low', 'medium', 'medium', 'high'])[1 + private.member_stress_pick(seed || ':ud:tkpr:' || k::text, 4)],
        (array['Chapter', 'Communications', 'Organizing', 'Grievances', 'Bargaining', 'Safety'])
          [1 + private.member_stress_pick(seed || ':ud:tkws:' || k::text, 6)],
        private.uniondemo_user_id(p_run_id,
          chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkas:' || k::text, chapter.steward_count)),
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((30 + private.member_stress_pick(seed || ':ud:tksd:' || k::text, 1370)) || ' days')::interval)::date
          else (pg_catalog.now() - ((private.member_stress_pick(seed || ':ud:tksd:' || k::text, 21)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5
          then (pg_catalog.now() - ((9 + private.member_stress_pick(seed || ':ud:tksd:' || k::text, 1370)) || ' days')::interval)::date + 21
          else (pg_catalog.now() + ((3 + private.member_stress_pick(seed || ':ud:tkdd:' || k::text, 24)) || ' days')::interval)::date end,
        case when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.5 then 100
             when private.member_stress_rand(seed || ':ud:tkst:' || k::text) < 0.68
               then 20 + private.member_stress_pick(seed || ':ud:tkpg:' || k::text, 70)
             else 0 end,
        private.member_stress_rand(seed || ':ud:tkbl:' || k::text) < 0.05,
        k % 11 = 0,
        k, 0
      from generate_series(1, 45) g(k)
      where chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkcr:' || k::text, chapter.steward_count) = author.ordinal;
    end loop;

    insert into public.chapter_task_comments (id, task_id, chapter_id, author_id, body, created_at)
    select
      private.member_stress_uuid(seed || ':ud:tkcm:' || k::text || ':' || c::text),
      private.member_stress_uuid(seed || ':ud:task:' || k::text),
      chapter.chapter_id,
      private.uniondemo_user_id(p_run_id,
        chapter.first_ordinal + private.member_stress_pick(seed || ':ud:tkca:' || k::text || ':' || c::text, chapter.steward_count)),
      (array[
        'On it — will report back at the next steward meeting.',
        'Done for my floor; two follow-ups still open on nights.',
        'Blocked until we hear back about the hall. Chasing it.',
        'Handing this to the steward with more contacts on that team.',
        'Numbers updated on the coverage map.',
        'Can someone double-check the Spanish version?'
      ])[1 + private.member_stress_pick(seed || ':ud:tkcb:' || k::text || ':' || c::text, 6)],
      pg_catalog.now() - ((private.member_stress_pick(seed || ':ud:tkct:' || k::text || ':' || c::text, 46) + 1) || ' hours')::interval
    from generate_series(1, 45) g(k)
    cross join lateral generate_series(1, private.member_stress_pick(seed || ':ud:tkcn:' || k::text, 4)) s(c)
    on conflict (id) do nothing;
  end if;

  perform private.uniondemo_sweep_trigger_rows(p_run_id);

  select pg_catalog.count(*) into thread_count from public.chapter_threads where chapter_id = chapter.chapter_id;
  select pg_catalog.count(*) into post_count from public.chapter_thread_posts where chapter_id = chapter.chapter_id;
  return jsonb_build_object(
    'chapter', chapter.chapter_id,
    'spaces', (select pg_catalog.count(*) from public.chapter_spaces where chapter_id = chapter.chapter_id),
    'threads', thread_count,
    'posts', post_count,
    'tasks', (select pg_catalog.count(*) from public.chapter_tasks where chapter_id = chapter.chapter_id),
    'tasks_seeded_this_call', tasks_seeded);
end;
$$;

-- 3. Drop the retired columns. Nothing reads them and nothing writes them now.
alter table public.chapter_threads drop column pinned_at;
alter table public.chapter_space_members drop column notification_level;

notify pgrst, 'reload schema';

-- Retired engagement data is deleted, not archived or copied. No CASCADE:
-- an unreviewed dependency must stop the migration. Posting controls survive.
create or replace function private.engagement_member_snapshot_scoped()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  actor_chapter text := private.current_member_chapter();
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'quarterlyGate', public.get_quarterly_survey_gate(),
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', survey.id,
        'title', survey.title,
        'description', survey.description,
        'cadence', survey.cadence,
        'periodKey', survey.period_key,
        'opensAt', survey.opens_at,
        'closesAt', survey.closes_at,
        'session', case when session.id is null then null else pg_catalog.jsonb_build_object(
          'id', session.id, 'status', session.status,
          'updatedAt', session.updated_at, 'submittedAt', session.submitted_at,
          'answers', coalesce((
            select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
            from public.organization_survey_answers answer
            where answer.session_id = session.id and answer.organization_id = org
          ), '{}'::jsonb)
        ) end,
        'questions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', question.id, 'sortIndex', question.sort_index,
            'type', question.question_type, 'label', question.label,
            'required', question.required, 'options', question.options,
            'sectionKey', question.section_key, 'sectionTitle', question.section_title,
            'branchParentId', question.branch_parent_id, 'branchValue', question.branch_value,
            'scaleMinLabel', question.scale_min_label, 'scaleMaxLabel', question.scale_max_label,
            'maxSelections', question.max_selections
          ) order by question.sort_index)
          from public.organization_survey_questions question
          where question.survey_id = survey.id and question.organization_id = org
        ), '[]'::jsonb)
      ) order by survey.closes_at nulls last, survey.updated_at desc)
      from public.organization_surveys survey
      left join public.organization_survey_sessions session
        on session.survey_id = survey.id and session.respondent_user_id = actor
      where survey.organization_id = org
        and survey.status = 'open'
        and (survey.chapter_id is null or survey.chapter_id = actor_chapter)
        and (survey.opens_at is null or survey.opens_at <= pg_catalog.now())
        and (survey.closes_at is null or survey.closes_at > pg_catalog.now())
    ), '[]'::jsonb),
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', event.id, 'promptId', prompt.id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'contextKey', event.context_key,
        'shownAt', event.shown_at
      ) order by event.shown_at desc)
      from public.organization_pulse_events event
      join public.organization_pulse_prompts prompt on prompt.id = event.prompt_id
      where event.organization_id = org and event.user_id = actor and event.state = 'shown'
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', poll.vote_count,
        'results', case
          when poll.results_visibility = 'live'
            or (poll.results_visibility = 'after_close' and poll.state = 'closed')
            then poll.result_cache else '[]'::jsonb end,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', case when attendance.user_id is null then null else pg_catalog.jsonb_build_object(
          'eligible', attendance.eligible, 'rsvp', attendance.rsvp,
          'checkedInAt', attendance.checked_in_at
        ) end,
        'selectedOptionId', vote.option_id
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll
      left join public.organization_live_poll_attendance attendance
        on attendance.poll_id = poll.id and attendance.user_id = actor
      left join public.organization_live_poll_votes vote
        on vote.poll_id = poll.id and vote.voter_user_id = actor
      where poll.organization_id = org
        and poll.state in ('scheduled', 'open', 'closed')
        and (poll.chapter_id is null or poll.chapter_id = actor_chapter)
        and (poll.closed_at is null or poll.closed_at >= pg_catalog.now() - interval '90 days')
    ), '[]'::jsonb),
    'workspace', coalesce((
      select pg_catalog.jsonb_build_object(
        'moduleOrder', preference.module_order,
        'hiddenModules', preference.hidden_modules,
        'updatedAt', preference.updated_at
      )
      from public.compass_workspace_preferences preference
      where preference.organization_id = org and preference.user_id = actor
    ), pg_catalog.jsonb_build_object(
      'moduleOrder', '["inbox","surveys","tasks","cases"]'::jsonb,
      'hiddenModules', '[]'::jsonb
    )),
    'actions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', action.id, 'actionKind', action.action_kind,
        'sourceKind', action.source_kind, 'sourceId', action.source_id,
        'title', action.title, 'state', action.state,
        'resultTaskId', action.result_task_id, 'createdAt', action.created_at
      ) order by action.created_at desc)
      from public.compass_workspace_actions action
      where action.organization_id = org and action.actor_user_id = actor
        and action.state in ('proposed', 'failed')
    ), '[]'::jsonb),
    'briefings', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', briefing.id, 'sourceKind', briefing.source_kind,
        'targetId', briefing.target_id, 'summary', briefing.summary,
        'actionItems', briefing.action_items, 'createdAt', briefing.created_at
      ) order by briefing.created_at desc)
      from (
        select * from public.compass_message_briefings saved
        where saved.organization_id = org and saved.requested_by = actor
        order by saved.created_at desc limit 10
      ) briefing
    ), '[]'::jsonb)
  );
end;
$function$;
create or replace function public.get_staff_engagement_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
begin
  perform private.engagement_require_staff(org);
  return pg_catalog.jsonb_build_object(
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', survey.id, 'title', survey.title, 'status', survey.status,
        'cadence', survey.cadence, 'periodKey', survey.period_key,
        'privacyMinResponses', survey.privacy_min_responses,
        'operationsState', survey.operations_state, 'ownerUserId', survey.owner_user_id,
        'opensAt', survey.opens_at, 'closesAt', survey.closes_at,
        'reviewDueAt', survey.review_due_at,
        'coverage', pg_catalog.jsonb_build_object(
          'total', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id),
          'sent', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state in ('sent', 'engaged')),
          'engaged', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'engaged'),
          'failed', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'failed')
        ),
        'tasks', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', task.id, 'reason', task.reason, 'status', task.status,
            'assignedTo', task.assigned_to, 'dueAt', task.due_at
          ) order by task.created_at)
          from public.organization_survey_tasks task where task.survey_id = survey.id
        ), '[]'::jsonb),
        'reviewCounts', coalesce((
          select pg_catalog.jsonb_object_agg(counts.state, counts.count)
          from (
            select review.state, pg_catalog.count(*)::integer as count
            from public.organization_survey_reviews review
            where review.survey_id = survey.id group by review.state
          ) counts
        ), '{}'::jsonb),
        'reviews', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', review.id, 'sessionId', review.session_id,
            'state', review.state, 'assignedTo', review.assigned_to,
            'disposition', review.disposition,
            'followUpDueAt', review.follow_up_due_at,
            'createdAt', review.created_at
          ) order by review.created_at desc)
          from public.organization_survey_reviews review
          where review.survey_id = survey.id
        ), '[]'::jsonb),
        'questions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', question.id, 'sortIndex', question.sort_index,
            'type', question.question_type, 'label', question.label,
            'required', question.required, 'options', question.options,
            'sectionKey', question.section_key, 'sectionTitle', question.section_title,
            'branchParentId', question.branch_parent_id,
            'branchValue', question.branch_value
          ) order by question.sort_index)
          from public.organization_survey_questions question
          where question.survey_id = survey.id
        ), '[]'::jsonb)
      ) order by survey.updated_at desc)
      from public.organization_surveys survey where survey.organization_id = org
    ), '[]'::jsonb),
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', prompt.id, 'chapterId', prompt.chapter_id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'active', prompt.active,
        'cooldownHours', prompt.cooldown_hours,
        'shown', (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id),
        'responded', (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id and event.state = 'responded')
      ) order by prompt.updated_at desc)
      from public.organization_pulse_prompts prompt where prompt.organization_id = org
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', poll.vote_count,
        'results', poll.result_cache,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', pg_catalog.jsonb_build_object(
          'roster', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.eligible),
          'rsvpYes', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.rsvp = 'yes'),
          'checkedIn', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.checked_in_at is not null)
        )
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll where poll.organization_id = org
    ), '[]'::jsonb),
    'delivery', coalesce((
      select pg_catalog.jsonb_object_agg(summary.state, summary.count)
      from (
        select outbox.state, pg_catalog.count(*)::integer as count
        from public.engagement_delivery_outbox outbox
        where outbox.organization_id = org group by outbox.state
      ) summary
    ), '{}'::jsonb),
    'presence', pg_catalog.jsonb_build_object(
      'online', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.status = 'online' and presence.last_seen_at >= pg_catalog.now() - interval '2 minutes'),
      'away', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.last_seen_at >= pg_catalog.now() - interval '15 minutes')
    ),
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', membership.user_id,
        'name', coalesce(profile.full_name, 'Member'),
        'chapterId', profile.chapter_id
      ) order by coalesce(profile.full_name, ''), membership.user_id)
      from public.organization_memberships membership
      left join public.member_profiles profile on profile.id = membership.user_id
      where membership.organization_id = org
        and membership.status = 'active' and membership.revoked_at is null
    ), '[]'::jsonb),
    'channels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', space.id, 'name', space.name,
        'postingMode', coalesce(control.posting_mode, 'members'),
        'slowModeSeconds', coalesce(control.slow_mode_seconds, 0),
        'approvalsRequired', coalesce(control.approvals_required, false)
      ) order by space.name, space.id)
      from public.chapter_spaces space
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      left join public.chapter_space_controls control on control.space_id = space.id
      where space.archived_at is null
    ), '[]'::jsonb)
  );
end;
$function$;
drop trigger chapter_thread_posts_capture_keyword_hits on public.chapter_thread_posts;
drop function private.capture_chapter_space_keyword_hits();
drop function public.set_chapter_space_preference(uuid, boolean, text);
drop function public.save_chapter_space_keyword_monitor(uuid, text, boolean);
drop function public.mark_chapter_space_keyword_hit_read(uuid);
drop policy chapter_space_keyword_hits_own_read on public.chapter_space_keyword_hits;
drop table public.chapter_space_keyword_hits;
drop policy chapter_space_keyword_monitors_own_read on public.chapter_space_keyword_monitors;
drop table public.chapter_space_keyword_monitors;
drop policy chapter_space_preferences_own_read on public.chapter_space_preferences;
drop table public.chapter_space_preferences;
notify pgrst, 'reload schema';

-- Round 4: bounded, source-pinned outer entry installation. This runs after
-- retirement's last writer replacement. Existing signatures, ACLs, search paths,
-- security modes and inner behavior remain unchanged. The outer block takes the
-- gate BEFORE even DECLARE initializers; a changed source requires re-review.
-- No discovery-driven rewriting: only the exact reviewed signatures below.
-- Pins include ENC's envelope replacements. Wrapping the installed source keeps
-- its ticket lookups inside the lifecycle lock without rewriting the inner body.
do $entry_gates$
declare item record; target oid; source text; definition text; replacement text; inner_source text;
begin
  for item in select * from (values
    ('private.case_deadline_notice_sweep()', 'c2c723a9c046506edc1719ebcde7a2f9'),
    ('private.cr108_execute_run(uuid)', '52ffb365a9892ab336048097de7b7ba8'),
    ('private.demo_seed_apply_analytics(text, uuid)', 'c3d31e9e60cc23c7e88d1c15d760e411'),
    ('private.demo_seed_apply_casework(text, uuid)', '0695c634148d2df9e6e9c40ff4333bbb'),
    ('private.demo_seed_apply_dues(text, uuid)', '1edcdb0bdc21ec7a84ba1c84f3d039e4'),
    ('private.demo_seed_apply_function_parity(text, uuid, text, text)', '794a19eb2050d0d42eec745a79fd899d'),
    ('private.demo_seed_apply_knowledge_library(text, uuid)', 'd79cbfee2a46c54fd398a6caade23827'),
    ('private.demo_seed_apply_organization_coordination(text, uuid)', 'e777e364b25bd810ae170083fea44e56'),
    ('private.demo_seed_apply_voice_parity(text, uuid)', '753645941c968169347109d3bbf88633'),
    ('private.demo_seed_ensure_voice_operations_refresh()', 'b9179ecb7ba371a64a49f311104fd50b'),
    ('private.demo_seed_record_page_evidence(text, uuid, uuid, uuid, uuid, uuid)', 'ce4cfa85608ddea36f9095f018749b3b'),
    ('private.demo_seed_record_page_evidence_pre_casework_20260830(text, uuid, uuid, uuid, uuid, uuid)', '782ff90dbb20528e62c58308a6406bd0'),
    ('private.demo_seed_refresh_voice_quarterly_windows()', '90215fb559f5a1735b54fa8a279e14d5'),
    ('private.demo_seed_remove_analytics(text, uuid)', '18e7e2bb2c56179a697aabc31bca4c89'),
    ('private.demo_seed_remove_casework(text, uuid)', '0c193db0cd2376244c3f8a5d84933d29'),
    ('private.demo_seed_remove_dues(text, uuid)', '41ef04325bc77833483cd3615b2fd94d'),
    ('private.demo_seed_remove_function_parity(text, uuid)', 'ca48cdeadc8f093bd4add0c01d9d10f0'),
    ('private.demo_seed_remove_knowledge_library(text, uuid)', 'cb0fda82fe0384df33774021723c39b0'),
    ('private.demo_seed_remove_organization_coordination(text, uuid)', 'f04cf3ce68ade83cbe48c5f05f159cba'),
    ('private.dispatch_due_member_messaging(integer)', '83be9fabde740f3765c127a4cd13dfb2'),
    ('private.perform_organization_retention_run(uuid)', 'dd89a1da09db32a801eba9231dee5489'),
    ('private.presg_demo_verify_pre_function_parity(uuid, text)', '81e036691e5c07472c57eec7f82b309a'),
    ('private.purge_deleted_chapter_tasks()', 'b594655d92580d3d8d4f3a3a49177bac'),
    ('private.redact_member_message_row(uuid, text, uuid)', 'fe41361ac6b3b216f4337f42d9df2437'),
    ('private.redact_member_scheduled_message_row(uuid)', '3b6f06932106836131089ecd26f16608'),
    ('private.run_due_organization_automations(integer)', '6ffcec2af63d09c3df1231ba8b63869d'),
    ('private.run_due_organization_retention_jobs(integer)', '3f1dceb0b846666f220cfa2ff5dfc2ef'),
    ('private.run_task_maintenance()', '826bcf92b97f74a76d36154cf864b8cb'),
    ('private.uniondemo_verify_pre_function_parity(uuid, text)', '63830101ee1a3e78f31bf42bb5c448f2'),
    ('public.activate_mi1_knowledge_sample(text, uuid, text, text)', '3414a9694c9f459023e6137e96ff8dcd'),
    ('public.advance_case_step(uuid, text)', 'ebaed334db6d025d639236e5cebb0403'),
    ('public.approve_and_open_case(uuid, text)', '2786e7669d04ad89ecd40513e4fb9519'),
    ('public.assign_member_case(uuid, uuid, uuid)', '768784fe2f9cd0f268532eba43169904'),
    ('public.authorize_dues_sample_seed(text, text, text, uuid, text)', '31f7b9a918af2b3586131ca52cfd881e'),
    ('public.bootstrap_first_organization(text, text, uuid, text, text, text, uuid)', 'e6fea7af281045314d80977f1441479b'),
    ('public.cancel_member_message_reminder(uuid)', '2e0caac5ab2efe3555b182797ac70026'),
    ('public.cancel_scheduled_member_message(uuid)', 'e48d1cab2e5f3f1a5ef7aca729d95f14'),
    ('public.casework_advance_step(uuid, text, text, text, uuid)', 'aa7f009ab75b3d947db67b4de410f242'),
    ('public.casework_bulk_update_cases(uuid[], text, text, text, uuid)', 'b7b4f475b7d09f1dfa51117c20176409'),
    ('public.casework_set_restriction(uuid, boolean, text)', '9e8ee787dc5c0a0d1ce8d0fdb57e1551'),
    ('public.commit_member_operations_import(uuid, uuid)', '4c81c86595a92c02afb7802d9f388cde'),
    ('public.convert_member_intake_report(uuid, text, uuid)', '2007079bda6d0574eee4b6fbaef2ac65'),
    ('public.coordinator_record_case_outcome(uuid, text, text)', '04f23cde3f70379df6a61c550bc5da50'),
    ('public.coordinator_update_case(uuid, text, text, date, text)', '46056f4636b37ca5c9309918de3eba30'),
    ('public.create_admin_chapter(text, text, text, integer)', '0454b6dd72ccac8e48b2fa3e01ce55ee'),
    ('public.create_chapter_task_from_source(text, text)', '58f1e57e2008df62dbcb1978a45a59de'),
    ('public.create_chapter_task_from_template(text, text, text, jsonb)', 'ed2fb7d979a0bd4e2b22b8a397f4a189'),
    ('public.create_member_case(text, date, text, text)', '988b5dac109e88e973de0622a2c70513'),
    ('public.create_member_message_reminder(text, uuid, timestamp with time zone, text)', '241b803a521031336af14d027f47d273'),
    ('public.decide_compass_workspace_action(uuid, text)', '20623d9f48220d3befdcee58f0879041'),
    ('public.execute_organization_automation_run(uuid, text)', 'a335ae6364daa62095d3f30c85f05a31'),
    ('public.execute_organization_retention_run(uuid)', '24ffba5387abaf09ac6c7802cc453f66'),
    ('public.grant_member_chapter_membership(uuid, text)', '56b47044d32f1326b10e340fc8365aa5'),
    ('public.member_stress_apply_batch(uuid, integer, integer, text, text, text)', '4356f8e9b495a22a65cc3e08f59f68de'),
    ('public.member_stress_enrich_batch(uuid, text, integer, integer, text, text)', '5a40e2ffa81f54efd213e97b8663d7d6'),
    ('public.member_stress_remove_batch(uuid, integer, text, text)', '56390ec3c752361c3e81479dcb835ffd'),
    ('public.merge_chapter_workstreams(uuid, uuid, integer)', 'ca26cb75572c337f3f2e7aae52ab012d'),
    ('public.move_chapter_task(uuid, text, text, uuid, timestamp with time zone)', '9fe217bfd8458b801f3965131f46e9b8'),
    ('public.open_form_as_case(uuid)', '9b32d440a113b7b2519420ea865535f2'),
    ('public.persist_compass_message_briefing(text, uuid, text, jsonb, text)', '36b52ebc20cf9e4e114f95c1828e4328'),
    ('public.place_member_message_legal_hold(uuid, text)', '5e0ee83aa7858cc09c72488633dc5b88'),
    ('public.presg_demo_apply_batch(uuid, integer, integer, text, text, text)', '0441fcc7379392f8554b8afd6b05f316'),
    ('public.presg_demo_begin(uuid, text, integer, integer, integer, text, text, text)', '900f02e81043eb83ae86f8e459a35084'),
    ('public.presg_demo_begin_remove(uuid, text, text)', '6d328460998f1f1454cf0f6ca273eddc'),
    ('public.presg_demo_enrich_batch(uuid, text, integer, integer, text, text)', '957e7196b96f1f41d336cf2bff617036'),
    ('public.presg_demo_prepare_reapply(uuid, text, text, text)', '1ddfee14f54f45e0224786d007daaec6'),
    ('public.presg_demo_remove_batch(uuid, integer, text, text)', '21b19ff6b81e8cc2c01497f7fb4ed4a4'),
    ('public.presg_demo_remove_function_parity(uuid, text, text)', '143b1cf58f3d57277fdbf24543f41b28'),
    ('public.presg_demo_seed_channels(uuid, text, text)', 'ac4213325f39422f5118cb2e19aafa75'),
    ('public.presg_demo_seed_function_parity(uuid, text, text)', '5eb9b2a9560c9c9c5e4050b690ede891'),
    ('public.presg_demo_seed_org(uuid, text, text)', '52a1eaa132438ba72d09d5ded4ae5955'),
    ('public.presg_demo_verify(uuid, text)', 'a769d11b6ed61451db327aba45e19c28'),
    ('public.propose_compass_workspace_action(text, text, text)', '6315d88cd3f53640455cb9e0cb6ec59e'),
    ('public.redact_member_message(uuid)', 'dc3b9b0ff64ab05792bcc3e101128c11'),
    ('public.release_member_message_legal_hold(uuid)', '7568a0be94d46a11025042448c978ac2'),
    ('public.remove_mi1_knowledge_sample(text, uuid, text, text)', '87035402ae2750137f3f58eb6b5b623f'),
    ('public.rename_chapter_workstream(uuid, text)', '9164d7f55c23327080e0f0ff67c07dfd'),
    ('public.restore_chapter_task(uuid)', '6cf7d50e50e6c5c6b6345dc38f04c52c'),
    ('public.review_case_deadline_change(uuid, text)', '8a6ca86a72cd2a371c45407b1347884d'),
    ('public.revoke_member_chapter_membership(uuid, text)', '217ecfd235abbb93c7a0cfb0b2b68f9a'),
    ('public.rollback_organization_automation_run(uuid, text)', 'dd4e9ed3061898079d17530453f79852'),
    ('public.schedule_member_message(uuid, text, timestamp with time zone)', '374255d5d84b280b388b9f50ab65b52e'),
    ('public.send_chapter_task_message(uuid, text)', '997c6061c3177dc99951e7e45df4bd0c'),
    ('public.send_member_resource(uuid, uuid, text)', '76f299b6e7a2dcf60df16b5f1df767e6'),
    ('public.send_steward_reply(uuid, text)', '94134565a1774f23ddbcf58d810e77d8'),
    ('public.send_steward_resource(uuid, uuid, text)', '8baf3a6d7c45453b24851f8c3995f862'),
    ('public.set_chapter_task_assignees(uuid, uuid[])', '28b0a8fdf0feb2c57cff9b32047fd24d'),
    ('public.soft_delete_chapter_task(uuid)', '894e803a4d938c816bfab6c61e38015b'),
    ('public.start_member_conversation(text)', 'af0f2b6eb3a9dae2c6c622349922b0ab'),
    ('public.switch_my_chapter(text)', '9a08c93e2112989edfcca94a6573d794'),
    ('public.toggle_member_message_reaction(text, uuid, text)', 'd15ac21d82e42dd3aa18cc5d2240ba37'),
    ('public.toggle_member_saved_message(text, uuid)', 'b1edc3dfe1d81a00559a9cbcfab6ec62'),
    ('public.uniondemo_apply_batch(uuid, integer, integer, text, text, text)', '1428469fb4e1f028881c02da53acfb7f'),
    ('public.uniondemo_begin(uuid, text, integer, integer, integer, text, text, text)', '4fc5088e86b035a8f126bab0336eab2c'),
    ('public.uniondemo_begin_remove(uuid, text, text)', '8b61bf2c468288a949e7b5e5d78a45a4'),
    ('public.uniondemo_enrich_batch(uuid, text, integer, integer, text, text)', '7a5d6ea12a4e89689c93f61fd7a7fb14'),
    ('public.uniondemo_prepare_reapply(uuid, text, text, text)', '9f9655aa37b4f9e2dd67c77b2ac5025a'),
    ('public.uniondemo_remove_batch(uuid, integer, text, text)', 'ae57470dfced63430899e3f942963504'),
    ('public.uniondemo_remove_function_parity(uuid, text, text)', '7f75b6e366e94a31b235a77813f6849c'),
    ('public.uniondemo_seed_channels(uuid, integer, text, text)', '893934338c8e63f3c5ba422acb34d031'),
    ('public.uniondemo_seed_function_parity(uuid, text, text)', '8f79aab827e866e66c3891b4f043a8d2'),
    ('public.uniondemo_seed_org(uuid, integer, text, text)', '72b3deda2a0eca86a49df19dacf62237'),
    ('public.uniondemo_verify(uuid, text)', '8e4e206c7aa5eeb653112540818061cf'),
    ('public.update_admin_chapter(text, text, text, integer)', '1d7b070dbf4099e41d8d87c8fd75f95f'),
    ('public.update_chapter_document_content(uuid, text, text, text, text, text, text)', '2d0038898e0147990b243a2eaf976e70'),
    ('public.update_chapter_space_content(uuid, text, text, text, boolean)', '9294ec9b72cf20d94bf7894d899e1562'),
    ('public.update_chapter_task_content(uuid, timestamp with time zone, text, text)', '904863ba50bc1f1bf0358c9196131688'),
    ('public.update_chapter_task_template_details(uuid, jsonb, text, boolean)', '2ffc29b30adacc4901940f2c4ae32f19')
  ) reviewed(signature, source_md5) loop
    target := pg_catalog.to_regprocedure(item.signature);
    select p.prosrc, pg_catalog.pg_get_functiondef(p.oid) into source, definition
      from pg_catalog.pg_proc p where p.oid = target;
    if source is null or pg_catalog.md5(source) is distinct from item.source_md5 then
      raise exception 'messaging entry source changed: %', item.signature;
    end if;
    inner_source := pg_catalog.replace(source, '#variable_conflict use_variable', '');
    replacement := case when pg_catalog.strpos(source, '#variable_conflict use_variable') > 0
      then '#variable_conflict use_variable' || chr(10) else '' end
      || chr(10) || 'begin' || chr(10) || '  perform private.lock_message_lifecycle();' || chr(10)
      || pg_catalog.rtrim(inner_source, ' ' || chr(10) || chr(13) || chr(9) || ';')
      || ';' || chr(10) || 'end;' || chr(10);
    definition := pg_catalog.replace(definition, source, replacement);
    execute definition;
  end loop;
end;
$entry_gates$;

-- Direct DML and trigger hosts enter before their first tuple/FK lock too.
drop trigger if exists message_lifecycle_statement on auth.users;
create trigger message_lifecycle_statement before insert or update or delete on auth.users
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on private.demo_seed_function_catalog;
create trigger message_lifecycle_statement before insert or update or delete on private.demo_seed_function_catalog
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on private.demo_seed_function_evidence;
create trigger message_lifecycle_statement before insert or update or delete on private.demo_seed_function_evidence
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on private.demo_seed_page_contract;
create trigger message_lifecycle_statement before insert or update or delete on private.demo_seed_page_contract
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on private.demo_seed_page_evidence;
create trigger message_lifecycle_statement before insert or update or delete on private.demo_seed_page_evidence
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on private.presg_demo_runs;
create trigger message_lifecycle_statement before insert or update or delete on private.presg_demo_runs
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on private.uniondemo_runs;
create trigger message_lifecycle_statement before insert or update or delete on private.uniondemo_runs
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.chapter_documents;
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_documents
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.chapter_spaces;
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_spaces
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.chapter_task_messages;
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_task_messages
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.chapter_tasks;
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_tasks
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.chapter_thread_posts;
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_thread_posts
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.chapter_threads;
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_threads
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.chapters;
create trigger message_lifecycle_statement before insert or update or delete on public.chapters
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.compass_message_briefings;
create trigger message_lifecycle_statement before insert or update or delete on public.compass_message_briefings
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.compass_workspace_actions;
create trigger message_lifecycle_statement before insert or update or delete on public.compass_workspace_actions
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_cases;
create trigger message_lifecycle_statement before insert or update or delete on public.member_cases
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_conversations;
create trigger message_lifecycle_statement before insert or update or delete on public.member_conversations
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_message_legal_holds;
create trigger message_lifecycle_statement before insert or update or delete on public.member_message_legal_holds
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_message_reactions;
create trigger message_lifecycle_statement before insert or update or delete on public.member_message_reactions
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_message_reminders;
create trigger message_lifecycle_statement before insert or update or delete on public.member_message_reminders
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_message_resources;
create trigger message_lifecycle_statement before insert or update or delete on public.member_message_resources
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_messages;
create trigger message_lifecycle_statement before insert or update or delete on public.member_messages
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_profiles;
create trigger message_lifecycle_statement before insert or update or delete on public.member_profiles
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_saved_messages;
create trigger message_lifecycle_statement before insert or update or delete on public.member_saved_messages
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.member_scheduled_messages;
create trigger message_lifecycle_statement before insert or update or delete on public.member_scheduled_messages
for each statement execute function private.lock_message_lifecycle_statement();
drop trigger if exists message_lifecycle_statement on public.organizations;
create trigger message_lifecycle_statement before insert or update or delete on public.organizations
for each statement execute function private.lock_message_lifecycle_statement();

commit;
