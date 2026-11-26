-- REQ-UG-LEARNING-PERIOD-EVENTS-20261103 (#6944), slice 5 of 9 of
-- #6805. Built on the engine (20261103163000_learning_period_engine.sql,
-- #6940) and following the tasks slice (20261103183000, #6941). Design:
-- the operator runbook, "Action
-- inventory" (Events), "Repeat undo and concurrency" and build row 5.
--
-- While an organization's learning period runs, a person's own event work is
-- journalled in the same transaction as the change and can be undone through
-- undo_my_learning_action:
--   event_create         undone by hiding the event while nobody else has
--                        RSVPed, checked in or written to its organizer
--   event_edit           fields, visibility (publishing), organizer, agenda,
--                        quorum and the RSVP switch, restored; change notices
--                        already sent stay sent, and an undone reschedule
--                        tells the people going, as a reschedule does
--   event_cancel         restored, telling the people going as restoring does;
--                        the cancellation notice stays sent
--   event_restore        cancelled again, telling the people going
--   event_delete         practised: the event and everything its delete would
--                        cascade (RSVPs, contact consent and links, minutes
--                        notices) are held in private storage, so undo puts
--                        them back; a delete that is kept is completed when
--                        the period closes, exactly as today's hard delete
--   event_rsvp           your own answer, restored
--   event_checkin(_scan) your own check-in, or one you scanned, removed; the
--                        used code, points and audit rows stay
--   live_poll_create     cancelled, until its first vote
-- Votes, ballots and live-poll answers are excluded and never journalled.
-- External calendars follow the event: the push worker diffs against
-- member_events, so a hidden event is removed there and a restored or
-- reverted one is pushed again. A copy someone already read stays read.
--
-- Prerequisite (design, "Repeat undo and concurrency"): member_events gains
-- a version, every ordinary writer bumps it, and update_member_event and
-- update_member_event_model take p_expected_version, so a stale edit waiting
-- behind an undo is refused instead of reapplying the undone value.
--
-- Nothing here changes or removes an audit row, a delivery or a sent notice.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Kinds
-- ---------------------------------------------------------------------------
insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  ('event_create', 'events', 'reverse', 'public.member_events', true, 'private.learning_undo_event', array[]::text[],
    'Creating an event; undo hides it while nobody else has RSVPed, checked in or written to its organizer.'),
  ('event_edit', 'events', 'reverse', 'public.member_events', false, 'private.learning_undo_event',
    array['live', 'title', 'starts_at', 'ends_at', 'event_kind', 'event_date', 'location', 'summary', 'is_public', 'is_public_across_agencies', 'organizer_id', 'agenda', 'rsvp_open', 'quorum_count', 'cancelled_at', 'cancelled_reason']::text[],
    'Editing an event, its visibility, organizer, agenda, quorum or RSVP switch. Change notices already sent stay sent; anyone who copied a published event may keep the copy.'),
  ('event_cancel', 'events', 'reverse', 'public.member_events', false, 'private.learning_undo_event',
    array['live', 'title', 'starts_at', 'ends_at', 'event_kind', 'event_date', 'location', 'summary', 'is_public', 'is_public_across_agencies', 'organizer_id', 'agenda', 'rsvp_open', 'quorum_count', 'cancelled_at', 'cancelled_reason']::text[],
    'Cancelling an event; undo restores it as restoring does. The cancellation notice stays sent.'),
  ('event_restore', 'events', 'reverse', 'public.member_events', false, 'private.learning_undo_event',
    array['live', 'title', 'starts_at', 'ends_at', 'event_kind', 'event_date', 'location', 'summary', 'is_public', 'is_public_across_agencies', 'organizer_id', 'agenda', 'rsvp_open', 'quorum_count', 'cancelled_at', 'cancelled_reason']::text[],
    'Restoring a cancelled event; undo cancels it again.'),
  ('event_delete', 'events', 'reverse', 'public.member_events', false, 'private.learning_undo_event',
    array['live', 'title', 'starts_at', 'ends_at', 'event_kind', 'event_date', 'location', 'summary', 'is_public', 'is_public_across_agencies', 'organizer_id', 'agenda', 'rsvp_open', 'quorum_count', 'cancelled_at', 'cancelled_reason']::text[],
    'Deleting an event. The cascade is practised: the event and its RSVPs are held so undo can put them back, and a kept delete is completed when the period closes.'),
  ('event_rsvp', 'events', 'reverse', 'public.member_event_rsvps', false, 'private.learning_undo_event_attendance',
    array['live', 'status']::text[], 'Your own RSVP; undo restores your earlier answer.'),
  ('event_checkin', 'events', 'reverse', 'public.member_event_checkins', true, 'private.learning_undo_event_attendance', array[]::text[],
    'Checking yourself in; undo removes the check-in. Points and audit rows stay.'),
  ('event_checkin_scan', 'events', 'reverse', 'public.member_event_checkins', true, 'private.learning_undo_event_attendance', array[]::text[],
    'Checking someone in by their code; undo removes the check-in. The used code, points and audit rows stay.'),
  ('live_poll_create', 'events', 'reverse', 'public.organization_live_polls', true, 'private.learning_undo_live_poll', array[]::text[],
    'Creating a live poll; undo cancels it until its first vote. After that it can only be closed.'),
  ('live_poll_edit', 'events', 'permanent', 'public.organization_live_polls', false, null, array[]::text[],
    'Editing a live poll or its options. Recorded and kept; not undone in this slice.'),
  ('live_poll_transition', 'events', 'permanent', 'public.organization_live_polls', false, null, array[]::text[],
    'Scheduling, opening, closing or cancelling a live poll. Members may already have seen it, so it stays.'),
  ('live_poll_meeting', 'events', 'permanent', 'public.organization_live_polls', false, null, array[]::text[],
    'Linking a live poll to a meeting. Recorded and kept; not undone in this slice.'),
  ('live_poll_vote', 'events', 'excluded', null, false, null, array[]::text[],
    'Answering a live poll. Vote secrecy and finality: never journalled or undone.'),
  ('ballot_vote', 'events', 'excluded', null, false, null, array[]::text[],
    'Casting a ballot. Vote secrecy and finality: never journalled or undone.'),
  ('channel_poll_vote', 'events', 'excluded', null, false, null, array[]::text[],
    'Answering a channel poll. Vote secrecy and finality: never journalled or undone.');

-- An event's before-image is bounded by its own checks: an agenda of 4,000
-- characters is at most 16,000 bytes of UTF-8 (two per escaped line break),
-- and every other column together stays under 6,000, so the journal bound
-- (16,384 since 20261103183000) moves to 32,768 and never blocks an edit.
alter table private.learning_action_journal
  drop constraint learning_action_journal_image,
  add constraint learning_action_journal_image check (
    before_image is null or (pg_catalog.jsonb_typeof(before_image) = 'object' and pg_catalog.octet_length(before_image::text) <= 32768));

-- ---------------------------------------------------------------------------
-- 2. The expected version every event writer checks or bumps
-- ---------------------------------------------------------------------------
alter table public.member_events
  add column version integer not null default 1,
  add constraint member_events_version_positive check (version >= 1);
comment on column public.member_events.version is
  'REQ-UG-LEARNING-PERIOD-EVENTS-20261103: bumped by every person-facing event writer and by undo; update_member_event and update_member_event_model refuse a stale p_expected_version.';

-- ---------------------------------------------------------------------------
-- 3. Held storage for a practised delete or a hidden creation
-- ---------------------------------------------------------------------------
-- A practised delete runs today's delete, cascade and all, after copying
-- the event and the rows the cascade removes here, under its journal entry.
-- Undo puts them back; a kept delete's copy is removed when the period
-- closes, which completes it as today's hard delete. An undone creation's
-- copy stays as its tombstone. Nobody reads these rows but undo.
create table private.learning_held_member_events (
  entry_id uuid primary key references private.learning_action_journal(id) on delete cascade,
  event_id text not null,
  organizer_id uuid references auth.users(id) on delete set null,
  event_row jsonb not null,
  held_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint learning_held_member_events_row check (
    pg_catalog.jsonb_typeof(event_row) = 'object' and event_row ->> 'id' = event_id and not event_row ? 'organizer_id')
);
create index learning_held_member_events_event_idx on private.learning_held_member_events (event_id);

create table private.learning_held_member_event_rsvps (
  entry_id uuid not null references private.learning_held_member_events(entry_id) on delete cascade,
  event_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (entry_id, user_id)
);
create index learning_held_member_event_rsvps_user_idx on private.learning_held_member_event_rsvps (user_id);

create table private.learning_held_member_event_contact_opt_ins (
  entry_id uuid not null references private.learning_held_member_events(entry_id) on delete cascade,
  event_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  organizer_id uuid not null,
  opted_in_at timestamptz not null,
  primary key (entry_id, user_id)
);
create index learning_held_member_event_contact_opt_ins_user_idx on private.learning_held_member_event_contact_opt_ins (user_id);

create table private.learning_held_member_event_contact_links (
  entry_id uuid not null references private.learning_held_member_events(entry_id) on delete cascade,
  message_id uuid not null references public.member_messages(id) on delete cascade,
  event_id text not null,
  organizer_id uuid references auth.users(id) on delete set null,
  participant_id uuid references auth.users(id) on delete set null,
  sender_role text not null,
  created_at timestamptz not null,
  primary key (entry_id, message_id)
);
create index learning_held_member_event_contact_links_message_idx on private.learning_held_member_event_contact_links (message_id);
create index learning_held_member_event_contact_links_organizer_idx on private.learning_held_member_event_contact_links (organizer_id);
create index learning_held_member_event_contact_links_participant_idx on private.learning_held_member_event_contact_links (participant_id);

create table private.learning_held_meeting_minutes_event_notices (
  entry_id uuid not null references private.learning_held_member_events(entry_id) on delete cascade,
  record_id uuid not null references public.chapter_records(id) on delete cascade,
  notice_row jsonb not null,
  primary key (entry_id, record_id),
  constraint learning_held_meeting_minutes_event_notices_row check (pg_catalog.jsonb_typeof(notice_row) = 'object')
);
create index learning_held_meeting_minutes_event_notices_record_idx on private.learning_held_meeting_minutes_event_notices (record_id);

alter table private.learning_held_member_events enable row level security;
alter table private.learning_held_member_events force row level security;
revoke all on table private.learning_held_member_events from public, anon, authenticated, service_role;
create policy mfa_assurance on private.learning_held_member_events as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.learning_held_member_events is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; only the event writers and the undo handler reach it.';
alter table private.learning_held_member_event_rsvps enable row level security;
alter table private.learning_held_member_event_rsvps force row level security;
revoke all on table private.learning_held_member_event_rsvps from public, anon, authenticated, service_role;
create policy mfa_assurance on private.learning_held_member_event_rsvps as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.learning_held_member_event_rsvps is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; only the event writers and the undo handler reach it.';
alter table private.learning_held_member_event_contact_opt_ins enable row level security;
alter table private.learning_held_member_event_contact_opt_ins force row level security;
revoke all on table private.learning_held_member_event_contact_opt_ins from public, anon, authenticated, service_role;
create policy mfa_assurance on private.learning_held_member_event_contact_opt_ins as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.learning_held_member_event_contact_opt_ins is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; only the event writers and the undo handler reach it.';
alter table private.learning_held_member_event_contact_links enable row level security;
alter table private.learning_held_member_event_contact_links force row level security;
revoke all on table private.learning_held_member_event_contact_links from public, anon, authenticated, service_role;
create policy mfa_assurance on private.learning_held_member_event_contact_links as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.learning_held_member_event_contact_links is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; only the event writers and the undo handler reach it.';
alter table private.learning_held_meeting_minutes_event_notices enable row level security;
alter table private.learning_held_meeting_minutes_event_notices force row level security;
revoke all on table private.learning_held_meeting_minutes_event_notices from public, anon, authenticated, service_role;
create policy mfa_assurance on private.learning_held_meeting_minutes_event_notices as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.learning_held_meeting_minutes_event_notices is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; only the event writers and the undo handler reach it.';

create trigger a00_case_graph_lock before insert or update or delete on private.learning_held_member_events
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_held_member_events
for each row execute function private.lock_case_graph_row_keys('{organizer_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_held_member_event_rsvps
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_held_member_event_rsvps
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_held_member_event_contact_opt_ins
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_held_member_event_contact_opt_ins
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_held_member_event_contact_links
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_held_member_event_contact_links
for each row execute function private.lock_case_graph_row_keys('{organizer_id},{participant_id}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_held_meeting_minutes_event_notices
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_held_meeting_minutes_event_notices
for each row execute function private.lock_case_graph_row_keys('', '');

comment on table private.learning_held_member_events is
  'REQ-UG-LEARNING-PERIOD-EVENTS-20261103: an event a person deleted during the learning period, held for undo with the rows its delete cascaded; removed when the delete is kept at the close. Also the tombstone of an undone event creation.';
comment on table private.learning_held_member_event_rsvps is
  'REQ-UG-LEARNING-PERIOD-EVENTS-20261103: RSVPs of a held event, put back when its delete is undone.';
comment on table private.learning_held_member_event_contact_opt_ins is
  'REQ-UG-LEARNING-PERIOD-EVENTS-20261103: organizer contact consent of a held event, put back when its delete is undone.';
comment on table private.learning_held_member_event_contact_links is
  'REQ-UG-LEARNING-PERIOD-EVENTS-20261103: message links of a held event, put back when its delete is undone.';
comment on table private.learning_held_meeting_minutes_event_notices is
  'REQ-UG-LEARNING-PERIOD-EVENTS-20261103: minutes notice settings of a held event, put back when its delete is undone.';

-- Copy an event and every row its delete cascades (except single-use
-- check-in codes and wrong-code counters, which are never restored) under a
-- journal entry. The caller then deletes the event as it always has.
create function private.learning_event_hold(p_entry_id uuid, p_event_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  insert into private.learning_held_member_events (entry_id, event_id, organizer_id, event_row)
  select p_entry_id, e.id, e.organizer_id, pg_catalog.to_jsonb(e) - array['organizer_id', 'check_in_offered', 'sort_at']::text[]
  from public.member_events e where e.id = p_event_id;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  insert into private.learning_held_member_event_rsvps (entry_id, event_id, user_id, status, created_at, updated_at)
  select p_entry_id, r.event_id, r.user_id, r.status, r.created_at, r.updated_at
  from public.member_event_rsvps r where r.event_id = p_event_id;
  insert into private.learning_held_member_event_contact_opt_ins (entry_id, event_id, user_id, organizer_id, opted_in_at)
  select p_entry_id, o.event_id, o.user_id, o.organizer_id, o.opted_in_at
  from private.member_event_contact_opt_ins o where o.event_id = p_event_id;
  insert into private.learning_held_member_event_contact_links (entry_id, message_id, event_id, organizer_id, participant_id, sender_role, created_at)
  select p_entry_id, l.message_id, l.event_id, l.organizer_id, l.participant_id, l.sender_role, l.created_at
  from private.member_event_contact_links l where l.event_id = p_event_id;
  insert into private.learning_held_meeting_minutes_event_notices (entry_id, record_id, notice_row)
  select p_entry_id, n.record_id, pg_catalog.to_jsonb(n)
  from private.meeting_minutes_event_notices n where n.event_id = p_event_id;
end;
$function$;
revoke all on function private.learning_event_hold(uuid, text) from public, anon, authenticated, service_role;

-- The close keeps every active entry (20261103163000). A kept delete's held
-- copy goes with it, which completes the delete as today's hard delete; a
-- rerun keeps nothing more, so it removes nothing more.
create function private.learning_event_delete_kept()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- The close holds the graph lock already; take it the same way.
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  delete from private.learning_held_member_events h where h.entry_id = new.id;
  return null;
end;
$function$;
revoke all on function private.learning_event_delete_kept() from public, anon, authenticated, service_role;
create trigger b30_learning_event_delete_kept after update of state on private.learning_action_journal
for each row when (old.state = 'active' and new.state = 'kept' and new.action_kind = 'event_delete')
execute function private.learning_event_delete_kept();

-- ---------------------------------------------------------------------------
-- 4. State and journal helpers
-- ---------------------------------------------------------------------------
-- An event's undo state: every column a person can change, or not live. The
-- check-in code is a credential and is never copied into the journal; undo
-- leaves the current code (and clears it only where the restored schedule
-- cannot carry one).
create function private.learning_event_state(p_event_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'live', true, 'title', e.title, 'starts_at', e.starts_at, 'ends_at', e.ends_at,
      'event_kind', e.event_kind, 'event_date', e.event_date, 'location', e.location, 'summary', e.summary,
      'is_public', e.is_public, 'is_public_across_agencies', e.is_public_across_agencies,
      'organizer_id', e.organizer_id, 'agenda', e.agenda, 'rsvp_open', e.rsvp_open,
      'quorum_count', e.quorum_count, 'cancelled_at', e.cancelled_at, 'cancelled_reason', e.cancelled_reason)
    from public.member_events e where e.id = p_event_id), '{"live": false}'::jsonb);
$function$;
revoke all on function private.learning_event_state(text) from public, anon, authenticated, service_role;

-- The one journal call every event writer makes. p_after is the state the
-- action leaves when the writer journals before it (a delete).
create function private.learning_event_journal(p_kind text, p_event_id text, p_before jsonb, p_parent uuid default null, p_after jsonb default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  return private.learning_journal_append(
    p_kind, 'public.member_events', p_event_id, p_parent,
    private.learning_fingerprint(coalesce(p_after, private.learning_event_state(p_event_id))),
    null,
    case when p_kind = 'event_create' then '{}'::jsonb else p_before end);
end;
$function$;
revoke all on function private.learning_event_journal(text, text, jsonb, uuid, jsonb) from public, anon, authenticated, service_role;

-- An RSVP or check-in, keyed '<event id>:<user id>': there, with its answer,
-- or not.
create function private.learning_attendance_state(p_table text, p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(case p_table
    when 'public.member_event_rsvps' then (
      select pg_catalog.jsonb_build_object('live', true, 'status', r.status)
      from public.member_event_rsvps r
      where r.event_id = pg_catalog.left(p_key, -37) and r.user_id::text = pg_catalog.right(p_key, 36))
    when 'public.member_event_checkins' then (
      select '{"live": true}'::jsonb
      from public.member_event_checkins k
      where k.event_id = pg_catalog.left(p_key, -37) and k.user_id::text = pg_catalog.right(p_key, 36))
  end, '{"live": false}'::jsonb);
$function$;
revoke all on function private.learning_attendance_state(text, text) from public, anon, authenticated, service_role;

create function private.learning_attendance_journal(p_kind text, p_table text, p_event_id text, p_user_id uuid, p_before jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  key text := p_event_id || ':' || p_user_id::text;
  after_state jsonb := private.learning_attendance_state(p_table, key);
begin
  -- An answer that changed nothing is not an action.
  if after_state = p_before then return null; end if;
  return private.learning_journal_append(
    p_kind, p_table, key, null, private.learning_fingerprint(after_state), null,
    case when p_before ->> 'live' = 'false' then '{}'::jsonb else p_before end);
end;
end;
$function$;
revoke all on function private.learning_attendance_journal(text, text, text, uuid, jsonb) from public, anon, authenticated, service_role;

-- A live poll's undo state is only whether it still runs: a creation is
-- undone by cancelling it, which edits by anyone leave possible, and a vote
-- refuses it in the handler's check.
create function private.learning_poll_state(p_poll_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_build_object('running', p.state in ('draft', 'scheduled', 'open'))
    from public.organization_live_polls p where p.id = p_poll_id), '{"running": false}'::jsonb);
$function$;
revoke all on function private.learning_poll_state(uuid) from public, anon, authenticated, service_role;

create function private.learning_poll_journal(p_kind text, p_poll_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if p_kind = 'live_poll_create' then
    return private.learning_journal_append(
      p_kind, 'public.organization_live_polls', p_poll_id::text, null,
      private.learning_fingerprint(private.learning_poll_state(p_poll_id)), null, '{}'::jsonb);
  end if;
  return private.learning_journal_append(p_kind, 'public.organization_live_polls', p_poll_id::text);
end;
$function$;
revoke all on function private.learning_poll_journal(text, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Reversing handlers (the interface is in 20261103163000)
-- ---------------------------------------------------------------------------
-- Every event kind. A creation is hidden by holding it as a delete would
-- (never erased); a practised delete is put back from its held copy; an
-- edit, cancel or restore writes the earlier columns back. Each reversal
-- writes the usual event audit row and tells people what an ordinary edit
-- would tell them; nothing already sent is touched.
create function private.learning_undo_event(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target text := p_entry ->> 'target_id';
  kind text := p_entry ->> 'action_kind';
  entry uuid := (p_entry ->> 'id')::uuid;
  image jsonb := p_entry -> 'before_image';
  ev public.member_events%rowtype;
  held private.learning_held_member_events%rowtype;
  restored public.member_events%rowtype;
  chapter text;
  fields text[];
  m record;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_events e where e.id = target for update;
    perform 1 from private.learning_held_member_events h where h.event_id = target order by h.entry_id for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_event_state(target);
  elsif p_mode = 'before' then
    if kind = 'event_create' then return '{"live": false}'::jsonb; end if;
    return image;
  end if;

  select e.* into ev from public.member_events e where e.id = target;
  if kind = 'event_delete' then
    select h.* into held from private.learning_held_member_events h where h.entry_id = entry;
  end if;
  -- A later step in the same undo may have taken the event away for now.
  chapter := coalesce(ev.chapter_id, held.event_row ->> 'chapter_id', (
    select h.event_row ->> 'chapter_id' from private.learning_held_member_events h
    where h.event_id = target order by h.held_at desc limit 1));

  if p_mode = 'check' then
    -- Today's rule for changing an event: event staff of its own chapter.
    if chapter is null or not private.member_can_manage_events()
       or private.current_member_chapter() is distinct from chapter then
      raise exception 'you can no longer change this event' using errcode = '42501';
    end if;
    if kind = 'event_delete' and (held.entry_id is null or ev.id is not null) then
      raise exception 'this event can no longer be put back' using errcode = '55000';
    end if;
    -- The rule an ordinary edit keeps: attendance recorded for a meeting is
    -- never turned into a deadline, counting answers a later practised
    -- delete of yours is holding.
    if kind in ('event_edit', 'event_cancel', 'event_restore') and image ->> 'event_kind' <> 'meeting'
       and coalesce(nullif(p_entry -> 'projected_state', 'null'::jsonb) ->> 'event_kind', ev.event_kind) = 'meeting'
       and (exists (select 1 from public.member_event_rsvps r where r.event_id = target)
         or exists (select 1 from private.learning_held_member_event_rsvps r where r.event_id = target)
         or exists (select 1 from public.member_event_checkins k where k.event_id = target)) then
      raise exception 'event has attendance; keep its meeting type' using errcode = '22023';
    end if;
    -- A creation is hidden only while it is still yours alone, counting
    -- what a later practised delete of yours is holding.
    if kind = 'event_create' and (
      exists (select 1 from public.member_event_rsvps r where r.event_id = target and r.user_id <> caller)
      or exists (select 1 from private.learning_held_member_event_rsvps r where r.event_id = target and r.user_id <> caller)
      or exists (select 1 from public.member_event_checkins k where k.event_id = target)
      or exists (select 1 from private.member_event_contact_opt_ins o where o.event_id = target and o.user_id <> caller)
      or exists (select 1 from private.learning_held_member_event_contact_opt_ins o where o.event_id = target and o.user_id <> caller)
      or exists (select 1 from private.member_event_contact_links l where l.event_id = target)
      or exists (select 1 from private.learning_held_member_event_contact_links l where l.event_id = target)) then
      raise exception 'people have already answered this event; cancel it instead' using errcode = '55000';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if kind = 'event_create' then
    perform private.learning_event_hold(entry, target);
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'delete_event', pg_catalog.jsonb_build_object(
      'eventId', target, 'title', ev.title, 'chapterId', ev.chapter_id,
      'startsAt', ev.starts_at, 'learningUndo', true));
    delete from public.member_events e where e.id = target;
    return null;
  end if;

  if kind = 'event_delete' then
    -- Same order lock every event creation takes, so the place is free.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_events:order_index:' || chapter, 509));
    insert into public.member_events (
      id, title, starts_at, location, summary, check_in_code, order_index, created_at,
      reminder_notice_sent_at, cancelled_at, cancelled_reason, chapter_id, is_public,
      is_public_across_agencies, organizer_id, agenda, ends_at, event_kind, event_date,
      series_id, rsvp_open, quorum_count, version)
    select r.id, r.title, r.starts_at, r.location, r.summary, r.check_in_code,
      case when exists (select 1 from public.member_events o where o.chapter_id = r.chapter_id and o.order_index = r.order_index)
        then coalesce((select pg_catalog.max(o.order_index) + 1 from public.member_events o where o.chapter_id = r.chapter_id), 1)
        else r.order_index end,
      r.created_at, r.reminder_notice_sent_at, r.cancelled_at, r.cancelled_reason, r.chapter_id, r.is_public,
      r.is_public_across_agencies, held.organizer_id, r.agenda, r.ends_at, r.event_kind, r.event_date,
      -- RSVP collection stays open until the held answers are back.
      r.series_id, true, r.quorum_count, r.version + 1
    from pg_catalog.jsonb_populate_record(null::public.member_events, held.event_row) r
    returning * into restored;
    insert into public.member_event_rsvps (event_id, user_id, status, created_at, updated_at)
    select r.event_id, r.user_id, r.status, r.created_at, r.updated_at
    from private.learning_held_member_event_rsvps r where r.entry_id = entry;
    insert into private.member_event_contact_opt_ins (event_id, user_id, organizer_id, opted_in_at)
    select o.event_id, o.user_id, o.organizer_id, o.opted_in_at
    from private.learning_held_member_event_contact_opt_ins o where o.entry_id = entry;
    insert into private.member_event_contact_links (message_id, event_id, organizer_id, participant_id, sender_role, created_at)
    select l.message_id, l.event_id, l.organizer_id, l.participant_id, l.sender_role, l.created_at
    from private.learning_held_member_event_contact_links l where l.entry_id = entry;
    insert into private.meeting_minutes_event_notices (
      record_id, organization_id, chapter_id, event_id, audience, hours_before, status, outcome,
      recipient_count, failed_count, processed_at, created_at, updated_at)
    select n.record_id, n.organization_id, n.chapter_id, n.event_id, n.audience, n.hours_before, n.status, n.outcome,
      n.recipient_count, n.failed_count, n.processed_at, n.created_at, n.updated_at
    from private.learning_held_meeting_minutes_event_notices h
    cross join lateral pg_catalog.jsonb_populate_record(null::private.meeting_minutes_event_notices, h.notice_row) n
    where h.entry_id = entry;
    if not coalesce((held.event_row ->> 'rsvp_open')::boolean, true) then
      update public.member_events e set rsvp_open = false where e.id = target;
    end if;
    delete from private.learning_held_member_events h where h.entry_id = entry;
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'restore_event', pg_catalog.jsonb_build_object(
      'eventId', target, 'title', restored.title, 'chapterId', restored.chapter_id,
      'deleted', true, 'learningUndo', true));
    return null;
  end if;

  -- An edit, cancel or restore: write the earlier columns back.
  fields := pg_catalog.array_remove(array[
    case when ev.title is distinct from image ->> 'title' then 'title' end,
    case when ev.starts_at is distinct from (image ->> 'starts_at')::timestamptz then 'starts_at' end,
    case when ev.ends_at is distinct from (image ->> 'ends_at')::timestamptz then 'ends_at' end,
    case when ev.event_kind is distinct from image ->> 'event_kind' then 'event_kind' end,
    case when ev.event_date is distinct from (image ->> 'event_date')::date then 'event_date' end,
    case when ev.location is distinct from image ->> 'location' then 'location' end,
    case when ev.summary is distinct from image ->> 'summary' then 'summary' end,
    case when ev.is_public is distinct from (image ->> 'is_public')::boolean then 'is_public' end,
    case when ev.is_public_across_agencies is distinct from (image ->> 'is_public_across_agencies')::boolean then 'is_public_across_agencies' end,
    case when ev.organizer_id is distinct from (image ->> 'organizer_id')::uuid then 'organizer' end,
    case when ev.agenda is distinct from image ->> 'agenda' then 'agenda' end,
    case when ev.rsvp_open is distinct from (image ->> 'rsvp_open')::boolean then 'rsvp_open' end,
    case when ev.quorum_count is distinct from (image ->> 'quorum_count')::integer then 'quorum' end,
    case when ev.check_in_code is not null and image ->> 'event_kind' <> 'meeting' then 'check_in_code' end
  ], null);
  update public.member_events e
  set title = image ->> 'title',
      starts_at = (image ->> 'starts_at')::timestamptz,
      ends_at = (image ->> 'ends_at')::timestamptz,
      event_kind = image ->> 'event_kind',
      event_date = (image ->> 'event_date')::date,
      location = image ->> 'location',
      summary = image ->> 'summary',
      is_public = (image ->> 'is_public')::boolean,
      is_public_across_agencies = (image ->> 'is_public_across_agencies')::boolean,
      organizer_id = (image ->> 'organizer_id')::uuid,
      agenda = image ->> 'agenda',
      rsvp_open = (image ->> 'rsvp_open')::boolean,
      quorum_count = (image ->> 'quorum_count')::integer,
      cancelled_at = (image ->> 'cancelled_at')::timestamptz,
      cancelled_reason = image ->> 'cancelled_reason',
      -- A deadline or reminder carries no check-in code.
      check_in_code = case when image ->> 'event_kind' = 'meeting' then e.check_in_code end,
      version = e.version + 1
  where e.id = target
  returning e.* into restored;

  if fields && array['starts_at', 'ends_at', 'event_date', 'event_kind'] then
    delete from private.member_event_checkin_tokens where event_id = target and consumed_at is null;
    update public.member_events set reminder_notice_sent_at = null where id = target;
  end if;
  -- Consent was given to the organizer shown at the time, as when the
  -- organizer changes by hand.
  if 'organizer' = any(fields) then
    delete from private.member_event_contact_opt_ins where event_id = target;
  end if;

  if ev.cancelled_at is not null and restored.cancelled_at is null then
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'restore_event', pg_catalog.jsonb_build_object(
      'eventId', target, 'title', restored.title, 'chapterId', restored.chapter_id, 'learningUndo', true));
  elsif ev.cancelled_at is null and restored.cancelled_at is not null then
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'cancel_event', pg_catalog.jsonb_build_object(
      'eventId', target, 'title', restored.title, 'chapterId', restored.chapter_id,
      'reason', coalesce(restored.cancelled_reason, ''), 'learningUndo', true));
  end if;
  if pg_catalog.cardinality(fields) > 0 then
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', target, 'title', ev.title, 'chapterId', restored.chapter_id,
      'fields', pg_catalog.to_jsonb(fields),
      'isPublic', restored.is_public,
      'isPublicAcrossAgencies', restored.is_public_across_agencies,
      'learningUndo', true));
  end if;

  -- The people going hear what an ordinary change would tell them; what
  -- they were already told stays told.
  begin
    for m in
      select rv.user_id,
        case
          when ev.cancelled_at is not null and restored.cancelled_at is null then 'restored'
          when ev.cancelled_at is null and restored.cancelled_at is not null then 'cancelled'
          else 'rescheduled'
        end as notice
      from public.member_event_rsvps rv
      join public.member_profiles recipient on recipient.id = rv.user_id
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = restored.chapter_id
      where rv.event_id = target and rv.status = 'going' and rv.user_id <> caller
        and ((ev.cancelled_at is null) is distinct from (restored.cancelled_at is null)
          or (restored.cancelled_at is null and fields && array['starts_at', 'ends_at', 'event_date', 'event_kind']))
        and (
          recipient.chapter_id = restored.chapter_id
          or restored.is_public_across_agencies
          or (restored.is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member_event(m.user_id, target, m.notice);
    end loop;
  exception
    when others then
      raise warning 'event undo notify failed for %: % (%)', target, sqlerrm, sqlstate;
  end;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_event(text, jsonb) from public, anon, authenticated, service_role;

-- Your own RSVP, your own check-in, or a check-in you scanned.
create function private.learning_undo_event_attendance(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target_table text := p_entry ->> 'target_table';
  target text := p_entry ->> 'target_id';
  kind text := p_entry ->> 'action_kind';
  image jsonb := p_entry -> 'before_image';
  target_event text := pg_catalog.left(p_entry ->> 'target_id', -37);
  target_user uuid := pg_catalog.right(p_entry ->> 'target_id', 36)::uuid;
  ev record;
begin
  if p_mode = 'lock' then
    if target_table = 'public.member_event_rsvps' then
      perform 1 from public.member_event_rsvps r where r.event_id = target_event and r.user_id = target_user for update;
    else
      perform 1 from public.member_event_checkins k where k.event_id = target_event and k.user_id = target_user for update;
    end if;
    return null;
  elsif p_mode = 'state' then
    return private.learning_attendance_state(target_table, target);
  elsif p_mode = 'before' then
    if kind = 'event_rsvp' and image ? 'live' then return image; end if;
    return '{"live": false}'::jsonb;
  elsif p_mode = 'check' then
    select e.chapter_id, e.is_public, e.is_public_across_agencies into ev
    from public.member_events e where e.id = target_event;
    if kind = 'event_checkin_scan' then
      if ev.chapter_id is null or not public.member_has_role(array['steward'])
         or private.current_member_chapter() is distinct from ev.chapter_id then
        raise exception 'you can no longer change this check-in' using errcode = '42501';
      end if;
    elsif target_user is distinct from caller or ev.chapter_id is null
       or not private.member_can_access_event_scope(ev.chapter_id, ev.is_public, ev.is_public_across_agencies) then
      raise exception 'you can no longer change this event answer' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  if kind = 'event_rsvp' and image ->> 'live' = 'true' then
    insert into public.member_event_rsvps (event_id, user_id, status, updated_at)
    values (target_event, target_user, image ->> 'status', pg_catalog.now())
    on conflict (event_id, user_id) do update
      set status = excluded.status, updated_at = pg_catalog.now();
  elsif kind = 'event_rsvp' then
    delete from public.member_event_rsvps r where r.event_id = target_event and r.user_id = target_user;
  else
    delete from public.member_event_checkins k where k.event_id = target_event and k.user_id = target_user;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_event_attendance(text, jsonb) from public, anon, authenticated, service_role;

-- A live poll you created: cancelled, as staff would cancel it, until its
-- first vote. A poll with any vote can only be closed.
create function private.learning_undo_live_poll(p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  target uuid := (p_entry ->> 'target_id')::uuid;
  org uuid;
  poll public.organization_live_polls%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.organization_live_polls p where p.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_poll_state(target);
  elsif p_mode = 'before' then
    return '{"running": false}'::jsonb;
  end if;

  select p.* into poll from public.organization_live_polls p where p.id = target;
  if p_mode = 'check' then
    org := private.engagement_selected_organization();
    if poll.id is null or poll.organization_id is distinct from org then
      raise exception 'you can no longer change this poll' using errcode = '42501';
    end if;
    perform private.engagement_require_staff(org);
    if poll.vote_count > 0 or exists (select 1 from public.organization_live_poll_votes v where v.poll_id = target) then
      raise exception 'this poll has votes; it can only be closed' using errcode = '55000';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;

  update public.organization_live_polls p
  set state = 'cancelled', closed_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where p.id = target;
  perform private.recalculate_organization_live_poll(target);
  perform private.mi1_w2_write_audit(poll.organization_id, 'live_poll_transitioned', pg_catalog.jsonb_build_object(
    'organizationId', poll.organization_id, 'pollId', target, 'userId', caller, 'status', 'cancelled',
    'action', 'cancel', 'count', 0
  ));
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_live_poll(text, jsonb) from public, anon, authenticated, service_role;

-- The dispatcher gains the event handlers (re-emitted from 20261104075000,
-- keeping the task and case-record branches).
create or replace function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Handlers write graph tables, so the dispatcher takes the lock first too.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  if p_mode is null or p_mode not in ('lock', 'state', 'before', 'check', 'apply') or p_entry is null then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  case p_handler
    when 'private.learning_undo_task' then return private.learning_undo_task(p_mode, p_entry);
    when 'private.learning_undo_task_edge' then return private.learning_undo_task_edge(p_mode, p_entry);
    when 'private.learning_undo_task_file' then return private.learning_undo_task_file(p_mode, p_entry);
    when 'private.learning_undo_task_checkoff' then return private.learning_undo_task_checkoff(p_mode, p_entry);
    when 'private.learning_undo_case' then return private.learning_undo_case(p_mode, p_entry);
    when 'private.learning_undo_case_note' then return private.learning_undo_case_note(p_mode, p_entry);
    when 'private.learning_undo_case_outcome' then return private.learning_undo_case_outcome(p_mode, p_entry);
    when 'private.learning_undo_case_file' then return private.learning_undo_case_file(p_mode, p_entry);
    when 'private.learning_undo_event' then return private.learning_undo_event(p_mode, p_entry);
    when 'private.learning_undo_event_attendance' then return private.learning_undo_event_attendance(p_mode, p_entry);
    when 'private.learning_undo_live_poll' then return private.learning_undo_live_poll(p_mode, p_entry);
    else raise exception 'learning undo handler unavailable: %', p_handler using errcode = '55000';
  end case;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. The event writers, each journalling its own change
-- ---------------------------------------------------------------------------
-- Re-emitted from their latest bodies with one journal call after the write
-- and the version bump. The two update signatures gain p_expected_version;
-- the earlier signatures are dropped once the new ones exist.

create or replace function public.create_member_event(p_id text, p_title text, p_starts_at timestamp with time zone, p_location text, p_summary text, p_check_in_code text, p_is_public boolean default false, p_is_public_across_agencies boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  -- NULL or empty: no check-in code (a deadline or reminder).
  clean_code text := nullif(p_check_in_code, '');
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_is_public is null or p_is_public_across_agencies is null then
    raise exception 'event visibility is required' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'invalid start time' using errcode = '22023';
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if clean_code is not null and clean_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_events:order_index:' || caller_chapter, 509));
  -- An id a practised delete may still put back is taken; a hidden
  -- creation's tombstone reserves nothing, since nothing restores it.
  if exists (select 1 from public.member_events where id = p_id)
     or exists (select 1 from private.learning_held_member_events h
       join private.learning_action_journal j on j.id = h.entry_id
       where h.event_id = p_id and j.action_kind = 'event_delete' and j.state = 'active') then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  insert into public.member_events (
    id, title, starts_at, location, summary, check_in_code, order_index,
    chapter_id, is_public, is_public_across_agencies)
  values (
    p_id, pg_catalog.btrim(p_title), p_starts_at, pg_catalog.btrim(p_location),
    pg_catalog.btrim(p_summary), clean_code,
    coalesce((select pg_catalog.max(order_index) + 1 from public.member_events where chapter_id = caller_chapter), 1),
    caller_chapter, p_is_public, p_is_public_across_agencies);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', pg_catalog.btrim(p_title),
    'chapterId', caller_chapter,
    'isPublic', p_is_public,
    'isPublicAcrossAgencies', p_is_public_across_agencies));

  begin
    for m in
      select recipient.id
      from public.member_profiles recipient
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = caller_chapter
      join public.organization_memberships recipient_membership
        on recipient_membership.user_id = recipient.id
       and recipient_membership.organization_id = publisher_chapter.organization_id
       and recipient_membership.status = 'active'
      where recipient.id <> caller
        and recipient_chapter.organization_id = publisher_chapter.organization_id
        and (
          recipient.chapter_id = caller_chapter
          or p_is_public_across_agencies
          or (p_is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member_event(m.id, p_id, 'created');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  -- A reused id continues the version its hidden creation left, so an
  -- editor opened on that event can never save into this one.
  update public.member_events e set version = held.next_version
  from (select pg_catalog.max((h.event_row ->> 'version')::integer) + 1 as next_version
    from private.learning_held_member_events h where h.event_id = p_id) held
  where e.id = p_id and held.next_version is not null;
  perform private.learning_event_journal('event_create', p_id, null);
  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
end;
$function$
;

create or replace function public.create_member_event_model(p_id text, p_title text, p_starts_at timestamp with time zone, p_location text, p_summary text, p_check_in_code text, p_is_public boolean default false, p_is_public_across_agencies boolean default false, p_kind text default 'meeting'::text, p_event_date date default NULL::date, p_ends_at timestamp with time zone default NULL::timestamp with time zone, p_occurrences integer default 1, p_timezone text default 'America/New_York'::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  m record;
  occurrence_id text;
  occurrence_start timestamptz;
  occurrence_end timestamptz;
  occurrence_code text;
  local_start timestamp;
  series uuid := case when p_occurrences > 1 then extensions.gen_random_uuid() end;
  ids jsonb := '[]'::jsonb;
  learning_parent uuid;
  learning_entry uuid;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_is_public is null or p_is_public_across_agencies is null then
    raise exception 'event visibility is required' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_kind is null or p_kind not in ('meeting', 'deadline', 'date_only')
     or (p_kind = 'meeting' and (p_starts_at is null or p_event_date is not null))
     or (p_kind <> 'meeting' and (p_event_date is null or p_starts_at is not null or p_ends_at is not null or nullif(p_check_in_code, '') is not null))
     or (p_ends_at is not null and p_ends_at <= p_starts_at)
     or p_occurrences is null or p_occurrences not between 1 and 12
     or (p_occurrences > 1 and p_kind <> 'meeting') then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  if p_occurrences > 1 then
    if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
      raise exception 'invalid event timezone' using errcode = '22023';
    end if;
    local_start := p_starts_at at time zone p_timezone;
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if nullif(p_check_in_code, '') is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_events:order_index:' || caller_chapter, 509));
  -- An id a practised delete may still put back is taken; a hidden
  -- creation's tombstone reserves nothing, since nothing restores it.
  if exists (select 1 from public.member_events where id = p_id)
     or exists (select 1 from private.learning_held_member_events h
       join private.learning_action_journal j on j.id = h.entry_id
       where h.event_id = p_id and j.action_kind = 'event_delete' and j.state = 'active') then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  -- Finite series: each row owns its RSVP, check-in code, audit and lifecycle.
  -- Add each offset to the original wall time (Jan 31 -> Feb 28 -> Mar 31).
  for occurrence in 0..p_occurrences - 1 loop
    occurrence_id := case when occurrence = 0 then p_id else 'event-' || extensions.gen_random_uuid()::text end;
    occurrence_start := case when occurrence = 0 then p_starts_at
      else (local_start + pg_catalog.make_interval(months => occurrence)) at time zone p_timezone end;
    occurrence_end := case when p_ends_at is null then null
      else occurrence_start + (p_ends_at - p_starts_at) end;
    occurrence_code := case when nullif(p_check_in_code, '') is null then null
      when occurrence = 0 and nullif(p_check_in_code, '') is not null then p_check_in_code
      else 'SG-' || pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(6), 'hex')) end;
  insert into public.member_events (
    id, title, starts_at, location, summary, check_in_code, order_index,
    chapter_id, is_public, is_public_across_agencies, event_kind, event_date, ends_at, series_id)
  values (
    occurrence_id, pg_catalog.btrim(p_title), occurrence_start, pg_catalog.btrim(p_location),
    pg_catalog.btrim(p_summary), occurrence_code,
    coalesce((select pg_catalog.max(order_index) + 1 from public.member_events where chapter_id = caller_chapter), 1),
    caller_chapter, p_is_public, p_is_public_across_agencies, p_kind, p_event_date, occurrence_end, series);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event', pg_catalog.jsonb_build_object(
    'eventId', occurrence_id, 'title', pg_catalog.btrim(p_title),
    'chapterId', caller_chapter,
    'isPublic', p_is_public,
    'isPublicAcrossAgencies', p_is_public_across_agencies));

  if occurrence = 0 then
  begin
    for m in
      select recipient.id
      from public.member_profiles recipient
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = caller_chapter
      join public.organization_memberships recipient_membership
        on recipient_membership.user_id = recipient.id
       and recipient_membership.organization_id = publisher_chapter.organization_id
       and recipient_membership.status = 'active'
      where recipient.id <> caller
        and recipient_chapter.organization_id = publisher_chapter.organization_id
        and (
          recipient.chapter_id = caller_chapter
          or p_is_public_across_agencies
          or (p_is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member_event(m.id, occurrence_id, 'created');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  end if;

  -- A reused id continues the version its hidden creation left, so an
  -- editor opened on that event can never save into this one.
  update public.member_events e set version = held.next_version
  from (select pg_catalog.max((h.event_row ->> 'version')::integer) + 1 as next_version
    from private.learning_held_member_events h where h.event_id = occurrence_id) held
  where e.id = occurrence_id and held.next_version is not null;
  -- A series is one action: its first occurrence is the parent entry.
  learning_entry := private.learning_event_journal('event_create', occurrence_id, null, learning_parent);
  if occurrence = 0 then learning_parent := learning_entry; end if;

  ids := ids || pg_catalog.jsonb_build_array(occurrence_id);
  end loop;
  return pg_catalog.jsonb_build_object('id', p_id, 'created', true, 'occurrenceIds', ids);
end;
end;
$function$
;

create or replace function public.create_member_event_with_rsvp(p_id text, p_title text, p_starts_at timestamp with time zone, p_location text, p_summary text, p_check_in_code text, p_is_public boolean, p_is_public_across_agencies boolean, p_kind text, p_event_date date, p_ends_at timestamp with time zone, p_occurrences integer, p_timezone text, p_rsvp_open boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  created jsonb;
  caller_chapter text;
  occurrence_id text;
  learning_before jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_rsvp_open is null then
    raise exception 'rsvp switch is required' using errcode = '22023';
  end if;
  created := public.create_member_event_model(
    p_id, p_title, p_starts_at, p_location, p_summary, p_check_in_code,
    p_is_public, p_is_public_across_agencies, p_kind, p_event_date, p_ends_at,
    p_occurrences, p_timezone);
  if not p_rsvp_open then
    caller_chapter := private.current_member_chapter();
    for occurrence_id in select pg_catalog.jsonb_array_elements_text(created -> 'occurrenceIds') loop
      learning_before := private.learning_event_state(occurrence_id);
      update public.member_events set rsvp_open = false, version = version + 1
      where chapter_id = caller_chapter and id = occurrence_id;
      perform private.learning_event_journal('event_edit', occurrence_id, learning_before);
    end loop;
    insert into public.member_admin_audit (actor, action, detail)
    values ((select auth.uid()), 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', pg_catalog.btrim(p_title), 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('rsvp_open'),
      'rsvpOpen', false,
      'isPublic', p_is_public,
      'isPublicAcrossAgencies', p_is_public_across_agencies));
  end if;
  return created || pg_catalog.jsonb_build_object('rsvpOpen', p_rsvp_open);
end;
$function$
;

create or replace function public.update_member_event(p_id text, p_title text default NULL::text, p_starts_at timestamp with time zone default NULL::timestamp with time zone, p_location text default NULL::text, p_summary text default NULL::text, p_check_in_code text default NULL::text, p_is_public boolean default NULL::boolean, p_is_public_across_agencies boolean default NULL::boolean, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
  learning_before jsonb;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  -- A stale edit, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = '40001', detail = 'event_changed';
  end if;
  learning_before := private.learning_event_state(p_id);

  if p_title is not null and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  -- NULL keeps the current code; the empty string removes it.
  if p_check_in_code is not null and p_check_in_code <> '' and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and nullif(p_check_in_code, '') is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = case when p_check_in_code is null then check_in_code else nullif(p_check_in_code, '') end,
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies),
      version = version + 1
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if 'starts_at' = any(changed) then
      update public.member_events set reminder_notice_sent_at = null
      where id = p_id and chapter_id = caller_chapter;
      begin
        for m in
          select rv.user_id
          from public.member_event_rsvps rv
          join public.member_profiles recipient on recipient.id = rv.user_id
          join public.member_events current_event on current_event.id = rv.event_id
          join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
          join public.chapters publisher_chapter on publisher_chapter.id = current_event.chapter_id
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
            and (
              recipient.chapter_id = current_event.chapter_id
              or current_event.is_public_across_agencies
              or (current_event.is_public and publisher_chapter.region is not null
                  and recipient_chapter.region = publisher_chapter.region)
            )
        loop
          perform private.notify_member_event(m.user_id, p_id, 'rescheduled');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
    perform private.learning_event_journal('event_edit', p_id, learning_before);
  end if;

  -- The version a retry or the next edit sends back.
  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$
;
revoke all on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean, integer) to authenticated;

create or replace function public.update_member_event_model(p_id text, p_title text default NULL::text, p_starts_at timestamp with time zone default NULL::timestamp with time zone, p_location text default NULL::text, p_summary text default NULL::text, p_check_in_code text default NULL::text, p_is_public boolean default NULL::boolean, p_is_public_across_agencies boolean default NULL::boolean, p_schedule jsonb default NULL::jsonb, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
  next_kind text;
  next_start timestamptz;
  next_date date;
  next_end timestamptz;
  next_code text;
  learning_before jsonb;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  -- A stale edit, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = '40001', detail = 'event_changed';
  end if;
  learning_before := private.learning_event_state(p_id);

  -- NULL schedule preserves exact stored seconds and an omitted end time.
  -- A present schedule is a full replacement; JSON null clears the end.
  if p_schedule is not null and (pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     or not (p_schedule ?& array['kind', 'startsAt', 'eventDate', 'endsAt'])) then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  next_kind := case when p_schedule is null then ev.event_kind else p_schedule ->> 'kind' end;
  next_start := case when p_schedule is null then coalesce(p_starts_at, ev.starts_at) else (p_schedule ->> 'startsAt')::timestamptz end;
  next_date := case when p_schedule is null then ev.event_date else (p_schedule ->> 'eventDate')::date end;
  next_end := case when p_schedule is null then ev.ends_at else (p_schedule ->> 'endsAt')::timestamptz end;
  next_code := case when p_check_in_code is null then ev.check_in_code else nullif(p_check_in_code, '') end;
  if next_kind is null or next_kind not in ('meeting', 'deadline', 'date_only')
     or (next_kind = 'meeting' and (next_start is null or next_date is not null))
     or (next_kind <> 'meeting' and (next_date is null or next_start is not null or next_end is not null or next_code is not null))
     or (next_end is not null and next_end <= next_start) then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  -- Do not turn attendance already recorded for a meeting into a deadline.
  if next_kind <> 'meeting' and ev.event_kind = 'meeting' and (
    exists (select 1 from public.member_event_rsvps where event_id = p_id)
    or exists (select 1 from public.member_event_checkins where event_id = p_id)
  ) then
    raise exception 'event has attendance; keep its meeting type' using errcode = '22023';
  end if;

  if p_title is not null and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if nullif(p_check_in_code, '') is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when next_start is distinct from ev.starts_at then 'starts_at' end,
    case when next_kind is distinct from ev.event_kind then 'event_kind' end,
    case when next_date is distinct from ev.event_date then 'event_date' end,
    case when next_end is distinct from ev.ends_at then 'ends_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when next_code is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = next_start, event_kind = next_kind, event_date = next_date, ends_at = next_end,
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = next_code,
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies),
      version = version + 1
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if changed && array['starts_at', 'ends_at', 'event_date', 'event_kind'] then
      delete from private.member_event_checkin_tokens where event_id = p_id and consumed_at is null;
      update public.member_events set reminder_notice_sent_at = null
      where id = p_id and chapter_id = caller_chapter;
      begin
        for m in
          select rv.user_id
          from public.member_event_rsvps rv
          join public.member_profiles recipient on recipient.id = rv.user_id
          join public.member_events current_event on current_event.id = rv.event_id
          join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
          join public.chapters publisher_chapter on publisher_chapter.id = current_event.chapter_id
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
            and (
              recipient.chapter_id = current_event.chapter_id
              or current_event.is_public_across_agencies
              or (current_event.is_public and publisher_chapter.region is not null
                  and recipient_chapter.region = publisher_chapter.region)
            )
        loop
          perform private.notify_member_event(m.user_id, p_id, 'rescheduled');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
    perform private.learning_event_journal('event_edit', p_id, learning_before);
  end if;

  -- The version a retry or the next edit sends back.
  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$
;
revoke all on function public.update_member_event_model(text, text, timestamptz, text, text, text, boolean, boolean, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.update_member_event_model(text, text, timestamptz, text, text, text, boolean, boolean, jsonb, integer) to authenticated, service_role;

drop function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean);
drop function public.update_member_event_model(text, text, timestamptz, text, text, text, boolean, boolean, jsonb);

create or replace function public.cancel_member_event(p_id text, p_reason text default NULL::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  clean_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  m record;
  learning_before jsonb;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if clean_reason is not null
     and (pg_catalog.char_length(clean_reason) > 300 or clean_reason ~ '[[:cntrl:]]') then
    raise exception 'invalid cancellation reason' using errcode = '22023';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', false);
  end if;

  learning_before := private.learning_event_state(p_id);
  update public.member_events
  set cancelled_at = now(), cancelled_reason = clean_reason, version = version + 1
  where id = p_id and chapter_id = caller_chapter;
  perform private.learning_event_journal('event_cancel', p_id, learning_before);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'cancel_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
    'reason', coalesce(clean_reason, '')));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member_event(m.user_id, p_id, 'cancelled');
    end loop;
  exception
    when others then
      raise warning 'event.cancelled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', true);
end;
end;
$function$
;

create or replace function public.restore_member_event(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  m record;
  learning_before jsonb;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', false);
  end if;

  learning_before := private.learning_event_state(p_id);
  update public.member_events
  set cancelled_at = null, cancelled_reason = null, version = version + 1
  where id = p_id and chapter_id = caller_chapter;
  perform private.learning_event_journal('event_restore', p_id, learning_before);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'restore_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member_event(m.user_id, p_id, 'restored');
    end loop;
  exception
    when others then
      raise warning 'event.restored notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', true);
end;
end;
$function$
;

create or replace function public.delete_member_event(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  attended integer;
  learning_entry uuid;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  select pg_catalog.count(*) into attended
  from public.member_event_checkins where event_id = p_id;
  if attended > 0 then
    raise exception 'this event has % check-in(s) and cannot be deleted', attended
      using errcode = '22023', detail = 'event_has_attendance';
  end if;

  -- During a learning period the delete is practised: the event and what
  -- its delete cascades are held under the journal entry first, so undo can
  -- put them back; the close completes a delete that is kept.
  learning_entry := private.learning_event_journal('event_delete', p_id,
    private.learning_event_state(p_id), null, '{"live": false}'::jsonb);
  if learning_entry is not null then
    perform private.learning_event_hold(learning_entry, p_id);
  end if;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'delete_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
    'startsAt', ev.starts_at));

  delete from public.member_events
  where id = p_id and chapter_id = caller_chapter;

  return pg_catalog.jsonb_build_object('id', p_id, 'deleted', true);
end;
end;
$function$
;

create or replace function public.set_member_event_rsvp_open(p_id text, p_open boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_open is null then
    raise exception 'rsvp switch is required' using errcode = '22023';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  if ev.rsvp_open is distinct from p_open then
    learning_before := private.learning_event_state(p_id);
    update public.member_events set rsvp_open = p_open, version = version + 1
    where id = p_id and chapter_id = caller_chapter;
    perform private.learning_event_journal('event_edit', p_id, learning_before);

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('rsvp_open'),
      'rsvpOpen', p_open,
      'isPublic', ev.is_public,
      'isPublicAcrossAgencies', ev.is_public_across_agencies));
  end if;

  return pg_catalog.jsonb_build_object('updated', ev.rsvp_open is distinct from p_open, 'rsvpOpen', p_open);
