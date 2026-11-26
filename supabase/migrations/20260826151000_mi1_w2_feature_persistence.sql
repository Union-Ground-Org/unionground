-- MI1 W2 feature persistence for surveys, case flow, knowledge files, and
-- member handoffs.
-- Created with `npx supabase migration new mi1_w2_feature_persistence` (CLI 2.109.1)
-- and renamed to the reserved 20260822020000+ allocation
-- `20260826151000_mi1_w2_feature_persistence.sql` so it applies after the
-- foundation and after the W1 `20260822020000` reservation without colliding.
--
-- Contract SHAs (behavior only; no donor migrations or seeds):
--   b7d3fbefbf24d3f8b26f8d611001484a36f72bc3 surveys
--   e7bf61ea491d0e046b76ddd1245588c6838a52c0 case flow
--   b67a209e3f9bde80e6666d75238d90a81b6a2d4b knowledge files
--   d59dc069b2b17825fd9496dd24f2483c37d606fe member handoffs
--
-- Zero organizations remains valid. This file does not insert organizations,
-- Auth users, SAMPLE rows, or fictional tenants. Callers never supply
-- organization_id. SECURITY DEFINER RPCs use empty search_path, fully
-- qualified names, auth.uid() + MFA, PUBLIC execute revoked, and exact-role
-- grants. Changelog checked 2026-08-22: no new migration-breaking RLS/RPC tag.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Expand the foundation tenant audit envelope for second-wave actions
-- ---------------------------------------------------------------------------

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
    'member_handoff_cancelled'
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
      'library', 'reviewStatus', 'indexStatus', 'byteSize', 'action',
      'handoffId', 'fromStewardId', 'toStewardId'
    ] = '{}'::jsonb
  );

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.organization_surveys (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  title text not null,
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  privacy_min_responses integer not null default 3 check (privacy_min_responses >= 3),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_surveys_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200
    and title !~ '[[:cntrl:]]'
  ),
  constraint organization_surveys_description_bounded check (
    pg_catalog.char_length(description) <= 4000
  )
);

create index organization_surveys_org_updated_idx
  on public.organization_surveys (organization_id, updated_at desc, id desc);

create table public.organization_survey_questions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  survey_id uuid not null references public.organization_surveys(id) on delete cascade,
  sort_index integer not null check (sort_index >= 0),
  question_type text not null check (question_type in (
    'text', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'rating', 'yes_no'
  )),
  label text not null,
  required boolean not null default false,
  options jsonb not null default '[]'::jsonb,
  section_key text,
  section_title text,
  branch_parent_id uuid references public.organization_survey_questions(id) on delete set null,
  branch_value text,
  scale_min_label text,
  scale_max_label text,
  max_selections integer check (max_selections is null or max_selections > 0),
  constraint organization_survey_questions_label_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(label)) between 1 and 400
    and label !~ '[[:cntrl:]]'
  ),
  constraint organization_survey_questions_options_array check (pg_catalog.jsonb_typeof(options) = 'array'),
  unique (survey_id, sort_index)
);

create index organization_survey_questions_survey_idx
  on public.organization_survey_questions (organization_id, survey_id, sort_index);

create table public.organization_survey_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  survey_id uuid not null references public.organization_surveys(id) on delete cascade,
  respondent_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'in_progress' check (status in ('in_progress', 'submitted')),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  submitted_at timestamptz,
  constraint organization_survey_sessions_submit_complete check (
    (status = 'in_progress' and submitted_at is null)
    or (status = 'submitted' and submitted_at is not null)
  ),
  unique (organization_id, survey_id, respondent_user_id)
);

create table public.organization_survey_answers (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  session_id uuid not null references public.organization_survey_sessions(id) on delete cascade,
  question_id uuid not null references public.organization_survey_questions(id) on delete cascade,
  value jsonb not null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (session_id, question_id)
);

create table public.case_deadline_changes (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete restrict,
  kind text not null check (kind in ('extension', 'override')),
  state text not null default 'pending' check (state in ('pending', 'approved', 'denied')),
  previous_deadline date,
  requested_deadline date not null,
  reason text not null,
  requested_by uuid not null references auth.users(id) on delete restrict,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  reviewed_at timestamptz,
  constraint case_deadline_changes_reason_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(reason)) between 10 and 1000
  )
);

create index case_deadline_changes_org_case_idx
  on public.case_deadline_changes (organization_id, case_id, created_at desc);

create table public.case_deadline_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete restrict,
  change_id uuid references public.case_deadline_changes(id) on delete restrict,
  previous_deadline date,
  new_deadline date,
  reason text not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  constraint case_deadline_audit_reason_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(reason)) between 1 and 1000
  )
);

create index case_deadline_audit_org_case_idx
  on public.case_deadline_audit (organization_id, case_id, created_at);

create table public.case_checklist_progress (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  item_id text not null,
  status text not null check (status in ('done', 'current', 'upcoming')),
  label text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, case_id, item_id),
  constraint case_checklist_progress_item_bounded check (
    pg_catalog.char_length(item_id) between 1 and 180
    and item_id !~ '[[:cntrl:]]'
  ),
  constraint case_checklist_progress_label_bounded check (
    label is null or pg_catalog.char_length(label) <= 160
  )
);

create table public.case_step_transitions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  from_step text not null,
  to_step text not null,
  checklist_complete boolean not null default false,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now()
);

create index case_step_transitions_org_case_idx
  on public.case_step_transitions (organization_id, case_id, created_at);

create table public.case_generated_work (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  step text not null,
  template_id text not null,
  title text not null,
  due_on date,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, case_id, step, template_id)
);

create table public.case_restrictions (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  restricted boolean not null default false,
  reason text,
  actor_user_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, case_id),
  constraint case_restrictions_reason_bounded check (
    reason is null or pg_catalog.char_length(reason) <= 1000
  )
);

create table public.case_restriction_access (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, case_id, user_id)
);

create table public.case_alerts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  alert_type text not null check (alert_type in (
    'deadline_risk', 'unacknowledged_step', 'restricted_access', 'counsel_escalation'
  )),
  state text not null default 'open' check (state in ('open', 'acknowledged', 'escalated')),
  escalation_bucket timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index case_alerts_org_state_idx
  on public.case_alerts (organization_id, state, created_at desc);

create table public.case_alert_acknowledgements (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  alert_id uuid not null references public.case_alerts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  acknowledged_at timestamptz not null default pg_catalog.now(),
  primary key (alert_id, user_id)
);

create table public.case_reminders (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  case_id uuid not null references public.member_cases(id) on delete cascade,
  due_on date not null,
  recurrence text not null default 'none' check (recurrence in ('none', 'weekly', 'monthly')),
  disposition text not null default 'pending' check (disposition in ('pending', 'dismissed', 'completed')),
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint case_reminders_note_bounded check (
    note is null or pg_catalog.char_length(note) <= 1000
  )
);

create index case_reminders_org_due_idx
  on public.case_reminders (organization_id, due_on, disposition);

create table public.organization_knowledge_files (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  library text not null default 'steward' check (library in ('steward', 'catalog')),
  title text not null,
  summary text not null default '',
  category text not null default 'general' check (category in (
    'general', 'contract', 'forms', 'guides', 'health_safety', 'meetings', 'steward_tools', 'training'
  )),
  doc_type text not null default 'other' check (doc_type in (
    'contract', 'form', 'guide', 'policy', 'minutes', 'other'
  )),
  file_name text not null,
  mime_type text,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 10485760),
  content_sha256 text,
  storage_kind text not null default 'organization_storage' check (storage_kind in ('organization_storage', 'external_url')),
  storage_handle uuid not null default extensions.gen_random_uuid(),
  storage_path text not null,
  review_status text not null default 'pending_scan' check (review_status in (
    'pending_scan', 'quarantined', 'approved', 'rejected'
  )),
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clean', 'blocked')),
  index_status text not null default 'pending' check (index_status in (
    'pending', 'chunked', 'failed', 'skipped_unset', 'embedded'
  )),
  visibility text not null default 'staff' check (visibility in ('staff', 'organization')),
  published_to_catalog boolean not null default false,
  idempotency_key uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_knowledge_files_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 200
    and title !~ '[[:cntrl:]]'
  ),
  constraint organization_knowledge_files_summary_bounded check (
    pg_catalog.char_length(summary) <= 1000
  ),
  constraint organization_knowledge_files_name_bounded check (
    pg_catalog.char_length(file_name) between 1 and 180
    and file_name !~ '[/\\]'
    and file_name !~ '[[:cntrl:]]'
  )
);

create unique index organization_knowledge_files_idempotency_key
  on public.organization_knowledge_files (organization_id, idempotency_key)
  where idempotency_key is not null;
create index organization_knowledge_files_org_library_idx
  on public.organization_knowledge_files (organization_id, library, updated_at desc);

