-- BUG-UG-WEB-WORKLOAD-DAILY-LIMIT-GENERIC-ERROR-20261003
--
-- submit_workload_log refuses a fourth log on the same Eastern day with SQLSTATE
-- 22023 and an English sentence only, so the Workload page could not tell that
-- refusal from any other failure and showed "That action could not be saved."
-- This stamps the stable DETAIL token workload_daily_limit on that one refusal
-- (src/lib/rpcErrorText.js maps it to catalogue copy in English and Spanish).
--
-- The body below is the installed definition read with pg_get_functiondef from
-- a disposable stack at Main, with only the daily-limit raise changed. The guard
-- refuses to replace any predecessor but that reviewed one. Signature, owner,
-- security definer, search_path and grants are unchanged by create or replace.
--
-- Hosted application needs the owner's separate go-ahead; the web change falls
-- back to the generic message until then.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessor$
declare
  installed text;
begin
  select pg_catalog.md5(p.prosrc) into strict installed
    from pg_catalog.pg_proc p
   where p.oid = 'public.submit_workload_log(integer, integer, integer, integer, integer, integer, integer, integer, integer, text, integer, boolean, boolean, integer, text, text, boolean, boolean, text, jsonb)'::regprocedure;
  if installed is distinct from 'fc624d573d5e6655ea1a0e409d1092f4' then
    raise exception 'unreviewed submit_workload_log predecessor: %', installed
      using errcode = '55000';
  end if;
end;
$predecessor$;

CREATE OR REPLACE FUNCTION public.submit_workload_log(p_priority integer, p_pending integer, p_unread_docs integer, p_todos integer, p_referrals integer, p_ce_activities integer, p_assistance_requests integer, p_aged_cases integer, p_weekly_assigned integer, p_employment text, p_pt_hours integer, p_on_plan boolean, p_ot_worked boolean, p_ot_hours integer, p_leave_type text, p_leave_timing text, p_no_intake boolean, p_half_day boolean, p_note text, p_sub_details jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
    raise exception 'daily workload log limit reached (3 per day)' using errcode = '22023', detail = 'workload_daily_limit';
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
end;
$function$;

commit;
