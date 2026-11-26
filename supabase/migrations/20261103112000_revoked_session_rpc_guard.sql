-- BUG-UG-REVOKED-SESSION-TOKEN-STILL-SERVES-THREE-RPCS-20261103 (#6886).
--
-- After a global sign-out removes every auth.sessions row for an account, the
-- other device's access token stays cryptographically valid until it expires.
-- list_my_sessions and the other session RPCs already refuse that token with
-- 42501 "member session required", through private.current_member_session_id()
-- (20260812125000_member_device_sessions.sql), and the RPCs gated by
-- private.mfa_satisfied() refuse it too. Three member RPCs only checked
-- auth.uid() and so kept answering:
--
-- 1. public.get_member_home_bootstrap, from 20261102173500_case_note_date_in_exports.sql.
--    SECURITY INVOKER, so it cannot reach the definer resolver itself; it now
--    calls the granted guard below. Otherwise unchanged; same grants.
-- 2. public.get_my_chapter_memberships, from
--    20260924200000_member_support_chapterless_org_resolution.sql. Its rows
--    were already filtered by private.mfa_satisfied(), so a revoked token got
--    200 with []; it now refuses instead. The query is unchanged; the function
--    moves from SQL to PL/pgSQL only so the guard runs before it.
-- 3. public.get_staff_mfa_standing, from 20260822010000_mi1_organization_scope_foundation.sql.
--    Guarded on the session row only, not on private.mfa_satisfied(): a staff
--    member who has not finished two-step sign-in yet still needs this answer.
--
-- private.require_member_session() is that session-row check and nothing
-- more: it raises 42501 "member session required" unless the token's
-- session_id names a live auth.sessions row of the caller. It returns nothing,
-- so granting it to authenticated exposes no session identifier, and the
-- private schema is not served by PostgREST.

begin;
set local search_path = pg_catalog;

create or replace function private.require_member_session()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.current_member_session_id();
end;
$function$;

revoke all on function private.require_member_session() from public, anon, authenticated, service_role;
grant execute on function private.require_member_session() to authenticated;

comment on function private.require_member_session() is
  'BUG-UG-REVOKED-SESSION-TOKEN-STILL-SERVES-THREE-RPCS-20261103: raises 42501 "member session required" unless the caller''s token names a live auth.sessions row of the caller. Callable from SECURITY INVOKER member RPCs.';

create or replace function public.get_member_home_bootstrap(p_action_log_since timestamptz, p_resources text[])
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform private.require_member_session();
  if p_action_log_since is null then
    raise exception 'action log window required' using errcode = '22023';
  end if;
  if p_resources is null or pg_catalog.cardinality(p_resources) = 0 then
    raise exception 'resource list required' using errcode = '22023';
  end if;
  return pg_catalog.jsonb_build_object(
    'user_id', caller,
    -- select * ... eq user_id ... order created_at desc
    'member_notifications', case when 'member_notifications' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
      from (select * from public.member_notifications where user_id = caller order by created_at desc limit 1000) t) end,
    -- select role ... eq user_id
    'member_roles', case when 'member_roles' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role', t.role)), '[]'::jsonb)
      from (select role from public.member_roles where user_id = caller limit 1000) t) end,
    -- select id,name ... order order_index
    'chapters', case when 'chapters' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'name', t.name) order by t.order_index), '[]'::jsonb)
      from (select id, name, order_index from public.chapters order by order_index limit 1000) t) end,
    -- select MEMBER_CASE_COLUMNS ... eq user_id ... order updated_at desc
    'member_cases', case when 'member_cases' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.updated_at desc), '[]'::jsonb)
      from (select id, user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at, steward_name, coordinator_name
            from public.member_cases where user_id = caller order by updated_at desc limit 1000) t) end,
    -- select id,case_id,user_id,body,occurred_on,created_at ... eq user_id ... order created_at
    'member_case_updates', case when 'member_case_updates' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.created_at), '[]'::jsonb)
      from (select id, case_id, user_id, body, occurred_on, created_at from public.member_case_updates where user_id = caller order by created_at limit 1000) t) end,
    -- select id,sender,title,body,published_at,locale,audience_scope ... is retracted_at null ... order published_at desc ... limit 50
    'member_broadcasts', case when 'member_broadcasts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.published_at desc), '[]'::jsonb)
      from (select id, sender, title, body, published_at, locale, audience_scope
            from public.member_broadcasts where retracted_at is null order by published_at desc limit 50) t) end,
    -- select broadcast_id,read_at ... eq user_id
    'member_broadcast_receipts', case when 'member_broadcast_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select broadcast_id, read_at from public.member_broadcast_receipts where user_id = caller limit 1000) t) end,
    -- select <ballot columns>,member_ballot_options(id,ballot_id,label,label_es,order_index) ... order order_index
    'member_ballots', case when 'member_ballots' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select b.id, b.title, b.title_es, b.body, b.body_es, b.closes_at, b.active, b.order_index, b.quorum_target, b.chapter_id,
                   b.campaign_state, b.published_at, b.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, ballot_id, label, label_es, order_index from public.member_ballot_options where ballot_id = b.id) o)
                     as member_ballot_options
            from public.member_ballots b order by b.order_index limit 1000) t) end,
    -- select <survey columns>,member_survey_options(id,survey_id,label,label_es,order_index) ... order order_index
    'member_surveys', case when 'member_surveys' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select s.id, s.title, s.title_es, s.body, s.body_es, s.closes_at, s.active, s.order_index, s.chapter_id,
                   s.campaign_state, s.published_at, s.closed_at,
                   (select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o) order by o.order_index), '[]'::jsonb)
                    from (select id, survey_id, label, label_es, order_index from public.member_survey_options where survey_id = s.id) o)
                     as member_survey_options
            from public.member_surveys s order by s.order_index limit 1000) t) end,
    -- select survey_id,option_id ... eq user_id
    'member_survey_responses', case when 'member_survey_responses' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select survey_id, option_id from public.member_survey_responses where user_id = caller limit 1000) t) end,
    -- select * ... order order_index
    'member_rights_lessons', case when 'member_rights_lessons' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.order_index), '[]'::jsonb)
      from (select * from public.member_rights_lessons order by order_index limit 1000) t) end,
    -- select lesson_id,completed_steps ... eq user_id
    'member_rights_progress', case when 'member_rights_progress' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select lesson_id, completed_steps from public.member_rights_progress where user_id = caller limit 1000) t) end,
    -- select action_key,action_kind,occurred_at ... eq user_id ... gte occurred_at <since> ... order occurred_at
    'member_action_log', case when 'member_action_log' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.occurred_at), '[]'::jsonb)
      from (select action_key, action_kind, occurred_at from public.member_action_log
            where user_id = caller and occurred_at >= p_action_log_since order by occurred_at limit 1000) t) end,
    -- select ballot_id,receipt_code,issued_at ... eq user_id
    'member_ballot_receipts', case when 'member_ballot_receipts' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select ballot_id, receipt_code, issued_at from public.member_ballot_receipts where user_id = caller limit 1000) t) end,
    -- select event_id,status ... eq user_id
    'member_event_rsvps', case when 'member_event_rsvps' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id, status from public.member_event_rsvps where user_id = caller limit 1000) t) end,
    -- select event_id ... eq user_id
    'member_event_checkins', case when 'member_event_checkins' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)), '[]'::jsonb)
      from (select event_id from public.member_event_checkins where user_id = caller limit 1000) t) end,
    -- select action_kind,label,points,weekly_cap ... order points desc
    'member_point_rules', case when 'member_point_rules' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.points desc), '[]'::jsonb)
      from (select action_kind, label, points, weekly_cap from public.member_point_rules order by points desc limit 1000) t) end,
    -- select tier,name,min_points ... order tier
    'member_reward_tiers', case when 'member_reward_tiers' = any(p_resources) then (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) order by t.tier), '[]'::jsonb)
      from (select tier, name, min_points from public.member_reward_tiers order by tier limit 1000) t) end
  );
