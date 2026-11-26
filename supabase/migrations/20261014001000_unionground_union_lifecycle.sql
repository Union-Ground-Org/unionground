-- REQ-UG-UNION-LIFECYCLE-20260723
--
-- Union Ground lifecycle spine. This migration is additive:
--
--   organize -> recognize/elect -> certify -> bargain -> first contract
--            -> engage -> grow -> cooperate
--
-- Sensitive tables have no client DML and no direct client SELECT. The
-- browser receives one role-shaped, aggregate workspace projection. Bounded
-- SECURITY DEFINER RPCs derive actor and chapter from auth.uid(), validate
-- state, and write an audit row in the same transaction.
--
-- Reconciled with the current schema on 2026-10-14. This file was written in
-- July 2026 against an earlier schema and originally ran at 20260724035000; it
-- now runs after every earlier migration. No live database had applied it, so
-- the file was rewritten in place rather than followed by a corrective
-- migration.
--
-- What changed against the July text, and why:
--
-- * Staff scope. The July section 1 made member_profiles.chapter_id and
--   member_roles.chapter_id NOT NULL, keyed member_roles to
--   member_profiles(id, chapter_id), added a chapter column and trigger to
--   member_admin_audit, and rewrote grant_member_role, revoke_member_role,
--   admin_search_members, get_staff_roster, get_admin_audit,
--   authorize_mfa_reset and record_mfa_reset to be chapter-scoped. The
--   shared tenant model has since been built for exactly that purpose
--   (member_chapter_memberships, member_role_chapters,
--   organization_role_grants, private.member_has_chapter_role, the
--   organization-scoped member_admin_audit policy, and tenant-scoped admin
--   and MFA-reset RPCs), and retired grant_member_role/revoke_member_role in
--   20260917050000_retire_superseded_role_grant_rpcs.sql. Re-applying the
--   July section would resurrect retired definer RPCs, overwrite newer
--   tenant-scoped bodies with older ones, and break the
--   multi-chapter identity (a member's selected chapter changes, and sign-up
--   without an invitation leaves chapter_id NULL by design). Those objects
--   already serve this purpose, so they are reused unchanged.
--   Only the Organizer hat is added to them, below.
--
-- * Member scope. Lifecycle rows that the July text tied to
--   member_profiles(id, chapter_id) now reference
--   member_chapter_memberships(user_id, chapter_id): that table, not the
--   mutable selected chapter on member_profiles, is the record that a person
--   belongs to a chapter. member_role_chapters uses the same key.
--
-- * Roles. Lifecycle authority reads the chapter-scoped
--   member_role_chapters (same user_id/role/chapter_id columns as the July
--   member_roles reads) and requires an active chapter membership plus
--   private.member_has_chapter_role, so the existing organization
--   membership and staff-MFA policy also bind lifecycle writers. Legacy
--   member_roles.chapter_id is not read: it records only the first chapter a
--   role was granted in and can outlive a chapter-level revocation.
--
-- * Coalition handshakes. The existing public.chapter_handshakes is a
--   chapter-to-chapter data-sharing agreement with its own RPCs and app code.
--   The July version of this file had a table of the same name that records a
--   handshake with an outside coalition partner, a different object. It is
--   created here as public.coalition_handshakes; the existing table is
--   untouched.
--
-- * New-member bootstrap. The existing private.handle_new_member binds a
--   chapter only through a matching, accepting invitation and no longer
--   fabricates history, which meets the July intent (chapter never from
--   user-editable metadata, no fake records) more strictly than the July
--   default-chapter rule. It is kept. Section 11 adds the lifecycle's
--   membership period, onboarding steps, and single welcome notification as
--   a separate AFTER INSERT trigger that runs after it.
--
-- * Account case graph. The lifecycle tables reference auth.users and
--   member_chapter_memberships, so they fall inside the account deletion
--   lock protocol. Every lifecycle writer in this file and in
--   20261014002000-009000 takes private.lock_case_graph() as its first
--   statement (the standard wrapper form), and
--   20261014012000_unionground_account_case_graph.sql installs the table
--   gates.

-- 1. Organizer hat in the shared role model --------------------------------

-- Additive: widen the two chapter-role tables that lifecycle authority reads
-- so the Organizer hat (internal id 'organizer') can be held. Every existing
-- role remains valid. Organization-wide grants are not widened: lifecycle
-- authority is chapter-scoped.
alter table public.member_roles drop constraint member_roles_role_check;
alter table public.member_roles
  add constraint member_roles_role_check
  check (role in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp'));

alter table public.member_role_chapters drop constraint member_role_chapters_role_check;
alter table public.member_role_chapters
  add constraint member_role_chapters_role_check
  check (role in ('steward', 'organizer', 'coordinator', 'advisor', 'admin', 'vp'));

-- public.set_member_chapter_role is the scope-aware role command
-- (the admin command center's writer). Its body is reused verbatim; only the
-- accepted-role list gains 'organizer'. The edit is applied to the live
-- definition and refuses to run if the installed list no longer matches, so
-- a later change cannot be silently overwritten by an older copy.
do $$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'public.set_member_chapter_role(uuid, text, text, boolean)'::regprocedure
  );
  old_list constant text :=
    'p_role not in (''steward'', ''coordinator'', ''advisor'', ''admin'', ''vp'')';
  new_list constant text :=
    'p_role not in (''steward'', ''organizer'', ''coordinator'', ''advisor'', ''admin'', ''vp'')';
begin
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_list, '')))
     / pg_catalog.length(old_list) <> 1 then
    raise exception 'set_member_chapter_role role list changed upstream; reconcile the Organizer hat by hand';
  end if;
  execute pg_catalog.replace(definition, old_list, new_list);
end
$$;

-- 2. Lifecycle, worksite, and private organizing records --------------------

create table public.union_employers (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete restrict,
  legal_name text not null check (pg_catalog.char_length(legal_name) between 2 and 180),
  display_name text not null check (pg_catalog.char_length(display_name) between 2 and 120),
  sector text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chapter_id)
);

create table public.union_worksites (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete restrict,
  employer_id uuid not null,
  name text not null check (pg_catalog.char_length(name) between 2 and 160),
  broad_location text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chapter_id),
  unique (id, chapter_id, employer_id),
  constraint union_worksites_employer_scope_fkey
    foreign key (employer_id, chapter_id)
    references public.union_employers(id, chapter_id) on delete restrict
);

create table public.organizing_campaigns (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete restrict,
  employer_id uuid not null,
  primary_worksite_id uuid not null,
  name text not null check (pg_catalog.char_length(name) between 3 and 160),
  proposed_unit text not null check (pg_catalog.char_length(proposed_unit) between 3 and 500),
  representation_path text not null default 'undecided'
    check (representation_path in ('undecided', 'voluntary_recognition', 'election')),
  stage text not null default 'lead'
    check (stage in ('lead', 'committee', 'cards', 'petition', 'election', 'recognition', 'certification', 'bargaining', 'first_contract', 'established')),
  status text not null default 'active' check (status in ('active', 'paused', 'closed')),
  outcome text check (outcome is null or outcome in ('established', 'withdrawn', 'lost', 'other')),
  outcome_reason text check (outcome_reason is null or pg_catalog.char_length(outcome_reason) <= 1000),
  closed_at timestamptz,
  stage_started_at timestamptz not null default now(),
  target_date date,
  eligible_estimate integer check (
    eligible_estimate is null or eligible_estimate between 0 and 10000000
  ),
  eligible_source text,
  eligible_as_of date,
  next_action text check (next_action is null or pg_catalog.char_length(next_action) <= 600),
  next_action_owner_id uuid references auth.users(id) on delete set null,
  next_action_due_at timestamptz,
  owner_id uuid not null references auth.users(id) on delete restrict,
  revision integer not null default 1 check (revision > 0),
  create_request_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chapter_id),
  unique (created_by, chapter_id, create_request_id),
  check ((status = 'closed') = (closed_at is not null)),
  check ((status = 'closed') = (outcome is not null)),
  check ((stage = 'established') = (status = 'closed' and outcome = 'established')),
  constraint organizing_campaigns_employer_scope_fkey
    foreign key (employer_id, chapter_id)
    references public.union_employers(id, chapter_id) on delete restrict,
  constraint organizing_campaigns_worksite_scope_fkey
    foreign key (primary_worksite_id, chapter_id, employer_id)
    references public.union_worksites(id, chapter_id, employer_id) on delete restrict
);

