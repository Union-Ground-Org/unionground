-- REQ-UG-DESIGN-BACKEND-P1-20260721: rewards engine + ballot receipts + quorum.
-- Points are awarded ONLY by a security-definer trigger on member_action_log so
-- clients can never forge point values; receipts are issued ONLY by a trigger on
-- first ballot vote and the public verify path never exposes voter or choice.

create table public.member_point_rules (
  action_kind text primary key,
  label text not null,
  points integer not null check (points between 0 and 100),
  weekly_cap integer check (weekly_cap is null or weekly_cap > 0)
);

create table public.member_reward_tiers (
  tier smallint primary key,
  name text not null unique,
  min_points integer not null unique check (min_points >= 0)
);

create table public.member_point_events (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_key text not null,
  action_kind text not null,
  points integer not null check (points between 1 and 100),
  occurred_at timestamptz not null default now(),
  unique (user_id, action_key)
);

create table public.member_ballot_receipts (
  id uuid primary key default extensions.gen_random_uuid(),
  ballot_id text not null references public.member_ballots(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt_code text not null unique check (receipt_code ~ '^SG-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$'),
  counted boolean not null default true,
  issued_at timestamptz not null default now(),
  unique (ballot_id, user_id)
);

alter table public.member_ballots
  add column quorum_target integer check (quorum_target is null or quorum_target > 0);

create index member_point_events_user_occurred_idx on public.member_point_events(user_id, occurred_at desc);
create index member_ballot_receipts_user_idx on public.member_ballot_receipts(user_id);

insert into public.member_point_rules (action_kind, label, points, weekly_cap) values
  ('vote', 'Cast a ballot', 20, null),
  ('survey', 'Answer a member pulse', 10, null),
  ('rights', 'Complete a rights lesson', 15, null),
  ('case', 'File a case', 25, 3),
  ('message', 'Message your steward', 2, 5),
  ('steward', 'Request steward support', 10, 3);

insert into public.member_reward_tiers (tier, name, min_points) values
  (1, 'Member', 0),
  (2, 'Backer', 100),
  (3, 'Organizer', 300),
  (4, 'Steward-Ready', 700),
  (5, 'Architect', 1500);

update public.member_ballots set quorum_target = 200 where id = 'ballot-2026';

-- Awards fire only when the action key is backed by a real entity the caller
-- owns (vote row, survey response, rights progress, case, conversation,
-- steward request); free-form action_log inserts earn nothing, and per-kind
-- weekly caps bound the kinds whose keys are client-varied.
create function private.award_member_points()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  rule record;
  backed boolean := false;
  awarded_this_week integer;
begin
  if new.action_kind = 'seed' then
    return new;
  end if;

  select points, weekly_cap into rule
  from public.member_point_rules
  where action_kind = new.action_kind
    and points > 0;

  if not found then
    return new;
  end if;

  if new.action_kind = 'vote' then
    backed := exists (
      select 1 from public.member_ballot_votes
      where user_id = new.user_id and ballot_id = pg_catalog.substr(new.action_key, 6)
    );
  elsif new.action_kind = 'survey' then
    backed := exists (
      select 1 from public.member_survey_responses
      where user_id = new.user_id and survey_id = pg_catalog.substr(new.action_key, 8)
    );
  elsif new.action_kind = 'rights' then
    backed := exists (
      select 1 from public.member_rights_progress
      where user_id = new.user_id
        and lesson_id = pg_catalog.substr(new.action_key, 8)
        and pg_catalog.cardinality(completed_steps) > 0
    );
  elsif new.action_kind = 'case' then
    backed := exists (
      select 1 from public.member_cases
      where user_id = new.user_id and reference = pg_catalog.substr(new.action_key, 6)
    );
  elsif new.action_kind = 'message' then
    backed := exists (
      select 1 from public.member_conversations
      where user_id = new.user_id
        and id::text = (pg_catalog.regexp_match(new.action_key, '^message-(.*)-[0-9]+$'))[1]
    );
  elsif new.action_kind = 'steward' then
    backed := exists (
      select 1 from public.member_steward_requests
      where user_id = new.user_id
        and coalesce(lesson_id, '') = coalesce((pg_catalog.regexp_match(new.action_key, '^steward-(.*)-[0-9]+$'))[1], '')
    );
  end if;

  if not backed then
    return new;
  end if;

  if rule.weekly_cap is not null then
    select count(*) into awarded_this_week
    from public.member_point_events
    where user_id = new.user_id
      and action_kind = new.action_kind
      and occurred_at >= pg_catalog.date_trunc('week', now());
    if awarded_this_week >= rule.weekly_cap then
      return new;
    end if;
  end if;

  insert into public.member_point_events (user_id, action_key, action_kind, points)
  values (new.user_id, new.action_key, new.action_kind, rule.points)
  on conflict (user_id, action_key) do nothing;
  return new;
end;
$$;

create trigger member_action_log_award_points
  after insert on public.member_action_log
  for each row execute function private.award_member_points();

-- Crockford-style base32 alphabet (no I, L, O, U) so codes match the design's
-- SG-XXXX-XXXX examples while staying unambiguous to read aloud.
create function private.member_receipt_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea := extensions.gen_random_bytes(8);
  code text := '';
  i integer;
begin
  for i in 0..7 loop
    code := code || pg_catalog.substr(alphabet, (pg_catalog.get_byte(bytes, i) % 32) + 1, 1);
    if i = 3 then
      code := code || '-';
    end if;
  end loop;
  return 'SG-' || code;
end;
$$;

create function private.issue_member_ballot_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  code text;
  attempts integer := 0;
begin
  loop
    code := private.member_receipt_code();
    begin
      insert into public.member_ballot_receipts (ballot_id, user_id, receipt_code)
      values (new.ballot_id, new.user_id, code)
      on conflict (ballot_id, user_id) do nothing;
      return new;
    exception when unique_violation then
      attempts := attempts + 1;
      if attempts >= 3 then
        raise;
      end if;
    end;
  end loop;
end;
$$;

create trigger member_ballot_votes_issue_receipt
  after insert on public.member_ballot_votes
  for each row execute function private.issue_member_ballot_receipt();

-- Backfill: award points for the existing action history and issue receipts for
-- existing votes so current members see real totals immediately.
insert into public.member_point_events (user_id, action_key, action_kind, points, occurred_at)
select log.user_id, log.action_key, log.action_kind, rules.points, log.occurred_at
from public.member_action_log as log
join public.member_point_rules as rules on rules.action_kind = log.action_kind
where rules.points > 0
on conflict (user_id, action_key) do nothing;

do $$
declare
  vote record;
  attempts integer;
begin
  for vote in select ballot_id, user_id from public.member_ballot_votes loop
    attempts := 0;
    loop
      begin
        insert into public.member_ballot_receipts (ballot_id, user_id, receipt_code)
        values (vote.ballot_id, vote.user_id, private.member_receipt_code())
        on conflict (ballot_id, user_id) do nothing;
        exit;
      exception when unique_violation then
        attempts := attempts + 1;
        if attempts >= 3 then
          raise;
        end if;
      end;
    end loop;
  end loop;
end;
$$;

create function public.get_member_rewards_summary()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  total integer;
  tier_row record;
  next_row record;
  streak integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select coalesce(sum(points), 0) into total
  from public.member_point_events
  where user_id = caller;

  select tier, name, min_points into tier_row
  from public.member_reward_tiers
  where min_points <= total
  order by min_points desc
  limit 1;

  select name, min_points into next_row
  from public.member_reward_tiers
  where min_points > total
  order by min_points asc
  limit 1;

  with action_weeks as (
    select distinct pg_catalog.date_trunc('week', occurred_at) as wk
    from public.member_action_log
    where user_id = caller
      and action_kind <> 'seed'
  ), anchored as (
    select wk, pg_catalog.row_number() over (order by wk desc) as rn,
      max(wk) over () as anchor
    from action_weeks
  )
  select count(*) into streak
  from anchored
  where anchor >= pg_catalog.date_trunc('week', now()) - interval '7 days'
    and wk = anchor - ((rn - 1) * interval '7 days');

  return pg_catalog.jsonb_build_object(
    'totalPoints', total,
    'tierNumber', coalesce(tier_row.tier, 1),
    'tierName', coalesce(tier_row.name, 'Member'),
    'nextTierName', next_row.name,
    'pointsToGo', case when next_row.min_points is null then null else next_row.min_points - total end,
    'weekStreak', coalesce(streak, 0)
  );
end;
$$;

create function public.get_ballot_tally(p_ballot_id text)
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

  select count(*) into total
  from public.member_ballot_votes
  where ballot_id = ballot.id;

  if not ballot.active then
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('optionId', counts.option_id, 'label', counts.label, 'votes', counts.votes)
      order by counts.order_index
    ), '[]'::jsonb) into option_counts
    from (
      select options.id as option_id, options.label, options.order_index, count(votes.option_id) as votes
      from public.member_ballot_options as options
      left join public.member_ballot_votes as votes
        on votes.ballot_id = options.ballot_id and votes.option_id = options.id
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

create function public.verify_ballot_receipt(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  clean_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
  receipt record;
begin
  if clean_code !~ '^SG-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$' then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  select receipts.counted, receipts.issued_at, ballots.title into receipt
  from public.member_ballot_receipts as receipts
  join public.member_ballots as ballots on ballots.id = receipts.ballot_id
  where receipts.receipt_code = clean_code;

  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'ballotTitle', receipt.title,
    'counted', receipt.counted,
    'issuedAt', receipt.issued_at
  );
end;
$$;

alter table public.member_point_rules enable row level security;
alter table public.member_reward_tiers enable row level security;
alter table public.member_point_events enable row level security;
alter table public.member_ballot_receipts enable row level security;

create policy member_point_rules_select_all on public.member_point_rules for select to authenticated using (true);
create policy member_reward_tiers_select_all on public.member_reward_tiers for select to authenticated using (true);
create policy member_point_events_select_own on public.member_point_events for select to authenticated using ((select auth.uid()) = user_id);
create policy member_ballot_receipts_select_own on public.member_ballot_receipts for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.member_point_rules from anon, authenticated;
revoke all on public.member_reward_tiers from anon, authenticated;
revoke all on public.member_point_events from anon, authenticated;
revoke all on public.member_ballot_receipts from anon, authenticated;

grant select on public.member_point_rules to authenticated;
grant select on public.member_reward_tiers to authenticated;
grant select on public.member_point_events to authenticated;
grant select on public.member_ballot_receipts to authenticated;

revoke all on function public.get_member_rewards_summary() from public, anon;
revoke all on function public.get_ballot_tally(text) from public, anon;
revoke all on function public.verify_ballot_receipt(text) from public;

grant execute on function public.get_member_rewards_summary() to authenticated;
grant execute on function public.get_ballot_tally(text) to authenticated;
grant execute on function public.verify_ballot_receipt(text) to anon, authenticated;
