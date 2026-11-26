-- OPS-UG-PRODUCTION-RESIDUE-CLEANUP-EXECUTION-20260912
-- Immediate re-lock for the removal-only production window opened by
-- 20260927110000_uniondemo_production_removal_window_unlock.sql.
--
-- Run this after the final read-only order-1 status and aggregate verification,
-- and also on every abort path. It authenticates the exact routed generation,
-- restores only the original SAMPLE-guard call, and drops the temporary guard
-- and expiring window table. No active-window row or confirmation is required
-- to close the window.

begin;

-- Restore the exact current reviewed case-graph/message definitions. The
-- preceding CREATE OR REPLACE keeps each existing owner and ACL.

-- knowledge-remove: source hashes 248c522946a82263ac5def54118f90fcd1fc156350e010e32d564ea704c75463 / 60858d8e3d5be7f02a6e6eb4a2d49b3909724bec543a75d463e8903da57ea728
create or replace function public.remove_mi1_knowledge_sample(
  p_lane text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$

begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  else
    raise exception 'unknown demo lane';
  end if;
  return private.demo_seed_remove_knowledge_library(p_lane, p_run_id);
end;
end;
end;
$function$;

-- parity-remove: source hashes f71f82c9b00be4ea11700281d9ecda016066ea2ae1a4a2875becab6e4d880458 / 774dbab1377400fe79814c29389e1a02637d6af652d735299f29f78f4ca19c3b
create or replace function public.uniondemo_remove_function_parity(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$

begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare operations_result jsonb; voice_result jsonb; base_result jsonb; refresh_removed boolean;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_retention_engine('uniondemo', p_run_id);
  perform private.demo_seed_remove_member_operations('uniondemo', p_run_id);
  perform private.demo_seed_remove_institutional_records('uniondemo', p_run_id);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('uniondemo', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('uniondemo', p_run_id);
  base_result := private.demo_seed_remove_function_parity('uniondemo', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
end;
end;
end;
$function$;

-- begin-remove: source hashes 1eac1cda76a6f59d7a2a54190470863d7dea072b516e0e5516c0fdee682615d4 / 1fee125b9b4251f4e1360b2eeb55854b8d89a9893d12dc5f3c39d7bd04714663
create or replace function public.uniondemo_begin_remove(
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '180s'
as $function$

begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  run private.uniondemo_runs%rowtype;
  collision_count bigint;
  remaining bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state = 'removed' then return jsonb_build_object('state', 'removed', 'remaining', 0, 'resumed', true); end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified', 'removing') then
    raise exception 'run cannot be removed';
  end if;
  if run.protected_snapshot <> private.uniondemo_protected_snapshot(p_run_id) then
    raise exception 'non-demo user snapshot changed; removal stopped';
  end if;
  select pg_catalog.count(*) into collision_count
  from auth.users users
  join private.uniondemo_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and (pg_catalog.lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'uniondemo_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'removal preflight found non-owned auth rows'; end if;
  update private.uniondemo_runs set state = 'removing', updated_at = pg_catalog.now() where id = p_run_id;
  select pg_catalog.count(*) into remaining from auth.users users
  join private.uniondemo_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  return jsonb_build_object('state', 'removing', 'remaining', remaining, 'resumed', run.state = 'removing');
end;
end;
end;
$function$;

-- remove-batch: source hashes e99d27f5988f5e4aaeb96f8c48ac1e3c01e8ed6686d2dc051e639659c7d86e36 / 66664e7f33dccf959ec9c76cd7c1ebb6a48a3500fafdb2d05431fdd380505602
create or replace function public.uniondemo_remove_batch(
  p_run_id uuid,
  p_batch_count integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $function$

begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  run private.uniondemo_runs%rowtype;
  deleted_count bigint;
  remaining bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 2000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state = 'removed' then return jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed'); end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  -- The task boards and channels are removed BEFORE any auth user: deleting a
  -- user first would cascade SET NULL onto chapter_tasks identity columns,
  -- fire the audit trigger, and insert an activity row whose actor_id is the
  -- identity mid-delete — a foreign-key violation. Idempotent per batch call.
  delete from public.chapter_task_activity t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_comments t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_assignments t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_subtasks t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_attachments t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_files t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_messages t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_watchers t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_dependencies t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_task_template_details t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_tasks t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_thread_posts t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_threads t using private.uniondemo_chapters map
    where map.run_id = p_run_id and t.chapter_id = map.chapter_id;
  delete from public.chapter_space_members m
    using public.chapter_spaces s, private.uniondemo_chapters map
    where map.run_id = p_run_id and s.chapter_id = map.chapter_id and s.id = m.space_id;
  delete from public.chapter_spaces s using private.uniondemo_chapters map
    where map.run_id = p_run_id and s.chapter_id = map.chapter_id;

  with selected as (
    select users.id
    from auth.users users
    join private.uniondemo_ledger ledger on ledger.user_id = users.id
    where ledger.run_id = p_run_id
      and pg_catalog.lower(users.email) = ledger.email
      and users.raw_app_meta_data ->> 'uniondemo_run_id' = p_run_id::text
    order by ledger.ordinal
    limit p_batch_count
  ), deleted as (
    delete from auth.users users using selected where users.id = selected.id returning users.id
  ) select pg_catalog.count(*) into deleted_count from deleted;

  select pg_catalog.count(*) into remaining from auth.users users
  join private.uniondemo_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;

  if remaining = 0 then
    if run.protected_snapshot <> private.uniondemo_protected_snapshot(p_run_id) then
      raise exception 'non-demo user snapshot changed during removal';
    end if;

    -- Org sweep. Every row below is scoped to a mapped 'ud-*' chapter id or a
    -- 'ud-' id prefix; the users (and so every user-cascading row) are
    -- already gone. Anything a real identity somehow attached to a demo
    -- chapter stops the sweep instead of being deleted.
    if exists (select 1 from public.member_profiles p
        join private.uniondemo_chapters map on map.chapter_id = p.chapter_id
        where map.run_id = p_run_id) then
      raise exception 'a live profile still references a union demo chapter; sweep stopped';
    end if;
    if exists (select 1 from public.member_ballot_votes where ballot_id like 'ud-ballot-%') then
      raise exception 'union demo ballots still hold votes from non-demo identities; sweep stopped';
    end if;

    delete from private.chapter_task_number_counters c using private.uniondemo_chapters map
      where map.run_id = p_run_id and c.chapter_id = map.chapter_id;
    delete from public.chapter_workstreams w using private.uniondemo_chapters map
      where map.run_id = p_run_id and w.chapter_id = map.chapter_id;
    delete from public.member_event_checkins c
      using public.member_events e where e.id = c.event_id and e.id like 'ud-evt-%';
    delete from public.member_event_rsvps r
      using public.member_events e where e.id = r.event_id and e.id like 'ud-evt-%';
    delete from public.member_events where id like 'ud-evt-%';
    delete from public.member_ballot_receipts where ballot_id like 'ud-ballot-%';
    delete from public.member_ballot_options where ballot_id like 'ud-ballot-%';
    delete from public.member_ballots where id like 'ud-ballot-%';
    delete from public.member_survey_responses where survey_id like 'ud-pulse-%';
    delete from public.member_survey_options where survey_id like 'ud-pulse-%';
    delete from public.member_surveys where id like 'ud-pulse-%';
    delete from public.member_broadcast_receipts where broadcast_id like 'ud-bc-%';
    delete from public.member_broadcasts where id like 'ud-bc-%';
    delete from public.chapters ch using private.uniondemo_chapters map
      where map.run_id = p_run_id and ch.id = map.chapter_id;

    update private.uniondemo_runs
    set state = 'removed', removed_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_run_id;
  end if;
  return jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
end;
end;
end;
$function$;

drop function private.uniondemo_production_removal_authorize(text, uuid, text, text);
drop function private.uniondemo_production_removal_actors_owned(uuid, jsonb, boolean);
drop table private.uniondemo_production_removal_windows;
drop function private.uniondemo_production_removal_stamp_window();

commit;
