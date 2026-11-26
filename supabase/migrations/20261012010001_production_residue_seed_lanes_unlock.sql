-- OPS-UG-PRODUCTION-RESIDUE-CLEANUP-EXECUTION-20260912
-- F2/F3 are applied only inside the separately authorized cleanup window.
-- Sources captured with pg_get_functiondef from PostgreSQL.
-- Four predecessor-only leading LFs were corrected locally; both body and
-- definition hashes now match R4's read-only production capture exactly.
-- Before any hosted unlock, MAIN must compare these hashes with a fresh read-only
-- production capture. Any difference refuses the window; never regenerate from drift.
-- No seed, apply, reapply, enrich, login, verify or shared authorization body changes.

begin;

do $source_hashes$
declare
  entry record;
  current_sha256 text;
  pinned_system_identifier constant numeric := 7662742571317219726;
  pinned_database_oid constant oid := 5;
  live_system_identifier numeric;
  live_database_oid oid;
  production_installation boolean;
begin
  select control.system_identifier::numeric into live_system_identifier from pg_catalog.pg_control_system() control;
  select database.oid into live_database_oid from pg_catalog.pg_database database where database.datname = pg_catalog.current_database();
  production_installation := live_system_identifier is not distinct from pinned_system_identifier
    and live_database_oid is not distinct from pinned_database_oid;
  -- #3561's never-production re-lock adds one leading LF in four bodies.
  -- Only its exact listed hash is admitted on a non-production replay.
  -- Production requires canonical R4 bytes; no normalization occurs here.
  for entry in select * from (values
    ('public.remove_mi1_knowledge_sample(text,uuid,text,text)', '6a6e3a273c5e90fcef658059995e22cf2d62c68e24ec4021631f42bd80d28329', '0467781450c05b97820a1cd322b2ac892075c046591d6d32c72d8d80232fe6f1'),
    ('public.uniondemo_remove_function_parity(uuid,text,text)', '88a3bba62b18a5ee19a6147e3091e7d0badadf31c8a410d09900d74e32db6194', '742c167a5aa8707955c4abb975585c468874856a1a11ecb74b1ea0c8c14fa611'),
    ('public.uniondemo_begin_remove(uuid,text,text)', 'bbc281b6f8f8f6e247b9e467634df74a95cd8ad2701fdede3504ebae9939a8d8', '6a1a2aa119be465f7c50863b2fd8f7cc827b4c20f99aa29628a8939e03cfab89'),
    ('public.uniondemo_remove_batch(uuid,integer,text,text)', 'cdb348b9e8391e930e6da54b837051d82551ec026adad386c51d93d1432289ff', '373f3d5a94629e7d28804189a6945646428f635400f28292e946c8724c95bc03'),
    ('public.member_stress_begin_remove(uuid,text,text)', '82fc1af513f7a8d03e2a9b8325e1f97d85bab6e152723302c65783046d4722b1', null),
    ('public.member_stress_remove_batch(uuid,integer,text,text)', 'fc77734881191e77e218563073eaa98b07fecad25a0f9e32a00211d7db226f82', null),
    ('private.mi1_bind_case_owner()', 'a0ca1edb107a57c44c488f3de3218a3d6c186314531e94283f46b8e3ab2e0933', 'af617c6391d5a4476a2f173e8e3e6a7bb97cb249bb31e2f5890bba8e0f615070')
  ) as captured(signature, sha256, replay_sha256) loop
    current_sha256 := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
      pg_catalog.pg_get_functiondef(entry.signature::regprocedure), 'UTF8'), 'sha256'), 'hex');
    if current_sha256 is distinct from entry.sha256
      and (production_installation or entry.replay_sha256 is null
        or current_sha256 is distinct from entry.replay_sha256) then
      raise exception 'production residue seed source changed; unlock refused' using errcode = '55000';
    end if;
  end loop;
end;
$source_hashes$;

