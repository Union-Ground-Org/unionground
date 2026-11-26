-- Completes MI1 CR-013, CR-085, CR-096, CR-110, and CR-111.
-- Donor behavior was screened at exact SHA
-- donor-baseline-20260721. No donor migration, credential,
-- project identifier, tenant, or service-role browser path is reused.

set local lock_timeout = '5s';

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
    'member_operations_import_committed'
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
      'accountEmail', 'fields', 'version', 'campaignId', 'batchId'
    ] = '{}'::jsonb
  );

alter table public.engagement_delivery_outbox
  drop constraint if exists engagement_delivery_outbox_delivery_kind_check,
  drop constraint if exists engagement_delivery_outbox_source_kind_check;
alter table public.engagement_delivery_outbox
  add constraint engagement_delivery_outbox_delivery_kind_check
    check (delivery_kind in ('broadcast', 'survey_invitation', 'survey_reminder', 'welcome')),
  add constraint engagement_delivery_outbox_source_kind_check
    check (source_kind in ('broadcast', 'survey', 'welcome_campaign'));

alter table public.engagement_delivery_outbox
  add column subject_snapshot text,
  add column body_snapshot text,
  add column action_path_snapshot text,
  add constraint engagement_delivery_outbox_subject_snapshot_bounded check (
    subject_snapshot is null or pg_catalog.char_length(subject_snapshot) between 1 and 200
  ),
  add constraint engagement_delivery_outbox_body_snapshot_bounded check (
    body_snapshot is null or pg_catalog.char_length(body_snapshot) between 1 and 10000
  ),
  add constraint engagement_delivery_outbox_action_snapshot_bounded check (
    action_path_snapshot is null or pg_catalog.char_length(action_path_snapshot) between 1 and 240
  ),
  add constraint engagement_delivery_outbox_welcome_snapshot_complete check (
    delivery_kind <> 'welcome'
    or (subject_snapshot is not null and body_snapshot is not null and action_path_snapshot is not null)
  );

create table public.weekly_question_selection_policies (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  enabled boolean not null default false,
  cadence_days integer not null default 7 check (cadence_days between 1 and 31),
  minimum_pool_size integer not null default 3 check (minimum_pool_size between 1 and 100),
  selection_count integer not null default 1 check (selection_count between 1 and 10),
  priority_rule text not null default 'support_then_oldest'
    check (priority_rule = 'support_then_oldest'),
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_result jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, chapter_id),
  constraint weekly_question_selection_policy_chapter_scope
    foreign key (chapter_id, organization_id)
    references public.chapters(id, organization_id) on update cascade on delete restrict
);

create table public.organization_member_operational_profiles (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  member_number text,
  job_title text,
  department text,
  work_location text,
  hire_date date,
  membership_class text,
  preferred_language text check (preferred_language is null or preferred_language in ('en', 'es')),
  administrative_notes text,
  version integer not null default 1 check (version > 0),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, member_user_id),
  foreign key (organization_id, member_user_id)
    references public.organization_memberships(organization_id, user_id) on delete cascade,
  constraint member_operational_profile_number_bounded check (
    member_number is null or pg_catalog.char_length(member_number) between 1 and 80
  ),
  constraint member_operational_profile_title_bounded check (
    job_title is null or pg_catalog.char_length(job_title) between 1 and 160
  ),
  constraint member_operational_profile_department_bounded check (
    department is null or pg_catalog.char_length(department) between 1 and 160
  ),
  constraint member_operational_profile_location_bounded check (
    work_location is null or pg_catalog.char_length(work_location) between 1 and 200
  ),
  constraint member_operational_profile_class_bounded check (
    membership_class is null or pg_catalog.char_length(membership_class) between 1 and 120
  ),
  constraint member_operational_profile_notes_bounded check (
    administrative_notes is null or pg_catalog.char_length(administrative_notes) between 1 and 4000
  )
);
create unique index organization_member_operational_profiles_number_idx
  on public.organization_member_operational_profiles (organization_id, pg_catalog.lower(member_number))
  where member_number is not null;

create table public.organization_welcome_campaigns (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  name text not null,
  state text not null default 'draft' check (state in ('draft', 'active', 'paused', 'archived')),
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_welcome_campaigns_name_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 160
  ),
  unique (organization_id, id)
);
create index organization_welcome_campaigns_org_state_idx
  on public.organization_welcome_campaigns (organization_id, state, updated_at desc, id);

create table public.organization_welcome_campaign_steps (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  campaign_id uuid not null references public.organization_welcome_campaigns(id) on delete cascade,
  position integer not null check (position between 0 and 50),
  delay_days integer not null default 0 check (delay_days between 0 and 365),
  locale text not null default 'en' check (locale in ('en', 'es')),
  subject text not null,
  body text not null,
  active boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (campaign_id, position, locale),
  foreign key (organization_id, campaign_id)
    references public.organization_welcome_campaigns(organization_id, id) on delete cascade,
  constraint organization_welcome_campaign_steps_subject_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(subject)) between 1 and 200
  ),
  constraint organization_welcome_campaign_steps_body_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 10000
  )
);
create index organization_welcome_campaign_steps_campaign_idx
  on public.organization_welcome_campaign_steps (campaign_id, active, position, locale, id);

create table public.member_welcome_enrollments (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  campaign_id uuid not null references public.organization_welcome_campaigns(id) on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  state text not null default 'active' check (state in ('active', 'paused', 'completed', 'cancelled')),
  next_step_position integer not null default 0 check (next_step_position between 0 and 51),
  next_due_at timestamptz not null default pg_catalog.now(),
  enrolled_by uuid not null references auth.users(id) on delete restrict,
  enrolled_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  updated_at timestamptz not null default pg_catalog.now(),
  unique (campaign_id, member_user_id),
  foreign key (organization_id, campaign_id)
    references public.organization_welcome_campaigns(organization_id, id) on delete restrict,
  foreign key (organization_id, member_user_id)
    references public.organization_memberships(organization_id, user_id) on delete cascade
);
create index member_welcome_enrollments_due_idx
  on public.member_welcome_enrollments (state, next_due_at, organization_id, id)
  where state = 'active';

create table public.organization_import_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  kind text not null check (kind in ('member', 'grievance')),
  filename text not null,
  mapping jsonb not null default '{}'::jsonb,
  state text not null default 'uploaded' check (state in ('uploaded', 'validated', 'committed', 'failed', 'discarded')),
  row_count integer not null default 0 check (row_count between 0 and 500),
  valid_count integer not null default 0 check (valid_count between 0 and 500),
  error_count integer not null default 0 check (error_count between 0 and 500),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  validated_at timestamptz,
  committed_at timestamptz,
  discarded_at timestamptz,
  constraint organization_import_batches_filename_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(filename)) between 1 and 240
  ),
  constraint organization_import_batches_mapping_object check (
    pg_catalog.jsonb_typeof(mapping) = 'object'
  ),
  unique (organization_id, id)
);
create index organization_import_batches_org_created_idx
  on public.organization_import_batches (organization_id, created_at desc, id desc);

create table public.organization_import_rows (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  batch_id uuid not null references public.organization_import_batches(id) on delete cascade,
  row_number integer not null check (row_number between 1 and 500),
  normalized_data jsonb not null,
  validation_errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (batch_id, row_number),
  foreign key (organization_id, batch_id)
    references public.organization_import_batches(organization_id, id) on delete cascade,
  constraint organization_import_rows_data_object check (
    pg_catalog.jsonb_typeof(normalized_data) = 'object'
  ),
  constraint organization_import_rows_errors_array check (
    pg_catalog.jsonb_typeof(validation_errors) = 'array'
    and pg_catalog.jsonb_array_length(validation_errors) <= 32
  )
);

alter table public.weekly_question_selection_policies enable row level security;
alter table public.organization_member_operational_profiles enable row level security;
alter table public.organization_welcome_campaigns enable row level security;
alter table public.organization_welcome_campaign_steps enable row level security;
alter table public.member_welcome_enrollments enable row level security;
alter table public.organization_import_batches enable row level security;
alter table public.organization_import_rows enable row level security;

create policy mfa_assurance on public.weekly_question_selection_policies
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_member_operational_profiles
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_welcome_campaigns
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_welcome_campaign_steps
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.member_welcome_enrollments
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_import_batches
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_import_rows
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

revoke all on table public.weekly_question_selection_policies from public, anon, authenticated;
revoke all on table public.organization_member_operational_profiles from public, anon, authenticated;
revoke all on table public.organization_welcome_campaigns from public, anon, authenticated;
revoke all on table public.organization_welcome_campaign_steps from public, anon, authenticated;
revoke all on table public.member_welcome_enrollments from public, anon, authenticated;
revoke all on table public.organization_import_batches from public, anon, authenticated;
revoke all on table public.organization_import_rows from public, anon, authenticated;

grant all on table public.weekly_question_selection_policies to service_role;
grant all on table public.organization_member_operational_profiles to service_role;
grant all on table public.organization_welcome_campaigns to service_role;
grant all on table public.organization_welcome_campaign_steps to service_role;
grant all on table public.member_welcome_enrollments to service_role;
grant all on table public.organization_import_batches to service_role;
grant all on table public.organization_import_rows to service_role;

