-- REQ-UG-CHAPTER-WORK-REPORT-20260727
--
-- Bounding the board read to 60 days (20260727050000 + memberApi patch) left a
-- real question behind: a coordinator planning next quarter needs all-time
-- numbers. The answer is NOT a bigger select -- it is aggregates computed in
-- the database and returned as one row of JSON, so the phone never carries
-- three thousand task rows to count them.
--
-- Staff-only and chapter-scoped, matching the surface it serves. Deleted tasks
-- are excluded from every figure except deleted_count, which exists so a
-- suspiciously small total has a visible explanation.

create or replace function public.chapter_task_report(
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  range_from date;
  range_to date;
  result jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  -- Default window is all of it. A null bound means unbounded on that side;
  -- the caller decides, and the UI names whatever it asked for.
  range_from := coalesce(p_from, '2000-01-01'::date);
  range_to := coalesce(p_to, current_date);

  if range_to < range_from then
    raise exception 'report range is inverted' using errcode = '22023';
  end if;

  with scoped as (
    select t.*
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
      and t.deleted_at is null
      and t.created_at::date <= range_to
      and (t.done_at is null or t.done_at::date >= range_from)
      and t.due_date >= range_from
  ),
  totals as (
    select
      pg_catalog.count(*) as total,
      pg_catalog.count(*) filter (where status = 'done') as done,
      pg_catalog.count(*) filter (where status <> 'done') as open,
      pg_catalog.count(*) filter (where blocked) as blocked,
      pg_catalog.count(*) filter (where status <> 'done' and due_date < current_date) as overdue,
      pg_catalog.count(*) filter (where milestone) as milestones,
      -- Cycle time in whole days, median rather than mean: one task that sat
      -- for a year would otherwise describe the whole chapter.
      pg_catalog.percentile_cont(0.5) within group (
        order by extract(epoch from (done_at - created_at)) / 86400.0
      ) filter (where done_at is not null) as median_days_to_done,
      -- Delivery honesty: of the work that finished, how much finished late.
      pg_catalog.count(*) filter (where done_at is not null and done_at::date > due_date) as done_late
    from scoped
  ),
  by_month as (
    select pg_catalog.to_char(pg_catalog.date_trunc('month', done_at), 'YYYY-MM') as month,
           pg_catalog.count(*) as done
    from scoped
    where done_at is not null
    group by 1
    order by 1
  ),
  by_workstream as (
    select workstream as name,
           pg_catalog.count(*) as total,
           pg_catalog.count(*) filter (where status = 'done') as done,
           pg_catalog.count(*) filter (where blocked) as blocked
    from scoped
    group by 1
    order by 2 desc, 1
  ),
  by_person as (
    -- assignee_name, not assignee_id: this is a report, and a member who has
    -- left the chapter still did the work. Unassigned is its own row.
    select coalesce(nullif(assignee_name, ''), '—') as name,
           pg_catalog.count(*) as total,
           pg_catalog.count(*) filter (where status = 'done') as done,
           pg_catalog.count(*) filter (where status <> 'done' and due_date < current_date) as overdue
    from scoped
    group by 1
    order by 2 desc, 1
  ),
  removed as (
    select pg_catalog.count(*) as deleted_count
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
      and t.deleted_at is not null
      and t.deleted_at::date between range_from and range_to
  )
  select pg_catalog.jsonb_build_object(
    'chapterId', caller_chapter,
    'from', range_from,
    'to', range_to,
    'generatedAt', now(),
    'totals', (select pg_catalog.to_jsonb(totals) from totals),
    'deletedCount', (select deleted_count from removed),
    'byMonth', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(by_month)) from by_month), '[]'::jsonb),
    'byWorkstream', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(by_workstream)) from by_workstream), '[]'::jsonb),
    'byPerson', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(by_person)) from by_person), '[]'::jsonb)
  ) into result;

  return result;
end
$$;

revoke all on function public.chapter_task_report(date, date) from public, anon, authenticated;
grant execute on function public.chapter_task_report(date, date) to authenticated;

comment on function public.chapter_task_report(date, date) is
  'All-time (or windowed) chapter work aggregates for the staff report view. Returns one JSON row so the client never reads the task table to count it. Excludes soft-deleted tasks except from deletedCount.';

notify pgrst, 'reload schema';
