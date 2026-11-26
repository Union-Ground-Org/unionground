-- REQ-UG-FORMS-COMPLETE-A-FORM-WITHOUT-DRAWING-A-SIGNATURE-20261113 (#8701).
--
-- A member who cannot draw completes a form by typing their full name and
-- ticking the existing consent box. A typed signature goes through the same
-- two RPCs as a drawn one (sign_member_form for the filer, respond_to_cosign
-- for a co-signer), each with one new optional argument, and is stored in the
-- same private.member_form_signatures row. Every guard a drawn signature has
-- (signed-in member with a satisfied second factor, consent, own form in
-- draft or returned, the form-scoped lock, the attachment waits, the pending
-- invitation for the caller, approved forms frozen, and the filer's expected
-- review from 20261113114500, compared under the form lock before the digest)
-- runs unchanged and in the same order for both kinds, behind the case-graph lock that the
-- 20260907151000 wrapper installed as each writer's first statement.
--
-- The signed material stays in the strokes column: the drawn strokes array as
-- before, or the object {"kind":"typed","name":<name>} for a typed signature.
-- The signature digest is therefore still sha256(content : member : material)
-- and binds the typed name exactly as it binds strokes, and submit_form,
-- approve_form and get_form_filing_payload, which recompute that digest from
-- the stored material, are not redefined. A check constraint ties the new
-- signature_kind and typed_name columns to the material so they can never
-- disagree, and an array can never be read as an object, so the two kinds
-- cannot be swapped under one digest.
--
-- private.validate_form_signature_strokes (20260812190000) is unchanged and
-- still validates every drawn signature. get_form_filing_status additionally
-- names the kind and the typed name of current signatures for the member and
-- the steward in scope; strokes still never leave Postgres except through the
-- service-only filing payload.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Replace only the reviewed predecessors.
do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.sign_member_form(uuid,jsonb,boolean,jsonb)'::regprocedure)) <> 'f061d0c96b29b8e824726a94af372a4f' then
    raise exception 'unreviewed predecessor: public.sign_member_form' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.respond_to_cosign(uuid,boolean,jsonb,boolean)'::regprocedure)) <> '26792c24f099d4a6652493936457324b' then
    raise exception 'unreviewed predecessor: public.respond_to_cosign' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_form_filing_status(uuid)'::regprocedure)) <> '5b8f95b6312a503d26150c1ad8ca2a0b' then
    raise exception 'unreviewed predecessor: public.get_form_filing_status' using errcode = '55000';
  end if;
end;
$predecessor$;

-- Every stored signature so far is drawn. The default keeps any writer that
-- does not name a kind on the drawn rule, which the constraint holds to an
-- array of strokes.
alter table private.member_form_signatures
  add column signature_kind text not null default 'drawn',
  add column typed_name text,
  add constraint member_form_signatures_kind_material check (
    (signature_kind = 'drawn'
      and typed_name is null
      and pg_catalog.jsonb_typeof(strokes) = 'array')
    or (signature_kind = 'typed'
      and typed_name is not null
      and pg_catalog.jsonb_typeof(strokes) = 'object'
      and strokes ->> 'kind' = 'typed'
      and pg_catalog.jsonb_typeof(strokes -> 'name') = 'string'
      and strokes ->> 'name' = typed_name
      and strokes - 'kind' - 'name' = '{}'::jsonb));

-- The one place the typed-name rule lives. It returns the name that is
-- stored and signed: NFC, inner whitespace collapsed to one space, trimmed.
-- The typed name does not have to match the account name (project decision,
-- November 14, 2026): legal and display names differ, and the steward view
-- and the filing copy show both names side by side.
create function private.normalize_form_typed_signature(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  signed_name text;
begin
  if p_name is null then
    raise exception 'type your full name to sign' using errcode = '22023';
  end if;
  -- Control, invisible and direction-changing characters could make the
  -- stored name read differently from what the member saw.
  if p_name ~ '[[:cntrl:]\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]' then
    raise exception 'typed signature contains a hidden or control character' using errcode = '22023';
  end if;
  signed_name := pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.normalize(p_name, 'NFC'), '[[:space:]]+', ' ', 'g'));
  if pg_catalog.char_length(signed_name) not between 2 and 120 then
    raise exception 'typed signature needs 2-120 characters' using errcode = '22023';
  end if;
  if signed_name !~ '[[:alpha:]]' then
    raise exception 'typed signature needs at least one letter' using errcode = '22023';
  end if;
  return signed_name;
end
$$;
revoke all on function private.normalize_form_typed_signature(text)
  from public, anon, authenticated, service_role;

