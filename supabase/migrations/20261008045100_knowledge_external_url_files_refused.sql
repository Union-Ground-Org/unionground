-- BUG-UG-WEB-CATALOG-EXTERNAL-URL-FILES-UNDOWNLOADABLE-20261003
--
-- organization_knowledge_files.storage_kind admitted 'external_url', but every
-- download resolves to the organization-knowledge bucket, so such a row could
-- never be opened and the member was told the file needed a fresh safety check.
-- Serving the link instead would hand members an unscanned file, which the
-- upload policy forbids (every served file carries a scan verdict).
-- Controller decision, October 5, 2026: refuse them.
--   * New external files and changes to legacy storage locations are refused.
--     Unrelated legacy-row updates remain possible, including the uploader
--     foreign key's ON DELETE SET NULL. Existing rows are counted for operators.
--   * get_knowledge_file_storage_target refuses an existing external_url row
--     with DETAIL knowledge_file_external_unsupported, which the client
--     translates. The body is the installed definition read with
--     pg_get_functiondef from a disposable stack at Main, with only that
--     refusal added, behind a prosrc predecessor guard.
--
-- Hosted application needs the owner's separate go-ahead.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessor$
declare
  installed text;
  external_rows bigint;
begin
  select pg_catalog.md5(p.prosrc) into strict installed
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_knowledge_file_storage_target(uuid, uuid, text)'::regprocedure;
  if installed is distinct from '3501c0f7158b3adeb27a5ecfa3aa4a8e' then
    raise exception 'unreviewed get_knowledge_file_storage_target predecessor: %', installed
      using errcode = '55000';
  end if;
  select pg_catalog.count(*) into external_rows
    from public.organization_knowledge_files
   where storage_kind is distinct from 'organization_storage';
  raise notice 'organization_knowledge_files rows not stored in organization storage: %', external_rows;
end;
$predecessor$;

create function private.refuse_external_knowledge_file_write()
returns trigger
language plpgsql
set search_path = ''
as $guard$
begin
  if new.storage_kind is distinct from 'organization_storage' then
    if tg_op = 'INSERT' then
      raise exception 'external knowledge files are unsupported'
        using errcode = '23514', detail = 'knowledge_file_external_unsupported';
    elsif new.storage_kind is distinct from old.storage_kind
       or new.storage_path is distinct from old.storage_path
       or new.storage_handle is distinct from old.storage_handle then
      raise exception 'external knowledge files are unsupported'
        using errcode = '23514', detail = 'knowledge_file_external_unsupported';
    end if;
  end if;
  return new;
end;
$guard$;

revoke all on function private.refuse_external_knowledge_file_write()
  from public, anon, authenticated, service_role;

create trigger organization_knowledge_files_refuse_external_write
before insert or update on public.organization_knowledge_files
for each row execute function private.refuse_external_knowledge_file_write();

CREATE OR REPLACE FUNCTION public.get_knowledge_file_storage_target(p_file_id uuid, p_storage_handle uuid, p_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_w2_selected_organization();
  file public.organization_knowledge_files%rowtype;
begin
  if not private.mfa_satisfied() or p_mode not in ('upload', 'steward_download', 'catalog_download') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into file from public.organization_knowledge_files source
  where source.id = p_file_id and source.organization_id = org;
  if not found or file.storage_handle is distinct from p_storage_handle then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if p_mode = 'upload' then
    if file.created_by is distinct from (select auth.uid())
       or file.review_status <> 'pending_scan' then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  elsif p_mode = 'steward_download' then
    if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
      raise exception 'not authorized' using errcode = '42501';
    end if;
    perform private.mi1_w2_download_knowledge_file(file.id, false);
  else
    perform private.mi1_w2_download_knowledge_file(file.id, true);
  end if;
  if file.storage_kind is distinct from 'organization_storage' then
    raise exception 'file is not stored here' using errcode = '22023', detail = 'knowledge_file_external_unsupported';
  end if;
  return pg_catalog.jsonb_build_object(
    'fileId', file.id,
    'bucketId', 'organization-knowledge',
    'objectName', file.storage_path,
    'fileName', file.file_name,
    'mimeType', file.mime_type,
    'storageHandle', file.storage_handle
  );
end;
end;
$function$;

-- Review only the trigger and function introduced here. Account deletion can
-- reach this trigger through created_by ON DELETE SET NULL; neither created_by
-- nor any other attribution field participates in its refusal condition.
-- The guard writes no rows and has no transitive application-function calls.
do $review_external_storage_guard$
declare
  reviewed integer;
begin
  insert into private.account_lifecycle_trigger_review
    (kind, schema_name, table_name, object_name, definition_hash)
  select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
    from private.account_lifecycle_trigger_surface() s
   where (s.kind = 'trigger' and s.schema_name = 'public'
       and s.table_name = 'organization_knowledge_files'
       and s.object_name = 'organization_knowledge_files_refuse_external_write')
      or (s.kind = 'function' and s.schema_name = 'private' and s.table_name = ''
       and s.object_name = 'refuse_external_knowledge_file_write()');
  get diagnostics reviewed = row_count;
  if reviewed <> 2 then
    raise exception 'external storage guard review did not insert exactly two entries';
  end if;
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after external storage refusal';
  end if;
end;
$review_external_storage_guard$;

commit;
