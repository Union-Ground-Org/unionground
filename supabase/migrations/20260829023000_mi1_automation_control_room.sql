-- REQ-MI1-CR-108-20260821
-- Versioned after the Main-visible 20260828230000 analytics restoration.
--
-- Organization-governed automation definitions, manual/scheduled runs, and
-- compensating rollback. Production stays empty after reset. Customers opt in
-- explicitly; there is no default tenant, definition, run, credential, or
-- provider dependency.

set local lock_timeout = '5s';

-- The shared append-only ledger already has an operations domain and bounded
-- metadata. Add only the two entity kinds needed to distinguish automation
-- definitions from their executions; event_type remains a bounded internal
-- vocabulary at the call sites below.
alter table public.organization_audit_ledger
  drop constraint organization_audit_ledger_entity_type_check;

alter table public.organization_audit_ledger
  add constraint organization_audit_ledger_entity_type_check check (entity_type in (
    'organization', 'chapter', 'membership', 'role_grant', 'member', 'case',
    'message', 'event', 'campaign', 'broadcast', 'invitation', 'export',
    'document', 'reward', 'job_run', 'security_policy', 'audit_event',
    'automation_definition', 'automation_run'
  ));

create table public.organization_automation_settings (
  organization_id uuid primary key
    references public.organizations(id) on update cascade on delete restrict,
  enabled boolean not null default false,
  max_effects_per_run smallint not null default 20
    check (max_effects_per_run between 1 and 50),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

comment on table public.organization_automation_settings is
  'Per-tenant kill switch and hard effect cap. No row means disabled with the safe default cap.';

create table public.organization_automation_definitions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  name text not null,
  trigger_kind text not null check (trigger_kind in (
    'overdue_task', 'case_deadline', 'unassigned_case'
  )),
  threshold_days smallint not null default 0 check (threshold_days between 0 and 90),
  action_kind text not null default 'create_standard_task'
    check (action_kind = 'create_standard_task'),
  task_priority text not null default 'medium'
    check (task_priority in ('low', 'medium', 'high')),
  cadence text not null default 'daily'
    check (cadence in ('hourly', 'daily', 'weekly')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'archived')),
  version integer not null default 1 check (version > 0),
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_automation_definitions_name_bounded check (
    pg_catalog.char_length(pg_catalog.btrim(name)) between 3 and 80
    and name !~ '[[:cntrl:]]'
  ),
  constraint organization_automation_definitions_unassigned_threshold check (
    trigger_kind <> 'unassigned_case' or threshold_days = 0
  ),
  constraint organization_automation_definitions_org_id_key
    unique (organization_id, id)
);

create unique index organization_automation_definitions_live_name_idx
  on public.organization_automation_definitions (
    organization_id, pg_catalog.lower(pg_catalog.btrim(name))
  ) where status <> 'archived';

create index organization_automation_definitions_due_idx
  on public.organization_automation_definitions (next_run_at, organization_id, id)
  where status = 'active';

comment on table public.organization_automation_definitions is
  'Editable tenant automation rules. Trigger and action vocabularies are closed; arbitrary code, URLs, secrets, and member content are not accepted.';

create table public.organization_automation_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  definition_id uuid not null,
  definition_version integer not null check (definition_version > 0),
  mode text not null check (mode in ('preview', 'manual', 'scheduled')),
  status text not null check (status in (
    'previewed', 'in_progress', 'no_op', 'succeeded', 'partial', 'failed',
    'rolled_back', 'rollback_partial'
  )),
  candidates_count integer not null default 0 check (candidates_count >= 0),
  effects_created integer not null default 0 check (effects_created >= 0),
  effects_skipped integer not null default 0 check (effects_skipped >= 0),
  effects_failed integer not null default 0 check (effects_failed >= 0),
  effects_rolled_back integer not null default 0 check (effects_rolled_back >= 0),
  rollback_skipped integer not null default 0 check (rollback_skipped >= 0),
  confirmation_phrase text,
  failure_code text check (failure_code is null or failure_code in (
    'disabled', 'definition_changed', 'effect_write_failed', 'internal_error'
  )),
  initiated_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  rollback_until timestamptz,
  rolled_back_at timestamptz,
  rolled_back_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint organization_automation_runs_definition_fk
    foreign key (organization_id, definition_id)
    references public.organization_automation_definitions (organization_id, id)
    on update cascade on delete restrict,
  constraint organization_automation_runs_org_id_definition_key
    unique (organization_id, id, definition_id),
  constraint organization_automation_runs_confirmation_bounded check (
    confirmation_phrase is null
    or pg_catalog.char_length(confirmation_phrase) between 5 and 32
  ),
  constraint organization_automation_runs_completion_order check (
    completed_at is null or completed_at >= started_at
  )
);

create index organization_automation_runs_org_created_idx
  on public.organization_automation_runs (organization_id, created_at desc, id desc);

