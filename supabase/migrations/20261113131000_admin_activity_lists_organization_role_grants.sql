-- BUG-UG-RECENT-ADMIN-ACTIVITY-OMITS-ORGANIZATION-ROLE-GRANTS-20261112 (#8534).
-- Recent admin activity (public.get_admin_audit) promises every grant and
-- revoke, but it merged only public.member_admin_audit and the organization
-- setting changes. An organization-wide role grant or revoke is written to
-- public.organization_audit_events only (organization_role_granted and
-- organization_role_revoked), so it never appeared there, while a chapter
-- role grant did. The reader now also merges those two ledger events for
-- the administrator's own organization, as grant_role and revoke_role rows
-- with the role, scope organization and the target member, in date order
-- with the existing rows. The guard, the tenant filter and the cap are
-- unchanged; the body is otherwise the live definition from
-- 20261030213002_admin_activity_names_and_goal_breakdown.sql.
-- Gate round 1 (stage 191): the chapter-role undo of the learning period
-- writes the same two ledger events with a chapterId beside its own
-- member_admin_audit row, so ledger events that name a chapter are left out
-- here (the chapter arm already lists them). A target whose profile is gone
-- gets no name, so the client prints its own translated removed-account
-- wording.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessors$ begin
if (select pg_catalog.md5(prosrc) from pg_catalog.pg_proc where oid = 'public.get_admin_audit(integer)'::regprocedure) is distinct from 'ee19d12b8cd2294036b334ba8511867a' then
  raise exception 'unreviewed get_admin_audit predecessor' using errcode = '55000';
end if;
end; $predecessors$;

create or replace function public.get_admin_audit(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        union all
        -- An organization-wide role granted or revoked. The organization
        -- ledger keeps these; the admin audit table has chapter roles only.
        select e.id,
               case e.event_type when 'organization_role_granted' then 'grant_role' else 'revoke_role' end,
               target.user_id,
               pg_catalog.jsonb_build_object('role', e.metadata ->> 'role', 'scope', 'organization', 'organizationId', e.organization_id),
               e.created_at,
               coalesce(a.full_name, 'System'),
               t.full_name
        from public.organization_audit_events e
        cross join lateral (
          select case when (e.metadata ->> 'userId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      then (e.metadata ->> 'userId')::uuid end as user_id
        ) target
        left join public.member_profiles a on a.id = e.actor_user_id
        left join public.member_profiles t on t.id = target.user_id
        where e.organization_id = audit_org
          and e.event_type in ('organization_role_granted', 'organization_role_revoked')
          and not (e.metadata ? 'chapterId')
      ) merged
      order by merged.created_at desc, merged.id
      limit cap
    ) s
  ), '[]'::jsonb);
end;
$function$;

commit;
