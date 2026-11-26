-- BUG-UG-FORM-APPROVAL-APPROVES-CONTENT-THE-STEWARD-NEVER-SAW-20261114 (#8707).
-- A steward's approval approves only what the steward reviewed.
--
-- approve_form (and approve_and_open_case, which calls it) took only the form
-- id and a note and approved and froze the filing as it stood when it ran.
-- The steward reviews in a dialog opened earlier. Two paths change the filing
-- in between: another steward in scope returns the form and the member edits,
-- re-signs and resubmits it; or, while the form is submitted or in review, the
-- member invites a co-signer who accepts, or an accepted co-signer withdraws.
-- Approval freezes the official filing copy, which lists the co-signers. Twin
-- of 20261113114500 (#8702, signing) and 20261113115500 (#8705, submitting).
--
-- Both gain p_expected jsonb DEFAULT NULL: the object sign_member_form and
-- submit_form take (attachmentIds always; dataVersion for a sealed template,
-- answers for an ordinary one) plus cosignerIds, the accepted co-signer rows
-- the review showed ([] when none). approve_form compares it under the form
-- lock, after the attachment checks and before the signature checks and the
-- approval. A difference refuses with PT409 and DETAIL
-- form_changed_since_review; a malformed argument refuses with 22023. Null
-- keeps the previous behaviour. Sealed answers never enter the argument.
--
-- approve_form is the live definition from 20261104080000 with the two
-- stored columns it compares added to its locked read and the block above;
-- guard, scope, lock order, signature and co-signature checks, the artifact
-- digest and the notice are unchanged. approve_and_open_case is its live
-- definition (20260725180000, wrapped by 20260907151000) passing p_expected
-- through. Grants unchanged. The applied migrations are not edited. Neither
-- function is on the account-lifecycle trigger surface (no trigger reaches
-- them), so there is no review receipt to renew.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.approve_form(uuid,text)'::regprocedure)) <> 'af0cc8421914c913e49ee9e9fb8d59fa' then
    raise exception 'unreviewed predecessor: public.approve_form(uuid,text)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.approve_and_open_case(uuid,text)'::regprocedure)) <> 'ca2d4460631a596b5bad2d412ae8c068' then
    raise exception 'unreviewed predecessor: public.approve_and_open_case(uuid,text)' using errcode = '55000';
  end if;
end;
$preflight$;

drop function public.approve_and_open_case(uuid, text);
drop function public.approve_form(uuid, text);

create function public.approve_form(p_form_id uuid, p_note text DEFAULT NULL::text, p_expected jsonb DEFAULT NULL::jsonb)
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

CREATE FUNCTION public.approve_and_open_case(p_form_id uuid, p_note text DEFAULT NULL::text, p_expected jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): make the inherited
  -- steward+MFA gate explicit at the entry point rather than relying on the first
  -- delegated call to raise. public.member_has_role() AND-s private.mfa_satisfied()
  -- before the role lookup, so an aal1 session with an enrolled TOTP factor is
  -- refused here. Observable behavior is unchanged for real callers.
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  -- The steward's reviewed expectation travels to the approval (#8707); a
  -- refusal there rolls back before any case is opened.
  perform public.approve_form(p_form_id, p_note, p_expected);
  return public.open_form_as_case(p_form_id);
end;
end;
$function$;

revoke all on function public.approve_form(uuid, text, jsonb) from public, anon;
grant execute on function public.approve_form(uuid, text, jsonb) to authenticated, service_role;
revoke all on function public.approve_and_open_case(uuid, text, jsonb) from public, anon;
grant execute on function public.approve_and_open_case(uuid, text, jsonb) to authenticated, service_role;

comment on function public.approve_form(uuid, text, jsonb) is 'Steward approval. p_expected (optional) names the reviewed answers (ordinary) or dataVersion (sealed), the confirmed attachment ids and the accepted co-signer ids shown; a difference under the form lock refuses with PT409 form_changed_since_review and nothing is approved.';

notify pgrst, 'reload schema';
commit;
