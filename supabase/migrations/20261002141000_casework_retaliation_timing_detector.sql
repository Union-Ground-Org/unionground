-- REQ-UG-RETALIATION-TIMING-DETECTOR-20261001 (CR-029/CR-030, narrowed)
--
-- Restore-everything campaign,. The pre-clean-room app
-- (de7df4b57c^:lib/grievances/retaliation-detection.ts) flagged likely
-- retaliation when discipline, or a management-log entry tagged Retaliation and
-- linked to the grievance, followed a member's grievance inside
-- retaliation_window_days; it counted prior discipline inside
-- retaliation_prior_discipline_months for the reviewer, scored confidence from
-- proximity and severity, stamped the ULP deadline, and told the member on Home
-- that their steward had been notified (components/home/lib/load-member-home.ts:391-405).
-- The clean-room rewrite kept only the report-count pattern scan
-- (api/_lib/sensitivePatterns.js, casework_scan_retaliation_patterns), with no
-- timing, no discipline check and no setting.
--
-- This migration adds the timing detector BESIDE the pattern scan, on the
-- casework suite and the flags table of REQ-UG-ULP-FILING-DEADLINE-20261001:
--
--   * Protected activity: a member's case (member_cases.created_at is the
--     filing date). Adverse action, adapted to the current model:
--       - a management behavior entry on any of the member's cases whose
--         category is "discipline" (old discipline_events), or whose category
--         is "retaliation" and that is linked to the protected case itself (old
--         management_log 'Retaliation' + linked_grievance_id);
--       - a later Discipline case of the same member (incident date from its
--         filing form, else the day it was opened).
--     A match inside the window after the filing date becomes a
--     casework_retaliation_flags row (source 'timing_detector'), so the ULP
--     deadline, the staff review/dismiss-with-note flow and the member summary
--     of the sibling record apply unchanged.
--   * Confidence is the old formula (retaliation-detection.ts:11-66):
--     proximity (<30d 1.0, <=90d 0.5, <=180d 0.3, else 0.1) * 0.5 + severity
--     (terminat/discharg/removal 1.0, suspension 0.7, written/formal 0.4, else
--     0.2, read from the entry summary or the discipline case title) * 0.4;
--     high >= 0.65, medium >= 0.35. Prior discipline is counted and shown, never
--     folded into confidence (BUG-r3-retaliation-detector-confidence-inversion).
--   * Notice: the assigned steward/coordinator (access re-checked) gets a
--     case-free notice; only when one was sent, the member is told their steward
--     was notified. Neither notice names the incident, the manager or the score.
--   * Runs hourly (bounded) and on demand from the chapter hub for coordinators,
--     like the old "Run detection scan" (app/dashboard/retaliation/actions.ts:77).
--
-- Settings (W1-SETTINGS registry, category casework):
--   features.casework.retaliation_timing_detector  true  old retaliation_enabled 'true'
--       (0024_tier1_polish.sql:40, 0037_feature_flag_seed_consolidation.sql:28;
--       default-ON kill switch, lib/settings/feature-flags.ts:66)
--   limits.casework.retaliation_window_days        180   retaliation-detection.ts:91-96 (the
--       code default was raised from 30 to 180 by BUG-retaliation-detection-window-30-days;
--       the 0022/0029 seed row still read 30), bounds 7..365
--   limits.casework.retaliation_prior_discipline_months 12  0029_fix_settings_constraints_and_seed.sql:43,
--       retaliation-detection.ts:97, bounds 1..60
--
-- Metadata on audit rows stays a closed vocabulary (source, confidence, kind).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  -- Old retaliation_enabled 'true' (0024:40, 0037:28), default-ON (feature-flags.ts:66).
  ('features.casework.retaliation_timing_detector', 'boolean', 'Retaliation timing detector',
   'Flag likely retaliation when discipline or a retaliation entry follows a member''s case within the window, and notify the assigned steward.',
   'true', null, null, null, 1440, 'casework', true),
  -- Old code default 180 (retaliation-detection.ts:91-96); the 0029:42 seed row read 30.
  ('limits.casework.retaliation_window_days', 'integer', 'Retaliation detection window (days)',
   'Days after a member opens a case during which later discipline or a retaliation entry is flagged as possible retaliation.',
   '180', 7, 365, null, 1450, 'casework', false),
  -- Old retaliation_prior_discipline_months 12 (0029:43, retaliation-detection.ts:97).
  ('limits.casework.retaliation_prior_discipline_months', 'integer', 'Prior discipline lookback (months)',
   'Months before the case searched for earlier discipline; the count is shown to the steward with each flag.',
   '12', 1, 60, null, 1460, 'casework', false)
