-- REQ-UG-FORMS-SIGNATURE-ONLY-ON-SIGNED-STATEMENTS-20261115 (#8957;
-- the signature half of #8281, a project decision):
-- the filer's signature is decided by the template. Signed statements
-- (grievance, alliance_grievance, non_selection, fmla_self, fmla_family,
-- alt_work) and every organization-made key keep it required and enforced;
-- service_request, an internal help request to the chapter, does not ask.
--
-- Each replaced body is the current one with only that rule added:
-- submit_form(uuid, jsonb) from 20261113115500 (the reviewed-content check
-- stays first), approve_form(uuid, text, jsonb) from 20261113123000 (the
-- reviewed-content and co-signer check stays; the two-argument approve_form
-- it dropped is not recreated), get_form_filing_status from 20261113120500
-- (the typed-signature kind and names stay) plus signatureRequired, and
-- get_form_filing_payload from its live definition. A typed signature counts
-- wherever a drawn one does: both are the same stored material and digest.
-- No save, discard or other forms function is touched.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.submit_form(uuid,jsonb)'::regprocedure)) <> '72fc0308cdf5336616865473d60dcf35' then
    raise exception 'unreviewed predecessor: public.submit_form(uuid,jsonb)' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review
             where kind = 'function' and schema_name = 'public' and table_name = ''
               and object_name = 'submit_form(p_form_id uuid, p_expected jsonb)' and definition_hash <> '72fc0308cdf5336616865473d60dcf35') then
    raise exception 'stale trigger receipt: public.submit_form(uuid,jsonb)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.approve_form(uuid,text,jsonb)'::regprocedure)) <> '8f928246672eab95552560a94ea9b71a' then
    raise exception 'unreviewed predecessor: public.approve_form(uuid,text,jsonb)' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review
             where kind = 'function' and schema_name = 'public' and table_name = ''
               and object_name = 'approve_form(p_form_id uuid, p_note text, p_expected jsonb)' and definition_hash <> '8f928246672eab95552560a94ea9b71a') then
    raise exception 'stale trigger receipt: public.approve_form(uuid,text,jsonb)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_form_filing_status(uuid)'::regprocedure)) <> 'e0bb006b8c52a409858b0fe8b37d6568' then
    raise exception 'unreviewed predecessor: public.get_form_filing_status(uuid)' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review
             where kind = 'function' and schema_name = 'public' and table_name = ''
               and object_name = 'get_form_filing_status(p_form_id uuid)' and definition_hash <> 'e0bb006b8c52a409858b0fe8b37d6568') then
    raise exception 'stale trigger receipt: public.get_form_filing_status(uuid)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_form_filing_payload(uuid,uuid)'::regprocedure)) <> '8353bc88e35cc4e0f51d734c0e53394e' then
    raise exception 'unreviewed predecessor: public.get_form_filing_payload(uuid,uuid)' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review
             where kind = 'function' and schema_name = 'public' and table_name = ''
               and object_name = 'get_form_filing_payload(p_form_id uuid, p_user_id uuid)' and definition_hash <> '8353bc88e35cc4e0f51d734c0e53394e') then
    raise exception 'stale trigger receipt: public.get_form_filing_payload(uuid,uuid)' using errcode = '55000';
  end if;
end;
$preflight$;

create function private.form_template_requires_signature(p_template_key text)
returns boolean language sql immutable set search_path = '' as $function$
  select p_template_key is distinct from 'service_request';
$function$;
revoke all on function private.form_template_requires_signature(text)
  from public, anon, authenticated, service_role;

