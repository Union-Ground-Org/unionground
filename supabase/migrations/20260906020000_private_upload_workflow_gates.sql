begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4.
--
-- Until now every private-upload workflow could advance a file past
-- confirmation, submission, filing, indexing, review, publication, catalog
-- listing and download with no malware verdict at all. The quarantine ledger
-- (20260905021500) closed the Storage READ boundary; this migration closes the
-- WRITE and PUBLISH boundary, using exactly one predicate everywhere:
--
--     private.private_upload_is_current(bucket_id, object_name)
--
-- That predicate binds a 'clean' row to one object identity AND one object
-- version, expires it at least(now()+24h, signature_updated_at+48h), and is
-- itself security definer with search_path = ''. No gate may consult anything
-- else, and no gate may accept a caller-supplied path, digest or verdict: every
-- bucket_id/object_name below is read from a server-owned row.
--
-- It also retires public.organization_knowledge_files.scan_status as a malware
-- verdict. That column was written unconditionally by the TEXT EXTRACTION
-- worker (replace_knowledge_source_chunks wrote 'clean' when extraction merely
-- produced non-empty text, and 'blocked' on an ingest error), so five separate
-- readers were treating "the text extractor succeeded" as "the antivirus
-- passed". Those writes are removed and every reader moves to the ledger.
-- Ingest health stays in index_status / organization_knowledge_sources.health.
--
-- Deliberately NOT gated, each for a reason that is a security property:
--   * private.can_insert_organization_knowledge_object and
--     get_knowledge_file_storage_target(p_mode = 'upload') — this is the
--     pre-scan write path. Gating it would make it impossible to ever upload
--     the bytes that need scanning.
--   * private.can_delete_organization_knowledge_object — deleting quarantined
--     bytes must stay possible, mirroring 'object.delete_many' in the
--     private_upload_quarantine_read policy.
--   * public.search_member_kb and list_knowledge_review_articles_snapshot —
--     inline article/lesson/document text, not Storage-backed.
--   * organization_knowledge_files rows with storage_kind <> 'organization_storage'
--     and organization_knowledge_sources with source_kind = 'text' — no
--     storage.objects row exists, so an unconditional gate would deny them
--     forever. Every knowledge gate below is therefore conditioned on
--     storage_kind = 'organization_storage'.
--   * Google Drive bytes (api/google-drive.js) — a separate byte path that
--     never lands in the organization-knowledge bucket; gate it separately if
--     at all.
--
-- Note on digest binding (design risk 8): only the knowledge kind carries a
-- sha256 into authorize_private_upload_inspection. For case/task/form the
-- first-scan TOCTOU window between the object read and the scan rests on
-- object.version equality plus the storage.objects immutability trigger; the
-- confirm gates below take a `for update` on the Storage row so a verdict
-- cannot be superseded between the check and the commit.