create table public.organization_automation_effects (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  run_id uuid not null,
  definition_id uuid not null,
  source_kind text not null check (source_kind in ('task', 'case')),
  source_id uuid not null,
  chapter_id text not null
    references public.chapters(id) on update cascade on delete restrict,
  planned_task_id uuid not null unique,
  task_title text not null check (task_title in (
    'Review overdue work', 'Prepare for a case deadline', 'Assign case ownership'
  )),
  task_priority text not null check (task_priority in ('low', 'medium', 'high')),
  -- planned_task_id remains the durable, content-free provenance key after the
  -- platform's 90-day task purge clears this live relationship.
  task_id uuid unique references public.chapter_tasks(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'created', 'rolled_back')),
  created_at timestamptz not null default pg_catalog.now(),
  rolled_back_at timestamptz,
  rolled_back_by uuid references auth.users(id) on delete set null,
  constraint organization_automation_effects_run_fk
    foreign key (organization_id, run_id, definition_id)
    references public.organization_automation_runs (organization_id, id, definition_id)
    on update cascade on delete restrict,
  constraint organization_automation_effects_definition_fk
    foreign key (organization_id, definition_id)
    references public.organization_automation_definitions (organization_id, id)
    on update cascade on delete restrict,
  constraint organization_automation_effects_state_complete check (
    (status = 'pending' and task_id is null and rolled_back_at is null and rolled_back_by is null)
    or (status = 'created' and rolled_back_at is null and rolled_back_by is null)
    or (status = 'rolled_back' and rolled_back_at is not null)
  )
);

create unique index organization_automation_effects_active_source_idx
  on public.organization_automation_effects (
    organization_id, definition_id, source_kind, source_id
  ) where status in ('pending', 'created');

create index organization_automation_effects_run_idx
  on public.organization_automation_effects (organization_id, run_id, created_at, id);

comment on table public.organization_automation_effects is
  'Opaque provenance for privacy-safe Standard Tasks. planned_task_id survives the shared 90-day task purge; source record content is never copied into the automation ledger or task card.';

alter table public.organization_automation_settings enable row level security;
alter table public.organization_automation_definitions enable row level security;
alter table public.organization_automation_runs enable row level security;
alter table public.organization_automation_effects enable row level security;

create policy organization_automation_settings_operator_select
  on public.organization_automation_settings for select to authenticated
  using (private.has_organization_role(organization_id, array['admin', 'vp']));
create policy organization_automation_definitions_operator_select
  on public.organization_automation_definitions for select to authenticated
  using (private.has_organization_role(organization_id, array['admin', 'vp']));
create policy organization_automation_runs_operator_select
  on public.organization_automation_runs for select to authenticated
  using (private.has_organization_role(organization_id, array['admin', 'vp']));
create policy organization_automation_effects_operator_select
  on public.organization_automation_effects for select to authenticated
  using (private.has_organization_role(organization_id, array['admin', 'vp']));

create policy mfa_assurance on public.organization_automation_settings
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_automation_definitions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_automation_runs
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
create policy mfa_assurance on public.organization_automation_effects
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on public.organization_automation_settings from public, anon, authenticated, service_role;
revoke all on public.organization_automation_definitions from public, anon, authenticated, service_role;
revoke all on public.organization_automation_runs from public, anon, authenticated, service_role;
revoke all on public.organization_automation_effects from public, anon, authenticated, service_role;

grant select on public.organization_automation_settings to authenticated;
grant select on public.organization_automation_definitions to authenticated;
grant select on public.organization_automation_runs to authenticated;
grant select on public.organization_automation_effects to authenticated;

-- Supabase's DDL privilege hook restores its non-DML service-role maintenance
-- quartet after a generic REVOKE ALL. Repeat those exact privileges after the
-- authenticated grants so this RPC-only store has no direct service seam.
revoke truncate, references, trigger, maintain on public.organization_automation_settings from service_role;
revoke truncate, references, trigger, maintain on public.organization_automation_definitions from service_role;
revoke truncate, references, trigger, maintain on public.organization_automation_runs from service_role;
revoke truncate, references, trigger, maintain on public.organization_automation_effects from service_role;

create function private.cr108_require_operator()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.current_member_organization();
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if org is null
     or not private.has_organization_role(org, array['admin', 'vp']) then
    raise exception 'organization automation operator required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create function private.cr108_next_run(p_cadence text, p_from timestamptz default pg_catalog.now())
returns timestamptz
language sql
immutable
set search_path = ''
as $function$
  select case p_cadence
    when 'hourly' then p_from + interval '1 hour'
    when 'daily' then p_from + interval '1 day'
    when 'weekly' then p_from + interval '7 days'
    else null
  end
$function$;

create function private.cr108_record_audit(
  p_organization_id uuid,
  p_event_type text,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_actor_user_id uuid,
  p_metadata jsonb,
  p_idempotency_key uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id, entity_type,
    entity_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'operations', p_event_type, p_action, p_actor_user_id,
    p_entity_type, p_entity_id, p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$function$;

create function private.cr108_candidate_count(
  p_organization_id uuid,
  p_definition_id uuid,
  p_trigger_kind text,
  p_threshold_days integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  total bigint := 0;
begin
  case p_trigger_kind
    when 'overdue_task' then
      select pg_catalog.count(*) into total
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= current_date - p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id
            and e.status in ('pending', 'created')
        );
    when 'case_deadline' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= current_date + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id
            and e.status in ('pending', 'created')
        );
    when 'unassigned_case' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id
            and e.status in ('pending', 'created')
        );
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
  return total::integer;
end;
$function$;

create function private.cr108_candidate_sources(
  p_organization_id uuid,
  p_definition_id uuid,
  p_trigger_kind text,
  p_threshold_days integer,
  p_limit integer
)
returns table(source_kind text, source_id uuid, chapter_id text)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_limit not between 1 and 50 then
    raise exception 'automation effect limit out of range' using errcode = '22023';
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      return query
      select 'task'::text, t.id, t.chapter_id
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= current_date - p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id
            and e.status in ('pending', 'created')
        )
      order by t.due_date, t.created_at, t.id
      limit p_limit;
    when 'case_deadline' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= current_date + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id
            and e.status in ('pending', 'created')
        )
      order by c.deadline, c.created_at, c.id
      limit p_limit;
    when 'unassigned_case' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id
            and e.status in ('pending', 'created')
        )
      order by c.created_at, c.id
      limit p_limit;
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
end;
$function$;

