begin;

-- A verdict belongs to one immutable Storage object, never merely to a path.
-- Tombstones intentionally outlive object deletion to prevent path reuse.
create table private.private_upload_scans (
  bucket_id text not null,
  object_name text not null,
  object_id uuid not null unique,
  object_version text,
  status text not null default 'pending' check (status in ('pending','clean','blocked','failed','deleted')),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  engine text,
  signature_version bigint,
  signature_updated_at timestamptz,
  scanned_at timestamptz,
  clean_until timestamptz,
  deleted_at timestamptz,
  primary key (bucket_id, object_name),
  check (bucket_id in ('case-files','chapter-task-files','member-form-files','organization-knowledge')),
  check (status <> 'clean' or (sha256 is not null and engine is not null
    and signature_version is not null and signature_version > 0 and signature_updated_at is not null
    and scanned_at is not null and clean_until is not null and clean_until > scanned_at and deleted_at is null))
);
alter table private.private_upload_scans enable row level security;
revoke all on table private.private_upload_scans from public, anon, authenticated, service_role;

create function private.track_private_upload_object()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  if tg_op = 'UPDATE' then
    if old.bucket_id in ('case-files','chapter-task-files','member-form-files','organization-knowledge')
       or new.bucket_id in ('case-files','chapter-task-files','member-form-files','organization-knowledge') then
      if new.id is distinct from old.id or new.bucket_id is distinct from old.bucket_id
        or new.name is distinct from old.name or new.version is distinct from old.version
        or new.metadata is distinct from old.metadata then
        raise exception 'private upload objects are immutable' using errcode = '42501';
      end if;
    end if;
    return new;
  elsif tg_op = 'INSERT' then
    if new.bucket_id in ('case-files','chapter-task-files','member-form-files','organization-knowledge') then
      -- A duplicate tombstone is an error, including for service-role uploads.
      insert into private.private_upload_scans (bucket_id, object_name, object_id, object_version)
      values (new.bucket_id, new.name, new.id, new.version);
    end if;
    return new;
  else
    if old.bucket_id in ('case-files','chapter-task-files','member-form-files','organization-knowledge') then
      update private.private_upload_scans set status = 'deleted', deleted_at = pg_catalog.now(), clean_until = null
      where bucket_id = old.bucket_id and object_name = old.name and object_id = old.id;
    end if;
    return old;
  end if;
end
$function$;
revoke all on function private.track_private_upload_object() from public, anon, authenticated, service_role;

create trigger private_upload_immutable before update on storage.objects
  for each row execute function private.track_private_upload_object();
create trigger private_upload_created after insert on storage.objects
  for each row execute function private.track_private_upload_object();
create trigger private_upload_deleted after delete on storage.objects
  for each row execute function private.track_private_upload_object();

-- Existing files receive no implicit clean attestation. The server must scan
-- them before authenticated access is restored.
insert into private.private_upload_scans (bucket_id, object_name, object_id, object_version)
select bucket_id, name, id, version from storage.objects
where bucket_id in ('case-files','chapter-task-files','member-form-files','organization-knowledge');

create function private.private_upload_is_current(p_bucket_id text, p_object_name text)
returns boolean language sql stable security definer set search_path = '' as $function$
  select ((select auth.uid()) is not null or (select auth.role()) = 'service_role') and exists (
    select 1 from private.private_upload_scans scan
    join storage.objects object on object.bucket_id = scan.bucket_id and object.name = scan.object_name
      and object.id = scan.object_id and object.version is not distinct from scan.object_version
    where scan.bucket_id = p_bucket_id and scan.object_name = p_object_name
      and scan.status = 'clean' and scan.deleted_at is null
      and scan.clean_until > pg_catalog.now()
      and scan.signature_updated_at > pg_catalog.now() - interval '48 hours'
  )
$function$;
revoke all on function private.private_upload_is_current(text,text) from public, anon, authenticated, service_role;
grant execute on function private.private_upload_is_current(text,text) to authenticated, service_role;

-- This restrictive policy intersects every existing feature authorization
-- policy. It never grants tenancy/case/task/form permission by itself.
-- Pending bytes may be inserted or deleted, but not downloaded or signed.
-- Signed URLs bypass future RLS evaluation; clients must use authenticated
-- downloads, which check the current verdict for every request.
create policy private_upload_quarantine_read on storage.objects
as restrictive for select to authenticated using (
  bucket_id not in ('case-files','chapter-task-files','member-form-files','organization-knowledge')
  or storage.allow_any_operation(array['object.upload','object.delete_many'])
  or (storage.allow_any_operation(array['object.get_authenticated','object.list','object.info_authenticated'])
    and private.private_upload_is_current(bucket_id, name))
);

