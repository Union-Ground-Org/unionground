-- CR-084: get_pending_dues_stripe_oauth_exchange recovery branches must write
-- a row that satisfies private.dues_stripe_oauth_states checks, and the
-- documented recovery audit event must be an admitted organization_audit_events
-- type. This does not redefine organization_audit_events_metadata_keys.

begin;

set local lock_timeout = '5s';

-- The 20260907151000 installation wrapper authenticated this function's inner
-- source at 748ebf5fc1caf686571c046a86ea0539a961d44e1472a3acacc7f4dd771befe3
-- and then wrapped it. Refuse any other predecessor before replacing the
-- wrapped body.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest not in (
    '748ebf5fc1caf686571c046a86ea0539a961d44e1472a3acacc7f4dd771befe3',
    'b0b4bfd327e31353bc4126f8cc31b9a813b88c4890bdbaf7406deb3d3297ccb1'
  ) then
    raise exception 'unreviewed get_pending_dues_stripe_oauth_exchange predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

-- Admit the recovery event the pending-exchange RPC already documents. Keep
-- every previously admitted type; do not touch metadata_keys.
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
    'dues_stripe_oauth_recovery_required'
  ));

create or replace function public.get_pending_dues_stripe_oauth_exchange(
  p_organization_id uuid,
  p_requested_by uuid,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  candidate_count integer;
  account_id text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_organization_id is null
     or p_requested_by is null
     or p_selected_hat not in ('admin', 'vp') then
    raise exception 'dues Stripe exchange recovery refused' using errcode = '42501';
  end if;

  -- A ready connection is already the organization’s current explicit choice.
  -- Never let an older recorded exchange overwrite it during a later start.
  if exists (
    select 1 from public.dues_provider_connections connection
    where connection.organization_id = p_organization_id
      and connection.state = 'ready'
  ) then
    update private.dues_stripe_oauth_states state
      set exchanged_account_id = coalesce(state.exchanged_account_id, state.exchange_account_id),
          recovery_required_at = coalesce(state.recovery_required_at, now()),
          exchange_account_id = null,
          exchange_recorded_at = null,
          callback_state = 'attention_required'
    where state.organization_id = p_organization_id
      and state.requested_by = p_requested_by
      and state.selected_hat = p_selected_hat
      and state.consumed_at is null
      and state.recovery_required_at is null
      and state.exchange_started_at is not null
      and state.exchange_account_id is not null
      and state.exchange_recorded_at is not null;
    return pg_catalog.jsonb_build_object('state', 'none');
  end if;

  select count(*), min(state.exchange_account_id)
    into candidate_count, account_id
  from private.dues_stripe_oauth_states state
  where state.organization_id = p_organization_id
    and state.requested_by = p_requested_by
    and state.selected_hat = p_selected_hat
    and state.consumed_at is null
    and state.recovery_required_at is null
    and state.exchange_started_at is not null
    and state.exchange_account_id is not null
    and state.exchange_recorded_at is not null;

  if candidate_count = 0 then
    return pg_catalog.jsonb_build_object('state', 'none');
  end if;

  if candidate_count <> 1 then
    update private.dues_stripe_oauth_states state
      set exchanged_account_id = coalesce(state.exchanged_account_id, state.exchange_account_id),
          recovery_required_at = coalesce(state.recovery_required_at, now()),
          exchange_account_id = null,
          exchange_recorded_at = null,
          callback_state = 'attention_required'
    where state.organization_id = p_organization_id
      and state.requested_by = p_requested_by
      and state.selected_hat = p_selected_hat
      and state.consumed_at is null
      and state.recovery_required_at is null
      and state.exchange_started_at is not null
      and state.exchange_account_id is not null
      and state.exchange_recorded_at is not null;

    update public.dues_provider_connections
      set state = 'attention_required',
          last_error_class = 'oauth_recorded_exchange_ambiguous',
          updated_at = now()
    where organization_id = p_organization_id
      and state <> 'ready';

    perform private.mi1_write_tenant_audit(
      p_organization_id,
      'dues_stripe_oauth_recovery_required',
      pg_catalog.jsonb_build_object('requestedBy', p_requested_by, 'reason', 'recorded_exchange_ambiguous')
    );
    return pg_catalog.jsonb_build_object('state', 'attention_required');
  end if;

  return pg_catalog.jsonb_build_object('state', 'recorded', 'accountId', account_id);
end;
end;
$function$;

revoke all on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)
  to service_role;

comment on function public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text) is
  'Service-only lookup for one durably exchanged, unconsumed Stripe account. Recovery branches copy the legacy account id onto exchanged_account_id, clear the constrained legacy pair, and stamp recovery_required_at so the documented recovery state is reachable.';

-- Re-pin the 20260907151000 installation-wrapper ledger to this inner source.
-- Fresh installs still wrap the original 20260831210909 body first; this file
-- then replaces the wrapped routine. The wrap-time hash stays so a later
-- unreviewed edit of that original inner source still fails closed.
do $ledger$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_pending_dues_stripe_oauth_exchange(uuid, uuid, text)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '3a343c15230e0532835ea1ab71e8ba2e5a3a4ceeb86bfd7802b20f08c300bffa' then
    raise exception 'get_pending_dues_stripe_oauth_exchange source hash drifted: %', digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