create table public.organizing_campaign_assignments (
  campaign_id uuid not null,
  chapter_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  assignment_role text not null check (assignment_role in ('lead_organizer', 'organizer', 'coordinator', 'legal_reviewer', 'viewer')),
  status text not null default 'active' check (status in ('active', 'paused', 'revoked')),
  granted_by uuid not null references auth.users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (campaign_id, user_id, assignment_role),
  check ((status = 'revoked') = (revoked_at is not null)),
  constraint organizing_campaign_assignments_campaign_scope_fkey
    foreign key (campaign_id, chapter_id)
    references public.organizing_campaigns(id, chapter_id) on delete cascade,
  constraint organizing_campaign_assignments_member_scope_fkey
    foreign key (user_id, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id) on delete cascade
);

create table public.organizing_stage_events (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null,
  chapter_id text not null,
  from_stage text,
  to_stage text not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  source_kind text not null default 'staff_verified'
    check (source_kind in ('staff_verified', 'document_verified', 'official_agency', 'legacy_import')),
  note text check (note is null or pg_catalog.char_length(note) <= 1000),
  occurred_at timestamptz not null default now(),
  constraint organizing_stage_events_campaign_scope_fkey
    foreign key (campaign_id, chapter_id)
    references public.organizing_campaigns(id, chapter_id) on delete cascade
);

create table public.organizing_work_areas (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null,
  chapter_id text not null,
  name text not null check (pg_catalog.char_length(name) between 1 and 120),
  shift text,
  eligible_estimate integer check (eligible_estimate is null or eligible_estimate >= 0),
  contacted_count integer not null default 0 check (contacted_count >= 0),
  committee_count integer not null default 0 check (committee_count >= 0),
  issue_themes text[] not null default '{}',
  source_as_of date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, campaign_id, chapter_id),
  check (eligible_estimate is null or contacted_count <= eligible_estimate),
  check (eligible_estimate is null or committee_count <= eligible_estimate),
  check (committee_count <= contacted_count),
  constraint organizing_work_areas_campaign_scope_fkey
    foreign key (campaign_id, chapter_id)
    references public.organizing_campaigns(id, chapter_id) on delete cascade
);

-- Private worker/contact facts. No direct grants are created for either table.
create table public.organizing_workers (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null,
  chapter_id text not null,
  work_area_id uuid,
  private_alias text not null check (pg_catalog.char_length(private_alias) between 1 and 80),
  employment_status text not null default 'unknown'
    check (employment_status in ('unknown', 'active', 'leave', 'separated')),
  eligibility text not null default 'unknown'
    check (eligibility in ('unknown', 'eligible', 'ineligible', 'disputed')),
  contact_stage text not null default 'identified'
    check (contact_stage in ('identified', 'attempting_contact', 'contacted', 'one_on_one', 'assessed', 'engaged')),
  support_position text not null default 'unknown'
    check (support_position in ('unknown', 'leader', 'supporter', 'undecided', 'opposed')),
  confidence text not null default 'low' check (confidence in ('low', 'medium', 'high')),
  consent_to_contact boolean not null default false,
  assigned_to uuid references auth.users(id) on delete set null,
  next_contact_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizing_workers_campaign_scope_fkey
    foreign key (campaign_id, chapter_id)
    references public.organizing_campaigns(id, chapter_id) on delete cascade,
  constraint organizing_workers_area_scope_fkey
    foreign key (work_area_id, campaign_id, chapter_id)
    references public.organizing_work_areas(id, campaign_id, chapter_id) on delete restrict
);

create table public.organizing_contact_events (
  id uuid primary key default extensions.gen_random_uuid(),
  worker_id uuid not null references public.organizing_workers(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete restrict,
  channel text not null check (channel in ('in_person', 'phone', 'sms', 'email', 'video', 'other')),
  outcome text not null check (outcome in ('completed', 'no_answer', 'declined', 'reschedule', 'unsafe_channel', 'other')),
  factual_note text check (factual_note is null or pg_catalog.char_length(factual_note) <= 2000),
  occurred_at timestamptz not null,
  next_action_at timestamptz,
  created_at timestamptz not null default now()
);

-- 3. Resistance, representation, and bargaining -----------------------------

create table public.organizing_resistance_incidents (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null,
  chapter_id text not null,
  reference text not null unique,
  title text not null check (pg_catalog.char_length(title) between 3 and 180),
  category text not null
    check (category in ('surveillance', 'interrogation', 'threat', 'captive_audience', 'retaliation', 'discipline', 'discharge', 'delay', 'unilateral_change', 'other')),
  severity text not null default 'standard' check (severity in ('monitor', 'standard', 'high', 'immediate')),
  factual_summary text not null check (pg_catalog.char_length(factual_summary) between 3 and 4000),
  occurred_on date,
  reported_on date not null default current_date,
  source_kind text not null
    check (source_kind in ('worker_report', 'steward_report', 'organizer_note', 'bargaining_record', 'document', 'other')),
  status text not null default 'reported'
    check (status in ('reported', 'triaged', 'response_planned', 'monitoring', 'resolved', 'closed')),
  legal_review_status text not null default 'not_requested'
    check (legal_review_status in ('not_requested', 'consider_review', 'requested', 'under_review', 'not_referred', 'referred')),
  agency text,
  charge_number text,
  charge_status text
    check (charge_status is null or charge_status in ('not_filed', 'considering', 'filed', 'investigation', 'hearing', 'settlement', 'decision', 'appeal', 'closed')),
  next_action text check (next_action is null or pg_catalog.char_length(next_action) <= 600),
  next_deadline_at timestamptz,
  owner_id uuid references auth.users(id) on delete set null,
  evidence_count integer not null default 0 check (evidence_count >= 0),
  resolution text check (resolution is null or pg_catalog.char_length(resolution) <= 2000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizing_resistance_campaign_scope_fkey
    foreign key (campaign_id, chapter_id)
    references public.organizing_campaigns(id, chapter_id) on delete cascade
);

create table public.organizing_resistance_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  incident_id uuid not null references public.organizing_resistance_incidents(id) on delete cascade,
  evidence_type text not null
    check (evidence_type in ('document', 'email', 'message', 'photo', 'audio', 'video', 'policy', 'witness_statement', 'agency_document', 'other')),
  title text not null check (pg_catalog.char_length(title) between 1 and 160),
  storage_object_id text,
  mime_type text,
  file_size bigint check (file_size is null or file_size >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  uploaded_at timestamptz not null default now()
);

create table public.organizing_bargaining_cycles (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null unique,
  chapter_id text not null,
  title text not null check (pg_catalog.char_length(title) between 3 and 160),
  phase text not null default 'preparing'
    check (phase in ('preparing', 'proposal_development', 'at_table', 'mediation', 'fact_finding', 'impasse', 'tentative_agreement', 'ratification', 'execution', 'complete')),
  bargaining_started_on date,
  target_first_contract_on date,
  first_contract_signed_on date,
  survey_return_rate numeric(5,2) check (survey_return_rate is null or survey_return_rate between 0 and 100),
  lead_id uuid references auth.users(id) on delete set null,
  next_action text check (next_action is null or pg_catalog.char_length(next_action) <= 600),
  next_deadline_at timestamptz,
  revision integer not null default 1,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizing_bargaining_campaign_scope_fkey
    foreign key (campaign_id, chapter_id)
    references public.organizing_campaigns(id, chapter_id) on delete cascade
);

create table public.organizing_bargaining_proposals (
  id uuid primary key default extensions.gen_random_uuid(),
  cycle_id uuid not null references public.organizing_bargaining_cycles(id) on delete cascade,
  parent_proposal_id uuid,
  topic text not null,
  title text not null,
  side text not null check (side in ('union', 'employer', 'joint')),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'presented', 'countered', 'tentative_agreement', 'accepted', 'rejected', 'withdrawn', 'superseded')),
  version integer not null default 1 check (version > 0),
  member_summary text,
  internal_notes text,
  presented_on date,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (id, cycle_id),
  constraint organizing_bargaining_proposals_parent_cycle_fkey
    foreign key (parent_proposal_id, cycle_id)
    references public.organizing_bargaining_proposals(id, cycle_id) on delete restrict
);

