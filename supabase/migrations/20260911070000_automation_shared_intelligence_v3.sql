begin;

alter table public.organization_audit_ledger
  drop constraint organization_audit_ledger_metadata_keys,
  add constraint organization_audit_ledger_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId', 'status',
      'requireStaffMfa', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'action', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence', 'dataClass', 'retentionDays', 'eligibleCount',
      'deletedCount', 'remainingCount', 'mode', 'executionEnabled', 'operation',
      'reviewStatus', 'version', 'selfReview'
    ] = '{}'::jsonb
  );

alter table public.organization_automation_definitions
  add column review_status text not null default 'draft',
  add column review_version integer,
  add column submitted_by uuid,
  add column submitted_at timestamptz,
  add column reviewed_by uuid,
  add column reviewed_at timestamptz,
  add column review_note text;

update public.organization_automation_definitions
set review_status = case when status in ('active', 'paused') then 'approved' else 'draft' end,
    review_version = case when status in ('active', 'paused') then version else null end;

alter table public.organization_automation_definitions
  add constraint organization_automation_review_status_check check (
    (review_status = 'draft' and review_version is null)
    or (review_status in ('submitted', 'changes_requested', 'approved') and review_version = version)
  ),
  add constraint organization_automation_review_note_check check (
    review_note is null or (length(review_note) between 1 and 500 and review_note !~ '[[:cntrl:]]')
  );

create index organization_automation_definitions_review_idx
  on public.organization_automation_definitions (organization_id, review_status, updated_at desc, id);

