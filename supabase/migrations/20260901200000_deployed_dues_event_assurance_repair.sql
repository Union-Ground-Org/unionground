-- Forward-only repair for live catalog drift exposed by Assurance nightly run
-- 33551680413. The migration ledger already named the Dues review migration,
-- so this file reasserts the reviewed catalog state under a new identity.
-- It creates no tenant, user, provider operation, credential, or data row.

begin;

set local lock_timeout = '5s';

-- Reassert the complete Dues audit vocabulary. Production retained the
-- pre-Dues constraints even though its migration ledger named the review
-- migration; SAMPLE already has this definition, so the operation is an
-- idempotent parity repair there.
alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check,
  drop constraint organization_audit_events_metadata_keys;

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
    'dues_stripe_oauth_failed', 'dues_checkout_attention_resolved'
  )),
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
      'reason', 'failureClass'
    ] = '{}'::jsonb
  );

-- These are caller-bound RPCs. The service role has separate, narrower Dues
-- worker functions and must not inherit the browser-facing capabilities.
revoke execute on function public.apply_dues_credit_event(uuid, text, integer, text, text, text) from service_role;
grant execute on function public.apply_dues_credit_event(uuid, text, integer, text, text, text) to authenticated;
revoke execute on function public.cancel_dues_checkout_reservation(uuid) from service_role;
grant execute on function public.cancel_dues_checkout_reservation(uuid) to authenticated;
revoke execute on function public.create_dues_checkout_reservation(uuid, text) from service_role;
grant execute on function public.create_dues_checkout_reservation(uuid, text) to authenticated;
revoke execute on function public.disconnect_dues_stripe_account(text) from service_role;
grant execute on function public.disconnect_dues_stripe_account(text) to authenticated;
revoke execute on function public.get_dues_provider_status(text) from service_role;
grant execute on function public.get_dues_provider_status(text) to authenticated;
revoke execute on function public.get_dues_workspace(text, text, date, uuid, integer, text) from service_role;
grant execute on function public.get_dues_workspace(text, text, date, uuid, integer, text) to authenticated;
revoke execute on function public.get_mobile_dues_context() from service_role;
grant execute on function public.get_mobile_dues_context() to authenticated;
revoke execute on function public.get_my_dues_workspace(uuid, integer) from service_role;
grant execute on function public.get_my_dues_workspace(uuid, integer) to authenticated;
revoke execute on function public.issue_dues_assessment_batch(text, text, text, text, integer, date, text, text, text) from service_role;
grant execute on function public.issue_dues_assessment_batch(text, text, text, text, integer, date, text, text, text) to authenticated;
revoke execute on function public.preview_dues_assessment_batch(text, text, text, text, integer, date, text) from service_role;
grant execute on function public.preview_dues_assessment_batch(text, text, text, text, integer, date, text) to authenticated;
revoke execute on function public.queue_dues_reminder(uuid, text, text, text) from service_role;
grant execute on function public.queue_dues_reminder(uuid, text, text, text) to authenticated;
revoke execute on function public.record_dues_manual_payment(uuid, integer, date, text, text, text, text, text) from service_role;
grant execute on function public.record_dues_manual_payment(uuid, integer, date, text, text, text, text, text) to authenticated;
revoke execute on function public.request_dues_stripe_connection(text) from service_role;
grant execute on function public.request_dues_stripe_connection(text) to authenticated;

-- The first tenant-isolation repair called a SECURITY DEFINER scope helper
-- once per historical event row. Production's 1,509-row scan therefore made
-- 1,509 correlated calls and crossed the API statement timeout. Keep tenant
-- equality before every widening branch, but evaluate caller context as
-- non-correlated init plans and perform the chapter comparison setwise.
drop policy if exists member_events_select_scoped on public.member_events;
create policy member_events_select_scoped on public.member_events
  for select to authenticated
  using (
    (select private.current_member_organization()) is not null
    and exists (
      select 1
      from public.chapters event_chapter
      where event_chapter.id = member_events.chapter_id
        and event_chapter.organization_id = (select private.current_member_organization())
        and (
          event_chapter.id = (select private.current_member_chapter())
          or coalesce(member_events.is_public_across_agencies, false)
          or (
            coalesce(member_events.is_public, false)
            and event_chapter.region is not null
            and event_chapter.region = (
              select member_chapter.region
              from public.chapters member_chapter
              where member_chapter.id = (select private.current_member_chapter())
                and member_chapter.organization_id = (select private.current_member_organization())
            )
          )
        )
    )
  );

notify pgrst, 'reload schema';

commit;
