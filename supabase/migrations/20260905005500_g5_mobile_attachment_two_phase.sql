-- TEST-UG-MOBILE-NATIVE-OS-CERTIFICATION-20260814 / G5
--
-- Mobile case and task attachments use a durable two-phase protocol. The
-- client chooses the UUID before registration, uploads only to the exact
-- pending path returned by the database, then confirms after Storage has the
-- object. Pending metadata and bytes are never readable. A crash at any seam
-- therefore leaves a durable, unambiguous checkpoint for the daily service
-- reconciliation pass rather than an exposed row or an untracked object.

alter table public.member_case_files
  add column if not exists confirmed_at timestamptz;
alter table public.chapter_task_files
  add column if not exists confirmed_at timestamptz;
alter table public.member_case_files
  add column if not exists cleanup_requested_at timestamptz;
alter table public.chapter_task_files
  add column if not exists cleanup_requested_at timestamptz;
alter table public.member_case_files
  add column if not exists removal_id uuid,
  add column if not exists removal_requested_at timestamptz,
  add column if not exists removal_requested_by uuid;
alter table public.chapter_task_files
  add column if not exists removal_id uuid,
  add column if not exists removal_requested_at timestamptz,
  add column if not exists removal_requested_by uuid;

-- Every pre-migration row came from the legacy register/upload path and was
-- already user-visible. Preserve that compatibility and visibility.
update public.member_case_files set confirmed_at = created_at where confirmed_at is null;
update public.chapter_task_files set confirmed_at = created_at where confirmed_at is null;

create index if not exists member_case_files_pending_created_idx
  on public.member_case_files (confirmed_at, cleanup_requested_at, created_at, id);
create index if not exists chapter_task_files_pending_created_idx
  on public.chapter_task_files (confirmed_at, cleanup_requested_at, created_at, id);
create unique index if not exists member_case_files_removal_id_idx
  on public.member_case_files (removal_id) where removal_id is not null;
create unique index if not exists chapter_task_files_removal_id_idx
  on public.chapter_task_files (removal_id) where removal_id is not null;
create index if not exists member_case_files_removal_requested_idx
  on public.member_case_files (removal_requested_at, id)
  where removal_requested_at is not null;
create index if not exists chapter_task_files_removal_requested_idx
  on public.chapter_task_files (removal_requested_at, id)
  where removal_requested_at is not null;

-- A deleted metadata row cannot authorize a later retry. Keep a short-lived,
-- private receipt bound to the exact attachment, removal UUID, and caller so
-- only the principal who completed the removal can receive an absent result.
create table private.attachment_removal_receipts (
  file_kind text not null check (file_kind in ('member_case', 'chapter_task')),
  file_id uuid not null,
  removal_id uuid not null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  primary key (file_kind, file_id, removal_id, requested_by)
);
create index attachment_removal_receipts_deleted_at_idx
  on private.attachment_removal_receipts (deleted_at);
revoke all on private.attachment_removal_receipts
  from public, anon, authenticated, service_role;

-- Direct client reads never reveal an incomplete upload.
drop policy if exists member_case_files_select_owner_or_coordinator on public.member_case_files;
create policy member_case_files_select_owner_or_coordinator
  on public.member_case_files for select to authenticated
  using (
    member_case_files.confirmed_at is not null
    and member_case_files.removal_requested_at is null
    and (
      member_case_files.user_id = (select auth.uid())
      or public.staff_can_see_user(member_case_files.user_id, 'coordinator')
    )
  );

drop policy if exists chapter_task_files_select_board on public.chapter_task_files;
create policy chapter_task_files_select_board
  on public.chapter_task_files for select to authenticated
  using (
    chapter_task_files.confirmed_at is not null
    and chapter_task_files.removal_requested_at is null
    and (select auth.uid()) is not null
    and exists (
      select 1
      from public.chapter_tasks t
      join public.member_profiles p
        on p.id = (select auth.uid())
       and p.chapter_id = t.chapter_id
      where t.id = chapter_task_files.task_id
        and t.chapter_id = chapter_task_files.chapter_id
        and t.deleted_at is null
    )
  );

-- The read helpers also hide pending bytes. Insert helpers always recheck
-- live target authorization, including for legacy immediately-confirmed rows.
-- Authenticated Storage deletion remains available only for readable,
-- confirmed legacy rows. Pending uploads and tombstones are intentionally
-- unreadable, so their physical deletion belongs to the service reconciler.
create or replace function private.can_read_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and f.confirmed_at is not null
      and f.removal_requested_at is null
      and (f.user_id = (select auth.uid())
        or public.staff_can_see_user(f.user_id, 'coordinator'))
  );
$$;

create or replace function private.can_write_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and ((f.confirmed_at is null and f.uploaded_by = (select auth.uid()))
        or f.confirmed_at is not null)
      and (f.confirmed_at is not null or f.cleanup_requested_at is null)
      and f.removal_requested_at is null
      and (
        f.user_id = (select auth.uid())
        or public.staff_can_see_user(f.user_id, 'coordinator')
      )
  );
$$;

create function private.can_delete_member_case_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and f.confirmed_at is not null
      and f.removal_requested_at is null
      and (
        f.user_id = (select auth.uid())
        or public.staff_can_see_user(f.user_id, 'coordinator')
      )
  );
$$;

create or replace function private.can_read_chapter_task_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.chapter_task_files f
    join public.chapter_tasks t
      on t.id = f.task_id and t.chapter_id = f.chapter_id and t.deleted_at is null
    join public.member_profiles p
      on p.id = (select auth.uid()) and p.chapter_id = t.chapter_id
    where f.bucket_id = p_bucket and f.object_name = p_name
      and f.confirmed_at is not null
      and f.removal_requested_at is null
  );
$$;

create or replace function private.can_write_chapter_task_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.chapter_task_files f
    join public.chapter_tasks t
      on t.id = f.task_id and t.chapter_id = f.chapter_id and t.deleted_at is null
    join public.member_profiles p
      on p.id = (select auth.uid()) and p.chapter_id = t.chapter_id
    where f.bucket_id = p_bucket and f.object_name = p_name
      and ((f.confirmed_at is null and f.uploaded_by = (select auth.uid()))
        or f.confirmed_at is not null)
      and (f.confirmed_at is not null or f.cleanup_requested_at is null)
      and f.removal_requested_at is null
      and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
  );
$$;

create function private.can_delete_chapter_task_object(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.chapter_task_files f
    join public.chapter_tasks t
      on t.id = f.task_id and t.chapter_id = f.chapter_id and t.deleted_at is null
    join public.member_profiles p
      on p.id = (select auth.uid()) and p.chapter_id = t.chapter_id
    where f.bucket_id = p_bucket and f.object_name = p_name
      and f.confirmed_at is not null
      and f.removal_requested_at is null
      and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
  );
$$;

drop policy if exists member_case_files_storage_insert on storage.objects;
create policy member_case_files_storage_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'case-files' and (select private.mfa_satisfied())
    and private.can_write_member_case_object(bucket_id, name));
drop policy if exists member_case_files_storage_delete on storage.objects;
create policy member_case_files_storage_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'case-files' and (select private.mfa_satisfied())
    and private.can_delete_member_case_object(bucket_id, name));

