-- SEC-UG-PUBLIC-INTEREST-LEAD-READS-ARE-NOT-TENANT-SCOPED-OR-DURABLY-AUDITED-20260921
--
-- public.public_interest_submissions was readable by any coordinator, admin
-- or vp through a direct SELECT policy (20260812130000, line 131). The policy
-- tested a legacy global role, not the caller's organization, and a direct
-- table read leaves no durable access record.
--
-- This migration:
--   * gives each lead an owning tenant (organization_id). The anonymous public
--     landing still writes NULL; a NULL lead is unassigned and readable by no
--     tenant. The column carries no foreign key on purpose: an FK to
--     public.organizations would pull this anonymous intake table into the
--     account case graph and force the service-only submit/stop paths behind
--     the case-graph entry gate. A lead whose id matches no organization is
--     simply unreadable.
--   * removes the direct SELECT policy and the authenticated table grant, so
--     the only staff read path is public.list_public_interest_leads.
--   * adds that RPC: MFA, stale-scope guard, coordinator/admin/vp organization
--     role in the selected organization, rows filtered to that organization,
--     and one durable organization_audit_events row per successful read.
--   * admits the public_interest_leads_read audit event type. The list keeps
--     organization_export_completed from 20260924030100 (PR #2338) so either
--     apply order leaves both types admitted.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.public_interest_submissions
  add column organization_id uuid;

comment on column public.public_interest_submissions.organization_id is
  'Owning tenant of the lead. NULL is an unassigned lead from the global public landing and is readable by no tenant.';

create index public_interest_submissions_organization_followup_idx
  on public.public_interest_submissions (organization_id, last_submitted_at desc)
  where organization_id is not null;

drop policy public_interest_submissions_staff_read on public.public_interest_submissions;
revoke all on public.public_interest_submissions from public, anon, authenticated;

alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check;

alter table public.organization_audit_events
  add constraint organization_audit_events_event_type_check check (event_type in (
    'first_organization_bootstrap',
    'organization_membership_granted',
    'organization_membership_revoked',
    'organization_role_granted',
    'organization_role_revoked',
    'staff_mfa_policy_changed',
    'qa_question_asked',
    'qa_official_replied',
    'qa_follow_up_replied',
    'qa_answer_accepted',
    'qa_answer_unaccepted',
    'qa_vote_toggled',
    'qa_edited',
    'qa_deleted',
    'analytics_snapshot_read',
    'analytics_export_requested',
    'pay_scale_grade_upserted',
    'pay_scale_step_upserted',
    'integration_provider_changed',
    'integration_webhook_changed',
    'integration_api_key_changed',
    'organization_job_acknowledged',
    'organization_job_retry_requested',
    'survey_draft_saved',
    'survey_published',
    'survey_closed',
    'survey_reopened',
    'survey_session_saved',
    'survey_session_submitted',
    'case_deadline_extension_requested',
    'case_deadline_change_reviewed',
    'case_deadline_applied',
    'case_checklist_patched',
    'case_step_advanced',
    'case_restriction_toggled',
    'case_restriction_access_changed',
    'case_alert_acknowledged',
    'case_alert_escalated',
    'case_reminder_created',
    'case_reminder_disposed',
    'knowledge_file_uploaded',
    'knowledge_file_reviewed',
    'knowledge_file_published_to_catalog',
    'knowledge_file_downloaded',
    'knowledge_source_retried',
    'knowledge_source_chunks_cleared',
    'contract_clause_created',
    'contract_clause_updated',
    'contract_clause_retired',
    'contract_clause_restored',
    'member_access_recorded',
    'knowledge_collection_changed',
    'knowledge_collection_item_changed',
    'knowledge_revision_restored',
    'knowledge_ingest_authorized',
    'google_drive_operation_authorized',
    'member_handoff_initiated',
    'member_handoff_acknowledged',
    'member_handoff_declined',
    'member_handoff_cancelled',
    'member_profile_updated',
    'member_profiles_bulk_updated',
    'welcome_campaign_saved',
    'welcome_messages_queued',
    'member_operations_import_committed',
    'dues_assessment_issued',
    'dues_manual_payment_recorded',
    'dues_credit_event_applied',
    'dues_reminder_queued',
    'dues_financial_identity_selected',
    'dues_financial_identity_provisioned',
    'dues_stripe_connected',
    'dues_stripe_oauth_deferred',
    'dues_stripe_oauth_failed',
    'dues_checkout_attention_resolved',
    'dues_stripe_oauth_recovery_required',
    'organization_export_completed',
    'public_interest_leads_read'
  ));

create function public.list_public_interest_leads(p_expected_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  leads jsonb;
  total integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select pg_catalog.count(*)::integer,
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', lead.id,
      'email', lead.email,
      'name', lead.name,
      'interest', lead.interest,
      'locale', lead.locale,
      'status', lead.status,
      'consentAt', lead.consent_at,
      'lastSubmittedAt', lead.last_submitted_at,
      'createdAt', lead.created_at
    ) order by lead.last_submitted_at desc, lead.id), '[]'::jsonb)
  into total, leads
  from (
    select s.*
    from public.public_interest_submissions s
    where s.organization_id = org
    order by s.last_submitted_at desc, s.id
    limit 500
  ) lead;

  perform private.mi1_write_tenant_audit(org, 'public_interest_leads_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'public_interest_leads',
    'rowCount', total
  ));

  return pg_catalog.jsonb_build_object('organizationId', org, 'rowCount', total, 'leads', leads);
end;
$function$;

comment on function public.list_public_interest_leads(uuid) is
  'Coordinator/admin/vp read of the selected organization''s public-interest leads (newest 500). Requires MFA and the expected-organization guard, enters through private.lock_case_graph, and writes one durable public_interest_leads_read audit event per successful read.';

revoke all on function public.list_public_interest_leads(uuid) from public, anon, service_role;
grant execute on function public.list_public_interest_leads(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
