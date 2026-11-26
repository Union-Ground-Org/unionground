-- SYS-UG-24H-INTEGRATION-RECONCILIATION-20260812
--
-- 20260813022500 correctly suppresses provider-bound notifications for
-- ledgered stress identities, but it was authored before UB-WKL-03 added the
-- workload topic and receipt-specific weekly-cap behavior. Migration order
-- would otherwise replace that newer queue definition with the older one.
-- Re-emit the integrated function once, preserving both contracts.

set local lock_timeout = '5s';

create or replace function private.enqueue_notification_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
  if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload') then
    return new;
  end if;

  if exists (
    select 1
    from private.member_stress_ledger l
    where l.user_id = new.user_id
  ) then
    return new;
  end if;

  begin
    select c.outbound_enabled into outbound_on from private.notification_controls c where c.id;
    if not coalesce(outbound_on, false) then return new; end if;
    select p.notification_prefs into prefs from public.member_profiles p where p.id = new.user_id;
    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then return new; end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0));
    select pg_catalog.count(*) into recent_hour from public.member_notification_deliveries d
      where d.user_id = new.user_id and d.created_at > pg_catalog.now() - interval '1 hour';
    select pg_catalog.count(*) into recent_day from public.member_notification_deliveries d
      where d.user_id = new.user_id and d.created_at > pg_catalog.now() - interval '24 hours';

    if new.kind not in ('deadlines', 'cases') and not transactional_receipt then
      select pg_catalog.count(*) into recent_week
      from public.member_notification_deliveries d
      join public.member_notifications n2 on n2.id = d.notification_id
      where d.user_id = new.user_id and d.channel = 'email' and d.status <> 'skipped'
        and d.created_at > pg_catalog.now() - interval '7 days'
        and n2.kind not in ('deadlines', 'cases')
        and not (n2.kind = 'workload' and n2.workload_event = 'receipt');
    end if;

    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.notification_outbound_counters c where c.day = current_date;
    if recent_hour >= max_per_recipient_hour then limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and not transactional_receipt
      and recent_week >= max_per_recipient_week then limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then limit_reason := 'rate limited: org day';
    end if;

    if limit_reason is not null then
      insert into public.member_notification_deliveries (notification_id, user_id, channel, status, last_error)
      values (new.id, new.user_id, 'email', 'skipped', limit_reason)
      on conflict (notification_id, channel) do nothing;
      return new;
    end if;
    insert into private.notification_outbound_counters (day, shard, enqueued)
      values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
      on conflict (day, shard) do update set enqueued = private.notification_outbound_counters.enqueued + 1;
    insert into public.member_notification_deliveries (notification_id, user_id, channel)
      values (new.id, new.user_id, 'email') on conflict (notification_id, channel) do nothing;
    insert into public.member_notification_deliveries (notification_id, user_id, channel)
      select new.id, new.user_id, 'push'
      where exists (select 1 from public.member_push_subscriptions s where s.user_id = new.user_id)
      on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)', new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
$$;

revoke all on function private.enqueue_notification_deliveries()
  from public, anon, authenticated, service_role;

comment on function private.enqueue_notification_deliveries() is
  'Queues eligible member notification delivery while suppressing ledgered stress identities and preserving workload receipt rate semantics.';
