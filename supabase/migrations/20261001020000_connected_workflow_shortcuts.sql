-- REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928 (server slice).
--
-- Source-aware shortcuts over records the caller can already read:
--   * context / recipients / linked task / reminders / send for messages,
--     channel posts, task messages, tasks and events;
--   * an explicit event organizer (member_events.organizer_id) and a per-attendee
--     contact opt-in (owner decision, 2026-09-28). Nothing else may contact
--     attendees.
--
-- Boundaries kept:
--   * every RPC is SECURITY DEFINER with an empty search_path, requires an
--     MFA-assured session and re-derives access from the exact record on every
--     call. A client-supplied chapter/organization is only a stale-scope
--     assertion; it never grants anything and never selects a tenant;
--   * reads of a missing, removed or unauthorized source give one answer;
--   * task creation stays staff-only (current-chapter grant), idempotent per
--     (chapter, source kind, source), with generic titles that copy no source
--     text, and only for a source of the caller's own current chapter;
--   * a reminder never carries source content; delivery re-authorizes the source;
--   * event contact needs BOTH a currently authorized steward-organizer AND an
--     opted-in, currently attending participant, and is refused for a cancelled
--     event. The words of every event contact live ONLY in public.member_messages,
--     written by the existing private-conversation writers (send_steward_reply,
--     send_member_message) into the participant’s canonical conversation, so
--     redaction tombstones, retention, legal holds, account deletion and export are
--     the message body lifecycle unchanged. private.member_event_contact_links is a
--     metadata-only binding (message id, event, organizer, participant); it holds
--     no text, has no client grant, forced RLS, and is read only by these RPCs after
--     the event and the private-message read predicates are re-proven. Known limits:
--     the organizer must be a steward, and stewards who can already see that member's conversations see
--     these messages there (the existing private boundary, not a wider one);
--   * no existing messaging boundary (private conversations, task threads, peer
--     contact) is widened: those writers are called unchanged.
--
-- Hosted application is a separate, explicitly authorized window.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Task links: two more typed sources (existing five keep their meaning)
-- ---------------------------------------------------------------------------

alter table public.chapter_task_attachments
  drop constraint chapter_task_attachments_source_pair_check,
  add constraint chapter_task_attachments_source_pair_check
    check (
      (source_kind is null and source_id is null)
      or (
        source_kind in ('message', 'broadcast', 'notification', 'survey', 'case', 'channel_post', 'event')
        and nullif(pg_catalog.btrim(source_id), '') is not null
      )
    );

-- Idempotency binding for connected sends: the ledger row records WHICH source,
-- recipient and payload digest (never the body) a request id was first used for.
alter table public.organization_audit_ledger
  drop constraint organization_audit_ledger_metadata_keys,
  add constraint organization_audit_ledger_metadata_keys
    check ((metadata - array['organizationId', 'chapterId', 'slug', 'name', 'role', 'userId', 'status', 'requireStaffMfa', 'entityType', 'entityId', 'fromStatus', 'toStatus', 'fromRole', 'toRole', 'action', 'eventType', 'domain', 'jobName', 'runId', 'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode', 'exportType', 'cadence', 'dataClass', 'retentionDays', 'eligibleCount', 'deletedCount', 'remainingCount', 'mode', 'executionEnabled', 'operation', 'reviewStatus', 'version', 'selfReview', 'payloadDigest', 'sourceId', 'sourceKind']::text[]) = '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- 2. Reminders: task/event sources, completion and snooze bookkeeping
-- ---------------------------------------------------------------------------
-- Legacy message reminders keep status 'pending' and the legacy dispatcher.
-- Work reminders (task_item, event) use status 'scheduled'; the status/kind
-- CHECK below makes it impossible for the legacy dispatcher to ever select one.

alter table public.member_message_reminders
  drop constraint member_message_reminders_one_source,
  drop constraint member_message_reminders_source_kind_check,
  drop constraint member_message_reminders_status_check,
  add column source_ref text,
  add column snooze_count smallint not null default 0,
  add column completed_at timestamptz,
  add column updated_at timestamptz;

alter table public.member_message_reminders
  add constraint member_message_reminders_source_kind_check
    check (source_kind in ('private', 'channel', 'task', 'task_item', 'event')),
  add constraint member_message_reminders_status_check
    check (status in ('pending', 'scheduled', 'delivered', 'completed', 'cancelled', 'failed')),
  add constraint member_message_reminders_one_source check (
    (source_kind = 'private' and private_message_id is not null and channel_post_id is null and task_message_id is null and source_ref is null)
    or (source_kind = 'channel' and private_message_id is null and channel_post_id is not null and task_message_id is null and source_ref is null)
    or (source_kind = 'task' and private_message_id is null and channel_post_id is null and task_message_id is not null and source_ref is null)
    or (source_kind in ('task_item', 'event') and private_message_id is null and channel_post_id is null and task_message_id is null
        and source_ref is not null and pg_catalog.char_length(source_ref) between 1 and 200)
  ),
  add constraint member_message_reminders_status_by_kind check (
    case when source_kind in ('task_item', 'event') then status <> 'pending' else status <> 'scheduled' end
  ),
  add constraint member_message_reminders_completed_state check (
    (status = 'completed') = (completed_at is not null)
  );

create index member_message_reminders_scheduled_idx
  on public.member_message_reminders (remind_at, id) where status = 'scheduled';
create index member_message_reminders_owner_source_ref_idx
  on public.member_message_reminders (owner_id, source_kind, source_ref) where source_ref is not null;

comment on column public.member_message_reminders.source_ref is
  'Opaque id of a task or event source. Carries no content and grants no access: every list, open, snooze and delivery re-authorizes the exact source.';

-- ---------------------------------------------------------------------------
-- 3. Event organizer
-- ---------------------------------------------------------------------------

alter table public.member_events
  add column organizer_id uuid references auth.users(id) on delete set null;

create index member_events_organizer_idx
  on public.member_events (organizer_id) where organizer_id is not null;

comment on column public.member_events.organizer_id is
  'Explicit organizer chosen by event staff of the owning chapter. Not client-granted; exposed only through the connected-workflow RPCs, and only while the organizer still holds a staff grant for the chapter.';

-- The account-deletion row-key gate names every auth.users column of the table.
drop trigger z99_case_graph_keys on public.member_events;
create trigger z99_case_graph_keys before insert or update or delete on public.member_events
for each row execute function private.lock_case_graph_row_keys('{organizer_id}', '');

-- ---------------------------------------------------------------------------
-- 4. Private event-contact tables (no client grant, forced RLS)
-- ---------------------------------------------------------------------------

create table private.member_event_contact_opt_ins (
  event_id text not null
    references public.member_events(id) on update cascade on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  -- The organizer the attendee saw and consented to. Deliberately no reference
  -- to auth.users: it is only compared, never dereferenced, and a departed or
  -- replaced organizer simply makes the row dormant (see cw_event_contact_ready).
  organizer_id uuid not null,
  opted_in_at timestamptz not null default pg_catalog.now(),
  primary key (event_id, user_id)
);

create index member_event_contact_opt_ins_user_idx
  on private.member_event_contact_opt_ins (user_id);

alter table private.member_event_contact_opt_ins enable row level security;
alter table private.member_event_contact_opt_ins force row level security;
revoke all on table private.member_event_contact_opt_ins from public, anon, authenticated, service_role;

comment on table private.member_event_contact_opt_ins is
  'One row = one attendee allows ONE named event organizer (organizer_id, the person shown when consent was given) to contact them about that event. Effective only while that same person is still the organizer and authorized, the attendee still RSVPs going and the event is not cancelled. Removed with the account, the event, or an organizer change. No client grant.';

-- Metadata only. The words of an event contact live ONLY in the canonical
-- public.member_messages row that an existing private-conversation writer
-- created, so redaction tombstones, retention, legal holds, account deletion and
-- export follow the message body lifecycle unchanged. This row records which
-- delivered message belongs to which event, organizer and participant, and
-- nothing else: no body, no preview, no conversation content.
create table private.member_event_contact_links (
  message_id uuid primary key
    references public.member_messages(id) on delete cascade,
  event_id text not null
    references public.member_events(id) on update cascade on delete cascade,
  organizer_id uuid
    references auth.users(id) on delete set null,
  participant_id uuid
    references auth.users(id) on delete set null,
  sender_role text not null
    constraint member_event_contact_links_sender_role_check
    check (sender_role in ('organizer', 'participant')),
  created_at timestamptz not null default pg_catalog.now()
);

create index member_event_contact_links_organizer_thread_idx
  on private.member_event_contact_links (event_id, organizer_id, participant_id, created_at desc, message_id);
create index member_event_contact_links_participant_idx
  on private.member_event_contact_links (participant_id, event_id, created_at desc);
create index member_event_contact_links_organizer_idx
  on private.member_event_contact_links (organizer_id);

alter table private.member_event_contact_links enable row level security;
alter table private.member_event_contact_links force row level security;
revoke all on table private.member_event_contact_links from public, anon, authenticated, service_role;

comment on table private.member_event_contact_links is
  'Metadata-only binding of a delivered private message (public.member_messages) to an event, its organizer and a consenting participant. Holds no message text. Identity columns detach (ON DELETE SET NULL) with an account; the link leaves with the message row or the event. No client grant.';

create trigger a00_case_graph_lock before insert or update or delete on private.member_event_contact_opt_ins
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_event_contact_opt_ins
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on private.member_event_contact_links
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_event_contact_links
for each row execute function private.lock_case_graph_row_keys('{organizer_id},{participant_id}', '');

-- ---------------------------------------------------------------------------
-- 5. Account lifecycle registration and export
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, export_projection_version, export_domain,
   export_columns, exclusion_reason, note, reviewed_at)
