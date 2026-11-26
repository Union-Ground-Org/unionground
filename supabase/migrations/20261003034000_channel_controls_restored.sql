-- REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001.
--
-- The "Messaging channel controls contract" brings back the six chapter
-- channel controls that 20260907122000_retire_dormant_channel_controls retired:
--
--   thread pinning                   chapter_threads.pinned_at, staff-only RPC
--   per-channel notification levels  chapter_space_notification_settings.notification_level
--   channel mute                     chapter_space_notification_settings.muted / muted_until
--   structured mentions and @here    chapter_thread_posts.mentioned_user_ids + body @here token
--   mention search                   public.search_my_channel_mentions
--   keyword alerts / highlighting    chapter_space_notification_settings.keywords
--
-- Each one returns as a complete capability, not a column and a grant:
--
--   * Server authorization. No client grant writes pinned_at, a level, a mute
--     or a keyword. Every write is a SECURITY DEFINER RPC that checks the
--     MFA-assured caller, the current organization, current read access to the
--     channel and the organization switch. The one client-writable addition,
--     chapter_thread_posts.mentioned_user_ids, is sanitized by a BEFORE INSERT
--     trigger: switch off -> empty, self and duplicates dropped, and anyone who
--     cannot read the channel removed without saying so.
--   * Real notification production. An AFTER INSERT trigger on
--     chapter_thread_posts produces member_notifications rows through
--     private.notify_member with the new 'messages' kind. That kind is
--     outbound-eligible, so the existing pipeline applies the member's topic
--     preference, the hour/day/weekly caps, the outbound kill switch, the
--     stress-ledger egress guard, and quiet hours / Do not disturb at claim time.
--   * Deterministic, tenant-scoped mute precedence (private.channel_alert_decision):
--
--       order  check                                         result
--       1      recipient cannot read the channel now         dropped (never disclosed)
--       2      the reason's switch is off in the channel's   'switch_off'
--              organization
--       3      channel mute active (switch on, muted, and    'muted'
--              muted_until null or in the future), except a
--              direct mention of the muted person (D6)
--       4      level 'none'                                  'level_none'
--       5      level 'mentions' and reason is a plain post   'level_mentions'
--       6      otherwise                                     'deliver'
--
--     Reasons rank mention > @here > keyword > plain post; one post produces at
--     most one notice per person. Every setting row is keyed by the channel's
--     own organization, and switches are read from that organization, never
--     from whichever organization the recipient has selected. A channel mute or
--     level never reaches direct conversations, task conversations (even a task
--     linked to a channel thread), announcements, or urgent-classified notices
--     ('deadlines', 'cases'): none of those producers consult this table, and
--     urgent notices keep the existing urgent rules in member_focus_blocks.
--   * @here reaches only channel members who are online now: member_presence
--     (the existing one-row-per-member heartbeat, no new log) with status
--     'online' inside a five-minute window, capped at 200 people, one @here per
--     author per channel per ten minutes, six per hour and twenty per day per
--     author across the organization (old lib/messages/here-dispatch.ts:
--     HERE_MENTION_COOLDOWN_MS, HERE_AUDIENCE_QUERY_LIMIT, Patch2DA budget).
--   * Mention search reads only live bodies. Channel post bodies are immutable
--     and have no tombstone; a post carrying deleted_at is never searched, and
--     direct-message bodies (which can be redacted) are not part of this search.
--
-- Defaults (: the old app's effective production default).
-- The old app had no flag for any of these: lib/settings/feature-flags.ts and
-- lib/settings/settings-keys.ts at de7df4b57c^ name none of them, and the
-- behaviors shipped always-on (lib/messages/here-dispatch.ts "V2 order 27",
-- lib/messages/keyword-highlight.ts "V2 order 30", 0392_mention_search_rpc.sql,
-- 0578_quiet_hours_and_mutes.sql channel_mutes). So every switch starts ON.
-- The keyword limit defaults to 10 per member (lane brief); the old app capped
-- keywords at 20 per channel and 48 characters each
-- (lib/dashboard/member-preferences.ts MAX_KEYWORD_ALERTS_PER_CHANNEL,
-- MAX_KEYWORD_ALERT_LENGTH), which the per-channel bound below keeps.
--
-- Level default 'mentions'. The old app deliberately had no per-post fan-out
-- for group channels (here-dispatch.ts header); only mentions and @here
-- pinged. 'mentions' keeps exactly that until a member opts into 'all'.
--
-- Settings live in their own table, not on chapter_space_members, because a
-- chapter_space_members row is an ACCESS grant for a private channel. A member
-- choosing a notification level on a chapter-wide channel must not acquire a
-- membership row that would keep them inside the channel if staff later made
-- it private.

begin;

set local lock_timeout = '5s';

do $preconditions$
begin
  if pg_catalog.to_regprocedure('private.organization_feature_enabled(uuid, text)') is null
     or pg_catalog.to_regprocedure('private.organization_limit(uuid, text)') is null then
    raise exception 'apply the feature switches and limits registry first (REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001)'
      using errcode = '42883';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure))
     <> '2ec5c00743fcd7bf5eec7b4af512fc48' then
    raise exception 'notification enqueue changed since 20260913031500; re-derive the channel controls re-emission';
  end if;
end
$preconditions$;

