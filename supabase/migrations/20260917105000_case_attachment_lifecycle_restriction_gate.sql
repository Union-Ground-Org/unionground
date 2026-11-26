-- SEC-UG-CASE-ATTACHMENT-LIFECYCLE-RPCS-IGNORE-RESTRICTION-20260917
--
-- PR #2119 (20260917020000) put private.coordinator_case_for_update and the
-- legacy exact-path Storage predicates behind the parent case row's
-- restriction. The live attachment path never reaches those helpers.
-- sensitive_case_server_upload is a restrictive INSERT
-- `with check (bucket_id <> 'case-files')`, so no authenticated client inserts
-- into case-files; uploads go through the two-phase RPCs and a service-role
-- write that public.sensitive_case_upload_target authorizes first.
--
-- Each of those RPCs still selected the case or file on
-- `c.user_id = caller or public.staff_can_see_user(c.user_id, 'coordinator')`
-- and never consulted public.member_cases.is_restricted. A grant-less
-- in-scope coordinator could therefore:
--
--   1. begin_member_case_file_upload — mint a pending member_case_files row
--      on a restricted case they cannot read.
--   2. confirm_member_case_file_upload — expose the attachment once its
--      bytes exist.
--   3. request_member_case_file_removal — tombstone a confirmed attachment
--      so can_read_member_case_object and can_delete_member_case_object
--      answer false for everyone, including the owner.
--   4. register_member_case_file — the retired one-step path, still EXECUTE
--      granted; it passes the case lookup and mints a confirmed row before
--      the inspection gate refuses (rolling the row back). Same lookup hole.
--   5. remove_member_case_file — the retired one-step delete; same coordinator
--      branch on the file row.
--
-- Not re-emitted: public.sensitive_case_upload_target (20260906190000:311),
-- the RPC api/sensitive-case-files.js calls before the service-role byte
-- write. Its staff branch already ANDs private.casework_staff_can_access,
-- whose restriction branch (20260828210000) is the same steward /
-- coordinator_user_id / advisor-admin-vp / active-grant list, so a
-- grant-less coordinator is refused 42501 there on Main today. The proof
-- keeps that refusal as a live regression guard and the contract pins the
-- conjunct; the record registers it as out of scope.
--
-- Repair. The four named RPCs plus the sibling one-step delete add
-- private.member_case_visible_to_caller(<case id>) to the coordinator branch
-- of their case or file lookup only. Owner and uploaded_by branches are
-- unchanged. Refusals keep each RPC's existing SQLSTATE and message
-- (22023 case/file unavailable); no row is written, no tombstone is set, no
-- audit event, no storage object is touched.
--
-- Helper. PostgreSQL refuses SET role inside a SECURITY DEFINER function, so
-- these writers cannot evaluate member_cases under RLS. They call the same
-- definer predicate PR #2119 installs, private.member_case_visible_to_caller,
-- whose body is the union of the three member_cases SELECT restriction
-- branches. This file CREATE OR REPLACES that helper with the identical
-- body so the RPCs compose whether this PR or #2119 lands first: if #2119
-- already created it, this is a no-op; if this PR lands first, #2119's
-- CREATE OR REPLACE is a no-op. It does not create, replace or drop
-- private.member_case_restriction_cleared or any policy PR #2113 emits.
--
-- Bodies are the live catalog shape after 20260907151000's lock_case_graph
-- wrapper (pg_get_functiondef): the lock is the first statement of the outer
-- block. Grants, signatures and search_path settings are untouched.

begin;
set local lock_timeout = '5s';

-- Same helper PR #2119 installs. Identical body so either merge order is a
-- no-op on the other. No client EXECUTE: the only callers are sibling
-- definer writers.
create or replace function private.member_case_visible_to_caller(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_cases c
    where c.id = p_case_id
      and (
        not c.is_restricted
        or c.user_id = (select auth.uid())
        or c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or private.casework_actor_has_active_grant(c.id)
      )
  );
$function$;

comment on function private.member_case_visible_to_caller(uuid) is
  'Whether the JWT caller clears public.member_cases.is_restricted for this case. SECURITY DEFINER writers cannot SET role to evaluate the member_cases SELECT policies, so this predicate is the union of those policies'' restriction branches under a distinct name from the sibling read-side helper.';

revoke all on function private.member_case_visible_to_caller(uuid)
  from public, anon, authenticated, service_role;

