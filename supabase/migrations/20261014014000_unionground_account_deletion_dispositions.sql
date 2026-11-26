-- Union Ground: reviewed account-deletion dispositions for the 44
-- auth.users keys the lifecycle migrations added (
-- 2026-10-15).
--
-- 20261014001000-009000 created the organizing lifecycle with 44
-- single-column auth.users foreign keys and no account-lifecycle manifest
-- rows, so private.account_lifecycle_unmanaged_restrictive_fks() and
-- private.account_lifecycle_unmanaged_export_fks() reported them and deleting
-- any account that had authored campaign evidence was refused by 28 RESTRICT
-- keys. This file reviews every one, with the existing vocabulary and
-- precedents (20260907150000 and its successors):
--
--   * cascade: the worker's own private records (membership period,
--     onboarding steps, participation and recognition receipts, trainings and
--     commitments offered to them, their campaign assignment and the weekly
--     recognition counters). They are deleted with the account, and the
--     records a worker would expect to take with them are exported first
--     through hand-shaped additionalDomains projections that never carry
--     another person's identity.
--   * pseudonymize: actor, author and assignment columns on shared campaign
--     records (created_by, recorded_by, verified_by, assigned_*, owner and
--     lead columns). The FK becomes ON DELETE SET NULL, so the campaign's
--     history survives without the departed person's identity. Card and
--     support records (organizing_workers, organizing_contact_events) keep
--     the worker under a private alias and lose the organizer identity.
--
-- Five append-only or paired-state guards would veto that SET NULL, so they
-- admit exactly the nested FK detachment the protocol already recognizes
-- (private.account_lifecycle_is_nested_auth_detachment) and still refuse every
-- ordinary write. Twelve restrictive composite keys below member_chapter_
-- memberships and the worker's own records are reviewed in
-- private.account_lifecycle_transitive_fk_manifest.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Referential actions
-- ---------------------------------------------------------------------------

-- union_employers, union_worksites: campaign-scoped employer and worksite
-- records. created_by is authorship on a shared campaign record: pseudonymize.
alter table public.union_employers drop constraint union_employers_created_by_fkey;
alter table public.union_employers alter column created_by drop not null;
alter table public.union_employers add constraint union_employers_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.union_worksites drop constraint union_worksites_created_by_fkey;
alter table public.union_worksites alter column created_by drop not null;
alter table public.union_worksites add constraint union_worksites_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;

-- organizing_campaigns: the campaign itself. created_by (authorship), owner_id
-- and next_action_owner_id (assignments) are pseudonymized; the campaign and
-- its stage history stay with the campaign.
alter table public.organizing_campaigns drop constraint organizing_campaigns_created_by_fkey;
alter table public.organizing_campaigns alter column created_by drop not null;
alter table public.organizing_campaigns add constraint organizing_campaigns_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organizing_campaigns drop constraint organizing_campaigns_owner_id_fkey;
alter table public.organizing_campaigns alter column owner_id drop not null;
alter table public.organizing_campaigns add constraint organizing_campaigns_owner_id_fkey foreign key (owner_id) references auth.users(id) on delete set null;

-- organizing_campaign_assignments: user_id is the assigned person's own access
-- assignment (already ON DELETE CASCADE); granted_by is the granting staff
-- member's attribution: pseudonymize.
alter table public.organizing_campaign_assignments drop constraint organizing_campaign_assignments_granted_by_fkey;
alter table public.organizing_campaign_assignments alter column granted_by drop not null;
alter table public.organizing_campaign_assignments add constraint organizing_campaign_assignments_granted_by_fkey foreign key (granted_by) references auth.users(id) on delete set null;

-- organizing_stage_events: the campaign's stage history. actor_id: pseudonymize.
alter table public.organizing_stage_events drop constraint organizing_stage_events_actor_id_fkey;
alter table public.organizing_stage_events alter column actor_id drop not null;
alter table public.organizing_stage_events add constraint organizing_stage_events_actor_id_fkey foreign key (actor_id) references auth.users(id) on delete set null;

-- organizing_workers: the campaign's private support map, keyed by a private
-- alias and never by a worker's account. created_by and assigned_to are the
-- organizers who recorded and follow up the row: pseudonymize, so no support
-- rating stays tied to a deleted organizer.
alter table public.organizing_workers drop constraint organizing_workers_created_by_fkey;
alter table public.organizing_workers alter column created_by drop not null;
alter table public.organizing_workers add constraint organizing_workers_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;

-- organizing_contact_events: one-on-one contact history on a support-map row.
-- actor_id is the contacting organizer: pseudonymize.
alter table public.organizing_contact_events drop constraint organizing_contact_events_actor_id_fkey;
alter table public.organizing_contact_events alter column actor_id drop not null;
alter table public.organizing_contact_events add constraint organizing_contact_events_actor_id_fkey foreign key (actor_id) references auth.users(id) on delete set null;

-- organizing_resistance_incidents, organizing_resistance_evidence: the
-- campaign's record of employer resistance. created_by, owner_id and
-- uploaded_by: pseudonymize, so the evidence survives for the campaign and its
-- legal review without the reporter's or uploader's identity.
alter table public.organizing_resistance_incidents drop constraint organizing_resistance_incidents_created_by_fkey;
alter table public.organizing_resistance_incidents alter column created_by drop not null;
alter table public.organizing_resistance_incidents add constraint organizing_resistance_incidents_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organizing_resistance_evidence drop constraint organizing_resistance_evidence_uploaded_by_fkey;
alter table public.organizing_resistance_evidence alter column uploaded_by drop not null;
alter table public.organizing_resistance_evidence add constraint organizing_resistance_evidence_uploaded_by_fkey foreign key (uploaded_by) references auth.users(id) on delete set null;

