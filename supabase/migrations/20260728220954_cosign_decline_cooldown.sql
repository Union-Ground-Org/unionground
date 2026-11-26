-- Co-sign re-invite cooldown (design decision, owner 2026-07-27).
--
-- WHY
-- invite_cosigner's re-invite branch accepts ANY non-active row, so a 'declined'
-- or 'withdrawn' co-signer can be re-invited immediately, over and over, up to
-- the active cap of 10 — and every re-invite inserts a fresh member_notification
-- for them. On an alliance grievance, "decline" is a member saying they will not
-- put their name on someone else's filing; the app must not turn that into a
-- button the filer can hold down. This adds a 30-day cooldown, server-side,
-- because a client-side guard is not a guard.
--
-- SCOPE
-- 'withdrawn' is covered too, and deliberately: withdrawing is revoking consent
-- that was already given, which is a stronger no than never giving it. Both
-- transitions stamp responded_at, so one clock serves both.
--
-- NOT AN ORACLE
-- The refusal is safe to be specific. Every row this branch can reach belongs to
-- the caller's OWN form, and the filer can already read its status through
-- member_form_cosigners_select_filer — so naming the cooldown discloses nothing
-- the caller cannot already see. The uniform-'invited' return (D1) is untouched:
-- it exists so a filer cannot learn whether an email maps to a member, and this
-- branch never runs for a fresh or active row. A cooldown refusal must NOT
-- return 'invited', or the filer believes an invitation was sent.
--
-- BODY PROVENANCE
-- Verbatim from the live definition at 20260725190000_mfa_guard_cosign_rpcs.sql
-- (MFA assurance guard, notification `kind` column from 20260723201000), with
-- exactly one insertion: the cooldown check at the top of the re-invite branch.
-- md5(pg_get_functiondef) changes by design here — re-pin invite_cosigner in
-- scripts/db-contract.json in the same PR.
--
-- CLIENT
-- FormsView's CosignerPanel should read the errcode + this message and render
-- forms.cosign.declinedCooldown inline against that row rather than as a toast,
-- with the invite button disabled while the address is in cooldown. See the
-- design pass: public/design/Forms System.dc.html (P5).

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
  cooldown constant interval := interval '30 days';
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

  select id, status, responded_at into existing from public.member_form_cosigners
    where form_id = p_form_id and invited_email = norm for update;
  if existing.id is not null then
    if existing.status in ('invited','accepted','reaffirm_needed') then
      return pg_catalog.jsonb_build_object('status','invited');  -- already active: uniform no-op
    end if;
    -- Re-invite cooldown (2026-07-27): a declined or withdrawn answer holds for
    -- 30 days. Own-form row, so the date is safe to name. Raises rather than
    -- returning the uniform 'invited', because nothing is sent.
    if existing.status in ('declined','withdrawn')
       and existing.responded_at is not null
       and existing.responded_at + cooldown > now() then
      raise exception 'this member answered already — you can ask again after %',
        pg_catalog.to_char(existing.responded_at + cooldown, 'YYYY-MM-DD')
        using errcode='22023';
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

-- Verification (staging, as the filer of an alliance grievance):
--   1. invite an address, respond_to_cosign(form, false) as that member
--   2. invite the same address again -> 22023, 'you can ask again after <date>'
--   3. update member_form_cosigners set responded_at = now() - interval '31 days'
--      where ... ; invite again -> succeeds, status back to 'invited'
--   4. an ACCEPTED row still returns the uniform {"status":"invited"} no-op
--   5. a never-invited address is unaffected
--
-- tests/: extend the cosign suite with a fnBody assertion on the new branch
-- ("you can ask again after") and a bodyMd5 re-pin in scripts/db-contract.json.
