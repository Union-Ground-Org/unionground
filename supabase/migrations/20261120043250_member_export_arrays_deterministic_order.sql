-- BUG-UG-MEMBER-DATA-EXPORT-NONDETERMINISTIC-ARRAY-ORDER-20261119 (#9263)
-- Add only aggregate ordering: retain the exact projections, predicates,
-- authentication, lifecycle audit, grants and search_path of every producer.
-- 24 private producers need 50 complete row-order clauses. The public wrapper,
-- civic arrays and other producers already have a complete key, a single-row
-- bound, or indistinguishable scalar role values, so those stay untouched.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public;

do $predecessors$
declare entry record;
begin
  for entry in select * from (values
    ('private.account_lifecycle_export_chapter_channel_poll_votes(uuid)', '95630b1347c4e97ac1a05574c59f62ce'),
    ('private.account_lifecycle_export_chapter_task_watchers(uuid)', 'cf6de8cdb7c554089860cbaffc12bf5a'),
    ('private.account_lifecycle_export_chapter_thread_posts(uuid)', '03bbbdeed821302c785d125cdc693a12'),
    ('private.account_lifecycle_export_chapter_threads(uuid)', '95eb5e45c860598ea4dbbea818386768'),
    ('private.account_lifecycle_export_compass_message_briefings(uuid)', '21cc1e8fd358bceee74040a82d06c733'),
    ('private.account_lifecycle_export_compass_workspace_preferences(uuid)', 'e89cd00be043abe779d68cd723ad4cc5'),
    ('private.account_lifecycle_export_member_ballot_votes(uuid)', 'cff281e00a860703f55d1914bd68b036'),
    ('private.account_lifecycle_export_member_broadcast_receipts(uuid)', '352e22e31c65ced9651c443529ae9508'),
    ('private.account_lifecycle_export_member_chapter_memberships(uuid)', '26d5b78f809f50e422ec68fb94591876'),
    ('private.account_lifecycle_export_member_emergency_checklists(uuid)', '6f450a44bf1b474ab63e8135b6649593'),
    ('private.account_lifecycle_export_member_event_contact_opt_ins(uuid)', '34a1a6243fa151f340a36a23b872fd70'),
    ('private.account_lifecycle_export_member_message_reactions(uuid)', 'd9f97f14690aa3a16538e1f14c0ceec3'),
    ('private.account_lifecycle_export_member_message_reminders(uuid)', 'df3edc355e41a181cb8ca5577e826fda'),
    ('private.account_lifecycle_export_member_message_resources(uuid)', '5dd246697317abe976bd903b5d5688a8'),
    ('private.account_lifecycle_export_member_qa_votes(uuid)', 'fb784565cff6c3a4200b32e1b37962bb'),
    ('private.account_lifecycle_export_member_saved_messages(uuid)', 'a59883bcd4c087825b987ac7290e1744'),
    ('private.account_lifecycle_export_member_weekly_question_promotions(uuid)', 'be067684c02b74202a86977fad50557b'),
    ('private.account_lifecycle_export_member_weekly_question_supports(uuid)', 'f591ff07c6b2377d94ae7bb839063131'),
    ('private.account_lifecycle_export_member_weekly_questions(uuid)', '713dd27ce70511b306872394bafafc8b'),
    ('private.account_lifecycle_export_organization_engagement_events(uuid)', '6d3f9135a59f56031055cf64ed128896'),
    ('private.account_lifecycle_export_organization_live_poll_votes(uuid)', 'b7ce6df8017c141813633289addb40fa'),
    ('private.account_lifecycle_export_organization_memberships(uuid)', '3c310fef1d9add64685052792f61bcc9'),
    ('private.account_lifecycle_export_organization_pulse_events(uuid)', 'b4c967bb9d91c3256956ca348bd26ac0'),
    ('private.member_data_export_without_peer_contact()', '1ce601562dc717e306ba22eb4373ebc4')
  ) reviewed(signature, definition_md5) loop
    if pg_catalog.md5(pg_catalog.pg_get_functiondef(entry.signature::regprocedure))
       is distinct from entry.definition_md5 then
      raise exception 'unreviewed member export predecessor: %', entry.signature using errcode='55000';
    end if;
  end loop;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_chapter_channel_poll_votes(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('poll_id', t.poll_id, 'option_id', t.option_id, 'user_id', t.user_id, 'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.poll_id), '[]'::jsonb) from public.chapter_channel_poll_votes t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_chapter_task_watchers(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id', t.user_id, 'task_id', t.task_id, 'chapter_id', t.chapter_id, 'created_at', t.created_at) order by t.created_at, t.task_id), '[]'::jsonb) from public.chapter_task_watchers t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_chapter_thread_posts(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'thread_id', t.thread_id, 'chapter_id', t.chapter_id, 'author_id', t.author_id,
    'body', t.body, 'parent_post_id', t.parent_post_id, 'created_at', t.created_at,
    'edited_at', t.edited_at, 'deleted_at', t.deleted_at, 'author_name', t.author_name,
    'author_initials', t.author_initials, 'author_role', t.author_role, 'body_es', t.body_es) order by t.created_at, t.id), '[]'::jsonb)
  from public.chapter_thread_posts t where t.author_id = p_caller;
