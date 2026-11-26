-- BUG-UG-GRANTING-RESTRICTED-CASE-ACCESS-COORDINATOR-CHOSEN-CHAPTER-SAVES-20261013
-- casework_grant_access accepted two grantees whom the restricted-case read rule then refused, so
-- the grant was saved and opened nothing. A grantee reaches a restricted case through
-- private.casework_staff_can_access, which needs public.staff_can_see_user(member, 'coordinator').
-- Its organization branch needs the grantee's active organization (private.current_member_organization)
-- to be the organization of the member's profile chapter, and the coordinator role in that
-- organization or on that chapter. Neither side is compared with the case organization:
--   * an organization coordinator with no selected active chapter, or whose active organization is
--     not the member's, has no current organization that matches;
--   * when the member's profile chapter has moved to another organization, an organization
--     coordinator of the case organization alone cannot reach them, while a
--     coordinator active in the member's new organization can.
-- The unreachable grantees are now refused with 22023 and the translated detail token
-- casework_grantee_outside_case_organization, before anything is written. The body is otherwise
-- the installed 20261006020000 definition; signature, grants and audit vocabulary are unchanged.
-- Hosted application needs a separate go-ahead from the maintainers.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $predecessor$
declare
  installed text;
begin
  select pg_catalog.md5(p.prosrc) into strict installed
    from pg_catalog.pg_proc p
   where p.oid = 'public.casework_grant_access(uuid, uuid, text)'::regprocedure;
  -- The reviewed predecessor is 20261006020000_casework_grant_access_reason.sql.
  if installed is distinct from '4025325c6cd55af3e17e6daff8e654fb' then
    raise exception 'unreviewed casework_grant_access predecessor: %', installed
      using errcode = '55000';
  end if;
end
$predecessor$;

create or replace function public.casework_grant_access(p_case_id uuid, p_grantee_user_id uuid, p_reason text)
returns public.casework_access_grants
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare v_case public.member_cases%rowtype; v_row public.casework_access_grants%rowtype; v_member_org uuid;
begin
  perform private.casework_require_mfa();
  select * into strict v_case from public.member_cases where id = p_case_id for share;
  if not private.casework_staff_can_access(v_case.id)
     or not (private.member_has_chapter_role(v_case.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role(v_case.organization_id, array['advisor','admin','vp']))
  then raise exception 'case not found' using errcode = 'P0002'; end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_reason, ''))) not between 8 and 500
  then raise exception 'grant reason must be 8 to 500 characters' using errcode = '22023', detail = 'casework_grant_reason_invalid'; end if;
  if not exists (select 1 from public.organization_memberships m where m.organization_id = v_case.organization_id and m.user_id = p_grantee_user_id and m.status = 'active')
     or not private.actor_has_chapter_staff_role(p_grantee_user_id, v_case.chapter_id)
  then raise exception 'grantee is not active chapter staff' using errcode = '22023'; end if;
  if not (
       exists (select 1 from public.organization_role_grants g
                where g.organization_id = v_case.organization_id and g.user_id = p_grantee_user_id and g.role = 'coordinator')
       or exists (select 1 from public.member_role_chapters rc
                    join public.member_chapter_memberships cm on cm.user_id = rc.user_id and cm.chapter_id = rc.chapter_id and cm.status = 'active'
                   where rc.user_id = p_grantee_user_id and rc.role = 'coordinator'
                     and rc.chapter_id = (select p.chapter_id from public.member_profiles p where p.id = v_case.user_id)))
  then raise exception 'only a coordinator can be given explicit access' using errcode = '22023', detail = 'casework_grantee_cannot_use_grant'; end if;
  -- The grantee then reads the case only through staff_can_see_user's organization branch: the
  -- grantee's active organization is the organization of the member's profile chapter, and the
  -- grantee is a coordinator of that organization or of that chapter. Otherwise the grant would be
  -- saved and still open nothing.
  v_member_org := (select ch.organization_id from public.member_profiles mp join public.chapters ch on ch.id = mp.chapter_id
                    where mp.id = v_case.user_id);
  if v_member_org is null
     or private.member_organization_for(p_grantee_user_id) is distinct from v_member_org
     or not (
       exists (select 1 from public.organization_role_grants g
                where g.organization_id = v_member_org and g.user_id = p_grantee_user_id and g.role = 'coordinator')
       or exists (select 1 from public.member_role_chapters rc
                    join public.member_chapter_memberships cm on cm.user_id = rc.user_id and cm.chapter_id = rc.chapter_id and cm.status = 'active'
                   where rc.user_id = p_grantee_user_id and rc.role = 'coordinator'
                     and rc.chapter_id = (select p.chapter_id from public.member_profiles p where p.id = v_case.user_id)))
  then raise exception 'grantee cannot reach this member through the case organization' using errcode = '22023', detail = 'casework_grantee_outside_case_organization'; end if;
  select * into v_row from public.casework_access_grants where case_id = v_case.id and grantee_user_id = p_grantee_user_id and revoked_at is null;
  if found then return v_row; end if;
  insert into public.casework_access_grants(case_id, organization_id, chapter_id, grantee_user_id, granted_by, reason)
  values (v_case.id, v_case.organization_id, v_case.chapter_id, p_grantee_user_id, (select auth.uid()), pg_catalog.btrim(p_reason)) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_case.organization_id, v_case.chapter_id, v_case.id, (select auth.uid()), 'access_granted', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', p_grantee_user_id));
  return v_row;
end;
end;
$function$;

revoke all on function public.casework_grant_access(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.casework_grant_access(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
commit;
