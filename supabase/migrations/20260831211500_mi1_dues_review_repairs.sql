-- CR-084 review repairs: exact tenant provisioning, provider-bound settlement,
-- crash-recoverable Connect, resumable disconnects, and audited quarantine.
-- This migration performs no provider request and creates no tenant or user.

begin;

set local lock_timeout = '5s';

-- Every Dues mutation below writes through the shared tenant audit helper.
-- Extend both audit allowlists before any new tenant can exercise those paths.
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

-- Live accounts never choose a financial hat in client UI. A single eligible
-- grant is provisioned inside the exact organization transaction; a dual grant
-- remains fail-closed until an explicit service/operator action supplies that
-- same organization, user, hat, and audit reason.
drop function if exists public.set_my_dues_financial_identity(text);
drop function if exists public.get_my_dues_financial_identity_choices();
drop function if exists public.set_dues_financial_identity_for_context(uuid, text, text);
drop function if exists public.provision_dues_financial_identity_for_active_context(uuid);
drop trigger if exists dues_financial_identity_membership_upsert on public.organization_memberships;
drop trigger if exists dues_financial_identity_membership_delete on public.organization_memberships;
drop trigger if exists dues_financial_identity_role_upsert on public.organization_role_grants;
drop trigger if exists dues_financial_identity_role_delete on public.organization_role_grants;
drop function if exists private.sync_dues_financial_identity_from_organization_change();
drop function if exists private.dues_sync_financial_identity_for_context(uuid, uuid);

create or replace function private.refresh_dues_financial_identity_for_context(
  p_organization_id uuid,
  p_user_id uuid,
  p_reset_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  hats text[] := array[]::text[];
begin
  if p_organization_id is null or p_user_id is null
     or p_reset_reason is null or p_reset_reason !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'invalid financial identity context' using errcode = '22023';
  end if;
  select coalesce(array_agg(grant_row.role order by grant_row.role), array[]::text[])
  into hats
  from (
    select distinct role_grant.role
    from public.organization_memberships membership
    join public.organization_role_grants role_grant
      on role_grant.organization_id = membership.organization_id
     and role_grant.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
      and role_grant.role in ('admin', 'vp')
  ) grant_row;
  if cardinality(hats) = 1 then
    insert into private.dues_financial_identity_selections (
      organization_id, user_id, selected_hat, selected_by, reset_reason
    ) values (
      p_organization_id, p_user_id, hats[1], null, p_reset_reason
    )
    on conflict (organization_id, user_id) do update
      set selected_hat = excluded.selected_hat,
          selected_at = now(),
          selected_by = null,
          reset_reason = excluded.reset_reason;
    return hats[1];
  end if;
  delete from private.dues_financial_identity_selections selection
  where selection.organization_id = p_organization_id
    and selection.user_id = p_user_id;
  return null;
end;
$function$;

create function public.reconcile_dues_checkout_reservation(
  p_reservation_id uuid,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_lease_kind text,
  p_session_status text,
  p_payment_status text,
  p_payment_intent text,
  p_provider_session_id text,
  p_connected_account_id text,
  p_amount_total integer,
  p_currency text,
  p_client_reference_id uuid,
  p_metadata_reservation_id uuid,
  p_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
  provider_binding_present boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_lease_kind not in ('ordinary', 'disconnect')
     or p_session_status not in (
       'open', 'complete', 'expired', 'canceled', 'retention_expired',
       'provider_error', 'unknown'
     )
     or p_payment_status not in (
       'paid', 'unpaid', 'no_payment_required', 'unknown',
       'provider_error', 'provider_unavailable', 'provider_not_found',
       'provider_rate_limited', 'provider_auth_refused', 'provider_refused',
       'invalid_checkout_request', 'provider_malformed'
     )
     or p_observed_at is null then
    raise exception 'invalid dues checkout observation' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id
  for update;
  if not found or reservation.state <> 'reconciling'
     or reservation.reconcile_lease_epoch <> p_lease_epoch
     or reservation.reconcile_lease_owner is distinct from p_lease_owner
     or reservation.reconcile_lease_kind is distinct from p_lease_kind
     or reservation.reconcile_lease_expires_at <= now() then
    raise exception 'dues checkout lease stale' using errcode = '42501';
  end if;
  provider_binding_present := p_provider_session_id is not null
    or p_connected_account_id is not null
    or p_amount_total is not null
    or p_currency is not null
    or p_client_reference_id is not null
    or p_metadata_reservation_id is not null;
  if provider_binding_present and (
    p_provider_session_id is distinct from reservation.stripe_session_id
    or p_connected_account_id is distinct from reservation.connected_account_id
    or p_amount_total is distinct from reservation.reserved_cents
    or p_currency is distinct from reservation.checkout_currency
    or p_client_reference_id is distinct from reservation.id
    or p_metadata_reservation_id is distinct from reservation.id
  ) then
    update public.dues_checkout_reservations
    set state = 'attention_required',
        definitive_failure_class = 'provider_binding_mismatch',
        reconcile_lease_owner = null,
        reconcile_lease_expires_at = null,
        reconcile_lease_kind = null,
        updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', 'attention_required'
    );
  end if;
  if p_payment_status = 'paid' and p_session_status <> 'complete' then
    update public.dues_checkout_reservations
    set state = 'attention_required',
        definitive_failure_class = 'provider_paid_state_conflict',
        reconcile_lease_owner = null,
        reconcile_lease_expires_at = null,
        reconcile_lease_kind = null,
        updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', 'attention_required'
    );
  end if;
  if p_session_status = 'complete' and p_payment_status = 'paid' then
    return private.dues_settle_stripe_checkout(
      reservation.id, p_provider_session_id, p_payment_intent,
      p_payment_status, p_amount_total, p_currency,
      p_connected_account_id, p_client_reference_id,
      p_metadata_reservation_id
    );
  end if;
  if p_session_status in ('expired', 'canceled')
     and p_payment_status in ('unpaid', 'no_payment_required') then
    update public.dues_checkout_reservations
    set state = 'released',
        definitive_failure_class = case
          when p_lease_kind = 'disconnect' then 'provider_disconnected'
          else 'checkout_' || p_session_status
        end,
        reconcile_lease_owner = null,
        reconcile_lease_expires_at = null,
        reconcile_lease_kind = null,
        updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', 'released'
    );
  end if;
  if p_session_status = 'retention_expired' then
    update public.dues_checkout_reservations
    set state = 'attention_required',
        definitive_failure_class = 'stripe_replay_retention_elapsed',
        reconcile_lease_owner = null,
        reconcile_lease_expires_at = null,
        reconcile_lease_kind = null,
        updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', 'attention_required'
    );
  end if;
  if reservation.expires_at <= now() then
    update public.dues_checkout_reservations
    set state = case
          when reservation.stripe_session_id is null then 'attention_required'
          else 'released'
        end,
        definitive_failure_class = case
          when reservation.stripe_session_id is null then 'checkout_unconfirmed_at_retention'
          else 'checkout_expired'
        end,
        reconcile_lease_owner = null,
        reconcile_lease_expires_at = null,
        reconcile_lease_kind = null,
        updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', case
        when reservation.stripe_session_id is null then 'attention_required'
        else 'released'
      end
    );
  end if;
  if p_session_status = 'open' and p_lease_kind = 'ordinary' then
    update public.dues_checkout_reservations
    set state = 'open',
        reconcile_lease_owner = null,
        reconcile_lease_expires_at = null,
        reconcile_lease_kind = null,
        reconcile_after = reservation.expires_at,
        updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', 'open'
    );
  end if;
  update public.dues_checkout_reservations
  set state = 'reconciling',
      reconcile_lease_owner = null,
      reconcile_lease_expires_at = null,
      reconcile_lease_kind = null,
      reconcile_after = now() + interval '5 minutes',
      updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object(
    'reservationId', reservation.id,
    'state', 'reconciling'
  );
