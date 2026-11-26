-- REQ-UG-ATOMIC-MEMBER-WRITES-20260725: make the four remaining multi-step
-- member writes atomic, and close three live defects found while designing them.
--
-- WHAT WAS WRONG. Sending a message, filing a case, casting a ballot, and
-- answering a pulse each ran as two or three independent PostgREST calls from
-- the browser. Every gap between them is a place the member's device can lose
-- power, lose signal, or be closed:
--
--   send message   insert member_messages -> update member_conversations
--                  -> insert member_action_log. Losing the middle write strands
--                  the message: the steward desk orders its inbox by
--                  updated_at desc limit 100, so an un-touched conversation
--                  sinks below the fold and the member's reply is never read.
--   create case    client-generated reference (`GR-<year>-<last 5 of Date.now()>`)
--                  -> insert -> action log. A retry after a timeout that
--                  actually committed mints a SECOND grievance reference for
--                  one incident, which a steward reconciles by hand.
--   ballot vote    upsert vote -> action log -> SELECT the receipt. The receipt
--                  read happens after the vote is already counted, so a dropped
--                  connection at that moment shows a failure toast over a vote
--                  that was recorded — the worst possible outcome for a secret
--                  ballot.
--   survey         upsert response -> action log. Same stranding shape.
--
-- Each becomes one SECURITY DEFINER function: one transaction, all-or-nothing,
-- with the receipt and the awarded point total returned from inside it.
--
-- THREE LIVE DEFECTS CLOSED HERE (all reachable today from the browser console
-- against production, none of them fixable in the client):
--
--   1. CROSS-BALLOT OPTION ACCEPTANCE. member_ballot_votes.option_id references
--      member_ballot_options(id) but NOT the ballot, and member_ballot_options
--      is org-readable. A member could post ballot_id = A with an option_id
--      belonging to ballot B: the FK is satisfied, the row is accepted, and
--      get_ballot_tally counts it in the TOTAL (inflating turnout against
--      quorum_target) while bucketing it under no option. Quorum is a legal
--      threshold in this org — inflating it is not cosmetic. Same shape on
--      member_survey_responses. Both RPCs now verify the option belongs to the
--      ballot/survey being voted in.
--
--   2. VOTES ACCEPTED AFTER CLOSE. Neither `active` nor `closes_at` was
--      enforced on any write path — only on the READ that lists open items. A
--      member who keeps the tab open, or who calls PostgREST directly, could
--      vote after the ballot closed and after the tally was public. Both RPCs
--      now refuse a closed ballot/pulse. The client deliberately does NOT
--      filter the catalogs on closes_at — visibility is not votability (owner
--      decision 2026-07-25): planItems marks closed rows and the UI disables
--      the action, keeping the receipt and quorum readout rendering.
--
--   3. SENDER-NAME SPOOFING. member_messages.sender_name was client-supplied
--      and is rendered raw in the steward desk thread, where 'Chapter steward'
--      is the label of the OTHER party. A member could send a message that
--      reads as though the steward wrote it — social engineering inside the
--      one channel members are told is trustworthy. The name is now derived
--      server-side from member_profiles.full_name; the parameter is gone.
--
-- THE ASSURANCE TERM IS LOAD-BEARING. 20260724030000 installed a RESTRICTIVE
-- mfa_assurance policy on every RLS-enabled public table, and SECURITY DEFINER
-- bypasses RLS — restrictive policies included. Converting a client write into
-- a definer RPC therefore silently exempts it from the MFA boundary unless the
-- function re-states the check itself. Every function below opens with the same
-- guard 20260724034000 added to rotate_calendar_feed_token and
-- upsert_push_subscription. Omitting it would have reopened all four paths at
-- aal1 — a regression introduced BY the security fix.
--
-- NO NEW MINT PATH. These functions never write member_point_events and never
-- redefine private.award_member_points. They insert the same action-log rows
-- the client used to insert, with action keys byte-identical to the prefixes
-- the live award trigger anchors on ('vote-'||id, 'survey-'||id, 'case-'||ref,
-- 'message-'||conversation||'-'||digits), so the entity-backing checks and the
-- weekly caps behave exactly as before. The awarded total is then READ BACK
-- from member_point_events rather than reported from member_point_rules,
-- because 'case' is capped at 3/week and 'message' at 5/week: over the cap the
-- trigger awards nothing, and the naive report would have told the member they
-- earned points they did not earn.
--
-- SCOPE. saveRightsProgress and requestSteward are deliberately NOT converted.
-- The rights write is idempotent by construction and self-healing on the next
-- save, and it is the one member write in the offline outbox — routing it
-- through a definer RPC would add failure surface to offline replay for no
-- atomicity gain. requestSteward's two writes are independent (the outcome is
-- delivered by the request row alone). Their real issues — an unbounded
-- completed_steps array and unthrottled duplicate steward requests — are outside
-- this migration's security scope.

set local lock_timeout = '5s';

