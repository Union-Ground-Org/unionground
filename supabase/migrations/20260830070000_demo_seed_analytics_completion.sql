-- SAMPLE-only completion for MI1 CR-040 through CR-044.
--
-- The analytics product schema is already deployed. This phase composes
-- reversible report-card activity and reusable chart layouts into each
-- guarded SAMPLE lane. It is attached to the shared function-evidence
-- lifecycle so later seed repairs compose without replacing one another's
-- public wrappers. Production has no function-evidence runs, and the only
-- public entry points remain the existing project-ref guarded seed RPCs.

set local lock_timeout = '5s';

update private.demo_seed_function_catalog catalog
set coverage = 'seeded',
    evidence_key = evidence.evidence_key,
    gate_relation = null
from (values
  ('CR-040', 'analytics-member-report-card'),
  ('CR-041', 'analytics-organization-health'),
  ('CR-042', 'analytics-explorer-datasets'),
  ('CR-043', 'analytics-layout-studio'),
  ('CR-044', 'analytics-chapter-charts')
) as evidence(function_id, evidence_key)
where catalog.function_id = evidence.function_id;

insert into private.demo_seed_page_contract
  (surface, page_size, minimum_rows, scope, source)
values
  ('analyticsMemberExplorer', 25, 50, 'organization',
    'supabase/migrations/20260830070000_demo_seed_analytics_completion.sql'),
  ('analyticsOrganizationLayouts', 15, 30, 'organization',
    'supabase/migrations/20260830070000_demo_seed_analytics_completion.sql'),
  ('analyticsChapterLayouts', 15, 30, 'featured-chapter',
    'supabase/migrations/20260830070000_demo_seed_analytics_completion.sql')
on conflict (surface) do update set
  page_size = excluded.page_size,
  minimum_rows = excluded.minimum_rows,
  scope = excluded.scope,
  source = excluded.source;

create table private.demo_seed_analytics_runs (
  lane text not null check (lane in ('presg', 'uniondemo')),
  run_id uuid not null,
  organization_id uuid not null,
  actor_user_id uuid not null,
  chapter_id text not null,
  source_prefix text not null,
  seeded_at timestamptz not null default pg_catalog.now(),
  primary key (lane, run_id)
);

-- Rows in these ledgers are the exact ownership boundary for data that is not
-- derived from the bulk-load user ledger. Health rows may share the same
-- chapter/date namespace as operator-authored snapshots, so only rows actually
-- inserted by this phase are recorded and later removed. The canonical SAMPLE
-- personas predate both load lanes; their previous selection state is captured
-- before the statewide lane temporarily connects them to its featured chapter.
create table private.demo_seed_analytics_health_rows (
  lane text not null check (lane in ('presg', 'uniondemo')),
  run_id uuid not null,
  snapshot_id uuid not null,
  chapter_id text not null,
  measured_on date not null,
  primary key (lane, run_id, snapshot_id)
);

create table private.demo_seed_analytics_persona_links (
  lane text not null check (lane = 'uniondemo'),
  run_id uuid not null,
  user_id uuid not null,
  previous_profile_chapter_id text,
  previous_profile_updated_at timestamptz not null,
  organization_membership_existed boolean not null,
  previous_organization_membership_status text,
  previous_organization_revoked_at timestamptz,
  chapter_membership_existed boolean not null,
  previous_chapter_membership_status text,
  previous_chapter_revoked_at timestamptz,
  previous_chapter_pinned boolean,
  previous_chapter_last_selected_at timestamptz,
  previous_chapter_joined_at timestamptz,
  primary key (lane, run_id, user_id)
);

create table private.demo_seed_analytics_persona_role_rows (
  lane text not null check (lane = 'uniondemo'),
  run_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')),
  primary key (lane, run_id, user_id, role)
);

revoke all on private.demo_seed_analytics_runs
  from public, anon, authenticated, service_role;
revoke all on private.demo_seed_analytics_health_rows
  from public, anon, authenticated, service_role;
revoke all on private.demo_seed_analytics_persona_links
  from public, anon, authenticated, service_role;
revoke all on private.demo_seed_analytics_persona_role_rows
  from public, anon, authenticated, service_role;

-- Account deletion correctly refuses the final administrator of an active
-- tenant. A guarded seed removal is an explicit tenant teardown, so archive
-- only that deterministic SAMPLE organization when its private run enters the
-- removing state. Interrupted removals remain resumable and visibly inactive;
-- the ordinary seed-org upsert restores active status on a later reapply.
create function private.demo_seed_archive_organization_on_remove()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  organization uuid;
begin
  if new.state = 'removing' and old.state is distinct from 'removing' then
    organization := private.member_stress_uuid(
      new.id::text || case when tg_table_name = 'presg_demo_runs'
        then ':presg:organization' else ':ud:organization' end
    );
    update public.organizations target
    set status = 'archived', updated_at = pg_catalog.now()
    where target.id = organization and target.status = 'active';
  end if;
  return new;