end;
end;
$function$
;

create or replace function public.set_member_event_quorum(p_id text, p_quorum integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_quorum is not null and p_quorum not between 1 and 100000 then
    raise exception 'quorum must be a whole number from 1 to 100000' using errcode = '22023';
  end if;
  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if coalesce(ev.event_kind, 'meeting') <> 'meeting' then
    raise exception 'only a meeting takes a quorum' using errcode = '22023';
  end if;
  if ev.quorum_count is not distinct from p_quorum then
    return pg_catalog.jsonb_build_object('id', p_id, 'quorum', p_quorum, 'changed', false, 'version', ev.version);
  end if;
  learning_before := private.learning_event_state(p_id);
  update public.member_events set quorum_count = p_quorum, version = version + 1
  where id = p_id and chapter_id = caller_chapter;
  perform private.learning_event_journal('event_edit', p_id, learning_before);
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'update_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
    'field', 'quorum', 'from', ev.quorum_count, 'to', p_quorum));
  return pg_catalog.jsonb_build_object('id', p_id, 'quorum', p_quorum, 'changed', true,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$
;

create or replace function public.set_member_event_agenda(p_id text, p_agenda text, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  learning_before jsonb;
  clean text := nullif(pg_catalog.btrim(coalesce(p_agenda, ''), ' ' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9)), '');
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  -- A stale agenda, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = '40001', detail = 'event_changed';
  end if;

  if clean is not null and (pg_catalog.char_length(clean) > 4000
     or pg_catalog.translate(clean, pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9), '') ~ '[[:cntrl:]]') then
    raise exception 'invalid agenda' using errcode = '22023';
  end if;

  if clean is distinct from ev.agenda then
    learning_before := private.learning_event_state(p_id);
    update public.member_events set agenda = clean, version = version + 1
    where id = p_id and chapter_id = caller_chapter;
    perform private.learning_event_journal('event_edit', p_id, learning_before);

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('agenda'),
      'isPublic', ev.is_public,
      'isPublicAcrossAgencies', ev.is_public_across_agencies));
  end if;

  return pg_catalog.jsonb_build_object('updated', clean is distinct from ev.agenda, 'agenda', clean,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$
;
revoke all on function public.set_member_event_agenda(text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.set_member_event_agenda(text, text, integer) to authenticated;
drop function public.set_member_event_agenda(text, text);

create or replace function public.set_member_event_organizer(p_event_id text, p_organizer_id uuid, p_expected_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  label text := null;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    perform private.cw_fail('not_authorized', '42501', 'staff role required', 'staff_grant_required');
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    perform private.cw_fail('not_authorized', '42501', 'staff chapter required');
  end if;
  select e.* into ev from public.member_events e
  where e.id = p_event_id and e.chapter_id = caller_chapter
  for update;
  if not found then
    perform private.cw_fail('source_unavailable', '22023', 'unknown event');
  end if;
  -- A stale organizer choice, for example one that waited behind an undo,
  -- is refused instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = '40001', detail = 'event_changed';
  end if;
  if p_organizer_id is not null and not private.cw_event_candidate_ok(p_organizer_id, ev.id) then
    perform private.cw_fail('invalid_input', '22023', 'organizer must hold a staff grant for this chapter', 'organizer_unavailable');
  end if;

  if ev.organizer_id is distinct from p_organizer_id then
    learning_before := private.learning_event_state(ev.id);
    update public.member_events set organizer_id = p_organizer_id, version = version + 1 where id = ev.id;
    perform private.learning_event_journal('event_edit', ev.id, learning_before);
    -- Consent was given to the organizer shown at the time; a different
    -- organizer (or none) starts from no consent.
    delete from private.member_event_contact_opt_ins where event_id = ev.id;
    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', ev.id, 'chapterId', ev.chapter_id, 'fields', pg_catalog.jsonb_build_array('organizer')));
  end if;

  if p_organizer_id is not null then
    select coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Organizer') into label
    from public.member_profiles pr where pr.id = p_organizer_id;
  end if;
  return pg_catalog.jsonb_build_object(
    'eventId', ev.id,
    'organizer', case when p_organizer_id is null then null
      else pg_catalog.jsonb_build_object('id', p_organizer_id, 'label', label) end,
    'changed', ev.organizer_id is distinct from p_organizer_id,
    'version', (select e.version from public.member_events e where e.id = ev.id));
end;
end;
$function$
;
revoke all on function public.set_member_event_organizer(text, uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.set_member_event_organizer(text, uuid, integer) to authenticated;
drop function public.set_member_event_organizer(text, uuid);

create or replace function public.rsvp_to_event(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  awarded integer := 0;
  rule_points integer;
  learning_before jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_status not in ('going', 'not_going') then
    raise exception 'invalid rsvp status' using errcode = '22023';
  end if;

  select e.cancelled_at, e.starts_at, e.event_kind into ev
  from public.member_events e
  where e.id = p_event_id
    and private.member_can_access_event_scope(
      e.chapter_id, e.is_public, e.is_public_across_agencies
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;
  if ev.event_kind <> 'meeting' then
    raise exception 'RSVP is not offered for this event' using errcode = '22023';
  end if;
  if ev.starts_at < now() then
    raise exception 'this event is in the past'
      using errcode = '22023', detail = 'event_past';
  end if;

  learning_before := private.learning_attendance_state('public.member_event_rsvps', p_event_id || ':' || caller::text);
  insert into public.member_event_rsvps (event_id, user_id, status, updated_at)
  values (p_event_id, caller, p_status, now())
  on conflict (event_id, user_id) do update
    set status = excluded.status, updated_at = now();
  perform private.learning_attendance_journal('event_rsvp', 'public.member_event_rsvps', p_event_id, caller, learning_before);

  if p_status = 'going' then
    insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, 'rsvp-' || p_event_id, 'rsvp')
    on conflict (user_id, action_key) do nothing;
    get diagnostics awarded = row_count;
  end if;

  select points into rule_points
  from public.member_point_rules where action_kind = 'rsvp';
  return pg_catalog.jsonb_build_object(
    'status', p_status,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
end;
$function$
;

create or replace function public.check_in_to_event(p_event_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  prior_wrong integer;
  prior_locked_until timestamptz;
  now_at timestamptz;
  wrong_count integer;
  checkin_org uuid;
  checkin_limit integer;
  checkin_lock_minutes integer;
  new_checkin integer := 0;
  awarded integer := 0;
  rule_points integer;
  -- One literal for both refusals (project decision 2026-09-25: a bound refusal is
  -- indistinguishable from a wrong code). Same SQLSTATE and message the
  -- raised refusal carried, so every surface reports the same failure.
  refusal constant jsonb := pg_catalog.jsonb_build_object(
    'checkedIn', false,
    'refused', true,
    'code', '22023',
    'message', 'invalid check-in code',
    'token', 'checkin_code_invalid'
  );
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.id, e.check_in_code, e.starts_at, e.cancelled_at into ev
  from public.member_events e
  where e.id = p_event_id
    and private.member_can_access_event_scope(
      e.chapter_id, e.is_public, e.is_public_across_agencies
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;
  -- No code, no check-in: a deadline or reminder admits nobody. Refused
  -- before the window or any attempt is counted, so a NULL code never
  -- reaches a comparison that SQL would leave unknown.
  if ev.check_in_code is null then
    raise exception 'this event has no check-in'
      using errcode = '22023', detail = 'checkin_not_offered';
  end if;

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023', detail = 'checkin_not_open';
  end if;

  -- Bound by the event organization's nonzero lock settings.
  select c.organization_id into checkin_org
  from public.member_events e join public.chapters c on c.id = e.chapter_id
  where e.id = p_event_id;
  checkin_limit := private.organization_limit(checkin_org, 'limits.security.event_checkin_wrong_codes');
  checkin_lock_minutes := private.organization_limit(checkin_org, 'limits.security.event_checkin_lock_minutes');
  now_at := private.event_checkin_clock();
  select a.wrong_attempts, a.locked_until into prior_wrong, prior_locked_until
  from private.member_event_checkin_attempts a
  where a.event_id = p_event_id and a.user_id = caller
  for update;
  if prior_locked_until is not null and now_at < prior_locked_until then
    -- Locked out: the correct code is refused too, nothing is counted, and
    -- the caller cannot tell this apart from a wrong code.
    return refusal;
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, ''))) <> pg_catalog.upper(ev.check_in_code) then
    -- An expired lockout starts a fresh window; otherwise the window continues.
    wrong_count := case
      when prior_wrong is null or prior_locked_until is not null then 1
      else prior_wrong + 1
    end;
    insert into private.member_event_checkin_attempts (event_id, user_id, wrong_attempts, locked_until, last_attempt_at)
    values (
      p_event_id, caller, wrong_count,
      case when wrong_count >= checkin_limit then now_at + pg_catalog.make_interval(mins => checkin_lock_minutes) end,
      now_at
    )
    on conflict (event_id, user_id) do update
      set wrong_attempts = excluded.wrong_attempts,
          locked_until = excluded.locked_until,
          last_attempt_at = excluded.last_attempt_at;
    if wrong_count >= checkin_limit then
      -- One audit row per lockout naming the event and the caller; no code
      -- value, neither the guess nor the secret, is ever written.
      insert into public.member_admin_audit (actor, action, target_user, detail)
      values (caller, 'event_checkin_lockout', caller, pg_catalog.jsonb_build_object(
        'eventId', p_event_id,
        'wrongAttempts', wrong_count,
        'lockedUntil', now_at + pg_catalog.make_interval(mins => checkin_lock_minutes)
      ));
    end if;
    return refusal;
  end if;

  -- A correct code outside a lockout closes the window.
  delete from private.member_event_checkin_attempts
  where event_id = p_event_id and user_id = caller;

  insert into public.member_event_checkins (event_id, user_id)
  values (p_event_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;
  if new_checkin = 1 then
    perform private.learning_attendance_journal('event_checkin', 'public.member_event_checkins', p_event_id, caller, '{"live": false}'::jsonb);
  end if;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics awarded = row_count;

  select points into rule_points
  from public.member_point_rules where action_kind = 'checkin';
  return pg_catalog.jsonb_build_object(
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
end;
$function$
;

create or replace function public.scan_event_checkin(p_event_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  clean_token text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_token, '')));
  steward_grant record;
  ev record;
  tok record;
  scanned_name text;
  new_checkin integer := 0;
  member_logged integer := 0;
  scanner_logged integer := 0;
  member_points integer := 0;
  scanner_points integer := 0;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'steward role required'
      using errcode = '42501', detail = 'scan_not_steward';
  end if;

  -- Fix the caller's chapter first, then lock one qualifying grant. Exact
  -- chapter grants are preferred over the legacy org-wide sentinel so this
  -- stays deterministic even if the role model later permits multiple scoped
  -- rows for one hat. A concurrent profile move or role revocation either
  -- commits first and is rechecked here, or waits until this scan finishes.
  select cp.chapter_id into caller_chapter
  from public.member_profiles cp
  where cp.id = caller
  for update of cp;
  if not found or caller_chapter is null then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;

  select r.user_id, r.role, r.chapter_id into steward_grant
  from public.member_roles r
  where r.user_id = caller and r.role = 'steward'
    and (r.chapter_id = caller_chapter or r.chapter_id is null)
  order by case when r.chapter_id = caller_chapter then 0 else 1 end,
           r.chapter_id nulls last
  limit 1
  for update of r;
  if not found or not public.member_has_role(array['steward']) then
    raise exception 'steward role required'
      using errcode = '42501', detail = 'scan_not_steward';
  end if;

  if clean_token = '' then
    raise exception 'enter the member''s check-in code'
      using errcode = '22023', detail = 'scan_code_missing';
  end if;

  -- Cancel/restore/delete/reschedule all take this same row lock. Recheck
  -- chapter, cancellation, and the live check-in window on the locked tuple
  -- before looking at or consuming a token.
  select e.id, e.chapter_id, e.starts_at, e.cancelled_at, e.is_public, e.is_public_across_agencies, e.check_in_code into ev
  from public.member_events e
  where e.id = p_event_id
    and e.chapter_id = caller_chapter
  for update of e;
  if not found then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'scan_event_cancelled';
  end if;
  -- No code, no check-in: a deadline or reminder admits nobody, so
  -- a personal code minted before the code was removed cannot be redeemed.
  if ev.check_in_code is null then
    raise exception 'this event has no check-in'
      using errcode = '22023', detail = 'checkin_not_offered';
  end if;
  if ev.starts_at is null
     or now() < ev.starts_at - interval '2 hours'
     or now() > ev.starts_at + interval '4 hours' then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
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

  -- Resolve, eligibility-check, and lock the member before consuming their
  -- single-use token. A concurrent deletion or chapter move either commits
  -- first and is rechecked, or waits; it cannot turn a successful response's
  -- memberName into null or make an ineligible token succeed after mutation.
  -- The token owner's eligibility is the same tenant-first event scope used
  -- by RSVP, self check-in, and token minting: active chapter and
  -- organization membership in the event's organization before any agency or
  -- cross-agency widening.
  select p.full_name into scanned_name
  from public.member_profiles p
  where p.id = tok.user_id
    and p.chapter_id is not null
    and private.member_can_access_event_scope_for_user(
      tok.user_id, ev.chapter_id, ev.is_public, ev.is_public_across_agencies
    )
  for update of p;
  if not found or nullif(pg_catalog.btrim(scanned_name), '') is null then
    raise exception 'invalid or expired check-in code'
      using errcode = '22023', detail = 'scan_code_invalid';
  end if;

  update private.member_event_checkin_tokens
  set consumed_at = now(), consumed_by = caller
  where id = tok.id;

  insert into public.member_event_checkins (event_id, user_id, scanned_by)
  values (p_event_id, tok.user_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;
  if new_checkin = 1 then
    perform private.learning_attendance_journal('event_checkin_scan', 'public.member_event_checkins', p_event_id, tok.user_id, '{"live": false}'::jsonb);
  end if;

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
    'memberName', scanned_name,
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'memberAwardedPoints', member_points,
    'scannerAwardedPoints', scanner_points
  );
end;
end;
$function$
;

create or replace function public.save_organization_live_poll(p_poll jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  poll_id uuid := nullif(p_poll ->> 'id', '')::uuid;
  payload_has_chapter boolean := pg_catalog.jsonb_exists(p_poll, 'chapterId');
  payload_chapter text := nullif(pg_catalog.btrim(coalesce(p_poll ->> 'chapterId', '')), '');
  options jsonb := coalesce(p_poll -> 'options', '[]'::jsonb);
  saved public.organization_live_polls%rowtype;
  resolved_eligibility text;
  chapter text;
begin
  perform private.engagement_require_staff(org);
  if payload_chapter is not null and not private.mi1_w2_same_org_chapter(org, payload_chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(options) <> 'array' or pg_catalog.jsonb_array_length(options) not between 2 and 10 then
    raise exception 'live polls require between 2 and 10 options' using errcode = '22023';
  end if;
  if poll_id is null then
    resolved_eligibility := coalesce(nullif(p_poll ->> 'eligibility', ''), 'organization');
    if resolved_eligibility = 'chapter' then
      chapter := coalesce(payload_chapter, private.current_member_chapter());
      if chapter is null then
        raise exception using
          errcode = '22023',
          message = 'chapter scope requires a specific chapter';
      end if;
      if not private.mi1_w2_same_org_chapter(org, chapter) then
        raise exception 'chapter is not in the selected organization' using errcode = '42501';
      end if;
    else
      chapter := null;
    end if;
    insert into public.organization_live_polls (
      organization_id, chapter_id, title, description, eligibility,
      results_visibility, scheduled_at, opens_at, closes_at, quorum_target, created_by
    ) values (
      org, chapter, pg_catalog.btrim(coalesce(p_poll ->> 'title', '')),
      pg_catalog.btrim(coalesce(p_poll ->> 'description', '')),
      resolved_eligibility,
      coalesce(nullif(p_poll ->> 'resultsVisibility', ''), 'after_close'),
      nullif(p_poll ->> 'scheduledAt', '')::timestamptz,
      nullif(p_poll ->> 'opensAt', '')::timestamptz,
      nullif(p_poll ->> 'closesAt', '')::timestamptz,
      nullif(p_poll ->> 'quorumTarget', '')::integer,
      (select auth.uid())
    ) returning * into saved;
    perform private.learning_poll_journal('live_poll_create', saved.id);
  else
    select * into saved from public.organization_live_polls
    where id = poll_id and organization_id = org for update;
    if not found then raise exception 'not found' using errcode = 'P0002'; end if;
    if saved.state not in ('draft', 'scheduled') then
      raise exception 'an active or closed poll cannot be edited' using errcode = '55000';
    end if;
    resolved_eligibility := coalesce(nullif(p_poll ->> 'eligibility', ''), saved.eligibility);
    if resolved_eligibility in ('organization', 'roster') then
      chapter := null;
    elsif payload_has_chapter or resolved_eligibility is distinct from saved.eligibility then
      chapter := coalesce(payload_chapter, saved.chapter_id, private.current_member_chapter());
      if resolved_eligibility = 'chapter' and chapter is null then
        raise exception using
          errcode = '22023',
          message = 'chapter scope requires a specific chapter';
      end if;
      if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
        raise exception 'chapter is not in the selected organization' using errcode = '42501';
      end if;
    else
      chapter := saved.chapter_id;
    end if;
    update public.organization_live_polls
    set chapter_id = case
          when resolved_eligibility in ('organization', 'roster') then null
          when payload_has_chapter or resolved_eligibility is distinct from saved.eligibility then chapter
          else saved.chapter_id
        end,
        title = pg_catalog.btrim(coalesce(p_poll ->> 'title', '')),
        description = pg_catalog.btrim(coalesce(p_poll ->> 'description', '')),
        eligibility = resolved_eligibility,
        results_visibility = coalesce(nullif(p_poll ->> 'resultsVisibility', ''), results_visibility),
        scheduled_at = nullif(p_poll ->> 'scheduledAt', '')::timestamptz,
        opens_at = nullif(p_poll ->> 'opensAt', '')::timestamptz,
        closes_at = nullif(p_poll ->> 'closesAt', '')::timestamptz,
        quorum_target = nullif(p_poll ->> 'quorumTarget', '')::integer,
        updated_at = pg_catalog.now()
    where id = saved.id returning * into saved;
    delete from public.organization_live_poll_options option where option.poll_id = saved.id;
    perform private.learning_poll_journal('live_poll_edit', saved.id);
  end if;
  insert into public.organization_live_poll_options (
    organization_id, poll_id, label, sort_index
  )
  select org, saved.id,
    pg_catalog.btrim(case when pg_catalog.jsonb_typeof(item.value) = 'string' then item.value #>> '{}' else item.value ->> 'label' end),
    item.ordinality::integer - 1
  from pg_catalog.jsonb_array_elements(options) with ordinality item(value, ordinality);
  perform private.mi1_w2_write_audit(org, 'live_poll_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'pollId', saved.id, 'userId', (select auth.uid()), 'status', saved.state,
    'count', pg_catalog.jsonb_array_length(options)
  ));
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'title', saved.title, 'state', saved.state,
    'scheduledAt', saved.scheduled_at, 'opensAt', saved.opens_at,
    'closesAt', saved.closes_at, 'eligibility', saved.eligibility,
    'resultsVisibility', saved.results_visibility,
    'chapterId', saved.chapter_id
  );
end;
end;
$function$
;

create or replace function public.transition_organization_live_poll(p_poll_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  poll public.organization_live_polls%rowtype;
  next_state text;
begin
  perform private.engagement_require_staff(org);
  select * into poll from public.organization_live_polls
  where id = p_poll_id and organization_id = org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  next_state := case p_action
    when 'schedule' then 'scheduled'
    when 'open' then 'open'
    when 'close' then 'closed'
    when 'cancel' then 'cancelled'
    when 'archive' then 'closed'
    else null
  end;
  if next_state is null then raise exception 'invalid poll action' using errcode = '22023'; end if;
  if p_action = 'schedule' and poll.state <> 'draft' then raise exception 'poll is not a draft' using errcode = '55000'; end if;
  if p_action = 'open' and poll.state not in ('draft', 'scheduled') then raise exception 'poll cannot be opened' using errcode = '55000'; end if;
  if p_action in ('close', 'archive') and poll.state <> 'open' then raise exception 'poll is not open' using errcode = '55000'; end if;
  if p_action = 'cancel' and poll.state not in ('draft', 'scheduled', 'open') then raise exception 'poll cannot be cancelled' using errcode = '55000'; end if;
  update public.organization_live_polls
  set state = next_state,
      opens_at = case when p_action = 'open' then coalesce(opens_at, pg_catalog.now()) else opens_at end,
      closed_at = case when next_state in ('closed', 'cancelled') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where id = poll.id returning * into poll;
  perform private.recalculate_organization_live_poll(poll.id);
  perform private.learning_poll_journal('live_poll_transition', poll.id);
  perform private.mi1_w2_write_audit(org, 'live_poll_transitioned', pg_catalog.jsonb_build_object(
    'organizationId', org, 'pollId', poll.id, 'userId', (select auth.uid()), 'status', next_state,
    'action', p_action, 'count', poll.vote_count
  ));
  return pg_catalog.jsonb_build_object(
    'id', poll.id, 'state', next_state, 'opensAt', poll.opens_at,
    'closesAt', poll.closes_at, 'closedAt', poll.closed_at
  );
end;
end;
$function$
;

create or replace function public.set_organization_live_poll_event(p_poll_id uuid, p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  next_event text := nullif(pg_catalog.btrim(coalesce(p_event_id, '')), '');
  poll public.organization_live_polls%rowtype;
begin
  perform private.engagement_require_staff(org);
  select * into poll from public.organization_live_polls
  where id = p_poll_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if poll.state not in ('draft', 'scheduled', 'open') then
    raise exception 'a closed or cancelled poll cannot be edited' using errcode = '55000';
  end if;
  if next_event is not null and not private.live_poll_meeting_visible(org, next_event) then
    raise exception 'meeting unavailable' using errcode = '42501';
  end if;
  update public.organization_live_polls
  set event_id = next_event, updated_at = pg_catalog.now()
  where id = poll.id;
  perform private.learning_poll_journal('live_poll_meeting', poll.id);
  perform private.mi1_w2_write_audit(org, 'live_poll_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'pollId', poll.id, 'userId', (select auth.uid()), 'status', poll.state,
    'fieldsChanged', pg_catalog.jsonb_build_array('meeting')
  ));
  return pg_catalog.jsonb_build_object('pollId', poll.id, 'eventId', next_event);
end;
end;
$function$
;

-- The organizer editor reads the version it sends back.
create or replace function public.get_connected_workflow_context(p_kind text, p_id text, p_chapter_id text default NULL::text, p_organization_id uuid default NULL::uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  src jsonb;
  src_state text;
  caller_chapter text;
  is_staff boolean;
  storage_kind text;
  attach public.chapter_task_attachments%rowtype;
  linked_task public.chapter_tasks%rowtype;
  linked jsonb := null;
  can_remind boolean := false;
  can_task boolean := false;
  can_message boolean := false;
  reason_remind text := null;
  reason_task text := null;
  reason_message text := null;
  discussion text := null;
  route text;
  links jsonb := '[]'::jsonb;
  link_row record;
  link_src jsonb;
  ev public.member_events%rowtype;
  organizer jsonb := null;
  opt_in boolean := false;
  can_manage boolean := false;
  can_opt boolean := false;
  contact_role text := null;
  starts jsonb := null;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('private_message', 'channel_post', 'task_message', 'task', 'event') then
    perform private.cw_fail('invalid_input', '22023', 'invalid reference', 'kind');
  end if;
  -- Exact tenant membership: an active chapter AND organization membership.
  if private.current_member_organization() is null then
    return private.cw_unavailable_context('source_unavailable', p_kind);
  end if;

  src := private.cw_resolve_source(caller, p_kind, p_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    return private.cw_unavailable_context('source_unavailable', p_kind);
  end if;
  if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
    return private.cw_unavailable_context('scope_changed', p_kind);
  end if;
  src_state := src ->> 'state';

  caller_chapter := private.current_member_chapter();
  is_staff := caller_chapter is not null and private.member_has_chapter_role(
    caller_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']);

  storage_kind := case p_kind
    when 'private_message' then 'private' when 'channel_post' then 'channel'
    when 'task_message' then 'task' when 'task' then 'task_item' else 'event' end;

  -- Reminder
  if src_state = 'removed' then reason_remind := 'source_removed';
  elsif src_state = 'cancelled' then reason_remind := 'event_cancelled';
  elsif private.cw_active_reminder_count(caller, storage_kind, src ->> 'id') >= 20 then reason_remind := 'limit_reached';
  else can_remind := true; end if;

  -- Linked task (staff only) and creation
  if p_kind = 'task_message' then
    -- A task message already belongs to a task: offer that task (never a new
    -- one) to staff of the caller's current chapter, under the ordinary task
    -- read predicate.
    if not is_staff then
      reason_task := 'staff_grant_required';
    elsif src ->> 'chapterId' is distinct from caller_chapter then
      reason_task := 'chapter_mismatch';
    else
      select t.* into linked_task from public.chapter_tasks t
      where t.id = (src ->> 'taskId')::uuid and t.deleted_at is null
        and private.cw_task_readable(caller, t.id);
      if found then
        linked := pg_catalog.to_jsonb(linked_task) || pg_catalog.jsonb_build_object(
          'taskKey', pg_catalog.lower(linked_task.chapter_id) || '-' || linked_task.task_number::text,
          'href', '/m/tasks?task=' || linked_task.id::text);
        can_task := true;
      else
        reason_task := 'source_removed';
      end if;
    end if;
  elsif p_kind not in ('private_message', 'channel_post', 'event') then
    reason_task := 'not_offered';
  elsif not is_staff then
    reason_task := 'staff_grant_required';
  elsif src ->> 'chapterId' is distinct from caller_chapter then
    -- Work is created in the caller's current chapter for a source of that chapter.
    reason_task := 'chapter_mismatch';
  else
    select a.* into attach
    from public.chapter_task_attachments a
    where a.chapter_id = caller_chapter
      and a.source_kind = case p_kind when 'private_message' then 'message' else p_kind end
      and a.source_id = src ->> 'id';
    if found then
      select t.* into linked_task from public.chapter_tasks t where t.id = attach.task_id and t.deleted_at is null;
      if found then
        linked := pg_catalog.to_jsonb(linked_task) || pg_catalog.jsonb_build_object(
          'taskKey', pg_catalog.lower(linked_task.chapter_id) || '-' || linked_task.task_number::text,
          'href', '/m/tasks?task=' || linked_task.id::text);
        can_task := true;
      else
        reason_task := 'linked_task_deleted';
      end if;
    elsif src_state = 'removed' then
      reason_task := 'source_removed';
    else
      can_task := true;
    end if;
  end if;

  -- Message audience (tasks: existing boundaries; events: organizer/participant thread)
  if p_kind not in ('task', 'event') then
    reason_message := 'not_offered';
  elsif exists (select 1 from private.cw_recipients(caller, src)) then
    can_message := true;
  elsif p_kind = 'event' then
    reason_message := case
      when src_state = 'cancelled' then 'event_cancelled'
      when not exists (select 1 from public.member_events e where e.id = src ->> 'id' and e.organizer_id is not null) then 'organizer_required'
      when exists (select 1 from private.member_event_contact_opt_ins o
                   join public.member_events e on e.id = o.event_id and e.organizer_id = o.organizer_id
                   where o.event_id = src ->> 'id' and o.user_id = caller) then 'organizer_not_reachable'
      else 'no_authorized_audience' end;
  else
    reason_message := 'no_authorized_audience';
  end if;

  -- Event organizer / consent
  if p_kind = 'event' then
    select e.* into ev from public.member_events e where e.id = src ->> 'id';
    if ev.organizer_id is not null and private.cw_event_organizer_ok(ev.organizer_id, ev.id) then
      select pg_catalog.jsonb_build_object(
        'id', pr.id, 'label', coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Organizer'))
      into organizer from public.member_profiles pr where pr.id = ev.organizer_id;
    end if;
    opt_in := exists (
      select 1 from private.member_event_contact_opt_ins o
      where o.event_id = ev.id and o.user_id = caller and o.organizer_id = ev.organizer_id);
    can_manage := private.member_can_manage_events() and ev.chapter_id = caller_chapter;
    can_opt := opt_in or (
      ev.cancelled_at is null and organizer is not null and ev.organizer_id <> caller
      and exists (select 1 from public.member_event_rsvps r
                  where r.event_id = ev.id and r.user_id = caller and r.status = 'going'));
    contact_role := case
      when ev.organizer_id = caller and private.cw_event_organizer_ok(caller, ev.id) then 'organizer'
      when opt_in then 'participant' end;
    -- Discussion is offered only for a thread the caller may read right now:
    -- a participant's own history (the event is still readable, checked above),
    -- or the current, authorized organizer with a consenting participant. Each
    -- link is confirmed against the canonical private-message read predicate.
    if exists (select 1 from private.member_event_contact_links l
               where l.event_id = ev.id and l.participant_id = caller
                 and private.can_read_message_source(caller, 'private', l.message_id, null, null))
       or (ev.organizer_id = caller
           and private.cw_event_organizer_ok(caller, ev.id)
           and exists (select 1 from private.member_event_contact_links l
                       where l.event_id = ev.id and l.organizer_id = caller
                         and private.cw_event_contact_ready(l.participant_id, ev.id)
                         and private.can_read_message_source(caller, 'private', l.message_id, null, null))) then
      discussion := '/m/events?event=' || ev.id || '&discussion=1';
    end if;
    starts := pg_catalog.jsonb_build_object('basis', 'instant', 'startsAt', ev.starts_at, 'eventZone', null);
  end if;

  -- Task: the caller's own task thread and the sources the task was created from
  if p_kind in ('task', 'task_message') then
    if p_kind = 'task_message' then
      discussion := src ->> 'href';
    elsif exists (
      select 1 from public.chapter_task_messages m
      where m.task_id = (src ->> 'id')::uuid and caller in (m.sender_id, m.recipient_id)) then
      discussion := '/m/messages?taskThread=' || (src ->> 'id');
    end if;
  end if;
  if p_kind = 'task' then
    for link_row in
      select a.source_kind, a.source_id
      from public.chapter_task_attachments a
      where a.task_id = (src ->> 'id')::uuid
        and a.chapter_id = src ->> 'chapterId'
        and a.source_kind in ('message', 'channel_post', 'event')
      order by a.created_at, a.id
      limit 20
    loop
      link_src := private.cw_resolve_source(caller,
        case link_row.source_kind when 'message' then 'private_message' else link_row.source_kind end,
        link_row.source_id);
      if coalesce((link_src ->> 'ok')::boolean, false) then
        links := links || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'reference', pg_catalog.jsonb_build_object(
            'kind', link_src ->> 'kind', 'id', link_src ->> 'id',
            'organizationId', link_src -> 'organizationId', 'chapterId', link_src -> 'chapterId'),
          'label', case link_src ->> 'kind'
            when 'private_message' then 'Linked message'
            when 'channel_post' then 'Linked channel post'
            else 'Linked event' end));
      end if;
    end loop;
  end if;

  route := src ->> 'href';
  if p_kind = 'task' and not private.member_has_chapter_role(
       src ->> 'chapterId', array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    route := null;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', true, 'reason', null, 'kind', p_kind, 'id', src ->> 'id',
    'organizationId', src -> 'organizationId', 'chapterId', src -> 'chapterId',
    'state', src_state, 'href', route,
    'canMessage', can_message, 'canRemind', can_remind, 'canCreateTask', can_task,
    'reasons', pg_catalog.jsonb_build_object(
      'message', reason_message, 'remind', reason_remind, 'task', reason_task),
    'linkedTask', linked, 'discussionHref', discussion, 'sourceLinks', links,
    'timezone', starts, 'cancelled', src_state = 'cancelled',
    'organizer', organizer, 'contactOptIn', opt_in,
    'canManageOrganizer', can_manage,
    -- The version an organizer change sends back; event staff only.
    'eventVersion', case when can_manage then ev.version end, 'canContactOptIn', can_opt, 'contactRole', contact_role);
end;
$function$
;

-- The event desk reads the version it sends back with an edit.
create or replace function public.get_admin_events()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'title', e.title, 'startsAt', e.starts_at,
      'endsAt', e.ends_at, 'eventKind', e.event_kind, 'eventDate', e.event_date,
      'seriesId', e.series_id, 'checkInOffered', e.check_in_offered,
      'location', e.location, 'summary', e.summary,
      'checkInCode', e.check_in_code, 'orderIndex', e.order_index,
      'chapterId', e.chapter_id, 'chapterName', c.name,
      'isPublic', e.is_public,
      'isPublicAcrossAgencies', e.is_public_across_agencies,
      'cancelledAt', e.cancelled_at,
      'cancelledReason', e.cancelled_reason,
      'rsvpOpen', e.rsvp_open,
      'rsvpCount', coalesce(r.n, 0), 'checkinCount', coalesce(k.n, 0),
      'checkinLockouts24h', coalesce(l.n, 0),
      'agenda', e.agenda,
      'minutes', coalesce(mr.items, '[]'::jsonb),
      'version', e.version
    ) order by e.order_index)
    from public.member_events e
    join public.chapters c on c.id = e.chapter_id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_rsvps where status = 'going' group by event_id
    ) r on r.event_id = e.id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_checkins group by event_id
    ) k on k.event_id = e.id
    left join (
      select a.detail ->> 'eventId' as event_id, pg_catalog.count(*) as n
      from public.member_admin_audit a
      where a.action = 'event_checkin_lockout'
        and a.created_at >= now() - interval '24 hours'
      group by a.detail ->> 'eventId'
    ) l on l.event_id = e.id
    left join lateral (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', cr.id, 'title', cr.title)
               order by cr.occurred_at desc, cr.id) as items
      from public.chapter_records cr
      where cr.event_id = e.id and cr.chapter_id = caller_chapter
        and cr.record_type = 'minutes' and cr.archived_at is null
        and (private.chapter_record_manageable(cr.chapter_id,cr.access_unit_id,cr.access_committee_id)
          or (cr.lifecycle_status = 'published' and cr.visibility = 'chapter'
            and private.chapter_record_publication(cr.record_type) = 'chapter_members'
            and private.can_read_chapter_member_record(cr.chapter_id)
            and private.chapter_scope_member_allowed(cr.chapter_id,cr.access_unit_id,cr.access_committee_id,caller)))
    ) mr on true
    where e.chapter_id = caller_chapter
  ), '[]'::jsonb);
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 7. Account lifecycle
-- ---------------------------------------------------------------------------
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','learning_held_member_events','organizer_id','pseudonymize','excluded_with_reason','auth_user_fk','Staff attribution on a held event copy that nobody reads but undo; the event itself is chapter content.','The organizer becomes null on account deletion; a restored event has no organizer.'),
 ('private','learning_held_member_event_rsvps','user_id','cascade','excluded_with_reason','auth_user_fk','A held copy of an RSVP that nobody reads but undo; it is put back or discarded, and exported again once restored.','Removed with the account; the restored event lacks that RSVP.'),
 ('private','learning_held_member_event_contact_opt_ins','user_id','cascade','excluded_with_reason','auth_user_fk','A held copy of contact consent that nobody reads but undo; it is put back or discarded, and exported again once restored.','Removed with the account, as the consent itself is.'),
 ('private','learning_held_member_event_contact_links','participant_id','pseudonymize','excluded_with_reason','auth_user_fk','A held copy of a message link that nobody reads but undo; the message itself is exported through its own record.','The participant becomes null on account deletion, as on the link itself.'),
 ('private','learning_held_member_event_contact_links','organizer_id','pseudonymize','excluded_with_reason','auth_user_fk','A held copy of a message link that nobody reads but undo; the message itself is exported through its own record.','The organizer becomes null on account deletion, as on the link itself.');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.schema_name = 'private' and s.table_name in (
     'learning_held_member_events', 'learning_held_member_event_rsvps', 'learning_held_member_event_contact_opt_ins',
     'learning_held_member_event_contact_links', 'learning_held_meeting_minutes_event_notices', 'learning_action_journal'))
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in ('learning_event_delete_kept()'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_learning_events_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the learning period events';
  end if;
end;
$assert_learning_events_trigger_review$;

commit;
