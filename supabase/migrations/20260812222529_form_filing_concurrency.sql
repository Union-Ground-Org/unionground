-- Serialize every official-filing transition on one form-scoped lock and make
-- Storage deletion a server-authorized two-phase operation. The Storage API
-- remains the only component that removes object bytes; Postgres owns the
-- tombstone that prevents a missing object from entering a signed artifact.

set local lock_timeout = '5s';

create function private.lock_member_form(p_form_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_form_id is null then
    raise exception 'form unavailable' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || p_form_id::text, 509));
end
$$;
revoke all on function private.lock_member_form(uuid)
  from public, anon, authenticated, service_role;

alter table public.member_form_files
  add column deletion_requested_at timestamptz,
  add column deletion_requested_by uuid references auth.users(id) on delete cascade,
  add constraint member_form_files_deletion_pair check (
    (deletion_requested_at is null and deletion_requested_by is null)
    or (deletion_requested_at is not null and deletion_requested_by is not null));

create index member_form_files_pending_deletion_idx
  on public.member_form_files (form_id, deletion_requested_at)
  where deletion_requested_at is not null;

create function private.enforce_member_form_child_mutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  form_id uuid := case when tg_op = 'DELETE' then old.form_id else new.form_id end;
  parent_approved boolean;
  old_json jsonb;
  new_json jsonb;
begin
  -- Preserve intentional FK cascades and identity detachment during account
  -- deletion. Browser/RPC mutations enter at trigger depth one.
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- The file/cosigner/signature-to-form association is immutable. Besides
  -- preserving evidence identity, this makes the pre-lock form-id discovery
  -- in file RPCs safe: the row can disappear, but it cannot jump locks.
  if tg_op = 'UPDATE' and old.form_id <> new.form_id then
    raise exception 'filing children cannot move between forms' using errcode = '22023';
  end if;
  perform private.lock_member_form(form_id);
  select f.status = 'approved' into parent_approved
    from public.member_forms f where f.id = form_id;
  if coalesce(parent_approved, false) then
    old_json := pg_catalog.to_jsonb(old);
    new_json := pg_catalog.to_jsonb(new);
    if tg_op = 'UPDATE' and tg_table_name = 'member_form_cosigners'
       and old_json ->> 'cosigner_user_id' is not null
       and new_json ->> 'cosigner_user_id' is null
       and (old_json - 'cosigner_user_id') = (new_json - 'cosigner_user_id') then
      return new;
    end if;
    if tg_op = 'UPDATE' and tg_table_name = 'member_form_signatures'
       and old_json ->> 'signer_user_id' is not null
       and new_json ->> 'signer_user_id' is null
       and (old_json - 'signer_user_id') = (new_json - 'signer_user_id') then
      return new;
    end if;
    raise exception 'approved filing children are immutable' using errcode = '22023';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function private.enforce_member_form_child_mutability()
  from public, anon, authenticated, service_role;

create trigger member_form_cosigners_parent_mutable
  before insert or update or delete on public.member_form_cosigners
  for each row execute function private.enforce_member_form_child_mutability();
create trigger member_form_signatures_parent_mutable
  before insert or update or delete on private.member_form_signatures
  for each row execute function private.enforce_member_form_child_mutability();
create trigger member_form_files_parent_mutable
  before insert or update or delete on public.member_form_files
  for each row execute function private.enforce_member_form_child_mutability();

