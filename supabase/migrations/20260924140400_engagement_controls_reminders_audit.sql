-- Append tenant audit events for chapter-space control updates and
-- organization survey reminder fanout. Existing authorization, writes, grants,
-- and the case-graph lock wrapper stay in place. A refused call never audits.
-- The audit append uses the same selected-organization resolver the two RPCs
-- bind, so a chapterless single-organization steward is audited rather than
-- having its own control update or reminder fanout rolled back.

--
-- The event-type list keeps Main's newest vocabulary (20260924030100 and
-- 20260924100200) and the three Stripe disconnect types from the sibling
-- migration 20260924140100 (PR #2448), so whichever of the two applies last
-- admits both sets.

begin;

set local lock_timeout = '5s';

alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check;

alter table public.organization_audit_events
  add constraint organization_audit_events_event_type_check check (event_type in (
    'first_organization_bootstrap',
    'organization_membership_granted', 'organization_membership_revoked',
    'organization_role_granted', 'organization_role_revoked',
    'staff_mfa_policy_changed', 'qa_question_asked', 'qa_official_replied',
    'qa_follow_up_replied', 'qa_answer_accepted', 'qa_answer_unaccepted',
    'qa_vote_toggled', 'qa_edited', 'qa_deleted', 'analytics_snapshot_read',
    'analytics_export_requested', 'pay_scale_grade_upserted',
    'pay_scale_step_upserted', 'integration_provider_changed',
    'integration_webhook_changed', 'integration_api_key_changed',
    'organization_job_acknowledged', 'organization_job_retry_requested',
    'survey_draft_saved', 'survey_published', 'survey_closed',
    'survey_reopened', 'survey_session_saved', 'survey_session_submitted',
    'case_deadline_extension_requested', 'case_deadline_change_reviewed',
    'case_deadline_applied', 'case_checklist_patched', 'case_step_advanced',
    'case_restriction_toggled', 'case_restriction_access_changed',
    'case_alert_acknowledged', 'case_alert_escalated',
    'case_reminder_created', 'case_reminder_disposed',
    'knowledge_file_uploaded', 'knowledge_file_reviewed',
    'knowledge_file_published_to_catalog', 'knowledge_file_downloaded',
    'knowledge_source_retried', 'knowledge_source_chunks_cleared',
    'contract_clause_created', 'contract_clause_updated',
    'contract_clause_retired', 'contract_clause_restored',
    'member_access_recorded', 'knowledge_collection_changed',
    'knowledge_collection_item_changed', 'knowledge_revision_restored',
    'knowledge_ingest_authorized', 'google_drive_operation_authorized',
    'member_handoff_initiated', 'member_handoff_acknowledged',
    'member_handoff_declined', 'member_handoff_cancelled',
    'member_profile_updated', 'member_profiles_bulk_updated',
    'welcome_campaign_saved', 'welcome_messages_queued',
    'member_operations_import_committed',
    'dues_assessment_issued', 'dues_manual_payment_recorded',
    'dues_credit_event_applied', 'dues_reminder_queued',
    'dues_financial_identity_selected', 'dues_financial_identity_provisioned',
    'dues_stripe_connected', 'dues_stripe_oauth_deferred',
    'dues_stripe_oauth_failed', 'dues_checkout_attention_resolved',
    'dues_stripe_oauth_recovery_required',
    'organization_export_completed', 'public_interest_leads_read',
    'dues_stripe_disconnect_requested', 'dues_stripe_disconnected',
    'dues_stripe_disconnect_attention',
    'chapter_space_controls_updated',
    'survey_reminders_queued'
  ));

alter table public.organization_audit_events
  drop constraint organization_audit_events_metadata_keys;

alter table public.organization_audit_events
  add constraint organization_audit_events_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId',
      'status', 'requireStaffMfa', 'questionId', 'replyId', 'targetKind',
      'voted', 'kind', 'surface', 'exportFormat', 'rowCount', 'suppressedCount',
      'expiresAt', 'grade', 'stepNumber', 'effectiveOn', 'action', 'provider',
      'host', 'events', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence', 'surveyId', 'sessionId', 'privacyMinResponses',
      'caseId', 'fromStep', 'toStep', 'previousDeadline', 'newDeadline',
      'alertId', 'reminderId', 'restricted', 'fileId', 'sourceId', 'category',
      'library', 'reviewStatus', 'indexStatus', 'byteSize', 'handoffId',
      'fromStewardId', 'toStewardId', 'clauseId', 'article',
      'collectionId', 'visibility', 'scope', 'itemKind', 'itemId', 'included',
      'articleId', 'restoredRevisionId', 'restoredFromVersion', 'newVersion',
      'accountEmail', 'fields', 'version', 'campaignId', 'batchId',
      'scopeKind', 'eligibleCount', 'amountCents', 'obligationId',
      'receiptNumber', 'eventKind', 'channel', 'attemptId', 'selectedHat',
      'requestedBy', 'reservationId', 'resolution', 'evidenceReference',
      'reason', 'failureClass', 'publishedPreserved',
      'publishedCandidatesStaged', 'publishedRetirementsStaged',
      'staleCandidatesCleared', 'draftsRetired', 'oauthStateFinalized',
      'resumedRecordedExchange',
      'spaceId', 'postingMode', 'slowModeSeconds', 'approvalsRequired'
    ] = '{}'::jsonb
  );

