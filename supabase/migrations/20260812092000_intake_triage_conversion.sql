-- REQ-UNION-BASE-INTAKE-ONWARD-PATH-20260812 (UB-VOTE-05)
--
-- Intake is not a terminal inbox. Chapter staff can explicitly triage a
-- report, assign it to another same-chapter intake owner, and convert it once
-- into a case, a privacy-quiet Standard Task, or an intake thread. All writes
-- are atomic and server-authorized; the broad legacy column UPDATE grant is
-- removed so a client cannot attach an arbitrary cross-chapter record.

set local lock_timeout = '5s';

alter table public.member_intake_reports
  add column task_id uuid references public.chapter_tasks(id) on delete set null;

alter table public.member_intake_reports
  add constraint member_intake_reports_single_outcome
  check (pg_catalog.num_nonnulls(thread_id, case_id, task_id) <= 1);

create index member_intake_reports_task_idx
  on public.member_intake_reports (task_id)
  where task_id is not null;

revoke update (status, assigned_to, thread_id, case_id)
  on public.member_intake_reports from authenticated;

-- Admin by itself is not an intake desk role. Keep report visibility and the
-- remaining UPDATE policy aligned with the RPC owner/caller contract: the
-- reporter can still read their own report, while chapter-wide intake access
-- belongs only to stewards and coordinators who can carry the resulting case.
alter policy member_intake_reports_read on public.member_intake_reports
  using (
    reporter_id = (select auth.uid())
    or (
      chapter_id = private.current_member_chapter()
      and public.member_has_role(array['steward', 'coordinator'])
    )
  );

alter policy member_intake_reports_staff_update on public.member_intake_reports
  using (
    chapter_id = private.current_member_chapter()
    and public.member_has_role(array['steward', 'coordinator'])
  )
  with check (
    chapter_id = private.current_member_chapter()
    and public.member_has_role(array['steward', 'coordinator'])
  );

create or replace function public.list_intake_triage_owners()
returns table (
  user_id uuid,
  full_name text,
  initials text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  return query
  select p.id, p.full_name, p.initials
  from public.member_profiles p
  where p.chapter_id = caller_chapter
    and exists (
      select 1
      from public.member_roles r
      where r.user_id = p.id
        and r.role = any(array['steward', 'coordinator'])
    )
  order by p.full_name, p.id;
end
$$;

create or replace function public.triage_member_intake_report(
  p_report_id uuid,
  p_status text,
  p_assigned_to uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  report_row public.member_intake_reports%rowtype;
  updated public.member_intake_reports%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator']) then
    raise exception 'intake staff role required' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('new', 'triaged', 'in_progress', 'closed') then
    raise exception 'invalid intake status' using errcode = '22023';
  end if;

  select r.* into report_row
  from public.member_intake_reports r
  join public.member_profiles caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = r.chapter_id
  where r.id = p_report_id
  for update of r;

  if report_row.id is null then
    raise exception 'intake report unavailable' using errcode = '22023';
  end if;

  if p_assigned_to is not null and not exists (
    select 1
    from public.member_profiles owner_profile
    where owner_profile.id = p_assigned_to
      and owner_profile.chapter_id = report_row.chapter_id
      and exists (
        select 1 from public.member_roles owner_role
        where owner_role.user_id = owner_profile.id
          and owner_role.role = any(array['steward', 'coordinator'])
      )
  ) then
    raise exception 'intake owner must be same-chapter staff' using errcode = '22023';
  end if;

  update public.member_intake_reports r
     set status = p_status,
         assigned_to = p_assigned_to
   where r.id = report_row.id
  returning r.* into updated;

  return pg_catalog.to_jsonb(updated);
end
$$;

create or replace function public.convert_member_intake_report(
  p_report_id uuid,
  p_target text,
  p_space_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
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
  join public.member_profiles caller_profile
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
    from public.member_profiles p
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

  return pg_catalog.jsonb_build_object(
    'report', pg_catalog.to_jsonb(updated),
    'target', p_target,
    'targetId', target_id
  );
end
$$;

revoke all on function public.list_intake_triage_owners()
  from public, anon, authenticated;
revoke all on function public.triage_member_intake_report(uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.convert_member_intake_report(uuid, text, uuid)
  from public, anon, authenticated;

grant execute on function public.list_intake_triage_owners() to authenticated;
grant execute on function public.triage_member_intake_report(uuid, text, uuid) to authenticated;
grant execute on function public.convert_member_intake_report(uuid, text, uuid) to authenticated;

comment on column public.member_intake_reports.task_id is
  'The single Standard Task created from this report, when task conversion was selected.';
comment on function public.convert_member_intake_report(uuid, text, uuid) is
  'Atomically converts one same-chapter intake report once; same-target retries are idempotent.';
