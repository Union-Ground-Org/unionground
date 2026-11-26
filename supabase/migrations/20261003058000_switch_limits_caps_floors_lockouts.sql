-- REQ-UG-SWITCHES-NOTIFICATION-CAPS-PRIVACY-FLOORS-LOCKOUTS-20261002
-- Today's enforced values are the defaults. The cited predecessors below are
-- retained as historical evidence; this is the forward-only settings delivery.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- B7: 20260913031500_native_push_enqueue_repair.sql:56-59.
-- B9: 20260925991000_organization_page_view_producer.sql:152 and
--     20260928080621_analytics_workspace_candidate_prefilter.sql:23.
-- B10: 20260928103100_chapter_connection_review_repairs.sql:271-272.
-- B11: 20260902050000_g4_native_staff_authorization_depth.sql:341-386.
-- B14: 20260822010000_mi1_organization_scope_foundation.sql:3826-3952;
--      20260907153000_member_invitation_accept_limit_pruning.sql:21;
--      20260925980000_event_checkin_code_attempt_bound.sql:256;
--      20260912002000_auth_bookkeeping_lock_scope.sql:199-208.
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  ('limits.notifications.member_hourly', 'integer', 'Notifications per member per hour',
   'Maximum outbound notifications queued for one member in a rolling hour.', '12'::jsonb, 1, 60, null, 2600, 'notifications', false),
  ('limits.notifications.member_daily', 'integer', 'Notifications per member per day',
   'Maximum outbound notifications queued for one member in a rolling 24 hours.', '50'::jsonb, 1, 200, null, 2610, 'notifications', false),
  ('limits.notifications.member_weekly_nudges', 'integer', 'Weekly non-urgent nudges',
   'Maximum non-urgent email nudges for one member in a rolling seven days. Deadlines and cases keep their existing exemption.', '5'::jsonb, 1, 50, null, 2620, 'notifications', true),
  ('limits.notifications.organization_daily', 'integer', 'Organization notifications per day',
   'Maximum outbound notifications queued for this organization in a calendar day.', '20000'::jsonb, 100, 100000, null, 2630, 'notifications', false),
  ('limits.analytics.anonymity_floor', 'integer', 'Analytics anonymity floor',
   'Minimum distinct people required before analytics cells and their complements are published. Never below ten.', '25'::jsonb, 10, 200, null, 2640, 'analytics', false),
  ('limits.intelligence.connection_issue_floor', 'integer', 'Connection issue contributor floor',
   'Minimum distinct reviewed contributors on both sides of a chapter issue band. Never below fifteen.', '25'::jsonb, 15, 200, null, 2650, 'intelligence', false),
  ('limits.analytics.chapter_health_cohort_floor', 'integer', 'Chapter health cohort floor',
   'Minimum chapter membership before a health snapshot and trend are shown. Never below five.', '10'::jsonb, 5, 100, null, 2660, 'analytics', false),
  ('limits.security.invitation_admin_hourly', 'integer', 'Invitations per admin per hour',
   'Maximum invitation creation attempts by one chapter admin in an hour.', '10'::jsonb, 1, 50, null, 2670, 'security', false),
  ('limits.security.invitation_chapter_daily', 'integer', 'Invitations per chapter per day',
   'Maximum invitation creation attempts for one chapter in a day.', '50'::jsonb, 1, 250, null, 2680, 'security', false),
  ('limits.security.invitation_resend_admin_hourly', 'integer', 'Invitation resends per admin per hour',
   'Maximum invitation resend attempts by one chapter admin in an hour.', '20'::jsonb, 1, 100, null, 2690, 'security', false),
  ('limits.security.invitation_resend_per_invite_hourly', 'integer', 'Resends per invitation per hour',
   'Maximum resend attempts for the same invitation in an hour.', '3'::jsonb, 1, 15, null, 2700, 'security', false),
  ('limits.security.invitation_accept_per_15_minutes', 'integer', 'Invitation accepts per fifteen minutes',
   'Maximum acceptance attempts from one opaque network scope in fifteen minutes.', '20'::jsonb, 1, 100, null, 2710, 'security', false),
  ('limits.security.event_checkin_wrong_codes', 'integer', 'Wrong event check-in codes before lock',
   'Number of incorrect event codes that locks a member and event pair.', '10'::jsonb, 1, 50, null, 2720, 'security', false),
  ('limits.security.event_checkin_lock_minutes', 'integer', 'Event check-in lock duration in minutes',
   'Minutes a locked member and event pair must wait before trying again.', '15'::jsonb, 5, 1440, null, 2730, 'security', false),
  ('limits.security.mfa_recovery_failures', 'integer', 'MFA recovery failures before lock',
   'Number of rejected recovery codes that locks the recovery-code set.', '5'::jsonb, 1, 25, null, 2740, 'security', false),
  ('limits.security.mfa_recovery_lock_minutes', 'integer', 'MFA recovery lock duration in minutes',
   'Minutes a locked recovery-code set must wait before another attempt.', '15'::jsonb, 5, 1440, null, 2750, 'security', false)
on conflict (key) do nothing;

-- The existing counter is global and has no tenant key. Keep it for legacy
-- unscoped notifications. Scoped recipients use a separate bounded counter.
create table private.organization_notification_outbound_counters (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  day date not null,
  shard smallint not null,
  enqueued integer not null default 0 check (enqueued >= 0),
  primary key (organization_id, day, shard)
);
revoke all on private.organization_notification_outbound_counters from public, anon, authenticated, service_role;

