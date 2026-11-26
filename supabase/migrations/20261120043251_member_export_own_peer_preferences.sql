-- Include the caller's own block and cross-chapter mute choices.
-- Stacked on; provisional stamp follows its 20261120043250 migration.
-- Preserve every existing producer, array order, auth/PIN/MFA guard and audit.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog, public;

do $predecessors$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_member_data_export()'::regprocedure))
       is distinct from 'b0be1872de9d1af71e6a3aa1021ad641'
     or pg_catalog.md5(pg_catalog.pg_get_functiondef('private.member_data_export_without_peer_contact()'::regprocedure))
       is distinct from '6e6fb010577ad1d9db07a58271d4b2c5' then
    raise exception 'unreviewed member export predecessor' using errcode='55000';
  end if;
end;
$predecessors$;

CREATE OR REPLACE FUNCTION public.get_member_data_export()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  exported jsonb;
  peer_contact jsonb;
  additional jsonb;
  safe_workload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- D5-3: the personal data export needs a password or passkey sign-in.
  perform private.member_pin_require_full_session();

  -- This private implementation performs the single lifecycle audit write.
  exported := private.member_data_export_without_peer_contact();

  select pg_catalog.jsonb_build_object(
    -- Only choices made by this caller, never another person's block of them.
    'blocks', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'createdAt', block.created_at
      ) order by block.created_at, block.blocker_id, block.blocked_id)
      from private.member_peer_blocks block where block.blocker_id = caller
    ), '[]'::jsonb),
    'crossChapterMutes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'mutedAt', mute.muted_at
      ) order by mute.muted_at, mute.user_id)
      from private.cross_chapter_peer_mutes mute where mute.user_id = caller
    ), '[]'::jsonb),
    'requests', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', request.id,
        'direction', case when request.requester_id = caller then 'sent' else 'received' end,
        'chapterId', request.chapter_id,
        'status', request.status,
        'createdAt', request.created_at,
        'respondedAt', request.responded_at,
        'expiresAt', request.expires_at
      ) order by request.created_at, request.id)
      from (
        select r.id, r.requester_id, r.chapter_id, r.status,
          r.created_at, r.responded_at, r.expires_at
        from public.member_peer_contact_requests r
        where r.requester_id = caller or r.recipient_id = caller
        order by r.created_at desc, r.id desc
        limit 100
      ) request
    ), '[]'::jsonb),
    'conversations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', conversation.id,
        'chapterId', conversation.chapter_id,
        'createdAt', conversation.created_at,
        'updatedAt', conversation.updated_at,
        'messages', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', message.id,
            'sentByMe', message.sender_id = caller,
            'body', message.body,
            'readAt', message.read_at,
            'createdAt', message.created_at
          ) order by message.created_at, message.id)
          from (
            select m.id, m.sender_id, m.body, m.read_at, m.created_at
            from public.member_peer_messages m
            where m.conversation_id = conversation.id
            order by m.created_at desc, m.id desc
            limit 100
          ) message
        ), '[]'::jsonb)
      ) order by conversation.created_at, conversation.id)
      from (
        select c.id, c.chapter_id, c.created_at, c.updated_at
        from public.member_peer_conversations c
        where c.user_low = caller or c.user_high = caller
        order by c.updated_at desc, c.id desc
        limit 20
      ) conversation
    ), '[]'::jsonb)
  ) into peer_contact;

  additional := private.account_lifecycle_export_additional_domains(caller);
  additional := additional || pg_catalog.jsonb_build_object(
    'member_case_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'caseId', file.case_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'createdAt', file.created_at
      ) order by file.created_at, file.id)
      from public.member_case_files file
      where file.user_id = caller
    ), '[]'::jsonb),
    'member_form_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'formId', file.form_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'confirmedAt', file.confirmed_at,
        'createdAt', file.created_at,
        'deletionRequestedAt', file.deletion_requested_at
      ) order by file.created_at, file.id)
      from public.member_form_files file
      where file.uploaded_by = caller
        and exists (
          select 1 from public.member_forms form
          where form.id = file.form_id and form.user_id = caller
        )
    ), '[]'::jsonb),
    'chapter_task_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'taskId', file.task_id,
        'chapterId', file.chapter_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'createdAt', file.created_at
      ) order by file.created_at, file.id)
      from public.chapter_task_files file
      where file.uploaded_by = caller
    ), '[]'::jsonb),
    'member_qa_questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id,
        'organizationId', question.organization_id,
        'chapterId', question.chapter_id,
        'title', question.title,
        'body', question.body,
        'status', question.status,
        'acceptedReplyId', question.accepted_reply_id,
        'upvoteCount', question.upvote_count,
        'createdAt', question.created_at,
        'updatedAt', question.updated_at,
        'deletedAt', question.deleted_at
      ) order by question.created_at, question.id)
      from public.member_qa_questions question
      where question.author_user_id = caller
    ), '[]'::jsonb),
    'member_qa_replies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', reply.id,
        'organizationId', reply.organization_id,
        'questionId', reply.question_id,
        'kind', reply.kind,
        'body', reply.body,
        'accepted', reply.accepted,
        'upvoteCount', reply.upvote_count,
        'createdAt', reply.created_at,
        'updatedAt', reply.updated_at,
        'deletedAt', reply.deleted_at
      ) order by reply.created_at, reply.id)
      from public.member_qa_replies reply
      where reply.author_user_id = caller
    ), '[]'::jsonb),
    'member_scheduled_messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', message.id,
        'conversationId', message.conversation_id,
        'senderKind', message.sender_kind,
        'body', message.body,
        'scheduledFor', message.scheduled_for,
        'status', message.status,
        'sentMessageId', message.sent_message_id,
        'createdAt', message.created_at,
        'dispatchedAt', message.dispatched_at
      ) order by message.created_at, message.id)
      from public.member_scheduled_messages message
      where message.actor_id = caller
    ), '[]'::jsonb),
    'meeting_attendance', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', attendance.record_id,
        'chapterId', attendance.chapter_id,
        'attendanceStatus', attendance.attendance_status,
        'recordedAt', attendance.recorded_at
      ) order by attendance.recorded_at, attendance.record_id)
      from public.meeting_attendance attendance
      where attendance.user_id = caller
    ), '[]'::jsonb),
    'meeting_minutes_dispatches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', dispatch.id,
        'recordId', dispatch.record_id,
        'chapterId', dispatch.chapter_id,
        'version', dispatch.version,
        'channel', dispatch.channel,
        'status', dispatch.status,
        'deliveredAt', dispatch.delivered_at,
        'createdAt', dispatch.created_at
      ) order by dispatch.created_at, dispatch.id)
      from public.meeting_minutes_dispatches dispatch
      where dispatch.recipient_id = caller
    ), '[]'::jsonb)
  );

  -- The original v1 exporter used `to_jsonb(w) - 'user_id'` for workload
  -- rows. Replace that whole-row shape before anything leaves this wrapper so
  -- the canonical v1 domain is an explicit reviewed projection too.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', workload.id,
    'priority', workload.priority,
    'pending', workload.pending,
    'unreadDocs', workload.unread_docs,
    'todos', workload.todos,
    'referrals', workload.referrals,
    'ceActivities', workload.ce_activities,
    'assistanceRequests', workload.assistance_requests,
    'agedCases', workload.aged_cases,
    'weeklyAssigned', workload.weekly_assigned,
    'employment', workload.employment,
    'partTimeHours', workload.pt_hours,
    'onPlan', workload.on_plan,
    'overtimeWorked', workload.ot_worked,
    'overtimeHours', workload.ot_hours,
    'leaveType', workload.leave_type,
    'leaveTiming', workload.leave_timing,
    'noIntake', workload.no_intake,
    'halfDay', workload.half_day,
    'note', workload.note,
    'subDetails', workload.sub_details,
    'receiptCode', workload.receipt_code,
    'loggedOn', workload.logged_on,
    'createdAt', workload.created_at
  ) order by workload.created_at, workload.id), '[]'::jsonb)
    into safe_workload
    from public.member_workload_logs workload
   where workload.user_id = caller;

  -- Contact choices carry timestamps only. No peer account id, profile
  -- label, email/address, share code, digest, or inbound block is added.
  -- Message direction remains relative to the authenticated caller.
  exported := pg_catalog.jsonb_set(exported, '{activity,workload}', safe_workload, true);
  exported := pg_catalog.jsonb_set(exported, '{peerContact}', peer_contact, true);
  return exported || pg_catalog.jsonb_build_object('additionalDomains', additional,
    'civic', private.civic_member_export(caller));
end;
$function$;

-- Only the owning edges become exported. The blocked_id edge remains excluded:
-- it describes somebody else's private choice, not the caller's own block.
do $manifest$
declare changed integer;
begin
  update private.account_lifecycle_manifest
     set export_disposition = 'included', export_projection = 'canonical',
         export_projection_version = 1, export_domain = case table_name
           when 'member_peer_blocks' then 'peerContact.blocks'
           else 'peerContact.crossChapterMutes' end,
         exclusion_reason = null,
         note = coalesce(note, '') || ' Ledger 511: caller-owned contact choices exported as timestamps only; inbound blocks remain private.',
         reviewed_at = private.eastern_day()
   where schema_name = 'private'
     and ((table_name = 'member_peer_blocks' and user_column = 'blocker_id')
       or (table_name = 'cross_chapter_peer_mutes' and user_column = 'user_id'));
  get diagnostics changed = row_count;
  if changed <> 2 then
    raise exception 'member export preference ownership manifest is incomplete' using errcode='55000';
  end if;
end;
$manifest$;

notify pgrst, 'reload schema';
commit;
