-- Union Ground adaptation: the tick change below is kept (it names no host
-- and sends nothing while files_reconcile_url is NULL). The new setup RPC,
-- configure_task_files_reconcile, keeps its signature and service-role grant
-- but refuses with a named error, and configure_notification_dispatch is not
-- re-emitted, as 20261015120000 decided for every fixed outside endpoint.
--
-- BUG-UG-REMOVED-ATTACHMENTS-NEVER-CLEANED-SERVER-SIDE-20261018
--
-- The two-phase removal RPCs (20260905005500) hide a removed case or task
-- attachment immediately and leave the byte delete to the service-only
-- reconciler: reconcile_chapter_task_files reports the exact Storage target
-- 15 minutes after the request, /api/task-files-reconcile deletes it through
-- the Storage API, and the zero-page second pass retires the row with its
-- caller receipt. Production reaches that endpoint daily (pg_cron plus the
-- Vercel backstop). SAMPLE never does:
--
--   * the Vercel cron is production work by construction
--     (resolveSupabaseBackend routes every authenticated cron tick to the
--     production backend), and
--   * the SAMPLE pg_cron tick stays inert, because it reads its bearer from
--     notifications-dispatch-secret. On SAMPLE that Vault entry is the
--     dedicated push-dispatch bearer, so configure_notification_dispatch
--     (20261009220000) requires files_reconcile_url to stay NULL.
--
-- Removal-requested and cleanup-requested rows on SAMPLE therefore keep their
-- bytes indefinitely (window C, October 18). This migration gives the tick its
-- own Vault bearer and one reviewed, environment-agnostic operation that
-- points it at the same /api/task-files-reconcile route on any database: the
-- database's installation identity, not the caller, selects the portal. The
-- endpoint authenticates that bearer per backend (CRON_SECRET for the SaaS
-- portal, SAMPLE_TASK_FILES_RECONCILE_SECRET for the demo portal).
--
-- Existing behavior is unchanged until an operator runs the RPC. Without a
-- task-files-reconcile-secret the tick falls back to the Vault name it reads
-- today. This migration creates no secret and sets no URL.

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

  -- Cadence, destination column, ledger and ON CONFLICT are unchanged from
  -- 20260915180000. Only the bearer lookup changes: the dedicated name wins
  -- when it exists.
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
    cross join lateral (
      select v.decrypted_secret
      from vault.decrypted_secrets v
      where v.name in ('task-files-reconcile-secret', 'notifications-dispatch-secret')
      order by (v.name = 'task-files-reconcile-secret') desc
      limit 1
    ) s
    where c.id
      and c.files_reconcile_url is not null
    limit 1
    on conflict (request_id) do update set created_at = excluded.created_at;
    delete from private.task_file_reconcile_ticks where created_at < now() - interval '14 days'
    $job$);
end
$tick$;

create function public.configure_task_files_reconcile(p_reconcile_url text, p_reconcile_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform p_reconcile_url, p_reconcile_secret;
  raise exception 'task-files reconcile has no Union Ground endpoint to configure'
    using errcode = '55000';
end;
$function$;

revoke all on function public.configure_task_files_reconcile(text, text) from public, anon, authenticated, service_role;
grant execute on function public.configure_task_files_reconcile(text, text) to service_role;

comment on function public.configure_task_files_reconcile(text, text) is
  'Service-role-only setup for the daily task-files reconcile tick. Union Ground installs no outside endpoint (20261015120000), so this refuses with a named error before any Vault or control-row write; a deployment points the tick at its own dispatcher.';

-- Union Ground does not re-emit public.configure_notification_dispatch here:
-- the refusal of 20261015120000 stays its last definition, so no
-- migration-installed path may wire this database to a host of a deployment
-- it does not own. The grants below restate the existing service-role ACL.

revoke all on function public.configure_notification_dispatch(text, text) from public, anon, authenticated, service_role;
grant execute on function public.configure_notification_dispatch(text, text) to service_role;

notify pgrst, 'reload schema';

commit;