-- The counter's organization FK joins the account graph. Acquire its standard
-- statement and empty row-key gates, preserving Auth-deletion lock ordering.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_notification_outbound_counters
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_notification_outbound_counters
for each row execute function private.lock_case_graph_row_keys('', '');
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select 'trigger', n.nspname, c.relname, t.tgname, pg_catalog.md5(pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text)
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid=t.tgrelid
join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='private' and c.relname='organization_notification_outbound_counters'
  and t.tgname in ('a00_case_graph_lock','z99_case_graph_keys') and not t.tgisinternal;

-- organization_limit is newly reachable from the reviewed notification trigger.
-- Its unchanged W1 helper reads one typed effective integer setting, writes no
-- rows and retains SECURITY DEFINER with an empty search path and no client ACL.
-- Pin the existing definition before registering it in the lifecycle closure.
do $limit_review$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.organization_limit(uuid,text)'::regprocedure)) <> 'c72f679227a26b16aa57c68b648c99d6' then
    raise exception 'organization limit helper differs from reviewed W1 bytes';
  end if;
end;
$limit_review$;
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
values ('function','private','','organization_limit(p_organization_id uuid, p_key text)','c72f679227a26b16aa57c68b648c99d6')
on conflict (kind,schema_name,table_name,object_name) do nothing;


-- Refuse an unreviewed predecessor before any SECURITY DEFINER body changes.
lock table private.account_lifecycle_trigger_review in share row exclusive mode;
alter function private.enqueue_notification_deliveries() security definer;
create temporary table switch_limits_enqueue_snapshot on commit drop as
  select p.proowner, p.proacl,
    (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.oid)
     from pg_catalog.pg_trigger t where t.tgfoid = p.oid) as triggers
  from pg_catalog.pg_proc p
  where p.oid = 'private.enqueue_notification_deliveries()'::regprocedure;

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) <> '4e2e50ab29a5fdf267f0d80bcada4bbf' then
    raise exception 'unreviewed switch-limits predecessor: private.enqueue_notification_deliveries()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_snapshot()'::regprocedure)) <> '49b74b8b1908a9fc67901575ef99d286' then
    raise exception 'unreviewed switch-limits predecessor: public.get_organization_analytics_snapshot()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_workspace()'::regprocedure)) <> '14444f036105fcccfdd9536ec26cfcc6' then
    raise exception 'unreviewed switch-limits predecessor: public.get_organization_analytics_workspace()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.freeze_chapter_connection_issue_aggregates(text,text)'::regprocedure)) <> 'b8ab9423c500fc40b0a20dd90e82c76f' then
    raise exception 'unreviewed switch-limits predecessor: public.freeze_chapter_connection_issue_aggregates(text,text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_chapter_health_portfolio()'::regprocedure)) <> '61565d4ba54c5223d4d3003d7d5845fb' then
    raise exception 'unreviewed switch-limits predecessor: public.get_chapter_health_portfolio()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.create_member_invitation(text,text,text,text,text,text)'::regprocedure)) <> '55202d9713d0dc943791a97ff99163f9' then
    raise exception 'unreviewed switch-limits predecessor: public.create_member_invitation(text,text,text,text,text,text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.resend_member_invitation(uuid,text)'::regprocedure)) <> 'e3b088ce77bc8130552eab14230d5f15' then
    raise exception 'unreviewed switch-limits predecessor: public.resend_member_invitation(uuid,text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.claim_mfa_recovery_code(text)'::regprocedure)) <> '0df38972092bbdf11604c87f9246ebee' then
    raise exception 'unreviewed switch-limits predecessor: public.claim_mfa_recovery_code(text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.check_in_to_event(text,text)'::regprocedure)) <> '3f62d1aba6de22d5102b8fd6c1de682b' then
    raise exception 'unreviewed switch-limits predecessor: public.check_in_to_event(text,text)';
  end if;
  if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure), 'UTF8')), 'hex') <> '34b46fc1409e243bcf0818261bc4c43e6d3fc61e3173fd355639e30c0d649b86'
     or (select count(*) from private.account_lifecycle_trigger_review
         where kind = 'function' and schema_name = 'private' and table_name = ''
           and object_name = 'enqueue_notification_deliveries()'
           and definition_hash = '4e2e50ab29a5fdf267f0d80bcada4bbf') <> 1 then
    raise exception 'notification enqueue lifecycle predecessor is not reviewed';
  end if;
end;
$preflight$;

