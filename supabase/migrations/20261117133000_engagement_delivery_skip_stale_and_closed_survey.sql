-- BUG-UG-ENGAGEMENT-DELIVERY-SENDS-WEEKS-LATE-MAIL-ON-ACTIVATION-20261117 (#9050)
--
-- Engagement email has not been sent since Sep 29 because the provider
-- settings are not entered, and the outbox keeps ageing. When they are
-- entered, public.claim_engagement_delivery_batch (20260828034122, no age
-- cutoff, oldest first) would lease and send weeks-late welcomes and survey
-- reminders on the first run. A survey email whose survey has closed is
-- leased, refused by get_engagement_delivery_payload, and retried as failed
-- up to 20 times instead of ending.
--
-- Four restated functions, guarded by their reviewed source digests below.
-- The claim's predecessor is the 20260828034122 text inside the
-- lock_case_graph wrapper that the account lifecycle manifest installed
-- (20260907151000); the restatement keeps that wrapper unchanged.
--
-- 1. public.claim_engagement_delivery_batch(uuid, integer, integer): before it
--    picks candidates, every claimable row (queued, failed, or leased with an
--    expired lease, under 20 attempts) whose available_at is more than 336
--    hours (14 days) before now() ends as state 'suppressed' with
--    last_error_code 'skipped_stale', and a survey row's still-open
--    organization_survey_deliveries row follows it. The cutoff is a fixed
--    duration between UTC instants (make_interval(hours => 336)), never
--    calendar days in a session time zone. A row exactly 336 hours old is not
--    stale and is still claimed. The sweep takes its rows FOR UPDATE SKIP
--    LOCKED and only from claimable states, so overlapping claims never
--    suppress a row twice or touch a row another claim has leased; the
--    candidate pick also refuses a stale row, so a stale row is never leased
--    even when another transaction holds it during this sweep. Everything
--    else (validation, candidate states, attempt cap, order, lease, result
--    shape) is unchanged.
--
-- 2. public.complete_engagement_delivery(uuid, uuid, boolean, text, integer):
--    a survey delivery the dispatcher reports as payload_unavailable ends as
--    'suppressed' with last_error_code 'skipped_survey_closed' when the
--    database agrees the survey is no longer open or is past its close time.
--    Every other outcome is unchanged; a payload_unavailable for an open
--    survey, a broadcast or a welcome still fails and retries.
--
-- 3. public.queue_organization_survey_reminders(uuid): while the survey is
--    open, a reminder staff request also selects a member whose
--    organization_survey_deliveries row was suppressed for one of the two
--    skip reasons above (skipped_stale or skipped_survey_closed), so a stale
--    invitation, or a survey that closed and was reopened, can still be
--    reminded. Rows suppressed for any other reason (opted out, access
--    revoked) stay excluded. Everything else is unchanged.
--
-- 4. private.run_survey_operations_sweep(integer): the scheduled half of the
--    same rule. While the survey is open, marking deliveries reminder-due and
--    picking scheduled reminder recipients also accept a delivery suppressed
--    as skipped_stale or skipped_survey_closed. The open-survey, unanswered,
--    opt-out and one-reminder-per-member checks are unchanged.
--
-- Signatures, security mode, search_path and grants (kept by CREATE OR
-- REPLACE) are unchanged. No constraint changes: 'suppressed' is already a
-- terminal state of both tables.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
declare
  r record;
  source text;
  digest text;
begin
  for r in select * from (values
    ('public.claim_engagement_delivery_batch(uuid, integer, integer)', 'dbda0bc2dfe166fab01d7882061889f13359bd397138ba1657b99e3de160354a'),
    ('public.complete_engagement_delivery(uuid, uuid, boolean, text, integer)', '49ebd8906832c0b50d762e951c0740b00049a39b3b13a45083558299e6fe50e5'),
    ('public.queue_organization_survey_reminders(uuid)', '4d75cbe1b5b8d15a26870828efc3c51803dd956a261f531dc3779c7ff72da47e'),
    ('private.run_survey_operations_sweep(integer)', 'f3022705f7b2250092f6ee2cd11b3524358ed4608f837b0c77e187de829087d5')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc into strict source
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(r.signature);
    digest := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
      'hex'
    );
    if digest is distinct from r.source_sha256 then
      raise exception 'unreviewed % predecessor: %', r.signature, digest
        using errcode = '55000';
    end if;
  end loop;
end;
$predecessor$;

create or replace function public.claim_engagement_delivery_batch(
  p_lease_token uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  claimed jsonb;
  -- A fixed duration between instants: 14 days of 24 hours, independent of
  -- the session time zone and daylight saving time.
  stale_before timestamptz := pg_catalog.now() - pg_catalog.make_interval(hours => 336);
begin
  if p_lease_token is null
     or p_limit not between 1 and 100
     or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid delivery lease request' using errcode = '22023';
  end if;
  -- Mail more than 14 days past its due time is never sent: it ends here,
  -- before any lease, with its reason. Only claimable rows are taken, and
  -- rows another transaction holds are skipped, so overlapping claims are
  -- idempotent.
  with stale as (
    select outbox.id
    from public.engagement_delivery_outbox outbox
    where (
      outbox.state in ('queued', 'failed')
      or (outbox.state = 'leased' and outbox.lease_expires_at < pg_catalog.now())
    )
      and outbox.available_at < stale_before
      and outbox.attempt_count < 20
    for update skip locked
  ), skipped as (
    update public.engagement_delivery_outbox outbox
    set state = 'suppressed', last_error_code = 'skipped_stale',
        lease_token = null, lease_expires_at = null, updated_at = pg_catalog.now()
    from stale
    where outbox.id = stale.id
    returning case when outbox.source_kind = 'survey' then outbox.source_id end as survey_source_id,
      outbox.recipient_user_id
  )
  update public.organization_survey_deliveries delivery
  set state = 'suppressed', last_error_code = 'skipped_stale', updated_at = pg_catalog.now()
  from skipped
  where skipped.survey_source_id is not null
    and delivery.survey_id::text = skipped.survey_source_id
    and delivery.recipient_user_id = skipped.recipient_user_id
    and delivery.state in ('queued', 'leased', 'failed');
  with candidates as (
    select outbox.id
    from public.engagement_delivery_outbox outbox
    where (
      outbox.state in ('queued', 'failed')
      or (outbox.state = 'leased' and outbox.lease_expires_at < pg_catalog.now())
    )
      and outbox.available_at <= pg_catalog.now()
      and outbox.available_at >= stale_before
      and outbox.attempt_count < 20
    order by outbox.available_at, outbox.created_at, outbox.id
    for update skip locked
    limit p_limit
  ), leased as (
    update public.engagement_delivery_outbox outbox
    set state = 'leased', lease_token = p_lease_token,
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
        attempt_count = outbox.attempt_count + 1,
        updated_at = pg_catalog.now()
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', leased.id,
    'organizationId', leased.organization_id,
    'recipientUserId', leased.recipient_user_id,
    'deliveryKind', leased.delivery_kind,
    'sourceKind', leased.source_kind,
    'sourceId', leased.source_id,
    'locale', leased.locale,
    'attemptCount', leased.attempt_count
  ) order by leased.created_at, leased.id), '[]'::jsonb)
  into claimed from leased;
  return claimed;
