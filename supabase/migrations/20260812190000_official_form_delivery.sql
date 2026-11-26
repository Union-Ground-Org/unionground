-- UB-FORM-02 / UB-FORM-05: private signatures, supporting files, and a
-- frozen approved filing artifact. Browsers receive safe metadata only;
-- stored signature strokes leave Postgres solely through the service-only PDF
-- payload RPC after a separate caller-scoped authorization check.

set local lock_timeout = '5s';

alter table public.member_forms
  add column filer_signed_at timestamptz,
  add column filer_signature_digest text,
  add column content_digest text,
  add column artifact_digest text,
  add column artifact_approved_at timestamptz,
  add column artifact_approved_by uuid references auth.users(id) on delete set null;

alter table public.member_form_cosigners
  add column signed_at timestamptz,
  add column signature_digest text;

create table private.member_form_signatures (
  id uuid primary key default extensions.gen_random_uuid(),
  form_id uuid not null references public.member_forms(id) on delete cascade,
  signer_kind text not null check (signer_kind in ('filer', 'cosigner')),
  signer_user_id uuid references auth.users(id) on delete set null,
  cosigner_id uuid references public.member_form_cosigners(id) on delete cascade,
  strokes jsonb not null,
  content_digest text not null,
  signature_digest text not null,
  consented_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (form_id, signer_kind, signer_user_id),
  unique (cosigner_id),
  check ((signer_kind = 'filer' and cosigner_id is null and signer_user_id is not null)
      or (signer_kind = 'cosigner' and cosigner_id is not null))
);

create index member_form_signatures_form_idx
  on private.member_form_signatures (form_id, signer_kind);

revoke all on table private.member_form_signatures
  from public, anon, authenticated, service_role;

create function private.validate_form_signature_strokes(p_strokes jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  stroke jsonb;
  point jsonb;
  stroke_count integer;
  point_count integer := 0;
  x numeric;
  y numeric;
begin
  if p_strokes is null or pg_catalog.jsonb_typeof(p_strokes) <> 'array' then
    raise exception 'signature strokes must be an array' using errcode = '22023';
  end if;
  stroke_count := pg_catalog.jsonb_array_length(p_strokes);
  if stroke_count not between 1 and 64 then
    raise exception 'signature needs 1-64 strokes' using errcode = '22023';
  end if;
  for stroke in select * from pg_catalog.jsonb_array_elements(p_strokes) loop
    if pg_catalog.jsonb_typeof(stroke) <> 'array'
       or pg_catalog.jsonb_array_length(stroke) not between 2 and 512 then
      raise exception 'each signature stroke needs 2-512 points' using errcode = '22023';
    end if;
    point_count := point_count + pg_catalog.jsonb_array_length(stroke);
    if point_count > 2000 then
      raise exception 'signature has too many points' using errcode = '22023';
    end if;
    for point in select * from pg_catalog.jsonb_array_elements(stroke) loop
      if pg_catalog.jsonb_typeof(point) <> 'object'
         or pg_catalog.jsonb_typeof(point -> 'x') <> 'number'
         or pg_catalog.jsonb_typeof(point -> 'y') <> 'number'
         or point - 'x' - 'y' <> '{}'::jsonb then
        raise exception 'signature points must contain integer x and y only' using errcode = '22023';
      end if;
      x := (point ->> 'x')::numeric;
      y := (point ->> 'y')::numeric;
      if x <> pg_catalog.trunc(x) or y <> pg_catalog.trunc(y)
         or x not between 0 and 1000 or y not between 0 and 1000 then
        raise exception 'signature coordinates must be integers from 0 to 1000' using errcode = '22023';
      end if;
    end loop;
  end loop;
end
$$;
revoke all on function private.validate_form_signature_strokes(jsonb)
  from public, anon, authenticated, service_role;

create function private.form_signature_digest(
  p_content_digest text, p_subject uuid, p_strokes jsonb
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    p_content_digest || ':' || p_subject::text || ':' || p_strokes::text,
    'UTF8'), 'sha256'), 'hex');
