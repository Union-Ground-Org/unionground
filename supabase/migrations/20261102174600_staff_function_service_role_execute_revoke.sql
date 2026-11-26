-- BUG-UG-HOSTED-SERVICE-ROLE-EXECUTE-DRIFT-20261102 (#6764)
-- Revoke the hosted default service_role grant on 17 staff functions.
--
-- Main's push CI job "Deployed database drift and Main image cache" (job
-- 125437020656, November 2, 2026) found 17 of 29498 contract checks
-- disagreeing with Production: each function below shows EXECUTE for
-- authenticated and service_role, while scripts/db-contract.json expects
-- authenticated only. Their creating migrations revoked EXECUTE from public
-- and anon (some also authenticated) before granting authenticated. On the
-- hosted projects, functions that postgres creates in schema public also
-- receive a default EXECUTE grant for service_role, so Production has carried
-- service_role=X/postgres on each since creation (read-only read, November 2,
-- 2026). The contract listed authenticated,service_role for them until #6682
-- re-pinned it to authenticated without a revoke; the disposable CI database
-- has no such default, so pull-request CI passed, and the deployed check went
-- red once 20261102005607 was applied and its baseline moved past #6682.
-- 20261102005607 replaces these bodies with CREATE OR REPLACE, which keeps the
-- ACL, so the apply did not add the grant.
--
-- Every function here keys its answer on auth.uid() or a caller-role helper,
-- service_role has no auth.uid(), and no application path calls them as
-- service_role, so this changes no behaviour. Revoking a privilege that was
-- never granted is a no-op, so each statement is safe on every target and on
-- a repeat run; authenticated keeps EXECUTE. Same repair as 20261031020500.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

revoke execute on function public.form_owner_in_steward_scope(uuid) from service_role;
revoke execute on function public.get_admin_events() from service_role;
revoke execute on function public.get_broadcast_read_counts() from service_role;
revoke execute on function public.get_staff_roster() from service_role;
revoke execute on function public.get_steward_badge_counts() from service_role;
revoke execute on function public.get_steward_chapter_member_count() from service_role;
revoke execute on function public.assign_member_case(uuid, uuid, uuid) from service_role;
revoke execute on function public.list_member_case_assignment_candidates(uuid) from service_role;
revoke execute on function public.open_form_as_case(uuid) from service_role;
revoke execute on function public.retract_member_broadcast(text) from service_role;
revoke execute on function public.return_form(uuid, text) from service_role;
revoke execute on function public.list_intake_triage_owners() from service_role;
revoke execute on function public.convert_member_intake_report(uuid, text, uuid) from service_role;
revoke execute on function public.steward_start_review(uuid) from service_role;
revoke execute on function public.list_vp_case_reviews() from service_role;
revoke execute on function public.update_chapter_document_content(uuid, text, text, text, text, text, text) from service_role;
revoke execute on function public.create_member_contact_note(uuid, text, uuid) from service_role;

commit;
