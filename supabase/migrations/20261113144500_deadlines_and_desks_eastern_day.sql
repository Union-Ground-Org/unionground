-- BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112 (#8568), part B of four:
-- casework deadlines and the staff desks, read on the Eastern day.
--
-- These readers compare a calendar day (a case deadline, an unfair labor
-- practice or safety deadline, a task's due date, an incident date) with
-- current_date, the session's day, and the hosted projects run in UTC: from
-- 7 PM Eastern (8 PM in daylight time) a deadline due today counted as
-- overdue, days left came out one short, the due-soon week started tomorrow
-- and an incident on today's date was refused as in the future. Each now reads
-- private.eastern_day() (20261113122500_eastern_day_helper.sql), written
-- (select private.eastern_day()) so it is read once per query, not once per
-- row. list_coordinator_cases runs with the caller's rights, and no API role
-- may execute the helper, so it reads the same Eastern day inline. The Compass
-- days-ago counts read both sides on the Eastern calendar: a case opened at
-- 9 PM Eastern was opened today, not tomorrow. Nothing else in any body
-- changes. Functions:
--   private.casework_detect_retaliation_timing
--   private.casework_retaliation_flag_json
--   private.casework_sweep_ulp_deadlines
--   private.cr108_candidate_count
--   private.cr108_candidate_sources
--   private.workload_rebalancing
--   public.casework_flag_retaliation_incident
--   public.casework_list_ulp_deadlines
--   public.create_member_case
--   public.get_advisor_overview
--   public.get_compass_case_context
--   public.get_compass_field_notes_packet_context
--   public.get_coordinator_kpis
--   public.get_my_case_ulp_summary
--   public.get_vp_overview
--   public.list_coordinator_cases
--   public.mark_vp_case_reviewed
--   public.mi1_get_automation_opportunities
--   public.open_member_case
--   public.validate_member_operations_import
--   private.casework_retaliation_adverse_events
--
-- BUG-UG-ULP-DEADLINE-FROM-AN-EVENING-MEMBER-REPORT-LANDS-A-DAY-LATE-20261115 (#8868), inside
-- this part by a project decision: the hourly sweep dated a member's retaliation report on the
-- UTC day, so an incident reported from 7 PM Eastern got tomorrow's date and its unfair labor
-- practice filing deadline (incident_on + ulp_window_days) came out a day late. The sweep, the
-- retaliation timing detector and its adverse-event source now date incidents, grievances and
-- adverse events on the Eastern calendar; a date typed on a form is kept as entered. Stored
-- member-report and timing-detector flags dated on the UTC day are corrected at the end, in this
-- transaction (#9003; this file was applied nowhere when that was added).
-- Grants are unchanged (create or replace keeps them). A predecessor guard
-- refuses to run unless every live body is the reviewed one.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_detect_retaliation_timing(uuid,text,integer)'::regprocedure)
    is distinct from 'd9c1ed328d372722bce66908489cd7e6' then
    raise exception 'unreviewed predecessor: private.casework_detect_retaliation_timing' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_retaliation_flag_json(public.casework_retaliation_flags,boolean)'::regprocedure)
    is distinct from '9de9bc2a91971b30f348d16b08e0adf9' then
    raise exception 'unreviewed predecessor: private.casework_retaliation_flag_json' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_sweep_ulp_deadlines(integer)'::regprocedure)
    is distinct from '0fe987ee7f385c5e6e95884960438aff' then
    raise exception 'unreviewed predecessor: private.casework_sweep_ulp_deadlines' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.cr108_candidate_count(uuid,uuid,text,integer)'::regprocedure)
    is distinct from '721a336eb106d97ec75d58956d423092' then
    raise exception 'unreviewed predecessor: private.cr108_candidate_count' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.cr108_candidate_sources(uuid,uuid,text,integer,integer)'::regprocedure)
    is distinct from '7313efb86f01027310f2709bd0690cae' then
    raise exception 'unreviewed predecessor: private.cr108_candidate_sources' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.workload_rebalancing(text)'::regprocedure)
    is distinct from '3bb8111b98563d6538a8e4853d23ead9' then
    raise exception 'unreviewed predecessor: private.workload_rebalancing' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.casework_flag_retaliation_incident(uuid,date,text,text)'::regprocedure)
    is distinct from '24f426b69dd675071c23a7c21cf85d23' then
    raise exception 'unreviewed predecessor: public.casework_flag_retaliation_incident' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.casework_list_ulp_deadlines(integer)'::regprocedure)
    is distinct from 'cbb07a1eac6d7ab9eff55e28a02b971b' then
    raise exception 'unreviewed predecessor: public.casework_list_ulp_deadlines' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.create_member_case(text,date,text,text)'::regprocedure)
    is distinct from '1a01f18b0f374872c0607bc5e37eb5e0' then
    raise exception 'unreviewed predecessor: public.create_member_case' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_advisor_overview()'::regprocedure)
    is distinct from 'ee7c6c7d18983a689ecc9a28d1c69a6d' then
    raise exception 'unreviewed predecessor: public.get_advisor_overview' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_compass_case_context(uuid)'::regprocedure)
    is distinct from '8776b53785e3237126c972fd17b8b430' then
    raise exception 'unreviewed predecessor: public.get_compass_case_context' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_compass_field_notes_packet_context(uuid,uuid[])'::regprocedure)
    is distinct from '730e7865cedf8da7248a284bd7b8d0ff' then
    raise exception 'unreviewed predecessor: public.get_compass_field_notes_packet_context' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_coordinator_kpis()'::regprocedure)
    is distinct from 'c9c8cdec76dcb0aa15f09e618333eeb0' then
    raise exception 'unreviewed predecessor: public.get_coordinator_kpis' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_my_case_ulp_summary()'::regprocedure)
    is distinct from 'e4d29d56c59c06bd346a661e3cc81785' then
    raise exception 'unreviewed predecessor: public.get_my_case_ulp_summary' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_vp_overview()'::regprocedure)
    is distinct from '954f70cf3a00b5dfbcf07a189f35ccbf' then
    raise exception 'unreviewed predecessor: public.get_vp_overview' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.list_coordinator_cases(text,date,uuid,integer)'::regprocedure)
    is distinct from 'dd52868af0f0e56c8fed322a42c4c64b' then
    raise exception 'unreviewed predecessor: public.list_coordinator_cases' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.mark_vp_case_reviewed(uuid)'::regprocedure)
    is distinct from '668e6fb821ce1eb72c8109f50311d35a' then
    raise exception 'unreviewed predecessor: public.mark_vp_case_reviewed' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.mi1_get_automation_opportunities()'::regprocedure)
    is distinct from '041f67a037aa29e25aa1a7b3f55aa826' then
    raise exception 'unreviewed predecessor: public.mi1_get_automation_opportunities' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.open_member_case(uuid,text,text,text,date,text,date,text,text,boolean)'::regprocedure)
    is distinct from '61e27ec9b68fcd8fe11503b14d5a320d' then
    raise exception 'unreviewed predecessor: public.open_member_case' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.validate_member_operations_import(uuid,uuid)'::regprocedure)
    is distinct from '4e00274bad1a4d6a916ece6e7df5c6f9' then
    raise exception 'unreviewed predecessor: public.validate_member_operations_import' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_retaliation_adverse_events(date)'::regprocedure)
    is distinct from 'a92e9ba5ea387fb8ffc3f4825ea9ebdd' then
    raise exception 'unreviewed predecessor: private.casework_retaliation_adverse_events' using errcode='55000';
  end if;
end
$preflight$;

CREATE OR REPLACE FUNCTION private.casework_detect_retaliation_timing(p_organization_id uuid DEFAULT NULL::uuid, p_chapter_id text DEFAULT NULL::text, p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer;
  v_count integer;
  v_match record;
  v_flag public.casework_retaliation_flags%rowtype;
  v_case public.member_cases%rowtype;
  v_staff uuid;
  v_notified boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_limit := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_count := 0;
  for v_match in
    with adverse as (
      select * from private.casework_retaliation_adverse_events((select private.eastern_day()) - 400)
    ),
    matches as (
      select a.adverse_kind, a.adverse_id, a.adverse_on, a.severity,
        g.id as case_id, g.organization_id, g.user_id as member_id,
        (g.created_at at time zone 'America/New_York')::date as protected_on
      from adverse a
      join public.member_cases g
        on g.user_id = a.member_id and g.organization_id = a.organization_id
      where g.id is distinct from a.adverse_id
        and (a.is_discipline or a.linked_case_id = g.id)
        and (p_organization_id is null or g.organization_id = p_organization_id)
        and (p_chapter_id is null or g.chapter_id = p_chapter_id)
        and a.adverse_on >= (g.created_at at time zone 'America/New_York')::date
        and a.adverse_on <= (g.created_at at time zone 'America/New_York')::date
          + private.organization_limit(g.organization_id, 'limits.casework.retaliation_window_days')
        and private.organization_feature_enabled(g.organization_id, 'features.casework.retaliation_timing_detector')
        and not exists (
          select 1 from public.casework_retaliation_flags f
          where f.case_id = g.id and f.source = 'timing_detector' and f.source_id = a.adverse_id)
    )
    select m.*,
      (select pg_catalog.count(*)::integer from adverse p
        where p.member_id = m.member_id and p.organization_id = m.organization_id and p.is_discipline
          and p.adverse_on < m.protected_on
          and p.adverse_on >= m.protected_on - pg_catalog.make_interval(months =>
            private.organization_limit(m.organization_id, 'limits.casework.retaliation_prior_discipline_months'))
      ) as prior_count
    from matches m
    order by m.adverse_on, m.case_id, m.adverse_id
    limit v_limit
  loop
    select * into v_case from public.member_cases where id = v_match.case_id;
    continue when not found;
    insert into public.casework_retaliation_flags
      (case_id, organization_id, chapter_id, source, source_id, incident_on, ulp_window_days,
       adverse_kind, protected_activity_on, days_between, confidence, prior_discipline_count)
    values (v_case.id, v_case.organization_id, v_case.chapter_id, 'timing_detector', v_match.adverse_id,
      v_match.adverse_on, private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days'),
      v_match.adverse_kind, v_match.protected_on, v_match.adverse_on - v_match.protected_on,
      private.casework_retaliation_confidence(v_match.adverse_on - v_match.protected_on, v_match.severity),
      v_match.prior_count)
    on conflict (case_id, source, source_id) where source_id is not null do nothing
    returning * into v_flag;
    if v_flag.id is null then
      continue;
    end if;
    insert into public.casework_audit_events
      (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_flag.organization_id, v_flag.chapter_id, v_flag.case_id, null,
      'pattern_detected', 'retaliation_flag', v_flag.id,
      pg_catalog.jsonb_build_object('source', 'timing_detector', 'confidence', v_flag.confidence,
        'adverseKind', v_flag.adverse_kind));
    v_notified := false;
    for v_staff in
      select distinct u from unnest(array[v_case.steward_user_id, v_case.coordinator_user_id]) u
      where u is not null and u is distinct from v_case.user_id
    loop
      if private.casework_reminder_owner_can_read(v_staff, v_case.id) then
        perform private.notify_member(v_staff, 'casework.retaliation.staff_flagged', '{}'::jsonb, 'cases');
        v_notified := true;
      end if;
    end loop;
    if v_notified then
      perform private.notify_member(v_case.user_id, 'casework.retaliation.member_steward_notified', '{}'::jsonb, 'cases');
      update public.casework_retaliation_flags set staff_notified_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where id = v_flag.id;
    end if;
    v_count := v_count + 1;
    v_flag := null;
  end loop;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION private.casework_retaliation_flag_json(p_flag public.casework_retaliation_flags, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select pg_catalog.jsonb_build_object(
    'id', p_flag.id,
    'caseId', p_flag.case_id,
    'source', p_flag.source,
    'incidentOn', p_flag.incident_on,
    'ulpDeadline', case when p_enabled then p_flag.ulp_deadline end,
    'daysLeft', case when p_enabled then p_flag.ulp_deadline - (select private.eastern_day()) end,
    'windowDays', p_flag.ulp_window_days,
    'status', p_flag.status,
    'note', p_flag.note,
    'reviewedAt', p_flag.reviewed_at,
    'warningSentAt', p_flag.warning_sent_at,
    'urgentSentAt', p_flag.urgent_sent_at,
    'createdAt', p_flag.created_at,
    'adverseKind', p_flag.adverse_kind,
    'protectedActivityOn', p_flag.protected_activity_on,
    'daysBetween', p_flag.days_between,
    'confidence', p_flag.confidence,
    'priorDisciplineCount', p_flag.prior_discipline_count,
    'staffNotifiedAt', p_flag.staff_notified_at,
    'windowBasis', p_flag.ulp_window_basis,
    'windowSource', (
      select r.provenance
      from private.reference_ulp_limitation_periods r
      where p_flag.ulp_window_basis = 'jurisdiction:' || r.jurisdiction),
    'protectedActivityCategory', p_flag.protected_activity_category,
    'safetyDeadline', case when p_enabled then p_flag.safety_deadline end,
    'safetyDaysLeft', case when p_enabled then p_flag.safety_deadline - (select private.eastern_day()) end);
$function$;

CREATE OR REPLACE FUNCTION private.casework_sweep_ulp_deadlines(p_limit integer DEFAULT 200)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_limit integer;
  v_count integer;
  v_report record;
  v_flag public.casework_retaliation_flags%rowtype;
  v_case public.member_cases%rowtype;
  v_warning integer;
  v_critical integer;
  v_days integer;
  v_level text;
  v_staff uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_limit := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_count := 0;

  -- 1. A member's retaliation report attached to a case is a flagged incident.
  for v_report in
    select r.id, r.case_id, r.organization_id, r.chapter_id, r.incident_at
    from public.casework_retaliation_reports r
    where r.case_id is not null
      and r.status <> 'withdrawn'
      and private.member_case_is_live(r.case_id)
      and not exists (
        select 1 from public.casework_retaliation_flags f
        where f.source = 'member_report' and f.source_id = r.id)
      and private.organization_feature_enabled(r.organization_id, 'features.casework.ulp_deadline')
    order by r.created_at, r.id
    limit v_limit
  loop
    insert into public.casework_retaliation_flags
      (case_id, organization_id, chapter_id, source, source_id, incident_on, ulp_window_days)
    values (v_report.case_id, v_report.organization_id, v_report.chapter_id, 'member_report', v_report.id,
      (v_report.incident_at at time zone 'America/New_York')::date,
      private.organization_limit(v_report.organization_id, 'limits.casework.ulp_window_days'))
    on conflict (case_id, source, source_id) where source_id is not null do nothing
    returning * into v_flag;
    if v_flag.id is not null then
      insert into public.casework_audit_events
        (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
      values (v_flag.organization_id, v_flag.chapter_id, v_flag.case_id, null,
        'pattern_detected', 'retaliation_flag', v_flag.id,
        pg_catalog.jsonb_build_object('source', 'member_report', 'ulpWindowDays', v_flag.ulp_window_days));
      v_count := v_count + 1;
    end if;
    v_flag := null;
  end loop;

  -- 2. A withdrawn report withdraws its flag.
  with withdrawn as (
    select f.id from public.casework_retaliation_flags f
    join public.casework_retaliation_reports r on r.id = f.source_id
    where f.source = 'member_report' and r.status = 'withdrawn' and f.status <> 'withdrawn'
    order by f.id
    limit v_limit
    for update of f skip locked
  )
  update public.casework_retaliation_flags f
    set status = 'withdrawn', updated_at = pg_catalog.now()
    from withdrawn w where f.id = w.id;

  -- 3. Warn once at the first threshold and once more at the urgent one.
  for v_flag in
    select f.* from public.casework_retaliation_flags f
    where f.status in ('open', 'confirmed')
      and private.member_case_is_live(f.case_id)
      and f.ulp_deadline >= (select private.eastern_day())
      and f.urgent_sent_at is null
      and f.ulp_deadline <= (select private.eastern_day()) + 120
    order by f.ulp_deadline, f.id
    for update of f skip locked
    limit v_limit
  loop
    if not private.organization_feature_enabled(v_flag.organization_id, 'features.casework.ulp_deadline') then
      continue;
    end if;
    select t.warning_days, t.critical_days into v_warning, v_critical
    from private.casework_ulp_thresholds(v_flag.organization_id) t;
    v_days := v_flag.ulp_deadline - (select private.eastern_day());
    v_level := case
      when v_days <= v_critical then 'urgent'
      when v_days <= v_warning and v_flag.warning_sent_at is null then 'warning'
    end;
    continue when v_level is null;
    select * into v_case from public.member_cases where id = v_flag.case_id and learning_undone_at is null;
    continue when not found;
    perform private.notify_member(v_case.user_id, 'casework.ulp.member_' || v_level, '{}'::jsonb, 'deadlines');
    for v_staff in
      select distinct u from unnest(array[v_case.steward_user_id, v_case.coordinator_user_id]) u
      where u is not null and u is distinct from v_case.user_id
    loop
      if private.casework_reminder_owner_can_read(v_staff, v_case.id) then
        perform private.notify_member(v_staff, 'casework.ulp.staff_' || v_level, '{}'::jsonb, 'deadlines');
      end if;
    end loop;
    update public.casework_retaliation_flags
      set warning_sent_at = coalesce(warning_sent_at, pg_catalog.now()),
        urgent_sent_at = case when v_level = 'urgent' then pg_catalog.now() else urgent_sent_at end,
        updated_at = pg_catalog.now()
      where id = v_flag.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION private.cr108_candidate_count(p_organization_id uuid, p_definition_id uuid, p_trigger_kind text, p_threshold_days integer)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  total bigint := 0;
begin
  if exists(select 1 from public.organization_automation_definitions where id=p_definition_id and organization_id=p_organization_id and schema_version=2) then
    return (select count(*)::integer from private.automation_v2_candidates(p_definition_id));
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      select pg_catalog.count(*) into total
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= (select private.eastern_day()) - p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id::text
            and e.status in ('pending', 'created')
        );
    when 'case_deadline' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= (select private.eastern_day()) + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        );
    when 'unassigned_case' then
      select pg_catalog.count(*) into total
      from public.member_cases c
      where c.organization_id = p_organization_id
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        );
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
  return total::integer;
end;
$function$;

CREATE OR REPLACE FUNCTION private.cr108_candidate_sources(p_organization_id uuid, p_definition_id uuid, p_trigger_kind text, p_threshold_days integer, p_limit integer)
 RETURNS TABLE(source_kind text, source_id uuid, chapter_id text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_limit not between 1 and 50 then
    raise exception 'automation effect limit out of range' using errcode = '22023';
  end if;
  case p_trigger_kind
    when 'overdue_task' then
      return query
      select 'task'::text, t.id, t.chapter_id
      from public.chapter_tasks t
      join public.chapters ch on ch.id = t.chapter_id
      where ch.organization_id = p_organization_id
        and t.deleted_at is null
        and t.status <> 'done'
        and t.due_date is not null
        and t.due_date <= (select private.eastern_day()) - p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'task'
            and e.source_id = t.id::text
            and e.status in ('pending', 'created')
        )
      order by t.due_date, t.created_at, t.id
      limit p_limit;
    when 'case_deadline' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id and c.learning_undone_at is null
        and c.chapter_id is not null
        and c.status = 'active'
        and c.deadline is not null
        and c.deadline <= (select private.eastern_day()) + p_threshold_days
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.deadline, c.created_at, c.id
      limit p_limit;
    when 'unassigned_case' then
      return query
      select 'case'::text, c.id, c.chapter_id
      from public.member_cases c
      where c.organization_id = p_organization_id and c.learning_undone_at is null
        and c.chapter_id is not null
        and c.status = 'active'
        and c.steward_user_id is null
        and c.coordinator_user_id is null
        and not exists (
          select 1 from public.organization_automation_effects e
          where e.organization_id = p_organization_id
            and e.definition_id = p_definition_id
            and e.source_kind = 'case'
            and e.source_id = c.id::text
            and e.status in ('pending', 'created')
        )
      order by c.created_at, c.id
      limit p_limit;
    else
      raise exception 'unsupported automation trigger' using errcode = '22023';
  end case;
end;
$function$;

CREATE OR REPLACE FUNCTION private.workload_rebalancing(p_chapter text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with chapter_scope as materialized (
    select c.organization_id, private.caller_unit_limited_in_chapter(p_chapter) as unit_limited
    from public.chapters c
    where c.id = p_chapter
  ), steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    cross join chapter_scope
    where p.chapter_id = p_chapter
      -- A steward limited to some units sees itself, the chapter-wide and
      -- organization-wide stewards and the stewards whose unit or committee
      -- scope overlaps its own. An
      -- organization-wide staff grant wins over a unit scope left from before
      -- it was granted.
      and (not chapter_scope.unit_limited
        or p.id = (select auth.uid())
        or exists (
          select 1 from public.organization_role_grants broad
          join public.organization_memberships membership
            on membership.user_id = broad.user_id and membership.organization_id = broad.organization_id
           and membership.status = 'active'
          where broad.user_id = p.id and broad.organization_id = chapter_scope.organization_id
            and broad.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
        or not exists (
          select 1 from private.chapter_role_scopes steward_scope
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward')
        or exists (
          select 1 from private.chapter_role_scopes steward_scope
          join private.chapter_role_scopes caller_scope
            on caller_scope.user_id = (select auth.uid()) and caller_scope.chapter_id = p_chapter
           and (steward_scope.unit_id = caller_scope.unit_id or steward_scope.committee_id = caller_scope.committee_id)
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward'))
      and (
        (
          chapter_scope.organization_id is not null
          and private.organization_member_roles(
            p.id,
            chapter_scope.organization_id,
            p_chapter
          ) ? 'steward'
        )
        or (
          chapter_scope.organization_id is null
          and exists (
            select 1
            from public.member_roles legacy_role
            where legacy_role.user_id = p.id
              and legacy_role.role = 'steward'
              and (legacy_role.chapter_id is null or legacy_role.chapter_id = p_chapter)
          )
        )
      )
    order by p.full_name, p.id
    limit 50
  ), counts as (
    select s.steward_id, s.full_name,
      pg_catalog.count(c.id)::integer as active,
      pg_catalog.count(c.id) filter (
        where c.deadline between (select private.eastern_day()) and (select private.eastern_day()) + 6)::integer as due_soon,
      pg_catalog.count(c.id) filter (where c.deadline < (select private.eastern_day()))::integer as overdue
    from steward_roster s
    left join public.member_cases c on c.steward_user_id = s.steward_id
      and c.status = 'active' and c.learning_undone_at is null
      and not private.organization_is_platform(c.organization_id)
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
      -- and counts only the cases of members it may see.
      and (not (select scope.unit_limited from chapter_scope scope) or private.caller_may_see_member(c.user_id))
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
$function$;

CREATE OR REPLACE FUNCTION public.casework_flag_retaliation_incident(p_case_id uuid, p_incident_on date, p_note text DEFAULT NULL::text, p_protected_activity_category text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_case public.member_cases%rowtype;
  v_flag public.casework_retaliation_flags%rowtype;
  v_note text;
  v_category text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_access(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id for update;
  if not private.organization_feature_enabled(v_case.organization_id, 'features.casework.ulp_deadline') then
    raise exception 'ulp deadline tracking is turned off' using errcode = '55000';
  end if;
  v_note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_category := nullif(pg_catalog.btrim(coalesce(p_protected_activity_category, '')), '');
  if p_incident_on is null
     or p_incident_on > (select private.eastern_day())
     or p_incident_on < (select private.eastern_day()) - 3650
     or (v_note is not null and pg_catalog.char_length(v_note) not between 3 and 1000)
     or (v_category is not null and v_category not in ('safety_health', 'other')) then
    raise exception 'invalid retaliation incident' using errcode = '22023';
  end if;
  select * into v_flag from public.casework_retaliation_flags f
  where f.case_id = v_case.id and f.source = 'staff' and f.incident_on = p_incident_on
    and f.protected_activity_category is not distinct from v_category
    and f.status in ('open', 'confirmed')
  order by f.created_at limit 1;
  if found then
    return private.casework_retaliation_flag_json(v_flag, true);
  end if;
  insert into public.casework_retaliation_flags
    (case_id, organization_id, chapter_id, source, incident_on, ulp_window_days, note, created_by,
     protected_activity_category, safety_deadline)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, 'staff', p_incident_on,
    private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days'),
    v_note, (select auth.uid()),
    v_category, case when v_category = 'safety_health' then p_incident_on + 30 end)
  returning * into v_flag;
  insert into public.casework_audit_events
    (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
    'pattern_detected', 'retaliation_flag', v_flag.id,
    pg_catalog.jsonb_build_object('source', 'staff', 'ulpWindowDays', v_flag.ulp_window_days)
      || case when v_category is not null
        then pg_catalog.jsonb_build_object('protectedActivityCategory', v_category)
        else '{}'::jsonb end);
  return private.casework_retaliation_flag_json(v_flag, true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_list_ulp_deadlines(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  perform private.casework_require_mfa();
  return coalesce((
    select pg_catalog.jsonb_agg(row_data order by deadline, flag_id)
    from (
      select case when f.safety_deadline >= (select private.eastern_day()) and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end as deadline,
        f.id as flag_id,
        pg_catalog.jsonb_build_object(
          'flagId', f.id,
          'caseId', c.id,
          'reference', c.reference,
          'title', private.case_row_title(c.id),
          'topicShown', private.case_row_topic_shown(c.id),
          'caseType', c.case_type,
          'step', c.step,
          'source', f.source,
          'status', f.status,
          'incidentOn', f.incident_on,
          'ulpDeadline', f.ulp_deadline,
          'daysLeft', f.ulp_deadline - (select private.eastern_day()),
          'warningDays', t.warning_days,
          'criticalDays', t.critical_days,
          'protectedActivityCategory', f.protected_activity_category,
          'safetyDeadline', f.safety_deadline,
          'safetyRoute', private.casework_safety_retaliation_route(f.organization_id)) as row_data
      from public.casework_retaliation_flags f
      join public.member_cases c on c.id = f.case_id
      cross join lateral private.casework_ulp_thresholds(f.organization_id) t
      where f.status in ('open', 'confirmed')
        and f.organization_id = org
        and private.casework_staff_can_read(f.case_id)
        and private.organization_feature_enabled(f.organization_id, 'features.casework.ulp_deadline')
      order by case when f.safety_deadline >= (select private.eastern_day()) and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end, f.id
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) rows
  ), '[]'::jsonb);
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_member_case(p_title text, p_deadline date, p_case_type text, p_articles text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller         uuid := (select auth.uid());
  clean_title    text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles text := pg_catalog.btrim(coalesce(p_articles, ''));
  ref            text;
  new_case       uuid;
  attempts       integer := 0;
  akey           text;
  awarded        integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Bounds are raised, never truncated. A grievance is a legal document; a
  -- server that quietly clips the member's account of what happened at 200
  -- characters is worse than one that refuses and says why.
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;

  -- Mirrors the six <option value> entries in src/views/CasesView.jsx. The
  -- column has no CHECK, so before this the case_type was free text straight
  -- from the wire and the coordinator/steward case planes grouped on it.
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;

  -- Deadlines drive the member's Today screen and the steward deadline board.
  -- +/- 10 years is generous for a real contractual deadline and still keeps a
  -- fat-fingered year 0202 or 20260 out of every downstream sort.
  if p_deadline is not null
     and (p_deadline < (select private.eastern_day()) - 3650 or p_deadline > (select private.eastern_day()) + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- Bounded retry rather than a uniqueness pre-check: the check-then-insert
  -- race is exactly the duplicate this migration exists to remove. 5 attempts
  -- over a 100000-value space is astronomically more than enough; exhausting
  -- it means something is badly wrong and the caller gets a clean error rather
  -- than a hung loop.
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (user_id, reference, title, deadline, case_type, articles, step)
      values (caller, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake')
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  akey := 'case-' || ref;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'case')
  on conflict (user_id, action_key) do nothing;

  -- 'case' is capped at 3/week; read the real award, not the rule.
  select e.points into awarded
  from public.member_point_events e
  where e.user_id = caller and e.action_key = akey;

  perform private.learning_case_journal('case_create', new_case, null);
  return pg_catalog.jsonb_build_object(
    'caseId', new_case,
    'reference', ref,
    'awardedPoints', coalesce(awarded, 0));
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_advisor_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid := private.current_member_organization();
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
  mfa_ok boolean := false;
  mobile_org uuid;
  elevated_org uuid;
  caller_has_scopes boolean := false;
  staff_chapters text[] := '{}'::text[];
  coordinator_ids uuid[] := '{}'::uuid[];
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;
  -- A legacy advisor on an ownerless chapter resolves no organization; only a
  -- platform caller is refused, and only platform-owned rows leave the totals.
  if private.organization_is_platform(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The selected workspace, never a NULL legacy role row, sets the scope.
  -- Keep an explicitly selected ownerless legacy chapter isolated as well.
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null or not exists (
    select 1 from public.chapters chapter where chapter.id = caller_chapter
      and chapter.organization_id is not distinct from caller_org
  ) then
    raise exception 'organization or legacy chapter required' using errcode = '42501';
  end if;

  -- Caller-constant half of the staff case read. SQL CASE below stops before
  -- the coordinator and grievance branches when an elevated organization role
  -- already admits the row, which is the desk that was paying once per case.
  mfa_ok := private.mfa_satisfied();
  mobile_org := private.current_mobile_staff_organization();
  if mobile_org is not null
    and private.has_organization_role(mobile_org, array['advisor', 'admin', 'vp']) then
    elevated_org := mobile_org;
  end if;
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );
  select coalesce(pg_catalog.array_agg(chapter.id), '{}'::text[])
    into staff_chapters
  from public.chapters chapter
  where private.actor_has_chapter_staff_role(caller, chapter.id);
  select coalesce(pg_catalog.array_agg(visible.id), '{}'::uuid[])
    into coordinator_ids
  from private.staff_visible_member_ids('coordinator') visible(id);

  select pg_catalog.count(*)
  into members_covered
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter
    and not private.chapter_belongs_to_platform(p.chapter_id);

  with base as materialized (
    select c.status, c.deadline
    from public.member_cases c
    join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
    where c.organization_id is not distinct from caller_org
      and c.chapter_id = caller_chapter
      and not private.organization_is_platform(c.organization_id)
      and (
        (c.organization_id is null and caller_org is null)
        or (
          c.learning_undone_at is null
          and mfa_ok
          and case
            when c.user_id = caller then true
            when c.organization_id is not null
              and c.chapter_id is not null
              and case
                when c.user_id = caller then true
                when not caller_has_scopes
                  and not exists (
                    select 1 from private.case_identity_privacy privacy
                    where privacy.case_id = c.id
                  )
                  then true
                else private.actor_case_scope_and_identity_allowed(caller, c)
              end
              and case
                when c.chapter_id = any (staff_chapters)
                  and (
                    c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or c.user_id = any (coordinator_ids)
                  )
                  and (
                    not c.is_restricted
                    or c.steward_user_id = caller
                    or c.coordinator_user_id = caller
                    or (elevated_org is not null and c.organization_id = elevated_org)
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                when c.organization_id = caller_org
                  and private.actor_role_covers_member(caller, c.chapter_id, 'coordinator', c.user_id, true)
                  and (
                    not c.is_restricted
                    or c.coordinator_user_id = caller
                    or private.casework_actor_has_active_grant(c.id)
                  )
                  then true
                else false
              end
              then true
            when c.user_id <> caller
              and not c.is_restricted
              and c.organization_id = caller_org
              and coalesce((select policy.steward_grievances from private.chapter_access_policies policy where policy.chapter_id = c.chapter_id), true)
              and private.chapter_grievance_steward_scope(c.chapter_id, c.user_id)
              and private.member_case_row_visible(c)
              then true
            else false
          end
        )
      )
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < (select private.eastern_day()))
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- Resolve chapter and organization grants through the same live scope
  -- projection as the staff roster. Membership in a second tenant never
  -- transfers a steward grant there.
  if caller_org is not null then
    select pg_catalog.count(*) into steward_count
    from public.organization_memberships membership
    where membership.organization_id = caller_org and membership.status = 'active'
      and private.organization_member_roles(membership.user_id, caller_org, caller_chapter) @> '["steward"]'::jsonb;
  else
    -- No organization-wide NULL role can be attributed to an ownerless
    -- chapter. Its exact chapter steward remains valid, including #6369.
    select pg_catalog.count(distinct r.user_id) into steward_count
    from public.member_roles r
    where r.role = 'steward' and r.chapter_id = caller_chapter;
  end if;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.organization_id is not distinct from caller_org
    and (b.chapter_id = caller_chapter or (caller_org is not null and b.chapter_id is null))
    and b.campaign_state <> 'draft'
    and not private.organization_is_platform(b.organization_id)
  order by b.closes_at desc, b.id
  limit 1;

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_compass_case_context(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  include_narrative boolean;
  case_row public.member_cases%rowtype;
  facts jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if org is null
     or not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.case_help') then
    raise exception 'case help is turned off' using errcode = '55000';
  end if;
  include_narrative := private.organization_feature_enabled(org, 'features.ai_assistant.case_context_includes_narrative');

  select c.* into case_row
  from public.member_cases c
  where c.id = p_case_id
    and c.organization_id = org
    and private.casework_can_read(c.id);
  if case_row.id is null then
    raise exception 'case unavailable' using errcode = 'P0002';
  end if;

  facts := pg_catalog.jsonb_build_object(
    'status', case_row.status,
    'step', case_row.step,
    'openedDaysAgo', greatest(0, ((select private.eastern_day()) - (case_row.created_at at time zone 'America/New_York')::date)),
    'lastChangeDaysAgo', greatest(0, ((select private.eastern_day()) - (case_row.updated_at at time zone 'America/New_York')::date)),
    'caseDeadlineInDays', case when case_row.deadline is null then null else (case_row.deadline - (select private.eastern_day())) end,
    'deadlines', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', deadline.kind, 'status', deadline.status,
        'dueInDays', pg_catalog.floor(extract(epoch from (deadline.due_at - pg_catalog.now())) / 86400.0)::integer
      ) order by deadline.due_at)
      from (
        select d.kind, d.status, d.due_at
        from public.casework_deadlines d
        where d.case_id = case_row.id and d.status = 'active'
        order by d.due_at, d.id
        limit 10
      ) deadline
    ), '[]'::jsonb),
    'timeline', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('type', event.kind, 'daysAgo', event.days_ago) order by event.at)
      from (
        select kind, at, greatest(0, ((select private.eastern_day()) - (at at time zone 'America/New_York')::date)) as days_ago
        from (
          select 'step_advanced'::text as kind, t.created_at as at
          from public.casework_step_transitions t where t.case_id = case_row.id
          union all
          select 'case_note'::text, u.created_at from public.member_case_updates u where u.case_id = case_row.id and u.learning_undone_at is null
          union all
          select 'outcome_recorded'::text, o.updated_at from public.member_case_outcomes o where o.case_id = case_row.id
        ) events
        order by at desc
        limit 12
      ) event
    ), '[]'::jsonb)
  );

  if include_narrative then
    facts := facts || pg_catalog.jsonb_build_object(
      'title', case_row.title,
      'notes', coalesce((
        select pg_catalog.jsonb_agg(note.body order by note.created_at)
        from (
          select u.body, u.created_at from public.member_case_updates u
          where u.case_id = case_row.id and u.learning_undone_at is null
          order by u.created_at desc
          limit 3
        ) note
      ), '[]'::jsonb));
  end if;

  return pg_catalog.jsonb_build_object(
    'organization_id', org,
    'includesNarrative', include_narrative,
    'data', facts
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_compass_field_notes_packet_context(p_task_id uuid, p_note_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  caller uuid;
  org uuid;
  note_limit integer;
  task_row public.chapter_tasks%rowtype;
  notes jsonb;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  org := private.member_organization_for(caller);
  if org is null
     or not private.organization_feature_enabled(org, 'features.ai_assistant.enabled')
     or not private.organization_feature_enabled(org, 'features.ai_assistant.field_notes_packet') then
    raise exception 'field notes packets are turned off' using errcode = '55000';
  end if;
  if p_note_ids is null or pg_catalog.array_length(p_note_ids, 1) is null then
    raise exception 'select at least one field note' using errcode = '22023';
  end if;
  note_limit := private.organization_limit(org, 'limits.ai_assistant.packet_notes');

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p
    on p.id = caller
   and p.chapter_id = t.chapter_id
  where t.id = p_task_id
    and t.deleted_at is null;
  if task_row.id is null then
    raise exception 'task unavailable' using errcode = 'P0002';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'daysAgo', note.days_ago, 'body', note.body) order by note.created_at), '[]'::jsonb)
    into notes
  from (
    select c.body, c.created_at,
           greatest(0, ((select private.eastern_day()) - (c.created_at at time zone 'America/New_York')::date)) as days_ago
    from public.chapter_task_comments c
    where c.task_id = task_row.id
      and c.chapter_id = task_row.chapter_id
      and c.id = any(p_note_ids)
    order by c.created_at, c.id
    limit note_limit
  ) note;

  return pg_catalog.jsonb_build_object(
    'organization_id', org,
    'noteLimit', note_limit,
    'data', pg_catalog.jsonb_build_object('title', task_row.title, 'notes', notes)
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_coordinator_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
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
  if private.organization_is_platform(private.current_member_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Caller-only and chapter/organization authority is projected once.
  with coordinator_members as materialized (
    select private.staff_visible_member_ids('coordinator') as id
  ),
  active_grants as materialized (
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = (select auth.uid())
      and g.revoked_at is null
  ),
  union_organizations as materialized (
    select o.id from public.organizations o
    where private.organization_is_union(o.id)
  ),
  tenant as materialized (
    select c as case_row, c.id, c.user_id, c.organization_id, c.chapter_id,
      c.steward_user_id, c.coordinator_user_id, c.is_restricted,
      c.status, c.step, c.articles, c.deadline
    from public.member_cases c
    where (select private.mfa_satisfied())
      and c.organization_id in (select id from union_organizations)
      and c.chapter_id is not null
      and (
        (c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter()))
        or (c.id in (select case_id from active_grants)
          and c.user_id in (select id from coordinator_members))
      )
  ),
  chapter_scope as materialized (
    select chapters.chapter_id,
      private.actor_has_chapter_staff_role(caller, chapters.chapter_id) as staff,
      coalesce((select p.steward_grievances from private.chapter_access_policies p
        where p.chapter_id = chapters.chapter_id), true) as steward_grievances
    from (select distinct chapter_id from tenant) chapters
  ),
  organization_scope as materialized (
    select organizations.organization_id,
      private.has_organization_role(organizations.organization_id, array['advisor','admin','vp']) as oversight
    from (select distinct organization_id from tenant) organizations
  ),
  access as materialized (
    select t.*, chapter_scope.steward_grievances,
      (chapter_scope.staff
        and (t.steward_user_id = caller or t.coordinator_user_id = caller
          or t.user_id in (select id from coordinator_members) or organization_scope.oversight)
        and (not t.is_restricted or t.steward_user_id = caller or t.coordinator_user_id = caller
          or organization_scope.oversight or t.id in (select case_id from active_grants))) as direct_access
    from tenant t
    join chapter_scope on chapter_scope.chapter_id = t.chapter_id
    join organization_scope on organization_scope.organization_id = t.organization_id
  ),
  base as materialized (
    select t.id, t.status, t.step, t.articles, t.deadline
    from access t
    where private.case_scope_and_identity_allowed(t.case_row)
      and case when t.direct_access then true else (
        t.organization_id = (select private.current_member_organization())
        and (
          (private.actor_role_covers_member(caller, t.chapter_id, 'coordinator', t.user_id, true)
            and (not t.is_restricted or t.coordinator_user_id = caller
              or t.id in (select case_id from active_grants)))
          or (t.user_id <> caller and not t.is_restricted and t.steward_grievances
            and private.chapter_grievance_steward_scope(t.chapter_id, t.user_id))
        )
      ) end
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline between (select private.eastern_day()) and (select private.eastern_day()) + 6),
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
$function$;

CREATE OR REPLACE FUNCTION public.get_my_case_ulp_summary()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', s.case_id,
      'ulpDeadline', case when s.enabled then s.ulp_deadline end,
      'retaliationFlagged', true,
      'stewardNotified', s.steward_notified,
      'ulpWarningDays', s.warning_days,
      'ulpCriticalDays', s.critical_days,
      'ulpSource', case when s.enabled then (
        select r.provenance
        from (
          select d.ulp_window_basis
          from public.casework_retaliation_flags d
          where d.case_id = s.case_id and d.status in ('open', 'confirmed')
            and d.ulp_deadline = s.ulp_deadline
          order by d.created_at, d.id
          limit 1
        ) b
        join private.reference_ulp_limitation_periods r
          on b.ulp_window_basis = 'jurisdiction:' || r.jurisdiction) end)
      || case when s.enabled and s.safety_deadline is not null
        then pg_catalog.jsonb_build_object(
          'safetyDeadline', s.safety_deadline,
          'safetyRoute', private.casework_safety_retaliation_route(s.organization_id))
        else '{}'::jsonb end
      order by s.ulp_deadline, s.case_id)
    from (
      select c.id as case_id,
        c.organization_id,
        private.organization_feature_enabled(c.organization_id, 'features.casework.ulp_deadline') as enabled,
        coalesce(
          min(f.ulp_deadline) filter (where f.ulp_deadline >= (select private.eastern_day())),
          max(f.ulp_deadline)) as ulp_deadline,
        coalesce(
          min(f.safety_deadline) filter (where f.safety_deadline >= (select private.eastern_day())),
          max(f.safety_deadline)) as safety_deadline,
        bool_or(f.staff_notified_at is not null) as steward_notified,
        t.warning_days,
        t.critical_days
      from public.member_cases c
      join public.casework_retaliation_flags f on f.case_id = c.id and f.status in ('open', 'confirmed')
      cross join lateral private.casework_ulp_thresholds(c.organization_id) t
      where c.user_id = caller and c.learning_undone_at is null
      group by c.id, c.organization_id, t.warning_days, t.critical_days
    ) s
  ), '[]'::jsonb);
end;

end;
$function$;

CREATE OR REPLACE FUNCTION public.get_vp_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
  leadership_open boolean := false;
  caller_has_scopes boolean := false;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  -- Fail closed: no selected organization or chapter means no tenant to
  -- report on, never a database-wide scan.
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  if caller_org is null or caller_chapter is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- The leadership read's caller-constant gates, once for this statement. The
  -- outer reads already require the case organization and chapter to be the
  -- caller's, so the role and staff-factor checks do not vary per case. A
  -- closed gate is zero grievances and an empty attention list.
  leadership_open := private.mfa_satisfied()
    and not private.member_pin_session_restricted()
    and (not private.staff_mfa_required(caller_org) or private.has_second_factor(caller))
    and (
      private.member_has_chapter_role(caller_chapter, array['admin', 'vp'])
      or private.has_organization_role(caller_org, array['admin', 'vp'])
    );
  caller_has_scopes := exists (
    select 1 from (select * from private.steward_assignment_scopes(caller,null) where not legacy_chapter_coverage) scope_row
    where scope_row.user_id = caller
  );

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
  where p.chapter_id = caller_chapter;

  if leadership_open then
    select pg_catalog.count(*)
    into active_grievances
    from public.member_cases c
    where c.status = 'active'
      and c.organization_id is not null
      and c.learning_undone_at is null
      and case
        when c.user_id = caller then true
        when not caller_has_scopes
          and not exists (
            select 1 from private.case_identity_privacy privacy
            where privacy.case_id = c.id
          )
          then true
        else private.actor_case_scope_and_identity_allowed(caller, c)
      end
      and c.organization_id = caller_org
      and c.chapter_id = caller_chapter;

    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id,
        'reference', s.reference,
        'title', s.title,
        'step', s.step,
        'deadline', s.deadline,
        'memberName', s.member_name) order by s.deadline, s.id), '[]'::jsonb)
    into attention
    from (
      select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
      from public.member_cases c
      join (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p on p.id = c.user_id
      where c.status = 'active'
        and c.deadline is not null
        and c.deadline < (select private.eastern_day())
        and c.organization_id is not null
        and c.chapter_id is not null
        and c.learning_undone_at is null
        and case
          when c.user_id = caller then true
          when not caller_has_scopes
            and not exists (
              select 1 from private.case_identity_privacy privacy
              where privacy.case_id = c.id
            )
            then true
          else private.actor_case_scope_and_identity_allowed(caller, c)
        end
        and c.organization_id = caller_org
        and c.chapter_id = caller_chapter
      order by c.deadline
      limit 6
    ) s;
  else
    active_grievances := 0;
    attention := '[]'::jsonb;
  end if;

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_choices
    where ballot_id = b.id
  ) v on true
  where (b.active = false or b.closes_at < pg_catalog.now())
    and b.campaign_state <> 'draft'
    and b.organization_id = caller_org
    and (b.chapter_id is null or b.chapter_id = caller_chapter)
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary) order by e.starts_at, e.id), '[]'::jsonb)
  into upcoming
  from (
    select ev.id, ev.title, ev.starts_at, ev.location, ev.summary
    from public.member_events ev
    join public.chapters event_chapter
      on event_chapter.id = ev.chapter_id
     and event_chapter.organization_id = caller_org
    where ev.starts_at >= pg_catalog.now()
      and ev.cancelled_at is null
      and private.member_event_scope_allows(
        (select private.member_event_caller_scope()),
        ev.chapter_id,
        ev.is_public,
        ev.is_public_across_agencies)
    order by ev.starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
      and campaign_state <> 'draft'
      and organization_id = caller_org
      and (chapter_id is null or chapter_id = caller_chapter)
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
      where p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_coordinator_cases(p_focus text DEFAULT 'all'::text, p_after_deadline date DEFAULT NULL::date, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 200)
 RETURNS SETOF public.member_cases
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 200), 1), 200);
begin
  if (select auth.uid()) is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if p_focus not in ('all', 'due', 'arbitration') then
    raise exception 'unknown focus' using errcode = '22023';
  end if;

  -- Tenant bound copied from private.casework_dashboard_open_cases
  -- (20260917142000) / public.get_coordinator_kpis (PR #2171) and MUST stay
  -- in sync with both. Applied before the remaining focus and keyset
  -- predicates so the RLS-visible read visits another chapter's case only
  -- when the caller holds an active grant for it and staff_can_see_user
  -- admits them (20261022053100). Due window is the Eastern day + 6: seven days
  -- inclusive of today (#8568).
  return query
  select c.*
  from public.member_cases c
  where c.status = 'active'
    and c.organization_id is not null
    and c.chapter_id is not null
    and (
      (c.organization_id = (select private.current_member_organization())
        and c.chapter_id = (select private.current_member_chapter()))
      or (
        c.id in (
          select g.case_id
          from public.casework_access_grants g
          where g.grantee_user_id = (select auth.uid())
            and g.revoked_at is null
        )
        and public.staff_can_see_user(c.user_id, 'coordinator')
        and private.casework_staff_can_access(c.id)
      )
    )
    and (p_focus <> 'due' or (c.deadline is not null
      and c.deadline between ((pg_catalog.now() at time zone 'America/New_York'))::date and ((pg_catalog.now() at time zone 'America/New_York'))::date + 6))
    and (p_focus <> 'arbitration' or (c.step ~* 'arb' or c.step = 'Step 4'))
    and (
      p_after_id is null
      or (p_after_deadline is not null and (
        c.deadline > p_after_deadline
        or (c.deadline = p_after_deadline and c.id > p_after_id)
        or c.deadline is null))
      or (p_after_deadline is null and c.deadline is null and c.id > p_after_id)
    )
  order by c.deadline asc nulls last, c.id asc
  limit page_limit;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_vp_case_reviewed(p_case_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  -- #8311: the selected workspace, never the first legacy role row.
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  result_row public.member_vp_case_reviews%rowtype;
begin
  if caller is null or not public.member_has_role(array['vp']) or not (select private.mfa_satisfied()) then
    raise exception 'president role with MFA required' using errcode = '42501';
  end if;

  -- The case's own stored chapter, never its owner's selected one, which
  -- the owner can switch after the case was opened.
  if caller_chapter is null or not exists (
    select 1
    from public.member_cases c
    join public.chapters ch on ch.id = c.chapter_id
    where c.id = p_case_id and c.learning_undone_at is null
      and c.chapter_id = caller_chapter
      and c.organization_id is not distinct from caller_org
      and ch.organization_id is not distinct from caller_org
      and c.status = 'active'
      and c.deadline is not null
      and c.deadline < (select private.eastern_day())
  ) then
    raise exception 'attention case not found' using errcode = 'P0002';
  end if;

  insert into public.member_vp_case_reviews (chapter_id, case_id, reviewed_by)
  values (caller_chapter, p_case_id, caller)
  on conflict (chapter_id, case_id) do nothing;

  select * into strict result_row
  from public.member_vp_case_reviews r
  where r.chapter_id = caller_chapter and r.case_id = p_case_id;

  return pg_catalog.jsonb_build_object(
    'caseId', result_row.case_id,
    'reviewedAt', result_row.reviewed_at,
    'reviewedBy', result_row.reviewed_by);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mi1_get_automation_opportunities()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    select 'overdue_task', count(*)::integer, 1 from visible_tasks where due_date < (select private.eastern_day()) and status in ('backlog','to_do','in_progress','needs_review')
    union all select 'task_due', count(*)::integer, 3 from visible_tasks where due_date between (select private.eastern_day()) and (select private.eastern_day()) + 3 and status in ('backlog','to_do','in_progress','needs_review')
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

CREATE OR REPLACE FUNCTION public.open_member_case(p_member_id uuid, p_title text, p_case_type text, p_articles text, p_deadline date, p_description text, p_incident_date date, p_remedy_sought text, p_filing_status text, p_assign_self boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid;
  clean_title text;
  clean_articles text;
  clean_description text;
  clean_remedy text;
  steward_scope boolean;
  assign boolean;
  steward_label text;
  actor_label text;
  created jsonb;
  ref text;
  new_case uuid;
  attempts integer;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  clean_description := nullif(pg_catalog.btrim(coalesce(p_description, '')), '');
  clean_remedy := nullif(pg_catalog.btrim(coalesce(p_remedy_sought, '')), '');
  -- Bounds are raised, never clipped, as in public.create_member_case.
  if pg_catalog.char_length(clean_description) > 10000 then
    raise exception 'case description too long (10000 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_remedy) > 2000 then
    raise exception 'remedy sought too long (2000 characters max)' using errcode = '22023';
  end if;
  if p_filing_status is not null and p_filing_status not in ('informal', 'filed') then
    raise exception 'invalid filing status' using errcode = '22023';
  end if;
  if p_incident_date is not null
     and (p_incident_date < (select private.eastern_day()) - 3650 or p_incident_date > (select private.eastern_day()) + 1) then
    raise exception 'incident date out of range' using errcode = '22023';
  end if;

  -- The member's own intake keeps every rule, reference and award of
  -- public.create_member_case and adds the details to that same row.
  if p_member_id is null or p_member_id = caller then
    created := public.create_member_case(p_title, p_deadline, p_case_type, p_articles);
    update public.member_cases set
      description = clean_description,
      incident_date = p_incident_date,
      remedy_sought = clean_remedy,
      filing_status = p_filing_status
    where id = (created->>'caseId')::uuid and user_id = caller;
    -- The details are a later step on the case create_member_case journalled,
    -- so undoing the case undoes both, newest first.
    perform private.learning_case_journal('case_edit', (created->>'caseId')::uuid, null);
    return created || pg_catalog.jsonb_build_object('assigned', false);
  end if;

  -- A case opened for another member: staff in the member's scope only.
  if not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'steward, coordinator or admin role required' using errcode = '42501';
  end if;
  steward_scope := private.chapter_case_intake_role_allows(p_member_id, 'steward');
  if not (steward_scope
          or private.chapter_case_intake_role_allows(p_member_id, 'coordinator')
          or private.chapter_case_intake_role_allows(p_member_id, 'admin')) then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  clean_title := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles := pg_catalog.btrim(coalesce(p_articles, ''));
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;
  if p_deadline is not null
     and (p_deadline < (select private.eastern_day()) - 3650 or p_deadline > (select private.eastern_day()) + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- A steward who opens the case is its steward, so it is on their caseload.
  assign := coalesce(p_assign_self, true) and steward_scope;
  if assign then
    select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  end if;

  attempts := 0;
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(pg_catalog.now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (
        user_id, reference, title, deadline, case_type, articles, step,
        description, incident_date, remedy_sought, filing_status,
        steward_user_id, steward_name, assigned_at)
      values (
        p_member_id, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake',
        clean_description, p_incident_date, clean_remedy, p_filing_status,
        case when assign then caller end,
        case when assign then coalesce(steward_label, 'Steward') end,
        case when assign then pg_catalog.now() end)
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  if assign then
    actor_label := coalesce(steward_label, 'Staff member');
    insert into public.member_case_assignment_audit
      (case_id, actor_id, actor_name, before_assignment, after_assignment)
    values (new_case, caller, actor_label,
      pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
        'coordinatorUserId', null, 'coordinatorName', null),
      pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', coalesce(steward_label, 'Steward'),
        'coordinatorUserId', null, 'coordinatorName', null));
  end if;

  perform private.learning_case_journal('case_create', new_case, null);
  return pg_catalog.jsonb_build_object('caseId', new_case, 'reference', ref, 'assigned', assign);
end;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.validate_member_operations_import(p_batch_id uuid, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.require_member_operations_admin();
  batch public.organization_import_batches%rowtype;
  row_item public.organization_import_rows%rowtype;
  errors jsonb;
  member_id uuid;
  raw_member_id text;
  raw_hire_date text;
  raw_deadline text;
  valid_rows integer;
  invalid_rows integer;
  request_payload jsonb := pg_catalog.jsonb_build_object('batchId', p_batch_id);
  prior jsonb;
  result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'validate_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  select * into batch from public.organization_import_batches where id = p_batch_id and organization_id = org for update;
  if not found or batch.state in ('committed','discarded') then raise exception 'batch is not editable' using errcode = '55000'; end if;
  for row_item in select * from public.organization_import_rows row where row.batch_id = batch.id order by row.row_number
  loop
    errors := '[]'::jsonb;
    member_id := null;
    raw_member_id := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'member_id', '')), '');
    if raw_member_id is not null then
      if raw_member_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        member_id := raw_member_id::uuid;
      else
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'field','member_id','code','invalid_uuid','message','Member ID must be a UUID'
        ));
      end if;
    end if;
    if member_id is null and coalesce(row_item.normalized_data ->> 'email', row_item.normalized_data ->> 'member_email') is not null then
      select membership.user_id into member_id
      from public.organization_memberships membership join auth.users user_row on user_row.id = membership.user_id
      where membership.organization_id = org and membership.status = 'active'
        and pg_catalog.lower(user_row.email) = pg_catalog.lower(coalesce(row_item.normalized_data ->> 'email', row_item.normalized_data ->> 'member_email'))
      limit 1;
    end if;
    if member_id is null or not exists (select 1 from public.organization_memberships membership
      where membership.organization_id = org and membership.user_id = member_id and membership.status = 'active') then
      errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member','code','member_not_found','message','Existing active member not found'));
    end if;
    if batch.kind = 'member' then
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'member_number', '')) > 80 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member_number','code','too_long','message','Member number is limited to 80 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'job_title', '')) > 160 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','job_title','code','too_long','message','Job title is limited to 160 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'department', '')) > 160 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','department','code','too_long','message','Department is limited to 160 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'work_location', '')) > 200 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','work_location','code','too_long','message','Work location is limited to 200 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'membership_class', '')) > 120 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','membership_class','code','too_long','message','Membership classification is limited to 120 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'administrative_notes', '')) > 4000 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','administrative_notes','code','too_long','message','Administrative notes are limited to 4,000 characters'));
      end if;
      if nullif(row_item.normalized_data ->> 'preferred_language', '') is not null
         and row_item.normalized_data ->> 'preferred_language' not in ('en','es') then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','preferred_language','code','invalid_language','message','Preferred language must be en or es'));
      end if;
      raw_hire_date := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'hire_date', '')), '');
      if raw_hire_date is not null then
        begin
          perform raw_hire_date::date;
        exception when others then
          errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','hire_date','code','invalid_date','message','Hire date must be a valid date'));
        end;
      end if;
      if nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'member_number', '')), '') is not null and (
        exists (
          select 1 from public.organization_import_rows duplicate_row
          where duplicate_row.batch_id = batch.id and duplicate_row.row_number <> row_item.row_number
            and pg_catalog.lower(pg_catalog.btrim(duplicate_row.normalized_data ->> 'member_number'))
              = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'))
        ) or exists (
          select 1 from public.organization_member_operational_profiles profile
          where profile.organization_id = org and profile.member_user_id is distinct from member_id
            and pg_catalog.lower(profile.member_number) = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'))
        )
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','member_number','code','duplicate','message','Member number must be unique'));
      end if;
    else
      if pg_catalog.char_length(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'title', ''))) not between 1 and 200 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','title','code','invalid_title','message','Title is required and limited to 200 characters'));
      end if;
      if pg_catalog.char_length(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'reference', ''))) not between 1 and 120 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','reference','code','invalid_reference','message','Reference is required and limited to 120 characters'));
      end if;
      if pg_catalog.char_length(coalesce(row_item.normalized_data ->> 'articles', '')) > 500 then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','articles','code','too_long','message','Articles are limited to 500 characters'));
      end if;
      if not exists (select 1 from public.chapters chapter where chapter.id = row_item.normalized_data ->> 'chapter_id' and chapter.organization_id = org) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','chapter_id','code','chapter_not_found','message','Chapter not found'));
      end if;
      if member_id is not null and not exists (
        select 1
        from public.member_profiles profile
        where profile.id = member_id
          and profile.chapter_id = row_item.normalized_data ->> 'chapter_id'
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'field','chapter_id','code','case_owner_chapter_mismatch',
          'message','Grievance chapter must match the member case-owning chapter'
        ));
      end if;
      raw_deadline := nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'deadline', '')), '');
      if raw_deadline is not null then
        begin
          perform raw_deadline::date;
          if raw_deadline::date < (select private.eastern_day()) - 3650 or raw_deadline::date > (select private.eastern_day()) + 3650 then
            errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','deadline','code','out_of_range','message','Deadline must be within 10 years'));
          end if;
        exception when others then
          errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','deadline','code','invalid_date','message','Deadline must be a valid date'));
        end;
      end if;
      if member_id is not null and nullif(pg_catalog.btrim(coalesce(row_item.normalized_data ->> 'reference', '')), '') is not null and (
        exists (
          select 1 from public.organization_import_rows duplicate_row
          where duplicate_row.batch_id = batch.id and duplicate_row.row_number <> row_item.row_number
            and duplicate_row.normalized_data ->> '_resolved_member_id' = member_id::text
            and pg_catalog.lower(pg_catalog.btrim(duplicate_row.normalized_data ->> 'reference'))
              = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'reference'))
        ) or exists (
          select 1 from public.member_cases existing_case
          where existing_case.user_id = member_id
            and pg_catalog.lower(existing_case.reference) = pg_catalog.lower(pg_catalog.btrim(row_item.normalized_data ->> 'reference'))
        )
      ) then
        errors := errors || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('field','reference','code','duplicate','message','Reference already exists for this member'));
      end if;
    end if;
    update public.organization_import_rows set normalized_data = normalized_data || pg_catalog.jsonb_build_object('_resolved_member_id', member_id),
      validation_errors = errors where batch_id = batch.id and row_number = row_item.row_number;
  end loop;
  select pg_catalog.count(*) filter (where pg_catalog.jsonb_array_length(row.validation_errors) = 0),
    pg_catalog.count(*) filter (where pg_catalog.jsonb_array_length(row.validation_errors) > 0)
  into valid_rows, invalid_rows from public.organization_import_rows row where row.batch_id = batch.id;
  update public.organization_import_batches set state = 'validated', valid_count = valid_rows, error_count = invalid_rows,
    validated_at = pg_catalog.now() where id = batch.id;
  result := pg_catalog.jsonb_build_object(
    'id', batch.id, 'state', 'validated', 'validCount', valid_rows, 'errorCount', invalid_rows
  );
  perform private.member_operations_store_receipt(
    org, 'validate_member_operations_import', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

create or replace function private.casework_retaliation_adverse_events(p_since date)
returns table (
  adverse_kind text,
  adverse_id uuid,
  organization_id uuid,
  member_id uuid,
  adverse_on date,
  linked_case_id uuid,
  is_discipline boolean,
  severity numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
  select 'management_entry', e.id, e.organization_id, c.user_id,
    (e.occurred_at at time zone 'America/New_York')::date, e.case_id,
    pg_catalog.lower(pg_catalog.btrim(e.category)) = 'discipline',
    private.casework_retaliation_severity(e.summary)
  from public.casework_management_entries e
  join public.member_cases c on c.id = e.case_id and c.learning_undone_at is null
  where e.case_id is not null
    and pg_catalog.lower(pg_catalog.btrim(e.category)) in ('discipline', 'retaliation')
    and e.occurred_at >= (p_since::timestamp at time zone 'America/New_York')
  union all
  select 'discipline_case', d.id, d.organization_id, d.user_id,
    coalesce(
      (select (f.answers ->> 'incident_date')::date from public.member_forms f
        where f.case_id = d.id and f.user_id = d.user_id
          and coalesce(f.answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
        order by f.created_at, f.id limit 1),
      (d.created_at at time zone 'America/New_York')::date),
    null::uuid, true, private.casework_retaliation_severity(d.title)
  from public.member_cases d
  where d.organization_id is not null and d.learning_undone_at is null
    and pg_catalog.lower(pg_catalog.btrim(d.case_type)) = 'discipline'
    and d.created_at >= ((p_since::timestamp - interval '1 year') at time zone 'America/New_York');
$function$;

-- #8868 (stored rows: BUG-UG-STORED-RETALIATION-FLAGS-KEEP-A-UTC-DAY-DEADLINE-20261117,
-- #9003): member-report and timing-detector flags whose incident fell between 7 PM (8 PM in
-- daylight time) and midnight Eastern were dated on the UTC day, so each filing deadline is a day
-- late. This file was applied nowhere when the correction was added (history 873 on both hosted
-- databases), so it corrects them here, after the new bodies, in the same transaction: no writer
-- can store another such row in between. For each flag dated that way:
--   * incident_on moves to the Eastern date of its source (a report's incident, a management
--     entry, or a discipline case's opening when no form incident date was typed);
--   * ulp_window_days is recalculated from the stored ulp_window_basis, as the insert trigger
--     private.casework_ulp_apply_jurisdiction() computes it: a jurisdiction counted in months
--     spans the months from the new date; organization_limit keeps its days (they set the window,
--     and the setting may have changed since). The generated ulp_deadline follows;
--   * safety_deadline, where set, becomes the new date + 30 (its check constraint);
--   * on a timing-detector flag, protected_activity_on moves to the Eastern date of the grievance
--     when it was dated on the UTC day, and days_between and confidence are recomputed;
--   * one bulk_updated audit event holds the old and new values.
-- Status, review fields, note, notification stamps, basis, category, prior discipline count,
-- source and keys never change, and no row is deleted. A timing flag whose corrected
-- days_between would be negative (the adverse event came before the protected activity on the
-- Eastern calendar) stops the migration for a person to decide. A second run finds nothing.
-- Output is counts only.
do $flag_correction$
declare
  v_flag record;
  v_period private.reference_ulp_limitation_periods%rowtype;
  v_window integer;
  v_protected date;
  v_days integer;
  v_corrected public.casework_retaliation_flags%rowtype;
  v_member_report integer := 0;
  v_management_entry integer := 0;
  v_discipline_case integer := 0;
begin
  -- The case-graph gate both flag producers take first (ledger 427), in its own statement, so a
  -- producer's flag still uncommitted when this block starts is committed and seen below.
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  for v_flag in
    select f.*, misdated.eastern_on, misdated.severity,
      (g.created_at at time zone 'UTC')::date as protected_utc_on,
      (g.created_at at time zone 'America/New_York')::date as protected_eastern_on
    from public.casework_retaliation_flags f
    join (
      select f.id, (r.incident_at at time zone 'America/New_York')::date as eastern_on, null::numeric as severity
      from public.casework_retaliation_flags f
      join public.casework_retaliation_reports r on r.id = f.source_id
      where f.source = 'member_report'
        and f.incident_on = (r.incident_at at time zone 'UTC')::date
        and f.incident_on <> (r.incident_at at time zone 'America/New_York')::date
      union all
      select f.id, (e.occurred_at at time zone 'America/New_York')::date, private.casework_retaliation_severity(e.summary)
      from public.casework_retaliation_flags f
      join public.casework_management_entries e on e.id = f.source_id
      where f.source = 'timing_detector' and f.adverse_kind = 'management_entry'
        and f.incident_on = (e.occurred_at at time zone 'UTC')::date
        and f.incident_on <> (e.occurred_at at time zone 'America/New_York')::date
      union all
      select f.id, (d.created_at at time zone 'America/New_York')::date, private.casework_retaliation_severity(d.title)
      from public.casework_retaliation_flags f
      join public.member_cases d on d.id = f.source_id
      where f.source = 'timing_detector' and f.adverse_kind = 'discipline_case'
        and f.incident_on = (d.created_at at time zone 'UTC')::date
        and f.incident_on <> (d.created_at at time zone 'America/New_York')::date
        and not exists (
          select 1 from public.member_forms m
          where m.case_id = d.id and m.user_id = d.user_id
            and coalesce(m.answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$')
    ) misdated on misdated.id = f.id
    left join public.member_cases g on g.id = f.case_id and f.source = 'timing_detector'
    order by f.id
    for update of f
  loop
    v_window := v_flag.ulp_window_days;
    if v_flag.ulp_window_basis like 'jurisdiction:%' then
      select * into v_period from private.reference_ulp_limitation_periods r
        where 'jurisdiction:' || r.jurisdiction = v_flag.ulp_window_basis;
      if not found then
        raise exception '#8868: a stored flag''s jurisdiction window has no sourced period; a person must correct it'
          using errcode = '55000';
      end if;
      v_window := case v_period.period_unit
        when 'month' then ((v_flag.eastern_on + pg_catalog.make_interval(months => v_period.period_value))::date - v_flag.eastern_on)
        else v_period.period_value
      end;
    end if;
    v_protected := v_flag.protected_activity_on;
    v_days := v_flag.days_between;
    if v_flag.source = 'timing_detector' then
      if v_flag.protected_activity_on = v_flag.protected_utc_on
         and v_flag.protected_activity_on <> v_flag.protected_eastern_on then
        v_protected := v_flag.protected_eastern_on;
      end if;
      v_days := v_flag.eastern_on - v_protected;
      if v_days < 0 then
        raise exception '#8868: a stored timing-detector flag would come before its protected activity on the Eastern calendar; a person must decide it'
          using errcode = '55000';
      end if;
    end if;
    update public.casework_retaliation_flags f
       set incident_on = v_flag.eastern_on,
           ulp_window_days = v_window,
           safety_deadline = case when f.safety_deadline is null then null else v_flag.eastern_on + 30 end,
           protected_activity_on = v_protected,
           days_between = v_days,
           confidence = case when f.source = 'timing_detector'
             then private.casework_retaliation_confidence(v_days, v_flag.severity) else f.confidence end,
           updated_at = pg_catalog.now()
     where f.id = v_flag.id
    returning f.* into v_corrected;
    insert into public.casework_audit_events
      (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (v_corrected.organization_id, v_corrected.chapter_id, v_corrected.case_id, null,
      'bulk_updated', 'retaliation_flag', v_corrected.id,
      pg_catalog.jsonb_build_object('change', 'incident date moved to the Eastern calendar (#8868)',
        'source', v_corrected.source, 'adverseKind', v_corrected.adverse_kind,
        'previousIncidentOn', v_flag.incident_on, 'incidentOn', v_corrected.incident_on,
        'previousUlpWindowDays', v_flag.ulp_window_days, 'ulpWindowDays', v_corrected.ulp_window_days,
        'previousUlpDeadline', v_flag.ulp_deadline, 'ulpDeadline', v_corrected.ulp_deadline,
        'previousSafetyDeadline', v_flag.safety_deadline, 'safetyDeadline', v_corrected.safety_deadline,
        'previousProtectedActivityOn', v_flag.protected_activity_on, 'protectedActivityOn', v_corrected.protected_activity_on,
        'previousDaysBetween', v_flag.days_between, 'daysBetween', v_corrected.days_between,
        'previousConfidence', v_flag.confidence, 'confidence', v_corrected.confidence));
    if v_corrected.source = 'member_report' then
      v_member_report := v_member_report + 1;
    elsif v_corrected.adverse_kind = 'management_entry' then
      v_management_entry := v_management_entry + 1;
    else
      v_discipline_case := v_discipline_case + 1;
    end if;
  end loop;
  raise notice '#8868 stored flags corrected: member_report %, timing_detector management_entry %, timing_detector discipline_case %',
    v_member_report, v_management_entry, v_discipline_case;
end
$flag_correction$;
-- The account-lifecycle trigger review follows every changed function that a
-- lifecycle trigger reaches, and the Eastern-day helper they now call.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
    ('private','casework_detect_retaliation_timing'),
    ('private','casework_retaliation_flag_json'),
    ('private','casework_sweep_ulp_deadlines'),
    ('private','cr108_candidate_count'),
    ('private','cr108_candidate_sources'),
    ('private','workload_rebalancing'),
    ('public','casework_flag_retaliation_incident'),
    ('public','casework_list_ulp_deadlines'),
    ('public','create_member_case'),
    ('public','get_advisor_overview'),
    ('public','get_compass_case_context'),
    ('public','get_compass_field_notes_packet_context'),
    ('public','get_coordinator_kpis'),
    ('public','get_my_case_ulp_summary'),
    ('public','get_vp_overview'),
    ('public','list_coordinator_cases'),
    ('public','mark_vp_case_reviewed'),
    ('public','mi1_get_automation_opportunities'),
    ('public','open_member_case'),
    ('public','validate_member_operations_import'),
    ('private','casework_retaliation_adverse_events'),
    ('private','eastern_day')
) changed(schema_name,function_name)
  on changed.schema_name=surface.schema_name
 and changed.function_name=pg_catalog.split_part(surface.object_name,'(',1)
where surface.kind='function'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

commit;
