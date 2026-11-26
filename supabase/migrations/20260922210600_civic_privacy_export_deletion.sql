-- Civic data in the member's own export, and removed with the account.
--
-- Host obligation from civic-data-resolver docs/MERGE-BACK.md: the mailing
-- address (collected with consent), the resolved places and districts, the
-- member's letters to officials, their "something's wrong" reports, and any
-- ratings they authored join the account export, and account deletion
-- removes the member's civic rows.
--
-- Export: public.get_member_data_export() is re-emitted from its current
-- definition (20260907150000_account_lifecycle_manifest.sql) with exactly one
-- change -- the returned object gains a top-level "civic" section built by
-- private.civic_member_export(caller). The single lifecycle audit write, the
-- peer-contact section and additionalDomains are untouched.
--
-- Deletion: every civic user column is a bare uuid (see
-- 20260922210000_civic_resolver_foundation.sql), so nothing cascades from
-- auth.users. Account deletion is a delete from auth.users, so an AFTER
-- DELETE statement trigger over the deleted identities removes the member's
-- address, derived districts/quarantine/change log, places, local reports and
-- letters, and detaches officer attribution (created_by / rated_by) on
-- chapter-owned civic rows, which stay. Campaign rows are kept; their
-- participation counts are computed live and simply no longer include the
-- deleted member. This is the host pattern used for public.member_saved_views
-- (20260917101000). The three deletion RPCs are not redefined: they are
-- source-pinned case-graph writers (20260907151000) and do not delete member
-- data themselves.
--
-- Every civic trigger and trigger function enters the reviewed account
-- lifecycle trigger surface here, and the migration refuses to commit if the
-- review is incomplete.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.civic_member_export(p_caller uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Same transaction entry as private.member_data_export_without_peer_contact:
  -- the case-graph gate first (re-entrant inside the exporter), then reads.
  perform private.lock_case_graph(array[p_caller], array[]::uuid[]);
  return pg_catalog.jsonb_build_object(
    'address', (
      select pg_catalog.jsonb_build_object(
        'fullName', address.full_name,
        'line1', address.line1,
        'line2', address.line2,
        'city', address.city,
        'state', address.state,
        'postalCode', address.postal_code,
        'consentVersion', address.consent_version,
        'consentedAt', address.consented_at,
        'lookupStatus', address.civic_lookup_status,
        'placesCheckedAt', address.places_checked_at,
        'updatedAt', address.updated_at)
      from public.civic_member_addresses address
      where address.user_id = p_caller),
    'districts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ocdId', link.ocd_id,
        'mapVersion', link.map_version,
        'resolvedAt', link.resolved_at) order by link.ocd_id)
      from public.civic_user_districts link
      where link.user_id = p_caller), '[]'::jsonb),
    'quarantine', (
      select pg_catalog.jsonb_build_object(
        'reason', held.reason,
        'quarantinedAt', held.quarantined_at)
      from public.civic_quarantine held
      where held.user_id = p_caller),
    'places', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'geoid', user_place.geoid,
        'kind', place.kind,
        'name', place.name,
        'state', place.state,
        'resolvedAt', user_place.resolved_at) order by user_place.geoid)
      from public.civic_user_places user_place
      join public.civic_places place on place.geoid = user_place.geoid
      where user_place.user_id = p_caller), '[]'::jsonb),
    'messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', message.id,
        'campaignId', message.campaign_id,
        'campaignTitle', campaign.title,
        'officialName', message.official_name,
        'office', message.office,
        'channel', message.channel,
        'status', message.status,
        'subject', message.subject,
        'body', message.body,
        'draftedAt', message.drafted_at,
        'sentAt', message.sent_at) order by message.drafted_at, message.id)
      from public.civic_member_messages message
      join public.civic_campaigns campaign on campaign.id = message.campaign_id
      where message.user_id = p_caller), '[]'::jsonb),
    'localReports', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', report.id,
        'jurisdictionId', report.jurisdiction_id,
        'officialId', report.official_id,
        'note', report.note,
        'status', report.status,
        'createdAt', report.created_at,
        'resolvedAt', report.resolved_at) order by report.created_at, report.id)
      from public.civic_local_flags report
      where report.user_id = p_caller), '[]'::jsonb),
    'ratingsAuthored', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', rating.id,
        'chapterId', rating.org_id,
        'officialName', rating.official_name,
        'office', rating.office,
        'cycle', rating.cycle,
        'grade', rating.grade,
        'endorsed', rating.endorsed,
        'rationale', rating.rationale,
        'published', rating.published,
        'createdAt', rating.created_at,
        'updatedAt', rating.updated_at) order by rating.created_at, rating.id)
      from public.civic_official_ratings rating
      where rating.rated_by = p_caller), '[]'::jsonb)
  );