-- Extend the current Standard Task preparation trigger with one narrow system
-- insert path. A task qualifies only while a pending effect with its
-- unguessable planned UUID is locked in the same transaction. The definition,
-- run, chapter, fixed copy, action kind, and priority must all agree. Normal
-- browser inserts and updates keep the previous behavior verbatim.
create or replace function private.prepare_chapter_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_name text;
  resolved_assignee_name text;
  previous_assignee uuid;
  automation_insert boolean := false;
  automation_effect public.organization_automation_effects%rowtype;
  automation_run public.organization_automation_runs%rowtype;
  automation_definition public.organization_automation_definitions%rowtype;
  expected_title text;
begin
  -- ON DELETE SET NULL updates are nested trigger writes. They may still see
  -- stale ambient JWT claims for the identity being deleted, so trigger depth
  -- participates in the gate. Match only the exact FK-detach shape: no
  -- business field may change and identities only stay unchanged or become
  -- NULL. This runs before user-edit normalization, notification, and audit.
  if (caller is null or pg_catalog.pg_trigger_depth() > 1)
     and tg_op = 'UPDATE'
     and (pg_catalog.to_jsonb(new) - array[
       'created_by', 'updated_by', 'assignee_id', 'assignee_name', 'deleted_by'
     ]::text[]) = (pg_catalog.to_jsonb(old) - array[
       'created_by', 'updated_by', 'assignee_id', 'assignee_name', 'deleted_by'
     ]::text[])
     and (new.created_by is null or new.created_by is not distinct from old.created_by)
     and (new.updated_by is null or new.updated_by is not distinct from old.updated_by)
     and (new.assignee_id is null or new.assignee_id is not distinct from old.assignee_id)
     and (new.deleted_by is null or new.deleted_by is not distinct from old.deleted_by)
     and (
       new.created_by is distinct from old.created_by
       or new.updated_by is distinct from old.updated_by
       or new.assignee_id is distinct from old.assignee_id
       or new.deleted_by is distinct from old.deleted_by
     ) then
    if new.assignee_id is null and new.assignee_id is distinct from old.assignee_id then
      new.assignee_name := '';
    else
      new.assignee_name := old.assignee_name;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    select e.* into automation_effect
    from public.organization_automation_effects e
    where e.planned_task_id = new.id
      and e.status = 'pending'
    for update of e;

    if found then
      select r.* into strict automation_run
      from public.organization_automation_runs r
      where r.id = automation_effect.run_id
        and r.organization_id = automation_effect.organization_id
        and r.definition_id = automation_effect.definition_id
        and r.status = 'in_progress';

      select d.* into strict automation_definition
      from public.organization_automation_definitions d
      where d.id = automation_effect.definition_id
        and d.organization_id = automation_effect.organization_id
        and d.version = automation_run.definition_version
        and d.action_kind = 'create_standard_task';

      if not exists (
        select 1 from public.chapters ch
        where ch.id = automation_effect.chapter_id
          and ch.organization_id = automation_effect.organization_id
      ) then
        raise exception 'automation effect chapter is outside the organization'
          using errcode = '42501';
      end if;

      automation_insert := true;
      caller := automation_run.initiated_by;
      caller_chapter := automation_effect.chapter_id;
      caller_name := 'Automation';
      expected_title := case automation_definition.trigger_kind
        when 'overdue_task' then 'Review overdue work'
        when 'case_deadline' then 'Prepare for a case deadline'
        when 'unassigned_case' then 'Assign case ownership'
      end;
    end if;
  end if;

  if caller is null and not automation_insert then
    raise exception 'authentication required';
  end if;

  if not automation_insert then
    select p.chapter_id, p.full_name
      into caller_chapter, caller_name
    from public.member_profiles p
    where p.id = caller;
  end if;

  if caller_chapter is null then
    raise exception 'member chapter required';
  end if;

  new.title := pg_catalog.btrim(new.title);
  new.description := pg_catalog.btrim(new.description);
  new.workstream := pg_catalog.btrim(new.workstream);

  if automation_insert and (
    new.title is distinct from expected_title
    or new.description <> ''
    or new.chapter_id is distinct from caller_chapter
    or new.status <> 'to_do'
    or new.priority is distinct from automation_definition.task_priority
    or new.workstream <> 'General'
    or new.assignee_id is not null
    or new.start_date is not null
    or new.due_date is not null
    or new.progress <> 0
    or new.blocked
    or new.milestone
    or new.task_type <> 'general'
  ) then
    raise exception 'automation task shape rejected' using errcode = '23514';
  end if;

  if new.assignee_id is null then
    new.assignee_name := '';
  elsif tg_op = 'INSERT'
     or new.assignee_id is distinct from old.assignee_id then
    select p.full_name
      into resolved_assignee_name
    from public.member_profiles p
    where p.id = new.assignee_id
      and p.chapter_id = caller_chapter;

    if resolved_assignee_name is null then
      raise exception 'assignee must be a member of your chapter'
        using errcode = '22023';
    end if;
    new.assignee_name := pg_catalog.btrim(resolved_assignee_name);
  elsif coalesce(pg_catalog.current_setting('sg.refresh_names', true), '') = '1' then
    new.assignee_name := pg_catalog.btrim(new.assignee_name);
  else
    new.assignee_name := old.assignee_name;
  end if;

  if tg_op = 'INSERT' then
    new.chapter_id := caller_chapter;
    new.created_by := caller;
    new.created_at := pg_catalog.now();
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('chapter_tasks.task_number:' || caller_chapter, 0));

    insert into private.chapter_task_number_counters (chapter_id, last_number)
    select caller_chapter, coalesce(pg_catalog.max(t.task_number), 0)
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
    on conflict (chapter_id) do nothing;

    update private.chapter_task_number_counters c
       set last_number = c.last_number + 1
     where c.chapter_id = caller_chapter
     returning c.last_number into new.task_number;
  elsif new.chapter_id is distinct from old.chapter_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.task_number is distinct from old.task_number then
    raise exception 'task ownership fields are immutable';
  end if;

  new.updated_by := caller;
  new.updated_at := pg_catalog.now();

  if new.status = 'done' then
    new.progress := 100;
    new.done_at := case when tg_op = 'UPDATE' then coalesce(old.done_at, pg_catalog.now()) else pg_catalog.now() end;
  else
    if tg_op = 'UPDATE' and old.done_at is not null
       and new.progress = 100 and old.progress = 100 then
      new.progress := 99;
    end if;
    new.done_at := null;
  end if;

  previous_assignee := case when tg_op = 'UPDATE' then old.assignee_id else null end;
  if new.assignee_id is distinct from previous_assignee then
    if new.assignee_id is not null and new.assignee_id <> caller then
      perform private.notify_member(
        new.assignee_id, 'task.assigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
    if previous_assignee is not null and previous_assignee <> caller then
      perform private.notify_member(
        previous_assignee, 'task.unassigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
  end if;
  return new;
end;
$function$;

create function private.cr108_execute_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run_row public.organization_automation_runs%rowtype;
  definition_row public.organization_automation_definitions%rowtype;
  effect_limit integer := 20;
  candidate record;
  candidate_total integer := 0;
  created_count integer := 0;
  skipped_count integer := 0;
  failed_count integer := 0;
  effect_id uuid;
  inserted_effect uuid;
  created_task_id uuid;
  task_title text;
  final_status text;
  final_failure text;
begin
  select r.* into strict run_row
  from public.organization_automation_runs r
  where r.id = p_run_id
  for update of r;

  if run_row.status <> 'in_progress' then
    raise exception 'automation run is not executable' using errcode = '22023';
  end if;

  select d.* into strict definition_row
  from public.organization_automation_definitions d
  where d.id = run_row.definition_id
    and d.organization_id = run_row.organization_id
    and d.version = run_row.definition_version
  for update of d;

  select s.max_effects_per_run into effect_limit
  from public.organization_automation_settings s
  where s.organization_id = run_row.organization_id
    and s.enabled;

  if effect_limit is null then
    update public.organization_automation_runs
       set status = 'failed', failure_code = 'disabled',
           completed_at = pg_catalog.now()
     where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'disabled');
  end if;

  candidate_total := private.cr108_candidate_count(
    run_row.organization_id, definition_row.id,
    definition_row.trigger_kind, definition_row.threshold_days
  );

  task_title := case definition_row.trigger_kind
    when 'overdue_task' then 'Review overdue work'
    when 'case_deadline' then 'Prepare for a case deadline'
    when 'unassigned_case' then 'Assign case ownership'
  end;

  for candidate in
    select * from private.cr108_candidate_sources(
      run_row.organization_id, definition_row.id,
      definition_row.trigger_kind, definition_row.threshold_days,
      effect_limit
    )
  loop
    begin
      effect_id := extensions.gen_random_uuid();
      created_task_id := extensions.gen_random_uuid();
      inserted_effect := null;

      insert into public.organization_automation_effects (
        id, organization_id, run_id, definition_id, source_kind, source_id,
        chapter_id, planned_task_id, task_title, task_priority, status
      ) values (
        effect_id, run_row.organization_id, run_row.id, definition_row.id,
        candidate.source_kind, candidate.source_id, candidate.chapter_id,
        created_task_id, task_title, definition_row.task_priority, 'pending'
      )
      on conflict (organization_id, definition_id, source_kind, source_id)
        where status in ('pending', 'created')
      do nothing
      returning id into inserted_effect;

      if inserted_effect is null then
        skipped_count := skipped_count + 1;
        continue;
      end if;

      insert into public.chapter_tasks (
        id, chapter_id, title, description, status, priority, workstream,
        assignee_id, assignee_name, start_date, due_date, progress, blocked,
        milestone, order_index, task_type
      ) values (
        created_task_id, candidate.chapter_id, task_title, '', 'to_do',
        definition_row.task_priority, 'General', null, '', null, null, 0,
        false, false, 0, 'general'
      );

      update public.organization_automation_effects
         set task_id = created_task_id, status = 'created'
       where id = inserted_effect;
      created_count := created_count + 1;
    exception when others then
      failed_count := failed_count + 1;
    end;
  end loop;

  final_status := case
    when candidate_total = 0 then 'no_op'
    when created_count = 0 and failed_count > 0 then 'failed'
    when failed_count > 0 then 'partial'
    else 'succeeded'
  end;
  final_failure := case when failed_count > 0 then 'effect_write_failed' else null end;

  update public.organization_automation_runs
     set status = final_status,
         candidates_count = candidate_total,
         effects_created = created_count,
         effects_skipped = skipped_count + greatest(candidate_total - effect_limit, 0),
         effects_failed = failed_count,
         failure_code = final_failure,
         completed_at = pg_catalog.now(),
         rollback_until = case when created_count > 0 then pg_catalog.now() + interval '7 days' else null end
   where id = run_row.id;

  update public.organization_automation_definitions
     set last_run_at = pg_catalog.now(),
         next_run_at = case when run_row.mode = 'scheduled'
           then private.cr108_next_run(cadence, pg_catalog.now())
           else next_run_at end,
         updated_at = case when run_row.mode = 'scheduled' then pg_catalog.now() else updated_at end
   where id = definition_row.id;

  perform private.cr108_record_audit(
    run_row.organization_id,
    'automation_run_completed',
    'create',
    'automation_run',
    run_row.id::text,
    run_row.initiated_by,
    pg_catalog.jsonb_build_object(
      'runId', run_row.id,
      'status', final_status,
      'count', created_count,
      'cadence', definition_row.cadence,
      'reasonCode', final_failure
    ),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'status', final_status,
    'candidatesCount', candidate_total,
    'effectsCreated', created_count,
    'effectsSkipped', skipped_count + greatest(candidate_total - effect_limit, 0),
    'effectsFailed', failed_count,
    'rollbackUntil', case when created_count > 0 then pg_catalog.now() + interval '7 days' else null end
  );
end;
$function$;

create function public.get_organization_automation_control_room()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.cr108_require_operator();
  settings_json jsonb;
  definitions_json jsonb;
  runs_json jsonb;
  scheduler_configured boolean := false;
begin
  select pg_catalog.jsonb_build_object(
    'enabled', s.enabled,
    'maxEffectsPerRun', s.max_effects_per_run,
    'updatedAt', s.updated_at
  ) into settings_json
  from public.organization_automation_settings s
  where s.organization_id = org;

  if settings_json is null then
    settings_json := pg_catalog.jsonb_build_object(
      'enabled', false,
      'maxEffectsPerRun', 20,
      'updatedAt', null
    );
  end if;

  select coalesce(pg_catalog.jsonb_agg(projected.item order by projected.created_at, projected.id), '[]'::jsonb)
  into definitions_json
  from (
    select d.created_at, d.id, pg_catalog.jsonb_build_object(
      'id', d.id,
      'name', d.name,
      'triggerKind', d.trigger_kind,
      'thresholdDays', d.threshold_days,
      'actionKind', d.action_kind,
      'taskPriority', d.task_priority,
      'cadence', d.cadence,
      'status', d.status,
      'version', d.version,
      'nextRunAt', d.next_run_at,
      'lastRunAt', d.last_run_at,
      'createdAt', d.created_at,
      'updatedAt', d.updated_at
    ) as item
    from public.organization_automation_definitions d
    where d.organization_id = org
      and d.status <> 'archived'
  ) projected;

  select coalesce(pg_catalog.jsonb_agg(projected.item order by projected.created_at desc, projected.id desc), '[]'::jsonb)
  into runs_json
  from (
    select r.created_at, r.id, pg_catalog.jsonb_build_object(
      'id', r.id,
      'definitionId', r.definition_id,
      'definitionName', d.name,
      'mode', r.mode,
      'status', r.status,
      'candidatesCount', r.candidates_count,
      'effectsCreated', r.effects_created,
      'effectsSkipped', r.effects_skipped,
      'effectsFailed', r.effects_failed,
      'effectsRolledBack', r.effects_rolled_back,
      'rollbackSkipped', r.rollback_skipped,
      'confirmationPhrase', r.confirmation_phrase,
      'failureCode', r.failure_code,
      'startedAt', r.started_at,
      'completedAt', r.completed_at,
      'rollbackUntil', r.rollback_until,
      'rolledBackAt', r.rolled_back_at,
      'rollbackEligible', (
        r.status in ('succeeded', 'partial')
        and r.effects_created > r.effects_rolled_back
        and r.rollback_until > pg_catalog.now()
      ),
      'rollbackPhrase', 'ROLL BACK ' || pg_catalog.upper(pg_catalog.left(r.id::text, 8))
    ) as item
    from public.organization_automation_runs r
    join public.organization_automation_definitions d
      on d.id = r.definition_id and d.organization_id = r.organization_id
    where r.organization_id = org
    order by r.created_at desc, r.id desc
    limit 50
  ) projected;

  if pg_catalog.to_regclass('cron.job') is not null then
    select exists (
      select 1 from cron.job j
      where j.jobname = 'organization-automation-tick' and j.active
    ) into scheduler_configured;
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'settings', settings_json,
    'definitions', definitions_json,
    'runs', runs_json,
    'schedulerConfigured', scheduler_configured
  );
