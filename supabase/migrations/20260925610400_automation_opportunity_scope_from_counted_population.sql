-- UX-UG-DISCOVER-LABELS-OPPORTUNITY-SCOPE-CHAPTER-NON-APPROVER-ORG-LEVEL-20260921
--
-- public.mi1_get_automation_opportunities stamped every row with a scope label
-- derived from private.automation_v3_actor_is_approver: 'organization' for an
-- admin or vp, 'chapter' for everyone else. That token answered "are you an
-- approver?", not "what did this count".
--
-- The counted population never depended on approval. visible_tasks selects
-- every chapter of the tenant the caller passes
-- private.actor_has_chapter_staff_role for, and that predicate is satisfied
-- org-wide by a single public.organization_role_grants row. A coordinator
-- granted steward/coordinator/advisor at organization scope therefore received
-- the org-wide count under a 'chapter' label, while an admin saw the identical
-- number labelled 'organization'.
--
-- The label is now derived from the population itself: 'organization' only when
-- the caller's staff role covers every chapter of the tenant, otherwise
-- 'chapter'. The same chapter array drives the aggregates, so the label and the
-- count can no longer disagree. The payload also carries scopeChapterId — the
-- one chapter that was counted, when exactly one was — so the Discover draft
-- button can seed the chapter scope a non-approver save requires instead of
-- sending them to a builder with an empty picker.
--
-- Aggregate-only output, the eight-row bound and both selection passes are
-- unchanged, and no row gains record identity or content: a chapter identifier
-- is tenant structure the caller already staffs, not a task, case or person.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
  counted_chapters text[];
  organization_chapters integer;
  scope_label text;
  scope_chapter text;
begin
  select
    coalesce(pg_catalog.array_agg(ch.id order by ch.id)
      filter (where private.actor_has_chapter_staff_role(actor, ch.id)), array[]::text[]),
    pg_catalog.count(*)::integer
  into counted_chapters, organization_chapters
  from public.chapters ch
  where ch.organization_id = org;

  scope_label := case
    when organization_chapters > 0
      and pg_catalog.cardinality(counted_chapters) = organization_chapters then 'organization'
    else 'chapter'
  end;
  scope_chapter := case
    when pg_catalog.cardinality(counted_chapters) = 1 then counted_chapters[1]
    else null
  end;

  with visible_tasks as (
    select t.*
    from public.chapter_tasks t
    where t.deleted_at is null and t.chapter_id = any(counted_chapters)
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
  return pg_catalog.jsonb_build_object(
    'capabilityVersion', 2,
    'observedAt', pg_catalog.now(),
    'scopeChapterId', scope_chapter,
    'rows', result
  );
end;
$function$;

comment on function public.mi1_get_automation_opportunities() is
  'Shared automation intelligence v3: bounded aggregate-only deterministic opportunity detector. The scope label and scopeChapterId are derived from the chapters the caller actually staffs, never from approval authority.';

notify pgrst, 'reload schema';

commit;
