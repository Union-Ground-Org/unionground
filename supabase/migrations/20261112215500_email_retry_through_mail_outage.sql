-- BUG-UG-NOTIFICATION-EMAIL-DROPPED-AFTER-HOUR-LONG-MAIL-OUTAGE-20261112
-- (#8488). A notification email that failed on every attempt during a mail
-- provider outage became 'failed' after its 6th attempt, about 62 minutes
-- after the first (backoff 2, 4, 8, 16, 32 minutes), and was never sent when
-- the provider recovered (incident drill 2 of November 11, 2026).
--
-- Now an email delivery whose failure is the provider's (Resend answering 5xx
-- or 429, a timeout, a network or transport error) keeps its place in the
-- queue past the 6th attempt, retried at the 60-minute backoff cap, while it
-- is younger than 23 hours, so the first attempt after the provider answers
-- again sends it. 23 hours stays inside Resend's 24-hour Idempotency-Key
-- window, and the key is the delivery id, so a retry can never send a second
-- copy. A delivery still failing at 23 hours is marked failed with
-- 'mail provider unavailable for 23 hours; replay needed: <error>', which
-- the operator runbook tells the operator to list and
-- replay. A refusal from the provider (4xx) is final at the 6th attempt, as
-- before; push and SMS are unchanged.
--
-- The three bodies are the live definitions on a stack built from Main with
-- only these edits, so no later rewrite is undone:
--   claim_notification_deliveries: may claim such an email past attempt 6.
--   record_notification_delivery_results: keeps it pending, or marks it; a
--   deferral (a budget or authorization hold that sends nothing) keeps the
--   provider outage as the recorded cause.
--   expire_notification_deliveries: leaves it alone until 23 hours, then
--   marks it.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.claim_notification_deliveries(p_channel text, p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Preserve the installed case-graph wrapper before any defaults or row locks.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
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
    where d.channel = p_channel and (d.attempts < 6 or (d.channel = 'email' and d.created_at >= pg_catalog.now() - interval '23 hours'))
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
        'sessionHandle', i.session_handle,
        'targetKey', i.target_key))
      from (select i2.installation_id, i2.provider, i2.environment, i2.device_token, i2.token_hash, i2.session_handle,
          'native:' || i2.installation_id::text as target_key
        from public.member_native_push_installations i2 where i2.user_id = f.user_id
          and private.native_push_session_eligible(i2.user_id, i2.session_handle)
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
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_notification_delivery_results(p_results jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
            -- A deferral sends nothing, so it keeps a provider outage recorded
            -- before it: the 23-hour replay mark depends on that cause.
            last_error = case
              when d.channel = 'email' and coalesce(d.last_error, '') ~ '^resend (http (5[0-9]{2}|429)|timeout|network|error)$'
                then d.last_error
              else pg_catalog.left(coalesce(item ->> 'error', 'provider unavailable'), 500)
            end,
            next_attempt_at = pg_catalog.now() + interval '15 minutes',
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt
          and d.delivery_lease_epoch = v_lease_epoch;
    else
      update public.member_notification_deliveries d
        set status = case
              when d.attempts >= 6
                and (v_first_delivered_at is not null or v_has_current_receipt) then 'sent'
              when d.attempts >= 6 and not (d.channel = 'email' and d.created_at >= pg_catalog.now() - interval '23 hours'
                and coalesce(item ->> 'error', '') ~ '^resend (http (5[0-9]{2}|429)|timeout|network|error)$') then 'failed'
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
              when d.attempts >= 6 and d.channel = 'email' and d.created_at < pg_catalog.now() - interval '23 hours'
                and coalesce(item ->> 'error', '') ~ '^resend (http (5[0-9]{2}|429)|timeout|network|error)$'
                then pg_catalog.left('mail provider unavailable for 23 hours; replay needed: ' || (item ->> 'error'), 500)
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
end;
$function$;

CREATE OR REPLACE FUNCTION public.expire_notification_deliveries()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      and not (d.channel = 'email' and d.created_at >= pg_catalog.now() - interval '23 hours')
      and (d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes'))
    group by d.id
  ), updated as (
    update public.member_notification_deliveries d
      set status = case when c.first_delivered_at is null then 'failed' else 'sent' end,
          sent_at = coalesce(d.sent_at, c.first_delivered_at),
          last_error = case when c.first_delivered_at is null
            then case
              when d.channel = 'email' and coalesce(d.last_error, '') ~ '^resend (http (5[0-9]{2}|429)|timeout|network|error)$'
                then pg_catalog.left('mail provider unavailable for 23 hours; replay needed: ' || d.last_error, 500)
              else coalesce(d.last_error, 'attempt budget exhausted')
            end else null end,
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
$function$;

notify pgrst, 'reload schema';

commit;
