-- REQ-UG-MINUTES-PRE-EVENT-DISPATCH-20261001 (CR-077)
-- REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001 (CR-059)
-- REQ-UG-RETENTION-DEFAULT-POLICIES-20261001 (CR-104)
-- REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001 (CR-072)
--
-- Restore-everything campaign, lane L7b AUTOMATION-2. Four old automations
-- come back on the current architecture: organization and chapter scoping,
-- MFA-backed SECURITY DEFINER RPCs, the notification pipeline, the retention
-- engine and the W1-SETTINGS registry. Old app = git ref de7df4b57c^.
--
-- 1. Pre-meeting minutes notice. Old app/api/cron/minutes-dispatch/route.ts
--    (hourly) told a chosen audience N hours before an event that its minutes
--    and agenda were ready. Staff now attach a minutes record to one of the
--    chapter's upcoming meetings, choose the audience and (optionally) the
--    lead time; an hourly pg_cron sweep sends the notice through
--    private.notify_member with kind 'events', so member preferences, quiet
--    hours and the per-recipient caps apply. The publish-time notice of
--    20260830060000 is unchanged.
--      Audiences: all_members = every active member of the record's chapter,
--      the only people who can open a chapter record; stewards_only = the
--      chapter's staff hats. The old 'specific_unit' audience is NOT restored:
--      the product has no unit attribute inside a chapter and another
--      chapter's members cannot read this chapter's record (see the PR's
--      "Needs owner decision").
-- 2. Scheduled export parity. Export schedules (coordination record kind
--    network_export_schedule) may name a dataset: the old agency-exports
--    datasets members_directory, events, resources, knowledge_articles and
--    broadcast_log (lib/agency/exports.ts DATASET_COLUMNS) join
--    coordination_records. Column allowlists keep the old privacy rule:
--    the directory is name, role and chapter only, and it is admin/vp-only
--    exactly like the members domain of request_filtered_organization_export.
--    Email and SFTP runs no longer sit queued forever: api/organization-
--    exports.js claims them, emails the schedule owner a sign-in link (never
--    the data) when the operator has configured email, and otherwise records
--    the honest 'not_configured' state. This deployment has no SFTP transport.
-- 3. Retention default policies. Old lib/storage/data-retention-policy.ts
--    purged page views (60 days), notifications (365), AI assistant
--    conversations (180) and AI usage counters (30) by default. Those four
--    classes now carry the old window and execute by default: the nightly
--    scheduler records a policy row for an organization the first time one
--    of them has something eligible, so an organization with nothing to
--    delete gets no policy row and no run. Direct-message bodies keep
--    execution off until an administrator confirms (the "Message body
--    lifecycle contract"). Failed sign-ins keep their existing per-
--    organization setting (security.failed_login_retention_days, 90 days)
--    and gain a nightly sweep so records age out even when no new failure
--    arrives. Successful sign-in history is not stored by this product, so
--    there is nothing to retain.
-- 4. Trusted source health. Old cron/trusted-info-source-health rolled up
--    stale (>180 days), failed and pending sources every hour. An hourly
--    bounded pg_cron sweep now records the same roll-up per organization
--    and get_knowledge_source_health() shows it to knowledge staff.
--
-- Every switch and limit is registered in platform_setting_definitions, so it
-- appears on the admin Feature switches & limits page, and every one is
-- enforced on the server. Production stays empty: the only rows written are
-- platform definitions and notification copy.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Switches and limits
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old app/api/cron/minutes-dispatch/route.ts:2 ran hourly with no switch: on.
  ('features.automation.minutes_pre_event_notice', 'boolean', 'Pre-meeting minutes and agenda notice',
   'Tell the chosen audience a set number of hours before a meeting that its minutes or agenda are ready to review.',
   'true'::jsonb, null, null, null, 1650, 'automation', false),
  -- Old app/dashboard/events/events-client.tsx:1503 suggested 24 hours;
  -- old supabase/migrations/0106_events_minutes_share.sql:18 bounded 0..336.
  ('limits.automation.minutes_pre_event_hours', 'integer', 'Pre-meeting notice lead time (hours)',
   'Hours before a meeting starts when its pre-meeting notice is sent, unless staff choose a different lead time for that meeting.',
   '24'::jsonb, 1, 336, null, 1651, 'automation', false),
  -- Old supabase/migrations/0588_agency_oversight.sql:42 exports_enabled
  -- defaulted to false; coordination-record exports, which work today, are
  -- not behind this switch.
  ('features.automation.scheduled_dataset_exports', 'boolean', 'Scheduled directory, event, resource, article and broadcast exports',
   'Let export schedules produce the members directory, events, resources, knowledge articles and broadcast log as well as coordination records.',
   'false'::jsonb, null, null, null, 1652, 'automation', true),
  -- Old app/api/cron/trusted-info-source-health/route.ts:24 ran hourly with
  -- no switch: on.
  ('features.intelligence.trusted_source_health_check', 'boolean', 'Hourly trusted-source health check',
   'Check knowledge articles, library documents and ingested sources every hour for stale, failed and pending items, and show the result to knowledge staff.',
   'true'::jsonb, null, null, null, 1653, 'intelligence', false),
  -- Old supabase/migrations/0482_trusted_info_source_health.sql:92 used 180 days.
  ('limits.intelligence.trusted_source_stale_days', 'integer', 'Trusted source stale after (days)',
   'Days since a trusted source was last verified, updated or ingested before the health check counts it as stale.',
   '180'::jsonb, 30, 1095, null, 1654, 'intelligence', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. Pre-meeting minutes and agenda notice (CR-077)
-- ---------------------------------------------------------------------------

insert into private.notification_copy (key, lang, title, body) values
  ('institutional.minutes.pre_event', 'en', 'Meeting materials are ready',
   '{record} for {event} is ready to review before the meeting.'),
  ('institutional.minutes.pre_event', 'es', 'Los materiales de la reunión están listos',
   '{record} para {event} está listo para revisar antes de la reunión.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

create table private.meeting_minutes_event_notices (
  record_id uuid primary key
    references public.chapter_records(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  chapter_id text not null
    references public.chapters(id) on update cascade on delete restrict,
  event_id text not null
    references public.member_events(id) on delete cascade,
  -- Old 0106_events_minutes_share.sql:17 offered all_members, stewards_only,
  -- specific_unit and none (default). 'none' is the absence of a row here.
  audience text not null check (audience in ('all_members', 'stewards_only')),
  -- Null = the organization's limits.automation.minutes_pre_event_hours at
  -- send time. Old bound 0..336 (0106_events_minutes_share.sql:18).
  hours_before integer check (hours_before is null or hours_before between 1 and 336),
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'expired')),
  outcome text check (outcome is null or outcome in (
    'delivered', 'no_audience', 'event_started', 'event_cancelled',
    'record_not_published', 'record_archived', 'record_staff_only'
  )),
  recipient_count integer not null default 0 check (recipient_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  processed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint meeting_minutes_event_notices_processed check (
    (status = 'scheduled' and processed_at is null and outcome is null)
    or (status <> 'scheduled' and processed_at is not null and outcome is not null)
  )
);

create index meeting_minutes_event_notices_scheduled_idx
  on private.meeting_minutes_event_notices (event_id)
  where status = 'scheduled';
create index meeting_minutes_event_notices_chapter_idx
  on private.meeting_minutes_event_notices (chapter_id, updated_at desc);

comment on table private.meeting_minutes_event_notices is
  'REQ-UG-MINUTES-PRE-EVENT-DISPATCH-20261001: one pre-meeting notice per minutes record, bound to one meeting of the same chapter. No client grant; staff write through save_minutes_pre_event_notice and the hourly sweep sends it.';

alter table private.meeting_minutes_event_notices enable row level security;
alter table private.meeting_minutes_event_notices force row level security;
revoke all on table private.meeting_minutes_event_notices from public, anon, authenticated, service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.meeting_minutes_event_notices
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.meeting_minutes_event_notices
for each row execute function private.lock_case_graph_row_keys('', '');

create function private.minutes_pre_event_notice_json(p_notice private.meeting_minutes_event_notices)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'recordId', p_notice.record_id,
    'eventId', p_notice.event_id,
    'eventTitle', e.title,
    'eventStartsAt', e.starts_at,
    'audience', p_notice.audience,
    'hoursBefore', p_notice.hours_before,
    'status', p_notice.status,
    'outcome', p_notice.outcome,
    'recipientCount', p_notice.recipient_count,
    'failedCount', p_notice.failed_count,
    'processedAt', p_notice.processed_at,
    'updatedAt', p_notice.updated_at
  )
  from public.member_events e
  where e.id = p_notice.event_id;
$function$;

revoke all on function private.minutes_pre_event_notice_json(private.meeting_minutes_event_notices)
  from public, anon, authenticated, service_role;

-- Staff read: the chapter's notices, its upcoming meetings to attach one to,
-- and the organization's switch and default lead time.
create function public.get_minutes_pre_event_notices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  ctx record;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  return pg_catalog.jsonb_build_object(
    'enabled', private.organization_feature_enabled(ctx.organization_id, 'features.automation.minutes_pre_event_notice'),
    'defaultHours', private.organization_limit(ctx.organization_id, 'limits.automation.minutes_pre_event_hours'),
    'notices', coalesce((
      select pg_catalog.jsonb_agg(private.minutes_pre_event_notice_json(n) order by n.updated_at desc)
      from private.meeting_minutes_event_notices n
      where n.organization_id = ctx.organization_id and n.chapter_id = ctx.chapter_id
    ), '[]'::jsonb),
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', upcoming.id, 'title', upcoming.title, 'startsAt', upcoming.starts_at
      ) order by upcoming.starts_at, upcoming.id)
      from (
        select e.id, e.title, e.starts_at
        from public.member_events e
        where e.chapter_id = ctx.chapter_id
          and e.cancelled_at is null
          and e.starts_at > pg_catalog.now()
        order by e.starts_at, e.id
        limit 50
      ) upcoming
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_minutes_pre_event_notices() from public, anon, authenticated, service_role;
grant execute on function public.get_minutes_pre_event_notices() to authenticated;

create function public.save_minutes_pre_event_notice(
  p_record_id uuid,
  p_event_id text,
  p_audience text,
  p_hours_before integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  ctx record;
  target public.chapter_records%rowtype;
  meeting public.member_events%rowtype;
  existing private.meeting_minutes_event_notices%rowtype;
  saved private.meeting_minutes_event_notices%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  if not private.organization_feature_enabled(ctx.organization_id, 'features.automation.minutes_pre_event_notice') then
    raise exception 'pre-meeting notices are turned off for this organization' using errcode = '42501';
  end if;
  if p_audience is null or p_audience not in ('all_members', 'stewards_only')
     or (p_hours_before is not null and p_hours_before not between 1 and 336) then
    raise exception 'invalid pre-meeting notice' using errcode = '22023';
  end if;

  select * into target from public.chapter_records r
  where r.id = p_record_id and r.chapter_id = ctx.chapter_id
  for update;
  if target.id is null or target.record_type <> 'minutes' or target.archived_at is not null then
    raise exception 'minutes record not found' using errcode = 'P0002';
  end if;
  -- Members can only open a chapter-visible record, so a staff-only record can
  -- only be announced to staff.
  if p_audience = 'all_members' and target.visibility <> 'chapter' then
    raise exception 'a staff-only record can only be announced to stewards' using errcode = '22023';
  end if;

  select * into meeting from public.member_events e
  where e.id = p_event_id and e.chapter_id = ctx.chapter_id;
  if meeting.id is null or meeting.cancelled_at is not null or meeting.starts_at <= pg_catalog.now() then
    raise exception 'upcoming meeting not found' using errcode = 'P0002';
  end if;

  select * into existing from private.meeting_minutes_event_notices n
  where n.record_id = target.id
  for update;
  if existing.record_id is not null and existing.status = 'sent' and existing.event_id = meeting.id then
    raise exception 'this notice was already sent for that meeting' using errcode = '22023';
  end if;

  insert into private.meeting_minutes_event_notices (
    record_id, organization_id, chapter_id, event_id, audience, hours_before
  ) values (
    target.id, ctx.organization_id, ctx.chapter_id, meeting.id, p_audience, p_hours_before
  )
  on conflict (record_id) do update set
    event_id = excluded.event_id,
    audience = excluded.audience,
    hours_before = excluded.hours_before,
    status = 'scheduled',
    outcome = null,
    recipient_count = 0,
    failed_count = 0,
    processed_at = null,
    updated_at = pg_catalog.now()
  returning * into saved;

  return private.minutes_pre_event_notice_json(saved);
end;
end;
$function$;

revoke all on function public.save_minutes_pre_event_notice(uuid, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.save_minutes_pre_event_notice(uuid, text, text, integer) to authenticated;

create function public.clear_minutes_pre_event_notice(p_record_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  ctx record;
  removed integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);
  delete from private.meeting_minutes_event_notices n
  where n.record_id = p_record_id
    and n.organization_id = ctx.organization_id
    and n.chapter_id = ctx.chapter_id;
  get diagnostics removed = row_count;
  return pg_catalog.jsonb_build_object('recordId', p_record_id, 'removed', removed > 0);
end;
end;
$function$;

revoke all on function public.clear_minutes_pre_event_notice(uuid) from public, anon, authenticated, service_role;
grant execute on function public.clear_minutes_pre_event_notice(uuid) to authenticated;

-- Hourly, bounded, idempotent: a notice leaves 'scheduled' exactly once. A
-- notice whose record is not yet published, or whose organization has the
-- switch off, stays scheduled until the meeting starts and then expires with
-- the reason, so nothing is sent after a meeting began (the old route had no
-- such guard and would announce a past meeting).
create function private.dispatch_minutes_pre_event_notices(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  notice record;
  recipient record;
  processed integer := 0;
  sent integer;
  failed integer;
  reason text;
begin
  for notice in
    select n.record_id, n.organization_id, n.chapter_id, n.audience,
      e.title as event_title, e.starts_at, e.cancelled_at,
      r.title as record_title, r.lifecycle_status, r.visibility, r.archived_at,
      private.organization_feature_enabled(n.organization_id, 'features.automation.minutes_pre_event_notice') as enabled
    from private.meeting_minutes_event_notices n
    join public.member_events e on e.id = n.event_id
    join public.chapter_records r on r.id = n.record_id
    where n.status = 'scheduled'
      and (
        e.cancelled_at is not null
        or e.starts_at <= pg_catalog.now()
        or e.starts_at - pg_catalog.make_interval(hours => coalesce(
          n.hours_before,
          private.organization_limit(n.organization_id, 'limits.automation.minutes_pre_event_hours')
        )) <= pg_catalog.now()
      )
    order by e.starts_at, n.record_id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
    for update of n skip locked
  loop
    reason := case
      when notice.cancelled_at is not null then 'event_cancelled'
      when notice.archived_at is not null or notice.lifecycle_status = 'archived' then 'record_archived'
      when notice.starts_at <= pg_catalog.now() and notice.lifecycle_status <> 'published' then 'record_not_published'
      when notice.starts_at <= pg_catalog.now() then 'event_started'
      when notice.audience = 'all_members' and notice.visibility <> 'chapter' then 'record_staff_only'
    end;
    if reason is null and (not notice.enabled or notice.lifecycle_status <> 'published') then
      continue;
    end if;
    if reason is not null then
      update private.meeting_minutes_event_notices
        set status = 'expired', outcome = reason, processed_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where record_id = notice.record_id;
      processed := processed + 1;
      continue;
    end if;

    sent := 0;
    failed := 0;
    for recipient in
      select cm.user_id
      from public.member_chapter_memberships cm
      join public.organization_memberships om
        on om.user_id = cm.user_id
       and om.organization_id = notice.organization_id
       and om.status = 'active'
      where cm.chapter_id = notice.chapter_id
        and cm.status = 'active'
        and (notice.audience = 'all_members'
             or private.actor_has_chapter_staff_role(cm.user_id, notice.chapter_id))
    loop
      begin
        perform private.notify_member(
          recipient.user_id,
          'institutional.minutes.pre_event',
          pg_catalog.jsonb_build_object('record', notice.record_title, 'event', notice.event_title),
          'events'
        );
        sent := sent + 1;
      exception when others then
        failed := failed + 1;
      end;
    end loop;

    update private.meeting_minutes_event_notices
      set status = 'sent',
          outcome = case when sent + failed = 0 then 'no_audience' else 'delivered' end,
          recipient_count = sent,
          failed_count = failed,
          processed_at = pg_catalog.now(),
          updated_at = pg_catalog.now()
      where record_id = notice.record_id;
    processed := processed + 1;
  end loop;
  return processed;
end;
end;
$function$;

revoke all on function private.dispatch_minutes_pre_event_notices(integer) from public, anon, authenticated, service_role;

comment on function private.dispatch_minutes_pre_event_notices(integer) is
  'Bounded pg_cron target (minutes-pre-event-notices-tick): sends each due pre-meeting minutes notice once through private.notify_member(kind events) to the chapter audience that can read the record, or expires it with a reason once the meeting starts.';

-- ---------------------------------------------------------------------------
-- 2. Scheduled export parity (CR-059)
-- ---------------------------------------------------------------------------

alter table public.organization_coordination_export_runs
  add column dataset text not null default 'coordination_records',
  add column delivered_at timestamptz,
  add column delivery_note text,
  add column delivery_claimed_at timestamptz;

alter table public.organization_coordination_export_runs
  add constraint organization_coordination_export_runs_dataset_check check (dataset in (
    'coordination_records', 'members_directory', 'events', 'resources',
    'knowledge_articles', 'broadcast_log'
  )),
  add constraint organization_coordination_export_runs_delivery_note_check check (
    delivery_note is null or delivery_note in (
      'email_transport_unset', 'sftp_transport_unavailable', 'no_recipient',
      'email_send_failed', 'dataset_disabled'
    )
  );

alter table public.organization_coordination_export_runs
  drop constraint organization_coordination_export_runs_status_check;
alter table public.organization_coordination_export_runs
  add constraint organization_coordination_export_runs_status_check check (status in (
    'queued', 'running', 'ready', 'failed', 'expired',
    'delivered', 'not_configured', 'skipped'
  ));

create index organization_coordination_export_runs_delivery_idx
  on public.organization_coordination_export_runs (status, created_at, id)
  where delivery_mode in ('email_unset', 'sftp_unset') and status in ('queued', 'running');

comment on column public.organization_coordination_export_runs.dataset is
  'REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001: the dataset the run exports. Payloads are rebuilt for the authorized caller at download and never stored.';

create function private.organization_export_restored_dataset(p_dataset text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_dataset in ('members_directory', 'events', 'resources', 'knowledge_articles', 'broadcast_log');
$function$;

revoke all on function private.organization_export_restored_dataset(text) from public, anon, authenticated, service_role;

-- Which organization roles may receive or download a dataset. The directory
-- names people, so it follows the filtered export's members domain
-- (admin/vp); everything else follows the existing coordination export.
create function private.organization_export_dataset_roles(p_dataset text)
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select case when p_dataset = 'members_directory'
    then array['admin', 'vp']::text[]
    else array['coordinator', 'admin', 'vp']::text[] end;
$function$;

revoke all on function private.organization_export_dataset_roles(text) from public, anon, authenticated, service_role;

-- Column allowlists mirror the old lib/agency/exports.ts DATASET_COLUMNS,
-- mapped onto current tables, and never select a whole row. Bounded to 10000
-- rows like request_filtered_organization_export.
create function private.organization_export_dataset(p_organization_id uuid, p_dataset text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  result_columns text[];
  result_rows jsonb;
begin
  case p_dataset
    when 'coordination_records' then
      result_columns := array['id', 'kind', 'title', 'status', 'visibility', 'updated_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.kind, x.title, x.status, x.visibility, x.updated_at
      ) order by x.updated_at desc, x.id desc), '[]'::jsonb) into result_rows
      from (
        select record.id, record.kind, record.title, record.status, record.visibility, record.updated_at
        from public.organization_coordination_records record
        where record.organization_id = p_organization_id
          or exists (
            select 1
            from public.organization_coordination_organization_participants participant
            where participant.record_id = record.id
              and participant.organization_id = p_organization_id
              and participant.status = 'active'
          )
        order by record.updated_at desc, record.id desc
        limit 10000
      ) x;
    when 'members_directory' then
      -- Old DATASET_COLUMNS.members_directory: name, role and branch only. No
      -- email, phone, address or employee identifier.
      result_columns := array['name', 'role', 'chapter'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.full_name, x.role, x.chapter_name
      ) order by x.full_name, x.user_id), '[]'::jsonb) into result_rows
      from (
        select p.id as user_id, p.full_name,
          coalesce((
            select g.role from public.organization_role_grants g
            where g.organization_id = p_organization_id and g.user_id = p.id
            order by pg_catalog.array_position(array['vp','admin','coordinator','advisor','steward']::text[], g.role)
            limit 1
          ), 'member') as role,
          membership.chapter_name
        from public.organization_memberships om
        join public.member_profiles p on p.id = om.user_id
        join lateral (
          select c.name as chapter_name
          from public.member_chapter_memberships cm
          join public.chapters c on c.id = cm.chapter_id
          where cm.user_id = p.id and cm.status = 'active' and c.organization_id = p_organization_id
          order by (cm.chapter_id = p.chapter_id) desc, cm.chapter_id
          limit 1
        ) membership on true
        where om.organization_id = p_organization_id and om.status = 'active'
        order by p.full_name, p.id
        limit 10000
      ) x;
    when 'events' then
      -- check_in_code is a secret and never leaves the database.
      result_columns := array['id', 'title', 'starts_at', 'location', 'chapter', 'public', 'public_across_agencies', 'cancelled_at', 'created_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.starts_at, x.location, x.chapter_name, x.is_public,
        x.is_public_across_agencies, x.cancelled_at, x.created_at
      ) order by x.starts_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select e.id, e.title, e.starts_at, e.location, c.name as chapter_name, e.is_public,
          e.is_public_across_agencies, e.cancelled_at, e.created_at
        from public.member_events e
        join public.chapters c on c.id = e.chapter_id
        where c.organization_id = p_organization_id
        order by e.starts_at desc, e.id
        limit 10000
      ) x;
    when 'resources' then
      result_columns := array['id', 'title', 'category', 'summary', 'file_name', 'visibility', 'created_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.category, x.summary, x.file_name, x.visibility, x.created_at
      ) order by x.created_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select f.id, f.title, f.category, f.summary, f.file_name, f.visibility, f.created_at
        from public.organization_knowledge_files f
        where f.organization_id = p_organization_id
          and f.published_to_catalog
          and f.review_status = 'approved'
        order by f.created_at desc, f.id
        limit 10000
      ) x;
    when 'knowledge_articles' then
      result_columns := array['id', 'title', 'kind', 'reference', 'status', 'chapter', 'created_at', 'updated_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.kind, x.article_ref, x.status, x.chapter_name, x.created_at, x.updated_at
      ) order by x.updated_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select k.id, k.title, k.kind, k.article_ref, k.status, c.name as chapter_name, k.created_at, k.updated_at
        from public.member_kb_articles k
        join public.chapters c on c.id = k.chapter_id
        where c.organization_id = p_organization_id
          and not k.is_sample
          and k.status in ('draft', 'published')
          and k.content_origin <> 'unresolved'
        order by k.updated_at desc, k.id
        limit 10000
      ) x;
    when 'broadcast_log' then
      result_columns := array['id', 'title', 'sender', 'audience', 'chapter', 'published_at', 'retracted_at'];
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
        x.id, x.title, x.sender, x.audience_scope, x.chapter_name, x.published_at, x.retracted_at
      ) order by x.published_at desc, x.id), '[]'::jsonb) into result_rows
      from (
        select b.id, b.title, b.sender, b.audience_scope, c.name as chapter_name, b.published_at, b.retracted_at
        from public.member_broadcasts b
        left join public.chapters c on c.id = b.chapter_id
        where b.organization_id = p_organization_id
        order by b.published_at desc, b.id
        limit 10000
      ) x;
    else
      raise exception 'export dataset unavailable' using errcode = '22023';
  end case;
  return pg_catalog.jsonb_build_object('columns', pg_catalog.to_jsonb(result_columns), 'rows', result_rows);
