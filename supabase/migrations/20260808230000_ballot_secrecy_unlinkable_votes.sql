-- UB-VOTE-04 — ballot secrecy becomes storage truth, not policy.
-- Owner directive (2026-08-08, role-map disposition layer): a recorded choice
-- must be unlinkable from the voter even with direct database access, and no
-- UI secrecy claim stands until that is true. This migration makes it true:
--
--   * public.member_ballot_choices is the new choice store: one anonymous row
--     per cast ballot — no user_id, no timestamp, random uuid key. No client
--     role can read or write it; only get_ballot_tally aggregates it.
--   * public.member_ballot_receipts becomes the sole participation record and
--     the one-vote guard (unique (ballot_id, user_id)). Receipts prove THAT a
--     member voted — which the UI already discloses — never how.
--   * Votes are FINAL. The old change-your-vote upsert required a row the
--     server could attribute to the caller; with unlinkable storage no such
--     row exists, so submit_ballot_vote now refuses a second submission
--     ('your vote is already recorded').
--   * member_ballot_votes is BACKFILLED into the new store (shuffled so heap
--     order carries no echo of receipt order), then EMPTIED — that delete is
--     the moment the voter→choice link ceases to exist. The table itself
--     survives, empty, because the currently deployed client still selects
--     from it at boot; the follow-up migration drops it once the new frontend
--     is live. Emptying now, dropping later keeps the deploy window safe.
--   * Every reader is re-pointed: get_ballot_tally (turnout from receipts,
--     per-option counts from choices), get_vp_overview / get_advisor_overview
--     turnout laterals (receipts), award_member_points' vote branch (receipt
--     backs the award), and the stress harness (per-voter receipt + anonymous
--     choice stamped with stress_run_id so removal can sweep rows the
--     auth.users cascade cannot reach).
--   * private.issue_member_ballot_receipt() (the AFTER INSERT trigger on the
--     votes table) is dropped with its trigger; receipt issuance moves into
--     private.issue_ballot_receipt(p_ballot_id, p_user_id), called directly
--     by submit_ballot_vote and the stress harness. Its null return IS the
--     already-voted signal, which also serializes concurrent double-submits.
--
-- Deliberately NOT stored anywhere in the new shape: any per-choice timestamp
-- or ordering hint. The only remaining correlation surface is physical heap
-- order, which the shuffled backfill scrambles for historical rows and which
-- carries no timestamp to correlate against for new ones.
--
-- db-contract.json co-edits in this commit: member_ballot_choices constraint
-- + index pins, policiesForbidden entry (no select policy may ever appear on
-- the choices table), rlsTableCount 78 -> 79, private.issue_ballot_receipt
-- function entry, private.issue_member_ballot_receipt moved to
-- functionsAbsent, submit_ballot_vote bodyContains/bodyForbids hardening, and
-- a refreshed award_member_points bodyMd5.

-- 1) The anonymous choice store ----------------------------------------------

create table public.member_ballot_choices (
  id uuid primary key default extensions.gen_random_uuid(),
  ballot_id text not null references public.member_ballots(id) on delete cascade,
  option_id text not null references public.member_ballot_options(id) on delete restrict,
  -- Synthetic-cohort marker ONLY. Stress enrichment stamps its run id here so
  -- removal can sweep rows the auth.users cascade cannot reach. Real votes
  -- always carry null — this column must never reference a member.
  stress_run_id uuid
);

-- Same cross-ballot integrity the votes table carried: the option must belong
-- to THIS ballot, not merely exist.
alter table public.member_ballot_choices
  add constraint member_ballot_choices_option_in_ballot_fkey
  foreign key (option_id, ballot_id) references public.member_ballot_options(id, ballot_id);

create index member_ballot_choices_ballot_option_idx
  on public.member_ballot_choices (ballot_id, option_id);

alter table public.member_ballot_choices enable row level security;

create policy mfa_assurance
  on public.member_ballot_choices
  as restrictive
  for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

-- No permissive policy and no client grants, ever: a per-vote row that any
-- client role could read would put the linkage question back on the table.
-- Aggregation happens only inside get_ballot_tally (definer).
revoke all on table public.member_ballot_choices from public, anon, authenticated;

-- 2) Receipt issuance becomes a callable helper ------------------------------
-- The votes-table trigger dies with the table's role. submit_ballot_vote and
-- the stress harness both need issuance, and both need the same semantics:
-- null return = this member already holds a receipt for this ballot.

create function private.issue_ballot_receipt(p_ballot_id text, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  code text;
  issued text;
  attempts integer := 0;
begin
  loop
    code := private.member_receipt_code();
    begin
      insert into public.member_ballot_receipts (ballot_id, user_id, receipt_code)
      values (p_ballot_id, p_user_id, code)
      on conflict (ballot_id, user_id) do nothing
      returning receipt_code into issued;
      -- null means the (ballot, member) pair already holds a receipt: the
      -- caller must treat that as "already voted", never as a fresh vote.
      return issued;
    exception when unique_violation then
      -- The pair conflict is absorbed by ON CONFLICT, so only a receipt_code
      -- collision can land here; retry with a fresh code.
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

-- Callers are all SECURITY DEFINER (submit_ballot_vote, the stress harness),
-- which execute as the function owner — no role needs a direct grant.
revoke all on function private.issue_ballot_receipt(text, uuid) from public, anon, authenticated, service_role;

-- 3) Backfill, then destroy the linkage --------------------------------------

