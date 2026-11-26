-- MFA assurance guard for the forms RPCs (REQ-UG-DEFINER-MFA-AUDIT, batch 2 of 4: forms).
--
-- VECTOR
-- SECURITY DEFINER bypasses RLS, so the RESTRICTIVE mfa_assurance policy that
-- covers every RLS table (20260724030000) does nothing for a definer function.
-- Batch 1 (20260725170000) swept the three event member RPCs; this batch takes
-- the forms family. submit_form and save_form_draft are member action RPCs that
-- mint a submission point / persist a draft; an aal1 session belonging to a
-- member who HAS enrolled a TOTP factor can call them today without stepping up.
--
-- FIX (two shapes, because the family mixes a member action with a steward action)
--   * submit_form, save_form_draft are MEMBER RPCs: augment the existing bare
--     `if caller is null` guard to the assurance form the guarded siblings carry:
--       if caller is null or not private.mfa_satisfied() then raise 42501.
--     private.mfa_satisfied() is aal2 OR "no verified TOTP factor", so this is
--     NON-LOCKOUT for members without MFA -- it only forces step-up for a member
--     who enrolled TOTP but is still at aal1.
--   * approve_and_open_case is a STEWARD RPC (a thin wrapper over the two
--     steward-gated RPCs approve_form + open_form_as_case). Today it carries no
--     auth check of its own -- its gate is purely inherited from the first
--     delegated call. We make that gate EXPLICIT at the entry point with
--       if caller is null or not public.member_has_role(array['steward']) then raise 42501.
--     public.member_has_role() AND-s private.mfa_satisfied() BEFORE the role
--     lookup, so this both enforces the steward hat and forces MFA step-up in one
--     term -- matching its callees approve_form / open_form_as_case exactly. For
--     any real caller the observable behavior is unchanged (non-steward already
--     got 42501 'steward role required' from approve_form); the win is that the
--     gate no longer depends on the wrapper's first statement being a gated call.
--
-- Bodies are otherwise VERBATIM from the live definitions (pg_get_functiondef);
-- the only change per function is the guard block plus its comment. Post-apply
-- the before/after definitions are diffed to prove nothing else moved.
--
-- STAGING + COVERAGE
-- Batch 2 of the 4-batch rollout (events / forms / cosign / capability) so no
-- single merge carries all 13 lockout-capable changes. scripts/db-contract.json
-- drops these three from mfaCoverage.pending; the sweep still requires every
-- SECURITY DEFINER function reachable by authenticated to carry the term
-- (directly or via member_has_role) or sit on an exemption list. 7 pending remain
-- (cosign + capability), shrinking to zero as batches 3-4 land.

set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.submit_form(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  rec record;
  missing text;
  v_key text;
  had_event boolean;
  actual integer;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): mints a form-submission point.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
  tpl record;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): writes a member form draft.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
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
      insert into public.member_notifications (user_id, title, body, kind)
        select cosigner_user_id, 'Re-affirm your co-signature',
          'An alliance grievance you co-signed was edited. Please review and re-affirm your co-signature.', 'forms'
        from reset where cosigner_user_id is not null;
    end if;
  end if;
  return existing;
end;
$function$;

CREATE OR REPLACE FUNCTION public.approve_and_open_case(p_form_id uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  perform public.approve_form(p_form_id, p_note);
  return public.open_form_as_case(p_form_id);
end $function$;