create function private.require_member_operations_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  return org;
end;
$function$;
revoke all on function private.require_member_operations_admin() from public, anon, authenticated, service_role;

create function private.member_operations_replay(
  p_organization_id uuid,
  p_operation text,
  p_idempotency_key uuid,
  p_request_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  cached private.mi1_w2_operation_receipts%rowtype;
begin
  if p_organization_id is null or p_idempotency_key is null
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_operation, ''))) not between 1 and 80 then
    raise exception 'operation key required' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operation || ':' || p_organization_id::text || ':' || p_idempotency_key::text,
    509
  ));
  select * into cached
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = p_organization_id
    and receipt.operation = p_operation
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached.request_payload is distinct from p_request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached.result;
  end if;
  return null;
end;
$function$;

create function private.member_operations_store_receipt(
  p_organization_id uuid,
  p_operation text,
  p_idempotency_key uuid,
  p_request_payload jsonb,
  p_result jsonb
)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (
    p_organization_id, p_operation, p_idempotency_key, p_request_payload, p_result
  )
$function$;

revoke all on function private.member_operations_replay(uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.member_operations_store_receipt(uuid, text, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;

create function private.member_reward_effect_enabled_in_organization(
  p_organization_id uuid,
  p_user_id uuid,
  p_effect_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_reward_grants grant_row
    join public.member_reward_items item on item.key = grant_row.item_key
    join public.organization_memberships membership
      on membership.organization_id = grant_row.organization_id
     and membership.user_id = grant_row.user_id
     and membership.status = 'active'
     and membership.revoked_at is null
    where grant_row.organization_id = p_organization_id
      and grant_row.user_id = p_user_id
      and grant_row.item_key = p_effect_key
      and grant_row.status in ('granted', 'shipped', 'delivered')
      and item.active
  )
$function$;

revoke all on function private.member_reward_effect_enabled_in_organization(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.list_weekly_question_editorial()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  caller_chapter text := private.current_member_chapter();
begin
  perform private.engagement_require_staff(org);
  if caller_chapter is null or not private.mi1_w2_same_org_chapter(org, caller_chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', q.id,
      'body', q.body,
      'options', q.options,
      'editorialState', q.editorial_state,
      'editorNote', q.editor_note,
      'weekStart', q.week_start,
      'score', coalesce(supports.score, 0),
      'publishedSurveyId', q.published_survey_id,
      'createdAt', q.created_at,
      'updatedAt', q.updated_at
    ) order by q.week_start desc, q.created_at, q.id)
    from (
      select source.*
      from public.member_weekly_questions source
      where source.chapter_id = caller_chapter
      order by source.week_start desc, source.created_at, source.id
      limit 500
    ) q
    left join lateral (
      select coalesce(pg_catalog.sum(case
        when private.member_reward_effect_enabled_in_organization(org, support.user_id, 'wq-boost-2x') then 2 else 1 end
      ), 0)::integer as score
      from public.member_weekly_question_supports support where support.question_id = q.id
    ) supports on true
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_weekly_question_editorial() from public, anon, authenticated, service_role;
grant execute on function public.list_weekly_question_editorial() to authenticated;

create function public.get_weekly_question_selection_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  chapter text := private.current_member_chapter();
  page jsonb;
begin
  perform private.engagement_require_staff(org);
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  page := public.list_weekly_question_selection_page('active', null, null, 26);
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', chapter,
    'policy', coalesce((
      select pg_catalog.to_jsonb(policy) - 'organization_id' - 'chapter_id' - 'updated_by'
      from public.weekly_question_selection_policies policy
      where policy.organization_id = org and policy.chapter_id = chapter
    ), pg_catalog.jsonb_build_object(
      'enabled', false, 'cadence_days', 7, 'minimum_pool_size', 3,
      'selection_count', 1, 'priority_rule', 'support_then_oldest'
    )),
    'items', coalesce(page -> 'items', '[]'::jsonb),
    'nextCursor', page -> 'nextCursor'
  );
end;
$function$;

create function public.list_weekly_question_selection_page(
  p_view text default 'active',
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 26
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  chapter text := private.current_member_chapter();
  cap integer := coalesce(p_limit, 26);
begin
  perform private.engagement_require_staff(org);
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  if p_view not in ('active','archive') or cap not between 1 and 50
     or (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'invalid weekly question page' using errcode = '22023';
  end if;
  return (
    with candidates as materialized (
      select question.*,
        coalesce((select pg_catalog.sum(case
          when private.member_reward_effect_enabled_in_organization(org, support.user_id, 'wq-boost-2x') then 2 else 1 end)
          from public.member_weekly_question_supports support
          where support.question_id = question.id), 0)::integer as support_score
      from public.member_weekly_questions question
      where question.chapter_id = chapter
        and case when p_view = 'active'
          then question.editorial_state in ('submitted','reserved')
          else question.editorial_state in ('published','archived') end
        and (p_before_created_at is null
          or (question.created_at, question.id) < (p_before_created_at, p_before_id))
      order by question.created_at desc, question.id desc
      limit cap + 1
    ), page as (
      select * from candidates order by created_at desc, id desc limit cap
    )
    select pg_catalog.jsonb_build_object(
      'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', page.id, 'body', page.body, 'options', page.options,
        'editorialState', page.editorial_state, 'editorNote', page.editor_note,
        'weekStart', page.week_start, 'score', page.support_score,
        'publishedSurveyId', page.published_survey_id,
        'createdAt', page.created_at, 'updatedAt', page.updated_at
      ) order by page.created_at desc, page.id desc) from page), '[]'::jsonb),
      'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then
        (select pg_catalog.jsonb_build_object('createdAt', page.created_at, 'id', page.id)
         from page order by page.created_at, page.id limit 1) else null end
    )
  );
end;
$function$;

create function public.save_weekly_question_selection_policy(
  p_enabled boolean,
  p_cadence_days integer,
  p_minimum_pool_size integer,
  p_selection_count integer,
  p_priority_rule text,
  p_next_run_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  chapter text := private.current_member_chapter();
  effective_next_run_at timestamptz;
begin
  perform private.engagement_require_staff(org);
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  if p_cadence_days not between 1 and 31
     or p_minimum_pool_size not between 1 and 100
     or p_selection_count not between 1 and 10
     or p_selection_count > p_minimum_pool_size
     or p_priority_rule <> 'support_then_oldest' then
    raise exception 'invalid weekly selection policy' using errcode = '22023';
  end if;
  effective_next_run_at := case
    when coalesce(p_enabled, false) then coalesce(
      p_next_run_at,
      pg_catalog.now() + pg_catalog.make_interval(days => p_cadence_days)
    )
    else null
  end;
  insert into public.weekly_question_selection_policies (
    organization_id, chapter_id, enabled, cadence_days, minimum_pool_size,
    selection_count, priority_rule, next_run_at, updated_by
  ) values (
    org, chapter, coalesce(p_enabled, false), p_cadence_days, p_minimum_pool_size,
    p_selection_count, p_priority_rule, effective_next_run_at, (select auth.uid())
  ) on conflict (organization_id, chapter_id) do update
    set enabled = excluded.enabled,
        cadence_days = excluded.cadence_days,
        minimum_pool_size = excluded.minimum_pool_size,
        selection_count = excluded.selection_count,
        priority_rule = excluded.priority_rule,
        next_run_at = excluded.next_run_at,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'status', case when p_enabled then 'enabled' else 'disabled' end,
    'reasonCode', 'weekly_selection_policy_saved', 'count', p_selection_count
  ));
  return public.get_weekly_question_selection_workspace();
end;
$function$;

create function public.run_weekly_question_selection(p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  chapter text := private.current_member_chapter();
  policy public.weekly_question_selection_policies%rowtype;
  pool_count integer;
  reserved_ids uuid[];
  request_payload jsonb;
  prior jsonb;
  result jsonb;
begin
  perform private.engagement_require_staff(org);
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter)
     or p_idempotency_key is null then
    raise exception 'invalid selection request' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object('chapterId', chapter);
  prior := private.member_operations_replay(org, 'weekly_question_selection', p_idempotency_key, request_payload);
  if prior is not null then return prior; end if;
  select * into policy from public.weekly_question_selection_policies
  where organization_id = org and chapter_id = chapter for update;
  if not found or not policy.enabled then
    raise exception 'weekly selection is disabled' using errcode = '55000';
  end if;
  select pg_catalog.count(*) into pool_count
  from public.member_weekly_questions question
  where question.chapter_id = chapter and question.editorial_state = 'submitted';
  if pool_count < policy.minimum_pool_size then
    raise exception 'minimum pool size not met' using errcode = '55000';
  end if;
  with ranked as (
    select question.id,
      coalesce((select pg_catalog.sum(case
        when private.member_reward_effect_enabled_in_organization(org, support.user_id, 'wq-boost-2x') then 2 else 1 end)
        from public.member_weekly_question_supports support where support.question_id = question.id), 0) as support_score,
      question.created_at
    from public.member_weekly_questions question
    where question.chapter_id = chapter and question.editorial_state = 'submitted'
    order by support_score desc, question.created_at asc, question.id asc
    for update skip locked
    limit policy.selection_count
  ), changed as (
    update public.member_weekly_questions question
    set editorial_state = 'reserved', updated_at = pg_catalog.now()
    from ranked where question.id = ranked.id
    returning question.id
  ) select coalesce(pg_catalog.array_agg(changed.id order by changed.id), '{}'::uuid[])
    into reserved_ids from changed;
  result := pg_catalog.jsonb_build_object(
    'selectedIds', pg_catalog.to_jsonb(reserved_ids), 'selectedCount', pg_catalog.cardinality(reserved_ids),
    'poolCount', pool_count, 'ranAt', pg_catalog.now()
  );
  update public.weekly_question_selection_policies
  set last_run_at = pg_catalog.now(), last_result = result,
      next_run_at = pg_catalog.now() + pg_catalog.make_interval(days => cadence_days),
      updated_by = (select auth.uid()), updated_at = pg_catalog.now()
  where organization_id = org and chapter_id = chapter;
  perform private.member_operations_store_receipt(
    org, 'weekly_question_selection', p_idempotency_key, request_payload, result
  );
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'status', 'reserved',
    'reasonCode', 'weekly_selection_run', 'count', pg_catalog.cardinality(reserved_ids)
  ));
  return result;
