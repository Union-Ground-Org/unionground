-- REQ-MI1-CR-104-20260821 — operational data-retention engine.
--
-- Donor baseline donor-baseline-20260721 supplied
-- behavior only. Its global data_retention_settings table, HQ marker,
-- service-role browser bridge, credentials, project identifiers, and migration
-- history are intentionally rejected. Current Union Ground rules are tenant
-- scoped, MFA-backed, explicit, bounded, and attributable.

set local lock_timeout = '5s';

create table public.organization_retention_policies (
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  data_class text not null check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks'
  )),
  retention_days integer not null check (retention_days between 1 and 3650),
  execution_enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (organization_id, data_class)
);

comment on table public.organization_retention_policies is
  'Organization-scoped retention rules. No tenant or policy is seeded. execution_enabled is explicit standing authorization for bounded manual or scheduled jobs.';

create table public.organization_retention_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  data_class text not null check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks'
  )),
  retention_days integer not null check (retention_days between 1 and 3650),
  mode text not null check (mode in ('dry_run', 'manual', 'scheduled')),
  status text not null check (status in (
    'previewed', 'authorized', 'running', 'completed', 'failed', 'expired'
  )),
  eligible_count integer not null default 0 check (eligible_count >= 0),
  deleted_count integer not null default 0 check (deleted_count >= 0),
  remaining_count integer not null default 0 check (remaining_count >= 0),
  requested_by uuid references auth.users(id) on delete set null,
  authorized_by uuid references auth.users(id) on delete set null,
  authorized_at timestamptz,
  authorization_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text check (failure_code is null or failure_code in (
    'authorization_expired', 'policy_changed', 'execution_disabled',
    'execution_failed'
  )),
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_retention_runs_authorization_complete check (
    (status = 'previewed' and authorized_at is null and authorization_expires_at is null)
    or
    (status <> 'previewed' and authorized_at is not null and authorization_expires_at is not null)
  ),
  constraint organization_retention_runs_completion_complete check (
    (status in ('completed', 'failed', 'expired') and completed_at is not null)
    or
    (status not in ('completed', 'failed', 'expired') and completed_at is null)
  )
);

create index organization_retention_runs_org_created_idx
  on public.organization_retention_runs (organization_id, created_at desc, id desc);
create index organization_retention_runs_authorized_idx
  on public.organization_retention_runs (status, authorization_expires_at)
  where status = 'authorized';

-- Every eligibility count and bounded candidate query begins with tenant and
-- age. Keep those reads off broad organization tables as history grows.
create index organization_page_views_retention_idx
  on public.organization_page_views (organization_id, day);
create index organization_engagement_events_retention_idx
  on public.organization_engagement_events (organization_id, occurred_at);
create index integration_jobs_retention_idx
  on public.integration_jobs (organization_id, updated_at, id)
  where status in ('success', 'failed', 'skipped', 'dead');
create index public_event_rsvps_retention_idx
  on public.public_event_rsvps (organization_id, created_at, id);
create index chapter_tasks_retention_idx
  on public.chapter_tasks (chapter_id, deleted_at, id)
  where deleted_at is not null;

comment on table public.organization_retention_runs is
  'Durable dry-run, authorization, deletion, and result history. Counts only; never retained row content.';

alter table public.organization_retention_policies enable row level security;
alter table public.organization_retention_runs enable row level security;

create policy organization_retention_policies_admin_select
  on public.organization_retention_policies
  for select to authenticated
  using (
    (select private.mfa_satisfied())
    and (select private.has_organization_role(organization_id, array['admin']))
  );

create policy organization_retention_runs_admin_select
  on public.organization_retention_runs
  for select to authenticated
  using (
    (select private.mfa_satisfied())
    and (select private.has_organization_role(organization_id, array['admin']))
  );

revoke all on table public.organization_retention_policies
  from public, anon, authenticated, service_role;
revoke all on table public.organization_retention_runs
  from public, anon, authenticated, service_role;
grant select on table public.organization_retention_policies to authenticated;
grant select on table public.organization_retention_runs to authenticated;

-- The repo-wide mfa_assurance restrictive policy is applied by a DO loop in an
-- earlier migration, so tables created here never receive it. Apply it
-- explicitly; without it these two tables are the only RLS tables in public
-- that lack the second assurance layer.
do $block$
declare table_name text;
begin
  foreach table_name in array array[
    'organization_retention_policies', 'organization_retention_runs'
  ] loop
    execute pg_catalog.format(
      'create policy mfa_assurance on public.%I as restrictive for all to authenticated using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()))',
      table_name
    );
  end loop;