create table public.organization_knowledge_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  file_id uuid not null references public.organization_knowledge_files(id) on delete cascade,
  source_kind text not null check (source_kind in ('steward_file', 'catalog_file', 'text')),
  label text not null,
  doc_type text not null default 'other',
  chunk_count integer not null default 0 check (chunk_count >= 0),
  embedded_count integer not null default 0 check (embedded_count >= 0),
  last_ingest_at timestamptz,
  last_error text,
  health text not null default 'unset_embedding' check (health in (
    'healthy', 'partial', 'failed', 'unset_embedding'
  )),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index organization_knowledge_sources_org_file_idx
  on public.organization_knowledge_sources (organization_id, file_id);

create table public.organization_knowledge_chunks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  source_id uuid not null references public.organization_knowledge_sources(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  unique (source_id, chunk_index),
  constraint organization_knowledge_chunks_content_bounded check (
    pg_catalog.char_length(content) between 1 and 8000
  )
);

create table private.mi1_w2_operation_receipts (
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  operation text not null check (pg_catalog.char_length(operation) between 1 and 80),
  idempotency_key uuid not null,
  request_payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, operation, idempotency_key)
);

revoke all on table private.mi1_w2_operation_receipts from public, anon, authenticated, service_role;

create table public.member_steward_relationships (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  steward_user_id uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, chapter_id, member_user_id)
);

create table public.member_handoffs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  from_steward_id uuid references auth.users(id) on delete set null,
  to_steward_id uuid not null references auth.users(id) on delete restrict,
  initiated_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'acknowledged', 'declined', 'cancelled')),
  note text,
  idempotency_key uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  constraint member_handoffs_note_bounded check (
    note is null or pg_catalog.char_length(note) <= 1000
  ),
  unique (idempotency_key)
);

create unique index member_handoffs_one_pending_idx
  on public.member_handoffs (organization_id, chapter_id, member_user_id)
  where status = 'pending';
create index member_handoffs_org_created_idx
  on public.member_handoffs (organization_id, created_at desc);

comment on table public.organization_surveys is
  'Organization-owned survey core. No default rows. Answers never enter audit metadata.';
comment on table public.case_deadline_audit is
  'Append-only deadline history. Compensating deletes are prohibited.';
comment on column public.organization_knowledge_files.storage_path is
  'Server-composed object key. Never returned to clients.';
comment on table public.member_handoffs is
  'Two-sided steward handoff. Assignment writes only on acknowledge.';

-- ---------------------------------------------------------------------------
-- 3. Guards and append-only histories
-- ---------------------------------------------------------------------------

create function private.mi1_w2_forbid_org_key_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception 'organization key is immutable' using errcode = '42501';
  end if;
  if new.organization_id is null then
    raise exception 'ownerless writes are prohibited' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create function private.mi1_w2_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'organization history is append-only' using errcode = '42501';
end;
$function$;

create function private.mi1_w2_knowledge_chunk_same_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from public.organization_knowledge_sources s
    where s.id = new.source_id
      and s.organization_id = new.organization_id
  ) then
    raise exception 'knowledge chunk organization must match its source' using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke all on function private.mi1_w2_forbid_org_key_mutation() from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_append_only() from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_knowledge_chunk_same_org() from public, anon, authenticated, service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organization_surveys',
    'organization_survey_questions',
    'organization_survey_sessions',
    'organization_survey_answers',
    'case_deadline_changes',
    'case_deadline_audit',
    'case_checklist_progress',
    'case_step_transitions',
    'case_generated_work',
    'case_restrictions',
    'case_restriction_access',
    'case_alerts',
    'case_alert_acknowledgements',
    'case_reminders',
    'organization_knowledge_files',
    'organization_knowledge_sources',
    'organization_knowledge_chunks',
    'member_steward_relationships',
    'member_handoffs'
  ]
  loop
    execute format(
      'create trigger %I_org_key before insert or update on public.%I for each row execute function private.mi1_w2_forbid_org_key_mutation()',
      table_name, table_name
    );
  end loop;
end
$$;

create trigger case_deadline_audit_append_only
  before update or delete on public.case_deadline_audit
  for each row execute function private.mi1_w2_append_only();

create trigger organization_knowledge_chunks_same_org
  before insert or update on public.organization_knowledge_chunks
  for each row execute function private.mi1_w2_knowledge_chunk_same_org();

-- ---------------------------------------------------------------------------
-- 4. RLS, MFA, and least table grants
-- ---------------------------------------------------------------------------

alter table public.organization_surveys enable row level security;
alter table public.organization_survey_questions enable row level security;
alter table public.organization_survey_sessions enable row level security;
alter table public.organization_survey_answers enable row level security;
alter table public.case_deadline_changes enable row level security;
alter table public.case_deadline_audit enable row level security;
alter table public.case_checklist_progress enable row level security;
alter table public.case_step_transitions enable row level security;
alter table public.case_generated_work enable row level security;
alter table public.case_restrictions enable row level security;
alter table public.case_restriction_access enable row level security;
alter table public.case_alerts enable row level security;
alter table public.case_alert_acknowledgements enable row level security;
alter table public.case_reminders enable row level security;
alter table public.organization_knowledge_files enable row level security;
alter table public.organization_knowledge_sources enable row level security;
alter table public.organization_knowledge_chunks enable row level security;
alter table public.member_steward_relationships enable row level security;
alter table public.member_handoffs enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organization_surveys',
    'organization_survey_questions',
    'organization_survey_sessions',
    'organization_survey_answers',
    'case_deadline_changes',
    'case_deadline_audit',
    'case_checklist_progress',
    'case_step_transitions',
    'case_generated_work',
    'case_restrictions',
    'case_restriction_access',
    'case_alerts',
    'case_alert_acknowledgements',
    'case_reminders',
    'organization_knowledge_files',
    'organization_knowledge_sources',
    'organization_knowledge_chunks',
    'member_steward_relationships',
    'member_handoffs'
  ]
  loop
    execute format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
  end loop;
end
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'organization-knowledge',
  'organization-knowledge',
  false,
  10485760,
  null
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------
-- 5. Private helpers
-- ---------------------------------------------------------------------------

