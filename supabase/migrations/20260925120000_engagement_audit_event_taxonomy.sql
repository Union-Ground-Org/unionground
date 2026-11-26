-- SEC-UG-ENGAGEMENT-AUDIT-EVENT-TAXONOMY-20260921 (part 1 of 2)
--
-- Twelve privileged engagement writers appended their tenant audit row as
-- 'survey_draft_saved', whatever they did, so the admin ledger could not tell
-- a privacy-floor change from a live-poll close. This migration admits one
-- operation-specific event type per engagement operation and four identifying
-- metadata keys, projects the engagement event types into the
-- 'communications' domain of the admin ledger (the three configuration writes
-- as 'settings_change'), and re-emits the six survey-side writers with their
-- own event types. Part 2 (20260925120100) re-emits the weekly-question and
-- live-poll writers onto the types admitted here.
--
-- Each writer is re-declared from its installed definition on Main: the
-- case-graph entry lock that 20260907151000 (or 20260924131100 for the atomic
-- publisher) placed ahead of the declaration initializers stays first, and
-- every authorization check, write and return shape is unchanged. Only the
-- audit append differs: its event type, the row identifier, and the actor.
-- publish_organization_survey_with_operations keeps its draft-save and
-- survey_published rows; only its configuration row changes type.
--
-- The event-type and metadata-key lists keep Main's newest vocabulary
-- (20260924140400) and append the new tokens at the end.

begin;

set local lock_timeout = '5s';

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
    'live_poll_transitioned'
  ));

alter table public.organization_audit_events
  drop constraint organization_audit_events_metadata_keys;

alter table public.organization_audit_events
  add constraint organization_audit_events_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId',
      'status', 'requireStaffMfa', 'questionId', 'replyId', 'targetKind',
      'voted', 'kind', 'surface', 'exportFormat', 'rowCount',
      'suppressedCount', 'expiresAt', 'grade', 'stepNumber', 'effectiveOn',
      'action', 'provider', 'host', 'events', 'entityType', 'entityId',
      'fromStatus', 'toStatus', 'fromRole', 'toRole', 'eventType', 'domain',
      'jobName', 'runId', 'remediation', 'outcome', 'count', 'fieldsChanged',
      'reasonCode', 'exportType', 'cadence', 'surveyId', 'sessionId',
      'privacyMinResponses', 'caseId', 'fromStep', 'toStep',
      'previousDeadline', 'newDeadline', 'alertId', 'reminderId',
      'restricted', 'fileId', 'sourceId', 'category', 'library',
      'reviewStatus', 'indexStatus', 'byteSize', 'handoffId', 'fromStewardId',
      'toStewardId', 'clauseId', 'article', 'collectionId', 'visibility',
      'scope', 'itemKind', 'itemId', 'included', 'articleId',
      'restoredRevisionId', 'restoredFromVersion', 'newVersion',
      'accountEmail', 'fields', 'version', 'campaignId', 'batchId',
      'scopeKind', 'eligibleCount', 'amountCents', 'obligationId',
      'receiptNumber', 'eventKind', 'channel', 'attemptId', 'selectedHat',
      'requestedBy', 'reservationId', 'resolution', 'evidenceReference',
      'reason', 'failureClass', 'publishedPreserved',
      'publishedCandidatesStaged', 'publishedRetirementsStaged',
      'staleCandidatesCleared', 'draftsRetired', 'oauthStateFinalized',
      'resumedRecordedExchange', 'spaceId', 'postingMode', 'slowModeSeconds',
      'approvalsRequired', 'taskId', 'reviewId', 'promptId', 'pollId'
    ] = '{}'::jsonb
  );

