-- SEC-UG-PRIVATE-BUCKET-ORPHAN-SWEEP-COVERAGE-20260920
--
-- public.reconcile_chapter_task_files is the only routine that enumerates
-- private Storage objects with no registration row, and it covered only
-- 'case-files' and 'chapter-task-files'. The other two private buckets can
-- reach the same state with no deletion path at all:
--   * member-form-files: member_form_files rows go with the account-deletion
--     cascade auth.users -> member_forms -> member_form_files, and nothing
--     removes the bytes;
--   * organization-knowledge: public.cancel_steward_library_upload deletes the
--     organization_knowledge_files row without requiring the object be gone.
--
-- Both buckets admit an authenticated upload only when the registration row
-- already exists (member_form_files_storage_insert; the organization-knowledge
-- insert policy matches organization_knowledge_files.storage_path), so an
-- object older than the existing one-hour grace with no row is an orphan. The
-- sweep now reports those objects as exact deletion targets for the Storage API
-- (api/task-files-reconcile.js), exactly as it does for the first two buckets,
-- and accepts them as expected-deletion targets on the second pass. Pending,
-- claimed and removal-row handling is unchanged: those lifecycles exist only
-- for case and task files. SQL still never deletes storage.objects.
--
-- The case-graph lock prologue 20260907151000 wrapped around this function is
-- kept. Grants are preserved by CREATE OR REPLACE (service_role only).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.reconcile_chapter_task_files(
  p_max_orphan_objects integer default 500,
  p_expected_deleted_objects jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  object_cap integer := least(greatest(coalesce(p_max_orphan_objects, 0), 0), 500);
  expected_deleted_objects jsonb := coalesce(p_expected_deleted_objects, '[]'::jsonb);
  expected_objects_remaining jsonb := '[]'::jsonb;
  case_bucket_visible boolean;
  task_bucket_visible boolean;
  form_bucket_visible boolean;
  knowledge_bucket_visible boolean;
  case_stale bigint := 0;
  task_stale bigint := 0;
  case_claimed integer := 0;
  task_claimed integer := 0;
  case_removed integer := 0;
  task_removed integer := 0;
  case_removal_retired integer := 0;
  task_removal_retired integer := 0;
  removal_object_total bigint := 0;
  object_delete_total bigint := 0;
  orphan_total bigint := 0;
  object_deletes jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(expected_deleted_objects) <> 'array' then
    raise exception 'invalid expected deletion targets' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(expected_deleted_objects) > 500 then
    raise exception 'too many expected deletion targets' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(expected_deleted_objects) target(value)
    where pg_catalog.jsonb_typeof(target.value) <> 'object'
      or coalesce(target.value ->> 'bucketId', '') not in (
        'case-files', 'chapter-task-files', 'member-form-files', 'organization-knowledge')
      or coalesce(pg_catalog.length(target.value ->> 'objectName'), 0) not between 1 and 1024
  ) then
    raise exception 'invalid expected deletion target' using errcode = '22023';
  end if;

  delete from private.attachment_removal_receipts
  where deleted_at < now() - interval '30 days';

  select exists(select 1 from storage.buckets b where b.id = 'case-files') into case_bucket_visible;
  select exists(select 1 from storage.buckets b where b.id = 'chapter-task-files') into task_bucket_visible;
  select exists(select 1 from storage.buckets b where b.id = 'member-form-files') into form_bucket_visible;
  select exists(select 1 from storage.buckets b where b.id = 'organization-knowledge') into knowledge_bucket_visible;

  with expected as (
    select distinct
      target.value ->> 'bucketId' as bucket_id,
      target.value ->> 'objectName' as object_name
    from pg_catalog.jsonb_array_elements(expected_deleted_objects) target(value)
  ), remaining as (
    select expected.bucket_id, expected.object_name
    from expected
    where (expected.bucket_id = 'case-files' and not case_bucket_visible)
      or (expected.bucket_id = 'chapter-task-files' and not task_bucket_visible)
      or (expected.bucket_id = 'member-form-files' and not form_bucket_visible)
      or (expected.bucket_id = 'organization-knowledge' and not knowledge_bucket_visible)
      or exists (
        select 1
        from storage.objects o
        where o.bucket_id = expected.bucket_id
          and o.name = expected.object_name
      )
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'bucketId', remaining.bucket_id,
    'objectName', remaining.object_name
  ) order by remaining.bucket_id, remaining.object_name), '[]'::jsonb)
  into expected_objects_remaining
  from remaining;

  select count(*) into case_stale from public.member_case_files f
  where f.removal_requested_at is null
    and (
      f.cleanup_requested_at is not null
      or (f.created_at < now() - interval '24 hours' and (
        not exists (select 1 from storage.objects o
          where o.bucket_id = f.bucket_id and o.name = f.object_name)
        or (f.confirmed_at is null and f.cleanup_requested_at is null and exists (
          select 1 from storage.objects o
          where o.bucket_id = f.bucket_id and o.name = f.object_name
            and o.created_at < now() - interval '1 hour'))
      ))
    );
  select count(*) into task_stale from public.chapter_task_files f
  where f.removal_requested_at is null
    and (
      f.cleanup_requested_at is not null
      or (f.created_at < now() - interval '24 hours' and (
        not exists (select 1 from storage.objects o
          where o.bucket_id = f.bucket_id and o.name = f.object_name)
        or (f.confirmed_at is null and f.cleanup_requested_at is null and exists (
          select 1 from storage.objects o
          where o.bucket_id = f.bucket_id and o.name = f.object_name
            and o.created_at < now() - interval '1 hour'))
      ))
    );

  if case_bucket_visible then
    with claimed_case_candidates as (
      select f.id
      from public.member_case_files f
      join storage.objects o
        on o.bucket_id = f.bucket_id and o.name = f.object_name
      where f.confirmed_at is null and f.cleanup_requested_at is null
        and f.removal_requested_at is null
        and f.created_at < now() - interval '24 hours'
        and o.created_at < now() - interval '1 hour'
      order by f.created_at, f.id
      for update of f skip locked
      limit object_cap
    ), claimed_case_pending as (
      update public.member_case_files f
      set cleanup_requested_at = coalesce(f.cleanup_requested_at, now())
      from claimed_case_candidates candidate
      where f.id = candidate.id and f.confirmed_at is null
        and f.cleanup_requested_at is null
        and f.removal_requested_at is null
      returning f.id
    )
    select count(*) into case_claimed from claimed_case_pending;

    delete from public.member_case_files f
    where f.removal_requested_at is null
      and (
        f.cleanup_requested_at is not null
        or f.created_at < now() - interval '24 hours'
      )
      and not exists (select 1 from storage.objects o
        where o.bucket_id = f.bucket_id and o.name = f.object_name);
    get diagnostics case_removed = row_count;

    with retired_case_removal_candidates as (
      select f.id, f.removal_id, f.removal_requested_by
      from public.member_case_files f
      where f.removal_requested_at is not null
        and f.removal_id is not null
        and f.removal_requested_by is not null
        and f.removal_requested_at < now() - interval '15 minutes'
        and not exists (select 1 from storage.objects o
          where o.bucket_id = f.bucket_id and o.name = f.object_name)
      order by f.removal_requested_at, f.id
      for update of f skip locked
      limit 500
    ), recorded_case_removal_receipts as (
      insert into private.attachment_removal_receipts
        (file_kind, file_id, removal_id, requested_by)
      select 'member_case', candidate.id, candidate.removal_id, candidate.removal_requested_by
      from retired_case_removal_candidates candidate
      on conflict (file_kind, file_id, removal_id, requested_by) do update
        set deleted_at = excluded.deleted_at
      returning file_id
    ), retired_case_removals as (
      delete from public.member_case_files f
      using retired_case_removal_candidates candidate, recorded_case_removal_receipts receipt
      where f.id = candidate.id and receipt.file_id = candidate.id
      returning f.id
    )
    select count(*) into case_removal_retired from retired_case_removals;
  end if;
  if task_bucket_visible then
    with claimed_task_candidates as (
      select f.id
      from public.chapter_task_files f
      join storage.objects o
        on o.bucket_id = f.bucket_id and o.name = f.object_name
      where f.confirmed_at is null and f.cleanup_requested_at is null
        and f.removal_requested_at is null
        and f.created_at < now() - interval '24 hours'
        and o.created_at < now() - interval '1 hour'
      order by f.created_at, f.id
      for update of f skip locked
      limit greatest(object_cap - case_claimed, 0)
    ), claimed_task_pending as (
      update public.chapter_task_files f
      set cleanup_requested_at = coalesce(f.cleanup_requested_at, now())
      from claimed_task_candidates candidate
      where f.id = candidate.id and f.confirmed_at is null
        and f.cleanup_requested_at is null
        and f.removal_requested_at is null
      returning f.id
    )
    select count(*) into task_claimed from claimed_task_pending;

    delete from public.chapter_task_files f
    where f.removal_requested_at is null
      and (
        f.cleanup_requested_at is not null
        or f.created_at < now() - interval '24 hours'
      )
      and not exists (select 1 from storage.objects o
        where o.bucket_id = f.bucket_id and o.name = f.object_name);
    get diagnostics task_removed = row_count;

    with retired_task_removal_candidates as (
      select f.id, f.removal_id, f.removal_requested_by
      from public.chapter_task_files f
      where f.removal_requested_at is not null
        and f.removal_id is not null
        and f.removal_requested_by is not null
        and f.removal_requested_at < now() - interval '15 minutes'
        and not exists (select 1 from storage.objects o
          where o.bucket_id = f.bucket_id and o.name = f.object_name)
      order by f.removal_requested_at, f.id
      for update of f skip locked
      limit 500
    ), recorded_task_removal_receipts as (
      insert into private.attachment_removal_receipts
        (file_kind, file_id, removal_id, requested_by)
      select 'chapter_task', candidate.id, candidate.removal_id, candidate.removal_requested_by
      from retired_task_removal_candidates candidate
      on conflict (file_kind, file_id, removal_id, requested_by) do update
        set deleted_at = excluded.deleted_at
      returning file_id
    ), retired_task_removals as (
      delete from public.chapter_task_files f
      using retired_task_removal_candidates candidate, recorded_task_removal_receipts receipt
      where f.id = candidate.id and receipt.file_id = candidate.id
      returning f.task_id, f.chapter_id, f.removal_requested_by, f.filename
    ), removal_activity as (
      insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, from_value)
      select retired.task_id, retired.chapter_id, retired.removal_requested_by,
        'file_removed', retired.filename
      from retired_task_removals retired
      returning 1
    )
    select count(*) into task_removal_retired from retired_task_removals;
  end if;

  with candidates as (
    select o.bucket_id, o.name as object_name, o.created_at
    from storage.objects o
    where o.bucket_id in ('case-files', 'chapter-task-files', 'member-form-files', 'organization-knowledge')
      and (
        (o.created_at < now() - interval '1 hour' and (
          (o.bucket_id = 'case-files' and not exists (
            select 1 from public.member_case_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          or (o.bucket_id = 'chapter-task-files' and not exists (
            select 1 from public.chapter_task_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          -- Registration rows are written before an upload is admitted
          -- (member_form_files_storage_insert, the organization-knowledge
          -- insert policy), so an object an hour old with no row is an orphan.
          or (o.bucket_id = 'member-form-files' and not exists (
            select 1 from public.member_form_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          or (o.bucket_id = 'organization-knowledge' and not exists (
            select 1 from public.organization_knowledge_files f
            where f.storage_path = o.name and f.storage_path <> 'pending'))
        ))
        or (o.bucket_id = 'case-files' and exists (
          select 1 from public.member_case_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.confirmed_at is null and f.cleanup_requested_at is not null))
        or (o.bucket_id = 'chapter-task-files' and exists (
          select 1 from public.chapter_task_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.confirmed_at is null and f.cleanup_requested_at is not null))
        or (o.bucket_id = 'case-files' and exists (
          select 1 from public.member_case_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.removal_requested_at is not null
            and f.removal_requested_at < now() - interval '15 minutes'))
        or (o.bucket_id = 'chapter-task-files' and exists (
          select 1 from public.chapter_task_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.removal_requested_at is not null
            and f.removal_requested_at < now() - interval '15 minutes'))
      )
  )
  select count(*) into object_delete_total from candidates;

  select count(*) into removal_object_total
  from storage.objects o
  where (o.bucket_id = 'case-files' and exists (
      select 1 from public.member_case_files f
      where f.bucket_id = o.bucket_id and f.object_name = o.name
        and f.removal_requested_at is not null
        and f.removal_requested_at < now() - interval '15 minutes'))
    or (o.bucket_id = 'chapter-task-files' and exists (
      select 1 from public.chapter_task_files f
      where f.bucket_id = o.bucket_id and f.object_name = o.name
        and f.removal_requested_at is not null
        and f.removal_requested_at < now() - interval '15 minutes'));

  select count(*) into orphan_total
  from storage.objects o
  where o.bucket_id in ('case-files', 'chapter-task-files', 'member-form-files', 'organization-knowledge')
    and o.created_at < now() - interval '1 hour'
    and (
      (o.bucket_id = 'case-files' and not exists (
        select 1 from public.member_case_files f
        where f.bucket_id = o.bucket_id and f.object_name = o.name))
      or (o.bucket_id = 'chapter-task-files' and not exists (
        select 1 from public.chapter_task_files f
        where f.bucket_id = o.bucket_id and f.object_name = o.name))
      or (o.bucket_id = 'member-form-files' and not exists (
        select 1 from public.member_form_files f
        where f.bucket_id = o.bucket_id and f.object_name = o.name))
      or (o.bucket_id = 'organization-knowledge' and not exists (
        select 1 from public.organization_knowledge_files f
        where f.storage_path = o.name and f.storage_path <> 'pending'))
    );

  with candidates as (
    select o.bucket_id, o.name as object_name, o.created_at
    from storage.objects o
    where o.bucket_id in ('case-files', 'chapter-task-files', 'member-form-files', 'organization-knowledge')
      and (
        (o.created_at < now() - interval '1 hour' and (
          (o.bucket_id = 'case-files' and not exists (
            select 1 from public.member_case_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          or (o.bucket_id = 'chapter-task-files' and not exists (
            select 1 from public.chapter_task_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          -- Registration rows are written before an upload is admitted
          -- (member_form_files_storage_insert, the organization-knowledge
          -- insert policy), so an object an hour old with no row is an orphan.
          or (o.bucket_id = 'member-form-files' and not exists (
            select 1 from public.member_form_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          or (o.bucket_id = 'organization-knowledge' and not exists (
            select 1 from public.organization_knowledge_files f
            where f.storage_path = o.name and f.storage_path <> 'pending'))
        ))
        or (o.bucket_id = 'case-files' and exists (
          select 1 from public.member_case_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.confirmed_at is null and f.cleanup_requested_at is not null))
        or (o.bucket_id = 'chapter-task-files' and exists (
          select 1 from public.chapter_task_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.confirmed_at is null and f.cleanup_requested_at is not null))
        or (o.bucket_id = 'case-files' and exists (
          select 1 from public.member_case_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.removal_requested_at is not null
            and f.removal_requested_at < now() - interval '15 minutes'))
        or (o.bucket_id = 'chapter-task-files' and exists (
          select 1 from public.chapter_task_files f
          where f.bucket_id = o.bucket_id and f.object_name = o.name
            and f.removal_requested_at is not null
            and f.removal_requested_at < now() - interval '15 minutes'))
      )
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'bucketId', page.bucket_id, 'objectName', page.object_name
  ) order by page.created_at, page.bucket_id, page.object_name), '[]'::jsonb)
  into object_deletes
  from (
    select * from candidates
    order by created_at, bucket_id, object_name
    limit object_cap
  ) page;

  return pg_catalog.jsonb_build_object(
    'staleRowsRemoved', case_removed + task_removed,
    'pendingRowsClaimed', case_claimed + task_claimed,
    'removalRowsRetired', case_removal_retired + task_removal_retired,
    'removalObjectTotal', removal_object_total,
    'staleRowsSkippedBlind',
      (case when case_bucket_visible then 0 else case_stale end)
      + (case when task_bucket_visible then 0 else task_stale end),
    'objectDeletes', object_deletes,
    'expectedObjectsRemaining', expected_objects_remaining,
    'objectDeleteTotal', object_delete_total,
    'orphanObjects', '[]'::jsonb,
    'orphanTotal', orphan_total,
    'ranAt', now());
end;
end $$;

comment on function public.reconcile_chapter_task_files(integer,jsonb) is
  'Service-only two-pass reconciliation for stale pending and orphaned private attachment objects: case/task pending, removal and rowless objects, plus rowless member-form-files and organization-knowledge objects. Reports exact Storage API deletion targets, proves which expected targets remain after deletion, and never deletes storage.objects in SQL.';

commit;
