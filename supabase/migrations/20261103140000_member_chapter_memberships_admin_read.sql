-- BUG-UG-CHAPTER-MEMBERSHIP-EXACT-STATE-READ-20261103 (#6874): the
-- membership card (ChapterMembershipCard) could read only the member
-- directory row, which names one located chapter and the member's roles
-- across the organization. It could not tell which chapters a member holds,
-- which roles they hold in each, or whether a chapter is their last, so
-- impossible grants and revokes stayed enabled and the revoke confirm could
-- only say "if this is their only chapter".
--
-- public.get_member_chapter_memberships_for_admin(p_user_id) is a read-only
-- answer to exactly that, behind the same callers as
-- revoke_member_chapter_membership and set_member_chapter_role: an
-- organization Admin (private.has_organization_role) sees the member's active
-- chapters in the caller's organization; a chapter Admin sees only their
-- selected chapter. Every other caller is refused with 42501. Roles are the
-- member_role_chapters rows the card's role buttons grant and remove.
-- lastChapter says whether the row is the member's only active chapter in the
-- organization; a chapter Admin learns that one fact because the revoke they
-- are about to confirm also removes the member from the organization when it
-- is true. Nothing is written.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create function public.get_member_chapter_memberships_for_admin(p_user_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  active_count integer;
  result jsonb;
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.organization_memberships om
    where om.organization_id = caller_org
      and om.user_id = p_user_id
      and om.status = 'active'
  ) then
    return pg_catalog.jsonb_build_object(
      'userId', p_user_id,
      'scope', case when org_admin then 'organization' else 'chapter' end,
      'chapters', '[]'::jsonb);
  end if;

  select pg_catalog.count(*)::integer into active_count
  from public.member_chapter_memberships m
  join public.chapters c
    on c.id = m.chapter_id
   and c.organization_id = caller_org
  where m.user_id = p_user_id
    and m.status = 'active';

  select pg_catalog.jsonb_build_object(
    'userId', p_user_id,
    'scope', case when org_admin then 'organization' else 'chapter' end,
    'chapters', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'chapterId', held.chapter_id,
      'home', held.home,
      'lastChapter', active_count = 1,
      'roles', held.roles
    ) order by held.home desc, held.order_index, held.chapter_id), '[]'::jsonb)
  ) into result
  from (
    select c.id as chapter_id,
      c.order_index,
      coalesce(p.chapter_id = c.id, false) as home,
      coalesce((
        select pg_catalog.jsonb_agg(rc.role order by rc.role)
        from public.member_role_chapters rc
        where rc.user_id = p_user_id
          and rc.chapter_id = c.id
      ), '[]'::jsonb) as roles
    from public.member_chapter_memberships m
    join public.chapters c
      on c.id = m.chapter_id
     and c.organization_id = caller_org
    left join public.member_profiles p on p.id = p_user_id
    where m.user_id = p_user_id
      and m.status = 'active'
      and (org_admin or c.id = caller_chapter)
  ) held;
  return result;
end;
$function$;

revoke all on function public.get_member_chapter_memberships_for_admin(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_member_chapter_memberships_for_admin(uuid)
  to authenticated;
comment on function public.get_member_chapter_memberships_for_admin(uuid) is
  'Read-only: a member''s active chapters in the caller''s organization, the home chapter, the chapter roles in each and whether each is their last. Organization Admin sees every chapter; a chapter Admin only their selected chapter; everyone else 42501.';

commit;
