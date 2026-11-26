-- REQ-UG-FULL-DEPTH-20260723 PR2 (3/3): member_forms joins the registry.
--
-- THE ONE MIGRATION TOUCHING LIVE member_forms. Ordering is load-bearing: it
-- MUST apply after 20260723110000 seeds the version=1 rows, or the FK
-- VALIDATE fails. Pre-flight (verified before the live apply):
--   select distinct template_key from public.member_forms
--   except select key from public.form_templates;   -- must be 0 rows
--
-- template_version backfills to 1 by constant default (metadata-only); every
-- pre-existing row is correctly version 1 because the seed reproduces exactly
-- the 7 keys the old CHECK allowed. The composite FK replaces the CHECK enum
-- and enforces both "key exists" and "the exact claimed version exists". The
-- FK attaches NOT VALID then VALIDATEs (scan under SHARE UPDATE EXCLUSIVE,
-- not the ADD's ACCESS EXCLUSIVE — member_forms is small, but the house
-- pattern stays phased on principle).
--
-- Function rewrites layered here (each reproduces its current live body):
--   save_form_draft  — registry lookup replaces the hardcoded key list; the
--                      active gate applies ONLY to new drafts (deactivate
--                      means "stop new starts", in-flight work finishes);
--                      new drafts stamp the current template_version.
--   submit_form      — completeness gate flips to the version-pinned 2-arg
--                      form_required_keys against the form's OWN version.
--   approve_form / return_form / open_form_as_case
--                    — notification title/body localized to the recipient's
--                      profile language via form_template_label_localized,
--                      and the steward chapter-scope guard (PR1's
--                      staff_can_see_user) folds into the existing collapsed
--                      row guard — out-of-scope stays indistinguishable from
--                      not-found (no existence oracle).
--   steward_start_review — same scope predicate folded into its UPDATE.

alter table public.member_forms
  add column template_version integer not null default 1;

alter table public.member_forms
  add constraint member_forms_template_fkey
  foreign key (template_key, template_version) references public.form_templates(key, version)
  not valid;

alter table public.member_forms validate constraint member_forms_template_fkey;

alter table public.member_forms drop constraint member_forms_template_key_check;

create or replace function public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
  tpl record;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select version, active into tpl from public.form_templates
    where key = p_template_key order by version desc limit 1;
  if not found then raise exception 'invalid template' using errcode='22023'; end if;
  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000
    then raise exception 'answers too large' using errcode='22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-form-'||caller::text||'-'||p_template_key, 509));
  select id, answers into existing, prev_answers from public.member_forms
    where user_id=caller and template_key=p_template_key and status in ('draft','returned')
    order by updated_at desc limit 1;
  if existing is null then
    if not tpl.active then
      raise exception 'this form is no longer accepting new submissions' using errcode='22023';
    end if;
    insert into public.member_forms (user_id, template_key, template_version, answers, step)
      values (caller, p_template_key, tpl.version, clean, least(greatest(coalesce(p_step,0),0),50))
      returning id into existing;
  else
    update public.member_forms set answers=clean, step=least(greatest(coalesce(p_step,0),0),50), updated_at=now()
      where id=existing and user_id=caller;
    if p_template_key = 'alliance_grievance' and clean is distinct from prev_answers then
      with reset as (
        update public.member_form_cosigners
          set status='reaffirm_needed', responded_at=now()
          where form_id=existing and status='accepted'
          returning cosigner_user_id
      )
      insert into public.member_notifications (user_id, title, body)
        select cosigner_user_id, 'Re-affirm your co-signature',
          'An alliance grievance you co-signed was edited. Please review and re-affirm your co-signature.'
        from reset where cosigner_user_id is not null;
    end if;
  end if;
  return existing;
end;
$$;

create or replace function public.submit_form(p_form_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  missing text;
  v_key text;
  had_event boolean;
  actual integer;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select id, user_id, status, template_key, template_version, answers into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller then raise exception 'form not found' using errcode='22023'; end if;
  if rec.status not in ('draft','returned') then raise exception 'form not submittable' using errcode='22023'; end if;

  select k into missing
  from pg_catalog.unnest(private.form_required_keys(rec.template_key, rec.template_version)) as k
  where case when pg_catalog.jsonb_typeof(rec.answers->k) = 'array'
             then pg_catalog.jsonb_array_length(rec.answers->k) = 0
             else pg_catalog.btrim(coalesce(rec.answers->>k, '')) = '' end
  limit 1;
  if missing is not null then
    raise exception 'form incomplete: %', missing using errcode='22023';
  end if;

  update public.member_forms set status='submitted', submitted_at=now(), review_note=null, updated_at=now()
    where id = p_form_id and user_id = caller;

  v_key := 'form-' || p_form_id::text;
  had_event := exists (select 1 from public.member_point_events where user_id = caller and action_key = v_key);
  insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, v_key, 'form') on conflict (user_id, action_key) do nothing;
  select points into actual from public.member_point_events where user_id = caller and action_key = v_key;

  return pg_catalog.jsonb_build_object('status', 'submitted',
    'awardedPoints', case when had_event then 0 else coalesce(actual, 0) end);
end;
$$;