end;
$function$;

create trigger presg_demo_archive_organization_on_remove
after update of state on private.presg_demo_runs
for each row execute function private.demo_seed_archive_organization_on_remove();

create trigger uniondemo_archive_organization_on_remove
after update of state on private.uniondemo_runs
for each row execute function private.demo_seed_archive_organization_on_remove();

-- Keep each active SAMPLE lane on an exact rolling three-year window. The
-- ownership ledger lets rotation remove only seed-created snapshots; an
-- operator-authored row that won the chapter/date uniqueness race is neither
-- claimed nor deleted.
create function private.demo_seed_refresh_analytics_health(text, uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  p_lane alias for $1;
  p_run_id alias for $2;
  run private.demo_seed_analytics_runs%rowtype;
  rolling_start date := (
    pg_catalog.date_trunc('month', current_date)::date - interval '35 months'
  )::date;
  removed_rows bigint := 0;
  inserted_rows bigint := 0;
begin
  select * into run
  from private.demo_seed_analytics_runs analytics_run
  where analytics_run.lane = p_lane and analytics_run.run_id = p_run_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'refreshed', false, 'reason', 'analytics_run_not_found'
    );
  end if;

  delete from public.chapter_health_snapshots snapshot
  using private.demo_seed_analytics_health_rows owned
  where owned.lane = p_lane
    and owned.run_id = p_run_id
    and owned.measured_on < rolling_start
    and snapshot.id = owned.snapshot_id;
  get diagnostics removed_rows = row_count;

  delete from private.demo_seed_analytics_health_rows owned
  where owned.lane = p_lane
    and owned.run_id = p_run_id
    and (
      owned.measured_on < rolling_start
      or not exists (
        select 1
        from public.chapter_health_snapshots snapshot
        where snapshot.id = owned.snapshot_id
      )
    );

  with chapter_months as (
    select chapter.id as chapter_id,
      (
        pg_catalog.date_trunc('month', current_date)::date
        - (series.month_offset || ' months')::interval
      )::date as measured_on
    from public.chapters chapter
    cross join pg_catalog.generate_series(0, 35) series(month_offset)
    where chapter.organization_id = run.organization_id
  ), signals as (
    select chapter_months.*,
      55 + private.member_stress_pick(
        p_run_id::text || ':analytics:health:participation:' || chapter_id || ':' || measured_on, 41
      ) as participation,
      55 + private.member_stress_pick(
        p_run_id::text || ':analytics:health:timeliness:' || chapter_id || ':' || measured_on, 41
      ) as case_timeliness,
      55 + private.member_stress_pick(
        p_run_id::text || ':analytics:health:capacity:' || chapter_id || ':' || measured_on, 41
      ) as steward_capacity,
      55 + private.member_stress_pick(
        p_run_id::text || ':analytics:health:training:' || chapter_id || ':' || measured_on, 41
      ) as training_coverage,
      55 + private.member_stress_pick(
        p_run_id::text || ':analytics:health:communication:' || chapter_id || ':' || measured_on, 41
      ) as communication_reach,
      55 + private.member_stress_pick(
        p_run_id::text || ':analytics:health:governance:' || chapter_id || ':' || measured_on, 41
      ) as governance_readiness
    from chapter_months
  ), inserted as (
    insert into public.chapter_health_snapshots (
      id, chapter_id, measured_on, member_count,
      participation, case_timeliness, steward_capacity, training_coverage,
      communication_reach, governance_readiness, score, created_by
    )
    select private.member_stress_uuid(
        p_run_id::text || ':analytics:health:' || signal.chapter_id || ':' || signal.measured_on
      ),
      signal.chapter_id, signal.measured_on,
      (
        select pg_catalog.count(*)
        from public.member_chapter_memberships membership
        where membership.chapter_id = signal.chapter_id
          and membership.status = 'active'
      ),
      signal.participation, signal.case_timeliness, signal.steward_capacity,
      signal.training_coverage, signal.communication_reach,
      signal.governance_readiness,
      ((signal.participation + signal.case_timeliness + signal.steward_capacity
        + signal.training_coverage + signal.communication_reach
        + signal.governance_readiness) / 6)::integer,
      run.actor_user_id
    from signals signal
    on conflict do nothing
    returning id, chapter_id, measured_on
  )
  insert into private.demo_seed_analytics_health_rows (
    lane, run_id, snapshot_id, chapter_id, measured_on
  )
  select p_lane, p_run_id, inserted.id, inserted.chapter_id, inserted.measured_on
  from inserted
  on conflict do nothing;
  get diagnostics inserted_rows = row_count;

  return pg_catalog.jsonb_build_object(
    'refreshed', true,
    'windowStart', rolling_start,
    'inserted', inserted_rows,
    'removed', removed_rows
  );
