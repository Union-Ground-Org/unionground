-- After a Postgres restart pg_net's request-id sequence can resume below
-- ids already stored in the tick ledgers. The three pg_cron jobs insert
-- net.http_post's bigint into a request_id primary key in the same statement,
-- so a collision rolls back the queued POST and the tick fails until the
-- sequence walks past every retained id (hours for the five-minute jobs,
-- months for the daily task-file job).
--
-- Make each insert idempotent. A colliding id refreshes created_at so the
-- health RPC still sees a fresh tick. Cadence, endpoints, and Vault secret
-- names stay the same. The health join also requires the pg_net response to
-- be created at or after that refreshed tick, so a reused request id cannot
-- report the previous request's status or error as the new dispatch.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $tick$
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
    on conflict (request_id) do update set created_at = excluded.created_at
    $job$);

  perform cron.unschedule(jobid) from cron.job where jobname = 'integration-webhooks-dispatch-tick';
  perform cron.schedule(
    'integration-webhooks-dispatch-tick',
    '*/5 * * * *',
    $job$
    insert into private.integration_webhook_dispatch_ticks (request_id)
    select net.http_post(
      url := controls.dispatch_url,
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || secret.decrypted_secret,
        'Content-Type', 'application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    )
    from private.integration_webhook_dispatch_controls controls
    cross join vault.decrypted_secrets secret
    where controls.id
      and controls.dispatch_url is not null
      and secret.name = 'integration-webhooks-dispatch-secret'
    limit 1
    on conflict (request_id) do update set created_at = excluded.created_at;
    delete from private.integration_webhook_dispatch_ticks
    where created_at < pg_catalog.now() - interval '7 days';
    $job$
  );

  perform cron.unschedule(jobid) from cron.job where jobname = 'task-files-reconcile-tick';
  perform cron.schedule(
    'task-files-reconcile-tick',
    '37 4 * * *',
    $job$
    insert into private.task_file_reconcile_ticks (request_id)
    select net.http_post(
      url := c.files_reconcile_url,
      headers := pg_catalog.jsonb_build_object(
        'Authorization', 'Bearer ' || s.decrypted_secret,
        'Content-Type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000)
    from private.notification_controls c
    cross join vault.decrypted_secrets s
    where c.id
      and c.files_reconcile_url is not null
      and s.name = 'notifications-dispatch-secret'
    limit 1
    on conflict (request_id) do update set created_at = excluded.created_at;
    delete from private.task_file_reconcile_ticks where created_at < now() - interval '14 days'
    $job$);
end
$tick$;

-- A reused request id can still have the prior net._http_response row. Join
-- that row only when it was created at or after the tick ledger's created_at
-- so get_notification_dispatch_health() cannot treat the old status/error as
-- a fresh dispatch. Webhook and task-file ticks have no sibling health RPC
-- that joins net._http_response.
create or replace function public.get_notification_dispatch_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $health$
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
    left join net._http_response r
      on r.id = t.request_id
     and r.created >= t.created_at
    where t.created_at > pg_catalog.now() - interval '1 hour';
  end if;

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
$health$;

revoke all on function public.get_notification_dispatch_health() from public, anon, authenticated;
grant execute on function public.get_notification_dispatch_health() to service_role;

notify pgrst, 'reload schema';

commit;
