-- REQ-UG-DESIGN-BACKEND-P3-20260722 (part A): events + RSVP + self-check-in,
-- plus a hardening of the point-award trigger.
--
-- Points economy hardening: award_member_points parsed the backing entity id
-- out of member_action_log.action_key with a bare substr and never checked the
-- key's PREFIX. Because members may insert their own action_log rows with any
-- action_key, a member holding one real vote/rsvp/checkin could mint unlimited
-- points by varying the key's leading bytes (e.g. 'AAAAAballot-2026' still has
-- substr(6)='ballot-2026' and is a distinct key, so the per-key unique guard
-- never fires). This migration re-creates the function with an explicit prefix
-- anchor on every substr-based branch, so exactly one canonical key per
-- (kind, entity) can ever be backed. message/steward were already anchored by
-- their '^...-' regex. Only the exploit is denied; legitimate keys are
-- unaffected. RSVP and check-in are additionally written only through the
-- definer RPCs below, and check-in codes never reach the client and are gated
-- to the event window, so attendance points require a code known on-site
-- during the event.

create table public.member_events (
  id text primary key,
  title text not null,
  starts_at timestamptz not null,
  location text not null,
  summary text not null,
  check_in_code text not null check (check_in_code ~ '^SG-[0-9A-Z]{3,12}$'),
  order_index integer not null unique,
  created_at timestamptz not null default now()
);

