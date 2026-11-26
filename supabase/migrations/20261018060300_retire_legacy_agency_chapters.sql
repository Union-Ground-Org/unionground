-- OPS-UG-LEGACY-AGENCY-CHAPTER-REMOVAL-20261015
-- Union Ground adaptation of the upstream retirement: all 129 incoming FK
-- shapes are reviewed, including fourteen additional organizing-table
-- references. It runs at the upstream version so later migrations see the
-- legacy chapters retired; 20261019224500 is its history alias.
-- Forward-only retirement. The July seed migrations and the October 15
-- operator receipts remain immutable. Never infer a target from its name.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $retire$
declare
  chapter_ids constant text[] := array[
    'wor','bos','spr','law','nbd','dds-hyn','dds-pit',
    'dcf-bos','dcf-wor','dcf-spr','dcf-law','dcf-brk','dcf-hol',
    'dta-bos','dta-spr','dta-wor','dta-fal','dta-lyn',
    'dmh-bos','dmh-wor','dmh-tau','dmh-nth',
    'mrc-bos','mrc-wor','mrc-spr','dph-bos','dph-tew','dys-bos','dys-wor'
  ];
  event_ids constant text[] := array[
    'evt-2026-chapter-meeting','evt-2026-steward-training',
    'evt-2026-office-hours','evt-2026-relief-rally','evt-2026-ratification-call',
    'evt-2025-fall-assembly','evt-2025-caseload-forum',
    'evt-2026-winter-training','evt-2026-lobby-day'
  ];
