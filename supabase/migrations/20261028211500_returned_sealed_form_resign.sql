-- BUG-UG-RETURNED-SEALED-FORM-ATTACHMENTS-RESIGN-20261026 (#6105)
-- Follow-up to 20261028174500 (SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022).
-- The maintenance backfill freezes a submitted, in-review or approved sealed
-- filing's digest as legacyDigest so its existing signatures stay valid.
-- form_content_digest returned that frozen digest whatever the row's status,
-- so a steward return followed by an attachment change still matched the old
-- filer and cosigner signatures and submit_form accepted a resubmission nobody
-- had re-signed. The frozen digest now applies only while the row is still in
-- a frozen status with the content digest it was submitted under; a returned
-- or resubmitted form derives the live fingerprint over its sealed marker and
-- confirmed attachments, exactly as a never-backfilled sealed form does. The
-- sealed-template and stored-envelope conditions from 20261028174500 stay.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.form_content_digest(p_form_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- Only a sealed template's stored envelope makes the marker authoritative;
  -- an ordinary or legacy plaintext row's answers.legacyDigest is just an
  -- answer and never chooses the digest (#6363 round 1). The frozen digest
  -- covers a backfilled filing only while it stays in a frozen status with the
  -- digest it was submitted under: a returned form can change its attachments,
  -- so it and any later resubmission derive the live fingerprint (#6105).
  select case when private.form_template_is_sealed(f.template_key) and f.encrypted_content ? 'answers'
    and f.answers->>'sealed' = 'true' and f.answers ? 'legacyDigest'
    and f.status in ('submitted', 'in_review', 'approved')
    and f.content_digest = f.answers->>'legacyDigest' then f.answers->>'legacyDigest'
  else pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'formId', f.id,
      'templateKey', f.template_key,
      'templateVersion', f.template_version,
      'answers', f.answers,
      'attachments', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', ff.id, 'filename', ff.filename, 'mimeType', ff.mime_type,
          'sizeBytes', ff.size_bytes) order by ff.id)
        from public.member_form_files ff
        where ff.form_id = f.id and ff.confirmed_at is not null
      ), '[]'::jsonb)
    )::text, 'UTF8'), 'sha256'), 'hex') end
  from public.member_forms f where f.id = p_form_id;
$$;
revoke all on function private.form_content_digest(uuid)
  from public, anon, authenticated, service_role;

-- Refresh the lifecycle review entry, if the surface tracks this function.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private' and object_name = 'form_content_digest(p_form_id uuid)'
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

commit;