-- T7: permit SET NULL updates with unchanged legacy ownership during the window.
-- captured Main body SHA-256: a0ca1edb107a57c44c488f3de3218a3d6c186314531e94283f46b8e3ab2e0933
CREATE OR REPLACE FUNCTION private.mi1_bind_case_owner()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  owner_organization uuid;
  owner_chapter text;
begin
  if tg_op = 'UPDATE' then
    if old.organization_id is null then
      if new.organization_id is distinct from old.organization_id
         or new.chapter_id is distinct from old.chapter_id then
        raise exception 'legacy case ownership requires an explicit backfill' using errcode = '42501';
      end if;
      return new;
    else
      if new.organization_id is distinct from old.organization_id
         or new.chapter_id is distinct from old.chapter_id then
        raise exception 'case organization and chapter are immutable' using errcode = '42501';
      end if;
      return new;
    end if;
  end if;

  select ch.organization_id, ch.id
  into owner_organization, owner_chapter
  from public.member_profiles p
  join public.chapters ch on ch.id = p.chapter_id
  where p.id = new.user_id;

  if owner_chapter is null then
    raise exception 'case owner requires a current organization chapter' using errcode = '23514';
  end if;
  if owner_organization is null then
    if new.organization_id is not null or new.chapter_id is not null then
      raise exception 'legacy case ownership cannot be supplied by the caller' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.organization_id is not null and new.organization_id is distinct from owner_organization then
    raise exception 'case organization is derived from the member chapter' using errcode = '42501';
  end if;
  if new.chapter_id is not null and new.chapter_id is distinct from owner_chapter then
    raise exception 'case chapter is derived from the member profile' using errcode = '42501';
  end if;

  new.organization_id := owner_organization;
  new.chapter_id := owner_chapter;
  return new;
end;
$function$
;