end;
$function$;

revoke all on function private.organization_export_dataset(uuid, text) from public, anon, authenticated, service_role;

-- Schedules may name a dataset. Validated here instead of re-emitting the
-- whole coordination shape validator; config is still bounded by it.
create function private.validate_coordination_export_dataset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  chosen text;
begin
  if new.kind <> 'network_export_schedule' then
    return new;
  end if;
  if new.config ? 'dataset' and pg_catalog.jsonb_typeof(new.config -> 'dataset') <> 'string' then
    raise exception 'export dataset unavailable' using errcode = '23514';
  end if;
  chosen := coalesce(new.config ->> 'dataset', 'coordination_records');
  if chosen not in (
    'coordination_records', 'members_directory', 'events', 'resources',
    'knowledge_articles', 'broadcast_log'
  ) then
    raise exception 'export dataset unavailable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' or (old.config ->> 'dataset') is distinct from (new.config ->> 'dataset') then
    if private.organization_export_restored_dataset(chosen)
       and not private.organization_feature_enabled(new.organization_id, 'features.automation.scheduled_dataset_exports') then
      raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '23514';
    end if;
    if (select auth.uid()) is not null
       and not private.has_organization_role(new.organization_id, private.organization_export_dataset_roles(chosen)) then
      raise exception 'organization export role required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.validate_coordination_export_dataset() from public, anon, authenticated, service_role;

