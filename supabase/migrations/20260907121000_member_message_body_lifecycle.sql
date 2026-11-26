begin;

-- SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904 — direct-message deletion,
-- redaction and retention semantics.
--
-- PROBLEM. public.member_messages stored plaintext conversation bodies with no
-- removal path at all: 20260725120000 narrowed the client UPDATE grant to
-- read_at, so neither a member nor a steward could remove content they sent,
-- and 20260830180000 (the MI1 retention engine) never classified the table, so
-- nothing expired either. A member who believed a message was gone was wrong in
-- every projection: reads, the mobile summary view, the steward pager, the
-- member data export, saved-message and reminder previews, and any cached
-- client copy all kept serving the original text forever.
--
-- SHAPE OF THE FIX — destructive redaction, not a soft flag.
-- The body column is CLEARED in place and the row survives as a tombstone.
-- A visibility flag would have been cheaper and wrong: every one of the
-- projections above would then have to remember to filter, and a single missed
-- projection is content the user believes deleted still being served. With the
-- text physically gone source readers cannot recover it. Persisted derivatives
-- additionally require invalidation and source-revision checks (section 6).
--
-- WHAT SURVIVES A REDACTION (the "minimal auditable tombstone metadata"):
--   redacted_at        when the content was removed
--   redacted_by        who removed it (null once that account is deleted)
--   redaction_reason   sender_removed | staff_removed | retention_expired | account_closed
--   body_sha256        digest of the removed text — proves what was there
--                      without retaining it, so a later dispute can be settled
--                      against a copy someone else still holds
--   original_length    bounded size evidence
-- The removed body itself is never copied into an audit value, a ledger
-- metadata field, or a log line.
--
-- RETENTION DEFAULT (owner input under the best-practice mandate; recorded in
-- The "Message body lifecycle contract" and
--   default 1095 days (3 years), floor 365 days, ceiling 2555 days (7 years).
-- The floor is evidence-protective: representation content is grievance and
-- arbitration evidence, and a tenant must not be able to configure a window
-- shorter than a normal grievance-to-arbitration cycle and destroy a member's
-- own record. The ceiling is privacy-forward: conversation content is not a
-- permanent corporate record. Execution stays disabled until an organization
-- administrator types the confirmation phrase, exactly like every other class.
--
-- LEGAL HOLD. public.member_message_legal_holds suspends every redaction path
-- — member, staff and retention — for a conversation. Only an organization
-- administrator with an MFA-assured session may place or release one, and both
-- events are written to the append-only organization ledger.
--
-- ACCOUNT DELETION. The 'account_closed' reason exists for the account-lifecycle
-- deletion path. The account boundary below detaches held evidence before any
-- cascade and sends unheld bodies through the disposition workers. The deletion and export dispositions themselves are recorded
-- once, in private.account_lifecycle_manifest, owned by
-- BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION. private.member_message_body_disposition()
-- here records only what that manifest's column set cannot express: the redaction
-- function, the retention data class and the legal-hold table. See section 4.
--
-- ROLLBACK: this migration is not safely reversible. Redaction destroys
-- content by design. Reverting the schema would leave tombstoned rows whose
-- bodies are already gone and whose check constraint no longer permits them.

-- LOCK ORDER (round 3): global message lifecycle transaction gate FIRST,
-- conversation advisory locks SECOND, row locks LAST. The gate serializes
-- destructive messaging transactions, so arbitrary multi-conversation row order
-- cannot form a cycle. BEFORE STATEMENT triggers enter it before direct DML
-- obtains row locks, including auth deletion and hold writes. Workers enter it
-- before reading/locking their run or source row. The dispatch and retention
-- schedulers enter at their outer boundary, before draft/reminder/policy locks;
-- retention admin validation and action decisions enter before their own locks.
-- Migration 045000 pins the transitive writer/trigger-host closure: 108 other
-- outer entries and 27 statement hosts. This includes ordinary sends, resources,
-- task maintenance and local fixture maintenance. All affected writes serialize;
-- this throughput cost is intentional pending a separately verified protocol.
-- Conversation holds are always
-- rechecked after locking with READ COMMITTED. This deliberately trades parallel
-- destructive throughput for a single order across direct SQL and FK cascades.
set local lock_timeout = '5s';

do $$
begin
  if pg_catalog.to_regclass('public.member_messages') is null then
    raise exception 'public.member_messages is missing; apply 20260720191847_fresh_member_workflows first'
      using errcode = '42P01';
  end if;
  if pg_catalog.to_regprocedure('private.retention_data_class_config(text)') is null then
    raise exception 'apply 20260830180000_mi1_retention_engine before classifying member_messages'
      using errcode = '42883';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Tombstone columns and the redacted-body constraint.
-- ---------------------------------------------------------------------------

alter table public.member_messages
  add column redacted_at timestamptz,
  add column redacted_by uuid references auth.users(id) on delete set null,
  add column redaction_reason text
    check (redaction_reason in ('sender_removed', 'staff_removed', 'retention_expired', 'account_closed')),
  add column body_sha256 text check (body_sha256 ~ '^[0-9a-f]{64}$'),
  add column original_length integer check (original_length between 1 and 4000);

-- A redacted row carries an empty body and its full tombstone; a live row
-- carries a bounded body and no tombstone at all. There is no third state, so
-- `body = ''` is unambiguous evidence of redaction for every reader.
alter table public.member_messages
  drop constraint member_messages_body_check;
alter table public.member_messages
  add constraint member_messages_body_lifecycle check (
    (redacted_at is null
      and redaction_reason is null
      and body_sha256 is null
      and original_length is null
      and pg_catalog.char_length(body) between 1 and 4000)
    or (redacted_at is not null
      and redaction_reason is not null
      and body_sha256 is not null
      and original_length is not null
      and body = '')
  );

comment on column public.member_messages.redacted_at is
  'Set when the body was removed. A non-null value means body is the empty string and body_sha256/original_length are the only evidence of the removed text.';
comment on column public.member_messages.body_sha256 is
  'SHA-256 of the removed body. Retained so a disputed copy can be checked against the tombstone; never sufficient to recover the text.';

create index member_messages_retention_idx
  on public.member_messages (created_at, id)
  where redacted_at is null;

-- A scheduled message keeps a second durable copy of the body until dispatch,
-- and keeps it afterwards next to sent_message_id. Redacting the delivered
-- message without this copy would leave the text sitting in a table the sender
-- can still select.
alter table public.member_scheduled_messages
  add column redacted_at timestamptz;
alter table public.member_scheduled_messages
  drop constraint member_scheduled_messages_body_check;
alter table public.member_scheduled_messages
  add constraint member_scheduled_messages_body_lifecycle check (
    (redacted_at is null and pg_catalog.char_length(pg_catalog.btrim(body)) between 1 and 4000)
    or (redacted_at is not null and body = '')
  );

-- Mirrors member_messages_retention_idx for the undelivered-draft sweep.
create index member_scheduled_messages_retention_idx
  on public.member_scheduled_messages (created_at, id)
  where redacted_at is null and sent_message_id is null;

comment on column public.member_scheduled_messages.redacted_at is
  'Set when this copy of the body was destroyed: by private.redact_member_message_row when the delivered member_messages row was redacted, or by private.redact_member_scheduled_message_row when an undelivered draft (pending, cancelled, failed, orphaned) passed the retention window. Both paths are refused under a preservation order.';

-- ---------------------------------------------------------------------------
-- 2. Legal hold.
-- ---------------------------------------------------------------------------

create table public.member_message_legal_holds (
  conversation_id uuid primary key
    references public.member_conversations(id) on delete cascade,
  organization_id uuid not null
    references public.organizations(id) on update cascade on delete restrict,
  reason_code text not null check (reason_code in (
    'litigation', 'arbitration', 'agency_charge', 'internal_investigation'
  )),
  placed_by uuid references auth.users(id) on delete set null,
  placed_at timestamptz not null default pg_catalog.now(),
  released_by uuid references auth.users(id) on delete set null,
  released_at timestamptz,
  constraint member_message_legal_holds_release_order check (
    released_at is null or released_at >= placed_at
  )
);

comment on table public.member_message_legal_holds is
  'Conversation-scoped preservation orders. An active hold refuses every redaction path — member, staff and retention. Holds carry a reason code only; they never carry message content.';

alter table public.member_message_legal_holds enable row level security;

create policy member_message_legal_holds_admin_select
  on public.member_message_legal_holds for select to authenticated
  using (
    organization_id = (select private.current_member_organization())
    and public.member_has_role(array['admin'])
  );

create policy mfa_assurance on public.member_message_legal_holds
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

comment on policy member_message_legal_holds_admin_select on public.member_message_legal_holds is
  'Organization administrators may read preservation orders only inside their active organization; message bodies are never exposed by this table.';
comment on policy mfa_assurance on public.member_message_legal_holds is
  'Authenticated callers must satisfy the shared MFA assurance predicate for every preservation-order operation, including administrator reads.';

revoke all on table public.member_message_legal_holds
  from public, anon, authenticated, service_role;
grant select on table public.member_message_legal_holds to authenticated;

alter table public.organization_audit_ledger
  drop constraint if exists organization_audit_ledger_entity_type_check,
  add constraint organization_audit_ledger_entity_type_check check (entity_type in (
    'organization', 'chapter', 'membership', 'role_grant', 'member', 'case',
    'message', 'event', 'campaign', 'broadcast', 'invitation', 'export',
    'document', 'reward', 'job_run', 'security_policy', 'audit_event',
    'automation_definition', 'automation_run',
    'retention_policy', 'retention_run', 'message_legal_hold'
  ));

alter table public.organization_audit_ledger
  drop constraint if exists organization_audit_ledger_metadata_keys,
  add constraint organization_audit_ledger_metadata_keys check (
    metadata - array[
      'organizationId', 'chapterId', 'slug', 'name', 'role', 'userId', 'status',
      'requireStaffMfa', 'entityType', 'entityId', 'fromStatus', 'toStatus',
      'fromRole', 'toRole', 'action', 'eventType', 'domain', 'jobName', 'runId',
      'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode',
      'exportType', 'cadence', 'dataClass', 'retentionDays', 'eligibleCount',
      'deletedCount', 'remainingCount', 'mode', 'executionEnabled', 'operation'
    ] = '{}'::jsonb
  );

create function private.member_message_under_legal_hold(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.member_message_legal_holds h
    where h.conversation_id = p_conversation_id and h.released_at is null
  );
$function$;

comment on function private.member_message_under_legal_hold(uuid) is
  'True while an unreleased preservation order covers the conversation. Consulted by every redaction path, including the retention worker.';

revoke all on function private.member_message_under_legal_hold(uuid)
  from public, anon, authenticated, service_role;

create function private.lock_message_lifecycle()
returns void language plpgsql volatile security definer set search_path = ''
as $function$
begin
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'message preservation requires read committed isolation' using errcode = '40001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message-lifecycle-global', 0));
end;
$function$;
revoke all on function private.lock_message_lifecycle() from public, anon, authenticated, service_role;

