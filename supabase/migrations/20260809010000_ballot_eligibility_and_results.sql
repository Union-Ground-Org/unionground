-- Ballot eligibility + published results (UB-VOTE-03, UB-VOTE-02 / UB-CON-04).
--
-- 1) Eligibility becomes a real model: member_ballots gains a nullable
--    chapter_id (null = union-wide). A member can read and vote in exactly
--    the ballots that are union-wide or belong to their own chapter
--    (member_profiles.chapter_id via private.current_member_chapter()).
--    Enforcement lives at the read policies and inside submit_ballot_vote's
--    ballot lookup — NEVER on member_ballot_choices, which stays voterless
--    by owner directive (UB-VOTE-04; the table is pinned at four columns).
--    All three existing ballots stay null/union-wide, so no live behavior
--    changes for existing data (including the stress cohort's choices).
--
-- 2) Results become storage truth the moment a ballot closes: get_ballot_tally
--    emits the per-option breakdown when the ballot is inactive OR its
--    closes_at has passed. Nothing flips active=false at close today, so the
--    old inactive-only gate meant the member client could never see a result;
--    the in-app rule text has always promised results to all members within
--    24 hours of close. While voting is open, no per-option count ever leaves
--    the function (no early tallies — the UB-VOTE-04 boundary is unchanged).
--
-- Scope votes AND visibility; results render in
-- the past-vote rows and detail dialog; rules copy is rewritten to describe
-- this model (client side of this wave).

-- 1) Eligibility column ------------------------------------------------------

alter table public.member_ballots
  add column chapter_id text references public.chapters(id) on delete set null;

comment on column public.member_ballots.chapter_id is
  'Eligibility scope: null = union-wide ballot, otherwise only members of this chapter can read and vote (UB-VOTE-03). Enforced by member_ballots_read_eligible and submit_ballot_vote; never derivable from member_ballot_choices, which stays voterless (UB-VOTE-04).';

-- 2) Read policies: eligibility replaces the org-wide catalog read -----------

drop policy member_ballots_read_authenticated on public.member_ballots;
create policy member_ballots_read_eligible on public.member_ballots
  for select to authenticated
  using (chapter_id is null or chapter_id = private.current_member_chapter());

-- Options follow their parent ballot's visibility: an out-of-chapter ballot
-- must not leak its existence or its option labels through the child table.
drop policy member_ballot_options_read_authenticated on public.member_ballot_options;
create policy member_ballot_options_read_eligible on public.member_ballot_options
  for select to authenticated
  using (exists (
    select 1 from public.member_ballots b
    where b.id = member_ballot_options.ballot_id
      and (b.chapter_id is null or b.chapter_id = private.current_member_chapter())
  ));

-- 3) submit_ballot_vote: eligibility folded into the ballot lookup -----------

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

  -- The lookup applies the same eligibility predicate as the member read
  -- policy (member_ballots_read_eligible), so a ballot outside the caller's
  -- chapter is indistinguishable from a ballot that does not exist — the
  -- distinct not-found / closed errors below stay non-oracle (UB-VOTE-03):
  -- nothing is disclosed that the caller's own SELECT would not already show.
  select b.id, b.active, b.closes_at into ballot
  from public.member_ballots b
  where b.id = p_ballot_id
    and (b.chapter_id is null or b.chapter_id = private.current_member_chapter());
  if not found then
    raise exception 'ballot not found' using errcode = '22023';
  end if;
  if not ballot.active or ballot.closes_at <= now() then
    raise exception 'this ballot is closed' using errcode = '22023';
  end if;

  -- The composite FK on member_ballot_choices proves option-belongs-to-ballot
  -- at write time, but this pre-check keeps the client-facing error message.
  if not exists (
    select 1 from public.member_ballot_options o
    where o.id = p_option_id and o.ballot_id = p_ballot_id
  ) then
    raise exception 'invalid option for this ballot' using errcode = '22023';
  end if;

  -- The receipt insert is the one-vote serialization point: a concurrent or
  -- repeated call for the same (ballot, member) gets null back and is refused
  -- here, so exactly one anonymous choice row can ever follow it. Votes are
  -- FINAL — the choice is stored unlinkably (UB-VOTE-04), so there is no row
  -- the server could attribute back to this member to update.
  code := private.issue_ballot_receipt(p_ballot_id, caller);
  if code is null then
    raise exception 'your vote is already recorded' using errcode = '22023';
  end if;

  -- The choice lands with no voter column and no timestamp; only its count is
  -- ever read back. The one exception to "no voter trace": a stress-cohort
  -- caller (present in the private ledger — real members never are) gets the
  -- run stamp, because removal must be able to sweep synthetic choices that
  -- the auth.users cascade cannot reach ( finding 5).
  insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)
  values (p_ballot_id, p_option_id,
    (select l.run_id from private.member_stress_ledger l where l.user_id = caller limit 1));

  akey := 'vote-' || p_ballot_id;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'vote')
  on conflict (user_id, action_key) do nothing
  returning true into logged;

  -- Only read the award back when THIS call actually logged the action; a
  -- replayed action key hits do-nothing and earns nothing on this call.
  if coalesce(logged, false) then
    select e.points into awarded
    from public.member_point_events e
    where e.user_id = caller and e.action_key = akey;
  end if;

  return pg_catalog.jsonb_build_object(
    'receiptCode', code,
    'awardedPoints', coalesce(awarded, 0));
end;
$$;

-- 4) get_ballot_tally: results at close, eligibility-scoped lookup -----------

create or replace function public.get_ballot_tally(p_ballot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ballot record;
  total integer;
  option_counts jsonb;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- Same eligibility predicate as the read policy: an out-of-chapter ballot
  -- id must not become a turnout oracle through this definer function.
  select id, title, closes_at, active, quorum_target into ballot
  from public.member_ballots
  where id = p_ballot_id
    and (chapter_id is null or chapter_id = private.current_member_chapter());

  if not found then
    raise exception 'ballot not found' using errcode = '22023';
  end if;

  -- Vote totals count cast ballots, not surviving accounts: receipts cascade
  -- away with auth.users while an anonymous choice (by design) cannot, so
  -- counting receipts here would let turnout drift below the option totals
  -- after an account deletion ( finding 4). A cast ballot
  -- stays counted.
  select count(*) into total
  from public.member_ballot_choices
  where ballot_id = ballot.id;

  -- Results publish the moment a ballot closes — by the explicit active flag
  -- OR by closes_at passing (nothing flips active=false at close, so the old
  -- inactive-only gate starved the member client forever: UB-VOTE-02). While
  -- voting is open no per-option count ever leaves this function.
  if (not ballot.active) or ballot.closes_at <= now() then
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('optionId', counts.option_id, 'label', counts.label, 'votes', counts.votes)
      order by counts.order_index
    ), '[]'::jsonb) into option_counts
    from (
      select options.id as option_id, options.label, options.order_index, count(choices.option_id) as votes
      from public.member_ballot_options as options
      left join public.member_ballot_choices as choices
        on choices.ballot_id = options.ballot_id and choices.option_id = options.id
      where options.ballot_id = ballot.id
      group by options.id, options.label, options.order_index
    ) as counts;
  end if;

  return pg_catalog.jsonb_build_object(
    'ballotId', ballot.id,
    'totalVotes', total,
    'quorumTarget', ballot.quorum_target,
    'closesAt', ballot.closes_at,
    'active', ballot.active,
    'options', option_counts
  );
end;
$$;