$function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_chapter_threads(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'space_id', t.space_id, 'chapter_id', t.chapter_id, 'title', t.title, 'kind', t.kind, 'status', t.status, 'created_by', t.created_by, 'task_id', t.task_id, 'case_id', t.case_id, 'resolved_at', t.resolved_at, 'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.id), '[]'::jsonb) from public.chapter_threads t where t.created_by = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_compass_message_briefings(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'organization_id', t.organization_id, 'requested_by', t.requested_by, 'source_kind', t.source_kind, 'target_id', t.target_id, 'summary', t.summary, 'action_items', t.action_items, 'created_at', t.created_at) order by t.created_at, t.id), '[]'::jsonb) from public.compass_message_briefings t where t.requested_by = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_compass_workspace_preferences(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'module_order', t.module_order, 'hidden_modules', t.hidden_modules, 'updated_at', t.updated_at) order by t.organization_id), '[]'::jsonb) from public.compass_workspace_preferences t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_ballot_votes(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('ballot_id', t.ballot_id, 'option_id', t.option_id, 'user_id', t.user_id, 'submitted_at', t.submitted_at) order by t.ballot_id), '[]'::jsonb) from public.member_ballot_votes t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_broadcast_receipts(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('broadcast_id', t.broadcast_id, 'user_id', t.user_id, 'read_at', t.read_at) order by t.broadcast_id), '[]'::jsonb) from public.member_broadcast_receipts t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_chapter_memberships(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', t.user_id, 'chapter_id', t.chapter_id, 'status', t.status, 'pinned', t.pinned,
    'last_selected_at', t.last_selected_at, 'joined_at', t.joined_at, 'revoked_at', t.revoked_at,
    'compass_unit_keys', t.compass_unit_keys, 'compass_scope_verification', t.compass_scope_verification,
    'display_title', t.display_title, 'budget_office', t.budget_office) order by t.chapter_id), '[]'::jsonb)
  from public.member_chapter_memberships t where t.user_id = p_caller;
