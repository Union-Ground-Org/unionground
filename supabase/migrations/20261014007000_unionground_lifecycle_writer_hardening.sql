-- Harden the first lifecycle writer slice without rewriting the verified
-- lifecycle foundation. Commands get one retry-safe receipt, authorization is
-- held through each mutation, and browser reads lose internal provenance.
--
-- Reconciled with the current schema on 2026-10-14 (this file ran at
-- 20260724103000 against an earlier schema). The July admin MFA reset section
-- is removed in favour of the shared reset boundary (see the note where it
-- used to start). Writer authorization now locks these records:
-- the caller's member_profiles row (selected chapter), the active
-- member_chapter_memberships row, and the member_role_chapters grant, and
-- rechecks private.member_has_chapter_role after the locks.

-- This belongs to the repository's documented fresh/offline project replay.
-- It is not an online expand/deploy/contract migration: no lock order can
-- quiesce every pre-existing RPC because those functions acquire the epoch and
-- campaign relations in different statement plans. Stop traffic before any
-- hosted apply rather than claiming a rolling-upgrade guarantee.

alter table public.union_lifecycle_audit_events
  add column request_id uuid,
  add column request_fingerprint text,
  add column result_revision integer;

alter table public.union_lifecycle_audit_events
  add constraint union_lifecycle_audit_request_shape_check
  check (
    (
      request_id is null
      and request_fingerprint is null
      and result_revision is null
    )
    or (
      request_id is not null
      and request_fingerprint is not null
      and request_fingerprint ~ '^[0-9a-f]{64}$'
      and (result_revision is null or result_revision > 0)
    )
  ) not valid;

alter table public.union_lifecycle_audit_events
  validate constraint union_lifecycle_audit_request_shape_check;

create unique index union_lifecycle_audit_request_idx
  on public.union_lifecycle_audit_events(actor_id, chapter_id, request_id)
  where request_id is not null;

-- Reserve every pre-hardening campaign-create UUID in the shared command
-- namespace. The original mutable input cannot be reconstructed, so this is a
-- sentinel rather than a fabricated replay receipt.
insert into public.union_lifecycle_audit_events (
  chapter_id,
  campaign_id,
  actor_id,
  event_type,
  entity_type,
  entity_id,
  to_state,
  safe_metadata,
  occurred_at,
  request_id,
  request_fingerprint,
  result_revision
)
select
  c.chapter_id,
  c.id,
  c.created_by,
  'campaign.created.legacy',
  'organizing_campaign',
  c.id,
  'lead',
  pg_catalog.jsonb_build_object('legacyRequest', true),
  c.created_at,
  c.create_request_id,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.created.legacy',
        'campaignId', c.id
      )::text,
      'sha256'
    ),
    'hex'
  ),
  1
from public.organizing_campaigns c
where not exists (
  select 1
  from public.union_lifecycle_audit_events a
  where a.actor_id = c.created_by
    and a.chapter_id = c.chapter_id
    and a.request_id = c.create_request_id
);

-- Legacy incidents have no replay key. Leave them NULL rather than rewriting
-- the full incident heap or fabricating an idempotency receipt.
alter table public.organizing_resistance_incidents
  add column create_request_id uuid;

alter table public.organizing_resistance_incidents
  add constraint organizing_resistance_incidents_create_request_check
  check (create_request_id is not null) not valid;

create unique index organizing_resistance_creator_request_key
  on public.organizing_resistance_incidents(
    created_by,
    chapter_id,
    create_request_id
  )
  where create_request_id is not null;

alter table public.organizing_stage_events
  add constraint organizing_stage_events_from_stage_domain_check
  check (
    from_stage is null or from_stage in (
      'lead', 'committee', 'cards', 'petition', 'election',
      'recognition', 'certification', 'bargaining',
      'first_contract', 'established'
    )
  ) not valid,
  add constraint organizing_stage_events_to_stage_domain_check
  check (
    to_stage in (
      'lead', 'committee', 'cards', 'petition', 'election',
      'recognition', 'certification', 'bargaining',
      'first_contract', 'established'
    )
  ) not valid,
  add constraint organizing_stage_events_distinct_stage_check
  check (from_stage is null or from_stage <> to_stage) not valid;

