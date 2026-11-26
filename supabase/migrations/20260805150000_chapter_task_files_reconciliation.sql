-- REQ-UNION-BASE-TASK-FILES-RECONCILIATION-20260805
--
-- The device-file feature (20260805051500) shipped with a recorded deferral:
-- registration rows and stored objects can drift apart — a crash between
-- register and upload strands a row with no bytes, a direct Storage API
-- deletion strands a row whose object is gone, and the 90-day task hard purge
-- cascades the rows away while the objects (and their bytes) stay behind.
-- SQL alone cannot finish the job because deleting a storage.objects row
-- removes only the catalog entry: the bytes in the backing store are keyed by
-- the row's version and become unreachable garbage the moment the row is gone.
-- Only the Storage API deletes both.
--
-- Two changes close the loop:
--
-- 1. remove_chapter_task_file stops deleting storage.objects in SQL. The
--    sanctioned client flow already deletes the object FIRST through the
--    Storage API (which removes the bytes), so the SQL delete was a no-op
--    there — but a caller invoking the RPC directly would delete the catalog
--    row and strand the bytes invisibly, beyond the reach of any sweep.
--    Leaving the object row behind instead turns that case into a VISIBLE
--    orphan; the storage read/write policies already stop resolving the
--    moment the registration row is gone, so nothing can reach the object in
--    the meantime.
--
-- 2. A service-role reconciliation RPC plus a daily pg_cron tick POSTing to
--    /api/task-files-reconcile, in the exact inert-until-configured shape of
--    the notification dispatch tick (20260723204000): endpoint URL in
--    private.notification_controls, bearer from Vault, and while either is
--    absent the job sends nothing at all. The endpoint deletes the orphans
--    the RPC reports through the Storage API, so the bytes actually leave.
--    It runs at 04:37 UTC — twenty minutes after task-maintenance-daily —
--    so objects the purge cascade just orphaned are swept the same morning.

-- A. remove_chapter_task_file no longer touches storage.objects -------------

create or replace function public.remove_chapter_task_file(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  file_row public.chapter_task_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select f.* into file_row
  from public.chapter_task_files f
  join public.member_profiles p on p.id = caller and p.chapter_id = f.chapter_id
  where f.id = p_file_id
  for update of f;
  if file_row.id is null then
    raise exception 'file unavailable' using errcode = '22023';
  end if;

  -- Deliberately NOT deleting from storage.objects here. The client removes
  -- the object through the Storage API before calling this (that is what
  -- deletes the bytes); if any caller skips that step, the object row it
  -- leaves behind is unreachable (both storage policies resolve through this
  -- registration row) and the daily reconciliation deletes it through the
  -- API. A SQL delete would instead strand the bytes invisibly forever.
  delete from public.chapter_task_files where id = file_row.id;

  insert into public.chapter_task_activity (
    task_id, chapter_id, actor_id, action, from_value
  ) values (
    file_row.task_id, file_row.chapter_id, caller, 'file_removed', file_row.filename
  );

  return pg_catalog.jsonb_build_object('deleted', true, 'id', file_row.id);
end
$$;

-- B. Reconciliation RPC ------------------------------------------------------

-- The SQL-visible half of the sweep, service-role only: remove registration
-- rows whose object never arrived (or was deleted out from under them), and
-- report orphaned objects for the caller to delete through the Storage API.
-- This function must never delete storage.objects rows itself — see the
-- header comment for why that strands bytes.
create or replace function public.reconcile_chapter_task_files(
  p_max_orphan_objects integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  visible_objects bigint;
  stale_candidates bigint;
  removed_rows integer := 0;
  blind boolean := false;
  orphan_total bigint;
  orphans jsonb;
  orphan_cap integer := least(greatest(coalesce(p_max_orphan_objects, 0), 0), 500);
begin
  -- Registration rows count as stale only after a generous grace: an upload
  -- follows its registration within seconds, so 24 hours cleanly separates
  -- "the upload never came" from anything in flight.
  select count(*) into stale_candidates
  from public.chapter_task_files f
  where f.created_at < now() - interval '24 hours'
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = f.bucket_id and o.name = f.object_name
    );

  select count(*) into visible_objects
  from storage.objects o
  where o.bucket_id = 'chapter-task-files';

  if stale_candidates > 0 and visible_objects = 0 then
    -- Fail closed. An empty-looking bucket alongside surviving registrations
    -- is indistinguishable from a grant/RLS regression that has made
    -- storage.objects invisible to this definer — and deleting on blind
    -- sight would drop EVERY registration row in one pass. Refuse, report,
    -- and let the non-2xx tick response surface it.
    blind := true;
  elsif stale_candidates > 0 then
    delete from public.chapter_task_files f
    where f.created_at < now() - interval '24 hours'
      and not exists (
        select 1 from storage.objects o
        where o.bucket_id = f.bucket_id and o.name = f.object_name
      );
    get diagnostics removed_rows = row_count;
  end if;

  -- Orphaned objects: uploads outlive their registration only through the
  -- purge cascade, a direct row deletion, or an RPC-only removal. The path
  -- embeds a per-registration uuid, so an orphan can never become referenced
  -- again — once seen past the one-hour settle grace it is terminal garbage.
  select count(*) into orphan_total
  from storage.objects o
  where o.bucket_id = 'chapter-task-files'
    and o.created_at < now() - interval '1 hour'
    and not exists (
      select 1 from public.chapter_task_files f
      where f.bucket_id = o.bucket_id and f.object_name = o.name
    );

  select coalesce(pg_catalog.jsonb_agg(x.name), '[]'::jsonb) into orphans
  from (
    select o.name
    from storage.objects o
    where o.bucket_id = 'chapter-task-files'
      and o.created_at < now() - interval '1 hour'
      and not exists (
        select 1 from public.chapter_task_files f
        where f.bucket_id = o.bucket_id and f.object_name = o.name
      )
    order by o.created_at, o.name
    limit orphan_cap
  ) x;

  return pg_catalog.jsonb_build_object(
    'staleRowsRemoved', removed_rows,
    'staleRowsSkippedBlind', case when blind then stale_candidates else 0 end,
    'orphanObjects', orphans,
    'orphanTotal', orphan_total,
    'ranAt', now()
  );
end
$$;

revoke all on function public.reconcile_chapter_task_files(integer) from public, anon, authenticated;
grant execute on function public.reconcile_chapter_task_files(integer) to service_role;

comment on function public.reconcile_chapter_task_files(integer) is
  'Daily drift repair for device-file attachments: deletes registration rows whose object never arrived (24h grace, fail-closed if the bucket looks blind) and reports orphaned objects for /api/task-files-reconcile to delete through the Storage API.';

-- C. Tick plumbing -----------------------------------------------------------

alter table private.notification_controls
  add column if not exists files_reconcile_url text
  check (files_reconcile_url is null or files_reconcile_url ~ '^https://[[:graph:]]+$');

comment on column private.notification_controls.files_reconcile_url is
  'Endpoint for the daily task-file reconciliation tick. NULL keeps the job inert — same deliberate-pointing rule as dispatch_url.';

-- Same reasoning as notification_dispatch_ticks: pg_net is fire-and-forget,
-- so without the request ids a tick that 401s daily is indistinguishable from
-- one that works.
create table if not exists private.task_file_reconcile_ticks (
  request_id bigint primary key,
  created_at timestamptz not null default now()
);

revoke all on private.task_file_reconcile_ticks from public, anon, authenticated, service_role;

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
    limit 1;
    delete from private.task_file_reconcile_ticks where created_at < now() - interval '14 days'
    $job$);
end
$$;

notify pgrst, 'reload schema';
