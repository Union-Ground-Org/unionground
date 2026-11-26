-- UB-WKL-03: privacy-safe workload intelligence, reminder scheduling and
-- queue-backed workload receipts.
--
-- Individual workload rows remain self-only. Every staff result below is a
-- bounded aggregate or counts-only operational assignment fact. Outbound mail
-- continues to cross exactly one boundary: member_notification_deliveries.

set local lock_timeout = '5s';

-- ------------------------------------------------ notification event metadata

alter table public.member_notifications
  add column if not exists workload_event text,
  add column if not exists workload_receipt_code text;

alter table public.member_notifications
  drop constraint if exists member_notifications_workload_event_check;
alter table public.member_notifications
  add constraint member_notifications_workload_event_check check (
    (kind <> 'workload' and workload_event is null and workload_receipt_code is null)
    or
    (kind = 'workload' and (
      (workload_event = 'receipt' and workload_receipt_code ~ '^[0-9a-f]{8}$')
      or (workload_event = 'reminder' and workload_receipt_code is null)
    ))
  );

-- The only client write on the feed stays read_at. In particular, a member
-- cannot change an event into a receipt or supply provider-bound metadata.
revoke update on public.member_notifications from authenticated;
grant update (read_at) on public.member_notifications to authenticated;

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.member_notifications'::regclass
      and conname = 'member_notifications_kind_check'
      and not convalidated
  ) then
    alter table public.member_notifications validate constraint member_notifications_kind_check;
  end if;
end
$$;

-- One canonical topic switch. Absent still means enabled for rollout
-- compatibility; new/future profiles get the complete explicit shape.
alter table public.member_profiles alter column notification_prefs set default
  '{"deadlines": true, "cases": true, "forms": true, "votes": true, "events": true, "tasks": true, "appointments": true, "workload": true}'::jsonb;

-- ------------------------------------------------------ reminder preferences

create table private.workload_reminder_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  cadence text not null default 'weekly'
    check (cadence in ('weekday_daily', 'weekly', 'biweekly', 'monthly', 'quarterly')),
  weekday smallint not null default 1 check (weekday between 1 and 7),
  local_hour smallint not null default 9 check (local_hour between 0 and 23),
  timezone text not null default 'America/New_York' check (timezone in (
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
    'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
    'America/Puerto_Rico', 'America/Detroit', 'America/Indiana/Indianapolis'
  )),
  next_due_at timestamptz,
  last_sent_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((enabled and next_due_at is not null) or (not enabled and next_due_at is null))
);

revoke all on table private.workload_reminder_preferences from public, anon, authenticated, service_role;