end
$block$;

-- Retention evidence is part of the existing append-only tenant ledger. Extend
-- only its closed vocabularies; do not add a parallel audit authority.
alter table public.organization_audit_ledger
  drop constraint if exists organization_audit_ledger_domain_check,
  add constraint organization_audit_ledger_domain_check check (domain in (
    'administration', 'casework', 'messages', 'data_access', 'community_events',
    'security', 'membership', 'communications', 'knowledge', 'operations',
    'exports', 'rewards', 'privacy'
  ));

alter table public.organization_audit_ledger
  drop constraint if exists organization_audit_ledger_entity_type_check,
  add constraint organization_audit_ledger_entity_type_check check (entity_type in (
    'organization', 'chapter', 'membership', 'role_grant', 'member', 'case',
    'message', 'event', 'campaign', 'broadcast', 'invitation', 'export',
    'document', 'reward', 'job_run', 'security_policy', 'audit_event',
    'automation_definition', 'automation_run',
    'retention_policy', 'retention_run'
  ));

alter table public.organization_audit_ledger
  drop constraint if exists organization_audit_ledger_metadata_keys,
  add constraint organization_audit_ledger_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId', 'status',
      'requireStaffMfa', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'action', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence', 'dataClass', 'retentionDays', 'eligibleCount',
      'deletedCount', 'remainingCount', 'mode', 'executionEnabled'
    ] = '{}'::jsonb
  );

create function private.retention_data_class_config(p_data_class text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case p_data_class
    when 'organization_page_views' then pg_catalog.jsonb_build_object(
      'label', 'Organization page views', 'minimumDays', 30, 'maximumDays', 3650, 'defaultDays', 180,
      'description', 'Aggregated daily path and hat counts; no page-view identity rows.'
    )
    when 'organization_engagement_events' then pg_catalog.jsonb_build_object(
      'label', 'Engagement events', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'description', 'Organization analytics events after their reporting window.'
    )
    when 'integration_job_history' then pg_catalog.jsonb_build_object(
      'label', 'Integration job history', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'description', 'Terminal provider-operation envelopes; active or queued jobs are never eligible.'
    )
    when 'public_event_rsvps' then pg_catalog.jsonb_build_object(
      'label', 'Public event RSVPs', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'description', 'Submitted public RSVP names and email addresses after the published 90-day window.'
    )
    when 'deleted_chapter_tasks' then pg_catalog.jsonb_build_object(
      'label', 'Deleted chapter tasks', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'description', 'Soft-deleted tasks and their cascading task-thread records after the recovery window.'
    )
    else null
  end;
$function$;

revoke all on function private.retention_data_class_config(text)
  from public, anon, authenticated, service_role;

create function private.retention_eligible_count(
  p_organization_id uuid,
  p_data_class text,
  p_retention_days integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  eligible bigint;
begin
  if private.retention_data_class_config(p_data_class) is null then
    raise exception 'unsupported retention data class' using errcode = '22023';
  end if;

  case p_data_class
    when 'organization_page_views' then
      select pg_catalog.count(*) into eligible
      from public.organization_page_views v
      where v.organization_id = p_organization_id
        and v.day < current_date - p_retention_days;
    when 'organization_engagement_events' then
      select pg_catalog.count(*) into eligible
      from public.organization_engagement_events e
      where e.organization_id = p_organization_id
        and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'integration_job_history' then
      select pg_catalog.count(*) into eligible
      from public.integration_jobs j
      where j.organization_id = p_organization_id
        and j.status in ('success', 'failed', 'skipped', 'dead')
        and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'public_event_rsvps' then
      select pg_catalog.count(*) into eligible
      from public.public_event_rsvps r
      where r.organization_id = p_organization_id
        and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'deleted_chapter_tasks' then
      select pg_catalog.count(*) into eligible
      from public.chapter_tasks t
      join public.chapters c on c.id = t.chapter_id
      where c.organization_id = p_organization_id
        and t.deleted_at is not null
        and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
  end case;

  if eligible > 2147483647 then
    return 2147483647;
  end if;
  return eligible::integer;
end;
$function$;

revoke all on function private.retention_eligible_count(uuid, text, integer)
  from public, anon, authenticated, service_role;

create function private.retention_scheduler_configured()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare configured boolean := false;
begin
  if pg_catalog.to_regclass('cron.job') is null then
    return false;
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1)'
    into configured using 'union-ground-organization-retention';
  return configured;
exception when others then
  return false;
end;
$function$;

revoke all on function private.retention_scheduler_configured()
  from public, anon, authenticated, service_role;

create function private.assert_retention_admin(p_organization_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid());
begin
  if caller is null
     or p_organization_id is null
     or p_organization_id is distinct from private.current_member_organization()
     or not private.mfa_satisfied()
     or not private.has_organization_role(p_organization_id, array['admin']) then
    raise exception 'organization admin with MFA required' using errcode = '42501';
  end if;

  perform 1
  from public.organization_role_grants g
  where g.organization_id = p_organization_id
    and g.user_id = caller
    and g.role = 'admin'
  for key share;
  if not found then
    raise exception 'organization admin role changed' using errcode = '42501';
  end if;
  return caller;
end;
$function$;

revoke all on function private.assert_retention_admin(uuid)
  from public, anon, authenticated, service_role;

create function public.get_organization_retention_engine()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  caller uuid;
  result jsonb;
begin
  caller := private.assert_retention_admin(org);

  with catalog(data_class) as (values
    ('organization_page_views'::text),
    ('organization_engagement_events'),
    ('integration_job_history'),
    ('public_event_rsvps'),
    ('deleted_chapter_tasks')
  ), policy_rows as (
    select
      c.data_class,
      private.retention_data_class_config(c.data_class) as config,
      p.retention_days,
      p.execution_enabled,
      p.updated_at
    from catalog c
    left join public.organization_retention_policies p
      on p.organization_id = org
     and p.data_class = c.data_class
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', org,
    'schedulerConfigured', private.retention_scheduler_configured(),
    'policies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'dataClass', p.data_class,
        'label', p.config ->> 'label',
        'description', p.config ->> 'description',
        'minimumDays', (p.config ->> 'minimumDays')::integer,
        'maximumDays', (p.config ->> 'maximumDays')::integer,
        'defaultDays', (p.config ->> 'defaultDays')::integer,
        'retentionDays', coalesce(p.retention_days, (p.config ->> 'defaultDays')::integer),
        'configured', p.retention_days is not null,
        'executionEnabled', coalesce(p.execution_enabled, false),
        'updatedAt', p.updated_at
      ) order by p.data_class)
      from policy_rows p
    ), '[]'::jsonb),
    'runs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'dataClass', r.data_class,
        'retentionDays', r.retention_days,
        'mode', r.mode,
        'status', r.status,
        'eligibleCount', r.eligible_count,
        'deletedCount', r.deleted_count,
        'remainingCount', r.remaining_count,
        'requestedBy', r.requested_by,
        'authorizedBy', r.authorized_by,
        'authorizationExpiresAt', r.authorization_expires_at,
        'createdAt', r.created_at,
        'completedAt', r.completed_at,
        'failureCode', r.failure_code,
        'confirmationPhrase', case when r.status = 'previewed'
          then 'AUTHORIZE ' || r.data_class else null end
      ) order by r.created_at desc, r.id desc)
      from (
        select history.*
        from public.organization_retention_runs history
        where history.organization_id = org
        order by history.created_at desc, history.id desc
        limit 25
      ) r
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