end;
$function$;

create or replace function public.get_my_dues_workspace(
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  member_subject uuid;
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if org is null or (select auth.uid()) is null then
    raise exception 'dues authorization required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'dues MFA required' using errcode = '42501';
  end if;
  select subject.id into member_subject
  from public.dues_member_subjects subject
  where subject.organization_id = org
    and subject.user_id = (select auth.uid());
  if member_subject is null then
    raise exception 'dues subject provisioning incomplete' using errcode = '55000';
  end if;
  return (
    with calculated as (
      select obligation.*, batch.title as assessment_title,
        coalesce((
          select sum(case event.event_kind
            when 'payment' then event.amount_cents
            when 'waiver' then event.amount_cents
            when 'credit_adjustment' then event.amount_cents
            when 'debit_adjustment' then -event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as settled_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'payment')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as paid_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'waiver')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as waived_cents,
        coalesce((
          select sum(case event.event_kind
            when 'credit_adjustment' then -event.amount_cents
            when 'debit_adjustment' then event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as adjustment_cents
      from public.dues_obligations obligation
      join public.dues_assessment_batches batch
        on batch.organization_id = obligation.organization_id
       and batch.id = obligation.batch_id
      where obligation.organization_id = org
        and obligation.member_subject_id = member_subject
    ), page as (
      select * from calculated
      where p_after_id is null or id > p_after_id
      order by id
      limit limit_value + 1
    ), visible as (
      select * from page order by id limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready',
      'staff', false,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0)) from calculated
        ), 0),
        'overdueCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0))
          from calculated where due_on < current_date
        ), 0),
        'collectedCents', coalesce((select sum(paid_cents) from calculated), 0),
        'memberCount', 1,
        'authoritative', pg_catalog.jsonb_build_object(
          'outstandingCents', coalesce((
            select sum(greatest(issued_cents - settled_cents, 0)) from calculated
          ), 0),
          'overdueCents', coalesce((
            select sum(greatest(issued_cents - settled_cents, 0))
            from calculated where due_on < current_date
          ), 0),
          'nextDueOn', (
            select min(due_on) from calculated
            where issued_cents - settled_cents > 0
          )
        )
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', id,
            'assessmentTitle', assessment_title,
            'issuedCents', issued_cents,
            'settledCents', settled_cents,
            'balanceCents', greatest(issued_cents - settled_cents, 0),
            'dueOn', due_on,
            'standing', case
              when issued_cents - settled_cents <= 0
                and waived_cents > 0 and paid_cents = 0 then 'waived'
              when issued_cents - settled_cents <= 0 then 'paid'
              when paid_cents > 0 or waived_cents > 0
                or adjustment_cents < 0 then 'partial'
              when due_on < current_date then 'overdue'
              else 'open'
            end,
            'events', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id', event.id,
                'kind', event.event_kind,
                'amountCents', event.amount_cents,
                'effectiveOn', event.effective_on,
                'receiptNumber', event.receipt_number,
                'paymentMethod', event.payment_method
              ) order by event.effective_on desc, event.id desc)
              from public.dues_ledger_events event
              where event.organization_id = org
                and event.obligation_id = visible.id
            ), '[]'::jsonb)
          ) order by id) from visible
        ), '[]'::jsonb),
        'nextCursor', case
          when (select count(*) from page) > limit_value
          then (select id from visible order by id desc limit 1)
          else null
        end
      ),
      'chapters', '[]'::jsonb,
      'provider', private.dues_provider_projection(org)
    )
  );
end;
$function$;

create or replace function public.get_dues_workspace(
  p_query text default null,
  p_status text default null,
  p_due_on date default null,
  p_after_id uuid default null,
  p_limit integer default 25,
  p_selected_hat text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.dues_require_financial_hat(p_selected_hat);
  query_value text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  limit_value integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if query_value is not null and pg_catalog.char_length(query_value) > 120 then
    raise exception 'dues search too long' using errcode = '22023';
  end if;
  if p_status is not null
     and p_status not in ('open', 'partial', 'overdue', 'paid', 'waived') then
    raise exception 'invalid dues status' using errcode = '22023';
  end if;
  return (
    with calculated as (
      select obligation.*, batch.title as assessment_title, subject.user_id,
        coalesce(profile.full_name, 'Member') as member_label,
        coalesce((
          select sum(case event.event_kind
            when 'payment' then event.amount_cents
            when 'waiver' then event.amount_cents
            when 'credit_adjustment' then event.amount_cents
            when 'debit_adjustment' then -event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as settled_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'payment')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as paid_cents,
        coalesce((
          select sum(event.amount_cents) filter (where event.event_kind = 'waiver')
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as waived_cents,
        coalesce((
          select sum(case event.event_kind
            when 'credit_adjustment' then -event.amount_cents
            when 'debit_adjustment' then event.amount_cents
            else 0 end)
          from public.dues_ledger_events event
          where event.organization_id = obligation.organization_id
            and event.obligation_id = obligation.id
        ), 0) as adjustment_cents
      from public.dues_obligations obligation
      join public.dues_assessment_batches batch
        on batch.organization_id = obligation.organization_id
       and batch.id = obligation.batch_id
      join public.dues_member_subjects subject
        on subject.organization_id = obligation.organization_id
       and subject.id = obligation.member_subject_id
      left join public.member_profiles profile on profile.id = subject.user_id
      where obligation.organization_id = org
    ), classified as (
      select *, case
        when issued_cents - settled_cents <= 0
          and waived_cents > 0 and paid_cents = 0 then 'waived'
        when issued_cents - settled_cents <= 0 then 'paid'
        when paid_cents > 0 or waived_cents > 0
          or adjustment_cents < 0 then 'partial'
        when due_on < current_date then 'overdue'
        else 'open'
      end as standing
      from calculated
    ), filtered as (
      select * from classified
      where (p_due_on is null or due_on = p_due_on)
        and (p_status is null or standing = p_status)
        and (query_value is null
          or member_label ilike '%' || query_value || '%' escape '\'
          or assessment_title ilike '%' || query_value || '%' escape '\')
    ), page as (
      select * from filtered
      where p_after_id is null or id > p_after_id
      order by id
      limit limit_value + 1
    ), visible as (
      select * from page order by id limit limit_value
    )
    select pg_catalog.jsonb_build_object(
      'state', 'ready',
      'staff', true,
      'summary', pg_catalog.jsonb_build_object(
        'outstandingCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0)) from filtered
        ), 0),
        'overdueCents', coalesce((
          select sum(greatest(issued_cents - settled_cents, 0))
          from filtered where due_on < current_date
        ), 0),
        'collectedCents', coalesce((select sum(paid_cents) from filtered), 0),
        'memberCount', (select count(distinct member_subject_id) from filtered)
      ),
      'obligations', pg_catalog.jsonb_build_object(
        'items', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', id,
            'memberSubjectId', member_subject_id,
            'memberLabel', member_label,
            'assessmentTitle', assessment_title,
            'issuedCents', issued_cents,
            'settledCents', settled_cents,
            'balanceCents', greatest(issued_cents - settled_cents, 0),
            'dueOn', due_on,
            'standing', standing,
            'chapterId', chapter_id
          ) order by id) from visible
        ), '[]'::jsonb),
        'nextCursor', case
          when (select count(*) from page) > limit_value
          then (select id from visible order by id desc limit 1)
          else null
        end
      ),
      'chapters', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', chapter.id, 'name', chapter.name
        ) order by chapter.name)
        from public.chapters chapter
        where chapter.organization_id = org
      ), '[]'::jsonb),
      'provider', private.dues_provider_projection(org)
    )
  );