-- ---------------------------------------------------------------------------
-- 0. Ledger writer: admit a provenance-free 'blocked' for structural refusals.
-- ---------------------------------------------------------------------------
-- api/private-files.js refuses a file structurally (bad magic bytes, MIME/ext
-- mismatch, archive, oversize PDF) BEFORE the antivirus engine ever runs, so it
-- has no sha256, engine string, signature version or scan timestamp to offer.
-- Requiring full provenance for 'blocked' forced that deliberate refusal to be
-- recorded as 'failed' — indistinguishable from a scanner outage. A refusal now
-- records 'blocked' with all five provenance arguments null; anything less than
-- all-five-null is still validated in full, so a partial claim cannot be
-- laundered into the ledger. 'clean' is unchanged: it still requires complete,
-- fresh provenance and still honours the digest and supersession guards.
create or replace function private.record_private_upload_scan(
  p_bucket_id text, p_object_name text, p_object_id uuid, p_object_version text,
  p_verdict text, p_sha256 text, p_engine text, p_signature_version bigint,
  p_signature_updated_at timestamptz, p_scanned_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  object storage.objects%rowtype;
  previous private.private_upload_scans%rowtype;
  expires timestamptz;
  claims_provenance boolean;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'scanner service required' using errcode = '42501';
  end if;
  if p_verdict is null or p_verdict not in ('clean','blocked','failed') then
    raise exception 'invalid scanner verdict' using errcode = '22023';
  end if;
  -- Keep the Storage-row -> ledger-row lock order used by the triggers.
  select * into object from storage.objects
  where bucket_id = p_bucket_id and name = p_object_name for update;
  if object.id is null or object.id is distinct from p_object_id
    or object.version is distinct from p_object_version then
    raise exception 'stored object changed or unavailable' using errcode = '22023';
  end if;
  select * into previous from private.private_upload_scans
  where bucket_id = p_bucket_id and object_name = p_object_name for update;
  if previous.object_id is distinct from p_object_id or previous.deleted_at is not null
    or previous.object_version is distinct from p_object_version then
    raise exception 'stored object changed or unavailable' using errcode = '22023';
  end if;
  claims_provenance := pg_catalog.num_nonnulls(
    p_sha256, p_engine, p_signature_version, p_signature_updated_at, p_scanned_at) > 0;
  -- A structural refusal is the only verdict allowed to carry no provenance,
  -- and it must carry none of it: all five arguments null together.
  if p_verdict = 'clean' or (p_verdict = 'blocked' and claims_provenance) then
    if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
      or p_engine is null or p_engine !~ '^ClamAV [0-9]+\.[0-9]+\.[0-9]+$'
      or p_signature_version is null or p_signature_version <= 0
      or p_signature_updated_at is null or p_signature_updated_at < pg_catalog.now() - interval '48 hours'
      or p_signature_updated_at > pg_catalog.now() + interval '5 minutes'
      or p_scanned_at is null or p_scanned_at < pg_catalog.now() - interval '5 minutes'
      or p_scanned_at > pg_catalog.now() + interval '5 minutes' then
      raise exception 'invalid or stale scanner provenance' using errcode = '22023';
    end if;
    if previous.sha256 is not null and previous.sha256 is distinct from p_sha256 then
      raise exception 'immutable object digest changed' using errcode = '22023';
    end if;
    if previous.scanned_at > p_scanned_at or previous.signature_version > p_signature_version then
      raise exception 'older scan cannot supersede current verdict' using errcode = '22023';
    end if;
  end if;
  expires := case when p_verdict = 'clean' then least(
    pg_catalog.now() + interval '24 hours', p_signature_updated_at + interval '48 hours'
  ) else null end;
  -- A provenance-free refusal quarantines the object and keeps whatever
  -- provenance an earlier scan recorded; clean_until is cleared either way, so
  -- private_upload_is_current stops returning true immediately. Fail closed.
  update private.private_upload_scans set status = p_verdict,
    sha256 = coalesce(p_sha256, previous.sha256), engine = coalesce(p_engine, previous.engine),
    signature_version = coalesce(p_signature_version, previous.signature_version),
    signature_updated_at = coalesce(p_signature_updated_at, previous.signature_updated_at),
    scanned_at = coalesce(p_scanned_at, previous.scanned_at), clean_until = expires
  where bucket_id = p_bucket_id and object_name = p_object_name;
  return pg_catalog.jsonb_build_object('status', p_verdict, 'cleanUntil', expires);
end
$function$;

-- ---------------------------------------------------------------------------
-- 1. Confirmation gates — case, task, form
-- ---------------------------------------------------------------------------
-- These three are the moment an uploaded object becomes visible to anyone but
-- the uploader. Each now locks its storage.objects row before reading the
-- verdict, so a concurrent 'blocked' write or object deletion serialises
-- against the confirmation rather than racing it.
create or replace function public.confirm_member_case_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
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
    and (c.user_id = caller or public.staff_can_see_user(c.user_id, 'coordinator'))
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
end $function$;

-- The task confirmation also appends a 'file_added' activity row visible to
-- every chapter member, so an ungated confirm published an unscanned
-- attachment into the shared task timeline.
create or replace function public.confirm_chapter_task_file_upload(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
  object storage.objects%rowtype;
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
end $function$;

-- This one was the weakest of the three: its existence check compared neither
-- mimetype nor size. It gains both, plus the row lock and the verdict gate.
create or replace function public.confirm_member_form_file(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  caller uuid := (select auth.uid());
  form_id uuid;
  rec public.member_form_files%rowtype;
  object storage.objects%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select ff.form_id into form_id from public.member_form_files ff where ff.id = p_file_id;
  if form_id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  perform private.lock_member_form(form_id);
  select ff.* into rec from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and ff.uploaded_by = caller and f.user_id = caller
      and f.status in ('draft', 'returned')
      and ff.deletion_requested_at is null for update of ff;
  if rec.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  select o.* into object from storage.objects o
    where o.bucket_id = rec.bucket_id and o.name = rec.object_name
      and coalesce(o.metadata ->> 'mimetype', '') = rec.mime_type
      and coalesce(o.metadata ->> 'size', '') = rec.size_bytes::text
    for update;
  if object.id is null then
    raise exception 'uploaded file was not found' using errcode = '22023';
  end if;
  if not private.private_upload_is_current(rec.bucket_id, rec.object_name) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  update public.member_form_files set confirmed_at = coalesce(confirmed_at, now())
    where id = rec.id returning * into rec;
  return pg_catalog.jsonb_build_object('id', rec.id, 'confirmedAt', rec.confirmed_at);
end
$function$;

-- ---------------------------------------------------------------------------
-- 2. Form submission, approval and filing
-- ---------------------------------------------------------------------------
-- Submission and approval freeze a content digest and an artifact digest over
-- the attachment manifest. Both gates run BEFORE private.form_content_digest so
-- an unscanned attachment can never be certified into a signed filing.
create or replace function public.submit_form(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  caller uuid := (select auth.uid());
  rec record;
  signature record;
  missing text;
  v_key text;
  had_event boolean;
  actual integer;
  current_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, template_key, template_version, answers into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller then raise exception 'form not found' using errcode = '22023'; end if;
  if rec.status not in ('draft', 'returned') then raise exception 'form not submittable' using errcode = '22023'; end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'wait for attachment deletion to finish' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'wait for every attachment upload to finish' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files ff
             where ff.form_id = p_form_id and ff.deletion_requested_at is null
               and not private.private_upload_is_current(ff.bucket_id, ff.object_name)) then
    raise exception 'wait for every attachment inspection to finish' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = caller;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, caller, signature.strokes) then
    raise exception 'draw and save a current signature before submitting' using errcode = '22023';
  end if;
  select k into missing
  from pg_catalog.unnest(private.form_required_keys(rec.template_key, rec.template_version)) as k
  where case when pg_catalog.jsonb_typeof(rec.answers -> k) = 'array'
    then pg_catalog.jsonb_array_length(rec.answers -> k) = 0
    else pg_catalog.btrim(coalesce(rec.answers ->> k, '')) = '' end limit 1;
  if missing is not null then
    raise exception 'form incomplete: %', missing using errcode = '22023';
  end if;
  update public.member_forms set status='submitted', submitted_at=now(),
    review_note=null, content_digest=current_digest, updated_at=now()
    where id=p_form_id and user_id=caller;
  v_key := 'form-' || p_form_id::text;
  had_event := exists (select 1 from public.member_point_events
                       where user_id = caller and action_key = v_key);
  insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, v_key, 'form') on conflict (user_id, action_key) do nothing;
  select points into actual from public.member_point_events
    where user_id = caller and action_key = v_key;
  return pg_catalog.jsonb_build_object('status', 'submitted',
    'awardedPoints', case when had_event then 0 else coalesce(actual, 0) end);
end
$function$;

create or replace function public.approve_form(p_form_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  caller uuid := (select auth.uid());
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  rec record;
  signature record;
  current_digest text;
  approved_time timestamptz := now();
  frozen_digest text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note is not null and (pg_catalog.char_length(clean_note) > 4000
      or pg_catalog.regexp_replace(clean_note,
        '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]') then
    raise exception 'note is invalid' using errcode = '22023';
  end if;
  perform private.lock_member_form(p_form_id);
  select f.id, f.user_id, f.status, f.template_key, f.template_version,
         coalesce(p.language, 'en') as lang into rec
    from public.member_forms f left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'form has a pending attachment deletion' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'form has an unfinished attachment' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files ff
             where ff.form_id = p_form_id and ff.deletion_requested_at is null
               and not private.private_upload_is_current(ff.bucket_id, ff.object_name)) then
    raise exception 'form has an attachment without a current inspection' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = rec.user_id;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, rec.user_id, signature.strokes) then
    raise exception 'form does not have a current filer signature' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_cosigners c
    where c.form_id = p_form_id and c.status = 'accepted'
      and (c.signature_digest is null or not exists (
        select 1 from private.member_form_signatures s
        where s.cosigner_id = c.id and s.signer_kind = 'cosigner'
          and s.content_digest = current_digest
          and s.signature_digest = c.signature_digest
          and s.signature_digest = private.form_signature_digest(
            current_digest, c.id, s.strokes)
      ))
  ) then
    raise exception 'form has an invalid co-signature' using errcode = '22023';
  end if;
  frozen_digest := private.form_artifact_digest(
    p_form_id, current_digest, signature.signature_digest,
    clean_note, caller, approved_time);
  update public.member_forms set
    status = 'approved', review_note = clean_note, reviewed_by = caller,
    reviewed_at = approved_time, content_digest = current_digest,
    artifact_digest = frozen_digest, artifact_approved_at = approved_time,
    artifact_approved_by = caller, updated_at = approved_time
  where id = p_form_id;
  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario aprobado',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — revisado y aprobado por tu delegado. Ya puedes descargar tu copia oficial de Union Base.'
        || coalesce(' Nota: ' || clean_note, ''), 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form approved',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — reviewed and approved by your steward. Your Union Base official filing copy is ready to download.'
        || coalesce(' Note: ' || clean_note, ''), 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'status', 'approved',
    'artifactDigest', frozen_digest, 'approvedAt', approved_time);