create function public.upsert_organization_retention_policy(
  p_data_class text,
  p_retention_days integer,
  p_execution_enabled boolean,
  p_confirmation text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  caller uuid;
  config jsonb := private.retention_data_class_config(p_data_class);
  minimum_days integer;
  maximum_days integer;
  previous_enabled boolean := false;
begin
  caller := private.assert_retention_admin(org);
  if config is null then
    raise exception 'unsupported retention data class' using errcode = '22023';
  end if;
  minimum_days := (config ->> 'minimumDays')::integer;
  maximum_days := (config ->> 'maximumDays')::integer;
  if p_retention_days is null or p_retention_days < minimum_days or p_retention_days > maximum_days then
    raise exception 'retention window outside supported range' using errcode = '22023';
  end if;

  select p.execution_enabled into previous_enabled
  from public.organization_retention_policies p
  where p.organization_id = org and p.data_class = p_data_class
  for update;
  previous_enabled := coalesce(previous_enabled, false);

  if p_execution_enabled and not previous_enabled
     and p_confirmation is distinct from ('ENABLE ' || p_data_class) then
    raise exception 'exact execution confirmation required' using errcode = '22023';
  end if;

  insert into public.organization_retention_policies (
    organization_id, data_class, retention_days, execution_enabled, updated_by
  ) values (
    org, p_data_class, p_retention_days, p_execution_enabled, caller
  )
  on conflict (organization_id, data_class) do update
    set retention_days = excluded.retention_days,
        execution_enabled = excluded.execution_enabled,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now();

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'retention.policy_saved', 'settings_change', caller,
    'retention_policy', p_data_class, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'dataClass', p_data_class,
      'retentionDays', p_retention_days,
      'executionEnabled', p_execution_enabled
    )
  );

  return public.get_organization_retention_engine();
