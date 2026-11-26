-- BUG-UG-AI-RETENTION-CASCADE-BATCH-COUNT-20261010
--
-- Append-only replacement of private.perform_organization_retention_run. Only
-- the `ai_assistant_conversations` branch of the data-class dispatch changes;
-- every other branch, and the authorization, policy, cutoff, tenant, locking,
-- audit-ledger and failure handling around the dispatch, is 20261003050000's
-- text unchanged. 20261003050000 must not be rewritten: stage 22 applied it.
--
-- Before: the branch deleted up to 5,000 expired messages, then up to 5,000
-- expired threads "with no recent messages". A thread in the second batch
-- could still hold expired messages the first batch had not reached, and
-- public.member_guide_messages.thread_id (20260721000709) cascades, so those
-- rows were deleted without entering `removed`. One execution could therefore
-- destroy more than 5,000 rows and report fewer than it destroyed.
--
-- After: the two statements share one 5,000-row budget, and a thread is
-- deleted only when no message points at it. deleted_count is then the exact
-- number of rows the execution deleted, and private.retention_eligible_count's
-- existing arm for this class -- expired messages plus expired threads with no
-- message newer than the cutoff -- stays an exact remaining_count across the
-- continuation, because a thread that is not yet empty is still eligible.

begin;

-- Based on 20260925630500; preserve its locking and legal-hold behavior.
-- New classes and message candidates use immutable creation-time tenant scope.
create or replace function private.perform_organization_retention_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  run_row public.organization_retention_runs%rowtype;
  policy_row public.organization_retention_policies%rowtype;
  removed integer := 0;
  remaining integer := 0;
  extra integer := 0;
  candidate_id uuid;
