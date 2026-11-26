-- REQ-UG-FIRST-CONTRACT-GOVERNANCE-20260724: give the
-- post-contract ratification integrity hold a governed exit.
--
-- Before this migration a correction recorded after a first contract set
-- organizing_bargaining_cycles.ratification_integrity_hold = true and no code
-- path could ever set it back. The BEFORE trigger
-- private.prevent_corrected_ratification_reactivation() rejected every UPDATE
-- that cleared the flag, including one issued by postgres or service_role, so
-- the only recovery was a DBA running ALTER TABLE ... DISABLE TRIGGER on live
-- evidence data. The trigger comment already named a "governed resolution"
-- that did not exist. This migration builds it.
--
-- The exit is deliberately narrow. A resolution is a staff act with the same
-- authority, MFA, idempotency, and audit obligations as the correction that
-- created the hold, and the trigger still refuses every clear that does not
-- arrive through it.
--
-- Reconciled with the current schema on 2026-10-14 (this file ran at
-- 20260725100000 against an earlier schema). It touches only the lifecycle's
-- bargaining objects; unchanged apart from comments.

-- 1. The governed resolution writer -----------------------------------------

create function public.resolve_ratification_integrity_hold(
  p_cycle_id uuid,
  p_expected_cycle_revision integer,
  p_request_id uuid,
  p_resolution_note text
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
  target record;
  campaign record;
  cycle record;
  receipt record;
  correction record;
  fingerprint text;
  audit_id uuid;
  event_time timestamptz := pg_catalog.clock_timestamp();
  normalized_note text := pg_catalog.btrim(coalesce(p_resolution_note, ''));
begin
  -- organizing_bargaining_cycles does not FORCE row level security, so this
  -- definer body bypasses the mfa_assurance policies that protect the sibling
  -- evidence tables. The MFA gate has to be stated here to exist at all.
  if caller is null
     or p_cycle_id is null
     or p_request_id is null
     or not (select private.mfa_satisfied()) then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;
  if p_expected_cycle_revision is null
     or p_expected_cycle_revision <= 0 then
    raise exception 'current revisions are required' using errcode = '22023';
  end if;
  -- The note is the whole product record of why the hold was lifted, so an
  -- empty one is a rejected request, not a nullable field. 1000 is the
  -- union_lifecycle_audit_events.reason ceiling.
  if pg_catalog.char_length(normalized_note) not between 3 and 1000 then
    raise exception 'resolution note is invalid' using errcode = '22023';
  end if;

  fingerprint := private.bargaining_request_fingerprint(
    'bargaining.integrity_hold.resolved',
    pg_catalog.jsonb_build_object(
      'cycleId', p_cycle_id,
      'expectedCycleRevision', p_expected_cycle_revision,
      'resolutionNote', normalized_note
    )
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
        || caller::text
        || ':'
        || p_request_id::text,
      0
    )
  );

  select c.campaign_id, c.chapter_id
  into target
  from public.organizing_bargaining_cycles c
  where c.id = p_cycle_id;

  if not found then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  -- Campaign before cycle: the sibling bargaining writers take the row locks
  -- in this order, and a resolution that reversed it could deadlock against a
  -- concurrent correction on the same campaign.
  select *
  into campaign
  from public.organizing_campaigns
  where id = target.campaign_id
    and chapter_id = target.chapter_id
  for update;

  select *
  into cycle
  from public.organizing_bargaining_cycles
  where id = p_cycle_id
    and campaign_id = campaign.id
    and chapter_id = campaign.chapter_id
  for update;

  if not found
     or private.lock_bargaining_campaign_writer(
       campaign.id,
       campaign.chapter_id,
       true
     ) is null then
    raise exception 'bargaining cycle not found' using errcode = '22023';
  end if;

  select a.*
  into receipt
  from public.union_lifecycle_audit_events a
  where a.actor_id = caller
    and a.chapter_id = campaign.chapter_id
    and a.request_id = p_request_id
  limit 1;

  if found then
    if receipt.event_type <> 'bargaining.integrity_hold.resolved'
       or receipt.campaign_id is distinct from campaign.id
       or receipt.request_fingerprint is distinct from fingerprint then
      raise exception 'request id was already used with different input'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'idempotent', true,
      'requestId', p_request_id,
      'campaignId', campaign.id,
      'cycleId', cycle.id,
      'phase', receipt.safe_metadata ->> 'phase',
      'revision', receipt.result_revision,
      'correctionId', (receipt.safe_metadata ->> 'correctionId')::uuid,
      'integrityHold', false,
      'auditEventId', receipt.id
    );
  end if;

  if cycle.revision <> p_expected_cycle_revision then
    raise exception 'bargaining record changed; reload and try again'
      using errcode = '40001';
  end if;

  -- Resolve only the hold the correction workflow can actually create: a
  -- correction whose ratification is the one a recorded first contract was
  -- built on. This is the same linkage the trigger demands before it will let
  -- the flag be raised, so nothing else can reach this exit.
  select correction_row.*
  into correction
  from public.organizing_bargaining_ratification_corrections correction_row
  join public.organizing_first_contracts contract
    on contract.ratification_id = correction_row.ratification_id
   and contract.cycle_id = correction_row.cycle_id
   and contract.campaign_id = correction_row.campaign_id
   and contract.chapter_id = correction_row.chapter_id
  where correction_row.cycle_id = cycle.id
    and correction_row.campaign_id = campaign.id
    and correction_row.chapter_id = campaign.chapter_id
  order by correction_row.created_at desc
  limit 1
  for share of correction_row;

  if not cycle.ratification_integrity_hold or correction.id is null then
    raise exception 'integrity hold resolution is not eligible'
      using errcode = '22023';
  end if;

  -- The audit row is written BEFORE the clear on purpose: the trigger below
  -- reads it back to confirm the marker names a real, append-only resolution
  -- receipt, so the escape hatch cannot be opened by set_config alone.
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
    'bargaining.integrity_hold.resolved',
    'bargaining_integrity_hold',
    cycle.id,
    'integrity_hold',
    'resolved',
    normalized_note,
    pg_catalog.jsonb_build_object(
      'campaignRevision', campaign.revision,
      'campaignStage', campaign.stage,
      'cycleRevision', cycle.revision + 1,
      'phase', cycle.phase,
      'correctionId', correction.id,
      'ratificationId', correction.ratification_id
    ),
    p_request_id,
    fingerprint,
    cycle.revision + 1,
    event_time
  ) returning id into audit_id;

  -- Transaction-local marker, cleared immediately after the update so the
  -- permission cannot leak to any other statement in the same transaction.
  perform pg_catalog.set_config(
    'unionground.hold_resolution',
    p_request_id::text,
    true
  );

  update public.organizing_bargaining_cycles
  set ratification_integrity_hold = false,
      revision = cycle.revision + 1,
      updated_at = event_time
  where id = cycle.id;

  perform pg_catalog.set_config('unionground.hold_resolution', '', true);

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'idempotent', false,
    'requestId', p_request_id,
    'campaignId', campaign.id,
    'cycleId', cycle.id,
    'phase', cycle.phase,
    'revision', cycle.revision + 1,
    'correctionId', correction.id,
    'ratificationId', correction.ratification_id,
    'integrityHold', false,
    'auditEventId', audit_id
  );
