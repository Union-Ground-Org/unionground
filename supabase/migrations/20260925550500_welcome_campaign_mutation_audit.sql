-- SEC-UG-WELCOME-CAMPAIGN-MUTATION-AUDIT-20260921
--
-- Welcome-campaign step saves, member enrollments and enrollment transitions
-- wrote only an idempotency receipt; save_welcome_campaign and
-- queue_due_welcome_messages already append organization audit events. Re-emit
-- the three RPCs so every admitted (non-replayed) mutation appends one
-- operation-specific event through private.mi1_w2_write_audit, which records
-- the session actor. Metadata is bounded to identifiers and states that
-- organization_audit_events_metadata_keys already admits: organizationId,
-- campaignId, entityType, entityId, action, status, fromStatus, toStatus.
-- Never the step subject or body, the member's profile, or the member id.

begin;

set local lock_timeout = '5s';

-- 20260907151000 authenticated the 20260830160000 bodies and wrapped them with
-- the case-graph entry gate. Those wrapped sources are the only predecessors
-- this repair may replace; each replacement keeps the gate as its first
-- statement.
do $predecessor$
declare
  r record;
  source text;
  digest text;
begin
  for r in select * from (values
    ('public.save_welcome_campaign_step(uuid,uuid,integer,integer,text,text,text,boolean,uuid)', '07270fc03f325c61f20df1d9e32646a7c39e52c7a677c704042fe54f9d0c689f'),
    ('public.enroll_member_in_welcome_campaign(uuid,uuid,uuid)', 'fb4f97cd3a61862431682996f823e736d0dce769168015a25f0c113259d8e9cd'),
    ('public.transition_member_welcome_enrollment(uuid,text,uuid)', '259c4adea7b2c210dbc19cff00e4660d4c5709ba5dc2a3244f0852e98fdc921d')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc into strict source
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(r.signature);
    digest := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
      'hex'
    );
    if digest is distinct from r.source_sha256 then
      raise exception 'unreviewed % predecessor: %', r.signature, digest
        using errcode = '55000';
    end if;
  end loop;
end;
$predecessor$;

-- Admit the three welcome-campaign events. Keep every previously admitted
-- type in Main's newest order (20260925120000 plus 20260925550000's
-- member_operations_import_discarded) and append the new tokens; do not touch
-- metadata_keys (every payload key is already admitted).
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
    'member_operations_import_discarded',
    'welcome_campaign_step_saved', 'welcome_member_enrolled',
    'welcome_enrollment_transitioned'
  ));