create function private.mi1_w2_selected_organization()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if org is null then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create function private.mi1_w2_write_audit(p_organization_id uuid, p_event_type text, p_metadata jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is distinct from private.current_member_organization() then
    raise exception 'audit organization is derived from the session' using errcode = '42501';
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id,
    p_event_type,
    (select auth.uid()),
    extensions.gen_random_uuid(),
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$function$;

create function private.mi1_w2_same_org_chapter(p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.chapters c
    where c.id = p_chapter_id
      and c.organization_id is not null
      and c.organization_id = p_organization_id
  )
$function$;

create function private.mi1_w2_case_organization(p_case_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select c.organization_id
  from public.member_cases mc
  join public.member_profiles p on p.id = mc.user_id
  join public.chapters c on c.id = p.chapter_id
  where mc.id = p_case_id
    and c.organization_id is not null
$function$;

create function private.can_read_restricted_case(p_organization_id uuid, p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    and p_organization_id is not null
    and p_case_id is not null
    and private.is_organization_member(p_organization_id)
    and exists (
      select 1
      from public.member_cases mc
      where mc.id = p_case_id
        and mc.organization_id = p_organization_id
        and (
          private.has_organization_role(p_organization_id, array['admin', 'vp'])
          or (
            mc.steward_user_id = (select auth.uid())
            and (
              private.has_organization_role(p_organization_id, array['steward'])
              or public.member_has_role(array['steward'])
            )
          )
          or public.staff_can_see_user(mc.user_id, 'coordinator')
        )
        and (
          not exists (
            select 1
            from public.case_restrictions r
            where r.organization_id = p_organization_id
              and r.case_id = mc.id
              and r.restricted
          )
          or private.has_organization_role(p_organization_id, array['admin', 'vp'])
          or exists (
            select 1
            from public.case_restriction_access a
            where a.organization_id = p_organization_id
              and a.case_id = mc.id
              and a.user_id = (select auth.uid())
          )
        )
    );
$function$;

create function private.mi1_w2_normalize_case_step(p_step text, p_status text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_status = 'resolved' then 'resolved'
    when pg_catalog.lower(pg_catalog.btrim(coalesce(p_step, ''))) in ('', 'intake', 'triage', 'step 1', 'step1') then 'intake'
    when pg_catalog.lower(pg_catalog.btrim(p_step)) in ('filing', 'filed') then 'filing'
    when pg_catalog.lower(pg_catalog.btrim(p_step)) in ('management_response', 'response', 'step 2', 'step2') then 'management_response'
    when pg_catalog.lower(pg_catalog.btrim(p_step)) in ('appeal', 'step 3', 'step3') then 'appeal'
    when pg_catalog.lower(pg_catalog.btrim(p_step)) in ('arbitration', 'step 4', 'step4') then 'arbitration'
    when pg_catalog.lower(pg_catalog.btrim(p_step)) in ('resolved', 'closed') then 'resolved'
    when pg_catalog.lower(pg_catalog.btrim(p_step)) = 'withdrawn' then 'withdrawn'
    else 'intake'
  end
$function$;

revoke all on function private.mi1_w2_selected_organization() from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_write_audit(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_same_org_chapter(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_case_organization(uuid) from public, anon, authenticated, service_role;
revoke all on function private.can_read_restricted_case(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_normalize_case_step(text, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Survey RPCs
-- ---------------------------------------------------------------------------

create function private.mi1_w2_replace_survey_questions(p_org uuid, p_survey uuid, p_questions jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item jsonb;
  idx integer := 0;
  question_type text;
  label text;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_questions, '[]'::jsonb)) <> 'array' then
    raise exception 'questions must be an array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(coalesce(p_questions, '[]'::jsonb)) > 200 then
    raise exception 'survey question cap exceeded' using errcode = '22023';
  end if;
  delete from public.organization_survey_questions q where q.survey_id = p_survey and q.organization_id = p_org;
  for item in select value from pg_catalog.jsonb_array_elements(coalesce(p_questions, '[]'::jsonb))
  loop
    question_type := coalesce(item ->> 'type', item ->> 'questionType', '');
    if question_type in ('textarea') then question_type := 'paragraph'; end if;
    if question_type in ('slider-10') then question_type := 'scale'; end if;
    if question_type in ('yes/no') then question_type := 'yes_no'; end if;
    if question_type in ('single-select', 'radio-branch') then question_type := 'radio'; end if;
    label := pg_catalog.btrim(coalesce(item ->> 'label', item ->> 'text', ''));
    if label = '' then
      continue;
    end if;
    if question_type not in ('text', 'paragraph', 'radio', 'checkbox', 'dropdown', 'scale', 'rating', 'yes_no') then
      raise exception 'unsupported survey question type' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(item -> 'options') = 'array'
       and pg_catalog.jsonb_array_length(item -> 'options') > 100 then
      raise exception 'survey option cap exceeded' using errcode = '22023';
    end if;
    insert into public.organization_survey_questions (
      id, organization_id, survey_id, sort_index, question_type, label, required,
      options, section_key, section_title, branch_value, scale_min_label, scale_max_label, max_selections
    ) values (
      coalesce(nullif(item ->> 'id', '')::uuid, extensions.gen_random_uuid()),
      p_org,
      p_survey,
      idx,
      question_type,
      label,
      coalesce((item ->> 'required')::boolean, false),
      case
        when pg_catalog.jsonb_typeof(item -> 'options') = 'array' then item -> 'options'
        else '[]'::jsonb
      end,
      nullif(item ->> 'sectionKey', ''),
      nullif(item ->> 'sectionTitle', ''),
      nullif(item ->> 'branchValue', ''),
      nullif(item ->> 'scaleMinLabel', ''),
      nullif(item ->> 'scaleMaxLabel', ''),
      nullif(item ->> 'maxSelections', '')::integer
    );
    idx := idx + 1;
  end loop;
end;
$function$;

create function private.mi1_w2_project_survey(p_survey_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', s.id,
    'organizationId', s.organization_id,
    'chapterId', s.chapter_id,
    'title', s.title,
    'description', s.description,
    'status', s.status,
    'privacyMinResponses', s.privacy_min_responses,
    'createdAt', s.created_at,
    'updatedAt', s.updated_at,
    'questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', bounded_questions.id,
        'type', bounded_questions.question_type,
        'label', bounded_questions.label,
        'required', bounded_questions.required,
        'options', bounded_questions.options,
        'sectionKey', bounded_questions.section_key,
        'sectionTitle', bounded_questions.section_title,
        'branchValue', bounded_questions.branch_value,
        'maxSelections', bounded_questions.max_selections,
        'sortIndex', bounded_questions.sort_index
      ) order by bounded_questions.sort_index, bounded_questions.id)
      from (
        select q.*
        from public.organization_survey_questions q
        where q.survey_id = s.id
        order by q.sort_index, q.id
        limit 200
      ) bounded_questions
    ), '[]'::jsonb)
  )
  from public.organization_surveys s
  where s.id = p_survey_id
$function$;

revoke all on function private.mi1_w2_replace_survey_questions(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_project_survey(uuid) from public, anon, authenticated, service_role;

create function public.save_organization_survey_draft(p_draft jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  existing public.organization_surveys%rowtype;
  saved_survey_id uuid;
  next_title text := pg_catalog.btrim(coalesce(p_draft ->> 'title', ''));
  chapter text := nullif(pg_catalog.btrim(coalesce(p_draft ->> 'chapterId', '')), '');
  privacy integer := coalesce(nullif(p_draft ->> 'privacyMinResponses', '')::integer, 3);
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if next_title = '' then
    raise exception 'A draft needs a title and at least one labeled question.' using errcode = '22023';
  end if;
  if privacy < 3 then
    raise exception 'privacy floor must be at least 3' using errcode = '22023';
  end if;
  if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if coalesce(p_draft ? 'organizationId', false) and nullif(p_draft ->> 'organizationId', '') is distinct from org::text then
    raise exception 'organization is derived from the session' using errcode = '42501';
  end if;
  if p_draft ? 'id' and nullif(p_draft ->> 'id', '') is not null then
    select * into existing from public.organization_surveys where id = (p_draft ->> 'id')::uuid;
    if not found or existing.organization_id is distinct from org then
      raise exception 'not found' using errcode = 'P0002';
    end if;
    if existing.status <> 'draft' then
      raise exception 'Published surveys cannot return to free-form draft editing.' using errcode = 'P0001';
    end if;
    saved_survey_id := existing.id;
    update public.organization_surveys
    set title = next_title,
        description = pg_catalog.btrim(coalesce(p_draft ->> 'description', '')),
        chapter_id = chapter,
        privacy_min_responses = privacy,
        updated_at = pg_catalog.now()
    where id = saved_survey_id;
  else
    insert into public.organization_surveys (
      organization_id, chapter_id, title, description, privacy_min_responses, created_by
    ) values (
      org, chapter, next_title, pg_catalog.btrim(coalesce(p_draft ->> 'description', '')), privacy, (select auth.uid())
    ) returning id into saved_survey_id;
  end if;
  perform private.mi1_w2_replace_survey_questions(org, saved_survey_id, p_draft -> 'questions');
  if not exists (select 1 from public.organization_survey_questions q where q.survey_id = saved_survey_id) then
    raise exception 'A draft needs a title and at least one labeled question.' using errcode = '22023';
  end if;
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'surveyId', saved_survey_id, 'status', 'draft',
    'privacyMinResponses', privacy
  ));
  return private.mi1_w2_project_survey(saved_survey_id);
end;
$function$;

create function public.publish_organization_survey(p_draft jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  saved jsonb;
  saved_survey_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  saved := public.save_organization_survey_draft(p_draft);
  saved_survey_id := (saved ->> 'id')::uuid;
  if not exists (
    select 1 from public.organization_survey_questions q
    where q.survey_id = saved_survey_id and q.organization_id = org
  ) then
    raise exception 'Survey is not ready to publish.' using errcode = '22023';
  end if;
  update public.organization_surveys
  set status = 'open', updated_at = pg_catalog.now()
  where id = saved_survey_id and organization_id = org;
  perform private.mi1_w2_write_audit(org, 'survey_published', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', saved_survey_id, 'status', 'open',
    'privacyMinResponses', (saved ->> 'privacyMinResponses')::integer
  ));
  return private.mi1_w2_project_survey(saved_survey_id);
end;
$function$;

create function public.close_organization_survey(p_survey_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys where id = p_survey_id;
  if not found or survey.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  update public.organization_surveys set status = 'closed', updated_at = pg_catalog.now() where id = survey.id;
  perform private.mi1_w2_write_audit(org, 'survey_closed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', survey.id, 'status', 'closed',
    'privacyMinResponses', survey.privacy_min_responses
  ));
  return private.mi1_w2_project_survey(survey.id);
end;
$function$;

create function public.reopen_organization_survey(p_survey_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys where id = p_survey_id;
  if not found or survey.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  update public.organization_surveys set status = 'open', updated_at = pg_catalog.now() where id = survey.id;
  perform private.mi1_w2_write_audit(org, 'survey_reopened', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', survey.id, 'status', 'open',
    'privacyMinResponses', survey.privacy_min_responses
  ));
  return private.mi1_w2_project_survey(survey.id);
end;
$function$;

create function public.set_organization_survey_privacy_floor(p_survey_id uuid, p_privacy_min_responses integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_privacy_min_responses is null or p_privacy_min_responses < 3 then
    raise exception 'privacy floor must be at least 3' using errcode = '22023';
  end if;
  select * into survey from public.organization_surveys where id = p_survey_id;
  if not found or survey.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  update public.organization_surveys
  set privacy_min_responses = p_privacy_min_responses, updated_at = pg_catalog.now()
  where id = survey.id;
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surveyId', survey.id, 'status', survey.status,
    'privacyMinResponses', p_privacy_min_responses
  ));
  return private.mi1_w2_project_survey(survey.id);
end;
$function$;

create function private.mi1_w2_upsert_survey_session(p_survey_id uuid, p_answers jsonb, p_submit boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  survey public.organization_surveys%rowtype;
  session_row public.organization_survey_sessions%rowtype;
  question public.organization_survey_questions%rowtype;
  answer jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  select * into survey from public.organization_surveys where id = p_survey_id;
  if not found or survey.organization_id is distinct from org or survey.status <> 'open' then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into session_row
  from public.organization_survey_sessions
  where organization_id = org and survey_id = survey.id and respondent_user_id = (select auth.uid());
  if found and session_row.status = 'submitted' then
    raise exception 'survey session already submitted' using errcode = 'P0001';
  end if;
  if not found then
    insert into public.organization_survey_sessions (
      organization_id, survey_id, respondent_user_id, status
    ) values (org, survey.id, (select auth.uid()), 'in_progress')
    returning * into session_row;
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_answers, '{}'::jsonb)) <> 'object' then
    raise exception 'answers must be an object' using errcode = '22023';
  end if;
  for question in
    select * from public.organization_survey_questions q
    where q.survey_id = survey.id and q.organization_id = org
    order by q.sort_index
  loop
    answer := p_answers -> question.id::text;
    if answer is null then
      if p_submit and question.required then
        raise exception 'required survey questions are missing' using errcode = '22023';
      end if;
      continue;
    end if;
    insert into public.organization_survey_answers (organization_id, session_id, question_id, value)
    values (org, session_row.id, question.id, answer)
    on conflict (session_id, question_id) do update
      set value = excluded.value, updated_at = pg_catalog.now();
  end loop;
  if p_submit then
    update public.organization_survey_sessions
    set status = 'submitted', submitted_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = session_row.id;
    perform private.mi1_w2_write_audit(org, 'survey_session_submitted', pg_catalog.jsonb_build_object(
      'organizationId', org, 'surveyId', survey.id, 'sessionId', session_row.id, 'status', 'submitted'
    ));
  else
    update public.organization_survey_sessions set updated_at = pg_catalog.now() where id = session_row.id;
    perform private.mi1_w2_write_audit(org, 'survey_session_saved', pg_catalog.jsonb_build_object(
      'organizationId', org, 'surveyId', survey.id, 'sessionId', session_row.id, 'status', 'in_progress'
    ));
  end if;
  return pg_catalog.jsonb_build_object(
    'id', session_row.id,
    'organizationId', org,
    'surveyId', survey.id,
    'status', case when p_submit then 'submitted' else 'in_progress' end
  );
end;
$function$;

revoke all on function private.mi1_w2_upsert_survey_session(uuid, jsonb, boolean) from public, anon, authenticated, service_role;

create function public.save_organization_survey_session(p_survey_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.mi1_w2_upsert_survey_session(p_survey_id, p_answers, false);
end;
$function$;

create function public.submit_organization_survey_session(p_survey_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.mi1_w2_upsert_survey_session(p_survey_id, p_answers, true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Case-flow RPCs
-- ---------------------------------------------------------------------------

create function private.mi1_w2_require_visible_case(p_org uuid, p_case_id uuid)
returns public.member_cases
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_case public.member_cases%rowtype;
begin
  select * into found_case from public.member_cases where id = p_case_id;
  if not found
     or private.mi1_w2_case_organization(p_case_id) is distinct from p_org
     or not private.can_read_restricted_case(p_org, p_case_id) then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  return found_case;
end;
$function$;

create function private.mi1_w2_generate_case_work(p_org uuid, p_case public.member_cases, p_step text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.case_generated_work (organization_id, case_id, step, template_id, title, due_on, priority)
  select p_org, p_case.id, p_step, work.template_id, work.title, work.due_on, work.priority
  from (
    select * from (
      values
        ('intake', 'facts', 'Confirm intake facts', (current_date + 1), 'medium'),
        ('intake', 'steward', 'Assign steward owner', current_date, 'high'),
        ('filing', 'filing', 'File grievance packet', coalesce(p_case.deadline, current_date + 3), 'high'),
        ('management_response', 'response', 'Record management response', (current_date + 7), 'high'),
        ('appeal', 'next_path', 'Prepare appeal path', (current_date + 3), 'medium'),
        ('arbitration', 'next_path', 'Prepare arbitration record', (current_date + 5), 'medium'),
        ('resolved', 'outcome', 'Record outcome summary', (current_date + 1), 'medium'),
        ('resolved', 'member_notice', 'Confirm member notification', (current_date + 2), 'medium'),
        ('withdrawn', 'outcome', 'Record withdrawal summary', (current_date + 1), 'medium')
    ) as work(step, template_id, title, due_on, priority)
    where work.step = p_step
  ) work
  on conflict (organization_id, case_id, step, template_id) do nothing;
end;
$function$;

revoke all on function private.mi1_w2_require_visible_case(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_generate_case_work(uuid, public.member_cases, text) from public, anon, authenticated, service_role;

create function public.get_organization_case_flow_snapshot()
returns jsonb
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
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', mc.id,
        'organizationId', org,
        'reference', mc.reference,
        'title', mc.title,
        'deadline', mc.deadline,
        'status', mc.status,
        'step', private.mi1_w2_normalize_case_step(mc.step, mc.status),
        'restricted', coalesce(r.restricted, false)
      ) order by mc.updated_at desc, mc.id)
      from (
        select source.*
        from public.member_cases source
        where source.organization_id = org
          and private.can_read_restricted_case(org, source.id)
        order by source.updated_at desc, source.id
        limit 200
      ) mc
      left join public.case_restrictions r
        on r.organization_id = org and r.case_id = mc.id
    ), '[]'::jsonb),
    'deadlineChanges', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', d.id, 'caseId', d.case_id, 'kind', d.kind, 'state', d.state,
        'previousDeadline', d.previous_deadline, 'requestedDeadline', d.requested_deadline
      ) order by d.created_at desc)
      from (
        select source.*
        from public.case_deadline_changes source
        where source.organization_id = org
          and private.can_read_restricted_case(org, source.case_id)
        order by source.created_at desc, source.id
        limit 200
      ) d
    ), '[]'::jsonb),
    'alerts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'caseId', a.case_id, 'type', a.alert_type, 'state', a.state
      ) order by a.created_at desc)
      from (
        select source.*
        from public.case_alerts source
        where source.organization_id = org
          and private.can_read_restricted_case(org, source.case_id)
        order by source.created_at desc, source.id
        limit 200
      ) a
    ), '[]'::jsonb),
    'reminders', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', rm.id, 'caseId', rm.case_id, 'dueOn', rm.due_on,
        'recurrence', rm.recurrence, 'disposition', rm.disposition
      ) order by rm.due_on, rm.id)
      from (
        select source.*
        from public.case_reminders source
        where source.organization_id = org
          and private.can_read_restricted_case(org, source.case_id)
        order by source.due_on, source.id
        limit 200
      ) rm
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.request_case_deadline_change(p_case_id uuid, p_kind text, p_new_deadline date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  found_case public.member_cases%rowtype;
  created uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_kind not in ('extension', 'override') then
    raise exception 'invalid deadline change kind' using errcode = '22023';
  end if;
  found_case := private.mi1_w2_require_visible_case(org, p_case_id);
  insert into public.case_deadline_changes (
    organization_id, case_id, kind, previous_deadline, requested_deadline, reason, requested_by
  ) values (
    org, found_case.id, p_kind, found_case.deadline, p_new_deadline, pg_catalog.btrim(p_reason), (select auth.uid())
  ) returning id into created;
  perform private.mi1_w2_write_audit(org, 'case_deadline_extension_requested', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', found_case.id, 'kind', p_kind,
    'previousDeadline', found_case.deadline, 'newDeadline', p_new_deadline
  ));
  return pg_catalog.jsonb_build_object('id', created, 'state', 'pending');
