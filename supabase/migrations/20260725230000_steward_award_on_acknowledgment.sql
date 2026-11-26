-- Steward award pays on steward INTERACTION, not on self-serve submission
-- (REQ-UG-STEWARD-REQUEST-ECONOMY-20260725).
--
-- VECTOR
-- member_steward_requests INSERT is client-granted (a deliberate survivor of
-- the 20260725120000 sole-writer sweep), and the 'steward' branch of
-- private.award_member_points backed a key on the mere EXISTENCE of a
-- caller-owned request row. "Forging the row" therefore cost one PostgREST
-- call: 3 throwaway requests a week that no steward ever touches earned the
-- full honest-path ceiling (3 x 10 pts). Bounded and identical to UI spam
-- (LOW), but it pays a premium for a free self-serve action. Live pre-apply
-- probe (rolled back): a pure self-serve submission minted 10 pts today.
--
-- Award points when staff acknowledge the action.
-- 1. private.award_member_points loses its 'steward' branch — the 8th
--    generation, GENERATED SERVER-SIDE via replace(pg_get_functiondef(...))
--    with an exactly-once assertion, never hand-transcribed:
--      pre-change  md5 df3ab8fcaacbc6fd79769135ba42d2d8  (7th gen as LIVE)
--      post-change md5 b8e8bd02f9799ccb57f5b69e1a23e943  (this file's body)
--    A member-minted 'steward-' action-log key is now never backed; the log
--    row a current bundle writes at submission time becomes audit-only (the
--    20260725120000 header's "the point key needs the row" rationale for
--    keeping the INSERT grant is superseded: the grant now survives for the
--    audit row and the triage queue itself).
-- 2. LEDGER SETTLE across the key-format boundary (review catch, HIGH: the
--    20260725150000 backfill settled member_action_log ONLY — the ledger's
--    historical steward payments still carry OLD-format keys
--    'steward-<lesson>-<ms>', which can never string-collide with this
--    trigger's 'steward-<request uuid>' keys, so the first ack of an
--    already-paid request would pay it a SECOND time). Legacy-format steward
--    ledger events are rekeyed 1:1 onto their owner's request rows in
--    deterministic order (oldest event onto oldest row), so the trigger's
--    on-conflict dedupe genuinely settles history. Leftovers are correct by
--    construction: a legacy event with no surviving row keeps its old key
--    (no row exists to double-pay on), and an unpaired row was never paid
--    (it pays on its first real interaction — exactly the new rule).
-- 3. private.award_steward_interaction() — an AFTER UPDATE trigger on
--    member_steward_requests fires on the status transition into
--    'acknowledged' or 'closed' (both are real steward interactions; triage
--    allows requested -> closed directly) and mints DIRECTLY into
--    member_point_events, reading points and weekly_cap from the same
--    member_point_rules row as every other kind, cap enforced AT INTERACTION
--    TIME, 'steward-' || id key deduped by the (user_id, action_key) unique.
--      award_steward_interaction body md5 d0b27017bef19ef69fa42bf9834f5bda
--    (live-rendered, captured via a rolled-back CREATE on the target before
--    this file was applied; tests/steward-award-on-ack.test.js chains the
--    db-contract bodyMd5 to this line.)
-- 4. The member_point_rules label stops promising submission-time pay: the
--    seeded 'Request steward support' (rendered verbatim by RewardsView's
--    "Ways to earn" and indexed by search) becomes
--    'A steward answers your request', and src/data/fallback.js mirrors it
--    so demo/offline rendering does not drift.
--
-- SELF-DEAL GUARD: a steward is also a member, and triage_steward_request
-- lets a steward triage their OWN request (they are in their own chapter's
-- scope), which would have kept the exact self-serve mint this migration
-- closes — restricted to steward accounts. The trigger refuses to pay when
-- new.handled_by = new.user_id (triage always stamps handled_by = caller).
-- A NULL handled_by falls through to pay: refusing then would let a future
-- write path silently zero the economy, and NULL means "no actor recorded",
-- not "self-dealt".
--
-- CAP SEMANTICS (accepted design, documented on review): interactions above
-- the weekly cap forfeit, exactly like every other action kind — the mint
-- moment moved, the forfeit rule did not. Because the WHEN clause also fires
-- on acknowledged -> closed, a close landing in a later week is an
-- INCIDENTAL retry for a request whose ack hit the cap; do not "fix" the
-- WHEN clause to ack-only without deciding that retry away consciously.
--
-- WHY NOT the other mechanisms / why not action_log re-mint:
--   * (a) partial-unique dedupe still pays for untouched requests (a member
--     with 3 distinct lessons keeps the full mint) and 409s the UI.
--   * (c) RPC + revoke is an expand/contract rollout for a LOW item; the
--     trigger achieves the acceptance with zero client-flow change.
--   * Re-minting through member_action_log at ack time CANNOT work: the
--     (user_id, action_key) unique on the log means a submission-time mint
--     (every current bundle writes one) permanently blocks the ack-time
--     insert, so the honest path would never pay. Direct-to-ledger is the
--     only shape where "steward acted" always pays exactly once.
--
-- WRITE PATHS that can fire the trigger: triage_steward_request is the sole
-- ack/close path (steward-gated definer RPC; the table has UPDATE granted but
-- NO RLS update policy, so a member cannot flip the status themselves —
-- probed live).
--
-- ROLLBACK (copy-paste; restores submission-time pay):
--   drop trigger if exists member_steward_requests_award_on_ack on public.member_steward_requests;
--   drop function if exists private.award_steward_interaction();
--   update public.member_point_rules set label = 'Request steward support' where action_kind = 'steward';
--   -- then re-apply the 7th-gen award_member_points body from
--   -- 20260725150000_points_mint_rebind_message_steward.sql. HONESTY NOTE:
--   -- that file's body renders md5 8a91db447835c847e2c635ad0f03d2ef, NOT the
--   -- df3ab8fc... this file was generated from — the LIVE 7th gen carried
--   -- cosmetically different comments than the committed file (pre-existing
--   -- applied-vs-committed drift on 150000; the comment-stripped executable
--   -- text is identical). After a file-based rollback, expect 8a91db44...
--   -- The ledger rekey needs no reversal: old and new keys are equivalent
--   -- settled spellings of the same historical payment.

set local lock_timeout = '5s';

-- Machine-enforced ordering: the 7th-gen function this file's body was
-- generated FROM must be present (a fresh-create here would silently get
-- default PUBLIC EXECUTE and the wrong baseline).
do $$
begin
  if pg_catalog.to_regprocedure('private.award_member_points()') is null then
    raise exception 'apply 20260721223851 + 20260725150000 (points engine) first'
      using errcode = '42883';
  end if;
end
$$;

CREATE OR REPLACE FUNCTION private.award_member_points()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  rule record;
  backed boolean := false;
  awarded_this_week integer;
  award_points integer;
  v_template text;
begin
  if new.action_kind = 'seed' then
    return new;
  end if;
  select points, weekly_cap into rule
  from public.member_point_rules
  where action_kind = new.action_kind and points > 0;
  if not found then
    return new;
  end if;
  award_points := rule.points;
  if new.action_kind = 'vote' then
    backed := pg_catalog.left(new.action_key, 5) = 'vote-' and exists (
      select 1 from public.member_ballot_votes
      where user_id = new.user_id and ballot_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'survey' then
    backed := pg_catalog.left(new.action_key, 7) = 'survey-' and exists (
      select 1 from public.member_survey_responses
      where user_id = new.user_id and survey_id = pg_catalog.substr(new.action_key, 8));
  elsif new.action_kind = 'rights' then
    backed := pg_catalog.left(new.action_key, 7) = 'rights-' and exists (
      select 1 from public.member_rights_progress
      where user_id = new.user_id and lesson_id = pg_catalog.substr(new.action_key, 8)
        and pg_catalog.cardinality(completed_steps) > 0);
  elsif new.action_kind = 'case' then
    backed := pg_catalog.left(new.action_key, 5) = 'case-' and exists (
      select 1 from public.member_cases
      where user_id = new.user_id and reference = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'message' then
    -- Rebound: the key is the caller's OWN message row id. The sender_kind
    -- filter keeps steward replies and welcome seeds — which carry
    -- user_id = the member — from backing member-minted keys.
    backed := pg_catalog.left(new.action_key, 8) = 'message-' and exists (
      select 1 from public.member_messages
      where user_id = new.user_id and sender_kind = 'member'
        and id::text = pg_catalog.substr(new.action_key, 9));
  -- 'steward' pays at interaction time now (20260725230000): the
  -- acknowledgment trigger on member_steward_requests mints directly into
  -- member_point_events, so a member-minted steward key is never backed here.
  elsif new.action_kind = 'rsvp' then
    backed := pg_catalog.left(new.action_key, 5) = 'rsvp-' and exists (
      select 1 from public.member_event_rsvps
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 6));
  elsif new.action_kind = 'checkin' then
    backed := pg_catalog.left(new.action_key, 8) = 'checkin-' and exists (
      select 1 from public.member_event_checkins
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 9));
  elsif new.action_kind = 'workload' then
    backed := pg_catalog.left(new.action_key, 9) = 'workload-' and exists (
      select 1 from public.member_workload_logs
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 10));
  elsif new.action_kind = 'form' then
    if pg_catalog.left(new.action_key, 5) = 'form-' then
      select template_key into v_template from public.member_forms
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 6)
        and status <> 'draft';
      if found then
        backed := true;
        award_points := private.form_points(v_template);
      end if;
    end if;
  elsif new.action_kind = 'scan' then
    if pg_catalog.left(new.action_key, 5) = 'scan-'
      and pg_catalog.substr(new.action_key, 6, 36) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and pg_catalog.substr(new.action_key, 42, 1) = '-' then
      backed := exists (
        select 1 from public.member_event_checkins
        where scanned_by = new.user_id
          and user_id = (pg_catalog.substr(new.action_key, 6, 36))::uuid
          and event_id = pg_catalog.substr(new.action_key, 43));
    end if;
  end if;
  if not backed then
    return new;
  end if;
  if rule.weekly_cap is not null then
    select count(*) into awarded_this_week
    from public.member_point_events
    where user_id = new.user_id and action_kind = new.action_kind
      and occurred_at >= pg_catalog.date_trunc('week', now());
    if awarded_this_week >= rule.weekly_cap then
      return new;
    end if;
  end if;
  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (new.user_id, new.action_key, new.action_kind, award_points)
  on conflict (user_id, action_key) do nothing;
  return new;