create or replace function public.list_organization_audit_ledger(
  p_limit integer,
  p_before timestamptz,
  p_before_id uuid,
  p_domain text,
  p_action text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(item order by occurred_at desc, id desc)
    from (
      select normalized.id, normalized.occurred_at, normalized.item
      from (
        select
          l.id,
          l.occurred_at,
          l.domain,
          l.action,
          pg_catalog.jsonb_build_object(
            'id', l.id,
            'organizationId', l.organization_id,
            'domain', l.domain,
            'eventType', l.event_type,
            'action', l.action,
            'actorUserId', l.actor_user_id,
            'entityType', l.entity_type,
            'entityId', l.entity_id,
            'occurredAt', l.occurred_at,
            'source', l.source,
            'metadata', l.metadata
          ) as item
        from public.organization_audit_ledger l
        where l.organization_id = org
        union all
        select
          e.id,
          e.created_at,
          classified.domain,
          classified.action,
          pg_catalog.jsonb_build_object(
            'id', e.id,
            'organizationId', e.organization_id,
            'domain', classified.domain,
            'eventType', e.event_type,
            'action', classified.action,
            'actorUserId', e.actor_user_id,
            'entityType', case
              when e.event_type = 'member_access_recorded'
                and e.metadata ->> 'entityType' in ('member', 'case')
                then e.metadata ->> 'entityType'
              else 'organization'
            end,
            'entityId', e.metadata ->> 'entityId',
            'occurredAt', e.created_at,
            'source', 'organization_audit_events',
            'metadata', e.metadata
          )
        from public.organization_audit_events e
        cross join lateral (values (
          case
            when e.event_type like 'qa_%' then 'knowledge'
            when e.event_type = 'analytics_snapshot_read' then 'data_access'
            when e.event_type = 'analytics_export_requested' then 'exports'
            when e.event_type like 'integration_%' or e.event_type like 'organization_job_%' then 'operations'
            when e.event_type = 'staff_mfa_policy_changed' then 'security'
            when e.event_type like 'organization_membership_%' or e.event_type like 'organization_role_%' then 'membership'
            when e.event_type like 'survey_%' or e.event_type like 'live_poll_%'
              or e.event_type like 'weekly_question_%' or e.event_type = 'pulse_prompt_saved' then 'communications'
            else 'administration'
          end,
          case
            when e.event_type in ('first_organization_bootstrap', 'qa_question_asked', 'qa_official_replied', 'qa_follow_up_replied') then 'create'
            when e.event_type in ('organization_membership_granted', 'organization_role_granted') then 'grant'
            when e.event_type in ('organization_membership_revoked', 'organization_role_revoked') then 'revoke'
            when e.event_type = 'qa_deleted' then 'delete'
            when e.event_type = 'analytics_snapshot_read' then 'read'
            when e.event_type = 'analytics_export_requested' then 'export'
            when e.event_type = 'organization_job_acknowledged' then 'acknowledge'
            when e.event_type = 'organization_job_retry_requested' then 'retry_requested'
            when e.event_type like 'integration_%' or e.event_type = 'staff_mfa_policy_changed' then 'settings_change'
            when e.event_type in ('survey_privacy_floor_changed', 'survey_operations_configured', 'weekly_question_policy_saved') then 'settings_change'
            else 'update'
          end
        )) as classified(domain, action)
        where e.organization_id = org
        union all
        select
          a.id,
          a.created_at,
          classified.domain,
          classified.action,
          pg_catalog.jsonb_build_object(
            'id', a.id,
            'organizationId', a.organization_id,
            'domain', classified.domain,
            'eventType', case a.action
              when 'grant_role' then 'role.granted'
              when 'revoke_role' then 'role.revoked'
              when 'create_event' then 'event.created'
              when 'update_event' then 'event.updated'
              when 'cancel_event' then 'event.cancelled'
              when 'restore_event' then 'event.restored'
              when 'delete_event' then 'event.deleted'
              when 'reset_mfa' then 'mfa.reset'
              when 'claim_reward' then 'reward.claimed'
              when 'grant_reward' then 'reward.granted'
              when 'revoke_reward' then 'reward.revoked'
              when 'fulfill_reward' then 'reward.fulfilled'
              when 'set_staff_mfa_policy' then 'mfa.policy_changed'
              when 'create_campaign' then 'campaign.created'
              when 'update_campaign_draft' then 'campaign.updated'
              when 'publish_campaign' then 'campaign.published'
              when 'close_campaign' then 'campaign.closed'
              when 'recover_signin_address' then 'signin.recovered'
              when 'recover_signin_address_failed' then 'signin.recovery_failed'
              when 'review_email_intake' then 'email.intake_reviewed'
              when 'create_chapter' then 'chapter.created'
              when 'update_chapter' then 'chapter.updated'
              when 'grant_chapter_membership' then 'membership.granted'
              when 'revoke_chapter_membership' then 'membership.revoked'
              else 'settings.changed'
            end,
            'action', classified.action,
            'actorUserId', a.actor,
            'entityType', case
              when a.action in ('grant_role', 'revoke_role') then 'role_grant'
              when a.action in ('create_event', 'update_event', 'cancel_event', 'restore_event', 'delete_event') then 'event'
              when a.action ~ 'reward' then 'reward'
              when a.action in ('grant_chapter_membership', 'revoke_chapter_membership') then 'membership'
              when a.action in ('create_chapter', 'update_chapter') then 'chapter'
              when a.action ~ '(mfa|signin|sign_in|compass_ai_provider)' then 'security_policy'
              when a.action ~ 'campaign' then 'campaign'
              else 'organization'
            end,
            'entityId', coalesce(a.target_user::text, a.detail->>'eventId', a.detail->>'chapterId', a.organization_id::text),
            'occurredAt', a.created_at,
            'source', 'member_admin_audit',
            'metadata', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
              'organizationId', a.organization_id,
              'chapterId', a.detail->>'chapterId',
              'role', a.detail->>'role',
              'userId', a.target_user,
              'status', a.detail->>'status'
            ))
          )
        from public.member_admin_audit a
        cross join lateral (values (
          case
            when a.action ~ '(event|checkin)' then 'community_events'
            when a.action ~ '(case|form|filing|cosign)' then 'casework'
            when a.action ~ '(message|broadcast|campaign|notification|email)' then 'communications'
            when a.action ~ '(document|record|task_template)' then 'knowledge'
            when a.action ~ '(reward|point|tier)' then 'rewards'
            when a.action ~ '(export)' then 'exports'
            when a.action ~ '(analytics)' then 'data_access'
            when a.action ~ '(mfa|signin|sign_in|signout|account_deletion|security|compass_ai_provider)' then 'security'
            when a.action ~ '(member|role|invitation|chapter_membership)' then 'membership'
            else 'administration'
          end,
          case
            when a.action ~ 'grant' then 'grant'
            when a.action ~ 'revoke' then 'revoke'
            when a.action ~ '(delete|remove|deactivate|cancel|close)' then 'delete'
            when a.action ~ '(create|add|invite)' then 'create'
            when a.action ~ '(send|publish)' then 'send'
            when a.action ~ 'export' then 'export'
            when a.action ~ '(login|signin|sign_in)' then 'login'
            when a.action ~ '(read|list|search|view)' then 'read'
            when a.action ~ 'acknowledge' then 'acknowledge'
            when a.action ~ 'retry' then 'retry_requested'
            else 'settings_change'
          end
        )) as classified(domain, action)
        where a.organization_id = org
      ) normalized
      where (p_domain is null or normalized.domain = p_domain)
        and (p_action is null or normalized.action = p_action)
        and (
          p_before is null
          or (normalized.occurred_at, normalized.id) < (
            p_before,
            coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
          )
        )
      order by normalized.occurred_at desc, normalized.id desc
      limit clamped
    ) projected
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.set_organization_survey_privacy_floor(
  p_survey_id uuid,
  p_privacy_min_responses integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_privacy_min_responses not between 3 and 50 then
    raise exception 'privacy floor must be between 3 and 50' using errcode = '22023';
  end if;
  select * into survey from public.organization_surveys
  where id = p_survey_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  update public.organization_surveys
  set privacy_min_responses = p_privacy_min_responses, updated_at = pg_catalog.now()
  where id = survey.id and organization_id = org;
  perform private.mi1_w2_write_audit(org, 'survey_privacy_floor_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', survey.id, 'userId', (select auth.uid()), 'status', survey.status,
    'privacyMinResponses', p_privacy_min_responses
  ));
  return private.mi1_w2_project_survey(survey.id);