end;
$function$;

create function public.review_case_deadline_change(p_change_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  change public.case_deadline_changes%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'denied') then
    raise exception 'invalid deadline review' using errcode = '22023';
  end if;
  select * into change from public.case_deadline_changes where id = p_change_id;
  if not found or change.organization_id is distinct from org then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  perform private.mi1_w2_require_visible_case(org, change.case_id);
  if change.state <> 'pending' then
    raise exception 'deadline change is no longer pending' using errcode = 'P0001';
  end if;
  update public.case_deadline_changes
  set state = p_decision, reviewed_by = (select auth.uid()), reviewed_at = pg_catalog.now()
  where id = change.id;
  if p_decision = 'approved' then
    insert into public.case_deadline_audit (
      organization_id, case_id, change_id, previous_deadline, new_deadline, reason, actor_user_id
    ) values (
      org, change.case_id, change.id, change.previous_deadline, change.requested_deadline, change.reason, (select auth.uid())
    );
    update public.member_cases set deadline = change.requested_deadline, updated_at = pg_catalog.now()
    where id = change.case_id;
    perform private.mi1_w2_write_audit(org, 'case_deadline_applied', pg_catalog.jsonb_build_object(
      'organizationId', org, 'caseId', change.case_id, 'kind', change.kind,
      'previousDeadline', change.previous_deadline, 'newDeadline', change.requested_deadline
    ));
  end if;
  perform private.mi1_w2_write_audit(org, 'case_deadline_change_reviewed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', change.case_id, 'kind', change.kind, 'status', p_decision
  ));
  return pg_catalog.jsonb_build_object('id', change.id, 'state', p_decision);