begin
  perform private.lock_message_lifecycle();
  select r.* into run_row
  from public.organization_retention_runs r
  where r.id = p_run_id
  for update;
  if run_row.id is null or run_row.status <> 'authorized' then
    raise exception 'authorized retention run required' using errcode = '22023';
  end if;
  if run_row.authorization_expires_at <= pg_catalog.now() then
    update public.organization_retention_runs
      set status = 'expired', completed_at = pg_catalog.now(),
          failure_code = 'authorization_expired'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'expired');
  end if;

  select p.* into policy_row
  from public.organization_retention_policies p
  where p.organization_id = run_row.organization_id and p.data_class = run_row.data_class
  for key share;
  if policy_row.organization_id is null or not policy_row.execution_enabled then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_disabled'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'execution_disabled');
  end if;
  if policy_row.retention_days <> run_row.retention_days then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'policy_changed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'policy_changed');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(run_row.organization_id::text || ':' || run_row.data_class, 0)
  );
  update public.organization_retention_runs
    set status = 'running', started_at = pg_catalog.now()
    where id = run_row.id;

  begin
    case run_row.data_class
      when 'organization_page_views' then
        with candidates as (
          select v.ctid
          from public.organization_page_views v
          where v.organization_id = run_row.organization_id
            and v.day < current_date - run_row.retention_days
          order by v.day, v.path, v.hat
          limit 5000
          for update skip locked
        )
        delete from public.organization_page_views target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'organization_engagement_events' then
        with candidates as (
          select e.ctid
          from public.organization_engagement_events e
          where e.organization_id = run_row.organization_id
            and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by e.occurred_at, e.user_id, e.event_type, e.source_id
          limit 5000
          for update skip locked
        )
        delete from public.organization_engagement_events target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'integration_job_history' then
        with candidates as (
          select j.id
          from public.integration_jobs j
          where j.organization_id = run_row.organization_id
            and j.status in ('success', 'failed', 'skipped', 'dead')
            and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by j.updated_at, j.id
          limit 5000
          for update skip locked
        )
        delete from public.integration_jobs target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'public_event_rsvps' then
        with candidates as (
          select r.id
          from public.public_event_rsvps r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update skip locked
        )
        delete from public.public_event_rsvps target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'deleted_chapter_tasks' then
        with candidates as (
          select t.id
          from public.chapter_tasks t
          join public.chapters c on c.id = t.chapter_id
          where c.organization_id = run_row.organization_id
            and t.deleted_at is not null
            and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by t.deleted_at, t.id
          limit 5000
          for update of t skip locked
        )
        delete from public.chapter_tasks target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'member_message_bodies' then
        -- Row-at-a-time on purpose. private.redact_member_message_row is the
        -- only path allowed to destroy a body: it re-checks the preservation
        -- order under the row lock and sweeps the duplicate scheduled-message
        -- copy. A set-based UPDATE here would be faster and would leave that
        -- second plaintext copy behind. A hold placed mid-run raises and the
        -- handler below fails the run without redacting further — preservation
        -- wins over the retention window, deliberately.
        for candidate_id in
          select m.id
          from public.member_messages m
          join public.member_conversations c on c.id = m.conversation_id
          where c.organization_id = run_row.organization_id
            and m.redacted_at is null
            and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(m.conversation_id)
          order by m.created_at, m.id
          limit 5000
        loop
          if private.redact_member_message_row(candidate_id, 'retention_expired', run_row.authorized_by) then
            removed := removed + 1;
          end if;
        end loop;
        -- The second durable copy with no delivered row behind it. A draft that
        -- was never dispatched is not reachable from the loop above — nothing
        -- points at it — so without this it would keep its plaintext body past
        -- the window forever, which is exactly what the class promises to
        -- prevent. Same bound, same preservation-order refusal.
        for candidate_id in
          select s.id
          from public.member_scheduled_messages s
          join public.member_conversations c on c.id = s.conversation_id
          where c.organization_id = run_row.organization_id
            and s.redacted_at is null
            and s.sent_message_id is null
            and s.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(s.conversation_id)
          order by s.created_at, s.id
          limit 5000
        loop
          if private.redact_member_scheduled_message_row(candidate_id) then
            removed := removed + 1;
          end if;
        end loop;
      when 'casework_record_versions' then
        -- Same bound and the same skip-locked candidate shape as every other
        -- deleting class. `case_id is null` is the whole disposition: a
        -- case-scoped snapshot is out of reach of this branch and stays out of
        -- reach, because its lifetime is the case's lifetime, not a window.
        with candidates as (
          select v.id
          from private.casework_record_versions v
          where v.organization_id = run_row.organization_id
            and v.case_id is null
            and v.at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by v.at, v.id
          limit 5000
          for update skip locked
        )
        delete from private.casework_record_versions target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'member_notifications' then
        -- Deliveries cascade with their notification; dues and automation
        -- references detach (on delete set null).
        with candidates as (
          select n.id
          from public.member_notifications n
          where n.organization_id = run_row.organization_id
            and n.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by n.created_at, n.id
          limit 5000
          for update of n skip locked
        )
        delete from public.member_notifications target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'ai_assistant_conversations' then
        -- One 5,000-row budget covers both statements, and a conversation is
        -- removed only once it holds no messages at all.
        --
        -- BUG-UG-AI-RETENTION-CASCADE-BATCH-COUNT-20261010: the thread
        -- foreign key added in 20260721000709 is `on delete cascade`, so
        -- deleting a thread that still held expired messages destroyed them
        -- outside `removed` and outside the batch bound. Testing for "no
        -- recent messages" was what let that happen: a thread older than the
        -- window whose expired messages had not fitted in the message
        -- statement's own 5,000 rows still qualified. `not exists (any
        -- message)` is the condition the class description has always
        -- advertised, and it leaves nothing for the cascade to find.
        with candidates as (
          select m.id
          from public.member_guide_messages m
          where m.organization_id = run_row.organization_id
            and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by m.created_at, m.id
          limit 5000
          for update of m skip locked
        )
        delete from public.member_guide_messages target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
        -- Whatever the message statement left of the shared budget. A
        -- conversation whose expired messages outlast one execution keeps its
        -- thread row until a later execution empties it, so the continuation
        -- the scheduler already performs finishes the work; private.retention_eligible_count
        -- counts that thread as eligible throughout, so remaining_count stays
        -- exact. The emptiness test is repeated in the DELETE itself: the
        -- candidate scan cannot be the only guard against a message inserted
        -- into an expired thread between the scan and the delete.
        with candidates as (
          select t.id
          from public.member_guide_threads t
          where t.organization_id = run_row.organization_id
            and t.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not exists (
              select 1 from public.member_guide_messages m
              where m.thread_id = t.id
            )
          order by t.updated_at, t.id
          limit 5000 - removed
          for update of t skip locked
        )
        delete from public.member_guide_threads target
        where target.id in (select candidates.id from candidates)
          and not exists (
            select 1 from public.member_guide_messages m
            where m.thread_id = target.id
          );
        get diagnostics extra = row_count;
        removed := removed + extra;
      when 'ai_usage_counters' then
        with candidates as (
          select r.id
          from public.member_ai_requests r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update of r skip locked
        )
        delete from public.member_ai_requests target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
    end case;

    remaining := private.retention_eligible_count(
      run_row.organization_id, run_row.data_class, run_row.retention_days
    );
    update public.organization_retention_runs
      set status = 'completed', deleted_count = removed,
          remaining_count = remaining, completed_at = pg_catalog.now()
      where id = run_row.id;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      run_row.organization_id, 'privacy', 'retention.completed', 'delete', run_row.authorized_by,
      'retention_run', run_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'dataClass', run_row.data_class,
        'retentionDays', run_row.retention_days,
        'eligibleCount', run_row.eligible_count,
        'deletedCount', removed,
        'remainingCount', remaining,
        'mode', run_row.mode,
        'operation', private.retention_data_class_config(run_row.data_class) ->> 'operation'
      ) || case
        -- A scheduled run has no actor (actor_user_id stays null). The admin
        -- whose standing policy authorized it is recorded separately as
        -- userId, so the ledger never shows that person performing the run.
        when run_row.mode = 'scheduled' and policy_row.updated_by is not null
          then pg_catalog.jsonb_build_object('userId', policy_row.updated_by)
        else '{}'::jsonb
      end
    );
  exception when others then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_failed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object(
      'id', run_row.id, 'status', 'failed', 'failureCode', 'execution_failed'
    );
  end;

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'dataClass', run_row.data_class,
    'status', 'completed',
    'deletedCount', removed,
    'remainingCount', remaining
  );
end;
end;
$function$;

commit;
