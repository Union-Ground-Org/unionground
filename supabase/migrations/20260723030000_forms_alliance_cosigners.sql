-- Phase 4b: Alliance co-signers (Forms P4b, deferred item from design §10).
-- PR-C1 backend. This introduces the app's FIRST cross-member read of another
-- member's grievance PII, deliberately narrow: only an ACCEPTED co-signer of an
-- 'alliance_grievance' form may read that one form, in full. Consent is
-- explicit, revocable (withdraw), and re-affirmed after edits (D4). Every write
-- goes through security-definer RPCs; clients get SELECT only. Additive /
-- non-destructive.
--
-- Design + pre-mortem: specs/2026-07-23-forms-alliance-cosigners-design.md
-- Owner-locked decisions: accepted co-signer sees FULL answers; the feature is
-- 'alliance_grievance'-only.
--
-- Two structural hazards engineered around here:
--  * Mutual RLS recursion — member_forms references member_form_cosigners and
--    vice-versa. Every cross-table check runs through a SECURITY DEFINER helper
--    that bypasses RLS on the inner read, breaking the cycle (Postgres would
--    otherwise raise 42P17 infinite recursion).
--  * Membership oracle — resolving and PERSISTING the invitee's user_id at
--    invite time would let the filer read their own invite rows and learn who
--    is/isn't a member. cosigner_user_id is left NULL until the invitee accepts;
--    the id is resolved only locally, only to send the invite notification.

-- 1. Co-signer ledger -------------------------------------------------------
create table if not exists public.member_form_cosigners (
  id               uuid primary key default extensions.gen_random_uuid(),
  form_id          uuid not null references public.member_forms(id) on delete cascade,
  invited_email    text not null check (pg_catalog.length(invited_email) between 3 and 320),
  cosigner_user_id uuid references auth.users(id) on delete set null,
  status           text not null default 'invited'
    check (status in ('invited','accepted','declined','reaffirm_needed','withdrawn')),
  invited_by       uuid not null references auth.users(id) on delete cascade,
  invited_at       timestamptz not null default now(),
  responded_at     timestamptz,
  unique (form_id, invited_email)
);
create index if not exists member_form_cosigners_user_status_idx
  on public.member_form_cosigners (cosigner_user_id, status);
create index if not exists member_form_cosigners_form_idx
  on public.member_form_cosigners (form_id);

alter table public.member_form_cosigners enable row level security;
revoke all on public.member_form_cosigners from anon, authenticated;
grant select on public.member_form_cosigners to authenticated;  -- definer RPCs are the only writers

-- 2. RLS anti-recursion helpers (SECURITY DEFINER) --------------------------
-- Each answers a yes/no about the CURRENT caller. Being definer, their internal
-- reads bypass RLS, so a policy on table A can consult table B without
-- re-entering table B's (A-referencing) policies.
create or replace function public.form_is_owned_by_caller(p_form_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.member_forms
                 where id = p_form_id and user_id = (select auth.uid()));
$$;

create or replace function public.caller_is_accepted_cosigner(p_form_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.member_form_cosigners
                 where form_id = p_form_id
                   and cosigner_user_id = (select auth.uid())
                   and status = 'accepted');
$$;

create or replace function public.form_is_alliance_reviewable(p_form_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.member_forms
                 where id = p_form_id
                   and template_key = 'alliance_grievance'
                   and status in ('submitted','in_review'));
$$;

revoke all on function public.form_is_owned_by_caller(uuid) from public, anon;
revoke all on function public.caller_is_accepted_cosigner(uuid) from public, anon;
revoke all on function public.form_is_alliance_reviewable(uuid) from public, anon;
grant execute on function public.form_is_owned_by_caller(uuid) to authenticated;
grant execute on function public.caller_is_accepted_cosigner(uuid) to authenticated;
grant execute on function public.form_is_alliance_reviewable(uuid) to authenticated;

-- 3. RLS policies -----------------------------------------------------------
-- Filer sees every invite on their own form (their status list).
drop policy if exists member_form_cosigners_select_filer on public.member_form_cosigners;
create policy member_form_cosigners_select_filer on public.member_form_cosigners
  for select to authenticated
  using (public.form_is_owned_by_caller(form_id));

-- Invitee sees ONLY their own invite row. Pre-accept cosigner_user_id is null,
-- so the match is by email (auth.email() is populated from the JWT in this
-- project); post-accept it also matches the stamped id.
drop policy if exists member_form_cosigners_select_invitee on public.member_form_cosigners;
create policy member_form_cosigners_select_invitee on public.member_form_cosigners
  for select to authenticated
  using (cosigner_user_id = (select auth.uid())
         or pg_catalog.lower(invited_email) = pg_catalog.lower(coalesce((select auth.email()), '')));

-- Steward reviewing the grievance sees ACCEPTED co-signers only, and only while
-- the form is in a steward-readable review state (mirrors
-- member_forms_select_steward). Pending/declined/withdrawn invites stay hidden.
drop policy if exists member_form_cosigners_select_steward on public.member_form_cosigners;
create policy member_form_cosigners_select_steward on public.member_form_cosigners
  for select to authenticated
  using (status = 'accepted'
         and public.member_has_role(array['steward'])
         and public.form_is_alliance_reviewable(form_id));

-- The HIGH-risk cross-member grievance read: an accepted co-signer may read the
-- one alliance_grievance form they co-signed, in full. Scoped to template +
-- accepted + exact form; pre-accept reads are impossible; withdraw / reaffirm
-- revokes in the same transaction (caller_is_accepted_cosigner turns false).
drop policy if exists member_forms_select_cosigner on public.member_forms;
create policy member_forms_select_cosigner on public.member_forms
  for select to authenticated
  using (template_key = 'alliance_grievance' and public.caller_is_accepted_cosigner(id));

