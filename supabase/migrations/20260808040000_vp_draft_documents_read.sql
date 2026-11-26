-- REQ-UNION-BASE-PRESIDENT-STAFF-PUBLISHING-RLS-20260807 (follow-up)
--
-- Sol's adversarial review of 20260808033000_vp_staff_publishing caught the
-- half-grant: vp could now insert and update chapter_documents, but
-- chapter_documents_read gave the DRAFT branch only to
-- steward/coordinator/advisor/admin — vp read only published documents. The
-- client creates and updates through insert/update ... returning (memberApi
-- expectWrite uses .select().single()), so a President saving a draft would
-- have the write succeed and the returning select refused; drafts would also
-- be invisible to vp in the Library. Publishing is draft-then-publish, so the
-- grant is only end-to-end once vp reads what it can write. Same shape as the
-- original policy with vp joining the staff branch; spaces and records reads
-- never had this gap (can_read_chapter_space already includes vp plus a
-- creator fallback, chapter_records_read is chapter-wide).

alter policy chapter_documents_read on public.chapter_documents
  using (
    chapter_id = private.current_member_chapter()
    and (
      (status = 'published' and (visibility = 'chapter' or public.member_has_role(array['steward','coordinator','advisor','admin','vp'])))
      or public.member_has_role(array['steward','coordinator','advisor','admin','vp'])
    )
  );
