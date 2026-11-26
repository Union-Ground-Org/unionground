-- REQ-UG-REMIND-HERE-20261001 and
-- REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001 (restore-everything).
--
-- ===========================================================================
-- 1. /remind here: a reminder to a channel's current staff
-- ===========================================================================
--
-- Old app: de7df4b57c^:supabase/migrations/0592_message_reminders.sql (kind
-- 'here', staff-only, channel the creator can post in),
-- de7df4b57c^:app/dashboard/messages/reminders-actions.ts (createReminder) and
-- de7df4b57c^:app/api/cron/message-reminders/_lib/reminder-dispatch.ts (the
-- channel's CURRENT staff resolved at fire time). It had no feature flag, so
-- features.messaging.remind_here starts ON.
--
-- A here reminder is a public.member_message_reminders row with the new
-- audience 'here' and the new source kind 'space' (source_ref = the
-- chapter_spaces id, the channel). It is NOT a second reminder table: it is
-- exported, cancelled and completed by its creator through the existing
-- reminder machinery, and deleted with the creator's account.
--
--   * Server authorization. public.create_channel_here_reminder is the only
--     writer. The caller needs an MFA-assured session, the channel's
--     organization switch on, the same "can post in this channel" standing the
--     chapter_thread_posts insert policy grants (selected chapter, readable
--     space), and chapter staff standing in that channel (old app: staff only).
--     Unknown, archived, other-chapter and unreadable channels give one answer.
--   * Delivery. private.dispatch_due_here_reminders rides the existing
--     member-messaging-dispatch minute job. At fire time it re-checks the
--     switch and the creator's standing, then resolves the channel's CURRENT
--     staff (chapter staff role, active organization and chapter membership,
--     staff two-step when the organization requires it, and read access to
--     the channel under its visibility rule), at most 200 people, and notifies
--     each once through private.notify_member with kind 'messages', the
--     channel topic REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001 adds in
--     20261003034000 (same restore train; this function only runs after every
--     migration has applied). That kind is outbound-eligible, so the existing
--     pipeline applies the recipient's topic preference ("Channel mentions"),
--     the hour/day/weekly caps, the outbound kill switch, the stress-ledger
--     egress guard, and quiet hours / Do not disturb at claim time.
--   * Body lifecycle. The note exists in exactly one row, the reminder. The
--     notification names the creator only ("{name} set a reminder for channel
--     staff"), never the channel, the note or any message. Recipients read the
--     note through public.list_channel_here_reminders, which re-checks their
--     current staff read access every time. private.channel_here_reminder_deliveries
--     is a metadata-only receipt (reminder, recipient, time, delivered or
--     suppressed outcome, and a reason code): no text.
--
-- ===========================================================================
-- 2. Steward email auto-routing
-- ===========================================================================
--
-- Old app: de7df4b57c^:lib/steward-email-intake/parser.ts and
-- de7df4b57c^:app/api/steward-email-intake/route.ts. A signed inbound email
-- that named a case number AND said "timeline", "case note" or "evidence"
-- became an INTERNAL note on that grievance; one tagged "#knowledge" (or
-- "knowledge base/article/library") became an UNPUBLISHED knowledge article.
-- Both ran whenever intake was on, and intake itself started off
-- (de7df4b57c^:supabase/migrations/0619_steward_email_intake.sql:8,
-- steward_email_intake_enabled = 'false'; no later migration changed it). So
-- both switches start OFF (: the old effective production
-- default).
--
-- public.ingest_steward_email keeps its signature, its envelope checks and its
-- replay control. After a NEW row is stored it calls
-- private.route_steward_email_intake, and only routes when every condition
-- holds; anything else stays in the manual claim/accept/reject queue with a
-- content-free hold code the queue shows:
--
--   * the organization switch for that route is on;
--   * the From address belongs to exactly one confirmed account
--     ('sender_unknown' otherwise);
--   * that account could review this intake by hand: steward or admin of the
--     intake chapter, active organization and chapter membership, staff
--     two-step when required ('sender_not_steward');
--   * for a case: the case number resolves to exactly one case IN THE INTAKE
--     CHAPTER ('case_not_found', 'case_ambiguous') and the sender can open that
--     case, restricted cases included ('case_access').
--
-- A routed case gets a staff-only attachment, not a member-visible case note:
-- the old note was internal, and public.member_case_updates is read by the
-- member. The email body is not copied; the case points at the intake row and
-- public.list_case_steward_emails shows it to staff who can open the case.
-- A knowledge item is always a DRAFT (status 'draft', no verifier); publishing
-- stays the existing reviewed save_chapter_kb_article step. Every route writes
-- organization_audit_ledger rows (no content) and a casework 'entity_linked'
-- event for a case. A routing fault never loses the email: it stays pending
-- with hold 'route_error'.
--
-- A From address alone never authenticates the sender. Automatic routing
-- requires an authenticated-sender result inside the signed relay envelope;
-- absent or failed results stay in manual review as sender_unverified.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $preconditions$
begin
  if pg_catalog.to_regprocedure('private.organization_feature_enabled(uuid, text)') is null then
    raise exception 'apply the feature switches and limits registry first (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001)'
      using errcode = '42883';
  end if;
end
$preconditions$;

-- The dispatch audit counts both delivered and preference-suppressed staff.
-- Keep the ledger's closed metadata vocabulary while adding these two
-- content-free counters.
alter table public.organization_audit_ledger
  drop constraint organization_audit_ledger_metadata_keys,
  add constraint organization_audit_ledger_metadata_keys
    check ((metadata - array['organizationId', 'chapterId', 'slug', 'name', 'role', 'userId', 'status', 'requireStaffMfa', 'entityType', 'entityId', 'fromStatus', 'toStatus', 'fromRole', 'toRole', 'action', 'eventType', 'domain', 'jobName', 'runId', 'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode', 'exportType', 'cadence', 'dataClass', 'retentionDays', 'eligibleCount', 'deletedCount', 'remainingCount', 'mode', 'executionEnabled', 'operation', 'reviewStatus', 'version', 'selfReview', 'payloadDigest', 'sourceId', 'sourceKind', 'deliveredCount', 'suppressedCount']::text[]) = '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- 0. Organization switches
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.messaging.remind_here', 'boolean', 'Channel staff reminders (/remind here)',
   'Chapter staff can type /remind here in a channel to remind everyone on the channel''s staff at a set time.',
   'true', null, null, null, 90, 'messaging', true),
  ('features.messaging.steward_email_auto_route_cases', 'boolean', 'Attach steward email to cases',
   'A signed steward email naming one case and saying timeline, case note or evidence is attached to that case for staff. Anything unclear stays in review.',
   'false', null, null, null, 100, 'messaging', false),
  ('features.messaging.steward_email_auto_route_knowledge', 'boolean', 'Steward email to knowledge drafts',
   'A signed steward email tagged #knowledge becomes an unpublished knowledge draft for staff review. It is never published automatically.',
   'false', null, null, null, 110, 'messaging', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Here reminders on public.member_message_reminders
-- ---------------------------------------------------------------------------

alter table public.member_message_reminders
  add column audience text not null default 'me';

alter table public.member_message_reminders
  drop constraint member_message_reminders_source_kind_check,
  drop constraint member_message_reminders_one_source,
  drop constraint member_message_reminders_status_by_kind;

alter table public.member_message_reminders
  add constraint member_message_reminders_audience_check
    check (audience in ('me', 'here')),
  add constraint member_message_reminders_source_kind_check
    check (source_kind in ('private', 'channel', 'task', 'task_item', 'event', 'space')),
  add constraint member_message_reminders_one_source check (
    (source_kind = 'private' and private_message_id is not null and channel_post_id is null and task_message_id is null and source_ref is null)
    or (source_kind = 'channel' and private_message_id is null and channel_post_id is not null and task_message_id is null and source_ref is null)
    or (source_kind = 'task' and private_message_id is null and channel_post_id is null and task_message_id is not null and source_ref is null)
    or (source_kind in ('task_item', 'event', 'space') and private_message_id is null and channel_post_id is null and task_message_id is null
        and source_ref is not null and pg_catalog.char_length(source_ref) between 1 and 200)
  ),
  add constraint member_message_reminders_status_by_kind check (
    case when source_kind in ('task_item', 'event', 'space') then status <> 'pending' else status <> 'scheduled' end
  ),
  -- A here reminder is exactly a channel reminder with a note, and nothing
  -- else is addressed to the channel's staff.
  add constraint member_message_reminders_here_shape check (
    (audience = 'here') = (source_kind = 'space')
    and (audience = 'me' or pg_catalog.char_length(pg_catalog.btrim(note)) between 1 and 500)
  );

create index member_message_reminders_here_source_idx
  on public.member_message_reminders (owner_id, source_ref, remind_at)
  where audience = 'here';

comment on column public.member_message_reminders.audience is
  'me = only the owner is reminded. here = the current staff of the channel named by source_ref (source_kind space) are reminded at remind_at (REQ-UG-REMIND-HERE-20261001). The note lives only in this row.';

-- Metadata-only delivery receipt: which reminder reached which staff member,
-- and when. No text. The recipient read re-authorizes against the channel on
-- every call; this row only says the person was on the channel's staff at
-- fire time.
create table private.channel_here_reminder_deliveries (
  reminder_id uuid not null
    references public.member_message_reminders(id) on delete cascade,
  recipient_id uuid not null
    references auth.users(id) on delete cascade,
  delivered_at timestamptz not null default pg_catalog.now(),
  delivery_status text not null default 'delivered'
    check (delivery_status in ('delivered', 'suppressed')),
  suppression_reason text,
  constraint channel_here_reminder_suppression_shape check (
    (delivery_status = 'delivered' and suppression_reason is null)
    or (delivery_status = 'suppressed' and suppression_reason is not null)
  ),
  primary key (reminder_id, recipient_id)
);

create index channel_here_reminder_deliveries_recipient_idx
  on private.channel_here_reminder_deliveries (recipient_id, delivered_at desc);

alter table private.channel_here_reminder_deliveries enable row level security;
alter table private.channel_here_reminder_deliveries force row level security;
revoke all on table private.channel_here_reminder_deliveries from public, anon, authenticated, service_role;

comment on table private.channel_here_reminder_deliveries is
  'Metadata-only per-recipient outcome for a /remind here reminder: delivered or suppressed by the shared channel preference decision. No note or message text. Removed with the reminder or recipient account; only delivered rows are readable through list_channel_here_reminders after a fresh access check.';

create trigger a00_case_graph_lock before insert or update or delete on private.channel_here_reminder_deliveries
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.channel_here_reminder_deliveries
for each row execute function private.lock_case_graph_row_keys('{recipient_id}', '');

insert into private.notification_copy (key, lang, title, body) values
  ('reminder.here', 'en', '{name} set a reminder for channel staff', 'Open Messages, then Reminders, to read it.'),
  ('reminder.here', 'es', '{name} dejó un recordatorio para el equipo del canal', 'Abre Mensajes y luego Recordatorios para leerlo.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- Can THIS person act as staff of THIS channel right now? Explicit-actor form
-- of member_has_chapter_role(...staff roles) AND private.can_read_chapter_space
-- for a background job and a creator check alike: active organization and
-- chapter membership, a staff role from an organization grant or a chapter
-- grant, staff two-step when the organization requires it, and the channel's
-- visibility rule (a private channel still needs its own membership).
create function private.remind_here_staff_reads_space(p_user_id uuid, p_space_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user_id is not null and exists (
    select 1
    from public.chapter_spaces s
    join public.chapters c on c.id = s.chapter_id
    join public.organizations o on o.id = c.organization_id and o.status = 'active'
    join public.organization_memberships om
      on om.organization_id = c.organization_id and om.user_id = p_user_id and om.status = 'active'
    join public.member_chapter_memberships cm
      on cm.chapter_id = s.chapter_id and cm.user_id = p_user_id and cm.status = 'active'
    where s.id = p_space_id
      and s.archived_at is null
      and (
        exists (
          select 1 from public.organization_role_grants g
          where g.organization_id = c.organization_id and g.user_id = p_user_id
            and g.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
        )
        or exists (
          select 1 from public.member_role_chapters rc
          where rc.user_id = p_user_id and rc.chapter_id = s.chapter_id
            and rc.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
        )
      )
      and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor(p_user_id))
      and (
        s.visibility in ('chapter', 'staff')
        or s.created_by = p_user_id
        or exists (
          select 1 from public.chapter_space_members sm
          where sm.space_id = s.id and sm.user_id = p_user_id
        )
      )
  );
$function$;

revoke all on function private.remind_here_staff_reads_space(uuid, uuid) from public, anon, authenticated, service_role;

create function public.create_channel_here_reminder(p_space_id uuid, p_remind_at timestamptz, p_note text)
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

-- Fire due here reminders. Error-isolated like dispatch_due_workflow_reminders:
-- one reminder's fault rolls back only that reminder and never aborts the
-- dispatch job it shares a command with.
create function private.dispatch_due_here_reminders(p_limit integer default 100)
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
  reminder record;
  target_space uuid;
  space_chapter text;
  org uuid;
  author_name text;
  recipient uuid;
  preference_decision text;
  reached integer;
  suppressed integer;
  delivered_count integer := 0;
  failed_count integer := 0;
  delivery_error boolean := false;
begin
  if p_limit not between 1 and 500 then
    raise exception 'invalid dispatch limit' using errcode = '22023';
  end if;
  begin
    for reminder in
      select due.*
      from public.member_message_reminders due
      where due.status = 'scheduled'
        and due.audience = 'here'
        and due.source_kind = 'space'
        and due.remind_at <= pg_catalog.now()
      order by due.remind_at, due.id
      limit p_limit
      for update skip locked
    loop
      begin
        target_space := case
          when reminder.source_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then reminder.source_ref::uuid end;
        select s.chapter_id, c.organization_id into space_chapter, org
        from public.chapter_spaces s
        join public.chapters c on c.id = s.chapter_id
        where s.id = target_space and s.archived_at is null;
        -- The switch and the creator's standing are re-checked at fire time:
        -- a creator who left the channel's staff no longer reaches it.
        if org is null
           or not private.organization_feature_enabled(org, 'features.messaging.remind_here')
           or not private.remind_here_staff_reads_space(reminder.owner_id, target_space) then
          update public.member_message_reminders
          set status = 'failed', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
          where id = reminder.id;
          failed_count := failed_count + 1;
          continue;
        end if;

        select coalesce(nullif(pg_catalog.btrim(p.full_name), ''), 'A steward') into author_name
        from public.member_profiles p where p.id = reminder.owner_id;
        author_name := coalesce(author_name, 'A steward');

        reached := 0;
        suppressed := 0;
        for recipient in
          select candidate.user_id
          from (
            select g.user_id from public.organization_role_grants g
            where g.organization_id = org
              and g.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
            union
            select rc.user_id from public.member_role_chapters rc
            where rc.chapter_id = space_chapter
              and rc.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
          ) candidate
          where private.remind_here_staff_reads_space(candidate.user_id, target_space)
          order by candidate.user_id
          limit 200
        loop
          preference_decision := private.channel_alert_decision(org, target_space, recipient, 'here');
          insert into private.channel_here_reminder_deliveries
            (reminder_id, recipient_id, delivery_status, suppression_reason)
          values (reminder.id, recipient,
            case when preference_decision = 'deliver' then 'delivered' else 'suppressed' end,
            case when preference_decision = 'deliver' then null else preference_decision end)
          on conflict (reminder_id, recipient_id) do nothing;
          if found then
            if preference_decision = 'deliver' then
              perform private.notify_member(
                recipient, 'reminder.here',
                pg_catalog.jsonb_build_object('name', author_name), 'messages');
              reached := reached + 1;
            else
              suppressed := suppressed + 1;
            end if;
          end if;
        end loop;

        update public.member_message_reminders
        set status = 'delivered', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where id = reminder.id;

        insert into public.organization_audit_ledger (
          organization_id, domain, event_type, action, actor_user_id,
          entity_type, entity_id, idempotency_key, metadata
        ) values (
          org, 'messages', 'message.remind_here.delivered', 'send', reminder.owner_id,
          'message', reminder.id::text, extensions.gen_random_uuid(),
          pg_catalog.jsonb_build_object('sourceKind', 'space', 'sourceId', target_space::text,
            'deliveredCount', reached, 'suppressedCount', suppressed)
        );
        delivered_count := delivered_count + 1;
      exception when others then
        failed_count := failed_count + 1;
        delivery_error := true;
        raise warning 'here reminder delivery failed (%)', sqlstate;
        begin
          update public.member_message_reminders
          set status = 'failed', delivered_at = pg_catalog.now(), updated_at = pg_catalog.now()
          where id = reminder.id;
        exception when others then
          null;
        end;
      end;
    end loop;
  exception when others then
    raise warning 'here reminder dispatch failed (%)', sqlstate;
    return pg_catalog.jsonb_build_object('delivered', 0, 'failed', 0, 'error', true);
  end;
  return pg_catalog.jsonb_build_object('delivered', delivered_count, 'failed', failed_count, 'error', delivery_error);
end;
end;
end;
$function$;

-- Reminders that reached the caller as channel staff in the last 30 days,
-- each re-authorized now: a person who left the channel's staff, lost the
-- channel, or lost the organization sees nothing. A reminder its creator
-- cancelled is withdrawn.
create function public.list_channel_here_reminders(p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', item.id,
      'note', item.note,
      'remindAt', item.remind_at,
      'deliveredAt', item.delivered_at,
      'spaceId', item.space_id,
      'spaceName', item.space_name,
      'authorName', item.author_name,
      'mine', item.mine
    ) order by item.delivered_at desc, item.id)
    from (
      select r.id, r.note, r.remind_at, d.delivered_at, s.id as space_id, s.name as space_name,
        coalesce(nullif(pg_catalog.btrim(p.full_name), ''), 'A steward') as author_name,
        r.owner_id = caller as mine
      from private.channel_here_reminder_deliveries d
      join public.member_message_reminders r on r.id = d.reminder_id
      join public.chapter_spaces s on s.id::text = r.source_ref
      left join public.member_profiles p on p.id = r.owner_id
      where d.recipient_id = caller
        and d.delivery_status = 'delivered'
        and d.delivered_at > pg_catalog.now() - interval '30 days'
        and r.audience = 'here'
        and r.status in ('delivered', 'completed')
        and private.remind_here_staff_reads_space(caller, s.id)
      order by d.delivered_at desc, r.id
      limit lim
    ) item
  ), '[]'::jsonb);
end;
$function$;

-- The owner's reminder list (list/act_on_connected_workflow_reminder) shows a
-- here reminder as a channel reminder the owner can complete or cancel. It
-- has no single message to open and no snooze; the clients offer neither.
create or replace function private.cw_reminder_api_kind(p_storage_kind text)
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
    when 'event' then 'event'
    when 'space' then 'channel_here' end;
$function$;

create or replace function private.cw_reminder_json(p_row public.member_message_reminders, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  api_kind text := private.cw_reminder_api_kind(p_row.source_kind);
  source_id text := private.cw_reminder_source_id(p_row);
  src jsonb;
  -- Exact tenant membership: no active chapter+organization membership, no source.
  available boolean;
  route text := null;
  channel_name text := null;
begin
  if p_row.source_kind = 'space' then
    -- A here reminder's source is its channel, re-authorized for the owner.
    select s.name into channel_name
    from public.chapter_spaces s
    where s.id::text = source_id
      and private.remind_here_staff_reads_space(p_actor, s.id);
    available := channel_name is not null and private.current_member_organization() is not null;
    return pg_catalog.jsonb_build_object(
      'id', p_row.id,
      'kind', api_kind,
      'audience', 'here',
      'sourceId', case when available then source_id end,
      'remindAt', p_row.remind_at,
      'note', p_row.note,
      'status', p_row.status,
      'snoozeCount', p_row.snooze_count,
      'completedAt', p_row.completed_at,
      'createdAt', p_row.created_at,
      'updatedAt', coalesce(p_row.updated_at, p_row.created_at),
      'available', available,
      'sourceState', case when available then 'available' else 'unavailable' end,
      'href', null,
      'title', case when available then channel_name end);
  end if;
  src := private.cw_resolve_source(p_actor, api_kind, source_id);
  available := coalesce((src ->> 'ok')::boolean, false)
    and private.current_member_organization() is not null;
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

revoke all on function public.create_channel_here_reminder(uuid, timestamptz, text) from public, anon, authenticated, service_role;
revoke all on function private.dispatch_due_here_reminders(integer) from public, anon, authenticated, service_role;
revoke all on function public.list_channel_here_reminders(integer) from public, anon, authenticated, service_role;
revoke all on function private.cw_reminder_api_kind(text) from public, anon, authenticated, service_role;
revoke all on function private.cw_reminder_json(public.member_message_reminders, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_channel_here_reminder(uuid, timestamptz, text) to authenticated;
grant execute on function public.list_channel_here_reminders(integer) to authenticated;

-- Delivery rides the existing minute dispatcher job. The command keeps every
-- earlier step, including 20261003031000's error-isolated welcome automation
-- tick (same restore train), and appends the here-reminder delivery.
do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  perform cron.alter_job(
    j.jobid,
    command := 'select private.dispatch_due_member_messaging(); select private.dispatch_due_workflow_reminders(200); select private.run_welcome_automation(50); select private.dispatch_due_here_reminders(200);')
  from cron.job j
  where j.jobname = 'member-messaging-dispatch';
end;
$cron$;

-- ---------------------------------------------------------------------------
-- 2. Steward email auto-routing
-- ---------------------------------------------------------------------------

alter table public.steward_email_intakes
  add column sender_authenticated boolean not null default false,
  add column auto_routed_at timestamptz,
  add column routed_case_id uuid references public.member_cases(id) on delete set null,
  add column knowledge_article_id uuid references public.member_kb_articles(id) on delete set null,
  add column auto_route_hold text,
  add constraint steward_email_intakes_auto_route_hold_check check (
    auto_route_hold is null or auto_route_hold in (
      'sender_unverified', 'sender_unknown', 'sender_not_steward', 'case_not_found', 'case_ambiguous',
      'case_access', 'route_error'))
  ;

-- The row-key gate names every identity column of the table, and now the
-- member_cases key too, so an attachment write coordinates on its case.
drop trigger z99_case_graph_keys on public.steward_email_intakes;
create trigger z99_case_graph_keys before insert or update or delete on public.steward_email_intakes
for each row execute function private.lock_case_graph_row_keys('{reviewed_by}', '{routed_case_id}');

create index steward_email_intakes_routed_case_idx
  on public.steward_email_intakes (routed_case_id) where routed_case_id is not null;
create index steward_email_intakes_knowledge_article_idx
  on public.steward_email_intakes (knowledge_article_id) where knowledge_article_id is not null;

comment on column public.steward_email_intakes.routed_case_id is
  'Case this email was attached to by automatic routing (REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001). Staff-only: read through public.list_case_steward_emails. The body is not copied.';
comment on column public.steward_email_intakes.auto_route_hold is
  'Why a routing request stayed in the manual queue. A code only; never content.';

-- The old parser's normalizeBody: quoted reply lines ("> ...") are not the
-- forwarding steward's words, so they neither trigger a route nor become a
-- draft.
create function private.steward_email_unquoted_body(p_body text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(coalesce(p_body, ''), '^>[^\n]*(\n|$)', '', 'gn'),
    '\n{3,}', pg_catalog.repeat(pg_catalog.chr(10), 2), 'g'),
    ' ' || pg_catalog.chr(9) || pg_catalog.chr(13) || pg_catalog.chr(10));
$function$;

-- Case numbers: the old pattern 20YY-NNN..NNNNN, with or without today's
-- "GR-" prefix, and the form-created GR-YYYY-F<8 hex> references.
create function private.steward_email_case_tokens(p_text text)
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select coalesce(pg_catalog.array_agg(distinct m[1] order by m[1]), array[]::text[])
  from pg_catalog.regexp_matches(
    pg_catalog.upper(coalesce(p_text, '')),
    '(?:^|[^A-Z0-9])(?:GR-)?(20[0-9]{2}-(?:F[0-9A-F]{8}|[0-9]{3,5}))(?![0-9A-Z])',
    'g') as m;
$function$;

-- The person who could review this intake by hand, for an explicit account:
-- steward or admin of the intake chapter with active organization and chapter
-- membership, and staff two-step when the organization requires it.
create function private.steward_email_sender_reviews_chapter(p_user_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_user_id is not null and exists (
    select 1
    from public.chapters c
    join public.organizations o on o.id = c.organization_id and o.status = 'active'
    join public.organization_memberships om
      on om.organization_id = c.organization_id and om.user_id = p_user_id and om.status = 'active'
    join public.member_chapter_memberships cm
      on cm.chapter_id = c.id and cm.user_id = p_user_id and cm.status = 'active'
    where c.id = p_chapter_id
      and (
        exists (
          select 1 from public.organization_role_grants g
          where g.organization_id = c.organization_id and g.user_id = p_user_id
            and g.role in ('steward', 'admin')
        )
        or exists (
          select 1 from public.member_role_chapters rc
          where rc.user_id = p_user_id and rc.chapter_id = c.id
            and rc.role in ('steward', 'admin')
        )
      )
      and (not private.staff_mfa_required(c.organization_id) or private.has_second_factor(p_user_id))
  );
$function$;

create function private.route_steward_email_intake(p_intake_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  intake public.steward_email_intakes%rowtype;
  org uuid;
  unquoted text;
  scan text;
  tokens text[];
  references_wanted text[];
  want_case boolean;
  want_knowledge boolean;
  sender uuid;
  sender_count integer;
  case_count integer;
  target_case public.member_cases%rowtype;
  new_article uuid;
  new_title text;
  new_ref text;
  hold text := null;
begin
  select * into intake from public.steward_email_intakes where id = p_intake_id for update;
  if not found or intake.status <> 'pending' or intake.auto_routed_at is not null then
    return pg_catalog.jsonb_build_object('routed', false);
  end if;
  select c.organization_id into org from public.chapters c where c.id = intake.chapter_id;
  if org is null then
    return pg_catalog.jsonb_build_object('routed', false);
  end if;
  if not intake.sender_authenticated then
    update public.steward_email_intakes
    set auto_route_hold = 'sender_unverified' where id = intake.id;
    return pg_catalog.jsonb_build_object('routed', false, 'hold', 'sender_unverified');
  end if;

  unquoted := private.steward_email_unquoted_body(intake.body_text);
  scan := intake.subject || pg_catalog.chr(10) || unquoted;
  tokens := private.steward_email_case_tokens(scan);
  want_case := private.organization_feature_enabled(org, 'features.messaging.steward_email_auto_route_cases')
    and pg_catalog.cardinality(tokens) > 0
    and scan ~* '\m(timeline|case\s*note|evidence)\M';
  want_knowledge := private.organization_feature_enabled(org, 'features.messaging.steward_email_auto_route_knowledge')
    and scan ~* '((^|\s)#knowledge\M|\mknowledge\s*(base|article|library)\M)';
  if not want_case and not want_knowledge then
    return pg_catalog.jsonb_build_object('routed', false);
  end if;

  select pg_catalog.count(*)::integer, (pg_catalog.array_agg(u.id))[1] into sender_count, sender
  from auth.users u
  where pg_catalog.lower(u.email) = intake.from_address
    and u.email_confirmed_at is not null
    and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.now());
  if sender_count <> 1 then
    hold := 'sender_unknown';
  elsif not private.steward_email_sender_reviews_chapter(sender, intake.chapter_id) then
    hold := 'sender_not_steward';
  end if;

  if hold is null and want_case then
    select pg_catalog.array_agg(distinct candidate) into references_wanted
    from (
      select token as candidate from pg_catalog.unnest(tokens) token
      union
      select 'GR-' || token from pg_catalog.unnest(tokens) token
    ) refs;
    select pg_catalog.count(*)::integer into case_count
    from public.member_cases mc
    where mc.chapter_id = intake.chapter_id
      and pg_catalog.upper(mc.reference) = any(references_wanted);
    if case_count = 0 then
      hold := 'case_not_found';
    elsif case_count > 1 then
      hold := 'case_ambiguous';
    else
      select mc.* into target_case
      from public.member_cases mc
      where mc.chapter_id = intake.chapter_id
        and pg_catalog.upper(mc.reference) = any(references_wanted);
      if target_case.organization_id is distinct from org
         or not private.casework_reminder_owner_can_read(sender, target_case.id)
         or target_case.user_id = sender then
        hold := 'case_access';
      end if;
    end if;
  end if;

  if hold is not null then
    update public.steward_email_intakes set auto_route_hold = hold where id = intake.id;
    return pg_catalog.jsonb_build_object('routed', false, 'hold', hold);
  end if;

  if want_case then
    perform private.lock_case_graph(array[sender], array[target_case.id]);
    update public.steward_email_intakes set routed_case_id = target_case.id where id = intake.id;
    insert into public.casework_audit_events (
      organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
    values (
      target_case.organization_id, target_case.chapter_id, target_case.id, sender,
      'entity_linked', 'steward_email', intake.id,
      pg_catalog.jsonb_build_object('source', 'steward_email', 'automatic', true));
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'casework', 'casework.steward_email_attached', 'create', sender,
      'case', target_case.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('sourceKind', 'steward_email', 'sourceId', intake.id::text, 'outcome', 'routed'));
  end if;

  if want_knowledge then
    new_article := extensions.gen_random_uuid();
    new_title := pg_catalog.left(coalesce(nullif(intake.subject, ''),
      'Steward email ' || pg_catalog.to_char(intake.received_at at time zone 'UTC', 'YYYY-MM-DD')), 200);
    new_ref := 'Steward email ' || pg_catalog.to_char(intake.received_at at time zone 'UTC', 'YYYY-MM-DD');
    -- Always a draft: no verifier, no verification time, status 'draft'.
    -- Staff-typed text with no Storage provenance, so 'authored'.
    insert into public.member_kb_articles (
      id, slug, kind, title, article_ref, body, keywords, order_index,
      chapter_id, status, is_sample, version, created_by, updated_by,
      verified_by, verified_at, updated_at, content_origin
    )
    select
      new_article,
      'chapter-kb-' || pg_catalog.replace(new_article::text, '-', ''),
      'faq', new_title, new_ref,
      coalesce(nullif(unquoted, ''), intake.body_text),
      array['email-intake']::text[],
      coalesce(pg_catalog.max(article.order_index), 0) + 1,
      intake.chapter_id, 'draft', false, 1, sender, sender,
      null, null, pg_catalog.now(), 'authored'
    from public.member_kb_articles article
    where article.chapter_id = intake.chapter_id;
    insert into public.member_kb_article_revisions (
      article_id, chapter_id, version, status, kind, title, article_ref, body,
      keywords, changed_by, verified_by, verified_at, content_origin, knowledge_source_id
    )
    select a.id, a.chapter_id, a.version, a.status, a.kind, a.title, a.article_ref, a.body,
      a.keywords, sender, null, null, a.content_origin, null
    from public.member_kb_articles a where a.id = new_article;
    update public.steward_email_intakes set knowledge_article_id = new_article where id = intake.id;
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'knowledge', 'knowledge.steward_email_draft_created', 'create', sender,
      'document', new_article::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('sourceKind', 'steward_email', 'sourceId', intake.id::text,
        'reviewStatus', 'draft', 'outcome', 'routed'));
  end if;

  update public.steward_email_intakes
  set status = 'accepted', reviewed_at = pg_catalog.now(), auto_routed_at = pg_catalog.now(),
      auto_route_hold = null
  where id = intake.id;
  return pg_catalog.jsonb_build_object('routed', true, 'case', want_case, 'knowledge', want_knowledge);
end;
end;
$function$;

-- 20260812201000's ingest, as installed (with the 20260907151000 case-graph
-- entry), plus the routing call for a newly stored row. A routing fault never
-- loses the email: the row stays pending with hold 'route_error'.
create or replace function public.ingest_steward_email(p_provider_message_digest text, p_chapter_id text, p_from_address text, p_subject text, p_body_text text, p_received_at timestamp with time zone)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  inserted boolean;
  new_id uuid;
  clean_address text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_from_address, '')));
  clean_subject text := pg_catalog.btrim(coalesce(p_subject, ''));
  clean_body text := pg_catalog.btrim(coalesce(p_body_text, ''));
