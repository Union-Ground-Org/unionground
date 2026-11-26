-- REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006.
--
-- Members could not tell who runs their chapter: officer titles were visible
-- only in the admin member directory, and nothing listed who holds the
-- President or administrator role. public.get_chapter_leadership() is the
-- member's read of their own chapter's leadership:
--   * officers: active members of the chapter with a display title
--     (20261004050000, set by an admin of the chapter, grants nothing);
--   * the chapter's President (a vp role scoped to this chapter; an
--     organization-wide vp grant is not a chapter Presidency) and its
--     administrators (an admin role scoped to this chapter);
--   * the organization's administrators, who can administer every chapter.
-- Each row carries a name, the title, and which of those roles the person
-- holds; never contact fields, member-since, or any other role.

begin;

set local lock_timeout = '5s';

create function public.get_chapter_leadership()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text;
  chapter_label text;
begin
  if caller is null or not private.mfa_satisfied() or caller_org is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select p.chapter_id into caller_chapter
  from public.member_profiles p where p.id = caller;
  -- The caller's own active membership of a chapter of the selected
  -- organization; a profile pointer alone is not membership.
  select c.name into chapter_label
  from public.chapters c
  join public.member_chapter_memberships cm
    on cm.chapter_id = c.id
   and cm.user_id = caller
   and cm.status = 'active'
  where c.id = caller_chapter
    and c.organization_id = caller_org;
  if chapter_label is null then
    raise exception 'member chapter required' using errcode = '22023';
  end if;

  return pg_catalog.jsonb_build_object(
    'chapterId', caller_chapter,
    'chapterName', chapter_label,
    'people', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', ranked.id,
        'name', ranked.full_name,
        'title', ranked.display_title,
        'president', ranked.chapter_president,
        'administrator', ranked.chapter_admin,
        'organizationAdministrator', ranked.organization_admin
      ) order by ranked.rank, ranked.full_name, ranked.id)
      from (
        select people.id, profile.full_name, people.display_title,
          scoped.chapter_president, scoped.chapter_admin, scoped.organization_admin,
          case
            when scoped.chapter_president then 0
            when people.display_title is not null then 1
            when scoped.chapter_admin then 2
            else 3
          end as rank
        from (
          select cm.user_id as id, cm.display_title
          from public.member_chapter_memberships cm
          join public.organization_memberships om
            on om.user_id = cm.user_id
           and om.organization_id = caller_org
           and om.status = 'active'
          where cm.chapter_id = caller_chapter
            and cm.status = 'active'
          union
          select g.user_id, null::text
          from public.organization_role_grants g
          join public.organization_memberships om
            on om.user_id = g.user_id
           and om.organization_id = g.organization_id
           and om.status = 'active'
          where g.organization_id = caller_org
            and g.role = 'admin'
            and not exists (
              select 1 from public.member_chapter_memberships own
              where own.user_id = g.user_id
                and own.chapter_id = caller_chapter
                and own.status = 'active'
            )
        ) people
        join public.member_profiles profile on profile.id = people.id
        cross join lateral (
          select
            exists (
              select 1 from public.member_role_chapters rc
              where rc.user_id = people.id
                and rc.chapter_id = caller_chapter
                and rc.role = 'vp'
            ) as chapter_president,
            exists (
              select 1 from public.member_role_chapters rc
              where rc.user_id = people.id
                and rc.chapter_id = caller_chapter
                and rc.role = 'admin'
            ) as chapter_admin,
            exists (
              select 1 from public.organization_role_grants g
              where g.user_id = people.id
                and g.organization_id = caller_org
                and g.role = 'admin'
            ) as organization_admin
        ) scoped
        where people.display_title is not null
           or scoped.chapter_president
           or scoped.chapter_admin
           or scoped.organization_admin
        order by 7, profile.full_name, people.id
        limit 100
      ) ranked
    ), '[]'::jsonb)
  );
end;

end;
$$;

revoke all on function public.get_chapter_leadership() from public, anon, authenticated, service_role;
grant execute on function public.get_chapter_leadership() to authenticated;

comment on function public.get_chapter_leadership() is
  'REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006: the caller''s own chapter''s officers (display titles), President and administrators, plus the organization''s administrators; name, title and those roles only.';

notify pgrst, 'reload schema';

commit;