end
$function$;

-- Status is metadata only and must not fail on a quarantined attachment: it
-- reports scanCurrent so a client can render "inspection pending" instead of a
-- dead download control.
create or replace function public.get_form_filing_status(p_form_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  caller uuid := (select auth.uid());
  rec record;
  current_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into rec from public.member_forms f where f.id = p_form_id;
  if not found or not (public.form_is_owned_by_caller(p_form_id)
    or (rec.status in ('submitted', 'in_review', 'approved')
      and public.member_has_role(array['steward'])
      and public.staff_can_see_user(rec.user_id, 'steward'))) then
    raise exception 'form unavailable' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  return pg_catalog.jsonb_build_object(
    'formId', rec.id, 'status', rec.status,
    'filerSigned', exists (select 1 from private.member_form_signatures s
      where s.form_id = rec.id and s.signer_kind = 'filer'
        and s.signer_user_id = rec.user_id and s.content_digest = current_digest),
    'filerSignedAt', rec.filer_signed_at,
    'contentDigest', rec.content_digest,
    'artifactDigest', rec.artifact_digest,
    'artifactApprovedAt', rec.artifact_approved_at,
    'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ff.id, 'bucketId', ff.bucket_id, 'objectName', ff.object_name,
      'filename', ff.filename, 'mimeType', ff.mime_type,
      'sizeBytes', ff.size_bytes, 'confirmedAt', ff.confirmed_at,
      'scanCurrent', private.private_upload_is_current(ff.bucket_id, ff.object_name))
      order by ff.created_at, ff.id) from public.member_form_files ff
      where ff.form_id = rec.id), '[]'::jsonb));
