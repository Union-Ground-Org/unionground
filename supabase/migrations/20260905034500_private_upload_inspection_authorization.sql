begin;

-- One bounded quota row per authenticated actor; no filenames or file bytes.
create table private.private_upload_inspection_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  hour_started timestamptz not null,
  hour_count integer not null check (hour_count between 0 and 20),
  day_started timestamptz not null,
  day_count integer not null check (day_count between 0 and 100)
);
alter table private.private_upload_inspection_limits enable row level security;
revoke all on private.private_upload_inspection_limits from public, anon, authenticated, service_role;

-- Each stored object has at most one active inspection. A new attempt replaces
-- an expired attempt's UUID; stale completions cannot overwrite the successor.
create table private.private_upload_inspection_attempts (
  object_id uuid primary key references storage.objects(id) on delete cascade,
  id uuid not null unique,
  object_version text,
  bucket_id text not null,
  object_name text not null,
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  completed_at timestamptz
);
alter table private.private_upload_inspection_attempts enable row level security;
revoke all on private.private_upload_inspection_attempts from public, anon, authenticated, service_role;
create index private_upload_inspection_attempts_actor_idx on private.private_upload_inspection_attempts(actor_user_id);

create function public.authorize_private_upload_inspection(p_kind text, p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  actor uuid := (select auth.uid());
  target jsonb;
  allowed boolean := false;
  object storage.objects%rowtype;
  quota private.private_upload_inspection_limits%rowtype;
  attempt private.private_upload_inspection_attempts%rowtype;
  attempt_id uuid := extensions.gen_random_uuid();
  checked_at timestamptz := pg_catalog.now();
begin
  if (select auth.role()) is distinct from 'authenticated' or actor is null or not private.mfa_satisfied() then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  if p_kind = 'case' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_member_case_object(f.bucket_id, f.object_name)
        or private.can_write_member_case_object(f.bucket_id, f.object_name)
    into target, allowed from public.member_case_files f
    where f.id = p_file_id and f.removal_requested_at is null and f.cleanup_requested_at is null;
  elsif p_kind = 'task' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_chapter_task_object(f.bucket_id, f.object_name)
        or private.can_write_chapter_task_object(f.bucket_id, f.object_name)
    into target, allowed from public.chapter_task_files f
    where f.id = p_file_id and f.removal_requested_at is null and f.cleanup_requested_at is null;
  elsif p_kind = 'form' then
    select pg_catalog.jsonb_build_object('bucketId', f.bucket_id, 'objectName', f.object_name,
      'filename', f.filename, 'mimeType', f.mime_type, 'sizeBytes', f.size_bytes),
      private.can_read_member_form_object(f.bucket_id, f.object_name)
        or private.can_write_member_form_object(f.bucket_id, f.object_name)
    into target, allowed from public.member_form_files f
    where f.id = p_file_id and f.deletion_requested_at is null;
  elsif p_kind = 'knowledge' then
    select pg_catalog.jsonb_build_object('bucketId', 'organization-knowledge', 'objectName', f.storage_path,
      'filename', f.file_name, 'mimeType', f.mime_type, 'sizeBytes', f.byte_size, 'sha256', f.content_sha256),
      private.can_insert_organization_knowledge_object('organization-knowledge', f.storage_path)
        or private.can_read_organization_knowledge_object('organization-knowledge', f.storage_path)
    into target, allowed from public.organization_knowledge_files f
    where f.id = p_file_id and f.storage_kind = 'organization_storage';
  end if;
  -- Unknown, foreign, removed and unauthorized identities have one response.
  if target is null or allowed is distinct from true then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  -- Serialize an actor's quota before taking any Storage lock. All functions
  -- that touch both object and attempt rows lock Storage first, then attempt.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('private-upload:' || actor::text, 509));
  select * into object from storage.objects
  where bucket_id = target->>'bucketId' and name = target->>'objectName' for update;
  if object.id is null then raise exception 'file unavailable' using errcode = '42501'; end if;
  -- Knowledge preparation reserves name/size/digest before MIME is recorded.
  -- The immutable Storage declaration is still only a claim: the inspector
  -- validates it against the filename and the actual downloaded bytes.
  if target->>'mimeType' is null then
    target := target || pg_catalog.jsonb_build_object('mimeType', object.metadata->>'mimetype');
  end if;
  if private.private_upload_is_current(object.bucket_id, object.name) then
    return pg_catalog.jsonb_build_object('fileId', p_file_id, 'current', true);
  end if;
  select * into attempt from private.private_upload_inspection_attempts a where a.object_id = object.id for update;
  if attempt.completed_at is null and attempt.expires_at > checked_at then
    return pg_catalog.jsonb_build_object('busy', true);
  end if;
  insert into private.private_upload_inspection_limits(user_id, hour_started, hour_count, day_started, day_count)
  values(actor, checked_at, 0, checked_at, 0) on conflict (user_id) do nothing;
  select * into quota from private.private_upload_inspection_limits where user_id = actor for update;
  if quota.hour_started <= checked_at - interval '1 hour' then quota.hour_started := checked_at; quota.hour_count := 0; end if;
  if quota.day_started <= checked_at - interval '24 hours' then quota.day_started := checked_at; quota.day_count := 0; end if;
  if quota.hour_count >= 20 or quota.day_count >= 100 then
    return pg_catalog.jsonb_build_object('rateLimited', true);
  end if;
  update private.private_upload_inspection_limits set hour_started = quota.hour_started, hour_count = quota.hour_count + 1,
    day_started = quota.day_started, day_count = quota.day_count + 1 where user_id = actor;
  insert into private.private_upload_inspection_attempts(object_id, id, object_version, bucket_id, object_name, actor_user_id, expires_at)
  values(object.id, attempt_id, object.version, object.bucket_id, object.name, actor, checked_at + interval '60 seconds')
  on conflict (object_id) do update set id = excluded.id, object_version = excluded.object_version,
    actor_user_id = excluded.actor_user_id, expires_at = excluded.expires_at, completed_at = null;
  return target || pg_catalog.jsonb_build_object('fileId', p_file_id, 'attemptId', attempt_id,
    'objectId', object.id, 'objectVersion', object.version, 'current', false);
