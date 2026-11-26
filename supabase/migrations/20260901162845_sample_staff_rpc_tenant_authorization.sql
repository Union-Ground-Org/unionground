-- Repair three pre-MI1 staff reads that still treated member_roles.chapter_id
-- as the source of chapter authority. The uniondemo seed correctly re-homes
-- SAMPLE personas into an organization-backed chapter and grants their hats
-- through organization_role_grants, so those stale predicates rejected a
-- valid Steward after the general tenant-aware member_has_role check passed.
--
-- Keep production fail-closed: current callers must satisfy the canonical
-- member_has_chapter_role boundary, and projected reviewers/stewards must hold
-- an active canonical role in the requested chapter or its organization.

create or replace function private.workload_rebalancing(p_chapter text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with chapter_scope as materialized (
    select c.organization_id
    from public.chapters c
    where c.id = p_chapter
  ), steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    cross join chapter_scope
    where p.chapter_id = p_chapter
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
      and c.status = 'active'
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
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

revoke all on function private.workload_rebalancing(text)
  from public, anon, authenticated, service_role;

create or replace function public.list_chapter_task_templates()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select caller_profile.chapter_id
    into caller_chapter
  from public.member_profiles caller_profile
  where caller_profile.id = caller;

  if caller_chapter is null or not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'key', c.template_key,
      'label', pg_catalog.jsonb_build_object('en', c.label_en, 'es', c.label_es),
      'description', pg_catalog.jsonb_build_object('en', c.description_en, 'es', c.description_es),
      'defaultStatus', c.default_status,
      'defaultPriority', c.default_priority,
      'fields', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'key', f.field_key,
          'kind', f.field_kind,
          'required', f.required,
          'label', pg_catalog.jsonb_build_object('en', f.label_en, 'es', f.label_es),
          'help', pg_catalog.jsonb_build_object('en', f.help_en, 'es', f.help_es),
          'options', f.option_keys
        ) order by f.position)
        from private.chapter_task_template_fields f
        where f.template_key = c.template_key
      ), '[]'::jsonb),
      'flow', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'key', s.step_key,
          'label', pg_catalog.jsonb_build_object('en', s.label_en, 'es', s.label_es),
          'predecessorKeys', s.predecessor_keys,
          'recommendedStatus', s.recommended_status,
          'terminal', s.terminal
        ) order by s.position)
        from private.chapter_task_template_flow_steps s
        where s.template_key = c.template_key
      ), '[]'::jsonb),
      'checklist', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'label', pg_catalog.jsonb_build_object('en', item.label_en, 'es', item.label_es)
        ) order by item.position)
        from private.chapter_task_template_checklist_items item
        where item.template_key = c.template_key
      ), '[]'::jsonb)
    ) order by c.sort_order
  ), '[]'::jsonb) into payload
  from private.chapter_task_template_catalog c
  where c.active;

  return payload;
end;
$function$;

revoke all on function public.list_chapter_task_templates()
  from public, anon, authenticated;
grant execute on function public.list_chapter_task_templates() to authenticated;
grant execute on function public.list_chapter_task_templates() to service_role;

create or replace function public.list_chapter_task_template_reviewers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  payload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  select caller_profile.chapter_id
    into caller_chapter
  from public.member_profiles caller_profile
  where caller_profile.id = caller;

  if caller_chapter is null or not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'chapter staff role required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('id', eligible.id, 'fullName', eligible.full_name)
    order by pg_catalog.lower(eligible.full_name), eligible.id
  ), '[]'::jsonb)
    into payload
  from (
    select reviewer_profile.id, reviewer_profile.full_name
    from public.member_profiles reviewer_profile
    where reviewer_profile.chapter_id = caller_chapter
      and private.actor_has_chapter_staff_role(reviewer_profile.id, caller_chapter)
  ) eligible;

  return payload;
end;
$function$;

revoke all on function public.list_chapter_task_template_reviewers()
  from public, anon, authenticated;
grant execute on function public.list_chapter_task_template_reviewers() to authenticated;
grant execute on function public.list_chapter_task_template_reviewers() to service_role;