end;
$function$;

create function public.preview_organization_retention_run(p_data_class text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  caller uuid;
  policy_row public.organization_retention_policies%rowtype;
  run_row public.organization_retention_runs%rowtype;
begin
  caller := private.assert_retention_admin(org);
  select p.* into policy_row
  from public.organization_retention_policies p
  where p.organization_id = org and p.data_class = p_data_class;
  if policy_row.organization_id is null then
    raise exception 'configure the retention policy before previewing it' using errcode = '22023';
  end if;

  insert into public.organization_retention_runs (
    organization_id, data_class, retention_days, mode, status,
    eligible_count, requested_by
  ) values (
    org, p_data_class, policy_row.retention_days, 'dry_run', 'previewed',
    private.retention_eligible_count(org, p_data_class, policy_row.retention_days), caller
  ) returning * into run_row;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'retention.previewed', 'read', caller,
    'retention_run', run_row.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'dataClass', run_row.data_class,
      'retentionDays', run_row.retention_days,
      'eligibleCount', run_row.eligible_count,
      'mode', run_row.mode
    )
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'dataClass', run_row.data_class,
    'retentionDays', run_row.retention_days,
    'mode', run_row.mode,
    'status', run_row.status,
    'eligibleCount', run_row.eligible_count,
    'confirmationPhrase', 'AUTHORIZE ' || run_row.data_class,
    'createdAt', run_row.created_at
  );
end;
$function$;

create function public.authorize_organization_retention_run(
  p_run_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  caller uuid;
  run_row public.organization_retention_runs%rowtype;
  policy_row public.organization_retention_policies%rowtype;
begin
  caller := private.assert_retention_admin(org);
  select r.* into run_row
  from public.organization_retention_runs r
  where r.id = p_run_id and r.organization_id = org
  for update;
  if run_row.id is null or run_row.status <> 'previewed' then
    raise exception 'retention preview is unavailable' using errcode = '22023';
  end if;
  if run_row.created_at < pg_catalog.now() - interval '15 minutes' then
    update public.organization_retention_runs
      set status = 'expired',
          authorized_at = pg_catalog.now(),
          authorization_expires_at = pg_catalog.now(),
          completed_at = pg_catalog.now(),
          failure_code = 'authorization_expired'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'expired');
  end if;
  if p_confirmation is distinct from ('AUTHORIZE ' || run_row.data_class) then
    raise exception 'exact run confirmation required' using errcode = '22023';
  end if;

  select p.* into policy_row
  from public.organization_retention_policies p
  where p.organization_id = org and p.data_class = run_row.data_class
  for key share;
  if policy_row.organization_id is null
     or not policy_row.execution_enabled
     or policy_row.retention_days <> run_row.retention_days then
    raise exception 'retention policy is not authorized for execution' using errcode = '42501';
  end if;

  update public.organization_retention_runs
    set mode = 'manual',
        status = 'authorized',
        authorized_by = caller,
        authorized_at = pg_catalog.now(),
        authorization_expires_at = pg_catalog.now() + interval '15 minutes'
    where id = run_row.id
    returning * into run_row;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'retention.authorized', 'settings_change', caller,
    'retention_run', run_row.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'dataClass', run_row.data_class,
      'retentionDays', run_row.retention_days,
      'eligibleCount', run_row.eligible_count,
      'mode', run_row.mode
    )
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'dataClass', run_row.data_class,
    'status', run_row.status,
    'eligibleCount', run_row.eligible_count,
    'authorizationExpiresAt', run_row.authorization_expires_at
  );
end;
$function$;

create function private.perform_organization_retention_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run_row public.organization_retention_runs%rowtype;
  policy_row public.organization_retention_policies%rowtype;
  removed integer := 0;
  remaining integer := 0;
