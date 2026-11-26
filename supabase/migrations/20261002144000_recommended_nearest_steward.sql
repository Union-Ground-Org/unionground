-- REQ-UG-RECOMMENDED-AND-NEAREST-STEWARD-20261001 (CR-065 narrowed + nearest steward)
--
-- Restore-everything campaign,. "Find available steward"
-- (src/features/coordination/ui/CoordinationWorkflowPanels.jsx) only ever said
-- "A steward is covered": public.recommend_organization_coverage
-- (20260828232000:1188) chose a steward by override/schedule but returned only
-- an account id the member surface rightly refuses to print, and it had no
-- proximity rule. The pre-clean-room app resolved the nearest steward
-- (de7df4b57c^:lib/dashboard/steward-resolver.ts, cached on grievances by
-- 0222_nearest_steward_on_grievances.sql): same work location, then same
-- department + unit, then same department, then same chapter, then any active
-- steward.
--
-- This re-emits recommend_organization_coverage with the same signature,
-- authorization and override-over-schedule precedence, and:
--   * returns the recommended steward the way the member-safe "Find my
--     steward" roster already does (get_member_chapter_stewards,
--     20260924170200): display name, the conversation route, and email/phone
--     only when that steward opted in (steward_contact_preferences);
--   * with features.casework.nearest_steward_matching on, breaks ties among
--     equally ranked overrides/schedules by proximity to the caller (same work
--     location, then same department, then the chapter), and when no steward is
--     scheduled at that instant recommends the nearest chapter steward instead
--     of "uncovered" (state 'nearest'). The current organization profile has no
--     unit field, so the old department + unit level folds into department.
--   * Proximity reads only the two organization operational profiles
--     (work_location, department) inside this definer; neither value is
--     returned. matchLevel names which rule chose the steward.
--
-- Setting: features.casework.nearest_steward_matching, default true (owner
-- pin for this record; the old resolver always ran, steward-resolver.ts:1-12).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum,
   allowed_values, sort_order, category, member_visible)
values
  -- Old resolver always ran (steward-resolver.ts); pinned default true.
  ('features.casework.nearest_steward_matching', 'boolean', 'Nearest steward matching',
   'Prefer a steward at the member''s work location or department when recommending one, and recommend the nearest steward when none is scheduled.',
   'true', null, null, null, 1600, 'casework', false)
on conflict (key) do nothing;

