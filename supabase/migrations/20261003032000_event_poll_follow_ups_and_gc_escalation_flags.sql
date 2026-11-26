-- REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001
-- REQ-UG-GC-ESCALATION-FLAGS-20261001 (CR-027)
--
-- Restore-everything campaign, lane L7a (owner request 2026-10-01; owner
-- decision D2: a restored feature starts in the old app's effective production
-- default, behind a visible admin switch).
--
-- 1. Event and poll follow-ups (old de7df4b57c^: lib/handoffs/event-handoffs.ts,
--    lib/handoffs/poll-handoffs.ts, 2026-04-25; called unconditionally from
--    app/dashboard/events/actions.ts:67 and app/dashboard/live-poll/actions.ts:299).
--
--    * A new event creates a DRAFT announcement ("Upcoming: <title>", date,
--      location, RSVP pointer) for the event chapter's stewards to review. It is
--      never sent automatically: a steward uses it in the broadcast composer
--      (and publishes through the existing publish_member_broadcast authority)
--      or dismisses it.
--    * When a live poll closes, everyone who voted gets an in-app results
--      notice (kind 'votes', so each member's votes topic, quiet hours and the
--      member stress guard apply). A poll whose results are staff-only sends no
--      results notice.
--    * When fewer people voted than the organization's threshold (old
--      action_participation_alert_threshold = 10,
--      supabase/migrations/0161_handoff_settings_seed.sql:42), the staff member
--      who created the poll gets a low-participation notice.
--    * Only events created and polls closed after this migration are followed
--      up; nothing is drafted or sent for history. The new-member onboarding
--      task is 's, not this one.
--    * The sweep rides the existing event-notices-tick (every 15 minutes,
--      already mirrored by the job health desk) and is error-isolated.
--
-- 2. Grievance-coordinator escalation flags (old de7df4b57c^:
--    supabase/migrations/0242_gc_tasks_escalation.sql gc_flag_escalations, run
--    hourly by app/api/cron/gc-escalations, vercel.ts:59): grievance tasks that
--    were overdue, or high/urgent and due within 48 hours, were flagged with a
--    reason badge in the coordinator's case workspace, and cleared when done.
--
--    Today's grievance-task equivalent is the recorded casework deadline. A
--    deadline is flagged 'overdue' once past due while still active or missed,
--    or 'critical_deadline' when a contractual deadline (filing, response,
--    hearing, appeal; follow-up deadlines are the old low/medium tasks) falls
--    inside limits.casework.gc_escalation_due_hours (default 48) of now. A flag
--    clears as soon as the deadline is met, extended or waived, its case is no
--    longer active, or the switch is turned off. Each new or escalated flag
--    notifies the case's coordinator (or, with none assigned, the chapter's
--    coordinators), once, under kind 'deadlines' with no case detail, and only
--    a person who can read the case (private.casework_reminder_owner_can_read).
--    Coordinator badges read the flags through casework_get_escalation_flags,
--    which only case staff may call. The sweep rides the existing per-minute
--    casework-alert-escalation-tick and is error-isolated. Marking a deadline
--    missed and firing a user-set reminder_at belong to; the 1-3 day
--    steward warnings belong to W1-URGENT-A.
--
-- Storage is two private tables reached only through SECURITY DEFINER
-- functions; neither holds a user id, so neither joins the account lifecycle.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- The two cron targets this rides are re-declared from their installed
-- bodies (event_notice_sweep as wrapped with the case-graph gate,
-- casework_escalate_due_alerts as wrapped). Refuse any other predecessor.
do $predecessor$
declare
  r record;
  source text;
  digest text;
begin
  for r in select * from (values
    ('private.event_notice_sweep()', 'e76d50cb90b848a964d8ef5385c62bdc68ddfd6fb60a841b28c5e1e766cd0178'),
    ('private.casework_escalate_due_alerts(integer)', '61d826b97bc87d82d5c5996fa54a9dbd0fae40d624e254425e3dbedbb131eb5e')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc into strict source
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(r.signature);
    digest := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
      'hex'
    );
    if digest is distinct from r.source_sha256 then
      raise exception 'unreviewed % predecessor: %', r.signature, digest
        using errcode = '55000';
    end if;
  end loop;
