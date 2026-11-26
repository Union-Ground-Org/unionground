-- REQ-UG-CASEWORK-CONSOLE-54-CASE-DASHBOARDS-20260917
--
-- Five read-only casework aggregates for the coordinator and steward case
-- dashboards. Every tile is computed HERE because the browser cannot compute
-- it at all: the coordinator queue is a keyset page of at most
-- COORDINATOR_CASE_PAGE cases, the steward desk is narrower still, and a count
-- taken over either would be a count of one page. Reading the whole chapter in
-- the client is not the alternative — RLS would have to hand a coordinator
-- every case row of every open case to let the browser tally them, which is a
-- far larger disclosure than the five numbers the tiles actually show. These
-- functions read the whole scope inside the database and return only counts.
--
-- get_coordinator_kpis (20260723160000) already aggregates server-side in this
-- same spirit, and its by-step tally is the funnel on the coordinator plane.
-- It is a different function, not a redundant one: it is scoped by
-- member_profiles.chapter_id and knows nothing of the casework suite, so it
-- neither applies private.casework_staff_can_access nor reaches
-- casework_deadlines or casework_step_transitions. Four of these five tiles
-- have no counterpart there at all.
--
-- SCOPE. Each aggregate is bounded twice, and the two bounds do different work:
--
--   1. TENANT. organization_id and chapter_id must equal the caller's own
--      private.current_member_organization() / private.current_member_chapter().
--      This is the cheap, index-usable bound that keeps the per-row access
--      helper off every other tenant's rows.
--   2. VISIBILITY. private.casework_staff_can_access(case_id) — the SAME
--      helper the casework suite's RLS policies and write RPCs already use —
--      decides case by case. Nothing here re-implements, widens or shortcuts
--      it, so a restricted case stays invisible to a coordinator without a
--      grant, and a steward keeps the assignee-scoped read owner decision
--      2026-08-08 (UB-CASE-05) gave them rather than a chapter-wide one.
--
-- These are SECURITY DEFINER because the caller cannot be allowed to run the
-- underlying scan itself: an invoker-security aggregate over member_cases
-- would need a direct client read of every row it counts. The definer is the
-- narrowing, not the widening — its body can return nothing but counts, and
-- the visibility predicate it applies is stricter than the table's own RLS.
--
-- MFA is asserted directly, not assumed: private.casework_dashboard_require_staff
-- refuses with 42501 unless private.mfa_satisfied() holds — the same assurance
-- gate every other authenticated casework definer RPC applies through
-- private.casework_require_mfa (REQ-UG-DEFINER-MFA-AUDIT). The chapter-role
-- helpers' own organization-policy factor check still applies underneath it.
--
-- No new policy, no new table, no new grant on an existing table.

begin;

set local lock_timeout = '5s';

-- The tenant bound above resolves against (organization_id, chapter_id) and
-- then groups by step. member_cases_status_deadline_idx orders by deadline and
-- cannot serve it; this partial index covers the open-case scope the four
-- open-case aggregates share and stays small because it excludes resolved rows.
create index if not exists member_cases_dashboard_open_idx
  on public.member_cases (organization_id, chapter_id, step)
  where status = 'active';

-- Deadline tiles walk the deadlines of one chapter by due date.
-- casework_deadlines_due_idx is (organization_id, chapter_id, status, due_at),
-- which already serves both windows; no second index is added for them.

create or replace function private.casework_dashboard_require_staff()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null
    or not private.mfa_satisfied()
    or private.current_member_organization() is null
    or private.current_member_chapter() is null
    or not private.actor_has_chapter_staff_role(
      (select auth.uid()),
      private.current_member_chapter()
    )
  then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;
end;
$function$;