drop policy if exists chapter_task_files_storage_insert on storage.objects;
create policy chapter_task_files_storage_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'chapter-task-files' and (select private.mfa_satisfied())
    and private.can_write_chapter_task_object(bucket_id, name));
drop policy if exists chapter_task_files_storage_delete on storage.objects;
create policy chapter_task_files_storage_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'chapter-task-files' and (select private.mfa_satisfied())
    and private.can_delete_chapter_task_object(bucket_id, name));

-- Legacy web clients keep their one-step registration RPCs. Those rows are
-- immediately confirmed; only the new mobile begin RPCs create pending rows.
create or replace function public.register_member_case_file(
  p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  case_row public.member_cases%rowtype;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) not between 1 and 160
     or clean_name ~ '[/\\]' or clean_name ~ '[[:cntrl:]]' then
    raise exception 'file name must be 1-160 characters without path separators' using errcode = '22023';
  end if;
  if coalesce(p_size_bytes, 0) not between 1 and 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = '22023';
  end if;
  if p_mime_type not in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'file type is not accepted' using errcode = '22023'; end if;

  select c.* into case_row from public.member_cases c
  where c.id = p_case_id
    and (c.user_id = caller or public.staff_can_see_user(c.user_id, 'coordinator'))
  for update of c;
  if case_row.id is null then raise exception 'case unavailable' using errcode = '22023'; end if;

  insert into public.member_case_files(
    id, case_id, user_id, object_name, filename, mime_type, size_bytes,
    uploaded_by, confirmed_at, cleanup_requested_at
  ) values (
    file_id, case_row.id, case_row.user_id,
    case_row.user_id || '/' || case_row.id || '/' || file_id || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller, now(), null
  ) returning * into inserted;
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'caseId', inserted.case_id, 'userId', inserted.user_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end $$;

create or replace function public.register_chapter_task_file(
  p_task_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) not between 1 and 160
     or clean_name ~ '[/\\]' or clean_name ~ '[[:cntrl:]]' then
    raise exception 'file name must be 1-160 characters without path separators' using errcode = '22023';
  end if;
  if coalesce(p_size_bytes, 0) not between 1 and 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = '22023';
  end if;
  if p_mime_type not in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'file type is not accepted' using errcode = '22023'; end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;
  if task_row.id is null then raise exception 'task unavailable' using errcode = '22023'; end if;

  insert into public.chapter_task_files(
    id, task_id, chapter_id, object_name, filename, mime_type, size_bytes,
    uploaded_by, confirmed_at, cleanup_requested_at
  ) values (
    file_id, task_row.id, task_row.chapter_id,
    task_row.chapter_id || '/' || task_row.id || '/' || file_id || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller, now(), null
  ) returning * into inserted;
  insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, to_value)
  values (task_row.id, task_row.chapter_id, caller, 'file_added', inserted.id::text);
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'taskId', inserted.task_id, 'chapterId', inserted.chapter_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end $$;

create function public.begin_member_case_file_upload(
  p_file_id uuid, p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  case_row public.member_cases%rowtype;
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_file_id is null then raise exception 'file id required' using errcode = '22023'; end if;
  if pg_catalog.char_length(clean_name) not between 1 and 160
     or clean_name ~ '[/\\]' or clean_name ~ '[[:cntrl:]]' then
    raise exception 'file name must be 1-160 characters without path separators' using errcode = '22023';
  end if;
  if coalesce(p_size_bytes, 0) not between 1 and 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = '22023';
  end if;
  if p_mime_type not in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'file type is not accepted' using errcode = '22023'; end if;

  select c.* into case_row from public.member_cases c
  where c.id = p_case_id
    and (c.user_id = caller or public.staff_can_see_user(c.user_id, 'coordinator'))
  for update of c;
  if case_row.id is null then raise exception 'case unavailable' using errcode = '22023'; end if;
  insert into public.member_case_files(
    id, case_id, user_id, object_name, filename, mime_type, size_bytes,
    uploaded_by, confirmed_at, cleanup_requested_at
  ) values (
    p_file_id, case_row.id, case_row.user_id,
    case_row.user_id || '/' || case_row.id || '/' || p_file_id || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller, null, null
  ) returning * into inserted;
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'caseId', inserted.case_id, 'userId', inserted.user_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end $$;

create function public.begin_chapter_task_file_upload(
  p_file_id uuid, p_task_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_file_id is null then raise exception 'file id required' using errcode = '22023'; end if;
  if pg_catalog.char_length(clean_name) not between 1 and 160
     or clean_name ~ '[/\\]' or clean_name ~ '[[:cntrl:]]' then
    raise exception 'file name must be 1-160 characters without path separators' using errcode = '22023';
  end if;
  if coalesce(p_size_bytes, 0) not between 1 and 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = '22023';
  end if;
  if p_mime_type not in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'file type is not accepted' using errcode = '22023'; end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;
  if task_row.id is null then raise exception 'task unavailable' using errcode = '22023'; end if;
  insert into public.chapter_task_files(
    id, task_id, chapter_id, object_name, filename, mime_type, size_bytes,
    uploaded_by, confirmed_at, cleanup_requested_at
  ) values (
    p_file_id, task_row.id, task_row.chapter_id,
    task_row.chapter_id || '/' || task_row.id || '/' || p_file_id || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller, null, null
  ) returning * into inserted;
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'taskId', inserted.task_id, 'chapterId', inserted.chapter_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end $$;

create function public.confirm_member_case_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into file_row from public.member_case_files f
  join public.member_cases c on c.id = f.case_id and c.user_id = f.user_id
  where f.id = p_file_id and f.uploaded_by = caller
    and f.cleanup_requested_at is null
    and f.removal_requested_at is null
    and (c.user_id = caller or public.staff_can_see_user(c.user_id, 'coordinator'))
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name
      and coalesce(o.metadata ->> 'mimetype', '') = file_row.mime_type
      and coalesce(o.metadata ->> 'size', '') = file_row.size_bytes::text) then
    raise exception 'uploaded file was not found' using errcode = '22023';
  end if;
  update public.member_case_files set confirmed_at = coalesce(confirmed_at, now())
    where id = file_row.id returning * into file_row;
  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'caseId', file_row.case_id, 'userId', file_row.user_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at);
end $$;

create function public.confirm_chapter_task_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select f.* into file_row from public.chapter_task_files f
  join public.chapter_tasks t on t.id = f.task_id and t.chapter_id = f.chapter_id and t.deleted_at is null
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where f.id = p_file_id and f.uploaded_by = caller
    and f.cleanup_requested_at is null
    and f.removal_requested_at is null
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name
      and coalesce(o.metadata ->> 'mimetype', '') = file_row.mime_type
      and coalesce(o.metadata ->> 'size', '') = file_row.size_bytes::text) then
    raise exception 'uploaded file was not found' using errcode = '22023';
  end if;
  if file_row.confirmed_at is null then
    update public.chapter_task_files set confirmed_at = coalesce(confirmed_at, now())
      where id = file_row.id returning * into file_row;
    insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, to_value)
    values (file_row.task_id, file_row.chapter_id, caller, 'file_added', file_row.id::text);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'taskId', file_row.task_id, 'chapterId', file_row.chapter_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at);
end $$;

