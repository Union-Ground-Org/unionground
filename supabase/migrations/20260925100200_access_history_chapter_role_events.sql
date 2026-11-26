-- SEC-UG-ACCESS-HISTORY-CHAPTER-ROLE-EVENTS-20260921
--
-- public.list_my_access_history (20260828021500) projected organization-role
-- grants and revocations from organization_audit_events but not chapter-role
-- changes. public.set_member_chapter_role (20260822010000) already records
-- every chapter-role grant and revocation in public.member_admin_audit
-- (action grant_role / revoke_role, target_user, detail.role and
-- detail.chapterId).
--
-- The feed now adds those rows for the caller only, limited to chapters of
-- the caller's selected organization, with the same shape and staff actor
-- label as the organization-role rows; entityId carries the chapter id so the
-- chapter scope is explicit. Every other line of the function is unchanged;
-- the MFA and membership gates run first as before, and the existing ACL
-- (authenticated only, 20260828163209) is preserved by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.list_my_access_history(p_range_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  caller uuid := (select auth.uid());
  cutoff timestamptz;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_range_days is not null and p_range_days not in (30, 90, 365) then
    raise exception 'invalid range' using errcode = '22023';
  end if;
  cutoff := case
    when p_range_days is null then null
    else pg_catalog.now() - (p_range_days || ' days')::interval
  end;
  return coalesce((
    select pg_catalog.jsonb_agg(row_to_json(feed) order by feed."occurredAt" desc)
    from (
      select
        e.id::text as id,
        e.organization_id as "organizationId",
        e.subject_user_id as "subjectUserId",
        split_part(coalesce(p.full_name, e.actor_role), ' ', 1) as "actorLabel",
        e.actor_role as "actorRole",
        e.action,
        e.entity_type as "entityType",
        e.entity_id as "entityId",
        e.occurred_at as "occurredAt"
      from public.member_access_events e
      left join public.member_profiles p on p.id = e.actor_user_id
      where e.organization_id = org
        and e.subject_user_id = caller
        and (cutoff is null or e.occurred_at >= cutoff)
      union all
      select
        a.id::text as id,
        a.organization_id as "organizationId",
        caller as "subjectUserId",
        split_part(coalesce(p.full_name, 'staff'), ' ', 1) as "actorLabel",
        'staff'::text as "actorRole",
        case
          when a.event_type = 'organization_role_granted' then 'granted_role'
          else 'revoked_role'
        end as action,
        'role_grant'::text as "entityType",
        null::text as "entityId",
        a.created_at as "occurredAt"
      from public.organization_audit_events a
      left join public.member_profiles p on p.id = a.actor_user_id
      where a.organization_id = org
        and a.event_type in ('organization_role_granted', 'organization_role_revoked')
        and a.metadata ->> 'userId' = caller::text
        and (cutoff is null or a.created_at >= cutoff)
      union all
      -- Chapter-role grants and revocations (public.set_member_chapter_role),
      -- limited to chapters of the selected organization; entityId names the
      -- chapter so the scope is explicit.
      select
        r.id::text as id,
        org as "organizationId",
        caller as "subjectUserId",
        split_part(coalesce(p.full_name, 'staff'), ' ', 1) as "actorLabel",
        'staff'::text as "actorRole",
        case
          when r.action = 'grant_role' then 'granted_role'
          else 'revoked_role'
        end as action,
        'role_grant'::text as "entityType",
        r.detail ->> 'chapterId' as "entityId",
        r.created_at as "occurredAt"
      from public.member_admin_audit r
      join public.chapters c on c.id = r.detail ->> 'chapterId'
      left join public.member_profiles p on p.id = r.actor
      where r.target_user = caller
        and r.action in ('grant_role', 'revoke_role')
        and c.organization_id = org
        and (cutoff is null or r.created_at >= cutoff)
    ) feed
  ), '[]'::jsonb);
end;
$function$;

commit;