end;
$function$;


create or replace function private.dues_claim_checkout_reconciliations(
  p_limit integer,
  p_worker_id uuid,
  p_disconnect boolean
)
returns table (
  reservation_id uuid,
  account_id text,
  idempotency_key text,
  amount_cents integer,
  currency text,
  description text,
  success_url text,
  cancel_url text,
  request_hash text,
  stripe_session_id text,
  state text,
  replay_until timestamptz,
  lease_epoch integer,
  lease_owner uuid,
  lease_kind text
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_limit is null or p_limit not between 1 and 25 or p_worker_id is null then
    raise exception 'invalid dues reconciliation claim' using errcode = '22023';
  end if;
  update public.dues_checkout_reservations reservation
  set state = 'attention_required',
      definitive_failure_class = 'reconcile_attempts_exhausted',
      reconcile_lease_owner = null,
      reconcile_lease_expires_at = null,
      reconcile_lease_kind = null,
      updated_at = now()
  from public.dues_provider_connections connection
  where connection.organization_id = reservation.organization_id
    and ((p_disconnect and connection.state = 'disconnecting')
      or (not p_disconnect and connection.state = 'ready'))
    and reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling')
    and reservation.reconcile_attempt_count >= 25
    and (reservation.reconcile_lease_expires_at is null
      or reservation.reconcile_lease_expires_at <= now());
  return query
  with candidates as (
    select reservation.id, reservation.state as prior_state
    from public.dues_checkout_reservations reservation
    join public.dues_provider_connections connection
      on connection.organization_id = reservation.organization_id
     and ((p_disconnect and connection.state = 'disconnecting')
       or (not p_disconnect and connection.state = 'ready'))
    where reservation.state in ('creating', 'open', 'cancel_requested', 'reconciling')
      and reservation.reconcile_attempt_count < 25
      and reservation.reconcile_after <= now()
      and (reservation.reconcile_lease_expires_at is null
        or reservation.reconcile_lease_expires_at <= now())
      and (
        (reservation.state = 'creating'
          and reservation.created_at <= now() - interval '30 seconds')
        or reservation.state = 'cancel_requested'
        or (reservation.state = 'open'
          and (p_disconnect or reservation.expires_at <= now()))
        or reservation.state = 'reconciling'
      )
    order by reservation.reconcile_after, reservation.created_at, reservation.id
    for update of reservation skip locked
    limit p_limit
  ), leased as (
    update public.dues_checkout_reservations reservation
    set state = 'reconciling',
        reconcile_lease_epoch = reservation.reconcile_lease_epoch + 1,
        reconcile_lease_owner = p_worker_id,
        reconcile_lease_expires_at = now() + interval '2 minutes',
        reconcile_lease_kind = case
          when p_disconnect then 'disconnect'
          else 'ordinary'
        end,
        reconcile_attempt_count = reservation.reconcile_attempt_count + 1,
        updated_at = now()
    from candidates
    where reservation.id = candidates.id
    returning reservation.*, candidates.prior_state
  )
  select leased.id, leased.connected_account_id,
    leased.provider_idempotency_key, leased.reserved_cents,
    leased.checkout_currency, leased.receipt_description,
    leased.success_url, leased.cancel_url, leased.request_hash,
    leased.stripe_session_id, leased.prior_state as state,
    leased.stripe_idempotency_replay_until,
    leased.reconcile_lease_epoch, leased.reconcile_lease_owner,
    leased.reconcile_lease_kind
  from leased;
end;
$function$;

create table private.dues_checkout_recovery_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  reservation_id uuid not null references public.dues_checkout_reservations(id) on delete restrict,
  resolution text not null check (
    resolution in ('settle-paid', 'release-terminal-unpaid', 'provider-search-no-session')
  ),
  evidence_reference text not null,
  resolved_at timestamptz not null default now()
);

revoke all on table private.dues_checkout_recovery_audit
  from public, anon, authenticated, service_role;

create function public.resolve_dues_checkout_attention(
  p_organization_id uuid,
  p_reservation_id uuid,
  p_resolution text,
  p_evidence_reference text,
  p_provider_session_id text,
  p_hosted_checkout_url text,
  p_session_expires_at timestamptz,
  p_payment_intent text,
  p_payment_status text,
  p_amount_total integer,
  p_currency text,
  p_connected_account_id text,
  p_client_reference_id uuid,
  p_metadata_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
  result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_resolution not in (
       'settle-paid', 'release-terminal-unpaid', 'provider-search-no-session'
     )
     or p_evidence_reference !~ '^[A-Za-z0-9:_./-]{8,240}$' then
    raise exception 'invalid dues recovery evidence' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.organization_id = p_organization_id
    and row.id = p_reservation_id
    and row.state = 'attention_required'
  for update;
  if not found then
    raise exception 'dues checkout recovery unavailable' using errcode = '42501';
  end if;
  if p_resolution = 'provider-search-no-session' then
    if reservation.stripe_session_id is not null
       or p_provider_session_id is not null
       or p_payment_status <> 'not_found' then
      raise exception 'invalid no-session recovery evidence' using errcode = '22023';
    end if;
    update public.dues_checkout_reservations
    set state = 'released',
        definitive_failure_class = 'provider_search_no_session',
        updated_at = now()
    where id = reservation.id;
    result := pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', 'released'
    );
  else
    if p_provider_session_id !~ '^[A-Za-z0-9_:-]{3,255}$'
       or p_connected_account_id is distinct from reservation.connected_account_id
       or p_amount_total is distinct from reservation.reserved_cents
       or p_currency is distinct from reservation.checkout_currency
       or p_client_reference_id is distinct from reservation.id
       or p_metadata_reservation_id is distinct from reservation.id
       or (reservation.stripe_session_id is not null
         and reservation.stripe_session_id <> p_provider_session_id) then
      raise exception 'dues recovery provider binding mismatch' using errcode = '22023';
    end if;
    if reservation.stripe_session_id is null then
      if p_hosted_checkout_url !~ '^https://[^[:space:]#]+$'
         or p_session_expires_at is null then
        raise exception 'dues recovery session evidence incomplete' using errcode = '22023';
      end if;
      update public.dues_checkout_reservations
      set stripe_session_id = p_provider_session_id,
          hosted_checkout_url = p_hosted_checkout_url,
          expires_at = least(expires_at, p_session_expires_at),
          updated_at = now()
      where id = reservation.id;
    end if;
    if p_resolution = 'settle-paid' then
      result := private.dues_settle_stripe_checkout(
        reservation.id, p_provider_session_id, p_payment_intent,
        p_payment_status, p_amount_total, p_currency,
        p_connected_account_id, p_client_reference_id,
        p_metadata_reservation_id
      );
    elsif p_payment_status in ('unpaid', 'no_payment_required') then
      update public.dues_checkout_reservations
      set state = 'released',
          definitive_failure_class = 'operator_verified_terminal_unpaid',
          updated_at = now()
      where id = reservation.id;
      result := pg_catalog.jsonb_build_object(
        'reservationId', reservation.id,
        'state', 'released'
      );
    else
      raise exception 'invalid terminal-unpaid recovery evidence' using errcode = '22023';
    end if;
  end if;
  insert into private.dues_checkout_recovery_audit (
    organization_id, reservation_id, resolution, evidence_reference
  ) values (
    p_organization_id, p_reservation_id, p_resolution, p_evidence_reference
  );
  perform private.mi1_write_tenant_audit(
    p_organization_id,
    'dues_checkout_attention_resolved',
    pg_catalog.jsonb_build_object(
      'reservationId', p_reservation_id,
      'resolution', p_resolution,
      'evidenceReference', p_evidence_reference
    )
  );
  return result;
