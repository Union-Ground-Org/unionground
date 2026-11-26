-- REQ-UG-TASKS-TOPIC-20260727
--
-- Closes S-5, the one sweep finding left as a product decision. Decision:
-- ADD THE SIXTH TOPIC.
--
-- Why the alternative loses. Every task notice is kind='general' today, which
-- is the never-send-outbound class, so a coordinator who is handed work and
-- does not open the app is never told -- and no preference can change that.
-- Chapter work has deadlines. Being handed a grievance-adjacent task two days
-- before its due date is at least as time-critical as the 'deadlines' topic
-- that already sends, and unlike a broadcast it names a specific person's
-- obligation. Accepting in-app-only would mean the assignment notice exists
-- mainly to make the board look responsive.
--
-- Three safety properties are preserved exactly as the outbound design set
-- them, and this migration adds nothing that could weaken them:
--
--   * No task notice names a task title, a chapter or a workstream. They read
--     "{name} assigned you a task" / "A task moved off your list". Once these
--     go to email and lock screens that rule stops being stylistic -- it is
--     the whole reason this topic can ship (the push-pass shoulder test).
--   * 'general' remains a real never-send class. Moving tasks OUT of it is the
--     point; nothing else moves, and the seed rows and the MFA alert stay
--     in-app only.
--   * The topic is opt-OUT via notification_prefs like every other topic, and
--     absent keys already mean enabled, so no backfill is required for the
--     ~300k existing rows or ~100k profiles.
--
-- ADAPTED 2026-07-28 (design wire-in step 2), twice:
--   (a) The package swapped the kind CHECK with a plain (validating) ADD,
--       which scans the ~300k-row feed under the ACCESS EXCLUSIVE the swap
--       takes. House style (20260723200500 / 20260723205000) is NOT VALID +
--       an explicit VALIDATE: the swap stays metadata-only, the validation
--       requests only SHARE UPDATE EXCLUSIVE, and both halves are replay-safe.
--       Under a single-transaction apply the AEL from the swap is still held
--       until commit, so this is no worse than the package's shape there and
--       strictly better under any statement-at-a-time apply. The new list is
--       a strict SUPERSET of the old one, so validation provably succeeds.
--   (b) The prepare_chapter_task re-emission below is the LAST emitter, so it
--       carries the 20260728221340 fix: the assignee-unchanged revert branch
--       honours the sg.refresh_names transaction-local flag, or the
--       member-renames name refresh silently reverts itself again.

set local lock_timeout = '5s';

-- 1. Widen the feed's kind CHECK. The column and its original constraint live
--    in 20260723200500; this is a constraint swap only -- no rewrite. NOT
--    VALID skips the 300k-row scan while still enforcing on every new and
--    updated row; the executable VALIDATE at the end of this file supplies the
--    proof over the old rows, exactly as 20260723205000 did for the original.
alter table public.member_notifications
  drop constraint if exists member_notifications_kind_check;
alter table public.member_notifications
  add constraint member_notifications_kind_check
  check (kind in ('general', 'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks'))
  not valid;

-- 2. Teach the single enforcement point about the topic. Body is
--    20260723201000's verbatim -- the control-flag read, the no-cast prefs
--    rule, the per-recipient advisory lock, the three caps, the visible
--    'skipped' suppression rows, the sharded org counter, and both exception
--    branches including the named query_canceled handler -- with 'tasks' added
--    to the ONE topic list. Nothing else is touched.
create or replace function private.enqueue_notification_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  org_today integer;
  limit_reason text;
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_org_day constant integer := 20000;
begin
  -- 'general' is in-app only and must never reach a provider. Short-circuit
  -- before the control flag, before prefs, before anything. 'tasks' joins the
  -- five topical kinds (2026-07-27 decision).
  if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks') then
    return new;
  end if;

  begin
    select c.outbound_enabled into outbound_on
      from private.notification_controls c where c.id;
    if not coalesce(outbound_on, false) then
      return new;
    end if;

    select p.notification_prefs into prefs
      from public.member_profiles p where p.id = new.user_id;

    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then
      return new;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0));

    select pg_catalog.count(*) into recent_hour
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '1 hour';

    select pg_catalog.count(*) into recent_day
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '24 hours';

    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.notification_outbound_counters c
      where c.day = current_date;

    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;

    if limit_reason is not null then
      insert into public.member_notification_deliveries (notification_id, user_id, channel, status, last_error)
      values (new.id, new.user_id, 'email', 'skipped', limit_reason)
      on conflict (notification_id, channel) do nothing;
      return new;
    end if;

    insert into private.notification_outbound_counters (day, shard, enqueued)
    values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
    on conflict (day, shard) do update
      set enqueued = private.notification_outbound_counters.enqueued + 1;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    values (new.id, new.user_id, 'email')
    on conflict (notification_id, channel) do nothing;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    select new.id, new.user_id, 'push'
    where exists (select 1 from public.member_push_subscriptions s where s.user_id = new.user_id)
    on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;

  return new;
