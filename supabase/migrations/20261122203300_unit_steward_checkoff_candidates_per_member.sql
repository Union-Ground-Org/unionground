-- SEC-UG-UNIT-STEWARD-CHECKOFF-AND-AUTOMATION-SCOPE-20261120 (#9307).
-- Chapter collaboration does not authorize another unit's member names/ids.
-- Broad chapter/organization staff retain the existing chapter roster, including
-- secondary chapter memberships. Scoped staff use the canonical per-member rule.
-- Candidates/payload/getter: 20261003053000; creator: 20261103183000.
-- Preserve the creator's PIN, graph lock and learning journal; no new grants.
begin;
set local search_path = pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $guard$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.list_task_checkoff_candidates(uuid)')
      and pg_catalog.md5(p.prosrc) = 'f5c6c5626917f51f92e079139e46bae3'
      and p.prosecdef and p.provolatile = 's'
      and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'unreviewed public.list_task_checkoff_candidates predecessor' using errcode = '55000';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.task_checkoff_payload(uuid,uuid)')
      and pg_catalog.md5(p.prosrc) = '3661ddb861457c01e6b2d456fb54fd27'
      and p.prosecdef and p.provolatile = 's'
      and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'unreviewed private.task_checkoff_payload predecessor' using errcode = '55000';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.get_task_checkoff_list(uuid)')
      and pg_catalog.md5(p.prosrc) = 'c3b5095f4d8af81dc1db2c241772cedf'
      and p.prosecdef and p.provolatile = 's'
      and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'unreviewed public.get_task_checkoff_list predecessor' using errcode = '55000';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.create_task_checkoff_list(uuid,text,uuid[],uuid[],jsonb)')
      and pg_catalog.md5(p.prosrc) = '2001f8cad6f63d029a644d9492c95501'
      and p.prosecdef and p.provolatile = 'v'
      and p.proconfig = array['search_path=""']::text[]
  ) then
    raise exception 'unreviewed public.create_task_checkoff_list predecessor' using errcode = '55000';
  end if;
  if pg_catalog.to_regprocedure('private.task_checkoff_actor_can_see_member(uuid,text,uuid)') is not null then
    raise exception 'unreviewed private.task_checkoff_actor_can_see_member already exists' using errcode = '55000';
  end if;
end;
$guard$;