end;
$function$;


create or replace function private.refresh_dues_financial_identity_from_role_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.refresh_dues_financial_identity_for_context(
    coalesce(new.organization_id, old.organization_id),
    coalesce(new.user_id, old.user_id),
    'organization-grant-refresh'
  );
  return coalesce(new, old);
end;
$function$;

drop trigger if exists refresh_dues_financial_identity_on_role_grant on public.organization_role_grants;
create trigger refresh_dues_financial_identity_on_role_grant
  after insert or update or delete on public.organization_role_grants
  for each row execute function private.refresh_dues_financial_identity_from_role_grant();

create or replace function private.refresh_dues_financial_identity_from_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.refresh_dues_financial_identity_for_context(
    coalesce(new.organization_id, old.organization_id),
    coalesce(new.user_id, old.user_id),
    'organization-membership-refresh'
  );
  return coalesce(new, old);
end;
$function$;

drop trigger if exists refresh_dues_financial_identity_on_membership on public.organization_memberships;
create trigger refresh_dues_financial_identity_on_membership
  after insert or update of status or delete on public.organization_memberships
  for each row execute function private.refresh_dues_financial_identity_from_membership();

select private.refresh_dues_financial_identity_for_context(
  membership.organization_id,
  membership.user_id,
  'migration-exact-context'
)
from public.organization_memberships membership
where membership.status = 'active';

create or replace function public.set_dues_financial_identity_for_context(
  p_organization_id uuid,
  p_user_id uuid,
  p_selected_hat text,
  p_reset_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_organization_id is null or p_user_id is null
     or p_selected_hat not in ('admin', 'vp')
     or p_reset_reason is null or p_reset_reason !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'invalid financial identity context' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    join public.organization_role_grants role_grant
      on role_grant.organization_id = membership.organization_id
     and role_grant.user_id = membership.user_id
     and role_grant.role = p_selected_hat
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
  ) then
    raise exception 'financial identity grant unavailable' using errcode = '42501';
  end if;
  insert into private.dues_financial_identity_selections (
    organization_id, user_id, selected_hat, selected_by, reset_reason
  ) values (
    p_organization_id, p_user_id, p_selected_hat, null, p_reset_reason
  )
  on conflict (organization_id, user_id) do update
    set selected_hat = excluded.selected_hat,
        selected_at = now(),
        selected_by = null,
        reset_reason = excluded.reset_reason;
  perform private.mi1_write_tenant_audit(
    p_organization_id,
    'dues_financial_identity_provisioned',
    pg_catalog.jsonb_build_object(
      'userId', p_user_id,
      'selectedHat', p_selected_hat,
      'reason', p_reset_reason
    )
  );
  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'userId', p_user_id,
    'selectedHat', p_selected_hat
  );
end;
$function$;

create function public.provision_dues_financial_identity_for_active_context(
  p_organization_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare selected_hat text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  selected_hat := private.refresh_dues_financial_identity_for_context(
    p_organization_id, p_user_id, 'service-exact-context'
  );
  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'userId', p_user_id,
    'selectedHat', selected_hat,
    'provisioned', selected_hat is not null
  );
end;
$function$;

-- A Connect callback moves pending -> processing -> exchanged -> completed.
-- An expired processing lease with no durable exchange is quarantined because
-- the one-time code may already have been consumed by Stripe.
alter table private.dues_stripe_oauth_states
  add column if not exists callback_state text not null default 'pending',
  add column if not exists callback_lease_owner uuid,
  add column if not exists callback_lease_epoch integer not null default 0,
  add column if not exists callback_lease_expires_at timestamptz,
  add column if not exists exchanged_account_id text,
  add column if not exists exchanged_scope text,
  add column if not exists exchanged_livemode boolean,
  add column if not exists last_error_class text,
  add column if not exists reconcile_after timestamptz not null default now(),
  add column if not exists completed_at timestamptz;

update private.dues_stripe_oauth_states
set callback_state = case when consumed_at is null then 'pending' else 'completed' end,
    completed_at = case when consumed_at is null then null else consumed_at end;

alter table private.dues_stripe_oauth_states
  drop constraint if exists dues_stripe_oauth_callback_state_check;
alter table private.dues_stripe_oauth_states
  add constraint dues_stripe_oauth_callback_state_check check (
    callback_state in ('pending', 'processing', 'exchanged', 'completed', 'attention_required', 'refused')
  );

create index if not exists dues_stripe_oauth_reconcile_idx
  on private.dues_stripe_oauth_states (callback_state, reconcile_after, created_at)
  where callback_state in ('processing', 'exchanged');

create or replace function public.save_dues_stripe_oauth_state(
  p_state_hash text,
  p_organization_id uuid,
  p_requested_by uuid,
  p_selected_hat text,
  p_browser_binding_hash text,
  p_redirect_uri text,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_state_hash !~ '^[a-f0-9]{64}$'
     or p_browser_binding_hash !~ '^[a-f0-9]{64}$'
     or p_selected_hat not in ('admin', 'vp')
     or p_redirect_uri !~ '^https://(unionground[.]net|demo[.]example[.]com)/api/dues-stripe-connect$'
     or p_expires_at <= now() or p_expires_at > now() + interval '10 minutes' then
    raise exception 'invalid dues Stripe state' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    join public.organization_role_grants role_grant
      on role_grant.organization_id = membership.organization_id
     and role_grant.user_id = membership.user_id
     and role_grant.role = p_selected_hat
    where membership.organization_id = p_organization_id
      and membership.user_id = p_requested_by
      and membership.status = 'active'
  ) then
    raise exception 'dues Stripe state context unavailable' using errcode = '42501';
  end if;
  insert into private.dues_stripe_oauth_states (
    state_hash, organization_id, requested_by, selected_hat,
    browser_binding_hash, redirect_uri, expires_at, callback_state,
    reconcile_after
  ) values (
    p_state_hash, p_organization_id, p_requested_by, p_selected_hat,
    p_browser_binding_hash, p_redirect_uri, p_expires_at, 'pending', now()
  );
