-- MFA assurance guard for the co-sign RPCs (REQ-UG-DEFINER-MFA-AUDIT, batch 3 of 4: cosign).
--
-- VECTOR
-- SECURITY DEFINER bypasses RLS, so the RESTRICTIVE mfa_assurance policy that
-- covers every RLS table (20260724030000) does nothing for a definer function.
-- Batches 1-2 (20260725170000 events, 20260725180000 forms) swept their families;
-- this batch takes the four co-sign RPCs. All four are MEMBER RPCs bound to the
-- caller's own rows (own form for invite, own invitation for respond/preview, own
-- accepted co-signature for withdraw); none is steward-gated, so all four take
-- the member guard shape. An aal1 session belonging to a member who HAS enrolled
-- a TOTP factor can call them today without stepping up.
--
-- FIX
-- Augment the existing bare `if caller is null` guard to the assurance form the
-- guarded siblings carry:
--   if caller is null or not private.mfa_satisfied() then raise 42501.
-- private.mfa_satisfied() is aal2 OR "no verified TOTP factor", so this is
-- NON-LOCKOUT for members without MFA -- it only forces step-up for a member who
-- enrolled TOTP but is still at aal1.
-- cosign_invite_preview is the one DISCLOSURE rpc in the family (filer name +
-- 500-char summary to the invitee). Its guard is the FIRST statement, before the
-- invitation-ownership check and both table reads, so nothing is disclosed to an
-- under-assured session. There is no pre-auth invitee flow to break: the function
-- already required a non-null auth.uid(), and the client only calls it for the
-- signed-in member's own invitation rows (memberApi.js).
--
-- Bodies are otherwise VERBATIM from the live definitions: this file was
-- GENERATED server-side via replace(pg_get_functiondef(oid), old_guard_line,
-- new_guard_block) — the old line occurs exactly once per body, asserted at
-- generation time — so the bodies never passed through hand transcription.
-- Post-apply, md5(pg_get_functiondef) must equal the generation-time value:
--   invite_cosigner        30299dcb0d8136907ed292e366acd221
--   respond_to_cosign      4e0d8652d38a3ff50f91e5adaf1724c7
--   withdraw_cosign        3654ba1ddab1d60774b52d47a1160cae
--   cosign_invite_preview  9c320ddd15b28ac3cd714a7a074c6dd5
--
-- STAGING + COVERAGE
-- Batch 3 of the 4-batch rollout (events / forms / cosign / capability).
-- scripts/db-contract.json drops these four from mfaCoverage.pending and pins
-- private.mfa_satisfied() as a bodyContains needle on each; the sweep still
-- requires every SECURITY DEFINER function reachable by authenticated to carry
-- the term (directly or via member_has_role) or sit on an exemption list.
-- 3 pending remain (capability), shrinking to zero as batch 4 lands.

set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.invite_cosigner(p_form_id uuid, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  norm text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  frec record;
  target uuid;
  existing record;
  active_count integer;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): writes a co-sign invitation + member notification.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- caller must own an eligible alliance_grievance form (not yet approved). One
  -- generic message; the form is the caller's own, so no cross-member leak.
  select id, user_id, template_key, status into frec
    from public.member_forms where id = p_form_id;
  if not found or frec.user_id <> caller
     or frec.template_key <> 'alliance_grievance'
     or frec.status not in ('draft','returned','submitted','in_review') then
    raise exception 'form not found or not eligible for co-signers' using errcode='22023';
  end if;

  -- validate caller-supplied email (own input, not an enumeration surface)
  if norm = '' or pg_catalog.length(norm) > 320
     or norm !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'a valid email address is required' using errcode='22023';
  end if;
  if norm = caller_email then
    raise exception 'you cannot invite yourself' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cosign-'||p_form_id::text, 509));

  -- resolve target member LOCALLY (notification only; never stored here — D1)
  select id into target from auth.users where pg_catalog.lower(email) = norm limit 1;

  select id, status into existing from public.member_form_cosigners
    where form_id = p_form_id and invited_email = norm for update;
  if existing.id is not null then
    if existing.status in ('invited','accepted','reaffirm_needed') then
      return pg_catalog.jsonb_build_object('status','invited');  -- already active: uniform no-op
    end if;
    select count(*) into active_count from public.member_form_cosigners
      where form_id = p_form_id and status in ('invited','accepted','reaffirm_needed');
    if active_count >= 10 then raise exception 'co-signer limit reached (max 10)' using errcode='22023'; end if;
    update public.member_form_cosigners
      set status='invited', cosigner_user_id=null, invited_by=caller, invited_at=now(), responded_at=null
      where id = existing.id;
  else
    select count(*) into active_count from public.member_form_cosigners
      where form_id = p_form_id and status in ('invited','accepted','reaffirm_needed');
    if active_count >= 10 then raise exception 'co-signer limit reached (max 10)' using errcode='22023'; end if;
    insert into public.member_form_cosigners (form_id, invited_email, cosigner_user_id, invited_by)
      values (p_form_id, norm, null, caller);
  end if;

  -- notify ONLY members; non-member emails sit inert (D1)
  if target is not null then
    insert into public.member_notifications (user_id, title, body, kind)
    values (target, 'Co-sign invitation',
      'A member invited you to co-sign an alliance grievance. Open Forms to review and accept or decline.', 'forms');
  end if;

  return pg_catalog.jsonb_build_object('status','invited');  -- uniform (D1)
