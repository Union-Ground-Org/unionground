-- Revoke the default service_role grant on the chapter display-title setter.
--
-- 20261004050000 created public.set_member_chapter_display_title and revoked
-- EXECUTE from public, anon and authenticated before granting authenticated.
-- On the hosted projects, functions that postgres creates in schema public
-- also receive a default EXECUTE grant for service_role, so the setter keeps
-- that grant there, while scripts/db-contract.json expects authenticated only.
-- The setter requires an authenticated chapter admin with MFA, and service_role
-- has no auth.uid(), so this changes no behaviour. Revoking a privilege that
-- was never granted is a no-op, so the statement is safe on every target.
--
-- Hosted application: the same window as 20261004040000 and 20261004050000,
-- after them.

begin;

revoke execute on function public.set_member_chapter_display_title(uuid, text, text) from service_role;

commit;