end;
$function$;

create function private.demo_seed_rotate_analytics_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
  refreshed_runs integer := 0;
begin
  for seeded_run in
    select analytics_run.lane, analytics_run.run_id
    from private.demo_seed_analytics_runs analytics_run
    order by analytics_run.lane, analytics_run.run_id
  loop
    perform private.demo_seed_refresh_analytics_health(
      seeded_run.lane, seeded_run.run_id
    );
    refreshed_runs := refreshed_runs + 1;
  end loop;
  return pg_catalog.jsonb_build_object('refreshedRuns', refreshed_runs);
end;
$function$;

create function private.demo_seed_ensure_analytics_health_rotation()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if pg_catalog.to_regclass('cron.job') is null then
    return false;
  end if;
  perform cron.unschedule(job.jobid)
  from cron.job job
  where job.jobname = 'demo-seed-analytics-health-rotate';
  perform cron.schedule('demo-seed-analytics-health-rotate', '23 5 * * *',
    $job$select private.demo_seed_rotate_analytics_health();$job$);
  return true;
exception when others then
  return false;
end;
$function$;

create function private.demo_seed_drop_analytics_health_rotation()
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if exists (select 1 from private.demo_seed_analytics_runs)
    or pg_catalog.to_regclass('cron.job') is null
  then
    return false;
  end if;
  perform cron.unschedule(job.jobid)
  from cron.job job
  where job.jobname = 'demo-seed-analytics-health-rotate';
  return true;
exception when others then
  return false;
end;
$function$;