create function private.production_residue_actors_owned(
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
      'user_id', 'watcher_id', 'organizer_id'
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

revoke all on function private.production_residue_actors_owned(uuid, jsonb, boolean)
  from public, anon, authenticated, service_role;

-- A validated root survives its creator's ON DELETE SET NULL across batches.
-- Retain exact row bytes; only the original actor column may become null,
-- and only after that run-owned Auth identity has actually been removed.
create table private.production_residue_root_ownership (
  run_id uuid not null,
  relation_name text not null,
  row_id text not null,
  row_value jsonb not null,
  primary key (run_id, relation_name, row_id)
);
alter table private.production_residue_root_ownership enable row level security;
revoke all on table private.production_residue_root_ownership from public, anon, authenticated, service_role;

create function private.production_residue_seed_root_known(p_run_id uuid, p_relation text, p_row jsonb)
returns boolean language sql stable security definer set search_path = ''
as $seed_known$
select exists (
select 1
from private.uniondemo_chapters map
join public.chapters chapter on chapter.id = map.chapter_id
where map.run_id = p_run_id
  and (map.chapter_id = p_row ->> 'chapter_id'
    or (p_relation = 'member_broadcasts' and map.chapter_index = 1
      and p_row ->> 'chapter_id' is null and p_row ->> 'organization_id' is null))
  and (chapter.organization_id is null
    or chapter.organization_id = private.member_stress_uuid(p_run_id::text || ':ud:organization'))
  and (not (p_row ? 'organization_id')
    or p_row ->> 'organization_id' is not distinct from chapter.organization_id::text)
  and (
    (p_relation = 'chapter_workstreams'
      and p_row ->> 'name' = any(array['Chapter','Communications','Organizing','Grievances','Bargaining','Safety'])
      and p_row ->> 'id' = private.member_stress_uuid(p_run_id::text || ':ch' || map.chapter_index::text || ':ud:ws:' || (p_row ->> 'name'))::text)
    or (p_relation = 'member_ballots' and exists (
      select 1 from pg_catalog.generate_series(1,9) marker(n)
      where p_row ->> 'id' = 'ud-ballot-' || pg_catalog.lpad(map.chapter_index::text,2,'0') || '-'
        || case when marker.n = 9 then 'live' else pg_catalog.lpad(marker.n::text,2,'0') end
        and p_row ->> 'order_index' = (41000 + map.chapter_index * 20 + marker.n)::text
        and p_row ->> 'body' = case when marker.n = 9
          then 'Open vote for ' || map.chapter_name || ': ratify how the chapter spends its action budget this year.'
          else 'Chapter vote for ' || map.chapter_name || ': review the materials in the broadcast archive, then cast your ballot.' end
    ))
    or (p_relation = 'member_surveys' and exists (
      select 1 from pg_catalog.generate_series(1,9) marker(n)
      where p_row ->> 'id' = 'ud-pulse-' || pg_catalog.lpad(map.chapter_index::text,2,'0') || '-'
        || case when marker.n = 9 then 'live' else pg_catalog.lpad(marker.n::text,2,'0') end
        and p_row ->> 'order_index' = (42000 + map.chapter_index * 20 + marker.n)::text
        and p_row ->> 'body' = case when marker.n = 9
          then 'Your answer shapes the mentoring program the chapter pilots this fall.'
          else 'Two questions, thirty seconds. Chapter results are shared at the next meeting.' end
    ))
    or (p_relation = 'member_events' and exists (
      select 1 from (
        select 'cm-' || pg_catalog.lpad(n::text,2,'0') suffix, n position,
          'M' || pg_catalog.lpad(n::text,2,'0') code, false is_public,
          'Chapter meeting — ' || pg_catalog.to_char((p_row ->> 'starts_at')::timestamptz - interval '18 hours','Mon YYYY') title,
          (array['Chapter hall + Zoom','Union office · Room 2','Program site community room'])[1+(n%3)] location,
          'Officer reports, grievance and bargaining updates, member Q&A.' summary
        from pg_catalog.generate_series(0,47) counter(n)
        union all
        select 'tr-' || pg_catalog.lpad(n::text,2,'0'), 100+n,
          'T' || pg_catalog.lpad(n::text,2,'0'), false,
          'Steward training — ' || pg_catalog.to_char((p_row ->> 'starts_at')::timestamptz - interval '17 hours 30 minutes','Mon YYYY'),
          'Union office · Training room',
          'Weingarten rights, Step 1 practice, and casework intake for chapter stewards.'
        from pg_catalog.generate_series(1,16) counter(n)
        union all
        select 'ac-' || n::text, 200+n, 'A' || n::text, true,
          (array['Caseload-relief rally','Contract action day','Community solidarity picnic','Legislative lobby day'])[1+(n%4)]
            || ' — ' || pg_catalog.to_char((p_row ->> 'starts_at')::timestamptz - interval '16 hours','Mon YYYY'),
          (array['State House steps','Agency headquarters','City park pavilion'])[1+(n%3)],
          'Chapter turnout event: bring a coworker and wear your chapter shirt.'
        from pg_catalog.generate_series(1,8) counter(n)
        union all
        select 'nx-' || n::text, 299+n, 'N' || n::text, n<>1,
          (array['Chapter meeting','New-steward training','Caseload-relief rally'])[n],
          (array['Chapter hall + Zoom','Union office · Training room','State House steps'])[n],
          (array['Bargaining survey vote and contract update.','Module 3 — Weingarten rights and Step 1 practice.','Statewide action for enforceable caseload caps.'])[n]
        from pg_catalog.generate_series(1,3) counter(n)
      ) expected
      where p_row ->> 'id' = 'ud-evt-' || pg_catalog.lpad(map.chapter_index::text,2,'0') || '-' || expected.suffix
        and p_row ->> 'order_index' = (map.chapter_index*1000+expected.position)::text
        and p_row ->> 'check_in_code' = 'SG-U' || pg_catalog.lpad(map.chapter_index::text,2,'0') || expected.code
        and p_row ->> 'is_public' = expected.is_public::text
        and p_row ->> 'title' = expected.title
        and p_row ->> 'location' = expected.location
        and p_row ->> 'summary' = expected.summary
    ))
    or (p_relation = 'member_broadcasts' and map.chapter_index = 1
      and ((p_row ->> 'chapter_id' = map.chapter_id and chapter.organization_id is not null
          and p_row ->> 'audience_scope' = 'organization')
        or (p_row ->> 'chapter_id' is null and p_row ->> 'organization_id' is null
          and chapter.organization_id is null and p_row ->> 'audience_scope' is null))
      and exists (
        select 1 from (select
'ud-bc-' || pg_catalog.lpad(n::text, 3, '0'),
      (array['Statewide local', 'Bargaining team', 'Steward council'])[1 + (n % 3)],
      case when n % 14 = 0
        then 'Actualización estatal — semana ' || n::text
        else (array[
          'Bargaining update #' || n::text,
          'Contract enforcement wins this week',
          'Steward office hours schedule',
          'Caseload-relief campaign update',
          'Know your Weingarten rights',
          'Legislative report: what moved',
          'New member welcome and orientation dates',
          'Health & safety walkthrough results',
          'Grievance clinic openings',
          'Member spotlight and chapter wins'
        ])[1 + (n % 10)]
      end,
      case when n % 14 = 0
        then 'Resumen semanal para todos los capítulos: negociaciones, casos y próximos pasos.'
        else (array[
          'The team held the line on caseload caps at this week''s session. Full recap and the next open bargaining date inside.',
          'Three grievances settled at Step 2 this week, including a full back-pay award. Details and what they mean for your worksite.',
          'Weekly steward office hours run at every chapter office and on Zoom. Bring discipline or scheduling questions.',
          'Two more legislators signed on to the caseload-relief bill this week. Here is the whip count and your next call.',
          'If a meeting could lead to discipline, you can ask for a steward before answering. Save this one.',
          'The committee testified at the State House hearing; the recording and written testimony are linked inside.',
          'Orientation runs the first Tuesday of every month at every chapter office. Bring a new coworker.',
          'Walkthrough findings and the fixes management committed to, with deadlines members can hold them to.',
          'Drop-in grievance clinics have open slots this month. A steward will help you prepare a filing.',
          'Wins from every chapter this week, and the members who made them happen.'
        ])[1 + (n % 10)]
      end,
          (40000+n)::text order_marker,
          case when n%14=0 then 'es' else 'en' end locale
          from pg_catalog.generate_series(1,207) counter(n)
        ) expected(id,sender,title,body,order_marker,locale)
        where p_row ->> 'id' = expected.id and p_row ->> 'sender' = expected.sender
          and p_row ->> 'title' = expected.title and p_row ->> 'body' = expected.body
          and p_row ->> 'order_index' = expected.order_marker and p_row ->> 'locale' = expected.locale
      ))
  )
);
$seed_known$;
revoke all on function private.production_residue_seed_root_known(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

create function private.production_residue_root_owned(p_run_id uuid, p_relation text, p_row jsonb, p_actor text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $root_owned$
begin
  if private.production_residue_actors_owned(p_run_id, p_row, true) then return true; end if;
  if not private.production_residue_actors_owned(p_run_id, p_row, false)
    or p_row ->> p_actor is not null then return false; end if;
  if private.production_residue_seed_root_known(p_run_id, p_relation, p_row) then return true; end if;
  return exists (
    select 1 from private.production_residue_root_ownership proof
    join private.uniondemo_ledger ledger on ledger.run_id = proof.run_id
      and ledger.user_id::text = proof.row_value ->> p_actor
    where proof.run_id = p_run_id and proof.relation_name = p_relation
      and proof.row_id = p_row ->> 'id'
      and proof.row_value - p_actor = p_row - p_actor
      and not exists (select 1 from auth.users u where u.id = ledger.user_id)
  );
end;
$root_owned$;
revoke all on function private.production_residue_root_owned(uuid, text, jsonb, text)
  from public, anon, authenticated, service_role;

create function private.production_residue_seed_kept_scope(p_lane text, p_run_id uuid)
returns void language plpgsql security definer set search_path = ''
as $kept_scope$
declare selected_users uuid[];
begin
  if p_lane = 'uniondemo' then
    select array_agg(u.id) into selected_users from auth.users u
      join private.uniondemo_ledger l on l.user_id = u.id where l.run_id = p_run_id;
  elsif p_lane = 'member_stress' then
    select array_agg(u.id) into selected_users from auth.users u
      join private.member_stress_ledger l on l.user_id = u.id where l.run_id = p_run_id;
  else raise exception 'production removal scope refused' using errcode = '42501'; end if;
  if exists (select 1 from public.organization_memberships m join private.production_residue_ledger l
      on l.subject_kind = 'organization' and l.subject_id = m.organization_id::text and l.cohort = 'org-kept'
      where m.user_id = any(selected_users))
    or exists (select 1 from public.member_profiles p join private.production_residue_ledger l
      on l.subject_kind = 'chapter' and l.subject_id = p.chapter_id and l.cohort = 'chapter-kept'
      where p.id = any(selected_users))
    or exists (select 1 from public.member_chapter_memberships m join private.production_residue_ledger l
      on l.subject_kind = 'chapter' and l.subject_id = m.chapter_id and l.cohort = 'chapter-kept'
      where m.user_id = any(selected_users))
    or exists (select 1 from public.organization_role_grants g join private.production_residue_ledger l
      on l.subject_kind = 'organization' and l.subject_id = g.organization_id::text and l.cohort = 'org-kept'
      where g.user_id = any(selected_users) or g.granted_by = any(selected_users))
    or exists (select 1 from public.member_roles r
      where (r.user_id = any(selected_users) or r.granted_by = any(selected_users)) and (
        exists (select 1 from private.production_residue_ledger l
          where l.subject_kind = 'chapter' and l.subject_id = r.chapter_id and l.cohort = 'chapter-kept')
        or exists (select 1 from private.production_residue_ledger l
          where l.subject_kind = 'account' and l.subject_id = r.user_id::text and l.cohort = 'account-kept')
        or exists (select 1 from public.member_role_chapters c join private.production_residue_ledger l
          on l.subject_kind = 'chapter' and l.subject_id = c.chapter_id and l.cohort = 'chapter-kept'
          where c.user_id = r.user_id and c.role = r.role)))
    or exists (select 1 from public.member_role_chapters r join private.production_residue_ledger l
      on l.subject_kind = 'chapter' and l.subject_id = r.chapter_id and l.cohort = 'chapter-kept'
      where r.user_id = any(selected_users) or r.granted_by = any(selected_users))
    or exists (select 1 from public.member_conversations c join private.production_residue_ledger l
      on l.subject_kind = 'organization' and l.subject_id = c.organization_id::text and l.cohort = 'org-kept'
      where c.user_id = any(selected_users) or c.steward_user_id = any(selected_users))
    or exists (select 1 from public.member_messages m join public.member_conversations c on c.id = m.conversation_id
      join private.production_residue_ledger l on l.cohort = 'account-kept'
        and (l.subject_id = m.sender_id::text or l.subject_id = m.user_id::text or l.subject_id = c.user_id::text)
      where c.user_id = any(selected_users) or m.user_id = any(selected_users) or m.sender_id = any(selected_users)) then
    raise exception 'production residue kept scope refused' using errcode = '55000';
  end if;
end;
$kept_scope$;
revoke all on function private.production_residue_seed_kept_scope(text, uuid)
  from public, anon, authenticated, service_role;

create function private.production_residue_seed_assert_active()
returns void language plpgsql security definer set search_path = ''
as $active$
begin
  if not exists (select 1 from private.production_residue_windows
      where opened_at <= pg_catalog.clock_timestamp() and expires_at > pg_catalog.clock_timestamp()) then
    raise exception 'production removal window expired during operation' using errcode = '55000';
  end if;
end;
$active$;
revoke all on function private.production_residue_seed_assert_active()
  from public, anon, authenticated, service_role;
create function private.production_residue_uniondemo_preflight(p_operation text, p_run_id uuid, p_target_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $preflight$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if (select auth.role()) is distinct from 'service_role'
    or p_operation is null or p_operation <> all(array['knowledge-remove','parity-remove','begin-remove','remove-batch'])
    or p_target_ref is distinct from 'productionprojectref'
    or p_run_id is distinct from '109141a8-bb29-4b02-af4f-f00ff45ba2ea'::uuid then
    raise exception 'production removal scope refused' using errcode = '42501';
  end if;
  perform 1
  from private.uniondemo_runs as run
  where run.id = p_run_id
    and run.target_ref = p_target_ref
    and run.member_count = 30000
    and run.state in ('verified', 'removing', 'removed')
    and private.production_residue_snapshot_accounted(run.protected_snapshot, private.uniondemo_protected_snapshot(p_run_id), 'uniondemo')
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
    or exists (select 1 from public.chapter_task_activity row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_comments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_assignments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_subtasks row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_attachments row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_files row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_messages row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_watchers row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_dependencies row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_task_template_details row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), false))
    or exists (select 1 from public.chapter_tasks row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_thread_posts row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_threads row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_spaces row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_actors_owned(p_run_id, to_jsonb(row_value), true))
    or exists (select 1 from public.chapter_workstreams row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id and not private.production_residue_root_owned(p_run_id, 'chapter_workstreams', to_jsonb(row_value), 'created_by'))
    or exists (select 1 from public.member_events row_value where row_value.id like 'ud-evt-%' and not private.production_residue_root_owned(p_run_id, 'member_events', to_jsonb(row_value), 'organizer_id'))
    or exists (select 1 from public.member_ballots row_value where row_value.id like 'ud-ballot-%' and not private.production_residue_root_owned(p_run_id, 'member_ballots', to_jsonb(row_value), 'created_by'))
    or exists (select 1 from public.member_surveys row_value where row_value.id like 'ud-pulse-%' and not private.production_residue_root_owned(p_run_id, 'member_surveys', to_jsonb(row_value), 'created_by'))
    or exists (select 1 from public.member_broadcasts row_value where row_value.id like 'ud-bc-%' and not private.production_residue_root_owned(p_run_id, 'member_broadcasts', to_jsonb(row_value), 'created_by'))
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
  if p_operation = 'remove-batch' then
    insert into private.production_residue_root_ownership(run_id, relation_name, row_id, row_value)
    select p_run_id, 'chapter_workstreams', body ->> 'id', body from (select to_jsonb(row_value) body from public.chapter_workstreams row_value join private.uniondemo_chapters map on map.chapter_id = row_value.chapter_id where map.run_id = p_run_id) candidates
    where private.production_residue_actors_owned(p_run_id, body, true)
    on conflict do nothing;
    insert into private.production_residue_root_ownership(run_id, relation_name, row_id, row_value)
    select p_run_id, 'member_events', body ->> 'id', body from (select to_jsonb(row_value) body from public.member_events row_value where row_value.id like 'ud-evt-%') candidates
    where private.production_residue_actors_owned(p_run_id, body, true)
    on conflict do nothing;
    insert into private.production_residue_root_ownership(run_id, relation_name, row_id, row_value)
    select p_run_id, 'member_ballots', body ->> 'id', body from (select to_jsonb(row_value) body from public.member_ballots row_value where row_value.id like 'ud-ballot-%') candidates
    where private.production_residue_actors_owned(p_run_id, body, true)
    on conflict do nothing;
    insert into private.production_residue_root_ownership(run_id, relation_name, row_id, row_value)
    select p_run_id, 'member_surveys', body ->> 'id', body from (select to_jsonb(row_value) body from public.member_surveys row_value where row_value.id like 'ud-pulse-%') candidates
    where private.production_residue_actors_owned(p_run_id, body, true)
    on conflict do nothing;
    insert into private.production_residue_root_ownership(run_id, relation_name, row_id, row_value)
    select p_run_id, 'member_broadcasts', body ->> 'id', body from (select to_jsonb(row_value) body from public.member_broadcasts row_value where row_value.id like 'ud-bc-%') candidates
    where private.production_residue_actors_owned(p_run_id, body, true)
    on conflict do nothing;
  end if;
end;
$preflight$;

revoke all on function private.production_residue_uniondemo_preflight(text, uuid, text)
  from public, anon, authenticated, service_role;

-- Captured definition sha256: 6a6e3a273c5e90fcef658059995e22cf2d62c68e24ec4021631f42bd80d28329
-- One contiguous substitution in public.remove_mi1_knowledge_sample(text,uuid,text,text); all surrounding bytes unchanged.
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
    if p_target_ref = 'productionprojectref' then
    perform private.production_residue_authorize('uniondemo', 'knowledge-remove', p_target_ref, p_confirm_token);
    perform private.production_residue_uniondemo_preflight('knowledge-remove', p_run_id, p_target_ref);
  else
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  end if;
  else
    raise exception 'unknown demo lane';
  end if;
  declare residue_result jsonb; begin
    residue_result := private.demo_seed_remove_knowledge_library(p_lane, p_run_id);
    if p_target_ref = 'productionprojectref' and p_lane = 'uniondemo' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end;
end;
end;
end;
$function$;
-- Captured definition sha256: 88a3bba62b18a5ee19a6147e3091e7d0badadf31c8a410d09900d74e32db6194
-- One contiguous substitution in public.uniondemo_remove_function_parity(uuid,text,text); all surrounding bytes unchanged.
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
  if p_target_ref = 'productionprojectref' then
    perform private.production_residue_authorize('uniondemo', 'parity-remove', p_target_ref, p_confirm_token);
    perform private.production_residue_uniondemo_preflight('parity-remove', p_run_id, p_target_ref);
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
  declare residue_result jsonb; begin
    residue_result := base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end;
end;
end;
end;
$function$;
-- Captured definition sha256: bbc281b6f8f8f6e247b9e467634df74a95cd8ad2701fdede3504ebae9939a8d8
-- One contiguous substitution in public.uniondemo_begin_remove(uuid,text,text); all surrounding bytes unchanged.
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
  if p_target_ref = 'productionprojectref' then
    perform private.production_residue_authorize('uniondemo', 'begin-remove', p_target_ref, p_confirm_token);
    perform private.production_residue_uniondemo_preflight('begin-remove', p_run_id, p_target_ref);
  else
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  end if;
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state = 'removed' then declare residue_result jsonb; begin
    residue_result := jsonb_build_object('state', 'removed', 'remaining', 0, 'resumed', true);
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified', 'removing') then
    raise exception 'run cannot be removed';
  end if;
  if (case when p_target_ref = 'productionprojectref' then
      not private.production_residue_snapshot_accounted(run.protected_snapshot, private.uniondemo_protected_snapshot(p_run_id), 'uniondemo')
    else run.protected_snapshot <> private.uniondemo_protected_snapshot(p_run_id) end) then
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
  declare residue_result jsonb; begin
    residue_result := jsonb_build_object('state', 'removing', 'remaining', remaining, 'resumed', run.state = 'removing');
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end;
end;
end;
end;
$function$;
-- Captured definition sha256: cdb348b9e8391e930e6da54b837051d82551ec026adad386c51d93d1432289ff
-- One contiguous substitution in public.uniondemo_remove_batch(uuid,integer,text,text); all surrounding bytes unchanged.
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
  if p_target_ref = 'productionprojectref' then
    perform private.production_residue_authorize('uniondemo', 'remove-batch', p_target_ref, p_confirm_token);
    perform private.production_residue_uniondemo_preflight('remove-batch', p_run_id, p_target_ref);
  else
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  end if;
  if p_batch_count not between 1 and 2000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state = 'removed' then declare residue_result jsonb; begin
    residue_result := jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed');
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end; end if;
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

  if p_target_ref = 'productionprojectref' then
    perform private.production_residue_seed_kept_scope('uniondemo', p_run_id);
  end if;

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
    if (case when p_target_ref = 'productionprojectref' then
      not private.production_residue_snapshot_accounted(run.protected_snapshot, private.uniondemo_protected_snapshot(p_run_id), 'uniondemo')
    else run.protected_snapshot <> private.uniondemo_protected_snapshot(p_run_id) end) then
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
  declare residue_result jsonb; begin
    residue_result := jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end;
end;
end;
end;
$function$;
-- Captured definition sha256: 82fc1af513f7a8d03e2a9b8325e1f97d85bab6e152723302c65783046d4722b1
-- One contiguous substitution in public.member_stress_begin_remove(uuid,text,text); all surrounding bytes unchanged.
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
  if p_target_ref = 'productionprojectref' then
    perform private.production_residue_authorize('member_stress', 'begin-remove', p_target_ref, p_confirm_token);
    if p_run_id is distinct from '6aae4c0b-856d-4fa9-a26c-ce21a1179f8d'::uuid then
      raise exception 'production removal scope refused' using errcode = '42501';
    end if;
    perform private.member_stress_authorize(p_target_ref, 'SEED_CURRENT_MEMBER_STRESS');
  else
    perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  end if;
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then declare residue_result jsonb; begin
    residue_result := jsonb_build_object('state', 'removed', 'remaining', 0, 'resumed', true);
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified', 'removing') then raise exception 'run cannot be removed'; end if;
  if (case when p_target_ref = 'productionprojectref' then
      not private.production_residue_snapshot_accounted(run.protected_snapshot, private.member_stress_protected_snapshot(p_run_id), 'member_stress')
    else run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) end) then
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
  declare residue_result jsonb; begin
    residue_result := jsonb_build_object('state', 'removing', 'remaining', remaining, 'resumed', run.state = 'removing');
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end;
end;
end;
$function$;
-- Captured definition sha256: fc77734881191e77e218563073eaa98b07fecad25a0f9e32a00211d7db226f82
-- One contiguous substitution in public.member_stress_remove_batch(uuid,integer,text,text); all surrounding bytes unchanged.
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
  if p_target_ref = 'productionprojectref' then
    perform private.production_residue_authorize('member_stress', 'remove-batch', p_target_ref, p_confirm_token);
    if p_run_id is distinct from '6aae4c0b-856d-4fa9-a26c-ce21a1179f8d'::uuid then
      raise exception 'production removal scope refused' using errcode = '42501';
    end if;
    perform private.member_stress_authorize(p_target_ref, 'SEED_CURRENT_MEMBER_STRESS');
  else
    perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  end if;
  if p_batch_count not between 1 and 5000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then declare residue_result jsonb; begin
    residue_result := jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed');
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end; end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  if p_target_ref = 'productionprojectref' then
    perform private.production_residue_seed_kept_scope('member_stress', p_run_id);
  end if;

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
    if (case when p_target_ref = 'productionprojectref' then
      not private.production_residue_snapshot_accounted(run.protected_snapshot, private.member_stress_protected_snapshot(p_run_id), 'member_stress')
    else run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) end) then
      raise exception 'non-stress user snapshot changed during removal';
    end if;
    -- Synthetic ballot choices carry no user_id, so the auth.users cascade
    -- cannot reach them; sweep them by run id before the run closes.
    delete from public.member_ballot_choices where stress_run_id = p_run_id;
    update private.member_stress_runs set state = 'removed', removed_at = now(), updated_at = now() where id = p_run_id;
  end if;
  declare residue_result jsonb; begin
    residue_result := jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
    if p_target_ref = 'productionprojectref' then
      perform private.production_residue_seed_assert_active();
    end if;
    return residue_result;
  end;
end;
end;
end;
$function$;

commit;