end;
end;
$function$;

create or replace function public.configure_organization_survey_operations(
  p_survey_id uuid,
  p_operations jsonb
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
  survey public.organization_surveys%rowtype;
  next_owner uuid := nullif(p_operations ->> 'ownerUserId', '')::uuid;
  next_cadence text := coalesce(nullif(p_operations ->> 'cadence', ''), 'one_off');
  next_period text := nullif(pg_catalog.btrim(coalesce(p_operations ->> 'periodKey', '')), '');
  next_state text := coalesce(nullif(p_operations ->> 'operationsState', ''), 'draft');
begin
  perform private.engagement_require_staff(org);
  select * into survey
  from public.organization_surveys
  where id = p_survey_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if next_cadence not in ('one_off', 'quarterly', 'contextual') then
    raise exception 'invalid cadence' using errcode = '22023';
  end if;
  if next_state not in ('draft', 'ready', 'distributing', 'reviewing', 'complete') then
    raise exception 'invalid operations state' using errcode = '22023';
  end if;
  if next_cadence = 'quarterly' and next_period is null then
    raise exception 'quarterly surveys require a period key' using errcode = '22023';
  end if;
  if next_owner is not null and not private.engagement_user_in_organization(org, next_owner) then
    raise exception 'owner is not an active organization member' using errcode = '42501';
  end if;
  update public.organization_surveys
  set cadence = next_cadence,
      period_key = next_period,
      opens_at = nullif(p_operations ->> 'opensAt', '')::timestamptz,
      closes_at = nullif(p_operations ->> 'closesAt', '')::timestamptz,
      owner_user_id = next_owner,
      operations_state = next_state,
      review_due_at = nullif(p_operations ->> 'reviewDueAt', '')::timestamptz,
      updated_at = pg_catalog.now()
  where id = survey.id;
  insert into public.organization_survey_tasks (
    organization_id, survey_id, reason, status, assigned_to, due_at, created_by
  )
  values (
    org, survey.id, 'readiness',
    case when next_state in ('ready', 'distributing', 'reviewing', 'complete') then 'done' else 'open' end,
    next_owner, nullif(p_operations ->> 'readinessDueAt', '')::timestamptz, (select auth.uid())
  )
  on conflict (survey_id, reason) do update
    set status = excluded.status,
        assigned_to = excluded.assigned_to,
        due_at = excluded.due_at,
        updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'survey_operations_configured', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', survey.id,
    'userId', (select auth.uid()),
    'status', next_state,
    'fieldsChanged', pg_catalog.jsonb_build_array('cadence', 'periodKey', 'owner', 'window', 'reviewDueAt')
  ));
  return private.mi1_w2_project_survey(survey.id) || pg_catalog.jsonb_build_object(
    'cadence', next_cadence,
    'periodKey', next_period,
    'operationsState', next_state,
    'ownerUserId', next_owner
  );