end;
$function$;

create function public.claim_dues_stripe_oauth_callback(
  p_state_hash text,
  p_browser_binding_hash text,
  p_worker_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_state_hash !~ '^[a-f0-9]{64}$'
     or p_browser_binding_hash !~ '^[a-f0-9]{64}$'
     or p_worker_id is null then
    raise exception 'invalid dues Stripe callback claim' using errcode = '22023';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
    and row.browser_binding_hash = p_browser_binding_hash
  for update;
  if not found or saved.callback_state in ('attention_required', 'refused') then
    raise exception 'dues Stripe state unavailable' using errcode = '42501';
  end if;
  if saved.callback_state = 'completed' then
    return pg_catalog.jsonb_build_object('callbackState', 'completed');
  end if;
  if saved.expires_at <= now() and saved.exchanged_account_id is null then
    update private.dues_stripe_oauth_states
    set callback_state = 'attention_required',
        last_error_class = 'callback_expired_unconfirmed',
        callback_lease_owner = null,
        callback_lease_expires_at = null,
        consumed_at = now()
    where state_hash = saved.state_hash;
    raise exception 'dues Stripe state unavailable' using errcode = '42501';
  end if;
  if saved.callback_state = 'processing'
     and saved.callback_lease_expires_at is not null
     and saved.callback_lease_expires_at > now() then
    raise exception 'dues Stripe callback already processing' using errcode = '55000';
  end if;
  if saved.callback_state = 'processing' and saved.exchanged_account_id is null then
    update private.dues_stripe_oauth_states
    set callback_state = 'attention_required',
        last_error_class = 'oauth_exchange_ambiguous',
        callback_lease_owner = null,
        callback_lease_expires_at = null,
        consumed_at = now()
    where state_hash = saved.state_hash;
    raise exception 'dues Stripe state unavailable' using errcode = '42501';
  end if;
  update private.dues_stripe_oauth_states
  set callback_state = case when exchanged_account_id is null then 'processing' else 'exchanged' end,
      callback_lease_epoch = callback_lease_epoch + 1,
      callback_lease_owner = p_worker_id,
      callback_lease_expires_at = now() + interval '2 minutes',
      last_error_class = null
  where state_hash = saved.state_hash
  returning * into saved;
  return pg_catalog.jsonb_build_object(
    'stateHash', saved.state_hash,
    'organizationId', saved.organization_id,
    'requestedBy', saved.requested_by,
    'selectedHat', saved.selected_hat,
    'redirectUri', saved.redirect_uri,
    'callbackState', saved.callback_state,
    'exchangedAccountId', saved.exchanged_account_id,
    'leaseEpoch', saved.callback_lease_epoch,
    'leaseOwner', saved.callback_lease_owner
  );
end;
$function$;

create function public.record_dues_stripe_oauth_exchange(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_account_id text,
  p_scope text,
  p_livemode boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'dues Stripe exchange record refused' using errcode = '42501';
  end if;
  update private.dues_stripe_oauth_states
  set callback_state = 'exchanged',
      exchanged_account_id = p_account_id,
      exchanged_scope = nullif(pg_catalog.left(coalesce(p_scope, ''), 120), ''),
      exchanged_livemode = coalesce(p_livemode, false),
      last_error_class = null,
      reconcile_after = now()
  where state_hash = p_state_hash
    and callback_state = 'processing'
    and callback_lease_epoch = p_lease_epoch
    and callback_lease_owner is not distinct from p_lease_owner
    and callback_lease_expires_at > now()
    and (exchanged_account_id is null or exchanged_account_id = p_account_id);
  if not found then
    raise exception 'dues Stripe callback lease stale' using errcode = '42501';
  end if;
end;
$function$;

create function public.defer_dues_stripe_oauth_callback(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_failure_class text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_failure_class !~ '^[a-z0-9_-]{1,80}$' then
    raise exception 'dues Stripe callback defer refused' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
  for update;
  if not found or saved.callback_lease_epoch <> p_lease_epoch
     or saved.callback_lease_owner is distinct from p_lease_owner
     or saved.callback_lease_expires_at <= now() then
    raise exception 'dues Stripe callback lease stale' using errcode = '42501';
  end if;
  update private.dues_stripe_oauth_states
  set callback_state = case when exchanged_account_id is null then 'attention_required' else 'exchanged' end,
      last_error_class = p_failure_class,
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      reconcile_after = now() + interval '5 minutes',
      consumed_at = case when exchanged_account_id is null then now() else consumed_at end
  where state_hash = saved.state_hash;
  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_oauth_deferred',
    pg_catalog.jsonb_build_object('failureClass', p_failure_class)
  );
end;
$function$;

create function public.fail_dues_stripe_oauth_callback(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_failure_class text,
  p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_failure_class !~ '^[a-z0-9_-]{1,80}$'
     or p_outcome not in ('refused', 'attention_required') then
    raise exception 'dues Stripe callback failure refused' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
  for update;
  if not found or saved.callback_lease_epoch <> p_lease_epoch
     or saved.callback_lease_owner is distinct from p_lease_owner
     or saved.callback_lease_expires_at <= now() then
    raise exception 'dues Stripe callback lease stale' using errcode = '42501';
  end if;
  update private.dues_stripe_oauth_states
  set callback_state = p_outcome,
      last_error_class = p_failure_class,
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      consumed_at = now()
  where state_hash = saved.state_hash;
  perform private.mi1_write_tenant_audit(
    saved.organization_id,
    'dues_stripe_oauth_failed',
    pg_catalog.jsonb_build_object('failureClass', p_failure_class, 'outcome', p_outcome)
  );
end;
$function$;

create function public.complete_dues_stripe_oauth_callback(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_organization_id uuid,
  p_requested_by uuid,
  p_account_id text,
  p_account_label text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare saved private.dues_stripe_oauth_states%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$' then
    raise exception 'dues Stripe callback completion refused' using errcode = '42501';
  end if;
  select * into saved
  from private.dues_stripe_oauth_states row
  where row.state_hash = p_state_hash
  for update;
  if not found or saved.callback_state not in ('processing', 'exchanged')
     or saved.callback_lease_epoch <> p_lease_epoch
     or saved.callback_lease_owner is distinct from p_lease_owner
     or saved.callback_lease_expires_at <= now()
     or saved.organization_id <> p_organization_id
     or saved.requested_by <> p_requested_by
     or saved.exchanged_account_id is distinct from p_account_id then
    raise exception 'dues Stripe callback lease stale' using errcode = '42501';
  end if;
  insert into public.dues_provider_connections (
    organization_id, state, stripe_account_id, account_label,
    charges_enabled, payouts_enabled, connected_at, updated_at
  ) values (
    p_organization_id, 'ready', p_account_id,
    nullif(pg_catalog.left(coalesce(p_account_label, ''), 120), ''),
    coalesce(p_charges_enabled, false), coalesce(p_payouts_enabled, false),
    now(), now()
  )
  on conflict (organization_id) do update
    set state = 'ready',
        stripe_account_id = excluded.stripe_account_id,
        account_label = excluded.account_label,
        charges_enabled = excluded.charges_enabled,
        payouts_enabled = excluded.payouts_enabled,
        connected_at = now(),
        disconnected_at = null,
        updated_at = now(),
        last_error_class = null;
  update private.dues_stripe_oauth_states
  set callback_state = 'completed',
      completed_at = now(),
      consumed_at = now(),
      callback_lease_owner = null,
      callback_lease_expires_at = null,
      last_error_class = null
  where state_hash = saved.state_hash;
  perform private.mi1_write_tenant_audit(
    p_organization_id,
    'dues_stripe_connected',
    pg_catalog.jsonb_build_object('requestedBy', p_requested_by)
  );
  return pg_catalog.jsonb_build_object('state', 'ready');
end;
$function$;

create function public.claim_dues_stripe_oauth_reconciliations(
  p_limit integer,
  p_worker_id uuid
)
returns table (
  state_hash text,
  organization_id uuid,
  requested_by uuid,
  exchanged_account_id text,
  lease_epoch integer,
  lease_owner uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 25 or p_worker_id is null then
    raise exception 'invalid dues OAuth reconciliation claim' using errcode = '22023';
  end if;
  return query
  with candidates as (
    select row.state_hash
    from private.dues_stripe_oauth_states row
    where row.callback_state = 'exchanged'
      and row.exchanged_account_id is not null
      and row.reconcile_after <= now()
      and (row.callback_lease_expires_at is null or row.callback_lease_expires_at <= now())
    order by row.reconcile_after, row.created_at, row.state_hash
    for update skip locked
    limit p_limit
  ), leased as (
    update private.dues_stripe_oauth_states row
    set callback_lease_epoch = row.callback_lease_epoch + 1,
        callback_lease_owner = p_worker_id,
        callback_lease_expires_at = now() + interval '2 minutes'
    from candidates
    where row.state_hash = candidates.state_hash
    returning row.*
  )
  select leased.state_hash, leased.organization_id, leased.requested_by,
    leased.exchanged_account_id, leased.callback_lease_epoch,
    leased.callback_lease_owner
  from leased;
end;
$function$;

-- Every successful settlement is bound under the reservation lock to the
-- connected account, exact Checkout Session, both reservation references,
-- amount, currency, and a paid provider observation.
alter table public.dues_stripe_events
  add column if not exists stripe_session_id text,
  add column if not exists connected_account_id text,
  add column if not exists payment_status text,
  add column if not exists amount_total integer,
  add column if not exists currency text,
  add column if not exists client_reference_id uuid,
  add column if not exists metadata_reservation_id uuid,
  add column if not exists payment_intent text,
  add column if not exists event_type text;

drop function if exists private.dues_settle_stripe_checkout(uuid, text, text);
drop function if exists private.dues_settle_stripe_checkout(uuid, text, text, text, integer, text, text, text);
drop function if exists public.settle_dues_stripe_event(text, uuid, text, text, text);
drop function if exists public.settle_dues_stripe_event(text, uuid, text, text, text, text, integer, text, text, text);
drop function if exists public.reconcile_dues_checkout_reservation(uuid, integer, uuid, text, text, text, text, timestamp with time zone);
drop function if exists public.reconcile_dues_checkout_reservation(uuid, integer, uuid, text, text, text, text, text, integer, text, text, text, timestamp with time zone);
drop function if exists public.resolve_dues_checkout_attention(uuid, text, text);

create function private.dues_settle_stripe_checkout(
  p_reservation_id uuid,
  p_stripe_session_id text,
  p_payment_intent text,
  p_payment_status text,
  p_amount_total integer,
  p_currency text,
  p_connected_account_id text,
  p_client_reference_id uuid,
  p_metadata_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  reservation public.dues_checkout_reservations%rowtype;
  obligation public.dues_obligations%rowtype;
  existing public.dues_ledger_events%rowtype;
  receipt text;
  balance integer;
  reference text := 'stripe-session:' || p_stripe_session_id;
begin
  if p_stripe_session_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_connected_account_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or (p_payment_intent is not null and p_payment_intent !~ '^[A-Za-z0-9_:-]{3,255}$')
     or p_payment_status <> 'paid'
     or p_amount_total is null or p_amount_total <= 0
     or p_currency <> 'usd'
     or p_client_reference_id is distinct from p_reservation_id
     or p_metadata_reservation_id is distinct from p_reservation_id then
    raise exception 'invalid Stripe settlement' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id
  for update;
  if not found
     or reservation.stripe_session_id is distinct from p_stripe_session_id
     or reservation.connected_account_id is distinct from p_connected_account_id
     or reservation.reserved_cents is distinct from p_amount_total
     or reservation.checkout_currency is distinct from p_currency then
    raise exception 'dues checkout settlement unavailable' using errcode = '42501';
  end if;
  select * into existing
  from public.dues_ledger_events event
  where event.organization_id = reservation.organization_id
    and event.external_reference = reference
  for update;
  if found then
    if existing.obligation_id <> reservation.obligation_id
       or existing.event_kind <> 'payment'
       or existing.payment_method <> 'stripe'
       or existing.amount_cents <> reservation.reserved_cents then
      raise exception 'dues Stripe settlement conflict' using errcode = '22023';
    end if;
    update public.dues_checkout_reservations
    set state = 'settled', reconcile_lease_owner = null,
        reconcile_lease_expires_at = null, reconcile_lease_kind = null,
        definitive_failure_class = null, updated_at = now()
    where id = reservation.id;
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'receiptNumber', existing.receipt_number,
      'idempotent', true
    );
  end if;
  select * into obligation
  from public.dues_obligations row
  where row.organization_id = reservation.organization_id
    and row.id = reservation.obligation_id
  for update;
  if not found then
    raise exception 'dues obligation unavailable' using errcode = '42501';
  end if;
  balance := private.dues_balance_cents(
    reservation.organization_id, reservation.obligation_id
  );
  if balance <> reservation.reserved_cents then
    raise exception 'dues checkout balance changed' using errcode = '55000';
  end if;
  receipt := private.dues_receipt_number(reservation.organization_id, current_date);
  insert into public.dues_ledger_events (
    organization_id, obligation_id, event_kind, amount_cents, effective_on,
    reason, payment_method, external_reference, receipt_number,
    idempotency_key, created_by
  ) values (
    reservation.organization_id, reservation.obligation_id, 'payment',
    reservation.reserved_cents, current_date, 'Stripe Checkout settlement',
    'stripe', reference, receipt,
    'dues-stripe-session:' || p_stripe_session_id, null
  ) returning * into existing;
  update public.dues_checkout_reservations
  set state = 'settled', reconcile_lease_owner = null,
      reconcile_lease_expires_at = null, reconcile_lease_kind = null,
      definitive_failure_class = null, updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object(
    'reservationId', reservation.id,
    'receiptNumber', receipt,
    'idempotent', false
  );
end;
$function$;

create function public.settle_dues_stripe_event(
  p_stripe_event_id text,
  p_reservation_id uuid,
  p_stripe_session_id text,
  p_connected_account_id text,
  p_payment_status text,
  p_amount_total integer,
  p_currency text,
  p_client_reference_id uuid,
  p_metadata_reservation_id uuid,
  p_payment_intent text,
  p_event_type text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  recorded public.dues_stripe_events%rowtype;
  result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_stripe_event_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_event_type not in (
       'checkout.session.completed',
       'checkout.session.async_payment_succeeded'
     ) then
    raise exception 'invalid Stripe event' using errcode = '22023';
  end if;
  select * into recorded
  from public.dues_stripe_events event
  where event.stripe_event_id = p_stripe_event_id
  for update;
  if found then
    if recorded.reservation_id <> p_reservation_id
       or recorded.stripe_session_id is distinct from p_stripe_session_id
       or recorded.connected_account_id is distinct from p_connected_account_id
       or recorded.payment_status is distinct from p_payment_status
       or recorded.amount_total is distinct from p_amount_total
       or recorded.currency is distinct from p_currency
       or recorded.client_reference_id is distinct from p_client_reference_id
       or recorded.metadata_reservation_id is distinct from p_metadata_reservation_id
       or recorded.payment_intent is distinct from p_payment_intent
       or recorded.event_type is distinct from p_event_type then
      raise exception 'Stripe event payload conflict' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('idempotent', true);
  end if;
  result := private.dues_settle_stripe_checkout(
    p_reservation_id, p_stripe_session_id, p_payment_intent,
    p_payment_status, p_amount_total, p_currency,
    p_connected_account_id, p_client_reference_id,
    p_metadata_reservation_id
  );
  insert into public.dues_stripe_events (
    stripe_event_id, reservation_id, stripe_session_id,
    connected_account_id, payment_status, amount_total, currency,
    client_reference_id, metadata_reservation_id, payment_intent, event_type
  ) values (
    p_stripe_event_id, p_reservation_id, p_stripe_session_id,
    p_connected_account_id, p_payment_status, p_amount_total, p_currency,
    p_client_reference_id, p_metadata_reservation_id, p_payment_intent,
    p_event_type
  );
  return result || pg_catalog.jsonb_build_object('idempotentEvent', false);
end;
$function$;

-- Disconnect-created sessions are persisted before they are expired. The next
-- paced disconnect claim observes that exact session; no missing-session claim
-- is ever translated into a terminal unpaid observation.
create or replace function public.finalize_dues_checkout_reservation(
  p_reservation_id uuid,
  p_stripe_session_id text,
  p_hosted_checkout_url text,
  p_stripe_expires_at timestamptz,
  p_lease_epoch integer default 0,
  p_lease_owner uuid default null,
  p_lease_kind text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare reservation public.dues_checkout_reservations%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     or p_stripe_session_id !~ '^[A-Za-z0-9_:-]{3,255}$'
     or p_hosted_checkout_url !~ '^https://[^[:space:]#]+$'
     or p_stripe_expires_at is null
     or p_stripe_expires_at <= now() - interval '5 minutes' then
    raise exception 'dues checkout finalization refused' using errcode = '22023';
  end if;
  select * into reservation
  from public.dues_checkout_reservations row
  where row.id = p_reservation_id
  for update;
  if not found then
    raise exception 'dues checkout unavailable' using errcode = '42501';
  end if;
  if reservation.state = 'open'
     and reservation.stripe_session_id = p_stripe_session_id then
    return pg_catalog.jsonb_build_object(
      'reservationId', reservation.id,
      'state', 'open',
      'hostedCheckoutUrl', reservation.hosted_checkout_url,
      'idempotent', true
    );
  end if;
  if reservation.state = 'creating' then
    if p_lease_epoch <> 0 or p_lease_owner is not null or p_lease_kind is not null
       or reservation.reconcile_lease_owner is not null
       or reservation.stripe_session_id is not null then
      raise exception 'dues checkout lease stale' using errcode = '42501';
    end if;
  elsif reservation.state = 'reconciling' then
    if p_lease_epoch <> reservation.reconcile_lease_epoch
       or p_lease_owner is distinct from reservation.reconcile_lease_owner
       or p_lease_kind is distinct from reservation.reconcile_lease_kind
       or reservation.reconcile_lease_kind not in ('ordinary', 'disconnect')
       or reservation.reconcile_lease_expires_at <= now() then
      raise exception 'dues checkout lease stale' using errcode = '42501';
    end if;
  else
    raise exception 'dues checkout finalization refused' using errcode = '42501';
  end if;
  update public.dues_checkout_reservations
  set state = 'open',
      stripe_session_id = p_stripe_session_id,
      hosted_checkout_url = p_hosted_checkout_url,
      expires_at = least(reservation.expires_at, p_stripe_expires_at),
      reconcile_lease_owner = null,
      reconcile_lease_expires_at = null,
      reconcile_lease_kind = null,
      reconcile_after = case
        when p_lease_kind = 'disconnect' then now() + interval '5 seconds'
        else p_stripe_expires_at
      end,
      updated_at = now()
  where id = reservation.id;
  return pg_catalog.jsonb_build_object(
    'reservationId', reservation.id,
    'state', 'open',
    'hostedCheckoutUrl', p_hosted_checkout_url,
    'idempotent', false
  );
end;
$function$;

-- Dues is a first-class notification topic. Re-emit the current integrated
-- enqueue function so the database preference gate, outbound controls, stress
-- suppression, rate limits, and workload receipt exception all remain the one
-- delivery spine. The only topic-set change is the addition of `dues`.
create or replace function private.enqueue_notification_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  recent_week integer := 0;
  org_today integer;
  limit_reason text;
  transactional_receipt boolean := new.kind = 'workload' and new.workload_event = 'receipt';
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_per_recipient_week constant integer := 5;
  max_org_day constant integer := 20000;
begin
  if new.kind not in (
    'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks',
    'appointments', 'workload', 'dues'
  ) then
    return new;
  end if;
  if exists (
    select 1 from private.member_stress_ledger l
    where l.user_id = new.user_id
  ) then
    return new;
  end if;
  begin
    select controls.outbound_enabled into outbound_on
    from private.notification_controls controls where controls.id;
    if not coalesce(outbound_on, false) then return new; end if;
    select p.notification_prefs into prefs
    from public.member_profiles p where p.id = new.user_id;
    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then return new; end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0)
    );
    select pg_catalog.count(*) into recent_hour
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '1 hour';
    select pg_catalog.count(*) into recent_day
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '24 hours';
    if new.kind not in ('deadlines', 'cases') and not transactional_receipt then
      select pg_catalog.count(*) into recent_week
      from public.member_notification_deliveries d
      join public.member_notifications n2 on n2.id = d.notification_id
      where d.user_id = new.user_id
        and d.channel = 'email'
        and d.status <> 'skipped'
        and d.created_at > pg_catalog.now() - interval '7 days'
        and n2.kind not in ('deadlines', 'cases')
        and not (
          n2.kind = 'workload' and n2.workload_event = 'receipt'
        );
    end if;
    select coalesce(pg_catalog.sum(counter.enqueued), 0) into org_today
    from private.notification_outbound_counters c where c.day = current_date;
    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and not transactional_receipt
      and recent_week >= max_per_recipient_week then
      limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;
    if limit_reason is not null then
      insert into public.member_notification_deliveries (
        notification_id, user_id, channel, status, last_error
      ) values (
        new.id, new.user_id, 'email', 'skipped', limit_reason
      ) on conflict (notification_id, channel) do nothing;
      return new;
    end if;
    insert into private.notification_outbound_counters (day, shard, enqueued)
    values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
    on conflict (day, shard) do update
      set enqueued = private.notification_outbound_counters.enqueued + 1;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    ) values (
      new.id, new.user_id, 'email'
    ) on conflict (notification_id, channel) do nothing;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    )
    select new.id, new.user_id, 'push'
    where exists (
      select 1 from public.member_push_subscriptions s
      where s.user_id = new.user_id
    )
    on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$function$;

-- The Dues scheduler records only a canonical notification enqueue. Email and
-- push provider work is claimed later by the shared notification dispatcher,
-- after the function above applies the member's Dues preference. No Dues cron
-- path guesses whether email is configured or marks a provider delivery sent.
create or replace function public.dispatch_dues_reminder_attempt(
  p_attempt_id uuid,
  p_expected_attempt_count integer,
  p_lease_epoch integer,
  p_outcome text,
  p_outbound_delivery_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  attempt public.dues_reminder_attempts%rowtype;
  recipient uuid;
  notification uuid;
  delivery_state text := p_outcome;
  delivery_suffix text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('sent', 'deferred', 'failed', 'blocked')
     or p_outbound_delivery_key is not null then
    raise exception 'invalid dues reminder outcome' using errcode = '22023';
  end if;
  select * into attempt
  from public.dues_reminder_attempts row
  where row.id = p_attempt_id
  for update;
  if not found then
    raise exception 'dues reminder attempt not found' using errcode = '22023';
  end if;
  if attempt.state <> 'leased'
     or attempt.lease_epoch <> p_lease_epoch
     or attempt.attempt_count <> p_expected_attempt_count
     or attempt.lease_expires_at <= pg_catalog.now() then
    raise exception 'stale dues reminder lease' using errcode = '40001';
  end if;
  select subject.user_id into recipient
  from public.dues_obligations obligation
  join public.dues_member_subjects subject
    on subject.organization_id = obligation.organization_id
   and subject.id = obligation.member_subject_id
  where obligation.organization_id = attempt.organization_id
    and obligation.id = attempt.obligation_id;

  if p_outcome = 'sent' and recipient is not null then
    delivery_suffix := case when attempt.channel = 'email' then 'email' else 'in-app' end;
    insert into public.dues_notification_deliveries (
      organization_id, reminder_attempt_id, channel, delivery_key, state
    ) values (
      attempt.organization_id, attempt.id, attempt.channel,
      'dues-reminder:' || attempt.id::text || ':' || delivery_suffix,
      'queued'
    ) on conflict (organization_id, reminder_attempt_id, channel) do nothing;
    select delivery.notification_id into notification
    from public.dues_notification_deliveries delivery
    where delivery.organization_id = attempt.organization_id
      and delivery.reminder_attempt_id = attempt.id
      and delivery.channel = attempt.channel
    for update;
    if notification is null then
      insert into public.member_notifications (user_id, title, body, kind)
      values (
        recipient,
        'Account update',
        'An account update needs your attention. Open Dues to review it.',
        'dues'
      ) returning id into notification;
      update public.dues_notification_deliveries
      set notification_id = notification,
          state = 'sent',
          updated_at = pg_catalog.now()
      where organization_id = attempt.organization_id
        and reminder_attempt_id = attempt.id
        and channel = attempt.channel;
    end if;
  elsif p_outcome = 'sent' then
    delivery_state := 'blocked';
  end if;
  update public.dues_reminder_attempts
  set state = delivery_state,
      lease_owner = null,
      lease_expires_at = null,
      outcome_code = delivery_state,
      updated_at = pg_catalog.now()
  where id = attempt.id;
  return pg_catalog.jsonb_build_object(
    'id', attempt.id,
    'state', delivery_state,
    'notificationId', notification
  );
end;
$function$;

revoke all on function private.enqueue_notification_deliveries()
  from public, anon, authenticated, service_role;
revoke all on function public.dispatch_dues_reminder_attempt(
  uuid, integer, integer, text, text
) from public, anon, authenticated;
grant execute on function public.dispatch_dues_reminder_attempt(
  uuid, integer, integer, text, text
) to service_role;

drop function if exists public.set_dues_stripe_account(uuid, uuid, text, text, boolean, boolean);

revoke all on function
  private.refresh_dues_financial_identity_for_context(uuid, uuid, text),
  private.refresh_dues_financial_identity_from_role_grant(),
  private.refresh_dues_financial_identity_from_membership(),
  private.dues_settle_stripe_checkout(
    uuid, text, text, text, integer, text, text, uuid, uuid
  ),
  private.dues_claim_checkout_reconciliations(integer, uuid, boolean)
  from public, anon, authenticated, service_role;

revoke all on function
  public.set_dues_financial_identity_for_context(uuid, uuid, text, text),
  public.provision_dues_financial_identity_for_active_context(uuid, uuid),
  public.save_dues_stripe_oauth_state(
    text, uuid, uuid, text, text, text, timestamptz
  ),
  public.claim_dues_stripe_oauth_callback(text, text, uuid),
  public.record_dues_stripe_oauth_exchange(
    text, integer, uuid, text, text, boolean
  ),
  public.defer_dues_stripe_oauth_callback(text, integer, uuid, text),
  public.fail_dues_stripe_oauth_callback(text, integer, uuid, text, text),
  public.complete_dues_stripe_oauth_callback(
    text, integer, uuid, uuid, uuid, text, text, boolean, boolean
  ),
  public.claim_dues_stripe_oauth_reconciliations(integer, uuid),
  public.settle_dues_stripe_event(
    text, uuid, text, text, text, integer, text, uuid, uuid, text, text
  ),
  public.reconcile_dues_checkout_reservation(
    uuid, integer, uuid, text, text, text, text, text, text, integer,
    text, uuid, uuid, timestamptz
  ),
  public.resolve_dues_checkout_attention(
    uuid, uuid, text, text, text, text, timestamptz, text, text,
    integer, text, text, uuid, uuid
  )
  from public, anon, authenticated;

grant execute on function
  public.set_dues_financial_identity_for_context(uuid, uuid, text, text),
  public.provision_dues_financial_identity_for_active_context(uuid, uuid),
  public.save_dues_stripe_oauth_state(
    text, uuid, uuid, text, text, text, timestamptz
  ),
  public.claim_dues_stripe_oauth_callback(text, text, uuid),
  public.record_dues_stripe_oauth_exchange(
    text, integer, uuid, text, text, boolean
  ),
  public.defer_dues_stripe_oauth_callback(text, integer, uuid, text),
  public.fail_dues_stripe_oauth_callback(text, integer, uuid, text, text),
  public.complete_dues_stripe_oauth_callback(
    text, integer, uuid, uuid, uuid, text, text, boolean, boolean
  ),
  public.claim_dues_stripe_oauth_reconciliations(integer, uuid),
  public.settle_dues_stripe_event(
    text, uuid, text, text, text, integer, text, uuid, uuid, text, text
  ),
  public.reconcile_dues_checkout_reservation(
    uuid, integer, uuid, text, text, text, text, text, text, integer,
    text, uuid, uuid, timestamptz
  ),
  public.resolve_dues_checkout_attention(
    uuid, uuid, text, text, text, text, timestamptz, text, text,
    integer, text, text, uuid, uuid
  )
  to service_role;

notify pgrst, 'reload schema';

commit;