create function private.task_checkoff_actor_can_see_member(p_actor uuid, p_chapter text, p_member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_actor is not null and p_member is not null
    and private.actor_has_chapter_staff_role(p_actor, p_chapter)
    and exists (
      select 1 from public.chapters chapter
      join public.organizations organization on organization.id = chapter.organization_id and organization.status = 'active'
      join public.organization_memberships member_org
        on member_org.organization_id = chapter.organization_id and member_org.user_id = p_member and member_org.status = 'active'
      join public.member_chapter_memberships member_chapter
        on member_chapter.chapter_id = chapter.id and member_chapter.user_id = p_member and member_chapter.status = 'active'
      left join public.member_profiles target_profile on target_profile.id = p_member
      left join public.chapters target_context on target_context.id = target_profile.chapter_id
      where chapter.id = p_chapter
        and (
          p_actor = p_member
          -- Broad task-chapter staff retain the original whole roster, even
          -- for members whose selected chapter currently differs.
          or exists (
            select 1 from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) held(role)
            where private.actor_role_covers_member(p_actor, p_chapter, held.role, null, false)
          )
          -- Otherwise mirror the member oracle's selected-organization and
          -- broad selected-chapter / explicit assignment arms for this actor.
          or (target_context.organization_id = chapter.organization_id and (
            exists (
              select 1 from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) held(role)
              where private.actor_role_covers_member(p_actor, target_context.id, held.role, null, false)
            )
            -- The actor's private.chapter_scoped_member_ids arm, scope for
            -- scope: carry-over coverage admits every active member of its
            -- chapter; unit and committee scopes admit their members.
            or exists (
              select 1 from private.steward_assignment_scopes(p_actor, null) assignment
              join public.chapters scope_chapter on scope_chapter.id = assignment.chapter_id
                and scope_chapter.organization_id = chapter.organization_id
              join public.organization_memberships actor_org on actor_org.user_id = p_actor
                and actor_org.organization_id = scope_chapter.organization_id and actor_org.status = 'active'
              join public.member_chapter_memberships scope_member on scope_member.user_id = p_member
                and scope_member.chapter_id = assignment.chapter_id and scope_member.status = 'active'
              where assignment.role = any(array['steward','coordinator','advisor','admin','vp'])
                and (exists (select 1 from public.member_chapter_memberships actor_chapter
                    where actor_chapter.user_id = p_actor and actor_chapter.chapter_id = assignment.chapter_id
                      and actor_chapter.status = 'active')
                  or (assignment.role = 'steward' and exists (select 1 from public.organization_role_grants grant_row
                    where grant_row.organization_id = scope_chapter.organization_id and grant_row.user_id = p_actor
                      and grant_row.role = 'steward')))
                and (not private.staff_mfa_required(scope_chapter.organization_id) or private.has_second_factor(p_actor))
                and (assignment.legacy_chapter_coverage
                  or (assignment.unit_id is not null
                    and p_member in (select private.chapter_unit_member_ids(assignment.unit_id, assignment.chapter_id)))
                  or (assignment.committee_id is not null and exists (
                    select 1 from private.chapter_committees committee
                    join private.chapter_committee_members committee_member on committee_member.committee_id = committee.id
                      and committee_member.chapter_id = committee.chapter_id
                    where committee.id = assignment.committee_id and committee.chapter_id = assignment.chapter_id
                      and committee_member.user_id = p_member
                      and committee.starts_on <= (select private.eastern_day()) -- fixed-zone: committee windows stay on New York's day, as private.chapter_scoped_member_ids does, until part 5 of #9446 moves them
                      and (committee.ends_on is null or committee.ends_on >= (select private.eastern_day()))))) -- fixed-zone: committee windows stay on New York's day, as private.chapter_scoped_member_ids does, until part 5 of #9446 moves them
            )
          ))
        )
    );
$function$;
revoke all on function private.task_checkoff_actor_can_see_member(uuid,text,uuid)
  from public, anon, authenticated, service_role;

create or replace function public.list_task_checkoff_candidates(p_task_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  scope record;
  broad_roster boolean;
  visible_members uuid[];
begin
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  broad_roster := private.member_has_chapter_role(scope.chapter_id, array['steward','coordinator','advisor','admin','vp'])
    or private.chapter_organization_role_allowed(scope.chapter_id, array['steward','coordinator','advisor','admin','vp']);
  if not broad_roster then
    -- Enumerate the canonical set of every staff role before ordering/capping:
    -- the same five-role union plus self that the payload and creator use, so
    -- a member visible through a role held in another chapter (or through an
    -- organization steward grant) stays selectable. task_checkoff_scope above
    -- already requires a staff role in the task chapter.
    select coalesce(pg_catalog.array_agg(distinct member_id), array[]::uuid[]) into visible_members
    from (
      select (select auth.uid()) as member_id
      union
      select private.staff_visible_member_ids(held.role)
      from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) held(role)
    ) admitted;
  end if;
  return pg_catalog.jsonb_build_object('members', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', roster.user_id, 'name', roster.full_name, 'steward', roster.steward
    ) order by roster.full_name, roster.user_id)
    from (
      select cm.user_id, coalesce(p.full_name, '') as full_name,
        private.actor_has_chapter_staff_role(cm.user_id, scope.chapter_id) as steward
      from public.member_chapter_memberships cm
      join public.organization_memberships om
        on om.user_id = cm.user_id and om.organization_id = scope.organization_id and om.status = 'active'
      left join public.member_profiles p on p.id = cm.user_id
      where cm.chapter_id = scope.chapter_id and cm.status = 'active'
      and (
        broad_roster
        or cm.user_id = any(visible_members)
      )
      order by coalesce(p.full_name, ''), cm.user_id
      limit 500
    ) roster
  ), '[]'::jsonb));