end;
$function$;


create or replace function public.get_my_chapter_memberships()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.require_member_session();
  return (
  select coalesce(
    nullif((
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'chapterId', c.id,
          'name', c.name,
          'region', c.region,
          'selected', c.id = p.chapter_id,
          'pinned', m.pinned,
          'lastSelectedAt', m.last_selected_at,
          'joinedAt', m.joined_at,
          'organizationId', c.organization_id,
          'roles', coalesce((
            select pg_catalog.jsonb_agg(scoped_role.role order by scoped_role.role)
            from (
              select rc.role
              from public.member_role_chapters rc
              where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
              union
              select g.role
              from public.organization_role_grants g
              where g.user_id = m.user_id
                and c.organization_id is not null
                and g.organization_id = c.organization_id
              union
              select r.role
              from public.member_roles r
              where r.user_id = m.user_id
                and r.chapter_id is null
                and c.organization_id is null
            ) scoped_role
          ), '[]'::jsonb),
          'organizationRoles', coalesce((
            select pg_catalog.jsonb_agg(g.role order by g.role)
            from public.organization_role_grants g
            where g.user_id = m.user_id
              and c.organization_id is not null
              and g.organization_id = c.organization_id
          ), '[]'::jsonb),
          'chapterRoles', coalesce((
            select pg_catalog.jsonb_agg(rc.role order by rc.role)
            from public.member_role_chapters rc
            where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
          ), '[]'::jsonb)
        ) order by m.pinned desc, m.last_selected_at desc nulls last, c.name
      ), '[]'::jsonb)
      from public.member_profiles p
      join public.member_chapter_memberships m
        on m.user_id = p.id and m.status = 'active'
      join public.chapters c on c.id = m.chapter_id
      where p.id = (select auth.uid())
        and private.mfa_satisfied()
        and (
          (
            c.organization_id is not null
            and exists (
              select 1
              from public.organization_memberships om
              join public.organizations o
                on o.id = om.organization_id
               and o.status = 'active'
              where om.user_id = p.id
                and om.organization_id = c.organization_id
                and om.status = 'active'
            )
            and (
              private.current_member_organization() is null
              or c.organization_id = private.current_member_organization()
            )
          )
          or (
            c.organization_id is null
            and private.current_member_organization() is null
            and not exists (
              select 1
              from public.organization_memberships om
              join public.organizations o
                on o.id = om.organization_id
               and o.status = 'active'
              where om.user_id = p.id
                and om.status = 'active'
            )
          )
        )
    ), '[]'::jsonb),
    (
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'chapterId', null,
          'name', o.name,
          'region', null,
          'selected', true,
          'pinned', false,
          'lastSelectedAt', null,
          'joinedAt', om.created_at,
          'organizationId', o.id,
          'roles', coalesce((
            select pg_catalog.jsonb_agg(g.role order by g.role)
            from public.organization_role_grants g
            where g.user_id = om.user_id and g.organization_id = o.id
          ), '[]'::jsonb),
          'organizationRoles', coalesce((
            select pg_catalog.jsonb_agg(g.role order by g.role)
            from public.organization_role_grants g
            where g.user_id = om.user_id and g.organization_id = o.id
          ), '[]'::jsonb),
          'chapterRoles', '[]'::jsonb
        )
      ), '[]'::jsonb)
      from public.organization_memberships om
      join public.organizations o
        on o.id = om.organization_id and o.status = 'active'
      where om.user_id = (select auth.uid())
        and om.status = 'active'
        and private.mfa_satisfied()
        and private.current_member_organization() is null
        and not exists (
          select 1
          from public.member_chapter_memberships cm
          where cm.user_id = om.user_id and cm.status = 'active'
        )
        and (
          select pg_catalog.count(*)
          from public.organization_memberships peer
          join public.organizations peer_org
            on peer_org.id = peer.organization_id and peer_org.status = 'active'
          where peer.user_id = om.user_id and peer.status = 'active'
        ) = 1
    ),
    '[]'::jsonb)
  );