begin
  if (select auth.jwt() ->> 'role') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_provider_message_digest is null or p_provider_message_digest !~ '^[a-f0-9]{64}$'
     or p_chapter_id is null or p_chapter_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or pg_catalog.char_length(clean_address) not between 3 and 320
     or clean_address !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     or pg_catalog.char_length(clean_subject) > 500
     or pg_catalog.char_length(clean_body) not between 1 and 60000
     or p_received_at is null
     or p_received_at > now() + interval '5 minutes' then
    raise exception 'invalid intake envelope' using errcode = '22023';
  end if;
  if not exists (select 1 from public.chapters chapter where chapter.id = p_chapter_id) then
    raise exception 'unknown chapter' using errcode = '22023';
  end if;

  insert into public.steward_email_intakes(
    provider_message_digest, chapter_id, from_address, subject, body_text, received_at)
  values (
    p_provider_message_digest, p_chapter_id, clean_address, clean_subject, clean_body, p_received_at)
  on conflict (provider_message_digest) do nothing
  returning id into new_id;
  inserted := new_id is not null;

  if inserted then
    begin
      perform private.route_steward_email_intake(new_id);
    exception
      when query_canceled then
        raise;
      when others then
        raise warning 'steward email routing failed (%)', sqlstate;
        update public.steward_email_intakes set auto_route_hold = 'route_error' where id = new_id;
    end;
  end if;

  return pg_catalog.jsonb_build_object(
    'accepted', true,
    'duplicate', not inserted
  );