end
$function$;

-- The filing payload runs as service_role and is what api/form-filing.js renders
-- into the official PDF. A filing copy that silently omits an attachment it was
-- approved with is itself an integrity break, so a quarantined attachment is a
-- hard failure here (primary) as well as being excluded from the manifest
-- (defensive). private_upload_is_current admits service_role by design.
create or replace function public.get_form_filing_payload(p_form_id uuid, p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  payload jsonb;
  rec record;
  current_digest text;
  filer_digest text;
  revalidated_digest text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select f.*, p.chapter_id as owner_chapter into rec
  from public.member_forms f
  left join public.member_profiles p on p.id = f.user_id
  where p_user_id is not null
    and f.id = p_form_id
    and f.status = 'approved'
    and f.artifact_digest is not null
    and (f.user_id = p_user_id or exists (
      select 1 from public.member_roles r
      where r.user_id = p_user_id
        and r.role = 'steward'
        and (r.chapter_id is null or r.chapter_id = p.chapter_id)
    ));
  if not found then raise exception 'filing unavailable' using errcode = '22023'; end if;

  current_digest := private.form_content_digest(p_form_id);
  select s.signature_digest into filer_digest
  from private.member_form_signatures s
  where s.form_id = p_form_id
    and s.signer_kind = 'filer'
    and s.signer_user_id = rec.user_id
    and s.content_digest = current_digest
    and s.signature_digest = rec.filer_signature_digest
    and s.signature_digest = private.form_signature_digest(
      current_digest, rec.user_id, s.strokes);
  if current_digest is null
     or rec.content_digest is distinct from current_digest
     or filer_digest is null then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_cosigners c
    where c.form_id = p_form_id and c.status = 'accepted'
      and (c.signature_digest is null or not exists (
        select 1 from private.member_form_signatures s
        where s.cosigner_id = c.id
          and s.signer_kind = 'cosigner'
          and s.signature_digest = c.signature_digest
          and s.content_digest = current_digest
          and s.signature_digest = private.form_signature_digest(
            current_digest, c.id, s.strokes)
      ))
  ) then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_files ff
    where ff.form_id = p_form_id and ff.confirmed_at is not null
      and ff.deletion_requested_at is null
      and not private.private_upload_is_current(ff.bucket_id, ff.object_name)
  ) then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  revalidated_digest := private.form_artifact_digest(
    p_form_id, current_digest, filer_digest, rec.review_note,
    rec.artifact_approved_by, rec.artifact_approved_at);
  if rec.artifact_digest is distinct from revalidated_digest then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object(
    'form', pg_catalog.to_jsonb(f),
    'template', pg_catalog.to_jsonb(t),
    'filer', pg_catalog.jsonb_build_object('id', p.id, 'name', p.full_name),
    'filerSignature', (select pg_catalog.jsonb_build_object(
      'strokes', s.strokes, 'signedAt', s.consented_at,
      'signatureDigest', s.signature_digest)
      from private.member_form_signatures s
      where s.form_id = f.id and s.signer_kind = 'filer'
        and s.signature_digest = f.filer_signature_digest
        and s.content_digest = f.content_digest),
    'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'email', c.invited_email, 'status', c.status,
      'signedAt', c.signed_at, 'signatureDigest', c.signature_digest,
      'strokes', cs.strokes)
      order by c.invited_at, c.id)
      from public.member_form_cosigners c
      left join private.member_form_signatures cs on cs.cosigner_id = c.id
        and cs.signature_digest = c.signature_digest
        and cs.content_digest = f.content_digest
      where c.form_id = f.id), '[]'::jsonb),
    'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ff)
      order by ff.created_at, ff.id) from public.member_form_files ff
      where ff.form_id = f.id and ff.confirmed_at is not null
        and private.private_upload_is_current(ff.bucket_id, ff.object_name)), '[]'::jsonb),
    'approval', pg_catalog.jsonb_build_object(
      'approvedBy', f.artifact_approved_by, 'approvedAt', f.artifact_approved_at,
      'reviewerName', rp.full_name, 'note', f.review_note,
      'artifactDigest', f.artifact_digest)
  ) into payload
  from public.member_forms f
  join public.form_templates t on t.key = f.template_key and t.version = f.template_version
  left join public.member_profiles p on p.id = f.user_id
  left join public.member_profiles rp on rp.id = f.artifact_approved_by
  where p_user_id is not null
    and f.id = p_form_id
    and f.status = 'approved'
    and f.artifact_digest is not null
    and (f.user_id = p_user_id or exists (
      select 1 from public.member_roles r
      where r.user_id = p_user_id
        and r.role = 'steward'
         and (r.chapter_id is null or r.chapter_id = p.chapter_id)
     ));
  if payload is null then raise exception 'filing unavailable' using errcode = '22023'; end if;
  return payload;
