-- REQ-UG-PUBLICATION-CONTRACT-WORKSTREAM-MERGE-20260727
--
-- The last two gaps the design pass named:
--
--   A. publication_contract_check() -- referenced by
--      apply/tests/chapter-tasks-rls.test.js and never written. Without it that
--      test block is dead code asserting nothing.
--   B. Merging two workstreams. rename_chapter_workstream() deliberately
--      REFUSES a name collision, because a merge is lossier than a rename. That
--      was the right refusal and it left "we actually want these to be one
--      thing" with no path at all. This is the path, with the loss made
--      explicit and previewable.

-- A. THE PUBLICATION CONTRACT ----------------------------------------------
--
-- 20260727010153 added chapter_task_messages to supabase_realtime and asserted
-- the publication was INSERT-only. That assertion ran once, at migration time.
-- An UPDATE or DELETE quietly added later would broadcast rows to subscribers
-- whose RLS was only ever evaluated at insert time -- the kind of change that
-- looks like a feature in review and is a disclosure in production.
--
-- Service role only: it reads catalog state, not member data, and nothing in
-- the app should be able to enumerate the publication.
create or replace function public.publication_contract_check()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  pub record;
  table_names text[];
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate
    into pub
  from pg_catalog.pg_publication p
  where p.pubname = 'supabase_realtime';

  if pub is null then
    raise exception 'publication supabase_realtime is missing';
  end if;

  select pg_catalog.array_agg(pt.tablename order by pt.tablename)
    into table_names
  from pg_catalog.pg_publication_tables pt
  where pt.pubname = 'supabase_realtime';

  return pg_catalog.jsonb_build_object(
    'insertOnly', pub.pubinsert and not pub.pubupdate and not pub.pubdelete and not pub.pubtruncate,
    'tables', pg_catalog.to_jsonb(coalesce(table_names, array[]::text[]))
  );
end
$$;

revoke all on function public.publication_contract_check() from public, anon, authenticated;
grant execute on function public.publication_contract_check() to service_role;

comment on function public.publication_contract_check() is
  'Asserts supabase_realtime is still INSERT-only and lists its tables. Read by tests/chapter-tasks-rls.test.js: an UPDATE or DELETE added to the publication would broadcast rows RLS was only evaluated on at insert time.';

-- B. MERGE ------------------------------------------------------------------
--
-- Two functions, on purpose. A merge changes other people's reports, so the
-- UI must be able to say exactly what will happen BEFORE it happens --
-- preview_chapter_workstream_merge() is stable and writes nothing, and the
-- confirm dialog is built from its numbers.

create or replace function public.preview_chapter_workstream_merge(
  p_source_id uuid,
  p_target_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  source_row public.chapter_workstreams;
  target_row public.chapter_workstreams;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  select w.* into source_row from public.chapter_workstreams w
  where w.id = p_source_id and w.chapter_id = caller_chapter;
  select w.* into target_row from public.chapter_workstreams w
  where w.id = p_target_id and w.chapter_id = caller_chapter;

  if source_row.id is null or target_row.id is null then
    raise exception 'workstream unavailable' using errcode = '22023';
  end if;
  if source_row.id = target_row.id then
    raise exception 'a workstream cannot be merged into itself' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'sourceName', source_row.name,
    'targetName', target_row.name,
    -- Live cards that will change name.
    'movingTasks', (
      select pg_catalog.count(*) from public.chapter_tasks t
      where t.chapter_id = caller_chapter and t.workstream = source_row.name and t.deleted_at is null),
    -- Finished cards move too, which is the part that changes history: every
    -- past report attributing this work to the source name will attribute it
    -- to the target name from now on. Counted separately so the dialog can
    -- say so instead of burying it in one total.
    'movingDoneTasks', (
      select pg_catalog.count(*) from public.chapter_tasks t
      where t.chapter_id = caller_chapter and t.workstream = source_row.name
        and t.deleted_at is null and t.status = 'done'),
    'targetExistingTasks', (
      select pg_catalog.count(*) from public.chapter_tasks t
      where t.chapter_id = caller_chapter and t.workstream = target_row.name and t.deleted_at is null)
  );
end
$$;

create or replace function public.merge_chapter_workstreams(
  p_source_id uuid,
  p_target_id uuid,
  p_expected_moving integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  source_row public.chapter_workstreams;
  target_row public.chapter_workstreams;
  moved integer;
  actual_moving integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;

  select w.* into source_row from public.chapter_workstreams w
  where w.id = p_source_id and w.chapter_id = caller_chapter for update;
  select w.* into target_row from public.chapter_workstreams w
  where w.id = p_target_id and w.chapter_id = caller_chapter for update;

  if source_row.id is null or target_row.id is null then
    raise exception 'workstream unavailable' using errcode = '22023';
  end if;
  if source_row.id = target_row.id then
    raise exception 'a workstream cannot be merged into itself' using errcode = '22023';
  end if;

  -- Optimistic concurrency against the preview the coordinator actually read.
  -- Someone else filing three cards between the dialog opening and the button
  -- being pressed should not silently widen an irreversible operation.
  if p_expected_moving is not null then
    select pg_catalog.count(*) into actual_moving
    from public.chapter_tasks t
    where t.chapter_id = caller_chapter and t.workstream = source_row.name and t.deleted_at is null;

    if actual_moving <> p_expected_moving then
      raise exception 'this workstream changed while you were looking at it; review the merge again'
        using errcode = '40001';
    end if;
  end if;

  -- Cards first: the target name already exists, so the assert trigger passes
  -- and there is no window where a card names a list row that is gone.
  update public.chapter_tasks
    set workstream = target_row.name
    where chapter_id = caller_chapter and workstream = source_row.name;
  get diagnostics moved = row_count;

  delete from public.chapter_workstreams where id = source_row.id;

  return pg_catalog.jsonb_build_object(
    'targetId', target_row.id,
    'targetName', target_row.name,
    'removedName', source_row.name,
    'movedTasks', moved
  );
end
$$;

revoke all on function public.preview_chapter_workstream_merge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.merge_chapter_workstreams(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.preview_chapter_workstream_merge(uuid, uuid) to authenticated;
grant execute on function public.merge_chapter_workstreams(uuid, uuid, integer) to authenticated;

comment on function public.merge_chapter_workstreams(uuid, uuid, integer) is
  'Moves every task from one workstream onto another and removes the source. Irreversible: it rewrites what past reports attribute the work to. Call preview_chapter_workstream_merge() first and pass its movingTasks as p_expected_moving.';

notify pgrst, 'reload schema';