end;
$predecessor$;

-- ---------------------------------------------------------------------------
-- 1. Organization switches and limits
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old default ON: onEventCreated ran on every new event, no flag
  -- (de7df4b57c^:app/dashboard/events/actions.ts:67, lib/handoffs/event-handoffs.ts).
  ('features.automation.event_announcement_drafts', 'boolean', 'Draft an announcement for new events',
   'When an event is created, prepare a draft announcement for the chapter''s stewards to review. Drafts are never sent automatically.',
   'true', null, null, null, 50, 'automation', false),
  -- Old default ON: onPollClosed ran on every close, no flag
  -- (de7df4b57c^:app/dashboard/live-poll/actions.ts:299, lib/handoffs/poll-handoffs.ts).
  ('features.automation.poll_results_notice', 'boolean', 'Tell voters when poll results are ready',
   'When a live poll closes, send everyone who voted an in-app notice that the results are ready (not for staff-only results).',
   'true', null, null, null, 60, 'automation', false),
  ('features.automation.poll_low_participation_alert', 'boolean', 'Low poll participation alert',
   'When a live poll closes with fewer voters than the threshold, notify the staff member who created it.',
   'true', null, null, null, 70, 'automation', false),
  -- Old default 10: action_participation_alert_threshold
  -- (de7df4b57c^:supabase/migrations/0161_handoff_settings_seed.sql:42).
  ('limits.automation.poll_low_participation_threshold', 'integer', 'Low poll participation threshold',
   'A closed live poll with fewer distinct voters than this sends the low-participation alert.',
   '10', 1, 1000, null, 80, 'automation', false),
  -- Old default ON: gc_flag_escalations ran hourly with no flag
  -- (de7df4b57c^:vercel.ts:59, supabase/migrations/0242_gc_tasks_escalation.sql).
  ('features.casework.gc_escalation_flags', 'boolean', 'Coordinator escalation flags',
   'Flag case deadlines that are overdue or close to due as coordinator badges.',
   'true', null, null, null, 300, 'casework', true),
  -- Old window: due_date between today and today + 2 days (0242, critical_deadline).
  ('limits.casework.gc_escalation_due_hours', 'integer', 'Coordinator escalation window (hours)',
   'A filing, response, hearing or appeal deadline due within this many hours is flagged as a critical deadline.',
   '48', 1, 336, null, 310, 'casework', true),
  -- The old flags had no notification; the record restores one, on by default.
  ('features.casework.gc_escalation_notify', 'boolean', 'Notify coordinators of escalations',
   'Notify the case coordinator (or the chapter''s coordinators) once when a deadline is newly flagged or becomes overdue.',
   'true', null, null, null, 320, 'casework', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Private storage
-- ---------------------------------------------------------------------------

-- Nothing that existed before this migration is followed up.
create table private.automation_follow_up_state (
  singleton boolean primary key default true check (singleton),
  installed_at timestamptz not null
);

insert into private.automation_follow_up_state (singleton, installed_at)
values (true, pg_catalog.now())
on conflict (singleton) do nothing;

create table private.engagement_follow_ups (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  chapter_id text,
  source_kind text not null check (source_kind in ('event', 'live_poll')),
  source_id text not null check (pg_catalog.char_length(source_id) between 1 and 128),
  kind text not null check (kind in ('announcement_draft', 'poll_results_notice', 'poll_low_participation_alert')),
  state text not null check (state in ('draft', 'published', 'dismissed', 'sent', 'skipped')),
  title text check (title is null or pg_catalog.char_length(pg_catalog.btrim(title)) between 1 and 120),
  body text check (body is null or pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 4000),
  recipients integer not null default 0 check (recipients >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  resolved_at timestamptz,
  unique (source_kind, source_id, kind),
  constraint engagement_follow_ups_draft_shape check (
    (kind = 'announcement_draft') = (title is not null and body is not null)
    and (kind <> 'announcement_draft' or state in ('draft', 'published', 'dismissed'))
    and (kind = 'announcement_draft' or state in ('sent', 'skipped'))
  )
);

create index engagement_follow_ups_drafts_idx
  on private.engagement_follow_ups (organization_id, chapter_id, created_at desc)
  where kind = 'announcement_draft' and state = 'draft';

create table private.casework_escalation_flags (
  deadline_id uuid primary key,
  organization_id uuid not null,
  chapter_id text not null,
  case_id uuid not null,
  reason text not null check (reason in ('overdue', 'critical_deadline')),
  flagged_at timestamptz not null default pg_catalog.now(),
  notified_reason text check (notified_reason is null or notified_reason in ('overdue', 'critical_deadline')),
  notified_at timestamptz
);

create index casework_escalation_flags_case_idx
  on private.casework_escalation_flags (case_id);

-- The per-minute flag scan reads open deadlines by due time. (Named apart from
-- 20261002143000's casework_deadlines_open_due_idx, whose predicate differs.)
create index casework_deadlines_escalation_due_idx
  on public.casework_deadlines (due_at)
  where status in ('active', 'missed');

revoke all on table private.automation_follow_up_state from public, anon, authenticated, service_role;
revoke all on table private.engagement_follow_ups from public, anon, authenticated, service_role;
revoke all on table private.casework_escalation_flags from public, anon, authenticated, service_role;

comment on table private.engagement_follow_ups is
  'REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001: one row per follow-up (an event''s draft announcement, a closed poll''s results notice and low-participation alert). Reached only through SECURITY DEFINER functions.';
comment on table private.casework_escalation_flags is
  'REQ-UG-GC-ESCALATION-FLAGS-20261001: the current coordinator escalation flag of each qualifying casework deadline and the last reason its coordinators were notified of. Rows clear when the deadline stops qualifying.';

insert into private.notification_copy (key, lang, title, body) values
  ('poll.results', 'en', 'Poll results are ready', 'A poll you voted in has closed. Open the app to see the results.'),
  ('poll.results', 'es', 'Los resultados de la votación están listos', 'Una votación en la que participaste cerró. Abre la app para ver los resultados.'),
  ('poll.low_participation', 'en', 'Low turnout on a poll', 'A poll you created closed with low participation. Open the app for details.'),
  ('poll.low_participation', 'es', 'Poca participación en una votación', 'Una votación que creaste cerró con poca participación. Abre la app para ver los detalles.'),
  ('casework.escalation.overdue', 'en', 'A case deadline is overdue', 'A case deadline you coordinate has passed. Open Casework to review it.'),
  ('casework.escalation.overdue', 'es', 'Un plazo de caso está vencido', 'Venció un plazo de un caso que coordinas. Abre Casos para revisarlo.'),
  ('casework.escalation.critical', 'en', 'A case deadline is close', 'A case deadline you coordinate is due soon. Open Casework to review it.'),
  ('casework.escalation.critical', 'es', 'Un plazo de caso está cerca', 'Un plazo de un caso que coordinas vence pronto. Abre Casos para revisarlo.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- ---------------------------------------------------------------------------
-- 3. Event and poll follow-up sweep
-- ---------------------------------------------------------------------------

create function private.engagement_follow_up_sweep(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  since timestamptz;
  ev record;
  poll record;
  voter uuid;
  voters integer;
  notified integer;
  threshold integer;
  drafts integer := 0;
  polls integer := 0;
  location_line text;
begin
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid follow-up limit' using errcode = '22023';
  end if;
  select s.installed_at into since from private.automation_follow_up_state s where s.singleton;
  if since is null then
    return pg_catalog.jsonb_build_object('drafts', 0, 'polls', 0);
  end if;

  -- New event -> one draft announcement for the event chapter's stewards.
  for ev in
    select e.id, e.title, e.starts_at, e.location, e.chapter_id, ch.organization_id
    from public.member_events e
    join public.chapters ch on ch.id = e.chapter_id
    join public.organizations o on o.id = ch.organization_id and o.status = 'active'
    where e.cancelled_at is null
      and e.created_at >= since
      and e.created_at >= pg_catalog.now() - interval '1 day'
      and e.starts_at > pg_catalog.now()
      and not exists (
        select 1 from private.engagement_follow_ups f
        where f.source_kind = 'event' and f.source_id = e.id and f.kind = 'announcement_draft'
      )
      and private.organization_feature_enabled(ch.organization_id, 'features.automation.event_announcement_drafts')
    order by e.created_at, e.id
    limit p_limit
  loop
    location_line := case when pg_catalog.btrim(coalesce(ev.location, '')) <> ''
      then pg_catalog.chr(10) || 'Location: ' || pg_catalog.btrim(ev.location) else '' end;
    insert into private.engagement_follow_ups (
      organization_id, chapter_id, source_kind, source_id, kind, state, title, body
    ) values (
      ev.organization_id, ev.chapter_id, 'event', ev.id, 'announcement_draft', 'draft',
      pg_catalog.left('Upcoming: ' || pg_catalog.btrim(ev.title), 120),
      -- Old copy (event-handoffs.ts), dated in UTC like the old server.
      pg_catalog.left(pg_catalog.btrim(ev.title) || pg_catalog.chr(10) || pg_catalog.chr(10)
        || 'Date: ' || pg_catalog.to_char(ev.starts_at at time zone 'UTC', 'FMDay, FMMonth FMDD')
        || location_line || pg_catalog.chr(10) || pg_catalog.chr(10)
        || 'RSVP in the app under Events.', 4000)
    ) on conflict (source_kind, source_id, kind) do nothing;
    if found then drafts := drafts + 1; end if;
  end loop;

  -- Closed live poll -> results notice to voters, low-participation alert to
  -- its creator.
  for poll in
    select p.id, p.organization_id, p.chapter_id, p.created_by, p.results_visibility
    from public.organization_live_polls p
    join public.organizations o on o.id = p.organization_id and o.status = 'active'
    where p.state = 'closed'
      and p.closed_at >= since
      and p.closed_at >= pg_catalog.now() - interval '7 days'
      and not exists (
        select 1 from private.engagement_follow_ups f
        where f.source_kind = 'live_poll' and f.source_id = p.id::text and f.kind = 'poll_results_notice'
      )
    order by p.closed_at, p.id
    limit p_limit
  loop
    select pg_catalog.count(distinct v.voter_user_id) into voters
    from public.organization_live_poll_votes v
    where v.poll_id = poll.id and v.organization_id = poll.organization_id;

    notified := 0;
    if poll.results_visibility <> 'staff_only'
       and private.organization_feature_enabled(poll.organization_id, 'features.automation.poll_results_notice') then
      for voter in
        select distinct v.voter_user_id
        from public.organization_live_poll_votes v
        join public.organization_memberships m
          on m.organization_id = v.organization_id and m.user_id = v.voter_user_id
         and m.status = 'active' and m.revoked_at is null
        where v.poll_id = poll.id and v.organization_id = poll.organization_id
      loop
        perform private.notify_member(voter, 'poll.results', '{}'::jsonb, 'votes');
        notified := notified + 1;
      end loop;
    end if;
    insert into private.engagement_follow_ups (organization_id, chapter_id, source_kind, source_id, kind, state, recipients)
    values (poll.organization_id, poll.chapter_id, 'live_poll', poll.id::text, 'poll_results_notice',
      case when notified > 0 then 'sent' else 'skipped' end, notified)
    on conflict (source_kind, source_id, kind) do nothing;

    threshold := private.organization_limit(poll.organization_id, 'limits.automation.poll_low_participation_threshold');
    notified := 0;
    if voters < threshold
       and poll.created_by is not null
       and private.organization_feature_enabled(poll.organization_id, 'features.automation.poll_low_participation_alert')
       and exists (
         select 1 from public.organization_memberships m
         where m.organization_id = poll.organization_id and m.user_id = poll.created_by
           and m.status = 'active' and m.revoked_at is null
       )
       and (
         exists (
           select 1 from public.organization_role_grants g
           where g.organization_id = poll.organization_id and g.user_id = poll.created_by
             and g.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
         )
         or exists (
           select 1 from public.member_role_chapters r
           join public.chapters ch on ch.id = r.chapter_id and ch.organization_id = poll.organization_id
           join public.member_chapter_memberships cm
             on cm.user_id = r.user_id and cm.chapter_id = r.chapter_id and cm.status = 'active'
           where r.user_id = poll.created_by
             and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
         )
       ) then
      perform private.notify_member(poll.created_by, 'poll.low_participation', '{}'::jsonb, 'general');
      notified := 1;
    end if;
    insert into private.engagement_follow_ups (organization_id, chapter_id, source_kind, source_id, kind, state, recipients)
    values (poll.organization_id, poll.chapter_id, 'live_poll', poll.id::text, 'poll_low_participation_alert',
      case when notified > 0 then 'sent' else 'skipped' end, notified)
    on conflict (source_kind, source_id, kind) do nothing;
    polls := polls + 1;
  end loop;

  return pg_catalog.jsonb_build_object('drafts', drafts, 'polls', polls);
end;
end;
$function$;

comment on function private.engagement_follow_up_sweep(integer) is
  'REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001: drafts an announcement for each new event (never sent) and, for each newly closed live poll, sends voters a results notice and the poll''s creator a low-participation alert, each behind its organization switch. Runs inside event-notices-tick.';

create function public.list_announcement_drafts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  chapter text;
  rows jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not private.member_has_chapter_role(chapter, array['steward']) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'title', f.title, 'body', f.body, 'eventId', f.source_id, 'createdAt', f.created_at
    ) order by f.created_at desc, f.id), '[]'::jsonb)
    into rows
  from (
    select f.* from private.engagement_follow_ups f
    join public.member_events e on e.id = f.source_id and e.chapter_id = f.chapter_id and e.cancelled_at is null
    where f.organization_id = org and f.chapter_id = chapter
      and f.kind = 'announcement_draft' and f.state = 'draft'
    order by f.created_at desc, f.id
    limit 20
  ) f;
  return pg_catalog.jsonb_build_object('organizationId', org, 'drafts', rows);
end;
$function$;

create function public.resolve_announcement_draft(p_draft_id uuid, p_state text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid;
  chapter text;
  resolved uuid;
begin
  if actor is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if p_state is null or p_state not in ('published', 'dismissed') then
    raise exception 'invalid draft state' using errcode = '22023';
  end if;
  org := private.current_member_organization();
  chapter := private.current_member_chapter();
  if org is null or chapter is null or not private.member_has_chapter_role(chapter, array['steward']) then
    raise exception 'chapter steward role required' using errcode = '42501';
  end if;
  update private.engagement_follow_ups f
     set state = p_state, resolved_at = pg_catalog.now()
   where f.id = p_draft_id and f.organization_id = org and f.chapter_id = chapter
     and f.kind = 'announcement_draft' and f.state = 'draft'
  returning f.id into resolved;
  if resolved is null then
    raise exception 'draft unavailable' using errcode = '22023';
  end if;
  perform private.cr108_record_audit(
    org, 'announcement_draft_resolved', 'update', 'broadcast', resolved::text, actor,
    pg_catalog.jsonb_build_object('status', p_state), extensions.gen_random_uuid()
  );
  return pg_catalog.jsonb_build_object('organizationId', org, 'id', resolved, 'state', p_state);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Grievance-coordinator escalation flags
-- ---------------------------------------------------------------------------

create function private.casework_flag_escalations(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  flag record;
  recipient uuid;
  changed integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'invalid escalation limit' using errcode = '22023';
  end if;

  -- Clear every flag whose deadline no longer qualifies (met, extended,
  -- waived, removed, case no longer active, switch off, or out of window).
  delete from private.casework_escalation_flags f
  where not exists (
    select 1
    from public.casework_deadlines d
    join public.member_cases c on c.id = d.case_id and c.organization_id = d.organization_id and c.status = 'active'
    where d.id = f.deadline_id
      and d.status in ('active', 'missed')
      and (d.due_at < pg_catalog.now()
        or (d.kind <> 'follow_up'
          and d.due_at <= pg_catalog.now() + pg_catalog.make_interval(hours => private.organization_limit(d.organization_id, 'limits.casework.gc_escalation_due_hours'))))
      and private.organization_feature_enabled(d.organization_id, 'features.casework.gc_escalation_flags')
  );

  -- Raise or escalate flags (old gc_flag_escalations: overdue first, then
  -- high/urgent within the window, which today are the contractual kinds).
  insert into private.casework_escalation_flags as f (deadline_id, organization_id, chapter_id, case_id, reason)
  select d.id, d.organization_id, d.chapter_id, d.case_id,
         case when d.due_at < pg_catalog.now() then 'overdue' else 'critical_deadline' end
  from public.casework_deadlines d
  join public.member_cases c on c.id = d.case_id and c.organization_id = d.organization_id and c.status = 'active'
  join public.organizations o on o.id = d.organization_id and o.status = 'active'
  where d.status in ('active', 'missed')
    and d.due_at <= pg_catalog.now() + interval '336 hours'
    and (d.due_at < pg_catalog.now()
      or (d.kind <> 'follow_up'
        and d.due_at <= pg_catalog.now() + pg_catalog.make_interval(hours => private.organization_limit(d.organization_id, 'limits.casework.gc_escalation_due_hours'))))
    and private.organization_feature_enabled(d.organization_id, 'features.casework.gc_escalation_flags')
    and not exists (
      select 1 from private.casework_escalation_flags existing
      where existing.deadline_id = d.id
        and existing.reason = case when d.due_at < pg_catalog.now() then 'overdue' else 'critical_deadline' end
    )
  order by d.due_at, d.id
  limit p_limit
  on conflict (deadline_id) do update
    set reason = excluded.reason, flagged_at = pg_catalog.now();

  -- Notify once per new or escalated reason.
  for flag in
    select f.*
    from private.casework_escalation_flags f
    where f.notified_reason is distinct from f.reason
    order by f.flagged_at, f.deadline_id
    limit p_limit
    for update of f skip locked
  loop
    if private.organization_feature_enabled(flag.organization_id, 'features.casework.gc_escalation_notify') then
      for recipient in
        select distinct candidate.user_id
        from (
          select c.coordinator_user_id as user_id, 0 as rank
          from public.member_cases c where c.id = flag.case_id and c.coordinator_user_id is not null
          union all
          select g.user_id, 1
          from public.member_role_chapters g
          join public.member_chapter_memberships cm
            on cm.user_id = g.user_id and cm.chapter_id = g.chapter_id and cm.status = 'active'
          where g.chapter_id = flag.chapter_id and g.role = 'coordinator'
            and not exists (select 1 from public.member_cases c where c.id = flag.case_id and c.coordinator_user_id is not null)
          union all
          select g.user_id, 1
          from public.organization_role_grants g
          where g.organization_id = flag.organization_id and g.role = 'coordinator'
            and not exists (select 1 from public.member_cases c where c.id = flag.case_id and c.coordinator_user_id is not null)
        ) candidate
        where private.casework_reminder_owner_can_read(candidate.user_id, flag.case_id)
        order by candidate.user_id
        limit 10
      loop
        perform private.notify_member(recipient,
          case flag.reason when 'overdue' then 'casework.escalation.overdue' else 'casework.escalation.critical' end,
          '{}'::jsonb, 'deadlines');
      end loop;
    end if;
    update private.casework_escalation_flags
       set notified_reason = flag.reason, notified_at = pg_catalog.now()
     where deadline_id = flag.deadline_id;
    changed := changed + 1;
  end loop;
  return changed;
end;
end;
$function$;

comment on function private.casework_flag_escalations(integer) is
  'REQ-UG-GC-ESCALATION-FLAGS-20261001: per-minute, bounded, idempotent coordinator escalation flags on casework deadlines (overdue; contractual kinds inside limits.casework.gc_escalation_due_hours), cleared when they stop qualifying, with one kind-deadlines notice per new reason to the case coordinator or chapter coordinators who can read the case. Runs inside casework-alert-escalation-tick.';

create function public.casework_get_escalation_flags(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  rows jsonb;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if p_case_id is null or not private.casework_staff_can_access(p_case_id) then
    raise exception 'case unavailable' using errcode = '42501';
  end if;
  select c.organization_id into org from public.member_cases c where c.id = p_case_id;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'deadlineId', f.deadline_id, 'reason', f.reason, 'flaggedAt', f.flagged_at
    ) order by f.flagged_at, f.deadline_id), '[]'::jsonb)
    into rows
  from private.casework_escalation_flags f
  where f.case_id = p_case_id and f.organization_id = org;
  return pg_catalog.jsonb_build_object(
    'caseId', p_case_id,
    'enabled', private.organization_feature_enabled(org, 'features.casework.gc_escalation_flags'),
    'dueHours', private.organization_limit(org, 'limits.casework.gc_escalation_due_hours'),
    'flags', rows
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Ride the existing mirrored jobs
-- ---------------------------------------------------------------------------

create or replace function private.event_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  r record;
  m record;
begin
  for r in
    select e.id from public.member_events e
    where e.reminder_notice_sent_at is null
      and e.starts_at > now()
      and e.starts_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_events set reminder_notice_sent_at = now() where id = r.id;
    for m in
      select rv.user_id
      from public.member_event_rsvps rv
      join public.member_profiles recipient on recipient.id = rv.user_id
      join public.member_events e on e.id = rv.event_id
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = e.chapter_id
      where rv.event_id = r.id and rv.status = 'going'
        and (
          recipient.chapter_id = e.chapter_id
          or e.is_public_across_agencies
          or (e.is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member(m.user_id, 'event.reminder', '{}'::jsonb, 'events');
    end loop;
  end loop;
  -- REQ-UG-EVENT-AND-POLL-FOLLOW-UPS-20261001 (20261003032000): event
  -- draft announcements and closed-poll follow-ups ride this tick. A fault
  -- there never undoes the reminders above.
  begin
    perform private.engagement_follow_up_sweep(100);
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'engagement_follow_up_sweep failed: % (%)', sqlerrm, sqlstate;
  end;
end;
end;
$function$;

create or replace function private.casework_escalate_due_alerts(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_alert public.casework_alerts%rowtype; v_count integer := 0;
begin
  for v_alert in
    select * from public.casework_alerts where status = 'open' and escalation_due_at <= pg_catalog.now()
    order by escalation_due_at, id for update skip locked limit least(greatest(p_limit, 1), 1000)
  loop
    update public.casework_alerts set status = 'escalated', escalated_at = pg_catalog.now() where id = v_alert.id;
    insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
    values (v_alert.organization_id, v_alert.chapter_id, v_alert.case_id, null, 'alert_escalated', 'alert', v_alert.id);
    v_count := v_count + 1;
  end loop;
  -- REQ-UG-GC-ESCALATION-FLAGS-20261001 (20261003032000): automatic
  -- coordinator flags ride this tick. A fault there never undoes the manual
  -- alert escalations above.
  begin
    perform private.casework_flag_escalations(200);
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'casework_flag_escalations failed: % (%)', sqlerrm, sqlstate;
  end;
  return v_count;
end;
end;
$function$;

revoke all on function private.engagement_follow_up_sweep(integer) from public, anon, authenticated, service_role;
revoke all on function private.casework_flag_escalations(integer) from public, anon, authenticated, service_role;
revoke all on function public.list_announcement_drafts() from public, anon, authenticated, service_role;
revoke all on function public.resolve_announcement_draft(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.casework_get_escalation_flags(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_announcement_drafts() to authenticated;
grant execute on function public.resolve_announcement_draft(uuid, text) to authenticated;
grant execute on function public.casework_get_escalation_flags(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