end;
end;
$function$;

create or replace function public.publish_organization_survey_with_operations(
  p_draft jsonb,
  p_operations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Acquire the case-graph gate before any declaration initializer runs, as
  -- the survey save, publish, and configuration writers already do, so this
  -- writer orders with concurrent Auth/account-deletion work.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_w2_selected_organization();
  existing public.organization_surveys%rowtype;
  saved_survey_id uuid;
  next_title text := pg_catalog.btrim(coalesce(p_draft ->> 'title', ''));
  next_description text := pg_catalog.btrim(coalesce(p_draft ->> 'description', ''));
  chapter text := nullif(pg_catalog.btrim(coalesce(p_draft ->> 'chapterId', '')), '');
  privacy integer := coalesce(nullif(p_draft ->> 'privacyMinResponses', '')::integer, 3);
  next_owner uuid := nullif(p_operations ->> 'ownerUserId', '')::uuid;
  next_cadence text := coalesce(nullif(p_operations ->> 'cadence', ''), 'one_off');
  next_period text := nullif(pg_catalog.btrim(coalesce(p_operations ->> 'periodKey', '')), '');
  next_state text := coalesce(nullif(p_operations ->> 'operationsState', ''), 'ready');
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(next_title) not between 3 and 200
     or pg_catalog.char_length(next_description) > 4000 then
    raise exception 'A draft needs valid title and description copy.' using errcode = '22023';
  end if;
  if privacy not between 3 and 50 then
    raise exception 'privacy floor must be between 3 and 50' using errcode = '22023';
  end if;
  if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if coalesce(p_draft ? 'organizationId', false)
     and nullif(p_draft ->> 'organizationId', '') is distinct from org::text then
    raise exception 'organization is derived from the session' using errcode = '42501';
  end if;
  if next_cadence not in ('one_off', 'quarterly', 'contextual') then
    raise exception 'invalid cadence' using errcode = '22023';
  end if;
  -- Publish never accepts operations_state = 'draft'. Member snapshots filter
  -- on status = 'open' and the time window only, so a draft operations payload
  -- would go live immediately. Omitted state defaults to 'ready' (the UI
  -- publish path); an explicit 'draft' is invalid here.
  if next_state not in ('ready', 'distributing', 'reviewing', 'complete') then
    raise exception 'invalid operations state' using errcode = '22023';
  end if;
  if next_cadence = 'quarterly' and next_period is null then
    raise exception 'quarterly surveys require a period key' using errcode = '22023';
  end if;
  if next_owner is not null and not private.engagement_user_in_organization(org, next_owner) then
    raise exception 'owner is not an active organization member' using errcode = '42501';
  end if;

  -- Refuse the quarterly period collision BEFORE any row changes state. The
  -- unique index remains as the concurrent-write backstop and raises the same
  -- 23505, so the client maps one code to the translated conflict copy.
  if next_cadence = 'quarterly' and next_period is not null then
    if exists (
      select 1 from public.organization_surveys s
      where s.organization_id = org
        and s.cadence = 'quarterly'
        and s.period_key = next_period
        and s.id is distinct from nullif(p_draft ->> 'id', '')::uuid
    ) then
      raise exception 'quarterly survey period conflict' using errcode = '23505';
    end if;
  end if;

  if nullif(p_draft ->> 'id', '') is not null then
    select * into existing
    from public.organization_surveys
    where id = (p_draft ->> 'id')::uuid
    for update;
    if not found or existing.organization_id is distinct from org then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if existing.status <> 'draft' then
      raise exception 'Published surveys cannot return to free-form draft editing.' using errcode = 'P0001';
    end if;
    saved_survey_id := existing.id;
    update public.organization_surveys
    set title = next_title,
        description = next_description,
        chapter_id = chapter,
        privacy_min_responses = privacy,
        updated_at = pg_catalog.now()
    where id = saved_survey_id and organization_id = org;
  else
    insert into public.organization_surveys (
      organization_id, chapter_id, title, description, privacy_min_responses, created_by
    ) values (
      org, chapter, next_title, next_description, privacy, (select auth.uid())
    ) returning id into saved_survey_id;
  end if;

  perform private.mi1_w2_replace_survey_questions(org, saved_survey_id, p_draft -> 'questions');
  if not exists (
    select 1 from public.organization_survey_questions q
    where q.survey_id = saved_survey_id and q.organization_id = org
  ) then
    raise exception 'Survey is not ready to publish.' using errcode = '22023';
  end if;

  -- Status and operating configuration commit together: any failure above or
  -- below rolls the whole publish back, so no survey can be observed at
  -- status 'open' without the cadence, period, window, and readiness task the
  -- operator submitted.
  update public.organization_surveys
  set status = 'open',
      cadence = next_cadence,
      period_key = next_period,
      opens_at = nullif(p_operations ->> 'opensAt', '')::timestamptz,
      closes_at = nullif(p_operations ->> 'closesAt', '')::timestamptz,
      owner_user_id = next_owner,
      operations_state = next_state,
      review_due_at = nullif(p_operations ->> 'reviewDueAt', '')::timestamptz,
      updated_at = pg_catalog.now()
  where id = saved_survey_id and organization_id = org;

  insert into public.organization_survey_tasks (
    organization_id, survey_id, reason, status, assigned_to, due_at, created_by
  )
  values (
    org, saved_survey_id, 'readiness',
    case when next_state in ('ready', 'distributing', 'reviewing', 'complete') then 'done' else 'open' end,
    next_owner, nullif(p_operations ->> 'readinessDueAt', '')::timestamptz, (select auth.uid())
  )
  on conflict (survey_id, reason) do update
    set status = excluded.status,
        assigned_to = excluded.assigned_to,
        due_at = excluded.due_at,
        updated_at = pg_catalog.now();

  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'surveyId', saved_survey_id,
    'status', 'draft', 'privacyMinResponses', privacy
  ));
  perform private.mi1_w2_write_audit(org, 'survey_published', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', saved_survey_id, 'status', 'open',
    'privacyMinResponses', privacy
  ));
  perform private.mi1_w2_write_audit(org, 'survey_operations_configured', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', saved_survey_id,
    'userId', (select auth.uid()),
    'status', next_state,
    'fieldsChanged', pg_catalog.jsonb_build_array('cadence', 'periodKey', 'owner', 'window', 'reviewDueAt')
  ));

  return private.mi1_w2_project_survey(saved_survey_id) || pg_catalog.jsonb_build_object(
    'cadence', next_cadence,
    'periodKey', next_period,
    'operationsState', next_state,
    'ownerUserId', next_owner
  );