create table public.organizing_bargaining_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  cycle_id uuid not null references public.organizing_bargaining_cycles(id) on delete cascade,
  session_number integer not null check (session_number > 0),
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  status text not null default 'scheduled' check (status in ('scheduled', 'held', 'cancelled', 'rescheduled')),
  agenda text,
  internal_minutes text,
  member_update text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (cycle_id, session_number)
);

-- 4. Verified membership, onboarding, and participation ---------------------

create table public.member_membership_periods (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  joined_on date,
  left_on date,
  date_precision text not null default 'day' check (date_precision in ('day', 'month', 'year', 'unknown')),
  status text not null default 'pending' check (status in ('pending', 'active', 'inactive', 'left')),
  end_reason text,
  source_kind text not null check (source_kind in ('portal_signup', 'verified_import', 'legacy_profile', 'staff_verified')),
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (left_on is null or joined_on is null or left_on >= joined_on),
  unique (id, user_id, chapter_id)
);
create unique index member_membership_periods_one_active_idx
  on public.member_membership_periods(user_id, chapter_id)
  where status = 'active' and left_on is null;

create table public.member_onboarding_steps (
  id uuid primary key default extensions.gen_random_uuid(),
  membership_period_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  step_key text not null
    check (step_key in ('welcome', 'steward_intro', 'rights_lesson', 'first_meeting', 'member_priorities', 'first_voluntary_action', 'follow_up_30', 'follow_up_90')),
  due_on date,
  status text not null default 'pending' check (status in ('pending', 'completed', 'waived', 'declined', 'reopened')),
  source_kind text,
  source_id text,
  completed_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (membership_period_id, step_key),
  constraint member_onboarding_steps_membership_scope_fkey
    foreign key (membership_period_id, user_id, chapter_id)
    references public.member_membership_periods(id, user_id, chapter_id)
    on delete cascade
);

create table public.member_participation_events (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  chapter_id text not null references public.chapters(id) on delete restrict,
  rung text not null check (rung in ('learn', 'attend', 'volunteer', 'organize', 'lead')),
  activity_kind text not null
    check (activity_kind in ('training_complete', 'orientation_complete', 'meeting_verified', 'peer_outreach_complete', 'committee_commitment_complete', 'commitment_complete', 'leadership_training_complete')),
  source_kind text not null,
  source_id text not null check (pg_catalog.char_length(source_id) between 1 and 160),
  occurred_at timestamptz not null,
  verified_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (user_id, chapter_id, activity_kind, source_kind, source_id),
  unique (id, user_id, chapter_id, activity_kind, source_kind, source_id),
  check (verified_by <> user_id),
  check (
    (activity_kind in ('training_complete', 'orientation_complete') and rung = 'learn')
    or (activity_kind = 'meeting_verified' and rung = 'attend')
    or (activity_kind = 'commitment_complete' and rung = 'volunteer')
    or (activity_kind in ('peer_outreach_complete', 'committee_commitment_complete') and rung = 'organize')
    or (activity_kind = 'leadership_training_complete' and rung = 'lead')
  ),
  constraint member_participation_events_member_scope_fkey
    foreign key (user_id, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete cascade,
  constraint member_participation_events_verifier_scope_fkey
    foreign key (verified_by, chapter_id)
    references public.member_chapter_memberships(user_id, chapter_id)
    on delete restrict
);

-- 5. Coalitions and coalition handshakes ------------------------------------

create table public.coalition_partners (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete restrict,
  name text not null check (pg_catalog.char_length(name) between 2 and 160),
  organization_type text not null,
  status text not null default 'forming' check (status in ('forming', 'active', 'paused', 'ended')),
  private_contact text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chapter_id)
);

create table public.coalition_handshakes (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete restrict,
  partner_id uuid not null,
  shared_interest text not null check (pg_catalog.char_length(shared_interest) between 3 and 1000),
  bridge_lead_id uuid references auth.users(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'proposed', 'countered', 'awaiting_approval', 'active', 'renewal_due', 'suspended', 'declined', 'ended', 'expired')),
  governance_summary text,
  renewal_due_on date,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, chapter_id),
  constraint coalition_handshakes_partner_scope_fkey
    foreign key (partner_id, chapter_id)
    references public.coalition_partners(id, chapter_id) on delete restrict
);

create table public.coalition_commitments (
  id uuid primary key default extensions.gen_random_uuid(),
  handshake_id uuid not null references public.coalition_handshakes(id) on delete cascade,
  title text not null check (pg_catalog.char_length(title) between 3 and 240),
  owner_side text not null check (owner_side in ('chapter', 'partner', 'joint')),
  owner_name text,
  due_on date,
  status text not null default 'proposed'
    check (status in ('proposed', 'accepted', 'in_progress', 'fulfilled', 'declined', 'cancelled', 'expired')),
  outcome text,
  completed_on date,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 6. Append-only audit -------------------------------------------------------

create table public.union_lifecycle_audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  chapter_id text not null references public.chapters(id) on delete restrict,
  campaign_id uuid,
  actor_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  from_state text,
  to_state text,
  reason text check (reason is null or pg_catalog.char_length(reason) <= 1000),
  safe_metadata jsonb not null default '{}'::jsonb
    check (pg_catalog.jsonb_typeof(safe_metadata) = 'object' and pg_catalog.length(safe_metadata::text) <= 2000),
  occurred_at timestamptz not null default now(),
  constraint union_lifecycle_audit_campaign_scope_fkey
    foreign key (campaign_id, chapter_id)
    references public.organizing_campaigns(id, chapter_id)
    on delete restrict
);

create function private.prevent_lifecycle_audit_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'lifecycle audit is append-only' using errcode = '42501';
end;
$$;

create trigger union_lifecycle_audit_append_only
  before update or delete on public.union_lifecycle_audit_events
  for each row execute function private.prevent_lifecycle_audit_change();

-- 7. Indexes and update triggers --------------------------------------------

create index organizing_campaigns_rail_idx
  on public.organizing_campaigns(chapter_id, stage, next_action_due_at);
create index organizing_campaigns_owner_queue_idx
  on public.organizing_campaigns(next_action_owner_id, next_action_due_at)
  where status = 'active';
create index organizing_campaign_assignments_user_idx
  on public.organizing_campaign_assignments(user_id, status, campaign_id);
create index organizing_work_areas_campaign_idx
  on public.organizing_work_areas(campaign_id, name, shift);
create index organizing_workers_next_contact_idx
  on public.organizing_workers(campaign_id, next_contact_at)
  where consent_to_contact and next_contact_at is not null;
create index organizing_contact_events_worker_idx
  on public.organizing_contact_events(worker_id, occurred_at desc);
create index organizing_stage_events_campaign_idx
  on public.organizing_stage_events(campaign_id, occurred_at);