create function private.lock_message_lifecycle_statement()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_message_lifecycle();
  return null;
end;
$function$;
revoke all on function private.lock_message_lifecycle_statement() from public, anon, authenticated, service_role;

create trigger message_lifecycle_statement before delete on auth.users
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.member_message_legal_holds
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.member_messages
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.member_scheduled_messages
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.member_conversations
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_thread_posts
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before insert or update or delete on public.chapter_task_messages
for each statement execute function private.lock_message_lifecycle_statement();

-- Parent cascades into channel/task sources must enter before locking the
-- parent, including the task-purge cron's direct DELETE. Identity renames can
-- cascade UPDATEs too. Retention's explicit task selection is already gated.
create trigger message_lifecycle_statement before delete or update of id on public.chapter_tasks
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before delete or update of id on public.chapter_threads
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before delete or update of id on public.chapter_spaces
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before delete or update of id on public.chapters
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before delete or update of id on public.organizations
for each statement execute function private.lock_message_lifecycle_statement();

-- Shared transaction lock, acquired BEFORE any message/draft row lock. Advisory
-- identity survives parent deletion and also serializes direct hold-table writes.
create function private.lock_member_message_conversation(p_conversation_id uuid)
returns void language plpgsql volatile security definer set search_path = ''
as $function$
begin
  perform private.lock_message_lifecycle();
  -- A fixed transaction snapshot cannot observe a hold committed while waiting.
  -- Fail closed instead of allowing a non-default SQL caller to bypass the
  -- fresh-snapshot recheck used by PostgREST and the retention scheduler.
  if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'message preservation requires read committed isolation' using errcode = '40001';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('message-preservation:' || p_conversation_id::text, 0));
end;
$function$;
revoke all on function private.lock_member_message_conversation(uuid)
  from public, anon, authenticated, service_role;

create function private.lock_member_message_hold()
returns trigger language plpgsql security definer set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and new.conversation_id is distinct from old.conversation_id then
    raise exception 'preservation identity is immutable' using errcode = '42501';
  end if;
  perform private.lock_member_message_conversation(
    case when tg_op = 'DELETE' then old.conversation_id else new.conversation_id end);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function private.lock_member_message_hold()
  from public, anon, authenticated, service_role;
create trigger member_message_holds_lock before insert or update or delete
on public.member_message_legal_holds for each row execute function private.lock_member_message_hold();

create function public.place_member_message_legal_hold(
  p_conversation_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := (select private.current_member_organization());
  conversation_org uuid;
begin
  if caller is null or org is null or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'authorization required' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code not in (
    'litigation', 'arbitration', 'agency_charge', 'internal_investigation'
  ) then
    raise exception 'unsupported legal hold reason' using errcode = '22023';
  end if;

  perform private.lock_member_message_conversation(p_conversation_id);

  -- The conversation must belong to the administrator's own tenant. Resolving
  -- through member_profiles keeps the check on the same path the rest of the
  -- organization scope uses instead of trusting a client-supplied tenant.
  select coalesce(c.organization_id, h.organization_id) into conversation_org
  from public.member_conversations v
  left join public.member_profiles p on p.id = v.user_id
  left join public.chapters c on c.id = p.chapter_id
  left join public.member_message_legal_holds h on h.conversation_id = v.id
  where v.id = p_conversation_id;
  if conversation_org is null or conversation_org is distinct from org then
    raise exception 'authorization required' using errcode = '42501';
  end if;

  insert into public.member_message_legal_holds (
    conversation_id, organization_id, reason_code, placed_by
  ) values (p_conversation_id, org, p_reason_code, caller)
  on conflict (conversation_id) do update
    set organization_id = excluded.organization_id,
        reason_code = excluded.reason_code,
        placed_by = excluded.placed_by,
        placed_at = pg_catalog.now(),
        released_by = null,
        released_at = null
    where public.member_message_legal_holds.released_at is not null;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'message.legal_hold_placed', 'settings_change', caller,
    'message_legal_hold', p_conversation_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('reasonCode', p_reason_code, 'operation', 'hold')
  );

  return pg_catalog.jsonb_build_object('held', true, 'reasonCode', p_reason_code);
end;
$function$;

create function public.release_member_message_legal_hold(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := (select private.current_member_organization());
  released integer := 0;
begin
  if caller is null or org is null or not private.mfa_satisfied()
     or not public.member_has_role(array['admin']) then
    raise exception 'authorization required' using errcode = '42501';
  end if;

  perform private.lock_member_message_conversation(p_conversation_id);

  update public.member_message_legal_holds h
    set released_at = pg_catalog.now(), released_by = caller
    where h.conversation_id = p_conversation_id
      and h.organization_id = org
      and h.released_at is null;
  get diagnostics released = row_count;
  if released = 0 then
    return pg_catalog.jsonb_build_object('released', false);
  end if;

  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'privacy', 'message.legal_hold_released', 'settings_change', caller,
    'message_legal_hold', p_conversation_id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('operation', 'release')
  );

  return pg_catalog.jsonb_build_object('released', true);
