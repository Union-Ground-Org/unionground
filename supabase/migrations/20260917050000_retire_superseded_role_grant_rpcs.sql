begin;

-- REQ-UG-DORMANT-61-RETIRE-SWEEP-20260917 — retire-by-default.
--
-- BINDING DISPOSITION (recorded 2026-09-17; the "Superseded role-grant
-- RPCs disposition"). The admin command center has used the selected-tenant,
-- scope-aware role commands since the MI1 organization-scope migration. These
-- two older chapter-role RPCs have no application, API, worker, or edge caller.
-- Keeping executable definer entry points after every consumer has moved on is
-- an unaudited capability, not backwards compatibility.
--
--   public.grant_member_role(uuid, text, text)          RETIRED
--   public.revoke_member_role(uuid, text)               RETIRED
--
-- WHAT IT WOULD TAKE TO BRING ONE BACK: a new reviewed product decision that
-- names a caller, proves why public.set_member_organization_role or
-- public.set_member_chapter_role cannot meet that need, defines the exact
-- tenant and authorization boundary, and adds regression coverage. Recreating
-- an old SECURITY DEFINER RPC and granting EXECUTE is not sufficient.
--
-- ROLLBACK (requires that new decision): recreate the exact last scope-aware
-- definitions from 20260812230000_admin_command_center.sql and explicitly
-- restore their authenticated EXECUTE grants.

set local lock_timeout = '5s';

drop function public.grant_member_role(uuid, text, text);
drop function public.revoke_member_role(uuid, text);

notify pgrst, 'reload schema';
commit;
