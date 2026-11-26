-- Events wave — worklist UB-EVT-05 + UB-EVT-06 (role-map records of the same
-- ids in the Union Base role-function map, Codex artifact 019fdee9).
--
-- UB-EVT-06: event authoring was gated on the admin hat alone inside the
-- definer RPCs, and nothing could cancel or delete an event once it existed.
-- ALL FIVE staff hats author (steward, coordinator,
-- advisor, vp — which is also the President hat — and admin), and removal is
-- cancel-soft plus a hard delete restricted to events nobody attended.
--
-- UB-EVT-05: the scan confirmation returned a bare user id, so the steward at
-- the door learned a points total and nothing about who they had just checked
-- in; and every refusal reached both people as a raw English sentence. This
-- migration returns the member's name and stamps every refusal with a stable
-- machine token in the exception DETAIL field, which PostgREST surfaces as
-- `details` for the client to translate. The English message stays as the
-- last-resort fallback.
--
-- Deliberately NOT changed here: scan_event_checkin keeps its steward-only
-- gate (widening who may scan is not part of any of the four records), and
-- check_in_code stays out of the member column grant.

-- ---------------------------------------------------------------- 1. columns
--
-- Cancellation is a soft state: the row, its RSVPs and its check-ins all
-- survive so attendance history (UB-EVT-04) keeps its evidence, and the event
-- stays visible to members marked cancelled rather than silently vanishing.
alter table public.member_events
  add column cancelled_at timestamptz,
  add column cancelled_reason text;

-- The member SELECT grant is column-scoped (check_in_code is withheld because
-- the static SG- code awards points on self-check-in). Cancellation state is
-- member-facing, so both new columns join the granted set;
-- reminder_notice_sent_at stays out, exactly as it has been since
-- 20260809020000 added it.
grant select (cancelled_at, cancelled_reason) on public.member_events to authenticated;

-- ------------------------------------------------------------ 2. audit kinds
alter table public.member_admin_audit
  drop constraint if exists member_admin_audit_action_check;
alter table public.member_admin_audit
  add constraint member_admin_audit_action_check
  check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event', 'reset_mfa',
                    'claim_reward', 'grant_reward', 'revoke_reward', 'fulfill_reward',
                    'cancel_event', 'restore_event', 'delete_event'));

-- ------------------------------------------------------ 3. the authoring gate
--
-- One predicate, six call sites. The vp-publishing wave  shipped a
-- defect precisely because six policies each carried their own role list and
-- one was missed; a single function makes that drift impossible here. The five
-- keys are exactly STAFF_TOOL_ROLES in src/lib/staffPlanes.js — the President
-- hat rides the 'vp' key, which is why no 'president' string appears.
create function private.member_can_manage_events()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.member_has_role(array['steward', 'coordinator', 'advisor', 'vp', 'admin']);
$$;

revoke all on function private.member_can_manage_events() from public, anon, authenticated, service_role;

-- ---------------------------------------------------- 4. notification copy
insert into private.notification_copy (key, lang, title, body) values
  ('event.cancelled', 'en', 'An event you signed up for was cancelled',
   'Open Events to see which one and why.'),
  ('event.cancelled', 'es', 'Se canceló un evento al que te inscribiste',
   'Abre Eventos para ver cuál y por qué.'),
  ('event.restored', 'en', 'A cancelled event is back on',
   'Open Events to see the details again.'),
  ('event.restored', 'es', 'Un evento cancelado se reactivó',
   'Abre Eventos para ver los detalles otra vez.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- ---------------------------------------------------------- 5. create/update
--
-- Re-emitted from the LIVE 20260809020000 generation (which carries the
-- event-created fan-out) with only the role gate widened. Any other drift here
-- would be an accidental revert of the notifications wave.
create or replace function public.create_member_event(
  p_id text,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_summary text,
  p_check_in_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120
     or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'invalid start time' using errcode = '22023';
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120
     or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500
     or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is null or p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_events:order_index'));
  if exists (select 1 from public.member_events where id = p_id) then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index)
  values (p_id, pg_catalog.btrim(p_title), p_starts_at, pg_catalog.btrim(p_location),
          pg_catalog.btrim(p_summary), p_check_in_code,
          coalesce((select pg_catalog.max(order_index) + 1 from public.member_events), 1));

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event',
          pg_catalog.jsonb_build_object('eventId', p_id, 'title', pg_catalog.btrim(p_title)));

  -- UB-SET-01: the 'events' switch governs real traffic from here on.
  begin
    for m in select p.id from public.member_profiles p where p.id <> caller loop
      perform private.notify_member(m.id, 'event.created', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
$$;

-- Editing a cancelled event is refused: its RSVPs were already told it is off,
-- so a silent time or place change would strand exactly the people who trusted
-- the cancellation notice. Restore it first, then edit.
create or replace function public.update_member_event(
  p_id text,
  p_title text default null,
  p_starts_at timestamptz default null,
  p_location text default null,
  p_summary text default null,
  p_check_in_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev public.member_events%rowtype;
  changed text[];
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select * into ev from public.member_events where id = p_id for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event is cancelled - restore it before editing' using errcode = '22023';
  end if;

  if p_title is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120
          or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120
          or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500
          or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and p_check_in_code is distinct from ev.check_in_code then 'check_in_code' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = coalesce(p_check_in_code, check_in_code)
    where id = p_id;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event',
            pg_catalog.jsonb_build_object('eventId', p_id, 'title', ev.title,
              'fields', pg_catalog.to_jsonb(changed)));

    if 'starts_at' = any(changed) then
      -- The new time deserves its own 24h reminder.
      update public.member_events set reminder_notice_sent_at = null where id = p_id;
      begin
        for m in
          select rv.user_id from public.member_event_rsvps rv
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
        loop
          perform private.notify_member(m.user_id, 'event.rescheduled', '{}'::jsonb, 'events');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0);
