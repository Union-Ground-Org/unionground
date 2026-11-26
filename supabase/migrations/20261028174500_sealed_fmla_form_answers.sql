-- SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022: FMLA form
-- answers are sealed with the application-layer envelope encryption already
-- used for member_accommodation_requests (docs/security/sensitive-data-encryption.md).
-- Only the two FMLA templates are sealed (owner default D1). Other templates
-- keep plaintext answers.
--
-- The server (api/sensitive-content.js) encrypts the whole answers object as
-- one envelope bound to the form's organization, id, field "answers" and
-- purpose "member_forms", stages it in a sensitive write ticket, and the
-- caller's own transaction consumes the ticket. The answers column of a
-- sealed row holds only a marker:
--   {"sealed": true, "filled": [<answered keys>], "dataVersion": <envelope dataVersion>}
-- "filled" lets submit_form keep its required-key check without plaintext,
-- and "dataVersion" changes with every new envelope, so the unchanged content
-- digest (it hashes the answers column) still moves exactly when the content
-- does. A row sealed by the maintenance backfill after it was submitted also
-- carries "legacyDigest", its frozen pre-sealing content digest, so existing
-- signatures and approved artifact digests stay valid (owner default D2:
-- legal digests are never recomputed).
--
-- Existing FMLA rows are re-sealed by scripts/sensitive-form-maintenance.mjs
-- in the closed maintenance window, never by this migration (owner default D5).

begin;

alter table public.member_forms
  add column if not exists organization_id uuid,
  add column if not exists encrypted_content jsonb not null default '{}'::jsonb;

comment on column public.member_forms.organization_id is
  'Organization a sealed (FMLA) form''s envelope is bound to; set when the sealed draft is created and by the maintenance backfill. Null for other templates.';
comment on column public.member_forms.encrypted_content is
  'Server-produced envelope of a sealed (FMLA) form''s answers. Writable only through the sensitive write ticket or the audited maintenance channel.';

create function private.form_template_is_sealed(p_template_key text)
returns boolean language sql immutable set search_path = '' as $$
  select p_template_key in ('fmla_self', 'fmla_family');
$$;
revoke all on function private.form_template_is_sealed(text) from public, anon, authenticated, service_role;

-- The checks every sealed-answers envelope must pass for its form.
create function private.sealed_form_envelope_valid(p_envelope jsonb, p_form_id uuid, p_organization_id uuid)
returns boolean language sql immutable set search_path = '' as $$
  select p_envelope is not null and p_organization_id is not null
    and p_envelope->>'organization' is not distinct from p_organization_id::text
    and p_envelope->>'record' is not distinct from p_form_id::text
    and p_envelope->>'field' is not distinct from 'answers'
    and p_envelope->>'purpose' is not distinct from 'member_forms'
    and p_envelope->>'schema' is not distinct from '1'
    and jsonb_typeof(p_envelope->'payload') is not distinct from 'object'
    and jsonb_typeof(p_envelope->'wrappedKey') is not distinct from 'object'
    and coalesce(p_envelope->>'keyVersion','') ~ '^[a-zA-Z0-9_-]{1,64}$'
    and coalesce(p_envelope->>'dataVersion','') ~ '^[0-9a-f-]{36}$';
$$;
revoke all on function private.sealed_form_envelope_valid(jsonb, uuid, uuid) from public, anon, authenticated, service_role;

-- Sealed answers change only through the ticket of save_sealed_form_draft or
-- the maintenance channel. Empty and seed-only answers carry nothing sensitive.
create function private.require_sealed_form_answers()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  maintenance boolean := session_user in ('postgres','supabase_admin')
    and current_setting('role') in ('none','postgres','supabase_admin')
    and current_setting('app.sensitive_maintenance',true) = 'on';
  source jsonb := '{}'::jsonb; operation text; envelope jsonb;