values
  ('public', 'member_events', 'organizer_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff attribution of an event the organizer manages; the column records an assignment, not content the account authored. The event itself is chapter content.',
   'Installed action is ON DELETE SET NULL; the event survives and its organizer is cleared, which also ends every organizer contact right.',
   date '2026-09-28'),
  ('private', 'member_event_contact_opt_ins', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_event_contact_opt_ins',
   array['event_id','user_id','organizer_id','opted_in_at']::text[], null,
   'The attendee''s own per-event consent to be contacted by the organizer. Exported to that attendee; deleted with the account.',
   date '2026-09-28'),
  ('private', 'member_event_contact_links', 'participant_id', 'pseudonymize', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_event_contact_links',
   array['message_id','event_id','organizer_id','participant_id','sender_role','created_at']::text[], null,
   'Metadata-only binding of the caller''s delivered private messages to an event. The message text is exported under the canonical conversations projection; this domain only names the event and the parties.',
   date '2026-09-28'),
  ('private', 'member_event_contact_links', 'organizer_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Covered by the participant_id export domain, whose projection returns every link where the caller is the organizer or the participant.',
   'Installed action is ON DELETE SET NULL; the link survives with the retained message row and its identity detaches.',
   date '2026-09-28');

update private.account_lifecycle_manifest
set export_columns = array['id','owner_id','source_kind','private_message_id','channel_post_id','task_message_id',
      'source_ref','note','remind_at','status','snooze_count','completed_at','created_at','delivered_at','updated_at']::text[]
where schema_name = 'public' and table_name = 'member_message_reminders' and user_column = 'owner_id';

create or replace function private.account_lifecycle_export_member_message_reminders(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'owner_id', t.owner_id, 'source_kind', t.source_kind,
    'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id,
    'task_message_id', t.task_message_id, 'source_ref', t.source_ref, 'note', t.note,
    'remind_at', t.remind_at, 'status', t.status, 'snooze_count', t.snooze_count,
    'completed_at', t.completed_at, 'created_at', t.created_at,
    'delivered_at', t.delivered_at, 'updated_at', t.updated_at)), '[]'::jsonb)
  from public.member_message_reminders t where t.owner_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_event_contact_opt_ins(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'event_id', t.event_id, 'user_id', t.user_id, 'organizer_id', t.organizer_id, 'opted_in_at', t.opted_in_at)), '[]'::jsonb)
  from private.member_event_contact_opt_ins t where t.user_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_event_contact_links(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'message_id', t.message_id, 'event_id', t.event_id, 'organizer_id', t.organizer_id,
    'participant_id', t.participant_id, 'sender_role', t.sender_role,
    'created_at', t.created_at) order by t.created_at, t.message_id), '[]'::jsonb)
  from private.member_event_contact_links t
  where t.participant_id = p_caller or t.organizer_id = p_caller;
$export$;

