-- REQ-UG-COMPASS-TRAINING-DATA-RETENTION-20261017.
-- Optional, project-local training candidates, separate from conversation
-- history and provider logging. Both consents start off. No training/export
-- job is introduced. Only the server's strict unchanged-text classifier may
-- submit a candidate, bound to an already-authorized request reservation.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The predecessor is the privacy 1.0.2 validator (20261027055000), which
-- carries terms 1.0.1; this moves privacy, terms, AI disclosure and retention
-- to 1.1.0. Refuse an unexpected predecessor rather than overwrite a newer
-- policy.
do $previous_pack$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.legal_acceptance_versions(jsonb)')
      and pg_catalog.md5(p.prosrc) = '53244f121e0814a9cdc2fdfacc8fddb8'
      and not p.prosecdef and p.provolatile = 'i'
  ) then
    raise exception 'Compass training 1.1.0 requires the reviewed privacy 1.0.2 validator' using errcode = '55000';
  end if;
end;
$previous_pack$;

create table private.compass_training_organization_consents (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  notice_version text not null check (notice_version = 'compass-training-v1'),
  enabled_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default pg_catalog.now()
);
create table private.compass_training_member_consents (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  notice_version text not null check (notice_version = 'compass-training-v1'),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, user_id)
);
create table private.compass_training_samples (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null unique,
  kind text not null check (kind in ('question', 'civic-draft')),
  prompt text not null check (char_length(prompt) between 1 and 1200),
  response text not null check (char_length(response) between 1 and 8000),
  notice_version text not null check (notice_version = 'compass-training-v1'),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null default (pg_catalog.now() + interval '180 days'),
  constraint compass_training_expiry_bound check (expires_at <= created_at + interval '180 days'),
  constraint compass_training_member_consent_fk foreign key (organization_id, user_id)
    references private.compass_training_member_consents(organization_id, user_id) on delete cascade
);
create index compass_training_samples_expiry on private.compass_training_samples(expires_at);
create index compass_training_samples_member on private.compass_training_samples(user_id, created_at, id);
create index compass_training_samples_organization on private.compass_training_samples(organization_id);

alter table private.compass_training_organization_consents enable row level security;
alter table private.compass_training_organization_consents force row level security;
alter table private.compass_training_member_consents enable row level security;
alter table private.compass_training_member_consents force row level security;
alter table private.compass_training_samples enable row level security;
alter table private.compass_training_samples force row level security;
revoke all on private.compass_training_organization_consents, private.compass_training_member_consents,
  private.compass_training_samples from public, anon, authenticated, service_role;

create policy mfa_assurance on private.compass_training_organization_consents as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on private.compass_training_member_consents as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
create policy mfa_assurance on private.compass_training_samples as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on private.compass_training_organization_consents is 'Independent MFA floor for any future authenticated grant on organization training consent.';
comment on policy mfa_assurance on private.compass_training_member_consents is 'Independent MFA floor for any future authenticated grant on member training consent.';
comment on policy mfa_assurance on private.compass_training_samples is 'Independent MFA floor for any future authenticated grant on training candidates.';

create policy training_organization_read on private.compass_training_organization_consents
  for select to authenticated using (organization_id = (select private.compass_context_organization()) and (select private.mfa_satisfied()));
create policy training_member_read on private.compass_training_member_consents
  for select to authenticated using (user_id = (select auth.uid()) and organization_id = (select private.compass_context_organization()) and (select private.mfa_satisfied()));
create policy training_sample_read on private.compass_training_samples
  for select to authenticated using (user_id = (select auth.uid()) and organization_id = (select private.compass_context_organization())
    and expires_at > pg_catalog.now() and (select private.mfa_satisfied()));
comment on policy training_organization_read on private.compass_training_organization_consents is 'Defense in depth: current organization members only; no direct table grants. Consent writes are restricted to the authenticated RPC.';
comment on policy training_member_read on private.compass_training_member_consents is 'Defense in depth: the caller''s own current-organization consent only; no direct table grants or write policies.';
comment on policy training_sample_read on private.compass_training_samples is 'Defense in depth: only the subject, in their current organization, may read unexpired training candidates; no client writes or table grants.';

