-- BUG-UG-GRIEVANCE-STEP-DEADLINES-UTC-DAY-20261106 (#7198); stamp
-- reserved by .
-- Procedure step deadlines were counted on the UTC calendar: an incident
-- date became midnight UTC (7 or 8 PM Eastern the evening before), calendar
-- and business days were added to the UTC date, and the result kept the
-- start's UTC time of day. A deadline 10 business days from an incident on
-- Monday Nov 2, 2026 was stored as Nov 16 00:00 UTC, which every screen shows
-- as Nov 15 at 7 PM Eastern, and the missed-deadline sweep (grace 0 by
-- default) marked it missed before the contract's due day began.
--
-- Deadlines now count America/New_York calendar dates, the zone every other
-- deadline surface already reads (the steward deadline list, the overdue
-- flag of #6745 and the deadline notices of #7087): the incident date, the
-- case's filing date and the step-entry date are Eastern dates, weekday and
-- holiday checks use Eastern dates, and due_at is the end of the Eastern due
-- day (23:59:59). The missed sweep compares due_at with the clock, so it now
-- waits until the due day is over. The case strength suggestion counts its
-- days remaining on the same Eastern calendar and warns 'passed' only after
-- the due day, never on it.
--
-- No stored deadline is rewritten: Production held no casework deadline,
-- procedure or step transition when this was written (read-only count,
-- Nov 6, 2026, 2:27 PM ET). Bodies are otherwise the ones 20260917133000
-- (business days), 20261104123000 (casework_advance_step) and
-- 20261102005607 (casework_suggest_case_strength) installed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Whole weeks are arithmetic on the Eastern calendar; the result is the end
-- of the Eastern due day, independent of the session TimeZone.
create or replace function private.casework_add_business_days(p_start timestamptz, p_count integer, p_organization_id uuid)
returns timestamptz language plpgsql stable security definer set search_path = '' as $function$
declare v_date timestamp; v_left integer := p_count;
  v_start date; v_extra integer;
begin
  if p_start is null or not isfinite(p_start) or p_count is null or p_count < 0 or p_organization_id is null then
    raise exception 'invalid business-day input' using errcode = '22023';
  end if;
  v_date := (p_start at time zone 'America/New_York')::date::timestamp;
  -- Whole weeks are arithmetic. Each subsequent iteration accounts only for
  -- holidays crossed by the previous extension, never loops once per day.
  while v_left > 0 loop
    v_start := v_date::date;
    if extract(isodow from v_date) >= 6 then
      v_date := v_date + ((8 - extract(isodow from v_date)::integer) * interval '1 day');
      v_left := v_left - 1;
    end if;
    v_date := v_date + ((v_left / 5)::bigint * 7 * interval '1 day');
    v_extra := v_left % 5;
    if extract(isodow from v_date)::integer + v_extra > 5 then v_extra := v_extra + 2; end if;
    v_date := v_date + (v_extra * interval '1 day');
    select count(*)::integer into v_left from public.organization_holidays h
      where h.organization_id = p_organization_id and h.holiday_date > v_start
        and h.holiday_date <= v_date::date and extract(isodow from h.holiday_date) < 6;
  end loop;
  return (v_date::date + time '23:59:59') at time zone 'America/New_York';
end;
$function$;
revoke all on function private.casework_add_business_days(timestamptz, integer, uuid) from public, anon, authenticated, service_role;

-- Calendar days and the incident anchor use Eastern dates.
create or replace function public.casework_advance_step(
  p_case_id uuid,
  p_expected_step text,
  p_next_step text,
  p_outcome text,
  p_idempotency_key uuid
)
returns public.casework_step_transitions
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_case public.member_cases%rowtype; v_transition public.casework_step_transitions%rowtype; v_template public.casework_checklist_templates%rowtype; v_checklist_id uuid; v_procedure uuid; v_current public.casework_procedure_steps%rowtype; v_next public.casework_procedure_steps%rowtype; v_start timestamptz; v_due timestamptz; v_incident text; v_deadline_id uuid;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_next_step is null or p_outcome is null or p_idempotency_key is null then raise exception 'invalid transition' using errcode = '22023'; end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('casework-procedure:' || v_case.organization_id::text, 0));
  select * into strict v_case from public.member_cases where id = p_case_id for update;
  select * into v_transition from public.casework_step_transitions where organization_id = v_case.organization_id and transitioned_by = (select auth.uid()) and idempotency_key = p_idempotency_key;
  if found then
    if v_transition.case_id <> p_case_id or v_transition.from_step is distinct from p_expected_step or v_transition.to_step is distinct from btrim(p_next_step) or v_transition.outcome is distinct from btrim(p_outcome) then raise exception 'idempotency key reused' using errcode = '22023'; end if;
    return v_transition;
  end if;
  if v_case.step is distinct from p_expected_step then raise exception 'case step changed' using errcode = '40001'; end if;
  v_procedure := private.casework_resolve_procedure(v_case.organization_id, v_case.chapter_id, v_case.case_type);
  if v_procedure is null and (char_length(btrim(p_next_step)) not between 2 and 100 or p_next_step = p_expected_step) then raise exception 'invalid next step' using errcode = '22023'; end if;
  if v_procedure is not null then
    select * into v_current from public.casework_procedure_steps where procedure_id = v_procedure and key = v_case.step;
    if v_current.terminal then raise exception 'terminal step cannot advance' using errcode = '22023'; end if;
    select * into v_next from private.casework_allowed_next_steps(v_procedure, v_case.step) s where s.key = btrim(p_next_step);
    if v_next.id is null then raise exception 'invalid procedure successor' using errcode = '22023'; end if;
    if v_current.requires_checklist and (not exists (select 1 from public.casework_checklists c where c.case_id = v_case.id and c.step = v_case.step)
      or exists (select 1 from public.casework_checklists c join public.casework_checklist_items i on i.checklist_id = c.id
        where c.case_id = v_case.id and c.step = v_case.step and i.required and i.completed_at is null))
      then raise exception 'required checklist incomplete' using errcode = '22023'; end if;
    if v_next.deadline_rule->>'kind' <> 'none' then
      v_start := now();
      if v_next.deadline_rule->>'from' = 'filing' then v_start := v_case.created_at; end if;
      if v_next.deadline_rule->>'from' = 'incident' then
        select f.answers->>'incident_date' into v_incident from public.member_forms f
          where f.case_id = v_case.id and f.user_id = v_case.user_id order by f.created_at, f.id limit 1;
        if v_incident is null or v_incident !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'incident date required on case filing' using errcode = '22023'; end if;
        v_start := v_incident::date::timestamp at time zone 'America/New_York';
      end if;
      v_due := case v_next.deadline_rule->>'kind'
        when 'business_days' then private.casework_add_business_days(v_start, (v_next.deadline_rule->>'count')::integer, v_case.organization_id)
        else (((v_start at time zone 'America/New_York')::date + (v_next.deadline_rule->>'count')::integer) + time '23:59:59') at time zone 'America/New_York' end;
    end if;
  end if;
  insert into public.casework_step_transitions(case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, v_case.step, pg_catalog.btrim(p_next_step), pg_catalog.btrim(p_outcome), (select auth.uid()), p_idempotency_key, pg_current_xact_id())
  returning * into v_transition;
  if v_due is not null then
    insert into public.casework_deadlines(case_id, organization_id, chapter_id, kind, label, due_at, created_by)
    values(v_case.id, v_case.organization_id, v_case.chapter_id, 'procedure', v_next.label, v_due, (select auth.uid()))
    returning id into v_deadline_id;
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'deadline_created', 'deadline', v_deadline_id,
      pg_catalog.jsonb_build_object('kind', 'procedure', 'dueAt', v_due, 'reminderSet', false));
  end if;
  update public.member_cases set step = pg_catalog.btrim(p_next_step), updated_at = pg_catalog.now() where id = v_case.id;
  select * into v_template from public.casework_checklist_templates t
  where t.organization_id = v_case.organization_id and (t.chapter_id is null or t.chapter_id = v_case.chapter_id)
    and t.case_type = v_case.case_type and t.step = pg_catalog.btrim(p_next_step) and t.active
  order by (t.chapter_id is not null) desc, t.updated_at desc limit 1;
  if found then
    insert into public.casework_checklists(case_id, organization_id, chapter_id, template_id, step, title, created_by)
    values (v_case.id, v_case.organization_id, v_case.chapter_id, v_template.id, p_next_step, v_template.title, (select auth.uid())) returning id into v_checklist_id;
    insert into public.casework_checklist_items(checklist_id, organization_id, label, position, required)
    select v_checklist_id, v_case.organization_id, item->>'label', (ordinality - 1)::integer, coalesce((item->>'required')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_template.items) with ordinality as x(item, ordinality);
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'step_advanced', 'step_transition', v_transition.id, pg_catalog.jsonb_build_object('fromStep', v_case.step, 'toStep', p_next_step, 'checklistId', v_checklist_id));
  perform private.learning_casework_journal('casework_step_advance', p_case_id);
  return v_transition;
