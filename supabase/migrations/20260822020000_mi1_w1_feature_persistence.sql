-- MI1 W1 feature persistence for the completed first-wave contracts.
-- Created with `npx supabase migration new mi1_w1_feature_persistence` (CLI 2.109.1)
-- and renamed to the reserved 20260822020000+ allocation
-- `20260822020000_mi1_w1_feature_persistence.sql`.
--
-- Bundles sharing this migration: QA (CR-018), analytics (CR-035–039, 049),
-- pay (CR-045–046), integrations (CR-092–093), audit/job health (CR-106–107),
-- and public directory (CR-113–114). Public RSVP stays service-role-only so
-- it can share the file without granting anon table access.
--
-- Donor SHA donor-baseline-20260721 is behavior-only. This
-- file does not replay donor migrations 0304, 0311, 0633, 0752, audit_log, or
-- cron_runs, and it does not seed organizations or SAMPLE rows.
--
-- Supabase guidance checked 2026-08-22: changelog.md had no new
-- migration-breaking tag for RLS/RPC; RLS guide requires grants and policies
-- to be set separately; database-functions guide requires empty search_path
-- and revoked PUBLIC execute on definers.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Expand the foundation tenant audit envelope for first-wave actions
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
    'organization_job_retry_requested'
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
      'exportType', 'cadence'
    ] = '{}'::jsonb
  );

alter table public.public_site_records
  add column organization_id uuid references public.organizations(id) on update cascade on delete restrict,
  add column chapter_code text;

create index public_site_records_organization_published_idx
  on public.public_site_records (organization_id, kind, sort_order)
  where is_published and organization_id is not null;

comment on column public.public_site_records.organization_id is
  'Owning tenant. NULL is a quarantined pre-MI1/orphan public card and never authorizes a public RSVP.';
comment on column public.public_site_records.chapter_code is
  'Public chapter code for directory/microsite pairing. Not a caller-selected tenant key.';

drop policy public_site_records_staff_read on public.public_site_records;
drop policy public_site_records_staff_create on public.public_site_records;
drop policy public_site_records_staff_update on public.public_site_records;
drop policy public_site_records_staff_delete on public.public_site_records;

create policy public_site_records_staff_read on public.public_site_records
  for select to authenticated
  using (
    organization_id is not null
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  );
create policy public_site_records_staff_create on public.public_site_records
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and organization_id is not null
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  );
create policy public_site_records_staff_update on public.public_site_records
  for update to authenticated
  using (
    organization_id is not null
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  )
  with check (
    organization_id is not null
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  );
create policy public_site_records_staff_delete on public.public_site_records
  for delete to authenticated
  using (
    organization_id is not null
    and private.has_organization_role(
      organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
  );

alter table public.member_cases
  add column organization_id uuid references public.organizations(id) on update cascade on delete restrict,
  add column chapter_id text references public.chapters(id) on update cascade on delete restrict;

update public.member_cases cs
set organization_id = ch.organization_id,
    chapter_id = ch.id
from public.member_profiles p
join public.chapters ch on ch.id = p.chapter_id
where p.id = cs.user_id
  and cs.organization_id is null;

create index member_cases_organization_chapter_idx
  on public.member_cases (organization_id, chapter_id, status)
  where organization_id is not null;

comment on column public.member_cases.organization_id is
  'Immutable case tenant. NULL is a quarantined legacy case that is excluded from organization analytics.';
comment on column public.member_cases.chapter_id is
  'Immutable chapter at case creation. Current profile chapter changes never re-home historical cases.';

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.member_qa_questions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'replied', 'accepted')),
  accepted_reply_id uuid,
  upvote_count integer not null default 0 check (upvote_count >= 0),
  idempotency_key uuid,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  deleted_at timestamptz,
  constraint member_qa_questions_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 8 and 200
    and title !~ '[[:cntrl:]]'
  ),
  constraint member_qa_questions_body_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(body)) between 12 and 10000
  )
);

create unique index member_qa_questions_idempotency_key
  on public.member_qa_questions (organization_id, idempotency_key)
  where idempotency_key is not null;
create index member_qa_questions_org_chapter_idx
  on public.member_qa_questions (organization_id, chapter_id, created_at desc)
  where deleted_at is null;

create table public.member_qa_replies (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  question_id uuid not null references public.member_qa_questions(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('official', 'follow_up')),
  body text not null,
  accepted boolean not null default false,
  upvote_count integer not null default 0 check (upvote_count >= 0),
  idempotency_key uuid,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  deleted_at timestamptz,
  constraint member_qa_replies_body_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(body)) between 12 and 10000
  )
);

create unique index member_qa_replies_idempotency_key
  on public.member_qa_replies (organization_id, idempotency_key)
  where idempotency_key is not null;
create index member_qa_replies_question_idx
  on public.member_qa_replies (question_id, created_at)
  where deleted_at is null;

alter table public.member_qa_questions
  add constraint member_qa_questions_accepted_reply_fkey
  foreign key (accepted_reply_id) references public.member_qa_replies(id) on delete set null;

create table public.member_qa_votes (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  question_id uuid references public.member_qa_questions(id) on delete cascade,
  reply_id uuid references public.member_qa_replies(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now(),
  constraint member_qa_votes_one_target check (
    (question_id is null) <> (reply_id is null)
  )
);

create unique index member_qa_votes_question_key
  on public.member_qa_votes (user_id, question_id)
  where question_id is not null;
create unique index member_qa_votes_reply_key
  on public.member_qa_votes (user_id, reply_id)
  where reply_id is not null;

create table public.organization_page_views (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  path text not null check (pg_catalog.char_length(path) between 1 and 200 and path !~ '[[:cntrl:]]'),
  hat text not null check (hat in ('member', 'steward', 'coordinator', 'advisor', 'admin', 'vp')),
  day date not null,
  view_count integer not null default 0 check (view_count >= 0),
  primary key (organization_id, path, hat, day)
);

create table public.organization_engagement_events (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  event_type text not null check (event_type in (
    'meeting_check_in', 'qa_contribution', 'poll_vote', 'survey_response',
    'event_rsvp', 'authorized_contact'
  )),
  source_id text not null check (pg_catalog.char_length(source_id) between 1 and 128),
  occurred_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, user_id, event_type, source_id)
);

create table public.organization_analytics_exports (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  export_format text not null check (export_format in ('csv', 'json')),
  expires_at timestamptz not null,
  row_count integer not null default 0 check (row_count >= 0),
  suppressed_count integer not null default 0 check (suppressed_count >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now()
);

create table public.pay_scale_grades (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  grade text not null,
  title text not null,
  job_family text,
  step_count integer check (step_count is null or (step_count between 1 and 99)),
  description text,
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, grade),
  constraint pay_scale_grades_grade_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(grade)) between 1 and 32
    and grade !~ '[[:cntrl:]]'
  ),
  constraint pay_scale_grades_title_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 120
  )
);

create table public.pay_scale_steps (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  grade text not null,
  effective_on date not null,
  step_number integer not null check (step_number between 1 and 99),
  hourly_rate_cents integer not null check (hourly_rate_cents between 1 and 10000000),
  primary key (organization_id, grade, effective_on, step_number),
  foreign key (organization_id, grade)
    references public.pay_scale_grades (organization_id, grade)
    on delete cascade
);

create table public.organization_integrations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  provider text not null check (provider in (
    'twilio', 'google_calendar', 'microsoft_calendar', 'constant_contact',
    'cba_ingest', 'customer_webhooks', 'customer_api', 'scim'
  )),
  status text not null default 'unset' check (status in (
    'unset', 'requested', 'configured', 'connected', 'degraded', 'revoked', 'disabled'
  )),
  account_owner text not null default 'organization' check (account_owner in ('organization', 'chapter')),
  allow_chapter_overrides boolean not null default false,
  allow_chapter_owned_accounts boolean not null default false,
  allowed_chapter_override_keys text[] not null default '{}'::text[],
  default_settings jsonb not null default '{}'::jsonb,
  credential_ref text,
  last_job_status text,
  last_error_code text,
  updated_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, provider),
  constraint organization_integrations_settings_object check (pg_catalog.jsonb_typeof(default_settings) = 'object'),
  constraint organization_integrations_scim_disabled check (
    provider <> 'scim' or status = 'disabled'
  )
);

