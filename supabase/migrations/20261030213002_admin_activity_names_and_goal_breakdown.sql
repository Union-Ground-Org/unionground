-- REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030 (#6580).
--
-- Findings 42, 58 and 61 of the Oct 29-30 role-play run: "Recent admin
-- activity" said "No admin actions logged yet" after an administrator changed
-- organization settings, the organization ledger named people by six-letter
-- codes, and an organizing goal could not be followed by shift and
-- classification.
--
--   * public.get_admin_audit() also returns the organization's setting
--     changes (public.organization_configuration_audit, written by every
--     setting writer since 20261002017000) as 'organization_setting_updated'
--     and 'organization_setting_reset' rows, with the setting's key and
--     registry label. The rest of the body is the installed one.
--   * public.list_organization_audit_actor_names(ids): the display names of
--     the people the organization ledger names, for an organization
--     administrator of the selected organization, and only for people who
--     have or had a membership of it (the same people the administrator
--     directory and get_admin_audit already name). At most 200 ids.
--   * public.list_failed_login_operations_inbox() also returns openCount,
--     every open failed sign-in report, so the overview's attention count is
--     not limited by the bounded page it shows.
--   * public.get_digital_action_goal_breakdown(action): an organization
--     administrator's live count for one collective action against its goal,
--     by shift and by classification. A participant's shift and
--     classification count under their name only when they shared their
--     profile details with administrators (details_visibility 'admins', the
--     administrator directory's rule); everyone else counts as not shared.
--     It shows administrators nothing the directory and the participant
--     export do not already show them. At most 50 groups each.
--
-- Hosted application: SAMPLE first, then production.

begin;
set local lock_timeout = '5s';

do $predecessors$ begin
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.get_admin_audit(integer)'::regprocedure) is distinct from '49a0059c31ce5f00f217acaf91a5e9b8' then
  raise exception 'unreviewed get_admin_audit predecessor' using errcode = '55000';
end if;
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.list_failed_login_operations_inbox(text,integer)'::regprocedure) is distinct from '5e2356f1503893c18d631dacfe12867a' then
  raise exception 'unreviewed list_failed_login_operations_inbox predecessor' using errcode = '55000';
end if;
end; $predecessors$;

-- ---------------------------------------------------------------------------
-- 1. Setting changes in Recent admin activity.
create or replace function public.get_admin_audit(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  audit_org uuid := private.current_member_organization();
  cap integer := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  if caller is null
     or audit_org is null
     or not private.member_has_chapter_role(private.current_member_chapter(), array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', s.id,
      'action', s.action,
      'actorName', s.actor_name,
      'targetName', s.target_name,
      'targetId', s.target_user,
      'detail', s.detail,
      'createdAt', s.created_at) order by s.created_at desc, s.id)
    from (
      select merged.*
      from (
        select m.id, m.action, m.target_user, m.detail, m.created_at,
               coalesce(a.full_name, 'System') as actor_name,
               case when m.target_user is null then null
                    else coalesce(t.full_name, 'Removed member') end as target_name
        from public.member_admin_audit m
        left join public.member_profiles a on a.id = m.actor
        left join public.member_profiles t on t.id = m.target_user
        where m.organization_id is not null
          and m.organization_id = audit_org
        union all
        -- An organization setting saved or reset: the setting's key and its
        -- registry label, never its values.
        select c.id,
               case c.action when 'setting_reset' then 'organization_setting_reset' else 'organization_setting_updated' end,
               null::uuid,
               pg_catalog.jsonb_build_object('item', c.item_key, 'label', definition.label),
               c.created_at,
               coalesce(a.full_name, 'System'),
               null::text
        from public.organization_configuration_audit c
        left join public.member_profiles a on a.id = c.actor_user_id
        left join public.platform_setting_definitions definition on definition.key = c.item_key
        where c.organization_id = audit_org
          and c.action in ('setting_updated', 'setting_reset')
      ) merged
      order by merged.created_at desc, merged.id
      limit cap
    ) s
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 1b. The failed sign-in inbox also returns every open report's count, so the
-- admin overview never reads the bounded page as the whole inbox.
create or replace function public.list_failed_login_operations_inbox(p_status text default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org_id uuid := private.current_member_organization(); threshold integer := 5; result jsonb;
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('open', 'reviewed', 'dismissed') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  if p_limit not between 1 and 100 then raise exception 'invalid limit' using errcode = '22023'; end if;
  select coalesce((v.value #>> '{}')::integer, (d.default_value #>> '{}')::integer)
  into threshold
  from public.platform_setting_definitions d
  left join public.organization_setting_values v on v.organization_id = org_id and v.setting_key = d.key
  where d.key = 'security.failed_login_alert_threshold';

  select pg_catalog.jsonb_build_object(
    'openLast24Hours', (select count(*) from public.organization_failed_login_attempts a
      where a.organization_id = org_id and a.status = 'open' and a.occurred_at >= pg_catalog.now() - interval '24 hours'),
    -- Every open report, uncapped: the admin overview's attention count must
    -- not depend on the bounded page below
    -- (REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030).
    'openCount', (select count(*) from public.organization_failed_login_attempts a
      where a.organization_id = org_id and a.status = 'open'),
    'attentionThreshold', threshold,
    'items', coalesce((select pg_catalog.jsonb_agg(row_data order by occurred_at desc) from (
      select a.occurred_at, pg_catalog.jsonb_build_object(
        'id', a.id,
        'memberName', coalesce(p.full_name, 'Former member'),
        'memberReference', pg_catalog.upper(pg_catalog.right(a.identity_hash, 6)),
        'method', a.method,
        'source', a.source,
        'userAgent', a.user_agent,
        'status', a.status,
        'dispositionNote', a.disposition_note,
        'occurredAt', a.occurred_at,
        'reviewedAt', a.reviewed_at
      ) as row_data
      from public.organization_failed_login_attempts a
      left join public.member_profiles p on p.id = a.member_user_id
      where a.organization_id = org_id and (p_status is null or a.status = p_status)
      order by a.occurred_at desc limit p_limit
    ) bounded), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Names for the organization ledger.
create function public.list_organization_audit_actor_names(p_user_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_ids is null or coalesce(pg_catalog.cardinality(p_user_ids), 0) > 200 then
    raise exception 'invalid user ids' using errcode = '22023';
  end if;

  return coalesce((
    select pg_catalog.jsonb_object_agg(named.id::text, named.full_name)
    from (
      select distinct profile.id, profile.full_name
      from pg_catalog.unnest(p_user_ids) as wanted(id)
      join public.member_profiles profile on profile.id = wanted.id
      where nullif(pg_catalog.btrim(coalesce(profile.full_name, '')), '') is not null
        and exists (
          select 1 from public.organization_memberships membership
          where membership.organization_id = org
            and membership.user_id = profile.id
        )
    ) named
  ), '{}'::jsonb);
end;
$function$;

revoke all on function public.list_organization_audit_actor_names(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_audit_actor_names(uuid[]) to authenticated;

comment on function public.list_organization_audit_actor_names(uuid[]) is
  'REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: an organization administrator''s lookup of the display names the organization ledger shows instead of user ids; only people who have or had a membership of the selected organization; at most 200 ids.';

-- ---------------------------------------------------------------------------
-- 3. A collective action's goal by shift and classification.
create function public.get_digital_action_goal_breakdown(p_action_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.member_pin_require_full_session();

declare
  org uuid := private.mi1_require_selected_organization();
  action_row public.digital_actions%rowtype;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- The platform's own organization keeps participation private, as the
  -- collective-action reader and the participant export do.
  if not private.organization_is_union(org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  select * into action_row
  from public.digital_actions a
  where a.id = p_action_id and a.organization_id = org;
  if not found then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  return (
    with participants as materialized (
      select
        case when detail.details_visibility = 'admins' then nullif(pg_catalog.btrim(detail.shift), '') end as shift,
        case when detail.details_visibility = 'admins' then nullif(pg_catalog.btrim(detail.classification), '') end as classification
      from public.digital_action_participants participant
      -- Only a current member's shared details: a former member's later
      -- profile changes never reach this organization. They still count in the
      -- total, as not shared.
      left join public.member_profile_details detail on detail.user_id = participant.user_id
        and exists (
          select 1 from public.organization_memberships membership
          where membership.user_id = participant.user_id
            and membership.organization_id = org
            and membership.status = 'active'
        )
        and exists (
          select 1 from public.member_chapter_memberships chapter_membership
          join public.chapters chapter on chapter.id = chapter_membership.chapter_id and chapter.organization_id = org
          where chapter_membership.user_id = participant.user_id
            and chapter_membership.status = 'active'
        )
      where participant.organization_id = org
        and participant.action_id = action_row.id
    )
    select pg_catalog.jsonb_build_object(
      'actionId', action_row.id,
      'title', action_row.title,
      'targetCount', action_row.target_count,
      'participantCount', (select pg_catalog.count(*)::integer from participants),
      'byShift', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('label', grouped.label, 'count', grouped.n) order by grouped.label is null, grouped.n desc, grouped.label)
        from (
          select p.shift as label, pg_catalog.count(*)::integer as n
          from participants p group by p.shift
          order by p.shift is null, pg_catalog.count(*) desc, p.shift
          limit 50
        ) grouped
      ), '[]'::jsonb),
      'byClassification', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('label', grouped.label, 'count', grouped.n) order by grouped.label is null, grouped.n desc, grouped.label)
        from (
          select p.classification as label, pg_catalog.count(*)::integer as n
          from participants p group by p.classification
          order by p.classification is null, pg_catalog.count(*) desc, p.classification
          limit 50
        ) grouped
      ), '[]'::jsonb)
    )
  );
end;
end;
$function$;

revoke all on function public.get_digital_action_goal_breakdown(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_digital_action_goal_breakdown(uuid) to authenticated;

comment on function public.get_digital_action_goal_breakdown(uuid) is
  'REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: an organization administrator''s live participant count for one collective action against its goal, by shift and by classification; a participant''s shift and classification count only when they shared their profile details with administrators; at most 50 groups each.';

notify pgrst, 'reload schema';

commit;
