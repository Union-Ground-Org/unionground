-- BUG-UG-FORM-SIGNATURE-SIGNS-ANSWERS-THE-SIGNER-NEVER-SAW-20261113 (#8702).
-- A form signature covers only what the signer reviewed, and a save names the
-- form it means.
--
-- public.sign_member_form takes the form lock and signs whatever the row holds
-- at that moment. Both clients save the reviewed answers and then sign in a
-- second request, so a save from another session of the same member between
-- the two (the website and the phone, or two tabs) was signed without being
-- shown, sealed FMLA forms included (gate stage 138 on #8700, finding r3s2).
--
-- The function gains one optional argument, p_expected, which names what the
-- signer reviewed. Under the existing form lock, after the attachment waits
-- and before the digest is computed, it is compared with the row:
--   sealed template:   p_expected->>'dataVersion' against the stored
--                      envelope's dataVersion, the version the client's
--                      checked save returned (the same value
--                      save_sealed_form_draft compares);
--   ordinary template: p_expected->'answers' against the stored answers,
--                      which save_form_draft stores exactly as sent;
--   attachmentIds:     required; the confirmed attachment ids the client
--                      showed ([] when it showed none). The set of confirmed
--                      attachments must equal it, because the digest covers
--                      them: an upload another session finished, or one a
--                      client cannot show yet, is not signed unseen (gate
--                      stage 139, r5s2 and r6s1).
-- A difference refuses with PT409 and DETAIL form_changed_since_review (HTTP
-- 409, never retried by PostgREST; 20261106220000). A p_expected that is not
-- an object, or lacks a key it needs, refuses with 22023.
--
-- p_expected null keeps the previous behaviour, so clients that do not send
-- it yet (the store builds) keep working. PostgREST resolves their three
-- named arguments to this function through the default.
--
-- Everything else is the live definition unchanged: the lock_case_graph entry
-- that 20260907151000 wrapped around it, the MFA, consent, stroke, owner,
-- status and attachment checks, the digest and the stored row. The grants
-- are the old ones (authenticated and service_role only). The function is not
-- on the account-lifecycle trigger surface (no trigger reaches it), so there
-- is no review receipt to renew.
--
-- public.save_form_draft (live definition from 20261028174500, with its
-- case-graph entry) gains an optional p_expected_form_id (gate stage 139,
-- r5s1). Without it the save updates the newest open form of the template or
-- creates one, so a retry after a lost submit reply could create a second
-- draft carrying the filed answers. With it, under the template lock and the
-- form lock, the named form must be the caller's, of that template and still
-- draft or returned; it is updated and no form is ever created. Otherwise it
-- refuses with PT409 and DETAIL form_not_editable before writing anything.
-- Null keeps the previous behaviour. Grants unchanged (authenticated and
-- service_role).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.sign_member_form(uuid,jsonb,boolean)'::regprocedure)) <> 'ee1429218cbe313ec7dda6470cb4caee' then
    raise exception 'unreviewed predecessor: public.sign_member_form(uuid,jsonb,boolean)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_form_draft(text,jsonb,integer)'::regprocedure)) <> 'f8613e0152ad26589f878cd1744e049c' then
    raise exception 'unreviewed predecessor: public.save_form_draft(text,jsonb,integer)' using errcode = '55000';
  end if;
end;
$preflight$;

drop function public.sign_member_form(uuid, jsonb, boolean);

create function public.sign_member_form(
  p_form_id uuid, p_strokes jsonb, p_consent boolean, p_expected jsonb default null
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
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_consent is distinct from true then
    raise exception 'signature consent required' using errcode = '22023';
  end if;
  perform private.validate_form_signature_strokes(p_strokes);
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
  signed_digest := private.form_signature_digest(current_digest, caller, p_strokes);
  insert into private.member_form_signatures (
    form_id, signer_kind, signer_user_id, strokes, content_digest,
    signature_digest, consented_at
  ) values (
    p_form_id, 'filer', caller, p_strokes, current_digest,
    signed_digest, signed_time
  )
  on conflict (form_id, signer_kind, signer_user_id) do update set
    strokes = excluded.strokes, content_digest = excluded.content_digest,
    signature_digest = excluded.signature_digest,
    consented_at = excluded.consented_at, created_at = now();
  update public.member_forms set
    filer_signed_at = signed_time, filer_signature_digest = signed_digest,
    content_digest = current_digest, updated_at = now()
  where id = p_form_id;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'signedAt', signed_time,
    'signatureDigest', signed_digest, 'contentDigest', current_digest);