create trigger a00_case_graph_lock before insert or update or delete on private.compass_training_organization_consents
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.compass_training_organization_consents
for each row execute function private.lock_case_graph_row_keys('{enabled_by}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.compass_training_member_consents
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.compass_training_member_consents
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.compass_training_samples
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.compass_training_samples
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

create function public.compass_training_preferences(
  p_action text default 'read', p_enabled boolean default null, p_notice_version text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid;
  org uuid;
  can_manage boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  perform private.member_pin_require_full_session();
  if caller is null or not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('read', 'member', 'organization') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  -- A person can always withdraw their own permission after leaving an
  -- organization. Do not resolve current membership before this branch.
  if p_action = 'member' and p_enabled = false then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('compass-training', 509));
    delete from private.compass_training_samples where user_id = caller;
    update private.compass_training_member_consents set enabled = false, updated_at = pg_catalog.now()
      where user_id = caller;
    return pg_catalog.jsonb_build_object('noticeVersion', 'compass-training-v1', 'organizationId', null,
      'retentionDays', 180, 'maximumSamplesPerMember', 100, 'canManageOrganization', false,
      'organizationEnabled', false, 'memberEnabled', false, 'allOrganizationsWithdrawn', true);
  end if;
  -- Use Compass's selected-organization rules, including its single active
  -- membership fallback for chapterless accounts and ambiguity refusal.
  org := private.compass_context_organization();
  if org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.organizations where id = org and status = 'active') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  can_manage := exists (
    select 1 from public.organization_role_grants g
    join public.organization_memberships m on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
    where g.organization_id = org and g.user_id = caller and g.role in ('admin', 'vp')
  ) and (not private.staff_mfa_required(org) or private.has_second_factor(caller));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('compass-training', 509));
  if p_action <> 'read' then
    if p_enabled is null or (p_enabled and p_notice_version is distinct from 'compass-training-v1') then
      raise exception 'current notice must be accepted' using errcode = '22023';
    end if;
    if p_action = 'organization' then
      if not can_manage then raise exception 'not authorized' using errcode = '42501'; end if;
      insert into private.compass_training_organization_consents(organization_id, enabled, notice_version, enabled_by)
      values (org, p_enabled, 'compass-training-v1', caller)
      on conflict (organization_id) do update set enabled = excluded.enabled, notice_version = excluded.notice_version,
        enabled_by = excluded.enabled_by, updated_at = pg_catalog.now();
      if not p_enabled then
        delete from private.compass_training_samples where organization_id = org;
        update private.compass_training_member_consents set enabled = false, updated_at = pg_catalog.now() where organization_id = org;
      end if;
    else
      insert into private.compass_training_member_consents(organization_id, user_id, enabled, notice_version)
      values (org, caller, p_enabled, 'compass-training-v1')
      on conflict (organization_id, user_id) do update set enabled = excluded.enabled,
        notice_version = excluded.notice_version, updated_at = pg_catalog.now();
    end if;
  end if;
  return pg_catalog.jsonb_build_object('noticeVersion', 'compass-training-v1', 'organizationId', org,
    'retentionDays', 180, 'maximumSamplesPerMember', 100, 'canManageOrganization', can_manage,
    'organizationEnabled', coalesce((select enabled from private.compass_training_organization_consents where organization_id = org), false),
    'memberEnabled', coalesce((select enabled from private.compass_training_member_consents where organization_id = org and user_id = caller), false));