create table public.chapter_integration_overrides (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  organization_integration_id uuid not null references public.organization_integrations(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  status text not null default 'inherit' check (status in ('inherit', 'enabled', 'disabled')),
  override_settings jsonb not null default '{}'::jsonb,
  credential_ref text,
  unique (organization_integration_id, chapter_id),
  constraint chapter_integration_overrides_settings_object check (pg_catalog.jsonb_typeof(override_settings) = 'object')
);

create table public.integration_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text references public.chapters(id) on update cascade on delete restrict,
  provider text not null,
  job_kind text not null check (job_kind in (
    'provider_health', 'connection_probe', 'webhook_deliver', 'webhook_retry'
  )),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'success', 'failed', 'skipped', 'dead'
  )),
  idempotency_key text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  error_code text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create unique index integration_jobs_org_idempotency_key
  on public.integration_jobs (organization_id, idempotency_key)
  where idempotency_key is not null;

create table public.integration_webhooks (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  url text not null,
  events text[] not null default '{}'::text[],
  secret_hash text not null,
  active boolean not null default true,
  last_delivery_at timestamptz,
  last_delivery_status text,
  created_at timestamptz not null default pg_catalog.now(),
  constraint integration_webhooks_url_bounded check (pg_catalog.char_length(url) between 12 and 500),
  constraint integration_webhooks_secret_hash_hex check (secret_hash ~ '^[0-9a-f]{64}$')
);

create table public.integration_webhook_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  webhook_id uuid not null references public.integration_webhooks(id) on delete cascade,
  event_name text not null,
  event_id text not null,
  idempotency_key text not null,
  status text not null check (status in ('queued', 'ok', 'failed', 'skipped', 'blocked', 'dead')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_code text,
  destination_host text,
  created_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, idempotency_key)
);

create table public.integration_api_keys (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  name text not null check (pg_catalog.char_length(pg_catalog.btrim(name)) between 1 and 80),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  key_prefix text not null check (pg_catalog.char_length(key_prefix) between 4 and 16),
  revoked_at timestamptz,
  last_rotated_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  unique (key_hash)
);

create table public.scim_tokens (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now(),
  unique (organization_id, token_hash)
);

comment on table public.scim_tokens is
  'Enterprise-later SCIM custody. Empty on reset. No authenticated insert path.';

create table public.organization_audit_ledger (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  domain text not null check (domain in (
    'administration', 'casework', 'messages', 'data_access', 'community_events',
    'security', 'membership', 'communications', 'knowledge', 'operations',
    'exports', 'rewards'
  )),
  event_type text not null,
  action text not null check (action in (
    'create', 'update', 'delete', 'read', 'export', 'grant', 'revoke', 'send',
    'settings_change', 'login', 'acknowledge', 'retry_requested'
  )),
  actor_user_id uuid references auth.users(id) on delete set null,
  entity_type text not null check (entity_type in (
    'organization', 'chapter', 'membership', 'role_grant', 'member', 'case',
    'message', 'event', 'campaign', 'broadcast', 'invitation', 'export',
    'document', 'reward', 'job_run', 'security_policy', 'audit_event'
  )),
  entity_id text,
  occurred_at timestamptz not null default pg_catalog.now(),
  idempotency_key uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  source text not null default 'organization_audit_ledger',
  constraint organization_audit_ledger_idempotency_key unique (idempotency_key),
  constraint organization_audit_ledger_metadata_object check (pg_catalog.jsonb_typeof(metadata) = 'object'),
  constraint organization_audit_ledger_metadata_bounded check (pg_catalog.octet_length(metadata::text) <= 2048),
  constraint organization_audit_ledger_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId', 'status',
      'requireStaffMfa', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'action', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence'
    ] = '{}'::jsonb
  ),
  constraint organization_audit_ledger_entity_id_bounded check (
    entity_id is null or pg_catalog.char_length(entity_id) <= 128
  )
);

create index organization_audit_ledger_org_occurred_idx
  on public.organization_audit_ledger (organization_id, occurred_at desc, id desc);

create table public.organization_job_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid references public.organizations(id) on update cascade on delete restrict,
  job_name text not null check (job_name in (
    'notifications-dispatch-tick',
    'notifications-expiry-sweep',
    'deadline-notices-tick',
    'ballot-notices-tick',
    'event-notices-tick',
    'appointment-reminders-tick',
    'member-messaging-dispatch',
    'workload-reminders-tick',
    'ballot-choices-mix',
    'ballot-choices-mix-recent',
    'task-files-reconcile-tick',
    'task-maintenance-daily'
  )),
  run_id text not null,
  status text not null check (status in ('in_progress', 'completed', 'failed', 'skipped')),
  started_at timestamptz not null default pg_catalog.now(),
  finished_at timestamptz,
  failure_code text,
  redacted_summary text,
  unique nulls not distinct (job_name, run_id, organization_id)
);

create table public.organization_job_acknowledgements (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  job_name text not null,
  run_id text not null,
  acknowledged_by uuid references auth.users(id) on delete set null,
  remediation text not null check (remediation in ('acknowledge', 'request_retry')),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, job_name, run_id)
);

create table public.public_event_rsvps (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  event_id text not null,
  email text not null,
  name text,
  locale text not null check (locale in ('en', 'es')),
  created_at timestamptz not null default pg_catalog.now(),
  constraint public_event_rsvps_email_normalized check (
    email = pg_catalog.lower(pg_catalog.btrim(email))
    and pg_catalog.char_length(email) between 3 and 254
  ),
  constraint public_event_rsvps_name_bounded check (
    name is null or pg_catalog.char_length(name) between 1 and 100
  ),
  unique (event_id, email)
);

create table private.public_event_rsvp_limits (
  scope_hash text not null check (scope_hash ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in ('network-15m', 'email-event-day')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  primary key (scope_hash, operation)
);

revoke all on private.public_event_rsvp_limits
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------

create function private.mi1_forbid_ownerless_public_publish()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  referenced_organization uuid;
begin
  if new.is_published and new.organization_id is null then
    raise exception 'published public records require an organization' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.organization_id is not null
     and new.organization_id is distinct from old.organization_id then
    raise exception 'public record organization is immutable' using errcode = '42501';
  end if;
  if new.kind = 'meeting' and new.chapter_code is not null then
    select r.organization_id into referenced_organization
    from public.public_site_records r
    where r.id = new.chapter_code
      and r.kind = 'chapter';
    if referenced_organization is null
       or referenced_organization is distinct from new.organization_id then
      raise exception 'meeting chapter must belong to the same organization' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

create trigger public_site_records_require_organization
  before insert or update on public.public_site_records
  for each row execute function private.mi1_forbid_ownerless_public_publish();

create function private.mi1_bind_case_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  owner_organization uuid;
  owner_chapter text;
begin
  if tg_op = 'UPDATE' then
    if old.organization_id is null then
      if new.organization_id is not null or new.chapter_id is not null then
        raise exception 'legacy case ownership requires an explicit backfill' using errcode = '42501';
      end if;
      return new;
    else
      if new.organization_id is distinct from old.organization_id
         or new.chapter_id is distinct from old.chapter_id then
        raise exception 'case organization and chapter are immutable' using errcode = '42501';
      end if;
      return new;
    end if;
  end if;

  select ch.organization_id, ch.id
  into owner_organization, owner_chapter
  from public.member_profiles p
  join public.chapters ch on ch.id = p.chapter_id
  where p.id = new.user_id;

  if owner_chapter is null then
    raise exception 'case owner requires a current organization chapter' using errcode = '23514';
  end if;
  if owner_organization is null then
    if new.organization_id is not null or new.chapter_id is not null then
      raise exception 'legacy case ownership cannot be supplied by the caller' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.organization_id is not null and new.organization_id is distinct from owner_organization then
    raise exception 'case organization is derived from the member chapter' using errcode = '42501';
  end if;
  if new.chapter_id is not null and new.chapter_id is distinct from owner_chapter then
    raise exception 'case chapter is derived from the member profile' using errcode = '42501';
  end if;

  new.organization_id := owner_organization;
  new.chapter_id := owner_chapter;
  return new;
end;
$function$;

create trigger member_cases_bind_organization
  before insert or update on public.member_cases
  for each row execute function private.mi1_bind_case_owner();

create function private.mi1_qa_reply_same_organization()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  question_org uuid;
begin
  select q.organization_id into question_org
  from public.member_qa_questions q
  where q.id = new.question_id;
  if question_org is null or question_org is distinct from new.organization_id then
    raise exception 'reply organization must match the question' using errcode = '23514';
  end if;
  return new;
end;
$function$;

create trigger member_qa_replies_same_organization
  before insert or update on public.member_qa_replies
  for each row execute function private.mi1_qa_reply_same_organization();

create function private.mi1_audit_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'organization audit ledger is append-only' using errcode = '55000';
end;
$function$;

create trigger organization_audit_ledger_append_only
  before update or delete on public.organization_audit_ledger
  for each row execute function private.mi1_audit_ledger_append_only();

revoke all on function private.mi1_forbid_ownerless_public_publish() from public, anon, authenticated, service_role;
revoke all on function private.mi1_qa_reply_same_organization() from public, anon, authenticated, service_role;
revoke all on function private.mi1_audit_ledger_append_only() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. RLS, policies, grants
-- ---------------------------------------------------------------------------

alter table public.member_qa_questions enable row level security;
alter table public.member_qa_replies enable row level security;
alter table public.member_qa_votes enable row level security;
alter table public.organization_page_views enable row level security;
alter table public.organization_engagement_events enable row level security;
alter table public.organization_analytics_exports enable row level security;
alter table public.pay_scale_grades enable row level security;
alter table public.pay_scale_steps enable row level security;
alter table public.organization_integrations enable row level security;
alter table public.chapter_integration_overrides enable row level security;
alter table public.integration_jobs enable row level security;
alter table public.integration_webhooks enable row level security;
alter table public.integration_webhook_deliveries enable row level security;
alter table public.integration_api_keys enable row level security;
alter table public.scim_tokens enable row level security;
alter table public.organization_audit_ledger enable row level security;
alter table public.organization_job_runs enable row level security;
alter table public.organization_job_acknowledgements enable row level security;
alter table public.public_event_rsvps enable row level security;

create policy pay_scale_grades_select_member on public.pay_scale_grades
  for select to authenticated
  using (private.is_organization_member(organization_id));
create policy pay_scale_steps_select_member on public.pay_scale_steps
  for select to authenticated
  using (private.is_organization_member(organization_id));
create policy organization_audit_ledger_select_admin on public.organization_audit_ledger
  for select to authenticated
  using (private.has_organization_role(organization_id, array['admin']));

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'member_qa_questions',
    'member_qa_replies',
    'member_qa_votes',
    'organization_page_views',
    'organization_engagement_events',
    'organization_analytics_exports',
    'pay_scale_grades',
    'pay_scale_steps',
    'organization_integrations',
    'chapter_integration_overrides',
    'integration_jobs',
    'integration_webhooks',
    'integration_webhook_deliveries',
    'integration_api_keys',
    'scim_tokens',
    'organization_audit_ledger',
    'organization_job_runs',
    'organization_job_acknowledgements',
    'public_event_rsvps'
  ]
  loop
    execute format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
  end loop;
