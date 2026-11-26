-- REQ-UG-NOTIFICATION-COPY-SWEEP-20260727
--
-- System sweep, not a Tasks fix. Three findings from SYSTEM-SWEEP.md:
--
--   S-1. The five co-signer notification sites are English-only, and they are
--        kind='forms' -- an OUTBOUND topic. A Spanish-speaking member does not
--        merely read English in the feed; once outbound is activated they get
--        an English email. The alliance grievance is the one flow in this
--        product that needs other members to sign it, and it is the one flow
--        that only speaks English.
--   S-2. notify_mfa_enrolment() dedupes on two hardcoded title literals. Reword
--        either -- or move the copy into a table, which is what this file does
--        -- and the dedupe silently stops matching, re-opening the
--        unenroll/re-enrol notification loop its own migration closed.
--   S-6. handle_new_member() seeds three English rows into every new member's
--        feed, including Spanish-speaking members.
--
-- All three are solved the same way: copy lives in private.notification_copy
-- (from 20260728221106), where a key cannot hold one language without the
-- other, and private.notify_member() renders per recipient.
--
-- REGENERATED 2026-07-28 (design wire-in step 2). The package's copies of the
-- four member RPCs below were STALE pre-2026-07-25 bodies: they dropped the
-- private.mfa_satisfied() assurance guards (20260725180000 / 20260725190000)
-- and the 30-day re-invite cooldown (20260728220954). Each body below is the
-- CURRENT live definition verbatim -- guards, cooldown, advisory locks,
-- exception boundaries, uniform-response semantics -- with ONLY the
-- notification insert replaced by private.notify_member. Written in
-- pg_get_functiondef form so the post-apply md5 equals the bodyMd5 pinned in
-- scripts/db-contract.json (re-pinned in this same PR).

set local lock_timeout = '5s';