end
$function$;

-- ---------------------------------------------------------------------------
-- 3. Organization knowledge — completion, ingest, review, publication, reads
-- ---------------------------------------------------------------------------
-- Completion is what makes an object eligible for ingest, so it is the entry
-- gate. The Storage row is locked first, in the same order the ledger triggers
-- and authorize_private_upload_inspection use.
create or replace function public.complete_steward_library_upload(p_upload_id uuid, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  object storage.objects%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object('uploadId', p_upload_id);
  result jsonb;
begin
  if not private.mfa_satisfied()
     or not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'complete_steward_library_upload:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'complete_steward_library_upload'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into file from public.organization_knowledge_files source
  where source.id = p_upload_id and source.organization_id = org for update;
  if not found or file.created_by is distinct from (select auth.uid()) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if file.storage_kind = 'organization_storage' then
    select o.* into object from storage.objects o
      where o.bucket_id = 'organization-knowledge' and o.name = file.storage_path
      for update;
    if object.id is null then
      raise exception 'uploaded file was not found' using errcode = '22023';
    end if;
    if not private.private_upload_is_current('organization-knowledge', file.storage_path) then
      raise exception 'file inspection required' using errcode = '42501';
    end if;
  end if;
  -- scan_status is retained here only as a workflow marker for the row's own
  -- lifecycle; it is no longer read as a malware verdict anywhere.
  update public.organization_knowledge_files
  set scan_status = 'pending', review_status = 'pending_scan', index_status = 'pending',
      updated_at = pg_catalog.now()
  where id = file.id and organization_id = org;
  insert into public.organization_knowledge_sources (
    organization_id, file_id, source_kind, label, doc_type, health, last_ingest_at
  ) select org, file.id, 'steward_file', file.title, file.doc_type, 'partial', null
  where not exists (
    select 1 from public.organization_knowledge_sources source
    where source.organization_id = org and source.file_id = file.id
  );
  result := private.mi1_w2_project_knowledge_file(file.id) || pg_catalog.jsonb_build_object(
    'sourceId', (
      select source.id from public.organization_knowledge_sources source
      where source.organization_id = org and source.file_id = file.id
      order by source.created_at, source.id limit 1
    )
  );
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'complete_steward_library_upload', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

-- The highest-value knowledge gate: this RPC is the ONLY place a storage_path
-- becomes privileged service-role byte access (api/knowledge-ingest.js reads
-- the object with the service key). Without a current verdict it must not hand
-- out bucketId/objectName at all.
-- The uploader-self-service branch now keys on index_status instead of
-- scan_status, because scan_status stops being written by the ingest worker
-- below and would otherwise stay 'pending' forever.
create or replace function public.authorize_knowledge_ingest(p_source_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor uuid := (select auth.uid());
  source public.organization_knowledge_sources%rowtype;
  file public.organization_knowledge_files%rowtype;
  recent_count integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  select * into file from public.organization_knowledge_files row
  where row.id = source.file_id and row.organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp'])
     and not (
       file.created_by = actor
       and file.review_status = 'pending_scan' and file.index_status = 'pending'
     ) then raise exception 'not authorized' using errcode = '42501'; end if;
  if file.category = 'contract' and (
    file.chapter_id is null
    or not exists (
      select 1 from public.chapters chapter
      where chapter.id = file.chapter_id and chapter.organization_id = org
    )
  ) then raise exception 'active organization chapter required for contract ingestion' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'authorize_knowledge_ingest:' || org::text || ':' || actor::text, 509
  ));
  select pg_catalog.count(*) into recent_count
  from public.organization_audit_events event
  where event.organization_id = org
    and event.actor_user_id = actor
    and event.event_type = 'knowledge_ingest_authorized'
    and event.created_at >= pg_catalog.now() - interval '1 hour';
  if recent_count >= 20 then
    return pg_catalog.jsonb_build_object('rateLimited', true);
  end if;
  if file.storage_kind = 'organization_storage'
     and not private.private_upload_is_current('organization-knowledge', file.storage_path) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  perform private.mi1_w2_write_audit(org, 'knowledge_ingest_authorized', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'sourceId', source.id, 'action', 'ingest'
  ));
  return pg_catalog.jsonb_build_object(
    'organizationId', org, 'sourceId', source.id, 'fileId', file.id,
    'bucketId', 'organization-knowledge', 'objectName', file.storage_path,
    'fileName', file.file_name, 'mimeType', file.mime_type,
    'byteSize', file.byte_size, 'contentSha256', file.content_sha256,
    'category', file.category, 'chapterId', file.chapter_id,
    'actorUserId', actor, 'rateLimited', false
  );
