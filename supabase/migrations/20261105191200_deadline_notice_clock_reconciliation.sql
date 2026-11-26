-- Forward repair for merged #7116; Refs #7087.
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

-- The earlier migration already set eastern_day on transaction-clock marks.
-- Reconcile those once as well as untouched UTC marks, without reconsidering
-- the retained legacy rows or new wall-clock deliveries on migration replay.
alter table private.staff_deadline_notice_marks
  add column if not exists clock_reconciled boolean not null default false;

-- Delivery timestamps use the same wall clock as casework history. A sweep
-- can start its transaction before it acquires the shared case-graph gate.
alter table private.staff_deadline_notice_marks
  alter column marked_at set default pg_catalog.clock_timestamp();

-- UTC keys for superseded instants are obsolete. A current legacy key can
-- instead be ambiguous: marked_at used transaction-start now(), whereas
-- history used clock_timestamp(), so a later write can appear older.
-- 's reconciliation policy (Nov 5, 2026): favour re-notification for
-- an active case with an active/extended deadline due today or later in Eastern
-- time. A possible duplicate is acceptable; a suppressed reminder is not.
-- Do not infer an exact delivery order from incompatible legacy timestamps.
-- Unambiguous valid marks and inactive/past ambiguous marks are retained.
do $reconcile_legacy_marks$
declare
  v_today date;
  v_obsolete bigint;
  v_ambiguous bigint;
begin
  v_today := (pg_catalog.clock_timestamp() at time zone 'America/New_York')::date;
  delete from private.staff_deadline_notice_marks mark
   where mark.source = 'casework_deadline' and not mark.clock_reconciled
     and not mark.eastern_day and not exists (
       select 1 from public.casework_deadlines deadline
        where deadline.id = mark.deadline_id
          and mark.due_on = (deadline.due_at at time zone 'UTC')::date
     );
  get diagnostics v_obsolete = row_count;

  delete from private.staff_deadline_notice_marks mark
   using public.casework_deadlines deadline, public.member_cases case_row
   where mark.source = 'casework_deadline' and not mark.clock_reconciled
     and deadline.id = mark.deadline_id and case_row.id = deadline.case_id
     and deadline.status in ('active', 'extended')
     and case_row.status = 'active' and case_row.learning_undone_at is null
     and (deadline.due_at at time zone 'America/New_York')::date >= v_today
     and exists (
       select 1 from private.casework_record_versions version
        where version.record_table = 'casework_deadlines'
          and version.record_id = mark.deadline_id::text
          and version.op = 'UPDATE' and version.at > mark.marked_at
          and ((version.old_row ->> 'due_at')::timestamptz at time zone 'America/New_York')::date
              is distinct from ((version.new_row ->> 'due_at')::timestamptz at time zone 'America/New_York')::date
     );
  get diagnostics v_ambiguous = row_count;
  raise notice 'deadline notice legacy reconciliation: cleared % ambiguous marks and % obsolete UTC marks',
    v_ambiguous, v_obsolete;
end;
$reconcile_legacy_marks$;

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
update private.staff_deadline_notice_marks set clock_reconciled = true
 where not clock_reconciled;
alter table private.staff_deadline_notice_marks
  alter column clock_reconciled set default true;

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
      insert into private.staff_deadline_notice_marks as mark (source, deadline_id, due_on, stage, marked_at, eastern_day)
      values (v_deadline.source, v_deadline.deadline_id, v_deadline.due_on, v_deadline.stage, pg_catalog.clock_timestamp(), true)
      on conflict (source, deadline_id, due_on) do update
        set stage = excluded.stage, marked_at = pg_catalog.clock_timestamp(), eastern_day = true
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

-- The existing member_cases BEFORE STATEMENT gate acquires before row locks.
-- Preserve this utility's original lock behaviour: do not acquire again from
-- the row trigger. Deadline retirement touches only the idempotency ledger.
create or replace function private.touch_member_case_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
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

-- Existing triggers retain their identities and grants. Only the changed row-trigger
-- function definition receives a refreshed review.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(
     ('private.' || reviewed.object_name)::regprocedure))
 where reviewed.kind = 'function' and reviewed.schema_name = 'private'
   and reviewed.table_name = ''
   and reviewed.object_name = 'touch_member_case_updated_at()';

commit;
