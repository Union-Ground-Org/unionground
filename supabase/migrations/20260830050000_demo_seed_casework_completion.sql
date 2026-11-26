-- SAMPLE-only casework parity repair for CR-020 through CR-034.
--
-- The casework schema landed after the original 114-function parity catalog.
-- This append-only repair promotes the stale gates and attaches deterministic,
-- reversible feature rows to both already-authorized demo lanes. The migration
-- itself writes no tenant, identity, credential, notification, or delivery.

set local lock_timeout = '5s';

do $catalog$
declare
  updated_count integer;
begin
  update private.demo_seed_function_catalog catalog
  set coverage = 'seeded',
      evidence_key = evidence.evidence_key,
      gate_relation = null
  from (values
    ('CR-020', 'casework-strength-analysis'),
    ('CR-021', 'casework-bargaining-proposals'),
    ('CR-022', 'casework-bargaining-live'),
    ('CR-023', 'casework-deadline-center'),
    ('CR-024', 'casework-structured-checklists'),
    ('CR-025', 'casework-step-progression'),
    ('CR-026', 'casework-restricted-access'),
    ('CR-027', 'casework-alert-escalation'),
    ('CR-028', 'casework-management-behavior'),
    ('CR-029', 'casework-retaliation-reports'),
    ('CR-030', 'casework-retaliation-patterns'),
    ('CR-031', 'casework-intake-drafts'),
    ('CR-032', 'casework-history-bulk-operations'),
    ('CR-033', 'casework-entity-graph'),
    ('CR-034', 'casework-reminders')
  ) as evidence(function_id, evidence_key)
  where catalog.function_id = evidence.function_id;
  get diagnostics updated_count = row_count;
  if updated_count <> 15 then
    raise exception 'casework catalog repair expected 15 rows, updated %', updated_count;
  end if;
end;
$catalog$;

insert into private.demo_seed_page_contract
  (surface, page_size, minimum_rows, scope, source)
values
  ('caseworkHistory', 50, 100, 'featured-steward', 'src/lib/caseworkApi.js:323')
on conflict (surface) do update
set page_size = excluded.page_size,
    minimum_rows = excluded.minimum_rows,
    scope = excluded.scope,
    source = excluded.source;

-- SAMPLE seed composition is an administrator-authorized lifecycle, but the
-- normal restriction trigger still (correctly) requires a real MFA factor for
-- staff writes. Permit only the transaction-local service-role seed run and
-- only for one of that run's deterministic SAMPLE organizations. The private
-- seed helper sets and clears this GUC around its one guarded update. The GUC
-- carries both run and organization so it cannot authorize the sibling lane.
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