end;
$function$;
revoke all on function private.civic_member_export(uuid) from public, anon, authenticated, service_role;

create or replace function public.get_member_data_export()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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

  -- This private implementation performs the single lifecycle audit write.
  exported := private.member_data_export_without_peer_contact();

  select pg_catalog.jsonb_build_object(
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

  -- No peer id, profile label, email/address, share code, or digest is added.
  -- Direction is expressed only relative to the authenticated caller.
  exported := pg_catalog.jsonb_set(exported, '{activity,workload}', safe_workload, true);
  exported := pg_catalog.jsonb_set(exported, '{peerContact}', peer_contact, true);
  return exported || pg_catalog.jsonb_build_object('additionalDomains', additional,
    'civic', private.civic_member_export(caller));
end;
$function$;

create function private.civic_delete_for_deleted_identities()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Re-entrant: the auth.users statement gate already holds the case-graph
  -- lock for this deletion, so this adds no new lock order.
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  delete from public.civic_member_messages
  where user_id in (select id from deleted_identities);
  delete from public.civic_local_flags
  where user_id in (select id from deleted_identities);
  delete from public.civic_user_places
  where user_id in (select id from deleted_identities);
  delete from public.civic_user_districts
  where user_id in (select id from deleted_identities);
  delete from public.civic_quarantine
  where user_id in (select id from deleted_identities);
  delete from public.civic_user_district_changes
  where user_id in (select id from deleted_identities);
  delete from public.civic_member_addresses
  where user_id in (select id from deleted_identities);
  update public.civic_campaigns set created_by = null
  where created_by in (select id from deleted_identities);
  update public.civic_official_ratings set rated_by = null
  where rated_by in (select id from deleted_identities);
  update public.civic_local_jurisdictions set created_by = null
  where created_by in (select id from deleted_identities);
  update public.civic_local_officials set created_by = null
  where created_by in (select id from deleted_identities);
  return null;
end;
$function$;
revoke all on function private.civic_delete_for_deleted_identities() from public, anon, authenticated, service_role;

create trigger civic_after_account_delete after delete on auth.users
referencing old table as deleted_identities
for each statement execute function private.civic_delete_for_deleted_identities();

-- Every civic trigger and trigger function enters the reviewed lifecycle
-- trigger surface, with hashes taken from the surface itself.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
where (surface.kind = 'trigger' and (
    (surface.schema_name = 'auth' and surface.table_name = 'users' and surface.object_name = 'civic_after_account_delete')
    or (surface.schema_name = 'public' and surface.table_name = 'civic_member_addresses' and surface.object_name = 'civic_member_address_changed')
    or (surface.schema_name = 'public' and surface.table_name = 'civic_local_jurisdictions' and surface.object_name = 'civic_local_jurisdiction_clean')
    or (surface.schema_name = 'public' and surface.table_name = 'civic_local_flags' and surface.object_name = 'civic_local_flag_limit')
    or (surface.schema_name = 'public' and surface.table_name = 'civic_campaigns' and surface.object_name = 'civic_campaign_keep_letters')))
  or (surface.kind = 'function' and surface.schema_name = 'private' and surface.table_name = '' and surface.object_name in (
    'civic_delete_for_deleted_identities()',
    'civic_member_address_changed()',
    'civic_local_jurisdiction_clean()',
    'civic_local_flag_limit()',
    'civic_campaign_keep_letters()'));

do $assert_civic_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the civic privacy migration';
  end if;
end;
$assert_civic_trigger_review$;

notify pgrst, 'reload schema';

commit;
