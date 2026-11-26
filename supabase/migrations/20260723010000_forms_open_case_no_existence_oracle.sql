-- Phase 4b follow-up: close a LOW existence-oracle in open_form_as_case.
--
-- The PR2 function (20260722210000) raised the status-specific
-- 'only approved forms can be opened as cases' for ANY not-own, not-approved
-- row. A member's draft/returned form is never steward-visible (the SELECT
-- policy exposes only submitted/in_review), so a steward holding a guessed or
-- leaked form UUID could use that status-specific message to distinguish
-- "exists but private" from "does not exist" — an existence oracle over another
-- member's in-progress FMLA/grievance filing (leaks existence, not content).
--
-- Fix: collapse the two member-private states (draft, returned) into the SAME
-- generic error a missing row raises. submitted/in_review stay distinguishable
-- on purpose — the steward already sees those in the inbox, so the "not
-- approved yet" message reveals nothing new. Idempotent create-or-replace; the
-- body is otherwise byte-identical to 20260722210000 (server-uuid reference,
-- role gate, self-review guard, single-shot case-open, no point minting).
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
  -- Not-found, the caller's own form, and member-private states (draft/returned
  -- are never steward-visible) all collapse to one generic error so a steward
  -- holding a guessed form UUID cannot use the status-specific raises below as
  -- an existence oracle for another member's in-progress filing.
  if not found or rec.user_id = caller or rec.status in ('draft', 'returned') then
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

revoke all on function public.open_form_as_case(uuid) from public, anon;
grant execute on function public.open_form_as_case(uuid) to authenticated;
