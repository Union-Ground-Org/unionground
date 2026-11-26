-- SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920
--
-- Creating a case deadline or a case alert was a direct authenticated INSERT
-- from the browser. Every other casework write of comparable weight leaves a
-- public.casework_audit_events row behind -- casework_apply_macro writes
-- alert_created for the alert it inserts, casework_set_reminder_status writes
-- reminder_changed, casework_record_case_export writes cases_exported -- but
-- the two direct routes and the procedure deadline casework_advance_step
-- inserts wrote nothing. A deadline or an alert therefore
-- appeared on a case desk with no reviewable record of who created it or when,
-- and the alert_escalated event that a later escalation writes had no creation
-- predecessor to sit after.
--
-- The repair follows the route the sibling casework writers already use rather
-- than inventing a second one:
--
--   1. public.casework_audit_events.event_type gains one member,
--      'deadline_created'. Alert creation already has 'alert_created'; only the
--      deadline side lacked a name (deadline_requested / deadline_decided are
--      the extension lifecycle, not creation).
--   2. Two SECURITY DEFINER routines, public.casework_create_deadline and
--      public.casework_create_alert, insert the row and the audit row in one
--      transaction. Each takes the case-graph gate first, requires staff MFA,
--      re-applies the staff read predicate, and derives organization_id /
--      chapter_id from the case instead of trusting the caller -- the same
--      three checks the retired INSERT policies performed, plus the audit row
--      the policies could not write (casework_audit_events admits no client
--      INSERT under RLS).
--   3. casework_advance_step, the procedure route that inserts a deadline
--      when the next step carries a deadline rule, writes the same
--      deadline_created row for the deadline it creates.
--   4. The direct INSERT privilege and the INSERT halves of the two policies
--      are removed, so the audited routine is the only client creation route
--      and the gap cannot reopen by a caller going around the RPC.
--
-- Reads are untouched: public.casework_deadlines keeps casework_deadlines_read
-- and gains casework_deadlines_staff_read, which restates the SELECT half of
-- the retired FOR ALL policy; public.casework_alerts keeps casework_alerts_read.
-- UPDATE and DELETE were never granted to authenticated on either table.
--
-- Recorded metadata stays derived or drawn from a closed vocabulary (kind,
-- severity, the due timestamp, whether a reminder was asked for), so an audit
-- row can never carry the staff-authored label or message text.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- casework_advance_step is re-emitted below from its installed 20260917133000
-- body; refuse any other predecessor.
do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.casework_advance_step(uuid, text, text, text, uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '9dec930970a63cfafe33e5d922376b354e89aa18b7b1d698fa2f970f48a9d07f' then
    raise exception 'unreviewed casework_advance_step predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

-- casework_audit_events.event_type is a closed enumeration. Deadline creation
-- needs one more member; every existing value is preserved.
alter table public.casework_audit_events
  drop constraint casework_audit_events_event_type_check;
alter table public.casework_audit_events
  add constraint casework_audit_events_event_type_check check (event_type in (
    'strength_scored','deadline_requested','deadline_decided','checklist_created','checklist_item_changed',
    'step_advanced','restriction_changed','access_granted','access_revoked',
    'alert_created','alert_acknowledged','alert_escalated','behavior_logged',
    'retaliation_submitted','retaliation_withdrawn','pattern_detected',
    'draft_saved','bulk_updated','entity_linked','reminder_changed',
    'bargaining_changed','behavior_addendum_added','pattern_reviewed',
    'macro_saved','macro_applied','note_added','note_mentioned','case_assigned',
    'cases_exported','deadline_created'
  ));

create or replace function public.casework_create_deadline(
  p_case_id uuid,
  p_kind text,
  p_label text,
  p_due_at timestamptz,
  p_reminder_at timestamptz default null
)
returns public.casework_deadlines
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_row public.casework_deadlines%rowtype;
begin
  -- Case graph gate first, before any declaration initializer, authorization
  -- read or row acquisition: this routine writes public.casework_audit_events,
  -- which carries both an auth.users and a member_cases reference.
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id;
  if not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  insert into public.casework_deadlines(
    case_id, organization_id, chapter_id, kind, label, due_at, reminder_at, created_by)
  values (
    v_case.id, v_case.organization_id, v_case.chapter_id, p_kind,
    pg_catalog.btrim(p_label), p_due_at, p_reminder_at, (select auth.uid()))
  returning * into v_row;
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (
    v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()),
    'deadline_created', 'deadline', v_row.id,
    pg_catalog.jsonb_build_object(
      'kind', v_row.kind,
      'dueAt', v_row.due_at,
      'reminderSet', v_row.reminder_at is not null));
  return v_row;
