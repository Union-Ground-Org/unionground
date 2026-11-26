-- SEC-UG-DUES-STRIPE-DISCONNECT-AUDIT-20260921
--
-- Provider-connection disconnect mutations omitted the tenant audit coverage
-- used by connect and recovery. Re-emit the session disconnect request RPC and
-- the service-role completion RPC so a row that actually moved writes an
-- admitted event. Bounded metadata only: organizationId, selectedHat,
-- fromStatus, included (account-label presence), requestedBy. Never the raw
-- stripe_account_id. The completion worker id is a lease token, not a member;
-- requestedBy is the member who requested disconnect (only a pre-existing
-- request falls back to the member who connected the account). A requester who
-- has since left keeps their retained UUID; no other member is substituted.

begin;

set local lock_timeout = '5s';

-- 20260907151000 wrapped the 20260831110200 / 20260831170400 bodies. Those
-- wrapped sources are the only predecessors this repair may replace.
do $predecessor$
declare
  disconnect_source text;
  disconnect_digest text;
  complete_source text;
  complete_digest text;
begin
  select p.prosrc into strict disconnect_source
    from pg_catalog.pg_proc p
   where p.oid = 'public.disconnect_dues_stripe_account(text)'::regprocedure;
  disconnect_digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(disconnect_source, 'UTF8'), 'sha256'),
    'hex'
  );
  if disconnect_digest is distinct from 'f5fe4bbad253435d9c55ad755eaea53d3743ae73cb272c40967560490581df7f' then
    raise exception 'unreviewed disconnect_dues_stripe_account predecessor: %', disconnect_digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict complete_source
    from pg_catalog.pg_proc p
   where p.oid = 'public.complete_dues_stripe_disconnect(text, integer, uuid, text, text)'::regprocedure;
  complete_digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(complete_source, 'UTF8'), 'sha256'),
    'hex'
  );
  if complete_digest is distinct from 'bcdd21a5e2bee3b152773402af3c89eb13c8bf1dafb90150059f584b965be7b9' then
    raise exception 'unreviewed complete_dues_stripe_disconnect predecessor: %', complete_digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

-- Admit the three disconnect events. Keep every previously admitted type,
-- including organization_export_completed (20260924030100) and
-- public_interest_leads_read (20260924100200); do
-- not touch metadata_keys (every payload key already exists on that list).
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
    'dues_stripe_disconnect_attention'
  ));

