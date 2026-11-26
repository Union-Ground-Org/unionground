-- REQ-UG-LEARNING-PERIOD-ENGINE-20261103 (#6940), slice 1 of 9 of
-- #6805 (REQ-UG-ORG-LEARNING-PERIOD-UNDO-20261102). Design:
-- the operator runbook Project decisions of
-- Nov 3, 2026 (, 7:54 AM and 10:51 AM ET): kept by default at the end;
-- the practice marker shows while the period runs and stays on items created
-- during it; already-sent deliveries are permanent; undo never touches the
-- audit trail; one organization-level period, no per-member period.
--
-- This migration is the engine's storage and period half:
--   private.organization_learning_periods  one period per organization, ever
--   private.learning_action_kinds          migration-owned action registry
--   private.learning_action_journal        undo working state, not the audit trail
--   public.start_organization_learning_period(integer)
--   public.end_organization_learning_period_early()
--   public.get_organization_learning_period()
--   private.learning_period_running(uuid)  clock_timestamp() based
--   private.learning_journal_append(...)   the write side every domain slice calls
--   private.learning_practice_flags(text, text[])
--   private.close_learning_period(uuid)    idempotent close step
-- The ledger's entity and metadata allowlists gain the learning entries by
-- check-constraint DDL; no existing row changes. Nothing here undoes,
-- deletes or rewrites any audit row, case version or delivery record.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Audit ledger vocabulary (append-only ledger; only the checks change)
-- ---------------------------------------------------------------------------
alter table public.organization_audit_ledger
  drop constraint organization_audit_ledger_entity_type_check;
alter table public.organization_audit_ledger
  add constraint organization_audit_ledger_entity_type_check check (entity_type in (
    'organization', 'chapter', 'membership', 'role_grant', 'member', 'case',
    'message', 'event', 'campaign', 'broadcast', 'invitation', 'export',
    'document', 'reward', 'job_run', 'security_policy', 'audit_event',
    'automation_definition', 'automation_run', 'retention_policy', 'retention_run',
    'message_legal_hold', 'automation_routing_rule',
    'learning_period', 'learning_action'
  ));
alter table public.organization_audit_ledger
  drop constraint organization_audit_ledger_metadata_keys,
  add constraint organization_audit_ledger_metadata_keys
    check ((metadata - array['organizationId', 'chapterId', 'slug', 'name', 'role', 'userId', 'status', 'requireStaffMfa', 'entityType', 'entityId', 'fromStatus', 'toStatus', 'fromRole', 'toRole', 'action', 'eventType', 'domain', 'jobName', 'runId', 'remediation', 'outcome', 'count', 'fieldsChanged', 'reasonCode', 'exportType', 'cadence', 'dataClass', 'retentionDays', 'eligibleCount', 'deletedCount', 'remainingCount', 'mode', 'executionEnabled', 'operation', 'reviewStatus', 'version', 'selfReview', 'payloadDigest', 'sourceId', 'sourceKind', 'deliveredCount', 'suppressedCount', 'periodId', 'lengthDays', 'entryId', 'actionKind', 'keptCount', 'undoneCount', 'imagesCleared']::text[]) = '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- 2. Storage
-- ---------------------------------------------------------------------------
create table private.organization_learning_periods (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  length_days smallint not null default 14,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  started_by uuid references auth.users(id) on delete set null,
  ended_early_at timestamptz,
  ended_early_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz,
  -- When the end job sent each notice, so a rerun never sends one twice.
  reminded_three_days_at timestamptz,
  reminded_one_day_at timestamptz,
  ended_notice_at timestamptz,
  constraint organization_learning_periods_one_per_organization unique (organization_id),
  constraint organization_learning_periods_id_organization unique (id, organization_id),
  constraint organization_learning_periods_length check (length_days in (7, 14)),
  -- Whole hours, not calendar days: the check is re-run on every update, and
  -- day arithmetic would depend on the session's time zone across a DST change.
  constraint organization_learning_periods_ends check (ends_at = starts_at + pg_catalog.make_interval(hours => length_days * 24)),
  constraint organization_learning_periods_ended_early check (
    ended_early_at is null or (ended_early_at >= starts_at and ended_early_at < ends_at)),
  constraint organization_learning_periods_ended_early_by check (ended_early_by is null or ended_early_at is not null),
  constraint organization_learning_periods_closed check (
    closed_at is null or closed_at >= coalesce(ended_early_at, ends_at))
);

create table private.learning_action_kinds (
  action_kind text primary key,
  domain text not null,
  disposition text not null,
  target_table text,
  creates boolean not null default false,
  handler text,
  before_image_columns text[] not null default array[]::text[],
  note text not null,
  constraint learning_action_kinds_name check (action_kind ~ '^[a-z][a-z0-9_]{2,62}$'),
  constraint learning_action_kinds_domain check (domain in (
    'engine', 'tasks', 'cases', 'case_access', 'events', 'messages', 'membership', 'settings')),
  constraint learning_action_kinds_disposition check (disposition in ('reverse', 'simulate', 'permanent', 'excluded')),
  constraint learning_action_kinds_target check (
    (disposition = 'excluded') = (target_table is null)
    and (target_table is null or target_table ~ '^(public|private)\.[a-z_][a-z0-9_]{0,62}$')),
  -- Only a reversing kind names a handler; it lives in private and its name
  -- says what it is, so the undo dispatch can never reach any other function.
  constraint learning_action_kinds_handler check (
    (disposition = 'reverse') = (handler is not null)
    and (handler is null or handler ~ '^private\.learning_undo_[a-z0-9_]{1,48}$')),
  -- A before-image may hold only these columns, never content or secrets.
  constraint learning_action_kinds_image check (
    pg_catalog.cardinality(before_image_columns) <= 40
    and (disposition = 'reverse' or pg_catalog.cardinality(before_image_columns) = 0)
    and not before_image_columns && array['body', 'body_text', 'content', 'text', 'message', 'file', 'file_content',
      'storage_path', 'token', 'token_hash', 'secret', 'key', 'api_key', 'password', 'credential', 'recipients']::text[])
);

create table private.learning_action_journal (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  period_id uuid not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action_kind text not null references private.learning_action_kinds(action_kind) on update restrict on delete restrict,
  target_table text not null,
  target_id text not null,
  parent_entry_id uuid references private.learning_action_journal(id) on delete cascade,
  after_fingerprint text,
  before_ref bigint,
  before_image jsonb,
  state text not null default 'active',
  version integer not null default 1,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  undone_at timestamptz,
  kept_at timestamptz,
  constraint learning_action_journal_period foreign key (period_id, organization_id)
    references private.organization_learning_periods(id, organization_id) on update cascade on delete cascade,
  constraint learning_action_journal_target check (
    target_table ~ '^(public|private)\.[a-z_][a-z0-9_]{0,62}$'
    and pg_catalog.char_length(target_id) between 1 and 128 and target_id !~ '[[:cntrl:]]'),
  constraint learning_action_journal_fingerprint check (after_fingerprint is null or after_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint learning_action_journal_image check (
    before_image is null or (pg_catalog.jsonb_typeof(before_image) = 'object' and pg_catalog.octet_length(before_image::text) <= 8192)),
  constraint learning_action_journal_state check (state in ('active', 'undone', 'kept')),
  constraint learning_action_journal_version check (version >= 1),
  constraint learning_action_journal_undone check ((state = 'undone') = (undone_at is not null)),
  constraint learning_action_journal_kept check ((state = 'kept') = (kept_at is not null))
);
create index learning_action_journal_actor_idx on private.learning_action_journal (organization_id, actor_user_id, created_at desc, id desc);
create index learning_action_journal_target_idx on private.learning_action_journal (target_table, target_id, created_at desc);
create index learning_action_journal_period_state_idx on private.learning_action_journal (period_id, state);
create index learning_action_journal_parent_idx on private.learning_action_journal (parent_entry_id) where parent_entry_id is not null;

-- RPC-only storage with the restrictive session check every private table has.
alter table private.organization_learning_periods enable row level security;
alter table private.organization_learning_periods force row level security;
revoke all on table private.organization_learning_periods from public, anon, authenticated, service_role;
create policy mfa_assurance on private.organization_learning_periods as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.organization_learning_periods is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC checks the caller''s organization and role.';
alter table private.learning_action_kinds enable row level security;
alter table private.learning_action_kinds force row level security;
revoke all on table private.learning_action_kinds from public, anon, authenticated, service_role;
create policy mfa_assurance on private.learning_action_kinds as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.learning_action_kinds is 'Restrictive session MFA defense for RPC-only storage. Migration-owned registry; no client table grants, permissive policy or definer writer.';
alter table private.learning_action_journal enable row level security;
alter table private.learning_action_journal force row level security;
revoke all on table private.learning_action_journal from public, anon, authenticated, service_role;
create policy mfa_assurance on private.learning_action_journal as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.learning_action_journal is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC checks the caller''s organization and own entries.';

-- Organization and person children join the account case graph. The kinds
-- registry has neither an organization nor a person, so it stays outside.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_learning_periods
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_learning_periods
for each row execute function private.lock_case_graph_row_keys('{ended_early_by},{started_by}', '');
create trigger a00_case_graph_lock before insert or update or delete on private.learning_action_journal
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.learning_action_journal
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');

-- A period's start, length and end never move, and ending early and closing
-- happen once. Only an account deletion may detach the starting or ending
-- administrator (ON DELETE SET NULL).
create function private.organization_learning_period_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
     or new.length_days is distinct from old.length_days or new.starts_at is distinct from old.starts_at
     or new.ends_at is distinct from old.ends_at
     or (new.started_by is distinct from old.started_by and new.started_by is not null)
     or (old.ended_early_at is not null and new.ended_early_at is distinct from old.ended_early_at)
     or (old.ended_early_by is not null and new.ended_early_by is distinct from old.ended_early_by and new.ended_early_by is not null)
     or (old.ended_early_at is null and new.ended_early_at is null and new.ended_early_by is distinct from old.ended_early_by)
     or (old.closed_at is not null and new.closed_at is distinct from old.closed_at)
     or (old.reminded_three_days_at is not null and new.reminded_three_days_at is distinct from old.reminded_three_days_at)
     or (old.reminded_one_day_at is not null and new.reminded_one_day_at is distinct from old.reminded_one_day_at)
     or (old.ended_notice_at is not null and new.ended_notice_at is distinct from old.ended_notice_at) then
    raise exception 'learning period is fixed once started' using errcode = '55000';
  end if;
  return new;
end;
$function$;
revoke all on function private.organization_learning_period_guard() from public, anon, authenticated, service_role;
create trigger b10_learning_period_guard before update on private.organization_learning_periods
for each row execute function private.organization_learning_period_guard();

-- A journal entry's identity never moves; its state only goes from active
-- to undone or kept, with its version bumped. Account deletion may detach
-- the actor; closing may clear a kept or undone entry's before-image.
create function private.learning_action_journal_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id or new.organization_id is distinct from old.organization_id
     or new.period_id is distinct from old.period_id or new.action_kind is distinct from old.action_kind
     or new.target_table is distinct from old.target_table or new.target_id is distinct from old.target_id
     or new.parent_entry_id is distinct from old.parent_entry_id or new.created_at is distinct from old.created_at
     or new.after_fingerprint is distinct from old.after_fingerprint or new.before_ref is distinct from old.before_ref
     or (new.actor_user_id is distinct from old.actor_user_id and new.actor_user_id is not null)
     or (new.before_image is distinct from old.before_image and (new.before_image is not null or new.state = 'active'))
     or (old.state <> 'active' and new.state is distinct from old.state)
     or (new.state is distinct from old.state and new.version <> old.version + 1)
     or (new.state is not distinct from old.state and new.version <> old.version) then
    raise exception 'learning journal entry is fixed' using errcode = '55000';
  end if;
  return new;
end;
$function$;
revoke all on function private.learning_action_journal_guard() from public, anon, authenticated, service_role;
create trigger b10_learning_journal_guard before update on private.learning_action_journal
for each row execute function private.learning_action_journal_guard();

create trigger b20_unverified_organization_boundary before insert or update on private.organization_learning_periods
for each row execute function private.enforce_unverified_organization_boundary();
create trigger b20_unverified_organization_boundary before insert or update on private.learning_action_journal
for each row execute function private.enforce_unverified_organization_boundary();

comment on table private.organization_learning_periods is
  'REQ-UG-LEARNING-PERIOD-ENGINE-20261103: the one learning period an organization may run, ever. Written only by start_organization_learning_period, end_organization_learning_period_early and close_learning_period.';
comment on table private.learning_action_kinds is
  'REQ-UG-LEARNING-PERIOD-ENGINE-20261103: migration-owned registry of journalled actions and their disposition (reverse, simulate, permanent, excluded). A write path with no row is not journalled.';
comment on table private.learning_action_journal is
  'REQ-UG-LEARNING-PERIOD-ENGINE-20261103: undo working state for actions a person took during the learning period. Not the audit trail. Before-images hold only allowlisted columns and are cleared when the period closes; the skeleton keeps the practice marker on items created during the period.';

-- The engine's own write paths are never journalled.
insert into private.learning_action_kinds (action_kind, domain, disposition, note) values
  ('learning_period_start', 'engine', 'excluded', 'Starting the period is an administrator setting, recorded in the audit ledger.'),
  ('learning_period_end_early', 'engine', 'excluded', 'Ending early is one-way and recorded in the audit ledger.'),
  ('learning_action_undo', 'engine', 'excluded', 'An undo is never itself undone; there is no redo.');

-- ---------------------------------------------------------------------------
-- 3. Boundary: the two organization-owned tables get their own branch
-- ---------------------------------------------------------------------------
-- Re-emit the current dispatch (20261029141540) with one named case for the
-- learning tables. Every existing branch and the Auth detachment exception
-- are preserved verbatim.
create or replace function private.enforce_unverified_organization_boundary()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  row_data jsonb;
  subject_org uuid;
  other_org uuid;
  attribution text;
begin
  row_data := pg_catalog.to_jsonb(new);

  -- Auth deletion may only detach one actual ON DELETE SET NULL attribution
  -- FK, nested beneath the deletion of that exact user. Direct edits, content
  -- changes and publication changes still pass through the platform guard.
  if tg_op = 'UPDATE' and tg_table_schema = 'public'
     and tg_table_name in ('public_site_records', 'organization_network_directory_profiles') then
    for attribution in
      select a.attname from pg_catalog.pg_constraint fk
      join pg_catalog.pg_attribute a on a.attrelid = fk.conrelid and a.attnum = fk.conkey[1]
      where fk.conrelid = tg_relid and fk.contype = 'f' and fk.confdeltype = 'n'
        and fk.confrelid = 'auth.users'::regclass and pg_catalog.cardinality(fk.conkey) = 1
    loop
      if row_data - attribution = to_jsonb(old) - attribution
         and private.account_lifecycle_is_nested_auth_detachment(
           (to_jsonb(old) ->> attribution)::uuid, (row_data ->> attribution)::uuid) then
        return new;
      end if;
    end loop;
  end if;


  case tg_table_schema || '.' || tg_table_name
    when 'private.platform_announcement_publishers' then
      perform private.platform_announcement_row_guard('platform_announcement_publishers',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_organization_follows' then
      perform private.platform_announcement_row_guard('platform_organization_follows',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcements' then
      perform private.platform_announcement_row_guard('platform_announcements',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcement_delivery_jobs' then
      perform private.platform_announcement_row_guard('platform_announcement_delivery_jobs',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.organization_platform_announcements' then
      perform private.platform_announcement_row_guard('organization_platform_announcements',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcement_preferences' then
      perform private.platform_announcement_row_guard('platform_announcement_preferences',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    when 'private.platform_announcement_audit' then
      perform private.platform_announcement_row_guard('platform_announcement_audit',tg_op,row_data,case when tg_op='UPDATE' then to_jsonb(old) else null end);

    -- REQ-UG-LEARNING-PERIOD-ENGINE-20261103: the learning period and
    -- its journal belong to union organizations only. Unverified ones may
    -- learn (they are the new ones); the platform organization may not.
    when 'private.organization_learning_periods', 'private.learning_action_journal' then
      if not private.organization_is_union((row_data ->> 'organization_id')::uuid) then
        raise exception 'learning period unavailable for this organization' using errcode = '42501';
      end if;

    when 'public.chapter_union_org_bindings' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.chapter_handshakes' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      select c.organization_id into other_org
      from public.chapters c where c.id = row_data ->> 'receiving_chapter_id';
      if (subject_org is not null and not private.organization_clears_signup_boundary(subject_org))
         or (other_org is not null and not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;
      -- A later insert trigger stamps the requesting chapter from the
      -- caller's session, so the caller's own organization is checked too.
      if tg_op = 'INSERT' then
        subject_org := private.current_member_organization();
        if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
          raise exception 'organization verification required' using errcode = '42501';
        end if;
      end if;

    when 'public.organization_coordination_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      other_org := (row_data ->> 'partner_organization_id')::uuid;
      if other_org is not null
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_coordination_organization_participants' then
      other_org := (row_data ->> 'organization_id')::uuid;
      select r.organization_id into subject_org
      from public.organization_coordination_records r
      where r.id = (row_data ->> 'record_id')::uuid;
      -- The owning organization's own participant row stays inside its walls.
      if other_org is distinct from subject_org
         and (not private.organization_clears_signup_boundary(subject_org)
              or not private.organization_clears_signup_boundary(other_org)) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_permission_grants' then
      if not private.organization_clears_signup_boundary((row_data ->> 'grantor_organization_id')::uuid)
         or not private.organization_clears_signup_boundary((row_data ->> 'grantee_organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.organization_network_directory_profiles' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid)
         and (row_data ->> 'visibility' is distinct from 'private'
              or row_data ->> 'parent_organization_id' is not null) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.public_site_records' then
      subject_org := (row_data ->> 'organization_id')::uuid;
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.dues_stripe_oauth_states', 'public.dues_provider_connections' then
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'public.member_invitations' then
      select c.organization_id into subject_org
      from public.chapters c where c.id = row_data ->> 'chapter_id';
      -- The a00_case_graph_lock statement trigger already holds the case-graph
      -- lock for this statement, so concurrent invitations count serially.
      if subject_org is not null and not private.organization_clears_signup_boundary(subject_org) then
        if (select pg_catalog.count(*)
              from public.member_invitations i
              join public.chapters c on c.id = i.chapter_id
             where c.organization_id = subject_org
               and i.created_at > pg_catalog.now() - interval '24 hours') >= 20
           or (select pg_catalog.count(*)
                 from public.member_invitations i
                 join public.chapters c on c.id = i.chapter_id
                where c.organization_id = subject_org) >= 200 then
          raise exception 'invitation rate limited' using errcode = 'P0001';
        end if;
      end if;

    when 'private.chapter_connection_profiles' then
      -- A draft stays inside the organization; a published profile reaches
      -- every other organization's staff.
      if row_data ->> 'publication_status' = 'published'
         and not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    when 'private.chapter_connection_hides' then
      -- A hide names another organization's published chapter and is
      -- reciprocal, so it changes what that chapter sees.
      if not private.organization_clears_signup_boundary((row_data ->> 'organization_id')::uuid) then
        raise exception 'organization verification required' using errcode = '42501';
      end if;

    else
      raise exception 'organization boundary not configured' using errcode = '55000';
  end case;

  return new;
end;
$function$;

revoke all on function private.enforce_unverified_organization_boundary() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Engine helpers
-- ---------------------------------------------------------------------------
-- The organization's period while it runs, by the wall clock (never the
-- transaction start), so a caller that waited on a lock past the end gets
-- nothing.
create function private.learning_period_running(p_organization_id uuid)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $function$
  select p.id from private.organization_learning_periods p
  where p.organization_id = p_organization_id
    and p.closed_at is null
    and pg_catalog.clock_timestamp() >= p.starts_at
    and pg_catalog.clock_timestamp() < coalesce(p.ended_early_at, p.ends_at);
$function$;
revoke all on function private.learning_period_running(uuid) from public, anon, authenticated, service_role;

-- The write side every domain slice calls in the same transaction as its
-- change, after its own authorization. It journals only the caller's own
-- action in the caller's selected organization while its period runs, and
-- only for a registered kind on that kind's table. Returns the entry id, or
-- null when nothing is journalled (no running period, or an excluded kind).
-- Permanent kinds are metadata-only and kept from the start; reversing kinds
-- need an after-fingerprint and a before-reference or allowlisted image.
create function private.learning_journal_append(
  p_action_kind text,
  p_target_table text,
  p_target_id text,
  p_parent_entry_id uuid default null,
  p_after_fingerprint text default null,
  p_before_ref bigint default null,
  p_before_image jsonb default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- Re-entrant: the calling domain RPC already holds it.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  period uuid;
  kind private.learning_action_kinds%rowtype;
  entry uuid;
begin
  if caller is null then return null; end if;
  org := private.current_mobile_staff_organization();
  if org is null then return null; end if;
  select * into kind from private.learning_action_kinds k where k.action_kind = p_action_kind;
  if not found then
    raise exception 'unregistered learning action: %', p_action_kind using errcode = '22023';
  end if;
  if kind.disposition = 'excluded' then return null; end if;
  if kind.target_table is distinct from p_target_table then
    raise exception 'learning action % does not write %', p_action_kind, p_target_table using errcode = '22023';
  end if;
  period := private.learning_period_running(org);
  if period is null then return null; end if;
  -- Hold the period against a concurrent close until this transaction ends,
  -- then read the clock again: a close that committed while this waited
  -- has ended the period, and the write is a real one, not practice.
  perform 1 from private.organization_learning_periods p where p.id = period for share;
  if private.learning_period_running(org) is distinct from period then return null; end if;
  if p_parent_entry_id is not null and not exists (
    select 1 from private.learning_action_journal j
    where j.id = p_parent_entry_id and j.organization_id = org and j.period_id = period and j.actor_user_id = caller
  ) then
    raise exception 'invalid parent learning entry' using errcode = '22023';
  end if;
  if kind.disposition = 'permanent' then
    if p_after_fingerprint is not null or p_before_ref is not null or p_before_image is not null then
      raise exception 'a permanent learning entry is metadata only' using errcode = '22023';
    end if;
  elsif kind.disposition = 'reverse' then
    if p_after_fingerprint is null or (p_before_ref is null and p_before_image is null) then
      raise exception 'a reversible learning entry needs its fingerprint and before state' using errcode = '22023';
    end if;
    if p_before_image is not null and (
      pg_catalog.jsonb_typeof(p_before_image) <> 'object'
      or exists (select 1 from pg_catalog.jsonb_object_keys(p_before_image) k(name) where not (k.name = any(kind.before_image_columns)))
    ) then
      raise exception 'before-image column not allowed for %', p_action_kind using errcode = '22023';
    end if;
  elsif p_before_ref is not null or p_before_image is not null then
    raise exception 'a simulated learning entry keeps no before state' using errcode = '22023';
  end if;
  insert into private.learning_action_journal
    (organization_id, period_id, actor_user_id, action_kind, target_table, target_id, parent_entry_id,
     after_fingerprint, before_ref, before_image, state, kept_at)
  values
    (org, period, caller, p_action_kind, p_target_table, p_target_id, p_parent_entry_id,
     p_after_fingerprint, p_before_ref, p_before_image,
     case when kind.disposition = 'permanent' then 'kept' else 'active' end,
     case when kind.disposition = 'permanent' then pg_catalog.clock_timestamp() end)
  returning id into entry;
  return entry;
end;
end;
$function$;
revoke all on function private.learning_journal_append(text, text, text, uuid, text, bigint, jsonb) from public, anon, authenticated, service_role;

-- The practice marker. A read RPC calls this only after its own
-- authorization, for rows it already returns, so it answers nothing the
-- caller cannot read and adds no identity. 'practice' marks an item created
-- during the period and stays after the period ends (project decision, Nov 3);
-- 'practice_edit' marks an item changed during the period and only while it
-- runs. An undone creation carries no marker.
create function private.learning_practice_flags(p_target_table text, p_ids text[])
returns table (target_id text, flag text)
language sql
volatile
security definer
set search_path = ''
as $function$
  with asked as (
    select distinct a.id from pg_catalog.unnest(p_ids[1:500]) a(id) where a.id is not null
  ), entries as (
    select j.target_id, k.creates, j.state, private.learning_period_running(j.organization_id) is not null as running
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    join asked on asked.id = j.target_id
    where j.target_table = p_target_table
  )
  select e.target_id,
    case when pg_catalog.bool_or(e.creates and e.state in ('active', 'kept')) then 'practice' else 'practice_edit' end
  from entries e
  group by e.target_id
  having pg_catalog.bool_or(e.creates and e.state in ('active', 'kept'))
      or pg_catalog.bool_or(not e.creates and e.state = 'active' and e.running);
$function$;
revoke all on function private.learning_practice_flags(text, text[]) from public, anon, authenticated, service_role;

-- Closing a period, at its end or when an administrator ends it early:
-- every active entry is kept as a real record, every before-image is
-- cleared, and one ledger row records the counts. Safe to rerun: a closed
-- period changes nothing. Domain slices add their own end steps here.
create function private.close_learning_period(p_period_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  period private.organization_learning_periods%rowtype;
  kept integer;
  cleared integer;
  undone integer;
  closing_at timestamptz := pg_catalog.clock_timestamp();
begin
  select * into period from private.organization_learning_periods p where p.id = p_period_id for update;
  if not found then
    raise exception 'learning period not found' using errcode = 'P0002';
  end if;
  if period.closed_at is not null then
    -- The append holds the period while it journals, so none should be
    -- left; if one is, keep it rather than leave its image behind.
    update private.learning_action_journal j
    set state = 'kept', kept_at = period.closed_at, before_image = null, version = j.version + 1
    where j.period_id = period.id and j.state = 'active';
    get diagnostics kept = row_count;
    return pg_catalog.jsonb_build_object('periodId', period.id, 'closed', true, 'changed', kept > 0);
  end if;
  if closing_at < coalesce(period.ended_early_at, period.ends_at) then
    raise exception 'learning period still running' using errcode = '55000';
  end if;
  update private.learning_action_journal j
  set state = 'kept', kept_at = closing_at, before_image = null, version = j.version + 1
  where j.period_id = period.id and j.state = 'active';
  get diagnostics kept = row_count;
  update private.learning_action_journal j
  set before_image = null
  where j.period_id = period.id and j.state <> 'active' and j.before_image is not null;
  get diagnostics cleared = row_count;
  select pg_catalog.count(*)::integer into undone from private.learning_action_journal j
  where j.period_id = period.id and j.state = 'undone';
  update private.organization_learning_periods p set closed_at = closing_at where p.id = period.id;
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    period.organization_id, 'administration', 'learning_period_closed', 'settings_change', null,
    'learning_period', period.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('periodId', period.id, 'keptCount', kept, 'undoneCount', undone, 'imagesCleared', kept + cleared)
  );
  return pg_catalog.jsonb_build_object('periodId', period.id, 'closed', true, 'changed', true,
    'keptCount', kept, 'undoneCount', undone);
end;
end;
$function$;
revoke all on function private.close_learning_period(uuid) from public, anon, authenticated, service_role;

-- What a member of the organization sees about its period; an
-- administrator also learns whether they may start or end it.
create function private.organization_learning_period_payload(p_organization_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'used', p.id is not null,
    'running', p.id is not null and private.learning_period_running(p_organization_id) is not null,
    'periodId', p.id,
    'lengthDays', p.length_days,
    'startsAt', p.starts_at,
    'endsAt', p.ends_at,
    'endedEarlyAt', p.ended_early_at,
    'closedAt', p.closed_at,
    'isAdmin', private.has_organization_role(p_organization_id, array['admin'])
  )
  from (select 1) one
  left join private.organization_learning_periods p on p.organization_id = p_organization_id;
$function$;
revoke all on function private.organization_learning_period_payload(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Client surface
-- ---------------------------------------------------------------------------
create function public.get_organization_learning_period()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_mobile_staff_organization();
  if org is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  return private.organization_learning_period_payload(org);
end;
$function$;
revoke all on function public.get_organization_learning_period() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_learning_period() to authenticated;

-- An active administrator of a union organization, in a session that
-- completed the extra verification step, starts the organization's one
-- period now, for 7 or 14 days. Nothing else starts it.
create function public.start_organization_learning_period(p_length_days integer default 14)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  period uuid;
  started timestamptz := pg_catalog.now();
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied()
     or (select auth.jwt() ->> 'aal') is distinct from 'aal2'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role with verified sign-in required' using errcode = '42501';
  end if;
  if not private.organization_is_union(org) then
    raise exception 'learning period unavailable for this organization' using errcode = '42501';
  end if;
  if p_length_days is null or p_length_days not in (7, 14) then
    raise exception 'invalid learning period length' using errcode = '22023';
  end if;
  insert into private.organization_learning_periods (organization_id, length_days, starts_at, ends_at, started_by)
  values (org, p_length_days, started, started + pg_catalog.make_interval(hours => p_length_days * 24), caller)
  on conflict (organization_id) do nothing
  returning id into period;
  if period is null then
    raise exception 'learning period already used' using errcode = '55000';
  end if;
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'learning_period_started', 'settings_change', caller,
    'learning_period', period::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('periodId', period, 'lengthDays', p_length_days)
  );
  return private.organization_learning_period_payload(org);
end;
end;
$function$;
revoke all on function public.start_organization_learning_period(integer) from public, anon, authenticated, service_role;
grant execute on function public.start_organization_learning_period(integer) to authenticated;

-- An administrator ends the running period now. One-way: the period closes
-- and is announced at once, exactly as at its end (every practice action is
-- kept), and it cannot be restarted.
create function public.end_organization_learning_period_early()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  period private.organization_learning_periods%rowtype;
  ending timestamptz;
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied()
     or (select auth.jwt() ->> 'aal') is distinct from 'aal2'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role with verified sign-in required' using errcode = '42501';
  end if;
  select * into period from private.organization_learning_periods p where p.organization_id = org for update;
  ending := pg_catalog.clock_timestamp();
  if not found or period.closed_at is not null or period.ended_early_at is not null
     or ending >= period.ends_at or ending < period.starts_at then
    raise exception 'learning period not running' using errcode = '55000';
  end if;
  update private.organization_learning_periods p
  set ended_early_at = ending, ended_early_by = caller
  where p.id = period.id;
  insert into public.organization_audit_ledger (
    organization_id, domain, event_type, action, actor_user_id,
    entity_type, entity_id, idempotency_key, metadata
  ) values (
    org, 'administration', 'learning_period_ended_early', 'settings_change', caller,
    'learning_period', period.id::text, extensions.gen_random_uuid(),
    pg_catalog.jsonb_build_object('periodId', period.id)
  );
  perform private.finish_learning_period(period.id);
  return private.organization_learning_period_payload(org);
end;
end;
$function$;
revoke all on function public.end_organization_learning_period_early() from public, anon, authenticated, service_role;
grant execute on function public.end_organization_learning_period_early() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Undo
-- ---------------------------------------------------------------------------
-- The one fingerprint every handler and the engine use: SHA-256 over the
-- canonical jsonb text of the handler's columns (jsonb orders its keys).
create function private.learning_fingerprint(p_state jsonb)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select case when p_state is null or p_state = 'null'::jsonb then null
    else pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_state::text, 'UTF8')), 'hex') end;
$function$;
revoke all on function private.learning_fingerprint(jsonb) from public, anon, authenticated, service_role;

-- The handler interface a domain slice implements for each reversing kind:
-- private.learning_undo_<name>(p_mode text, p_entry jsonb) returns jsonb,
-- called with the caller's own claims, inside the undo transaction:
--   'lock'   lock the target row (p_entry carries target_table and target_id);
--   'state'  return the target's handler columns as they are now (null if gone);
--   'before' return the target's columns as this entry found them (null for a
--            creation), from its before_ref or before_image;
--   'check'  refuse (raise) unless the caller may take the reversing step
--            today and no legal hold or preservation order covers the target;
--   'apply'  reverse this entry through the domain's own path, writing its
--            usual audit rows; a creation is tombstoned, never deleted.
-- Dispatch is static: each domain slice re-emits this function with one
-- branch per handler its kinds name, so only a reviewed, named function is
-- ever called and no SQL is assembled at run time. The engine ships it with
-- no handler at all.
create function private.learning_dispatch(p_handler text, p_mode text, p_entry jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_mode is null or p_mode not in ('lock', 'state', 'before', 'check', 'apply') or p_entry is null then
    raise exception 'invalid learning undo dispatch' using errcode = '22023';
  end if;
  raise exception 'learning undo handler unavailable: %', p_handler using errcode = '55000';
end;
$function$;
revoke all on function private.learning_dispatch(text, text, jsonb) from public, anon, authenticated, service_role;

-- Undo one of your own practice actions, with every later action of yours
-- that depends on it, newest first. Anyone else's entry, or no entry, reads
-- the same: not found. Locks come first (the case graph, then the journal
-- entries, then the targets in ascending order); only then is the clock
-- read, so an undo that waited past the end is refused. Each link is checked
-- against the state the newer undo would leave, never the live row. Any
-- refusal rolls the whole transaction back and leaves every entry active.
create function public.undo_my_learning_action(p_entry_id uuid, p_expected_version integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org uuid;
  requested private.learning_action_journal%rowtype;
  chain_ids uuid[];
  item record;
  target_key text;
  current_state jsonb;
  projected jsonb := '{}'::jsonb;
  undone integer := 0;
begin
  org := private.current_mobile_staff_organization();
  if caller is null or org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into requested from private.learning_action_journal j
  where j.id = p_entry_id and j.actor_user_id = caller and j.organization_id = org
  for update;
  if not found then
    raise exception 'learning entry not found' using errcode = 'P0002';
  end if;
  if requested.state = 'undone' then
    return pg_catalog.jsonb_build_object('status', 'already_undone', 'entryId', requested.id, 'version', requested.version);
  end if;
  if requested.state = 'kept' then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  if p_expected_version is distinct from requested.version then
    raise exception 'learning entry changed' using errcode = '40001';
  end if;

  -- The chain: this entry, your later active entries on the same targets,
  -- and every entry of a bulk action any of them belongs to (its parent and
  -- all its children), so a bulk action is never partly reversed. A parent
  -- joins whatever its state, and one no longer active refuses the undo.
  with recursive chain(id) as (
    select requested.id
    union
    select j.id
    from chain c
    join private.learning_action_journal cj on cj.id = c.id
    join private.learning_action_journal j
      on j.organization_id = org and j.period_id = requested.period_id
     and j.actor_user_id = caller
     and ((j.state = 'active'
           and ((j.target_table = cj.target_table and j.target_id = cj.target_id
                 and (j.created_at, j.id) > (cj.created_at, cj.id))
                or j.parent_entry_id = cj.id))
          or j.id = cj.parent_entry_id)
  )
  select pg_catalog.array_agg(chain.id order by chain.id) into chain_ids from chain;
  perform 1 from private.learning_action_journal j where j.id = any(chain_ids) order by j.id for update;

  if exists (
    select 1 from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and (j.state <> 'active' or k.disposition not in ('reverse', 'simulate'))
  ) then
    raise exception 'this practice action can no longer be undone' using errcode = '55000';
  end if;
  -- Someone else changed one of these targets after you: undo would take
  -- their work with it. What they sent on it stays sent and does not block.
  if exists (
    select 1
    from private.learning_action_journal c
    join private.learning_action_journal o
      on o.target_table = c.target_table and o.target_id = c.target_id
     and (o.created_at, o.id) > (c.created_at, c.id)
     and o.actor_user_id is distinct from caller and o.state <> 'undone'
    join private.learning_action_kinds ok on ok.action_kind = o.action_kind and ok.disposition <> 'permanent'
    where c.id = any(chain_ids)
  ) then
    raise exception 'someone else has changed this since' using errcode = '40001';
  end if;

  for item in
    select distinct j.target_table, j.target_id, k.handler
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids) and k.disposition = 'reverse'
    order by j.target_table, j.target_id
  loop
    perform private.learning_dispatch(item.handler, 'lock',
      pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
  end loop;

  -- Every lock is held: only now read the clock.
  if private.learning_period_running(org) is distinct from requested.period_id then
    raise exception 'the learning period has ended' using errcode = '55000';
  end if;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      target_key := item.target_table || ':' || item.target_id;
      if projected ? target_key then
        current_state := projected -> target_key;
      else
        current_state := private.learning_dispatch(item.handler, 'state',
          pg_catalog.jsonb_build_object('target_table', item.target_table, 'target_id', item.target_id));
      end if;
      if private.learning_fingerprint(current_state) is distinct from item.after_fingerprint then
        raise exception 'this has changed since your practice action' using errcode = '40001';
      end if;
      projected := projected || pg_catalog.jsonb_build_object(target_key,
        coalesce(private.learning_dispatch(item.handler, 'before', pg_catalog.to_jsonb(item)), 'null'::jsonb));
      perform private.learning_dispatch(item.handler, 'check', pg_catalog.to_jsonb(item));
    end if;
  end loop;

  for item in
    select j.*, k.handler, k.disposition
    from private.learning_action_journal j
    join private.learning_action_kinds k on k.action_kind = j.action_kind
    where j.id = any(chain_ids)
    order by j.created_at desc, j.id desc
  loop
    if item.disposition = 'reverse' then
      perform private.learning_dispatch(item.handler, 'apply', pg_catalog.to_jsonb(item));
    end if;
    update private.learning_action_journal j
    set state = 'undone', undone_at = pg_catalog.clock_timestamp(), version = j.version + 1
    where j.id = item.id;
    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      org, 'administration', 'learning_action_undone', 'update', caller,
      'learning_action', item.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('entryId', item.id, 'actionKind', item.action_kind, 'periodId', item.period_id)
    );
    undone := undone + 1;
  end loop;

  return pg_catalog.jsonb_build_object('status', 'undone', 'entryId', requested.id,
    'version', requested.version + 1, 'undoneCount', undone);
end;
end;
$function$;
revoke all on function public.undo_my_learning_action(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function public.undo_my_learning_action(uuid, integer) to authenticated;

-- Your own practice history in your selected organization, newest first:
-- every journalled action, whether Undo is open for it, and "Sent" for
-- permanent ones. Nobody else's history is ever returned.
create function public.list_my_learning_history(p_limit integer default 50, p_before timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid;
  running uuid;
  bounded integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.current_mobile_staff_organization();
  if org is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  running := private.learning_period_running(org);
  return pg_catalog.jsonb_build_object(
    'running', running is not null,
    'entries', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', j.id, 'actionKind', j.action_kind, 'domain', k.domain, 'disposition', k.disposition,
        'targetTable', j.target_table, 'targetId', j.target_id, 'parentEntryId', j.parent_entry_id,
        'state', j.state, 'version', j.version, 'createdAt', j.created_at,
        'undoneAt', j.undone_at, 'keptAt', j.kept_at,
        'sent', k.disposition = 'permanent',
        'undoable', j.state = 'active' and k.disposition in ('reverse', 'simulate') and j.period_id = running
      ) order by j.created_at desc, j.id desc)
      from (
        select * from private.learning_action_journal j
        where j.organization_id = org and j.actor_user_id = caller
          and (p_before is null or j.created_at < p_before)
        order by j.created_at desc, j.id desc
        limit bounded
      ) j
      join private.learning_action_kinds k on k.action_kind = j.action_kind
    ), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.list_my_learning_history(integer, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.list_my_learning_history(integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. End of the period
-- ---------------------------------------------------------------------------
-- In-app notices in each person's own language. Nothing is emailed here.
create function private.learning_period_notify(p_period_id uuid, p_notice text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  period private.organization_learning_periods%rowtype;
  sent integer;
begin
  select * into period from private.organization_learning_periods p where p.id = p_period_id;
  if p_notice in ('three_days', 'one_day') then
    insert into public.member_notifications (user_id, title, body, kind, organization_id)
    select j.actor_user_id,
      case when pr.language = 'es' then 'Tu período de práctica termina pronto' else 'Your learning period ends soon' end,
      case when pr.language = 'es'
        then 'En ' || case p_notice when 'three_days' then '3 días' else '1 día' end || ' tus ' || pg_catalog.count(*) || ' acciones de práctica se conservarán como registros reales. Revísalas o deshazlas antes.'
        else 'In ' || case p_notice when 'three_days' then '3 days' else '1 day' end || ' your ' || pg_catalog.count(*) || ' practice actions will be kept as real records. Review or undo them before then.' end,
      'general', period.organization_id
    from private.learning_action_journal j
    join public.organization_memberships m on m.organization_id = period.organization_id and m.user_id = j.actor_user_id and m.status = 'active'
    left join public.member_profiles pr on pr.id = j.actor_user_id
    where j.period_id = period.id and j.state = 'active'
    group by j.actor_user_id, pr.language;
  elsif p_notice = 'ended' then
    insert into public.member_notifications (user_id, title, body, kind, organization_id)
    select m.user_id,
      case when pr.language = 'es' then 'Terminó el período de práctica' else 'The learning period has ended' end,
      case when pr.language = 'es'
        then 'Lo que se hizo durante el período de práctica ahora se conserva como registros reales.'
        else 'What was done during the learning period is now kept as real records.' end,
      'general', period.organization_id
    from public.organization_memberships m
    left join public.member_profiles pr on pr.id = m.user_id
    where m.organization_id = period.organization_id and m.status = 'active';
  else
    raise exception 'invalid learning notice' using errcode = '22023';
  end if;
  get diagnostics sent = row_count;
  return sent;
end;
end;
$function$;
revoke all on function private.learning_period_notify(uuid, text) from public, anon, authenticated, service_role;

-- Close and announce an ended period once. Both the end job and ending
-- early run exactly this.
create function private.finish_learning_period(p_period_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  closed jsonb;
  announced integer := 0;
begin
  closed := private.close_learning_period(p_period_id);
  if exists (select 1 from private.organization_learning_periods p where p.id = p_period_id and p.ended_notice_at is null) then
    announced := private.learning_period_notify(p_period_id, 'ended');
    update private.organization_learning_periods p set ended_notice_at = pg_catalog.clock_timestamp() where p.id = p_period_id;
  end if;
  return closed || pg_catalog.jsonb_build_object('announced', announced);
end;
end;
$function$;
revoke all on function private.finish_learning_period(uuid) from public, anon, authenticated, service_role;

-- The hourly end job. Idempotent and safe to rerun: each notice goes once,
-- and a closed period changes nothing. A late or failed run never extends
-- undo, which the clock check alone ends.
create function public.run_learning_period_end_job()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
declare
  period private.organization_learning_periods%rowtype;
  at timestamptz;
  reminded integer := 0;
  finished integer := 0;
begin
  -- Executable by service_role and the scheduler only (grants below).
  if (select auth.role()) in ('authenticated', 'anon') then
    raise exception 'service role required' using errcode = '42501';
  end if;
  for period in
    select * from private.organization_learning_periods p
    where p.closed_at is null or p.ended_notice_at is null
    order by p.id
    for update
  loop
    at := pg_catalog.clock_timestamp();
    if at >= coalesce(period.ended_early_at, period.ends_at) then
      perform private.finish_learning_period(period.id);
      finished := finished + 1;
    elsif at >= period.ends_at - interval '24 hours' and period.reminded_one_day_at is null then
      perform private.learning_period_notify(period.id, 'one_day');
      update private.organization_learning_periods p
      set reminded_one_day_at = at, reminded_three_days_at = coalesce(p.reminded_three_days_at, at)
      where p.id = period.id;
      reminded := reminded + 1;
    elsif at >= period.ends_at - interval '72 hours' and at < period.ends_at - interval '24 hours'
          and period.reminded_three_days_at is null then
      perform private.learning_period_notify(period.id, 'three_days');
      update private.organization_learning_periods p set reminded_three_days_at = at where p.id = period.id;
      reminded := reminded + 1;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('reminded', reminded, 'finished', finished);
end;
end;
$function$;
revoke all on function public.run_learning_period_end_job() from public, anon, authenticated, service_role;
grant execute on function public.run_learning_period_end_job() to service_role;

-- ---------------------------------------------------------------------------
-- 8. Account lifecycle
-- ---------------------------------------------------------------------------
insert into private.account_lifecycle_manifest(schema_name,table_name,user_column,delete_disposition,export_disposition,export_inventory_basis,exclusion_reason,note) values
 ('private','organization_learning_periods','started_by','pseudonymize','excluded_with_reason','auth_user_fk','Organization-owned setting, not personal content.','The starting administrator becomes null on account deletion; the start is kept in the audit ledger.'),
 ('private','organization_learning_periods','ended_early_by','pseudonymize','excluded_with_reason','auth_user_fk','Organization-owned setting, not personal content.','The ending administrator becomes null on account deletion; the end is kept in the audit ledger.'),
 ('private','learning_action_journal','actor_user_id','pseudonymize','excluded_with_reason','auth_user_fk','Undo working state with no content; the actions themselves are exported through their own records.','The actor becomes null on account deletion so the practice marker on created items stays; before-images are cleared when the period closes.');

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.schema_name = 'private' and s.table_name in ('organization_learning_periods', 'learning_action_journal'))
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
     'enforce_unverified_organization_boundary()', 'organization_learning_period_guard()', 'learning_action_journal_guard()'))
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_learning_period_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the learning period';
  end if;
end;
$assert_learning_period_trigger_review$;

-- ---------------------------------------------------------------------------
-- 9. The hourly end job joins every job-health registry
-- ---------------------------------------------------------------------------
-- Carried forward from 20261102175905 (the latest copy of the constraint, the
-- cron-history mirror and the health catalog) with only
-- learning-period-end-tick added.
alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in ('account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'learning-period-end-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick'));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
-- Generic plans overestimate the moving cron window; compiling that estimate
-- costs more than the indexed work. This setting is local to this routine.
set jit = off
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  --
  -- One tick mirrors at most 2,000 pending runs, oldest start first (ties by
  -- run id), so a cold or lagging mirror catches up across ticks instead of
  -- writing fourteen days of history in one transaction under the lifecycle
  -- gate. Taking the oldest first keeps the newest-start watermark honest:
  -- this tick's newest mirrored start is no later than any run it left
  -- pending, so every left-over run stays inside the next tick's window. Open
  -- runs are re-read whatever their start, so late completions still land.
  -- Each tick is one transaction and one batch; nothing loops here.
  with candidate as (
    select j.jobname as job_name,
      d.runid as cron_runid,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in ('analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'learning-period-end-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and (d.start_time >= window_start or d.runid = any(open_runs))
  ), pending as (
    select c.*
    from candidate c
    left join lateral (
      -- The unique (job_name, run_id, organization_id) identity admits at
      -- most one row. Keep this a candidate lookup: a merge/hash join may read
      -- the entire retained mirror while the lifecycle gate is held.
      select existing.*
      from public.organization_job_runs existing
      where existing.job_name = c.job_name
        and existing.run_id = c.run_id
        and existing.organization_id is null
      limit 1
    ) mirrored on true
    where mirrored.id is null
       or mirrored.status is distinct from c.status
       or mirrored.finished_at is distinct from c.finished_at
       or mirrored.failure_code is distinct from c.failure_code
       or mirrored.redacted_summary is distinct from c.redacted_summary
    order by c.started_at, c.cron_runid
    limit 2000
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, p.job_name, p.run_id, p.status, p.started_at, p.finished_at,
    p.failure_code, p.redacted_summary
  from pending p
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array['account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'learning-period-end-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'pulse-weekly-snapshots', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick']) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'learning-period-end-tick';
  perform cron.schedule('learning-period-end-tick', '11 * * * *', 'select public.run_learning_period_end_job()');
end;
$block$;

notify pgrst, 'reload schema';
commit;