-- 0 same work location, 1 same department, 2 same chapter (every candidate here
-- already serves the chapter); null when matching is off.
create function private.steward_proximity_rank(p_organization_id uuid, p_member uuid, p_steward uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when m.work_location is not null and s.work_location is not null
      and pg_catalog.lower(pg_catalog.btrim(m.work_location)) = pg_catalog.lower(pg_catalog.btrim(s.work_location)) then 0
    when m.department is not null and s.department is not null
      and pg_catalog.lower(pg_catalog.btrim(m.department)) = pg_catalog.lower(pg_catalog.btrim(s.department)) then 1
    else 2
  end
  from (select 1) one
  left join public.organization_member_operational_profiles m
    on m.organization_id = p_organization_id and m.member_user_id = p_member
  left join public.organization_member_operational_profiles s
    on s.organization_id = p_organization_id and s.member_user_id = p_steward;
$function$;

revoke all on function private.steward_proximity_rank(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.recommend_organization_coverage(
  p_chapter_id text,
  p_at timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  organization uuid := private.current_member_organization();
  nearest boolean;
  chosen record;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if caller is null or organization is null
    or not private.is_organization_member(organization)
    or not exists (
      select 1 from public.chapters c
      where c.id = p_chapter_id and c.organization_id = organization
    ) then
    raise exception 'chapter coverage unavailable' using errcode = '42501';
  end if;
  nearest := private.organization_feature_enabled(organization, 'features.casework.nearest_steward_matching');

  select r.id, (r.config ->> 'stewardUserId')::uuid as steward_user_id,
    'override'::text as source,
    case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end as rank
  into chosen
  from public.organization_coordination_records r
  join private.member_roster_stewards_for_chapter(p_chapter_id) eligible
    on eligible.steward_id = (r.config ->> 'stewardUserId')::uuid
  where r.organization_id = organization and r.chapter_id = p_chapter_id
    and r.kind = 'coverage_override' and r.status = 'active'
    and coalesce((r.config ->> 'available')::boolean, true)
    and p_at >= (r.config ->> 'startsAt')::timestamptz
    and p_at < (r.config ->> 'endsAt')::timestamptz
  order by case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end nulls last,
    r.updated_at desc, r.id desc limit 1;

  if not found then
    select r.id, (r.config ->> 'stewardUserId')::uuid as steward_user_id,
      'schedule'::text as source,
      case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end as rank
    into chosen
    from public.organization_coordination_records r
    join private.member_roster_stewards_for_chapter(p_chapter_id) eligible
      on eligible.steward_id = (r.config ->> 'stewardUserId')::uuid
    cross join lateral (
      select p_at at time zone coalesce(nullif(r.config ->> 'timezone', ''), 'America/New_York') as local_at
    ) local_time
    where r.organization_id = organization and r.chapter_id = p_chapter_id
      and r.kind = 'coverage_schedule' and r.status = 'active'
      and extract(dow from local_time.local_at)::integer = (r.config ->> 'dayOfWeek')::integer
      and (extract(hour from local_time.local_at)::integer * 60
        + extract(minute from local_time.local_at)::integer)
        between (r.config ->> 'startMinute')::integer
          and ((r.config ->> 'endMinute')::integer - 1)
    order by coalesce((r.config ->> 'priority')::integer, 0) desc,
      case when nearest then private.steward_proximity_rank(organization, caller, (r.config ->> 'stewardUserId')::uuid) end nulls last,
      r.updated_at desc, r.id desc limit 1;
  end if;

  if chosen.steward_user_id is null and nearest then
    select null::uuid as id, e.steward_id as steward_user_id, 'nearest'::text as source,
      private.steward_proximity_rank(organization, caller, e.steward_id) as rank
    into chosen
    from private.member_roster_stewards_for_chapter(p_chapter_id) e
    where e.steward_id is distinct from caller
    order by private.steward_proximity_rank(organization, caller, e.steward_id), e.steward_id
    limit 1;
  end if;

  if chosen.steward_user_id is null then
    return pg_catalog.jsonb_build_object(
      'state', 'uncovered', 'chapterId', p_chapter_id,
      'recommendedUserId', null
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'state', case when chosen.source = 'nearest' then 'nearest' else 'covered' end,
    'chapterId', p_chapter_id,
    'recommendedUserId', chosen.steward_user_id,
    'source', chosen.source, 'recordId', chosen.id,
    'contactRoute', 'member_message',
    'matchLevel', case chosen.rank when 0 then 'work_location' when 1 then 'department' when 2 then 'chapter' end,
    -- Name and opted-in routes only for a chapter the caller belongs to, the
    -- same audience as the Find my steward roster.
    'steward', case when exists (
      select 1 from public.member_chapter_memberships cm
      where cm.user_id = caller and cm.chapter_id = p_chapter_id and cm.status = 'active'
    ) then (
      select pg_catalog.jsonb_build_object(
        'name', coalesce(profile.full_name, ''),
        'contact', pg_catalog.jsonb_build_object(
          'conversation', true,
          'email', case when coalesce(pref.share_email, false) then pref.contact_email end,
          'phone', case when coalesce(pref.share_phone, false) then pref.contact_phone end))
      from (select 1) one
      left join public.member_profiles profile on profile.id = chosen.steward_user_id
      left join public.steward_contact_preferences pref on pref.steward_user_id = chosen.steward_user_id
    ) end
  );
end;
$function$;

comment on function public.recommend_organization_coverage(text, timestamptz) is
  'REQ-UG-RECOMMENDED-AND-NEAREST-STEWARD-20261001: override, then schedule, recommendation for one chapter of the caller''s organization, with proximity tie-break and a nearest-steward fallback behind features.casework.nearest_steward_matching; returns the steward''s display name and opted-in contact routes only.';

notify pgrst, 'reload schema';

commit;