end
$$;

revoke all on public.member_qa_questions from public, anon, authenticated;
revoke all on public.member_qa_replies from public, anon, authenticated;
revoke all on public.member_qa_votes from public, anon, authenticated;
revoke all on public.organization_page_views from public, anon, authenticated;
revoke all on public.organization_engagement_events from public, anon, authenticated;
revoke all on public.organization_analytics_exports from public, anon, authenticated;
revoke all on public.pay_scale_grades from public, anon, authenticated;
revoke all on public.pay_scale_steps from public, anon, authenticated;
revoke all on public.organization_integrations from public, anon, authenticated;
revoke all on public.chapter_integration_overrides from public, anon, authenticated;
revoke all on public.integration_jobs from public, anon, authenticated;
revoke all on public.integration_webhooks from public, anon, authenticated;
revoke all on public.integration_webhook_deliveries from public, anon, authenticated;
revoke all on public.integration_api_keys from public, anon, authenticated;
revoke all on public.scim_tokens from public, anon, authenticated;
revoke all on public.organization_audit_ledger from public, anon, authenticated;
revoke all on public.organization_job_runs from public, anon, authenticated;
revoke all on public.organization_job_acknowledgements from public, anon, authenticated;
revoke all on public.public_event_rsvps from public, anon, authenticated;

grant select on public.pay_scale_grades to authenticated;
grant select on public.pay_scale_steps to authenticated;
grant select on public.organization_audit_ledger to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Private helpers
-- ---------------------------------------------------------------------------

create function private.mi1_require_selected_organization()
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

