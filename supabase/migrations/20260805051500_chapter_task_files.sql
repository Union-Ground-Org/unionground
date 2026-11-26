-- Device file attachments for chapter tasks (owner direction 2026-08-04:
-- "users should be able to attach docs from the mobile device or computer").
-- The existing chapter_task_attachments table stays what it is — authorized
-- in-app record LINKS — and real files land in a private bucket with a
-- registration row per object. Register-then-upload: the RPC mints the row
-- and the object path, and the storage policies only accept objects whose
-- path was registered by the caller, so the bucket can never hold an
-- unaccounted file.

-- A. Bucket ----------------------------------------------------------------

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'chapter-task-files',
  'chapter-task-files',
  false,
  10485760,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'text/plain',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- B. Registration rows ------------------------------------------------------

create table public.chapter_task_files (
  id uuid primary key default extensions.gen_random_uuid(),
  task_id uuid not null references public.chapter_tasks(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete restrict,
  bucket_id text not null default 'chapter-task-files',
  object_name text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint chapter_task_files_bucket_pinned
    check (bucket_id = 'chapter-task-files'),
  constraint chapter_task_files_filename_bounded
    check (
      char_length(btrim(filename)) between 1 and 160
      and filename !~ '[/\\]'
      and filename !~ '[[:cntrl:]]'
    ),
  constraint chapter_task_files_size_bounded
    check (size_bytes between 1 and 10485760),
  constraint chapter_task_files_mime_allowed
    check (mime_type in (
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
      'text/plain', 'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ))
);

create index chapter_task_files_task_created_idx
  on public.chapter_task_files (task_id, created_at, id);
create index chapter_task_files_uploaded_by_idx
  on public.chapter_task_files (uploaded_by);

alter table public.chapter_task_files enable row level security;

-- Same visibility boundary as chapter_task_attachments: any member of the
-- task's chapter may see the file list.
create policy chapter_task_files_select_board
  on public.chapter_task_files
  for select to authenticated
  using (
    (select auth.uid()) is not null
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

create policy mfa_assurance on public.chapter_task_files
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.chapter_task_files from public, anon, authenticated;
grant select on table public.chapter_task_files to authenticated;

-- C. Registration and removal ----------------------------------------------

create or replace function public.register_chapter_task_file(
  p_task_id uuid,
  p_filename text,
  p_mime_type text,
  p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  task_row public.chapter_tasks%rowtype;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := btrim(coalesce(p_filename, ''));
  inserted public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if char_length(clean_name) not between 1 and 160
     or clean_name ~ '[/\\]' or clean_name ~ '[[:cntrl:]]' then
    raise exception 'file name must be 1-160 characters without path separators' using errcode = '22023';
  end if;
  if coalesce(p_size_bytes, 0) not between 1 and 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = '22023';
  end if;
  if p_mime_type not in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception 'file type is not accepted' using errcode = '22023';
  end if;

  select t.* into task_row
  from public.chapter_tasks t
  join public.member_profiles p on p.id = caller and p.chapter_id = t.chapter_id
  where t.id = p_task_id and t.deleted_at is null
  for update of t;
  if task_row.id is null then
    raise exception 'task unavailable' using errcode = '22023';
  end if;

  insert into public.chapter_task_files (
    id, task_id, chapter_id, object_name, filename, mime_type, size_bytes, uploaded_by
  ) values (
    file_id,
    task_row.id,
    task_row.chapter_id,
    task_row.chapter_id || '/' || task_row.id || '/' || file_id || '/' || clean_name,
    clean_name,
    p_mime_type,
    p_size_bytes,
    caller
  ) returning * into inserted;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, task_row.chapter_id, caller, 'file_added', inserted.id::text
  );

  return pg_catalog.jsonb_build_object(
    'id', inserted.id,
    'taskId', inserted.task_id,
    'chapterId', inserted.chapter_id,
    'bucketId', inserted.bucket_id,
    'objectName', inserted.object_name,
    'filename', inserted.filename,
    'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes,
    'uploadedBy', inserted.uploaded_by,
    'createdAt', inserted.created_at
  );
end
$$;

create or replace function public.remove_chapter_task_file(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  where f.id = p_file_id
  for update of f;
  if file_row.id is null then
    raise exception 'file unavailable' using errcode = '22023';
  end if;

  -- The object goes first so a crash leaves an orphaned ROW (harmless,
  -- retryable) rather than an orphaned OBJECT nothing references.
  delete from storage.objects
  where bucket_id = file_row.bucket_id and name = file_row.object_name;

  delete from public.chapter_task_files where id = file_row.id;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, from_value
  ) values (
    file_row.task_id, file_row.chapter_id, caller, 'file_removed', file_row.filename
  );

  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end
$$;

revoke all on function public.register_chapter_task_file(uuid, text, text, bigint) from public, anon;
grant execute on function public.register_chapter_task_file(uuid, text, text, bigint) to authenticated;
revoke all on function public.remove_chapter_task_file(uuid) from public, anon;
grant execute on function public.remove_chapter_task_file(uuid) to authenticated;

-- D. Storage policies -------------------------------------------------------

-- One definer helper per verb keeps the per-object policy an indexed lookup.
create or replace function private.can_read_chapter_task_object(p_bucket text, p_name text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chapter_task_files f
    join public.chapter_tasks t on t.id = f.task_id and t.deleted_at is null
    join public.member_profiles p
      on p.id = (select auth.uid())
     and p.chapter_id = t.chapter_id
    where f.bucket_id = p_bucket
      and f.object_name = p_name
  );
$$;

create or replace function private.can_write_chapter_task_object(p_bucket text, p_name text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chapter_task_files f
    where f.bucket_id = p_bucket
      and f.object_name = p_name
      and f.uploaded_by = (select auth.uid())
  );
$$;

revoke all on function private.can_read_chapter_task_object(text, text) from public, anon, authenticated;
grant execute on function private.can_read_chapter_task_object(text, text) to authenticated;
revoke all on function private.can_write_chapter_task_object(text, text) from public, anon, authenticated;
grant execute on function private.can_write_chapter_task_object(text, text) to authenticated;

drop policy if exists chapter_task_files_storage_read on storage.objects;
create policy chapter_task_files_storage_read
on storage.objects
for select to authenticated
using (
  bucket_id = 'chapter-task-files'
  and (select private.mfa_satisfied())
  and private.can_read_chapter_task_object(bucket_id, name)
);

drop policy if exists chapter_task_files_storage_insert on storage.objects;
create policy chapter_task_files_storage_insert
on storage.objects
for insert to authenticated
with check (
  bucket_id = 'chapter-task-files'
  and (select private.mfa_satisfied())
  and private.can_write_chapter_task_object(bucket_id, name)
);

drop policy if exists chapter_task_files_storage_delete on storage.objects;
create policy chapter_task_files_storage_delete
on storage.objects
for delete to authenticated
using (
  bucket_id = 'chapter-task-files'
  and (select private.mfa_satisfied())
  and private.can_write_chapter_task_object(bucket_id, name)
);

comment on table public.chapter_task_files is
  'Registration rows for device-file attachments on chapter tasks. Register-then-upload: storage policies accept only objects whose exact path was minted by register_chapter_task_file for the caller, so the private bucket holds no unaccounted objects.';

-- E. Activity vocabulary ----------------------------------------------------

alter table public.chapter_task_activity drop constraint chapter_task_activity_action_check;
alter table public.chapter_task_activity add constraint chapter_task_activity_action_check
  check (action in (
    'created', 'status_changed', 'assignee_changed', 'type_changed',
    'blocked', 'unblocked', 'board_changed', 'deleted', 'restored',
    'attachment_added', 'attachment_removed', 'file_added', 'file_removed'
  ));
