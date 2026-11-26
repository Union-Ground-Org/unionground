-- PERF-UG-MI1-GET-AUTOMATION-WORKSPACE-SCANS-ORGANIZATION-AUTOMATION-20260921
--
-- public.mi1_get_automation_workspace (20260911070000:446-454) selects the
-- definitions page with ONE predicate:
--
--   where private.automation_v3_definition_visible(d, actor, org)
--
-- The tenant bound is inside that SECURITY DEFINER function
-- (20260911070000:272 "select d.organization_id = p_org and (...)"), where the
-- planner cannot see it. So the workspace read -- the first RPC every
-- automation page issues, for every staff role -- reads EVERY tenant's
-- definition rows and calls the visibility function on each one;
-- organization_automation_definitions_review_idx (organization_id,
-- review_status, updated_at desc, id) is unusable without an explicit equality
-- on its leading column. Each of those calls enters
-- automation_v3_actor_is_approver -> automation_v3_actor_is_author, a six-table
-- EXISTS over organizations, organization_memberships,
-- organization_role_grants, member_role_chapters, chapters and
-- member_chapter_memberships. The surviving rows then reach
-- automation_v3_definition_json, which re-derives the SAME approver answer
-- three more times per row and calls the visibility function again for
-- canPreview.
--
-- Both sibling reads already carry the bound -- the runs subquery at
-- 20260911070000:459 ("r.organization_id = org"), the opportunities coverage
-- probe at :520 and the preview lookup at :670 -- and so did the v2 RPC this
-- one replaced (20260910045839 mi1_get_automation_definitions). The workspace
-- page is the one place the v3 rewrite dropped it.
--
-- Repair, in two parts, both behaviour-preserving:
--
--   1. Add `d.organization_id = org` beside the visibility call. It is the
--      same equality the function already asserts internally, so no row's
--      visibility changes; it is simply now a planner-visible, index-usable
--      predicate that is far cheaper than the function, which means the
--      qual-ordering cost model evaluates it first and other tenants' rows
--      never reach the definer call at all.
--   2. Let the caller hand down the approver decision it already made.
--      automation_v3_definition_visible and automation_v3_definition_json each
--      gain a four-argument form taking that boolean; the three-argument forms
--      stay -- every other caller is single-row -- and now resolve the approver
--      ONCE and delegate, instead of re-deriving it per projected field.
--
-- Nothing about who may see what changes. The visibility rule keeps its own
-- `d.organization_id = p_org` check, so the function remains correct on its own
-- for the single-row callers, and the workspace's approver argument is exactly
-- the value the function would have computed for itself.

begin;

set local lock_timeout = '5s';

-- The four-argument form is the implementation: same rule as 20260911070000:272
-- with the approver decision supplied by the caller instead of re-derived.
create or replace function private.automation_v3_definition_visible(
  d public.organization_automation_definitions,
  p_actor uuid,
  p_org uuid,
  p_approver boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select d.organization_id = p_org
    and (
      coalesce(p_approver, false)
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

-- Unchanged contract for the single-row callers: resolve the approver once,
-- then apply the rule above.
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
  select private.automation_v3_definition_visible(
    d, p_actor, p_org, private.automation_v3_actor_is_approver(p_actor, p_org)
  );
$function$;

-- Projection body moved verbatim from 20260911070000:286-333, with the four
-- approver derivations and the canPreview visibility call replaced by the one
-- boolean the caller already holds.
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
  );
end;
$function$;

-- Unchanged contract for the single-row callers (save, submit, review), which
-- now derive the approver once instead of four times.
create or replace function private.automation_v3_definition_json(
  d public.organization_automation_definitions,
  p_actor uuid,
  p_org uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select private.automation_v3_definition_json(
    d, p_actor, p_org, private.automation_v3_actor_is_approver(p_actor, p_org)
  );
$function$;

-- Re-emitted from 20260911070000:433-489. Only the definitions subquery
-- changes: it gains the explicit tenant equality and passes the approver
-- boolean this function already computes at :445 down into both the predicate
-- and the projection. The runs subquery, access block, settings, scheduler
-- probe and capability contract are byte-for-byte the same.
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
  select coalesce(pg_catalog.jsonb_agg(private.automation_v3_definition_json(d, actor, org, approver) order by d.updated_at desc, d.id), '[]'::jsonb)
    into definitions
  from (
    select * from public.organization_automation_definitions d
    where d.organization_id = org
      and private.automation_v3_definition_visible(d, actor, org, approver)
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

revoke all on function private.automation_v3_definition_visible(public.organization_automation_definitions, uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.automation_v3_definition_json(public.organization_automation_definitions, uuid, uuid, boolean) from public, anon, authenticated, service_role;

comment on function private.automation_v3_definition_visible(public.organization_automation_definitions, uuid, uuid, boolean) is
  'Shared automation intelligence v3 visibility rule with the approver decision supplied by the caller. Identical to the three-argument form, which delegates here after resolving the approver once; the tenant equality stays inside so every caller keeps its own bound.';
comment on function private.automation_v3_definition_json(public.organization_automation_definitions, uuid, uuid, boolean) is
  'Shared automation intelligence v3 definition projection with the approver decision supplied by the caller, so a page of definitions derives it once instead of four times per row. The three-argument form delegates here.';
comment on function public.mi1_get_automation_workspace() is
  'Automation workspace read. The definitions page is bounded by an explicit organization_id equality beside the visibility predicate so organization_automation_definitions_review_idx is usable and no other tenant''s row reaches the per-row SECURITY DEFINER visibility call, and the approver decision is computed once and handed to both the predicate and the projection.';

notify pgrst, 'reload schema';

commit;