create function private.next_workload_reminder_at(
  p_cadence text,
  p_weekday integer,
  p_local_hour integer,
  p_timezone text,
  p_after timestamptz
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  candidate date;
  candidate_at timestamptz;
begin
  if p_cadence is null or p_weekday is null or p_local_hour is null or p_timezone is null
     or p_cadence not in ('weekday_daily', 'weekly', 'biweekly', 'monthly', 'quarterly')
     or p_weekday not between 1 and 7
     or p_local_hour not between 0 and 23
     or p_timezone not in (
       'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
       'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
       'America/Puerto_Rico', 'America/Detroit', 'America/Indiana/Indianapolis'
     ) then
    raise exception 'invalid workload reminder schedule' using errcode = '22023';
  end if;

  for candidate in
    select candidate_day::date
    from pg_catalog.generate_series(
      (p_after at time zone p_timezone)::date,
      (p_after at time zone p_timezone)::date + 400,
      interval '1 day'
    ) as days(candidate_day)
    where case p_cadence
      when 'weekday_daily' then extract(isodow from candidate_day) between 1 and 5
      when 'weekly' then extract(isodow from candidate_day) = p_weekday
      when 'biweekly' then extract(isodow from candidate_day) = p_weekday
        and (pg_catalog.floor(extract(epoch from pg_catalog.date_trunc('week', candidate_day)) / 604800)::bigint % 2) = 0
      when 'monthly' then extract(isodow from candidate_day) = p_weekday
        and extract(day from candidate_day) <= 7
      when 'quarterly' then extract(isodow from candidate_day) = p_weekday
        and extract(month from candidate_day) in (1, 4, 7, 10)
        and extract(day from candidate_day) <= 7
      else false
    end
    order by candidate_day
  loop
    candidate_at := (candidate + pg_catalog.make_interval(hours => p_local_hour)) at time zone p_timezone;
    if candidate_at > p_after then return candidate_at; end if;
  end loop;

  raise exception 'could not calculate workload reminder' using errcode = '22023';
end;
$$;

revoke all on function private.next_workload_reminder_at(text, integer, integer, text, timestamptz)
  from public, anon, authenticated, service_role;

create function public.get_workload_reminder_preferences()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  pref private.workload_reminder_preferences;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select * into pref from private.workload_reminder_preferences where user_id = caller;
  if not found then
    return pg_catalog.jsonb_build_object(
      'enabled', false, 'cadence', 'weekly', 'weekday', 1,
      'localHour', 9, 'timezone', 'America/New_York',
      'nextDueAt', null, 'lastSentAt', null);
  end if;

  return pg_catalog.jsonb_build_object(
    'enabled', pref.enabled, 'cadence', pref.cadence, 'weekday', pref.weekday,
    'localHour', pref.local_hour, 'timezone', pref.timezone,
    'nextDueAt', pref.next_due_at, 'lastSentAt', pref.last_sent_at);
end;
$$;

revoke all on function public.get_workload_reminder_preferences() from public, anon;
grant execute on function public.get_workload_reminder_preferences() to authenticated;

create function public.set_workload_reminder_preferences(
  p_enabled boolean,
  p_cadence text,
  p_weekday integer,
  p_local_hour integer,
  p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  existing private.workload_reminder_preferences;
  next_due timestamptz;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Validate even when disabled so a hidden invalid schedule cannot become
  -- active through a later boolean-only edit.
  perform private.next_workload_reminder_at(p_cadence, p_weekday, p_local_hour, p_timezone, pg_catalog.now());
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('workload-reminder:' || caller::text, 0));
  select * into existing from private.workload_reminder_preferences
    where user_id = caller for update;

  if coalesce(p_enabled, false) then
    next_due := case
      when found
        and existing.enabled
        and existing.cadence = p_cadence
        and existing.weekday = p_weekday
        and existing.local_hour = p_local_hour
        and existing.timezone = p_timezone
        and existing.next_due_at > pg_catalog.now()
      then existing.next_due_at
      else private.next_workload_reminder_at(p_cadence, p_weekday, p_local_hour, p_timezone, pg_catalog.now())
    end;
  end if;

  insert into private.workload_reminder_preferences (
    user_id, enabled, cadence, weekday, local_hour, timezone, next_due_at, updated_at)
  values (caller, coalesce(p_enabled, false), p_cadence, p_weekday, p_local_hour, p_timezone, next_due, pg_catalog.now())
  on conflict (user_id) do update set
    enabled = excluded.enabled,
    cadence = excluded.cadence,
    weekday = excluded.weekday,
    local_hour = excluded.local_hour,
    timezone = excluded.timezone,
    next_due_at = excluded.next_due_at,
    updated_at = pg_catalog.now();

  return public.get_workload_reminder_preferences();
end;
$$;

revoke all on function public.set_workload_reminder_preferences(boolean, text, integer, integer, text) from public, anon;
grant execute on function public.set_workload_reminder_preferences(boolean, text, integer, integer, text) to authenticated;

-- ------------------------------------------------------ bilingual event copy

insert into private.notification_copy (key, lang, title, body) values
  ('workload.receipt', 'en', 'Workload log received', 'Your workload log receipt is #{code}. Keep this code for your records.'),
  ('workload.receipt', 'es', 'Registro de carga recibido', 'Tu comprobante de carga de trabajo es #{code}. Guarda este código.'),
  ('workload.reminder', 'en', 'Workload reminder', 'It is time to log your workload in Union Base. Open the app when you are ready.'),
  ('workload.reminder', 'es', 'Recordatorio de carga de trabajo', 'Es hora de registrar tu carga de trabajo en Union Base. Abre la aplicación cuando puedas.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

create function private.notify_workload_event(
  p_user_id uuid,
  p_event text,
  p_receipt_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_lang text;
  copy_row private.notification_copy;
  notification_id uuid;
  event_key text;
begin
  if p_user_id is null
     or p_event not in ('receipt', 'reminder')
     or (p_event = 'receipt' and coalesce(p_receipt_code, '') !~ '^[0-9a-f]{8}$')
     or (p_event = 'reminder' and p_receipt_code is not null) then
    raise exception 'invalid workload notification event' using errcode = '22023';
  end if;

  select coalesce(p.language, 'en') into recipient_lang
  from public.member_profiles p where p.id = p_user_id;
  event_key := 'workload.' || p_event;
  select * into copy_row from private.notification_copy c
    where c.key = event_key and c.lang = coalesce(recipient_lang, 'en');
  if copy_row.key is null then
    select * into copy_row from private.notification_copy c
      where c.key = event_key and c.lang = 'en';
  end if;
  if copy_row.key is null then
    raise exception 'missing workload notification copy' using errcode = '22023';
  end if;

  insert into public.member_notifications (
    user_id, title, body, kind, workload_event, workload_receipt_code)
  values (
    p_user_id,
    pg_catalog.replace(copy_row.title, '{code}', coalesce(p_receipt_code, '')),
    pg_catalog.replace(copy_row.body, '{code}', coalesce(p_receipt_code, '')),
    'workload', p_event, p_receipt_code)
  returning id into notification_id;
  return notification_id;
end;
$$;

revoke all on function private.notify_workload_event(uuid, text, text) from public, anon, authenticated, service_role;

-- ------------------------------------------------ collective distribution

create or replace function public.get_workload_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  loc_now timestamp := (pg_catalog.now() at time zone 'America/New_York');
  q_start_local timestamp := pg_catalog.date_trunc('quarter', loc_now) - interval '3 months';
  q_end_local timestamp := pg_catalog.date_trunc('quarter', loc_now);
  q_start timestamptz := q_start_local at time zone 'America/New_York';
  q_end timestamptz := q_end_local at time zone 'America/New_York';
  period_label text := pg_catalog.date_part('year', q_start_local)::int::text
    || '-Q' || pg_catalog.date_part('quarter', q_start_local)::int::text;
  n_sub integer;
  k constant integer := 25;
  cats jsonb;
  tiles jsonb;
  band text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'chapter_unavailable',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;

  select pg_catalog.count(*) into n_sub from (
    select distinct on (w.user_id) w.id
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ) s;

  if n_sub < k then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'reason', 'anonymity_floor',
      'minSubmitters', k, 'period', period_label, 'generatedAt', pg_catalog.now());
  end if;
  band := case when n_sub >= 100 then '100+' when n_sub >= 50 then '50-99' else '25-49' end;

  with latest as (
    select distinct on (w.user_id)
      w.priority, w.pending, w.unread_docs, w.todos, w.referrals,
      w.ce_activities, w.assistance_requests, w.aged_cases,
      w.employment, least(w.ot_hours, 40) as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  ), values_by_key as (
    select v.key, v.ord, least(v.value, 150)::numeric as value
    from latest l
    cross join lateral (values
      ('priority', 1, l.priority), ('pending', 2, l.pending),
      ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
      ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
      ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
    ) v(key, ord, value)
  ), metrics as (
    select key, ord,
      pg_catalog.round(pg_catalog.avg(value)) as avg,
      pg_catalog.percentile_disc(0.5) within group (order by value) as median,
      pg_catalog.percentile_disc(0.9) within group (order by value) as p90
    from values_by_key group by key, ord
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'key', key, 'avg', avg, 'median', median, 'p90', p90) order by ord)
  into cats from metrics;

  with latest as (
    select distinct on (w.user_id) w.employment, least(w.ot_hours, 40) as ot_hours
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= q_start and w.created_at < q_end
    order by w.user_id, w.created_at desc
  )
  select pg_catalog.jsonb_build_object(
    'pctFullTime', pg_catalog.round(100.0 * pg_catalog.avg((employment = 'full_time')::int) / 10.0) * 10,
    'pctPartTime', pg_catalog.round(100.0 * pg_catalog.avg((employment = 'part_time')::int) / 10.0) * 10,
    'avgOtHours', pg_catalog.round(pg_catalog.avg(ot_hours)::numeric, 1))
  into tiles from latest;

  return pg_catalog.jsonb_build_object(
    'enoughData', true, 'period', period_label, 'generatedAt', pg_catalog.now(),
    'submittersBand', band, 'categories', cats, 'tiles', tiles);
end;
$$;

revoke all on function public.get_workload_stats() from public, anon;
grant execute on function public.get_workload_stats() to authenticated;

-- ----------------------------------------------------- counts-only balancing

create function private.workload_rebalancing(p_chapter text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    join public.member_roles r on r.user_id = p.id and r.role = 'steward'
    where p.chapter_id = p_chapter
      and (r.chapter_id is null or r.chapter_id = p_chapter)
    order by p.full_name, p.id
    limit 50
  ), counts as (
    select s.steward_id, s.full_name,
      pg_catalog.count(c.id)::integer as active,
      pg_catalog.count(c.id) filter (
        where c.deadline between current_date and current_date + 6)::integer as due_soon,
      pg_catalog.count(c.id) filter (where c.deadline < current_date)::integer as overdue
    from steward_roster s
    left join public.member_cases c on c.steward_user_id = s.steward_id
      and c.status = 'active'
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
    group by s.steward_id, s.full_name
  ), mean as (
    select coalesce(pg_catalog.avg(active), 0) as avg_active from counts
  ), ranked_high as (
    select c.*, pg_catalog.row_number() over (order by active desc, overdue desc, steward_id) as rn
    from counts c, mean m where c.active >= pg_catalog.ceil(m.avg_active)::integer + 2
  ), ranked_low as (
    select c.*, pg_catalog.row_number() over (order by active asc, overdue asc, steward_id) as rn
    from counts c, mean m where c.active <= greatest(pg_catalog.floor(m.avg_active)::integer - 1, 0)
  ), suggestions as (
    select h.steward_id as from_id, h.full_name as from_name,
      l.steward_id as to_id, l.full_name as to_name,
      least(greatest((h.active - l.active) / 2, 1), 10)::integer as review_count,
      h.active as from_active, l.active as to_active
    from ranked_high h join ranked_low l using (rn)
    where h.steward_id <> l.steward_id
    order by h.active desc, l.active asc, h.steward_id, l.steward_id
    limit 10
  )
  select pg_catalog.jsonb_build_object(
    'stewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', c.steward_id, 'name', c.full_name, 'activeCases', c.active,
      'dueSoon', c.due_soon, 'overdue', c.overdue) order by c.full_name, c.steward_id) from counts c), '[]'::jsonb),
    'suggestions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fromUserId', s.from_id, 'fromName', s.from_name,
      'toUserId', s.to_id, 'toName', s.to_name,
      'reviewCount', s.review_count, 'fromActiveCases', s.from_active,
      'toActiveCases', s.to_active) order by s.from_active desc, s.from_id) from suggestions s), '[]'::jsonb)
  );
