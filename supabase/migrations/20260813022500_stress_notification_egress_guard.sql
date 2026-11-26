-- SEC-UG-STRESS-NOTIFICATION-EGRESS-20260812
--
-- Stress accounts are deliberately capable of exercising real application
-- writes, but they must never consume a real notification provider. The
-- notifications wave added cron and trigger producers after the stress lane's
-- original safeguards. Those producers legitimately called notify_member for
-- ledgered users, which created 959 real Resend attempts in one day.
--
-- Two boundaries are guarded:
--   1. notify_member drops typed notifications before copy/render/storage;
--   2. enqueue_notification_deliveries drops any typed direct insert that did
--      not use notify_member.
--
-- The stable identity is private.member_stress_ledger, never an email-domain
-- string. General seed notifications remain available to the stress harness.

set local lock_timeout = '5s';

create or replace function private.notify_member(
  p_user_id uuid,
  p_key text,
  p_args jsonb default '{}'::jsonb,
  p_kind text default 'general'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipient_lang text;
  copy_row private.notification_copy;
  rendered_title text;
  rendered_body text;
  arg record;
begin
  if p_user_id is null then
    return;
  end if;

  if p_kind in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments')
    and exists (
      select 1
      from private.member_stress_ledger l
      where l.user_id = p_user_id
    )
  then
    return;
  end if;

  select coalesce(p.language, 'en') into recipient_lang
  from public.member_profiles p where p.id = p_user_id;

  select * into copy_row
  from private.notification_copy c
  where c.key = p_key and c.lang = coalesce(recipient_lang, 'en');

  if copy_row.key is null then
    select * into copy_row
    from private.notification_copy c
    where c.key = p_key and c.lang = 'en';
  end if;

  if copy_row.key is null then
    raise exception 'unknown notification copy key: %', p_key;
  end if;

  rendered_title := copy_row.title;
  rendered_body := copy_row.body;

  for arg in select key, value from pg_catalog.jsonb_each_text(coalesce(p_args, '{}'::jsonb))
  loop
    rendered_title := pg_catalog.replace(rendered_title, '{' || arg.key || '}', arg.value);
    rendered_body := pg_catalog.replace(rendered_body, '{' || arg.key || '}', arg.value);
  end loop;

  insert into public.member_notifications (user_id, title, body, kind)
  values (p_user_id, rendered_title, rendered_body, p_kind);
end
$$;

revoke all on function private.notify_member(uuid, text, jsonb, text)
  from public, anon, authenticated, service_role;

comment on function private.notify_member(uuid, text, jsonb, text) is
  'Single copy-resolution point for member notifications. Typed notifications for ledgered stress users are dropped before storage or outbound enqueue.';

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
  max_per_recipient_hour constant integer := 12;
  max_per_recipient_day constant integer := 50;
  max_per_recipient_week constant integer := 5;
  max_org_day constant integer := 20000;
begin
  if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments') then
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
    select c.outbound_enabled into outbound_on
      from private.notification_controls c where c.id;
    if not coalesce(outbound_on, false) then
      return new;
    end if;

    select p.notification_prefs into prefs
      from public.member_profiles p where p.id = new.user_id;

    pref_value := prefs -> new.kind;
    if pref_value = 'false'::jsonb then
      return new;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0));

    select pg_catalog.count(*) into recent_hour
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '1 hour';

    select pg_catalog.count(*) into recent_day
      from public.member_notification_deliveries d
      where d.user_id = new.user_id
        and d.created_at > pg_catalog.now() - interval '24 hours';

    if new.kind not in ('deadlines', 'cases') then
      select pg_catalog.count(*) into recent_week
        from public.member_notification_deliveries d
        join public.member_notifications n2 on n2.id = d.notification_id
        where d.user_id = new.user_id
          and d.channel = 'email'
          and d.status <> 'skipped'
          and d.created_at > pg_catalog.now() - interval '7 days'
          and n2.kind not in ('deadlines', 'cases');
    end if;

    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.notification_outbound_counters c
      where c.day = current_date;

    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and recent_week >= max_per_recipient_week then
      limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;

    if limit_reason is not null then
      insert into public.member_notification_deliveries (notification_id, user_id, channel, status, last_error)
      values (new.id, new.user_id, 'email', 'skipped', limit_reason)
      on conflict (notification_id, channel) do nothing;
      return new;
    end if;

    insert into private.notification_outbound_counters (day, shard, enqueued)
    values (current_date, (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
    on conflict (day, shard) do update
      set enqueued = private.notification_outbound_counters.enqueued + 1;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    values (new.id, new.user_id, 'email')
    on conflict (notification_id, channel) do nothing;

    insert into public.member_notification_deliveries (notification_id, user_id, channel)
    select new.id, new.user_id, 'push'
    where exists (select 1 from public.member_push_subscriptions s where s.user_id = new.user_id)
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
$$;

revoke all on function private.enqueue_notification_deliveries()
  from public, anon, authenticated, service_role;

-- Quarantine older synthetic rows that have not been claimed. A 'sending' row
-- is an active lease already held in a dispatcher's memory; changing that row
-- cannot revoke the provider call and would make its eventual result look
-- stale. Leave active leases alone so record_notification_delivery_results can
-- record their real outcome. The enqueue guards above prevent any replacement.
update public.member_notification_deliveries d
set status = 'skipped',
    last_error = 'suppressed: synthetic stress account',
    updated_at = pg_catalog.now()
where d.status = 'pending'
  and exists (
    select 1
    from private.member_stress_ledger l
    where l.user_id = d.user_id
  );