-- NOT VALID protects new writes without rejecting or rewriting historical
-- legacy-import rows. Historical reconciliation belongs in an audited,
-- separately reviewed data migration.
alter table public.organizing_campaigns
  add constraint organizing_campaigns_outcome_reason_closed_check
  check (
    status <> 'closed'
    or outcome = 'established'
    or (
      status = 'closed'
      and outcome <> 'established'
      and nullif(pg_catalog.btrim(outcome_reason), '') is not null
      )
  ) not valid;

-- The July version of this file continued here with its own admin MFA
-- reset (security-epoch columns, private reset command and request tables, a
-- lock-taking private.mfa_satisfied(), VOLATILE re-declarations of the
-- read RPCs that called it, begin_mfa_reset(uuid, uuid),
-- complete_mfa_reset(uuid, uuid), and overrides of record_mfa_reset,
-- rotate_calendar_feed_token and upsert_push_subscription that took the reset
-- mutex). The shared reset boundary replaces all of it; see
-- 20261014006000_unionground_mfa_reset_epoch.sql for the reasoning. None of
-- those objects is created, and none of the existing functions is altered.
--
-- The lifecycle writers below still take the per-caller advisory lock keyed
-- 'unionground:mfa-reset:' before their request lock. Nothing else takes
-- that key now; it is kept as the first, per-caller serialization point of
-- every lifecycle and bargaining writer, so one member's concurrent writes
-- queue in a fixed lock order.

-- Lock the exact authorization rows used by campaign writers. Two inner-join
-- branches avoid an outer join whose nullable side PostgreSQL cannot lock.
create function private.lock_lifecycle_campaign_writer(
  p_campaign_id uuid,
  p_chapter_id text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  writer_kind text;
begin
  if caller is null or not (select private.mfa_satisfied()) then
    return null;
  end if;

  select 'coordinator'
  into writer_kind
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  join public.member_role_chapters r
    on r.user_id = p.id
   and r.chapter_id = p.chapter_id
   and r.role = 'coordinator'
  where p.id = caller
    and p.chapter_id = p_chapter_id
  for share of p, r, m;

  if found then
    -- Union Ground's role predicate (organization membership, staff-MFA
    -- policy) must agree with the locked chapter grant.
    if not (select private.mfa_satisfied())
       or not private.member_has_chapter_role(p_chapter_id, array['coordinator']) then
      return null;
    end if;
    return writer_kind;
  end if;

  select a.assignment_role
  into writer_kind
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  join public.member_role_chapters r
    on r.user_id = p.id
   and r.chapter_id = p.chapter_id
   and r.role = 'organizer'
  join public.organizing_campaign_assignments a
    on a.user_id = p.id
   and a.chapter_id = p.chapter_id
   and a.campaign_id = p_campaign_id
  where p.id = caller
    and p.chapter_id = p_chapter_id
    and a.status = 'active'
    and a.assignment_role in ('lead_organizer', 'organizer')
  order by case a.assignment_role
    when 'lead_organizer' then 1
    else 2
  end
  limit 1
  for share of p, r, a, m;

  if not found
     or not (select private.mfa_satisfied())
     or not private.member_has_chapter_role(p_chapter_id, array['organizer']) then
    return null;
  end if;

  return writer_kind;
end;
end;
$$;

revoke all on function private.lock_lifecycle_campaign_writer(uuid, text)
  from public, anon, authenticated, service_role;