-- 1. Copy. Bodies name no form, no case reference and no member: the
--    shoulder-test rule from the push pass, and these rows now go outbound.
insert into private.notification_copy (key, lang, title, body) values
  ('cosign.invited', 'en', 'Co-sign invitation',
    'A member invited you to co-sign an alliance grievance. Open Forms to review and accept or decline.'),
  ('cosign.invited', 'es', 'Invitación para co-firmar',
    'Un miembro te invitó a co-firmar una queja en alianza. Abre Formularios para revisarla y aceptar o rechazar.'),
  ('cosign.accepted', 'en', 'Co-signer accepted',
    'A member accepted your invitation to co-sign your alliance grievance.'),
  ('cosign.accepted', 'es', 'Co-firma aceptada',
    'Un miembro aceptó tu invitación para co-firmar tu queja en alianza.'),
  ('cosign.withdrew', 'en', 'Co-signer withdrew',
    'A co-signer withdrew from your alliance grievance.'),
  ('cosign.withdrew', 'es', 'Una co-firma se retiró',
    'Un co-firmante se retiró de tu queja en alianza.'),
  ('cosign.reaffirm', 'en', 'Re-affirm your co-signature',
    'An alliance grievance you co-signed was edited. Please review and re-affirm your co-signature.'),
  ('cosign.reaffirm', 'es', 'Reconfirma tu co-firma',
    'Se editó una queja en alianza que co-firmaste. Revísala y reconfirma tu co-firma.'),
  ('cosign.approved', 'en', 'Alliance grievance approved',
    'An alliance grievance you co-signed was approved by a steward.'),
  ('cosign.approved', 'es', 'Queja en alianza aprobada',
    'Tu delegado aprobó una queja en alianza que co-firmaste.'),
  -- S-2: the MFA alert's copy moves here so the dedupe can resolve it instead
  -- of matching two literals that any reword would break.
  ('mfa.enrolled', 'en', 'Two-step sign-in was turned on',
    'An authenticator was added to your account. If this was not you, contact your local office immediately — an admin can remove it and sign out any open sessions.'),
  ('mfa.enrolled', 'es', 'Se activó la verificación en dos pasos',
    'Se agregó un autenticador a tu cuenta. Si no fuiste tú, contacta a tu oficina local de inmediato — un administrador puede quitarlo y cerrar las sesiones abiertas.'),
  -- S-6: the three signup seed rows. Fictional onboarding content, in-app only.
  ('seed.ballot', 'en', 'Ballot closes soon', 'Cast your vote on the chapter action budget priorities.'),
  ('seed.ballot', 'es', 'La votación cierra pronto', 'Vota sobre las prioridades del presupuesto de acción de la sección.'),
  ('seed.caseDeadline', 'en', 'Case deadline', 'Your Step 2 response deadline needs attention.'),
  ('seed.caseDeadline', 'es', 'Fecha límite del caso', 'La fecha límite de tu respuesta del Paso 2 necesita atención.'),
  ('seed.chapterUpdate', 'en', 'New chapter update', 'The latest fictional chapter broadcast is ready.'),
  ('seed.chapterUpdate', 'es', 'Nueva actualización de la sección', 'El último comunicado ficticio de la sección está listo.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- 2. notify_member gains a kind argument's real use and a backdated variant.
--    handle_new_member writes rows with created_at in the past (so the feed
--    looks lived-in on first sign-in), which the base helper cannot express.
create or replace function private.notify_member_at(
  p_user_id uuid,
  p_key text,
  p_created_at timestamptz,
  p_args jsonb default '{}'::jsonb,
  p_kind text default 'general'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_lang text;
  copy_row private.notification_copy;
  rendered_title text;
  rendered_body text;
  arg record;
begin
  if p_user_id is null then
    return;
  end if;

  select coalesce(p.language, 'en') into recipient_lang
  from public.member_profiles p where p.id = p_user_id;

  select * into copy_row from private.notification_copy c
  where c.key = p_key and c.lang = coalesce(recipient_lang, 'en');
  if copy_row.key is null then
    select * into copy_row from private.notification_copy c
    where c.key = p_key and c.lang = 'en';
  end if;
  if copy_row.key is null then
    raise exception 'unknown notification copy key: %', p_key;
  end if;

  rendered_title := copy_row.title;
  rendered_body := copy_row.body;
  for arg in select key, value from pg_catalog.jsonb_each_text(coalesce(p_args, '{}'::jsonb))
  loop
    rendered_title := pg_catalog.replace(rendered_title, '{' || arg.key || '}', arg.value);
    rendered_body := pg_catalog.replace(rendered_body, '{' || arg.key || '}', arg.value);
  end loop;

  insert into public.member_notifications (user_id, title, body, kind, created_at)
  values (p_user_id, rendered_title, rendered_body, p_kind, coalesce(p_created_at, now()));
end
$$;

revoke all on function private.notify_member_at(uuid, text, timestamptz, jsonb, text)
  from public, anon, authenticated, service_role;

-- 3. S-1: the five co-signer sites. Each body is the CURRENT live definition
--    verbatim -- MFA guards (20260725180000/20260725190000) and the re-invite
--    cooldown (20260728220954) included -- with ONLY the notification insert
--    replaced.

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
    perform private.notify_member(target, 'cosign.invited', '{}'::jsonb, 'forms');
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
    perform private.notify_member(inv.invited_by, 'cosign.accepted', '{}'::jsonb, 'forms');
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
  perform private.notify_member(inv.invited_by, 'cosign.withdrew', '{}'::jsonb, 'forms');
  return pg_catalog.jsonb_build_object('status','withdrawn');
end $function$;

create or replace function private.notify_cosigners_on_approve()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  cosigner uuid;
begin
  for cosigner in
    select c.cosigner_user_id
    from public.member_form_cosigners c
    where c.form_id = new.id and c.status = 'accepted' and c.cosigner_user_id is not null
  loop
    perform private.notify_member(cosigner, 'cosign.approved', '{}'::jsonb, 'forms');
  end loop;
  return new;
end $function$;

revoke all on function private.notify_cosigners_on_approve() from public, anon, authenticated;

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
  reaffirmed uuid;
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
      for reaffirmed in
        update public.member_form_cosigners
          set status='reaffirm_needed', responded_at=now()
          where form_id=existing and status='accepted'
          returning cosigner_user_id
      loop
        if reaffirmed is not null then
          perform private.notify_member(reaffirmed, 'cosign.reaffirm', '{}'::jsonb, 'forms');
        end if;
      end loop;
    end if;
  end if;
  return existing;
end;
$function$;

-- 4. S-2: the dedupe resolves its own copy instead of matching two literals.
create or replace function private.notify_mfa_enrolment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    -- One warning per hour per member. The titles are read FROM the copy table
    -- for this key, in every language, so rewording the alert (or adding a
    -- third language) can never silently break the dedupe and re-open the
    -- unenroll -> re-enrol -> verify flood this guard exists to stop.
    if exists (
      select 1 from public.member_notifications n
       where n.user_id = new.user_id
         and n.title in (select c.title from private.notification_copy c where c.key = 'mfa.enrolled')
         and n.created_at > now() - interval '1 hour'
    ) then
      return null;
    end if;

    perform private.notify_member(new.user_id, 'mfa.enrolled', '{}'::jsonb, 'general');
  exception when others then
    raise warning 'mfa enrolment notification failed for %: %', new.user_id, sqlerrm;
  end;
  return null;
end;
$$;

revoke all on function private.notify_mfa_enrolment() from public, anon, authenticated;

-- 5. S-6: the signup seeds. Body verbatim except the three notification rows;
--    the backdated created_at values are preserved via notify_member_at.
create or replace function private.handle_new_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  conversation_one uuid := extensions.gen_random_uuid();
  conversation_two uuid := extensions.gen_random_uuid();
  member_first text := coalesce(nullif(new.raw_user_meta_data ->> 'first_name', ''), 'Darnell');
  member_full text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), 'Darnell Foster');
  member_initials text := coalesce(nullif(new.raw_user_meta_data ->> 'initials', ''), 'DF');
  member_chapter text := nullif(new.raw_user_meta_data ->> 'chapter_id', '');
