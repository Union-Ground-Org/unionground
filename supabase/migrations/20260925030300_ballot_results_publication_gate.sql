-- BUG-UG-BALLOT-RESULTS-NEVER-PUBLISH-AT-CLOSE-20260920
--
-- A ballot closes by the clock (closes_at), not by a staff action, but
-- 20260812140000 narrowed get_ballot_tally's per-option counts to
-- campaign_state = 'closed' — a state only public.close_vote_campaign writes.
-- After closes_at passed a member could no longer vote, was told the results
-- were in, and saw no result bars until a staff member happened to close the
-- campaign by hand. The same generation also left private.ballot_notice_sweep
-- announcing (and pre-stamping results_notice_sent_at for) DRAFT ballots,
-- which get_ballot_tally refuses and the member read policy hides — burning
-- the one notice owed at the ballot's real close. Restore the publication
-- gate 20260809010000 shipped for REQ-UNION-BASE-BALLOT-RESULTS-ELIGIBILITY:
-- counts emit exactly when a vote can no longer be cast, and the sweep only
-- notices ballots whose tally is actually readable. close_vote_campaign,
-- publish_vote_campaign, and the campaign_state/active check constraint are
-- untouched.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The old 15-minute sweep stamped two classes that the new tally still hid:
-- drafts (`not bl.active`, because the campaign_state/active check keeps
-- drafts inactive) and elapsed `campaign_state = 'open'` campaigns
-- (`closes_at <= now()`). Leaving either stamp in place means the next sweep
-- skips them after this gate finally makes their counts readable, so the
-- notice owed at real publication is lost. Clear both before the new filter.
-- Staff-closed rows and unpublished historical pre-stamps stay put.
update public.member_ballots
set results_notice_sent_at = null
where results_notice_sent_at is not null
  and (
    campaign_state = 'draft'
    or (
      campaign_state = 'open'
      and published_at is not null
      and closes_at <= now()
    )
  );

-- Re-created from Main's newest definition (20260924160000, owner-bounded
-- read via private.can_read_vote_campaign,
-- SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920); only the counts gate
-- changes.
create or replace function public.get_ballot_tally(p_ballot_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  ballot record;
  total integer;
  option_counts jsonb;
begin
  if caller is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select id, title, closes_at, active, quorum_target, campaign_state into ballot
  from public.member_ballots
  where id = p_ballot_id and campaign_state <> 'draft'
    and private.can_read_vote_campaign(organization_id, chapter_id);
  if not found then raise exception 'ballot not found' using errcode = '22023'; end if;
  select count(*) into total from public.member_ballot_choices where ballot_id = ballot.id;
  -- Publication gate = exact complement of submit_ballot_vote's refusal
  -- ("if not ballot.active or ballot.closes_at <= now() then raise exception
  -- 'this ballot is closed'"): the moment a vote can no longer be cast, the
  -- counts are readable — no staff close required.
  if not ballot.active or ballot.closes_at <= now() then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'optionId', counts.option_id, 'label', counts.label, 'labelEs', counts.label_es,
      'votes', counts.votes) order by counts.order_index), '[]'::jsonb)
    into option_counts
    from (
      select options.id as option_id, options.label, options.label_es, options.order_index,
        count(choices.option_id) as votes
      from public.member_ballot_options options
      left join public.member_ballot_choices choices
        on choices.ballot_id = options.ballot_id and choices.option_id = options.id
      where options.ballot_id = ballot.id
      group by options.id, options.label, options.label_es, options.order_index
    ) counts;
  end if;
  return pg_catalog.jsonb_build_object('ballotId', ballot.id, 'totalVotes', total,
    'quorumTarget', ballot.quorum_target, 'closesAt', ballot.closes_at,
    'active', ballot.active, 'options', option_counts);
end;
$function$;

-- Re-created from Main's newest definition (20260924020100, tenant-bound
-- recipients via private.ballot_notice_recipients and the 20260907151000
-- case-graph lock preamble); only the results loop gains the draft filter.
create or replace function private.ballot_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed 20260907151000 case-graph lock preamble.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  b record;
  m record;
begin
  -- Ballot became open (new since the last tick; existing ballots were
  -- pre-stamped at migration time).
  for b in
    select bl.id, bl.chapter_id, bl.created_by from public.member_ballots bl
    where bl.active
      and bl.closes_at > now()
      and bl.opened_notice_sent_at is null
    for update skip locked
  loop
    update public.member_ballots set opened_notice_sent_at = now() where id = b.id;
    for m in
      select r.user_id from private.ballot_notice_recipients(b.chapter_id, b.created_by) r
    loop
      perform private.notify_member(m.user_id, 'vote.opened', '{}'::jsonb, 'votes');
    end loop;
  end loop;

  -- Closes within a day: remind eligible members who have not voted yet.
  for b in
    select bl.id, bl.chapter_id, bl.created_by from public.member_ballots bl
    where bl.active
      and bl.closing_notice_sent_at is null
      and bl.closes_at > now()
      and bl.closes_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_ballots set closing_notice_sent_at = now() where id = b.id;
    for m in
      select r.user_id from private.ballot_notice_recipients(b.chapter_id, b.created_by) r
      where not exists (
        select 1 from public.member_ballot_receipts rc
        where rc.ballot_id = b.id and rc.user_id = r.user_id
      )
    loop
      perform private.notify_member(m.user_id, 'vote.closing', '{}'::jsonb, 'votes');
    end loop;
  end loop;

  -- Results publish the moment the tally gate opens (get_ballot_tally:
  -- inactive OR closes_at passed). Drafts are excluded: the tally refuses
  -- campaign_state = 'draft' rows, so announcing here would tell members
  -- results exist that neither the tally nor the member read policy will
  -- ever show, and would stamp results_notice_sent_at — permanently
  -- consuming the notice owed at the ballot's real close. Historic ballots
  -- were pre-stamped at migration time, so this only ever fires for a close
  -- that happened since.
  for b in
    select bl.id, bl.chapter_id, bl.created_by from public.member_ballots bl
    where bl.results_notice_sent_at is null
      and bl.campaign_state <> 'draft'
      and (not bl.active or bl.closes_at <= now())
    for update skip locked
  loop
    update public.member_ballots set results_notice_sent_at = now() where id = b.id;
    for m in
      select r.user_id from private.ballot_notice_recipients(b.chapter_id, b.created_by) r
    loop
      perform private.notify_member(m.user_id, 'vote.results', '{}'::jsonb, 'votes');
    end loop;
  end loop;
end;
end;
$function$;

revoke all on function private.ballot_notice_sweep() from public, anon, authenticated, service_role;

comment on function private.ballot_notice_sweep() is
  'UB-SET-01 votes producer: opened / closing-within-24h / results sweeps. Every notice goes to private.ballot_notice_recipients, which bounds recipients to the ballot organization before any chapter targeting. Closing reminder skips receipt holders. Never touches member_ballot_choices.';

commit;