-- Campaign creation already had request idempotency and post-wait role locks.
-- Replace the same signature so the per-caller writer lock is always the
-- first blocking lock, as in every other lifecycle writer.
create or replace function public.create_organizing_campaign(
  p_name text,
  p_employer_name text,
  p_worksite_name text,
  p_proposed_unit text,
  p_request_id uuid,
  p_representation_path text default 'undecided',
  p_eligible_estimate integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  scope_chapter text := private.lifecycle_scope_chapter(array['organizer', 'coordinator']);
  employer_id uuid;
  worksite_id uuid;
  campaign_id uuid;
  receipt record;
  request_fingerprint text;
  audit_id uuid;
begin
  if caller is null or scope_chapter is null then
    raise exception 'organizing role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_name, ''))) not between 3 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_employer_name, ''))) not between 2 and 120
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_worksite_name, ''))) not between 2 and 160
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_proposed_unit, ''))) not between 3 and 500 then
    raise exception 'campaign fields are invalid' using errcode = '22023';
  end if;
  if p_representation_path is null
     or p_representation_path not in ('undecided', 'voluntary_recognition', 'election') then
    raise exception 'unknown representation path' using errcode = '22023';
  end if;
  if p_eligible_estimate is not null
     and p_eligible_estimate not between 0 and 10000000 then
    raise exception 'eligible estimate must be between zero and ten million'
      using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'request id is required' using errcode = '22023';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.created',
        'name', pg_catalog.btrim(p_name),
        'employerName', pg_catalog.btrim(p_employer_name),
        'worksiteName', pg_catalog.btrim(p_worksite_name),
        'proposedUnit', pg_catalog.btrim(p_proposed_unit),
        'representationPath', p_representation_path,
        'eligibleEstimate', p_eligible_estimate
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  scope_chapter := private.lifecycle_scope_chapter(array['organizer', 'coordinator']);
  if scope_chapter is null then
    raise exception 'organizing role required' using errcode = '42501';
  end if;
  perform 1
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  join public.member_role_chapters r
    on r.user_id = p.id
   and r.chapter_id = p.chapter_id
   and r.role in ('organizer', 'coordinator')
  where p.id = caller
    and p.chapter_id = scope_chapter
  for share of p, r, m;
  if not found
     or not (select private.mfa_satisfied())
     or private.lifecycle_scope_chapter(array['organizer', 'coordinator']) is distinct from scope_chapter then
    raise exception 'organizing role required' using errcode = '42501';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = scope_chapter
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.safe_metadata ->> 'legacyRequest' = 'true' then
      raise exception 'legacy campaign request cannot be replayed safely'
        using errcode = '55000';
    end if;
    if receipt.event_type <> 'campaign.created'
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', receipt.entity_id,
      'stage', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  -- Pre-hardening create commands have no immutable input receipt. Their
  -- original path and names may already have changed, so never guess whether
  -- an old request is an exact replay.
  if exists (
    select 1
    from public.organizing_campaigns c
    where c.created_by = caller
      and c.chapter_id = scope_chapter
      and c.create_request_id = p_request_id
  ) then
    raise exception 'legacy campaign request cannot be replayed safely'
      using errcode = '55000';
  end if;

  insert into public.union_employers (
    chapter_id, legal_name, display_name, created_by
  ) values (
    scope_chapter,
    pg_catalog.btrim(p_employer_name),
    pg_catalog.btrim(p_employer_name),
    caller
  ) returning id into employer_id;

  insert into public.union_worksites (
    chapter_id, employer_id, name, created_by
  ) values (
    scope_chapter, employer_id, pg_catalog.btrim(p_worksite_name), caller
  ) returning id into worksite_id;

  insert into public.organizing_campaigns (
    chapter_id,
    employer_id,
    primary_worksite_id,
    name,
    proposed_unit,
    representation_path,
    eligible_estimate,
    owner_id,
    next_action_owner_id,
    create_request_id,
    created_by
  ) values (
    scope_chapter,
    employer_id,
    worksite_id,
    pg_catalog.btrim(p_name),
    pg_catalog.btrim(p_proposed_unit),
    p_representation_path,
    p_eligible_estimate,
    caller,
    caller,
    p_request_id,
    caller
  ) returning id into campaign_id;

  insert into public.organizing_campaign_assignments (
    campaign_id, chapter_id, user_id, assignment_role, granted_by
  ) values (
    campaign_id, scope_chapter, caller, 'lead_organizer', caller
  );

  insert into public.organizing_stage_events (
    campaign_id, chapter_id, from_stage, to_stage, actor_id, note
  ) values (
    campaign_id, scope_chapter, null, 'lead', caller, 'Campaign created'
  );

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    request_id,
    request_fingerprint,
    result_revision
  ) values (
    scope_chapter,
    campaign_id,
    caller,
    'campaign.created',
    'organizing_campaign',
    campaign_id,
    'lead',
    p_request_id,
    request_fingerprint,
    1
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign_id,
    'stage', 'lead',
    'revision', 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

revoke all on function
  public.transition_organizing_campaign(uuid, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.set_organizing_campaign_status(uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.record_resistance_incident(uuid, text, text, text, text, date, timestamptz)
  from public, anon, authenticated, service_role;

drop function public.transition_organizing_campaign(uuid, integer, text, text);
drop function public.set_organizing_campaign_status(uuid, integer, text, text, text);
drop function public.record_resistance_incident(uuid, text, text, text, text, date, timestamptz);

create function public.transition_organizing_campaign(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_next_stage text,
  p_request_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  request_fingerprint text;
  allowed boolean := false;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if p_next_stage is null or p_next_stage not in (
    'lead', 'committee', 'cards', 'petition', 'election',
    'recognition', 'certification', 'bargaining',
    'first_contract', 'established'
  ) then
    raise exception 'unknown campaign stage' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_note, '')) > 1000 then
    raise exception 'campaign milestone note is too long' using errcode = '22023';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.stage_changed',
        'campaignId', p_campaign_id,
        'expectedRevision', p_expected_revision,
        'nextStage', p_next_stage,
        'note', normalized_note
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'campaign.stage_changed'
       or receipt.entity_id <> campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', receipt.entity_id,
      'stage', receipt.to_state,
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status <> 'active' then
    raise exception 'campaign is not active' using errcode = '22023';
  end if;

  allowed := case
    when campaign.stage = 'lead' then p_next_stage = 'committee'
    when campaign.stage = 'committee' then p_next_stage = 'cards'
    when campaign.stage = 'cards' then
      (p_next_stage = 'petition' and campaign.representation_path in ('undecided', 'election'))
      or
      (p_next_stage = 'recognition' and campaign.representation_path in ('undecided', 'voluntary_recognition'))
    when campaign.stage = 'petition' then
      campaign.representation_path = 'election' and p_next_stage = 'election'
    when campaign.stage = 'election' then p_next_stage = 'certification'
    when campaign.stage = 'recognition' then
      campaign.representation_path = 'voluntary_recognition' and p_next_stage = 'bargaining'
    when campaign.stage = 'certification' then p_next_stage = 'bargaining'
    -- First-contract entry remains fail-closed until a typed, approved
    -- ratification record can be checked in this transaction.
    when campaign.stage = 'bargaining' then false
    when campaign.stage = 'first_contract' then p_next_stage = 'established'
    else false
  end;
  if not allowed then
    raise exception 'invalid campaign transition' using errcode = '22023';
  end if;

  if p_next_stage = 'bargaining'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = campaign.id
         and b.chapter_id = campaign.chapter_id
         and b.bargaining_started_on is not null
         and b.phase in (
           'at_table', 'mediation', 'fact_finding', 'impasse',
           'tentative_agreement', 'ratification', 'execution', 'complete'
         )
     ) then
    raise exception 'verified bargaining start required' using errcode = '22023';
  end if;
  if p_next_stage = 'established'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = campaign.id
         and b.chapter_id = campaign.chapter_id
         and b.phase = 'complete'
         and b.first_contract_signed_on is not null
     ) then
    raise exception 'signed first contract required' using errcode = '22023';
  end if;

  event_time := pg_catalog.clock_timestamp();

  update public.organizing_campaigns
  set stage = p_next_stage,
      representation_path = case
        when campaign.stage = 'cards' and p_next_stage = 'petition' then 'election'
        when campaign.stage = 'cards' and p_next_stage = 'recognition' then 'voluntary_recognition'
        else representation_path
      end,
      status = case when p_next_stage = 'established' then 'closed' else status end,
      outcome = case when p_next_stage = 'established' then 'established' else outcome end,
      outcome_reason = case when p_next_stage = 'established' then null else outcome_reason end,
      closed_at = case when p_next_stage = 'established' then event_time else closed_at end,
      stage_started_at = event_time,
      revision = revision + 1
  where id = campaign.id;

  insert into public.organizing_stage_events (
    campaign_id,
    chapter_id,
    from_stage,
    to_stage,
    actor_id,
    note,
    occurred_at
  ) values (
    campaign.id,
    campaign.chapter_id,
    campaign.stage,
    p_next_stage,
    caller,
    normalized_note,
    event_time
  );

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'campaign.stage_changed',
    'organizing_campaign',
    campaign.id,
    campaign.stage,
    p_next_stage,
    normalized_note,
    p_request_id,
    request_fingerprint,
    campaign.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'stage', p_next_stage,
    'revision', campaign.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

