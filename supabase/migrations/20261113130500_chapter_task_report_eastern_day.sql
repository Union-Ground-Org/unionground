-- BUG-UG-TASKS-REPORT-ENDS-ON-THE-UTC-DAY-AFTER-7-PM-EASTERN-20261112 (#8563).
-- public.chapter_task_report counted days by the database session's day, and
-- the hosted projects run in UTC. From 7 PM Eastern (8 PM during daylight
-- time) until midnight Eastern the report said "through" tomorrow's date and
-- counted a task due today as overdue. The product counts days in Eastern
-- time, so every day this report reads is now the Eastern day, through
-- private.eastern_day() (20261113122500_eastern_day_helper.sql):
--   * the default range end and the overdue cut are today's Eastern date;
--   * created_at, done_at and deleted_at are compared with the range on the
--     Eastern day they fell on (a task created at 8 PM Eastern belongs to
--     today's Eastern date, not to tomorrow's UTC date, so moving the range
--     end alone would drop it from the report);
--   * "finished late" compares the Eastern completion day with the due date;
--   * the by-month buckets are Eastern months.
-- Callers, the caller and role checks, the window rules of
-- 20260922013000_chapter_task_report_window_repair.sql and the platform
-- boundary of 20261028080000_platform_organization_boundary.sql are
-- unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.chapter_task_report(date,date)'::regprocedure)
    is distinct from 'd305e0a666d4a90965dda1fe3e149ef8' then
    raise exception 'unreviewed predecessor: public.chapter_task_report' using errcode='55000';
  end if;
end
$preflight$;

CREATE OR REPLACE FUNCTION public.chapter_task_report(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  -- The product's day is the Eastern day, whatever the session time zone.
  today date := private.eastern_day();
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
  if private.chapter_belongs_to_platform(caller_chapter) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Default window is all of it. A null bound means unbounded on that side;
  -- the caller decides, and the UI names whatever it asked for.
  range_from := coalesce(p_from, '2000-01-01'::date);
  range_to := coalesce(p_to, today);

  if range_to < range_from then
    raise exception 'report range is inverted' using errcode = '22023';
  end if;

  with scoped as (
    select t.*,
           private.eastern_day(t.done_at) as done_on
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
      and t.deleted_at is null
      and private.eastern_day(t.created_at) <= range_to
      and (t.done_at is null or private.eastern_day(t.done_at) between range_from and range_to)
      and (t.due_date is null or private.eastern_day(t.done_at) between range_from and range_to or t.due_date >= range_from)
  ),
  totals as (
    select
      pg_catalog.count(*) as total,
      pg_catalog.count(*) filter (where status = 'done') as done,
      pg_catalog.count(*) filter (where status <> 'done') as open,
      pg_catalog.count(*) filter (where blocked) as blocked,
      pg_catalog.count(*) filter (where status <> 'done' and due_date is not null and due_date < today) as overdue,
      pg_catalog.count(*) filter (where milestone) as milestones,
      -- Cycle time in whole days, median rather than mean: one task that sat
      -- for a year would otherwise describe the whole chapter.
      pg_catalog.percentile_cont(0.5) within group (
        order by extract(epoch from (done_at - created_at)) / 86400.0
      ) filter (where done_at is not null) as median_days_to_done,
      -- Delivery honesty: of the work that finished, how much finished late.
      pg_catalog.count(*) filter (where done_at is not null and due_date is not null and done_on > due_date) as done_late
    from scoped
  ),
  by_month as (
    select pg_catalog.to_char(private.eastern_day(done_at), 'YYYY-MM') as month,
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
           pg_catalog.count(*) filter (where status <> 'done' and due_date is not null and due_date < today) as overdue
    from scoped
    group by 1
    order by 2 desc, 1
  ),
  removed as (
    select pg_catalog.count(*) as deleted_count
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter
      and t.deleted_at is not null
      and private.eastern_day(t.deleted_at) between range_from and range_to
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
$function$;

revoke all on function public.chapter_task_report(date, date) from public, anon, authenticated, service_role;
grant execute on function public.chapter_task_report(date, date) to authenticated;

commit;