create or replace function public.queue_organization_survey_reminders(p_survey_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  queued integer;
begin
  perform private.engagement_require_staff(org);
  if not exists (
    select 1 from public.organization_surveys s
    where s.id = p_survey_id and s.organization_id = org and s.status = 'open'
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  with candidates as (
    select d.recipient_user_id
    from public.organization_survey_deliveries d
    where d.organization_id = org
      and d.survey_id = p_survey_id
      and d.state in ('queued', 'sent', 'failed')
      and d.engaged_at is null
  ), inserted as (
    insert into public.engagement_delivery_outbox (
      organization_id, recipient_user_id, delivery_kind, source_kind, source_id
    )
    select org, candidates.recipient_user_id, 'survey_reminder', 'survey', p_survey_id::text
    from candidates
    on conflict (delivery_kind, source_id, recipient_user_id) do update
      set state = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.state
            else 'queued'
          end,
          available_at = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.available_at
            else pg_catalog.now()
          end,
          updated_at = pg_catalog.now()
      where public.engagement_delivery_outbox.state <> 'sent'
    returning recipient_user_id
  )
  select pg_catalog.count(*)::integer into queued from inserted;
  update public.organization_survey_deliveries
  set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
  where organization_id = org and survey_id = p_survey_id and engaged_at is null;
  perform private.mi1_w2_write_audit(org, 'survey_reminders_queued', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', p_survey_id,
    'userId', (select auth.uid()),
    'count', coalesce(queued, 0)
  ));
  return pg_catalog.jsonb_build_object('surveyId', p_survey_id, 'queued', coalesce(queued, 0));
end;
end;
$function$;

create or replace function public.set_chapter_space_controls(
  p_space_id uuid,
  p_posting_mode text,
  p_slow_mode_seconds integer,
  p_approvals_required boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  space public.chapter_spaces%rowtype;
begin
  perform private.engagement_require_staff(org);
  select * into space from public.chapter_spaces where id = p_space_id;
  if not found or not private.mi1_w2_same_org_chapter(org, space.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_posting_mode not in ('members', 'staff_only', 'read_only')
     or p_slow_mode_seconds not between 0 and 86400 then
    raise exception 'invalid channel controls' using errcode = '22023';
  end if;
  insert into public.chapter_space_controls (
    organization_id, space_id, posting_mode, slow_mode_seconds, approvals_required, updated_by
  ) values (org, space.id, p_posting_mode, p_slow_mode_seconds, coalesce(p_approvals_required, false), (select auth.uid()))
  on conflict (space_id) do update
    set posting_mode = excluded.posting_mode,
        slow_mode_seconds = excluded.slow_mode_seconds,
        approvals_required = excluded.approvals_required,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'chapter_space_controls_updated', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'spaceId', space.id,
    'userId', (select auth.uid()),
    'postingMode', p_posting_mode,
    'slowModeSeconds', p_slow_mode_seconds,
    'approvalsRequired', coalesce(p_approvals_required, false)
  ));
  return pg_catalog.jsonb_build_object(
    'spaceId', space.id, 'postingMode', p_posting_mode,
    'slowModeSeconds', p_slow_mode_seconds,
    'approvalsRequired', coalesce(p_approvals_required, false)
  );
end;
end;
$function$;

revoke all on function public.queue_organization_survey_reminders(uuid) from public, anon, authenticated;
revoke all on function public.set_chapter_space_controls(uuid, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.queue_organization_survey_reminders(uuid) to authenticated;
grant execute on function public.set_chapter_space_controls(uuid, text, integer, boolean) to authenticated;
revoke execute on function public.queue_organization_survey_reminders(uuid) from service_role;
revoke execute on function public.set_chapter_space_controls(uuid, text, integer, boolean) from service_role;

notify pgrst, 'reload schema';

commit;
