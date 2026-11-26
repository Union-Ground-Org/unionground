-- MI1 CR-086 member-facing access history.
-- Empty on reset. Members read only their own subject rows. Staff record
-- through a session-derived RPC and cannot write about themselves.

set local lock_timeout = '5s';

alter table public.organization_audit_events
  drop constraint organization_audit_events_event_type_check,
  drop constraint organization_audit_events_metadata_keys;

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
    'member_handoff_initiated',
    'member_handoff_acknowledged',
    'member_handoff_declined',
    'member_handoff_cancelled',
    'contract_clause_created',
    'contract_clause_updated',
    'contract_clause_retired',
    'contract_clause_restored',
    'member_access_recorded'
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
      'library', 'reviewStatus', 'indexStatus', 'byteSize',
      'handoffId', 'fromStewardId', 'toStewardId', 'clauseId', 'article'
    ] = '{}'::jsonb
  );

create table public.member_access_events (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  subject_user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text not null,
  action text not null check (action in (
    'viewed_profile', 'viewed_case', 'updated_profile', 'updated_case',
    'granted_role', 'revoked_role'
  )),
  entity_type text not null check (entity_type in ('member', 'case', 'role_grant')),
  entity_id text,
  occurred_at timestamptz not null default pg_catalog.now(),
  constraint member_access_events_not_self check (subject_user_id is distinct from actor_user_id),
  constraint member_access_events_actor_role_bounded check (
    actor_role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ),
  constraint member_access_events_entity_id_bounded check (
    entity_id is null or pg_catalog.char_length(entity_id) between 1 and 80
  )
);

create index member_access_events_subject_occurred_idx
  on public.member_access_events (organization_id, subject_user_id, occurred_at desc);

alter table public.member_access_events enable row level security;

create policy member_access_events_select_subject on public.member_access_events
  for select to authenticated
  using (
    subject_user_id = (select auth.uid())
    and private.is_organization_member(organization_id)
  );

create policy mfa_assurance on public.member_access_events
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on public.member_access_events from public, anon, authenticated;
grant select on public.member_access_events to authenticated;

create function public.list_my_access_history(p_range_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  cutoff timestamptz;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_range_days is not null and p_range_days not in (30, 90, 365) then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  cutoff := case
    when p_range_days is null then null
    else pg_catalog.now() - (p_range_days || ' days')::interval
  end;
  return coalesce((
    select pg_catalog.jsonb_agg(row_to_json(feed) order by feed."occurredAt" desc)
    from (
      select
        e.id::text as id,
        e.organization_id as "organizationId",
        e.subject_user_id as "subjectUserId",
        split_part(coalesce(p.full_name, e.actor_role), ' ', 1) as "actorLabel",
        e.actor_role as "actorRole",
        e.action,
        e.entity_type as "entityType",
        e.entity_id as "entityId",
        e.occurred_at as "occurredAt"
      from public.member_access_events e
      left join public.member_profiles p on p.id = e.actor_user_id
      where e.organization_id = org
        and e.subject_user_id = caller
        and (cutoff is null or e.occurred_at >= cutoff)
      union all
      select
        a.id::text as id,
        a.organization_id as "organizationId",
        caller as "subjectUserId",
        split_part(coalesce(p.full_name, 'staff'), ' ', 1) as "actorLabel",
        'staff'::text as "actorRole",
        case
          when a.event_type = 'organization_role_granted' then 'granted_role'
          else 'revoked_role'
        end as action,
        'role_grant'::text as "entityType",
        null::text as "entityId",
        a.created_at as "occurredAt"
      from public.organization_audit_events a
      left join public.member_profiles p on p.id = a.actor_user_id
      where a.organization_id = org
        and a.event_type in ('organization_role_granted', 'organization_role_revoked')
        and a.metadata ->> 'userId' = caller::text
        and (cutoff is null or a.created_at >= cutoff)
    ) feed
  ), '[]'::jsonb);
end;
$function$;

create function public.record_member_access_event(
  p_expected_organization_id uuid,
  p_subject_user_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  caller uuid := (select auth.uid());
  role text;
  saved public.member_access_events%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_subject_user_id is null or p_subject_user_id is not distinct from caller then
    raise exception 'cannot record self access' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = org
      and membership.user_id = p_subject_user_id
      and membership.status = 'active'
  ) then
    raise exception 'subject not authorized' using errcode = '42501';
  end if;
  if p_action not in ('viewed_profile', 'viewed_case', 'updated_profile', 'updated_case') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_entity_type not in ('member', 'case') then
    raise exception 'invalid entity' using errcode = '22023';
  end if;
  if (p_action in ('viewed_profile', 'updated_profile') and p_entity_type <> 'member')
    or (p_action in ('viewed_case', 'updated_case') and p_entity_type <> 'case')
    or (p_entity_id is not null and pg_catalog.char_length(p_entity_id) not between 1 and 80)
    or (p_entity_type = 'case' and p_entity_id is null)
  then
    raise exception 'invalid entity' using errcode = '22023';
  end if;
  select r.role into role
  from public.organization_role_grants r
  where r.organization_id = org
    and r.user_id = caller
    and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  order by case r.role
    when 'admin' then 1
    when 'vp' then 2
    when 'coordinator' then 3
    when 'advisor' then 4
    when 'steward' then 5
    else 6
  end
  limit 1;
  if role is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.member_access_events (
    organization_id, subject_user_id, actor_user_id, actor_role, action, entity_type, entity_id
  ) values (
    org, p_subject_user_id, caller, role, p_action, p_entity_type, nullif(p_entity_id, '')
  )
  returning * into saved;
  perform private.mi1_write_tenant_audit(org, 'member_access_recorded', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'userId', p_subject_user_id,
    'action', p_action,
    'entityType', p_entity_type
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'id', saved.id, 'organizationId', org);
end;
$function$;

revoke all on function public.list_my_access_history(integer) from public, anon;
revoke all on function public.record_member_access_event(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.list_my_access_history(integer) to authenticated;
grant execute on function public.record_member_access_event(uuid, uuid, text, text, text) to authenticated;