end;
$function$;

create function private.run_due_weekly_question_selections(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  cap integer := coalesce(p_limit, 25);
  target public.weekly_question_selection_policies%rowtype;
  pool_count integer;
  selected_ids uuid[];
  result jsonb;
  processed integer := 0;
  reserved integer := 0;
begin
  if cap not between 1 and 100 then
    raise exception 'invalid weekly scheduler limit' using errcode = '22023';
  end if;
  for target in
    select policy.*
    from public.weekly_question_selection_policies policy
    where policy.enabled and policy.next_run_at is not null
      and policy.next_run_at <= pg_catalog.now()
    order by policy.next_run_at, policy.organization_id, policy.chapter_id
    for update skip locked
    limit cap
  loop
    select pg_catalog.count(*) into pool_count
    from public.member_weekly_questions question
    where question.chapter_id = target.chapter_id and question.editorial_state = 'submitted';
    selected_ids := '{}'::uuid[];
    if pool_count >= target.minimum_pool_size then
      with ranked as (
        select question.id,
          coalesce((select pg_catalog.sum(case
            when private.member_reward_effect_enabled_in_organization(target.organization_id, support.user_id, 'wq-boost-2x') then 2 else 1 end)
            from public.member_weekly_question_supports support
            where support.question_id = question.id), 0) as support_score,
          question.created_at
        from public.member_weekly_questions question
        where question.chapter_id = target.chapter_id and question.editorial_state = 'submitted'
        order by support_score desc, question.created_at asc, question.id asc
        for update skip locked
        limit target.selection_count
      ), changed as (
        update public.member_weekly_questions question
        set editorial_state = 'reserved', updated_at = pg_catalog.now()
        from ranked where question.id = ranked.id
        returning question.id
      )
      select coalesce(pg_catalog.array_agg(changed.id order by changed.id), '{}'::uuid[])
      into selected_ids from changed;
    end if;
    result := pg_catalog.jsonb_build_object(
      'selectedIds', pg_catalog.to_jsonb(selected_ids),
      'selectedCount', pg_catalog.cardinality(selected_ids),
      'poolCount', pool_count,
      'ranAt', pg_catalog.now(),
      'mode', 'scheduled',
      'reason', case when pool_count < target.minimum_pool_size then 'minimum_pool_not_met' else null end
    );
    update public.weekly_question_selection_policies
    set last_run_at = pg_catalog.now(), last_result = result,
        next_run_at = pg_catalog.now() + pg_catalog.make_interval(days => cadence_days),
        updated_at = pg_catalog.now()
    where organization_id = target.organization_id and chapter_id = target.chapter_id;
    insert into public.organization_audit_events (
      organization_id, event_type, actor_user_id, idempotency_key, metadata
    ) values (
      target.organization_id, 'survey_draft_saved', null, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'organizationId', target.organization_id, 'chapterId', target.chapter_id,
        'status', 'reserved', 'reasonCode', 'weekly_selection_scheduled',
        'count', pg_catalog.cardinality(selected_ids)
      )
    );
    processed := processed + 1;
    reserved := reserved + pg_catalog.cardinality(selected_ids);
  end loop;
  return pg_catalog.jsonb_build_object('processed', processed, 'reserved', reserved);
end;
$function$;

revoke all on function private.run_due_weekly_question_selections(integer)
  from public, anon, authenticated, service_role;

do $scheduler$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'weekly-question-selection-tick';
    perform cron.schedule(
      'weekly-question-selection-tick',
      '17 * * * *',
      $job$select private.run_due_weekly_question_selections(25);$job$
    );
  end if;
end;
$scheduler$;

create function public.get_member_operations_directory(
  p_query text default null,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := coalesce(p_limit, 25);
begin
  if cap not between 1 and 50 or (needle <> '' and pg_catalog.char_length(needle) < 2) then
    raise exception 'invalid directory request' using errcode = '22023';
  end if;
  if (p_after_name is null) <> (p_after_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');
  return (
    with candidates as materialized (
      select profile.id, profile.full_name, profile.initials,
        located.chapter_id, located.chapter_name,
        private.organization_member_roles(profile.id, org, null) as roles,
        coalesce(operational.version, 0) as version,
        operational.updated_at,
        editor.full_name as updated_by_name,
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'memberNumber', operational.member_number, 'jobTitle', operational.job_title,
          'department', operational.department, 'workLocation', operational.work_location,
          'hireDate', operational.hire_date, 'membershipClass', operational.membership_class,
          'preferredLanguage', operational.preferred_language,
          'administrativeNotes', operational.administrative_notes
        )) as operational_profile
      from public.organization_memberships membership
      join public.member_profiles profile on profile.id = membership.user_id
      left join public.organization_member_operational_profiles operational
        on operational.organization_id = membership.organization_id and operational.member_user_id = membership.user_id
      left join public.member_profiles editor on editor.id = operational.updated_by
      left join lateral (
        select chapter.id as chapter_id, chapter.name as chapter_name
        from public.member_chapter_memberships chapter_membership
        join public.chapters chapter on chapter.id = chapter_membership.chapter_id and chapter.organization_id = org
        where chapter_membership.user_id = membership.user_id and chapter_membership.status = 'active'
        order by (chapter.id = profile.chapter_id) desc, chapter.order_index, chapter.id limit 1
      ) located on true
      where membership.organization_id = org and membership.status = 'active' and membership.revoked_at is null
        and (needle = '' or profile.full_name ilike '%' || needle || '%' escape '\')
        and (p_after_name is null or (profile.full_name, profile.id) > (p_after_name, p_after_id))
      order by profile.full_name, profile.id limit cap + 1
    ), page as (select * from candidates order by full_name, id limit cap)
    select pg_catalog.jsonb_build_object(
      'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', page.id, 'fullName', page.full_name, 'initials', page.initials,
        'chapterId', page.chapter_id, 'chapterName', page.chapter_name, 'roles', page.roles,
        'version', page.version, 'profile', page.operational_profile,
        'updatedAt', page.updated_at, 'updatedByName', page.updated_by_name
      ) order by page.full_name, page.id) from page), '[]'::jsonb),
      'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then
        (select pg_catalog.jsonb_build_object('name', page.full_name, 'id', page.id)
         from page order by page.full_name desc, page.id desc limit 1) else null end
    )
  );
end;
$function$;

create function public.get_member_operational_profile(p_member_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'userId', profile.id, 'fullName', profile.full_name, 'initials', profile.initials,
    'version', coalesce(operational.version, 0),
    'profile', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'memberNumber', operational.member_number, 'jobTitle', operational.job_title,
      'department', operational.department, 'workLocation', operational.work_location,
      'hireDate', operational.hire_date, 'membershipClass', operational.membership_class,
      'preferredLanguage', operational.preferred_language,
      'administrativeNotes', operational.administrative_notes
    )), 'updatedAt', operational.updated_at, 'updatedByName', editor.full_name
  ) into result
  from public.organization_memberships membership
  join public.member_profiles profile on profile.id = membership.user_id
  left join public.organization_member_operational_profiles operational
    on operational.organization_id = membership.organization_id and operational.member_user_id = membership.user_id
  left join public.member_profiles editor on editor.id = operational.updated_by
  where membership.organization_id = org and membership.user_id = p_member_user_id
    and membership.status = 'active' and membership.revoked_at is null;
  if result is null then raise exception 'not found' using errcode = 'P0002'; end if;
  return result;
end;
$function$;

