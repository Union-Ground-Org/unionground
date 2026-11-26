-- OPS-UG-DEADLINE-SWEEP-EASTERN-DAY-BOUNDARY-20261105 (#7087).
-- Calendar deadlines follow Eastern dates, independently of the cron hour or
-- session timezone. Keep the existing cron.job rows and sweep signatures.
begin;

-- Serialize the key remap with both sweeps and case deadline edits.
select private.lock_case_graph(array[]::uuid[], array[]::uuid[]);

-- A persisted basis flag distinguishes untouched UTC keys from keys already
-- converted to Eastern. Replaying this migration must not reinterpret an
-- Eastern key that happens to equal the current UTC date.
alter table private.staff_deadline_notice_marks
  add column if not exists eastern_day boolean not null default false;

-- A legacy key for a previous due instant cannot prove delivery for the
-- current deadline. Retire it before a stale UTC key can alias today's
-- Eastern key after an extension. Member-case keys were always date-valued.
delete from private.staff_deadline_notice_marks mark
 where mark.source = 'casework_deadline' and not mark.eastern_day
   and (not exists (
     select 1 from public.casework_deadlines deadline
      where deadline.id = mark.deadline_id
        and mark.due_on = (deadline.due_at at time zone 'UTC')::date
   ) or exists (
     -- An extension can cross Eastern midnight without changing the UTC
     -- date. Its recorded day change invalidates an earlier legacy mark
     -- even when that old key still equals the current UTC bucket.
     select 1 from private.casework_record_versions version
      where version.record_table = 'casework_deadlines'
        and version.record_id = mark.deadline_id::text
        and version.op = 'UPDATE' and version.at > mark.marked_at
        and ((version.old_row ->> 'due_at')::timestamptz at time zone 'America/New_York')::date
            is distinct from ((version.new_row ->> 'due_at')::timestamptz at time zone 'America/New_York')::date
   ));

insert into private.staff_deadline_notice_marks as target
  (source, deadline_id, due_on, stage, marked_at, eastern_day)
select mark.source, mark.deadline_id,
       (deadline.due_at at time zone 'America/New_York')::date,
       mark.stage, mark.marked_at, true
  from private.staff_deadline_notice_marks mark
  join public.casework_deadlines deadline on deadline.id = mark.deadline_id
 where mark.source = 'casework_deadline' and not mark.eastern_day
on conflict (source, deadline_id, due_on) do update
  set stage = case when target.eastern_day then greatest(target.stage, excluded.stage) else excluded.stage end,
      marked_at = case when target.eastern_day then greatest(target.marked_at, excluded.marked_at) else excluded.marked_at end,
      eastern_day = true;

delete from private.staff_deadline_notice_marks
 where source = 'casework_deadline' and not eastern_day;
update private.staff_deadline_notice_marks set eastern_day = true
 where source = 'member_case' and not eastern_day;
alter table private.staff_deadline_notice_marks
  alter column eastern_day set default true;

create or replace function private.case_deadline_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  r record;
  v_today date;
begin
  v_today := (pg_catalog.now() at time zone 'America/New_York')::date;
  for r in
    select c.id, c.user_id, (c.deadline - v_today) as days_left
    from public.member_cases c
    where c.status = 'active' and c.learning_undone_at is null
      and c.deadline is not null
      and (c.deadline - v_today) between 0 and 7
      and (
        ((c.deadline - v_today) <= 1 and c.deadline_notice_1_sent_at is null)
        or ((c.deadline - v_today) between 2 and 3 and c.deadline_notice_3_sent_at is null)
        or ((c.deadline - v_today) between 4 and 7 and c.deadline_notice_7_sent_at is null)
      )
    for update skip locked
  loop
    if r.days_left <= 1 then
      update public.member_cases
        set deadline_notice_1_sent_at = now(),
            deadline_notice_3_sent_at = coalesce(deadline_notice_3_sent_at, now()),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id,
        case when r.days_left <= 0 then 'deadline.case.today' else 'deadline.case.tomorrow' end,
        '{}'::jsonb, 'deadlines');
    elsif r.days_left <= 3 then
      update public.member_cases
        set deadline_notice_3_sent_at = now(),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    else
      update public.member_cases
        set deadline_notice_7_sent_at = now()
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    end if;
  end loop;
  begin
    perform private.staff_deadline_notice_sweep();
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'staff_deadline_notice_sweep failed: % (%)', sqlerrm, sqlstate;
  end;
