-- OPS-UG-PRODUCTION-RESIDUE-CLEANUP-EXECUTION-20260912
-- Removal-only unlock for execution order 1 of
-- docs/audits/sample-production-residue-cleanup-plan-20260830.json.
--
-- Merging or applying this migration authorizes no removal. The four removal
-- entrypoints continue to refuse production until an owner-attended operator
-- inserts the exact production installation into the empty window table below.
-- PostgreSQL stamps the opening time, the row expires no later than the end of
-- the 12:10-5:00 AM ET maintenance interval, and the guard also requires the
-- owner-held confirmation value. The following re-lock migration restores the
-- four entrypoints and drops both temporary authorization objects.
--
-- private.uniondemo_authorize(text,text), its SAMPLE binding, and every seed,
-- apply, reapply, enrich, login, snapshot-refresh and verification path remain
-- unchanged. Only knowledge-remove, parity-remove, begin-remove and
-- remove-batch can reach the production guard.

begin;

create table private.uniondemo_production_removal_windows (
  project_ref text primary key,
  run_id uuid not null unique,
  system_identifier numeric not null,
  database_oid oid not null,
  authorization_reference text not null,
  backup_reference text not null,
  opened_at timestamptz not null default pg_catalog.statement_timestamp(),
  expires_at timestamptz not null,
  constraint uniondemo_production_removal_window_target
    check (project_ref = 'productionprojectref'),
  constraint uniondemo_production_removal_window_run
    check (run_id = '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid),
  constraint uniondemo_production_removal_window_authorization_reference
    check (authorization_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  constraint uniondemo_production_removal_window_backup_reference
    check (backup_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$'),
  constraint uniondemo_production_removal_window_duration
    check (expires_at > opened_at
      and expires_at <= opened_at + interval '4 hours 50 minutes'),
  constraint uniondemo_production_removal_window_eastern_interval
    check ((opened_at at time zone 'America/New_York')::time >= time '00:10'
      and (opened_at at time zone 'America/New_York')::time < time '05:00'
      and (expires_at at time zone 'America/New_York')::date
        = (opened_at at time zone 'America/New_York')::date
      and (expires_at at time zone 'America/New_York')::time <= time '05:00')
);

alter table private.uniondemo_production_removal_windows enable row level security;
revoke all on table private.uniondemo_production_removal_windows
  from public, anon, authenticated, service_role;

comment on table private.uniondemo_production_removal_windows is
  'Empty-by-default, expiring administrator lock for the one owner-attended production uniondemo removal window. Dropped by the immediate re-lock migration.';

create function private.uniondemo_production_removal_stamp_window()
returns trigger
language plpgsql
security definer
set search_path = ''
as $stamp_window$
declare
  database_opened_at timestamptz := pg_catalog.statement_timestamp();
  eastern_opened_at timestamp := database_opened_at at time zone 'America/New_York';
begin
  if eastern_opened_at::time < time '00:10'
    or eastern_opened_at::time >= time '05:00' then
    raise exception 'production removal window must open between 12:10 and 5:00 AM ET'
      using errcode = '55000';
  end if;
  -- A caller-supplied opened_at is never authoritative. PostgreSQL replaces it
  -- even when the INSERT explicitly names the column.
  new.opened_at := database_opened_at;
  return new;
end;
$stamp_window$;

revoke all on function private.uniondemo_production_removal_stamp_window()
  from public, anon, authenticated, service_role;

create trigger uniondemo_production_removal_stamp_window
before insert or update on private.uniondemo_production_removal_windows
for each row execute function private.uniondemo_production_removal_stamp_window();

create function private.uniondemo_production_removal_actors_owned(
  p_run_id uuid,
  p_row jsonb,
  p_require_actor boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $actors_owned$
declare
  actor record;
  actor_seen boolean := false;
begin
  for actor in
    select field.key, field.value
    from pg_catalog.jsonb_each_text(p_row) as field
    where field.key = any(array[
      'actor_id', 'assigned_by', 'assignee_id', 'author_id', 'commenter_id',
      'completed_by', 'created_by', 'member_id', 'updated_by', 'uploaded_by',
      'user_id', 'watcher_id'
    ])
      and field.value is not null
  loop
    actor_seen := true;
    if actor.value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or not exists (
        select 1
        from private.uniondemo_ledger as ledger
        where ledger.run_id = p_run_id
          and ledger.user_id::text = actor.value
      ) then
      return false;
    end if;
  end loop;
  return actor_seen or not p_require_actor;
end;
$actors_owned$;

revoke all on function private.uniondemo_production_removal_actors_owned(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role;

create function private.uniondemo_production_removal_authorize(
  p_operation text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $guard$
declare
  pinned_system_identifier constant numeric := 7662742571317219726;
  pinned_database_oid constant oid := 5;
  pinned_confirmation_digest constant text := '5155e1a3ed12485fe08548293aa3c12c49bf16bf0e0fbce8a4072914d7688a20';
  live_system_identifier numeric;
  live_database_oid oid;
  checked_at timestamptz := pg_catalog.clock_timestamp();
  active_window private.uniondemo_production_removal_windows%rowtype;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'production removal requires service_role' using errcode = '42501';
  end if;
  if p_operation is null or p_operation <> all(array[
      'knowledge-remove', 'parity-remove', 'begin-remove', 'remove-batch']) then
    raise exception 'production removal operation refused' using errcode = '42501';
  end if;
  if p_target_ref is distinct from 'productionprojectref'
    or p_run_id is distinct from '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid then
    raise exception 'production removal scope refused' using errcode = '42501';
  end if;

  select control.system_identifier::numeric
    into live_system_identifier
  from pg_catalog.pg_control_system() as control;
  select database.oid
    into live_database_oid
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();

  if live_system_identifier is distinct from pinned_system_identifier
    or live_database_oid is distinct from pinned_database_oid then
    raise exception 'production removal installation refused' using errcode = '55000';
  end if;

  select removal_window.*
    into active_window
  from private.uniondemo_production_removal_windows as removal_window
  where removal_window.project_ref = p_target_ref
    and removal_window.run_id = p_run_id
    and removal_window.system_identifier = live_system_identifier
    and removal_window.database_oid = live_database_oid
  for share;

  if not found
    or active_window.opened_at > checked_at
    or active_window.expires_at <= checked_at
    or active_window.expires_at > active_window.opened_at + interval '4 hours 50 minutes' then
    raise exception 'production removal window is not active' using errcode = '55000';
  end if;

  if pg_catalog.encode(extensions.digest(p_confirm_token, 'sha256'), 'hex')
      is distinct from pinned_confirmation_digest then
    raise exception 'production removal confirmation refused' using errcode = '42501';
  end if;

  if exists (select 1 from private.demo_seed_installation_bindings)
    or exists (select 1 from public.organizations)
    or exists (select 1 from storage.objects) then
    raise exception 'production removal environment refused' using errcode = '55000';
  end if;

  perform 1
  from private.uniondemo_runs as run
  where run.id = p_run_id
    and run.target_ref = p_target_ref
    and run.member_count = 30000
    and run.state in ('verified', 'removing', 'removed')
    and run.protected_snapshot = private.uniondemo_protected_snapshot(p_run_id)
  for update;
  if not found then
    raise exception 'production removal run refused' using errcode = '55000';
  end if;

  if (select pg_catalog.count(*) from private.uniondemo_ledger where run_id = p_run_id) <> 30000
    or exists (
      select 1
      from auth.users as users
      join private.uniondemo_ledger as ledger on ledger.user_id = users.id
      where ledger.run_id = p_run_id
        and (pg_catalog.lower(users.email) is distinct from ledger.email
          or users.raw_app_meta_data ->> 'uniondemo_run_id' is distinct from p_run_id::text)
    )
    or exists (
      select 1 from auth.sessions as sessions
      join private.uniondemo_ledger as ledger on ledger.user_id = sessions.user_id
      where ledger.run_id = p_run_id
    )
    or exists (
      select 1 from auth.refresh_tokens as tokens
      join private.uniondemo_ledger as ledger on ledger.user_id::text = tokens.user_id::text
      where ledger.run_id = p_run_id
    ) then
    raise exception 'production removal ownership or session preflight refused' using errcode = '55000';
  end if;

  -- A ledger proves Auth identity ownership, not ownership of rows merely
  -- sharing a mapped chapter or a synthetic-looking id. Before remove-batch's
  -- first DELETE, require every actor carried by broad-delete candidates to be
  -- present in this run's ledger. Root content must carry at least one owned
  -- actor; actorless join/derived rows are admitted only through an already
  -- checked parent surface. This is the committed counterpart of the
  -- cleanupContentInvariant rehearsal's foreign-row negative control.
  if p_operation = 'remove-batch' and (
    exists (select 1 from public.member_profiles row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id left join private.uniondemo_ledger ledger on ledger.run_id = p_run_id and ledger.user_id = row_value.id where map.run_id = p_run_id and ledger.user_id is null)
    or exists (select 1 from public.chapter_task_activity row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_comments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_assignments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_subtasks row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_attachments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_files row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_messages row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_watchers row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_dependencies row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_template_details row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_tasks row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_thread_posts row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_threads row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_spaces row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_workstreams row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.member_events row_value where row_value.id like 'ud-evt-%' and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.member_ballots row_value where row_value.id like 'ud-ballot-%' and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.member_surveys row_value where row_value.id like 'ud-pulse-%' and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.member_broadcasts row_value where row_value.id like 'ud-bc-%' and not private.uniondemo_production_removal_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (
      select 1
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where relation.relkind = 'f'
        and namespace.nspname !~ '^pg_'
        and namespace.nspname <> 'information_schema'
    )
  ) then
    raise exception 'production removal found unproven actor or foreign-table content'
      using errcode = '55000';
  end if;
end;
$guard$;

revoke all on function private.uniondemo_production_removal_authorize(text, uuid, text, text)
  from public, anon, authenticated, service_role;

comment on function private.uniondemo_production_removal_authorize(text, uuid, text, text) is
  'Removal-only production guard: exact operation, run, project, installation, active expiring owner-attended window, confirmation, protected snapshot, ownership, and revoked-session preflight.';

-- The following definitions are the exact current reviewed case-graph/message
-- generation with one substitution in each body: its single SAMPLE guard call
-- becomes the operation-specific production-removal guard. CREATE OR REPLACE
-- preserves the existing owner and ACL.

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
    if p_target_ref = 'productionprojectref' then
      perform private.uniondemo_production_removal_authorize('knowledge-remove',p_run_id,p_target_ref,p_confirm_token);
    else
      perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
    end if;
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
  if p_target_ref = 'productionprojectref' then
    perform private.uniondemo_production_removal_authorize('parity-remove',p_run_id,p_target_ref,p_confirm_token);
  else
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  end if;
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
  if p_target_ref = 'productionprojectref' then
    perform private.uniondemo_production_removal_authorize('begin-remove',p_run_id,p_target_ref,p_confirm_token);
  else
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  end if;
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
  if p_target_ref = 'productionprojectref' then
    perform private.uniondemo_production_removal_authorize('remove-batch',p_run_id,p_target_ref,p_confirm_token);
  else
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  end if;
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

commit;
