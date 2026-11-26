-- OPS-UG-SCHEDULED-JOB-FAILURES-RAISE-NO-OPERATOR-ALERT-20261115 (#8881)
--
-- A failing scheduled background job told no operator: a failed run, or a job
-- that stopped running, showed only on the admin Job health page or in the
-- database, and since #8860 an organization admin's list also hides the jobs
-- of held features. api/scheduled-job-alerts.js (a Vercel cron tick every five
-- minutes) now asks this database which monitored jobs need an operator alert
-- and posts it to the private ug-alerts channel.
--
-- What changes here, and nothing else:
--   * private.scheduled_job_alert_state: per monitored job, when the monitor
--     first watched it, its last alert, the run start it last called overdue,
--     whether an alert is open (no completed run since), and the claim that
--     last changed it with the state before that claim, when it was made and
--     whether its delivery is still unconfirmed.
--   * private.scheduled_job_alert_reported: the failed runs already counted in
--     an alert, by run row id, kept for two days.
--   * public.claim_scheduled_job_alerts(p_stale_after_seconds),
--     public.confirm_scheduled_job_alert(p_claim_id) and
--     public.release_scheduled_job_alert(p_claim_id), service_role only, and
--     private.undo_scheduled_job_alert_claim(p_claim_id), which no role may
--     execute.
-- The monitored set is the 40 names of public.list_organization_job_health,
-- held features' jobs included. That function, public.organization_job_runs,
-- the job catalogue, every schedule and every admin-visible object are
-- unchanged: the claim only reads runs, and no organization ever sees these
-- tables or functions.
--
-- The claim, serialized by one transaction advisory lock, decides per job:
--   failed     unreported failed runs (started in the last day, and no earlier
--              than 30 minutes before the monitor first watched the job), when
--              the job has had no alert for 30 minutes; they become reported.
--   overdue    the newest run started longer ago than the caller's threshold
--              for the job, once per stalled run start, under the same 30
--              minute limit. A job with no recorded run is never overdue.
--   recovered  an open alert whose job's newest run finished, completed, after
--              it (by finish time, so a run already in progress when the alert
--              was raised can close it), with no unreported failure: one
--              notice, and the alert closes.
-- It returns metadata only: job name, kind, a failure count and run start
-- times. Never an organization, a failure code, a summary or any row content.
-- Failures are counted by run row id, not by a time cursor, because a run is
-- recorded as in_progress and becomes failed later, and the cron mirror
-- records runs after they start.
--
-- Every claim is pending until the caller confirms its delivery. The caller
-- claims before it posts, confirms a delivered post, and releases the claim
-- of a post that was refused or never sent: the job's state and its reported
-- runs return to what they were, so the next tick tries again. A claim that
-- is neither confirmed nor released within 30 minutes (its post timed out, so
-- delivery is unknown, or the tick ended first) is undone by the next claim
-- after that, so the same failure or stall is offered again then, and not
-- before: no delivery outcome can silence a job for good. While a job's claim
-- is pending it is offered nothing new. None of these functions ever touches
-- a job, its schedule or its runs.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.scheduled_job_alert_state (
  job_name text primary key,
  watched_since timestamptz not null,
  alerted_at timestamptz,
  alert_kind text check (alert_kind in ('failed', 'overdue')),
  overdue_for timestamptz,
  open boolean not null default false,
  claim_id uuid,
  claim_previous jsonb,
  claimed_at timestamptz,
  claim_pending boolean not null default false
);

create table private.scheduled_job_alert_reported (
  run_row_id uuid primary key,
  job_name text not null,
  started_at timestamptz not null,
  claim_id uuid not null
);
create index scheduled_job_alert_reported_claim_idx
  on private.scheduled_job_alert_reported (claim_id);

alter table private.scheduled_job_alert_state enable row level security;
alter table private.scheduled_job_alert_reported enable row level security;
revoke all on table private.scheduled_job_alert_state from public, anon, authenticated, service_role;
revoke all on table private.scheduled_job_alert_reported from public, anon, authenticated, service_role;

-- Restores the state a claim replaced and forgets the runs it reported.
-- Called only by the definer functions below, under their advisory lock.
create function private.undo_scheduled_job_alert_claim(p_claim_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $function$
declare
  v_state private.scheduled_job_alert_state;
  v_previous private.scheduled_job_alert_state;
begin
  select * into v_state from private.scheduled_job_alert_state s
  where s.claim_id = p_claim_id for update;
  if not found then
    return false;
  end if;
  v_previous := pg_catalog.jsonb_populate_record(null::private.scheduled_job_alert_state, v_state.claim_previous);
  update private.scheduled_job_alert_state s set
    watched_since = v_previous.watched_since,
    alerted_at = v_previous.alerted_at,
    alert_kind = v_previous.alert_kind,
    overdue_for = v_previous.overdue_for,
    open = v_previous.open,
    claim_id = null,
    claim_previous = null,
    claimed_at = null,
    claim_pending = false
  where s.job_name = v_state.job_name;
  delete from private.scheduled_job_alert_reported p where p.claim_id = p_claim_id;
  return true;
end;
$function$;

create function public.claim_scheduled_job_alerts(p_stale_after_seconds jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_jobs text[];
  v_now timestamptz;
  v_job text;
  v_state private.scheduled_job_alert_state;
  v_latest public.organization_job_runs;
  v_stale integer;
  v_window_open boolean;
  v_claim uuid;
  v_kind text;
  v_failures integer;
  v_first timestamptz;
  v_last timestamptz;
  v_alerts jsonb;
  v_expired uuid;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  v_jobs := array['account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'learning-period-end-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mi1-job-health-sync', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick'];
  -- Separate checks and a CASE, because SQL does not promise to evaluate OR
  -- left to right: jsonb_each and the numeric cast see only what they accept.
  if p_stale_after_seconds is null or pg_catalog.jsonb_typeof(p_stale_after_seconds) <> 'object' then
    raise exception 'invalid scheduled job alert thresholds' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_each(p_stale_after_seconds) e
    where not (e.key = any (v_jobs))
      or case when pg_catalog.jsonb_typeof(e.value) = 'number' then
           (e.value)::numeric <> pg_catalog.trunc((e.value)::numeric)
           or (e.value)::numeric < 60
           or (e.value)::numeric > 1209600
         else true end
  ) then
    raise exception 'invalid scheduled job alert thresholds' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-job-alerts', 0));
  v_now := pg_catalog.now();
  v_alerts := '[]'::jsonb;

  insert into private.scheduled_job_alert_state (job_name, watched_since)
  select j.job_name, v_now - interval '30 minutes'
  from pg_catalog.unnest(v_jobs) as j(job_name)
  on conflict (job_name) do nothing;

  delete from private.scheduled_job_alert_reported
  where started_at < v_now - interval '2 days';

  -- A claim still unconfirmed after 30 minutes was never known to arrive:
  -- undo it, so the same failure or stall is offered again below.
  for v_expired in
    select s.claim_id from private.scheduled_job_alert_state s
    where s.claim_pending and s.claimed_at <= v_now - interval '30 minutes'
  loop
    perform private.undo_scheduled_job_alert_claim(v_expired);
  end loop;

  foreach v_job in array v_jobs loop
    select * into v_state from private.scheduled_job_alert_state s
    where s.job_name = v_job for update;
    -- A pending claim younger than 30 minutes holds the job until it is
    -- confirmed, released or undone.
    continue when v_state.claim_pending;
    v_latest := null;
    select * into v_latest from public.organization_job_runs r
    where r.job_name = v_job
    order by r.started_at desc limit 1;
    v_stale := (p_stale_after_seconds ->> v_job)::integer;
    v_window_open := v_state.alerted_at is null or v_now - v_state.alerted_at >= interval '30 minutes';
    v_claim := extensions.gen_random_uuid();
    v_kind := null;
    v_failures := 0;
    v_first := null;
    v_last := null;

    if v_window_open then
      with fresh as (
        insert into private.scheduled_job_alert_reported (run_row_id, job_name, started_at, claim_id)
        select r.id, r.job_name, r.started_at, v_claim
        from public.organization_job_runs r
        where r.job_name = v_job
          and r.status = 'failed'
          and r.started_at > greatest(v_state.watched_since, v_now - interval '1 day')
          and not exists (
            select 1 from private.scheduled_job_alert_reported p where p.run_row_id = r.id
          )
        returning started_at
      )
      select pg_catalog.count(*)::integer, pg_catalog.min(fresh.started_at), pg_catalog.max(fresh.started_at)
        into v_failures, v_first, v_last
      from fresh;
    end if;

    if v_failures > 0 then
      v_kind := 'failed';
    elsif v_window_open
        and v_stale is not null
        and v_latest.id is not null
        and v_now - v_latest.started_at > pg_catalog.make_interval(secs => v_stale)
        and v_state.overdue_for is distinct from v_latest.started_at then
      v_kind := 'overdue';
    elsif v_state.open
        and v_latest.status = 'completed'
        and coalesce(v_latest.finished_at, v_latest.started_at) > v_state.alerted_at
        and not exists (
          select 1 from public.organization_job_runs r
          where r.job_name = v_job
            and r.status = 'failed'
            and r.started_at > greatest(v_state.watched_since, v_now - interval '1 day')
            and not exists (
              select 1 from private.scheduled_job_alert_reported p where p.run_row_id = r.id
            )
        ) then
      v_kind := 'recovered';
    end if;

    if v_kind is not null then
      update private.scheduled_job_alert_state s set
        claim_id = v_claim,
        claim_previous = pg_catalog.to_jsonb(v_state) - 'claim_id' - 'claim_previous' - 'claimed_at' - 'claim_pending',
        claimed_at = v_now,
        claim_pending = true,
        alerted_at = case when v_kind = 'recovered' then s.alerted_at else v_now end,
        alert_kind = case when v_kind = 'recovered' then s.alert_kind else v_kind end,
        overdue_for = case when v_kind = 'overdue' then v_latest.started_at else s.overdue_for end,
        open = v_kind <> 'recovered'
      where s.job_name = v_job;
      v_alerts := v_alerts || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'claimId', v_claim,
        'jobName', v_job,
        'kind', v_kind,
        'failures', v_failures,
        'firstFailureAt', v_first,
        'lastFailureAt', v_last,
        'lastStartedAt', v_latest.started_at
      ));
    end if;
  end loop;

  return v_alerts;
end;
$function$;

create function public.confirm_scheduled_job_alert(p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_id is null then
    raise exception 'invalid scheduled job alert claim' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-job-alerts', 0));
  update private.scheduled_job_alert_state s set
    claim_id = null,
    claim_previous = null,
    claimed_at = null,
    claim_pending = false
  where s.claim_id = p_claim_id and s.claim_pending;
  return found;
end;
$function$;

create function public.release_scheduled_job_alert(p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_id is null then
    raise exception 'invalid scheduled job alert claim' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-job-alerts', 0));
  return private.undo_scheduled_job_alert_claim(p_claim_id);
end;
$function$;

revoke all on function public.claim_scheduled_job_alerts(jsonb) from public, anon, authenticated;
revoke all on function public.confirm_scheduled_job_alert(uuid) from public, anon, authenticated;
revoke all on function public.release_scheduled_job_alert(uuid) from public, anon, authenticated;
revoke all on function private.undo_scheduled_job_alert_claim(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_scheduled_job_alerts(jsonb) to service_role;
grant execute on function public.confirm_scheduled_job_alert(uuid) to service_role;
grant execute on function public.release_scheduled_job_alert(uuid) to service_role;

commit;