-- organizing_bargaining_cycles, _proposals, _sessions: first-contract
-- bargaining records. created_by and lead_id: pseudonymize.
alter table public.organizing_bargaining_cycles drop constraint organizing_bargaining_cycles_created_by_fkey;
alter table public.organizing_bargaining_cycles alter column created_by drop not null;
alter table public.organizing_bargaining_cycles add constraint organizing_bargaining_cycles_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organizing_bargaining_proposals drop constraint organizing_bargaining_proposals_created_by_fkey;
alter table public.organizing_bargaining_proposals alter column created_by drop not null;
alter table public.organizing_bargaining_proposals add constraint organizing_bargaining_proposals_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organizing_bargaining_sessions drop constraint organizing_bargaining_sessions_created_by_fkey;
alter table public.organizing_bargaining_sessions alter column created_by drop not null;
alter table public.organizing_bargaining_sessions add constraint organizing_bargaining_sessions_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;

-- organizing_bargaining_ratifications, _ratification_corrections,
-- organizing_first_contracts: append-only external evidence of the
-- ratification vote and the signed first contract. recorded_by and
-- corrected_by: pseudonymize; the evidence itself stays immutable.
alter table public.organizing_bargaining_ratifications drop constraint organizing_bargaining_ratifications_recorded_by_fkey;
alter table public.organizing_bargaining_ratifications alter column recorded_by drop not null;
alter table public.organizing_bargaining_ratifications add constraint organizing_bargaining_ratifications_recorded_by_fkey foreign key (recorded_by) references auth.users(id) on delete set null;
alter table public.organizing_bargaining_ratification_corrections drop constraint organizing_bargaining_ratification_correction_corrected_by_fkey;
alter table public.organizing_bargaining_ratification_corrections alter column corrected_by drop not null;
alter table public.organizing_bargaining_ratification_corrections add constraint organizing_bargaining_ratification_correction_corrected_by_fkey foreign key (corrected_by) references auth.users(id) on delete set null;
alter table public.organizing_first_contracts drop constraint organizing_first_contracts_recorded_by_fkey;
alter table public.organizing_first_contracts alter column recorded_by drop not null;
alter table public.organizing_first_contracts add constraint organizing_first_contracts_recorded_by_fkey foreign key (recorded_by) references auth.users(id) on delete set null;

-- coalition_partners, coalition_handshakes, coalition_commitments: the
-- campaign's coalition record. created_by and bridge_lead_id: pseudonymize.
alter table public.coalition_partners drop constraint coalition_partners_created_by_fkey;
alter table public.coalition_partners alter column created_by drop not null;
alter table public.coalition_partners add constraint coalition_partners_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.coalition_handshakes drop constraint coalition_handshakes_created_by_fkey;
alter table public.coalition_handshakes alter column created_by drop not null;
alter table public.coalition_handshakes add constraint coalition_handshakes_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.coalition_commitments drop constraint coalition_commitments_created_by_fkey;
alter table public.coalition_commitments alter column created_by drop not null;
alter table public.coalition_commitments add constraint coalition_commitments_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;

-- union_lifecycle_audit_events: append-only lifecycle audit. actor_id:
-- pseudonymize, as is already done for casework_audit_events.
alter table public.union_lifecycle_audit_events drop constraint union_lifecycle_audit_events_actor_id_fkey;
alter table public.union_lifecycle_audit_events alter column actor_id drop not null;
alter table public.union_lifecycle_audit_events add constraint union_lifecycle_audit_events_actor_id_fkey foreign key (actor_id) references auth.users(id) on delete set null;