begin
  select r.* into run_row
  from public.organization_retention_runs r
  where r.id = p_run_id
  for update;
  if run_row.id is null or run_row.status <> 'authorized' then
    raise exception 'authorized retention run required' using errcode = '22023';
  end if;
  if run_row.authorization_expires_at <= pg_catalog.now() then
    update public.organization_retention_runs
      set status = 'expired', completed_at = pg_catalog.now(),
          failure_code = 'authorization_expired'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'expired');
  end if;

  select p.* into policy_row
  from public.organization_retention_policies p
  where p.organization_id = run_row.organization_id and p.data_class = run_row.data_class
  for key share;
  if policy_row.organization_id is null or not policy_row.execution_enabled then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_disabled'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'execution_disabled');
  end if;
  if policy_row.retention_days <> run_row.retention_days then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'policy_changed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'policy_changed');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(run_row.organization_id::text || ':' || run_row.data_class, 0)
  );
  update public.organization_retention_runs
    set status = 'running', started_at = pg_catalog.now()
    where id = run_row.id;

  begin
    case run_row.data_class
      when 'organization_page_views' then
        with candidates as (
          select v.ctid
          from public.organization_page_views v
          where v.organization_id = run_row.organization_id
            and v.day < current_date - run_row.retention_days
          order by v.day, v.path, v.hat
          limit 5000
          for update skip locked
        )
        delete from public.organization_page_views target
        where target.ctid in (select candidates.ctid from candidates);
      when 'organization_engagement_events' then
        with candidates as (
          select e.ctid
          from public.organization_engagement_events e
          where e.organization_id = run_row.organization_id
            and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by e.occurred_at, e.user_id, e.event_type, e.source_id
          limit 5000
          for update skip locked
        )
        delete from public.organization_engagement_events target
        where target.ctid in (select candidates.ctid from candidates);
      when 'integration_job_history' then
        with candidates as (
          select j.id
          from public.integration_jobs j
          where j.organization_id = run_row.organization_id
            and j.status in ('success', 'failed', 'skipped', 'dead')
            and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by j.updated_at, j.id
          limit 5000
          for update skip locked
        )
        delete from public.integration_jobs target
        where target.id in (select candidates.id from candidates);
      when 'public_event_rsvps' then
        with candidates as (
          select r.id
          from public.public_event_rsvps r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update skip locked
        )
        delete from public.public_event_rsvps target
        where target.id in (select candidates.id from candidates);
      when 'deleted_chapter_tasks' then
        with candidates as (
          select t.id
          from public.chapter_tasks t
          join public.chapters c on c.id = t.chapter_id
          where c.organization_id = run_row.organization_id
            and t.deleted_at is not null
            and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by t.deleted_at, t.id
          limit 5000
          for update of t skip locked
        )
        delete from public.chapter_tasks target
        where target.id in (select candidates.id from candidates);
    end case;
    get diagnostics removed = row_count;

    remaining := private.retention_eligible_count(
      run_row.organization_id, run_row.data_class, run_row.retention_days
    );
    update public.organization_retention_runs
      set status = 'completed', deleted_count = removed,
          remaining_count = remaining, completed_at = pg_catalog.now()
      where id = run_row.id;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      run_row.organization_id, 'privacy', 'retention.completed', 'delete', run_row.authorized_by,
      'retention_run', run_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'dataClass', run_row.data_class,
        'retentionDays', run_row.retention_days,
        'eligibleCount', run_row.eligible_count,
        'deletedCount', removed,
        'remainingCount', remaining,
        'mode', run_row.mode
      )
    );
  exception when others then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_failed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object(
      'id', run_row.id, 'status', 'failed', 'failureCode', 'execution_failed'
    );
  end;

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'dataClass', run_row.data_class,
    'status', 'completed',
    'deletedCount', removed,
    'remainingCount', remaining
  );
end;
$function$;

revoke all on function private.perform_organization_retention_run(uuid)
  from public, anon, authenticated, service_role;

create function public.execute_organization_retention_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  caller uuid;
  run_organization uuid;
begin
  caller := private.assert_retention_admin(org);
  select r.organization_id into run_organization
  from public.organization_retention_runs r
  where r.id = p_run_id;
  if run_organization is distinct from org then
    raise exception 'retention run unavailable' using errcode = '42501';
  end if;
  return private.perform_organization_retention_run(p_run_id);
end;
$function$;