end;

end;
$function$;

-- Days remaining count Eastern dates, matching the deadlines above. A
-- deadline is open through the end of its Eastern due day: that day reads 0
-- days remaining with the 'soon' warning, and 'passed' starts the day after.
-- The incident filing window ends the same way.
CREATE OR REPLACE FUNCTION public.casework_suggest_case_strength(p_case_id uuid, p_evidence_type text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_answers jsonb;
  v_words text[];
  v_word_count integer;
  v_matches jsonb;
  v_max integer;
  v_contract integer;
  v_evidence_type text;
  v_inferred boolean;
  v_evidence integer;
  v_incident date;
  v_window integer;
  v_warning_days integer;
  v_days_since integer;
  v_procedural integer;
  v_days_remaining integer;
  v_due date;
  v_today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_overall integer;
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_read(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  if p_evidence_type is not null and p_evidence_type not in ('witness_statements', 'documents', 'photos', 'none') then
    raise exception 'invalid evidence type' using errcode = '22023';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  if not private.organization_feature_enabled(v_case.organization_id, 'features.casework.strength_auto_suggest') then
    raise exception 'strength suggestion is turned off' using errcode = '55000';
  end if;
  select f.answers into v_answers from public.member_forms f
  where f.case_id = v_case.id and f.user_id = v_case.user_id
    and (f.user_id=(select auth.uid()) or f.status in ('submitted','in_review','approved') or private.member_draft_shared_to_caller(f))
  order by f.created_at, f.id limit 1;
  v_answers := coalesce(v_answers, '{}'::jsonb);

  -- Old words(): lower case, drop non-alphanumerics, split, keep >= 3 chars.
  select coalesce(array_agg(w), '{}'::text[]) into v_words
  from pg_catalog.regexp_split_to_table(
    pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.concat_ws(' ',
      v_case.title, v_case.articles, v_answers ->> 'summary', v_answers ->> 'articles', v_answers ->> 'narrative')),
      '[^a-z0-9[:space:]]', '', 'g'),
    '[[:space:]]+') w
  where pg_catalog.char_length(w) >= 3;
  v_word_count := pg_catalog.cardinality(v_words);

  with scored as (
    select c.id, c.article, c.title, c.sort_order,
      (select pg_catalog.count(*)::integer from pg_catalog.unnest(v_words) w
        where pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.array_to_string(c.keywords, ' ') || ' ' || coalesce(c.summary, '')), w) > 0
      ) as match_count
    from public.contract_clauses c
    where c.organization_id = v_case.organization_id and c.status = 'published'
  ), ranked as (
    select s.*, row_number() over (order by s.match_count desc, s.sort_order, s.article, s.id) as position
    from scored s where s.match_count > 0
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', r.id, 'article', r.article, 'title', r.title, 'matchCount', r.match_count,
      'tag', case when r.position = 1 then 'Primary' else 'Supporting' end) order by r.position)
      filter (where r.position <= 3), '[]'::jsonb),
    coalesce(max(r.match_count), 0)
  into v_matches, v_max
  from ranked r;
  v_contract := case when v_max > 0
    then least(100, round(v_max::numeric / greatest(v_word_count, 1) * 100))::integer else 0 end;

  v_inferred := p_evidence_type is null;
  v_evidence_type := coalesce(p_evidence_type, case
    when nullif(pg_catalog.btrim(coalesce(v_answers ->> 'witnesses', '')), '') is not null then 'witness_statements'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type not like 'image/%') then 'documents'
    when exists (select 1 from public.member_case_files mf where mf.case_id = v_case.id and mf.removal_id is null
      and mf.mime_type like 'image/%') then 'photos'
    else 'none' end);
  v_evidence := private.organization_limit(v_case.organization_id, case v_evidence_type
    when 'witness_statements' then 'limits.casework.strength_evidence_witness'
    when 'documents' then 'limits.casework.strength_evidence_documents'
    when 'photos' then 'limits.casework.strength_evidence_photos'
    else 'limits.casework.strength_evidence_none' end);

  v_window := private.organization_limit(v_case.organization_id, 'limits.casework.strength_filing_window_days');
  v_warning_days := private.organization_limit(v_case.organization_id, 'limits.casework.strength_deadline_warning_days');
  if coalesce(v_answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_incident := (v_answers ->> 'incident_date')::date;
  end if;
  v_procedural := 100;
  if v_incident is not null then
    v_days_since := greatest(0, v_today - v_incident);
    v_procedural := greatest(0, round(100 - v_days_since::numeric / v_window * 100))::integer;
    v_days_remaining := v_window - v_days_since;
  end if;
  select (min(d.due_at) at time zone 'America/New_York')::date into v_due
  from public.casework_deadlines d
  where d.case_id = v_case.id and d.kind in ('filing', 'procedure') and d.status in ('active', 'extended');
  if v_due is not null then
    v_days_remaining := v_due - v_today;
  end if;

  v_overall := round(v_contract * 0.4 + v_evidence * 0.35 + v_procedural * 0.25)::integer;
  return pg_catalog.jsonb_build_object(
    'overallScore', v_overall,
    'band', case when v_overall < 45 then 'needs_evidence' when v_overall < 75 then 'developing' else 'strong' end,
    'contractScore', v_contract,
    'evidenceScore', v_evidence,
    'proceduralScore', v_procedural,
    'evidenceType', v_evidence_type,
    'evidenceInferred', v_inferred,
    'matchedClauses', v_matches,
    'daysRemaining', case when v_days_remaining is not null then greatest(0, v_days_remaining) end,
    'deadlineWarning', case
      when v_days_remaining is null then null
      when v_days_remaining < 0 then 'passed'
      when v_days_remaining <= v_warning_days then 'soon' end,
    'warningDays', v_warning_days,
    'suggestedInputs', pg_catalog.jsonb_build_object(
      'contract_support', least(5, round(v_contract / 20.0))::integer,
      'documentation', least(5, round(v_evidence / 20.0))::integer,
      'timeliness', least(5, round(v_procedural / 20.0))::integer,
      'witnesses', case when v_evidence_type = 'witness_statements' then 5 else 0 end));
end;
$function$;

commit;
