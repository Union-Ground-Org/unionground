-- REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103
-- (#6945), slice 6 of 9 of #6805. Built on the engine
-- (20261103163000_learning_period_engine.sql, #6940) and the task slice
-- (20261103183000_learning_period_tasks.sql, #6941). Design:
-- the operator runbook, "Messages and
-- notices", the invitation rows of "Invitations and membership", "Exports",
-- open questions 1 and 2, build-record row 6.
--
-- Project decisions of Nov 3, 2026 (, 7:54 AM and 10:51 AM ET) that bind
-- this slice: what went out during the period is permanent (never recalled
-- or blocked); removing your own message is undoable while the period runs;
-- automations are preview-only during the period; the practice marker stays
-- on items created during it; undo never touches the audit trail.
--
-- What this migration does, while an organization's learning period runs:
--   * Sent things are journalled metadata-only (kind, target id, time, kept):
--     direct and steward messages, conversation starts, chapter thread
--     posts, peer and coordination messages, published and retracted
--     notices, invitations, every export with a run row, digital actions and
--     civic messages to officials. Never a body, notification text,
--     recipient list or file.
--   * Removing your own message holds it instead of redacting it: the row is
--     hidden from every reader at once and the body stays in its own row
--     only. Undo in the period clears the hold. Closing the period (its end
--     or ending it early) finishes each held removal through
--     private.redact_member_message_row; an unreleased legal hold suspends
--     that, and releasing the hold finishes it. Retention expiry, account
--     closure and staff removal redact at once, held or not. AGENTS.md and
--     the operator runbook carry the amended
--     contract.
--   * Reverse: scheduling a message (undo cancels it while pending),
--     cancelling one (undo puts it back while its time is still ahead),
--     reactions, saved messages and reminders.
--   * Invitations: sending is permanent; a revoke holds the link's token so
--     undo makes the same link work again while it has not expired, with no
--     new email. Closing the period finishes held revokes.
--   * Automations are preview-only while the period runs: every automation
--     of the organization, whenever it was switched on, runs as a practice
--     preview (what it would act on, recorded on
--     organization_automation_runs) and acts on nothing; "run for real" is
--     refused until the period ends, and its schedule moves on, so nothing
--     previewed is ever sent afterwards. Switching one on or off, or the
--     organization's switch, stays undoable.
--
-- The undo dispatcher and the period close step are shared by every slice.
-- This migration moves the installed ones aside under slice-named names
-- and puts thin versions in front that handle this slice's work and hand
-- everything else to them, so it composes with whichever slices applied
-- before it.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Vocabulary
-- ---------------------------------------------------------------------------
alter table private.learning_action_kinds
  drop constraint learning_action_kinds_domain,
  add constraint learning_action_kinds_domain check (domain in (
    'engine', 'tasks', 'cases', 'case_access', 'events', 'messages', 'membership', 'settings',
    'exports', 'automations'));

alter table public.member_invitation_audit
  drop constraint member_invitation_audit_action_check;
alter table public.member_invitation_audit
  add constraint member_invitation_audit_action_check check (action in (
    'invite_requested', 'invite_sent', 'invite_delivery_failed',
    'invite_resent', 'invite_revoked', 'invite_claimed', 'invite_accepted',
    'invite_expired', 'reinvite_requested', 'reinvite_accepted',
    'invite_restored'
  ));

insert into private.learning_action_kinds (action_kind, domain, disposition, target_table, creates, handler, before_image_columns, note) values
  -- Sent: metadata-only, kept from the start, never undone.
  ('message_send', 'messages', 'permanent', 'public.member_messages', true, null, array[]::text[],
    'Sending a message in a conversation. It went out, so it stays sent.'),
  ('conversation_start', 'messages', 'permanent', 'public.member_messages', true, null, array[]::text[],
    'Starting a conversation with its first message. It went out, so it stays sent.'),
  ('message_edit', 'messages', 'permanent', 'public.member_messages', false, null, array[]::text[],
    'Editing a message you sent. The earlier text is not kept anywhere, so the edit stays.'),
  ('message_remove', 'messages', 'permanent', 'public.member_messages', false, null, array[]::text[],
    'Removing a message as chapter staff. The text is destroyed at once, so it stays removed.'),
  ('thread_post', 'messages', 'permanent', 'public.chapter_thread_posts', true, null, array[]::text[],
    'Posting in a chapter thread. Posts are immutable and others were notified, so it stays.'),
  ('peer_message_send', 'messages', 'permanent', 'public.member_peer_messages', true, null, array[]::text[],
    'Sending a message to another member. It went out, so it stays sent.'),
  ('coordination_message_send', 'messages', 'permanent', 'public.organization_coordination_messages', true, null, array[]::text[],
    'Sending a coordination message to a partner organization. It went out, so it stays sent.'),
  ('broadcast_publish', 'messages', 'permanent', 'public.member_broadcasts', true, null, array[]::text[],
    'Publishing a broadcast or notice. It went out; the in-app copy carries the practice marker.'),
  ('broadcast_retract', 'messages', 'permanent', 'public.member_broadcasts', false, null, array[]::text[],
    'Retracting a published notice. Copies already delivered stay delivered.'),
  ('civic_message_send', 'messages', 'permanent', 'public.civic_member_messages', true, null, array[]::text[],
    'Recording a message you sent to an official. It left Union Ground, so it stays sent.'),
  ('digital_action_join', 'messages', 'permanent', 'public.digital_action_participants', true, null, array[]::text[],
    'Taking part in a digital action. It left Union Ground, so it stays.'),
  ('digital_action_leave', 'messages', 'permanent', 'public.digital_action_participants', false, null, array[]::text[],
    'Leaving a digital action you took part in. What already went out stays.'),
  ('invitation_send', 'membership', 'permanent', 'public.member_invitations', true, null, array[]::text[],
    'Sending or resending an invitation. The email went out; "Stop this invitation from working" is the remedy, not undo.'),
  ('organization_export_request', 'exports', 'permanent', 'public.organization_data_export_runs', true, null, array[]::text[],
    'Requesting an organization export. The file cannot be recalled.'),
  ('analytics_export_request', 'exports', 'permanent', 'public.organization_analytics_exports', true, null, array[]::text[],
    'Requesting an analytics export. The file cannot be recalled.'),
  ('coordination_export_request', 'exports', 'permanent', 'public.organization_coordination_export_runs', true, null, array[]::text[],
    'Running a coordination export. The file cannot be recalled.'),
  ('digital_action_export_request', 'exports', 'permanent', 'public.digital_action_exports', true, null, array[]::text[],
    'Requesting a digital-action participant export. The file cannot be recalled.'),
  -- Reverse.
  ('message_remove_own', 'messages', 'reverse', 'public.member_messages', false, 'private.learning_undo_message_removal',
    array['held', 'redacted']::text[],
    'Removing your own message. It is hidden from everyone at once and destroyed when the period closes; undo shows it again.'),
  ('scheduled_message_create', 'messages', 'reverse', 'public.member_scheduled_messages', true, 'private.learning_undo_scheduled_message',
    array[]::text[], 'Scheduling a message; undo cancels it while it has not been sent.'),
  ('scheduled_message_cancel', 'messages', 'reverse', 'public.member_scheduled_messages', false, 'private.learning_undo_scheduled_message',
    array['status', 'scheduled_for', 'sent']::text[], 'Cancelling a scheduled message; undo schedules it again while its time is still ahead.'),
  ('message_react', 'messages', 'reverse', 'public.member_message_reactions', true, 'private.learning_undo_message_mark',
    array[]::text[], 'Reacting to a message; undo takes the reaction away.'),
  ('message_unreact', 'messages', 'reverse', 'public.member_message_reactions', false, 'private.learning_undo_message_mark',
    array['live', 'actor_id', 'source_kind', 'private_message_id', 'channel_post_id', 'task_message_id', 'reaction']::text[],
    'Taking a reaction away; undo puts it back.'),
  ('message_save', 'messages', 'reverse', 'public.member_saved_messages', true, 'private.learning_undo_message_mark',
    array[]::text[], 'Saving a message for yourself; undo unsaves it.'),
  ('message_unsave', 'messages', 'reverse', 'public.member_saved_messages', false, 'private.learning_undo_message_mark',
    array['live', 'owner_id', 'source_kind', 'private_message_id', 'channel_post_id', 'task_message_id', 'saved_at']::text[],
    'Unsaving a message; undo saves it again.'),
  ('message_reminder_set', 'messages', 'reverse', 'public.member_message_reminders', true, 'private.learning_undo_message_reminder',
    array[]::text[], 'Setting a reminder; undo cancels it.'),
  ('message_reminder_change', 'messages', 'reverse', 'public.member_message_reminders', false, 'private.learning_undo_message_reminder',
    array['status', 'remind_at', 'note', 'title', 'repeat_rule', 'time_zone', 'audience', 'snooze_count', 'completed_at', 'delivered_at']::text[],
    'Changing, snoozing, finishing or cancelling a reminder; undo puts it back as it was.'),
  ('invitation_revoke', 'membership', 'reverse', 'public.member_invitations', false, 'private.learning_undo_invitation_revoke',
    array['status', 'revoked_at', 'failure_code']::text[],
    'Stopping an invitation from working. Undo makes the same link work again while it has not expired; no new email is sent.'),
  ('automation_activate', 'automations', 'reverse', 'public.organization_automation_definitions', false, 'private.learning_undo_automation',
    array['status', 'next_run_at']::text[],
    'Switching an automation on, off or archiving it. Automations only preview while the period runs; undo puts the status back.'),
  ('automation_definition_save', 'automations', 'permanent', 'public.organization_automation_definitions', false, null, array[]::text[],
    'Saving, submitting or reviewing an automation definition. Its own versions and review record keep it; it is not undone.'),
  ('automation_switch', 'automations', 'reverse', 'public.organization_automation_settings', false, 'private.learning_undo_automation',
    array['enabled', 'max_effects_per_run']::text[],
    'Turning automations on or off for the organization, or changing their limit. Automations only preview while the period runs.');

-- ---------------------------------------------------------------------------
-- 2. Held states: a removal or revoke that waits for the period to close
-- ---------------------------------------------------------------------------
-- A held own-message removal keeps its body in its own row only and hides
-- the row from every reader. It is a learning-period state: closing the
-- period redacts it, and it never coexists with a redaction.
alter table public.member_messages
  add column learning_removal_held_at timestamptz,
  add constraint member_messages_learning_removal_hold check (learning_removal_held_at is null or redacted_at is null);
comment on column public.member_messages.learning_removal_held_at is
  'REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103: set when the sender removed their own message during the organization''s learning period. The row is hidden from every reader; the body stays in this row only until the period closes (private.redact_member_message_row) or the sender undoes the removal.';
create index member_messages_learning_removal_held_idx
  on public.member_messages (learning_removal_held_at, id)
  where learning_removal_held_at is not null;

-- Every client read of a held row is refused, realtime included; definer
-- readers filter it themselves (section 7).
create policy learning_removal_hold on public.member_messages
  as restrictive for select to authenticated
  using (learning_removal_held_at is null);
comment on policy learning_removal_hold on public.member_messages is
  'REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103: a message its sender removed during the learning period is hidden from every reader while its removal is held.';

-- A revoked invitation keeps its token hash only while the revoke is held,
-- so undo can make the same link work again. Nothing accepts a revoked row.
alter table public.member_invitations
  add column learning_revoke_held_at timestamptz,
  add constraint member_invitations_learning_revoke_hold check (learning_revoke_held_at is null or status = 'revoked');
alter table public.member_invitations
  drop constraint member_invitations_state_check;
alter table public.member_invitations
  add constraint member_invitations_state_check check (
    (status = 'pending' and token_hash is not null and auth_user_id is null)
    or (status = 'accepting' and token_hash is not null and accepting_at is not null)
    or (status = 'accepted' and token_hash is null and accepted_at is not null)
    or (status in ('revoked', 'superseded', 'delivery_failed', 'expired')
        and (token_hash is null or (status = 'revoked' and learning_revoke_held_at is not null)))
  );
comment on column public.member_invitations.learning_revoke_held_at is
  'REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103: set when an invitation was revoked during the organization''s learning period. The token hash stays only so undo can reopen the same link; closing the period clears it.';

-- A preview the learning period ran instead of a real run.
alter table public.organization_automation_runs
  add column learning_practice boolean not null default false,
  add constraint organization_automation_runs_learning_practice check (
    not learning_practice or (mode = 'preview' and status = 'previewed' and confirmation_phrase is null));
comment on column public.organization_automation_runs.learning_practice is
  'REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103: a scheduled run the learning period turned into a practice preview. It acted on nothing and can never be run for real.';

-- ---------------------------------------------------------------------------
-- 3. Sent things: one metadata-only journal entry per row a person sends
-- ---------------------------------------------------------------------------
-- An after-row trigger on each table whose rows are deliveries, so every
-- write path (RPC or the column-scoped client insert a table still has) is
-- covered without copying anything: the entry names the kind and the row id
-- and nothing else. It journals only a row the signed-in person is the
-- sender or requester of; a worker, a seed or another person's row is never
-- journalled to them, and outside a running period the append does nothing.
create function private.learning_journal_sent()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  kind text;
  target text;
  actor uuid;
begin
  -- A row removed by a cascade (an account or membership going away) is
  -- not anyone's practice action.
  if caller is null or (tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() > 1) then
    return null;
  end if;
  case tg_table_name
    when 'member_messages' then
      actor := coalesce(new.sender_id, caller);
      target := new.id::text;
      kind := case when exists (
          select 1 from public.member_messages m
          where m.conversation_id = new.conversation_id and m.id <> new.id)
        then 'message_send' else 'conversation_start' end;
    when 'chapter_thread_posts' then
      actor := new.author_id; target := new.id::text; kind := 'thread_post';
    when 'member_peer_messages' then
      actor := new.sender_id; target := new.id::text; kind := 'peer_message_send';
    when 'organization_coordination_messages' then
      actor := new.sender_user_id; target := new.id::text; kind := 'coordination_message_send';
    when 'member_broadcasts' then
      actor := coalesce(new.created_by, caller); target := new.id;
      if tg_op = 'INSERT' then
        kind := 'broadcast_publish';
      elsif old.retracted_at is null and new.retracted_at is not null then
        kind := 'broadcast_retract';
      end if;
    when 'civic_member_messages' then
      -- Only the send: a draft is the member's own unsent text.
      actor := new.user_id; target := new.id::text;
      if new.status = 'sent' and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
        kind := 'civic_message_send';
      end if;
    when 'digital_action_participants' then
      if tg_op = 'INSERT' then
        actor := new.user_id; target := new.action_id::text || ':' || new.user_id::text; kind := 'digital_action_join';
      else
        actor := old.user_id; target := old.action_id::text || ':' || old.user_id::text; kind := 'digital_action_leave';
      end if;
    when 'organization_data_export_runs' then
      actor := new.requested_by; target := new.id::text; kind := 'organization_export_request';
    when 'organization_analytics_exports' then
      actor := new.created_by; target := new.id::text; kind := 'analytics_export_request';
    when 'organization_coordination_export_runs' then
      actor := new.requested_by; target := new.id::text; kind := 'coordination_export_request';
    when 'digital_action_exports' then
      actor := new.created_by; target := new.id::text; kind := 'digital_action_export_request';
    else
      raise exception 'learning sent journal not configured for %', tg_table_name using errcode = '55000';
  end case;
  if kind is not null and actor = caller then
    perform private.learning_journal_append(kind, tg_table_schema || '.' || tg_table_name, target);
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_journal_sent() from public, anon, authenticated, service_role;

create trigger z90_learning_journal_sent after insert on public.member_messages
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert on public.chapter_thread_posts
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert on public.member_peer_messages
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert on public.organization_coordination_messages
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert or update of retracted_at on public.member_broadcasts
for each row execute function private.learning_journal_sent();
-- Its sent journal takes the case-graph lock, so the civic message table
-- joins the account case graph with the same two gates every graph table
-- has. It references no account or case row, so its row-key gate locks no key.
create trigger a00_case_graph_lock before insert or update or delete on public.civic_member_messages
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.civic_member_messages
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z90_learning_journal_sent after insert or update of status on public.civic_member_messages
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert or delete on public.digital_action_participants
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert on public.organization_data_export_runs
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert on public.organization_analytics_exports
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert on public.organization_coordination_export_runs
for each row execute function private.learning_journal_sent();
create trigger z90_learning_journal_sent after insert on public.digital_action_exports
for each row execute function private.learning_journal_sent();

-- ---------------------------------------------------------------------------
-- 4. Undo handlers (the interface is in 20261103163000)
-- ---------------------------------------------------------------------------
-- A held own-message removal. Its state is whether the row is held or
-- redacted, never its text. Undo shows the message again; nothing is
-- destroyed by it, so a legal hold on the conversation does not stop it
-- (preservation forbids destroying, not showing). A redaction that has
-- already happened (retention, account closure, staff removal or the close
-- of the period) changes the state and refuses the undo.
create function private.learning_undo_message_removal(p_mode text, p_entry jsonb)
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
  message_row public.member_messages%rowtype;
begin
  if p_mode = 'lock' then
    perform private.lock_member_message_conversation(m.conversation_id)
    from public.member_messages m where m.id = target;
    perform 1 from public.member_messages m where m.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return (select pg_catalog.jsonb_build_object(
        'held', m.learning_removal_held_at is not null, 'redacted', m.redacted_at is not null)
      from public.member_messages m where m.id = target);
  elsif p_mode = 'before' then
    return p_entry -> 'before_image';
  elsif p_mode = 'check' then
    select m.* into message_row from public.member_messages m where m.id = target;
    if message_row.id is null or message_row.redacted_at is not null
       or coalesce(message_row.sender_id, case when message_row.sender_kind = 'member' then message_row.user_id end) is distinct from caller then
      raise exception 'this message can no longer be restored' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  update public.member_messages m
  set learning_removal_held_at = null
  where m.id = target and m.learning_removal_held_at is not null and m.redacted_at is null;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_message_removal(text, jsonb) from public, anon, authenticated, service_role;

-- A scheduled message: its status, time and whether it went out. Undoing
-- the scheduling cancels it while it is pending; undoing a cancel puts it
-- back while its time is still ahead. Once dispatched the state no longer
-- matches and undo is refused: what was sent stays sent.
create function private.learning_scheduled_message_state(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object('status', s.status, 'scheduled_for', s.scheduled_for, 'sent', s.sent_message_id is not null)
  from public.member_scheduled_messages s where s.id = p_id;
$function$;
revoke all on function private.learning_scheduled_message_state(uuid) from public, anon, authenticated, service_role;

create function private.learning_undo_scheduled_message(p_mode text, p_entry jsonb)
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
  scheduled public.member_scheduled_messages%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_scheduled_messages s where s.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_scheduled_message_state(target);
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'scheduled_message_create' then return null; end if;
    return p_entry -> 'before_image';
  elsif p_mode = 'check' then
    select s.* into scheduled from public.member_scheduled_messages s where s.id = target;
    if scheduled.id is null or scheduled.actor_id is distinct from caller or scheduled.redacted_at is not null then
      raise exception 'this scheduled message is no longer yours to change' using errcode = '42501';
    end if;
    if p_entry ->> 'action_kind' = 'scheduled_message_cancel'
       and (scheduled.scheduled_for <= pg_catalog.clock_timestamp()
            or not private.can_actor_send_private_message(caller, scheduled.conversation_id, scheduled.sender_kind)) then
      raise exception 'this message can no longer be scheduled again' using errcode = '55000';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_entry ->> 'action_kind' = 'scheduled_message_create' then
    update public.member_scheduled_messages s set status = 'cancelled'
    where s.id = target and s.status = 'pending';
  else
    update public.member_scheduled_messages s set status = 'pending'
    where s.id = target and s.status = 'cancelled' and s.sent_message_id is null;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_scheduled_message(text, jsonb) from public, anon, authenticated, service_role;

-- A reaction or a saved message: it exists with these values, or it does not.
create function private.learning_message_mark_state(p_table text, p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(case p_table
    when 'public.member_message_reactions' then (
      select pg_catalog.jsonb_build_object('live', true, 'actor_id', r.actor_id, 'source_kind', r.source_kind,
        'private_message_id', r.private_message_id, 'channel_post_id', r.channel_post_id,
        'task_message_id', r.task_message_id, 'reaction', r.reaction)
      from public.member_message_reactions r where r.id = p_id)
    when 'public.member_saved_messages' then (
      select pg_catalog.jsonb_build_object('live', true, 'owner_id', s.owner_id, 'source_kind', s.source_kind,
        'private_message_id', s.private_message_id, 'channel_post_id', s.channel_post_id,
        'task_message_id', s.task_message_id, 'saved_at', s.saved_at)
      from public.member_saved_messages s where s.id = p_id)
  end, '{"live": false}'::jsonb);
$function$;
revoke all on function private.learning_message_mark_state(text, uuid) from public, anon, authenticated, service_role;

create function private.learning_undo_message_mark(p_mode text, p_entry jsonb)
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
  target uuid := (p_entry ->> 'target_id')::uuid;
  image jsonb := p_entry -> 'before_image';
  creation boolean := p_entry ->> 'action_kind' in ('message_react', 'message_save');
  owner uuid;
begin
  if target_table not in ('public.member_message_reactions', 'public.member_saved_messages') then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_mode = 'lock' then
    if target_table = 'public.member_message_reactions' then
      perform 1 from public.member_message_reactions r where r.id = target for update;
    else
      perform 1 from public.member_saved_messages s where s.id = target for update;
    end if;
    return null;
  elsif p_mode = 'state' then
    return private.learning_message_mark_state(target_table, target);
  elsif p_mode = 'before' then
    if creation then return '{"live": false}'::jsonb; end if;
    return image;
  elsif p_mode = 'check' then
    -- Only your own mark, and putting one back needs the message to be one
    -- you can still read, with no equal mark already there.
    if creation then
      owner := (p_entry -> 'projected_state' ->> case when target_table = 'public.member_message_reactions' then 'actor_id' else 'owner_id' end)::uuid;
      if owner is distinct from caller then
        raise exception 'this is no longer yours to change' using errcode = '42501';
      end if;
      return null;
    end if;
    owner := (image ->> case when target_table = 'public.member_message_reactions' then 'actor_id' else 'owner_id' end)::uuid;
    if owner is distinct from caller
       or not private.can_read_message_source(caller, image ->> 'source_kind',
         (image ->> 'private_message_id')::uuid, (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid) then
      raise exception 'this message is no longer available' using errcode = '42501';
    end if;
    if (target_table = 'public.member_message_reactions' and exists (
          select 1 from public.member_message_reactions r
          where r.actor_id = caller and r.source_kind = image ->> 'source_kind' and r.reaction = image ->> 'reaction'
            and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id)
              = coalesce((image ->> 'private_message_id')::uuid, (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid)))
       or (target_table = 'public.member_saved_messages' and exists (
          select 1 from public.member_saved_messages s
          where s.owner_id = caller and s.source_kind = image ->> 'source_kind'
            and coalesce(s.private_message_id, s.channel_post_id, s.task_message_id)
              = coalesce((image ->> 'private_message_id')::uuid, (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid))) then
      raise exception 'this is already back' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if creation then
    if target_table = 'public.member_message_reactions' then
      delete from public.member_message_reactions r where r.id = target and r.actor_id = caller;
    else
      delete from public.member_saved_messages s where s.id = target and s.owner_id = caller;
    end if;
  elsif target_table = 'public.member_message_reactions' then
    insert into public.member_message_reactions (id, actor_id, source_kind, private_message_id, channel_post_id, task_message_id, reaction)
    values (target, caller, image ->> 'source_kind', (image ->> 'private_message_id')::uuid,
      (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid, image ->> 'reaction');
  else
    insert into public.member_saved_messages (id, owner_id, source_kind, private_message_id, channel_post_id, task_message_id, saved_at)
    values (target, caller, image ->> 'source_kind', (image ->> 'private_message_id')::uuid,
      (image ->> 'channel_post_id')::uuid, (image ->> 'task_message_id')::uuid, (image ->> 'saved_at')::timestamptz);
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_message_mark(text, jsonb) from public, anon, authenticated, service_role;

-- A reminder of your own: its schedule, wording and progress. Undoing a new
-- one cancels it; undoing a change puts every field back. A reminder that
-- was already delivered no longer matches, so it is not taken back.
create function private.learning_message_reminder_state(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object('status', r.status, 'remind_at', r.remind_at, 'note', r.note, 'title', r.title,
    'repeat_rule', r.repeat_rule, 'time_zone', r.time_zone, 'audience', r.audience, 'snooze_count', r.snooze_count,
    'completed_at', r.completed_at, 'delivered_at', r.delivered_at)
  from public.member_message_reminders r where r.id = p_id;
$function$;
revoke all on function private.learning_message_reminder_state(uuid) from public, anon, authenticated, service_role;

-- The one journal call each reminder writer makes after its change.
create function private.learning_reminder_journal(p_kind text, p_id uuid, p_before jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  return private.learning_journal_append(
    p_kind, 'public.member_message_reminders', p_id::text, null,
    private.learning_fingerprint(private.learning_message_reminder_state(p_id)), null,
    case when p_kind = 'message_reminder_set' then '{}'::jsonb else p_before end);
end;
$function$;
revoke all on function private.learning_reminder_journal(text, uuid, jsonb) from public, anon, authenticated, service_role;

create function private.learning_undo_message_reminder(p_mode text, p_entry jsonb)
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
  image jsonb := p_entry -> 'before_image';
begin
  if p_mode = 'lock' then
    perform 1 from public.member_message_reminders r where r.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_message_reminder_state(target);
  elsif p_mode = 'before' then
    if p_entry ->> 'action_kind' = 'message_reminder_set' then return null; end if;
    return image;
  elsif p_mode = 'check' then
    if not exists (select 1 from public.member_message_reminders r where r.id = target and r.owner_id = caller) then
      raise exception 'this reminder is no longer yours to change' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_entry ->> 'action_kind' = 'message_reminder_set' then
    update public.member_message_reminders r
    set status = 'cancelled', updated_at = pg_catalog.now()
    where r.id = target and r.owner_id = caller and r.status in ('pending', 'scheduled');
  else
    update public.member_message_reminders r
    set status = image ->> 'status', remind_at = (image ->> 'remind_at')::timestamptz, note = image ->> 'note',
        title = image ->> 'title', repeat_rule = image ->> 'repeat_rule', time_zone = image ->> 'time_zone',
        audience = image ->> 'audience', snooze_count = (image ->> 'snooze_count')::smallint,
        completed_at = (image ->> 'completed_at')::timestamptz, delivered_at = (image ->> 'delivered_at')::timestamptz,
        updated_at = pg_catalog.now()
    where r.id = target and r.owner_id = caller;
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_message_reminder(text, jsonb) from public, anon, authenticated, service_role;

-- A revoked invitation whose revoke is held. Undo makes the same link work
-- again (pending) while it has not expired, sends no email, and records
-- invite_restored in the invitation's own audit. The person must still be
-- able to stop that invitation today.
create function private.learning_invitation_state(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object('status', i.status, 'revoked_at', i.revoked_at, 'failure_code', i.failure_code)
  from public.member_invitations i where i.id = p_id;
$function$;
revoke all on function private.learning_invitation_state(uuid) from public, anon, authenticated, service_role;

create function private.learning_undo_invitation_revoke(p_mode text, p_entry jsonb)
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
  image jsonb := p_entry -> 'before_image';
  invitation_row public.member_invitations%rowtype;
begin
  if p_mode = 'lock' then
    perform 1 from public.member_invitations i where i.id = target for update;
    return null;
  elsif p_mode = 'state' then
    return private.learning_invitation_state(target);
  elsif p_mode = 'before' then
    return image;
  elsif p_mode = 'check' then
    select i.* into invitation_row from public.member_invitations i where i.id = target;
    if invitation_row.id is null
       or not (private.member_invitation_chapter_administrable(invitation_row.chapter_id)
               or (invitation_row.initial_role is null and invitation_row.kind = 'provision'
                   and private.member_invitation_chapter_presided(invitation_row.chapter_id))) then
      raise exception 'you can no longer manage this invitation' using errcode = '42501';
    end if;
    if invitation_row.learning_revoke_held_at is null
       or (image ->> 'status' = 'pending' and (invitation_row.token_hash is null
           or invitation_row.expires_at <= pg_catalog.clock_timestamp())) then
      raise exception 'this invitation link has expired' using errcode = '55000';
    end if;
    -- Nobody may have become this person since the invitation was sent: no
    -- account was created for the address and no invitation to it was
    -- accepted or is being accepted. (A former member's account predates
    -- their invitation and does not count.)
    if invitation_row.auth_user_id is not null or exists (
      select 1 from auth.users u
      where pg_catalog.lower(u.email) = invitation_row.normalized_email and u.created_at >= invitation_row.created_at
    ) or exists (
      select 1 from public.member_invitations other
      where other.normalized_email = invitation_row.normalized_email and other.id <> invitation_row.id
        and (other.status = 'accepting' or (other.status = 'accepted' and other.accepted_at >= invitation_row.created_at))
    ) then
      raise exception 'this person has joined since; send a new invitation instead' using errcode = '40001';
    end if;
    if image ->> 'status' = 'pending' and exists (
      select 1 from public.member_invitations other
      where other.normalized_email = invitation_row.normalized_email and other.id <> invitation_row.id
        and other.status in ('pending', 'accepting')
    ) then
      raise exception 'a newer invitation to this person is already open' using errcode = '40001';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  update public.member_invitations i
  set status = image ->> 'status',
      revoked_at = null,
      failure_code = image ->> 'failure_code',
      -- Only a pending invitation has a working link; any other earlier state
      -- carries no token, exactly as before the revoke.
      token_hash = case when image ->> 'status' = 'pending' then i.token_hash end,
      learning_revoke_held_at = null
  where i.id = target and i.status = 'revoked' and i.learning_revoke_held_at is not null
  returning i.* into invitation_row;
  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, caller, 'invite_restored',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version));
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_invitation_revoke(text, jsonb) from public, anon, authenticated, service_role;

-- An automation's status, or the organization's automation switch and
-- limit. Undo puts them back through the same audit the controls write.
create function private.learning_automation_state(p_table text, p_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case p_table
    when 'public.organization_automation_definitions' then (
      select pg_catalog.jsonb_build_object('status', d.status)
      from public.organization_automation_definitions d where d.id::text = p_id)
    when 'public.organization_automation_settings' then (
      select pg_catalog.jsonb_build_object('enabled', coalesce(s.enabled, false), 'max_effects_per_run', coalesce(s.max_effects_per_run, 20))
      from (select 1) one
      left join public.organization_automation_settings s on s.organization_id::text = p_id)
  end;
$function$;
revoke all on function private.learning_automation_state(text, text) from public, anon, authenticated, service_role;

create function private.learning_undo_automation(p_mode text, p_entry jsonb)
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
  image jsonb := p_entry -> 'before_image';
  org uuid;
  saved_definition public.organization_automation_definitions%rowtype;
  saved_settings public.organization_automation_settings%rowtype;
begin
  if target_table not in ('public.organization_automation_definitions', 'public.organization_automation_settings') then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if p_mode = 'lock' then
    if target_table = 'public.organization_automation_definitions' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || d.organization_id::text, 0))
      from public.organization_automation_definitions d where d.id::text = target;
      perform 1 from public.organization_automation_definitions d where d.id::text = target for update;
    else
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || target, 0));
      perform 1 from public.organization_automation_settings s where s.organization_id::text = target for update;
    end if;
    return null;
  elsif p_mode = 'state' then
    return private.learning_automation_state(target_table, target);
  elsif p_mode = 'before' then
    return image - 'next_run_at';
  elsif p_mode = 'check' then
    -- Today's rule for each control: an approver for an automation's status,
    -- an operator for the organization's switch and limit.
    if target_table = 'public.organization_automation_definitions' then
      org := private.automation_v3_require_approver();
      if not exists (select 1 from public.organization_automation_definitions d where d.id::text = target and d.organization_id = org) then
        raise exception 'you can no longer change this automation' using errcode = '42501';
      end if;
    elsif private.cr108_require_operator()::text is distinct from target then
      raise exception 'you can no longer change automation for this organization' using errcode = '42501';
    end if;
    return null;
  elsif p_mode <> 'apply' then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  if target_table = 'public.organization_automation_definitions' then
    update public.organization_automation_definitions d
    set status = image ->> 'status',
        next_run_at = case when image ->> 'status' = 'active'
          then coalesce((image ->> 'next_run_at')::timestamptz, pg_catalog.now()) end,
        updated_by = caller,
        updated_at = pg_catalog.now()
    where d.id::text = target
    returning d.* into saved_definition;
    perform private.cr108_record_audit(saved_definition.organization_id, 'automation_definition_status_changed', 'update',
      'automation_definition', saved_definition.id::text, caller,
      pg_catalog.jsonb_build_object('status', saved_definition.status, 'reviewStatus', saved_definition.review_status,
        'version', saved_definition.version),
      extensions.gen_random_uuid());
  else
    update public.organization_automation_settings s
    set enabled = (image ->> 'enabled')::boolean,
        max_effects_per_run = (image ->> 'max_effects_per_run')::smallint,
        updated_by = caller,
        updated_at = pg_catalog.now()
    where s.organization_id::text = target
    returning s.* into saved_settings;
    perform private.cr108_record_audit(saved_settings.organization_id, 'automation_kill_switch_changed', 'settings_change',
      'organization', saved_settings.organization_id::text, caller,
      pg_catalog.jsonb_build_object('status', case when saved_settings.enabled then 'enabled' else 'paused' end),
      extensions.gen_random_uuid());
  end if;
  return null;
end;
end;
$function$;
revoke all on function private.learning_undo_automation(text, jsonb) from public, anon, authenticated, service_role;

-- Automations are preview-only during the period (owner's ruling of Nov 3,
-- 2026): while the organization's learning period runs, every automation of
-- that organization, whenever it was switched on, records a practice preview
-- and acts on nothing.
create function private.learning_automation_preview_only(p_organization_id uuid, p_definition_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $function$
  select p_definition_id is not null and private.learning_period_running(p_organization_id) is not null;
$function$;
revoke all on function private.learning_automation_preview_only(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The shared dispatcher and close step gain this slice's work
-- ---------------------------------------------------------------------------
-- The installed dispatcher keeps every branch the earlier slices gave it;
-- it moves aside under its own name and this one hands it every handler
-- that is not this slice's. Dispatch stays static: only named, reviewed
-- functions are ever called.
alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_messages;
comment on function private.learning_dispatch_before_messages(text, text, jsonb) is
  'REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103: the undo dispatcher as the slices before slice 6 left it, reached only through private.learning_dispatch.';

create function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb)
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
    when 'private.learning_undo_message_removal' then return private.learning_undo_message_removal(p_mode, p_entry);
    when 'private.learning_undo_scheduled_message' then return private.learning_undo_scheduled_message(p_mode, p_entry);
    when 'private.learning_undo_message_mark' then return private.learning_undo_message_mark(p_mode, p_entry);
    when 'private.learning_undo_message_reminder' then return private.learning_undo_message_reminder(p_mode, p_entry);
    when 'private.learning_undo_invitation_revoke' then return private.learning_undo_invitation_revoke(p_mode, p_entry);
    when 'private.learning_undo_automation' then return private.learning_undo_automation(p_mode, p_entry);
    else return private.learning_dispatch_before_messages(p_handler, p_mode, p_entry);
  end case;
end;
$function$;
revoke all on function private.learning_dispatch(text, text, jsonb) from public, anon, authenticated, service_role;

-- Finish one held own-message removal: redact it through the one path
-- allowed to destroy a delivered body, unless an unreleased legal hold
-- covers its conversation, in which case it stays held (hidden) and the
-- hold's release finishes it. Returns true when the body was destroyed.
create function private.learning_finish_held_message_removal(p_message_id uuid, p_actor uuid, p_organization_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  conversation uuid;
  removed boolean;
begin
  select m.conversation_id into conversation from public.member_messages m where m.id = p_message_id;
  if conversation is null then
    return false;
  end if;
  perform private.lock_member_message_conversation(conversation);
  if not exists (
    select 1 from public.member_messages m
    where m.id = p_message_id and m.learning_removal_held_at is not null and m.redacted_at is null
  ) or private.member_message_under_legal_hold(conversation) then
    return false;
  end if;
  removed := private.redact_member_message_row(p_message_id, 'sender_removed', p_actor);
  if removed and p_organization_id is not null then
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      p_organization_id, 'privacy', 'message.redacted', 'delete', p_actor,
      'message', p_message_id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('reasonCode', 'sender_removed', 'operation', 'redact', 'count', 1)
    );
  end if;
  return removed;
end;
end;
$function$;
revoke all on function private.learning_finish_held_message_removal(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Everything this slice holds for a closed period becomes final: held
-- removals are redacted (or stay held under a legal hold) and held revokes
-- lose their token. Safe to rerun.
create function private.learning_finish_held_messages(p_period_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  period private.organization_learning_periods%rowtype;
  held record;
  redacted integer := 0;
  suspended integer := 0;
  revokes integer := 0;
begin
  select * into period from private.organization_learning_periods p where p.id = p_period_id;
  if period.id is null or period.closed_at is null then
    return pg_catalog.jsonb_build_object('heldRemovalsRedacted', 0, 'heldRemovalsSuspended', 0, 'heldRevokesFinished', 0);
  end if;
  for held in
    select j.target_id, j.actor_user_id
    from private.learning_action_journal j
    join public.member_messages m on m.id::text = j.target_id
    where j.period_id = period.id and j.action_kind = 'message_remove_own' and j.state = 'kept'
      and m.learning_removal_held_at is not null and m.redacted_at is null
    order by j.target_id
  loop
    if private.learning_finish_held_message_removal(held.target_id::uuid, held.actor_user_id, period.organization_id) then
      redacted := redacted + 1;
    else
      suspended := suspended + 1;
    end if;
  end loop;
  update public.member_invitations i
  set token_hash = null, learning_revoke_held_at = null
  from private.learning_action_journal j
  where j.period_id = period.id and j.action_kind = 'invitation_revoke' and j.state = 'kept'
    and i.id::text = j.target_id and i.learning_revoke_held_at is not null;
  get diagnostics revokes = row_count;
  return pg_catalog.jsonb_build_object('heldRemovalsRedacted', redacted, 'heldRemovalsSuspended', suspended,
    'heldRevokesFinished', revokes);
end;
end;
$function$;
revoke all on function private.learning_finish_held_messages(uuid) from public, anon, authenticated, service_role;

-- The installed close step keeps every end step the earlier slices gave it;
-- it moves aside and this one runs it, then finishes what this slice held.
-- The end job and ending early both close through here.
alter function private.close_learning_period(uuid) rename to close_learning_period_before_messages;
comment on function private.close_learning_period_before_messages(uuid) is
  'REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103: the period close step as the slices before slice 6 left it, reached only through private.close_learning_period.';

create function private.close_learning_period(p_period_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  closed jsonb;
begin
  -- Close first: what this slice finishes is only final once the period is.
  closed := private.close_learning_period_before_messages(p_period_id);
  return closed || private.learning_finish_held_messages(p_period_id);
end;
end;
$function$;
revoke all on function private.close_learning_period(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Messages: held own-message removal, edits, scheduling, marks
-- ---------------------------------------------------------------------------
-- The one path allowed to destroy a delivered body (re-emitted from
-- 20260907152000). A held row is redacted like any other, at once, and stops
-- being held: retention expiry, account closure, staff removal and the close
-- of the period all come through here.
create or replace function private.redact_member_message_row(
  p_message_id uuid,
  p_reason text,
  p_actor uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  message_row public.member_messages%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if p_reason not in ('sender_removed', 'staff_removed', 'retention_expired', 'account_closed') then
    raise exception 'unsupported redaction reason' using errcode = '22023';
  end if;

  perform private.lock_member_message_conversation(m.conversation_id)
  from public.member_messages m where m.id = p_message_id;
  select m.* into message_row
  from public.member_messages m
  where m.id = p_message_id
  for update;
  if message_row.id is null then
    return false;
  end if;
  if message_row.redacted_at is not null then
    return false;
  end if;
  if private.member_message_under_legal_hold(message_row.conversation_id) then
    raise exception 'conversation is under a preservation order' using errcode = '42501';
  end if;

  update public.member_messages m
    set body = '',
        body_sha256 = pg_catalog.encode(
          extensions.digest(message_row.body, 'sha256'), 'hex'),
        original_length = pg_catalog.char_length(message_row.body),
        redacted_at = pg_catalog.now(),
        redacted_by = p_actor,
        redaction_reason = p_reason,
        learning_removal_held_at = null
    where m.id = message_row.id;

  -- Sweep the dispatched copy; section 6 invalidates persisted briefings.
  update public.member_scheduled_messages s
    set body = '', redacted_at = pg_catalog.now()
    where s.sent_message_id = message_row.id and s.redacted_at is null;

  return true;
end;
$function$;

-- Removing a message (re-emitted from 20260907152000). While the caller's
-- organization runs its learning period, removing your own message holds
-- it: hidden from every reader at once, its body kept in its own row only,
-- and nothing copied, logged or put in the ledger. Undo in the period shows
-- it again; the period's close redacts it. A preservation order refuses the
-- removal exactly as before. Staff removal of someone else's message, and
-- every removal outside a period, redacts at once as before.
create or replace function public.redact_member_message(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  message_row public.member_messages%rowtype;
  org uuid;
  reason text;
  removed boolean;
  held_at timestamptz;
  held_entry uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select m.* into message_row
  from public.member_messages m
  where m.id = p_message_id;
  if message_row.id is null then
    -- Flat denial: an unauthorized caller must not learn that an id exists.
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if message_row.user_id = caller and message_row.sender_kind = 'member' then
    -- The member removes content the member wrote. A steward's reply in the
    -- member's own conversation is the steward's content and takes the staff
    -- path below.
    reason := 'sender_removed';
  elsif public.member_has_role(array['steward', 'coordinator', 'admin'])
        and exists (
          select 1
          from public.member_profiles author
          join public.chapters c on c.id = author.chapter_id
          where author.id = message_row.user_id
            and c.id = private.current_member_chapter()
        ) then
    reason := 'staff_removed';
  else
    raise exception 'not permitted' using errcode = '42501';
  end if;

  -- Your own message, while your organization's learning period runs: hold.
  if (reason = 'sender_removed' or message_row.sender_id = caller)
     and private.learning_period_running(private.current_mobile_staff_organization()) is not null then
    perform private.lock_member_message_conversation(message_row.conversation_id);
    select m.* into message_row from public.member_messages m where m.id = message_row.id for update;
    if message_row.redacted_at is null and message_row.learning_removal_held_at is null then
      if private.member_message_under_legal_hold(message_row.conversation_id) then
        raise exception 'conversation is under a preservation order' using errcode = '42501';
      end if;
      held_at := pg_catalog.clock_timestamp();
      update public.member_messages m set learning_removal_held_at = held_at where m.id = message_row.id;
      held_entry := private.learning_journal_append('message_remove_own', 'public.member_messages', message_row.id::text, null,
        private.learning_fingerprint(pg_catalog.jsonb_build_object('held', true, 'redacted', false)), null,
        pg_catalog.jsonb_build_object('held', false, 'redacted', false));
      if held_entry is null then
        -- The period closed while this waited: an ordinary removal.
        update public.member_messages m set learning_removal_held_at = null where m.id = message_row.id;
      else
        -- The dispatched scheduled copy is a second copy of the same text: it
        -- is destroyed now, so the held body lives in its own row only. Undo
        -- shows the message again from that row and recreates no copy.
        update public.member_scheduled_messages s
          set body = '', redacted_at = pg_catalog.now()
          where s.sent_message_id = message_row.id and s.redacted_at is null;
        org := (select private.current_member_organization());
        if org is not null then
          insert into public.organization_audit_ledger (
            organization_id, domain, event_type, action, actor_user_id,
            entity_type, entity_id, idempotency_key, metadata
          ) values (
            org, 'privacy', 'message.removal_held', 'delete', caller,
            'message', message_row.id::text, extensions.gen_random_uuid(),
            pg_catalog.jsonb_build_object('reasonCode', reason, 'operation', 'hold', 'count', 1)
          );
        end if;
        return pg_catalog.jsonb_build_object('redacted', false, 'held', true, 'reasonCode', reason, 'learningEntryId', held_entry,
          'message', pg_catalog.jsonb_build_object('id', message_row.id, 'body', '', 'redacted_at', null,
            'learning_removal_held_at', held_at, 'redaction_reason', null));
      end if;
    elsif message_row.learning_removal_held_at is not null then
      return pg_catalog.jsonb_build_object('redacted', false, 'held', true, 'reasonCode', reason,
        'message', pg_catalog.jsonb_build_object('id', message_row.id, 'body', '', 'redacted_at', null,
          'learning_removal_held_at', message_row.learning_removal_held_at, 'redaction_reason', null));
    end if;
  end if;

  removed := private.redact_member_message_row(message_row.id, reason, caller);
  if not removed then
    return pg_catalog.jsonb_build_object('redacted', false, 'alreadyRedacted', true,
      'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
  end if;

  org := (select private.current_member_organization());
  if org is not null then
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'privacy', 'message.redacted', 'delete', caller,
      'message', message_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('reasonCode', reason, 'operation', 'redact', 'count', 1)
    );
  end if;
  -- A staff removal during the period is listed as done; it stays done.
  perform private.learning_journal_append('message_remove', 'public.member_messages', message_row.id::text);

  return pg_catalog.jsonb_build_object('redacted', true, 'reasonCode', reason,
    'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
end;
$function$;

-- Releasing a legal hold (re-emitted from 20260907152000) finishes any own-
-- message removal the hold suspended when its learning period closed.
create or replace function public.release_member_message_legal_hold(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  org uuid;
  released integer;
  held record;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  released := 0;
  caller := (select auth.uid());
  org := (select private.current_member_organization());
  if caller is null or org is null or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'authorization required' using errcode = '42501';
  end if;

  perform private.lock_member_message_conversation(p_conversation_id);

  update public.member_message_legal_holds h
    set released_at = pg_catalog.now(), released_by = caller
    where h.conversation_id = p_conversation_id
      and h.organization_id = org
      and h.released_at is null;
  get diagnostics released = row_count;
  if released = 0 then
    return pg_catalog.jsonb_build_object('released', false);
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'message.legal_hold_released', 'settings_change', caller,
    'message_legal_hold', p_conversation_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('operation', 'release')
  );

  -- A removal whose period has closed (its entry is kept) is final now.
  for held in
    select m.id, j.actor_user_id, j.organization_id
    from public.member_messages m
    join private.learning_action_journal j
      on j.target_table = 'public.member_messages' and j.target_id = m.id::text
     and j.action_kind = 'message_remove_own' and j.state = 'kept'
    where m.conversation_id = p_conversation_id
      and m.learning_removal_held_at is not null and m.redacted_at is null
    order by m.id
  loop
    perform private.learning_finish_held_message_removal(held.id, held.actor_user_id, held.organization_id);
  end loop;

  return pg_catalog.jsonb_build_object('released', true);
end;
$function$;

-- A held removal is a change to what readers may see, so it invalidates the
-- persisted briefings and action titles built from the conversation, as a
-- body change does (re-emitted from 20261030234500). Only the transition to
-- held invalidates; undo needs nothing removed, and no body is copied.
create or replace function private.invalidate_message_briefings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare kind text; target uuid;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'UPDATE' and old.body is not distinct from new.body
     and (pg_catalog.to_jsonb(old) -> 'body_es') is not distinct from (pg_catalog.to_jsonb(new) -> 'body_es')
     and not ((pg_catalog.to_jsonb(old) ->> 'learning_removal_held_at') is null
              and (pg_catalog.to_jsonb(new) ->> 'learning_removal_held_at') is not null) then
    return new;
  end if;
  if tg_table_name = 'member_messages' then kind := 'private'; target := old.conversation_id;
  elsif tg_table_name = 'chapter_thread_posts' then kind := 'channel'; target := old.thread_id;
  else kind := 'task'; target := old.task_id; end if;
  delete from public.compass_message_briefings where source_kind = kind and target_id = target;
  if kind = 'private' then
    update public.compass_workspace_actions set title = 'Follow up on member message'
      where source_kind = 'message' and source_id in
        (select m.id::text from public.member_messages m where m.conversation_id = target
         union select old.id::text);
  end if;
  return null;
end;
$function$;

drop trigger invalidate_message_briefings on public.member_messages;
create trigger invalidate_message_briefings after update of body, learning_removal_held_at or delete on public.member_messages
for each row execute function private.invalidate_message_briefings();

-- Editing your own message (re-emitted from 20260907140000): the edit is
-- listed as kept; the earlier text is not kept anywhere.
create or replace function public.edit_member_message(p_message_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.lock_message_lifecycle();
  declare state jsonb; clean text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  begin
    if (select auth.uid()) is null or private.mfa_satisfied() is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    state := public.get_member_message_actions('private', p_message_id);
    if (state->>'canEdit')::boolean is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if pg_catalog.char_length(clean) not between 1 and 4000 then
      raise exception 'invalid message' using errcode = '22023';
    end if;
    perform 1 from public.member_messages where id = p_message_id for update;
    update public.member_messages set body = clean, edited_at = pg_catalog.clock_timestamp() where id = p_message_id;
    -- Dispatch keeps a second body copy; an edit must replace that copy too.
    update public.member_scheduled_messages set body = clean where sent_message_id = p_message_id;
    perform private.message_action_audit('private', p_message_id, 'edited');
    perform private.learning_journal_append('message_edit', 'public.member_messages', p_message_id::text);
    return (select pg_catalog.to_jsonb(m) from public.member_messages m where m.id = p_message_id);
  end;
end;
$function$;

-- Scheduling a message (re-emitted from 20261006030000): undo cancels it
-- while it is pending.
create or replace function public.schedule_member_message(p_conversation_id uuid, p_body text, p_scheduled_for timestamp with time zone)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  conversation public.member_conversations%rowtype;
  sender_kind text;
  new_id uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;
  if p_scheduled_for <= now() or p_scheduled_for > now() + interval '1 year' then
    raise exception 'invalid schedule time' using errcode = '22023';
  end if;
  select * into conversation from public.member_conversations where id = p_conversation_id for update;
  if not found then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  if private.can_actor_send_private_message(caller, p_conversation_id, 'member') then
    sender_kind := 'member';
    if conversation.steward_user_id is null and not private.chapter_steward_reader_exists(caller) then
      raise exception 'no steward assigned' using errcode = '22023', detail = 'no_steward_assigned';
    end if;
  elsif public.member_has_role(array['steward'])
        and private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    sender_kind := 'steward';
  else
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  insert into public.member_scheduled_messages(
    actor_id, conversation_id, recipient_id, sender_kind, body, scheduled_for)
  values (caller, conversation.id, conversation.user_id, sender_kind, clean_body, p_scheduled_for)
  returning id into new_id;
  perform private.learning_journal_append('scheduled_message_create', 'public.member_scheduled_messages', new_id::text, null,
    private.learning_fingerprint(private.learning_scheduled_message_state(new_id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending');
end;
end;
end;
$function$;

-- Cancelling a scheduled message (re-emitted from 20260812200000): undo
-- schedules it again while its time is still ahead.
create or replace function public.cancel_scheduled_member_message(p_scheduled_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  before_state jsonb;
  updated integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform 1 from public.member_scheduled_messages s
  where s.id = p_scheduled_message_id and s.actor_id = caller and s.status = 'pending'
  for update;
  before_state := private.learning_scheduled_message_state(p_scheduled_message_id);
  update public.member_scheduled_messages
  set status = 'cancelled'
  where id = p_scheduled_message_id and actor_id = caller and status = 'pending';
  get diagnostics updated = row_count;
  if updated = 0 then raise exception 'scheduled message unavailable' using errcode = '22023'; end if;
  perform private.learning_journal_append('scheduled_message_cancel', 'public.member_scheduled_messages', p_scheduled_message_id::text, null,
    private.learning_fingerprint(private.learning_scheduled_message_state(p_scheduled_message_id)), null, before_state);
  return pg_catalog.jsonb_build_object('cancelled', true);
end;
end;
$function$;

-- Reacting (re-emitted from 20261001010000): each reaction added or taken
-- away is undoable.
create or replace function public.toggle_member_message_reaction(p_source_kind text, p_message_id uuid, p_reaction text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  removed integer := 0;
  new_id uuid;
  gone public.member_message_reactions%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_source_kind not in ('private','channel','task')
     or p_reaction not in ('like','support','celebrate','solidarity','strength','seen','agreed','care','grievance','victory')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('message-reaction:' || caller::text || ':' || p_message_id::text || ':' || p_reaction, 509));
  for gone in
    delete from public.member_message_reactions r
    where r.actor_id = caller and r.source_kind = p_source_kind and r.reaction = p_reaction
      and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id
    returning r.*
  loop
    removed := removed + 1;
    perform private.learning_journal_append('message_unreact', 'public.member_message_reactions', gone.id::text, null,
      private.learning_fingerprint('{"live": false}'::jsonb), null,
      pg_catalog.jsonb_build_object('live', true, 'actor_id', gone.actor_id, 'source_kind', gone.source_kind,
        'private_message_id', gone.private_message_id, 'channel_post_id', gone.channel_post_id,
        'task_message_id', gone.task_message_id, 'reaction', gone.reaction));
  end loop;
  if removed > 0 then
    return pg_catalog.jsonb_build_object('reacted', false);
  end if;

  insert into public.member_message_reactions(
    actor_id, source_kind, private_message_id, channel_post_id, task_message_id, reaction)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end,
    p_reaction)
  returning id into new_id;
  perform private.learning_journal_append('message_react', 'public.member_message_reactions', new_id::text, null,
    private.learning_fingerprint(private.learning_message_mark_state('public.member_message_reactions', new_id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('reacted', true, 'id', new_id);
end;
end;
end;
$function$;

-- Saving a message for yourself (re-emitted from 20260812200000): undoable,
-- and it takes the case-graph lock first now that it journals.
create or replace function public.toggle_member_saved_message(p_source_kind text, p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  removed integer := 0;
  new_id uuid;
  gone public.member_saved_messages%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_source_kind not in ('private','channel','task')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('saved-message:' || caller::text || ':' || p_message_id::text, 509));
  for gone in
    delete from public.member_saved_messages saved
    where saved.owner_id = caller and saved.source_kind = p_source_kind
      and coalesce(saved.private_message_id, saved.channel_post_id, saved.task_message_id) = p_message_id
    returning saved.*
  loop
    removed := removed + 1;
    perform private.learning_journal_append('message_unsave', 'public.member_saved_messages', gone.id::text, null,
      private.learning_fingerprint('{"live": false}'::jsonb), null,
      pg_catalog.jsonb_build_object('live', true, 'owner_id', gone.owner_id, 'source_kind', gone.source_kind,
        'private_message_id', gone.private_message_id, 'channel_post_id', gone.channel_post_id,
        'task_message_id', gone.task_message_id, 'saved_at', gone.saved_at));
  end loop;
  if removed > 0 then
    return pg_catalog.jsonb_build_object('saved', false);
  end if;
  insert into public.member_saved_messages(
    owner_id, source_kind, private_message_id, channel_post_id, task_message_id)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end)
  returning id into new_id;
  perform private.learning_journal_append('message_save', 'public.member_saved_messages', new_id::text, null,
    private.learning_fingerprint(private.learning_message_mark_state('public.member_saved_messages', new_id)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object('saved', true, 'id', new_id);
end;
end;
$function$;

-- Reminders of your own are undoable: a new one is cancelled, a changed one
-- put back. Re-emitted from 20260925140000, 20260812200000, 20261003033000,
-- 20261030234501 and 20261001020000.
create or replace function public.create_member_message_reminder(p_source_kind text, p_message_id uuid, p_remind_at timestamp with time zone, p_note text default ''::text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  new_id uuid;
  pending_count integer;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_remind_at <= now() or p_remind_at > now() + interval '1 year' or pg_catalog.char_length(clean_note) > 500 then
    raise exception 'invalid reminder' using errcode = '22023';
  end if;
  if p_source_kind not in ('private','channel','task')
     or not private.can_read_message_source(
       caller, p_source_kind,
       case when p_source_kind = 'private' then p_message_id end,
       case when p_source_kind = 'channel' then p_message_id end,
       case when p_source_kind = 'task' then p_message_id end) then
    raise exception 'message unavailable' using errcode = '22023';
  end if;
  select r.id into new_id
  from public.member_message_reminders r
  where r.owner_id = caller and r.status = 'pending' and r.source_kind = p_source_kind
    and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id
    and r.remind_at = p_remind_at
  order by r.created_at, r.id
  limit 1;
  if new_id is not null then
    return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending', 'coalesced', true);
  end if;
  select count(*)::integer into pending_count
  from public.member_message_reminders r
  where r.owner_id = caller and r.status = 'pending' and r.source_kind = p_source_kind
    and coalesce(r.private_message_id, r.channel_post_id, r.task_message_id) = p_message_id;
  if pending_count >= 20 then
    raise exception 'reminder limit reached: 20 pending per message' using errcode = '54000';
  end if;
  insert into public.member_message_reminders(
    owner_id, source_kind, private_message_id, channel_post_id, task_message_id, note, remind_at)
  values (
    caller, p_source_kind,
    case when p_source_kind = 'private' then p_message_id end,
    case when p_source_kind = 'channel' then p_message_id end,
    case when p_source_kind = 'task' then p_message_id end,
    clean_note, p_remind_at)
  returning id into new_id;
  perform private.learning_reminder_journal('message_reminder_set', new_id, null);
  return pg_catalog.jsonb_build_object('id', new_id, 'status', 'pending');
end;
end;
end;
$function$;

create or replace function public.cancel_member_message_reminder(p_reminder_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  before_state jsonb;
  updated integer;
begin
  if caller is null or not private.mfa_satisfied() then raise exception 'authentication required' using errcode = '42501'; end if;
  perform 1 from public.member_message_reminders r where r.id = p_reminder_id and r.owner_id = caller and r.status = 'pending' for update;
  before_state := private.learning_message_reminder_state(p_reminder_id);
  update public.member_message_reminders set status = 'cancelled'
  where id = p_reminder_id and owner_id = caller and status = 'pending';
  get diagnostics updated = row_count;
  if updated = 0 then raise exception 'reminder unavailable' using errcode = '22023'; end if;
  perform private.learning_reminder_journal('message_reminder_change', p_reminder_id, before_state);
  return pg_catalog.jsonb_build_object('cancelled', true);
end;
end;
$function$;

create or replace function public.create_channel_here_reminder(p_space_id uuid, p_remind_at timestamptz, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  space_row public.chapter_spaces%rowtype;
  org uuid;
  reminder_row public.member_message_reminders%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into space_row from public.chapter_spaces s where s.id = p_space_id;
  -- The chapter_thread_posts insert policy's standing, at channel level: the
  -- caller's selected chapter and a channel they can read. Missing, archived,
  -- another chapter's and unreadable channels give one answer.
  if not found or space_row.archived_at is not null or not private.can_read_chapter_space(space_row) then
    raise exception 'channel unavailable' using errcode = '42501';
  end if;
  select c.organization_id into org from public.chapters c where c.id = space_row.chapter_id;
  if org is null or org is distinct from private.current_member_organization() then
    raise exception 'channel unavailable' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.messaging.remind_here') then
    raise exception 'channel staff reminders are turned off for this organization'
      using errcode = '42501', detail = 'feature-disabled';
  end if;
  if not private.remind_here_staff_reads_space(caller, space_row.id) then
    raise exception 'only chapter staff can remind the channel staff'
      using errcode = '42501', detail = 'staff-required';
  end if;
  if pg_catalog.char_length(clean_note) not between 1 and 500 then
    raise exception 'reminder must be between 1 and 500 characters' using errcode = '22023';
  end if;
  if p_remind_at is null or p_remind_at <= pg_catalog.now()
     or p_remind_at > pg_catalog.now() + interval '1 year' then
    raise exception 'invalid reminder time' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('remind-here:' || caller::text || ':' || space_row.id::text, 509));

  -- A retried request returns the reminder it already created.
  select r.* into reminder_row
  from public.member_message_reminders r
  where r.owner_id = caller and r.audience = 'here' and r.source_kind = 'space'
    and r.source_ref = space_row.id::text and r.status = 'scheduled'
    and r.remind_at = p_remind_at and r.note = clean_note
  order by r.created_at, r.id
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'id', reminder_row.id, 'remindAt', reminder_row.remind_at,
      'status', 'scheduled', 'coalesced', true);
  end if;

  -- The connected-reminder bounds: 20 scheduled per source, 500 open overall.
  if (select pg_catalog.count(*) from public.member_message_reminders r
      where r.owner_id = caller and r.audience = 'here' and r.source_ref = space_row.id::text
        and r.status = 'scheduled') >= 20 then
    raise exception 'reminder limit reached: 20 scheduled per channel' using errcode = '54000';
  end if;
  if (select pg_catalog.count(*) from public.member_message_reminders r
      where r.owner_id = caller and r.status in ('pending', 'scheduled')) >= 500 then
    raise exception 'reminder limit reached: 500 scheduled' using errcode = '54000';
  end if;

  insert into public.member_message_reminders (
    owner_id, source_kind, source_ref, audience, note, remind_at, status)
  values (caller, 'space', space_row.id::text, 'here', clean_note, p_remind_at, 'scheduled')
  returning * into reminder_row;
  perform private.learning_reminder_journal('message_reminder_set', reminder_row.id, null);

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'messages', 'message.remind_here.created', 'create', caller,
    'message', reminder_row.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('sourceKind', 'space', 'sourceId', space_row.id::text)
  );

  return pg_catalog.jsonb_build_object(
    'id', reminder_row.id, 'remindAt', reminder_row.remind_at,
    'status', 'scheduled', 'coalesced', false);
end;
end;
end;
$function$;

create or replace function public.save_connected_workflow_reminder(
  p_kind text,
  p_id text,
  p_remind_at timestamptz,
  p_note text default '',
  p_chapter_id text default null,
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  src jsonb;
  src_id text;
  storage_kind text;
  reminder_row public.member_message_reminders%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('private_message', 'channel_post', 'task_message', 'task', 'event') then
    perform private.cw_fail('invalid_input', '22023', 'invalid reference', 'kind');
  end if;
  if private.current_member_organization() is null then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_remind_at is null or p_remind_at <= pg_catalog.now()
     or p_remind_at > pg_catalog.now() + interval '1 year' then
    perform private.cw_fail('invalid_input', '22023', 'invalid reminder time', 'remind_at');
  end if;
  if pg_catalog.char_length(clean_note) > 500 then
    perform private.cw_fail('invalid_input', '22023', 'note is too long', 'note');
  end if;

  src := private.cw_resolve_source(caller, p_kind, p_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
    perform private.cw_fail('scope_changed', '22023', 'source scope changed');
  end if;
  if src ->> 'state' = 'removed' then
    perform private.cw_fail('capability_unavailable', '22023', 'source removed', 'source_removed');
  end if;
  if src ->> 'state' = 'cancelled' then
    perform private.cw_fail('event_cancelled', '22023', 'this event was cancelled', 'event_cancelled');
  end if;
  src_id := src ->> 'id';
  storage_kind := case p_kind
    when 'private_message' then 'private' when 'channel_post' then 'channel'
    when 'task_message' then 'task' when 'task' then 'task_item' else 'event' end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cw-reminder:' || caller::text || ':' || storage_kind || ':' || src_id, 509));

  select r.* into reminder_row
  from public.member_message_reminders r
  where r.owner_id = caller and r.source_kind = storage_kind
    and r.status in ('pending', 'scheduled')
    and coalesce(r.private_message_id::text, r.channel_post_id::text,
                 r.task_message_id::text, r.source_ref) = src_id
    and r.remind_at = p_remind_at
  order by r.created_at, r.id
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'created', false, 'coalesced', true, 'reminder', private.cw_reminder_json(reminder_row, caller));
  end if;

  if private.cw_active_reminder_count(caller, storage_kind, src_id) >= 20 then
    perform private.cw_fail('rate_limited', '54000', 'reminder limit reached: 20 scheduled per source', 'limit_reached');
  end if;
  if (select pg_catalog.count(*) from public.member_message_reminders r
      where r.owner_id = caller and r.status in ('pending', 'scheduled')) >= 500 then
    perform private.cw_fail('rate_limited', '54000', 'reminder limit reached: 500 scheduled', 'limit_reached');
  end if;

  insert into public.member_message_reminders (
    owner_id, source_kind, private_message_id, channel_post_id, task_message_id, source_ref,
    note, remind_at, status)
  values (
    caller, storage_kind,
    case when storage_kind = 'private' then src_id::uuid end,
    case when storage_kind = 'channel' then src_id::uuid end,
    case when storage_kind = 'task' then src_id::uuid end,
    case when storage_kind in ('task_item', 'event') then src_id end,
    clean_note, p_remind_at,
    case when storage_kind in ('task_item', 'event') then 'scheduled' else 'pending' end)
  returning * into reminder_row;
  perform private.learning_reminder_journal('message_reminder_set', reminder_row.id, null);

  return pg_catalog.jsonb_build_object(
    'created', true, 'coalesced', false, 'reminder', private.cw_reminder_json(reminder_row, caller));
end;
end;
$function$;

create or replace function public.save_personal_reminder(
  p_id uuid, p_title text, p_note text, p_remind_at timestamptz, p_repeat text, p_time_zone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  clean_title text := pg_catalog.btrim(coalesce(p_title, ''));
  clean_note text := pg_catalog.btrim(coalesce(p_note, ''));
  rule text := coalesce(nullif(p_repeat, ''), 'none');
  saved public.member_message_reminders%rowtype;
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_title) not between 1 and 160 or clean_title ~ '[[:cntrl:]]' then
    raise exception 'title must be 1 to 160 characters' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_note) > 500 then
    raise exception 'note is too long' using errcode = '22023';
  end if;
  if rule not in ('none', 'daily', 'weekly', 'monthly') then
    raise exception 'invalid repeat' using errcode = '22023';
  end if;
  if p_time_zone is null
     or not exists (select 1 from private.iana_timezone_names zone where zone.name = p_time_zone) then
    raise exception 'invalid time zone' using errcode = '22023';
  end if;
  if p_remind_at is null or p_remind_at <= pg_catalog.now()
     or p_remind_at > pg_catalog.now() + interval '1 year' then
    raise exception 'invalid reminder time' using errcode = '22023';
  end if;
  if p_id is null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-reminders:' || caller::text, 0));
    if (select pg_catalog.count(*) from public.member_message_reminders r
        where r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled') >= 200 then
      raise exception 'personal reminder limit reached' using errcode = '54000';
    end if;
    insert into public.member_message_reminders
      (owner_id, source_kind, title, note, remind_at, status, repeat_rule, audience, time_zone)
    values (caller, 'personal', clean_title, clean_note, p_remind_at, 'scheduled', rule, 'me', p_time_zone)
    returning * into saved;
    perform private.learning_reminder_journal('message_reminder_set', saved.id, null);
  else
    perform 1 from public.member_message_reminders r where r.id = p_id and r.owner_id = caller for update;
    before_state := private.learning_message_reminder_state(p_id);
    update public.member_message_reminders r
    set title = clean_title, note = clean_note, remind_at = p_remind_at, repeat_rule = rule,
        time_zone = p_time_zone, updated_at = pg_catalog.now()
    where r.id = p_id and r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled'
    returning * into saved;
    if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
    perform private.learning_reminder_journal('message_reminder_change', saved.id, before_state);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'title', saved.title, 'note', saved.note, 'remindAt', saved.remind_at,
    'repeat', saved.repeat_rule, 'status', saved.status);
end;
end;
$function$;

create or replace function public.cancel_personal_reminder(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform 1 from public.member_message_reminders r where r.id = p_id and r.owner_id = caller for update;
  before_state := private.learning_message_reminder_state(p_id);
  update public.member_message_reminders r
  set status = 'cancelled', updated_at = pg_catalog.now()
  where r.id = p_id and r.owner_id = caller and r.source_kind = 'personal' and r.status = 'scheduled';
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  perform private.learning_reminder_journal('message_reminder_change', p_id, before_state);
  return pg_catalog.jsonb_build_object('id', p_id, 'status', 'cancelled');
end;
end;
$function$;

create or replace function public.act_on_connected_workflow_reminder(p_reminder_id uuid, p_action text, p_remind_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  reminder_row public.member_message_reminders%rowtype;
  src jsonb;
  api_kind text;
  shown jsonb;
  replayed boolean := false;
  active boolean;
  before_state jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_reminder_id is null or p_action is null or p_action not in ('open', 'snooze', 'complete', 'cancel') then
    perform private.cw_fail('invalid_input', '22023', 'invalid reminder action', 'action');
  end if;

  select r.* into reminder_row
  from public.member_message_reminders r
  where r.id = p_reminder_id and r.owner_id = caller
    -- Personal reminders are cancelled through cancel_personal_reminder.
    and r.source_kind <> 'personal'
  for update;
  if not found then
    perform private.cw_fail('source_unavailable', '22023', 'reminder unavailable', 'reminder');
  end if;
  before_state := private.learning_message_reminder_state(reminder_row.id);
  active := reminder_row.status in ('pending', 'scheduled', 'delivered');
  api_kind := private.cw_reminder_api_kind(reminder_row.source_kind);

  if p_action = 'open' then
    shown := private.cw_reminder_json(reminder_row, caller);
    return pg_catalog.jsonb_build_object(
      'reminder', shown,
      'available', coalesce((shown ->> 'available')::boolean, false),
      'href', shown -> 'href',
      'replayed', false);
  end if;

  if p_action = 'complete' then
    if reminder_row.status = 'completed' then
      replayed := true;
    elsif active then
      update public.member_message_reminders
      set status = 'completed', completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
      where id = reminder_row.id returning * into reminder_row;
    else
      perform private.cw_fail('capability_unavailable', '22023', 'reminder is closed', 'reminder_closed');
    end if;
  elsif p_action = 'cancel' then
    if reminder_row.status = 'cancelled' then
      replayed := true;
    elsif active then
      update public.member_message_reminders
      set status = 'cancelled', updated_at = pg_catalog.now()
      where id = reminder_row.id returning * into reminder_row;
    else
      perform private.cw_fail('capability_unavailable', '22023', 'reminder is closed', 'reminder_closed');
    end if;
  else
    if p_remind_at is null or p_remind_at <= pg_catalog.now()
       or p_remind_at > pg_catalog.now() + interval '1 year' then
      perform private.cw_fail('invalid_input', '22023', 'invalid reminder time', 'remind_at');
    end if;
    if not active then
      perform private.cw_fail('capability_unavailable', '22023', 'reminder is closed', 'reminder_closed');
    end if;
    src := private.cw_resolve_source(caller, api_kind, private.cw_reminder_source_id(reminder_row));
    if not coalesce((src ->> 'ok')::boolean, false) or private.current_member_organization() is null then
      perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
    end if;
    if src ->> 'state' = 'removed' then
      perform private.cw_fail('capability_unavailable', '22023', 'source removed', 'source_removed');
    end if;
    if src ->> 'state' = 'cancelled' then
      perform private.cw_fail('event_cancelled', '22023', 'this event was cancelled', 'event_cancelled');
    end if;
    if reminder_row.status in ('pending', 'scheduled') and reminder_row.remind_at = p_remind_at then
      replayed := true;
    else
      -- A delivered reminder owns its notification slot; free it so the
      -- snoozed reminder can notify again.
      update public.member_notifications set message_reminder_id = null
      where message_reminder_id = reminder_row.id;
      update public.member_message_reminders
      set remind_at = p_remind_at,
          status = case when source_kind in ('task_item', 'event') then 'scheduled' else 'pending' end,
          delivered_at = null,
          snooze_count = least(snooze_count + 1, 1000),
          updated_at = pg_catalog.now()
      where id = reminder_row.id returning * into reminder_row;
    end if;
  end if;

  if not replayed then
    perform private.learning_reminder_journal('message_reminder_change', reminder_row.id, before_state);
  end if;
  shown := private.cw_reminder_json(reminder_row, caller);
  return pg_catalog.jsonb_build_object(
    'reminder', shown,
    'available', coalesce((shown ->> 'available')::boolean, false),
    'href', shown -> 'href',
    'replayed', replayed);
end;
end;
$function$;

-- Sending an invitation is permanent and listed as sent (re-emitted from
-- 20261102014446, 20261004010000, 20261022171700).
create or replace function public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  target_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_role text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_initial_role, ''))), '');
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
  as_admin boolean;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- An admin may invite into any chapter they administer in the selected
  -- organization. A chapter President may invite only into a chapter they
  -- preside over, and only as a plain member (project decision, October 4,
  -- 2026). The desk gate above already holds the organization-role lock.
  as_admin := private.member_invitation_chapter_administrable(target_chapter);
  if not as_admin and (clean_role is not null
     or not private.member_invitation_chapter_presided(target_chapter)) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if clean_role is not null and (coalesce(auth.jwt()->>'aal','')<>'aal2' or not private.has_second_factor(caller)) then raise exception 'two-step sign-in required for starting access' using errcode='42501'; end if;

  -- Count before duplicate/existing-account branches. Those branches must not
  -- be a free unbounded address-probing endpoint.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_admin_hourly'), interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || target_chapter, 'chapter-day', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_chapter_daily'), interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es')
     or (clean_role is not null and clean_role not in ('steward', 'organizer', 'coordinator', 'advisor', 'vp', 'admin', 'secretary', 'records', 'treasurer')) then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     clean_role, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes')
  returning * into invitation_row;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', invitation_row.id::text);

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', clean_role, 'locale', clean_locale,
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;

create or replace function public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  -- The same desk gate as every other invitation write: a chapter admin of the
  -- selected chapter, resolved under the organization-role -> member lock
  -- order. The target chapter must then be one the caller administers in the
  -- selected organization, the same rule the list, delivery record, resend and
  -- revoke RPCs apply, so whoever can issue this invitation can also manage it.
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  target_org uuid;
  locked_org uuid;
  target_user uuid;
  prior_revoked_at timestamptz;
  profile_row public.member_profiles%rowtype;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
begin
  -- Organization admin only, with the second factor every admin membership
  -- write demands. private.has_organization_role already carries the MFA
  -- step-up; the explicit check keeps the refusal the same when it is absent.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select c.organization_id into target_org
  from public.chapters c
  where c.id = p_chapter_id;
  if target_org is null or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;
  if caller_chapter is null
     or not private.member_invitation_chapter_administrable(p_chapter_id) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- Count before the eligibility branches: an ineligible address must not be a
  -- free unbounded probing endpoint. Same persisted buckets as the ordinary
  -- invitation, so one admin's budget is one budget.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', 10, interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || p_chapter_id, 'chapter-day', 50, interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-role:' || target_org::text, 509));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  -- Re-derive and re-authorize under the tenant lock, as the grant and
  -- set_member_organization_role do: a request that queued behind a role
  -- revocation must not expire or issue invitations with the authority it had
  -- before the lock was granted.
  select c.organization_id into locked_org
  from public.chapters c
  where c.id = p_chapter_id;
  if locked_org is distinct from target_org
     or not private.mfa_satisfied()
     or not private.has_organization_role(target_org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  -- Eligibility: exactly one live account owns the address, it has a profile,
  -- its membership in THIS organization is revoked, and it is active in no
  -- organization. Anything else (no account, never a member here, active
  -- here or elsewhere, a live invitation already out) returns the uniform
  -- accepted/no-send outcome and writes nothing.
  select u.id into target_user
  from auth.users u
  where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
  order by u.created_at
  limit 1;
  if target_user is null then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || target_user::text, 0));
  select * into profile_row from public.member_profiles p where p.id = target_user;
  select om.revoked_at into prior_revoked_at
  from public.organization_memberships om
  where om.organization_id = target_org
    and om.user_id = target_user
    and om.status = 'revoked';
  if not found
     or profile_row.id is null
     or exists (
       select 1 from public.organization_memberships other
       where other.user_id = target_user and other.status = 'active'
     )
     or exists (
       select 1 from public.member_invitations i
       where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
     ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, kind)
  values
    (clean_email, profile_row.full_name, profile_row.first_name, profile_row.initials, p_chapter_id,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes', 'reactivation')
  returning * into invitation_row;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', invitation_row.id::text);

  perform private.audit_member_invitation(
    invitation_row.id, p_chapter_id, caller, 'reinvite_requested',
    pg_catalog.jsonb_build_object('chapterId', p_chapter_id,
      'organizationId', target_org, 'priorRevokedAt', prior_revoked_at,
      'locale', clean_locale, 'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at
  );
end;
end;
$function$;

create or replace function public.create_roster_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_locale text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  target_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  clean_name text := pg_catalog.btrim(coalesce(p_full_name, ''));
  clean_locale text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_locale, '')));
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  organization uuid;
  name_parts text[];
  clean_first text;
  clean_initials text;
  invitation_row public.member_invitations%rowtype;
  expired_row public.member_invitations%rowtype;
  refused_limit text;
  refused_scope text;
  refused_operation text;
  refused_window interval;
  day_retry timestamptz;
  refused_retry timestamptz;
begin
  -- Roster import is for chapter administrators only; a chapter President keeps
  -- the ad-hoc invitation and its limits.
  if caller is null or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not private.member_invitation_chapter_administrable(target_chapter) then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- A malformed request is refused before any lookup or charge, the same way
  -- for every address. Validating after the account probe let an unknown
  -- address raise (rolling back its lookup charge) while an existing one
  -- answered 202, which is free probing.
  name_parts := pg_catalog.regexp_split_to_array(clean_name, '[[:space:]]+');
  clean_first := name_parts[1];
  clean_initials := pg_catalog.upper(
    pg_catalog.left(clean_first, 1)
    || case when pg_catalog.array_length(name_parts, 1) > 1
       then pg_catalog.left(name_parts[pg_catalog.array_length(name_parts, 1)], 1)
       else '' end
  );
  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or pg_catalog.char_length(coalesce(clean_first, '')) not between 1 and 80
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es') then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- Every row is charged to the roster lookup throttle before any lookup can
  -- shape the answer, so the endpoint stays bounded for address probing
  -- (count-before-lookup, as in the ad-hoc create). An address that already
  -- has an account or a live invitation is then answered without touching the
  -- sending allowance, so re-sending a roster that lists current members, or
  -- people already invited, never exhausts it (project decision 20261021-2220,
  -- option b). A failed delivery is not a no-op: re-sending it creates a new
  -- invitation and email, and that counts as a send.
  organization := private.current_member_organization();
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'roster-lookup-hour', private.organization_limit(organization, 'limits.security.invitation_roster_lookup_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001',
      detail = pg_catalog.jsonb_build_object(
        'limit', 'limits.security.invitation_roster_lookup_hourly',
        'retryAt', private.member_invitation_limit_retry_at('admin:' || caller::text, 'roster-lookup-hour', interval '1 hour')
      )::text;
  end if;
  -- Everything after the lookup charge runs in one subtransaction. Only an
  -- unknown address reaches the sending charges, the expiry update and the
  -- insert, so any error there (a constraint, a reused token hash, an audit
  -- write) must not roll the charge back: it is caught here, only this block
  -- is undone, and a refusal is returned with the charge committed for every
  -- address.
  begin
  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email
      and (i.status = 'accepting' or (i.status = 'pending' and i.expires_at > clock_timestamp()))
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  -- The sending charges run in their own subtransaction. A refusal rolls back
  -- only roster-hour and roster-day; the lookup charge above stays committed,
  -- and the refusal is returned as a result (the API answers 429). A RAISE
  -- here would also undo the lookup charge, so once the sending allowance was
  -- spent an unknown address would cost nothing while an existing one cost a
  -- lookup: free probing for accounts.
  begin
    if not private.consume_member_invitation_admin_limit(
      'admin:' || caller::text, 'roster-hour', private.organization_limit(organization, 'limits.security.invitation_roster_admin_hourly'), interval '1 hour'
    ) then
      refused_limit := 'limits.security.invitation_roster_admin_hourly';
      refused_scope := 'admin:' || caller::text;
      refused_operation := 'roster-hour';
      refused_window := interval '1 hour';
    elsif not private.consume_member_invitation_admin_limit(
      'chapter:' || target_chapter, 'roster-day', private.organization_limit(organization, 'limits.security.invitation_roster_chapter_daily'), interval '1 day'
    ) then
      refused_limit := 'limits.security.invitation_roster_chapter_daily';
      refused_scope := 'chapter:' || target_chapter;
      refused_operation := 'roster-day';
      refused_window := interval '1 day';
    end if;
    -- An hourly stop while the chapter's daily window is also spent reports the
    -- later of the two, so the retry time is when sending can actually resume.
    if refused_operation = 'roster-hour' then
      select l.window_started_at + interval '1 day' into day_retry
      from private.member_invitation_admin_limits l
      where l.scope_key = 'chapter:' || target_chapter and l.operation = 'roster-day'
        and l.window_started_at + interval '1 day' > clock_timestamp()
        and l.request_count >= private.organization_limit(organization, 'limits.security.invitation_roster_chapter_daily');
      if day_retry is not null
         and day_retry > private.member_invitation_limit_retry_at(refused_scope, refused_operation, refused_window) then
        refused_limit := 'limits.security.invitation_roster_chapter_daily';
        refused_scope := 'chapter:' || target_chapter;
        refused_operation := 'roster-day';
        refused_window := interval '1 day';
      end if;
    end if;
    if refused_limit is not null then
      refused_retry := private.member_invitation_limit_retry_at(refused_scope, refused_operation, refused_window);
      raise exception 'invitation rate limited' using errcode = 'P0001';
    end if;
  exception when sqlstate 'P0001' then
    if refused_limit is null then
      raise;
    end if;
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'send', false, 'rateLimited', true,
      'limit', refused_limit, 'retryAt', refused_retry);
  end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-email:' || clean_email, 509)
  );

  for expired_row in
    update public.member_invitations
    set status = 'expired', token_hash = null, failure_code = null
    where normalized_email = clean_email
      and status = 'pending'
      and expires_at <= clock_timestamp()
    returning *
  loop
    perform private.audit_member_invitation(
      expired_row.id, expired_row.chapter_id, caller, 'invite_expired',
      pg_catalog.jsonb_build_object('chapterId', expired_row.chapter_id,
        'deliveryVersion', expired_row.delivery_version)
    );
  end loop;

  if exists (
    select 1 from auth.users u
    where pg_catalog.lower(pg_catalog.btrim(coalesce(u.email, ''))) = clean_email
  ) or exists (
    select 1 from public.member_invitations i
    where i.normalized_email = clean_email and i.status in ('pending', 'accepting')
  ) then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     expires_at, source)
  values
    (clean_email, clean_name, clean_first, clean_initials, target_chapter,
     null, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '7 days', 'roster')
  returning * into invitation_row;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', invitation_row.id::text);

  perform private.audit_member_invitation(
    invitation_row.id, target_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', target_chapter,
      'initialRole', null, 'locale', clean_locale, 'source', 'roster',
      'deliveryVersion', invitation_row.delivery_version)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', invitation_row.id,
    'deliveryVersion', invitation_row.delivery_version,
    'expiresAt', invitation_row.expires_at,
    'source', 'roster'
  );
  exception when others then
    return pg_catalog.jsonb_build_object('accepted', false, 'send', false, 'unavailable', true);
  end;
end;
end;
$function$;

create or replace function public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Installed Main carries this routine wrapped by the reviewed case-graph
  -- entry block of 20260907151000 (gate before declaration initializers);
  -- re-emitting it keeps that outer gate.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'resend-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_resend_admin_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;
  if clean_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid invitation request' using errcode = '22023';
  end if;

  -- An invitation of any chapter the caller administers in the selected
  -- organization; every other id gets the same no-op answer as a missing one.
  select * into old_row
  from public.member_invitations
  where id = p_invitation_id
    and (private.member_invitation_chapter_administrable(chapter_id)
         or (initial_role is null and kind = 'provision'
             and private.member_invitation_chapter_presided(chapter_id)))
  for update;
  if not found or old_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'send', false);
  end if;
  if not private.consume_member_invitation_admin_limit(
    'invitation:' || old_row.id::text, 'invitation-resend-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_resend_per_invite_hourly'), interval '1 hour'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  update public.member_invitations
  set status = 'superseded', token_hash = null, failure_code = null
  where id = old_row.id;

  insert into public.member_invitations
    (normalized_email, full_name, first_name, initials, chapter_id,
     initial_role, locale, token_hash, status, delivery_version, invited_by,
     replaces_id, expires_at, kind, source)
  values
    (old_row.normalized_email, old_row.full_name, old_row.first_name,
     old_row.initials, old_row.chapter_id, old_row.initial_role, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, caller, old_row.id,
     clock_timestamp() + case when old_row.source = 'roster' then interval '7 days' else interval '15 minutes' end,
     old_row.kind, old_row.source)
  returning * into new_row;
  perform private.learning_journal_append('invitation_send', 'public.member_invitations', new_row.id::text);

  perform private.audit_member_invitation(
    new_row.id, new_row.chapter_id, caller, 'invite_resent',
    pg_catalog.jsonb_build_object('chapterId', new_row.chapter_id,
      'deliveryVersion', new_row.delivery_version,
      'replacesInvitationId', old_row.id)
  );

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'send', true,
    'invitationId', new_row.id,
    'deliveryVersion', new_row.delivery_version,
    'expiresAt', new_row.expires_at,
    'normalizedEmail', new_row.normalized_email,
    'fullName', new_row.full_name,
    'locale', new_row.locale,
    'source', new_row.source
  );
end;
end;
$function$;

-- Revoking an invitation (re-emitted from 20261004040000), offered as "Stop
-- this invitation from working". While the period runs the revoke is held:
-- the link stops working at once, and its token stays on the row only so
-- undo can reopen the same link while it has not expired. Closing the
-- period clears it.
create or replace function public.revoke_member_invitation(p_invitation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_inviter_chapter();
  invitation_row public.member_invitations%rowtype;
  learning_before jsonb;
  held boolean;
  held_entry uuid;
begin
  if caller is null
     or not (private.member_has_chapter_role(caller_chapter, array['admin'])
             or private.member_invitation_chapter_presided(caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- An invitation of any chapter the caller administers in the selected
  -- organization; every other id gets the same no-op answer as a missing one.
  select * into invitation_row
  from public.member_invitations
  where id = p_invitation_id
    and (private.member_invitation_chapter_administrable(chapter_id)
         or (initial_role is null and kind = 'provision'
             and private.member_invitation_chapter_presided(chapter_id)))
  for update;
  if not found or invitation_row.status not in ('pending', 'delivery_failed', 'expired') then
    return pg_catalog.jsonb_build_object('accepted', true, 'revoked', false);
  end if;

  learning_before := private.learning_invitation_state(invitation_row.id);
  held := private.learning_period_running(private.current_mobile_staff_organization()) is not null;
  update public.member_invitations
  set status = 'revoked',
      token_hash = case when held then token_hash end,
      revoked_at = clock_timestamp(),
      failure_code = null,
      learning_revoke_held_at = case when held then clock_timestamp() end
  where id = invitation_row.id;
  if held then
    held_entry := private.learning_journal_append('invitation_revoke', 'public.member_invitations', invitation_row.id::text, null,
      private.learning_fingerprint(private.learning_invitation_state(invitation_row.id)), null, learning_before);
    if held_entry is null then
      -- The period closed while this waited: an ordinary revoke.
      update public.member_invitations
      set token_hash = null, learning_revoke_held_at = null
      where id = invitation_row.id;
    end if;
  end if;

  perform private.audit_member_invitation(
    invitation_row.id, invitation_row.chapter_id, caller, 'invite_revoked',
    pg_catalog.jsonb_build_object('chapterId', invitation_row.chapter_id,
      'deliveryVersion', invitation_row.delivery_version)
  );
  -- Outside a period the answer is exactly what it always was.
  return pg_catalog.jsonb_build_object('accepted', true, 'revoked', true)
    || case when held_entry is null then '{}'::jsonb else pg_catalog.jsonb_build_object('learningEntryId', held_entry) end;
end;
end;
$function$;

-- Saving, submitting and reviewing an automation are recorded and kept; an
-- automation changed during the period only previews while it runs.
-- Re-emitted from 20260925190800 and 20260911070000.
create or replace function public.save_organization_automation_definition(p_definition_id uuid, p_name text, p_trigger_kind text, p_threshold_days integer, p_cadence text, p_task_priority text, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  saved public.organization_automation_definitions%rowtype;
  audit_id uuid := extensions.gen_random_uuid();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 3 and 80
     or p_name ~ '[[:cntrl:]]' then
    raise exception 'automation name must be 3 to 80 visible characters' using errcode = '22023';
  end if;
  if p_trigger_kind not in ('overdue_task', 'case_deadline', 'unassigned_case')
     or p_cadence not in ('hourly', 'daily', 'weekly')
     or p_task_priority not in ('low', 'medium', 'high')
     or p_threshold_days not between 0 and 90
     or (p_trigger_kind = 'unassigned_case' and p_threshold_days <> 0) then
    raise exception 'invalid automation definition' using errcode = '22023';
  end if;

  if exists(select 1 from public.organization_automation_definitions where id=p_definition_id and organization_id=org and schema_version=2) then
    raise exception 'v2 definition requires v2 editor' using errcode='22023';
  end if;
  if p_definition_id is null then
    if p_expected_version is not null then
      raise exception 'new automation definition cannot have a version' using errcode = '22023';
    end if;
    perform private.automation_definition_creation_admit(org);
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, created_by, updated_by
    ) values (
      org, pg_catalog.btrim(p_name), p_trigger_kind, p_threshold_days,
      p_task_priority, p_cadence, actor, actor
    ) returning * into saved;
  else
    if p_expected_version is null then
      raise exception 'expected automation version required' using errcode = '22023';
    end if;
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_name),
           trigger_kind = p_trigger_kind,
           threshold_days = p_threshold_days,
           task_priority = p_task_priority,
           cadence = p_cadence,
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now()
     where d.id = p_definition_id
       and d.organization_id = org
       and d.version = p_expected_version
       and d.status <> 'archived'
     returning d.* into saved;
    if saved.id is null then
      raise exception 'automation definition changed; reload before saving' using errcode = '40001';
    end if;
  end if;

  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
  perform private.cr108_record_audit(
    org,
    case when p_definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when p_definition_id is null then 'create' else 'update' end,
    'automation_definition',
    saved.id::text,
    actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'cadence', saved.cadence),
    audit_id
  );

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'name', saved.name, 'triggerKind', saved.trigger_kind,
    'thresholdDays', saved.threshold_days, 'taskPriority', saved.task_priority,
    'cadence', saved.cadence, 'status', saved.status, 'version', saved.version
  );
end;
end;
$function$;

create or replace function public.mi1_save_automation_definition_v2(p_definition jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
  definition_id uuid;
  approver boolean;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  approver := private.automation_v3_actor_is_approver(actor, org);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.automation_v3_require_author() is distinct from org then
    raise exception 'organization changed' using errcode = '42501';
  end if;
  perform private.automation_v2_validate(org, p_definition);
  definition_id := (p_definition->>'id')::uuid;
  if not approver and not ((p_definition->'conditions') ? 'chapterId' or (p_definition->'conditions') ? 'sourceId') then
    raise exception 'staff drafts require visible chapter or source scope' using errcode = '42501';
  end if;

  if definition_id is null then
    if p_definition ? 'expectedVersion' then
      raise exception 'new definition cannot have version' using errcode = '22023';
    end if;
    perform private.automation_definition_creation_admit(org);
    insert into public.organization_automation_definitions (
      organization_id, name, trigger_kind, threshold_days, task_priority,
      cadence, action_kind, schema_version, conditions, action_config,
      created_by, updated_by, review_status, review_version
    ) values (
      org, pg_catalog.btrim(p_definition->>'name'), p_definition->>'triggerKind',
      (p_definition->>'thresholdDays')::smallint, p_definition->>'taskPriority',
      p_definition->>'cadence', p_definition->>'actionKind', 2,
      p_definition->'conditions', p_definition->'actionConfig', actor, actor,
      'draft', null
    ) returning * into saved;
  else
    update public.organization_automation_definitions d
       set name = pg_catalog.btrim(p_definition->>'name'),
           trigger_kind = p_definition->>'triggerKind',
           threshold_days = (p_definition->>'thresholdDays')::smallint,
           task_priority = p_definition->>'taskPriority',
           cadence = p_definition->>'cadence',
           action_kind = p_definition->>'actionKind',
           schema_version = 2,
           conditions = p_definition->'conditions',
           action_config = p_definition->'actionConfig',
           version = d.version + 1,
           updated_by = actor,
           updated_at = pg_catalog.now(),
           review_status = 'draft',
           review_version = null,
           submitted_by = null,
           submitted_at = null,
           reviewed_by = null,
           reviewed_at = null,
           review_note = null
     where d.id = definition_id
       and d.organization_id = org
       and d.version = (p_definition->>'expectedVersion')::integer
       and d.status <> 'archived'
       and (approver or (d.created_by = actor and d.review_status in ('draft', 'changes_requested')))
     returning d.* into saved;
    if saved.id is null then
      raise exception 'definition changed or is not editable' using errcode = '40001';
    end if;
  end if;

  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
  perform private.cr108_record_audit(
    org,
    case when definition_id is null then 'automation_definition_created' else 'automation_definition_updated' end,
    case when definition_id is null then 'create' else 'update' end,
    'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version),
    extensions.gen_random_uuid()
  );
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

create or replace function public.mi1_submit_automation_definition(
  p_definition_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  approver boolean;
  saved public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_author();
  approver := private.automation_v3_actor_is_approver(actor, org);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set review_status = 'submitted',
         review_version = d.version,
         submitted_by = actor,
         submitted_at = pg_catalog.now(),
         reviewed_by = null,
         reviewed_at = null,
         review_note = null,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.status <> 'archived'
     and d.review_status in ('draft', 'changes_requested')
     and (approver or d.created_by = actor)
   returning d.* into saved;
  if saved.id is null then raise exception 'definition changed or cannot be submitted' using errcode = '40001'; end if;
  insert into public.organization_automation_definition_reviews (
    organization_id, definition_id, definition_version, action, actor_id, snapshot_digest
  ) values (org, saved.id, saved.version, 'submitted', actor, private.automation_v3_snapshot_digest(saved));
  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
  perform private.cr108_record_audit(org, 'automation_definition_submitted', 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('reviewStatus', saved.review_status, 'version', saved.version), extensions.gen_random_uuid());
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

create or replace function public.mi1_review_automation_definition(
  p_definition_id uuid,
  p_expected_version integer,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
  next_status text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  if p_action not in ('approve', 'request_changes')
      or (p_note is not null and (length(p_note) not between 1 and 500 or p_note ~ '[[:cntrl:]]'))
      or (p_action = 'request_changes' and p_note is null) then
    raise exception 'invalid automation review' using errcode = '22023';
  end if;
  next_status := case p_action when 'approve' then 'approved' else 'changes_requested' end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  update public.organization_automation_definitions d
     set review_status = next_status,
         review_version = d.version,
         reviewed_by = actor,
         reviewed_at = pg_catalog.now(),
         review_note = p_note,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.review_status = 'submitted'
   returning d.* into saved;
  if saved.id is null then raise exception 'submitted definition changed' using errcode = '40001'; end if;
  insert into public.organization_automation_definition_reviews (
    organization_id, definition_id, definition_version, action, actor_id, note, snapshot_digest
  ) values (org, saved.id, saved.version, next_status, actor, p_note, private.automation_v3_snapshot_digest(saved));
  perform private.learning_journal_append('automation_definition_save', 'public.organization_automation_definitions', saved.id::text);
  perform private.cr108_record_audit(org, 'automation_definition_' || next_status, 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('reviewStatus', saved.review_status, 'version', saved.version, 'selfReview', saved.submitted_by = actor), extensions.gen_random_uuid());
  return private.automation_v3_definition_json(saved, actor, org);
end;
$function$;

-- Switching an automation on or off (re-emitted from 20260925630600) is
-- undoable; one switched on during the period only previews.
create or replace function public.set_organization_automation_definition_status(
  p_definition_id uuid,
  p_status text,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  saved public.organization_automation_definitions%rowtype;
  learning_before jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  if p_status not in ('active', 'paused', 'archived') or p_expected_version is null then
    raise exception 'invalid automation status transition' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  select pg_catalog.jsonb_build_object('status', d.status, 'next_run_at', d.next_run_at) into learning_before
  from public.organization_automation_definitions d where d.id = p_definition_id and d.organization_id = org for update;
  update public.organization_automation_definitions d
     set status = p_status,
         next_run_at = case when p_status = 'active' then pg_catalog.now() else null end,
         updated_by = actor,
         updated_at = pg_catalog.now()
   where d.id = p_definition_id
     and d.organization_id = org
     and d.version = p_expected_version
     and d.status <> 'archived'
     and (p_status <> 'active' or (d.review_status = 'approved' and d.review_version = d.version))
   returning d.* into saved;
  if saved.id is null then raise exception 'definition changed, unapproved, or unavailable' using errcode = '40001'; end if;
  -- Scheduled runs execute with updated_by (the activating approver) as their
  -- authority, and appointment sources are visible only to a coordinator,
  -- advisor or admin whose home chapter holds the appointment. An approver who
  -- cannot supervise those appointments would activate a permanent no-op, so
  -- activation is refused with a named reason instead.
  if saved.status = 'active'
     and saved.trigger_kind in ('appointment_upcoming', 'appointment_followup')
     and not private.automation_v3_appointment_supervisor(actor, org, saved.conditions ->> 'chapterId') then
    raise exception 'appointment supervision required' using errcode = '42501';
  end if;
  perform private.learning_journal_append('automation_activate', 'public.organization_automation_definitions', saved.id::text, null,
    private.learning_fingerprint(private.learning_automation_state('public.organization_automation_definitions', saved.id::text)), null,
    learning_before);
  perform private.cr108_record_audit(org, 'automation_definition_status_changed', 'update', 'automation_definition', saved.id::text, actor,
    pg_catalog.jsonb_build_object('status', saved.status, 'reviewStatus', saved.review_status, 'version', saved.version), extensions.gen_random_uuid());
  return pg_catalog.jsonb_build_object('id', saved.id, 'status', saved.status, 'version', saved.version, 'nextRunAt', saved.next_run_at);
end;
$function$;

-- The organization's automation switch and limit (re-emitted from
-- 20260829023000): undoable; turned on during the period, automations only
-- preview. Both take the case-graph lock first now that they journal.
create or replace function public.set_organization_automation_enabled(
  p_enabled boolean,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  expected_confirmation text := case when p_enabled then 'ENABLE AUTOMATION' else 'PAUSE AUTOMATION' end;
  saved public.organization_automation_settings%rowtype;
  learning_before jsonb;
begin
  if p_confirmation is distinct from expected_confirmation then
    raise exception 'automation confirmation did not match' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  learning_before := private.learning_automation_state('public.organization_automation_settings', org::text);
  insert into public.organization_automation_settings (
    organization_id, enabled, updated_by
  ) values (org, p_enabled, actor)
  on conflict (organization_id) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now()
  returning * into saved;
  perform private.learning_journal_append('automation_switch', 'public.organization_automation_settings', org::text, null,
    private.learning_fingerprint(private.learning_automation_state('public.organization_automation_settings', org::text)), null,
    learning_before);

  perform private.cr108_record_audit(
    org, 'automation_kill_switch_changed', 'settings_change',
    'organization', org::text, actor,
    pg_catalog.jsonb_build_object('status', case when saved.enabled then 'enabled' else 'paused' end),
    extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'enabled', saved.enabled, 'maxEffectsPerRun', saved.max_effects_per_run,
    'updatedAt', saved.updated_at
  );
end;
end;
$function$;

create or replace function public.set_organization_automation_safety_cap(
  p_max_effects_per_run integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid := private.cr108_require_operator();
  saved public.organization_automation_settings%rowtype;
  learning_before jsonb;
begin
  if p_max_effects_per_run not between 1 and 50 then
    raise exception 'automation safety cap must be between 1 and 50' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  if private.cr108_require_operator() is distinct from org then
    raise exception 'organization scope changed' using errcode = '42501';
  end if;

  learning_before := private.learning_automation_state('public.organization_automation_settings', org::text);
  insert into public.organization_automation_settings (
    organization_id, max_effects_per_run, updated_by
  ) values (org, p_max_effects_per_run, actor)
  on conflict (organization_id) do update
    set max_effects_per_run = excluded.max_effects_per_run,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now()
  returning * into saved;
  perform private.learning_journal_append('automation_switch', 'public.organization_automation_settings', org::text, null,
    private.learning_fingerprint(private.learning_automation_state('public.organization_automation_settings', org::text)), null,
    learning_before);

  perform private.cr108_record_audit(
    org, 'automation_safety_cap_changed', 'settings_change',
    'organization', org::text, actor,
    pg_catalog.jsonb_build_object('count', saved.max_effects_per_run),
    extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object(
    'enabled', saved.enabled, 'maxEffectsPerRun', saved.max_effects_per_run,
    'updatedAt', saved.updated_at
  );
end;
end;
$function$;

-- The scheduler (re-emitted from 20261003030000): a due automation that is
-- preview-only during its organization's learning period records a practice
-- preview, acts on nothing, and moves on to its next slot.
create or replace function private.run_due_organization_automations(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  candidate_row record;
  definition_row public.organization_automation_definitions%rowtype;
  run_id uuid;
  processed integer;
  succeeded integer;
  failed integer;
  previewed integer := 0;
  candidate_total integer;
  effect_limit integer;
begin
  processed := 0;
  succeeded := 0;
  failed := 0;
  if p_limit not between 1 and 50 then raise exception 'scheduled automation limit out of range' using errcode = '22023'; end if;
  for candidate_row in
    select d.id, d.organization_id
    from public.organization_automation_definitions d
    join public.organization_automation_settings s on s.organization_id = d.organization_id and s.enabled
    join public.organizations o on o.id = d.organization_id and o.status = 'active'
    where d.status = 'active'
      and d.review_status = 'approved'
      and d.review_version = d.version
      and d.next_run_at is not null and d.next_run_at <= pg_catalog.now()
      and (d.recipe_key is null or private.organization_feature_enabled(d.organization_id, 'features.automation.default_recipes'))
    order by d.next_run_at, d.organization_id, d.id
    limit p_limit
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || candidate_row.organization_id::text, 0));
    definition_row := null;
    select d.* into definition_row
    from public.organization_automation_definitions d
    join public.organization_automation_settings s on s.organization_id = d.organization_id and s.enabled
    join public.organizations o on o.id = d.organization_id and o.status = 'active'
    where d.id = candidate_row.id
      and d.organization_id = candidate_row.organization_id
      and d.status = 'active'
      and d.review_status = 'approved'
      and d.review_version = d.version
      and d.next_run_at is not null and d.next_run_at <= pg_catalog.now()
    for update of d skip locked;
    if definition_row.id is null then continue; end if;
    processed := processed + 1;
    if private.learning_automation_preview_only(definition_row.organization_id, definition_row.id) then
      begin
        candidate_total := private.cr108_candidate_count(
          definition_row.organization_id, definition_row.id, definition_row.trigger_kind, definition_row.threshold_days);
        select coalesce(s.max_effects_per_run, 20) into effect_limit
        from (select 1) one
        left join public.organization_automation_settings s on s.organization_id = definition_row.organization_id;
        insert into public.organization_automation_runs (
          organization_id, definition_id, definition_version, mode, status,
          candidates_count, effects_skipped, confirmation_phrase, initiated_by,
          completed_at, definition_snapshot, learning_practice
        ) values (
          definition_row.organization_id, definition_row.id, definition_row.version, 'preview', 'previewed',
          candidate_total, greatest(candidate_total - effect_limit, 0), null, null,
          pg_catalog.now(), private.automation_v2_definition_json(definition_row), true
        );
        previewed := previewed + 1;
      exception when others then
        failed := failed + 1;
      end;
      update public.organization_automation_definitions
         set last_run_at = pg_catalog.now(), next_run_at = private.cr108_next_run(cadence, pg_catalog.now()), updated_at = pg_catalog.now()
       where id = definition_row.id;
      continue;
    end if;
    run_id := extensions.gen_random_uuid();
    insert into public.organization_automation_runs (
      id, organization_id, definition_id, definition_version, mode, status, initiated_by
    ) values (run_id, definition_row.organization_id, definition_row.id, definition_row.version, 'scheduled', 'in_progress', null);
    begin
      perform private.cr108_execute_run(run_id);
      succeeded := succeeded + 1;
    exception when others then
      failed := failed + 1;
      -- A scheduled run has no initiator, so private.automation_v2_execute
      -- takes its authority from the definition's updated_by (the approver who
      -- last activated or edited it) and raises 'operator unavailable' once
      -- that person is no longer an active Admin/President with the required
      -- second factor. Name that cause instead of folding it into
      -- internal_error.
      update public.organization_automation_runs
         set status = 'failed',
             failure_code = case
               when sqlstate = '42501' and sqlerrm = 'operator unavailable' then 'operator_unavailable'
               else 'internal_error'
             end,
             completed_at = pg_catalog.now()
       where id = run_id;
      update public.organization_automation_definitions
         set last_run_at = pg_catalog.now(), next_run_at = private.cr108_next_run(cadence, pg_catalog.now()), updated_at = pg_catalog.now()
       where id = definition_row.id;
    end;
  end loop;
  return pg_catalog.jsonb_build_object('processed', processed, 'succeeded', succeeded, 'failed', failed, 'previewed', previewed);
end;
end;
$function$;

-- "Run for real" (re-emitted from 20260911070000) is refused for a practice
-- preview and for any automation that is preview-only during the period.
create or replace function public.execute_organization_automation_run(
  p_run_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid;
  org uuid;
  run_row public.organization_automation_runs%rowtype;
  definition_row public.organization_automation_definitions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  actor := (select auth.uid());
  org := private.automation_v3_require_approver();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('organization-automation:' || org::text, 0));
  select r.* into run_row from public.organization_automation_runs r
  where r.id = p_run_id and r.organization_id = org and r.mode = 'preview' and r.status = 'previewed'
  for update of r;
  if run_row.id is null then raise exception 'automation preview unavailable' using errcode = '22023'; end if;
  if run_row.learning_practice or run_row.confirmation_phrase is null
     or private.learning_automation_preview_only(org, run_row.definition_id) then
    raise exception 'automations only preview during the learning period' using errcode = '55000';
  end if;
  if run_row.completed_at < pg_catalog.now() - interval '15 minutes' then raise exception 'automation preview expired' using errcode = '22023'; end if;
  if p_confirmation is distinct from run_row.confirmation_phrase then raise exception 'automation run confirmation did not match' using errcode = '22023'; end if;
  if not exists(select 1 from public.organization_automation_settings s where s.organization_id = org and s.enabled) then
    raise exception 'organization automation is paused' using errcode = '22023';
  end if;
  select d.* into definition_row from public.organization_automation_definitions d
  where d.id = run_row.definition_id
    and d.organization_id = org
    and d.version = run_row.definition_version
    and d.status = 'active'
    and d.review_status = 'approved'
    and d.review_version = d.version
  for update of d;
  if definition_row.id is null then raise exception 'automation definition changed or approval is stale; preview again' using errcode = '40001'; end if;
  update public.organization_automation_runs
     set mode = 'manual', status = 'in_progress', initiated_by = actor,
         started_at = pg_catalog.now(), completed_at = null, candidates_count = 0,
         effects_skipped = 0, confirmation_phrase = null
   where id = run_row.id;
  return private.cr108_execute_run(run_row.id);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Every definer reader skips a held removal
-- ---------------------------------------------------------------------------
-- The restrictive policy covers client reads; these definer readers and
-- gates (re-emitted from their latest migrations) skip the held row too, so
-- no reply, count, briefing, export, signal, source or preview shows it.
create or replace function private.can_read_message_source(
  p_actor uuid,
  p_source_kind text,
  p_private_message uuid,
  p_channel_post uuid,
  p_task_message uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_source_kind
    when 'private' then exists (
      select 1
      from public.member_messages m
      where m.id = p_private_message
        and m.learning_removal_held_at is null
        and (
          private.can_actor_send_private_message(p_actor, m.conversation_id, 'member')
          or private.can_actor_send_private_message(p_actor, m.conversation_id, 'steward')
        )
    )
    when 'channel' then exists (
      select 1
      from public.chapter_thread_posts post
      join public.chapter_threads thread on thread.id = post.thread_id
      join public.chapter_spaces space on space.id = thread.space_id
      join public.member_profiles actor on actor.id = p_actor and actor.chapter_id = post.chapter_id
      where post.id = p_channel_post
        and post.deleted_at is null
        and (
          space.visibility = 'chapter'
          or space.created_by = p_actor
          or exists (
            select 1 from public.chapter_space_members membership
            where membership.space_id = space.id and membership.user_id = p_actor
          )
          or (space.visibility = 'staff' and private.actor_has_chapter_staff_role(p_actor, post.chapter_id))
        )
    )
    when 'task' then exists (
      select 1
      from public.chapter_task_messages message
      join public.member_profiles actor on actor.id = p_actor and actor.chapter_id = message.chapter_id
      where message.id = p_task_message
        and p_actor in (message.sender_id, message.recipient_id)
    )
    else false
  end
$$;

create or replace function private.validate_message_reply_parent()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare parent_id uuid; parent_target uuid; target uuid;
begin
  if tg_table_name = 'member_messages' then
    parent_id := new.parent_message_id; target := new.conversation_id;
    if parent_id is null then return new; end if;
    select m.conversation_id into parent_target from public.member_messages m
      where m.id = parent_id and m.redacted_at is null and m.learning_removal_held_at is null;
  else
    parent_id := new.parent_post_id; target := new.thread_id;
    if parent_id is null then return new; end if;
    select p.thread_id into parent_target from public.chapter_thread_posts p
      where p.id = parent_id and p.deleted_at is null;
  end if;
  if parent_id = new.id or parent_target is null or parent_target is distinct from target then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  return new;
end;
$function$;

create or replace function public.get_member_message_replies(p_source_kind text, p_parent_id uuid, p_target_id uuid, p_after_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare caller uuid := (select auth.uid()); parent jsonb; page jsonb; total bigint; target uuid;
begin
  perform private.lock_case_graph_read();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_target_id is null or p_limit is null or p_limit not between 1 and 100
     or (p_after_at is null) is distinct from (p_after_id is null)
     or private.can_read_message_source(caller, p_source_kind,
       case when p_source_kind = 'private' then p_parent_id end,
       case when p_source_kind = 'channel' then p_parent_id end, null) is not true then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select m.conversation_id into target from public.member_messages m where m.id = p_parent_id and m.learning_removal_held_at is null;
  else
    select t.space_id into target from public.chapter_thread_posts p
      join public.chapter_threads t on t.id = p.thread_id where p.id = p_parent_id;
  end if;
  if target is distinct from p_target_id then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  if p_source_kind = 'private' then
    select pg_catalog.jsonb_build_object('id', m.id, 'body', m.body, 'created_at', m.created_at,
      'author_name', m.sender_name, 'parent_id', m.parent_message_id, 'edited_at', m.edited_at,
      'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason)
      into parent from public.member_messages m where m.id = p_parent_id and m.learning_removal_held_at is null;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select m.id, m.created_at, pg_catalog.jsonb_build_object('id', m.id, 'body', m.body,
        'created_at', m.created_at, 'author_name', m.sender_name, 'parent_id', m.parent_message_id,
        'edited_at', m.edited_at, 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) value
      from public.member_messages m where m.parent_message_id = p_parent_id and m.conversation_id = target and m.learning_removal_held_at is null
        and (p_after_at is null or (m.created_at, m.id) > (p_after_at, p_after_id))
      order by m.created_at, m.id limit p_limit + 1
    ) row;
  else
    select pg_catalog.jsonb_build_object('id', p.id, 'body', p.body, 'created_at', p.created_at,
      'author_name', p.author_name, 'parent_id', p.parent_post_id)
      into parent from public.chapter_thread_posts p where p.id = p_parent_id;
    select coalesce(pg_catalog.jsonb_agg(row.value order by row.created_at, row.id), '[]'::jsonb) into page from (
      select p.id, p.created_at, pg_catalog.jsonb_build_object('id', p.id, 'body', p.body,
        'created_at', p.created_at, 'author_name', p.author_name, 'parent_id', p.parent_post_id) value
      from public.chapter_thread_posts p join public.chapter_thread_posts root on root.id = p_parent_id
      where p.parent_post_id = root.id and p.thread_id = root.thread_id and p.deleted_at is null
        and (p_after_at is null or (p.created_at, p.id) > (p_after_at, p_after_id))
      order by p.created_at, p.id limit p_limit + 1
    ) row;
  end if;
  total := (public.get_member_message_reply_counts(p_source_kind, array[p_parent_id])->>p_parent_id::text)::bigint;
  return pg_catalog.jsonb_build_object('parent', parent, 'replies',
    case when pg_catalog.jsonb_array_length(page) > p_limit then page - p_limit else page end,
    'count', total, 'hasMore', pg_catalog.jsonb_array_length(page) > p_limit);
end;

end;
$function$;

create or replace function public.get_member_message_reply_counts(p_source_kind text, p_message_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare caller uuid := (select auth.uid()); message_id uuid; result jsonb := '{}'::jsonb; total bigint;
begin
  perform private.lock_case_graph_read();
  if caller is null or private.mfa_satisfied() is not true
     or p_source_kind is null or p_source_kind not in ('private', 'channel')
     or p_message_ids is null or pg_catalog.cardinality(p_message_ids) > 200 then
    raise exception 'message unavailable' using errcode = '42501';
  end if;
  foreach message_id in array p_message_ids loop
    if private.can_read_message_source(caller, p_source_kind,
        case when p_source_kind = 'private' then message_id end,
        case when p_source_kind = 'channel' then message_id end, null) is not true then
      raise exception 'message unavailable' using errcode = '42501';
    end if;
    if p_source_kind = 'private' then
      select count(*) into total from public.member_messages m
      join public.member_messages parent on parent.id = message_id
      where m.parent_message_id = parent.id and m.conversation_id = parent.conversation_id
        and m.learning_removal_held_at is null and parent.learning_removal_held_at is null;
    else
      select count(*) into total from public.chapter_thread_posts p
      join public.chapter_thread_posts parent on parent.id = message_id
      where p.parent_post_id = parent.id and p.thread_id = parent.thread_id and p.deleted_at is null;
    end if;
    result := result || pg_catalog.jsonb_build_object(message_id::text, total);
  end loop;
  return result;
end;

end;
$function$;

create or replace function public.get_message_briefing_context(
  p_source_kind text,
  p_target_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  messages jsonb;
begin
  if p_source_kind = 'private' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.sender_kind, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select message.id, message.sender_kind, message.body, message.created_at
      from public.member_messages message
      where message.conversation_id = p_target_id and message.learning_removal_held_at is null
      order by message.created_at desc, message.id desc
      limit 40
    ) row;
  elsif p_source_kind = 'channel' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.author_id, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select post.id, post.author_id, post.body, post.created_at
      from public.chapter_thread_posts post
      where post.thread_id = p_target_id
      order by post.created_at desc, post.id desc
      limit 40
    ) row;
  elsif p_source_kind = 'task' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.sender_id, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select message.id, message.sender_id, message.body, message.created_at
      from public.chapter_task_messages message
      where message.task_id = p_target_id
      order by message.created_at desc, message.id desc
      limit 40
    ) row;
  else
    raise exception 'invalid message briefing source' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(messages) = 0 then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('sourceKind', p_source_kind, 'targetId', p_target_id, 'messages', messages,
    'sourceRevision', pg_catalog.encode(extensions.digest(messages::text, 'sha256'), 'hex'));
end;
$function$;

create or replace function public.list_steward_thread_messages(
  p_conversation_id uuid,
  p_before_created timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  sender_kind text,
  sender_name text,
  body text,
  created_at timestamptz,
  reactions jsonb,
  saved boolean,
  reminder jsonb,
  resource jsonb,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  total bigint;
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_conversation_id is null then raise exception 'conversation required' using errcode = '22023'; end if;
  if (p_before_id is null) <> (p_before_created is null) then raise exception 'incomplete cursor' using errcode = '22023'; end if;
  select count(*) into total from public.member_messages message where message.conversation_id = p_conversation_id and message.learning_removal_held_at is null;
  return query
  select message.id, message.sender_kind, message.sender_name, message.body, message.created_at,
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(reaction) order by reaction.created_at)
      from public.member_message_reactions reaction where reaction.private_message_id = message.id), '[]'::jsonb),
    exists (select 1 from public.member_saved_messages saved where saved.owner_id = caller and saved.private_message_id = message.id),
    (select pg_catalog.jsonb_build_object('id', reminder.id, 'remind_at', reminder.remind_at, 'status', reminder.status)
      from public.member_message_reminders reminder where reminder.owner_id = caller and reminder.private_message_id = message.id and reminder.status = 'pending' order by reminder.created_at desc limit 1),
    (select pg_catalog.jsonb_build_object('documentId', link.document_id, 'title', document.title, 'documentType', document.document_type)
      from public.member_message_resources link join public.chapter_documents document on document.id = link.document_id
      where link.message_id = message.id limit 1),
    total
  from public.member_messages message
  where message.conversation_id = p_conversation_id and message.learning_removal_held_at is null
    and (p_before_id is null or (message.created_at, message.id) < (p_before_created, p_before_id))
  order by message.created_at desc, message.id desc
  limit page_limit;
end;
$$;

create or replace function public.list_steward_conversations(
  p_filter text default 'all',
  p_search text default null,
  p_after_updated timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
) returns table (
  id uuid,
  user_id uuid,
  title text,
  updated_at timestamptz,
  member_name text,
  member_initials text,
  last_body text,
  last_sender_kind text,
  last_created_at timestamptz,
  message_count bigint,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  needle text := nullif(trim(coalesce(p_search, '')), '');
  pattern text;
  total bigint;
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if p_filter not in ('all', 'awaiting') then
    raise exception 'unknown thread filter' using errcode = '22023';
  end if;
  if (p_after_id is null) <> (p_after_updated is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  pattern := case when needle is null then null
    else '%' || replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;

  -- "Awaiting reply" is a property of the latest message, so the count has to
  -- evaluate the same latest-message subquery the page does — counting rows
  -- the page would not serve is exactly the KPI drift this wave removes.
  select count(*) into total
  from public.member_conversations c
  where (pattern is null
      or c.title ilike pattern
      or exists (
        select 1 from public.member_profiles pr
        where pr.id = c.user_id and pr.full_name ilike pattern))
    and (p_filter = 'all' or (
      select m.sender_kind from public.member_messages m
      where m.conversation_id = c.id and m.learning_removal_held_at is null
      order by m.created_at desc, m.id desc
      limit 1) = 'member');

  return query
  select c.id, c.user_id, c.title, c.updated_at,
         pr.full_name, pr.initials,
         last.body, last.sender_kind, last.created_at,
         (select count(*) from public.member_messages mc where mc.conversation_id = c.id and mc.learning_removal_held_at is null),
         total
  from public.member_conversations c
  left join public.member_profiles pr on pr.id = c.user_id
  left join lateral (
    select m.body, m.sender_kind, m.created_at
    from public.member_messages m
    where m.conversation_id = c.id and m.learning_removal_held_at is null
    order by m.created_at desc, m.id desc
    limit 1
  ) last on true
  where (pattern is null
      or c.title ilike pattern
      or exists (
        select 1 from public.member_profiles p2
        where p2.id = c.user_id and p2.full_name ilike pattern))
    and (p_filter = 'all' or last.sender_kind = 'member')
    and (p_after_id is null or (c.updated_at, c.id) < (p_after_updated, p_after_id))
  order by c.updated_at desc, c.id desc
  limit page_limit;
end;
$$;

create or replace function public.get_steward_desk_kpis()
returns table (open_requests bigint, awaiting_reply bigint, broadcasts_30d bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  desk_org uuid := private.current_member_organization();
begin
  if (select auth.uid()) is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  return query
  select
    (select count(*) from public.member_steward_requests request where request.status <> 'closed'),
    (select count(*) from public.member_conversations conversation where (
      select message.sender_kind from public.member_messages message
      where message.conversation_id = conversation.id and message.learning_removal_held_at is null
      order by message.created_at desc, message.id desc
      limit 1) = 'member'),
    (select count(*) from public.member_broadcasts broadcast
     where broadcast.retracted_at is null
       and broadcast.published_at > now() - interval '30 days'
       and broadcast.organization_id is not null
       and broadcast.organization_id = desk_org);
end;
$function$;

create or replace function public.get_member_home_takeover()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  org uuid;
  joined_at timestamptz;
  message_item jsonb;
  broadcast_item jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_mobile_staff_organization();
  if org is null or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  if not private.organization_feature_enabled(org, 'features.home.unread_message_takeover') then
    return pg_catalog.jsonb_build_object('enabled', false, 'message', null, 'broadcast', null);
  end if;

  -- Newest unread steward direct message to the caller in a conversation of
  -- the selected organization (member_conversations.organization_id, stamped
  -- at creation). A conversation without an organization never matches.
  -- Bounded preview: the full thread opens in Messages.
  select pg_catalog.jsonb_build_object(
      'id', m.id,
      'conversationId', m.conversation_id,
      'senderName', m.sender_name,
      'body', pg_catalog.left(m.body, 600),
      'truncated', pg_catalog.char_length(m.body) > 600,
      'createdAt', m.created_at
    )
  into message_item
  from public.member_messages m
  join public.member_conversations c on c.id = m.conversation_id and c.user_id = caller
  where m.user_id = caller
    and m.learning_removal_held_at is null
    and c.organization_id = org
    and m.sender_kind = 'steward'
    and m.sender_id is distinct from caller
    and m.read_at is null
    and m.redacted_at is null
  order by m.created_at desc, m.id desc
  limit 1;

  select membership.created_at into joined_at
  from public.organization_memberships membership
  where membership.organization_id = org
    and membership.user_id = caller
    and membership.status = 'active';

  -- Newest unread broadcast the caller can see, published since they joined.
  select pg_catalog.jsonb_build_object(
      'id', b.id,
      'sender', b.sender,
      'title', b.title,
      'body', pg_catalog.left(b.body, 600),
      'truncated', pg_catalog.char_length(b.body) > 600,
      'publishedAt', b.published_at,
      'audience', b.audience_scope
    )
  into broadcast_item
  from public.member_broadcasts b
  where b.id in (select private.visible_member_broadcast_ids())
    and b.organization_id = org
    and b.retracted_at is null
    and b.published_at <= pg_catalog.now()
    and (joined_at is null or b.published_at >= joined_at)
    and not exists (
      select 1 from public.member_broadcast_receipts r
      where r.broadcast_id = b.id and r.user_id = caller
    )
  order by b.published_at desc, b.id desc
  limit 1;

  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'message', message_item,
    'broadcast', broadcast_item
  );
end;

end;
$function$;

create or replace function public.list_member_event_contact_messages(
  p_event_id text,
  p_participant_id uuid default null,
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  src jsonb;
  ev public.member_events%rowtype;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  cursor_json jsonb;
  cursor_at timestamptz;
  cursor_id uuid;
  organizer_side boolean := false;
  items jsonb := '[]'::jsonb;
  fetched integer := 0;
  next_cursor text := null;
  row_data record;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_cursor is not null then
    begin
      cursor_json := p_cursor::jsonb;
      cursor_at := (cursor_json ->> 0)::timestamptz;
      cursor_id := (cursor_json ->> 1)::uuid;
      if cursor_at is null or cursor_id is null then raise exception 'bad cursor'; end if;
    exception when others then
      perform private.cw_fail('invalid_input', '22023', 'invalid cursor', 'cursor');
    end;
  end if;
  -- Source access and tenant membership are re-proven BEFORE any body is read.
  -- A participant keeps their own history after opting out or after a
  -- cancellation only while the event itself is still readable to them.
  if private.current_member_organization() is null then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
  end if;
  src := private.cw_resolve_source(caller, 'event', p_event_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
  end if;
  select e.* into ev from public.member_events e where e.id = src ->> 'id';
  -- The organizer reads only with fresh authorization for an explicitly named,
  -- currently consenting participant; a participant reads their own history.
  if ev.organizer_id = caller then
    if p_participant_id is null
       or not private.cw_event_organizer_ok(caller, ev.id)
       or not private.cw_event_contact_ready(p_participant_id, ev.id) then
      return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
    end if;
    organizer_side := true;
  elsif p_participant_id is not null and p_participant_id <> caller then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null, 'available', false);
  end if;

  -- The words come from the canonical message row, and only rows the existing
  -- private-conversation read predicate still lets THIS caller see. A redaction
  -- tombstone therefore reads as removed here exactly as it does in the inbox.
  for row_data in
    select m.id, m.body, m.redacted_at, m.created_at, m.sender_id, l.sender_role
    from private.member_event_contact_links l
    join public.member_messages m on m.id = l.message_id and m.learning_removal_held_at is null
    where l.event_id = ev.id
      and case when organizer_side
        then l.organizer_id = caller and l.participant_id = p_participant_id
        else l.participant_id = caller end
      and private.can_read_message_source(caller, 'private', m.id, null, null)
      and (cursor_at is null or (m.created_at, m.id) < (cursor_at, cursor_id))
    order by m.created_at desc, m.id desc
    limit lim + 1
  loop
    fetched := fetched + 1;
    if fetched <= lim then
      items := items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', row_data.id,
        'mine', row_data.sender_id = caller,
        'senderRole', row_data.sender_role,
        'body', case when row_data.redacted_at is null then row_data.body else '' end,
        'redacted', row_data.redacted_at is not null,
        'createdAt', row_data.created_at));
    else
      next_cursor := pg_catalog.jsonb_build_array(
        (items -> (lim - 1)) ->> 'createdAt', (items -> (lim - 1)) ->> 'id')::text;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('items', items, 'nextCursor', next_cursor, 'available', true);
end;

end;
$function$;

create or replace function private.cw_event_recipients(p_actor uuid, p_event_id text)
returns table (rid uuid, rlabel text, rvia text, rtarget uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  ev public.member_events%rowtype;
  reply_conversation uuid;
  actor_chapter text;
begin
  select e.* into ev from public.member_events e where e.id = p_event_id;
  if not found or ev.cancelled_at is not null or ev.organizer_id is null then
    return;
  end if;
  if private.cw_event_organizer_ok(p_actor, ev.id) then
    -- Organizer -> consenting participants, restricted to the same member scope
    -- send_steward_reply enforces. A missing conversation is created on Send,
    -- under the explicit event opt-in, never by opening a draft.
    if not coalesce(public.member_has_role(array['steward']), false) then
      return;
    end if;
    return query
      select o.user_id,
             coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Member'),
             'event_organizer'::text, conv.id
      from private.member_event_contact_opt_ins o
      join public.member_profiles pr on pr.id = o.user_id
      cross join lateral (select private.cw_event_conversation(p_actor, o.user_id) as id) conv
      where o.event_id = ev.id
        and o.user_id <> p_actor
        and private.staff_actor_can_see_user(p_actor, o.user_id)
        and private.cw_event_contact_ready(o.user_id, ev.id);
  elsif ev.organizer_id <> p_actor
        and private.cw_event_contact_ready(p_actor, ev.id)
        and private.cw_event_organizer_ok(ev.organizer_id, ev.id) then
    -- Participant -> organizer, after consent only. First choice: a reply inside
    -- the conversation the organizer's own event contact was delivered to, while
    -- the organizer can still see it. Otherwise the attendee may START a
    -- conversation with the organizer through the ordinary member -> steward
    -- writer (start_member_steward_conversation), whose exact predicate is
    -- mirrored here: the caller's own selected chapter roster must list the
    -- organizer, and the caller must belong to an active organization. That
    -- grants no right an attendee did not already have on the steward card.
    select m.conversation_id into reply_conversation
    from private.member_event_contact_links l
    join public.member_messages m on m.id = l.message_id
    where l.event_id = ev.id and l.organizer_id = ev.organizer_id
      and l.participant_id = p_actor and l.sender_role = 'organizer'
      and m.redacted_at is null and m.learning_removal_held_at is null
      and private.can_actor_send_private_message(p_actor, m.conversation_id, 'member')
      and private.can_actor_send_private_message(ev.organizer_id, m.conversation_id, 'steward')
    order by m.created_at desc, m.id desc
    limit 1;
    if reply_conversation is not null then
      return query
        select pr.id, coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Organizer'),
               'event_participant'::text, reply_conversation
        from public.member_profiles pr where pr.id = ev.organizer_id;
      return;
    end if;
    select p.chapter_id into actor_chapter from public.member_profiles p where p.id = p_actor;
    if actor_chapter is not null
       and private.current_member_organization() is not null
       and exists (select 1 from private.member_roster_stewards_for_chapter(actor_chapter) rs
                   where rs.steward_id = ev.organizer_id) then
      return query
        select pr.id, coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Organizer'),
               'event_participant_start'::text, null::uuid
        from public.member_profiles pr where pr.id = ev.organizer_id;
    end if;
  end if;
end;
$function$;

create or replace function private.member_data_export_without_peer_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
  exported jsonb;
  records integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  records := 0;
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object('schemaVersion', 1,
    'generatedAt', now(),
    'account', pg_catalog.jsonb_build_object(
      'userId', caller,
      'email', (select u.email from auth.users u where u.id = caller),
      'profile', coalesce((
        select pg_catalog.jsonb_build_object(
          'firstName', p.first_name, 'fullName', p.full_name,
          'initials', p.initials, 'roleLine', p.role_line,
          'memberSince', p.member_since, 'language', p.language,
          'chapterId', p.chapter_id, 'createdAt', p.created_at,
          'updatedAt', p.updated_at)
        from public.member_profiles p where p.id = caller
      ), '{}'::jsonb),
      'roles', coalesce((select pg_catalog.jsonb_agg(r.role order by r.role)
        from public.member_roles r where r.user_id = caller), '[]'::jsonb)
    ),
    'notifications', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind,
      'readAt', n.read_at, 'createdAt', n.created_at) order by n.created_at)
      from public.member_notifications n where n.user_id = caller), '[]'::jsonb),
    'conversations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'title', c.title, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'stewardUserId', c.steward_user_id,
      'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'senderKind', m.sender_kind, 'senderName', m.sender_name,
        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,
        'bodySha256', m.body_sha256, 'originalLength', m.original_length,
        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)
        from public.member_messages m
        where m.conversation_id = c.id and m.learning_removal_held_at is null
          and (m.user_id = caller or m.sender_id = caller)), '[]'::jsonb)
      ) order by c.created_at) from public.member_conversations c where c.user_id = caller), '[]'::jsonb),
    'cases', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'reference', c.reference, 'title', c.title, 'deadline', c.deadline,
      'caseType', c.case_type, 'articles', c.articles, 'step', c.step,
      'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'updates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'body', u.body, 'occurredOn', u.occurred_on, 'createdAt', u.created_at) order by u.created_at)
        from public.member_case_updates u where u.case_id = c.id and u.user_id = caller and u.learning_undone_at is null), '[]'::jsonb)
      ) order by c.created_at) from public.member_cases c where c.user_id = caller and c.learning_undone_at is null), '[]'::jsonb),
    'forms', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'templateKey', f.template_key, 'templateVersion', f.template_version,
      'status', f.status, 'answers', f.answers, 'step', f.step,
      'reviewNote', f.review_note, 'reviewedAt', f.reviewed_at,
      'submittedAt', f.submitted_at, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
      'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'status', c.status, 'invitedAt', c.invited_at, 'respondedAt', c.responded_at)
        order by c.invited_at) from public.member_form_cosigners c where c.form_id = f.id), '[]'::jsonb)
      ) order by f.created_at) from public.member_forms f where f.user_id = caller), '[]'::jsonb),
    'participation', pg_catalog.jsonb_build_object(
      'ballotReceipts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ballotId', r.ballot_id, 'receiptCode', r.receipt_code,
        'counted', r.counted, 'issuedAt', r.issued_at) order by r.issued_at)
        from public.member_ballot_receipts r where r.user_id = caller), '[]'::jsonb),
      'surveyResponses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'surveyId', s.survey_id, 'optionId', s.option_id, 'submittedAt', s.submitted_at)
        order by s.submitted_at) from public.member_survey_responses s where s.user_id = caller), '[]'::jsonb),
      'rightsProgress', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lessonId', r.lesson_id, 'completedSteps', r.completed_steps, 'updatedAt', r.updated_at)
        order by r.updated_at) from public.member_rights_progress r where r.user_id = caller), '[]'::jsonb),
      'eventRsvps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', r.event_id, 'status', r.status, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_event_rsvps r where r.user_id = caller), '[]'::jsonb),
      'eventCheckins', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', c.event_id, 'checkedInAt', c.checked_in_at) order by c.checked_in_at)
        from public.member_event_checkins c where c.user_id = caller), '[]'::jsonb)
    ),
    'support', pg_catalog.jsonb_build_object(
      'stewardRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'lessonId', r.lesson_id, 'status', r.status,
        'createdAt', r.created_at, 'acknowledgedAt', r.acknowledged_at, 'closedAt', r.closed_at)
        order by r.created_at) from public.member_steward_requests r where r.user_id = caller), '[]'::jsonb),
      'appointments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'chapterId', a.chapter_id, 'appointmentType', a.appointment_type,
        'durationMinutes', a.duration_minutes, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
        'status', a.status, 'routedVia', a.routed_via, 'reasonCategory', a.reason_category,
        'createdAt', a.created_at, 'updatedAt', a.updated_at) order by a.created_at)
        from public.member_appointments a where a.user_id = caller), '[]'::jsonb),
      'intakeReports', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id, 'chapterId', i.chapter_id, 'category', i.category, 'title', i.title,
        'details', i.details, 'status', i.status, 'createdAt', i.created_at, 'updatedAt', i.updated_at)
        order by i.created_at) from public.member_intake_reports i where i.reporter_id = caller), '[]'::jsonb),
      'dataRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'chapterId', g.chapter_id, 'requestType', g.request_type,
        'details', g.details, 'status', g.status, 'response', g.response,
        'createdAt', g.created_at, 'updatedAt', g.updated_at) order by g.created_at)
        from public.chapter_governance_requests g where g.requester_id = caller), '[]'::jsonb)
    ),
    'compass', pg_catalog.jsonb_build_object(
      'threads', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'title', t.title, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
        'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', m.id, 'role', m.role, 'body', m.body, 'sources', m.sources, 'createdAt', m.created_at)
          order by m.created_at) from public.member_guide_messages m
          where m.thread_id = t.id and m.user_id = caller), '[]'::jsonb)) order by t.created_at)
        from public.member_guide_threads t where t.user_id = caller), '[]'::jsonb),
      'requestHistory', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'createdAt', r.created_at, 'role', r.compass_role,
        'limit', r.compass_limit, 'dispatchAuthorizedAt', r.dispatch_authorized_at)
        order by r.created_at) from public.member_ai_requests r where r.user_id = caller), '[]'::jsonb)
    ),
    'activity', pg_catalog.jsonb_build_object(
      'points', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', p.action_key, 'actionKind', p.action_kind,
        'points', p.points, 'occurredAt', p.occurred_at) order by p.occurred_at)
        from public.member_point_events p where p.user_id = caller), '[]'::jsonb),
      'rewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'itemKey', r.item_key, 'status', r.status, 'source', r.source,
        'reason', r.reason, 'note', r.note, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_reward_grants r where r.user_id = caller), '[]'::jsonb),
      'workload', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(w) - 'user_id' order by w.created_at)
        from public.member_workload_logs w where w.user_id = caller), '[]'::jsonb),
      'actions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', a.action_key, 'actionKind', a.action_kind, 'occurredAt', a.occurred_at)
        order by a.occurred_at) from public.member_action_log a where a.user_id = caller), '[]'::jsonb)
    ),
    'chapterParticipation', pg_catalog.jsonb_build_object(
      'spaceMemberships', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', m.space_id, 'role', m.role,
        'joinedAt', m.joined_at) order by m.joined_at)
        from public.chapter_space_members m where m.user_id = caller), '[]'::jsonb),
      'taskAssignments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'taskId', a.task_id, 'chapterId', a.chapter_id, 'position', a.position, 'assignedAt', a.assigned_at)
        order by a.assigned_at) from public.chapter_task_assignments a where a.assignee_id = caller), '[]'::jsonb),
      'taskComments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'taskId', c.task_id, 'chapterId', c.chapter_id,
        'body', c.body, 'createdAt', c.created_at) order by c.created_at)
        from public.chapter_task_comments c where c.author_id = caller), '[]'::jsonb),
      'taskMessages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'taskId', m.task_id, 'chapterId', m.chapter_id,
        'direction', case when m.sender_id = caller then 'sent' else 'received' end,
        'body', m.body, 'createdAt', m.created_at) order by m.created_at)
        from public.chapter_task_messages m where m.sender_id = caller or m.recipient_id = caller), '[]'::jsonb)
    )
  ) into exported;

  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(value)), 0)::integer
    into records
  from pg_catalog.jsonb_each(exported) section
  where pg_catalog.jsonb_typeof(value) = 'array';

  insert into private.member_account_lifecycle_audit (subject_hash, event_type, record_count)
  values (private.member_lifecycle_subject_hash(caller), 'export_generated', records);

  return exported || pg_catalog.jsonb_build_object('topLevelRecordCount', records);
