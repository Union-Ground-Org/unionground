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

-- 2. steward widening read: review states only ------------------------------
-- Explicit allow-list, not exclusion: 'returned' is out because after a return
-- the member re-edits the same row in place via save_form_draft, so it is
-- functionally a draft; and any status added later stays steward-invisible
-- until deliberately listed here.
drop policy if exists member_forms_select_steward on public.member_forms;
create policy member_forms_select_steward on public.member_forms
  for select to authenticated
  using (public.member_has_role(array['steward']) and status in ('submitted', 'in_review', 'approved'));

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