revoke all on function private.account_lifecycle_export_member_message_reminders(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_event_contact_opt_ins(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_event_contact_links(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from the installed definition (20260924170200) with two added
-- domains; every other key is unchanged.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller)
  );
$export$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;


-- Trigger inventory: the new gates and the replaced member_events row-key gate.
delete from private.account_lifecycle_trigger_review
where kind = 'trigger' and schema_name = 'public' and table_name = 'member_events'
  and object_name = 'z99_case_graph_keys';

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger'
  and (
    (schema_name = 'public' and table_name = 'member_events' and object_name = 'z99_case_graph_keys')
    or (schema_name = 'private' and table_name in ('member_event_contact_opt_ins', 'member_event_contact_links')
        and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
  );

do $assert_connected_workflow_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after connected workflow shortcuts';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after connected workflow shortcuts';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after connected workflow shortcuts';
  end if;
end;
$assert_connected_workflow_lifecycle$;

-- ---------------------------------------------------------------------------
-- 6. Private helpers (no client EXECUTE)
-- ---------------------------------------------------------------------------

-- Machine-readable refusals: SQLSTATE + DETAIL 'cw:<code>[:<reason>]'.
-- STABLE on purpose: it only ever raises, and the read RPCs below are STABLE
-- (a volatile callee would make every one of them a lint finding).
create function private.cw_fail(p_code text, p_sqlstate text, p_message text, p_reason text default null)
returns void
language plpgsql
stable
set search_path = ''
as $function$
begin
  raise exception using
    errcode = p_sqlstate,
    message = p_message,
    detail = 'cw:' || p_code || case when p_reason is null then '' else ':' || p_reason end;
end;
$function$;

-- The chapter-task read boundary, mirrored once for an explicit actor:
-- chapter_tasks_select_chapter (same selected chapter, not soft-deleted) AND,
-- fail-closed, current active chapter and organization membership of an active
-- organization. The membership joins only ever narrow the RLS predicate: a
-- caller who could not act in this tenant gets the same answer as a stranger.
create function private.cw_task_readable(p_actor uuid, p_task uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.chapter_tasks t
    join public.member_profiles p on p.id = p_actor and p.chapter_id = t.chapter_id
    join public.chapters c on c.id = t.chapter_id and c.organization_id is not null
    join public.organizations o on o.id = c.organization_id and o.status = 'active'
    join public.member_chapter_memberships cm
      on cm.user_id = p.id and cm.chapter_id = c.id and cm.status = 'active'
    join public.organization_memberships om
      on om.user_id = p.id and om.organization_id = c.organization_id and om.status = 'active'
    where t.id = p_task and t.deleted_at is null
  );
$function$;

-- One authorization + normalization step per source. Returns {ok:false} for a
-- missing, removed-from-view or unauthorized record (indistinguishable), and a
-- privacy-safe description otherwise.
create function private.cw_resolve_source(p_actor uuid, p_kind text, p_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  clean_id text := pg_catalog.btrim(coalesce(p_id, ''));
  uid uuid;
  msg public.member_messages%rowtype;
  post_row public.chapter_thread_posts%rowtype;
  tmsg public.chapter_task_messages%rowtype;
  task_row public.chapter_tasks%rowtype;
  ev public.member_events%rowtype;
  scope_chapter text;
  scope_org uuid;
begin
  if p_actor is null or p_kind is null or clean_id = '' or pg_catalog.char_length(clean_id) > 200 then
    return pg_catalog.jsonb_build_object('ok', false);
  end if;
  if p_kind in ('private_message', 'channel_post', 'task_message', 'task') then
    begin
      uid := clean_id::uuid;
    exception when invalid_text_representation then
      return pg_catalog.jsonb_build_object('ok', false);
    end;
    clean_id := uid::text;
  end if;

  if p_kind = 'private_message' then
    if not private.can_read_message_source(p_actor, 'private', uid, null, null) then
      return pg_catalog.jsonb_build_object('ok', false);
    end if;
    select m.* into msg from public.member_messages m where m.id = uid;
    select p.chapter_id, c.organization_id into scope_chapter, scope_org
    from public.member_profiles p
    left join public.chapters c on c.id = p.chapter_id
    where p.id = msg.user_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'kind', p_kind, 'id', clean_id,
      'state', case when msg.redacted_at is null then 'available' else 'removed' end,
      'chapterId', scope_chapter, 'organizationId', scope_org,
      'conversationId', msg.conversation_id, 'senderKind', msg.sender_kind,
      'href', case when msg.user_id = p_actor
        then '/m/messages?conversation=' || msg.conversation_id::text || '&message=' || clean_id
        else '/m/steward?thread=' || msg.conversation_id::text || '&message=' || clean_id end);
  elsif p_kind = 'channel_post' then
    if not private.can_read_message_source(p_actor, 'channel', null, uid, null) then
      return pg_catalog.jsonb_build_object('ok', false);
    end if;
    select po.* into post_row from public.chapter_thread_posts po where po.id = uid;
    select c.organization_id into scope_org from public.chapters c where c.id = post_row.chapter_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'kind', p_kind, 'id', clean_id, 'state', 'available',
      'chapterId', post_row.chapter_id, 'organizationId', scope_org,
      'threadId', post_row.thread_id,
      'href', '/m/messages?channel=' || post_row.thread_id::text || '&post=' || clean_id);
  elsif p_kind = 'task_message' then
    if not private.can_read_message_source(p_actor, 'task', null, null, uid) then
      return pg_catalog.jsonb_build_object('ok', false);
    end if;
    select tm.* into tmsg from public.chapter_task_messages tm where tm.id = uid;
    if not exists (select 1 from public.chapter_tasks t where t.id = tmsg.task_id and t.deleted_at is null) then
      return pg_catalog.jsonb_build_object('ok', false);
    end if;
    select c.organization_id into scope_org from public.chapters c where c.id = tmsg.chapter_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'kind', p_kind, 'id', clean_id, 'state', 'available',
      'chapterId', tmsg.chapter_id, 'organizationId', scope_org, 'taskId', tmsg.task_id,
      'href', '/m/messages?taskThread=' || tmsg.task_id::text || '&message=' || clean_id);
  elsif p_kind = 'task' then
    if not private.cw_task_readable(p_actor, uid) then
      return pg_catalog.jsonb_build_object('ok', false);
    end if;
    select t.* into task_row from public.chapter_tasks t where t.id = uid;
    select c.organization_id into scope_org from public.chapters c where c.id = task_row.chapter_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'kind', p_kind, 'id', clean_id, 'state', 'available',
      'chapterId', task_row.chapter_id, 'organizationId', scope_org,
      'title', task_row.title, 'status', task_row.status,
      'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
      'href', '/m/tasks?task=' || clean_id);
  elsif p_kind = 'event' then
    if clean_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
      return pg_catalog.jsonb_build_object('ok', false);
    end if;
    select e.* into ev from public.member_events e where e.id = clean_id;
    if not found
       or not private.member_can_access_event_scope_for_user(
         p_actor, ev.chapter_id, ev.is_public, ev.is_public_across_agencies) then
      return pg_catalog.jsonb_build_object('ok', false);
    end if;
    select c.organization_id into scope_org from public.chapters c where c.id = ev.chapter_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'kind', p_kind, 'id', clean_id,
      'state', case when ev.cancelled_at is null then 'available' else 'cancelled' end,
      'chapterId', ev.chapter_id, 'organizationId', scope_org,
      'title', ev.title, 'startsAt', ev.starts_at, 'cancelledAt', ev.cancelled_at,
      'href', '/m/events?event=' || clean_id);
  end if;
  return pg_catalog.jsonb_build_object('ok', false);
end;
$function$;

-- A client-supplied chapter/organization is only an assertion about which scope
-- the client was looking at: accepted when it equals the source's OR the
-- caller's current scope, refused otherwise (stale tab, switched chapter).
create function private.cw_scope_matches(p_source jsonb, p_chapter text, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
      p_chapter is null
      or p_chapter = (p_source ->> 'chapterId')
      or p_chapter = private.current_member_chapter(), false)
    and coalesce(
      p_org is null
      or p_org::text = (p_source ->> 'organizationId')
      or p_org = private.current_member_organization(), false);
$function$;

create function private.cw_unavailable_context(p_reason text, p_kind text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'available', false, 'reason', p_reason, 'kind', p_kind, 'id', null,
    'organizationId', null, 'chapterId', null, 'state', 'unavailable', 'href', null,
    'canMessage', false, 'canRemind', false, 'canCreateTask', false,
    'reasons', pg_catalog.jsonb_build_object('message', p_reason, 'remind', p_reason, 'task', p_reason),
    'linkedTask', null, 'discussionHref', null, 'sourceLinks', '[]'::jsonb, 'timezone', null,
    'cancelled', false, 'organizer', null, 'contactOptIn', false,
    'canManageOrganizer', false, 'canContactOptIn', false, 'contactRole', null);
$function$;