end;
$$;

create or replace function private.issue_intelligence_family_signal(
  p_organization_id uuid,
  p_family text,
  p_as_of timestamptz default pg_catalog.now(),
  p_window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  window_end timestamptz := coalesce(p_as_of, pg_catalog.now());
  window_days integer := coalesce(p_window_days, 30);
  window_start timestamptz;
  prior_start timestamptz;
  retaliation boolean;
  qa_count integer := 0; qa_prior integer := 0;
  message_count integer := 0; message_senders integer := 0; message_prior integer := 0;
  case_count integer := 0; case_prior integer := 0;
  poll_count integer := 0; poll_prior integer := 0;
  report_count integer := 0; report_prior integer := 0;
  checklist_count integer := 0; checklist_prior integer := 0;
  reviewed_theme boolean := false;
  people_by_evidence jsonb := '{}'::jsonb;
  families text[] := array[]::text[];
  direct boolean := false;
  contributors integer := 0;
  confidence text := null;
  active boolean := false;
  current_total integer;
  prior_total integer;
  trend text;
begin
  if p_organization_id is null or p_family not in ('contract_rights_confusion', 'retaliation_protected_activity_pressure') then
    raise exception 'invalid issue intelligence family' using errcode = '22023';
  end if;
  if window_days not between 1 and 90 then
    raise exception 'invalid issue intelligence window' using errcode = '22023';
  end if;
  -- The old engine looked back 30 days (load-evidence.ts:7); the old weekly
  -- digest used the completed week. Trend compares the same-length window
  -- immediately before.
  window_start := window_end - pg_catalog.make_interval(days => window_days);
  prior_start := window_end - pg_catalog.make_interval(days => window_days * 2);
  retaliation := p_family = 'retaliation_protected_activity_pressure';

  -- Every evidence row is (evidence, person, occurred_at) inside this tenant,
  -- over the current and the prior window (for the trend).
  with evidence(evidence, person, occurred_at) as (
    -- Q&A: the organization's own forum questions (titles and bodies are
    -- already readable by every member of the organization).
    select 'qa', q.author_user_id, q.created_at
    from public.member_qa_questions q
    where q.organization_id = p_organization_id
      and q.deleted_at is null
      and q.created_at >= prior_start and q.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(q.title || ' ' || q.body)
        else private.issue_signal_contract_rights_text(q.title || ' ' || q.body) end
    union all
    -- Messages: inbound member messages and their conversation title, stamped
    -- with the conversation's organization when it was created. Redacted
    -- rows have no text and are skipped.
    select 'messages', m.user_id, m.created_at
    from public.member_messages m
    join public.member_conversations c on c.id = m.conversation_id
      and c.organization_id = p_organization_id and m.learning_removal_held_at is null
    join public.organization_memberships om
      on om.organization_id = p_organization_id and om.user_id = c.user_id and om.status = 'active'
    where m.sender_kind = 'member'
      and m.redacted_at is null
      and m.created_at >= prior_start and m.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(c.title || ' ' || m.body)
        else private.issue_signal_contract_rights_text(c.title || ' ' || m.body) end
    union all
    -- Cases: category and cited contract articles only; never titles or
    -- narratives; restricted cases never count.
    select 'cases', mc.user_id, mc.created_at
    from public.member_cases mc
    where mc.organization_id = p_organization_id
      and not mc.is_restricted and mc.learning_undone_at is null
      and mc.created_at >= prior_start and mc.created_at <= window_end
      and case when retaliation
        then private.issue_signal_retaliation_text(mc.case_type)
        else private.issue_signal_contract_rights_text(mc.case_type)
          or pg_catalog.btrim(coalesce(mc.articles, '')) <> '' end
    union all
    -- Polls (contract rights): member weekly-question submissions ...
    select 'polls', w.user_id, w.created_at
    from public.member_weekly_questions w
    join public.chapters ch on ch.id = w.chapter_id and ch.organization_id = p_organization_id
    where not retaliation
      and w.created_at >= prior_start and w.created_at <= window_end
      and private.issue_signal_contract_rights_text(w.body)
    union all
    -- ... and contextual pulse responses to a staff-written contract prompt.
    select 'polls', e.user_id, e.responded_at
    from public.organization_pulse_events e
    join public.organization_pulse_prompts pr on pr.id = e.prompt_id and pr.organization_id = p_organization_id
    where not retaliation
      and e.organization_id = p_organization_id
      and e.state = 'responded'
      and e.responded_at >= prior_start and e.responded_at <= window_end
      and private.issue_signal_contract_rights_text(pr.question)
    union all
    -- Retaliation reports (old retaliation_flags): submitted, not withdrawn.
    select 'retaliation_reports', r.reporter_user_id, r.created_at
    from public.casework_retaliation_reports r
    where retaliation
      and r.organization_id = p_organization_id
      and r.status <> 'withdrawn'
      and r.created_at >= prior_start and r.created_at <= window_end
    union all
    -- Know-your-rights emergency checklists (old kyr family) for discipline
    -- scenarios, the current equivalent of the old harassment checklist.
    select 'kyr', k.member_user_id, k.updated_at
    from public.member_emergency_checklists k
    where retaliation
      and k.organization_id = p_organization_id
      and k.scenario in ('disciplinary_meeting', 'pre_discipline_response')
      and k.updated_at >= prior_start and k.updated_at <= window_end
  )
  select
    pg_catalog.count(*) filter (where e.evidence = 'qa' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'qa' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'messages' and e.occurred_at >= window_start),
    pg_catalog.count(distinct e.person) filter (where e.evidence = 'messages' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'messages' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'cases' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'cases' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'polls' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'polls' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'retaliation_reports' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'retaliation_reports' and e.occurred_at < window_start),
    pg_catalog.count(*) filter (where e.evidence = 'kyr' and e.occurred_at >= window_start),
    pg_catalog.count(*) filter (where e.evidence = 'kyr' and e.occurred_at < window_start),
    -- People per evidence family in the current window, used only to apply
    -- the privacy floor below; never returned to any caller.
    pg_catalog.jsonb_build_object(
      'qa', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'qa' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'messages', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'messages' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'cases', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'cases' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'polls', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'polls' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'retaliation_reports', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'retaliation_reports' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb),
      'kyr', coalesce(pg_catalog.jsonb_agg(distinct e.person) filter (where e.evidence = 'kyr' and e.occurred_at >= window_start and e.person is not null), '[]'::jsonb)
    )
  into qa_count, qa_prior, message_count, message_senders, message_prior, case_count, case_prior,
    poll_count, poll_prior, report_count, report_prior, checklist_count, checklist_prior, people_by_evidence
  from evidence e;

  -- Reviewed issue themes: the organization's own frozen, privacy-banded
  -- connection aggregates from roughly the last two quarters. They carry no
  -- people and never count toward the privacy floor.
  select exists (
    select 1
    from private.chapter_connection_issue_aggregates a
    join private.chapter_connection_aggregate_runs run
      on run.chapter_id = a.chapter_id and run.period_key = a.period_key
    where run.organization_id = p_organization_id
      and run.period_ends_at >= window_end - interval '200 days'
      and run.period_ends_at <= window_end
      and a.band in ('many', 'most')
      and a.topic_key = any (case when retaliation
        then array['discrimination']
        else array['contract-enforcement', 'discipline'] end)
  ) into reviewed_theme;

  if retaliation then
    if report_count >= 1 then families := families || 'retaliation_reports'::text; direct := true; end if;
    if checklist_count >= 1 then families := families || 'kyr'::text; direct := true; end if;
    if message_count >= 2 and message_senders >= 1 then families := families || 'messages'::text; end if;
    if case_count >= 1 then families := families || 'cases'::text; end if;
    if qa_count >= 1 then families := families || 'qa'::text; end if;
    if reviewed_theme then families := families || 'reviewed_themes'::text; end if;
    active := direct and pg_catalog.cardinality(families) >= 2;
  else
    if qa_count >= 2 then families := families || 'qa'::text; end if;
    if message_count >= 3 and message_senders >= 2 then families := families || 'messages'::text; end if;
    if case_count >= 1 then families := families || 'cases'::text; end if;
    if poll_count >= 1 then families := families || 'polls'::text; end if;
    if reviewed_theme then families := families || 'reviewed_themes'::text; end if;
    active := pg_catalog.cardinality(families) >= 2;
  end if;

  if active then
    confidence := case
      when pg_catalog.cardinality(families) >= 4 then 'strong'
      when pg_catalog.cardinality(families) >= 3 then 'active'
      else 'emerging' end;
  end if;

  -- Distinct people behind the evidence families that made this one active.
  select pg_catalog.count(distinct person.value)
  into contributors
  from pg_catalog.jsonb_each(people_by_evidence) by_family
  cross join lateral pg_catalog.jsonb_array_elements_text(by_family.value) person
  where by_family.key = any (families);

  current_total := qa_count + message_count + case_count + poll_count + report_count + checklist_count;
  prior_total := qa_prior + message_prior + case_prior + poll_prior + report_prior + checklist_prior;
  trend := case
    when current_total >= prior_total + 2 and current_total * 4 >= prior_total * 5 then 'rising'
    when prior_total >= current_total + 2 and current_total * 4 <= prior_total * 3 then 'declining'
    else 'stable' end;

  return pg_catalog.jsonb_build_object(
    'family', p_family,
    'threadKey', case when retaliation then 'retaliation-protected-activity-pressure' else 'contract-rights-confusion' end,
    'active', active,
    'confidence', confidence,
    'evidenceFamilies', pg_catalog.to_jsonb(families),
    'trend', trend,
    'contributors', contributors,
    'windowStart', window_start,
    'windowEnd', window_end,
    'windowDays', window_days,
    'evidence', pg_catalog.jsonb_build_object(
      'qa', qa_count, 'messages', message_count, 'messageSenders', message_senders,
      'cases', case_count, 'polls', poll_count, 'retaliationReports', report_count,
      'kyr', checklist_count, 'reviewedThemes', reviewed_theme
    )
  );