end;
end;
$function$;

create or replace function public.complete_engagement_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_error_code text default null,
  p_retry_after_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  row public.engagement_delivery_outbox%rowtype;
  suppress boolean;
  survey_closed boolean;
  next_state text;
  claimed_code text;
begin
  if not p_success and pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, ''))) !~ '^[a-z0-9._:-]{1,80}$' then
    raise exception 'bounded error code required' using errcode = '22023';
  end if;
  if p_retry_after_seconds not between 60 and 86400 then
    raise exception 'invalid retry delay' using errcode = '22023';
  end if;
  select * into row from public.engagement_delivery_outbox outbox
  where outbox.id = p_delivery_id and outbox.state = 'leased' and outbox.lease_token = p_lease_token
  for update;
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  -- An opted-out or no-longer-eligible recipient is terminal, never a retry.
  -- The dispatcher's claim is believed only when the database agrees.
  claimed_code := pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, '')));
  -- A survey email the payload refused because the survey closed is terminal
  -- too, again only when the database agrees the survey is not open now.
  survey_closed := not p_success and claimed_code = 'payload_unavailable' and row.source_kind = 'survey'
    and not exists (
      select 1 from public.organization_surveys survey
      where survey.id::text = row.source_id and survey.organization_id = row.organization_id
        and survey.status = 'open'
        and (survey.closes_at is null or survey.closes_at > pg_catalog.now())
    );
  if survey_closed then claimed_code := 'skipped_survey_closed'; end if;
  suppress := survey_closed or (not p_success and (
    (claimed_code = 'recipient_opted_out'
      and private.engagement_email_opted_out(row.recipient_user_id, row.delivery_kind))
    or (claimed_code in ('recipient_opted_out', 'recipient_access_revoked')
      and not private.engagement_delivery_recipient_eligible(
        row.organization_id, row.recipient_user_id, row.source_kind, row.source_id))
  ));
  next_state := case when p_success then 'sent' when suppress then 'suppressed' else 'failed' end;
  update public.engagement_delivery_outbox outbox
  set state = next_state,
      sent_at = case when p_success then pg_catalog.now() else null end,
      last_error_code = case when p_success then null else claimed_code end,
      available_at = case when p_success or suppress then outbox.available_at else pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_after_seconds) end,
      lease_token = null, lease_expires_at = null, updated_at = pg_catalog.now()
  where outbox.id = row.id
  returning * into row;
  if row.source_kind = 'survey' then
    update public.organization_survey_deliveries
    set state = next_state,
        attempt_count = row.attempt_count,
        last_attempt_at = pg_catalog.now(),
        sent_at = case when p_success then coalesce(sent_at, pg_catalog.now()) else sent_at end,
        last_error_code = row.last_error_code,
        updated_at = pg_catalog.now()
    where survey_id = row.source_id::uuid and recipient_user_id = row.recipient_user_id;
  end if;
  return pg_catalog.jsonb_build_object('id', row.id, 'state', row.state);
