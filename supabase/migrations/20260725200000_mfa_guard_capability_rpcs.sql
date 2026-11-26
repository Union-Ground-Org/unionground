-- MFA assurance guard for the capability RPCs (REQ-UG-DEFINER-MFA-AUDIT, batch 4 of 4: capability).
--
-- VECTOR
-- SECURITY DEFINER bypasses RLS, so the RESTRICTIVE mfa_assurance policy that
-- covers every RLS table (20260724030000) does nothing for a definer function.
-- Batches 1-3 (20260725170000 events, 20260725180000 forms, 20260725190000
-- cosign) swept their families; this batch takes the final three: the caller's
-- write-once workload ledger (submit_workload_log), the caller's private
-- Compass guide history (save_member_guide_exchange), and the caller's calendar
-- feed capability revocation (revoke_calendar_feed_token). All three are MEMBER
-- RPCs bound to the caller's own rows; none is steward-gated, so all three take
-- the member guard shape. An aal1 session belonging to a member who HAS
-- enrolled a TOTP factor can call them today without stepping up.
--
-- FIX
-- Augment the existing bare `if caller is null` guard to the assurance form the
-- guarded siblings carry:
--   if caller is null or not private.mfa_satisfied() then raise 42501.
-- private.mfa_satisfied() is aal2 OR "no verified TOTP factor", so this is
-- NON-LOCKOUT for members without MFA -- it only forces step-up for a member
-- who enrolled TOTP but is still at aal1. revoke_calendar_feed_token now
-- matches its sibling rotate_calendar_feed_token: revoking is the destructive
-- half of the same capability pair and was the only unguarded half. None of the
-- three DISCLOSES data: workload/guide are writes to the caller's own rows and
-- revoke deletes the caller's own token row, so guard placement is simply
-- first-statement, identical to the bare guard it replaces.
--
-- Bodies are otherwise VERBATIM from the live definitions: this file was
-- GENERATED server-side via replace(pg_get_functiondef(oid), old_guard_line,
-- new_guard_block) -- the old line occurs exactly once per body, asserted at
-- generation time -- so the bodies never passed through hand transcription.
-- Post-apply, md5(pg_get_functiondef) must equal the generation-time value:
--   submit_workload_log         1467b7ea19cf661541f16e5f8b96decc
--   save_member_guide_exchange  73aaad990824307991233352c5a3a574
--   revoke_calendar_feed_token  0ec182b554092705a4a255ce9620f781
--
-- STAGING + COVERAGE
-- Batch 4 of 4 -- the rollout closes here (events / forms / cosign /
-- capability). scripts/db-contract.json drops these three from
-- mfaCoverage.pending (the list is now EMPTY) and pins the full guard line +
-- errcode as bodyContains needles on each; the sweep still requires every
-- SECURITY DEFINER function reachable by authenticated to carry the term
-- (directly or via member_has_role) or sit on the exempt list, which stays
-- pinned at exactly 8 entries by test.

set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.submit_workload_log(p_priority integer, p_pending integer, p_unread_docs integer, p_todos integer, p_referrals integer, p_ce_activities integer, p_assistance_requests integer, p_aged_cases integer, p_weekly_assigned integer, p_employment text, p_pt_hours integer, p_on_plan boolean, p_ot_worked boolean, p_ot_hours integer, p_leave_type text, p_leave_timing text, p_no_intake boolean, p_half_day boolean, p_note text, p_sub_details jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): appends to the caller's write-once workload ledger and mints points.
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
end $function$;

CREATE OR REPLACE FUNCTION public.save_member_guide_exchange(p_thread_id uuid, p_question text, p_answer text, p_sources jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  active_thread_id uuid := p_thread_id;
  clean_question text := pg_catalog.btrim(coalesce(p_question, ''));
  clean_answer text := pg_catalog.btrim(coalesce(p_answer, ''));
  clean_sources jsonb := null;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): persists the caller's private Compass guide history.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_question) not between 1 and 1200 then
    raise exception 'question must be between 1 and 1200 characters' using errcode = '22023';
  end if;

  if pg_catalog.char_length(clean_answer) not between 1 and 4000 then
    raise exception 'answer must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if p_sources is not null
     and pg_catalog.jsonb_typeof(p_sources) = 'array'
     and pg_catalog.length(p_sources::text) <= 4000 then
    clean_sources := p_sources;
  end if;

  if active_thread_id is null then
    insert into public.member_guide_threads (user_id, title)
    values (caller, pg_catalog.left(clean_question, 120))
    returning id into active_thread_id;
  else
    perform 1
    from public.member_guide_threads
    where id = active_thread_id
      and user_id = caller
    for update;

    if not found then
      raise exception 'guide conversation not found' using errcode = '22023';
    end if;
  end if;

  insert into public.member_guide_messages (thread_id, user_id, role, body, sources)
  values
    (active_thread_id, caller, 'user', clean_question, null),
    (active_thread_id, caller, 'assistant', clean_answer, clean_sources);

  update public.member_guide_threads
  set updated_at = now()
  where id = active_thread_id
    and user_id = caller;

  return active_thread_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_calendar_feed_token()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): destroys the caller's calendar feed capability; now matches guarded sibling rotate_calendar_feed_token.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  delete from public.member_calendar_feed_tokens where user_id = caller;
  return pg_catalog.jsonb_build_object('revoked', true);
end;
$function$;
