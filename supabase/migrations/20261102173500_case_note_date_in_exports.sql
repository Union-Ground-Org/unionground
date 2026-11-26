-- BUG-UG-CASE-NOTE-DATE-MISSING-FROM-EXPORTS-20261102 (#6746;
-- follow-up to 20261031010000, #6648).
--
-- member_case_updates.occurred_on, the date a member gives a case note, never
-- left in either export: the account data export built each case update as
-- id, body and createdAt, and the case packet is built from the member's own
-- case-update read, which (with its one-call Home bootstrap twin) did not
-- select the column. Both are re-emitted with occurred_on and nothing else
-- changed:
--
-- 1. private.member_data_export_without_peer_contact, from
--    20260924170200_member_steward_roster_and_contact.sql: each cases[].updates
--    entry gains occurredOn (null on notes written before the column). The
--    explicit first case-graph gate is unchanged; its reviewed source hash is
--    updated in scripts/account-case-graph-review.json.
-- 2. public.get_member_home_bootstrap, from 20261028150000_member_home_bootstrap.sql:
--    the member_case_updates sub-select carries occurred_on, matching the new
--    PostgREST shape in src/lib/memberApi.js and src/lib/memberHomeBootstrap.js.
--    Still SECURITY INVOKER; same grants.

begin;
set local search_path = pg_catalog;

create or replace function private.member_data_export_without_peer_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
  exported jsonb;
  records integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  records := 0;
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
      'stewardUserId', c.steward_user_id,
      'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'senderKind', m.sender_kind, 'senderName', m.sender_name,
        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,
        'bodySha256', m.body_sha256, 'originalLength', m.original_length,
        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)
        from public.member_messages m
        where m.conversation_id = c.id
          and (m.user_id = caller or m.sender_id = caller)), '[]'::jsonb)
      ) order by c.created_at) from public.member_conversations c where c.user_id = caller), '[]'::jsonb),
    'cases', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'reference', c.reference, 'title', c.title, 'deadline', c.deadline,
      'caseType', c.case_type, 'articles', c.articles, 'step', c.step,
      'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'updates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'body', u.body, 'occurredOn', u.occurred_on, 'createdAt', u.created_at) order by u.created_at)
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

revoke all on function private.member_data_export_without_peer_contact() from public, anon, authenticated, service_role;