create or replace function public.disconnect_dues_stripe_account(p_selected_hat text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  prior_state text;
  prior_label_present boolean;
begin
  select connection.state, connection.account_label is not null
    into prior_state, prior_label_present
    from public.dues_provider_connections connection
   where connection.organization_id = org
     and connection.state in ('ready', 'attention_required')
     for update;
  update public.dues_provider_connections
     set state = 'disconnecting', updated_at = now(), last_error_class = null
   where organization_id = org
     and state in ('ready', 'attention_required');
  if found then
    perform private.mi1_write_tenant_audit(
      org,
      'dues_stripe_disconnect_requested',
      pg_catalog.jsonb_build_object(
        'organizationId', org,
        'selectedHat', p_selected_hat,
        'fromStatus', prior_state,
        'included', prior_label_present,
        'requestedBy', (select auth.uid())
      )
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'state', coalesce((select state from public.dues_provider_connections where organization_id = org), 'unset')
  );
end;
end;
$function$;

create or replace function public.complete_dues_stripe_disconnect(
  p_account_id text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_outcome text,
  p_failure_class text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  connection public.dues_provider_connections%rowtype;
  audit_actor uuid;
  audit_event text;
  audit_metadata jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_outcome not in ('disconnected', 'attention_required') then
    raise exception 'invalid dues disconnect completion' using errcode = '22023';
  end if;
  select * into connection
  from public.dues_provider_connections row
  where row.stripe_account_id = p_account_id
  for update;
  if not found or connection.state <> 'disconnecting'
     or connection.disconnect_lease_epoch <> p_lease_epoch
     or connection.disconnect_lease_owner is distinct from p_lease_owner
     or connection.disconnect_lease_expires_at <= now() then
    raise exception 'dues disconnect lease stale' using errcode = '42501';
  end if;

  -- disconnect_lease_owner is the reconciliation worker id (randomUUID), not a
  -- tenant member. Attribute the event to the member who requested this
  -- disconnect: the request event keeps that UUID even after the account is
  -- deleted, so never substitute another member. Only a request queued before
  -- request events existed falls back to the member who connected the account.
  select event.actor_user_id
    into audit_actor
    from public.organization_audit_events event
   where event.organization_id = connection.organization_id
     and event.event_type = 'dues_stripe_disconnect_requested'
   order by event.created_at desc
   limit 1;
  if audit_actor is null then
    select candidate.actor
      into audit_actor
      from (
        select 1 as rank, event.actor_user_id as actor, event.created_at as seen_at
          from public.organization_audit_events event
         where event.organization_id = connection.organization_id
           and event.event_type = 'dues_stripe_connected'
        union all
        select 2, state.requested_by, coalesce(state.consumed_at, state.created_at)
          from private.dues_stripe_oauth_states state
         where state.organization_id = connection.organization_id
           and state.requested_by is not null
      ) candidate
     order by candidate.rank, candidate.seen_at desc
     limit 1;
  end if;

  if p_outcome = 'disconnected' then
    if exists (
      select 1 from public.dues_checkout_reservations reservation
      where reservation.organization_id = connection.organization_id
        and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling', 'attention_required')
    ) then
      raise exception 'dues disconnect has active checkout' using errcode = '55000';
    end if;
    update public.dues_provider_connections
    set state = 'disconnected', stripe_account_id = null, account_label = null,
        charges_enabled = false, payouts_enabled = false, disconnected_at = now(),
        last_error_class = null, disconnect_lease_owner = null,
        disconnect_lease_expires_at = null, updated_at = now()
    where organization_id = connection.organization_id;
    audit_event := 'dues_stripe_disconnected';
    audit_metadata := pg_catalog.jsonb_build_object(
      'requestedBy', audit_actor,
      'organizationId', connection.organization_id,
      'fromStatus', connection.state,
      'included', connection.account_label is not null
    );
  else
    update public.dues_provider_connections
    set state = 'attention_required', last_error_class = nullif(pg_catalog.left(p_failure_class, 80), ''),
        disconnect_lease_owner = null, disconnect_lease_expires_at = null, updated_at = now()
    where organization_id = connection.organization_id;
    audit_event := 'dues_stripe_disconnect_attention';
    audit_metadata := pg_catalog.jsonb_build_object(
      'requestedBy', audit_actor,
      'organizationId', connection.organization_id,
      'fromStatus', connection.state,
      'included', connection.account_label is not null,
      'failureClass', nullif(pg_catalog.left(p_failure_class, 80), '')
    );
  end if;

  if exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = connection.organization_id
      and membership.user_id = audit_actor
  ) then
    perform private.mi1_write_tenant_audit(connection.organization_id, audit_event, audit_metadata);
  elsif audit_actor is not null then
    -- The requester has left the organization. The service audit writer only
    -- admits current members, so append the event under the retained UUID.
    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      connection.organization_id, audit_event, audit_actor,
      extensions.gen_random_uuid(), audit_metadata
    );
  end if;
  return pg_catalog.jsonb_build_object('state', p_outcome);
end;
end;
$function$;

revoke all on function public.disconnect_dues_stripe_account(text)
  from public, anon, authenticated, service_role;
grant execute on function public.disconnect_dues_stripe_account(text)
  to authenticated;

revoke all on function public.complete_dues_stripe_disconnect(text, integer, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.complete_dues_stripe_disconnect(text, integer, uuid, text, text)
  to service_role;

comment on function public.disconnect_dues_stripe_account(text) is
  'Session financial-hat RPC. Moves a ready or attention_required Stripe connection to disconnecting and writes dues_stripe_disconnect_requested only when a row actually moved. Bounded audit metadata; never the provider account id.';

comment on function public.complete_dues_stripe_disconnect(text, integer, uuid, text, text) is
  'Service-only terminal disconnect. Unchanged lease, stale, and active-checkout refusals. Writes dues_stripe_disconnected or dues_stripe_disconnect_attention attributed to the retained requester; the attention event carries the bounded failure class.';

do $ledger$
declare
  disconnect_source text;
  disconnect_digest text;
  complete_source text;
  complete_digest text;
begin
  select p.prosrc into strict disconnect_source
    from pg_catalog.pg_proc p
   where p.oid = 'public.disconnect_dues_stripe_account(text)'::regprocedure;
  disconnect_digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(disconnect_source, 'UTF8'), 'sha256'),
    'hex'
  );
  if disconnect_digest is distinct from '4a17773fa5a1d0c4e1d7c35d7be5c0e3882c33f1370ed2d66d4070a4a65a1e68' then
    raise exception 'disconnect_dues_stripe_account source hash drifted: %', disconnect_digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict complete_source
    from pg_catalog.pg_proc p
   where p.oid = 'public.complete_dues_stripe_disconnect(text, integer, uuid, text, text)'::regprocedure;
  complete_digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(complete_source, 'UTF8'), 'sha256'),
    'hex'
  );
  if complete_digest is distinct from '5d8daaa3fd6af175113b911b5197fbb2468fc54773ed4e81c4d9820d8a4da685' then
    raise exception 'complete_dues_stripe_disconnect source hash drifted: %', complete_digest
      using errcode = '55000';
  end if;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