create or replace function public.invite_cosigner(p_form_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text := pg_catalog.lower(coalesce((select auth.email()), ''));
  norm text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  frec record;
  target uuid;
  existing record;
  active_count integer;
  cooldown constant interval := interval '30 days';
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if norm = '' or pg_catalog.length(norm) > 320
     or norm !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'a valid email address is required' using errcode='22023';
  end if;
  if norm = caller_email then
    raise exception 'you cannot invite yourself' using errcode='22023';
  end if;

  perform private.lock_member_form(p_form_id);
  select id, user_id, template_key, status into frec
    from public.member_forms where id = p_form_id;
  if not found or frec.user_id <> caller
     or frec.template_key <> 'alliance_grievance'
     or frec.status not in ('draft','returned','submitted','in_review') then
    raise exception 'form not found or not eligible for co-signers' using errcode='22023';
  end if;

  select id into target from auth.users where pg_catalog.lower(email) = norm limit 1;
  select id, status, responded_at into existing from public.member_form_cosigners
    where form_id = p_form_id and invited_email = norm for update;
  if existing.id is not null then
    if existing.status in ('invited','accepted','reaffirm_needed') then
      return pg_catalog.jsonb_build_object('status','invited');
    end if;
    if existing.status in ('declined','withdrawn')
       and existing.responded_at is not null
       and existing.responded_at + cooldown > now() then
      raise exception 'this member answered already — you can ask again after %',
        pg_catalog.to_char(existing.responded_at + cooldown, 'YYYY-MM-DD')
        using errcode='22023';
    end if;
    select count(*) into active_count from public.member_form_cosigners
      where form_id = p_form_id and status in ('invited','accepted','reaffirm_needed');
    if active_count >= 10 then raise exception 'co-signer limit reached (max 10)' using errcode='22023'; end if;
    update public.member_form_cosigners
      set status='invited', cosigner_user_id=null, invited_by=caller,
          invited_at=now(), responded_at=null, signed_at=null, signature_digest=null
      where id = existing.id;
  else
    select count(*) into active_count from public.member_form_cosigners
      where form_id = p_form_id and status in ('invited','accepted','reaffirm_needed');
    if active_count >= 10 then raise exception 'co-signer limit reached (max 10)' using errcode='22023'; end if;
    insert into public.member_form_cosigners
      (form_id, invited_email, cosigner_user_id, invited_by)
      values (p_form_id, norm, null, caller);
  end if;
  if target is not null then
    perform private.notify_member(target, 'cosign.invited', '{}'::jsonb, 'forms');
  end if;
  return pg_catalog.jsonb_build_object('status','invited');
end
$$;

create or replace function public.respond_to_cosign(
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

  perform private.lock_member_form(p_form_id);
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
  perform private.lock_member_form(p_form_id);
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

create or replace function public.sign_member_form(
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
  perform private.lock_member_form(p_form_id);
  select id, user_id, status into rec from public.member_forms
    where id = p_form_id for update;
  if not found or rec.user_id <> caller or rec.status not in ('draft', 'returned') then
    raise exception 'form not found or not signable' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'wait for attachment deletion to finish' using errcode = '22023';
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
    strokes = excluded.strokes, content_digest = excluded.content_digest,
    signature_digest = excluded.signature_digest,
    consented_at = excluded.consented_at, created_at = now();
  update public.member_forms set
    filer_signed_at = signed_time, filer_signature_digest = signed_digest,
    content_digest = current_digest, updated_at = now()
  where id = p_form_id;
  return pg_catalog.jsonb_build_object(
    'formId', p_form_id, 'signedAt', signed_time,
    'signatureDigest', signed_digest, 'contentDigest', current_digest);
end
$$;

create or replace function public.register_member_form_file(
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
  perform private.lock_member_form(p_form_id);
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

create or replace function public.confirm_member_form_file(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  form_id uuid;
  rec public.member_form_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select ff.form_id into form_id from public.member_form_files ff where ff.id = p_file_id;
  if form_id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  perform private.lock_member_form(form_id);
  select ff.* into rec from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and ff.uploaded_by = caller and f.user_id = caller
      and f.status in ('draft', 'returned')
      and ff.deletion_requested_at is null for update of ff;
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

create function public.request_member_form_file_removal(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  form_id uuid;
  rec public.member_form_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select ff.form_id into form_id from public.member_form_files ff where ff.id = p_file_id;
  if form_id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  perform private.lock_member_form(form_id);
  select ff.* into rec from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and f.user_id = caller
      and f.status in ('draft', 'returned') for update of f, ff;
  if rec.id is null or (rec.deletion_requested_by is not null
      and rec.deletion_requested_by <> caller) then
    raise exception 'file unavailable' using errcode = '22023';
  end if;
  if rec.deletion_requested_at is null then
    update public.member_form_files
      set deletion_requested_at = now(), deletion_requested_by = caller
      where id = rec.id returning * into rec;
    perform private.invalidate_member_form_signatures(rec.form_id);
  end if;
  return pg_catalog.jsonb_build_object(
    'id', rec.id, 'formId', rec.form_id, 'bucketId', rec.bucket_id,
    'objectName', rec.object_name, 'deletionRequestedAt', rec.deletion_requested_at);
end
$$;

create function public.finalize_member_form_file_removal(p_file_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  form_id uuid;
  rec public.member_form_files%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select ff.form_id into form_id from public.member_form_files ff where ff.id = p_file_id;
  if form_id is null then
    return pg_catalog.jsonb_build_object('deleted', true, 'id', p_file_id);
  end if;
  perform private.lock_member_form(form_id);
  select ff.* into rec from public.member_form_files ff
    join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and f.user_id = caller
      and f.status in ('draft', 'returned')
      and ff.deletion_requested_at is not null
      and ff.deletion_requested_by = caller for update of f, ff;
  if rec.id is null then raise exception 'file unavailable' using errcode = '22023'; end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = rec.bucket_id and o.name = rec.object_name
  ) then
    raise exception 'attachment bytes still exist' using errcode = '22023';
  end if;
  delete from public.member_form_files where id = rec.id;
  return pg_catalog.jsonb_build_object('deleted', true, 'id', rec.id);
end
$$;

drop policy if exists member_form_files_storage_delete on storage.objects;
create function private.can_delete_member_form_object(p_bucket text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.member_form_files ff
    where ff.bucket_id = p_bucket and ff.object_name = p_name
      and ff.deletion_requested_at is not null
      and ff.deletion_requested_by = (select auth.uid())
  );
$$;
revoke all on function private.can_delete_member_form_object(text, text)
  from public, anon, authenticated;
grant execute on function private.can_delete_member_form_object(text, text) to authenticated;
drop policy if exists member_form_files_storage_insert on storage.objects;
create policy member_form_files_storage_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'member-form-files' and (select private.mfa_satisfied())
    and private.can_write_member_form_object(bucket_id, name)
    and not private.can_delete_member_form_object(bucket_id, name));
create policy member_form_files_storage_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'member-form-files' and (select private.mfa_satisfied())
    and private.can_delete_member_form_object(bucket_id, name));

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
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, template_key, template_version, answers into rec
    from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller then raise exception 'form not found' using errcode = '22023'; end if;
  if rec.status not in ('draft', 'returned') then raise exception 'form not submittable' using errcode = '22023'; end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'wait for attachment deletion to finish' using errcode = '22023';
  end if;
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
  perform private.lock_member_form(p_form_id);
  select f.id, f.user_id, f.status, f.template_key, f.template_version,
         coalesce(p.language, 'en') as lang into rec
    from public.member_forms f left join public.member_profiles p on p.id = f.user_id
    where f.id = p_form_id for update of f;
  if not found or rec.status not in ('submitted', 'in_review') or rec.user_id = caller
     or not public.staff_can_see_user(rec.user_id, 'steward') then
    raise exception 'form not found, not reviewable, or your own' using errcode = '22023';
  end if;
  if exists (select 1 from public.member_form_files
             where form_id = p_form_id and deletion_requested_at is not null) then
    raise exception 'form has a pending attachment deletion' using errcode = '22023';
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
        where s.cosigner_id = c.id and s.signer_kind = 'cosigner'
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

drop function if exists public.remove_member_form_file(uuid);

revoke all on function public.invite_cosigner(uuid, text) from public, anon;
grant execute on function public.invite_cosigner(uuid, text) to authenticated, service_role;
revoke all on function public.respond_to_cosign(uuid, boolean, jsonb, boolean) from public, anon;
grant execute on function public.respond_to_cosign(uuid, boolean, jsonb, boolean) to authenticated, service_role;
revoke all on function public.withdraw_cosign(uuid) from public, anon;
grant execute on function public.withdraw_cosign(uuid) to authenticated, service_role;
revoke all on function public.sign_member_form(uuid, jsonb, boolean) from public, anon;
grant execute on function public.sign_member_form(uuid, jsonb, boolean) to authenticated, service_role;
revoke all on function public.register_member_form_file(uuid, text, text, bigint) from public, anon;
grant execute on function public.register_member_form_file(uuid, text, text, bigint) to authenticated, service_role;
revoke all on function public.confirm_member_form_file(uuid) from public, anon;
grant execute on function public.confirm_member_form_file(uuid) to authenticated, service_role;
revoke all on function public.request_member_form_file_removal(uuid) from public, anon;
grant execute on function public.request_member_form_file_removal(uuid) to authenticated, service_role;
revoke all on function public.finalize_member_form_file_removal(uuid) from public, anon;
grant execute on function public.finalize_member_form_file_removal(uuid) to authenticated, service_role;
revoke all on function public.submit_form(uuid) from public, anon;
grant execute on function public.submit_form(uuid) to authenticated, service_role;
revoke all on function public.approve_form(uuid, text) from public, anon;
grant execute on function public.approve_form(uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';
