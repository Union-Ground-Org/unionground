-- REQ-UG-FULL-DEPTH-20260723 (PR3, part A): signed event check-in with a
-- steward scanner.
--
-- The existing self-check-in (check_in_to_event + the static per-event
-- SG-code posted on-site) STAYS: it is the only workable path for unstaffed
-- events (a rally, an overflow Zoom), it carries live data and passing tests,
-- and both paths converge on the same member_event_checkins row so they can
-- never double-award. This migration adds a higher-assurance option for
-- staffed doors: the member requests a short-lived single-use code on their
-- own phone and a steward redeems it, which records who scanned whom and pays
-- the scanner a capped +15.
--
-- Token design: a server-issued opaque 7-char Crockford-base32 code (the
-- ballot-receipt alphabet — no I/L/O/U), stored ONLY as its sha256 hash with
-- a 90-second TTL and single-use consumption. A stateless HMAC was rejected:
-- the scanner must resolve code -> member, which a one-way MAC cannot do
-- without embedding the member id in the code itself and ballooning it past
-- a typeable length.

-- 1) Token store. Private schema (already revoked from public/anon/
--    authenticated at creation); the explicit revoke below is belt-and-
--    suspenders, matching the member_stress_* style. Consumed rows are kept
--    as a who-scanned-whom audit trail (bounded by real attendance);
--    unconsumed rows are replaced on every re-request, so the table cannot
--    grow past one live token per (event, member).
create table private.member_event_checkin_tokens (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id text not null references public.member_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- The scan RPC looks tokens up by (event_id, token_hash) without filtering on
-- consumed_at (a consumed token must be distinguishable from an unknown one),
-- so this index is deliberately NOT partial.
create index member_event_checkin_tokens_lookup_idx
  on private.member_event_checkin_tokens(event_id, token_hash);
create index member_event_checkin_tokens_user_event_idx
  on private.member_event_checkin_tokens(user_id, event_id);

revoke all on private.member_event_checkin_tokens from public, anon, authenticated;

-- 2) Record who scanned each check-in. A staff identity is never
--    member-readable (same privacy discipline as member_steward_requests'
--    handled_by), so the previous table-level SELECT grant becomes a
--    column-scoped one that excludes scanned_by.
alter table public.member_event_checkins
  add column scanned_by uuid references auth.users(id) on delete set null;

revoke select on public.member_event_checkins from authenticated;
grant select (event_id, user_id, checked_in_at) on public.member_event_checkins to authenticated;

-- 3) New 'scan' action kind: widen the CHECK to a strict superset (drop +
--    re-add in one migration; missing any live value would break every log
--    insert) and seed its point rule. weekly_cap = 20 bounds what a
--    compromised or colluding steward account can mint at one event while
--    covering a legitimate big door shift; the exact cap is tunable the same
--    way the form rule's is.
alter table public.member_action_log drop constraint member_action_log_action_kind_check;
alter table public.member_action_log
  add constraint member_action_log_action_kind_check
  check (action_kind in ('seed', 'vote', 'survey', 'rights', 'case', 'message', 'steward', 'rsvp', 'checkin', 'workload', 'form', 'scan'));

insert into public.member_point_rules (action_kind, label, points, weekly_cap) values
  ('scan', 'Check a member in at an event', 15, 20)
on conflict (action_kind) do update set label = excluded.label, points = excluded.points, weekly_cap = excluded.weekly_cap;

-- 4) Re-create the award trigger from its LIVE body (which already carries
--    the workload + per-template form branches) plus the new 'scan' branch.
--    The scan action_key is 'scan-' || <uuid of the scanned member> || '-'
--    || <event_id>, uuid FIRST because it is fixed-length (36 chars): event
--    ids contain hyphens ('evt-2026-chapter-meeting'), so a trailing uuid
--    could not be sliced out unambiguously. Do NOT reorder the segments when
--    extending this branch. The lowercase-only uuid regex both (a) makes the
--    ::uuid cast safe against member-forged keys (members can insert their
--    own action_log rows) and (b) pins ONE canonical spelling per scan —
--    uuid casts are case-insensitive, so without it 'scan-<UPPERCASE>-…'
--    would be a distinct, equally-backed key: the exact re-mint hole the
--    prefix anchors closed.
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
    backed := exists (
      select 1 from public.member_conversations
      where user_id = new.user_id
        and id::text = (pg_catalog.regexp_match(new.action_key, '^message-(.*)-[0-9]+$'))[1]);
  elsif new.action_kind = 'steward' then
    backed := exists (
      select 1 from public.member_steward_requests
      where user_id = new.user_id
        and coalesce(lesson_id, '') = coalesce((pg_catalog.regexp_match(new.action_key, '^steward-(.*)-[0-9]+$'))[1], ''));
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
    -- 'scan-' || uuid || '-' || event_id, uuid first (see the header note).
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