end;
$function$;


create or replace function public.get_staff_mfa_standing()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  policy_org uuid := private.current_member_organization();
  holds_role boolean;
  enrolled boolean;
  required boolean;
begin
  if caller is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  perform private.require_member_session();

  required := case
    when policy_org is null then private.staff_mfa_required()
    else private.staff_mfa_required(policy_org)
  end;
  enrolled := private.has_second_factor(caller);

  if policy_org is not null then
    holds_role := exists (
      select 1
      from public.organization_memberships om
      where om.organization_id = policy_org
        and om.user_id = caller
        and om.status = 'active'
        and (
          exists (
            select 1 from public.organization_role_grants g
            where g.organization_id = policy_org and g.user_id = caller
          )
          or exists (
            select 1
            from public.member_role_chapters rc
            join public.chapters c
              on c.id = rc.chapter_id and c.organization_id = policy_org
            join public.member_chapter_memberships cm
              on cm.user_id = rc.user_id
             and cm.chapter_id = rc.chapter_id
             and cm.status = 'active'
            where rc.user_id = caller
          )
        )
    );
  else
    holds_role := exists (
      select 1
      from public.member_roles r
      join public.member_profiles p on p.id = r.user_id
      left join public.chapters c on c.id = p.chapter_id
      where r.user_id = caller
        and (c.id is null or c.organization_id is null)
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'requireStaffMfa', required,
    'holdsStaffRole', holds_role,
    'enrolled', enrolled,
    'assured', private.mfa_satisfied(),
    'blocked', required and holds_role and not enrolled
  );
end;
$function$;


revoke all on function public.get_member_home_bootstrap(timestamptz, text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_member_home_bootstrap(timestamptz, text[]) to authenticated;

revoke all on function public.get_my_chapter_memberships()
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_chapter_memberships() to authenticated;

revoke all on function public.get_staff_mfa_standing() from public, anon;
grant execute on function public.get_staff_mfa_standing() to authenticated;

notify pgrst, 'reload schema';

commit;