end;
$function$;

create or replace function private.task_checkoff_payload(p_task_id uuid, p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  -- The same set-based visibility used by member_profiles: evaluate each
  -- staff role once, union self, and use a semijoin so overlapping units
  -- never duplicate entries. Broad task-chapter staff skip the set entirely.
  with access_scope as materialized (
    select not private.caller_unit_limited_in_chapter(access_scope.chapter_id)
      and (private.member_has_chapter_role(access_scope.chapter_id, array['steward','coordinator','advisor','admin','vp'])
        or private.chapter_organization_role_allowed(access_scope.chapter_id, array['steward','coordinator','advisor','admin','vp'])) as broad_roster
    from private.task_checkoff_lists access_scope where access_scope.task_id = p_task_id
  ), visible_members as materialized (
    select (select auth.uid()) as member_id from access_scope where not broad_roster
    union
    select private.staff_visible_member_ids(readable_role)
    from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role
    cross join access_scope where not broad_roster
  )
  select case when l.task_id is null then pg_catalog.jsonb_build_object(
      'enabled', true, 'list', null
    ) else pg_catalog.jsonb_build_object(
      'enabled', true,
      'list', pg_catalog.jsonb_build_object(
        'taskId', l.task_id,
        'mode', l.assignment_mode,
        'status', l.status,
        'createdBy', l.created_by,
        'createdAt', l.created_at,
        'canManage', (coalesce(l.created_by = (select auth.uid()), false)
          or coalesce(private.has_organization_role(p_organization_id, array['admin', 'vp']), false)),
        'entries', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', e.id,
            'memberUserId', e.member_user_id,
            'memberName', coalesce(member.full_name, ''),
            'assignedStewardId', e.assigned_steward_id,
            'assignedStewardName', steward.full_name,
            'status', e.status,
            'note', e.note,
            'actionedBy', e.actioned_by,
            'actionedByName', actor.full_name,
            'actionedAt', e.actioned_at
          ) order by e.position, e.id)
          from private.task_checkoff_entries e
          left join public.member_profiles member on member.id = e.member_user_id
          left join public.member_profiles steward on steward.id = e.assigned_steward_id
          left join public.member_profiles actor on actor.id = e.actioned_by
          where e.task_id = l.task_id
            and (
              (select broad_roster from access_scope)
              or e.member_user_id in (select member_id from visible_members)
            )
        ), '[]'::jsonb)
      )
    ) end
  from (select p_task_id as task_id) requested
  left join private.task_checkoff_lists l on l.task_id = requested.task_id;
$function$;