-- ---------------------------------------------------------------------------
-- 1. Organization switches and the keyword limit.
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.messaging.channel_pinning', 'boolean', 'Thread pinning',
   'Chapter staff can pin channel threads so they stay at the top of the channel for every reader.',
   'true', null, null, null, 10, 'messaging', true),
  ('features.messaging.channel_notification_levels', 'boolean', 'Channel notification levels',
   'Each member can choose every post, mentions only, or nothing for each chapter channel.',
   'true', null, null, null, 20, 'messaging', true),
  ('features.messaging.channel_mute', 'boolean', 'Channel mute',
   'Each member can mute a chapter channel for a while or until they unmute it. Direct, task and announcement notices are never muted by it.',
   'true', null, null, null, 30, 'messaging', true),
  ('features.messaging.mentions', 'boolean', 'Mentions',
   'Members can mention people who can read the channel, and each mentioned person is notified.',
   'true', null, null, null, 40, 'messaging', true),
  ('features.messaging.here_mentions', 'boolean', '@here mentions',
   'A channel post containing @here notifies the channel members who are online right now.',
   'true', null, null, null, 50, 'messaging', true),
  ('features.messaging.mention_search', 'boolean', 'Mention search',
   'Members can search the channel posts that mention them.',
   'true', null, null, null, 60, 'messaging', true),
  ('features.messaging.keyword_alerts', 'boolean', 'Keyword alerts and highlighting',
   'Members can save keywords per channel. Matching posts are highlighted and notify them.',
   'true', null, null, null, 70, 'messaging', true),
  ('limits.messaging.keyword_alerts_per_member', 'integer', 'Keyword alerts per member',
   'Most keywords one member can watch across every channel in this organization.',
   '10', 1, 50, null, 80, 'messaging', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The 'messages' notification topic.
-- ---------------------------------------------------------------------------

alter table public.member_notifications
  drop constraint if exists member_notifications_kind_check;
alter table public.member_notifications
  add constraint member_notifications_kind_check
  check (kind in (
    'general', 'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks',
    'appointments', 'workload', 'dues', 'messages'
  )) not valid;
alter table public.member_notifications validate constraint member_notifications_kind_check;

-- Shoulder test: the copy names the author and nothing about the channel, the
-- thread or the post. A lock screen on a break-room table must not disclose it.
insert into private.notification_copy (key, lang, title, body) values
  ('channel.mention', 'en', '{name} mentioned you in a chapter channel', 'Open Messages to read it.'),
  ('channel.mention', 'es', '{name} te mencionó en un canal del capítulo', 'Abre Mensajes para leerlo.'),
  ('channel.here', 'en', '{name} pinged everyone online in a chapter channel', 'Open Messages to read it.'),
  ('channel.here', 'es', '{name} avisó a todos los conectados en un canal del capítulo', 'Abre Mensajes para leerlo.'),
  ('channel.keyword', 'en', 'A chapter channel post matched one of your keywords', 'Open Messages to read it.'),
  ('channel.keyword', 'es', 'Una publicación de un canal coincidió con una de tus palabras clave', 'Abre Mensajes para leerla.'),
  ('channel.post', 'en', '{name} posted in a chapter channel you follow', 'Open Messages to read it.'),
  ('channel.post', 'es', '{name} publicó en un canal del capítulo que sigues', 'Abre Mensajes para leerlo.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- Synthetic demo/stress identities keep their explicit no-egress posture for
-- the new topic, as 20260831205804 did for 'dues'. The enqueue stress-ledger
-- guard stays the second, independent boundary.
update public.member_profiles p
set notification_prefs = p.notification_prefs || '{"messages": false}'::jsonb
where exists (
  select 1 from private.member_stress_ledger l where l.user_id = p.id
)
and (p.notification_prefs -> 'messages') is distinct from 'false'::jsonb;

-- 20260913031500's installed enqueue, byte for byte, with 'messages' added to
-- the outbound-eligible list. Preferences, caps, kill switch and egress guard
-- are unchanged and now apply to channel notices too.
CREATE OR REPLACE FUNCTION private.enqueue_notification_deliveries()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  recent_week integer := 0;
  org_today integer;
  limit_reason text;
  transactional_receipt boolean := new.kind = 'workload' and new.workload_event = 'receipt';
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_per_recipient_week constant integer := 5;
  max_org_day constant integer := 20000;
begin
  -- Only a receipt created/locked by this very transaction can suppress task
  -- transport. A caller-set GUC alone, an old receipt, or another backend's
  -- pending receipt grants nothing. In-app notifications and audit still run.
  if new.kind='tasks' and exists(
    select 1 from public.organization_automation_effects e
    join public.organization_automation_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.status='in_progress'
    join public.organization_automation_definitions d on d.id=e.definition_id and d.schema_version=2
    where e.id::text=current_setting('app.automation_task_receipt',true)
    and e.status='pending' and e.mutation_xid=pg_current_xact_id()
    and e.action_kind in ('create_standard_task','assign_task','raise_task_priority')
    and (d.version=r.definition_version or e.rollback_target is not null)
  ) then return new; end if;
  if new.kind not in (
    'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks',
    'appointments', 'workload', 'dues', 'messages'
  ) then
    return new;
  end if;
  if exists (
    select 1 from private.member_stress_ledger l
    where l.user_id = new.user_id
  ) then
    return new;
  end if;
  begin
    select controls.outbound_enabled into outbound_on
    from private.notification_controls controls where controls.id;
    if not coalesce(outbound_on, false) then return new; end if;
    select p.notification_prefs into prefs
    from public.member_profiles p where p.id = new.user_id;
    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then return new; end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0)
    );
    select pg_catalog.count(*) into recent_hour
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '1 hour';
    select pg_catalog.count(*) into recent_day
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '24 hours';
    if new.kind not in ('deadlines', 'cases') and not transactional_receipt then
      select pg_catalog.count(*) into recent_week
      from public.member_notification_deliveries d
      join public.member_notifications n2 on n2.id = d.notification_id
      where d.user_id = new.user_id
        and d.channel = 'email'
        and d.status <> 'skipped'
        and d.created_at > pg_catalog.now() - interval '7 days'
        and n2.kind not in ('deadlines', 'cases')
        and not (
          n2.kind = 'workload' and n2.workload_event = 'receipt'
        );
    end if;
    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
    from private.notification_outbound_counters c where c.day = current_date;
    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and not transactional_receipt
      and recent_week >= max_per_recipient_week then
      limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;
    if limit_reason is not null then
      insert into public.member_notification_deliveries (
        notification_id, user_id, channel, status, last_error
      ) values (
        new.id, new.user_id, 'email', 'skipped', limit_reason
      ) on conflict (notification_id, channel) do nothing;
      return new;
    end if;
    insert into private.notification_outbound_counters (day, shard, enqueued)
    values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
    on conflict (day, shard) do update
      set enqueued = private.notification_outbound_counters.enqueued + 1;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    ) values (
      new.id, new.user_id, 'email'
    ) on conflict (notification_id, channel) do nothing;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    )
    select new.id, new.user_id, 'push'
    where exists (
      select 1 from public.member_push_subscriptions s
      where s.user_id = new.user_id
    ) or exists (
      select 1 from public.member_native_push_installations i
      where i.user_id = new.user_id
    )
    on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
end;
$function$
;

