-- REQ-UG-FULL-DEPTH-20260723 PR4a: coordinator case plane.
-- The grievance coordinator reads every case in their chapter: a genuine
-- cross-member RLS widening on EXACTLY member_cases, member_case_updates, and
-- member_profiles (owner names), routed through staff_can_see_user so the
-- PR1 chapter gate applies (a coordinator role row with chapter_id sees only
-- that chapter; a NULL chapter_id row is org-wide). This mirrors the shipped
-- steward widening byte-for-byte with 'coordinator' in place of 'steward'.
-- KPIs come from a role-gated SECURITY DEFINER aggregate (the
-- get_workload_stats precedent: definer because the caller cannot see the
-- underlying rows under member RLS until these policies exist, and because
-- the aggregate must never depend on the client's row visibility).
--
-- SHIPS WITH (same PR, blocking): loadMemberApp adds .eq("user_id", user.id)
-- to its member_cases and member_case_updates reads. Without that client fix
-- these policies would leak every member's cases into a coordinator's OWN
-- member Cases view — the exact trap the steward migration sidestepped for
-- conversations/messages.
--
-- ROLLOUT ORDER (live): apply this migration, deploy AND browser-verify the
-- client bundle, and only then provision the first coordinator role row.
-- Stale tabs running the previous bundle read member_cases unfiltered, so a
-- role granted before the client ships would leak chapter cases into that
-- session's own Cases view. No coordinator roles exist today, so the window
-- is theoretical — keep it that way by sequencing.

-- 1. Coordinator read widening: exactly these three tables and nothing else.
--    Owner column is user_id on member-owned tables and id on profiles.
create policy member_cases_select_coordinator on public.member_cases
  for select to authenticated using (public.staff_can_see_user(user_id, 'coordinator'));

create policy member_case_updates_select_coordinator on public.member_case_updates
  for select to authenticated using (public.staff_can_see_user(user_id, 'coordinator'));

create policy member_profiles_select_coordinator on public.member_profiles
  for select to authenticated using (public.staff_can_see_user(id, 'coordinator'));

-- 2. Hot path for the due-soon queue: active cases ordered by deadline.
--    Live apply builds this CONCURRENTLY as its own Management API call (the
--    table holds ~400k rows and a plain create index takes a write-blocking
--    lock for the build); IF NOT EXISTS keeps this file replayable after that.
create index if not exists member_cases_status_deadline_idx on public.member_cases(status, deadline);

-- 3. Case-queue KPIs. Chapter-scoped exactly like the policies: the caller's
--    coordinator role row picks the chapter (NULL = org-wide). The demo
--    dashboard's "win/settle rate" had no backing (cases carry no outcome
--    enum) — the honest replacement is resolutionRate = resolved / total.
create function public.get_coordinator_kpis()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  open_cases integer;
  due_week integer;
  in_arb integer;
  resolved_cases integer;
  by_step jsonb;
  by_article jsonb;
begin
  if caller is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'coordinator';

  -- Single pass over the case/profile join: the CTE materializes the chapter's
  -- cases once and the count filters plus both grouped tallies read the
  -- materialized set, instead of three independent 400k-row scans.
  -- Due window is current_date + 6: seven days inclusive of today.
  with base as materialized (
    select c.status, c.step, c.articles, c.deadline
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where caller_chapter is null or p.chapter_id = caller_chapter
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline between current_date and current_date + 6),
    pg_catalog.count(*) filter (where b.status = 'active'
      and (b.step ~* 'arb' or b.step = 'Step 4')),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('step', s.step, 'count', s.n) order by s.n desc, s.step), '[]'::jsonb)
     from (
       select step, pg_catalog.count(*) as n
       from base
       where status = 'active'
       group by step
     ) s),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('articles', a.articles, 'count', a.n) order by a.n desc, a.articles), '[]'::jsonb)
     from (
       select articles, pg_catalog.count(*) as n
       from base
       where status = 'active' and articles <> ''
       group by articles
     ) a)
  into open_cases, due_week, in_arb, resolved_cases, by_step, by_article
  from base b;

  return pg_catalog.jsonb_build_object(
    'openCases', open_cases,
    'dueThisWeek', due_week,
    'inArbitration', in_arb,
    'resolved', resolved_cases,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'byStep', by_step,
    'byArticle', by_article);
end;
$$;

revoke all on function public.get_coordinator_kpis() from public, anon;
grant execute on function public.get_coordinator_kpis() to authenticated;