create function public.set_organizing_campaign_status(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_status text,
  p_request_id uuid,
  p_outcome text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  request_fingerprint text;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision <= 0 then
    raise exception 'campaign revision is required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'paused', 'closed') then
    raise exception 'unknown campaign status' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(normalized_reason, '')) > 1000 then
    raise exception 'campaign status reason is too long' using errcode = '22023';
  end if;
  if p_status = 'closed' then
    if p_outcome is null or p_outcome not in ('withdrawn', 'lost', 'other') then
      raise exception 'closed campaign outcome required' using errcode = '22023';
    end if;
    if normalized_reason is null then
      raise exception 'closed campaign reason required' using errcode = '22023';
    end if;
  elsif p_outcome is not null then
    raise exception 'outcome is only valid when closing' using errcode = '22023';
  end if;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'campaign.status_changed',
        'campaignId', p_campaign_id,
        'expectedRevision', p_expected_revision,
        'status', p_status,
        'outcome', p_outcome,
        'reason', normalized_reason
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'campaign.status_changed'
       or receipt.entity_id <> campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', receipt.entity_id,
      'status', receipt.to_state,
      'outcome', receipt.safe_metadata ->> 'outcome',
      'revision', receipt.result_revision,
      'auditEventId', receipt.id
    );
  end if;

  if campaign.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if campaign.status = 'closed' then
    raise exception 'closed campaign cannot be changed' using errcode = '22023';
  end if;
  if campaign.status = p_status then
    raise exception 'campaign already has that status' using errcode = '22023';
  end if;
  if not (
    (campaign.status = 'active' and p_status in ('paused', 'closed'))
    or
    (campaign.status = 'paused' and p_status in ('active', 'closed'))
  ) then
    raise exception 'invalid campaign status transition' using errcode = '22023';
  end if;
  if p_status = 'closed' and writer_kind <> 'coordinator' then
    raise exception 'coordinator role required to close a campaign' using errcode = '42501';
  end if;

  event_time := pg_catalog.clock_timestamp();

  update public.organizing_campaigns
  set status = p_status,
      outcome = case when p_status = 'closed' then p_outcome else null end,
      outcome_reason = case when p_status = 'closed' then normalized_reason else null end,
      closed_at = case when p_status = 'closed' then event_time else null end,
      revision = revision + 1
  where id = campaign.id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    from_state,
    to_state,
    reason,
    safe_metadata,
    request_id,
    request_fingerprint,
    result_revision,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'campaign.status_changed',
    'organizing_campaign',
    campaign.id,
    campaign.status,
    p_status,
    normalized_reason,
    pg_catalog.jsonb_build_object(
      'outcome',
      case when p_status = 'closed' then p_outcome else null end
    ),
    p_request_id,
    request_fingerprint,
    campaign.revision + 1,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'status', p_status,
    'outcome', case when p_status = 'closed' then p_outcome else null end,
    'revision', campaign.revision + 1,
    'auditEventId', audit_id
  );