end;
end;
$$;

comment on function public.resolve_ratification_integrity_hold(
  uuid, integer, uuid, text
) is
  'Governed exit from a post-first-contract ratification integrity hold. '
  'Requires the same coordinator writer lock and reset-safe AAL2 session as '
  'correct_organizing_ratification, writes an append-only resolution receipt, '
  'and is the only caller the cycle trigger will accept a clear from.';

-- 2. Relax the trigger to permit precisely that one clear -------------------

-- Replaced rather than edited in place so 20261014008000 keeps shipping the
-- original, unrelaxed body and this file alone carries the governed exit.
-- (When written, as 20260725100000, the reason was that 20260724110000 was
-- already applied. This lane has no applied history yet; the split is
-- kept because the two bodies are reviewed and tested separately.)
create or replace function private.prevent_corrected_ratification_reactivation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  resolution text;
begin
  if new.current_ratification_id is not null
     and exists (
       select 1
       from public.organizing_bargaining_ratification_corrections correction
       where correction.ratification_id = new.current_ratification_id
     ) then
    raise exception 'corrected ratification cannot become current'
      using errcode = '22023';
  end if;
  if new.ratification_integrity_hold
     and not exists (
       select 1
       from public.organizing_first_contracts contract
       join public.organizing_bargaining_ratification_corrections correction
         on correction.ratification_id = contract.ratification_id
        and correction.cycle_id = contract.cycle_id
        and correction.campaign_id = contract.campaign_id
        and correction.chapter_id = contract.chapter_id
       where contract.cycle_id = new.id
         and contract.campaign_id = new.campaign_id
         and contract.chapter_id = new.chapter_id
     ) then
    raise exception 'ratification integrity hold requires corrected contract authority'
      using errcode = '22023';
  end if;
  if tg_op = 'UPDATE'
     and old.ratification_integrity_hold
     and not new.ratification_integrity_hold then
    -- nullif, not pg_catalog.nullif: NULLIF is parser syntax and has no
    -- catalog entry, so a schema-qualified call would not resolve.
    resolution := nullif(
      pg_catalog.current_setting('unionground.hold_resolution', true),
      ''
    );
    -- Shape first, in its own IF: Postgres does not promise left-to-right
    -- short-circuit evaluation of OR, so folding the ::uuid cast into the
    -- same condition could surface a raw 22P02 instead of this refusal.
    if resolution is null
       or resolution !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'ratification integrity hold requires governed resolution'
        using errcode = '22023';
    end if;
    -- The marker alone proves nothing — anything with raw SQL could set it.
    -- What it does is name the append-only receipt that must already exist
    -- for THIS cycle, so the only way to clear the flag is to leave a
    -- correction-linked audit trail that cannot afterwards be edited away.
    if not exists (
         select 1
         from public.union_lifecycle_audit_events a
         where a.request_id = resolution::uuid
           and a.event_type = 'bargaining.integrity_hold.resolved'
           and a.entity_type = 'bargaining_integrity_hold'
           and a.entity_id = new.id
           and a.campaign_id = new.campaign_id
           and a.chapter_id = new.chapter_id
       )
       or not exists (
         select 1
         from public.organizing_bargaining_ratification_corrections correction
         where correction.cycle_id = new.id
           and correction.campaign_id = new.campaign_id
           and correction.chapter_id = new.chapter_id
       ) then
      raise exception 'ratification integrity hold requires governed resolution'
        using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_corrected_ratification_reactivation()
  from public, anon, authenticated, service_role;

-- 3. Exact authenticated RPC surface ----------------------------------------

revoke all on function public.resolve_ratification_integrity_hold(
  uuid, integer, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.resolve_ratification_integrity_hold(
  uuid, integer, uuid, text
) to authenticated;

notify pgrst, 'reload schema';