end;
$function$;

create function public.save_organization_automation_definition(
  p_definition_id uuid,
  p_name text,
  p_trigger_kind text,
  p_threshold_days integer,
  p_cadence text,
  p_task_priority text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  saved public.organization_automation_definitions%rowtype;
  audit_id uuid := extensions.gen_random_uuid();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 3 and 80
     or p_name ~ '[[:cntrl:]]' then
    raise exception 'automation name must be 3 to 80 visible characters' using errcode = '22023';
  end if;
  if p_trigger_kind not in ('overdue_task', 'case_deadline', 'unassigned_case')
     or p_cadence not in ('hourly', 'daily', 'weekly')
     or p_task_priority not in ('low', 'medium', 'high')
     or p_threshold_days not between 0 and 90
     or (p_trigger_kind = 'unassigned_case' and p_threshold_days <> 0) then
    raise exception 'invalid automation definition' using errcode = '22023';
  end if;

  if p_definition_id is null then
    if p_expected_version is not null then
      raise exception 'new automation definition cannot have a version' using errcode = '22023';
    end if;
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, created_by, updated_by
    ) values (
      org, pg_catalog.btrim(p_name), p_trigger_kind, p_threshold_days,
      p_task_priority, p_cadence, actor, actor
    ) returning * into saved;
  else
    if p_expected_version is null then
      raise exception 'expected automation version required' using errcode = '22023';
    end if;
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_name),
           trigger_kind = p_trigger_kind,
           threshold_days = p_threshold_days,
           task_priority = p_task_priority,
           cadence = p_cadence,
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now()
     where d.id = p_definition_id
       and d.organization_id = org
       and d.version = p_expected_version
       and d.status <> 'archived'
     returning d.* into saved;
    if saved.id is null then
      raise exception 'automation definition changed; reload before saving' using errcode = '40001';
    end if;
  end if;

  perform private.cr108_record_audit(
    org,
    case when p_definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when p_definition_id is null then 'create' else 'update' end,
    'automation_definition',
    saved.id::text,
    actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'cadence', saved.cadence),
    audit_id
  );

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'name', saved.name, 'triggerKind', saved.trigger_kind,
    'thresholdDays', saved.threshold_days, 'taskPriority', saved.task_priority,
    'cadence', saved.cadence, 'status', saved.status, 'version', saved.version
  );
