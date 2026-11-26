begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4 repairs, part two.
--
-- The last client-visible trace of the retired malware flag.
--
-- 20260906020000 stopped organization_knowledge_files.scan_status being a
-- verdict: public.complete_steward_library_upload writes 'pending' once as a
-- workflow marker for the row's own lifecycle, public.replace_knowledge_source
-- _chunks no longer moves it, and every gate, ACL, catalog reader and download
-- path was moved onto private.private_upload_is_current. One projection was
-- missed. private.mi1_w2_project_knowledge_file is the shared row-shaping
-- helper behind every steward-library payload — list, upload completion,
-- review, publish — and it still emitted
--
--     'scanStatus', f.scan_status,
--
-- so every steward-library row shipped `scanStatus: "pending"` to the client,
-- permanently, for the rest of its life.
--
-- Nothing consumes it today: the one client comment that mentions the name
-- (src/features/knowledge/KnowledgeWorkspacePanel.jsx) exists precisely to
-- record that approve and publish stopped being gated on it. The problem is
-- what the field invites next. It reads like a malware verdict, it is the only
-- surviving client-visible trace of the column, and a later contributor who
-- re-introduced `scanStatus === "clean"` anywhere would be inventing a gate
-- that can never be satisfied — a client-side check that silently denies
-- everything, which is the exact defect class this record exists to close.
-- Both catalog readers and the storage ACL now carry contract-level
-- `bodyForbids` guards against scan_status; this projection had none.
--
-- The pair is therefore dropped rather than renamed. `indexStatus` and
-- `reviewStatus` are still projected and are the two lifecycle fields the
-- panel actually reads; ingest health lives in index_status and
-- organization_knowledge_sources.health, per invariant 7. The column itself is
-- left in place: it is still written once by complete_steward_library_upload
-- as a row-local workflow marker, and dropping it is a schema change with its
-- own review, not a projection fix.
--
-- Everything else in the body is byte-identical to the original declaration in
-- 20260826151000_mi1_w2_feature_persistence.sql:1769-1798.

create or replace function private.mi1_w2_project_knowledge_file(p_file_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', f.id,
    'organizationId', f.organization_id,
    'chapterId', f.chapter_id,
    'library', f.library,
    'title', f.title,
    'summary', f.summary,
    'category', f.category,
    'docType', f.doc_type,
    'fileName', f.file_name,
    'byteSize', f.byte_size,
    'storageHandle', f.storage_handle,
    'reviewStatus', f.review_status,
    'indexStatus', f.index_status,
    'visibility', f.visibility,
    'publishedToCatalog', f.published_to_catalog,
    'createdAt', f.created_at,
    'updatedAt', f.updated_at
  )
  from public.organization_knowledge_files f
  where f.id = p_file_id
$function$;

-- The helper is internal: it was revoked from every role in 20260826151000 and
-- `create or replace` preserves that. Re-stated so the grant surface of this
-- migration is readable on its own.
revoke all on function private.mi1_w2_project_knowledge_file(uuid)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
