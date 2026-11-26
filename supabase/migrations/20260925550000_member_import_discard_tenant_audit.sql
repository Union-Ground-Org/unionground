-- SEC-UG-MEMBER-IMPORT-DISCARD-AUDIT-20260921: discarding a staged member
-- operations import deletes its staged rows without an organization audit
-- event, while commit_member_operations_import records one. Admit
-- member_operations_import_discarded and re-emit only
-- public.discard_member_operations_import so a successful discard appends that
-- event with the batch id, import kind and deleted row count. The payload
-- reuses admitted metadata keys and never carries staged row contents. Replay,
-- refusal, return shape, grants and organization_audit_events_metadata_keys
-- are unchanged. The event-type list keeps Main's newest vocabulary
-- (20260925120000) and appends the new token at the end.

begin;

set local lock_timeout = '5s';

-- 20260907151000 authenticated the 20260830160000 source at
-- caa634cb36e6cf1ce9af205cc855b87e5defe4d8d844d4a48cb7040f4578c669 and wrapped
-- it; the wrapped body is the only predecessor this repair may supersede.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.discard_member_operations_import(uuid, uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'c8f92aa1f3e841ffefabfcdc97c6c5d51c06de3c06783477775498af0356edb0' then
    raise exception 'unreviewed discard_member_operations_import predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check;

alter table public.organization_audit_events
  add constraint organization_audit_events_event_type_check check (event_type in (
    'first_organization_bootstrap', 'organization_membership_granted',
    'organization_membership_revoked', 'organization_role_granted',
    'organization_role_revoked', 'staff_mfa_policy_changed',
    'qa_question_asked', 'qa_official_replied', 'qa_follow_up_replied',
    'qa_answer_accepted', 'qa_answer_unaccepted', 'qa_vote_toggled',
    'qa_edited', 'qa_deleted', 'analytics_snapshot_read',
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
    'member_operations_import_committed', 'dues_assessment_issued',
    'dues_manual_payment_recorded', 'dues_credit_event_applied',
    'dues_reminder_queued', 'dues_financial_identity_selected',
    'dues_financial_identity_provisioned', 'dues_stripe_connected',
    'dues_stripe_oauth_deferred', 'dues_stripe_oauth_failed',
    'dues_checkout_attention_resolved', 'dues_stripe_oauth_recovery_required',
    'organization_export_completed', 'public_interest_leads_read',
    'dues_stripe_disconnect_requested', 'dues_stripe_disconnected',
    'dues_stripe_disconnect_attention', 'chapter_space_controls_updated',
    'survey_reminders_queued', 'survey_privacy_floor_changed',
    'survey_operations_configured', 'survey_task_updated',
    'survey_response_review_updated', 'pulse_prompt_saved',
    'weekly_question_reviewed', 'weekly_question_policy_saved',
    'weekly_question_selection_run', 'live_poll_saved',
    'live_poll_transitioned',
    'member_operations_import_discarded'
  ));

create or replace function public.discard_member_operations_import(
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.require_member_operations_admin();
  request_payload jsonb := pg_catalog.jsonb_build_object('batchId', p_batch_id);
  prior jsonb;
  result jsonb;
  batch_kind text;
  discarded integer;
begin
  prior := private.member_operations_replay(
    org, 'discard_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  update public.organization_import_batches set state = 'discarded', discarded_at = pg_catalog.now()
  where id = p_batch_id and organization_id = org and state in ('uploaded','validated','failed')
  returning kind into batch_kind;
  if not found then raise exception 'batch is not discardable' using errcode = '55000'; end if;
  delete from public.organization_import_rows where batch_id = p_batch_id and organization_id = org;
  get diagnostics discarded = row_count;
  perform private.mi1_w2_write_audit(org, 'member_operations_import_discarded', pg_catalog.jsonb_build_object(
    'organizationId', org, 'batchId', p_batch_id, 'kind', batch_kind, 'count', discarded
  ));
  result := pg_catalog.jsonb_build_object('id', p_batch_id, 'state', 'discarded');
  perform private.member_operations_store_receipt(
    org, 'discard_member_operations_import', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

revoke all on function public.discard_member_operations_import(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.discard_member_operations_import(uuid, uuid)
  to authenticated;

do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.discard_member_operations_import(uuid, uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '273d0df328c70bbc2ea8451b087c6533c43cc6923c7b578ce39035da046f081e' then
    raise exception 'discard_member_operations_import source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
