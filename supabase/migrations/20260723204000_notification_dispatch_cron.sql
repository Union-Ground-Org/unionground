-- REQ-UG-FULL-DEPTH-20260723 PR5: dispatch tick from the database.
-- The Vercel project's plan tier caps native cron frequency (Hobby = daily),
-- so the PRIMARY dispatch trigger is a pg_cron job POSTing to the dispatcher
-- endpoint every 5 minutes via pg_net; vercel.json keeps a daily cron as a
-- plan-safe backstop. Double-triggering is harmless: the claim RPC uses
-- FOR UPDATE SKIP LOCKED, so overlapping invocations never double-send.
--
-- The bearer secret lives in Supabase Vault under the name
-- 'notifications-dispatch-secret' (inserted at apply time, never in this
-- file). The endpoint lives in private.notification_controls.dispatch_url,
-- NOT hard-coded here: a hard-coded production URL means applying this
-- migration to any other Supabase project immediately schedules five-minute
-- calls against production. A fresh project gets NULL and the job stays inert
-- until someone deliberately points it somewhere.
--
-- While either the secret or the URL is absent the tick sends nothing at all —
-- the join keeps the job silent instead of hammering an endpoint with doomed
-- calls.
--
-- Fully guarded: environments without pg_cron/pg_net (local shadow DBs, CI)
-- skip scheduling without failing the deploy.

alter table private.notification_controls
  add column if not exists dispatch_url text
  check (dispatch_url is null or dispatch_url ~ '^https://[[:graph:]]+$');

-- pg_net is fire-and-forget: net.http_post returns immediately with a request
-- id and the response lands asynchronously in net._http_response. Without
-- recording that id, a tick that 401s every five minutes is indistinguishable
-- from a tick that works — cron.job_run_details would report success either
-- way, because the SQL succeeded. Keeping the ids is what makes the health
-- RPC below able to answer "is dispatch actually reaching the endpoint?".
create table if not exists private.notification_dispatch_ticks (
  request_id bigint primary key,
  created_at timestamptz not null default now()
);

revoke all on private.notification_dispatch_ticks from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then
    return;
  end if;
  execute 'create extension if not exists pg_cron';

  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_net') then
    return;
  end if;
  execute 'create extension if not exists pg_net';

  perform cron.unschedule(jobid) from cron.job where jobname = 'notifications-dispatch-tick';
  perform cron.schedule(
    'notifications-dispatch-tick',
    '*/5 * * * *',
    $job$
    insert into private.notification_dispatch_ticks (request_id)
    select net.http_post(
      url := c.dispatch_url,
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || s.decrypted_secret,
        'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000)
    from private.notification_controls c
    cross join vault.decrypted_secrets s
    where c.id
      and c.dispatch_url is not null
      and s.name = 'notifications-dispatch-secret'
    limit 1
    $job$);

  -- The queue must age out even when nothing is claiming it: an unconfigured
  -- provider, a switched-off kill flag, or an endpoint that has been 401ing
  -- for a week all mean the dispatcher never runs the sweep itself.
  perform cron.unschedule(jobid) from cron.job where jobname = 'notifications-expiry-sweep';
  perform cron.schedule(
    'notifications-expiry-sweep',
    '20 4 * * *',
    $job$
    select public.expire_notification_deliveries();
    delete from private.notification_dispatch_ticks where created_at < now() - interval '7 days';
    delete from private.notification_outbound_counters where day < (now() - interval '90 days')::date;
    $job$);
end
$$;

-- Operational read-out. Answers the question "did outbound delivery quietly
-- stop working?" without a console: tick outcomes from the last hour, the
-- depth and age of the queue, and terminal failures in the last day.
create or replace function public.get_notification_dispatch_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ticks jsonb := '[]'::jsonb;
  queue jsonb;
  controls jsonb;
begin
  if pg_catalog.to_regclass('net._http_response') is not null then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'requestId', t.request_id,
      'at', t.created_at,
      'status', r.status_code,
      'timedOut', r.timed_out,
      'error', r.error_msg)), '[]'::jsonb)
    into ticks
    from private.notification_dispatch_ticks t
    left join net._http_response r on r.id = t.request_id
    where t.created_at > pg_catalog.now() - interval '1 hour';
  end if;

  -- Per-channel pending counts are not decoration: the dispatcher uses them to
  -- decide whether a channel with no provider configured is quietly stranding
  -- work, which is otherwise indistinguishable from a healthy idle channel.
  select pg_catalog.jsonb_build_object(
    'pending', pg_catalog.count(*) filter (where status = 'pending'),
    'pending_email', pg_catalog.count(*) filter (where status = 'pending' and channel = 'email'),
    'pending_push', pg_catalog.count(*) filter (where status = 'pending' and channel = 'push'),
    'sending', pg_catalog.count(*) filter (where status = 'sending'),
    'failedToday', pg_catalog.count(*) filter (
      where status = 'failed' and updated_at > pg_catalog.now() - interval '24 hours'),
    'sentToday', pg_catalog.count(*) filter (
      where status = 'sent' and sent_at > pg_catalog.now() - interval '24 hours'),
    'oldestPendingAt', pg_catalog.min(created_at) filter (where status = 'pending'))
  into queue
  from public.member_notification_deliveries;

  select pg_catalog.jsonb_build_object(
    'outboundEnabled', c.outbound_enabled,
    'dispatchUrlSet', c.dispatch_url is not null)
  into controls
  from private.notification_controls c where c.id;

  return pg_catalog.jsonb_build_object('ticks', ticks, 'queue', queue, 'controls', controls);
end;
$$;

revoke all on function public.get_notification_dispatch_health() from public, anon, authenticated;
grant execute on function public.get_notification_dispatch_health() to service_role;

notify pgrst, 'reload schema';
