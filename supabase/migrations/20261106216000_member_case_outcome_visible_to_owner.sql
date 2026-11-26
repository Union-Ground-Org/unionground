-- BUG-UG-MEMBER-NEVER-SEES-GRIEVANCE-OUTCOME-20261106 (#7195); stamp
-- reserved by .
--
-- A coordinator's recorded outcome (upheld, settled, withdrawn, denied or
-- other, plus a summary) was staff-only: member_case_outcomes had a
-- coordinator select policy and no owner policy, and nothing told the member
-- the case had been resolved. They saw "Resolved" and nothing else.
--
-- 1. member_case_outcomes_select replaces member_case_outcomes_select_coordinator
--    with one permissive SELECT policy (a table keeps a single permissive
--    SELECT policy since 20261028210000): the case owner reads their own
--    case's outcome (the row's user_id and the parent case's owner must both
--    be the caller), OR the coordinator branch exactly as 20260917103000
--    left it. The restrictive mfa_assurance and member_pin_step_up policies
--    still apply, so two-step assurance is required where the organization
--    requires it and a restricted PIN session reads nothing.
-- 2. Notification copy case.resolved (EN and ES). It names no case content:
--    no reference, title, outcome or summary reaches a lock screen.
-- 3. coordinator_record_case_outcome sends the case owner that notice
--    through private.notify_member (kind 'cases') whenever the call resolves
--    a case that was not resolved (a reopened case included) or changes the
--    recorded outcome; a retry on a resolved case with the same outcome and
--    summary sends nothing. The body is otherwise the one 20261104123000
--    installed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Refuse to run unless the coordinator read is the table's only permissive
-- SELECT policy, as 20260917103000 left it.
do $guard$
declare
  observed text[];
begin
  select coalesce(pg_catalog.array_agg(p.polname::text order by p.polname), '{}')
    into observed
    from pg_catalog.pg_policy p
   where p.polrelid = 'public.member_case_outcomes'::regclass
     and p.polpermissive and p.polcmd in ('r', '*');
  if observed is distinct from array['member_case_outcomes_select_coordinator'] then
    raise exception 'public.member_case_outcomes permissive SELECT policies drifted: %', observed
      using errcode = '55000';
  end if;
end;
$guard$;

drop policy member_case_outcomes_select_coordinator on public.member_case_outcomes;
create policy member_case_outcomes_select on public.member_case_outcomes
  for select to authenticated using (
    (
      user_id = (select auth.uid())
      and exists (
        select 1
        from public.member_cases c
        where c.id = member_case_outcomes.case_id
          and c.user_id = (select auth.uid())
      )
    )
    or (
      public.staff_can_see_user(user_id, 'coordinator')
      and exists (
        select 1
        from public.member_cases c
        where c.id = member_case_outcomes.case_id
      )
    )
  );

comment on policy member_case_outcomes_select on public.member_case_outcomes is
  'The case owner reads the outcome recorded on their own case (#7195), OR a chapter-scoped grievance coordinator reads it only while the parent case row is itself visible to them under the member_cases policies, so a restricted case''s outcome needs an explicit casework access grant. The restrictive mfa_assurance and member_pin_step_up policies still apply.';

insert into private.notification_copy (key, lang, title, body) values
  ('case.resolved', 'en', 'Your case was resolved', 'Open Cases to see how it ended.'),
  ('case.resolved', 'es', 'Tu caso se resolvió', 'Abre Casos para ver cómo terminó.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

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
  -- The case owner hears that the case was resolved whenever this call
  -- resolves it (c is the row as it stood before the update, so a reopened
  -- case notifies again) or changes the recorded outcome; a retry on an
  -- already resolved case with the same outcome and summary sends nothing.
  -- The copy carries no case content.
  if c.status is distinct from 'resolved' or prior.case_id is null or prior.outcome is distinct from saved.outcome or prior.summary is distinct from saved.summary then
    perform private.notify_member(c.user_id, 'case.resolved', '{}'::jsonb, 'cases');
  end if;
  return jsonb_build_object('caseId',saved.case_id,'outcome',saved.outcome,'summary',saved.summary,'recordedAt',saved.recorded_at,'updatedAt',saved.updated_at);
end;
end;
$$;

commit;