end $function$;

CREATE OR REPLACE FUNCTION public.respond_to_cosign(p_form_id uuid, p_accept boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  new_status text;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): binds or declines a co-signature on a grievance.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select id, invited_by into inv
    from public.member_form_cosigners
    where form_id = p_form_id
      and status in ('invited','reaffirm_needed')
      and (cosigner_user_id = caller or (caller_email <> '' and invited_email = caller_email))
    order by invited_at desc
    for update
    limit 1;
  if inv.id is null then
    raise exception 'no pending co-sign invitation for you on this form' using errcode='22023';
  end if;

  new_status := case when p_accept then 'accepted' else 'declined' end;
  update public.member_form_cosigners
    set status = new_status,
        cosigner_user_id = case when p_accept then caller else cosigner_user_id end,
        responded_at = now()
    where id = inv.id;

  if p_accept then
    insert into public.member_notifications (user_id, title, body, kind)
    values (inv.invited_by, 'Co-signer accepted',
      'A member accepted your invitation to co-sign your alliance grievance.', 'forms');
  end if;
  return pg_catalog.jsonb_build_object('status', new_status);
end $function$;

CREATE OR REPLACE FUNCTION public.withdraw_cosign(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  inv record;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): revokes an accepted co-signature.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select id, invited_by into inv
    from public.member_form_cosigners
    where form_id = p_form_id and cosigner_user_id = caller and status = 'accepted'
    for update limit 1;
  if inv.id is null then
    raise exception 'you have no active co-signature on this form' using errcode='22023';
  end if;
  update public.member_form_cosigners
    set status = 'withdrawn', responded_at = now() where id = inv.id;
  insert into public.member_notifications (user_id, title, body, kind)
  values (inv.invited_by, 'Co-signer withdrew',
    'A co-signer withdrew from your alliance grievance.', 'forms');
  return pg_catalog.jsonb_build_object('status','withdrawn');
end $function$;

CREATE OR REPLACE FUNCTION public.cosign_invite_preview(p_form_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  frec record;
  filer_name text;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): pre-accept disclosure of filer name + summary; the guard precedes every read.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select id, status into inv
    from public.member_form_cosigners
    where form_id = p_form_id
      and status in ('invited','reaffirm_needed','accepted')
      and (cosigner_user_id = caller or (caller_email <> '' and invited_email = caller_email))
    order by invited_at desc limit 1;
  if inv.id is null then
    raise exception 'no co-sign invitation for you on this form' using errcode='22023';
  end if;

  select user_id, template_key, answers into frec
    from public.member_forms where id = p_form_id;
  select full_name into filer_name from public.member_profiles where id = frec.user_id;

  return pg_catalog.jsonb_build_object(
    'formId', p_form_id,
    'template', frec.template_key,
    'inviteStatus', inv.status,
    'summary', pg_catalog.left(coalesce(frec.answers->>'summary',''), 500),
    'filerName', coalesce(nullif(pg_catalog.btrim(coalesce(filer_name,'')),''), 'A member')
  );
end $function$;
