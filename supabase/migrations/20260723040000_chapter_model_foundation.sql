-- REQ-UG-FULL-DEPTH-20260723 PR1: chapter/org model foundation.
--
-- 'Chapter' lands as a three-tier concept:
--   1. Member self-data stays self-scoped — no chapter predicate is added to
--      any member self-policy, so the 100k-row stress dataset is untouched.
--   2. Steward cross-member reads become a real least-privilege boundary: a
--      steward role row with a chapter_id sees only that chapter; a NULL
--      chapter_id means org-wide, which is exactly today's behavior, so every
--      existing steward account is behavior-identical after this migration.
--   3. Advisor/VP/coordinator analytics stay aggregate-only DEFINER RPCs and
--      land in later PRs — this migration opens no raw-row surface for them.
--
-- Backfill is deliberately metadata-only: adding chapter_id with a constant
-- default is an atthasmissing catalog change in Postgres 11+ (no table
-- rewrite, no dead tuples), so all existing profiles read back 'wor' with no
-- data-modifying statement.
--
-- APPLY CONTRACT (live database): sections 1-9 run as ONE transaction;
-- section 10 (FK VALIDATE, then the chapter index) runs as SEPARATE calls —
-- VALIDATE in its own transaction so its full scan holds only SHARE UPDATE
-- EXCLUSIVE, and the live index built with CREATE INDEX CONCURRENTLY so
-- writes never block. Running this whole file as a single transaction would
-- hold the ADD COLUMN's ACCESS EXCLUSIVE lock across both full scans on the
-- hottest table in the app. Section 10's plain statements exist for
-- fresh/empty databases, where those locks are moot.

-- 1. Chapters reference table -----------------------------------------------

create table public.chapters (
  id text primary key,
  name text not null unique,
  region text,
  is_default boolean not null default false,
  order_index integer not null,
  created_at timestamptz not null default now()
);

-- Exactly one default chapter at any time; handle_new_member and the profile
-- column default both lean on it.
create unique index chapters_one_default_idx on public.chapters (is_default) where is_default;

insert into public.chapters (id, name, is_default, order_index) values
  ('wor', 'Cedar Ridge Care Services', true, 1),
  ('bos', 'Pine Harbor Care Services', false, 2),
  ('spr', 'Maple Crossing Care Services', false, 3),
  ('law', 'Willow Bend Care Services', false, 4),
  ('nbd', 'Hemlock Bay Care Services', false, 5);

alter table public.chapters enable row level security;

create policy chapters_select_all on public.chapters
  for select to authenticated using (true);

revoke all on public.chapters from anon, authenticated;
grant select on public.chapters to authenticated;

-- 2. member_profiles.chapter_id ---------------------------------------------

alter table public.member_profiles
  add column chapter_id text default 'wor';

alter table public.member_profiles
  add constraint member_profiles_chapter_id_fkey
  foreign key (chapter_id) references public.chapters(id) not valid;

-- Validation and the chapter index land in section 10 (phase B/C) so their
-- full scans never run under this section's ACCESS EXCLUSIVE lock.

-- 3. member_roles.chapter_id + the completed role model ----------------------
-- NULL chapter_id = org-wide scope (the legacy-preserving sentinel). The role
-- CHECK widens to the full five-hat model; constraint name verified against
-- pg_constraint on the live project before this drop.

alter table public.member_roles
  add column chapter_id text references public.chapters(id) on delete set null;

alter table public.member_roles
  drop constraint member_roles_role_check;

alter table public.member_roles
  add constraint member_roles_role_check
  check (role in ('steward', 'coordinator', 'advisor', 'admin', 'vp'));

-- 4. Generalized staff scope helper -----------------------------------------
-- One DEFINER helper for every chapter-scoped cross-member surface: steward
-- policies call it with 'steward' here; the coordinator plane reuses it with
-- 'coordinator' in a later PR. It only ever answers "can the CALLER see this
-- target", derived from the caller's own role rows, so it leaks nothing a
-- caller does not already know. security definer so policy evaluation on
-- member_roles/member_profiles can never recurse.