on conflict (key) do nothing;

alter table public.casework_retaliation_flags
  drop constraint casework_retaliation_flags_source_check;
alter table public.casework_retaliation_flags
  add constraint casework_retaliation_flags_source_check
    check (source in ('staff', 'member_report', 'timing_detector'));
alter table public.casework_retaliation_flags
  add column adverse_kind text check (adverse_kind is null or adverse_kind in ('management_entry', 'discipline_case')),
  add column protected_activity_on date,
  add column days_between integer check (days_between is null or days_between >= 0),
  add column confidence text check (confidence is null or confidence in ('high', 'medium', 'low')),
  add column prior_discipline_count integer check (prior_discipline_count is null or prior_discipline_count >= 0),
  add column staff_notified_at timestamptz,
  add constraint casework_retaliation_flags_detector_shape check (
    (source = 'timing_detector') = (
      adverse_kind is not null and protected_activity_on is not null and days_between is not null
      and confidence is not null and prior_discipline_count is not null
    )
  );

insert into private.notification_copy (key, lang, title, body) values
  ('casework.retaliation.staff_flagged', 'en', 'A possible retaliation pattern was flagged',
   'Open Casework to review the flagged case and confirm or dismiss it.'),
  ('casework.retaliation.staff_flagged', 'es', 'Se señaló un posible patrón de represalia',
   'Abre Casos para revisar el caso señalado y confirmarlo o descartarlo.'),
  ('casework.retaliation.member_steward_notified', 'en', 'Your steward has been notified',
   'A possible retaliation concern on your case was sent to your steward for review.'),
  ('casework.retaliation.member_steward_notified', 'es', 'Se avisó a tu representante',
   'Se envió a tu representante una posible represalia en tu caso para que la revise.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- Old severityWeight (retaliation-detection.ts:12-18), read from the entry's
-- summary or the discipline case title.
create function private.casework_retaliation_severity(p_text text)
returns numeric
language sql
immutable
set search_path = ''
as $function$
  select case
    when pg_catalog.lower(coalesce(p_text, '')) ~ '(terminat|discharg|removal)' then 1.0
    when pg_catalog.lower(coalesce(p_text, '')) ~ 'suspen' then 0.7
    when pg_catalog.lower(coalesce(p_text, '')) ~ '(written|formal)' then 0.4
    else 0.2
  end;
$function$;

-- Old calcConfidence (retaliation-detection.ts:20-66): proximity * 0.5 +
-- severity * 0.4; prior discipline is deliberately not an input.
create function private.casework_retaliation_confidence(p_days integer, p_severity numeric)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case when s.score >= 0.65 then 'high' when s.score >= 0.35 then 'medium' else 'low' end
  from (
    select (case when p_days < 30 then 1.0 when p_days <= 90 then 0.5 when p_days <= 180 then 0.3 else 0.1 end) * 0.5
      + coalesce(p_severity, 0.2) * 0.4 as score
  ) s;
$function$;

-- Discipline events of the member: discipline-category management entries on
-- any of the member's cases, retaliation-category entries (linked case kept for
-- the protected-case match), and Discipline cases with their incident date.
create function private.casework_retaliation_adverse_events(p_since date)
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
    (e.occurred_at at time zone 'UTC')::date, e.case_id,
    pg_catalog.lower(pg_catalog.btrim(e.category)) = 'discipline',
    private.casework_retaliation_severity(e.summary)
  from public.casework_management_entries e
  join public.member_cases c on c.id = e.case_id
  where e.case_id is not null
    and pg_catalog.lower(pg_catalog.btrim(e.category)) in ('discipline', 'retaliation')
    and e.occurred_at >= (p_since::timestamp at time zone 'UTC')
  union all
  select 'discipline_case', d.id, d.organization_id, d.user_id,
    coalesce(
      (select (f.answers ->> 'incident_date')::date from public.member_forms f
        where f.case_id = d.id and f.user_id = d.user_id
          and coalesce(f.answers ->> 'incident_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
        order by f.created_at, f.id limit 1),
      (d.created_at at time zone 'UTC')::date),
    null::uuid, true, private.casework_retaliation_severity(d.title)
  from public.member_cases d
  where d.organization_id is not null
    and pg_catalog.lower(pg_catalog.btrim(d.case_type)) = 'discipline'
    and d.created_at >= (p_since::timestamp at time zone 'UTC') - interval '1 year';
$function$;

create function private.casework_detect_retaliation_timing(
  p_organization_id uuid default null,
  p_chapter_id text default null,
  p_limit integer default 200
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
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
      select * from private.casework_retaliation_adverse_events(current_date - 400)
    ),
    matches as (
      select a.adverse_kind, a.adverse_id, a.adverse_on, a.severity,
        g.id as case_id, g.organization_id, g.user_id as member_id,
        (g.created_at at time zone 'UTC')::date as protected_on
      from adverse a
      join public.member_cases g
        on g.user_id = a.member_id and g.organization_id = a.organization_id
      where g.id is distinct from a.adverse_id
        and (a.is_discipline or a.linked_case_id = g.id)
        and (p_organization_id is null or g.organization_id = p_organization_id)
        and (p_chapter_id is null or g.chapter_id = p_chapter_id)
        and a.adverse_on >= (g.created_at at time zone 'UTC')::date
        and a.adverse_on <= (g.created_at at time zone 'UTC')::date
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

-- On-demand chapter scan for coordinators, beside the report-count pattern
-- scan (old runDetectionScan, app/dashboard/retaliation/actions.ts:77).
create function public.casework_scan_retaliation_timing(p_chapter_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_org uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  select c.organization_id into v_org from public.chapters c where c.id = p_chapter_id;
  if v_org is null or not private.member_has_chapter_role(p_chapter_id, array['coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'chapter not found' using errcode = 'P0002';
  end if;
  if not private.organization_feature_enabled(v_org, 'features.casework.retaliation_timing_detector') then
    raise exception 'retaliation timing detector is turned off' using errcode = '55000';
  end if;
  return private.casework_detect_retaliation_timing(v_org, p_chapter_id, 500);
end;
$function$;

-- The staff projection gains the detector's reviewer context; same signature.
create or replace function private.casework_retaliation_flag_json(p_flag public.casework_retaliation_flags, p_enabled boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', p_flag.id,
    'caseId', p_flag.case_id,
    'source', p_flag.source,
    'incidentOn', p_flag.incident_on,
    'ulpDeadline', case when p_enabled then p_flag.ulp_deadline end,
    'daysLeft', case when p_enabled then p_flag.ulp_deadline - current_date end,
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
    'staffNotifiedAt', p_flag.staff_notified_at);
$function$;

-- The member summary keeps every pinned field and adds stewardNotified: true
-- once an open or confirmed flag on the case was sent to an assigned steward.
create or replace function public.get_my_case_ulp_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
      'ulpCriticalDays', s.critical_days) order by s.ulp_deadline, s.case_id)
    from (
      select c.id as case_id,
        private.organization_feature_enabled(c.organization_id, 'features.casework.ulp_deadline') as enabled,
        coalesce(
          min(f.ulp_deadline) filter (where f.ulp_deadline >= current_date),
          max(f.ulp_deadline)) as ulp_deadline,
        bool_or(f.staff_notified_at is not null) as steward_notified,
        t.warning_days,
        t.critical_days
      from public.member_cases c
      join public.casework_retaliation_flags f on f.case_id = c.id and f.status in ('open', 'confirmed')
      cross join lateral private.casework_ulp_thresholds(c.organization_id) t
      where c.user_id = caller
      group by c.id, c.organization_id, t.warning_days, t.critical_days
    ) s
  ), '[]'::jsonb);
end;
$function$;

revoke all on function private.casework_retaliation_severity(text) from public, anon, authenticated, service_role;
revoke all on function private.casework_retaliation_confidence(integer, numeric) from public, anon, authenticated, service_role;
revoke all on function private.casework_retaliation_adverse_events(date) from public, anon, authenticated, service_role;
revoke all on function private.casework_detect_retaliation_timing(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.casework_scan_retaliation_timing(text) from public, anon, authenticated, service_role;
grant execute on function public.casework_scan_retaliation_timing(text) to authenticated;

comment on function private.casework_detect_retaliation_timing(uuid, text, integer) is
  'REQ-UG-RETALIATION-TIMING-DETECTOR-20261001: bounded detector; discipline or a linked retaliation entry inside the window after a member case opened becomes a timing_detector flag with confidence and prior-discipline count; assigned staff are notified and then the member is told a steward was notified.';
comment on function public.casework_scan_retaliation_timing(text) is
  'Coordinator on-demand timing scan for one chapter, beside casework_scan_retaliation_patterns. Refused (55000) while features.casework.retaliation_timing_detector is off.';

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'casework-retaliation-timing-tick';
  perform cron.schedule('casework-retaliation-timing-tick', '23 * * * *', 'select private.casework_detect_retaliation_timing(null, null, 200)');
end;
$block$;

-- ---------------------------------------------------------------------------
-- Job health: casework-retaliation-timing-tick joins the four copies of the monitored set (the
-- job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20261002140000 with only that name added (REQ-UG-RETALIATION-TIMING-DETECTOR-20261001).
-- ---------------------------------------------------------------------------

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent',
    'ballot-notices-tick', 'casework-alert-escalation-tick',
    'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick',
    'casework-ulp-deadline-tick', 'deadline-notices-tick',
    'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
    'event-checkin-token-retention', 'event-notices-tick',
    'integration-webhooks-dispatch-tick', 'live-poll-schedule-tick',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention',
    'notifications-dispatch-tick', 'notifications-expiry-sweep',
    'organization-automation-tick', 'organization-claim-retention',
    'survey-operations-sweep', 'task-files-reconcile-tick',
    'task-maintenance-daily', 'union-ground-organization-retention',
    'weekly-question-selection-tick', 'workload-reminders-tick'
  ));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  with candidate as (
    select j.jobname as job_name,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in (
      'appointment-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick',
      'deadline-notices-tick', 'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'live-poll-schedule-tick', 'member-messaging-dispatch',
      'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'organization-claim-retention', 'survey-operations-sweep',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ) and (d.start_time >= window_start or d.runid = any(open_runs))
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, c.job_name, c.run_id, c.status, c.started_at, c.finished_at,
    c.failure_code, c.redacted_summary
  from candidate c
  left join public.organization_job_runs mirrored
    on mirrored.job_name = c.job_name
   and mirrored.run_id = c.run_id
   and mirrored.organization_id is null
  where mirrored.id is null
     or mirrored.status is distinct from c.status
     or mirrored.finished_at is distinct from c.finished_at
     or mirrored.failure_code is distinct from c.failure_code
     or mirrored.redacted_summary is distinct from c.redacted_summary
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array[
      'account-deletion-reconcile-tick', 'appointment-reminders-tick',
      'ballot-choices-mix', 'ballot-choices-mix-recent',
      'ballot-notices-tick', 'casework-alert-escalation-tick',
      'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick',
      'casework-ulp-deadline-tick', 'deadline-notices-tick',
      'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
      'event-checkin-token-retention', 'event-notices-tick',
      'integration-webhooks-dispatch-tick', 'live-poll-schedule-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention',
      'notifications-dispatch-tick', 'notifications-expiry-sweep',
      'organization-automation-tick', 'organization-claim-retention',
      'survey-operations-sweep', 'task-files-reconcile-tick',
      'task-maintenance-daily', 'union-ground-organization-retention',
      'weekly-question-selection-tick', 'workload-reminders-tick'
    ]) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

notify pgrst, 'reload schema';

commit;
