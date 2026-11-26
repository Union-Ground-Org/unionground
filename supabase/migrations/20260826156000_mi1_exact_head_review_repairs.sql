-- Exact-head review repairs are additive: explicit Q&A outcomes, actor-bound
-- idempotency, RSVP limiter ordering/retention, bounded integration inputs,
-- webhook rotation, durable leases, and observable scheduler history.

-- Keep private mutation receipts isolated by both tenant and actor without
-- requiring every already-published function to grow a new column list. The
-- compatibility view exposes only the current actor's rows and binds inserts
-- in one server-owned trigger.
alter table private.mi1_w2_operation_receipts
  rename to mi1_w2_operation_receipt_rows;

alter table private.mi1_w2_operation_receipt_rows
  add column actor_user_id uuid;

update private.mi1_w2_operation_receipt_rows
set actor_user_id = '00000000-0000-0000-0000-000000000000'::uuid
where actor_user_id is null;

alter table private.mi1_w2_operation_receipt_rows
  alter column actor_user_id set not null,
  drop constraint mi1_w2_operation_receipts_pkey,
  add constraint mi1_w2_operation_receipt_rows_pkey
    primary key (organization_id, actor_user_id, operation, idempotency_key);

create view private.mi1_w2_operation_receipts
with (security_barrier = true)
as
select organization_id, operation, idempotency_key, request_payload, result, created_at
from private.mi1_w2_operation_receipt_rows
where actor_user_id = (select auth.uid());

create function private.mi1_w2_bind_operation_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.uid()) is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  insert into private.mi1_w2_operation_receipt_rows (
    organization_id, actor_user_id, operation, idempotency_key,
    request_payload, result, created_at
  ) values (
    new.organization_id, (select auth.uid()), new.operation,
    new.idempotency_key, new.request_payload, new.result,
    coalesce(new.created_at, pg_catalog.now())
  );
  return new;
end;
$function$;

create trigger mi1_w2_operation_receipts_insert
instead of insert on private.mi1_w2_operation_receipts
for each row execute function private.mi1_w2_bind_operation_receipt();

revoke all on table private.mi1_w2_operation_receipt_rows from public, anon, authenticated, service_role;
revoke all on table private.mi1_w2_operation_receipts from public, anon, authenticated, service_role;
revoke all on function private.mi1_w2_bind_operation_receipt() from public, anon, authenticated, service_role;

-- File idempotency is actor-bound too. A deliberate UUID collision from a
-- second administrator must not replay or block another actor's upload.
drop index public.organization_knowledge_files_idempotency_key;
create unique index organization_knowledge_files_actor_idempotency_key
  on public.organization_knowledge_files (organization_id, created_by, idempotency_key)
  where idempotency_key is not null;

