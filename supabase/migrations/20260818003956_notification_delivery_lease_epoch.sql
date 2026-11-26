-- A deferred delivery rewinds attempts so provider/configuration deferrals do
-- not consume the six real-send attempts. attempts therefore cannot also be a
-- unique lease token: after reclaim, an old result can carry the same attempt
-- number as the new claim. Keep retry accounting and lease identity separate.
alter table public.member_notification_deliveries
  add column delivery_lease_epoch bigint not null default 0
  constraint member_notification_deliveries_lease_epoch_check
  check (delivery_lease_epoch >= 0);

create or replace function public.expire_notification_deliveries()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    where n.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload')
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
$$;

revoke all on function public.expire_notification_deliveries()
  from public, anon, authenticated, service_role;
grant execute on function public.expire_notification_deliveries()
  to service_role;

create or replace function public.record_notification_delivery_results(p_results jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  target_item jsonb;
  v_id uuid;
  v_attempt integer;
  v_lease_epoch bigint;
  v_status text;
  v_target_key text;
  v_first_delivered_at timestamptz;
  v_has_current_receipt boolean;
  v_rows integer;
  applied integer := 0;
  ignored integer := 0;
begin
  if p_results is null or pg_catalog.jsonb_typeof(p_results) <> 'array' then
    raise exception 'p_results must be a json array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_results) > 500 then
    raise exception 'too many results' using errcode = '22023';
  end if;

  for item in select value from pg_catalog.jsonb_array_elements(p_results)
  loop
    v_status := item ->> 'status';
    if v_status is null or v_status not in ('sent', 'failed', 'skipped', 'deferred') then
      raise exception 'unknown result status' using errcode = '22023';
    end if;
    if coalesce(pg_catalog.jsonb_typeof(item -> 'deliveryId'), '') <> 'string'
       or coalesce(pg_catalog.jsonb_typeof(item -> 'attempt'), '') <> 'number'
       or coalesce(item ->> 'attempt', '') !~ '^[1-9][0-9]{0,8}$'
       or coalesce(pg_catalog.jsonb_typeof(item -> 'leaseEpoch'), '') <> 'number'
       or coalesce(item ->> 'leaseEpoch', '') !~ '^[1-9][0-9]{0,17}$'
       or (item ? 'deliveredTargetKeys'
         and pg_catalog.jsonb_typeof(item -> 'deliveredTargetKeys') <> 'array')
       or pg_catalog.jsonb_array_length(coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb)) > 20 then
      raise exception 'malformed result entry' using errcode = '22023';
    end if;
    v_id := (item ->> 'deliveryId')::uuid;
    v_attempt := (item ->> 'attempt')::integer;
    v_lease_epoch := (item ->> 'leaseEpoch')::bigint;
    v_has_current_receipt := pg_catalog.jsonb_array_length(
      coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb)) > 0;
    select pg_catalog.min(r.delivered_at)
      into v_first_delivered_at
      from private.member_notification_push_target_receipts r
      where r.delivery_id = v_id;

    if v_status = 'sent' then
      update public.member_notification_deliveries d
        set status = 'sent', sent_at = pg_catalog.now(),
            provider_message_id = pg_catalog.left(coalesce(item ->> 'providerMessageId', ''), 200),
            last_error = null, updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt
          and d.delivery_lease_epoch = v_lease_epoch;
    elsif v_status = 'skipped' then
      update public.member_notification_deliveries d
        set status = case when v_first_delivered_at is null then 'skipped' else 'sent' end,
            sent_at = case when v_first_delivered_at is null then d.sent_at else v_first_delivered_at end,
            last_error = case
              when v_first_delivered_at is null
                then pg_catalog.left(coalesce(item ->> 'error', 'skipped'), 500)
              else null
            end,
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt
          and d.delivery_lease_epoch = v_lease_epoch;
    elsif v_status = 'deferred' then
      update public.member_notification_deliveries d
        set status = 'pending',
            attempts = greatest(0, d.attempts - 1),
            last_error = pg_catalog.left(coalesce(item ->> 'error', 'provider unavailable'), 500),
            next_attempt_at = pg_catalog.now() + interval '15 minutes',
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt
          and d.delivery_lease_epoch = v_lease_epoch;
    else
      update public.member_notification_deliveries d
        set status = case
              when d.attempts >= 6
                and (v_first_delivered_at is not null or v_has_current_receipt) then 'sent'
              when d.attempts >= 6 then 'failed'
              else 'pending'
            end,
            sent_at = case
              when d.attempts >= 6
                and (v_first_delivered_at is not null or v_has_current_receipt)
                then coalesce(v_first_delivered_at, pg_catalog.now())
              else d.sent_at
            end,
            last_error = case
              when d.attempts >= 6
                and (v_first_delivered_at is not null or v_has_current_receipt) then null
              else pg_catalog.left(coalesce(item ->> 'error', 'send failed'), 500)
            end,
            next_attempt_at = pg_catalog.now()
              + least(60, pg_catalog.power(2, least(d.attempts, 10))::integer) * interval '1 minute',
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt
          and d.delivery_lease_epoch = v_lease_epoch;
    end if;

    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      if pg_catalog.jsonb_array_length(
           coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb)) > 0
         and not exists (
           select 1 from public.member_notification_deliveries d
           where d.id = v_id and d.channel = 'push'
         ) then
        raise exception 'target receipts require push delivery' using errcode = '22023';
      end if;
      for target_item in
        select value from pg_catalog.jsonb_array_elements(
          coalesce(item -> 'deliveredTargetKeys', '[]'::jsonb))
      loop
        if pg_catalog.jsonb_typeof(target_item) <> 'string' then
          raise exception 'malformed target receipt' using errcode = '22023';
        end if;
        v_target_key := target_item #>> '{}';
        if v_target_key !~ '^web:[0-9a-f]{64}$'
           and v_target_key !~ '^native:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
          raise exception 'malformed target receipt' using errcode = '22023';
        end if;
        insert into private.member_notification_push_target_receipts (delivery_id, target_key)
        values (v_id, v_target_key)
        on conflict (delivery_id, target_key) do nothing;
      end loop;
      applied := applied + 1;
    else
      ignored := ignored + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('applied', applied, 'ignored', ignored);
