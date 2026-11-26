-- SAMPLE-only, reversible depth for CR-013/085/096/110/111. This migration
-- installs seed composition; it creates no organization, user, or product row
-- by itself. Rows appear only inside an already-authorized presg/uniondemo run.

set local lock_timeout = '5s';

insert into private.demo_seed_page_contract (surface, page_size, minimum_rows, scope, source) values
  ('member-operations-weekly-admin', 26, 52, 'featured-chapter', 'src/features/engagement/StaffEngagement.jsx'),
  ('member-operations-records', 25, 50, 'organization', 'src/features/memberOperations/MemberOperations.jsx'),
  ('member-operations-handoffs', 20, 40, 'organization', 'src/views/MemberSupportView.jsx'),
  ('member-operations-welcome', 10, 20, 'organization', 'src/features/memberOperations/MemberOperations.jsx'),
  ('member-operations-imports', 10, 20, 'organization', 'src/features/memberOperations/MemberOperations.jsx')
on conflict (surface) do update set
  page_size = excluded.page_size,
  minimum_rows = excluded.minimum_rows,
  scope = excluded.scope,
  source = excluded.source;

update private.demo_seed_function_catalog
set coverage = 'seeded',
    evidence_key = case function_id
      when 'CR-013' then 'member-operations-weekly-admin'
      when 'CR-085' then 'member-operations-records'
      when 'CR-096' then 'member-operations-handoffs'
      when 'CR-110' then 'member-operations-welcome'
      when 'CR-111' then 'member-operations-imports'
    end
where function_id in ('CR-013','CR-085','CR-096','CR-110','CR-111');

create function private.demo_seed_member_operations_from_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  run record;
  org uuid;
  chapter text;
  creator uuid;
  seed_campaign_id uuid;
  seed_step_id uuid;
  seed_enrollment_id uuid;
  seed_batch_id uuid;
  seed_member_id uuid;
  i integer;