end;
$function$;

-- The unconditional knowledge clean writes. This function is the TEXT
-- EXTRACTION completion callback: `error_code is null` means the extractor
-- produced usable text, which has nothing to do with malware. It used to write
-- scan_status='clean' on success and scan_status='blocked' on an ingest error,
-- which is how "the extractor worked" became a malware attestation that
-- publish/download/catalog/collection readers trusted. Both writes are removed;
-- index_status and organization_knowledge_sources.health carry ingest health,
-- and the verdict lives only in private.private_upload_scans.
create or replace function public.replace_knowledge_source_chunks(
  p_organization_id uuid, p_source_id uuid, p_actor_user_id uuid, p_chunks jsonb, p_error_code text
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  source public.organization_knowledge_sources%rowtype;
  item record;
  item_count integer;
  error_code text := nullif(pg_catalog.btrim(coalesce(p_error_code, '')), '');
begin
  if (select auth.role()) <> 'service_role'
     or p_organization_id is null or p_source_id is null or p_actor_user_id is null
     or pg_catalog.jsonb_typeof(coalesce(p_chunks, '[]'::jsonb)) <> 'array'
     or pg_catalog.jsonb_array_length(coalesce(p_chunks, '[]'::jsonb)) > 500
     or (error_code is not null and error_code !~ '^knowledge-[a-z0-9-]{1,110}$') then
    raise exception 'invalid ingest completion' using errcode = '22023';
  end if;
  select * into source from public.organization_knowledge_sources row
  where row.id = p_source_id and row.organization_id = p_organization_id for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.organization_memberships membership
    join public.organization_role_grants role
      on role.organization_id = membership.organization_id and role.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id and membership.status = 'active'
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
  ) then raise exception 'not authorized' using errcode = '42501'; end if;
  delete from public.organization_knowledge_chunks chunk
  where chunk.source_id = source.id and chunk.organization_id = p_organization_id;
  if error_code is not null then
    update public.organization_knowledge_sources
    set chunk_count = 0, embedded_count = 0, health = 'failed',
        last_error = error_code, last_ingest_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = source.id and organization_id = p_organization_id;
    update public.organization_knowledge_files
    set index_status = 'failed', updated_at = pg_catalog.now()
    where id = source.file_id and organization_id = p_organization_id;
  else
    item_count := pg_catalog.jsonb_array_length(p_chunks);
    if item_count = 0 then raise exception 'ingest produced no chunks' using errcode = '22023'; end if;
    for item in select value, ordinality from pg_catalog.jsonb_array_elements_text(p_chunks) with ordinality loop
      if pg_catalog.char_length(item.value) not between 1 and 8000 then
        raise exception 'invalid knowledge chunk' using errcode = '22023';
      end if;
      insert into public.organization_knowledge_chunks (
        organization_id, source_id, chunk_index, content
      ) values (p_organization_id, source.id, item.ordinality - 1, item.value);
    end loop;
    update public.organization_knowledge_sources
    set chunk_count = item_count, embedded_count = 0, health = 'unset_embedding',
        last_error = null, last_ingest_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = source.id and organization_id = p_organization_id;
    update public.organization_knowledge_files
    set index_status = 'chunked', updated_at = pg_catalog.now()
    where id = source.file_id and organization_id = p_organization_id;
  end if;
  insert into public.organization_audit_events (
    organization_id, event_type, actor_user_id, idempotency_key, metadata
  ) values (
    p_organization_id, 'knowledge_source_retried', p_actor_user_id,
    extensions.gen_random_uuid(), pg_catalog.jsonb_build_object(
      'organizationId', p_organization_id, 'fileId', source.file_id, 'sourceId', source.id,
      'indexStatus', case when error_code is null then 'chunked' else 'failed' end,
      'action', case when error_code is null then 'ingested' else 'failed' end
    )
  );
  return pg_catalog.jsonb_build_object(
    'id', source.id, 'fileId', source.file_id,
    'chunkCount', case when error_code is null then item_count else 0 end,
    'embeddedCount', 0,
    'health', case when error_code is null then 'unset_embedding' else 'failed' end,
    'lastError', error_code
  );