update storage.buckets set file_size_limit = 10485760,
  allowed_mime_types = array[
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','text/plain','text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
where id in ('case-files','chapter-task-files','member-form-files','organization-knowledge');

create function private.record_private_upload_scan(
  p_bucket_id text, p_object_name text, p_object_id uuid, p_object_version text,
  p_verdict text, p_sha256 text, p_engine text, p_signature_version bigint,
  p_signature_updated_at timestamptz, p_scanned_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  object storage.objects%rowtype;
  previous private.private_upload_scans%rowtype;
  expires timestamptz;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'scanner service required' using errcode = '42501';
  end if;
  if p_verdict is null or p_verdict not in ('clean','blocked','failed') then
    raise exception 'invalid scanner verdict' using errcode = '22023';
  end if;
  -- Keep the Storage-row -> ledger-row lock order used by the triggers.
  select * into object from storage.objects
  where bucket_id = p_bucket_id and name = p_object_name for update;
  if object.id is null or object.id is distinct from p_object_id
    or object.version is distinct from p_object_version then
    raise exception 'stored object changed or unavailable' using errcode = '22023';
  end if;
  select * into previous from private.private_upload_scans
  where bucket_id = p_bucket_id and object_name = p_object_name for update;
  if previous.object_id is distinct from p_object_id or previous.deleted_at is not null
    or previous.object_version is distinct from p_object_version then
    raise exception 'stored object changed or unavailable' using errcode = '22023';
  end if;
  if p_verdict in ('clean','blocked') then
    if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
      or p_engine is null or p_engine !~ '^ClamAV [0-9]+\.[0-9]+\.[0-9]+$'
      or p_signature_version is null or p_signature_version <= 0
      or p_signature_updated_at is null or p_signature_updated_at < pg_catalog.now() - interval '48 hours'
      or p_signature_updated_at > pg_catalog.now() + interval '5 minutes'
      or p_scanned_at is null or p_scanned_at < pg_catalog.now() - interval '5 minutes'
      or p_scanned_at > pg_catalog.now() + interval '5 minutes' then
      raise exception 'invalid or stale scanner provenance' using errcode = '22023';
    end if;
    if previous.sha256 is not null and previous.sha256 is distinct from p_sha256 then
      raise exception 'immutable object digest changed' using errcode = '22023';
    end if;
    if previous.scanned_at > p_scanned_at or previous.signature_version > p_signature_version then
      raise exception 'older scan cannot supersede current verdict' using errcode = '22023';
    end if;
  end if;
  expires := case when p_verdict = 'clean' then least(
    pg_catalog.now() + interval '24 hours', p_signature_updated_at + interval '48 hours'
  ) else null end;
  update private.private_upload_scans set status = p_verdict,
    sha256 = coalesce(p_sha256, previous.sha256), engine = coalesce(p_engine, previous.engine),
    signature_version = coalesce(p_signature_version, previous.signature_version),
    signature_updated_at = coalesce(p_signature_updated_at, previous.signature_updated_at),
    scanned_at = coalesce(p_scanned_at, previous.scanned_at), clean_until = expires
  where bucket_id = p_bucket_id and object_name = p_object_name;
  return pg_catalog.jsonb_build_object('status', p_verdict, 'cleanUntil', expires);
end
$function$;
revoke all on function private.record_private_upload_scan(text,text,uuid,text,text,text,text,bigint,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.record_private_upload_scan(text,text,uuid,text,text,text,text,bigint,timestamptz,timestamptz)
  to service_role;

create function public.record_private_upload_scan(
  p_bucket_id text, p_object_name text, p_object_id uuid, p_object_version text,
  p_verdict text, p_sha256 text, p_engine text, p_signature_version bigint,
  p_signature_updated_at timestamptz, p_scanned_at timestamptz
)
-- The service role has no private-schema USAGE. This single, service-only
-- entrypoint crosses that boundary without granting broad schema access; the
-- private implementation also verifies the JWT service role before any write.
returns jsonb language sql security definer set search_path = '' as $function$
  select private.record_private_upload_scan(p_bucket_id, p_object_name, p_object_id, p_object_version,
    p_verdict, p_sha256, p_engine, p_signature_version, p_signature_updated_at, p_scanned_at)
$function$;
revoke all on function public.record_private_upload_scan(text,text,uuid,text,text,text,text,bigint,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.record_private_upload_scan(text,text,uuid,text,text,text,text,bigint,timestamptz,timestamptz)
  to service_role;

notify pgrst, 'reload schema';
commit;