end;
end;
$function$;

create or replace function public.queue_organization_survey_reminders(p_survey_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  queued integer;
begin
  perform private.engagement_require_staff(org);
  if not exists (
    select 1 from public.organization_surveys s
    where s.id = p_survey_id and s.organization_id = org and s.status = 'open'
      and (s.closes_at is null or s.closes_at > pg_catalog.now())
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  with candidates as (
    select d.recipient_user_id
    from public.organization_survey_deliveries d
    where d.organization_id = org
      and d.survey_id = p_survey_id
      and (
        d.state in ('queued', 'sent', 'failed')
        -- A delivery that only ended because its email was too late or its
        -- survey was closed at the time is remindable again while the
        -- survey is open (checked above).
        or (d.state = 'suppressed' and d.last_error_code in ('skipped_stale', 'skipped_survey_closed'))
      )
      and d.engaged_at is null
      and not private.engagement_email_opted_out(d.recipient_user_id, 'survey_reminder')
  ), inserted as (
    insert into public.engagement_delivery_outbox (
      organization_id, recipient_user_id, delivery_kind, source_kind, source_id
    )
    select org, candidates.recipient_user_id, 'survey_reminder', 'survey', p_survey_id::text
    from candidates
    on conflict (delivery_kind, source_id, recipient_user_id) do update
      set state = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.state
            else 'queued'
          end,
          available_at = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.available_at
            else pg_catalog.now()
          end,
          updated_at = pg_catalog.now()
      where public.engagement_delivery_outbox.state <> 'sent'
    returning recipient_user_id
  )
  select pg_catalog.count(*)::integer into queued from inserted;
  update public.organization_survey_deliveries
  set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
  where organization_id = org and survey_id = p_survey_id and engaged_at is null;
  perform private.mi1_w2_write_audit(org, 'survey_reminders_queued', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', p_survey_id,
    'userId', (select auth.uid()),
    'count', coalesce(queued, 0)
  ));
  return pg_catalog.jsonb_build_object('surveyId', p_survey_id, 'queued', coalesce(queued, 0));
end;
end;
$function$;

create or replace function private.run_survey_operations_sweep(p_limit integer DEFAULT 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := coalesce(p_limit, 100);
  survey public.organization_surveys%rowtype;
  attention jsonb;
  created integer := 0;
  marked integer := 0;
  escalated integer := 0;
  reminders integer := 0;
  step integer;
  actor uuid;
begin
  if cap not between 1 and 500 then
    raise exception 'invalid survey sweep limit' using errcode = '22023';
  end if;
  -- Switched-off organizations are excluded before LIMIT, and the durable
  -- per-survey cursor puts the least recently swept surveys first, so neither
  -- a disabled tenant nor the oldest 100 surveys can starve the rest.
  for survey in
    select candidate.*
    from public.organization_surveys candidate
    where (candidate.status = 'open'
       or (candidate.status = 'closed' and candidate.operations_state <> 'complete'))
      and private.organization_feature_enabled(candidate.organization_id, 'features.engagement_voice.survey_follow_up_automation')
    order by candidate.operations_swept_at nulls first, candidate.id
    for update skip locked
    limit cap
  loop
    update public.organization_surveys
    set operations_swept_at = pg_catalog.now()
    where id = survey.id;
    attention := private.survey_operations_state(survey.id);

    if (attention ->> 'reviewReady')::boolean then
      if private.open_survey_follow_up_task(survey, 'response_review', null) then created := created + 1; end if;
    end if;
    if (attention ->> 'closeoutDue')::boolean then
      if private.open_survey_follow_up_task(survey, 'closeout', null) then created := created + 1; end if;
    end if;
    if (attention #>> '{lowResponse,due}')::boolean then
      if private.open_survey_follow_up_task(survey, 'low_response', null) then created := created + 1; end if;
    end if;
    if attention #>> '{escalation,level}' in ('elevated', 'urgent') then
      if private.open_survey_follow_up_task(survey, 'coverage_escalation', pg_catalog.now()) then created := created + 1; end if;
    end if;

    -- A survey past its close time takes no answers, so it gets no more
    -- reminders either (REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030).
    if survey.status = 'open' and (survey.closes_at is null or survey.closes_at > pg_catalog.now()) then
      -- Reminder cadence: unanswered deliveries become reminder_due once the
      -- survey's reminder date passes, then escalated when a due reminder is
      -- still unanswered after the progress window.
      if (attention #>> '{reminder,due}')::boolean then
        update public.organization_survey_deliveries delivery
        set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
        where delivery.survey_id = survey.id and delivery.engaged_at is null
          and (
            delivery.state in ('queued', 'sent', 'failed')
            -- Ended only because its email was too late or its survey was
            -- closed at the time (20261117133000): still remindable.
            or (delivery.state = 'suppressed' and delivery.last_error_code in ('skipped_stale', 'skipped_survey_closed'))
          )
          and delivery.escalation_state = 'none';
        get diagnostics step = row_count;
        marked := marked + step;
      end if;
      update public.organization_survey_deliveries delivery
      set escalation_state = 'escalated', updated_at = pg_catalog.now()
      where delivery.survey_id = survey.id and delivery.engaged_at is null
        and delivery.escalation_state = 'reminder_due'
        and delivery.updated_at <= pg_catalog.now() - pg_catalog.make_interval(days => (attention ->> 'progressStaleDays')::integer);
      get diagnostics step = row_count;
      escalated := escalated + step;

      if private.organization_feature_enabled(survey.organization_id, 'features.engagement_voice.survey_scheduled_reminders') then
        with candidates as (
          select delivery.recipient_user_id
          from public.organization_survey_deliveries delivery
          where delivery.survey_id = survey.id and delivery.engaged_at is null
            and (
              delivery.state in ('queued', 'sent', 'failed')
              or (delivery.state = 'suppressed' and delivery.last_error_code in ('skipped_stale', 'skipped_survey_closed'))
            )
            and delivery.escalation_state in ('reminder_due', 'escalated')
            -- Same producer-side opt-out as the manual Remind button
            -- (20261002021000); the lease-time payload check stays the backstop.
            and not private.engagement_email_opted_out(delivery.recipient_user_id, 'survey_reminder')
            and not exists (
              select 1 from public.engagement_delivery_outbox outbox
              where outbox.delivery_kind = 'survey_reminder' and outbox.source_id = survey.id::text
                and outbox.recipient_user_id = delivery.recipient_user_id
            )
        ), inserted as (
          insert into public.engagement_delivery_outbox (
            organization_id, recipient_user_id, delivery_kind, source_kind, source_id
          )
          select survey.organization_id, candidates.recipient_user_id, 'survey_reminder', 'survey', survey.id::text
          from candidates
          on conflict (delivery_kind, source_id, recipient_user_id) do nothing
          returning recipient_user_id
        )
        select pg_catalog.count(*)::integer into step from inserted;
        if step > 0 then
          reminders := reminders + step;
          actor := coalesce(survey.owner_user_id, survey.created_by);
          if actor is not null then
            insert into public.organization_audit_events (
              organization_id, event_type, actor_user_id, idempotency_key, metadata
            ) values (
              survey.organization_id, 'survey_reminders_queued', actor, extensions.gen_random_uuid(),
              pg_catalog.jsonb_build_object(
                'organizationId', survey.organization_id, 'surveyId', survey.id,
                'userId', actor, 'count', step, 'reasonCode', 'scheduled'
              )
            );
          end if;
        end if;
      end if;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'tasksCreated', created, 'remindersDue', marked, 'escalated', escalated, 'remindersQueued', reminders
  );
end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
