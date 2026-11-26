begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Storage's authenticated metadata endpoint uses object.get_authenticated_info.
-- The former object.info_authenticated spelling never matched that operation.
-- Keep this a restrictive, authenticated SELECT policy: the feature's own
-- ownership/tenant/MFA policy must still allow the row, and metadata needs the
-- same current immutable-object scan verdict as an authenticated download.
-- Upload/delete operations retain their existing quarantine-cleanup exception;
-- signing, public reads and unknown operations receive no new permission.
-- Supabase permits ALTER POLICY here but reserves COMMENT ON POLICY to the
-- managed storage.objects owner (SQLSTATE 42501 for the migration role).
-- This file's reviewed convention exception retains the rationale above;
-- it does not change the vendor table's owner or migration-role privileges.
alter policy private_upload_quarantine_read on storage.objects using (
  bucket_id not in ('case-files','chapter-task-files','member-form-files','organization-knowledge')
  or storage.allow_any_operation(array['object.upload','object.delete_many'])
  or (storage.allow_any_operation(array['object.get_authenticated','object.list','object.get_authenticated_info'])
    and private.private_upload_is_current(bucket_id, name))
);

commit;