-- Live body after 20260906023000 (MIME allowlist, no HEIC) wrapped by
-- 20260907151000. Visibility is a conjunct on the coordinator branch only.
create or replace function public.begin_member_case_file_upload(
  p_file_id uuid, p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
    'application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'file type is not accepted' using errcode = '22023'; end if;

  select c.* into case_row from public.member_cases c
  where c.id = p_case_id
    and (
      c.user_id = caller
      or (public.staff_can_see_user(c.user_id, 'coordinator')
        and private.member_case_visible_to_caller(c.id))
    )
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
end;
end;
$function$;

comment on function public.begin_member_case_file_upload(uuid, uuid, text, text, bigint) is
  'Mints a pending case-file row after MFA. The case owner keeps the existing path; a chapter-scoped grievance coordinator additionally needs the parent case row to be visible under the live member_cases SELECT policies.';

-- Live body after 20260906023000 (inspection gate + MIME allowlist) wrapped
-- by 20260907151000. Same coordinator conjunct. The inspection gate still
-- runs for callers who pass the lookup; a grant-less coordinator never
-- reaches it on a restricted case.
create or replace function public.register_member_case_file(
  p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
    'application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then raise exception 'file type is not accepted' using errcode = '22023'; end if;

  select c.* into case_row from public.member_cases c
  where c.id = p_case_id
    and (
      c.user_id = caller
      or (public.staff_can_see_user(c.user_id, 'coordinator')
        and private.member_case_visible_to_caller(c.id))
    )
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
  -- The row this RPC mints is confirmed on creation, so the gate has to sit
  -- here rather than at a later confirmation step. Read from the inserted row,
  -- never from an argument.
  if not private.private_upload_is_current(inserted.bucket_id, inserted.object_name) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'caseId', inserted.case_id, 'userId', inserted.user_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end;
end;
$function$;

comment on function public.register_member_case_file(uuid, text, text, bigint) is
  'Retired one-step case-file registration. The case owner keeps the existing inspection-gated path; a chapter-scoped grievance coordinator additionally needs the parent case row to be visible under the live member_cases SELECT policies.';

-- Live body after 20260906020000 (inspection gate, object lock) wrapped by
-- 20260907151000. uploaded_by = caller is unchanged; the coordinator scope
-- conjunct on the joined case gains visibility.
create or replace function public.confirm_member_case_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  file_row public.member_case_files%rowtype;
  object storage.objects%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into file_row from public.member_case_files f
  join public.member_cases c on c.id = f.case_id and c.user_id = f.user_id
  where f.id = p_file_id and f.uploaded_by = caller
    and f.cleanup_requested_at is null
    and f.removal_requested_at is null
    and (
      c.user_id = caller
      or (public.staff_can_see_user(c.user_id, 'coordinator')
        and private.member_case_visible_to_caller(c.id))
    )
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  select o.* into object from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name
      and coalesce(o.metadata ->> 'mimetype', '') = file_row.mime_type
      and coalesce(o.metadata ->> 'size', '') = file_row.size_bytes::text
    for update;
  if object.id is null then
    raise exception 'uploaded file was not found' using errcode = '22023';
  end if;
  if not private.private_upload_is_current(file_row.bucket_id, file_row.object_name) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  update public.member_case_files set confirmed_at = coalesce(confirmed_at, now())
    where id = file_row.id returning * into file_row;
  return pg_catalog.jsonb_build_object(
    'id', file_row.id, 'caseId', file_row.case_id, 'userId', file_row.user_id,
    'bucketId', file_row.bucket_id, 'objectName', file_row.object_name,
    'filename', file_row.filename, 'mimeType', file_row.mime_type,
    'sizeBytes', file_row.size_bytes, 'uploadedBy', file_row.uploaded_by,
    'confirmedAt', file_row.confirmed_at, 'createdAt', file_row.created_at);
end;
end;
$function$;

comment on function public.confirm_member_case_file_upload(uuid) is
  'Commits a pending case-file row after the uploader, exact Storage object and inspection verdict check. The owner path is unchanged; a chapter-scoped grievance coordinator additionally needs the parent case row to be visible under the live member_cases SELECT policies.';

-- Live body after 20260905005500 wrapped by 20260907151000. The idempotent
-- replay branch (same caller, same removal_id) is unchanged. The new-request
-- coordinator branch gains visibility.
create or replace function public.request_member_case_file_removal(p_file_id uuid, p_removal_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
        and (
          f.user_id = caller
          or (public.staff_can_see_user(f.user_id, 'coordinator')
            and private.member_case_visible_to_caller(f.case_id))
        )
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
end;
end;
$function$;

comment on function public.request_member_case_file_removal(uuid, uuid) is
  'Idempotent case-file deletion request. The owner path and the caller-bound replay are unchanged; a chapter-scoped grievance coordinator additionally needs the parent case row to be visible under the live member_cases SELECT policies, so a restricted case cannot be tombstoned without an explicit grant.';

-- Sibling writer found by grepping member_case_files DML. Live body after
-- 20260905005500 wrapped by 20260907151000.
create or replace function public.remove_member_case_file(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
    and (
      f.user_id = caller
      or (public.staff_can_see_user(f.user_id, 'coordinator')
        and private.member_case_visible_to_caller(f.case_id))
    )
  for update of f;
  if file_row.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if exists (select 1 from storage.objects o
    where o.bucket_id = file_row.bucket_id and o.name = file_row.object_name) then
    raise exception 'uploaded object still exists' using errcode = '22023';
  end if;
  delete from public.member_case_files where id = file_row.id;
  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end;
end;
$function$;

comment on function public.remove_member_case_file(uuid) is
  'Retired one-step case-file delete. The owner path is unchanged; a chapter-scoped grievance coordinator additionally needs the parent case row to be visible under the live member_cases SELECT policies.';

notify pgrst, 'reload schema';
commit;
