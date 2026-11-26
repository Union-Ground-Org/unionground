-- REQ-UG-FULL-DEPTH-20260723 PR5: dispatcher claim/record/expire RPCs.
-- All three are service-role-only (the cron dispatcher is the sole caller),
-- following the member_ai_requests reserve/release grant idiom. The delivery
-- table itself carries no service_role DML grant, so these functions are the
-- only way the state machine can move.
--
-- Retry model: claim increments attempts and flips rows to 'sending', handing
-- back the attempt number it just wrote. That number is the LEASE. A result
-- only lands if the row is still 'sending' AND still on the same attempt, so a
-- late result from a previous invocation cannot reopen a row that has since
-- been recorded, and a duplicate result is a no-op rather than a resurrection.
--
-- 'sent' and 'skipped' are terminal. 'failed' returns the row to 'pending'
-- with capped exponential backoff until the 6th attempt, after which it is
-- terminal. A 'sending' row untouched for 15 minutes is treated as a crashed
-- invocation and becomes claimable again — but only while it is still inside
-- both the 48-hour window and the 6-attempt budget, so a row whose result can
-- never be recorded terminates instead of looping forever.

-- 1. Expiry sweep. Deliberately NOT folded into the claim: an unconfigured or
--    switched-off channel never claims, and a queue that only ages out during
--    a claim would then grow without bound. pg_cron runs this daily and the
--    dispatcher runs it every tick, whatever the channel configuration says.
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
begin
  -- A 'sending' row is a row some dispatcher invocation currently HOLDS a lease
  -- on. Terminalizing it while that send is in flight is not a cleanup, it is a
  -- race: the invocation completes, tries to record its result, finds the row no
  -- longer 'sending' on its attempt, and the result is discarded — so a message
  -- the provider genuinely accepted is recorded as never sent and is sent again
  -- on the next reclaim. Expiry may only touch a lease that is demonstrably
  -- abandoned, which is the same 15-minute staleness the claim watchdog uses.
  -- 'pending' rows hold no lease and can terminate immediately.

  -- Ancient backlog never ships: once a provider is (re)configured we must not
  -- blast members with two-day-old alerts.
  update public.member_notification_deliveries
    set status = 'skipped', last_error = 'expired before dispatch', updated_at = pg_catalog.now()
    where created_at < pg_catalog.now() - interval '48 hours'
      and (
        status = 'pending'
        or (status = 'sending' and updated_at < pg_catalog.now() - interval '15 minutes')
      );
  get diagnostics expired = row_count;

  -- A row that has burned its whole attempt budget without ever recording a
  -- result (provider accepted but the record call kept failing, say) must not
  -- stay reclaimable.
  update public.member_notification_deliveries
    set status = 'failed',
        last_error = coalesce(last_error, 'attempt budget exhausted'),
        updated_at = pg_catalog.now()
    where attempts >= 6
      and (
        status = 'pending'
        or (status = 'sending' and updated_at < pg_catalog.now() - interval '15 minutes')
      );
  get diagnostics exhausted = row_count;

  -- Belt and braces for the in-app-only rule: if anything ever manages to
  -- enqueue a delivery for a notification that is not outbound-eligible, it
  -- terminates here instead of reaching a provider. A live lease is left alone
  -- for the same reason as above; the kind cannot change under it, so one extra
  -- cycle costs nothing.
  update public.member_notification_deliveries d
    set status = 'skipped', last_error = 'kind is not outbound-eligible', updated_at = pg_catalog.now()
    from public.member_notifications n
    where n.id = d.notification_id
      and n.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events')
      and (
        d.status = 'pending'
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes')
      );
  get diagnostics ineligible = row_count;

  return pg_catalog.jsonb_build_object(
    'expired', expired, 'exhausted', exhausted, 'ineligible', ineligible);
end;
$$;

revoke all on function public.expire_notification_deliveries() from public, anon, authenticated;
grant execute on function public.expire_notification_deliveries() to service_role;

