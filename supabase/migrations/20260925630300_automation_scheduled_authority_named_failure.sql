-- OPS-UG-AUTOMATION-SCHEDULED-AUTHORITY-DEPENDS-ON-LAST-EDITOR-20260921
--
-- The hourly pg_cron job private.run_due_organization_automations inserts each
-- scheduled run with initiated_by = null, so private.automation_v2_execute
-- (20260910045839:459) gates on automation_v2_operator(d.updated_by). That is
-- the approver who last activated or edited the definition. Once that person
-- is demoted, leaves, loses their second factor, or has their account deleted
-- (updated_by on delete set null), the gate raises 42501 'operator
-- unavailable'. The dispatcher's `exception when others` arm then recorded
-- failure_code = 'internal_error' and advanced next_run_at, so the definition
-- failed every cadence with no named cause. The v2 control room's
-- dependencyReady flag, which surfaced the condition, was dropped when the
-- v3 workspace replaced it.
--
-- This takes the record's minimum repair, which names the gap and does not
-- widen authority. Scheduled execution still runs only with the authority of
-- a current Admin/President, so whose visibility a scheduled run uses does not
-- change:
--
--   1. organization_automation_runs.failure_code admits 'operator_unavailable'.
--   2. run_due_organization_automations records that code when the run fails
--      on exactly that refusal (42501 'operator unavailable'). Every other
--      failure is still 'internal_error'. The retry cadence is unchanged.
--   3. private.automation_v3_definition_json (the four-argument projection
--      mi1_get_automation_workspace calls) restores dependencyReady =
--      automation_v2_operator(updated_by) for approvers only. Other staff do
--      not learn another person's role or factor state. An approver fixes a
--      false flag by activating the definition again, which re-stamps
--      updated_by.
--
-- Both functions are re-declared from their installed bodies (20260911070000
-- and 20260924181000). The digest guard below refuses any other predecessor,
-- and the dispatcher keeps its case-graph lock first.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'private.run_due_organization_automations(integer)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'b81a4805adf0889b4f680fe6504cd1d01aa526ac3c2e04be53440a9d13dddeff' then
    raise exception 'unreviewed run_due_organization_automations predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'private.automation_v3_definition_json(public.organization_automation_definitions, uuid, uuid, boolean)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '5282e18414dce96305533409a40d3710b89cbda921aaf976e618f8f4320aed15' then
    raise exception 'unreviewed automation_v3_definition_json predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

alter table public.organization_automation_runs
  drop constraint organization_automation_runs_failure_code_check,
  add constraint organization_automation_runs_failure_code_check check (
    failure_code is null
    or failure_code in ('disabled', 'definition_changed', 'effect_write_failed', 'internal_error', 'operator_unavailable')
  );

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
      -- A scheduled run has no initiator, so private.automation_v2_execute
      -- takes its authority from the definition's updated_by (the approver who
      -- last activated or edited it) and raises 'operator unavailable' once
      -- that person is no longer an active Admin/President with the required
      -- second factor. Name that cause instead of folding it into
      -- internal_error.
      update public.organization_automation_runs
         set status = 'failed',
             failure_code = case
               when sqlstate = '42501' and sqlerrm = 'operator unavailable' then 'operator_unavailable'
               else 'internal_error'
             end,
             completed_at = pg_catalog.now()
       where id = run_id;
      update public.organization_automation_definitions
         set last_run_at = pg_catalog.now(), next_run_at = private.cr108_next_run(cadence, pg_catalog.now()), updated_at = pg_catalog.now()
       where id = definition_row.id;
    end;
  end loop;
  return pg_catalog.jsonb_build_object('processed', processed, 'succeeded', succeeded, 'failed', failed);
end;
end;
$function$;

create or replace function private.automation_v3_definition_json(
  d public.organization_automation_definitions,
  p_actor uuid,
  p_org uuid,
  p_approver boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result jsonb := private.automation_v2_definition_json(d);
  approver boolean := coalesce(p_approver, false);
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
    'canEdit', coalesce(d.status <> 'archived' and (approver or d.created_by = p_actor)
      and d.review_status in ('draft', 'changes_requested'), false),
    'canSubmit', coalesce(d.status <> 'archived' and (approver or d.created_by = p_actor)
      and d.review_status in ('draft', 'changes_requested'), false),
    'canReview', coalesce(approver and d.review_status = 'submitted', false),
    'canActivate', coalesce(approver
      and d.review_status = 'approved' and d.review_version = d.version, false),
    'canPreview', coalesce(private.automation_v3_definition_visible(d, p_actor, p_org, approver), false)
  ) || case
    -- Approvers only: whether the scheduled authority (updated_by) is still an
    -- active Admin/President operator. false means every scheduled tick fails
    -- with 'operator_unavailable' until an approver activates it again.
    when approver then pg_catalog.jsonb_build_object(
      'dependencyReady', coalesce(private.automation_v2_operator(d.updated_by, p_org), false)
    )
    else '{}'::jsonb
  end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