create function public.abort_member_case_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into file_row from public.member_case_files f
  where f.id = p_file_id and f.uploaded_by = caller and f.confirmed_at is null
  for update;
  if file_row.id is null then
    return pg_catalog.jsonb_build_object('deleted', false, 'absent', true, 'id', p_file_id);
  end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    delete from public.member_case_files where id = file_row.id;
    return pg_catalog.jsonb_build_object('deleted', true, 'absent', false, 'id', file_row.id);
  end if;
  update public.member_case_files
  set cleanup_requested_at = coalesce(cleanup_requested_at, now())
  where id = file_row.id and confirmed_at is null
  returning * into file_row;
  return pg_catalog.jsonb_build_object(
    'deleted', false, 'absent', false, 'cleanupQueued', true,
    'cleanupRequestedAt', file_row.cleanup_requested_at, 'id', file_row.id);
end $$;

create function public.abort_chapter_task_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into file_row from public.chapter_task_files f
  where f.id = p_file_id and f.uploaded_by = caller and f.confirmed_at is null
  for update;
  if file_row.id is null then
    return pg_catalog.jsonb_build_object('deleted', false, 'absent', true, 'id', p_file_id);
  end if;
  if not exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    delete from public.chapter_task_files where id = file_row.id;
    return pg_catalog.jsonb_build_object('deleted', true, 'absent', false, 'id', file_row.id);
  end if;
  update public.chapter_task_files
  set cleanup_requested_at = coalesce(cleanup_requested_at, now())
  where id = file_row.id and confirmed_at is null
  returning * into file_row;
  return pg_catalog.jsonb_build_object(
    'deleted', false, 'absent', false, 'cleanupQueued', true,
    'cleanupRequestedAt', file_row.cleanup_requested_at, 'id', file_row.id);
end $$;

-- Confirmed removal is a durable, idempotent client request followed by a
-- service-owned Storage delete and row retirement. A request immediately hides
-- both metadata and bytes, and a lost response can be replayed under the
-- caller-minted removal UUID.
create function public.request_member_case_file_removal(p_file_id uuid, p_removal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_file_id is null or p_removal_id is null then
    raise exception 'file and removal ids required' using errcode = '22023';
  end if;

  select f.* into file_row from public.member_case_files f
  where f.id = p_file_id
    and (
      (f.removal_id = p_removal_id and f.removal_requested_by = caller)
      or (
        f.removal_id is null
        and f.confirmed_at is not null
        and (f.user_id = caller or public.staff_can_see_user(f.user_id, 'coordinator'))
      )
    )
  for update;
  if file_row.id is null then
    if exists (
      select 1 from private.attachment_removal_receipts r
      where r.file_kind = 'member_case'
        and r.file_id = p_file_id
        and r.removal_id = p_removal_id
        and r.requested_by = caller
    ) then
      return pg_catalog.jsonb_build_object(
        'deleted', false, 'absent', true, 'id', p_file_id, 'removalId', p_removal_id);
    end if;
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if file_row.confirmed_at is null then
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if file_row.removal_id is not null then
    if file_row.removal_id <> p_removal_id or file_row.removal_requested_by <> caller then
      raise exception 'file unavailable' using errcode = '22023';
    end if;
  else
    update public.member_case_files
    set removal_id = p_removal_id,
        removal_requested_at = now(),
        removal_requested_by = caller
    where id = file_row.id and removal_id is null
    returning * into file_row;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'caseId', file_row.case_id, 'userId', file_row.user_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at,
    'removalId', file_row.removal_id,
    'removalRequestedAt', file_row.removal_requested_at);
end $$;

create function public.request_chapter_task_file_removal(p_file_id uuid, p_removal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_file_id is null or p_removal_id is null then
    raise exception 'file and removal ids required' using errcode = '22023';
  end if;

  select f.* into file_row from public.chapter_task_files f
  where f.id = p_file_id
    and (
      (f.removal_id = p_removal_id and f.removal_requested_by = caller)
      or (
        f.removal_id is null
        and f.confirmed_at is not null
        and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
        and exists (
          select 1
          from public.chapter_tasks t
          join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
          where t.id = f.task_id
            and t.chapter_id = f.chapter_id
            and t.deleted_at is null
        )
      )
    )
  for update;
  if file_row.id is null then
    if exists (
      select 1 from private.attachment_removal_receipts r
      where r.file_kind = 'chapter_task'
        and r.file_id = p_file_id
        and r.removal_id = p_removal_id
        and r.requested_by = caller
    ) then
      return pg_catalog.jsonb_build_object(
        'deleted', false, 'absent', true, 'id', p_file_id, 'removalId', p_removal_id);
    end if;
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if file_row.confirmed_at is null then
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if file_row.removal_id is not null then
    if file_row.removal_id <> p_removal_id or file_row.removal_requested_by <> caller then
      raise exception 'file unavailable' using errcode = '22023';
    end if;
  else
    update public.chapter_task_files
    set removal_id = p_removal_id,
        removal_requested_at = now(),
        removal_requested_by = caller
    where id = file_row.id and removal_id is null
    returning * into file_row;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'taskId', file_row.task_id, 'chapterId', file_row.chapter_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at,
    'removalId', file_row.removal_id,
    'removalRequestedAt', file_row.removal_requested_at);
end $$;