$$;
revoke all on function private.form_signature_digest(text, uuid, jsonb)
  from public, anon, authenticated, service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'member-form-files', 'member-form-files', false, 10485760,
  array[
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table public.member_form_files (
  id uuid primary key default extensions.gen_random_uuid(),
  form_id uuid not null references public.member_forms(id) on delete cascade,
  bucket_id text not null default 'member-form-files'
    check (bucket_id = 'member-form-files'),
  object_name text not null unique,
  filename text not null check (
    pg_catalog.char_length(pg_catalog.btrim(filename)) between 1 and 160
    and filename !~ '[/\\]' and filename !~ '[[:cntrl:]]'),
  mime_type text not null check (mime_type in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create index member_form_files_form_idx
  on public.member_form_files (form_id, confirmed_at, created_at, id);
create index member_form_files_uploaded_by_idx
  on public.member_form_files (uploaded_by);

alter table public.member_form_files enable row level security;
create policy member_form_files_select_authorized
  on public.member_form_files for select to authenticated
  using (
    (select private.mfa_satisfied())
    and exists (
      select 1 from public.member_forms f
      where f.id = member_form_files.form_id
        and (f.user_id = (select auth.uid())
          or (f.status in ('submitted', 'in_review', 'approved')
            and public.member_has_role(array['steward'])
            and public.staff_can_see_user(f.user_id, 'steward')))
    )
  );
create policy mfa_assurance on public.member_form_files
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));
revoke all on table public.member_form_files from public, anon, authenticated;
grant select on table public.member_form_files to authenticated;

create function private.form_content_digest(p_form_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
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
    )::text, 'UTF8'), 'sha256'), 'hex')
  from public.member_forms f where f.id = p_form_id;
$$;
revoke all on function private.form_content_digest(uuid)
  from public, anon, authenticated, service_role;

create function private.form_artifact_digest(
  p_form_id uuid,
  p_content_digest text,
  p_filer_signature_digest text,
  p_review_note text,
  p_approved_by uuid,
  p_approved_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contentDigest', p_content_digest,
      'filerSignatureDigest', p_filer_signature_digest,
      'cosigners', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', c.id, 'email', c.invited_email, 'status', c.status,
          'signedAt', c.signed_at, 'signatureDigest', c.signature_digest)
          order by c.invited_at, c.id)
        from public.member_form_cosigners c where c.form_id = p_form_id
      ), '[]'::jsonb),
      'reviewNote', p_review_note,
      'approvedBy', p_approved_by,
      'approvedAt', p_approved_at
    )::text, 'UTF8'), 'sha256'), 'hex');
