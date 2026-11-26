-- SEC-UG-MOBILE-PUSH-TOKEN-LIFECYCLE-20260814
-- Fixed reviewed enqueue repair; no provider calls or outbound activation.
-- Accept the normal lifecycle pin or the explicit SAMPLE repair lineage after
-- the intervening connected-automation definition has been applied.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
lock table supabase_migrations.schema_migrations in share row exclusive mode;
lock table private.account_lifecycle_trigger_review in share row exclusive mode;
do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) <> '758e6af4274350b85114e660338228b9'
     or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure), 'UTF8')), 'hex') <> '93689f8e5551d7a2a721fca3819c59c1029e42b964975d5368712b13228c1067' then
    raise exception 'unreviewed notification enqueue predecessor';
  end if;
  if (select count(*) from private.account_lifecycle_trigger_review where kind='function'
      and schema_name='private' and table_name='' and object_name='enqueue_notification_deliveries()'
      and definition_hash in ('758e6af4274350b85114e660338228b9','ab74f4cfa750c9c60dbe8581a7848571')) <> 1 then
    raise exception 'notification enqueue lifecycle predecessor is not reviewed';
  end if;
end;
$predecessor$;
-- Retain the function DDL lock using its already-reviewed security setting.
alter function private.enqueue_notification_deliveries() security definer;
do $coordinated$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) <> '758e6af4274350b85114e660338228b9' then
    raise exception 'notification enqueue changed during coordination';
  end if;
end;
$coordinated$;
create temporary table native_push_enqueue_repair_snapshot on commit drop as
  select p.proowner, p.proacl,
    (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_catalog.pg_trigger t where t.tgfoid=p.oid) as triggers
  from pg_catalog.pg_proc p where p.oid='private.enqueue_notification_deliveries()'::regprocedure;

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
    'appointments', 'workload', 'dues'
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

do $postflight$
declare affected integer;
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) <> '2ec5c00743fcd7bf5eec7b4af512fc48'
     or pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure), 'UTF8')), 'hex') <> '235052704e1bef96cde29ba71ccff77ed8e9b704a0bb9ab5faa4ac2058765522' then
    raise exception 'notification enqueue installed definition differs from reviewed bytes';
  end if;
  if exists(select 1 from pg_catalog.pg_proc p cross join pg_temp.native_push_enqueue_repair_snapshot s
      where p.oid='private.enqueue_notification_deliveries()'::regprocedure and
      (p.proowner is distinct from s.proowner or p.proacl is distinct from s.proacl
       or (select jsonb_agg(to_jsonb(t) order by t.oid) from pg_catalog.pg_trigger t where t.tgfoid=p.oid) is distinct from s.triggers)) then
    raise exception 'notification enqueue ownership, grants or trigger binding changed';
  end if;
  update private.account_lifecycle_trigger_review set definition_hash='2ec5c00743fcd7bf5eec7b4af512fc48'
    where kind='function' and schema_name='private' and table_name=''
      and object_name='enqueue_notification_deliveries()' and definition_hash in ('758e6af4274350b85114e660338228b9','ab74f4cfa750c9c60dbe8581a7848571');
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'notification enqueue lifecycle pin was not updated exactly once'; end if;
end;
$postflight$;
drop table pg_temp.native_push_enqueue_repair_snapshot;
commit;