end
$function$;
revoke all on function public.authorize_private_upload_inspection(text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.authorize_private_upload_inspection(text,uuid) to authenticated;

create function public.finish_private_upload_inspection(
  p_attempt_id uuid, p_verdict text, p_sha256 text, p_engine text, p_signature_version bigint,
  p_signature_updated_at timestamptz, p_scanned_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  attempt private.private_upload_inspection_attempts%rowtype;
  object storage.objects%rowtype;
  result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'scanner service required' using errcode = '42501';
  end if;
  select * into attempt from private.private_upload_inspection_attempts where id = p_attempt_id;
  if attempt.id is null then raise exception 'inspection unavailable' using errcode = '22023'; end if;
  select * into object from storage.objects where id = attempt.object_id for update;
  select * into attempt from private.private_upload_inspection_attempts where id = p_attempt_id for update;
  if object.id is null or attempt.id is null or attempt.completed_at is not null
    or attempt.expires_at <= pg_catalog.clock_timestamp() or object.version is distinct from attempt.object_version then
    raise exception 'inspection unavailable' using errcode = '22023';
  end if;
  result := private.record_private_upload_scan(object.bucket_id, object.name, object.id, object.version,
    p_verdict, p_sha256, p_engine, p_signature_version, p_signature_updated_at, p_scanned_at);
  update private.private_upload_inspection_attempts set completed_at = pg_catalog.clock_timestamp() where id = p_attempt_id;
  return result;
end
$function$;
revoke all on function public.finish_private_upload_inspection(uuid,text,text,text,bigint,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_private_upload_inspection(uuid,text,text,text,bigint,timestamptz,timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