create function private.mi1_qa_display_name(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.concat_ws(
    ' ',
    nullif(pg_catalog.btrim(p.first_name), ''),
    case
      when p.full_name ~ '\s+\S+'
        then pg_catalog.upper(pg_catalog.left(pg_catalog.regexp_replace(p.full_name, '^.*\s+', ''), 1)) || '.'
      else null
    end
  )
  from public.member_profiles p
  where p.id = p_user_id
$function$;

create function private.mi1_qa_is_officer(p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.has_organization_role(
      p_organization_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
    or private.member_has_chapter_role(
      p_chapter_id,
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']
    )
$function$;

create function private.mi1_qa_can_see(p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.is_organization_member(p_organization_id)
    and (
      p_chapter_id = private.current_member_chapter()
      or private.mi1_qa_is_officer(p_organization_id, p_chapter_id)
    )
$function$;

create function private.mi1_write_tenant_audit(
  p_organization_id uuid,
  p_event_type text,
  p_metadata jsonb
)
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

create function private.consume_public_event_rsvp_limit(
  p_scope_hash text,
  p_operation text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_row private.public_event_rsvp_limits%rowtype;
  moment timestamptz := clock_timestamp();
begin
  if p_scope_hash is null
     or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_operation not in ('network-15m', 'email-event-day')
     or p_limit < 1
     or p_window <= interval '0 seconds' then
    raise exception 'invalid public event rsvp rate limit' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public-event-rsvp-rate:' || p_operation || ':' || p_scope_hash,
      509
    )
  );

  select * into current_row
  from private.public_event_rsvp_limits
  where scope_hash = p_scope_hash and operation = p_operation
  for update;

  if not found then
    insert into private.public_event_rsvp_limits
      (scope_hash, operation, window_started_at, request_count)
    values (p_scope_hash, p_operation, moment, 1);
    return true;
  end if;

  if current_row.window_started_at + p_window <= moment then
    update private.public_event_rsvp_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = p_scope_hash and operation = p_operation;
    return true;
  end if;

  if current_row.request_count >= p_limit then
    return false;
  end if;

  update private.public_event_rsvp_limits
  set request_count = request_count + 1
  where scope_hash = p_scope_hash and operation = p_operation;
  return true;
end;
$function$;

revoke all on function private.mi1_require_selected_organization() from public, anon, authenticated, service_role;
revoke all on function private.mi1_qa_display_name(uuid) from public, anon, authenticated, service_role;
revoke all on function private.mi1_qa_is_officer(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.mi1_qa_can_see(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.mi1_write_tenant_audit(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.mi1_bind_case_owner() from public, anon, authenticated, service_role;
revoke all on function private.consume_public_event_rsvp_limit(text, text, integer, interval)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Q&A RPCs
-- ---------------------------------------------------------------------------

create function private.mi1_qa_project_question(p_question_id uuid, p_actor uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', q.id,
    'organizationId', q.organization_id,
    'chapterId', q.chapter_id,
    'title', q.title,
    'body', q.body,
    'status', q.status,
    'acceptedReplyId', q.accepted_reply_id,
    'upvoteCount', q.upvote_count,
    'votedByMe', exists (
      select 1 from public.member_qa_votes v
      where v.question_id = q.id and v.user_id = p_actor
    ),
    'authorDisplayName', private.mi1_qa_display_name(q.author_user_id),
    'createdAt', q.created_at,
    'updatedAt', q.updated_at,
    'deletedAt', q.deleted_at,
    'replyCount', (
      select pg_catalog.count(*) from public.member_qa_replies r
      where r.question_id = q.id and r.deleted_at is null
    ),
    'officialReplyCount', (
      select pg_catalog.count(*) from public.member_qa_replies r
      where r.question_id = q.id and r.deleted_at is null and r.kind = 'official'
    ),
    'replies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'questionId', r.question_id,
        'kind', r.kind,
        'body', r.body,
        'accepted', r.accepted,
        'upvoteCount', r.upvote_count,
        'votedByMe', exists (
          select 1 from public.member_qa_votes v
          where v.reply_id = r.id and v.user_id = p_actor
        ),
        'authorDisplayName', private.mi1_qa_display_name(r.author_user_id),
        'createdAt', r.created_at,
        'updatedAt', r.updated_at,
        'deletedAt', r.deleted_at
      ) order by r.created_at, r.id)
      from (
        select limited.*
        from public.member_qa_replies limited
        where limited.question_id = q.id
          and limited.deleted_at is null
        order by limited.created_at, limited.id
        limit 100
      ) r
    ), '[]'::jsonb)
  )
  from public.member_qa_questions q
  where q.id = p_question_id
$function$;

revoke all on function private.mi1_qa_project_question(uuid, uuid) from public, anon, authenticated, service_role;

create function public.list_member_qa_questions(p_query text, p_status text, p_sort text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  chapter text := private.current_member_chapter();
  wanted_status text := nullif(p_status, '');
  wanted_sort text := coalesce(nullif(p_sort, ''), 'newest');
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if wanted_status is not null and wanted_status not in ('open', 'replied', 'accepted') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if wanted_sort not in ('newest', 'votes', 'unanswered') then
    raise exception 'invalid sort' using errcode = '22023';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(private.mi1_qa_project_question(q.id, (select auth.uid())) order by
      case when wanted_sort = 'votes' then q.upvote_count else 0 end desc,
      case when wanted_sort = 'unanswered' and q.status = 'open' then 0 else 1 end,
      q.created_at desc, q.id desc)
    from (
      select candidate.id, candidate.upvote_count, candidate.status, candidate.created_at
      from public.member_qa_questions candidate
      where candidate.organization_id = org
        and candidate.deleted_at is null
        and candidate.chapter_id = chapter
        and (wanted_status is null or candidate.status = wanted_status)
        and (
          needle is null
          or candidate.title ilike '%' || needle || '%'
          or candidate.body ilike '%' || needle || '%'
          or exists (
            select 1 from public.member_qa_replies r
            where r.question_id = candidate.id
              and r.deleted_at is null
              and r.body ilike '%' || needle || '%'
          )
        )
      order by
        case when wanted_sort = 'votes' then candidate.upvote_count else 0 end desc,
        case when wanted_sort = 'unanswered' and candidate.status = 'open' then 0 else 1 end,
        candidate.created_at desc, candidate.id desc
      limit 50
    ) q
  ), '[]'::jsonb);
end;
$function$;

create function public.search_member_qa_history(p_query text, p_status text, p_sort text)
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
  return public.list_member_qa_questions(p_query, p_status, p_sort);
end;
$function$;

create function public.get_member_qa_question(p_question_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id;
  if not found
     or question.organization_id is distinct from org
     or question.deleted_at is not null
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create function public.ask_member_qa_question(p_title text, p_body text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  chapter text := private.current_member_chapter();
  existing uuid;
  existing_deleted_at timestamptz;
  created uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) or chapter is null then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_idempotency_key is not null then
    select id, deleted_at into existing, existing_deleted_at
    from public.member_qa_questions
    where organization_id = org and idempotency_key = p_idempotency_key
    for share;
    if existing is not null then
      if existing_deleted_at is not null then
        return pg_catalog.jsonb_build_object('id', existing, 'deleted', true);
      end if;
      return private.mi1_qa_project_question(existing, (select auth.uid()));
    end if;
  end if;

  insert into public.member_qa_questions (
    organization_id, chapter_id, author_user_id, title, body, idempotency_key
  ) values (
    org, chapter, (select auth.uid()), pg_catalog.btrim(p_title), pg_catalog.btrim(p_body), p_idempotency_key
  ) returning id into created;

  perform private.mi1_write_tenant_audit(org, 'qa_question_asked', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'questionId', created, 'status', 'open'
  ));
  return private.mi1_qa_project_question(created, (select auth.uid()));
end;
$function$;

create function public.reply_member_qa_official(p_question_id uuid, p_body text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  existing uuid;
  created uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  if not found or question.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is not null then
    select id into existing
    from public.member_qa_replies
    where organization_id = org and idempotency_key = p_idempotency_key;
    if existing is not null then
      return private.mi1_qa_project_question(question.id, (select auth.uid()));
    end if;
  end if;

  insert into public.member_qa_replies (
    organization_id, question_id, author_user_id, kind, body, idempotency_key
  ) values (
    org, question.id, (select auth.uid()), 'official', pg_catalog.btrim(p_body), p_idempotency_key
  ) returning id into created;

  update public.member_qa_questions
  set status = case when status = 'accepted' then status else 'replied' end,
      updated_at = pg_catalog.now()
  where id = question.id;

  perform private.mi1_write_tenant_audit(org, 'qa_official_replied', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', created, 'kind', 'official'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create function public.reply_member_qa_follow_up(p_question_id uuid, p_body text, p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  existing uuid;
  created uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  if not found
     or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_idempotency_key is not null then
    select id into existing
    from public.member_qa_replies
    where organization_id = org and idempotency_key = p_idempotency_key;
    if existing is not null then
      return private.mi1_qa_project_question(question.id, (select auth.uid()));
    end if;
  end if;

  insert into public.member_qa_replies (
    organization_id, question_id, author_user_id, kind, body, idempotency_key
  ) values (
    org, question.id, (select auth.uid()), 'follow_up', pg_catalog.btrim(p_body), p_idempotency_key
  ) returning id into created;

  update public.member_qa_questions
  set status = case when status = 'accepted' then status else 'replied' end,
      updated_at = pg_catalog.now()
  where id = question.id;

  perform private.mi1_write_tenant_audit(org, 'qa_follow_up_replied', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', created, 'kind', 'follow_up'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create function public.toggle_member_qa_vote(p_target_kind text, p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  reply public.member_qa_replies%rowtype;
  voted boolean;
  next_count integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_target_kind not in ('question', 'reply') then
    raise exception 'invalid vote target' using errcode = '22023';
  end if;

  if p_target_kind = 'question' then
    select * into question from public.member_qa_questions where id = p_target_id and deleted_at is null;
  else
    select * into reply from public.member_qa_replies where id = p_target_id and deleted_at is null;
    if found then
      select * into question from public.member_qa_questions where id = reply.question_id and deleted_at is null;
    end if;
  end if;

  if question.id is null
     or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  if p_target_kind = 'question' then
    delete from public.member_qa_votes
    where user_id = (select auth.uid()) and question_id = question.id;
    if found then
      voted := false;
    else
      insert into public.member_qa_votes (organization_id, user_id, question_id)
      values (org, (select auth.uid()), question.id);
      voted := true;
    end if;
    update public.member_qa_questions q
    set upvote_count = (
      select pg_catalog.count(*) from public.member_qa_votes v where v.question_id = q.id
    )
    where q.id = question.id
    returning upvote_count into next_count;
  else
    delete from public.member_qa_votes
    where user_id = (select auth.uid()) and reply_id = reply.id;
    if found then
      voted := false;
    else
      insert into public.member_qa_votes (organization_id, user_id, reply_id)
      values (org, (select auth.uid()), reply.id);
      voted := true;
    end if;
    update public.member_qa_replies r
    set upvote_count = (
      select pg_catalog.count(*) from public.member_qa_votes v where v.reply_id = r.id
    )
    where r.id = reply.id
    returning upvote_count into next_count;
  end if;

  perform private.mi1_write_tenant_audit(org, 'qa_vote_toggled', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'targetKind', p_target_kind, 'voted', voted
  ));
  return pg_catalog.jsonb_build_object(
    'voted', voted,
    'upvoteCount', next_count,
    'question', private.mi1_qa_project_question(question.id, (select auth.uid()))
  );
end;
$function$;

create function public.accept_member_qa_answer(p_question_id uuid, p_reply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  reply public.member_qa_replies%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if question.id is null
     or reply.id is null
     or question.organization_id is distinct from org
     or reply.organization_id is distinct from org
     or reply.question_id is distinct from question.id then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if reply.kind is distinct from 'official' then
    raise exception 'only official replies can be accepted' using errcode = '22023';
  end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.member_qa_replies set accepted = (id = reply.id) where question_id = question.id;
  update public.member_qa_questions
  set accepted_reply_id = reply.id, status = 'accepted', updated_at = pg_catalog.now()
  where id = question.id;

  perform private.mi1_write_tenant_audit(org, 'qa_answer_accepted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', reply.id, 'status', 'accepted'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create function public.edit_member_qa_question(p_question_id uuid, p_title text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  if not found or question.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_questions
  set title = pg_catalog.btrim(p_title), body = pg_catalog.btrim(p_body), updated_at = pg_catalog.now()
  where id = question.id;
  perform private.mi1_write_tenant_audit(org, 'qa_edited', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id, 'questionId', question.id, 'kind', 'question'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create function public.delete_member_qa_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null;
  if not found or question.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_questions set deleted_at = pg_catalog.now(), updated_at = pg_catalog.now() where id = question.id;
  perform private.mi1_write_tenant_audit(org, 'qa_deleted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id, 'questionId', question.id, 'kind', 'question'
  ));
  return pg_catalog.jsonb_build_object('deleted', true, 'id', question.id);
end;
$function$;

create function public.edit_member_qa_reply(p_reply_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  reply public.member_qa_replies%rowtype;
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into question from public.member_qa_questions where id = reply.question_id;
  if question.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if reply.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_replies
  set body = pg_catalog.btrim(p_body), updated_at = pg_catalog.now()
  where id = reply.id;
  perform private.mi1_write_tenant_audit(org, 'qa_edited', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', reply.id, 'kind', 'reply'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create function public.delete_member_qa_reply(p_reply_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  reply public.member_qa_replies%rowtype;
  question public.member_qa_questions%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select * into question from public.member_qa_questions where id = reply.question_id;
  if question.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if reply.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.member_qa_replies set deleted_at = pg_catalog.now(), accepted = false where id = reply.id;
  update public.member_qa_questions
  set accepted_reply_id = case
        when accepted_reply_id is not distinct from reply.id then null
        else accepted_reply_id
      end,
      status = case
        when accepted_reply_id is distinct from reply.id and status = 'accepted' then 'accepted'
        when exists (
          select 1 from public.member_qa_replies r
          where r.question_id = question.id and r.deleted_at is null
        ) then 'replied' else 'open'
      end,
      updated_at = pg_catalog.now()
  where id = question.id;
  perform private.mi1_write_tenant_audit(org, 'qa_deleted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', question.chapter_id,
    'questionId', question.id, 'replyId', reply.id, 'kind', 'reply'
  ));
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

create function public.list_member_qa_officer_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
     and not private.member_has_chapter_role(
       private.current_member_chapter(),
       array['steward', 'coordinator', 'advisor', 'admin', 'vp']
     ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(private.mi1_qa_project_question(q.id, (select auth.uid())) order by q.created_at, q.id)
    from (
      select candidate.id, candidate.created_at
      from public.member_qa_questions candidate
      where candidate.organization_id = org
        and candidate.deleted_at is null
        and candidate.status in ('open', 'replied')
        and private.mi1_qa_is_officer(candidate.organization_id, candidate.chapter_id)
      order by candidate.created_at, candidate.id
      limit 50
    ) q
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Analytics RPCs
-- ---------------------------------------------------------------------------

create function public.get_organization_analytics_snapshot()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := 5;
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  result := pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id,
        'label', c.name,
        'memberCount', case when member_totals.value >= privacy_threshold then member_totals.value else null end,
        'memberCountSuppressed', member_totals.value < privacy_threshold,
        'stewardCount', case when steward_totals.value >= privacy_threshold then steward_totals.value else null end,
        'stewardCountSuppressed', steward_totals.value < privacy_threshold
      ) order by c.name, c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value
        from public.member_chapter_memberships m
        where m.chapter_id = c.id and m.status = 'active'
      ) member_totals
      cross join lateral (
        select pg_catalog.count(distinct rc.user_id) as value
        from public.member_role_chapters rc
        join public.member_chapter_memberships m
          on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
        where rc.chapter_id = c.id and rc.role = 'steward'
      ) steward_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'chapterId', counted.chapter_id,
        'status', counted.status,
        'step', counted.step_bucket,
        'workplaceKey', counted.case_type,
        'count', counted.case_count
      ) order by counted.chapter_id, counted.status, counted.case_type, counted.step_bucket)
      from (
        select
          cs.chapter_id,
          cs.status,
          case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket,
          cs.case_type,
          pg_catalog.count(*) as case_count
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id is not null
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(*) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'usageViews', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', v.organization_id,
        'path', v.path,
        'hat', v.hat,
        'day', v.day,
        'count', v.view_count
      ) order by v.day, v.path)
      from public.organization_page_views v
      where v.organization_id = org
        and v.day >= (generated::date - 30)
        and v.view_count >= privacy_threshold
    ), '[]'::jsonb),
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        'dau', case when windows.dau >= privacy_threshold then windows.dau else null end,
        'wau', case when windows.wau >= privacy_threshold then windows.wau else null end,
        'mau', case when windows.mau >= privacy_threshold then windows.mau else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', windows.dau < privacy_threshold,
          'wau', windows.wau < privacy_threshold,
          'mau', windows.mau < privacy_threshold
        )
      )
      from (
        select
          pg_catalog.count(distinct user_id) filter (
            where occurred_at >= generated - interval '1 day'
          ) as dau,
          pg_catalog.count(distinct user_id) filter (
            where occurred_at >= generated - interval '7 days'
          ) as wau,
          pg_catalog.count(distinct user_id) filter (
            where occurred_at >= generated - interval '30 days'
          ) as mau
        from public.organization_engagement_events
        where organization_id = org
      ) windows
    ),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'openCases', case when case_totals.value >= privacy_threshold then case_totals.value else null end,
        'openCasesSuppressed', case_totals.value < privacy_threshold,
        'attendanceRate', null,
        'engagementMean', null,
        'usageViews', null
      ) order by c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.status = 'active'
      ) case_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'heatmapPoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'kind', 'grievance',
        'rowKey', counted.chapter_id,
        'colKey', counted.case_type,
        'count', counted.case_count
      ) order by counted.chapter_id, counted.case_type)
      from (
        select cs.chapter_id, cs.case_type, pg_catalog.count(*) as case_count
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id is not null
        group by cs.chapter_id, cs.case_type
        having pg_catalog.count(*) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', counted.chapter_id,
        'eventType', counted.event_type,
        'count', counted.event_count
      ) order by counted.chapter_id, counted.event_type)
      from (
        select e.chapter_id, e.event_type, pg_catalog.count(*) as event_count
        from public.organization_engagement_events e
        where e.organization_id = org
        group by e.chapter_id, e.event_type
        having pg_catalog.count(*) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementHistogram', pg_catalog.jsonb_build_object(
      'organizationId', org,
      'privacyThreshold', privacy_threshold
    ),
    'attendanceEvents', '[]'::jsonb,
    'attendanceCohorts', pg_catalog.jsonb_build_object(
      'organizationId', org,
      'firstTime', null,
      'repeat', null,
      'suppressed', true
    )
  );

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'organization_analytics_snapshot'
  ));
  return result;
