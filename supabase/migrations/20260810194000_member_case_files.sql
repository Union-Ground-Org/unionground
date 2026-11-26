-- UB-CASE-01: private grievance document vault. This deliberately follows the
-- chapter-task register-then-upload contract: SQL mints the exact path, and
-- Storage accepts bytes only for a registration owned by the caller.

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'case-files', 'case-files', false, 10485760,
  array['application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.member_case_files (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null references public.member_cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  bucket_id text not null default 'case-files',
  object_name text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint member_case_files_bucket_pinned check (bucket_id = 'case-files'),
  constraint member_case_files_filename_bounded check (
    char_length(btrim(filename)) between 1 and 160
    and filename !~ '[/\\]' and filename !~ '[[:cntrl:]]'
  ),
  constraint member_case_files_size_bounded check (size_bytes between 1 and 10485760),
  constraint member_case_files_mime_allowed check (mime_type in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ))
);

create index member_case_files_case_created_idx on public.member_case_files(case_id, created_at, id);
create index member_case_files_user_created_idx on public.member_case_files(user_id, created_at desc);
create index member_case_files_uploaded_by_idx on public.member_case_files(uploaded_by);

alter table public.member_case_files enable row level security;
create policy member_case_files_select_owner_or_coordinator
  on public.member_case_files for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.staff_can_see_user(user_id, 'coordinator')
  );
create policy mfa_assurance on public.member_case_files
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.member_case_files from public, anon, authenticated;
grant select on table public.member_case_files to authenticated;

create or replace function public.register_member_case_file(
  p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  case_row public.member_cases%rowtype;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := btrim(coalesce(p_filename, ''));
  inserted public.member_case_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if char_length(clean_name) not between 1 and 160
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
    id, case_id, user_id, object_name, filename, mime_type, size_bytes, uploaded_by
  ) values (
    file_id, case_row.id, case_row.user_id,
    case_row.user_id || '/' || case_row.id || '/' || file_id || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller
  ) returning * into inserted;

  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'caseId', inserted.case_id, 'userId', inserted.user_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'createdAt', inserted.created_at
  );
end $$;

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
  where f.id = p_file_id
    and (f.user_id = caller or public.staff_can_see_user(f.user_id, 'coordinator'))
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  delete from public.member_case_files where id = file_row.id;
  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end $$;

revoke all on function public.register_member_case_file(uuid,text,text,bigint) from public, anon;
grant execute on function public.register_member_case_file(uuid,text,text,bigint) to authenticated;
revoke all on function public.remove_member_case_file(uuid) from public, anon;
grant execute on function public.remove_member_case_file(uuid) to authenticated;

create or replace function private.can_read_member_case_object(p_bucket text, p_name text)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and (f.user_id = (select auth.uid()) or public.staff_can_see_user(f.user_id, 'coordinator'))
  );
$$;
create or replace function private.can_write_member_case_object(p_bucket text, p_name text)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.member_case_files f
    where f.bucket_id = p_bucket and f.object_name = p_name
      and (
        f.user_id = (select auth.uid())
        or public.staff_can_see_user(f.user_id, 'coordinator')
      )
  );
$$;
revoke all on function private.can_read_member_case_object(text,text) from public, anon, authenticated;
grant execute on function private.can_read_member_case_object(text,text) to authenticated;
revoke all on function private.can_write_member_case_object(text,text) from public, anon, authenticated;
grant execute on function private.can_write_member_case_object(text,text) to authenticated;

drop policy if exists member_case_files_storage_read on storage.objects;
create policy member_case_files_storage_read on storage.objects for select to authenticated
using (bucket_id = 'case-files' and (select private.mfa_satisfied()) and private.can_read_member_case_object(bucket_id, name));
drop policy if exists member_case_files_storage_insert on storage.objects;
create policy member_case_files_storage_insert on storage.objects for insert to authenticated
with check (bucket_id = 'case-files' and (select private.mfa_satisfied()) and private.can_write_member_case_object(bucket_id, name));
drop policy if exists member_case_files_storage_delete on storage.objects;
create policy member_case_files_storage_delete on storage.objects for delete to authenticated
using (bucket_id = 'case-files' and (select private.mfa_satisfied()) and private.can_write_member_case_object(bucket_id, name));

comment on table public.member_case_files is
  'Private grievance attachments visible only to the case owner and chapter/org-scoped coordinators. Paths are minted by register_member_case_file before upload.';
