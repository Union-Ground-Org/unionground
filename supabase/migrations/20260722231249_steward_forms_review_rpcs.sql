-- 5. steward review RPCs ----------------------------------------------------
-- All role-gated, all reject the caller's own form (a steward-member never
-- reviews their own filing), none write member_action_log.
create or replace function public.steward_start_review(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  update public.member_forms
    set status = 'in_review', reviewed_by = caller, updated_at = now()
    where id = p_form_id and status = 'submitted' and user_id <> caller;
  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'form not found, not awaiting review, or your own' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'in_review');
end $$;

create or replace function public.approve_form(p_form_id uuid, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
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

  select id, user_id, status, template_key into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;

  update public.member_forms
    set status = 'approved', review_note = clean_note, reviewed_by = caller, reviewed_at = now(), updated_at = now()
    where id = p_form_id;

  insert into public.member_notifications (user_id, title, body)
  values (rec.user_id, 'Form approved',
    private.form_template_label(rec.template_key) || ' — reviewed and approved by your steward.'
      || coalesce(' Note: ' || clean_note, ''));

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'approved');
end $$;

create or replace function public.return_form(p_form_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
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

  select id, user_id, status, template_key into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller then
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

  insert into public.member_notifications (user_id, title, body)
  values (rec.user_id, 'Form returned',
    private.form_template_label(rec.template_key) || ' — returned by your steward for changes. Note: ' || clean_note);

  return pg_catalog.jsonb_build_object('formId', p_form_id, 'status', 'returned');
end $$;

create or replace function public.open_form_as_case(p_form_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  new_case uuid;
  ref text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select id, user_id, status, template_key, answers, case_id into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id = caller then
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

  -- deterministic per-form reference; the case_id-null guard makes this
  -- single-shot, and a collision with a member-created reference surfaces as
  -- a clean error rather than a duplicate case. No action-log write here:
  -- steward actions never mint member points.
  ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-F' || pg_catalog.substr(pg_catalog.replace(rec.id::text, '-', ''), 1, 6);
  begin
    insert into public.member_cases (user_id, reference, title, case_type, articles, step)
    values (
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

  insert into public.member_notifications (user_id, title, body)
  values (rec.user_id, 'Grievance case opened',
    private.form_template_label(rec.template_key) || ' — your steward opened case ' || ref || ' from your approved form. Track it under Cases.');

  return new_case;
end $$;

revoke all on function public.steward_start_review(uuid) from public, anon;
revoke all on function public.approve_form(uuid, text) from public, anon;
revoke all on function public.return_form(uuid, text) from public, anon;
revoke all on function public.open_form_as_case(uuid) from public, anon;
grant execute on function public.steward_start_review(uuid) to authenticated;
grant execute on function public.approve_form(uuid, text) to authenticated;
grant execute on function public.return_form(uuid, text) to authenticated;
grant execute on function public.open_form_as_case(uuid) to authenticated;