end;
$function$;

create function public.request_organization_analytics_export(p_format text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  created uuid;
  expires timestamptz := pg_catalog.now() + interval '24 hours';
  fmt text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_format, '')));
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if fmt not in ('csv', 'json') then
    raise exception 'invalid export format' using errcode = '22023';
  end if;

  insert into public.organization_analytics_exports (
    organization_id, export_format, expires_at, created_by
  ) values (org, fmt, expires, (select auth.uid()))
  returning id into created;

  perform private.mi1_write_tenant_audit(org, 'analytics_export_requested', pg_catalog.jsonb_build_object(
    'organizationId', org, 'exportFormat', fmt, 'expiresAt', expires
  ));
  return pg_catalog.jsonb_build_object(
    'id', created,
    'organizationId', org,
    'format', fmt,
    'expiresAt', expires,
    'rowCount', 0,
    'suppressedCount', 0
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Pay RPCs
-- ---------------------------------------------------------------------------

create function public.list_pay_scale_grades()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', g.organization_id,
      'grade', g.grade,
      'title', g.title,
      'jobFamily', g.job_family,
      'stepCount', g.step_count,
      'description', g.description
    ) order by g.grade)
    from public.pay_scale_grades g
    where g.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

create function public.list_pay_scale_steps(p_grade text, p_effective_on date, p_step_number integer, p_effective_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'organizationId', s.organization_id,
      'grade', s.grade,
      'effectiveOn', s.effective_on,
      'stepNumber', s.step_number,
      'hourlyRateCents', s.hourly_rate_cents
    ) order by s.grade, s.effective_on desc, s.step_number)
    from public.pay_scale_steps s
    where s.organization_id = org
      and (p_grade is null or s.grade = p_grade)
      and (p_effective_on is null or s.effective_on <= p_effective_on)
      and (p_step_number is null or s.step_number = p_step_number)
      and (p_effective_year is null or pg_catalog.date_part('year', s.effective_on) = p_effective_year)
  ), '[]'::jsonb);