end;
$$;

revoke all on function public.record_notification_delivery_results(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_notification_delivery_results(jsonb)
  to service_role;

create or replace function public.claim_notification_deliveries(p_channel text, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap integer := greatest(1, least(coalesce(p_limit, 200), 500));
  max_subscriptions constant integer := 10;
  max_native_installations constant integer := 10;
  outbound_on boolean;
  claimed jsonb;
begin
  if p_channel is null or p_channel not in ('email', 'push', 'sms') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;
  select c.outbound_enabled into outbound_on from private.notification_controls c where c.id;
  if not coalesce(outbound_on, false) then return '[]'::jsonb; end if;

  with candidates as (
    select d.id from public.member_notification_deliveries d
    join public.member_notifications n on n.id = d.notification_id
    where d.channel = p_channel and d.attempts < 6
      and d.created_at >= pg_catalog.now() - interval '48 hours'
      and ((d.status = 'pending' and d.next_attempt_at <= pg_catalog.now())
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
      and ((n.kind = 'workload' and n.workload_event = 'receipt')
        or not private.member_focus_blocks(d.user_id, n.kind))
    order by d.next_attempt_at limit cap for update of d skip locked
  ), flipped as (
    update public.member_notification_deliveries d set
      status = 'sending', attempts = d.attempts + 1,
      delivery_lease_epoch = d.delivery_lease_epoch + 1,
      updated_at = pg_catalog.now()
    from candidates c where d.id = c.id
    returning d.id, d.notification_id, d.user_id, d.attempts, d.delivery_lease_epoch
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', f.id, 'kind', n.kind, 'lang', coalesce(pr.language, 'en'),
    'attempt', f.attempts,
    'leaseEpoch', f.delivery_lease_epoch,
    'event', n.workload_event,
    'receiptCode', n.workload_receipt_code,
    'email', case when p_channel = 'email' then u.email end,
    'subscriptions', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth_key,
        'targetKey', s.target_key))
      from (select s2.endpoint, s2.p256dh, s2.auth_key,
          'web:' || pg_catalog.encode(extensions.digest(s2.endpoint, 'sha256'), 'hex') as target_key
        from public.member_push_subscriptions s2 where s2.user_id = f.user_id
          and not exists (
            select 1 from private.member_notification_push_target_receipts r
            where r.delivery_id = f.id
              and r.target_key = 'web:' || pg_catalog.encode(extensions.digest(s2.endpoint, 'sha256'), 'hex')
          )
        order by s2.last_seen_at desc limit max_subscriptions) s
    ) end,
    'nativeInstallations', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'installationId', i.installation_id,
        'provider', i.provider,
        'environment', i.environment,
        'token', i.device_token,
        'tokenHash', i.token_hash,
        'targetKey', i.target_key))
      from (select i2.installation_id, i2.provider, i2.environment, i2.device_token, i2.token_hash,
          'native:' || i2.installation_id::text as target_key
        from public.member_native_push_installations i2 where i2.user_id = f.user_id
          and not exists (
            select 1 from private.member_notification_push_target_receipts r
            where r.delivery_id = f.id
              and r.target_key = 'native:' || i2.installation_id::text
          )
        order by i2.last_seen_at desc limit max_native_installations) i
    ) end)), '[]'::jsonb)
  into claimed from flipped f
  join public.member_notifications n on n.id = f.notification_id
  left join public.member_profiles pr on pr.id = f.user_id
  left join auth.users u on u.id = f.user_id;
  return claimed;
end;
$$;

revoke all on function public.claim_notification_deliveries(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_notification_deliveries(text, integer)
  to service_role;

notify pgrst, 'reload schema';