begin
  if tg_op = 'UPDATE' then new.encrypted_content := old.encrypted_content;
  else new.encrypted_content := '{}'::jsonb; end if;
  if not private.form_template_is_sealed(new.template_key)
    and (tg_op = 'INSERT' or not private.form_template_is_sealed(old.template_key)) then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.id <> old.id or new.template_key is distinct from old.template_key
    or (old.organization_id is not null and new.organization_id is distinct from old.organization_id)) then
    raise exception 'sensitive-data-identity-immutable' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.answers is not distinct from old.answers then
    -- Key rotation: the maintenance channel may rewrap a sealed row's envelope
    -- in place; the content (dataVersion) and the marker stay the same.
    envelope := coalesce(nullif(current_setting('app.sensitive_envelopes',true),'')::jsonb,'{}'::jsonb)->'answers';
    if maintenance and envelope is not null then
      if old.answers->>'sealed' is distinct from 'true'
        or envelope->>'dataVersion' is distinct from old.answers->>'dataVersion'
        or not private.sealed_form_envelope_valid(envelope, new.id, new.organization_id) then
        raise exception 'sensitive-data-envelope-required' using errcode = '22023';
      end if;
      new.encrypted_content := jsonb_build_object('answers', envelope);
    end if;
    return new;
  end if;
  if not exists (select 1 from jsonb_object_keys(coalesce(new.answers, '{}'::jsonb)) k where k <> 'seedSequence') then
    new.encrypted_content := new.encrypted_content - 'answers';
    return new;
  end if;
  if maintenance then
    source := coalesce(nullif(current_setting('app.sensitive_envelopes',true),'')::jsonb,'{}'::jsonb);
  else
    select t.envelopes, t.operation into source, operation from private.sensitive_write_tickets t
      where t.id = nullif(current_setting('app.sensitive_ticket',true),'')::uuid
      and t.actor = (select auth.uid()) and t.expires_at > clock_timestamp();
    if operation is distinct from 'save_sealed_form_draft' or new.user_id is distinct from (select auth.uid()) then
      raise exception 'sensitive-data-encryption-required' using errcode = '22023';
    end if;
  end if;
  envelope := source->'answers';
  if not private.sealed_form_envelope_valid(envelope, new.id, new.organization_id)
    or jsonb_typeof(new.answers) is distinct from 'object'
    or new.answers->>'sealed' is distinct from 'true'
    or jsonb_typeof(new.answers->'filled') is distinct from 'array'
    -- Templates allow 12 steps of 30 fields; MAX_FORM_ANSWER_KEYS (#6320).
    or jsonb_array_length(new.answers->'filled') > 360
    or exists (select 1 from jsonb_array_elements(new.answers->'filled') e
      where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 80)
    or exists (select 1 from jsonb_object_keys(new.answers) k
      where k not in ('sealed', 'filled', 'dataVersion', 'legacyDigest'))
    or (new.answers ? 'legacyDigest' and not maintenance)
    or new.answers->>'dataVersion' is distinct from envelope->>'dataVersion'
  then
    raise exception 'sensitive-data-envelope-required' using errcode = '22023';
  end if;
  new.encrypted_content := jsonb_build_object('answers', envelope);
  return new;
end
$$;
revoke all on function private.require_sealed_form_answers() from public, anon, authenticated, service_role;
create trigger member_forms_sealed_answers
  before insert or update on public.member_forms
  for each row execute function private.require_sealed_form_answers();

-- Finds the caller's open sealed draft (draft or returned) for a template or
-- creates an empty one, so the server can bind the envelope to its id. Returns
-- the stored envelope for change detection; never plaintext.
create function public.prepare_sealed_form(p_template_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  existing record;
  tpl record;
  org uuid;
  created uuid;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.form_template_is_sealed(p_template_key) then
    raise exception 'invalid template' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  select id, organization_id, encrypted_content into existing from public.member_forms
    where user_id = caller and template_key = p_template_key and status in ('draft', 'returned')
    order by updated_at desc limit 1;
  if found then
    if existing.organization_id is null then
      raise exception 'sensitive-data-backfill-required' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('formId', existing.id, 'organizationId', existing.organization_id,
      'envelope', existing.encrypted_content->'answers');
  end if;
  org := private.current_member_organization();
  if org is null then raise exception 'organization required' using errcode = '22023'; end if;
  -- Same precedence as save_form_draft and the registry: the organization's
  -- own template before a platform seed, then the highest version (#5827 r7s1).
  select version, active into tpl from public.form_templates
    where key = p_template_key and (is_platform_seed or organization_id = org)
    order by (organization_id is not null) desc, version desc limit 1;
  if not found then raise exception 'invalid template' using errcode = '22023'; end if;
  if not tpl.active then
    raise exception 'this form is no longer accepting new submissions' using errcode = '22023';
  end if;
  insert into public.member_forms (user_id, template_key, template_version, answers, step, organization_id)
    values (caller, p_template_key, tpl.version, '{}'::jsonb, 0, org)
    returning id into created;
  return pg_catalog.jsonb_build_object('formId', created, 'organizationId', org, 'envelope', null);
end;
end
$$;
revoke all on function public.prepare_sealed_form(text) from public, anon, service_role;
grant execute on function public.prepare_sealed_form(text) to authenticated;

-- The legacy plaintext save refuses sealed templates (#6329, #6289 round 2).
-- Re-emitted from 20261022192718 with only the sealed-template refusal added;
-- the guard stops on any other installed body.
do $$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p
      where p.oid = 'public.save_form_draft(text, jsonb, integer)'::regprocedure)
    is distinct from '4a35ac175f8ed7e5b0e200cb1410061f' then
    raise exception 'unreviewed save_form_draft predecessor' using errcode = '55000';
  end if;
end
$$;
CREATE OR REPLACE FUNCTION public.save_form_draft(p_template_key text, p_answers jsonb, p_step integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

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
  -- Sealed templates save only through prepare_sealed_form and
  -- save_sealed_form_draft, which bind the draft to its organization and its
  -- envelope. A legacy save, even an empty one from a cached bundle, would
  -- create an organizationless draft or clear the sealed answers (#6329).
  if private.form_template_is_sealed(p_template_key) then
    raise exception 'sealed form templates save through the sensitive content API' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(clean) <> 'object' or pg_catalog.length(clean::text) > 20000 then
    raise exception 'answers too large' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member-form-' || caller::text || '-' || p_template_key, 509));
  select id, answers into existing, prev_answers from public.member_forms
    where user_id = caller and template_key = p_template_key and status in ('draft', 'returned')
    order by updated_at desc limit 1;
  if existing is null then
    -- With no selected organization only platform seeds match below.
    select version,active into tpl from public.form_templates
      where key=p_template_key and (is_platform_seed
        or organization_id=(select private.current_member_organization()))
      order by (organization_id is not null) desc, version desc limit 1;
    if not found then raise exception 'invalid template' using errcode='22023'; end if;
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
end;
end;
$function$;

-- Runs only inside write_sensitive_content (no direct grant): the ticket binds
-- p_changed, p_filled and p_data_version to the envelope the server produced.
create function public.save_sealed_form_draft(p_form_id uuid, p_step integer, p_changed boolean,
  p_filled jsonb, p_data_version text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  rec record;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if nullif(current_setting('app.sensitive_ticket', true), '') is null then
    raise exception 'sensitive-data-trusted-write-required' using errcode = '42501';
  end if;
  perform private.lock_member_form(p_form_id);
  select id, user_id, status, template_key into rec from public.member_forms where id = p_form_id for update;
  if not found or rec.user_id <> caller or not private.form_template_is_sealed(rec.template_key)
    or rec.status not in ('draft', 'returned') then
    raise exception 'form not found' using errcode = '22023';
  end if;
  if p_changed then
    delete from private.member_form_signatures where form_id = p_form_id;
    update public.member_forms
      set filer_signed_at = null, filer_signature_digest = null, content_digest = null,
        answers = pg_catalog.jsonb_build_object('sealed', true, 'filled', coalesce(p_filled, '[]'::jsonb),
          'dataVersion', p_data_version),
        step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = p_form_id and user_id = caller;
  else
    update public.member_forms set step = least(greatest(coalesce(p_step, 0), 0), 50), updated_at = now()
      where id = p_form_id and user_id = caller;
  end if;
  return p_form_id;
end;
end
$$;
revoke all on function public.save_sealed_form_draft(uuid, integer, boolean, jsonb, text)
  from public, anon, authenticated, service_role;

-- Final dispatcher: the 20260907152000 definition plus the sealed form draft.
create or replace function public.write_sensitive_content(p_operation text, p_arguments jsonb, p_envelopes jsonb, p_ticket uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  perform 1 from private.sensitive_write_tickets t where t.id = p_ticket
    and t.actor = (select auth.uid()) and t.operation = p_operation
    and t.arguments = p_arguments and t.envelopes = p_envelopes
    and t.expires_at > clock_timestamp() for update;
  if not found then raise exception 'sensitive-data-trusted-write-required' using errcode = '42501'; end if;
  perform set_config('app.sensitive_ticket', p_ticket::text, true);
  case p_operation
  when 'create_member_accommodation_request' then
    result := public.create_member_accommodation_request(p_arguments->>'p_request_type', p_arguments->>'p_description', (p_arguments->>'p_idempotency_key')::uuid);
  when 'transition_member_accommodation_request' then
    result := public.transition_member_accommodation_request((p_arguments->>'p_request_id')::uuid, p_arguments->>'p_status', p_arguments->>'p_staff_note', (p_arguments->>'p_idempotency_key')::uuid);
  when 'casework_submit_retaliation_report' then
    result := to_jsonb(public.casework_submit_retaliation_report((p_arguments->>'p_case_id')::uuid, (p_arguments->>'p_incident_at')::timestamptz,
      p_arguments->>'p_management_person', p_arguments->>'p_protected_activity', p_arguments->>'p_adverse_action', p_arguments->>'p_requested_support', (p_arguments->>'p_idempotency_key')::uuid));
  when 'casework_scan_retaliation_patterns' then
    result := to_jsonb(public.casework_scan_retaliation_patterns(p_arguments->>'p_chapter_id'));
  when 'casework_withdraw_retaliation_report' then
    result := to_jsonb(public.casework_withdraw_retaliation_report((p_arguments->>'p_report_id')::uuid, p_arguments->>'p_reason'));
  when 'save_sealed_form_draft' then
    result := to_jsonb(public.save_sealed_form_draft((p_arguments->>'p_form_id')::uuid, (p_arguments->>'p_step')::integer,
      (p_arguments->>'p_changed')::boolean, p_arguments->'p_filled', p_arguments->>'p_data_version'));
  else raise exception 'sensitive-data-operation-refused' using errcode = '42501';
  end case;
  perform set_config('app.sensitive_ticket', '', true);
  delete from private.sensitive_write_tickets where id = p_ticket;
  return result;
end
$$;
revoke execute on function public.write_sensitive_content(text, jsonb, jsonb, uuid) from service_role;

-- A row the backfill sealed after submission keeps its frozen content digest.
create or replace function private.form_content_digest(p_form_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- Only a sealed template's stored envelope makes the marker authoritative;
  -- an ordinary or legacy plaintext row's answers.legacyDigest is just an
  -- answer and never chooses the digest (#6363 round 1).
  select case when private.form_template_is_sealed(f.template_key) and f.encrypted_content ? 'answers'
    and f.answers->>'sealed' = 'true' and f.answers ? 'legacyDigest' then f.answers->>'legacyDigest'
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

-- An approved FMLA filing may change only once, from plaintext answers to the
-- sealed marker that freezes its existing content digest, and only through the
-- audited maintenance channel.
create or replace function private.enforce_approved_member_form_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sealing boolean := session_user in ('postgres','supabase_admin')
    and current_setting('role') in ('none','postgres','supabase_admin')
    and current_setting('app.sensitive_maintenance',true) = 'on'
    and private.form_template_is_sealed(old.template_key)
    -- Not yet sealed means no envelope; a legacy checkbox named "sealed" is
    -- an ordinary answer (#6363 round 1).
    and not coalesce(old.encrypted_content ? 'answers', false)
    and new.answers->>'sealed' = 'true'
    and new.answers->>'legacyDigest' is not distinct from old.content_digest
    and jsonb_typeof(new.answers->'filled') = 'array'
    and not exists (select 1 from jsonb_object_keys(new.answers) k
      where k not in ('sealed', 'filled', 'dataVersion', 'legacyDigest'));
begin
  if old.status = 'approved' and (
    new.status is distinct from old.status
    or (new.answers is distinct from old.answers and not sealing)
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

-- The 20260906020000 definition inside the reviewed case-graph wrapper that
-- 20260907151000 installed; a sealed row answers the required-key check from
-- the server-written "filled" list instead of plaintext.
create or replace function public.submit_form(p_form_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
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
  select id, user_id, status, template_key, template_version, answers, encrypted_content into rec
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
  if exists (select 1 from public.member_form_files ff
             where ff.form_id = p_form_id and ff.deletion_requested_at is null
               and not private.private_upload_is_current(ff.bucket_id, ff.object_name)) then
    raise exception 'wait for every attachment inspection to finish' using errcode = '22023';
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
  -- The server-written "filled" list answers the check only for a sealed
  -- template's enveloped row; elsewhere answers.sealed and answers.filled are
  -- ordinary answers and cannot stand in for required ones (#6363 round 1).
  where case when private.form_template_is_sealed(rec.template_key) and rec.encrypted_content ? 'answers'
      and rec.answers->>'sealed' = 'true' then not coalesce(rec.answers->'filled' ? k, false)
    when pg_catalog.jsonb_typeof(rec.answers -> k) = 'array'
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
end;
end
$function$;

-- Attachments of a sealed form use the case-file protection class: the server
-- encrypts the bytes with a per-file envelope (purpose "form-document") and
-- stores only ciphertext in member-form-files; the browser never writes them.
alter table public.member_form_files add column if not exists encrypted_content jsonb;
comment on column public.member_form_files.encrypted_content is
  'Ciphertext authentication metadata of a sealed (FMLA) form attachment; payload ciphertext is stored in member-form-files, never plaintext.';

create function private.member_form_object_is_sealed(p_object_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- Answers only for an object the caller may write, so it reveals nothing
  -- about another member's attachments.
  select private.can_write_member_form_object('member-form-files', p_object_name)
    and exists (select 1 from public.member_form_files ff join public.member_forms f on f.id = ff.form_id
    where ff.object_name = p_object_name and private.form_template_is_sealed(f.template_key));
$$;
revoke all on function private.member_form_object_is_sealed(text) from public, anon, service_role;
grant execute on function private.member_form_object_is_sealed(text) to authenticated;

-- Restrictive addition: existing feature ACL and quarantine policies remain.
create policy sealed_form_server_upload on storage.objects as restrictive
for insert to authenticated with check (bucket_id <> 'member-form-files' or not private.member_form_object_is_sealed(name));
create policy sealed_form_server_update on storage.objects as restrictive
for update to authenticated using (bucket_id <> 'member-form-files' or not private.member_form_object_is_sealed(name))
with check (bucket_id <> 'member-form-files' or not private.member_form_object_is_sealed(name));
-- SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022: only the
-- server (api/sensitive-form-files.js, service role) writes sealed FMLA form
-- attachments as ciphertext. The browser cannot upload plaintext or overwrite
-- ciphertext. Keep this explanation in source: the migration role does not
-- own storage.objects and cannot COMMENT ON its policies.

-- A sealed form's attachment cannot be confirmed before its envelope is set.
create function private.require_sealed_form_file_envelope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.confirmed_at is not null and old.confirmed_at is null and new.encrypted_content is null
    and exists (select 1 from public.member_forms f where f.id = new.form_id and private.form_template_is_sealed(f.template_key)) then
    raise exception 'sensitive-document-encryption-required' using errcode = '22023';
  end if;
  -- An envelope is set once; only the audited maintenance channel rewraps it
  -- in place on key rotation (same dataVersion, same ciphertext).
  if new.encrypted_content is distinct from old.encrypted_content and old.encrypted_content is not null
    and not (session_user in ('postgres','supabase_admin')
      and current_setting('role') in ('none','postgres','supabase_admin')
      and current_setting('app.sensitive_maintenance',true) = 'on'
      and new.encrypted_content->>'dataVersion' is not distinct from old.encrypted_content->>'dataVersion') then
    raise exception 'sensitive-data-identity-immutable' using errcode = '22023';
  end if;
  return new;
end
$$;
revoke all on function private.require_sealed_form_file_envelope() from public, anon, authenticated, service_role;
create trigger member_form_files_sealed_envelope
  before update on public.member_form_files
  for each row execute function private.require_sealed_form_file_envelope();

-- The 20260812222529 child-mutability trigger, plus one exception: the audited
-- maintenance channel may seal an approved FMLA filing's attachment (new
-- object, first envelope) or rewrap it (same dataVersion), changing nothing else.
create or replace function private.enforce_member_form_child_mutability()
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
    if tg_op = 'UPDATE' and tg_table_name = 'member_form_files'
       and session_user in ('postgres','supabase_admin')
       and current_setting('role') in ('none','postgres','supabase_admin')
       and current_setting('app.sensitive_maintenance',true) = 'on'
       and (old_json - 'object_name' - 'encrypted_content') = (new_json - 'object_name' - 'encrypted_content')
       and new_json -> 'encrypted_content' is not null and jsonb_typeof(new_json -> 'encrypted_content') = 'object'
       and ((old_json -> 'encrypted_content' = 'null'::jsonb and new_json ->> 'object_name' <> old_json ->> 'object_name')
         or (new_json ->> 'object_name' = old_json ->> 'object_name'
           and new_json -> 'encrypted_content' ->> 'dataVersion' = old_json -> 'encrypted_content' ->> 'dataVersion')) then
      return new;
    end if;
    raise exception 'approved filing children are immutable' using errcode = '22023';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function private.enforce_member_form_child_mutability()
  from public, anon, authenticated, service_role;

-- Plaintext member-form-files objects replaced by the attachment backfill,
-- retired only after the pointer swap is durable (bucket-qualified, unlike
-- the case-files ledger).
create table private.sensitive_retired_form_objects (object_name text primary key);
revoke all on private.sensitive_retired_form_objects from public, anon, authenticated, service_role;

-- Unconfirmed rows are hidden by ordinary RLS. This narrow upload target
-- reuses the registration's owner, MFA and lifecycle checks.
create function public.sensitive_form_upload_target(p_file_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.member_pin_require_full_session();

declare ff public.member_form_files%rowtype; form record;
begin
  perform private.casework_require_mfa();
  select * into ff from public.member_form_files where id = p_file_id
    and uploaded_by = (select auth.uid()) and confirmed_at is null and deletion_requested_at is null;
  if ff.id is null then raise exception 'file unavailable' using errcode = '42501'; end if;
  select f.user_id, f.status, f.template_key, f.organization_id into form from public.member_forms f where f.id = ff.form_id;
  if form.user_id is distinct from (select auth.uid()) or not private.form_template_is_sealed(form.template_key)
    or form.status not in ('draft', 'returned') or form.organization_id is null
    or form.organization_id is distinct from private.mi1_require_selected_organization() then
    raise exception 'file unavailable' using errcode = '42501';
  end if;
  return to_jsonb(ff) || jsonb_build_object('organization_id', form.organization_id);
end;
end
$$;
revoke all on function public.sensitive_form_upload_target(uuid) from public, anon, service_role;
grant execute on function public.sensitive_form_upload_target(uuid) to authenticated;

create function public.set_sensitive_form_envelope(p_file_id uuid, p_envelope jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare org uuid; changed integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  select f.organization_id into org from public.member_form_files ff join public.member_forms f on f.id = ff.form_id
    where ff.id = p_file_id and private.form_template_is_sealed(f.template_key);
  if org is null
    or p_envelope->>'organization' is distinct from org::text
    or p_envelope->>'record' is distinct from p_file_id::text
    or p_envelope->>'field' is distinct from 'bytes'
    or p_envelope->>'purpose' is distinct from 'form-document'
    or p_envelope->>'schema' is distinct from '1'
    or p_envelope->'payload' ? 'ciphertext'
  then raise exception 'invalid envelope' using errcode = '22023'; end if;
  update public.member_form_files set encrypted_content = p_envelope
  where id = p_file_id and encrypted_content is null and confirmed_at is null and deletion_requested_at is null;
  get diagnostics changed = row_count;
  return changed = 1;
end
$$;
revoke all on function public.set_sensitive_form_envelope(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.set_sensitive_form_envelope(uuid,jsonb) to service_role;

-- Bounded temporary ciphertext transport, as for case files. No foreign key:
-- a chunk is an hour-bounded ciphertext fragment the API purges on expiry and
-- on finish, so it stays outside the account case-graph closure.
create table public.sensitive_form_chunks (
  file_id uuid not null,
  chunk_index integer not null check(chunk_index between 0 and 9),
  envelope jsonb not null check(pg_column_size(envelope) <= 1500000),
  expires_at timestamptz not null default now() + interval '1 hour',
  primary key(file_id,chunk_index)
);
alter table public.sensitive_form_chunks enable row level security;
create policy mfa_assurance on public.sensitive_form_chunks as restrictive for all to authenticated
using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));
comment on policy mfa_assurance on public.sensitive_form_chunks is
  'Same as sensitive_case_chunks: no client privileges; a stolen aal1 token can never reach the temporary ciphertext chunks of a sealed form attachment.';
revoke all on public.sensitive_form_chunks from public, anon, authenticated;
grant select, insert, update, delete on public.sensitive_form_chunks to service_role;

create function public.sensitive_form_read_current(p_file_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select private.private_upload_is_current('member-form-files', ff.object_name)
    from public.member_form_files ff where ff.id = p_file_id
$$;
revoke all on function public.sensitive_form_read_current(uuid) from public, anon, service_role;
grant execute on function public.sensitive_form_read_current(uuid) to authenticated;

-- The inspector's bounded projection for an active attempt on this exact object.
create function public.sensitive_form_inspection_metadata(p_file_id uuid, p_attempt_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('id', ff.id, 'size_bytes', ff.size_bytes,
    'object_name', ff.object_name, 'encrypted_content', ff.encrypted_content,
    'organization_id', f.organization_id)
  from public.member_form_files ff
  join public.member_forms f on f.id = ff.form_id
  join private.private_upload_inspection_attempts a
    on a.bucket_id = ff.bucket_id and a.object_name = ff.object_name
  join storage.objects o on o.id = a.object_id
    and o.bucket_id = a.bucket_id and o.name = a.object_name
    and o.version is not distinct from a.object_version
  where (select auth.role()) = 'service_role'
    and ff.id = p_file_id and ff.bucket_id = 'member-form-files' and a.id = p_attempt_id
    and a.completed_at is null and a.expires_at > clock_timestamp()
    and ff.deletion_requested_at is null and ff.encrypted_content is not null
    and private.form_template_is_sealed(f.template_key)
$$;
revoke all on function public.sensitive_form_inspection_metadata(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sensitive_form_inspection_metadata(uuid,uuid) to service_role;

-- Register only this delivery's reviewed lifecycle surface. Existing FK
-- cascades retain the parent/child trigger exceptions, while unchanged-answer
-- and unchanged-envelope updates preserve identity detachment. Other entries
-- remain pinned to their previous definitions; do not refresh the whole graph.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select 'function', n.nspname, '', p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
  pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where p.oid in (
  'private.require_sealed_form_file_envelope()'::regprocedure,
  'private.enforce_member_form_child_mutability()'::regprocedure,
  'private.require_sealed_form_answers()'::regprocedure,
  'private.enforce_approved_member_form_immutability()'::regprocedure,
  'private.form_template_is_sealed(text)'::regprocedure,
  'private.sealed_form_envelope_valid(jsonb,uuid,uuid)'::regprocedure,
  'public.save_sealed_form_draft(uuid,integer,boolean,jsonb,text)'::regprocedure
)
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

-- save_form_draft keeps its existing review entry, refreshed to this body.
update private.account_lifecycle_trigger_review r
  set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef('public.save_form_draft(text,jsonb,integer)'::regprocedure))
  where r.kind = 'function' and r.schema_name = 'public' and r.table_name = ''
    and r.object_name = 'save_form_draft(p_template_key text, p_answers jsonb, p_step integer)';

insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select 'trigger', n.nspname, c.relname, t.tgname,
  pg_catalog.md5(pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text)
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal and n.nspname = 'public'
  and ((c.relname = 'member_forms' and t.tgname = 'member_forms_sealed_answers')
    or (c.relname = 'member_form_files' and t.tgname = 'member_form_files_sealed_envelope'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

commit;
