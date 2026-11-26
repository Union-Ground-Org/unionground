-- SEC-UG-NON-INTERFERENCE-FIRST-RUN-FINDINGS-20261111 (#8337), items 1
-- and 3 (item 2, the shared civic and chapter-binding rows, is #8322).
--
-- Item 1.
--
-- The restrictive read policies of organization_automation_definitions,
-- organization_automation_runs and organization_automation_effects call
-- private.automation_v2_reference_visible on every row. It began by calling
-- private.cr108_require_operator(), which raises 'organization automation
-- operator required' for anyone who is not an admin or vp of their
-- organization. A plain member or a steward reading one of those tables got
-- zero rows while no organization had automation rows, and that error once
-- any organization had one, so the read told them whether automation rows
-- exist anywhere (found by the leak guard of #8323).
--
-- The helper now answers false for such a caller, never the refusal. For an
-- operator of the row's own organization nothing changes: the same checks
-- (signed in, MFA, the caller's organization, the admin or vp role) decide,
-- and the source-visibility rule after them is unchanged. The governed RPCs
-- that use it already require an operator before they get here.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function private.automation_v2_reference_visible(p_organization_id uuid,p_reference jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare org uuid; kind text; source_id text;
begin
 -- Only an operator of the row's own organization sees it; anyone else gets
 -- false, so a read never tells whether another organization has rows.
 if (select auth.uid()) is null or not private.mfa_satisfied() then return false; end if;
 org:=private.current_member_organization();
 if org is null or org is distinct from p_organization_id
    or not private.has_organization_role(org, array['admin', 'vp']) then
 return false;
 end if;
 source_id:=coalesce(p_reference#>>'{conditions,sourceId}',p_reference->>'sourceId');
 if source_id is null then return true; end if;
 kind:=p_reference->>'sourceKind';
 if p_reference ? 'triggerKind' then
 kind:=case when p_reference->>'triggerKind' in ('case_deadline','unassigned_case','casework_deadline','incomplete_case_checklist') then 'case'
 when p_reference->>'triggerKind' like 'appointment_%' then 'appointment'
 when p_reference->>'triggerKind' like 'event_%' then 'event' else 'task' end;
 end if;
 return private.automation_v2_source_visible(auth.uid(),org,kind,source_id);
end; $$;
revoke all on function private.automation_v2_reference_visible(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function private.automation_v2_reference_visible(uuid,jsonb) to authenticated;

-- Item 3. A steward limited to some units of a chapter (a
-- private.chapter_role_scopes row, and no chapter-wide or organization staff
-- role) follows the member-data rule of #8054 (20261111184200): it sees a
-- member only when public.staff_can_see_user allows it for one of its roles.
-- For such a caller the chapter's task
-- assignee list follows that rule; the workload view counts only the cases of
-- members it may see and lists itself, the chapter-wide stewards and the
-- stewards whose unit or committee scope overlaps its own. Chapter-wide
-- stewards, staff and plain members keep the chapter view as before. The workload
-- view's weekly trends stay chapter aggregates (shown only when at least 25
-- members logged that week).

create or replace function private.caller_unit_limited_in_chapter(p_chapter text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
      select 1 from private.chapter_role_scopes scope
      where scope.user_id = (select auth.uid()) and scope.chapter_id = p_chapter)
    and not private.member_has_chapter_role(p_chapter, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
    and not coalesce(private.has_organization_role(
      (select chapter.organization_id from public.chapters chapter where chapter.id = p_chapter),
      array['steward', 'coordinator', 'advisor', 'admin', 'vp']), false);
$function$;
revoke all on function private.caller_unit_limited_in_chapter(text) from public, anon, authenticated, service_role;

create or replace function private.caller_may_see_member(p_member uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select p_member is not null and (
    p_member = (select auth.uid())
    or exists (
      select 1 from pg_catalog.unnest(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) as staff_role(role)
      where public.staff_can_see_user(p_member, staff_role.role)));
$function$;
revoke all on function private.caller_may_see_member(uuid) from public, anon, authenticated, service_role;

create or replace function private.workload_rebalancing(p_chapter text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with chapter_scope as materialized (
    select c.organization_id, private.caller_unit_limited_in_chapter(p_chapter) as unit_limited
    from public.chapters c
    where c.id = p_chapter
  ), steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    cross join chapter_scope
    where p.chapter_id = p_chapter
      -- A steward limited to some units sees itself, the chapter-wide and
      -- organization-wide stewards and the stewards whose unit or committee
      -- scope overlaps its own. An
      -- organization-wide staff grant wins over a unit scope left from before
      -- it was granted.
      and (not chapter_scope.unit_limited
        or p.id = (select auth.uid())
        or exists (
          select 1 from public.organization_role_grants broad
          join public.organization_memberships membership
            on membership.user_id = broad.user_id and membership.organization_id = broad.organization_id
           and membership.status = 'active'
          where broad.user_id = p.id and broad.organization_id = chapter_scope.organization_id
            and broad.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
        or not exists (
          select 1 from private.chapter_role_scopes steward_scope
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward')
        or exists (
          select 1 from private.chapter_role_scopes steward_scope
          join private.chapter_role_scopes caller_scope
            on caller_scope.user_id = (select auth.uid()) and caller_scope.chapter_id = p_chapter
           and (steward_scope.unit_id = caller_scope.unit_id or steward_scope.committee_id = caller_scope.committee_id)
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward'))
      and (
        (
          chapter_scope.organization_id is not null
          and private.organization_member_roles(
            p.id,
            chapter_scope.organization_id,
            p_chapter
          ) ? 'steward'
        )
        or (
          chapter_scope.organization_id is null
          and exists (
            select 1
            from public.member_roles legacy_role
            where legacy_role.user_id = p.id
              and legacy_role.role = 'steward'
              and (legacy_role.chapter_id is null or legacy_role.chapter_id = p_chapter)
          )
        )
      )
    order by p.full_name, p.id
    limit 50
  ), counts as (
    select s.steward_id, s.full_name,
      pg_catalog.count(c.id)::integer as active,
      pg_catalog.count(c.id) filter (
        where c.deadline between current_date and current_date + 6)::integer as due_soon,
      pg_catalog.count(c.id) filter (where c.deadline < current_date)::integer as overdue
    from steward_roster s
    left join public.member_cases c on c.steward_user_id = s.steward_id
      and c.status = 'active' and c.learning_undone_at is null
      and not private.organization_is_platform(c.organization_id)
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
      -- and counts only the cases of members it may see.
      and (not (select scope.unit_limited from chapter_scope scope) or private.caller_may_see_member(c.user_id))
    group by s.steward_id, s.full_name
  ), mean as (
    select coalesce(pg_catalog.avg(active), 0) as avg_active from counts
  ), ranked_high as (
    select c.*, pg_catalog.row_number() over (order by active desc, overdue desc, steward_id) as rn
    from counts c, mean m where c.active >= pg_catalog.ceil(m.avg_active)::integer + 2
  ), ranked_low as (
    select c.*, pg_catalog.row_number() over (order by active asc, overdue asc, steward_id) as rn
    from counts c, mean m where c.active <= greatest(pg_catalog.floor(m.avg_active)::integer - 1, 0)
  ), suggestions as (
    select h.steward_id as from_id, h.full_name as from_name,
      l.steward_id as to_id, l.full_name as to_name,
      least(greatest((h.active - l.active) / 2, 1), 10)::integer as review_count,
      h.active as from_active, l.active as to_active
    from ranked_high h join ranked_low l using (rn)
    where h.steward_id <> l.steward_id
    order by h.active desc, l.active asc, h.steward_id, l.steward_id
    limit 10
  )
  select pg_catalog.jsonb_build_object(
    'stewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', c.steward_id, 'name', c.full_name, 'activeCases', c.active,
      'dueSoon', c.due_soon, 'overdue', c.overdue) order by c.full_name, c.steward_id) from counts c), '[]'::jsonb),
    'suggestions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fromUserId', s.from_id, 'fromName', s.from_name,
      'toUserId', s.to_id, 'toName', s.to_name,
      'reviewCount', s.review_count, 'fromActiveCases', s.from_active,
      'toActiveCases', s.to_active) order by s.from_active desc, s.from_id) from suggestions s), '[]'::jsonb)
  );
$function$;


create or replace function public.list_chapter_task_assignees()
returns table (
  user_id uuid,
  full_name text,
  initials text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  unit_limited boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id
    into caller_chapter
  from public.member_profiles p
  where p.id = caller;

  if caller_chapter is null then
    raise exception 'member chapter required' using errcode = '42501';
  end if;

  unit_limited := private.caller_unit_limited_in_chapter(caller_chapter);

  return query
  select p.id, p.full_name, p.initials
  from public.member_profiles p
  where p.chapter_id = caller_chapter
    -- A steward limited to some units lists only the members it may see.
    and (not unit_limited or private.caller_may_see_member(p.id))
  order by p.full_name, p.id;
end
$$;

revoke all on function public.list_chapter_task_assignees() from public, anon, authenticated;
grant execute on function public.list_chapter_task_assignees() to authenticated;

notify pgrst, 'reload schema';

commit;