create index organizing_resistance_queue_idx
  on public.organizing_resistance_incidents(campaign_id, status, next_deadline_at);
create unique index organizing_resistance_charge_idx
  on public.organizing_resistance_incidents(agency, charge_number)
  where agency is not null and charge_number is not null;
create index organizing_bargaining_cycle_queue_idx
  on public.organizing_bargaining_cycles(chapter_id, phase, next_deadline_at);
create index member_onboarding_pending_idx
  on public.member_onboarding_steps(chapter_id, due_on)
  where status in ('pending', 'reopened');
create index member_participation_chapter_idx
  on public.member_participation_events(chapter_id, activity_kind, occurred_at desc);
create index coalition_handshakes_review_idx
  on public.coalition_handshakes(chapter_id, status, renewal_due_on);
create index coalition_commitments_due_idx
  on public.coalition_commitments(handshake_id, status, due_on);
create index union_lifecycle_audit_chapter_idx
  on public.union_lifecycle_audit_events(chapter_id, occurred_at desc);
create index union_lifecycle_audit_campaign_idx
  on public.union_lifecycle_audit_events(campaign_id, occurred_at desc)
  where campaign_id is not null;

create trigger union_employers_touch_updated_at before update on public.union_employers
  for each row execute function private.touch_updated_at();
create trigger union_worksites_touch_updated_at before update on public.union_worksites
  for each row execute function private.touch_updated_at();
create trigger organizing_campaigns_touch_updated_at before update on public.organizing_campaigns
  for each row execute function private.touch_updated_at();
create trigger organizing_work_areas_touch_updated_at before update on public.organizing_work_areas
  for each row execute function private.touch_updated_at();
create trigger organizing_workers_touch_updated_at before update on public.organizing_workers
  for each row execute function private.touch_updated_at();
create trigger organizing_resistance_touch_updated_at before update on public.organizing_resistance_incidents
  for each row execute function private.touch_updated_at();
create trigger organizing_bargaining_cycles_touch_updated_at before update on public.organizing_bargaining_cycles
  for each row execute function private.touch_updated_at();
create trigger coalition_partners_touch_updated_at before update on public.coalition_partners
  for each row execute function private.touch_updated_at();
create trigger coalition_handshakes_touch_updated_at before update on public.coalition_handshakes
  for each row execute function private.touch_updated_at();
create trigger coalition_commitments_touch_updated_at before update on public.coalition_commitments
  for each row execute function private.touch_updated_at();

-- 8. Private authorization helpers ------------------------------------------

-- Lifecycle authority is the chapter-scoped grant
-- (public.member_role_chapters) in the caller's selected chapter, held while
-- the caller's membership in that chapter is active and while the shared
-- predicate (private.member_has_chapter_role: MFA, organization
-- membership, staff-MFA policy) agrees. Every inline role read in the
-- lifecycle RPCs below runs only after this scope resolves.
create function private.lifecycle_scope_chapter(p_roles text[])
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.chapter_id
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  where (select private.mfa_satisfied())
    and p.id = (select auth.uid())
    and exists (
      select 1 from public.member_role_chapters r
      where r.user_id = p.id
        and r.chapter_id = p.chapter_id
        and r.role = any(p_roles)
    )
    and private.member_has_chapter_role(p.chapter_id, p_roles)
  limit 1;
$$;

create function private.lifecycle_can_operate_campaign(p_campaign_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.mfa_satisfied()) and exists (
    select 1
    from public.organizing_campaigns c
    join public.member_chapter_memberships m
      on m.user_id = (select auth.uid())
     and m.chapter_id = c.chapter_id
     and m.status = 'active'
    where c.id = p_campaign_id
      and (
        (
          exists (
            select 1 from public.member_role_chapters r
            where r.user_id = (select auth.uid())
              and r.chapter_id = c.chapter_id
              and r.role = 'coordinator'
          )
          and private.member_has_chapter_role(c.chapter_id, array['coordinator'])
        )
        or (
          exists (
            select 1
            from public.organizing_campaign_assignments a
            join public.member_role_chapters r
              on r.user_id = a.user_id
             and r.chapter_id = a.chapter_id
             and r.role = 'organizer'
            where a.campaign_id = c.id
              and a.user_id = (select auth.uid())
              and a.status = 'active'
              and a.assignment_role in ('lead_organizer', 'organizer')
          )
          and private.member_has_chapter_role(c.chapter_id, array['organizer'])
        )
      )
  );
$$;
-- 9. Bounded campaign write RPCs --------------------------------------------

create function public.create_organizing_campaign(
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
declare
  caller uuid := (select auth.uid());
  scope_chapter text := private.lifecycle_scope_chapter(array['organizer', 'coordinator']);
  employer_id uuid;
  worksite_id uuid;
  campaign_id uuid;
  existing record;
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(caller::text || ':' || p_request_id::text, 0)
  );
  -- The caller may have waited behind a duplicate request. Re-resolve its
  -- chapter and hold the current authorization rows (selected chapter,
  -- active chapter membership, chapter role grant) so a concurrent transfer,
  -- membership revocation, or role revocation cannot become stale before the
  -- writes below.
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

  select
    c.id,
    c.stage,
    c.revision,
    c.name,
    e.display_name as employer_name,
    w.name as worksite_name,
    c.proposed_unit,
    c.representation_path,
    c.eligible_estimate
  into existing
  from public.organizing_campaigns c
  join public.union_employers e on e.id = c.employer_id
  join public.union_worksites w on w.id = c.primary_worksite_id
  where c.created_by = caller
    and c.chapter_id = scope_chapter
    and c.create_request_id = p_request_id;

  if found then
    if existing.name <> pg_catalog.btrim(p_name)
       or existing.employer_name <> pg_catalog.btrim(p_employer_name)
       or existing.worksite_name <> pg_catalog.btrim(p_worksite_name)
       or existing.proposed_unit <> pg_catalog.btrim(p_proposed_unit)
       or existing.representation_path <> p_representation_path
       or existing.eligible_estimate is distinct from p_eligible_estimate then
      raise exception 'request id already used for a different campaign'
        using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object(
      'changed', false,
      'campaignId', existing.id,
      'stage', existing.stage,
      'revision', existing.revision
    );
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
    chapter_id, campaign_id, actor_id, event_type, entity_type, entity_id, to_state
  ) values (
    scope_chapter, campaign_id, caller, 'campaign.created', 'organizing_campaign', campaign_id, 'lead'
  );

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'campaignId', campaign_id,
    'stage', 'lead',
    'revision', 1
  );
end;
$$;