end;
end;
$function$;

revoke all on function private.case_deadline_notice_sweep() from public, anon, authenticated, service_role;

create or replace function private.staff_deadline_notice_sweep()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deadline record;
  v_today date;
  v_recipient uuid;
  v_sent integer;
  v_read integer;
  v_batch_rows integer;
  v_batch_size integer;
  v_max_rows integer;
  v_after_due date;
  v_after_source text;
  v_after_id uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_today := (pg_catalog.now() at time zone 'America/New_York')::date;
  v_sent := 0;
  v_read := 0;
  -- The case-graph lock is held for this transaction, so one run reads at
  -- most v_max_rows due deadlines in keyset batches. Only work that is due
  -- (inside the organization's window and not yet announced at today's
  -- stage) is read; switched-off organizations never enter the scan. Nearer
  -- deadlines come first and the remainder is reached on the next run.
  v_batch_size := 100;
  v_max_rows := 500;
  v_after_due := '-infinity'::date;
  v_after_source := '';
  v_after_id := '00000000-0000-0000-0000-000000000000'::uuid;
  delete from private.staff_deadline_notice_marks mark
   where mark.due_on < v_today - 7;
  loop
    v_batch_rows := 0;
    for v_deadline in
      select candidate.source, candidate.deadline_id, candidate.case_id,
             candidate.organization_id, candidate.owner_id,
             candidate.steward_user_id, candidate.coordinator_user_id,
             candidate.due_on, stage.days, stage.stage
        from (
          select 'member_case'::text as source, c.id as deadline_id, c.id as case_id,
                 c.organization_id, c.user_id as owner_id,
                 c.steward_user_id, c.coordinator_user_id, c.deadline as due_on
            from public.member_cases c
           where c.status = 'active'
             and c.deadline between v_today and v_today + 30
             and (c.steward_user_id is not null or c.coordinator_user_id is not null)
             and private.organization_feature_enabled(c.organization_id, 'features.notifications.steward_deadline_reminders')
          union all
          select 'casework_deadline', d.id, c.id,
                 c.organization_id, c.user_id,
                 c.steward_user_id, c.coordinator_user_id, (d.due_at at time zone 'America/New_York')::date
            from public.casework_deadlines d
            join public.member_cases c on c.id = d.case_id and c.organization_id = d.organization_id
           where d.status in ('active', 'extended')
             and c.status = 'active'
             and d.due_at >= (v_today::timestamp at time zone 'America/New_York')
             and d.due_at < ((v_today + 31)::timestamp at time zone 'America/New_York')
             and (c.steward_user_id is not null or c.coordinator_user_id is not null)
             and private.organization_feature_enabled(c.organization_id, 'features.notifications.steward_deadline_reminders')
        ) candidate
        cross join lateral (
          select candidate.due_on - v_today as days,
                 (case
                    when candidate.due_on - v_today <= 0 then 3
                    when candidate.due_on - v_today = 1 then 2
                    when candidate.due_on - v_today <= least(greatest(coalesce(private.organization_limit(
                      candidate.organization_id, 'limits.notifications.steward_deadline_reminder_days'), 3), 1), 30) then 1
                  end)::smallint as stage
        ) stage
       where stage.stage is not null
         and (candidate.due_on, candidate.source, candidate.deadline_id)
             > (v_after_due, v_after_source, v_after_id)
         and not exists (
           select 1 from private.staff_deadline_notice_marks mark
            where mark.source = candidate.source
              and mark.deadline_id = candidate.deadline_id
              and mark.due_on = candidate.due_on
              and mark.eastern_day
              and mark.stage >= stage.stage
         )
       order by candidate.due_on, candidate.source, candidate.deadline_id
       limit least(v_batch_size, v_max_rows - v_read)
    loop
      v_batch_rows := v_batch_rows + 1;
      v_read := v_read + 1;
      v_after_due := v_deadline.due_on;
      v_after_source := v_deadline.source;
      v_after_id := v_deadline.deadline_id;
      insert into private.staff_deadline_notice_marks as mark (source, deadline_id, due_on, stage, eastern_day)
      values (v_deadline.source, v_deadline.deadline_id, v_deadline.due_on, v_deadline.stage, true)
      on conflict (source, deadline_id, due_on) do update
        set stage = excluded.stage, marked_at = pg_catalog.now(), eastern_day = true
        where not mark.eastern_day or mark.stage < excluded.stage;
      if not found then
        continue;
      end if;
      for v_recipient in
        select distinct assignee.user_id
          from (values (v_deadline.steward_user_id), (v_deadline.coordinator_user_id)) as assignee(user_id)
         where assignee.user_id is not null
           -- The case owner already gets the member deadline notice.
           and not (v_deadline.source = 'member_case' and assignee.user_id = v_deadline.owner_id)
      loop
        if private.casework_reminder_owner_can_read(v_recipient, v_deadline.case_id) then
          perform private.notify_member(
            v_recipient,
            case v_deadline.stage when 3 then 'deadline.staff.today' when 2 then 'deadline.staff.tomorrow' else 'deadline.staff.days' end,
            case when v_deadline.stage = 1 then pg_catalog.jsonb_build_object('days', v_deadline.days::text) else '{}'::jsonb end,
            'deadlines');
          v_sent := v_sent + 1;
        end if;
      end loop;
    end loop;
    exit when v_batch_rows < v_batch_size or v_read >= v_max_rows;
  end loop;
  return v_sent;