$$;
revoke all on function private.form_artifact_digest(uuid, text, text, text, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create function private.invalidate_member_form_signatures(p_form_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  reaffirmed uuid;
begin
  delete from private.member_form_signatures where form_id = p_form_id;
  update public.member_forms
    set filer_signed_at = null, filer_signature_digest = null, content_digest = null
    where id = p_form_id;
  for reaffirmed in
    update public.member_form_cosigners
      set status = 'reaffirm_needed', responded_at = now(),
          signed_at = null, signature_digest = null
      where form_id = p_form_id and status = 'accepted'
      returning cosigner_user_id
  loop
    if reaffirmed is not null then
      perform private.notify_member(reaffirmed, 'cosign.reaffirm', '{}'::jsonb, 'forms');
    end if;
  end loop;
end
$$;
revoke all on function private.invalidate_member_form_signatures(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.save_form_draft(
  p_template_key text, p_answers jsonb, p_step integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  existing uuid;
  clean jsonb := coalesce(p_answers, '{}'::jsonb);
  prev_answers jsonb;
  tpl record;
  reaffirmed uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select version, active into tpl from public.form_templates
    where key = p_template_key order by version desc limit 1;
  if not found then raise exception 'invalid template' using errcode = '22023'; end if;
  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000 then
    raise exception 'answers too large' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  select id, answers into existing, prev_answers from public.member_forms
    where user_id = caller and template_key = p_template_key and status in ('draft', 'returned')
    order by updated_at desc limit 1;
  if existing is null then
    if not tpl.active then
      raise exception 'this form is no longer accepting new submissions' using errcode = '22023';
    end if;
    insert into public.member_forms (user_id, template_key, template_version, answers, step)
      values (caller, p_template_key, tpl.version, clean,
        least(greatest(coalesce(p_step, 0), 0), 50))
      returning id into existing;
  else
    if clean is distinct from prev_answers then
      delete from private.member_form_signatures where form_id = existing;
      update public.member_forms
        set filer_signed_at = null, filer_signature_digest = null, content_digest = null
        where id = existing;
      if p_template_key = 'alliance_grievance' then
        for reaffirmed in
          update public.member_form_cosigners
            set status='reaffirm_needed', responded_at=now(), signed_at=null, signature_digest=null
            where form_id=existing and status='accepted'
            returning cosigner_user_id
        loop
          if reaffirmed is not null then
            perform private.notify_member(reaffirmed, 'cosign.reaffirm', '{}'::jsonb, 'forms');
          end if;
        end loop;
      end if;
    end if;
    update public.member_forms
      set answers = clean, step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = existing and user_id = caller;
  end if;
  return existing;
end
$$;

create function public.sign_member_form(
  p_form_id uuid, p_strokes jsonb, p_consent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  current_digest text;
  signed_time timestamptz := now();
  signed_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_consent is distinct from true then
    raise exception 'signature consent required' using errcode = '22023';
  end if;
  perform private.validate_form_signature_strokes(p_strokes);
  select id, user_id, status into rec from public.member_forms
    where id = p_form_id for update;
  if not found or rec.user_id <> caller or rec.status not in ('draft', 'returned') then
    raise exception 'form not found or not signable' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'wait for every attachment upload to finish' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  signed_digest := private.form_signature_digest(current_digest, caller, p_strokes);
  insert into private.member_form_signatures (
    form_id, signer_kind, signer_user_id, strokes, content_digest,
    signature_digest, consented_at
  ) values (
    p_form_id, 'filer', caller, p_strokes, current_digest,
    signed_digest, signed_time
  )
  on conflict (form_id, signer_kind, signer_user_id) do update set
    strokes = excluded.strokes,
    content_digest = excluded.content_digest,
    signature_digest = excluded.signature_digest,
    consented_at = excluded.consented_at,
    created_at = now();
  update public.member_forms set
    filer_signed_at = signed_time,
    filer_signature_digest = signed_digest,
    content_digest = current_digest,
    updated_at = now()
  where id = p_form_id;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'signedAt', signed_time,
    'signatureDigest', signed_digest, 'contentDigest', current_digest);
end
$$;

drop function if exists public.respond_to_cosign(uuid, boolean);
create function public.respond_to_cosign(
  p_form_id uuid, p_accept boolean, p_strokes jsonb, p_consent boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  inv record;
  new_status text;
  current_digest text;
  signed_time timestamptz;
  signed_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_accept and p_consent is distinct from true then
    raise exception 'signature consent required' using errcode = '22023';
  end if;
  if p_accept then perform private.validate_form_signature_strokes(p_strokes); end if;
  select c.*, f.status as form_status into inv
    from public.member_form_cosigners c
    join public.member_forms f on f.id = c.form_id
    where c.form_id = p_form_id
      and f.status <> 'approved'
      and c.status in ('invited', 'reaffirm_needed')
      and (c.cosigner_user_id = caller
        or (caller_email <> '' and c.invited_email = caller_email))
    order by c.invited_at desc for update of c limit 1;
  if inv.id is null then
    raise exception 'no pending co-sign invitation for you on this form' using errcode = '22023';
  end if;

  new_status := case when p_accept then 'accepted' else 'declined' end;
  if p_accept then
    current_digest := private.form_content_digest(p_form_id);
    signed_time := now();
    signed_digest := private.form_signature_digest(current_digest, inv.id, p_strokes);
    insert into private.member_form_signatures (
      form_id, signer_kind, signer_user_id, cosigner_id, strokes,
      content_digest, signature_digest, consented_at
    ) values (
      p_form_id, 'cosigner', caller, inv.id, p_strokes,
      current_digest, signed_digest, signed_time
    )
    on conflict (form_id, signer_kind, signer_user_id) do update set
      cosigner_id = excluded.cosigner_id, strokes = excluded.strokes,
      content_digest = excluded.content_digest,
      signature_digest = excluded.signature_digest,
      consented_at = excluded.consented_at, created_at = now();
  else
    delete from private.member_form_signatures
      where form_id = p_form_id and signer_kind = 'cosigner' and signer_user_id = caller;
  end if;
  update public.member_form_cosigners
    set status = new_status,
        cosigner_user_id = case when p_accept then caller else cosigner_user_id end,
        responded_at = now(), signed_at = signed_time, signature_digest = signed_digest
    where id = inv.id;
  if p_accept then
    perform private.notify_member(inv.invited_by, 'cosign.accepted', '{}'::jsonb, 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', new_status, 'signedAt', signed_time, 'signatureDigest', signed_digest);
end
$$;

create or replace function public.withdraw_cosign(p_form_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  inv record;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select c.id, c.invited_by into inv
    from public.member_form_cosigners c
    join public.member_forms f on f.id = c.form_id
    where c.form_id = p_form_id and c.cosigner_user_id = caller
      and c.status = 'accepted' and f.status <> 'approved'
    for update of c limit 1;
  if inv.id is null then
    raise exception 'you have no withdrawable co-signature on this form' using errcode = '22023';
  end if;
  delete from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'cosigner' and signer_user_id = caller;
  update public.member_form_cosigners
    set status = 'withdrawn', responded_at = now(), signed_at = null, signature_digest = null
    where id = inv.id;
  perform private.notify_member(inv.invited_by, 'cosign.withdrew', '{}'::jsonb, 'forms');
  return pg_catalog.jsonb_build_object('status', 'withdrawn');
end
$$;

create function public.register_member_form_file(
  p_form_id uuid, p_filename text, p_mime_type text, p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  file_id uuid := extensions.gen_random_uuid();
  clean_name text := pg_catalog.btrim(coalesce(p_filename, ''));
  inserted public.member_form_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) not between 1 and 160
     or clean_name ~ '[/\\]' or clean_name ~ '[[:cntrl:]]' then
    raise exception 'file name must be 1-160 characters without path separators' using errcode = '22023';
  end if;
  if coalesce(p_size_bytes, 0) not between 1 and 10485760 then
    raise exception 'file must be between 1 byte and 10 MB' using errcode = '22023';
  end if;
  if p_mime_type not in (
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then
    raise exception 'file type is not accepted' using errcode = '22023';
  end if;
  select id, user_id, status into rec from public.member_forms
    where id = p_form_id for update;
  if not found or rec.user_id <> caller or rec.status not in ('draft', 'returned') then
    raise exception 'form not found or attachments are locked' using errcode = '22023';
  end if;
  if (select count(*) from public.member_form_files where form_id = p_form_id) >= 20 then
    raise exception 'attachment limit reached (max 20)' using errcode = '22023';
  end if;
  perform private.invalidate_member_form_signatures(p_form_id);
  insert into public.member_form_files (
    id, form_id, object_name, filename, mime_type, size_bytes, uploaded_by
  ) values (
    file_id, p_form_id, p_form_id::text || '/' || file_id::text || '/' || clean_name,
    clean_name, p_mime_type, p_size_bytes, caller
  ) returning * into inserted;
  return pg_catalog.jsonb_build_object(
    'id', inserted.id, 'formId', inserted.form_id, 'bucketId', inserted.bucket_id,
    'objectName', inserted.object_name, 'filename', inserted.filename,
    'mimeType', inserted.mime_type, 'sizeBytes', inserted.size_bytes,
    'confirmedAt', inserted.confirmed_at, 'createdAt', inserted.created_at);
end
$$;

create function public.confirm_member_form_file(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec public.member_form_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select ff.* into rec from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and ff.uploaded_by = caller and f.user_id = caller
      and f.status in ('draft', 'returned') for update of ff;
  if rec.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if not exists (select 1 from storage.objects o
                 where o.bucket_id = rec.bucket_id and o.name = rec.object_name) then
    raise exception 'uploaded file was not found' using errcode = '22023';
  end if;
  update public.member_form_files set confirmed_at = coalesce(confirmed_at, now())
    where id = rec.id returning * into rec;
  return pg_catalog.jsonb_build_object('id', rec.id, 'confirmedAt', rec.confirmed_at);
end
$$;

create function public.remove_member_form_file(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec public.member_form_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select ff.* into rec from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and f.user_id = caller
      and f.status in ('draft', 'returned') for update of ff;
  if rec.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  delete from public.member_form_files where id = rec.id;
  perform private.invalidate_member_form_signatures(rec.form_id);
  return pg_catalog.jsonb_build_object('deleted', true, 'id', rec.id);
end
$$;

create function private.can_read_member_form_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.bucket_id = p_bucket and ff.object_name = p_name
      and ff.confirmed_at is not null
      and (f.user_id = (select auth.uid())
        or (f.status in ('submitted', 'in_review', 'approved')
          and public.member_has_role(array['steward'])
          and public.staff_can_see_user(f.user_id, 'steward')))
  );
$$;

create function private.can_write_member_form_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.bucket_id = p_bucket and ff.object_name = p_name
      and ff.uploaded_by = (select auth.uid()) and f.user_id = (select auth.uid())
      and f.status in ('draft', 'returned')
  );
$$;
revoke all on function private.can_read_member_form_object(text, text)
  from public, anon, authenticated;
revoke all on function private.can_write_member_form_object(text, text)
  from public, anon, authenticated;
grant execute on function private.can_read_member_form_object(text, text) to authenticated;
grant execute on function private.can_write_member_form_object(text, text) to authenticated;

drop policy if exists member_form_files_storage_read on storage.objects;
create policy member_form_files_storage_read on storage.objects
  for select to authenticated using (
    bucket_id = 'member-form-files' and (select private.mfa_satisfied())
    and private.can_read_member_form_object(bucket_id, name));
drop policy if exists member_form_files_storage_insert on storage.objects;
create policy member_form_files_storage_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'member-form-files' and (select private.mfa_satisfied())
    and private.can_write_member_form_object(bucket_id, name));
drop policy if exists member_form_files_storage_delete on storage.objects;
create policy member_form_files_storage_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'member-form-files' and (select private.mfa_satisfied())
    and private.can_write_member_form_object(bucket_id, name));

create or replace function public.submit_form(p_form_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  signature record;
  missing text;
  v_key text;
  had_event boolean;
  actual integer;
  current_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select id, user_id, status, template_key, template_version, answers into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller then raise exception 'form not found' using errcode = '22023'; end if;
  if rec.status not in ('draft', 'returned') then raise exception 'form not submittable' using errcode = '22023'; end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'wait for every attachment upload to finish' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = caller;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, caller, signature.strokes) then
    raise exception 'draw and save a current signature before submitting' using errcode = '22023';
  end if;
  select k into missing
  from pg_catalog.unnest(private.form_required_keys(rec.template_key, rec.template_version)) as k
  where case when pg_catalog.jsonb_typeof(rec.answers -> k) = 'array'
    then pg_catalog.jsonb_array_length(rec.answers -> k) = 0
    else pg_catalog.btrim(coalesce(rec.answers ->> k, '')) = '' end limit 1;
  if missing is not null then
    raise exception 'form incomplete: %', missing using errcode = '22023';
  end if;
  update public.member_forms set status='submitted', submitted_at=now(),
    review_note=null, content_digest=current_digest, updated_at=now()
    where id=p_form_id and user_id=caller;
  v_key := 'form-' || p_form_id::text;
  had_event := exists (select 1 from public.member_point_events
                       where user_id = caller and action_key = v_key);
  insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, v_key, 'form') on conflict (user_id, action_key) do nothing;
  select points into actual from public.member_point_events
    where user_id = caller and action_key = v_key;
  return pg_catalog.jsonb_build_object('status', 'submitted',
    'awardedPoints', case when had_event then 0 else coalesce(actual, 0) end);
end
$$;

create or replace function public.approve_form(p_form_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  rec record;
  signature record;
  current_digest text;
  approved_time timestamptz := now();
  frozen_digest text;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_note is not null and (pg_catalog.char_length(clean_note) > 4000
      or pg_catalog.regexp_replace(clean_note,
        '[' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9) || ']', '', 'g') ~ '[[:cntrl:]]') then
    raise exception 'note is invalid' using errcode = '22023';
  end if;
  select f.id, f.user_id, f.status, f.template_key, f.template_version,
         coalesce(p.language, 'en') as lang into rec
    from public.member_forms f left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and confirmed_at is null) then
    raise exception 'form has an unfinished attachment' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  select content_digest, signature_digest, strokes into signature
    from private.member_form_signatures
    where form_id = p_form_id and signer_kind = 'filer' and signer_user_id = rec.user_id;
  if signature.signature_digest is null
     or signature.content_digest <> current_digest
     or signature.signature_digest <> private.form_signature_digest(
       current_digest, rec.user_id, signature.strokes) then
    raise exception 'form does not have a current filer signature' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_cosigners c
    where c.form_id = p_form_id and c.status = 'accepted'
      and (c.signature_digest is null or not exists (
        select 1 from private.member_form_signatures s
        where s.cosigner_id = c.id
          and s.signer_kind = 'cosigner'
          and s.content_digest = current_digest
          and s.signature_digest = c.signature_digest
          and s.signature_digest = private.form_signature_digest(
            current_digest, c.id, s.strokes)
      ))
  ) then
    raise exception 'form has an invalid co-signature' using errcode = '22023';
  end if;
  frozen_digest := private.form_artifact_digest(
    p_form_id, current_digest, signature.signature_digest,
    clean_note, caller, approved_time);
  update public.member_forms set
    status = 'approved', review_note = clean_note, reviewed_by = caller,
    reviewed_at = approved_time, content_digest = current_digest,
    artifact_digest = frozen_digest, artifact_approved_at = approved_time,
    artifact_approved_by = caller, updated_at = approved_time
  where id = p_form_id;
  if rec.lang = 'es' then
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Formulario aprobado',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — revisado y aprobado por tu delegado. Ya puedes descargar tu copia oficial de Union Base.'
        || coalesce(' Nota: ' || clean_note, ''), 'forms');
  else
    insert into public.member_notifications (user_id, title, body, kind)
    values (rec.user_id, 'Form approved',
      private.form_template_label_localized(rec.template_key, rec.template_version, rec.lang)
        || ' — reviewed and approved by your steward. Your Union Base official filing copy is ready to download.'
        || coalesce(' Note: ' || clean_note, ''), 'forms');
  end if;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'status', 'approved',
    'artifactDigest', frozen_digest, 'approvedAt', approved_time);
end
$$;

create function private.enforce_approved_member_form_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'approved' and (
    new.status is distinct from old.status or new.answers is distinct from old.answers
    or new.template_key is distinct from old.template_key
    or new.template_version is distinct from old.template_version
    or new.content_digest is distinct from old.content_digest
    or new.artifact_digest is distinct from old.artifact_digest
    or new.artifact_approved_at is distinct from old.artifact_approved_at
    or new.artifact_approved_by is distinct from old.artifact_approved_by
    or new.review_note is distinct from old.review_note
    or new.reviewed_by is distinct from old.reviewed_by
    or new.reviewed_at is distinct from old.reviewed_at) then
    raise exception 'approved filing artifacts are immutable' using errcode = '22023';
  end if;
  return new;
end
$$;
revoke all on function private.enforce_approved_member_form_immutability()
  from public, anon, authenticated, service_role;
drop trigger if exists member_forms_approved_immutable on public.member_forms;
create trigger member_forms_approved_immutable
  before update on public.member_forms for each row
  execute function private.enforce_approved_member_form_immutability();

create function public.get_form_filing_status(p_form_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  rec record;
  current_digest text;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select f.* into rec from public.member_forms f where f.id = p_form_id;
  if not found or not (public.form_is_owned_by_caller(p_form_id)
    or (rec.status in ('submitted', 'in_review', 'approved')
      and public.member_has_role(array['steward'])
      and public.staff_can_see_user(rec.user_id, 'steward'))) then
    raise exception 'form unavailable' using errcode = '22023';
  end if;
  current_digest := private.form_content_digest(p_form_id);
  return pg_catalog.jsonb_build_object(
    'formId', rec.id, 'status', rec.status,
    'filerSigned', exists (select 1 from private.member_form_signatures s
      where s.form_id = rec.id and s.signer_kind = 'filer'
        and s.signer_user_id = rec.user_id and s.content_digest = current_digest),
    'filerSignedAt', rec.filer_signed_at,
    'contentDigest', rec.content_digest,
    'artifactDigest', rec.artifact_digest,
    'artifactApprovedAt', rec.artifact_approved_at,
    'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ff.id, 'bucketId', ff.bucket_id, 'objectName', ff.object_name,
      'filename', ff.filename, 'mimeType', ff.mime_type,
      'sizeBytes', ff.size_bytes, 'confirmedAt', ff.confirmed_at)
      order by ff.created_at, ff.id) from public.member_form_files ff
      where ff.form_id = rec.id), '[]'::jsonb));