-- 2. Claim.
create or replace function public.claim_notification_deliveries(p_channel text, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap integer := greatest(1, least(coalesce(p_limit, 200), 500));
  -- Matches the per-member device cap in the subscriptions migration. Bounding
  -- it here too means one member can never turn a single delivery into an
  -- unbounded provider fan-out inside the dispatcher's invocation budget.
  max_subscriptions constant integer := 10;
  outbound_on boolean;
  claimed jsonb;
begin
  if p_channel is null or p_channel not in ('email', 'push', 'sms') then
    raise exception 'unknown channel' using errcode = '22023';
  end if;

  -- The database-side stop. Checked here as well as in the enqueue trigger so
  -- that switching outbound off halts sends already sitting in the queue,
  -- within one claim cycle, with no deploy and no dependency on Vercel.
  select c.outbound_enabled into outbound_on
    from private.notification_controls c where c.id;
  if not coalesce(outbound_on, false) then
    return '[]'::jsonb;
  end if;

  with candidates as (
    select d.id
    from public.member_notification_deliveries d
    where d.channel = p_channel
      and d.attempts < 6
      and d.created_at >= pg_catalog.now() - interval '48 hours'
      and (
        (d.status = 'pending' and d.next_attempt_at <= pg_catalog.now())
        or (d.status = 'sending' and d.updated_at < pg_catalog.now() - interval '15 minutes')
      )
    order by d.next_attempt_at
    limit cap
    for update skip locked
  ),
  flipped as (
    update public.member_notification_deliveries d
      set status = 'sending', attempts = d.attempts + 1, updated_at = pg_catalog.now()
      from candidates c
      where d.id = c.id
      returning d.id, d.notification_id, d.user_id, d.attempts
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', f.id,
    'kind', n.kind,
    'lang', coalesce(pr.language, 'en'),
    -- The lease the result must echo back.
    'attempt', f.attempts,
    'email', case when p_channel = 'email' then u.email end,
    'subscriptions', case when p_channel = 'push' then (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth_key))
      from (
        select s2.endpoint, s2.p256dh, s2.auth_key
        from public.member_push_subscriptions s2
        where s2.user_id = f.user_id
        order by s2.last_seen_at desc
        limit max_subscriptions
      ) s
    ) end)), '[]'::jsonb)
  into claimed
  from flipped f
  join public.member_notifications n on n.id = f.notification_id
  left join public.member_profiles pr on pr.id = f.user_id
  left join auth.users u on u.id = f.user_id;

  -- NOTE: title and body are deliberately absent. Provider payloads are
  -- generic per-kind templates, so the notification's own text must never
  -- leave the database — the dispatcher cannot leak what it never receives.
  return claimed;
end;
$$;

revoke all on function public.claim_notification_deliveries(text, integer) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(text, integer) to service_role;

-- 3. Record — bulk only.
--
-- One call per invocation rather than one per delivery. The per-row version
-- could not survive its own arithmetic: 100 sequential round trips at an
-- 8-second timeout is 800 seconds against a 300-second function ceiling, so a
-- slow database would strand already-sent rows in 'sending' and the watchdog
-- would send them a second time.
create or replace function public.record_notification_delivery_results(p_results jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  v_id uuid;
  v_attempt integer;
  v_status text;
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
    if v_status is null or v_status not in ('sent', 'failed', 'skipped') then
      raise exception 'unknown result status' using errcode = '22023';
    end if;
    if pg_catalog.jsonb_typeof(item -> 'deliveryId') <> 'string'
       or pg_catalog.jsonb_typeof(item -> 'attempt') <> 'number' then
      raise exception 'malformed result entry' using errcode = '22023';
    end if;
    v_id := (item ->> 'deliveryId')::uuid;
    v_attempt := (item ->> 'attempt')::integer;

    -- The lease predicate. `status = 'sending' and attempts = v_attempt` is
    -- what makes a stale or duplicate result a no-op instead of reopening a
    -- delivery that has already been recorded.
    if v_status = 'sent' then
      update public.member_notification_deliveries d
        set status = 'sent', sent_at = pg_catalog.now(),
            provider_message_id = pg_catalog.left(coalesce(item ->> 'providerMessageId', ''), 200),
            last_error = null, updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt;
    elsif v_status = 'skipped' then
      update public.member_notification_deliveries d
        set status = 'skipped',
            last_error = pg_catalog.left(coalesce(item ->> 'error', 'skipped'), 500),
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt;
    else
      update public.member_notification_deliveries d
        set status = case when d.attempts >= 6 then 'failed' else 'pending' end,
            last_error = pg_catalog.left(coalesce(item ->> 'error', 'send failed'), 500),
            -- greatest/least are grammar constructs — never pg_catalog-qualify.
            -- The inner least() caps the exponent: without it, a row that kept
            -- being reclaimed would eventually overflow int4 inside power()
            -- and wedge permanently.
            next_attempt_at = pg_catalog.now()
              + least(60, pg_catalog.power(2, least(d.attempts, 10))::integer) * interval '1 minute',
            updated_at = pg_catalog.now()
        where d.id = v_id and d.status = 'sending' and d.attempts = v_attempt;
    end if;

    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      applied := applied + 1;
    else
      ignored := ignored + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('applied', applied, 'ignored', ignored);
end;
$$;

revoke all on function public.record_notification_delivery_results(jsonb) from public, anon, authenticated;
grant execute on function public.record_notification_delivery_results(jsonb) to service_role;

notify pgrst, 'reload schema';