end;
$function$;

-- Approval is a publication decision, so it needs a verdict. 'rejected' and
-- 'quarantined' stay unconditional: a blocked file must always remain
-- rejectable and quarantinable.
create or replace function public.review_steward_library_file(p_file_id uuid, p_decision text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  next_status text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_decision not in ('approved', 'rejected', 'quarantined') then
    raise exception 'invalid review decision' using errcode = '22023';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_decision = 'approved' and file.storage_kind = 'organization_storage'
     and not private.private_upload_is_current('organization-knowledge', file.storage_path) then
    raise exception 'file inspection required' using errcode = '42501';
  end if;
  next_status := p_decision;
  update public.organization_knowledge_files
  set review_status = next_status,
      index_status = case when next_status = 'approved' then 'skipped_unset' else index_status end,
      updated_at = pg_catalog.now()
  where id = file.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_reviewed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'reviewStatus', next_status, 'action', 'reviewed'
  ));
  return private.mi1_w2_project_knowledge_file(file.id);
end;
$function$;

create or replace function public.publish_steward_file_to_catalog(p_file_id uuid, p_category text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb := pg_catalog.jsonb_build_object(
    'fileId', p_file_id, 'category', coalesce(p_category, '')
  );
  result jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'publish_steward_file_to_catalog:' || org::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'publish_steward_file_to_catalog'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  -- Was `file.scan_status <> 'clean'`, a stale row flag written by the text
  -- extractor. The verdict is now read from the ledger, bound to this object's
  -- identity and version.
  if file.review_status <> 'approved'
     or (file.storage_kind = 'organization_storage'
       and not private.private_upload_is_current('organization-knowledge', file.storage_path)) then
    raise exception 'only approved clean files can be published' using errcode = '22023';
  end if;
  update public.organization_knowledge_files
  set published_to_catalog = true,
      visibility = 'organization',
      category = coalesce(nullif(p_category, ''), category),
      updated_at = pg_catalog.now()
  where id = file.id;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_published_to_catalog', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'library', 'catalog',
    'category', coalesce(nullif(p_category, ''), file.category), 'action', 'published'
  ));
  result := private.mi1_w2_project_knowledge_file(file.id);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'publish_steward_file_to_catalog', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

-- Both branches. The steward branch previously checked nothing at all, and the
-- catalog branch trusted the extractor's scan_status. The catalog branch keeps
-- raising P0002 so a member cannot distinguish "quarantined" from "absent".
create or replace function private.mi1_w2_download_knowledge_file(p_file_id uuid, p_catalog_only boolean)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
  expires timestamptz := pg_catalog.now() + interval '5 minutes';
  handle text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found or file.organization_id is distinct from org then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_catalog_only then
    if not private.is_organization_member(org)
       or not file.published_to_catalog
       or file.review_status <> 'approved'
       or (file.storage_kind = 'organization_storage'
         and not private.private_upload_is_current('organization-knowledge', file.storage_path)) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  else
    if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    if file.storage_kind = 'organization_storage'
       and not private.private_upload_is_current('organization-knowledge', file.storage_path) then
      raise exception 'file inspection required' using errcode = '42501';
    end if;
  end if;
  handle := replace(extensions.gen_random_uuid()::text, '-', '');
  perform private.mi1_w2_write_audit(org, 'knowledge_file_downloaded', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', file.id, 'library', file.library, 'action', 'downloaded'
  ));
  return pg_catalog.jsonb_build_object(
    'fileId', file.id,
    'fileName', file.file_name,
    'disposition', 'attachment',
    'expiresAt', expires,
    'href', 'knowledge:' || file.storage_handle::text || ':' || handle
  );
end;
$function$;