-- private.enqueue_notification_deliveries()
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
  notification_org uuid;
  max_per_recipient_hour integer;
  max_per_recipient_day integer;
  max_per_recipient_week integer;
  max_org_day integer;
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
    -- The recipient's active primary chapter is the durable tenant for this
    -- legacy notification row, which itself has no organization_id column.
    select c.organization_id into notification_org
    from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    join public.member_chapter_memberships cm
      on cm.chapter_id = c.id and cm.user_id = p.id and cm.status = 'active'
    join public.organization_memberships om
      on om.organization_id = c.organization_id and om.user_id = p.id and om.status = 'active'
    where p.id = new.user_id;
    max_per_recipient_hour := private.organization_limit(notification_org, 'limits.notifications.member_hourly');
    max_per_recipient_day := private.organization_limit(notification_org, 'limits.notifications.member_daily');
    max_per_recipient_week := private.organization_limit(notification_org, 'limits.notifications.member_weekly_nudges');
    max_org_day := private.organization_limit(notification_org, 'limits.notifications.organization_daily');
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
    -- Serialize the organization total across counter shards. Every enqueue
    -- takes the member lock first, then this tenant lock, in the same order.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'organization_notification_rate:' || coalesce(notification_org::text, 'legacy'), 0
      )
    );
    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
    from private.notification_outbound_counters c
    where c.day = current_date and notification_org is null;
    if notification_org is not null then
      select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.organization_notification_outbound_counters c
      where c.organization_id = notification_org and c.day = current_date;
    end if;
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
    if notification_org is null then
      insert into private.notification_outbound_counters (day, shard, enqueued)
      values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
      on conflict (day, shard) do update
        set enqueued = private.notification_outbound_counters.enqueued + 1;
    else
      insert into private.organization_notification_outbound_counters
        (organization_id, day, shard, enqueued)
      values (notification_org, current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
      on conflict (organization_id, day, shard) do update
        set enqueued = private.organization_notification_outbound_counters.enqueued + 1;
    end if;
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
$function$;

-- public.get_organization_analytics_snapshot()
CREATE OR REPLACE FUNCTION public.get_organization_analytics_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  period_end timestamptz := pg_catalog.date_trunc('month', generated);
  period_start timestamptz := pg_catalog.date_trunc('month', generated) - interval '6 months';
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  attendance_start timestamptz := generated - interval '180 days';
  result jsonb;
  snapshot_id uuid := extensions.gen_random_uuid();
  published_rows integer;
  withheld_rows integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  result := pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'label', c.name,
        'memberCount', case when member_totals.value >= privacy_threshold
          then (pg_catalog.floor(member_totals.value / 5.0) * 5)::integer else null end,
        'memberCountSuppressed', member_totals.value < privacy_threshold,
        'stewardCount', case when steward_totals.value >= privacy_threshold
          and member_totals.value - steward_totals.value >= privacy_threshold
          then (pg_catalog.floor(steward_totals.value / 5.0) * 5)::integer else null end,
        'stewardCountSuppressed', steward_totals.value < privacy_threshold
          or member_totals.value - steward_totals.value < privacy_threshold
      ) order by c.name, c.id)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*) as value from public.member_chapter_memberships m
        where m.chapter_id = c.id and m.status = 'active'
      ) member_totals
      cross join lateral (
        select pg_catalog.count(distinct rc.user_id) as value
        from public.member_role_chapters rc
        join public.member_chapter_memberships m
          on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id and m.status = 'active'
        where rc.chapter_id = c.id and rc.role = 'steward'
      ) steward_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'cases', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'chapterId', counted.chapter_id, 'status', counted.status,
        'step', counted.step_bucket, 'workplaceKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.status, counted.case_type, counted.step_bucket)
      from (
        select cs.chapter_id, cs.status,
          case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket,
          cs.case_type, pg_catalog.count(distinct cs.user_id) as person_count
        from public.member_cases cs
        where cs.organization_id = org and cs.chapter_id is not null
          and cs.created_at >= period_start and cs.created_at < period_end
        group by cs.chapter_id, cs.status, step_bucket, cs.case_type
        having pg_catalog.count(distinct cs.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    -- OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
    -- ( AUTHENTICATED PAGE-VIEW PRODUCER):
    -- public.record_workspace_page_view fills organization_page_views and
    -- writes one page_view engagement event per (person, path, minute). A
    -- (path, hat, day) total is published, rounded down to 5, only when it is
    -- itself at least privacy_threshold and at least privacy_threshold
    -- distinct people viewed that path that day (the page_view events carry
    -- the path before '|'), so a request total never stands in for a small
    -- person cohort.
    'usageViews', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'path', v.path, 'hat', v.hat, 'day', v.day,
        'count', (pg_catalog.floor(v.view_count / 5.0) * 5)::integer
      ) order by v.day, v.path, v.hat)
      from public.organization_page_views v
      where v.organization_id = org
        and v.day > ((generated - interval '30 days') at time zone 'UTC')::date
        and v.day <= (generated at time zone 'UTC')::date
        and v.view_count >= privacy_threshold
        and (
          select pg_catalog.count(distinct e.user_id)
          from public.organization_engagement_events e
          where e.organization_id = org and e.event_type = 'page_view'
            and e.occurred_at >= (v.day::timestamp at time zone 'UTC')
            and e.occurred_at < ((v.day + 1)::timestamp at time zone 'UTC')
            and pg_catalog.split_part(e.source_id, '|', 1) = v.path
        ) >= privacy_threshold
    ), '[]'::jsonb),
    'usageWindows', (
      select pg_catalog.jsonb_build_object(
        'organizationId', org,
        -- Distinct people with any engagement event (page views included) in
        -- the last day / 7 days / 30 days, rounded down to 5. Nested windows
        -- permit complement differencing, so an outer window is published only
        -- when the people it adds over the nearest published inner window also
        -- clear the floor.
        'dau', case when windows.dau_ok then (pg_catalog.floor(windows.dau / 5.0) * 5)::integer else null end,
        'wau', case when windows.wau_ok then (pg_catalog.floor(windows.wau / 5.0) * 5)::integer else null end,
        'mau', case when windows.mau_ok then (pg_catalog.floor(windows.mau / 5.0) * 5)::integer else null end,
        'suppressed', pg_catalog.jsonb_build_object(
          'dau', not windows.dau_ok,
          'wau', not windows.wau_ok,
          'mau', not windows.mau_ok
        )
      ) from (
        select gated.dau, gated.wau, gated.mau, gated.dau_ok, gated.wau_ok,
          gated.mau >= privacy_threshold
            and case
              when gated.wau_ok then gated.mau - gated.wau >= privacy_threshold
              when gated.dau_ok then gated.mau - gated.dau >= privacy_threshold
              else true
            end as mau_ok
        from (
          select counted.dau, counted.wau, counted.mau,
            counted.dau >= privacy_threshold as dau_ok,
            counted.wau >= privacy_threshold
              and (counted.dau < privacy_threshold or counted.wau - counted.dau >= privacy_threshold) as wau_ok
          from (
            select
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '1 day') as dau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '7 days') as wau,
              pg_catalog.count(distinct user_id) filter (where occurred_at >= generated - interval '30 days') as mau
            from public.organization_engagement_events where organization_id = org
          ) counted
        ) gated
      ) windows
    ),
    'series', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', c.id,
        'openCases', case when case_totals.value >= privacy_threshold and case_totals.minimum_cell >= privacy_threshold
          then (pg_catalog.floor(case_totals.value / 5.0) * 5)::integer else null end,
        'openCasesSuppressed', case_totals.value < privacy_threshold or case_totals.minimum_cell < privacy_threshold,
        -- Share of recorded roster slots marked present over 180 days; guests
        -- are not on the roster. Published only when both the attending and
        -- the non-attending cohorts clear the person floor, so the rate cannot
        -- disclose a small absent cohort by complement.
        'attendanceRate', case when attendance_totals.present_people >= privacy_threshold
          and attendance_totals.missed_people >= privacy_threshold
          and attendance_totals.roster_rows > 0
          then pg_catalog.round(100.0 * attendance_totals.present_rows / attendance_totals.roster_rows, 0)
          else null end,
        -- Mean per-member engagement score (the client taxonomy's caps and
        -- weights, 180 days) over the chapter's active members.
        'engagementMean', case when engagement_totals.members >= privacy_threshold
          then pg_catalog.round(engagement_totals.mean_score, 1) else null end,
        -- Page-view totals are not person-level, so chapter portal use is the
        -- rounded 30-day distinct-person cohort of active members seen online.
        'usageViews', case when usage_totals.value >= privacy_threshold
          then (pg_catalog.floor(usage_totals.value / 5.0) * 5)::integer else null end
      ) order by c.id)
      from public.chapters c
      cross join lateral (
        select totals.value, minima.minimum_cell
        from (
          select pg_catalog.count(distinct cs.user_id) as value
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
            and cs.created_at >= period_start and cs.created_at < period_end
        ) totals
        cross join (
          select coalesce(pg_catalog.min(cell.cell_people), 0) as minimum_cell
          from (
            select pg_catalog.count(distinct cs.user_id) as cell_people
            from public.member_cases cs
            where cs.organization_id = org and cs.chapter_id = c.id and cs.status = 'active'
              and cs.created_at >= period_start and cs.created_at < period_end
            group by cs.case_type, case when cs.step in ('Intake', 'intake') then 0 else 2 end
          ) cell
        ) minima
      ) case_totals
      cross join lateral (
        select
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(distinct ma.user_id) filter (where ma.attendance_status <> 'present') as missed_people,
          pg_catalog.count(*) as roster_rows,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_rows
        from public.meeting_attendance ma
        join public.chapter_records r on r.id = ma.record_id and r.chapter_id = ma.chapter_id
        where ma.chapter_id = c.id
          and ma.attendance_status in ('present', 'absent', 'excused')
          and r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
      ) attendance_totals
      cross join lateral (
        select pg_catalog.count(*) as members,
          coalesce(pg_catalog.avg(coalesce(scored.score, 0)), 0) as mean_score
        from public.member_chapter_memberships m
        left join (
          select per_type.user_id,
            least(100, pg_catalog.sum(least(per_type.event_count::numeric / weights.cap, 1) * weights.weight)) as score
          from (
            select e.user_id, e.event_type, pg_catalog.count(*) as event_count
            from public.organization_engagement_events e
            where e.organization_id = org and e.chapter_id = c.id
              and e.occurred_at >= generated - interval '180 days'
            group by e.user_id, e.event_type
          ) per_type
          join (values
            ('meeting_check_in', 10, 30),
            ('qa_contribution', 15, 25),
            ('poll_vote', 5, 10),
            ('survey_response', 3, 10),
            ('event_rsvp', 8, 15),
            ('authorized_contact', 5, 10)
          ) as weights(event_type, cap, weight) on weights.event_type = per_type.event_type
          group by per_type.user_id
        ) scored on scored.user_id = m.user_id
        where m.chapter_id = c.id and m.status = 'active'
      ) engagement_totals
      cross join lateral (
        select pg_catalog.count(distinct p.user_id) as value
        from public.member_presence p
        join public.member_chapter_memberships m
          on m.user_id = p.user_id and m.chapter_id = c.id and m.status = 'active'
        where p.organization_id = org and p.last_seen_at >= generated - interval '30 days'
      ) usage_totals
      where c.organization_id = org
    ), '[]'::jsonb),
    'heatmapPoints', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'kind', 'grievance', 'rowKey', counted.chapter_id,
        'colKey', counted.case_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.case_type)
      from (
        with scoped as (
          select cs.user_id, cs.chapter_id, cs.case_type, cs.status,
            case when cs.step in ('Intake', 'intake') then 0 else 2 end as step_bucket
          from public.member_cases cs
          where cs.organization_id = org and cs.chapter_id is not null
            and cs.created_at >= period_start and cs.created_at < period_end
        ), totals as (
          select scoped.chapter_id, scoped.case_type,
            pg_catalog.count(distinct scoped.user_id) as person_count
          from scoped group by scoped.chapter_id, scoped.case_type
        ), minima as (
          select cells.chapter_id, cells.case_type, pg_catalog.min(cells.cell_people) as minimum_cell
          from (
            select scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket,
              pg_catalog.count(distinct scoped.user_id) as cell_people
            from scoped
            group by scoped.chapter_id, scoped.case_type, scoped.status, scoped.step_bucket
          ) cells
          group by cells.chapter_id, cells.case_type
        )
        select totals.chapter_id, totals.case_type, totals.person_count
        from totals join minima using (chapter_id, case_type)
        where totals.person_count >= privacy_threshold and minima.minimum_cell >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementCounts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', counted.chapter_id,
        'eventType', counted.event_type,
        'count', (pg_catalog.floor(counted.person_count / 5.0) * 5)::integer
      ) order by counted.chapter_id, counted.event_type)
      from (
        select e.chapter_id, e.event_type, pg_catalog.count(distinct e.user_id) as person_count
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
        group by e.chapter_id, e.event_type
        having pg_catalog.count(distinct e.user_id) >= privacy_threshold
      ) counted
    ), '[]'::jsonb),
    'engagementHistogram', pg_catalog.jsonb_build_object(
      'organizationId', org, 'privacyThreshold', privacy_threshold
    ),
    -- One row per recorded meeting in the last 180 days (newest 200). Counts
    -- are distinct people (one attendance row per record and member), rounded
    -- down to 5 and withheld below the person floor. The roster (rsvpGoing) is
    -- published only when the non-attending cohort also clears the floor, so
    -- rsvpGoing minus checkIns cannot disclose a small absent cohort.
    'attendanceEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org, 'id', counted.record_id, 'chapterId', counted.chapter_id,
        'startsAt', counted.occurred_at,
        'checkIns', case when counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.present_people / 5.0) * 5)::integer else null end,
        'rsvpGoing', case when counted.present_people >= privacy_threshold
          and counted.roster_people - counted.present_people >= privacy_threshold
          then (pg_catalog.floor(counted.roster_people / 5.0) * 5)::integer else null end
      ) order by counted.occurred_at desc, counted.record_id)
      from (
        select r.id as record_id, r.chapter_id, r.occurred_at,
          pg_catalog.count(*) filter (where ma.attendance_status = 'present') as present_people,
          pg_catalog.count(*) filter (where ma.attendance_status in ('present', 'absent', 'excused')) as roster_people
        from public.chapter_records r
        join public.chapters c on c.id = r.chapter_id and c.organization_id = org
        join public.meeting_attendance ma on ma.record_id = r.id and ma.chapter_id = r.chapter_id
        where r.lifecycle_status <> 'archived'
          and r.occurred_at >= attendance_start and r.occurred_at <= generated
        group by r.id, r.chapter_id, r.occurred_at
        order by r.occurred_at desc, r.id
        limit 200
      ) counted
    ), '[]'::jsonb),
    'attendanceCohorts', pg_catalog.jsonb_build_object(
      'organizationId', org, 'firstTime', null, 'repeat', null, 'suppressed', true
    )
  );
  -- Server-derived export counts for this issued snapshot: every published
  -- row, and the rows that carry at least one withheld (null) measure.
  select pg_catalog.count(*)::integer,
    (pg_catalog.count(*) filter (where exists (
      select 1 from pg_catalog.jsonb_each(published.value) field
      where field.value = 'null'::jsonb
    )))::integer
  into published_rows, withheld_rows
  from pg_catalog.jsonb_array_elements(
    (result -> 'chapters') || (result -> 'cases') || (result -> 'series')
      || (result -> 'heatmapPoints') || (result -> 'engagementCounts')
      || (result -> 'attendanceEvents')
  ) published;
  result := result || pg_catalog.jsonb_build_object('snapshotId', snapshot_id);
  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org, 'surface', 'organization_analytics_snapshot',
    'entityId', snapshot_id, 'rowCount', published_rows, 'suppressedCount', withheld_rows
  ));
  return result;