end;
$$;
revoke all on function public.compass_training_preferences(text, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.compass_training_preferences(text, boolean, text) to authenticated;

create function public.retain_compass_training_pair(
  p_request_id uuid, p_user_id uuid, p_kind text, p_prompt text, p_response text, p_notice_version text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  request_row public.member_ai_requests%rowtype;
  org uuid;
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_user_id is null or p_request_id is null or p_kind is null or p_kind not in ('question', 'civic-draft')
    or p_notice_version is distinct from 'compass-training-v1' or p_prompt is null or p_response is null
    or char_length(p_prompt) not between 1 and 1200 or char_length(p_response) not between 1 and 8000
    or p_prompt like '%[details withheld]%' or p_response like '%[details withheld]%' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-ai-global', 509));
  select * into request_row from public.member_ai_requests
    where id = p_request_id and user_id = p_user_id for update;
  org := request_row.compass_organization_id;
  if org is null or request_row.dispatch_authorized_at is null
    or request_row.dispatch_authorized_at < pg_catalog.now() - interval '10 minutes' then return false; end if;
  perform 1 from public.organizations where id = org and status = 'active' for share;
  if not found then return false; end if;
  if not exists (select 1 from public.organization_memberships where organization_id = org and user_id = p_user_id and status = 'active') then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('compass-training', 509));
  if not exists (select 1 from private.compass_training_organization_consents where organization_id = org and enabled
      and notice_version = p_notice_version and updated_at <= request_row.created_at)
    or not exists (select 1 from private.compass_training_member_consents where organization_id = org and user_id = p_user_id and enabled
      and notice_version = p_notice_version and updated_at <= request_row.created_at) then return false; end if;
  if exists (select 1 from private.compass_training_samples where request_id = p_request_id) then return false; end if;
  -- Keep at most 100 current samples for this person across organizations.
  delete from private.compass_training_samples where user_id = p_user_id and
    (expires_at <= pg_catalog.now() or id in (select id from private.compass_training_samples where user_id = p_user_id order by created_at desc, id desc offset 99));
  insert into private.compass_training_samples(organization_id, user_id, request_id, kind, prompt, response, notice_version)
    values (org, p_user_id, p_request_id, p_kind, p_prompt, p_response, p_notice_version);
  return true;
end;
$$;
revoke all on function public.retain_compass_training_pair(uuid, uuid, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.retain_compass_training_pair(uuid, uuid, text, text, text, text) to service_role;

create function private.account_lifecycle_export_compass_training_samples(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'organization_id', organization_id, 'user_id', user_id,
    'kind', kind, 'prompt', prompt, 'response', response, 'notice_version', notice_version,
    'created_at', created_at, 'expires_at', expires_at) order by created_at, id), '[]'::jsonb)
  from private.compass_training_samples where user_id = p_caller and expires_at > pg_catalog.now();
$$;
create function private.account_lifecycle_export_compass_training_member_consents(p_caller uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('organization_id', organization_id, 'user_id', user_id,
    'enabled', enabled, 'notice_version', notice_version, 'updated_at', updated_at) order by organization_id), '[]'::jsonb)
  from private.compass_training_member_consents where user_id = p_caller;
$$;
revoke all on function private.account_lifecycle_export_compass_training_samples(uuid), private.account_lifecycle_export_compass_training_member_consents(uuid) from public, anon, authenticated, service_role;

create function public.get_my_compass_training_export() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  perform private.member_pin_require_full_session();
  if caller is null or not private.mfa_satisfied() then raise exception 'not authorized' using errcode = '42501'; end if;
  return jsonb_build_object('consents', private.account_lifecycle_export_compass_training_member_consents(caller),
    'samples', private.account_lifecycle_export_compass_training_samples(caller));
end;
$$;
revoke all on function public.get_my_compass_training_export() from public, anon, authenticated, service_role;
grant execute on function public.get_my_compass_training_export() to authenticated;

create function private.purge_expired_compass_training_samples() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  delete from private.compass_training_samples where id in
    (select id from private.compass_training_samples where expires_at <= pg_catalog.now() limit 20000 for update skip locked);
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function private.purge_expired_compass_training_samples() from public, anon, authenticated, service_role;