create trigger validate_export_schedule_dataset
  before insert or update of config, kind on public.organization_coordination_records
  for each row execute function private.validate_coordination_export_dataset();

-- Scheduled runs: the dataset comes from the schedule. A restored dataset
-- whose organization switch is off records a 'skipped' run and still
-- advances, like the old route's oversight check (agency-exports/route.ts).
create or replace function public.run_due_organization_coordination_exports(
  p_now timestamptz default pg_catalog.now(),
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  schedule public.organization_coordination_records%rowtype;
  run_count integer := 0;
  next_at timestamptz;
  chosen text;
  disabled boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_limit not between 1 and 200 then
    raise exception 'export batch limit unavailable' using errcode = '22023';
  end if;
  for schedule in
    select record.*
    from public.organization_coordination_records record
    where record.kind = 'network_export_schedule' and record.status = 'active'
      and coalesce((record.config ->> 'nextRunAt')::timestamptz, p_now) <= p_now
    order by (record.config ->> 'nextRunAt')::timestamptz nulls first, record.id
    for update skip locked limit p_limit
  loop
    chosen := coalesce(schedule.config ->> 'dataset', 'coordination_records');
    disabled := private.organization_export_restored_dataset(chosen)
      and not private.organization_feature_enabled(schedule.organization_id, 'features.automation.scheduled_dataset_exports');
    insert into public.organization_coordination_export_runs (
      schedule_id, organization_id, requested_by, format, delivery_mode,
      status, row_count, idempotency_key, dataset, delivery_note
    ) values (
      schedule.id, schedule.organization_id, null,
      schedule.config ->> 'format', schedule.config ->> 'deliveryMode',
      case
        when disabled then 'skipped'
        when schedule.config ->> 'deliveryMode' = 'internal_download' then 'ready'
        else 'queued'
      end,
      case
        when disabled then 0
        when chosen = 'coordination_records' then (
          select pg_catalog.count(*)::integer
          from public.organization_coordination_records scoped
          where scoped.organization_id = schedule.organization_id
            or exists (
              select 1
              from public.organization_coordination_organization_participants participant
              where participant.record_id = scoped.id
                and participant.organization_id = schedule.organization_id
                and participant.status = 'active'
            ))
        else pg_catalog.jsonb_array_length(
          private.organization_export_dataset(schedule.organization_id, chosen) -> 'rows')
      end,
      extensions.gen_random_uuid(),
      chosen,
      case when disabled then 'dataset_disabled' end
    );
    next_at := case schedule.config ->> 'cadence'
      when 'daily' then p_now + interval '1 day'
      when 'weekly' then p_now + interval '7 days'
      when 'monthly' then p_now + interval '1 month'
    end;
    update public.organization_coordination_records
    set config = config || pg_catalog.jsonb_build_object(
      'lastRunAt', p_now, 'nextRunAt', next_at
    ), updated_at = pg_catalog.clock_timestamp()
    where id = schedule.id;
    run_count := run_count + 1;
  end loop;
  return pg_catalog.jsonb_build_object('processed', run_count, 'ranAt', p_now);
end;
end;
$function$;

-- A manual run from the desk exports the schedule's dataset for the caller,
-- who must hold a role that may read it.
create or replace function public.run_organization_coordination_export(
  p_schedule_id uuid,
  p_format text default 'csv',
  p_idempotency_key uuid default extensions.gen_random_uuid()
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
  organization uuid := private.current_member_organization();
  run_id uuid;
  rows_ready integer;
  chosen text;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if p_format not in ('csv', 'json') then
    raise exception 'export format unavailable' using errcode = '22023';
  end if;
  select coalesce(record.config ->> 'dataset', 'coordination_records') into chosen
  from public.organization_coordination_records record
  where record.id = p_schedule_id and record.organization_id = organization
    and record.kind = 'network_export_schedule' and record.status = 'active';
  if not found then
    raise exception 'export schedule unavailable' using errcode = '22023';
  end if;
  if not private.has_organization_role(organization, private.organization_export_dataset_roles(chosen)) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if private.organization_export_restored_dataset(chosen)
     and not private.organization_feature_enabled(organization, 'features.automation.scheduled_dataset_exports') then
    raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '42501';
  end if;
  if chosen = 'coordination_records' then
    select pg_catalog.count(*)::integer into rows_ready
    from public.organization_coordination_records record
    where record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      );
  else
    rows_ready := pg_catalog.jsonb_array_length(private.organization_export_dataset(organization, chosen) -> 'rows');
  end if;
  insert into public.organization_coordination_export_runs (
    schedule_id, organization_id, requested_by, format, delivery_mode,
    status, row_count, idempotency_key, dataset
  ) values (
    p_schedule_id, organization, caller, p_format, 'internal_download',
    'ready', rows_ready, p_idempotency_key, chosen
  ) on conflict (idempotency_key) do update
    set idempotency_key = excluded.idempotency_key
  returning id into run_id;
  return pg_catalog.jsonb_build_object(
    'runId', run_id, 'status', 'ready', 'rowCount', rows_ready,
    'deliveryMode', 'internal_download', 'dataset', chosen
  );
end;
end;
$function$;

-- Download. Coordination-record content keeps its exact previous shape; the
-- restored datasets use the column allowlists above. Every payload carries
-- the same rows as a table so the browser can also save an XLSX workbook.
-- Email and SFTP runs are downloadable once their delivery has an outcome.
create or replace function public.get_organization_coordination_export_payload(p_run_id uuid)
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
  organization uuid := private.current_member_organization();
  export_run public.organization_coordination_export_runs%rowtype;
  content text;
  dataset_table jsonb;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.has_organization_role(organization, array['coordinator','admin','vp']) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  select * into export_run
  from public.organization_coordination_export_runs run
  where run.id = p_run_id and run.organization_id = organization
    and (
      (run.delivery_mode = 'internal_download' and run.status = 'ready')
      or (run.delivery_mode in ('email_unset', 'sftp_unset') and run.status in ('delivered', 'not_configured'))
    )
    and run.expires_at > pg_catalog.now();
  if not found then
    raise exception 'ready organization export unavailable' using errcode = '22023';
  end if;
  if not private.has_organization_role(organization, private.organization_export_dataset_roles(export_run.dataset)) then
    raise exception 'organization export role required' using errcode = '42501';
  end if;
  if private.organization_export_restored_dataset(export_run.dataset)
     and not private.organization_feature_enabled(organization, 'features.automation.scheduled_dataset_exports') then
    raise exception 'scheduled dataset exports are turned off for this organization' using errcode = '42501';
  end if;

  dataset_table := private.organization_export_dataset(organization, export_run.dataset);

  if export_run.dataset = 'coordination_records' and export_run.format = 'json' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', record.id,
      'kind', record.kind,
      'title', record.title,
      'status', record.status,
      'visibility', record.visibility,
      'updatedAt', record.updated_at
    ) order by record.updated_at desc, record.id desc), '[]'::jsonb)::text
    into content
    from public.organization_coordination_records record
    where record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      );
  elsif export_run.dataset = 'coordination_records' then
    select 'id,kind,title,status,visibility,updated_at' || pg_catalog.chr(10)
      || coalesce(pg_catalog.string_agg(
        private.organization_coordination_csv_cell(record.id::text) || ','
        || private.organization_coordination_csv_cell(record.kind) || ','
        || private.organization_coordination_csv_cell(record.title) || ','
        || private.organization_coordination_csv_cell(record.status) || ','
        || private.organization_coordination_csv_cell(record.visibility) || ','
        || private.organization_coordination_csv_cell(record.updated_at::text),
        pg_catalog.chr(10) order by record.updated_at desc, record.id desc
      ), '')
    into content
    from public.organization_coordination_records record
    where record.organization_id = organization
      or exists (
        select 1
        from public.organization_coordination_organization_participants participant
        where participant.record_id = record.id
          and participant.organization_id = organization
          and participant.status = 'active'
      );
  elsif export_run.format = 'json' then
    select coalesce(pg_catalog.jsonb_agg((
      select pg_catalog.jsonb_object_agg(col.name, row_value.value -> (col.position::integer - 1))
      from pg_catalog.jsonb_array_elements_text(dataset_table -> 'columns') with ordinality as col(name, position)
    ) order by row_value.ordinality), '[]'::jsonb)::text
    into content
    from pg_catalog.jsonb_array_elements(dataset_table -> 'rows') with ordinality as row_value(value, ordinality);
  else
    select (
      select pg_catalog.string_agg(private.organization_coordination_csv_cell(col.name), ',' order by col.position)
      from pg_catalog.jsonb_array_elements_text(dataset_table -> 'columns') with ordinality as col(name, position)
    ) || pg_catalog.chr(10) || coalesce((
      select pg_catalog.string_agg((
        select pg_catalog.string_agg(private.organization_coordination_csv_cell(cell.value), ',' order by cell.position)
        from pg_catalog.jsonb_array_elements_text(row_value.value) with ordinality as cell(value, position)
      ), pg_catalog.chr(10) order by row_value.ordinality)
      from pg_catalog.jsonb_array_elements(dataset_table -> 'rows') with ordinality as row_value(value, ordinality)
    ), '')
    into content;
  end if;

  return pg_catalog.jsonb_build_object(
    'runId', export_run.id,
    'dataset', export_run.dataset,
    'filename', case when export_run.dataset = 'coordination_records'
        then 'coordination-export-' else pg_catalog.replace(export_run.dataset, '_', '-') || '-export-' end
      || pg_catalog.to_char(export_run.created_at at time zone 'UTC', 'YYYYMMDDHH24MISS')
      || '.' || export_run.format,
    'mimeType', case when export_run.format = 'json'
      then 'application/json' else 'text/csv' end,
    'content', content,
    'rowCount', export_run.row_count,
    'table', dataset_table
  );