create or replace function public.save_welcome_campaign_step(
  p_campaign_id uuid,
  p_step_id uuid,
  p_position integer,
  p_delay_days integer,
  p_locale text,
  p_subject text,
  p_body text,
  p_active boolean,
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
  saved uuid;
  request_payload jsonb;
  prior jsonb;
  result jsonb;
begin
  if p_idempotency_key is null or p_position not between 0 and 50 or p_delay_days not between 0 and 365
     or p_locale not in ('en','es')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_subject, ''))) not between 1 and 200
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_body, ''))) not between 1 and 10000
     or not exists (select 1 from public.organization_welcome_campaigns campaign where campaign.id = p_campaign_id and campaign.organization_id = org) then
    raise exception 'invalid welcome step' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'campaignId', p_campaign_id, 'stepId', p_step_id, 'position', p_position,
    'delayDays', p_delay_days, 'locale', p_locale,
    'subjectSha256', pg_catalog.encode(extensions.digest(p_subject, 'sha256'), 'hex'),
    'bodySha256', pg_catalog.encode(extensions.digest(p_body, 'sha256'), 'hex'),
    'active', coalesce(p_active, true)
  );
  prior := private.member_operations_replay(
    org, 'save_welcome_campaign_step', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  if p_step_id is null then
    insert into public.organization_welcome_campaign_steps (
      organization_id, campaign_id, position, delay_days, locale, subject, body, active
    ) values (org, p_campaign_id, p_position, p_delay_days, p_locale, pg_catalog.btrim(p_subject), pg_catalog.btrim(p_body), coalesce(p_active, true))
    returning id into saved;
  else
    update public.organization_welcome_campaign_steps set position = p_position, delay_days = p_delay_days,
      locale = p_locale, subject = pg_catalog.btrim(p_subject), body = pg_catalog.btrim(p_body),
      active = coalesce(p_active, true), updated_at = pg_catalog.now()
    where id = p_step_id and campaign_id = p_campaign_id and organization_id = org returning id into saved;
    if saved is null then raise exception 'not found' using errcode = 'P0002'; end if;
  end if;
  perform private.mi1_w2_write_audit(org, 'welcome_campaign_step_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'campaignId', p_campaign_id,
    'entityType', 'welcome_campaign_step', 'entityId', saved,
    'action', case when p_step_id is null then 'created' else 'updated' end
  ));
  result := pg_catalog.jsonb_build_object('id', saved, 'campaignId', p_campaign_id);
  perform private.member_operations_store_receipt(
    org, 'save_welcome_campaign_step', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

create or replace function public.enroll_member_in_welcome_campaign(
  p_campaign_id uuid,
  p_member_user_id uuid,
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
  saved public.member_welcome_enrollments%rowtype;
  first_position integer;
  first_delay integer;
  member_locale text;
  request_payload jsonb;
  prior jsonb;
  result jsonb;
begin
  if p_idempotency_key is null or not exists (select 1 from public.organization_welcome_campaigns campaign
      where campaign.id = p_campaign_id and campaign.organization_id = org and campaign.state = 'active')
     or not exists (select 1 from public.organization_welcome_campaign_steps step
      where step.campaign_id = p_campaign_id and step.organization_id = org and step.active)
     or not exists (select 1 from public.organization_memberships membership
      where membership.organization_id = org and membership.user_id = p_member_user_id
        and membership.status = 'active' and membership.revoked_at is null) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'campaignId', p_campaign_id, 'memberUserId', p_member_user_id
  );
  prior := private.member_operations_replay(
    org, 'enroll_member_in_welcome_campaign', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  select coalesce(operational.preferred_language, profile.language, 'en')
  into member_locale
  from public.member_profiles profile
  left join public.organization_member_operational_profiles operational
    on operational.organization_id = org
   and operational.member_user_id = profile.id
  where profile.id = p_member_user_id;
  select step.position, step.delay_days
  into first_position, first_delay
  from public.organization_welcome_campaign_steps step
  where step.campaign_id = p_campaign_id and step.organization_id = org and step.active
  order by step.position,
    case when step.locale = member_locale then 0 else 1 end,
    step.locale,
    step.id
  limit 1;
  insert into public.member_welcome_enrollments (
    organization_id, campaign_id, member_user_id, next_step_position,
    next_due_at, enrolled_by
  ) values (
    org, p_campaign_id, p_member_user_id, first_position,
    pg_catalog.now() + pg_catalog.make_interval(days => first_delay), (select auth.uid())
  )
  on conflict (campaign_id, member_user_id) do update set
    state = case when public.member_welcome_enrollments.state = 'cancelled' then 'active' else public.member_welcome_enrollments.state end,
    next_step_position = case when public.member_welcome_enrollments.state = 'cancelled'
      then excluded.next_step_position else public.member_welcome_enrollments.next_step_position end,
    next_due_at = case when public.member_welcome_enrollments.state = 'cancelled'
      then excluded.next_due_at else public.member_welcome_enrollments.next_due_at end,
    enrolled_at = case when public.member_welcome_enrollments.state = 'cancelled'
      then pg_catalog.now() else public.member_welcome_enrollments.enrolled_at end,
    completed_at = case when public.member_welcome_enrollments.state = 'cancelled'
      then null else public.member_welcome_enrollments.completed_at end,
    updated_at = pg_catalog.now()
  returning * into saved;
  perform private.mi1_w2_write_audit(org, 'welcome_member_enrolled', pg_catalog.jsonb_build_object(
    'organizationId', org, 'campaignId', p_campaign_id,
    'entityType', 'welcome_enrollment', 'entityId', saved.id, 'status', saved.state
  ));
  result := pg_catalog.jsonb_build_object('id', saved.id, 'state', saved.state);
  perform private.member_operations_store_receipt(
    org, 'enroll_member_in_welcome_campaign', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

create or replace function public.transition_member_welcome_enrollment(
  p_enrollment_id uuid,
  p_state text,
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
  request_payload jsonb;
  prior jsonb;
  prior_state text;
  enrollment_campaign uuid;
  result jsonb;
begin
  if p_idempotency_key is null or p_state not in ('active','paused','cancelled') then
    raise exception 'invalid enrollment state' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object('enrollmentId', p_enrollment_id, 'state', p_state);
  prior := private.member_operations_replay(
    org, 'transition_member_welcome_enrollment', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  if p_state = 'active' and not exists (
    select 1 from public.member_welcome_enrollments enrollment
    join public.organization_memberships membership
      on membership.organization_id = enrollment.organization_id
      and membership.user_id = enrollment.member_user_id
    where enrollment.id = p_enrollment_id and enrollment.organization_id = org
      and membership.status = 'active' and membership.revoked_at is null
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select enrollment.state, enrollment.campaign_id
  into prior_state, enrollment_campaign
  from public.member_welcome_enrollments enrollment
  where enrollment.id = p_enrollment_id and enrollment.organization_id = org and enrollment.state <> 'completed'
  for update;
  update public.member_welcome_enrollments set state = p_state, updated_at = pg_catalog.now()
  where id = p_enrollment_id and organization_id = org and state <> 'completed';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'welcome_enrollment_transitioned', pg_catalog.jsonb_build_object(
    'organizationId', org, 'campaignId', enrollment_campaign,
    'entityType', 'welcome_enrollment', 'entityId', p_enrollment_id,
    'fromStatus', prior_state, 'toStatus', p_state
  ));
  result := pg_catalog.jsonb_build_object('id', p_enrollment_id, 'state', p_state);
  perform private.member_operations_store_receipt(
    org, 'transition_member_welcome_enrollment', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

revoke all on function public.save_welcome_campaign_step(uuid, uuid, integer, integer, text, text, text, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.enroll_member_in_welcome_campaign(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.transition_member_welcome_enrollment(uuid, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_welcome_campaign_step(uuid, uuid, integer, integer, text, text, text, boolean, uuid) to authenticated;
grant execute on function public.enroll_member_in_welcome_campaign(uuid, uuid, uuid) to authenticated;
grant execute on function public.transition_member_welcome_enrollment(uuid, text, uuid) to authenticated;

do $ledger$
declare
  r record;
  source text;
  digest text;
begin
  for r in select * from (values
    ('public.save_welcome_campaign_step(uuid,uuid,integer,integer,text,text,text,boolean,uuid)', '6c0e10bbe3376e5855e2f365f21f503a701d09caf5120168027839e2841e90e1'),
    ('public.enroll_member_in_welcome_campaign(uuid,uuid,uuid)', '771c46a5075208484e41f0486323f8ff65ec52131a98a54fa8ec01400e4e9da5'),
    ('public.transition_member_welcome_enrollment(uuid,text,uuid)', 'a71f6d29e09ff2de93924091f8c5583bbc0daff9e03fbdf6696f45680d63652b')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc into strict source
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(r.signature);
    digest := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
      'hex'
    );
    if digest is distinct from r.source_sha256 then
      raise exception '% source hash drifted: %', r.signature, digest
        using errcode = '55000';
    end if;
  end loop;
end;
$ledger$;

notify pgrst, 'reload schema';

commit;