end;
$function$;

create function public.patch_case_checklist(p_case_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  found_case public.member_cases%rowtype;
  item jsonb;
  next_item_id text;
  custom_count integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  found_case := private.mi1_w2_require_visible_case(org, p_case_id);
  if pg_catalog.jsonb_typeof(coalesce(p_patch, '[]'::jsonb)) <> 'array' then
    raise exception 'checklist patch must be an array' using errcode = '22023';
  end if;
  for item in select value from pg_catalog.jsonb_array_elements(p_patch)
  loop
    next_item_id := pg_catalog.btrim(coalesce(item ->> 'itemId', item ->> 'id', ''));
    if next_item_id = '' then
      raise exception 'checklist item id required' using errcode = '22023';
    end if;
    if next_item_id like 'custom:%' then
      select pg_catalog.count(*) into custom_count
      from public.case_checklist_progress as progress
      where progress.organization_id = org
        and progress.case_id = found_case.id
        and progress.item_id like 'custom:%';
      if custom_count >= 20 then
        raise exception 'custom checklist cap exceeded' using errcode = '22023';
      end if;
    end if;
    insert into public.case_checklist_progress (
      organization_id, case_id, item_id, status, label, updated_by
    ) values (
      org,
      found_case.id,
      next_item_id,
      coalesce(nullif(item ->> 'status', ''), 'current'),
      nullif(item ->> 'label', ''),
      (select auth.uid())
    )
    on conflict (organization_id, case_id, item_id) do update
      set status = excluded.status,
          label = coalesce(excluded.label, public.case_checklist_progress.label),
          updated_by = excluded.updated_by,
          updated_at = pg_catalog.now();
  end loop;
  perform private.mi1_w2_write_audit(org, 'case_checklist_patched', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', found_case.id
  ));
  return pg_catalog.jsonb_build_object('caseId', found_case.id, 'ok', true);
end;
$function$;

create function public.advance_case_step(p_case_id uuid, p_to_step text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  found_case public.member_cases%rowtype;
  from_step text;
  to_step text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_to_step, '')));
  allowed text[];
  checklist_is_complete boolean := false;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  found_case := private.mi1_w2_require_visible_case(org, p_case_id);
  from_step := private.mi1_w2_normalize_case_step(found_case.step, found_case.status);
  allowed := case from_step
    when 'intake' then array['filing', 'withdrawn']
    when 'filing' then array['management_response', 'withdrawn']
    when 'management_response' then array['appeal', 'resolved', 'withdrawn']
    when 'appeal' then array['arbitration', 'resolved', 'withdrawn']
    when 'arbitration' then array['resolved', 'withdrawn']
    else array[]::text[]
  end;
  if to_step <> all(allowed) then
    raise exception 'invalid case step transition' using errcode = '22023';
  end if;
  select exists (
      select 1 from public.case_checklist_progress progress
      where progress.organization_id = org and progress.case_id = found_case.id
    ) and not exists (
      select 1 from public.case_checklist_progress progress
      where progress.organization_id = org and progress.case_id = found_case.id
        and progress.status <> 'done'
    )
  into checklist_is_complete;
  insert into public.case_step_transitions (
    organization_id, case_id, from_step, to_step, checklist_complete, actor_user_id
  ) values (
    org, found_case.id, from_step, to_step, checklist_is_complete, (select auth.uid())
  );
  update public.member_cases
  set step = to_step,
      status = case when to_step in ('resolved', 'withdrawn') then 'resolved' else 'active' end,
      updated_at = pg_catalog.now()
  where id = found_case.id;
  perform private.mi1_w2_generate_case_work(org, found_case, to_step);
  perform private.mi1_w2_write_audit(org, 'case_step_advanced', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', found_case.id, 'fromStep', from_step, 'toStep', to_step
  ));
  return pg_catalog.jsonb_build_object('caseId', found_case.id, 'fromStep', from_step, 'toStep', to_step);
end;
$function$;

create function public.set_case_restriction(p_case_id uuid, p_restricted boolean, p_reason text, p_access_user_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  found_case public.member_cases%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  found_case := private.mi1_w2_require_visible_case(org, p_case_id);
  if exists (
    select 1
    from unnest(coalesce(p_access_user_ids, '{}'::uuid[])) as requested(user_id)
    where requested.user_id is null
       or not exists (
         select 1
         from public.organization_memberships membership
         where membership.organization_id = org
           and membership.user_id = requested.user_id
           and membership.status = 'active'
       )
  ) then
    raise exception 'case restriction access user is not an active organization member'
      using errcode = '22023';
  end if;
  insert into public.case_restrictions (organization_id, case_id, restricted, reason, actor_user_id)
  values (org, found_case.id, coalesce(p_restricted, false), nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''), (select auth.uid()))
  on conflict (organization_id, case_id) do update
    set restricted = excluded.restricted,
        reason = excluded.reason,
        actor_user_id = excluded.actor_user_id,
        updated_at = pg_catalog.now();
  delete from public.case_restriction_access a
  where a.organization_id = org and a.case_id = found_case.id;
  if p_access_user_ids is not null then
    insert into public.case_restriction_access (organization_id, case_id, user_id, granted_by)
    select org, found_case.id, uid, (select auth.uid())
    from unnest(p_access_user_ids) as uid
    where exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = org
        and membership.user_id = uid
        and membership.status = 'active'
    )
    on conflict do nothing;
  end if;
  perform private.mi1_w2_write_audit(org, 'case_restriction_toggled', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', found_case.id, 'restricted', coalesce(p_restricted, false)
  ));
  perform private.mi1_w2_write_audit(org, 'case_restriction_access_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', found_case.id, 'restricted', coalesce(p_restricted, false)
  ));
  return pg_catalog.jsonb_build_object('caseId', found_case.id, 'restricted', coalesce(p_restricted, false));
end;
$function$;

create function public.acknowledge_case_alert(p_alert_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  alert public.case_alerts%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into alert from public.case_alerts where id = p_alert_id;
  if not found or alert.organization_id is distinct from org then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  perform private.mi1_w2_require_visible_case(org, alert.case_id);
  insert into public.case_alert_acknowledgements (organization_id, alert_id, user_id)
  values (org, alert.id, (select auth.uid()))
  on conflict (alert_id, user_id) do nothing;
  update public.case_alerts
  set state = 'acknowledged', updated_at = pg_catalog.now()
  where id = alert.id and state = 'open';
  perform private.mi1_w2_write_audit(org, 'case_alert_acknowledged', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', alert.case_id, 'alertId', alert.id
  ));
  return pg_catalog.jsonb_build_object('alertId', alert.id, 'state', 'acknowledged');
end;
$function$;

create function public.escalate_unacknowledged_case_alerts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  bucket timestamptz := date_trunc('hour', pg_catalog.now());
  escalated integer := 0;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.case_alerts a
  set state = 'escalated',
      escalation_bucket = bucket,
      updated_at = pg_catalog.now()
  where a.organization_id = org
    and a.state = 'open'
    and a.created_at <= pg_catalog.now() - interval '48 hours'
    and (a.escalation_bucket is distinct from bucket)
    and private.can_read_restricted_case(org, a.case_id)
    and not exists (
      select 1 from public.case_alert_acknowledgements k
      where k.alert_id = a.id
    );
  get diagnostics escalated = row_count;
  if escalated > 0 then
    perform private.mi1_w2_write_audit(org, 'case_alert_escalated', pg_catalog.jsonb_build_object(
      'organizationId', org, 'status', 'escalated'
    ));
  end if;
  return pg_catalog.jsonb_build_object('escalated', escalated, 'bucket', bucket);
end;
$function$;

create function public.upsert_case_reminder(p_reminder jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  found_case public.member_cases%rowtype;
  reminder_id uuid := nullif(p_reminder ->> 'id', '')::uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  found_case := private.mi1_w2_require_visible_case(org, (p_reminder ->> 'caseId')::uuid);
  if reminder_id is not null then
    update public.case_reminders
    set due_on = (p_reminder ->> 'dueOn')::date,
        recurrence = coalesce(nullif(p_reminder ->> 'recurrence', ''), recurrence),
        note = nullif(p_reminder ->> 'note', ''),
        updated_at = pg_catalog.now()
    where id = reminder_id and organization_id = org and case_id = found_case.id
    returning id into reminder_id;
    if reminder_id is null then
      raise exception 'case_not_found' using errcode = 'P0002';
    end if;
  else
    insert into public.case_reminders (
      organization_id, case_id, due_on, recurrence, note, created_by
    ) values (
      org,
      found_case.id,
      (p_reminder ->> 'dueOn')::date,
      coalesce(nullif(p_reminder ->> 'recurrence', ''), 'none'),
      nullif(p_reminder ->> 'note', ''),
      (select auth.uid())
    ) returning id into reminder_id;
  end if;
  perform private.mi1_w2_write_audit(org, 'case_reminder_created', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', found_case.id, 'reminderId', reminder_id
  ));
  return pg_catalog.jsonb_build_object('id', reminder_id, 'caseId', found_case.id);