end;

end;
$function$;

-- Delivery worker seam for api/organization-exports.js (service role only).
-- A claim moves queued email/SFTP runs to 'running' under a 15-minute lease;
-- the worker reports one outcome per run. The only recipient is the person
-- who created the schedule, and only while they still hold a role that may
-- read the dataset; the email carries a sign-in link, never the data.
create function public.claim_organization_export_deliveries(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  claimed jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  with candidates as (
    select run.id
    from public.organization_coordination_export_runs run
    where run.delivery_mode in ('email_unset', 'sftp_unset')
      and (
        run.status = 'queued'
        or (run.status = 'running' and run.delivery_claimed_at < pg_catalog.now() - interval '15 minutes')
      )
    order by run.created_at, run.id
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update skip locked
  ), updated as (
    update public.organization_coordination_export_runs run
    set status = 'running', delivery_claimed_at = pg_catalog.now()
    from candidates
    where run.id = candidates.id
    returning run.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'runId', u.id,
    'organizationId', u.organization_id,
    'dataset', u.dataset,
    'format', u.format,
    'deliveryMode', u.delivery_mode,
    'expiresAt', u.expires_at,
    'organizationName', o.name,
    'recipient', (
      select pg_catalog.jsonb_build_object('email', au.email, 'lang', coalesce(p.language, 'en'))
      from public.organization_coordination_records schedule
      join auth.users au on au.id = schedule.created_by
      left join public.member_profiles p on p.id = au.id
      where schedule.id = u.schedule_id
        and au.email is not null
        and exists (
          select 1 from public.organization_memberships m
          where m.organization_id = u.organization_id and m.user_id = au.id and m.status = 'active'
        )
        and exists (
          select 1 from public.organization_role_grants g
          where g.organization_id = u.organization_id and g.user_id = au.id
            and g.role = any(private.organization_export_dataset_roles(u.dataset))
        )
    )
  ) order by u.created_at, u.id), '[]'::jsonb)
  into claimed
  from updated u
  join public.organizations o on o.id = u.organization_id;
  return claimed;
end;
end;
$function$;

create function public.complete_organization_export_delivery(
  p_run_id uuid,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  finished public.organization_coordination_export_runs%rowtype;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_status not in ('delivered', 'not_configured', 'failed')
     or (p_status = 'delivered' and p_note is not null)
     or (p_status <> 'delivered' and (p_note is null or p_note not in (
       'email_transport_unset', 'sftp_transport_unavailable', 'no_recipient', 'email_send_failed'
     ))) then
    raise exception 'invalid export delivery outcome' using errcode = '22023';
  end if;
  update public.organization_coordination_export_runs run
  set status = p_status,
      delivery_note = p_note,
      delivered_at = case when p_status = 'delivered' then pg_catalog.now() end
  where run.id = p_run_id
    and run.status = 'running'
    and run.delivery_mode in ('email_unset', 'sftp_unset')
  returning run.* into finished;
  if finished.id is null then
    raise exception 'claimed export delivery unavailable' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object('runId', finished.id, 'status', finished.status, 'note', finished.delivery_note);
end;
end;
$function$;

revoke all on function public.claim_organization_export_deliveries(integer) from public, anon, authenticated, service_role;
revoke all on function public.complete_organization_export_delivery(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_organization_export_deliveries(integer) to service_role;
grant execute on function public.complete_organization_export_delivery(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Retention default policies (CR-104)
-- ---------------------------------------------------------------------------

alter table public.organization_retention_policies
  drop constraint organization_retention_policies_data_class_check,
  add constraint organization_retention_policies_data_class_check check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks',
    'member_message_bodies',
    'casework_record_versions',
    'member_notifications',
    'ai_assistant_conversations',
    'ai_usage_counters'
  ));

alter table public.organization_retention_runs
  drop constraint organization_retention_runs_data_class_check,
  add constraint organization_retention_runs_data_class_check check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks',
    'member_message_bodies',
    'casework_record_versions',
    'member_notifications',
    'ai_assistant_conversations',
    'ai_usage_counters'
  ));

-- Retention belongs to the tenant that produced a row, never a member's later
-- selected chapter. Existing rows stay NULL: their source cannot be inferred.
alter table public.member_notifications add column organization_id uuid references public.organizations(id) on delete restrict;
alter table public.member_guide_threads add column organization_id uuid references public.organizations(id) on delete restrict;
alter table public.member_guide_messages add column organization_id uuid references public.organizations(id) on delete restrict;
alter table public.member_ai_requests add column organization_id uuid references public.organizations(id) on delete restrict;

