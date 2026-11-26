-- SEC-UG-ANALYTICS-LAYOUT-CREATION-RETRY-BOUNDS-20260921: analytics layout
-- creation had no count bound, and expired idempotency receipts were purged
-- only on that same user's next write.
--
-- 1. public.save_organization_analytics_layout is re-emitted from its installed
--    definition (the 20260828230000 body wrapped with the case-graph entry lock
--    by 20260907151000; predecessor digest guarded, lock kept first). The only
--    change is in the create branch: under a per-organization advisory lock a
--    person may own at most 50 layouts per organization and an organization may
--    hold at most 500; past either bound the save is refused with 54000 and
--    writes nothing. Updates of an existing layout are not counted, and the
--    idempotent replay returns before the bound, so a retried save of a layout
--    that was already created still replays its receipt.
-- 2. private.purge_expired_analytics_idempotency_receipts() removes receipts
--    past the unchanged 30-day lifetime for every user, and the daily pg_cron
--    job mi1-analytics-receipt-retention runs it, so retention no longer waits
--    for a later write.
-- 3. The new job joins the job-health monitored set in all four copies:
--    organization_job_runs_job_name_check, the mirror's jobname allowlist in
--    private.sync_organization_job_runs_from_cron_history, the
--    public.list_organization_job_health catalog (both re-emitted from their
--    20260925000100 definitions, predecessor digests guarded, otherwise
--    unchanged) and PRODUCT_JOBS in src/features/operations/jobRegistry.js.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.save_organization_analytics_layout(uuid, text, text, text, jsonb, uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '87bf5f8c80aeb36f93c801b4e8c91e1b35acece762bf5b32f09e0d15d028cc8e' then
    raise exception 'unreviewed save_organization_analytics_layout predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'private.sync_organization_job_runs_from_cron_history()'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from 'fbb926bbd427148adc896ab0925ca818ec0fde9b5d88f5896bb0fbe5ea7667fb' then
    raise exception 'unreviewed sync_organization_job_runs_from_cron_history predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

do $predecessor$
declare
  source text;
  digest text;
begin
  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'public.list_organization_job_health()'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '4dfdb11c02cb1bb3f19dfa6d098eda9eaccf4e00b1ad1e4a7a18447651717304' then
    raise exception 'unreviewed list_organization_job_health predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function public.save_organization_analytics_layout(
  p_layout_id uuid,
  p_name text,
  p_scope text,
  p_chapter_id text,
  p_spec jsonb,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid := private.mi1_require_selected_organization();
  target_id uuid := coalesce(p_layout_id, extensions.gen_random_uuid());
  request_hash text;
  prior private.organization_analytics_idempotency_receipts%rowtype;
  existing public.organization_analytics_layouts%rowtype;
  result jsonb;
  action_name text := 'created';
  owner_layout_limit constant integer := 50;
  organization_layout_limit constant integer := 500;
begin
  if caller is null or org is null or p_idempotency_key is null then
    raise exception 'authentication, organization, and idempotency key required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_scope not in ('personal', 'chapter', 'organization')
    or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 1 and 80
    or coalesce(p_name, '') ~ '[[:cntrl:]]'
    or not private.analytics_layout_spec_valid(p_spec)
    or (p_scope = 'chapter') is distinct from (p_chapter_id is not null)
  then
    raise exception 'invalid analytics layout' using errcode = '22023';
  end if;
  if p_scope = 'chapter' and not exists (
    select 1 from public.chapters c where c.id = p_chapter_id and c.organization_id = org
  ) then
    raise exception 'chapter is outside selected organization' using errcode = '42501';
  end if;
  if p_scope = 'organization'
    and not private.has_organization_role(org, array['coordinator', 'admin', 'vp'])
  then
    raise exception 'organization sharing requires leadership role' using errcode = '42501';
  end if;
  if (p_spec ->> 'datasetId') = 'organization:chapter-health' then
    null;
  elsif (p_spec ->> 'datasetId') ~ '^chapter:[A-Za-z0-9_-]{1,40}:health-trend$' then
    if not exists (
      select 1
      from public.chapters c
      where c.id = pg_catalog.split_part(p_spec ->> 'datasetId', ':', 2)
        and c.organization_id = org
        and (
          select pg_catalog.count(*)
          from public.member_chapter_memberships m
          join public.organization_memberships om
            on om.organization_id = org
           and om.user_id = m.user_id
           and om.status = 'active'
          where m.chapter_id = c.id and m.status = 'active'
        ) >= 25
    ) then
      raise exception 'analytics dataset is unavailable' using errcode = '22023';
    end if;
  else
    raise exception 'analytics dataset is unavailable' using errcode = '22023';
  end if;
  if p_scope = 'chapter'
    and (p_spec ->> 'datasetId') like 'chapter:%'
    and pg_catalog.split_part(p_spec ->> 'datasetId', ':', 2) is distinct from p_chapter_id
  then
    raise exception 'chapter layout dataset does not match chapter' using errcode = '22023';
  end if;

  request_hash := pg_catalog.encode(extensions.digest(pg_catalog.jsonb_build_object(
    'layoutId', p_layout_id, 'name', pg_catalog.btrim(p_name), 'scope', p_scope,
    'chapterId', p_chapter_id, 'spec', p_spec
  )::text, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text || p_idempotency_key::text, 0));
  delete from private.organization_analytics_idempotency_receipts r
  where r.user_id = caller
    and r.created_at < pg_catalog.now() - interval '30 days';
  select * into prior from private.organization_analytics_idempotency_receipts r
  where r.user_id = caller and r.idempotency_key = p_idempotency_key;
  if found then
    if prior.operation is distinct from 'save_layout' or prior.request_hash is distinct from request_hash then
      raise exception 'idempotency key reused with different request' using errcode = '22023';
    end if;
    return prior.response;
  end if;

  if p_layout_id is not null then
    select * into existing from public.organization_analytics_layouts l where l.id = p_layout_id for update;
    if found then
      if existing.organization_id is distinct from org
        or (existing.owner_user_id is distinct from caller
          and not private.has_organization_role(org, array['admin']))
      then
        raise exception 'not authorized' using errcode = '42501';
      end if;
      action_name := 'updated';
    end if;
  end if;

  if action_name = 'updated' then
    update public.organization_analytics_layouts l set
      scope = p_scope,
      chapter_id = p_chapter_id,
      name = pg_catalog.btrim(p_name),
      spec = p_spec,
      updated_at = pg_catalog.now()
    where l.id = target_id
      and l.organization_id = org;
  else
    -- Creation bounds: serialize creates per organization so concurrent saves
    -- cannot overshoot, then refuse once either documented limit is met. The
    -- idempotent replay above returns first, so a retried save of a layout
    -- that was already created is never refused.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('organization_analytics_layouts:' || org::text, 0)
    );
    if (
      select pg_catalog.count(*) from public.organization_analytics_layouts l
      where l.organization_id = org and l.owner_user_id = caller
    ) >= owner_layout_limit then
      raise exception 'analytics layout limit reached: 50 per person per organization' using errcode = '54000';
    end if;
    if (
      select pg_catalog.count(*) from public.organization_analytics_layouts l
      where l.organization_id = org
    ) >= organization_layout_limit then
      raise exception 'analytics layout limit reached: 500 per organization' using errcode = '54000';
    end if;
    insert into public.organization_analytics_layouts (
      id, organization_id, owner_user_id, scope, chapter_id, name, spec
    ) values (
      target_id, org, caller, p_scope, p_chapter_id, pg_catalog.btrim(p_name), p_spec
    );
  end if;

  insert into public.organization_analytics_layout_events (
    organization_id, layout_id, actor_user_id, action, scope, chapter_id
  ) values (org, target_id, caller, action_name, p_scope, p_chapter_id);

  result := pg_catalog.jsonb_build_object(
    'id', target_id,
    'organizationId', org,
    'name', pg_catalog.btrim(p_name),
    'scope', p_scope,
    'chapterId', p_chapter_id,
    'spec', p_spec,
    'canEdit', true
  );
  insert into private.organization_analytics_idempotency_receipts (
    user_id, idempotency_key, operation, request_hash, response
  ) values (caller, p_idempotency_key, 'save_layout', request_hash, result);
  return result;