-- 20260831205804's installed expiry sweep with the same one-word change, so a
-- 'messages' delivery is not terminalized as outbound-ineligible.
-- The body keeps the case-graph writer gate 20260907151000 installed on this
-- function (its first statement), as every restatement of a gated writer must.
create or replace function public.expire_notification_deliveries()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  expired integer := 0;
  exhausted integer := 0;
  ineligible integer := 0;
  receipt_promoted integer := 0;
  promoted_delta integer := 0;
begin
  with candidates as (
    select d.id, pg_catalog.min(r.delivered_at) as first_delivered_at
    from public.member_notification_deliveries d
    left join private.member_notification_push_target_receipts r on r.delivery_id = d.id
    where d.created_at < pg_catalog.now() - interval '48 hours'
      and (d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
    group by d.id
  ), updated as (
    update public.member_notification_deliveries d
      set status = case when c.first_delivered_at is null then 'skipped' else 'sent' end,
          sent_at = coalesce(d.sent_at, c.first_delivered_at),
          last_error = case when c.first_delivered_at is null then 'expired before dispatch' else null end,
          updated_at = pg_catalog.now()
    from candidates c where d.id = c.id
    returning c.first_delivered_at
  )
  select pg_catalog.count(*) filter (where first_delivered_at is null)::integer,
         pg_catalog.count(*) filter (where first_delivered_at is not null)::integer
    into expired, promoted_delta
    from updated;
  receipt_promoted := receipt_promoted + promoted_delta;

  with candidates as (
    select d.id, pg_catalog.min(r.delivered_at) as first_delivered_at
    from public.member_notification_deliveries d
    left join private.member_notification_push_target_receipts r on r.delivery_id = d.id
    where d.attempts >= 6
      and (d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
    group by d.id
  ), updated as (
    update public.member_notification_deliveries d
      set status = case when c.first_delivered_at is null then 'failed' else 'sent' end,
          sent_at = coalesce(d.sent_at, c.first_delivered_at),
          last_error = case when c.first_delivered_at is null
            then coalesce(d.last_error, 'attempt budget exhausted') else null end,
          updated_at = pg_catalog.now()
    from candidates c where d.id = c.id
    returning c.first_delivered_at
  )
  select pg_catalog.count(*) filter (where first_delivered_at is null)::integer,
         pg_catalog.count(*) filter (where first_delivered_at is not null)::integer
    into exhausted, promoted_delta
    from updated;
  receipt_promoted := receipt_promoted + promoted_delta;

  with candidates as (
    select d.id, pg_catalog.min(r.delivered_at) as first_delivered_at
    from public.member_notification_deliveries d
    join public.member_notifications n on n.id = d.notification_id
    left join private.member_notification_push_target_receipts r on r.delivery_id = d.id
    where n.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload', 'dues', 'messages')
      and (d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
    group by d.id
  ), updated as (
    update public.member_notification_deliveries d
      set status = case when c.first_delivered_at is null then 'skipped' else 'sent' end,
          sent_at = coalesce(d.sent_at, c.first_delivered_at),
          last_error = case when c.first_delivered_at is null
            then 'kind is not outbound-eligible' else null end,
          updated_at = pg_catalog.now()
    from candidates c where d.id = c.id
    returning c.first_delivered_at
  )
  select pg_catalog.count(*) filter (where first_delivered_at is null)::integer,
         pg_catalog.count(*) filter (where first_delivered_at is not null)::integer
    into ineligible, promoted_delta
    from updated;
  receipt_promoted := receipt_promoted + promoted_delta;

  return pg_catalog.jsonb_build_object(
    'expired', expired,
    'exhausted', exhausted,
    'ineligible', ineligible,
    'receiptPromoted', receipt_promoted);
end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Shared helpers. None is client-executable.
-- ---------------------------------------------------------------------------

-- Can THIS person read THIS channel right now? private.can_read_chapter_space
-- answers for the session's selected chapter; a notification audience needs
-- the same rule for someone else. Membership-based: an active organization
-- membership and an active membership of the channel's chapter, then the
-- channel's visibility rule. Staff-only channels also require the staff
-- two-step standing member_has_role would require of that person.
create function private.channel_member_can_read_space(p_user_id uuid, p_space_id uuid)
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
        s.visibility = 'chapter'
        or s.created_by = p_user_id
        or exists (
          select 1 from public.chapter_space_members sm
          where sm.space_id = s.id and sm.user_id = p_user_id
        )
        or (
          s.visibility = 'staff'
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
        )
      )
  );
$function$;

-- A standalone @here token: not inside a word and not part of an address
-- ("team@here.org", "@heretic" never match). Old lib/messages/here-mention.ts.
create function private.channel_body_has_here(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(p_body, '') ~* '(^|[^a-z0-9_@])@here([^a-z0-9_]|$)';
$function$;

-- Keywords are stored lowercase and trimmed, 2-48 characters, no control
-- characters, no duplicates, at most 20 per channel (old
-- lib/dashboard/member-preferences.ts: 20 per channel, 48 characters).
create function private.channel_keywords_valid(p_keywords text[])
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select p_keywords is not null
    and coalesce(pg_catalog.cardinality(p_keywords), 0) <= 20
    and not exists (
      select 1 from pg_catalog.unnest(p_keywords) k(value)
      where k.value is null
        or k.value <> pg_catalog.lower(pg_catalog.btrim(k.value))
        or pg_catalog.char_length(k.value) not between 2 and 48
        or k.value ~ '[[:cntrl:]]'
    )
    and (select pg_catalog.count(distinct k.value) from pg_catalog.unnest(p_keywords) k(value))
      = coalesce(pg_catalog.cardinality(p_keywords), 0);
$function$;

-- Case-insensitive, whole-word: "overtime" matches "Overtime list", never
-- "overtimes". A boundary is any non-[a-z0-9_] neighbor, so "@jordan" anchors
-- too. Old lib/messages/keyword-highlight.ts buildKeywordPattern.
create function private.channel_keywords_match(p_body text, p_keywords text[])
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select exists (
    select 1 from pg_catalog.unnest(coalesce(p_keywords, '{}'::text[])) k(value)
    where pg_catalog.lower(coalesce(p_body, '')) ~ (
      '(^|[^a-z0-9_])'
      || pg_catalog.regexp_replace(k.value, '([.*+?^${}()|\[\]\\])', '\\\1', 'g')
      || '([^a-z0-9_]|$)'
    )
  );
$function$;

create function private.channel_control_switches(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'channelPinning', private.organization_feature_enabled(p_organization_id, 'features.messaging.channel_pinning'),
    'notificationLevels', private.organization_feature_enabled(p_organization_id, 'features.messaging.channel_notification_levels'),
    'channelMute', private.organization_feature_enabled(p_organization_id, 'features.messaging.channel_mute'),
    'mentions', private.organization_feature_enabled(p_organization_id, 'features.messaging.mentions'),
    'hereMentions', private.organization_feature_enabled(p_organization_id, 'features.messaging.here_mentions'),
    'mentionSearch', private.organization_feature_enabled(p_organization_id, 'features.messaging.mention_search'),
    'keywordAlerts', private.organization_feature_enabled(p_organization_id, 'features.messaging.keyword_alerts')
  );
$function$;

create function private.raise_channel_control_disabled(p_control text)
returns void
language plpgsql
-- It only raises, so STABLE readers (search_my_channel_mentions) may call it.
stable
set search_path = ''
as $function$
begin
  raise exception '% is turned off for this organization', p_control
    using errcode = '42501', detail = 'feature-disabled';
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Per-member channel notification settings (level, mute, keywords).
-- ---------------------------------------------------------------------------

create table public.chapter_space_notification_settings (
  organization_id uuid not null references public.organizations(id) on update cascade on delete restrict,
  space_id uuid not null references public.chapter_spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_level text not null default 'mentions',
  muted boolean not null default false,
  muted_until timestamptz,
  keywords text[] not null default '{}'::text[],
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (space_id, user_id),
  constraint chapter_space_notification_settings_level_check
    check (notification_level in ('all', 'mentions', 'none')),
  constraint chapter_space_notification_settings_mute_shape
    check (muted or muted_until is null),
  constraint chapter_space_notification_settings_keywords_shape
    check (private.channel_keywords_valid(keywords))
);

create index chapter_space_notification_settings_member_idx
  on public.chapter_space_notification_settings (organization_id, user_id);

alter table public.chapter_space_notification_settings enable row level security;

create policy mfa_assurance on public.chapter_space_notification_settings
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

-- Self-only read kept as a policy so a later grant can never widen it. There
-- is no client grant at all: the RPCs below are the only readers and writers.
create policy chapter_space_notification_settings_select_own on public.chapter_space_notification_settings
  for select to authenticated
  using ((select auth.uid()) = user_id);

comment on policy mfa_assurance on public.chapter_space_notification_settings is
  'Restrictive MFA floor every RLS table carries: no authenticated read or write of a member''s channel settings without an MFA-assured session.';
comment on policy chapter_space_notification_settings_select_own on public.chapter_space_notification_settings is
  'Self-only read of a member''s own channel notification settings. Defense in depth: the table has no client grant; the set_channel_* RPCs are the only writers and get_my_channel_controls the only reader.';

revoke all on public.chapter_space_notification_settings from public, anon, authenticated, service_role;

comment on table public.chapter_space_notification_settings is
  'One member''s notification level, mute and keyword alerts for one chapter channel (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001). Keyed by the channel''s own organization. Written only by the set_channel_* RPCs; no client grant. A row never grants access to a channel.';

create trigger a00_case_graph_lock before insert or update or delete on public.chapter_space_notification_settings
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_space_notification_settings
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

-- The precedence decision. Pure read; see the table in this file's header.
create function private.channel_alert_decision(
  p_organization_id uuid,
  p_space_id uuid,
  p_user_id uuid,
  p_reason text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  setting public.chapter_space_notification_settings%rowtype;
  levels_on boolean;
  reason_on boolean;
  effective_level text;
begin
  if p_reason not in ('mention', 'here', 'keyword', 'post') then
    raise exception 'unknown channel alert reason' using errcode = '22023';
  end if;
  levels_on := private.organization_feature_enabled(p_organization_id, 'features.messaging.channel_notification_levels');
  reason_on := case p_reason
      when 'mention' then private.organization_feature_enabled(p_organization_id, 'features.messaging.mentions')
      when 'here' then private.organization_feature_enabled(p_organization_id, 'features.messaging.here_mentions')
      when 'keyword' then private.organization_feature_enabled(p_organization_id, 'features.messaging.keyword_alerts')
      else levels_on
    end;
  if not reason_on then
    return 'switch_off';
  end if;
  select * into setting
  from public.chapter_space_notification_settings s
  where s.organization_id = p_organization_id and s.space_id = p_space_id and s.user_id = p_user_id;
  if found
     and private.organization_feature_enabled(p_organization_id, 'features.messaging.channel_mute')
     and setting.muted
     and p_reason <> 'mention'
     and (setting.muted_until is null or setting.muted_until > pg_catalog.now()) then
    return 'muted';
  end if;
  effective_level := case when levels_on then coalesce(setting.notification_level, 'mentions') else 'mentions' end;
  if effective_level = 'none' then
    return 'level_none';
  end if;
  if effective_level = 'mentions' and p_reason = 'post' then
    return 'level_mentions';
  end if;
  return 'deliver';
end;
$function$;

-- The channel a setter acts on: readable by the caller right now, inside the
-- caller's current organization. Missing and unauthorized look the same.
create function private.channel_settings_target(p_space_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  space_org uuid;
begin
  select c.organization_id into space_org
  from public.chapter_spaces s
  join public.chapters c on c.id = s.chapter_id
  where s.id = p_space_id
    and s.archived_at is null
    and private.can_read_chapter_space(s);
  if space_org is null or space_org is distinct from private.current_member_organization()
     or not private.is_organization_member(space_org) then
    raise exception 'channel unavailable' using errcode = 'P0002';
  end if;
  return space_org;
end;
$function$;

create function private.channel_settings_json(p_row public.chapter_space_notification_settings)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'spaceId', p_row.space_id,
    'level', coalesce(p_row.notification_level, 'mentions'),
    'muted', coalesce(p_row.muted, false),
    'mutedUntil', p_row.muted_until,
    'muteActive', coalesce(p_row.muted, false)
      and (p_row.muted_until is null or p_row.muted_until > pg_catalog.now()),
    'keywords', pg_catalog.to_jsonb(coalesce(p_row.keywords, '{}'::text[]))
  );
$function$;

-- Writes one member's row; a row equal to the defaults is removed, so the
-- table only ever holds real choices.
create function private.save_channel_notification_settings(
  p_organization_id uuid,
  p_space_id uuid,
  p_user_id uuid,
  p_level text,
  p_muted boolean,
  p_muted_until timestamptz,
  p_keywords text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  saved public.chapter_space_notification_settings%rowtype;
begin
  perform private.lock_case_graph(array[p_user_id], array[]::uuid[]);
  if p_level = 'mentions' and not coalesce(p_muted, false) and coalesce(pg_catalog.cardinality(p_keywords), 0) = 0 then
    delete from public.chapter_space_notification_settings s
    where s.space_id = p_space_id and s.user_id = p_user_id;
    saved.space_id := p_space_id;
    saved.notification_level := 'mentions';
    saved.muted := false;
    saved.keywords := '{}'::text[];
    return private.channel_settings_json(saved);
  end if;
  insert into public.chapter_space_notification_settings (
    organization_id, space_id, user_id, notification_level, muted, muted_until, keywords, updated_at
  ) values (
    p_organization_id, p_space_id, p_user_id, p_level, coalesce(p_muted, false),
    case when coalesce(p_muted, false) then p_muted_until end,
    coalesce(p_keywords, '{}'::text[]), pg_catalog.now()
  )
  on conflict (space_id, user_id) do update set
    organization_id = excluded.organization_id,
    notification_level = excluded.notification_level,
    muted = excluded.muted,
    muted_until = excluded.muted_until,
    keywords = excluded.keywords,
    updated_at = excluded.updated_at
  returning * into saved;
  return private.channel_settings_json(saved);
end;
$function$;

create function public.set_channel_notification_level(p_space_id uuid, p_level text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid;
  current_row public.chapter_space_notification_settings%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_level is null or p_level not in ('all', 'mentions', 'none') then
    raise exception 'invalid notification level' using errcode = '22023';
  end if;
  org := private.channel_settings_target(p_space_id);
  if not private.organization_feature_enabled(org, 'features.messaging.channel_notification_levels') then
    perform private.raise_channel_control_disabled('Channel notification levels');
  end if;
  select * into current_row from public.chapter_space_notification_settings s
  where s.space_id = p_space_id and s.user_id = caller for update;
  return private.save_channel_notification_settings(org, p_space_id, caller, p_level,
    coalesce(current_row.muted, false), current_row.muted_until, coalesce(current_row.keywords, '{}'::text[]));
end;
end;
$function$;

create function public.set_channel_mute(p_space_id uuid, p_muted boolean, p_muted_until timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid;
  current_row public.chapter_space_notification_settings%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_muted is null then
    raise exception 'mute choice required' using errcode = '22023';
  end if;
  if p_muted and p_muted_until is not null
     and (p_muted_until <= pg_catalog.now() or p_muted_until > pg_catalog.now() + interval '366 days') then
    raise exception 'a timed mute ends within the next year' using errcode = '22023';
  end if;
  org := private.channel_settings_target(p_space_id);
  if not private.organization_feature_enabled(org, 'features.messaging.channel_mute') then
    perform private.raise_channel_control_disabled('Channel mute');
  end if;
  select * into current_row from public.chapter_space_notification_settings s
  where s.space_id = p_space_id and s.user_id = caller for update;
  return private.save_channel_notification_settings(org, p_space_id, caller,
    coalesce(current_row.notification_level, 'mentions'), p_muted,
    case when p_muted then p_muted_until end, coalesce(current_row.keywords, '{}'::text[]));
end;
end;
$function$;

create function public.set_channel_keyword_alerts(p_space_id uuid, p_keywords text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid;
  clean text[];
  member_limit integer;
  elsewhere integer;
  current_row public.chapter_space_notification_settings%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if coalesce(pg_catalog.cardinality(p_keywords), 0) > 50 then
    raise exception 'too many keywords' using errcode = '22023';
  end if;
  -- Normalize in the caller's order: trimmed, lowercase, blanks and repeats dropped.
  select coalesce(pg_catalog.array_agg(n.value order by n.first_at), '{}'::text[]) into clean
  from (
    select pg_catalog.lower(pg_catalog.btrim(k.value)) as value, pg_catalog.min(k.ordinality) as first_at
    from pg_catalog.unnest(coalesce(p_keywords, '{}'::text[])) with ordinality k(value, ordinality)
    where pg_catalog.btrim(coalesce(k.value, '')) <> ''
    group by pg_catalog.lower(pg_catalog.btrim(k.value))
  ) n;
  if exists (
    select 1 from pg_catalog.unnest(clean) k(value)
    where pg_catalog.char_length(k.value) not between 2 and 48 or k.value ~ '[[:cntrl:]]'
  ) then
    raise exception 'each keyword is 2 to 48 characters' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(clean) > 20 then
    raise exception 'a channel watches at most 20 keywords' using errcode = '22023';
  end if;
  org := private.channel_settings_target(p_space_id);
  if not private.organization_feature_enabled(org, 'features.messaging.keyword_alerts') then
    perform private.raise_channel_control_disabled('Keyword alerts');
  end if;
  member_limit := private.organization_limit(org, 'limits.messaging.keyword_alerts_per_member');
  select coalesce(pg_catalog.sum(pg_catalog.cardinality(s.keywords)), 0)::integer into elsewhere
  from public.chapter_space_notification_settings s
  where s.organization_id = org and s.user_id = caller and s.space_id <> p_space_id;
  if elsewhere + pg_catalog.cardinality(clean) > member_limit then
    raise exception 'keyword alert limit reached' using errcode = '22023', detail = 'keyword-limit';
  end if;
  select * into current_row from public.chapter_space_notification_settings s
  where s.space_id = p_space_id and s.user_id = caller for update;
  return private.save_channel_notification_settings(org, p_space_id, caller,
    coalesce(current_row.notification_level, 'mentions'), coalesce(current_row.muted, false),
    current_row.muted_until, clean);
end;
end;
$function$;

-- Everything a channel settings surface needs in one read: the organization's
-- switches (so no client shows a control the server would refuse), the keyword
-- budget, whether the caller may pin, and the caller's own rows for channels
-- they can read now.
create function public.get_my_channel_controls()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object(
      'available', false, 'organizationId', null,
      'switches', pg_catalog.jsonb_build_object(
        'channelPinning', false, 'notificationLevels', false, 'channelMute', false,
        'mentions', false, 'hereMentions', false, 'mentionSearch', false, 'keywordAlerts', false),
      'keywordLimit', 0, 'keywordCount', 0, 'canPin', false, 'spaces', '{}'::jsonb);
  end if;
  if not private.is_organization_member(org) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'available', true,
    'organizationId', org,
    'switches', private.channel_control_switches(org),
    'keywordLimit', private.organization_limit(org, 'limits.messaging.keyword_alerts_per_member'),
    'keywordCount', (
      select coalesce(pg_catalog.sum(pg_catalog.cardinality(s.keywords)), 0)::integer
      from public.chapter_space_notification_settings s
      where s.organization_id = org and s.user_id = caller
    ),
    'canPin', private.organization_feature_enabled(org, 'features.messaging.channel_pinning')
      and public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']),
    'spaces', coalesce((
      select pg_catalog.jsonb_object_agg(s.space_id::text, private.channel_settings_json(s))
      from public.chapter_space_notification_settings s
      join public.chapter_spaces space on space.id = s.space_id
      where s.organization_id = org and s.user_id = caller
        and space.archived_at is null
        and private.can_read_chapter_space(space)
    ), '{}'::jsonb)
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Thread pinning. pinned_at has no client grant: staff pin through here.
-- ---------------------------------------------------------------------------

alter table public.chapter_threads add column pinned_at timestamptz;

comment on column public.chapter_threads.pinned_at is
  'When chapter staff pinned this thread to the top of its channel (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001). Written only by public.set_chapter_thread_pinned; no client column grant.';

create function public.set_chapter_thread_pinned(p_thread_id uuid, p_pinned boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  target public.chapter_threads%rowtype;
  space public.chapter_spaces%rowtype;
  org uuid;
  pinned_count integer;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_pinned is null then
    raise exception 'pin choice required' using errcode = '22023';
  end if;
  select t.* into target from public.chapter_threads t where t.id = p_thread_id for update;
  if target.id is null then
    raise exception 'thread unavailable' using errcode = 'P0002';
  end if;
  -- Staff of the channel's own chapter only; same gate as space management.
  space := private.assert_space_manager(target.space_id);
  select c.organization_id into org from public.chapters c where c.id = space.chapter_id;
  if not private.organization_feature_enabled(org, 'features.messaging.channel_pinning') then
    perform private.raise_channel_control_disabled('Thread pinning');
  end if;
  if p_pinned and target.pinned_at is null then
    select pg_catalog.count(*)::integer into pinned_count
    from public.chapter_threads t
    where t.space_id = target.space_id and t.pinned_at is not null;
    if pinned_count >= 10 then
      raise exception 'a channel pins at most 10 threads' using errcode = '22023';
    end if;
  end if;
  update public.chapter_threads t
  set pinned_at = case when p_pinned then coalesce(t.pinned_at, pg_catalog.now()) end
  where t.id = target.id
  returning * into target;
  return pg_catalog.jsonb_build_object('threadId', target.id, 'spaceId', target.space_id, 'pinnedAt', target.pinned_at);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Structured mentions on channel posts.
-- ---------------------------------------------------------------------------

alter table public.chapter_thread_posts
  add column mentioned_user_ids uuid[] not null default '{}'::uuid[];
alter table public.chapter_thread_posts
  add constraint chapter_thread_posts_mentions_bounded
  check (pg_catalog.cardinality(mentioned_user_ids) <= 20);

comment on column public.chapter_thread_posts.mentioned_user_ids is
  'People this post mentions (REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001). Sanitized on insert by private.prepare_chapter_post_mentions: only people who can read the channel survive, never the author, never with the switch off.';

grant insert (mentioned_user_ids) on public.chapter_thread_posts to authenticated;

create index chapter_thread_posts_mentions_idx
  on public.chapter_thread_posts using gin (mentioned_user_ids)
  where pg_catalog.cardinality(mentioned_user_ids) > 0;
create index chapter_thread_posts_author_recent_idx
  on public.chapter_thread_posts (author_id, created_at desc);

create function private.prepare_chapter_post_mentions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  post_author uuid := coalesce(new.author_id, (select auth.uid()));
  target_space uuid;
  space_org uuid;
begin
  if coalesce(pg_catalog.cardinality(new.mentioned_user_ids), 0) = 0 then
    new.mentioned_user_ids := '{}'::uuid[];
    return new;
  end if;
  if pg_catalog.cardinality(new.mentioned_user_ids) > 20 then
    raise exception 'a post mentions at most 20 people' using errcode = '22023';
  end if;
  select t.space_id, c.organization_id into target_space, space_org
  from public.chapter_threads t
  join public.chapter_spaces s on s.id = t.space_id
  join public.chapters c on c.id = s.chapter_id
  where t.id = new.thread_id;
  if target_space is null or space_org is null
     or not private.organization_feature_enabled(space_org, 'features.messaging.mentions') then
    new.mentioned_user_ids := '{}'::uuid[];
    return new;
  end if;
  -- Dropped, not refused: a refusal would tell the author whether a given
  -- person can read the channel.
  select coalesce(pg_catalog.array_agg(m.id order by m.id), '{}'::uuid[]) into new.mentioned_user_ids
  from (select distinct candidate.id from pg_catalog.unnest(new.mentioned_user_ids) candidate(id)) m
  where m.id is not null
    and m.id is distinct from post_author
    and private.channel_member_can_read_space(m.id, target_space);
  return new;
end;
$function$;

create trigger chapter_thread_posts_prepare_mentions
before insert on public.chapter_thread_posts
for each row execute function private.prepare_chapter_post_mentions();

-- Mention candidates. Staff, who already see their chapter's roster, search
-- every reader of the channel. A member never receives a directory: their
-- candidates are people whose names the channel already shows them (authors
-- in this channel) and the chapter stewards the roster already publishes.
create function public.list_channel_mention_candidates(p_space_id uuid, p_query text default null, p_limit integer default 8)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  space public.chapter_spaces%rowtype;
  org uuid;
  needle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, '')));
  cap integer := least(greatest(coalesce(p_limit, 8), 1), 10);
  staff boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) > 60 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  org := private.channel_settings_target(p_space_id);
  select s.* into space from public.chapter_spaces s where s.id = p_space_id;
  if not private.organization_feature_enabled(org, 'features.messaging.mentions') then
    return '[]'::jsonb;
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');
  staff := public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']);
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', picked.id, 'name', picked.name, 'initials', picked.initials) order by picked.name, picked.id)
    from (
      select p.id, coalesce(nullif(pg_catalog.btrim(p.full_name), ''), 'Chapter member') as name,
        coalesce(nullif(pg_catalog.btrim(p.initials), ''), '·') as initials
      from public.member_profiles p
      where p.id <> caller
        and (
          (staff and exists (
            select 1 from public.member_chapter_memberships cm
            where cm.user_id = p.id and cm.chapter_id = space.chapter_id and cm.status = 'active'))
          or exists (
            select 1 from public.chapter_thread_posts post
            join public.chapter_threads thread on thread.id = post.thread_id
            where thread.space_id = space.id and post.author_id = p.id and post.deleted_at is null)
          or exists (
            select 1 from private.member_roster_stewards_for_chapter(space.chapter_id) roster
            where roster.steward_id = p.id)
        )
        and (needle = ''
          or pg_catalog.lower(coalesce(p.full_name, '')) like needle || '%' escape '\'
          or pg_catalog.lower(coalesce(p.full_name, '')) like '% ' || needle || '%' escape '\')
        and private.channel_member_can_read_space(p.id, space.id)
      order by pg_catalog.lower(coalesce(p.full_name, '')), p.id
      limit cap
    ) picked
  ), '[]'::jsonb);
end;
$function$;

-- Mention search: posts in the caller's current chapter that mention them or
-- ping @here, in channels they can read now. Live bodies only.
create function public.search_my_channel_mentions(p_query text default null, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := least(greatest(coalesce(p_limit, 30), 1), 50);
  here_on boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null or not private.is_organization_member(org) then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.messaging.mention_search') then
    perform private.raise_channel_control_disabled('Mention search');
  end if;
  if pg_catalog.char_length(needle) > 80 then
    raise exception 'query too long' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(needle, '\', '\\'), '%', '\%'), '_', '\_');
  here_on := private.organization_feature_enabled(org, 'features.messaging.here_mentions');
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'postId', hit.id, 'threadId', hit.thread_id, 'spaceId', hit.space_id,
      'threadTitle', hit.thread_title, 'spaceName', hit.space_name,
      'body', hit.body, 'authorName', hit.author_name, 'authorInitials', hit.author_initials,
      'createdAt', hit.created_at, 'reason', hit.reason) order by hit.created_at desc, hit.id desc)
    from (
      select post.id, post.thread_id, thread.space_id, thread.title as thread_title, space.name as space_name,
        post.body, post.author_name, post.author_initials, post.created_at,
        case when caller = any(post.mentioned_user_ids) then 'mention' else 'here' end as reason
      from public.chapter_thread_posts post
      join public.chapter_threads thread on thread.id = post.thread_id
      join public.chapter_spaces space on space.id = thread.space_id
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      where post.deleted_at is null
        and space.archived_at is null
        and private.can_read_chapter_space(space)
        and post.author_id <> caller
        and (
          caller = any(post.mentioned_user_ids)
          or (here_on and post.body ilike '%@here%' and private.channel_body_has_here(post.body))
        )
        and (needle = '' or post.body ilike '%' || needle || '%' escape '\')
      order by post.created_at desc, post.id desc
      limit cap
    ) hit
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Notification production.
-- ---------------------------------------------------------------------------

create function private.produce_channel_post_alerts(p_post_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  post record;
  mentions_on boolean;
  here_on boolean;
  keywords_on boolean;
  levels_on boolean;
  here_live boolean;
  author_label text;
  candidate record;
  delivered integer;
begin
  -- Notices are case-graph writes (member_notifications): enter the gate
  -- before the first row read, as every graph writer does.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  here_live := false;
  delivered := 0;
  select p.id, p.author_id, p.body, p.mentioned_user_ids, p.created_at, p.author_name,
         t.space_id, c.organization_id
    into post
  from public.chapter_thread_posts p
  join public.chapter_threads t on t.id = p.thread_id
  join public.chapter_spaces s on s.id = t.space_id and s.archived_at is null
  join public.chapters c on c.id = s.chapter_id
  where p.id = p_post_id and p.deleted_at is null;
  if post.id is null or post.organization_id is null then
    return 0;
  end if;

  mentions_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.mentions');
  here_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.here_mentions');
  keywords_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.keyword_alerts');
  levels_on := private.organization_feature_enabled(post.organization_id, 'features.messaging.channel_notification_levels');

  -- @here: the message always posts; only the ping is rate-limited. One per
  -- author per channel per ten minutes; six per hour and twenty per day per
  -- author across the organization (old here-dispatch.ts cooldown + Patch2DA).
  if here_on and private.channel_body_has_here(post.body) then
    here_live := not exists (
      select 1 from public.chapter_thread_posts earlier
      join public.chapter_threads et on et.id = earlier.thread_id
      where earlier.author_id = post.author_id and earlier.id <> post.id
        and et.space_id = post.space_id
        and earlier.created_at >= post.created_at - interval '10 minutes'
        and earlier.created_at <= post.created_at
        and earlier.body ilike '%@here%' and private.channel_body_has_here(earlier.body)
    );
    if here_live then
      here_live := (
        select pg_catalog.count(*) filter (where earlier.created_at >= post.created_at - interval '1 hour') < 6
          and pg_catalog.count(*) < 20
        from public.chapter_thread_posts earlier
        join public.chapter_threads et on et.id = earlier.thread_id
        join public.chapter_spaces es on es.id = et.space_id
        join public.chapters ec on ec.id = es.chapter_id and ec.organization_id = post.organization_id
        where earlier.author_id = post.author_id and earlier.id <> post.id
          and earlier.created_at >= post.created_at - interval '24 hours'
          and earlier.created_at <= post.created_at
          and earlier.body ilike '%@here%' and private.channel_body_has_here(earlier.body)
      );
    end if;
  end if;

  author_label := coalesce(nullif(pg_catalog.btrim(post.author_name), ''), 'A chapter member');

  for candidate in
    with reasons(user_id, reason, priority) as (
      select m.id, 'mention'::text, 1
      from pg_catalog.unnest(case when mentions_on then post.mentioned_user_ids else '{}'::uuid[] end) m(id)
      union all
      select online.user_id, 'here', 2
      from (
        select presence.user_id
        from public.member_presence presence
        where here_live
          and presence.organization_id = post.organization_id
          and presence.status = 'online'
          and presence.last_seen_at >= pg_catalog.now() - interval '5 minutes'
          and presence.user_id <> post.author_id
          and private.channel_member_can_read_space(presence.user_id, post.space_id)
        order by presence.last_seen_at desc, presence.user_id
        limit 200
      ) online
      union all
      select s.user_id, 'keyword', 3
      from public.chapter_space_notification_settings s
      where keywords_on
        and s.organization_id = post.organization_id and s.space_id = post.space_id
        and pg_catalog.cardinality(s.keywords) > 0
        and private.channel_keywords_match(post.body, s.keywords)
      union all
      select s.user_id, 'post', 4
      from public.chapter_space_notification_settings s
      where levels_on
        and s.organization_id = post.organization_id and s.space_id = post.space_id
        and s.notification_level = 'all'
    )
    select distinct on (r.user_id) r.user_id, r.reason
    from reasons r
    where r.user_id is not null and r.user_id <> post.author_id
    order by r.user_id, r.priority
    limit 1000
  loop
    continue when not private.channel_member_can_read_space(candidate.user_id, post.space_id);
    continue when private.channel_alert_decision(post.organization_id, post.space_id, candidate.user_id, candidate.reason) <> 'deliver';
    perform private.notify_member(candidate.user_id, 'channel.' || candidate.reason,
      pg_catalog.jsonb_build_object('name', author_label), 'messages');
    delivered := delivered + 1;
  end loop;
  return delivered;
end;
$function$;

-- Exception-fenced like private.notify_stewards_of_request: notification
-- plumbing must never refuse a member's post.
create function private.chapter_post_alerts_after_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  begin
    perform private.produce_channel_post_alerts(new.id);
  exception
    when query_canceled then
      raise warning 'channel alerts cancelled for post %', new.id;
    when others then
      raise warning 'channel alerts failed for post %: % (%)', new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$function$;

create trigger chapter_thread_posts_channel_alerts
after insert on public.chapter_thread_posts
for each row execute function private.chapter_post_alerts_after_insert();

-- ---------------------------------------------------------------------------
-- 8. Grants. Private helpers: nobody. Member RPCs: authenticated only.
-- ---------------------------------------------------------------------------

revoke all on function private.channel_member_can_read_space(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.channel_body_has_here(text) from public, anon, authenticated, service_role;
revoke all on function private.channel_keywords_valid(text[]) from public, anon, authenticated, service_role;
revoke all on function private.channel_keywords_match(text, text[]) from public, anon, authenticated, service_role;
revoke all on function private.channel_control_switches(uuid) from public, anon, authenticated, service_role;
revoke all on function private.raise_channel_control_disabled(text) from public, anon, authenticated, service_role;
revoke all on function private.channel_alert_decision(uuid, uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.channel_settings_target(uuid) from public, anon, authenticated, service_role;
revoke all on function private.channel_settings_json(public.chapter_space_notification_settings) from public, anon, authenticated, service_role;
revoke all on function private.save_channel_notification_settings(uuid, uuid, uuid, text, boolean, timestamptz, text[]) from public, anon, authenticated, service_role;
revoke all on function private.prepare_chapter_post_mentions() from public, anon, authenticated, service_role;
revoke all on function private.produce_channel_post_alerts(uuid) from public, anon, authenticated, service_role;
revoke all on function private.chapter_post_alerts_after_insert() from public, anon, authenticated, service_role;

revoke all on function public.set_channel_notification_level(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.set_channel_mute(uuid, boolean, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.set_channel_keyword_alerts(uuid, text[]) from public, anon, authenticated, service_role;
revoke all on function public.get_my_channel_controls() from public, anon, authenticated, service_role;
revoke all on function public.set_chapter_thread_pinned(uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.list_channel_mention_candidates(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.search_my_channel_mentions(text, integer) from public, anon, authenticated, service_role;

grant execute on function public.set_channel_notification_level(uuid, text) to authenticated;
grant execute on function public.set_channel_mute(uuid, boolean, timestamptz) to authenticated;
grant execute on function public.set_channel_keyword_alerts(uuid, text[]) to authenticated;
grant execute on function public.get_my_channel_controls() to authenticated;
grant execute on function public.set_chapter_thread_pinned(uuid, boolean) to authenticated;
grant execute on function public.list_channel_mention_candidates(uuid, text, integer) to authenticated;
grant execute on function public.search_my_channel_mentions(text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Account lifecycle: the settings row is the member's own; it is exported
-- to them and deleted with the account.
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, export_projection_version, export_domain,
   export_columns, exclusion_reason, note, reviewed_at)
values
  ('public', 'chapter_space_notification_settings', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.chapter_space_notification_settings',
   array['organization_id','space_id','user_id','notification_level','muted','muted_until','keywords','updated_at']::text[],
   null,
   'The member''s own notification level, mute and keyword alerts for each chapter channel. Exported to that member; deleted with the account.',
   date '2026-10-02');

create function private.account_lifecycle_export_chapter_space_notification_settings(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'organization_id', t.organization_id, 'space_id', t.space_id, 'user_id', t.user_id,
    'notification_level', t.notification_level, 'muted', t.muted, 'muted_until', t.muted_until,
    'keywords', t.keywords, 'updated_at', t.updated_at) order by t.space_id), '[]'::jsonb)
  from public.chapter_space_notification_settings t where t.user_id = p_caller;
$export$;

revoke all on function private.account_lifecycle_export_chapter_space_notification_settings(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from the installed definition (20261001020000) with one added
-- domain; every other key is unchanged.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller)
  );
$export$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

-- Reviewed trigger surface: the two new channel-post triggers, the settings
-- table's lock gates, the functions they reach, and the re-emitted enqueue.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and (
        (table_name = 'chapter_thread_posts'
          and object_name in ('chapter_thread_posts_prepare_mentions', 'chapter_thread_posts_channel_alerts'))
        or (table_name = 'chapter_space_notification_settings'
          and object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))))
   or (kind = 'function' and schema_name = 'private' and object_name in (
        'enqueue_notification_deliveries()',
        'prepare_chapter_post_mentions()',
        'chapter_post_alerts_after_insert()',
        'produce_channel_post_alerts(p_post_id uuid)',
        'channel_member_can_read_space(p_user_id uuid, p_space_id uuid)',
        'channel_body_has_here(p_body text)',
        'channel_keywords_match(p_body text, p_keywords text[])',
        'channel_alert_decision(p_organization_id uuid, p_space_id uuid, p_user_id uuid, p_reason text)',
        'organization_feature_enabled(p_organization_id uuid, p_key text)',
        'organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_channel_controls_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after channel controls: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after channel controls';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after channel controls';
  end if;
end;
$assert_channel_controls_lifecycle$;

notify pgrst, 'reload schema';

commit;
