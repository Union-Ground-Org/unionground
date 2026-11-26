-- Quorum integrity: composite FKs pair every vote/response option with its own
-- ballot/survey (REQ-UG-QUORUM-COMPOSITE-FK-20260725).
--
-- VECTOR
-- member_ballot_votes.option_id references member_ballot_options(id) with no
-- ballot component, so a row satisfying both single-column FKs can still pair
-- ballot A with an option belonging to ballot B. get_ballot_tally counts such
-- a row in the turnout TOTAL — quorum_target is a legal threshold in this org —
-- while bucketing it under no option. 20260725000000 closed the RPC path with
-- an in-body exists() check and 20260725120000 made the RPCs the sole client
-- write path, but an app-level check is not a constraint: a service_role
-- write, a future RPC, or an erroneously restored grant can still land a
-- poisoned row. Same shape on member_survey_responses.
--
-- FIX
-- The schema-level invariant the tables were missing:
--   member_ballot_votes (option_id, ballot_id)     -> member_ballot_options (id, ballot_id)
--   member_survey_responses (option_id, survey_id) -> member_survey_options (id, survey_id)
-- Each composite FK needs a UNIQUE target first — both options tables carry a
-- single-column PK on id, and Postgres requires the referenced column pair to
-- have its own unique constraint even though PK(id) logically implies it.
-- The new FKs take the default NO ACTION on purpose: it defers the check to
-- statement end, so it is strictly more permissive than the single-column
-- option_id RESTRICT FKs that stay in place and keep governing delete
-- semantics. This migration adds the missing pairing invariant and changes
-- nothing else — no RPC body, no grant, no policy, no client file.
--
-- PostgREST: the composite FK is a SECOND relationship between the votes and
-- options tables, which would make an embed across that pair ambiguous. No
-- client query embeds across it — the only embeds are
-- member_ballots->member_ballot_options and member_surveys->member_survey_options
-- (src/lib/memberApi.js), both untouched here. Pinned by
-- tests/quorum-composite-fk.test.js.
--
-- Pre-flight (verified against production before the live apply, and enforced
-- loudly below): zero poisoned rows in either family.

set local lock_timeout = '5s';

-- Refuse loudly if a poisoned row exists. The VALIDATE below would fail on one
-- anyway, but this names the defect and the audit query instead of surfacing a
-- bare foreign_key_violation from inside a constraint scan.
do $$
declare bad integer;
begin
  select count(*) into bad
  from public.member_ballot_votes v
  join public.member_ballot_options o on o.id = v.option_id
  where o.ballot_id <> v.ballot_id;
  if bad > 0 then
    raise exception 'refusing to constrain: % member_ballot_votes row(s) pair an option from another ballot — audit those rows before applying', bad
      using errcode = '23503';
  end if;

  select count(*) into bad
  from public.member_survey_responses r
  join public.member_survey_options o on o.id = r.option_id
  where o.survey_id <> r.survey_id;
  if bad > 0 then
    raise exception 'refusing to constrain: % member_survey_responses row(s) pair an option from another survey — audit those rows before applying', bad
      using errcode = '23503';
  end if;
end
$$;

alter table public.member_ballot_options
  add constraint member_ballot_options_id_ballot_id_key unique (id, ballot_id);

alter table public.member_ballot_votes
  add constraint member_ballot_votes_option_in_ballot_fkey
  foreign key (option_id, ballot_id) references public.member_ballot_options(id, ballot_id)
  not valid;

alter table public.member_ballot_votes validate constraint member_ballot_votes_option_in_ballot_fkey;

alter table public.member_survey_options
  add constraint member_survey_options_id_survey_id_key unique (id, survey_id);

alter table public.member_survey_responses
  add constraint member_survey_responses_option_in_survey_fkey
  foreign key (option_id, survey_id) references public.member_survey_options(id, survey_id)
  not valid;

alter table public.member_survey_responses validate constraint member_survey_responses_option_in_survey_fkey;

-- CONTRACT COORDINATION (scripts/db-contract.json): eight constraints entries.
-- Four pin the new UNIQUE targets and composite FKs (convalidated, exact
-- pg_get_constraintdef rendering as needles). Four more pin the PRE-EXISTING
-- single-column FKs WITH their ON DELETE tails (review finding, CONFIRMED):
-- the composite-FK needles end at the referenced column list, so a substring
-- match cannot see an ON DELETE action appended to a re-created composite FK —
-- that append is only harmful if the option_id RESTRICT FKs stop blocking
-- option deletes first, so their delete semantics are pinned too. No grant
-- changes, so knownGaps is untouched.