-- 3a) Receipts are about to become the sole participation record; make sure
-- every existing vote has one. (The trigger has issued receipts since
-- 20260721223851; this covers any vote row that predates it.)
do $$
declare
  pair record;
begin
  for pair in
    select v.ballot_id, v.user_id
    from public.member_ballot_votes v
    where not exists (
      select 1 from public.member_ballot_receipts r
      where r.ballot_id = v.ballot_id and r.user_id = v.user_id)
  loop
    perform private.issue_ballot_receipt(pair.ballot_id, pair.user_id);
  end loop;
end
$$;

-- 3b) Copy every recorded choice into the anonymous store. Shuffled on the way
-- in so heap order carries no echo of receipt issue order; synthetic votes are
-- stamped with their stress run for later removal, real votes stay null.
insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)
select v.ballot_id, v.option_id, l.run_id
from public.member_ballot_votes v
left join private.member_stress_ledger l on l.user_id = v.user_id
order by pg_catalog.random();

-- 3c) Empty — do not yet drop — the votes table. This DELETE is the point at
-- which the voter→choice link stops existing. The table survives, empty,
-- because the deployed client still selects from it at boot; the follow-up
-- migration drops it (and its policies, index, and contract pins) once the
-- new frontend is live.
delete from public.member_ballot_votes;

drop trigger member_ballot_votes_issue_receipt on public.member_ballot_votes;
drop function if exists private.issue_member_ballot_receipt();

-- 4) submit_ballot_vote: final votes, anonymous storage ----------------------

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
  -- ever read back.
  insert into public.member_ballot_choices (ballot_id, option_id)
  values (p_ballot_id, p_option_id);

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

-- 5) get_ballot_tally: turnout from receipts, options from choices -----------

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

  select id, title, closes_at, active, quorum_target into ballot
  from public.member_ballots
  where id = p_ballot_id;

  if not found then
    raise exception 'ballot not found' using errcode = '22023';
  end if;

  -- Turnout is the count of participation records; the choices table would
  -- give the same number, but turnout is a statement about members, and the
  -- receipt is the member-facing participation record.
  select count(*) into total
  from public.member_ballot_receipts
  where ballot_id = ballot.id;

  if not ballot.active then
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

-- 6) Staff turnout laterals re-pointed at participation ----------------------

create or replace function public.get_vp_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  member_count integer;
  new_this_year integer;
  active_grievances integer;
  turnout jsonb;
  attention jsonb;
  upcoming jsonb;
  priorities jsonb;
  trend jsonb;
begin
  if caller is null or not public.member_has_role(array['vp', 'admin']) then
    raise exception 'vp role required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('vp', 'admin')
  order by case r.role when 'vp' then 0 else 1 end
  limit 1;

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where p.member_since = pg_catalog.date_part('year', pg_catalog.now())::int)
  into member_count, new_this_year
  from public.member_profiles p
  where caller_chapter is null or p.chapter_id = caller_chapter;

  select pg_catalog.count(*)
  into active_grievances
  from public.member_cases c
  join public.member_profiles p on p.id = c.user_id
  where c.status = 'active'
    and (caller_chapter is null or p.chapter_id = caller_chapter);

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_receipts
    where ballot_id = b.id
  ) v on true
  where b.active = false or b.closes_at < pg_catalog.now()
  order by b.closes_at desc
  limit 1;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'reference', s.reference,
      'title', s.title,
      'step', s.step,
      'deadline', s.deadline,
      'memberName', s.member_name)), '[]'::jsonb)
  into attention
  from (
    select c.id, c.reference, c.title, c.step, c.deadline, p.full_name as member_name
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where c.status = 'active'
      and c.deadline is not null
      and c.deadline < current_date
      and (caller_chapter is null or p.chapter_id = caller_chapter)
    order by c.deadline
    limit 6
  ) s;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary)), '[]'::jsonb)
  into upcoming
  from (
    select id, title, starts_at, location, summary
    from public.member_events
    where starts_at >= pg_catalog.now()
    order by starts_at
    limit 5
  ) e;

  -- The aggregate-level ORDER BY is the guarantee; the subquery's ORDER BY
  -- only picks WHICH 8 survive the limit.
  select coalesce(pg_catalog.jsonb_agg(x.obj order by x.order_index), '[]'::jsonb)
  into priorities
  from (
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'ballot') as obj, order_index
    from public.member_ballots
    where active = true
    union all
    select pg_catalog.jsonb_build_object('id', id, 'title', title, 'kind', 'survey'), order_index
    from public.member_surveys
    where active = true
    order by order_index
    limit 8
  ) x;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'year', y.yr, 'count', y.cumulative) order by y.yr), '[]'::jsonb)
  into trend
  from (
    select g.yr, pg_catalog.sum(g.n) over (order by g.yr) as cumulative
    from (
      select p.member_since as yr, pg_catalog.count(*) as n
      from public.member_profiles p
      where caller_chapter is null or p.chapter_id = caller_chapter
      group by p.member_since
    ) g
  ) y
  where y.yr >= pg_catalog.date_part('year', pg_catalog.now())::int - 5;

  return pg_catalog.jsonb_build_object(
    'memberCount', member_count,
    'newThisYear', new_this_year,
    'activeGrievances', active_grievances,
    'turnout', turnout,
    'attention', attention,
    'upcomingEvents', upcoming,
    'priorities', priorities,
    'membershipTrend', trend);