-- 5 CSPRNG digits for the case reference. The old client-side scheme used the
-- last five digits of Date.now(), which is a clock reading: two members filing
-- in the same millisecond collide, and — worse — a retried request regenerates
-- a DIFFERENT suffix, which is precisely how one incident became two cases.
-- Server-side randomness plus the (user_id, reference) unique constraint and
-- the bounded retry loop below make the reference unguessable and the insert
-- single-shot. Volatile: it must return a fresh value on every call inside the
-- retry loop, and a stable/immutable marking would let the planner fold it to
-- one value and spin the loop forever.
create or replace function private.member_case_suffix()
returns text
language sql
volatile
set search_path = ''
as $$
  select pg_catalog.lpad(
    ((pg_catalog.get_byte(s.b, 0)::int * 65536
      + pg_catalog.get_byte(s.b, 1)::int * 256
      + pg_catalog.get_byte(s.b, 2)::int) % 100000)::text,
    5, '0')
  from (select extensions.gen_random_bytes(3) as b) as s;
$$;

comment on function private.member_case_suffix() is
  'CSPRNG 5-digit suffix for member case references. private: never client-callable.';

revoke all on function private.member_case_suffix() from public, anon, authenticated;

-- 1) send_member_message ----------------------------------------------------
-- One transaction over the message row, the conversation touch, and the action
-- log. No p_sender_name: see defect 3 in the header.
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

  -- Same key shape the client used to build, so the award trigger's
  -- '^message-(.*)-[0-9]+$' anchor still resolves the conversation.
  -- clock_timestamp() rather than now(): now() is transaction time and two
  -- messages in one transaction would collide on the unique (user_id,
  -- action_key), silently dropping the second log row.
  akey := 'message-' || p_conversation_id::text || '-'
          || pg_catalog.to_char(pg_catalog.clock_timestamp(), 'YYYYMMDDHH24MISSUS');
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