create function public.finalize_member_case_file_removal(p_file_id uuid, p_removal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_file_id is null or p_removal_id is null then
    raise exception 'file and removal ids required' using errcode = '22023';
  end if;

  select f.* into file_row from public.member_case_files f
  where f.id = p_file_id
    and f.removal_id = p_removal_id
    and f.removal_requested_by = caller
  for update;
  if file_row.id is null then
    if exists (
      select 1 from private.attachment_removal_receipts r
      where r.file_kind = 'member_case'
        and r.file_id = p_file_id
        and r.removal_id = p_removal_id
        and r.requested_by = caller
    ) then
      return pg_catalog.jsonb_build_object(
        'deleted', false, 'absent', true, 'id', p_file_id, 'removalId', p_removal_id);
    end if;
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    raise exception 'uploaded object still exists' using errcode = '22023';
  end if;

  insert into private.attachment_removal_receipts
    (file_kind, file_id, removal_id, requested_by)
  values ('member_case', file_row.id, p_removal_id, caller)
  on conflict (file_kind, file_id, removal_id, requested_by) do update
    set deleted_at = excluded.deleted_at;
  delete from public.member_case_files
  where id = file_row.id and removal_id = p_removal_id;
  return pg_catalog.jsonb_build_object(
    'deleted', true, 'absent', false, 'id', file_row.id, 'removalId', p_removal_id);
end $$;

create function public.finalize_chapter_task_file_removal(p_file_id uuid, p_removal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_file_id is null or p_removal_id is null then
    raise exception 'file and removal ids required' using errcode = '22023';
  end if;

  select f.* into file_row from public.chapter_task_files f
  where f.id = p_file_id
    and f.removal_id = p_removal_id
    and f.removal_requested_by = caller
  for update;
  if file_row.id is null then
    if exists (
      select 1 from private.attachment_removal_receipts r
      where r.file_kind = 'chapter_task'
        and r.file_id = p_file_id
        and r.removal_id = p_removal_id
        and r.requested_by = caller
    ) then
      return pg_catalog.jsonb_build_object(
        'deleted', false, 'absent', true, 'id', p_file_id, 'removalId', p_removal_id);
    end if;
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    raise exception 'uploaded object still exists' using errcode = '22023';
  end if;

  insert into private.attachment_removal_receipts
    (file_kind, file_id, removal_id, requested_by)
  values ('chapter_task', file_row.id, p_removal_id, caller)
  on conflict (file_kind, file_id, removal_id, requested_by) do update
    set deleted_at = excluded.deleted_at;
  delete from public.chapter_task_files
  where id = file_row.id and removal_id = p_removal_id;
  insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, from_value)
  values (file_row.task_id, file_row.chapter_id, caller, 'file_removed', file_row.filename);
  return pg_catalog.jsonb_build_object(
    'deleted', true, 'absent', false, 'id', file_row.id, 'removalId', p_removal_id);
end $$;

-- Legacy web clients retain their Storage-first one-step finalize RPC. They
-- may act only on a non-tombstoned confirmed row and still must prove exact
-- object absence, so rolling web/mobile deploys cannot resurrect or steal a
-- mobile removal operation.
create or replace function public.remove_member_case_file(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into file_row from public.member_case_files f
  where f.id = p_file_id and f.confirmed_at is not null
    and f.removal_requested_at is null
    and (f.user_id = caller or public.staff_can_see_user(f.user_id, 'coordinator'))
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    raise exception 'uploaded object still exists' using errcode = '22023';
  end if;
  delete from public.member_case_files where id = file_row.id;
  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end $$;

create or replace function public.remove_chapter_task_file(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  select f.* into file_row
  from public.chapter_task_files f
  join public.member_profiles p on p.id = caller and p.chapter_id = f.chapter_id
  where f.id = p_file_id and f.confirmed_at is not null
    and f.removal_requested_at is null
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    raise exception 'uploaded object still exists' using errcode = '22023';
  end if;
  delete from public.chapter_task_files where id = file_row.id;
  insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, from_value)
  values (file_row.task_id, file_row.chapter_id, caller, 'file_removed', file_row.filename);
  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end $$;

-- Service-only reconciliation reports exact bucket/name pairs. The endpoint
-- deletes bytes through Storage, then invokes this RPC again with a zero page
-- to remove rows whose pending object is now absent. SQL never deletes a
-- storage.objects row because doing so can strand backing bytes.
drop function public.reconcile_chapter_task_files(integer);
create function public.reconcile_chapter_task_files(
  p_max_orphan_objects integer default 500,
  p_expected_deleted_objects jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  object_cap integer := least(greatest(coalesce(p_max_orphan_objects, 0), 0), 500);
  expected_deleted_objects jsonb := coalesce(p_expected_deleted_objects, '[]'::jsonb);
  expected_objects_remaining jsonb := '[]'::jsonb;
  case_bucket_visible boolean;
  task_bucket_visible boolean;
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
      or coalesce(target.value ->> 'bucketId', '') not in ('case-files', 'chapter-task-files')
      or coalesce(pg_catalog.length(target.value ->> 'objectName'), 0) not between 1 and 1024
  ) then
    raise exception 'invalid expected deletion target' using errcode = '22023';
  end if;

  delete from private.attachment_removal_receipts
  where deleted_at < now() - interval '30 days';

  select exists(select 1 from storage.buckets b where b.id = 'case-files') into case_bucket_visible;
  select exists(select 1 from storage.buckets b where b.id = 'chapter-task-files') into task_bucket_visible;

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
    where o.bucket_id in ('case-files', 'chapter-task-files')
      and (
        (o.created_at < now() - interval '1 hour' and (
          (o.bucket_id = 'case-files' and not exists (
            select 1 from public.member_case_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          or (o.bucket_id = 'chapter-task-files' and not exists (
            select 1 from public.chapter_task_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
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
  where o.bucket_id in ('case-files', 'chapter-task-files')
    and o.created_at < now() - interval '1 hour'
    and (
      (o.bucket_id = 'case-files' and not exists (
        select 1 from public.member_case_files f
        where f.bucket_id = o.bucket_id and f.object_name = o.name))
      or (o.bucket_id = 'chapter-task-files' and not exists (
        select 1 from public.chapter_task_files f
        where f.bucket_id = o.bucket_id and f.object_name = o.name))
    );

  with candidates as (
    select o.bucket_id, o.name as object_name, o.created_at
    from storage.objects o
    where o.bucket_id in ('case-files', 'chapter-task-files')
      and (
        (o.created_at < now() - interval '1 hour' and (
          (o.bucket_id = 'case-files' and not exists (
            select 1 from public.member_case_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
          or (o.bucket_id = 'chapter-task-files' and not exists (
            select 1 from public.chapter_task_files f
            where f.bucket_id = o.bucket_id and f.object_name = o.name))
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
end $$;

revoke all on function public.begin_member_case_file_upload(uuid,uuid,text,text,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_member_case_file_upload(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.abort_member_case_file_upload(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.begin_chapter_task_file_upload(uuid,uuid,text,text,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.confirm_chapter_task_file_upload(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.abort_chapter_task_file_upload(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.request_member_case_file_removal(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_member_case_file_removal(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.request_chapter_task_file_removal(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_chapter_task_file_removal(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_member_case_file_upload(uuid,uuid,text,text,bigint) to authenticated;
grant execute on function public.confirm_member_case_file_upload(uuid) to authenticated;
grant execute on function public.abort_member_case_file_upload(uuid) to authenticated;
grant execute on function public.begin_chapter_task_file_upload(uuid,uuid,text,text,bigint) to authenticated;
grant execute on function public.confirm_chapter_task_file_upload(uuid) to authenticated;
grant execute on function public.abort_chapter_task_file_upload(uuid) to authenticated;
grant execute on function public.request_member_case_file_removal(uuid,uuid) to authenticated;
grant execute on function public.finalize_member_case_file_removal(uuid,uuid) to authenticated;
grant execute on function public.request_chapter_task_file_removal(uuid,uuid) to authenticated;
grant execute on function public.finalize_chapter_task_file_removal(uuid,uuid) to authenticated;

revoke all on function private.can_delete_member_case_object(text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.can_delete_chapter_task_object(text,text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_delete_member_case_object(text,text) to authenticated;
grant execute on function private.can_delete_chapter_task_object(text,text) to authenticated;

revoke all on function public.reconcile_chapter_task_files(integer,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.reconcile_chapter_task_files(integer,jsonb) to service_role;

comment on column public.member_case_files.confirmed_at is
  'NULL only while a caller-minted mobile upload is pending; direct reads and Storage reads hide pending files.';
comment on column public.chapter_task_files.confirmed_at is
  'NULL only while a caller-minted mobile upload is pending; task activity is emitted exactly once on confirmation.';
comment on column public.member_case_files.removal_id is
  'Caller-minted idempotency key for a hidden two-phase confirmed-file removal.';
comment on column public.chapter_task_files.removal_id is
  'Caller-minted idempotency key for a hidden two-phase confirmed-file removal.';
comment on table private.attachment_removal_receipts is
  'Short-lived exact caller receipts for idempotent attachment-removal retries; never exposed through the Data API.';
comment on function public.reconcile_chapter_task_files(integer,jsonb) is
  'Service-only two-pass reconciliation for stale pending and orphaned case/task attachment objects. Reports exact Storage API deletion targets, proves which expected targets remain after deletion, and never deletes storage.objects in SQL.';

-- Push cleanup and registration share one caller-scoped serialization point.
-- The advisory lock closes transactions already using these RPCs; this durable,
-- opaque barrier closes the later gap while Auth sign-out runs outside SQL.
create table private.member_session_closing_barriers (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_handle text not null,
  scope text not null,
  closed_at timestamptz not null default now(),
  primary key (user_id, session_handle),
  constraint member_session_closing_barriers_handle_check
    check (session_handle ~ '^[0-9a-f]{64}$'),
  constraint member_session_closing_barriers_scope_check
    check (scope in ('local', 'global'))
);

revoke all on private.member_session_closing_barriers
  from public, anon, authenticated, service_role;

comment on table private.member_session_closing_barriers is
  'Opaque per-session push-registration barrier retained between transactional cleanup and external Auth sign-out.';

-- Self-service MFA recovery temporarily invalidates every session, including
-- sessions created after recovery begins. A reset timestamp alone cannot close
-- that post-boundary/new-session race. Store only the claim digest and release
-- the lock atomically when the exact claim is consumed after Auth logout.
create table private.member_mfa_recovery_locks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  claim_token_hash text not null,
  locked_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint member_mfa_recovery_locks_claim_hash_check
    check (claim_token_hash ~ '^[0-9a-f]{64}$')
);

revoke all on private.member_mfa_recovery_locks
  from public, anon, authenticated, service_role;

comment on table private.member_mfa_recovery_locks is
  'Digest-only fail-closed boundary while one-time MFA recovery is between preparation and exact-claim finalization.';

-- Bind each unconsumed recovery claim to the exact live Auth session that
-- presented the one-time code. Persist only the same SHA-256 handle used by
-- the device-session boundary; raw Auth session identifiers remain private.
alter table public.mfa_recovery_codes
  add column claim_session_handle text;

-- A deploy can overlap a two-minute claim lease from the preceding function
-- definition. Invalidate only those unconsumed leases so they must be retried
-- through the session-bound implementation below. Historical consumed codes
-- remain intact.
update public.mfa_recovery_codes
set claimed_at = null,
    claim_expires_at = null,
    claim_token_hash = null,
    claim_session_handle = null
where used_at is null
  and claim_token_hash is not null;

alter table public.mfa_recovery_codes
  add constraint mfa_recovery_codes_claim_session_binding_check
  check (
    (claim_token_hash is null and claim_session_handle is null)
    or (
      claim_token_hash is not null
      and (
        used_at is not null
        or claim_session_handle ~ '^[0-9a-f]{64}$'
      )
    )
  );

comment on column public.mfa_recovery_codes.claim_session_handle is
  'Opaque SHA-256 handle of the live Auth session that claimed this recovery code; required for every new unconsumed claim.';

create or replace function public.claim_mfa_recovery_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean text := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  prefix text;
  set_row public.mfa_recovery_code_sets%rowtype;
  code_row public.mfa_recovery_codes%rowtype;
  claim_token text;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();
  -- Pin the proven Auth row through claim commit. If external revocation won
  -- the race after JWT verification, this lookup observes no row and refuses.
  perform 1
  from auth.sessions s
  where s.id = current_session
    and s.user_id = caller
  for key share;
  if not found then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  current_handle := private.member_session_handle(current_session);

  if clean !~ '^UG[A-F0-9]{16}$' then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;
  select * into set_row
  from public.mfa_recovery_code_sets
  where user_id = caller
  for update;
  if not found
     or (set_row.locked_until is not null and set_row.locked_until > pg_catalog.now()) then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;

  prefix := pg_catalog.substr(clean, 3, 8);
  select * into code_row
  from public.mfa_recovery_codes
  where user_id = caller
    and generation = set_row.generation
    and code_prefix = prefix
    and used_at is null
    and (claim_expires_at is null or claim_expires_at <= pg_catalog.now())
  for update;
  if not found or extensions.crypt(clean, code_row.code_hash) <> code_row.code_hash then
    update public.mfa_recovery_code_sets
    set failed_attempts = case when failed_attempts >= 4 then 0 else failed_attempts + 1 end,
        locked_until = case
          when failed_attempts >= 4 then pg_catalog.now() + interval '15 minutes'
          else null
        end
    where user_id = caller;
    return pg_catalog.jsonb_build_object('accepted', false);
  end if;

  claim_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  update public.mfa_recovery_codes
  set claimed_at = pg_catalog.now(),
      claim_expires_at = pg_catalog.now() + interval '2 minutes',
      claim_token_hash = pg_catalog.encode(
        extensions.digest(claim_token, 'sha256'), 'hex'),
      claim_session_handle = current_handle
  where id = code_row.id;
  update public.mfa_recovery_code_sets
  set failed_attempts = 0,
      locked_until = null
  where user_id = caller;

  return pg_catalog.jsonb_build_object(
    'claimToken', claim_token,
    'userId', caller,
    'sessionHandle', current_handle,
    'expiresIn', 120);
end;
$function$;

create or replace function private.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when claims.user_id is null then false
    when coalesce(claims.session_id, '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    when exists (
      select 1
      from private.member_mfa_recovery_locks recovery
      where recovery.user_id = claims.user_id
    ) then false
    when not exists (
      select 1
      from auth.sessions session
      left join private.member_mfa_reset_boundaries boundary
        on boundary.user_id = session.user_id
      where session.id = claims.session_id::uuid
        and session.user_id = claims.user_id
        and session.created_at > coalesce(
          boundary.invalid_before,
          '-infinity'::timestamptz
        )
    ) then false
    when claims.aal = 'aal2' then true
    else not exists (
      select 1
      from auth.mfa_factors factor
      where factor.user_id = claims.user_id
        and factor.status = 'verified'
        and factor.factor_type = 'totp'
    )
  end
  from (
    select
      (select auth.uid()) as user_id,
      (select auth.jwt() ->> 'session_id') as session_id,
      (select auth.jwt() ->> 'aal') as aal
  ) claims;
$function$;

comment on function private.mfa_satisfied() is
  'RLS predicate: denies in-progress self-recovery, otherwise requires a live Auth session newer than the latest administrator reset before AAL2 or factor absence can satisfy MFA.';

-- Keep the wire-compatible browser writer, but serialize it with sign-out
-- before resolving the JWT session or touching an endpoint row.
create or replace function public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);

  -- A fresh Auth session may retire barriers whose opaque source sessions no
  -- longer exist. Never time-expire a barrier while its Auth session remains.
  delete from private.member_session_closing_barriers b
  where b.user_id = caller
    and not exists (
      select 1
      from auth.sessions s
      where s.user_id = caller
        and private.member_session_handle(s.id) = b.session_handle
    );

  if exists (
       select 1
       from private.member_session_closing_barriers b
       where b.user_id = caller
         and (b.session_handle = current_handle or b.scope = 'global')
     ) or exists (
       select 1
       from private.member_session_revocations r
       where r.user_id = caller
         and r.session_handle = current_handle
     ) then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_endpoint is null
     or pg_catalog.lower(p_endpoint) !~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)/' then
    raise exception 'unsupported push endpoint' using errcode = '22023';
  end if;
  if p_p256dh is null or p_auth is null
     or pg_catalog.char_length(p_p256dh) not between 1 and 512
     or pg_catalog.char_length(p_auth) not between 1 and 512 then
    raise exception 'invalid push key material' using errcode = '22023';
  end if;

  insert into public.member_push_subscriptions
    (user_id, endpoint, p256dh, auth_key, session_handle)
  values
    (caller, p_endpoint, p_p256dh, p_auth, current_handle)
  on conflict (endpoint) do update
    set user_id = caller,
        p256dh = excluded.p256dh,
        auth_key = excluded.auth_key,
        session_handle = excluded.session_handle,
        last_seen_at = pg_catalog.now();
end;
$$;

revoke all on function public.upsert_push_subscription(text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.upsert_push_subscription(text,text,text)
  to authenticated, service_role;

-- Native registration follows the same outer member-session lock, then keeps
-- its established member-rate and provider-token locks in that order.
drop function public.register_my_native_push_installation(uuid,text,text,text);
create function public.register_my_native_push_installation(
  p_installation_id uuid,
  p_provider text,
  p_environment text,
  p_device_token text,
  p_expected_user_id uuid default null,
  p_expected_session_handle text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  current_session_created_at timestamptz;
  newer_live_session_owns_target boolean := false;
  clean_expected_handle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_expected_session_handle, '')));
  clean_provider text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_provider, '')));
  clean_environment text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_environment, '')));
  clean_token text;
  clean_hash text;
  token_owner uuid;
  rate_row private.member_native_push_registration_limits%rowtype;
  registered public.member_native_push_installations%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if p_expected_user_id is null
     or caller is distinct from p_expected_user_id
     or clean_expected_handle !~ '^[0-9a-f]{64}$' then
    raise exception 'member session required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);
  select s.created_at into current_session_created_at
  from auth.sessions s
  where s.id = current_session and s.user_id = caller;
  if current_handle is distinct from clean_expected_handle then
    raise exception 'member session required' using errcode = '42501';
  end if;

  delete from private.member_session_closing_barriers b
  where b.user_id = caller
    and not exists (
      select 1
      from auth.sessions s
      where s.user_id = caller
        and private.member_session_handle(s.id) = b.session_handle
    );

  if exists (
       select 1
       from private.member_session_closing_barriers b
       where b.user_id = caller
         and (b.session_handle = current_handle or b.scope = 'global')
     ) or exists (
       select 1
       from private.member_session_revocations r
       where r.user_id = caller
         and r.session_handle = current_handle
     ) then
    raise exception 'member session required' using errcode = '42501';
  end if;

  -- Count every open-session authenticated attempt before format or ownership
  -- checks. Raising above deliberately does not consume a registration limit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('native-push-member:' || caller::text));
  insert into private.member_native_push_registration_limits
    (user_id, window_started_at, request_count)
  values (caller, pg_catalog.now(), 1)
  on conflict (user_id) do update
    set window_started_at = case
          when private.member_native_push_registration_limits.window_started_at
            <= pg_catalog.now() - interval '1 hour'
          then pg_catalog.now()
          else private.member_native_push_registration_limits.window_started_at
        end,
        request_count = case
          when private.member_native_push_registration_limits.window_started_at
            <= pg_catalog.now() - interval '1 hour'
          then 1
          else least(private.member_native_push_registration_limits.request_count + 1, 31)
        end
  returning * into rate_row;

  if rate_row.request_count > 30
     and rate_row.window_started_at > pg_catalog.now() - interval '1 hour' then
    return pg_catalog.jsonb_build_object(
      'registered', false,
      'reason', 'rate_limited',
      'retryAfterSeconds', greatest(1, pg_catalog.ceil(
        extract(epoch from (rate_row.window_started_at + interval '1 hour' - pg_catalog.now()))
      )::integer));
  end if;

  if p_installation_id is null
     or p_installation_id = '00000000-0000-0000-0000-000000000000'::uuid
     or p_installation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or clean_provider not in ('apns', 'fcm')
     or (clean_provider = 'apns' and clean_environment not in ('sandbox', 'production'))
     or (clean_provider = 'fcm' and clean_environment <> 'production') then
    return pg_catalog.jsonb_build_object('registered', false, 'reason', 'unavailable');
  end if;

  clean_token := case
    when clean_provider = 'apns' then pg_catalog.lower(pg_catalog.btrim(coalesce(p_device_token, '')))
    else pg_catalog.btrim(coalesce(p_device_token, ''))
  end;
  if (clean_provider = 'apns' and (
       clean_token !~ '^[0-9a-f]+$'
       or pg_catalog.char_length(clean_token) not between 32 and 512
       or pg_catalog.char_length(clean_token) % 2 <> 0
     ))
     or (clean_provider = 'fcm' and (
       pg_catalog.char_length(clean_token) not between 20 and 4096
       or clean_token ~ '[[:space:]]'
     )) then
    return pg_catalog.jsonb_build_object('registered', false, 'reason', 'unavailable');
  end if;
  clean_hash := pg_catalog.encode(extensions.digest(clean_token, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('native-push-token:' || clean_provider || ':' || clean_hash));

  -- A device installation and provider token form one live lineage for this
  -- member. A newly created session may take them over, but an older session
  -- that is still cryptographically valid must never reclaim a row already
  -- bound to a newer live session. The caller lock makes the ordering stable.
  select exists (
    select 1
    from public.member_native_push_installations i
    join auth.sessions existing_session
      on existing_session.user_id = caller
     and private.member_session_handle(existing_session.id) = i.session_handle
    where i.user_id = caller
      and i.session_handle is distinct from current_handle
      and (
        i.installation_id = p_installation_id
        or (i.provider = clean_provider and i.token_hash = clean_hash)
      )
      and (existing_session.created_at, existing_session.id::text)
        > (current_session_created_at, current_session::text)
  ) into newer_live_session_owns_target;
  if newer_live_session_owns_target then
    raise exception 'member session required' using errcode = '42501';
  end if;

  select i.user_id into token_owner
  from public.member_native_push_installations i
  where i.provider = clean_provider
    and i.token_hash = clean_hash
  for update;
  if token_owner is not null and token_owner <> caller then
    delete from public.member_native_push_installations i
    where i.provider = clean_provider
      and i.token_hash = clean_hash;
  end if;

  delete from public.member_native_push_installations i
  where i.user_id = caller
    and i.provider = clean_provider
    and i.token_hash = clean_hash
    and i.installation_id <> p_installation_id;

  insert into public.member_native_push_installations
    (user_id, installation_id, provider, environment, device_token, session_handle)
  values
    (caller, p_installation_id, clean_provider, clean_environment, clean_token, current_handle)
  on conflict (user_id, installation_id) do update
    set provider = excluded.provider,
        environment = excluded.environment,
        device_token = excluded.device_token,
        session_handle = excluded.session_handle,
        updated_at = pg_catalog.now(),
        last_seen_at = pg_catalog.now()
  returning * into registered;

  delete from public.member_native_push_installations i
  where i.id in (
    select extra.id
    from public.member_native_push_installations extra
    where extra.user_id = caller
      and extra.id <> registered.id
    order by extra.last_seen_at desc, extra.created_at desc
    offset 9
  );

  return pg_catalog.jsonb_build_object(
    'registered', true,
    'installationId', registered.installation_id,
    'provider', registered.provider,
    'environment', registered.environment,
    'tokenFingerprint', pg_catalog.left(registered.token_hash, 12),
    'lastSeenAt', registered.last_seen_at);
end;
$$;

revoke all on function public.register_my_native_push_installation(uuid,text,text,text,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.register_my_native_push_installation(uuid,text,text,text,uuid,text)
  to authenticated;

-- Remote revocation participates in the same order. A registration that wins
-- first is deleted; one that loses sees the absent Auth session or ledger row.
create or replace function public.revoke_my_session(p_session_handle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  target_session uuid;
  clean_handle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_session_handle, '')));
  web_push_removed integer := 0;
  native_push_removed integer := 0;
  push_removed integer := 0;
  session_removed integer := 0;
  prior private.member_session_revocations%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if clean_handle = '' or p_session_handle !~ '^[0-9a-f]{64}$' then
    raise exception 'session unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();

  select * into prior
  from private.member_session_revocations r
  where r.user_id = caller
    and r.session_handle = clean_handle;
  if prior.user_id is not null then
    return pg_catalog.jsonb_build_object(
      'revoked', true,
      'alreadyRevoked', true,
      'pushSubscriptionsRemoved', prior.push_rows_removed);
  end if;

  select s.id into target_session
  from auth.sessions s
  where s.user_id = caller
    and private.member_session_handle(s.id) = clean_handle
  for update;

  if target_session is null then
    raise exception 'session unavailable' using errcode = '22023';
  end if;
  if target_session::text = current_session::text then
    raise exception 'cannot revoke the current session' using errcode = '22023';
  end if;

  delete from public.member_push_subscriptions
  where user_id = caller
    and (session_handle = clean_handle or session_handle is null);
  get diagnostics web_push_removed = row_count;

  delete from public.member_native_push_installations
  where user_id = caller
    and session_handle = clean_handle;
  get diagnostics native_push_removed = row_count;
  push_removed := web_push_removed + native_push_removed;

  delete from auth.sessions
  where id = target_session
    and user_id = caller;
  get diagnostics session_removed = row_count;
  if session_removed <> 1 then
    raise exception 'session unavailable' using errcode = '22023';
  end if;

  insert into private.member_session_revocations
    (user_id, session_handle, push_rows_removed)
  values
    (caller, clean_handle, push_removed);

  return pg_catalog.jsonb_build_object(
    'revoked', true,
    'alreadyRevoked', false,
    'pushSubscriptionsRemoved', push_removed,
    'nativePushInstallationsRemoved', native_push_removed);
end;
$$;

revoke all on function public.revoke_my_session(text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_my_session(text)
  to authenticated;

-- Destructive mobile cleanup must name the account captured by the action.
-- PostgREST may attach a newer client's JWT after the UI began signing out;
-- the server refuses that mismatch before locks or deletes. A DEFAULT keeps
-- rolling old callers resolvable while making omission fail closed.
drop function public.delete_my_native_push_installation(uuid);
create function public.delete_my_native_push_installation(
  p_installation_id uuid,
  p_expected_user_id uuid default null,
  p_expected_session_handle text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean_expected_handle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_expected_session_handle, '')));
  removed integer := 0;
begin
  if caller is null or p_expected_user_id is null
     or caller is distinct from p_expected_user_id
     or clean_expected_handle !~ '^[0-9a-f]{64}$' then
    raise exception 'member session required' using errcode = '42501';
  end if;
  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);
  if current_handle is distinct from clean_expected_handle then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if p_installation_id is null then
    raise exception 'native push installation unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('native-push-member:' || caller::text));
  delete from public.member_native_push_installations i
  where i.user_id = caller
    and i.installation_id = p_installation_id
    and i.session_handle = current_handle;
  get diagnostics removed = row_count;

  return pg_catalog.jsonb_build_object('deleted', removed = 1);
end;
$$;

revoke all on function public.delete_my_native_push_installation(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.delete_my_native_push_installation(uuid,uuid,text)
  to authenticated;

-- MFA recovery begins from a deliberately AAL1 session, so the ordinary
-- AAL2-only global sign-out preparation cannot authorize this path. The API
-- presents the service role together with the live one-time recovery claim;
-- bind cleanup to that claim before GoTrue revokes sessions out of transaction.
create function public.prepare_mfa_recovery_signout(
  p_user_id uuid,
  p_session_handle text,
  p_claim_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_session_handle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_session_handle, '')));
  clean_claim_token text := pg_catalog.btrim(coalesce(p_claim_token, ''));
  recovery_code_id uuid;
  web_push_removed integer := 0;
  native_push_removed integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null
     or clean_session_handle !~ '^[0-9a-f]{64}$'
     or clean_claim_token !~ '^[0-9a-f]{64}$' then
    raise exception 'recovery claim unavailable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || p_user_id::text));

  select c.id into recovery_code_id
  from public.mfa_recovery_codes c
  where c.user_id = p_user_id
    and c.used_at is null
    and c.claim_expires_at > pg_catalog.now()
    and c.claim_session_handle = clean_session_handle
    and c.claim_token_hash = pg_catalog.encode(
      extensions.digest(clean_claim_token, 'sha256'), 'hex')
  for update;
  if recovery_code_id is null then
    raise exception 'recovery claim unavailable' using errcode = '42501';
  end if;

  -- Re-prove and pin the exact Auth session that claimed the code. A JWT may
  -- remain cryptographically valid after its session row is revoked; no
  -- service-role factor or push mutation may begin from that stale bearer.
  perform 1
  from auth.sessions s
  where s.user_id = p_user_id
    and private.member_session_handle(s.id) = clean_session_handle
  for key share;
  if not found then
    raise exception 'recovery claim unavailable' using errcode = '42501';
  end if;

  insert into private.member_mfa_recovery_locks
    (user_id, claim_token_hash, locked_at)
  values (
    p_user_id,
    pg_catalog.encode(extensions.digest(clean_claim_token, 'sha256'), 'hex'),
    pg_catalog.clock_timestamp()
  )
  on conflict (user_id) do update
    set claim_token_hash = excluded.claim_token_hash,
        locked_at = excluded.locked_at;

  -- One live global barrier makes registration fail closed for every current
  -- or newly created session until GoTrue removes the source sessions. A later
  -- clean sign-in lazily retires barriers whose Auth sessions are gone.
  insert into private.member_session_closing_barriers
    (user_id, session_handle, scope)
  select p_user_id, private.member_session_handle(s.id), 'global'
  from auth.sessions s
  where s.user_id = p_user_id
  on conflict (user_id, session_handle) do update
    set scope = 'global',
        closed_at = pg_catalog.now();

  delete from public.member_push_subscriptions
  where user_id = p_user_id;
  get diagnostics web_push_removed = row_count;
  delete from public.member_native_push_installations
  where user_id = p_user_id;
  get diagnostics native_push_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'scope', 'global',
    'pushSubscriptionsRemoved', web_push_removed + native_push_removed,
    'nativePushInstallationsRemoved', native_push_removed,
    'serverCleanupComplete', true);
end;
$$;

revoke all on function public.prepare_mfa_recovery_signout(uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_mfa_recovery_signout(uuid,text,text)
  to service_role;

-- Consume the exact live claim and release only the recovery lock installed by
-- that claim. The shared member lock prevents an older request from releasing
-- a newer concurrent recovery attempt.
create or replace function public.finalize_mfa_recovery_code(
  p_user_id uuid,
  p_claim_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  clean_claim_token text := pg_catalog.btrim(coalesce(p_claim_token, ''));
  expected_claim_hash text;
  recovery_code_id uuid;
  changed integer := 0;
  released integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null or clean_claim_token !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  expected_claim_hash := pg_catalog.encode(
    extensions.digest(clean_claim_token, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || p_user_id::text));

  select c.id into recovery_code_id
  from public.mfa_recovery_codes c
  where c.user_id = p_user_id
    and c.used_at is null
    and c.claim_expires_at > pg_catalog.now()
    and c.claim_token_hash = expected_claim_hash
  for update;
  if recovery_code_id is null or not exists (
    select 1
    from private.member_mfa_recovery_locks l
    where l.user_id = p_user_id
      and l.claim_token_hash = expected_claim_hash
  ) then
    return false;
  end if;

  update public.mfa_recovery_codes c
  set used_at = pg_catalog.now()
  where c.id = recovery_code_id
    and c.used_at is null;
  get diagnostics changed = row_count;
  if changed <> 1 then
    return false;
  end if;

  delete from private.member_mfa_recovery_locks l
  where l.user_id = p_user_id
    and l.claim_token_hash = expected_claim_hash;
  get diagnostics released = row_count;
  return released = 1;
end;
$function$;

revoke all on function public.finalize_mfa_recovery_code(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_mfa_recovery_code(uuid,text)
  to service_role;

-- Administrator-assisted reset is the tightly controlled liveness path for a
-- self-service recovery that stopped after installing its durable account
-- lock. Establish the reset boundary first, then invalidate the abandoned
-- claim and release the recovery lock atomically. Existing sessions remain
-- denied even when provider factor deletion or logout later fails.
create or replace function public.begin_mfa_reset(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  boundary_at timestamptz;
  abandoned_claims integer := 0;
  recovery_locks_released integer := 0;
  web_push_removed integer := 0;
  native_push_removed integer := 0;
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'target required' using errcode = '22023';
  end if;
  if p_user_id = caller then
    raise exception 'an admin cannot reset their own second factor' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || p_user_id::text));
  perform 1
  from public.member_profiles
  where id = p_user_id
  for key share;
  if not found then
    raise exception 'unknown member' using errcode = '22023';
  end if;

  boundary_at := pg_catalog.clock_timestamp();
  insert into private.member_mfa_reset_boundaries
    (user_id, invalid_before, reset_by)
  values (p_user_id, boundary_at, caller)
  on conflict (user_id) do update
    set invalid_before = greatest(
          private.member_mfa_reset_boundaries.invalid_before,
          excluded.invalid_before
        ),
        reset_by = excluded.reset_by,
        created_at = pg_catalog.clock_timestamp();

  update public.mfa_recovery_codes
  set claimed_at = null,
      claim_expires_at = null,
      claim_token_hash = null,
      claim_session_handle = null
  where user_id = p_user_id
    and used_at is null
    and claim_token_hash is not null;
  get diagnostics abandoned_claims = row_count;

  delete from private.member_mfa_recovery_locks
  where user_id = p_user_id;
  get diagnostics recovery_locks_released = row_count;

  insert into private.member_session_closing_barriers
    (user_id, session_handle, scope)
  select p_user_id, private.member_session_handle(s.id), 'global'
  from auth.sessions s
  where s.user_id = p_user_id
  on conflict (user_id, session_handle) do update
    set scope = 'global',
        closed_at = pg_catalog.now();

  delete from public.member_push_subscriptions
  where user_id = p_user_id;
  get diagnostics web_push_removed = row_count;
  delete from public.member_native_push_installations
  where user_id = p_user_id;
  get diagnostics native_push_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'userId', p_user_id,
    'authorized', true,
    'staleSessionsBlocked', true,
    'abandonedClaimsInvalidated', abandoned_claims,
    'recoveryLockReleased', recovery_locks_released = 1,
    'pushSubscriptionsRemoved', web_push_removed + native_push_removed,
    'nativePushInstallationsRemoved', native_push_removed,
    'serverCleanupComplete', true);
end;
$function$;

comment on function public.begin_mfa_reset(uuid) is
  'MFA-gated administrator reset boundary and fail-closed reconciliation for stranded self-recovery, session push cleanup, and subsequent provider factor removal.';

drop function public.prepare_my_signout(text);
create function public.prepare_my_signout(
  p_scope text,
  p_expected_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean_scope text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_scope, '')));
  web_push_removed integer := 0;
  native_push_removed integer := 0;
  push_removed integer := 0;
  mfa_ok boolean := false;
begin
  if caller is null or p_expected_user_id is null
     or caller is distinct from p_expected_user_id then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if clean_scope not in ('local', 'global') then
    raise exception 'invalid signout scope' using errcode = '22023';
  end if;
  mfa_ok := private.mfa_satisfied();
  if clean_scope = 'global' and not mfa_ok then
    raise exception 'member session required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();
  current_handle := private.member_session_handle(current_session);

  delete from private.member_session_closing_barriers b
  where b.user_id = caller
    and not exists (
      select 1
      from auth.sessions s
      where s.user_id = caller
        and private.member_session_handle(s.id) = b.session_handle
    );

  if clean_scope = 'global' then
    -- Insert the proven current handle independently so an external Auth delete
    -- between catalog reads cannot erase the barrier for this request.
    insert into private.member_session_closing_barriers
      (user_id, session_handle, scope)
    values (caller, current_handle, 'global')
    on conflict (user_id, session_handle) do update
      set scope = 'global',
          closed_at = pg_catalog.now();

    -- A global sign-out also closes every remote session known at preparation
    -- time. Registration treats any still-live global row as user-wide.
    insert into private.member_session_closing_barriers
      (user_id, session_handle, scope)
    select caller, private.member_session_handle(s.id), 'global'
    from auth.sessions s
    where s.user_id = caller
    on conflict (user_id, session_handle) do update
      set scope = 'global',
          closed_at = pg_catalog.now();
  else
    insert into private.member_session_closing_barriers
      (user_id, session_handle, scope)
    values (caller, current_handle, 'local')
    on conflict (user_id, session_handle) do nothing;
  end if;

  if clean_scope = 'global' then
    delete from public.member_push_subscriptions where user_id = caller;
    get diagnostics web_push_removed = row_count;
    delete from public.member_native_push_installations where user_id = caller;
    get diagnostics native_push_removed = row_count;
  else
    delete from public.member_push_subscriptions
    where user_id = caller
      and (session_handle = current_handle or session_handle is null);
    get diagnostics web_push_removed = row_count;
    delete from public.member_native_push_installations i
    where i.user_id = caller
      and i.session_handle = current_handle;
    get diagnostics native_push_removed = row_count;
  end if;
  push_removed := web_push_removed + native_push_removed;

  return pg_catalog.jsonb_build_object(
    'scope', clean_scope,
    'pushSubscriptionsRemoved', push_removed,
    'nativePushInstallationsRemoved', native_push_removed,
    'serverCleanupComplete', true);
end;
$$;

revoke all on function public.prepare_my_signout(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_my_signout(text,uuid)
  to authenticated;

notify pgrst, 'reload schema';