-- 4. RPCs (all SECURITY DEFINER, search_path='', authenticated-only) ---------

-- invite_cosigner: caller invites another member by exact email. Uniform
-- success whether or not the email maps to a member (D1). The member's id is
-- resolved LOCALLY for notification only and never persisted at invite time
-- (persisting it would let the filer enumerate membership from their own read).
create or replace function public.invite_cosigner(p_form_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  norm text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  frec record;
  target uuid;
  existing record;
  active_count integer;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;

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
    insert into public.member_notifications (user_id, title, body)
    values (target, 'Co-sign invitation',
      'A member invited you to co-sign an alliance grievance. Open Forms to review and accept or decline.');
  end if;

  return pg_catalog.jsonb_build_object('status','invited');  -- uniform (D1)
end $$;

-- respond_to_cosign: invitee accepts or declines. Accepting stamps their id
-- (consensual disclosure) and unlocks the full read via RLS + notifies the
-- filer. Declining leaves cosigner_user_id null (does not disclose the
-- decliner's membership to the filer beyond the status they already see).
create or replace function public.respond_to_cosign(p_form_id uuid, p_accept boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  new_status text;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
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
    insert into public.member_notifications (user_id, title, body)
    values (inv.invited_by, 'Co-signer accepted',
      'A member accepted your invitation to co-sign your alliance grievance.');
  end if;
  return pg_catalog.jsonb_build_object('status', new_status);
end $$;

-- cosign_invite_preview: pre-accept view for the invitee — the one-line issue
-- summary + filer name ONLY (D2). Never the narrative / remedy / affected PII;
-- those unlock only after accept (then via the member_forms_select_cosigner
-- RLS read, not this RPC).
create or replace function public.cosign_invite_preview(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  frec record;
  filer_name text;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
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
end $$;

-- withdraw_cosign: an accepted co-signer revokes consent (D7). RLS read is
-- revoked in the same transaction. Notifies the filer.
create or replace function public.withdraw_cosign(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  inv record;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  select id, invited_by into inv
    from public.member_form_cosigners
    where form_id = p_form_id and cosigner_user_id = caller and status = 'accepted'
    for update limit 1;
  if inv.id is null then
    raise exception 'you have no active co-signature on this form' using errcode='22023';
  end if;
  update public.member_form_cosigners
    set status = 'withdrawn', responded_at = now() where id = inv.id;
  insert into public.member_notifications (user_id, title, body)
  values (inv.invited_by, 'Co-signer withdrew',
    'A co-signer withdrew from your alliance grievance.');
  return pg_catalog.jsonb_build_object('status','withdrawn');
end $$;

revoke all on function public.invite_cosigner(uuid, text) from public, anon;
revoke all on function public.respond_to_cosign(uuid, boolean) from public, anon;
revoke all on function public.cosign_invite_preview(uuid) from public, anon;
revoke all on function public.withdraw_cosign(uuid) from public, anon;
grant execute on function public.invite_cosigner(uuid, text) to authenticated;
grant execute on function public.respond_to_cosign(uuid, boolean) to authenticated;
grant execute on function public.cosign_invite_preview(uuid) to authenticated;
grant execute on function public.withdraw_cosign(uuid) to authenticated;

-- 5. save_form_draft: re-affirm hook (D4, bait-and-switch) ------------------
-- Reproduced from 20260722170000_member_forms.sql with one addition: editing an
-- alliance grievance that has ACCEPTED co-signers resets them to
-- reaffirm_needed and notifies them — a co-signer affirmed specific text, so
-- their name must not silently carry onto edited answers. Only fires when the
-- answers actually changed.
create or replace function public.save_form_draft(p_template_key text, p_answers jsonb, p_step int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_template_key not in ('fmla_self','fmla_family','grievance','alliance_grievance','non_selection','alt_work','service_request')
    then raise exception 'invalid template' using errcode='22023'; end if;
  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000
    then raise exception 'answers too large' using errcode='22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-form-'||caller::text||'-'||p_template_key, 509));
  select id, answers into existing, prev_answers from public.member_forms
    where user_id=caller and template_key=p_template_key and status in ('draft','returned')
    order by updated_at desc limit 1;
  if existing is null then
    insert into public.member_forms (user_id, template_key, answers, step)
      values (caller, p_template_key, clean, least(greatest(coalesce(p_step,0),0),50))
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
end $$;
revoke all on function public.save_form_draft(text,jsonb,int) from public, anon;
grant execute on function public.save_form_draft(text,jsonb,int) to authenticated;

-- 6. Progress notice on approval -------------------------------------------
-- When an alliance grievance is approved, tell its accepted co-signers ("...
-- notified as it progresses"). A trigger keeps the PR2 steward RPCs untouched.
create or replace function private.notify_cosigners_on_approve()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.member_notifications (user_id, title, body)
    select c.cosigner_user_id, 'Group workplace issue approved',
      'An alliance grievance you co-signed was approved by a steward.'
    from public.member_form_cosigners c
    where c.form_id = new.id and c.status = 'accepted' and c.cosigner_user_id is not null;
  return new;
end $$;

drop trigger if exists trg_notify_cosigners_on_approve on public.member_forms;
create trigger trg_notify_cosigners_on_approve
  after update of status on public.member_forms
  for each row
  when (new.template_key = 'alliance_grievance' and new.status = 'approved' and old.status is distinct from 'approved')
  execute function private.notify_cosigners_on_approve();
