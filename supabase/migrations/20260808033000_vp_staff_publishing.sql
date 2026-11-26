-- REQ-UNION-BASE-PRESIDENT-STAFF-PUBLISHING-RLS-20260807
--
-- The President plane (role key "vp") renders the space/document/record
-- publishing controls — STAFF_TOOL_ROLES (src/lib/staffPlanes.js) includes
-- "vp" and ProductHubView gates every staff action on it — but the staff
-- create/write policies shipped by 20260727211853_full_product_completion
-- allow only steward/coordinator/advisor/admin, so a President submission
-- died at RLS after the form was already filled in. Handshake creation,
-- governance writes, and staff reads always included vp; publishing was the
-- one gap.
--
-- GRANT — vp joins the staff publishing roles on all three tables
-- rather than losing the controls, because the President plane should be able
-- to publish at least what stewards can. alter policy keeps each policy's
-- name, command, and role list exactly as scripts/db-contract.json pins them;
-- only the role array inside the qual/with_check grows.

alter policy chapter_spaces_staff_create on public.chapter_spaces
  with check (chapter_id = private.current_member_chapter() and created_by = (select auth.uid()) and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));
alter policy chapter_spaces_staff_write on public.chapter_spaces
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));

alter policy chapter_documents_staff_create on public.chapter_documents
  with check (chapter_id = private.current_member_chapter() and created_by = (select auth.uid()) and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));
alter policy chapter_documents_staff_write on public.chapter_documents
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));

alter policy chapter_records_staff_create on public.chapter_records
  with check (chapter_id = private.current_member_chapter() and created_by = (select auth.uid()) and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));
alter policy chapter_records_staff_write on public.chapter_records
  using (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']))
  with check (chapter_id = private.current_member_chapter() and public.member_has_role(array['steward','coordinator','advisor','admin','vp']));