drop function public.sign_member_form(uuid, jsonb, boolean, jsonb);
create function public.sign_member_form(
  p_form_id uuid, p_strokes jsonb, p_consent boolean, p_expected jsonb default null,
  p_typed_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  rec record;
  current_digest text;
  signed_time timestamptz := now();
  signed_digest text;
  signed_kind text := 'drawn';
  signed_name text;
  material jsonb := p_strokes;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_consent is distinct from true then
    raise exception 'signature consent required' using errcode = '22023';
  end if;
  if p_typed_name is null then
    perform private.validate_form_signature_strokes(p_strokes);
  elsif p_strokes is not null then
    raise exception 'sign by drawing or by typing your name, not both' using errcode = '22023';
  else
    signed_name := private.normalize_form_typed_signature(p_typed_name);
    signed_kind := 'typed';
    material := pg_catalog.jsonb_build_object('kind', 'typed', 'name', signed_name);
  end if;
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, template_key, answers, encrypted_content into rec from public.member_forms
    where id = p_form_id for update;
  if not found or rec.user_id <> caller or rec.status not in ('draft', 'returned') then
    raise exception 'form not found or not signable' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'wait for attachment deletion to finish' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'wait for every attachment upload to finish' using errcode = '22023';
  end if;
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
  signed_digest := private.form_signature_digest(current_digest, caller, material);
  insert into private.member_form_signatures (
    form_id, signer_kind, signer_user_id, strokes, signature_kind, typed_name,
    content_digest, signature_digest, consented_at
  ) values (
    p_form_id, 'filer', caller, material, signed_kind, signed_name,
    current_digest, signed_digest, signed_time
  )
  on conflict (form_id, signer_kind, signer_user_id) do update set
    strokes = excluded.strokes, signature_kind = excluded.signature_kind,
    typed_name = excluded.typed_name, content_digest = excluded.content_digest,
    signature_digest = excluded.signature_digest,
    consented_at = excluded.consented_at, created_at = now();
  update public.member_forms set
    filer_signed_at = signed_time, filer_signature_digest = signed_digest,
    content_digest = current_digest, updated_at = now()
  where id = p_form_id;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'signedAt', signed_time, 'signatureKind', signed_kind,
    'signatureDigest', signed_digest, 'contentDigest', current_digest);
end;
end
$$;

drop function public.respond_to_cosign(uuid, boolean, jsonb, boolean);
create function public.respond_to_cosign(
  p_form_id uuid, p_accept boolean, p_strokes jsonb, p_consent boolean,
  p_typed_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  new_status text;
  current_digest text;
  signed_time timestamptz;
  signed_digest text;
  signed_kind text := 'drawn';
  signed_name text;
  material jsonb := p_strokes;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_accept and p_consent is distinct from true then
    raise exception 'signature consent required' using errcode = '22023';
  end if;
  if p_accept then
    if p_typed_name is null then
      perform private.validate_form_signature_strokes(p_strokes);
    elsif p_strokes is not null then
      raise exception 'sign by drawing or by typing your name, not both' using errcode = '22023';
    else
      signed_name := private.normalize_form_typed_signature(p_typed_name);
      signed_kind := 'typed';
      material := pg_catalog.jsonb_build_object('kind', 'typed', 'name', signed_name);
    end if;
  end if;

  perform private.lock_member_form(p_form_id);
  select c.*, f.status as form_status into inv
    from public.member_form_cosigners c
    join public.member_forms f on f.id = c.form_id
    where c.form_id = p_form_id
      and f.status <> 'approved'
      and c.status in ('invited', 'reaffirm_needed')
      and (c.cosigner_user_id = caller
        or (caller_email <> '' and c.invited_email = caller_email))
    order by c.invited_at desc for update of c limit 1;
  if inv.id is null then
    raise exception 'no pending co-sign invitation for you on this form' using errcode = '22023';
  end if;

  new_status := case when p_accept then 'accepted' else 'declined' end;
  if p_accept then
    current_digest := private.form_content_digest(p_form_id);
    signed_time := now();
    signed_digest := private.form_signature_digest(current_digest, inv.id, material);
    insert into private.member_form_signatures (
      form_id, signer_kind, signer_user_id, cosigner_id, strokes, signature_kind,
      typed_name, content_digest, signature_digest, consented_at
    ) values (
      p_form_id, 'cosigner', caller, inv.id, material, signed_kind,
      signed_name, current_digest, signed_digest, signed_time
    )
    on conflict (form_id, signer_kind, signer_user_id) do update set
      cosigner_id = excluded.cosigner_id, strokes = excluded.strokes,
      signature_kind = excluded.signature_kind, typed_name = excluded.typed_name,
      content_digest = excluded.content_digest,
      signature_digest = excluded.signature_digest,
      consented_at = excluded.consented_at, created_at = now();
  else
    delete from private.member_form_signatures
      where form_id = p_form_id and signer_kind = 'cosigner' and signer_user_id = caller;
  end if;
  update public.member_form_cosigners
    set status = new_status,
        cosigner_user_id = case when p_accept then caller else cosigner_user_id end,
        responded_at = now(), signed_at = signed_time, signature_digest = signed_digest
    where id = inv.id;
  if p_accept then
    perform private.notify_member(inv.invited_by, 'cosign.accepted', '{}'::jsonb, 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', new_status, 'signedAt', signed_time,
    'signatureKind', case when p_accept then signed_kind end,
    'signatureDigest', signed_digest);
end;
end;
$$;

-- The member and the steward in scope see which way each current signature
-- was made and the typed name, never the strokes.
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

revoke all on function public.sign_member_form(uuid, jsonb, boolean, jsonb, text) from public, anon;
grant execute on function public.sign_member_form(uuid, jsonb, boolean, jsonb, text) to authenticated, service_role;
revoke all on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text) from public, anon;
grant execute on function public.respond_to_cosign(uuid, boolean, jsonb, boolean, text) to authenticated, service_role;

-- None of the replaced or new functions is reachable from a trigger; prove
-- the account lifecycle trigger inventory still matches its review.
do $inventory$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;

commit;