end;
$function$;

create function public.dispose_case_reminder(p_reminder_id uuid, p_disposition text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  reminder public.case_reminders%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_disposition not in ('dismissed', 'completed') then
    raise exception 'invalid reminder disposition' using errcode = '22023';
  end if;
  select * into reminder from public.case_reminders where id = p_reminder_id;
  if not found or reminder.organization_id is distinct from org then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  perform private.mi1_w2_require_visible_case(org, reminder.case_id);
  update public.case_reminders
  set disposition = p_disposition, updated_at = pg_catalog.now()
  where id = reminder.id;
  perform private.mi1_w2_write_audit(org, 'case_reminder_disposed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'caseId', reminder.case_id, 'reminderId', reminder.id, 'status', p_disposition
  ));
  return pg_catalog.jsonb_build_object('id', reminder.id, 'disposition', p_disposition);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Knowledge-file RPCs
-- ---------------------------------------------------------------------------

create function private.mi1_w2_project_knowledge_file(p_file_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', f.id,
    'organizationId', f.organization_id,
    'chapterId', f.chapter_id,
    'library', f.library,
    'title', f.title,
    'summary', f.summary,
    'category', f.category,
    'docType', f.doc_type,
    'fileName', f.file_name,
    'byteSize', f.byte_size,
    'storageHandle', f.storage_handle,
    'reviewStatus', f.review_status,
    'scanStatus', f.scan_status,
    'indexStatus', f.index_status,
    'visibility', f.visibility,
    'publishedToCatalog', f.published_to_catalog,
    'createdAt', f.created_at,
    'updatedAt', f.updated_at
  )
  from public.organization_knowledge_files f
  where f.id = p_file_id
$function$;

create function private.mi1_w2_safe_file_name(p_file_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $function$
declare
  cleaned text := pg_catalog.btrim(coalesce(p_file_name, ''));
  ext text;
begin
  if cleaned = '' or pg_catalog.char_length(cleaned) > 180 or cleaned ~ '[/\\]' or cleaned ~ '[[:cntrl:]]' then
    raise exception 'invalid file name' using errcode = '22023';
  end if;
  ext := pg_catalog.lower(pg_catalog.regexp_replace(cleaned, '.*(\.[a-z0-9]+)$', '\1', 'i'));
  if ext not in ('.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.rtf', '.jpg', '.jpeg', '.png', '.gif') then
    raise exception 'file type is not allowed' using errcode = '22023';
  end if;
  return cleaned;
end;
$function$;

revoke all on function private.mi1_w2_project_knowledge_file(uuid) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_safe_file_name(text) from public, anon, authenticated, service_role;

create function public.list_knowledge_ingest_sources()
returns jsonb
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
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'fileId', s.file_id,
      'kind', s.source_kind,
      'label', s.label,
      'chunkCount', s.chunk_count,
      'embeddedCount', s.embedded_count,
      'health', s.health,
      'lastIngestAt', s.last_ingest_at,
      'lastError', s.last_error
    ) order by s.updated_at desc, s.id)
    from (
      select source.*
      from public.organization_knowledge_sources source
      where source.organization_id = org
      order by source.updated_at desc, source.id
      limit 100
    ) s
  ), '[]'::jsonb);
end;
$function$;

create function public.get_knowledge_ingest_source(p_source_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  source public.organization_knowledge_sources%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into source from public.organization_knowledge_sources where id = p_source_id;
  if not found or source.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', source.id,
    'fileId', source.file_id,
    'kind', source.source_kind,
    'label', source.label,
    'chunkCount', source.chunk_count,
    'embeddedCount', source.embedded_count,
    'health', source.health,
    'lastIngestAt', source.last_ingest_at,
    'lastError', source.last_error
  );
end;
$function$;

create function public.retry_knowledge_ingest_source(p_source_id uuid, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  source public.organization_knowledge_sources%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object('sourceId', p_source_id);
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'retry_knowledge_ingest_source:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'retry_knowledge_ingest_source'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into source from public.organization_knowledge_sources where id = p_source_id;
  if not found or source.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  update public.organization_knowledge_sources
  set health = 'unset_embedding',
      last_error = null,
      last_ingest_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = source.id;
  update public.organization_knowledge_files
  set index_status = 'skipped_unset', updated_at = pg_catalog.now()
  where id = source.file_id;
  perform private.mi1_w2_write_audit(org, 'knowledge_source_retried', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', source.file_id, 'sourceId', source.id,
    'indexStatus', 'skipped_unset', 'action', 'retried'
  ));
  result := public.get_knowledge_ingest_source(source.id);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'retry_knowledge_ingest_source', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

create function public.clear_knowledge_ingest_source_chunks(p_source_id uuid, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  source public.organization_knowledge_sources%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object('sourceId', p_source_id);
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'clear_knowledge_ingest_source_chunks:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'clear_knowledge_ingest_source_chunks'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into source from public.organization_knowledge_sources where id = p_source_id;
  if not found or source.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  delete from public.organization_knowledge_chunks c
  where c.source_id = source.id and c.organization_id = org;
  update public.organization_knowledge_sources
  set chunk_count = 0, embedded_count = 0, health = 'unset_embedding', updated_at = pg_catalog.now()
  where id = source.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_source_chunks_cleared', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', source.file_id, 'sourceId', source.id, 'action', 'cleared'
  ));
  result := public.get_knowledge_ingest_source(source.id);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'clear_knowledge_ingest_source_chunks', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

create function public.get_knowledge_embedding_activation()
returns jsonb
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
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'status', 'unset',
    'provider', null,
    'connected', false,
    'lastCheckedAt', null,
    'reason', 'optional_activation_unset'
  );
end;
$function$;

create function public.list_steward_library_files(p_query text, p_status text, p_category text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(private.mi1_w2_project_knowledge_file(f.id) order by f.updated_at desc, f.id)
    from (
      select source.id, source.updated_at
      from public.organization_knowledge_files source
      where source.organization_id = org
        and source.library = 'steward'
        and (p_status is null or source.review_status = p_status)
        and (p_category is null or source.category = p_category)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(source.title), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.file_name), pg_catalog.lower(needle)) > 0
        )
      order by source.updated_at desc, source.id
      limit 80
    ) f
  ), '[]'::jsonb);
end;
$function$;

create function public.get_steward_library_file(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org or file.library <> 'steward' then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return private.mi1_w2_project_knowledge_file(file.id);
end;
$function$;

create function public.prepare_steward_library_upload(
  p_file_name text,
  p_byte_size bigint,
  p_content_sha256 text,
  p_title text,
  p_summary text,
  p_category text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  safe_name text := private.mi1_w2_safe_file_name(p_file_name);
  existing uuid;
  created uuid;
  handle uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 10485760 then
    raise exception 'file size is outside the allowed range' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    select id into existing
    from public.organization_knowledge_files
    where organization_id = org and idempotency_key = p_idempotency_key;
    if existing is not null then
      return pg_catalog.jsonb_build_object(
        'uploadId', existing,
        'fileId', existing,
        'storageHandle', (select storage_handle from public.organization_knowledge_files where id = existing)
      );
    end if;
  end if;
  insert into public.organization_knowledge_files (
    organization_id, chapter_id, library, title, summary, category, file_name,
    byte_size, content_sha256, storage_path, idempotency_key, created_by
  ) values (
    org,
    case when chapter is not null and private.mi1_w2_same_org_chapter(org, chapter) then chapter else null end,
    'steward',
    coalesce(nullif(pg_catalog.btrim(coalesce(p_title, '')), ''), safe_name),
    pg_catalog.btrim(coalesce(p_summary, '')),
    coalesce(nullif(p_category, ''), 'general'),
    safe_name,
    p_byte_size,
    nullif(p_content_sha256, ''),
    'pending',
    p_idempotency_key,
    (select auth.uid())
  ) returning id, storage_handle into created, handle;
  update public.organization_knowledge_files
  set storage_path = 'org/' || org::text || '/' || created::text || '/' || safe_name
  where id = created;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_uploaded', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', created, 'library', 'steward',
    'category', coalesce(nullif(p_category, ''), 'general'),
    'reviewStatus', 'pending_scan', 'byteSize', p_byte_size, 'action', 'uploaded'
  ));
  return pg_catalog.jsonb_build_object('uploadId', created, 'fileId', created, 'storageHandle', handle);
end;
$function$;