end;
$function$;

revoke all on function public.place_member_message_legal_hold(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.release_member_message_legal_hold(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.place_member_message_legal_hold(uuid, text) to authenticated;
grant execute on function public.release_member_message_legal_hold(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The single redaction worker, and the caller-authorized RPC over it.
-- ---------------------------------------------------------------------------

create function private.redact_member_message_row(
  p_message_id uuid,
  p_reason text,
  p_actor uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  message_row public.member_messages%rowtype;
begin
  if p_reason not in ('sender_removed', 'staff_removed', 'retention_expired', 'account_closed') then
    raise exception 'unsupported redaction reason' using errcode = '22023';
  end if;

  perform private.lock_member_message_conversation(m.conversation_id)
  from public.member_messages m where m.id = p_message_id;
  select m.* into message_row
  from public.member_messages m
  where m.id = p_message_id
  for update;
  if message_row.id is null then
    return false;
  end if;
  if message_row.redacted_at is not null then
    return false;
  end if;
  if private.member_message_under_legal_hold(message_row.conversation_id) then
    raise exception 'conversation is under a preservation order' using errcode = '42501';
  end if;

  update public.member_messages m
    set body = '',
        body_sha256 = pg_catalog.encode(
          extensions.digest(message_row.body, 'sha256'), 'hex'),
        original_length = pg_catalog.char_length(message_row.body),
        redacted_at = pg_catalog.now(),
        redacted_by = p_actor,
        redaction_reason = p_reason
    where m.id = message_row.id;

  -- Sweep the dispatched copy; section 6 invalidates persisted briefings.
  update public.member_scheduled_messages s
    set body = '', redacted_at = pg_catalog.now()
    where s.sent_message_id = message_row.id and s.redacted_at is null;

  return true;
end;
$function$;

comment on function private.redact_member_message_row(uuid, text, uuid) is
  'The one place a member_messages body is destroyed. Every caller — member, staff, retention worker, account lifecycle — goes through here so the legal-hold refusal and the sweep of the dispatched scheduled copy cannot be bypassed.';

revoke all on function private.redact_member_message_row(uuid, text, uuid)
  from public, anon, authenticated, service_role;

-- The sibling path, for the copy that has no delivered message behind it.
-- private.redact_member_message_row sweeps member_scheduled_messages only where
-- sent_message_id points at the row it just redacted, so a draft that was never
-- dispatched — pending, cancelled, failed, or orphaned by a delivered message
-- that has since been deleted — would otherwise keep its plaintext body forever,
-- past any retention window. This is the path that destroys it.
--
-- No tombstone columns here, deliberately. A never-delivered draft was never
-- received by anyone, so there is no counterparty copy for a body_sha256 to
-- adjudicate; redacted_at plus the body_lifecycle check constraint is the whole
-- record. The preservation order still wins: an undelivered draft in a conversation
-- under legal hold is evidence of what was about to be said.
create function private.redact_member_scheduled_message_row(p_scheduled_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  scheduled_row public.member_scheduled_messages%rowtype;
begin
  perform private.lock_member_message_conversation(s.conversation_id)
  from public.member_scheduled_messages s where s.id = p_scheduled_id;
  select s.* into scheduled_row
  from public.member_scheduled_messages s
  where s.id = p_scheduled_id
  for update;
  if scheduled_row.id is null then
    return false;
  end if;
  if scheduled_row.redacted_at is not null then
    return false;
  end if;
  -- A dispatched draft is the delivered message's second copy and is governed by
  -- that message's redaction, so the two paths can never both destroy one body.
  if scheduled_row.sent_message_id is not null then
    return false;
  end if;
  if private.member_message_under_legal_hold(scheduled_row.conversation_id) then
    raise exception 'conversation is under a preservation order' using errcode = '42501';
  end if;

  update public.member_scheduled_messages s
    set body = '', redacted_at = pg_catalog.now()
    where s.id = scheduled_row.id;

  return true;
end;
$function$;

comment on function private.redact_member_scheduled_message_row(uuid) is
  'SEC-UG-MESSAGE-BODY-LIFECYCLE: destroys the body of a scheduled message that was never delivered (pending, cancelled, failed, or orphaned). Refuses under a preservation order and refuses a dispatched draft, which private.redact_member_message_row owns.';

revoke all on function private.redact_member_scheduled_message_row(uuid)
  from public, anon, authenticated, service_role;

create function public.redact_member_message(p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  message_row public.member_messages%rowtype;
  org uuid;
  reason text;
  removed boolean;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select m.* into message_row
  from public.member_messages m
  where m.id = p_message_id;
  if message_row.id is null then
    -- Flat denial: an unauthorized caller must not learn that an id exists.
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if message_row.user_id = caller and message_row.sender_kind = 'member' then
    -- The member removes content the member wrote. A steward's reply in the
    -- member's own conversation is the steward's content and takes the staff
    -- path below.
    reason := 'sender_removed';
  elsif public.member_has_role(array['steward', 'coordinator', 'admin'])
        and exists (
          select 1
          from public.member_profiles author
          join public.chapters c on c.id = author.chapter_id
          where author.id = message_row.user_id
            and c.id = private.current_member_chapter()
        ) then
    reason := 'staff_removed';
  else
    raise exception 'not permitted' using errcode = '42501';
  end if;

  removed := private.redact_member_message_row(message_row.id, reason, caller);
  if not removed then
    return pg_catalog.jsonb_build_object('redacted', false, 'alreadyRedacted', true,
      'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
  end if;

  org := (select private.current_member_organization());
  if org is not null then
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'privacy', 'message.redacted', 'delete', caller,
      'message', message_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('reasonCode', reason, 'operation', 'redact', 'count', 1)
    );
  end if;

  return pg_catalog.jsonb_build_object('redacted', true, 'reasonCode', reason,
    'message', (select pg_catalog.jsonb_build_object('id', m.id, 'body', '', 'redacted_at', m.redacted_at, 'redaction_reason', m.redaction_reason) from public.member_messages m where m.id = message_row.id));
end;
$function$;

revoke all on function public.redact_member_message(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.redact_member_message(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The message-body disposition contract for the two messaging tables.
-- ---------------------------------------------------------------------------
-- DECISION (taken 2026-09-06 after reading the pushed
-- codex/wave2-account-lifecycle-20260906): this stays a SEPARATE, messaging-
-- scoped function and is deliberately NOT a second account-lifecycle manifest.
--
-- BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION owns private.account_lifecycle_manifest,
-- a TABLE whose columns record one thing: what an auth.users foreign key does on
-- account deletion and whether the table is exported. It already carries
-- public.member_messages.user_id and public.member_scheduled_messages.actor_id/
-- recipient_id for exactly that purpose, and this migration does not restate it:
-- nothing here registers a deletion disposition or an export disposition.
--
-- What this function records is the part that manifest's column set cannot
-- express and that is meaningless outside messaging: which function destroys a
-- body, which retention data class governs it, and which table can suspend the
-- destruction. Folding these three facts into the account-lifecycle table would
-- mean adding three messaging-only columns to a schema-wide contract, and making
-- this migration depend on a table it does not own — a hard apply-order
-- dependency in whichever direction the two branches merge second.
--
-- The invariant that keeps the two from drifting into duplication is asserted in
-- tests/message-body-lifecycle-migration.test.js: exactly two tables, both
-- messaging, and no deletion or export disposition of its own.
create function private.member_message_body_disposition()
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  -- No 'onAccountDeletion', 'cascadeVia', or export disposition: those belong to
  -- private.account_lifecycle_manifest and are recorded there, once.
  select pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'table', 'public.member_messages',
      'domain', 'messaging',
      'accountClosureReason', 'account_closed',
      'redactionFunction', 'private.redact_member_message_row',
      'retentionDataClass', 'member_message_bodies',
      'legalHoldTable', 'public.member_message_legal_holds'
    ),
    pg_catalog.jsonb_build_object(
      'table', 'public.member_scheduled_messages',
      'domain', 'messaging',
      'accountClosureReason', 'account_closed',
      'redactionFunction', 'private.redact_member_scheduled_message_row',
      'retentionDataClass', 'member_message_bodies',
      'legalHoldTable', 'public.member_message_legal_holds'
    )
  );
$function$;

comment on function private.member_message_body_disposition() is
  'SEC-UG-MESSAGE-BODY-LIFECYCLE: how a message body is destroyed, retained and preserved, for the two messaging tables only. Deliberately not an account-lifecycle manifest: private.account_lifecycle_manifest (BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION) owns deletion and export dispositions and already carries both tables. This must never grow a deletion or export disposition, nor a third table.';

revoke all on function private.member_message_body_disposition()
  from public, anon, authenticated, service_role;

-- Account closure owns the BEFORE DELETE boundary, before any FK cascade.
-- Keep the cascading FK inventory B05 classifies; only held rows detach first.
-- No synthetic account is created and no message text is copied.
alter table public.member_conversations alter column user_id drop not null;
alter table public.member_messages alter column user_id drop not null;
alter table public.compass_message_briefings alter column requested_by drop not null;
alter table public.compass_workspace_actions alter column actor_user_id drop not null;
alter table public.member_scheduled_messages
  alter column actor_id drop not null, alter column recipient_id drop not null;

create function private.preserve_member_messages_on_account_delete()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare conversation uuid; message uuid; draft uuid;
begin
  for conversation in
    select v.id from public.member_conversations v where v.user_id = old.id
    union select m.conversation_id from public.member_messages m where m.user_id = old.id
    union select s.conversation_id from public.member_scheduled_messages s
      where s.actor_id = old.id or s.recipient_id = old.id
    union select b.target_id from public.compass_message_briefings b
      where b.requested_by = old.id and b.source_kind = 'private'
    union select m.conversation_id from public.compass_workspace_actions a
      join public.member_messages m on m.id::text = a.source_id
      where a.actor_user_id = old.id and a.source_kind = 'message'
    order by 1
  loop
    perform private.lock_member_message_conversation(conversation);
    if private.member_message_under_legal_hold(conversation) then
      -- Requester/actor may own no source row. Detach their identity only;
      -- preserve summary, action_items, title and source binding in place.
      update public.compass_message_briefings set requested_by = null
        where source_kind = 'private' and target_id = conversation and requested_by = old.id;
      update public.compass_workspace_actions set actor_user_id = null
        where source_kind = 'message' and actor_user_id = old.id and source_id in
          (select m.id::text from public.member_messages m where m.conversation_id = conversation);
      update public.member_conversations set user_id = null, title = 'Preserved conversation', initials = ''
        where id = conversation and user_id = old.id;
      update public.member_messages set user_id = null,
        sender_name = case when sender_kind = 'member' then 'Deleted account' else sender_name end
        where conversation_id = conversation and user_id = old.id;
      update public.member_scheduled_messages
        set actor_id = case when actor_id = old.id then null else actor_id end,
            recipient_id = case when recipient_id = old.id then null else recipient_id end,
            status = case when status = 'pending' then 'cancelled' else status end
        where conversation_id = conversation and (actor_id = old.id or recipient_id = old.id);
    else
      for message in select m.id from public.member_messages m where m.conversation_id = conversation
        and (m.user_id = old.id or m.id in (select s.sent_message_id from public.member_scheduled_messages s
          where s.actor_id = old.id or s.recipient_id = old.id)) order by m.id loop
        perform private.redact_member_message_row(message, 'account_closed', null);
      end loop;
      for draft in select s.id from public.member_scheduled_messages s
        where s.conversation_id = conversation and s.sent_message_id is null
          and (s.actor_id = old.id or s.recipient_id = old.id) order by s.id loop
        perform private.redact_member_scheduled_message_row(draft);
      end loop;
      -- Remove the already-redacted copies while the auth parent still exists.
      -- Their sent-state CHECK cannot tolerate an intermediate SET NULL from
      -- deleting the delivered message first in the later FK cascade.
      delete from public.member_scheduled_messages s where s.conversation_id = conversation
        and (s.actor_id = old.id or s.recipient_id = old.id);
    end if;
  end loop;
  return old;
end;
$function$;
revoke all on function private.preserve_member_messages_on_account_delete()
  from public, anon, authenticated, service_role;
create trigger preserve_member_messages_before_account_delete before delete on auth.users
for each row execute function private.preserve_member_messages_on_account_delete();

-- Defence at our own tables' deletion path too: a future cascade or definer
-- must not bypass preservation by deleting a conversation or body directly.
create function private.guard_member_message_destruction()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare conversation uuid; candidate uuid;
begin
  if tg_table_name = 'member_conversations' then conversation := old.id;
  else conversation := old.conversation_id; end if;
  perform private.lock_member_message_conversation(conversation);
  if private.member_message_under_legal_hold(conversation) then
    raise exception 'conversation is under a preservation order' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    if tg_table_name = 'member_conversations' then
      for candidate in select m.id from public.member_messages m where m.conversation_id = old.id order by m.id loop
        perform private.redact_member_message_row(candidate, 'account_closed', null);
      end loop;
      for candidate in select s.id from public.member_scheduled_messages s
        where s.conversation_id = old.id and s.sent_message_id is null order by s.id loop
        perform private.redact_member_scheduled_message_row(candidate);
      end loop;
    elsif tg_table_name = 'member_messages' then
      if old.redacted_at is null then
        raise exception 'redaction required before deletion' using errcode = '42501';
      end if;
      -- Permit the sent_message_id SET NULL referential action: a deleted
      -- delivered row no longer satisfies the scheduled sent-state constraint.
      update public.member_scheduled_messages set status = 'cancelled', dispatched_at = null
        where sent_message_id = old.id;
    elsif tg_table_name = 'member_scheduled_messages' then
      if old.redacted_at is null then
        raise exception 'redaction required before deletion' using errcode = '42501';
      end if;
    end if;
    return old;
  end if;
  return new;
end;
$function$;
revoke all on function private.guard_member_message_destruction()
  from public, anon, authenticated, service_role;
create trigger member_conversations_guard_delete before delete on public.member_conversations
for each row execute function private.guard_member_message_destruction();
create trigger member_messages_guard_delete before delete on public.member_messages
for each row execute function private.guard_member_message_destruction();
create trigger member_scheduled_messages_guard_delete before delete on public.member_scheduled_messages
for each row execute function private.guard_member_message_destruction();
create trigger member_messages_guard_body before update of body on public.member_messages
for each row when (old.body is distinct from new.body) execute function private.guard_member_message_destruction();
create trigger member_scheduled_messages_guard_body before update of body on public.member_scheduled_messages
for each row when (old.body is distinct from new.body) execute function private.guard_member_message_destruction();

-- ---------------------------------------------------------------------------
-- 5. Classify member_messages in the MI1 retention engine.
-- ---------------------------------------------------------------------------

alter table public.organization_retention_policies
  drop constraint organization_retention_policies_data_class_check,
  add constraint organization_retention_policies_data_class_check check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks',
    'member_message_bodies'
  ));

alter table public.organization_retention_runs
  drop constraint organization_retention_runs_data_class_check,
  add constraint organization_retention_runs_data_class_check check (data_class in (
    'organization_page_views',
    'organization_engagement_events',
    'integration_job_history',
    'public_event_rsvps',
    'deleted_chapter_tasks',
    'member_message_bodies'
  ));

create or replace function private.retention_data_class_config(p_data_class text)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case p_data_class
    when 'organization_page_views' then pg_catalog.jsonb_build_object(
      'label', 'Organization page views', 'minimumDays', 30, 'maximumDays', 3650, 'defaultDays', 180,
      'operation', 'delete',
      'description', 'Aggregated daily path and hat counts; no page-view identity rows.'
    )
    when 'organization_engagement_events' then pg_catalog.jsonb_build_object(
      'label', 'Engagement events', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'operation', 'delete',
      'description', 'Organization analytics events after their reporting window.'
    )
    when 'integration_job_history' then pg_catalog.jsonb_build_object(
      'label', 'Integration job history', 'minimumDays', 90, 'maximumDays', 3650, 'defaultDays', 365,
      'operation', 'delete',
      'description', 'Terminal provider-operation envelopes; active or queued jobs are never eligible.'
    )
    when 'public_event_rsvps' then pg_catalog.jsonb_build_object(
      'label', 'Public event RSVPs', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'operation', 'delete',
      'description', 'Submitted public RSVP names and email addresses after the published 90-day window.'
    )
    when 'deleted_chapter_tasks' then pg_catalog.jsonb_build_object(
      'label', 'Deleted chapter tasks', 'minimumDays', 90, 'maximumDays', 90, 'defaultDays', 90,
      'operation', 'delete',
      'description', 'Soft-deleted tasks and their cascading task-thread records after the recovery window.'
    )
    when 'member_message_bodies' then pg_catalog.jsonb_build_object(
      'label', 'Direct message bodies', 'minimumDays', 365, 'maximumDays', 2555, 'defaultDays', 1095,
      'operation', 'redact',
      'description', 'Direct conversation text older than the window is destroyed in place; the message, its timestamps and a digest survive as a tombstone. Conversations under a preservation order are never eligible.'
    )
    else null
  end;
$function$;

create or replace function private.retention_eligible_count(
  p_organization_id uuid,
  p_data_class text,
  p_retention_days integer
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  eligible bigint;
begin
  if private.retention_data_class_config(p_data_class) is null then
    raise exception 'unsupported retention data class' using errcode = '22023';
  end if;

  case p_data_class
    when 'organization_page_views' then
      select pg_catalog.count(*) into eligible
      from public.organization_page_views v
      where v.organization_id = p_organization_id
        and v.day < current_date - p_retention_days;
    when 'organization_engagement_events' then
      select pg_catalog.count(*) into eligible
      from public.organization_engagement_events e
      where e.organization_id = p_organization_id
        and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'integration_job_history' then
      select pg_catalog.count(*) into eligible
      from public.integration_jobs j
      where j.organization_id = p_organization_id
        and j.status in ('success', 'failed', 'skipped', 'dead')
        and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'public_event_rsvps' then
      select pg_catalog.count(*) into eligible
      from public.public_event_rsvps r
      where r.organization_id = p_organization_id
        and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'deleted_chapter_tasks' then
      select pg_catalog.count(*) into eligible
      from public.chapter_tasks t
      join public.chapters c on c.id = t.chapter_id
      where c.organization_id = p_organization_id
        and t.deleted_at is not null
        and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
    when 'member_message_bodies' then
      -- Both durable copies of a body are in scope, or the count would promise a
      -- sweep the worker does not perform: delivered messages, plus scheduled
      -- messages that were never dispatched and therefore have no delivered row
      -- to be redacted with.
      select
        (select pg_catalog.count(*)
         from public.member_messages m
         left join public.member_profiles p on p.id = m.user_id
         left join public.chapters c on c.id = p.chapter_id
         left join public.member_message_legal_holds h on h.conversation_id = m.conversation_id
         where coalesce(c.organization_id, h.organization_id) = p_organization_id
           and m.redacted_at is null
           and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days)
           and not private.member_message_under_legal_hold(m.conversation_id))
        + (select pg_catalog.count(*)
           from public.member_scheduled_messages s
           left join public.member_profiles p on p.id = s.actor_id
           left join public.chapters c on c.id = p.chapter_id
           left join public.member_message_legal_holds h on h.conversation_id = s.conversation_id
           where coalesce(c.organization_id, h.organization_id) = p_organization_id
             and s.redacted_at is null
             and s.sent_message_id is null
             and s.created_at < pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days)
             and not private.member_message_under_legal_hold(s.conversation_id))
      into eligible;
  end case;

  if eligible > 2147483647 then
    return 2147483647;
  end if;
  return eligible::integer;
end;
$function$;

-- The bounded worker gains one redacting branch. Every other branch is
-- unchanged from 20260830180000; the class catalogue's 'operation' field is
-- what distinguishes a class that deletes rows from a class that destroys
-- content in place and leaves the row behind.
create or replace function private.perform_organization_retention_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run_row public.organization_retention_runs%rowtype;
  policy_row public.organization_retention_policies%rowtype;
  removed integer := 0;
  remaining integer := 0;
  candidate_id uuid;
begin
  perform private.lock_message_lifecycle();
  select r.* into run_row
  from public.organization_retention_runs r
  where r.id = p_run_id
  for update;
  if run_row.id is null or run_row.status <> 'authorized' then
    raise exception 'authorized retention run required' using errcode = '22023';
  end if;
  if run_row.authorization_expires_at <= pg_catalog.now() then
    update public.organization_retention_runs
      set status = 'expired', completed_at = pg_catalog.now(),
          failure_code = 'authorization_expired'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'expired');
  end if;

  select p.* into policy_row
  from public.organization_retention_policies p
  where p.organization_id = run_row.organization_id and p.data_class = run_row.data_class
  for key share;
  if policy_row.organization_id is null or not policy_row.execution_enabled then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_disabled'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'execution_disabled');
  end if;
  if policy_row.retention_days <> run_row.retention_days then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'policy_changed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'policy_changed');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(run_row.organization_id::text || ':' || run_row.data_class, 0)
  );
  update public.organization_retention_runs
    set status = 'running', started_at = pg_catalog.now()
    where id = run_row.id;

  begin
    case run_row.data_class
      when 'organization_page_views' then
        with candidates as (
          select v.ctid
          from public.organization_page_views v
          where v.organization_id = run_row.organization_id
            and v.day < current_date - run_row.retention_days
          order by v.day, v.path, v.hat
          limit 5000
          for update skip locked
        )
        delete from public.organization_page_views target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'organization_engagement_events' then
        with candidates as (
          select e.ctid
          from public.organization_engagement_events e
          where e.organization_id = run_row.organization_id
            and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by e.occurred_at, e.user_id, e.event_type, e.source_id
          limit 5000
          for update skip locked
        )
        delete from public.organization_engagement_events target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'integration_job_history' then
        with candidates as (
          select j.id
          from public.integration_jobs j
          where j.organization_id = run_row.organization_id
            and j.status in ('success', 'failed', 'skipped', 'dead')
            and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by j.updated_at, j.id
          limit 5000
          for update skip locked
        )
        delete from public.integration_jobs target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'public_event_rsvps' then
        with candidates as (
          select r.id
          from public.public_event_rsvps r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update skip locked
        )
        delete from public.public_event_rsvps target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'deleted_chapter_tasks' then
        with candidates as (
          select t.id
          from public.chapter_tasks t
          join public.chapters c on c.id = t.chapter_id
          where c.organization_id = run_row.organization_id
            and t.deleted_at is not null
            and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by t.deleted_at, t.id
          limit 5000
          for update of t skip locked
        )
        delete from public.chapter_tasks target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'member_message_bodies' then
        -- Row-at-a-time on purpose. private.redact_member_message_row is the
        -- only path allowed to destroy a body: it re-checks the preservation
        -- order under the row lock and sweeps the duplicate scheduled-message
        -- copy. A set-based UPDATE here would be faster and would leave that
        -- second plaintext copy behind. A hold placed mid-run raises and the
        -- handler below fails the run without redacting further — preservation
        -- wins over the retention window, deliberately.
        for candidate_id in
          select m.id
          from public.member_messages m
          left join public.member_profiles p on p.id = m.user_id
          left join public.chapters c on c.id = p.chapter_id
          left join public.member_message_legal_holds h on h.conversation_id = m.conversation_id
          where coalesce(c.organization_id, h.organization_id) = run_row.organization_id
            and m.redacted_at is null
            and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(m.conversation_id)
          order by m.created_at, m.id
          limit 5000
        loop
          if private.redact_member_message_row(candidate_id, 'retention_expired', run_row.authorized_by) then
            removed := removed + 1;
          end if;
        end loop;
        -- The second durable copy with no delivered row behind it. A draft that
        -- was never dispatched is not reachable from the loop above — nothing
        -- points at it — so without this it would keep its plaintext body past
        -- the window forever, which is exactly what the class promises to
        -- prevent. Same bound, same preservation-order refusal.
        for candidate_id in
          select s.id
          from public.member_scheduled_messages s
          left join public.member_profiles p on p.id = s.actor_id
          left join public.chapters c on c.id = p.chapter_id
          left join public.member_message_legal_holds h on h.conversation_id = s.conversation_id
          where coalesce(c.organization_id, h.organization_id) = run_row.organization_id
            and s.redacted_at is null
            and s.sent_message_id is null
            and s.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(s.conversation_id)
          order by s.created_at, s.id
          limit 5000
        loop
          if private.redact_member_scheduled_message_row(candidate_id) then
            removed := removed + 1;
          end if;
        end loop;
    end case;

    remaining := private.retention_eligible_count(
      run_row.organization_id, run_row.data_class, run_row.retention_days
    );
    update public.organization_retention_runs
      set status = 'completed', deleted_count = removed,
          remaining_count = remaining, completed_at = pg_catalog.now()
      where id = run_row.id;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      run_row.organization_id, 'privacy', 'retention.completed', 'delete', run_row.authorized_by,
      'retention_run', run_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'dataClass', run_row.data_class,
        'retentionDays', run_row.retention_days,
        'eligibleCount', run_row.eligible_count,
        'deletedCount', removed,
        'remainingCount', remaining,
        'mode', run_row.mode,
        'operation', private.retention_data_class_config(run_row.data_class) ->> 'operation'
      )
    );
  exception when others then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_failed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object(
      'id', run_row.id, 'status', 'failed', 'failureCode', 'execution_failed'
    );
  end;

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'dataClass', run_row.data_class,
    'status', 'completed',
    'deletedCount', removed,
    'remainingCount', remaining
  );