$$;

revoke all on function private.workload_rebalancing(text) from public, anon, authenticated, service_role;

-- ------------------------------------------------------------ trend / forecast

create function public.get_steward_workload_intelligence(p_weeks integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  weeks integer := greatest(2, least(coalesce(p_weeks, 12), 52));
  eligible_points integer := 0;
  trends jsonb := '[]'::jsonb;
  balancing jsonb;
  reason text;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'available', false, 'reason', 'chapter_unavailable', 'eligibleWeeks', 0,
      'categories', '[]'::jsonb, 'rebalancing', pg_catalog.jsonb_build_object('stewards', '[]'::jsonb, 'suggestions', '[]'::jsonb));
  end if;
  -- member_has_role owns the assurance rule, but its role-name lookup is not
  -- chapter-scoped. Require a global grant or a grant for the caller's profile
  -- chapter before any aggregate/rebalancing read begins.
  if not exists (
    select 1 from public.member_roles r
    where r.user_id = caller
      and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
      and (r.chapter_id is null or r.chapter_id = caller_chapter)
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  balancing := private.workload_rebalancing(caller_chapter);

  with latest_weekly as materialized (
    select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
      pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
      least(w.priority, 150) as priority, least(w.pending, 150) as pending,
      least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
      least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
      least(w.assistance_requests, 150) as assistance_requests,
      least(w.aged_cases, 150) as aged_cases
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
    order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
  ), eligible_weeks as materialized (
    select week_start
    from latest_weekly
    group by week_start
    having pg_catalog.count(distinct user_id) >= 25
  )
  select pg_catalog.count(*) into eligible_points from eligible_weeks;

  if eligible_points >= 2 then
    with latest_weekly as materialized (
      select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
        pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
        least(w.priority, 150) as priority, least(w.pending, 150) as pending,
        least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
        least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
        least(w.assistance_requests, 150) as assistance_requests,
        least(w.aged_cases, 150) as aged_cases
      from public.member_workload_logs w
      join public.member_profiles p on p.id = w.user_id
      where p.chapter_id = caller_chapter
        and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
      order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
    ), eligible as (
      select week_start from latest_weekly group by week_start
      having pg_catalog.count(distinct user_id) >= 25
    ), weekly_categories as (
      select l.week_start, v.key, v.ord, pg_catalog.avg(v.value)::numeric as value
      from latest_weekly l join eligible e using (week_start)
      cross join lateral (values
        ('priority', 1, l.priority), ('pending', 2, l.pending),
        ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
        ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
        ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
      ) v(key, ord, value)
      group by l.week_start, v.key, v.ord
    ), regression as (
      select key, ord, pg_catalog.count(*)::integer as points,
        pg_catalog.regr_slope(value, extract(epoch from week_start) / 604800.0)::numeric as slope,
        (pg_catalog.array_agg(value order by week_start desc))[1] as latest
      from weekly_categories group by key, ord
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', key, 'points', points,
      'slope', pg_catalog.round(slope, 2),
      'latest', pg_catalog.round(latest, 1),
      'forecast4Weeks', pg_catalog.round(greatest(latest + slope * 4, 0), 1)) order by ord)
    into trends from regression;
  else
    reason := case when eligible_points = 0 then 'anonymity_floor' else 'insufficient_weeks' end;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', eligible_points >= 2,
    'reason', reason,
    'eligibleWeeks', eligible_points,
    'categories', coalesce(trends, '[]'::jsonb),
    'rebalancing', balancing,
    'generatedAt', pg_catalog.now());