create function private.compass_training_archive_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if new.status = 'archived' and old.status is distinct from 'archived' then
    delete from private.compass_training_samples where organization_id = new.id;
    delete from private.compass_training_member_consents where organization_id = new.id;
    delete from private.compass_training_organization_consents where organization_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.compass_training_archive_cleanup() from public, anon, authenticated, service_role;
create trigger organizations_compass_training_archive_cleanup after update of status on public.organizations
for each row execute function private.compass_training_archive_cleanup();

-- Append to the existing monitored daily retention job; preserve its schedule
-- and existing operation. Expired rows are unreadable immediately at expiry.
do $$
declare job_id bigint; old_command text;
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    select jobid, command into job_id, old_command from cron.job where jobname = 'union-ground-organization-retention';
    if job_id is null then raise exception 'organization retention scheduler missing'; end if;
    perform cron.alter_job(job_id, command := old_command || ' select private.purge_expired_compass_training_samples();');
  end if;
end;
$$;

-- Account-lifecycle integration and reviewed trigger inventory follow below.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_projection,
   export_inventory_basis, export_projection_version, export_domain, export_columns, exclusion_reason, note, reviewed_at)
values
  ('private', 'compass_training_member_consents', 'user_id', 'cascade', 'included', 'additional_domains',
   'auth_user_fk', 1, 'additionalDomains.compass_training_member_consents',
   array['organization_id','user_id','enabled','notice_version','updated_at'], null,
   'Optional training consent; only the subject exports it; deleted with the account.', date '2026-10-23'),
  ('private', 'compass_training_samples', 'user_id', 'cascade', 'included', 'additional_domains',
   'auth_user_fk', 1, 'additionalDomains.compass_training_samples',
   array['id','organization_id','user_id','kind','prompt','response','notice_version','created_at','expires_at'], null,
   'Strict unchanged-text training candidates; deleted with the account and on organization archive.', date '2026-10-23'),
  ('private', 'compass_training_organization_consents', 'enabled_by', 'pseudonymize', 'excluded_with_reason', null,
   'auth_user_fk', null, null, null, 'Organization control attribution is not member-owned portable content.',
   'Organization permission; the former administrator attribution is removed with that account.', date '2026-10-23');

-- Existing export domains preserved; append only the two training domains.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller), 'compass_training_member_consents', private.account_lifecycle_export_compass_training_member_consents(p_caller), 'compass_training_samples', private.account_lifecycle_export_compass_training_samples(p_caller)
  )
  || pg_catalog.jsonb_build_object(
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

insert into private.account_lifecycle_trigger_review(kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'private' and table_name in
  ('compass_training_member_consents', 'compass_training_organization_consents', 'compass_training_samples'))
  or (kind = 'trigger' and schema_name = 'public' and table_name = 'organizations' and object_name = 'organizations_compass_training_archive_cleanup')
  or (kind = 'function' and schema_name = 'private' and object_name = 'compass_training_archive_cleanup()')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $$ begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after Compass training retention';
  end if;
end; $$;
-- Material policy notice is separate from explicit training consent.
create or replace function private.legal_acceptance_versions(p_versions jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  entry record;
begin
  if p_versions is null
    or pg_catalog.jsonb_typeof(p_versions) <> 'object'
    or p_versions = '{}'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_versions)) > 32
  then
    raise exception 'legal versions required' using errcode = '22023';
  end if;
  for entry in select key, value from pg_catalog.jsonb_each_text(p_versions) loop
    if entry.key !~ '^[a-z][a-z0-9-]{1,62}$'
      or entry.value !~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'
    then
      raise exception 'legal versions malformed' using errcode = '22023';
    end if;
  end loop;
  if p_versions ->> 'terms-of-use' is null then
    raise exception 'terms version required' using errcode = '22023';
  end if;
  -- published-legal-versions: generated from currentLegalVersions(); the
  -- regression test pins this database authority to the rendered pack.
  if p_versions <> '{"privacy-policy":"1.1.0","terms-of-use":"1.1.0","accessibility-statement":"1.0.0","ai-disclosure":"1.1.0","retention-schedule":"1.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
