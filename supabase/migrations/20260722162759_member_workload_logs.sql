create table if not exists public.member_workload_logs (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  priority              smallint not null default 0 check (priority             between 0 and 300),
  pending               smallint not null default 0 check (pending              between 0 and 300),
  unread_docs           smallint not null default 0 check (unread_docs          between 0 and 300),
  todos                 smallint not null default 0 check (todos                between 0 and 300),
  referrals             smallint not null default 0 check (referrals            between 0 and 300),
  ce_activities         smallint not null default 0 check (ce_activities        between 0 and 300),
  assistance_requests   smallint not null default 0 check (assistance_requests  between 0 and 300),
  aged_cases            smallint not null default 0 check (aged_cases           between 0 and 300),
  weekly_assigned  smallint not null default 15 check (weekly_assigned between 0 and 300),
  employment       text     not null default 'full_time' check (employment in ('full_time','part_time')),
  pt_hours         smallint check (pt_hours is null or pt_hours between 0 and 80),
  on_plan          boolean  not null default false,
  ot_worked        boolean  not null default false,
  ot_hours         smallint not null default 0 check (ot_hours between 0 and 99),
  leave_type   text check (leave_type is null or leave_type in
                  ('sick_leave','annual_leave','lwop','fmla','admin_leave','comp_time')),
  leave_timing text check (leave_timing is null or leave_timing in ('planned','unplanned')),
  no_intake    boolean not null default false,
  half_day     boolean not null default false,
  note        text check (note is null or pg_catalog.char_length(note) between 1 and 4000),
  sub_details jsonb not null default '{}'::jsonb
                check (pg_catalog.jsonb_typeof(sub_details) = 'object'
                       and pg_catalog.length(sub_details::text) <= 4000),
  receipt_code text not null unique check (receipt_code ~ '^[0-9a-f]{8}$'),
  created_at   timestamptz not null default now(),
  logged_on    date not null default ((now() at time zone 'America/New_York')::date),
  constraint pt_hours_when_part_time check (employment <> 'part_time' or pt_hours is not null),
  constraint ot_hours_when_worked    check (ot_worked = false or ot_hours > 0),
  constraint leave_timing_when_leave check (leave_type is null or leave_timing is not null)
);

create index if not exists member_workload_logs_user_created_idx
  on public.member_workload_logs (user_id, created_at desc);
create index if not exists member_workload_logs_user_day_idx
  on public.member_workload_logs (user_id, logged_on);
create index if not exists member_workload_logs_created_idx
  on public.member_workload_logs (created_at desc);

alter table public.member_workload_logs enable row level security;

drop policy if exists member_workload_logs_select_own on public.member_workload_logs;
create policy member_workload_logs_select_own on public.member_workload_logs
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.member_workload_logs from anon, authenticated;
grant select on public.member_workload_logs to authenticated;

alter table public.member_action_log drop constraint member_action_log_action_kind_check;
alter table public.member_action_log
  add constraint member_action_log_action_kind_check
  check (action_kind in
    ('seed','vote','survey','rights','case','message','steward','rsvp','checkin','workload'));

insert into public.member_point_rules (action_kind, label, points, weekly_cap) values
  ('workload', 'Log your workload', 10, null)
on conflict (action_kind) do update
  set label = excluded.label, points = excluded.points, weekly_cap = excluded.weekly_cap;

create or replace function private.award_member_points()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  rule record;
  backed boolean := false;
  awarded_this_week integer;