end;
end;
$function$;

create or replace function public.update_organization_survey_task(
  p_task_id uuid,
  p_status text,
  p_assigned_to uuid default null,
  p_due_at timestamp with time zone default null
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
  task public.organization_survey_tasks%rowtype;
begin
  perform private.engagement_require_staff(org);
  if p_status not in ('open', 'in_progress', 'done', 'dismissed') then
    raise exception 'invalid task status' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not private.engagement_user_in_organization(org, p_assigned_to) then
    raise exception 'assignee is not an active organization member' using errcode = '42501';
  end if;
  update public.organization_survey_tasks
  set status = p_status, assigned_to = p_assigned_to, due_at = p_due_at,
      updated_at = pg_catalog.now()
  where id = p_task_id and organization_id = org
  returning * into task;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'survey_task_updated', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', task.survey_id,
    'taskId', task.id,
    'userId', (select auth.uid()),
    'status', task.status,
    'reasonCode', task.reason,
    'fieldsChanged', pg_catalog.jsonb_build_array('assignment', 'status', 'dueAt')
  ));
  return pg_catalog.jsonb_build_object(
    'id', task.id, 'surveyId', task.survey_id, 'reason', task.reason,
    'status', task.status, 'assignedTo', task.assigned_to, 'dueAt', task.due_at
  );