-- 5) Member-side RPC: mint my own short-lived code for an event. Same window
--    as the self-check-in path. Re-requesting replaces any prior unconsumed
--    token, so at most one code per (event, member) is ever live.
create function public.request_event_checkin_token(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev_starts timestamptz;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  plain text := '';
  valid_until timestamptz;
  i integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select starts_at into ev_starts from public.member_events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if now() < ev_starts - interval '2 hours' or now() > ev_starts + interval '4 hours' then
    raise exception 'check-in codes are only available around the event start time' using errcode = '22023';
  end if;

  delete from private.member_event_checkin_tokens
  where event_id = p_event_id and user_id = caller and consumed_at is null;

  bytes := extensions.gen_random_bytes(7);
  for i in 0..6 loop
    plain := plain || pg_catalog.substr(alphabet, (pg_catalog.get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  valid_until := now() + interval '90 seconds';

  insert into private.member_event_checkin_tokens (event_id, user_id, token_hash, expires_at)
  values (p_event_id, caller, pg_catalog.encode(extensions.digest(plain, 'sha256'), 'hex'), valid_until);

  return pg_catalog.jsonb_build_object(
    'token', plain,
    'expiresAt', valid_until,
    'ttlSeconds', 90
  );
end;
$$;

-- 6) Steward-side RPC: redeem a member's code. The row lock serializes two
--    stewards racing on the same code; not-found / consumed / expired are
--    distinct, member-facing messages (no enumeration value here — the code
--    space is opaque and 90-second). Both point awards are read back from
--    member_point_events AFTER the trigger ran so the returned numbers are
--    what was actually minted — 0 on the scanner's weekly cap or on a
--    self-checked-in member (scanned_by stays null there, which un-backs the
--    scanner's key by design) — and the toast never lies.
create function public.scan_event_checkin(p_event_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_token text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_token, '')));
  tok record;
  new_checkin integer := 0;
  member_logged integer := 0;
  scanner_logged integer := 0;
  member_points integer := 0;
  scanner_points integer := 0;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_token = '' then
    raise exception 'enter the member''s check-in code' using errcode = '22023';
  end if;

  select id, user_id, expires_at, consumed_at into tok
  from private.member_event_checkin_tokens
  where event_id = p_event_id
    and token_hash = pg_catalog.encode(extensions.digest(clean_token, 'sha256'), 'hex')
  for update;

  if not found then
    raise exception 'invalid or expired check-in code' using errcode = '22023';
  end if;
  if tok.consumed_at is not null then
    raise exception 'this code has already been used' using errcode = '22023';
  end if;
  if tok.expires_at < now() then
    raise exception 'this code has expired — ask the member to refresh it' using errcode = '22023';
  end if;
  if tok.user_id = caller then
    raise exception 'you cannot scan your own check-in code' using errcode = '22023';
  end if;

  update private.member_event_checkin_tokens
  set consumed_at = now(), consumed_by = caller
  where id = tok.id;

  insert into public.member_event_checkins (event_id, user_id, scanned_by)
  values (p_event_id, tok.user_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (tok.user_id, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics member_logged = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'scan-' || tok.user_id::text || '-' || p_event_id, 'scan')
  on conflict (user_id, action_key) do nothing;
  get diagnostics scanner_logged = row_count;

  if member_logged = 1 then
    select coalesce(pg_catalog.max(points), 0) into member_points
    from public.member_point_events
    where user_id = tok.user_id and action_key = 'checkin-' || p_event_id;
  end if;
  if scanner_logged = 1 then
    select coalesce(pg_catalog.max(points), 0) into scanner_points
    from public.member_point_events
    where user_id = caller and action_key = 'scan-' || tok.user_id::text || '-' || p_event_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'memberUserId', tok.user_id,
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'memberAwardedPoints', member_points,
    'scannerAwardedPoints', scanner_points
  );
end;
$$;

revoke all on function public.request_event_checkin_token(text) from public, anon;
revoke all on function public.scan_event_checkin(text, text) from public, anon;
grant execute on function public.request_event_checkin_token(text) to authenticated;
-- scan_event_checkin's steward gate is enforced in-body via member_has_role,
-- the same pattern as triage_steward_request.
grant execute on function public.scan_event_checkin(text, text) to authenticated;
