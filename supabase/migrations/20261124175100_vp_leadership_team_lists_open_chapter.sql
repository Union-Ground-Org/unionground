-- BUG-UG-COUNTS-AND-STATUSES-DISAGREE-BETWEEN-PAGES-20261122 (#9533),
-- finding B-55: the Leadership team on the President's desk listed the whole
-- organization. public.get_staff_roster answers organization-wide for anyone
-- holding an organization admin, coordinator, advisor or vp grant, and the
-- President holds an organization vp grant, which stays.
--
-- The read gains one optional argument, p_chapter_only (default false). With
-- it the answer is the one a leader holding only a chapter role gets today:
-- the staff of the caller's open chapter (private.current_member_chapter(),
-- the chapter get_vp_overview counts), each with their roles in that chapter
-- plus their organization-wide grants. Only the President's desk asks for it.
-- Without it the answer is unchanged for every caller, refusals included, so
-- the Admin desk, the Advisor desk, the case macro editor and the phone Admin
-- desk keep the organization-wide list they read today. The refusal rule does
-- not change in either mode, and the argument can narrow the answer but never
-- widen it. A zero-argument call resolves to this function through the
-- default.
begin;

-- Replace only the exact predecessor 20261106130000 installed.
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_staff_roster()'::regprocedure)) <> '7d43ad41668b217978179b132c6a69c4' then raise exception 'unreviewed predecessor: public.get_staff_roster' using errcode='55000'; end if;
  if exists(select 1 from private.account_lifecycle_trigger_review where kind='function' and schema_name='public' and object_name='get_staff_roster()') then raise exception 'unexpected trigger receipt: public.get_staff_roster' using errcode='55000'; end if;
end;
$preflight$;

drop function public.get_staff_roster();

CREATE OR REPLACE FUNCTION public.get_staff_roster(p_chapter_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  caller_org_wide boolean := private.has_organization_role(
    caller_org, array['admin', 'coordinator', 'advisor', 'vp']
  );
  -- The organization-wide list is read only when it is held and not narrowed.
  org_wide_view boolean := caller_org_wide and not coalesce(p_chapter_only, false);
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (
       caller_org_wide
       or private.member_has_chapter_role(
         caller_chapter, array['admin', 'coordinator', 'advisor', 'vp']
       )
     ) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', s.id,
      'fullName', s.full_name,
      'initials', s.initials,
      'memberSince', s.member_since,
      'chapterId', s.chapter_id,
      'chapterName', s.chapter_name,
      'roles', s.roles
    ) order by s.full_name, s.id)
    from (
      select p.id, p.full_name, p.initials, p.member_since,
        located.chapter_id, located.chapter_name,
        private.organization_member_roles(
          p.id, caller_org, case when org_wide_view then null else caller_chapter end
        ) as roles
      from (select access_row.* from public.member_profiles access_row where (access_row.id = (select auth.uid()) or access_row.id in (select private.staff_visible_member_ids(readable_role) from pg_catalog.unnest(array['steward','coordinator','advisor','admin','vp']) readable_role))) p
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = caller_org
       and om.status = 'active'
      join lateral (
        select c.id as chapter_id, c.name as chapter_name
        from public.member_chapter_memberships cm
        join public.chapters c
          on c.id = cm.chapter_id
         and c.organization_id = caller_org
        where cm.user_id = p.id
          and cm.status = 'active'
          and (org_wide_view or c.id = caller_chapter)
        order by (c.id = p.chapter_id) desc, c.order_index, c.id
        limit 1
      ) located on true
      where private.organization_member_roles(
        p.id, caller_org, case when org_wide_view then null else caller_chapter end
      ) <> '[]'::jsonb
      order by p.full_name, p.id
      limit 200
    ) s
  ), '[]'::jsonb);
end;
$function$
;

-- The predecessor's grants, exactly: signed-in callers only (20261102174600
-- took execute away from service_role).
revoke all on function public.get_staff_roster(boolean) from public, anon, service_role;
grant execute on function public.get_staff_roster(boolean) to authenticated;

commit;