end;
end;
$function$;

-- public.get_organization_analytics_workspace()
CREATE OR REPLACE FUNCTION public.get_organization_analytics_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.member_pin_require_full_session();
declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor');
  health_threshold integer := private.organization_limit(org, 'limits.analytics.chapter_health_cohort_floor');
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
begin
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'chapterHealthFloor', health_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', least(100, activity.event_count * 10),
        'profileReadiness',
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50,
        'followThrough', least(100, activity.follow_count * 20),
        'overallScore', pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3),
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', activity.last_activity
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.user_id = m.user_id
          -- Preserve train 2a participation semantics: page views are telemetry.
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and (may_read_unassigned or cs.steward_user_id = actor or cs.coordinator_user_id = actor)
          and private.casework_staff_can_access(cs.id)
      ) cases
      where m.status = 'active'
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < health_threshold,
        'score', case when totals.member_count >= health_threshold then latest.score else null end,
        'drivers', case when totals.member_count >= health_threshold and latest.id is not null
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= health_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= health_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s where s.chapter_id = c.id
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$;

-- public.freeze_chapter_connection_issue_aggregates(text,text)
CREATE OR REPLACE FUNCTION public.freeze_chapter_connection_issue_aggregates(p_selected_hat text, p_chapter_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  chapter text;
  quarter record;
  already boolean;
  topic_count integer;
  frozen_at timestamptz;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
org := private.mi1_require_selected_organization();
  chapter := private.chapter_connection_require_chapter(org, p_chapter_id);
  perform private.chapter_connection_require_hat(org, p_selected_hat, chapter, array['advisor', 'admin', 'vp']);

  select * into quarter from private.chapter_connection_previous_quarter();

  select r.frozen_at, r.published_topic_count into frozen_at, topic_count
  from private.chapter_connection_aggregate_runs r
  where r.chapter_id = chapter and r.period_key = quarter.period_key
  for update;
  already := found;

  if not already then
    frozen_at := pg_catalog.now();
    insert into private.chapter_connection_aggregate_runs
      (chapter_id, organization_id, period_key, period_starts_at, period_ends_at, frozen_at, published_topic_count)
    values (chapter, org, quarter.period_key, quarter.starts_at, quarter.ends_at, frozen_at, 0);

    insert into private.chapter_connection_issue_aggregates (chapter_id, period_key, topic_key, band)
    select
      chapter,
      quarter.period_key,
      per_topic.topic_key,
      -- Band by share of the window's contributors: at most a third, at most
      -- two thirds, or more. Integer arithmetic, so a boundary share lands on
      -- the same band the client-side preview assigns it.
      case
        when per_topic.contributors * 3 <= total.contributors then 'some'
        when per_topic.contributors * 3 <= total.contributors * 2 then 'many'
        else 'most'
      end
    from (
      select t.topic_key, pg_catalog.count(distinct t.contributor_user_id) as contributors
      from private.chapter_connection_source_tags t
      where t.chapter_id = chapter
        and t.organization_id = org
        and t.status = 'confirmed'
        and t.topic_key is not null
        and t.source_occurred_at >= quarter.starts_at
        and t.source_occurred_at < quarter.ends_at
      group by t.topic_key
    ) per_topic
    cross join (
      select pg_catalog.count(distinct t.contributor_user_id) as contributors
      from private.chapter_connection_source_tags t
      where t.chapter_id = chapter
        and t.organization_id = org
        and t.status = 'confirmed'
        and t.source_occurred_at >= quarter.starts_at
        and t.source_occurred_at < quarter.ends_at
    ) total
    where per_topic.contributors >= private.organization_limit(org, 'limits.intelligence.connection_issue_floor')
      and total.contributors - per_topic.contributors >= private.organization_limit(org, 'limits.intelligence.connection_issue_floor');
    get diagnostics topic_count = row_count;

    update private.chapter_connection_aggregate_runs r
    set published_topic_count = topic_count
    where r.chapter_id = chapter and r.period_key = quarter.period_key;

    if exists (
      select 1 from private.chapter_connection_profiles p
      where p.chapter_id = chapter
        and p.publication_status = 'published'
        and p.share_analyzed_issues
    ) then
      perform private.chapter_connection_bump_epoch();
    end if;

    perform private.chapter_connection_audit(org, chapter, 'chapter_connection_aggregates_frozen',
      pg_catalog.jsonb_build_object(
        'entityType', 'aggregate_period',
        'entityId', quarter.period_key,
        'operation', 'freeze',
        'count', topic_count
      ));
  end if;

  return pg_catalog.jsonb_build_object(
    'chapterId', chapter,
    'periodKey', quarter.period_key,
    'periodStartsAt', quarter.starts_at,
    'periodEndsAt', quarter.ends_at,
    'frozenAt', frozen_at,
    'alreadyFrozen', already,
    'topics', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('key', a.topic_key, 'band', a.band) order by a.topic_key)
      from private.chapter_connection_issue_aggregates a
      where a.chapter_id = chapter and a.period_key = quarter.period_key
    ), '[]'::jsonb)
  );