end;
$$;

revoke all on function public.get_steward_workload_intelligence(integer) from public, anon;
grant execute on function public.get_steward_workload_intelligence(integer) to authenticated;

-- ---------------------------------------------- receipt in the write tx

create or replace function public.submit_workload_log(
  p_priority integer, p_pending integer, p_unread_docs integer, p_todos integer,
  p_referrals integer, p_ce_activities integer, p_assistance_requests integer,
  p_aged_cases integer, p_weekly_assigned integer, p_employment text,
  p_pt_hours integer, p_on_plan boolean, p_ot_worked boolean, p_ot_hours integer,
  p_leave_type text, p_leave_timing text, p_no_intake boolean, p_half_day boolean,
  p_note text, p_sub_details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  today_count integer;
  new_id uuid;
  rcode text;
  attempts integer := 0;
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  emp text := coalesce(p_employment, 'full_time');
  lt text := nullif(p_leave_type, '');
  rule_points integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if emp not in ('full_time', 'part_time') then
    raise exception 'invalid employment' using errcode = '22023';
  end if;
  if lt is not null and lt not in ('sick_leave','annual_leave','lwop','fmla','admin_leave','comp_time') then
    raise exception 'invalid leave type' using errcode = '22023';
  end if;
  if clean_note is not null and pg_catalog.char_length(clean_note) > 4000 then
    raise exception 'note too long' using errcode = '22023';
  end if;
  if p_sub_details is not null and pg_catalog.length(p_sub_details::text) > 4000 then
    raise exception 'sub_details too large' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-workload-' || caller::text, 509));
  select pg_catalog.count(*) into today_count from public.member_workload_logs
    where user_id = caller and logged_on = today;
  if today_count >= 3 then
    raise exception 'daily workload log limit reached (3 per day)' using errcode = '22023';
  end if;

  loop
    attempts := attempts + 1;
    rcode := private.workload_receipt_code();
    begin
      insert into public.member_workload_logs (
        user_id, priority, pending, unread_docs, todos, referrals, ce_activities,
        assistance_requests, aged_cases, weekly_assigned, employment, pt_hours,
        on_plan, ot_worked, ot_hours, leave_type, leave_timing, no_intake, half_day,
        note, sub_details, receipt_code, logged_on)
      values (
        caller,
        least(greatest(coalesce(p_priority, 0), 0), 300),
        least(greatest(coalesce(p_pending, 0), 0), 300),
        least(greatest(coalesce(p_unread_docs, 0), 0), 300),
        least(greatest(coalesce(p_todos, 0), 0), 300),
        least(greatest(coalesce(p_referrals, 0), 0), 300),
        least(greatest(coalesce(p_ce_activities, 0), 0), 300),
        least(greatest(coalesce(p_assistance_requests, 0), 0), 300),
        least(greatest(coalesce(p_aged_cases, 0), 0), 300),
        least(greatest(coalesce(p_weekly_assigned, 15), 0), 300),
        emp,
        case when emp = 'part_time' then least(greatest(coalesce(p_pt_hours, 24), 0), 80) else null end,
        coalesce(p_on_plan, false), coalesce(p_ot_worked, false),
        case when coalesce(p_ot_worked, false) then least(greatest(coalesce(p_ot_hours, 0), 1), 99) else 0 end,
        lt, case when lt is not null then coalesce(nullif(p_leave_timing, ''), 'unplanned') else null end,
        coalesce(p_no_intake, false), coalesce(p_half_day, false), clean_note,
        coalesce(p_sub_details, '{}'::jsonb), rcode, today)
      returning id into new_id;
      exit;
    exception when unique_violation then
      if attempts >= 3 then
        raise exception 'could not issue receipt, retry' using errcode = '40001';
      end if;
    end;
  end loop;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'workload-' || new_id::text, 'workload')
  on conflict (user_id, action_key) do nothing;
  perform private.notify_workload_event(caller, 'receipt', rcode);
  select points into rule_points from public.member_point_rules where action_kind = 'workload';
  return pg_catalog.jsonb_build_object(
    'id', new_id, 'receiptCode', rcode,
    'remainingToday', 3 - (today_count + 1),
    'awardedPoints', coalesce(rule_points, 0));