-- 2) create_member_case -----------------------------------------------------
-- Server-generated reference; no p_reference parameter exists, so a member can
-- neither choose their own case number nor pre-insert one to block a filing.
create or replace function public.create_member_case(
  p_title text,
  p_deadline date,
  p_case_type text,
  p_articles text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller         uuid := (select auth.uid());
  clean_title    text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles text := pg_catalog.btrim(coalesce(p_articles, ''));
  ref            text;
  new_case       uuid;
  attempts       integer := 0;
  akey           text;
  awarded        integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Bounds are raised, never truncated. A grievance is a legal document; a
  -- server that quietly clips the member's account of what happened at 200
  -- characters is worse than one that refuses and says why.
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;

  -- Mirrors the six <option value> entries in src/views/CasesView.jsx. The
  -- column has no CHECK, so before this the case_type was free text straight
  -- from the wire and the coordinator/steward case planes grouped on it.
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;

  -- Deadlines drive the member's Today screen and the steward deadline board.
  -- +/- 10 years is generous for a real contractual deadline and still keeps a
  -- fat-fingered year 0202 or 20260 out of every downstream sort.
  if p_deadline is not null
     and (p_deadline < current_date - 3650 or p_deadline > current_date + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- Bounded retry rather than a uniqueness pre-check: the check-then-insert
  -- race is exactly the duplicate this migration exists to remove. 5 attempts
  -- over a 100000-value space is astronomically more than enough; exhausting
  -- it means something is badly wrong and the caller gets a clean error rather
  -- than a hung loop.
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (user_id, reference, title, deadline, case_type, articles, step)
      values (caller, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake')
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  akey := 'case-' || ref;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'case')
  on conflict (user_id, action_key) do nothing;

  -- 'case' is capped at 3/week; read the real award, not the rule.
  select e.points into awarded
  from public.member_point_events e
  where e.user_id = caller and e.action_key = akey;

  return pg_catalog.jsonb_build_object(
    'caseId', new_case,
    'reference', ref,
    'awardedPoints', coalesce(awarded, 0));
end;
$$;

-- 3) submit_ballot_vote -----------------------------------------------------
-- Closes defects 1 and 2 for ballots, and returns the receipt from inside the
-- same transaction that counted the vote.
create or replace function public.submit_ballot_vote(p_ballot_id text, p_option_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller  uuid := (select auth.uid());
  ballot  record;
  akey    text;
  awarded integer;
  logged  boolean;
  code    text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Distinct not-found / closed errors here are deliberate and NOT an oracle
  -- regression: member_ballots is org-readable to every authenticated member
  -- (member_ballots_read_authenticated using (true)), and get_ballot_tally
  -- already distinguishes the same two states. Nothing is disclosed that a
  -- plain SELECT does not already give the caller.
  select b.id, b.active, b.closes_at into ballot
  from public.member_ballots b
  where b.id = p_ballot_id;
  if not found then
    raise exception 'ballot not found' using errcode = '22023';
  end if;
  if not ballot.active or ballot.closes_at <= now() then
    raise exception 'this ballot is closed' using errcode = '22023';
  end if;

  -- Defect 1. The FK on member_ballot_votes.option_id points at
  -- member_ballot_options(id) with no ballot component, so a satisfied FK is
  -- not evidence the option belongs to THIS ballot.
  if not exists (
    select 1 from public.member_ballot_options o
    where o.id = p_option_id and o.ballot_id = p_ballot_id
  ) then
    raise exception 'invalid option for this ballot' using errcode = '22023';
  end if;

  -- Changing an existing vote updates option_id only. submitted_at is
  -- deliberately NOT bumped, and the receipt trigger is AFTER INSERT, so a
  -- changed vote correctly keeps its original receipt code rather than
  -- issuing a second one for one member on one ballot.
  insert into public.member_ballot_votes (ballot_id, user_id, option_id)
  values (p_ballot_id, caller, p_option_id)
  on conflict (ballot_id, user_id) do update set option_id = excluded.option_id;

  akey := 'vote-' || p_ballot_id;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'vote')
  on conflict (user_id, action_key) do nothing
  returning true into logged;

  -- Only read the award back when THIS call actually logged the action. A
  -- changed vote hits `do nothing`, the AFTER INSERT trigger never fires, and
  -- nothing is awarded — but the original vote's ledger row still matches akey,
  -- so an unconditional read-back would report points not earned on this call.
  if coalesce(logged, false) then
    select e.points into awarded
    from public.member_point_events e
    where e.user_id = caller and e.action_key = akey;
  end if;

  -- Self-scoped explicitly even though this row is the caller's by
  -- construction: definer code carries no RLS, so every predicate that would
  -- have been a policy has to be written out.
  select r.receipt_code into code
  from public.member_ballot_receipts r
  where r.user_id = caller and r.ballot_id = p_ballot_id;

  -- '' rather than null: the client toast gates on truthiness, and the empty
  -- string keeps "vote saved, no receipt yet" from rendering as "undefined".
  return pg_catalog.jsonb_build_object(
    'receiptCode', coalesce(code, ''),
    'awardedPoints', coalesce(awarded, 0));
end;
$$;

-- 4) submit_survey_response -------------------------------------------------
-- Same two defects, same shape, on the pulse tables. No receipt: pulses are
-- anonymous by design and issue none.
create or replace function public.submit_survey_response(p_survey_id text, p_option_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller  uuid := (select auth.uid());
  survey  record;
  akey    text;
  awarded integer;
  logged  boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select s.id, s.active, s.closes_at into survey
  from public.member_surveys s
  where s.id = p_survey_id;
  if not found then
    raise exception 'pulse not found' using errcode = '22023';
  end if;
  if not survey.active or survey.closes_at <= now() then
    raise exception 'this pulse is closed' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.member_survey_options o
    where o.id = p_option_id and o.survey_id = p_survey_id
  ) then
    raise exception 'invalid option for this pulse' using errcode = '22023';
  end if;

  insert into public.member_survey_responses (survey_id, user_id, option_id)
  values (p_survey_id, caller, p_option_id)
  on conflict (survey_id, user_id) do update set option_id = excluded.option_id;

  akey := 'survey-' || p_survey_id;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'survey')
  on conflict (user_id, action_key) do nothing
  returning true into logged;

  -- Same read-back guard as the ballot path: a changed pulse answer logs
  -- nothing new, so only read the award when this call actually inserted.
  if coalesce(logged, false) then
    select e.points into awarded
    from public.member_point_events e
    where e.user_id = caller and e.action_key = akey;
  end if;

  return pg_catalog.jsonb_build_object('awardedPoints', coalesce(awarded, 0));
end;
$$;

-- Privileges: members only, never anon or public.
revoke all on function public.send_member_message(uuid, text) from public, anon;
grant execute on function public.send_member_message(uuid, text) to authenticated;

revoke all on function public.create_member_case(text, date, text, text) from public, anon;
grant execute on function public.create_member_case(text, date, text, text) to authenticated;

revoke all on function public.submit_ballot_vote(text, text) from public, anon;
grant execute on function public.submit_ballot_vote(text, text) to authenticated;

revoke all on function public.submit_survey_response(text, text) from public, anon;
grant execute on function public.submit_survey_response(text, text) to authenticated;

-- SOLE-WRITER REVOKES LIVE IN 20260725120000, NOT HERE — deliberately.
-- This migration is the EXPAND phase of an expand/contract rollout: it only
-- ADDS functions, so it is safe against every client that exists when it is
-- applied. The old bundle keeps direct-table writing (grants untouched); the
-- new bundle finds its RPCs waiting. The revokes are the CONTRACT phase and
-- are backward-incompatible in both directions — applied before the new
-- frontend is live they 42501 every old client's writes; shipped with the
-- frontend in one step they PGRST202 every new client until the migration
-- lands. 20260725120000 must therefore be applied ONLY AFTER the deploy
-- serving the RPC-calling bundle is verified live.

notify pgrst, 'reload schema';
