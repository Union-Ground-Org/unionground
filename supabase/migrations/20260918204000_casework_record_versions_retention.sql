-- SYS-UG-CASEWORK-RECORD-VERSIONS-RETENTION-20260917 — the written
-- retention disposition for private.casework_record_versions, and its wiring
-- into the CR-104 engine.
--
-- THE DISPOSITION
--
-- 20260917143000 (PR #2103) installed twenty-five after-row triggers that
-- capture full old_row/new_row snapshots of public.member_cases and the
-- casework suite into private.casework_record_versions. Those snapshots split
-- cleanly in two, and they get two different answers.
--
-- 1. A CASE-SCOPED VERSION (case_id is not null) KEEPS CASCADING. It is held by
--    casework_record_versions_case_id_fkey on delete cascade, it is already
--    declared that way in private.account_lifecycle_transitive_fk_manifest, and
--    tests/case-history-db.test.js proves the cascade. Its lifetime is the
--    case's lifetime. That is a STRONGER disposition than any window an
--    administrator could configure here, and a window would not shorten it: a
--    case that is still open is still being worked, and a version older than
--    the window is exactly the early history a grievance or arbitration record
--    is most likely to need. So case-scoped versions are deliberately NOT
--    eligible, and the executor branch below cannot reach them.
--
-- 2. AN ORGANIZATION-SCOPED VERSION (case_id is null) GETS A WINDOW. These are
--    the snapshots of rows that never belonged to a case — the clearest example
--    is one row per public.casework_intake_drafts revision written while an
--    intake is still a draft. They are held only by organization_id on delete
--    cascade, so before this migration they survived until the ORGANIZATION was
--    deleted: no clock, and no disposition an operator answering a retention or
--    deletion question could point at. They are now the
--    'casework_record_versions' data class: 180 days minimum, 3650 maximum,
--    730 default, operation 'delete', execution disabled until an organization
--    administrator turns it on like every other class.
--
--    The 180-day floor is deliberate and is not the messaging floor. These rows
--    are the only record of who changed an organization's casework
--    configuration and of what a draft intake said before it became a case, so
--    a window short enough to erase the current configuration cycle would
--    destroy the audit value the capture exists for. The 3650-day ceiling
--    matches the other organization-configuration classes rather than the
--    2555-day privacy ceiling on conversation content, because this class
--    holds no delivered member-to-member correspondence.
--
-- WHY CAPTURE IS NOT NARROWED TO THE FIFTEEN TABLES THE READER EXPOSES
--
-- public.casework_case_history projects fifteen of the twenty-five captured
-- tables. The other ten are captured on purpose and are justified here rather
-- than removed, because the reader and the ledger answer different questions.
-- The reader answers "what may THIS caller see about this case", under the
-- caller's own RLS. The ledger answers "what actually changed", for the
-- account-lifecycle and deletion inventory and for incident reconstruction; it
-- is revoked from public, anon, authenticated and service_role, it has RLS
-- enabled, and private.casework_history_versions is its only read boundary.
-- Dropping capture on the ten unread tables would buy no privacy — nobody can
-- read them today — and would lose the only record that those rows ever
-- changed. The honest cost of keeping them is an unbounded clock, and that is
-- what this migration removes. The inventory row in
-- private.account_lifecycle_manifest is extended below so the disposition is
-- readable from the same place as every other table's.
--
-- Every captured table except public.member_cases carries organization_id, and
-- a public.member_cases snapshot always carries a case_id, so no captured row
-- can fall outside both dispositions.

begin;
set local lock_timeout = '5s';

-- Every eligibility count and candidate query starts with tenant, scope and
-- age, exactly like the five indexes 20260830180000 added for its own classes.
create index casework_record_versions_org_retention_idx
  on private.casework_record_versions (organization_id, at, id)
  where case_id is null;

alter table public.organization_retention_policies
  drop constraint organization_retention_policies_data_class_check,
  add constraint organization_retention_policies_data_class_check check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks',
    'member_message_bodies',
    'casework_record_versions'
  ));

alter table public.organization_retention_runs
  drop constraint organization_retention_runs_data_class_check,
  add constraint organization_retention_runs_data_class_check check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks',
    'member_message_bodies',
    'casework_record_versions'
  ));