create function public.transition_organizing_campaign(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_next_stage text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  row_in record;
  allowed boolean := false;
  audit_id uuid;
begin
  if caller is null or not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select * into row_in
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found
     or p_expected_revision is null
     or p_expected_revision <= 0
     or row_in.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if row_in.status <> 'active' then
    raise exception 'campaign is not active' using errcode = '22023';
  end if;

  allowed := case
    when row_in.stage = 'lead' then p_next_stage = 'committee'
    when row_in.stage = 'committee' then p_next_stage = 'cards'
    when row_in.stage = 'cards' then
      (p_next_stage = 'petition' and row_in.representation_path in ('undecided', 'election'))
      or
      (p_next_stage = 'recognition' and row_in.representation_path in ('undecided', 'voluntary_recognition'))
    when row_in.stage = 'petition' then
      row_in.representation_path = 'election' and p_next_stage = 'election'
    when row_in.stage = 'election' then p_next_stage = 'certification'
    when row_in.stage = 'recognition' then
      row_in.representation_path = 'voluntary_recognition' and p_next_stage = 'certification'
    when row_in.stage = 'certification' then p_next_stage = 'bargaining'
    when row_in.stage = 'bargaining' then p_next_stage = 'first_contract'
    when row_in.stage = 'first_contract' then p_next_stage = 'established'
    else false
  end;
  if not allowed then
    raise exception 'invalid campaign transition' using errcode = '22023';
  end if;

  -- Later-stage labels are factual outcomes, not progress buttons. Require the
  -- underlying bargaining record before advancing into or through them.
  if p_next_stage = 'bargaining'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = row_in.id
         and b.chapter_id = row_in.chapter_id
     ) then
    raise exception 'bargaining cycle required' using errcode = '22023';
  end if;
  if p_next_stage = 'first_contract'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = row_in.id
         and b.chapter_id = row_in.chapter_id
         and b.phase in ('tentative_agreement', 'ratification', 'execution', 'complete')
     ) then
    raise exception 'ratification milestone required' using errcode = '22023';
  end if;
  if p_next_stage = 'established'
     and not exists (
       select 1
       from public.organizing_bargaining_cycles b
       where b.campaign_id = row_in.id
         and b.chapter_id = row_in.chapter_id
         and b.phase = 'complete'
         and b.first_contract_signed_on is not null
     ) then
    raise exception 'signed first contract required' using errcode = '22023';
  end if;

  update public.organizing_campaigns
  set stage = p_next_stage,
      representation_path = case
        when row_in.stage = 'cards' and p_next_stage = 'petition' then 'election'
        when row_in.stage = 'cards' and p_next_stage = 'recognition' then 'voluntary_recognition'
        else representation_path
      end,
      status = case when p_next_stage = 'established' then 'closed' else status end,
      outcome = case when p_next_stage = 'established' then 'established' else outcome end,
      closed_at = case when p_next_stage = 'established' then now() else closed_at end,
      stage_started_at = now(),
      revision = revision + 1
  where id = p_campaign_id;

  insert into public.organizing_stage_events (
    campaign_id, chapter_id, from_stage, to_stage, actor_id, note
  ) values (
    row_in.id, row_in.chapter_id, row_in.stage, p_next_stage, caller,
    nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
  );

  insert into public.union_lifecycle_audit_events (
    chapter_id, campaign_id, actor_id, event_type, entity_type, entity_id,
    from_state, to_state, reason
  ) values (
    row_in.chapter_id, row_in.id, caller, 'campaign.stage_changed',
    'organizing_campaign', row_in.id, row_in.stage, p_next_stage,
    nullif(pg_catalog.btrim(coalesce(p_note, '')), '')
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'campaignId', row_in.id,
    'stage', p_next_stage,
    'revision', row_in.revision + 1,
    'auditEventId', audit_id
  );
end;
$$;

create function public.set_organizing_campaign_status(
  p_campaign_id uuid,
  p_expected_revision integer,
  p_status text,
  p_outcome text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  row_in record;
  audit_id uuid;
begin
  if caller is null or not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;

  select * into row_in
  from public.organizing_campaigns
  where id = p_campaign_id
  for update;

  if not found
     or p_expected_revision is null
     or p_expected_revision <= 0
     or row_in.revision <> p_expected_revision then
    raise exception 'campaign changed; reload and try again' using errcode = '40001';
  end if;
  if row_in.status = 'closed' then
    raise exception 'closed campaign cannot be changed' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('active', 'paused', 'closed') then
    raise exception 'unknown campaign status' using errcode = '22023';
  end if;
  if p_status = 'closed' and (p_outcome is null or p_outcome not in ('withdrawn', 'lost', 'other')) then
    raise exception 'closed campaign outcome required' using errcode = '22023';
  end if;
  if p_status <> 'closed' and p_outcome is not null then
    raise exception 'outcome is only valid when closing' using errcode = '22023';
  end if;
  if pg_catalog.char_length(coalesce(p_reason, '')) > 1000 then
    raise exception 'campaign status reason is too long' using errcode = '22023';
  end if;

  update public.organizing_campaigns
  set status = p_status,
      outcome = case when p_status = 'closed' then p_outcome else null end,
      outcome_reason = case
        when p_status = 'closed' then nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')
        else null
      end,
      closed_at = case when p_status = 'closed' then now() else null end,
      revision = revision + 1
  where id = p_campaign_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id, campaign_id, actor_id, event_type, entity_type, entity_id,
    from_state, to_state, reason
  ) values (
    row_in.chapter_id, row_in.id, caller, 'campaign.status_changed',
    'organizing_campaign', row_in.id, row_in.status, p_status,
    nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'campaignId', row_in.id,
    'status', p_status,
    'outcome', case when p_status = 'closed' then p_outcome else null end,
    'revision', row_in.revision + 1,
    'auditEventId', audit_id
  );
end;
$$;