end;
$function$;

notify pgrst, 'reload schema';

-- The administrator settings surface consumes this catalogue.
create or replace function public.get_organization_retention_engine()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.current_member_organization();
  caller uuid;
  result jsonb;
begin
  caller := private.assert_retention_admin(org);

  with catalog(data_class) as (values
    ('organization_page_views'::text),
    ('organization_engagement_events'),
    ('integration_job_history'),
    ('public_event_rsvps'),
    ('deleted_chapter_tasks'),
    ('member_message_bodies')
  ), policy_rows as (
    select
      c.data_class,
      private.retention_data_class_config(c.data_class) as config,
      p.retention_days,
      p.execution_enabled,
      p.updated_at
    from catalog c
    left join public.organization_retention_policies p
      on p.organization_id = org
     and p.data_class = c.data_class
  )
  select pg_catalog.jsonb_build_object(
    'organizationId', org,
    'schedulerConfigured', private.retention_scheduler_configured(),
    'policies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'dataClass', p.data_class,
        'label', p.config ->> 'label',
        'description', p.config ->> 'description',
        'minimumDays', (p.config ->> 'minimumDays')::integer,
        'maximumDays', (p.config ->> 'maximumDays')::integer,
        'defaultDays', (p.config ->> 'defaultDays')::integer,
        'retentionDays', coalesce(p.retention_days, (p.config ->> 'defaultDays')::integer),
        'configured', p.retention_days is not null,
        'executionEnabled', coalesce(p.execution_enabled, false),
        'updatedAt', p.updated_at
      ) order by p.data_class)
      from policy_rows p
    ), '[]'::jsonb),
    'runs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id,
        'dataClass', r.data_class,
        'retentionDays', r.retention_days,
        'mode', r.mode,
        'status', r.status,
        'eligibleCount', r.eligible_count,
        'deletedCount', r.deleted_count,
        'remainingCount', r.remaining_count,
        'requestedBy', r.requested_by,
        'authorizedBy', r.authorized_by,
        'authorizationExpiresAt', r.authorization_expires_at,
        'createdAt', r.created_at,
        'completedAt', r.completed_at,
        'failureCode', r.failure_code,
        'confirmationPhrase', case when r.status = 'previewed'
          then 'AUTHORIZE ' || r.data_class else null end
      ) order by r.created_at desc, r.id desc)
      from (
        select history.*
        from public.organization_retention_runs history
        where history.organization_id = org
        order by history.created_at desc, history.id desc
        limit 25
      ) r
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