end;
$function$;

create or replace function public.propose_compass_workspace_action(
  p_source_kind text,
  p_source_id text,
  p_title text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid;
  actor uuid;
  created public.compass_workspace_actions%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.engagement_selected_organization();
  actor := (select auth.uid());
  perform private.engagement_require_staff(org);
  if p_source_kind not in ('message', 'broadcast', 'notification', 'survey', 'case') then
    raise exception 'invalid action source' using errcode = '22023';
  end if;
  if p_source_kind = 'message' then
    perform private.lock_message_lifecycle();
    if not exists (select 1 from public.member_messages m
      where m.id::text = p_source_id and m.redacted_at is null and m.learning_removal_held_at is null
        and private.engagement_can_read_message_target('private', m.conversation_id)) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  end if;
  insert into public.compass_workspace_actions (
    organization_id, actor_user_id, action_kind, source_kind, source_id, title
  ) values (
    org, actor, 'create_task', p_source_kind,
    pg_catalog.btrim(coalesce(p_source_id, '')),
    case when p_source_kind = 'message' then 'Follow up on member message'
      else pg_catalog.btrim(coalesce(p_title, '')) end
  ) returning * into created;
  return pg_catalog.jsonb_build_object(
    'id', created.id, 'actionKind', created.action_kind,
    'sourceKind', created.source_kind, 'sourceId', created.source_id,
    'title', created.title, 'state', created.state
  );
end;
$function$;

create or replace function public.get_case_queue_next_actions(p_selected_hat text, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.case_signals_staff_organization(p_selected_hat);
  hat text := pg_catalog.btrim(p_selected_hat);
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  lookahead integer;
  critical_days integer;
  high_days integer;
  stale_days integer;
  evidence_days integer;
  weak_below integer;
  bounded integer := greatest(1, least(coalesce(p_limit, 25), 100));
  items jsonb;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.casework.next_action_queue') then
    return pg_catalog.jsonb_build_object('enabled', false, 'items', '[]'::jsonb,
      'summary', pg_catalog.jsonb_build_object('total', 0, 'urgent', 0, 'missingOwner', 0));
  end if;
  lookahead := private.organization_limit(org, 'limits.casework.deadline_lookahead_days');
  critical_days := private.organization_limit(org, 'limits.casework.deadline_risk_critical_days');
  high_days := private.organization_limit(org, 'limits.casework.deadline_risk_high_days');
  stale_days := private.organization_limit(org, 'limits.casework.stale_contact_days');
  evidence_days := private.organization_limit(org, 'limits.casework.evidence_deadline_days');
  weak_below := private.organization_limit(org, 'limits.casework.weak_strength_threshold');

  with cases as (
    select c.id, c.user_id, c.reference, c.step, c.steward_user_id,
      private.case_signals_next_due(c.id, c.deadline) as next_due
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    where c.organization_id = org
      and c.status = 'active'
      and c.user_id <> caller
      and (hat <> 'steward' or c.steward_user_id = caller)
      and private.casework_staff_can_read(c.id)
  ),
  enriched as (
    select cs.*,
      case when cs.next_due is null then null else cs.next_due - today end as due_days,
      exists (
        select 1 from public.member_case_files f
        where f.case_id = cs.id and f.confirmed_at is not null and f.removal_requested_at is null
      ) as has_evidence,
      (
        select a.score from public.casework_strength_analyses a
        where a.case_id = cs.id
        order by a.created_at desc, a.id desc
        limit 1
      ) as strength
    from cases cs
  ),
  members as (
    select e.user_id,
      pg_catalog.count(*) as open_cases,
      (pg_catalog.array_agg(e.id order by e.due_days nulls last, e.reference))[1] as top_case,
      (pg_catalog.array_agg(e.reference order by e.due_days nulls last, e.reference))[1] as top_reference,
      greatest(
        (select pg_catalog.max(n.created_at) from public.member_contact_notes n
          join public.chapters ch on ch.id = n.chapter_id and ch.organization_id = org
          where n.member_user_id = e.user_id),
        (select pg_catalog.max(m.created_at) from public.member_messages m
          join public.member_conversations conversation
            on conversation.id = m.conversation_id and conversation.organization_id = org
          where m.user_id = e.user_id and m.sender_kind = 'steward' and m.learning_removal_held_at is null)
      ) as last_contact
    from enriched e
    group by e.user_id
  ),
  raw_items as (
    -- Deadline risk (workflow-queues.ts:322-361): due within the lookahead,
    -- overdue always included.
    select pg_catalog.jsonb_build_object(
        'id', 'deadline_risk:' || e.id, 'kind', 'deadline_risk',
        'severity', case when e.due_days <= critical_days then 'critical' when e.due_days <= high_days then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days) as item,
      case when e.due_days <= 0 then 500 + pg_catalog.abs(e.due_days) else 360 - e.due_days end::numeric as score
    from enriched e
    where e.due_days is not null and e.due_days <= lookahead
    union all
    -- Owner gap (unassigned case), for queue owners only.
    select pg_catalog.jsonb_build_object(
        'id', 'missing_owner:' || e.id, 'kind', 'missing_owner', 'severity', 'high',
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days),
      330::numeric
    from enriched e
    where hat <> 'steward' and e.steward_user_id is null
    union all
    -- Stale member contact (workflow-queues.ts:468-541), one item per member.
    select pg_catalog.jsonb_build_object(
        'id', 'stale_contact:' || mb.user_id, 'kind', 'stale_contact', 'severity', 'medium',
        'caseId', mb.top_case, 'reference', mb.top_reference, 'memberId', mb.user_id,
        'memberName', private.member_support_member_label(mb.user_id),
        'openCases', mb.open_cases,
        'lastContactDays', case when mb.last_contact is null then null
          else today - (mb.last_contact at time zone 'America/New_York')::date end),
      210 + coalesce(today - (mb.last_contact at time zone 'America/New_York')::date, stale_days + 1)::numeric / 100
    from members mb
    where mb.last_contact is null
       or today - (mb.last_contact at time zone 'America/New_York')::date > stale_days
    union all
    -- Missing evidence before a deadline (workflow-queues.ts:543-590).
    select pg_catalog.jsonb_build_object(
        'id', 'missing_evidence:' || e.id, 'kind', 'missing_evidence',
        'severity', case when e.due_days <= 0 then 'critical' else 'high' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days),
      case when e.due_days <= 0 then 440 + least(pg_catalog.abs(e.due_days), 9) else 348 - e.due_days end::numeric
    from enriched e
    where e.due_days is not null and e.due_days <= evidence_days and not e.has_evidence
    union all
    -- Weak case strength (workflow-queues.ts:603-645): scored cases only.
    select pg_catalog.jsonb_build_object(
        'id', 'weak_strength:' || e.id, 'kind', 'weak_strength',
        'severity', case when e.strength < weak_below / 2.0 then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days, 'strength', e.strength),
      200 + greatest(0, weak_below - e.strength)::numeric / 100
    from enriched e
    where e.strength is not null and e.strength < weak_below
  ),
  ranked as (
    select r.item, r.score,
      case r.item ->> 'severity' when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end as severity_rank
    from raw_items r
  )
  select pg_catalog.jsonb_build_object(
    'enabled', true,
    'items', coalesce((
      select pg_catalog.jsonb_agg(top.item order by top.score desc, top.severity_rank desc, top.item ->> 'dueDate' nulls last, top.item ->> 'id')
      from (select * from ranked order by score desc, severity_rank desc, item ->> 'dueDate' nulls last, item ->> 'id' limit bounded) top
    ), '[]'::jsonb),
    'summary', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from ranked),
      'urgent', (select pg_catalog.count(*) from ranked where severity_rank >= 3),
      'missingOwner', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_owner'),
      'staleContact', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'stale_contact'),
      'missingEvidence', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_evidence'),
      'weakStrength', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'weak_strength')
    ),
    'settings', pg_catalog.jsonb_build_object('staleContactDays', stale_days, 'evidenceDays', evidence_days, 'weakStrengthBelow', weak_below)
  ) into items;
  return items;