create function private.stamp_retention_member_scope()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  scoped_org uuid;
  thread_owner uuid;
begin
  perform private.lock_case_graph(case when tg_op = 'UPDATE' then array[new.user_id, old.user_id] else array[new.user_id] end, array[]::uuid[]);
  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id or new.user_id is distinct from old.user_id then
      raise exception 'retention ownership is immutable' using errcode = '42501';
    end if;
    if tg_table_name = 'member_guide_messages' then
      if new.thread_id is distinct from old.thread_id then
        raise exception 'assistant thread ownership is immutable' using errcode = '42501';
      end if;
    end if;
    return new;
  end if;
  -- Notification producers must supply their actual source organization.
  -- An unstamped legacy producer remains outside organization purges.
  if tg_table_name = 'member_notifications' then return new; end if;
  if tg_table_name = 'member_guide_messages' then
    select t.organization_id, t.user_id into scoped_org, thread_owner
    from public.member_guide_threads t where t.id = new.thread_id;
    if thread_owner is distinct from new.user_id then
      raise exception 'assistant thread ownership mismatch' using errcode = '42501';
    end if;
    if (select auth.role()) = 'authenticated' and
       (scoped_org is null or scoped_org is distinct from private.member_organization_for(new.user_id)) then
      raise exception 'start a conversation in the selected organization' using errcode = '42501';
    end if;
  else
    scoped_org := private.member_organization_for(new.user_id);
  end if;
  if new.organization_id is not null and new.organization_id is distinct from scoped_org then
    raise exception 'assistant organization mismatch' using errcode = '42501';
  end if;
  new.organization_id := scoped_org;
  return new;
end;
$function$;
revoke all on function private.stamp_retention_member_scope() from public, anon, authenticated, service_role;

create trigger stamp_retention_scope before insert or update of organization_id, user_id
  on public.member_notifications for each row execute function private.stamp_retention_member_scope();
create trigger stamp_retention_scope before insert or update of organization_id, user_id
  on public.member_guide_threads for each row execute function private.stamp_retention_member_scope();
create trigger stamp_retention_scope before insert or update of organization_id, user_id, thread_id
  on public.member_guide_messages for each row execute function private.stamp_retention_member_scope();
create trigger stamp_retention_scope before insert or update of organization_id, user_id
  on public.member_ai_requests for each row execute function private.stamp_retention_member_scope();

-- Keep the original owner and restricted-PIN policies; tenant scope is an
-- additional restriction. Unattributed archives stay in the account export.
create function private.guide_history_organization()
returns uuid language sql stable security definer set search_path = ''
as $function$
  select private.member_organization_for((select auth.uid()));
$function$;
revoke all on function private.guide_history_organization() from public, anon, authenticated, service_role;
grant execute on function private.guide_history_organization() to authenticated;

create policy guide_history_organization_scope on public.member_guide_threads as restrictive
  for all to authenticated using (organization_id = (select private.guide_history_organization()))
  with check (organization_id = (select private.guide_history_organization()));
create policy guide_history_organization_scope on public.member_guide_messages as restrictive
  for all to authenticated using (organization_id = (select private.guide_history_organization()))
  with check (organization_id = (select private.guide_history_organization()));

comment on policy guide_history_organization_scope on public.member_guide_threads is
  'Retains owner and restricted-PIN guards; only history stamped in the caller''s current organization can appear in its assistant. Unattributed legacy history is protected from tenant purges.';
comment on policy guide_history_organization_scope on public.member_guide_messages is
  'Restrictive tenant boundary inherited immutably from the parent thread, in addition to the existing owner and restricted-PIN guards.';

-- Bounded candidate scans begin with immutable tenant scope and age.
create index member_notifications_retention_idx
  on public.member_notifications (organization_id, created_at);
create index member_guide_messages_retention_idx
  on public.member_guide_messages (organization_id, created_at);
create index member_guide_threads_retention_idx
  on public.member_guide_threads (organization_id, updated_at);
create index member_ai_requests_retention_idx
  on public.member_ai_requests (organization_id, created_at);