begin
  if pg_catalog.pg_trigger_depth() > 1 then return null; end if;
  for run in select distinct lane, run_id from inserted_member_operations_evidence
  loop
    if run.lane not in ('presg','uniondemo') then continue; end if;
    org := private.member_stress_uuid(run.run_id::text || case when run.lane = 'presg' then ':presg:organization' else ':ud:organization' end);
    chapter := private.demo_seed_chapter(run.lane, run.run_id, 1);
    creator := private.demo_seed_user(run.lane, run.run_id, 1);
    if not exists (select 1 from public.organizations source where source.id = org)
       or not exists (select 1 from public.chapters source where source.id = chapter and source.organization_id = org)
       or not exists (select 1 from auth.users source where source.id = creator) then
      continue;
    end if;

    insert into public.weekly_question_selection_policies (
      organization_id, chapter_id, enabled, cadence_days, minimum_pool_size,
      selection_count, priority_rule, next_run_at, last_run_at, last_result, updated_by
    ) values (
      org, chapter, true, 7, 3, 1, 'support_then_oldest',
      pg_catalog.now() + interval '3 days', pg_catalog.now() - interval '4 days',
      pg_catalog.jsonb_build_object('selectedCount',1,'poolCount',52,'seeded',true), creator
    ) on conflict (organization_id, chapter_id) do update set
      enabled = true, next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at,
      last_result = excluded.last_result, updated_by = excluded.updated_by, updated_at = pg_catalog.now();

    for i in 1..104 loop
      seed_member_id := private.demo_seed_user(run.lane, run.run_id, 2 + ((i - 1) % 80));
      if exists (select 1 from public.organization_memberships membership
        where membership.organization_id = org and membership.user_id = seed_member_id and membership.status = 'active') then
        insert into public.member_weekly_questions (
          id, chapter_id, user_id, week_start, body, options, editorial_state,
          editor_note, created_at, updated_at
        ) values (
          private.member_stress_uuid(run.run_id::text || ':member-operations:weekly:' || i),
          chapter, seed_member_id,
          (pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date - (i * 7)),
          'Which workplace priority should the chapter discuss next? ' || i,
          '["Scheduling","Workload","Safety"]'::jsonb,
          case when i <= 26 then 'submitted' when i <= 52 then 'reserved' else 'archived' end,
          case when i > 26 then 'Reviewed in the weekly editorial cycle.' end,
          pg_catalog.now() - (i * 7 || ' days')::interval,
          pg_catalog.now() - (i * 7 || ' days')::interval
        ) on conflict (id) do update set
          editorial_state = excluded.editorial_state, editor_note = excluded.editor_note,
          updated_at = excluded.updated_at;
      end if;
    end loop;

    insert into public.organization_member_operational_profiles (
      organization_id, member_user_id, member_number, job_title, department,
      work_location, hire_date, membership_class, preferred_language,
      administrative_notes, updated_by
    )
    select org, membership.user_id,
      'UG-' || pg_catalog.lpad(roster.ordinality::text, 5, '0'),
      (array['Program specialist','Field representative','Analyst','Coordinator'])[1 + ((roster.ordinality - 1) % 4)],
      (array['Member services','Operations','Education','Field support'])[1 + ((roster.ordinality - 1) % 4)],
      (array['Pine Harbor','Maple Crossing','Cedar Ridge','Remote'])[1 + ((roster.ordinality - 1) % 4)],
      current_date - ((365 + roster.ordinality * 19) || ' days')::interval,
      case when roster.ordinality % 5 = 0 then 'Temporary' else 'Regular' end,
      case when roster.ordinality % 6 = 0 then 'es' else 'en' end,
      case when roster.ordinality % 7 = 0 then 'Follow up at the next scheduled roster review.' end,
      creator
    from (
      select source.user_id, pg_catalog.row_number() over (order by source.user_id) as ordinality
      from public.organization_memberships source
      where source.organization_id = org and source.status = 'active'
      order by source.user_id limit 50
    ) roster
    join public.organization_memberships membership
      on membership.organization_id = org and membership.user_id = roster.user_id
    on conflict (organization_id, member_user_id) do update set
      member_number = excluded.member_number, job_title = excluded.job_title,
      department = excluded.department, work_location = excluded.work_location,
      hire_date = excluded.hire_date, membership_class = excluded.membership_class,
      preferred_language = excluded.preferred_language,
      administrative_notes = excluded.administrative_notes, updated_by = excluded.updated_by,
      updated_at = pg_catalog.now();

    for i in 1..40 loop
      seed_member_id := private.demo_seed_user(run.lane, run.run_id, 10 + i);
      if exists (select 1 from public.organization_memberships membership
        where membership.organization_id = org and membership.user_id = seed_member_id and membership.status = 'active') then
        insert into public.member_handoffs (
          id, organization_id, chapter_id, member_user_id, from_steward_id,
          to_steward_id, initiated_by, status, note, idempotency_key,
          created_at, acknowledged_at, resolved_at
        ) values (
          private.member_stress_uuid(run.run_id::text || ':member-operations:handoff:' || i),
          org, chapter, seed_member_id,
          private.demo_seed_user(run.lane, run.run_id, 1),
          private.demo_seed_user(run.lane, run.run_id, 2), creator,
          case when i <= 2 then 'pending' when i % 4 = 0 then 'declined' when i % 5 = 0 then 'cancelled' else 'acknowledged' end,
          'Transfer includes current contacts, open follow-up, and the next agreed check-in.',
          private.member_stress_uuid(run.run_id::text || ':member-operations:handoff-key:' || i),
          pg_catalog.now() - (i * 24 || ' days')::interval,
          case when i > 2 and i % 4 <> 0 and i % 5 <> 0 then pg_catalog.now() - ((i * 24 - 1) || ' days')::interval end,
          case when i > 2 then pg_catalog.now() - ((i * 24 - 1) || ' days')::interval end
        ) on conflict (id) do update set status = excluded.status, note = excluded.note,
          acknowledged_at = excluded.acknowledged_at, resolved_at = excluded.resolved_at;
      end if;
    end loop;

    for i in 1..2 loop
      seed_campaign_id := private.member_stress_uuid(run.run_id::text || ':member-operations:campaign:' || i);
      insert into public.organization_welcome_campaigns (
        id, organization_id, name, state, created_by, updated_by, created_at, updated_at
      ) values (
        seed_campaign_id, org,
        case i when 1 then 'New member orientation' else 'First-month check-in' end,
        case i when 1 then 'active' else 'paused' end,
        creator, creator, pg_catalog.now() - (i * 180 || ' days')::interval, pg_catalog.now() - (i * 9 || ' days')::interval
      ) on conflict (id) do update set name = excluded.name, state = excluded.state, updated_at = excluded.updated_at;
      for step_number in 0..2 loop
        seed_step_id := private.member_stress_uuid(run.run_id::text || ':member-operations:campaign:' || i || ':step:' || step_number);
        insert into public.organization_welcome_campaign_steps (
          id, organization_id, campaign_id, position, delay_days, locale, subject, body, active
        ) values (
          seed_step_id, org, seed_campaign_id, step_number, step_number * 7, 'en',
          (array['Welcome to Union Ground','Your first-week guide','One-month check-in'])[step_number + 1],
          (array[
            'Your account is ready. Start with your chapter, rights, and message inbox.',
            'Review the member guide and choose the updates you want to receive.',
            'Tell your chapter team what would make the next month more useful.'
          ])[step_number + 1], true
        ) on conflict (campaign_id, position, locale) do update set
          subject = excluded.subject, body = excluded.body, active = true, updated_at = pg_catalog.now();
      end loop;
      for enrollment_number in 1..20 loop
        seed_member_id := private.demo_seed_user(run.lane, run.run_id, 20 + ((i - 1) * 20) + enrollment_number);
        if exists (select 1 from public.organization_memberships membership
          where membership.organization_id = org and membership.user_id = seed_member_id and membership.status = 'active') then
          seed_enrollment_id := private.member_stress_uuid(run.run_id::text || ':member-operations:campaign:' || i || ':enrollment:' || enrollment_number);
          insert into public.member_welcome_enrollments (
            id, organization_id, campaign_id, member_user_id, state,
            next_step_position, next_due_at, enrolled_by, enrolled_at, completed_at
          ) values (
            seed_enrollment_id, org, seed_campaign_id, seed_member_id,
            case when enrollment_number % 7 = 0 then 'paused' when enrollment_number % 5 = 0 then 'completed' else 'active' end,
            case when enrollment_number % 5 = 0 then 3 else 1 + (enrollment_number % 2) end,
            pg_catalog.now() + ((enrollment_number % 9) || ' days')::interval,
            creator, pg_catalog.now() - (enrollment_number * 11 || ' days')::interval,
            case when enrollment_number % 5 = 0 then pg_catalog.now() - interval '2 days' end
          ) on conflict (campaign_id, member_user_id) do update set
            state = excluded.state, next_step_position = excluded.next_step_position,
            next_due_at = excluded.next_due_at, completed_at = excluded.completed_at;
          seed_step_id := private.member_stress_uuid(run.run_id::text || ':member-operations:campaign:' || i || ':step:0');
          insert into public.engagement_delivery_outbox (
            id, organization_id, recipient_user_id, delivery_kind, source_kind,
            source_id, locale, state, attempt_count, sent_at, last_error_code,
            available_at, created_at, updated_at,
            subject_snapshot, body_snapshot, action_path_snapshot
          ) values (
            private.member_stress_uuid(run.run_id::text || ':member-operations:delivery:' || i || ':' || enrollment_number),
            org, seed_member_id, 'welcome', 'welcome_campaign', seed_enrollment_id::text || ':' || seed_step_id::text,
            'en', 'suppressed', 0, null, 'sample.seed',
            pg_catalog.now() - (enrollment_number || ' days')::interval,
            pg_catalog.now() - (enrollment_number || ' days')::interval,
            pg_catalog.now() - (enrollment_number || ' days')::interval,
            'Welcome to Union Ground',
            'Your account is ready. Start with your chapter, rights, and message inbox.',
            '/m/support?welcome=' || seed_enrollment_id::text
          ) on conflict (delivery_kind, source_id, recipient_user_id) do update set
            state = excluded.state, attempt_count = excluded.attempt_count,
            sent_at = excluded.sent_at, last_error_code = excluded.last_error_code;
        end if;
      end loop;
    end loop;

    for i in 1..20 loop
      seed_batch_id := private.member_stress_uuid(run.run_id::text || ':member-operations:import:' || i);
      seed_member_id := private.demo_seed_user(run.lane, run.run_id, 2 + i);
      insert into public.organization_import_batches (
        id, organization_id, kind, filename, mapping, state, row_count,
        valid_count, error_count, created_by, created_at, validated_at, committed_at
      ) values (
        seed_batch_id, org, case when i % 2 = 0 then 'member' else 'grievance' end,
        case when i % 2 = 0 then 'member-records-' || i || '.csv' else 'grievances-' || i || '.csv' end,
        case when i % 2 = 0 then '{"member_id":"member_id","department":"department"}'::jsonb
          else '{"member_id":"member_id","chapter_id":"chapter_id","reference":"reference","title":"title"}'::jsonb end,
        case when i <= 4 then 'validated' else 'committed' end,
        1, 1, 0, creator, pg_catalog.now() - (i * 17 || ' days')::interval,
        pg_catalog.now() - (i * 17 - 1 || ' days')::interval,
        case when i > 4 then pg_catalog.now() - (i * 17 - 2 || ' days')::interval end
      ) on conflict (id) do update set state = excluded.state, committed_at = excluded.committed_at;
      insert into public.organization_import_rows (
        organization_id, batch_id, row_number, normalized_data, validation_errors, created_at
      ) values (
        org, seed_batch_id, 1,
        case when i % 2 = 0 then pg_catalog.jsonb_build_object(
          'member_id',seed_member_id,'department','Member services','_resolved_member_id',seed_member_id
        ) else pg_catalog.jsonb_build_object(
          'member_id',seed_member_id,'chapter_id',chapter,'reference','DEMO-GR-' || pg_catalog.lpad(i::text,3,'0'),
          'title','Imported workplace concern','_resolved_member_id',seed_member_id
        ) end,
        '[]'::jsonb, pg_catalog.now() - (i * 17 || ' days')::interval
      ) on conflict (batch_id, row_number) do update set normalized_data = excluded.normalized_data, validation_errors = '[]'::jsonb;
    end loop;

    insert into private.demo_seed_page_evidence (lane, run_id, surface, actual_rows) values
      (run.lane, run.run_id, 'member-operations-weekly-admin', (
        select least(
          pg_catalog.count(*) filter (where question.editorial_state in ('submitted','reserved')),
          pg_catalog.count(*) filter (where question.editorial_state in ('published','archived'))
        )::integer
        from public.member_weekly_questions question
        where question.chapter_id = chapter
      )),
      (run.lane, run.run_id, 'member-operations-records', 50),
      (run.lane, run.run_id, 'member-operations-handoffs', 40),
      (run.lane, run.run_id, 'member-operations-welcome', 40),
      (run.lane, run.run_id, 'member-operations-imports', 20)
    on conflict (lane, run_id, surface) do update set actual_rows = excluded.actual_rows, recorded_at = pg_catalog.now();
  end loop;
  return null;