end;
$$;

create or replace function public.get_advisor_overview()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  members_covered integer;
  open_cases integer;
  resolved_cases integer;
  overdue_cases integer;
  steward_count integer;
  turnout jsonb;
begin
  if caller is null or not public.member_has_role(array['advisor', 'admin']) then
    raise exception 'advisor role required' using errcode = '42501';
  end if;

  select r.chapter_id into caller_chapter
  from public.member_roles r
  where r.user_id = caller and r.role in ('advisor', 'admin')
  order by case r.role when 'advisor' then 0 else 1 end
  limit 1;

  select pg_catalog.count(*)
  into members_covered
  from public.member_profiles p
  where caller_chapter is null or p.chapter_id = caller_chapter;

  with base as materialized (
    select c.status, c.deadline
    from public.member_cases c
    join public.member_profiles p on p.id = c.user_id
    where caller_chapter is null or p.chapter_id = caller_chapter
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline < current_date)
  into open_cases, resolved_cases, overdue_cases
  from base b;

  -- An org-wide steward (NULL chapter role row) covers every chapter, so it
  -- counts toward any caller's scope.
  select pg_catalog.count(distinct r.user_id)
  into steward_count
  from public.member_roles r
  where r.role = 'steward'
    and (caller_chapter is null or r.chapter_id is null or r.chapter_id = caller_chapter);

  select pg_catalog.jsonb_build_object(
      'title', b.title,
      'totalVotes', v.n,
      'quorumTarget', b.quorum_target)
  into turnout
  from public.member_ballots b
  left join lateral (
    select pg_catalog.count(*) as n
    from public.member_ballot_receipts
    where ballot_id = b.id
  ) v on true
  where b.active = false or b.closes_at < pg_catalog.now()
  order by b.closes_at desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'membersCovered', members_covered,
    'openGrievances', open_cases,
    'resolvedGrievances', resolved_cases,
    'stewardCount', steward_count,
    'coverageRatio', case when steward_count = 0 then null
      else pg_catalog.round(members_covered::numeric / steward_count) end,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'turnout', turnout,
    'atRisk', pg_catalog.jsonb_build_object(
      'overdueCases', overdue_cases,
      'unstaffed', steward_count = 0));
end;
$$;

-- 7) award_member_points (9th gen): receipt backs the vote award -------------

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
      select 1 from public.member_ballot_receipts
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

-- 8) Stress harness: receipts + run-stamped anonymous choices ----------------