-- Owner retention ruling (October 3, 2026 ET): execution stays OFF until an
-- administrator explicitly enables each policy; page views keep today's 180 days.
-- (lib/storage/data-retention-policy.ts): page views 60 days (line 39),
-- notifications 365 (line 46), AI assistant conversations 180 (line 60) and
-- AI usage counters 30 (line 67), each defaultAutoPurgeEnabled true. Every
-- other class keeps execution off until an administrator enables it; for
-- member_message_bodies that is the Message body lifecycle contract.
create or replace function private.retention_data_class_config(p_data_class text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case p_data_class
    when 'organization_page_views' then pg_catalog.jsonb_build_object(
      'label', 'Organization page views', 'minimumDays', 30, 'maximumDays', 3650, 'defaultDays', 180,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Aggregated daily path and hat counts; no page-view identity rows.'
    )
    when 'organization_engagement_events' then pg_catalog.jsonb_build_object(
      'label', 'Engagement events', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Organization analytics events after their reporting window.'
    )
    when 'integration_job_history' then pg_catalog.jsonb_build_object(
      'label', 'Integration job history', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Terminal provider-operation envelopes; active or queued jobs are never eligible.'
    )
    when 'public_event_rsvps' then pg_catalog.jsonb_build_object(
      'label', 'Public event RSVPs', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Submitted public RSVP names and email addresses after the published 90-day window.'
    )
    when 'deleted_chapter_tasks' then pg_catalog.jsonb_build_object(
      'label', 'Deleted chapter tasks', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Soft-deleted tasks and their cascading task-thread records after the recovery window.'
    )
    when 'member_message_bodies' then pg_catalog.jsonb_build_object(
      'label', 'Direct message bodies', 'minimumDays', 365, 'maximumDays', 2555, 'defaultDays', 1095,
      'operation', 'redact', 'defaultExecution', false,
      'description', 'Direct conversation text older than the window is destroyed in place; the message, its timestamps and a digest survive as a tombstone. Conversations under a preservation order are never eligible.'
    )
    when 'casework_record_versions' then pg_catalog.jsonb_build_object(
      'label', 'Casework record snapshots', 'minimumDays', 180, 'maximumDays', 3650, 'defaultDays', 730,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Organization-scoped casework row snapshots that never belonged to a case. A snapshot that belongs to a case is never eligible here; it is destroyed with the case.'
    )
    when 'member_notifications' then pg_catalog.jsonb_build_object(
      'label', 'In-app notifications', 'minimumDays', 30, 'maximumDays', 3650, 'defaultDays', 365,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Member alerts and reminders and their delivery history after the window.'
    )
    when 'ai_assistant_conversations' then pg_catalog.jsonb_build_object(
      'label', 'AI assistant conversations', 'minimumDays', 30, 'maximumDays', 3650, 'defaultDays', 180,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Questions members asked the assistant and its stored replies, and conversations left with no messages, after the window.'
    )
    when 'ai_usage_counters' then pg_catalog.jsonb_build_object(
      'label', 'AI assistant usage counters', 'minimumDays', 1, 'maximumDays', 365, 'defaultDays', 30,
      'operation', 'delete', 'defaultExecution', false,
      'description', 'Per-request rate-limit entries. The rate limiter already removes them after two hours; this window is the backstop.'
    )
    else null
  end;
$function$;

create or replace function private.retention_eligible_count(
  p_organization_id uuid,
  p_data_class text,
  p_retention_days integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  eligible bigint;
  cutoff timestamptz := pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
begin
  if private.retention_data_class_config(p_data_class) is null then
    raise exception 'unsupported retention data class' using errcode = '22023';
  end if;

  case p_data_class
    when 'organization_page_views' then
      select pg_catalog.count(*) into eligible
      from public.organization_page_views v
      where v.organization_id = p_organization_id
        and v.day < current_date - p_retention_days;
    when 'organization_engagement_events' then
      select pg_catalog.count(*) into eligible
      from public.organization_engagement_events e
      where e.organization_id = p_organization_id
        and e.occurred_at < cutoff;
    when 'integration_job_history' then
      select pg_catalog.count(*) into eligible
      from public.integration_jobs j
      where j.organization_id = p_organization_id
        and j.status in ('success', 'failed', 'skipped', 'dead')
        and j.updated_at < cutoff;
    when 'public_event_rsvps' then
      select pg_catalog.count(*) into eligible
      from public.public_event_rsvps r
      where r.organization_id = p_organization_id
        and r.created_at < cutoff;
    when 'deleted_chapter_tasks' then
      select pg_catalog.count(*) into eligible
      from public.chapter_tasks t
      join public.chapters c on c.id = t.chapter_id
      where c.organization_id = p_organization_id
        and t.deleted_at is not null
        and t.deleted_at < cutoff;
    when 'member_message_bodies' then
      select
        (select pg_catalog.count(*)
         from public.member_messages m
         join public.member_conversations c on c.id = m.conversation_id
         where c.organization_id = p_organization_id
           and m.redacted_at is null
           and m.created_at < cutoff
           and not private.member_message_under_legal_hold(m.conversation_id))
        + (select pg_catalog.count(*)
           from public.member_scheduled_messages s
           join public.member_conversations c on c.id = s.conversation_id
           where c.organization_id = p_organization_id
             and s.redacted_at is null
             and s.sent_message_id is null
             and s.created_at < cutoff
             and not private.member_message_under_legal_hold(s.conversation_id))
      into eligible;
    when 'casework_record_versions' then
      select pg_catalog.count(*) into eligible
      from private.casework_record_versions v
      where v.organization_id = p_organization_id
        and v.case_id is null
        and v.at < cutoff;
    -- Unattributed legacy rows are deliberately outside tenant purges.
    when 'member_notifications' then
      select pg_catalog.count(*) into eligible
      from public.member_notifications n
      where n.organization_id = p_organization_id
        and n.created_at < cutoff;
    when 'ai_assistant_conversations' then
      select
        (select pg_catalog.count(*)
         from public.member_guide_messages m
         where m.organization_id = p_organization_id
           and m.created_at < cutoff)
        + (select pg_catalog.count(*)
           from public.member_guide_threads t
           where t.organization_id = p_organization_id
             and t.updated_at < cutoff
             and not exists (
               select 1 from public.member_guide_messages m
               where m.thread_id = t.id and m.created_at >= cutoff
             ))
      into eligible;
    when 'ai_usage_counters' then
      select pg_catalog.count(*) into eligible
      from public.member_ai_requests r
      where r.organization_id = p_organization_id
        and r.created_at < cutoff;
  end case;

  if eligible > 2147483647 then
    return 2147483647;
  end if;
  return eligible::integer;
end;
$function$;

-- Based on 20260925630500; preserve its locking and legal-hold behavior.
-- New classes and message candidates use immutable creation-time tenant scope.
create or replace function private.perform_organization_retention_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  run_row public.organization_retention_runs%rowtype;
  policy_row public.organization_retention_policies%rowtype;
  removed integer := 0;
  remaining integer := 0;
  extra integer := 0;
  candidate_id uuid;
begin
  perform private.lock_message_lifecycle();
  select r.* into run_row
  from public.organization_retention_runs r
  where r.id = p_run_id
  for update;
  if run_row.id is null or run_row.status <> 'authorized' then
    raise exception 'authorized retention run required' using errcode = '22023';
  end if;
  if run_row.authorization_expires_at <= pg_catalog.now() then
    update public.organization_retention_runs
      set status = 'expired', completed_at = pg_catalog.now(),
          failure_code = 'authorization_expired'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'expired');
  end if;

  select p.* into policy_row
  from public.organization_retention_policies p
  where p.organization_id = run_row.organization_id and p.data_class = run_row.data_class
  for key share;
  if policy_row.organization_id is null or not policy_row.execution_enabled then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_disabled'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'execution_disabled');
  end if;
  if policy_row.retention_days <> run_row.retention_days then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'policy_changed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'policy_changed');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(run_row.organization_id::text || ':' || run_row.data_class, 0)
  );
  update public.organization_retention_runs
    set status = 'running', started_at = pg_catalog.now()
    where id = run_row.id;

  begin
    case run_row.data_class
      when 'organization_page_views' then
        with candidates as (
          select v.ctid
          from public.organization_page_views v
          where v.organization_id = run_row.organization_id
            and v.day < current_date - run_row.retention_days
          order by v.day, v.path, v.hat
          limit 5000
          for update skip locked
        )
        delete from public.organization_page_views target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'organization_engagement_events' then
        with candidates as (
          select e.ctid
          from public.organization_engagement_events e
          where e.organization_id = run_row.organization_id
            and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by e.occurred_at, e.user_id, e.event_type, e.source_id
          limit 5000
          for update skip locked
        )
        delete from public.organization_engagement_events target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'integration_job_history' then
        with candidates as (
          select j.id
          from public.integration_jobs j
          where j.organization_id = run_row.organization_id
            and j.status in ('success', 'failed', 'skipped', 'dead')
            and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by j.updated_at, j.id
          limit 5000
          for update skip locked
        )
        delete from public.integration_jobs target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'public_event_rsvps' then
        with candidates as (
          select r.id
          from public.public_event_rsvps r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update skip locked
        )
        delete from public.public_event_rsvps target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'deleted_chapter_tasks' then
        with candidates as (
          select t.id
          from public.chapter_tasks t
          join public.chapters c on c.id = t.chapter_id
          where c.organization_id = run_row.organization_id
            and t.deleted_at is not null
            and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by t.deleted_at, t.id
          limit 5000
          for update of t skip locked
        )
        delete from public.chapter_tasks target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'member_message_bodies' then
        -- Row-at-a-time on purpose. private.redact_member_message_row is the
        -- only path allowed to destroy a body: it re-checks the preservation
        -- order under the row lock and sweeps the duplicate scheduled-message
        -- copy. A set-based UPDATE here would be faster and would leave that
        -- second plaintext copy behind. A hold placed mid-run raises and the
        -- handler below fails the run without redacting further — preservation
        -- wins over the retention window, deliberately.
        for candidate_id in
          select m.id
          from public.member_messages m
          join public.member_conversations c on c.id = m.conversation_id
          where c.organization_id = run_row.organization_id
            and m.redacted_at is null
            and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(m.conversation_id)
          order by m.created_at, m.id
          limit 5000
        loop
          if private.redact_member_message_row(candidate_id, 'retention_expired', run_row.authorized_by) then
            removed := removed + 1;
          end if;
        end loop;
        -- The second durable copy with no delivered row behind it. A draft that
        -- was never dispatched is not reachable from the loop above — nothing
        -- points at it — so without this it would keep its plaintext body past
        -- the window forever, which is exactly what the class promises to
        -- prevent. Same bound, same preservation-order refusal.
        for candidate_id in
          select s.id
          from public.member_scheduled_messages s
          join public.member_conversations c on c.id = s.conversation_id
          where c.organization_id = run_row.organization_id
            and s.redacted_at is null
            and s.sent_message_id is null
            and s.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(s.conversation_id)
          order by s.created_at, s.id
          limit 5000
        loop
          if private.redact_member_scheduled_message_row(candidate_id) then
            removed := removed + 1;
          end if;
        end loop;
      when 'casework_record_versions' then
        -- Same bound and the same skip-locked candidate shape as every other
        -- deleting class. `case_id is null` is the whole disposition: a
        -- case-scoped snapshot is out of reach of this branch and stays out of
        -- reach, because its lifetime is the case's lifetime, not a window.
        with candidates as (
          select v.id
          from private.casework_record_versions v
          where v.organization_id = run_row.organization_id
            and v.case_id is null
            and v.at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by v.at, v.id
          limit 5000
          for update skip locked
        )
        delete from private.casework_record_versions target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'member_notifications' then
        -- Deliveries cascade with their notification; dues and automation
        -- references detach (on delete set null).
        with candidates as (
          select n.id
          from public.member_notifications n
          where n.organization_id = run_row.organization_id
            and n.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by n.created_at, n.id
          limit 5000
          for update of n skip locked
        )
        delete from public.member_notifications target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'ai_assistant_conversations' then
        with candidates as (
          select m.id
          from public.member_guide_messages m
          where m.organization_id = run_row.organization_id
            and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by m.created_at, m.id
          limit 5000
          for update of m skip locked
        )
        delete from public.member_guide_messages target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
        -- A conversation left with nothing newer than the window goes too.
        with candidates as (
          select t.id
          from public.member_guide_threads t
          where t.organization_id = run_row.organization_id
            and t.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not exists (
              select 1 from public.member_guide_messages m
              where m.thread_id = t.id
                and m.created_at >= pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            )
          order by t.updated_at, t.id
          limit 5000
          for update of t skip locked
        )
        delete from public.member_guide_threads target
        where target.id in (select candidates.id from candidates);
        get diagnostics extra = row_count;
        removed := removed + extra;
      when 'ai_usage_counters' then
        with candidates as (
          select r.id
          from public.member_ai_requests r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update of r skip locked
        )
        delete from public.member_ai_requests target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
    end case;

    remaining := private.retention_eligible_count(
      run_row.organization_id, run_row.data_class, run_row.retention_days
    );
    update public.organization_retention_runs
      set status = 'completed', deleted_count = removed,
          remaining_count = remaining, completed_at = pg_catalog.now()
      where id = run_row.id;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      run_row.organization_id, 'privacy', 'retention.completed', 'delete', run_row.authorized_by,
      'retention_run', run_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'dataClass', run_row.data_class,
        'retentionDays', run_row.retention_days,
        'eligibleCount', run_row.eligible_count,
        'deletedCount', removed,
        'remainingCount', remaining,
        'mode', run_row.mode,
        'operation', private.retention_data_class_config(run_row.data_class) ->> 'operation'
      ) || case
        -- A scheduled run has no actor (actor_user_id stays null). The admin
        -- whose standing policy authorized it is recorded separately as
        -- userId, so the ledger never shows that person performing the run.
        when run_row.mode = 'scheduled' and policy_row.updated_by is not null
          then pg_catalog.jsonb_build_object('userId', policy_row.updated_by)
        else '{}'::jsonb
      end
    );
  exception when others then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_failed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object(
      'id', run_row.id, 'status', 'failed', 'failureCode', 'execution_failed'
    );
  end;

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'dataClass', run_row.data_class,
    'status', 'completed',
    'deletedCount', removed,
    'remainingCount', remaining
  );
end;
end;
$function$;

-- The nightly scheduler first records the default policy of a default-on
-- class for an organization that has something eligible under it and no
-- disabled policy of its own (no person: updated_by stays null), then runs every
-- explicitly enabled policy exactly as before. An administrator's own row, on or off,
-- always wins and is never overwritten. It also ages failed sign-in records
-- out by each organization's security.failed_login_retention_days even when
-- no new failure arrives to trigger the purge in record_failed_login_attempt.
create or replace function private.run_due_organization_retention_jobs(p_limit integer default 25)
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
  policy_row public.organization_retention_policies%rowtype;
  run_id uuid;
  processed integer := 0;
  seeded integer := 0;
  expired_failures integer := 0;
  bound integer := greatest(1, least(coalesce(p_limit, 25), 100));
