-- BUG-UG-STEWARD-DEADLINE-LIST-OVERDUE-EASTERN-DAY-20261102 (#6745;
-- follow-up to 20261031010000, #6648).
--
-- 1. public.list_steward_case_deadlines decided overdue as
--    `due_on < current_date`: it dropped a clock's time (a clock due at 9 AM
--    read "due" all afternoon, and a clock the sweep had already marked missed
--    still read "due"), and current_date is the session's UTC day, so from
--    7 PM EST / 8 PM EDT today's Eastern items read overdue early. A
--    casework_deadlines row is now overdue when due_at < now() or it is
--    missed, the rule the deadline sweep (20261002143000) and the dashboard
--    tile already use; the case's own date deadline is overdue when it is
--    before the Eastern today. due_on, order, the 100-row cap and the
--    truncated flag are unchanged.
-- 2. member_case_updates.occurred_on defaults to the Eastern today, and
--    public.steward_add_case_note's fallback and date range use it, so a note
--    typed in the evening is no longer dated tomorrow.
--
-- The writer still takes private.lock_case_graph first and declares no
-- initializers (scripts/account-case-graph-inventory.mjs).

begin;
set local search_path = pg_catalog;

alter table public.member_case_updates
  alter column occurred_on set default ((pg_catalog.now() at time zone 'America/New_York')::date);
comment on column public.member_case_updates.occurred_on is
  'REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030: the date the note is about (a call, a meeting), distinct from created_at; defaults to the entry date on the Eastern calendar (BUG-UG-STEWARD-DEADLINE-LIST-OVERDUE-EASTERN-DAY-20261102), null on notes written before the column existed.';

create or replace function public.steward_add_case_note(p_case_id uuid, p_body text, p_occurred_on date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  v_case public.member_cases%rowtype;
  v_body text;
  v_today date;
  v_on date;
  v_inserted public.member_case_updates%rowtype;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[p_case_id]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  select c.* into v_case from public.member_cases c where c.id = p_case_id for update;
  -- Only the case's own steward, and only while they still hold staff
  -- authority in the case's own chapter and organization
  -- (private.casework_staff_can_access): a steward whose membership there was
  -- revoked keeps the assignment row but not the case. Any other case
  -- collapses to one refusal.
  if not found or v_case.steward_user_id is distinct from caller
     or not private.casework_staff_can_access(v_case.id) then
    raise exception 'case not found or not yours' using errcode = '42501';
  end if;
  v_body := pg_catalog.btrim(coalesce(p_body, ''));
  if pg_catalog.char_length(v_body) not between 1 and 4000 then
    raise exception 'note must be 1-4000 characters' using errcode = '22023';
  end if;
  -- Today on the Eastern calendar, the day the steward is living in; the
  -- session's current_date is the UTC day.
  v_today := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_on := coalesce(p_occurred_on, v_today);
  if v_on < v_today - 3650 or v_on > v_today + 1 then
    raise exception 'note date out of range' using errcode = '22023';
  end if;

  insert into public.member_case_updates(case_id, user_id, body, occurred_on)
  values (v_case.id, v_case.user_id, v_body, v_on)
  returning * into v_inserted;

  insert into public.casework_audit_events(
    organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, caller,
    'note_added', 'case_update', v_inserted.id,
    pg_catalog.jsonb_build_object('occurredOn', v_on, 'by', 'steward'));

  return pg_catalog.jsonb_build_object(
    'id', v_inserted.id, 'caseId', v_inserted.case_id, 'body', v_inserted.body,
    'occurredOn', v_inserted.occurred_on, 'createdAt', v_inserted.created_at);
end;
$function$;
revoke all on function public.steward_add_case_note(uuid, text, date) from public, anon, authenticated, service_role;
grant execute on function public.steward_add_case_note(uuid, text, date) to authenticated;
comment on function public.steward_add_case_note(uuid, text, date) is
  'REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030: the case''s own steward (steward hat, MFA) adds a dated note (default today on the Eastern calendar) without the coordinator role; audited as note_added.';

create or replace function public.list_steward_case_deadlines()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_build_object(
      'truncated', pg_catalog.count(*) > 100,
      'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', due.case_id, 'reference', due.reference, 'title', due.title,
      'kind', due.kind, 'label', due.label, 'dueOn', due.due_on,
      'overdue', due.overdue,
      'afterStepDue', due.after_step_due
    ) order by due.due_on, due.reference, due.kind) filter (where due.position <= 100), '[]'::jsonb))
    from (
      select merged.*, pg_catalog.row_number() over (order by merged.due_on, merged.reference, merged.kind) as position
      from (
        -- A clock is overdue once its moment has passed or the sweep has
        -- marked it missed (20261002143000), whatever the calendar day.
        select c.id as case_id, c.reference, c.title, d.kind, d.label,
               (d.due_at at time zone 'America/New_York')::date as due_on,
               (d.due_at < pg_catalog.now() or d.status = 'missed') as overdue,
               false as after_step_due
        from public.member_cases c
        join public.casework_deadlines d on d.case_id = c.id and d.status in ('active', 'extended', 'missed')
        where c.steward_user_id = caller and c.status = 'active'
          and private.casework_staff_can_access(c.id)
        union all
        -- The case's own deadline is a date: overdue from the next Eastern day.
        select c.id, c.reference, c.title, 'case', c.title, c.deadline,
               c.deadline < (pg_catalog.now() at time zone 'America/New_York')::date,
               exists (
                 select 1 from public.casework_deadlines step
                 where step.case_id = c.id and step.status in ('active', 'extended', 'missed') and step.kind = 'procedure'
                   and (step.due_at at time zone 'America/New_York')::date < c.deadline)
        from public.member_cases c
        where c.steward_user_id = caller and c.status = 'active' and c.deadline is not null
          and private.casework_staff_can_access(c.id)
      ) merged
      order by merged.due_on, merged.reference, merged.kind
      limit 101
    ) due
  ), pg_catalog.jsonb_build_object('truncated', false, 'rows', '[]'::jsonb));
end;
$function$;
revoke all on function public.list_steward_case_deadlines() from public, anon, authenticated, service_role;
grant execute on function public.list_steward_case_deadlines() to authenticated;
comment on function public.list_steward_case_deadlines() is
  'REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030: every open deadline on the active cases the caller holds as steward (open = active, extended or missed procedure and other casework deadlines plus the case deadline; each case also passes private.casework_staff_can_access), soonest first, at most 100 rows with a truncated flag, flagged after an open procedure step''s due date for a case deadline, and overdue when a clock''s due_at has passed or it is missed, or the case deadline is before the Eastern today (BUG-UG-STEWARD-DEADLINE-LIST-OVERDUE-EASTERN-DAY-20261102).';

notify pgrst, 'reload schema';

commit;