-- 6. Persisted derived content shares the source lifecycle. No summary or action
-- item text is copied into an audit or revision store.
create function private.invalidate_message_briefings()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare kind text; target uuid;
begin
  if tg_op = 'UPDATE' and old.body is not distinct from new.body then return new; end if;
  if tg_table_name = 'member_messages' then kind := 'private'; target := old.conversation_id;
  elsif tg_table_name = 'chapter_thread_posts' then kind := 'channel'; target := old.thread_id;
  else kind := 'task'; target := old.task_id; end if;
  delete from public.compass_message_briefings where source_kind = kind and target_id = target;
  if kind = 'private' then
    update public.compass_workspace_actions set title = 'Follow up on member message'
      where source_kind = 'message' and source_id in
        (select m.id::text from public.member_messages m where m.conversation_id = target
         union select old.id::text);
  end if;
  return null;
end;
$function$;
revoke all on function private.invalidate_message_briefings() from public, anon, authenticated, service_role;
create trigger invalidate_message_briefings after update of body or delete on public.member_messages
for each row execute function private.invalidate_message_briefings();
create trigger invalidate_message_briefings after update of body or delete on public.chapter_thread_posts
for each row execute function private.invalidate_message_briefings();
create trigger invalidate_message_briefings after update of body or delete on public.chapter_task_messages
for each row execute function private.invalidate_message_briefings();