end;
$function$;

-- public.get_chapter_health_portfolio()
CREATE OR REPLACE FUNCTION public.get_chapter_health_portfolio()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();
  return (
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'chapterId', chapter.id,
    'chapterName', chapter.name,
    'databaseDate', current_date,
    'measuredOn', latest.measured_on,
    'cohortProtected', coalesce(latest.member_count, 0) < private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor'),
    'memberCount', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then latest.member_count else null end,
    'score', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then latest.score else null end,
    'recordedAt', latest.created_at,
    'recordedBy', case when latest.id is null then null else coalesce(
      nullif(pg_catalog.btrim(snapshot_creator.full_name), ''), 'Former staff member') end,
    'revisedAt', latest.updated_at,
    'revisedBy', case when latest.updated_at is null then null else coalesce(
      nullif(pg_catalog.btrim(snapshot_reviser.full_name), ''), 'Former staff member') end,
    'drivers', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then pg_catalog.jsonb_build_object(
      'participation', latest.participation,
      'caseTimeliness', latest.case_timeliness,
      'stewardCapacity', latest.steward_capacity,
      'trainingCoverage', latest.training_coverage,
      'communicationReach', latest.communication_reach,
      'governanceReadiness', latest.governance_readiness
    ) else null end,
    'trend', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'measuredOn', trend.measured_on, 'score', trend.score
      ) order by trend.measured_on)
      from (
        select snapshot.measured_on, snapshot.score
        from public.chapter_health_snapshots snapshot
        where snapshot.chapter_id = chapter.id and snapshot.member_count >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor')
        order by snapshot.measured_on desc limit 12
      ) trend
    ), '[]'::jsonb) else '[]'::jsonb end,
    'coaching', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', coaching.id,
        'summary', coaching.summary,
        'nextAction', coaching.next_action,
        'attentionLevel', coaching.attention_level,
        'createdAt', coaching.created_at,
        'authorName', coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Former staff member')
      ) order by coaching.created_at desc)
      from (
        select * from public.chapter_health_coaching health_coaching
        where health_coaching.chapter_id = chapter.id
        order by health_coaching.created_at desc limit 20
      ) coaching
      left join public.member_profiles profile on profile.id = coaching.author_id
    ), '[]'::jsonb)
  ) order by
      case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then latest.score else null end nulls last,
      chapter.name), '[]'::jsonb)
  from public.chapters chapter
  left join lateral (
    select * from public.chapter_health_snapshots snapshot
    where snapshot.chapter_id = chapter.id
    order by snapshot.measured_on desc limit 1
  ) latest on true
  left join public.member_profiles snapshot_creator on snapshot_creator.id = latest.created_by
  left join public.member_profiles snapshot_reviser on snapshot_reviser.id = latest.updated_by
  where private.mfa_satisfied()
    and private.can_manage_chapter_health(chapter.id)
  );