create function public.save_member_operational_profile(
  p_member_user_id uuid,
  p_expected_version integer,
  p_fields jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  current_version integer;
  result jsonb;
  request_payload jsonb;
  prior jsonb;
  allowed text[] := array['memberNumber','jobTitle','department','workLocation','hireDate','membershipClass','preferredLanguage','administrativeNotes'];
begin
  if p_member_user_id is null or p_idempotency_key is null or pg_catalog.jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_fields) key where key <> all(allowed)) then
    raise exception 'invalid member record' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'memberUserId', p_member_user_id,
    'expectedVersion', coalesce(p_expected_version, 0),
    'fieldsSha256', pg_catalog.encode(extensions.digest(p_fields::text, 'sha256'), 'hex')
  );
  prior := private.member_operations_replay(
    org, 'save_member_operational_profile', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  if not exists (select 1 from public.organization_memberships membership
    where membership.organization_id = org and membership.user_id = p_member_user_id
      and membership.status = 'active' and membership.revoked_at is null) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select profile.version into current_version from public.organization_member_operational_profiles profile
  where profile.organization_id = org and profile.member_user_id = p_member_user_id for update;
  current_version := coalesce(current_version, 0);
  if current_version <> coalesce(p_expected_version, 0) then
    raise exception 'stale member record' using errcode = '40001';
  end if;
  insert into public.organization_member_operational_profiles (
    organization_id, member_user_id, member_number, job_title, department, work_location,
    hire_date, membership_class, preferred_language, administrative_notes, version, updated_by
  ) values (
    org, p_member_user_id,
    nullif(pg_catalog.btrim(p_fields ->> 'memberNumber'), ''),
    nullif(pg_catalog.btrim(p_fields ->> 'jobTitle'), ''),
    nullif(pg_catalog.btrim(p_fields ->> 'department'), ''),
    nullif(pg_catalog.btrim(p_fields ->> 'workLocation'), ''),
    nullif(p_fields ->> 'hireDate', '')::date,
    nullif(pg_catalog.btrim(p_fields ->> 'membershipClass'), ''),
    nullif(p_fields ->> 'preferredLanguage', ''),
    nullif(pg_catalog.btrim(p_fields ->> 'administrativeNotes'), ''),
    current_version + 1, (select auth.uid())
  ) on conflict (organization_id, member_user_id) do update
    set member_number = excluded.member_number, job_title = excluded.job_title,
        department = excluded.department, work_location = excluded.work_location,
        hire_date = excluded.hire_date, membership_class = excluded.membership_class,
        preferred_language = excluded.preferred_language,
        administrative_notes = excluded.administrative_notes,
        version = excluded.version, updated_by = excluded.updated_by, updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'member_profile_updated', pg_catalog.jsonb_build_object(
    'organizationId', org, 'userId', p_member_user_id, 'fields',
    (select coalesce(pg_catalog.jsonb_agg(key order by key), '[]'::jsonb) from pg_catalog.jsonb_object_keys(p_fields) key),
    'version', current_version + 1
  ));
  result := public.get_member_operational_profile(p_member_user_id);
  perform private.member_operations_store_receipt(
    org, 'save_member_operational_profile', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.bulk_update_member_operational_profiles(
  p_member_user_ids uuid[],
  p_field text,
  p_value text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  changed integer;
  request_payload jsonb;
  prior jsonb;
  result jsonb;
begin
  if p_idempotency_key is null or pg_catalog.cardinality(p_member_user_ids) < 1
     or pg_catalog.cardinality(p_member_user_ids) > 100
     or p_field not in ('department', 'workLocation', 'membershipClass', 'preferredLanguage')
     or pg_catalog.char_length(coalesce(p_value, '')) > 200 then
    raise exception 'invalid bulk member update' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'memberUserIds', pg_catalog.to_jsonb(p_member_user_ids), 'field', p_field, 'value', p_value
  );
  prior := private.member_operations_replay(
    org, 'bulk_update_member_operational_profiles', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  if exists (select 1 from pg_catalog.unnest(p_member_user_ids) target(user_id)
    where not exists (select 1 from public.organization_memberships membership
      where membership.organization_id = org and membership.user_id = target.user_id
        and membership.status = 'active' and membership.revoked_at is null)) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  insert into public.organization_member_operational_profiles (organization_id, member_user_id, updated_by)
  select org, target.user_id, (select auth.uid()) from pg_catalog.unnest(p_member_user_ids) target(user_id)
  on conflict (organization_id, member_user_id) do nothing;
  update public.organization_member_operational_profiles profile
  set department = case when p_field = 'department' then nullif(pg_catalog.btrim(p_value), '') else profile.department end,
      work_location = case when p_field = 'workLocation' then nullif(pg_catalog.btrim(p_value), '') else profile.work_location end,
      membership_class = case when p_field = 'membershipClass' then nullif(pg_catalog.btrim(p_value), '') else profile.membership_class end,
      preferred_language = case when p_field = 'preferredLanguage' then nullif(p_value, '') else profile.preferred_language end,
      version = profile.version + 1, updated_by = (select auth.uid()), updated_at = pg_catalog.now()
  where profile.organization_id = org and profile.member_user_id = any(p_member_user_ids);
  get diagnostics changed = row_count;
  perform private.mi1_w2_write_audit(org, 'member_profiles_bulk_updated', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fields', pg_catalog.jsonb_build_array(p_field), 'count', changed
  ));
  result := pg_catalog.jsonb_build_object('updatedCount', changed, 'field', p_field);
  perform private.member_operations_store_receipt(
    org, 'bulk_update_member_operational_profiles', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.list_member_handoffs_v2(
  p_query text default null,
  p_status text default null,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor uuid := (select auth.uid());
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  cap integer := coalesce(p_limit, 20);
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.mi1_w2_handoff_can_initiate(org)
     and not private.mi1_w2_handoff_can_oversee(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if cap not between 1 and 50 or (p_status is not null and p_status not in ('pending','acknowledged','declined','cancelled'))
     or (p_before_created_at is null) <> (p_before_id is null) or pg_catalog.char_length(coalesce(needle, '')) > 100 then
    raise exception 'invalid handoff list request' using errcode = '22023';
  end if;
  return (
    with candidates as materialized (
      select handoff.*, member.full_name as member_name,
        coalesce(from_profile.full_name, 'Unassigned') as from_name,
        to_profile.full_name as to_name
      from public.member_handoffs handoff
      join public.member_profiles member on member.id = handoff.member_user_id
      left join public.member_profiles from_profile on from_profile.id = handoff.from_steward_id
      join public.member_profiles to_profile on to_profile.id = handoff.to_steward_id
      where handoff.organization_id = org and private.mi1_w2_handoff_visible(org, handoff)
        and (p_status is null or handoff.status = p_status)
        and (needle is null or member.full_name ilike '%' || needle || '%' or to_profile.full_name ilike '%' || needle || '%')
        and (p_before_created_at is null or (handoff.created_at, handoff.id) < (p_before_created_at, p_before_id))
      order by handoff.created_at desc, handoff.id desc limit cap + 1
    ), page as (select * from candidates order by created_at desc, id desc limit cap)
    select pg_catalog.jsonb_build_object(
      'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', page.id, 'memberId', page.member_user_id, 'memberName', page.member_name,
        'fromStewardId', page.from_steward_id, 'fromStewardName', page.from_name,
        'toStewardId', page.to_steward_id, 'toStewardName', page.to_name,
        'direction', case when page.to_steward_id = actor then 'incoming' when page.initiated_by = actor or page.from_steward_id = actor then 'outgoing' else 'overseen' end,
        'status', page.status, 'note', page.note, 'createdAt', page.created_at,
        'acknowledgedAt', page.acknowledged_at, 'resolvedAt', page.resolved_at,
        'canAcknowledge', page.status = 'pending' and page.to_steward_id = actor,
        'canDecline', page.status = 'pending' and page.to_steward_id = actor,
        'canCancel', page.status = 'pending' and (
          page.initiated_by = actor or private.mi1_w2_handoff_can_oversee(org)
        )
      ) order by page.created_at desc, page.id desc) from page), '[]'::jsonb),
      'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then
        (select pg_catalog.jsonb_build_object('createdAt', page.created_at, 'id', page.id)
         from page order by page.created_at, page.id limit 1) else null end
    )
  );
end;
$function$;

create function public.search_handoff_members(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if not private.mfa_satisfied() or not private.mi1_w2_handoff_can_initiate(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) < 2 or pg_catalog.char_length(needle) > 100 then
    raise exception 'invalid search' using errcode = '22023';
  end if;
  return coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'userId', candidate.id, 'displayName', candidate.full_name
  ) order by candidate.full_name, candidate.id)
  from (
    select profile.id, profile.full_name
    from public.organization_memberships membership
    join public.member_profiles profile on profile.id = membership.user_id
    join public.member_chapter_memberships chapter_membership
      on chapter_membership.user_id = membership.user_id
      and chapter_membership.chapter_id = chapter
      and chapter_membership.status = 'active'
    where membership.organization_id = org and membership.status = 'active'
      and pg_catalog.strpos(pg_catalog.lower(profile.full_name), pg_catalog.lower(needle)) > 0
    order by profile.full_name, profile.id
    limit 20
  ) candidate), '[]'::jsonb);
end;
$function$;