create or replace function public.get_member_home_bootstrap(p_action_log_since timestamptz, p_resources text[])
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_action_log_since is null then
    raise exception 'action log window required' using errcode = '22023';
  end if;
  if p_resources is null or pg_catalog.cardinality(p_resources) = 0 then
    raise exception 'resource list required' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'user_id', caller,
    -- select * ... eq user_id ... order created_at desc
    'member_notifications', case when 'member_notifications' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
      from (select * from public.member_notifications where user_id = caller order by created_at desc limit 1000) t) end,
    -- select role ... eq user_id
    'member_roles', case when 'member_roles' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', t.role)), '[]'::jsonb)
      from (select role from public.member_roles where user_id = caller limit 1000) t) end,
    -- select id,name ... order order_index
    'chapters', case when 'chapters' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'name', t.name) order by t.order_index), '[]'::jsonb)
      from (select id, name, order_index from public.chapters order by order_index limit 1000) t) end,
    -- select MEMBER_CASE_COLUMNS ... eq user_id ... order updated_at desc
    'member_cases', case when 'member_cases' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.updated_at desc), '[]'::jsonb)
      from (select id, user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at, steward_name, coordinator_name
            from public.member_cases where user_id = caller order by updated_at desc limit 1000) t) end,
    -- select id,case_id,user_id,body,occurred_on,created_at ... eq user_id ... order created_at
    'member_case_updates', case when 'member_case_updates' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at), '[]'::jsonb)
      from (select id, case_id, user_id, body, occurred_on, created_at from public.member_case_updates where user_id = caller order by created_at limit 1000) t) end,
    -- select id,sender,title,body,published_at,locale,audience_scope ... is retracted_at null ... order published_at desc ... limit 50
    'member_broadcasts', case when 'member_broadcasts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.published_at desc), '[]'::jsonb)
      from (select id, sender, title, body, published_at, locale, audience_scope
            from public.member_broadcasts where retracted_at is null order by published_at desc limit 50) t) end,
    -- select broadcast_id,read_at ... eq user_id
    'member_broadcast_receipts', case when 'member_broadcast_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select broadcast_id, read_at from public.member_broadcast_receipts where user_id = caller limit 1000) t) end,
    -- select <ballot columns>,member_ballot_options(id,ballot_id,label,label_es,order_index) ... order order_index
    'member_ballots', case when 'member_ballots' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select b.id, b.title, b.title_es, b.body, b.body_es, b.closes_at, b.active, b.order_index, b.quorum_target, b.chapter_id,
                   b.campaign_state, b.published_at, b.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, ballot_id, label, label_es, order_index from public.member_ballot_options where ballot_id = b.id) o)
                     as member_ballot_options
            from public.member_ballots b order by b.order_index limit 1000) t) end,
    -- select <survey columns>,member_survey_options(id,survey_id,label,label_es,order_index) ... order order_index
    'member_surveys', case when 'member_surveys' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select s.id, s.title, s.title_es, s.body, s.body_es, s.closes_at, s.active, s.order_index, s.chapter_id,
                   s.campaign_state, s.published_at, s.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, survey_id, label, label_es, order_index from public.member_survey_options where survey_id = s.id) o)
                     as member_survey_options
            from public.member_surveys s order by s.order_index limit 1000) t) end,
    -- select survey_id,option_id ... eq user_id
    'member_survey_responses', case when 'member_survey_responses' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select survey_id, option_id from public.member_survey_responses where user_id = caller limit 1000) t) end,
    -- select * ... order order_index
    'member_rights_lessons', case when 'member_rights_lessons' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select * from public.member_rights_lessons order by order_index limit 1000) t) end,
    -- select lesson_id,completed_steps ... eq user_id
    'member_rights_progress', case when 'member_rights_progress' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select lesson_id, completed_steps from public.member_rights_progress where user_id = caller limit 1000) t) end,
    -- select action_key,action_kind,occurred_at ... eq user_id ... gte occurred_at <since> ... order occurred_at
    'member_action_log', case when 'member_action_log' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.occurred_at), '[]'::jsonb)
      from (select action_key, action_kind, occurred_at from public.member_action_log
            where user_id = caller and occurred_at >= p_action_log_since order by occurred_at limit 1000) t) end,
    -- select ballot_id,receipt_code,issued_at ... eq user_id
    'member_ballot_receipts', case when 'member_ballot_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select ballot_id, receipt_code, issued_at from public.member_ballot_receipts where user_id = caller limit 1000) t) end,
    -- select event_id,status ... eq user_id
    'member_event_rsvps', case when 'member_event_rsvps' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id, status from public.member_event_rsvps where user_id = caller limit 1000) t) end,
    -- select event_id ... eq user_id
    'member_event_checkins', case when 'member_event_checkins' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id from public.member_event_checkins where user_id = caller limit 1000) t) end,
    -- select action_kind,label,points,weekly_cap ... order points desc
    'member_point_rules', case when 'member_point_rules' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.points desc), '[]'::jsonb)
      from (select action_kind, label, points, weekly_cap from public.member_point_rules order by points desc limit 1000) t) end,
    -- select tier,name,min_points ... order tier
    'member_reward_tiers', case when 'member_reward_tiers' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier), '[]'::jsonb)
      from (select tier, name, min_points from public.member_reward_tiers order by tier limit 1000) t) end
  );
end;
$function$;

revoke all on function public.get_member_home_bootstrap(timestamptz, text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_bootstrap(timestamptz, text[]) to authenticated;

notify pgrst, 'reload schema';

commit;