$function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_emergency_checklists(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'organization_id', t.organization_id, 'member_user_id', t.member_user_id, 'scenario', t.scenario, 'status', t.status, 'completed_steps', t.completed_steps, 'notes', t.notes, 'alerted_at', t.alerted_at, 'resolved_at', t.resolved_at, 'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.id), '[]'::jsonb) from public.member_emergency_checklists t where t.member_user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_event_contact_opt_ins(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'event_id', t.event_id, 'user_id', t.user_id, 'organizer_id', t.organizer_id, 'opted_in_at', t.opted_in_at) order by t.event_id), '[]'::jsonb)
  from private.member_event_contact_opt_ins t where t.user_id = p_caller;
$function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_message_reactions(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'actor_id', t.actor_id, 'source_kind', t.source_kind, 'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id, 'task_message_id', t.task_message_id, 'reaction', t.reaction, 'created_at', t.created_at) order by t.created_at, t.id), '[]'::jsonb) from public.member_message_reactions t where t.actor_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_message_reminders(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'owner_id', t.owner_id, 'source_kind', t.source_kind,
    'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id,
    'task_message_id', t.task_message_id, 'source_ref', t.source_ref, 'audience', t.audience,
    'note', t.note, 'title', t.title, 'repeat_rule', t.repeat_rule, 'time_zone', t.time_zone, 'remind_at', t.remind_at, 'status', t.status, 'snooze_count', t.snooze_count,
    'completed_at', t.completed_at, 'created_at', t.created_at,
    'delivered_at', t.delivered_at, 'updated_at', t.updated_at) order by t.created_at, t.id), '[]'::jsonb)
  from public.member_message_reminders t where t.owner_id = p_caller;