end;
end;
$function$;

revoke all on function public.save_organization_analytics_layout(uuid, text, text, text, jsonb, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.save_organization_analytics_layout(uuid, text, text, text, jsonb, uuid)
  to authenticated;

create or replace function private.purge_expired_analytics_idempotency_receipts()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  removed integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  delete from private.organization_analytics_idempotency_receipts r
  where r.created_at < pg_catalog.now() - interval '30 days';
  get diagnostics removed = row_count;
  return removed;
end;
$function$;

revoke all on function private.purge_expired_analytics_idempotency_receipts()
  from public, anon, authenticated, service_role;

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
    'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
    'deadline-notices-tick',
    'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention',
    'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
    'notifications-expiry-sweep', 'organization-automation-tick',
    'task-files-reconcile-tick', 'task-maintenance-daily',
    'union-ground-organization-retention', 'weekly-question-selection-tick',
    'workload-reminders-tick'
  ));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  with candidate as (
    select j.jobname as job_name,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in (
      'appointment-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ) and (d.start_time >= window_start or d.runid = any(open_runs))
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, c.job_name, c.run_id, c.status, c.started_at, c.finished_at,
    c.failure_code, c.redacted_summary
  from candidate c
  left join public.organization_job_runs mirrored
    on mirrored.job_name = c.job_name
   and mirrored.run_id = c.run_id
   and mirrored.organization_id is null
  where mirrored.id is null
     or mirrored.status is distinct from c.status
     or mirrored.finished_at is distinct from c.finished_at
     or mirrored.failure_code is distinct from c.failure_code
     or mirrored.redacted_summary is distinct from c.redacted_summary
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array[
      'account-deletion-reconcile-tick', 'appointment-reminders-tick',
      'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
      'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep', 'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ]) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mi1-analytics-receipt-retention';
    perform cron.schedule(
      'mi1-analytics-receipt-retention',
      '23 4 * * *',
      $job$ select private.purge_expired_analytics_idempotency_receipts(); $job$
    );
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