create or replace function private.retention_data_class_config(p_data_class text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case p_data_class
    when 'organization_page_views' then pg_catalog.jsonb_build_object(
      'label', 'Organization page views', 'minimumDays', 30, 'maximumDays', 3650, 'defaultDays', 180,
      'operation', 'delete',
      'description', 'Aggregated daily path and hat counts; no page-view identity rows.'
    )
    when 'organization_engagement_events' then pg_catalog.jsonb_build_object(
      'label', 'Engagement events', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'operation', 'delete',
      'description', 'Organization analytics events after their reporting window.'
    )
    when 'integration_job_history' then pg_catalog.jsonb_build_object(
      'label', 'Integration job history', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'operation', 'delete',
      'description', 'Terminal provider-operation envelopes; active or queued jobs are never eligible.'
    )
    when 'public_event_rsvps' then pg_catalog.jsonb_build_object(
      'label', 'Public event RSVPs', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'operation', 'delete',
      'description', 'Submitted public RSVP names and email addresses after the published 90-day window.'
    )
    when 'deleted_chapter_tasks' then pg_catalog.jsonb_build_object(
      'label', 'Deleted chapter tasks', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'operation', 'delete',
      'description', 'Soft-deleted tasks and their cascading task-thread records after the recovery window.'
    )
    when 'member_message_bodies' then pg_catalog.jsonb_build_object(
      'label', 'Direct message bodies', 'minimumDays', 365, 'maximumDays', 2555, 'defaultDays', 1095,
      'operation', 'redact',
      'description', 'Direct conversation text older than the window is destroyed in place; the message, its timestamps and a digest survive as a tombstone. Conversations under a preservation order are never eligible.'
    )
    when 'casework_record_versions' then pg_catalog.jsonb_build_object(
      'label', 'Casework record snapshots', 'minimumDays', 180, 'maximumDays', 3650, 'defaultDays', 730,
      'operation', 'delete',
      'description', 'Organization-scoped casework row snapshots that never belonged to a case. A snapshot that belongs to a case is never eligible here; it is destroyed with the case.'
    )
    else null
  end;
$function$;

create or replace function private.retention_eligible_count(
  p_organization_id uuid,
  p_data_class text,
  p_retention_days integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  eligible bigint;
begin
  if private.retention_data_class_config(p_data_class) is null then
    raise exception 'unsupported retention data class' using errcode = '22023';
  end if;

  case p_data_class
    when 'organization_page_views' then
      select pg_catalog.count(*) into eligible
      from public.organization_page_views v
      where v.organization_id = p_organization_id
        and v.day < current_date - p_retention_days;
    when 'organization_engagement_events' then
      select pg_catalog.count(*) into eligible
      from public.organization_engagement_events e
      where e.organization_id = p_organization_id
        and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'integration_job_history' then
      select pg_catalog.count(*) into eligible
      from public.integration_jobs j
      where j.organization_id = p_organization_id
        and j.status in ('success', 'failed', 'skipped', 'dead')
        and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'public_event_rsvps' then
      select pg_catalog.count(*) into eligible
      from public.public_event_rsvps r
      where r.organization_id = p_organization_id
        and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'deleted_chapter_tasks' then
      select pg_catalog.count(*) into eligible
      from public.chapter_tasks t
      join public.chapters c on c.id = t.chapter_id
      where c.organization_id = p_organization_id
        and t.deleted_at is not null
        and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'member_message_bodies' then
      -- Both durable copies of a body are in scope, or the count would promise a
      -- sweep the worker does not perform: delivered messages, plus scheduled
      -- messages that were never dispatched and therefore have no delivered row
      -- to be redacted with.
      select
        (select pg_catalog.count(*)
         from public.member_messages m
         left join public.member_profiles p on p.id = m.user_id
         left join public.chapters c on c.id = p.chapter_id
         left join public.member_message_legal_holds h on h.conversation_id = m.conversation_id
         where coalesce(c.organization_id, h.organization_id) = p_organization_id
           and m.redacted_at is null
           and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days)
           and not private.member_message_under_legal_hold(m.conversation_id))
        + (select pg_catalog.count(*)
           from public.member_scheduled_messages s
           left join public.member_profiles p on p.id = s.actor_id
           left join public.chapters c on c.id = p.chapter_id
           left join public.member_message_legal_holds h on h.conversation_id = s.conversation_id
           where coalesce(c.organization_id, h.organization_id) = p_organization_id
             and s.redacted_at is null
             and s.sent_message_id is null
             and s.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days)
             and not private.member_message_under_legal_hold(s.conversation_id))
      into eligible;
    when 'casework_record_versions' then
      -- Only the organization-scoped snapshots. A snapshot with a case_id is
      -- held by public.member_cases on delete cascade and has a shorter,
      -- stronger disposition already: it disappears with the case. Counting it
      -- here would promise a deletion the executor deliberately does not make.
      select pg_catalog.count(*) into eligible
      from private.casework_record_versions v
      where v.organization_id = p_organization_id
        and v.case_id is null
        and v.at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
  end case;

  if eligible > 2147483647 then
    return 2147483647;
  end if;
  return eligible::integer;