end;
$function$;

create function public.set_organization_automation_definition_status(
  p_definition_id uuid,
  p_status text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  saved public.organization_automation_definitions%rowtype;
begin
  if p_status not in ('active', 'paused', 'archived') or p_expected_version is null then
    raise exception 'invalid automation status transition' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  update public.organization_automation_definitions d
     set status = p_status,
         version = d.version + 1,
         next_run_at = case when p_status = 'active' then pg_catalog.now() else null end,
         updated_by = actor,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.status <> 'archived'
   returning d.* into saved;
  if saved.id is null then
    raise exception 'automation definition changed; reload before saving' using errcode = '40001';
  end if;

  perform private.cr108_record_audit(
    org, 'automation_definition_status_changed', 'update',
    'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'cadence', saved.cadence),
    extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'status', saved.status, 'version', saved.version,
    'nextRunAt', saved.next_run_at
  );
end;
$function$;

create function public.set_organization_automation_enabled(
  p_enabled boolean,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  expected_confirmation text := case when p_enabled then 'ENABLE AUTOMATION' else 'PAUSE AUTOMATION' end;
  saved public.organization_automation_settings%rowtype;
begin
  if p_confirmation is distinct from expected_confirmation then
    raise exception 'automation confirmation did not match' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  insert into public.organization_automation_settings (
    organization_id, enabled, updated_by
  ) values (org, p_enabled, actor)
  on conflict (organization_id) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now()
  returning * into saved;

  perform private.cr108_record_audit(
    org, 'automation_kill_switch_changed', 'settings_change',
    'organization', org::text, actor,
    pg_catalog.jsonb_build_object('status', case when saved.enabled then 'enabled' else 'paused' end),
    extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'enabled', saved.enabled, 'maxEffectsPerRun', saved.max_effects_per_run,
    'updatedAt', saved.updated_at
  );
end;
$function$;

create function public.set_organization_automation_safety_cap(
  p_max_effects_per_run integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  saved public.organization_automation_settings%rowtype;
begin
  if p_max_effects_per_run not between 1 and 50 then
    raise exception 'automation safety cap must be between 1 and 50' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  insert into public.organization_automation_settings (
    organization_id, max_effects_per_run, updated_by
  ) values (org, p_max_effects_per_run, actor)
  on conflict (organization_id) do update
    set max_effects_per_run = excluded.max_effects_per_run,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now()
  returning * into saved;

  perform private.cr108_record_audit(
    org, 'automation_safety_cap_changed', 'settings_change',
    'organization', org::text, actor,
    pg_catalog.jsonb_build_object('count', saved.max_effects_per_run),
    extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'enabled', saved.enabled, 'maxEffectsPerRun', saved.max_effects_per_run,
    'updatedAt', saved.updated_at
  );
end;
$function$;

create function public.preview_organization_automation_run(p_definition_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  definition_row public.organization_automation_definitions%rowtype;
  run_row public.organization_automation_runs%rowtype;
  candidate_total integer;
  effect_limit integer := 20;
begin
  select d.* into definition_row
  from public.organization_automation_definitions d
  where d.id = p_definition_id
    and d.organization_id = org
    and d.status <> 'archived';
  if definition_row.id is null then
    raise exception 'automation definition unavailable' using errcode = '22023';
  end if;

  select coalesce(s.max_effects_per_run, 20) into effect_limit
  from (select 1) seed
  left join public.organization_automation_settings s
    on s.organization_id = org;

  candidate_total := private.cr108_candidate_count(
    org, definition_row.id, definition_row.trigger_kind, definition_row.threshold_days
  );

  insert into public.organization_automation_runs (
    organization_id, definition_id, definition_version, mode, status,
    candidates_count, effects_skipped, confirmation_phrase, initiated_by,
    completed_at
  ) values (
    org, definition_row.id, definition_row.version, 'preview', 'previewed',
    candidate_total, greatest(candidate_total - effect_limit, 0),
    null, actor, pg_catalog.now()
  ) returning * into run_row;

  run_row.confirmation_phrase := 'RUN ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8));
  update public.organization_automation_runs
     set confirmation_phrase = run_row.confirmation_phrase
   where id = run_row.id;

  perform private.cr108_record_audit(
    org, 'automation_run_previewed', 'read', 'automation_run',
    run_row.id::text, actor,
    pg_catalog.jsonb_build_object(
      'runId', run_row.id, 'status', 'previewed',
      'count', candidate_total, 'cadence', definition_row.cadence
    ),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'definitionId', definition_row.id,
    'definitionName', definition_row.name,
    'mode', 'preview',
    'status', 'previewed',
    'candidatesCount', candidate_total,
    'willCreate', least(candidate_total, effect_limit),
    'effectsSkipped', greatest(candidate_total - effect_limit, 0),
    'confirmationPhrase', run_row.confirmation_phrase,
    'settingsEnabled', coalesce((
      select s.enabled from public.organization_automation_settings s
      where s.organization_id = org
    ), false)
  );
end;
$function$;

create function public.execute_organization_automation_run(
  p_run_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  run_row public.organization_automation_runs%rowtype;
  definition_row public.organization_automation_definitions%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  select r.* into run_row
  from public.organization_automation_runs r
  where r.id = p_run_id
    and r.organization_id = org
    and r.mode = 'preview'
    and r.status = 'previewed'
  for update of r;
  if run_row.id is null then
    raise exception 'automation preview unavailable' using errcode = '22023';
  end if;
  if run_row.completed_at < pg_catalog.now() - interval '15 minutes' then
    raise exception 'automation preview expired' using errcode = '22023';
  end if;
  if p_confirmation is distinct from run_row.confirmation_phrase then
    raise exception 'automation run confirmation did not match' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.organization_automation_settings s
    where s.organization_id = org and s.enabled
  ) then
    raise exception 'organization automation is paused' using errcode = '22023';
  end if;

  select d.* into definition_row
  from public.organization_automation_definitions d
  where d.id = run_row.definition_id
    and d.organization_id = org
    and d.version = run_row.definition_version
    and d.status = 'active'
  for update of d;
  if definition_row.id is null then
    raise exception 'automation definition changed; preview again' using errcode = '40001';
  end if;

  update public.organization_automation_runs
     set mode = 'manual', status = 'in_progress', initiated_by = actor,
         started_at = pg_catalog.now(), completed_at = null,
         candidates_count = 0, effects_skipped = 0,
         confirmation_phrase = null
   where id = run_row.id;

  return private.cr108_execute_run(run_row.id);
end;
$function$;

create function public.rollback_organization_automation_run(
  p_run_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  run_row public.organization_automation_runs%rowtype;
  effect_row public.organization_automation_effects%rowtype;
  task_row public.chapter_tasks%rowtype;
  rolled_back_count integer := 0;
  skipped_count integer := 0;
  expected_confirmation text;
  final_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  select r.* into run_row
  from public.organization_automation_runs r
  where r.id = p_run_id
    and r.organization_id = org
  for update of r;
  if run_row.id is null
     or run_row.status not in ('succeeded', 'partial')
     or run_row.effects_created <= run_row.effects_rolled_back
     or run_row.rollback_until is null
     or run_row.rollback_until <= pg_catalog.now() then
    raise exception 'automation run is not rollback eligible' using errcode = '22023';
  end if;

  expected_confirmation := 'ROLL BACK ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8));
  if p_confirmation is distinct from expected_confirmation then
    raise exception 'automation rollback confirmation did not match' using errcode = '22023';
  end if;

  for effect_row in
    select e.*
    from public.organization_automation_effects e
    where e.organization_id = org
      and e.run_id = run_row.id
      and e.status = 'created'
    order by e.created_at, e.id
    for update of e
  loop
    select t.* into task_row
    from public.chapter_tasks t
    where t.id = effect_row.task_id
    for update of t;

    if task_row.id is null
       or task_row.deleted_at is not null
       or task_row.title is distinct from effect_row.task_title
       or task_row.description <> ''
       or task_row.status <> 'to_do'
       or task_row.priority is distinct from effect_row.task_priority
       or task_row.progress <> 0
       or task_row.assignee_id is not null
       or task_row.start_date is not null
       or task_row.due_date is not null
       or task_row.blocked
       or task_row.milestone
       or task_row.task_type <> 'general'
       or task_row.workstream <> 'General'
       or task_row.updated_at > task_row.created_at + interval '5 seconds'
       or (select pg_catalog.count(*) from public.chapter_task_activity a where a.task_id = task_row.id) <> 1
       or exists (select 1 from public.chapter_task_comments c where c.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_messages m where m.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_attachments a where a.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_files f where f.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_assignments a where a.task_id = task_row.id)
       or exists (select 1 from public.chapter_task_watchers w where w.task_id = task_row.id)
       or exists (
         select 1 from public.chapter_task_dependencies d
         where d.task_id = task_row.id or d.depends_on_id = task_row.id
       )
       or exists (
         select 1 from public.chapter_task_subtasks s
         where s.parent_task_id = task_row.id or s.subtask_id = task_row.id
       )
       or exists (select 1 from public.chapter_task_template_details td where td.task_id = task_row.id) then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    update public.chapter_tasks
       set deleted_at = pg_catalog.now(), deleted_by = actor
     where id = task_row.id;
    update public.organization_automation_effects
       set status = 'rolled_back', rolled_back_at = pg_catalog.now(), rolled_back_by = actor
     where id = effect_row.id;
    rolled_back_count := rolled_back_count + 1;
  end loop;

  final_status := case when skipped_count = 0 then 'rolled_back' else 'rollback_partial' end;
  update public.organization_automation_runs
     set status = final_status,
         effects_rolled_back = effects_rolled_back + rolled_back_count,
         rollback_skipped = rollback_skipped + skipped_count,
         rolled_back_at = pg_catalog.now(),
         rolled_back_by = actor
   where id = run_row.id;

  perform private.cr108_record_audit(
    org, 'automation_run_rolled_back', 'update', 'automation_run',
    run_row.id::text, actor,
    pg_catalog.jsonb_build_object(
      'runId', run_row.id, 'status', final_status,
      'count', rolled_back_count, 'reasonCode', case when skipped_count > 0 then 'human_modified' else null end
    ),
    extensions.gen_random_uuid()
  );

  return pg_catalog.jsonb_build_object(
    'id', run_row.id, 'status', final_status,
    'effectsRolledBack', rolled_back_count, 'rollbackSkipped', skipped_count
  );
end;
$function$;

create function private.run_due_organization_automations(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  candidate_row record;
  definition_row public.organization_automation_definitions%rowtype;
  run_id uuid;
  processed integer := 0;
  succeeded integer := 0;
  failed integer := 0;
begin
  if p_limit not between 1 and 50 then
    raise exception 'scheduled automation limit out of range' using errcode = '22023';
  end if;

  for candidate_row in
    select d.id, d.organization_id
    from public.organization_automation_definitions d
    join public.organization_automation_settings s
      on s.organization_id = d.organization_id and s.enabled
    join public.organizations o
      on o.id = d.organization_id and o.status = 'active'
    where d.status = 'active'
      and d.next_run_at is not null
      and d.next_run_at <= pg_catalog.now()
    order by d.next_run_at, d.organization_id, d.id
    limit p_limit
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('organization-automation:' || candidate_row.organization_id::text, 0));

    definition_row := null;
    select d.* into definition_row
    from public.organization_automation_definitions d
    join public.organization_automation_settings s
      on s.organization_id = d.organization_id and s.enabled
    join public.organizations o
      on o.id = d.organization_id and o.status = 'active'
    where d.id = candidate_row.id
      and d.organization_id = candidate_row.organization_id
      and d.status = 'active'
      and d.next_run_at is not null
      and d.next_run_at <= pg_catalog.now()
    for update of d skip locked;
    if definition_row.id is null then
      continue;
    end if;

    processed := processed + 1;
    run_id := extensions.gen_random_uuid();
    insert into public.organization_automation_runs (
      id, organization_id, definition_id, definition_version, mode, status,
      initiated_by
    ) values (
      run_id, definition_row.organization_id, definition_row.id,
      definition_row.version, 'scheduled', 'in_progress', null
    );
    begin
      perform private.cr108_execute_run(run_id);
      succeeded := succeeded + 1;
    exception when others then
      failed := failed + 1;
      update public.organization_automation_runs
         set status = 'failed', failure_code = 'internal_error',
             completed_at = pg_catalog.now()
       where id = run_id;
      update public.organization_automation_definitions
         set last_run_at = pg_catalog.now(),
             next_run_at = private.cr108_next_run(cadence, pg_catalog.now()),
             updated_at = pg_catalog.now()
       where id = definition_row.id;
    end;
  end loop;

  return pg_catalog.jsonb_build_object(
    'processed', processed, 'succeeded', succeeded, 'failed', failed
  );
end;
$function$;

revoke all on function private.cr108_require_operator() from public, anon, authenticated, service_role;
revoke all on function private.cr108_next_run(text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.cr108_record_audit(uuid, text, text, text, text, uuid, jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function private.cr108_candidate_count(uuid, uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function private.cr108_candidate_sources(uuid, uuid, text, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.cr108_execute_run(uuid) from public, anon, authenticated, service_role;
revoke all on function private.run_due_organization_automations(integer) from public, anon, authenticated, service_role;

revoke all on function public.get_organization_automation_control_room() from public, anon, authenticated, service_role;
revoke all on function public.save_organization_automation_definition(uuid, text, text, integer, text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_automation_definition_status(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_automation_enabled(boolean, text) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_automation_safety_cap(integer) from public, anon, authenticated, service_role;
revoke all on function public.preview_organization_automation_run(uuid) from public, anon, authenticated, service_role;
revoke all on function public.execute_organization_automation_run(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.rollback_organization_automation_run(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.get_organization_automation_control_room() to authenticated;
grant execute on function public.save_organization_automation_definition(uuid, text, text, integer, text, text, integer) to authenticated;
grant execute on function public.set_organization_automation_definition_status(uuid, text, integer) to authenticated;
grant execute on function public.set_organization_automation_enabled(boolean, text) to authenticated;
grant execute on function public.set_organization_automation_safety_cap(integer) to authenticated;
grant execute on function public.preview_organization_automation_run(uuid) to authenticated;
grant execute on function public.execute_organization_automation_run(uuid, text) to authenticated;
grant execute on function public.rollback_organization_automation_run(uuid, text) to authenticated;

do $schedule$
begin
  if pg_catalog.to_regclass('cron.job') is null then
    return;
  end if;
  perform cron.unschedule(j.jobid)
  from cron.job j
  where j.jobname = 'organization-automation-tick';
  perform cron.schedule(
    'organization-automation-tick',
    '11 * * * *',
    $job$select private.run_due_organization_automations(25);$job$
  );
end;
$schedule$;