end
$$;

create function public.can_access_form_filing(p_form_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and private.mfa_satisfied() and exists (
    select 1 from public.member_forms f
    where f.id = p_form_id and f.status = 'approved'
      and (f.user_id = (select auth.uid())
        or (public.member_has_role(array['steward'])
          and public.staff_can_see_user(f.user_id, 'steward')))
  );
$$;

-- Retire the unbound service-only overload. The replacement receives the
-- already-authenticated caller id and repeats live ownership/role/scope checks
-- in the same statement that reads private signature strokes. This closes the
-- authorize-then-fetch revocation window in the HTTP endpoint.
drop function if exists public.get_form_filing_payload(uuid);

create function public.get_form_filing_payload(p_form_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
  rec record;
  current_digest text;
  filer_digest text;
  revalidated_digest text;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select f.*, p.chapter_id as owner_chapter into rec
  from public.member_forms f
  left join public.member_profiles p on p.id = f.user_id
  where p_user_id is not null
    and f.id = p_form_id
    and f.status = 'approved'
    and f.artifact_digest is not null
    and (f.user_id = p_user_id or exists (
      select 1 from public.member_roles r
      where r.user_id = p_user_id
        and r.role = 'steward'
        and (r.chapter_id is null or r.chapter_id = p.chapter_id)
    ));
  if not found then raise exception 'filing unavailable' using errcode = '22023'; end if;

  current_digest := private.form_content_digest(p_form_id);
  select s.signature_digest into filer_digest
  from private.member_form_signatures s
  where s.form_id = p_form_id
    and s.signer_kind = 'filer'
    and s.signer_user_id = rec.user_id
    and s.content_digest = current_digest
    and s.signature_digest = rec.filer_signature_digest
    and s.signature_digest = private.form_signature_digest(
      current_digest, rec.user_id, s.strokes);
  if current_digest is null
     or rec.content_digest is distinct from current_digest
     or filer_digest is null then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.member_form_cosigners c
    where c.form_id = p_form_id and c.status = 'accepted'
      and (c.signature_digest is null or not exists (
        select 1 from private.member_form_signatures s
        where s.cosigner_id = c.id
          and s.signer_kind = 'cosigner'
          and s.signature_digest = c.signature_digest
          and s.content_digest = current_digest
          and s.signature_digest = private.form_signature_digest(
            current_digest, c.id, s.strokes)
      ))
  ) then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;
  revalidated_digest := private.form_artifact_digest(
    p_form_id, current_digest, filer_digest, rec.review_note,
    rec.artifact_approved_by, rec.artifact_approved_at);
  if rec.artifact_digest is distinct from revalidated_digest then
    raise exception 'filing integrity check failed' using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object(
    'form', pg_catalog.to_jsonb(f),
    'template', pg_catalog.to_jsonb(t),
    'filer', pg_catalog.jsonb_build_object('id', p.id, 'name', p.full_name),
    'filerSignature', (select pg_catalog.jsonb_build_object(
      'strokes', s.strokes, 'signedAt', s.consented_at,
      'signatureDigest', s.signature_digest)
      from private.member_form_signatures s
      where s.form_id = f.id and s.signer_kind = 'filer'
        and s.signature_digest = f.filer_signature_digest
        and s.content_digest = f.content_digest),
    'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'email', c.invited_email, 'status', c.status,
      'signedAt', c.signed_at, 'signatureDigest', c.signature_digest,
      'strokes', cs.strokes)
      order by c.invited_at, c.id)
      from public.member_form_cosigners c
      left join private.member_form_signatures cs on cs.cosigner_id = c.id
        and cs.signature_digest = c.signature_digest
        and cs.content_digest = f.content_digest
      where c.form_id = f.id), '[]'::jsonb),
    'attachments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(ff)
      order by ff.created_at, ff.id) from public.member_form_files ff
      where ff.form_id = f.id and ff.confirmed_at is not null), '[]'::jsonb),
    'approval', pg_catalog.jsonb_build_object(
      'approvedBy', f.artifact_approved_by, 'approvedAt', f.artifact_approved_at,
      'reviewerName', rp.full_name, 'note', f.review_note,
      'artifactDigest', f.artifact_digest)
  ) into payload
  from public.member_forms f
  join public.form_templates t on t.key = f.template_key and t.version = f.template_version
  left join public.member_profiles p on p.id = f.user_id
  left join public.member_profiles rp on rp.id = f.artifact_approved_by
  where p_user_id is not null
    and f.id = p_form_id
    and f.status = 'approved'
    and f.artifact_digest is not null
    and (f.user_id = p_user_id or exists (
      select 1 from public.member_roles r
      where r.user_id = p_user_id
        and r.role = 'steward'
         and (r.chapter_id is null or r.chapter_id = p.chapter_id)
     ));
  if payload is null then raise exception 'filing unavailable' using errcode = '22023'; end if;
  return payload;
