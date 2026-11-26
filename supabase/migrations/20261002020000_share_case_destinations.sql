-- Bounded native share destinations: same SELECT visibility as the case search,
-- with caller scope computed once rather than staff_can_see_user per case.
-- No status/chapter parameter: a client cannot widen or truncate tenant authority.
begin;
set local lock_timeout = '5s';
create function public.list_share_case_destinations(p_limit integer default 100)
returns table(id uuid, user_id uuid, reference text, title text, status text, updated_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_limit integer := least(greatest(coalesce(p_limit,100),1),100);
begin
  if v_actor is null then return; end if;
  return query
  with actor_scope as materialized (
    select
      -- mfa_assurance, the RESTRICTIVE policy both case tables carry. It ANDs
      -- over every permissive branch, so it gates the whole `visible` CTE.
      (select private.mfa_satisfied()) as mfa_satisfied,
      -- member_cases_select_steward's second conjunct.
      public.member_has_role(array['steward']) as steward_hat,
      -- public.staff_can_see_user(user_id, 'coordinator') as a set of chapters.
      array(select private.staff_visible_chapter_scope('coordinator')) as coordinator_chapters,
      -- private.has_organization_role(organization_id, array['advisor','admin','vp'])
      -- is false unless organization_id is this organization, so the grant test
      -- is a constant and the per-row test is a column comparison.
      (select private.current_mobile_staff_organization()) as staff_organization,
      coalesce((select private.has_organization_role(
        (select private.current_mobile_staff_organization()),
        array['advisor','admin','vp'])), false) as organization_officer,
      -- private.casework_actor_has_active_grant(id), as the set it tests.
      array(
        select g.case_id
        from public.casework_access_grants g
        where g.grantee_user_id = v_actor
          and g.revoked_at is null
      ) as granted_cases
  ),
  staff_visible as (
    select c.id
    from public.member_profiles case_owner
    join public.member_cases c on c.user_id = case_owner.id
    where (select s.coordinator_chapters from actor_scope s) <> '{}'::text[]
      and case_owner.chapter_id = any((select s.coordinator_chapters from actor_scope s)::text[])
      and (
        not c.is_restricted or c.coordinator_user_id = v_actor
        or (c.organization_id is not null
          and c.organization_id = (select s.staff_organization from actor_scope s)
          and (select s.organization_officer from actor_scope s))
        or c.id = any((select s.granted_cases from actor_scope s)::uuid[])
      )
  ), visible_ids as (
    select c.id from public.member_cases c where c.user_id = v_actor
    union
    select c.id from public.member_cases c
      where c.steward_user_id = v_actor and (select s.steward_hat from actor_scope s)
    union
    select s.id from staff_visible s
  )
  select c.id, c.user_id, c.reference, c.title, c.status, c.updated_at
  from visible_ids v join public.member_cases c on c.id = v.id
  where (select s.mfa_satisfied from actor_scope s)
  order by c.updated_at desc, c.id
  limit v_limit;
end;
$function$;
revoke all on function public.list_share_case_destinations(integer) from public, anon, authenticated, service_role;
grant execute on function public.list_share_case_destinations(integer) to authenticated;
commit;