-- Derivatives enforce preservation at their own mutation/delete boundary too.
-- Identity-only detachment and task-result referential maintenance remain legal.
create function private.guard_held_message_derivative()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare conversation uuid;
begin
  if tg_table_name = 'compass_message_briefings' then
    if old.source_kind = 'private' then conversation := old.target_id; end if;
    if tg_op = 'UPDATE' and
      (old.source_kind, old.target_id, old.organization_id, old.summary, old.action_items)
      is not distinct from
      (new.source_kind, new.target_id, new.organization_id, new.summary, new.action_items)
      then return new; end if;
  else
    if old.source_kind = 'message' then
      select m.conversation_id into conversation from public.member_messages m where m.id::text = old.source_id;
    end if;
    if tg_op = 'UPDATE' and
      (old.source_kind, old.source_id, old.organization_id, old.title)
      is not distinct from
      (new.source_kind, new.source_id, new.organization_id, new.title)
      then return new; end if;
  end if;
  if conversation is not null then
    perform private.lock_member_message_conversation(conversation);
    if private.member_message_under_legal_hold(conversation) then
      raise exception 'conversation is under a preservation order' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function private.guard_held_message_derivative() from public, anon, authenticated, service_role;
create trigger message_lifecycle_statement before delete or update of source_kind, target_id, organization_id, summary, action_items on public.compass_message_briefings
for each statement execute function private.lock_message_lifecycle_statement();
create trigger message_lifecycle_statement before delete or update of source_kind, source_id, organization_id, title on public.compass_workspace_actions
for each statement execute function private.lock_message_lifecycle_statement();
create trigger guard_held_message_derivative before delete or update on public.compass_message_briefings
for each row execute function private.guard_held_message_derivative();
create trigger guard_held_message_derivative before delete or update on public.compass_workspace_actions
for each row execute function private.guard_held_message_derivative();