create table public.organization_automation_definition_reviews (
  id uuid primary key default extensions.gen_random_uuid(),
  -- This is an evidence ledger, not a child record. Retain its tenant and
  -- definition identifiers even if a privileged maintenance operation later
  -- removes the source row; the SECURITY DEFINER review RPC is its only writer.
  organization_id uuid not null,
  definition_id uuid not null,
  definition_version integer not null check (definition_version > 0),
  action text not null check (action in ('submitted', 'approved', 'changes_requested')),
  actor_id uuid not null,
  note text check (note is null or (length(note) between 1 and 500 and note !~ '[[:cntrl:]]')),
  snapshot_digest text not null check (snapshot_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now()
);

create index organization_automation_definition_reviews_history_idx
  on public.organization_automation_definition_reviews
  (organization_id, definition_id, definition_version, created_at, id);

alter table public.organization_automation_definition_reviews enable row level security;
revoke all on table public.organization_automation_definition_reviews from public, anon, authenticated, service_role;

create policy mfa_assurance on public.organization_automation_definition_reviews
as restrictive for all to authenticated
using ((select private.mfa_satisfied()))
with check ((select private.mfa_satisfied()));

comment on policy mfa_assurance on public.organization_automation_definition_reviews is
  'Restrictive MFA boundary for exact-version automation review evidence; authenticated access remains denied unless the selected staff session satisfies the organization assurance policy.';

create or replace function private.automation_definition_reviews_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  raise exception 'automation definition reviews are append only' using errcode = '55000';
end;
$function$;

create trigger automation_definition_reviews_append_only
before update or delete on public.organization_automation_definition_reviews
for each row execute function private.automation_definition_reviews_append_only();

create or replace function private.automation_v3_actor_is_author(p_actor uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_actor is not null
    and exists (
      select 1
      from public.organizations o
      join public.organization_memberships m
        on m.organization_id = o.id
       and m.user_id = p_actor
       and m.status = 'active'
      where o.id = p_org
        and o.status = 'active'
        and (not private.staff_mfa_required(o.id) or private.has_second_factor(p_actor))
        and (
          exists (
            select 1 from public.organization_role_grants g
            where g.organization_id = o.id
              and g.user_id = p_actor
              and g.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
          )
          or exists (
            select 1
            from public.member_role_chapters r
            join public.chapters ch on ch.id = r.chapter_id and ch.organization_id = o.id
            join public.member_chapter_memberships cm
              on cm.user_id = r.user_id and cm.chapter_id = r.chapter_id and cm.status = 'active'
            where r.user_id = p_actor
              and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
          )
        )
    );
$function$;

create or replace function private.automation_v3_actor_is_approver(p_actor uuid, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.automation_v3_actor_is_author(p_actor, p_org)
    and exists (
      select 1 from public.organization_role_grants g
      where g.organization_id = p_org
        and g.user_id = p_actor
        and g.role in ('admin', 'vp')
    );
$function$;

create or replace function private.automation_v3_require_author()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if not private.automation_v3_actor_is_author((select auth.uid()), org) then
    raise exception 'active automation author role required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create or replace function private.automation_v3_require_approver()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.automation_v3_require_author();
begin
  if not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if not private.automation_v3_actor_is_approver((select auth.uid()), org) then
    raise exception 'automation approver role required' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create or replace function private.automation_v3_source_visible(
  p_actor uuid,
  p_org uuid,
  p_kind text,
  p_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.automation_v3_actor_is_author(p_actor, p_org) and exists (
    select 1
    from (
      select t.id::text id, t.chapter_id, 'task'::text kind
      from public.chapter_tasks t where t.deleted_at is null
      union all
      select c.id::text, c.chapter_id, 'case'
      from public.member_cases c
      where c.organization_id = p_org and private.automation_v2_case_visible(p_actor, p_org, c.id)
      union all
      select d.id::text, d.chapter_id, 'casework_deadline'
      from public.casework_deadlines d
      where d.organization_id = p_org and private.automation_v2_case_visible(p_actor, p_org, d.case_id)
      union all
      select c.id::text, c.chapter_id, 'checklist'
      from public.casework_checklists c
      where c.organization_id = p_org and private.automation_v2_case_visible(p_actor, p_org, c.case_id)
      union all
      select a.id::text, a.chapter_id, 'appointment'
      from public.member_appointments a
      where exists (
        select 1 from public.organization_memberships m
        where m.organization_id = p_org and m.user_id = a.user_id and m.status = 'active'
      )
      and exists (
        select 1 from public.organization_memberships m
        where m.organization_id = p_org and m.user_id = a.steward_id and m.status = 'active'
      )
      -- Keep the V2 selected-chapter supervisor route: broadening the author
      -- class must not let organization staff without appointment supervision
      -- (for example a President) read another member's appointment context.
      and exists (select 1 from public.member_profiles p where p.id = p_actor and p.chapter_id = a.chapter_id)
      and (
        a.user_id = p_actor
        or (a.steward_id = p_actor and exists (
          select 1 from public.member_role_chapters g
          where g.user_id = p_actor and g.chapter_id = a.chapter_id and g.role = 'steward'
        ))
        or exists (
          select 1 from public.organization_role_grants g
          where g.organization_id = p_org and g.user_id = p_actor and g.role in ('coordinator', 'advisor', 'admin')
        )
        or exists (
          select 1 from public.member_role_chapters g
          where g.user_id = p_actor and g.chapter_id = a.chapter_id and g.role in ('coordinator', 'advisor', 'admin')
        )
      )
      union all
      select e.id, e.chapter_id, 'event' from public.member_events e
    ) source
    join public.chapters chapter on chapter.id = source.chapter_id and chapter.organization_id = p_org
    where source.kind = p_kind
      and source.id = p_id
      and private.actor_has_chapter_staff_role(p_actor, chapter.id)
  );
$function$;

-- V2 validation remains the typed capability authority. Widen only its
-- actor-explicit source predicate to the new author class; public reads still
-- pass through their own selected-organization and role guards.
create or replace function private.automation_v2_source_visible(p_actor uuid, p_org uuid, p_kind text, p_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.automation_v3_source_visible(p_actor, p_org, p_kind, p_id);
$function$;

create or replace function private.automation_v3_definition_visible(
  d public.organization_automation_definitions,
  p_actor uuid,
  p_org uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select d.organization_id = p_org
    and (
      private.automation_v3_actor_is_approver(p_actor, p_org)
      or d.created_by = p_actor
      or (
        d.review_status in ('submitted', 'changes_requested', 'approved')
        and (
          not (d.conditions ? 'chapterId')
          or private.actor_has_chapter_staff_role(p_actor, d.conditions->>'chapterId')
        )
      )
    );
$function$;

create or replace function private.automation_v3_definition_json(
  d public.organization_automation_definitions,
  p_actor uuid,
  p_org uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb := private.automation_v2_definition_json(d);
  source_kind text := case
    when d.trigger_kind in ('case_deadline', 'unassigned_case') then 'case'
    when d.trigger_kind = 'casework_deadline' then 'case'
    when d.trigger_kind = 'incomplete_case_checklist' then 'case'
    when d.trigger_kind like 'appointment_%' then 'appointment'
    when d.trigger_kind like 'event_%' then 'event'
    else 'task'
  end;
begin
  if d.conditions ? 'sourceId'
     and not private.automation_v3_source_visible(p_actor, p_org, source_kind, d.conditions->>'sourceId') then
    result := pg_catalog.jsonb_set(result, '{conditions}', (result->'conditions') - 'sourceId')
      || pg_catalog.jsonb_build_object('sourceFilterAvailable', false);
  end if;

  -- Every capability flag is an exact boolean. submitted_by and created_by are
  -- nullable (never submitted, or the author account was deleted), and a SQL
  -- NULL here would make the strict client normalizer reject the whole workspace.
  return result || pg_catalog.jsonb_build_object(
    'reviewStatus', d.review_status,
    'reviewVersion', d.review_version,
    'submittedBySelf', coalesce(d.submitted_by = p_actor, false),
    'submittedAt', d.submitted_at,
    'reviewedAt', d.reviewed_at,
    'reviewNote', d.review_note,
    'canEdit', coalesce(d.status <> 'archived' and (private.automation_v3_actor_is_approver(p_actor, p_org) or d.created_by = p_actor)
      and d.review_status in ('draft', 'changes_requested'), false),
    'canSubmit', coalesce(d.status <> 'archived' and (private.automation_v3_actor_is_approver(p_actor, p_org) or d.created_by = p_actor)
      and d.review_status in ('draft', 'changes_requested'), false),
    'canReview', coalesce(private.automation_v3_actor_is_approver(p_actor, p_org) and d.review_status = 'submitted', false),
    'canActivate', coalesce(private.automation_v3_actor_is_approver(p_actor, p_org)
      and d.review_status = 'approved' and d.review_version = d.version, false),
    'canPreview', coalesce(private.automation_v3_definition_visible(d, p_actor, p_org), false)
  );
end;
$function$;

create or replace function private.automation_v3_snapshot_digest(d public.organization_automation_definitions)
returns text
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(private.automation_v2_definition_json(d)::text, 'UTF8'), 'sha256'),
    'hex'
  );
$function$;

create or replace function public.mi1_save_automation_definition_v2(p_definition jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
  definition_id uuid;
  approver boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  approver := private.automation_v3_actor_is_approver(actor, org);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.automation_v3_require_author() is distinct from org then
    raise exception 'organization changed' using errcode = '42501';
  end if;
  perform private.automation_v2_validate(org, p_definition);
  definition_id := (p_definition->>'id')::uuid;
  if not approver and not ((p_definition->'conditions') ? 'chapterId' or (p_definition->'conditions') ? 'sourceId') then
    raise exception 'staff drafts require visible chapter or source scope' using errcode = '42501';
  end if;

  if definition_id is null then
    if p_definition ? 'expectedVersion' then
      raise exception 'new definition cannot have version' using errcode = '22023';
    end if;
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, action_kind, schema_version, conditions, action_config,
      created_by, updated_by, review_status, review_version
    ) values (
      org, pg_catalog.btrim(p_definition->>'name'), p_definition->>'triggerKind',
      (p_definition->>'thresholdDays')::smallint, p_definition->>'taskPriority',
      p_definition->>'cadence', p_definition->>'actionKind', 2,
      p_definition->'conditions', p_definition->'actionConfig', actor, actor,
      'draft', null
    ) returning * into saved;
  else
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_definition->>'name'),
           trigger_kind = p_definition->>'triggerKind',
           threshold_days = (p_definition->>'thresholdDays')::smallint,
           task_priority = p_definition->>'taskPriority',
           cadence = p_definition->>'cadence',
           action_kind = p_definition->>'actionKind',
           schema_version = 2,
           conditions = p_definition->'conditions',
           action_config = p_definition->'actionConfig',
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now(),
           review_status = 'draft',
           review_version = null,
           submitted_by = null,
           submitted_at = null,
           reviewed_by = null,
           reviewed_at = null,
           review_note = null
     where d.id = definition_id
       and d.organization_id = org
       and d.version = (p_definition->>'expectedVersion')::integer
       and d.status <> 'archived'
       and (approver or (d.created_by = actor and d.review_status in ('draft', 'changes_requested')))
     returning d.* into saved;
    if saved.id is null then
      raise exception 'definition changed or is not editable' using errcode = '40001';
    end if;
  end if;

  perform private.cr108_record_audit(
    org,
    case when definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when definition_id is null then 'create' else 'update' end,
    'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version),
    extensions.gen_random_uuid()
  );
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

create or replace function public.mi1_get_automation_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.automation_v3_require_author();
  definitions jsonb;
  runs jsonb;
  approver boolean := private.automation_v3_actor_is_approver(actor, org);
begin
  select coalesce(pg_catalog.jsonb_agg(private.automation_v3_definition_json(d, actor, org) order by d.updated_at desc, d.id), '[]'::jsonb)
    into definitions
  from (
    select * from public.organization_automation_definitions d
    where private.automation_v3_definition_visible(d, actor, org)
    order by d.updated_at desc, d.id
    limit 100
  ) d;

  select coalesce(pg_catalog.jsonb_agg(
      private.automation_v2_run_json(r) || pg_catalog.jsonb_build_object('definitionName', d.name)
      order by r.created_at desc, r.id desc
    ), '[]'::jsonb)
    into runs
  from (
    select * from public.organization_automation_runs r
    where r.organization_id = org and (approver or r.initiated_by = actor)
    order by r.created_at desc, r.id desc
    limit 50
  ) r
  join public.organization_automation_definitions d on d.id = r.definition_id;

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'access', pg_catalog.jsonb_build_object('canAuthor', true, 'canApprove', approver, 'canOperate', approver),
    'settings', pg_catalog.jsonb_build_object(
      'enabled', coalesce((select s.enabled from public.organization_automation_settings s where s.organization_id = org), false),
      'maxEffectsPerRun', coalesce((select s.max_effects_per_run from public.organization_automation_settings s where s.organization_id = org), 20)
    ),
    'schedulerConfigured', exists(select 1 from cron.job j where j.jobname = 'organization-automation-tick' and j.active),
    'capabilities', pg_catalog.jsonb_build_object(
      'schemaVersion', 2,
      'triggers', pg_catalog.to_jsonb(array['overdue_task','case_deadline','unassigned_case','task_due','blocked_task','unassigned_task','stale_task','review_task','casework_deadline','incomplete_case_checklist','appointment_upcoming','appointment_followup','event_upcoming','event_followup']),
      'actions', pg_catalog.to_jsonb(array['create_standard_task','assign_task','raise_task_priority','notify_in_app']),
      'cadences', pg_catalog.to_jsonb(array['hourly','daily','weekly']),
      'maxThresholdDays', 90
    ),
    'definitions', definitions,
    'runs', runs
  );
end;
$function$;

create or replace function public.mi1_get_automation_opportunities()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.automation_v3_require_author();
  result jsonb;
  scope_label text := case when private.automation_v3_actor_is_approver(actor, org) then 'organization' else 'chapter' end;
begin
  with visible_tasks as (
    select t.*
    from public.chapter_tasks t
    join public.chapters ch on ch.id = t.chapter_id and ch.organization_id = org
    where t.deleted_at is null and private.actor_has_chapter_staff_role(actor, ch.id)
  ), aggregates(trigger_kind, candidate_count, threshold_days) as (
    select 'overdue_task', count(*)::integer, 1 from visible_tasks where due_date < current_date and status in ('backlog','to_do','in_progress','needs_review')
    union all select 'task_due', count(*)::integer, 3 from visible_tasks where due_date between current_date and current_date + 3 and status in ('backlog','to_do','in_progress','needs_review')
    union all select 'blocked_task', count(*)::integer, 0 from visible_tasks where blocked and status in ('backlog','to_do','in_progress','needs_review')
    union all select 'unassigned_task', count(*)::integer, 0 from visible_tasks t where t.assignee_id is null and not exists(select 1 from public.chapter_task_assignments a where a.task_id = t.id)
    union all select 'stale_task', count(*)::integer, 7 from visible_tasks where updated_at < pg_catalog.now() - interval '7 days' and status in ('backlog','to_do','in_progress','needs_review')
    union all select 'review_task', count(*)::integer, 2 from visible_tasks where status = 'needs_review'
  ), bounded as (
    select a.*, exists (
      select 1 from public.organization_automation_definitions d
      where d.organization_id = org
        and d.trigger_kind = a.trigger_kind
        and d.status <> 'archived'
        and d.review_status in ('submitted', 'approved')
        and private.automation_v3_definition_visible(d, actor, org)
    ) covered
    from aggregates a
    where a.candidate_count > 0
    order by a.candidate_count desc, a.trigger_kind
    limit 8
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'triggerKind', trigger_kind,
    'candidateCount', least(candidate_count, 9999),
    'thresholdDays', threshold_days,
    'scope', scope_label,
    'covered', covered
  ) order by candidate_count desc, trigger_kind), '[]'::jsonb)
  into result from bounded;
  return pg_catalog.jsonb_build_object('capabilityVersion', 2, 'observedAt', pg_catalog.now(), 'rows', result);
end;
$function$;

create or replace function public.mi1_get_automation_ai_authorization()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.automation_v3_require_author();
begin
  return pg_catalog.jsonb_build_object('authorized', true, 'organizationId', org, 'capabilityVersion', 2);
end;
$function$;

create or replace function public.mi1_submit_automation_definition(
  p_definition_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  approver boolean;
  saved public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  approver := private.automation_v3_actor_is_approver(actor, org);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set review_status = 'submitted',
         review_version = d.version,
         submitted_by = actor,
         submitted_at = pg_catalog.now(),
         reviewed_by = null,
         reviewed_at = null,
         review_note = null,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.status <> 'archived'
     and d.review_status in ('draft', 'changes_requested')
     and (approver or d.created_by = actor)
   returning d.* into saved;
  if saved.id is null then raise exception 'definition changed or cannot be submitted' using errcode = '40001'; end if;
  insert into public.organization_automation_definition_reviews (
    organization_id, definition_id, definition_version, action, actor_id, snapshot_digest
  ) values (org, saved.id, saved.version, 'submitted', actor, private.automation_v3_snapshot_digest(saved));
  perform private.cr108_record_audit(org, 'automation_definition_submitted', 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('reviewStatus', saved.review_status, 'version', saved.version), extensions.gen_random_uuid());
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

create or replace function public.mi1_review_automation_definition(
  p_definition_id uuid,
  p_expected_version integer,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
  next_status text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  if p_action not in ('approve', 'request_changes')
      or (p_note is not null and (length(p_note) not between 1 and 500 or p_note ~ '[[:cntrl:]]'))
      or (p_action = 'request_changes' and p_note is null) then
    raise exception 'invalid automation review' using errcode = '22023';
  end if;
  next_status := case p_action when 'approve' then 'approved' else 'changes_requested' end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set review_status = next_status,
         review_version = d.version,
         reviewed_by = actor,
         reviewed_at = pg_catalog.now(),
         review_note = p_note,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.review_status = 'submitted'
   returning d.* into saved;
  if saved.id is null then raise exception 'submitted definition changed' using errcode = '40001'; end if;
  insert into public.organization_automation_definition_reviews (
    organization_id, definition_id, definition_version, action, actor_id, note, snapshot_digest
  ) values (org, saved.id, saved.version, next_status, actor, p_note, private.automation_v3_snapshot_digest(saved));
  perform private.cr108_record_audit(org, 'automation_definition_' || next_status, 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('reviewStatus', saved.review_status, 'version', saved.version, 'selfReview', saved.submitted_by = actor), extensions.gen_random_uuid());
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

create or replace function public.mi1_preview_automation_definition(p_definition_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  definition_row public.organization_automation_definitions%rowtype;
  run_row public.organization_automation_runs%rowtype;
  candidate_total integer;
  effect_limit integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  effect_limit := 20;
  select d.* into definition_row
  from public.organization_automation_definitions d
  where d.id = p_definition_id
    and d.organization_id = org
    and d.status <> 'archived'
    and private.automation_v3_definition_visible(d, actor, org);
  if definition_row.id is null then raise exception 'automation definition unavailable' using errcode = '42501'; end if;
  select count(*)::integer into candidate_total
  from private.automation_v2_candidates(definition_row.id) c
  where private.automation_v3_source_visible(actor, org, c.source_kind, c.source_id);
  select coalesce(s.max_effects_per_run, 20) into effect_limit
  from (select 1) seed left join public.organization_automation_settings s on s.organization_id = org;
  run_row.id := extensions.gen_random_uuid();
  run_row.confirmation_phrase := 'RUN ' || pg_catalog.upper(pg_catalog.left(run_row.id::text, 8));
  insert into public.organization_automation_runs (
    id, organization_id, definition_id, definition_version, mode, status,
    candidates_count, effects_skipped, confirmation_phrase, initiated_by, completed_at, definition_snapshot
  ) values (
    run_row.id, org, definition_row.id, definition_row.version, 'preview', 'previewed',
    candidate_total, greatest(candidate_total - effect_limit, 0), run_row.confirmation_phrase, actor, pg_catalog.now(),
    private.automation_v2_definition_json(definition_row)
  ) returning * into run_row;
  perform private.cr108_record_audit(org, 'automation_run_previewed', 'read', 'automation_run', run_row.id::text, actor,
    pg_catalog.jsonb_build_object('runId', run_row.id, 'count', candidate_total), extensions.gen_random_uuid());
  return pg_catalog.jsonb_build_object(
    'id', run_row.id, 'definitionId', definition_row.id, 'definitionName', definition_row.name,
    'mode', 'preview', 'status', 'previewed', 'candidatesCount', candidate_total,
    'willCreate', least(candidate_total, effect_limit),
    'effectsSkipped', greatest(candidate_total - effect_limit, 0),
    'confirmationPhrase', run_row.confirmation_phrase,
    'settingsEnabled', coalesce((select s.enabled from public.organization_automation_settings s where s.organization_id = org), false)
  );
end;
$function$;

create or replace function public.set_organization_automation_definition_status(
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
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  if p_status not in ('active', 'paused', 'archived') or p_expected_version is null then
    raise exception 'invalid automation status transition' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set status = p_status,
         next_run_at = case when p_status = 'active' then pg_catalog.now() else null end,
         updated_by = actor,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.status <> 'archived'
     and (p_status <> 'active' or (d.review_status = 'approved' and d.review_version = d.version))
   returning d.* into saved;
  if saved.id is null then raise exception 'definition changed, unapproved, or unavailable' using errcode = '40001'; end if;
  perform private.cr108_record_audit(org, 'automation_definition_status_changed', 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version), extensions.gen_random_uuid());
  return pg_catalog.jsonb_build_object('id', saved.id, 'status', saved.status, 'version', saved.version, 'nextRunAt', saved.next_run_at);
end;
$function$;

create or replace function public.execute_organization_automation_run(
  p_run_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  run_row public.organization_automation_runs%rowtype;
  definition_row public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  select r.* into run_row from public.organization_automation_runs r
  where r.id = p_run_id and r.organization_id = org and r.mode = 'preview' and r.status = 'previewed'
  for update of r;
  if run_row.id is null then raise exception 'automation preview unavailable' using errcode = '22023'; end if;
  if run_row.completed_at < pg_catalog.now() - interval '15 minutes' then raise exception 'automation preview expired' using errcode = '22023'; end if;
  if p_confirmation is distinct from run_row.confirmation_phrase then raise exception 'automation run confirmation did not match' using errcode = '22023'; end if;
  if not exists(select 1 from public.organization_automation_settings s where s.organization_id = org and s.enabled) then
    raise exception 'organization automation is paused' using errcode = '22023';
  end if;
  select d.* into definition_row from public.organization_automation_definitions d
  where d.id = run_row.definition_id
    and d.organization_id = org
    and d.version = run_row.definition_version
    and d.status = 'active'
    and d.review_status = 'approved'
    and d.review_version = d.version
  for update of d;
  if definition_row.id is null then raise exception 'automation definition changed or approval is stale; preview again' using errcode = '40001'; end if;
  update public.organization_automation_runs
     set mode = 'manual', status = 'in_progress', initiated_by = actor,
         started_at = pg_catalog.now(), completed_at = null, candidates_count = 0,
         effects_skipped = 0, confirmation_phrase = null
   where id = run_row.id;
  return private.cr108_execute_run(run_row.id);
end;
$function$;

create or replace function private.run_due_organization_automations(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  candidate_row record;
  definition_row public.organization_automation_definitions%rowtype;
  run_id uuid;
  processed integer;
  succeeded integer;
  failed integer;
begin
  processed := 0;
  succeeded := 0;
  failed := 0;
  if p_limit not between 1 and 50 then raise exception 'scheduled automation limit out of range' using errcode = '22023'; end if;
  for candidate_row in
    select d.id, d.organization_id
    from public.organization_automation_definitions d
    join public.organization_automation_settings s on s.organization_id = d.organization_id and s.enabled
    join public.organizations o on o.id = d.organization_id and o.status = 'active'
    where d.status = 'active'
      and d.review_status = 'approved'
      and d.review_version = d.version
      and d.next_run_at is not null and d.next_run_at <= pg_catalog.now()
    order by d.next_run_at, d.organization_id, d.id
    limit p_limit
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || candidate_row.organization_id::text, 0));
    definition_row := null;
    select d.* into definition_row
    from public.organization_automation_definitions d
    join public.organization_automation_settings s on s.organization_id = d.organization_id and s.enabled
    join public.organizations o on o.id = d.organization_id and o.status = 'active'
    where d.id = candidate_row.id
      and d.organization_id = candidate_row.organization_id
      and d.status = 'active'
      and d.review_status = 'approved'
      and d.review_version = d.version
      and d.next_run_at is not null and d.next_run_at <= pg_catalog.now()
    for update of d skip locked;
    if definition_row.id is null then continue; end if;
    processed := processed + 1;
    run_id := extensions.gen_random_uuid();
    insert into public.organization_automation_runs (
      id, organization_id, definition_id, definition_version, mode, status, initiated_by
    ) values (run_id, definition_row.organization_id, definition_row.id, definition_row.version, 'scheduled', 'in_progress', null);
    begin
      perform private.cr108_execute_run(run_id);
      succeeded := succeeded + 1;
    exception when others then
      failed := failed + 1;
      update public.organization_automation_runs set status = 'failed', failure_code = 'internal_error', completed_at = pg_catalog.now() where id = run_id;
      update public.organization_automation_definitions
         set last_run_at = pg_catalog.now(), next_run_at = private.cr108_next_run(cadence, pg_catalog.now()), updated_at = pg_catalog.now()
       where id = definition_row.id;
    end;
  end loop;
  return pg_catalog.jsonb_build_object('processed', processed, 'succeeded', succeeded, 'failed', failed);
end;
end;
$function$;

revoke all on function private.automation_definition_reviews_append_only() from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_actor_is_author(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_actor_is_approver(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_require_author() from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_require_approver() from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_source_visible(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.automation_v2_source_visible(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_definition_visible(public.organization_automation_definitions, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_definition_json(public.organization_automation_definitions, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_snapshot_digest(public.organization_automation_definitions) from public, anon, authenticated, service_role;
revoke all on function private.run_due_organization_automations(integer) from public, anon, authenticated, service_role;

revoke all on function public.mi1_save_automation_definition_v2(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.mi1_get_automation_workspace() from public, anon, authenticated, service_role;
revoke all on function public.mi1_get_automation_opportunities() from public, anon, authenticated, service_role;
revoke all on function public.mi1_get_automation_ai_authorization() from public, anon, authenticated, service_role;
revoke all on function public.mi1_submit_automation_definition(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.mi1_review_automation_definition(uuid, integer, text, text) from public, anon, authenticated, service_role;
revoke all on function public.mi1_preview_automation_definition(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_organization_automation_definition_status(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.execute_organization_automation_run(uuid, text) from public, anon, authenticated, service_role;

grant execute on function public.mi1_save_automation_definition_v2(jsonb) to authenticated;
grant execute on function public.mi1_get_automation_workspace() to authenticated;
grant execute on function public.mi1_get_automation_opportunities() to authenticated;
grant execute on function public.mi1_get_automation_ai_authorization() to authenticated;
grant execute on function public.mi1_submit_automation_definition(uuid, integer) to authenticated;
grant execute on function public.mi1_review_automation_definition(uuid, integer, text, text) to authenticated;
grant execute on function public.mi1_preview_automation_definition(uuid) to authenticated;
grant execute on function public.set_organization_automation_definition_status(uuid, text, integer) to authenticated;
grant execute on function public.execute_organization_automation_run(uuid, text) to authenticated;

-- The account-lifecycle audit inventories every trigger reachable from its
-- referential-action surface. Pin this new append-only evidence guard exactly.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
values
  ('trigger', 'public', 'organization_automation_definition_reviews', 'automation_definition_reviews_append_only', 'd90332c6f879c51b1261db552dab0689'),
  ('function', 'private', '', 'automation_definition_reviews_append_only()', 'a158984781f44878a79d63e8e7d0213b');

do $assert_account_lifecycle_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the shared automation intelligence migration';
  end if;
end;
$assert_account_lifecycle_trigger_review$;

commit;
