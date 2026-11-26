-- BUG-UG-NOTIFICATION-EMAIL-SKIPPED-WHEN-FIRST-SWEEP-COMES-AFTER-48-HOURS-20261115 (#8781).
--
-- public.expire_notification_deliveries (20261112215500, #8488) ran its
-- 48-hour branch first: every pending or stale sending delivery older than 48
-- hours became 'skipped' ('expired before dispatch'). The branch that marks an
-- email still failing from a mail provider outage as 'failed' with
-- 'mail provider unavailable for 23 hours; replay needed: <error>' ran after
-- it. When no sweep ran between 23 and 48 hours, the outage email was skipped
-- and the operator's replay list, which looks for the replay needed mark,
-- never found it.
--
-- Now the 48-hour branch leaves an email whose last error is a mail provider
-- outage (the same pattern record_notification_delivery_results and the
-- replay branch use) to the replay branch, which takes it past 48 hours even
-- below six attempts (a deferral keeps the outage as the recorded cause
-- without counting an attempt). A delivery older than 48 hours that never
-- failed is still skipped, and nothing changes under 48 hours. The body is
-- the live definition from 20261112215500 with only these two edits; grants
-- are unchanged by CREATE OR REPLACE.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

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
      -- #8781: an email still failing from a mail outage is marked for replay
      -- below, however late the first sweep after 23 hours comes.
      and not (d.channel = 'email' and coalesce(d.last_error, '') ~ '^resend (http (5[0-9]{2}|429)|timeout|network|error)$')
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
    where (d.attempts >= 6
        or (d.created_at < pg_catalog.now() - interval '48 hours'
          and d.channel = 'email' and coalesce(d.last_error, '') ~ '^resend (http (5[0-9]{2}|429)|timeout|network|error)$'))
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
