-- REQ-UG-INVITE-RIGHTS-AND-ACCESS-REQUESTS-20261030 (#6561)
--
-- In the Oct 29-30, 2026 role-play run (finding 26), a President found no way
-- to invite anyone. Only a chapter admin, or the President of the selected
-- chapter (a member_role_chapters vp row), could invite; an organization-wide
-- vp grant alone was refused by design (20261004040000). a project decision of
-- October 30, 2026 (least privilege, no new trust boundary): an
-- organization-wide President invites members directly with the same form
-- and limits as a chapter President.
--
-- private.member_invitation_chapter_presided(p_chapter_id) now also holds for
-- the holder of an organization-wide vp grant in the organization of the
-- caller's selected chapter, for any chapter of that organization. Every
-- invitation path already asks only this function, so create, list, resend,
-- revoke and delivery recording follow it, with everything else unchanged:
--   * a President still invites plain members only (no starting access) and
--     sees and manages only plain-member invitations;
--   * the admin path, the former-member path (organization admin only), the
--     rate limits (consume_member_invitation_admin_limit) and the
--     no-enumeration answers are unchanged;
--   * private.has_organization_role carries the same MFA, selected
--     organization, active membership and staff second-factor checks as
--     private.member_has_chapter_role.
-- Invitation suggestions by Stewards and Members and elevated-access
-- requests are a separate record (split by a project decision).

begin;

create or replace function private.member_invitation_chapter_presided(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (
    private.member_has_chapter_role(p_chapter_id, array['vp'])
    and exists (
      select 1
      from public.member_profiles p
      join public.chapters selected on selected.id = p.chapter_id
      join public.chapters target on target.id = p_chapter_id
      join public.member_role_chapters rc
        on rc.user_id = p.id and rc.chapter_id = target.id and rc.role = 'vp'
      where p.id = (select auth.uid())
        and selected.organization_id is not null
        and target.organization_id = selected.organization_id
    )
  ) or exists (
    select 1
    from public.member_profiles p
    join public.chapters selected on selected.id = p.chapter_id
    join public.chapters target on target.id = p_chapter_id
    where p.id = (select auth.uid())
      and selected.organization_id is not null
      and target.organization_id = selected.organization_id
      and private.has_organization_role(target.organization_id, array['vp'])
  );
$function$;

revoke all on function private.member_invitation_chapter_presided(text)
  from public, anon, authenticated, service_role;

comment on function private.member_invitation_chapter_presided(text) is
  'True when the caller presides over the target chapter in the organization of the caller''s selected chapter: the chapter-scoped vp (President) role for that chapter with an active membership, or an organization-wide vp grant in that organization (REQ-UG-INVITE-RIGHTS-AND-ACCESS-REQUESTS-20261030). A President invites plain members only.';

notify pgrst, 'reload schema';

commit;
