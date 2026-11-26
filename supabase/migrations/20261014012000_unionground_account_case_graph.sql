-- Join the organizing lifecycle tables to the account case graph.
--
-- The schema serializes every write that can reach an account's rows with
-- account deletion through one protocol (20260907150000_account_lifecycle_manifest
-- and its successors): a BEFORE STATEMENT gate (a00_case_graph_lock) and a
-- BEFORE ROW key gate (z99_case_graph_keys) on every table in the foreign-key
-- closure of auth.users, and private.lock_case_graph() as the first statement
-- of every function that writes those tables. The organizing lifecycle
-- tables reference auth.users and member_chapter_memberships, so 30 of them
-- are now in that closure (scripts/account-case-graph-fks.json and
-- scripts/account-case-graph-review.json record the recaptured catalogue).
-- The writer functions in 20261014001000-009000 take the gate first; this
-- file installs the table gates. Row-key arguments are the direct auth.users
-- foreign-key columns, as scripts/account-case-graph-inventory.mjs derives
-- them; none of these tables references a case.
--
-- Not done here, recorded for the owner: the lifecycle tables' auth.users
-- columns are not yet entries in private.account_lifecycle_manifest, so
-- private.account_lifecycle_unmanaged_restrictive_fks() and
-- private.account_lifecycle_unmanaged_export_fks() list them, and deleting an
-- account that authored lifecycle evidence is refused by the RESTRICT keys.
-- Which columns to pseudonymize, cascade, or export is a product decision.