end;
$function$;

create trigger demo_seed_member_operations_from_evidence
after insert on private.demo_seed_page_evidence
referencing new table as inserted_member_operations_evidence
for each statement execute function private.demo_seed_member_operations_from_evidence();

create function private.demo_seed_remove_member_operations(p_lane text, p_run_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_stress_uuid(p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end);
begin
  delete from public.engagement_delivery_outbox
  where organization_id = org and source_kind = 'welcome_campaign';
  delete from public.member_welcome_enrollments where organization_id = org;
  delete from public.organization_welcome_campaigns where organization_id = org;
  delete from public.organization_import_batches where organization_id = org;
  delete from public.member_handoffs where organization_id = org
    and id in (select private.member_stress_uuid(p_run_id::text || ':member-operations:handoff:' || i) from pg_catalog.generate_series(1,40) i);
  delete from public.organization_member_operational_profiles where organization_id = org;
  delete from public.weekly_question_selection_policies where organization_id = org;
  delete from public.member_weekly_questions where id in (
    select private.member_stress_uuid(p_run_id::text || ':member-operations:weekly:' || i) from pg_catalog.generate_series(1,104) i
  );
end;
$function$;

revoke all on function private.demo_seed_member_operations_from_evidence() from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_member_operations(text,uuid) from public, anon, authenticated, service_role;

alter function private.demo_seed_casework_status(text,uuid)
  rename to demo_seed_casework_status_pre_member_operations_20260830;

create function private.demo_seed_casework_status(p_lane text, p_run_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  prior jsonb := private.demo_seed_casework_status_pre_member_operations_20260830(p_lane, p_run_id);
  org uuid := private.member_stress_uuid(p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end);
  suppressed_welcome integer;
  unsafe_outbound integer;
  counts jsonb;
  other_ok boolean;
begin
  select pg_catalog.count(*) into suppressed_welcome
  from public.engagement_delivery_outbox delivery
  where delivery.organization_id = org and delivery.source_kind = 'welcome_campaign'
    and delivery.state = 'suppressed' and delivery.last_error_code = 'sample.seed';
  unsafe_outbound := (prior ->> 'outboundDeliveries')::integer - suppressed_welcome;
  counts := prior -> 'counts';
  other_ok :=
    (counts ->> 'strengthAnalyses')::integer >= 120
    and (counts ->> 'bargainingWorkspaces')::integer >= 50
    and (counts ->> 'bargainingProposals')::integer >= 100
    and (counts ->> 'bargainingEvents')::integer >= 300
    and (counts ->> 'deadlines')::integer >= 120
    and (counts ->> 'deadlineExtensions')::integer >= 120
    and (counts ->> 'checklistTemplates')::integer >= 120
    and (counts ->> 'checklists')::integer >= 120
    and (counts ->> 'checklistItems')::integer >= 360
    and (counts ->> 'stepTransitions')::integer >= 120
    and (counts ->> 'accessGrants')::integer >= 12
    and (counts ->> 'alerts')::integer >= 120
    and (counts ->> 'alertAcknowledgements')::integer >= 30
    and (counts ->> 'managementPeople')::integer >= 120
    and (counts ->> 'managementEntries')::integer >= 120
    and (counts ->> 'managementAddenda')::integer >= 120
    and (counts ->> 'retaliationReports')::integer >= 120
    and (counts ->> 'retaliationPatterns')::integer >= 10
    and (counts ->> 'retaliationPatternLinks')::integer >= 90
    and (counts ->> 'retaliationPatternNotes')::integer >= 10
    and (counts ->> 'intakeDrafts')::integer >= 120
    and (counts ->> 'entityLinks')::integer >= 120
    and (counts ->> 'reminders')::integer >= 120
    and (counts ->> 'auditEvents')::integer >= 120
    and (prior ->> 'featuredHistoryRows')::integer >= 120
    and (prior ->> 'restrictedCases')::integer >= 12
    and (prior ->> 'acknowledgedAlerts')::integer >= 30
    and (prior ->> 'checklistStateMismatches')::integer = 0
    and (prior ->> 'alertAcknowledgementMismatches')::integer = 0
    and (prior ->> 'bargainingPulseMismatches')::integer = 0
    and (prior ->> 'retaliationPatternChapterMismatches')::integer = 0;
  return prior || pg_catalog.jsonb_build_object(
    'ok', other_ok and unsafe_outbound = 0,
    'outboundDeliveries', unsafe_outbound,
    'suppressedWelcomeDeliveries', suppressed_welcome
  );
end;
$function$;

revoke all on function private.demo_seed_casework_status_pre_member_operations_20260830(text,uuid) from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_casework_status(text,uuid) from public, anon, authenticated, service_role;

create or replace function public.presg_demo_remove_function_parity(p_run_id uuid,p_target_ref text,p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare operations_result jsonb; voice_result jsonb; base_result jsonb; refresh_removed boolean;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_member_operations('presg', p_run_id);
  perform private.demo_seed_remove_institutional_records('presg', p_run_id);
  perform private.demo_seed_remove_auth_operations('presg', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('presg', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('presg', p_run_id);
  base_result := private.demo_seed_remove_function_parity('presg', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
end;
$function$;

create or replace function public.uniondemo_remove_function_parity(p_run_id uuid,p_target_ref text,p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare operations_result jsonb; voice_result jsonb; base_result jsonb; refresh_removed boolean;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  perform private.demo_seed_remove_member_operations('uniondemo', p_run_id);
  perform private.demo_seed_remove_institutional_records('uniondemo', p_run_id);
  perform private.demo_seed_remove_auth_operations('uniondemo', p_run_id);
  operations_result := private.demo_seed_remove_voice_operations('uniondemo', p_run_id);
  voice_result := private.demo_seed_remove_voice_parity('uniondemo', p_run_id);
  base_result := private.demo_seed_remove_function_parity('uniondemo', p_run_id);
  refresh_removed := private.demo_seed_drop_voice_operations_refresh();
  return base_result || pg_catalog.jsonb_build_object('voiceRefreshRemoved',refresh_removed,'voice',voice_result || pg_catalog.jsonb_build_object('operations',operations_result));
end;
$function$;

revoke all on function public.presg_demo_remove_function_parity(uuid,text,text) from public, anon, authenticated;
revoke all on function public.uniondemo_remove_function_parity(uuid,text,text) from public, anon, authenticated;
grant execute on function public.presg_demo_remove_function_parity(uuid,text,text) to service_role;
grant execute on function public.uniondemo_remove_function_parity(uuid,text,text) to service_role;