create or replace function public.submit_form(p_form_id uuid, p_expected jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
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
  select id, user_id, status, template_key, template_version, answers, encrypted_content into rec
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
  -- What the submitter reviewed (#8705), in the shape sign_member_form takes:
  -- compared under the form lock before the signature check and before
  -- anything is filed, so the filed content, and the signature that must
  -- cover it, are the reviewed ones.
  if p_expected is not null then
    if pg_catalog.jsonb_typeof(p_expected) <> 'object'
       or (private.form_template_is_sealed(rec.template_key) and not (p_expected ? 'dataVersion'))
       or (not private.form_template_is_sealed(rec.template_key) and not (p_expected ? 'answers'))
       or pg_catalog.jsonb_typeof(p_expected->'attachmentIds') is distinct from 'array' then
      raise exception 'expected review must name the reviewed answers and attachments' using errcode = '22023';
    end if;
    if (private.form_template_is_sealed(rec.template_key)
          and (p_expected->>'dataVersion') is distinct from (rec.encrypted_content #>> '{answers,dataVersion}'))
       or (not private.form_template_is_sealed(rec.template_key)
          and (p_expected->'answers') is distinct from rec.answers)
       or ((
          select coalesce(pg_catalog.array_agg(distinct ff.id::text order by ff.id::text), '{}'::text[])
            from public.member_form_files ff
            where ff.form_id = p_form_id and ff.confirmed_at is not null
        ) is distinct from (
          select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(seen.id) order by pg_catalog.lower(seen.id)), '{}'::text[])
            from pg_catalog.jsonb_array_elements_text(p_expected->'attachmentIds') seen(id)
        )) then
      raise exception 'form changed since review' using errcode = 'PT409',
        detail = 'form_changed_since_review';
    end if;
  end if;
  current_digest := private.form_content_digest(p_form_id);
  -- A signed-statement template needs the filer's current signature (drawn
  -- or typed); a template that is not one
  -- (private.form_template_requires_signature) submits without it.
  if private.form_template_requires_signature(rec.template_key) then
    select content_digest, signature_digest, strokes into signature
      from private.member_form_signatures
      where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = caller;
    if signature.signature_digest is null
       or signature.content_digest <> current_digest
       or signature.signature_digest <> private.form_signature_digest(
         current_digest, caller, signature.strokes) then
      raise exception 'draw and save a current signature before submitting' using errcode = '22023';
    end if;
  end if;
  select k into missing
  from pg_catalog.unnest(private.form_required_keys(rec.template_key, rec.template_version)) as k
  -- The server-written "filled" list answers the check only for a sealed
  -- template's enveloped row; elsewhere answers.sealed and answers.filled are
  -- ordinary answers and cannot stand in for required ones (#6363 round 1).
  where case when private.form_template_is_sealed(rec.template_key) and rec.encrypted_content ? 'answers'
      and rec.answers->>'sealed' = 'true' then not coalesce(rec.answers->'filled' ? k, false)
    when pg_catalog.jsonb_typeof(rec.answers -> k) = 'array'
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
end;
end
$function$;

create or replace function public.approve_form(p_form_id uuid, p_note text DEFAULT NULL::text, p_expected jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
         f.answers, f.encrypted_content,
         coalesce(p.language, 'en') as lang into rec
    from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f left join public.member_profiles p on p.id = f.user_id
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
  -- What the steward reviewed (#8707): the answers (ordinary) or the stored
  -- version (sealed), the confirmed attachments and the accepted co-signers
  -- the review showed, compared under the form lock before anything is
  -- approved, so a return and resubmission or a co-signer change after the
  -- steward's read is never approved unseen.
  if p_expected is not null then
    if pg_catalog.jsonb_typeof(p_expected) <> 'object'
       or (private.form_template_is_sealed(rec.template_key) and not (p_expected ? 'dataVersion'))
       or (not private.form_template_is_sealed(rec.template_key) and not (p_expected ? 'answers'))
       or pg_catalog.jsonb_typeof(p_expected->'attachmentIds') is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_expected->'cosignerIds') is distinct from 'array' then
      raise exception 'expected review must name the reviewed answers, attachments and co-signers' using errcode = '22023';
    end if;
    if (private.form_template_is_sealed(rec.template_key)
          and (p_expected->>'dataVersion') is distinct from (rec.encrypted_content #>> '{answers,dataVersion}'))
       or (not private.form_template_is_sealed(rec.template_key)
          and (p_expected->'answers') is distinct from rec.answers)
       or ((
          select coalesce(pg_catalog.array_agg(distinct ff.id::text order by ff.id::text), '{}'::text[])
            from public.member_form_files ff
            where ff.form_id = p_form_id and ff.confirmed_at is not null
        ) is distinct from (
          select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(seen.id) order by pg_catalog.lower(seen.id)), '{}'::text[])
            from pg_catalog.jsonb_array_elements_text(p_expected->'attachmentIds') seen(id)
        ))
       or ((
          select coalesce(pg_catalog.array_agg(distinct c.id::text order by c.id::text), '{}'::text[])
            from public.member_form_cosigners c
            where c.form_id = p_form_id and c.status = 'accepted'
        ) is distinct from (
          select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(seen.id) order by pg_catalog.lower(seen.id)), '{}'::text[])
            from pg_catalog.jsonb_array_elements_text(p_expected->'cosignerIds') seen(id)
        )) then
      raise exception 'form changed since review' using errcode = 'PT409',
        detail = 'form_changed_since_review';
    end if;
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = rec.user_id;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, rec.user_id, signature.strokes) then
    -- Only a signed-statement template needs it; any other is approved as
    -- unsigned, so no stale signature enters the approved artifact.
    if private.form_template_requires_signature(rec.template_key) then
      raise exception 'form does not have a current filer signature' using errcode = '22023';
    end if;
    signature.signature_digest := null;
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
  where id = p_form_id and private.member_form_case_readable(p_form_id);
  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario aprobado',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — revisado y aprobado por tu delegado. Ya puedes descargar tu copia oficial de Union Base.'
        || case when clean_note is not null then ' Abre Formularios para leer la nota de tu delegado.' else '' end, 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form approved',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — reviewed and approved by your steward. Your Union Base official filing copy is ready to download.'
        || case when clean_note is not null then ' Open Forms to read your steward''s note.' else '' end, 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'status', 'approved',
    'artifactDigest', frozen_digest, 'approvedAt', approved_time);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_form_filing_status(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  rec record;
  current_digest text;
  filer_signature record;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into rec from (select scope_form.* from public.member_forms scope_form where private.member_form_scope_and_identity_allowed(scope_form)) f where f.id = p_form_id;
  if not found or not (public.form_is_owned_by_caller(p_form_id)
    or (rec.status in ('submitted', 'in_review', 'approved')
      and public.member_has_role(array['steward'])
      and public.staff_can_see_user(rec.user_id, 'steward'))) then
    raise exception 'form unavailable' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select s.signature_kind, s.typed_name into filer_signature
    from private.member_form_signatures s
    where s.form_id = rec.id and s.signer_kind = 'filer'
      and s.signer_user_id = rec.user_id and s.content_digest = current_digest;
  return pg_catalog.jsonb_build_object(
    'formId', rec.id, 'status', rec.status,
    'filerSigned', exists (select 1 from private.member_form_signatures s
      where s.form_id = rec.id and s.signer_kind = 'filer'
        and s.signer_user_id = rec.user_id and s.content_digest = current_digest),
    'filerSignedAt', rec.filer_signed_at,
    'signatureRequired', private.form_template_requires_signature(rec.template_key),
    'filerSignatureKind', filer_signature.signature_kind,
    'filerTypedName', filer_signature.typed_name,
    'cosignatures', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'cosignerId', c.id, 'kind', cs.signature_kind, 'typedName', cs.typed_name)
      order by c.invited_at, c.id)
      from public.member_form_cosigners c
      join private.member_form_signatures cs on cs.cosigner_id = c.id
        and cs.signer_kind = 'cosigner'
        and cs.signature_digest = c.signature_digest
        and cs.content_digest = current_digest
      where c.form_id = rec.id and c.status = 'accepted'), '[]'::jsonb),
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
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_form_filing_payload(p_form_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  from (select scope_form.* from public.member_forms scope_form where private.member_form_actor_scope_and_identity_allowed(p_user_id,scope_form)) f
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
  -- A template that is not a signed statement may have been approved
  -- unsigned; the artifact digest below still binds whichever it was.
  if current_digest is null
     or rec.content_digest is distinct from current_digest
     or (filer_digest is null and private.form_template_requires_signature(rec.template_key)) then
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
  from (select scope_form.* from public.member_forms scope_form where private.member_form_actor_scope_and_identity_allowed(p_user_id,scope_form)) f
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

-- CREATE OR REPLACE keeps each function's ACL. Renew only existing reviewed
-- account-lifecycle receipts; never add one.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid = 'public.submit_form(uuid,jsonb)'::regprocedure
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid = 'public.approve_form(uuid,text,jsonb)'::regprocedure
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid = 'public.get_form_filing_status(uuid)'::regprocedure
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid = 'public.get_form_filing_payload(uuid,uuid)'::regprocedure
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';

notify pgrst, 'reload schema';
commit;