end;
$function$;

-- public.create_member_invitation(text,text,text,text,text,text)
CREATE OR REPLACE FUNCTION public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
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
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  if caller_chapter is null or p_chapter_id is distinct from caller_chapter then
    raise exception 'invitation not permitted' using errcode = '42501';
  end if;

  -- Count before duplicate/existing-account branches. Those branches must not
  -- be a free unbounded address-probing endpoint.
  if not private.consume_member_invitation_admin_limit(
    'admin:' || caller::text, 'create-hour', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_admin_hourly'), interval '1 hour'
  ) or not private.consume_member_invitation_admin_limit(
    'chapter:' || caller_chapter, 'chapter-day', private.organization_limit(private.current_member_organization(), 'limits.security.invitation_chapter_daily'), interval '1 day'
  ) then
    raise exception 'invitation rate limited' using errcode = 'P0001';
  end if;

  if pg_catalog.char_length(clean_email) not between 3 and 254
     or clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or pg_catalog.char_length(clean_name) not between 2 and 120
     or clean_name ~ '[[:cntrl:]]'
     or clean_hash !~ '^[0-9a-f]{64}$'
     or clean_locale not in ('en', 'es')
     or (clean_role is not null and clean_role not in ('steward', 'coordinator', 'advisor')) then
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
    (clean_email, clean_name, clean_first, clean_initials, caller_chapter,
     clean_role, clean_locale, clean_hash, 'pending', 1, caller,
     clock_timestamp() + interval '15 minutes')
  returning * into invitation_row;

  perform private.audit_member_invitation(
    invitation_row.id, caller_chapter, caller, 'invite_requested',
    pg_catalog.jsonb_build_object('chapterId', caller_chapter,
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

-- public.resend_member_invitation(uuid,text)
CREATE OR REPLACE FUNCTION public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Installed Main carries this routine wrapped by the reviewed case-graph
  -- entry block of 20260907151000 (gate before declaration initializers);
  -- re-emitting it keeps that outer gate.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.require_member_invitation_admin_chapter();
  clean_hash text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_token_hash, '')));
  old_row public.member_invitations%rowtype;
  new_row public.member_invitations%rowtype;