end;
$$;

-- ------------------------------------------------------- 6. cancel / restore
--
-- Cancelling tells the people who said they were going. The fan-out is
-- exception-fenced for the same reason create's is: outbound plumbing must
-- never fail the cancellation itself, because a half-cancelled event is worse
-- than a silent one.
create function public.cancel_member_event(p_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev public.member_events%rowtype;
  clean_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if clean_reason is not null
     and (pg_catalog.char_length(clean_reason) > 300 or clean_reason ~ '[[:cntrl:]]') then
    raise exception 'invalid cancellation reason' using errcode = '22023';
  end if;

  select * into ev from public.member_events where id = p_id for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  -- Idempotent: a second cancel is a no-op rather than a second notification
  -- burst to the same RSVPs.
  if ev.cancelled_at is not null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', false);
  end if;

  update public.member_events
  set cancelled_at = now(), cancelled_reason = clean_reason
  where id = p_id;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'cancel_event',
          pg_catalog.jsonb_build_object('eventId', p_id, 'title', ev.title,
            'reason', coalesce(clean_reason, '')));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member(m.user_id, 'event.cancelled', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.cancelled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', true);
end;
$$;

-- Restore exists so a mis-click is recoverable without re-creating the event
-- and losing its RSVPs.
--
-- It notifies. Staying silent was the first instinct — a cancel-then-restore
-- inside a minute pushes two contradictory messages — but silence is the worse
-- failure: the cancellation notice has already gone out, so every member who
-- said they were going is left believing the event is off while the database
-- says it is on. A redundant "it is back on" costs a notification; a missing
-- one costs the attendance.
create function public.restore_member_event(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev public.member_events%rowtype;
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select * into ev from public.member_events where id = p_id for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', false);
  end if;

  update public.member_events
  set cancelled_at = null, cancelled_reason = null
  where id = p_id;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'restore_event',
          pg_catalog.jsonb_build_object('eventId', p_id, 'title', ev.title));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member(m.user_id, 'event.restored', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.restored notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', true);
end;
$$;

-- ------------------------------------------------------------- 7. hard delete
--
-- Hard delete is for mistakes, so it is refused the
-- moment the event has attendance. A check-in is the one artefact that cannot
-- be reconstructed and that already paid points to a member and a scanner;
-- RSVPs cascade away with the row because an RSVP to an event that never
-- happened carries no history worth keeping.
--
-- Known and accepted: member_action_log / member_point_events rows keyed
-- 'rsvp-<event id>' outlive the delete. Points already earned are never
-- clawed back — the award trigger's backing check only ever runs at insert
-- time, so a surviving ledger row is inert.
create function public.delete_member_event(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev public.member_events%rowtype;
  attended integer;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select * into ev from public.member_events where id = p_id for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  select pg_catalog.count(*) into attended
  from public.member_event_checkins where event_id = p_id;
  if attended > 0 then
    raise exception 'this event has % check-in(s) and cannot be deleted', attended
      using errcode = '22023', detail = 'event_has_attendance';
  end if;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'delete_event',
          pg_catalog.jsonb_build_object('eventId', p_id, 'title', ev.title,
            'startsAt', ev.starts_at));

  delete from public.member_events where id = p_id;

  return pg_catalog.jsonb_build_object('id', p_id, 'deleted', true);
end;
$$;

-- ------------------------------------------------------- 8. the staff listing
--
-- Same shape, five hats instead of one, plus the cancellation state the
-- authoring UI needs to decide between Cancel and Restore. The name keeps its
-- get_admin_ prefix so the contract pin, the client wrapper and the tests stay
-- addressable; what changed is who may call it.
--
-- This is the only authenticated-reachable path returning check_in_code, so
-- widening it widens who can see a code that awards points on self-check-in.
-- That is a deliberate consequence of the owner's decision: the five hats that
-- may create an event are the same five that post its code at the door.
create or replace function public.get_admin_events()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary,
      'checkInCode', e.check_in_code,
      'orderIndex', e.order_index,
      'cancelledAt', e.cancelled_at,
      'cancelledReason', e.cancelled_reason,
      'rsvpCount', coalesce(r.n, 0),
      'checkinCount', coalesce(k.n, 0)) order by e.order_index)
    from public.member_events e
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_rsvps where status = 'going' group by event_id
    ) r on r.event_id = e.id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_checkins group by event_id
    ) k on k.event_id = e.id
  ), '[]'::jsonb);
