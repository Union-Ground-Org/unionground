-- Phase 4b PR2: steward forms review inbox (GAP-401/402). Widens member_forms
-- with a steward read of review states only (drafts AND returned re-edits stay
-- owner-only — the headline privacy invariant; pre-mortem finding #1), adds the
-- four review RPCs, and closes PR1 follow-ups M1 (submit_form reports only
-- actually-credited points) and L3 (server-side completeness). Steward RPCs
-- never touch member_action_log. Additive.

-- 1. case linkage FK (column shipped in PR1 without the constraint) ---------
alter table public.member_forms drop constraint if exists member_forms_case_id_fkey;
alter table public.member_forms
  add constraint member_forms_case_id_fkey
  foreign key (case_id) references public.member_cases(id) on delete set null;

-- 2. steward widening read: active review states only -----------------------
-- Explicit allow-list, not exclusion: 'returned' is out because after a return
-- the member re-edits the same row in place via save_form_draft, so it is
-- functionally a draft; 'approved' is out because no steward read path needs
-- it (the inbox reads submitted/in_review and case-opening runs through
-- security-definer RPCs) and leaving it in would expose every member's
-- approved FMLA/medical answers chapter-wide forever. Any status added later
-- stays steward-invisible until deliberately listed here.
drop policy if exists member_forms_select_steward on public.member_forms;
create policy member_forms_select_steward on public.member_forms
  for select to authenticated
  using (public.member_has_role(array['steward']) and status in ('submitted', 'in_review'));

-- 2b. cap the form point kind (pre-mortem #2: it was the only uncapped kind;
-- resubmission loops could otherwise mint +15 per fresh form id without limit)
update public.member_point_rules set weekly_cap = 3 where action_kind = 'form';

-- 3. helpers ----------------------------------------------------------------
-- Required keys mirror src/lib/formTemplates.js; tests/steward-forms.test.js
-- pins the two lists in lockstep so template edits cannot drift silently.
create or replace function private.form_required_keys(p_template_key text)
returns text[] language sql immutable set search_path = '' as $$
  select case p_template_key
    when 'grievance' then array['summary','incident_date','narrative','remedy']
    when 'fmla_self' then array['reason','condition_type','start_date','end_date']
    when 'fmla_family' then array['relationship','family_member','reason','condition_type','start_date','end_date']
    when 'alliance_grievance' then array['summary','incident_date','narrative','affected','remedy']
    when 'non_selection' then array['posting','applied_date','notified_date','grounds']
    when 'alt_work' then array['requested','reason']
    when 'service_request' then array['category','description']
    else array[]::text[] end;
$$;

-- English labels for member notifications; matches the en i18n titles.
create or replace function private.form_template_label(p_template_key text)
returns text language sql immutable set search_path = '' as $$
  select case p_template_key
    when 'grievance' then 'Grievance report'
    when 'fmla_self' then 'FMLA — my own health'
    when 'fmla_family' then 'FMLA — family care'
    when 'alliance_grievance' then 'Alliance grievance'
    when 'non_selection' then 'Non-selection appeal'
    when 'alt_work' then 'Alternative work arrangement'
    when 'service_request' then 'Member service request'
    else p_template_key end;
$$;

-- 4. submit_form: M1 truthful award + L3 completeness -----------------------
-- member_point_events is unique (user_id, action_key) and only the award
-- trigger writes it, so "credited by THIS call" = no event before the
-- action-log insert AND an event after it.
create or replace function public.submit_form(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  missing text;
  v_key text;
  had_event boolean;
  actual integer;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select id, user_id, status, template_key, answers into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller then raise exception 'form not found' using errcode='22023'; end if;
  if rec.status not in ('draft','returned') then raise exception 'form not submittable' using errcode='22023'; end if;

  select k into missing
  from pg_catalog.unnest(private.form_required_keys(rec.template_key)) as k
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
end $$;
revoke all on function public.submit_form(uuid) from public, anon;
grant execute on function public.submit_form(uuid) to authenticated;

revoke all on function private.form_required_keys(text) from public, anon, authenticated;
revoke all on function private.form_template_label(text) from public, anon, authenticated;

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

-- 6. atomic approve-and-open (adversarial-review HIGH-1) --------------------
-- The client's "Approve & open case" was two RPC transactions: if the approve
-- committed and the case-open then failed, the grievance sat approved but
-- case-less with no UI path back to it (the inbox lists only
-- submitted/in_review). Composing both inside one function makes the pair a
-- single transaction — a case-open failure rolls the approval back too. All
-- guards (role, self-review, status, template, single-shot) live in the two
-- composed functions.
create or replace function public.approve_and_open_case(p_form_id uuid, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform public.approve_form(p_form_id, p_note);
  return public.open_form_as_case(p_form_id);
end $$;
revoke all on function public.approve_and_open_case(uuid, text) from public, anon;
grant execute on function public.approve_and_open_case(uuid, text) to authenticated;
