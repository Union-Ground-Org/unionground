-- Ballot-secrecy hardening — the fix half of the sol adversarial review of
--  (commit 4aa4d3e7b, migration 20260808230000). Four findings land
-- here; the review's remaining findings are dispositioned in the PR thread.
--
--   (1) Same-transaction metadata (xmin) could pair a fresh anonymous choice
--       with the receipt/action-log rows written in the same RPC transaction.
--       private.mix_member_ballot_choices() rewrites every choice row in one
--       transaction, collapsing all per-row xmins into a single shared value;
--       a nightly pg_cron job keeps the window to at most a day, and this
--       migration performs the first mix immediately. Residuals recorded, not
--       hidden: dead tuples keep old xmins until (auto)vacuum, and WAL/PITR/
--       managed backups retain pre-migration history until retention expiry —
--       those live at the storage layer, outside what schema can destroy.
--   (2) Turnout counted receipts while option totals counted choices; a
--       deleted member account cascades its receipt but (by design) never the
--       anonymous choice, so the two could diverge. Every vote total now
--       counts choices: a cast ballot stays counted when the account leaves.
--   (3) A login-capable stress-cohort member voting through the real RPC left
--       a choice no removal could sweep. submit_ballot_vote now stamps the
--       caller's ledger run id; real members are never in the ledger.
--   (4) member_stress_enrich_verify emitted the ballot counters without
--       gating on them; run-scoped choices==receipts now participates in
--       'passed'.
--
-- db-contract co-edits in this commit: ballot-choices-mix cron pin,
-- private.mix_member_ballot_choices entry, submit_ballot_vote needle + fresh
-- bodyMd5.

-- 1) The mixer ---------------------------------------------------------------

create function private.mix_member_ballot_choices()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An identical-value UPDATE still writes a new tuple version, so after this
  -- statement every live choice row carries the mixer transaction's xmin —
  -- per-vote transaction pairing is gone. ~100k rows; trivially cheap nightly.
  update public.member_ballot_choices set ballot_id = ballot_id;
end;
$$;

revoke all on function private.mix_member_ballot_choices() from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    return;
  end if;
  execute 'create extension if not exists pg_cron';

  perform cron.unschedule(jobid) from cron.job where jobname = 'ballot-choices-mix';
  perform cron.schedule(
    'ballot-choices-mix',
    '43 4 * * *',
    $job$ select private.mix_member_ballot_choices(); $job$);
end
$$;

-- First mix now: collapse the xmins of everything written so far (the
-- backfill already shared one transaction; today's live votes did not).
update public.member_ballot_choices set ballot_id = ballot_id;

-- 2) submit_ballot_vote: stress callers get the run stamp --------------------

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

-- 3) Vote totals count cast ballots ------------------------------------------

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

  -- Vote totals count cast ballots, not surviving accounts: receipts cascade
  -- away with auth.users while an anonymous choice (by design) cannot, so
  -- counting receipts here would let turnout drift below the option totals
  -- after an account deletion ( finding 4). A cast ballot
  -- stays counted.
  select count(*) into total
  from public.member_ballot_choices
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
    from public.member_ballot_choices
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
    from public.member_ballot_choices
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

-- 4) Verifier gates on the containment invariant -----------------------------

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

  -- Run-scoped choices==receipts is the containment invariant of the
  -- unlinkable store: every synthetic receipt pairs exactly one run-stamped
  -- choice ( finding 6).
  passed :=
    (result ->> 'ballot_votes')::bigint = (result ->> 'ballot_receipts')::bigint
    and chapters_used >= 29
    and max_share <= 0.12
    and cases_total = cases_distinct
    and typed_kinds = 0
    and deliveries = 0
    and fresh_points = 0
    and (result ->> 'protected_unchanged')::boolean;

  return result || jsonb_build_object('ok', passed);
end;
$$;
