begin;

-- REQ-UG-DORMANT-67-CATALOG-HANDOFF-READS-20260917 — retire-by-default.
--
-- BINDING DISPOSITION (recorded 2026-09-17). Four authenticated SECURITY
-- DEFINER readers shipped with MI1 W2 feature persistence and never gained a
-- client. Each is redundant with a guarded path the product already uses.
-- tests/retired-catalog-handoff-reads.test.js fails if a later migration,
-- client, API or script reintroduces one.
--
--   public.list_resource_catalog(text, text)                 RETIRED
--   public.get_resource_catalog_item(uuid)                   RETIRED
--   public.get_steward_library_file(uuid)                    RETIRED
--   public.get_member_steward_relationship(uuid)             RETIRED
--
-- WHY RETIRE, PER RPC.
--
-- 1. list_resource_catalog. src/features/knowledge/knowledgeApi.js
--    loadKnowledgeWorkspace calls list_resource_catalog_page. That paginated
--    twin already applies the same membership, MFA, published-and-approved,
--    and private.private_upload_is_current conjunct the 20260906020000
--    comment required: "the catalog list a member clicks to download must
--    hide quarantined files." The unpaged 80-row first page is a second copy
--    of that predicate with no caller. Keeping both was an invitation to
--    drift (the 20260906021000 repair existed because they already had).
--
-- 2. get_resource_catalog_item. No web or native caller fetches a single
--    catalog row. The workspace lists through list_resource_catalog_page
--    (id, title, summary, category, fileName, byteSize, createdAt) and
--    downloads through download_resource_catalog_item ->
--    private.mi1_w2_download_knowledge_file(..., true), which raises P0002
--    for a quarantined or unpublished row so a member cannot distinguish
--    "quarantined" from "absent". A third metadata getter is not a product
--    surface.
--
-- 3. get_steward_library_file. Staff listing goes through
--    list_steward_library_files_page, which projects each row through the
--    same private.mi1_w2_project_knowledge_file helper this getter used.
--    Downloads go through download_steward_library_file. Neither the
--    KnowledgeWorkspacePanel nor apps/mobile ever looks up one library file
--    by id. Staff library listing is supposed to show quarantined rows so a
--    steward can review them; hiding them here would have been the wrong
--    gate.
--
-- 4. get_member_steward_relationship. The product surface is the staff
--    Handoffs panel: list_member_handoffs_v2, search_handoff_members,
--    search_handoff_stewards, and initiate/acknowledge/decline/cancel.
--    src/features/memberSupport/adapter.js never calls this getter. The
--    current assignment is written inside private.mi1_w2_resolve_handoff
--    when a handoff is acknowledged; it is not a client-facing read. No
--    client selects public.member_steward_relationships.
--
-- WHAT IT WOULD TAKE TO BRING ONE BACK: a real caller that cannot use the
-- guarded twin, plus a regression that the twin does not already cover
-- (catalog: quarantined rows stay hidden; steward library: staff still see
-- reviewable rows; relationship: member/steward/oversee visibility).
-- Re-adding the function and grant is not that, and the guard test says so.
--
-- COLLATERAL. None. These four functions are not referenced from any other
-- function body, trigger, policy, or seed. list_resource_catalog_page,
-- download_resource_catalog_item, list_steward_library_files_page,
-- download_steward_library_file, and list_member_handoffs_v2 stay.
--
-- ROLLBACK (needs a new owner decision reversing the disposition, not just
-- these statements): restore the four bodies from
-- 20260906020000_private_upload_workflow_gates.sql (catalog pair) and
-- 20260826151000_mi1_w2_feature_persistence.sql (library get and
-- relationship get), re-revoke PUBLIC/anon/service_role, and re-grant
-- EXECUTE to authenticated.

set local lock_timeout = '5s';

-- Withdraw the client execute capability before the functions go, so a
-- session holding an old PostgREST schema cache fails closed on GRANT
-- rather than finding a missing function after a reload.
revoke all on function public.list_resource_catalog(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_resource_catalog_item(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_steward_library_file(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_member_steward_relationship(uuid)
  from public, anon, authenticated, service_role;

drop function public.list_resource_catalog(text, text);
drop function public.get_resource_catalog_item(uuid);
drop function public.get_steward_library_file(uuid);
drop function public.get_member_steward_relationship(uuid);

notify pgrst, 'reload schema';
commit;
