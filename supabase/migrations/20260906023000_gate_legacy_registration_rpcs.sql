begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4, second repair.
--
-- Two boundaries that slice 4 stated but did not finish.
--
-- 1. THE LEGACY ONE-STEP REGISTRATIONS ARE GATED.
--    Design decision A2 says web case/task uploads move to the two-phase
--    begin/upload/inspect/confirm contract "because register_member_case_file /
--    register_chapter_task_file set confirmed_at = now() at registration, so on
--    web there is no state where the row exists but is invisible", and then:
--    "register_* stays only for rolling-deploy compatibility and is gated in
--    slice 4 too". 20260906020000 gated the three confirm_* RPCs and left the
--    two register_* RPCs alone, so the one caller the design was worried about
--    — an old web bundle still in flight during a rolling deploy, or a direct
--    PostgREST call by any authenticated member — could still mint a CONFIRMED
--    member_case_files / chapter_task_files row for bytes nothing had inspected.
--    `authenticated` holds a direct SELECT grant on those tables, so the row was
--    visible to the member and to coordinators, and indistinguishable in the UI
--    from an inspected one. There was never byte exposure: the restrictive
--    private_upload_quarantine_read policy denies object.get_authenticated,
--    object.list and object.info_authenticated without a current verdict, and it
--    denies signing outright. This was a metadata-visibility hole and a
--    violation of invariant 3, "do not leave a row visible-but-unscanned".
--
--    Both RPCs now carry the same single gate expression every other workflow
--    function carries, over the server-owned inserted row rather than anything
--    the caller sent:
--
--        if not private.private_upload_is_current(inserted.bucket_id,
--                                                 inserted.object_name) then
--          raise exception 'file inspection required' using errcode = '42501';
--        end if;
--
--    An object cannot have a verdict at registration time — the path is minted
--    by this very call and no bytes have been uploaded against it — so in
--    practice this retires both RPCs behind a fail-closed refusal rather than
--    leaving them a way in. That is deliberate and it is the conservative half
--    of decision A2: the signatures, the grants (`authenticated` keeps EXECUTE)
--    and every existing error shape are preserved, so a stale client gets a
--    clean, typed 42501 'file inspection required' — the same refusal the
--    inspected path raises before confirmation — instead of silently creating a
--    confirmed, never-inspected attachment. Rolling deploys therefore degrade to
--    a visible upload failure on the old bundle, which is the safe direction.
--    Nothing in the repository calls either RPC any more (web and native both
--    use begin_*/confirm_*); the proofs in
--    tests/private-file-workflow-gates-db.test.js pin the refusal.
--
--    register_member_form_file is deliberately NOT gated. It leaves
--    confirmed_at null, so its row is already invisible until
--    confirm_member_form_file — which 20260906020000 gated — runs. Gating the
--    registration too would break the form upload path outright.
--
-- 2. THE RPC MIME ALLOWLISTS MATCH THE BUCKET ALLOWLISTS (decision E2).
--    20260906010000 removed 'image/heic' from all four private buckets'
--    allowed_mime_types because the inspector permanently refuses HEIC, but the
--    five registration RPCs kept 'image/heic' in their own per-call allowlist.
--    The result was fail-closed but dishonest: the RPC told the caller the type
--    was acceptable, minted a row and an object name, and Storage then refused
--    the upload with an unrelated error. All five now state the same policy as
--    the buckets — pdf, jpeg, png, webp, txt, csv, docx, xlsx.
--
-- Forward-only. No data is rewritten; every statement is a create-or-replace of
-- the latest body (20260905005500 for the four case/task RPCs, 20260812222529
-- for the form one) with exactly the two changes described above, so grants,
-- ownership, signatures and search_path settings are untouched.

-- ---------------------------------------------------------------------------
-- 1. Legacy one-step registrations — gated, HEIC removed
-- ---------------------------------------------------------------------------
create or replace function public.register_member_case_file(
  p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
end $function$;

create or replace function public.register_chapter_task_file(
  p_task_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
    'application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv',
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
  -- Before the 'file_added' activity row: that row is visible to every chapter
  -- member, so an ungated registration published an unscanned attachment into
  -- the shared task timeline exactly the way an ungated confirm did.
  if not private.private_upload_is_current(inserted.bucket_id, inserted.object_name) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  insert into public.chapter_task_activity(task_id, chapter_id, actor_id, action, to_value)
  values (task_row.id, task_row.chapter_id, caller, 'file_added', inserted.id::text);
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'taskId', inserted.task_id, 'chapterId', inserted.chapter_id,
    'bucketId', inserted.bucket_id, 'objectName', inserted.object_name,
    'filename', inserted.filename, 'mimeType', inserted.mime_type,
    'sizeBytes', inserted.size_bytes, 'uploadedBy', inserted.uploaded_by,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end $function$;

-- ---------------------------------------------------------------------------
-- 2. The remaining per-call MIME allowlists — HEIC removed, nothing else
-- ---------------------------------------------------------------------------
-- Not gated: this registration leaves confirmed_at null, so the row stays
-- invisible until the gated confirm_member_form_file runs.
create or replace function public.register_member_form_file(
  p_form_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  rec record;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.member_form_files%rowtype;
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
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then
    raise exception 'file type is not accepted' using errcode = '22023';
  end if;
  perform private.lock_member_form(p_form_id);
  select id, user_id, status into rec from public.member_forms
    where id = p_form_id for update;
  if not found or rec.user_id <> caller or rec.status not in ('draft', 'returned') then
    raise exception 'form not found or attachments are locked' using errcode = '22023';
  end if;
  if (select count(*) from public.member_form_files where form_id = p_form_id) >= 20 then
    raise exception 'attachment limit reached (max 20)' using errcode = '22023';
  end if;
  perform private.invalidate_member_form_signatures(p_form_id);
  insert into public.member_form_files (
    id, form_id, object_name, filename, mime_type, size_bytes, uploaded_by
  ) values (
    file_id, p_form_id, p_form_id::text || '/' || file_id::text || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller
  ) returning * into inserted;
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'formId', inserted.form_id, 'bucketId', inserted.bucket_id,
    'objectName', inserted.object_name, 'filename', inserted.filename,
    'mimeType', inserted.mime_type, 'sizeBytes', inserted.size_bytes,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end
$function$;

-- The two-phase checkpoints stay ungated by design — they are the pre-scan
-- write path, and their rows are invisible until the gated confirm_* runs.
-- Only the allowlist changes.
create or replace function public.begin_member_case_file_upload(
  p_file_id uuid, p_case_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
end $function$;

create or replace function public.begin_chapter_task_file_upload(
  p_file_id uuid, p_task_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
    'application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv',
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
end $function$;

notify pgrst, 'reload schema';
commit;
