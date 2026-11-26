-- SEC-UG-ROSTER-INVITATION-SERVICE-ROLE-EXECUTE-20261026
-- Revoke the default service_role grant on the roster invitation create.
--
-- 20261022171700 created public.create_roster_member_invitation and revoked
-- EXECUTE from public, anon and authenticated before granting authenticated.
-- On the hosted projects, functions that postgres creates in schema public
-- also receive a default EXECUTE grant for service_role, so after the
-- October 26, 2026 apply both SAMPLE and Production show that grant, while
-- scripts/db-contract.json expects authenticated only. The function requires
-- an authenticated chapter administrator with MFA, and service_role has no
-- auth.uid(), so this changes no behaviour. Revoking a privilege that was
-- never granted is a no-op, so the statement is safe on every target. Same
-- repair as 20260813170000 and 20261005044000.
begin;

revoke execute on function public.create_roster_member_invitation(text, text, text, text, text) from service_role;

commit;