begin
  if caller is null
     or not private.member_has_chapter_role(caller_chapter, array['admin']) then
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

  select * into old_row
  from public.member_invitations
  where id = p_invitation_id and chapter_id = caller_chapter
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
     replaces_id, expires_at, kind)
  values
    (old_row.normalized_email, old_row.full_name, old_row.first_name,
     old_row.initials, old_row.chapter_id, old_row.initial_role, old_row.locale,
     clean_hash, 'pending', old_row.delivery_version + 1, caller, old_row.id,
     clock_timestamp() + interval '15 minutes', old_row.kind)
  returning * into new_row;

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
    'locale', new_row.locale
  );
end;
end;
$function$;

-- public.claim_mfa_recovery_code(text)
CREATE OR REPLACE FUNCTION public.claim_mfa_recovery_code(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);

declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean text := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  prefix text;
  set_row public.mfa_recovery_code_sets%rowtype;
  code_row public.mfa_recovery_codes%rowtype;
  claim_token text;
  recovery_limit integer;
  recovery_lock_minutes integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();
  -- Pin the proven Auth row through claim commit. If external revocation won
  -- the race after JWT verification, this lookup observes no row and refuses.
  perform 1
  from auth.sessions s
  where s.id = current_session
    and s.user_id = caller
  for key share;
  if not found then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  current_handle := private.member_session_handle(current_session);
  recovery_limit := private.organization_limit(private.current_member_organization(), 'limits.security.mfa_recovery_failures');
  recovery_lock_minutes := private.organization_limit(private.current_member_organization(), 'limits.security.mfa_recovery_lock_minutes');

  if clean !~ '^UG[A-F0-9]{16}$' then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;
  select * into set_row
  from public.mfa_recovery_code_sets
  where user_id = caller
  for update;
  if not found
     or (set_row.locked_until is not null and set_row.locked_until > pg_catalog.now()) then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;

  prefix := pg_catalog.substr(clean, 3, 8);
  select * into code_row
  from public.mfa_recovery_codes
  where user_id = caller
    and generation = set_row.generation
    and code_prefix = prefix
    and used_at is null
    and (claim_expires_at is null or claim_expires_at <= pg_catalog.now())
  for update;
  if not found or extensions.crypt(clean, code_row.code_hash) <> code_row.code_hash then
    update public.mfa_recovery_code_sets
    set failed_attempts = case when failed_attempts >= recovery_limit - 1 then 0 else failed_attempts + 1 end,
        locked_until = case
          when failed_attempts >= recovery_limit - 1 then pg_catalog.now() + pg_catalog.make_interval(mins => recovery_lock_minutes)
          else null
        end
    where user_id = caller;
    return pg_catalog.jsonb_build_object('accepted', false);
  end if;

  claim_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  update public.mfa_recovery_codes
  set claimed_at = pg_catalog.now(),
      claim_expires_at = pg_catalog.now() + interval '2 minutes',
      claim_token_hash = pg_catalog.encode(
        extensions.digest(claim_token, 'sha256'), 'hex'),
      claim_session_handle = current_handle
  where id = code_row.id;
  update public.mfa_recovery_code_sets
  set failed_attempts = 0,
      locked_until = null
  where user_id = caller;

  return pg_catalog.jsonb_build_object(
    'claimToken', claim_token,
    'userId', caller,
    'sessionHandle', current_handle,
    'expiresIn', 120);
end;
end;
$function$;

