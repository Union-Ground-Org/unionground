-- DEBT-UG-RETENTION-SCHEDULED-RUN-ACTOR-MISATTRIBUTED-20260921
--
-- private.run_due_organization_retention_jobs (last written in
-- 20260907121000, then wrapped by 20260907151000) inserted every nightly
-- scheduled run with requested_by = authorized_by = the policy's updated_by.
-- private.perform_organization_retention_run then stamped that admin as the
-- actor_user_id of the retention.completed ledger event and as redacted_by on
-- every message tombstone the scheduler produced. The privacy ledger showed a
-- person, possibly one who had since left the organization, deleting rows
-- every night. Once that account was deleted, the same rows carried no actor
-- at all.
--
-- Scheduled runs now record requested_by and authorized_by as null: the
-- scheduler acted, and mode = 'scheduled' is the documented system marker.
-- Because perform_organization_retention_run passes run_row.authorized_by as
-- the ledger actor and the redactor, scheduler-driven ledger events and
-- message tombstones carry no person either. The admin whose standing policy
-- enabled execution is kept as the standing authorizer: retention.completed
-- for a scheduled run adds metadata.userId = the policy's updated_by (a key
-- the ledger's metadata allowlist already admits), and the audit log renders
-- that event's actor as the Scheduler with the standing authorizer named
-- separately. Manual runs are unchanged: the admin who authorized one is
-- still its actor and its redactor.
--
-- Both functions are re-declared from their installed bodies. The digest
-- guard below refuses any predecessor other than the reviewed ones: the
-- 20260907151000 double-wrapped scheduler and the 20260918204000 worker. Every
-- case-graph and message-lifecycle gate is kept in its original position, and
-- nothing else in either body changes.

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
   where p.oid = 'private.run_due_organization_retention_jobs(integer)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '7a1a3f3ae75701fef3e096fc734b7c8880d8d2beb9c7ec3e8870cf51ad4a7436' then
    raise exception 'unreviewed run_due_organization_retention_jobs predecessor: %', digest
      using errcode = '55000';
  end if;

  select p.prosrc into strict source
    from pg_catalog.pg_proc p
   where p.oid = 'private.perform_organization_retention_run(uuid)'::regprocedure;
  digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
    'hex'
  );
  if digest is distinct from '4cbb4d5c2fe1cc34a549d35dbcceba6b72f01ba11fbad23a6567abf2d4634e8c' then
    raise exception 'unreviewed perform_organization_retention_run predecessor: %', digest
      using errcode = '55000';
  end if;
end;
$predecessor$;

create or replace function private.run_due_organization_retention_jobs(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  perform private.lock_message_lifecycle();

declare
  policy_row public.organization_retention_policies%rowtype;
  run_id uuid;
  processed integer := 0;
begin
  perform private.lock_message_lifecycle();
  for policy_row in
    select p.*
    from public.organization_retention_policies p
    where p.execution_enabled
      and not exists (
        select 1
        from public.organization_retention_runs r
        where r.organization_id = p.organization_id
          and r.data_class = p.data_class
          and r.mode = 'scheduled'
          and r.created_at >= pg_catalog.now() - interval '20 hours'
      )
    order by p.updated_at, p.organization_id, p.data_class
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update skip locked
  loop
    -- The scheduler performs this run, not the policy's last editor, so it
    -- carries no requesting or authorizing person. The admin whose standing
    -- policy enabled execution is named in the ledger metadata instead.
    insert into public.organization_retention_runs (
      organization_id, data_class, retention_days, mode, status,
      eligible_count, requested_by, authorized_by, authorized_at,
      authorization_expires_at
    ) values (
      policy_row.organization_id, policy_row.data_class, policy_row.retention_days,
      'scheduled', 'authorized',
      private.retention_eligible_count(
        policy_row.organization_id, policy_row.data_class, policy_row.retention_days
      ),
      null, null, pg_catalog.now(),
      pg_catalog.now() + interval '30 minutes'
    ) returning id into run_id;
    perform private.perform_organization_retention_run(run_id);
    processed := processed + 1;
  end loop;

  return pg_catalog.jsonb_build_object('processed', processed, 'ranAt', pg_catalog.now());
end;
end;
end;
$function$;

create or replace function private.perform_organization_retention_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- 20260907151000 wrapped the previous definition of this writer with the
  -- case-graph gate. A create-or-replace has to carry that gate itself, so
  -- the original block below becomes a nested block behind the same first
  -- acquisition, in the same order, for exactly the same reason.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  run_row public.organization_retention_runs%rowtype;
  policy_row public.organization_retention_policies%rowtype;
  removed integer := 0;
  remaining integer := 0;
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
          left join public.member_profiles p on p.id = m.user_id
          left join public.chapters c on c.id = p.chapter_id
          left join public.member_message_legal_holds h on h.conversation_id = m.conversation_id
          where coalesce(c.organization_id, h.organization_id) = run_row.organization_id
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
          left join public.member_profiles p on p.id = s.actor_id
          left join public.chapters c on c.id = p.chapter_id
          left join public.member_message_legal_holds h on h.conversation_id = s.conversation_id
          where coalesce(c.organization_id, h.organization_id) = run_row.organization_id
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
