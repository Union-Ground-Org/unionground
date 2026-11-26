-- REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 (#6942), part 2 of 2:
-- the case workflow under the learning period. Built on the engine
-- (20261103163000), the task slice (20261103183000) and part 1, the case
-- record (20261104075000). Stamped after every open migration (080000,
-- 090000, 095000, 110000, 111500, 113000, 120000).
--
-- While an organization's learning period runs, a person's own case
-- workflow actions are journalled and undoable: moving a case to its next
-- step (by a reverse transition; the earlier transition row stays), deadlines
-- and extension requests and decisions, checklist items, reminders, intake
-- drafts, strength scores, case macros, and converting an intake report or
-- committing an operations import. Each action is undone from the case
-- history rows it wrote, all or nothing; case history keeps every version
-- and the audit trail only grows.
--
-- Retaliation reports, patterns and pattern notes are not part of this
-- slice: #6943 (20261104120000) records and keeps them. The undo dispatcher
-- is a hand-off, so this slice copies no other slice's branch.
--
-- The member's direct case reminder insert becomes create_my_case_reminder.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Kinds
-- ---------------------------------------------------------------------------
insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('casework_step_transitions_change', 'cases', 'reverse', 'public.casework_step_transitions', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_deadlines_change', 'cases', 'reverse', 'public.casework_deadlines', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_deadline_extensions_change', 'cases', 'reverse', 'public.casework_deadline_extensions', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_checklists_change', 'cases', 'reverse', 'public.casework_checklists', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_checklist_items_change', 'cases', 'reverse', 'public.casework_checklist_items', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_reminders_change', 'cases', 'reverse', 'public.casework_reminders', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_intake_drafts_change', 'cases', 'reverse', 'public.casework_intake_drafts', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_strength_analyses_change', 'cases', 'reverse', 'public.casework_strength_analyses', false, 'private.learning_undo_casework', array[]::text[],
    'One row a case action wrote, undone from the case history row it captured.'),
  ('casework_step_advance', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Moving a case to its next step, with the deadlines and checklists that step created. Undone together, by a reverse transition. The parent of one entry per row it wrote.'),
  ('casework_deadline_create', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Adding a case deadline. The parent of one entry per row it wrote.'),
  ('casework_deadline_status', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Changing a case deadline''s status. The parent of one entry per row it wrote.'),
  ('casework_extension_request', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Requesting a deadline extension. Undone only while nobody has decided it. The parent of one entry per row it wrote.'),
  ('casework_extension_decide', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Deciding a deadline extension, with the deadline it moved. Undone to undecided while neither has changed since. The parent of one entry per row it wrote.'),
  ('casework_checklist_item', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Checking or unchecking a case checklist item. The parent of one entry per row it wrote.'),
  ('casework_reminder_create', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Setting a case reminder. The parent of one entry per row it wrote.'),
  ('casework_reminder_status', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Snoozing, completing or cancelling a case reminder. The parent of one entry per row it wrote.'),
  ('casework_draft_save', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Saving a case intake draft. The parent of one entry per row it wrote.'),
  ('casework_case_score', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Scoring a case''s strength (a generated case aid). The parent of one entry per row it wrote.'),
  ('case_intake_convert', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Converting a member''s intake report into a case. The parent of one entry per row it wrote.'),
  ('case_operations_import', 'cases', 'simulate', 'public.member_cases', false, null, array[]::text[],
    'Committing an operations import that creates cases, as one action. The parent of one entry per row it wrote.'),
  ('casework_macro_save', 'cases', 'reverse', 'public.casework_macros', false, 'private.learning_undo_casework_macro', array['existed', 'name', 'actions', 'active']::text[],
    'Saving a case macro. Undo puts back the earlier macro, or retires a new one.'),
  ('casework_macro_save_kept', 'cases', 'permanent', 'public.casework_macros', false, null, array[]::text[],
    'Saving a macro whose earlier version is too large for a before-image. Kept as saved.');

-- A covered row's state without the bookkeeping a delivery sweep writes,
-- which is not the person's work and so neither blocks an undo nor is put
-- back by one: updated_at everywhere; a reminder's delivery stamp
-- (last_fired_at); a deadline's notice stamps (reminder_sent_at,
-- reminder_disposition). A recurring reminder whose schedule the sweep
-- advanced, and a deadline the sweep marks missed, have really changed and
-- still refuse.
create function private.learning_casework_stable(p_table text, p_row jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_row is null then null
    when p_table = 'casework_reminders' then p_row - array['updated_at', 'last_fired_at']::text[]
    when p_table = 'casework_deadlines' then p_row - array['updated_at', 'reminder_sent_at', 'reminder_disposition']::text[]
    else p_row - 'updated_at'
  end;
$function$;
revoke all on function private.learning_casework_stable(text, jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Journalling a case action from the case history rows it wrote
-- ---------------------------------------------------------------------------
-- A writer calls this once, after its writes. It journals one simulate
-- parent and one child per private.casework_record_versions row the
-- calling statement wrote by the caller (case history stamps each row with
-- clock_timestamp()) and not yet journalled: a case row maps to
-- the case kinds of 20261104075000, any other covered row to its
-- casework_<table>_change kind. Audit rows are never journalled: the audit
-- trail only grows. With p_any_case, rows of any case (or none) count. An
-- action that wrote no covered row journals nothing, so it never offers an
-- Undo that changes nothing. p_case_image is the before-image a created
-- case's entry keeps (the intake report it was converted from).
create function private.learning_casework_journal(p_kind text, p_case_id uuid, p_any_case boolean default false, p_case_image jsonb default '{}'::jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  parent uuid;
  written private.casework_record_versions[];
  v private.casework_record_versions%rowtype;
begin
  if caller is null then return null; end if;
  select coalesce(pg_catalog.array_agg(r order by r.id), array[]::private.casework_record_versions[]) into written
    from private.casework_record_versions r
    where r.actor = caller and r.at >= pg_catalog.statement_timestamp()
      and (p_any_case or r.case_id is not distinct from p_case_id)
      and r.record_table = any(array['casework_step_transitions', 'casework_deadlines', 'casework_deadline_extensions', 'casework_checklists', 'casework_checklist_items', 'casework_reminders', 'casework_intake_drafts', 'casework_strength_analyses', 'member_cases']::text[])
      and not exists (select 1 from private.learning_action_journal j where j.before_ref = r.id)
      and not (r.record_table = 'member_cases' and r.op = 'INSERT' and exists (
        select 1 from private.learning_action_journal j
        where j.target_table = 'public.member_cases' and j.target_id = r.record_id and j.action_kind = 'case_create'))
      and not (r.record_table = 'member_cases' and r.op = 'DELETE');
  if pg_catalog.cardinality(written) = 0 then return null; end if;
  parent := private.learning_journal_append(p_kind, 'public.member_cases', 'action:' || extensions.gen_random_uuid()::text);
  if parent is null then return null; end if;
  foreach v in array written
  loop
    if v.record_table = 'member_cases' then
      if v.op = 'INSERT' then
        perform private.learning_journal_append('case_create', 'public.member_cases', v.record_id, parent,
          private.learning_fingerprint(private.learning_case_state_from(v.new_row)), null, coalesce(p_case_image, '{}'::jsonb));
      elsif v.op = 'UPDATE' then
        perform private.learning_journal_append('case_edit', 'public.member_cases', v.record_id, parent,
          private.learning_fingerprint(private.learning_case_state_from(v.new_row)), v.id, null);
      end if;
    else
      perform private.learning_journal_append('casework_' || pg_catalog.substr(v.record_table, 10) || '_change',
        'public.' || v.record_table, v.record_id, parent,
        private.learning_fingerprint(case when v.new_row is null then '{"absent": true}'::jsonb else private.learning_casework_stable(v.record_table, v.new_row) end), v.id, null);
    end if;
  end loop;
  return parent;
end;
end;
$function$;
revoke all on function private.learning_casework_journal(text, uuid, boolean, jsonb) from public, anon, authenticated, service_role;

-- The lifecycle fields an intake conversion sets on its report, and the
-- image a converted case's or task's creation keeps of them: the report as
-- it stood before and as conversion left it.
create function private.learning_intake_report_fields(p_report public.member_intake_reports)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object('status', p_report.status, 'assigned_to', p_report.assigned_to,
    'case_id', p_report.case_id, 'task_id', p_report.task_id, 'thread_id', p_report.thread_id);
$function$;
revoke all on function private.learning_intake_report_fields(public.member_intake_reports) from public, anon, authenticated, service_role;

-- Undoing the conversion puts the report back, but only while it still
-- stands as conversion left it; anyone's later triage refuses the undo.
create function private.learning_intake_report_unchanged(p_image jsonb)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_image is null or exists (
    select 1 from public.member_intake_reports r
    where r.id = (p_image ->> 'id')::uuid and private.learning_intake_report_fields(r) = p_image -> 'after');
$function$;
revoke all on function private.learning_intake_report_unchanged(jsonb) from public, anon, authenticated, service_role;

create function private.learning_restore_intake_report(p_image jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if p_image is null then return; end if;
  update public.member_intake_reports r
  set status = p_image -> 'before' ->> 'status',
      assigned_to = (p_image -> 'before' ->> 'assigned_to')::uuid,
      case_id = (p_image -> 'before' ->> 'case_id')::uuid,
      task_id = (p_image -> 'before' ->> 'task_id')::uuid,
      thread_id = (p_image -> 'before' ->> 'thread_id')::uuid
  where r.id = (p_image ->> 'id')::uuid and private.learning_intake_report_fields(r) = p_image -> 'after';
end;
$function$;
revoke all on function private.learning_restore_intake_report(jsonb) from public, anon, authenticated, service_role;

-- A converted case's or task's creation keeps the report's image.
update private.learning_action_kinds set before_image_columns = array['intake_report']::text[]
where action_kind in ('case_create', 'task_create');

-- A covered row as its case history captures it, without updated_at; a
-- row that is gone reads as {"absent": true}, so a removal has a state to
-- fingerprint and compare like any other change.
create function private.learning_casework_row_state(p_table text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(case p_table
    when 'casework_step_transitions' then (select private.learning_casework_stable('casework_step_transitions', pg_catalog.to_jsonb(x)) from public.casework_step_transitions x where x.id::text = p_id)
    when 'casework_deadlines' then (select private.learning_casework_stable('casework_deadlines', pg_catalog.to_jsonb(x)) from public.casework_deadlines x where x.id::text = p_id)
    when 'casework_deadline_extensions' then (select private.learning_casework_stable('casework_deadline_extensions', pg_catalog.to_jsonb(x)) from public.casework_deadline_extensions x where x.id::text = p_id)
    when 'casework_checklists' then (select private.learning_casework_stable('casework_checklists', pg_catalog.to_jsonb(x)) from public.casework_checklists x where x.id::text = p_id)
    when 'casework_checklist_items' then (select private.learning_casework_stable('casework_checklist_items', pg_catalog.to_jsonb(x)) from public.casework_checklist_items x where x.id::text = p_id)
    when 'casework_reminders' then (select private.learning_casework_stable('casework_reminders', pg_catalog.to_jsonb(x)) from public.casework_reminders x where x.id::text = p_id)
    when 'casework_intake_drafts' then (select private.learning_casework_stable('casework_intake_drafts', pg_catalog.to_jsonb(x)) from public.casework_intake_drafts x where x.id::text = p_id)
    when 'casework_strength_analyses' then (select private.learning_casework_stable('casework_strength_analyses', pg_catalog.to_jsonb(x)) from public.casework_strength_analyses x where x.id::text = p_id)
  end, '{"absent": true}'::jsonb);
$function$;
revoke all on function private.learning_casework_row_state(text, text) from public, anon, authenticated, service_role;

-- The reverse transition: the earlier transition row stays, and a new one
-- records the move back, by the caller in this transaction, so the case's
-- step guard admits restoring the step. Written once per move.
create function private.learning_reverse_transition(p_case_id uuid, p_from text, p_to text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  insert into public.casework_step_transitions
    (case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, procedure_transaction_id)
  select c.id, c.organization_id, c.chapter_id, p_from, p_to, 'Undone during the learning period',
    (select auth.uid()), extensions.gen_random_uuid(), pg_catalog.pg_current_xact_id()
  from public.member_cases c
  where c.id = p_case_id and p_from is distinct from p_to
    and not exists (select 1 from public.casework_step_transitions t
      where t.case_id = p_case_id and t.from_step = p_from and t.to_step = p_to
        and t.transitioned_by = (select auth.uid()) and t.procedure_transaction_id = pg_catalog.pg_current_xact_id());
end;
$function$;
revoke all on function private.learning_reverse_transition(uuid, text, text) from public, anon, authenticated, service_role;

-- The reversing handler for every covered case row (interface in
-- 20261103163000). It reads the case history row the entry points at: an
-- inserted row is removed (a step transition gets its reverse instead), an
-- updated row is put back as it was, a
-- removed row comes back. Case history keeps every version either way.
create function private.learning_undo_casework(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  t text := pg_catalog.substr(p_entry ->> 'target_table', 8);
  target text := p_entry ->> 'target_id';
  v private.casework_record_versions%rowtype;
  v_row jsonb;
begin
  select r.* into v from private.casework_record_versions r where r.id = (p_entry ->> 'before_ref')::bigint;
  v_row := coalesce(v.new_row, v.old_row);
  if p_mode = 'lock' then
    case t
      when 'casework_step_transitions' then perform 1 from public.casework_step_transitions x where x.id::text = target for update;
      when 'casework_deadlines' then perform 1 from public.casework_deadlines x where x.id::text = target for update;
      when 'casework_deadline_extensions' then perform 1 from public.casework_deadline_extensions x where x.id::text = target for update;
      when 'casework_checklists' then perform 1 from public.casework_checklists x where x.id::text = target for update;
      when 'casework_checklist_items' then perform 1 from public.casework_checklist_items x where x.id::text = target for update;
      when 'casework_reminders' then perform 1 from public.casework_reminders x where x.id::text = target for update;
      when 'casework_intake_drafts' then perform 1 from public.casework_intake_drafts x where x.id::text = target for update;
      when 'casework_strength_analyses' then perform 1 from public.casework_strength_analyses x where x.id::text = target for update;
      else null;
    end case;
    return null;
  elsif p_mode = 'state' then
    return private.learning_casework_row_state(t, target);
  elsif p_mode = 'before' then
    return case when v.old_row is null then null else private.learning_casework_stable(t, v.old_row) end;
  elsif p_mode = 'check' then
    if v.id is null or v.record_table is distinct from t or v.record_id is distinct from target then
      raise exception 'this practice action can no longer be undone' using errcode = '55000';
    end if;
    -- Today's rule of the writer that made the change, per table and
    -- operation: a reminder is its owner's while they can still read the
    -- case; a draft is its writer's while they still hold the drafting role
    -- (and the case it names is in scope); an extension request is its
    -- requester's while they may still request one (the case's member or
    -- staff who can work on it); every other workflow change (steps,
    -- deadlines, decisions, checklists, scores) needs staff who can work on
    -- the case today.
    if not private.mfa_satisfied() or not coalesce(case
         when t = 'casework_reminders' then
           (v_row ->> 'owner_user_id')::uuid = caller and private.casework_can_read((v_row ->> 'case_id')::uuid)
         when t = 'casework_intake_drafts' then
           v.actor = caller
           and private.member_has_chapter_role(v_row ->> 'chapter_id', array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
           and (v_row ->> 'case_id' is null or private.casework_scope_matches((v_row ->> 'case_id')::uuid,
             (v_row ->> 'organization_id')::uuid, v_row ->> 'chapter_id'))
         when v.case_id is null then false
         when t = 'casework_deadline_extensions' and v.op = 'INSERT' then
           v.actor = caller and private.casework_can_read(v.case_id)
           and (private.casework_member_owns(v.case_id) or private.casework_staff_can_access(v.case_id))
         else private.casework_staff_can_access(v.case_id)
       end, false) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- Taking away a deadline someone asked to extend would detach the request.
    if v.op = 'INSERT' and t = 'casework_deadlines'
       and exists (select 1 from public.casework_deadline_extensions e where e.deadline_id::text = target) then
      raise exception 'this has changed since your practice action' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if v.op = 'INSERT' then
    if t = 'casework_step_transitions' then
      perform private.learning_reverse_transition((v.new_row ->> 'case_id')::uuid, v.new_row ->> 'to_step', v.new_row ->> 'from_step');
    else
      case t
        when 'casework_deadlines' then delete from public.casework_deadlines x where x.id::text = target;
        when 'casework_deadline_extensions' then delete from public.casework_deadline_extensions x where x.id::text = target;
        when 'casework_checklists' then delete from public.casework_checklists x where x.id::text = target;
        when 'casework_checklist_items' then delete from public.casework_checklist_items x where x.id::text = target;
        when 'casework_reminders' then delete from public.casework_reminders x where x.id::text = target;
        when 'casework_intake_drafts' then delete from public.casework_intake_drafts x where x.id::text = target;
        when 'casework_strength_analyses' then delete from public.casework_strength_analyses x where x.id::text = target;
        else null;
      end case;
    end if;
  elsif v.op = 'UPDATE' then
    case t
        when 'casework_step_transitions' then update public.casework_step_transitions x set (case_id, organization_id, chapter_id, from_step, to_step, outcome, transitioned_by, idempotency_key, created_at, procedure_transaction_id) =
          (select r.case_id, r.organization_id, r.chapter_id, r.from_step, r.to_step, r.outcome, r.transitioned_by, r.idempotency_key, r.created_at, r.procedure_transaction_id from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row) r)
          where x.id::text = target;
        when 'casework_deadlines' then update public.casework_deadlines x set (case_id, organization_id, chapter_id, kind, label, due_at, status, reminder_at, created_by, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.kind, r.label, r.due_at, r.status, r.reminder_at, r.created_by, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row) r)
          where x.id::text = target;
        when 'casework_deadline_extensions' then update public.casework_deadline_extensions x set (deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, status, decided_by, decided_at, decision_note, idempotency_key, created_at) =
          (select r.deadline_id, r.organization_id, r.requested_by, r.previous_due_at, r.requested_due_at, r.reason, r.status, r.decided_by, r.decided_at, r.decision_note, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklists' then update public.casework_checklists x set (case_id, organization_id, chapter_id, template_id, step, title, created_by, created_at, completed_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.template_id, r.step, r.title, r.created_by, r.created_at, r.completed_at from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row) r)
          where x.id::text = target;
        when 'casework_checklist_items' then update public.casework_checklist_items x set (checklist_id, organization_id, label, position, required, completed_at, completed_by) =
          (select r.checklist_id, r.organization_id, r.label, r.position, r.required, r.completed_at, r.completed_by from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row) r)
          where x.id::text = target;
        when 'casework_reminders' then update public.casework_reminders x set (case_id, organization_id, chapter_id, owner_user_id, title, remind_at, recurrence, status, completed_at, created_at, updated_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.owner_user_id, r.title, r.remind_at, r.recurrence, r.status, r.completed_at, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row) r)
          where x.id::text = target;
        when 'casework_intake_drafts' then update public.casework_intake_drafts x set (organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload, revision, created_at, updated_at) =
          (select r.organization_id, r.chapter_id, r.owner_user_id, r.member_user_id, r.case_id, r.payload, r.revision, r.created_at, r.updated_at from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row) r)
          where x.id::text = target;
        when 'casework_strength_analyses' then update public.casework_strength_analyses x set (case_id, organization_id, chapter_id, analyzed_by, inputs, score, band, recommendations, idempotency_key, created_at) =
          (select r.case_id, r.organization_id, r.chapter_id, r.analyzed_by, r.inputs, r.score, r.band, r.recommendations, r.idempotency_key, r.created_at from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row) r)
          where x.id::text = target;
      else null;
    end case;
  else
    case t
        when 'casework_step_transitions' then insert into public.casework_step_transitions select * from pg_catalog.jsonb_populate_record(null::public.casework_step_transitions, v.old_row);
        when 'casework_deadlines' then insert into public.casework_deadlines select * from pg_catalog.jsonb_populate_record(null::public.casework_deadlines, v.old_row);
        when 'casework_deadline_extensions' then insert into public.casework_deadline_extensions select * from pg_catalog.jsonb_populate_record(null::public.casework_deadline_extensions, v.old_row);
        when 'casework_checklists' then insert into public.casework_checklists select * from pg_catalog.jsonb_populate_record(null::public.casework_checklists, v.old_row);
        when 'casework_checklist_items' then insert into public.casework_checklist_items select * from pg_catalog.jsonb_populate_record(null::public.casework_checklist_items, v.old_row);
        when 'casework_reminders' then insert into public.casework_reminders select * from pg_catalog.jsonb_populate_record(null::public.casework_reminders, v.old_row);
        when 'casework_intake_drafts' then insert into public.casework_intake_drafts select * from pg_catalog.jsonb_populate_record(null::public.casework_intake_drafts, v.old_row);
        when 'casework_strength_analyses' then insert into public.casework_strength_analyses select * from pg_catalog.jsonb_populate_record(null::public.casework_strength_analyses, v.old_row);
      else null;
    end case;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_casework(text, jsonb) from public, anon, authenticated, service_role;

create function private.learning_casework_macro_state(p_macro_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select pg_catalog.jsonb_build_object('existed', true, 'name', m.name, 'actions', m.actions, 'active', m.active)
     from public.casework_macros m where m.id = p_macro_id),
    '{"existed": false}'::jsonb);
$function$;
revoke all on function private.learning_casework_macro_state(uuid) from public, anon, authenticated, service_role;

-- Undo for saving a case macro: the earlier macro comes back, and a macro the
-- action created is retired (macros are referenced by audit and history).
create function private.learning_undo_casework_macro(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  macro public.casework_macros%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.casework_macros m where m.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_casework_macro_state(target);
  elsif p_mode = 'before' then
    return case when coalesce((image ->> 'existed')::boolean, false) then image
      else private.learning_casework_macro_state(target) || '{"active": false}'::jsonb end;
  end if;
  select m.* into macro from public.casework_macros m where m.id = target;
  if p_mode = 'check' then
    -- Today's rule for authoring a macro in its scope, as casework_save_macro
    -- applies it.
    if macro.id is null or not private.mfa_satisfied()
       or not private.casework_macro_audience(macro.organization_id, macro.chapter_id, true) then
      raise exception 'you can no longer change this macro' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if coalesce((image ->> 'existed')::boolean, false) then
    update public.casework_macros m set name = image ->> 'name', actions = image -> 'actions',
      active = (image ->> 'active')::boolean, updated_at = pg_catalog.now()
    where m.id = target;
  else
    update public.casework_macros m set active = false, updated_at = pg_catalog.now() where m.id = target;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_casework_macro(text, jsonb) from public, anon, authenticated, service_role;

-- The member's own case reminder, replacing the direct client insert, with
-- the rule the insert policy applied.
create function public.create_my_case_reminder(p_case_id uuid, p_title text, p_remind_at timestamptz, p_recurrence text default 'none')
returns public.casework_reminders
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  case_row public.member_cases%rowtype;
  inserted public.casework_reminders%rowtype;
begin
  if caller is null or not private.mfa_satisfied() or private.member_pin_session_restricted() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select c.* into case_row from public.member_cases c where c.id = p_case_id and c.learning_undone_at is null;
  if case_row.id is null or not private.casework_can_read(case_row.id)
     or not private.casework_scope_matches(case_row.id, case_row.organization_id, case_row.chapter_id) then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  insert into public.casework_reminders (case_id, organization_id, chapter_id, owner_user_id, title, remind_at, recurrence)
  values (case_row.id, case_row.organization_id, case_row.chapter_id, caller, pg_catalog.btrim(coalesce(p_title, '')),
    p_remind_at, coalesce(p_recurrence, 'none'))
  returning * into inserted;
  perform private.learning_casework_journal('casework_reminder_create', case_row.id);
  return inserted;
end;
end;
$function$;
revoke all on function public.create_my_case_reminder(uuid, text, timestamptz, text) from public, anon, authenticated, service_role;
grant execute on function public.create_my_case_reminder(uuid, text, timestamptz, text) to authenticated;

-- Reminders and checklists are written only through journalled RPCs now:
-- no client role keeps a direct insert on a table the journal covers.
drop policy if exists casework_reminders_owner_create on public.casework_reminders;
drop policy if exists casework_checklists_staff on public.casework_checklists;
revoke insert on public.casework_reminders from authenticated;
revoke insert on public.casework_checklists from authenticated;

-- Hand-off, as 20261104111500 and 20261104120000 do: the dispatcher
-- installed when this applies (every earlier slice's handlers) keeps its body
-- under a new name, and the new dispatcher sends this slice's two handlers to
-- them and every other handler to it. No earlier slice's branch is copied, so
-- none can be dropped whichever order the slices land in.
alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_case_workflow;
comment on function private.learning_dispatch_before_case_workflow(text, text, jsonb) is
  'REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103: the undo dispatcher as the slices before the case workflow slice left it, reached only through private.learning_dispatch.';

create function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Handlers write graph tables, so the dispatcher takes the lock first too.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if p_mode is null or p_mode not in ('lock', 'state', 'before', 'check', 'apply') or p_entry is null then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  case p_handler
    when 'private.learning_undo_casework' then return private.learning_undo_casework(p_mode, p_entry);
    when 'private.learning_undo_casework_macro' then return private.learning_undo_casework_macro(p_mode, p_entry);
    else return private.learning_dispatch_before_case_workflow(p_handler, p_mode, p_entry);
  end case;
end;
$function$;
revoke all on function private.learning_dispatch(text, text, jsonb) from public, anon, authenticated, service_role;

-- The case handler reverses a procedure step by a reverse transition, frees a form-created case's form and restores a converted intake report (re-emitted from 20261104075000).
create or replace function private.learning_undo_case(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  case_row public.member_cases%rowtype;
  earlier jsonb;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_cases c where c.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_case_state(target);
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'case_create' then return null; end if;
    return private.learning_case_state_from(
      (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  end if;
  select c.* into case_row from public.member_cases c where c.id = target;
  if p_mode = 'check' then
    -- Today's rule for changing the case: its owner, or staff who can work on it.
    if case_row.id is null or not private.mfa_satisfied() or not (
        (case_row.user_id = caller and private.chapter_case_readable(case_row))
        or private.casework_staff_can_access(case_row.id)
        -- Whoever opened the case at intake may undo that, under the same
        -- intake rule open_member_case applies, assigned or not.
        or (p_entry ->> 'action_kind' = 'case_create' and (
          private.chapter_case_intake_role_allows(case_row.user_id, 'steward')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'coordinator')
          or private.chapter_case_intake_role_allows(case_row.user_id, 'admin')))) then
      raise exception 'you can no longer change this case' using errcode = '42501';
    end if;
    -- A step this edit moved cannot go back by hand once a procedure governs
    -- the case: the procedure's own transition is the only way to move it.
    -- The step is the one the newer undos in this chain leave (projected).
    if p_entry ->> 'action_kind' = 'case_edit'
       and coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) is distinct from (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)
       and private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null
       -- A step the caller's own transition moved goes back by the reverse
       -- transition (20261104123000); any other step change still does not.
       and not exists (select 1 from public.casework_step_transitions st
         where st.case_id = target and st.to_step = coalesce(p_entry -> 'projected_state' ->> 'step', case_row.step) and st.transitioned_by = caller
           and st.from_step = (select v.old_row ->> 'step' from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint)) then
      raise exception 'this case now follows a procedure; move its step there' using errcode = '55000';
    end if;
    -- Opening a case is undone only while nobody else has worked on it:
    -- no one else's note, contact, file, outcome, audited action or change
    -- in its history.
    if p_entry ->> 'action_kind' = 'case_create' and (
        exists (select 1 from public.member_case_updates u
          where u.case_id = target and u.learning_undone_at is null and u.author_user_id is distinct from caller)
        or exists (select 1 from public.member_case_files f
          where f.case_id = target and f.removal_requested_at is null and f.uploaded_by is distinct from caller)
        or exists (select 1 from public.member_case_outcomes o where o.case_id = target and o.recorded_by is distinct from caller)
        or exists (select 1 from public.member_case_contacts k where k.case_id = target and k.coordinator_id is distinct from caller)
        or exists (select 1 from public.coordinator_case_audit a where a.case_id = target and a.actor_id is distinct from caller)
        -- A President's review and a steward's identity-privacy decision
        -- leave no case history row, so they are checked here (#7000 r2s2, r2g1).
        or exists (select 1 from public.member_vp_case_reviews r where r.case_id = target and r.reviewed_by is distinct from caller)
        -- An administrator's Action Lab action on the case (#7000 r3s3).
        or exists (select 1 from public.organization_object_action_runs a
          where a.target_kind = 'member_case' and a.target_id = target and a.actor_user_id is distinct from caller)
        or exists (select 1 from public.member_admin_audit a
          where a.action = 'grievance_identity_visibility_updated' and a.detail ->> 'caseId' = target::text
            and a.actor is distinct from caller)
        or exists (select 1 from private.casework_record_versions v
          where v.case_id = target and v.actor is not null and v.actor is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if p_entry ->> 'action_kind' = 'case_create' then
    update public.member_cases c set learning_undone_at = pg_catalog.clock_timestamp()
    where c.id = target and c.learning_undone_at is null;
    -- A form the case was opened from can be opened as a case again.
    update public.member_forms f set case_id = null, updated_at = pg_catalog.now() where f.case_id = target;
    -- An intake report converted into the case goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
    return null;
  end if;
  earlier := private.learning_case_state_from(
    (select v.old_row from private.casework_record_versions v where v.id = (p_entry ->> 'before_ref')::bigint));
  if earlier is null then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  update public.member_cases c
  set title = earlier ->> 'title', deadline = (earlier ->> 'deadline')::date, case_type = earlier ->> 'case_type',
      articles = earlier ->> 'articles', status = earlier ->> 'status', description = earlier ->> 'description',
      filing_status = earlier ->> 'filing_status', incident_date = (earlier ->> 'incident_date')::date,
      remedy_sought = earlier ->> 'remedy_sought'
  where c.id = target;
  -- The step guard fires only on a real change; a step the edit did not
  -- move is left alone.
  if case_row.step is distinct from earlier ->> 'step' then
    if private.casework_resolve_procedure(case_row.organization_id, case_row.chapter_id, case_row.case_type) is not null then
      perform private.learning_reverse_transition(target, case_row.step, earlier ->> 'step');
    end if;
    update public.member_cases c set step = earlier ->> 'step' where c.id = target;
  end if;
  return null;
end;
end;
$function$;

-- The task handler restores a converted intake report (re-emitted from 20261104075000).
create or replace function private.learning_undo_task(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  task_row public.chapter_tasks%rowtype;
  wanted uuid[];
  current_ids uuid[];
  was_live boolean;
  caller_name text;
  recipient uuid;
begin
  if p_mode = 'lock' then
    perform 1 from public.chapter_tasks t where t.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_task_state(target) - 'order_index';
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'task_create' then return null; end if;
    return image - 'order_index';
  elsif p_mode = 'check' then
    -- Today's rule for changing a task: staff of the task's own chapter.
    select t.* into task_row
    from public.chapter_tasks t
    join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
    where t.id = target;
    if task_row.id is null or not private.member_has_chapter_role(task_row.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'you can no longer change this task' using errcode = '42501';
    end if;
    -- Undoing a creation hides the task; refuse when someone else's
    -- check-off work hangs off it, which would be hidden with it.
    if p_entry ->> 'action_kind' = 'task_create' and (
        exists (select 1 from private.task_checkoff_lists l where l.task_id = target and l.created_by is distinct from caller)
        or exists (select 1 from private.task_checkoff_entries e
          where e.task_id = target and e.actioned_by is not null and e.actioned_by is distinct from caller)) then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    -- A report the record was converted from must still stand as conversion
    -- left it; anyone's later triage refuses the undo.
    if not private.learning_intake_report_unchanged(p_entry -> 'before_image' -> 'intake_report') then
      raise exception 'someone else has changed this since' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  select p.full_name into caller_name from public.member_profiles p where p.id = caller;
  if p_entry ->> 'action_kind' = 'task_create' then
    update public.chapter_tasks t
    set deleted_at = pg_catalog.now(), deleted_by = caller
    where t.id = target and t.deleted_at is null
    returning t.* into task_row;
    -- The task goes away as a deletion does, and its assignee hears so.
    if task_row.assignee_id is not null and task_row.assignee_id <> caller then
      perform private.notify_member(task_row.assignee_id, 'task.deleted',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
    -- An intake report converted into the task goes back to how it stood.
    perform private.learning_restore_intake_report(p_entry -> 'before_image' -> 'intake_report');
    return null;
  end if;

  select t.deleted_at is null into was_live from public.chapter_tasks t where t.id = target;

  update public.chapter_tasks t
  set title = image ->> 'title',
      description = image ->> 'description',
      status = image ->> 'status',
      priority = image ->> 'priority',
      workstream = image ->> 'workstream',
      start_date = (image ->> 'start_date')::date,
      due_date = (image ->> 'due_date')::date,
      progress = (image ->> 'progress')::smallint,
      blocked = (image ->> 'blocked')::boolean,
      milestone = (image ->> 'milestone')::boolean,
      task_type = image ->> 'task_type',
      order_index = coalesce((image ->> 'order_index')::integer, t.order_index),
      deleted_at = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_at, pg_catalog.now()) end,
      deleted_by = case when (image ->> 'live')::boolean then null else coalesce(t.deleted_by, caller) end
  where t.id = target
  returning t.* into task_row;

  -- Assignees as they were, in order, the way set_chapter_task_assignees
  -- writes them, and told the way it tells them: the task's own trigger
  -- notifies the primary assignee it gains or loses, and each co-assignee
  -- added or removed hears so here. What was already sent stays sent; each
  -- person's newest notice matches the task again.
  select coalesce(pg_catalog.array_agg(e.id::uuid order by e.position), '{}') into wanted
  from pg_catalog.jsonb_array_elements_text(coalesce(image -> 'assignee_ids', '[]'::jsonb)) with ordinality as e(id, position);
  select coalesce(pg_catalog.array_agg(a.assignee_id order by a.position), '{}') into current_ids
  from public.chapter_task_assignments a where a.task_id = target;
  if wanted is distinct from current_ids then
    delete from public.chapter_task_assignments a where a.task_id = target;
    insert into public.chapter_task_assignments (task_id, chapter_id, assignee_id, position, assigned_by)
    select target, task_row.chapter_id, ids.assignee_id, ids.ordinality - 1, caller
    from pg_catalog.unnest(wanted) with ordinality as ids(assignee_id, ordinality);
  end if;
  if task_row.assignee_id is distinct from wanted[1] then
    perform pg_catalog.set_config('sg.setting_task_assignees', '1', true);
    update public.chapter_tasks t set assignee_id = wanted[1] where t.id = target;
    -- Only this update skips the assignment sync; later writes in the same
    -- undo (or transaction) get it again.
    perform pg_catalog.set_config('sg.setting_task_assignees', '', true);
  end if;
  for recipient in
    select id from pg_catalog.unnest(wanted) id
    where not (id = any(current_ids)) and id is distinct from wanted[1] and id <> caller
  loop
    perform private.notify_member(recipient, 'task.assigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  for recipient in
    select id from pg_catalog.unnest(current_ids) id
    where not (id = any(wanted)) and id is distinct from task_row.assignee_id and id <> caller
  loop
    perform private.notify_member(recipient, 'task.unassigned',
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end loop;
  -- Putting a deleted task back, or taking a restored one away, tells its
  -- assignee the way soft_delete_chapter_task and restore_chapter_task do,
  -- so the last notice they hold matches the task.
  if was_live is distinct from (image ->> 'live')::boolean
     and wanted[1] is not null and wanted[1] <> caller then
    perform private.notify_member(wanted[1],
      case when (image ->> 'live')::boolean then 'task.restored' else 'task.deleted' end,
      pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
  end if;
  return null;
end;
end;
$function$;

-- An outcome kept for its size keeps its status change (re-emitted from 20261104075000).
create or replace function public.coordinator_record_case_outcome(p_case_id uuid, p_outcome text, p_summary text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare learning_parent uuid; learning_image jsonb; c public.member_cases%rowtype; prior public.member_case_outcomes%rowtype; saved public.member_case_outcomes%rowtype; clean_summary text := btrim(coalesce(p_summary,''));
begin
  c := private.coordinator_case_for_update(p_case_id);
  if p_outcome not in ('upheld','settled','withdrawn','denied','other') then raise exception 'invalid outcome' using errcode='22023'; end if;
  if char_length(clean_summary) not between 1 and 4000 then raise exception 'summary must be 1-4000 characters' using errcode='22023'; end if;
  select * into prior from public.member_case_outcomes where case_id=c.id;
  insert into public.member_case_outcomes(case_id,user_id,outcome,summary,recorded_by)
  values(c.id,c.user_id,p_outcome,clean_summary,(select auth.uid()))
  on conflict(case_id) do update set outcome=excluded.outcome,summary=excluded.summary,recorded_by=excluded.recorded_by,updated_at=now()
  returning * into saved;
  update public.member_cases set status='resolved' where id=c.id;
  -- One action: the status change is the parent, the outcome its child.
  learning_parent := private.learning_case_journal('case_edit', c.id, null);
  learning_image := case when prior.case_id is null then '{"existed": false}'::jsonb
    else pg_catalog.jsonb_build_object('existed', true, 'outcome', prior.outcome, 'summary', prior.summary, 'recorded_by', prior.recorded_by) end;
  -- The journal bounds a before-image by bytes (16,384); an earlier summary
  -- that does not fit keeps this outcome as recorded rather than block it.
  if pg_catalog.octet_length(learning_image::text) <= 16384 then
    perform private.learning_journal_append('case_outcome', 'public.member_case_outcomes', c.id::text, learning_parent,
      private.learning_fingerprint(private.learning_case_outcome_state(c.id)), null, learning_image);
  else
    perform private.learning_journal_append('case_outcome_kept', 'public.member_case_outcomes', c.id::text, learning_parent);
    -- The status change is the same action: keep it too, so the action is
    -- refused as a whole rather than partly undone.
    update private.learning_action_journal j
    set state = 'kept', kept_at = pg_catalog.clock_timestamp(), before_image = null, version = j.version + 1
    where j.id = learning_parent and j.state = 'active';
  end if;
  insert into public.coordinator_case_audit(case_id,user_id,actor_id,action,before_value,after_value)
  values(c.id,c.user_id,(select auth.uid()),'outcome_recorded',
    case when prior.case_id is null then null else jsonb_build_object('outcome',prior.outcome,'summary',prior.summary) end,
    jsonb_build_object('outcome',saved.outcome,'summary',saved.summary,'status','resolved'));
  return jsonb_build_object('caseId',saved.case_id,'outcome',saved.outcome,'summary',saved.summary,'recordedAt',saved.recorded_at,'updatedAt',saved.updated_at);
end;
end;
$$;

-- Case workflow writers journal their action, the graph lock first.
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
  perform private.learning_casework_journal('casework_step_advance', p_case_id);
  return v_transition;
end;

end;
$function$;

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
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
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
  perform private.learning_casework_journal('casework_deadline_create', p_case_id);
  return v_row;
end;
end;
$function$;

create or replace function public.casework_set_deadline_status(p_deadline_id uuid, p_status text)
returns public.casework_deadlines
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  v_deadline public.casework_deadlines%rowtype;
  v_previous text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  select * into v_deadline from public.casework_deadlines where id = p_deadline_id;
  if not found or not private.casework_staff_can_access(v_deadline.case_id) then
    raise exception 'deadline not found' using errcode = 'P0002';
  end if;
  if p_status is null or p_status not in ('met', 'waived', 'active') then
    raise exception 'invalid deadline status' using errcode = '22023';
  end if;
  select * into strict v_deadline from public.casework_deadlines where id = p_deadline_id for update;
  v_previous := v_deadline.status;
  if v_previous = p_status then
    return v_deadline;
  end if;
  update public.casework_deadlines set status = p_status, updated_at = pg_catalog.now()
    where id = v_deadline.id returning * into v_deadline;
  insert into public.casework_audit_events
    (organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()),
    'deadline_decided', 'deadline', v_deadline.id,
    pg_catalog.jsonb_build_object('decision', p_status, 'previousStatus', v_previous));
  perform private.learning_casework_journal('casework_deadline_status', v_deadline.case_id);
  return v_deadline;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.casework_request_deadline_extension(p_deadline_id uuid, p_requested_due_at timestamp with time zone, p_reason text, p_idempotency_key uuid)
 RETURNS public.casework_deadline_extensions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_deadline public.casework_deadlines%rowtype; v_row public.casework_deadline_extensions%rowtype;
begin
  perform private.casework_require_mfa();
  select * into strict v_deadline from public.casework_deadlines where id = p_deadline_id for share;
  if not private.casework_can_read(v_deadline.case_id) or not (private.casework_member_owns(v_deadline.case_id) or private.casework_staff_can_access(v_deadline.case_id)) then raise exception 'deadline not found' using errcode = 'P0002'; end if;
  if p_requested_due_at <= v_deadline.due_at or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 8 and 2000 then raise exception 'invalid extension request' using errcode = '22023'; end if;
  insert into public.casework_deadline_extensions(deadline_id, organization_id, requested_by, previous_due_at, requested_due_at, reason, idempotency_key)
  values (v_deadline.id, v_deadline.organization_id, (select auth.uid()), v_deadline.due_at, p_requested_due_at, pg_catalog.btrim(p_reason), p_idempotency_key)
  on conflict (organization_id, requested_by, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()), 'deadline_requested', 'deadline_extension', v_row.id, pg_catalog.jsonb_build_object('deadlineId', v_deadline.id));
  perform private.learning_casework_journal('casework_extension_request', v_deadline.case_id);
  return v_row;
end;
end;
$function$
;

create or replace function public.casework_decide_deadline_extension(
  p_extension_id uuid,
  p_decision text,
  p_note text default null
)
returns public.casework_deadline_extensions
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_extension public.casework_deadline_extensions%rowtype; v_deadline public.casework_deadlines%rowtype;
begin
  perform private.casework_require_mfa();
  if p_decision not in ('approved','denied') then raise exception 'invalid decision' using errcode = '22023'; end if;
  select * into strict v_extension from public.casework_deadline_extensions where id = p_extension_id for update;
  select * into strict v_deadline from public.casework_deadlines where id = v_extension.deadline_id for update;
  if not private.casework_staff_can_access(v_deadline.case_id) then raise exception 'extension not found' using errcode = 'P0002'; end if;
  if v_extension.status <> 'requested' then return v_extension; end if;
  update public.casework_deadline_extensions set status = p_decision, decided_by = (select auth.uid()), decided_at = pg_catalog.now(), decision_note = nullif(pg_catalog.btrim(p_note), '')
  where id = v_extension.id returning * into v_extension;
  if p_decision = 'approved' then
    update public.casework_deadlines set due_at = v_extension.requested_due_at, status = 'extended', updated_at = pg_catalog.now() where id = v_deadline.id;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_deadline.organization_id, v_deadline.chapter_id, v_deadline.case_id, (select auth.uid()), 'deadline_decided', 'deadline_extension', v_extension.id, pg_catalog.jsonb_build_object('decision', p_decision));
  perform private.learning_casework_journal('casework_extension_decide', v_deadline.case_id);
  return v_extension;
end;
end;
$function$;

create or replace function public.casework_set_checklist_item(p_item_id uuid, p_completed boolean)
returns public.casework_checklist_items
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_item public.casework_checklist_items%rowtype; v_checklist public.casework_checklists%rowtype;
begin
  perform private.casework_require_mfa();
  select c.* into strict v_checklist
  from public.casework_checklists c join public.casework_checklist_items i on i.checklist_id = c.id
  where i.id = p_item_id for update of c;
  if not private.casework_staff_can_access(v_checklist.case_id) then raise exception 'checklist item not found' using errcode = 'P0002'; end if;
  update public.casework_checklist_items set
    completed_at = case when p_completed then pg_catalog.now() else null end,
    completed_by = case when p_completed then (select auth.uid()) else null end
  where id = p_item_id returning * into v_item;
  update public.casework_checklists set completed_at = case
    when exists (select 1 from public.casework_checklist_items i where i.checklist_id = v_checklist.id and i.completed_at is null) then null
    else pg_catalog.now()
  end where id = v_checklist.id;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_checklist.organization_id, v_checklist.chapter_id, v_checklist.case_id, (select auth.uid()), 'checklist_item_changed', 'checklist_item', v_item.id, pg_catalog.jsonb_build_object('completed', p_completed));
  perform private.learning_casework_journal('casework_checklist_item', v_checklist.case_id);
  return v_item;
end;
end;
$function$;

create or replace function public.casework_set_reminder_status(p_reminder_id uuid, p_action text, p_remind_at timestamptz)
returns public.casework_reminders
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_row public.casework_reminders%rowtype;
begin
  perform private.casework_require_mfa();
  if p_action not in ('scheduled','snoozed','completed','dismissed') then raise exception 'invalid reminder action' using errcode = '22023'; end if;
  select * into strict v_row from public.casework_reminders where id = p_reminder_id and owner_user_id = (select auth.uid()) for update;
  if p_action = 'snoozed' and p_remind_at is null then raise exception 'snooze time required' using errcode = '22023'; end if;
  update public.casework_reminders set status = p_action,
    remind_at = case when p_action = 'snoozed' then p_remind_at else remind_at end,
    completed_at = case when p_action in ('completed','dismissed') then pg_catalog.now() else null end,
    updated_at = pg_catalog.now()
  where id = v_row.id returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'reminder_changed', 'reminder', v_row.id, pg_catalog.jsonb_build_object('status', p_action));
  perform private.learning_casework_journal('casework_reminder_status', v_row.case_id);
  return v_row;
end;
end;
$function$;

create or replace function public.casework_save_intake_draft(
  p_draft_id uuid,
  p_chapter_id text,
  p_member_user_id uuid,
  p_case_id uuid,
  p_payload jsonb,
  p_expected_revision integer
)
returns public.casework_intake_drafts
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare v_org uuid; v_row public.casework_intake_drafts%rowtype;
begin
  perform private.casework_require_mfa();
  select c.organization_id into strict v_org from public.chapters c where c.id = p_chapter_id;
  if v_org is null or not private.member_has_chapter_role(p_chapter_id, array['steward','coordinator','advisor','admin','vp']) then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' or pg_catalog.pg_column_size(p_payload) > 32768 then raise exception 'invalid draft payload' using errcode = '22023'; end if;
  if p_case_id is not null and not private.casework_scope_matches(p_case_id, v_org, p_chapter_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_draft_id is null then
    insert into public.casework_intake_drafts(organization_id, chapter_id, owner_user_id, member_user_id, case_id, payload)
    values (v_org, p_chapter_id, (select auth.uid()), p_member_user_id, p_case_id, p_payload) returning * into v_row;
  else
    update public.casework_intake_drafts set member_user_id = p_member_user_id, case_id = p_case_id, payload = p_payload, revision = revision + 1, updated_at = pg_catalog.now()
    where id = p_draft_id and owner_user_id = (select auth.uid()) and revision = p_expected_revision returning * into v_row;
    if not found then raise exception 'draft changed' using errcode = '40001'; end if;
  end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_org, p_chapter_id, p_case_id, (select auth.uid()), 'draft_saved', 'intake_draft', v_row.id, pg_catalog.jsonb_build_object('revision', v_row.revision));
  perform private.learning_casework_journal('casework_draft_save', null, true);
  return v_row;
end;
end;
$function$;

create or replace function public.casework_score_case(
  p_case_id uuid,
  p_inputs jsonb,
  p_idempotency_key uuid
)
returns public.casework_strength_analyses
language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  v_case public.member_cases%rowtype;
  v_score integer;
  v_row public.casework_strength_analyses%rowtype;
  v_recommendations jsonb := '[]'::jsonb;
begin
  perform private.casework_require_mfa();
  if not private.casework_staff_can_access(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if p_inputs is null or pg_catalog.jsonb_typeof(p_inputs) <> 'object'
     or p_inputs - array['facts','documentation','timeliness','contract_support','witnesses'] <> '{}'::jsonb then
    raise exception 'invalid scoring inputs' using errcode = '22023';
  end if;
  select * into strict v_case from public.member_cases where id = p_case_id for share;
  v_score := 4 * (
    greatest(0, least(5, coalesce((p_inputs->>'facts')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'documentation')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'timeliness')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'contract_support')::integer, 0)))
    + greatest(0, least(5, coalesce((p_inputs->>'witnesses')::integer, 0)))
  );
  if coalesce((p_inputs->>'documentation')::integer, 0) < 3 then v_recommendations := v_recommendations || '["strengthen_documentation"]'::jsonb; end if;
  if coalesce((p_inputs->>'timeliness')::integer, 0) < 3 then v_recommendations := v_recommendations || '["review_deadlines"]'::jsonb; end if;
  if coalesce((p_inputs->>'contract_support')::integer, 0) < 3 then v_recommendations := v_recommendations || '["confirm_contract_support"]'::jsonb; end if;
  insert into public.casework_strength_analyses(case_id, organization_id, chapter_id, analyzed_by, inputs, score, band, recommendations, idempotency_key)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, (select auth.uid()), p_inputs, v_score,
    case when v_score < 45 then 'needs_evidence' when v_score < 75 then 'developing' else 'strong' end,
    v_recommendations, p_idempotency_key)
  on conflict (organization_id, analyzed_by, idempotency_key) do update set idempotency_key = excluded.idempotency_key
  returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'strength_scored', 'strength_analysis', v_row.id, pg_catalog.jsonb_build_object('score', v_row.score, 'band', v_row.band));
  perform private.learning_casework_journal('casework_case_score', p_case_id);
  return v_row;
exception when invalid_text_representation then raise exception 'scoring inputs must be integers' using errcode = '22023';
end;
end;
$function$;

create or replace function public.casework_save_macro(
  p_macro_id uuid,
  p_chapter_id text,
  p_name text,
  p_actions jsonb,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  learning_image jsonb := '{"existed": false}'::jsonb;
  v_org uuid;
  v_chapter text;
  v_name text;
  v_macro public.casework_macros%rowtype;
begin
  -- casework_macros carries a created_by reference into auth.users, so it is a
  -- case graph relation: the gate precedes the MFA read and the upsert.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  v_chapter := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  perform private.casework_require_mfa();
  if pg_catalog.char_length(v_name) not between 2 and 120 then
    raise exception 'macro name must be 2-120 characters' using errcode = '22023';
  end if;
  if not private.casework_macro_actions_valid(p_actions) then
    raise exception 'macro actions are not a valid ordered action list' using errcode = '22023';
  end if;

  -- Scope decides the organization the macro belongs to. An organization-wide
  -- macro is owned by the caller's own selected staff organization; a chapter
  -- macro is owned by the chapter's organization.
  if v_chapter is null then
    v_org := (select private.current_mobile_staff_organization());
    if v_org is null then
      raise exception 'organization admin role required' using errcode = '42501';
    end if;
  else
    select c.organization_id into v_org from public.chapters c where c.id = v_chapter;
    if v_org is null then raise exception 'chapter not found' using errcode = 'P0002'; end if;
  end if;

  -- One audience, one call. This is the same function casework_list_macros()
  -- and casework_macros_staff_read evaluate, with the authorship term added,
  -- so a save that succeeds here is a row this caller can list and re-open.
  if not private.casework_macro_audience(v_org, v_chapter, true) then
    raise exception 'macro authorship requires the scope write role and the staff role that reads the macro'
      using errcode = '42501', hint = 'casework_macro_audience';
  end if;

  if p_macro_id is null then
    insert into public.casework_macros(organization_id, chapter_id, name, actions, active, created_by)
    values (v_org, v_chapter, v_name, p_actions, coalesce(p_active, true), (select auth.uid()))
    returning * into v_macro;
  else
    select * into v_macro from public.casework_macros where id = p_macro_id for update;
    if v_macro.id is null then raise exception 'macro not found' using errcode = 'P0002'; end if;
    learning_image := private.learning_casework_macro_state(v_macro.id);
    -- Re-scoping a macro would move it past the role check that created it.
    if v_macro.organization_id <> v_org or v_macro.chapter_id is distinct from v_chapter then
      raise exception 'macro scope cannot change' using errcode = '42501';
    end if;
    update public.casework_macros
      set name = v_name, actions = p_actions,
          active = coalesce(p_active, v_macro.active), updated_at = pg_catalog.now()
      where id = v_macro.id
      returning * into v_macro;
  end if;

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_macro.organization_id, v_macro.chapter_id, null, (select auth.uid()),
    'macro_saved', 'macro', v_macro.id,
    pg_catalog.jsonb_build_object(
      'actionCount', pg_catalog.jsonb_array_length(v_macro.actions), 'active', v_macro.active));

  -- The journal bounds a before-image by bytes; a macro too large to keep
  -- one is recorded as saved, never blocked.
  if pg_catalog.octet_length(learning_image::text) <= 16384 then
    perform private.learning_journal_append('casework_macro_save', 'public.casework_macros', v_macro.id::text, null,
      private.learning_fingerprint(private.learning_casework_macro_state(v_macro.id)), null, learning_image);
  else
    perform private.learning_journal_append('casework_macro_save_kept', 'public.casework_macros', v_macro.id::text);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', v_macro.id, 'name', v_macro.name, 'chapterId', v_macro.chapter_id,
    'actions', v_macro.actions, 'active', v_macro.active, 'updatedAt', v_macro.updated_at);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.convert_member_intake_report(p_report_id uuid, p_target text, p_space_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  learning_parent uuid;
  learning_report jsonb;
  caller uuid := (select auth.uid());
  report_row public.member_intake_reports%rowtype;
  updated public.member_intake_reports%rowtype;
  target_id uuid;
  attachment_id uuid;
  ref text;
  attempts integer := 0;
  case_type text;
  outcome_owner uuid;
  outcome_owner_name text;
  outcome_owner_is_steward boolean := false;
  outcome_owner_is_coordinator boolean := false;
  task_workstream text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;
  if p_target is null or p_target not in ('case', 'task', 'thread') then
    raise exception 'invalid intake conversion target' using errcode = '22023';
  end if;

  select r.* into report_row
  from public.member_intake_reports r
  join (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = r.chapter_id
  where r.id = p_report_id
  for update of r;

  if report_row.id is null then
    raise exception 'intake report unavailable' using errcode = '22023';
  end if;
  -- A retried request is safe. Repeating the same target returns the existing
  -- result; changing targets after conversion is refused.
  if pg_catalog.num_nonnulls(report_row.case_id, report_row.task_id, report_row.thread_id) > 0 then
    target_id := case p_target
      when 'case' then report_row.case_id
      when 'task' then report_row.task_id
      when 'thread' then report_row.thread_id
    end;
    if target_id is null then
      raise exception 'intake report already converted to another target' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'report', pg_catalog.to_jsonb(report_row),
      'target', p_target,
      'targetId', target_id
    );
  end if;
  if report_row.status = 'closed' then
    raise exception 'closed intake reports cannot be converted' using errcode = '22023';
  end if;

  if p_target = 'case' then
    case_type := case report_row.category when 'safety' then 'Safety' else 'Other' end;
    outcome_owner := coalesce(report_row.assigned_to, caller);
    select p.full_name,
           exists (select 1 from public.member_roles r where r.user_id = p.id and r.role = 'steward'),
           exists (select 1 from public.member_roles r where r.user_id = p.id and r.role = 'coordinator')
      into outcome_owner_name, outcome_owner_is_steward, outcome_owner_is_coordinator
    from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p
    where p.id = outcome_owner and p.chapter_id = report_row.chapter_id;
    loop
      attempts := attempts + 1;
      ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix();
      begin
        insert into public.member_cases (
          user_id, reference, title, case_type, articles, step, status,
          steward_user_id, steward_name, coordinator_user_id, coordinator_name, assigned_at
        ) values (
          report_row.reporter_id,
          ref,
          pg_catalog.left('Intake follow-up: ' || report_row.title, 200),
          case_type,
          '',
          'Intake',
          'active',
          case when outcome_owner_is_steward then outcome_owner else null end,
          case when outcome_owner_is_steward then outcome_owner_name else null end,
          case when outcome_owner_is_coordinator then outcome_owner else null end,
          case when outcome_owner_is_coordinator then outcome_owner_name else null end,
          case when outcome_owner_is_steward or outcome_owner_is_coordinator then now() else null end
        ) returning id into target_id;
        exit;
      exception when unique_violation then
        if attempts >= 5 then
          raise exception 'could not allocate a case reference' using errcode = '23505';
        end if;
      end;
    end loop;
  elsif p_target = 'task' then
    -- Standard Task defaults are deliberate. Sensitive report text is not
    -- copied into the card; the attachment is an authorized in-app link whose
    -- destination remains protected by intake RLS.
    -- `General` is preferred while it exists, but workstream rename is a
    -- supported chapter operation. Lock the chosen row so a concurrent rename
    -- cannot invalidate it between selection and the task trigger's check.
    select w.name into task_workstream
    from public.chapter_workstreams w
    where w.chapter_id = report_row.chapter_id
    order by (w.name = 'General') desc, w.name, w.id
    limit 1
    for key share of w;

    if task_workstream is null then
      raise exception 'chapter has no available task workstream' using errcode = '22023';
    end if;

    insert into public.chapter_tasks (
      title, description, status, priority, task_type, workstream,
      assignee_id, start_date, due_date, progress, blocked, milestone, order_index
    ) values (
      'Follow up on intake report', '', 'to_do', 'medium', 'general', task_workstream,
      null, null, null, 0, false, false, 0
    ) returning id into target_id;

    insert into public.chapter_task_attachments (
      task_id, chapter_id, label, record_url, created_by
    ) values (
      target_id,
      report_row.chapter_id,
      'Authorized intake report',
      '/m/organize?intake=' || report_row.id::text,
      caller
    ) returning id into attachment_id;

    insert into public.chapter_task_activity (
      task_id, chapter_id, actor_id, action, to_value
    ) values (
      target_id, report_row.chapter_id, caller, 'attachment_added', attachment_id::text
    );
  else
    if p_space_id is null or not exists (
      select 1
      from public.chapter_spaces s
      where s.id = p_space_id
        and s.chapter_id = report_row.chapter_id
        and s.archived_at is null
        and private.can_read_chapter_space(s)
    ) then
      raise exception 'choose an available same-chapter space' using errcode = '22023';
    end if;

    insert into public.chapter_threads (space_id, title, kind)
    values (p_space_id, 'Intake follow-up', 'intake')
    returning id into target_id;
  end if;

  update public.member_intake_reports r
     set status = 'in_progress',
         assigned_to = coalesce(r.assigned_to, caller),
         case_id = case when p_target = 'case' then target_id else null end,
         task_id = case when p_target = 'task' then target_id else null end,
         thread_id = case when p_target = 'thread' then target_id else null end
   where r.id = report_row.id
  returning r.* into updated;

  -- The created case or task keeps the report as it stood and as conversion
  -- left it, so undoing the creation puts the report back.
  learning_report := pg_catalog.jsonb_build_object('intake_report', pg_catalog.jsonb_build_object('id', report_row.id,
    'before', private.learning_intake_report_fields(report_row), 'after', private.learning_intake_report_fields(updated)));
  if p_target = 'case' then
    perform private.learning_casework_journal('case_intake_convert', target_id, false, learning_report);
  elsif p_target = 'task' then
    learning_parent := private.learning_journal_append('task_create', 'public.chapter_tasks', target_id::text, null,
      private.learning_fingerprint(private.learning_task_state(target_id) - 'order_index'), null, learning_report);
    perform private.learning_journal_append('task_link_add', 'public.chapter_task_attachments', attachment_id::text, learning_parent,
      private.learning_fingerprint(private.learning_task_edge_state('public.chapter_task_attachments', attachment_id::text)), null, '{}'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'report', pg_catalog.to_jsonb(updated),
    'target', p_target,
    'targetId', target_id
  );
end;
end;
end;
$function$
;

create or replace function public.commit_member_operations_import(
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := private.require_member_operations_admin();
  batch public.organization_import_batches%rowtype;
  imported integer := 0;
  row_item public.organization_import_rows%rowtype;
  request_payload jsonb := pg_catalog.jsonb_build_object('batchId', p_batch_id);
  prior jsonb;
  result jsonb;
  validation_result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'commit_member_operations_import', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  select * into batch from public.organization_import_batches where id = p_batch_id and organization_id = org for update;
  if not found or batch.state <> 'validated' then raise exception 'batch must be validated' using errcode = '55000'; end if;
  validation_result := public.validate_member_operations_import(batch.id, extensions.gen_random_uuid());
  select * into batch from public.organization_import_batches
  where id = p_batch_id and organization_id = org for update;
  if batch.error_count > 0 or exists (select 1 from public.organization_import_rows row
    where row.batch_id = batch.id and row.organization_id = org
      and pg_catalog.jsonb_array_length(row.validation_errors) > 0) then
    result := validation_result || pg_catalog.jsonb_build_object(
      'state', 'validated', 'committed', false, 'reason', 'revalidation_failed'
    );
    perform private.member_operations_store_receipt(
      org, 'commit_member_operations_import', p_idempotency_key, request_payload, result
    );
    return result;
  end if;
  for row_item in select * from public.organization_import_rows row where row.batch_id = batch.id order by row.row_number for update
  loop
    if batch.kind = 'member' then
      insert into public.organization_member_operational_profiles as existing_profile (
        organization_id, member_user_id, member_number, job_title, department, work_location,
        hire_date, membership_class, preferred_language, administrative_notes, updated_by
      ) values (
        org, (row_item.normalized_data ->> '_resolved_member_id')::uuid,
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'member_number'), ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'job_title'), ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'department'), ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'work_location'), ''),
        nullif(row_item.normalized_data ->> 'hire_date', '')::date,
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'membership_class'), ''),
        nullif(row_item.normalized_data ->> 'preferred_language', ''),
        nullif(pg_catalog.btrim(row_item.normalized_data ->> 'administrative_notes'), ''),
        (select auth.uid())
      ) on conflict (organization_id, member_user_id) do update
        set member_number = case when row_item.normalized_data ? 'member_number'
              then excluded.member_number else existing_profile.member_number end,
            job_title = case when row_item.normalized_data ? 'job_title'
              then excluded.job_title else existing_profile.job_title end,
            department = case when row_item.normalized_data ? 'department'
              then excluded.department else existing_profile.department end,
            work_location = case when row_item.normalized_data ? 'work_location'
              then excluded.work_location else existing_profile.work_location end,
            hire_date = case when row_item.normalized_data ? 'hire_date'
              then excluded.hire_date else existing_profile.hire_date end,
            membership_class = case when row_item.normalized_data ? 'membership_class'
              then excluded.membership_class else existing_profile.membership_class end,
            preferred_language = case when row_item.normalized_data ? 'preferred_language'
              then excluded.preferred_language else existing_profile.preferred_language end,
            administrative_notes = case when row_item.normalized_data ? 'administrative_notes'
              then excluded.administrative_notes else existing_profile.administrative_notes end,
            version = existing_profile.version + 1,
            updated_by = excluded.updated_by, updated_at = pg_catalog.now();
    else
      insert into public.member_cases (
        user_id, organization_id, chapter_id, reference, title, deadline, case_type, articles, step, status
      ) values (
        (row_item.normalized_data ->> '_resolved_member_id')::uuid, org,
        row_item.normalized_data ->> 'chapter_id', pg_catalog.btrim(row_item.normalized_data ->> 'reference'),
        pg_catalog.btrim(row_item.normalized_data ->> 'title'), nullif(row_item.normalized_data ->> 'deadline', '')::date,
        'Other', coalesce(row_item.normalized_data ->> 'articles', ''), 'Intake', 'active'
      );
    end if;
    imported := imported + 1;
  end loop;
  update public.organization_import_batches set state = 'committed', committed_at = pg_catalog.now() where id = batch.id;
  perform private.mi1_w2_write_audit(org, 'member_operations_import_committed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'batchId', batch.id, 'kind', batch.kind, 'count', imported
  ));
  result := pg_catalog.jsonb_build_object(
    'id', batch.id, 'state', 'committed', 'importedCount', imported
  );
  perform private.member_operations_store_receipt(
    org, 'commit_member_operations_import', p_idempotency_key, request_payload, result
  );
  perform private.learning_casework_journal('case_operations_import', null, true);
  return result;
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Review
-- ---------------------------------------------------------------------------
-- The casework journal and the engine helpers it newly reaches on the
-- reviewed account-lifecycle surface are reviewed at their current
-- definitions; nothing else is waived.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where s.kind = 'function'
  and s.schema_name = 'private' and pg_catalog.split_part(s.object_name, '(', 1) in
    ('learning_casework_journal', 'learning_case_state_from', 'learning_fingerprint', 'learning_journal_append', 'learning_period_running')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_case_workflow_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after case workflow under learning';
  end if;
end;
$assert_case_workflow_trigger_review$;

notify pgrst, 'reload schema';
commit;
