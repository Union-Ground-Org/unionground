-- Rebind the 'message' and 'steward' point-award keys to the rows they pay for.
--
-- WHAT. Seventh generation of private.award_member_points (sixth is
-- 20260723140000). Two branches change; every other branch is carried over
-- byte-identical. public.send_member_message is re-created in the same
-- transaction so the trigger and the sole message-key writer swap atomically.
--
-- WHY. Both branches accepted a CLIENT-CHOSEN trailing counter, so the number
-- of distinct backed keys was unbounded instead of one-per-action:
--
--   message  '^message-(.*)-[0-9]+$' extracted the conversation id and checked
--            only ownership. The trailing digits came from the caller (the RPC
--            uses a clock reading, but members can insert their own
--            member_action_log rows directly), so ONE owned conversation —
--            and every member is seeded with two — backed
--            'message-<conv>-1', '-2', ... Mint bounded only by the weekly
--            cap: 2 pts x 5/week for zero real messages.
--
--   steward  Same forged-counter hole, plus a wildcard: the check was
--            coalesce(lesson_id,'') = coalesce((regexp_match(...))[1],'').
--            regexp_match returns null on a non-matching key, so a member
--            holding any null-lesson request row compared '' = '' — EVERY key
--            of kind 'steward' was backed, matching format or not. 10 pts x
--            3/week for zero real requests. Together: ~40 forged pts/week.
--
-- FIX. The backing entity becomes the row the member actually created, keyed
-- by its uuid primary key: 'message-' || member_messages.id (the caller's own
-- sender_kind='member' row) and 'steward-' || member_steward_requests.id.
-- One row, one backable key, ever — the (user_id, action_key) unique
-- constraint already makes each key single-mint, so forgery now requires
-- forging the row itself, which is the real action being rewarded.
--
--   * sender_kind = 'member' is LOAD-BEARING, not decorative: steward replies
--     (20260722001108) and the welcome seeds (20260720191847) insert
--     member_messages rows with user_id = THE MEMBER and
--     sender_kind = 'steward'. Without the filter, every member could harvest
--     'message-<id>' keys from rows they never wrote — two free keys at
--     signup. RLS already blocks members from inserting non-member kinds, so
--     the filter admits exactly the rows the member authored.
--   * The COLUMN is cast to text; the key is never cast to uuid. A forged
--     non-uuid key therefore compares false instead of raising, and
--     uuid::text's canonical lowercase output pins ONE backed spelling per
--     row (the 20260723140000 scan-branch lesson: uuid casts are
--     case-insensitive, so accepting 'MESSAGE-<UPPER>' spellings would be a
--     re-mint hole).
--
--   * NOTE (steward economy): member_steward_requests INSERT is deliberately
--     still client-granted (20260720191847:376; not in the 20260725120000
--     sole-writer sweep), so a member can create a request row with one
--     PostgREST insert. This migration closes the FORGED-KEY hole — keys with
--     no matching row, and the null-lesson wildcard that backed EVERY steward
--     key — but not the economy question of paying 10 pts for a self-serve
--     action. That residual is exactly the honest-path ceiling (3 requests ×
--     10 pts/week, the weekly cap), identical to legitimate UI use, and is
--     tracked as its own item (REQ-UG-STEWARD-REQUEST-ECONOMY-20260725).
--
-- KEY WRITERS. send_member_message (below) mints from the insert's RETURNING
-- id; the clock_timestamp() suffix is gone because row ids are unique per
-- send, including two sends in one transaction. requestSteward stays a plain
-- client insert (deliberately unconverted — see 20260725000000's SCOPE note)
-- and now logs 'steward-' || the returned row id (src/lib/memberApi.js).
--
-- HISTORICAL SETTLEMENT. The old and new keys are DIFFERENT STRINGS for the
-- SAME underlying row (old: conversation/lesson + a client counter; new: the
-- row's own uuid). Non-collision is therefore a HAZARD here, not the safety it
-- first looks like: the (user_id, action_key) unique constraint cannot dedupe
-- two strings that never match, so on the day the branches change meaning
-- every already-paid member_messages / member_steward_requests row becomes a
-- fresh, unclaimed key its owner could mint with one member_action_log insert
-- (INSERT stays granted by design, 20260725120000). The backfill below settles
-- the back catalogue BEFORE the create-or-replace: with the award trigger
-- disabled it writes the new-format action-log rows (paying nothing), and the
-- unique constraint then makes each historical row permanently unclaimable.
-- Both statements run inside this migration's transaction, so the trigger is
-- never off for concurrent traffic. It is deliberately conservative — it also
-- burns sends that were past the weekly cap and so never paid; those are
-- settled history and are indistinguishable at the trigger from the re-mint.
--
-- ROLLOUT. Applied to prod BEFORE the frontend merges/deploys (same order as
-- #567), so verify:db and the client bundle both see the new generation.
-- Messages have no gap in either order: the RPC is the only live message-key
-- writer and it swaps here atomically. Steward keys from OLD cached bundles
-- ('steward-<lesson>-<ms>') go unbacked once this applies until the browser
-- picks up the new bundle: fail-soft by design — the request row and the
-- action-log row still land, the member just isn't paid for that request.
-- Paying it would mean keeping a forgeable acceptance path alive, which is the
-- hole itself.
--
-- CONTRACT. scripts/db-contract.json gains bodyContains needles on the
-- private.award_member_points() entry pinning the two rebound predicates
-- ("where user_id = new.user_id and sender_kind = 'member'" and the steward
-- row-binding line) against the LIVE definition — the cross-generation
-- backstop the text-pin tests cannot provide. That is why this migration must
-- reach prod before its branch's verify:db runs. The function SET, ACLs, the
-- award trigger's ratcheted publicExecuteOnPrivateFunction gap, and the
-- send_member_message bodyContains needle ('private.mfa_satisfied()') are all
-- unchanged.

set local lock_timeout = '5s';

-- create-or-replace on a NOT-YET-EXISTING function would fresh-create it with
-- default PUBLIC EXECUTE. send_member_message must already exist (20260725000000)
-- with its restricted authenticated,service_role ACL, which create-or-replace
-- then preserves. Guard the invariant machine-side rather than trust apply order.
do $$
begin
  if to_regprocedure('public.send_member_message(uuid, text)') is null then
    raise exception 'precondition: public.send_member_message(uuid, text) must exist before this migration (apply 20260725000000 first)'
      using errcode = '42883';
  end if;
end;
$$;

-- Settle the back catalogue before the branches change meaning (see HISTORICAL
-- SETTLEMENT). Trigger disabled so the backfill pays nothing; the unique
-- (user_id, action_key) then makes each historical row permanently unclaimable.
-- Verified on prod 2026-07-25: all live backing rows were paid under old-format
-- keys and had zero rows under their new-format keys.
alter table public.member_action_log disable trigger member_action_log_award_points;

insert into public.member_action_log (user_id, action_key, action_kind, occurred_at)
select m.user_id, 'message-' || m.id::text, 'message', m.created_at
from public.member_messages m
where m.sender_kind = 'member'
on conflict (user_id, action_key) do nothing;

insert into public.member_action_log (user_id, action_key, action_kind, occurred_at)
select r.user_id, 'steward-' || r.id::text, 'steward', r.created_at
from public.member_steward_requests r
on conflict (user_id, action_key) do nothing;

alter table public.member_action_log enable trigger member_action_log_award_points;

create or replace function private.award_member_points()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
  -- per-kind default; only the 'form' branch overrides it, per template
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
    -- Rebound (header): the key is the caller's OWN message row id. The
    -- sender_kind filter keeps steward replies and welcome seeds — which
    -- carry user_id = the member — from backing member-minted keys.
    backed := pg_catalog.left(new.action_key, 8) = 'message-' and exists (
      select 1 from public.member_messages
      where user_id = new.user_id and sender_kind = 'member'
        and id::text = pg_catalog.substr(new.action_key, 9));
  elsif new.action_kind = 'steward' then
    -- Rebound (header): one backed key per real request row. This also
    -- retires the null-lesson coalesce wildcard that backed every key. The
    -- where-clause is kept on ONE line so scripts/db-contract.json can pin the
    -- ownership + row-binding predicate as a single branch-unique needle.
    backed := pg_catalog.left(new.action_key, 8) = 'steward-' and exists (
      select 1 from public.member_steward_requests
      where user_id = new.user_id and id::text = pg_catalog.substr(new.action_key, 9));
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
    -- prefix-anchored + backed by a caller-owned, non-draft form; the award
    -- amount is this form's template value rather than the flat rule default.
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
    -- 'scan-' || uuid || '-' || event_id, uuid first (see 20260723140000).
    -- The regex runs before the cast in its own statement so a forged key can
    -- never raise from ::uuid, and its [0-9a-f] is deliberately
    -- case-SENSITIVE so only the canonical lowercase spelling is ever backed.
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
$$;

-- The sole live message-key writer, re-created with the row-id key so no
-- deploy ordering can strand a message between key formats. Body otherwise
-- identical to 20260725000000 — including the assurance guard, which is
-- load-bearing (security definer bypasses the restrictive mfa_assurance
-- policy) and is the contract's bodyContains needle for this function.
create or replace function public.send_member_message(p_conversation_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller     uuid := (select auth.uid());
  -- Full ASCII-whitespace set, matching the old client's JS .trim(): a bare
  -- btrim() strips only U+0020, so a body of "\n\n" would clear the 1..4000
  -- length gate and insert (then earn a message point) where .trim() made it "".
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), E' \t\n\r\f\v');
  conv       record;
  sender     text;
  new_id     uuid;
  akey       text;
  awarded    integer;
begin
  -- Assurance term: security definer bypasses the restrictive mfa_assurance
  -- policy, so without this line an aal1 session could write here even though
  -- the same session cannot read the conversation it is writing into.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Mirrors the column CHECK. Raised, never truncated: silently shortening a
  -- member's account of an incident is a data-integrity problem, not a UX one.
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  -- FOR UPDATE serializes concurrent sends on the same thread so the
  -- updated_at touch below can never be lost to an interleaving writer.
  select c.id, c.user_id into conv
  from public.member_conversations c
  where c.id = p_conversation_id
  for update;

  -- No existence oracle: conversations are member-private, so "does not exist"
  -- and "exists but is not yours" collapse to ONE error. A distinct
  -- "not yours" would let a caller holding a guessed uuid confirm that some
  -- other member has a thread with that id.
  if not found or conv.user_id <> caller then
    raise exception 'conversation not found' using errcode = '22023';
  end if;

  -- Derived, not supplied. Falls back to 'Member' when the profile has no
  -- name so the not-null column always has a value.
  select p.full_name into sender from public.member_profiles p where p.id = caller;

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body)
  values (
    p_conversation_id,
    caller,
    'member',
    coalesce(nullif(pg_catalog.btrim(coalesce(sender, '')), ''), 'Member'),
    clean_body)
  returning id into new_id;

  -- The previously-strandable write. The steward desk orders by updated_at
  -- desc limit 100; a message whose conversation was not touched is invisible
  -- to the steward it was written for.
  update public.member_conversations set updated_at = now() where id = p_conversation_id;

  -- The message row id IS the key (header): the trigger backs it only while
  -- a caller-sent row with this id exists, so a backed key can no longer be
  -- manufactured. Per-send uniqueness is inherent in the id — the old
  -- clock_timestamp() suffix existed only to keep two same-transaction sends
  -- from colliding on (user_id, action_key), and ids never collide.
  akey := 'message-' || new_id::text;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'message')
  on conflict (user_id, action_key) do nothing;

  -- Read the award back from the ledger. 'message' is capped at 5/week: past
  -- the cap the AFTER INSERT trigger writes nothing and this correctly
  -- returns 0, where reporting member_point_rules.points would have lied.
  select e.points into awarded
  from public.member_point_events e
  where e.user_id = caller and e.action_key = akey;

  return pg_catalog.jsonb_build_object('messageId', new_id, 'awardedPoints', coalesce(awarded, 0));
end;
$$;

-- Signature and ACLs are unchanged (create-or-replace preserves both), so
-- PostgREST needs no new shape — the notify is belt-and-braces consistency
-- with the sibling migrations.
notify pgrst, 'reload schema';