-- Catalog listing and item read: metadata only, but this is the list a member
-- clicks to download, so a quarantined file must not appear in it.
create or replace function public.list_resource_catalog(p_query text, p_category text)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id,
      'title', f.title,
      'summary', f.summary,
      'category', f.category,
      'fileName', f.file_name,
      'byteSize', f.byte_size
    ) order by f.title, f.id)
    from (
      select source.id, source.title, source.summary, source.category,
             source.file_name, source.byte_size
      from public.organization_knowledge_files source
      where source.organization_id = org
        and source.published_to_catalog
        and source.review_status = 'approved'
        and (source.storage_kind <> 'organization_storage'
          or private.private_upload_is_current('organization-knowledge', source.storage_path))
        and (p_category is null or source.category = p_category)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(source.title), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.summary), pg_catalog.lower(needle)) > 0
        )
      order by source.title, source.id
      limit 80
    ) f
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.get_resource_catalog_item(p_file_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into file from public.organization_knowledge_files where id = p_file_id;
  if not found
     or file.organization_id is distinct from org
     or not file.published_to_catalog
     or file.review_status <> 'approved'
     or (file.storage_kind = 'organization_storage'
       and not private.private_upload_is_current('organization-knowledge', file.storage_path)) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', file.id,
    'title', file.title,
    'summary', file.summary,
    'category', file.category,
    'fileName', file.file_name,
    'byteSize', file.byte_size
  );
end;
$function$;

-- The verdict conjunct sits OUTSIDE the `staff or (...)` disjunction, so staff
-- are bound by it too: the previous shape let staff see every placed file with
-- no scan predicate at all.
create or replace function public.list_knowledge_collections(p_chapter_id text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  requested_chapter text := nullif(pg_catalog.btrim(coalesce(p_chapter_id, '')), '');
  org uuid := private.mi1_knowledge_context_organization(requested_chapter);
  home_chapter text := private.current_member_chapter();
  chapter text := coalesce(requested_chapter, home_chapter);
  staff boolean := private.mi1_knowledge_collection_staff(org);
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is not null
     and (not staff or not private.mi1_w2_same_org_chapter(org, requested_chapter)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if requested_chapter is null
     and chapter is not null
     and not private.mi1_w2_same_org_chapter(org, chapter) then
    chapter := null;
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', collection.id,
      'title', collection.title,
      'description', collection.description,
      'visibility', collection.visibility,
      'chapterId', collection.chapter_id,
      'sortOrder', collection.sort_order,
      'items', coalesce((
        select pg_catalog.jsonb_agg(item.value order by item.sort_order, item.id)
        from (
          select placement.id, placement.sort_order, pg_catalog.jsonb_build_object(
            'id', placement.id,
            'kind', 'kb_article',
            'itemId', article.id,
            'title', article.title,
            'summary', article.article_ref,
            'status', article.status,
            'version', article.version
          ) as value
          from public.knowledge_collection_items placement
          join public.member_kb_articles article on article.id = placement.kb_article_id
          where placement.collection_id = collection.id
            and article.chapter_id = chapter
            and not article.is_sample
            and (staff or (
              article.status = 'published'
              and article.verified_by is not null
              and article.verified_at is not null
            ))
          union all
          select placement.id, placement.sort_order, pg_catalog.jsonb_build_object(
            'id', placement.id,
            'kind', 'knowledge_file',
            'itemId', file.id,
            'title', file.title,
            'summary', file.summary,
            'status', file.review_status,
            'version', 1
          ) as value
          from public.knowledge_collection_items placement
          join public.organization_knowledge_files file on file.id = placement.knowledge_file_id
          where placement.collection_id = collection.id
            and file.organization_id = org
            and (file.storage_kind <> 'organization_storage'
              or private.private_upload_is_current('organization-knowledge', file.storage_path))
            and (staff or (
              file.published_to_catalog
              and file.review_status = 'approved'
            ))
        ) item
      ), '[]'::jsonb)
    ) order by collection.sort_order, collection.title, collection.id)
    from public.knowledge_collections collection
    where collection.organization_id = org
      and (collection.chapter_id is null or collection.chapter_id = chapter)
      and (collection.visibility = 'organization' or staff)
  ), '[]'::jsonb);
end;
$function$;

-- The Storage-side read predicate. Only the member branch's stale
-- `file.scan_status = 'clean'` is replaced. The staff branch stays without a
-- verdict clause on purpose: this helper is also consulted by
-- authorize_private_upload_inspection, and gating the staff branch would make
-- it impossible for a steward to ever get another member's pending upload
-- inspected. Actual reads remain bound by the restrictive
-- private_upload_quarantine_read policy, which evaluates
-- private_upload_is_current on every authenticated download.
create or replace function private.can_read_organization_knowledge_object(p_bucket_id text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select case
    when p_bucket_id is distinct from 'organization-knowledge' then false
    when not private.mfa_satisfied() then false
    when private.current_mobile_staff_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.organization_id = private.current_mobile_staff_organization()
        and (
          private.has_organization_role(
            file.organization_id,
            array['steward', 'coordinator', 'advisor', 'admin', 'vp']
          )
          or (
            private.is_organization_member(file.organization_id)
            and file.published_to_catalog
            and file.review_status = 'approved'
            and private.private_upload_is_current('organization-knowledge', file.storage_path)
          )
        )
    )
  end
$function$;

notify pgrst, 'reload schema';
commit;