begin
  -- Block concurrent reseeding and FK attachment until all preflights and
  -- deletion finish. PostgreSQL's FK parent locks conflict with these locks.
  lock table public.chapters, public.member_events,
    public.chapter_workstreams, private.member_stress_chapter_plan
    in share row exclusive mode;
  perform 1 from public.chapters where id = any(chapter_ids) for update;
  perform 1 from public.member_events where chapter_id = any(chapter_ids) for update;
  perform 1 from public.chapter_workstreams where chapter_id = any(chapter_ids) for update;
  perform 1 from private.member_stress_chapter_plan where chapter_id = any(chapter_ids) for update;

  if exists (select 1 from public.chapters
             where id = any(chapter_ids) and organization_id is not null) then
    raise exception 'legacy chapter retirement refused: target belongs to an organization';
  end if;
  if exists (select 1 from public.member_events
             where chapter_id = any(chapter_ids)
               and (not (id = any(event_ids)) or organizer_id is not null)) then
    raise exception 'legacy chapter retirement refused: non-seed event';
  end if;
  if exists (select 1 from public.chapter_workstreams
             where chapter_id = any(chapter_ids)
               and (name <> 'General' or created_by is not null)) then
    raise exception 'legacy chapter retirement refused: non-seed workstream';
  end if;

  -- Fail closed on new or changed FK shapes. Every data probe below is
  -- static SQL so provenance analysis can inspect the complete migration.
  if exists (
    select 1 from pg_catalog.pg_constraint c
    where c.contype = 'f'
      and c.confrelid in ('public.chapters'::regclass, 'public.member_events'::regclass,
                         'public.chapter_workstreams'::regclass,
                         'private.member_stress_chapter_plan'::regclass)
      and not exists (
        select 1 from (values
      ('public.coalition_handshakes', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.coalition_partners', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_capacity_commitments', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_learning_assignments', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_learning_sessions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_membership_periods', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_onboarding_steps', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_participation_completions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_participation_events', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_recognition_events', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organizing_campaigns', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.union_employers', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.union_lifecycle_audit_events', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.union_worksites', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.chapter_connection_aggregate_runs', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.chapter_connection_hides', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.chapter_connection_hides', array['hidden_chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.chapter_connection_profiles', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.chapter_connection_source_tags', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.chapter_task_number_counters', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.compass_chapter_scope_bindings', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.learning_content', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.learning_policies', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.meeting_minutes_event_notices', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.member_password_reissues', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.member_signin_recoveries', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.member_stress_chapter_plan', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('private.task_checkoff_lists', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_access_grants', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_alerts', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_audit_events', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_bargaining_workspaces', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_checklist_templates', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_checklists', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_deadlines', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_entity_links', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_intake_drafts', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_macros', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_management_entries', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_management_people', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_procedures', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_reminders', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_retaliation_flags', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_retaliation_patterns', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_retaliation_reports', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_step_transitions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.casework_strength_analyses', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_channel_polls', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_connection_readiness', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_contact_log', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_contact_log_versions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_documents', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_governance_requests', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_handshake_events', array['actor_chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_handshakes', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_handshakes', array['receiving_chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_health_coaching', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_health_snapshots', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_integration_overrides', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_leadership_claims', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_record_versions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_records', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_spaces', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_activity', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_assignments', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_attachments', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_comments', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_dependencies', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_files', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_messages', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_subtasks', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_template_details', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_task_watchers', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_tasks', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_thread_posts', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_threads', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_union_org_bindings', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.chapter_workstreams', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.digital_actions', array['organization_id','chapter_id']::text[], 'public.chapters', array['organization_id','id']::text[]),
      ('public.dues_assessment_batches', array['organization_id','chapter_id']::text[], 'public.chapters', array['organization_id','id']::text[]),
      ('public.dues_obligations', array['organization_id','chapter_id']::text[], 'public.chapters', array['organization_id','id']::text[]),
      ('public.integration_jobs', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.knowledge_collections', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.meeting_attendance', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.meeting_minutes_dispatches', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_appointments', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_ballots', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_broadcasts', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_cases', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_chapter_memberships', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_contact_notes', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_events', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_handoffs', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_intake_reports', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_invitation_audit', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_invitations', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_kb_article_revisions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_kb_articles', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_peer_contact_requests', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_peer_conversations', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_profiles', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_qa_questions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_role_chapters', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_roles', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_steward_relationships', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_surveys', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_weekly_question_promotions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.member_weekly_questions', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_analytics_layouts', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_automation_effects', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_automation_routing_rules', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_chart_nodes', array['organization_id','chapter_id']::text[], 'public.chapters', array['organization_id','id']::text[]),
      ('public.organization_coordination_records', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_engagement_events', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_knowledge_files', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_live_polls', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_pulse_prompts', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_surveys', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.organization_timeline_events', array['organization_id','chapter_id']::text[], 'public.chapters', array['organization_id','id']::text[]),
      ('public.steward_email_intakes', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.weekly_question_selection_policies', array['chapter_id']::text[], 'public.chapters', array['id']::text[]),
      ('public.weekly_question_selection_policies', array['chapter_id','organization_id']::text[], 'public.chapters', array['id','organization_id']::text[]),
      ('private.meeting_minutes_event_notices', array['event_id']::text[], 'public.member_events', array['id']::text[]),
      ('private.member_event_checkin_attempts', array['event_id']::text[], 'public.member_events', array['id']::text[]),
      ('private.member_event_checkin_tokens', array['event_id']::text[], 'public.member_events', array['id']::text[]),
      ('private.member_event_contact_links', array['event_id']::text[], 'public.member_events', array['id']::text[]),
      ('private.member_event_contact_opt_ins', array['event_id']::text[], 'public.member_events', array['id']::text[]),
      ('public.member_event_checkins', array['event_id']::text[], 'public.member_events', array['id']::text[]),
      ('public.member_event_rsvps', array['event_id']::text[], 'public.member_events', array['id']::text[])
        ) known(child, child_columns, parent, parent_columns)
        where c.conrelid = pg_catalog.to_regclass(known.child)
          and c.confrelid = pg_catalog.to_regclass(known.parent)
          and array(select a.attname::text from unnest(c.conkey) with ordinality k(attnum, n)
                    join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
                    order by k.n) = known.child_columns
          and array(select a.attname::text from unnest(c.confkey) with ordinality k(attnum, n)
                    join pg_catalog.pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum
                    order by k.n) = known.parent_columns
      )
  ) then
    raise exception 'legacy chapter retirement refused: unrecognized foreign key';
  end if;

  -- Union Ground lifecycle, participation, learning and coalition references.
  if exists (select 1 from public.coalition_handshakes where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.coalition_handshakes';
  end if;
  if exists (select 1 from public.coalition_partners where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.coalition_partners';
  end if;
  if exists (select 1 from public.member_capacity_commitments where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_capacity_commitments';
  end if;
  if exists (select 1 from public.member_learning_assignments where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_learning_assignments';
  end if;
  if exists (select 1 from public.member_learning_sessions where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_learning_sessions';
  end if;
  if exists (select 1 from public.member_membership_periods where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_membership_periods';
  end if;
  if exists (select 1 from public.member_onboarding_steps where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_onboarding_steps';
  end if;
  if exists (select 1 from public.member_participation_completions where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_participation_completions';
  end if;
  if exists (select 1 from public.member_participation_events where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_participation_events';
  end if;
  if exists (select 1 from public.member_recognition_events where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.member_recognition_events';
  end if;
  if exists (select 1 from public.organizing_campaigns where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.organizing_campaigns';
  end if;
  if exists (select 1 from public.union_employers where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.union_employers';
  end if;
  if exists (select 1 from public.union_lifecycle_audit_events where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.union_lifecycle_audit_events';
  end if;
  if exists (select 1 from public.union_worksites where chapter_id = any(chapter_ids)) then
    raise exception 'legacy chapter retirement refused: attached rows in public.union_worksites';
  end if;

  if pg_catalog.to_regclass('private.chapter_connection_aggregate_runs') is not null then
    if exists (select 1 from private.chapter_connection_aggregate_runs where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.chapter_connection_aggregate_runs';
    end if;
  end if;
  if pg_catalog.to_regclass('private.chapter_connection_hides') is not null then
    if exists (select 1 from private.chapter_connection_hides where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.chapter_connection_hides';
    end if;
  end if;
  if pg_catalog.to_regclass('private.chapter_connection_hides') is not null then
    if exists (select 1 from private.chapter_connection_hides where hidden_chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.chapter_connection_hides';
    end if;
  end if;
  if pg_catalog.to_regclass('private.chapter_connection_profiles') is not null then
    if exists (select 1 from private.chapter_connection_profiles where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.chapter_connection_profiles';
    end if;
  end if;
  if pg_catalog.to_regclass('private.chapter_connection_source_tags') is not null then
    if exists (select 1 from private.chapter_connection_source_tags where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.chapter_connection_source_tags';
    end if;
  end if;
  if pg_catalog.to_regclass('private.chapter_task_number_counters') is not null then
    if exists (select 1 from private.chapter_task_number_counters where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.chapter_task_number_counters';
    end if;
  end if;
  if pg_catalog.to_regclass('private.compass_chapter_scope_bindings') is not null then
    if exists (select 1 from private.compass_chapter_scope_bindings where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.compass_chapter_scope_bindings';
    end if;
  end if;
  if pg_catalog.to_regclass('private.learning_content') is not null then
    if exists (select 1 from private.learning_content where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.learning_content';
    end if;
  end if;
  if pg_catalog.to_regclass('private.learning_policies') is not null then
    if exists (select 1 from private.learning_policies where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.learning_policies';
    end if;
  end if;
  if pg_catalog.to_regclass('private.meeting_minutes_event_notices') is not null then
    if exists (select 1 from private.meeting_minutes_event_notices where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.meeting_minutes_event_notices';
    end if;
  end if;
  if pg_catalog.to_regclass('private.member_password_reissues') is not null then
    if exists (select 1 from private.member_password_reissues where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.member_password_reissues';
    end if;
  end if;
  if pg_catalog.to_regclass('private.member_signin_recoveries') is not null then
    if exists (select 1 from private.member_signin_recoveries where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.member_signin_recoveries';
    end if;
  end if;
  if pg_catalog.to_regclass('private.task_checkoff_lists') is not null then
    if exists (select 1 from private.task_checkoff_lists where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in private.task_checkoff_lists';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_access_grants') is not null then
    if exists (select 1 from public.casework_access_grants where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_access_grants';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_alerts') is not null then
    if exists (select 1 from public.casework_alerts where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_alerts';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_audit_events') is not null then
    if exists (select 1 from public.casework_audit_events where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_audit_events';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_bargaining_workspaces') is not null then
    if exists (select 1 from public.casework_bargaining_workspaces where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_bargaining_workspaces';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_checklist_templates') is not null then
    if exists (select 1 from public.casework_checklist_templates where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_checklist_templates';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_checklists') is not null then
    if exists (select 1 from public.casework_checklists where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_checklists';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_deadlines') is not null then
    if exists (select 1 from public.casework_deadlines where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_deadlines';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_entity_links') is not null then
    if exists (select 1 from public.casework_entity_links where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_entity_links';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_intake_drafts') is not null then
    if exists (select 1 from public.casework_intake_drafts where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_intake_drafts';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_macros') is not null then
    if exists (select 1 from public.casework_macros where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_macros';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_management_entries') is not null then
    if exists (select 1 from public.casework_management_entries where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_management_entries';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_management_people') is not null then
    if exists (select 1 from public.casework_management_people where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_management_people';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_procedures') is not null then
    if exists (select 1 from public.casework_procedures where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_procedures';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_reminders') is not null then
    if exists (select 1 from public.casework_reminders where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_reminders';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_retaliation_flags') is not null then
    if exists (select 1 from public.casework_retaliation_flags where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_retaliation_flags';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_retaliation_patterns') is not null then
    if exists (select 1 from public.casework_retaliation_patterns where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_retaliation_patterns';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_retaliation_reports') is not null then
    if exists (select 1 from public.casework_retaliation_reports where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_retaliation_reports';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_step_transitions') is not null then
    if exists (select 1 from public.casework_step_transitions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_step_transitions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.casework_strength_analyses') is not null then
    if exists (select 1 from public.casework_strength_analyses where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.casework_strength_analyses';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_channel_polls') is not null then
    if exists (select 1 from public.chapter_channel_polls where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_channel_polls';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_connection_readiness') is not null then
    if exists (select 1 from public.chapter_connection_readiness where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_connection_readiness';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_contact_log') is not null then
    if exists (select 1 from public.chapter_contact_log where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_contact_log';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_contact_log_versions') is not null then
    if exists (select 1 from public.chapter_contact_log_versions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_contact_log_versions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_documents') is not null then
    if exists (select 1 from public.chapter_documents where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_documents';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_governance_requests') is not null then
    if exists (select 1 from public.chapter_governance_requests where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_governance_requests';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_handshake_events') is not null then
    if exists (select 1 from public.chapter_handshake_events where actor_chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_handshake_events';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_handshakes') is not null then
    if exists (select 1 from public.chapter_handshakes where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_handshakes';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_handshakes') is not null then
    if exists (select 1 from public.chapter_handshakes where receiving_chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_handshakes';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_health_coaching') is not null then
    if exists (select 1 from public.chapter_health_coaching where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_health_coaching';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_health_snapshots') is not null then
    if exists (select 1 from public.chapter_health_snapshots where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_health_snapshots';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_integration_overrides') is not null then
    if exists (select 1 from public.chapter_integration_overrides where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_integration_overrides';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_leadership_claims') is not null then
    if exists (select 1 from public.chapter_leadership_claims where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_leadership_claims';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_record_versions') is not null then
    if exists (select 1 from public.chapter_record_versions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_record_versions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_records') is not null then
    if exists (select 1 from public.chapter_records where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_records';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_spaces') is not null then
    if exists (select 1 from public.chapter_spaces where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_spaces';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_activity') is not null then
    if exists (select 1 from public.chapter_task_activity where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_activity';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_assignments') is not null then
    if exists (select 1 from public.chapter_task_assignments where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_assignments';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_attachments') is not null then
    if exists (select 1 from public.chapter_task_attachments where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_attachments';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_comments') is not null then
    if exists (select 1 from public.chapter_task_comments where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_comments';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_dependencies') is not null then
    if exists (select 1 from public.chapter_task_dependencies where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_dependencies';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_files') is not null then
    if exists (select 1 from public.chapter_task_files where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_files';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_messages') is not null then
    if exists (select 1 from public.chapter_task_messages where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_messages';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_subtasks') is not null then
    if exists (select 1 from public.chapter_task_subtasks where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_subtasks';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_template_details') is not null then
    if exists (select 1 from public.chapter_task_template_details where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_template_details';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_task_watchers') is not null then
    if exists (select 1 from public.chapter_task_watchers where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_task_watchers';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_tasks') is not null then
    if exists (select 1 from public.chapter_tasks where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_tasks';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_thread_posts') is not null then
    if exists (select 1 from public.chapter_thread_posts where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_thread_posts';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_threads') is not null then
    if exists (select 1 from public.chapter_threads where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_threads';
    end if;
  end if;
  if pg_catalog.to_regclass('public.chapter_union_org_bindings') is not null then
    if exists (select 1 from public.chapter_union_org_bindings where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.chapter_union_org_bindings';
    end if;
  end if;
  if pg_catalog.to_regclass('public.digital_actions') is not null then
    if exists (select 1 from public.digital_actions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.digital_actions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.dues_assessment_batches') is not null then
    if exists (select 1 from public.dues_assessment_batches where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.dues_assessment_batches';
    end if;
  end if;
  if pg_catalog.to_regclass('public.dues_obligations') is not null then
    if exists (select 1 from public.dues_obligations where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.dues_obligations';
    end if;
  end if;
  if pg_catalog.to_regclass('public.integration_jobs') is not null then
    if exists (select 1 from public.integration_jobs where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.integration_jobs';
    end if;
  end if;
  if pg_catalog.to_regclass('public.knowledge_collections') is not null then
    if exists (select 1 from public.knowledge_collections where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.knowledge_collections';
    end if;
  end if;
  if pg_catalog.to_regclass('public.meeting_attendance') is not null then
    if exists (select 1 from public.meeting_attendance where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.meeting_attendance';
    end if;
  end if;
  if pg_catalog.to_regclass('public.meeting_minutes_dispatches') is not null then
    if exists (select 1 from public.meeting_minutes_dispatches where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.meeting_minutes_dispatches';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_appointments') is not null then
    if exists (select 1 from public.member_appointments where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_appointments';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_ballots') is not null then
    if exists (select 1 from public.member_ballots where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_ballots';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_broadcasts') is not null then
    if exists (select 1 from public.member_broadcasts where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_broadcasts';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_cases') is not null then
    if exists (select 1 from public.member_cases where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_cases';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_chapter_memberships') is not null then
    if exists (select 1 from public.member_chapter_memberships where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_chapter_memberships';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_contact_notes') is not null then
    if exists (select 1 from public.member_contact_notes where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_contact_notes';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_handoffs') is not null then
    if exists (select 1 from public.member_handoffs where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_handoffs';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_intake_reports') is not null then
    if exists (select 1 from public.member_intake_reports where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_intake_reports';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_invitation_audit') is not null then
    if exists (select 1 from public.member_invitation_audit where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_invitation_audit';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_invitations') is not null then
    if exists (select 1 from public.member_invitations where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_invitations';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_kb_article_revisions') is not null then
    if exists (select 1 from public.member_kb_article_revisions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_kb_article_revisions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_kb_articles') is not null then
    if exists (select 1 from public.member_kb_articles where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_kb_articles';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_peer_contact_requests') is not null then
    if exists (select 1 from public.member_peer_contact_requests where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_peer_contact_requests';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_peer_conversations') is not null then
    if exists (select 1 from public.member_peer_conversations where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_peer_conversations';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_profiles') is not null then
    if exists (select 1 from public.member_profiles where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_profiles';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_qa_questions') is not null then
    if exists (select 1 from public.member_qa_questions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_qa_questions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_role_chapters') is not null then
    if exists (select 1 from public.member_role_chapters where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_role_chapters';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_roles') is not null then
    if exists (select 1 from public.member_roles where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_roles';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_steward_relationships') is not null then
    if exists (select 1 from public.member_steward_relationships where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_steward_relationships';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_surveys') is not null then
    if exists (select 1 from public.member_surveys where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_surveys';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_weekly_question_promotions') is not null then
    if exists (select 1 from public.member_weekly_question_promotions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_weekly_question_promotions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_weekly_questions') is not null then
    if exists (select 1 from public.member_weekly_questions where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.member_weekly_questions';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_analytics_layouts') is not null then
    if exists (select 1 from public.organization_analytics_layouts where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_analytics_layouts';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_automation_effects') is not null then
    if exists (select 1 from public.organization_automation_effects where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_automation_effects';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_automation_routing_rules') is not null then
    if exists (select 1 from public.organization_automation_routing_rules where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_automation_routing_rules';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_chart_nodes') is not null then
    if exists (select 1 from public.organization_chart_nodes where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_chart_nodes';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_coordination_records') is not null then
    if exists (select 1 from public.organization_coordination_records where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_coordination_records';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_engagement_events') is not null then
    if exists (select 1 from public.organization_engagement_events where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_engagement_events';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_knowledge_files') is not null then
    if exists (select 1 from public.organization_knowledge_files where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_knowledge_files';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_live_polls') is not null then
    if exists (select 1 from public.organization_live_polls where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_live_polls';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_pulse_prompts') is not null then
    if exists (select 1 from public.organization_pulse_prompts where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_pulse_prompts';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_surveys') is not null then
    if exists (select 1 from public.organization_surveys where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_surveys';
    end if;
  end if;
  if pg_catalog.to_regclass('public.organization_timeline_events') is not null then
    if exists (select 1 from public.organization_timeline_events where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.organization_timeline_events';
    end if;
  end if;
  if pg_catalog.to_regclass('public.steward_email_intakes') is not null then
    if exists (select 1 from public.steward_email_intakes where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.steward_email_intakes';
    end if;
  end if;
  if pg_catalog.to_regclass('public.weekly_question_selection_policies') is not null then
    if exists (select 1 from public.weekly_question_selection_policies where chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: attached rows in public.weekly_question_selection_policies';
    end if;
  end if;
  if pg_catalog.to_regclass('private.meeting_minutes_event_notices') is not null then
    if exists (select 1 from private.meeting_minutes_event_notices child join public.member_events parent on child.event_id = parent.id where parent.chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: seed descendants in private.meeting_minutes_event_notices';
    end if;
  end if;
  if pg_catalog.to_regclass('private.member_event_checkin_attempts') is not null then
    if exists (select 1 from private.member_event_checkin_attempts child join public.member_events parent on child.event_id = parent.id where parent.chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: seed descendants in private.member_event_checkin_attempts';
    end if;
  end if;
  if pg_catalog.to_regclass('private.member_event_checkin_tokens') is not null then
    if exists (select 1 from private.member_event_checkin_tokens child join public.member_events parent on child.event_id = parent.id where parent.chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: seed descendants in private.member_event_checkin_tokens';
    end if;
  end if;
  if pg_catalog.to_regclass('private.member_event_contact_links') is not null then
    if exists (select 1 from private.member_event_contact_links child join public.member_events parent on child.event_id = parent.id where parent.chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: seed descendants in private.member_event_contact_links';
    end if;
  end if;
  if pg_catalog.to_regclass('private.member_event_contact_opt_ins') is not null then
    if exists (select 1 from private.member_event_contact_opt_ins child join public.member_events parent on child.event_id = parent.id where parent.chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: seed descendants in private.member_event_contact_opt_ins';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_event_checkins') is not null then
    if exists (select 1 from public.member_event_checkins child join public.member_events parent on child.event_id = parent.id where parent.chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: seed descendants in public.member_event_checkins';
    end if;
  end if;
  if pg_catalog.to_regclass('public.member_event_rsvps') is not null then
    if exists (select 1 from public.member_event_rsvps child join public.member_events parent on child.event_id = parent.id where parent.chapter_id = any(chapter_ids)) then
      raise exception 'legacy chapter retirement refused: seed descendants in public.member_event_rsvps';
    end if;
  end if;

  delete from private.member_stress_chapter_plan where chapter_id = any(chapter_ids);
  delete from public.member_events where chapter_id = any(chapter_ids) and id = any(event_ids);
  delete from public.chapter_workstreams
    where chapter_id = any(chapter_ids) and name = 'General' and created_by is null;
  delete from public.chapters where id = any(chapter_ids) and organization_id is null;
end;
$retire$;

-- The foundation migration also left a column default pointing at wor.
-- New profiles must remain chapterless until explicitly provisioned.
do $default$
begin
  if exists (
    select 1 from pg_catalog.pg_attrdef d
    join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
    where d.adrelid = 'public.member_profiles'::regclass and a.attname = 'chapter_id'
      and pg_catalog.pg_get_expr(d.adbin, d.adrelid) = '''wor''::text'
  ) then
    alter table public.member_profiles alter column chapter_id drop default;
  end if;
end;
$default$;

-- A database constraint guards every seed caller, even service-role inserts,
-- COPY, upserts and chapter-id renames. It adds no callable definer function.
-- Reapplying the migration is safe and never changes unrelated chapters.
alter table public.chapters drop constraint if exists chapters_legacy_agency_ids_retired;
alter table public.chapters add constraint chapters_legacy_agency_ids_retired
  check (id <> all(array[
    'wor','bos','spr','law','nbd','dds-hyn','dds-pit',
    'dcf-bos','dcf-wor','dcf-spr','dcf-law','dcf-brk','dcf-hol',
    'dta-bos','dta-spr','dta-wor','dta-fal','dta-lyn',
    'dmh-bos','dmh-wor','dmh-tau','dmh-nth',
    'mrc-bos','mrc-wor','mrc-spr','dph-bos','dph-tew','dys-bos','dys-wor'
  ]::text[]));
commit;