begin
  perform private.lock_message_lifecycle();

  with defaults as (
    select o.id as organization_id, c.data_class,
      (private.retention_data_class_config(c.data_class) ->> 'defaultDays')::integer as retention_days
    from public.organizations o
    cross join (values
      ('organization_page_views'::text), ('member_notifications'),
      ('ai_assistant_conversations'), ('ai_usage_counters'),
      ('organization_engagement_events'), ('integration_job_history'),
      ('public_event_rsvps'), ('deleted_chapter_tasks'),
      ('member_message_bodies'), ('casework_record_versions')
    ) c(data_class)
    where o.status = 'active'
      and not exists (
        select 1 from public.organization_retention_policies p
        where p.organization_id = o.id and p.data_class = c.data_class
      )
  ), due as (
    select d.*
    from defaults d
    order by d.organization_id, d.data_class
    limit bound
  )
  insert into public.organization_retention_policies (
    organization_id, data_class, retention_days, execution_enabled, updated_by
  )
  select due.organization_id, due.data_class, due.retention_days, false, null
  from due
  on conflict (organization_id, data_class) do nothing;
  get diagnostics seeded = row_count;

  with expired as (
    select a.id
    from public.organization_failed_login_attempts a
    where a.occurred_at < pg_catalog.now() - pg_catalog.make_interval(
      days => private.organization_limit(a.organization_id, 'security.failed_login_retention_days'))
    order by a.occurred_at, a.id
    limit 5000
    for update skip locked
  )
  delete from public.organization_failed_login_attempts target
  where target.id in (select expired.id from expired);
  get diagnostics expired_failures = row_count;

  for policy_row in
    select p.*
    from public.organization_retention_policies p
    where p.execution_enabled
      and not exists (
        select 1
        from public.organization_retention_runs r
        where r.organization_id = p.organization_id
          and r.data_class = p.data_class
          and r.mode = 'scheduled'
          and r.created_at >= pg_catalog.now() - interval '20 hours'
      )
    order by p.updated_at, p.organization_id, p.data_class
    limit bound
    for update skip locked
  loop
    -- The scheduler performs this run, not the policy's last editor, so it
    -- carries no requesting or authorizing person. The admin whose standing
    -- policy enabled execution is named in the ledger metadata instead.
    insert into public.organization_retention_runs (
      organization_id, data_class, retention_days, mode, status,
      eligible_count, requested_by, authorized_by, authorized_at,
      authorization_expires_at
    ) values (
      policy_row.organization_id, policy_row.data_class, policy_row.retention_days,
      'scheduled', 'authorized',
      private.retention_eligible_count(
        policy_row.organization_id, policy_row.data_class, policy_row.retention_days
      ),
      null, null, pg_catalog.now(),
      pg_catalog.now() + interval '30 minutes'
    ) returning id into run_id;
    perform private.perform_organization_retention_run(run_id);
    processed := processed + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'processed', processed,
    'defaultPoliciesRecorded', seeded,
    'failedSigninsExpired', expired_failures,
    'ranAt', pg_catalog.now()
  );
end;
end;
end;
$function$;

-- An organization with no row of its own sees a default-on class as on, so
-- saving a new window for it is not an "enable" and needs no confirmation.
-- Turning a class on from off still needs the exact ENABLE phrase.
create or replace function public.upsert_organization_retention_policy(
  p_data_class text,
  p_retention_days integer,
  p_execution_enabled boolean,
  p_confirmation text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := private.current_member_organization();
  caller uuid;
  config jsonb := private.retention_data_class_config(p_data_class);
  minimum_days integer;
  maximum_days integer;
  previous_enabled boolean;
begin
  caller := private.assert_retention_admin(org);
  if config is null then
    raise exception 'unsupported retention data class' using errcode = '22023';
  end if;
  minimum_days := (config ->> 'minimumDays')::integer;
  maximum_days := (config ->> 'maximumDays')::integer;
  if p_retention_days is null or p_retention_days < minimum_days or p_retention_days > maximum_days then
    raise exception 'retention window outside supported range' using errcode = '22023';
  end if;

  select p.execution_enabled into previous_enabled
  from public.organization_retention_policies p
  where p.organization_id = org and p.data_class = p_data_class
  for update;
  previous_enabled := coalesce(previous_enabled, (config ->> 'defaultExecution')::boolean, false);

  if p_execution_enabled and not previous_enabled
     and p_confirmation is distinct from ('ENABLE ' || p_data_class) then
    raise exception 'exact execution confirmation required' using errcode = '22023';
  end if;

  insert into public.organization_retention_policies (
    organization_id, data_class, retention_days, execution_enabled, updated_by
  ) values (
    org, p_data_class, p_retention_days, p_execution_enabled, caller
  )
  on conflict (organization_id, data_class) do update
    set retention_days = excluded.retention_days,
        execution_enabled = excluded.execution_enabled,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now();

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'retention.policy_saved', 'settings_change', caller,
    'retention_policy', p_data_class, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object(
      'dataClass', p_data_class,
      'retentionDays', p_retention_days,
      'executionEnabled', p_execution_enabled
    )
  );

  return public.get_organization_retention_engine();
end;
end;
$function$;

create or replace function public.get_organization_retention_engine()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  org uuid;
  caller uuid;
  result jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.current_member_organization();
  caller := private.assert_retention_admin(org);

  with catalog(data_class) as (values
    ('organization_page_views'::text),
    ('organization_engagement_events'),
    ('integration_job_history'),
    ('public_event_rsvps'),
    ('deleted_chapter_tasks'),
    ('member_message_bodies'),
    ('casework_record_versions'),
    ('member_notifications'),
    ('ai_assistant_conversations'),
    ('ai_usage_counters')
  ), policy_rows as (
    select
      c.data_class,
      private.retention_data_class_config(c.data_class) as config,
      p.retention_days,
      p.execution_enabled,
      p.updated_at
    from catalog c
    left join public.organization_retention_policies p
      on p.organization_id = org
     and p.data_class = c.data_class
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', org,
    'schedulerConfigured', private.retention_scheduler_configured(),
    'policies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'dataClass', p.data_class,
        'label', p.config ->> 'label',
        'description', p.config ->> 'description',
        'minimumDays', (p.config ->> 'minimumDays')::integer,
        'maximumDays', (p.config ->> 'maximumDays')::integer,
        'defaultDays', (p.config ->> 'defaultDays')::integer,
        'retentionDays', coalesce(p.retention_days, (p.config ->> 'defaultDays')::integer),
        'configured', p.retention_days is not null,
        'defaultExecutionEnabled', coalesce((p.config ->> 'defaultExecution')::boolean, false),
        'executionEnabled', coalesce(p.execution_enabled, (p.config ->> 'defaultExecution')::boolean, false),
        'updatedAt', p.updated_at
      ) order by p.data_class)
      from policy_rows p
    ), '[]'::jsonb),
    'runs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'dataClass', r.data_class,
        'retentionDays', r.retention_days,
        'mode', r.mode,
        'status', r.status,
        'eligibleCount', r.eligible_count,
        'deletedCount', r.deleted_count,
        'remainingCount', r.remaining_count,
        'requestedBy', r.requested_by,
        'authorizedBy', r.authorized_by,
        'authorizationExpiresAt', r.authorization_expires_at,
        'createdAt', r.created_at,
        'completedAt', r.completed_at,
        'failureCode', r.failure_code,
        'confirmationPhrase', case when r.status = 'previewed'
          then 'AUTHORIZE ' || r.data_class else null end
      ) order by r.created_at desc, r.id desc)
      from (
        select history.*
        from public.organization_retention_runs history
        where history.organization_id = org
        order by history.created_at desc, history.id desc
        limit 25
      ) r
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Trusted source health check (CR-072)
-- ---------------------------------------------------------------------------

create table private.organization_knowledge_source_health (
  organization_id uuid primary key
    references public.organizations(id) on update cascade on delete cascade,
  stale_days integer not null check (stale_days between 1 and 3650),
  article_total integer not null default 0 check (article_total >= 0),
  article_stale integer not null default 0 check (article_stale >= 0),
  document_total integer not null default 0 check (document_total >= 0),
  document_stale integer not null default 0 check (document_stale >= 0),
  document_pending integer not null default 0 check (document_pending >= 0),
  document_failed integer not null default 0 check (document_failed >= 0),
  source_total integer not null default 0 check (source_total >= 0),
  source_stale integer not null default 0 check (source_stale >= 0),
  source_pending integer not null default 0 check (source_pending >= 0),
  source_failed integer not null default 0 check (source_failed >= 0),
  last_indexed_at timestamptz,
  checked_at timestamptz not null default pg_catalog.now()
);

comment on table private.organization_knowledge_source_health is
  'REQ-UG-TRUSTED-SOURCE-STALENESS-CHECK-20261001: the latest hourly roll-up of one organization''s trusted knowledge sources (counts only). No client grant; read through get_knowledge_source_health.';

alter table private.organization_knowledge_source_health enable row level security;
alter table private.organization_knowledge_source_health force row level security;
revoke all on table private.organization_knowledge_source_health from public, anon, authenticated, service_role;

create trigger a00_case_graph_lock before insert or update or delete on private.organization_knowledge_source_health
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_knowledge_source_health
for each row execute function private.lock_case_graph_row_keys('', '');