create or replace function private.mi1_w2_handoff_visible(
  p_org uuid,
  p_handoff public.member_handoffs
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_handoff.organization_id = p_org
    and (
      p_handoff.initiated_by = (select auth.uid())
      or p_handoff.to_steward_id = (select auth.uid())
      or p_handoff.from_steward_id = (select auth.uid())
      or private.mi1_w2_handoff_can_oversee(p_org)
    )
$function$;

create or replace function private.mi1_w2_resolve_handoff(p_handoff_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  handoff public.member_handoffs%rowtype;
  actor uuid := (select auth.uid());
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into handoff from public.member_handoffs where id = p_handoff_id for update;
  if not found
     or handoff.organization_id is distinct from org
     or not private.mi1_w2_handoff_visible(org, handoff) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_action in ('acknowledged', 'declined') and handoff.to_steward_id is distinct from actor then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action = 'cancelled'
     and handoff.initiated_by is distinct from actor
     and not private.mi1_w2_handoff_can_oversee(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if handoff.status = p_action then
    return pg_catalog.jsonb_build_object('id', handoff.id, 'status', handoff.status, 'kind', 'reuse');
  end if;
  if handoff.status <> 'pending' then
    raise exception 'This handoff is no longer pending.' using errcode = 'P0001';
  end if;
  update public.member_handoffs
  set status = p_action,
      acknowledged_at = case when p_action = 'acknowledged' then pg_catalog.now() else null end,
      resolved_at = pg_catalog.now()
  where id = handoff.id;
  if p_action = 'acknowledged' then
    insert into public.member_steward_relationships (
      organization_id, chapter_id, member_user_id, steward_user_id
    ) values (
      org, handoff.chapter_id, handoff.member_user_id, handoff.to_steward_id
    )
    on conflict (organization_id, chapter_id, member_user_id) do update
      set steward_user_id = excluded.steward_user_id,
          updated_at = pg_catalog.now();
  end if;
  perform private.mi1_w2_write_audit(org, 'member_handoff_' || p_action, pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', handoff.chapter_id,
    'userId', handoff.member_user_id, 'status', p_action,
    'handoffId', handoff.id, 'fromStewardId', handoff.from_steward_id,
    'toStewardId', handoff.to_steward_id
  ));
  return pg_catalog.jsonb_build_object('id', handoff.id, 'status', p_action, 'kind', p_action);
end;
$function$;

create function public.list_welcome_campaign_enrollments(
  p_campaign_id uuid,
  p_before_enrolled_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  cap integer := coalesce(p_limit, 10);
begin
  if cap not between 1 and 50 or (p_before_enrolled_at is null) <> (p_before_id is null)
     or not exists (select 1 from public.organization_welcome_campaigns campaign
       where campaign.id = p_campaign_id and campaign.organization_id = org) then
    raise exception 'invalid welcome enrollment page' using errcode = '22023';
  end if;
  return (
    with candidates as materialized (
      select enrollment.*, profile.full_name as member_name
      from public.member_welcome_enrollments enrollment
      join public.member_profiles profile on profile.id = enrollment.member_user_id
      where enrollment.campaign_id = p_campaign_id and enrollment.organization_id = org
        and (p_before_enrolled_at is null
          or (enrollment.enrolled_at, enrollment.id) < (p_before_enrolled_at, p_before_id))
      order by enrollment.enrolled_at desc, enrollment.id desc
      limit cap + 1
    ), page as (
      select * from candidates order by enrolled_at desc, id desc limit cap
    )
    select pg_catalog.jsonb_build_object(
      'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', page.id, 'memberUserId', page.member_user_id,
        'memberName', page.member_name, 'state', page.state,
        'nextStepPosition', page.next_step_position, 'nextDueAt', page.next_due_at,
        'enrolledAt', page.enrolled_at,
        'deliveries', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', outbox.id, 'state', outbox.state, 'attemptCount', outbox.attempt_count,
          'createdAt', outbox.created_at, 'sentAt', outbox.sent_at,
          'errorCode', outbox.last_error_code
        ) order by outbox.created_at desc, outbox.id desc)
        from public.engagement_delivery_outbox outbox
        where outbox.organization_id = org and outbox.source_kind = 'welcome_campaign'
          and pg_catalog.split_part(outbox.source_id, ':', 1) = page.id::text), '[]'::jsonb)
      ) order by page.enrolled_at desc, page.id desc) from page), '[]'::jsonb),
      'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then
        (select pg_catalog.jsonb_build_object('enrolledAt', page.enrolled_at, 'id', page.id)
         from page order by page.enrolled_at, page.id limit 1) else null end
    )
  );
end;
$function$;

