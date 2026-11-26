-- G4 native staff authorization and portfolio depth repairs.
-- This migration changes no tenant, member, handshake, or health data.

set local lock_timeout = '5s';

-- Handshake notifications follow the current tenant model. Legacy unscoped
-- member_roles rows cannot identify an organization and therefore must never
-- receive a chapter-scoped lifecycle notice.
create or replace function private.notify_handshake_staff(
  p_chapter_id text,
  p_title text,
  p_body text
)
returns void
language sql
security definer
set search_path = ''
as $function$
  insert into public.member_notifications (user_id, title, body, kind)
  select distinct recipients.user_id, p_title, p_body, 'general'
  from (
    select role_chapter.user_id
    from public.member_role_chapters role_chapter
    join public.chapters role_chapter_scope
      on role_chapter_scope.id = role_chapter.chapter_id
    left join public.organizations role_organization
      on role_organization.id = role_chapter_scope.organization_id
    join public.member_chapter_memberships membership
      on membership.user_id = role_chapter.user_id
     and membership.chapter_id = role_chapter.chapter_id
     and membership.status = 'active'
    where role_chapter.chapter_id = p_chapter_id
      and role_chapter.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
      and (
        role_chapter_scope.organization_id is null
        or role_organization.status = 'active'
      )
    union
    select role_grant.user_id
    from public.chapters chapter
    join public.organizations organization
      on organization.id = chapter.organization_id
     and organization.status = 'active'
    join public.organization_role_grants role_grant
      on role_grant.organization_id = chapter.organization_id
     and role_grant.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    join public.organization_memberships organization_membership
      on organization_membership.organization_id = role_grant.organization_id
     and organization_membership.user_id = role_grant.user_id
     and organization_membership.status = 'active'
    where chapter.id = p_chapter_id
  ) recipients;
$function$;

revoke all on function private.notify_handshake_staff(text, text, text)
  from public, anon, authenticated, service_role;

-- A chapter selection remains the strongest tenant signal, including an
-- organization-less legacy chapter. Organization-only staff may not have a
-- chapter membership, so fall back only when no chapter is selected and
-- exactly one active organization membership exists. Multiple organizations
-- fail closed.
create or replace function private.current_mobile_staff_organization()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when private.current_member_chapter() is not null
      then private.current_member_organization()
    else (
      select case when pg_catalog.count(*) = 1
        then pg_catalog.min(candidate.organization_id::text)::uuid
        else null
      end
      from (
        select distinct membership.organization_id
        from public.organization_memberships membership
        join public.organizations organization
          on organization.id = membership.organization_id
         and organization.status = 'active'
        where membership.user_id = (select auth.uid())
          and membership.status = 'active'
      ) candidate
    )
  end;
$function$;

revoke all on function private.current_mobile_staff_organization()
  from public, anon, authenticated, service_role;

-- Native authorization receives the active organization, its exact role
-- grants, and the selected chapter's exact role grants. It never selects among
-- two organizations or two staff hats; both ambiguities remain fail-closed in
-- the client after this server-owned projection.
create or replace function public.get_my_mobile_staff_scope()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  selected_organization_id uuid := private.current_mobile_staff_organization();
  selected_chapter_id text := private.current_member_chapter();
  roles jsonb := '[]'::jsonb;
  chapter_roles jsonb := '[]'::jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authenticated session required' using errcode = '42501';
  end if;
  if (
       (
         selected_organization_id is not null
         and private.staff_mfa_required(selected_organization_id)
       )
       or (
         selected_organization_id is null
         and private.staff_mfa_required()
       )
     )
     and not private.has_second_factor(caller) then
    return pg_catalog.jsonb_build_object(
      'organizationId', selected_organization_id,
      'roles', roles,
      'chapterRoles', chapter_roles,
      'staffAuthorized', false
    );
  end if;
  select coalesce(pg_catalog.jsonb_agg(role_grant.role order by role_grant.role), '[]'::jsonb)
  into roles
  from public.organization_role_grants role_grant
  join public.organization_memberships membership
    on membership.organization_id = role_grant.organization_id
   and membership.user_id = role_grant.user_id
   and membership.status = 'active'
  where role_grant.organization_id = selected_organization_id
    and role_grant.user_id = caller;

  -- Chapter roles remain valid for active legacy chapters that predate the
  -- organization model. For organization-backed chapters, bind the selected
  -- chapter to the same active organization resolved above.
  select coalesce(pg_catalog.jsonb_agg(role_chapter.role order by role_chapter.role), '[]'::jsonb)
  into chapter_roles
  from public.member_role_chapters role_chapter
  join public.member_chapter_memberships membership
    on membership.user_id = role_chapter.user_id
   and membership.chapter_id = role_chapter.chapter_id
   and membership.status = 'active'
  join public.chapters chapter
    on chapter.id = role_chapter.chapter_id
  left join public.organizations organization
    on organization.id = chapter.organization_id
  where role_chapter.user_id = caller
    and role_chapter.chapter_id = selected_chapter_id
    and (
      (chapter.organization_id is null and selected_organization_id is null)
      or (
        chapter.organization_id = selected_organization_id
        and organization.status = 'active'
      )
    );

  return pg_catalog.jsonb_build_object(
    'organizationId', selected_organization_id,
    'roles', roles,
    'chapterRoles', chapter_roles,
    'staffAuthorized', (
      pg_catalog.jsonb_array_length(roles) > 0
      or pg_catalog.jsonb_array_length(chapter_roles) > 0
    )
  );
