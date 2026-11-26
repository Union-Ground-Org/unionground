begin;
set local lock_timeout = '5s';

-- BUG-UG-STEWARD-DESK-RPC-LATENCY-AT-SCALE-20260908.
-- At the observed 30,006-member/20-chapter tenant skew, the KPI repeats the
-- same selected-organization role check 60 times. Evaluate that unchanged
-- predicate once per helper invocation. Materialize the chapter boundary so
-- chapter-scoped and legacy checks cannot move into the per-profile join.
-- RETURN QUERY lets PL/pgSQL reuse the prepared visibility statement when
-- multiple RLS scans invoke it in one backend. The previous SQL-language
-- wrapper repeated that work across the initial five-RPC desk wave.
-- Preserve the full prior MFA, tenant, membership, role and legacy predicates;
-- the KPI and all table RLS policies remain SECURITY INVOKER boundaries.

create or replace function private.staff_visible_member_ids(p_role text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return query
  with caller as materialized (
    select
      (select auth.uid()) as uid,
      (select private.current_member_organization()) as organization_id
  ),
  organization_role as materialized (
    select case when caller.uid is not null and p_role is not null
      and caller.organization_id is not null and (select private.mfa_satisfied())
      then private.has_organization_role(caller.organization_id, array[p_role])
      else false end as allowed
    from caller
  ),
  visible_chapters as materialized (
    select chapter.id
    from public.chapters chapter
    cross join caller
    cross join organization_role
    where caller.uid is not null
      and p_role is not null
      and (select private.mfa_satisfied())
      and (
        (
          chapter.organization_id is not null
          and chapter.organization_id = caller.organization_id
          and (
            organization_role.allowed
            or private.member_has_chapter_role(
              chapter.id,
              array[p_role]
            )
          )
        )
        or (
          chapter.organization_id is null
          and caller.organization_id is null
          and exists (
            select 1
            from public.member_profiles caller_profile
            left join public.chapters caller_chapter
              on caller_chapter.id = caller_profile.chapter_id
            where caller_profile.id = caller.uid
              and (
                caller_chapter.id is null
                or caller_chapter.organization_id is null
              )
          )
          and (
            not (select private.staff_mfa_required())
            or (select private.has_second_factor(caller.uid))
          )
          and exists (
            select 1
            from public.member_roles role_grant
            where role_grant.user_id = caller.uid
              and role_grant.role = p_role
              and (
                role_grant.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters role_chapter
                  join public.member_chapter_memberships membership
                    on membership.user_id = role_chapter.user_id
                   and membership.chapter_id = role_chapter.chapter_id
                  join public.chapters mapped_chapter
                    on mapped_chapter.id = role_chapter.chapter_id
                  where role_chapter.user_id = role_grant.user_id
                    and role_chapter.role = role_grant.role
                    and role_chapter.chapter_id = chapter.id
                    and mapped_chapter.organization_id is null
                    and membership.status = 'active'
                )
              )
          )
        )
      )
  )
  select profile.id
  from public.member_profiles profile
  join visible_chapters
    on visible_chapters.id = profile.chapter_id;
end;
$function$;

revoke all on function private.staff_visible_member_ids(text)
  from public, anon, authenticated, service_role;
grant execute on function private.staff_visible_member_ids(text)
  to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