end;
$function$;

revoke all on function private.staff_deadline_notice_sweep() from public, anon, authenticated, service_role;

comment on function private.staff_deadline_notice_sweep() is
  'BUG-UG-STEWARD-DEADLINE-REMINDERS-20261001 / BUG-UG-STEWARD-DEADLINE-SWEEP-UNBOUNDED-20261002: warns the assigned steward and coordinator of each active member_cases.deadline and casework_deadlines due date once per threshold (window, day before, due day). Reads at most 500 due, not-yet-announced deadlines per run in keyset batches of 100, nearest first, with switched-off organizations excluded in the scan; re-checks case access per recipient and names no case.';

create or replace function private.capture_casework_record_version()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  previous jsonb; following jsonb; row_data jsonb; case_key uuid;
  parent_table text; parent_key text; record_key text; chapter_key text;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  if tg_op <> 'INSERT' then previous := pg_catalog.to_jsonb(old); end if;
  if tg_op <> 'DELETE' then following := pg_catalog.to_jsonb(new); end if;
  -- Every due_at writer reaches this existing row trigger: approved
  -- extensions, direct writes, seed upserts and learning-period undo.
  if tg_table_name = 'casework_deadlines' and (
    tg_op in ('INSERT', 'DELETE')
    or ((previous ->> 'due_at')::timestamptz at time zone 'America/New_York')::date
       is distinct from ((following ->> 'due_at')::timestamptz at time zone 'America/New_York')::date
  ) then
    delete from private.staff_deadline_notice_marks
     where source = 'casework_deadline'
       and deadline_id = coalesce(following ->> 'id', previous ->> 'id')::uuid;
  end if;
  if tg_op = 'UPDATE' and previous - 'updated_at' = following - 'updated_at' then
    return null;
  end if;
  row_data := coalesce(following, previous);
  record_key := coalesce(row_data ->> 'id',
    (row_data ->> 'pattern_id') || ':' || (row_data ->> 'report_id'));
  case_key := case when tg_table_name = 'member_cases' then (row_data ->> 'id')::uuid
    else coalesce(row_data ->> 'case_id', row_data ->> 'source_case_id', previous ->> 'case_id')::uuid end;
  chapter_key := row_data ->> 'chapter_id';
  -- Child rows carry no case_id. Resolve each parent with its own constant
  -- statement: dynamic EXECUTE is unanalyzable and the conventions verifier
  -- refuses it, so every lookup below is a fixed relation.
  case tg_table_name
    when 'casework_deadline_extensions' then
      parent_table := 'casework_deadlines'; parent_key := coalesce(row_data ->> 'deadline_id', previous ->> 'deadline_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_deadlines p where p.id = parent_key::uuid;
    when 'casework_checklist_items' then
      parent_table := 'casework_checklists'; parent_key := coalesce(row_data ->> 'checklist_id', previous ->> 'checklist_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_checklists p where p.id = parent_key::uuid;
    when 'casework_alert_acknowledgements' then
      parent_table := 'casework_alerts'; parent_key := coalesce(row_data ->> 'alert_id', previous ->> 'alert_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_alerts p where p.id = parent_key::uuid;
    when 'casework_management_addenda' then
      parent_table := 'casework_management_entries'; parent_key := coalesce(row_data ->> 'entry_id', previous ->> 'entry_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_management_entries p where p.id = parent_key::uuid;
    when 'casework_retaliation_pattern_reports' then
      parent_table := 'casework_retaliation_reports'; parent_key := coalesce(row_data ->> 'report_id', previous ->> 'report_id');
      select p.case_id, p.chapter_id into case_key, chapter_key from public.casework_retaliation_reports p where p.id = parent_key::uuid;
    else null;
  end case;
  -- During a parent cascade the live parent row can already be gone; the
  -- parent's own last captured version still carries the case.
  if parent_table is not null and case_key is null then
    select v.case_id, v.chapter_id into case_key, chapter_key from private.casework_record_versions v
    where v.record_table = parent_table and v.record_id = parent_key
    order by v.id desc limit 1;
  end if;
  -- Retained children may be detached by a case cascade after its versions
  -- have already disappeared. The existing lifecycle snapshot identifies that
  -- case even for rows which predate this migration.
  if case_key is null then
    select h.case_id into case_key from private.account_lifecycle_history_scope h
    where (h.kind = 'deadline_extension' and tg_table_name = 'casework_deadline_extensions' and h.record_id = record_key)
       or (h.kind = 'management_entry' and h.record_id = case when tg_table_name = 'casework_management_addenda' then parent_key when tg_table_name = 'casework_management_entries' then record_key end)
       or (h.kind = 'retaliation_report' and h.record_id = case when tg_table_name = 'casework_retaliation_pattern_reports' then parent_key when tg_table_name = 'casework_retaliation_reports' then record_key end)
    limit 1;
  end if;
  -- These children always belong to a case. No unscoped snapshot survives a
  -- cascade whose parent and version have both already been removed.
  if case_key is null and tg_table_name = any(array[
    'casework_checklist_items','casework_alert_acknowledgements','casework_deadline_extensions'
  ]) then return null; end if;
  -- Never resurrect versions during the case's own delete/cascade/detachment.
  if case_key is not null and not exists (select 1 from public.member_cases c where c.id = case_key) then
    return null;
  end if;
  if row_data ->> 'organization_id' is not null and not exists (
    select 1 from public.organizations o where o.id = (row_data ->> 'organization_id')::uuid
  ) then return null; end if;
  insert into private.casework_record_versions
    (case_id, organization_id, chapter_id, record_table, record_id, op, old_row, new_row, actor)
  values (case_key, (row_data ->> 'organization_id')::uuid, chapter_key, tg_table_name,
    record_key, tg_op, previous, following, (select u.id from auth.users u where u.id = auth.uid()));
  return null;
end;
$function$;
revoke all on function private.capture_casework_record_version() from public, anon, authenticated, service_role;

create or replace function private.touch_member_case_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if old.restricted_by is not null
     and new.restricted_by is null
     and new.is_restricted
     and private.account_lifecycle_is_nested_auth_detachment(old.restricted_by, new.restricted_by)
     and (pg_catalog.to_jsonb(new) - 'restricted_by' - 'updated_at')
       is not distinct from (pg_catalog.to_jsonb(old) - 'restricted_by' - 'updated_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;
  if new.deadline is distinct from old.deadline then
    new.deadline_notice_1_sent_at := null;
    new.deadline_notice_3_sent_at := null;
    new.deadline_notice_7_sent_at := null;
    delete from private.staff_deadline_notice_marks
     where source = 'member_case' and deadline_id = old.id;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;
revoke all on function private.touch_member_case_updated_at() from public, anon, authenticated, service_role;

-- Existing triggers retain their identities and grants. Only their two
-- deliberately replaced function definitions receive a refreshed review.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
     ('private.' || reviewed.object_name)::regprocedure))
 where reviewed.kind = 'function' and reviewed.schema_name = 'private'
   and reviewed.table_name = ''
   and reviewed.object_name in
     ('capture_casework_record_version()', 'touch_member_case_updated_at()');

commit;