create or replace function public.approve_form(p_form_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  rec record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note is not null then
    if pg_catalog.char_length(clean_note) > 4000 then
      raise exception 'note must be at most 4000 characters' using errcode = '22023';
    end if;
    if pg_catalog.regexp_replace(clean_note, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
      raise exception 'note contains unsupported control characters' using errcode = '22023';
    end if;
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, coalesce(p.language, 'en') as lang into rec
    from public.member_forms f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;

  update public.member_forms
    set status = 'approved', review_note = clean_note, reviewed_by = caller, reviewed_at = now(), updated_at = now()
    where id = p_form_id;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body)
    values (rec.user_id, 'Formulario aprobado',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — revisado y aprobado por tu delegado.'
        || coalesce(' Nota: ' || clean_note, ''));
  else
    insert into public.member_notifications (user_id, title, body)
    values (rec.user_id, 'Form approved',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — reviewed and approved by your steward.'
        || coalesce(' Note: ' || clean_note, ''));
  end if;

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'approved');
end;
$$;

create or replace function public.return_form(p_form_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  rec record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note = '' or pg_catalog.char_length(clean_note) > 4000 then
    raise exception 'return note must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if pg_catalog.regexp_replace(clean_note, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'note contains unsupported control characters' using errcode = '22023';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, coalesce(p.language, 'en') as lang into rec
    from public.member_forms f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;

  -- the one-active-per-template partial index covers draft+returned: if the
  -- member started a NEW draft of this template after submitting this row,
  -- flipping it to returned would collide. Surface a clean error instead of a
  -- unique_violation 500 — the steward can approve, or the member finishes
  -- the newer draft first.
  begin
    update public.member_forms
      set status = 'returned', review_note = clean_note, reviewed_by = caller, reviewed_at = now(), updated_at = now()
      where id = p_form_id;
  exception when unique_violation then
    raise exception 'member already has an active draft of this template; approve instead or ask them to finish it' using errcode = '23505';
  end;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body)
    values (rec.user_id, 'Formulario devuelto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — devuelto por tu delegado para cambios. Nota: ' || clean_note);
  else
    insert into public.member_notifications (user_id, title, body)
    values (rec.user_id, 'Form returned',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — returned by your steward for changes. Note: ' || clean_note);
  end if;

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'returned');
end;
$$;

create or replace function public.open_form_as_case(p_form_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  new_case uuid;
  ref text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select f.id, f.user_id, f.status, f.template_key, f.template_version, f.answers, f.case_id, coalesce(p.language, 'en') as lang into rec
    from public.member_forms f
    left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  -- Not-found, the caller's own form, member-private states (draft/returned
  -- are never steward-visible), and out-of-chapter-scope targets all collapse
  -- to one generic error so a steward holding a guessed form UUID cannot use
  -- the status-specific raises below as an existence oracle for another
  -- member's in-progress filing.
  if not found or rec.user_id = caller or rec.status in ('draft', 'returned')
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found or your own' using errcode = '22023';
  end if;
  if rec.status <> 'approved' then
    raise exception 'only approved forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.template_key not in ('grievance', 'alliance_grievance') then
    raise exception 'only grievance forms can be opened as cases' using errcode = '22023';
  end if;
  if rec.case_id is not null then
    raise exception 'this form already has a case' using errcode = '22023';
  end if;

  -- server-generated reference (pre-mortem #3): the form id is member-visible,
  -- so a member could pre-insert its derived reference and permanently block
  -- this call. A fresh uuid is unknowable to the member; 8 hex chars kill the
  -- intra-user birthday collision. The case_id-null guard makes this
  -- single-shot, and any residual unique_violation surfaces as a clean error
  -- rather than a duplicate case. No action-log write here: steward actions
  -- never mint member points.
  new_case := extensions.gen_random_uuid();
  ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-F' || pg_catalog.substr(pg_catalog.replace(new_case::text, '-', ''), 1, 8);
  begin
    insert into public.member_cases (id, user_id, reference, title, case_type, articles, step)
    values (
      new_case,
      rec.user_id,
      ref,
      coalesce(nullif(pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'summary', ''), 200)), ''), 'Grievance from submitted form'),
      'Grievance',
      pg_catalog.btrim(pg_catalog.left(coalesce(rec.answers->>'articles', ''), 200)),
      'Intake')
    returning id into new_case;
  exception when unique_violation then
    raise exception 'a case with this reference already exists for the member' using errcode = '23505';
  end;

  update public.member_forms set case_id = new_case, updated_at = now() where id = p_form_id;

  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body)
    values (rec.user_id, 'Caso de queja abierto',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — tu delegado abrió el caso ' || ref || ' a partir de tu formulario aprobado. Síguelo en Casos.');
  else
    insert into public.member_notifications (user_id, title, body)
    values (rec.user_id, 'Grievance case opened',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang) || ' — your steward opened case ' || ref || ' from your approved form. Track it under Cases.');
  end if;

  return new_case;
end;
$$;

create or replace function public.steward_start_review(p_form_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  update public.member_forms
    set status = 'in_review', reviewed_by = caller, updated_at = now()
    where id = p_form_id and status = 'submitted' and user_id <> caller
      and public.staff_can_see_user(user_id, 'steward');
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'form not found, not awaiting review, or your own' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'in_review');
end;
$$;

revoke all on function public.save_form_draft(text, jsonb, integer) from public, anon;
revoke all on function public.submit_form(uuid) from public, anon;
revoke all on function public.approve_form(uuid, text) from public, anon;
revoke all on function public.return_form(uuid, text) from public, anon;
revoke all on function public.open_form_as_case(uuid) from public, anon;
revoke all on function public.steward_start_review(uuid) from public, anon;

grant execute on function public.save_form_draft(text, jsonb, integer) to authenticated;
grant execute on function public.submit_form(uuid) to authenticated;
grant execute on function public.approve_form(uuid, text) to authenticated;
grant execute on function public.return_form(uuid, text) to authenticated;
grant execute on function public.open_form_as_case(uuid) to authenticated;
grant execute on function public.steward_start_review(uuid) to authenticated;