end;
$function$;

create function public.upsert_pay_scale_grade(p_grade text, p_title text, p_job_family text, p_step_count integer, p_description text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  normalized text := pg_catalog.btrim(p_grade);
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform 1
  from public.pay_scale_grades g
  where g.organization_id = org and g.grade = normalized
  for update;
  if p_step_count is not null and exists (
    select 1 from public.pay_scale_steps s
    where s.organization_id = org
      and s.grade = normalized
      and s.step_number > p_step_count
  ) then
    raise exception 'step count is below an existing scale step' using errcode = '22023';
  end if;
  insert into public.pay_scale_grades (
    organization_id, grade, title, job_family, step_count, description
  ) values (
    org, normalized, pg_catalog.btrim(p_title), nullif(pg_catalog.btrim(coalesce(p_job_family, '')), ''),
    p_step_count, nullif(pg_catalog.btrim(coalesce(p_description, '')), '')
  )
  on conflict (organization_id, grade) do update
    set title = excluded.title,
        job_family = excluded.job_family,
        step_count = excluded.step_count,
        description = excluded.description,
        updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'pay_scale_grade_upserted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'grade', normalized, 'action', 'upsert_grade'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'organizationId', org, 'grade', normalized);
end;
$function$;

create function public.upsert_pay_scale_step(p_grade text, p_effective_on date, p_step_number integer, p_hourly_rate_cents integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  normalized text := pg_catalog.btrim(p_grade);
  declared_step_count integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select g.step_count into declared_step_count
  from public.pay_scale_grades g
  where g.organization_id = org and g.grade = normalized
  for update;
  if not found or (declared_step_count is not null and p_step_number > declared_step_count) then
    raise exception 'scale or step not found' using errcode = 'P0002';
  end if;
  insert into public.pay_scale_steps (
    organization_id, grade, effective_on, step_number, hourly_rate_cents
  ) values (org, normalized, p_effective_on, p_step_number, p_hourly_rate_cents)
  on conflict (organization_id, grade, effective_on, step_number) do update
    set hourly_rate_cents = excluded.hourly_rate_cents;
  perform private.mi1_write_tenant_audit(org, 'pay_scale_step_upserted', pg_catalog.jsonb_build_object(
    'organizationId', org, 'grade', normalized, 'stepNumber', p_step_number,
    'effectiveOn', p_effective_on, 'action', 'upsert_step'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'organizationId', org, 'grade', normalized);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Integration RPCs
-- ---------------------------------------------------------------------------

create function private.mi1_require_integration_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.has_organization_role(org, array['admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return org;
end;
$function$;

revoke all on function private.mi1_require_integration_admin() from public, anon, authenticated, service_role;

create function public.list_organization_integrations()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', i.id,
      'organizationId', i.organization_id,
      'provider', i.provider,
      'status', i.status,
      'accountOwner', i.account_owner,
      'allowChapterOverrides', i.allow_chapter_overrides,
      'allowChapterOwnedAccounts', i.allow_chapter_owned_accounts,
      'allowedChapterOverrideKeys', i.allowed_chapter_override_keys,
      'defaultSettings', i.default_settings,
      'hasCredentialRef', i.credential_ref is not null,
      'lastJobStatus', i.last_job_status,
      'lastErrorCode', i.last_error_code
    ) order by i.provider)
    from public.organization_integrations i
    where i.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

create function public.upsert_organization_integration(
  p_provider text,
  p_status text,
  p_account_owner text,
  p_allow_chapter_overrides boolean,
  p_allow_chapter_owned_accounts boolean,
  p_allowed_chapter_override_keys text[],
  p_default_settings jsonb,
  p_credential_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  next_status text := coalesce(nullif(p_status, ''), 'unset');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_provider = 'scim' then
    next_status := 'disabled';
  end if;
  if p_provider = 'scim' and p_status in ('connected', 'configured', 'requested') then
    raise exception 'SCIM stays disabled until the enterprise-later gate' using errcode = '42501';
  end if;
  insert into public.organization_integrations (
    organization_id, provider, status, account_owner, allow_chapter_overrides,
    allow_chapter_owned_accounts, allowed_chapter_override_keys, default_settings,
    credential_ref
  ) values (
    org, p_provider, next_status, coalesce(nullif(p_account_owner, ''), 'organization'),
    coalesce(p_allow_chapter_overrides, false),
    coalesce(p_allow_chapter_owned_accounts, false),
    coalesce(p_allowed_chapter_override_keys, '{}'::text[]),
    coalesce(p_default_settings, '{}'::jsonb),
    nullif(p_credential_ref, '')
  )
  on conflict (organization_id, provider) do update
    set status = excluded.status,
        account_owner = excluded.account_owner,
        allow_chapter_overrides = excluded.allow_chapter_overrides,
        allow_chapter_owned_accounts = excluded.allow_chapter_owned_accounts,
        allowed_chapter_override_keys = excluded.allowed_chapter_override_keys,
        default_settings = excluded.default_settings,
        credential_ref = excluded.credential_ref,
        updated_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'status', next_status
  ));
  return public.list_organization_integrations();
end;
$function$;

create function public.list_chapter_integration_overrides()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', o.id,
      'organizationId', o.organization_id,
      'organizationIntegrationId', o.organization_integration_id,
      'chapterId', o.chapter_id,
      'status', o.status,
      'overrideSettings', o.override_settings,
      'hasCredentialRef', o.credential_ref is not null
    ) order by o.chapter_id)
    from public.chapter_integration_overrides o
    where o.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

create function public.upsert_chapter_integration_override(
  p_provider text,
  p_chapter_id text,
  p_status text,
  p_override_settings jsonb,
  p_credential_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  integration_id uuid;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select i.id into integration_id
  from public.organization_integrations i
  where i.organization_id = org and i.provider = p_provider;
  if integration_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.chapters c
    where c.id = p_chapter_id and c.organization_id = org
  ) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  insert into public.chapter_integration_overrides (
    organization_id, organization_integration_id, chapter_id, status,
    override_settings, credential_ref
  ) values (
    org, integration_id, p_chapter_id, coalesce(nullif(p_status, ''), 'inherit'),
    coalesce(p_override_settings, '{}'::jsonb), nullif(p_credential_ref, '')
  )
  on conflict (organization_integration_id, chapter_id) do update
    set status = excluded.status,
        override_settings = excluded.override_settings,
        credential_ref = excluded.credential_ref;
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', p_provider, 'chapterId', p_chapter_id, 'status', coalesce(p_status, 'inherit')
  ));
  return public.list_chapter_integration_overrides();
end;
$function$;

create function public.list_integration_jobs()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', j.id,
      'organizationId', j.organization_id,
      'chapterId', j.chapter_id,
      'provider', j.provider,
      'jobKind', j.job_kind,
      'status', j.status,
      'attemptCount', j.attempt_count,
      'processedCount', j.processed_count,
      'errorCode', j.error_code,
      'createdAt', j.created_at
    ) order by j.created_at desc)
    from public.integration_jobs j
    where j.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

create function public.list_integration_webhooks()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', w.id,
      'organizationId', w.organization_id,
      'url', w.url,
      'events', w.events,
      'active', w.active,
      'lastDeliveryAt', w.last_delivery_at,
      'lastDeliveryStatus', w.last_delivery_status
    ) order by w.created_at desc)
    from public.integration_webhooks w
    where w.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

create function public.create_integration_webhook(p_url text, p_events text[], p_secret_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  host text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_url is null or p_url !~* '^https://'
     or p_url ~* 'localhost|127\.0\.0\.1|0\.0\.0\.0|::1|169\.254|10\.|192\.168\.' then
    raise exception 'invalid webhook url' using errcode = '22023';
  end if;
  host := (pg_catalog.regexp_match(p_url, '^https://([^/]+)'))[1];
  insert into public.integration_webhooks (organization_id, url, events, secret_hash)
  values (org, p_url, coalesce(p_events, '{}'::text[]), p_secret_hash);
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'host', host, 'events', coalesce(p_events, '{}'::text[]), 'status', 'created'
  ));
  return public.list_integration_webhooks();