create or replace function public.create_task_checkoff_list(
  p_task_id uuid,
  p_mode text,
  p_member_ids uuid[],
  p_steward_ids uuid[],
  p_manual jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  learning_parent uuid;
  caller uuid;
  scope record;
  members uuid[];
  stewards uuid[];
  steward_count integer;
  bad_id uuid;
  member_scope_limited boolean;
  assignments jsonb;
  caller_visible_members uuid[];
  steward_eligible jsonb;
  unrestricted_stewards uuid[];
  assignment_counts integer[];
  next_member uuid;
  next_steward uuid;
  next_slot integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  perform private.member_pin_require_full_session();
caller := (select auth.uid());
  if not private.mfa_satisfied() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into scope from private.task_checkoff_scope(p_task_id);
  if not found then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(scope.organization_id, 'features.tasks.coop_checkoff_lists') then
    raise exception 'member check-off lists are turned off' using errcode = '55000';
  end if;
  if p_mode is null or p_mode not in ('manual', 'split_even', 'split_random', 'shared') then
    raise exception 'invalid check-off mode' using errcode = '22023';
  end if;
  assignments := '{}'::jsonb;
  -- First occurrence wins, order kept (the even split is order-preserving).
  select coalesce(pg_catalog.array_agg(item.id order by item.first_at), array[]::uuid[])
    into members
  from (
    select ids.id, pg_catalog.min(ids.ordinality) as first_at
    from pg_catalog.unnest(coalesce(p_member_ids, array[]::uuid[])) with ordinality as ids(id, ordinality)
    where ids.id is not null
    group by ids.id
  ) item;
  select coalesce(pg_catalog.array_agg(item.id order by item.first_at), array[]::uuid[])
    into stewards
  from (
    select ids.id, pg_catalog.min(ids.ordinality) as first_at
    from pg_catalog.unnest(coalesce(p_steward_ids, array[]::uuid[])) with ordinality as ids(id, ordinality)
    where ids.id is not null
    group by ids.id
  ) item;
  if pg_catalog.cardinality(members) not between 1 and 500 then
    raise exception 'pick between 1 and 500 members' using errcode = '22023';
  end if;
  if pg_catalog.cardinality(stewards) > 50 then
    raise exception 'pick at most 50 stewards' using errcode = '22023';
  end if;
  -- Raw organization steward authority is not chapter-wide member access.
  member_scope_limited := private.caller_unit_limited_in_chapter(scope.chapter_id)
    or not (private.member_has_chapter_role(scope.chapter_id, array['steward','coordinator','advisor','admin','vp'])
      or private.chapter_organization_role_allowed(scope.chapter_id, array['steward','coordinator','advisor','admin','vp']));
  if member_scope_limited then
    select coalesce(pg_catalog.array_agg(distinct member_id), array[]::uuid[]) into caller_visible_members
    from (
      select caller as member_id
      union
      select private.staff_visible_member_ids(readable_role)
      from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role
    ) admitted;
  end if;
  select ids.id into bad_id
  from pg_catalog.unnest(members) as ids(id)
  where not exists (
    select 1
    from public.member_chapter_memberships cm
    join public.organization_memberships om
      on om.user_id = cm.user_id and om.organization_id = scope.organization_id and om.status = 'active'
    where cm.user_id = ids.id and cm.chapter_id = scope.chapter_id and cm.status = 'active'
      and (not member_scope_limited or cm.user_id = any(caller_visible_members))
  )
  limit 1;
  if bad_id is not null then
    if member_scope_limited then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    raise exception 'one or more members are not active in this chapter' using errcode = '22023';
  end if;
  if p_mode = 'manual' then
    if p_manual is null or pg_catalog.jsonb_typeof(p_manual) <> 'object' then
      raise exception 'every member needs a steward in manual mode' using errcode = '22023';
    end if;
    select pg_catalog.array_agg(distinct (p_manual ->> ids.id::text)::uuid)
      into stewards
    from pg_catalog.unnest(members) as ids(id)
    where coalesce(p_manual ->> ids.id::text, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    if exists (
      select 1 from pg_catalog.unnest(members) as ids(id)
      where coalesce(p_manual ->> ids.id::text, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      raise exception 'every member needs a steward in manual mode' using errcode = '22023';
    end if;
    stewards := coalesce(stewards, array[]::uuid[]);
  elsif p_mode in ('split_even', 'split_random') then
    if pg_catalog.cardinality(stewards) = 0 then
      raise exception 'pick at least one steward to split the list across' using errcode = '22023';
    end if;
  else
    stewards := array[]::uuid[];
  end if;
  select ids.id into bad_id
  from pg_catalog.unnest(stewards) as ids(id)
  where not private.actor_has_chapter_staff_role(ids.id, scope.chapter_id)
  limit 1;
  if bad_id is not null then
    raise exception 'one or more stewards do not hold a staff role in this chapter' using errcode = '22023';
  end if;

  -- Decide every assignment before any list, entry, activity or journal write.
  -- Chapter-wide stewards retain the original round-robin distribution. For
  -- scoped stewards choose the least-loaded eligible actor; random mode only
  -- changes member order, never a steward's authority.
  steward_count := pg_catalog.cardinality(stewards);
  if p_mode <> 'shared' then
    select coalesce(pg_catalog.array_agg(candidate.id), array[]::uuid[])
      into unrestricted_stewards
    from pg_catalog.unnest(stewards) candidate(id)
    where exists (
      select 1 from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) held(role)
      where private.actor_role_covers_member(candidate.id, scope.chapter_id, held.role, null, false)
    );
    -- Build each scoped assignee's member set once: the assignee's own
    -- canonical staff_visible_member_ids arms (selected-chapter roles, then
    -- every same-organization scope, carry-over included) plus self. Tests
    -- compare it with that canonical set and the scalar actor helper; no
    -- authorization query runs in a loop.
    with scoped_actors as materialized (
      select id from pg_catalog.unnest(stewards) selected(id)
      where not (id = any(unrestricted_stewards))
    ), targets as materialized (
      select ids.id, p.chapter_id, c.organization_id
      from pg_catalog.unnest(members) ids(id)
      left join public.member_profiles p on p.id = ids.id
      left join public.chapters c on c.id = p.chapter_id
    ), selected_chapters as materialized (
      select distinct chapter_id from targets where organization_id = scope.organization_id
    ), broad_selected as materialized (
      select actor.id, selected.chapter_id
      from scoped_actors actor cross join selected_chapters selected
      where exists (
        select 1 from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) held(role)
        where private.actor_role_covers_member(actor.id, selected.chapter_id, held.role, null, false)
      )
    ), eligible_scopes as materialized (
      select actor.id as actor_id, assignment.*
      from scoped_actors actor
      cross join lateral private.steward_assignment_scopes(actor.id, null) assignment
      join public.chapters scope_chapter on scope_chapter.id = assignment.chapter_id
        and scope_chapter.organization_id = scope.organization_id
      join public.organizations organization on organization.id = scope_chapter.organization_id and organization.status = 'active'
      join public.organization_memberships actor_org on actor_org.user_id = actor.id
        and actor_org.organization_id = scope_chapter.organization_id and actor_org.status = 'active'
      -- The canonical chapter_scoped_member_ids scope gate, for this actor.
      where assignment.role = any(array['steward','coordinator','advisor','admin','vp'])
        and (not private.staff_mfa_required(scope_chapter.organization_id) or private.has_second_factor(actor.id))
        and (
          exists (select 1 from public.member_chapter_memberships actor_chapter
            where actor_chapter.user_id = actor.id and actor_chapter.chapter_id = assignment.chapter_id
              and actor_chapter.status = 'active')
          or (assignment.role = 'steward' and exists (select 1 from public.organization_role_grants grant_row
            where grant_row.user_id = actor.id and grant_row.organization_id = scope_chapter.organization_id
              and grant_row.role = 'steward'))
        )
    ), scope_members as (
      -- Carry-over coverage admits every active member of its chapter.
      select assignment.actor_id, assignment.chapter_id, membership.user_id as member_id
      from eligible_scopes assignment
      join public.member_chapter_memberships membership on membership.chapter_id = assignment.chapter_id
        and membership.status = 'active'
      where assignment.legacy_chapter_coverage
      union
      select assignment.actor_id, assignment.chapter_id, member.member_id
      from eligible_scopes assignment
      cross join lateral private.chapter_unit_member_ids(assignment.unit_id, assignment.chapter_id) member(member_id)
      where assignment.unit_id is not null
      union
      select assignment.actor_id, assignment.chapter_id, member.user_id
      from eligible_scopes assignment
      join private.chapter_committees committee on committee.id = assignment.committee_id
        and committee.chapter_id = assignment.chapter_id
        and committee.starts_on <= (select private.eastern_day()) -- fixed-zone: committee windows stay on New York's day, as private.chapter_scoped_member_ids does, until part 5 of #9446 moves them
        and (committee.ends_on is null or committee.ends_on >= (select private.eastern_day())) -- fixed-zone: committee windows stay on New York's day, as private.chapter_scoped_member_ids does, until part 5 of #9446 moves them
      join private.chapter_committee_members member on member.committee_id = committee.id and member.chapter_id = committee.chapter_id
    ), covered as materialized (
      select distinct member.actor_id, member.member_id
      from scope_members member
      join public.member_chapter_memberships target_chapter on target_chapter.user_id = member.member_id
        and target_chapter.chapter_id = member.chapter_id and target_chapter.status = 'active'
      join public.organization_memberships target_org on target_org.user_id = member.member_id
        and target_org.organization_id = scope.organization_id and target_org.status = 'active'
    )
    select coalesce(pg_catalog.jsonb_object_agg(actor.id::text || ':' || target.id::text, true), '{}'::jsonb)
      into steward_eligible
    from scoped_actors actor cross join targets target
    where actor.id = target.id or (target.organization_id = scope.organization_id and (
      exists (select 1 from broad_selected broad where broad.id = actor.id and broad.chapter_id = target.chapter_id)
      or exists (select 1 from covered where covered.actor_id = actor.id and covered.member_id = target.id)
    ));
    if p_mode = 'manual' then
      assignments := p_manual;
      foreach next_member in array members loop
        next_steward := (assignments ->> next_member::text)::uuid;
        if not (case when next_steward = any(unrestricted_stewards) then true
          else steward_eligible ? (next_steward::text || ':' || next_member::text) end) then
          raise exception 'checkoff:assignment_scope: A selected steward cannot see the assigned member.' using errcode = '22023';
        end if;
      end loop;
    else
      if p_mode = 'split_random' then
        select pg_catalog.array_agg(member_id order by pg_catalog.random())
          into members from pg_catalog.unnest(members) member_id;
      end if;
      assignment_counts := pg_catalog.array_fill(0, array[steward_count]);
      foreach next_member in array members loop
        select candidate.id, candidate.position::integer into next_steward, next_slot
        from pg_catalog.unnest(stewards) with ordinality candidate(id, position)
        where case when candidate.id = any(unrestricted_stewards) then true
          else steward_eligible ? (candidate.id::text || ':' || next_member::text) end
        order by assignment_counts[candidate.position::integer], candidate.position
        limit 1;
        if not found then
          raise exception 'checkoff:assignment_scope: No selected steward can see this member.' using errcode = '22023';
        end if;
        assignments := pg_catalog.jsonb_set(assignments, array[next_member::text], pg_catalog.to_jsonb(next_steward));
        assignment_counts[next_slot] := assignment_counts[next_slot] + 1;
      end loop;
    end if;
  end if;

  insert into private.task_checkoff_lists (task_id, organization_id, chapter_id, assignment_mode, created_by)
  values (p_task_id, scope.organization_id, scope.chapter_id, p_mode, caller)
  on conflict (task_id) do nothing;
  if not found then
    raise exception 'this task already has a check-off list' using errcode = '23505';
  end if;

  insert into private.task_checkoff_entries (task_id, member_user_id, assigned_steward_id, position)
  select p_task_id, ordered.id,
    case when p_mode = 'shared' then null else (assignments ->> ordered.id::text)::uuid end,
    ordered.position::integer - 1
  from pg_catalog.unnest(members) with ordinality ordered(id, position);

  insert into public.chapter_task_activity (task_id, chapter_id, actor_id, action, from_value, to_value)
  values (p_task_id, scope.chapter_id, caller, 'checkoff_list_created', null, p_mode);

  learning_parent := private.learning_checkoff_journal('task_checkoff_create', 'private.task_checkoff_lists', p_task_id::text, null);
  -- Each member the list created is a child of that one entry.
  perform private.learning_journal_append('task_checkoff_entry_create', 'private.task_checkoff_entries', e.id::text, learning_parent,
    private.learning_fingerprint(private.learning_task_checkoff_state('private.task_checkoff_entries', e.id::text) - 'actioned_at'), null, '{}'::jsonb)
  from private.task_checkoff_entries e where e.task_id = p_task_id order by e.id;
  return private.task_checkoff_payload(p_task_id, scope.organization_id);
end;
$function$;

commit;
