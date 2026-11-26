begin;

-- SEC-UG-CLEANROOM-UPLOAD-SECURITY-20260904 — slice 4 repairs.
--
-- 20260906020000 moved every private-upload workflow gate onto the single
-- predicate private.private_upload_is_current(bucket_id, object_name) and
-- retired public.organization_knowledge_files.scan_status as a malware
-- verdict. A verification sweep of the merged head found four places where
-- that change was incomplete. Each is repaired here, forward-only.
--
-- 1. public.list_resource_catalog_page was missed. It is the PAGINATED twin of
--    public.list_resource_catalog, it is the one the web client actually calls
--    (src/features/knowledge/knowledgeApi.js loadKnowledgeWorkspace), it is
--    granted to `authenticated`, and it still filtered on
--    `source.scan_status = 'clean'`. Both halves of that are wrong now:
--      * Availability — complete_steward_library_upload pins scan_status at
--        'pending' and replace_knowledge_source_chunks no longer writes
--        'clean', so no newly published file could ever appear in the member
--        catalog again.
--      * Security — the SAMPLE seed's fabricated scan_status='clean' rows kept
--        being listed with no ledger consultation at all.
--    It now uses exactly the predicate list_resource_catalog uses.
--
-- 2. private.can_read_organization_knowledge_object's member branch is
--    UNGATED again. 20260906020000 replaced its stale `scan_status = 'clean'`
--    with private_upload_is_current, but that helper is also the knowledge-kind
--    ACL inside public.authorize_private_upload_inspection (20260905034500),
--    so a lapsed verdict — which happens by design within 24 h, because
--    clean_until = least(now()+24h, signature_updated_at+48h) — locked a plain
--    member out of the very re-inspection that would renew it. This is exactly
--    the argument 20260906020000 already made for leaving the STAFF branch
--    ungated; it simply was not applied to the member branch. Removing the
--    conjunct opens no read: the restrictive private_upload_quarantine_read
--    policy (20260905021500) evaluates private_upload_is_current on every
--    object.get_authenticated independently, so quarantined bytes stay
--    quarantined either way. This helper governs only who may ASK.
--
-- 3+4. public.cancel_steward_library_upload and
--    private.can_delete_organization_knowledge_object both scoped the
--    uploader's own cleanup window with `review_status = 'pending_scan' and
--    scan_status = 'pending'`. A successful ingest used to flip scan_status to
--    'clean' and close that window; scan_status is now permanently 'pending',
--    which silently widened both windows to "until a steward reviews it".
--    DECISION: keep the pre-20260906020000 lifecycle exactly, expressed in the
--    column that still carries it. The window is "uploaded but not yet
--    ingested", which is `index_status = 'pending'` — replace_knowledge_source_chunks
--    still writes index_status 'chunked' on success and 'failed' on an ingest
--    error, so both outcomes close the window at precisely the moment the old
--    scan_status write did. public.authorize_knowledge_ingest already made this
--    same substitution in 20260906020000 for its uploader-self-service branch.
--    Deleting quarantined bytes stays possible for the uploader before ingest,
--    which is the property invariant 3 and the 'object.delete_many' arm of the
--    quarantine policy require.

-- ---------------------------------------------------------------------------
-- 1. Paginated member catalog listing.
-- ---------------------------------------------------------------------------
create or replace function public.list_resource_catalog_page(
  p_query text,
  p_category text,
  p_cursor_created_at timestamptz,
  p_cursor_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  needle text := nullif(pg_catalog.btrim(coalesce(p_query, '')), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if needle is not null and pg_catalog.char_length(needle) > 120 then
    raise exception 'search is too long' using errcode = '22023';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid page cursor' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', catalog_page.id,
      'title', catalog_page.title,
      'summary', catalog_page.summary,
      'category', catalog_page.category,
      'fileName', catalog_page.file_name,
      'byteSize', catalog_page.byte_size,
      'createdAt', catalog_page.created_at
    ) order by catalog_page.created_at desc, catalog_page.id)
    from (
      select source.id, source.title, source.summary, source.category,
             source.file_name, source.byte_size, source.created_at
      from public.organization_knowledge_files source
      where source.organization_id = org
        and source.published_to_catalog
        and source.review_status = 'approved'
        and (source.storage_kind <> 'organization_storage'
          or private.private_upload_is_current('organization-knowledge', source.storage_path))
        and (p_category is null or source.category = p_category)
        and (
          needle is null
          or pg_catalog.strpos(pg_catalog.lower(source.title), pg_catalog.lower(needle)) > 0
          or pg_catalog.strpos(pg_catalog.lower(source.summary), pg_catalog.lower(needle)) > 0
        )
        and (
          p_cursor_created_at is null
          or source.created_at < p_cursor_created_at
          or (source.created_at = p_cursor_created_at and source.id > p_cursor_id)
        )
      order by source.created_at desc, source.id
      limit 80
    ) catalog_page
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Storage read predicate: who may ASK, not what may be read.
-- ---------------------------------------------------------------------------
-- Neither branch carries a verdict clause. This helper is consulted by
-- public.authorize_private_upload_inspection as the knowledge-kind ACL, so a
-- verdict clause here is circular: it would deny the inspection that renews the
-- verdict. A steward could not get another member's pending upload inspected,
-- and a member could not renew their own catalog file after its 24 h
-- clean_until lapsed. Reads themselves stay bound by the restrictive
-- private_upload_quarantine_read policy on storage.objects, which evaluates
-- private.private_upload_is_current on every authenticated download.
create or replace function private.can_read_organization_knowledge_object(p_bucket_id text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select case
    when p_bucket_id is distinct from 'organization-knowledge' then false
    when not private.mfa_satisfied() then false
    when private.current_mobile_staff_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.organization_id = private.current_mobile_staff_organization()
        and (
          private.has_organization_role(
            file.organization_id,
            array['steward', 'coordinator', 'advisor', 'admin', 'vp']
          )
          or (
            private.is_organization_member(file.organization_id)
            and file.published_to_catalog
            and file.review_status = 'approved'
          )
        )
    )
  end
$function$;

-- ---------------------------------------------------------------------------
-- 3. Uploader's own pre-ingest cancellation.
-- ---------------------------------------------------------------------------
-- `scan_status = 'pending'` is now permanently true and no longer bounds
-- anything; `index_status = 'pending'` is the same lifecycle window it used to
-- express, and it closes on both ingest outcomes.
create or replace function public.cancel_steward_library_upload(p_file_id uuid, p_storage_handle uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  delete from public.organization_knowledge_files file
  where file.id = p_file_id
    and file.organization_id = org
    and file.created_by = (select auth.uid())
    and file.storage_handle = p_storage_handle
    and file.review_status = 'pending_scan'
    and file.index_status = 'pending';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  return pg_catalog.jsonb_build_object('fileId', p_file_id, 'cancelled', true);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Uploader's own pre-ingest Storage delete predicate.
-- ---------------------------------------------------------------------------
-- Same substitution, same window. Deleting quarantined bytes deliberately
-- stays possible: this arm mirrors 'object.delete_many' in the
-- private_upload_quarantine_read policy and must never be gated on a verdict.
create or replace function private.can_delete_organization_knowledge_object(
  p_bucket_id text,
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_bucket_id is distinct from 'organization-knowledge' then false
    when not private.mfa_satisfied() then false
    when private.current_mobile_staff_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.created_by = (select auth.uid())
        and file.organization_id = private.current_mobile_staff_organization()
        and file.review_status = 'pending_scan'
        and file.index_status = 'pending'
    )
  end
$function$;

notify pgrst, 'reload schema';
commit;
