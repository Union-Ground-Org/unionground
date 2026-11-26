-- UX-UG-HALF-DONE-THE-MICROSITE-HIERARCHY-EDITOR-DEAD-ENDS-AT-PUBLIC-CHAPTER-PROFILE-20260921
--
-- public_site_records rows are written by SECURITY DEFINER routines
-- (upsert_public_chapter_profile and the reviewed seed/cleanup routines); no
-- product client writes the table directly. The direct authenticated
-- INSERT/UPDATE policies checked only the written organization and a staff
-- role, so they bypassed the profile RPC's chapter-ownership binding. Mirror
-- 20260920010000_public_chapter_microsite_rpc_only_writes: keep the staff read
-- policy and SELECT privilege, keep the reviewed DELETE policy and privilege
-- (20260920012000_public_site_chapter_parent_delete_guard), and remove direct
-- authenticated INSERT/UPDATE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke insert, update on public.public_site_records from authenticated;

drop policy if exists public_site_records_staff_create on public.public_site_records;
drop policy if exists public_site_records_staff_update on public.public_site_records;

notify pgrst, 'reload schema';

commit;