end;
$$;

revoke all on function public.submit_workload_log(
  integer,integer,integer,integer,integer,integer,integer,integer,integer,text,
  integer,boolean,boolean,integer,text,text,boolean,boolean,text,jsonb) from public, anon;
grant execute on function public.submit_workload_log(
  integer,integer,integer,integer,integer,integer,integer,integer,integer,text,
  integer,boolean,boolean,integer,text,text,boolean,boolean,text,jsonb) to authenticated;

-- ----------------------------------------- queue classification and claiming

create or replace function private.enqueue_notification_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  recent_week integer := 0;
  org_today integer;
  limit_reason text;
  transactional_receipt boolean := new.kind = 'workload' and new.workload_event = 'receipt';
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_per_recipient_week constant integer := 5;
  max_org_day constant integer := 20000;
begin
  if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload') then
    return new;
  end if;
  begin
    select c.outbound_enabled into outbound_on from private.notification_controls c where c.id;
    if not coalesce(outbound_on, false) then return new; end if;
    select p.notification_prefs into prefs from public.member_profiles p where p.id = new.user_id;
    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then return new; end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0));
    select pg_catalog.count(*) into recent_hour from public.member_notification_deliveries d
      where d.user_id = new.user_id and d.created_at > pg_catalog.now() - interval '1 hour';
    select pg_catalog.count(*) into recent_day from public.member_notification_deliveries d
      where d.user_id = new.user_id and d.created_at > pg_catalog.now() - interval '24 hours';

    if new.kind not in ('deadlines', 'cases') and not transactional_receipt then
      select pg_catalog.count(*) into recent_week
      from public.member_notification_deliveries d
      join public.member_notifications n2 on n2.id = d.notification_id
      where d.user_id = new.user_id and d.channel = 'email' and d.status <> 'skipped'
        and d.created_at > pg_catalog.now() - interval '7 days'
        and n2.kind not in ('deadlines', 'cases')
        and not (n2.kind = 'workload' and n2.workload_event = 'receipt');
    end if;

    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.notification_outbound_counters c where c.day = current_date;
    if recent_hour >= max_per_recipient_hour then limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and not transactional_receipt
      and recent_week >= max_per_recipient_week then limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then limit_reason := 'rate limited: org day';
    end if;

    if limit_reason is not null then
      insert into public.member_notification_deliveries (notification_id, user_id, channel, status, last_error)
      values (new.id, new.user_id, 'email', 'skipped', limit_reason)
      on conflict (notification_id, channel) do nothing;
      return new;
    end if;
    insert into private.notification_outbound_counters (day, shard, enqueued)
      values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
      on conflict (day, shard) do update set enqueued = private.notification_outbound_counters.enqueued + 1;
    insert into public.member_notification_deliveries (notification_id, user_id, channel)
      values (new.id, new.user_id, 'email') on conflict (notification_id, channel) do nothing;
    insert into public.member_notification_deliveries (notification_id, user_id, channel)
      select new.id, new.user_id, 'push'
      where exists (select 1 from public.member_push_subscriptions s where s.user_id = new.user_id)
      on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)', new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$$;