end;
$$;

revoke all on function private.enqueue_notification_deliveries() from public, anon, authenticated, service_role;

-- 3. Spell the new topic into the default prefs shape. Absent keys already
--    mean enabled, so existing profiles need no backfill -- this only makes a
--    new member's stored blob self-describing, exactly as 20260723201000 did.
alter table public.member_profiles
  alter column notification_prefs
  set default '{"deadlines": true, "cases": true, "forms": true, "votes": true, "events": true, "tasks": true}'::jsonb;

-- 4. Route the four task notices onto the new topic. These replace the
--    'general' argument only; the copy rows in private.notification_copy are
--    unchanged, and none of them names a task, a chapter or a workstream --
--    which is what makes them safe to put on a lock screen. This is the LAST
--    emitter of prepare_chapter_task, so it also carries the 20260728221340
--    sg.refresh_names branch (see the header).
create or replace function private.prepare_chapter_task()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_name text;
  resolved_assignee_name text;
  previous_assignee uuid;
begin
  if caller is null then
    raise exception 'authentication required';
  end if;

  select p.chapter_id, p.full_name
    into caller_chapter, caller_name
  from public.member_profiles p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required';
  end if;

  new.title := btrim(new.title);
  new.description := btrim(new.description);
  new.workstream := btrim(new.workstream);

  if new.assignee_id is null then
    new.assignee_name := '';
  elsif tg_op = 'INSERT'
     or new.assignee_id is distinct from old.assignee_id then
    select p.full_name
      into resolved_assignee_name
    from public.member_profiles p
    where p.id = new.assignee_id
      and p.chapter_id = caller_chapter;

    if resolved_assignee_name is null then
      raise exception 'assignee must be a member of your chapter'
        using errcode = '22023';
    end if;

    new.assignee_name := btrim(resolved_assignee_name);
  elsif coalesce(pg_catalog.current_setting('sg.refresh_names', true), '') = '1' then
    -- Server-side name refresh (private.refresh_task_assignee_names): keep the
    -- corrected copy. The flag is transaction-local, raised for exactly one
    -- UPDATE statement, and that statement writes only assignee_name.
    new.assignee_name := btrim(new.assignee_name);
  else
    -- Direct write with the assignee unchanged: assignee_name is not
    -- client-writable, so retain the prior server-stamped copy.
    new.assignee_name := old.assignee_name;
  end if;

  if tg_op = 'INSERT' then
    new.chapter_id := caller_chapter;
    new.created_by := caller;
    new.created_at := now();
  elsif new.chapter_id is distinct from old.chapter_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'task ownership fields are immutable';
  end if;

  new.updated_by := caller;
  new.updated_at := now();

  if new.status = 'done' then
    new.progress := 100;
    new.done_at := case
      when tg_op = 'UPDATE' then coalesce(old.done_at, now())
      else now()
    end;
  else
    -- Reopening a card the done-branch forced to 100: the client deliberately
    -- sends status only (it never rewrites a typed progress), so without this
    -- a reopened card reads as finished forever. Only the forced value is
    -- walked back - a progress the client actually typed is left alone.
    if tg_op = 'UPDATE' and old.done_at is not null
       and new.progress = 100 and old.progress = 100 then
      new.progress := 99;
    end if;
    new.done_at := null;
  end if;

  previous_assignee := case when tg_op = 'UPDATE' then old.assignee_id else null end;

  if new.assignee_id is distinct from previous_assignee then
    if new.assignee_id is not null and new.assignee_id <> caller then
      perform private.notify_member(
        new.assignee_id, 'task.assigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;

    if previous_assignee is not null and previous_assignee <> caller then
      perform private.notify_member(
        previous_assignee, 'task.unassigned',
        pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');
    end if;
  end if;

  return new;
end
$$;

revoke all on function private.prepare_chapter_task() from public, anon, authenticated;

-- The message notice and the delete notice, same one-argument change. Both
-- bodies are otherwise verbatim from 20260728221135 / 20260728221223.
create or replace function public.send_chapter_task_message(
  p_task_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_name text;
  task_row public.chapter_tasks%rowtype;
  recipient uuid;
  inserted public.chapter_task_messages%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 2000 then
    raise exception 'message must be between 1 and 2000 characters'
      using errcode = '22023';
  end if;

  select t.*
    into task_row
  from public.chapter_tasks t
  join public.member_profiles caller_profile
    on caller_profile.id = caller
   and caller_profile.chapter_id = t.chapter_id
  where t.id = p_task_id
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if caller is distinct from task_row.created_by
     and caller is distinct from task_row.assignee_id then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  if caller = task_row.assignee_id then
    recipient := task_row.created_by;
  else
    recipient := task_row.assignee_id;
  end if;

  if recipient is null or recipient = caller then
    raise exception 'task has no message recipient' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.member_profiles recipient_profile
    where recipient_profile.id = recipient
      and recipient_profile.chapter_id = task_row.chapter_id
  ) then
    raise exception 'message recipient is unavailable' using errcode = '22023';
  end if;

  insert into public.chapter_task_messages (
    task_id, chapter_id, sender_id, recipient_id, body
  )
  values (
    task_row.id, task_row.chapter_id, caller, recipient, btrim(p_body)
  )
  returning * into inserted;

  select p.full_name into caller_name
  from public.member_profiles p where p.id = caller;

  perform private.notify_member(
    recipient, 'task.message',
    pg_catalog.jsonb_build_object('name', coalesce(caller_name, 'Someone')), 'tasks');

  return jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'senderId', inserted.sender_id,
    'recipientId', inserted.recipient_id,
    'body', inserted.body,
    'createdAt', inserted.created_at
  );
end
$$;

revoke all on function public.send_chapter_task_message(uuid, text)
  from public, anon, authenticated;
grant execute on function public.send_chapter_task_message(uuid, text)
  to authenticated;

-- The delete notice stays 'tasks' too: a card disappearing from your list with
-- no explanation is precisely the case where reaching someone who is not in
-- the app is the point.
create or replace function public.soft_delete_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  update public.chapter_tasks
    set deleted_at = now(), deleted_by = caller
    where id = task_row.id;

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.deleted',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'deletedAt', now());
end
$$;

revoke all on function public.soft_delete_chapter_task(uuid) from public, anon, authenticated;
grant execute on function public.soft_delete_chapter_task(uuid) to authenticated;

-- Restore rides the same topic: without it, the delete notice above stands
-- as the permanently false last word every time an Undo brings the task back.
create or replace function public.restore_chapter_task(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is not null
  for update of t;

  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  update public.chapter_tasks
    set deleted_at = null, deleted_by = null
    where id = task_row.id;

  if task_row.assignee_id is not null and task_row.assignee_id <> caller then
    perform private.notify_member(task_row.assignee_id, 'task.restored',
      pg_catalog.jsonb_build_object('name',
        coalesce((select p.full_name from public.member_profiles p where p.id = caller), 'Someone')),
      'tasks');
  end if;

  return pg_catalog.jsonb_build_object('id', task_row.id, 'restored', true);
end
$$;

revoke all on function public.restore_chapter_task(uuid) from public, anon, authenticated;
grant execute on function public.restore_chapter_task(uuid) to authenticated;

comment on constraint member_notifications_kind_check on public.member_notifications is
  'Topic classification. general = in-app only, never outbound. tasks added 2026-07-27: chapter work has deadlines, and no task notice names a task, chapter or workstream, which is what makes it safe on a lock screen.';

-- 5. Validate the swapped CHECK as an executable statement (house style,
--    20260723205000): a validation step that lives only in a runbook is a
--    validation step that eventually does not happen, and convalidated=false
--    is exactly what scripts/verify-db-contract.mjs reports as FAIL. VALIDATE
--    requests SHARE UPDATE EXCLUSIVE, and every pre-existing row satisfied the
--    old six-value list, which the new list strictly contains -- so this scan
--    cannot fail. Replay-safe: validating an already-validated constraint is
--    skipped by the guard.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_notifications'::regclass
      and conname = 'member_notifications_kind_check'
      and not convalidated
  ) then
    -- Scans ~300k rows comparing one text column against a seven-value list.
    alter table public.member_notifications
      validate constraint member_notifications_kind_check;
  end if;
end
$$;

-- Fail loudly rather than leave a half-validated schema looking applied.
do $$
declare
  unvalidated integer;
begin
  select pg_catalog.count(*) into unvalidated
  from pg_constraint
  where conname = 'member_notifications_kind_check'
    and not convalidated;
  if unvalidated > 0 then
    raise exception 'tasks topic: member_notifications_kind_check still NOT VALID after validation';
  end if;
end
$$;

notify pgrst, 'reload schema';