end;
end;
$function$;

create or replace function public.update_organization_survey_review(
  p_review_id uuid,
  p_state text,
  p_assigned_to uuid default null,
  p_disposition text default null,
  p_follow_up_due_at timestamp with time zone default null
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
  review public.organization_survey_reviews%rowtype;
begin
  perform private.engagement_require_staff(org);
  if p_state not in ('unreviewed', 'assigned', 'follow_up', 'resolved', 'dismissed') then
    raise exception 'invalid review state' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not private.engagement_user_in_organization(org, p_assigned_to) then
    raise exception 'reviewer is not an active organization member' using errcode = '42501';
  end if;
  update public.organization_survey_reviews
  set state = p_state,
      assigned_to = p_assigned_to,
      disposition = nullif(pg_catalog.btrim(coalesce(p_disposition, '')), ''),
      follow_up_due_at = p_follow_up_due_at,
      updated_at = pg_catalog.now()
  where id = p_review_id and organization_id = org
  returning * into review;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'survey_response_review_updated', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', review.survey_id,
    'sessionId', review.session_id,
    'reviewId', review.id,
    'userId', (select auth.uid()),
    'status', review.state,
    'fieldsChanged', pg_catalog.jsonb_build_array('assignment', 'state', 'disposition', 'followUpDueAt')
  ));
  return pg_catalog.jsonb_build_object(
    'id', review.id, 'surveyId', review.survey_id, 'sessionId', review.session_id,
    'state', review.state, 'assignedTo', review.assigned_to,
    'disposition', review.disposition, 'followUpDueAt', review.follow_up_due_at
  );