end;
end;
$$;

create function public.record_resistance_incident(
  p_campaign_id uuid,
  p_title text,
  p_category text,
  p_severity text,
  p_summary text,
  p_request_id uuid,
  p_source_kind text,
  p_occurred_on date default null,
  p_next_deadline_at timestamptz default null,
  p_consider_legal_review boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  campaign record;
  receipt record;
  writer_kind text;
  normalized_title text := pg_catalog.btrim(coalesce(p_title, ''));
  normalized_summary text := pg_catalog.btrim(coalesce(p_summary, ''));
  request_fingerprint text;
  incident_id uuid;
  incident_reference text;
  legal_review_status text;
  event_time timestamptz;
  audit_id uuid;
begin
  if caller is null or p_campaign_id is null or p_request_id is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if pg_catalog.char_length(normalized_title) not between 3 and 180
     or pg_catalog.char_length(normalized_summary) not between 3 and 4000 then
    raise exception 'incident fields are invalid' using errcode = '22023';
  end if;
  if p_category is null or p_category not in (
    'surveillance', 'interrogation', 'threat', 'captive_audience',
    'retaliation', 'discipline', 'discharge', 'delay',
    'unilateral_change', 'other'
  ) then
    raise exception 'incident category is invalid' using errcode = '22023';
  end if;
  if p_severity is null or p_severity not in ('monitor', 'standard', 'high', 'immediate') then
    raise exception 'incident urgency is invalid' using errcode = '22023';
  end if;
  if p_source_kind is null or p_source_kind not in (
    'worker_report', 'steward_report', 'organizer_note',
    'bargaining_record', 'document', 'other'
  ) then
    raise exception 'incident source is invalid' using errcode = '22023';
  end if;
  if p_occurred_on is not null and p_occurred_on > current_date then
    raise exception 'incident date cannot be in the future' using errcode = '22023';
  end if;
  if p_consider_legal_review is null then
    raise exception 'legal review choice is required' using errcode = '22023';
  end if;

  legal_review_status := case
    when p_consider_legal_review then 'consider_review'
    else 'not_requested'
  end;

  request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.jsonb_build_object(
        'operation', 'resistance.reported',
        'campaignId', p_campaign_id,
        'title', normalized_title,
        'category', p_category,
        'severity', p_severity,
        'summary', normalized_summary,
        'sourceKind', p_source_kind,
        'occurredOn', p_occurred_on,
        'nextDeadlineAt', p_next_deadline_at,
        'considerLegalReview', p_consider_legal_review
      )::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:mfa-reset:' || caller::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'unionground:lifecycle-request:'
      || caller::text || ':' || p_request_id::text,
      0
    )
  );

  if not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select *
  into campaign
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  writer_kind := private.lock_lifecycle_campaign_writer(campaign.id, campaign.chapter_id);
  if writer_kind is null then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'resistance.reported'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from request_fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'incidentId', receipt.entity_id,
      'reference', receipt.safe_metadata ->> 'reference',
      'status', receipt.to_state,
      'legalReviewStatus', receipt.safe_metadata ->> 'legalReviewStatus',
      'auditEventId', receipt.id
    );
  end if;

  if campaign.status = 'closed' then
    raise exception 'closed campaign cannot receive incident reports' using errcode = '22023';
  end if;

  event_time := pg_catalog.clock_timestamp();
  incident_reference := 'ER-' || pg_catalog.to_char(event_time, 'YYYY') || '-' ||
    pg_catalog.upper(
      pg_catalog.substr(
        pg_catalog.replace(extensions.gen_random_uuid()::text, '-', ''),
        1,
        8
      )
    );

  insert into public.organizing_resistance_incidents (
    campaign_id,
    chapter_id,
    reference,
    title,
    category,
    severity,
    factual_summary,
    occurred_on,
    source_kind,
    legal_review_status,
    next_deadline_at,
    owner_id,
    created_by,
    create_request_id,
    created_at,
    updated_at
  ) values (
    campaign.id,
    campaign.chapter_id,
    incident_reference,
    normalized_title,
    p_category,
    p_severity,
    normalized_summary,
    p_occurred_on,
    p_source_kind,
    legal_review_status,
    p_next_deadline_at,
    caller,
    caller,
    p_request_id,
    event_time,
    event_time
  ) returning id into incident_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id,
    campaign_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    to_state,
    safe_metadata,
    request_id,
    request_fingerprint,
    occurred_at
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'resistance.reported',
    'resistance_incident',
    incident_id,
    'reported',
    pg_catalog.jsonb_build_object(
      'reference', incident_reference,
      'category', p_category,
      'severity', p_severity,
      'sourceKind', p_source_kind,
      'legalReviewStatus', legal_review_status
    ),
    p_request_id,
    request_fingerprint,
    event_time
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'incidentId', incident_id,
    'reference', incident_reference,
    'status', 'reported',
    'legalReviewStatus', legal_review_status,
    'auditEventId', audit_id
  );