end;
$function$;

revoke all on function public.get_my_mobile_staff_scope()
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_mobile_staff_scope()
  to authenticated, service_role;

-- One authorization predicate keeps read, write, and portfolio scope aligned:
-- chapter-mapped leadership sees its chapter; organization-wide leadership
-- sees chapters in its current organization without fictional memberships.
create or replace function private.can_manage_chapter_health(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.chapters chapter
    where chapter.id = p_chapter_id
      and (
        private.member_has_chapter_role(chapter.id, array['advisor','admin','vp'])
        or (
          chapter.organization_id is not null
          and chapter.organization_id = private.current_mobile_staff_organization()
          and private.mfa_satisfied()
          and (
            not private.staff_mfa_required(chapter.organization_id)
            or private.has_second_factor((select auth.uid()))
          )
          and exists (
            select 1
            from public.organization_role_grants role_grant
            join public.organization_memberships membership
              on membership.organization_id = role_grant.organization_id
             and membership.user_id = role_grant.user_id
             and membership.status = 'active'
            where role_grant.organization_id = chapter.organization_id
              and role_grant.user_id = (select auth.uid())
              and role_grant.role in ('advisor','admin','vp')
          )
        )
      )
  );
$function$;

revoke all on function private.can_manage_chapter_health(text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_manage_chapter_health(text) to authenticated;

drop policy if exists chapter_health_snapshots_leadership_read on public.chapter_health_snapshots;
create policy chapter_health_snapshots_leadership_read
  on public.chapter_health_snapshots for select to authenticated
  using (private.can_manage_chapter_health(chapter_id));

drop policy if exists chapter_health_coaching_leadership_read on public.chapter_health_coaching;
create policy chapter_health_coaching_leadership_read
  on public.chapter_health_coaching for select to authenticated
  using (private.can_manage_chapter_health(chapter_id));

-- Preserve the original recorder while making the latest same-day correction
-- attributable. The measured date remains the stable trend point.
alter table public.chapter_health_snapshots
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_at timestamptz;

create or replace function public.record_chapter_health_snapshot(
  p_chapter_id text,
  p_measured_on date,
  p_participation integer,
  p_case_timeliness integer,
  p_steward_capacity integer,
  p_training_coverage integer,
  p_communication_reach integer,
  p_governance_readiness integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  members integer;
  calculated integer;
  saved public.chapter_health_snapshots%rowtype;
begin
  if caller is null
     or not private.mfa_satisfied()
     or not private.can_manage_chapter_health(p_chapter_id) then
    raise exception 'leadership role required' using errcode = '42501';
  end if;
  if p_measured_on is null or p_measured_on > current_date
     or p_participation not between 0 and 100 or p_case_timeliness not between 0 and 100
     or p_steward_capacity not between 0 and 100 or p_training_coverage not between 0 and 100
     or p_communication_reach not between 0 and 100 or p_governance_readiness not between 0 and 100 then
    raise exception 'invalid health drivers' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into members
  from public.member_chapter_memberships membership
  where membership.chapter_id = p_chapter_id and membership.status = 'active';
  calculated := pg_catalog.round((p_participation + p_case_timeliness + p_steward_capacity
    + p_training_coverage + p_communication_reach + p_governance_readiness)::numeric / 6)::integer;
  insert into public.chapter_health_snapshots
    (chapter_id, measured_on, member_count, participation, case_timeliness,
     steward_capacity, training_coverage, communication_reach, governance_readiness,
     score, created_by)
  values (p_chapter_id, p_measured_on, members, p_participation, p_case_timeliness,
    p_steward_capacity, p_training_coverage, p_communication_reach, p_governance_readiness,
    calculated, caller)
  on conflict (chapter_id, measured_on) do update
    set member_count = excluded.member_count, participation = excluded.participation,
        case_timeliness = excluded.case_timeliness, steward_capacity = excluded.steward_capacity,
        training_coverage = excluded.training_coverage, communication_reach = excluded.communication_reach,
        governance_readiness = excluded.governance_readiness, score = excluded.score,
        updated_by = caller, updated_at = pg_catalog.clock_timestamp()
  returning * into saved;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

create or replace function public.add_chapter_health_coaching(
  p_chapter_id text,
  p_summary text,
  p_next_action text,
  p_attention_level text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid()); saved public.chapter_health_coaching%rowtype;
begin
  if caller is null
     or not private.mfa_satisfied()
     or not private.can_manage_chapter_health(p_chapter_id) then
    raise exception 'leadership role required' using errcode = '42501';
  end if;
  if p_attention_level not in ('watch','support','urgent','resolved') then
    raise exception 'invalid attention level' using errcode = '22023';
  end if;
  insert into public.chapter_health_coaching
    (chapter_id, author_id, summary, next_action, attention_level)
  values (p_chapter_id, caller, pg_catalog.btrim(p_summary),
    pg_catalog.btrim(coalesce(p_next_action,'')), p_attention_level)
  returning * into saved;
  return pg_catalog.to_jsonb(saved);
end;
$function$;

create or replace function public.get_chapter_health_portfolio()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'chapterId', chapter.id,
    'chapterName', chapter.name,
    'databaseDate', current_date,
    'measuredOn', latest.measured_on,
    'cohortProtected', coalesce(latest.member_count, 0) < 10,
    'memberCount', case when coalesce(latest.member_count, 0) >= 10 then latest.member_count else null end,
    'score', case when coalesce(latest.member_count, 0) >= 10 then latest.score else null end,
    'recordedAt', latest.created_at,
    'recordedBy', case when latest.id is null then null else coalesce(
      nullif(pg_catalog.btrim(snapshot_creator.full_name), ''), 'Former staff member') end,
    'revisedAt', latest.updated_at,
    'revisedBy', case when latest.updated_at is null then null else coalesce(
      nullif(pg_catalog.btrim(snapshot_reviser.full_name), ''), 'Former staff member') end,
    'drivers', case when coalesce(latest.member_count, 0) >= 10 then pg_catalog.jsonb_build_object(
      'participation', latest.participation,
      'caseTimeliness', latest.case_timeliness,
      'stewardCapacity', latest.steward_capacity,
      'trainingCoverage', latest.training_coverage,
      'communicationReach', latest.communication_reach,
      'governanceReadiness', latest.governance_readiness
    ) else null end,
    'trend', case when coalesce(latest.member_count, 0) >= 10 then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'measuredOn', trend.measured_on, 'score', trend.score
      ) order by trend.measured_on)
      from (
        select snapshot.measured_on, snapshot.score
        from public.chapter_health_snapshots snapshot
        where snapshot.chapter_id = chapter.id and snapshot.member_count >= 10
        order by snapshot.measured_on desc limit 12
      ) trend
    ), '[]'::jsonb) else '[]'::jsonb end,
    'coaching', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', coaching.id,
        'summary', coaching.summary,
        'nextAction', coaching.next_action,
        'attentionLevel', coaching.attention_level,
        'createdAt', coaching.created_at,
        'authorName', coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Former staff member')
      ) order by coaching.created_at desc)
      from (
        select * from public.chapter_health_coaching health_coaching
        where health_coaching.chapter_id = chapter.id
        order by health_coaching.created_at desc limit 20
      ) coaching
      left join public.member_profiles profile on profile.id = coaching.author_id
    ), '[]'::jsonb)
  ) order by
      case when coalesce(latest.member_count, 0) >= 10 then latest.score else null end nulls last,
      chapter.name), '[]'::jsonb)
  from public.chapters chapter
  left join lateral (
    select * from public.chapter_health_snapshots snapshot
    where snapshot.chapter_id = chapter.id
    order by snapshot.measured_on desc limit 1
  ) latest on true
  left join public.member_profiles snapshot_creator on snapshot_creator.id = latest.created_by
  left join public.member_profiles snapshot_reviser on snapshot_reviser.id = latest.updated_by
  where private.mfa_satisfied()
    and private.can_manage_chapter_health(chapter.id);
$function$;