-- Remove legacy derivatives already invalidated by source redaction, except
-- evidence covered by a current preservation order.
delete from public.compass_message_briefings b where b.source_kind = 'private'
  and not private.member_message_under_legal_hold(b.target_id)
  and exists (select 1 from public.member_messages m where m.conversation_id = b.target_id and m.redacted_at is not null);

create or replace function public.get_message_briefing_context(
  p_source_kind text,
  p_target_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  messages jsonb;
begin
  if p_source_kind = 'private' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.sender_kind, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select message.id, message.sender_kind, message.body, message.created_at
      from public.member_messages message
      where message.conversation_id = p_target_id
      order by message.created_at desc, message.id desc
      limit 40
    ) row;
  elsif p_source_kind = 'channel' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.author_id, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select post.id, post.author_id, post.body, post.created_at
      from public.chapter_thread_posts post
      where post.thread_id = p_target_id
      order by post.created_at desc, post.id desc
      limit 40
    ) row;
  elsif p_source_kind = 'task' then
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', row.id, 'actor', row.sender_id, 'body', row.body, 'createdAt', row.created_at
    ) order by row.created_at, row.id), '[]'::jsonb)
    into messages
    from (
      select message.id, message.sender_id, message.body, message.created_at
      from public.chapter_task_messages message
      where message.task_id = p_target_id
      order by message.created_at desc, message.id desc
      limit 40
    ) row;
  else
    raise exception 'invalid message briefing source' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(messages) = 0 then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  return pg_catalog.jsonb_build_object('sourceKind', p_source_kind, 'targetId', p_target_id, 'messages', messages,
    'sourceRevision', pg_catalog.encode(extensions.digest(messages::text, 'sha256'), 'hex'));
end;
$function$;

drop function public.persist_compass_message_briefing(text, uuid, text, jsonb);
create function public.persist_compass_message_briefing(
  p_source_kind text,
  p_target_id uuid,
  p_summary text,
  p_action_items jsonb,
  p_source_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  saved public.compass_message_briefings%rowtype;
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.engagement_can_read_message_target(p_source_kind, p_target_id) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 1 and 4000
     or pg_catalog.jsonb_typeof(p_action_items) <> 'array'
     or pg_catalog.jsonb_array_length(p_action_items) > 12 then
    raise exception 'invalid briefing result' using errcode = '22023';
  end if;
  perform private.lock_message_lifecycle();
  if p_source_revision is null or p_source_revision is distinct from
    (public.get_message_briefing_context(p_source_kind, p_target_id)->>'sourceRevision') then
    raise exception 'message source changed; request a new briefing' using errcode = '40001';
  end if;
  insert into public.compass_message_briefings (
    organization_id, requested_by, source_kind, target_id, summary, action_items
  ) values (
    org, actor, p_source_kind, p_target_id,
    pg_catalog.btrim(p_summary), p_action_items
  ) returning * into saved;
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'sourceKind', saved.source_kind,
    'targetId', saved.target_id, 'summary', saved.summary,
    'actionItems', saved.action_items, 'createdAt', saved.created_at
  );