begin
  if member_chapter is null
     or not exists (select 1 from public.chapters where id = member_chapter) then
    select id into member_chapter from public.chapters where is_default limit 1;
  end if;

  insert into public.member_profiles (id, first_name, full_name, initials, chapter_id)
  values (new.id, member_first, member_full, member_initials, member_chapter);

  -- Localized to the member's stored language. The profile row above is
  -- inserted first, so notify_member_at can resolve it.
  perform private.notify_member_at(new.id, 'seed.ballot', now() - interval '1 hour', '{}'::jsonb, 'general');
  perform private.notify_member_at(new.id, 'seed.caseDeadline', now() - interval '4 hours', '{}'::jsonb, 'general');
  perform private.notify_member_at(new.id, 'seed.chapterUpdate', now() - interval '1 day', '{}'::jsonb, 'general');

  insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at) values
    (conversation_one, new.id, 'Chapter steward', 'CS', now() - interval '9 days', now() - interval '8 days'),
    (conversation_two, new.id, 'Chapter steward', 'CS', now() - interval '23 days', now() - interval '22 days');

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body, read_at, created_at) values
    (conversation_one, new.id, 'steward', 'Chapter steward', 'Now the employer owes a written Step 2 answer, due at the end of next week.', null, now() - interval '8 days'),
    (conversation_two, new.id, 'steward', 'Chapter steward', 'HI', now() - interval '21 days', now() - interval '22 days');

  insert into public.member_cases (user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at) values
    (new.id, 'GR-2026-509', 'Step 2 — discipline', current_date - 29, 'Discipline', 'Article 12 — Discipline · Article 3 — Union Rights and Representation', 'Step 2', 'active', now() - interval '40 days', now() - interval '8 days'),
    (new.id, 'GR-2026-312', 'Telework schedule restored', current_date - 128, 'Telework', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '160 days', now() - interval '120 days'),
    (new.id, 'GR-2025-944', 'Safety equipment issued', current_date - 214, 'Safety', 'Article 16 — Health and Safety', 'Closed', 'resolved', now() - interval '245 days', now() - interval '210 days'),
    (new.id, 'GR-2025-721', 'Scheduling shift corrected', current_date - 284, 'Scheduling', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '310 days', now() - interval '280 days');

  insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
  values ('weingarten', new.id, array[0]);

  insert into public.member_action_log (user_id, action_key, action_kind, occurred_at) values
    (new.id, 'seed-tuesday', 'seed', date_trunc('week', now()) + interval '1 day 12 hours'),
    (new.id, 'seed-thursday', 'seed', date_trunc('week', now()) + interval '3 days 12 hours'),
    (new.id, 'seed-friday', 'seed', date_trunc('week', now()) + interval '4 days 12 hours');
  return new;
end;
$function$;

revoke all on function private.handle_new_member() from public, anon, authenticated;

-- The member_messages and member_cases seed content above is still English.
-- It is fictional demo data rather than product copy, and localizing it means
-- localizing case titles and article names -- a content exercise for the
-- chapter, not a migration. Recorded in SYSTEM-SWEEP.md rather than guessed at.

notify pgrst, 'reload schema';