end
$$;

revoke all on function public.save_form_draft(text, jsonb, integer) from public, anon;
grant execute on function public.save_form_draft(text, jsonb, integer) to authenticated;
grant execute on function public.save_form_draft(text, jsonb, integer) to service_role;
revoke all on function public.sign_member_form(uuid, jsonb, boolean) from public, anon;
grant execute on function public.sign_member_form(uuid, jsonb, boolean) to authenticated;
grant execute on function public.sign_member_form(uuid, jsonb, boolean) to service_role;
revoke all on function public.respond_to_cosign(uuid, boolean, jsonb, boolean) from public, anon;
grant execute on function public.respond_to_cosign(uuid, boolean, jsonb, boolean) to authenticated;
grant execute on function public.respond_to_cosign(uuid, boolean, jsonb, boolean) to service_role;
revoke all on function public.withdraw_cosign(uuid) from public, anon;
grant execute on function public.withdraw_cosign(uuid) to authenticated;
grant execute on function public.withdraw_cosign(uuid) to service_role;
revoke all on function public.register_member_form_file(uuid, text, text, bigint) from public, anon;
grant execute on function public.register_member_form_file(uuid, text, text, bigint) to authenticated;
grant execute on function public.register_member_form_file(uuid, text, text, bigint) to service_role;
revoke all on function public.confirm_member_form_file(uuid) from public, anon;
grant execute on function public.confirm_member_form_file(uuid) to authenticated;
grant execute on function public.confirm_member_form_file(uuid) to service_role;
revoke all on function public.remove_member_form_file(uuid) from public, anon;
grant execute on function public.remove_member_form_file(uuid) to authenticated;
grant execute on function public.remove_member_form_file(uuid) to service_role;
revoke all on function public.submit_form(uuid) from public, anon;
grant execute on function public.submit_form(uuid) to authenticated;
grant execute on function public.submit_form(uuid) to service_role;
revoke all on function public.approve_form(uuid, text) from public, anon;
grant execute on function public.approve_form(uuid, text) to authenticated;
grant execute on function public.approve_form(uuid, text) to service_role;
revoke all on function public.get_form_filing_status(uuid) from public, anon;
grant execute on function public.get_form_filing_status(uuid) to authenticated;
grant execute on function public.get_form_filing_status(uuid) to service_role;
revoke all on function public.can_access_form_filing(uuid) from public, anon;
grant execute on function public.can_access_form_filing(uuid) to authenticated;
grant execute on function public.can_access_form_filing(uuid) to service_role;
revoke all on function public.get_form_filing_payload(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_form_filing_payload(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