create function public.record_resistance_incident(
  p_campaign_id uuid,
  p_title text,
  p_category text,
  p_severity text,
  p_summary text,
  p_occurred_on date default null,
  p_next_deadline_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  campaign record;
  incident_id uuid;
  incident_reference text;
  audit_id uuid;
begin
  if caller is null or not private.lifecycle_can_operate_campaign(p_campaign_id) then
    raise exception 'campaign not found' using errcode = '22023';
  end if;
  if p_category is null
     or p_category not in ('surveillance', 'interrogation', 'threat', 'captive_audience', 'retaliation', 'discipline', 'discharge', 'delay', 'unilateral_change', 'other')
     or p_severity is null
     or p_severity not in ('monitor', 'standard', 'high', 'immediate')
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_title, ''))) not between 3 and 180
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_summary, ''))) not between 3 and 4000 then
    raise exception 'incident fields are invalid' using errcode = '22023';
  end if;

  select id, chapter_id into campaign
  from public.organizing_campaigns where id = p_campaign_id;
  incident_reference := 'ER-' || pg_catalog.to_char(current_date, 'YYYY') || '-' ||
    pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(extensions.gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.organizing_resistance_incidents (
    campaign_id, chapter_id, reference, title, category, severity,
    factual_summary, occurred_on, source_kind, next_deadline_at, owner_id, created_by
  ) values (
    campaign.id,
    campaign.chapter_id,
    incident_reference,
    pg_catalog.btrim(p_title),
    p_category,
    p_severity,
    pg_catalog.btrim(p_summary),
    p_occurred_on,
    'organizer_note',
    p_next_deadline_at,
    caller,
    caller
  ) returning id into incident_id;

  insert into public.union_lifecycle_audit_events (
    chapter_id, campaign_id, actor_id, event_type, entity_type, entity_id,
    to_state, safe_metadata
  ) values (
    campaign.chapter_id,
    campaign.id,
    caller,
    'resistance.reported',
    'resistance_incident',
    incident_id,
    'reported',
    pg_catalog.jsonb_build_object('category', p_category, 'severity', p_severity)
  ) returning id into audit_id;

  return pg_catalog.jsonb_build_object(
    'changed', true,
    'incidentId', incident_id,
    'reference', incident_reference,
    'auditEventId', audit_id
  );
end;
$$;

-- 10. Aggregate, role-shaped workspace loader -------------------------------

create function public.get_union_lifecycle_workspace()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  scope_chapter text := private.lifecycle_scope_chapter(array['organizer', 'coordinator', 'advisor', 'vp']);
  resistance_details boolean;
  chapter_wide boolean;
  aggregate_view boolean;
  chapter_name text;
  member_total integer;
  workspace jsonb;
begin
  if caller is null or scope_chapter is null then
    raise exception 'lifecycle staff role required' using errcode = '42501';
  end if;

  chapter_wide := exists (
    select 1 from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role = 'coordinator'
  );
  aggregate_view := exists (
    select 1 from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role in ('advisor', 'vp')
  ) and not chapter_wide and not exists (
    select 1 from public.member_role_chapters r
    where r.user_id = caller
      and r.chapter_id = scope_chapter
      and r.role = 'organizer'
  );
  resistance_details := chapter_wide or exists (
    select 1
    from public.organizing_campaign_assignments a
    where a.chapter_id = scope_chapter
      and a.user_id = caller
      and a.status = 'active'
      and a.assignment_role in ('lead_organizer', 'organizer', 'legal_reviewer')
  );
  select c.name into chapter_name from public.chapters c where c.id = scope_chapter;
  select pg_catalog.count(distinct p.user_id)::integer into member_total
  from public.member_membership_periods p
  where p.chapter_id = scope_chapter
    and p.status = 'active'
    and p.left_on is null
    and p.verified_at is not null;

  workspace := pg_catalog.jsonb_build_object(
    'mode', 'live',
    'generatedAt', now(),
    'chapter', pg_catalog.jsonb_build_object('id', scope_chapter, 'name', chapter_name),
    'methodology', pg_catalog.jsonb_build_object(
      'label', 'Role-scoped lifecycle records',
      'detail', 'Campaign and worksite summaries omit worker identity, contact details, support position, evidence content, and private legal narratives.',
      'suppressionMinimum', 5
    ),
    'access', pg_catalog.jsonb_build_object(
      'canCreateCampaign', exists (
        select 1 from public.member_role_chapters r
        where r.user_id = caller
          and r.chapter_id = scope_chapter
          and r.role in ('organizer', 'coordinator')
      ),
      'resistanceDetails', resistance_details,
      'resistanceCampaignIds', coalesce((
        select pg_catalog.jsonb_agg(c.id)
        from public.organizing_campaigns c
        where c.chapter_id = scope_chapter
          and (
            chapter_wide
            or exists (
              select 1
              from public.organizing_campaign_assignments a
              where a.campaign_id = c.id
                and a.user_id = caller
                and a.status = 'active'
                and a.assignment_role in ('lead_organizer', 'organizer', 'legal_reviewer')
            )
          )
      ), '[]'::jsonb),
      'chapterWideOperations', chapter_wide,
      'aggregateOnly', aggregate_view
    ),
    'campaigns', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'employerName', e.display_name,
        'worksiteName', w.name,
        'proposedUnit', c.proposed_unit,
        'ownerName', case when private.lifecycle_can_operate_campaign(c.id) then coalesce(owner.full_name, 'Assigned team') else 'Assigned team' end,
        'canOperate', private.lifecycle_can_operate_campaign(c.id),
        'stage', c.stage,
        'status', c.status,
        'revision', c.revision,
        'closedAt', c.closed_at,
        'stageStartedAt', c.stage_started_at,
        'targetDate', c.target_date,
        'nextAction', case when private.lifecycle_can_operate_campaign(c.id) then c.next_action else null end,
        'nextActionDue', case when private.lifecycle_can_operate_campaign(c.id) then c.next_action_due_at else null end,
        'eligibleEstimate', case
          when private.lifecycle_can_operate_campaign(c.id)
           and c.eligible_estimate >= 5
           and coverage.committee_count >= 5
           and coverage.contacted_count - coverage.committee_count >= 5
           and c.eligible_estimate - coverage.contacted_count >= 5
           and (
             c.eligible_estimate - coverage.work_area_eligible_count = 0
             or c.eligible_estimate - coverage.work_area_eligible_count >= 5
           )
           and not coverage.has_suppressed_area
          then c.eligible_estimate
          else null
        end,
        'contactedCount', case
          when private.lifecycle_can_operate_campaign(c.id)
           and c.eligible_estimate >= 5
           and coverage.committee_count >= 5
           and coverage.contacted_count - coverage.committee_count >= 5
           and c.eligible_estimate - coverage.contacted_count >= 5
           and (
             c.eligible_estimate - coverage.work_area_eligible_count = 0
             or c.eligible_estimate - coverage.work_area_eligible_count >= 5
           )
           and not coverage.has_suppressed_area
          then coverage.contacted_count
          else null
        end,
        'committeeCount', case
          when private.lifecycle_can_operate_campaign(c.id)
           and c.eligible_estimate >= 5
           and coverage.committee_count >= 5
           and coverage.contacted_count - coverage.committee_count >= 5
           and c.eligible_estimate - coverage.contacted_count >= 5
           and (
             c.eligible_estimate - coverage.work_area_eligible_count = 0
             or c.eligible_estimate - coverage.work_area_eligible_count >= 5
           )
           and not coverage.has_suppressed_area
          then coverage.committee_count
          else null
        end,
        'cardsSigned', null,
        'route', case
          when c.representation_path = 'election' then
            pg_catalog.jsonb_build_array('lead','committee','cards','petition','election','certification','bargaining','first_contract','established')
          when c.representation_path = 'voluntary_recognition' then
            pg_catalog.jsonb_build_array('lead','committee','cards','recognition','certification','bargaining','first_contract','established')
          else
            pg_catalog.jsonb_build_array('lead','committee','cards')
        end,
        'verifiedStages', coalesce((
          select pg_catalog.jsonb_agg(s.to_stage order by s.occurred_at)
          from public.organizing_stage_events s where s.campaign_id = c.id
        ), pg_catalog.jsonb_build_array(c.stage)),
        'outcome', c.outcome,
        'outcomeReason', case when private.lifecycle_can_operate_campaign(c.id) then c.outcome_reason else null end
      ) order by c.next_action_due_at nulls last, c.created_at desc)
      from public.organizing_campaigns c
      join public.union_employers e on e.id = c.employer_id
      join public.union_worksites w on w.id = c.primary_worksite_id
      left join public.member_profiles owner
        on owner.id = c.owner_id and owner.chapter_id = c.chapter_id
      left join lateral (
        select
          coalesce(pg_catalog.sum(a.eligible_estimate), 0)::integer as work_area_eligible_count,
          coalesce(pg_catalog.sum(a.contacted_count), 0)::integer as contacted_count,
          coalesce(pg_catalog.sum(a.committee_count), 0)::integer as committee_count,
          coalesce(pg_catalog.bool_or(
            coalesce(a.eligible_estimate, 0) < 5
            or a.committee_count < 5
            or a.contacted_count - a.committee_count < 5
            or a.eligible_estimate - a.contacted_count < 5
          ), true) as has_suppressed_area
        from public.organizing_work_areas a
        where a.campaign_id = c.id
      ) coverage on true
      where c.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments a
            where a.campaign_id = c.id
              and a.user_id = caller
              and a.status = 'active'
              and a.assignment_role in ('lead_organizer', 'organizer', 'coordinator', 'legal_reviewer', 'viewer')
          )
        )
    ), '[]'::jsonb),
    'workAreas', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id,
        'campaignId', a.campaign_id,
        'name', a.name,
        'shift', a.shift,
        'eligibleEstimate', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then a.eligible_estimate
          else null
        end,
        'contactedCount', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then a.contacted_count
          else null
        end,
        'committeeCount', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then a.committee_count
          else null
        end,
        'issueThemes', case
          when coalesce(a.eligible_estimate, 0) >= 5
           and a.committee_count >= 5
           and a.contacted_count - a.committee_count >= 5
           and a.eligible_estimate - a.contacted_count >= 5
          then to_jsonb(a.issue_themes)
          else '[]'::jsonb
        end
      ) order by a.name, a.shift)
      from public.organizing_work_areas a
      where a.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments assignment
            where assignment.campaign_id = a.campaign_id
              and assignment.user_id = caller
              and assignment.status = 'active'
              and assignment.assignment_role in ('lead_organizer', 'organizer', 'coordinator', 'viewer')
          )
        )
    ), '[]'::jsonb),
    'resistanceEvents', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id,
        'campaignId', i.campaign_id,
        'category', i.category,
        'severity', i.severity,
        'occurredOn', i.occurred_on,
        'reportedOn', i.reported_on,
        'title', i.title,
        'summary', i.factual_summary,
        'sourceType', i.source_kind,
        'legalReviewStatus', i.legal_review_status,
        'agency', i.agency,
        'chargeNumber', i.charge_number,
        'chargeStatus', i.charge_status,
        'nextDeadline', i.next_deadline_at,
        'ownerName', coalesce(owner.full_name, 'Assigned team'),
        'evidenceCount', i.evidence_count,
        'resolution', i.resolution
      ) order by i.next_deadline_at nulls last, i.reported_on desc)
      from public.organizing_resistance_incidents i
      left join public.member_profiles owner
        on owner.id = i.owner_id and owner.chapter_id = i.chapter_id
      where i.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments a
            where a.campaign_id = i.campaign_id
              and a.user_id = caller
              and a.status = 'active'
              and a.assignment_role in ('lead_organizer', 'organizer', 'legal_reviewer')
          )
        )
    ), '[]'::jsonb),
    'bargaining', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id,
        'campaignId', b.campaign_id,
        'status', b.phase,
        'bargainingStartedOn', b.bargaining_started_on,
        'firstContractTargetOn', b.target_first_contract_on,
        'firstContractSignedOn', b.first_contract_signed_on,
        'surveyReturnRate', null,
        'surveyReturnAvailability', 'Not shown without a verified denominator and suppression check.',
        'proposals', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', p.id,
            'topic', p.topic,
            'title', p.title,
            'side', p.side,
            'status', p.status,
            'version', p.version,
            'presentedOn', p.presented_on
          ) order by p.created_at)
          from public.organizing_bargaining_proposals p where p.cycle_id = b.id
        ), '[]'::jsonb),
        'sessions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', s.id,
            'startsAt', s.starts_at,
            'location', s.location,
            'status', s.status,
            'summary', coalesce(s.member_update, s.agenda, '')
          ) order by s.starts_at desc)
          from public.organizing_bargaining_sessions s where s.cycle_id = b.id
        ), '[]'::jsonb)
      ) order by b.created_at desc)
      from public.organizing_bargaining_cycles b
      where b.chapter_id = scope_chapter
        and (
          chapter_wide
          or exists (
            select 1
            from public.organizing_campaign_assignments a
            where a.campaign_id = b.campaign_id
              and a.user_id = caller
              and a.status = 'active'
              and a.assignment_role in ('lead_organizer', 'organizer', 'coordinator', 'viewer')
          )
        )
    ), '[]'::jsonb),
    'engagement', pg_catalog.jsonb_build_object(
      'asOf', current_date,
      'source', 'Verified membership periods and participation events',
      'method', 'Thirty- and ninety-day metrics require exact verified membership dates and full observation windows.',
      'coverage', 'Live records only',
      'suppressionMinimum', 25,
      'memberCount', case when member_total >= 25 then member_total else null end,
      'availability', 'Metrics remain unavailable until verified cohorts mature and pass suppression.',
      'onboarding30', null,
      'onboarding90', null,
      'membershipRetention12Month', null,
      'engagementRetention12Month', null,
      'ladder', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('stage','learn','count',null),
        pg_catalog.jsonb_build_object('stage','attend','count',null),
        pg_catalog.jsonb_build_object('stage','volunteer','count',null),
        pg_catalog.jsonb_build_object('stage','organize','count',null),
        pg_catalog.jsonb_build_object('stage','lead','count',null)
      ),
      'safeRewardKinds', pg_catalog.jsonb_build_array('Training completion','Orientation completion','Verified peer outreach','Committee commitment','Completed voluntary commitment'),
      'excludedRewardKinds', pg_catalog.jsonb_build_array('Case or grievance','Form or co-signature','Retaliation or ULP report','Evidence upload','Steward request','Private message','Workload log','Vote or survey','RSVP or generic attendance','Check-in or scan','Support position','Card or signature','Outcome or remedy')
    ),
    'coalitions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id,
        'name', p.name,
        'organizationType', p.organization_type,
        'sharedInterest', h.shared_interest,
        'bridgeLead', coalesce(lead.full_name, 'Not assigned'),
        'status', h.status,
        'governance', h.governance_summary,
        'commitments', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', c.id,
            'title', c.title,
            'ownerOrg', c.owner_side,
            'dueOn', c.due_on,
            'status', c.status,
            'outcome', c.outcome
          ) order by c.due_on nulls last)
          from public.coalition_commitments c where c.handshake_id = h.id
        ), '[]'::jsonb)
      ) order by p.name)
      from public.coalition_handshakes h
      join public.coalition_partners p on p.id = h.partner_id
      left join public.member_profiles lead
        on lead.id = h.bridge_lead_id and lead.chapter_id = h.chapter_id
      where h.chapter_id = scope_chapter
    ), '[]'::jsonb),
    'impact', pg_catalog.jsonb_build_object(
      'period', (extract(year from current_date)::integer - 9)::text || '–' || extract(year from current_date)::integer::text,
      'asOf', current_date,
      'source', 'Recorded campaign openings and verified membership periods',
      'method', 'Calendar-year openings below five and verified person cohorts below twenty-five are suppressed; complementary totals are hidden.',
      'suppressionMinimum', 5,
      'summary', pg_catalog.jsonb_build_object(
        'campaigns', (
          select case
            when pg_catalog.count(*) >= 5
             and not exists (
               select 1
               from pg_catalog.generate_series(
                 extract(year from current_date)::integer - 9,
                 extract(year from current_date)::integer
               ) hidden_year(year)
               where (
                 select pg_catalog.count(*)
                 from public.organizing_campaigns hidden_campaign
                 where hidden_campaign.chapter_id = scope_chapter
                   and extract(year from hidden_campaign.created_at)::integer = hidden_year.year
               ) between 1 and 4
             )
            then pg_catalog.count(*)
            else null
          end
          from public.organizing_campaigns
          where chapter_id = scope_chapter
            and created_at >= date_trunc('year', current_date) - interval '9 years'
            and created_at < date_trunc('year', current_date) + interval '1 year'
        ),
        'certified', null,
        'firstContracts', null
      ),
      'years', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'year', y.year,
          'campaigns', case when y.campaigns >= 5 then y.campaigns else null end,
          'certified', null,
          'firstContracts', null,
          'outcomeSuppressed', y.campaigns < 5,
          'joined', case when y.joined >= 25 then y.joined else null end,
          'left', case when y.left_count >= 25 then y.left_count else null end
        ) order by y.year)
        from (
          select years.year,
            (select pg_catalog.count(*)::integer from public.organizing_campaigns c where c.chapter_id = scope_chapter and extract(year from c.created_at)::integer = years.year) campaigns,
            (select pg_catalog.count(distinct m.user_id)::integer from public.member_membership_periods m where m.chapter_id = scope_chapter and m.verified_at is not null and m.joined_on is not null and extract(year from m.joined_on)::integer = years.year) joined,
            (select pg_catalog.count(distinct m.user_id)::integer from public.member_membership_periods m where m.chapter_id = scope_chapter and m.verified_at is not null and m.left_on is not null and extract(year from m.left_on)::integer = years.year) left_count
          from pg_catalog.generate_series(
            extract(year from current_date)::integer - 9,
            extract(year from current_date)::integer
          ) years(year)
        ) y
      ), '[]'::jsonb),
      'availability', 'Outcome conversion and duration metrics remain unavailable until audited cohorts pass primary and complementary suppression.',
      'funnel', '[]'::jsonb,
      'medianDays', '[]'::jsonb
    )
  );

  -- Advisor/VP access is aggregate-only. Remove every record-shaped projection
  -- (including coalition names, named bridge leads, governance text, owner
  -- details, and commitment registers) before returning the workspace.
  if aggregate_view then
    workspace := workspace || pg_catalog.jsonb_build_object(
      'campaigns', '[]'::jsonb,
      'worksites', '[]'::jsonb,
      'workAreas', '[]'::jsonb,
      'resistanceEvents', '[]'::jsonb,
      'bargaining', '[]'::jsonb,
      'coalitions', '[]'::jsonb
    );
  end if;

  return workspace;
