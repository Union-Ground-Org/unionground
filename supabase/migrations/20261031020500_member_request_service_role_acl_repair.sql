-- Revoke the default service_role grant on the member-request functions and
-- the officer member-directory export and probe.
--
-- Main's push CI (run 41336510434, "Deployed DB contract drift", November 1,
-- 2026) found 5 of 28124 contract checks disagreeing with Production: the five
-- public functions 20261030235900 created show EXECUTE for authenticated and
-- service_role, while scripts/db-contract.json expects authenticated only.
-- 20261030235900 revoked EXECUTE from public and anon before granting
-- authenticated. On the hosted projects, functions that postgres creates in
-- schema public also receive a default EXECUTE grant for service_role, so that
-- grant stayed; the disposable CI database has no such default, so pull-request
-- CI passed.
--
-- 20261031020000 (#6656, ahead of this in stamp order) creates
-- public.export_member_directory_csv and public.get_member_directory_access
-- with the same omission (revoked from public, anon and authenticated, then
-- granted to authenticated), so they are repaired here too. They are revoked
-- only where they exist: a database without 20261031020000 has nothing to
-- repair.
--
-- Every function here refuses a caller without auth.uid(), and service_role has
-- none, so this changes no behaviour. Revoking a privilege that was never
-- granted is a no-op, so each statement is safe on every target and on a
-- repeat run; authenticated keeps EXECUTE. Same repair as 20261026140000.

begin;

revoke execute on function public.submit_member_request(text, text, text, text, text) from service_role;
revoke execute on function public.list_my_member_requests(integer, timestamptz, uuid) from service_role;
revoke execute on function public.list_member_requests(text, integer, timestamptz, uuid) from service_role;
revoke execute on function public.decide_member_request(uuid, text) from service_role;
revoke execute on function public.approve_member_request_invitation(uuid, text, text, text) from service_role;

-- Inside the block the statement is spelled REVOKE ALL: on a function ALL is
-- exactly EXECUTE, and the conventions check reads a bare EXECUTE in a DO body
-- as dynamic SQL.
do $officer_directory$
begin
  if pg_catalog.to_regprocedure('public.export_member_directory_csv(uuid, text, text)') is not null then
    revoke all on function public.export_member_directory_csv(uuid, text, text) from service_role;
  end if;
  if pg_catalog.to_regprocedure('public.get_member_directory_access()') is not null then
    revoke all on function public.get_member_directory_access() from service_role;
  end if;
end;
$officer_directory$;

commit;
