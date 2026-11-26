-- Keep organization-knowledge authorization private without breaking every
-- other authenticated storage bucket. The original storage.objects policies
-- selected organization_knowledge_files directly even though authenticated
-- intentionally has no table grant. PostgreSQL may evaluate that policy while
-- authorizing an unrelated bucket, so a valid case-file upload failed with a
-- permission error before its own bucket policy could authorize it.
--
-- These narrowly executable SECURITY DEFINER predicates preserve the table
-- revoke, fail closed before touching tenant state for every other bucket,
-- retain the existing tenant, lifecycle, and actor checks, and add the same MFA
-- gate used by the knowledge authorization RPCs.

begin;

set local lock_timeout = '5s';

drop index if exists public.organization_knowledge_files_storage_path_key;
create unique index organization_knowledge_files_storage_path_key
  on public.organization_knowledge_files (storage_path)
  where storage_path <> 'pending';

create or replace function private.can_insert_organization_knowledge_object(
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
    when private.current_member_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.created_by = (select auth.uid())
        and file.organization_id = private.mi1_w2_selected_organization()
        and file.review_status = 'pending_scan'
    )
  end
$function$;

create or replace function private.can_read_organization_knowledge_object(
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
    when private.current_member_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.organization_id = private.mi1_w2_selected_organization()
        and (
          private.has_organization_role(
            file.organization_id,
            array['steward', 'coordinator', 'advisor', 'admin', 'vp']
          )
          or (
            private.is_organization_member(file.organization_id)
            and file.published_to_catalog
            and file.review_status = 'approved'
            and file.scan_status = 'clean'
          )
        )
    )
  end
$function$;

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
    when private.current_member_organization() is null then false
    else exists (
      select 1
      from public.organization_knowledge_files file
      where file.storage_path = p_name
        and file.created_by = (select auth.uid())
        and file.organization_id = private.mi1_w2_selected_organization()
        and file.review_status = 'pending_scan'
        and file.scan_status = 'pending'
    )
  end
$function$;

revoke all on function private.can_insert_organization_knowledge_object(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.can_read_organization_knowledge_object(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.can_delete_organization_knowledge_object(text, text)
  from public, anon, authenticated, service_role;

grant execute on function private.can_insert_organization_knowledge_object(text, text)
  to authenticated;
grant execute on function private.can_read_organization_knowledge_object(text, text)
  to authenticated;
grant execute on function private.can_delete_organization_knowledge_object(text, text)
  to authenticated;

drop policy if exists organization_knowledge_objects_insert on storage.objects;
create policy organization_knowledge_objects_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'organization-knowledge'
    and (select private.mfa_satisfied())
    and private.can_insert_organization_knowledge_object(bucket_id, name)
  );

drop policy if exists organization_knowledge_objects_read on storage.objects;
create policy organization_knowledge_objects_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'organization-knowledge'
    and (select private.mfa_satisfied())
    and private.can_read_organization_knowledge_object(bucket_id, name)
  );

drop policy if exists organization_knowledge_objects_delete on storage.objects;
create policy organization_knowledge_objects_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'organization-knowledge'
    and (select private.mfa_satisfied())
    and private.can_delete_organization_knowledge_object(bucket_id, name)
  );

commit;
