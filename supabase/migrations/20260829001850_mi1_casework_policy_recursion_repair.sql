-- Break the member_cases <-> casework_access_grants RLS cycle introduced by
-- 20260828210000_mi1_casework_suite.sql. A direct subquery from the
-- member_cases coordinator policy enters casework_access_grants RLS, whose
-- read policy consults member_cases again and PostgreSQL raises 42P17.
--
-- Keep the original restricted-case authorization semantics: the caller must
-- still hold an active explicit grant for this exact case. The definer helper
-- bypasses RLS only for that bounded existence check. Authenticated callers
-- receive the EXECUTE privilege PostgreSQL requires while evaluating the
-- policy; the private schema keeps the helper outside the PostgREST API.

set lock_timeout = '5s';

create or replace function private.casework_actor_has_active_grant(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.casework_access_grants g
    where g.case_id = p_case_id
      and g.grantee_user_id = (select auth.uid())
      and g.revoked_at is null
  );
$function$;

revoke all on function private.casework_actor_has_active_grant(uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.casework_actor_has_active_grant(uuid)
  to authenticated;

drop policy if exists member_cases_select_coordinator on public.member_cases;
create policy member_cases_select_coordinator on public.member_cases
  for select to authenticated using (
    public.staff_can_see_user(user_id, 'coordinator')
    and (
      not is_restricted
      or coordinator_user_id = (select auth.uid())
      or private.has_organization_role(organization_id, array['advisor','admin','vp'])
      or private.casework_actor_has_active_grant(id)
    )
  );