end;
$function$;

-- The bounded worker gains one deleting branch. Every other branch is
-- unchanged from 20260907121000.
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
      )
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

-- The administrator settings surface consumes this catalogue.
create or replace function public.get_organization_retention_engine()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  org uuid;
  caller uuid;
  result jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  org := private.current_member_organization();
  caller := private.assert_retention_admin(org);

  with catalog(data_class) as (values
    ('organization_page_views'::text),
    ('organization_engagement_events'),
    ('integration_job_history'),
    ('public_event_rsvps'),
    ('deleted_chapter_tasks'),
    ('member_message_bodies'),
    ('casework_record_versions')
  ), policy_rows as (
    select
      c.data_class,
      private.retention_data_class_config(c.data_class) as config,
      p.retention_days,
      p.execution_enabled,
      p.updated_at
    from catalog c
    left join public.organization_retention_policies p
      on p.organization_id = org
     and p.data_class = c.data_class
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', org,
    'schedulerConfigured', private.retention_scheduler_configured(),
    'policies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'dataClass', p.data_class,
        'label', p.config ->> 'label',
        'description', p.config ->> 'description',
        'minimumDays', (p.config ->> 'minimumDays')::integer,
        'maximumDays', (p.config ->> 'maximumDays')::integer,
        'defaultDays', (p.config ->> 'defaultDays')::integer,
        'retentionDays', coalesce(p.retention_days, (p.config ->> 'defaultDays')::integer),
        'configured', p.retention_days is not null,
        'executionEnabled', coalesce(p.execution_enabled, false),
        'updatedAt', p.updated_at
      ) order by p.data_class)
      from policy_rows p
    ), '[]'::jsonb),
    'runs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'dataClass', r.data_class,
        'retentionDays', r.retention_days,
        'mode', r.mode,
        'status', r.status,
        'eligibleCount', r.eligible_count,
        'deletedCount', r.deleted_count,
        'remainingCount', r.remaining_count,
        'requestedBy', r.requested_by,
        'authorizedBy', r.authorized_by,
        'authorizationExpiresAt', r.authorization_expires_at,
        'createdAt', r.created_at,
        'completedAt', r.completed_at,
        'failureCode', r.failure_code,
        'confirmationPhrase', case when r.status = 'previewed'
          then 'AUTHORIZE ' || r.data_class else null end
      ) order by r.created_at desc, r.id desc)
      from (
        select history.*
        from public.organization_retention_runs history
        where history.organization_id = org
        order by history.created_at desc, history.id desc
        limit 25
      ) r
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

-- The inventory row now carries the retention decision, so an operator
-- answering a deletion or retention question reads both halves in one place.
update private.account_lifecycle_manifest
set note = 'Actor detaches on account deletion; case-owned versions cascade with the case. Retention: organization-scoped versions (case_id is null) are the casework_record_versions data class (180-3650 days, default 730, operation delete, execution disabled until an organization administrator enables it); case-scoped versions have no window and are destroyed with their case. Capture covers all twenty-five casework tables, ten more than public.casework_case_history projects, because the ledger is an internal change record behind private.casework_history_versions, not a member-facing feed.'
where schema_name = 'private'
  and table_name = 'casework_record_versions'
  and user_column = 'actor';

notify pgrst, 'reload schema';

commit;