end;
end
$$;

revoke all on function public.sign_member_form(uuid, jsonb, boolean, jsonb) from public, anon;
grant execute on function public.sign_member_form(uuid, jsonb, boolean, jsonb) to authenticated, service_role;

comment on function public.sign_member_form(uuid, jsonb, boolean, jsonb) is 'Filer signature. p_expected (optional) names the reviewed dataVersion (sealed) or answers (ordinary) and the confirmed attachment ids shown; a difference under the form lock refuses with PT409 form_changed_since_review.';

drop function public.save_form_draft(text, jsonb, integer);

CREATE FUNCTION public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
  tpl record;
  reaffirmed uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- Sealed templates save only through prepare_sealed_form and
  -- save_sealed_form_draft, which bind the draft to its organization and its
  -- envelope. A legacy save, even an empty one from a cached bundle, would
  -- create an organizationless draft or clear the sealed answers (#6329).
  if private.form_template_is_sealed(p_template_key) then
    raise exception 'sealed form templates save through the sensitive content API' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000 then
    raise exception 'answers too large' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  if p_expected_form_id is not null then
    -- The client names the form it edits (#8702): it must still be this
    -- caller's open form of this template, checked under the form lock that
    -- submit_form and sign_member_form take, and nothing is created.
    perform private.lock_member_form(p_expected_form_id);
    select id, answers into existing, prev_answers from public.member_forms
      where id = p_expected_form_id and user_id = caller and template_key = p_template_key
        and status in ('draft', 'returned')
      for update;
    if existing is null then
      raise exception 'form no longer editable' using errcode = 'PT409', detail = 'form_not_editable';
    end if;
  else
    select id, answers into existing, prev_answers from public.member_forms
      where user_id = caller and template_key = p_template_key and status in ('draft', 'returned')
      order by updated_at desc limit 1;
  end if;
  if existing is null then
    -- With no selected organization only platform seeds match below.
    select version,active into tpl from public.form_templates
      where key=p_template_key and (is_platform_seed
        or organization_id=(select private.current_member_organization()))
      order by (organization_id is not null) desc, version desc limit 1;
    if not found then raise exception 'invalid template' using errcode='22023'; end if;
    if not tpl.active then
      raise exception 'this form is no longer accepting new submissions' using errcode = '22023';
    end if;
    insert into public.member_forms (user_id, template_key, template_version, answers, step)
      values (caller, p_template_key, tpl.version, clean,
        least(greatest(coalesce(p_step, 0), 0), 50))
      returning id into existing;
  else
    if clean is distinct from prev_answers then
      delete from private.member_form_signatures where form_id = existing;
      update public.member_forms
        set filer_signed_at = null, filer_signature_digest = null, content_digest = null
        where id = existing;
      if p_template_key = 'alliance_grievance' then
        for reaffirmed in
          update public.member_form_cosigners
            set status='reaffirm_needed', responded_at=now(), signed_at=null, signature_digest=null
            where form_id=existing and status='accepted'
            returning cosigner_user_id
        loop
          if reaffirmed is not null then
            perform private.notify_member(reaffirmed, 'cosign.reaffirm', '{}'::jsonb, 'forms');
          end if;
        end loop;
      end if;
    end if;
    update public.member_forms
      set answers = clean, step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = existing and user_id = caller;
  end if;
  return existing;
end;
end;
$function$;

revoke all on function public.save_form_draft(text, jsonb, integer, uuid) from public, anon;
grant execute on function public.save_form_draft(text, jsonb, integer, uuid) to authenticated, service_role;

comment on function public.save_form_draft(text, jsonb, integer, uuid) is 'Ordinary form save. p_expected_form_id (optional) names the form being edited; it must still be the caller''s open form of the template under the form lock, else PT409 form_not_editable and nothing is created or written.';

notify pgrst, 'reload schema';
commit;