-- public.check_in_to_event(text,text)
CREATE OR REPLACE FUNCTION public.check_in_to_event(p_event_id text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- One literal for both refusals (: a bound refusal is
  -- indistinguishable from a wrong code). Same SQLSTATE and message the
  -- raised refusal carried, so every surface reports the same failure.
  refusal constant jsonb := pg_catalog.jsonb_build_object(
    'checkedIn', false,
    'refused', true,
    'code', '22023',
    'message', 'invalid check-in code'
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

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023';
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
$function$;

do $postflight$
declare affected integer;
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) <> '5f9e7c24eef313065b87545c17b9b86c' then
    raise exception 'installed switch-limits body differs from reviewed bytes: private.enqueue_notification_deliveries()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_snapshot()'::regprocedure)) <> '59b234d370247e421a127aebcedec23c' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.get_organization_analytics_snapshot()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_organization_analytics_workspace()'::regprocedure)) <> 'b18bccf2f5cf3d658bcbb8444fb37c8e' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.get_organization_analytics_workspace()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.freeze_chapter_connection_issue_aggregates(text,text)'::regprocedure)) <> 'be59bc6c08202cbf755d39047602d5bc' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.freeze_chapter_connection_issue_aggregates(text,text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_chapter_health_portfolio()'::regprocedure)) <> '1c8e5572c8cb72daa5c73744deb285d5' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.get_chapter_health_portfolio()';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.create_member_invitation(text,text,text,text,text,text)'::regprocedure)) <> 'cf9f14f4346c49387c15dc19acb39abc' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.create_member_invitation(text,text,text,text,text,text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.resend_member_invitation(uuid,text)'::regprocedure)) <> '23f7d4b472c3342fe45336d1c620f3d4' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.resend_member_invitation(uuid,text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.claim_mfa_recovery_code(text)'::regprocedure)) <> 'f04f336b339407fc59b5f7176c0052d0' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.claim_mfa_recovery_code(text)';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.check_in_to_event(text,text)'::regprocedure)) <> '53e93ba7a2064f3fe809ea4ac96230d6' then
    raise exception 'installed switch-limits body differs from reviewed bytes: public.check_in_to_event(text,text)';
  end if;
  if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure), 'UTF8')), 'hex') <> 'b4d3bf807a8f291986f5fd297fa058e8a67cf399ebf147e94f28f5270c74bb62' then
    raise exception 'installed notification enqueue SHA-256 differs from reviewed bytes';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p cross join pg_temp.switch_limits_enqueue_snapshot s
      where p.oid = 'private.enqueue_notification_deliveries()'::regprocedure and
      (p.proowner is distinct from s.proowner or p.proacl is distinct from s.proacl
       or (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.oid) from pg_catalog.pg_trigger t where t.tgfoid = p.oid) is distinct from s.triggers)) then
    raise exception 'notification enqueue ownership, grants or trigger binding changed';
  end if;
  update private.account_lifecycle_trigger_review
  set definition_hash = '5f9e7c24eef313065b87545c17b9b86c'
  where kind = 'function' and schema_name = 'private' and table_name = ''
    and object_name = 'enqueue_notification_deliveries()'
    and definition_hash = '4e2e50ab29a5fdf267f0d80bcada4bbf';
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'notification enqueue lifecycle pin was not updated exactly once'; end if;
end;
$postflight$;

-- The public accept route must consume a network bucket before deciding whether
-- a token is usable. It passes only a digest. An unknown token keeps the old
-- platform cap; a known token selects an organization-specific bucket without
-- returning that fact to the caller. The old service RPC remains for existing
-- callers and its pruning contract is unchanged.
create function public.consume_member_invitation_accept_limit_for_token(
  p_scope_hash text, p_token_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  current_row private.member_invitation_accept_limits%rowtype;
  moment timestamptz := clock_timestamp();
  accept_org uuid;
  scope_key text;
  cap integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or (p_token_hash is not null and p_token_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid rate scope' using errcode = '22023';
  end if;
  if p_token_hash is not null then
    select c.organization_id into accept_org
    from public.member_invitations i
    join public.chapters c on c.id = i.chapter_id
    where i.token_hash = p_token_hash and i.status = 'pending';
  end if;
  cap := private.organization_limit(accept_org, 'limits.security.invitation_accept_per_15_minutes');
  scope_key := case when accept_org is null then p_scope_hash else
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      p_scope_hash || ':' || accept_org::text, 'UTF8')), 'hex') end;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-rate:' || scope_key, 509)
  );
  -- Keep the reviewed non-waiting, bounded prune and lock order.
  if pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('member-invitation-accept-prune', 509)
  ) then
    delete from private.member_invitation_accept_limits as stale
    where stale.ctid in (
      select candidate.ctid
      from private.member_invitation_accept_limits as candidate
      where candidate.window_started_at <= moment - interval '15 minutes'
      order by candidate.window_started_at, candidate.scope_hash
      limit 200
      for update skip locked
    );
  end if;
  select * into current_row
  from private.member_invitation_accept_limits
  where scope_hash = scope_key
  for update;
  if not found then
    insert into private.member_invitation_accept_limits
      (scope_hash, window_started_at, request_count)
    values (scope_key, moment, 1);
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.window_started_at + interval '15 minutes' <= moment then
    update private.member_invitation_accept_limits
    set window_started_at = moment, request_count = 1
    where scope_hash = scope_key;
    return pg_catalog.jsonb_build_object('allowed', true, 'remaining', cap - 1);
  end if;
  if current_row.request_count >= cap then
    return pg_catalog.jsonb_build_object('allowed', false, 'remaining', 0);
  end if;
  update private.member_invitation_accept_limits
  set request_count = request_count + 1
  where scope_hash = scope_key;
  return pg_catalog.jsonb_build_object(
    'allowed', true, 'remaining', cap - current_row.request_count - 1
  );
end;
end;
$function$;
revoke all on function public.consume_member_invitation_accept_limit_for_token(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_member_invitation_accept_limit_for_token(text, text)
  to service_role;

commit;
