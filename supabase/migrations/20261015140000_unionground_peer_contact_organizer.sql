-- Union Ground: Organizers may use staff peer contact (
-- 2026-10-15: peer contact is one-to-one organizing and stays).
--
-- private.member_peer_staff_eligible() decides who may list, send and accept
-- a staff peer-contact request (public.list_reward_peer_contact,
-- request_reward_peer_contact and respond_reward_peer_contact). Its two role
-- lists named the steward, coordinator, advisor, admin and vp hats but not the
-- Organizer hat that 20261014001000 added, so the people doing one-on-ones were
-- refused. Re-emitted from 20261007012625 with 'organizer' added to both lists,
-- beside 'steward'; everything else, including the active-membership, account,
-- recovery-lock and staff two-step sign-in checks, is unchanged. Organization-
-- wide grants cannot hold 'organizer' (organization_role_grants_role_check), so
-- in practice the hat comes from member_role_chapters; the first list carries
-- it too so the two stay symmetrical.

begin;
set local lock_timeout = '5s';

create or replace function private.member_peer_staff_eligible(p_user_id uuid, p_chapter_id text)
returns boolean language sql stable security definer set search_path = ''
as $staff$
  select exists (
    select 1 from public.member_profiles profile
    join auth.users account on account.id = profile.id
    join public.chapters chapter on chapter.id = profile.chapter_id
    join public.organizations organization on organization.id = chapter.organization_id and organization.status = 'active'
    join public.organization_memberships om on om.user_id = profile.id and om.organization_id = organization.id and om.status = 'active'
    join public.member_chapter_memberships cm on cm.user_id = profile.id and cm.chapter_id = chapter.id and cm.status = 'active'
    where profile.id = p_user_id and chapter.id = p_chapter_id
      and account.deleted_at is null and coalesce(account.banned_until, '-infinity'::timestamptz) <= now()
      and not exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = profile.id)
      and (
        exists (select 1 from public.organization_role_grants grant_row where grant_row.user_id = profile.id
          and grant_row.organization_id = organization.id and grant_row.role in ('steward','organizer','coordinator','advisor','admin','vp'))
        or exists (select 1 from public.member_role_chapters grant_row where grant_row.user_id = profile.id
          and grant_row.chapter_id = chapter.id and grant_row.role in ('steward','organizer','coordinator','advisor','admin','vp'))
      )
      and (not private.staff_mfa_required(organization.id) or private.has_second_factor(profile.id)
        -- The caller's key assurance must belong to the current JWT. A peer
        -- has no caller JWT here, so only that peer may use its own live key.
        or (profile.id is distinct from (select auth.uid())
          and exists (select 1 from private.verified_key_sessions key_session where key_session.user_id = profile.id
            and private.verified_key_session(profile.id, key_session.session_id))))
  );
$staff$;
revoke all on function private.member_peer_staff_eligible(uuid,text) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