end;
$function$;
revoke all on function public.persist_compass_message_briefing(text, uuid, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.persist_compass_message_briefing(text, uuid, text, jsonb, text) to authenticated;
notify pgrst, 'reload schema';

update public.compass_workspace_actions a set title = 'Follow up on member message'
where a.source_kind = 'message' and exists (
  select 1 from public.member_messages m where m.id::text = a.source_id
    and m.redacted_at is not null and not private.member_message_under_legal_hold(m.conversation_id)
);

-- Message-derived action titles carry no source text. Their linked task already
-- uses the same generic title and an authorized source link, never body copies.
create or replace function public.propose_compass_workspace_action(
  p_source_kind text,
  p_source_id text,
  p_title text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  created public.compass_workspace_actions%rowtype;
begin
  perform private.engagement_require_staff(org);
  if p_source_kind not in ('message', 'broadcast', 'notification', 'survey', 'case') then
    raise exception 'invalid action source' using errcode = '22023';
  end if;
  if p_source_kind = 'message' then
    perform private.lock_message_lifecycle();
    if not exists (select 1 from public.member_messages m
      where m.id::text = p_source_id and m.redacted_at is null
        and private.engagement_can_read_message_target('private', m.conversation_id)) then
      raise exception 'not found' using errcode = 'P0002';
    end if;
  end if;
  insert into public.compass_workspace_actions (
    organization_id, actor_user_id, action_kind, source_kind, source_id, title
  ) values (
    org, actor, 'create_task', p_source_kind,
    pg_catalog.btrim(coalesce(p_source_id, '')),
    case when p_source_kind = 'message' then 'Follow up on member message'
      else pg_catalog.btrim(coalesce(p_title, '')) end
  ) returning * into created;
  return pg_catalog.jsonb_build_object(
    'id', created.id, 'actionKind', created.action_kind,
    'sourceKind', created.source_kind, 'sourceId', created.source_id,
    'title', created.title, 'state', created.state
  );
end;
$function$;

-- Outermost entry: lifecycle gate before the first row lock.
create or replace function private.dispatch_due_member_messaging(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  job record;
  reminder record;
  sender_name text;
  new_message_id uuid;
  sent_count integer := 0;
  reminder_count integer := 0;
  failed_count integer := 0;
begin
  perform private.lock_message_lifecycle();
  if p_limit not between 1 and 500 then raise exception 'invalid dispatch limit' using errcode = '22023'; end if;

  for job in
    select scheduled.* from public.member_scheduled_messages scheduled
    where scheduled.status = 'pending' and scheduled.scheduled_for <= now()
    order by scheduled.scheduled_for, scheduled.id
    limit p_limit
    for update skip locked
  loop
    if not private.can_actor_send_private_message(job.actor_id, job.conversation_id, job.sender_kind)
       or not exists (select 1 from public.member_profiles recipient where recipient.id = job.recipient_id)
       or not exists (
         select 1 from public.member_conversations conversation
         where conversation.id = job.conversation_id and conversation.user_id = job.recipient_id
       ) then
      update public.member_scheduled_messages
      set status = 'failed', failure_reason = 'authorization-revoked',
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      failed_count := failed_count + 1;
      continue;
    end if;
    begin
      if job.sender_kind = 'member' then
        select coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Member') into sender_name
        from public.member_profiles profile where profile.id = job.actor_id;
      else
        sender_name := 'Chapter steward';
      end if;
      insert into public.member_messages(
        conversation_id, user_id, sender_kind, sender_name, body, scheduled_message_id)
      values (
        job.conversation_id, job.recipient_id, job.sender_kind, sender_name, job.body, job.id)
      on conflict (scheduled_message_id) do nothing
      returning id into new_message_id;
      if new_message_id is null then
        select id into new_message_id from public.member_messages where scheduled_message_id = job.id;
      end if;
      if job.sender_kind = 'member' then
        insert into public.member_action_log(user_id, action_key, action_kind)
        values (job.actor_id, 'message-' || new_message_id::text, 'message')
        on conflict (user_id, action_key) do nothing;
      end if;
      update public.member_conversations set updated_at = now() where id = job.conversation_id;
      update public.member_scheduled_messages
      set status = 'sent', sent_message_id = new_message_id, failure_reason = null,
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      sent_count := sent_count + 1;
    exception when others then
      update public.member_scheduled_messages
      set status = 'failed', failure_reason = 'dispatch-error',
          dispatched_at = now(), attempts = attempts + 1
      where id = job.id;
      failed_count := failed_count + 1;
    end;
  end loop;

  for reminder in
    select pending.* from public.member_message_reminders pending
    where pending.status = 'pending' and pending.remind_at <= now()
    order by pending.remind_at, pending.id
    limit p_limit
    for update skip locked
  loop
    if not private.can_read_message_source(reminder.owner_id, reminder.source_kind,
      reminder.private_message_id, reminder.channel_post_id, reminder.task_message_id) then
      update public.member_message_reminders
      set status = 'failed', delivered_at = now() where id = reminder.id;
      failed_count := failed_count + 1;
      continue;
    end if;
    insert into public.member_notifications(user_id, title, body, kind, message_reminder_id)
    values (reminder.owner_id, 'Message reminder', 'Open Messages to review your reminder.', 'general', reminder.id)
    on conflict (message_reminder_id) do nothing;
    update public.member_message_reminders
    set status = 'delivered', delivered_at = now() where id = reminder.id;
    reminder_count := reminder_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object(
    'sent', sent_count, 'reminders', reminder_count, 'failed', failed_count);
end;
$$;

-- Outermost entry: lifecycle gate before the first row lock.
create or replace function private.run_due_organization_retention_jobs(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  policy_row public.organization_retention_policies%rowtype;
  run_id uuid;
  processed integer := 0;
begin
  perform private.lock_message_lifecycle();
  for policy_row in
    select p.*
    from public.organization_retention_policies p
    where p.execution_enabled
      and not exists (
        select 1
        from public.organization_retention_runs r
        where r.organization_id = p.organization_id
          and r.data_class = p.data_class
          and r.mode = 'scheduled'
          and r.created_at >= pg_catalog.now() - interval '20 hours'
      )
    order by p.updated_at, p.organization_id, p.data_class
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    for update skip locked
  loop
    insert into public.organization_retention_runs (
      organization_id, data_class, retention_days, mode, status,
      eligible_count, requested_by, authorized_by, authorized_at,
      authorization_expires_at
    ) values (
      policy_row.organization_id, policy_row.data_class, policy_row.retention_days,
      'scheduled', 'authorized',
      private.retention_eligible_count(
        policy_row.organization_id, policy_row.data_class, policy_row.retention_days
      ),
      policy_row.updated_by, policy_row.updated_by, pg_catalog.now(),
      pg_catalog.now() + interval '30 minutes'
    ) returning id into run_id;
    perform private.perform_organization_retention_run(run_id);
    processed := processed + 1;
  end loop;

  return pg_catalog.jsonb_build_object('processed', processed, 'ranAt', pg_catalog.now());
end;
$function$;

-- Outermost entry: lifecycle gate before the first row lock.
create or replace function private.assert_retention_admin(p_organization_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare caller uuid := (select auth.uid());
begin
  perform private.lock_message_lifecycle();
  if caller is null
     or p_organization_id is null
     or p_organization_id is distinct from private.current_member_organization()
     or not private.mfa_satisfied()
     or not private.has_organization_role(p_organization_id, array['admin']) then
    raise exception 'organization admin with MFA required' using errcode = '42501';
  end if;

  perform 1
  from public.organization_role_grants g
  where g.organization_id = p_organization_id
    and g.user_id = caller
    and g.role = 'admin'
  for key share;
  if not found then
    raise exception 'organization admin role changed' using errcode = '42501';
  end if;
  return caller;
end;
$function$;

-- Outermost entry: lifecycle gate before the first row lock.
create or replace function public.decide_compass_workspace_action(
  p_action_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  action_row public.compass_workspace_actions%rowtype;
  task_result jsonb;
begin
  perform private.lock_message_lifecycle();
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  select * into action_row from public.compass_workspace_actions
  where id = p_action_id and organization_id = org and actor_user_id = actor
  for update;
  if not found or action_row.state <> 'proposed' then
    raise exception 'action is not pending' using errcode = '55000';
  end if;
  if p_decision = 'reject' then
    update public.compass_workspace_actions
    set state = 'rejected', decided_at = pg_catalog.now()
    where id = action_row.id;
    return pg_catalog.jsonb_build_object('id', action_row.id, 'state', 'rejected');
  end if;
  if p_decision <> 'confirm' then raise exception 'invalid action decision' using errcode = '22023'; end if;
  begin
    task_result := public.create_chapter_task_from_source(action_row.source_kind, action_row.source_id);
    update public.compass_workspace_actions
    set state = 'confirmed',
        result_task_id = nullif(task_result #>> '{task,id}', '')::uuid,
        decided_at = pg_catalog.now()
    where id = action_row.id;
  exception when others then
    update public.compass_workspace_actions
    set state = 'failed', decided_at = pg_catalog.now()
    where id = action_row.id;
    return pg_catalog.jsonb_build_object(
      'id', action_row.id, 'state', 'failed', 'taskId', null
    );
  end;
  return pg_catalog.jsonb_build_object(
    'id', action_row.id, 'state', 'confirmed',
    'taskId', task_result #>> '{task,id}', 'task', task_result -> 'task'
  );
end;
$function$;

-- Preserve B05's independently discoverable CASCADE inventory and reviewed
-- export projections. The conditional held-row detachment is an enforcement
-- note on those same entries, never a second manifest or an unconditional
-- SET NULL FK (unheld requester-owned derivatives still cascade).
do $manifest$
begin
  if pg_catalog.to_regclass('private.account_lifecycle_manifest') is not null then
    update private.account_lifecycle_manifest
      set note = coalesce(note, '') || ' B03: before auth deletion, held private-message briefing evidence detaches requested_by; unheld rows keep the reviewed cascading disposition and export projection.'
      where schema_name = 'public' and table_name = 'compass_message_briefings' and user_column = 'requested_by';
    update private.account_lifecycle_manifest
      set note = coalesce(note, '') || ' B03: before auth deletion, held message-linked action evidence detaches actor_user_id; unheld rows keep the reviewed cascading disposition and export exclusion.'
      where schema_name = 'public' and table_name = 'compass_workspace_actions' and user_column = 'actor_user_id';
  end if;
end;
$manifest$;

-- Detached conversations deny every unrelated sender. The outer block enters
-- the lifecycle gate before identity reads, authorization and parent row locks.
CREATE OR REPLACE FUNCTION public.send_member_message(p_conversation_id uuid, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_message_lifecycle();
declare
  caller     uuid := (select auth.uid());
  clean_body text := pg_catalog.btrim(coalesce(p_body, ''), ' ' || chr(9) || chr(10) || chr(13) || chr(12) || chr(11));
  conv       record;
  sender     text;
  new_id     uuid;
  akey       text;
  awarded    integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if pg_catalog.char_length(clean_body) not between 1 and 4000 then
    raise exception 'message must be between 1 and 4000 characters' using errcode = '22023';
  end if;

  select c.id, c.user_id into conv
  from public.member_conversations c
  where c.id = p_conversation_id
  for update;

  if not found or conv.user_id is distinct from caller then
    raise exception 'conversation not found' using errcode = '22023';
  end if;

  select p.full_name into sender from public.member_profiles p where p.id = caller;

  insert into public.member_messages (conversation_id, user_id, sender_kind, sender_name, body)
  values (
    p_conversation_id,
    caller,
    'member',
    coalesce(nullif(pg_catalog.btrim(coalesce(sender, '')), ''), 'Member'),
    clean_body)
  returning id into new_id;

  update public.member_conversations set updated_at = now() where id = p_conversation_id;

  akey := 'message-' || new_id::text;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, akey, 'message')
  on conflict (user_id, action_key) do nothing;

  select e.points into awarded
  from public.member_point_events e
  where e.user_id = caller and e.action_key = akey;

  return pg_catalog.jsonb_build_object('messageId', new_id, 'awardedPoints', coalesce(awarded, 0));
end;
end;
$function$
;

commit;