create function public.complete_steward_library_upload(p_upload_id uuid, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object('uploadId', p_upload_id);
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'complete_steward_library_upload:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'complete_steward_library_upload'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into file from public.organization_knowledge_files where id = p_upload_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  update public.organization_knowledge_files
  set scan_status = 'clean',
      review_status = 'pending_scan',
      index_status = 'skipped_unset',
      updated_at = pg_catalog.now()
  where id = file.id;
  if not exists (
    select 1 from public.organization_knowledge_sources s
    where s.organization_id = org and s.file_id = file.id
  ) then
    insert into public.organization_knowledge_sources (
      organization_id, file_id, source_kind, label, doc_type, health, last_ingest_at
    ) values (
      org, file.id, 'steward_file', file.title, file.doc_type, 'unset_embedding', pg_catalog.now()
    );
  end if;
  result := private.mi1_w2_project_knowledge_file(file.id);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'complete_steward_library_upload', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

create function private.mi1_w2_download_knowledge_file(p_file_id uuid, p_catalog_only boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  expires timestamptz := pg_catalog.now() + interval '5 minutes';
  handle text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_catalog_only then
    if not private.is_organization_member(org)
       or not file.published_to_catalog
       or file.review_status <> 'approved'
       or file.scan_status <> 'clean' then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  else
    if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;
  handle := replace(extensions.gen_random_uuid()::text, '-', '');
  perform private.mi1_w2_write_audit(org, 'knowledge_file_downloaded', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'library', file.library, 'action', 'downloaded'
  ));
  return pg_catalog.jsonb_build_object(
    'fileId', file.id,
    'fileName', file.file_name,
    'disposition', 'attachment',
    'expiresAt', expires,
    'href', 'knowledge:' || file.storage_handle::text || ':' || handle
  );
end;
$function$;

revoke all on function private.mi1_w2_download_knowledge_file(uuid, boolean) from public, anon, authenticated, service_role;

create function public.download_steward_library_file(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.mi1_w2_download_knowledge_file(p_file_id, false);
end;
$function$;

create function public.review_steward_library_file(p_file_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  next_status text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected', 'quarantined') then
    raise exception 'invalid review decision' using errcode = '22023';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  next_status := p_decision;
  update public.organization_knowledge_files
  set review_status = next_status,
      index_status = case when next_status = 'approved' then 'skipped_unset' else index_status end,
      updated_at = pg_catalog.now()
  where id = file.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_reviewed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'reviewStatus', next_status, 'action', 'reviewed'
  ));
  return private.mi1_w2_project_knowledge_file(file.id);
end;
$function$;

create function public.publish_steward_file_to_catalog(p_file_id uuid, p_category text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object(
    'fileId', p_file_id, 'category', coalesce(p_category, '')
  );
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'publish_steward_file_to_catalog:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'publish_steward_file_to_catalog'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if file.review_status <> 'approved' or file.scan_status <> 'clean' then
    raise exception 'only approved clean files can be published' using errcode = '22023';
  end if;
  update public.organization_knowledge_files
  set published_to_catalog = true,
      visibility = 'organization',
      category = coalesce(nullif(p_category, ''), category),
      updated_at = pg_catalog.now()
  where id = file.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_published_to_catalog', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'library', 'catalog',
    'category', coalesce(nullif(p_category, ''), file.category), 'action', 'published'
  ));
  result := private.mi1_w2_project_knowledge_file(file.id);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'publish_steward_file_to_catalog', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

create function public.list_resource_catalog(p_query text, p_category text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id,
      'title', f.title,
      'summary', f.summary,
      'category', f.category,
      'fileName', f.file_name,
      'byteSize', f.byte_size
    ) order by f.title, f.id)
    from (
      select source.id, source.title, source.summary, source.category,
             source.file_name, source.byte_size
      from public.organization_knowledge_files source
      where source.organization_id = org
        and source.published_to_catalog
        and source.review_status = 'approved'
        and source.scan_status = 'clean'
        and (p_category is null or source.category = p_category)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(source.title), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.summary), pg_catalog.lower(needle)) > 0
        )
      order by source.title, source.id
      limit 80
    ) f
  ), '[]'::jsonb);
end;
$function$;

create function public.get_resource_catalog_item(p_file_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found
     or file.organization_id is distinct from org
     or not file.published_to_catalog
     or file.review_status <> 'approved'
     or file.scan_status <> 'clean' then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', file.id,
    'title', file.title,
    'summary', file.summary,
    'category', file.category,
    'fileName', file.file_name,
    'byteSize', file.byte_size
  );
end;
$function$;

create function public.download_resource_catalog_item(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.mi1_w2_download_knowledge_file(p_file_id, true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Member handoff RPCs
-- ---------------------------------------------------------------------------

create function private.mi1_w2_handoff_can_initiate(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.has_organization_role(p_org, array['steward', 'coordinator', 'admin', 'vp'])
$function$;

create function private.mi1_w2_handoff_can_oversee(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.has_organization_role(p_org, array['coordinator', 'admin', 'vp', 'advisor'])
$function$;

create function private.mi1_w2_handoff_visible(p_org uuid, p_handoff public.member_handoffs)
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
      or p_handoff.member_user_id = (select auth.uid())
      or private.mi1_w2_handoff_can_oversee(p_org)
    )
$function$;

revoke all on function private.mi1_w2_handoff_can_initiate(uuid) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_handoff_can_oversee(uuid) from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_handoff_visible(uuid, public.member_handoffs) from public, anon, authenticated, service_role;

create function public.initiate_member_handoff(
  p_member_user_id uuid,
  p_to_steward_id uuid,
  p_note text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  existing public.member_handoffs%rowtype;
  pending public.member_handoffs%rowtype;
  created uuid;
  current_steward uuid;
  hourly integer;
  daily integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.mi1_w2_handoff_can_initiate(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_member_user_id is null or p_to_steward_id is null or p_idempotency_key is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_member_user_id = p_to_steward_id then
    raise exception 'A member cannot be handed off to themselves.' using errcode = '22023';
  end if;
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.organization_memberships m
    where m.organization_id = org and m.user_id = p_member_user_id and m.status = 'active'
  ) or not exists (
    select 1
    from public.member_chapter_memberships cm
    where cm.user_id = p_member_user_id and cm.chapter_id = chapter and cm.status = 'active'
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1
    from public.organization_memberships m
    join public.organization_role_grants g
      on g.organization_id = m.organization_id
     and g.user_id = m.user_id
    where m.organization_id = org
      and m.user_id = p_to_steward_id
      and m.status = 'active'
      and g.role = 'steward'
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  select pg_catalog.count(*) into hourly
  from public.member_handoffs h
  where h.organization_id = org
    and h.initiated_by = (select auth.uid())
    and h.created_at >= pg_catalog.now() - interval '1 hour';
  select pg_catalog.count(*) into daily
  from public.member_handoffs h
  where h.organization_id = org
    and h.initiated_by = (select auth.uid())
    and h.created_at >= pg_catalog.now() - interval '1 day';
  if hourly >= 20 or daily >= 80 then
    raise exception 'handoff rate limit exceeded' using errcode = '54000';
  end if;

  select * into existing from public.member_handoffs where idempotency_key = p_idempotency_key;
  if found then
    if existing.organization_id is distinct from org
       or existing.member_user_id is distinct from p_member_user_id
       or existing.to_steward_id is distinct from p_to_steward_id
       or existing.initiated_by is distinct from (select auth.uid())
       or existing.note is distinct from nullif(pg_catalog.btrim(coalesce(p_note, '')), '') then
      raise exception 'That idempotency key already started a different handoff.' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('id', existing.id, 'status', existing.status, 'kind', 'reuse');
  end if;

  select * into pending
  from public.member_handoffs
  where organization_id = org
    and chapter_id = chapter
    and member_user_id = p_member_user_id
    and status = 'pending';
  if found then
    raise exception 'This member already has a pending handoff.' using errcode = 'P0001';
  end if;

  select r.steward_user_id into current_steward
  from public.member_steward_relationships r
  where r.organization_id = org
    and r.chapter_id = chapter
    and r.member_user_id = p_member_user_id;

  insert into public.member_handoffs (
    organization_id, chapter_id, member_user_id, from_steward_id, to_steward_id,
    initiated_by, note, idempotency_key, status
  ) values (
    org, chapter, p_member_user_id, current_steward, p_to_steward_id,
    (select auth.uid()), nullif(pg_catalog.btrim(coalesce(p_note, '')), ''), p_idempotency_key, 'pending'
  ) returning id into created;

  perform private.mi1_w2_write_audit(org, 'member_handoff_initiated', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'userId', p_member_user_id,
    'status', 'pending', 'handoffId', created,
    'fromStewardId', current_steward, 'toStewardId', p_to_steward_id
  ));
  return pg_catalog.jsonb_build_object('id', created, 'status', 'pending', 'kind', 'initiate');
end;
$function$;

create function private.mi1_w2_resolve_handoff(p_handoff_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  handoff public.member_handoffs%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into handoff from public.member_handoffs where id = p_handoff_id;
  if not found
     or handoff.organization_id is distinct from org
     or not private.mi1_w2_handoff_visible(org, handoff) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_action = 'acknowledged' and handoff.to_steward_id is distinct from (select auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action = 'declined' and handoff.to_steward_id is distinct from (select auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action = 'cancelled' and handoff.initiated_by is distinct from (select auth.uid()) then
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
    'organizationId', org,
    'chapterId', handoff.chapter_id,
    'userId', handoff.member_user_id,
    'status', p_action,
    'handoffId', handoff.id,
    'fromStewardId', handoff.from_steward_id,
    'toStewardId', handoff.to_steward_id
  ));
  return pg_catalog.jsonb_build_object('id', handoff.id, 'status', p_action, 'kind', p_action);
end;
$function$;

revoke all on function private.mi1_w2_resolve_handoff(uuid, text) from public, anon, authenticated, service_role;

create function public.acknowledge_member_handoff(p_handoff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.mi1_w2_resolve_handoff(p_handoff_id, 'acknowledged');
end;
$function$;

create function public.decline_member_handoff(p_handoff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.mi1_w2_resolve_handoff(p_handoff_id, 'declined');
end;
$function$;

create function public.cancel_member_handoff(p_handoff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return private.mi1_w2_resolve_handoff(p_handoff_id, 'cancelled');
end;
$function$;

create function public.list_member_handoffs(p_query text, p_status text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
  wanted text := nullif(p_status, '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if wanted is not null and wanted not in ('pending', 'acknowledged', 'declined', 'cancelled') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 100 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', h.id,
      'organizationId', h.organization_id,
      'chapterId', h.chapter_id,
      'memberId', h.member_user_id,
      'fromStewardId', h.from_steward_id,
      'toStewardId', h.to_steward_id,
      'initiatedBy', h.initiated_by,
      'status', h.status,
      'createdAt', h.created_at,
      'acknowledgedAt', h.acknowledged_at,
      'resolvedAt', h.resolved_at
    ) order by h.created_at desc, h.id desc)
    from (
      select source.*
      from public.member_handoffs source
      where source.organization_id = org
        and private.mi1_w2_handoff_visible(org, source)
        and (wanted is null or wanted = 'all' or source.status = wanted)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(source.id::text), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.member_user_id::text), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.status), pg_catalog.lower(needle)) > 0
        )
      order by source.created_at desc, source.id desc
      limit 20
    ) h
  ), '[]'::jsonb);
end;
$function$;

create function public.search_handoff_stewards(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.mi1_w2_handoff_can_initiate(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 100 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', p.id,
      'displayName', coalesce(nullif(p.full_name, ''), p.first_name)
    ) order by p.full_name, p.id)
    from (
      select profile.id, profile.full_name, profile.first_name
      from public.organization_role_grants grant_row
      join public.organization_memberships membership
        on membership.organization_id = grant_row.organization_id
       and membership.user_id = grant_row.user_id
       and membership.status = 'active'
      join public.member_profiles profile on profile.id = grant_row.user_id
      where grant_row.organization_id = org
        and grant_row.role = 'steward'
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(profile.full_name), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(profile.first_name), pg_catalog.lower(needle)) > 0
        )
      order by profile.full_name, profile.id
      limit 20
    ) p
  ), '[]'::jsonb);