create function public.staff_can_see_user(p_target uuid, p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.member_roles r
    where r.user_id = (select auth.uid())
      and r.role = p_role
      and (r.chapter_id is null
           or r.chapter_id = (select p.chapter_id
                              from public.member_profiles p
                              where p.id = p_target))
  );
$$;

-- Cosigner rows carry only form_id, so the steward policy on them resolves
-- the form owner through a DEFINER hop (the caller's own member_forms RLS
-- must not decide policy outcomes on a different table). coalesce keeps a
-- missing form indistinguishable from an out-of-scope one — this function is
-- callable by any authenticated user and must not be a form-existence oracle.
create function public.form_owner_in_steward_scope(p_form_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select public.staff_can_see_user(f.user_id, 'steward')
     from public.member_forms f
     where f.id = p_form_id),
    false);
$$;

-- 5. New-member chapter resolution ------------------------------------------
-- Body reproduced verbatim from 20260720191847 plus chapter resolution: only
-- a real chapter slug in signup metadata is honored; absent/empty/unknown
-- values fall back to the default chapter. The stress seeder sends no
-- chapter_id key, so synthetic users land on the default chapter unchanged.

create or replace function private.handle_new_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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

  insert into public.member_notifications (user_id, title, body, created_at) values
    (new.id, 'Ballot closes soon', 'Cast your vote on the chapter action budget priorities.', now() - interval '1 hour'),
    (new.id, 'Case deadline', 'Your Step 2 response deadline needs attention.', now() - interval '4 hours'),
    (new.id, 'New chapter update', 'The latest fictional chapter broadcast is ready.', now() - interval '1 day');

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
$$;

-- 6. Steward read policies route through the chapter gate ---------------------
-- Behavior-preserving drop+recreate: every current steward role row has a
-- NULL chapter_id after step 3, and the helper's NULL branch grants exactly
-- the old org-wide visibility.

drop policy member_steward_requests_select_steward on public.member_steward_requests;
create policy member_steward_requests_select_steward on public.member_steward_requests
  for select to authenticated using (public.staff_can_see_user(user_id, 'steward'));

drop policy member_conversations_select_steward on public.member_conversations;
create policy member_conversations_select_steward on public.member_conversations
  for select to authenticated using (public.staff_can_see_user(user_id, 'steward'));

drop policy member_messages_select_steward on public.member_messages;
create policy member_messages_select_steward on public.member_messages
  for select to authenticated using (public.staff_can_see_user(user_id, 'steward'));

drop policy member_profiles_select_steward on public.member_profiles;
create policy member_profiles_select_steward on public.member_profiles
  for select to authenticated using (public.staff_can_see_user(id, 'steward'));

drop policy member_forms_select_steward on public.member_forms;
create policy member_forms_select_steward on public.member_forms
  for select to authenticated
  using (status in ('submitted', 'in_review') and public.staff_can_see_user(user_id, 'steward'));

drop policy member_form_cosigners_select_steward on public.member_form_cosigners;
create policy member_form_cosigners_select_steward on public.member_form_cosigners
  for select to authenticated
  using (status = 'accepted'
         and public.form_is_alliance_reviewable(form_id)
         and public.form_owner_in_steward_scope(form_id));

-- 7. Steward write RPCs verify the target is in scope -------------------------
-- The scope predicate folds into the existing row lookups so an out-of-scope
-- target raises the same error as a nonexistent one — no existence oracle
-- (house rule since 20260723010000). triage body otherwise reproduced from
-- 20260722001108; reply body from the 20260722002517 multiline corrective.