create function private.refresh_organization_knowledge_source_health(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  window_days integer := private.organization_limit(p_organization_id, 'limits.intelligence.trusted_source_stale_days');
  cutoff timestamptz;
begin
  cutoff := pg_catalog.now() - pg_catalog.make_interval(days => window_days);
  insert into private.organization_knowledge_source_health (
    organization_id, stale_days,
    article_total, article_stale,
    document_total, document_stale, document_pending, document_failed,
    source_total, source_stale, source_pending, source_failed,
    last_indexed_at, checked_at
  )
  select p_organization_id, window_days,
    articles.total, articles.stale,
    documents.total, documents.stale, documents.pending, documents.failed,
    sources.total, sources.stale, sources.pending, sources.failed,
    greatest(documents.last_indexed, sources.last_ingested), pg_catalog.now()
  from (
    select pg_catalog.count(*)::integer as total,
      (pg_catalog.count(*) filter (where coalesce(k.verified_at, k.updated_at) < cutoff))::integer as stale
    from public.member_kb_articles k
    join public.chapters c on c.id = k.chapter_id
    where c.organization_id = p_organization_id
      and k.status = 'published'
      and not k.is_sample
      and k.content_origin <> 'unresolved'
  ) articles,
  (
    select pg_catalog.count(*)::integer as total,
      (pg_catalog.count(*) filter (where f.updated_at < cutoff))::integer as stale,
      (pg_catalog.count(*) filter (where f.index_status = 'pending'))::integer as pending,
      (pg_catalog.count(*) filter (where f.index_status = 'failed'))::integer as failed,
      pg_catalog.max(f.updated_at) filter (where f.index_status in ('chunked', 'embedded')) as last_indexed
    from public.organization_knowledge_files f
    where f.organization_id = p_organization_id
      and f.review_status = 'approved'
  ) documents,
  (
    select pg_catalog.count(*)::integer as total,
      (pg_catalog.count(*) filter (where coalesce(s.last_ingest_at, s.created_at) < cutoff))::integer as stale,
      (pg_catalog.count(*) filter (where s.health = 'partial'))::integer as pending,
      (pg_catalog.count(*) filter (where s.health = 'failed'))::integer as failed,
      pg_catalog.max(s.last_ingest_at) as last_ingested
    from public.organization_knowledge_sources s
    where s.organization_id = p_organization_id
  ) sources
  on conflict (organization_id) do update set
    stale_days = excluded.stale_days,
    article_total = excluded.article_total,
    article_stale = excluded.article_stale,
    document_total = excluded.document_total,
    document_stale = excluded.document_stale,
    document_pending = excluded.document_pending,
    document_failed = excluded.document_failed,
    source_total = excluded.source_total,
    source_stale = excluded.source_stale,
    source_pending = excluded.source_pending,
    source_failed = excluded.source_failed,
    last_indexed_at = excluded.last_indexed_at,
    checked_at = excluded.checked_at;
end;
end;
$function$;

revoke all on function private.refresh_organization_knowledge_source_health(uuid) from public, anon, authenticated, service_role;

-- Hourly, bounded: organizations whose switch is on and that hold knowledge
-- content, least recently checked first.
create function private.run_knowledge_source_health_checks(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  target uuid;
  processed integer := 0;
begin
  for target in
    select o.id
    from public.organizations o
    left join private.organization_knowledge_source_health h on h.organization_id = o.id
    where o.status = 'active'
      and (h.checked_at is null or h.checked_at < pg_catalog.now() - interval '50 minutes')
      and private.organization_feature_enabled(o.id, 'features.intelligence.trusted_source_health_check')
      and (
        exists (select 1 from public.organization_knowledge_sources s where s.organization_id = o.id)
        or exists (select 1 from public.organization_knowledge_files f where f.organization_id = o.id)
        or exists (
          select 1 from public.member_kb_articles k
          join public.chapters c on c.id = k.chapter_id
          where c.organization_id = o.id and k.status = 'published'
        )
      )
    order by h.checked_at nulls first, o.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    perform private.refresh_organization_knowledge_source_health(target);
    processed := processed + 1;
  end loop;
  return processed;
end;
end;
$function$;

revoke all on function private.run_knowledge_source_health_checks(integer) from public, anon, authenticated, service_role;

comment on function private.run_knowledge_source_health_checks(integer) is
  'Bounded pg_cron target (knowledge-source-health-tick): refreshes the trusted-source roll-up for organizations whose features.intelligence.trusted_source_health_check switch is on.';

-- Knowledge staff read: the same roles as list_knowledge_ingest_sources.
-- Counts come from the last hourly check; the attention list is read live and
-- names at most five items per family, oldest first.
create function public.get_knowledge_source_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  health private.organization_knowledge_source_health%rowtype;
  window_days integer;
  cutoff timestamptz;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  window_days := private.organization_limit(org, 'limits.intelligence.trusted_source_stale_days');
  cutoff := pg_catalog.now() - pg_catalog.make_interval(days => window_days);
  select * into health from private.organization_knowledge_source_health h where h.organization_id = org;
  return pg_catalog.jsonb_build_object(
    'enabled', private.organization_feature_enabled(org, 'features.intelligence.trusted_source_health_check'),
    'staleDays', window_days,
    'checkedAt', health.checked_at,
    'checkedStaleDays', health.stale_days,
    'lastIndexedAt', health.last_indexed_at,
    'articles', pg_catalog.jsonb_build_object(
      'total', coalesce(health.article_total, 0), 'stale', coalesce(health.article_stale, 0)),
    'documents', pg_catalog.jsonb_build_object(
      'total', coalesce(health.document_total, 0), 'stale', coalesce(health.document_stale, 0),
      'pending', coalesce(health.document_pending, 0), 'failed', coalesce(health.document_failed, 0)),
    'sources', pg_catalog.jsonb_build_object(
      'total', coalesce(health.source_total, 0), 'stale', coalesce(health.source_stale, 0),
      'pending', coalesce(health.source_pending, 0), 'failed', coalesce(health.source_failed, 0)),
    'attention', case when private.organization_feature_enabled(org, 'features.intelligence.trusted_source_health_check') then coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.since nulls first, item.value ->> 'id')
      from (
        (select pg_catalog.jsonb_build_object(
            'kind', 'source', 'id', s.id::text, 'label', s.label,
            'reason', case s.health when 'failed' then 'failed' when 'partial' then 'pending' else 'stale' end,
            'since', coalesce(s.last_ingest_at, s.created_at)) as value,
          coalesce(s.last_ingest_at, s.created_at) as since
         from public.organization_knowledge_sources s
         where s.organization_id = org
           and (s.health in ('failed', 'partial') or coalesce(s.last_ingest_at, s.created_at) < cutoff)
         order by coalesce(s.last_ingest_at, s.created_at), s.id
         limit 5)
        union all
        (select pg_catalog.jsonb_build_object(
            'kind', 'document', 'id', f.id::text, 'label', f.title,
            'reason', case f.index_status when 'failed' then 'failed' when 'pending' then 'pending' else 'stale' end,
            'since', f.updated_at) as value,
          f.updated_at as since
         from public.organization_knowledge_files f
         where f.organization_id = org
           and f.review_status = 'approved'
           and (f.index_status in ('failed', 'pending') or f.updated_at < cutoff)
         order by f.updated_at, f.id
         limit 5)
        union all
        (select pg_catalog.jsonb_build_object(
            'kind', 'article', 'id', k.id::text, 'label', k.title,
            'reason', 'stale',
            'since', coalesce(k.verified_at, k.updated_at)) as value,
          coalesce(k.verified_at, k.updated_at) as since
         from public.member_kb_articles k
         join public.chapters c on c.id = k.chapter_id
         where c.organization_id = org
           and k.status = 'published'
           and not k.is_sample
           and k.content_origin <> 'unresolved'
           and coalesce(k.verified_at, k.updated_at) < cutoff
         order by coalesce(k.verified_at, k.updated_at), k.id
         limit 5)
      ) item
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
$function$;

revoke all on function public.get_knowledge_source_health() from public, anon, authenticated, service_role;
grant execute on function public.get_knowledge_source_health() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Account-lifecycle trigger review for the two new organization-keyed
--    tables and the dataset validator on coordination records
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'trigger'
  and (
    (schema_name = 'private' and table_name in ('meeting_minutes_event_notices', 'organization_knowledge_source_health')
      and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
    or (schema_name = 'public' and table_name in ('member_notifications', 'member_guide_threads', 'member_guide_messages', 'member_ai_requests')
      and object_name = 'stamp_retention_scope')
    or (schema_name = 'public' and table_name = 'organization_coordination_records'
      and object_name = 'validate_export_schedule_dataset')
  )
union all
-- The dataset validator only reads: it raises or returns NEW unchanged and
-- fires on config/kind changes, never on the chapter or account cascades.
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private' and table_name = ''
  and object_name in (
    'validate_coordination_export_dataset()', 'stamp_retention_member_scope()',
    -- Unchanged 20260918071000 reader: active profile/chapter and both active
    -- memberships derive the member's organization; it writes or locks no rows.
    'member_organization_for(p_user_id uuid)',
    'organization_export_restored_dataset(p_dataset text)',
    'organization_export_dataset_roles(p_dataset text)',
    'organization_feature_enabled(p_organization_id uuid, p_key text)',
    'organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)'
  )
on conflict do nothing;

do $assert_l7b_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the L7b automation tables';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after the L7b automation tables';
  end if;
end;
$assert_l7b_trigger_review$;

-- ---------------------------------------------------------------------------
-- 6. Schedules (old cadence: both routes ran hourly)
-- ---------------------------------------------------------------------------

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname in ('minutes-pre-event-notices-tick', 'knowledge-source-health-tick');
  perform cron.schedule('minutes-pre-event-notices-tick', '7 * * * *', 'select private.dispatch_minutes_pre_event_notices(200)');
  perform cron.schedule('knowledge-source-health-tick', '15 * * * *', 'select private.run_knowledge_source_health_checks(100)');
end;
$block$;

-- ---------------------------------------------------------------------------
-- 7. Job health: the two new pg_cron jobs join the four copies of the
--    monitored set (the job-name CHECK, the mirror's jobname allow-list,
--    list_organization_job_health() and PRODUCT_JOBS in
--    src/features/operations/jobRegistry.js). Re-emitted from
--    20261002102000 with minutes-pre-event-notices-tick and
--    knowledge-source-health-tick added and nothing else changed.
-- ---------------------------------------------------------------------------

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in ('account-deletion-reconcile-tick', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick'));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  with candidate as (
    select j.jobname as job_name,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in ('appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and (d.start_time >= window_start or d.runid = any(open_runs))
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, c.job_name, c.run_id, c.status, c.started_at, c.finished_at,
    c.failure_code, c.redacted_summary
  from candidate c
  left join public.organization_job_runs mirrored
    on mirrored.job_name = c.job_name
   and mirrored.run_id = c.run_id
   and mirrored.organization_id is null
  where mirrored.id is null
     or mirrored.status is distinct from c.status
     or mirrored.finished_at is distinct from c.finished_at
     or mirrored.failure_code is distinct from c.failure_code
     or mirrored.redacted_summary is distinct from c.redacted_summary
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array['account-deletion-reconcile-tick', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick']) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

notify pgrst, 'reload schema';

commit;