create trigger a00_case_graph_lock before insert or update or delete on private.member_recognition_week_kind_totals
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_recognition_week_kind_totals
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger a00_case_graph_lock before insert or update or delete on private.member_recognition_week_totals
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_recognition_week_totals
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.coalition_commitments
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.coalition_commitments
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.coalition_handshakes
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.coalition_handshakes
for each row execute function private.lock_case_graph_row_keys('{bridge_lead_id},{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.coalition_partners
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.coalition_partners
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_capacity_commitments
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_capacity_commitments
for each row execute function private.lock_case_graph_row_keys('{offered_by},{user_id},{verified_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_learning_assignments
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_learning_assignments
for each row execute function private.lock_case_graph_row_keys('{assigned_by},{user_id},{verified_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_learning_sessions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_learning_sessions
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_membership_periods
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_membership_periods
for each row execute function private.lock_case_graph_row_keys('{user_id},{verified_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_onboarding_steps
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_onboarding_steps
for each row execute function private.lock_case_graph_row_keys('{user_id},{verified_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_participation_completions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_participation_completions
for each row execute function private.lock_case_graph_row_keys('{user_id},{verified_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_participation_events
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_participation_events
for each row execute function private.lock_case_graph_row_keys('{user_id},{verified_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.member_recognition_events
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.member_recognition_events
for each row execute function private.lock_case_graph_row_keys('{user_id},{verified_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_bargaining_cycles
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_bargaining_cycles
for each row execute function private.lock_case_graph_row_keys('{created_by},{lead_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_bargaining_proposals
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_bargaining_proposals
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_bargaining_ratification_corrections
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_bargaining_ratification_corrections
for each row execute function private.lock_case_graph_row_keys('{corrected_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_bargaining_ratifications
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_bargaining_ratifications
for each row execute function private.lock_case_graph_row_keys('{recorded_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_bargaining_sessions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_bargaining_sessions
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_campaign_assignments
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_campaign_assignments
for each row execute function private.lock_case_graph_row_keys('{granted_by},{user_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_campaigns
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_campaigns
for each row execute function private.lock_case_graph_row_keys('{created_by},{next_action_owner_id},{owner_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_contact_events
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_contact_events
for each row execute function private.lock_case_graph_row_keys('{actor_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_first_contracts
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_first_contracts
for each row execute function private.lock_case_graph_row_keys('{recorded_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_resistance_evidence
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_resistance_evidence
for each row execute function private.lock_case_graph_row_keys('{uploaded_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_resistance_incidents
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_resistance_incidents
for each row execute function private.lock_case_graph_row_keys('{created_by},{owner_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_stage_events
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_stage_events
for each row execute function private.lock_case_graph_row_keys('{actor_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_work_areas
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_work_areas
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger a00_case_graph_lock before insert or update or delete on public.organizing_workers
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.organizing_workers
for each row execute function private.lock_case_graph_row_keys('{assigned_to},{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.union_employers
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.union_employers
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.union_lifecycle_audit_events
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.union_lifecycle_audit_events
for each row execute function private.lock_case_graph_row_keys('{actor_id}', '');

create trigger a00_case_graph_lock before insert or update or delete on public.union_worksites
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on public.union_worksites
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');

-- Reviewed trigger surface (private.account_lifecycle_trigger_review).
--
-- The schema reviews every trigger and trigger function on a table in the
-- account graph, by definition hash. This lane's changes to that surface:
--   * retired by 20261014003000 (points economy): the award trigger on
--     public.member_action_log and private.award_member_points(); with it gone,
--     private.form_points(text) and private.form_points(text, integer) leave
--     the surface. Their review rows are removed.
--   * added: every trigger on the 30 lifecycle tables (touch_updated_at,
--     append-only and evidence guards, the recognition cap, the gates above),
--     the signup lifecycle trigger on auth.users, the calendar-feed revocation
--     trigger on private.member_mfa_reset_boundaries, and their trigger
--     functions. They are recorded at their installed hashes.
delete from private.account_lifecycle_trigger_review r
where (r.kind, r.schema_name, r.table_name, r.object_name) in (
    ('trigger', 'public', 'member_action_log', 'member_action_log_award_points'),
    ('function', 'private', '', 'award_member_points()'),
    ('function', 'private', '', 'form_points(p_template_key text)'),
    ('function', 'private', '', 'form_points(p_template_key text, p_template_version integer)')
  )
  and not exists (
    select 1 from private.account_lifecycle_trigger_surface() s
    where s.kind = r.kind and s.schema_name = r.schema_name
      and s.table_name = r.table_name and s.object_name = r.object_name
  );

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (
    s.kind = 'trigger'
    and (s.schema_name, s.table_name) in (
    ('private', 'member_recognition_week_kind_totals'),
    ('private', 'member_recognition_week_totals'),
    ('public', 'coalition_commitments'),
    ('public', 'coalition_handshakes'),
    ('public', 'coalition_partners'),
    ('public', 'member_capacity_commitments'),
    ('public', 'member_learning_assignments'),
    ('public', 'member_learning_sessions'),
    ('public', 'member_membership_periods'),
    ('public', 'member_onboarding_steps'),
    ('public', 'member_participation_completions'),
    ('public', 'member_participation_events'),
    ('public', 'member_recognition_events'),
    ('public', 'organizing_bargaining_cycles'),
    ('public', 'organizing_bargaining_proposals'),
    ('public', 'organizing_bargaining_ratification_corrections'),
    ('public', 'organizing_bargaining_ratifications'),
    ('public', 'organizing_bargaining_sessions'),
    ('public', 'organizing_campaign_assignments'),
    ('public', 'organizing_campaigns'),
    ('public', 'organizing_contact_events'),
    ('public', 'organizing_first_contracts'),
    ('public', 'organizing_resistance_evidence'),
    ('public', 'organizing_resistance_incidents'),
    ('public', 'organizing_stage_events'),
    ('public', 'organizing_work_areas'),
    ('public', 'organizing_workers'),
    ('public', 'union_employers'),
    ('public', 'union_lifecycle_audit_events'),
    ('public', 'union_worksites')
    )
  )
  or (s.kind = 'trigger' and s.schema_name = 'auth' and s.table_name = 'users'
      and s.object_name = 'on_auth_user_created_unionground_lifecycle')
  or (s.kind = 'trigger' and s.schema_name = 'private' and s.table_name = 'member_mfa_reset_boundaries'
      and s.object_name = 'unionground_mfa_reset_revokes_calendar_feed')
  or (s.kind = 'function' and s.schema_name = 'private' and s.object_name in (
      'unionground_start_member_lifecycle()',
      'unionground_revoke_capabilities_on_mfa_reset()',
      'prevent_lifecycle_audit_change()',
      'prevent_canonical_participation_update()',
      'enforce_member_recognition_cap()',
      'preserve_bargaining_proposal_snapshot()',
      'prevent_bargaining_evidence_change()',
      'enforce_corrected_ratification_detached()',
      'prevent_corrected_ratification_reactivation()',
      'enforce_typed_first_contract_stages()'
  ))
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

do $assert_unionground_case_graph$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the Union Ground case graph gates: %',
      (select pg_catalog.string_agg(i.schema_name || '.' || i.table_name || '.' || i.trigger_name, ', ')
       from private.account_lifecycle_referential_action_trigger_issues() i);
  end if;
end;
$assert_unionground_case_graph$;