end;
end;
$function$;

create or replace function public.save_organization_pulse_prompt(p_prompt jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  prompt_id uuid := nullif(p_prompt ->> 'id', '')::uuid;
  chapter text := nullif(pg_catalog.btrim(coalesce(p_prompt ->> 'chapterId', '')), '');
  saved public.organization_pulse_prompts%rowtype;
begin
  perform private.engagement_require_staff(org);
  if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if prompt_id is null then
    insert into public.organization_pulse_prompts (
      organization_id, chapter_id, event_key, question, options, active, cooldown_hours, created_by
    ) values (
      org,
      chapter,
      pg_catalog.lower(pg_catalog.btrim(coalesce(p_prompt ->> 'eventKey', ''))),
      pg_catalog.btrim(coalesce(p_prompt ->> 'question', '')),
      coalesce(p_prompt -> 'options', '[]'::jsonb),
      coalesce((p_prompt ->> 'active')::boolean, true),
      coalesce(nullif(p_prompt ->> 'cooldownHours', '')::integer, 168),
      (select auth.uid())
    ) returning * into saved;
  else
    update public.organization_pulse_prompts
    set chapter_id = chapter,
        event_key = pg_catalog.lower(pg_catalog.btrim(coalesce(p_prompt ->> 'eventKey', ''))),
        question = pg_catalog.btrim(coalesce(p_prompt ->> 'question', '')),
        options = coalesce(p_prompt -> 'options', '[]'::jsonb),
        active = coalesce((p_prompt ->> 'active')::boolean, active),
        cooldown_hours = coalesce(nullif(p_prompt ->> 'cooldownHours', '')::integer, cooldown_hours),
        updated_at = pg_catalog.now()
    where id = prompt_id and organization_id = org
    returning * into saved;
    if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  end if;
  perform private.mi1_w2_write_audit(org, 'pulse_prompt_saved', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'promptId', saved.id,
    'userId', (select auth.uid()),
    'status', case when saved.active then 'active' else 'inactive' end
  ));
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'chapterId', saved.chapter_id, 'eventKey', saved.event_key,
    'question', saved.question, 'options', saved.options, 'active', saved.active,
    'cooldownHours', saved.cooldown_hours
  );
end;
end;
$function$;

revoke all on function public.set_organization_survey_privacy_floor(uuid, integer) from public, anon, authenticated;
revoke all on function public.configure_organization_survey_operations(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.publish_organization_survey_with_operations(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.update_organization_survey_task(uuid, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.update_organization_survey_review(uuid, text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.save_organization_pulse_prompt(jsonb) from public, anon, authenticated;
grant execute on function public.set_organization_survey_privacy_floor(uuid, integer) to authenticated;
grant execute on function public.configure_organization_survey_operations(uuid, jsonb) to authenticated;
grant execute on function public.publish_organization_survey_with_operations(jsonb, jsonb) to authenticated;
grant execute on function public.update_organization_survey_task(uuid, text, uuid, timestamptz) to authenticated;
grant execute on function public.update_organization_survey_review(uuid, text, uuid, text, timestamptz) to authenticated;
grant execute on function public.save_organization_pulse_prompt(jsonb) to authenticated;
revoke execute on function public.set_organization_survey_privacy_floor(uuid, integer) from service_role;
revoke execute on function public.configure_organization_survey_operations(uuid, jsonb) from service_role;
revoke execute on function public.publish_organization_survey_with_operations(jsonb, jsonb) from service_role;
revoke execute on function public.update_organization_survey_task(uuid, text, uuid, timestamptz) from service_role;
revoke execute on function public.update_organization_survey_review(uuid, text, uuid, text, timestamptz) from service_role;
revoke execute on function public.save_organization_pulse_prompt(jsonb) from service_role;

notify pgrst, 'reload schema';

commit;