end;
$$;

-- 11. Clean new-member bootstrap --------------------------------------------
-- New accounts receive only an identity/profile, a portal membership start,
-- onboarding tasks, and one accurate welcome notification. Historical cases,
-- conversations, action logs, and partially-completed lessons are never
-- fabricated.
--
-- The existing private.handle_new_member (on_auth_user_created_member_app)
-- stays in charge of the profile and of chapter binding: a chapter named in
-- sign-up metadata is honoured only with a matching, accepting invitation for
-- the same address in an active organization; otherwise the account starts
-- with no chapter. This trigger runs after it (same event, later name) and
-- reads only what that function stored, never raw_user_meta_data.

create function private.unionground_start_member_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_chapter text;
  period_id uuid;
begin
  -- Union Ground's account case graph gate comes first (20261014012000).
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- The chapter Union Ground bound from a verified invitation, if any.
  select m.chapter_id into member_chapter
  from public.member_profiles p
  join public.member_chapter_memberships m
    on m.user_id = p.id
   and m.chapter_id = p.chapter_id
   and m.status = 'active'
  where p.id = new.id;

  if member_chapter is not null then
    insert into public.member_membership_periods (
      user_id, chapter_id, joined_on, date_precision, status, source_kind
    ) values (
      new.id, member_chapter, current_date, 'day', 'pending', 'portal_signup'
    ) returning id into period_id;

    insert into public.member_onboarding_steps (
      membership_period_id, user_id, chapter_id, step_key, due_on
    ) values
      (period_id, new.id, member_chapter, 'welcome', current_date + 3),
      (period_id, new.id, member_chapter, 'steward_intro', current_date + 7),
      (period_id, new.id, member_chapter, 'rights_lesson', current_date + 14),
      (period_id, new.id, member_chapter, 'first_meeting', current_date + 30),
      (period_id, new.id, member_chapter, 'member_priorities', current_date + 30),
      (period_id, new.id, member_chapter, 'first_voluntary_action', current_date + 60),
      (period_id, new.id, member_chapter, 'follow_up_30', current_date + 30),
      (period_id, new.id, member_chapter, 'follow_up_90', current_date + 90);
  end if;

  -- One welcome row, classified 'general' because 'general' is the only kind
  -- that never enqueues an outbound send (20260723201000:15-21). This is the
  -- entire signup notification surface.
  insert into public.member_notifications (user_id, title, body, kind)
  values (
    new.id,
    'Welcome to your private organizing workspace',
    'Start with your organizing rights guide and your campaign orientation.',
    'general'
  );

  return new;
