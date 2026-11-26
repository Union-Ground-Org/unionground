-- Keep the native chapter switcher honest for organization-wide staff.
--
-- member_role_chapters intentionally carries only chapter-scoped grants. The
-- original mobile projection read that table alone, so legacy organization-
-- wide Admin and President grants (member_roles.chapter_id IS NULL) vanished
-- from the authenticated iOS/Android authorization state. Project those grants
-- into every active chapter membership without creating a chapter mapping or
-- changing the underlying authorization scope.

set local lock_timeout = '5s';

create or replace function public.get_my_chapter_memberships()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'chapterId', c.id,
      'name', c.name,
      'region', c.region,
      'selected', c.id = p.chapter_id,
      'pinned', m.pinned,
      'lastSelectedAt', m.last_selected_at,
      'joinedAt', m.joined_at,
      'roles', coalesce((
        select pg_catalog.jsonb_agg(scoped_role.role order by scoped_role.role)
        from (
          select rc.role
          from public.member_role_chapters rc
          where rc.user_id = m.user_id and rc.chapter_id = m.chapter_id
          union
          select r.role
          from public.member_roles r
          where r.user_id = m.user_id and r.chapter_id is null
        ) scoped_role
      ), '[]'::jsonb)
    ) order by m.pinned desc, m.last_selected_at desc nulls last, c.name
  ), '[]'::jsonb)
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id and m.status = 'active'
  join public.chapters c on c.id = m.chapter_id
  where p.id = (select auth.uid()) and private.mfa_satisfied();
$function$;

revoke all on function public.get_my_chapter_memberships() from public, anon;
grant execute on function public.get_my_chapter_memberships() to authenticated;