end;
end;
$function$;

-- The relay can opt into automatic routing only by signing authentication
-- results in the envelope. The six-argument legacy intake remains a manual
-- queue path; it cannot invent sender authentication from a From address.
create function public.ingest_steward_email(
  p_provider_message_digest text, p_chapter_id text, p_from_address text,
  p_subject text, p_body_text text, p_received_at timestamp with time zone,
  p_sender_authenticated boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  result jsonb;
  intake_id uuid;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  result := public.ingest_steward_email(
    p_provider_message_digest, p_chapter_id, p_from_address, p_subject,
    p_body_text, p_received_at);
  if result->>'duplicate' = 'true' or p_sender_authenticated is distinct from true then
    return result;
  end if;
  update public.steward_email_intakes
  set sender_authenticated = true, auto_route_hold = null
  where provider_message_digest = p_provider_message_digest
    and status = 'pending' and auto_routed_at is null
  returning id into intake_id;
  if intake_id is not null then
    begin
      perform private.route_steward_email_intake(intake_id);
    exception when query_canceled then raise;
    when others then
      update public.steward_email_intakes
      set auto_route_hold = 'route_error' where id = intake_id;
    end;
  end if;
  return result;
end;
end;
$function$;

revoke all on function public.ingest_steward_email(text, text, text, text, text, timestamptz, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_steward_email(text, text, text, text, text, timestamptz, boolean)
  to service_role;

-- 20260812201000's review queue, unchanged in authorization, now saying what
-- automatic routing did: the case it attached (reference only when the
-- reader can open that case), the draft it created, or why it held back.
create or replace function public.list_steward_email_intakes(p_status text default 'pending'::text, p_limit integer default 50)
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
  if caller is null
     or not private.mfa_satisfied()
     or not public.member_has_role(array['steward','admin']) then
    raise exception 'MFA staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if not private.actor_has_chapter_staff_role(caller, caller_chapter) then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_status not in ('pending','reviewing','accepted','rejected','all')
     or p_limit not between 1 and 100 then
    raise exception 'invalid intake filter' using errcode = '22023';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', intake.id,
      'chapterId', intake.chapter_id,
      'from', intake.from_address,
      'subject', intake.subject,
      'text', intake.body_text,
      'receivedAt', intake.received_at,
      'status', intake.status,
      'reviewedBy', intake.reviewed_by,
      'reviewedAt', intake.reviewed_at,
      'autoRoutedAt', intake.auto_routed_at,
      'routeHold', intake.auto_route_hold,
      'routedCase', case when intake.routed_case_id is not null
          and private.casework_staff_can_access(intake.routed_case_id)
        then (select pg_catalog.jsonb_build_object('id', mc.id, 'reference', mc.reference)
              from public.member_cases mc where mc.id = intake.routed_case_id) end,
      'caseAttached', intake.routed_case_id is not null,
      'knowledgeDraft', intake.knowledge_article_id is not null
    ) order by intake.received_at desc, intake.id)
    from (
      select row.* from public.steward_email_intakes row
      where row.chapter_id = caller_chapter
        and (p_status = 'all' or row.status = p_status)
      order by row.received_at desc, row.id
      limit p_limit
    ) intake
  ), '[]'::jsonb);