end;
end;
$$;

-- The app currently consumes membership/onboarding through bounded definer
-- functions. Keep optional own-row reads useful without exposing provenance,
-- staff identifiers, chapter identifiers, or internal reasons.
revoke all on table
  public.union_employers,
  public.union_worksites,
  public.organizing_campaigns,
  public.organizing_campaign_assignments,
  public.organizing_stage_events,
  public.organizing_work_areas,
  public.organizing_workers,
  public.organizing_contact_events,
  public.organizing_resistance_incidents,
  public.organizing_resistance_evidence,
  public.organizing_bargaining_cycles,
  public.organizing_bargaining_proposals,
  public.organizing_bargaining_sessions,
  public.member_membership_periods,
  public.member_onboarding_steps,
  public.member_participation_events,
  public.coalition_partners,
  public.coalition_handshakes,
  public.coalition_commitments,
  public.union_lifecycle_audit_events
from service_role;

revoke select on public.member_membership_periods from authenticated;
revoke select (
  id,
  user_id,
  chapter_id,
  joined_on,
  left_on,
  date_precision,
  status,
  end_reason,
  source_kind,
  verified_by,
  verified_at,
  created_at
) on public.member_membership_periods from authenticated;
grant select (
  id,
  joined_on,
  left_on,
  date_precision,
  status,
  verified_at
) on public.member_membership_periods to authenticated;

