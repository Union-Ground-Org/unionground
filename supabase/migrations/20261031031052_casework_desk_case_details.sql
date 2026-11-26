-- REQ-UG-ALT-CASE-DESK-SERVER-READS-20261030 (follow-up of #6527,
-- gap lists for #6548 and #6614).
--
-- public.casework_desk_case_details: one bounded read for the alternate
-- shell's case desk. For each case id the caller passes (at most 100 per call)
-- and may work as staff (private.casework_staff_can_access), it returns:
--   openedAt      when the case was opened (member_cases.created_at);
--   closedAt      for a resolved case, when it was last closed, from the
--                 case's own field history (private.casework_record_versions);
--   outcome       the recorded outcome and its note, only where the caller
--                 already reads member_case_outcomes (the coordinator policy
--                 predicate public.staff_can_see_user(user_id, 'coordinator'));
--   clocks        the open contract clocks (casework_deadlines active,
--                 extended or missed, the open set casework_case_signals
--                 uses) other than hearings, soonest first, at most 25, each
--                 with its label and, for a procedure step clock whose rule
--                 is certain (see below), the step's deadline rule;
--   hearings      the open hearing deadlines, soonest first, at most 25;
--   statusEvents  the case's last 10 status changes (settle and reopen) with
--                 when, the status before and after, and who: a role label,
--                 the case's stamped steward or coordinator name when that is
--                 who acted, and byYou. No actor uuid is returned.
-- Case ids the caller cannot work are left out, never reported. The read
-- writes nothing: it is not an access record, so the desk keeps writing its
-- own viewed_case record when a case is opened, as before.

begin;

set local lock_timeout = '5s';

create function public.casework_desk_case_details(p_case_ids uuid[])
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
     or (select private.member_pin_session_restricted()) then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if p_case_ids is null or coalesce(pg_catalog.cardinality(p_case_ids), 0) > 100 then
    raise exception 'pass at most 100 case ids' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'caseId', c.id,
      'openedAt', c.created_at,
      'closedAt', case when c.status = 'resolved' then events.closed_at end,
      'outcome', outcome.value,
      'clocks', coalesce(clocks.value, '[]'::jsonb),
      'hearings', coalesce(hearings.value, '[]'::jsonb),
      'statusEvents', coalesce(events.value, '[]'::jsonb)
    ) order by c.id)
    from public.member_cases c
    left join lateral (
      select pg_catalog.jsonb_build_object('outcome', o.outcome, 'summary', o.summary, 'recordedAt', o.updated_at) as value
      from public.member_case_outcomes o
      where o.case_id = c.id and c.status = 'resolved'
        and public.staff_can_see_user(c.user_id, 'coordinator')
    ) outcome on true
    left join lateral (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', d.id, 'kind', d.kind, 'label', d.label, 'dueAt', d.due_at, 'status', d.status,
        'stepLabel', step.label, 'rule', step.deadline_rule
      ) order by d.due_at, d.id) as value
      from (
        select d.* from public.casework_deadlines d
        where d.case_id = c.id and d.kind <> 'hearing' and d.status in ('active', 'extended', 'missed')
        order by d.due_at, d.id
        limit 25
      ) d
      -- A procedure step clock is written in the same transaction as its step
      -- transition (public.casework_advance_step), so both carry the same
      -- now(); the step it entered names the rule that set the clock. No
      -- rule is snapshotted with the clock, so one is shown only when it is
      -- certain: exactly one transition of the case carries that now() (a
      -- macro can advance a case twice in one transaction), and the case's
      -- procedure has not been saved since the clock was set
      -- (public.casework_save_procedure replaces its steps and bumps
      -- updated_at). Otherwise the clock shows its label without a rule.
      left join lateral (
        select s.label, s.deadline_rule
        from public.casework_step_transitions t
        join public.casework_procedures p
          on p.id = private.casework_resolve_procedure(c.organization_id, c.chapter_id, c.case_type)
         and p.updated_at <= d.created_at
        join public.casework_procedure_steps s on s.procedure_id = p.id and s.key = t.to_step
        where d.kind = 'procedure' and t.case_id = d.case_id and t.created_at = d.created_at
          and (select pg_catalog.count(*) from public.casework_step_transitions same
               where same.case_id = d.case_id and same.created_at = d.created_at) = 1
      ) step on true
    ) clocks on true
    left join lateral (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id, 'label', h.label, 'dueAt', h.due_at, 'status', h.status
      ) order by h.due_at, h.id) as value
      from (
        select h.* from public.casework_deadlines h
        where h.case_id = c.id and h.kind = 'hearing' and h.status in ('active', 'extended', 'missed')
        order by h.due_at, h.id
        limit 25
      ) h
    ) hearings on true
    left join lateral (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'at', v.at,
        'from', v.old_row ->> 'status',
        'to', v.new_row ->> 'status',
        'actorRole', case
          when v.actor is null then null
          when v.actor = c.steward_user_id then 'steward'
          when v.actor = c.coordinator_user_id then 'coordinator'
          when v.actor = c.user_id then 'member'
          else 'staff' end,
        'actorName', case
          when v.actor is null then null
          when v.actor = c.steward_user_id then nullif(pg_catalog.btrim(coalesce(c.steward_name, '')), '')
          when v.actor = c.coordinator_user_id then nullif(pg_catalog.btrim(coalesce(c.coordinator_name, '')), '')
          end,
        'byYou', v.actor is not null and v.actor = caller
      ) order by v.at desc, v.id desc) as value,
        pg_catalog.max(v.at) filter (where v.new_row ->> 'status' = 'resolved') as closed_at
      from (
        select v.* from private.casework_record_versions v
        where v.case_id = c.id and v.record_table = 'member_cases' and v.op = 'UPDATE'
          and (v.old_row ->> 'status') is distinct from (v.new_row ->> 'status')
        order by v.at desc, v.id desc
        limit 10
      ) v
    ) events on true
    where c.id = any(p_case_ids)
      and private.casework_staff_can_access(c.id)
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.casework_desk_case_details(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.casework_desk_case_details(uuid[]) to authenticated;
comment on function public.casework_desk_case_details(uuid[]) is
  'REQ-UG-ALT-CASE-DESK-SERVER-READS-20261030: the case desk''s bounded read. For at most 100 case ids the caller may work as staff (private.casework_staff_can_access; MFA and no PIN session), the opened date, the last closing date of a resolved case, the outcome and note where the caller already reads member_case_outcomes, up to 25 open contract clocks with label and procedure step rule, up to 25 open hearings, and the last 10 status changes with a role label, stamped assignee name and byYou, never an actor id. Read only: no access record is written.';

notify pgrst, 'reload schema';

commit;