create or replace function public.get_steward_workload_intelligence(p_weeks integer default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  weeks integer := greatest(2, least(coalesce(p_weeks, 12), 52));
  eligible_points integer := 0;
  trends jsonb := '[]'::jsonb;
  balancing jsonb;
  reason text;
begin
  if caller is null or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if caller_chapter is null then
    return pg_catalog.jsonb_build_object(
      'available', false, 'reason', 'chapter_unavailable', 'eligibleWeeks', 0,
      'categories', '[]'::jsonb, 'rebalancing', pg_catalog.jsonb_build_object('stewards', '[]'::jsonb, 'suggestions', '[]'::jsonb));
  end if;
  if not private.member_has_chapter_role(
    caller_chapter,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;

  balancing := private.workload_rebalancing(caller_chapter);

  with latest_weekly as materialized (
    select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
      pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
      least(w.priority, 150) as priority, least(w.pending, 150) as pending,
      least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
      least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
      least(w.assistance_requests, 150) as assistance_requests,
      least(w.aged_cases, 150) as aged_cases
    from public.member_workload_logs w
    join public.member_profiles p on p.id = w.user_id
    where p.chapter_id = caller_chapter
      and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
    order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
  ), eligible_weeks as materialized (
    select week_start
    from latest_weekly
    group by week_start
    having pg_catalog.count(distinct user_id) >= 25
  )
  select pg_catalog.count(*) into eligible_points from eligible_weeks;

  if eligible_points >= 2 then
    with latest_weekly as materialized (
      select distinct on (pg_catalog.date_trunc('week', w.created_at), w.user_id)
        pg_catalog.date_trunc('week', w.created_at)::date as week_start, w.user_id,
        least(w.priority, 150) as priority, least(w.pending, 150) as pending,
        least(w.unread_docs, 150) as unread_docs, least(w.todos, 150) as todos,
        least(w.referrals, 150) as referrals, least(w.ce_activities, 150) as ce_activities,
        least(w.assistance_requests, 150) as assistance_requests,
        least(w.aged_cases, 150) as aged_cases
      from public.member_workload_logs w
      join public.member_profiles p on p.id = w.user_id
      where p.chapter_id = caller_chapter
        and w.created_at >= pg_catalog.date_trunc('week', pg_catalog.now()) - pg_catalog.make_interval(weeks => weeks)
      order by pg_catalog.date_trunc('week', w.created_at), w.user_id, w.created_at desc
    ), eligible as (
      select week_start from latest_weekly group by week_start
      having pg_catalog.count(distinct user_id) >= 25
    ), weekly_categories as (
      select l.week_start, v.key, v.ord, pg_catalog.avg(v.value)::numeric as value
      from latest_weekly l join eligible e using (week_start)
      cross join lateral (values
        ('priority', 1, l.priority), ('pending', 2, l.pending),
        ('unread_docs', 3, l.unread_docs), ('todos', 4, l.todos),
        ('referrals', 5, l.referrals), ('ce_activities', 6, l.ce_activities),
        ('assistance_requests', 7, l.assistance_requests), ('aged_cases', 8, l.aged_cases)
      ) v(key, ord, value)
      group by l.week_start, v.key, v.ord
    ), regression as (
      select key, ord, pg_catalog.count(*)::integer as points,
        pg_catalog.regr_slope(value, extract(epoch from week_start) / 604800.0)::numeric as slope,
        (pg_catalog.array_agg(value order by week_start desc))[1] as latest
      from weekly_categories group by key, ord
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'key', key, 'points', points,
      'slope', pg_catalog.round(slope, 2),
      'latest', pg_catalog.round(latest, 1),
      'forecast4Weeks', pg_catalog.round(greatest(latest + slope * 4, 0), 1)) order by ord)
    into trends from regression;
  else
    reason := case when eligible_points = 0 then 'anonymity_floor' else 'insufficient_weeks' end;
  end if;

  return pg_catalog.jsonb_build_object(
    'available', eligible_points >= 2,
    'reason', reason,
    'eligibleWeeks', eligible_points,
    'categories', coalesce(trends, '[]'::jsonb),
    'rebalancing', balancing,
    'generatedAt', pg_catalog.now());
end;
$function$;

revoke all on function public.get_steward_workload_intelligence(integer)
  from public, anon, service_role;
grant execute on function public.get_steward_workload_intelligence(integer) to authenticated;