revoke select on public.member_onboarding_steps from authenticated;
revoke select (
  id,
  membership_period_id,
  user_id,
  chapter_id,
  step_key,
  due_on,
  status,
  source_kind,
  source_id,
  completed_at,
  verified_by,
  created_at
) on public.member_onboarding_steps from authenticated;
grant select (
  id,
  membership_period_id,
  step_key,
  due_on,
  status,
  completed_at
) on public.member_onboarding_steps to authenticated;

revoke all on function public.transition_organizing_campaign(
  uuid, integer, text, uuid, text
) from public, anon, authenticated, service_role;
revoke all on function public.create_organizing_campaign(
  text, text, text, text, uuid, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.set_organizing_campaign_status(
  uuid, integer, text, uuid, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.record_resistance_incident(
  uuid, text, text, text, text, uuid, text, date, timestamptz, boolean
) from public, anon, authenticated, service_role;

grant execute on function public.transition_organizing_campaign(
  uuid, integer, text, uuid, text
) to authenticated;
grant execute on function public.create_organizing_campaign(
  text, text, text, text, uuid, text, integer
) to authenticated;
grant execute on function public.set_organizing_campaign_status(
  uuid, integer, text, uuid, text, text
) to authenticated;
grant execute on function public.record_resistance_incident(
  uuid, text, text, text, text, uuid, text, date, timestamptz, boolean
) to authenticated;

notify pgrst, 'reload schema';