-- member_learning_sessions: a training, orientation or meeting the campaign
-- held. created_by, and its membership-scoped twin, pseudonymize.
alter table public.member_learning_sessions drop constraint member_learning_sessions_created_by_fkey;
alter table public.member_learning_sessions alter column created_by drop not null;
alter table public.member_learning_sessions add constraint member_learning_sessions_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.member_learning_sessions drop constraint member_learning_sessions_creator_scope_fkey;
alter table public.member_learning_sessions add constraint member_learning_sessions_creator_scope_fkey
  foreign key (created_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (created_by);

-- member_learning_assignments: a session offered to one worker. user_id is the
-- worker's own record (cascade, exported). assigned_by and verified_by are the
-- organizers who offered and verified it, with their membership-scoped twins:
-- pseudonymize.
alter table public.member_learning_assignments drop constraint member_learning_assignments_assigned_by_fkey;
alter table public.member_learning_assignments alter column assigned_by drop not null;
alter table public.member_learning_assignments add constraint member_learning_assignments_assigned_by_fkey foreign key (assigned_by) references auth.users(id) on delete set null;
alter table public.member_learning_assignments drop constraint member_learning_assignments_verified_by_fkey;
alter table public.member_learning_assignments add constraint member_learning_assignments_verified_by_fkey foreign key (verified_by) references auth.users(id) on delete set null;
alter table public.member_learning_assignments drop constraint member_learning_assignments_assigner_scope_fkey;
alter table public.member_learning_assignments add constraint member_learning_assignments_assigner_scope_fkey
  foreign key (assigned_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (assigned_by);
alter table public.member_learning_assignments drop constraint member_learning_assignments_verifier_scope_fkey;
alter table public.member_learning_assignments add constraint member_learning_assignments_verifier_scope_fkey
  foreign key (verified_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (verified_by);

-- member_capacity_commitments: a commitment offered to one worker. Same split
-- as the learning assignments: user_id cascades; offered_by and verified_by
-- pseudonymize.
alter table public.member_capacity_commitments drop constraint member_capacity_commitments_offered_by_fkey;
alter table public.member_capacity_commitments alter column offered_by drop not null;
alter table public.member_capacity_commitments add constraint member_capacity_commitments_offered_by_fkey foreign key (offered_by) references auth.users(id) on delete set null;
alter table public.member_capacity_commitments drop constraint member_capacity_commitments_verified_by_fkey;
alter table public.member_capacity_commitments add constraint member_capacity_commitments_verified_by_fkey foreign key (verified_by) references auth.users(id) on delete set null;
alter table public.member_capacity_commitments drop constraint member_capacity_commitments_offeror_scope_fkey;
alter table public.member_capacity_commitments add constraint member_capacity_commitments_offeror_scope_fkey
  foreign key (offered_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (offered_by);
alter table public.member_capacity_commitments drop constraint member_capacity_commitments_verifier_scope_fkey;
alter table public.member_capacity_commitments add constraint member_capacity_commitments_verifier_scope_fkey
  foreign key (verified_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (verified_by);

-- member_participation_completions: the verified completion behind a
-- participation receipt. user_id cascades (exported); verified_by pseudonymizes.
-- Its source keys point at the same worker's assignment or commitment, so
-- they cascade with that record instead of blocking the worker's deletion.
alter table public.member_participation_completions drop constraint member_participation_completions_verified_by_fkey;
alter table public.member_participation_completions alter column verified_by drop not null;
alter table public.member_participation_completions add constraint member_participation_completions_verified_by_fkey foreign key (verified_by) references auth.users(id) on delete set null;
alter table public.member_participation_completions drop constraint member_participation_completions_verifier_scope_fkey;
alter table public.member_participation_completions add constraint member_participation_completions_verifier_scope_fkey
  foreign key (verified_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (verified_by);
alter table public.member_participation_completions drop constraint member_participation_completions_learning_source_fkey;
alter table public.member_participation_completions add constraint member_participation_completions_learning_source_fkey
  foreign key (learning_assignment_id, user_id, chapter_id, activity_kind, rung)
  references public.member_learning_assignments(id, user_id, chapter_id, activity_kind, rung)
  on delete cascade;
alter table public.member_participation_completions drop constraint member_participation_completions_commitment_source_fkey;
alter table public.member_participation_completions add constraint member_participation_completions_commitment_source_fkey
  foreign key (capacity_commitment_id, user_id, chapter_id, activity_kind, rung)
  references public.member_capacity_commitments(id, user_id, chapter_id, activity_kind, rung)
  on delete cascade;

-- member_participation_events: the worker's participation receipt. user_id
-- cascades (exported); verified_by pseudonymizes. Its canonical completion key
-- carries the verifier, so it follows the completion: CASCADE on delete (same
-- worker) and on update (the verifier detaching).
alter table public.member_participation_events drop constraint member_participation_events_verified_by_fkey;
alter table public.member_participation_events alter column verified_by drop not null;
alter table public.member_participation_events add constraint member_participation_events_verified_by_fkey foreign key (verified_by) references auth.users(id) on delete set null;
alter table public.member_participation_events drop constraint member_participation_events_verifier_scope_fkey;
alter table public.member_participation_events add constraint member_participation_events_verifier_scope_fkey
  foreign key (verified_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (verified_by);
alter table public.member_participation_events drop constraint member_participation_events_canonical_completion_fkey;
alter table public.member_participation_events add constraint member_participation_events_canonical_completion_fkey
  foreign key (canonical_completion_id, user_id, chapter_id, activity_kind, rung, verified_by, verified_at)
  references public.member_participation_completions(id, user_id, chapter_id, activity_kind, rung, verified_by, verified_at)
  on update cascade on delete cascade;

-- member_recognition_events: a contribution acknowledged without points.
-- user_id cascades (exported); verified_by pseudonymizes; the receipt key
-- points at the same worker's participation receipt and cascades with it.
alter table public.member_recognition_events drop constraint member_recognition_events_verified_by_fkey;
alter table public.member_recognition_events alter column verified_by drop not null;
alter table public.member_recognition_events add constraint member_recognition_events_verified_by_fkey foreign key (verified_by) references auth.users(id) on delete set null;
alter table public.member_recognition_events drop constraint member_recognition_events_verifier_scope_fkey;
alter table public.member_recognition_events add constraint member_recognition_events_verifier_scope_fkey
  foreign key (verified_by, chapter_id) references public.member_chapter_memberships(user_id, chapter_id)
  on delete set null (verified_by);
alter table public.member_recognition_events drop constraint member_recognition_events_participation_fkey;
alter table public.member_recognition_events add constraint member_recognition_events_participation_fkey
  foreign key (participation_event_id, user_id, chapter_id, recognition_kind, source_kind, source_id, canonical_completion_id)
  references public.member_participation_events(id, user_id, chapter_id, activity_kind, source_kind, source_id, canonical_completion_id)
  on delete cascade;

-- member_membership_periods, member_onboarding_steps: user_id is the worker's
-- own membership and onboarding record (already cascade, exported);
-- verified_by is already ON DELETE SET NULL and is reviewed as pseudonymize.
-- organizing_campaigns.next_action_owner_id, organizing_workers.assigned_to,
-- organizing_resistance_incidents.owner_id, organizing_bargaining_cycles.lead_id
-- and coalition_handshakes.bridge_lead_id are already ON DELETE SET NULL
-- assignment columns, reviewed as pseudonymize. private.member_recognition_
-- week_totals.user_id is the worker's weekly recognition counter (cascade).

-- ---------------------------------------------------------------------------
-- 2. Guards that admit only the nested FK detachment
-- ---------------------------------------------------------------------------

-- A referential SET NULL is itself an UPDATE. Each guard below keeps refusing
-- every ordinary write and admits one shape only: the actor column turning
-- NULL below another trigger while its Auth row is already gone, with every
-- other column unchanged.
create or replace function private.prevent_lifecycle_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and private.account_lifecycle_is_nested_auth_detachment(old.actor_id, new.actor_id)
     and (pg_catalog.to_jsonb(new) - 'actor_id')
       is not distinct from (pg_catalog.to_jsonb(old) - 'actor_id') then
    return new;
  end if;
  raise exception 'lifecycle audit is append-only' using errcode = '42501';
end;
$$;

revoke all on function private.prevent_lifecycle_audit_change()
  from public, anon, authenticated, service_role;

create or replace function private.prevent_canonical_participation_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and private.account_lifecycle_is_nested_auth_detachment(old.verified_by, new.verified_by)
     and (pg_catalog.to_jsonb(new) - 'verified_by')
       is not distinct from (pg_catalog.to_jsonb(old) - 'verified_by') then
    return new;
  end if;
  raise exception 'verified participation is immutable' using errcode = '42501';
end;
$$;

revoke all on function private.prevent_canonical_participation_update()
  from public, anon, authenticated, service_role;

create or replace function private.prevent_bargaining_evidence_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_column text := case tg_table_name
    when 'organizing_bargaining_ratification_corrections' then 'corrected_by'
    else 'recorded_by'
  end;
begin
  if tg_op = 'UPDATE'
     and private.account_lifecycle_is_nested_auth_detachment(
       (pg_catalog.to_jsonb(old) ->> actor_column)::uuid,
       (pg_catalog.to_jsonb(new) ->> actor_column)::uuid
     )
     -- execution_authorized is a stored generated column, which a BEFORE
     -- trigger sees as NULL in NEW; it derives from compared columns.
     and (pg_catalog.to_jsonb(new) - actor_column - 'execution_authorized')
       is not distinct from (pg_catalog.to_jsonb(old) - actor_column - 'execution_authorized') then
    return new;
  end if;
  raise exception 'bargaining evidence is append-only' using errcode = '42501';
end;
$$;

revoke all on function private.prevent_bargaining_evidence_change()
  from public, anon, authenticated, service_role;

-- The proposal snapshot guard is re-emitted from 20261014008000 with one
-- added arm: created_by may only change by the nested FK detachment.
create or replace function private.preserve_bargaining_proposal_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by
     and not (
       private.account_lifecycle_is_nested_auth_detachment(old.created_by, new.created_by)
       and (pg_catalog.to_jsonb(new) - 'created_by')
         is not distinct from (pg_catalog.to_jsonb(old) - 'created_by')
     ) then
    raise exception 'proposal version content is immutable' using errcode = '22023';
  end if;
  if new.cycle_id is distinct from old.cycle_id
     or new.campaign_id is distinct from old.campaign_id
     or new.chapter_id is distinct from old.chapter_id
     or new.parent_proposal_id is distinct from old.parent_proposal_id
     or new.relation_kind is distinct from old.relation_kind
     or new.record_kind is distinct from old.record_kind
     or new.included_proposal_ids is distinct from old.included_proposal_ids
     or new.document_sha256 is distinct from old.document_sha256
     or new.topic is distinct from old.topic
     or new.title is distinct from old.title
     or new.side is distinct from old.side
     or new.version is distinct from old.version
     or new.member_summary is distinct from old.member_summary
     or new.internal_notes is distinct from old.internal_notes
     or new.created_at is distinct from old.created_at
     or new.create_request_id is distinct from old.create_request_id then
    raise exception 'proposal version content is immutable' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.preserve_bargaining_proposal_snapshot()
  from public, anon, authenticated, service_role;

-- A completed assignment or commitment required a verifier in its status
-- CHECK. The CHECK keeps the state and timestamps; only the historical
-- verifier may be absent after deletion. The trigger below still requires a
-- verifier whenever application code writes the completed state.
alter table public.member_learning_assignments
  drop constraint member_learning_assignments_check1,
  add constraint member_learning_assignments_check1 check (
    (status = 'offered'
      and responded_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status in ('accepted', 'declined')
      and responded_at is not null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'completed'
      and responded_at is not null
      and completed_at is not null
      and verified_at is not null)
  );

alter table public.member_capacity_commitments
  drop constraint member_capacity_commitments_check1,
  add constraint member_capacity_commitments_check1 check (
    (status = 'offered'
      and responded_at is null
      and started_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'accepted'
      and responded_at is not null
      and started_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'declined'
      and responded_at is not null
      and started_at is null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'in_progress'
      and responded_at is not null
      and started_at is not null
      and completed_at is null
      and verified_by is null
      and verified_at is null)
    or (status = 'completed'
      and responded_at is not null
      and completed_at is not null
      and verified_at is not null)
  );

create function private.guard_participation_source_verifier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'completed' and new.verified_by is null then
    if tg_op = 'UPDATE' and old.status = 'completed' then
      if old.verified_by is null then
        return new;
      end if;
      -- activity_kind and rung are stored generated columns, which a BEFORE
      -- trigger sees as NULL in NEW; they derive from compared columns.
      if private.account_lifecycle_is_nested_auth_detachment(old.verified_by, new.verified_by)
         and (pg_catalog.to_jsonb(new) - 'verified_by' - 'activity_kind' - 'rung')
           is not distinct from (pg_catalog.to_jsonb(old) - 'verified_by' - 'activity_kind' - 'rung') then
        return new;
      end if;
      raise exception 'participation verifier attribution cannot be detached' using errcode = '42501';
    end if;
    raise exception 'completed participation requires a verifier' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_participation_source_verifier()
  from public, anon, authenticated, service_role;

create trigger member_learning_assignments_guard_verifier
  before insert or update on public.member_learning_assignments
  for each row execute function private.guard_participation_source_verifier();
create trigger member_capacity_commitments_guard_verifier
  before insert or update on public.member_capacity_commitments
  for each row execute function private.guard_participation_source_verifier();

-- ---------------------------------------------------------------------------
-- 3. Manifest rows
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_projection, export_inventory_basis, export_projection_version, export_domain,
   export_columns, exclusion_reason, note, reviewed_at)
values
  -- The worker's own records: cascade.
  ('public', 'member_membership_periods', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_membership_periods',
   array['id','user_id','chapter_id','joined_on','left_on','date_precision','status','end_reason','source_kind','verified_at','created_at']::text[], null,
   'The worker''s own campaign membership period. Exported without the verifier; deleted with the account.', date '2026-10-15'),
  ('public', 'member_onboarding_steps', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_onboarding_steps',
   array['id','membership_period_id','user_id','chapter_id','step_key','due_on','status','source_kind','completed_at','created_at']::text[], null,
   'The worker''s own onboarding steps. Exported without the verifier or source record id; deleted with the account.', date '2026-10-15'),
  ('public', 'member_participation_events', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_participation_events',
   array['id','user_id','chapter_id','rung','activity_kind','source_kind','occurred_at','created_at']::text[], null,
   'The worker''s own participation receipts. Exported without the verifier; deleted with the account.', date '2026-10-15'),
  ('public', 'member_participation_completions', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_participation_completions',
   array['id','user_id','chapter_id','activity_kind','rung','learning_assignment_id','capacity_commitment_id','occurred_at','verified_at','created_at']::text[], null,
   'The worker''s own verified completions. Exported without the verifier or request key; deleted with the account.', date '2026-10-15'),
  ('public', 'member_learning_assignments', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_learning_assignments',
   array['id','session_id','user_id','chapter_id','learning_kind','activity_kind','rung','status','responded_at','completed_at','verified_at','created_at']::text[], null,
   'Trainings, orientations and meetings offered to the worker and their answers. Exported without the organizers'' identities or request keys; deleted with the account.', date '2026-10-15'),
  ('public', 'member_capacity_commitments', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_capacity_commitments',
   array['id','user_id','chapter_id','commitment_kind','activity_kind','rung','title','status','responded_at','started_at','completed_at','verified_at','created_at']::text[], null,
   'Commitments offered to the worker and their answers. Exported without the organizers'' identities or request keys; deleted with the account.', date '2026-10-15'),
  ('public', 'member_recognition_events', 'user_id', 'cascade', 'included',
   'additional_domains', 'auth_user_fk', 1, 'additionalDomains.member_recognition_events',
   array['id','user_id','chapter_id','recognition_kind','source_kind','source_label','occurred_at','verified_at','created_at']::text[], null,
   'Contributions acknowledged for the worker, without points. Exported without the verifier; deleted with the account.', date '2026-10-15'),
  ('private', 'member_recognition_week_totals', 'user_id', 'cascade', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Weekly recognition cap counter derived from the exported recognition records; control state, not content the worker authored.',
   'Deleted with the account; its per-kind counters cascade with it.', date '2026-10-15'),
  ('public', 'organizing_campaign_assignments', 'user_id', 'cascade', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Campaign access assignment granted by staff; an authorization record, not content the person authored. The person''s hats are exported in account.roles.',
   'Deleted with the account, so no campaign keeps a deleted person on its team.', date '2026-10-15'),
  -- Actor, author and assignment attribution on shared campaign records: pseudonymize.
  ('public', 'union_employers', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of a shared campaign employer record; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the employer record stays with the campaign.', date '2026-10-15'),
  ('public', 'union_worksites', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of a shared campaign worksite record; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the worksite record stays with the campaign.', date '2026-10-15'),
  ('public', 'organizing_campaigns', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of the shared campaign record; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the campaign and its history survive.', date '2026-10-15'),
  ('public', 'organizing_campaigns', 'owner_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff assignment of campaign ownership; an assignment, not content the person authored.',
   'Installed action is ON DELETE SET NULL; the campaign waits for a new owner.', date '2026-10-15'),
  ('public', 'organizing_campaigns', 'next_action_owner_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff assignment of the campaign''s next action; an assignment, not content the person authored.',
   'Installed action is ON DELETE SET NULL; the next action stays unassigned.', date '2026-10-15'),
  ('public', 'organizing_campaign_assignments', 'granted_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff attribution of a campaign access grant; security attribution, not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the assignment survives without its grantor.', date '2026-10-15'),
  ('public', 'organizing_stage_events', 'actor_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Actor on the campaign''s shared stage history; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the stage history survives.', date '2026-10-15'),
  ('public', 'organizing_workers', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who recorded a support-map row about another worker; exporting it would hand out other workers'' support data.',
   'Installed action is ON DELETE SET NULL; the row stays under its private alias with no organizer identity.', date '2026-10-15'),
  ('public', 'organizing_workers', 'assigned_to', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer assigned to follow up a support-map row about another worker; an assignment over other workers'' support data.',
   'Installed action is ON DELETE SET NULL; the row returns to the unassigned pool.', date '2026-10-15'),
  ('public', 'organizing_contact_events', 'actor_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer on a one-on-one contact note about another worker; exporting it would hand out that worker''s contact history.',
   'Installed action is ON DELETE SET NULL; the contact history survives without the organizer identity.', date '2026-10-15'),
  ('public', 'organizing_resistance_incidents', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Reporter of a shared employer-resistance incident; campaign evidence, not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the incident survives for the campaign without its reporter.', date '2026-10-15'),
  ('public', 'organizing_resistance_incidents', 'owner_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff assignment of an employer-resistance incident; an assignment, not content the person authored.',
   'Installed action is ON DELETE SET NULL; the incident stays unassigned.', date '2026-10-15'),
  ('public', 'organizing_resistance_evidence', 'uploaded_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Uploader of shared resistance evidence; campaign evidence with storage references, not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the evidence survives without its uploader.', date '2026-10-15'),
  ('public', 'organizing_bargaining_cycles', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of the shared first-contract bargaining cycle; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the cycle survives.', date '2026-10-15'),
  ('public', 'organizing_bargaining_cycles', 'lead_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff assignment of the bargaining lead; an assignment, not content the person authored.',
   'Installed action is ON DELETE SET NULL; the cycle waits for a new lead.', date '2026-10-15'),
  ('public', 'organizing_bargaining_proposals', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of a shared bargaining proposal version; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the proposal snapshot stays immutable otherwise.', date '2026-10-15'),
  ('public', 'organizing_bargaining_sessions', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of a shared bargaining session record; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the session record survives.', date '2026-10-15'),
  ('public', 'organizing_bargaining_ratifications', 'recorded_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff who recorded external ratification evidence; append-only campaign evidence, not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the append-only guard admits only that detachment.', date '2026-10-15'),
  ('public', 'organizing_bargaining_ratification_corrections', 'corrected_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff who recorded a ratification correction; append-only campaign evidence, not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the append-only guard admits only that detachment.', date '2026-10-15'),
  ('public', 'organizing_first_contracts', 'recorded_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff who recorded the signed first contract; append-only campaign evidence, not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the append-only guard admits only that detachment.', date '2026-10-15'),
  ('public', 'coalition_partners', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of a shared coalition partner record; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the partner record survives.', date '2026-10-15'),
  ('public', 'coalition_handshakes', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of a shared coalition handshake; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the handshake survives.', date '2026-10-15'),
  ('public', 'coalition_handshakes', 'bridge_lead_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Staff assignment of the coalition bridge lead; an assignment, not content the person authored.',
   'Installed action is ON DELETE SET NULL; the handshake waits for a new bridge lead.', date '2026-10-15'),
  ('public', 'coalition_commitments', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Authorship of a shared coalition commitment; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the commitment survives.', date '2026-10-15'),
  ('public', 'union_lifecycle_audit_events', 'actor_id', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Actor on the append-only lifecycle audit; security and control attribution, not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the append-only guard admits only that detachment.', date '2026-10-15'),
  ('public', 'member_learning_sessions', 'created_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who scheduled a shared training, orientation or meeting; not caller-owned portable content.',
   'Installed action is ON DELETE SET NULL; the session and its attendees'' records survive.', date '2026-10-15'),
  ('public', 'member_learning_assignments', 'assigned_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who offered a session to another worker; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the worker''s assignment survives.', date '2026-10-15'),
  ('public', 'member_learning_assignments', 'verified_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who verified another worker''s completion; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the completed state survives and new completions still require a verifier.', date '2026-10-15'),
  ('public', 'member_capacity_commitments', 'offered_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who offered a commitment to another worker; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the worker''s commitment survives.', date '2026-10-15'),
  ('public', 'member_capacity_commitments', 'verified_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who verified another worker''s commitment; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the completed state survives and new completions still require a verifier.', date '2026-10-15'),
  ('public', 'member_participation_completions', 'verified_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who verified another worker''s participation; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the immutability guard admits only that detachment.', date '2026-10-15'),
  ('public', 'member_participation_events', 'verified_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who verified another worker''s participation receipt; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL, and the canonical completion key cascades the same detachment; the immutability guard admits only that.', date '2026-10-15'),
  ('public', 'member_recognition_events', 'verified_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who verified another worker''s acknowledged contribution; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the acknowledgement survives with the worker.', date '2026-10-15'),
  ('public', 'member_membership_periods', 'verified_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who verified another worker''s membership period; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the period survives with the worker.', date '2026-10-15'),
  ('public', 'member_onboarding_steps', 'verified_by', 'pseudonymize', 'excluded_with_reason',
   null, 'auth_user_fk', null, null, null,
   'Organizer who verified another worker''s onboarding step; exporting it would hand out that worker''s record.',
   'Installed action is ON DELETE SET NULL; the step survives with the worker.', date '2026-10-15');

-- ---------------------------------------------------------------------------
-- 4. Restrictive keys below auth.users
-- ---------------------------------------------------------------------------

insert into private.account_lifecycle_transitive_fk_manifest
  (parent_schema_name, parent_table_name, schema_name, table_name, constraint_name,
   delete_disposition, set_null_columns, review_reason, reviewed_at)
values
  ('public', 'member_chapter_memberships', 'public', 'member_learning_sessions', 'member_learning_sessions_creator_scope_fkey',
   'pseudonymize', array['created_by'],
   'The organizer''s campaign membership is deleted with their account; only the creator link detaches and the session stays with the campaign.', date '2026-10-15'),
  ('public', 'member_chapter_memberships', 'public', 'member_learning_assignments', 'member_learning_assignments_assigner_scope_fkey',
   'pseudonymize', array['assigned_by'],
   'The offering organizer''s membership is deleted with their account; only that link detaches and the worker''s assignment survives.', date '2026-10-15'),
  ('public', 'member_chapter_memberships', 'public', 'member_learning_assignments', 'member_learning_assignments_verifier_scope_fkey',
   'pseudonymize', array['verified_by'],
   'The verifying organizer''s membership is deleted with their account; only that link detaches and the worker''s completion survives.', date '2026-10-15'),
  ('public', 'member_chapter_memberships', 'public', 'member_capacity_commitments', 'member_capacity_commitments_offeror_scope_fkey',
   'pseudonymize', array['offered_by'],
   'The offering organizer''s membership is deleted with their account; only that link detaches and the worker''s commitment survives.', date '2026-10-15'),
  ('public', 'member_chapter_memberships', 'public', 'member_capacity_commitments', 'member_capacity_commitments_verifier_scope_fkey',
   'pseudonymize', array['verified_by'],
   'The verifying organizer''s membership is deleted with their account; only that link detaches and the worker''s commitment survives.', date '2026-10-15'),
  ('public', 'member_chapter_memberships', 'public', 'member_participation_completions', 'member_participation_completions_verifier_scope_fkey',
   'pseudonymize', array['verified_by'],
   'The verifying organizer''s membership is deleted with their account; only that link detaches and the worker''s completion survives.', date '2026-10-15'),
  ('public', 'member_chapter_memberships', 'public', 'member_participation_events', 'member_participation_events_verifier_scope_fkey',
   'pseudonymize', array['verified_by'],
   'The verifying organizer''s membership is deleted with their account; only that link detaches and the worker''s receipt survives.', date '2026-10-15'),
  ('public', 'member_chapter_memberships', 'public', 'member_recognition_events', 'member_recognition_events_verifier_scope_fkey',
   'pseudonymize', array['verified_by'],
   'The verifying organizer''s membership is deleted with their account; only that link detaches and the worker''s acknowledgement survives.', date '2026-10-15'),
  ('public', 'member_learning_assignments', 'public', 'member_participation_completions', 'member_participation_completions_learning_source_fkey',
   'cascade', '{}'::text[],
   'The completion and its source assignment belong to the same worker (the key carries user_id); both are that worker''s own records and go together.', date '2026-10-15'),
  ('public', 'member_capacity_commitments', 'public', 'member_participation_completions', 'member_participation_completions_commitment_source_fkey',
   'cascade', '{}'::text[],
   'The completion and its source commitment belong to the same worker (the key carries user_id); both are that worker''s own records and go together.', date '2026-10-15'),
  ('public', 'member_participation_completions', 'public', 'member_participation_events', 'member_participation_events_canonical_completion_fkey',
   'cascade', '{}'::text[],
   'The receipt and its canonical completion belong to the same worker; the receipt goes with the completion, and ON UPDATE CASCADE carries a verifier detachment to the receipt.', date '2026-10-15'),
  ('public', 'member_participation_events', 'public', 'member_recognition_events', 'member_recognition_events_participation_fkey',
   'cascade', '{}'::text[],
   'The acknowledgement and its participation receipt belong to the same worker; the acknowledgement goes with the receipt.', date '2026-10-15');

-- ---------------------------------------------------------------------------
-- 5. Export: hand-shaped projections of the worker's own records
-- ---------------------------------------------------------------------------

create function private.account_lifecycle_export_member_membership_periods(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'user_id', t.user_id, 'chapter_id', t.chapter_id, 'joined_on', t.joined_on,
    'left_on', t.left_on, 'date_precision', t.date_precision, 'status', t.status,
    'end_reason', t.end_reason, 'source_kind', t.source_kind, 'verified_at', t.verified_at,
    'created_at', t.created_at) order by t.created_at, t.id), '[]'::jsonb)
  from public.member_membership_periods t where t.user_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_onboarding_steps(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'membership_period_id', t.membership_period_id, 'user_id', t.user_id,
    'chapter_id', t.chapter_id, 'step_key', t.step_key, 'due_on', t.due_on, 'status', t.status,
    'source_kind', t.source_kind, 'completed_at', t.completed_at,
    'created_at', t.created_at) order by t.created_at, t.id), '[]'::jsonb)
  from public.member_onboarding_steps t where t.user_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_participation_events(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'user_id', t.user_id, 'chapter_id', t.chapter_id, 'rung', t.rung,
    'activity_kind', t.activity_kind, 'source_kind', t.source_kind, 'occurred_at', t.occurred_at,
    'created_at', t.created_at) order by t.occurred_at, t.id), '[]'::jsonb)
  from public.member_participation_events t where t.user_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_participation_completions(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'user_id', t.user_id, 'chapter_id', t.chapter_id, 'activity_kind', t.activity_kind,
    'rung', t.rung, 'learning_assignment_id', t.learning_assignment_id,
    'capacity_commitment_id', t.capacity_commitment_id, 'occurred_at', t.occurred_at,
    'verified_at', t.verified_at, 'created_at', t.created_at) order by t.occurred_at, t.id), '[]'::jsonb)
  from public.member_participation_completions t where t.user_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_learning_assignments(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'session_id', t.session_id, 'user_id', t.user_id, 'chapter_id', t.chapter_id,
    'learning_kind', t.learning_kind, 'activity_kind', t.activity_kind, 'rung', t.rung,
    'status', t.status, 'responded_at', t.responded_at, 'completed_at', t.completed_at,
    'verified_at', t.verified_at, 'created_at', t.created_at) order by t.created_at, t.id), '[]'::jsonb)
  from public.member_learning_assignments t where t.user_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_capacity_commitments(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'user_id', t.user_id, 'chapter_id', t.chapter_id,
    'commitment_kind', t.commitment_kind, 'activity_kind', t.activity_kind, 'rung', t.rung,
    'title', t.title, 'status', t.status, 'responded_at', t.responded_at,
    'started_at', t.started_at, 'completed_at', t.completed_at, 'verified_at', t.verified_at,
    'created_at', t.created_at) order by t.created_at, t.id), '[]'::jsonb)
  from public.member_capacity_commitments t where t.user_id = p_caller;
$export$;

create function private.account_lifecycle_export_member_recognition_events(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id, 'user_id', t.user_id, 'chapter_id', t.chapter_id,
    'recognition_kind', t.recognition_kind, 'source_kind', t.source_kind,
    'source_label', t.source_label, 'occurred_at', t.occurred_at, 'verified_at', t.verified_at,
    'created_at', t.created_at) order by t.occurred_at, t.id), '[]'::jsonb)
  from public.member_recognition_events t where t.user_id = p_caller;
$export$;

revoke all on function private.account_lifecycle_export_member_membership_periods(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_onboarding_steps(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_participation_events(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_participation_completions(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_learning_assignments(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_capacity_commitments(uuid) from public, anon, authenticated, service_role;
revoke all on function private.account_lifecycle_export_member_recognition_events(uuid) from public, anon, authenticated, service_role;

-- Re-emitted from the installed definition (20261009000500) with the seven
-- organizing lifecycle domains added; every other key is unchanged.
create or replace function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_space_notification_settings', private.account_lifecycle_export_chapter_space_notification_settings(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_event_contact_links', private.account_lifecycle_export_member_event_contact_links(p_caller), 'member_event_contact_opt_ins', private.account_lifecycle_export_member_event_contact_opt_ins(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_profile_details', private.account_lifecycle_export_member_profile_details(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller), 'steward_contact_preferences', private.account_lifecycle_export_steward_contact_preferences(p_caller), 'steward_private_reminders', private.account_lifecycle_export_steward_private_reminders(p_caller),
    'member_capacity_commitments', private.account_lifecycle_export_member_capacity_commitments(p_caller), 'member_learning_assignments', private.account_lifecycle_export_member_learning_assignments(p_caller), 'member_membership_periods', private.account_lifecycle_export_member_membership_periods(p_caller), 'member_onboarding_steps', private.account_lifecycle_export_member_onboarding_steps(p_caller), 'member_participation_completions', private.account_lifecycle_export_member_participation_completions(p_caller), 'member_participation_events', private.account_lifecycle_export_member_participation_events(p_caller), 'member_recognition_events', private.account_lifecycle_export_member_recognition_events(p_caller)
  );
$$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Reviewed trigger surface
-- ---------------------------------------------------------------------------

-- The four guards above change hash, and the two verifier guards and their
-- function join the surface. Hashes come from the surface itself.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'public'
        and (s.table_name, s.object_name) in (
          ('member_learning_assignments', 'member_learning_assignments_guard_verifier'),
          ('member_capacity_commitments', 'member_capacity_commitments_guard_verifier')))
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
        'prevent_lifecycle_audit_change()',
        'prevent_canonical_participation_update()',
        'prevent_bargaining_evidence_change()',
        'preserve_bargaining_proposal_snapshot()',
        'guard_participation_source_verifier()'))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_unionground_account_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the Union Ground dispositions: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after the Union Ground dispositions: %',
      (select pg_catalog.string_agg(i.table_name || '.' || i.user_column || ' ' || i.inventory_issue, ', ')
       from private.account_lifecycle_unmanaged_restrictive_fks() i);
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after the Union Ground dispositions: %',
      (select pg_catalog.string_agg(i.table_name || '.' || i.user_column || ' ' || i.inventory_issue, ', ')
       from private.account_lifecycle_unmanaged_export_fks() i);
  end if;
end;
$assert_unionground_account_lifecycle$;

notify pgrst, 'reload schema';

commit;