create function private.demo_seed_remove_casework(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
#variable_conflict use_variable
declare
  organization_id uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  parity_case_ids uuid[];
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane';
  end if;

  select pg_catalog.array_agg(private.member_stress_uuid(
    p_run_id::text || ':parity:case:' || ordinal
  ))
  into parity_case_ids
  from pg_catalog.generate_series(1, 120) as numbered(ordinal);

  delete from public.casework_retaliation_pattern_notes row
  using public.casework_retaliation_patterns pattern
  where row.pattern_id = pattern.id and pattern.organization_id = organization_id;
  delete from public.casework_retaliation_pattern_reports row
  using public.casework_retaliation_patterns pattern
  where row.pattern_id = pattern.id and pattern.organization_id = organization_id;
  delete from public.casework_retaliation_patterns row where row.organization_id = organization_id;
  delete from public.casework_management_addenda row where row.organization_id = organization_id;
  delete from public.casework_alert_acknowledgements row where row.organization_id = organization_id;
  delete from public.casework_deadline_extensions row where row.organization_id = organization_id;
  delete from public.casework_checklist_items row where row.organization_id = organization_id;
  delete from public.casework_entity_links row where row.organization_id = organization_id;
  delete from public.casework_audit_events row
  where row.organization_id = organization_id
    and row.metadata ->> 'reasonCode' = 'sample-seed'
    and row.metadata ->> 'runId' = p_run_id::text;
  delete from public.casework_access_grants row where row.organization_id = organization_id;
  delete from public.casework_strength_analyses row where row.organization_id = organization_id;
  delete from public.casework_bargaining_events row where row.organization_id = organization_id;
  delete from public.casework_bargaining_proposals row where row.organization_id = organization_id;
  delete from public.casework_management_entries row where row.organization_id = organization_id;
  delete from public.casework_management_people row where row.organization_id = organization_id;
  delete from public.casework_retaliation_reports row where row.organization_id = organization_id;
  delete from public.casework_intake_drafts row where row.organization_id = organization_id;
  delete from public.casework_reminders row where row.organization_id = organization_id;
  delete from public.casework_step_transitions row where row.organization_id = organization_id;
  delete from public.casework_alerts row where row.organization_id = organization_id;
  delete from public.casework_checklists row where row.organization_id = organization_id;
  delete from public.casework_checklist_templates row where row.organization_id = organization_id;
  delete from public.casework_deadlines row where row.organization_id = organization_id;
  delete from public.casework_bargaining_workspaces row where row.organization_id = organization_id;

  perform pg_catalog.set_config(
    'unionground.demo_seed_casework_scope',
    pg_catalog.jsonb_build_object(
      'lane', p_lane, 'runId', p_run_id, 'organizationId', organization_id
    )::text,
    true
  );
  begin
    update public.member_cases row
    set is_restricted = false,
        restriction_reason = null,
        restricted_at = null,
        restricted_by = null,
        steward_user_id = null,
        steward_name = null,
        assigned_at = null
    where row.organization_id = organization_id
      and row.id = any(parity_case_ids);
  exception when others then
    perform pg_catalog.set_config('unionground.demo_seed_casework_scope', '', true);
    raise;
  end;
  perform pg_catalog.set_config('unionground.demo_seed_casework_scope', '', true);

  return pg_catalog.jsonb_build_object(
    'removed', true,
    'lane', p_lane,
    'runId', p_run_id
  );
end;
$function$;

create function private.demo_seed_casework_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
#variable_conflict use_variable
declare
  organization_id uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  featured_steward uuid;
  result jsonb;
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane';
  end if;
  featured_steward := private.demo_seed_user(p_lane, p_run_id, 1);

  with counts as (
    select
      (select pg_catalog.count(*) from public.casework_strength_analyses row where row.organization_id = organization_id) as strength,
      (select pg_catalog.count(*) from public.casework_bargaining_workspaces row where row.organization_id = organization_id) as workspaces,
      (select pg_catalog.count(*) from public.casework_bargaining_proposals row where row.organization_id = organization_id) as proposals,
      (select pg_catalog.count(*) from public.casework_bargaining_events row where row.organization_id = organization_id) as bargaining_events,
      (select pg_catalog.count(*) from public.casework_deadlines row where row.organization_id = organization_id) as deadlines,
      (select pg_catalog.count(*) from public.casework_deadline_extensions row where row.organization_id = organization_id) as extensions,
      (select pg_catalog.count(*) from public.casework_checklist_templates row where row.organization_id = organization_id) as templates,
      (select pg_catalog.count(*) from public.casework_checklists row where row.organization_id = organization_id) as checklists,
      (select pg_catalog.count(*) from public.casework_checklist_items row where row.organization_id = organization_id) as checklist_items,
      (select pg_catalog.count(*) from public.casework_step_transitions row where row.organization_id = organization_id) as transitions,
      (select pg_catalog.count(*) from public.casework_access_grants row where row.organization_id = organization_id) as grants,
      (select pg_catalog.count(*) from public.casework_alerts row where row.organization_id = organization_id) as alerts,
      (select pg_catalog.count(*) from public.casework_alert_acknowledgements row where row.organization_id = organization_id) as acknowledgements,
      (select pg_catalog.count(*) from public.casework_management_people row where row.organization_id = organization_id) as management_people,
      (select pg_catalog.count(*) from public.casework_management_entries row where row.organization_id = organization_id) as management_entries,
      (select pg_catalog.count(*) from public.casework_management_addenda row where row.organization_id = organization_id) as management_addenda,
      (select pg_catalog.count(*) from public.casework_retaliation_reports row where row.organization_id = organization_id) as retaliation_reports,
      (select pg_catalog.count(*) from public.casework_retaliation_patterns row where row.organization_id = organization_id) as retaliation_patterns,
      (select pg_catalog.count(*) from public.casework_retaliation_pattern_reports row where row.organization_id = organization_id) as retaliation_links,
      (select pg_catalog.count(*) from public.casework_retaliation_pattern_notes row where row.organization_id = organization_id) as retaliation_notes,
      (select pg_catalog.count(*) from public.casework_intake_drafts row where row.organization_id = organization_id) as drafts,
      (select pg_catalog.count(*) from public.casework_entity_links row where row.organization_id = organization_id) as entity_links,
      (select pg_catalog.count(*) from public.casework_reminders row where row.organization_id = organization_id) as reminders,
      (select pg_catalog.count(*) from public.casework_audit_events row where row.organization_id = organization_id) as audit_events,
      (select pg_catalog.count(*) from public.member_cases row
       where row.organization_id = organization_id and row.steward_user_id = featured_steward) as history_rows,
      (select pg_catalog.count(*) from public.member_cases row
       where row.organization_id = organization_id and row.is_restricted) as restricted_cases,
      (select pg_catalog.count(*)
       from public.casework_checklists checklist
       where checklist.organization_id = organization_id
         and (checklist.completed_at is not null) is distinct from (
           select pg_catalog.count(*) = 3
             and pg_catalog.bool_and(item.completed_at is not null and item.completed_by is not null)
           from public.casework_checklist_items item
           where item.checklist_id = checklist.id
         )) as checklist_state_mismatches,
      (select pg_catalog.count(*)
       from public.casework_alerts alert
       where alert.organization_id = organization_id
         and (alert.status = 'acknowledged') is distinct from exists (
           select 1 from public.casework_alert_acknowledgements acknowledgement
           where acknowledgement.alert_id = alert.id
         )) as alert_acknowledgement_mismatches,
      (select pg_catalog.count(*)
       from public.casework_bargaining_events event
       where event.organization_id = organization_id
         and ((event.event_type = 'pulse' and event.pulse is null)
           or (event.event_type <> 'pulse' and event.pulse is not null))) as bargaining_pulse_mismatches,
      (select pg_catalog.count(*)
       from public.casework_retaliation_pattern_reports link
       join public.casework_retaliation_patterns pattern
         on pattern.id = link.pattern_id and pattern.organization_id = link.organization_id
       join public.casework_retaliation_reports report
         on report.id = link.report_id and report.organization_id = link.organization_id
       where link.organization_id = organization_id
         and pattern.chapter_id is distinct from report.chapter_id) as pattern_chapter_mismatches,
      (select pg_catalog.count(*)
       from public.member_notification_deliveries delivery
       where (p_lane = 'presg' and exists (
         select 1 from private.presg_demo_ledger ledger
         where ledger.run_id = p_run_id and ledger.user_id = delivery.user_id
       )) or (p_lane = 'uniondemo' and exists (
         select 1 from private.uniondemo_ledger ledger
         where ledger.run_id = p_run_id and ledger.user_id = delivery.user_id
       )))
      + (select pg_catalog.count(*) from public.engagement_delivery_outbox outbound
         where outbound.organization_id = organization_id)
      + (select pg_catalog.count(*) from public.integration_webhook_deliveries delivery
         where delivery.organization_id = organization_id) as outbound_deliveries
  )
  select pg_catalog.jsonb_build_object(
    'ok', strength >= 120
      and workspaces >= 50 and proposals >= 100 and bargaining_events >= 300
      and deadlines >= 120 and extensions >= 120
      and templates >= 120 and checklists >= 120 and checklist_items >= 360
      and transitions >= 120 and grants >= 12
      and alerts >= 120 and acknowledgements >= 30
      and management_people >= 120 and management_entries >= 120 and management_addenda >= 120
      and retaliation_reports >= 120 and retaliation_patterns >= 10
      and retaliation_links >= 90 and retaliation_notes >= 10
      and drafts >= 120 and entity_links >= 120 and reminders >= 120 and audit_events >= 120
      and history_rows >= 120 and restricted_cases >= 12
      and checklist_state_mismatches = 0 and alert_acknowledgement_mismatches = 0
      and bargaining_pulse_mismatches = 0
      and pattern_chapter_mismatches = 0 and outbound_deliveries = 0,
    'lane', p_lane,
    'runId', p_run_id,
    'counts', pg_catalog.jsonb_build_object(
      'strengthAnalyses', strength,
      'bargainingWorkspaces', workspaces,
      'bargainingProposals', proposals,
      'bargainingEvents', bargaining_events,
      'deadlines', deadlines,
      'deadlineExtensions', extensions,
      'checklistTemplates', templates,
      'checklists', checklists,
      'checklistItems', checklist_items,
      'stepTransitions', transitions,
      'accessGrants', grants,
      'alerts', alerts,
      'alertAcknowledgements', acknowledgements,
      'managementPeople', management_people,
      'managementEntries', management_entries,
      'managementAddenda', management_addenda,
      'retaliationReports', retaliation_reports,
      'retaliationPatterns', retaliation_patterns,
      'retaliationPatternLinks', retaliation_links,
      'retaliationPatternNotes', retaliation_notes,
      'intakeDrafts', drafts,
      'entityLinks', entity_links,
      'reminders', reminders,
      'auditEvents', audit_events
    ),
    'featuredHistoryRows', history_rows,
    'restrictedCases', restricted_cases,
    'acknowledgedAlerts', acknowledgements,
    'checklistStateMismatches', checklist_state_mismatches,
    'alertAcknowledgementMismatches', alert_acknowledgement_mismatches,
    'bargainingPulseMismatches', bargaining_pulse_mismatches,
    'retaliationPatternLinks', retaliation_links,
    'retaliationPatternChapterMismatches', pattern_chapter_mismatches,
    'outboundDeliveries', outbound_deliveries
  )
  into result
  from counts;

  return result;
end;
$function$;

create function private.demo_seed_apply_casework(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $function$
#variable_conflict use_variable
declare
  organization_id uuid := private.member_stress_uuid(
    p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end
  );
  featured_chapter text;
  featured_steward uuid;
  grant_user uuid;
  case_ids uuid[];
  case_row record;
  case_id uuid;
  next_case_id uuid;
  template_id uuid;
  checklist_id uuid;
  alert_id uuid;
  deadline_id uuid;
  management_person_id uuid;
  management_entry_id uuid;
  retaliation_report_id uuid;
  workspace_id uuid;
  proposal_id uuid;
  pattern_id uuid;
  pattern_row record;
  workspace_ordinal integer;
  event_ordinal integer;
  report_ordinal integer;
  result jsonb;
begin
  if p_lane not in ('presg', 'uniondemo') then
    raise exception 'unknown demo lane';
  end if;
  if p_lane = 'presg' and not exists (
    select 1 from private.presg_demo_runs row
    where row.id = p_run_id and row.state in ('applied', 'verified')
  ) then
    raise exception 'presg demo run is not applied';
  end if;
  if p_lane = 'uniondemo' and not exists (
    select 1 from private.uniondemo_runs row
    where row.id = p_run_id and row.state in ('applied', 'verified')
  ) then
    raise exception 'union demo run is not applied';
  end if;
  if not exists (
    select 1 from public.organizations row
    where row.id = organization_id and row.status = 'active'
  ) then
    raise exception 'demo organization is missing';
  end if;

  perform private.demo_seed_remove_casework(p_lane, p_run_id);
  featured_chapter := private.demo_seed_chapter(p_lane, p_run_id, 1);
  featured_steward := private.demo_seed_user(p_lane, p_run_id, 1);
  grant_user := private.demo_seed_user(p_lane, p_run_id, 2);

  select pg_catalog.array_agg(expected.id order by expected.ordinal)
  into case_ids
  from (
    select numbered.ordinal,
      private.member_stress_uuid(p_run_id::text || ':parity:case:' || numbered.ordinal) as id
    from pg_catalog.generate_series(1, 120) as numbered(ordinal)
  ) as expected
  join public.member_cases row
    on row.id = expected.id
   and row.organization_id = organization_id
   and row.chapter_id is not null;
  if coalesce(pg_catalog.array_length(case_ids, 1), 0) < 120 then
    raise exception 'casework parity requires at least 120 organization-scoped cases';
  end if;

  for case_row in
    select row.id,
      row.chapter_id,
      row.user_id,
      numbered.ordinal::integer,
      coalesce(
        pg_catalog.lead(row.id) over (partition by row.chapter_id order by numbered.ordinal),
        pg_catalog.first_value(row.id) over (partition by row.chapter_id order by numbered.ordinal)
      ) as next_case_id
    from pg_catalog.unnest(case_ids) with ordinality as numbered(id, ordinal)
    join public.member_cases row on row.id = numbered.id
    order by numbered.ordinal
  loop
    case_id := case_row.id;
    next_case_id := case_row.next_case_id;
    template_id := private.member_stress_uuid(p_run_id::text || ':casework:template:' || case_row.ordinal);
    checklist_id := private.member_stress_uuid(p_run_id::text || ':casework:checklist:' || case_row.ordinal);
    alert_id := private.member_stress_uuid(p_run_id::text || ':casework:alert:' || case_row.ordinal);
    deadline_id := private.member_stress_uuid(p_run_id::text || ':casework:deadline:' || case_row.ordinal);
    management_person_id := private.member_stress_uuid(p_run_id::text || ':casework:management-person:' || case_row.ordinal);
    management_entry_id := private.member_stress_uuid(p_run_id::text || ':casework:management-entry:' || case_row.ordinal);
    retaliation_report_id := private.member_stress_uuid(p_run_id::text || ':casework:retaliation-report:' || case_row.ordinal);

    perform pg_catalog.set_config(
      'unionground.demo_seed_casework_scope',
      pg_catalog.jsonb_build_object(
        'lane', p_lane, 'runId', p_run_id, 'organizationId', organization_id
      )::text,
      true
    );
    begin
      update public.member_cases row
      set steward_user_id = featured_steward,
          steward_name = 'Casework steward',
          assigned_at = pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
          is_restricted = case_row.ordinal % 10 = 0,
          restriction_reason = case when case_row.ordinal % 10 = 0
            then 'Limited to the assigned team because the fictional file contains sensitive retaliation details.'
            else null end,
          restricted_at = case when case_row.ordinal % 10 = 0
            then pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval else null end,
          restricted_by = case when case_row.ordinal % 10 = 0 then featured_steward else null end
      where row.id = case_id and row.organization_id = organization_id;
    exception when others then
      perform pg_catalog.set_config('unionground.demo_seed_casework_scope', '', true);
      raise;
    end;
    perform pg_catalog.set_config('unionground.demo_seed_casework_scope', '', true);

    insert into public.casework_strength_analyses (
      id, case_id, organization_id, chapter_id, analyzed_by, inputs,
      score, band, recommendations, idempotency_key, created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':casework:strength:' || case_row.ordinal),
      case_id, organization_id, case_row.chapter_id, featured_steward,
      pg_catalog.jsonb_build_object(
        'facts', 1 + (case_row.ordinal % 5),
        'documentation', 1 + ((case_row.ordinal + 1) % 5),
        'timeliness', 1 + ((case_row.ordinal + 2) % 5),
        'contract_support', 1 + ((case_row.ordinal + 3) % 5),
        'witnesses', 1 + ((case_row.ordinal + 4) % 5)
      ),
      35 + (case_row.ordinal % 61),
      case when case_row.ordinal % 3 = 0 then 'needs_evidence'
        when case_row.ordinal % 3 = 1 then 'developing' else 'strong' end,
      pg_catalog.jsonb_build_array(
        'Confirm the incident chronology.',
        'Attach the relevant contract language.'
      ),
      private.member_stress_uuid(p_run_id::text || ':casework:strength-idempotency:' || case_row.ordinal),
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval
    );

    insert into public.casework_deadlines (
      id, case_id, organization_id, chapter_id, kind, label, due_at, status,
      reminder_at, created_by, created_at, updated_at
    ) values (
      deadline_id, case_id, organization_id, case_row.chapter_id,
      (array['filing','response','hearing','appeal','follow_up'])[1 + (case_row.ordinal % 5)],
      'Case milestone ' || pg_catalog.lpad(case_row.ordinal::text, 3, '0'),
      pg_catalog.now() + ((case_row.ordinal % 45) || ' days')::interval + interval '12 hours',
      (array['active','met','extended','waived','missed'])[1 + (case_row.ordinal % 5)],
      pg_catalog.now() + ((case_row.ordinal % 45) || ' days')::interval,
      featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_deadline_extensions (
      id, deadline_id, organization_id, requested_by, previous_due_at,
      requested_due_at, reason, status, decided_by, decided_at, decision_note,
      idempotency_key, created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':casework:extension:' || case_row.ordinal),
      deadline_id, organization_id, case_row.user_id,
      pg_catalog.now() + ((case_row.ordinal % 45) || ' days')::interval + interval '12 hours',
      pg_catalog.now() + ((case_row.ordinal % 45 + 7) || ' days')::interval + interval '12 hours',
      'Additional time is requested to obtain the fictional records needed for a complete review.',
      case when case_row.ordinal % 3 = 0 then 'requested'
        when case_row.ordinal % 3 = 1 then 'approved' else 'denied' end,
      case when case_row.ordinal % 3 = 0 then null else featured_steward end,
      case when case_row.ordinal % 3 = 0 then null else pg_catalog.now() - interval '2 hours' end,
      case when case_row.ordinal % 3 = 0 then null
        when case_row.ordinal % 3 = 1 then 'Approved after review of the documented request.'
        else 'The existing milestone remains achievable with the available records.' end,
      private.member_stress_uuid(p_run_id::text || ':casework:extension-idempotency:' || case_row.ordinal),
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_checklist_templates (
      id, organization_id, chapter_id, case_type, step, title, items,
      active, created_by, created_at, updated_at
    ) values (
      template_id, organization_id, case_row.chapter_id,
      (array['Discipline','Scheduling','Safety','Pay'])[1 + (case_row.ordinal % 4)],
      (array['Intake','Investigation','Step 1','Review'])[1 + (case_row.ordinal % 4)],
      'Case preparation template ' || pg_catalog.lpad(case_row.ordinal::text, 3, '0'),
      '[{"label":"Confirm timeline","required":true},{"label":"Collect records","required":true},{"label":"Review contract language","required":true}]'::jsonb,
      true, featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_checklists (
      id, case_id, organization_id, chapter_id, template_id, step, title,
      created_by, created_at, completed_at
    ) values (
      checklist_id, case_id, organization_id, case_row.chapter_id, template_id,
      (array['Intake','Investigation','Step 1','Review'])[1 + (case_row.ordinal % 4)],
      'Current case preparation', featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      case when case_row.ordinal % 4 = 3 then pg_catalog.now() - interval '1 day' else null end
    );

    insert into public.casework_checklist_items (
      id, checklist_id, organization_id, label, position, required,
      completed_at, completed_by
    )
    select
      private.member_stress_uuid(p_run_id::text || ':casework:checklist-item:' || case_row.ordinal || ':' || item.position),
      checklist_id, organization_id, item.label, item.position, true,
      case when item.position < (case_row.ordinal % 4) then pg_catalog.now() - interval '1 day' else null end,
      case when item.position < (case_row.ordinal % 4) then featured_steward else null end
    from (values
      (0, 'Confirm the member chronology'),
      (1, 'Collect supporting records'),
      (2, 'Review the governing language')
    ) as item(position, label);

    insert into public.casework_step_transitions (
      id, case_id, organization_id, chapter_id, from_step, to_step, outcome,
      transitioned_by, idempotency_key, created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':casework:transition:' || case_row.ordinal),
      case_id, organization_id, case_row.chapter_id,
      (array['Intake','Investigation','Step 1','Step 2'])[1 + (case_row.ordinal % 4)],
      (array['Investigation','Step 1','Step 2','Review'])[1 + (case_row.ordinal % 4)],
      'The fictional file advanced after its required preparation items were reviewed.',
      featured_steward,
      private.member_stress_uuid(p_run_id::text || ':casework:transition-idempotency:' || case_row.ordinal),
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_alerts (
      id, case_id, organization_id, chapter_id, kind, severity, message, status,
      escalation_due_at, escalated_at, resolved_at, created_by, created_at
    ) values (
      alert_id, case_id, organization_id, case_row.chapter_id,
      (array['deadline','safety','retaliation','legal','stalled','custom'])[1 + (case_row.ordinal % 6)],
      (array['info','warning','critical'])[1 + (case_row.ordinal % 3)],
      'Review the case condition and record the next authorized action.',
      (array['open','acknowledged','escalated','resolved'])[1 + (case_row.ordinal % 4)],
      pg_catalog.now() + ((case_row.ordinal % 5 - 2) || ' days')::interval,
      case when case_row.ordinal % 4 = 2 then pg_catalog.now() - interval '2 hours' else null end,
      case when case_row.ordinal % 4 = 3 then pg_catalog.now() - interval '1 hour' else null end,
      featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    if case_row.ordinal % 4 = 1 then
      insert into public.casework_alert_acknowledgements (
        id, alert_id, organization_id, acknowledged_by, note, created_at
      ) values (
        private.member_stress_uuid(p_run_id::text || ':casework:alert-ack:' || case_row.ordinal),
        alert_id, organization_id, featured_steward,
        'The alert was reviewed and the next step was recorded.',
        pg_catalog.now() - ((121 - case_row.ordinal) || ' minutes')::interval
      );
    end if;

    insert into public.casework_management_people (
      id, organization_id, chapter_id, display_name, title, workplace,
      created_by, created_at, updated_at
    ) values (
      management_person_id, organization_id, case_row.chapter_id,
      'Management contact ' || pg_catalog.lpad(case_row.ordinal::text, 3, '0'),
      (array['Program manager','Operations director','Shift supervisor'])[1 + (case_row.ordinal % 3)],
      'Regional service site ' || (1 + (case_row.ordinal % 12)),
      featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_management_entries (
      id, management_person_id, case_id, organization_id, chapter_id,
      occurred_at, category, summary, created_by, created_at
    ) values (
      management_entry_id, management_person_id, case_id, organization_id,
      case_row.chapter_id,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      (array['discipline','scheduling','safety','retaliation','bargaining','other'])[1 + (case_row.ordinal % 6)],
      'A factual fictional observation records the workplace conduct, participants, and immediate follow-up.',
      featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval
    );

    insert into public.casework_management_addenda (
      id, entry_id, organization_id, body, created_by, created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':casework:management-addendum:' || case_row.ordinal),
      management_entry_id, organization_id,
      'Follow-up confirmed the record and preserved the original observation unchanged.',
      featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_retaliation_reports (
      id, organization_id, chapter_id, reporter_user_id, case_id, incident_at,
      management_person, protected_activity, adverse_action, requested_support,
      status, withdrawn_at, withdrawal_reason, idempotency_key, created_at, updated_at
    ) values (
      retaliation_report_id, organization_id, case_row.chapter_id, case_row.user_id,
      case_id,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      'Management contact ' || (1 + (case_row.ordinal % 10)),
      'The member participated in a protected workplace discussion and requested representation.',
      'A schedule or assignment changed soon after the protected activity.',
      'Document the sequence and review available safeguards.',
      case when case_row.ordinal % 4 = 0 then 'withdrawn'
        when case_row.ordinal % 4 = 1 then 'submitted'
        when case_row.ordinal % 4 = 2 then 'in_review' else 'closed' end,
      case when case_row.ordinal % 4 = 0 then pg_catalog.now() - interval '2 hours' else null end,
      case when case_row.ordinal % 4 = 0 then 'The member chose to pause this fictional report after receiving support.' else null end,
      private.member_stress_uuid(p_run_id::text || ':casework:retaliation-idempotency:' || case_row.ordinal),
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_intake_drafts (
      id, organization_id, chapter_id, owner_user_id, member_user_id, case_id,
      payload, revision, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':casework:draft:' || case_row.ordinal),
      organization_id, case_row.chapter_id, featured_steward, case_row.user_id,
      case_id,
      pg_catalog.jsonb_build_object(
        'summary', 'Draft intake for a fictional workplace concern.',
        'assignmentHint', case when case_row.ordinal % 2 = 0 then 'steward' else 'coordinator' end,
        'seedSequence', case_row.ordinal
      ),
      1 + (case_row.ordinal % 5),
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' minutes')::interval
    );

    insert into public.casework_entity_links (
      id, organization_id, chapter_id, source_case_id, target_case_id,
      target_kind, target_id, relationship, note, created_by, created_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':casework:entity-link:' || case_row.ordinal),
      organization_id, case_row.chapter_id, case_id, next_case_id,
      'case', next_case_id, 'related workplace pattern',
      'The fictional files share a workplace condition and require coordinated review.',
      featured_steward,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    insert into public.casework_reminders (
      id, case_id, organization_id, chapter_id, owner_user_id, title, remind_at,
      recurrence, status, last_fired_at, completed_at, created_at, updated_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':casework:reminder:' || case_row.ordinal),
      case_id, organization_id, case_row.chapter_id, featured_steward,
      'Case follow-up ' || pg_catalog.lpad(case_row.ordinal::text, 3, '0'),
      pg_catalog.now() + ((case_row.ordinal % 30) || ' days')::interval,
      (array['none','daily','weekly','monthly'])[1 + (case_row.ordinal % 4)],
      (array['scheduled','snoozed','completed','dismissed'])[1 + (case_row.ordinal % 4)],
      case when case_row.ordinal % 4 in (2, 3) then pg_catalog.now() - interval '1 day' else null end,
      case when case_row.ordinal % 4 = 2 then pg_catalog.now() - interval '1 day' else null end,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' days')::interval,
      pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
    );

    if case_row.ordinal % 10 = 0 then
      insert into public.casework_access_grants (
        id, case_id, organization_id, chapter_id, grantee_user_id,
        granted_by, reason, granted_at
      ) values (
        private.member_stress_uuid(p_run_id::text || ':casework:grant:' || case_row.ordinal),
        case_id, organization_id, case_row.chapter_id, grant_user,
        featured_steward,
        'Temporary access for coordinated review of this restricted fictional file.',
        pg_catalog.now() - ((121 - case_row.ordinal) || ' hours')::interval
      );
    end if;

    insert into public.casework_audit_events (
      organization_id, chapter_id, case_id, actor_user_id, event_type,
      entity_type, entity_id, metadata, created_at
    ) values (
      organization_id, case_row.chapter_id, case_id, featured_steward,
      (array['strength_scored','deadline_requested','checklist_created','step_advanced',
        'restriction_changed','alert_acknowledged','behavior_logged','retaliation_submitted',
        'draft_saved','bulk_updated','entity_linked','reminder_changed'])[1 + (case_row.ordinal % 12)],
      'case', case_id,
      pg_catalog.jsonb_build_object(
        'reasonCode', 'sample-seed',
        'runId', p_run_id::text,
        'seedSequence', case_row.ordinal
      ),
      pg_catalog.now() - ((121 - case_row.ordinal) || ' minutes')::interval
    );
  end loop;

  for workspace_ordinal in 1..50 loop
    workspace_id := private.member_stress_uuid(
      p_run_id::text || ':casework:bargaining-workspace:' || workspace_ordinal
    );
    insert into public.casework_bargaining_workspaces (
      id, organization_id, chapter_id, title, status, starts_at,
      created_by, created_at, updated_at
    ) values (
      workspace_id, organization_id, featured_chapter,
      'Negotiation workspace ' || pg_catalog.lpad(workspace_ordinal::text, 2, '0'),
      (array['planning','live','paused','tentative_agreement','closed'])[1 + (workspace_ordinal % 5)],
      pg_catalog.now() + ((workspace_ordinal - 25) || ' days')::interval,
      featured_steward,
      pg_catalog.now() - ((51 - workspace_ordinal) || ' days')::interval,
      pg_catalog.now() - ((51 - workspace_ordinal) || ' hours')::interval
    );

    for report_ordinal in 1..2 loop
      proposal_id := private.member_stress_uuid(
        p_run_id::text || ':casework:bargaining-proposal:' || workspace_ordinal || ':' || report_ordinal
      );
      insert into public.casework_bargaining_proposals (
        id, workspace_id, organization_id, side, title, body, status,
        response_due_at, position, created_by, created_at, updated_at
      ) values (
        proposal_id, workspace_id, organization_id,
        case when report_ordinal = 1 then 'union' else 'management' end,
        case when report_ordinal = 1 then 'Scheduling safeguards' else 'Operational flexibility' end,
        'A realistic fictional proposal records the current position, supporting rationale, and response path.',
        (array['draft','proposed','countered','tentative','accepted','rejected','withdrawn'])
          [1 + ((workspace_ordinal + report_ordinal) % 7)],
        pg_catalog.now() + ((workspace_ordinal % 14) || ' days')::interval,
        report_ordinal - 1, featured_steward,
        pg_catalog.now() - ((51 - workspace_ordinal) || ' days')::interval,
        pg_catalog.now() - ((51 - workspace_ordinal) || ' hours')::interval
      );
    end loop;

    for event_ordinal in 1..6 loop
      proposal_id := private.member_stress_uuid(
        p_run_id::text || ':casework:bargaining-proposal:' || workspace_ordinal || ':' || (1 + (event_ordinal % 2))
      );
      insert into public.casework_bargaining_events (
        id, workspace_id, organization_id, proposal_id, event_type, body,
        pulse, created_by, created_at
      ) values (
        private.member_stress_uuid(
          p_run_id::text || ':casework:bargaining-event:' || workspace_ordinal || ':' || event_ordinal
        ),
        workspace_id, organization_id,
        case when event_ordinal % 3 = 0 then null else proposal_id end,
        (array['note','proposal_status','session_status','pulse'])[1 + (event_ordinal % 4)],
        'Session note ' || event_ordinal || ' records movement, open questions, and the next caucus action.',
        case when event_ordinal % 4 = 3
          then (array['steady','watch','urgent'])[1 + (workspace_ordinal % 3)] else null end,
        featured_steward,
        pg_catalog.now() - ((301 - ((workspace_ordinal - 1) * 6 + event_ordinal)) || ' minutes')::interval
      );
    end loop;
  end loop;

  for pattern_row in
    select report.chapter_id,
      pg_catalog.lower(pg_catalog.btrim(report.management_person)) as person_key,
      pg_catalog.min(report.management_person) as subject_label,
      pg_catalog.count(*)::integer as report_count
    from public.casework_retaliation_reports report
    where report.organization_id = organization_id
      and report.status <> 'withdrawn'
      and report.incident_at >= pg_catalog.now() - interval '3 years'
    group by report.chapter_id, pg_catalog.lower(pg_catalog.btrim(report.management_person))
    having pg_catalog.count(*) >= 2
    order by report.chapter_id, pg_catalog.lower(pg_catalog.btrim(report.management_person))
  loop
    pattern_id := private.member_stress_uuid(
      p_run_id::text || ':casework:retaliation-pattern:'
        || pattern_row.chapter_id || ':' || pattern_row.person_key
    );
    insert into public.casework_retaliation_patterns (
      id, organization_id, chapter_id, fingerprint, subject_label,
      report_count, status, disposition, detected_at, reviewed_by, reviewed_at
    ) values (
      pattern_id, organization_id, pattern_row.chapter_id,
      pg_catalog.md5(pattern_row.chapter_id || ':' || pattern_row.person_key),
      pattern_row.subject_label,
      pattern_row.report_count,
      (array['flagged','investigating','substantiated','dismissed'])
        [1 + (pattern_row.report_count % 4)],
      case when pattern_row.report_count % 2 = 0
        then 'Coordinated follow-up is documented.' else null end,
      pg_catalog.now() - interval '10 days',
      case when pattern_row.report_count % 2 = 0 then featured_steward else null end,
      case when pattern_row.report_count % 2 = 0 then pg_catalog.now() - interval '1 day' else null end
    );

    insert into public.casework_retaliation_pattern_reports (
      pattern_id, report_id, organization_id
    )
    select pattern_id, report.id, organization_id
    from public.casework_retaliation_reports report
    where report.organization_id = organization_id
      and report.chapter_id = pattern_row.chapter_id
      and report.status <> 'withdrawn'
      and report.incident_at >= pg_catalog.now() - interval '3 years'
      and pg_catalog.lower(pg_catalog.btrim(report.management_person)) = pattern_row.person_key;

    insert into public.casework_retaliation_pattern_notes (
      id, pattern_id, organization_id, body, created_by, created_at
    ) values (
      private.member_stress_uuid(
        p_run_id::text || ':casework:retaliation-pattern-note:'
          || pattern_row.chapter_id || ':' || pattern_row.person_key
      ),
      pattern_id, organization_id,
      'The review note distinguishes shared facts from assumptions and records the authorized next action.',
      featured_steward,
      pg_catalog.now() - interval '10 hours'
    );
  end loop;

  result := private.demo_seed_casework_status(p_lane, p_run_id);
  if not coalesce((result ->> 'ok')::boolean, false) then
    raise exception 'casework SAMPLE parity verification failed: %', result;
  end if;
  return result;
end;
$function$;

create function private.demo_seed_sync_casework_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result jsonb;
begin
  if tg_op = 'INSERT' and new.function_id = 'CR-020' then
    result := private.demo_seed_apply_casework(new.lane, new.run_id);
    if not coalesce((result ->> 'ok')::boolean, false) then
      raise exception 'casework SAMPLE parity verification failed: %', result;
    end if;
    return new;
  elsif tg_op = 'DELETE' and old.function_id = 'CR-020' then
    perform private.demo_seed_remove_casework(old.lane, old.run_id);
    return old;
  end if;
  if tg_op = 'INSERT' then return new; end if;
  return old;
end;
$function$;

create trigger demo_seed_sync_casework_evidence
before insert or delete on private.demo_seed_function_evidence
for each row execute function private.demo_seed_sync_casework_evidence();

-- Preserve every previously composed surface by delegating to the installed
-- recorder, then add the case-history count and recompute the complete result.
alter function private.demo_seed_record_page_evidence(text, uuid, uuid, uuid, uuid, uuid)
  rename to demo_seed_record_page_evidence_pre_casework_20260830;

create function private.demo_seed_record_page_evidence(
  p_lane text,
  p_run_id uuid,
  p_organization_id uuid,
  p_featured_user uuid,
  p_featured_steward uuid,
  p_featured_conversation uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.demo_seed_record_page_evidence_pre_casework_20260830(
    p_lane,
    p_run_id,
    p_organization_id,
    p_featured_user,
    p_featured_steward,
    p_featured_conversation
  );

  insert into private.demo_seed_page_evidence (lane, run_id, surface, actual_rows)
  values (
    p_lane,
    p_run_id,
    'caseworkHistory',
    (
      select pg_catalog.count(*)
      from public.member_cases row
      where row.organization_id = p_organization_id
        and row.steward_user_id = p_featured_steward
    )
  )
  on conflict (lane, run_id, surface) do update
  set actual_rows = excluded.actual_rows,
      recorded_at = pg_catalog.now();

  return pg_catalog.jsonb_build_object(
    'ok', not exists (
      select 1
      from private.demo_seed_page_contract contract
      left join private.demo_seed_page_evidence evidence
        on evidence.surface = contract.surface
       and evidence.lane = p_lane
       and evidence.run_id = p_run_id
      where evidence.surface is null or evidence.actual_rows < contract.minimum_rows
    ),
    'surfaces', (
      select pg_catalog.jsonb_object_agg(
        contract.surface,
        pg_catalog.jsonb_build_object(
          'actual', coalesce(evidence.actual_rows, 0),
          'minimum', contract.minimum_rows,
          'pageSize', contract.page_size,
          'ok', coalesce(evidence.actual_rows, 0) >= contract.minimum_rows
        )
      )
      from private.demo_seed_page_contract contract
      left join private.demo_seed_page_evidence evidence
        on evidence.surface = contract.surface
       and evidence.lane = p_lane
       and evidence.run_id = p_run_id
    )
  );
end;
$function$;

-- The installed aggregate status predates casework. Keep its prior Voice and
-- page-depth composition, then fail closed on every catalog row, every page
-- contract, and the measured casework lifecycle added above.
alter function private.demo_seed_function_parity_status(text, uuid)
  rename to demo_seed_function_parity_status_pre_casework_20260830;

create function private.demo_seed_function_parity_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  prior_status jsonb := private.demo_seed_function_parity_status_pre_casework_20260830(
    p_lane, p_run_id
  );
  casework_status jsonb := private.demo_seed_casework_status(p_lane, p_run_id);
  evidence_ok boolean;
  pages_ok boolean;
  complete_page_depth jsonb;
begin
  select not exists (
    select 1
    from private.demo_seed_function_catalog catalog
    left join private.demo_seed_function_evidence evidence
      on evidence.function_id = catalog.function_id
     and evidence.lane = p_lane
     and evidence.run_id = p_run_id
    where evidence.function_id is null
       or evidence.status is distinct from catalog.coverage
       or evidence.evidence_key is distinct from catalog.evidence_key
  ) into evidence_ok;

  select not exists (
    select 1
    from private.demo_seed_page_contract contract
    left join private.demo_seed_page_evidence evidence
      on evidence.surface = contract.surface
     and evidence.lane = p_lane
     and evidence.run_id = p_run_id
    where evidence.surface is null or evidence.actual_rows < contract.minimum_rows
  ), pg_catalog.jsonb_object_agg(
    contract.surface,
    pg_catalog.jsonb_build_object(
      'actual', coalesce(evidence.actual_rows, 0),
      'minimum', contract.minimum_rows,
      'pageSize', contract.page_size,
      'ok', coalesce(evidence.actual_rows, 0) >= contract.minimum_rows
    )
  )
  into pages_ok, complete_page_depth
  from private.demo_seed_page_contract contract
  left join private.demo_seed_page_evidence evidence
    on evidence.surface = contract.surface
   and evidence.lane = p_lane
   and evidence.run_id = p_run_id;

  return prior_status || pg_catalog.jsonb_build_object(
    'ok', coalesce((prior_status ->> 'ok')::boolean, false)
      and evidence_ok
      and pages_ok
      and coalesce((casework_status ->> 'ok')::boolean, false),
    'catalogEvidenceMatches', evidence_ok,
    'pageDepth', complete_page_depth,
    'casework', casework_status
  );
end;
$function$;

revoke all on function private.demo_seed_remove_casework(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_casework_status(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_apply_casework(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_sync_casework_evidence()
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_record_page_evidence_pre_casework_20260830(text, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_record_page_evidence(text, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_function_parity_status_pre_casework_20260830(text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_function_parity_status(text, uuid)
  from public, anon, authenticated, service_role;

comment on function private.demo_seed_apply_casework(text, uuid) is
  'Deterministic SAMPLE-only casework evidence. Called only from an already-authorized demo seed evidence transaction.';
comment on function private.demo_seed_remove_casework(text, uuid) is
  'Removes one authorized SAMPLE lane casework dataset before ordinary lane teardown.';
comment on function private.demo_seed_sync_casework_evidence() is
  'Attaches reversible casework data to the existing guarded demo function-evidence lifecycle.';