create or replace function public.triage_steward_request(p_request_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  updated integer;
  row_out record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if p_action = 'acknowledge' then
    update public.member_steward_requests
    set status = 'acknowledged', acknowledged_at = now(), handled_by = caller
    where id = p_request_id and status = 'requested'
      and public.staff_can_see_user(user_id, 'steward');
  elsif p_action = 'close' then
    update public.member_steward_requests
    set status = 'closed', closed_at = now(), handled_by = caller
    where id = p_request_id and status in ('requested', 'acknowledged')
      and public.staff_can_see_user(user_id, 'steward');
  else
    raise exception 'unknown triage action' using errcode = '22023';
  end if;

  get diagnostics updated = row_count;
  if updated = 0 then
    raise exception 'request not found or already past this step' using errcode = '22023';
  end if;

  select id, status, acknowledged_at, closed_at into row_out
  from public.member_steward_requests where id = p_request_id;

  return pg_catalog.jsonb_build_object(
    'id', row_out.id,
    'status', row_out.status,
    'acknowledgedAt', row_out.acknowledged_at,
    'closedAt', row_out.closed_at
  );
end;
$$;

create or replace function public.send_steward_reply(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''));
  convo record;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  if clean_body = '' or pg_catalog.char_length(clean_body) > 4000 then
    raise exception 'reply must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  if pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    raise exception 'reply contains unsupported control characters' using errcode = '22023';
  end if;

  select id, user_id into convo
  from public.member_conversations
  where id = p_conversation_id
    and public.staff_can_see_user(user_id, 'steward');

  if not found then
    raise exception 'conversation not found' using errcode = '22023';
  end if;

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body)
  values (convo.id, convo.user_id, 'steward', 'Chapter steward', clean_body);

  update public.member_conversations set updated_at = now() where id = convo.id;

  return pg_catalog.jsonb_build_object('conversationId', convo.id);
end;
$$;

-- 8. Chapter-scoped members-covered count for the steward desk KPI -----------
-- Counts only, never rows. An org-wide steward (NULL chapter) counts every
-- profile; a scoped steward counts their chapter through
-- member_profiles_chapter_idx.

create function public.get_steward_chapter_member_count()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  scope_chapter text;
  result integer;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;

  select r.chapter_id into scope_chapter
  from public.member_roles r
  where r.user_id = caller and r.role = 'steward'
  limit 1;

  if scope_chapter is null then
    select count(*)::integer into result from public.member_profiles;
  else
    select count(*)::integer into result
    from public.member_profiles p
    where p.chapter_id = scope_chapter;
  end if;

  return result;
end;
$$;

-- 9. Grants -------------------------------------------------------------------

-- chapter_id is the steward-scoping key, so it must never be member-self-
-- writable: the data subject cannot choose which steward's scope they sit in.
-- The blanket self-update grant narrows to exactly the profile and settings
-- columns the app writes; id/created_at/updated_at ride along into the denied
-- set (updated_at is trigger-set, unaffected by column grants).
revoke update on public.member_profiles from authenticated;
grant update (first_name, full_name, initials, role_line, member_since, language, notification_prefs)
  on public.member_profiles to authenticated;

revoke all on function public.staff_can_see_user(uuid, text) from public, anon;
revoke all on function public.form_owner_in_steward_scope(uuid) from public, anon;
revoke all on function public.get_steward_chapter_member_count() from public, anon;
revoke all on function public.triage_steward_request(uuid, text) from public, anon;
revoke all on function public.send_steward_reply(uuid, text) from public, anon;
revoke all on function private.handle_new_member() from public, anon, authenticated;

grant execute on function public.staff_can_see_user(uuid, text) to authenticated;
grant execute on function public.form_owner_in_steward_scope(uuid) to authenticated;
grant execute on function public.get_steward_chapter_member_count() to authenticated;
grant execute on function public.triage_steward_request(uuid, text) to authenticated;
grant execute on function public.send_steward_reply(uuid, text) to authenticated;

-- 10. Phase B/C: FK validation + chapter index --------------------------------
-- LIVE APPLY: each statement below runs as its OWN Management API call, per
-- the apply contract in the header — VALIDATE alone in a transaction, and the
-- index built with CREATE INDEX CONCURRENTLY instead of this plain form.

alter table public.member_profiles validate constraint member_profiles_chapter_id_fkey;

create index member_profiles_chapter_idx on public.member_profiles(chapter_id);
