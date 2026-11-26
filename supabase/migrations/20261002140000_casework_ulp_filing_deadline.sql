-- REQ-UG-ULP-FILING-DEADLINE-20261001
--
-- Restore-everything campaign,. The pre-clean-room app
-- (de7df4b57c^) carried an unfair-labor-practice (ULP) charge filing deadline on
-- every flagged retaliation incident: lib/grievances/retaliation-detection.ts:101
-- read ulp_window_days (default 180) and:160/:204 stamped
-- ulp_deadline = adverse-action date + window on each flag; the member Home
-- (components/home/lib/load-member-home.ts:347-373) warned at <= 30 days and
-- escalated to critical at <= 7 days. The clean-room rewrite dropped all of it.
--
-- This migration restores it on the casework suite (the one case model,
-- The "Casework W2 case-flow disposition"); no retired W2 object returns.
--
--   * public.casework_retaliation_flags: one row per flagged retaliation
--     incident on a member's case. ulp_deadline is a stored generated column
--     (incident date + the organization's window at flag time), so a later
--     change of the window never silently moves a deadline already shown to a
--     member. Sources in this migration: a steward/coordinator flagging an
--     incident on the case, and the member's own retaliation report attached to
--     the case (incident_at). The timing detector (sibling record
--     REQ-UG-RETALIATION-TIMING-DETECTOR-20261001) adds its own source.
--     No client table grant: staff and members read through the definer RPCs.
--   * public.get_my_case_ulp_summary(): the member's own case summary signal.
--     PINNED for ("What matters for you now"): one object per own case
--     that has an open or confirmed flag, with
--       caseId, ulpDeadline (ISO date or null), retaliationFlagged (boolean),
--       ulpWarningDays, ulpCriticalDays.
--     ulpDeadline is the nearest deadline that has not passed, else the most
--     recent passed one; null when the organization turned ULP tracking off.
--   * Staff: casework_flag_retaliation_incident, casework_review_retaliation_flag
--     (confirm / dismiss with a note / reopen), casework_list_case_retaliation_flags
--     (case view) and casework_list_ulp_deadlines (deadline view).
--   * private.casework_sweep_ulp_deadlines: hourly bounded sweep that attaches
--     member reports, follows report withdrawal, and sends the warning and the
--     urgent notice once each to the member and the assigned steward/coordinator
--     (access re-checked at send time). Notices carry no case reference, title,
--     narrative or date.
--
-- Settings (W1-SETTINGS registry, category casework). Defaults are the old
-- app's effective production values:
--   features.casework.ulp_deadline      true  old: no own flag; the ULP deadline
--                                             rode on retaliation_enabled 'true'
--                                             (0024_tier1_polish.sql:40,
--                                             0037_feature_flag_seed_consolidation.sql:28)
--   limits.casework.ulp_window_days     180   0022_features_all.sql:454,
--                                             0029_fix_settings_constraints_and_seed.sql:44,
--                                             retaliation-detection.ts:101; bounds 30..365
--   limits.casework.ulp_warning_days     30   load-member-home.ts:354
--   limits.casework.ulp_critical_days     7   load-member-home.ts:362/373
--
-- Audit: creation and review write casework_audit_events rows of the existing
-- pattern_detected / pattern_reviewed kinds with entity_type 'retaliation_flag',
-- so the closed event vocabulary is not edited here. Metadata carries only
-- closed-vocabulary values (source, status), never staff-written text.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Switch and limits
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  -- Old: no separate flag; ULP deadlines existed whenever retaliation
  -- detection ran (retaliation_enabled 'true', 0024:40 / 0037:28).
  ('features.casework.ulp_deadline', 'boolean', 'ULP filing deadline tracking',
   'Compute the unfair labor practice charge filing deadline for flagged retaliation incidents, show it to the member and steward, and warn as it approaches.',
   'true', null, null, null, 1400, 'casework', true),
  -- Old: ulp_window_days 180 (0022:454, 0029:44, retaliation-detection.ts:101).
  ('limits.casework.ulp_window_days', 'integer', 'ULP filing window (days)',
   'Days after the incident or discipline date within which an unfair labor practice charge must be filed. Applies to incidents flagged after a change.',
   '180', 30, 365, null, 1410, 'casework', false),
  -- Old: member Home warned when the ULP deadline was <= 30 days away (load-member-home.ts:354).
  ('limits.casework.ulp_warning_days', 'integer', 'ULP deadline first warning (days before)',
   'Days before the ULP filing deadline when the member and the assigned steward are first warned.',
   '30', 1, 120, null, 1420, 'casework', true),
  -- Old: the warning turned critical at <= 7 days (load-member-home.ts:362/373).
  ('limits.casework.ulp_critical_days', 'integer', 'ULP deadline urgent warning (days before)',
   'Days before the ULP filing deadline when the warning becomes urgent and is sent once more.',
   '7', 1, 60, null, 1430, 'casework', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Flagged incidents
-- ---------------------------------------------------------------------------

create table public.casework_retaliation_flags (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  source text not null check (source in ('staff', 'member_report')),
  source_id uuid,
  incident_on date not null,
  ulp_window_days integer not null check (ulp_window_days between 30 and 365),
  ulp_deadline date generated always as (incident_on + ulp_window_days) stored,
  status text not null default 'open' check (status in ('open', 'confirmed', 'dismissed', 'withdrawn')),
  note text check (note is null or pg_catalog.char_length(pg_catalog.btrim(note)) between 3 and 1000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  warning_sent_at timestamptz,
  urgent_sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  foreign key (case_id, organization_id, chapter_id)
    references public.member_cases(id, organization_id, chapter_id) on delete cascade,
  unique (id, organization_id),
  constraint casework_retaliation_flags_source_shape check (
    (source = 'staff' and source_id is null) or (source <> 'staff' and source_id is not null)
  )
);

create unique index casework_retaliation_flags_source_unique
  on public.casework_retaliation_flags (case_id, source, source_id) where source_id is not null;
create index casework_retaliation_flags_case_idx
  on public.casework_retaliation_flags (case_id, organization_id, chapter_id);
create index casework_retaliation_flags_open_deadline_idx
  on public.casework_retaliation_flags (ulp_deadline) where status in ('open', 'confirmed');
create index casework_retaliation_flags_organization_idx
  on public.casework_retaliation_flags (organization_id, status, ulp_deadline);
create index casework_retaliation_flags_chapter_idx
  on public.casework_retaliation_flags (chapter_id);
create index casework_retaliation_flags_created_by_idx
  on public.casework_retaliation_flags (created_by) where created_by is not null;
create index casework_retaliation_flags_reviewed_by_idx
  on public.casework_retaliation_flags (reviewed_by) where reviewed_by is not null;

alter table public.casework_retaliation_flags enable row level security;
create policy mfa_assurance on public.casework_retaliation_flags
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.casework_retaliation_flags is
  'Restrictive MFA floor every casework table carries; with no permissive policy and no client grant it is defense in depth behind the definer-only read path.';
-- Deny-by-default: no permissive policy and no client privilege. Staff and
-- members read through the SECURITY DEFINER routines below, which apply the
-- casework access predicate and the organization switch.
revoke all on table public.casework_retaliation_flags from public, anon, authenticated;

comment on table public.casework_retaliation_flags is
  'REQ-UG-ULP-FILING-DEADLINE-20261001: flagged retaliation incidents on a member case with the ULP charge filing deadline (incident date + organization window at flag time). No client grant; read through casework definer routines.';

-- Account lifecycle: two attribution columns hang from auth.users and detach
-- on account deletion; the flag itself lives exactly as long as its case.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_inventory_basis, exclusion_reason, note)
values
  ('public', 'casework_retaliation_flags', 'created_by', 'pseudonymize', 'excluded_with_reason', 'auth_user_fk',
   'Staff attribution on a casework record; the member''s own retaliation report is exported from its own table.',
   'Installed action is ON DELETE SET NULL; the flag stays with its case.'),
  ('public', 'casework_retaliation_flags', 'reviewed_by', 'pseudonymize', 'excluded_with_reason', 'auth_user_fk',
   'Staff review attribution on a casework record, not member-authored content.',
   'Installed action is ON DELETE SET NULL; the flag stays with its case.');

create trigger a00_case_graph_lock before insert or update or delete on public.casework_retaliation_flags
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.casework_retaliation_flags
for each row execute function private.lock_case_graph_row_keys('{created_by},{reviewed_by}', '{case_id,organization_id,chapter_id}');

do $review$
declare affected integer;
begin
  insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
  select kind, schema_name, table_name, object_name, definition_hash
  from private.account_lifecycle_trigger_surface()
  where kind = 'trigger' and schema_name = 'public'
    and table_name = 'casework_retaliation_flags'
    and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys');
  get diagnostics affected = row_count;
  if affected <> 2 then
    raise exception 'ULP flag trigger review pinned % rows, expected 2', affected;
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after ULP flags';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after ULP flags';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after ULP flags';
  end if;
end;
$review$;

-- ---------------------------------------------------------------------------
-- 3. Notice copy (no case reference, title, narrative or date)
-- ---------------------------------------------------------------------------

insert into private.notification_copy (key, lang, title, body) values
  ('casework.ulp.member_warning', 'en', 'A legal filing deadline on your case is approaching',
   'Open your case to see the date, and talk with your steward before it passes.'),
  ('casework.ulp.member_warning', 'es', 'Se acerca un plazo legal de presentación en tu caso',
   'Abre tu caso para ver la fecha y habla con tu representante antes de que venza.'),
  ('casework.ulp.member_urgent', 'en', 'A legal filing deadline on your case is days away',
   'Contact your steward now. Open your case to see the date.'),
  ('casework.ulp.member_urgent', 'es', 'Faltan pocos días para un plazo legal en tu caso',
   'Comunícate con tu representante ahora. Abre tu caso para ver la fecha.'),
  ('casework.ulp.staff_warning', 'en', 'An unfair labor practice filing window is closing',
   'Open Casework to review the flagged case before the filing deadline.'),
  ('casework.ulp.staff_warning', 'es', 'Se está cerrando un plazo para presentar un cargo por práctica laboral injusta',
   'Abre Casos para revisar el caso señalado antes de la fecha límite.'),
  ('casework.ulp.staff_urgent', 'en', 'An unfair labor practice filing deadline is days away',
   'Open Casework now to decide on a charge for the flagged case.'),
  ('casework.ulp.staff_urgent', 'es', 'Faltan pocos días para presentar un cargo por práctica laboral injusta',
   'Abre Casos ahora para decidir sobre un cargo en el caso señalado.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ---------------------------------------------------------------------------
-- 4. Private helpers
-- ---------------------------------------------------------------------------

-- Effective warning thresholds for one organization; the urgent threshold never
-- exceeds the first warning.
create function private.casework_ulp_thresholds(p_organization_id uuid)
returns table (warning_days integer, critical_days integer)
language sql
stable
security definer
set search_path = ''
as $function$
  select w.days, least(c.days, w.days)
  from (select private.organization_limit(p_organization_id, 'limits.casework.ulp_warning_days') as days) w,
       (select private.organization_limit(p_organization_id, 'limits.casework.ulp_critical_days') as days) c;
$function$;

revoke all on function private.casework_ulp_thresholds(uuid) from public, anon, authenticated, service_role;

-- One flag as the staff routines return it.
create function private.casework_retaliation_flag_json(p_flag public.casework_retaliation_flags, p_enabled boolean)
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
    'createdAt', p_flag.created_at);
$function$;

revoke all on function private.casework_retaliation_flag_json(public.casework_retaliation_flags, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Staff routines
-- ---------------------------------------------------------------------------

create function public.casework_flag_retaliation_incident(
  p_case_id uuid,
  p_incident_on date,
  p_note text default null
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
  if p_incident_on is null
     or p_incident_on > current_date
     or p_incident_on < current_date - 3650
     or (v_note is not null and pg_catalog.char_length(v_note) not between 3 and 1000) then
    raise exception 'invalid retaliation incident' using errcode = '22023';
  end if;
  select * into v_flag from public.casework_retaliation_flags f
  where f.case_id = v_case.id and f.source = 'staff' and f.incident_on = p_incident_on
    and f.status in ('open', 'confirmed')
  order by f.created_at limit 1;
  if found then
    return private.casework_retaliation_flag_json(v_flag, true);
  end if;
  insert into public.casework_retaliation_flags
    (case_id, organization_id, chapter_id, source, incident_on, ulp_window_days, note, created_by)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, 'staff', p_incident_on,
    private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days'),
    v_note, (select auth.uid()))
  returning * into v_flag;
  insert into public.casework_audit_events
    (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()),
    'pattern_detected', 'retaliation_flag', v_flag.id,
    pg_catalog.jsonb_build_object('source', 'staff', 'ulpWindowDays', v_flag.ulp_window_days));
  return private.casework_retaliation_flag_json(v_flag, true);
end;
$function$;

create function public.casework_review_retaliation_flag(
  p_flag_id uuid,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_flag public.casework_retaliation_flags%rowtype;
  v_note text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  select * into v_flag from public.casework_retaliation_flags where id = p_flag_id;
  if not found or not private.casework_staff_can_access(v_flag.case_id) then
    raise exception 'flag not found' using errcode = 'P0002';
  end if;
  v_note := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  if p_status is null or p_status not in ('open', 'confirmed', 'dismissed')
     or v_flag.status = 'withdrawn'
     or (v_note is not null and pg_catalog.char_length(v_note) not between 3 and 1000)
     or (p_status = 'dismissed' and v_note is null) then
    raise exception 'invalid flag review' using errcode = '22023';
  end if;
  select * into strict v_flag from public.casework_retaliation_flags where id = p_flag_id for update;
  update public.casework_retaliation_flags
    set status = p_status,
      note = coalesce(v_note, note),
      reviewed_by = (select auth.uid()),
      reviewed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where id = v_flag.id
    returning * into v_flag;
  insert into public.casework_audit_events
    (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_flag.organization_id, v_flag.chapter_id, v_flag.case_id, (select auth.uid()),
    'pattern_reviewed', 'retaliation_flag', v_flag.id,
    pg_catalog.jsonb_build_object('status', p_status));
  return private.casework_retaliation_flag_json(v_flag,
    private.organization_feature_enabled(v_flag.organization_id, 'features.casework.ulp_deadline'));
end;
$function$;

create function public.casework_list_case_retaliation_flags(p_case_id uuid)
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
begin
  perform private.casework_require_mfa();
  if p_case_id is null or not private.casework_staff_can_access(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id;
  v_enabled := private.organization_feature_enabled(v_case.organization_id, 'features.casework.ulp_deadline');
  select t.warning_days, t.critical_days into v_warning, v_critical
  from private.casework_ulp_thresholds(v_case.organization_id) t;
  return pg_catalog.jsonb_build_object(
    'enabled', v_enabled,
    'windowDays', private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days'),
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

-- The steward deadline view: open and confirmed ULP deadlines on every case the
-- caller may work, in organizations that track them, soonest first.
create function public.casework_list_ulp_deadlines(p_limit integer default 50)
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
      select f.ulp_deadline as deadline, f.id as flag_id,
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
          'criticalDays', t.critical_days) as row_data
      from public.casework_retaliation_flags f
      join public.member_cases c on c.id = f.case_id
      cross join lateral private.casework_ulp_thresholds(f.organization_id) t
      where f.status in ('open', 'confirmed')
        and f.organization_id = org
        and private.casework_staff_can_access(f.case_id)
        and private.organization_feature_enabled(f.organization_id, 'features.casework.ulp_deadline')
      order by f.ulp_deadline, f.id
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) rows
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Member summary (PINNED for)
-- ---------------------------------------------------------------------------

create function public.get_my_case_ulp_summary()
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
      'ulpWarningDays', s.warning_days,
      'ulpCriticalDays', s.critical_days) order by s.ulp_deadline, s.case_id)
    from (
      select c.id as case_id,
        private.organization_feature_enabled(c.organization_id, 'features.casework.ulp_deadline') as enabled,
        coalesce(
          min(f.ulp_deadline) filter (where f.ulp_deadline >= current_date),
          max(f.ulp_deadline)) as ulp_deadline,
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

-- ---------------------------------------------------------------------------
-- 7. Scheduled sweep
-- ---------------------------------------------------------------------------

create function private.casework_sweep_ulp_deadlines(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
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
      (v_report.incident_at at time zone 'UTC')::date,
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
      and f.ulp_deadline >= current_date
      and f.urgent_sent_at is null
      and f.ulp_deadline <= current_date + 120
    order by f.ulp_deadline, f.id
    for update of f skip locked
    limit v_limit
  loop
    if not private.organization_feature_enabled(v_flag.organization_id, 'features.casework.ulp_deadline') then
      continue;
    end if;
    select t.warning_days, t.critical_days into v_warning, v_critical
    from private.casework_ulp_thresholds(v_flag.organization_id) t;
    v_days := v_flag.ulp_deadline - current_date;
    v_level := case
      when v_days <= v_critical then 'urgent'
      when v_days <= v_warning and v_flag.warning_sent_at is null then 'warning'
    end;
    continue when v_level is null;
    select * into v_case from public.member_cases where id = v_flag.case_id;
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

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.casework_flag_retaliation_incident(uuid, date, text) from public, anon, authenticated, service_role;
revoke all on function public.casework_review_retaliation_flag(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.casework_list_case_retaliation_flags(uuid) from public, anon, authenticated, service_role;
revoke all on function public.casework_list_ulp_deadlines(integer) from public, anon, authenticated, service_role;
revoke all on function public.get_my_case_ulp_summary() from public, anon, authenticated, service_role;
revoke all on function private.casework_sweep_ulp_deadlines(integer) from public, anon, authenticated, service_role;

grant execute on function public.casework_flag_retaliation_incident(uuid, date, text) to authenticated;
grant execute on function public.casework_review_retaliation_flag(uuid, text, text) to authenticated;
grant execute on function public.casework_list_case_retaliation_flags(uuid) to authenticated;
grant execute on function public.casework_list_ulp_deadlines(integer) to authenticated;
grant execute on function public.get_my_case_ulp_summary() to authenticated;

comment on function public.get_my_case_ulp_summary() is
  'REQ-UG-ULP-FILING-DEADLINE-20261001: the caller''s own cases with an open or confirmed retaliation flag, as [{caseId, ulpDeadline (ISO date or null when the organization turned tracking off), retaliationFlagged, ulpWarningDays, ulpCriticalDays}].';
comment on function public.casework_flag_retaliation_incident(uuid, date, text) is
  'Staff flag a retaliation incident on a case they may work; the ULP filing deadline is the incident date plus the organization window. Refused while features.casework.ulp_deadline is off.';
comment on function public.casework_review_retaliation_flag(uuid, text, text) is
  'Staff confirm, dismiss (note required) or reopen a retaliation flag; audited as pattern_reviewed.';
comment on function public.casework_list_case_retaliation_flags(uuid) is
  'Staff case view of retaliation flags with the organization ULP switch and thresholds.';
comment on function public.casework_list_ulp_deadlines(integer) is
  'Staff deadline view: open and confirmed ULP filing deadlines on cases the caller may work, soonest first.';
comment on function private.casework_sweep_ulp_deadlines(integer) is
  'Bounded pg_cron target: attaches member retaliation reports as flags, follows withdrawal, and sends the ULP warning and urgent notice once each to the member and the assigned staff.';

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'casework-ulp-deadline-tick';
  perform cron.schedule('casework-ulp-deadline-tick', '41 * * * *', 'select private.casework_sweep_ulp_deadlines(200)');
end;
$block$;

-- ---------------------------------------------------------------------------
-- 9. Job health: casework-ulp-deadline-tick joins the four copies of the
-- monitored set (the job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20260930040000 with only that name added.
-- ---------------------------------------------------------------------------

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent',
    'ballot-notices-tick', 'casework-alert-escalation-tick',
    'casework-reminder-delivery-tick', 'casework-ulp-deadline-tick',
    'deadline-notices-tick', 'dues-reminders-dispatch-tick',
    'dues-stripe-reconcile-tick', 'event-checkin-token-retention',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'live-poll-schedule-tick', 'member-messaging-dispatch',
    'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention',
    'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
    'notifications-expiry-sweep', 'organization-automation-tick',
    'organization-claim-retention', 'survey-operations-sweep',
    'task-files-reconcile-tick', 'task-maintenance-daily',
    'union-ground-organization-retention', 'weekly-question-selection-tick',
    'workload-reminders-tick'
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
      'casework-ulp-deadline-tick', 'deadline-notices-tick',
      'event-checkin-token-retention', 'event-notices-tick',
      'integration-webhooks-dispatch-tick', 'live-poll-schedule-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention',
      'notifications-dispatch-tick', 'notifications-expiry-sweep',
      'organization-automation-tick', 'organization-claim-retention',
      'survey-operations-sweep', 'task-files-reconcile-tick',
      'task-maintenance-daily', 'union-ground-organization-retention',
      'weekly-question-selection-tick', 'workload-reminders-tick'
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
      'casework-reminder-delivery-tick', 'casework-ulp-deadline-tick',
      'deadline-notices-tick', 'dues-reminders-dispatch-tick',
      'dues-stripe-reconcile-tick', 'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'live-poll-schedule-tick', 'member-messaging-dispatch',
      'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'organization-claim-retention', 'survey-operations-sweep',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
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