end;
$function$;

-- Staff-only: the steward email attached to one case. The reader must be able
-- to open the case (casework staff access, restricted cases included) and
-- hold reviewer standing in the case's chapter; members never see it.
create function public.list_case_steward_emails(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_case_id is null or not private.casework_staff_can_access(p_case_id) then
    raise exception 'case not found' using errcode = 'P0002';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', intake.id,
      'from', intake.from_address,
      'subject', intake.subject,
      'text', intake.body_text,
      'receivedAt', intake.received_at,
      'autoRoutedAt', intake.auto_routed_at
    ) order by intake.received_at desc, intake.id)
    from (
      select row.* from public.steward_email_intakes row
      join public.member_cases mc on mc.id = row.routed_case_id and mc.chapter_id = row.chapter_id
      where row.routed_case_id = p_case_id
      order by row.received_at desc, row.id
      limit 50
    ) intake
  ), '[]'::jsonb);
end;
$function$;

revoke all on function private.steward_email_unquoted_body(text) from public, anon, authenticated, service_role;
revoke all on function private.steward_email_case_tokens(text) from public, anon, authenticated, service_role;
revoke all on function private.steward_email_sender_reviews_chapter(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.route_steward_email_intake(uuid) from public, anon, authenticated, service_role;
revoke all on function public.list_case_steward_emails(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_case_steward_emails(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Account lifecycle
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, export_projection_version, export_domain,
   export_columns, exclusion_reason, note, reviewed_at)
values
  ('private', 'channel_here_reminder_deliveries', 'recipient_id', 'cascade', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Delivery receipt of a reminder another staff member wrote; it holds no text, and the reminder itself is exported to its author under member_message_reminders.',
   'Installed action is ON DELETE CASCADE; the receipt leaves with the recipient account or the reminder.',
   date '2026-10-02');

update private.account_lifecycle_manifest
set export_columns = array['id','owner_id','source_kind','private_message_id','channel_post_id','task_message_id',
      'source_ref','audience','note','remind_at','status','snooze_count','completed_at','created_at','delivered_at','updated_at']::text[]
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
    'task_message_id', t.task_message_id, 'source_ref', t.source_ref, 'audience', t.audience,
    'note', t.note, 'remind_at', t.remind_at, 'status', t.status, 'snooze_count', t.snooze_count,
    'completed_at', t.completed_at, 'created_at', t.created_at,
    'delivered_at', t.delivered_at, 'updated_at', t.updated_at)), '[]'::jsonb)
  from public.member_message_reminders t where t.owner_id = p_caller;
$export$;

revoke all on function private.account_lifecycle_export_member_message_reminders(uuid) from public, anon, authenticated, service_role;

-- Trigger inventory: the receipt table's gates and the re-created intake
-- row-key gate. Nothing else on the trigger surface changes.
delete from private.account_lifecycle_trigger_review
where kind = 'trigger' and schema_name = 'public' and table_name = 'steward_email_intakes'
  and object_name = 'z99_case_graph_keys';

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger'
  and (
    (schema_name = 'private' and table_name = 'channel_here_reminder_deliveries'
      and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
    or (schema_name = 'public' and table_name = 'steward_email_intakes' and object_name = 'z99_case_graph_keys')
  )
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_l8_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after remind here and steward email routing: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after remind here and steward email routing';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after remind here and steward email routing';
  end if;
end;
$assert_l8_lifecycle$;

notify pgrst, 'reload schema';

commit;