create function private.demo_seed_analytics_status(p_lane text, p_run_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with run as (
    select * from private.demo_seed_analytics_runs
    where lane = p_lane and run_id = p_run_id
  ), layout_ids as (
    select series.i as ordinal,
      private.member_stress_uuid(
      p_run_id::text || ':analytics:layout:' || series.i
    ) as id
    from pg_catalog.generate_series(1, 60) series(i)
  ), demo_seed_ledger as (
    select ledger.user_id from private.presg_demo_ledger ledger
    where p_lane = 'presg' and ledger.run_id = p_run_id
    union all
    select ledger.user_id from private.uniondemo_ledger ledger
    where p_lane = 'uniondemo' and ledger.run_id = p_run_id
  ), eligible_members as (
    select membership.user_id, profile.chapter_id,
      (ledger.user_id is null) as primary_persona
    from run
    join public.organization_memberships membership
      on membership.organization_id = run.organization_id
     and membership.status = 'active'
    join public.member_profiles profile on profile.id = membership.user_id
    join public.member_chapter_memberships chapter_membership
      on chapter_membership.user_id = profile.id
     and chapter_membership.chapter_id = profile.chapter_id
     and chapter_membership.status = 'active'
    join public.chapters candidate
      on candidate.id = profile.chapter_id
     and candidate.organization_id = run.organization_id
    left join demo_seed_ledger ledger on ledger.user_id = membership.user_id
    order by (ledger.user_id is null) desc, membership.user_id
    limit 100
  ), selected_members as (
    select * from eligible_members
  ), event_counts as (
    select pg_catalog.count(*) * 6 as expected
    from selected_members
  ), explorer_counts as (
    select pg_catalog.count(*) as actual
    from selected_members
  ), layout_counts as (
    select
      pg_catalog.count(*) filter (where
        expected.ordinal between 1 and 30
        and layout.organization_id = run.organization_id
        and layout.owner_user_id = run.actor_user_id
        and layout.scope = 'organization'
        and layout.chapter_id is null
        and layout.name = 'Organization health view ' || expected.ordinal
        and layout.spec = pg_catalog.jsonb_build_object(
          'datasetId', 'organization:chapter-health',
          'chartType', (array['bar', 'stacked_bar', 'line', 'area', 'table'])[1 + (expected.ordinal % 5)],
          'title', 'Organization health view ' || expected.ordinal
        )
      ) as organization_layouts,
      pg_catalog.count(*) filter (where
        expected.ordinal between 31 and 60
        and layout.organization_id = run.organization_id
        and layout.owner_user_id = run.actor_user_id
        and layout.scope = 'chapter'
        and layout.chapter_id = run.chapter_id
        and layout.name = 'Chapter trend view ' || expected.ordinal
        and layout.spec = pg_catalog.jsonb_build_object(
          'datasetId', 'chapter:' || run.chapter_id || ':health-trend',
          'chartType', (array['bar', 'stacked_bar', 'line', 'area', 'table'])[1 + (expected.ordinal % 5)],
          'title', 'Chapter trend view ' || expected.ordinal
        )
      ) as chapter_layouts
    from run
    cross join layout_ids expected
    left join public.organization_analytics_layouts layout
      on layout.id = expected.id
  ), chapter_set as (
    select chapter.id
    from run
    join public.chapters chapter on chapter.organization_id = run.organization_id
  ), health_dates as (
    select (
      pg_catalog.date_trunc('month', current_date)::date
      - (series.month_offset || ' months')::interval
    )::date as measured_on
    from pg_catalog.generate_series(0, 35) series(month_offset)
  ), expected_health as (
    select chapter.id as chapter_id, health_dates.measured_on
    from chapter_set chapter cross join health_dates
  ), health_counts as (
    select pg_catalog.count(*) as expected,
      pg_catalog.count(snapshot.id) as actual,
      pg_catalog.count(distinct case when snapshot.id is not null then expected.chapter_id end) as chapters
    from expected_health expected
    left join public.chapter_health_snapshots snapshot
      on snapshot.chapter_id = expected.chapter_id
     and snapshot.measured_on = expected.measured_on
  ), sample_personas as (
    select users.id,
      users.raw_app_meta_data ->> 'sample_persona' as hat
    from auth.users users
    where p_lane = 'uniondemo'
      and coalesce(users.raw_app_meta_data ->> 'sample_persona', '')
        in ('member', 'steward', 'coordinator', 'advisor', 'admin', 'vp')
  ), persona_counts as (
    select pg_catalog.count(*) as expected,
      pg_catalog.count(distinct persona.hat) as distinct_hats,
      pg_catalog.count(*) filter (where
        exists (
          select 1 from run
          join public.member_profiles profile on profile.id = persona.id
          join public.chapters chapter
            on chapter.id = profile.chapter_id
           and chapter.organization_id = run.organization_id
          join public.organization_memberships membership
            on membership.organization_id = run.organization_id
           and membership.user_id = persona.id
           and membership.status = 'active'
          join public.member_chapter_memberships chapter_membership
            on chapter_membership.user_id = persona.id
           and chapter_membership.chapter_id = profile.chapter_id
           and chapter_membership.status = 'active'
          where not exists (
            select 1
            from public.member_roles role
            where role.user_id = persona.id
              and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
              and not exists (
                select 1 from public.organization_role_grants role_grant
                where role_grant.organization_id = run.organization_id
                  and role_grant.user_id = persona.id
                  and role_grant.role = role.role
              )
          )
        )
      ) as visible
    from sample_personas persona
  )
  select pg_catalog.jsonb_build_object(
    'ok',
      exists (select 1 from run)
      and (select organization_layouts = 30 and chapter_layouts = 30
        from layout_counts)
      and (select actual >= 50 from explorer_counts)
      and (select expected > 0 from event_counts)
      and (select event_counts.expected = (
             select pg_catalog.count(*)
             from public.organization_engagement_events event
             join run on run.organization_id = event.organization_id
             where event.source_id like run.source_prefix || ':%'
           ) from event_counts)
      and (select actual = expected and expected > 0 from health_counts)
      and (select visible = expected from persona_counts)
      and (
        p_lane <> 'uniondemo'
        or (select expected = 6 and distinct_hats = 6 from persona_counts)
      ),
    'layouts', (select organization_layouts + chapter_layouts from layout_counts),
    'organizationLayouts', (select organization_layouts from layout_counts),
    'chapterLayouts', (select chapter_layouts from layout_counts),
    'explorerMembers', (select actual from explorer_counts),
    'reportCardEvents', (select pg_catalog.count(*)
      from public.organization_engagement_events event
      join run on run.organization_id = event.organization_id
      where event.source_id like run.source_prefix || ':%'),
    'expectedReportCardEvents', (select expected from event_counts),
    'healthSnapshots', (select actual from health_counts),
    'expectedHealthSnapshots', (select expected from health_counts),
    'healthChapters', (select chapters from health_counts),
    'samplePersonas', (select expected from persona_counts),
    'distinctSamplePersonaHats', (select distinct_hats from persona_counts),
    'visibleSamplePersonas', (select visible from persona_counts)
  );
$function$;

-- The public seed drivers use these status functions for both explicit
-- `status` and `verify`. Recompose the latest auth-operation wrapper with the
-- analytics verifier so persisted catalog/page evidence can never mask a
-- deleted layout, event, health point, persona membership, or role grant.
create or replace function public.presg_demo_function_parity_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  analytics_result jsonb;
  parity_result jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  auth_result := private.demo_seed_auth_operations_status('presg', p_run_id);
  analytics_result := private.demo_seed_analytics_status('presg', p_run_id);
  parity_result := private.demo_seed_function_parity_status('presg', p_run_id);
  return parity_result || pg_catalog.jsonb_build_object(
    'ok',
      coalesce((parity_result ->> 'ok')::boolean, false)
      and coalesce((auth_result ->> 'ok')::boolean, false)
      and coalesce((analytics_result ->> 'ok')::boolean, false),
    'authOperations', auth_result,
    'analytics', analytics_result
  );
end;
$function$;

create or replace function public.uniondemo_function_parity_status(p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  auth_result jsonb;
  analytics_result jsonb;
  parity_result jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  auth_result := private.demo_seed_auth_operations_status('uniondemo', p_run_id);
  analytics_result := private.demo_seed_analytics_status('uniondemo', p_run_id);
  parity_result := private.demo_seed_function_parity_status('uniondemo', p_run_id);
  return parity_result || pg_catalog.jsonb_build_object(
    'ok',
      coalesce((parity_result ->> 'ok')::boolean, false)
      and coalesce((auth_result ->> 'ok')::boolean, false)
      and coalesce((analytics_result ->> 'ok')::boolean, false),
    'authOperations', auth_result,
    'analytics', analytics_result
  );
end;
$function$;

create function private.demo_seed_apply_analytics(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $function$
declare
  organization uuid;
  actor uuid;
  chapter text;
  verification jsonb;
  prefix text := 'analytics-' || pg_catalog.substr(
    pg_catalog.md5(p_run_id::text || ':' || p_lane), 1, 12
  );
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_lane = 'presg' then
    organization := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    organization := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;
  actor := private.demo_seed_user(p_lane, p_run_id, 1);
  chapter := private.demo_seed_chapter(p_lane, p_run_id, 1);
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = organization
      and membership.user_id = actor
      and membership.status = 'active'
  ) then
    raise exception 'analytics actor is not an active organization member';
  end if;

  insert into private.demo_seed_analytics_runs (
    lane, run_id, organization_id, actor_user_id, chapter_id, source_prefix
  ) values (
    p_lane, p_run_id, organization, actor, chapter, prefix
  ) on conflict (lane, run_id) do update set
    organization_id = excluded.organization_id,
    actor_user_id = excluded.actor_user_id,
    chapter_id = excluded.chapter_id,
    source_prefix = excluded.source_prefix,
    seeded_at = pg_catalog.now();

  -- The SAMPLE website enters as one of six explicitly tagged personas. Link
  -- those pre-existing fictional identities to the statewide demo only; the
  -- Union Ground lane remains independently runnable. Every previous
  -- profile and membership value is captured before the first write so the
  -- lane's guarded teardown restores, rather than guesses, earlier state.
  if p_lane = 'uniondemo' then
    insert into private.demo_seed_analytics_persona_links (
      lane, run_id, user_id, previous_profile_chapter_id,
      previous_profile_updated_at,
      organization_membership_existed,
      previous_organization_membership_status,
      previous_organization_revoked_at,
      chapter_membership_existed,
      previous_chapter_membership_status,
      previous_chapter_revoked_at,
      previous_chapter_pinned,
      previous_chapter_last_selected_at,
      previous_chapter_joined_at
    )
    select p_lane, p_run_id, users.id, profile.chapter_id, profile.updated_at,
      (membership.user_id is not null), membership.status, membership.revoked_at,
      (chapter_membership.user_id is not null), chapter_membership.status,
      chapter_membership.revoked_at, chapter_membership.pinned,
      chapter_membership.last_selected_at, chapter_membership.joined_at
    from auth.users users
    join public.member_profiles profile on profile.id = users.id
    left join public.organization_memberships membership
      on membership.organization_id = organization
     and membership.user_id = users.id
    left join public.member_chapter_memberships chapter_membership
      on chapter_membership.chapter_id = chapter
     and chapter_membership.user_id = users.id
    where coalesce(users.raw_app_meta_data ->> 'sample_persona', '')
      in ('member', 'steward', 'coordinator', 'advisor', 'admin', 'vp')
    on conflict (lane, run_id, user_id) do nothing;

    update public.member_profiles profile
    set chapter_id = chapter, updated_at = pg_catalog.now()
    from private.demo_seed_analytics_persona_links link
    where link.lane = p_lane and link.run_id = p_run_id
      and profile.id = link.user_id
      and profile.chapter_id is distinct from chapter;

    insert into public.organization_memberships (
      organization_id, user_id, status, created_at, revoked_at
    )
    select organization, link.user_id, 'active', pg_catalog.now(), null
    from private.demo_seed_analytics_persona_links link
    where link.lane = p_lane and link.run_id = p_run_id
    on conflict (organization_id, user_id) do update
      set status = 'active', revoked_at = null;

    insert into public.member_chapter_memberships (
      user_id, chapter_id, status, pinned, last_selected_at, joined_at, revoked_at
    )
    select link.user_id, chapter, 'active', true, pg_catalog.now(),
      current_date, null
    from private.demo_seed_analytics_persona_links link
    where link.lane = p_lane and link.run_id = p_run_id
    on conflict (user_id, chapter_id) do update set
      status = 'active', pinned = true, last_selected_at = excluded.last_selected_at,
      revoked_at = null;

    insert into private.demo_seed_analytics_persona_role_rows (
      lane, run_id, user_id, role
    )
    select p_lane, p_run_id, role.user_id, role.role
    from private.demo_seed_analytics_persona_links link
    join public.member_roles role on role.user_id = link.user_id
    where link.lane = p_lane and link.run_id = p_run_id
      and role.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
      and not exists (
        select 1 from public.organization_role_grants existing
        where existing.organization_id = organization
          and existing.user_id = role.user_id
          and existing.role = role.role
      )
    on conflict do nothing;

    insert into public.organization_role_grants (
      organization_id, user_id, role, granted_by, granted_at
    )
    select organization, owned.user_id, owned.role, actor, pg_catalog.now()
    from private.demo_seed_analytics_persona_role_rows owned
    where owned.lane = p_lane and owned.run_id = p_run_id
    on conflict (organization_id, user_id, role) do nothing;
  end if;

  -- Prefer the primary SAMPLE personas (the active organization members not
  -- owned by either bulk-load ledger), then fill the cohort with lane users.
  -- Six events per person populate the member report card while retaining a
  -- bounded, reversible source prefix.
  delete from public.organization_engagement_events event
  where event.organization_id = organization
    and event.source_id like prefix || ':%';

  with demo_seed_ledger as (
    select ledger.user_id from private.presg_demo_ledger ledger
    where p_lane = 'presg' and ledger.run_id = p_run_id
    union all
    select ledger.user_id from private.uniondemo_ledger ledger
    where p_lane = 'uniondemo' and ledger.run_id = p_run_id
  ), selected_members as (
    select membership.user_id, profile.chapter_id,
      (ledger.user_id is null) as primary_persona,
      pg_catalog.row_number() over (
        order by (ledger.user_id is null) desc, membership.user_id
      ) as ordinal
    from public.organization_memberships membership
    join public.member_profiles profile on profile.id = membership.user_id
    join public.member_chapter_memberships chapter_membership
      on chapter_membership.user_id = profile.id
     and chapter_membership.chapter_id = profile.chapter_id
     and chapter_membership.status = 'active'
    left join demo_seed_ledger ledger on ledger.user_id = membership.user_id
    where membership.organization_id = organization
      and membership.status = 'active'
      and exists (
        select 1 from public.chapters candidate
        where candidate.id = profile.chapter_id
          and candidate.organization_id = organization
      )
    order by (ledger.user_id is null) desc, membership.user_id
    limit 100
  )
  insert into public.organization_engagement_events (
    organization_id, user_id, chapter_id, event_type, source_id, occurred_at
  )
  select organization, member.user_id, member.chapter_id,
    (array[
      'meeting_check_in', 'qa_contribution', 'poll_vote',
      'survey_response', 'event_rsvp', 'authorized_contact'
    ])[event_number],
    prefix || ':' || member.ordinal || ':' || event_number,
    pg_catalog.now() - ((member.ordinal + event_number) || ' hours')::interval
  from selected_members member
  cross join pg_catalog.generate_series(1, 6) event_number
  on conflict (organization_id, user_id, event_type, source_id) do update set
    chapter_id = excluded.chapter_id,
    occurred_at = excluded.occurred_at;

  -- Seed the current rolling window immediately; the daily private refresh
  -- advances it at month boundaries and prunes only ledger-owned expired rows.
  perform private.demo_seed_refresh_analytics_health(p_lane, p_run_id);
  perform private.demo_seed_ensure_analytics_health_rotation();

  -- Thirty organization layouts plus thirty chapter layouts provide two
  -- complete 15-row pages per scope (and four combined studio pages) using
  -- the product's shared layout-page limit. Organization
  -- and chapter scopes make the rows visible to every authorized SAMPLE hat;
  -- personal layouts remain user-owned and are not fabricated for real users.
  insert into public.organization_analytics_layouts (
    id, organization_id, owner_user_id, scope, chapter_id,
    name, spec, created_at, updated_at
  )
  select private.member_stress_uuid(p_run_id::text || ':analytics:layout:' || i),
    organization, actor,
    case when i <= 30 then 'organization' else 'chapter' end,
    case when i <= 30 then null else chapter end,
    case when i <= 30 then 'Organization health view ' else 'Chapter trend view ' end || i,
    case when i <= 30 then pg_catalog.jsonb_build_object(
      'datasetId', 'organization:chapter-health',
      'chartType', (array['bar', 'stacked_bar', 'line', 'area', 'table'])[1 + (i % 5)],
      'title', 'Organization health view ' || i
    ) else pg_catalog.jsonb_build_object(
      'datasetId', 'chapter:' || chapter || ':health-trend',
      'chartType', (array['bar', 'stacked_bar', 'line', 'area', 'table'])[1 + (i % 5)],
      'title', 'Chapter trend view ' || i
    ) end,
    pg_catalog.now() - ((61 - i) || ' days')::interval,
    pg_catalog.now() - ((61 - i) || ' hours')::interval
  from pg_catalog.generate_series(1, 60) i
  on conflict (id) do update set
    organization_id = excluded.organization_id,
    owner_user_id = excluded.owner_user_id,
    scope = excluded.scope,
    chapter_id = excluded.chapter_id,
    name = excluded.name,
    spec = excluded.spec,
    updated_at = excluded.updated_at;

  insert into private.demo_seed_page_evidence (
    lane, run_id, surface, actual_rows
  )
  select p_lane, p_run_id, surface, actual_rows
  from (values
    ('analyticsMemberExplorer',
      (select pg_catalog.count(*)
       from (
         select membership.user_id
         from public.organization_memberships membership
         join public.member_profiles profile on profile.id = membership.user_id
         join public.member_chapter_memberships chapter_membership
           on chapter_membership.user_id = profile.id
          and chapter_membership.chapter_id = profile.chapter_id
          and chapter_membership.status = 'active'
         join public.chapters candidate
           on candidate.id = profile.chapter_id
          and candidate.organization_id = organization
         where membership.organization_id = organization
           and membership.status = 'active'
         limit 100
       ) explorer)),
    ('analyticsOrganizationLayouts',
      (select pg_catalog.count(*)
       from public.organization_analytics_layouts layout
       where layout.organization_id = organization
         and layout.owner_user_id = actor
         and layout.scope = 'organization'
         and layout.chapter_id is null
         and layout.spec ->> 'datasetId' = 'organization:chapter-health'
         and layout.id in (
           select private.member_stress_uuid(
             p_run_id::text || ':analytics:layout:' || series.i
           ) from pg_catalog.generate_series(1, 30) series(i)
         ))),
    ('analyticsChapterLayouts',
    (select pg_catalog.count(*)
     from public.organization_analytics_layouts layout
     where layout.organization_id = organization
       and layout.owner_user_id = actor
       and layout.scope = 'chapter'
       and layout.chapter_id = chapter
       and layout.spec ->> 'datasetId' = 'chapter:' || chapter || ':health-trend'
       and layout.id in (
       select private.member_stress_uuid(
         p_run_id::text || ':analytics:layout:' || series.i
       ) from pg_catalog.generate_series(31, 60) series(i)
     )))
  ) seeded_pages(surface, actual_rows)
  on conflict (lane, run_id, surface) do update set
    actual_rows = excluded.actual_rows;

  verification := private.demo_seed_analytics_status(p_lane, p_run_id);
  if not coalesce((verification ->> 'ok')::boolean, false) then
    raise exception 'analytics seed verification failed'
      using detail = verification::text;
  end if;
  return verification;
end;
$function$;

create function private.demo_seed_remove_analytics(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run private.demo_seed_analytics_runs%rowtype;
  removed_layouts bigint := 0;
  removed_events bigint := 0;
  removed_health bigint := 0;
  restored_personas bigint := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  select * into run from private.demo_seed_analytics_runs
  where lane = p_lane and run_id = p_run_id;
  if not found then
    return pg_catalog.jsonb_build_object('removed', true, 'layouts', 0, 'reportCardEvents', 0);
  end if;

  delete from public.organization_analytics_layouts layout
  where layout.organization_id = run.organization_id
    and layout.id in (
      select private.member_stress_uuid(
        p_run_id::text || ':analytics:layout:' || series.i
      ) from pg_catalog.generate_series(1, 60) series(i)
    );
  get diagnostics removed_layouts = row_count;

  delete from public.organization_engagement_events event
  where event.organization_id = run.organization_id
    and event.source_id like run.source_prefix || ':%';
  get diagnostics removed_events = row_count;

  delete from public.chapter_health_snapshots snapshot
  using private.demo_seed_analytics_health_rows owned
  where owned.lane = p_lane and owned.run_id = p_run_id
    and snapshot.id = owned.snapshot_id;
  get diagnostics removed_health = row_count;

  delete from public.organization_role_grants role_grant
  using private.demo_seed_analytics_persona_role_rows owned
  where owned.lane = p_lane and owned.run_id = p_run_id
    and role_grant.organization_id = run.organization_id
    and role_grant.user_id = owned.user_id
    and role_grant.role = owned.role;

  update public.member_profiles profile
  set chapter_id = link.previous_profile_chapter_id,
      updated_at = link.previous_profile_updated_at
  from private.demo_seed_analytics_persona_links link
  where link.lane = p_lane and link.run_id = p_run_id
    and profile.id = link.user_id;
  get diagnostics restored_personas = row_count;

  delete from public.member_chapter_memberships membership
  using private.demo_seed_analytics_persona_links link
  where link.lane = p_lane and link.run_id = p_run_id
    and not link.chapter_membership_existed
    and membership.user_id = link.user_id
    and membership.chapter_id = run.chapter_id;

  update public.member_chapter_memberships membership
  set status = link.previous_chapter_membership_status,
      revoked_at = link.previous_chapter_revoked_at,
      pinned = link.previous_chapter_pinned,
      last_selected_at = link.previous_chapter_last_selected_at,
      joined_at = link.previous_chapter_joined_at
  from private.demo_seed_analytics_persona_links link
  where link.lane = p_lane and link.run_id = p_run_id
    and link.chapter_membership_existed
    and membership.user_id = link.user_id
    and membership.chapter_id = run.chapter_id;

  delete from public.organization_memberships membership
  using private.demo_seed_analytics_persona_links link
  where link.lane = p_lane and link.run_id = p_run_id
    and not link.organization_membership_existed
    and membership.organization_id = run.organization_id
    and membership.user_id = link.user_id;

  update public.organization_memberships membership
  set status = link.previous_organization_membership_status,
      revoked_at = link.previous_organization_revoked_at
  from private.demo_seed_analytics_persona_links link
  where link.lane = p_lane and link.run_id = p_run_id
    and link.organization_membership_existed
    and membership.organization_id = run.organization_id
    and membership.user_id = link.user_id;

  delete from private.demo_seed_page_evidence
  where lane = p_lane and run_id = p_run_id
    and surface in (
      'analyticsMemberExplorer',
      'analyticsOrganizationLayouts',
      'analyticsChapterLayouts'
    );
  delete from private.demo_seed_analytics_health_rows
  where lane = p_lane and run_id = p_run_id;
  delete from private.demo_seed_analytics_persona_role_rows
  where lane = p_lane and run_id = p_run_id;
  delete from private.demo_seed_analytics_persona_links
  where lane = p_lane and run_id = p_run_id;
  delete from private.demo_seed_analytics_runs
  where lane = p_lane and run_id = p_run_id;
  perform private.demo_seed_drop_analytics_health_rotation();

  return pg_catalog.jsonb_build_object(
    'removed', true, 'layouts', removed_layouts,
    'reportCardEvents', removed_events, 'healthSnapshots', removed_health,
    'restoredSamplePersonas', restored_personas
  );
end;
$function$;

create function private.demo_seed_analytics_after_page_evidence_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
begin
  if pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from inserted_page_evidence evidence
    where evidence.surface not in (
      'analyticsMemberExplorer',
      'analyticsOrganizationLayouts',
      'analyticsChapterLayouts'
    )
  loop
    perform private.demo_seed_apply_analytics(seeded_run.lane, seeded_run.run_id);
  end loop;
  return null;
end;
$function$;

create function private.demo_seed_analytics_after_evidence_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seeded_run record;
begin
  for seeded_run in
    select distinct evidence.lane, evidence.run_id
    from deleted_function_evidence evidence
    where evidence.function_id between 'CR-040' and 'CR-044'
  loop
    perform private.demo_seed_remove_analytics(seeded_run.lane, seeded_run.run_id);
  end loop;
  return null;
end;
$function$;

create trigger demo_seed_analytics_after_page_evidence_insert
after insert on private.demo_seed_page_evidence
referencing new table as inserted_page_evidence
for each statement execute function private.demo_seed_analytics_after_page_evidence_insert();

create trigger demo_seed_analytics_after_evidence_delete
after delete on private.demo_seed_function_evidence
referencing old table as deleted_function_evidence
for each statement execute function private.demo_seed_analytics_after_evidence_delete();

revoke all on function private.demo_seed_analytics_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_refresh_analytics_health(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_rotate_analytics_health()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_ensure_analytics_health_rotation()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_drop_analytics_health_rotation()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_apply_analytics(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_analytics(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_analytics_after_page_evidence_insert()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_analytics_after_evidence_delete()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_archive_organization_on_remove()
  from public, anon, authenticated, service_role;
