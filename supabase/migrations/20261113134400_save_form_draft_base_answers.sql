-- BUG-UG-ORDINARY-FORM-SAVE-OVERWRITES-A-NEWER-EDIT-FROM-ANOTHER-SESSION-20261114 (#8719).
-- An ordinary draft save names the answers it was based on.
--
-- save_form_draft wrote the answers it was given over whatever was stored:
-- the last writer won. A device that had shown older answers (its pre-sign or
-- pre-submit save included) silently replaced the member's newer edit from
-- another session and cleared that session's signature (Android SAMPLE run on
-- #8700, Nov 14, 2026). Sealed forms already carry an expected data version.
--
-- save_form_draft gains p_base_answers jsonb DEFAULT NULL: the answers the
-- client last knew to be stored for this form. Under the form lock (taken on
-- the named form, or on the newest open form of the template when no form is
-- named, which is then re-read), a stored draft that differs from the base
-- refuses with PT409 and DETAIL form_saved_elsewhere, and nothing is written.
-- A first save that creates the draft has nothing to compare. A base that is
-- not an object refuses with 22023. Null keeps the previous behaviour.
--
-- The body is the live definition from 20261113114500 with the checks above;
-- guard, sealed refusal, template lock, the expected-form-id check, signature
-- reset, co-signer reaffirm and grants are unchanged.
--
-- save_unit_form_draft (20261113124000, a unit's form draft) saves through
-- save_form_draft; it gains the same optional p_base_answers and passes it
-- through, so a unit save is protected too. Its body is otherwise the live
-- definition. Applied migrations are not edited.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_form_draft(text,jsonb,integer,uuid)'::regprocedure)) <> '784d7851b8d9a69897fc95f35fe13522' then
    raise exception 'unreviewed predecessor: public.save_form_draft(text,jsonb,integer,uuid)' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid)'::regprocedure)) <> '64471dc251ef1a36ce465995989bf7df' then
    raise exception 'unreviewed predecessor: public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid)' using errcode = '55000';
  end if;
end;
$preflight$;

drop function public.save_unit_form_draft(text, jsonb, integer, uuid, uuid, text, uuid, uuid);
drop function public.save_form_draft(text, jsonb, integer, uuid);

CREATE FUNCTION public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer, p_expected_form_id uuid DEFAULT NULL::uuid, p_base_answers jsonb DEFAULT NULL::jsonb)
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
  if p_base_answers is not null and pg_catalog.jsonb_typeof(p_base_answers) <> 'object' then
    raise exception 'base answers must be an object' using errcode = '22023';
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
    if existing is not null and p_base_answers is not null then
      -- The base is compared under the form lock that sign_member_form and
      -- submit_form take (#8719); re-read the row once it is held.
      perform private.lock_member_form(existing);
      select answers into prev_answers from public.member_forms where id = existing for update;
    end if;
  end if;
  -- The answers this save was based on (#8719): when the stored draft has
  -- moved past them (another session saved), nothing is written.
  if existing is not null and p_base_answers is not null
     and p_base_answers is distinct from coalesce(prev_answers, '{}'::jsonb) then
    raise exception 'form changed elsewhere' using errcode = 'PT409', detail = 'form_saved_elsewhere';
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

revoke all on function public.save_form_draft(text, jsonb, integer, uuid, jsonb) from public, anon;
grant execute on function public.save_form_draft(text, jsonb, integer, uuid, jsonb) to authenticated, service_role;

comment on function public.save_form_draft(text, jsonb, integer, uuid, jsonb) is 'Ordinary form save. p_expected_form_id (optional) names the form being edited (else PT409 form_not_editable); p_base_answers (optional) names the answers the client last knew to be stored, and a stored draft that differs refuses with PT409 form_saved_elsewhere, writing nothing.';

create function public.save_unit_form_draft(p_template_key text,p_answers jsonb,p_step integer,p_unit uuid,p_actor uuid,p_chapter text,p_organization uuid,p_expected_form_id uuid default null,p_base_answers jsonb default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; previous text;
begin
  perform private.lock_case_graph(array[auth.uid()],array[]::uuid[]);
  if auth.uid() is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode='42501'; end if;
  previous:=current_setting('unionground.settings_unit',true);
  perform private.require_unit_workflow_context(p_actor,p_chapter,p_organization);
  perform private.resolve_settings_unit(private.current_member_chapter(),p_unit);
  perform set_config('unionground.settings_unit',coalesce(p_unit::text,''),true);
  result:=public.save_form_draft(p_template_key,p_answers,p_step,p_expected_form_id,p_base_answers);
  perform set_config('unionground.settings_unit',coalesce(previous,''),true);
  return result;
end;
$$;
revoke all on function public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_unit_form_draft(text,jsonb,integer,uuid,uuid,text,uuid,uuid,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