$function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_message_resources(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'message_id', t.message_id, 'document_id', t.document_id, 'added_by', t.added_by, 'created_at', t.created_at) order by t.created_at, t.id), '[]'::jsonb) from public.member_message_resources t where t.added_by = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_qa_votes(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'question_id', t.question_id, 'reply_id', t.reply_id, 'created_at', t.created_at) order by t.created_at, pg_catalog.to_jsonb(t)), '[]'::jsonb) from public.member_qa_votes t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_saved_messages(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'owner_id', t.owner_id, 'source_kind', t.source_kind, 'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id, 'task_message_id', t.task_message_id, 'saved_at', t.saved_at) order by t.id), '[]'::jsonb) from public.member_saved_messages t where t.owner_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_weekly_question_promotions(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('question_id', t.question_id, 'reward_grant_id', t.reward_grant_id, 'organization_id', t.organization_id, 'chapter_id', t.chapter_id, 'user_id', t.user_id, 'promoted_at', t.promoted_at) order by t.question_id), '[]'::jsonb) from public.member_weekly_question_promotions t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_weekly_question_supports(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('question_id', t.question_id, 'user_id', t.user_id, 'created_at', t.created_at) order by t.created_at, t.question_id), '[]'::jsonb) from public.member_weekly_question_supports t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_member_weekly_questions(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'chapter_id', t.chapter_id, 'user_id', t.user_id, 'week_start', t.week_start, 'body', t.body, 'options', t.options, 'editorial_state', t.editorial_state, 'published_survey_id', t.published_survey_id, 'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.id), '[]'::jsonb) from public.member_weekly_questions t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_organization_engagement_events(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'chapter_id', t.chapter_id, 'event_type', t.event_type, 'source_id', t.source_id, 'occurred_at', t.occurred_at) order by t.occurred_at, t.organization_id, t.event_type, t.source_id), '[]'::jsonb) from public.organization_engagement_events t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_organization_live_poll_votes(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'poll_id', t.poll_id, 'option_id', t.option_id, 'voter_user_id', t.voter_user_id, 'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at, t.poll_id), '[]'::jsonb) from public.organization_live_poll_votes t where t.voter_user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_organization_memberships(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'status', t.status, 'created_at', t.created_at, 'revoked_at', t.revoked_at) order by t.created_at, t.organization_id), '[]'::jsonb) from public.organization_memberships t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.account_lifecycle_export_organization_pulse_events(p_caller uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'organization_id', t.organization_id, 'prompt_id', t.prompt_id, 'user_id', t.user_id, 'context_key', t.context_key, 'state', t.state, 'response_value', t.response_value, 'shown_at', t.shown_at, 'responded_at', t.responded_at, 'updated_at', t.updated_at) order by t.id), '[]'::jsonb) from public.organization_pulse_events t where t.user_id = p_caller; $function$;

CREATE OR REPLACE FUNCTION private.member_data_export_without_peer_contact()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'readAt', n.read_at, 'createdAt', n.created_at) order by n.created_at, n.id)
      from public.member_notifications n where n.user_id = caller), '[]'::jsonb),
    'conversations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'title', c.title, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'stewardUserId', c.steward_user_id,
      'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'senderKind', m.sender_kind, 'senderName', m.sender_name,
        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,
        'bodySha256', m.body_sha256, 'originalLength', m.original_length,
        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at, m.id)
        from public.member_messages m
        where m.conversation_id = c.id and m.learning_removal_held_at is null
          and (m.user_id = caller or m.sender_id = caller)), '[]'::jsonb)
      ) order by c.created_at, c.id) from public.member_conversations c where c.user_id = caller), '[]'::jsonb),
    'cases', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'reference', c.reference, 'title', c.title, 'deadline', c.deadline,
      'caseType', c.case_type, 'articles', c.articles, 'step', c.step,
      'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'updates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'body', u.body, 'occurredOn', u.occurred_on, 'createdAt', u.created_at) order by u.created_at, u.id)
        from public.member_case_updates u where u.case_id = c.id and u.user_id = caller and u.learning_undone_at is null), '[]'::jsonb)
      ) order by c.created_at, c.id) from public.member_cases c where c.user_id = caller and c.learning_undone_at is null), '[]'::jsonb),
    'forms', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'templateKey', f.template_key, 'templateVersion', f.template_version,
      'status', f.status, 'answers', f.answers, 'step', f.step,
      'reviewNote', f.review_note, 'reviewedAt', f.reviewed_at,
      'submittedAt', f.submitted_at, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
      'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'status', c.status, 'invitedAt', c.invited_at, 'respondedAt', c.responded_at)
        order by c.invited_at, c.id) from public.member_form_cosigners c where c.form_id = f.id), '[]'::jsonb)
      ) order by f.created_at, f.id) from public.member_forms f where f.user_id = caller), '[]'::jsonb),
    'participation', pg_catalog.jsonb_build_object(
      'ballotReceipts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ballotId', r.ballot_id, 'receiptCode', r.receipt_code,
        'counted', r.counted, 'issuedAt', r.issued_at) order by r.issued_at, r.id)
        from public.member_ballot_receipts r where r.user_id = caller), '[]'::jsonb),
      'surveyResponses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'surveyId', s.survey_id, 'optionId', s.option_id, 'submittedAt', s.submitted_at)
        order by s.submitted_at, s.survey_id) from public.member_survey_responses s where s.user_id = caller), '[]'::jsonb),
      'rightsProgress', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lessonId', r.lesson_id, 'completedSteps', r.completed_steps, 'updatedAt', r.updated_at)
        order by r.updated_at, r.lesson_id) from public.member_rights_progress r where r.user_id = caller), '[]'::jsonb),
      'eventRsvps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', r.event_id, 'status', r.status, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at, r.event_id) from public.member_event_rsvps r where r.user_id = caller), '[]'::jsonb),
      'eventCheckins', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', c.event_id, 'checkedInAt', c.checked_in_at) order by c.checked_in_at, c.event_id)
        from public.member_event_checkins c where c.user_id = caller), '[]'::jsonb)
    ),
    'support', pg_catalog.jsonb_build_object(
      'stewardRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'lessonId', r.lesson_id, 'status', r.status,
        'createdAt', r.created_at, 'acknowledgedAt', r.acknowledged_at, 'closedAt', r.closed_at)
        order by r.created_at, r.id) from public.member_steward_requests r where r.user_id = caller), '[]'::jsonb),
      'appointments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'chapterId', a.chapter_id, 'appointmentType', a.appointment_type,
        'durationMinutes', a.duration_minutes, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
        'status', a.status, 'routedVia', a.routed_via, 'reasonCategory', a.reason_category,
        'createdAt', a.created_at, 'updatedAt', a.updated_at) order by a.created_at, a.id)
        from public.member_appointments a where a.user_id = caller), '[]'::jsonb),
      'intakeReports', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id, 'chapterId', i.chapter_id, 'category', i.category, 'title', i.title,
        'details', i.details, 'status', i.status, 'createdAt', i.created_at, 'updatedAt', i.updated_at)
        order by i.created_at, i.id) from public.member_intake_reports i where i.reporter_id = caller), '[]'::jsonb),
      'dataRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'chapterId', g.chapter_id, 'requestType', g.request_type,
        'details', g.details, 'status', g.status, 'response', g.response,
        'createdAt', g.created_at, 'updatedAt', g.updated_at) order by g.created_at, g.id)
        from public.chapter_governance_requests g where g.requester_id = caller), '[]'::jsonb)
    ),
    'compass', pg_catalog.jsonb_build_object(
      'threads', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'title', t.title, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
        'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', m.id, 'role', m.role, 'body', m.body, 'sources', m.sources, 'createdAt', m.created_at)
          order by m.created_at, m.id) from public.member_guide_messages m
          where m.thread_id = t.id and m.user_id = caller), '[]'::jsonb)) order by t.created_at, t.id)
        from public.member_guide_threads t where t.user_id = caller), '[]'::jsonb),
      'requestHistory', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'createdAt', r.created_at, 'role', r.compass_role,
        'limit', r.compass_limit, 'dispatchAuthorizedAt', r.dispatch_authorized_at)
        order by r.created_at, r.id) from public.member_ai_requests r where r.user_id = caller), '[]'::jsonb)
    ),
    'activity', pg_catalog.jsonb_build_object(
      'points', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', p.action_key, 'actionKind', p.action_kind,
        'points', p.points, 'occurredAt', p.occurred_at) order by p.occurred_at, p.id)
        from public.member_point_events p where p.user_id = caller), '[]'::jsonb),
      'rewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'itemKey', r.item_key, 'status', r.status, 'source', r.source,
        'reason', r.reason, 'note', r.note, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at, r.id) from public.member_reward_grants r where r.user_id = caller), '[]'::jsonb),
      'workload', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(w) - 'user_id' order by w.created_at, w.id)
        from public.member_workload_logs w where w.user_id = caller), '[]'::jsonb),
      'actions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', a.action_key, 'actionKind', a.action_kind, 'occurredAt', a.occurred_at)
        order by a.occurred_at, a.id) from public.member_action_log a where a.user_id = caller), '[]'::jsonb)
    ),
    'chapterParticipation', pg_catalog.jsonb_build_object(
      'spaceMemberships', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', m.space_id, 'role', m.role,
        'joinedAt', m.joined_at) order by m.joined_at, m.space_id)
        from public.chapter_space_members m where m.user_id = caller), '[]'::jsonb),
      'taskAssignments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'taskId', a.task_id, 'chapterId', a.chapter_id, 'position', a.position, 'assignedAt', a.assigned_at)
        order by a.assigned_at, a.id) from public.chapter_task_assignments a where a.assignee_id = caller), '[]'::jsonb),
      'taskComments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'taskId', c.task_id, 'chapterId', c.chapter_id,
        'body', c.body, 'createdAt', c.created_at) order by c.created_at, c.id)
        from public.chapter_task_comments c where c.author_id = caller), '[]'::jsonb),
      'taskMessages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'taskId', m.task_id, 'chapterId', m.chapter_id,
        'direction', case when m.sender_id = caller then 'sent' else 'received' end,
        'body', m.body, 'createdAt', m.created_at) order by m.created_at, m.id)
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
$function$;

notify pgrst, 'reload schema';
commit;