begin
  if new.action_kind = 'seed' then
    return new;
  end if;
  select points, weekly_cap into rule
  from public.member_point_rules
  where action_kind = new.action_kind and points > 0;
  if not found then
    return new;
  end if;
  if new.action_kind = 'vote' then
    backed := pg_catalog.left(new.action_key, 5) = 'vote-' and exists (
      select 1 from public.member_ballot_votes
      where user_id = new.user_id and ballot_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'survey' then
    backed := pg_catalog.left(new.action_key, 7) = 'survey-' and exists (
      select 1 from public.member_survey_responses
      where user_id = new.user_id and survey_id = pg_catalog.substr(new.action_key, 8));
  elsif new.action_kind = 'rights' then
    backed := pg_catalog.left(new.action_key, 7) = 'rights-' and exists (
      select 1 from public.member_rights_progress
      where user_id = new.user_id and lesson_id = pg_catalog.substr(new.action_key, 8)
        and pg_catalog.cardinality(completed_steps) > 0);
  elsif new.action_kind = 'case' then
    backed := pg_catalog.left(new.action_key, 5) = 'case-' and exists (
      select 1 from public.member_cases
      where user_id = new.user_id and reference = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'message' then
    backed := exists (
      select 1 from public.member_conversations
      where user_id = new.user_id
        and id::text = (pg_catalog.regexp_match(new.action_key, '^message-(.*)-[0-9]+$'))[1]);
  elsif new.action_kind = 'steward' then
    backed := exists (
      select 1 from public.member_steward_requests
      where user_id = new.user_id
        and coalesce(lesson_id, '') = coalesce((pg_catalog.regexp_match(new.action_key, '^steward-(.*)-[0-9]+$'))[1], ''));
  elsif new.action_kind = 'rsvp' then
    backed := pg_catalog.left(new.action_key, 5) = 'rsvp-' and exists (
      select 1 from public.member_event_rsvps
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'checkin' then
    backed := pg_catalog.left(new.action_key, 8) = 'checkin-' and exists (
      select 1 from public.member_event_checkins
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 9));
  elsif new.action_kind = 'workload' then
    backed := pg_catalog.left(new.action_key, 9) = 'workload-' and exists (
      select 1 from public.member_workload_logs
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 10));
  end if;
  if not backed then
    return new;
  end if;
  if rule.weekly_cap is not null then
    select count(*) into awarded_this_week
    from public.member_point_events
    where user_id = new.user_id and action_kind = new.action_kind
      and occurred_at >= pg_catalog.date_trunc('week', now());
    if awarded_this_week >= rule.weekly_cap then
      return new;
    end if;
  end if;
  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (new.user_id, new.action_key, new.action_kind, rule.points)
  on conflict (user_id, action_key) do nothing;
  return new;
end;
$function$;

create or replace function private.workload_receipt_code()
returns text language sql volatile set search_path = '' as $$
  select pg_catalog.encode(extensions.gen_random_bytes(4), 'hex');
$$;
revoke all on function private.workload_receipt_code() from public, anon, authenticated;

create function public.submit_workload_log(
  p_priority int, p_pending int, p_unread_docs int, p_todos int,
  p_referrals int, p_ce_activities int, p_assistance_requests int, p_aged_cases int,
  p_weekly_assigned int, p_employment text, p_pt_hours int, p_on_plan boolean,
  p_ot_worked boolean, p_ot_hours int,
  p_leave_type text, p_leave_timing text, p_no_intake boolean, p_half_day boolean,
  p_note text, p_sub_details jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  caller      uuid := (select auth.uid());
  today       date := (now() at time zone 'America/New_York')::date;
  today_count integer;
  new_id      uuid;
  rcode       text;
  attempts    int := 0;
  clean_note  text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  emp         text := coalesce(p_employment, 'full_time');
  lt          text := nullif(p_leave_type, '');
  rule_points integer;
begin
  if caller is null then
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-workload-' || caller::text, 509));

  select count(*) into today_count
  from public.member_workload_logs
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
        coalesce(p_on_plan, false),
        coalesce(p_ot_worked, false),
        case when coalesce(p_ot_worked, false) then least(greatest(coalesce(p_ot_hours, 0), 1), 99) else 0 end,
        lt,
        case when lt is not null then coalesce(nullif(p_leave_timing, ''), 'unplanned') else null end,
        coalesce(p_no_intake, false),
        coalesce(p_half_day, false),
        clean_note,
        coalesce(p_sub_details, '{}'::jsonb),
        rcode, today)
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

  select points into rule_points from public.member_point_rules where action_kind = 'workload';

  return pg_catalog.jsonb_build_object(
    'id', new_id, 'receiptCode', rcode,
    'remainingToday', 3 - (today_count + 1),
    'awardedPoints', coalesce(rule_points, 0));
end $$;

revoke all on function public.submit_workload_log(
  int,int,int,int,int,int,int,int,int,text,int,boolean,boolean,int,text,text,boolean,boolean,text,jsonb)
  from public, anon;
grant execute on function public.submit_workload_log(
  int,int,int,int,int,int,int,int,int,text,int,boolean,boolean,int,text,text,boolean,boolean,text,jsonb)
  to authenticated;

create function public.get_workload_stats()
returns jsonb language plpgsql security definer stable set search_path = '' as $$
declare
  loc_now       timestamp   := (now() at time zone 'America/New_York');
  q_start_local timestamp   := pg_catalog.date_trunc('quarter', loc_now) - interval '3 months';
  q_end_local   timestamp   := pg_catalog.date_trunc('quarter', loc_now);
  q_start       timestamptz := q_start_local at time zone 'America/New_York';
  q_end         timestamptz := q_end_local at time zone 'America/New_York';
  period_label  text := (pg_catalog.date_part('year', q_start_local))::int::text
                        || '-Q' || (pg_catalog.date_part('quarter', q_start_local))::int::text;
  n_sub  integer;
  K constant integer := 25;
  cats   jsonb;
  tiles  jsonb;
  band   text;
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.count(*) into n_sub from (
    select distinct on (user_id) id
    from public.member_workload_logs
    where created_at >= q_start and created_at < q_end
    order by user_id, created_at desc
  ) s;

  if n_sub < K then
    return pg_catalog.jsonb_build_object(
      'enoughData', false, 'minSubmitters', K, 'period', period_label, 'generatedAt', now());
  end if;

  band := case when n_sub >= 100 then '100+' when n_sub >= 50 then '50-99' else '25-49' end;

  with latest as (
    select distinct on (user_id)
      priority, pending, unread_docs, todos, referrals, ce_activities,
      assistance_requests, aged_cases, employment, ot_hours
    from public.member_workload_logs
    where created_at >= q_start and created_at < q_end
    order by user_id, created_at desc
  ),
  w as (
    select
      least(priority, 150) p, least(pending, 150) pe, least(unread_docs, 150) ud,
      least(todos, 150) td, least(referrals, 150) rf, least(ce_activities, 150) ce,
      least(assistance_requests, 150) ar, least(aged_cases, 150) ag,
      employment emp, least(ot_hours, 40) oth
    from latest
  )
  select
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('key', 'priority',            'avg', pg_catalog.round(pg_catalog.avg(p))),
      pg_catalog.jsonb_build_object('key', 'pending',             'avg', pg_catalog.round(pg_catalog.avg(pe))),
      pg_catalog.jsonb_build_object('key', 'unread_docs',         'avg', pg_catalog.round(pg_catalog.avg(ud))),
      pg_catalog.jsonb_build_object('key', 'todos',               'avg', pg_catalog.round(pg_catalog.avg(td))),
      pg_catalog.jsonb_build_object('key', 'referrals',           'avg', pg_catalog.round(pg_catalog.avg(rf))),
      pg_catalog.jsonb_build_object('key', 'ce_activities',       'avg', pg_catalog.round(pg_catalog.avg(ce))),
      pg_catalog.jsonb_build_object('key', 'assistance_requests', 'avg', pg_catalog.round(pg_catalog.avg(ar))),
      pg_catalog.jsonb_build_object('key', 'aged_cases',          'avg', pg_catalog.round(pg_catalog.avg(ag)))
    ),
    pg_catalog.jsonb_build_object(
      'pctFullTime', pg_catalog.round(100.0 * pg_catalog.avg((emp = 'full_time')::int) / 10.0) * 10,
      'pctPartTime', pg_catalog.round(100.0 * pg_catalog.avg((emp = 'part_time')::int) / 10.0) * 10,
      'avgOtHours',  pg_catalog.round(pg_catalog.avg(oth)::numeric, 1))
  into cats, tiles
  from w;

  return pg_catalog.jsonb_build_object(
    'enoughData', true, 'period', period_label, 'generatedAt', now(),
    'submittersBand', band, 'categories', cats, 'tiles', tiles);
end $$;

revoke all on function public.get_workload_stats() from public, anon;
grant execute on function public.get_workload_stats() to authenticated;
