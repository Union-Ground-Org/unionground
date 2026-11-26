-- REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030 (Oct 29-30
-- role-play run, findings 44 and 48; follow-up to #6572).
--
-- 1. Case notes carry the date they are about (occurred_on), distinct from
--    when they were typed (created_at). New notes default to today; notes
--    written before this keep a null date and show their entry time.
-- 2. public.steward_add_case_note: a steward adds a dated note to a case they
--    hold (steward_user_id = caller, steward hat), without the coordinator
--    role that casework_add_case_note requires.
-- 3. public.casework_case_history returns a note's occurredOn beside its body.
-- 4. public.list_steward_case_deadlines: one list of every open deadline on
--    the cases a steward holds (procedure step deadlines and the case's own
--    deadline), soonest first, with overdue and "after the current step's due
--    date" flags. A clock is open while active, extended or missed, the set
--    casework_case_signals already uses; the list says when it was cut at 100.
--
-- Both routines also require private.casework_staff_can_access on each case,
-- so the steward assignment alone never outlives the caller's authority in
-- that case's chapter and organization.
--
-- The writer takes private.lock_case_graph first and declares no
-- initializers (scripts/account-case-graph-inventory.mjs).

begin;

alter table public.member_case_updates add column occurred_on date;
alter table public.member_case_updates alter column occurred_on set default current_date;
alter table public.member_case_updates
  add constraint member_case_updates_occurred_on_range
    check (occurred_on is null or occurred_on between date '2000-01-01' and date '2100-12-31');
comment on column public.member_case_updates.occurred_on is
  'REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030: the date the note is about (a call, a meeting), distinct from created_at; defaults to the entry date, null on notes written before the column existed.';

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
  v_on := coalesce(p_occurred_on, current_date);
  if v_on < current_date - 3650 or v_on > current_date + 1 then
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
  'REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030: the case''s own steward (steward hat, MFA) adds a dated note (default today) without the coordinator role; audited as note_added.';

-- casework_case_history: the note row now carries occurredOn (null keys stripped).
create or replace function public.casework_case_history(p_case_id uuid, p_limit integer default 50, p_before timestamp with time zone default null::timestamp with time zone)
returns table(event_id text, kind text, at timestamp with time zone, actor_user_id uuid, actor_name text, actor_role text, details jsonb)
language sql
stable
set search_path = ''
as $function$
  with events as (
    -- The note author is readable by anyone the row's own RLS already admits.
    -- A note carries its writer in author_user_id (20260925110300); a note
    -- written before that column existed, or by a job with no session, keeps
    -- the case member attribution it always had.
    select 'note:' || n.id event_id, 'note'::text kind, n.created_at at, coalesce(n.author_user_id, n.user_id) actor_user_id,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('body', n.body, 'occurredOn', n.occurred_on)) details
    from public.member_case_updates n where n.case_id = p_case_id
    union all
    select 'transition:' || s.id, 'transition', s.created_at, s.transitioned_by,
      pg_catalog.jsonb_build_object('from_step', s.from_step, 'to_step', s.to_step, 'outcome', s.outcome)
    from public.casework_step_transitions s where s.case_id = p_case_id
    union all
    select 'assignment:' || a.id, 'assignment', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('before', a.before_assignment, 'after', a.after_assignment)
    from public.member_case_assignment_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'coordinator:' || a.id, 'coordinator', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('action', a.action, 'before', a.before_value, 'after', a.after_value, 'reason', a.reason)
    from public.coordinator_case_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'audit:' || a.id, 'audit', a.created_at, a.actor_user_id,
      pg_catalog.jsonb_build_object('action', a.event_type, 'metadata', a.metadata)
    from public.casework_audit_events a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select * from private.casework_history_versions(p_case_id)
  ), page as (
    select * from events where private.casework_can_read(p_case_id)
      and (p_before is null or events.at < p_before)
    order by events.at desc
    fetch first (greatest(1, least(coalesce(p_limit, 50), 100))) rows with ties
  -- Attribution is resolved under the CALLER's own visibility and nothing
  -- wider. public.member_profiles answers only for the accounts
  -- private.staff_visible_member_ids (the set-wise public.staff_can_see_user)
  -- already exposes, plus the caller's own row; the assignee labels stamped on
  -- public.member_cases are exactly the two staff names a member may already
  -- read on their own case, which is where the case detail's assignee line
  -- comes from. A member therefore names their own steward, their own
  -- coordinator and themselves, and no other staff account. An actor the
  -- caller may not name carries a role label instead: the uuid is never a
  -- display value.
  ), subject as (
    select c.user_id member_user_id, c.steward_user_id, c.steward_name,
      c.coordinator_user_id, c.coordinator_name
    from public.member_cases c where c.id = p_case_id
  -- A ROLE IS NOT ATTRIBUTION. The subject CTE above stays INVOKER because it
  -- carries the two assignee NAMES; a caller who cannot read the case row gets
  -- no names from it, which is the design. The role label is different: it says
  -- only which of three positions an actor the caller is ALREADY looking at
  -- occupies on this case. Deriving it from the same empty INVOKER read made an
  -- organization advisor see every event as 'staff', including the member's own
  -- note. private.casework_case_actor_roles is the definer helper that answers
  -- it, from the case row the existing definer read boundary already consults,
  -- for exactly the actor ids on this caller's own page and nothing else.
  ), roles as (
    select r.actor_user_id role_user_id, r.actor_role role_label
    from private.casework_case_actor_roles(
      p_case_id,
      -- `fetch first N rows with ties` can return more than the clamped page
      -- size, so the distinct actor list is capped here too. The helper's own
      -- guard is the authority; this keeps the reader provably inside it, and
      -- an id beyond the cap degrades to the historical 'staff' fallback below
      -- instead of raising in the feed.
      (select pg_catalog.array_agg(candidate.actor_user_id) from (
        select distinct page.actor_user_id from page
        where page.actor_user_id is not null limit 100
      ) candidate)
    ) r
  )
  select page.event_id, page.kind, page.at, page.actor_user_id,
    nullif(pg_catalog.btrim(coalesce(
      (select p.full_name from public.member_profiles p where p.id = page.actor_user_id),
      (select s.steward_name from subject s where s.steward_user_id = page.actor_user_id),
      (select s.coordinator_name from subject s where s.coordinator_user_id = page.actor_user_id),
      '')), ''),
    case
      when page.actor_user_id is null then null
      else coalesce((select r.role_label from roles r where r.role_user_id = page.actor_user_id), 'staff')
    end,
    page.details
  from page order by page.at desc, page.event_id desc;
$function$;


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
      'overdue', due.due_on < current_date,
      'afterStepDue', due.after_step_due
    ) order by due.due_on, due.reference, due.kind) filter (where due.position <= 100), '[]'::jsonb))
    from (
      select merged.*, pg_catalog.row_number() over (order by merged.due_on, merged.reference, merged.kind) as position
      from (
        select c.id as case_id, c.reference, c.title, d.kind, d.label,
               (d.due_at at time zone 'America/New_York')::date as due_on,
               false as after_step_due
        from public.member_cases c
        join public.casework_deadlines d on d.case_id = c.id and d.status in ('active', 'extended', 'missed')
        where c.steward_user_id = caller and c.status = 'active'
          and private.casework_staff_can_access(c.id)
        union all
        select c.id, c.reference, c.title, 'case', c.title, c.deadline,
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
  'REQ-UG-STEWARD-CASE-NOTES-AND-STEP-DEADLINES-20261030: every open deadline on the active cases the caller holds as steward (open = active, extended or missed procedure and other casework deadlines plus the case deadline; each case also passes private.casework_staff_can_access), soonest first, at most 100 rows with a truncated flag, flagged overdue and, for a case deadline, after an open procedure step''s due date.';

notify pgrst, 'reload schema';

commit;