end;
$function$
;

create or replace function public.create_chapter_task_from_source(
  p_source_kind text,
  p_source_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  learning_parent uuid;
  caller uuid := (select auth.uid());
  caller_chapter text;
  caller_org uuid;
  clean_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_source_kind, '')));
  clean_source_id text := pg_catalog.btrim(coalesce(p_source_id, ''));
  source_uuid uuid;
  source_found boolean := false;
  source_is_current boolean := true;
  task_title text;
  attachment_label text;
  record_url text;
  task_workstream text;
  message_owner uuid;
  message_conversation uuid;
  case_row public.member_cases%rowtype;
  task_row public.chapter_tasks%rowtype;
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if clean_kind not in ('message', 'broadcast', 'notification', 'survey', 'case')
     or clean_source_id = ''
     or pg_catalog.char_length(clean_source_id) > 200 then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  if clean_kind in ('message', 'notification', 'case') then
    begin
      source_uuid := clean_source_id::uuid;
      clean_source_id := source_uuid::text;
    exception when invalid_text_representation then
      raise exception 'source unavailable' using errcode = '22023';
    end;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));

  select p.chapter_id, c.organization_id into caller_chapter, caller_org
  from public.member_profiles p
  left join public.chapters c on c.id = p.chapter_id
  where p.id = caller;
  if caller_chapter is null then
    raise exception 'source unavailable' using errcode = '22023';
  end if;
  if not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  case clean_kind
    when 'message' then
      select m.user_id, m.conversation_id into message_owner, message_conversation
      from public.member_messages m
      where m.id = source_uuid
        and m.learning_removal_held_at is null
        and m.sender_kind = 'member'
        and (
          m.user_id = caller
          or public.staff_can_see_user(m.user_id, 'steward')
        );
      source_found := found;
      task_title := 'Follow up on member message';
      attachment_label := 'Authorized member message';
      record_url := case when message_owner = caller
        then '/m/messages?conversation=' || message_conversation::text
        else '/m/steward?thread=' || message_conversation::text
      end;
    when 'broadcast' then
      select b.retracted_at is null into source_is_current
      from public.member_broadcasts b
      where b.id = clean_source_id
        and b.organization_id is not null
        and caller_org is not null
        and b.organization_id = caller_org
        and private.can_read_member_broadcast(b.id);
      source_found := found;
      task_title := 'Review chapter broadcast';
      attachment_label := 'Authorized chapter broadcast';
      record_url := '/m/messages?broadcast=' || clean_source_id;
    when 'notification' then
      select true into source_found
      from public.member_notifications n
      where n.id = source_uuid
        and n.user_id = caller;
      source_found := found;
      task_title := 'Review notification';
      attachment_label := 'Authorized notification';
      record_url := '/m/messages?notification=' || clean_source_id;
    when 'survey' then
      select s.active into source_is_current
      from public.member_surveys s
      where s.id = clean_source_id
        and s.chapter_id is not null
        and s.chapter_id = caller_chapter;
      source_found := found;
      task_title := 'Follow up on survey';
      attachment_label := 'Authorized survey';
      record_url := '/m/voting?survey=' || clean_source_id;
    when 'case' then
      select c.* into case_row
      from public.member_cases c
      where c.id = source_uuid
        and (
          c.user_id = caller
          or (
            c.steward_user_id = caller
            and private.member_has_chapter_role(caller_chapter, array['steward'])
          )
          or public.staff_can_see_user(c.user_id, 'coordinator')
        );
      source_found := found;
      source_is_current := case_row.status = 'active';
      task_title := 'Follow up on grievance';
      attachment_label := 'Authorized grievance';
      record_url := case
        when case_row.user_id = caller then '/m/cases?case=' || clean_source_id
        when case_row.steward_user_id = caller
          and private.member_has_chapter_role(caller_chapter, array['steward'])
          then '/m/steward?case=' || clean_source_id
        else '/m/coordinator?case=' || clean_source_id
      end;
  end case;

  if not source_found then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_chapter || pg_catalog.chr(31) || clean_kind || pg_catalog.chr(31) || clean_source_id,
      0
    )
  );

  select a.* into attachment_row
  from public.chapter_task_attachments a
  where a.chapter_id = caller_chapter
    and a.source_kind = clean_kind
    and a.source_id = clean_source_id;
  if found then
    select t.* into task_row
    from public.chapter_tasks t
    where t.id = attachment_row.task_id;
    return pg_catalog.jsonb_build_object(
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', pg_catalog.to_jsonb(attachment_row),
      'created', false
    );
  end if;

  if not source_is_current then
    raise exception 'source unavailable' using errcode = '22023';
  end if;

  select w.name into task_workstream
  from public.chapter_workstreams w
  where w.chapter_id = caller_chapter
  order by
    (pg_catalog.lower(pg_catalog.btrim(w.name)) = 'general') desc,
    pg_catalog.lower(pg_catalog.btrim(w.name)),
    w.name,
    w.id
  limit 1
  for key share of w;
  if task_workstream is null then
    raise exception 'chapter has no available task workstream' using errcode = '22023';
  end if;

  insert into public.chapter_tasks (
    title, description, status, priority, task_type, workstream,
    assignee_id, start_date, due_date, progress, blocked, milestone, order_index
  ) values (
    task_title, '', 'to_do', 'medium', 'general', task_workstream,
    null, null, null, 0, false, false, 0
  ) returning * into task_row;

  insert into public.chapter_task_attachments (
    task_id, chapter_id, label, record_url, created_by, source_kind, source_id
  ) values (
    task_row.id, caller_chapter, attachment_label, record_url, caller,
    clean_kind, clean_source_id
  ) returning * into attachment_row;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, caller_chapter, caller, 'attachment_added', attachment_row.id::text
  );

  learning_parent := private.learning_task_journal('task_create', task_row.id, null);
  perform private.learning_journal_append('task_link_add', 'public.chapter_task_attachments', attachment_row.id::text, learning_parent,
    private.learning_fingerprint(private.learning_task_edge_state('public.chapter_task_attachments', attachment_row.id::text)), null, '{}'::jsonb);
  return pg_catalog.jsonb_build_object(
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'created', true
  );