-- A candidate may be named organizer only if that person could act as one:
-- hold a staff grant for the event's chapter, be able to read the event, AND be
-- a steward the existing private-conversation writer authorizes for members of
-- that chapter (private.staff_actor_can_see_user, the predicate behind
-- can_actor_send_private_message(..., 'steward')). Organizer contact is delivered
-- through that writer, so no other staff hat gains a new right to contact members.
create function private.cw_event_candidate_ok(p_user uuid, p_event_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user is not null and exists (
    select 1
    from public.member_events e
    where e.id = p_event_id
      and private.actor_has_chapter_staff_role(p_user, e.chapter_id)
      and private.member_can_access_event_scope_for_user(
        p_user, e.chapter_id, e.is_public, e.is_public_across_agencies)
      and exists (
        select 1 from public.member_profiles t
        where t.chapter_id = e.chapter_id and t.id <> p_user
          and private.staff_actor_can_see_user(p_user, t.id)
        limit 1)
  );
$function$;

-- The assigned organizer must still satisfy the exact steward/private-message
-- predicate used when assigning them; another remaining staff role is insufficient.
create function private.cw_event_organizer_ok(p_actor uuid, p_event_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_actor is not null and exists (
    select 1
    from public.member_events e
    where e.id = p_event_id
      and e.organizer_id = p_actor
      and private.cw_event_candidate_ok(p_actor, e.id)
      and private.member_can_access_event_scope_for_user(
        p_actor, e.chapter_id, e.is_public, e.is_public_across_agencies)
  );
$function$;

-- Effective consent: opt-in row AND RSVP going AND still in the event's scope
-- AND event not cancelled AND an organizer is assigned. Freshly evaluated.
create function private.cw_event_contact_ready(p_user uuid, p_event_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user is not null and exists (
    select 1
    from public.member_events e
    join private.member_event_contact_opt_ins o
      on o.event_id = e.id and o.user_id = p_user and o.organizer_id = e.organizer_id
    join public.member_event_rsvps r on r.event_id = e.id and r.user_id = p_user and r.status = 'going'
    where e.id = p_event_id
      and e.cancelled_at is null
      and e.organizer_id is not null
      and private.member_can_access_event_scope_for_user(
        p_user, e.chapter_id, e.is_public, e.is_public_across_agencies)
  );
$function$;

-- The participant's existing private conversation the organizer's own writer
-- authorizes (deterministic pick: bound to this steward, then the general
-- thread, then the most recently active). A consenting attendee without one
-- receives a new canonical steward-bound conversation only on explicit Send.
create function private.cw_event_conversation(p_organizer uuid, p_participant uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select cv.id
  from public.member_conversations cv
  where cv.user_id = p_participant
    and private.can_actor_send_private_message(p_organizer, cv.id, 'steward')
  order by (cv.steward_user_id is not distinct from p_organizer) desc,
           (cv.steward_user_id is null) desc, cv.updated_at desc, cv.id
  limit 1;
$function$;

create function private.cw_event_recipients(p_actor uuid, p_event_id text)
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
      and m.redacted_at is null
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

-- Task participants reachable ONLY through boundaries that already exist:
-- the task thread (creator <-> primary assignee), an accepted peer contact,
-- a steward's own reply path, or a member -> roster steward conversation.
create function private.cw_task_recipients(p_actor uuid, p_task uuid)
returns table (rid uuid, rlabel text, rvia text, rtarget uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  task_row public.chapter_tasks%rowtype;
  actor_chapter text;
  counterpart uuid;
  steward_ready boolean;
begin
  select tk.* into task_row from public.chapter_tasks tk where tk.id = p_task and tk.deleted_at is null;
  if not found then return; end if;
  select p.chapter_id into actor_chapter from public.member_profiles p where p.id = p_actor;
  if actor_chapter is null or actor_chapter is distinct from task_row.chapter_id then return; end if;
  -- Only the task's own people (creator, assignee) or chapter staff may enumerate
  -- its audience; a member who merely reads the board is offered no one.
  if not (
    p_actor = task_row.created_by
    or exists (select 1 from public.chapter_task_assignments a
               where a.task_id = task_row.id and a.assignee_id = p_actor)
    or private.member_has_chapter_role(
         task_row.chapter_id, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
  ) then
    return;
  end if;
  counterpart := case
    when p_actor = task_row.assignee_id then task_row.created_by
    when p_actor = task_row.created_by then task_row.assignee_id end;
  steward_ready := coalesce(public.member_has_role(array['steward']), false);
  return query
  select e.uid, e.label, pick.via, pick.target_id
  from (
    select pr.id as uid,
           coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Member') as label
    from (
      select task_row.created_by as uid
      union
      select a.assignee_id from public.chapter_task_assignments a where a.task_id = task_row.id
    ) part
    join public.member_profiles pr on pr.id = part.uid and pr.chapter_id = task_row.chapter_id
    where part.uid is not null and part.uid <> p_actor
  ) e
  cross join lateral (
    select v.via, v.target_id
    from (
      select 1 as prio, 'task_thread'::text as via, task_row.id as target_id
        where e.uid = counterpart
      union all
      -- peer: the exact authorization public.send_reward_peer_message applies is
      -- membership of an EXISTING member_peer_conversations row. Such a row is
      -- created only from an accepted contact request, and the product has no
      -- revoke/unfriend path (accepted consent is durable by design, 20260812233000),
      -- so existence of the row IS the current-contact predicate. We advertise
      -- exactly that, no looser and no stricter.
      select 2, 'peer', c.id
        from public.member_peer_conversations c
        where (c.user_low = p_actor and c.user_high = e.uid) or (c.user_low = e.uid and c.user_high = p_actor)
      union all
      select 3, 'steward_reply', cv.id
        from public.member_conversations cv
        where steward_ready and cv.user_id = e.uid
          and private.can_actor_send_private_message(p_actor, cv.id, 'steward')
      union all
      select 4, 'steward_start', null::uuid
        where exists (
          select 1 from private.member_roster_stewards_for_chapter(actor_chapter) rs
          where rs.steward_id = e.uid)
    ) v
    order by v.prio, v.target_id
    limit 1
  ) pick;
end;
$function$;

create function private.cw_recipients(p_actor uuid, p_source jsonb)
returns table (rid uuid, rlabel text, rvia text, rtarget uuid)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_source ->> 'kind' = 'task' then
    return query select * from private.cw_task_recipients(p_actor, (p_source ->> 'id')::uuid);
  elsif p_source ->> 'kind' = 'event' then
    return query select * from private.cw_event_recipients(p_actor, p_source ->> 'id');
  end if;
end;
$function$;

-- Reminder storage <-> API vocabulary.
create function private.cw_reminder_api_kind(p_storage_kind text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case p_storage_kind
    when 'private' then 'private_message'
    when 'channel' then 'channel_post'
    when 'task' then 'task_message'
    when 'task_item' then 'task'
    when 'event' then 'event' end;
$function$;

create function private.cw_reminder_source_id(p_row public.member_message_reminders)
returns text
language sql
immutable
set search_path = ''
as $function$
  select coalesce(p_row.private_message_id::text, p_row.channel_post_id::text,
                  p_row.task_message_id::text, p_row.source_ref);
$function$;

create function private.cw_active_reminder_count(p_owner uuid, p_storage_kind text, p_source_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.count(*)::integer
  from public.member_message_reminders r
  where r.owner_id = p_owner
    and r.source_kind = p_storage_kind
    and r.status in ('pending', 'scheduled')
    and coalesce(r.private_message_id::text, r.channel_post_id::text,
                 r.task_message_id::text, r.source_ref) = p_source_id;
$function$;

create function private.cw_reminder_json(p_row public.member_message_reminders, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  api_kind text := private.cw_reminder_api_kind(p_row.source_kind);
  source_id text := private.cw_reminder_source_id(p_row);
  src jsonb := private.cw_resolve_source(p_actor, api_kind, source_id);
  -- Exact tenant membership: no active chapter+organization membership, no source.
  available boolean := coalesce((src ->> 'ok')::boolean, false)
    and private.current_member_organization() is not null;
  route text := null;
begin
  if available then
    route := src ->> 'href';
    if api_kind = 'task'
       and not private.member_has_chapter_role(
         src ->> 'chapterId', array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      route := null;
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'id', p_row.id,
    'kind', api_kind,
    'sourceId', case when available then source_id end,
    'remindAt', p_row.remind_at,
    'note', p_row.note,
    'status', case p_row.status when 'pending' then 'scheduled' else p_row.status end,
    'snoozeCount', p_row.snooze_count,
    'completedAt', p_row.completed_at,
    'createdAt', p_row.created_at,
    'updatedAt', coalesce(p_row.updated_at, p_row.created_at),
    'available', available,
    'sourceState', case when available then src ->> 'state' else 'unavailable' end,
    'href', route,
    'title', case when available and api_kind in ('task', 'event') then src ->> 'title' end);
end;
$function$;

revoke all on function private.cw_fail(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_task_readable(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.cw_resolve_source(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_scope_matches(jsonb, text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.cw_unavailable_context(text, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_event_organizer_ok(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_event_candidate_ok(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_event_contact_ready(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_event_recipients(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_event_conversation(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.cw_task_recipients(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.cw_recipients(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.cw_reminder_api_kind(text) from public, anon, authenticated, service_role;
revoke all on function private.cw_reminder_source_id(public.member_message_reminders) from public, anon, authenticated, service_role;
revoke all on function private.cw_active_reminder_count(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.cw_reminder_json(public.member_message_reminders, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Context
-- ---------------------------------------------------------------------------

create function public.get_connected_workflow_context(
  p_kind text,
  p_id text,
  p_chapter_id text default null,
  p_organization_id uuid default null
)
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
    'canManageOrganizer', can_manage, 'canContactOptIn', can_opt, 'contactRole', contact_role);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Recipients (keyset paged)
-- ---------------------------------------------------------------------------

create function public.list_connected_workflow_recipients(
  p_kind text,
  p_id text,
  p_cursor text default null,
  p_limit integer default 25,
  p_chapter_id text default null,
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  src jsonb;
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  cursor_label text;
  cursor_id uuid;
  cursor_json jsonb;
  items jsonb;
  last_item jsonb;
  next_cursor text := null;
  empty_reason text;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('private_message', 'channel_post', 'task_message', 'task', 'event') then
    perform private.cw_fail('invalid_input', '22023', 'invalid reference', 'kind');
  end if;
  if p_cursor is not null then
    begin
      cursor_json := p_cursor::jsonb;
      cursor_label := cursor_json ->> 0;
      cursor_id := (cursor_json ->> 1)::uuid;
      if cursor_label is null or cursor_id is null then raise exception 'bad cursor'; end if;
    exception when others then
      perform private.cw_fail('invalid_input', '22023', 'invalid cursor', 'cursor');
    end;
  end if;
  if p_kind not in ('task', 'event') then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'reason', 'not_offered', 'items', '[]'::jsonb, 'nextCursor', null);
  end if;
  if private.current_member_organization() is null then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'reason', 'source_unavailable', 'items', '[]'::jsonb, 'nextCursor', null);
  end if;

  src := private.cw_resolve_source(caller, p_kind, p_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'reason', 'source_unavailable', 'items', '[]'::jsonb, 'nextCursor', null);
  end if;
  if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'reason', 'scope_changed', 'items', '[]'::jsonb, 'nextCursor', null);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.rid, 'label', p.rlabel)
           order by pg_catalog.lower(p.rlabel), p.rid), '[]'::jsonb)
  into items
  from (
    select r.rid, r.rlabel
    from private.cw_recipients(caller, src) r
    where cursor_label is null or (pg_catalog.lower(r.rlabel), r.rid) > (cursor_label, cursor_id)
    order by pg_catalog.lower(r.rlabel), r.rid
    limit lim + 1
  ) p;

  if pg_catalog.jsonb_array_length(items) > lim then
    items := items - lim;
    last_item := items -> (lim - 1);
    next_cursor := pg_catalog.jsonb_build_array(
      pg_catalog.lower(last_item ->> 'label'), last_item ->> 'id')::text;
  end if;

  if pg_catalog.jsonb_array_length(items) = 0 and p_cursor is null then
    empty_reason := case
      when p_kind = 'event' and src ->> 'state' = 'cancelled' then 'event_cancelled'
      when p_kind = 'event' and not exists (
        select 1 from public.member_events e where e.id = src ->> 'id' and e.organizer_id is not null) then 'organizer_required'
      else 'no_authorized_audience' end;
    return pg_catalog.jsonb_build_object('status', 'unavailable', 'reason', empty_reason, 'items', '[]'::jsonb, 'nextCursor', null);
  end if;
  return pg_catalog.jsonb_build_object('status', 'available', 'reason', null, 'items', items, 'nextCursor', next_cursor);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Linked task (create or open), staff only, idempotent per source
-- ---------------------------------------------------------------------------

create function public.create_connected_workflow_task(
  p_kind text,
  p_id text,
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
  caller_chapter text;
  src jsonb;
  src_id text;
  storage_kind text;
  task_title text;
  attachment_label text;
  task_workstream text;
  task_row public.chapter_tasks%rowtype;
  attachment_row public.chapter_task_attachments%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('private_message', 'channel_post', 'event', 'task_message') then
    perform private.cw_fail('capability_unavailable', '22023', 'task creation is not offered for this source', 'not_offered');
  end if;

  -- Same serialization the chapter switcher uses, so the caller's chapter is
  -- authorized and used under one lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-chapter:' || caller::text, 0));
  select p.chapter_id into caller_chapter from public.member_profiles p where p.id = caller;
  if caller_chapter is null then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  if not private.member_has_chapter_role(
       caller_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    perform private.cw_fail('not_authorized', '42501', 'staff role required', 'staff_grant_required');
  end if;

  src := private.cw_resolve_source(caller, p_kind, p_id);
  if not coalesce((src ->> 'ok')::boolean, false) then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
    perform private.cw_fail('scope_changed', '22023', 'source scope changed');
  end if;
  -- A task is created in the caller's CURRENT chapter for a source of that same
  -- chapter. A stale reference (the caller switched chapter after opening it)
  -- never lands work in a different chapter than the source belongs to.
  if src ->> 'chapterId' is distinct from caller_chapter then
    perform private.cw_fail('scope_changed', '22023', 'source is not in your current chapter', 'chapter_mismatch');
  end if;
  if p_kind = 'task_message' then
    -- The message already belongs to a task. Open that task (never create a
    -- second one) for staff of this chapter, under the ordinary task read predicate.
    select t.* into task_row from public.chapter_tasks t
    where t.id = (src ->> 'taskId')::uuid and t.deleted_at is null;
    if not found or not private.cw_task_readable(caller, task_row.id) then
      perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false,
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', null,
      'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
      'href', '/m/tasks?task=' || task_row.id::text);
  end if;
  src_id := src ->> 'id';
  storage_kind := case p_kind when 'private_message' then 'message' else p_kind end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_chapter || pg_catalog.chr(31) || storage_kind || pg_catalog.chr(31) || src_id, 0));

  select a.* into attachment_row
  from public.chapter_task_attachments a
  where a.chapter_id = caller_chapter and a.source_kind = storage_kind and a.source_id = src_id;
  if found then
    select t.* into task_row from public.chapter_tasks t
    where t.id = attachment_row.task_id and t.deleted_at is null;
    if not found then
      perform private.cw_fail('capability_unavailable', '22023', 'linked task was deleted', 'linked_task_deleted');
    end if;
    return pg_catalog.jsonb_build_object(
      'created', false,
      'task', pg_catalog.to_jsonb(task_row),
      'attachment', pg_catalog.to_jsonb(attachment_row),
      'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
      'href', '/m/tasks?task=' || task_row.id::text);
  end if;

  if src ->> 'state' = 'removed' then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable', 'source_removed');
  end if;

  task_title := case p_kind
    when 'private_message' then case when src ->> 'senderKind' = 'member' then 'Follow up on member message' else 'Follow up on message' end
    when 'channel_post' then 'Follow up on channel post'
    else 'Follow up on event' end;
  attachment_label := case p_kind
    when 'private_message' then case when src ->> 'senderKind' = 'member' then 'Authorized member message' else 'Authorized message' end
    when 'channel_post' then 'Authorized channel post'
    else 'Authorized event' end;

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
    perform private.cw_fail('capability_unavailable', '22023', 'chapter has no available task workstream', 'no_workstream');
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
    task_row.id, caller_chapter, attachment_label, src ->> 'href', caller, storage_kind, src_id
  ) returning * into attachment_row;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, to_value
  ) values (
    task_row.id, caller_chapter, caller, 'attachment_added', attachment_row.id::text
  );

  return pg_catalog.jsonb_build_object(
    'created', true,
    'task', pg_catalog.to_jsonb(task_row),
    'attachment', pg_catalog.to_jsonb(attachment_row),
    'taskKey', pg_catalog.lower(task_row.chapter_id) || '-' || task_row.task_number::text,
    'href', '/m/tasks?task=' || task_row.id::text);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Reminders
-- ---------------------------------------------------------------------------

create function public.save_connected_workflow_reminder(
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

  return pg_catalog.jsonb_build_object(
    'created', true, 'coalesced', false, 'reminder', private.cw_reminder_json(reminder_row, caller));
end;
end;
$function$;

create function public.list_connected_workflow_reminders(
  p_cursor text default null,
  p_limit integer default 25,
  p_status text default 'open'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  filter_status text := coalesce(p_status, 'open');
  statuses text[];
  cursor_json jsonb;
  cursor_at timestamptz;
  cursor_id uuid;
  row_data public.member_message_reminders%rowtype;
  collected jsonb := '[]'::jsonb;
  fetched integer := 0;
  next_cursor text := null;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  statuses := case filter_status
    when 'open' then array['pending', 'scheduled', 'delivered']
    when 'scheduled' then array['pending', 'scheduled']
    when 'delivered' then array['delivered']
    when 'completed' then array['completed']
    when 'cancelled' then array['cancelled']
    when 'failed' then array['failed']
    when 'all' then array['pending', 'scheduled', 'delivered', 'completed', 'cancelled', 'failed'] end;
  if statuses is null then
    perform private.cw_fail('invalid_input', '22023', 'invalid status filter', 'status');
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

  for row_data in
    select r.*
    from public.member_message_reminders r
    where r.owner_id = caller
      and r.status = any(statuses)
      and (cursor_at is null or (r.remind_at, r.id) > (cursor_at, cursor_id))
    order by r.remind_at, r.id
    limit lim + 1
  loop
    fetched := fetched + 1;
    if fetched <= lim then
      collected := collected || pg_catalog.jsonb_build_array(private.cw_reminder_json(row_data, caller));
    else
      next_cursor := pg_catalog.jsonb_build_array(
        (collected -> (lim - 1)) ->> 'remindAt', (collected -> (lim - 1)) ->> 'id')::text;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('items', collected, 'nextCursor', next_cursor);
end;
$function$;

create function public.act_on_connected_workflow_reminder(
  p_reminder_id uuid,
  p_action text,
  p_remind_at timestamptz default null
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
  reminder_row public.member_message_reminders%rowtype;
  src jsonb;
  api_kind text;
  shown jsonb;
  replayed boolean := false;
  active boolean;
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
  for update;
  if not found then
    perform private.cw_fail('source_unavailable', '22023', 'reminder unavailable', 'reminder');
  end if;
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

  shown := private.cw_reminder_json(reminder_row, caller);
  return pg_catalog.jsonb_build_object(
    'reminder', shown,
    'available', coalesce((shown ->> 'available')::boolean, false),
    'href', shown -> 'href',
    'replayed', replayed);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 11. Event organizer, consent and thread reader
-- ---------------------------------------------------------------------------

create function public.set_member_event_organizer(p_event_id text, p_organizer_id uuid)
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
  if p_organizer_id is not null and not private.cw_event_candidate_ok(p_organizer_id, ev.id) then
    perform private.cw_fail('invalid_input', '22023', 'organizer must hold a staff grant for this chapter', 'organizer_unavailable');
  end if;

  if ev.organizer_id is distinct from p_organizer_id then
    update public.member_events set organizer_id = p_organizer_id where id = ev.id;
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
    'changed', ev.organizer_id is distinct from p_organizer_id);
end;
end;
$function$;

create function public.list_member_event_organizer_candidates(
  p_event_id text,
  p_cursor text default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  ev public.member_events%rowtype;
  event_org uuid;
  lim integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  cursor_label text;
  cursor_id uuid;
  cursor_json jsonb;
  items jsonb;
  last_item jsonb;
  next_cursor text := null;
begin
  if caller is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    perform private.cw_fail('not_authorized', '42501', 'staff role required', 'staff_grant_required');
  end if;
  if p_cursor is not null then
    begin
      cursor_json := p_cursor::jsonb;
      cursor_label := cursor_json ->> 0;
      cursor_id := (cursor_json ->> 1)::uuid;
      if cursor_label is null or cursor_id is null then raise exception 'bad cursor'; end if;
    exception when others then
      perform private.cw_fail('invalid_input', '22023', 'invalid cursor', 'cursor');
    end;
  end if;
  select e.* into ev from public.member_events e
  where e.id = p_event_id and e.chapter_id = private.current_member_chapter();
  if not found then
    perform private.cw_fail('source_unavailable', '22023', 'unknown event');
  end if;
  select c.organization_id into event_org from public.chapters c where c.id = ev.chapter_id;
  if event_org is null then
    return pg_catalog.jsonb_build_object('items', '[]'::jsonb, 'nextCursor', null);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.uid, 'label', p.label)
           order by pg_catalog.lower(p.label), p.uid), '[]'::jsonb)
  into items
  from (
    select u.uid,
           coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Member') as label
    from (
      select g.user_id as uid from public.organization_role_grants g
        where g.organization_id = event_org
          and g.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
      union
      select rc.user_id from public.member_role_chapters rc
        where rc.chapter_id = ev.chapter_id
          and rc.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    ) u
    join public.member_profiles pr on pr.id = u.uid
    where private.cw_event_candidate_ok(u.uid, ev.id)
      and (cursor_label is null
           or (pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Member')), u.uid) > (cursor_label, cursor_id))
    order by pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(pr.full_name), ''), 'Member')), u.uid
    limit lim + 1
  ) p;

  if pg_catalog.jsonb_array_length(items) > lim then
    items := items - lim;
    last_item := items -> (lim - 1);
    next_cursor := pg_catalog.jsonb_build_array(
      pg_catalog.lower(last_item ->> 'label'), last_item ->> 'id')::text;
  end if;
  return pg_catalog.jsonb_build_object('items', items, 'nextCursor', next_cursor);
end;
$function$;

create function public.set_member_event_contact_opt_in(
  p_event_id text,
  p_opt_in boolean,
  p_expected_organizer_id uuid default null
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
  clean_event text := pg_catalog.btrim(coalesce(p_event_id, ''));
  src jsonb;
  ev public.member_events%rowtype;
  changed boolean := false;
  removed integer;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_opt_in is null then
    perform private.cw_fail('invalid_input', '22023', 'opt-in choice is required', 'opt_in');
  end if;

  -- Withdrawing consent is always possible, even when the event can no longer
  -- be read: it only ever removes the caller's own row.
  if not p_opt_in then
    delete from private.member_event_contact_opt_ins where event_id = clean_event and user_id = caller;
    get diagnostics removed = row_count;
    return pg_catalog.jsonb_build_object('eventId', clean_event, 'contactOptIn', false, 'changed', removed > 0);
  end if;

  -- Consent is given to ONE named person. The attendee states which organizer
  -- they were shown; if staff changed the organizer since, the stale form is
  -- refused instead of silently granting the new organizer.
  if p_expected_organizer_id is null then
    perform private.cw_fail('invalid_input', '22023', 'the organizer you are agreeing to is required', 'expected_organizer');
  end if;
  if private.current_member_organization() is null then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  src := private.cw_resolve_source(caller, 'event', clean_event);
  if not coalesce((src ->> 'ok')::boolean, false) then
    perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
  end if;
  -- The share lock conflicts with the FOR UPDATE lock every organizer change
  -- holds (set_member_event_organizer), so the organizer compared here is the
  -- organizer that is current when consent is written, never an earlier one.
  select e.* into ev from public.member_events e where e.id = src ->> 'id' for share;
  if ev.cancelled_at is not null then
    perform private.cw_fail('event_cancelled', '22023', 'this event was cancelled', 'event_cancelled');
  end if;
  if ev.organizer_id is null then
    perform private.cw_fail('organizer_required', '22023', 'this event has no organizer', 'organizer_required');
  end if;
  if ev.organizer_id is distinct from p_expected_organizer_id then
    perform private.cw_fail('organizer_changed', '22023', 'the event organizer changed; review and confirm again', 'organizer_changed');
  end if;
  if not private.cw_event_organizer_ok(ev.organizer_id, ev.id) then
    perform private.cw_fail('organizer_required', '22023', 'this event has no organizer', 'organizer_required');
  end if;
  if ev.organizer_id = caller then
    perform private.cw_fail('capability_unavailable', '22023', 'the organizer cannot opt in', 'organizer_cannot_opt_in');
  end if;
  if not exists (select 1 from public.member_event_rsvps r
                 where r.event_id = ev.id and r.user_id = caller and r.status = 'going') then
    perform private.cw_fail('opt_in_required', '22023', 'RSVP going before allowing contact', 'not_attending');
  end if;
  insert into private.member_event_contact_opt_ins (event_id, user_id, organizer_id)
  values (ev.id, caller, ev.organizer_id)
  on conflict (event_id, user_id) do update
    set organizer_id = excluded.organizer_id, opted_in_at = pg_catalog.now()
    where private.member_event_contact_opt_ins.organizer_id is distinct from excluded.organizer_id;
  changed := found;
  return pg_catalog.jsonb_build_object(
    'eventId', ev.id, 'contactOptIn', true, 'changed', changed, 'organizerId', ev.organizer_id);
end;
end;
$function$;

create function public.list_member_event_contact_messages(
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
    join public.member_messages m on m.id = l.message_id
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
$function$;

-- ---------------------------------------------------------------------------
-- 12. Send (all-or-nothing, explicit recipients, idempotent per request)
-- ---------------------------------------------------------------------------

create function private.cw_send_digest(
  p_request uuid, p_kind text, p_source text, p_recipient uuid, p_body text)
returns text
language sql
immutable
set search_path = ''
as $function$
  -- The request id salts the digest, so the stored value is not a dictionary
  -- oracle for short bodies, and it binds source, recipient and exact text.
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    p_request::text || pg_catalog.chr(31) || p_kind || pg_catalog.chr(31) || p_source
      || pg_catalog.chr(31) || p_recipient::text || pg_catalog.chr(31) || p_body, 'UTF8')), 'hex');
$function$;

revoke all on function private.cw_send_digest(uuid, text, text, uuid, text) from public, anon, authenticated, service_role;

create function public.send_connected_workflow_message(
  p_kind text,
  p_id text,
  p_recipient_ids uuid[],
  p_body text,
  p_request_id uuid,
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
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''),
    ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(12) || pg_catalog.chr(11));
  recipients uuid[];
  rcpt uuid;
  norm_id text;
  src jsonb;
  candidate record;
  ev public.member_events%rowtype;
  caller_org uuid;
  ledger_key uuid;
  ledger_row public.organization_audit_ledger%rowtype;
  digest text;
  sent_result jsonb;
  message_id text;
  results jsonb := '[]'::jsonb;
  prior jsonb := '{}'::jsonb;
  pending integer := 0;
  fresh integer := 0;
begin
  if caller is null or not private.mfa_satisfied() then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  if p_kind is null or p_kind not in ('task', 'event') then
    perform private.cw_fail('capability_unavailable', '22023', 'messaging is not offered for this source', 'not_offered');
  end if;
  if p_request_id is null then
    perform private.cw_fail('invalid_input', '22023', 'request id is required', 'request_id');
  end if;
  if pg_catalog.char_length(clean_body) not between 1 and 4000
     or pg_catalog.regexp_replace(clean_body, '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]' then
    perform private.cw_fail('invalid_input', '22023', 'message must be between 1 and 4000 characters', 'body');
  end if;
  select coalesce(pg_catalog.array_agg(distinct x order by x), '{}') into recipients
  from pg_catalog.unnest(coalesce(p_recipient_ids, '{}')) x where x is not null;
  if pg_catalog.cardinality(recipients) not between 1 and 12
     or pg_catalog.cardinality(recipients) <> coalesce(pg_catalog.cardinality(p_recipient_ids), 0) then
    perform private.cw_fail('invalid_input', '22023', 'choose between 1 and 12 distinct recipients', 'recipients');
  end if;
  caller_org := private.current_member_organization();
  if caller_org is null then
    perform private.cw_fail('not_authorized', '42501', 'authentication required');
  end if;
  begin
    norm_id := case when p_kind = 'task' then (pg_catalog.btrim(p_id))::uuid::text else pg_catalog.btrim(p_id) end;
  exception when others then
    perform private.cw_fail('invalid_input', '22023', 'invalid reference', 'id');
  end;
  if norm_id is null or norm_id = '' or pg_catalog.char_length(norm_id) > 200 then
    perform private.cw_fail('invalid_input', '22023', 'invalid reference', 'id');
  end if;

  -- Concurrent identical requests converge: one writer at a time per request.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cw-send:' || caller::text || ':' || p_request_id::text, 509));

  -- Replay pass. A recorded (request, recipient) is answered from the ledger
  -- without any new write, but only when it was recorded for the SAME actor,
  -- source, recipient and payload digest; anything else is a reused request id.
  foreach rcpt in array recipients loop
    ledger_key := pg_catalog.md5(p_request_id::text || ':' || rcpt::text)::uuid;
    digest := private.cw_send_digest(p_request_id, p_kind, norm_id, rcpt, clean_body);
    select l.* into ledger_row from public.organization_audit_ledger l where l.idempotency_key = ledger_key;
    if found then
      if ledger_row.actor_user_id is distinct from caller
         or ledger_row.metadata ->> 'sourceKind' is distinct from p_kind
         or ledger_row.metadata ->> 'sourceId' is distinct from norm_id
         or ledger_row.metadata ->> 'userId' is distinct from rcpt::text
         or ledger_row.metadata ->> 'payloadDigest' is distinct from digest then
        perform private.cw_fail('idempotency_conflict', '23505', 'request id was already used for a different message', 'request_reused');
      end if;
      prior := prior || pg_catalog.jsonb_build_object(rcpt::text, pg_catalog.jsonb_build_object(
        'recipientId', rcpt, 'via', ledger_row.metadata ->> 'entityType',
        'messageId', ledger_row.entity_id, 'replayed', true));
    else
      pending := pending + 1;
    end if;
  end loop;

  if pending > 0 then
    -- Fresh source, scope, cancellation and write-budget gates apply only to
    -- recipients that would actually receive a new message.
    src := private.cw_resolve_source(caller, p_kind, norm_id);
    if not coalesce((src ->> 'ok')::boolean, false) then
      perform private.cw_fail('source_unavailable', '22023', 'source unavailable');
    end if;
    if not private.cw_scope_matches(src, p_chapter_id, p_organization_id) then
      perform private.cw_fail('scope_changed', '22023', 'source scope changed');
    end if;
    if p_kind = 'event' then
      if src ->> 'state' = 'cancelled' then
        perform private.cw_fail('event_cancelled', '22023', 'this event was cancelled', 'event_cancelled');
      end if;
      select e.* into ev from public.member_events e where e.id = src ->> 'id';
    end if;
    perform private.message_action_admit();
  end if;

  foreach rcpt in array recipients loop
    if prior ->> rcpt::text is not null then
      results := results || pg_catalog.jsonb_build_array(prior -> rcpt::text);
      continue;
    end if;
    -- Every new recipient must be in the CURRENT eligible set, or nothing is sent.
    select r.* into candidate from private.cw_recipients(caller, src) r where r.rid = rcpt;
    if not found then
      perform private.cw_fail('recipient_unavailable', '22023', 'a selected recipient is not available', 'recipient_unavailable');
    end if;
    ledger_key := pg_catalog.md5(p_request_id::text || ':' || rcpt::text)::uuid;
    digest := private.cw_send_digest(p_request_id, p_kind, norm_id, rcpt, clean_body);

    message_id := null;
    if candidate.rvia = 'task_thread' then
      if pg_catalog.char_length(clean_body) > 2000 then
        perform private.cw_fail('invalid_input', '22023', 'task messages are limited to 2000 characters', 'body');
      end if;
      sent_result := public.send_chapter_task_message(candidate.rtarget, clean_body);
      message_id := sent_result ->> 'id';
    elsif candidate.rvia = 'peer' then
      sent_result := public.send_reward_peer_message(candidate.rtarget, clean_body);
      message_id := sent_result -> 'message' ->> 'id';
    elsif candidate.rvia = 'steward_reply' then
      perform public.send_steward_reply(candidate.rtarget, clean_body);
      select m.id::text into message_id
      from public.member_messages m
      where m.conversation_id = candidate.rtarget and m.sender_kind = 'steward'
        and m.sender_id = caller and m.body = clean_body
        and m.created_at = pg_catalog.transaction_timestamp()
      order by m.id desc limit 1;
    elsif candidate.rvia = 'steward_start' then
      sent_result := public.start_member_steward_conversation(rcpt, clean_body);
      message_id := sent_result ->> 'messageId';
    elsif candidate.rvia = 'event_organizer' then
      if candidate.rtarget is null then
        -- The event's explicit consent authorizes first contact. Reuse the
        -- member->steward writer's pair lock and unique conversation identity.
        -- The case-graph gate above orders this with opt-out, RSVP, membership,
        -- organizer and account changes; no conversation is created on reads.
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(rcpt::text || ':' || caller::text, 0));
        select c.id into candidate.rtarget from public.member_conversations c
        where c.user_id = rcpt and c.steward_user_id = caller;
        if candidate.rtarget is null then
          insert into public.member_conversations (user_id, title, initials, steward_user_id)
          values (rcpt, 'Chapter steward', 'CS', caller)
          returning id into candidate.rtarget;
        end if;
      end if;
      -- Delivered by the existing steward writer into the participant's own
      -- private conversation; the event only gets a metadata link to that row.
      perform public.send_steward_reply(candidate.rtarget, clean_body);
      select m.id::text into message_id
      from public.member_messages m
      where m.conversation_id = candidate.rtarget and m.sender_kind = 'steward'
        and m.sender_id = caller and m.body = clean_body
        and m.created_at = pg_catalog.transaction_timestamp()
      order by m.id desc limit 1;
      if message_id is not null then
        insert into private.member_event_contact_links (message_id, event_id, organizer_id, participant_id, sender_role)
        values (message_id::uuid, ev.id, caller, rcpt, 'organizer');
      end if;
    elsif candidate.rvia = 'event_participant_start' then
      -- The ordinary member -> roster steward writer creates or reuses the
      -- steward-bound conversation and delivers the words into member_messages.
      sent_result := public.start_member_steward_conversation(rcpt, clean_body);
      message_id := sent_result ->> 'messageId';
      if message_id is not null then
        insert into private.member_event_contact_links (message_id, event_id, organizer_id, participant_id, sender_role)
        values (message_id::uuid, ev.id, ev.organizer_id, caller, 'participant');
      end if;
    elsif candidate.rvia = 'event_participant' then
      sent_result := public.send_member_message(candidate.rtarget, clean_body);
      message_id := sent_result ->> 'messageId';
      if message_id is not null then
        insert into private.member_event_contact_links (message_id, event_id, organizer_id, participant_id, sender_role)
        values (message_id::uuid, ev.id, ev.organizer_id, caller, 'participant');
      end if;
    end if;
    if message_id is null then
      perform private.cw_fail('recipient_unavailable', '22023', 'message was not confirmed', 'recipient_unavailable');
    end if;

    -- Content-free record: ids and a salted digest only, never the body.
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      caller_org, 'privacy', 'message.connected_send', 'send', caller,
      'message', message_id, ledger_key,
      pg_catalog.jsonb_build_object(
        'operation', 'connected_send', 'entityType', candidate.rvia, 'userId', rcpt::text,
        'sourceKind', p_kind, 'sourceId', norm_id, 'payloadDigest', digest));
    fresh := fresh + 1;
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recipientId', rcpt, 'via', candidate.rvia, 'messageId', message_id, 'replayed', false));
  end loop;

  return pg_catalog.jsonb_build_object(
    'sent', fresh, 'replayed', fresh = 0, 'results', results);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 13. Delivery of task/event reminders (error-isolated; own cron tick)
-- ---------------------------------------------------------------------------

create function private.dispatch_due_workflow_reminders(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  reminder record;
  src jsonb;
  delivered_count integer := 0;
  failed_count integer := 0;
  delivery_error boolean := false;
begin
  if p_limit not between 1 and 500 then
    raise exception 'invalid dispatch limit' using errcode = '22023';
  end if;
  begin
    for reminder in
      select pending.*
      from public.member_message_reminders pending
      where pending.status = 'scheduled'
        and pending.source_kind in ('task_item', 'event')
        and pending.remind_at <= pg_catalog.now()
      order by pending.remind_at, pending.id
      limit p_limit
      for update skip locked
    loop
      begin
        src := private.cw_resolve_source(
          reminder.owner_id, private.cw_reminder_api_kind(reminder.source_kind), reminder.source_ref);
        if not coalesce((src ->> 'ok')::boolean, false) or src ->> 'state' in ('cancelled', 'removed') then
          update public.member_message_reminders
          set status = 'failed', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
          where id = reminder.id;
          failed_count := failed_count + 1;
          continue;
        end if;
        insert into public.member_notifications (user_id, title, body, kind, message_reminder_id)
        values (reminder.owner_id, 'Reminder', 'Open your reminders to review it.', 'general', reminder.id)
        on conflict (message_reminder_id) do nothing;
        update public.member_message_reminders
        set status = 'delivered', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where id = reminder.id;
        delivered_count := delivered_count + 1;
      exception when others then
        -- Roll back only this reminder, preserving earlier successes and allowing
        -- later rows to run. Do not put source or notification content in logs.
        failed_count := failed_count + 1;
        delivery_error := true;
        raise warning 'workflow reminder delivery failed (%)', sqlstate;
        begin
          update public.member_message_reminders
          set status = 'failed', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
          where id = reminder.id;
        exception when others then
          -- A broken status write must not undo another reminder's delivery.
          null;
        end;
      end;
    end loop;
  exception when others then
    -- A delivery fault must never abort the surrounding cron transaction.
    raise warning 'workflow reminder dispatch failed (%)', sqlstate;
    return pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0, 'error', true);
  end;
  return pg_catalog.jsonb_build_object('delivered', delivered_count, 'failed', failed_count, 'error', delivery_error);
end;
end;
$function$;

revoke all on function private.dispatch_due_workflow_reminders(integer) from public, anon, authenticated, service_role;

-- Delivery rides the existing minute dispatcher job (already mirrored by the job
-- health desk) instead of adding a job. The workflow tick is error-isolated
-- (its handler swallows every fault), so it cannot abort the message dispatch it
-- follows in the same command.
do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  perform cron.alter_job(
    j.jobid,
    command := 'select private.dispatch_due_member_messaging(); select private.dispatch_due_workflow_reminders(200);')
  from cron.job j
  where j.jobname = 'member-messaging-dispatch';
end;
$cron$;

-- ---------------------------------------------------------------------------
-- 14. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.get_connected_workflow_context(text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_connected_workflow_recipients(text, text, text, integer, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_connected_workflow_task(text, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_connected_workflow_reminder(text, text, timestamptz, text, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_connected_workflow_reminders(text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.act_on_connected_workflow_reminder(uuid, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.send_connected_workflow_message(text, text, uuid[], text, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_member_event_organizer(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_member_event_organizer_candidates(text, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.set_member_event_contact_opt_in(text, boolean, uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_member_event_contact_messages(text, uuid, text, integer) from public, anon, authenticated, service_role;

grant execute on function public.get_connected_workflow_context(text, text, text, uuid) to authenticated;
grant execute on function public.list_connected_workflow_recipients(text, text, text, integer, text, uuid) to authenticated;
grant execute on function public.create_connected_workflow_task(text, text, text, uuid) to authenticated;
grant execute on function public.save_connected_workflow_reminder(text, text, timestamptz, text, text, uuid) to authenticated;
grant execute on function public.list_connected_workflow_reminders(text, integer, text) to authenticated;
grant execute on function public.act_on_connected_workflow_reminder(uuid, text, timestamptz) to authenticated;
grant execute on function public.send_connected_workflow_message(text, text, uuid[], text, uuid, text, uuid) to authenticated;
grant execute on function public.set_member_event_organizer(text, uuid) to authenticated;
grant execute on function public.list_member_event_organizer_candidates(text, text, integer) to authenticated;
grant execute on function public.set_member_event_contact_opt_in(text, boolean, uuid) to authenticated;
grant execute on function public.list_member_event_contact_messages(text, uuid, text, integer) to authenticated;

comment on function public.get_connected_workflow_context(text, text, text, uuid) is
  'Authorized, privacy-safe shortcut context for one exact record (message, channel post, task message, task, event): capabilities, source route, linked task, organizer and consent state. Refusal is uniform for missing, removed and unauthorized sources.';
comment on function public.send_connected_workflow_message(text, text, uuid[], text, uuid, text, uuid) is
  'All-or-nothing send to explicitly selected recipients re-derived from existing boundaries (task thread, peer, steward reply, roster steward) or the event organizer/participant contact, which is delivered through the existing private-message writers. Idempotent per (request id, recipient), bound to source and payload digest.';

notify pgrst, 'reload schema';

commit;
