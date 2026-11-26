-- Union Demo Org SAMPLE seed: a re-runnable upcoming-event window.
--
-- public.uniondemo_seed_org writes each demo chapter's three upcoming events
-- as `now() + 3..21 days` under fixed ids (`ud-evt-<ck>-nx-1..3`) with
-- `on conflict (id) do nothing`. Once that window passes, the demo
-- organization serves no upcoming event — the member app's RSVP controls
-- (apps/mobile/src/features/LiveLivedInScreens.tsx:349) render only for a
-- meeting whose starts_at is in the future — and re-running the seed cannot
-- re-anchor the rows, because their ids already exist.
--
-- This function adds a fresh window instead of moving the old one: it only
-- inserts, under new ids stamped with the call date, and never updates or
-- deletes a row. The ids keep the `ud-evt-` prefix that the production
-- cleanup contract owns (scripts/lib/production-cleanup-content-invariant.mjs),
-- and a chapter is eligible only if private.uniondemo_chapters already maps
-- it, so no chapter outside the demo organization can be touched. The guard
-- is private.uniondemo_authorize, the same service_role + SAMPLE-project-ref
-- + confirmation-token check every other Union Demo entry point uses, so this
-- migration seeds nothing by itself on any project.
--
-- public.member_events is a reviewed case-graph relation
-- (scripts/account-case-graph-review.json), so every function that writes it
-- is a case-graph writer and has to take private.lock_case_graph as its first
-- statement, before any declaration initializer or authorization read. That is
-- the gate order the account-deletion, retention and messaging transactions
-- already hold (private.lock_case_graph takes the message-lifecycle gate and
-- the (509, 700) advisory lock in turn), and taking it later is what lets two
-- transactions cycle. The outer block below therefore carries only the gate,
-- and the declarations with initializers live in the nested block -- the same
-- shape the other Union Demo entry points use
-- (supabase/migrations/20260927110100_uniondemo_production_removal_window_relock.sql).

begin;

create or replace function public.uniondemo_topup_upcoming_events(
  p_chapter_ids text[],
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '60s'
as $$

begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  stamp text := pg_catalog.to_char(pg_catalog.now(), 'YYYYMMDD');
  inserted integer := 0;
  eligible text[];
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  if p_chapter_ids is null or pg_catalog.array_length(p_chapter_ids, 1) is null then
    raise exception 'union demo upcoming-event top-up needs at least one chapter id';
  end if;
  select pg_catalog.array_agg(distinct m.chapter_id) into eligible
    from private.uniondemo_chapters m
   where m.chapter_id = any(p_chapter_ids);
  if eligible is null then
    raise exception 'none of those chapters belong to the union demo organization';
  end if;

  insert into public.member_events (
    id, title, starts_at, location, summary, check_in_code,
    order_index, chapter_id, is_public, is_public_across_agencies, reminder_notice_sent_at)
  select
    'ud-evt-' || eligible_chapter.chapter_id || '-up' || stamp || '-' || slot.n::text,
    slot.title,
    pg_catalog.now() + ((slot.in_days * 24 + slot.at_hour) || ' hours')::interval,
    slot.location,
    slot.summary,
    'SG-' || pg_catalog.upper(pg_catalog.substr(pg_catalog.md5(eligible_chapter.chapter_id || stamp || slot.n::text), 1, 8)),
    (select coalesce(pg_catalog.max(existing.order_index), 0)
       from public.member_events existing
      where existing.chapter_id = eligible_chapter.chapter_id) + slot.n,
    eligible_chapter.chapter_id,
    slot.is_public,
    false,
    null
  from pg_catalog.unnest(eligible) as eligible_chapter(chapter_id)
  cross join (values
    (1, 'Chapter meeting', 3, 18,
     'Chapter hall + Zoom', 'Bargaining survey vote and contract update.', false),
    (2, 'New-steward training', 6, 17,
     'Union office · Training room', 'Module 3 — Weingarten rights and Step 1 practice.', true),
    (3, 'Caseload-relief rally', 11, 16,
     'State House steps', 'Statewide action for enforceable caseload caps.', true)
  ) as slot(n, title, in_days, at_hour, location, summary, is_public)
  on conflict (id) do nothing;
  get diagnostics inserted = row_count;

  return pg_catalog.jsonb_build_object(
    'event', 'uniondemo_upcoming_events_topup',
    'stamp', stamp,
    'requested', p_chapter_ids,
    'chapters', eligible,
    'inserted', inserted);
end;
end;
$$;

revoke all on function public.uniondemo_topup_upcoming_events(text[], text, text)
  from public, anon, authenticated;
grant execute on function public.uniondemo_topup_upcoming_events(text[], text, text)
  to service_role;

commit;