end;
$$;

-- Trigger order on one event is by name: "on_auth_user_created_unionground_lifecycle"
-- sorts after the existing "on_auth_user_created_member_app", so the profile
-- and any invitation-bound membership exist when this runs.
create trigger on_auth_user_created_unionground_lifecycle
  after insert on auth.users
  for each row execute function private.unionground_start_member_lifecycle();

-- 12. RLS, grants, and function exposure ------------------------------------

alter table public.union_employers enable row level security;
alter table public.union_worksites enable row level security;
alter table public.organizing_campaigns enable row level security;
alter table public.organizing_campaign_assignments enable row level security;
alter table public.organizing_stage_events enable row level security;
alter table public.organizing_work_areas enable row level security;
alter table public.organizing_workers enable row level security;
alter table public.organizing_contact_events enable row level security;
alter table public.organizing_resistance_incidents enable row level security;
alter table public.organizing_resistance_evidence enable row level security;
alter table public.organizing_bargaining_cycles enable row level security;
alter table public.organizing_bargaining_proposals enable row level security;
alter table public.organizing_bargaining_sessions enable row level security;
alter table public.member_membership_periods enable row level security;
alter table public.member_onboarding_steps enable row level security;
alter table public.member_participation_events enable row level security;
alter table public.coalition_partners enable row level security;
alter table public.coalition_handshakes enable row level security;
alter table public.coalition_commitments enable row level security;
alter table public.union_lifecycle_audit_events enable row level security;

-- These tables are created after the source application's one-time MFA policy
-- generator. Apply the restrictive boundary in this same transaction so an
-- incremental upgrade and a clean replay have identical assurance coverage.
do $$
declare
  target regclass;
begin
  foreach target in array array[
    'public.union_employers'::regclass,
    'public.union_worksites'::regclass,
    'public.organizing_campaigns'::regclass,
    'public.organizing_campaign_assignments'::regclass,
    'public.organizing_stage_events'::regclass,
    'public.organizing_work_areas'::regclass,
    'public.organizing_workers'::regclass,
    'public.organizing_contact_events'::regclass,
    'public.organizing_resistance_incidents'::regclass,
    'public.organizing_resistance_evidence'::regclass,
    'public.organizing_bargaining_cycles'::regclass,
    'public.organizing_bargaining_proposals'::regclass,
    'public.organizing_bargaining_sessions'::regclass,
    'public.member_membership_periods'::regclass,
    'public.member_onboarding_steps'::regclass,
    'public.member_participation_events'::regclass,
    'public.coalition_partners'::regclass,
    'public.coalition_handshakes'::regclass,
    'public.coalition_commitments'::regclass,
    'public.union_lifecycle_audit_events'::regclass
  ]
  loop
    execute pg_catalog.format('drop policy if exists mfa_assurance on %s', target);
    execute pg_catalog.format(
      'create policy mfa_assurance on %s as restrictive for all to authenticated '
      || 'using ((select private.mfa_satisfied())) '
      || 'with check ((select private.mfa_satisfied()))',
      target
    );
  end loop;
end
$$;

create policy member_membership_periods_select_own on public.member_membership_periods
  for select to authenticated using ((select auth.uid()) = user_id);
create policy member_onboarding_steps_select_own on public.member_onboarding_steps
  for select to authenticated using ((select auth.uid()) = user_id);
create policy member_participation_events_select_own on public.member_participation_events
  for select to authenticated using ((select auth.uid()) = user_id);

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
from public, anon, authenticated;

grant select on public.member_membership_periods to authenticated;
grant select on public.member_onboarding_steps to authenticated;
grant select (
  user_id,
  rung,
  activity_kind,
  source_kind,
  source_id,
  occurred_at
) on public.member_participation_events to authenticated;

revoke all on function public.create_organizing_campaign(text, text, text, text, uuid, text, integer) from public, anon;
revoke all on function public.transition_organizing_campaign(uuid, integer, text, text) from public, anon;
revoke all on function public.set_organizing_campaign_status(uuid, integer, text, text, text) from public, anon;
revoke all on function public.record_resistance_incident(uuid, text, text, text, text, date, timestamptz) from public, anon;
revoke all on function public.get_union_lifecycle_workspace() from public, anon;
revoke all on function private.unionground_start_member_lifecycle() from public, anon, authenticated;
revoke all on function private.prevent_lifecycle_audit_change() from public, anon, authenticated;
revoke all on function private.lifecycle_scope_chapter(text[]) from public, anon, authenticated;
revoke all on function private.lifecycle_can_operate_campaign(uuid) from public, anon, authenticated;

grant execute on function public.create_organizing_campaign(text, text, text, text, uuid, text, integer) to authenticated;
grant execute on function public.transition_organizing_campaign(uuid, integer, text, text) to authenticated;
grant execute on function public.set_organizing_campaign_status(uuid, integer, text, text, text) to authenticated;
grant execute on function public.record_resistance_incident(uuid, text, text, text, text, date, timestamptz) to authenticated;
grant execute on function public.get_union_lifecycle_workspace() to authenticated;