create or replace function public.member_stress_enrich_batch(
  p_run_id uuid,
  p_phase text,
  p_start_ordinal integer,
  p_batch_count integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.member_stress_runs%rowtype;
  lo integer := p_start_ordinal;
  hi integer := p_start_ordinal + p_batch_count - 1;
  touched bigint := 0;
  seed text := p_run_id::text;
  pick record;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 5000 or p_start_ordinal < 1 then
    raise exception 'invalid enrichment batch range';
  end if;
  select * into run from private.member_stress_runs where id = p_run_id;
  if not found then raise exception 'unknown member stress run'; end if;
  -- 'applied' or 'verified' only: enrichment must never race the seeder, and a
  -- removed/removing run has nothing to enrich.
  if run.state not in ('applied', 'verified') then
    raise exception 'run must be applied or verified to enrich (state %)', run.state;
  end if;

  if p_phase = 'profile' then
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    assigned as (
      select t.*,
        (select cp.chapter_id from private.member_stress_chapter_plan cp
          where private.member_stress_pick(t.s || ':chapter', 100000) between cp.lo and cp.hi
          limit 1) as chapter_id
      from tgt t
    ),
    named as (
      select a.*,
        (select v.value from private.member_stress_name_pool v
          where v.part = 'first'
            and v.idx = private.member_stress_pick(a.s || ':first',
              (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'first'))) as fn,
        (select v.value from private.member_stress_name_pool v
          where v.part = 'last'
            and v.idx = private.member_stress_pick(a.s || ':last',
              (select pg_catalog.count(*)::integer from private.member_stress_name_pool where part = 'last'))) as ln
      from assigned a
    ),
    resolved as (
      select n.*, c.region as agency,
        (select r.title from private.member_stress_role_pool r
          where r.agency = c.region
            and r.idx = private.member_stress_pick(n.s || ':role',
              (select pg_catalog.count(*)::integer from private.member_stress_role_pool r2 where r2.agency = c.region))) as role_title
      from named n join public.chapters c on c.id = n.chapter_id
    ),
    upd as (
      update public.member_profiles mp
      set chapter_id = r.chapter_id,
          first_name = r.fn,
          full_name = r.fn || ' ' || r.ln,
          initials = pg_catalog.upper(pg_catalog.left(r.fn, 1) || pg_catalog.left(r.ln, 1)),
          role_line = r.role_title,
          member_since = 1998 + private.member_stress_pick(r.s || ':since', 28),
          language = case when private.member_stress_rand(r.s || ':lang') < 0.15 then 'es' else 'en' end
      from resolved r
      where mp.id = r.user_id
      returning 1
    )
    select pg_catalog.count(*) into touched from upd;

  elsif p_phase = 'texture' then
    -- Notification/conversation/message variety. `kind` is NEVER touched: see
    -- the outbound-delivery rule in this file's header.
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select n.id, t.s,
        pg_catalog.row_number() over (partition by n.user_id order by n.created_at) as rn
      from public.member_notifications n join tgt t on t.user_id = n.user_id
    ),
    upd as (
      update public.member_notifications n
      set title = (array[
            'Step 2 hearing scheduled','Contract action update','Chapter meeting reminder',
            'Your grievance moved forward','New rights lesson available','Steward office hours',
            'Membership drive this week','Workload survey closing'
          ])[1 + private.member_stress_pick(k.s || ':ntitle' || k.rn, 8)],
          body = (array[
            'Your steward will meet you 30 minutes before the hearing.',
            'The bargaining team posted a summary of this week''s session.',
            'Agenda and the call-in link are posted on the chapter board.',
            'The employer''s written answer is due at the end of next week.',
            'A three-minute refresher on your representation rights.',
            'Drop-in hours run Thursday afternoon at the area office.',
            'Two co-workers signed up this week — say hello.',
            'Last call to log your caseload for the quarter.'
          ])[1 + private.member_stress_pick(k.s || ':nbody' || k.rn, 8)],
          created_at = pg_catalog.now()
            - (private.member_stress_pick(k.s || ':nage' || k.rn, 120) || ' days')::interval
            - (private.member_stress_pick(k.s || ':nhr' || k.rn, 24) || ' hours')::interval,
          read_at = case when private.member_stress_rand(k.s || ':nread' || k.rn) < 0.62
            then pg_catalog.now() - (private.member_stress_pick(k.s || ':nrd' || k.rn, 96) || ' hours')::interval
            else null end
      from ranked k
      where n.id = k.id
      returning 1
    )
    select pg_catalog.count(*) into touched from upd;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at) as rn
      from public.member_conversations c join tgt t on t.user_id = c.user_id
    )
    update public.member_conversations c
    set title = (array[
          'Chapter steward','Area steward','Grievance chair','Field representative','Chapter president'
        ])[1 + private.member_stress_pick(k.s || ':ctitle' || k.rn, 5)],
        initials = (array['CS','AS','GC','FR','CP'])[1 + private.member_stress_pick(k.s || ':ctitle' || k.rn, 5)],
        created_at = pg_catalog.now() - (30 + private.member_stress_pick(k.s || ':cage' || k.rn, 300) || ' days')::interval,
        updated_at = pg_catalog.now() - (private.member_stress_pick(k.s || ':cupd' || k.rn, 30) || ' days')::interval
    from ranked k
    where c.id = k.id;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select m.id, t.s,
        pg_catalog.row_number() over (partition by m.user_id order by m.created_at) as rn
      from public.member_messages m join tgt t on t.user_id = m.user_id
    )
    update public.member_messages m
    set body = (array[
          'Now the employer owes a written Step 2 answer, due at the end of next week.',
          'I filed the grievance this morning — you are copied on the paperwork.',
          'Bring your notes from the meeting and we will go through them together.',
          'They agreed to restore the schedule. I will confirm in writing.',
          'You have the right to a union rep in that meeting. Do not go alone.',
          'The caseload numbers you sent are going into the standards push.'
        ])[1 + private.member_stress_pick(k.s || ':mbody' || k.rn, 6)],
        created_at = pg_catalog.now() - (private.member_stress_pick(k.s || ':mage' || k.rn, 240) || ' days')::interval
    from ranked k
    where m.id = k.id;

  elsif p_phase = 'cases' then
    -- The clone tell this whole migration exists to kill: every member carried
    -- the same four references. Rewrite to a globally unique
    -- GR-<year>-<ordinal><slot> and vary count, type, step and status.
    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s, t.ordinal,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at desc) as rn
      from public.member_cases c join tgt t on t.user_id = c.user_id
    ),
    doomed as (
      -- Keep 0-4 cases per member (mean ~2.2): a fixed four-per-member is as
      -- artificial as identical references.
      delete from public.member_cases c
      using ranked k
      where c.id = k.id
        and k.rn > private.member_stress_pick(k.s || ':ncases', 5)
      returning 1
    )
    select pg_catalog.count(*) into touched from doomed;

    with tgt as (
      select l.ordinal, l.user_id, seed || ':' || l.ordinal::text as s
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
    ),
    ranked as (
      select c.id, t.s, t.ordinal,
        pg_catalog.row_number() over (partition by c.user_id order by c.created_at desc) as rn
      from public.member_cases c join tgt t on t.user_id = c.user_id
    ),
    shaped as (
      select k.*,
        private.member_stress_pick(k.s || ':ctype' || k.rn, 6) as type_idx,
        private.member_stress_pick(k.s || ':cage' || k.rn, 900) as age_days
      from ranked k
    )
    update public.member_cases c
    set reference = 'GR-' || pg_catalog.to_char(pg_catalog.now() - (s.age_days || ' days')::interval, 'YYYY')
          || '-' || pg_catalog.lpad(((s.ordinal - 1) * 4 + s.rn)::text, 7, '0'),
        case_type = (array['Discipline','Telework','Safety','Scheduling','Caseload','Contract'])[1 + s.type_idx],
        title = (array[
          'Step 2 — discipline','Telework schedule restored','Safety equipment issued',
          'Scheduling shift corrected','Caseload above the standard','Contract language dispute'
        ])[1 + s.type_idx],
        articles = (array[
          'Article 12 — Discipline · Article 3 — Union Rights and Representation',
          'Article 7 — Hours of Work',
          'Article 16 — Health and Safety',
          'Article 7 — Hours of Work',
          'Article 24 — Workload',
          'Article 5 — Management Rights'
        ])[1 + s.type_idx],
        step = case when s.age_days < 120 then (array['Step 1','Step 2','Step 3'])[1 + private.member_stress_pick(s.s || ':cstep' || s.rn, 3)] else 'Closed' end,
        status = case when s.age_days < 120 then 'active' else 'resolved' end,
        deadline = (pg_catalog.now() - (s.age_days || ' days')::interval + interval '30 days')::date,
        created_at = pg_catalog.now() - (s.age_days || ' days')::interval,
        updated_at = pg_catalog.now() - (s.age_days / 2 || ' days')::interval
    from shaped s
    where c.id = s.id;

    -- Case timelines: 0-3 updates on each surviving case.
    insert into public.member_case_updates (case_id, user_id, body, created_at)
    select c.id, c.user_id,
      (array[
        'Filed with the area office and logged by the steward.',
        'Step 1 meeting held; the employer asked for a week to respond.',
        'Written answer received — escalating to the next step.',
        'Resolved. The member confirmed the correction took effect.'
      ])[1 + private.member_stress_pick(t.s || ':cu' || c.id::text || g.i::text, 4)],
      c.created_at + (g.i * (7 + private.member_stress_pick(t.s || ':cud' || c.id::text || g.i::text, 20)) || ' days')::interval
    from private.member_stress_ledger l
    join public.member_cases c on c.user_id = l.user_id
    cross join lateral (select seed || ':' || l.ordinal::text as s) t
    cross join lateral generate_series(1, private.member_stress_pick(t.s || ':nupd' || c.id::text, 4)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict do nothing;

  elsif p_phase = 'rights' then
    -- 1-5 of the five live lessons, at varying completion depth. The
    -- completed_steps CHECK (cardinality <= 64, migration 20260725160000) is
    -- nowhere near binding at three steps.
    -- A CASE, not a subscripted nested array: `(array[array[0], array[0,1]])[n]`
    -- reads as a single-element access on a 2-D array and yields integer, not
    -- integer[], which the column rejects.
    insert into public.member_rights_progress (lesson_id, user_id, completed_steps)
    select les.id, l.user_id,
      case private.member_stress_pick(seed || ':' || l.ordinal::text || ':rp' || les.id, 3)
        when 0 then array[0]
        when 1 then array[0, 1]
        else array[0, 1, 2]
      end
    from private.member_stress_ledger l
    cross join public.member_rights_lessons les
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':rl' || les.id) < 0.42
    on conflict (lesson_id, user_id) do nothing;
    get diagnostics touched = row_count;

  elsif p_phase = 'participation' then
    -- RSVPs across all events; check-ins only against events that have already
    -- happened, and only for members who RSVP'd.
    -- status is constrained to ('going','not_going') — there is no 'maybe'.
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select e.id, l.user_id,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':rs' || e.id) < 0.82 then 'going' else 'not_going' end,
      e.starts_at - interval '14 days', e.starts_at - interval '14 days'
    from private.member_stress_ledger l
    cross join public.member_events e
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':rv' || e.id) < 0.26
    on conflict (event_id, user_id) do nothing;
    get diagnostics touched = row_count;

    insert into public.member_event_checkins (event_id, user_id, checked_in_at, scanned_by)
    select r.event_id, r.user_id, e.starts_at + interval '12 minutes', null
    from public.member_event_rsvps r
    join public.member_events e on e.id = r.event_id
    join private.member_stress_ledger l on l.user_id = r.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and e.starts_at < pg_catalog.now()
      and r.status = 'going'
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':ci' || r.event_id) < 0.61
    on conflict (event_id, user_id) do nothing;

    -- Surveys: the two closed pulses take broad participation, the live one less.
    insert into public.member_survey_responses (survey_id, option_id, user_id, submitted_at)
    select o.survey_id, o.id, l.user_id,
      coalesce(s.closes_at, pg_catalog.now()) - (1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':sd' || o.survey_id, 20) || ' days')::interval
    from private.member_stress_ledger l
    cross join public.member_surveys s
    join public.member_survey_options o on o.survey_id = s.id
      and o.order_index = 1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':so' || s.id,
        (select pg_catalog.count(*)::integer from public.member_survey_options o2 where o2.survey_id = s.id))
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':sv' || s.id) < case when s.active then 0.19 else 0.34 end
    on conflict (survey_id, user_id) do nothing;

    insert into public.member_broadcast_receipts (broadcast_id, user_id, read_at)
    select b.id, l.user_id,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':br' || b.id, 200) || ' days')::interval
    from private.member_stress_ledger l
    cross join public.member_broadcasts b
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':bc' || b.id) < 0.34
    on conflict (broadcast_id, user_id) do nothing;

    -- Steward requests are INSERTED in their FINAL status. An UPDATE here would
    -- fire member_steward_requests_award_on_ack (20260725230000) and mint the
    -- steward award at now() for every row — see this file's header.
    insert into public.member_steward_requests (user_id, lesson_id, status, created_at, acknowledged_at, closed_at, handled_by)
    select l.user_id,
      (select les.id from public.member_rights_lessons les
        order by les.id
        offset private.member_stress_pick(seed || ':' || l.ordinal::text || ':srl', 5) limit 1),
      (array['acknowledged','closed','closed','requested'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4)],
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':srd', 400) || ' days')::interval,
      case when private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4) < 3
        then pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':sra', 380) || ' days')::interval end,
      case when private.member_stress_pick(seed || ':' || l.ordinal::text || ':srs', 4) between 1 and 2
        then pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':src', 360) || ' days')::interval end,
      null
    from private.member_stress_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':sr') < 0.11
    on conflict do nothing;

    insert into public.member_forms (user_id, template_key, template_version, status, answers, step, submitted_at, created_at, updated_at)
    select l.user_id, ft.key, ft.version,
      (array['submitted','approved','approved','draft'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':fs', 4)],
      '{}'::jsonb, 0,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fd', 300) || ' days')::interval,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fd', 300) || ' days')::interval,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':fu', 200) || ' days')::interval
    from private.member_stress_ledger l
    join lateral (
      select f.key, f.version from public.form_templates f where f.active
      order by f.key
      offset private.member_stress_pick(seed || ':' || l.ordinal::text || ':ft',
        (select pg_catalog.count(*)::integer from public.form_templates where active))
      limit 1
    ) ft on true
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':fm') < 0.15
    on conflict do nothing;

    -- Three constraints govern this table and all three are easy to trip:
    -- receipt_code must match '^[0-9a-f]{8}$' (lower-case, exactly 8), every
    -- count column is bounded 0..300, and pt_hours_when_part_time requires a
    -- non-null pt_hours whenever employment is 'part_time'.
    insert into public.member_workload_logs (user_id, priority, pending, unread_docs, todos, referrals,
      ce_activities, assistance_requests, aged_cases, weekly_assigned, employment, pt_hours, receipt_code,
      created_at, logged_on)
    select l.user_id,
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wp', 12),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wpe', 40),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wu', 25),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wt', 30),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wr', 15),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wc', 8),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wa', 10),
      private.member_stress_pick(seed || ':' || l.ordinal::text || ':wg', 18),
      10 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':ww', 25),
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':we') < 0.86 then 'full_time' else 'part_time' end,
      case when private.member_stress_rand(seed || ':' || l.ordinal::text || ':we') < 0.86 then null
        else (16 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':wph', 24))::smallint end,
      pg_catalog.substr(pg_catalog.md5(seed || ':wrc:' || l.ordinal::text), 1, 8),
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':wd', 120) || ' days')::interval,
      (pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':wd', 120) || ' days')::interval)::date
    from private.member_stress_ledger l
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':wl') < 0.23
    on conflict do nothing;

    with threads as (
      insert into public.member_guide_threads (user_id, title, created_at, updated_at)
      select l.user_id,
        (array[
          'What are my Weingarten rights?','How do I file a grievance?',
          'Can they change my schedule without notice?','What counts as a safety refusal?',
          'How much notice for a shift change?'
        ])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':gt', 5)],
        pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':gd', 180) || ' days')::interval,
        pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':gd', 180) || ' days')::interval
      from private.member_stress_ledger l
      where l.run_id = p_run_id and l.ordinal between lo and hi
        and private.member_stress_rand(seed || ':' || l.ordinal::text || ':gv') < 0.09
      returning id, user_id, title, created_at
    )
    insert into public.member_guide_messages (thread_id, user_id, role, body, created_at)
    select t.id, t.user_id, m.role, m.body, t.created_at + m.offs
    from threads t
    cross join lateral (values
      ('user', t.title, interval '0 minutes'),
      ('assistant', 'Here is what your contract and the law say, with the article citations.', interval '9 seconds')
    ) as m(role, body, offs);

  elsif p_phase = 'ballots' then
    -- Turnout on each ballot, weighted lower on the still-open one. Votes are
    -- stored unlinkably since 20260808230000: participation lives in
    -- member_ballot_receipts and the choice sits in member_ballot_choices with
    -- no voter column, so enrichment issues a receipt per synthetic voter and
    -- files the matching anonymous choice only when that receipt is new
    -- (re-runs and the two real votes on ballot-2026 both surface as an
    -- existing receipt and are skipped). Choices carry stress_run_id so
    -- removal can sweep what the auth.users cascade cannot reach.
    for pick in
      select b.id as ballot_id, o.id as option_id, l.user_id
      from private.member_stress_ledger l
      cross join public.member_ballots b
      join public.member_ballot_options o on o.ballot_id = b.id
        and o.order_index = 1 + case
          when private.member_stress_rand(seed || ':' || l.ordinal::text || ':bo' || b.id) < 0.74 then 0
          when private.member_stress_rand(seed || ':' || l.ordinal::text || ':bo' || b.id) < 0.93 then 1
          else 2 end
      where l.run_id = p_run_id and l.ordinal between lo and hi
        and private.member_stress_rand(seed || ':' || l.ordinal::text || ':bv' || b.id) < case when b.active then 0.31 else 0.38 end
    loop
      if private.issue_ballot_receipt(pick.ballot_id, pick.user_id) is not null then
        insert into public.member_ballot_choices (ballot_id, option_id, stress_run_id)
        values (pick.ballot_id, pick.option_id, p_run_id);
        touched := touched + 1;
      end if;
    end loop;

  elsif p_phase = 'points' then
    -- Direct, BACKDATED inserts. Routing these through member_action_log would
    -- hand them to private.award_member_points, which stamps occurred_at =
    -- now() and enforces per-kind weekly caps — collapsing 100k members'
    -- histories into the current week and paying almost none of them.
    insert into public.member_point_events (user_id, action_key, action_kind, points, occurred_at)
    select l.user_id,
      'hist-' || l.ordinal::text || '-' || g.i::text,
      (array['vote','survey','rights','case','rsvp','checkin','form','message'])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pk' || g.i::text, 8)],
      (array[20, 10, 15, 25, 40, 50, 15, 2])[1 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pk' || g.i::text, 8)],
      pg_catalog.now() - (7 + private.member_stress_pick(seed || ':' || l.ordinal::text || ':pd' || g.i::text, 540) || ' days')::interval
    from private.member_stress_ledger l
    cross join lateral generate_series(1, private.member_stress_pick(seed || ':' || l.ordinal::text || ':pn', 11)) g(i)
    where l.run_id = p_run_id and l.ordinal between lo and hi
    on conflict (user_id, action_key) do nothing;
    get diagnostics touched = row_count;

  elsif p_phase = 'roles' then
    -- Chapter-scoped stewards, roughly 1 per 90 members, so the steward desk
    -- and get_steward_chapter_member_count have realistic scoped populations.
    insert into public.member_roles (user_id, role, chapter_id, granted_at, granted_by)
    select l.user_id, 'steward', mp.chapter_id,
      pg_catalog.now() - (private.member_stress_pick(seed || ':' || l.ordinal::text || ':rg', 700) || ' days')::interval,
      null
    from private.member_stress_ledger l
    join public.member_profiles mp on mp.id = l.user_id
    where l.run_id = p_run_id and l.ordinal between lo and hi
      and private.member_stress_rand(seed || ':' || l.ordinal::text || ':stw') < 0.011
    on conflict (user_id, role) do nothing;
    get diagnostics touched = row_count;

  else
    raise exception 'unknown enrichment phase %', p_phase;
  end if;

  return jsonb_build_object('phase', p_phase, 'from', lo, 'to', hi, 'touched', touched);
end;
$$;

create or replace function public.member_stress_enrich_verify(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '300s'
as $$
declare
  run private.member_stress_runs%rowtype;
  result jsonb;
  chapters_used integer;
  max_share double precision;
  cases_total bigint;
  cases_distinct bigint;
  typed_kinds bigint;
  deliveries bigint;
  fresh_points bigint;
  passed boolean;
begin
  if (select auth.role()) <> 'service_role' then raise exception 'member stress RPC requires service_role'; end if;
  select * into run from private.member_stress_runs where id = p_run_id;
  if not found then raise exception 'unknown member stress run'; end if;

  select pg_catalog.count(distinct mp.chapter_id),
         -- GREATEST is a grammar construct, not a function: it cannot be
         -- schema-qualified (tests/admin-plane.test.js pins this repo-wide).
         pg_catalog.max(share.n)::double precision / greatest(run.member_count, 1)
    into chapters_used, max_share
  from public.member_profiles mp
  join private.member_stress_ledger l on l.user_id = mp.id and l.run_id = p_run_id
  cross join lateral (
    select pg_catalog.count(*) as n from public.member_profiles p2
    join private.member_stress_ledger l2 on l2.user_id = p2.id and l2.run_id = p_run_id
    where p2.chapter_id = mp.chapter_id
  ) share;

  select pg_catalog.count(*), pg_catalog.count(distinct c.reference)
    into cases_total, cases_distinct
  from public.member_cases c
  join private.member_stress_ledger l on l.user_id = c.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into typed_kinds
  from public.member_notifications n
  join private.member_stress_ledger l on l.user_id = n.user_id and l.run_id = p_run_id
  where n.kind <> 'general';

  select pg_catalog.count(*) into deliveries
  from public.member_notification_deliveries d
  join private.member_stress_ledger l on l.user_id = d.user_id and l.run_id = p_run_id;

  select pg_catalog.count(*) into fresh_points
  from public.member_point_events e
  join private.member_stress_ledger l on l.user_id = e.user_id and l.run_id = p_run_id
  where e.occurred_at >= pg_catalog.date_trunc('week', pg_catalog.now());

  result := jsonb_build_object(
    'run_id', p_run_id,
    'members', run.member_count,
    'chapters_used', chapters_used,
    'largest_chapter_share', pg_catalog.round(max_share::numeric, 4),
    'cases', cases_total,
    'cases_distinct_refs', cases_distinct,
    'typed_notification_kinds', typed_kinds,
    'outbound_deliveries', deliveries,
    'points_in_current_week', fresh_points,
    'rights_progress', (select pg_catalog.count(*) from public.member_rights_progress r join private.member_stress_ledger l on l.user_id = r.user_id and l.run_id = p_run_id),
    'ballot_votes', (select pg_catalog.count(*) from public.member_ballot_choices c where c.stress_run_id = p_run_id),
    'ballot_receipts', (select pg_catalog.count(*) from public.member_ballot_receipts b join private.member_stress_ledger l on l.user_id = b.user_id and l.run_id = p_run_id),
    'event_rsvps', (select pg_catalog.count(*) from public.member_event_rsvps r join private.member_stress_ledger l on l.user_id = r.user_id and l.run_id = p_run_id),
    'event_checkins', (select pg_catalog.count(*) from public.member_event_checkins c join private.member_stress_ledger l on l.user_id = c.user_id and l.run_id = p_run_id),
    'survey_responses', (select pg_catalog.count(*) from public.member_survey_responses s join private.member_stress_ledger l on l.user_id = s.user_id and l.run_id = p_run_id),
    'broadcast_receipts', (select pg_catalog.count(*) from public.member_broadcast_receipts b join private.member_stress_ledger l on l.user_id = b.user_id and l.run_id = p_run_id),
    'steward_requests', (select pg_catalog.count(*) from public.member_steward_requests s join private.member_stress_ledger l on l.user_id = s.user_id and l.run_id = p_run_id),
    'forms', (select pg_catalog.count(*) from public.member_forms f join private.member_stress_ledger l on l.user_id = f.user_id and l.run_id = p_run_id),
    'workload_logs', (select pg_catalog.count(*) from public.member_workload_logs w join private.member_stress_ledger l on l.user_id = w.user_id and l.run_id = p_run_id),
    'guide_threads', (select pg_catalog.count(*) from public.member_guide_threads t join private.member_stress_ledger l on l.user_id = t.user_id and l.run_id = p_run_id),
    'case_updates', (select pg_catalog.count(*) from public.member_case_updates u join private.member_stress_ledger l on l.user_id = u.user_id and l.run_id = p_run_id),
    'point_events', (select pg_catalog.count(*) from public.member_point_events e join private.member_stress_ledger l on l.user_id = e.user_id and l.run_id = p_run_id),
    'steward_roles', (select pg_catalog.count(*) from public.member_roles r join private.member_stress_ledger l on l.user_id = r.user_id and l.run_id = p_run_id),
    'protected_unchanged', run.protected_snapshot = private.member_stress_protected_snapshot(p_run_id)
  );

  passed :=
    chapters_used >= 29
    and max_share <= 0.12
    and cases_total = cases_distinct
    and typed_kinds = 0
    and deliveries = 0
    and fresh_points = 0
    and (result ->> 'protected_unchanged')::boolean;

  return result || jsonb_build_object('ok', passed);
end;
$$;

create or replace function public.member_stress_remove_batch(
  p_run_id uuid,
  p_batch_count integer,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  run private.member_stress_runs%rowtype;
  deleted_count bigint;
  remaining bigint;
begin
  perform private.member_stress_authorize(p_target_ref, p_confirm_token);
  if p_batch_count not between 1 and 5000 then raise exception 'invalid removal batch size'; end if;
  select * into run from private.member_stress_runs where id = p_run_id for update;
  if not found then raise exception 'unknown member stress run'; end if;
  if run.state = 'removed' then return jsonb_build_object('deleted', 0, 'remaining', 0, 'state', 'removed'); end if;
  if run.state <> 'removing' then raise exception 'removal preflight has not passed'; end if;

  with selected as (
    select users.id
    from auth.users users
    join private.member_stress_ledger ledger on ledger.user_id = users.id
    where ledger.run_id = p_run_id
      and lower(users.email) = ledger.email
      and users.raw_app_meta_data ->> 'member_stress_run_id' = p_run_id::text
    order by ledger.ordinal
    limit p_batch_count
  ), deleted as (
    delete from auth.users users using selected where users.id = selected.id returning users.id
  ) select count(*) into deleted_count from deleted;

  select count(*) into remaining from auth.users users
  join private.member_stress_ledger ledger on ledger.user_id = users.id where ledger.run_id = p_run_id;
  if remaining = 0 then
    if run.protected_snapshot <> private.member_stress_protected_snapshot(p_run_id) then
      raise exception 'non-stress user snapshot changed during removal';
    end if;
    -- Synthetic ballot choices carry no user_id, so the auth.users cascade
    -- cannot reach them; sweep them by run id before the run closes.
    delete from public.member_ballot_choices where stress_run_id = p_run_id;
    update private.member_stress_runs set state = 'removed', removed_at = now(), updated_at = now() where id = p_run_id;
  end if;
  return jsonb_build_object('deleted', deleted_count, 'remaining', remaining,
    'state', case when remaining = 0 then 'removed' else 'removing' end);
end;
$$;
