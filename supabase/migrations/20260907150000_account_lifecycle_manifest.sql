begin;

-- Round 8, 2026-09-07 UTC: unapplied lifecycle migrations amended in place.
-- Total acquisition order: common transaction gate, sorted supplied Auth keys,
-- sorted supplied case keys, then existing row locks and FK actions. The common
-- gate coordinates unknown key sets, nested calls and direct statements before
-- tuple acquisition; key subsets alone cannot provide that guarantee.
-- 657 literal source-pinned wrappers in 041000 plus the seven in-place retained
-- writers and the SQL notification writer acquire before reads/initializers.
-- 340 BEFORE STATEMENT gates cover Auth deletion, implicit FK writers and
-- trigger roots; 339 BEFORE ROW gates collect OLD/NEW Auth and case references
-- before FK checks. The 913-FK reviewed case-graph catalogue derives the
-- relation closure; every
-- participating function acquires the common gate before reads or row locks.
-- Authorization reads run after the gate. Cross-case writes intentionally
-- serialize; narrowing this gate requires a separately verified protocol.
-- Static and installed inventories: scripts/account-case-graph-inventory.mjs.
-- Transactional case-graph entry protocol. The common gate is necessary for
-- unknown keys in direct statements and for nested/multi-case calls: independently
-- sorted subsets alone cannot order a transaction's later acquisitions.
create function private.lock_case_graph(p_auth_ids uuid[], p_case_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $function$
declare identity_id uuid; case_id uuid;
begin
  -- Message-body preservation is the earlier cross-domain gate. Acquiring it
  -- here gives every overlapping message/case writer one total lock order.
  perform private.lock_message_lifecycle();
  perform pg_catalog.pg_advisory_xact_lock(509, 700);
  for identity_id in select distinct id from pg_catalog.unnest(p_auth_ids) id
    where id is not null order by id loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('case-graph-auth:' || identity_id::text, 509));
  end loop;
  for case_id in select distinct id from pg_catalog.unnest(p_case_ids) id
    where id is not null order by id loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('case-graph-case:' || case_id::text, 509));
  end loop;
end;
$function$;
revoke all on function private.lock_case_graph(uuid[], uuid[]) from public, anon, authenticated, service_role;

create function private.lock_case_graph_statement()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  return null;
end;
$function$;
revoke all on function private.lock_case_graph_statement() from public, anon, authenticated, service_role;


-- Row keys come from the installed FK catalogue, under the statement gate.
-- Both OLD and final NEW references participate, including Auth cascade keys.
create function private.lock_case_graph_row_keys()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare auth_ids uuid[]; case_ids uuid[]; row_data jsonb; column_name text;
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  auth_ids := array[]::uuid[];
  case_ids := array[]::uuid[];
  for row_data in select value from pg_catalog.jsonb_array_elements(
    pg_catalog.jsonb_build_array(case when tg_op <> 'INSERT' then pg_catalog.to_jsonb(old) end,
      case when tg_op <> 'DELETE' then pg_catalog.to_jsonb(new) end)) loop
    foreach column_name in array pg_catalog.string_to_array(tg_argv[0], ',') loop
      auth_ids := pg_catalog.array_append(auth_ids, (row_data ->> column_name)::uuid);
    end loop;
    foreach column_name in array pg_catalog.string_to_array(tg_argv[1], ',') loop
      case_ids := pg_catalog.array_append(case_ids, (row_data ->> column_name)::uuid);
    end loop;
  end loop;
  perform private.lock_case_graph(auth_ids, case_ids);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function private.lock_case_graph_row_keys() from public, anon, authenticated, service_role;

-- BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831: a schema-wide manifest of
-- every delete path rooted at auth.users(id), not merely the root-level FKs.
-- Two invariants are enforced from the same manifest going forward:
--   1. Every restrictive (RESTRICT/NO ACTION) auth.users foreign key must be
--      registered here with a deletion disposition, or self-service deletion
--      would deadlock on it. private.account_lifecycle_unmanaged_restrictive_fks()
--      lists any future violation for CI and tests to fail on.
--   2. Every direct public/private auth.users FK is the independently
--      discoverable ownership inventory, regardless of delete action. Each one must be
--      explicitly included or excluded with a reason; the bidirectional
--      invariant also rejects stale reviewed rows no longer backed by that FK.
--      Included rows use either a versioned hand-shaped projection or a
--      reviewed per-column allowlist -- never an unbounded raw-row export.
--   3. The cascading closure is also inventory-controlled. Every restrictive
--      dependency of a row that auth.users deletion can cascade into, at every
--      depth, is reviewed below. Essential child rows cascade; retained audit,
--      legal-hold, and historical rows detach only their parent reference; an
--      explicit reason records each retained relation. This prevents a direct
--      ON DELETE CASCADE from concealing a transitive RESTRICT deadlock.

create table private.account_lifecycle_manifest (
  schema_name text not null default 'public',
  table_name text not null,
  user_column text not null,
  delete_disposition text not null check (delete_disposition in ('cascade', 'pseudonymize', 'not_applicable')),
  export_disposition text not null check (export_disposition in ('included', 'excluded_with_reason', 'not_applicable')),
  export_projection text check (export_projection in ('canonical', 'additional_domains')),
  export_inventory_basis text check (export_inventory_basis in ('auth_user_fk')),
  export_projection_version integer,
  export_domain text,
  export_columns text[],
  exclusion_reason text check (export_disposition <> 'excluded_with_reason' or exclusion_reason is not null),
  note text,
  reviewed_at date not null default current_date,
  check (
    (export_disposition = 'included' and export_projection is not null and exclusion_reason is null)
    or (export_disposition = 'excluded_with_reason' and export_projection is null
      and pg_catalog.length(pg_catalog.btrim(exclusion_reason)) > 0)
    or (export_disposition = 'not_applicable' and export_projection is null and exclusion_reason is null)
  ),
  primary key (schema_name, table_name, user_column)
);

revoke all on private.account_lifecycle_manifest from public, anon, authenticated, service_role;

comment on table private.account_lifecycle_manifest is
  'Schema-wide account-lifecycle contract: every auth.users FK deletion disposition and every member-owned export domain, in one place. See BUG-UG-ACCOUNT-LIFECYCLE-REGRESSION-20260831.';

-- Deletion-blocking attribution columns discovered on the deployed and local
-- schemas: 54 ON DELETE RESTRICT foreign keys to auth.users, all on
-- staff/coordinator attribution or a relationship's essential subject.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, exclusion_reason, note)
values
      ('public', 'case_deadline_audit', 'actor_user_id', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'case_deadline_changes', 'requested_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'case_step_transitions', 'actor_user_id', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_access_grants', 'granted_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_access_grants', 'revoked_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_alert_acknowledgements', 'acknowledged_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_alerts', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_audit_events', 'actor_user_id', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_bargaining_events', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_bargaining_proposals', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_bargaining_workspaces', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_checklist_items', 'completed_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_checklist_templates', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_checklists', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_deadline_extensions', 'decided_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_deadline_extensions', 'requested_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_deadlines', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_entity_links', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_management_addenda', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_management_entries', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_management_people', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_retaliation_pattern_notes', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_retaliation_patterns', 'reviewed_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_retaliation_reports', 'reporter_user_id', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_step_transitions', 'transitioned_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'casework_strength_analyses', 'analyzed_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'chapter_channel_polls', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'chapter_contact_log', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'chapter_union_org_bindings', 'requested_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'coordinator_case_audit', 'actor_id', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'digital_action_exports', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'digital_actions', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'digital_actions', 'updated_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'dues_checkout_reservations', 'requested_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'member_case_contacts', 'coordinator_id', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'member_case_outcomes', 'recorded_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'member_cases', 'restricted_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'member_handoffs', 'initiated_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'member_handoffs', 'to_steward_id', 'cascade', 'not_applicable', null, 'NOT NULL recipient of a specific steward handoff; without a live steward the handoff itself is meaningless, so the row cascades instead of anonymizing.'),
      ('public', 'member_steward_relationships', 'steward_user_id', 'cascade', 'not_applicable', null, 'NOT NULL subject of a member-steward assignment; the relationship has no meaning without a live steward, so the row cascades instead of anonymizing.'),
      ('public', 'member_welcome_enrollments', 'enrolled_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_chart_nodes', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_chart_nodes', 'updated_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_coordination_records', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_data_export_runs', 'requested_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_import_batches', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_merge_match_reviews', 'source_user_id', 'cascade', 'not_applicable', null, 'NOT NULL merge-candidate identity; the review compares two specific accounts and is meaningless once either is gone, so the row cascades instead of anonymizing.'),
      ('public', 'organization_merge_match_reviews', 'target_user_id', 'cascade', 'not_applicable', null, 'NOT NULL merge-candidate identity; the review compares two specific accounts and is meaningless once either is gone, so the row cascades instead of anonymizing.'),
      ('public', 'organization_relationships', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_relationships', 'updated_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_timeline_events', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_timeline_events', 'updated_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_topic_progress', 'updated_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.'),
      ('public', 'organization_welcome_campaigns', 'created_by', 'pseudonymize', 'not_applicable', null, 'Attribution column on staff/coordination content; auth.users FK previously ON DELETE RESTRICT.');

-- Member-owned content domains the original export omitted: Q&A, weekly
-- questions, ballot/poll votes, peer and channel messaging artifacts,
-- case-file and form-file attachments, and private Compass briefings.
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition, export_projection, exclusion_reason, note)
values
      ('public', 'member_qa_questions', 'author_user_id', 'not_applicable', 'included', 'canonical', null, 'Member-authored Q&A question; safe projection omits its idempotency key.'),
      ('public', 'member_qa_replies', 'author_user_id', 'not_applicable', 'included', 'canonical', null, 'Member-authored Q&A reply; safe projection omits its idempotency key.'),
      ('public', 'member_qa_votes', 'user_id', 'not_applicable', 'included', 'additional_domains', null, 'Member''s own Q&A upvote; already ON DELETE CASCADE.'),
      ('public', 'member_weekly_questions', 'user_id', 'not_applicable', 'included', 'additional_domains', null, 'Member-submitted weekly question; already ON DELETE CASCADE.'),
      ('public', 'member_weekly_question_supports', 'user_id', 'not_applicable', 'included', 'additional_domains', null, 'Member''s own weekly-question support; already ON DELETE CASCADE.'),
      ('public', 'member_weekly_question_promotions', 'user_id', 'not_applicable', 'included', 'additional_domains', null, 'Reward-linked promotion of the member''s own weekly question; already ON DELETE CASCADE.'),
      ('public', 'member_ballot_votes', 'user_id', 'not_applicable', 'included', 'additional_domains', null, 'Member''s own recorded ballot vote; already ON DELETE CASCADE.'),
      ('public', 'chapter_channel_poll_votes', 'user_id', 'not_applicable', 'included', 'additional_domains', null, 'Member''s own chapter channel poll vote; already ON DELETE CASCADE.'),
      ('public', 'member_peer_messages', 'sender_id', 'not_applicable', 'included', 'canonical', null, 'Peer message is already covered by the privacy-safe peerContact projection.'),
      ('public', 'member_message_reactions', 'actor_id', 'not_applicable', 'included', 'additional_domains', null, 'Member''s own reaction to a message, channel post, or task message.'),
      ('public', 'member_message_reminders', 'owner_id', 'not_applicable', 'included', 'additional_domains', null, 'Member''s own private message reminder.'),
      ('public', 'member_message_resources', 'added_by', 'not_applicable', 'included', 'additional_domains', null, 'Message resource attached by the member; column already ON DELETE SET NULL.'),
      ('public', 'member_saved_messages', 'owner_id', 'not_applicable', 'included', 'additional_domains', null, 'Member''s own saved/bookmarked message.'),
      ('public', 'member_scheduled_messages', 'actor_id', 'not_applicable', 'included', 'canonical', null, 'Safe projection omits the recipient identity and dispatch internals.'),
      ('public', 'member_case_files', 'user_id', 'not_applicable', 'included', 'canonical', null, 'Safe projection omits the storage bucket and object path.'),
      ('public', 'member_form_files', 'uploaded_by', 'not_applicable', 'included', 'canonical', null, 'Safe projection omits the storage bucket and object path.'),
      ('public', 'chapter_task_files', 'uploaded_by', 'not_applicable', 'included', 'canonical', null, 'Safe projection omits the storage bucket and object path.'),
      ('public', 'compass_message_briefings', 'requested_by', 'not_applicable', 'included', 'additional_domains', null, 'Compass AI briefing the member privately requested for a conversation, channel, or task thread.');

-- Apply every reviewed direct auth.users disposition as explicit DDL. The
-- manifest and bidirectional inventory below remain the drift-detection source;
-- explicit statements keep policy-sensitive schema changes statically auditable.
alter table public.case_deadline_audit drop constraint case_deadline_audit_actor_user_id_fkey;
alter table public.case_deadline_audit alter column actor_user_id drop not null;
alter table public.case_deadline_audit add constraint case_deadline_audit_actor_user_id_fkey foreign key (actor_user_id) references auth.users(id) on delete set null;
alter table public.case_deadline_changes drop constraint case_deadline_changes_requested_by_fkey;
alter table public.case_deadline_changes alter column requested_by drop not null;
alter table public.case_deadline_changes add constraint case_deadline_changes_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete set null;
alter table public.case_step_transitions drop constraint case_step_transitions_actor_user_id_fkey;
alter table public.case_step_transitions alter column actor_user_id drop not null;
alter table public.case_step_transitions add constraint case_step_transitions_actor_user_id_fkey foreign key (actor_user_id) references auth.users(id) on delete set null;
alter table public.casework_access_grants drop constraint casework_access_grants_granted_by_fkey;
alter table public.casework_access_grants alter column granted_by drop not null;
alter table public.casework_access_grants add constraint casework_access_grants_granted_by_fkey foreign key (granted_by) references auth.users(id) on delete set null;
alter table public.casework_access_grants drop constraint casework_access_grants_revoked_by_fkey;
alter table public.casework_access_grants alter column revoked_by drop not null;
alter table public.casework_access_grants add constraint casework_access_grants_revoked_by_fkey foreign key (revoked_by) references auth.users(id) on delete set null;
alter table public.casework_alert_acknowledgements drop constraint casework_alert_acknowledgements_acknowledged_by_fkey;
alter table public.casework_alert_acknowledgements alter column acknowledged_by drop not null;
alter table public.casework_alert_acknowledgements add constraint casework_alert_acknowledgements_acknowledged_by_fkey foreign key (acknowledged_by) references auth.users(id) on delete set null;
alter table public.casework_alerts drop constraint casework_alerts_created_by_fkey;
alter table public.casework_alerts alter column created_by drop not null;
alter table public.casework_alerts add constraint casework_alerts_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_audit_events drop constraint casework_audit_events_actor_user_id_fkey;
alter table public.casework_audit_events alter column actor_user_id drop not null;
alter table public.casework_audit_events add constraint casework_audit_events_actor_user_id_fkey foreign key (actor_user_id) references auth.users(id) on delete set null;
alter table public.casework_bargaining_events drop constraint casework_bargaining_events_created_by_fkey;
alter table public.casework_bargaining_events alter column created_by drop not null;
alter table public.casework_bargaining_events add constraint casework_bargaining_events_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_bargaining_proposals drop constraint casework_bargaining_proposals_created_by_fkey;
alter table public.casework_bargaining_proposals alter column created_by drop not null;
alter table public.casework_bargaining_proposals add constraint casework_bargaining_proposals_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_bargaining_workspaces drop constraint casework_bargaining_workspaces_created_by_fkey;
alter table public.casework_bargaining_workspaces alter column created_by drop not null;
alter table public.casework_bargaining_workspaces add constraint casework_bargaining_workspaces_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_checklist_items drop constraint casework_checklist_items_completed_by_fkey;
alter table public.casework_checklist_items alter column completed_by drop not null;
alter table public.casework_checklist_items add constraint casework_checklist_items_completed_by_fkey foreign key (completed_by) references auth.users(id) on delete set null;
alter table public.casework_checklist_templates drop constraint casework_checklist_templates_created_by_fkey;
alter table public.casework_checklist_templates alter column created_by drop not null;
alter table public.casework_checklist_templates add constraint casework_checklist_templates_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_checklists drop constraint casework_checklists_created_by_fkey;
alter table public.casework_checklists alter column created_by drop not null;
alter table public.casework_checklists add constraint casework_checklists_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_deadline_extensions drop constraint casework_deadline_extensions_decided_by_fkey;
alter table public.casework_deadline_extensions alter column decided_by drop not null;
alter table public.casework_deadline_extensions add constraint casework_deadline_extensions_decided_by_fkey foreign key (decided_by) references auth.users(id) on delete set null;
alter table public.casework_deadline_extensions drop constraint casework_deadline_extensions_requested_by_fkey;
alter table public.casework_deadline_extensions alter column requested_by drop not null;
alter table public.casework_deadline_extensions add constraint casework_deadline_extensions_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete set null;
alter table public.casework_deadlines drop constraint casework_deadlines_created_by_fkey;
alter table public.casework_deadlines alter column created_by drop not null;
alter table public.casework_deadlines add constraint casework_deadlines_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_entity_links drop constraint casework_entity_links_created_by_fkey;
alter table public.casework_entity_links alter column created_by drop not null;
alter table public.casework_entity_links add constraint casework_entity_links_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_management_addenda drop constraint casework_management_addenda_created_by_fkey;
alter table public.casework_management_addenda alter column created_by drop not null;
alter table public.casework_management_addenda add constraint casework_management_addenda_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_management_entries drop constraint casework_management_entries_created_by_fkey;
alter table public.casework_management_entries alter column created_by drop not null;
alter table public.casework_management_entries add constraint casework_management_entries_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_management_people drop constraint casework_management_people_created_by_fkey;
alter table public.casework_management_people alter column created_by drop not null;
alter table public.casework_management_people add constraint casework_management_people_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_retaliation_pattern_notes drop constraint casework_retaliation_pattern_notes_created_by_fkey;
alter table public.casework_retaliation_pattern_notes alter column created_by drop not null;
alter table public.casework_retaliation_pattern_notes add constraint casework_retaliation_pattern_notes_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.casework_retaliation_patterns drop constraint casework_retaliation_patterns_reviewed_by_fkey;
alter table public.casework_retaliation_patterns alter column reviewed_by drop not null;
alter table public.casework_retaliation_patterns add constraint casework_retaliation_patterns_reviewed_by_fkey foreign key (reviewed_by) references auth.users(id) on delete set null;
alter table public.casework_retaliation_reports drop constraint casework_retaliation_reports_reporter_user_id_fkey;
alter table public.casework_retaliation_reports alter column reporter_user_id drop not null;
alter table public.casework_retaliation_reports add constraint casework_retaliation_reports_reporter_user_id_fkey foreign key (reporter_user_id) references auth.users(id) on delete set null;
alter table public.casework_step_transitions drop constraint casework_step_transitions_transitioned_by_fkey;
alter table public.casework_step_transitions alter column transitioned_by drop not null;
alter table public.casework_step_transitions add constraint casework_step_transitions_transitioned_by_fkey foreign key (transitioned_by) references auth.users(id) on delete set null;
alter table public.casework_strength_analyses drop constraint casework_strength_analyses_analyzed_by_fkey;
alter table public.casework_strength_analyses alter column analyzed_by drop not null;
alter table public.casework_strength_analyses add constraint casework_strength_analyses_analyzed_by_fkey foreign key (analyzed_by) references auth.users(id) on delete set null;
alter table public.chapter_channel_polls drop constraint chapter_channel_polls_created_by_fkey;
alter table public.chapter_channel_polls alter column created_by drop not null;
alter table public.chapter_channel_polls add constraint chapter_channel_polls_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.chapter_contact_log drop constraint chapter_contact_log_created_by_fkey;
alter table public.chapter_contact_log alter column created_by drop not null;
alter table public.chapter_contact_log add constraint chapter_contact_log_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.chapter_union_org_bindings drop constraint chapter_union_org_bindings_requested_by_fkey;
alter table public.chapter_union_org_bindings alter column requested_by drop not null;
alter table public.chapter_union_org_bindings add constraint chapter_union_org_bindings_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete set null;
alter table public.coordinator_case_audit drop constraint coordinator_case_audit_actor_id_fkey;
alter table public.coordinator_case_audit alter column actor_id drop not null;
alter table public.coordinator_case_audit add constraint coordinator_case_audit_actor_id_fkey foreign key (actor_id) references auth.users(id) on delete set null;
alter table public.digital_action_exports drop constraint digital_action_exports_created_by_fkey;
alter table public.digital_action_exports alter column created_by drop not null;
alter table public.digital_action_exports add constraint digital_action_exports_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.digital_actions drop constraint digital_actions_created_by_fkey;
alter table public.digital_actions alter column created_by drop not null;
alter table public.digital_actions add constraint digital_actions_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.digital_actions drop constraint digital_actions_updated_by_fkey;
alter table public.digital_actions alter column updated_by drop not null;
alter table public.digital_actions add constraint digital_actions_updated_by_fkey foreign key (updated_by) references auth.users(id) on delete set null;
alter table public.dues_checkout_reservations drop constraint dues_checkout_reservations_requested_by_fkey;
alter table public.dues_checkout_reservations alter column requested_by drop not null;
alter table public.dues_checkout_reservations add constraint dues_checkout_reservations_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete set null;
alter table public.member_case_contacts drop constraint member_case_contacts_coordinator_id_fkey;
alter table public.member_case_contacts alter column coordinator_id drop not null;
alter table public.member_case_contacts add constraint member_case_contacts_coordinator_id_fkey foreign key (coordinator_id) references auth.users(id) on delete set null;
alter table public.member_case_outcomes drop constraint member_case_outcomes_recorded_by_fkey;
alter table public.member_case_outcomes alter column recorded_by drop not null;
alter table public.member_case_outcomes add constraint member_case_outcomes_recorded_by_fkey foreign key (recorded_by) references auth.users(id) on delete set null;
alter table public.member_cases drop constraint member_cases_restricted_by_fkey;
alter table public.member_cases alter column restricted_by drop not null;
alter table public.member_cases add constraint member_cases_restricted_by_fkey foreign key (restricted_by) references auth.users(id) on delete set null;
alter table public.member_handoffs drop constraint member_handoffs_initiated_by_fkey;
alter table public.member_handoffs alter column initiated_by drop not null;
alter table public.member_handoffs add constraint member_handoffs_initiated_by_fkey foreign key (initiated_by) references auth.users(id) on delete set null;
alter table public.member_handoffs drop constraint member_handoffs_to_steward_id_fkey;
alter table public.member_handoffs add constraint member_handoffs_to_steward_id_fkey foreign key (to_steward_id) references auth.users(id) on delete cascade;
alter table public.member_steward_relationships drop constraint member_steward_relationships_steward_user_id_fkey;
alter table public.member_steward_relationships add constraint member_steward_relationships_steward_user_id_fkey foreign key (steward_user_id) references auth.users(id) on delete cascade;
alter table public.member_welcome_enrollments drop constraint member_welcome_enrollments_enrolled_by_fkey;
alter table public.member_welcome_enrollments alter column enrolled_by drop not null;
alter table public.member_welcome_enrollments add constraint member_welcome_enrollments_enrolled_by_fkey foreign key (enrolled_by) references auth.users(id) on delete set null;
alter table public.organization_chart_nodes drop constraint organization_chart_nodes_created_by_fkey;
alter table public.organization_chart_nodes alter column created_by drop not null;
alter table public.organization_chart_nodes add constraint organization_chart_nodes_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organization_chart_nodes drop constraint organization_chart_nodes_updated_by_fkey;
alter table public.organization_chart_nodes alter column updated_by drop not null;
alter table public.organization_chart_nodes add constraint organization_chart_nodes_updated_by_fkey foreign key (updated_by) references auth.users(id) on delete set null;
alter table public.organization_coordination_records drop constraint organization_coordination_records_created_by_fkey;
alter table public.organization_coordination_records alter column created_by drop not null;
alter table public.organization_coordination_records add constraint organization_coordination_records_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organization_data_export_runs drop constraint organization_data_export_runs_requested_by_fkey;
alter table public.organization_data_export_runs alter column requested_by drop not null;
alter table public.organization_data_export_runs add constraint organization_data_export_runs_requested_by_fkey foreign key (requested_by) references auth.users(id) on delete set null;
alter table public.organization_import_batches drop constraint organization_import_batches_created_by_fkey;
alter table public.organization_import_batches alter column created_by drop not null;
alter table public.organization_import_batches add constraint organization_import_batches_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organization_merge_match_reviews drop constraint organization_merge_match_reviews_source_user_id_fkey;
alter table public.organization_merge_match_reviews add constraint organization_merge_match_reviews_source_user_id_fkey foreign key (source_user_id) references auth.users(id) on delete cascade;
alter table public.organization_merge_match_reviews drop constraint organization_merge_match_reviews_target_user_id_fkey;
alter table public.organization_merge_match_reviews add constraint organization_merge_match_reviews_target_user_id_fkey foreign key (target_user_id) references auth.users(id) on delete cascade;
alter table public.organization_relationships drop constraint organization_relationships_created_by_fkey;
alter table public.organization_relationships alter column created_by drop not null;
alter table public.organization_relationships add constraint organization_relationships_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organization_relationships drop constraint organization_relationships_updated_by_fkey;
alter table public.organization_relationships alter column updated_by drop not null;
alter table public.organization_relationships add constraint organization_relationships_updated_by_fkey foreign key (updated_by) references auth.users(id) on delete set null;
alter table public.organization_timeline_events drop constraint organization_timeline_events_created_by_fkey;
alter table public.organization_timeline_events alter column created_by drop not null;
alter table public.organization_timeline_events add constraint organization_timeline_events_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;
alter table public.organization_timeline_events drop constraint organization_timeline_events_updated_by_fkey;
alter table public.organization_timeline_events alter column updated_by drop not null;
alter table public.organization_timeline_events add constraint organization_timeline_events_updated_by_fkey foreign key (updated_by) references auth.users(id) on delete set null;
alter table public.organization_topic_progress drop constraint organization_topic_progress_updated_by_fkey;
alter table public.organization_topic_progress alter column updated_by drop not null;
alter table public.organization_topic_progress add constraint organization_topic_progress_updated_by_fkey foreign key (updated_by) references auth.users(id) on delete set null;
alter table public.organization_welcome_campaigns drop constraint organization_welcome_campaigns_created_by_fkey;
alter table public.organization_welcome_campaigns alter column created_by drop not null;
alter table public.organization_welcome_campaigns add constraint organization_welcome_campaigns_created_by_fkey foreign key (created_by) references auth.users(id) on delete set null;

-- A referential SET NULL is itself an UPDATE, so pre-existing immutable-history
-- triggers and paired-state CHECK constraints can accidentally veto the Auth
-- deletion they are meant to preserve.  This predicate recognizes only the
-- nested FK action: a non-null attribution becomes null below another trigger
-- and the referenced Auth row is already absent.  Direct calls are revoked and
-- every caller below additionally requires the rest of the row to be identical.
create function private.account_lifecycle_is_nested_auth_detachment(p_old_user_id uuid, p_new_user_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  select p_old_user_id is not null
    and p_new_user_id is null
    and pg_catalog.pg_trigger_depth() > 1
    and not exists (
      select 1
      from auth.users
      where id = p_old_user_id
    );
$$;

revoke all on function private.account_lifecycle_is_nested_auth_detachment(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Preserve the append-only deadline audit while permitting only the exact
-- nested FK detachment of its now-pseudonymous actor or its deleted case.
create or replace function private.mi1_w2_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
     and tg_table_schema = 'public'
     and tg_table_name = 'case_deadline_audit'
     and (
       (private.account_lifecycle_is_nested_auth_detachment(old.actor_user_id, new.actor_user_id)
        and (pg_catalog.to_jsonb(new) - 'actor_user_id')
          is not distinct from (pg_catalog.to_jsonb(old) - 'actor_user_id'))
       or (
         old.case_id is not null and new.case_id is null
         and pg_catalog.pg_trigger_depth() > 1
         and not exists (select 1 from public.member_cases where id = old.case_id)
         and (pg_catalog.to_jsonb(new) - 'case_id')
           is not distinct from (pg_catalog.to_jsonb(old) - 'case_id')
       )
     ) then
    return new;
  end if;
  raise exception 'organization history is append-only' using errcode = '42501';
end;
$function$;

revoke all on function private.mi1_w2_append_only()
  from public, anon, authenticated, service_role;

-- The original poll trigger restored created_by on every update and its
-- sibling touch trigger changed updated_at, both of which defeated an FK SET
-- NULL. Fold ordinary timestamp maintenance into this identity guard so the
-- one referential exception retains the historical timestamp as well.
create or replace function private.stamp_channel_poll_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  space_chapter text;
begin
  if tg_op = 'UPDATE' then
    if new.created_by is distinct from old.created_by then
      if private.account_lifecycle_is_nested_auth_detachment(old.created_by, new.created_by)
         and (pg_catalog.to_jsonb(new) - 'created_by')
           is not distinct from (pg_catalog.to_jsonb(old) - 'created_by') then
        new.updated_at := old.updated_at;
        return new;
      end if;
      raise exception 'channel poll creator is immutable' using errcode = '42501';
    end if;
    new.space_id := old.space_id;
    new.chapter_id := old.chapter_id;
    new.post_id := old.post_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_at := pg_catalog.now();
    return new;
  end if;
  select s.chapter_id into space_chapter
  from public.chapter_spaces s
  where s.id = new.space_id;
  new.chapter_id := space_chapter;
  new.created_by := (select auth.uid());
  return new;
end;
$$;

revoke all on function private.stamp_channel_poll_identity()
  from public, anon, authenticated, service_role;

drop trigger chapter_channel_polls_touch_updated_at on public.chapter_channel_polls;

-- These CHECKs continue to require the substantive state and timestamp.  Only
-- the historical actor may be absent after Auth deletion; INSERT/UPDATE guards
-- below still require an actor whenever application code creates that state.
alter table public.member_cases
  drop constraint member_cases_restriction_state_coherent,
  add constraint member_cases_restriction_state_coherent check (
    (not is_restricted and restriction_reason is null and restricted_at is null and restricted_by is null)
    or (is_restricted and restriction_reason is not null and restricted_at is not null)
  );

alter table public.casework_access_grants
  drop constraint casework_access_grants_revoke_coherent,
  add constraint casework_access_grants_revoke_coherent check (
    (revoked_at is null and revoked_by is null) or revoked_at is not null
  );

alter table public.casework_deadline_extensions
  drop constraint casework_deadline_extension_decision,
  add constraint casework_deadline_extension_decision check (
    (status = 'requested' and decided_by is null and decided_at is null)
    or (status in ('approved','denied') and decided_at is not null)
  );

alter table public.casework_checklist_items
  drop constraint casework_checklist_item_completion,
  add constraint casework_checklist_item_completion check (
    (completed_at is null and completed_by is null) or completed_at is not null
  );

-- member_cases has a general updated_at trigger that runs after the
-- restriction guard. Preserve the original timestamp for the one nested FK
-- detachment; every ordinary update retains the established touch behavior.
create function private.touch_member_case_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.restricted_by is not null
     and new.restricted_by is null
     and new.is_restricted
     and private.account_lifecycle_is_nested_auth_detachment(old.restricted_by, new.restricted_by)
     and (pg_catalog.to_jsonb(new) - 'restricted_by' - 'updated_at')
       is not distinct from (pg_catalog.to_jsonb(old) - 'restricted_by' - 'updated_at') then
    new.updated_at := old.updated_at;
    return new;
  end if;
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

revoke all on function private.touch_member_case_updated_at()
  from public, anon, authenticated, service_role;

drop trigger member_cases_touch_updated_at on public.member_cases;
create trigger member_cases_touch_updated_at
before update on public.member_cases
for each row execute function private.touch_member_case_updated_at();

-- Keep the SAMPLE seed exception and normal staff authorization intact.  The
-- new early arm is deliberately narrower: only an exact nested FK detachment
-- can leave a still-restricted case without its historical actor.
create or replace function private.guard_casework_restriction_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  seed_scope_text text := pg_catalog.current_setting('unionground.demo_seed_casework_scope', true);
  seed_scope_json jsonb;
  seed_lane text;
  seed_run uuid;
  seed_organization uuid;
  seed_run_valid boolean := false;
  seed_scope boolean := false;
begin
  if tg_op = 'INSERT' then
    if new.is_restricted and new.restricted_by is null then
      raise exception 'restricted case requires an attribution actor' using errcode = '23514';
    end if;
    return new;
  end if;

  if old.restricted_by is not null
     and new.restricted_by is null
     and new.is_restricted then
    if private.account_lifecycle_is_nested_auth_detachment(old.restricted_by, new.restricted_by)
       and (pg_catalog.to_jsonb(new) - 'restricted_by')
         is not distinct from (pg_catalog.to_jsonb(old) - 'restricted_by') then
      return new;
    end if;
    raise exception 'restricted-case attribution cannot be detached' using errcode = '42501';
  end if;
  if not old.is_restricted and new.is_restricted and new.restricted_by is null then
    raise exception 'restricted case requires an attribution actor' using errcode = '23514';
  end if;

  begin
    seed_scope_json := seed_scope_text::jsonb;
    seed_lane := seed_scope_json ->> 'lane';
    if seed_lane not in ('presg', 'uniondemo')
       or (seed_scope_json ->> 'runId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid casework seed scope';
    end if;
    seed_run := (seed_scope_json ->> 'runId')::uuid;
    seed_organization := private.member_stress_uuid(
      seed_run::text || case when seed_lane = 'presg'
        then ':presg:organization' else ':ud:organization' end
    );
    if seed_lane = 'presg' then
      select exists (
        select 1 from private.presg_demo_runs row
        where row.id = seed_run and row.state in ('applied', 'verified')
      ) into seed_run_valid;
    else
      select exists (
        select 1 from private.uniondemo_runs row
        where row.id = seed_run and row.state in ('applied', 'verified')
      ) into seed_run_valid;
    end if;
    seed_scope := (select auth.role()) = 'service_role'
      and seed_run_valid
      and (seed_scope_json ->> 'organizationId')::uuid = seed_organization
      and seed_organization = old.organization_id;
  exception when others then
    seed_scope := false;
  end;

  if row(old.is_restricted, old.restriction_reason, old.restricted_at, old.restricted_by)
     is distinct from
     row(new.is_restricted, new.restriction_reason, new.restricted_at, new.restricted_by)
     and not seed_scope
     and not private.casework_staff_can_access(old.id) then
    raise exception 'restricted-case fields require authorized staff' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke all on function private.guard_casework_restriction_update()
  from public, anon, authenticated, service_role;

create trigger member_cases_guard_restriction_insert
before insert on public.member_cases
for each row execute function private.guard_casework_restriction_update();

-- Three other paired actor/state constraints need the same historical-only
-- exception.  Any new active/decided/completed state still requires an actor;
-- a direct actor clear is refused even for a privileged application caller.
create function private.guard_casework_historical_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  case tg_table_name
    when 'casework_access_grants' then
      if tg_op = 'INSERT' then
        if new.revoked_at is not null and new.revoked_by is null then
          raise exception 'revoked grant requires an attribution actor' using errcode = '23514';
        end if;
      elsif new.revoked_at is not null and new.revoked_by is null then
        if old.revoked_at is not null and old.revoked_by is null then
          return new;
        end if;
        if old.revoked_by is not null
           and private.account_lifecycle_is_nested_auth_detachment(old.revoked_by, new.revoked_by)
           and (pg_catalog.to_jsonb(new) - 'revoked_by')
             is not distinct from (pg_catalog.to_jsonb(old) - 'revoked_by') then
          return new;
        end if;
        raise exception 'grant revocation attribution cannot be detached' using errcode = '42501';
      end if;
    when 'casework_deadline_extensions' then
      if tg_op = 'INSERT' then
        if new.status in ('approved', 'denied') and new.decided_by is null then
          raise exception 'deadline decision requires an attribution actor' using errcode = '23514';
        end if;
      elsif new.status in ('approved', 'denied') and new.decided_by is null then
        if old.status in ('approved', 'denied') and old.decided_by is null then
          return new;
        end if;
        if old.decided_by is not null
           and private.account_lifecycle_is_nested_auth_detachment(old.decided_by, new.decided_by)
           and (pg_catalog.to_jsonb(new) - 'decided_by')
             is not distinct from (pg_catalog.to_jsonb(old) - 'decided_by') then
          return new;
        end if;
        raise exception 'deadline decision attribution cannot be detached' using errcode = '42501';
      end if;
    when 'casework_checklist_items' then
      if tg_op = 'INSERT' then
        if new.completed_at is not null and new.completed_by is null then
          raise exception 'completed checklist item requires an attribution actor' using errcode = '23514';
        end if;
      elsif new.completed_at is not null and new.completed_by is null then
        if old.completed_at is not null and old.completed_by is null then
          return new;
        end if;
        if old.completed_by is not null
           and private.account_lifecycle_is_nested_auth_detachment(old.completed_by, new.completed_by)
           and (pg_catalog.to_jsonb(new) - 'completed_by')
             is not distinct from (pg_catalog.to_jsonb(old) - 'completed_by') then
          return new;
        end if;
        raise exception 'checklist completion attribution cannot be detached' using errcode = '42501';
      end if;
    else
      raise exception 'unsupported historical-attribution table' using errcode = '55000';
  end case;
  return new;
end;
$function$;

revoke all on function private.guard_casework_historical_attribution()
  from public, anon, authenticated, service_role;

create trigger casework_access_grants_guard_historical_attribution
before insert or update on public.casework_access_grants
for each row execute function private.guard_casework_historical_attribution();

create trigger casework_deadline_extensions_guard_historical_attribution
before insert or update on public.casework_deadline_extensions
for each row execute function private.guard_casework_historical_attribution();

create trigger casework_checklist_items_guard_historical_attribution
before insert or update on public.casework_checklist_items
for each row execute function private.guard_casework_historical_attribution();

-- Export completeness is discovered independently from the export manifest:
-- every direct public/private identity FK that cascades with auth.users is a
-- candidate member-owned relation and must be classified. `canonical` means
-- an existing hand-shaped privacy projection above owns it;
-- `additional_domains` means the bounded generic projection below owns it;
-- exclusions name why returning the raw relation would be dishonest or would
-- disclose credentials, another person's identity, staff work product, or
-- transport/security internals. This exact-key review list is intentionally
-- closed: a later cascading FK is unmanaged until a migration reviews it.
with reviewed_export(key, export_disposition, export_projection, exclusion_reason) as (
  values
    ('private.attachment_removal_receipts.requested_by', 'excluded_with_reason', null, 'Two-phase attachment-removal receipt; it records only the storage-protocol handles that prove a deletion completed, and the member-facing attachment rows are exported through their own file projections.'),
    ('private.assurance_synthetic_accounts.user_id', 'excluded_with_reason', null, 'Assurance-only synthetic ownership registry; exporting it would expose security-control metadata rather than member content.'),
    ('private.calendar_oauth_states.steward_id', 'excluded_with_reason', null, 'Short-lived OAuth control state; raw export could expose credential-adjacent material.'),
    ('private.constant_contact_oauth_states.requested_by', 'excluded_with_reason', null, 'Short-lived OAuth control state; raw export could expose credential-adjacent material.'),
    ('private.dues_financial_identity_selections.user_id', 'excluded_with_reason', null, 'Private provider-routing state; the member-facing dues records are exported through their product projection.'),
    ('private.dues_stripe_oauth_states.requested_by', 'excluded_with_reason', null, 'Short-lived OAuth control state; raw export could expose credential-adjacent material.'),
    ('private.google_drive_oauth_states.user_id', 'excluded_with_reason', null, 'Short-lived OAuth control state; raw export could expose credential-adjacent material.'),
    ('private.member_event_checkin_tokens.user_id', 'excluded_with_reason', null, 'Single-use security capability; it must never be copied into a portable export.'),
    ('private.member_mfa_recovery_locks.user_id', 'excluded_with_reason', null, 'MFA recovery lock holding a single-use claim digest; raw export could weaken account-recovery controls.'),
    ('private.member_mfa_reset_boundaries.user_id', 'excluded_with_reason', null, 'MFA reset security boundary; raw export could weaken account-recovery controls.'),
    ('private.member_native_push_registration_limits.user_id', 'excluded_with_reason', null, 'Abuse-control counter, not member-authored content.'),
    ('private.member_password_reissues.actor', 'excluded_with_reason', null, 'Password-recovery control record; raw export could expose another actor and security timing.'),
    ('private.member_password_reissues.target_user', 'excluded_with_reason', null, 'Password-recovery control record; raw export could expose security timing.'),
    ('private.member_session_closing_barriers.user_id', 'excluded_with_reason', null, 'Session-closing security barrier keyed by an opaque session handle; raw export could expose sign-out internals.'),
    ('private.member_session_revocations.user_id', 'excluded_with_reason', null, 'Session-security control record; raw export could expose revocation internals.'),
    ('private.member_signin_recoveries.actor', 'excluded_with_reason', null, 'Sign-in recovery control record; raw export could expose another actor and security timing.'),
    ('private.member_signin_recoveries.target_user', 'excluded_with_reason', null, 'Sign-in recovery control record; raw export could expose security timing.'),
    ('private.member_sms_preferences.user_id', 'excluded_with_reason', null, 'Private delivery configuration; the raw row can carry provider-facing control state.'),
    ('private.organization_analytics_idempotency_receipts.user_id', 'excluded_with_reason', null, 'Internal idempotency receipt, not member content.'),
    ('private.private_upload_inspection_attempts.actor_user_id', 'excluded_with_reason', null, 'Malware-inspection control state carrying the storage bucket and object path; it is security-control metadata, and the member-facing files are exported through their own file projections.'),
    ('private.private_upload_inspection_limits.user_id', 'excluded_with_reason', null, 'Abuse-control inspection quota counter, not member-authored content.'),
    ('private.steward_calendar_oauth_tokens.steward_id', 'excluded_with_reason', null, 'OAuth token custody; secrets must never enter a portable export.'),
    ('private.workload_reminder_preferences.user_id', 'excluded_with_reason', null, 'Private delivery schedule configuration; raw export can expose automation internals.'),
    ('public.case_alert_acknowledgements.user_id', 'excluded_with_reason', null, 'Shared casework state; raw export could expose protected staff-case identifiers.'),
    ('public.case_restriction_access.user_id', 'excluded_with_reason', null, 'Authorization grant, not caller-owned content; raw export could expose protected-case scope.'),
    ('public.casework_access_grants.grantee_user_id', 'excluded_with_reason', null, 'Authorization grant, not caller-owned content; raw export could expose protected-case scope and another actor.'),
    ('public.casework_intake_drafts.owner_user_id', 'excluded_with_reason', null, 'Staff-owned casework draft; it can contain protected work product about another member.'),
    ('public.casework_reminders.owner_user_id', 'excluded_with_reason', null, 'Staff-owned casework reminder; it can contain protected work product about another member.'),
    ('public.chapter_channel_poll_votes.user_id', 'included', 'additional_domains', null),
    ('public.chapter_governance_requests.requester_id', 'included', 'canonical', null),
    ('public.chapter_space_members.user_id', 'included', 'canonical', null),
    ('public.chapter_space_reads.user_id', 'excluded_with_reason', null, 'Ephemeral read cursor, not member-authored content.'),
    ('public.chapter_task_assignments.assignee_id', 'included', 'canonical', null),
    ('public.chapter_task_watchers.user_id', 'included', 'additional_domains', null),
    ('public.chapter_task_messages.recipient_id', 'included', 'canonical', null),
    ('public.chapter_task_messages.sender_id', 'included', 'canonical', null),
    ('public.compass_message_briefings.requested_by', 'included', 'additional_domains', null),
    ('public.compass_workspace_actions.actor_user_id', 'excluded_with_reason', null, 'Shared staff-workspace action can expose protected target records; it requires a dedicated privacy-safe projection.'),
    ('public.compass_workspace_preferences.user_id', 'included', 'additional_domains', null),
    ('public.coordinator_case_audit.user_id', 'excluded_with_reason', null, 'Staff audit work product about a case, not caller-authored content.'),
    ('public.engagement_delivery_outbox.recipient_user_id', 'excluded_with_reason', null, 'Transport queue state; raw export could expose delivery routing, leases, and error metadata.'),
    ('public.meeting_attendance.user_id', 'included', 'canonical', null),
    ('public.meeting_minutes_dispatches.recipient_id', 'included', 'canonical', null),
    ('public.member_access_events.subject_user_id', 'excluded_with_reason', null, 'Security access ledger; raw export could expose audit internals and another actor.'),
    ('public.member_accommodation_requests.member_user_id', 'excluded_with_reason', null, 'Row includes staff-only review notes and requires a dedicated member-safe projection.'),
    ('public.member_action_log.user_id', 'included', 'canonical', null),
    ('public.member_ai_requests.user_id', 'included', 'canonical', null),
    ('public.member_appointment_blackouts.steward_id', 'excluded_with_reason', null, 'Staff scheduling control can reveal shared operational availability.'),
    ('public.member_appointment_schedules.steward_id', 'excluded_with_reason', null, 'Staff scheduling control can reveal shared operational availability.'),
    ('public.member_appointments.user_id', 'included', 'canonical', null),
    ('public.member_ballot_receipts.user_id', 'included', 'canonical', null),
    ('public.member_ballot_votes.user_id', 'included', 'additional_domains', null),
    ('public.member_broadcast_receipts.user_id', 'included', 'additional_domains', null),
    ('public.member_calendar_busy.steward_id', 'excluded_with_reason', null, 'Calendar-derived busy blocks are provider/availability metadata and require a privacy-safe calendar projection.'),
    ('public.member_calendar_connections.steward_id', 'excluded_with_reason', null, 'Calendar connection control state can expose provider identifiers and must not be exported raw.'),
    ('public.member_calendar_feed_tokens.user_id', 'excluded_with_reason', null, 'Reusable calendar capability; secrets must never enter a portable export.'),
    ('public.member_calendar_import_events.steward_id', 'excluded_with_reason', null, 'Calendar import audit state can expose provider event identifiers and synchronization internals.'),
    ('public.member_case_contacts.user_id', 'excluded_with_reason', null, 'Coordinator-authored casework record; raw export could expose protected staff notes.'),
    ('public.member_case_files.user_id', 'included', 'canonical', null),
    ('public.member_case_outcomes.user_id', 'excluded_with_reason', null, 'Coordinator-authored casework record; raw export could expose protected staff notes.'),
    ('public.member_case_updates.user_id', 'included', 'canonical', null),
    ('public.member_cases.user_id', 'included', 'canonical', null),
    ('public.member_chapter_memberships.user_id', 'included', 'additional_domains', null),
    ('public.member_contact_notes.member_user_id', 'excluded_with_reason', null, 'Staff contact note about a member, not caller-authored content.'),
    ('public.member_conversations.user_id', 'included', 'canonical', null),
    ('public.member_emergency_checklists.member_user_id', 'included', 'additional_domains', null),
    ('public.member_event_checkins.user_id', 'included', 'canonical', null),
    ('public.member_event_rsvps.user_id', 'included', 'canonical', null),
    ('public.member_form_cosigners.invited_by', 'excluded_with_reason', null, 'Shared invitation row can identify another signer; caller-owned form status is already exported through the canonical form projection.'),
    ('public.member_form_files.deletion_requested_by', 'excluded_with_reason', null, 'Internal attachment-deletion attribution, not a member-owned file projection.'),
    ('public.member_form_files.uploaded_by', 'included', 'canonical', null),
    ('public.member_forms.user_id', 'included', 'canonical', null),
    ('public.member_guide_messages.user_id', 'included', 'canonical', null),
    ('public.member_guide_threads.user_id', 'included', 'canonical', null),
    ('public.member_handoffs.member_user_id', 'excluded_with_reason', null, 'Shared steward-assignment workflow can expose other staff identities and protected routing notes.'),
    ('public.member_handoffs.to_steward_id', 'excluded_with_reason', null, 'Essential staff-assignment relation, not the steward caller''s own member content.'),
    ('public.member_hr_contacts.member_user_id', 'excluded_with_reason', null, 'Staff-authored HR contact record can contain protected notes and another actor; it requires a dedicated member-safe projection.'),
    ('public.member_intake_reports.reporter_id', 'included', 'canonical', null),
    ('public.member_mentorship_pairs.mentee_user_id', 'excluded_with_reason', null, 'Shared relationship contains another member identity; it requires a privacy-safe relationship projection.'),
    ('public.member_mentorship_pairs.mentor_user_id', 'excluded_with_reason', null, 'Shared relationship contains another member identity; it requires a privacy-safe relationship projection.'),
    ('public.member_message_legal_holds.placed_by', 'excluded_with_reason', null, 'Legal-hold authority metadata is preservation control state, not caller-owned message content.'),
    ('public.member_message_legal_holds.released_by', 'excluded_with_reason', null, 'Legal-hold release attribution is preservation control state, not caller-owned message content.'),
    ('public.member_message_reactions.actor_id', 'included', 'additional_domains', null),
    ('public.member_message_reminders.owner_id', 'included', 'additional_domains', null),
    ('public.member_messages.redacted_by', 'excluded_with_reason', null, 'Message redaction attribution is audit metadata and must not expose another actor through a portable export.'),
    ('public.member_messages.sender_id', 'included', 'canonical', null),
    ('public.member_messages.user_id', 'included', 'canonical', null),
    ('public.member_native_push_installations.user_id', 'excluded_with_reason', null, 'Push token custody and device routing metadata must never enter a portable export.'),
    ('public.member_notification_deliveries.user_id', 'excluded_with_reason', null, 'Transport delivery state, not member-authored content.'),
    ('public.member_notifications.user_id', 'included', 'canonical', null),
    ('public.member_onboarding_plans.member_user_id', 'excluded_with_reason', null, 'Shared onboarding plan contains staff assignment identity and requires a dedicated member-safe projection.'),
    ('public.member_peer_contact_keys.user_id', 'excluded_with_reason', null, 'Cryptographic contact capability; key material must never enter a portable export.'),
    ('public.member_peer_contact_requests.recipient_id', 'included', 'canonical', null),
    ('public.member_peer_contact_requests.requester_id', 'included', 'canonical', null),
    ('public.member_peer_conversations.user_high', 'included', 'canonical', null),
    ('public.member_peer_conversations.user_low', 'included', 'canonical', null),
    ('public.member_peer_messages.sender_id', 'included', 'canonical', null),
    ('public.member_point_events.user_id', 'included', 'canonical', null),
    ('public.member_presence.user_id', 'excluded_with_reason', null, 'Ephemeral presence state, not durable member-authored content.'),
    ('public.member_profiles.id', 'included', 'canonical', null),
    ('public.member_push_subscriptions.user_id', 'excluded_with_reason', null, 'Web-push endpoint and key custody must never enter a portable export.'),
    ('public.member_qa_questions.author_user_id', 'included', 'canonical', null),
    ('public.member_qa_replies.author_user_id', 'included', 'canonical', null),
    ('public.member_qa_votes.user_id', 'included', 'additional_domains', null),
    ('public.member_report_preferences.user_id', 'included', 'additional_domains', null),
    ('public.member_reward_grants.user_id', 'included', 'canonical', null),
    ('public.member_reward_tier_attainment.user_id', 'included', 'additional_domains', null),
    ('public.member_rights_progress.user_id', 'included', 'canonical', null),
    ('public.member_roles.user_id', 'included', 'canonical', null),
    ('public.member_saved_messages.owner_id', 'included', 'additional_domains', null),
    ('public.member_scheduled_messages.actor_id', 'included', 'canonical', null),
    ('public.member_scheduled_messages.recipient_id', 'excluded_with_reason', null, 'Another member''s unsent scheduled-message metadata is not recipient-owned content.'),
    ('public.member_steward_relationships.member_user_id', 'excluded_with_reason', null, 'Shared relationship contains another user identity and requires a privacy-safe relationship projection.'),
    ('public.member_steward_relationships.steward_user_id', 'excluded_with_reason', null, 'Essential staff-assignment relation, not the steward caller''s own member content.'),
    ('public.member_steward_requests.user_id', 'included', 'canonical', null),
    ('public.member_survey_responses.user_id', 'included', 'canonical', null),
    ('public.member_weekly_question_promotions.user_id', 'included', 'additional_domains', null),
    ('public.member_weekly_question_supports.user_id', 'included', 'additional_domains', null),
    ('public.member_weekly_questions.user_id', 'included', 'additional_domains', null),
    ('public.member_welcome_enrollments.member_user_id', 'excluded_with_reason', null, 'Shared onboarding record includes staff enrollment attribution and requires a dedicated member-safe projection.'),
    ('public.member_workload_logs.user_id', 'included', 'canonical', null),
    ('public.mfa_recovery_code_sets.user_id', 'excluded_with_reason', null, 'MFA recovery secret metadata must never enter a portable export.'),
    ('public.mfa_recovery_codes.user_id', 'excluded_with_reason', null, 'MFA recovery material must never enter a portable export.'),
    ('public.organization_analytics_layouts.owner_user_id', 'excluded_with_reason', null, 'Organization-shared analytics configuration, not caller-owned member content.'),
    ('public.organization_coordination_user_participants.user_id', 'excluded_with_reason', null, 'Shared inter-organization participant relation can expose external-party identity and permissions.'),
    ('public.organization_engagement_events.user_id', 'included', 'additional_domains', null),
    ('public.organization_live_poll_attendance.user_id', 'excluded_with_reason', null, 'Shared attendance row includes staff check-in attribution and requires a member-safe projection.'),
    ('public.organization_live_poll_votes.voter_user_id', 'included', 'additional_domains', null),
    ('public.organization_member_operational_profiles.member_user_id', 'excluded_with_reason', null, 'Staff-authored operational profile, not caller-authored content.'),
    ('public.organization_memberships.user_id', 'included', 'additional_domains', null),
    ('public.organization_merge_match_reviews.source_user_id', 'excluded_with_reason', null, 'Administrative duplicate-account review can expose another account identity.'),
    ('public.organization_merge_match_reviews.target_user_id', 'excluded_with_reason', null, 'Administrative duplicate-account review can expose another account identity.'),
    ('public.organization_pulse_events.user_id', 'included', 'additional_domains', null),
    ('public.organization_survey_deliveries.recipient_user_id', 'excluded_with_reason', null, 'Transport delivery state, not member-authored survey content.'),
    ('public.organization_survey_sessions.respondent_user_id', 'excluded_with_reason', null, 'Session row alone omits its answer children; a complete privacy-safe joined projection is required before inclusion.')
), parsed_review as (
  select
    pg_catalog.split_part(key, '.', 1) as schema_name,
    pg_catalog.split_part(key, '.', 2) as table_name,
    pg_catalog.split_part(key, '.', 3) as user_column,
    export_disposition,
    export_projection,
    exclusion_reason
  from reviewed_export
)
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition,
   export_disposition, export_projection, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
select schema_name, table_name, user_column, 'not_applicable',
       export_disposition, export_projection, 'auth_user_fk', exclusion_reason,
       'Reviewed against the independent direct auth.users FK inventory.',
       date '2026-09-03'
from parsed_review
on conflict (schema_name, table_name, user_column) do update
set export_disposition = excluded.export_disposition,
    export_projection = excluded.export_projection,
    export_inventory_basis = excluded.export_inventory_basis,
    exclusion_reason = excluded.exclusion_reason,
    reviewed_at = excluded.reviewed_at;

-- ON DELETE SET NULL preserves authored and attributed rows after account deletion,
-- but the delete action does not decide whether the live row belongs in the
-- member's export. Freeze every direct SET NULL identity link in the same
-- reviewed inventory; explicit projections and exclusions decide disposition.
with reviewed_set_null_export(key, export_disposition, export_projection, exclusion_reason) as (
  values
    ('private.constant_contact_oauth_tokens.connected_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('private.dues_financial_identity_selections.selected_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('private.member_event_checkin_tokens.consumed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('private.member_form_signatures.signer_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('private.member_mfa_reset_boundaries.reset_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('private.member_native_push_installation_audit.user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_checklist_progress.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_deadline_audit.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_deadline_changes.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_deadline_changes.reviewed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_reminders.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_restriction_access.granted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_restrictions.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.case_step_transitions.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_access_grants.granted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_access_grants.revoked_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_alert_acknowledgements.acknowledged_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_alerts.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_audit_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_bargaining_events.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_bargaining_proposals.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_bargaining_workspaces.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_checklist_items.completed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_checklist_templates.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_checklists.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_deadline_extensions.decided_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_deadline_extensions.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_deadlines.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_entity_links.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_intake_drafts.member_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_management_addenda.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_management_entries.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_management_people.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_retaliation_pattern_notes.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_retaliation_patterns.reviewed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_retaliation_reports.reporter_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_step_transitions.transitioned_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.casework_strength_analyses.analyzed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_channel_polls.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_connection_readiness.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_contact_log.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_contact_log.subject_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_contact_log.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_documents.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_governance_requests.handled_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_handshake_documents.shared_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_handshake_events.actor', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_handshakes.countersigned_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_handshakes.receiver_signed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_handshakes.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_handshakes.requester_signed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_health_coaching.author_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_health_snapshots.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_health_snapshots.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_record_versions.changed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_records.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_space_controls.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_spaces.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_activity.actor_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_assignments.assigned_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_attachments.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_comments.author_id', 'excluded_with_reason', null, 'Retained shared task-thread content is not a caller-owned canonical export domain; a dedicated authorized projection is required before inclusion.'),
    ('public.chapter_task_dependencies.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_files.uploaded_by', 'included', 'canonical', null),
    ('public.chapter_task_subtasks.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_template_details.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_template_details.reviewer_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_task_template_details.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_tasks.assignee_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_tasks.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_tasks.deleted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_tasks.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_thread_posts.author_id', 'included', 'additional_domains', null),
    ('public.chapter_threads.created_by', 'included', 'additional_domains', null),
    ('public.chapter_union_org_bindings.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_union_org_bindings.verified_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.chapter_workstreams.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.compass_ai_policy.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.compass_ai_role_limits.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.constant_contact_sync_requests.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.constant_contact_sync_runs.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.contract_clauses.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.coordinator_case_audit.actor_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.digital_action_exports.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.digital_actions.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.digital_actions.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.dues_assessment_batches.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.dues_checkout_reservations.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.dues_ledger_events.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.dues_member_subjects.user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.dues_reminder_attempts.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.form_templates.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.integration_jobs.target_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.knowledge_collection_items.added_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.knowledge_collections.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.knowledge_collections.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.meeting_attendance.recorded_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_access_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_admin_audit.actor', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_admin_audit.target_user', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_appointment_events.actor', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_appointments.cancelled_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_appointments.steward_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_ballots.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_broadcasts.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_case_contacts.coordinator_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_case_files.uploaded_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_case_outcomes.recorded_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_cases.coordinator_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_cases.restricted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_cases.steward_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_contact_notes.author_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_event_checkins.scanned_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_form_cosigners.cosigner_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_forms.artifact_approved_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_handoffs.from_steward_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_handoffs.initiated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_hr_contacts.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_intake_reports.assigned_to', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_invitation_audit.actor', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_invitations.auth_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_invitations.invited_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_mentorship_goals.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_mentorship_notes.author_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_mentorship_pairs.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_message_resources.added_by', 'included', 'additional_domains', null),
    ('public.member_onboarding_plans.assigned_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_reward_economy_revisions.actor_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_reward_grants.granted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_reward_grants.revoked_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_role_chapters.granted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_roles.granted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_steward_requests.handled_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_support_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_support_events.member_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_surveys.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.member_welcome_enrollments.enrolled_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.org_security_policy.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_analytics_exports.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_analytics_layout_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_audit_ledger.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_automation_definitions.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_automation_definitions.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_automation_effects.rolled_back_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_automation_runs.initiated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_automation_runs.rolled_back_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_automation_settings.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_chart_nodes.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_chart_nodes.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coalition_decision_votes.voter_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coalition_decisions.proposed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_configuration_audit.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_export_runs.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_messages.sender_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_organization_participants.invited_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_organization_participants.responded_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_outreach_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_page_attachments.attached_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_records.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_coordination_resources.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_data_export_runs.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_failed_login_attempts.member_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_failed_login_attempts.reviewed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_field_note_blocks.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_field_note_packets.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_field_note_sources.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_hr_directory.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_import_batches.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_intelligence_audit_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_job_acknowledgements.acknowledged_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_knowledge_files.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_label_overrides.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_live_poll_attendance.check_in_actor', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_live_polls.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_member_operational_profiles.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_merge_jobs.executed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_merge_jobs.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_merge_match_reviews.reviewed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_merge_remap_events.executed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_network_access_events.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_network_directory_profiles.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_network_permission_grants.granted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_object_action_runs.actor_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_onboarding_steps.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_poms_evidence.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_poms_sources.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_pulse_prompts.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_relationships.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_relationships.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_retention_policies.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_retention_runs.authorized_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_retention_runs.requested_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_role_grants.granted_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_setting_values.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_survey_reviews.assigned_to', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_survey_tasks.assigned_to', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_survey_tasks.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_surveys.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_surveys.owner_user_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_timeline_events.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_timeline_events.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_topic_progress.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_welcome_campaigns.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organization_welcome_campaigns.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.organizations.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.public_chapter_page_attachments.attached_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.public_chapter_page_takeovers.new_owner_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.public_chapter_page_takeovers.previous_owner_id', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.public_chapter_pages.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.public_chapter_sections.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.public_site_records.created_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.steward_email_intakes.reviewed_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.'),
    ('public.weekly_question_selection_policies.updated_by', 'excluded_with_reason', null, 'Retained, shared, staff, security, or control attribution is not caller-owned portable content; a dedicated privacy-safe projection is required before inclusion.')
), parsed_set_null_review as (
  select pg_catalog.split_part(key, '.', 1) as schema_name,
         pg_catalog.split_part(key, '.', 2) as table_name,
         pg_catalog.split_part(key, '.', 3) as user_column,
         export_disposition, export_projection, exclusion_reason
  from reviewed_set_null_export
)
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition,
   export_disposition, export_projection, export_inventory_basis,
   exclusion_reason, note, reviewed_at)
select schema_name, table_name, user_column, 'not_applicable',
       export_disposition, export_projection, 'auth_user_fk', exclusion_reason,
       'Reviewed against the complete direct auth.users ownership inventory; installed action is ON DELETE SET NULL.',
       date '2026-09-07'
from parsed_set_null_review
on conflict (schema_name, table_name, user_column) do update
set export_disposition = excluded.export_disposition,
    export_projection = excluded.export_projection,
    export_inventory_basis = excluded.export_inventory_basis,
    exclusion_reason = excluded.exclusion_reason,
    reviewed_at = excluded.reviewed_at;

-- Versioned paths tie every `canonical` label to a concrete hand-shaped
-- location in get_member_data_export(). The local verifier independently pins
-- this map, confirms that every path exists, and checks that the installed
-- exporter definition actually names the source relation.
with canonical_projection(key, export_domain) as (
  values
    ('public.chapter_governance_requests.requester_id', 'support.dataRequests'),
    ('public.chapter_space_members.user_id', 'chapterParticipation.spaceMemberships'),
    ('public.chapter_task_assignments.assignee_id', 'chapterParticipation.taskAssignments'),
    ('public.chapter_task_files.uploaded_by', 'additionalDomains.chapter_task_files'),
    ('public.chapter_task_messages.recipient_id', 'chapterParticipation.taskMessages'),
    ('public.chapter_task_messages.sender_id', 'chapterParticipation.taskMessages'),
    ('public.meeting_attendance.user_id', 'additionalDomains.meeting_attendance'),
    ('public.meeting_minutes_dispatches.recipient_id', 'additionalDomains.meeting_minutes_dispatches'),
    ('public.member_action_log.user_id', 'activity.actions'),
    ('public.member_ai_requests.user_id', 'compass.requestHistory'),
    ('public.member_appointments.user_id', 'support.appointments'),
    ('public.member_ballot_receipts.user_id', 'participation.ballotReceipts'),
    ('public.member_case_files.user_id', 'additionalDomains.member_case_files'),
    ('public.member_case_updates.user_id', 'cases[].updates'),
    ('public.member_cases.user_id', 'cases'),
    ('public.member_conversations.user_id', 'conversations'),
    ('public.member_event_checkins.user_id', 'participation.eventCheckins'),
    ('public.member_event_rsvps.user_id', 'participation.eventRsvps'),
    ('public.member_form_files.uploaded_by', 'additionalDomains.member_form_files'),
    ('public.member_forms.user_id', 'forms'),
    ('public.member_guide_messages.user_id', 'compass.threads[].messages'),
    ('public.member_guide_threads.user_id', 'compass.threads'),
    ('public.member_intake_reports.reporter_id', 'support.intakeReports'),
    ('public.member_messages.sender_id', 'conversations[].messages'),
    ('public.member_messages.user_id', 'conversations[].messages'),
    ('public.member_notifications.user_id', 'notifications'),
    ('public.member_peer_contact_requests.recipient_id', 'peerContact.requests'),
    ('public.member_peer_contact_requests.requester_id', 'peerContact.requests'),
    ('public.member_peer_conversations.user_high', 'peerContact.conversations'),
    ('public.member_peer_conversations.user_low', 'peerContact.conversations'),
    ('public.member_peer_messages.sender_id', 'peerContact.conversations[].messages'),
    ('public.member_point_events.user_id', 'activity.points'),
    ('public.member_profiles.id', 'account.profile'),
    ('public.member_qa_questions.author_user_id', 'additionalDomains.member_qa_questions'),
    ('public.member_qa_replies.author_user_id', 'additionalDomains.member_qa_replies'),
    ('public.member_reward_grants.user_id', 'activity.rewards'),
    ('public.member_rights_progress.user_id', 'participation.rightsProgress'),
    ('public.member_roles.user_id', 'account.roles'),
    ('public.member_scheduled_messages.actor_id', 'additionalDomains.member_scheduled_messages'),
    ('public.member_steward_requests.user_id', 'support.stewardRequests'),
    ('public.member_survey_responses.user_id', 'participation.surveyResponses'),
    ('public.member_workload_logs.user_id', 'activity.workload')
), parsed_projection as (
  select pg_catalog.split_part(key, '.', 1) as schema_name,
         pg_catalog.split_part(key, '.', 2) as table_name,
         pg_catalog.split_part(key, '.', 3) as user_column,
         export_domain
  from canonical_projection
)
update private.account_lifecycle_manifest manifest
set export_projection_version = 1,
    export_domain = projection.export_domain,
    export_columns = null
from parsed_projection projection
where manifest.schema_name = projection.schema_name
  and manifest.table_name = projection.table_name
  and manifest.user_column = projection.user_column
  and manifest.export_disposition = 'included'
  and manifest.export_projection = 'canonical';

-- Generic projections are allowed only for these explicitly reviewed columns.
-- In particular, no storage path, capability/token, provider field, dispatch
-- failure detail, or another person's user id is selected by t.*.
with safe_additional(key, export_columns) as (
  values
    ('public.chapter_thread_posts.author_id', array['id','thread_id','chapter_id','author_id','body','parent_post_id','created_at','edited_at','deleted_at','author_name','author_initials','author_role']::text[]),
    ('public.chapter_threads.created_by', array['id','space_id','chapter_id','title','kind','status','created_by','task_id','case_id','resolved_at','created_at','updated_at']::text[]),
    ('public.chapter_channel_poll_votes.user_id', array['poll_id','option_id','user_id','created_at','updated_at']::text[]),
    ('public.chapter_task_watchers.user_id', array['user_id','task_id','chapter_id','created_at']::text[]),
    ('public.compass_message_briefings.requested_by', array['id','organization_id','requested_by','source_kind','target_id','summary','action_items','created_at']::text[]),
    ('public.compass_workspace_preferences.user_id', array['organization_id','user_id','module_order','hidden_modules','updated_at']::text[]),
    ('public.member_ballot_votes.user_id', array['ballot_id','option_id','user_id','submitted_at']::text[]),
    ('public.member_broadcast_receipts.user_id', array['broadcast_id','user_id','read_at']::text[]),
    ('public.member_chapter_memberships.user_id', array['user_id','chapter_id','status','pinned','last_selected_at','joined_at','revoked_at']::text[]),
    ('public.member_emergency_checklists.member_user_id', array['id','organization_id','member_user_id','scenario','status','completed_steps','notes','alerted_at','resolved_at','created_at','updated_at']::text[]),
    ('public.member_message_reactions.actor_id', array['id','actor_id','source_kind','private_message_id','channel_post_id','task_message_id','reaction','created_at']::text[]),
    ('public.member_message_reminders.owner_id', array['id','owner_id','source_kind','private_message_id','channel_post_id','task_message_id','note','remind_at','status','created_at','delivered_at']::text[]),
    ('public.member_message_resources.added_by', array['id','message_id','document_id','added_by','created_at']::text[]),
    ('public.member_qa_votes.user_id', array['organization_id','user_id','question_id','reply_id','created_at']::text[]),
    ('public.member_report_preferences.user_id', array['user_id','config','updated_at']::text[]),
    ('public.member_reward_tier_attainment.user_id', array['user_id','highest_tier','attained_at','updated_at']::text[]),
    ('public.member_saved_messages.owner_id', array['id','owner_id','source_kind','private_message_id','channel_post_id','task_message_id','saved_at']::text[]),
    ('public.member_weekly_question_promotions.user_id', array['question_id','reward_grant_id','organization_id','chapter_id','user_id','promoted_at']::text[]),
    ('public.member_weekly_question_supports.user_id', array['question_id','user_id','created_at']::text[]),
    ('public.member_weekly_questions.user_id', array['id','chapter_id','user_id','week_start','body','options','editorial_state','published_survey_id','created_at','updated_at']::text[]),
    ('public.organization_engagement_events.user_id', array['organization_id','user_id','chapter_id','event_type','source_id','occurred_at']::text[]),
    ('public.organization_live_poll_votes.voter_user_id', array['organization_id','poll_id','option_id','voter_user_id','created_at','updated_at']::text[]),
    ('public.organization_memberships.user_id', array['organization_id','user_id','status','created_at','revoked_at']::text[]),
    ('public.organization_pulse_events.user_id', array['id','organization_id','prompt_id','user_id','context_key','state','response_value','shown_at','responded_at','updated_at']::text[])
), parsed_additional as (
  select pg_catalog.split_part(key, '.', 1) as schema_name,
         pg_catalog.split_part(key, '.', 2) as table_name,
         pg_catalog.split_part(key, '.', 3) as user_column,
         export_columns
  from safe_additional
)
update private.account_lifecycle_manifest manifest
set export_projection_version = 1,
    export_domain = 'additionalDomains.' || additional.table_name,
    export_columns = additional.export_columns
from parsed_additional additional
where manifest.schema_name = additional.schema_name
  and manifest.table_name = additional.table_name
  and manifest.user_column = additional.user_column
  and manifest.export_disposition = 'included'
  and manifest.export_projection = 'additional_domains';

alter table private.account_lifecycle_manifest
  add constraint account_lifecycle_manifest_export_projection_shape check (
    (export_disposition = 'included' and export_projection = 'canonical'
      and export_projection_version = 1
      and pg_catalog.length(pg_catalog.btrim(export_domain)) > 0
      and export_columns is null)
    or (export_disposition = 'included' and export_projection = 'additional_domains'
      and export_projection_version = 1
      and export_domain = 'additionalDomains.' || table_name
      and pg_catalog.cardinality(export_columns) > 0
      and pg_catalog.array_to_string(export_columns, ',')
        ~ '^[a-z_][a-z0-9_]*(,[a-z_][a-z0-9_]*)*$')
    or (export_disposition <> 'included'
      and export_projection_version is null
      and export_domain is null
      and export_columns is null)
  );

-- Fail the migration itself if a reviewed allowlist drifts from the physical
-- table or reintroduces a field class that must have a hand-shaped projection.
do $do$
declare
  rec record;
  column_name text;
begin
  for rec in
    select schema_name, table_name, export_columns
    from private.account_lifecycle_manifest
    where export_disposition = 'included'
      and export_projection = 'additional_domains'
  loop
    foreach column_name in array rec.export_columns
    loop
      if column_name ~ '(token|secret|password|object_name|bucket_id|provider|idempotency_key)'
         or column_name in ('recipient_id', 'recorded_by', 'failure_reason') then
        raise exception 'unsafe generic export column %.%.%', rec.schema_name, rec.table_name, column_name;
      end if;
      if not exists (
        select 1
        from pg_catalog.pg_attribute attribute
        join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = rec.schema_name
          and relation.relname = rec.table_name
          and attribute.attname = column_name
          and attribute.attnum > 0
          and not attribute.attisdropped
      ) then
        raise exception 'generic export column %.%.% does not exist', rec.schema_name, rec.table_name, column_name;
      end if;
    end loop;
  end loop;
end;
$do$;

-- Direct auth.users rows above cover root-level attribution. This companion
-- manifest covers every restrictive edge below a relation reached by an ON
-- DELETE CASCADE from auth.users. `pseudonymize` means retain the row and SET
-- NULL only the listed child reference columns; `cascade` means the dependent
-- row has no honest existence without its parent. Keep the reason next to each
-- retained relation: it is the review record for retention and legal-hold
-- analysis, not an invitation to delete historical evidence.
create table private.account_lifecycle_transitive_fk_manifest (
  parent_schema_name text not null,
  parent_table_name text not null,
  schema_name text not null,
  table_name text not null,
  constraint_name text not null,
  delete_disposition text not null check (delete_disposition in ('cascade', 'pseudonymize')),
  set_null_columns text[] not null default '{}'::text[],
  defer_constraint boolean not null default false,
  review_reason text not null check (pg_catalog.length(pg_catalog.btrim(review_reason)) > 0),
  reviewed_at date not null default current_date,
  primary key (schema_name, table_name, constraint_name),
  check (
    (delete_disposition = 'cascade' and pg_catalog.cardinality(set_null_columns) = 0)
    or (delete_disposition = 'pseudonymize' and pg_catalog.cardinality(set_null_columns) > 0)
  )
);

revoke all on private.account_lifecycle_transitive_fk_manifest from public, anon, authenticated, service_role;

insert into private.account_lifecycle_transitive_fk_manifest
  (parent_schema_name, parent_table_name, schema_name, table_name, constraint_name,
   delete_disposition, set_null_columns, review_reason)
values
  ('public', 'member_cases', 'public', 'case_deadline_changes', 'case_deadline_changes_case_id_fkey',
   'pseudonymize', array['case_id'], 'Deadline-change history remains available to retention and legal-hold review after its deleted member case is detached.'),
  ('public', 'member_cases', 'public', 'case_deadline_audit', 'case_deadline_audit_case_id_fkey',
   'pseudonymize', array['case_id'], 'Append-only deadline audit history is retained; compensating deletion is prohibited, so only the deleted case reference detaches.'),
  ('public', 'member_cases', 'public', 'casework_audit_events', 'casework_audit_events_case_id_organization_id_chapter_id_fkey',
   'pseudonymize', array['case_id'], 'Casework audit evidence survives account deletion and any legal hold; organization and chapter scope remain while the deleted case reference detaches.'),
  ('public', 'member_cases', 'public', 'casework_intake_drafts', 'casework_intake_drafts_case_id_organization_id_chapter_id_fkey',
   'pseudonymize', array['case_id'], 'An optimistic-concurrency staff intake draft can predate or outlive a case; retain its scoped work product while detaching the deleted case.'),
  ('public', 'member_cases', 'public', 'casework_management_entries', 'casework_management_entries_case_id_organization_id_chapte_fkey',
   'pseudonymize', array['case_id'], 'Immutable behavior observations are corrected by addenda, not deleted; detach only the deleted case reference.'),
  ('public', 'member_cases', 'public', 'casework_retaliation_reports', 'casework_retaliation_reports_case_id_organization_id_chapt_fkey',
   'pseudonymize', array['case_id'], 'Retaliation intake has an explicit withdrawal lifecycle and is retained for review; detach only the deleted case reference.'),
  ('public', 'member_cases', 'public', 'member_case_assignment_audit', 'member_case_assignment_audit_case_id_fkey',
   'pseudonymize', array['case_id'], 'Assignment audit remains historical evidence after the member case is removed; the case reference is detachable.'),
  ('public', 'member_profiles', 'public', 'member_vp_case_reviews', 'member_vp_case_reviews_reviewed_by_fkey',
   'pseudonymize', array['reviewed_by'], 'A VP review is retained as staff workflow history while a departed reviewer identity is detached.'),
  ('public', 'member_reward_grants', 'public', 'member_weekly_question_promotions', 'member_weekly_question_promotions_reward_grant_id_fkey',
   'cascade', '{}'::text[], 'A promotion has no independent subject once its reward grant is deleted.'),
  ('public', 'organization_memberships', 'public', 'organization_coordination_outreach_events', 'organization_coordination_out_organization_id_target_user__fkey',
   'cascade', '{}'::text[], 'A coordination outreach event targets a membership subject and cannot remain truthful after that membership is deleted.'),
  ('public', 'organization_memberships', 'public', 'organization_relationships', 'organization_relationships_organization_id_source_user_id_fkey',
   'cascade', '{}'::text[], 'A staff relationship graph edge has no valid source endpoint after its membership subject is deleted.'),
  ('public', 'organization_memberships', 'public', 'organization_relationships', 'organization_relationships_organization_id_target_user_id_fkey',
   'cascade', '{}'::text[], 'A staff relationship graph edge has no valid target endpoint after its membership subject is deleted.'),
  ('public', 'organization_memberships', 'public', 'organization_topic_progress', 'organization_topic_progress_organization_id_member_user_id_fkey',
   'cascade', '{}'::text[], 'Member topic progress is an essential membership-owned progress row and has no subject after deletion.'),
  ('public', 'casework_alerts', 'public', 'casework_alert_acknowledgements', 'casework_alert_acknowledgements_alert_id_organization_id_fkey',
   'cascade', '{}'::text[], 'An acknowledgement cannot exist independently of the cascading alert it acknowledges.'),
  ('public', 'casework_deadlines', 'public', 'casework_deadline_extensions', 'casework_deadline_extensions_deadline_id_organization_id_fkey',
   'pseudonymize', array['deadline_id'], 'Append-only deadline extension decisions are retained for audit and legal-hold review while the deleted deadline reference detaches.');

-- This nested retained history also has direct Auth-attribution detachment.
-- Deferring its parent check to transaction end makes the two referential
-- actions commute: the row has both references cleared before the final check.
update private.account_lifecycle_transitive_fk_manifest
set defer_constraint = true
where constraint_name = 'casework_deadline_extensions_deadline_id_organization_id_fkey';

-- Apply the reviewed transitive closure as explicit DDL generated from the
-- fresh merged catalogue. The manifest-backed invariant below still detects
-- missing, stale, duplicate, or action-mismatched edges at every depth.
alter table public.casework_alert_acknowledgements drop constraint casework_alert_acknowledgements_alert_id_organization_id_fkey;
alter table public.casework_deadline_extensions drop constraint casework_deadline_extensions_deadline_id_organization_id_fkey;
alter table public.case_deadline_audit drop constraint case_deadline_audit_case_id_fkey;
alter table public.case_deadline_changes drop constraint case_deadline_changes_case_id_fkey;
alter table public.casework_audit_events drop constraint casework_audit_events_case_id_organization_id_chapter_id_fkey;
alter table public.casework_intake_drafts drop constraint casework_intake_drafts_case_id_organization_id_chapter_id_fkey;
alter table public.casework_management_entries drop constraint casework_management_entries_case_id_organization_id_chapte_fkey;
alter table public.casework_retaliation_reports drop constraint casework_retaliation_reports_case_id_organization_id_chapt_fkey;
alter table public.member_case_assignment_audit drop constraint member_case_assignment_audit_case_id_fkey;
alter table public.member_vp_case_reviews drop constraint member_vp_case_reviews_reviewed_by_fkey;
alter table public.member_weekly_question_promotions drop constraint member_weekly_question_promotions_reward_grant_id_fkey;
alter table public.organization_coordination_outreach_events drop constraint organization_coordination_out_organization_id_target_user__fkey;
alter table public.organization_relationships drop constraint organization_relationships_organization_id_source_user_id_fkey;
alter table public.organization_relationships drop constraint organization_relationships_organization_id_target_user_id_fkey;
alter table public.organization_topic_progress drop constraint organization_topic_progress_organization_id_member_user_id_fkey;
alter table public.casework_alert_acknowledgements add constraint casework_alert_acknowledgements_alert_id_organization_id_fkey foreign key (alert_id, organization_id) references public.casework_alerts (id, organization_id) on update no action on delete cascade;
alter table public.casework_deadline_extensions alter column deadline_id drop not null;
alter table public.casework_deadline_extensions add constraint casework_deadline_extensions_deadline_id_organization_id_fkey foreign key (deadline_id, organization_id) references public.casework_deadlines (id, organization_id) on update no action on delete set null (deadline_id) deferrable initially deferred;
alter table public.case_deadline_audit alter column case_id drop not null;
alter table public.case_deadline_audit add constraint case_deadline_audit_case_id_fkey foreign key (case_id) references public.member_cases (id) on update no action on delete set null (case_id);
alter table public.case_deadline_changes alter column case_id drop not null;
alter table public.case_deadline_changes add constraint case_deadline_changes_case_id_fkey foreign key (case_id) references public.member_cases (id) on update no action on delete set null (case_id);
alter table public.casework_audit_events alter column case_id drop not null;
alter table public.casework_audit_events add constraint casework_audit_events_case_id_organization_id_chapter_id_fkey foreign key (case_id, organization_id, chapter_id) references public.member_cases (id, organization_id, chapter_id) on update no action on delete set null (case_id);
alter table public.casework_intake_drafts alter column case_id drop not null;
alter table public.casework_intake_drafts add constraint casework_intake_drafts_case_id_organization_id_chapter_id_fkey foreign key (case_id, organization_id, chapter_id) references public.member_cases (id, organization_id, chapter_id) on update no action on delete set null (case_id);
alter table public.casework_management_entries alter column case_id drop not null;
alter table public.casework_management_entries add constraint casework_management_entries_case_id_organization_id_chapte_fkey foreign key (case_id, organization_id, chapter_id) references public.member_cases (id, organization_id, chapter_id) on update no action on delete set null (case_id);
alter table public.casework_retaliation_reports alter column case_id drop not null;
alter table public.casework_retaliation_reports add constraint casework_retaliation_reports_case_id_organization_id_chapt_fkey foreign key (case_id, organization_id, chapter_id) references public.member_cases (id, organization_id, chapter_id) on update no action on delete set null (case_id);
alter table public.member_case_assignment_audit alter column case_id drop not null;
alter table public.member_case_assignment_audit add constraint member_case_assignment_audit_case_id_fkey foreign key (case_id) references public.member_cases (id) on update no action on delete set null (case_id);
alter table public.member_vp_case_reviews alter column reviewed_by drop not null;
alter table public.member_vp_case_reviews add constraint member_vp_case_reviews_reviewed_by_fkey foreign key (reviewed_by) references public.member_profiles (id) on update no action on delete set null (reviewed_by);
alter table public.member_weekly_question_promotions add constraint member_weekly_question_promotions_reward_grant_id_fkey foreign key (reward_grant_id) references public.member_reward_grants (id) on update no action on delete cascade;
alter table public.organization_coordination_outreach_events add constraint organization_coordination_out_organization_id_target_user__fkey foreign key (organization_id, target_user_id) references public.organization_memberships (organization_id, user_id) on update no action on delete cascade;
alter table public.organization_relationships add constraint organization_relationships_organization_id_source_user_id_fkey foreign key (organization_id, source_user_id) references public.organization_memberships (organization_id, user_id) on update no action on delete cascade;
alter table public.organization_relationships add constraint organization_relationships_organization_id_target_user_id_fkey foreign key (organization_id, target_user_id) references public.organization_memberships (organization_id, user_id) on update no action on delete cascade;
alter table public.organization_topic_progress add constraint organization_topic_progress_organization_id_member_user_id_fkey foreign key (organization_id, member_user_id) references public.organization_memberships (organization_id, user_id) on update no action on delete cascade;

-- Bidirectional deletion inventory invariant. It detects an unreviewed
-- restrictive FK at the auth.users root or at every descendant reached through
-- ON DELETE CASCADE, and proves every reviewed disposition is still backed by
-- exactly one FK with the expected delete action.
create function private.account_lifecycle_unmanaged_restrictive_fks()
returns table (
  schema_name text,
  table_name text,
  user_column text,
  constraint_name text,
  inventory_issue text,
  parent_schema_name text,
  parent_table_name text,
  cascade_depth integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive cascade_nodes as (
    select 'auth.users'::regclass as relation_oid, 0::integer as cascade_depth,
      array['auth.users'::regclass] as relation_path
    union all
    select child_constraint.conrelid, cascade_nodes.cascade_depth + 1,
      cascade_nodes.relation_path || child_constraint.conrelid
    from cascade_nodes
    join pg_catalog.pg_constraint child_constraint
      on child_constraint.contype = 'f'
     and child_constraint.confrelid = cascade_nodes.relation_oid
     and child_constraint.confdeltype = 'c'
    where not child_constraint.conrelid = any(cascade_nodes.relation_path)
  ), reachable as (
    select relation_oid, pg_catalog.min(cascade_depth) as cascade_depth
    from cascade_nodes
    group by relation_oid
  ), expected as (
    select m.schema_name, m.table_name, m.user_column,
      case m.delete_disposition when 'cascade' then 'c'::"char" else 'n'::"char" end as expected_action
    from private.account_lifecycle_manifest m
    where m.delete_disposition in ('cascade', 'pseudonymize')
  ), direct_catalog as (
    select n.nspname as schema_name, c.relname as table_name,
      a.attname as user_column, con.conname as constraint_name,
      con.confdeltype
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.unnest(con.conkey) with ordinality as k(attnum, ord) on true
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and pg_catalog.array_length(con.conkey, 1) = 1
  ), expected_issues as (
    select expected.schema_name, expected.table_name, expected.user_column,
      pg_catalog.string_agg(catalog.constraint_name, ',' order by catalog.constraint_name) as constraint_name,
      case
        when pg_catalog.count(catalog.constraint_name) = 0 then 'stale-review'::text
        when pg_catalog.count(catalog.constraint_name) <> 1 then 'duplicate-constraint'::text
        else 'action-mismatch'::text
      end as inventory_issue
    from expected
    left join direct_catalog catalog
      on catalog.schema_name = expected.schema_name
     and catalog.table_name = expected.table_name
     and catalog.user_column = expected.user_column
    group by expected.schema_name, expected.table_name, expected.user_column, expected.expected_action
    having pg_catalog.count(catalog.constraint_name) <> 1
      or pg_catalog.bool_or(catalog.confdeltype is distinct from expected.expected_action)
  ), transitive_catalog as (
    select reachable.cascade_depth + 1 as cascade_depth,
      parent_namespace.nspname as parent_schema_name, parent_relation.relname as parent_table_name,
      child_namespace.nspname as schema_name, child_relation.relname as table_name,
      child_constraint.conname as constraint_name, child_constraint.confdeltype,
      child_constraint.condeferrable, child_constraint.condeferred,
      pg_catalog.string_agg(child_attribute.attname, ',' order by child_key.ord) as user_column
    from reachable
    join pg_catalog.pg_constraint child_constraint
      on child_constraint.contype = 'f'
     and child_constraint.confrelid = reachable.relation_oid
    join pg_catalog.pg_class parent_relation on parent_relation.oid = reachable.relation_oid
    join pg_catalog.pg_namespace parent_namespace on parent_namespace.oid = parent_relation.relnamespace
    join pg_catalog.pg_class child_relation on child_relation.oid = child_constraint.conrelid
    join pg_catalog.pg_namespace child_namespace on child_namespace.oid = child_relation.relnamespace
    join pg_catalog.unnest(child_constraint.conkey) with ordinality as child_key(attnum, ord) on true
    join pg_catalog.pg_attribute child_attribute
      on child_attribute.attrelid = child_relation.oid and child_attribute.attnum = child_key.attnum
    where reachable.cascade_depth > 0
    group by reachable.cascade_depth, parent_namespace.nspname, parent_relation.relname,
      child_namespace.nspname, child_relation.relname, child_constraint.conname, child_constraint.confdeltype,
      child_constraint.condeferrable, child_constraint.condeferred
  ), transitive_expected_issues as (
    select reviewed.schema_name, reviewed.table_name,
      pg_catalog.array_to_string(reviewed.set_null_columns, ',') as user_column,
      reviewed.constraint_name,
      case
        when pg_catalog.count(catalog.constraint_name) = 0 then 'stale-review'::text
        when pg_catalog.count(catalog.constraint_name) <> 1 then 'duplicate-constraint'::text
        else 'action-mismatch'::text
      end as inventory_issue,
      reviewed.parent_schema_name, reviewed.parent_table_name,
      coalesce(pg_catalog.min(catalog.cascade_depth), 0)::integer as cascade_depth
    from private.account_lifecycle_transitive_fk_manifest reviewed
    left join transitive_catalog catalog
      on catalog.parent_schema_name = reviewed.parent_schema_name
     and catalog.parent_table_name = reviewed.parent_table_name
     and catalog.schema_name = reviewed.schema_name
     and catalog.table_name = reviewed.table_name
     and catalog.constraint_name = reviewed.constraint_name
    group by reviewed.schema_name, reviewed.table_name, reviewed.constraint_name,
      reviewed.set_null_columns, reviewed.delete_disposition, reviewed.defer_constraint,
      reviewed.parent_schema_name, reviewed.parent_table_name
    having pg_catalog.count(catalog.constraint_name) <> 1
      or pg_catalog.bool_or(catalog.confdeltype is distinct from case reviewed.delete_disposition when 'cascade' then 'c'::"char" else 'n'::"char" end)
      or pg_catalog.bool_or(reviewed.defer_constraint and not (catalog.condeferrable and catalog.condeferred))
  ), missing_reviews as (
    select catalog.schema_name, catalog.table_name, catalog.user_column,
      catalog.constraint_name, 'missing-review'::text as inventory_issue,
      'auth'::text as parent_schema_name, 'users'::text as parent_table_name, 1::integer as cascade_depth
    from direct_catalog catalog
    where catalog.confdeltype in ('a', 'r')
      and not exists (
        select 1
        from expected
        where expected.schema_name = catalog.schema_name
          and expected.table_name = catalog.table_name
          and expected.user_column = catalog.user_column
      )
  ), missing_transitive_reviews as (
    select catalog.schema_name, catalog.table_name, catalog.user_column,
      catalog.constraint_name, 'missing-review'::text as inventory_issue,
      catalog.parent_schema_name, catalog.parent_table_name, catalog.cascade_depth
    from transitive_catalog catalog
    where catalog.confdeltype in ('a', 'r')
      and not exists (
      select 1
      from private.account_lifecycle_transitive_fk_manifest reviewed
      where reviewed.parent_schema_name = catalog.parent_schema_name
        and reviewed.parent_table_name = catalog.parent_table_name
        and reviewed.schema_name = catalog.schema_name
        and reviewed.table_name = catalog.table_name
        and reviewed.constraint_name = catalog.constraint_name
    )
  )
  select schema_name, table_name, user_column, constraint_name, inventory_issue,
    'auth'::text, 'users'::text, 1::integer from expected_issues
  union all
  select * from missing_reviews
  union all
  select * from transitive_expected_issues
  union all
  select * from missing_transitive_reviews
  order by 1, 2, 3, 5;
$$;

revoke all on function private.account_lifecycle_unmanaged_restrictive_fks() from public, anon, authenticated;
grant execute on function private.account_lifecycle_unmanaged_restrictive_fks() to service_role;

-- Export inventory is deliberately checked against pg_catalog rather than
-- derived from rows already marked `included`. Every direct auth.users
-- identity link, regardless of its delete action, in the product schemas must have an affirmative
-- reviewed disposition: either a
-- named export projection or a non-empty explanation for excluding the raw
-- relation. Removing an inventory row, or adding a later auth.users FK without
-- reviewing it, therefore makes this function return the gap.
create function private.account_lifecycle_unmanaged_export_fks()
returns table (
  schema_name text,
  table_name text,
  user_column text,
  constraint_name text,
  inventory_issue text
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Catalog candidate with no valid, reviewed inventory classification.
  select n.nspname, c.relname, a.attname, con.conname,
         'missing-review'::text as inventory_issue
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join unnest(con.conkey) with ordinality as k(attnum, ord) on true
  join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
  where con.contype = 'f'
    and con.confrelid = 'auth.users'::regclass
    and n.nspname in ('public', 'private')
    and array_length(con.conkey, 1) = 1
    and not exists (
      select 1
      from private.account_lifecycle_manifest m
      where m.schema_name = n.nspname
        and m.table_name = c.relname
        and m.user_column = a.attname
        and m.export_inventory_basis = 'auth_user_fk'
        and m.export_disposition in ('included', 'excluded_with_reason')
        and (
          (m.export_disposition = 'included'
            and m.export_projection in ('canonical', 'additional_domains'))
          or (m.export_disposition = 'excluded_with_reason'
            and pg_catalog.length(pg_catalog.btrim(m.exclusion_reason)) > 0)
        )
    )

  union all

  -- Reviewed ownership row whose defining direct FK no longer exists.
  -- This reverse arm prevents a stale hand-maintained list from looking
  -- complete merely because every current catalog candidate was found.
  select m.schema_name, m.table_name, m.user_column, null::text,
         'stale-review'::text as inventory_issue
  from private.account_lifecycle_manifest m
  where m.export_inventory_basis = 'auth_user_fk'
    and not exists (
      select 1
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      join unnest(con.conkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where con.contype = 'f'
        and con.confrelid = 'auth.users'::regclass
        and n.nspname in ('public', 'private')
        and array_length(con.conkey, 1) = 1
        and n.nspname = m.schema_name
        and c.relname = m.table_name
        and a.attname = m.user_column
    )
  order by 1, 2, 3, 5;
$$;

revoke all on function private.account_lifecycle_unmanaged_export_fks() from public, anon, authenticated;
grant execute on function private.account_lifecycle_unmanaged_export_fks() to service_role;

-- Static, reviewed export helpers generated from the manifest catalogue. Each
-- helper exposes only its per-column allowlist and filters by the caller UUID.
create function private.account_lifecycle_export_chapter_channel_poll_votes(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('poll_id', t.poll_id, 'option_id', t.option_id, 'user_id', t.user_id, 'created_at', t.created_at, 'updated_at', t.updated_at)), '[]'::jsonb) from public.chapter_channel_poll_votes t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_chapter_channel_poll_votes(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_chapter_task_watchers(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id', t.user_id, 'task_id', t.task_id, 'chapter_id', t.chapter_id, 'created_at', t.created_at)), '[]'::jsonb) from public.chapter_task_watchers t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_chapter_task_watchers(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_chapter_thread_posts(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'thread_id', t.thread_id, 'chapter_id', t.chapter_id, 'author_id', t.author_id, 'body', t.body, 'parent_post_id', t.parent_post_id, 'created_at', t.created_at, 'edited_at', t.edited_at, 'deleted_at', t.deleted_at, 'author_name', t.author_name, 'author_initials', t.author_initials, 'author_role', t.author_role)), '[]'::jsonb) from public.chapter_thread_posts t where t.author_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_chapter_thread_posts(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_chapter_threads(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'space_id', t.space_id, 'chapter_id', t.chapter_id, 'title', t.title, 'kind', t.kind, 'status', t.status, 'created_by', t.created_by, 'task_id', t.task_id, 'case_id', t.case_id, 'resolved_at', t.resolved_at, 'created_at', t.created_at, 'updated_at', t.updated_at)), '[]'::jsonb) from public.chapter_threads t where t.created_by = p_caller; $export$; revoke all on function private.account_lifecycle_export_chapter_threads(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_compass_message_briefings(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'organization_id', t.organization_id, 'requested_by', t.requested_by, 'source_kind', t.source_kind, 'target_id', t.target_id, 'summary', t.summary, 'action_items', t.action_items, 'created_at', t.created_at)), '[]'::jsonb) from public.compass_message_briefings t where t.requested_by = p_caller; $export$; revoke all on function private.account_lifecycle_export_compass_message_briefings(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_compass_workspace_preferences(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'module_order', t.module_order, 'hidden_modules', t.hidden_modules, 'updated_at', t.updated_at)), '[]'::jsonb) from public.compass_workspace_preferences t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_compass_workspace_preferences(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_ballot_votes(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('ballot_id', t.ballot_id, 'option_id', t.option_id, 'user_id', t.user_id, 'submitted_at', t.submitted_at)), '[]'::jsonb) from public.member_ballot_votes t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_ballot_votes(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_broadcast_receipts(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('broadcast_id', t.broadcast_id, 'user_id', t.user_id, 'read_at', t.read_at)), '[]'::jsonb) from public.member_broadcast_receipts t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_broadcast_receipts(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_chapter_memberships(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id', t.user_id, 'chapter_id', t.chapter_id, 'status', t.status, 'pinned', t.pinned, 'last_selected_at', t.last_selected_at, 'joined_at', t.joined_at, 'revoked_at', t.revoked_at)), '[]'::jsonb) from public.member_chapter_memberships t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_chapter_memberships(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_emergency_checklists(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'organization_id', t.organization_id, 'member_user_id', t.member_user_id, 'scenario', t.scenario, 'status', t.status, 'completed_steps', t.completed_steps, 'notes', t.notes, 'alerted_at', t.alerted_at, 'resolved_at', t.resolved_at, 'created_at', t.created_at, 'updated_at', t.updated_at)), '[]'::jsonb) from public.member_emergency_checklists t where t.member_user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_emergency_checklists(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_message_reactions(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'actor_id', t.actor_id, 'source_kind', t.source_kind, 'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id, 'task_message_id', t.task_message_id, 'reaction', t.reaction, 'created_at', t.created_at)), '[]'::jsonb) from public.member_message_reactions t where t.actor_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_message_reactions(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_message_reminders(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'owner_id', t.owner_id, 'source_kind', t.source_kind, 'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id, 'task_message_id', t.task_message_id, 'note', t.note, 'remind_at', t.remind_at, 'status', t.status, 'created_at', t.created_at, 'delivered_at', t.delivered_at)), '[]'::jsonb) from public.member_message_reminders t where t.owner_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_message_reminders(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_message_resources(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'message_id', t.message_id, 'document_id', t.document_id, 'added_by', t.added_by, 'created_at', t.created_at)), '[]'::jsonb) from public.member_message_resources t where t.added_by = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_message_resources(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_qa_votes(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'question_id', t.question_id, 'reply_id', t.reply_id, 'created_at', t.created_at)), '[]'::jsonb) from public.member_qa_votes t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_qa_votes(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_report_preferences(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id', t.user_id, 'config', t.config, 'updated_at', t.updated_at)), '[]'::jsonb) from public.member_report_preferences t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_report_preferences(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_reward_tier_attainment(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('user_id', t.user_id, 'highest_tier', t.highest_tier, 'attained_at', t.attained_at, 'updated_at', t.updated_at)), '[]'::jsonb) from public.member_reward_tier_attainment t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_reward_tier_attainment(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_saved_messages(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'owner_id', t.owner_id, 'source_kind', t.source_kind, 'private_message_id', t.private_message_id, 'channel_post_id', t.channel_post_id, 'task_message_id', t.task_message_id, 'saved_at', t.saved_at)), '[]'::jsonb) from public.member_saved_messages t where t.owner_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_saved_messages(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_weekly_question_promotions(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('question_id', t.question_id, 'reward_grant_id', t.reward_grant_id, 'organization_id', t.organization_id, 'chapter_id', t.chapter_id, 'user_id', t.user_id, 'promoted_at', t.promoted_at)), '[]'::jsonb) from public.member_weekly_question_promotions t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_weekly_question_promotions(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_weekly_question_supports(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('question_id', t.question_id, 'user_id', t.user_id, 'created_at', t.created_at)), '[]'::jsonb) from public.member_weekly_question_supports t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_weekly_question_supports(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_member_weekly_questions(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'chapter_id', t.chapter_id, 'user_id', t.user_id, 'week_start', t.week_start, 'body', t.body, 'options', t.options, 'editorial_state', t.editorial_state, 'published_survey_id', t.published_survey_id, 'created_at', t.created_at, 'updated_at', t.updated_at)), '[]'::jsonb) from public.member_weekly_questions t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_member_weekly_questions(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_organization_engagement_events(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'chapter_id', t.chapter_id, 'event_type', t.event_type, 'source_id', t.source_id, 'occurred_at', t.occurred_at)), '[]'::jsonb) from public.organization_engagement_events t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_organization_engagement_events(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_organization_live_poll_votes(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'poll_id', t.poll_id, 'option_id', t.option_id, 'voter_user_id', t.voter_user_id, 'created_at', t.created_at, 'updated_at', t.updated_at)), '[]'::jsonb) from public.organization_live_poll_votes t where t.voter_user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_organization_live_poll_votes(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_organization_memberships(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('organization_id', t.organization_id, 'user_id', t.user_id, 'status', t.status, 'created_at', t.created_at, 'revoked_at', t.revoked_at)), '[]'::jsonb) from public.organization_memberships t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_organization_memberships(uuid) from public, anon, authenticated, service_role;
create function private.account_lifecycle_export_organization_pulse_events(p_caller uuid) returns jsonb language sql stable security definer set search_path = '' as $export$ select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'organization_id', t.organization_id, 'prompt_id', t.prompt_id, 'user_id', t.user_id, 'context_key', t.context_key, 'state', t.state, 'response_value', t.response_value, 'shown_at', t.shown_at, 'responded_at', t.responded_at, 'updated_at', t.updated_at)), '[]'::jsonb) from public.organization_pulse_events t where t.user_id = p_caller; $export$; revoke all on function private.account_lifecycle_export_organization_pulse_events(uuid) from public, anon, authenticated, service_role;

create function private.account_lifecycle_export_additional_domains(p_caller uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $export$
  select pg_catalog.jsonb_build_object(
    'chapter_channel_poll_votes', private.account_lifecycle_export_chapter_channel_poll_votes(p_caller), 'chapter_task_watchers', private.account_lifecycle_export_chapter_task_watchers(p_caller), 'chapter_thread_posts', private.account_lifecycle_export_chapter_thread_posts(p_caller), 'chapter_threads', private.account_lifecycle_export_chapter_threads(p_caller), 'compass_message_briefings', private.account_lifecycle_export_compass_message_briefings(p_caller), 'compass_workspace_preferences', private.account_lifecycle_export_compass_workspace_preferences(p_caller), 'member_ballot_votes', private.account_lifecycle_export_member_ballot_votes(p_caller), 'member_broadcast_receipts', private.account_lifecycle_export_member_broadcast_receipts(p_caller), 'member_chapter_memberships', private.account_lifecycle_export_member_chapter_memberships(p_caller), 'member_emergency_checklists', private.account_lifecycle_export_member_emergency_checklists(p_caller), 'member_message_reactions', private.account_lifecycle_export_member_message_reactions(p_caller), 'member_message_reminders', private.account_lifecycle_export_member_message_reminders(p_caller), 'member_message_resources', private.account_lifecycle_export_member_message_resources(p_caller), 'member_qa_votes', private.account_lifecycle_export_member_qa_votes(p_caller), 'member_report_preferences', private.account_lifecycle_export_member_report_preferences(p_caller), 'member_reward_tier_attainment', private.account_lifecycle_export_member_reward_tier_attainment(p_caller), 'member_saved_messages', private.account_lifecycle_export_member_saved_messages(p_caller), 'member_weekly_question_promotions', private.account_lifecycle_export_member_weekly_question_promotions(p_caller), 'member_weekly_question_supports', private.account_lifecycle_export_member_weekly_question_supports(p_caller), 'member_weekly_questions', private.account_lifecycle_export_member_weekly_questions(p_caller), 'organization_engagement_events', private.account_lifecycle_export_organization_engagement_events(p_caller), 'organization_live_poll_votes', private.account_lifecycle_export_organization_live_poll_votes(p_caller), 'organization_memberships', private.account_lifecycle_export_organization_memberships(p_caller), 'organization_pulse_events', private.account_lifecycle_export_organization_pulse_events(p_caller)
  );
$export$;

revoke all on function private.account_lifecycle_export_additional_domains(uuid) from public, anon, authenticated, service_role;

-- B04 introduced sender_id as the authenticated author of each new direct
-- message. Preserve the established member conversation projection while also
-- exporting messages authored by the caller under that current identity.
create or replace function private.member_data_export_without_peer_contact()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid;
  exported jsonb;
  records integer;
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  records := 0;
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select pg_catalog.jsonb_build_object('schemaVersion', 1,
    'generatedAt', now(),
    'account', pg_catalog.jsonb_build_object(
      'userId', caller,
      'email', (select u.email from auth.users u where u.id = caller),
      'profile', coalesce((
        select pg_catalog.jsonb_build_object(
          'firstName', p.first_name, 'fullName', p.full_name,
          'initials', p.initials, 'roleLine', p.role_line,
          'memberSince', p.member_since, 'language', p.language,
          'chapterId', p.chapter_id, 'createdAt', p.created_at,
          'updatedAt', p.updated_at)
        from public.member_profiles p where p.id = caller
      ), '{}'::jsonb),
      'roles', coalesce((select pg_catalog.jsonb_agg(r.role order by r.role)
        from public.member_roles r where r.user_id = caller), '[]'::jsonb)
    ),
    'notifications', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', n.id, 'title', n.title, 'body', n.body, 'kind', n.kind,
      'readAt', n.read_at, 'createdAt', n.created_at) order by n.created_at)
      from public.member_notifications n where n.user_id = caller), '[]'::jsonb),
    'conversations', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'title', c.title, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'senderKind', m.sender_kind, 'senderName', m.sender_name,
        'body', m.body, 'redactedAt', m.redacted_at, 'redactionReason', m.redaction_reason,
        'bodySha256', m.body_sha256, 'originalLength', m.original_length,
        'readAt', m.read_at, 'createdAt', m.created_at) order by m.created_at)
        from public.member_messages m
        where m.conversation_id = c.id
          and (m.user_id = caller or m.sender_id = caller)), '[]'::jsonb)
      ) order by c.created_at) from public.member_conversations c where c.user_id = caller), '[]'::jsonb),
    'cases', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', c.id, 'reference', c.reference, 'title', c.title, 'deadline', c.deadline,
      'caseType', c.case_type, 'articles', c.articles, 'step', c.step,
      'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at,
      'updates', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', u.id, 'body', u.body, 'createdAt', u.created_at) order by u.created_at)
        from public.member_case_updates u where u.case_id = c.id and u.user_id = caller), '[]'::jsonb)
      ) order by c.created_at) from public.member_cases c where c.user_id = caller), '[]'::jsonb),
    'forms', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', f.id, 'templateKey', f.template_key, 'templateVersion', f.template_version,
      'status', f.status, 'answers', f.answers, 'step', f.step,
      'reviewNote', f.review_note, 'reviewedAt', f.reviewed_at,
      'submittedAt', f.submitted_at, 'createdAt', f.created_at, 'updatedAt', f.updated_at,
      'cosigners', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'status', c.status, 'invitedAt', c.invited_at, 'respondedAt', c.responded_at)
        order by c.invited_at) from public.member_form_cosigners c where c.form_id = f.id), '[]'::jsonb)
      ) order by f.created_at) from public.member_forms f where f.user_id = caller), '[]'::jsonb),
    'participation', pg_catalog.jsonb_build_object(
      'ballotReceipts', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ballotId', r.ballot_id, 'receiptCode', r.receipt_code,
        'counted', r.counted, 'issuedAt', r.issued_at) order by r.issued_at)
        from public.member_ballot_receipts r where r.user_id = caller), '[]'::jsonb),
      'surveyResponses', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'surveyId', s.survey_id, 'optionId', s.option_id, 'submittedAt', s.submitted_at)
        order by s.submitted_at) from public.member_survey_responses s where s.user_id = caller), '[]'::jsonb),
      'rightsProgress', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'lessonId', r.lesson_id, 'completedSteps', r.completed_steps, 'updatedAt', r.updated_at)
        order by r.updated_at) from public.member_rights_progress r where r.user_id = caller), '[]'::jsonb),
      'eventRsvps', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', r.event_id, 'status', r.status, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_event_rsvps r where r.user_id = caller), '[]'::jsonb),
      'eventCheckins', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', c.event_id, 'checkedInAt', c.checked_in_at) order by c.checked_in_at)
        from public.member_event_checkins c where c.user_id = caller), '[]'::jsonb)
    ),
    'support', pg_catalog.jsonb_build_object(
      'stewardRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'lessonId', r.lesson_id, 'status', r.status,
        'createdAt', r.created_at, 'acknowledgedAt', r.acknowledged_at, 'closedAt', r.closed_at)
        order by r.created_at) from public.member_steward_requests r where r.user_id = caller), '[]'::jsonb),
      'appointments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'chapterId', a.chapter_id, 'appointmentType', a.appointment_type,
        'durationMinutes', a.duration_minutes, 'startsAt', a.starts_at, 'endsAt', a.ends_at,
        'status', a.status, 'routedVia', a.routed_via, 'reasonCategory', a.reason_category,
        'createdAt', a.created_at, 'updatedAt', a.updated_at) order by a.created_at)
        from public.member_appointments a where a.user_id = caller), '[]'::jsonb),
      'intakeReports', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', i.id, 'chapterId', i.chapter_id, 'category', i.category, 'title', i.title,
        'details', i.details, 'status', i.status, 'createdAt', i.created_at, 'updatedAt', i.updated_at)
        order by i.created_at) from public.member_intake_reports i where i.reporter_id = caller), '[]'::jsonb),
      'dataRequests', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', g.id, 'chapterId', g.chapter_id, 'requestType', g.request_type,
        'details', g.details, 'status', g.status, 'response', g.response,
        'createdAt', g.created_at, 'updatedAt', g.updated_at) order by g.created_at)
        from public.chapter_governance_requests g where g.requester_id = caller), '[]'::jsonb)
    ),
    'compass', pg_catalog.jsonb_build_object(
      'threads', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', t.id, 'title', t.title, 'createdAt', t.created_at, 'updatedAt', t.updated_at,
        'messages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', m.id, 'role', m.role, 'body', m.body, 'sources', m.sources, 'createdAt', m.created_at)
          order by m.created_at) from public.member_guide_messages m
          where m.thread_id = t.id and m.user_id = caller), '[]'::jsonb)) order by t.created_at)
        from public.member_guide_threads t where t.user_id = caller), '[]'::jsonb),
      'requestHistory', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'createdAt', r.created_at, 'role', r.compass_role,
        'limit', r.compass_limit, 'dispatchAuthorizedAt', r.dispatch_authorized_at)
        order by r.created_at) from public.member_ai_requests r where r.user_id = caller), '[]'::jsonb)
    ),
    'activity', pg_catalog.jsonb_build_object(
      'points', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', p.action_key, 'actionKind', p.action_kind,
        'points', p.points, 'occurredAt', p.occurred_at) order by p.occurred_at)
        from public.member_point_events p where p.user_id = caller), '[]'::jsonb),
      'rewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'itemKey', r.item_key, 'status', r.status, 'source', r.source,
        'reason', r.reason, 'note', r.note, 'createdAt', r.created_at, 'updatedAt', r.updated_at)
        order by r.created_at) from public.member_reward_grants r where r.user_id = caller), '[]'::jsonb),
      'workload', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(w) - 'user_id' order by w.created_at)
        from public.member_workload_logs w where w.user_id = caller), '[]'::jsonb),
      'actions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actionKey', a.action_key, 'actionKind', a.action_kind, 'occurredAt', a.occurred_at)
        order by a.occurred_at) from public.member_action_log a where a.user_id = caller), '[]'::jsonb)
    ),
    'chapterParticipation', pg_catalog.jsonb_build_object(
      'spaceMemberships', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', m.space_id, 'role', m.role,
        'joinedAt', m.joined_at) order by m.joined_at)
        from public.chapter_space_members m where m.user_id = caller), '[]'::jsonb),
      'taskAssignments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'taskId', a.task_id, 'chapterId', a.chapter_id, 'position', a.position, 'assignedAt', a.assigned_at)
        order by a.assigned_at) from public.chapter_task_assignments a where a.assignee_id = caller), '[]'::jsonb),
      'taskComments', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'taskId', c.task_id, 'chapterId', c.chapter_id,
        'body', c.body, 'createdAt', c.created_at) order by c.created_at)
        from public.chapter_task_comments c where c.author_id = caller), '[]'::jsonb),
      'taskMessages', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', m.id, 'taskId', m.task_id, 'chapterId', m.chapter_id,
        'direction', case when m.sender_id = caller then 'sent' else 'received' end,
        'body', m.body, 'createdAt', m.created_at) order by m.created_at)
        from public.chapter_task_messages m where m.sender_id = caller or m.recipient_id = caller), '[]'::jsonb)
    )
  ) into exported;

  select coalesce(pg_catalog.sum(pg_catalog.jsonb_array_length(value)), 0)::integer
    into records
  from pg_catalog.jsonb_each(exported) section
  where pg_catalog.jsonb_typeof(value) = 'array';

  insert into private.member_account_lifecycle_audit (subject_hash, event_type, record_count)
  values (private.member_lifecycle_subject_hash(caller), 'export_generated', records);

  return exported || pg_catalog.jsonb_build_object('topLevelRecordCount', records);
end;
$$;

revoke all on function private.member_data_export_without_peer_contact() from public, anon, authenticated, service_role;

-- 20260812233000 already turned this into a thin, single-audit wrapper around
-- private.member_data_export_without_peer_contact() (the renamed original
-- exporter) plus a peerContact section. Folding additionalDomains in here
-- too, rather than reintroducing the pre-wrapper body, keeps that single
-- audit-write invariant and the peer-contact section both intact.
create or replace function public.get_member_data_export()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  exported jsonb;
  peer_contact jsonb;
  additional jsonb;
  safe_workload jsonb;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  -- This private implementation performs the single lifecycle audit write.
  exported := private.member_data_export_without_peer_contact();

  select pg_catalog.jsonb_build_object(
    'requests', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', request.id,
        'direction', case when request.requester_id = caller then 'sent' else 'received' end,
        'chapterId', request.chapter_id,
        'status', request.status,
        'createdAt', request.created_at,
        'respondedAt', request.responded_at,
        'expiresAt', request.expires_at
      ) order by request.created_at, request.id)
      from (
        select r.id, r.requester_id, r.chapter_id, r.status,
          r.created_at, r.responded_at, r.expires_at
        from public.member_peer_contact_requests r
        where r.requester_id = caller or r.recipient_id = caller
        order by r.created_at desc, r.id desc
        limit 100
      ) request
    ), '[]'::jsonb),
    'conversations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', conversation.id,
        'chapterId', conversation.chapter_id,
        'createdAt', conversation.created_at,
        'updatedAt', conversation.updated_at,
        'messages', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', message.id,
            'sentByMe', message.sender_id = caller,
            'body', message.body,
            'readAt', message.read_at,
            'createdAt', message.created_at
          ) order by message.created_at, message.id)
          from (
            select m.id, m.sender_id, m.body, m.read_at, m.created_at
            from public.member_peer_messages m
            where m.conversation_id = conversation.id
            order by m.created_at desc, m.id desc
            limit 100
          ) message
        ), '[]'::jsonb)
      ) order by conversation.created_at, conversation.id)
      from (
        select c.id, c.chapter_id, c.created_at, c.updated_at
        from public.member_peer_conversations c
        where c.user_low = caller or c.user_high = caller
        order by c.updated_at desc, c.id desc
        limit 20
      ) conversation
    ), '[]'::jsonb)
  ) into peer_contact;

  additional := private.account_lifecycle_export_additional_domains(caller);
  additional := additional || pg_catalog.jsonb_build_object(
    'member_case_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'caseId', file.case_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'createdAt', file.created_at
      ) order by file.created_at, file.id)
      from public.member_case_files file
      where file.user_id = caller
    ), '[]'::jsonb),
    'member_form_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'formId', file.form_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'confirmedAt', file.confirmed_at,
        'createdAt', file.created_at,
        'deletionRequestedAt', file.deletion_requested_at
      ) order by file.created_at, file.id)
      from public.member_form_files file
      where file.uploaded_by = caller
        and exists (
          select 1 from public.member_forms form
          where form.id = file.form_id and form.user_id = caller
        )
    ), '[]'::jsonb),
    'chapter_task_files', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', file.id,
        'taskId', file.task_id,
        'chapterId', file.chapter_id,
        'filename', file.filename,
        'mimeType', file.mime_type,
        'sizeBytes', file.size_bytes,
        'createdAt', file.created_at
      ) order by file.created_at, file.id)
      from public.chapter_task_files file
      where file.uploaded_by = caller
    ), '[]'::jsonb),
    'member_qa_questions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', question.id,
        'organizationId', question.organization_id,
        'chapterId', question.chapter_id,
        'title', question.title,
        'body', question.body,
        'status', question.status,
        'acceptedReplyId', question.accepted_reply_id,
        'upvoteCount', question.upvote_count,
        'createdAt', question.created_at,
        'updatedAt', question.updated_at,
        'deletedAt', question.deleted_at
      ) order by question.created_at, question.id)
      from public.member_qa_questions question
      where question.author_user_id = caller
    ), '[]'::jsonb),
    'member_qa_replies', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', reply.id,
        'organizationId', reply.organization_id,
        'questionId', reply.question_id,
        'kind', reply.kind,
        'body', reply.body,
        'accepted', reply.accepted,
        'upvoteCount', reply.upvote_count,
        'createdAt', reply.created_at,
        'updatedAt', reply.updated_at,
        'deletedAt', reply.deleted_at
      ) order by reply.created_at, reply.id)
      from public.member_qa_replies reply
      where reply.author_user_id = caller
    ), '[]'::jsonb),
    'member_scheduled_messages', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', message.id,
        'conversationId', message.conversation_id,
        'senderKind', message.sender_kind,
        'body', message.body,
        'scheduledFor', message.scheduled_for,
        'status', message.status,
        'sentMessageId', message.sent_message_id,
        'createdAt', message.created_at,
        'dispatchedAt', message.dispatched_at
      ) order by message.created_at, message.id)
      from public.member_scheduled_messages message
      where message.actor_id = caller
    ), '[]'::jsonb),
    'meeting_attendance', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'recordId', attendance.record_id,
        'chapterId', attendance.chapter_id,
        'attendanceStatus', attendance.attendance_status,
        'recordedAt', attendance.recorded_at
      ) order by attendance.recorded_at, attendance.record_id)
      from public.meeting_attendance attendance
      where attendance.user_id = caller
    ), '[]'::jsonb),
    'meeting_minutes_dispatches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', dispatch.id,
        'recordId', dispatch.record_id,
        'chapterId', dispatch.chapter_id,
        'version', dispatch.version,
        'channel', dispatch.channel,
        'status', dispatch.status,
        'deliveredAt', dispatch.delivered_at,
        'createdAt', dispatch.created_at
      ) order by dispatch.created_at, dispatch.id)
      from public.meeting_minutes_dispatches dispatch
      where dispatch.recipient_id = caller
    ), '[]'::jsonb)
  );

  -- The original v1 exporter used `to_jsonb(w) - 'user_id'` for workload
  -- rows. Replace that whole-row shape before anything leaves this wrapper so
  -- the canonical v1 domain is an explicit reviewed projection too.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', workload.id,
    'priority', workload.priority,
    'pending', workload.pending,
    'unreadDocs', workload.unread_docs,
    'todos', workload.todos,
    'referrals', workload.referrals,
    'ceActivities', workload.ce_activities,
    'assistanceRequests', workload.assistance_requests,
    'agedCases', workload.aged_cases,
    'weeklyAssigned', workload.weekly_assigned,
    'employment', workload.employment,
    'partTimeHours', workload.pt_hours,
    'onPlan', workload.on_plan,
    'overtimeWorked', workload.ot_worked,
    'overtimeHours', workload.ot_hours,
    'leaveType', workload.leave_type,
    'leaveTiming', workload.leave_timing,
    'noIntake', workload.no_intake,
    'halfDay', workload.half_day,
    'note', workload.note,
    'subDetails', workload.sub_details,
    'receiptCode', workload.receipt_code,
    'loggedOn', workload.logged_on,
    'createdAt', workload.created_at
  ) order by workload.created_at, workload.id), '[]'::jsonb)
    into safe_workload
    from public.member_workload_logs workload
   where workload.user_id = caller;

  -- No peer id, profile label, email/address, share code, or digest is added.
  -- Direction is expressed only relative to the authenticated caller.
  exported := pg_catalog.jsonb_set(exported, '{activity,workload}', safe_workload, true);
  exported := pg_catalog.jsonb_set(exported, '{peerContact}', peer_contact, true);
  return exported || pg_catalog.jsonb_build_object('additionalDomains', additional);
end;
$$;

revoke all on function public.get_member_data_export() from public, anon;
grant execute on function public.get_member_data_export() to authenticated;

-- Retain only authorization inputs whose parent is about to disappear. Caller
-- roles, organization selection, MFA and chapter memberships remain live reads.
-- No principal allowlist: each table retains its own original predicate.
create table private.account_lifecycle_case_scope (
  case_id uuid primary key,
  organization_id uuid,
  chapter_id text,
  owner_id uuid,
  owner_chapter_id text,
  steward_user_id uuid,
  coordinator_user_id uuid,
  is_restricted boolean not null,
  grants jsonb not null
);
create table private.account_lifecycle_history_scope (
  kind text not null,
  record_id text not null,
  case_id uuid not null references private.account_lifecycle_case_scope(case_id),
  primary key(kind, record_id)
);
revoke all on private.account_lifecycle_case_scope, private.account_lifecycle_history_scope
  from public, anon, authenticated, service_role;

-- Exact staff_can_see_user predicate with only the disappearing target profile
-- lookup replaced by its retained chapter input. The chapter/reader stay live.
create function private.account_lifecycle_staff_can_see_chapter(p_target_chapter text, p_role text)
returns boolean language sql stable security definer set search_path = '' as $function$

  select case
    when (select auth.uid()) is null or p_target_chapter is null or p_role is null then false
    when not (select private.mfa_satisfied()) then false
    else exists (
      select 1
      from public.chapters target_chapter
      where target_chapter.id = p_target_chapter
        and (
          (
            target_chapter.organization_id is not null
            and target_chapter.organization_id = (select private.current_member_organization())
            and (
              private.has_organization_role(target_chapter.organization_id, array[p_role])
              or private.member_has_chapter_role(target_chapter.id, array[p_role])
            )
          )
          or (
            target_chapter.organization_id is null
            and (select private.current_member_organization()) is null
            and exists (
              select 1
              from public.member_profiles caller_profile
              left join public.chapters caller_chapter
                on caller_chapter.id = caller_profile.chapter_id
              where caller_profile.id = (select auth.uid())
                and (caller_chapter.id is null or caller_chapter.organization_id is null)
            )
            and (
              not (select private.staff_mfa_required())
              or (select private.has_second_factor((select auth.uid())))
            )
            and exists (
              select 1
              from public.member_roles r
              where r.user_id = (select auth.uid())
                and r.role = p_role
                and (
                  r.chapter_id is null
                  or exists (
                    select 1
                    from public.member_role_chapters rc
                    join public.member_chapter_memberships m
                      on m.user_id = rc.user_id and m.chapter_id = rc.chapter_id
                    join public.chapters mapped on mapped.id = rc.chapter_id
                    where rc.user_id = r.user_id
                      and rc.role = r.role
                      and rc.chapter_id = p_target_chapter
                      and mapped.organization_id is null
                      and m.status = 'active'
                  )
                )
            )
          )
        )
    )
  end;
$function$;

create function private.account_lifecycle_capture_case(p_case public.member_cases)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  -- The deleting statement owns the case row (including its assignments).
  -- FOR UPDATE also conflicts with FK key-share, preventing new grants; lock
  -- existing grants before reading so a committed revoke cannot be lost.
  perform 1 from public.member_cases where id = p_case.id for update;
  perform 1 from public.casework_access_grants where case_id = p_case.id order by id for update;
  perform 1 from public.member_profiles where id = p_case.user_id for share;
  insert into private.account_lifecycle_case_scope
  select p_case.id, p_case.organization_id, p_case.chapter_id,
    (select id from auth.users where id = p_case.user_id),
    case when exists(select 1 from public.member_profiles where id = p_case.user_id)
      then (select chapter_id from public.member_profiles where id = p_case.user_id)
      else (select owner_chapter_id from private.account_lifecycle_case_scope where case_id = p_case.id) end,
    (select id from auth.users where id = p_case.steward_user_id),
    (select id from auth.users where id = p_case.coordinator_user_id), p_case.is_restricted,
    coalesce((select jsonb_agg(jsonb_build_object('grantee_user_id', g.grantee_user_id,
      'granted_at', g.granted_at, 'revoked_at', g.revoked_at))
      from public.casework_access_grants g where g.case_id = p_case.id), '[]'::jsonb)
  on conflict (case_id) do update set
    organization_id = excluded.organization_id, chapter_id = excluded.chapter_id,
    owner_id = excluded.owner_id, owner_chapter_id = excluded.owner_chapter_id,
    steward_user_id = excluded.steward_user_id, coordinator_user_id = excluded.coordinator_user_id,
    is_restricted = excluded.is_restricted, grants = excluded.grants;

  insert into private.account_lifecycle_history_scope
  select 'management_entry', id::text, p_case.id from public.casework_management_entries where case_id = p_case.id
  union all select 'retaliation_report', id::text, p_case.id from public.casework_retaliation_reports where case_id = p_case.id
  union all select 'assignment_audit', id::text, p_case.id from public.member_case_assignment_audit where case_id = p_case.id
  union all select 'casework_audit', id::text, p_case.id from public.casework_audit_events where case_id = p_case.id
  union all select 'deadline_extension', e.id::text, p_case.id
    from public.casework_deadline_extensions e join public.casework_deadlines d on d.id = e.deadline_id
    where d.case_id = p_case.id
  on conflict (kind, record_id) do update set case_id = excluded.case_id;
end;
$function$;

create function private.capture_account_lifecycle_case_scope()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.account_lifecycle_capture_case(old);
  return old;
end;
$function$;

-- Before cascades, lock the profile, cases/assignments and grants. Keep only
-- the disappearing profile input here; final authorization and history capture
-- happens once, in each case's BEFORE DELETE trigger, after earlier cascades.
create function private.capture_account_lifecycle_auth_scope()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare c public.member_cases;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform 1 from public.member_profiles where id = old.id for update;
  update private.account_lifecycle_case_scope set owner_chapter_id =
    (select chapter_id from public.member_profiles where id = old.id)
  where owner_id = old.id;
  for c in select * from public.member_cases where user_id = old.id order by id for update loop
    perform 1 from public.casework_access_grants where case_id = c.id order by id for update;
    insert into private.account_lifecycle_case_scope
    values (c.id, c.organization_id, c.chapter_id, c.user_id,
      (select chapter_id from public.member_profiles where id = old.id),
      c.steward_user_id, c.coordinator_user_id, c.is_restricted, '[]'::jsonb)
    on conflict (case_id) do update set owner_chapter_id = excluded.owner_chapter_id;
  end loop;
  -- Mirror auth FK actions on inputs retained from earlier case deletions.
  -- A later account re-provision using the same UUID must not resurrect an
  -- assignment, owner-self path or cascaded access grant from a former identity.
  update private.account_lifecycle_case_scope retained
  set owner_id = case when retained.owner_id = old.id then null else retained.owner_id end,
      steward_user_id = case when retained.steward_user_id = old.id then null else retained.steward_user_id end,
      coordinator_user_id = case when retained.coordinator_user_id = old.id then null else retained.coordinator_user_id end,
      grants = coalesce((select jsonb_agg(g) from pg_catalog.jsonb_array_elements(retained.grants) g
        where (g->>'grantee_user_id')::uuid is distinct from old.id), '[]'::jsonb)
  where retained.owner_id = old.id or retained.steward_user_id = old.id or retained.coordinator_user_id = old.id
    or exists(select 1 from pg_catalog.jsonb_array_elements(retained.grants) g where (g->>'grantee_user_id')::uuid = old.id);
  return old;
end;
$function$;

create trigger member_cases_capture_account_lifecycle_scope before delete on public.member_cases
for each row execute function private.capture_account_lifecycle_case_scope();
create trigger auth_users_capture_account_lifecycle_scope before delete on auth.users
for each row execute function private.capture_account_lifecycle_auth_scope();

create or replace function public.casework_revoke_access(p_grant_id uuid)
returns public.casework_access_grants
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_access_grants%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  -- Resolve the parent without a child lock, then acquire case before grant.
  -- Re-read the grant after waiting; the case may have been deleted meanwhile.
  select * into strict v_row from public.casework_access_grants where id = p_grant_id;
  perform 1 from public.member_cases where id = v_row.case_id for update;
  if not found then raise exception 'grant not found' using errcode = 'P0002'; end if;
  select * into strict v_row from public.casework_access_grants where id = p_grant_id for update;
  if not private.casework_staff_can_access(v_row.case_id)
     or not (private.member_has_chapter_role(v_row.chapter_id, array['steward','coordinator','advisor','admin','vp']) or private.has_organization_role(v_row.organization_id, array['advisor','admin','vp']))
  then raise exception 'grant not found' using errcode = 'P0002'; end if;
  if v_row.revoked_at is not null then return v_row; end if;
  update public.casework_access_grants set revoked_at = pg_catalog.now(), revoked_by = (select auth.uid()) where id = v_row.id returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id, metadata)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'access_revoked', 'casework_access_grant', v_row.id, pg_catalog.jsonb_build_object('granteeUserId', v_row.grantee_user_id));
  return v_row;
end;
$function$;

-- Run after all Auth FK actions, including any waits on another deletion's
-- case/grant tuples. Each volatile trigger query takes a fresh READ COMMITTED
-- snapshot, so it also clears retained rows committed during those waits.
create function private.finalize_account_lifecycle_auth_scope()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  update private.account_lifecycle_case_scope retained
  set owner_id = case when retained.owner_id in (select id from deleted_identities) then null else retained.owner_id end,
      steward_user_id = case when retained.steward_user_id in (select id from deleted_identities) then null else retained.steward_user_id end,
      coordinator_user_id = case when retained.coordinator_user_id in (select id from deleted_identities) then null else retained.coordinator_user_id end,
      grants = coalesce((select jsonb_agg(g) from pg_catalog.jsonb_array_elements(retained.grants) g
        where not exists (select 1 from deleted_identities d where d.id = (g->>'grantee_user_id')::uuid)), '[]'::jsonb)
  where retained.owner_id in (select id from deleted_identities)
     or retained.steward_user_id in (select id from deleted_identities)
     or retained.coordinator_user_id in (select id from deleted_identities)
     or exists (select 1 from pg_catalog.jsonb_array_elements(retained.grants) g
       join deleted_identities d on d.id = (g->>'grantee_user_id')::uuid);
  return null;
end;
$function$;
revoke all on function private.finalize_account_lifecycle_auth_scope() from public, anon, authenticated, service_role;
create trigger auth_users_finalize_account_lifecycle_scope after delete on auth.users
referencing old table as deleted_identities
for each statement execute function private.finalize_account_lifecycle_auth_scope();

create function private.account_lifecycle_retained_case_scope_allows(
  p_kind text, p_record_id text, p_chapter_id text
)
returns boolean language sql stable security definer set search_path = '' as $function$
  select coalesce(case when p_kind = 'assignment_audit' then
    private.account_lifecycle_staff_can_see_chapter((case when exists(select 1 from public.member_profiles where id=c.owner_id) then (select chapter_id from public.member_profiles where id=c.owner_id) else c.owner_chapter_id end), 'coordinator')
    -- The original policy's EXISTS also invokes member_cases SELECT RLS.
    and (
      c.owner_id = (select auth.uid())
      or (c.steward_user_id = (select auth.uid()) and public.member_has_role(array['steward']))
      or (
        not c.is_restricted
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or exists (select 1 from pg_catalog.jsonb_to_recordset(c.grants) as g(grantee_user_id uuid, revoked_at timestamptz)
          where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null)
      )
    )
  else
    (p_kind = 'deadline_extension' and c.owner_id = (select auth.uid()))
    or (
      c.organization_id is not null
      and c.chapter_id is not null
      and private.actor_has_chapter_staff_role((select auth.uid()), c.chapter_id)
      and (
        c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.account_lifecycle_staff_can_see_chapter((case when exists(select 1 from public.member_profiles where id=c.owner_id) then (select chapter_id from public.member_profiles where id=c.owner_id) else c.owner_chapter_id end), 'coordinator')
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
      )
      and (
        not c.is_restricted
        or c.steward_user_id = (select auth.uid())
        or c.coordinator_user_id = (select auth.uid())
        or private.has_organization_role(c.organization_id, array['advisor','admin','vp'])
        or exists (
          select 1 from pg_catalog.jsonb_to_recordset(c.grants) as g(grantee_user_id uuid, revoked_at timestamptz)
          where g.grantee_user_id = (select auth.uid()) and g.revoked_at is null
        )
      )
    )
  end, false)
  from private.account_lifecycle_history_scope h
  join private.account_lifecycle_case_scope c on c.case_id = h.case_id
  where h.kind = p_kind and h.record_id = p_record_id;
$function$;

revoke all on function private.account_lifecycle_capture_case(public.member_cases),
  private.capture_account_lifecycle_case_scope(), private.capture_account_lifecycle_auth_scope(),
  private.account_lifecycle_staff_can_see_chapter(text, text),
  private.account_lifecycle_retained_case_scope_allows(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.account_lifecycle_retained_case_scope_allows(text, text, text) to authenticated;

drop policy casework_management_entries_staff on public.casework_management_entries;
create policy casework_management_entries_staff on public.casework_management_entries
  for select to authenticated using (
    private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
    and (
      (case_id is not null and private.casework_staff_can_access(case_id))
      or (case_id is null and coalesce(
        private.account_lifecycle_retained_case_scope_allows('management_entry', id::text, chapter_id),
        true
      ))
    )
  );
comment on policy casework_management_entries_staff on public.casework_management_entries is
  'Authenticated chapter staff may read current authorized case entries and retained entries whose captured chapter scope still authorizes them.';

drop policy casework_management_addenda_staff on public.casework_management_addenda;
create policy casework_management_addenda_staff on public.casework_management_addenda
  for select to authenticated using (
    exists (
      select 1
      from public.casework_management_entries entry
      where entry.id = casework_management_addenda.entry_id
        and entry.organization_id = casework_management_addenda.organization_id
        and private.member_has_chapter_role(entry.chapter_id, array['steward','coordinator','advisor','admin','vp'])
        and (
          (entry.case_id is not null and private.casework_staff_can_access(entry.case_id))
          or (entry.case_id is null and coalesce(
            private.account_lifecycle_retained_case_scope_allows('management_entry', entry.id::text, entry.chapter_id),
            true
          ))
        )
    )
  );
comment on policy casework_management_addenda_staff on public.casework_management_addenda is
  'Authenticated chapter staff may read addenda only through an entry whose current or retained chapter authorization permits access.';

drop policy casework_retaliation_reports_read on public.casework_retaliation_reports;
create policy casework_retaliation_reports_read on public.casework_retaliation_reports
  for select to authenticated using (
    reporter_user_id = (select auth.uid())
    or (
      private.member_has_chapter_role(chapter_id, array['steward','coordinator','advisor','admin','vp'])
      and (
        (case_id is not null and private.casework_staff_can_access(case_id))
        or (case_id is null and coalesce(
          private.account_lifecycle_retained_case_scope_allows('retaliation_report', id::text, chapter_id),
          true
        ))
      )
    )
  );
comment on policy casework_retaliation_reports_read on public.casework_retaliation_reports is
  'Authenticated reporters read their own reports; authorized chapter staff read current or retained reports within their permitted case scope.';

drop policy member_case_assignment_audit_select_coordinator on public.member_case_assignment_audit;
create policy member_case_assignment_audit_select_coordinator
  on public.member_case_assignment_audit for select to authenticated
  using (
    exists (
      select 1 from public.member_cases case_row
      where case_row.id = member_case_assignment_audit.case_id
        and public.staff_can_see_user(case_row.user_id, 'coordinator')
    )
    or (case_id is null and private.account_lifecycle_retained_case_scope_allows(
      'assignment_audit', id::text, null
    ))
  );
comment on policy member_case_assignment_audit_select_coordinator on public.member_case_assignment_audit is
  'Authenticated coordinators read assignment history only when current member visibility or captured retained-case authorization permits it.';

create function private.account_lifecycle_is_nested_case_detachment(p_old_case_id uuid, p_new_case_id uuid)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $function$
  select p_old_case_id is not null
    and p_new_case_id is null
    and pg_catalog.pg_trigger_depth() > 1
    and not exists (select 1 from public.member_cases where id = p_old_case_id);
$function$;

revoke all on function private.account_lifecycle_is_nested_case_detachment(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function private.prevent_case_assignment_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE'
     and private.account_lifecycle_is_nested_case_detachment(old.case_id, new.case_id)
     and (pg_catalog.to_jsonb(new) - 'case_id')
       is not distinct from (pg_catalog.to_jsonb(old) - 'case_id') then
    return new;
  end if;
  raise exception 'case assignment audit is immutable' using errcode = '42501';
end;
$function$;

create or replace function public.casework_add_management_addendum(p_entry_id uuid, p_body text)
returns public.casework_management_addenda
language plpgsql security definer set search_path = '' as $function$
declare v_entry public.casework_management_entries%rowtype; v_row public.casework_management_addenda%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  select * into strict v_entry from public.casework_management_entries where id = p_entry_id for share;
  if not private.member_has_chapter_role(v_entry.chapter_id, array['steward','coordinator','advisor','admin','vp']) or (case when v_entry.case_id is not null then not private.casework_staff_can_access(v_entry.case_id) else not coalesce(private.account_lifecycle_retained_case_scope_allows('management_entry', v_entry.id::text, v_entry.chapter_id), true) end) then raise exception 'entry not found' using errcode = 'P0002'; end if;
  insert into public.casework_management_addenda(entry_id, organization_id, body, created_by)
  values (v_entry.id, v_entry.organization_id, pg_catalog.btrim(p_body), (select auth.uid())) returning * into v_row;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_entry.organization_id, v_entry.chapter_id, v_entry.case_id, (select auth.uid()), 'behavior_addendum_added', 'management_addendum', v_row.id);
  -- Audit rows produced after detachment inherit the entry's retained inputs.
  insert into private.account_lifecycle_history_scope(kind, record_id, case_id)
  select 'casework_audit', a.id::text, h.case_id
  from public.casework_audit_events a
  join private.account_lifecycle_history_scope h on h.kind = 'management_entry' and h.record_id = v_entry.id::text
  where a.entity_id = v_row.id and a.entity_type = 'management_addendum'
  on conflict (kind, record_id) do update set case_id = excluded.case_id;
  return v_row;
end;
$function$;


drop policy casework_audit_events_staff_read on public.casework_audit_events;
create policy casework_audit_events_staff_read on public.casework_audit_events
for select to authenticated using (
  private.has_organization_role(organization_id, array['coordinator','advisor','admin','vp'])
  or (case_id is not null and private.casework_staff_can_access(case_id))
  or (case_id is null and private.account_lifecycle_retained_case_scope_allows('casework_audit', id::text, chapter_id))
);
comment on policy casework_audit_events_staff_read on public.casework_audit_events is
  'Authenticated organization staff read audit events only through their organization role, current case authorization, or captured retained-case scope.';
drop policy casework_deadline_extensions_read on public.casework_deadline_extensions;
create policy casework_deadline_extensions_read on public.casework_deadline_extensions
for select to authenticated using (
  exists (select 1 from public.casework_deadlines d where d.id = casework_deadline_extensions.deadline_id
    and d.organization_id = casework_deadline_extensions.organization_id and private.casework_can_read(d.case_id))
  or (deadline_id is null and private.account_lifecycle_retained_case_scope_allows('deadline_extension', id::text, null))
);
comment on policy casework_deadline_extensions_read on public.casework_deadline_extensions is
  'Authenticated staff read deadline extensions only through an authorized live deadline or the captured authorization for a retained detached extension.';

create or replace function public.casework_withdraw_retaliation_report(p_report_id uuid, p_reason text)
returns public.casework_retaliation_reports
language plpgsql security definer set search_path = '' as $function$
declare v_row public.casework_retaliation_reports%rowtype;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform private.casework_require_mfa();
  update public.casework_retaliation_reports set status = 'withdrawn', withdrawn_at = pg_catalog.now(), withdrawal_reason = pg_catalog.btrim(p_reason), updated_at = pg_catalog.now()
  where id = p_report_id and reporter_user_id = (select auth.uid()) and status = 'submitted' returning * into v_row;
  if not found then raise exception 'report not found or cannot be withdrawn' using errcode = 'P0002'; end if;
  insert into public.casework_audit_events(organization_id, chapter_id, case_id, actor_user_id, event_type, entity_type, entity_id)
  values (v_row.organization_id, v_row.chapter_id, v_row.case_id, (select auth.uid()), 'retaliation_withdrawn', 'retaliation_report', v_row.id);
  -- Reporter ownership above is the exact live and retained write predicate.
  -- Preserve the reader scope of the resulting audit when the case is gone.
  insert into private.account_lifecycle_history_scope(kind, record_id, case_id)
  select 'casework_audit', a.id::text, h.case_id
  from public.casework_audit_events a
  join private.account_lifecycle_history_scope h on h.kind = 'retaliation_report' and h.record_id = v_row.id::text
  where a.entity_id = v_row.id and a.entity_type = 'retaliation_report'
  on conflict (kind, record_id) do update set case_id = excluded.case_id;
  return v_row;
end;
$function$;

-- Conservative reviewed superset: every application trigger/rule, including
-- INSERT side effects and tables reached only by trigger DML, plus the complete
-- statically named helper closure. Exact definition pins detect changed dynamic
-- SQL too; new triggers/rules/functions cannot be silently enrolled at runtime.
create trigger a00_case_graph_lock before insert or update or delete on auth.identities
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.mfa_amr_claims
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.mfa_challenges
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.mfa_factors
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.oauth_authorizations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.oauth_consents
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.one_time_tokens
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.refresh_tokens
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.sessions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.users
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.webauthn_challenges
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on auth.webauthn_credentials
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.account_lifecycle_case_scope
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.account_lifecycle_history_scope
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.assurance_synthetic_accounts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.attachment_removal_receipts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.calendar_oauth_states
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_task_number_counters
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.constant_contact_oauth_states
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.constant_contact_oauth_tokens
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.demo_seed_function_evidence
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.demo_seed_page_evidence
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.dues_checkout_recovery_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.dues_financial_identity_selections
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.dues_sample_seed_ledger
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.dues_sample_seed_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.dues_stripe_oauth_states
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.google_drive_oauth_states
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_account_deletions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_event_checkin_tokens
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_form_signatures
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_mfa_recovery_locks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_mfa_reset_boundaries
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_native_push_installation_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_native_push_registration_limits
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_notification_push_target_receipts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_password_reissues
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_session_closing_barriers
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_session_revocations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_signin_recoveries
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_sms_preferences
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.member_stress_chapter_plan
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.mi1_w2_operation_receipt_rows
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.mi1_w2_operation_receipts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.organization_analytics_idempotency_receipts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.presg_demo_ledger
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.presg_demo_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.private_upload_inspection_attempts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.private_upload_inspection_limits
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.steward_calendar_oauth_tokens
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.twilio_sms_attempts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.uniondemo_chapters
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.uniondemo_ledger
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.uniondemo_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on private.workload_reminder_preferences
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_alert_acknowledgements
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_alerts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_checklist_progress
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_deadline_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_deadline_changes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_generated_work
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_reminders
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_restriction_access
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_restrictions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.case_step_transitions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_access_grants
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_alert_acknowledgements
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_alerts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_audit_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_bargaining_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_bargaining_proposals
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_bargaining_workspaces
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_checklist_items
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_checklist_templates
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_checklists
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_deadline_extensions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_deadlines
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_entity_links
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_intake_drafts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_management_addenda
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_management_entries
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_management_people
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_reminders
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_retaliation_pattern_notes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_retaliation_pattern_reports
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_retaliation_patterns
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_retaliation_reports
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_step_transitions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.casework_strength_analyses
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_channel_poll_options
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_channel_poll_votes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_channel_polls
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_connection_readiness
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_contact_log
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_documents
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_governance_requests
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_handshake_documents
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_handshake_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_handshakes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_health_coaching
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_health_snapshots
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_integration_overrides
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_record_versions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_records
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_space_controls
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_space_members
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_space_reads
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_spaces
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_activity
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_assignments
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_attachments
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_comments
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_dependencies
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_files
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_messages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_subtasks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_template_details
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_task_watchers
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_tasks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_thread_posts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_threads
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_union_org_bindings
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapter_workstreams
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.chapters
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.compass_ai_policy
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.compass_ai_role_limits
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.compass_message_briefings
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.compass_workspace_actions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.compass_workspace_preferences
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.constant_contact_member_analytics
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.constant_contact_sync_requests
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.constant_contact_sync_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.contract_clauses
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.coordinator_case_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.digital_action_exports
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.digital_action_participants
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.digital_actions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_assessment_batches
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_checkout_reservations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_ledger_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_member_subjects
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_notification_deliveries
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_obligations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_provider_connections
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_receipt_counters
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_reminder_attempts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.dues_stripe_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.engagement_delivery_outbox
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.form_templates
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.integration_api_keys
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.integration_jobs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.integration_webhook_deliveries
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.integration_webhooks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.knowledge_collection_items
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.knowledge_collections
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.meeting_attendance
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.meeting_minutes_dispatches
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_access_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_accommodation_requests
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_action_log
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_admin_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_ai_requests
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_appointment_blackouts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_appointment_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_appointment_schedules
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_appointment_windows
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_appointments
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_ballot_choices
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_ballot_options
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_ballot_receipts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_ballot_votes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_ballots
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_broadcast_receipts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_broadcasts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_calendar_busy
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_calendar_connections
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_calendar_feed_tokens
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_calendar_import_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_case_assignment_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_case_contacts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_case_files
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_case_outcomes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_case_updates
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_cases
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_chapter_memberships
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_contact_notes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_conversations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_emergency_checklists
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_event_checkins
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_event_rsvps
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_form_cosigners
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_form_files
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_forms
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_guide_messages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_guide_threads
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_handoffs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_hr_contacts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_intake_reports
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_invitation_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_invitations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_kb_article_revisions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_kb_articles
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_mentorship_goals
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_mentorship_notes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_mentorship_pairs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_message_reactions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_message_reminders
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_message_resources
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_messages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_native_push_installations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_notification_deliveries
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_notifications
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_onboarding_plans
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_peer_contact_keys
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_peer_contact_requests
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_peer_conversations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_peer_messages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_point_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_presence
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_profiles
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_push_subscriptions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_qa_questions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_qa_replies
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_qa_votes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_report_preferences
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_reward_economy_revisions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_reward_grants
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_reward_tier_attainment
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_rights_progress
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_role_chapters
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_roles
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_saved_messages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_scheduled_messages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_steward_relationships
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_steward_requests
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_support_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_survey_options
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_survey_responses
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_surveys
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_vp_case_reviews
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_weekly_question_promotions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_weekly_question_supports
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_weekly_questions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_welcome_enrollments
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.member_workload_logs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.mfa_recovery_code_sets
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.mfa_recovery_codes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.org_security_policy
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_analytics_exports
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_analytics_layout_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_analytics_layouts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_audit_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_audit_ledger
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_automation_definitions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_automation_effects
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_automation_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_automation_settings
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_chart_nodes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coalition_decision_votes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coalition_decisions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_configuration_audit
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_export_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_messages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_organization_participants
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_outreach_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_page_attachments
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_records
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_resources
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_coordination_user_participants
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_data_export_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_engagement_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_failed_login_attempts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_field_note_blocks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_field_note_packets
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_field_note_sources
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_hr_directory
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_import_batches
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_import_rows
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_integrations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_intelligence_audit_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_job_acknowledgements
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_job_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_knowledge_chunks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_knowledge_conversions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_knowledge_files
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_knowledge_sources
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_label_overrides
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_live_poll_attendance
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_live_poll_options
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_live_poll_votes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_live_polls
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_member_operational_profiles
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_memberships
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_merge_jobs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_merge_match_reviews
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_merge_remap_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_mission_badges
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_network_access_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_network_directory_profiles
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_network_permission_grants
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_object_action_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_onboarding_steps
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_page_views
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_poms_evidence
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_poms_ingest_chunks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_poms_sources
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_pulse_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_pulse_prompts
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_relationships
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_retention_policies
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_retention_runs
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_role_grants
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_setting_values
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_survey_answers
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_survey_deliveries
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_survey_questions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_survey_reviews
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_survey_sessions
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_survey_tasks
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_surveys
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_timeline_events
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_topic_progress
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_welcome_campaign_steps
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organization_welcome_campaigns
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.organizations
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.pay_scale_grades
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.pay_scale_steps
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.public_chapter_page_attachments
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.public_chapter_page_takeovers
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.public_chapter_pages
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.public_chapter_sections
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.public_event_rsvps
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.public_site_records
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.scim_tokens
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.steward_email_intakes
for each statement execute function private.lock_case_graph_statement();
create trigger a00_case_graph_lock before insert or update or delete on public.weekly_question_selection_policies
for each statement execute function private.lock_case_graph_statement();

create trigger z99_case_graph_keys before insert or update or delete on private.member_account_deletions
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger z99_case_graph_keys before insert or update or delete on private.uniondemo_ledger
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger z99_case_graph_keys before insert or update or delete on private.uniondemo_chapters
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger z99_case_graph_keys before insert or update or delete on private.presg_demo_ledger
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger z99_case_graph_keys before insert or update or delete on auth.identities
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.mfa_amr_claims
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.mfa_challenges
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.mfa_factors
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.oauth_authorizations
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.oauth_consents
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.one_time_tokens
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.refresh_tokens
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.sessions
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.users
for each row execute function private.lock_case_graph_row_keys('id', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.webauthn_challenges
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on auth.webauthn_credentials
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.account_lifecycle_case_scope
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.account_lifecycle_history_scope
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.assurance_synthetic_accounts
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.attachment_removal_receipts
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.calendar_oauth_states
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_task_number_counters
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.constant_contact_oauth_states
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.constant_contact_oauth_tokens
for each row execute function private.lock_case_graph_row_keys('{connected_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.demo_seed_function_evidence
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.demo_seed_page_evidence
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.dues_checkout_recovery_audit
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.dues_financial_identity_selections
for each row execute function private.lock_case_graph_row_keys('{selected_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.dues_sample_seed_ledger
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.dues_sample_seed_runs
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.dues_stripe_oauth_states
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.google_drive_oauth_states
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_event_checkin_tokens
for each row execute function private.lock_case_graph_row_keys('{consumed_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_form_signatures
for each row execute function private.lock_case_graph_row_keys('{signer_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_mfa_recovery_locks
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_mfa_reset_boundaries
for each row execute function private.lock_case_graph_row_keys('{reset_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_native_push_installation_audit
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_native_push_registration_limits
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_notification_push_target_receipts
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_password_reissues
for each row execute function private.lock_case_graph_row_keys('{actor},{target_user}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_session_closing_barriers
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_session_revocations
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_signin_recoveries
for each row execute function private.lock_case_graph_row_keys('{actor},{target_user}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_sms_preferences
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.member_stress_chapter_plan
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.mi1_w2_operation_receipt_rows
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.organization_analytics_idempotency_receipts
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.private_upload_inspection_attempts
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.private_upload_inspection_limits
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.steward_calendar_oauth_tokens
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on private.twilio_sms_attempts
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on private.workload_reminder_preferences
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.case_alert_acknowledgements
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.case_alerts
for each row execute function private.lock_case_graph_row_keys('', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_checklist_progress
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_deadline_audit
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_deadline_changes
for each row execute function private.lock_case_graph_row_keys('{requested_by},{reviewed_by}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_generated_work
for each row execute function private.lock_case_graph_row_keys('', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_reminders
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_restriction_access
for each row execute function private.lock_case_graph_row_keys('{granted_by},{user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_restrictions
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.case_step_transitions
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_access_grants
for each row execute function private.lock_case_graph_row_keys('{granted_by},{grantee_user_id},{revoked_by}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_alert_acknowledgements
for each row execute function private.lock_case_graph_row_keys('{acknowledged_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_alerts
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_audit_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_bargaining_events
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_bargaining_proposals
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_bargaining_workspaces
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_checklist_items
for each row execute function private.lock_case_graph_row_keys('{completed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_checklist_templates
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_checklists
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_deadline_extensions
for each row execute function private.lock_case_graph_row_keys('{decided_by},{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_deadlines
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_entity_links
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{source_case_id,organization_id,chapter_id},{target_case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_intake_drafts
for each row execute function private.lock_case_graph_row_keys('{member_user_id},{owner_user_id}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_management_addenda
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_management_entries
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_management_people
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_reminders
for each row execute function private.lock_case_graph_row_keys('{owner_user_id}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_retaliation_pattern_notes
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_retaliation_pattern_reports
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_retaliation_patterns
for each row execute function private.lock_case_graph_row_keys('{reviewed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_retaliation_reports
for each row execute function private.lock_case_graph_row_keys('{reporter_user_id}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_step_transitions
for each row execute function private.lock_case_graph_row_keys('{transitioned_by}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.casework_strength_analyses
for each row execute function private.lock_case_graph_row_keys('{analyzed_by}', '{case_id,organization_id,chapter_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_channel_poll_options
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_channel_poll_votes
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_channel_polls
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_connection_readiness
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_contact_log
for each row execute function private.lock_case_graph_row_keys('{created_by},{subject_user_id},{updated_by}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_documents
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_governance_requests
for each row execute function private.lock_case_graph_row_keys('{handled_by},{requester_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_handshake_documents
for each row execute function private.lock_case_graph_row_keys('{shared_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_handshake_events
for each row execute function private.lock_case_graph_row_keys('{actor}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_handshakes
for each row execute function private.lock_case_graph_row_keys('{countersigned_by},{receiver_signed_by},{requested_by},{requester_signed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_health_coaching
for each row execute function private.lock_case_graph_row_keys('{author_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_health_snapshots
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_integration_overrides
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_record_versions
for each row execute function private.lock_case_graph_row_keys('{changed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_records
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_space_controls
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_space_members
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_space_reads
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_spaces
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_activity
for each row execute function private.lock_case_graph_row_keys('{actor_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_assignments
for each row execute function private.lock_case_graph_row_keys('{assigned_by},{assignee_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_attachments
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_comments
for each row execute function private.lock_case_graph_row_keys('{author_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_dependencies
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_files
for each row execute function private.lock_case_graph_row_keys('{uploaded_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_messages
for each row execute function private.lock_case_graph_row_keys('{recipient_id},{sender_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_subtasks
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_template_details
for each row execute function private.lock_case_graph_row_keys('{created_by},{reviewer_id},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_task_watchers
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_tasks
for each row execute function private.lock_case_graph_row_keys('{assignee_id},{created_by},{deleted_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_thread_posts
for each row execute function private.lock_case_graph_row_keys('{author_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_threads
for each row execute function private.lock_case_graph_row_keys('{created_by}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_union_org_bindings
for each row execute function private.lock_case_graph_row_keys('{requested_by},{verified_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapter_workstreams
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.chapters
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.compass_ai_policy
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.compass_ai_role_limits
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.compass_message_briefings
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.compass_workspace_actions
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.compass_workspace_preferences
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.constant_contact_member_analytics
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.constant_contact_sync_requests
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.constant_contact_sync_runs
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.contract_clauses
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.coordinator_case_audit
for each row execute function private.lock_case_graph_row_keys('{actor_id},{user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.digital_action_exports
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.digital_action_participants
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.digital_actions
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_assessment_batches
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_checkout_reservations
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_ledger_events
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_member_subjects
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_notification_deliveries
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_obligations
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_provider_connections
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_receipt_counters
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_reminder_attempts
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.dues_stripe_events
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.engagement_delivery_outbox
for each row execute function private.lock_case_graph_row_keys('{recipient_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.form_templates
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.integration_api_keys
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.integration_jobs
for each row execute function private.lock_case_graph_row_keys('{target_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.integration_webhook_deliveries
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.integration_webhooks
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.knowledge_collection_items
for each row execute function private.lock_case_graph_row_keys('{added_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.knowledge_collections
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.meeting_attendance
for each row execute function private.lock_case_graph_row_keys('{recorded_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.meeting_minutes_dispatches
for each row execute function private.lock_case_graph_row_keys('{recipient_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_access_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id},{subject_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_accommodation_requests
for each row execute function private.lock_case_graph_row_keys('{member_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_action_log
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_admin_audit
for each row execute function private.lock_case_graph_row_keys('{actor},{target_user}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_ai_requests
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_appointment_blackouts
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_appointment_events
for each row execute function private.lock_case_graph_row_keys('{actor}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_appointment_schedules
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_appointment_windows
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_appointments
for each row execute function private.lock_case_graph_row_keys('{cancelled_by},{steward_id},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_ballot_choices
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_ballot_options
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_ballot_receipts
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_ballot_votes
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_ballots
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_broadcast_receipts
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_broadcasts
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_calendar_busy
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_calendar_connections
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_calendar_feed_tokens
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_calendar_import_events
for each row execute function private.lock_case_graph_row_keys('{steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_case_assignment_audit
for each row execute function private.lock_case_graph_row_keys('', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_case_contacts
for each row execute function private.lock_case_graph_row_keys('{coordinator_id},{user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_case_files
for each row execute function private.lock_case_graph_row_keys('{uploaded_by},{user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_case_outcomes
for each row execute function private.lock_case_graph_row_keys('{recorded_by},{user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_case_updates
for each row execute function private.lock_case_graph_row_keys('{user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_cases
for each row execute function private.lock_case_graph_row_keys('{coordinator_user_id},{restricted_by},{steward_user_id},{user_id}', 'id');
create trigger z99_case_graph_keys before insert or update or delete on public.member_chapter_memberships
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_contact_notes
for each row execute function private.lock_case_graph_row_keys('{author_id},{member_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_conversations
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_emergency_checklists
for each row execute function private.lock_case_graph_row_keys('{member_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_event_checkins
for each row execute function private.lock_case_graph_row_keys('{scanned_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_event_rsvps
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_events
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_form_cosigners
for each row execute function private.lock_case_graph_row_keys('{cosigner_user_id},{invited_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_form_files
for each row execute function private.lock_case_graph_row_keys('{deletion_requested_by},{uploaded_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_forms
for each row execute function private.lock_case_graph_row_keys('{artifact_approved_by},{user_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_guide_messages
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_guide_threads
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_handoffs
for each row execute function private.lock_case_graph_row_keys('{from_steward_id},{initiated_by},{member_user_id},{to_steward_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_hr_contacts
for each row execute function private.lock_case_graph_row_keys('{actor_user_id},{member_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_intake_reports
for each row execute function private.lock_case_graph_row_keys('{assigned_to},{reporter_id}', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_invitation_audit
for each row execute function private.lock_case_graph_row_keys('{actor}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_invitations
for each row execute function private.lock_case_graph_row_keys('{auth_user_id},{invited_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_kb_article_revisions
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_kb_articles
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_mentorship_goals
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_mentorship_notes
for each row execute function private.lock_case_graph_row_keys('{author_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_mentorship_pairs
for each row execute function private.lock_case_graph_row_keys('{created_by},{mentee_user_id},{mentor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_message_reactions
for each row execute function private.lock_case_graph_row_keys('{actor_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_message_reminders
for each row execute function private.lock_case_graph_row_keys('{owner_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_message_resources
for each row execute function private.lock_case_graph_row_keys('{added_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_messages
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_native_push_installations
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_notification_deliveries
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_notifications
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_onboarding_plans
for each row execute function private.lock_case_graph_row_keys('{assigned_by},{member_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_peer_contact_keys
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_peer_contact_requests
for each row execute function private.lock_case_graph_row_keys('{recipient_id},{requester_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_peer_conversations
for each row execute function private.lock_case_graph_row_keys('{user_high},{user_low}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_peer_messages
for each row execute function private.lock_case_graph_row_keys('{sender_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_point_events
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_presence
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_profiles
for each row execute function private.lock_case_graph_row_keys('{id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_push_subscriptions
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_qa_questions
for each row execute function private.lock_case_graph_row_keys('{author_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_qa_replies
for each row execute function private.lock_case_graph_row_keys('{author_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_qa_votes
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_report_preferences
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_reward_economy_revisions
for each row execute function private.lock_case_graph_row_keys('{actor_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_reward_grants
for each row execute function private.lock_case_graph_row_keys('{granted_by},{revoked_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_reward_tier_attainment
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_rights_progress
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_role_chapters
for each row execute function private.lock_case_graph_row_keys('{granted_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_roles
for each row execute function private.lock_case_graph_row_keys('{granted_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_saved_messages
for each row execute function private.lock_case_graph_row_keys('{owner_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_scheduled_messages
for each row execute function private.lock_case_graph_row_keys('{actor_id},{recipient_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_steward_relationships
for each row execute function private.lock_case_graph_row_keys('{member_user_id},{steward_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_steward_requests
for each row execute function private.lock_case_graph_row_keys('{handled_by},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_support_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id},{member_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_survey_options
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_survey_responses
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_surveys
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_vp_case_reviews
for each row execute function private.lock_case_graph_row_keys('', '{case_id}');
create trigger z99_case_graph_keys before insert or update or delete on public.member_weekly_question_promotions
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_weekly_question_supports
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_weekly_questions
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_welcome_enrollments
for each row execute function private.lock_case_graph_row_keys('{enrolled_by},{member_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.member_workload_logs
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.mfa_recovery_code_sets
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.mfa_recovery_codes
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.org_security_policy
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_analytics_exports
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_analytics_layout_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_analytics_layouts
for each row execute function private.lock_case_graph_row_keys('{owner_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_audit_events
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_audit_ledger
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_automation_definitions
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_automation_effects
for each row execute function private.lock_case_graph_row_keys('{rolled_back_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_automation_runs
for each row execute function private.lock_case_graph_row_keys('{initiated_by},{rolled_back_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_automation_settings
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_chart_nodes
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coalition_decision_votes
for each row execute function private.lock_case_graph_row_keys('{voter_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coalition_decisions
for each row execute function private.lock_case_graph_row_keys('{proposed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_configuration_audit
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_export_runs
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_messages
for each row execute function private.lock_case_graph_row_keys('{sender_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_organization_participants
for each row execute function private.lock_case_graph_row_keys('{invited_by},{responded_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_outreach_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_page_attachments
for each row execute function private.lock_case_graph_row_keys('{attached_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_records
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_resources
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_coordination_user_participants
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_data_export_runs
for each row execute function private.lock_case_graph_row_keys('{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_engagement_events
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_failed_login_attempts
for each row execute function private.lock_case_graph_row_keys('{member_user_id},{reviewed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_field_note_blocks
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_field_note_packets
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_field_note_sources
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_hr_directory
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_import_batches
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_import_rows
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_integrations
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_intelligence_audit_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_job_acknowledgements
for each row execute function private.lock_case_graph_row_keys('{acknowledged_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_job_runs
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_knowledge_chunks
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_knowledge_conversions
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_knowledge_files
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_knowledge_sources
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_label_overrides
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_live_poll_attendance
for each row execute function private.lock_case_graph_row_keys('{check_in_actor},{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_live_poll_options
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_live_poll_votes
for each row execute function private.lock_case_graph_row_keys('{voter_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_live_polls
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_member_operational_profiles
for each row execute function private.lock_case_graph_row_keys('{member_user_id},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_memberships
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_merge_jobs
for each row execute function private.lock_case_graph_row_keys('{executed_by},{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_merge_match_reviews
for each row execute function private.lock_case_graph_row_keys('{reviewed_by},{source_user_id},{target_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_merge_remap_events
for each row execute function private.lock_case_graph_row_keys('{executed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_mission_badges
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_network_access_events
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_network_directory_profiles
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_network_permission_grants
for each row execute function private.lock_case_graph_row_keys('{granted_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_object_action_runs
for each row execute function private.lock_case_graph_row_keys('{actor_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_onboarding_steps
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_page_views
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_poms_evidence
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_poms_ingest_chunks
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_poms_sources
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_pulse_events
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_pulse_prompts
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_relationships
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_retention_policies
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_retention_runs
for each row execute function private.lock_case_graph_row_keys('{authorized_by},{requested_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_role_grants
for each row execute function private.lock_case_graph_row_keys('{granted_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_setting_values
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_survey_answers
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_survey_deliveries
for each row execute function private.lock_case_graph_row_keys('{recipient_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_survey_questions
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_survey_reviews
for each row execute function private.lock_case_graph_row_keys('{assigned_to}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_survey_sessions
for each row execute function private.lock_case_graph_row_keys('{respondent_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_survey_tasks
for each row execute function private.lock_case_graph_row_keys('{assigned_to},{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_surveys
for each row execute function private.lock_case_graph_row_keys('{created_by},{owner_user_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_timeline_events
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_topic_progress
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_welcome_campaign_steps
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organization_welcome_campaigns
for each row execute function private.lock_case_graph_row_keys('{created_by},{updated_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.organizations
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.pay_scale_grades
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.pay_scale_steps
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.public_chapter_page_attachments
for each row execute function private.lock_case_graph_row_keys('{attached_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.public_chapter_page_takeovers
for each row execute function private.lock_case_graph_row_keys('{new_owner_id},{previous_owner_id}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.public_chapter_pages
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.public_chapter_sections
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.public_event_rsvps
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.public_site_records
for each row execute function private.lock_case_graph_row_keys('{created_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.scim_tokens
for each row execute function private.lock_case_graph_row_keys('', '');
create trigger z99_case_graph_keys before insert or update or delete on public.steward_email_intakes
for each row execute function private.lock_case_graph_row_keys('{reviewed_by}', '');
create trigger z99_case_graph_keys before insert or update or delete on public.weekly_question_selection_policies
for each row execute function private.lock_case_graph_row_keys('{updated_by}', '');

create function private.account_lifecycle_trigger_surface()
returns table(kind text, schema_name text, table_name text, object_name text, definition_hash text)
language sql stable security definer set search_path = '' as $function$
  with recursive roots as (
    select 'trigger'::text kind, n.nspname::text schema_name, c.relname::text table_name,
      t.tgname::text object_name, t.tgfoid function_oid,
      pg_catalog.pg_get_triggerdef(t.oid) || ':' || t.tgenabled::text as definition
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid=t.tgrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname in ('public','private','auth')
    union all
    select 'rule', n.nspname, c.relname, r.rulename, 0::oid,
      pg_catalog.pg_get_ruledef(r.oid) || ':' || r.ev_enabled::text
    from pg_catalog.pg_rewrite r
    join pg_catalog.pg_class c on c.oid=r.ev_class
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where r.rulename <> '_RETURN' and n.nspname in ('public','private','auth')
  ), app_functions as (
    select p.oid, n.nspname::text schema_name, p.proname::text object_name, p.prosrc,
      pg_catalog.pg_get_function_identity_arguments(p.oid) arguments,
      pg_catalog.pg_get_functiondef(p.oid) definition
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private','auth') and p.prokind='f'
      and not exists (select 1 from pg_catalog.pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
  ), reachable(oid) as (
    select f.oid from app_functions f where exists (
      select 1 from roots r where r.function_oid=f.oid
        or (r.kind='rule' and r.definition ~ ('\m' || f.object_name || '\M'))
    )
    union
    select child.oid from reachable parent
    join app_functions f on f.oid=parent.oid
    join app_functions child on f.prosrc ~ ('\m' || child.object_name || '\M')
  )
  select kind, schema_name, table_name, object_name, pg_catalog.md5(definition) from roots
  union all
  select 'function', f.schema_name, '', f.object_name || '(' || f.arguments || ')', pg_catalog.md5(f.definition)
  from reachable join app_functions f on f.oid=reachable.oid;
$function$;
revoke all on function private.account_lifecycle_trigger_surface() from public, anon, authenticated, service_role;

create table private.account_lifecycle_trigger_review (
  kind text not null, schema_name text not null, table_name text not null,
  object_name text not null, definition_hash text not null,
  primary key(kind, schema_name, table_name, object_name)
);
revoke all on private.account_lifecycle_trigger_review from public, anon, authenticated, service_role;
create trigger z99_case_graph_keys before insert or update or delete on private.uniondemo_runs
for each row execute function private.lock_case_graph_row_keys('', '');

create trigger z99_case_graph_keys before insert or update or delete on private.presg_demo_runs
for each row execute function private.lock_case_graph_row_keys('', '');

-- Reviewed 2026-09-07: 867 application triggers, no non-view rewrite rules,
-- and 177 reachable functions at the final 141000 migration tail. Existing legal-hold/actor/immutability guards
-- remain intentional blockers for their own protected states; the manifest
-- does not waive them. Only the exact reviewed referential exceptions apply.
-- This is a conservative whole-application superset of the deletion touch graph,
-- so DML reached through triggers/helpers cannot escape a direct-FK inventory.
insert into private.account_lifecycle_trigger_review values
  ('function', 'auth', '', 'email()', 'bf3569f4ae1c7e250e74daf51d0311c7'),
  ('function', 'auth', '', 'jwt()', '20054548ba2003f61a6bcb472175700b'),
  ('function', 'auth', '', 'role()', '8a3e05459e07e0633d43c6fba2a2cdf4'),
  ('function', 'auth', '', 'uid()', 'ea3b41bf29e2ad573067939329aa088e'),
  ('function', 'private', '', 'account_lifecycle_capture_case(p_case public.member_cases)', '040a122a4f737f6b84185da4f20b712a'),
  ('function', 'private', '', 'account_lifecycle_is_nested_auth_detachment(p_old_user_id uuid, p_new_user_id uuid)', 'e3f55e19bb4568553d1f6960ba60667f'),
  ('function', 'private', '', 'account_lifecycle_is_nested_case_detachment(p_old_case_id uuid, p_new_case_id uuid)', '43715307062aaabcc613cf471516036d'),
  ('function', 'private', '', 'actor_has_chapter_staff_role(p_actor uuid, p_chapter text)', 'ed0b9613c428626340cc995378b13fcc'),
  ('function', 'private', '', 'assert_chapter_task_ceiling()', 'b08dea519394c78f2d451606db8cf01d'),
  ('function', 'private', '', 'assert_chapter_workstream()', 'f632145699650bc3a03a1b083c34688d'),
  ('function', 'private', '', 'assert_member_account_deletion_allowed(p_user_id uuid)', '610de1567364e3a69283d762fc800989'),
  ('function', 'private', '', 'assign_member_admin_audit_organization()', '8a27bf6d4babfef34cff2e91053fbd7a'),
  ('function', 'private', '', 'audit_chapter_task_change()', 'f14b2bd0e42de46043e6ad6c4d57166e'),
  ('function', 'private', '', 'audit_member_native_push_installation()', '8664f2ac026864232ca43a6a4b3b5cd1'),
  ('function', 'private', '', 'award_member_points()', '40aa625b08bd02797fac3d9590a6b55c'),
  ('function', 'private', '', 'award_organization_mission_badges()', '11022bc3343918bc6c533dc9f367b417'),
  ('function', 'private', '', 'award_steward_interaction()', '61fc7cbe7b315fc3d5b7976243341ffa'),
  ('function', 'private', '', 'broadcast_chapter_task_change()', '557ca2277b4de56a255b42e94835c2d9'),
  ('function', 'private', '', 'bump_chapter_thread_on_post()', '9e962f14f1945fca2170679e092abe94'),
  ('function', 'private', '', 'capture_account_lifecycle_auth_scope()', '403a2da5e3f19485cf7ed571e55ceaff'),
  ('function', 'private', '', 'capture_account_lifecycle_case_scope()', '80388783e1bfb3026acdebed06ca59eb'),
  ('function', 'private', '', 'capture_assurance_synthetic_account()', '6ac7ab8846d9b543dd6d2d444bbeffe1'),
  ('function', 'private', '', 'carry_rescheduled_appointment_place()', 'e72a2bad80954aaf9834867f5034c2e1'),
  ('function', 'private', '', 'casework_require_mfa()', '9fc3cf827dc5c2a9e438926c3c86424b'),
  ('function', 'private', '', 'casework_staff_can_access(p_case_id uuid)', '56528952191b6f5f2b73cfb7312086f4'),
  ('function', 'private', '', 'challengeable_factor_types()', 'f232a2bbb00faeb5436b5479b7b9fa5f'),
  ('function', 'private', '', 'current_member_chapter()', '66d2119d4ba08a84c9ed80636a81237f'),
  ('function', 'private', '', 'current_member_organization()', 'b53dd743e9944493fd782108caabd748'),
  ('function', 'private', '', 'current_mobile_staff_organization()', '8f97a9b44bc230128e76003346532ae8'),
  ('function', 'private', '', 'demo_seed_analytics_after_evidence_delete()', '0cb8c7960051816cc2bdae81b87e746f'),
  ('function', 'private', '', 'demo_seed_analytics_after_page_evidence_insert()', '65c3206bc0cc63228e5dac6fa4859447'),
  ('function', 'private', '', 'demo_seed_analytics_status(p_lane text, p_run_id uuid)', '6c858f4cea4054287e03480fd231678c'),
  ('function', 'private', '', 'demo_seed_apply_administrative_evidence(p_lane text, p_run_id uuid)', '33c1d7fb807acf029a345814c8e57dc6'),
  ('function', 'private', '', 'demo_seed_apply_analytics(p_lane text, p_run_id uuid)', 'b3d466a3d238c07cd9c5ab62e0e0507b'),
  ('function', 'private', '', 'demo_seed_apply_casework(p_lane text, p_run_id uuid)', '0f3a31831828e74811945d4cb6d12e33'),
  ('function', 'private', '', 'demo_seed_apply_member_support(p_lane text, p_run_id uuid)', 'cdfafb6a6882ec49d35d4eed0c2b4c5b'),
  ('function', 'private', '', 'demo_seed_apply_organization_coordination(p_lane text, p_run_id uuid)', '339ec015407c2fb4182bcbc4060949d4'),
  ('function', 'private', '', 'demo_seed_apply_organization_intelligence_unwindowed_20260829(p_lane text, p_run_id uuid)', '655a7f5ad07918d7ccb82da3bd5ce114'),
  ('function', 'private', '', 'demo_seed_apply_organization_intelligence(p_lane text, p_run_id uuid)', '9eeab9835e371b97fa8fd5dfbf252d11'),
  ('function', 'private', '', 'demo_seed_archive_organization_on_remove()', '7facae9acde7b17cf55a8cd3ab5f0df6'),
  ('function', 'private', '', 'demo_seed_casework_status_pre_member_operations_20260830(p_lane text, p_run_id uuid)', '48ed056668ab1c16db2f1c93c779a901'),
  ('function', 'private', '', 'demo_seed_casework_status(p_lane text, p_run_id uuid)', '81aca5406677b2ee5486be1bf5286d39'),
  ('function', 'private', '', 'demo_seed_chapter(p_lane text, p_run_id uuid, p_ordinal integer)', '9a9cc1fcbe9d0c664e2fa590a58182ba'),
  ('function', 'private', '', 'demo_seed_coordination_after_evidence_delete()', '1db23717b2639ae4e1ac3304a3d3d8cb'),
  ('function', 'private', '', 'demo_seed_coordination_after_evidence_insert()', 'ca3b9e71df8bb82cf0f692754ffad9b1'),
  ('function', 'private', '', 'demo_seed_coordination_page_evidence()', '360b71fd2493c465c0712b1e1ed22046'),
  ('function', 'private', '', 'demo_seed_drop_analytics_health_rotation()', '949caf08650de228078ff8308ec2da6b'),
  ('function', 'private', '', 'demo_seed_ensure_analytics_health_rotation()', '0d5145b0843670eb60f7e6bd6e54aaa7'),
  ('function', 'private', '', 'demo_seed_institutional_records_from_evidence()', '13ac6a62955b37e439301977974c3ddb'),
  ('function', 'private', '', 'demo_seed_member_operations_from_evidence()', 'f92f149db0a24fa24fcfef267e4e1b2a'),
  ('function', 'private', '', 'demo_seed_member_support_status(p_lane text, p_run_id uuid)', 'ff3052c20ef4ef07d5078bca678d2cdf'),
  ('function', 'private', '', 'demo_seed_refresh_administrative_page_evidence()', '894ce31b57f9ed74a6ef78fef15cb2ec'),
  ('function', 'private', '', 'demo_seed_refresh_analytics_health(text, uuid)', 'd92a1702397cd13961e41e728c09fb02'),
  ('function', 'private', '', 'demo_seed_refresh_voice_page_evidence()', 'f0c824fe111bcfc95263af82821c6364'),
  ('function', 'private', '', 'demo_seed_remove_administrative_evidence(p_lane text, p_run_id uuid)', '151a950ad9267fdf225afe13154c6229'),
  ('function', 'private', '', 'demo_seed_remove_analytics(p_lane text, p_run_id uuid)', '4584a24b5bd6702ee65e9e45a87af611'),
  ('function', 'private', '', 'demo_seed_remove_casework(p_lane text, p_run_id uuid)', '84b2d247c5c1d75c1436be447d51c73e'),
  ('function', 'private', '', 'demo_seed_remove_member_support(p_lane text, p_run_id uuid)', '9fc71658fca41afc506fe7012c3a17f5'),
  ('function', 'private', '', 'demo_seed_remove_organization_coordination(p_lane text, p_run_id uuid)', '698f65f08214fa033fea03b4b69a6740'),
  ('function', 'private', '', 'demo_seed_remove_organization_intelligence(p_lane text, p_run_id uuid)', 'd09f46503e7e925337eb60b20860cf5f'),
  ('function', 'private', '', 'demo_seed_rotate_analytics_health()', '29ee7f99037495235367a397704d0c49'),
  ('function', 'private', '', 'demo_seed_sync_administrative_evidence()', '30e8dbfb26590d957c0ebcdab8132a47'),
  ('function', 'private', '', 'demo_seed_sync_casework_evidence()', '985e873dbeddea3d58d84ae468229a75'),
  ('function', 'private', '', 'demo_seed_sync_member_support_evidence()', 'a5cbc83cfd2f32fd320bd9904b3f72b3'),
  ('function', 'private', '', 'demo_seed_sync_organization_intelligence_evidence()', 'e75757cc55f70e63844ae91a828efcd9'),
  ('function', 'private', '', 'demo_seed_twilio_operation_history_from_evidence()', '81de00bc23406062a0aa0113c463e05b'),
  ('function', 'private', '', 'demo_seed_twilio_operation_history(p_lane text, p_run_id uuid)', '6fae777477406e9defea382451b56a07'),
  ('function', 'private', '', 'demo_seed_user(p_lane text, p_run_id uuid, p_ordinal integer)', '8b415d66ec6ea8579bcfb240b0a6d072'),
  ('function', 'private', '', 'dues_reject_competing_checkout_mutation()', 'a5c9486a99ced21b405089cd860c9a5b'),
  ('function', 'private', '', 'dues_sample_remove_subjects_on_lane_removal()', '1843a59b9715c0510baa06e00c67aea7'),
  ('function', 'private', '', 'dues_sample_seed_organization(p_lane text, p_run_id uuid)', 'efd4a9e7d3304459d75dffdca4bb370b'),
  ('function', 'private', '', 'enforce_approved_member_form_immutability()', '225d59d623d66145a7cf9e39615d4987'),
  ('function', 'private', '', 'enforce_member_form_child_mutability()', '1184036d0b728449fbba7ee6ffc0ee6c'),
  ('function', 'private', '', 'enforce_organization_role_grant_membership()', '23882438321c93dadd67f50a0dc2f22c'),
  ('function', 'private', '', 'enforce_push_subscription_cap()', '3374193f4871b19dd1788ad0c6b33061'),
  ('function', 'private', '', 'enqueue_notification_deliveries()', '582cafe475745907bdf0a8b16689355f'),
  ('function', 'private', '', 'ensure_dues_sample_seed_covering_indexes()', 'cda5a24bf234657832b583cbec6dee38'),
  ('function', 'private', '', 'finalize_account_lifecycle_auth_scope()', '8e8c2de0eecc32a3692033564b44a690'),
  ('function', 'private', '', 'forbid_new_ownerless_member_roles()', 'd2429f388b9ed2182b8be23e86480498'),
  ('function', 'private', '', 'forbid_organization_audit_mutation()', 'a5f9f2ded71c740681614dd76e7710e5'),
  ('function', 'private', '', 'forbid_ownerless_broadcast_write()', '4636b883191815c659b827175873e570'),
  ('function', 'private', '', 'forbid_ownerless_chapter_write()', '6e91f92f067597556369a5f091cf09c4'),
  ('function', 'private', '', 'forbid_ownerless_reward_grant_write()', 'bdc0ef5565854b10746ecf24a2f7b6ef'),
  ('function', 'private', '', 'form_points(p_template_key text)', 'e57dfc9805e6220402cb60bdd91ee02e'),
  ('function', 'private', '', 'guard_auth_user_deletion()', 'ae41f728b31c8afe77b63c16e0c20519'),
  ('function', 'private', '', 'guard_casework_historical_attribution()', 'f0d3ecce72586c4d20cad4d460c9fb69'),
  ('function', 'private', '', 'guard_casework_restriction_update()', 'bed9fb23735c63f688e689da75b2478f'),
  ('function', 'private', '', 'guard_chapter_task_template_type()', 'c02b3b292e1d0fbc78af4fa67e098efa'),
  ('function', 'private', '', 'guard_member_account_deletion_request()', '367d1a50de70e2cf7b59b0f000121a1a'),
  ('function', 'private', '', 'handle_new_member()', '3570385dd35ebbb12c57706d377120e1'),
  ('function', 'private', '', 'has_organization_role(p_organization_id uuid, p_roles text[])', '7fb91c8babd2807267998737fae080f3'),
  ('function', 'private', '', 'has_second_factor(p_user uuid)', '4910cb349c9c6d1288ea21e21d0e34bd'),
  ('function', 'private', '', 'inherit_organization_coordination_participants()', 'e067ab14cb218ebddf71702ead6446ef'),
  ('function', 'private', '', 'lock_case_graph_row_keys()', 'a28cd538a23ebc13276df547931b93a5'),
  ('function', 'private', '', 'lock_case_graph_statement()', '8da39feab13944e9c0403c1b3c7fcd25'),
  ('function', 'private', '', 'lock_case_graph(p_auth_ids uuid[], p_case_ids uuid[])', 'afdaa961b2d02d00ecc86a3a87200f55'),
  ('function', 'private', '', 'lock_member_form(p_form_id uuid)', 'a567657a29069475cec8413f1d640c29'),
  ('function', 'private', '', 'member_has_chapter_role(p_chapter_id text, p_roles text[])', 'e917789913d479c474688f837846d81b'),
  ('function', 'private', '', 'member_peer_contact_code(p_user_id uuid)', 'c0fd238485247be5a2dfbb92dd61993b'),
  ('function', 'private', '', 'member_stress_pick(p_seed text, p_n integer)', 'f924f17eefb79ba89e15134fa6160232'),
  ('function', 'private', '', 'member_stress_rand(p_seed text)', '1a7ad8f140d13b2a48f541620f779845'),
  ('function', 'private', '', 'member_stress_uuid(p_value text)', 'bf52530c2820740b3ac4a39a48f02748'),
  ('function', 'private', '', 'member_support_is_staff(p_organization_id uuid)', '738260e7761ec86693f4ed208750be8e'),
  ('function', 'private', '', 'member_support_record_event(p_id uuid, p_organization_id uuid, p_member_user_id uuid, p_entity_type text, p_entity_id uuid, p_event_type text)', 'd32f00c862f7e3d6d0898a36fb99f140'),
  ('function', 'private', '', 'mfa_satisfied()', '34253b550b67358f7f5d1fe94a432f3a'),
  ('function', 'private', '', 'mi1_audit_ledger_append_only()', '907fd24ea6b81412bb38eff6fcd6a4f0'),
  ('function', 'private', '', 'mi1_bind_case_owner()', '954d8ae259ffc15bf8cc2e7191fc78fd'),
  ('function', 'private', '', 'mi1_forbid_ownerless_public_publish()', '5fb327d03d67d12878766016e8e0773f'),
  ('function', 'private', '', 'mi1_qa_reply_same_organization()', 'ed33dee6f5698eba24502df97f637ce7'),
  ('function', 'private', '', 'mi1_require_selected_organization()', '7f4d5fc26eb9ab50003496fdfefd98d7'),
  ('function', 'private', '', 'mi1_validate_public_chapter_hierarchy()', 'ac5b9e050ed8525041994e194465c12b'),
  ('function', 'private', '', 'mi1_w2_append_only()', '7d22a98f1efc7efdfa12c120a521a37f'),
  ('function', 'private', '', 'mi1_w2_bind_operation_receipt()', 'be101912e345fd72d4dde30b94e18fb9'),
  ('function', 'private', '', 'mi1_w2_forbid_org_key_mutation()', '78442c95825ff925a38ad14f41dd9888'),
  ('function', 'private', '', 'mi1_w2_knowledge_chunk_same_org()', 'a96961cb242b775ea934d6436300d46d'),
  ('function', 'private', '', 'notify_chapter_task_watchers()', '0b537a2afc43d8147520345541267b22'),
  ('function', 'private', '', 'notify_cosigners_on_approve()', 'd4f732907c9545dc6e765a338dbd3aca'),
  ('function', 'private', '', 'notify_member(p_user_id uuid, p_key text, p_args jsonb, p_kind text)', '9a49301442ced32b4dd327d847cddfc9'),
  ('function', 'private', '', 'notify_mfa_enrolment()', '60105bee6d42dab912cfd50f1530b5cf'),
  ('function', 'private', '', 'notify_stewards_of_request()', '7d115fae742c71a355f07901db60c01b'),
  ('function', 'private', '', 'on_demo_seed_binding_ensure_dues_indexes()', 'ead1a8e4010dc8aa105be9ba75a97248'),
  ('function', 'private', '', 'on_organization_live_poll_vote()', 'c607f7d6fb6bfa31f5d98d09144ee393'),
  ('function', 'private', '', 'on_organization_survey_submitted()', '5d90af63079eb637555bea82b8fafb68'),
  ('function', 'private', '', 'organization_network_has_permission(p_first_organization_id uuid, p_second_organization_id uuid, p_capability text)', 'fd5e09b911e2d028cc8934f2789e6d9d'),
  ('function', 'private', '', 'prepare_chapter_task_dependency()', 'ef4d0e03750efbd5bbecbd56d6ba18e8'),
  ('function', 'private', '', 'prepare_chapter_task_subtask()', '13257e2d1d0af37b56a9169cdfe1d1e2'),
  ('function', 'private', '', 'prepare_chapter_task_watcher()', 'eca394784e295ce45cd554aecbc97af7'),
  ('function', 'private', '', 'prepare_chapter_task()', '022cd953089db0c8e22aa00cd40cacc4'),
  ('function', 'private', '', 'preserve_member_reward_tier()', '7d441dc9f94b199350a94899be82c154'),
  ('function', 'private', '', 'prevent_case_assignment_audit_mutation()', '2f0da3ecce3aa6f00c140aa3f550a29e'),
  ('function', 'private', '', 'provision_dues_member_subject_from_membership()', '8cc6753e21b21728f3dcb210c4b71337'),
  ('function', 'private', '', 'queue_member_broadcast_delivery()', 'ebe657dc2e5a43c7aa9436d4404829d1'),
  ('function', 'private', '', 'recalculate_organization_live_poll(p_poll_id uuid)', '43c7e53e95cea68f18417f6c5cc9776c'),
  ('function', 'private', '', 'refresh_dues_financial_identity_for_context(p_organization_id uuid, p_user_id uuid, p_reset_reason text)', '114498121dcfd14141606b54b0e32e8a'),
  ('function', 'private', '', 'refresh_dues_financial_identity_from_membership()', '1f103c29a1edfce7ba478e895eb422d1'),
  ('function', 'private', '', 'refresh_dues_financial_identity_from_role_grant()', '80f2f6da2d5c1d97f92e011c01e1a30e'),
  ('function', 'private', '', 'refresh_task_assignee_names()', '1dbae8c9ad7940f8edc3a318b6ab58c5'),
  ('function', 'private', '', 'require_sensitive_envelopes()', 'dcfd913959f311dcce0824a16eda0ae6'),
  ('function', 'private', '', 'revoke_organization_role_grants_on_membership_revoke()', 'e96fa9a1f3577f72b3a4e5066b3e46d1'),
  ('function', 'private', '', 'staff_mfa_required()', '2c14dabb979ff239d0c3f0391349c824'),
  ('function', 'private', '', 'staff_mfa_required(p_organization_id uuid)', '8023ed7f14a32040ec5ae92ed8d8041a'),
  ('function', 'private', '', 'stamp_channel_poll_identity()', '3716112c928b3f5c41ff09cb4ab7f1b0'),
  ('function', 'private', '', 'stamp_channel_post_author()', '44a4b5e9f4793cfc4ce34a5ad74345ed'),
  ('function', 'private', '', 'stamp_product_identity()', '9adf2d8de7b7865b50133a42d2f3f171'),
  ('function', 'private', '', 'sync_chapter_task_primary_assignment()', 'aef5568852ce6e32fb72728df8beabcc'),
  ('function', 'private', '', 'sync_member_peer_contact_key()', 'b7a41c3a4ed8b2a83d6c88498e670c9e'),
  ('function', 'private', '', 'touch_member_case_updated_at()', '7a6ca538539b2736c34ff53264aec571'),
  ('function', 'private', '', 'touch_updated_at()', '421610edc57a405507d39fae82d85783'),
  ('function', 'private', '', 'validate_member_focus_timezone()', '116e737e20e1677deb997e92214dc8a2'),
  ('function', 'private', '', 'validate_organization_coalition_decision()', '97b5e5aefcbd832c51942d33a9edcddd'),
  ('function', 'private', '', 'validate_organization_coordination_record_shape()', '85f2bc4937ed8b4516c416169af31041'),
  ('function', 'private', '', 'validate_organization_coordination_resource_permission()', '8b0c00aa8fb66c791ad6a5a05c414a1c'),
  ('function', 'private', '', 'validate_organization_coordination_visibility()', '94332ced9b34c22bb899446bc9590f3e'),
  ('function', 'private', '', 'validate_public_chapter_page_attachment()', '2965ee6519c7e77f8f947e4be6b45e20'),
  ('function', 'public', '', 'casework_scan_retaliation_patterns(p_chapter_id text)', '246fe944b83c6f36fcb62989c661570b'),
  ('function', 'public', '', 'casework_submit_retaliation_report(p_case_id uuid, p_incident_at timestamp with time zone, p_management_person text, p_protected_activity text, p_adverse_action text, p_requested_support text, p_idempotency_key uuid)', 'ccaf434724dbfa915a9350161b906d89'),
  ('function', 'public', '', 'casework_withdraw_retaliation_report(p_report_id uuid, p_reason text)', 'c74ef9b6708cd84592e873072496d7a5'),
  ('function', 'public', '', 'create_member_accommodation_request(p_request_type text, p_description text, p_idempotency_key uuid)', '968c1a9afab32bbf8dd24cb368c14add'),
  ('function', 'public', '', 'member_has_role(p_roles text[])', '2d8f8d36f65c4f7b1c55bd473416a163'),
  ('function', 'public', '', 'staff_can_see_user(p_target uuid, p_role text)', '3b2d156f7a96145af243ef4074a37f5c'),
  ('function', 'public', '', 'transition_member_accommodation_request(p_request_id uuid, p_status text, p_staff_note text, p_idempotency_key uuid)', '0de59c48c0f97736b13da42ff259c594'),
  ('trigger', 'auth', 'identities', 'a00_case_graph_lock', '5a07787ce875ed5b1ae1fb0ccf581c6b'),
  ('trigger', 'auth', 'identities', 'z99_case_graph_keys', 'c403e012166a7674f3587b407e3b9611'),
  ('trigger', 'auth', 'mfa_amr_claims', 'a00_case_graph_lock', 'bf09935e7f7538a07ee04e84dcab9bb0'),
  ('trigger', 'auth', 'mfa_amr_claims', 'z99_case_graph_keys', '1d82056ce4048653e38e0c4d5e36d25d'),
  ('trigger', 'auth', 'mfa_challenges', 'a00_case_graph_lock', 'f8a157d960a470de0e5d2c60af25a96f'),
  ('trigger', 'auth', 'mfa_challenges', 'z99_case_graph_keys', 'cc5f81d8b7cd0b0e4997618fe9024d11'),
  ('trigger', 'auth', 'mfa_factors', 'a00_case_graph_lock', 'e66ba7f2fe973f4a08bd91b13b3487c4'),
  ('trigger', 'auth', 'mfa_factors', 'mfa_factor_verified_notify_insert', 'c965fe2475716c4f11849f09ab98b95f'),
  ('trigger', 'auth', 'mfa_factors', 'mfa_factor_verified_notify_update', '6a868ded18cf809e884b3d9e0f299c18'),
  ('trigger', 'auth', 'mfa_factors', 'z99_case_graph_keys', '65643741adcbeb4a949541557a394e89'),
  ('trigger', 'auth', 'oauth_authorizations', 'a00_case_graph_lock', '0ad2d29c759d84384587c8c09c7bdbc4'),
  ('trigger', 'auth', 'oauth_authorizations', 'z99_case_graph_keys', 'fb48e5769e199b1383d52bd5acc62b3f'),
  ('trigger', 'auth', 'oauth_consents', 'a00_case_graph_lock', 'd1c642628c1bd3fb843f37a86a525511'),
  ('trigger', 'auth', 'oauth_consents', 'z99_case_graph_keys', '13ad1136d04b847f428a4ed6e6941770'),
  ('trigger', 'auth', 'one_time_tokens', 'a00_case_graph_lock', 'a25a6ef2e18ec5aa51d6e6bfdc1237eb'),
  ('trigger', 'auth', 'one_time_tokens', 'z99_case_graph_keys', '13e456a7759a78f1d39f1493221ac052'),
  ('trigger', 'auth', 'refresh_tokens', 'a00_case_graph_lock', '3357d1f0c9a2eb14090ff3511e83a706'),
  ('trigger', 'auth', 'refresh_tokens', 'z99_case_graph_keys', '492168be8fcc0953b0beb740b8c84b62'),
  ('trigger', 'auth', 'sessions', 'a00_case_graph_lock', '48b7a485f262f435cc314703a722d05d'),
  ('trigger', 'auth', 'sessions', 'z99_case_graph_keys', '5347743745cacd169a8d332eadd8839b'),
  ('trigger', 'auth', 'users', 'a00_case_graph_lock', '761ac7ae0ddc167aee2dd5ee5730f060'),
  ('trigger', 'auth', 'users', 'auth_users_capture_account_lifecycle_scope', 'f9a3e72c30f197bfd80946c44d5003b0'),
  ('trigger', 'auth', 'users', 'auth_users_finalize_account_lifecycle_scope', 'f13214f3d650d0a6d528761eb2a52250'),
  ('trigger', 'auth', 'users', 'auth_users_preserve_final_organization_admin', '6f524bb6a239dc29a58a5a09bc6de112'),
  ('trigger', 'auth', 'users', 'on_auth_user_assurance_registry', '325c6a37043eda2a5e552988818a7787'),
  ('trigger', 'auth', 'users', 'on_auth_user_created_member_app', 'fb57d3dff2992ccf0fe156deb01a1c05'),
  ('trigger', 'auth', 'users', 'z99_case_graph_keys', '6d49d93fc5a722787f254083a5aab12c'),
  ('trigger', 'auth', 'webauthn_challenges', 'a00_case_graph_lock', '453ad97ed027dbf058ea31ce1751b559'),
  ('trigger', 'auth', 'webauthn_challenges', 'z99_case_graph_keys', '800b17e9358fc9ba23ab290d87c77152'),
  ('trigger', 'auth', 'webauthn_credentials', 'a00_case_graph_lock', 'e7fb4feea9c686d57fa6b4940a421646'),
  ('trigger', 'auth', 'webauthn_credentials', 'z99_case_graph_keys', '4f57825fe95c32e5aba072ed4aa8d966'),
  ('trigger', 'private', 'account_lifecycle_case_scope', 'a00_case_graph_lock', '6683db8dbe3fe81de8d0ccdccf21d831'),
  ('trigger', 'private', 'account_lifecycle_case_scope', 'z99_case_graph_keys', '11569fb793dbe644f718c9b6d8fe099d'),
  ('trigger', 'private', 'account_lifecycle_history_scope', 'a00_case_graph_lock', '9a0c4a6fb6fb80259d54bc802b0b54bb'),
  ('trigger', 'private', 'account_lifecycle_history_scope', 'z99_case_graph_keys', '48bbb37116f9a8a2aad96ef7fea7ab20'),
  ('trigger', 'private', 'assurance_synthetic_accounts', 'a00_case_graph_lock', 'dbdf87f746f95ae1fe521e7391cd76fe'),
  ('trigger', 'private', 'assurance_synthetic_accounts', 'z99_case_graph_keys', '0f0ceae5f633aa79a2985d68efd9e3d0'),
  ('trigger', 'private', 'attachment_removal_receipts', 'a00_case_graph_lock', '4f9a3baabf281a9d7c39857fcc4ce24f'),
  ('trigger', 'private', 'attachment_removal_receipts', 'z99_case_graph_keys', '626507e09b9e65da44e5867041b06647'),
  ('trigger', 'private', 'calendar_oauth_states', 'a00_case_graph_lock', '1f859aa097e64df958f190ad86c06cfa'),
  ('trigger', 'private', 'calendar_oauth_states', 'z99_case_graph_keys', 'd1c95cbcfae9e9d31ed3ed5518f5017d'),
  ('trigger', 'private', 'chapter_task_number_counters', 'a00_case_graph_lock', 'c259f5be384600ca97dad69e00dd15ef'),
  ('trigger', 'private', 'chapter_task_number_counters', 'z99_case_graph_keys', '77022c0492804249c56faea9135c53fd'),
  ('trigger', 'private', 'constant_contact_oauth_states', 'a00_case_graph_lock', '3375d331117d0d03b219b27d13084651'),
  ('trigger', 'private', 'constant_contact_oauth_states', 'z99_case_graph_keys', 'bd012efe3246f24fefa0132b0d45c695'),
  ('trigger', 'private', 'constant_contact_oauth_tokens', 'a00_case_graph_lock', 'cadfe771d161482fb5f9dade7d114f10'),
  ('trigger', 'private', 'constant_contact_oauth_tokens', 'z99_case_graph_keys', '19a772cb7e016cf29ca6bfa2d38729bc'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'a00_case_graph_lock', '4f3bcf139ad195c9474e0eb7a3b18b68'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_analytics_after_evidence_delete', 'b3e0c87615239abd0c046b3fe1dcd930'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_coordination_after_evidence_delete', 'd667f422b2a398c380a7fa92e46d41bf'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_coordination_after_evidence_insert', 'a2a1dfc3e4d152ebfea0472636e033f5'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_administrative_evidence', '776cf610e7950428e46d7fc6fdff8db4'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_casework_evidence', 'c8d1dfdf0895b5340ef7fd9940edcb27'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_member_support_evidence', '7c49f90578b7d62be8c0e4cda7119183'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_sync_organization_intelligence_evidence', 'a6311c3b4a5e5f350d6240fcc0b0cfb0'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'demo_seed_twilio_operation_history', '5e88372d9dde1f38cb5739299312334c'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'z99_case_graph_keys', '73185dcf69c996cffe548df59370dd7a'),
  ('trigger', 'private', 'demo_seed_installation_bindings', 'demo_seed_binding_ensure_dues_indexes', 'f94ec31e51b22620acdaa7c08129d6bc'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'a00_case_graph_lock', 'd2357f29fbbc07950158ada31515abc0'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_analytics_after_page_evidence_insert', '6c974fbe48507935de5a872d907730d9'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_coordination_page_evidence', '7d34728773d8f379e942ddd7c1b754bd'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_institutional_records_from_evidence', '70dbb70a6826a09bd77ea26cfb1510e5'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_member_operations_from_evidence', 'fb8ca2f0fc28467f41607f436e82e008'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_refresh_administrative_page_evidence', '2a613a5ed1ad88342b3a71e2e58bde4a'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'demo_seed_refresh_voice_page_evidence', '81091487b690d06d3b709e062c8de14d'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'z99_case_graph_keys', '60306f069540ad06f6a59da7ee40ea91'),
  ('trigger', 'private', 'dues_checkout_recovery_audit', 'a00_case_graph_lock', '4a9c836c2a8d5de9e9de3b5475c7fdad'),
  ('trigger', 'private', 'dues_checkout_recovery_audit', 'z99_case_graph_keys', 'b22a3f3af3c9afee47218e39f9476d81'),
  ('trigger', 'private', 'dues_financial_identity_selections', 'a00_case_graph_lock', '8beb080eb5c1000fa1d248c5e22814ae'),
  ('trigger', 'private', 'dues_financial_identity_selections', 'z99_case_graph_keys', '755ad5d34ea7b902c1096ae72a9f8621'),
  ('trigger', 'private', 'dues_sample_seed_ledger', 'a00_case_graph_lock', '8d92db44519a72b5f261b4c95d6c574c'),
  ('trigger', 'private', 'dues_sample_seed_ledger', 'z99_case_graph_keys', '30bc294f99c84783cf6cfb9209226e26'),
  ('trigger', 'private', 'dues_sample_seed_runs', 'a00_case_graph_lock', '2de33062cc476c6c222bc672a9e7f861'),
  ('trigger', 'private', 'dues_sample_seed_runs', 'z99_case_graph_keys', 'e8c8772d5f33220be52cada2633cb4f8'),
  ('trigger', 'private', 'dues_stripe_oauth_states', 'a00_case_graph_lock', '4f1f99f9fce51dfeb4c77a8597090e18'),
  ('trigger', 'private', 'dues_stripe_oauth_states', 'z99_case_graph_keys', '243a42019e58825fb2eff1d39a498bf2'),
  ('trigger', 'private', 'google_drive_oauth_states', 'a00_case_graph_lock', 'b591d8540f232e87a0443e57b3b6c8ec'),
  ('trigger', 'private', 'google_drive_oauth_states', 'z99_case_graph_keys', '7699450cb9bec2c7edf38c90d0540941'),
  ('trigger', 'private', 'member_account_deletions', 'a00_case_graph_lock', 'ef78f566324ebd74a2181046a3fb33d3'),
  ('trigger', 'private', 'member_account_deletions', 'member_account_deletions_preserve_final_organization_admin', 'e267086cf044d6f3a4db598aaf2e6ed1'),
  ('trigger', 'private', 'member_account_deletions', 'z99_case_graph_keys', '35b99178b906fa587ab46ce04352eb59'),
  ('trigger', 'private', 'member_event_checkin_tokens', 'a00_case_graph_lock', 'eb0af0c6dfe301fac6f638246e73b15d'),
  ('trigger', 'private', 'member_event_checkin_tokens', 'z99_case_graph_keys', 'd251c9e62a286880a2d4d1fb213ee396'),
  ('trigger', 'private', 'member_form_signatures', 'a00_case_graph_lock', 'e7a9d91863096e4fc54c78102dd6a0c2'),
  ('trigger', 'private', 'member_form_signatures', 'member_form_signatures_parent_mutable', 'e95757ac164f4cd2d3b62f0b172ad3f8'),
  ('trigger', 'private', 'member_form_signatures', 'z99_case_graph_keys', 'bf2263ec2300ee06f7a65d1c779c6809'),
  ('trigger', 'private', 'member_mfa_recovery_locks', 'a00_case_graph_lock', '2b93b15578f7bf985cb763fec5d1c9a6'),
  ('trigger', 'private', 'member_mfa_recovery_locks', 'z99_case_graph_keys', 'c5f2fd09ba9f227eb64805f070b9e13c'),
  ('trigger', 'private', 'member_mfa_reset_boundaries', 'a00_case_graph_lock', '741351a9a1b088efd8ba5bd9c692d7b9'),
  ('trigger', 'private', 'member_mfa_reset_boundaries', 'z99_case_graph_keys', 'd3c9851e48d38868a8760c192b1e3259'),
  ('trigger', 'private', 'member_native_push_installation_audit', 'a00_case_graph_lock', 'bdd493f7d4ba922d4e8f7443baa13755'),
  ('trigger', 'private', 'member_native_push_installation_audit', 'z99_case_graph_keys', '820a28e0f4638e21f72f67339a82f250'),
  ('trigger', 'private', 'member_native_push_registration_limits', 'a00_case_graph_lock', 'f44f53358e4331514abe1ddc061a22e0'),
  ('trigger', 'private', 'member_native_push_registration_limits', 'z99_case_graph_keys', '6a999cafe7f3891c7f5b31e740be7dbd'),
  ('trigger', 'private', 'member_notification_push_target_receipts', 'a00_case_graph_lock', '70e1097d050fce0cff3607dde9d1bce9'),
  ('trigger', 'private', 'member_notification_push_target_receipts', 'z99_case_graph_keys', 'bda42887403103664d4b5d9a27a23789'),
  ('trigger', 'private', 'member_password_reissues', 'a00_case_graph_lock', '3206d18681123ce52dd357dcf9444f1d'),
  ('trigger', 'private', 'member_password_reissues', 'z99_case_graph_keys', '01835a6521ccdfb61315ee4252d322c3'),
  ('trigger', 'private', 'member_session_closing_barriers', 'a00_case_graph_lock', '45aa96bb02894dc818d44e0abea71e3b'),
  ('trigger', 'private', 'member_session_closing_barriers', 'z99_case_graph_keys', '06631776e31a91354ddc50fb96750da1'),
  ('trigger', 'private', 'member_session_revocations', 'a00_case_graph_lock', 'fddde7e6c11bb59be5199cf3c412ccab'),
  ('trigger', 'private', 'member_session_revocations', 'z99_case_graph_keys', '269a7002666bb980a653aaf35c88b965'),
  ('trigger', 'private', 'member_signin_recoveries', 'a00_case_graph_lock', 'e5c0660cb28f41ca254c91893c8548df'),
  ('trigger', 'private', 'member_signin_recoveries', 'z99_case_graph_keys', '0cadb052ed935b085443c1cfb9e42b51'),
  ('trigger', 'private', 'member_sms_preferences', 'a00_case_graph_lock', '91c6d6825f924cd4d3577247bc69c285'),
  ('trigger', 'private', 'member_sms_preferences', 'z99_case_graph_keys', '773634830d8effadd02ee8bb1cc3ae80'),
  ('trigger', 'private', 'member_stress_chapter_plan', 'a00_case_graph_lock', '8a9d0cb11b20499aa804ad08485d8292'),
  ('trigger', 'private', 'member_stress_chapter_plan', 'z99_case_graph_keys', '07a35c6ab0d638d3dae1309a774d8828'),
  ('trigger', 'private', 'mi1_w2_operation_receipt_rows', 'a00_case_graph_lock', '982ae2108059fd11d902f7fd38288828'),
  ('trigger', 'private', 'mi1_w2_operation_receipt_rows', 'z99_case_graph_keys', '835141a403a9a090f64adb10c0c7ba83'),
  ('trigger', 'private', 'mi1_w2_operation_receipts', 'a00_case_graph_lock', '8c6835bb5571d5dbf8620f6b9beef061'),
  ('trigger', 'private', 'mi1_w2_operation_receipts', 'mi1_w2_operation_receipts_insert', 'ce463bc394167e458733ae49ef574914'),
  ('trigger', 'private', 'organization_analytics_idempotency_receipts', 'a00_case_graph_lock', '3c776184a3b0fa128909595b4bcb3109'),
  ('trigger', 'private', 'organization_analytics_idempotency_receipts', 'z99_case_graph_keys', '4443570d5d8ac723cf6e6db09269fca9'),
  ('trigger', 'private', 'presg_demo_ledger', 'a00_case_graph_lock', '238e78e88fa8ea10c33ec9e5f62d42cb'),
  ('trigger', 'private', 'presg_demo_ledger', 'z99_case_graph_keys', 'dc0d8306e3559b98d7ec5adc38c95d66'),
  ('trigger', 'private', 'presg_demo_runs', 'a00_case_graph_lock', '9280e97ffbeff99b2a188ca0e14166c1'),
  ('trigger', 'private', 'presg_demo_runs', 'dues_sample_remove_presg_subjects', 'cbed189551703758d389f851bf65c579'),
  ('trigger', 'private', 'presg_demo_runs', 'presg_demo_archive_organization_on_remove', 'ecbbb878f5251a570c5049d681009cae'),
  ('trigger', 'private', 'presg_demo_runs', 'z99_case_graph_keys', '1c67a3216d191ace5b97d21a57d4ce9e'),
  ('trigger', 'private', 'private_upload_inspection_attempts', 'a00_case_graph_lock', 'c646062b60987be77b9abe90e93e541d'),
  ('trigger', 'private', 'private_upload_inspection_attempts', 'z99_case_graph_keys', '55c65523092cb4fb23ce216fc7a258c3'),
  ('trigger', 'private', 'private_upload_inspection_limits', 'a00_case_graph_lock', 'dbc0a13fcd352a3a9cae70cd82bf4f54'),
  ('trigger', 'private', 'private_upload_inspection_limits', 'z99_case_graph_keys', '5e49d27545f2cb6665db06c9350a2561'),
  ('trigger', 'private', 'steward_calendar_oauth_tokens', 'a00_case_graph_lock', 'c43a20763614260e194729e6d07ddb7f'),
  ('trigger', 'private', 'steward_calendar_oauth_tokens', 'z99_case_graph_keys', 'febd949b8f404ab5fd071dd95b6e0455'),
  ('trigger', 'private', 'twilio_sms_attempts', 'a00_case_graph_lock', '00eb5786d71320d70f43d5abb546d16c'),
  ('trigger', 'private', 'twilio_sms_attempts', 'z99_case_graph_keys', '16a5bec6130fc129ca5a3fb750bf526e'),
  ('trigger', 'private', 'uniondemo_chapters', 'a00_case_graph_lock', '766109dc1a7c31fe8d3973074843790a'),
  ('trigger', 'private', 'uniondemo_chapters', 'z99_case_graph_keys', '00230b12df0dffc7e19e2cdef0609c76'),
  ('trigger', 'private', 'uniondemo_ledger', 'a00_case_graph_lock', '67dfcdbde60fc5b22fe2ec580f37324e'),
  ('trigger', 'private', 'uniondemo_ledger', 'z99_case_graph_keys', 'be224801a727ee3e1acf5dcb024ca3ea'),
  ('trigger', 'private', 'uniondemo_runs', 'a00_case_graph_lock', 'fa12a5f8c7b0b28cf1cf6fd9e65057b6'),
  ('trigger', 'private', 'uniondemo_runs', 'dues_sample_remove_uniondemo_subjects', 'b5391c987d70f605d1ca1ac5d19b238f'),
  ('trigger', 'private', 'uniondemo_runs', 'uniondemo_archive_organization_on_remove', '65bc8d15b8202a9834fd4a4a8179d2b1'),
  ('trigger', 'private', 'uniondemo_runs', 'z99_case_graph_keys', '1255ffc7b296931bc83f9b8e99fa29fa'),
  ('trigger', 'private', 'workload_reminder_preferences', 'a00_case_graph_lock', 'e646248aef26213889a65f35a27eaca7'),
  ('trigger', 'private', 'workload_reminder_preferences', 'z99_case_graph_keys', '92318af8d016b496c9f8b17d9083767b'),
  ('trigger', 'public', 'case_alert_acknowledgements', 'a00_case_graph_lock', '71ddd46fe9212957db511f529d47c9a0'),
  ('trigger', 'public', 'case_alert_acknowledgements', 'case_alert_acknowledgements_org_key', '4d23e8227bfe9559dd6eba2ebb5b8674'),
  ('trigger', 'public', 'case_alert_acknowledgements', 'z99_case_graph_keys', '22ea170998862e0651dafd66a568877c'),
  ('trigger', 'public', 'case_alerts', 'a00_case_graph_lock', 'ba7ab8fe43cafdac57e9215e858d0427'),
  ('trigger', 'public', 'case_alerts', 'case_alerts_org_key', 'f645a2be39268a34904ec5f3809a9c5f'),
  ('trigger', 'public', 'case_alerts', 'z99_case_graph_keys', '2caae7c99c56e60385a77541c8236d12'),
  ('trigger', 'public', 'case_checklist_progress', 'a00_case_graph_lock', '23d24d75f7e3df1f23e85b3dfbbbab72'),
  ('trigger', 'public', 'case_checklist_progress', 'case_checklist_progress_org_key', '52959beece23b6678b116671b95d651a'),
  ('trigger', 'public', 'case_checklist_progress', 'z99_case_graph_keys', '3b89359979feabea966a59f73656af8d'),
  ('trigger', 'public', 'case_deadline_audit', 'a00_case_graph_lock', 'b4b74f461e4c95eb8173a2485c9a3595'),
  ('trigger', 'public', 'case_deadline_audit', 'case_deadline_audit_append_only', 'd61263d10e8c15c0196bce3e20101b95'),
  ('trigger', 'public', 'case_deadline_audit', 'case_deadline_audit_org_key', 'ffa07cbb92da90c79f201bced7a5c1eb'),
  ('trigger', 'public', 'case_deadline_audit', 'z99_case_graph_keys', '0e82408f5f6aae7d42e1346bebda88cb'),
  ('trigger', 'public', 'case_deadline_changes', 'a00_case_graph_lock', '3c726ac69961183b1e79ce79280597e7'),
  ('trigger', 'public', 'case_deadline_changes', 'case_deadline_changes_org_key', '9c5072608917307ea1feb9a5d82df17d'),
  ('trigger', 'public', 'case_deadline_changes', 'z99_case_graph_keys', '29e81f69571f255db8c99bceb07cf86e'),
  ('trigger', 'public', 'case_generated_work', 'a00_case_graph_lock', '0f4dc2bba6a8fa5059e8ef8484d0de9c'),
  ('trigger', 'public', 'case_generated_work', 'case_generated_work_org_key', '30b8d30b022df681206a5994e6f391f7'),
  ('trigger', 'public', 'case_generated_work', 'z99_case_graph_keys', 'eb5c3a1d4b60a69838d8a09811371b9b'),
  ('trigger', 'public', 'case_reminders', 'a00_case_graph_lock', 'dd722f3ba4856d36a803543532444ba9'),
  ('trigger', 'public', 'case_reminders', 'case_reminders_org_key', 'a4e5481cfb6391bed09e349fcb4854b3'),
  ('trigger', 'public', 'case_reminders', 'z99_case_graph_keys', '084514b79f0b1c4d259f4465d193339e'),
  ('trigger', 'public', 'case_restriction_access', 'a00_case_graph_lock', '563fa81958ff4925be7fcc6971e9671e'),
  ('trigger', 'public', 'case_restriction_access', 'case_restriction_access_org_key', 'fdcf8b9b83f7f905dd068381ece39fcb'),
  ('trigger', 'public', 'case_restriction_access', 'z99_case_graph_keys', 'ee993770af583b998490f4d25673ded3'),
  ('trigger', 'public', 'case_restrictions', 'a00_case_graph_lock', 'c902da0c5ecd6b998af37719d1a64428'),
  ('trigger', 'public', 'case_restrictions', 'case_restrictions_org_key', '603d4a963f20e095e10a023e24da34f4'),
  ('trigger', 'public', 'case_restrictions', 'z99_case_graph_keys', 'eaa420abdfd95019829c43b0ab56fdc4'),
  ('trigger', 'public', 'case_step_transitions', 'a00_case_graph_lock', 'e89ea3243758077d764d9b6db03f7abb'),
  ('trigger', 'public', 'case_step_transitions', 'case_step_transitions_org_key', '4433a95e2213fd609d8a4d54e360fa07'),
  ('trigger', 'public', 'case_step_transitions', 'z99_case_graph_keys', 'cc398d86d7d771ac19e734f291b24cbc'),
  ('trigger', 'public', 'casework_access_grants', 'a00_case_graph_lock', '117d461c753c82b8c99f6a5d35f2dcbd'),
  ('trigger', 'public', 'casework_access_grants', 'casework_access_grants_guard_historical_attribution', '0a3ae082b5315b9187ac80fa7e71c77d'),
  ('trigger', 'public', 'casework_access_grants', 'z99_case_graph_keys', 'f8ecca2a7b5a326959ebf071b8bde00d'),
  ('trigger', 'public', 'casework_alert_acknowledgements', 'a00_case_graph_lock', '34bf5ab30cee4ac7b8321bddc2bba88a'),
  ('trigger', 'public', 'casework_alert_acknowledgements', 'z99_case_graph_keys', '91736f50ec1f0f616c60a3a16750d73f'),
  ('trigger', 'public', 'casework_alerts', 'a00_case_graph_lock', '5b3d6521006608828eb9900855ff5144'),
  ('trigger', 'public', 'casework_alerts', 'z99_case_graph_keys', 'e433ecb6b6388de5b4f3e59c5a190012'),
  ('trigger', 'public', 'casework_audit_events', 'a00_case_graph_lock', 'f43531605f1209e62b187d4d01531692'),
  ('trigger', 'public', 'casework_audit_events', 'z99_case_graph_keys', '7b8b83cb9fecb79e2e604e5ebc4dbdfc'),
  ('trigger', 'public', 'casework_bargaining_events', 'a00_case_graph_lock', '46798fa0b83cce5c42af3dbc16393511'),
  ('trigger', 'public', 'casework_bargaining_events', 'z99_case_graph_keys', '2aeb4257a593651f759f809a16d0175d'),
  ('trigger', 'public', 'casework_bargaining_proposals', 'a00_case_graph_lock', 'f09140a7ad77c3e787d303023eddfaef'),
  ('trigger', 'public', 'casework_bargaining_proposals', 'z99_case_graph_keys', '6e875ca8b7f09bb1762803176df3f289'),
  ('trigger', 'public', 'casework_bargaining_workspaces', 'a00_case_graph_lock', '7d295f575d79969c0b2af954160866e3'),
  ('trigger', 'public', 'casework_bargaining_workspaces', 'z99_case_graph_keys', '6447afaf65d7b5ba3d2998f1f7b0c9ef'),
  ('trigger', 'public', 'casework_checklist_items', 'a00_case_graph_lock', '986b34ac65b38a026af10a3b9adb5a5d'),
  ('trigger', 'public', 'casework_checklist_items', 'casework_checklist_items_guard_historical_attribution', '511cc5b76735ad7b3fb7245436ed46a7'),
  ('trigger', 'public', 'casework_checklist_items', 'z99_case_graph_keys', '0ded0b898232f515d5db11cfa3598ada'),
  ('trigger', 'public', 'casework_checklist_templates', 'a00_case_graph_lock', 'fa3d8e31eb667746c92a7796acb4e857'),
  ('trigger', 'public', 'casework_checklist_templates', 'z99_case_graph_keys', 'e6eb6ec713750b73dbe3ba50a135cfe6'),
  ('trigger', 'public', 'casework_checklists', 'a00_case_graph_lock', '3f1dab7243cef950feaad97fd6f8c098'),
  ('trigger', 'public', 'casework_checklists', 'z99_case_graph_keys', 'a9fc7964d28079a7c13b375688732bbe'),
  ('trigger', 'public', 'casework_deadline_extensions', 'a00_case_graph_lock', 'b4ac5ce32022931a7756e72301ea9a47'),
  ('trigger', 'public', 'casework_deadline_extensions', 'casework_deadline_extensions_guard_historical_attribution', '202d994752bb82d8cd9c825ae758b139'),
  ('trigger', 'public', 'casework_deadline_extensions', 'z99_case_graph_keys', '368dd5c1dd8f980b65425a42b24a0372'),
  ('trigger', 'public', 'casework_deadlines', 'a00_case_graph_lock', 'fd03863e7aa650d18e2c8ae4b17eaf80'),
  ('trigger', 'public', 'casework_deadlines', 'z99_case_graph_keys', 'd36b05a61d17ad7e036c7f98756b0731'),
  ('trigger', 'public', 'casework_entity_links', 'a00_case_graph_lock', 'a46a9b4af756738ebe031f0f31383566'),
  ('trigger', 'public', 'casework_entity_links', 'z99_case_graph_keys', 'c431541d646c32ef86208504cdb12fdb'),
  ('trigger', 'public', 'casework_intake_drafts', 'a00_case_graph_lock', '0555d2279ababcf714ca207ee83c213c'),
  ('trigger', 'public', 'casework_intake_drafts', 'z99_case_graph_keys', '602ea989282685d379defe9d87c97d4b'),
  ('trigger', 'public', 'casework_management_addenda', 'a00_case_graph_lock', '88aee5aecd0ba32bc279b8689b7c2c13'),
  ('trigger', 'public', 'casework_management_addenda', 'z99_case_graph_keys', '5bee5d47d47ecc137829969976581e34'),
  ('trigger', 'public', 'casework_management_entries', 'a00_case_graph_lock', '6c8ecce5ea6e77864ef260686dc9c2e4'),
  ('trigger', 'public', 'casework_management_entries', 'z99_case_graph_keys', '9234d97c8068aa2cee7ac2632fcc99ce'),
  ('trigger', 'public', 'casework_management_people', 'a00_case_graph_lock', '9fa783baeb24bc21f1d262806996eef6'),
  ('trigger', 'public', 'casework_management_people', 'z99_case_graph_keys', '5ac296d4a377667303a7e713d16c0304'),
  ('trigger', 'public', 'casework_reminders', 'a00_case_graph_lock', 'ad90547bef3a122276e4c1592342ee79'),
  ('trigger', 'public', 'casework_reminders', 'z99_case_graph_keys', '9d2909dba0268efbb9077481c7d2c8d7'),
  ('trigger', 'public', 'casework_retaliation_pattern_notes', 'a00_case_graph_lock', '9eddc7b362afc3228c042f812ac41b51'),
  ('trigger', 'public', 'casework_retaliation_pattern_notes', 'z99_case_graph_keys', 'd91836049afbf298aa41b67bb20fe72a'),
  ('trigger', 'public', 'casework_retaliation_pattern_reports', 'a00_case_graph_lock', 'eb89f15c8abbd3e9f9dd03fb3c770ada'),
  ('trigger', 'public', 'casework_retaliation_pattern_reports', 'z99_case_graph_keys', 'dc2ec1bf3e4b5cf174fb1a0e8631ce0c'),
  ('trigger', 'public', 'casework_retaliation_patterns', 'a00_case_graph_lock', '7b5067efd4287ee6992335e5eed2e583'),
  ('trigger', 'public', 'casework_retaliation_patterns', 'sensitive_envelopes', '75b25263ddf18ac2a2c16075a11036d2'),
  ('trigger', 'public', 'casework_retaliation_patterns', 'z99_case_graph_keys', 'cadf336017ea25c21a75bedc1ac4eb86'),
  ('trigger', 'public', 'casework_retaliation_reports', 'a00_case_graph_lock', 'e3961b75cfb291b2ad956a8b559a39c5'),
  ('trigger', 'public', 'casework_retaliation_reports', 'sensitive_envelopes', '20b4ae65fbbf26d121a050882468df91'),
  ('trigger', 'public', 'casework_retaliation_reports', 'z99_case_graph_keys', 'cf09d612a3824fd6adff19e495319bd4'),
  ('trigger', 'public', 'casework_step_transitions', 'a00_case_graph_lock', '8d9205c8112094a99bbfeddf6d3afef3'),
  ('trigger', 'public', 'casework_step_transitions', 'z99_case_graph_keys', '2aa6e9acb83eb016e1b4a0f92d8e6eb8'),
  ('trigger', 'public', 'casework_strength_analyses', 'a00_case_graph_lock', '66ca71b30d87b0ec172a19c03d99c505'),
  ('trigger', 'public', 'casework_strength_analyses', 'z99_case_graph_keys', '397e054954fc64b7faf2617a28b652b4'),
  ('trigger', 'public', 'chapter_channel_poll_options', 'a00_case_graph_lock', '520e86ffeddcdc01705961f92abc6573'),
  ('trigger', 'public', 'chapter_channel_poll_options', 'z99_case_graph_keys', '4156d6c06e2fecd78f41ee85b9587c20'),
  ('trigger', 'public', 'chapter_channel_poll_votes', 'a00_case_graph_lock', 'f706f96aace41f4761312942fbd8b9d8'),
  ('trigger', 'public', 'chapter_channel_poll_votes', 'z99_case_graph_keys', 'b652d9c184740ec1db33bc0b7b617b33'),
  ('trigger', 'public', 'chapter_channel_polls', 'a00_case_graph_lock', '70b30c25d0b771837c3c07e40688cec8'),
  ('trigger', 'public', 'chapter_channel_polls', 'chapter_channel_polls_stamp_identity', 'b7bf16c5e2987d257b5fdb0c13a60952'),
  ('trigger', 'public', 'chapter_channel_polls', 'z99_case_graph_keys', 'bf2abe6ae689038f7b7c5451174a321c'),
  ('trigger', 'public', 'chapter_connection_readiness', 'a00_case_graph_lock', '23ee57d4f0ea636c50102d709696e539'),
  ('trigger', 'public', 'chapter_connection_readiness', 'z99_case_graph_keys', 'fd3ba85c87b9c2ef80076e0fa660e4f6'),
  ('trigger', 'public', 'chapter_contact_log', 'a00_case_graph_lock', 'ba3749ad5c72ff54edc30b8818465fba'),
  ('trigger', 'public', 'chapter_contact_log', 'z99_case_graph_keys', 'c1b13f50b8f99dcc56ff483035f9e8f5'),
  ('trigger', 'public', 'chapter_documents', 'a00_case_graph_lock', 'c0513e4bd11e07735f42696a8c2ff504'),
  ('trigger', 'public', 'chapter_documents', 'chapter_documents_touch_updated_at', 'c56f61d95cb53f7b80287a0e309d1c8f'),
  ('trigger', 'public', 'chapter_documents', 'stamp_product_identity', '9195f8b037aa0cb693d00e5b190353e5'),
  ('trigger', 'public', 'chapter_documents', 'z99_case_graph_keys', 'b7e349f4855aa58a15cb55c08ff64a77'),
  ('trigger', 'public', 'chapter_governance_requests', 'a00_case_graph_lock', '9eea0c3efa79388f5031664f76fc6241'),
  ('trigger', 'public', 'chapter_governance_requests', 'chapter_governance_requests_touch_updated_at', '739444f85ce331818f84e65758029c13'),
  ('trigger', 'public', 'chapter_governance_requests', 'stamp_product_identity', '5f5fa2b3a151d79171425e888280ac3e'),
  ('trigger', 'public', 'chapter_governance_requests', 'z99_case_graph_keys', '50b5235221df4ac128c60f322f109740'),
  ('trigger', 'public', 'chapter_handshake_documents', 'a00_case_graph_lock', 'dee2258c1a48108e4206e910f65bf698'),
  ('trigger', 'public', 'chapter_handshake_documents', 'z99_case_graph_keys', 'd273b5ccf99016994d1934743dad08e7'),
  ('trigger', 'public', 'chapter_handshake_events', 'a00_case_graph_lock', 'ca7803cad2dcbcdcf4cff5b55efcc9ad'),
  ('trigger', 'public', 'chapter_handshake_events', 'z99_case_graph_keys', 'd7f1f53a2322dd35ced899124bc8c7fe'),
  ('trigger', 'public', 'chapter_handshakes', 'a00_case_graph_lock', 'f05ed15f43d64644fbb110eb87eb927e'),
  ('trigger', 'public', 'chapter_handshakes', 'chapter_handshakes_touch_updated_at', 'ac4227b099a47492587332be10b96098'),
  ('trigger', 'public', 'chapter_handshakes', 'stamp_product_identity', '5f1a07eb494dd6657361fb83d058d276'),
  ('trigger', 'public', 'chapter_handshakes', 'z99_case_graph_keys', '605199e7bb74e84de943265a0f69f34c'),
  ('trigger', 'public', 'chapter_health_coaching', 'a00_case_graph_lock', '2199f8ef6e2ed24d79274e216c960a1b'),
  ('trigger', 'public', 'chapter_health_coaching', 'z99_case_graph_keys', 'af747e2e941b05bd48bc93b5e2dc7cb9'),
  ('trigger', 'public', 'chapter_health_snapshots', 'a00_case_graph_lock', 'aae87ec9a6f71f2ada0ea7e97d949f7a'),
  ('trigger', 'public', 'chapter_health_snapshots', 'z99_case_graph_keys', '7de35347211aae05cdebe289ae667401'),
  ('trigger', 'public', 'chapter_integration_overrides', 'a00_case_graph_lock', '6bb94ff0e396eb616ff3cafd99addb91'),
  ('trigger', 'public', 'chapter_integration_overrides', 'z99_case_graph_keys', 'e436a94571f9619086a09ebfe1044ccc'),
  ('trigger', 'public', 'chapter_record_versions', 'a00_case_graph_lock', 'dfa67f42a103f8cde9206b01f67b8a75'),
  ('trigger', 'public', 'chapter_record_versions', 'z99_case_graph_keys', 'b0f44409d8985a3f807bcfc0bf131b7d'),
  ('trigger', 'public', 'chapter_records', 'a00_case_graph_lock', 'de24441eabc758821d841508336ba274'),
  ('trigger', 'public', 'chapter_records', 'stamp_product_identity', '9c4b603bc109fb466685391c8b523d7e'),
  ('trigger', 'public', 'chapter_records', 'z99_case_graph_keys', '623b67d8a6e189f531f3daf8fefbd3b8'),
  ('trigger', 'public', 'chapter_space_controls', 'a00_case_graph_lock', '32ba0e3db917f64cd3581e1a271cd4eb'),
  ('trigger', 'public', 'chapter_space_controls', 'z99_case_graph_keys', '2b70afb1d61e7deafba0e770eac3f6fa'),
  ('trigger', 'public', 'chapter_space_members', 'a00_case_graph_lock', '644a6e1d9a3b3e10cc4e38b6190ca4df'),
  ('trigger', 'public', 'chapter_space_members', 'z99_case_graph_keys', '5dc19ffd05d5de30bea83ba92ec7169a'),
  ('trigger', 'public', 'chapter_space_reads', 'a00_case_graph_lock', '4f2d04623ca5937502dec886c8ec944f'),
  ('trigger', 'public', 'chapter_space_reads', 'z99_case_graph_keys', 'b88aa866d9e9ee0e0f7016de9b4b2308'),
  ('trigger', 'public', 'chapter_spaces', 'a00_case_graph_lock', 'b2b6f396979c853845722058420f1f9a'),
  ('trigger', 'public', 'chapter_spaces', 'chapter_spaces_touch_updated_at', 'd212fcfdc65a69771c8f6b2a8cc0ad0c'),
  ('trigger', 'public', 'chapter_spaces', 'stamp_product_identity', '7c7bf91f24e881f9affa281e85cd94ca'),
  ('trigger', 'public', 'chapter_spaces', 'z99_case_graph_keys', '8280cca9e45dbe347685267158519643'),
  ('trigger', 'public', 'chapter_task_activity', 'a00_case_graph_lock', 'ff3ea8417e7d6dd28328222719fc02f7'),
  ('trigger', 'public', 'chapter_task_activity', 'chapter_task_activity_notify_watchers', '95c5ff3a8810c72ccd7c789b203f588d'),
  ('trigger', 'public', 'chapter_task_activity', 'z99_case_graph_keys', 'a2f66fbee77058165f0b96ee6bc52320'),
  ('trigger', 'public', 'chapter_task_assignments', 'a00_case_graph_lock', 'edba03eb65b1da1d526b80f952a36fb4'),
  ('trigger', 'public', 'chapter_task_assignments', 'chapter_task_assignments_broadcast', '6ec38f5bbfc3a2273911fd8176d5426a'),
  ('trigger', 'public', 'chapter_task_assignments', 'z99_case_graph_keys', '6067988b60fdf2d8e71e8520fd025e1c'),
  ('trigger', 'public', 'chapter_task_attachments', 'a00_case_graph_lock', 'd064def728eb139c1230f550e9f20761'),
  ('trigger', 'public', 'chapter_task_attachments', 'z99_case_graph_keys', '69219a2565a72ff6206759045e8bc2cc'),
  ('trigger', 'public', 'chapter_task_comments', 'a00_case_graph_lock', '2d014e9eeddde46a545ad0e73e76263f'),
  ('trigger', 'public', 'chapter_task_comments', 'z99_case_graph_keys', 'e908e45f32116543c48419348312b385'),
  ('trigger', 'public', 'chapter_task_dependencies', 'a00_case_graph_lock', '29ab33ae35850a259f4908d75f39749f'),
  ('trigger', 'public', 'chapter_task_dependencies', 'chapter_task_dependencies_broadcast', '587d3136c1992da841ee54bb56ee7bc3'),
  ('trigger', 'public', 'chapter_task_dependencies', 'chapter_task_dependencies_prepare', 'fcb29fc87ffcafe802e47dd08032c167'),
  ('trigger', 'public', 'chapter_task_dependencies', 'z99_case_graph_keys', '7a1662f6cf65ba6383642242d70ff7ed'),
  ('trigger', 'public', 'chapter_task_files', 'a00_case_graph_lock', 'c1bbbce9331c372ca85f04056b1d965e'),
  ('trigger', 'public', 'chapter_task_files', 'z99_case_graph_keys', '698284bb2904f3ab47dd206c6879a2b5'),
  ('trigger', 'public', 'chapter_task_messages', 'a00_case_graph_lock', 'abf0cd95945afa7e01591835249d5c37'),
  ('trigger', 'public', 'chapter_task_messages', 'z99_case_graph_keys', '86b0f9b47405bf220b099bef5670f77a'),
  ('trigger', 'public', 'chapter_task_subtasks', 'a00_case_graph_lock', '57710de7b6d1215f7d9c7dd66c3c2bb7'),
  ('trigger', 'public', 'chapter_task_subtasks', 'chapter_task_subtasks_broadcast', 'e55dd1c2fa054a34ab40dc813568ddc2'),
  ('trigger', 'public', 'chapter_task_subtasks', 'chapter_task_subtasks_prepare', '482b7480d80cd97f396e9afc6abbf033'),
  ('trigger', 'public', 'chapter_task_subtasks', 'z99_case_graph_keys', '4329f02853cafd4ef03dc1eab32444dd'),
  ('trigger', 'public', 'chapter_task_template_details', 'a00_case_graph_lock', '0c7239fb663d5a8a713309892c98f131'),
  ('trigger', 'public', 'chapter_task_template_details', 'z99_case_graph_keys', '10d59c45c5cd9b536e538d291a270278'),
  ('trigger', 'public', 'chapter_task_watchers', 'a00_case_graph_lock', 'd6262d5d7a7f0842ca96cddfee60c86a'),
  ('trigger', 'public', 'chapter_task_watchers', 'chapter_task_watchers_prepare', '4d65c6bed57b489d0b6616e8a42d3883'),
  ('trigger', 'public', 'chapter_task_watchers', 'z99_case_graph_keys', '7abe60d399e251b2b6ddf52082ece9cf'),
  ('trigger', 'public', 'chapter_tasks', 'a00_case_graph_lock', '3af847dbabdddae27dac5884b891dd9f'),
  ('trigger', 'public', 'chapter_tasks', 'chapter_tasks_audit', 'a8194ea4be087e93b6a8f456ee8b2415'),
  ('trigger', 'public', 'chapter_tasks', 'chapter_tasks_broadcast', '982fc8cfed8b3712307bbf968231cf9a'),
  ('trigger', 'public', 'chapter_tasks', 'chapter_tasks_guard_template_type', 'a71407e8a3ffc4bb3b421b220847909c'),
  ('trigger', 'public', 'chapter_tasks', 'chapter_tasks_prepare', 'd81ce319e564eb922df7e4e8b1e0415d'),
  ('trigger', 'public', 'chapter_tasks', 'chapter_tasks_sync_primary_assignment', 'a54ce62674e9612a5c251ace606bac22'),
  ('trigger', 'public', 'chapter_tasks', 'chapter_tasks_workstream', 'a487af051ed0574fd4f6890ba9ac32b8'),
  ('trigger', 'public', 'chapter_tasks', 'chapter_tasks_zz_ceiling', 'e60d533a9d27cba2bd17f6c268b4b944'),
  ('trigger', 'public', 'chapter_tasks', 'z99_case_graph_keys', '267b229b737dbd38c4a2ad7d579b2727'),
  ('trigger', 'public', 'chapter_thread_posts', 'a00_case_graph_lock', '5310b30cf18ecb26b47513b59e8126fb'),
  ('trigger', 'public', 'chapter_thread_posts', 'chapter_thread_posts_bump_thread', '532a338608ea1bd65b249276ebe640e4'),
  ('trigger', 'public', 'chapter_thread_posts', 'chapter_thread_posts_stamp_author', '8afe2303fd2cd6f851b39e93b3ddeb4f'),
  ('trigger', 'public', 'chapter_thread_posts', 'stamp_product_identity', '455df9746d489f8402734aaed9f7e421'),
  ('trigger', 'public', 'chapter_thread_posts', 'z99_case_graph_keys', 'b4b06e71c93321e55ce8bbef10847789'),
  ('trigger', 'public', 'chapter_threads', 'a00_case_graph_lock', '47a4e7df64bbcb6889f3dc4f6a2fba50'),
  ('trigger', 'public', 'chapter_threads', 'chapter_threads_touch_updated_at', '385f6cab51a8bdc5c1e9ccd3160a0b16'),
  ('trigger', 'public', 'chapter_threads', 'stamp_product_identity', '7a0091b27799d3e3e2937bc20cc39e17'),
  ('trigger', 'public', 'chapter_threads', 'z99_case_graph_keys', 'cac4d35864f5e8a1ef1135a7150a7f02'),
  ('trigger', 'public', 'chapter_union_org_bindings', 'a00_case_graph_lock', 'c6afeb69b0f4a3f2fb4030da438fbc12'),
  ('trigger', 'public', 'chapter_union_org_bindings', 'z99_case_graph_keys', 'a4ba367c7b1292d0768889db2c06d08e'),
  ('trigger', 'public', 'chapter_workstreams', 'a00_case_graph_lock', '552e6b0c9b64950d9ea7c657427d0fa4'),
  ('trigger', 'public', 'chapter_workstreams', 'chapter_workstreams_broadcast', '4039a9541df7acb339d1fdd688e77bfe'),
  ('trigger', 'public', 'chapter_workstreams', 'z99_case_graph_keys', '0fb965ca78760d6c23b3759d199d3806'),
  ('trigger', 'public', 'chapters', 'a00_case_graph_lock', '414242aab880a0987ddd4a63d8064fe0'),
  ('trigger', 'public', 'chapters', 'chapters_forbid_ownerless_write', 'bef6f05f4ee88ef4066a9b83780b9cb4'),
  ('trigger', 'public', 'chapters', 'z99_case_graph_keys', '53e724b3fde9d30449539d9b2c5dbf0a'),
  ('trigger', 'public', 'compass_ai_policy', 'a00_case_graph_lock', 'f5be1eb36fe04db7590cf4398f7f5ba0'),
  ('trigger', 'public', 'compass_ai_policy', 'z99_case_graph_keys', 'cc577af70e86e26934dbee7972f268ca'),
  ('trigger', 'public', 'compass_ai_role_limits', 'a00_case_graph_lock', '74a5d46d1ea48a49b0d2b5369278d636'),
  ('trigger', 'public', 'compass_ai_role_limits', 'z99_case_graph_keys', '172ee9de5f3568803251f0a4342b0dab'),
  ('trigger', 'public', 'compass_message_briefings', 'a00_case_graph_lock', 'bc10b751e29a2a16b02e89efdac5d324'),
  ('trigger', 'public', 'compass_message_briefings', 'z99_case_graph_keys', '41b35a231f801a063dcbdf685ae867e3'),
  ('trigger', 'public', 'compass_workspace_actions', 'a00_case_graph_lock', '841eedd127c526f523048ce78e829448'),
  ('trigger', 'public', 'compass_workspace_actions', 'z99_case_graph_keys', '6ac63a8c09caa6a9878b032c5ca23d72'),
  ('trigger', 'public', 'compass_workspace_preferences', 'a00_case_graph_lock', 'b42b7a18ad2ad5285bc615346b01bbe9'),
  ('trigger', 'public', 'compass_workspace_preferences', 'z99_case_graph_keys', 'bfe800fa464c3ae335b35c6f1195bf04'),
  ('trigger', 'public', 'constant_contact_member_analytics', 'a00_case_graph_lock', 'df4e5044309f6865b6bab5f0f5d24c2a'),
  ('trigger', 'public', 'constant_contact_member_analytics', 'z99_case_graph_keys', '1b4ff24607a0cae21e4e36324fd1a1dc'),
  ('trigger', 'public', 'constant_contact_sync_requests', 'a00_case_graph_lock', '0b2a044d5767a704bee89e809c4a0f75'),
  ('trigger', 'public', 'constant_contact_sync_requests', 'z99_case_graph_keys', '73bdbf5a68e7611cc30aea4a6674bad7'),
  ('trigger', 'public', 'constant_contact_sync_runs', 'a00_case_graph_lock', '3184d84e3dd9bc6eed4e58278371cff2'),
  ('trigger', 'public', 'constant_contact_sync_runs', 'z99_case_graph_keys', '9aa59e19921336e98ae971f16c27fd8a'),
  ('trigger', 'public', 'contract_clauses', 'a00_case_graph_lock', 'b439ba1a0f1f3b08b3aea72ab9082460'),
  ('trigger', 'public', 'contract_clauses', 'z99_case_graph_keys', '68a508d32b32cf5718d4f7c3e0dac027'),
  ('trigger', 'public', 'coordinator_case_audit', 'a00_case_graph_lock', 'c9ceb1281743207b3b6c87810a84f64b'),
  ('trigger', 'public', 'coordinator_case_audit', 'z99_case_graph_keys', '13fe7db44e325d46aaf52578b3dc8089'),
  ('trigger', 'public', 'digital_action_exports', 'a00_case_graph_lock', '22a33e7cc776b9709b22b80b2ab16a91'),
  ('trigger', 'public', 'digital_action_exports', 'z99_case_graph_keys', '6342f69cb3eba4320a3fc07863b91678'),
  ('trigger', 'public', 'digital_action_participants', 'a00_case_graph_lock', '41d71729f86812484c5878b044a43bf1'),
  ('trigger', 'public', 'digital_action_participants', 'z99_case_graph_keys', '2957764b441ef5eb187e0c46aff93e49'),
  ('trigger', 'public', 'digital_actions', 'a00_case_graph_lock', '2a456c67517ea7c769b47e34bbffb7fb'),
  ('trigger', 'public', 'digital_actions', 'z99_case_graph_keys', 'a8702fb43c23a456eb053d5bc83c93c0'),
  ('trigger', 'public', 'dues_assessment_batches', 'a00_case_graph_lock', '4fecfbfb6e8a7a27647f75f3b8b69b14'),
  ('trigger', 'public', 'dues_assessment_batches', 'z99_case_graph_keys', '8fb83990bf9d063b18750649eebd7f54'),
  ('trigger', 'public', 'dues_checkout_reservations', 'a00_case_graph_lock', 'ffa111ecf5f99bd51ddd600b588ef72e'),
  ('trigger', 'public', 'dues_checkout_reservations', 'z99_case_graph_keys', '9ce2cba838562730b510ac85066d1ffe'),
  ('trigger', 'public', 'dues_ledger_events', 'a00_case_graph_lock', 'cba6010a047f39cea383db23224666d4'),
  ('trigger', 'public', 'dues_ledger_events', 'dues_reject_competing_checkout_mutation', '214738390266ffc88d93afbaacda2271'),
  ('trigger', 'public', 'dues_ledger_events', 'z99_case_graph_keys', 'd32b16e71b4125a3f82ee12d66d2aa46'),
  ('trigger', 'public', 'dues_member_subjects', 'a00_case_graph_lock', '32c00b2e8a64237ef8d5c354c2a64d21'),
  ('trigger', 'public', 'dues_member_subjects', 'z99_case_graph_keys', '2b4dd1106ed88c8b0a9d896949a932b8'),
  ('trigger', 'public', 'dues_notification_deliveries', 'a00_case_graph_lock', '79d8196f16be5c9017b0971af5b9ffd5'),
  ('trigger', 'public', 'dues_notification_deliveries', 'z99_case_graph_keys', '287ef6dba9936fe11cfe2f260ec7cbb1'),
  ('trigger', 'public', 'dues_obligations', 'a00_case_graph_lock', '3225f123dedf55b5e95d04c26846a6fe'),
  ('trigger', 'public', 'dues_obligations', 'z99_case_graph_keys', '49e2e0a028f37f3e7841f7f52bef03d2'),
  ('trigger', 'public', 'dues_provider_connections', 'a00_case_graph_lock', '906b591003f011c2bc0a4c410feb0672'),
  ('trigger', 'public', 'dues_provider_connections', 'z99_case_graph_keys', '6f5614422303d555be202041969a4ad6'),
  ('trigger', 'public', 'dues_receipt_counters', 'a00_case_graph_lock', '47698e06bbe5a42fce061e16f6feabb1'),
  ('trigger', 'public', 'dues_receipt_counters', 'z99_case_graph_keys', '99d64b34118e309e9b6224d4a8b3a38c'),
  ('trigger', 'public', 'dues_reminder_attempts', 'a00_case_graph_lock', '7d7dd4f50782e35445a9583ebeaf8bd2'),
  ('trigger', 'public', 'dues_reminder_attempts', 'z99_case_graph_keys', '28a694208f03ab7884ba0123742eaa3f'),
  ('trigger', 'public', 'dues_stripe_events', 'a00_case_graph_lock', 'bb2c828f308390ce9f3c4e4e94eb76c9'),
  ('trigger', 'public', 'dues_stripe_events', 'z99_case_graph_keys', '3b235ca1707404bc92ceeed6bc755048'),
  ('trigger', 'public', 'engagement_delivery_outbox', 'a00_case_graph_lock', '9201236d9c6b37c80f1ff9bc02027bd9'),
  ('trigger', 'public', 'engagement_delivery_outbox', 'z99_case_graph_keys', 'e065ae41f9598d549bc6898902f0e925'),
  ('trigger', 'public', 'form_templates', 'a00_case_graph_lock', '61839958ba4213e5d22031197a622ed1'),
  ('trigger', 'public', 'form_templates', 'z99_case_graph_keys', '6c49a48a33b4c1e898c0b9d577379e60'),
  ('trigger', 'public', 'integration_api_keys', 'a00_case_graph_lock', 'f72a86e29d2fa05ec681fa984d526425'),
  ('trigger', 'public', 'integration_api_keys', 'z99_case_graph_keys', '6da39eaf6e67185d7f3187134fa79032'),
  ('trigger', 'public', 'integration_jobs', 'a00_case_graph_lock', '1da565f80186b2c272920366003db3b3'),
  ('trigger', 'public', 'integration_jobs', 'z99_case_graph_keys', 'c46f8e59bc3025ba16222b38794a4ac2'),
  ('trigger', 'public', 'integration_webhook_deliveries', 'a00_case_graph_lock', '89a0db5342f6c4944c691b7200f8d2e3'),
  ('trigger', 'public', 'integration_webhook_deliveries', 'z99_case_graph_keys', '8be6ef1b1b1148436e7963084c8e3af9'),
  ('trigger', 'public', 'integration_webhooks', 'a00_case_graph_lock', '407df765ca4bcc365cf04c023bcaa9a9'),
  ('trigger', 'public', 'integration_webhooks', 'z99_case_graph_keys', 'ad6e2a88d12aa451229133b304f3d049'),
  ('trigger', 'public', 'knowledge_collection_items', 'a00_case_graph_lock', '6ed1255fc6ce628a0f0672cae4dd8817'),
  ('trigger', 'public', 'knowledge_collection_items', 'z99_case_graph_keys', '5fd9973906dc0d432c8992f7026865f8'),
  ('trigger', 'public', 'knowledge_collections', 'a00_case_graph_lock', '63499fe87377794e7abe5a10916ee7fd'),
  ('trigger', 'public', 'knowledge_collections', 'z99_case_graph_keys', '9108dc97db1840f07a00a992fa7d9542'),
  ('trigger', 'public', 'meeting_attendance', 'a00_case_graph_lock', '9efb76d600d5ab43e85e7e5e0891af3f'),
  ('trigger', 'public', 'meeting_attendance', 'z99_case_graph_keys', '66092057b63c683b7278494a329cead9'),
  ('trigger', 'public', 'meeting_minutes_dispatches', 'a00_case_graph_lock', 'ceb8f4046a35deecd4af9b27899a1678'),
  ('trigger', 'public', 'meeting_minutes_dispatches', 'z99_case_graph_keys', 'cf275310b939bd9fb48f950844fd88f9'),
  ('trigger', 'public', 'member_access_events', 'a00_case_graph_lock', '49e0ec462dda38c0193f1cde4b95c5b4'),
  ('trigger', 'public', 'member_access_events', 'z99_case_graph_keys', '73c1bdafd9ef00944133d64b0cd88009'),
  ('trigger', 'public', 'member_accommodation_requests', 'a00_case_graph_lock', '3f801b2eaf9695cc5ddd8129a9d96293'),
  ('trigger', 'public', 'member_accommodation_requests', 'sensitive_envelopes', '6a4f6d53bb4c0ae94ff8dff1b00a93d1'),
  ('trigger', 'public', 'member_accommodation_requests', 'z99_case_graph_keys', '9b7116495f8bd1ef84564b701821c255'),
  ('trigger', 'public', 'member_action_log', 'a00_case_graph_lock', '9983984722f6ef0e2bbd976146cea622'),
  ('trigger', 'public', 'member_action_log', 'member_action_log_award_points', 'aaf5aeba156553aee3ca20675c256876'),
  ('trigger', 'public', 'member_action_log', 'z99_case_graph_keys', '176e01457c36660919c68b6d21489c64'),
  ('trigger', 'public', 'member_admin_audit', 'a00_case_graph_lock', 'a7d9b7b64938ee55801dcd9462cf313f'),
  ('trigger', 'public', 'member_admin_audit', 'member_admin_audit_assign_organization', 'd2e7535037c627d2bdf004aba5ed3788'),
  ('trigger', 'public', 'member_admin_audit', 'z99_case_graph_keys', '222dbc9500f7e0c24641b02df495e55a'),
  ('trigger', 'public', 'member_ai_requests', 'a00_case_graph_lock', '6ac09b400bccd7f9e212c321ae8869d2'),
  ('trigger', 'public', 'member_ai_requests', 'z99_case_graph_keys', '76e0a68f9c9cee98eaf7c756a413e473'),
  ('trigger', 'public', 'member_appointment_blackouts', 'a00_case_graph_lock', '43e4ed2ac21937e3aa6aafbbed11e952'),
  ('trigger', 'public', 'member_appointment_blackouts', 'z99_case_graph_keys', '059e3c7f65ad10ebab9d3ab7bacda158'),
  ('trigger', 'public', 'member_appointment_events', 'a00_case_graph_lock', 'c8fd95b765daf8a742f1f7fafe1c3369'),
  ('trigger', 'public', 'member_appointment_events', 'z99_case_graph_keys', '3b966043679c0051d0a36b52bb0b9c54'),
  ('trigger', 'public', 'member_appointment_schedules', 'a00_case_graph_lock', '0239bd3efd7cdc4c59a28f029e6800c8'),
  ('trigger', 'public', 'member_appointment_schedules', 'member_appointment_schedules_touch', '10e0b1e026a004ac4e9cba3dfdd04148'),
  ('trigger', 'public', 'member_appointment_schedules', 'z99_case_graph_keys', 'f954fda1bad6b529acef0dd7fcbb23c5'),
  ('trigger', 'public', 'member_appointment_windows', 'a00_case_graph_lock', '719376f9fdedb5cbccf914b692d9918d'),
  ('trigger', 'public', 'member_appointment_windows', 'z99_case_graph_keys', '87b89f6b603d3653a164fa41aa56091e'),
  ('trigger', 'public', 'member_appointments', 'a00_case_graph_lock', 'e68818c1c0dd2e0a0999d53893acd817'),
  ('trigger', 'public', 'member_appointments', 'member_appointments_carry_rescheduled_place', '230fc509cae0a94d03f9f1bd483a92e4'),
  ('trigger', 'public', 'member_appointments', 'member_appointments_touch', '543dc01455511f0d9f914022cbe488cf'),
  ('trigger', 'public', 'member_appointments', 'z99_case_graph_keys', '2403e980d5f4d006f1b0ab37b6430c96'),
  ('trigger', 'public', 'member_ballot_choices', 'a00_case_graph_lock', '0e042c916f2f043fe0a4c480f002bbf2'),
  ('trigger', 'public', 'member_ballot_choices', 'z99_case_graph_keys', '509894e56979a3ad9c6c389205c19849'),
  ('trigger', 'public', 'member_ballot_options', 'a00_case_graph_lock', '10a37348c511013dd100a2a062e32c6b'),
  ('trigger', 'public', 'member_ballot_options', 'z99_case_graph_keys', 'a6dff0ff17853da90290eac3686dbb61'),
  ('trigger', 'public', 'member_ballot_receipts', 'a00_case_graph_lock', 'c4d57982845b4cec765a398700d5d479'),
  ('trigger', 'public', 'member_ballot_receipts', 'z99_case_graph_keys', 'a4bb2966b3ac691aef6c75d0e228b6e2'),
  ('trigger', 'public', 'member_ballot_votes', 'a00_case_graph_lock', '1ad9d4f5503a9107f1a60234f3587e37'),
  ('trigger', 'public', 'member_ballot_votes', 'z99_case_graph_keys', '05fc5db325c2a58d8e4b0db6176bf076'),
  ('trigger', 'public', 'member_ballots', 'a00_case_graph_lock', '9219ddc643174816dbb3f62c32e29881'),
  ('trigger', 'public', 'member_ballots', 'z99_case_graph_keys', '9e9b8ae929fc7ee24a1e43ae54083d15'),
  ('trigger', 'public', 'member_broadcast_receipts', 'a00_case_graph_lock', 'b6e67c53c2039cf387e1eb9a114ae72e'),
  ('trigger', 'public', 'member_broadcast_receipts', 'z99_case_graph_keys', '87b534681113b48c6e6c40160393d555'),
  ('trigger', 'public', 'member_broadcasts', 'a00_case_graph_lock', '624d2a8ead724060a2859199e72e85a4'),
  ('trigger', 'public', 'member_broadcasts', 'member_broadcasts_forbid_ownerless_write', 'f8bc61488e3e49622309fdd97f9b9ba8'),
  ('trigger', 'public', 'member_broadcasts', 'member_broadcasts_queue_delivery', '7f183d70434c7ac37239b22d85987f3f'),
  ('trigger', 'public', 'member_broadcasts', 'z99_case_graph_keys', '7eaa7003fc943267b09afa84359c587f'),
  ('trigger', 'public', 'member_calendar_busy', 'a00_case_graph_lock', 'c387a2ad97e997dc642b0ff5124a0c08'),
  ('trigger', 'public', 'member_calendar_busy', 'z99_case_graph_keys', '80756f78e6e5e6b687de3812846bed5c'),
  ('trigger', 'public', 'member_calendar_connections', 'a00_case_graph_lock', '168e871c4f146b54b6c6669d689928a8'),
  ('trigger', 'public', 'member_calendar_connections', 'member_calendar_connections_touch', '4578f01ac481917cb73d0e139f888dad'),
  ('trigger', 'public', 'member_calendar_connections', 'z99_case_graph_keys', '20f432513ad13d0fe1c0e32201127a48'),
  ('trigger', 'public', 'member_calendar_feed_tokens', 'a00_case_graph_lock', 'd11b3620aab41a43a3538cff05537275'),
  ('trigger', 'public', 'member_calendar_feed_tokens', 'z99_case_graph_keys', '6f622bb1b46e9dc53688a785086ff873'),
  ('trigger', 'public', 'member_calendar_import_events', 'a00_case_graph_lock', '187ff6bb67a944ba539e492bec41a3d6'),
  ('trigger', 'public', 'member_calendar_import_events', 'z99_case_graph_keys', 'b81c1d2a8c9f9b15a9e7f1fef95ed595'),
  ('trigger', 'public', 'member_case_assignment_audit', 'a00_case_graph_lock', '55622f9e0c28a45e091c62554defc02e'),
  ('trigger', 'public', 'member_case_assignment_audit', 'member_case_assignment_audit_immutable', '68cb704471c22ee1b403e4524c5ced15'),
  ('trigger', 'public', 'member_case_assignment_audit', 'z99_case_graph_keys', '9968a0ef8e1a164be86d9f9d80c3ee64'),
  ('trigger', 'public', 'member_case_contacts', 'a00_case_graph_lock', '470b5348feb7e3f41521b45b591fbd6b'),
  ('trigger', 'public', 'member_case_contacts', 'z99_case_graph_keys', '857a7bafe9d683cf1fd51fc0f07f89a9'),
  ('trigger', 'public', 'member_case_files', 'a00_case_graph_lock', '4aaa9c0fa97c200213a36dcefecefd00'),
  ('trigger', 'public', 'member_case_files', 'z99_case_graph_keys', '4e8319a2427176d9547e0d0e3eacdafd'),
  ('trigger', 'public', 'member_case_outcomes', 'a00_case_graph_lock', 'a993021d535de5c4004adf43d322c5da'),
  ('trigger', 'public', 'member_case_outcomes', 'z99_case_graph_keys', 'cd5f47e1f06c7ca0538bf97322974954'),
  ('trigger', 'public', 'member_case_updates', 'a00_case_graph_lock', '8e826cf4dac50d7d0dd0a96797c320f3'),
  ('trigger', 'public', 'member_case_updates', 'z99_case_graph_keys', '7f22d9737f3eef4e423fa4e441e2daaf'),
  ('trigger', 'public', 'member_cases', 'a00_case_graph_lock', '0f05afcee77fbe2bb005f8e465edd1d4'),
  ('trigger', 'public', 'member_cases', 'member_cases_bind_organization', 'ee4d93c77110d6d902b474e5a6008fa2'),
  ('trigger', 'public', 'member_cases', 'member_cases_capture_account_lifecycle_scope', '26e290d4470444920279c949583971cd'),
  ('trigger', 'public', 'member_cases', 'member_cases_guard_restriction_insert', 'da78ba6e1815065b22bbf7bacba0e00d'),
  ('trigger', 'public', 'member_cases', 'member_cases_guard_restriction_update', '775133f2a6a6b205d0b4fc93159b0c2f'),
  ('trigger', 'public', 'member_cases', 'member_cases_touch_updated_at', '0e54216a9d9d47c48beb1114e6efe75a'),
  ('trigger', 'public', 'member_cases', 'z99_case_graph_keys', 'b19dbdb482245b26aff59cbb13c01f3d'),
  ('trigger', 'public', 'member_chapter_memberships', 'a00_case_graph_lock', '2490e506c507d0b3babb1350298cc580'),
  ('trigger', 'public', 'member_chapter_memberships', 'z99_case_graph_keys', '56c737ce2db3f8d1987692177d74a886'),
  ('trigger', 'public', 'member_contact_notes', 'a00_case_graph_lock', '06b03acafb01dc41b72362165e60427c'),
  ('trigger', 'public', 'member_contact_notes', 'z99_case_graph_keys', '87e2b61d81d6693539c48ccf30338bde'),
  ('trigger', 'public', 'member_conversations', 'a00_case_graph_lock', 'dd409af40df8cc6ea10cc824c82cd92c'),
  ('trigger', 'public', 'member_conversations', 'member_conversations_touch_updated_at', '31c15f7e4315fe2ab79bef68ffbbd2df'),
  ('trigger', 'public', 'member_conversations', 'z99_case_graph_keys', '19c5ce20e3aaee6aa9316c9b87c13fbc'),
  ('trigger', 'public', 'member_emergency_checklists', 'a00_case_graph_lock', '2153871b7a05b4bc74b05bb4dd3ccf89'),
  ('trigger', 'public', 'member_emergency_checklists', 'z99_case_graph_keys', 'b6f3374526684d62fdc58c44b354a348'),
  ('trigger', 'public', 'member_event_checkins', 'a00_case_graph_lock', '58b818d832479c53c67b5e9d6a856730'),
  ('trigger', 'public', 'member_event_checkins', 'z99_case_graph_keys', '6db54108b7d023d21b6e942a5911971f'),
  ('trigger', 'public', 'member_event_rsvps', 'a00_case_graph_lock', 'b6463d2ec59097c96299a7747948b2e3'),
  ('trigger', 'public', 'member_event_rsvps', 'z99_case_graph_keys', '08dcf04a60c97766635680fa25277a26'),
  ('trigger', 'public', 'member_events', 'a00_case_graph_lock', '51e4796a6f4a8eec362cfca766b092d2'),
  ('trigger', 'public', 'member_events', 'z99_case_graph_keys', '56ad665f2ed39e23f5ad5ddf3af05c13'),
  ('trigger', 'public', 'member_form_cosigners', 'a00_case_graph_lock', '4b5910afe678e6cbbefeea5accefc6c4'),
  ('trigger', 'public', 'member_form_cosigners', 'member_form_cosigners_parent_mutable', '8da8ae613865f16bbe6470e59625951e'),
  ('trigger', 'public', 'member_form_cosigners', 'z99_case_graph_keys', 'f3cc13306ec5022c3fc2a6021df76729'),
  ('trigger', 'public', 'member_form_files', 'a00_case_graph_lock', '715a6d011ff796a7f8ef64f6d6e602c3'),
  ('trigger', 'public', 'member_form_files', 'member_form_files_parent_mutable', '41fa8e047a042598451b9623097bbc32'),
  ('trigger', 'public', 'member_form_files', 'z99_case_graph_keys', 'a9947c5f655e153b977decab3451df96'),
  ('trigger', 'public', 'member_forms', 'a00_case_graph_lock', '6b6e6785d50856201a1051109d4292e3'),
  ('trigger', 'public', 'member_forms', 'member_forms_approved_immutable', '677e347d61d437f9e166a30ceab8617d'),
  ('trigger', 'public', 'member_forms', 'trg_notify_cosigners_on_approve', '40fb45d34ffd8cdf2dc1ab93efd74cc1'),
  ('trigger', 'public', 'member_forms', 'z99_case_graph_keys', 'b1603905f36d95462fc640c85481c040'),
  ('trigger', 'public', 'member_guide_messages', 'a00_case_graph_lock', '8f6dc85ac6287b8556953e0d008de0bc'),
  ('trigger', 'public', 'member_guide_messages', 'z99_case_graph_keys', '319979aa2275efd335c2f6afd7cc59d0'),
  ('trigger', 'public', 'member_guide_threads', 'a00_case_graph_lock', '0f845097f995b716f513995202c51b5f'),
  ('trigger', 'public', 'member_guide_threads', 'member_guide_threads_touch_updated_at', 'cfbd3110769f1c88efef37e6efdbda19'),
  ('trigger', 'public', 'member_guide_threads', 'z99_case_graph_keys', '12d5d416d370bade63c9bc531db50ee7'),
  ('trigger', 'public', 'member_handoffs', 'a00_case_graph_lock', 'b44b3871f876e7f86b4005afb43ea0d0'),
  ('trigger', 'public', 'member_handoffs', 'member_handoffs_org_key', 'adc2b97cc1cc685e998e93f9405e258e'),
  ('trigger', 'public', 'member_handoffs', 'z99_case_graph_keys', '42a2a6ea10ebd5dc40a0ced589f587fc'),
  ('trigger', 'public', 'member_hr_contacts', 'a00_case_graph_lock', '8c31aad40809278fe085e2e84fc5c5d3'),
  ('trigger', 'public', 'member_hr_contacts', 'z99_case_graph_keys', 'ab80fbabb0c21c2994ce970464f5c218'),
  ('trigger', 'public', 'member_intake_reports', 'a00_case_graph_lock', '73b8d268b42c5b83d92b8db59ba6623b'),
  ('trigger', 'public', 'member_intake_reports', 'member_intake_reports_touch_updated_at', 'd3b7ea30442bb8bcfd2f44dc0ae49565'),
  ('trigger', 'public', 'member_intake_reports', 'stamp_product_identity', 'c3b356217e6f4bed011b3623ed3a0f8e'),
  ('trigger', 'public', 'member_intake_reports', 'z99_case_graph_keys', '5e824bbdd5bfb4166ff731120fc80e06'),
  ('trigger', 'public', 'member_invitation_audit', 'a00_case_graph_lock', '2c7a48c4041a8640671b302b58347fb3'),
  ('trigger', 'public', 'member_invitation_audit', 'z99_case_graph_keys', '35372595cf9ae9a30949ddc24c524946'),
  ('trigger', 'public', 'member_invitations', 'a00_case_graph_lock', '369d9417961a384a486d47a3ea3c7931'),
  ('trigger', 'public', 'member_invitations', 'z99_case_graph_keys', 'b9afd7cde9c88ea0070e31c454a6c725'),
  ('trigger', 'public', 'member_kb_article_revisions', 'a00_case_graph_lock', 'd8ee22644ca4bb90597877b4bdf8af63'),
  ('trigger', 'public', 'member_kb_article_revisions', 'z99_case_graph_keys', 'a98ab3b9c0ec62d495edad80e9247a64'),
  ('trigger', 'public', 'member_kb_articles', 'a00_case_graph_lock', '0aae78a32984744fa6e56b623aae8364'),
  ('trigger', 'public', 'member_kb_articles', 'z99_case_graph_keys', '70bb9d416ccaaa4ebde12644c803a08e'),
  ('trigger', 'public', 'member_mentorship_goals', 'a00_case_graph_lock', '3ca749ca981e80ab4d19e0e739ec4cfa'),
  ('trigger', 'public', 'member_mentorship_goals', 'z99_case_graph_keys', 'a53cc26d22781b3f2ce7b604b830cac8'),
  ('trigger', 'public', 'member_mentorship_notes', 'a00_case_graph_lock', '3e2a54f54a7c48f86fb5a80a65380451'),
  ('trigger', 'public', 'member_mentorship_notes', 'z99_case_graph_keys', '1d2d43c7c8b6df5b5a9f7a3f515b8e61'),
  ('trigger', 'public', 'member_mentorship_pairs', 'a00_case_graph_lock', '7e5ba50de05a53b10a41b4e70ffbb6a9'),
  ('trigger', 'public', 'member_mentorship_pairs', 'z99_case_graph_keys', 'ebdfc9624705f8fbcc7d8d00e73a6156'),
  ('trigger', 'public', 'member_message_reactions', 'a00_case_graph_lock', '6c0e526cc382b0a625c8fbd1cbc0965d'),
  ('trigger', 'public', 'member_message_reactions', 'z99_case_graph_keys', '15908af9bb825bf15122f59b6bc0b7ee'),
  ('trigger', 'public', 'member_message_reminders', 'a00_case_graph_lock', 'a2cbdacbe7fbd18cf4328259007086d8'),
  ('trigger', 'public', 'member_message_reminders', 'z99_case_graph_keys', '33aa1f90ad6a3fdb968bceb60f510c85'),
  ('trigger', 'public', 'member_message_resources', 'a00_case_graph_lock', '127b3cbf6e83f14b4994dcfd503fb9a4'),
  ('trigger', 'public', 'member_message_resources', 'z99_case_graph_keys', 'de9b880fe5dab79fb25a5d9a56d92f5c'),
  ('trigger', 'public', 'member_messages', 'a00_case_graph_lock', 'f4f9107f9e886f6030d975a3bac14953'),
  ('trigger', 'public', 'member_messages', 'z99_case_graph_keys', 'a9cc945feb054d924715a17c26d35da9'),
  ('trigger', 'public', 'member_native_push_installations', 'a00_case_graph_lock', '4e106464f614cf7696a4a83f78d39598'),
  ('trigger', 'public', 'member_native_push_installations', 'member_native_push_installations_audit', '5a83fd6aa2321ba77cc380f0da09f451'),
  ('trigger', 'public', 'member_native_push_installations', 'z99_case_graph_keys', 'e88bd8981b993f987035388a953d03df'),
  ('trigger', 'public', 'member_notification_deliveries', 'a00_case_graph_lock', '8e94d893b6905ef0aef85a236380a9f6'),
  ('trigger', 'public', 'member_notification_deliveries', 'z99_case_graph_keys', '5d873ae7fb7c95312150950c0ef03359'),
  ('trigger', 'public', 'member_notifications', 'a00_case_graph_lock', 'ad102d8d316f353fdc667c3d0d349540'),
  ('trigger', 'public', 'member_notifications', 'member_notifications_enqueue_deliveries', 'f2f81a071e2c282823f4802302c80975'),
  ('trigger', 'public', 'member_notifications', 'z99_case_graph_keys', '67d648a3368639944ef12f75735483ac'),
  ('trigger', 'public', 'member_onboarding_plans', 'a00_case_graph_lock', '1023fa3c0b425e599de20d8d302d8760'),
  ('trigger', 'public', 'member_onboarding_plans', 'z99_case_graph_keys', '79d3e7c54bf7972fc886fd4811dc1490'),
  ('trigger', 'public', 'member_peer_contact_keys', 'a00_case_graph_lock', 'd66e475683104f14038c6a5f1df74b48'),
  ('trigger', 'public', 'member_peer_contact_keys', 'z99_case_graph_keys', 'da9fa0a399daed30f6ed9b852c7e05dd'),
  ('trigger', 'public', 'member_peer_contact_requests', 'a00_case_graph_lock', 'b3c4a7366d8f8ba46706eb784e75489a'),
  ('trigger', 'public', 'member_peer_contact_requests', 'z99_case_graph_keys', 'b9afc8dfd0683e1221f6bed6528f906f'),
  ('trigger', 'public', 'member_peer_conversations', 'a00_case_graph_lock', 'a835cc24dcee73b492110a1b32788f14'),
  ('trigger', 'public', 'member_peer_conversations', 'z99_case_graph_keys', 'f29c27d5952aefac1881fea71ee81bf6'),
  ('trigger', 'public', 'member_peer_messages', 'a00_case_graph_lock', '34489b28c4fd4fa0e7344f05df3cd959'),
  ('trigger', 'public', 'member_peer_messages', 'z99_case_graph_keys', '502ade10a0acbd0169af365f53ec0dcb'),
  ('trigger', 'public', 'member_point_events', 'a00_case_graph_lock', '3108dcf42fcfd6035255e9f2150a5aa6'),
  ('trigger', 'public', 'member_point_events', 'member_point_events_preserve_tier', '952c369765ab5eb815dfffff38e8da5c'),
  ('trigger', 'public', 'member_point_events', 'z99_case_graph_keys', '73122e7eb50d7eab0b4f924e8746fa10'),
  ('trigger', 'public', 'member_presence', 'a00_case_graph_lock', 'fa0c41f6b925eb34a662a63b675dad45'),
  ('trigger', 'public', 'member_presence', 'z99_case_graph_keys', '5b23c34e5589802324d76527bf8814b0'),
  ('trigger', 'public', 'member_profiles', 'a00_case_graph_lock', '956e437b6150e6995669d329e4b1547b'),
  ('trigger', 'public', 'member_profiles', 'member_profiles_peer_contact_key', '1d284171ded3ea382fa75fe4a8d2dbe9'),
  ('trigger', 'public', 'member_profiles', 'member_profiles_refresh_task_names', '18d2eaa6bb6286210c2f19536716057d'),
  ('trigger', 'public', 'member_profiles', 'member_profiles_touch_updated_at', 'b15ddc154341e611b8c8a78cbecb57ef'),
  ('trigger', 'public', 'member_profiles', 'member_profiles_validate_focus_timezone', 'dd12fbaeb32e529dd301f3e79b539d7d'),
  ('trigger', 'public', 'member_profiles', 'z99_case_graph_keys', 'f9bf512d257565a7ec8f3c72f07142db'),
  ('trigger', 'public', 'member_push_subscriptions', 'a00_case_graph_lock', 'ad8d288dc849a462acd6c74885e5a9c2'),
  ('trigger', 'public', 'member_push_subscriptions', 'member_push_subscriptions_cap', '227aecabcfe89c4e2ef150910452b138'),
  ('trigger', 'public', 'member_push_subscriptions', 'z99_case_graph_keys', 'd940c3cd155c581ef40eec3fb15bfd7e'),
  ('trigger', 'public', 'member_qa_questions', 'a00_case_graph_lock', '922ce7ba2c9aac783f27096e334ac2c3'),
  ('trigger', 'public', 'member_qa_questions', 'z99_case_graph_keys', '8c6fa5116b2483832fe3647ee92fe51e'),
  ('trigger', 'public', 'member_qa_replies', 'a00_case_graph_lock', '4911eae0ec2ffe5ab61c61bebaf740d5'),
  ('trigger', 'public', 'member_qa_replies', 'member_qa_replies_same_organization', 'c084672a8c687c944a4e3a2eddad0a94'),
  ('trigger', 'public', 'member_qa_replies', 'z99_case_graph_keys', '40af830c9a3f36653090bb73e32d92fd'),
  ('trigger', 'public', 'member_qa_votes', 'a00_case_graph_lock', '973a2aa1bfabc846133940473d5b1125'),
  ('trigger', 'public', 'member_qa_votes', 'z99_case_graph_keys', '6d493bc7493ac5da76814b40cf4f4b90'),
  ('trigger', 'public', 'member_report_preferences', 'a00_case_graph_lock', 'a03b6bb9683f8dbd17cad18d2dddb0cf'),
  ('trigger', 'public', 'member_report_preferences', 'z99_case_graph_keys', '34e38587aeac5b9262514d8d1f265456'),
  ('trigger', 'public', 'member_reward_economy_revisions', 'a00_case_graph_lock', '0b1e9fdf50dbf434c09d2cd2cdefd845'),
  ('trigger', 'public', 'member_reward_economy_revisions', 'z99_case_graph_keys', '81c56a9b1cdc3d1c5d3376cb7bc0abc3'),
  ('trigger', 'public', 'member_reward_grants', 'a00_case_graph_lock', '71f29ad9c0470ba0c67cdb96f996f1b0'),
  ('trigger', 'public', 'member_reward_grants', 'member_reward_grants_forbid_ownerless_write', '6add047471e605e3ab825b4c8534fb57'),
  ('trigger', 'public', 'member_reward_grants', 'z99_case_graph_keys', 'a263754c105ad4566386111e789d815c'),
  ('trigger', 'public', 'member_reward_tier_attainment', 'a00_case_graph_lock', 'fe025d75c145977798ea9da278c73e1a'),
  ('trigger', 'public', 'member_reward_tier_attainment', 'z99_case_graph_keys', '8aef6fc83ca754c0389063e43f783b55'),
  ('trigger', 'public', 'member_rights_progress', 'a00_case_graph_lock', '4928d8423501fb700bc64afd95643c71'),
  ('trigger', 'public', 'member_rights_progress', 'z99_case_graph_keys', '6aa11af7b4f5d891ffca710397da324b'),
  ('trigger', 'public', 'member_role_chapters', 'a00_case_graph_lock', 'aaff66157c1f0e4b286cc5f570ea6113'),
  ('trigger', 'public', 'member_role_chapters', 'z99_case_graph_keys', '72a6cf07fe84fa16ceb0c86b2ff53459'),
  ('trigger', 'public', 'member_roles', 'a00_case_graph_lock', '43e88bb4fe42ef44c89327db1e60bd38'),
  ('trigger', 'public', 'member_roles', 'member_roles_forbid_new_ownerless', '698ed04b28888ed1668cd44fd5b51c2d'),
  ('trigger', 'public', 'member_roles', 'z99_case_graph_keys', 'fd40daa1dd6f335e7a5a83befc59e897'),
  ('trigger', 'public', 'member_saved_messages', 'a00_case_graph_lock', '243a536966776abd3fe6806ef7efd282'),
  ('trigger', 'public', 'member_saved_messages', 'z99_case_graph_keys', '196e773ce68714777bb71d43408c8c12'),
  ('trigger', 'public', 'member_scheduled_messages', 'a00_case_graph_lock', '37975022d855fbc2c56e4f70dd3c5c6c'),
  ('trigger', 'public', 'member_scheduled_messages', 'z99_case_graph_keys', 'ab950a98475e4aa2843ec952167afd12'),
  ('trigger', 'public', 'member_steward_relationships', 'a00_case_graph_lock', 'eba17df0b5472864a04ec777a6a514ab'),
  ('trigger', 'public', 'member_steward_relationships', 'member_steward_relationships_org_key', 'ae153a397c16a443dfdbffbe21f005ad'),
  ('trigger', 'public', 'member_steward_relationships', 'z99_case_graph_keys', '12308a05b83fbe1f6dccdd90dc2265c3'),
  ('trigger', 'public', 'member_steward_requests', 'a00_case_graph_lock', '269c67bd75949503279bab27c8934c0f'),
  ('trigger', 'public', 'member_steward_requests', 'member_steward_requests_award_on_ack', '4ad92e35cdbf6e1c1aeea00cd7bd54af'),
  ('trigger', 'public', 'member_steward_requests', 'member_steward_requests_notify_stewards', '29f2127d7f6d6192699338c728b37e44'),
  ('trigger', 'public', 'member_steward_requests', 'z99_case_graph_keys', 'd9999bd0f5053351487fbf82727bf3f8'),
  ('trigger', 'public', 'member_support_events', 'a00_case_graph_lock', 'a0cfa89b2c1f5dd1c563ee129a2b1645'),
  ('trigger', 'public', 'member_support_events', 'z99_case_graph_keys', '02895e51895e614225d21b599c5813d3'),
  ('trigger', 'public', 'member_survey_options', 'a00_case_graph_lock', 'f1cb5d962761656f03b7d2ae8a566ede'),
  ('trigger', 'public', 'member_survey_options', 'z99_case_graph_keys', '42a7aab60511efd9f08a8fa74db35b35'),
  ('trigger', 'public', 'member_survey_responses', 'a00_case_graph_lock', 'f5a20968560dd67ef0584c9509a15de0'),
  ('trigger', 'public', 'member_survey_responses', 'z99_case_graph_keys', '0fbfaef3aa312720890249fe67c1bd67'),
  ('trigger', 'public', 'member_surveys', 'a00_case_graph_lock', '2913dd21a454889f04b0289105d2f9c5'),
  ('trigger', 'public', 'member_surveys', 'z99_case_graph_keys', 'ddba36473a674a39c1edd8d9e71135db'),
  ('trigger', 'public', 'member_vp_case_reviews', 'a00_case_graph_lock', '517be1925ec055faa4d58e5da127ab9d'),
  ('trigger', 'public', 'member_vp_case_reviews', 'z99_case_graph_keys', 'a545344e0cd136f64a4e4416dc7d2789'),
  ('trigger', 'public', 'member_weekly_question_promotions', 'a00_case_graph_lock', '9fa3d47b7191adfc4e38822bf07168b2'),
  ('trigger', 'public', 'member_weekly_question_promotions', 'z99_case_graph_keys', '4fe3230f7c3b57e95038c43449fdfcb4'),
  ('trigger', 'public', 'member_weekly_question_supports', 'a00_case_graph_lock', 'eb302a9eb44515e1d4c44505f4fe4bb9'),
  ('trigger', 'public', 'member_weekly_question_supports', 'z99_case_graph_keys', '7f3ca7dc9a75374b8a33deaf3263cfc8'),
  ('trigger', 'public', 'member_weekly_questions', 'a00_case_graph_lock', '390f4b03eeaeae6241d7b918c18019b0'),
  ('trigger', 'public', 'member_weekly_questions', 'z99_case_graph_keys', '56a616fbd49da92bae1be7375c6075ae'),
  ('trigger', 'public', 'member_welcome_enrollments', 'a00_case_graph_lock', '9933e41dc52e2a675ab7158921dffe3a'),
  ('trigger', 'public', 'member_welcome_enrollments', 'z99_case_graph_keys', '911a9daa4a497ddf3fcd8c695fa9b62e'),
  ('trigger', 'public', 'member_workload_logs', 'a00_case_graph_lock', 'c3f0fb1ec99ad96fc22361a4c103c392'),
  ('trigger', 'public', 'member_workload_logs', 'z99_case_graph_keys', '616b8859b986f1306f0910be58f9adcc'),
  ('trigger', 'public', 'mfa_recovery_code_sets', 'a00_case_graph_lock', 'e621385482ac2df6f39164ca0d9d8eee'),
  ('trigger', 'public', 'mfa_recovery_code_sets', 'z99_case_graph_keys', 'fb4a06aab39b8dc7992ddddb25cf418a'),
  ('trigger', 'public', 'mfa_recovery_codes', 'a00_case_graph_lock', '919d8771756075425d1173a207a6ab61'),
  ('trigger', 'public', 'mfa_recovery_codes', 'z99_case_graph_keys', '4c816e3ce6f8d6aeae884e34fa2e47bb'),
  ('trigger', 'public', 'org_security_policy', 'a00_case_graph_lock', 'f9a4811dc904d4f40b71241528acd111'),
  ('trigger', 'public', 'org_security_policy', 'z99_case_graph_keys', '1410cf004a84a9fc6d9d8dccc664d55d'),
  ('trigger', 'public', 'organization_analytics_exports', 'a00_case_graph_lock', '984934e601b992ede8f37c34183fba83'),
  ('trigger', 'public', 'organization_analytics_exports', 'z99_case_graph_keys', 'c082cf198fe24193caf0eca13a329afb'),
  ('trigger', 'public', 'organization_analytics_layout_events', 'a00_case_graph_lock', '5d223627b9dd474923633b3f4d2c9ada'),
  ('trigger', 'public', 'organization_analytics_layout_events', 'z99_case_graph_keys', 'bdf7ec31ec836f7986d220579bc0eda4'),
  ('trigger', 'public', 'organization_analytics_layouts', 'a00_case_graph_lock', '4e6648f5db1031e93d21d2716ec8bd28'),
  ('trigger', 'public', 'organization_analytics_layouts', 'z99_case_graph_keys', 'd67e9133a5947ff8fc24a7966d7b7e5a'),
  ('trigger', 'public', 'organization_audit_events', 'a00_case_graph_lock', '754facec676192f8240b75ba639be529'),
  ('trigger', 'public', 'organization_audit_events', 'organization_audit_events_append_only', '947b3c517ec42ca96ab536ed91dc09f2'),
  ('trigger', 'public', 'organization_audit_events', 'z99_case_graph_keys', 'd8e42d9c44f33ddb4a17c53d3e5c1ae5'),
  ('trigger', 'public', 'organization_audit_ledger', 'a00_case_graph_lock', 'e0959dd45ec168984a7170f3d5646fa5'),
  ('trigger', 'public', 'organization_audit_ledger', 'organization_audit_ledger_append_only', 'cd66fd10c43e3c6920489c9f8c80a946'),
  ('trigger', 'public', 'organization_audit_ledger', 'z99_case_graph_keys', '57f1b258dbe877f8a4e2387987b781e3'),
  ('trigger', 'public', 'organization_automation_definitions', 'a00_case_graph_lock', '1beb2c6c9c90d73b3f66a26ad04ae279'),
  ('trigger', 'public', 'organization_automation_definitions', 'z99_case_graph_keys', 'ab9ce2102b73798ecaae024177c2c7d0'),
  ('trigger', 'public', 'organization_automation_effects', 'a00_case_graph_lock', 'dadacf78a7dc7fd091611a0fe06b4157'),
  ('trigger', 'public', 'organization_automation_effects', 'z99_case_graph_keys', 'b029b351fd061e14355d0a3f5347339a'),
  ('trigger', 'public', 'organization_automation_runs', 'a00_case_graph_lock', 'f9aa95325e2d30a5f91a156c153d606e'),
  ('trigger', 'public', 'organization_automation_runs', 'z99_case_graph_keys', 'dcf2a2372e40bc8ff7b5df76c825c325'),
  ('trigger', 'public', 'organization_automation_settings', 'a00_case_graph_lock', '62cae84c23f241d22f12f32ba9db7fd8'),
  ('trigger', 'public', 'organization_automation_settings', 'z99_case_graph_keys', '007be69b023a1053fcd40afd96270554'),
  ('trigger', 'public', 'organization_chart_nodes', 'a00_case_graph_lock', '2fb8f1c4e8ad7c7a1ce8575f4f79eb99'),
  ('trigger', 'public', 'organization_chart_nodes', 'z99_case_graph_keys', '3d1b58232679f7bbfb14e89db2d1d194'),
  ('trigger', 'public', 'organization_coalition_decision_votes', 'a00_case_graph_lock', 'dc8fa8bbd588c633fe8a5724cfaa72e8'),
  ('trigger', 'public', 'organization_coalition_decision_votes', 'z99_case_graph_keys', '81ab323d0df67b5bf8b1c4abff017a7e'),
  ('trigger', 'public', 'organization_coalition_decisions', 'a00_case_graph_lock', '538ce6a839f0acd750b9ca3c83396c63'),
  ('trigger', 'public', 'organization_coalition_decisions', 'validate_organization_coalition_decision', '54461672e165356b0277db6a401078c1'),
  ('trigger', 'public', 'organization_coalition_decisions', 'z99_case_graph_keys', '805a60c663cd633c40e37fed4fbddeda'),
  ('trigger', 'public', 'organization_configuration_audit', 'a00_case_graph_lock', '2ce5f1ccac19138fcceca49885eb694e'),
  ('trigger', 'public', 'organization_configuration_audit', 'z99_case_graph_keys', 'eb21fe0b20ccbb5f8d9163a419ec1481'),
  ('trigger', 'public', 'organization_coordination_events', 'a00_case_graph_lock', 'e81d0fc78da2e7eb58a6c1aa4957297e'),
  ('trigger', 'public', 'organization_coordination_events', 'z99_case_graph_keys', '005f01fec031497594b848eb4da3d43e'),
  ('trigger', 'public', 'organization_coordination_export_runs', 'a00_case_graph_lock', '9d74082625c31f4f0c8a39cb5c1a44c1'),
  ('trigger', 'public', 'organization_coordination_export_runs', 'z99_case_graph_keys', 'e3fb853a014ab6cbb2ba38cb754223ee'),
  ('trigger', 'public', 'organization_coordination_messages', 'a00_case_graph_lock', '0c18f65033508fcf9785a794e585666e'),
  ('trigger', 'public', 'organization_coordination_messages', 'z99_case_graph_keys', 'caf319b759ce07ea5114433cb766d35b'),
  ('trigger', 'public', 'organization_coordination_organization_participants', 'a00_case_graph_lock', '960857570860f36ce01b29135a3834e8'),
  ('trigger', 'public', 'organization_coordination_organization_participants', 'z99_case_graph_keys', 'ab9beb23cb1aa9aba5234e58d4fca450'),
  ('trigger', 'public', 'organization_coordination_outreach_events', 'a00_case_graph_lock', 'e1b6df8756746cdf92ace6b102fa85c2'),
  ('trigger', 'public', 'organization_coordination_outreach_events', 'z99_case_graph_keys', '93adf505711fd67c8cf6769fdc698936'),
  ('trigger', 'public', 'organization_coordination_page_attachments', 'a00_case_graph_lock', '93f70506b84860f48748c9fbdadbb1f4'),
  ('trigger', 'public', 'organization_coordination_page_attachments', 'z99_case_graph_keys', '0a1fba6939b71915c704812e0651d530'),
  ('trigger', 'public', 'organization_coordination_records', 'a00_case_graph_lock', 'c3db53439ea5a85afbf7c8efb40c764a'),
  ('trigger', 'public', 'organization_coordination_records', 'inherit_organization_coordination_participants', '7301db918d439a4be6922c829d688ef4'),
  ('trigger', 'public', 'organization_coordination_records', 'validate_organization_coordination_record_shape', '98dd9243ef84a58966682a76def1be4c'),
  ('trigger', 'public', 'organization_coordination_records', 'validate_organization_coordination_visibility', '8c6f392cfbaf9fde31288c8bbc4b9d5d'),
  ('trigger', 'public', 'organization_coordination_records', 'z99_case_graph_keys', '44816186abf4051491e25e3d95e7bd35'),
  ('trigger', 'public', 'organization_coordination_resources', 'a00_case_graph_lock', 'eb7184028bb8b44f651646a3917b7712'),
  ('trigger', 'public', 'organization_coordination_resources', 'validate_organization_coordination_resource_permission', '7ba8c1c043f6884c905d9d27b58c2032'),
  ('trigger', 'public', 'organization_coordination_resources', 'z99_case_graph_keys', 'd8cdc1a12fd083b0c5cf5b9465dbedfb'),
  ('trigger', 'public', 'organization_coordination_user_participants', 'a00_case_graph_lock', 'f53756c602663d06cdf9587bd655db37'),
  ('trigger', 'public', 'organization_coordination_user_participants', 'award_organization_mission_badges', '2d8567891981ea39ce20f90911d3a8e1'),
  ('trigger', 'public', 'organization_coordination_user_participants', 'z99_case_graph_keys', 'daaf1091eeffd4df62d6f195149c5ecc'),
  ('trigger', 'public', 'organization_data_export_runs', 'a00_case_graph_lock', '5e86fa140c4b7596d88050f0479246b2'),
  ('trigger', 'public', 'organization_data_export_runs', 'z99_case_graph_keys', '25641c80018cf4b4479d6c157745fb6e'),
  ('trigger', 'public', 'organization_engagement_events', 'a00_case_graph_lock', '3061815f91bb66accbbf4854d9ada1e9'),
  ('trigger', 'public', 'organization_engagement_events', 'z99_case_graph_keys', '53c34779326a31db8a4e963d6262522c'),
  ('trigger', 'public', 'organization_failed_login_attempts', 'a00_case_graph_lock', 'bb90be7b4b2c9180e234f172a5e2f5f2'),
  ('trigger', 'public', 'organization_failed_login_attempts', 'z99_case_graph_keys', '3cffd23610ae14d18311bc2ac5fea50a'),
  ('trigger', 'public', 'organization_field_note_blocks', 'a00_case_graph_lock', '7ed6a125b11421d17e871c4056f53820'),
  ('trigger', 'public', 'organization_field_note_blocks', 'z99_case_graph_keys', 'e48460ab9901d7808f4e0895d86eed65'),
  ('trigger', 'public', 'organization_field_note_packets', 'a00_case_graph_lock', 'f83bb27b7863cbd74c38e3596749376f'),
  ('trigger', 'public', 'organization_field_note_packets', 'z99_case_graph_keys', 'a204ffd6a8c5fbd6258b5a37a04b3faa'),
  ('trigger', 'public', 'organization_field_note_sources', 'a00_case_graph_lock', 'af93dc9624fab501d003f19a2caa2c75'),
  ('trigger', 'public', 'organization_field_note_sources', 'z99_case_graph_keys', 'e7bd2174c81002d2584578dd6ac52129'),
  ('trigger', 'public', 'organization_hr_directory', 'a00_case_graph_lock', '4760dc4a74e410c5bf23be02bb9921ae'),
  ('trigger', 'public', 'organization_hr_directory', 'z99_case_graph_keys', '6cbc943e1c98226b2e0bc5434dda0c99'),
  ('trigger', 'public', 'organization_import_batches', 'a00_case_graph_lock', 'e1aa8f8a158c7fbec763c8e28c0137c8'),
  ('trigger', 'public', 'organization_import_batches', 'z99_case_graph_keys', '0998e56501d91467ddcae0aaab356bac'),
  ('trigger', 'public', 'organization_import_rows', 'a00_case_graph_lock', '20622f9ec1eba9f766e09cd1381e69c0'),
  ('trigger', 'public', 'organization_import_rows', 'z99_case_graph_keys', 'ffa98db2d4e87e98910b3ffa588c9edb'),
  ('trigger', 'public', 'organization_integrations', 'a00_case_graph_lock', '7aa375e9ea29eb590b48a9aae3a7a59c'),
  ('trigger', 'public', 'organization_integrations', 'z99_case_graph_keys', '9cd9419d0e4372c2aefd008a022e20e2'),
  ('trigger', 'public', 'organization_intelligence_audit_events', 'a00_case_graph_lock', 'e98aaf33045fdafcd8ec92144d0619b2'),
  ('trigger', 'public', 'organization_intelligence_audit_events', 'z99_case_graph_keys', 'a661a68069dac556d4ef23896658702e'),
  ('trigger', 'public', 'organization_job_acknowledgements', 'a00_case_graph_lock', 'a0f4b4dcc3e7e2e3d40cc7e4d4902bcc'),
  ('trigger', 'public', 'organization_job_acknowledgements', 'z99_case_graph_keys', 'cb0752660127c3e5e161e94517f353bf'),
  ('trigger', 'public', 'organization_job_runs', 'a00_case_graph_lock', '44ba8cb95e08edd93ef58bb4d0e6cc46'),
  ('trigger', 'public', 'organization_job_runs', 'z99_case_graph_keys', '383eef555cc6d925c0c3ceda52396f20'),
  ('trigger', 'public', 'organization_knowledge_chunks', 'a00_case_graph_lock', '593fb3b818a78174bef491264c4f01ac'),
  ('trigger', 'public', 'organization_knowledge_chunks', 'organization_knowledge_chunks_org_key', 'abe38185dcd1eae6dc380776f8c50c9f'),
  ('trigger', 'public', 'organization_knowledge_chunks', 'organization_knowledge_chunks_same_org', '18a83389a6e0832939711299cf63d027'),
  ('trigger', 'public', 'organization_knowledge_chunks', 'z99_case_graph_keys', '6edf0a66bd9b34a9620ed26edadc99eb'),
  ('trigger', 'public', 'organization_knowledge_files', 'a00_case_graph_lock', '6323c21481741770384822964b0648c6'),
  ('trigger', 'public', 'organization_knowledge_files', 'organization_knowledge_files_org_key', '01491e515deaf60d5f737a7038001fb3'),
  ('trigger', 'public', 'organization_knowledge_files', 'z99_case_graph_keys', '22264e4462475630d5cf104bce76fb34'),
  ('trigger', 'public', 'organization_knowledge_sources', 'a00_case_graph_lock', '1429c98d7a929a14e0f9538a5093f790'),
  ('trigger', 'public', 'organization_knowledge_sources', 'organization_knowledge_sources_org_key', 'f6c73bd5a4580ae2b5d2e0a08a6db3b0'),
  ('trigger', 'public', 'organization_knowledge_sources', 'z99_case_graph_keys', 'a54f7c2b44930104490ef8d3b01336f3'),
  ('trigger', 'public', 'organization_label_overrides', 'a00_case_graph_lock', '0bd0f36f47a0dcb28da436264160a546'),
  ('trigger', 'public', 'organization_label_overrides', 'z99_case_graph_keys', '33a4ff3e4861fb5332b468a0f763a91e'),
  ('trigger', 'public', 'organization_live_poll_attendance', 'a00_case_graph_lock', 'af15e692b6fb31a60b5d32b2a3c22e52'),
  ('trigger', 'public', 'organization_live_poll_attendance', 'z99_case_graph_keys', 'e0d31b4fa708250e5873bf540d996612'),
  ('trigger', 'public', 'organization_live_poll_options', 'a00_case_graph_lock', 'd9314c1c707aaf075bfe7e964418c528'),
  ('trigger', 'public', 'organization_live_poll_options', 'z99_case_graph_keys', '93a0c1940c5fea44fbc910e26bd7a2bb'),
  ('trigger', 'public', 'organization_live_poll_votes', 'a00_case_graph_lock', '29a8613eda800ab2478351f408c8195a'),
  ('trigger', 'public', 'organization_live_poll_votes', 'organization_live_poll_votes_recalculate', 'b355bf8374b05839bf064726a2739f18'),
  ('trigger', 'public', 'organization_live_poll_votes', 'z99_case_graph_keys', 'b950cfbc1db765347bb2b1d1a784cd4a'),
  ('trigger', 'public', 'organization_live_polls', 'a00_case_graph_lock', '9367edb691e489bc635de43ac58fe3a3'),
  ('trigger', 'public', 'organization_live_polls', 'z99_case_graph_keys', '8c3a006df3668161f2443b2a7fca390a'),
  ('trigger', 'public', 'organization_member_operational_profiles', 'a00_case_graph_lock', '3060f9b7fbc0869007b9a70a1d13d380'),
  ('trigger', 'public', 'organization_member_operational_profiles', 'z99_case_graph_keys', '84f8e2e2c05293337f42e70f6eda2af9'),
  ('trigger', 'public', 'organization_memberships', 'a00_case_graph_lock', '753fc7862b883c1573be77ca36767d76'),
  ('trigger', 'public', 'organization_memberships', 'organization_memberships_revoke_grants', '7c7269aefaf6497e31907701356e6ee8'),
  ('trigger', 'public', 'organization_memberships', 'provision_dues_member_subject_on_membership', 'a44086935975f2d7d95021f38bd88ff2'),
  ('trigger', 'public', 'organization_memberships', 'refresh_dues_financial_identity_on_membership', '0e698e059a8457f158c7a5a585bd51dc'),
  ('trigger', 'public', 'organization_memberships', 'z99_case_graph_keys', '01438c695262768c5d109e7dec30a446'),
  ('trigger', 'public', 'organization_merge_jobs', 'a00_case_graph_lock', '238e8d65a20e8dcd98f3492f700964fe'),
  ('trigger', 'public', 'organization_merge_jobs', 'z99_case_graph_keys', '83613e89b5a4721aecf1757006ac752c'),
  ('trigger', 'public', 'organization_merge_match_reviews', 'a00_case_graph_lock', 'd2373106cd1ee208b17926ffa323a09c'),
  ('trigger', 'public', 'organization_merge_match_reviews', 'z99_case_graph_keys', '2a07e5942fc1497e65bdcb892a43496f'),
  ('trigger', 'public', 'organization_merge_remap_events', 'a00_case_graph_lock', 'c276ed742b070eb90133aaaa2f14d110'),
  ('trigger', 'public', 'organization_merge_remap_events', 'z99_case_graph_keys', '983769045c9530651628aafb3f44f944'),
  ('trigger', 'public', 'organization_mission_badges', 'a00_case_graph_lock', 'a373e470f7a45f8dd4cca2e3935fec40'),
  ('trigger', 'public', 'organization_mission_badges', 'z99_case_graph_keys', '9b46f16d33545565081c66544af3bea9'),
  ('trigger', 'public', 'organization_network_access_events', 'a00_case_graph_lock', '94fd979a15c6adddd9ac01ad06803302'),
  ('trigger', 'public', 'organization_network_access_events', 'z99_case_graph_keys', 'b46e1ed1d8f61a9e9576267f8b5d1ae2'),
  ('trigger', 'public', 'organization_network_directory_profiles', 'a00_case_graph_lock', '0eae62beaa15b0e59368c0aadb70c9eb'),
  ('trigger', 'public', 'organization_network_directory_profiles', 'z99_case_graph_keys', 'be88e46acac402d5b8406420d6926201'),
  ('trigger', 'public', 'organization_network_permission_grants', 'a00_case_graph_lock', '55e2bc9f62782c76125d22ddb7056c73'),
  ('trigger', 'public', 'organization_network_permission_grants', 'z99_case_graph_keys', '19b859de37f18918fd2de648bdee90b4'),
  ('trigger', 'public', 'organization_object_action_runs', 'a00_case_graph_lock', '4276100672bce708986dcd95c87242eb'),
  ('trigger', 'public', 'organization_object_action_runs', 'z99_case_graph_keys', '694e8be119b9755c2739b30ff6a5794e'),
  ('trigger', 'public', 'organization_onboarding_steps', 'a00_case_graph_lock', '10b0c84bcd844fab6de36ec6c4bcfb80'),
  ('trigger', 'public', 'organization_onboarding_steps', 'z99_case_graph_keys', '1d8faab57658aa941800f9fd6d670a9a'),
  ('trigger', 'public', 'organization_page_views', 'a00_case_graph_lock', '8274441b5243cc04252b70d7cf3774d3'),
  ('trigger', 'public', 'organization_page_views', 'z99_case_graph_keys', '6fc79b73ec5ebfb02663c8c564885206'),
  ('trigger', 'public', 'organization_poms_evidence', 'a00_case_graph_lock', 'd848490cc51ba8486701de77f7ac32f1'),
  ('trigger', 'public', 'organization_poms_evidence', 'z99_case_graph_keys', '3911e029257287e621badf7bb1f49eb2'),
  ('trigger', 'public', 'organization_poms_ingest_chunks', 'a00_case_graph_lock', '91fbb19eb43ed18c2431e81d94a75c20'),
  ('trigger', 'public', 'organization_poms_ingest_chunks', 'z99_case_graph_keys', 'a73aaae0723855af4e444ef1afe54946'),
  ('trigger', 'public', 'organization_poms_sources', 'a00_case_graph_lock', '5ac730a63a65321d847862f4b4287ae3'),
  ('trigger', 'public', 'organization_poms_sources', 'z99_case_graph_keys', '055b9ef386d6ddce99629f57f6495f1b'),
  ('trigger', 'public', 'organization_pulse_events', 'a00_case_graph_lock', '164ceeffd80df26ce10f72cf52b2a0ec'),
  ('trigger', 'public', 'organization_pulse_events', 'z99_case_graph_keys', 'a98adf279f699db37aa6fbdb22419e74'),
  ('trigger', 'public', 'organization_pulse_prompts', 'a00_case_graph_lock', '3d9383116a2582730da167383fcc1690'),
  ('trigger', 'public', 'organization_pulse_prompts', 'z99_case_graph_keys', '5908fa6ca82d7ac877a0885df8b875dd'),
  ('trigger', 'public', 'organization_relationships', 'a00_case_graph_lock', '4cbd5b33be70684d10988b28d250483a'),
  ('trigger', 'public', 'organization_relationships', 'z99_case_graph_keys', '84d1e3983943f6cc35927355c890fe7b'),
  ('trigger', 'public', 'organization_retention_policies', 'a00_case_graph_lock', 'a5b8bfa5a20d40217579038b25bb3ffe'),
  ('trigger', 'public', 'organization_retention_policies', 'z99_case_graph_keys', 'f24badfd95e4f1a8c993caff2f7e1534'),
  ('trigger', 'public', 'organization_retention_runs', 'a00_case_graph_lock', '7c6fb1b6fbf6686f4150758ffe8f8b72'),
  ('trigger', 'public', 'organization_retention_runs', 'z99_case_graph_keys', 'ab4c46598565c5668ec1381d449fcbb4'),
  ('trigger', 'public', 'organization_role_grants', 'a00_case_graph_lock', '644f4728f760a235328dcc501d102924'),
  ('trigger', 'public', 'organization_role_grants', 'organization_role_grants_require_active_membership', '6ac3bf07589bbc4919517bb57939a24f'),
  ('trigger', 'public', 'organization_role_grants', 'refresh_dues_financial_identity_on_role_grant', 'a096e64916cdf7b89da66d006b8f4984'),
  ('trigger', 'public', 'organization_role_grants', 'z99_case_graph_keys', 'a5a5f9ccd999409d9bf2cc3a51000331'),
  ('trigger', 'public', 'organization_setting_values', 'a00_case_graph_lock', '638e2780fb1af82960eb764900a15987'),
  ('trigger', 'public', 'organization_setting_values', 'z99_case_graph_keys', '2583ccdf5c67a34c3e29e5f740811272'),
  ('trigger', 'public', 'organization_survey_answers', 'a00_case_graph_lock', '794f418f676deedd360cc32a977da52b'),
  ('trigger', 'public', 'organization_survey_answers', 'organization_survey_answers_org_key', '8b9ce8a27616211688ee81c21ef97471'),
  ('trigger', 'public', 'organization_survey_answers', 'z99_case_graph_keys', '993fdcdcd9e8bfc613be66ad8cc3b6c8'),
  ('trigger', 'public', 'organization_survey_deliveries', 'a00_case_graph_lock', 'e88800ac0c6d94b65a1b763336e8d852'),
  ('trigger', 'public', 'organization_survey_deliveries', 'z99_case_graph_keys', 'b597399657ad6e1d8afbcc2d8702ed6e'),
  ('trigger', 'public', 'organization_survey_questions', 'a00_case_graph_lock', 'd59378961501deb6e0e5f337c79fa8a9'),
  ('trigger', 'public', 'organization_survey_questions', 'organization_survey_questions_org_key', 'c0341f6a238cc8285bf6269af6c5924a'),
  ('trigger', 'public', 'organization_survey_questions', 'z99_case_graph_keys', '5be5a1b4ef94869358bbe7539e946d73'),
  ('trigger', 'public', 'organization_survey_reviews', 'a00_case_graph_lock', 'cb43227b448c8ddf607e860cda565536'),
  ('trigger', 'public', 'organization_survey_reviews', 'z99_case_graph_keys', '3056f4634ecf5cf612821ff1c4578750'),
  ('trigger', 'public', 'organization_survey_sessions', 'a00_case_graph_lock', 'cd7ed9989ed9091678368023dac787dd'),
  ('trigger', 'public', 'organization_survey_sessions', 'organization_survey_sessions_engagement_completion', '6850d7ca036f4fbde03579b8ea824d47'),
  ('trigger', 'public', 'organization_survey_sessions', 'organization_survey_sessions_org_key', 'af52b5d2be8133d75abb406ce4421f89'),
  ('trigger', 'public', 'organization_survey_sessions', 'z99_case_graph_keys', '7f2e0331e2f6999e4edc8bda91699f9c'),
  ('trigger', 'public', 'organization_survey_tasks', 'a00_case_graph_lock', '34a2e60107e22de3825bcdc0d60dd02d'),
  ('trigger', 'public', 'organization_survey_tasks', 'z99_case_graph_keys', '810d48f496a5a9cb64002cab9d93847f'),
  ('trigger', 'public', 'organization_surveys', 'a00_case_graph_lock', 'b853fa1d22bb6199c3bea0094493bb13'),
  ('trigger', 'public', 'organization_surveys', 'organization_surveys_org_key', '23d17deb33487f951a7ab215ab4d854e'),
  ('trigger', 'public', 'organization_surveys', 'z99_case_graph_keys', 'd49f605036b74d73928d9a23ea6bac49'),
  ('trigger', 'public', 'organization_timeline_events', 'a00_case_graph_lock', 'a6b7f5e6ea5cebb61a2d16dbb9873c4f'),
  ('trigger', 'public', 'organization_timeline_events', 'z99_case_graph_keys', 'c5db6648ff11aeb2d2cd5f7fbbae8171'),
  ('trigger', 'public', 'organization_topic_progress', 'a00_case_graph_lock', 'fa68a2b31ab958ae4899a823e963811b'),
  ('trigger', 'public', 'organization_topic_progress', 'z99_case_graph_keys', '8a6f7511200ec7c4c4600f519e53a71b'),
  ('trigger', 'public', 'organization_welcome_campaign_steps', 'a00_case_graph_lock', '8692d54c4f57c0e911bcb0231c537293'),
  ('trigger', 'public', 'organization_welcome_campaign_steps', 'z99_case_graph_keys', 'aa54e67f4ee6bd3fd92a4ca21a85d974'),
  ('trigger', 'public', 'organization_welcome_campaigns', 'a00_case_graph_lock', '2b50b05dacecafd12dfe0271c7d64727'),
  ('trigger', 'public', 'organization_welcome_campaigns', 'z99_case_graph_keys', '3d15059c35c54e938545f49d4d57e4fe'),
  ('trigger', 'public', 'organizations', 'a00_case_graph_lock', 'a2b0088114df5fd0f4052fb05f9f4bc1'),
  ('trigger', 'public', 'organizations', 'z99_case_graph_keys', '40db8f1767c347f7132fae87afb8f149'),
  ('trigger', 'public', 'pay_scale_grades', 'a00_case_graph_lock', '2d01044cc714416ea151956a810d2a1b'),
  ('trigger', 'public', 'pay_scale_grades', 'z99_case_graph_keys', '44889b92a27200724b6e02dac3d80a70'),
  ('trigger', 'public', 'pay_scale_steps', 'a00_case_graph_lock', '409834c72c9a2ca676f3a8ba6ef547b2'),
  ('trigger', 'public', 'pay_scale_steps', 'z99_case_graph_keys', '85b2998f542bd3b237e3f13dee1c5d2a'),
  ('trigger', 'public', 'public_chapter_page_attachments', 'a00_case_graph_lock', '8ea7d1b9efe50fbf10f0f777e42da86d'),
  ('trigger', 'public', 'public_chapter_page_attachments', 'validate_public_chapter_page_attachment', '9c4adf1fe940c7461aafd81e67920092'),
  ('trigger', 'public', 'public_chapter_page_attachments', 'z99_case_graph_keys', 'c8ca376caa3fa88ee93bbfedbadc6075'),
  ('trigger', 'public', 'public_chapter_page_takeovers', 'a00_case_graph_lock', '9a8565e85bd77b683cd7e42c3d9e07f6'),
  ('trigger', 'public', 'public_chapter_page_takeovers', 'z99_case_graph_keys', 'b45a233a4f85ca89fb0ac0634a55bc2b'),
  ('trigger', 'public', 'public_chapter_pages', 'a00_case_graph_lock', '36fe43a19e19a455e01244bc828e4e21'),
  ('trigger', 'public', 'public_chapter_pages', 'public_chapter_pages_touch_updated_at', 'e192636040753eb74cc53af9359123ae'),
  ('trigger', 'public', 'public_chapter_pages', 'public_chapter_pages_validate', '1c8867408409ad3112f708837813f39b'),
  ('trigger', 'public', 'public_chapter_pages', 'z99_case_graph_keys', '9e4fd3ea7429489145a5aa4639e15544'),
  ('trigger', 'public', 'public_chapter_sections', 'a00_case_graph_lock', '2006fdd96a74db4d9688f16835e19119'),
  ('trigger', 'public', 'public_chapter_sections', 'public_chapter_sections_touch_updated_at', 'd43175bf98e2a2d3447d3bd5b7fbd02d'),
  ('trigger', 'public', 'public_chapter_sections', 'public_chapter_sections_validate', 'fd8cef64555d7af607a6e25762a9df09'),
  ('trigger', 'public', 'public_chapter_sections', 'z99_case_graph_keys', 'b4f2fae33d59cfec298d46069cd228f8'),
  ('trigger', 'public', 'public_event_rsvps', 'a00_case_graph_lock', 'a358665b0cce7882976fbade2c511288'),
  ('trigger', 'public', 'public_event_rsvps', 'z99_case_graph_keys', 'c0c9563e1cae94e485a3ffef847463d0'),
  ('trigger', 'public', 'public_site_records', 'a00_case_graph_lock', 'c26a3b05e0e2e1941a49ada0d11d5f10'),
  ('trigger', 'public', 'public_site_records', 'public_site_records_require_organization', 'c23960aeb05f05a531a7c787ded56d6a'),
  ('trigger', 'public', 'public_site_records', 'z99_case_graph_keys', '14fb50aed2f47064d07e6f962bafa0bf'),
  ('trigger', 'public', 'scim_tokens', 'a00_case_graph_lock', 'b8f87df74fd273609e5317f7132c9086'),
  ('trigger', 'public', 'scim_tokens', 'z99_case_graph_keys', 'e6aac449efe4d462b30f51385267bad1'),
  ('trigger', 'public', 'sensitive_case_chunks', 'a00_case_graph_lock', 'aeea048ea475140be1fd4dc0da53bee3'),
  ('trigger', 'public', 'sensitive_case_chunks', 'z99_case_graph_keys', 'c24b540b713deeb3cbbf9ed2cb68ac04'),
  ('trigger', 'public', 'steward_email_intakes', 'a00_case_graph_lock', 'a6fa5a3fec5c0a2322a742c14d2cf58c'),
  ('trigger', 'public', 'steward_email_intakes', 'z99_case_graph_keys', '9f5b74f249475e6247d888897be120eb'),
  ('trigger', 'public', 'weekly_question_selection_policies', 'a00_case_graph_lock', '0edc2609297587d982427f76495504e9'),
  ('trigger', 'public', 'weekly_question_selection_policies', 'z99_case_graph_keys', 'e0693c32e0abce6926bb7c1361e64f92'),
  ('function', 'private', '', 'chapter_post_edit_contract_active()', '4dce424d741f4cfb19967161502e5538'),
  ('function', 'private', '', 'guard_chapter_post_body_mutation()', '69c922ecd3df2eff01e458e043d3592a'),
  ('function', 'private', '', 'guard_held_message_derivative()', 'c8d95eda2c0d840fd6753f7714a0872a'),
  ('function', 'private', '', 'guard_member_message_destruction()', '2ae2bd52d5081beccc50d63323897384'),
  ('function', 'private', '', 'invalidate_message_briefings()', 'eeafb36b843075a81f2808d43898a85f'),
  ('function', 'private', '', 'knowledge_conversion_is_append_only()', 'f3ff882f1f0396eef2b122f820fae986'),
  ('function', 'private', '', 'lock_member_message_conversation(p_conversation_id uuid)', 'b50d8b3d82df84923ba38e2e7e6a7bb9'),
  ('function', 'private', '', 'lock_member_message_hold()', '68c03340c03798fda92d21cae2f9486e'),
  ('function', 'private', '', 'lock_message_lifecycle_statement()', 'b4569b6997a80d5f6686a60134006d0f'),
  ('function', 'private', '', 'lock_message_lifecycle()', '64d533151735e312dc3c36a53919c85c'),
  ('function', 'private', '', 'member_message_under_legal_hold(p_conversation_id uuid)', 'db6a0302d956b0cb3725ad0fe4b5c262'),
  ('function', 'private', '', 'preserve_member_messages_on_account_delete()', '589530de6166e4b46dc36ec8fc9d2a71'),
  ('function', 'private', '', 'redact_member_message_row(p_message_id uuid, p_reason text, p_actor uuid)', '62378089225a3b0dc2a53db673ae9656'),
  ('function', 'private', '', 'redact_member_scheduled_message_row(p_scheduled_id uuid)', 'fc79dd7339a53e87d8e2417963aa5504'),
  ('function', 'private', '', 'stamp_message_action_identity()', '24394c24e684f26e83b8f944082af686'),
  ('function', 'private', '', 'validate_message_reply_parent()', '8ac6b5314dd455f185351215cb0396cd'),
  ('trigger', 'auth', 'users', 'message_lifecycle_statement', '49cd36669817f3bd7a6e0bee595e0d1f'),
  ('trigger', 'auth', 'users', 'preserve_member_messages_before_account_delete', 'cbafa8c742da8c86327321954c06b9fb'),
  ('trigger', 'private', 'demo_seed_function_catalog', 'message_lifecycle_statement', 'c931dd6cc96981ebe494c54fc761d4f8'),
  ('trigger', 'private', 'demo_seed_function_evidence', 'message_lifecycle_statement', '935945778430f1b26b7aec5b0c29ba38'),
  ('trigger', 'private', 'demo_seed_page_contract', 'message_lifecycle_statement', '4ea7f84d7d2be012b1fcbef7b4b85026'),
  ('trigger', 'private', 'demo_seed_page_evidence', 'message_lifecycle_statement', '3cb00870d58cfe395d04793f3fa64da7'),
  ('trigger', 'private', 'presg_demo_runs', 'message_lifecycle_statement', 'e5287812420a932045e95f4ceb8724fb'),
  ('trigger', 'private', 'uniondemo_runs', 'message_lifecycle_statement', 'd2e2b71990ad2a7b9de9cc824788a0d1'),
  ('trigger', 'public', 'chapter_documents', 'message_lifecycle_statement', 'c54ccf40ba183f131913fc518ce30928'),
  ('trigger', 'public', 'chapter_spaces', 'message_lifecycle_statement', 'fec3596c6c3af8ce0e5eff3bdab39713'),
  ('trigger', 'public', 'chapter_task_messages', 'invalidate_message_briefings', '391eccba6955dbc13fc744d74c09c18b'),
  ('trigger', 'public', 'chapter_task_messages', 'message_lifecycle_statement', '2e90c6debd1793f43592d8e2f84c1b7c'),
  ('trigger', 'public', 'chapter_tasks', 'message_lifecycle_statement', '05aa678880515396f1e5a41b9a1f8c99'),
  ('trigger', 'public', 'chapter_thread_posts', 'chapter_thread_posts_guard_body_mutation', 'aa0f965e317f2cd5063f7d3821f34a38'),
  ('trigger', 'public', 'chapter_thread_posts', 'chapter_thread_posts_validate_reply', 'a1430e3defa7ab12a9bbcb1d71ae1745'),
  ('trigger', 'public', 'chapter_thread_posts', 'invalidate_message_briefings', 'fcb11ef3b9c0392fdc01b1810bfe929f'),
  ('trigger', 'public', 'chapter_thread_posts', 'message_lifecycle_statement', 'fac06f0b84011841cf3f560771304d80'),
  ('trigger', 'public', 'chapter_threads', 'message_lifecycle_statement', '13a5eba65c8fae31750e70d1e453eeaf'),
  ('trigger', 'public', 'chapters', 'message_lifecycle_statement', '566143d0b928138e679c2d96d5d7440a'),
  ('trigger', 'public', 'compass_message_briefings', 'guard_held_message_derivative', 'fd2275e16cd929a9070a0ea0c4110ae2'),
  ('trigger', 'public', 'compass_message_briefings', 'message_lifecycle_statement', '898c9d8332597539af08137b9bebbb6c'),
  ('trigger', 'public', 'compass_workspace_actions', 'guard_held_message_derivative', '94815e3e273bff3d0e08a93a9590f4d9'),
  ('trigger', 'public', 'compass_workspace_actions', 'message_lifecycle_statement', 'b232a8d82f523b18840c8eba1a465d41'),
  ('trigger', 'public', 'member_cases', 'message_lifecycle_statement', '1fa3f199a554bf546f8b34cd60466698'),
  ('trigger', 'public', 'member_conversations', 'member_conversations_guard_delete', 'df5c040416592103b12ba261db4d3168'),
  ('trigger', 'public', 'member_conversations', 'message_lifecycle_statement', '0002dc9feaff8d2fb5743ee60d8cbfd9'),
  ('trigger', 'public', 'member_message_legal_holds', 'a00_case_graph_lock', 'd30d7404acd7eab3f7f12c3ba98e9712'),
  ('trigger', 'public', 'member_message_legal_holds', 'member_message_holds_lock', 'b56806426b12b5bf3995f288b3554789'),
  ('trigger', 'public', 'member_message_legal_holds', 'message_lifecycle_statement', '0a8bb8e0803baeb80dd434abbd8a37ce'),
  ('trigger', 'public', 'member_message_legal_holds', 'z99_case_graph_keys', '7d59ce17e1f8339c8dd6cfe155e2fdb4'),
  ('trigger', 'public', 'member_message_reactions', 'message_lifecycle_statement', '07b0f992d5f2283dc7c0fd622c91acfe'),
  ('trigger', 'public', 'member_message_reminders', 'message_lifecycle_statement', 'e9ee9b254a2e000b8bfa21fe539108f2'),
  ('trigger', 'public', 'member_message_resources', 'message_lifecycle_statement', 'df267d0273ccf1795734d2be803265a2'),
  ('trigger', 'public', 'member_messages', 'invalidate_message_briefings', 'e43b61dfffc174591c0cbaa593975228'),
  ('trigger', 'public', 'member_messages', 'member_messages_guard_body', 'f7d2ee1c7e2c2274d27c2f06b2e54699'),
  ('trigger', 'public', 'member_messages', 'member_messages_guard_delete', '3ab1f3da7e45e745ca24669c7a5adb83'),
  ('trigger', 'public', 'member_messages', 'member_messages_stamp_action_identity', '6b21f0fd3bf84943d73fbe588456bbd8'),
  ('trigger', 'public', 'member_messages', 'member_messages_validate_reply', 'a9de74d4ac8deed67a2e64b5616e248f'),
  ('trigger', 'public', 'member_messages', 'message_lifecycle_statement', '4b1bb146e285b7339746fb08ea0f4039'),
  ('trigger', 'public', 'member_profiles', 'message_lifecycle_statement', 'ae35bfe2da8aa6bae40ed563b5957fd2'),
  ('trigger', 'public', 'member_saved_messages', 'message_lifecycle_statement', 'c7113ccc8709dc7a5cdcabc5e8f41398'),
  ('trigger', 'public', 'member_scheduled_messages', 'member_scheduled_messages_guard_body', '54a1e307d7055ef6c5b56080b07b8afc'),
  ('trigger', 'public', 'member_scheduled_messages', 'member_scheduled_messages_guard_delete', '60b38bbfa4aedb09098c5548d1cf747a'),
  ('trigger', 'public', 'member_scheduled_messages', 'message_lifecycle_statement', '21173c1474e93be930892ec4f6abb3db'),
  ('trigger', 'public', 'organization_knowledge_conversions', 'a00_case_graph_lock', '01f03b362f48453eff6fc9c7fe045953'),
  ('trigger', 'public', 'organization_knowledge_conversions', 'organization_knowledge_conversions_append_only', 'b12ea2d18e62357e06802bd4581fac83'),
  ('trigger', 'public', 'organization_knowledge_conversions', 'z99_case_graph_keys', '8042b5c5ddc4f7a8c59535e887cc6f16'),
  ('trigger', 'public', 'organizations', 'message_lifecycle_statement', 'abdfae6a8cdeccbf4119c6374a8726da');


create function private.account_lifecycle_referential_action_trigger_issues()
returns table (schema_name text, table_name text, trigger_name text, inventory_issue text)
language sql stable security definer set search_path = '' as $function$
  select coalesce(c.schema_name,r.schema_name), coalesce(c.table_name,r.table_name),
    coalesce(c.object_name,r.object_name), 'unreviewed-referential-action-trigger'::text
  from private.account_lifecycle_trigger_surface() c
  full join private.account_lifecycle_trigger_review r
    on r.kind=c.kind and r.schema_name=c.schema_name and r.table_name=c.table_name and r.object_name=c.object_name
  where c.definition_hash is distinct from r.definition_hash;
$function$;
revoke all on function private.account_lifecycle_referential_action_trigger_issues() from public, anon, authenticated, service_role;
grant execute on function private.account_lifecycle_referential_action_trigger_issues() to service_role;

commit;