end;
$function$;

create function public.set_integration_webhook_active(p_webhook_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  update public.integration_webhooks
  set active = coalesce(p_active, false)
  where id = p_webhook_id and organization_id = org;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', case when p_active then 'active' else 'inactive' end
  ));
  return public.list_integration_webhooks();
end;
$function$;

create function public.delete_integration_webhook(p_webhook_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  delete from public.integration_webhooks
  where id = p_webhook_id and organization_id = org;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', 'deleted'
  ));
  return public.list_integration_webhooks();
end;
$function$;

create function public.list_integration_api_keys()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', k.id,
      'organizationId', k.organization_id,
      'name', k.name,
      'keyPrefix', k.key_prefix,
      'revokedAt', k.revoked_at,
      'lastRotatedAt', k.last_rotated_at,
      'lastUsedAt', k.last_used_at
    ) order by k.created_at desc)
    from public.integration_api_keys k
    where k.organization_id = org
  ), '[]'::jsonb);
end;
$function$;

create function public.create_integration_api_key(p_name text, p_key_hash text, p_key_prefix text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  insert into public.integration_api_keys (organization_id, name, key_hash, key_prefix)
  values (org, pg_catalog.btrim(p_name), p_key_hash, p_key_prefix);
  perform private.mi1_write_tenant_audit(org, 'integration_api_key_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'name', pg_catalog.btrim(p_name), 'status', 'created'
  ));
  return public.list_integration_api_keys();
end;
$function$;

create function public.revoke_integration_api_key(p_key_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  update public.integration_api_keys
  set revoked_at = pg_catalog.now()
  where id = p_key_id and organization_id = org and revoked_at is null;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  perform private.mi1_write_tenant_audit(org, 'integration_api_key_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'status', 'revoked'
  ));
  return public.list_integration_api_keys();
end;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Audit ledger and job-health RPCs
-- ---------------------------------------------------------------------------

create function public.record_organization_audit_event(
  p_organization_id uuid,
  p_domain text,
  p_event_type text,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_idempotency_key uuid,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_org uuid := private.current_member_organization();
  org uuid;
  created uuid;
  existing public.organization_audit_ledger%rowtype;
begin
  if (select auth.uid()) is not null then
    org := session_org;
    if org is null or (p_organization_id is not null and p_organization_id is distinct from org) then
      raise exception 'audit organization is derived from the session' using errcode = '42501';
    end if;
  else
    org := p_organization_id;
    if org is null or not exists (select 1 from public.organizations o where o.id = org) then
      raise exception 'audit organization required' using errcode = '42501';
    end if;
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id, entity_type,
    entity_id, idempotency_key, metadata
  ) values (
    org, p_domain, p_event_type, p_action, (select auth.uid()), p_entity_type,
    p_entity_id, p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (idempotency_key) do nothing
  returning id into created;

  if created is null then
    select * into existing
    from public.organization_audit_ledger l
    where l.idempotency_key = p_idempotency_key;
    if not found
       or existing.organization_id is distinct from org
       or existing.domain is distinct from p_domain
       or existing.event_type is distinct from p_event_type
       or existing.action is distinct from p_action
       or existing.actor_user_id is distinct from (select auth.uid())
       or existing.entity_type is distinct from p_entity_type
       or existing.entity_id is distinct from p_entity_id
       or existing.metadata is distinct from coalesce(p_metadata, '{}'::jsonb) then
      raise exception 'audit idempotency key payload mismatch' using errcode = '23505';
    end if;
    created := existing.id;
  end if;

  return pg_catalog.jsonb_build_object('id', created, 'organizationId', org);
end;
$function$;

create function public.list_organization_audit_ledger(
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
            'entityType', 'organization',
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
            'eventType', 'admin.audit',
            'action', classified.action,
            'actorUserId', a.actor,
            'entityType', 'audit_event',
            'occurredAt', a.created_at,
            'source', 'member_admin_audit'
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

create function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name,
      'organizationId', org,
      'lastRunId', r.run_id,
      'lastStatus', r.status,
      'lastStartedAt', r.started_at,
      'lastFinishedAt', r.finished_at,
      'failureCode', r.failure_code,
      'acknowledged', a.run_id is not null,
      'remediation', a.remediation
    ) order by catalog.job_name)
    from (
      select unnest(array[
        'notifications-dispatch-tick',
        'notifications-expiry-sweep',
        'deadline-notices-tick',
        'ballot-notices-tick',
        'event-notices-tick',
        'appointment-reminders-tick',
        'member-messaging-dispatch',
        'workload-reminders-tick',
        'ballot-choices-mix',
        'ballot-choices-mix-recent',
        'task-files-reconcile-tick',
        'task-maintenance-daily'
      ]) as job_name
    ) catalog
    left join lateral (
      select *
      from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc
      limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org
     and a.job_name = catalog.job_name
     and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

create function public.acknowledge_organization_job_run(p_job_name text, p_run_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.organization_job_acknowledgements (
    organization_id, job_name, run_id, acknowledged_by, remediation
  ) values (org, p_job_name, p_run_id, (select auth.uid()), 'acknowledge')
  on conflict (organization_id, job_name, run_id) do update
    set remediation = 'acknowledge',
        acknowledged_by = excluded.acknowledged_by,
        created_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'organization_job_acknowledged', pg_catalog.jsonb_build_object(
    'organizationId', org, 'jobName', p_job_name, 'runId', p_run_id, 'remediation', 'acknowledge'
  ));
  return public.list_organization_job_health();
end;
$function$;

create function public.request_organization_job_retry(p_job_name text, p_run_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.organization_job_acknowledgements (
    organization_id, job_name, run_id, acknowledged_by, remediation
  ) values (org, p_job_name, p_run_id, (select auth.uid()), 'request_retry')
  on conflict (organization_id, job_name, run_id) do update
    set remediation = 'request_retry',
        acknowledged_by = excluded.acknowledged_by,
        created_at = pg_catalog.now();
  perform private.mi1_write_tenant_audit(org, 'organization_job_retry_requested', pg_catalog.jsonb_build_object(
    'organizationId', org, 'jobName', p_job_name, 'runId', p_run_id, 'remediation', 'request_retry'
  ));
  return public.list_organization_job_health();
end;
$function$;

-- ---------------------------------------------------------------------------
-- 11. Public directory RPCs
-- ---------------------------------------------------------------------------

create function public.get_public_directory(p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
begin
  return pg_catalog.jsonb_build_object(
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'title', case when wanted = 'es' then r.title_es else r.title_en end,
        'body', case when wanted = 'es' then r.body_es else r.body_en end,
        'region', case when wanted = 'es' then r.region_es else r.region_en end,
        'url', r.url,
        'sections', '[]'::jsonb
      ) order by r.sort_order, r.published_at desc, r.id)
      from public.public_site_records r
      where r.is_published
        and r.kind = 'chapter'
        and r.organization_id is not null
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'title', case when wanted = 'es' then r.title_es else r.title_en end,
        'body', case when wanted = 'es' then r.body_es else r.body_en end,
        'startsAt', r.starts_at,
        'endsAt', r.ends_at,
        'location', case when wanted = 'es' then r.location_es else r.location_en end,
        'url', r.url,
        'chapterCode', r.chapter_code,
        'category', 'meeting'
      ) order by r.starts_at, r.sort_order, r.id)
      from public.public_site_records r
      where r.is_published
        and r.kind = 'meeting'
        and r.organization_id is not null
    ), '[]'::jsonb)
  );
end;
$function$;

create function public.get_public_event_detail(p_event_id text, p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
  result jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', r.id,
    'title', case when wanted = 'es' then r.title_es else r.title_en end,
    'body', case when wanted = 'es' then r.body_es else r.body_en end,
    'startsAt', r.starts_at,
    'endsAt', r.ends_at,
    'location', case when wanted = 'es' then r.location_es else r.location_en end,
    'url', r.url,
    'chapterCode', r.chapter_code,
    'category', 'meeting'
  ) into result
  from public.public_site_records r
  where r.id = p_event_id
    and r.is_published
    and r.kind = 'meeting'
    and r.organization_id is not null;
  return result;
end;
$function$;