end;
$$;

-- --------------------------------------------- 9. cancelled events are closed
--
-- Re-emitted from the live 20260725170000 generations. The only change is the
-- cancelled guard: a cancelled event must not take a new RSVP, must not mint a
-- check-in token, and must not accept the static code. Without this the points
-- economy would keep paying out for attendance at an event that is off.
create or replace function public.rsvp_to_event(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev record;
  awarded integer := 0;
  rule_points integer;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): mints an rsvp point.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_status not in ('going', 'not_going') then
    raise exception 'invalid rsvp status' using errcode = '22023';
  end if;
  select cancelled_at into ev from public.member_events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
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

create or replace function public.check_in_to_event(p_event_id text, p_code text)
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
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): mints a check-in point.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select id, check_in_code, starts_at, cancelled_at into ev
  from public.member_events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
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

create or replace function public.request_event_checkin_token(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev record;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  plain text := '';
  valid_until timestamptz;
  i integer;
begin
  -- Assurance term added (REQ-UG-DEFINER-MFA-AUDIT): issues a bearer token.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select starts_at, cancelled_at into ev from public.member_events where id = p_event_id;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;
  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
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

-- ------------------------------------------------------- 10. the scan surface
--
-- UB-EVT-05, findings 1 and 3.
--
-- (1) The confirmation now carries memberName. A steward at a door has to be
--     able to tell that the code they just redeemed belonged to the person in
--     front of them; a points total cannot surface a code redeemed against the
--     wrong member. full_name is the same identity the member already publishes
--     to every other member surface, so the steward learns nothing here they
--     could not read off the roster.
--
-- (3) Every refusal now carries a stable token in DETAIL, which PostgREST hands
--     the client as `details`. The client maps it to an EN/ES string; the
--     English MESSAGE stays as the fallback for any path that loses the detail
--     field. Do not reword these tokens — the client lookup table and the tests
--     key on them.
create or replace function public.scan_event_checkin(p_event_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_token text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_token, '')));
  tok record;
  scanned_name text;
  new_checkin integer := 0;
  member_logged integer := 0;
  scanner_logged integer := 0;
  member_points integer := 0;
  scanner_points integer := 0;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required'
      using errcode = '42501', detail = 'scan_not_steward';
  end if;
  if clean_token = '' then
    raise exception 'enter the member''s check-in code'
      using errcode = '22023', detail = 'scan_code_missing';
  end if;
  if exists (select 1 from public.member_events
             where id = p_event_id and cancelled_at is not null) then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'scan_event_cancelled';
  end if;

  select id, user_id, expires_at, consumed_at into tok
  from private.member_event_checkin_tokens
  where event_id = p_event_id
    and token_hash = pg_catalog.encode(extensions.digest(clean_token, 'sha256'), 'hex')
  for update;

  if not found then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;
  if tok.consumed_at is not null then
    raise exception 'this code has already been used'
      using errcode = '22023', detail = 'scan_code_used';
  end if;
  if tok.expires_at < now() then
    raise exception 'this code has expired - ask the member to refresh it'
      using errcode = '22023', detail = 'scan_code_expired';
  end if;
  if tok.user_id = caller then
    raise exception 'you cannot scan your own check-in code'
      using errcode = '22023', detail = 'scan_code_self';
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

  select p.full_name into scanned_name
  from public.member_profiles p where p.id = tok.user_id;

  return pg_catalog.jsonb_build_object(
    'memberUserId', tok.user_id,
    'memberName', scanned_name,
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'memberAwardedPoints', member_points,
    'scannerAwardedPoints', scanner_points
  );
end;
$$;

-- --------------------------------------------------------------- 11. grants
revoke all on function public.cancel_member_event(text, text) from public, anon;
revoke all on function public.restore_member_event(text) from public, anon;
revoke all on function public.delete_member_event(text) from public, anon;
grant execute on function public.cancel_member_event(text, text) to authenticated;
grant execute on function public.restore_member_event(text) to authenticated;
grant execute on function public.delete_member_event(text) to authenticated;
