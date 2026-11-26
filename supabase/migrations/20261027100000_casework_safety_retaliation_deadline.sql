-- BUG-UG-CASEWORK-SAFETY-RETALIATION-30-DAY-DEADLINE-20261022
--
-- A member punished for raising a workplace safety or health complaint, or for
-- refusing unsafe work, has 30 days to file a retaliation complaint:
--   * private-sector workers: federal OSHA under section 11(c) of the OSH Act,
--     29 U.S.C. 660(c)(2) ("within thirty days after such violation occurs");
--   * Massachusetts public employees: the Department of Labor Standards (DLS)
--     under 454 CMR 25.07, which applies 29 CFR Part 1977.
-- A pending grievance or arbitration does not pause either clock
-- (29 CFR 1977.15(d)(3)). data/reference/labor-rights/agencies.json carries
-- both deadlines with their provenance records.
--
-- Until now a retaliation flag computed only the unfair labor practice (ULP)
-- deadline (incident date + 180 days or the jurisdiction's six months), and
-- the member's first warning arrived about day 150, long after the 30-day
-- safety window had closed.
--
-- This migration:
--   * adds two nullable columns to public.casework_retaliation_flags with no
--     default (metadata-only ALTER, no existing row is rewritten):
--       protected_activity_category  'safety_health' | 'other' | null (not
--                                    recorded: every flag made before today,
--                                    and the member-report and timing-detector
--                                    sources, which do not ask)
--       safety_deadline              incident_on + 30 when the category is
--                                    safety_health, else null
--     A CHECK ties the two together, so a stored safety deadline is always the
--     incident date plus 30 days and exists only for the safety category. It
--     is added NOT VALID and validated separately (existing rows are null, so
--     validation only reads). A plain column, not a generated one: adding a
--     stored generated column rewrites the table.
--   * replaces public.casework_flag_retaliation_incident(uuid, date, text)
--     with a four-argument version whose trailing
--     p_protected_activity_category defaults to null, so three-argument callers
--     keep working; the old signature is dropped so PostgREST resolves one
--     function. The routine stamps safety_deadline itself.
--   * adds limits.casework.employer_sector (unknown | private | public, default
--     unknown) and private.casework_safety_retaliation_route(org), which names
--     the filing route from the sector and limits.casework.ulp_jurisdiction:
--       private              -> osha_11c
--       public + MA          -> ma_dls
--       anything else        -> unknown (the clients name both routes
--                               neutrally instead of guessing)
--   * re-emits the four read routines with the safety fields added and every
--     earlier key kept:
--       private.casework_retaliation_flag_json       (latest: 20261013200000)
--       public.casework_list_case_retaliation_flags  (latest: 20261013200000)
--       public.casework_list_ulp_deadlines           (latest: 20261002140000)
--       public.get_my_case_ulp_summary               (latest: 20261013200000)
--     The member summary adds safetyDeadline and safetyRoute only for a case
--     that has a categorized safety flag, so every other case's summary row is
--     byte-for-byte what it was.
--
-- The hourly ULP notice sweep is unchanged: its sent-once markers belong to
-- the ULP deadline. The member's What-matters-now card and the staff panel
-- rank on the earlier of the two deadlines.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The employer sector setting
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  -- New: unknown names both safety-retaliation routes rather than guessing.
  ('limits.casework.employer_sector', 'text', 'Employer sector for safety retaliation',
   'Private or public employer. Picks where a safety or health retaliation complaint is filed within 30 days: federal OSHA s.11(c) for the private sector, Massachusetts DLS (454 CMR 25.07) for its public employees. Unknown shows both.',
   '"unknown"', null, null, array['unknown', 'private', 'public'], 1406, 'casework', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Columns and their shape
-- ---------------------------------------------------------------------------

alter table public.casework_retaliation_flags
  add column protected_activity_category text,
  add column safety_deadline date;

alter table public.casework_retaliation_flags
  add constraint casework_retaliation_flags_protected_activity_category_check
    check (protected_activity_category is null or protected_activity_category in ('safety_health', 'other')) not valid,
  -- A CASE, not an OR of comparisons, so SQL NULL cannot pass: safety_health
  -- needs a non-null deadline of exactly incident_on + 30 (incident_on is NOT
  -- NULL), and every other category, null included, needs no deadline.
  add constraint casework_retaliation_flags_safety_deadline_shape
    check (
      case when protected_activity_category = 'safety_health'
        then safety_deadline is not null and safety_deadline = incident_on + 30
        else safety_deadline is null
      end
    ) not valid;

alter table public.casework_retaliation_flags
  validate constraint casework_retaliation_flags_protected_activity_category_check;
alter table public.casework_retaliation_flags
  validate constraint casework_retaliation_flags_safety_deadline_shape;

comment on column public.casework_retaliation_flags.protected_activity_category is
  'What the member did that the retaliation answered, chosen by staff when flagging: safety_health (a workplace safety or health complaint or refusal) or other. Null when not recorded (flags made before BUG-UG-CASEWORK-SAFETY-RETALIATION-30-DAY-DEADLINE-20261022, member reports, the timing detector).';
comment on column public.casework_retaliation_flags.safety_deadline is
  'Safety or health retaliation complaint deadline: incident_on + 30 days (29 U.S.C. 660(c)(2); 454 CMR 25.07), set by casework_flag_retaliation_incident when protected_activity_category is safety_health, else null. A pending grievance does not pause it (29 CFR 1977.15(d)(3)).';

-- ---------------------------------------------------------------------------
-- 3. Filing route
-- ---------------------------------------------------------------------------

create function private.casework_safety_retaliation_route(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when s.sector = 'private' then 'osha_11c'
    when s.sector = 'public' and s.jurisdiction = 'MA' then 'ma_dls'
    else 'unknown'
  end
  from (
    select private.organization_setting_text(p_organization_id, 'limits.casework.employer_sector') as sector,
      private.organization_setting_text(p_organization_id, 'limits.casework.ulp_jurisdiction') as jurisdiction
  ) s;
$function$;

revoke all on function private.casework_safety_retaliation_route(uuid) from public, anon, authenticated, service_role;

comment on function private.casework_safety_retaliation_route(uuid) is
  'BUG-UG-CASEWORK-SAFETY-RETALIATION-30-DAY-DEADLINE-20261022: where a safety or health retaliation complaint is filed for one organization: osha_11c (private sector), ma_dls (public sector, Massachusetts jurisdiction) or unknown (the clients name both routes). No execute grant.';

-- ---------------------------------------------------------------------------
-- 4. Flag creation: the category and the 30-day deadline
-- ---------------------------------------------------------------------------

drop function public.casework_flag_retaliation_incident(uuid, date, text);

create function public.casework_flag_retaliation_incident(
  p_case_id uuid,
  p_incident_on date,
  p_note text default null,
  p_protected_activity_category text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
     or p_incident_on > current_date
     or p_incident_on < current_date - 3650
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

revoke all on function public.casework_flag_retaliation_incident(uuid, date, text, text) from public, anon, authenticated, service_role;
grant execute on function public.casework_flag_retaliation_incident(uuid, date, text, text) to authenticated;

comment on function public.casework_flag_retaliation_incident(uuid, date, text, text) is
  'Staff flag a retaliation incident on a case they may work; the ULP filing deadline is the incident date plus the organization window. With protected activity category safety_health the flag also carries the 30-day safety retaliation deadline (incident date + 30). Refused while features.casework.ulp_deadline is off.';

-- ---------------------------------------------------------------------------
-- 5. Read routines (every earlier key kept)
-- ---------------------------------------------------------------------------

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
    'staffNotifiedAt', p_flag.staff_notified_at,
    'windowBasis', p_flag.ulp_window_basis,
    'windowSource', (
      select r.provenance
      from private.reference_ulp_limitation_periods r
      where p_flag.ulp_window_basis = 'jurisdiction:' || r.jurisdiction),
    'protectedActivityCategory', p_flag.protected_activity_category,
    'safetyDeadline', case when p_enabled then p_flag.safety_deadline end,
    'safetyDaysLeft', case when p_enabled then p_flag.safety_deadline - current_date end);
$function$;

create or replace function public.casework_list_case_retaliation_flags(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_enabled boolean;
  v_warning integer;
  v_critical integer;
  v_jurisdiction jsonb;
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_access(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  v_enabled := private.organization_feature_enabled(v_case.organization_id, 'features.casework.ulp_deadline');
  select t.warning_days, t.critical_days into v_warning, v_critical
  from private.casework_ulp_thresholds(v_case.organization_id) t;
  select pg_catalog.jsonb_build_object(
      'code', r.jurisdiction,
      'name', r.jurisdiction_name,
      'periodValue', r.period_value,
      'periodUnit', r.period_unit,
      'periodText', r.period_text,
      'trigger', r.trigger_text,
      'extension', r.extension_text,
      'pinpoint', r.pinpoint,
      'provenance', r.provenance)
    into v_jurisdiction
  from private.reference_ulp_limitation_periods r
  where r.jurisdiction = private.organization_setting_text(v_case.organization_id, 'limits.casework.ulp_jurisdiction');
  return pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'windowDays', private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days'),
    'jurisdiction', v_jurisdiction,
    'safetyRoute', private.casework_safety_retaliation_route(v_case.organization_id),
    'warningDays', v_warning,
    'criticalDays', v_critical,
    'flags', coalesce((
      select pg_catalog.jsonb_agg(private.casework_retaliation_flag_json(f, v_enabled)
        order by f.ulp_deadline, f.created_at, f.id)
      from public.casework_retaliation_flags f
      where f.case_id = v_case.id
    ), '[]'::jsonb));
end;
$function$;

-- The steward deadline view lists each open flag at its earlier live deadline:
-- a safety deadline still ahead comes before the ULP deadline it precedes.
-- Each row names the organization's safety filing route (safetyRoute).
create or replace function public.casework_list_ulp_deadlines(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  perform private.casework_require_mfa();
  return coalesce((
    select pg_catalog.jsonb_agg(row_data order by deadline, flag_id)
    from (
      select case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end as deadline,
        f.id as flag_id,
        pg_catalog.jsonb_build_object(
          'flagId', f.id,
          'caseId', c.id,
          'reference', c.reference,
          'title', c.title,
          'source', f.source,
          'status', f.status,
          'incidentOn', f.incident_on,
          'ulpDeadline', f.ulp_deadline,
          'daysLeft', f.ulp_deadline - current_date,
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
        and private.casework_staff_can_access(f.case_id)
        and private.organization_feature_enabled(f.organization_id, 'features.casework.ulp_deadline')
      order by case when f.safety_deadline >= current_date and f.safety_deadline < f.ulp_deadline
          then f.safety_deadline else f.ulp_deadline end, f.id
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) rows
  ), '[]'::jsonb);
end;
$function$;

-- The member summary keeps every pinned field and the PIN full-session gate.
-- A case with an open or confirmed safety-category flag also carries
-- safetyDeadline (the nearest one not yet passed, else the latest passed) and
-- safetyRoute; no other case's row changes.
create or replace function public.get_my_case_ulp_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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
          min(f.ulp_deadline) filter (where f.ulp_deadline >= current_date),
          max(f.ulp_deadline)) as ulp_deadline,
        coalesce(
          min(f.safety_deadline) filter (where f.safety_deadline >= current_date),
          max(f.safety_deadline)) as safety_deadline,
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

end;
$function$;

notify pgrst, 'reload schema';

commit;