create function public.get_public_chapter_microsite(p_chapter_code text, p_locale text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  wanted text := case when p_locale = 'es' then 'es' else 'en' end;
  chapter jsonb;
begin
  select pg_catalog.jsonb_build_object(
    'id', r.id,
    'title', case when wanted = 'es' then r.title_es else r.title_en end,
    'body', case when wanted = 'es' then r.body_es else r.body_en end,
    'region', case when wanted = 'es' then r.region_es else r.region_en end,
    'url', r.url,
    'sections', '[]'::jsonb,
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id,
        'title', case when wanted = 'es' then e.title_es else e.title_en end,
        'body', case when wanted = 'es' then e.body_es else e.body_en end,
        'startsAt', e.starts_at,
        'endsAt', e.ends_at,
        'location', case when wanted = 'es' then e.location_es else e.location_en end,
        'url', e.url,
        'chapterCode', e.chapter_code,
        'category', 'meeting'
      ) order by e.starts_at, e.id)
      from public.public_site_records e
      where e.is_published
        and e.kind = 'meeting'
        and e.organization_id = r.organization_id
        and e.chapter_code = r.id
    ), '[]'::jsonb)
  ) into chapter
  from public.public_site_records r
  where r.id = p_chapter_code
    and r.is_published
    and r.kind = 'chapter'
    and r.organization_id is not null;
  return chapter;
end;
$function$;

create function public.submit_public_event_rsvp(
  p_event_id text,
  p_email text,
  p_name text,
  p_locale text,
  p_source text,
  p_website text,
  p_scope_hash text,
  p_email_scope_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  event_org uuid;
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if pg_catalog.char_length(coalesce(p_event_id, '')) not between 1 and 128
     or pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (normalized_name is not null and pg_catalog.char_length(normalized_name) > 100)
     or p_source is distinct from 'public-event-rsvp'
     or p_locale is null
     or p_locale not in ('en', 'es') then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;

  network_allowed := private.consume_public_event_rsvp_limit(
    p_scope_hash, 'network-15m', 20, interval '15 minutes'
  );

  select r.organization_id into event_org
  from public.public_site_records r
  where r.id = p_event_id
    and r.is_published
    and r.kind = 'meeting'
    and r.organization_id is not null;

  if network_allowed
     and event_org is not null
     and private.consume_public_event_rsvp_limit(
       p_email_scope_hash, 'email-event-day', 3, interval '1 day'
     ) then
    insert into public.public_event_rsvps (
      organization_id, event_id, email, name, locale
    ) values (
      event_org, p_event_id, normalized_email, normalized_name, p_locale
    )
    on conflict (event_id, email) do nothing;
  end if;

  delete from private.public_event_rsvp_limits as stale
  where stale.ctid in (
    select candidate.ctid
    from private.public_event_rsvp_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash not in (p_scope_hash, p_email_scope_hash)
    order by candidate.window_started_at
    limit 200
    for update skip locked
  );

  return pg_catalog.jsonb_build_object('accepted', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 12. Execute grants
-- ---------------------------------------------------------------------------

revoke all on function public.list_member_qa_questions(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.search_member_qa_history(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_member_qa_question(uuid) from public, anon, authenticated, service_role;
revoke all on function public.ask_member_qa_question(text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reply_member_qa_official(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reply_member_qa_follow_up(uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.toggle_member_qa_vote(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.accept_member_qa_answer(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.edit_member_qa_question(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_member_qa_question(uuid) from public, anon, authenticated, service_role;
revoke all on function public.edit_member_qa_reply(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.delete_member_qa_reply(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_member_qa_officer_queue() from public, anon, authenticated, service_role;
revoke all on function public.get_organization_analytics_snapshot() from public, anon, authenticated, service_role;
revoke all on function public.request_organization_analytics_export(text) from public, anon, authenticated, service_role;
revoke all on function public.list_pay_scale_grades() from public, anon, authenticated, service_role;
revoke all on function public.list_pay_scale_steps(text, date, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.upsert_pay_scale_grade(text, text, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.upsert_pay_scale_step(text, date, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.list_organization_integrations() from public, anon, authenticated, service_role;
revoke all on function public.upsert_organization_integration(text, text, text, boolean, boolean, text[], jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.list_chapter_integration_overrides() from public, anon, authenticated, service_role;
revoke all on function public.upsert_chapter_integration_override(text, text, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.list_integration_jobs() from public, anon, authenticated, service_role;
revoke all on function public.list_integration_webhooks() from public, anon, authenticated, service_role;
revoke all on function public.create_integration_webhook(text, text[], text) from public, anon, authenticated, service_role;
revoke all on function public.set_integration_webhook_active(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.delete_integration_webhook(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_integration_api_keys() from public, anon, authenticated, service_role;
revoke all on function public.create_integration_api_key(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.revoke_integration_api_key(uuid) from public, anon, authenticated, service_role;
revoke all on function public.record_organization_audit_event(uuid, text, text, text, text, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.list_organization_audit_ledger(integer, timestamptz, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.list_organization_job_health() from public, anon, authenticated, service_role;
revoke all on function public.acknowledge_organization_job_run(text, text) from public, anon, authenticated, service_role;
revoke all on function public.request_organization_job_retry(text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_public_directory(text) from public, anon, authenticated, service_role;
revoke all on function public.get_public_event_detail(text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_public_chapter_microsite(text, text) from public, anon, authenticated, service_role;
revoke all on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text) from public, anon, authenticated, service_role;

grant execute on function public.list_member_qa_questions(text, text, text) to authenticated;
grant execute on function public.search_member_qa_history(text, text, text) to authenticated;
grant execute on function public.get_member_qa_question(uuid) to authenticated;
grant execute on function public.ask_member_qa_question(text, text, uuid) to authenticated;
grant execute on function public.reply_member_qa_official(uuid, text, uuid) to authenticated;
grant execute on function public.reply_member_qa_follow_up(uuid, text, uuid) to authenticated;
grant execute on function public.toggle_member_qa_vote(text, uuid) to authenticated;
grant execute on function public.accept_member_qa_answer(uuid, uuid) to authenticated;
grant execute on function public.edit_member_qa_question(uuid, text, text) to authenticated;
grant execute on function public.delete_member_qa_question(uuid) to authenticated;
grant execute on function public.edit_member_qa_reply(uuid, text) to authenticated;
grant execute on function public.delete_member_qa_reply(uuid) to authenticated;
grant execute on function public.list_member_qa_officer_queue() to authenticated;
grant execute on function public.get_organization_analytics_snapshot() to authenticated;
grant execute on function public.request_organization_analytics_export(text) to authenticated;
grant execute on function public.list_pay_scale_grades() to authenticated;
grant execute on function public.list_pay_scale_steps(text, date, integer, integer) to authenticated;
grant execute on function public.upsert_pay_scale_grade(text, text, text, integer, text) to authenticated;
grant execute on function public.upsert_pay_scale_step(text, date, integer, integer) to authenticated;
grant execute on function public.list_organization_integrations() to authenticated;
grant execute on function public.upsert_organization_integration(text, text, text, boolean, boolean, text[], jsonb, text) to authenticated;
grant execute on function public.list_chapter_integration_overrides() to authenticated;
grant execute on function public.upsert_chapter_integration_override(text, text, text, jsonb, text) to authenticated;
grant execute on function public.list_integration_jobs() to authenticated;
grant execute on function public.list_integration_webhooks() to authenticated;
grant execute on function public.create_integration_webhook(text, text[], text) to authenticated;
grant execute on function public.set_integration_webhook_active(uuid, boolean) to authenticated;
grant execute on function public.delete_integration_webhook(uuid) to authenticated;
grant execute on function public.list_integration_api_keys() to authenticated;
grant execute on function public.create_integration_api_key(text, text, text) to authenticated;
grant execute on function public.revoke_integration_api_key(uuid) to authenticated;
grant execute on function public.record_organization_audit_event(uuid, text, text, text, text, text, uuid, jsonb) to service_role;
grant execute on function public.list_organization_audit_ledger(integer, timestamptz, uuid, text, text) to authenticated;
grant execute on function public.list_organization_job_health() to authenticated;
grant execute on function public.acknowledge_organization_job_run(text, text) to authenticated;
grant execute on function public.request_organization_job_retry(text, text) to authenticated;
grant execute on function public.get_public_directory(text) to anon, authenticated, service_role;
grant execute on function public.get_public_event_detail(text, text) to anon, authenticated, service_role;
grant execute on function public.get_public_chapter_microsite(text, text) to anon, authenticated, service_role;
grant execute on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text) to service_role;