end;
$function$;

create function public.get_member_steward_relationship(p_member_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  rel public.member_steward_relationships%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if chapter is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into rel
  from public.member_steward_relationships r
  where r.organization_id = org
    and r.chapter_id = chapter
    and r.member_user_id = p_member_user_id
    and (
      r.member_user_id = (select auth.uid())
      or r.steward_user_id = (select auth.uid())
      or private.mi1_w2_handoff_can_oversee(org)
    );
  if not found then
    return pg_catalog.jsonb_build_object('organizationId', org, 'chapterId', chapter, 'memberId', p_member_user_id, 'stewardId', null);
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', rel.organization_id,
    'chapterId', rel.chapter_id,
    'memberId', rel.member_user_id,
    'stewardId', rel.steward_user_id,
    'updatedAt', rel.updated_at
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Execute grants
-- ---------------------------------------------------------------------------

revoke all on function public.save_organization_survey_draft(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.publish_organization_survey(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.close_organization_survey(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reopen_organization_survey(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_survey_privacy_floor(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.save_organization_survey_session(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.submit_organization_survey_session(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_organization_case_flow_snapshot() from public, anon, authenticated, service_role;
revoke all on function public.request_case_deadline_change(uuid, text, date, text) from public, anon, authenticated, service_role;
revoke all on function public.review_case_deadline_change(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.patch_case_checklist(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.advance_case_step(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.set_case_restriction(uuid, boolean, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_case_alert(uuid) from public, anon, authenticated, service_role;
revoke all on function public.escalate_unacknowledged_case_alerts() from public, anon, authenticated, service_role;
revoke all on function public.upsert_case_reminder(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.dispose_case_reminder(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.list_knowledge_ingest_sources() from public, anon, authenticated, service_role;
revoke all on function public.get_knowledge_ingest_source(uuid) from public, anon, authenticated, service_role;
revoke all on function public.retry_knowledge_ingest_source(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.clear_knowledge_ingest_source_chunks(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_knowledge_embedding_activation() from public, anon, authenticated, service_role;
revoke all on function public.list_steward_library_files(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_steward_library_file(uuid) from public, anon, authenticated, service_role;
revoke all on function public.prepare_steward_library_upload(text, bigint, text, text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.complete_steward_library_upload(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.download_steward_library_file(uuid) from public, anon, authenticated, service_role;
revoke all on function public.review_steward_library_file(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.publish_steward_file_to_catalog(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_resource_catalog(text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_resource_catalog_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.download_resource_catalog_item(uuid) from public, anon, authenticated, service_role;
revoke all on function public.initiate_member_handoff(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_member_handoff(uuid) from public, anon, authenticated, service_role;
revoke all on function public.decline_member_handoff(uuid) from public, anon, authenticated, service_role;
revoke all on function public.cancel_member_handoff(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_member_handoffs(text, text) from public, anon, authenticated, service_role;
revoke all on function public.search_handoff_stewards(text) from public, anon, authenticated, service_role;
revoke all on function public.get_member_steward_relationship(uuid) from public, anon, authenticated, service_role;

grant execute on function public.save_organization_survey_draft(jsonb) to authenticated;
grant execute on function public.publish_organization_survey(jsonb) to authenticated;
grant execute on function public.close_organization_survey(uuid) to authenticated;
grant execute on function public.reopen_organization_survey(uuid) to authenticated;
grant execute on function public.set_organization_survey_privacy_floor(uuid, integer) to authenticated;
grant execute on function public.save_organization_survey_session(uuid, jsonb) to authenticated;
grant execute on function public.submit_organization_survey_session(uuid, jsonb) to authenticated;
grant execute on function public.get_organization_case_flow_snapshot() to authenticated;
grant execute on function public.request_case_deadline_change(uuid, text, date, text) to authenticated;
grant execute on function public.review_case_deadline_change(uuid, text) to authenticated;
grant execute on function public.patch_case_checklist(uuid, jsonb) to authenticated;
grant execute on function public.advance_case_step(uuid, text) to authenticated;
grant execute on function public.set_case_restriction(uuid, boolean, text, uuid[]) to authenticated;
grant execute on function public.acknowledge_case_alert(uuid) to authenticated;
grant execute on function public.escalate_unacknowledged_case_alerts() to authenticated;
grant execute on function public.upsert_case_reminder(jsonb) to authenticated;
grant execute on function public.dispose_case_reminder(uuid, text) to authenticated;
grant execute on function public.list_knowledge_ingest_sources() to authenticated;
grant execute on function public.get_knowledge_ingest_source(uuid) to authenticated;
grant execute on function public.retry_knowledge_ingest_source(uuid, uuid) to authenticated;
grant execute on function public.clear_knowledge_ingest_source_chunks(uuid, uuid) to authenticated;
grant execute on function public.get_knowledge_embedding_activation() to authenticated;
grant execute on function public.list_steward_library_files(text, text, text) to authenticated;
grant execute on function public.get_steward_library_file(uuid) to authenticated;
grant execute on function public.prepare_steward_library_upload(text, bigint, text, text, text, text, uuid) to authenticated;
grant execute on function public.complete_steward_library_upload(uuid, uuid) to authenticated;
grant execute on function public.download_steward_library_file(uuid) to authenticated;
grant execute on function public.review_steward_library_file(uuid, text) to authenticated;
grant execute on function public.publish_steward_file_to_catalog(uuid, text, uuid) to authenticated;
grant execute on function public.list_resource_catalog(text, text) to authenticated;
grant execute on function public.get_resource_catalog_item(uuid) to authenticated;
grant execute on function public.download_resource_catalog_item(uuid) to authenticated;
grant execute on function public.initiate_member_handoff(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.acknowledge_member_handoff(uuid) to authenticated;
grant execute on function public.decline_member_handoff(uuid) to authenticated;
grant execute on function public.cancel_member_handoff(uuid) to authenticated;
grant execute on function public.list_member_handoffs(text, text) to authenticated;
grant execute on function public.search_handoff_stewards(text) to authenticated;
grant execute on function public.get_member_steward_relationship(uuid) to authenticated;