end;
$function$;

revoke all on function public.casework_create_deadline(uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.casework_create_deadline(uuid, text, text, timestamptz, timestamptz)
  to authenticated;

comment on function public.casework_create_deadline(uuid, text, text, timestamptz, timestamptz) is
  'SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920: the only client route that creates a casework deadline. Records exactly one deadline_created casework_audit_events row, derives the case scope from the case rather than the caller, and refuses any case the caller cannot reach under private.casework_staff_can_access.';

create or replace function public.casework_create_alert(
  p_case_id uuid,
  p_kind text,
  p_severity text,
  p_message text,
  p_escalation_due_at timestamptz default null
)
returns public.casework_alerts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_case public.member_cases%rowtype;
  v_row public.casework_alerts%rowtype;
begin
  -- Same gate order as casework_create_deadline, for the same reason.
  perform private.lock_case_graph(array[auth.uid()], array[p_case_id]);
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id;
  if not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  insert into public.casework_alerts(
    case_id, organization_id, chapter_id, kind, severity, message, escalation_due_at, created_by)
  values (
    v_case.id, v_case.organization_id, v_case.chapter_id, p_kind, p_severity,
    pg_catalog.btrim(p_message), p_escalation_due_at, (select auth.uid()))
  returning * into v_row;
  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (
    v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()),
    'alert_created', 'alert', v_row.id,
    pg_catalog.jsonb_build_object(
      'kind', v_row.kind,
      'severity', v_row.severity,
      'escalationSet', v_row.escalation_due_at is not null));
  return v_row;
end;
$function$;

revoke all on function public.casework_create_alert(uuid, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.casework_create_alert(uuid, text, text, text, timestamptz)
  to authenticated;

comment on function public.casework_create_alert(uuid, text, text, text, timestamptz) is
  'SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920: the only client route that creates a casework alert. Records exactly one alert_created casework_audit_events row, derives the case scope from the case rather than the caller, and refuses any case the caller cannot reach under private.casework_staff_can_access.';

-- The procedure route: casework_advance_step inserts the deadline a procedure
-- step's deadline rule computes. Re-emitted from its installed 20260917133000
-- body (predecessor digest guarded above); the only change is that the
-- deadline insert returns its id and writes one deadline_created row in the
-- same transaction, with the same derived metadata as the client route. The
-- case-graph gate stays first and grants are unchanged.
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
        v_start := v_incident::date::timestamp at time zone 'UTC';
      end if;
      v_due := case v_next.deadline_rule->>'kind'
        when 'business_days' then private.casework_add_business_days(v_start, (v_next.deadline_rule->>'count')::integer, v_case.organization_id)
        else ((v_start at time zone 'UTC') + ((v_next.deadline_rule->>'count')::integer * interval '1 day')) at time zone 'UTC' end;
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
  return v_transition;
end;

end;
$function$;

-- The unaudited direct routes close at both layers: the privilege and the
-- policy. casework_deadlines_staff_write was FOR ALL, so its SELECT half is
-- restated as a read policy and only its write half is retired.
revoke insert on public.casework_deadlines from authenticated;
revoke insert on public.casework_alerts from authenticated;

drop policy if exists casework_deadlines_staff_write on public.casework_deadlines;

create policy casework_deadlines_staff_read on public.casework_deadlines
  for select to authenticated
  using (private.casework_staff_can_access(case_id));

comment on policy casework_deadlines_staff_read on public.casework_deadlines is
  'Restates the SELECT half of the retired casework_deadlines_staff_write FOR ALL policy; deadline creation belongs to the audited public.casework_create_deadline.';

drop policy if exists casework_alerts_create on public.casework_alerts;

notify pgrst, 'reload schema';

commit;