revoke all on function private.enqueue_notification_deliveries() from public, anon, authenticated, service_role;

create or replace function public.expire_notification_deliveries()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare expired integer := 0; exhausted integer := 0; ineligible integer := 0;
begin
  update public.member_notification_deliveries set
    status = 'skipped', last_error = 'expired before dispatch', updated_at = pg_catalog.now()
  where created_at < pg_catalog.now() - interval '48 hours'
    and (status = 'pending' or (status = 'sending' and updated_at < pg_catalog.now() - interval '15 minutes'));
  get diagnostics expired = row_count;
  update public.member_notification_deliveries set
    status = 'failed', last_error = coalesce(last_error, 'attempt budget exhausted'), updated_at = pg_catalog.now()
  where attempts >= 6
    and (status = 'pending' or (status = 'sending' and updated_at < pg_catalog.now() - interval '15 minutes'));
  get diagnostics exhausted = row_count;
  update public.member_notification_deliveries d set
    status = 'skipped', last_error = 'kind is not outbound-eligible', updated_at = pg_catalog.now()
  from public.member_notifications n
  where n.id = d.notification_id
    and n.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload')
    and (d.status = 'pending' or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'));
  get diagnostics ineligible = row_count;
  return pg_catalog.jsonb_build_object('expired', expired, 'exhausted', exhausted, 'ineligible', ineligible);
end;
$$;

revoke all on function public.expire_notification_deliveries() from public, anon, authenticated;
grant execute on function public.expire_notification_deliveries() to service_role;

create or replace function public.claim_notification_deliveries(p_channel text, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap integer := greatest(1, least(coalesce(p_limit, 200), 500));
  max_subscriptions constant integer := 10;
  outbound_on boolean;
  claimed jsonb;
begin
  if p_channel is null or p_channel not in ('email', 'push', 'sms') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;
  select c.outbound_enabled into outbound_on from private.notification_controls c where c.id;
  if not coalesce(outbound_on, false) then return '[]'::jsonb; end if;

  with candidates as (
    select d.id from public.member_notification_deliveries d
    join public.member_notifications n on n.id = d.notification_id
    where d.channel = p_channel and d.attempts < 6
      and d.created_at >= pg_catalog.now() - interval '48 hours'
      and ((d.status = 'pending' and d.next_attempt_at <= pg_catalog.now())
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
      and ((n.kind = 'workload' and n.workload_event = 'receipt')
        or not private.member_focus_blocks(d.user_id, n.kind))
    order by d.next_attempt_at limit cap for update of d skip locked
  ), flipped as (
    update public.member_notification_deliveries d set
      status = 'sending', attempts = d.attempts + 1, updated_at = pg_catalog.now()
    from candidates c where d.id = c.id
    returning d.id, d.notification_id, d.user_id, d.attempts
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', f.id, 'kind', n.kind, 'lang', coalesce(pr.language, 'en'),
    'attempt', f.attempts,
    'event', n.workload_event,
    'receiptCode', n.workload_receipt_code,
    'email', case when p_channel = 'email' then u.email end,
    'subscriptions', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth_key))
      from (select s2.endpoint, s2.p256dh, s2.auth_key
        from public.member_push_subscriptions s2 where s2.user_id = f.user_id
        order by s2.last_seen_at desc limit max_subscriptions) s
    ) end)), '[]'::jsonb)
  into claimed from flipped f
  join public.member_notifications n on n.id = f.notification_id
  left join public.member_profiles pr on pr.id = f.user_id
  left join auth.users u on u.id = f.user_id;
  return claimed;
end;
$$;

revoke all on function public.claim_notification_deliveries(text, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(text, integer) to service_role;

-- --------------------------------------------------------- due-row sweep/cron

create function private.workload_reminder_sweep()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  pref private.workload_reminder_preferences;
  sent integer := 0;
begin
  for pref in
    select * from private.workload_reminder_preferences
    where enabled and next_due_at <= pg_catalog.now()
    order by next_due_at, user_id
    for update skip locked
  loop
    update private.workload_reminder_preferences set
      next_due_at = private.next_workload_reminder_at(
        pref.cadence, pref.weekday, pref.local_hour, pref.timezone, pg_catalog.now()),
      last_sent_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where user_id = pref.user_id;
    perform private.notify_workload_event(pref.user_id, 'reminder', null);
    sent := sent + 1;
  end loop;
  return sent;
end;
$$;

revoke all on function private.workload_reminder_sweep() from public, anon, authenticated, service_role;

do $$
begin
  if pg_catalog.to_regnamespace('cron') is null then return; end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'workload-reminders-tick';
  perform cron.schedule(
    'workload-reminders-tick', '*/10 * * * *',
    $job$ select private.workload_reminder_sweep(); $job$);
end
$$;

notify pgrst, 'reload schema';