-- The one scope every open-case tile shares. Returning the rows rather than a
-- predicate means the per-row visibility helper runs once per case per read
-- instead of once per case per tile.
create or replace function private.casework_dashboard_open_cases()
returns table (
  case_id uuid,
  step_name text,
  steward_id uuid,
  steward_label text,
  coordinator_id uuid,
  coordinator_label text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    c.id,
    c.step,
    c.steward_user_id,
    c.steward_name,
    c.coordinator_user_id,
    c.coordinator_name
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and c.organization_id = (select private.current_member_organization())
    and c.chapter_id = (select private.current_member_chapter())
    and private.casework_staff_can_access(c.id);
$function$;

-- Tile 1 — open cases by step.
create or replace function public.casework_dashboard_open_cases_by_step()
returns table (step text, case_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  select scoped.step_name, pg_catalog.count(*)
  from private.casework_dashboard_open_cases() scoped
  group by scoped.step_name
  order by pg_catalog.count(*) desc, scoped.step_name asc;
end;
$function$;

-- Tile 2 — deadlines falling due inside the next seven days.
--
-- Bucketed by whole days FROM NOW rather than by calendar date: a calendar
-- bucket has to pick a timezone, and picking the server's would shift the
-- "today" column for every chapter that is not in it. days_out 0 is "due
-- within 24 hours", 6 is the last day of the window.
create or replace function public.casework_dashboard_deadlines_due_soon()
returns table (days_out integer, deadline_count bigint, case_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  with scoped as (
    select deadline.id, deadline.case_id, deadline.due_at
    from public.casework_deadlines deadline
    join private.casework_dashboard_open_cases() visible
      on visible.case_id = deadline.case_id
    where deadline.status in ('active', 'extended')
      and deadline.due_at >= pg_catalog.now()
      and deadline.due_at < pg_catalog.now() + interval '7 days'
  )
  select
    pg_catalog.floor(
      extract(epoch from (scoped.due_at - pg_catalog.now())) / 86400.0
    )::integer as bucket,
    pg_catalog.count(*),
    pg_catalog.count(distinct scoped.case_id)
  from scoped
  group by bucket
  order by bucket;
end;
$function$;

-- Tile 3 — deadlines already missed, by kind.
create or replace function public.casework_dashboard_overdue_deadlines()
returns table (kind text, deadline_count bigint, case_count bigint, oldest_due_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  select
    deadline.kind,
    pg_catalog.count(*),
    pg_catalog.count(distinct deadline.case_id),
    pg_catalog.min(deadline.due_at)
  from public.casework_deadlines deadline
  join private.casework_dashboard_open_cases() visible
    on visible.case_id = deadline.case_id
  where deadline.status in ('active', 'extended')
    and deadline.due_at < pg_catalog.now()
  group by deadline.kind
  order by pg_catalog.count(*) desc, deadline.kind asc;
end;
$function$;

-- Tile 4 — open cases per assignee.
--
-- member_cases carries the assignment itself (steward_user_id /
-- coordinator_user_id, 20260728170500); there is no separate assignee table,
-- so a case with both a steward and a coordinator is counted once under each
-- and a case with neither lands in the explicit unassigned row. The display
-- names are the server-stamped steward_name / coordinator_name columns, so
-- this never needs a profile read the caller is not entitled to.
create or replace function public.casework_dashboard_open_cases_by_assignee()
returns table (assignee_role text, assignee_user_id uuid, assignee_name text, case_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  with scoped as (
    select * from private.casework_dashboard_open_cases()
  ),
  tallied as (
    select 'steward'::text as role_name, scoped.steward_id as user_id,
           scoped.steward_label as label, pg_catalog.count(*) as total
    from scoped
    where scoped.steward_id is not null
    group by scoped.steward_id, scoped.steward_label
    union all
    select 'coordinator'::text, scoped.coordinator_id,
           scoped.coordinator_label, pg_catalog.count(*)
    from scoped
    where scoped.coordinator_id is not null
    group by scoped.coordinator_id, scoped.coordinator_label
    union all
    select 'unassigned'::text, null::uuid, null::text, pg_catalog.count(*)
    from scoped
    where scoped.steward_id is null and scoped.coordinator_id is null
    having pg_catalog.count(*) > 0
  )
  select tallied.role_name, tallied.user_id, tallied.label, tallied.total
  from tallied
  order by tallied.total desc, tallied.role_name asc, tallied.label asc nulls last;
end;
$function$;

-- Tile 5 — median days spent in each step over the last 90 days.
--
-- Driven from casework_step_transitions, not from open cases: a cycle time is
-- a property of steps that have been LEFT, and most of those belong to cases
-- that have since resolved. The scope is therefore the transitions' own tenant
-- columns plus the same per-case visibility helper.
--
-- Time in a step is measured from the transition that ENTERED it — the lag
-- over the case's full transition history, not over the 90-day slice, so the
-- first in-window transition of a long-running case is not silently measured
-- from the case's creation date. A case's first step has no entering
-- transition, so its clock starts at the case row's created_at.
create or replace function public.casework_dashboard_median_days_per_step()
returns table (step text, median_days numeric, transition_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.casework_dashboard_require_staff();
  return query
  with tenant as (
    select distinct transition.case_id
    from public.casework_step_transitions transition
    where transition.created_at >= pg_catalog.now() - interval '90 days'
      and transition.organization_id = (select private.current_member_organization())
      and transition.chapter_id = (select private.current_member_chapter())
  ),
  visible as (
    select tenant.case_id
    from tenant
    where private.casework_staff_can_access(tenant.case_id)
  ),
  history as (
    select
      transition.case_id,
      transition.from_step,
      transition.created_at,
      lag(transition.created_at) over (
        partition by transition.case_id
        order by transition.created_at, transition.id
      ) as entered_at
    from public.casework_step_transitions transition
    join visible on visible.case_id = transition.case_id
  ),
  measured as (
    select
      history.from_step,
      extract(epoch from (
        history.created_at - coalesce(history.entered_at, opened.created_at)
      )) / 86400.0 as days_in_step
    from history
    join public.member_cases opened on opened.id = history.case_id
    where history.created_at >= pg_catalog.now() - interval '90 days'
  )
  select
    measured.from_step,
    pg_catalog.round(
      (pg_catalog.percentile_cont(0.5) within group (order by measured.days_in_step))::numeric,
      2
    ),
    pg_catalog.count(*)
  from measured
  group by measured.from_step
  order by pg_catalog.count(*) desc, measured.from_step asc;
end;
$function$;

revoke all on function private.casework_dashboard_require_staff()
  from public, anon, authenticated, service_role;
revoke all on function private.casework_dashboard_open_cases()
  from public, anon, authenticated, service_role;

revoke all on function public.casework_dashboard_open_cases_by_step()
  from public, anon, service_role;
revoke all on function public.casework_dashboard_deadlines_due_soon()
  from public, anon, service_role;
revoke all on function public.casework_dashboard_overdue_deadlines()
  from public, anon, service_role;
revoke all on function public.casework_dashboard_open_cases_by_assignee()
  from public, anon, service_role;
revoke all on function public.casework_dashboard_median_days_per_step()
  from public, anon, service_role;

grant execute on function public.casework_dashboard_open_cases_by_step() to authenticated;
grant execute on function public.casework_dashboard_deadlines_due_soon() to authenticated;
grant execute on function public.casework_dashboard_overdue_deadlines() to authenticated;
grant execute on function public.casework_dashboard_open_cases_by_assignee() to authenticated;
grant execute on function public.casework_dashboard_median_days_per_step() to authenticated;

comment on function public.casework_dashboard_open_cases_by_step() is
  'Open-case counts per step for the case dashboards. Tenant-bounded to the caller''s organization and chapter, then filtered case by case through private.casework_staff_can_access so restricted cases and non-assignee stewards keep the visibility the casework suite already grants them.';
comment on function public.casework_dashboard_deadlines_due_soon() is
  'Casework deadlines falling due within seven days, bucketed by whole days from now so no server timezone decides which column is today. Same tenant and per-case visibility bounds as casework_dashboard_open_cases_by_step.';
comment on function public.casework_dashboard_overdue_deadlines() is
  'Missed casework deadlines by kind, with the oldest due date. Same tenant and per-case visibility bounds as casework_dashboard_open_cases_by_step.';
comment on function public.casework_dashboard_open_cases_by_assignee() is
  'Open-case counts per assigned steward and coordinator, plus an explicit unassigned row. Names come from the server-stamped assignment columns, never from a profile read. Same tenant and per-case visibility bounds as casework_dashboard_open_cases_by_step.';
comment on function public.casework_dashboard_median_days_per_step() is
  'Median days spent in each step over the last 90 days, measured from casework_step_transitions across the case''s full history so a long-running case is not measured from its creation date. Tenant-bounded to the caller''s organization and chapter, then filtered case by case through private.casework_staff_can_access.';

notify pgrst, 'reload schema';

commit;