create function public.get_welcome_campaign_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
begin
  return pg_catalog.jsonb_build_object(
    'campaigns', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', campaign.id, 'name', campaign.name, 'state', campaign.state,
      'steps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', step.id, 'position', step.position, 'delayDays', step.delay_days,
        'locale', step.locale, 'subject', step.subject, 'body', step.body, 'active', step.active
      ) order by step.position, step.locale, step.id) from public.organization_welcome_campaign_steps step
      where step.campaign_id = campaign.id), '[]'::jsonb),
      'enrollments', coalesce(enrollment_page.payload -> 'items', '[]'::jsonb),
      'enrollmentNextCursor', enrollment_page.payload -> 'nextCursor'
    ) order by campaign.updated_at desc, campaign.id desc)
    from (
      select source.* from public.organization_welcome_campaigns source
      where source.organization_id = org
      order by source.updated_at desc, source.id desc limit 50
    ) campaign
    cross join lateral (
      select public.list_welcome_campaign_enrollments(campaign.id, null, null, 10) payload
    ) enrollment_page
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.save_welcome_campaign(
  p_campaign_id uuid,
  p_name text,
  p_state text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  saved uuid;
  request_payload jsonb;
  prior jsonb;
  result jsonb;
begin
  if p_idempotency_key is null or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 1 and 160
     or p_state not in ('draft','active','paused','archived') then
    raise exception 'invalid welcome campaign' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'campaignId', p_campaign_id, 'name', pg_catalog.btrim(p_name), 'state', p_state
  );
  prior := private.member_operations_replay(
    org, 'save_welcome_campaign', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  if p_campaign_id is null then
    insert into public.organization_welcome_campaigns (organization_id, name, state, created_by, updated_by)
    values (org, pg_catalog.btrim(p_name), p_state, (select auth.uid()), (select auth.uid())) returning id into saved;
  else
    update public.organization_welcome_campaigns set name = pg_catalog.btrim(p_name), state = p_state,
      updated_by = (select auth.uid()), updated_at = pg_catalog.now()
    where id = p_campaign_id and organization_id = org returning id into saved;
    if saved is null then raise exception 'not found' using errcode = 'P0002'; end if;
  end if;
  perform private.mi1_w2_write_audit(org, 'welcome_campaign_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'campaignId', saved, 'status', p_state
  ));
  result := pg_catalog.jsonb_build_object('id', saved, 'state', p_state);
  perform private.member_operations_store_receipt(
    org, 'save_welcome_campaign', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.save_welcome_campaign_step(
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
  result := pg_catalog.jsonb_build_object('id', saved, 'campaignId', p_campaign_id);
  perform private.member_operations_store_receipt(
    org, 'save_welcome_campaign_step', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.enroll_member_in_welcome_campaign(
  p_campaign_id uuid,
  p_member_user_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  result := pg_catalog.jsonb_build_object('id', saved.id, 'state', saved.state);
  perform private.member_operations_store_receipt(
    org, 'enroll_member_in_welcome_campaign', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.transition_member_welcome_enrollment(
  p_enrollment_id uuid,
  p_state text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  request_payload jsonb;
  prior jsonb;
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
  update public.member_welcome_enrollments set state = p_state, updated_at = pg_catalog.now()
  where id = p_enrollment_id and organization_id = org and state <> 'completed';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  result := pg_catalog.jsonb_build_object('id', p_enrollment_id, 'state', p_state);
  perform private.member_operations_store_receipt(
    org, 'transition_member_welcome_enrollment', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.queue_due_welcome_messages(p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  queued integer := 0;
  enrollment record;
  step_row public.organization_welcome_campaign_steps%rowtype;
  following_position integer;
  following_delay integer;
  member_locale text;
  request_payload jsonb := '{}'::jsonb;
  prior jsonb;
  result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'queue_due_welcome_messages', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  for enrollment in
    select active.* from public.member_welcome_enrollments active
    join public.organization_welcome_campaigns campaign
      on campaign.id = active.campaign_id and campaign.organization_id = active.organization_id
    join public.organization_memberships membership
      on membership.organization_id = active.organization_id
      and membership.user_id = active.member_user_id
    where active.organization_id = org and active.state = 'active' and active.next_due_at <= pg_catalog.now()
      and campaign.state = 'active' and membership.status = 'active' and membership.revoked_at is null
    order by active.next_due_at, active.id for update skip locked limit 100
  loop
    select coalesce(operational.preferred_language, profile.language, 'en')
    into member_locale
    from public.member_profiles profile
    left join public.organization_member_operational_profiles operational
      on operational.organization_id = org
     and operational.member_user_id = profile.id
    where profile.id = enrollment.member_user_id;
    select * into step_row from public.organization_welcome_campaign_steps step
    where step.campaign_id = enrollment.campaign_id and step.organization_id = org
      and step.position = enrollment.next_step_position and step.active
    order by case when step.locale = member_locale then 0 else 1 end,
      step.locale, step.id limit 1;
    if not found then
      select next_step.position, next_step.delay_days
      into following_position, following_delay
      from public.organization_welcome_campaign_steps next_step
      where next_step.campaign_id = enrollment.campaign_id
        and next_step.organization_id = org
        and next_step.active
        and next_step.position > enrollment.next_step_position
        and next_step.position = (
          select pg_catalog.min(candidate.position)
          from public.organization_welcome_campaign_steps candidate
          where candidate.campaign_id = enrollment.campaign_id
            and candidate.organization_id = org
            and candidate.active
            and candidate.position > enrollment.next_step_position
        )
      order by case when next_step.locale = member_locale then 0 else 1 end,
        next_step.locale,
        next_step.id
      limit 1;
      if following_position is null then
        update public.member_welcome_enrollments
        set state = 'completed', completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where id = enrollment.id and organization_id = org;
      else
        update public.member_welcome_enrollments
        set next_step_position = following_position,
            next_due_at = enrollment.enrolled_at + pg_catalog.make_interval(days => following_delay),
            updated_at = pg_catalog.now()
        where id = enrollment.id and organization_id = org;
      end if;
      continue;
    end if;
    insert into public.engagement_delivery_outbox (
      organization_id, recipient_user_id, delivery_kind, source_kind, source_id, locale,
      subject_snapshot, body_snapshot, action_path_snapshot
    ) values (
      org, enrollment.member_user_id, 'welcome', 'welcome_campaign',
      enrollment.id::text || ':' || step_row.id::text, step_row.locale,
      step_row.subject, step_row.body, '/m/support?welcome=' || enrollment.id::text
    ) on conflict (delivery_kind, source_id, recipient_user_id) do nothing;
    if found then queued := queued + 1; end if;
    select next_step.position, next_step.delay_days
    into following_position, following_delay
    from public.organization_welcome_campaign_steps next_step
    where next_step.campaign_id = enrollment.campaign_id and next_step.organization_id = org
      and next_step.active and next_step.position > enrollment.next_step_position
      and next_step.position = (select pg_catalog.min(candidate.position)
        from public.organization_welcome_campaign_steps candidate
        where candidate.campaign_id = enrollment.campaign_id and candidate.organization_id = org
          and candidate.active and candidate.position > enrollment.next_step_position)
    order by case when next_step.locale = member_locale then 0 else 1 end,
      next_step.locale,
      next_step.id
    limit 1;
    if following_position is null then
      update public.member_welcome_enrollments
      set state = 'completed', completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
      where id = enrollment.id and organization_id = org;
    else
      update public.member_welcome_enrollments
      set next_step_position = following_position,
          next_due_at = enrollment.enrolled_at + pg_catalog.make_interval(days => following_delay),
          updated_at = pg_catalog.now()
      where id = enrollment.id and organization_id = org;
    end if;
  end loop;
  perform private.mi1_w2_write_audit(org, 'welcome_messages_queued', pg_catalog.jsonb_build_object(
    'organizationId', org, 'count', queued, 'status', 'queued'
  ));
  result := pg_catalog.jsonb_build_object('queuedCount', queued);
  perform private.member_operations_store_receipt(
    org, 'queue_due_welcome_messages', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.list_member_import_batches(
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  cap integer := coalesce(p_limit, 10);
begin
  if cap not between 1 and 50 or (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'invalid import batch page' using errcode = '22023';
  end if;
  return (
    with candidates as materialized (
      select source.* from public.organization_import_batches source
      where source.organization_id = org
        and (p_before_created_at is null
          or (source.created_at, source.id) < (p_before_created_at, p_before_id))
      order by source.created_at desc, source.id desc limit cap + 1
    ), page as (
      select * from candidates order by created_at desc, id desc limit cap
    )
    select pg_catalog.jsonb_build_object(
      'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', page.id, 'kind', page.kind, 'state', page.state, 'filename', page.filename,
        'mapping', page.mapping, 'rowCount', page.row_count, 'validCount', page.valid_count,
        'errorCount', page.error_count, 'createdAt', page.created_at, 'committedAt', page.committed_at,
        'errors', coalesce((select pg_catalog.jsonb_agg(error_item.payload order by error_item.row_number)
          from (
            select row.row_number, pg_catalog.jsonb_build_object(
              'rowNumber', row.row_number, 'field', error ->> 'field',
              'code', error ->> 'code', 'message', error ->> 'message'
            ) payload
            from public.organization_import_rows row
            cross join lateral pg_catalog.jsonb_array_elements(row.validation_errors) error
            where row.batch_id = page.id and row.organization_id = org
            order by row.row_number limit 100
          ) error_item), '[]'::jsonb)
      ) order by page.created_at desc, page.id desc) from page), '[]'::jsonb),
      'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then
        (select pg_catalog.jsonb_build_object('createdAt', page.created_at, 'id', page.id)
         from page order by page.created_at, page.id limit 1) else null end
    )
  );
end;
$function$;

create function public.get_member_import_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  perform private.require_member_operations_admin();
  return coalesce(public.list_member_import_batches(null, null, 10) -> 'items', '[]'::jsonb);
end;
$function$;

create function public.stage_member_operations_import(
  p_kind text,
  p_filename text,
  p_mapping jsonb,
  p_rows jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  created_batch_id uuid;
  request_payload jsonb;
  prior jsonb;
  result jsonb;
  allowed_fields text[];
begin
  if p_idempotency_key is null or p_kind not in ('member','grievance')
     or pg_catalog.jsonb_typeof(p_mapping) <> 'object'
     or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_mapping)) > 64
     or pg_catalog.octet_length(pg_catalog.convert_to(p_mapping::text, 'UTF8')) > 65536
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_mapping) key
       where pg_catalog.char_length(key) > 200)
     or pg_catalog.jsonb_typeof(p_rows) <> 'array' or pg_catalog.jsonb_array_length(p_rows) < 1
     or pg_catalog.jsonb_array_length(p_rows) > 500
     or pg_catalog.octet_length(pg_catalog.convert_to(p_rows::text, 'UTF8')) > 2097152
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_filename, ''))) not between 1 and 240 then
    raise exception 'import kind must be member or grievance and contain 1 to 500 rows' using errcode = '22023';
  end if;
  allowed_fields := case when p_kind = 'member' then array[
    'member_id','email','member_number','job_title','department','work_location',
    'hire_date','membership_class','preferred_language','administrative_notes'
  ] else array[
    'member_id','member_email','chapter_id','reference','title','deadline','articles'
  ] end;
  if exists (
      select 1 from pg_catalog.jsonb_each_text(p_mapping) mapped
      where mapped.value <> '' and mapped.value <> all(allowed_fields)
    ) or (
      select pg_catalog.count(*) from pg_catalog.jsonb_each_text(p_mapping) mapped where mapped.value <> ''
    ) <> (
      select pg_catalog.count(distinct mapped.value) from pg_catalog.jsonb_each_text(p_mapping) mapped where mapped.value <> ''
    ) or not exists (
      select 1 from pg_catalog.jsonb_each_text(p_mapping) mapped
      where mapped.value in ('member_id', case when p_kind = 'member' then 'email' else 'member_email' end)
    ) or (p_kind = 'grievance' and exists (
      select required.field from pg_catalog.unnest(array['chapter_id','reference','title']) required(field)
      where not exists (select 1 from pg_catalog.jsonb_each_text(p_mapping) mapped where mapped.value = required.field)
    )) then
    raise exception 'import mapping is incomplete, duplicated, or unsupported' using errcode = '22023';
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_rows) item(value)
       where pg_catalog.jsonb_typeof(item.value) <> 'object')
     or (select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(p_rows) item(value)
      cross join lateral pg_catalog.jsonb_object_keys(case
        when pg_catalog.jsonb_typeof(item.value) = 'object' then item.value else '{}'::jsonb end)) > 10000
     or exists (
       select 1
       from pg_catalog.jsonb_array_elements(p_rows) item(value)
       cross join lateral pg_catalog.jsonb_each(case
         when pg_catalog.jsonb_typeof(item.value) = 'object' then item.value else '{}'::jsonb end) cell
       where cell.key <> all(allowed_fields)
          or pg_catalog.jsonb_typeof(cell.value) not in ('string','null')
          or pg_catalog.char_length(coalesce(cell.value #>> '{}', '')) > 10000
     ) then
    raise exception 'import rows exceed the bounded allowlist' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'kind', p_kind,
    'filename', pg_catalog.btrim(p_filename),
    'mapping', p_mapping,
    'rowCount', pg_catalog.jsonb_array_length(p_rows),
    'rowsSha256', pg_catalog.encode(extensions.digest(p_rows::text, 'sha256'), 'hex')
  );
  prior := private.member_operations_replay(
    org, 'stage_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  insert into public.organization_import_batches (
    organization_id, kind, filename, mapping, row_count, created_by
  ) values (org, p_kind, pg_catalog.btrim(p_filename), p_mapping, pg_catalog.jsonb_array_length(p_rows), (select auth.uid()))
  returning id into created_batch_id;
  insert into public.organization_import_rows (organization_id, batch_id, row_number, normalized_data)
  select org, created_batch_id, item.ordinality::integer, item.value
  from pg_catalog.jsonb_array_elements(p_rows) with ordinality item(value, ordinality)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(item.value)) <= 64;
  if (select pg_catalog.count(*) from public.organization_import_rows row where row.batch_id = created_batch_id)
     <> pg_catalog.jsonb_array_length(p_rows) then
    raise exception 'every import row must be a bounded object' using errcode = '22023';
  end if;
  result := pg_catalog.jsonb_build_object(
    'id', created_batch_id, 'state', 'uploaded', 'rowCount', pg_catalog.jsonb_array_length(p_rows)
  );
  perform private.member_operations_store_receipt(
    org, 'stage_member_operations_import', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.validate_member_operations_import(
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  batch public.organization_import_batches%rowtype;
  row_item public.organization_import_rows%rowtype;
  errors jsonb;
  member_id uuid;
  raw_member_id text;
  raw_hire_date text;
  raw_deadline text;
  valid_rows integer;
  invalid_rows integer;
  request_payload jsonb := pg_catalog.jsonb_build_object('batchId', p_batch_id);
  prior jsonb;
  result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'validate_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  select * into batch from public.organization_import_batches where id = p_batch_id and organization_id = org for update;
  if not found or batch.state in ('committed','discarded') then raise exception 'batch is not editable' using errcode = '55000'; end if;
  for row_item in select * from public.organization_import_rows row where row.batch_id = batch.id order by row.row_number
  loop
    errors := '[]'::jsonb;
    member_id := null;
    raw_member_id := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'member_id', '')), '');
    if raw_member_id is not null then
      if raw_member_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        member_id := raw_member_id::uuid;
      else
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'field','member_id','code','invalid_uuid','message','Member ID must be a UUID'
        ));
      end if;
    end if;
    if member_id is null and coalesce(row_item.normalized_data ->> 'email', row_item.normalized_data ->> 'member_email') is not null then
      select membership.user_id into member_id
      from public.organization_memberships membership join auth.users user_row on user_row.id = membership.user_id
      where membership.organization_id = org and membership.status = 'active'
        and pg_catalog.lower(user_row.email) = pg_catalog.lower(coalesce(row_item.normalized_data ->> 'email', row_item.normalized_data ->> 'member_email'))
      limit 1;
    end if;
    if member_id is null or not exists (select 1 from public.organization_memberships membership
      where membership.organization_id = org and membership.user_id = member_id and membership.status = 'active') then
      errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member','code','member_not_found','message','Existing active member not found'));
    end if;
    if batch.kind = 'member' then
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'member_number', '')) > 80 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member_number','code','too_long','message','Member number is limited to 80 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'job_title', '')) > 160 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','job_title','code','too_long','message','Job title is limited to 160 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'department', '')) > 160 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','department','code','too_long','message','Department is limited to 160 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'work_location', '')) > 200 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','work_location','code','too_long','message','Work location is limited to 200 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'membership_class', '')) > 120 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','membership_class','code','too_long','message','Membership classification is limited to 120 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'administrative_notes', '')) > 4000 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','administrative_notes','code','too_long','message','Administrative notes are limited to 4,000 characters'));
      end if;
      if nullif(row_item.normalized_data ->> 'preferred_language', '') is not null
         and row_item.normalized_data ->> 'preferred_language' not in ('en','es') then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','preferred_language','code','invalid_language','message','Preferred language must be en or es'));
      end if;
      raw_hire_date := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'hire_date', '')), '');
      if raw_hire_date is not null then
        begin
          perform raw_hire_date::date;
        exception when others then
          errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','hire_date','code','invalid_date','message','Hire date must be a valid date'));
        end;
      end if;
      if nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'member_number', '')), '') is not null and (
        exists (
          select 1 from public.organization_import_rows duplicate_row
          where duplicate_row.batch_id = batch.id and duplicate_row.row_number <> row_item.row_number
            and pg_catalog.lower(pg_catalog.btrim(duplicate_row.normalized_data ->> 'member_number'))
              = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'))
        ) or exists (
          select 1 from public.organization_member_operational_profiles profile
          where profile.organization_id = org and profile.member_user_id is distinct from member_id
            and pg_catalog.lower(profile.member_number) = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'))
        )
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member_number','code','duplicate','message','Member number must be unique'));
      end if;
    else
      if pg_catalog.char_length(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'title', ''))) not between 1 and 200 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','title','code','invalid_title','message','Title is required and limited to 200 characters'));
      end if;
      if pg_catalog.char_length(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'reference', ''))) not between 1 and 120 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','reference','code','invalid_reference','message','Reference is required and limited to 120 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'articles', '')) > 500 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','articles','code','too_long','message','Articles are limited to 500 characters'));
      end if;
      if not exists (select 1 from public.chapters chapter where chapter.id = row_item.normalized_data ->> 'chapter_id' and chapter.organization_id = org) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','chapter_id','code','chapter_not_found','message','Chapter not found'));
      end if;
      if member_id is not null and not exists (
        select 1
        from public.member_profiles profile
        where profile.id = member_id
          and profile.chapter_id = row_item.normalized_data ->> 'chapter_id'
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'field','chapter_id','code','case_owner_chapter_mismatch',
          'message','Grievance chapter must match the member case-owning chapter'
        ));
      end if;
      raw_deadline := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'deadline', '')), '');
      if raw_deadline is not null then
        begin
          perform raw_deadline::date;
          if raw_deadline::date < current_date - 3650 or raw_deadline::date > current_date + 3650 then
            errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','deadline','code','out_of_range','message','Deadline must be within 10 years'));
          end if;
        exception when others then
          errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','deadline','code','invalid_date','message','Deadline must be a valid date'));
        end;
      end if;
      if member_id is not null and nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'reference', '')), '') is not null and (
        exists (
          select 1 from public.organization_import_rows duplicate_row
          where duplicate_row.batch_id = batch.id and duplicate_row.row_number <> row_item.row_number
            and duplicate_row.normalized_data ->> '_resolved_member_id' = member_id::text
            and pg_catalog.lower(pg_catalog.btrim(duplicate_row.normalized_data ->> 'reference'))
              = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'reference'))
        ) or exists (
          select 1 from public.member_cases existing_case
          where existing_case.user_id = member_id
            and pg_catalog.lower(existing_case.reference) = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'reference'))
        )
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','reference','code','duplicate','message','Reference already exists for this member'));
      end if;
    end if;
    update public.organization_import_rows set normalized_data = normalized_data || pg_catalog.jsonb_build_object('_resolved_member_id', member_id),
      validation_errors = errors where batch_id = batch.id and row_number = row_item.row_number;
  end loop;
  select pg_catalog.count(*) filter (where pg_catalog.jsonb_array_length(row.validation_errors) = 0),
    pg_catalog.count(*) filter (where pg_catalog.jsonb_array_length(row.validation_errors) > 0)
  into valid_rows, invalid_rows from public.organization_import_rows row where row.batch_id = batch.id;
  update public.organization_import_batches set state = 'validated', valid_count = valid_rows, error_count = invalid_rows,
    validated_at = pg_catalog.now() where id = batch.id;
  result := pg_catalog.jsonb_build_object(
    'id', batch.id, 'state', 'validated', 'validCount', valid_rows, 'errorCount', invalid_rows
  );
  perform private.member_operations_store_receipt(
    org, 'validate_member_operations_import', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.commit_member_operations_import(
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  batch public.organization_import_batches%rowtype;
  imported integer := 0;
  row_item public.organization_import_rows%rowtype;
  request_payload jsonb := pg_catalog.jsonb_build_object('batchId', p_batch_id);
  prior jsonb;
  result jsonb;
  validation_result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'commit_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  select * into batch from public.organization_import_batches where id = p_batch_id and organization_id = org for update;
  if not found or batch.state <> 'validated' then raise exception 'batch must be validated' using errcode = '55000'; end if;
  validation_result := public.validate_member_operations_import(batch.id, extensions.gen_random_uuid());
  select * into batch from public.organization_import_batches
  where id = p_batch_id and organization_id = org for update;
  if batch.error_count > 0 or exists (select 1 from public.organization_import_rows row
    where row.batch_id = batch.id and row.organization_id = org
      and pg_catalog.jsonb_array_length(row.validation_errors) > 0) then
    result := validation_result || pg_catalog.jsonb_build_object(
      'state', 'validated', 'committed', false, 'reason', 'revalidation_failed'
    );
    perform private.member_operations_store_receipt(
      org, 'commit_member_operations_import', p_idempotency_key, request_payload, result
    );
    return result;
  end if;
  for row_item in select * from public.organization_import_rows row where row.batch_id = batch.id order by row.row_number for update
  loop
    if batch.kind = 'member' then
      insert into public.organization_member_operational_profiles as existing_profile (
        organization_id, member_user_id, member_number, job_title, department, work_location,
        hire_date, membership_class, preferred_language, administrative_notes, updated_by
      ) values (
        org, (row_item.normalized_data ->> '_resolved_member_id')::uuid,
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'), ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'job_title'), ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'department'), ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'work_location'), ''),
        nullif(row_item.normalized_data ->> 'hire_date', '')::date,
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'membership_class'), ''),
        nullif(row_item.normalized_data ->> 'preferred_language', ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'administrative_notes'), ''),
        (select auth.uid())
      ) on conflict (organization_id, member_user_id) do update
        set member_number = case when row_item.normalized_data ? 'member_number'
              then excluded.member_number else existing_profile.member_number end,
            job_title = case when row_item.normalized_data ? 'job_title'
              then excluded.job_title else existing_profile.job_title end,
            department = case when row_item.normalized_data ? 'department'
              then excluded.department else existing_profile.department end,
            work_location = case when row_item.normalized_data ? 'work_location'
              then excluded.work_location else existing_profile.work_location end,
            hire_date = case when row_item.normalized_data ? 'hire_date'
              then excluded.hire_date else existing_profile.hire_date end,
            membership_class = case when row_item.normalized_data ? 'membership_class'
              then excluded.membership_class else existing_profile.membership_class end,
            preferred_language = case when row_item.normalized_data ? 'preferred_language'
              then excluded.preferred_language else existing_profile.preferred_language end,
            administrative_notes = case when row_item.normalized_data ? 'administrative_notes'
              then excluded.administrative_notes else existing_profile.administrative_notes end,
            version = existing_profile.version + 1,
            updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    else
      insert into public.member_cases (
        user_id, organization_id, chapter_id, reference, title, deadline, case_type, articles, step, status
      ) values (
        (row_item.normalized_data ->> '_resolved_member_id')::uuid, org,
        row_item.normalized_data ->> 'chapter_id', pg_catalog.btrim(row_item.normalized_data ->> 'reference'),
        pg_catalog.btrim(row_item.normalized_data ->> 'title'), nullif(row_item.normalized_data ->> 'deadline', '')::date,
        'Other', coalesce(row_item.normalized_data ->> 'articles', ''), 'Intake', 'active'
      );
    end if;
    imported := imported + 1;
  end loop;
  update public.organization_import_batches set state = 'committed', committed_at = pg_catalog.now() where id = batch.id;
  perform private.mi1_w2_write_audit(org, 'member_operations_import_committed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'batchId', batch.id, 'kind', batch.kind, 'count', imported
  ));
  result := pg_catalog.jsonb_build_object(
    'id', batch.id, 'state', 'committed', 'importedCount', imported
  );
  perform private.member_operations_store_receipt(
    org, 'commit_member_operations_import', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.discard_member_operations_import(
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  request_payload jsonb := pg_catalog.jsonb_build_object('batchId', p_batch_id);
  prior jsonb;
  result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'discard_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  update public.organization_import_batches set state = 'discarded', discarded_at = pg_catalog.now()
  where id = p_batch_id and organization_id = org and state in ('uploaded','validated','failed');
  if not found then raise exception 'batch is not discardable' using errcode = '55000'; end if;
  delete from public.organization_import_rows where batch_id = p_batch_id and organization_id = org;
  result := pg_catalog.jsonb_build_object('id', p_batch_id, 'state', 'discarded');
  perform private.member_operations_store_receipt(
    org, 'discard_member_operations_import', p_idempotency_key, request_payload, result
  );
  return result;
end;
$function$;

create function public.get_member_operations_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.require_member_operations_admin();
  welcome jsonb := public.get_welcome_campaign_workspace();
  imports jsonb := public.list_member_import_batches(null, null, 10);
begin
  return pg_catalog.jsonb_build_object(
    'state', 'ready', 'organizationId', org,
    'directory', public.get_member_operations_directory(null, null, null, 25),
    'campaigns', coalesce(welcome -> 'campaigns', '[]'::jsonb),
    'imports', coalesce(imports -> 'items', '[]'::jsonb),
    'importsNextCursor', imports -> 'nextCursor',
    'deliveryConfigured', false
  );
end;
$function$;

create or replace function public.get_engagement_delivery_payload(
  p_delivery_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  row public.engagement_delivery_outbox%rowtype;
  email text;
  title text;
  body text;
  action_path text;
begin
  select * into row from public.engagement_delivery_outbox
  where id = p_delivery_id and state = 'leased' and lease_token = p_lease_token
    and lease_expires_at >= pg_catalog.now();
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  select user_row.email into email from auth.users user_row where user_row.id = row.recipient_user_id;
  if row.source_kind = 'broadcast' then
    select broadcast.title, broadcast.body, '/m/messages?broadcast=' || row.source_id into title, body, action_path
    from public.member_broadcasts broadcast where broadcast.id = row.source_id
      and broadcast.organization_id = row.organization_id and broadcast.retracted_at is null;
  elsif row.source_kind = 'survey' then
    select survey.title, case row.delivery_kind when 'survey_reminder'
      then 'A survey is still waiting for your response in Union Ground.'
      else 'A survey is ready for you in Union Ground.' end,
      '/m/voice?survey=' || row.source_id into title, body, action_path
    from public.organization_surveys survey where survey.id = row.source_id::uuid
      and survey.organization_id = row.organization_id and survey.status = 'open';
  else
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.member_welcome_enrollments enrollment
    join public.organization_memberships membership
      on membership.organization_id = enrollment.organization_id
      and membership.user_id = enrollment.member_user_id
    where enrollment.id = pg_catalog.split_part(row.source_id, ':', 1)::uuid
      and enrollment.organization_id = row.organization_id and enrollment.member_user_id = row.recipient_user_id
      and enrollment.state in ('active','completed')
      and membership.status = 'active' and membership.revoked_at is null;
  end if;
  if email is null or title is null then return pg_catalog.jsonb_build_object('available', false); end if;
  return pg_catalog.jsonb_build_object(
    'available', true, 'email', email, 'locale', row.locale,
    'subject', title, 'body', body, 'path', action_path
  );
end;
$function$;

revoke all on function public.get_weekly_question_selection_workspace() from public, anon, authenticated, service_role;
revoke all on function public.list_weekly_question_selection_page(text, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.save_weekly_question_selection_policy(boolean, integer, integer, integer, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.run_weekly_question_selection(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_member_operations_directory(text, text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_member_operational_profile(uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_member_operational_profile(uuid, integer, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.bulk_update_member_operational_profiles(uuid[], text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_member_handoffs_v2(text, text, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.search_handoff_members(text) from public, anon, authenticated, service_role;
revoke all on function public.get_welcome_campaign_workspace() from public, anon, authenticated, service_role;
revoke all on function public.list_welcome_campaign_enrollments(uuid, timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.save_welcome_campaign(uuid, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_welcome_campaign_step(uuid, uuid, integer, integer, text, text, text, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.enroll_member_in_welcome_campaign(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.transition_member_welcome_enrollment(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.queue_due_welcome_messages(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_member_import_workspace() from public, anon, authenticated, service_role;
revoke all on function public.list_member_import_batches(timestamptz, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.stage_member_operations_import(text, text, jsonb, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.validate_member_operations_import(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.commit_member_operations_import(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.discard_member_operations_import(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_member_operations_workspace() from public, anon, authenticated, service_role;

grant execute on function public.get_weekly_question_selection_workspace() to authenticated;
grant execute on function public.list_weekly_question_selection_page(text, timestamptz, uuid, integer) to authenticated;
grant execute on function public.save_weekly_question_selection_policy(boolean, integer, integer, integer, text, timestamptz) to authenticated;
grant execute on function public.run_weekly_question_selection(uuid) to authenticated;
grant execute on function public.get_member_operations_directory(text, text, uuid, integer) to authenticated;
grant execute on function public.get_member_operational_profile(uuid) to authenticated;
grant execute on function public.save_member_operational_profile(uuid, integer, jsonb, uuid) to authenticated;
grant execute on function public.bulk_update_member_operational_profiles(uuid[], text, text, uuid) to authenticated;
grant execute on function public.list_member_handoffs_v2(text, text, timestamptz, uuid, integer) to authenticated;
grant execute on function public.search_handoff_members(text) to authenticated;
grant execute on function public.get_welcome_campaign_workspace() to authenticated;
grant execute on function public.list_welcome_campaign_enrollments(uuid, timestamptz, uuid, integer) to authenticated;
grant execute on function public.save_welcome_campaign(uuid, text, text, uuid) to authenticated;
grant execute on function public.save_welcome_campaign_step(uuid, uuid, integer, integer, text, text, text, boolean, uuid) to authenticated;
grant execute on function public.enroll_member_in_welcome_campaign(uuid, uuid, uuid) to authenticated;
grant execute on function public.transition_member_welcome_enrollment(uuid, text, uuid) to authenticated;
grant execute on function public.queue_due_welcome_messages(uuid) to authenticated;
grant execute on function public.get_member_import_workspace() to authenticated;
grant execute on function public.list_member_import_batches(timestamptz, uuid, integer) to authenticated;
grant execute on function public.stage_member_operations_import(text, text, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.validate_member_operations_import(uuid, uuid) to authenticated;
grant execute on function public.commit_member_operations_import(uuid, uuid) to authenticated;
grant execute on function public.discard_member_operations_import(uuid, uuid) to authenticated;
grant execute on function public.get_member_operations_workspace() to authenticated;

revoke all on function public.get_engagement_delivery_payload(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_engagement_delivery_payload(uuid, uuid) to service_role;