create or replace function public.prepare_steward_library_upload(
  p_file_name text,
  p_byte_size bigint,
  p_content_sha256 text,
  p_title text,
  p_summary text,
  p_category text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  chapter text := private.current_member_chapter();
  safe_name text := private.mi1_w2_safe_file_name(p_file_name);
  actor_id uuid := (select auth.uid());
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb;
  created uuid;
  handle uuid;
  result jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_byte_size is null or p_byte_size <= 0 or p_byte_size > 10485760 then
    raise exception 'file size is outside the allowed range' using errcode = '22023';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  request_payload := pg_catalog.jsonb_build_object(
    'fileName', safe_name,
    'byteSize', p_byte_size,
    'contentSha256', coalesce(p_content_sha256, ''),
    'title', coalesce(pg_catalog.btrim(p_title), ''),
    'summary', coalesce(pg_catalog.btrim(p_summary), ''),
    'category', coalesce(nullif(p_category, ''), 'general')
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'prepare_steward_library_upload:' || org::text || ':' || actor_id::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org
    and receipt.operation = 'prepare_steward_library_upload'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  insert into public.organization_knowledge_files (
    organization_id, chapter_id, library, title, summary, category, file_name,
    byte_size, content_sha256, storage_path, idempotency_key, created_by
  ) values (
    org,
    case when chapter is not null and private.mi1_w2_same_org_chapter(org, chapter) then chapter else null end,
    'steward', coalesce(nullif(pg_catalog.btrim(coalesce(p_title, '')), ''), safe_name),
    pg_catalog.btrim(coalesce(p_summary, '')), coalesce(nullif(p_category, ''), 'general'),
    safe_name, p_byte_size, nullif(p_content_sha256, ''), 'pending', p_idempotency_key, actor_id
  ) returning id, storage_handle into created, handle;
  update public.organization_knowledge_files
  set storage_path = 'org/' || org::text || '/' || created::text || '/' || safe_name
  where id = created;
  perform private.mi1_w2_write_audit(org, 'knowledge_file_uploaded', pg_catalog.jsonb_build_object(
    'organizationId', org, 'fileId', created, 'library', 'steward',
    'category', coalesce(nullif(p_category, ''), 'general'),
    'reviewStatus', 'pending_scan', 'byteSize', p_byte_size, 'action', 'uploaded'
  ));
  result := pg_catalog.jsonb_build_object('uploadId', created, 'fileId', created, 'storageHandle', handle);
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'prepare_steward_library_upload', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

revoke all on function public.prepare_steward_library_upload(text, bigint, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_steward_library_upload(text, bigint, text, text, text, text, uuid)
  to authenticated;

-- Restriction writes receive the same retry contract. Audit rows describe
-- actual changes only; an unchanged access set does not emit a second event.
drop function if exists public.set_case_restriction(uuid, boolean, text, uuid[]);
create function public.set_case_restriction(
  p_case_id uuid,
  p_restricted boolean,
  p_reason text,
  p_access_user_ids uuid[],
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_w2_selected_organization();
  actor_id uuid := (select auth.uid());
  found_case public.member_cases%rowtype;
  normalized_access uuid[];
  previous_access uuid[];
  previous_restricted boolean;
  previous_reason text;
  restriction_changed boolean;
  access_changed boolean;
  cached jsonb;
  cached_request jsonb;
  request_payload jsonb;
  result jsonb;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if not private.has_organization_role(org, array['coordinator', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency key required' using errcode = '22023'; end if;
  found_case := private.mi1_w2_require_visible_case(org, p_case_id);
  select coalesce(pg_catalog.array_agg(distinct requested.user_id order by requested.user_id), '{}'::uuid[])
  into normalized_access
  from unnest(coalesce(p_access_user_ids, '{}'::uuid[])) as requested(user_id);
  if exists (
    select 1 from unnest(normalized_access) requested(user_id)
    where requested.user_id is null or not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = org and membership.user_id = requested.user_id
        and membership.status = 'active'
    )
  ) then
    raise exception 'case restriction access user is not an active organization member' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object(
    'caseId', found_case.id, 'restricted', coalesce(p_restricted, false),
    'reason', coalesce(nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''), ''),
    'accessUserIds', pg_catalog.to_jsonb(normalized_access)
  );
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'set_case_restriction:' || org::text || ':' || actor_id::text || ':' || p_idempotency_key::text, 509
  ));
  select receipt.result, receipt.request_payload into cached, cached_request
  from private.mi1_w2_operation_receipts receipt
  where receipt.organization_id = org and receipt.operation = 'set_case_restriction'
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if cached_request is distinct from request_payload then
      raise exception 'idempotency key reused for a different request' using errcode = '22023';
    end if;
    return cached;
  end if;
  select r.restricted, r.reason into previous_restricted, previous_reason
  from public.case_restrictions r where r.organization_id = org and r.case_id = found_case.id;
  restriction_changed := not found
    or previous_restricted is distinct from coalesce(p_restricted, false)
    or previous_reason is distinct from nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  select coalesce(pg_catalog.array_agg(a.user_id order by a.user_id), '{}'::uuid[])
  into previous_access
  from public.case_restriction_access a
  where a.organization_id = org and a.case_id = found_case.id;
  access_changed := previous_access is distinct from normalized_access;
  insert into public.case_restrictions (organization_id, case_id, restricted, reason, actor_user_id)
  values (org, found_case.id, coalesce(p_restricted, false), nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''), actor_id)
  on conflict (organization_id, case_id) do update
    set restricted = excluded.restricted, reason = excluded.reason,
        actor_user_id = excluded.actor_user_id, updated_at = pg_catalog.now();
  if access_changed then
    delete from public.case_restriction_access a
    where a.organization_id = org and a.case_id = found_case.id;
    insert into public.case_restriction_access (organization_id, case_id, user_id, granted_by)
    select org, found_case.id, uid, actor_id from unnest(normalized_access) uid;
  end if;
  if restriction_changed then
    perform private.mi1_w2_write_audit(org, 'case_restriction_toggled', pg_catalog.jsonb_build_object(
      'organizationId', org, 'caseId', found_case.id, 'restricted', coalesce(p_restricted, false)
    ));
  end if;
  if access_changed then
    perform private.mi1_w2_write_audit(org, 'case_restriction_access_changed', pg_catalog.jsonb_build_object(
      'organizationId', org, 'caseId', found_case.id, 'restricted', coalesce(p_restricted, false)
    ));
  end if;
  result := pg_catalog.jsonb_build_object('caseId', found_case.id, 'restricted', coalesce(p_restricted, false));
  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (org, 'set_case_restriction', p_idempotency_key, request_payload, result);
  return result;
end;
$function$;

revoke all on function public.set_case_restriction(uuid, boolean, text, uuid[], uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.set_case_restriction(uuid, boolean, text, uuid[], uuid) to authenticated;

-- Q&A outcome RPCs are setters, not toggles. Repeating a request after a lost
-- response converges on the same state and emits no duplicate audit event.
drop function if exists public.toggle_member_qa_vote(text, uuid);
create function public.toggle_member_qa_vote(p_target_kind text, p_target_id uuid, p_voted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  reply public.member_qa_replies%rowtype;
  was_voted boolean;
  desired boolean := coalesce(p_voted, false);
  next_count integer;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_target_kind not in ('question', 'reply') then raise exception 'invalid vote target' using errcode = '22023'; end if;
  if p_target_kind = 'question' then
    select * into question from public.member_qa_questions where id = p_target_id and deleted_at is null for update;
  else
    select * into reply from public.member_qa_replies where id = p_target_id and deleted_at is null;
    if found then select * into question from public.member_qa_questions where id = reply.question_id and deleted_at is null for update; end if;
  end if;
  if question.id is null or question.organization_id is distinct from org
     or not private.mi1_qa_can_see(question.organization_id, question.chapter_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  select exists (
    select 1 from public.member_qa_votes v
    where v.user_id = (select auth.uid())
      and ((p_target_kind = 'question' and v.question_id = question.id)
        or (p_target_kind = 'reply' and v.reply_id = reply.id))
  ) into was_voted;
  if desired and not was_voted then
    insert into public.member_qa_votes (organization_id, user_id, question_id, reply_id)
    values (org, (select auth.uid()),
      case when p_target_kind = 'question' then question.id end,
      case when p_target_kind = 'reply' then reply.id end);
  elsif not desired and was_voted then
    delete from public.member_qa_votes v
    where v.user_id = (select auth.uid())
      and ((p_target_kind = 'question' and v.question_id = question.id)
        or (p_target_kind = 'reply' and v.reply_id = reply.id));
  end if;
  if p_target_kind = 'question' then
    update public.member_qa_questions q set upvote_count = (
      select pg_catalog.count(*) from public.member_qa_votes v where v.question_id = q.id
    ) where q.id = question.id returning upvote_count into next_count;
  else
    update public.member_qa_replies r set upvote_count = (
      select pg_catalog.count(*) from public.member_qa_votes v where v.reply_id = r.id
    ) where r.id = reply.id returning upvote_count into next_count;
  end if;
  if was_voted is distinct from desired then
    perform private.mi1_write_tenant_audit(org, 'qa_vote_toggled', pg_catalog.jsonb_build_object(
      'organizationId', org, 'chapterId', question.chapter_id,
      'questionId', question.id, 'targetKind', p_target_kind, 'voted', desired
    ));
  end if;
  return pg_catalog.jsonb_build_object(
    'voted', desired, 'upvoteCount', next_count,
    'question', private.mi1_qa_project_question(question.id, (select auth.uid()))
  );
end;
$function$;

drop function if exists public.accept_member_qa_answer(uuid, uuid);
create function public.accept_member_qa_answer(p_question_id uuid, p_reply_id uuid, p_accepted boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  question public.member_qa_questions%rowtype;
  reply public.member_qa_replies%rowtype;
  desired boolean := coalesce(p_accepted, false);
  was_accepted boolean;
  next_status text;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into question from public.member_qa_questions where id = p_question_id and deleted_at is null for update;
  select * into reply from public.member_qa_replies where id = p_reply_id and deleted_at is null;
  if question.id is null or reply.id is null or question.organization_id is distinct from org
     or reply.organization_id is distinct from org or reply.question_id is distinct from question.id then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if reply.kind is distinct from 'official' then raise exception 'only official replies can be accepted' using errcode = '22023'; end if;
  if question.author_user_id is distinct from (select auth.uid())
     and not private.mi1_qa_is_officer(question.organization_id, question.chapter_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  was_accepted := question.accepted_reply_id is not distinct from reply.id;
  if desired then
    update public.member_qa_replies set accepted = (id = reply.id), updated_at = pg_catalog.now()
    where question_id = question.id and accepted is distinct from (id = reply.id);
    update public.member_qa_questions set accepted_reply_id = reply.id, status = 'accepted', updated_at = pg_catalog.now()
    where id = question.id and (accepted_reply_id is distinct from reply.id or status is distinct from 'accepted');
    next_status := 'accepted';
  elsif was_accepted then
    update public.member_qa_replies set accepted = false, updated_at = pg_catalog.now()
    where question_id = question.id and accepted;
    next_status := case when exists (
      select 1 from public.member_qa_replies r
      where r.question_id = question.id and r.deleted_at is null and r.kind = 'official'
    ) then 'replied' else 'open' end;
    update public.member_qa_questions set accepted_reply_id = null, status = next_status, updated_at = pg_catalog.now()
    where id = question.id and (accepted_reply_id is not null or status is distinct from next_status);
  else
    next_status := question.status;
  end if;
  if was_accepted is distinct from desired then
    perform private.mi1_write_tenant_audit(
      org, case when desired then 'qa_answer_accepted' else 'qa_answer_unaccepted' end,
      pg_catalog.jsonb_build_object(
        'organizationId', org, 'chapterId', question.chapter_id,
        'questionId', question.id, 'replyId', reply.id, 'status', next_status
      )
    );
  end if;
  return private.mi1_qa_project_question(question.id, (select auth.uid()));
end;
$function$;

revoke all on function public.toggle_member_qa_vote(text, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.toggle_member_qa_vote(text, uuid, boolean) to authenticated;
revoke all on function public.accept_member_qa_answer(uuid, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.accept_member_qa_answer(uuid, uuid, boolean) to authenticated;

alter table public.member_qa_questions
  add constraint member_qa_questions_body_controls
  check (body !~ E'[\\001-\\010\\013\\014\\016-\\037\\177]') not valid;
alter table public.member_qa_questions validate constraint member_qa_questions_body_controls;
alter table public.member_qa_replies
  add constraint member_qa_replies_body_controls
  check (body !~ E'[\\001-\\010\\013\\014\\016-\\037\\177]') not valid;
alter table public.member_qa_replies validate constraint member_qa_replies_body_controls;

-- Public RSVP retention is scheduled whenever pg_cron is available. Consume
-- the per-email allowance before the event-wide allowance so an abusive email
-- cannot drain the shared event budget after its own cap is exhausted.
do $schedule$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'mi1-public-rsvp-retention';
  perform cron.schedule(
    'mi1-public-rsvp-retention', '17 4 * * *',
    'select private.purge_expired_public_event_rsvps();'
  );
end;
$schedule$;

create or replace function public.submit_public_event_rsvp(
  p_event_id text, p_email text, p_name text, p_locale text,
  p_source text, p_website text, p_scope_hash text, p_email_scope_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  event_org uuid;
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  normalized_name text := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  event_scope_hash text;
  moment timestamptz := clock_timestamp();
  network_allowed boolean;
  email_allowed boolean := false;
  event_allowed boolean := false;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.btrim(coalesce(p_website, '')) <> '' then return pg_catalog.jsonb_build_object('accepted', true); end if;
  if p_scope_hash is null or p_scope_hash !~ '^[0-9a-f]{64}$'
     or p_email_scope_hash is null or p_email_scope_hash !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  if pg_catalog.char_length(coalesce(p_event_id, '')) not between 1 and 128
     or pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or (normalized_name is not null and pg_catalog.char_length(normalized_name) > 100)
     or p_source is distinct from 'public-event-rsvp'
     or p_locale is null or p_locale not in ('en', 'es') then
    return pg_catalog.jsonb_build_object('accepted', true);
  end if;
  network_allowed := private.consume_public_event_rsvp_limit(p_scope_hash, 'network-15m', 20, interval '15 minutes');
  if network_allowed then
    select r.organization_id into event_org from public.public_site_records r
    where r.id = p_event_id and r.is_published and r.kind = 'meeting' and r.organization_id is not null;
  end if;
  if network_allowed and event_org is not null then
    email_allowed := private.consume_public_event_rsvp_limit(
      p_email_scope_hash, 'email-event-day', 3, interval '1 day'
    );
  end if;
  if network_allowed and email_allowed then
    event_scope_hash := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(event_org::text || ':' || p_event_id, 'UTF8'), 'sha256'), 'hex'
    );
    event_allowed := private.consume_public_event_rsvp_limit(event_scope_hash, 'event-day', 500, interval '1 day');
  end if;
  if network_allowed and email_allowed and event_allowed then
    insert into public.public_event_rsvps (organization_id, event_id, email, name, locale)
    values (event_org, p_event_id, normalized_email, normalized_name, p_locale)
    on conflict (event_id, email) do nothing;
  end if;
  delete from private.public_event_rsvp_limits as stale
  where stale.ctid in (
    select candidate.ctid from private.public_event_rsvp_limits as candidate
    where candidate.window_started_at < moment - interval '2 days'
      and candidate.scope_hash <> all(pg_catalog.array_remove(
        array[p_scope_hash, p_email_scope_hash, event_scope_hash]::text[], null
      ))
    order by candidate.window_started_at limit 200 for update skip locked
  );
  return pg_catalog.jsonb_build_object('accepted', true);
end;
$function$;

revoke all on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_public_event_rsvp(text, text, text, text, text, text, text, text)
  to service_role;

-- Bound configuration payloads at rest, regardless of which RPC reaches them.
alter table public.organization_integrations
  add constraint organization_integrations_settings_bounded
    check (pg_catalog.pg_column_size(default_settings) <= 65536) not valid,
  add constraint organization_integrations_credential_ref_bounded
    check (credential_ref is null or pg_catalog.char_length(credential_ref) <= 200) not valid;
alter table public.organization_integrations validate constraint organization_integrations_settings_bounded;
alter table public.organization_integrations validate constraint organization_integrations_credential_ref_bounded;
alter table public.chapter_integration_overrides
  add constraint chapter_integration_overrides_settings_bounded
    check (pg_catalog.pg_column_size(override_settings) <= 65536) not valid,
  add constraint chapter_integration_overrides_credential_ref_bounded
    check (credential_ref is null or pg_catalog.char_length(credential_ref) <= 200) not valid;
alter table public.chapter_integration_overrides validate constraint chapter_integration_overrides_settings_bounded;
alter table public.chapter_integration_overrides validate constraint chapter_integration_overrides_credential_ref_bounded;

-- Reject integer-form IPv4 hosts at the server boundary as well as in the UI.
create or replace function private.mi1_integration_url_has_integer_host(p_url text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select coalesce(p_url ~ '^https://[0-9]+([:/]|$)', false)
$function$;
revoke all on function private.mi1_integration_url_has_integer_host(text) from public, anon, authenticated, service_role;
alter table public.integration_webhooks
  add constraint integration_webhooks_integer_host_denied
  check (not private.mi1_integration_url_has_integer_host(url)) not valid;
alter table public.integration_webhooks validate constraint integration_webhooks_integer_host_denied;

-- Webhook secret rotation keeps the endpoint and subscriptions stable, swaps
-- Vault custody transactionally, and displays the replacement exactly once.
create function public.rotate_integration_webhook_secret(p_webhook_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_integration_admin();
  hook public.integration_webhooks%rowtype;
  plaintext text := 'whsec_' || pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  next_hash text;
  next_ref uuid;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  select * into hook from public.integration_webhooks
  where id = p_webhook_id and organization_id = org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  next_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(plaintext, 'UTF8'), 'sha256'), 'hex');
  next_ref := vault.create_secret(
    plaintext, 'mi1-webhook-' || hook.id::text || '-' || extensions.gen_random_uuid()::text,
    'Rotated organization webhook signing secret'
  );
  update public.integration_webhooks set secret_hash = next_hash, secret_ref = next_ref
  where id = hook.id and organization_id = org;
  if hook.secret_ref is not null then delete from vault.secrets where id = hook.secret_ref; end if;
  perform private.mi1_write_tenant_audit(org, 'integration_webhook_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'host', (pg_catalog.regexp_match(hook.url, '^https://([^/]+)'))[1], 'status', 'secret_rotated'
  ));
  return pg_catalog.jsonb_build_object('signingSecret', plaintext);
end;
$function$;

revoke all on function public.rotate_integration_webhook_secret(uuid) from public, anon, authenticated, service_role;
grant execute on function public.rotate_integration_webhook_secret(uuid) to authenticated;

-- A claimed delivery may spend 3s resolving, 10s connecting, and additional
-- time recording. Ten minutes keeps the lease safely beyond the 300s worker.
create or replace function public.claim_integration_webhook_deliveries(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare result jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.mi1_reap_expired_webhook_final_attempts();
  with candidates as (
    select d.id from public.integration_webhook_deliveries d
    join public.integration_webhooks w on w.id = d.webhook_id and w.organization_id = d.organization_id
    where w.active and (
      (d.status in ('queued', 'failed') and coalesce(d.next_attempt_at, d.created_at) <= pg_catalog.now())
      or (d.status = 'sending' and d.lease_expires_at <= pg_catalog.now() and d.attempt_count < 5)
    ) order by coalesce(d.next_attempt_at, d.created_at), d.id
    limit greatest(1, least(coalesce(p_limit, 10), 25)) for update of d skip locked
  ), claimed as (
    update public.integration_webhook_deliveries d
    set status = 'sending', attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '10 minutes',
        next_attempt_at = null, error_code = null
    from candidates where d.id = candidates.id
    returning d.*
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'deliveryId', d.id, 'attemptCount', d.attempt_count, 'url', w.url,
    'eventName', d.event_name, 'eventId', d.event_id, 'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) order by d.created_at, d.id), '[]'::jsonb) into result
  from claimed d join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;
  update public.integration_jobs j set status = 'running', updated_at = pg_catalog.now()
  where exists (
    select 1 from pg_catalog.jsonb_array_elements(result) entry
    join public.integration_webhook_deliveries d on d.id = (entry->>'deliveryId')::uuid
    where j.organization_id = d.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text
  );
  return result;
end;
$function$;

revoke all on function public.claim_integration_webhook_deliveries(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_integration_webhook_deliveries(integer) to service_role;

create or replace function public.claim_integration_webhook_delivery(p_delivery_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare claimed jsonb;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  perform private.mi1_reap_expired_webhook_final_attempts();
  with candidate as (
    select d.id from public.integration_webhook_deliveries d
    join public.integration_webhooks w on w.id = d.webhook_id and w.organization_id = d.organization_id
    where d.id = p_delivery_id and w.active and w.secret_ref is not null and (
      (d.status in ('queued', 'failed') and coalesce(d.next_attempt_at, d.created_at) <= pg_catalog.now())
      or (d.status = 'sending' and d.lease_expires_at <= pg_catalog.now() and d.attempt_count < 5)
    ) and d.attempt_count < 5
    for update of d skip locked
  ), claimed_delivery as (
    update public.integration_webhook_deliveries d
    set status = 'sending', attempt_count = d.attempt_count + 1,
        lease_expires_at = pg_catalog.now() + interval '10 minutes',
        next_attempt_at = null, error_code = null
    from candidate where d.id = candidate.id returning d.*
  )
  select pg_catalog.jsonb_build_object(
    'deliveryId', d.id, 'attemptCount', d.attempt_count, 'url', w.url,
    'eventName', d.event_name, 'eventId', d.event_id, 'occurredAt', d.created_at,
    'secret', s.decrypted_secret
  ) into claimed
  from claimed_delivery d join public.integration_webhooks w on w.id = d.webhook_id
  join vault.decrypted_secrets s on s.id = w.secret_ref;
  if claimed is not null then
    update public.integration_jobs j set status = 'running', updated_at = pg_catalog.now()
    from public.integration_webhook_deliveries d
    where d.id = (claimed->>'deliveryId')::uuid
      and j.organization_id = d.organization_id
      and j.idempotency_key = 'delivery:' || d.id::text;
  end if;
  return claimed;
end;
$function$;

revoke all on function public.claim_integration_webhook_delivery(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_integration_webhook_delivery(uuid) to service_role;

-- Mirror pg_cron history into the admin health desk. This observes the actual
-- scheduled command outcome; it does not invent successful runs.
do $jobs$
begin
  if pg_catalog.to_regnamespace('cron') is null then return; end if;
  execute $ddl$
    create function private.sync_organization_job_runs_from_cron_history()
    returns integer
    language plpgsql
    security definer
    set search_path = ''
    as $function$
    declare inserted_count integer;
    begin
      insert into public.organization_job_runs (
        organization_id, job_name, run_id, status, started_at, finished_at, failure_code, redacted_summary
      )
      select null, j.jobname, 'cron:' || d.runid::text,
        case d.status when 'succeeded' then 'completed' when 'running' then 'in_progress' else 'failed' end,
        coalesce(d.start_time, pg_catalog.now()), d.end_time,
        case when d.status in ('succeeded', 'running') then null else 'cron_failed' end,
        case when d.status in ('succeeded', 'running') then null else 'Scheduled command failed.' end
      from cron.job_run_details d join cron.job j on j.jobid = d.jobid
      where j.jobname in (
        'notifications-dispatch-tick', 'notifications-expiry-sweep', 'deadline-notices-tick',
        'ballot-notices-tick', 'event-notices-tick', 'appointment-reminders-tick',
        'member-messaging-dispatch', 'workload-reminders-tick', 'ballot-choices-mix',
        'ballot-choices-mix-recent', 'task-files-reconcile-tick', 'task-maintenance-daily'
      ) and d.start_time >= pg_catalog.now() - interval '14 days'
      on conflict (job_name, run_id, organization_id) do update
        set status = excluded.status, finished_at = excluded.finished_at,
            failure_code = excluded.failure_code, redacted_summary = excluded.redacted_summary;
      get diagnostics inserted_count = row_count;
      return inserted_count;
    end;
    $function$
  $ddl$;
  revoke all on function private.sync_organization_job_runs_from_cron_history()
    from public, anon, authenticated, service_role;
  perform cron.unschedule(jobid) from cron.job where jobname = 'mi1-job-health-sync';
  perform cron.schedule(
    'mi1-job-health-sync', '* * * * *',
    'select private.sync_organization_job_runs_from_cron_history();'
  );
end;
$jobs$;

notify pgrst, 'reload schema';
