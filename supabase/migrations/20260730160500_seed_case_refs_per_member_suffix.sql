-- REQ-UG-CASE-REF-UNIQUENESS-20260725: the four demo case references that
-- private.handle_new_member seeds were hardcoded literals, so they collided
-- ACROSS members (never within one — UNIQUE (user_id, reference) has held
-- since 20260720191847). The owner picked the per-member-suffix option on
-- 2026-07-30: each new member now gets ONE CSPRNG suffix from
-- private.member_case_suffix() appended to all four bases, e.g.
-- GR-2026-509-31847.
--
-- One suffix per member, not one per row, deliberately: the four bases are
-- distinct, so within-member uniqueness is structural and a random collision
-- can never abort the signup trigger mid-INSERT (the real case path survives
-- suffix collisions with a retry loop; a multi-row VALUES insert cannot).
-- Cross-member uniqueness is probabilistic over a 100,000-value space, which
-- against this deployment's admin-provisioned signup volume is as good as
-- certain — and a collision would merely reproduce, at 1/100,000 the rate,
-- the cosmetic overlap this migration removes.
--
-- The recognizable bases stay in the ref on purpose: the client fallback
-- overlay (src/data/fallback.js) tells the same four demo stories under the
-- bare refs, and the suffixed form keeps that correspondence readable.
--
-- Everything except the member_cases block is byte-identical to the
-- 20260728221544 generation.

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
  seed_ref_suffix text := private.member_case_suffix();
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
    (new.id, 'GR-2026-509-' || seed_ref_suffix, 'Step 2 — discipline', current_date - 29, 'Discipline', 'Article 12 — Discipline · Article 3 — Union Rights and Representation', 'Step 2', 'active', now() - interval '40 days', now() - interval '8 days'),
    (new.id, 'GR-2026-312-' || seed_ref_suffix, 'Telework schedule restored', current_date - 128, 'Telework', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '160 days', now() - interval '120 days'),
    (new.id, 'GR-2025-944-' || seed_ref_suffix, 'Safety equipment issued', current_date - 214, 'Safety', 'Article 16 — Health and Safety', 'Closed', 'resolved', now() - interval '245 days', now() - interval '210 days'),
    (new.id, 'GR-2025-721-' || seed_ref_suffix, 'Scheduling shift corrected', current_date - 284, 'Scheduling', 'Article 7 — Hours of Work', 'Closed', 'resolved', now() - interval '310 days', now() - interval '280 days');

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

-- Backfill: the 12 existing seeded rows (probed 2026-07-30: exactly 3 users x
-- the 4 bare bases; zero member_action_log keys embed these refs, so nothing
-- else moves). One suffix per member, same as the trigger now mints. Guarded
-- to rows whose reference is EXACTLY a bare base, so rerunning is a no-op and
-- real refs (always GR-YYYY-<5 digits>, three-digit tails impossible) are
-- untouchable by construction.
do $$
declare
  seeded_user uuid;
  member_suffix text;
begin
  for seeded_user in
    select distinct user_id from public.member_cases
    where reference in ('GR-2026-509', 'GR-2026-312', 'GR-2025-944', 'GR-2025-721')
  loop
    member_suffix := private.member_case_suffix();
    update public.member_cases
       set reference = reference || '-' || member_suffix
     where user_id = seeded_user
       and reference in ('GR-2026-509', 'GR-2026-312', 'GR-2025-944', 'GR-2025-721');
  end loop;
end;
$$;