create table public.member_event_rsvps (
  event_id text not null references public.member_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'going' check (status in ('going', 'not_going')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create table public.member_event_checkins (
  event_id text not null references public.member_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  checked_in_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index member_event_rsvps_user_idx on public.member_event_rsvps(user_id);
create index member_event_checkins_user_idx on public.member_event_checkins(user_id);
create index member_events_starts_at_idx on public.member_events(starts_at);

-- widen the action_kind CHECK to a strict superset (drop + re-add in one
-- migration). Missing any existing value would break every log insert.
alter table public.member_action_log drop constraint member_action_log_action_kind_check;
alter table public.member_action_log
  add constraint member_action_log_action_kind_check
  check (action_kind in ('seed', 'vote', 'survey', 'rights', 'case', 'message', 'steward', 'rsvp', 'checkin'));

insert into public.member_point_rules (action_kind, label, points, weekly_cap) values
  ('rsvp', 'RSVP to an event', 40, null),
  ('checkin', 'Check in at an event', 50, null)
on conflict (action_kind) do update set label = excluded.label, points = excluded.points, weekly_cap = excluded.weekly_cap;

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

  -- Every branch anchors the action_key prefix so only the one canonical key
  -- per (kind, entity) can be backed; without this a varied-prefix key parses
  -- to the same entity and re-awards past the per-key unique guard.
  if new.action_kind = 'vote' then
    backed := pg_catalog.left(new.action_key, 5) = 'vote-' and exists (
      select 1 from public.member_ballot_votes
      where user_id = new.user_id and ballot_id = pg_catalog.substr(new.action_key, 6)
    );
  elsif new.action_kind = 'survey' then
    backed := pg_catalog.left(new.action_key, 7) = 'survey-' and exists (
      select 1 from public.member_survey_responses
      where user_id = new.user_id and survey_id = pg_catalog.substr(new.action_key, 8)
    );
  elsif new.action_kind = 'rights' then
    backed := pg_catalog.left(new.action_key, 7) = 'rights-' and exists (
      select 1 from public.member_rights_progress
      where user_id = new.user_id
        and lesson_id = pg_catalog.substr(new.action_key, 8)
        and pg_catalog.cardinality(completed_steps) > 0
    );
  elsif new.action_kind = 'case' then
    backed := pg_catalog.left(new.action_key, 5) = 'case-' and exists (
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
  elsif new.action_kind = 'rsvp' then
    backed := pg_catalog.left(new.action_key, 5) = 'rsvp-' and exists (
      select 1 from public.member_event_rsvps
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 6)
    );
  elsif new.action_kind = 'checkin' then
    backed := pg_catalog.left(new.action_key, 8) = 'checkin-' and exists (
      select 1 from public.member_event_checkins
      where user_id = new.user_id and event_id = pg_catalog.substr(new.action_key, 9)
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

-- RSVP: atomic definer RPC (upsert the rsvp row + log the action in one
-- transaction, logging only when going) so a going -> not_going -> going flip
-- can never strand the award. Members cannot write member_event_rsvps directly
-- (no client insert/update grant).
create function public.rsvp_to_event(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  awarded integer := 0;
  rule_points integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_status not in ('going', 'not_going') then
    raise exception 'invalid rsvp status' using errcode = '22023';
  end if;
  if not exists (select 1 from public.member_events where id = p_event_id) then
    raise exception 'event not found' using errcode = '22023';
  end if;

  insert into public.member_event_rsvps (event_id, user_id, status, updated_at)
  values (p_event_id, caller, p_status, now())
  on conflict (event_id, user_id) do update set status = excluded.status, updated_at = now();

  if p_status = 'going' then
    insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, 'rsvp-' || p_event_id, 'rsvp')
    on conflict (user_id, action_key) do nothing;
    get diagnostics awarded = row_count;
  end if;

  select points into rule_points from public.member_point_rules where action_kind = 'rsvp';
  return pg_catalog.jsonb_build_object(
    'status', p_status,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
$$;

-- Check-in: definer RPC that validates the per-event code (never exposed to
-- the client) inside the event window, records the check-in and logs the
-- action atomically. The award trigger sees the check-in row written earlier
-- in this same transaction. Members cannot write member_event_checkins
-- directly (no client insert grant), so a forged action_log 'checkin' row has
-- no backing.
create function public.check_in_to_event(p_event_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev record;
  new_checkin integer := 0;
  awarded integer := 0;
  rule_points integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select id, check_in_code, starts_at into ev
  from public.member_events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023';
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, ''))) <> pg_catalog.upper(ev.check_in_code) then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  insert into public.member_event_checkins (event_id, user_id)
  values (p_event_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics awarded = row_count;

  select points into rule_points from public.member_point_rules where action_kind = 'checkin';
  return pg_catalog.jsonb_build_object(
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
$$;

alter table public.member_events enable row level security;
alter table public.member_event_rsvps enable row level security;
alter table public.member_event_checkins enable row level security;

-- events are an org-wide catalog, but the check_in_code column is never
-- granted to clients (column-scoped grant) so it cannot be read from the app.
create policy member_events_select_all on public.member_events for select to authenticated using (true);
create policy member_event_rsvps_select_own on public.member_event_rsvps for select to authenticated using ((select auth.uid()) = user_id);
create policy member_event_checkins_select_own on public.member_event_checkins for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.member_events from anon, authenticated;
revoke all on public.member_event_rsvps from anon, authenticated;
revoke all on public.member_event_checkins from anon, authenticated;

grant select (id, title, starts_at, location, summary, order_index, created_at) on public.member_events to authenticated;
grant select on public.member_event_rsvps to authenticated;
grant select on public.member_event_checkins to authenticated;

revoke all on function public.rsvp_to_event(text, text) from public, anon;
revoke all on function public.check_in_to_event(text, text) from public, anon;
grant execute on function public.rsvp_to_event(text, text) to authenticated;
grant execute on function public.check_in_to_event(text, text) to authenticated;

-- Seed the canon events. The first is live now (its check-in window is open)
-- so the flow is demonstrable; the rest are upcoming. Codes are posted on-site.
insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index) values
  ('evt-2026-chapter-meeting', 'Chapter meeting', now(), 'Pine Harbor office hall + Zoom', 'Bargaining survey vote and contract update.', 'SG-CHAPTER', 1),
  ('evt-2026-steward-training', 'New-steward training', now() + interval '5 days', 'Juniper hall · 30 Example Way', 'Module 3 — Weingarten rights and Step 1 practice.', 'SG-TRAINING', 2),
  ('evt-2026-office-hours', 'Bargaining team office hours', now() + interval '8 days', 'Zoom', 'Tentative-agreement questions answered live.', 'SG-OFFICE', 3),
  ('evt-2026-relief-rally', 'Caseload-relief rally', now() + interval '12 days', 'State House steps', 'Bring your local T-shirt — noon start.', 'SG-RALLY', 4),
  ('evt-2026-ratification-call', 'Ratification results call', now() + interval '16 days', 'Zoom · all chapters', 'Live results of the 2026 contract ratification vote.', 'SG-RATIFY', 5)
on conflict (id) do update set
  title = excluded.title, starts_at = excluded.starts_at, location = excluded.location,
  summary = excluded.summary, check_in_code = excluded.check_in_code, order_index = excluded.order_index;
