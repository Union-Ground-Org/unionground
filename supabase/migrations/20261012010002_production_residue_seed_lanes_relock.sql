-- OPS-UG-PRODUCTION-RESIDUE-CLEANUP-EXECUTION-20260912
-- F2/F3 are applied only inside the separately authorized cleanup window.
-- Sources captured with pg_get_functiondef from PostgreSQL.
-- Four predecessor-only leading LFs were corrected locally; both body and
-- definition hashes now match R4's read-only production capture exactly.
-- Before any hosted unlock, MAIN must compare these hashes with a fresh read-only
-- production capture. Any difference refuses the window; never regenerate from drift.
-- No seed, apply, reapply, enrich, login, verify or shared authorization body changes.
-- F3 restores all six captured definitions byte for byte, then drops F2 helpers.

begin;

do $restore_hashes$
declare entry record; current_sha256 text;
begin
  for entry in select * from (values
    ('public.remove_mi1_knowledge_sample(text,uuid,text,text)', '6a6e3a273c5e90fcef658059995e22cf2d62c68e24ec4021631f42bd80d28329', 'e4d378991898e8cc575883e90b4a98bb4616598ff85a68625c46148910dce2e3'),
    ('public.uniondemo_remove_function_parity(uuid,text,text)', '88a3bba62b18a5ee19a6147e3091e7d0badadf31c8a410d09900d74e32db6194', 'cd79e269c0ec1414c85232274b999a988ba6ab6a4e2955086219b85e88162a02'),
    ('public.uniondemo_begin_remove(uuid,text,text)', 'bbc281b6f8f8f6e247b9e467634df74a95cd8ad2701fdede3504ebae9939a8d8', 'a3d4e2b94399177b8a6a404a5a89dae16e91424efa69e9434ea9ce12989602f3'),
    ('public.uniondemo_remove_batch(uuid,integer,text,text)', 'cdb348b9e8391e930e6da54b837051d82551ec026adad386c51d93d1432289ff', '82a172eb8fa37e94ecea07bf05ca3b27d2bc68adb8d02f3bd62c6b55578de73d'),
    ('public.member_stress_begin_remove(uuid,text,text)', '82fc1af513f7a8d03e2a9b8325e1f97d85bab6e152723302c65783046d4722b1', '630eda50f4dd0804855ccd09f278c9236ca798f64dffdea34f1128d615594b52'),
    ('public.member_stress_remove_batch(uuid,integer,text,text)', 'fc77734881191e77e218563073eaa98b07fecad25a0f9e32a00211d7db226f82', 'bec707694135cc3f1b363d10ee768bffc60f6db4c5feb01729e6d353a575d440')
  ) as captured(signature, original_sha256, unlocked_sha256) loop
    current_sha256 := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
      pg_catalog.pg_get_functiondef(entry.signature::regprocedure), 'UTF8'), 'sha256'), 'hex');
    if current_sha256 is distinct from entry.original_sha256
      and current_sha256 is distinct from entry.unlocked_sha256 then
      raise exception 'production residue seed source changed; relock refuses overwrite' using errcode = '55000';
    end if;
  end loop;
end;
$restore_hashes$;

-- Captured definition sha256: 6a6e3a273c5e90fcef658059995e22cf2d62c68e24ec4021631f42bd80d28329
CREATE OR REPLACE FUNCTION public.remove_mi1_knowledge_sample(p_lane text, p_run_id uuid, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
-- Captured definition sha256: 88a3bba62b18a5ee19a6147e3091e7d0badadf31c8a410d09900d74e32db6194
CREATE OR REPLACE FUNCTION public.uniondemo_remove_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
-- Captured definition sha256: bbc281b6f8f8f6e247b9e467634df74a95cd8ad2701fdede3504ebae9939a8d8
CREATE OR REPLACE FUNCTION public.uniondemo_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '180s'
AS $function$
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
-- Captured definition sha256: cdb348b9e8391e930e6da54b837051d82551ec026adad386c51d93d1432289ff
CREATE OR REPLACE FUNCTION public.uniondemo_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '300s'
AS $function$
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
-- Captured definition sha256: 82fc1af513f7a8d03e2a9b8325e1f97d85bab6e152723302c65783046d4722b1
CREATE OR REPLACE FUNCTION public.member_stress_begin_remove(p_run_id uuid, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  run private.member_stress_runs%rowtype;
  collision_count bigint;
  remaining bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then return jsonb_build_object('state', 'removed', 'remaining', 0, 'resumed', true); end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified', 'removing') then raise exception 'run cannot be removed'; end if;
  if run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) then
    raise exception 'non-stress user snapshot changed; removal stopped';
  end if;
  select count(*) into collision_count
  from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id
  where ledger.run_id = p_run_id
    and (lower(users.email) <> ledger.email
      or coalesce(users.raw_app_meta_data ->> 'member_stress_run_id', '') <> p_run_id::text);
  if collision_count <> 0 then raise exception 'removal preflight found non-owned auth rows'; end if;
  update private.member_stress_runs set state = 'removing', updated_at = now() where id = p_run_id;
  select count(*) into remaining from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  return jsonb_build_object('state', 'removing', 'remaining', remaining, 'resumed', run.state = 'removing');
end;
end;
$function$;
-- Captured definition sha256: fc77734881191e77e218563073eaa98b07fecad25a0f9e32a00211d7db226f82
CREATE OR REPLACE FUNCTION public.member_stress_remove_batch(p_run_id uuid, p_batch_count integer, p_target_ref text, p_confirm_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '120s'
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  run private.member_stress_runs%rowtype;
  deleted_count bigint;
  remaining bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 5000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then return jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed'); end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  with selected as (
    select users.id
    from auth.users users
    join private.member_stress_ledger ledger on ledger.user_id = users.id
    where ledger.run_id = p_run_id
      and lower(users.email) = ledger.email
      and users.raw_app_meta_data ->> 'member_stress_run_id' = p_run_id::text
    order by ledger.ordinal
    limit p_batch_count
  ), deleted as (
    delete from auth.users users using selected where users.id = selected.id returning users.id
  ) select count(*) into deleted_count from deleted;

  select count(*) into remaining from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  if remaining = 0 then
    if run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) then
      raise exception 'non-stress user snapshot changed during removal';
    end if;
    -- Synthetic ballot choices carry no user_id, so the auth.users cascade
    -- cannot reach them; sweep them by run id before the run closes.
    delete from public.member_ballot_choices where stress_run_id = p_run_id;
    update private.member_stress_runs set state = 'removed', removed_at = now(), updated_at = now() where id = p_run_id;
  end if;
  return jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
end;
end;
end;
$function$;
drop function if exists private.production_residue_uniondemo_preflight(text, uuid, text);
drop function if exists private.production_residue_root_owned(uuid, text, jsonb, text);
drop function if exists private.production_residue_seed_root_known(uuid, text, jsonb);
drop function if exists private.production_residue_seed_kept_scope(text, uuid);
drop function if exists private.production_residue_seed_assert_active();
drop function if exists private.production_residue_actors_owned(uuid, jsonb, boolean);
drop table if exists private.production_residue_root_ownership;

commit;