create function private.run_due_organization_retention_jobs(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  policy_row public.organization_retention_policies%rowtype;
  run_id uuid;
  processed integer := 0;
begin
  for policy_row in
    select p.*
    from public.organization_retention_policies p
    where p.execution_enabled
      and not exists (
        select 1
        from public.organization_retention_runs r
        where r.organization_id = p.organization_id
          and r.data_class = p.data_class
          and r.mode = 'scheduled'
          and r.created_at >= pg_catalog.now() - interval '20 hours'
      )
    order by p.updated_at, p.organization_id, p.data_class
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update skip locked
  loop
    insert into public.organization_retention_runs (
      organization_id, data_class, retention_days, mode, status,
      eligible_count, requested_by, authorized_by, authorized_at,
      authorization_expires_at
    ) values (
      policy_row.organization_id, policy_row.data_class, policy_row.retention_days,
      'scheduled', 'authorized',
      private.retention_eligible_count(
        policy_row.organization_id, policy_row.data_class, policy_row.retention_days
      ),
      policy_row.updated_by, policy_row.updated_by, pg_catalog.now(),
      pg_catalog.now() + interval '30 minutes'
    ) returning id into run_id;
    perform private.perform_organization_retention_run(run_id);
    processed := processed + 1;
  end loop;

  return pg_catalog.jsonb_build_object('processed', processed, 'ranAt', pg_catalog.now());
end;
$function$;

revoke all on function private.run_due_organization_retention_jobs(integer)
  from public, anon, authenticated, service_role;

revoke all on function public.get_organization_retention_engine()
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_organization_retention_policy(text, integer, boolean, text)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_organization_retention_run(text)
  from public, anon, authenticated, service_role;
revoke all on function public.authorize_organization_retention_run(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.execute_organization_retention_run(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.get_organization_retention_engine() to authenticated;
grant execute on function public.upsert_organization_retention_policy(text, integer, boolean, text) to authenticated;
grant execute on function public.preview_organization_retention_run(text) to authenticated;
grant execute on function public.authorize_organization_retention_run(uuid, text) to authenticated;
grant execute on function public.execute_organization_retention_run(uuid) to authenticated;

do $schedule$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.schedule(
      'union-ground-organization-retention',
      '47 3 * * *',
      'select private.run_due_organization_retention_jobs(25);'
    );
  end if;
exception when unique_violation then null;
end;
$schedule$;

-- The SAMPLE database uses the same backed Admin surface. Extend its existing
-- guarded function-parity phase instead of introducing fixtures or a second
-- seed authority. Both lanes remain service-role-only and additionally depend
-- on private.*_demo_authorize, whose final definition verifies the out-of-band
-- SAMPLE database identity binding.
create function private.demo_seed_retention_engine(
  p_lane text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  actor uuid;
  policy_count integer;
  history_count integer;
begin
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
    if not exists (
      select 1 from private.presg_demo_runs
      where id = p_run_id and state in ('applied', 'verified')
    ) then
      raise exception 'presg demo run must be applied before retention history';
    end if;
    org := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
    if not exists (
      select 1 from private.uniondemo_runs
      where id = p_run_id and state in ('applied', 'verified')
    ) then
      raise exception 'union demo run must be applied before retention history';
    end if;
    org := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;

  select grant_row.user_id into actor
  from public.organization_role_grants grant_row
  join public.organization_memberships membership
    on membership.organization_id = grant_row.organization_id
   and membership.user_id = grant_row.user_id
   and membership.status = 'active'
  where grant_row.organization_id = org
    and grant_row.role = 'admin'
  order by grant_row.granted_at, grant_row.user_id
  limit 1;
  if actor is null then
    raise exception 'demo retention history requires an active organization admin';
  end if;

  insert into public.organization_retention_policies (
    organization_id, data_class, retention_days, execution_enabled,
    updated_by, created_at, updated_at
  ) values
    (org, 'organization_page_views', 180, true, actor, pg_catalog.now(), pg_catalog.now()),
    (org, 'organization_engagement_events', 365, false, actor, pg_catalog.now(), pg_catalog.now()),
    (org, 'integration_job_history', 365, false, actor, pg_catalog.now(), pg_catalog.now()),
    (org, 'public_event_rsvps', 90, true, actor, pg_catalog.now(), pg_catalog.now()),
    (org, 'deleted_chapter_tasks', 90, false, actor, pg_catalog.now(), pg_catalog.now())
  on conflict (organization_id, data_class) do update set
    retention_days = excluded.retention_days,
    execution_enabled = excluded.execution_enabled,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  insert into public.organization_retention_runs (
    id, organization_id, data_class, retention_days, mode, status,
    eligible_count, deleted_count, remaining_count, requested_by,
    authorized_by, authorized_at, authorization_expires_at, started_at,
    completed_at, failure_code, created_at
  )
  select
    private.member_stress_uuid(
      p_run_id::text || ':' || p_lane || ':retention-run:' || series.n::text
    ),
    org,
    classes.data_class,
    case classes.data_class
      when 'organization_page_views' then 180
      when 'organization_engagement_events' then 365
      when 'integration_job_history' then 365
      else 90
    end,
    case when series.n % 4 = 0 then 'manual' else 'scheduled' end,
    case when series.n % 7 = 0 then 'failed' else 'completed' end,
    18 + series.n * 3,
    case when series.n % 7 = 0 then 0 else 18 + series.n * 3 end,
    case when series.n % 7 = 0 then 18 + series.n * 3 else 0 end,
    actor,
    actor,
    timing.created_at + interval '1 minute',
    timing.created_at + interval '16 minutes',
    timing.created_at + interval '2 minutes',
    timing.created_at + interval '3 minutes',
    case when series.n % 7 = 0 then 'execution_failed' else null end,
    timing.created_at
  from pg_catalog.generate_series(1, 18) as series(n)
  cross join lateral (
    select (array[
      'organization_page_views',
      'organization_engagement_events',
      'integration_job_history',
      'public_event_rsvps',
      'deleted_chapter_tasks'
    ]::text[])[1 + ((series.n - 1) % 5)] as data_class
  ) as classes
  cross join lateral (
    select pg_catalog.now() - pg_catalog.make_interval(days => series.n * 60) as created_at
  ) as timing
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    data_class = excluded.data_class,
    retention_days = excluded.retention_days,
    mode = excluded.mode,
    status = excluded.status,
    eligible_count = excluded.eligible_count,
    deleted_count = excluded.deleted_count,
    remaining_count = excluded.remaining_count,
    requested_by = excluded.requested_by,
    authorized_by = excluded.authorized_by,
    authorized_at = excluded.authorized_at,
    authorization_expires_at = excluded.authorization_expires_at,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    failure_code = excluded.failure_code,
    created_at = excluded.created_at;

  select pg_catalog.count(*)::integer into policy_count
  from public.organization_retention_policies p
  where p.organization_id = org;
  select pg_catalog.count(*)::integer into history_count
  from pg_catalog.generate_series(1, 18) series(n)
  join public.organization_retention_runs r
    on r.id = private.member_stress_uuid(
      p_run_id::text || ':' || p_lane || ':retention-run:' || series.n::text
    )
   and r.organization_id = org;

  return pg_catalog.jsonb_build_object(
    'ok', policy_count = 5 and history_count = 18,
    'policies', policy_count,
    'history', history_count
  );
end;
$function$;

create function private.demo_seed_retention_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg'
      then ':presg:organization' else ':ud:organization' end
  );
  policy_count integer;
  history_count integer;
begin
  select pg_catalog.count(*)::integer into policy_count
  from public.organization_retention_policies p
  where p.organization_id = org;
  select pg_catalog.count(*)::integer into history_count
  from pg_catalog.generate_series(1, 18) series(n)
  join public.organization_retention_runs r
    on r.id = private.member_stress_uuid(
      p_run_id::text || ':' || p_lane || ':retention-run:' || series.n::text
    )
   and r.organization_id = org;
  return pg_catalog.jsonb_build_object(
    'ok', policy_count = 5 and history_count = 18,
    'policies', policy_count,
    'history', history_count
  );
end;
$function$;

create function private.demo_seed_remove_retention_engine(p_lane text, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg'
      then ':presg:organization' else ':ud:organization' end
  );
begin
  delete from public.organization_retention_runs r where r.organization_id = org;
  delete from public.organization_retention_policies p where p.organization_id = org;
end;
$function$;

create or replace function public.presg_demo_seed_function_parity(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  base_result jsonb;
  voice_result jsonb;
  operations_result jsonb;
  refresh_scheduled boolean;
  retention jsonb;
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  voice_result := private.demo_seed_apply_voice_parity('presg', p_run_id);
  operations_result := private.demo_seed_apply_voice_operations('presg', p_run_id);
  base_result := private.demo_seed_apply_function_parity(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  if not coalesce((voice_result ->> 'ok')::boolean, false)
     or not coalesce((operations_result ->> 'ok')::boolean, false) then
    raise exception 'Voice survey parity verification failed: %',
      voice_result || pg_catalog.jsonb_build_object('operations', operations_result);
  end if;
  refresh_scheduled := private.demo_seed_ensure_voice_operations_refresh();
  retention := private.demo_seed_retention_engine(
    'presg', p_run_id, p_target_ref, p_confirm_token
  );
  return base_result || pg_catalog.jsonb_build_object(
    'ok', (base_result ->> 'ok')::boolean
      and (auth_result ->> 'ok')::boolean
      and (voice_result ->> 'ok')::boolean
      and (operations_result ->> 'ok')::boolean,
    'authOperations', auth_result,
    'voiceRefreshScheduled', refresh_scheduled,
    'voice', voice_result || pg_catalog.jsonb_build_object('operations', operations_result),
    'retentionEngine', retention
  );
end;
$function$;

create or replace function public.uniondemo_seed_function_parity(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  base_result jsonb;
  voice_result jsonb;
  operations_result jsonb;
  refresh_scheduled boolean;
  retention jsonb;
begin
  auth_result := private.demo_seed_apply_auth_operations(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  voice_result := private.demo_seed_apply_voice_parity('uniondemo', p_run_id);
  operations_result := private.demo_seed_apply_voice_operations('uniondemo', p_run_id);
  base_result := private.demo_seed_apply_function_parity(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  if not coalesce((voice_result ->> 'ok')::boolean, false)
     or not coalesce((operations_result ->> 'ok')::boolean, false) then
    raise exception 'Voice survey parity verification failed: %',
      voice_result || pg_catalog.jsonb_build_object('operations', operations_result);
  end if;
  refresh_scheduled := private.demo_seed_ensure_voice_operations_refresh();
  retention := private.demo_seed_retention_engine(
    'uniondemo', p_run_id, p_target_ref, p_confirm_token
  );
  return base_result || pg_catalog.jsonb_build_object(
    'ok', (base_result ->> 'ok')::boolean
      and (auth_result ->> 'ok')::boolean
      and (voice_result ->> 'ok')::boolean
      and (operations_result ->> 'ok')::boolean,
    'authOperations', auth_result,
    'voiceRefreshScheduled', refresh_scheduled,
    'voice', voice_result || pg_catalog.jsonb_build_object('operations', operations_result),
    'retentionEngine', retention
  );
end;
$function$;

create or replace function public.presg_demo_function_parity_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  analytics_result jsonb;
  parity_result jsonb;
  retention jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  auth_result := private.demo_seed_auth_operations_status('presg', p_run_id);
  analytics_result := private.demo_seed_analytics_status('presg', p_run_id);
  parity_result := private.demo_seed_function_parity_status('presg', p_run_id);
  retention := private.demo_seed_retention_status('presg', p_run_id);
  return parity_result || pg_catalog.jsonb_build_object(
    'ok',
      coalesce((parity_result ->> 'ok')::boolean, false)
      and coalesce((auth_result ->> 'ok')::boolean, false)
      and coalesce((analytics_result ->> 'ok')::boolean, false)
      and coalesce((retention ->> 'ok')::boolean, false),
    'authOperations', auth_result,
    'analytics', analytics_result,
    'retentionEngine', retention
  );
end;
$function$;

create or replace function public.uniondemo_function_parity_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  analytics_result jsonb;
  parity_result jsonb;
  retention jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  auth_result := private.demo_seed_auth_operations_status('uniondemo', p_run_id);
  analytics_result := private.demo_seed_analytics_status('uniondemo', p_run_id);
  parity_result := private.demo_seed_function_parity_status('uniondemo', p_run_id);
  retention := private.demo_seed_retention_status('uniondemo', p_run_id);
  return parity_result || pg_catalog.jsonb_build_object(
    'ok',
      coalesce((parity_result ->> 'ok')::boolean, false)
      and coalesce((auth_result ->> 'ok')::boolean, false)
      and coalesce((analytics_result ->> 'ok')::boolean, false)
      and coalesce((retention ->> 'ok')::boolean, false),
    'authOperations', auth_result,
    'analytics', analytics_result,
    'retentionEngine', retention
  );
end;
$function$;

create or replace function public.presg_demo_remove_function_parity(p_run_id uuid,p_target_ref text,p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare operations_result jsonb; voice_result jsonb; base_result jsonb; refresh_removed boolean;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_retention_engine('presg', p_run_id);
  perform private.demo_seed_remove_member_operations('presg', p_run_id);
  perform private.demo_seed_remove_institutional_records('presg', p_run_id);
  perform private.demo_seed_remove_auth_operations('presg', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('presg', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('presg', p_run_id);
  base_result := private.demo_seed_remove_function_parity('presg', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
end;
$function$;

create or replace function public.uniondemo_remove_function_parity(p_run_id uuid,p_target_ref text,p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare operations_result jsonb; voice_result jsonb; base_result jsonb; refresh_removed boolean;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_retention_engine('uniondemo', p_run_id);
  perform private.demo_seed_remove_member_operations('uniondemo', p_run_id);
  perform private.demo_seed_remove_institutional_records('uniondemo', p_run_id);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('uniondemo', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('uniondemo', p_run_id);
  base_result := private.demo_seed_remove_function_parity('uniondemo', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
end;
$function$;

revoke all on function private.demo_seed_retention_engine(text, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_retention_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_retention_engine(text, uuid)
  from public, anon, authenticated, service_role;

update private.demo_seed_function_catalog
set coverage = 'seeded', evidence_key = 'retention-engine', gate_relation = null
where function_id = 'CR-104';