end;
end
$function$;

-- Replying: a repeated reply within a minute returns the earlier one only
-- while that one is visible; a held one is not returned (re-emitted from
-- 20261006030000).
create or replace function public.reply_to_member_message(p_source_kind text, p_message_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
  declare caller uuid := (select auth.uid()); clean text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
    source public.member_messages%rowtype; post public.chapter_thread_posts%rowtype; result jsonb; new_id uuid; kind text;
  begin
    perform public.get_member_message_actions(p_source_kind, p_message_id);
    if pg_catalog.char_length(clean) not between 1 and 4000 then
      raise exception 'invalid message' using errcode = '22023';
    end if;
    if p_source_kind = 'private' then
      select * into source from public.member_messages where id = p_message_id;
      if private.can_actor_send_private_message(caller, source.conversation_id, 'member') is true then
        kind := 'member';
        if (select c.steward_user_id from public.member_conversations c where c.id = source.conversation_id) is null
           and not private.chapter_steward_reader_exists(caller) then
          raise exception 'no steward assigned' using errcode = '22023', detail = 'no_steward_assigned';
        end if;
      elsif private.can_actor_send_private_message(caller, source.conversation_id, 'steward') is true
          and public.member_has_role(array['steward']) is true then kind := 'steward';
      else raise exception 'message unavailable' using errcode = '42501'; end if;
      result := (select pg_catalog.to_jsonb(m) from public.member_messages m
        where m.parent_message_id = p_message_id and m.sender_id = caller and m.body = clean
          and m.redacted_at is null and m.learning_removal_held_at is null and m.created_at > pg_catalog.clock_timestamp() - interval '60 seconds'
        order by m.created_at desc, m.id desc limit 1);
      if result is not null then return result; end if;
      perform private.message_action_admit();
      insert into public.member_messages(conversation_id, user_id, sender_kind, sender_name, body, parent_message_id, created_at)
        values(source.conversation_id, source.user_id, kind,
          case when kind = 'steward' then 'Chapter steward'
            else coalesce((select nullif(full_name, '') from public.member_profiles where id = caller), 'Member') end,
          clean, p_message_id, pg_catalog.clock_timestamp())
        returning id into new_id;
      update public.member_conversations set updated_at = pg_catalog.now() where id = source.conversation_id;
      result := (select pg_catalog.to_jsonb(m) from public.member_messages m where m.id = new_id);
    else
      select * into post from public.chapter_thread_posts where id = p_message_id;
      if not exists (select 1 from public.chapter_threads t join public.chapter_spaces s on s.id = t.space_id
        where t.id = post.thread_id and t.status = 'open' and private.can_read_chapter_space(s) is true
          and t.chapter_id = private.current_member_chapter()) then
        raise exception 'message unavailable' using errcode = '42501';
      end if;
      result := (select pg_catalog.to_jsonb(p) from public.chapter_thread_posts p
        where p.parent_post_id = p_message_id and p.author_id = caller and p.body = clean
          and p.deleted_at is null and p.created_at > pg_catalog.clock_timestamp() - interval '60 seconds'
        order by p.created_at desc, p.id desc limit 1);
      if result is not null then return result; end if;
      perform private.message_action_admit();
      insert into public.chapter_thread_posts(thread_id, body, parent_post_id)
        values(post.thread_id, clean, p_message_id) returning id into new_id;
      result := (select pg_catalog.to_jsonb(p) from public.chapter_thread_posts p where p.id = new_id);
    end if;
    perform private.message_action_audit(p_source_kind, new_id, 'replied');
    return result;
  end;
end;
end;
$function$;

create or replace function public.create_member_contact_note(p_conversation_id uuid, p_note text, p_source_message_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  conversation public.member_conversations%rowtype;
  member_chapter text;
  new_id uuid;
begin
  if caller is null or not public.member_has_role(array['steward'])
     or not private.can_actor_send_private_message(caller, p_conversation_id, 'steward') then
    raise exception 'conversation unavailable' using errcode = '22023';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_note, ''))) not between 1 and 2000 then
    raise exception 'note must be between 1 and 2000 characters' using errcode = '22023';
  end if;
  select c.* into conversation from public.member_conversations c where c.id = p_conversation_id;
  select p.chapter_id into member_chapter from (select access_row.* from public.member_profiles access_row where (private.chapter_member_readable(access_row.id))) p where p.id = conversation.user_id;
  if member_chapter is null then raise exception 'conversation unavailable' using errcode = '22023'; end if;
  if p_source_message_id is not null and not exists (
    select 1 from public.member_messages m
    where m.id = p_source_message_id and m.conversation_id = conversation.id and m.learning_removal_held_at is null
  ) then raise exception 'message unavailable' using errcode = '22023'; end if;
  insert into public.member_contact_notes(
    conversation_id, member_user_id, chapter_id, author_id, source_message_id, note)
  values (
    conversation.id, conversation.user_id, member_chapter, caller,
    p_source_message_id, pg_catalog.btrim(p_note))
  returning id into new_id;
  return pg_catalog.jsonb_build_object('id', new_id, 'created', true);
end;
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 8. Account lifecycle trigger review
-- ---------------------------------------------------------------------------
-- The sent-journal trigger and the functions it and the changed message
-- guards reach are reviewed: none of them fires on a referential action
-- with an effect (a cascaded delete returns before journalling).
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.object_name = 'z90_learning_journal_sent')
   or (s.kind = 'trigger' and s.schema_name = 'public' and s.table_name = 'member_messages' and s.object_name = 'invalidate_message_briefings')
   or (s.kind = 'trigger' and s.schema_name = 'public' and s.table_name = 'civic_member_messages'
       and s.object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
     'learning_journal_sent()',
     'learning_journal_append(p_action_kind text, p_target_table text, p_target_id text, p_parent_entry_id uuid, p_after_fingerprint text, p_before_ref bigint, p_before_image jsonb)',
     'learning_period_running(p_organization_id uuid)',
     'redact_member_message_row(p_message_id uuid, p_reason text, p_actor uuid)',
     'validate_message_reply_parent()',
     'invalidate_message_briefings()'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_learning_messages_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the learning period message slice';
  end if;
end;
$assert_learning_messages_trigger_review$;

notify pgrst, 'reload schema';
commit;