end;
$function$;


-- LEDGER SETTLE (FIX step 2). Runs BEFORE the trigger exists, in the same
-- transaction as everything else. Pre-flight: no new-format steward key can
-- exist in the ledger yet (nothing has ever minted one — the 150000 backfill
-- touched only member_action_log); finding one means this database is in a
-- state this settle was not designed for, so fail loudly instead of pairing
-- around it.
do $$
begin
  if exists (
    select 1 from public.member_point_events
    where action_kind = 'steward'
      and action_key ~ '^steward-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'new-format steward ledger keys already exist — settle by hand before applying 20260725230000';
  end if;
end
$$;

with legacy as (
  select e.id as event_id, e.user_id,
         row_number() over (partition by e.user_id order by e.occurred_at, e.id) as rn
  from public.member_point_events e
  where e.action_kind = 'steward'
    and e.action_key !~ '^steward-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
requests as (
  select r.id as request_id, r.user_id,
         row_number() over (partition by r.user_id order by r.created_at, r.id) as rn
  from public.member_steward_requests r
)
update public.member_point_events e
set action_key = 'steward-' || q.request_id::text
from legacy l
join requests q on q.user_id = l.user_id and q.rn = l.rn
where e.id = l.event_id;

-- FIX step 4: the label stops promising submission-time pay (rendered
-- verbatim by RewardsView "Ways to earn" and the search index; mirrored in
-- src/data/fallback.js in the same change).
update public.member_point_rules
set label = 'A steward answers your request'
where action_kind = 'steward';

-- The interaction mint. SECURITY DEFINER: the UPDATE that fires this comes
-- from the steward's triage RPC, and the ledger insert must not depend on the
-- steward's own RLS view of member_point_events.
create function private.award_steward_interaction()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  rule record;
  awarded_this_week integer;
begin
  if new.handled_by = new.user_id then
    return new;
  end if;
  select points, weekly_cap into rule
  from public.member_point_rules
  where action_kind = 'steward' and points > 0;
  if not found then
    return new;
  end if;
  if rule.weekly_cap is not null then
    select count(*) into awarded_this_week
    from public.member_point_events
    where user_id = new.user_id and action_kind = 'steward'
      and occurred_at >= pg_catalog.date_trunc('week', now());
    if awarded_this_week >= rule.weekly_cap then
      return new;
    end if;
  end if;
  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (new.user_id, 'steward-' || new.id::text, 'steward', rule.points)
  on conflict (user_id, action_key) do nothing;
  return new;
end;
$$;

-- Trigger functions run as the table owner; no client role ever calls this
-- directly, and leaving default PUBLIC EXECUTE would grow the ratcheted
-- knownGaps.publicExecuteOnPrivateFunctions set.
revoke all on function private.award_steward_interaction() from public, anon, authenticated;

create trigger member_steward_requests_award_on_ack
  after update on public.member_steward_requests
  for each row
  when (old.status is distinct from new.status and new.status in ('acknowledged', 'closed'))
  execute function private.award_steward_interaction();

-- CONTRACT COORDINATION (scripts/db-contract.json): award_member_points'
-- steward-branch needles are replaced (message-branch ownership pin +
-- bodyMd5 b8e8bd02f9799ccb57f5b69e1a23e943); a functions entry pins the new
-- interaction fn (self-deal guard, rules select, cap block, ledger dedupe,
-- bodyMd5 chained to this header) with client EXECUTE revoked; an EXCLUSIVE
-- triggers entry pins the WHEN-claused trigger — a second trigger beside it
-- would be a second minting authority on the same row.
-- tests/steward-award-on-ack.test.js pins this file.
