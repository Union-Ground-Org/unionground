-- SAMPLE-only demo seed function-parity and page-depth contract.
--
-- The two lanes remain independent and reversible. This migration adds the
-- shared contract phase after their existing roster/history phases. It never
-- executes a seed during migration and exposes no authenticated mutation path.

set local lock_timeout = '5s';

create table private.demo_seed_function_catalog (
  function_id text primary key check (function_id ~ '^CR-[0-9]{3}$'),
  domain text not null check (domain in (
    'voice', 'casework', 'analytics', 'organizing', 'knowledge',
    'communications', 'administration', 'public'
  )),
  coverage text not null check (coverage in ('seeded', 'schema-not-yet-landed')),
  evidence_key text,
  gate_relation text,
  constraint demo_seed_function_catalog_evidence_complete check (
    (coverage = 'seeded' and evidence_key is not null and gate_relation is null)
    or (coverage = 'schema-not-yet-landed' and evidence_key is null)
  )
);

create table private.demo_seed_function_evidence (
  lane text not null check (lane in ('presg', 'uniondemo')),
  run_id uuid not null,
  function_id text not null references private.demo_seed_function_catalog(function_id) on delete restrict,
  status text not null check (status in ('seeded', 'schema-not-yet-landed')),
  evidence_key text,
  recorded_at timestamptz not null default pg_catalog.now(),
  primary key (lane, run_id, function_id)
);

create table private.demo_seed_page_contract (
  surface text primary key,
  page_size integer not null check (page_size > 0),
  minimum_rows integer not null check (minimum_rows = page_size * 2),
  scope text not null,
  source text not null
);

create table private.demo_seed_page_evidence (
  lane text not null check (lane in ('presg', 'uniondemo')),
  run_id uuid not null,
  surface text not null references private.demo_seed_page_contract(surface) on delete restrict,
  actual_rows bigint not null check (actual_rows >= 0),
  recorded_at timestamptz not null default pg_catalog.now(),
  primary key (lane, run_id, surface)
);

revoke all on private.demo_seed_function_catalog,
  private.demo_seed_function_evidence,
  private.demo_seed_page_contract,
  private.demo_seed_page_evidence
from public, anon, authenticated, service_role;

insert into private.demo_seed_function_catalog
  (function_id, domain, coverage, evidence_key, gate_relation)
select
  'CR-' || pg_catalog.lpad(n::text, 3, '0'),
  case
    when n between 1 and 19 then 'voice'
    when n between 20 and 34 then 'casework'
    when n between 35 and 50 then 'analytics'
    when n between 51 and 67 then 'organizing'
    when n between 68 and 87 then 'knowledge'
    when n between 88 and 99 then 'communications'
    when n between 100 and 112 then 'administration'
    else 'public'
  end,
  case when n = any(array[18,35,36,37,38,39,45,46,49,92,93,94,106,107,113,114])
    then 'seeded' else 'schema-not-yet-landed' end,
  case
    when n = 18 then 'member-qa'
    when n = any(array[35,36,37,38,39,49]) then 'organization-analytics'
    when n = any(array[45,46]) then 'pay-scales'
    when n = any(array[92,93,94]) then 'integration-control-plane'
    when n = 106 then 'audit-ledger'
    when n = 107 then 'job-health'
    when n = 113 then 'public-events'
    when n = 114 then 'public-directory'
    else null
  end,
  case
    when n between 3 and 9 then 'public.organization_surveys'
    when n = 23 then 'public.member_case_deadlines'
    when n = 24 then 'public.member_case_checklist_items'
    when n = 25 then 'public.member_case_step_rules'
    when n = 26 then 'public.member_case_restrictions'
    when n = 27 then 'public.member_case_alerts'
    when n = 34 then 'public.member_case_reminders'
    when n between 72 and 74 then 'public.knowledge_files'
    when n = 96 then 'public.member_handoffs'
    else null
  end
from pg_catalog.generate_series(1, 114) as numbered(n);

insert into private.demo_seed_page_contract (surface, page_size, minimum_rows, scope, source) values
  ('adminMemberDirectory', 25, 50, 'organization', 'src/App.jsx:1832'),
  ('memberQa', 50, 100, 'organization', 'supabase/migrations/20260822020000_mi1_w1_feature_persistence.sql:1042'),
  ('stewardRequests', 100, 200, 'featured-steward', 'src/lib/memberApi.js:2845'),
  ('stewardConversations', 50, 100, 'featured-steward', 'src/lib/memberApi.js:2846'),
  ('stewardForms', 50, 100, 'featured-steward', 'src/lib/memberApi.js:2847'),
  ('stewardBroadcasts', 20, 40, 'organization', 'src/lib/memberApi.js:2848'),
  ('stewardThreadMessages', 50, 100, 'featured-conversation', 'src/lib/memberApi.js:2849'),
  ('coordinatorCases', 200, 400, 'organization', 'src/lib/memberApi.js:3289'),
  ('memberPointsLedger', 30, 60, 'featured-member', 'src/lib/memberApi.js:272'),
  ('stewardUpcomingAppointments', 50, 100, 'featured-steward', 'src/lib/memberApi.js:2854'),
  ('stewardRecentAppointments', 20, 40, 'featured-steward', 'src/lib/memberApi.js:2855'),
  ('chapterAppointments', 50, 100, 'featured-chapter', 'src/lib/memberApi.js:3809');

-- The product ledger remains append-only for every ordinary path. SAMPLE
-- teardown gets one narrow exception: service_role, an exact transaction-local
-- run id, and only rows stamped by this deterministic seeder.
create or replace function private.mi1_audit_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE'
     and (select auth.role()) = 'service_role'
     and old.source = 'demo_seed'
     and old.metadata ->> 'reasonCode' = 'sample-seed'
     and old.metadata ->> 'runId' = pg_catalog.current_setting('unionground.demo_seed_remove_run', true) then
    return old;
  end if;
  raise exception 'organization audit ledger is append-only' using errcode = '55000';
end;
$function$;

create function private.demo_seed_user(p_lane text, p_run_id uuid, p_ordinal integer)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_user uuid;
  lane_count integer;
begin
  if p_lane = 'presg' then
    select member_count into lane_count from private.presg_demo_runs where id = p_run_id;
    select user_id into found_user from private.presg_demo_ledger
    where run_id = p_run_id and ordinal = 1 + (greatest(p_ordinal, 1) - 1) % lane_count;
  elsif p_lane = 'uniondemo' then
    select member_count into lane_count from private.uniondemo_runs where id = p_run_id;
    select user_id into found_user from private.uniondemo_ledger
    where run_id = p_run_id and ordinal = 1 + (greatest(p_ordinal, 1) - 1) % lane_count;
  else
    raise exception 'unknown demo lane';
  end if;
  if found_user is null then raise exception 'demo lane has no seeded users'; end if;
  return found_user;
end;
$function$;

create function private.demo_seed_chapter(p_lane text, p_run_id uuid, p_ordinal integer)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  found_chapter text;
  lane_count integer;
begin
  if p_lane = 'presg' then
    return 'presg';
  elsif p_lane = 'uniondemo' then
    select chapter_count into lane_count from private.uniondemo_runs where id = p_run_id;
    select chapter_id into found_chapter from private.uniondemo_chapters
    where run_id = p_run_id and chapter_index = 1 + (greatest(p_ordinal, 1) - 1) % lane_count;
    return found_chapter;
  end if;
  raise exception 'unknown demo lane';
end;
$function$;

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
  delete from private.demo_seed_page_evidence where lane = p_lane and run_id = p_run_id;

  insert into private.demo_seed_page_evidence (lane, run_id, surface, actual_rows)
  values
    (p_lane, p_run_id, 'adminMemberDirectory', (select pg_catalog.count(*) from public.member_profiles p join public.chapters c on c.id = p.chapter_id where c.organization_id = p_organization_id)),
    (p_lane, p_run_id, 'memberQa', (select pg_catalog.count(*) from public.member_qa_questions q where q.organization_id = p_organization_id and q.deleted_at is null)),
    (p_lane, p_run_id, 'stewardRequests', (select pg_catalog.count(*) from public.member_steward_requests r join public.member_profiles p on p.id = r.user_id join public.chapters c on c.id = p.chapter_id where c.organization_id = p_organization_id)),
    (p_lane, p_run_id, 'stewardConversations', (select pg_catalog.count(*) from public.member_conversations v join public.member_profiles p on p.id = v.user_id join public.chapters c on c.id = p.chapter_id where c.organization_id = p_organization_id)),
    (p_lane, p_run_id, 'stewardForms', (select pg_catalog.count(*) from public.member_forms f join public.member_profiles p on p.id = f.user_id join public.chapters c on c.id = p.chapter_id where c.organization_id = p_organization_id and f.status in ('submitted', 'in_review'))),
    (p_lane, p_run_id, 'stewardBroadcasts', (select pg_catalog.count(*) from public.member_broadcasts b where b.organization_id = p_organization_id)),
    (p_lane, p_run_id, 'stewardThreadMessages', (select pg_catalog.count(*) from public.member_messages m where m.conversation_id = p_featured_conversation)),
    (p_lane, p_run_id, 'coordinatorCases', (select pg_catalog.count(*) from public.member_cases c where c.organization_id = p_organization_id)),
    (p_lane, p_run_id, 'memberPointsLedger', (select pg_catalog.count(*) from public.member_point_events e where e.user_id = p_featured_user)),
    (p_lane, p_run_id, 'stewardUpcomingAppointments', (select pg_catalog.count(*) from public.member_appointments a where a.steward_id = p_featured_steward and a.status = 'confirmed' and a.starts_at >= pg_catalog.now())),
    (p_lane, p_run_id, 'stewardRecentAppointments', (select pg_catalog.count(*) from public.member_appointments a where a.steward_id = p_featured_steward and a.status in ('completed', 'cancelled', 'no_show') and a.starts_at < pg_catalog.now())),
    (p_lane, p_run_id, 'chapterAppointments', (select pg_catalog.count(*) from public.member_appointments a join public.chapters c on c.id = a.chapter_id where c.organization_id = p_organization_id));

  return pg_catalog.jsonb_build_object(
    'ok', not exists (
      select 1 from private.demo_seed_page_evidence e
      join private.demo_seed_page_contract c on c.surface = e.surface
      where e.lane = p_lane and e.run_id = p_run_id and e.actual_rows < c.minimum_rows
    ),
    'surfaces', (select pg_catalog.jsonb_object_agg(e.surface, pg_catalog.jsonb_build_object(
      'actual', e.actual_rows, 'minimum', c.minimum_rows, 'pageSize', c.page_size,
      'ok', e.actual_rows >= c.minimum_rows))
      from private.demo_seed_page_evidence e
      join private.demo_seed_page_contract c on c.surface = e.surface
      where e.lane = p_lane and e.run_id = p_run_id)
  );
end;
$function$;

create function private.demo_seed_apply_function_parity(
  p_lane text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '300s'
as $function$
declare
  v_organization_id uuid;
  chapter_id text;
  featured_user uuid;
  featured_steward uuid;
  featured_conversation uuid;
  template_key text;
  template_version integer;
  row_user uuid;
  row_chapter text;
  row_id uuid;
  i integer;
  page_result jsonb;
  gate record;
begin
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
    if not exists (select 1 from private.presg_demo_runs where id = p_run_id and state in ('applied', 'verified')) then
      raise exception 'presg demo run must be applied before parity data';
    end if;
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
    if not exists (select 1 from private.uniondemo_runs where id = p_run_id and state in ('applied', 'verified')) then
      raise exception 'union demo run must be applied before parity data';
    end if;
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;

  if not exists (select 1 from public.organizations o where o.id = v_organization_id and o.status = 'active') then
    raise exception 'demo organization is missing';
  end if;

  for gate in
    select function_id, gate_relation from private.demo_seed_function_catalog
    where coverage = 'schema-not-yet-landed' and gate_relation is not null
  loop
    if pg_catalog.to_regclass(gate.gate_relation) is not null then
      raise exception '% schema has landed; add deterministic seed evidence before applying', gate.function_id;
    end if;
  end loop;

  chapter_id := private.demo_seed_chapter(p_lane, p_run_id, 1);
  featured_steward := private.demo_seed_user(p_lane, p_run_id, 1);
  featured_user := private.demo_seed_user(p_lane, p_run_id, 2);
  featured_conversation := private.member_stress_uuid(p_run_id::text || ':parity:featured-conversation');

  select key, version into template_key, template_version
  from public.form_templates where active order by key, version desc limit 1;
  if template_key is null then raise exception 'an active form template is required'; end if;

  for i in 1..400 loop
    row_user := private.demo_seed_user(p_lane, p_run_id, i + 2);
    row_chapter := private.demo_seed_chapter(p_lane, p_run_id, i + 2);

    if i <= 200 then
      insert into public.member_steward_requests (id, user_id, status, created_at)
      values (private.member_stress_uuid(p_run_id::text || ':parity:request:' || i), row_user,
        (array['requested','acknowledged','closed'])[1 + (i % 3)], pg_catalog.now() - (i || ' hours')::interval)
      on conflict (id) do nothing;
    end if;

    if i <= 100 then
      row_id := private.member_stress_uuid(p_run_id::text || ':parity:conversation:' || i);
      insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at)
      values (row_id, row_user, 'Workplace question ' || i, 'UG',
        pg_catalog.now() - (i || ' days')::interval, pg_catalog.now() - (i || ' hours')::interval)
      on conflict (id) do nothing;
      insert into public.member_messages (id, conversation_id, user_id, sender_kind, sender_name, body, created_at)
      values (private.member_stress_uuid(p_run_id::text || ':parity:conversation-message:' || i), row_id,
        row_user, case when i % 2 = 0 then 'member' else 'steward' end,
        case when i % 2 = 0 then 'Member' else 'Chapter steward' end,
        'Deterministic conversation preview ' || i || ' with enough detail to exercise search and paging.',
        pg_catalog.now() - (i || ' hours')::interval)
      on conflict (id) do nothing;

      insert into public.member_forms
        (id, user_id, template_key, template_version, status, answers, step, submitted_at, created_at, updated_at)
      values (private.member_stress_uuid(p_run_id::text || ':parity:form:' || i), row_user,
        template_key, template_version, case when i % 3 = 0 then 'in_review' else 'submitted' end,
        pg_catalog.jsonb_build_object('seedSequence', i), 1,
        pg_catalog.now() - (i || ' hours')::interval,
        pg_catalog.now() - (i || ' days')::interval, pg_catalog.now() - (i || ' hours')::interval)
      on conflict (id) do nothing;

      row_id := private.member_stress_uuid(p_run_id::text || ':parity:qa:' || i);
      insert into public.member_qa_questions
        (id, organization_id, chapter_id, author_user_id, title, body, status, upvote_count,
         idempotency_key, created_at, updated_at)
      values (row_id, v_organization_id, row_chapter, row_user,
        'Member question ' || pg_catalog.lpad(i::text, 3, '0') || ' about workplace rights',
        'A realistic fictional question used to exercise the member Q&A list, filters, and second page.',
        (array['open','replied','accepted'])[1 + (i % 3)], i % 17,
        private.member_stress_uuid(p_run_id::text || ':parity:qa-idempotency:' || i),
        pg_catalog.now() - (i || ' days')::interval, pg_catalog.now() - (i || ' hours')::interval)
      on conflict (id) do nothing;
    end if;

    insert into public.member_cases
      (id, user_id, reference, title, deadline, case_type, articles, step, status, created_at, updated_at)
    values (private.member_stress_uuid(p_run_id::text || ':parity:case:' || i), row_user,
      upper(p_lane) || '-PG-' || pg_catalog.lpad(i::text, 4, '0'),
      (array['Scheduling dispute','Overtime review','Safety follow-up','Discipline response'])[1 + (i % 4)] || ' ' || i,
      current_date + ((i % 120) - 30),
      (array['Contract enforcement','Discipline','Health and safety','Pay'])[1 + (i % 4)],
      case when i % 2 = 0 then 'Article 7' else 'Article 12' end,
      (array['Intake','Investigation','Step 1','Step 2','Review'])[1 + (i % 5)],
      case when i % 5 = 0 then 'resolved' else 'active' end,
      pg_catalog.now() - (i || ' days')::interval, pg_catalog.now() - (i || ' hours')::interval)
    on conflict (id) do nothing;
  end loop;

  insert into public.member_conversations (id, user_id, title, initials, created_at, updated_at)
  values (featured_conversation, featured_user, 'Scheduling follow-up archive', 'UG',
    pg_catalog.now() - interval '120 days', pg_catalog.now())
  on conflict (id) do update set updated_at = excluded.updated_at;

  for i in 1..100 loop
    insert into public.member_messages (id, conversation_id, user_id, sender_kind, sender_name, body, created_at)
    values (private.member_stress_uuid(p_run_id::text || ':parity:featured-message:' || i),
      featured_conversation, featured_user, case when i % 2 = 0 then 'member' else 'steward' end,
      case when i % 2 = 0 then 'Member' else 'Chapter steward' end,
      'Archived scheduling follow-up message ' || i || ' for deterministic two-page thread history.',
      pg_catalog.now() - ((101 - i) || ' hours')::interval)
    on conflict (id) do nothing;
  end loop;

  for i in 1..60 loop
    insert into public.member_point_events (id, user_id, action_key, action_kind, points, occurred_at)
    values (private.member_stress_uuid(p_run_id::text || ':parity:point:' || i), featured_user,
      'parity-' || p_run_id::text || '-' || i, 'rights', 1 + (i % 15),
      pg_catalog.now() - ((8 + i) || ' days')::interval)
    on conflict (id) do nothing;
  end loop;

  for i in 1..100 loop
    row_user := private.demo_seed_user(p_lane, p_run_id, i + 2);
    insert into public.member_appointments
      (id, user_id, steward_id, chapter_id, appointment_type, duration_minutes,
       starts_at, ends_at, status, routed_via, reason_category, created_at, updated_at)
    values (private.member_stress_uuid(p_run_id::text || ':parity:upcoming-appointment:' || i),
      row_user, featured_steward, chapter_id, (array['office_hours','grievance_followup','onboarding','contract_questions'])[1 + (i % 4)],
      30, (current_date + 400 + i)::timestamp at time zone 'America/New_York' + interval '15 hours',
      (current_date + 400 + i)::timestamp at time zone 'America/New_York' + interval '15 hours 30 minutes',
      'confirmed', 'steward', (array['general','pay','benefits','scheduling','safety'])[1 + (i % 5)],
      pg_catalog.now(), pg_catalog.now())
    on conflict (id) do nothing;
  end loop;

  for i in 1..40 loop
    row_user := private.demo_seed_user(p_lane, p_run_id, i + 102);
    insert into public.member_appointments
      (id, user_id, steward_id, chapter_id, appointment_type, duration_minutes,
       starts_at, ends_at, status, routed_via, reason_category, created_at, updated_at)
    values (private.member_stress_uuid(p_run_id::text || ':parity:recent-appointment:' || i),
      row_user, featured_steward, chapter_id, 'office_hours', 30,
      (current_date - 400 - i)::timestamp at time zone 'America/New_York' + interval '15 hours',
      (current_date - 400 - i)::timestamp at time zone 'America/New_York' + interval '15 hours 30 minutes',
      (array['completed','cancelled','no_show'])[1 + (i % 3)], 'steward', 'general',
      pg_catalog.now() - (i || ' days')::interval, pg_catalog.now() - (i || ' days')::interval)
    on conflict (id) do nothing;
  end loop;

  insert into public.organization_page_views (organization_id, path, hat, day, view_count)
  select v_organization_id, p.path, p.hat, current_date - d, 10 + ((d + p.n) % 90)
  from pg_catalog.generate_series(0, 119) d
  cross join (values (1, '/home', 'member'), (2, '/work', 'steward'),
    (3, '/casework', 'coordinator'), (4, '/admin', 'admin')) p(n, path, hat)
  on conflict (organization_id, path, hat, day) do update set view_count = excluded.view_count;

  insert into public.organization_engagement_events
    (organization_id, user_id, chapter_id, event_type, source_id, occurred_at)
  select v_organization_id, private.demo_seed_user(p_lane, p_run_id, series.n),
    private.demo_seed_chapter(p_lane, p_run_id, series.n),
    (array['meeting_check_in','qa_contribution','poll_vote','survey_response','event_rsvp','authorized_contact'])[1 + (series.n % 6)],
    p_lane || '-parity-engagement-' || series.n, pg_catalog.now() - (series.n || ' hours')::interval
  from pg_catalog.generate_series(1, 120) series(n)
  on conflict (organization_id, user_id, event_type, source_id) do nothing;

  insert into public.organization_analytics_exports
    (id, organization_id, export_format, expires_at, row_count, suppressed_count, created_by, created_at)
  select private.member_stress_uuid(p_run_id::text || ':parity:analytics-export:' || series.n),
    v_organization_id, case when series.n % 2 = 0 then 'csv' else 'json' end,
    pg_catalog.now() + interval '24 hours', 100 + series.n, series.n % 7, featured_steward,
    pg_catalog.now() - (series.n || ' hours')::interval
  from pg_catalog.generate_series(1, 20) series(n)
  on conflict (id) do nothing;

  insert into public.pay_scale_grades (organization_id, grade, title, job_family, step_count, description)
  select v_organization_id, 'G' || pg_catalog.lpad(series.n::text, 2, '0'),
    'Public service grade ' || series.n, (array['Direct care','Administration','Clinical','Operations'])[1 + (series.n % 4)],
    10, 'Fictional pay grade for calculator and table demonstrations.'
  from pg_catalog.generate_series(1, 12) series(n)
  on conflict (organization_id, grade) do update set title = excluded.title, step_count = excluded.step_count;

  insert into public.pay_scale_steps (organization_id, grade, effective_on, step_number, hourly_rate_cents)
  select v_organization_id, 'G' || pg_catalog.lpad(g::text, 2, '0'), date '2026-07-01', s,
    2000 + g * 125 + s * 55
  from pg_catalog.generate_series(1, 12) g cross join pg_catalog.generate_series(1, 10) s
  on conflict (organization_id, grade, effective_on, step_number)
  do update set hourly_rate_cents = excluded.hourly_rate_cents;

  insert into public.organization_integrations
    (id, organization_id, provider, status, account_owner, allow_chapter_overrides,
     allow_chapter_owned_accounts, allowed_chapter_override_keys, default_settings)
  select private.member_stress_uuid(p_run_id::text || ':parity:integration:' || p.provider),
    v_organization_id, p.provider,
    case when p.provider = 'scim' then 'disabled' else 'unset' end,
    'organization', p.provider in ('google_calendar','microsoft_calendar'), false,
    case when p.provider in ('google_calendar','microsoft_calendar') then array['enabled']::text[] else '{}'::text[] end,
    '{}'::jsonb
  from unnest(array['twilio','google_calendar','microsoft_calendar','constant_contact',
    'cba_ingest','customer_webhooks','customer_api','scim']) p(provider)
  on conflict (organization_id, provider) do update set status = excluded.status,
    credential_ref = null, default_settings = excluded.default_settings;

  insert into public.integration_webhooks
    (id, organization_id, url, events, secret_hash, active, last_delivery_status)
  values (private.member_stress_uuid(p_run_id::text || ':parity:webhook'), v_organization_id,
    'https://disabled.example.invalid/union-ground', array['case.updated'],
    pg_catalog.encode(extensions.digest(p_run_id::text || ':disabled-webhook', 'sha256'), 'hex'),
    false, 'blocked')
  on conflict (id) do update set active = false;

  insert into public.integration_api_keys
    (id, organization_id, name, key_hash, key_prefix, revoked_at, last_rotated_at)
  values (private.member_stress_uuid(p_run_id::text || ':parity:api-key'), v_organization_id,
    'Revoked demonstration key',
    pg_catalog.encode(extensions.digest(p_run_id::text || ':revoked-api-key', 'sha256'), 'hex'),
    'ug_demo', pg_catalog.now() - interval '30 days', pg_catalog.now() - interval '60 days')
  on conflict (id) do update set revoked_at = excluded.revoked_at;

  insert into public.organization_job_runs
    (id, organization_id, job_name, run_id, status, started_at, finished_at, failure_code, redacted_summary)
  select private.member_stress_uuid(p_run_id::text || ':parity:job:' || series.n), v_organization_id,
    (array['notifications-dispatch-tick','deadline-notices-tick','appointment-reminders-tick','task-maintenance-daily'])[1 + (series.n % 4)],
    p_lane || '-parity-' || series.n, (array['completed','failed','skipped'])[1 + (series.n % 3)],
    pg_catalog.now() - (series.n || ' hours')::interval, pg_catalog.now() - (series.n || ' hours')::interval + interval '2 minutes',
    case when series.n % 3 = 1 then 'sample-provider-disabled' else null end,
    'Fictional redacted job result; no provider delivery was attempted.'
  from pg_catalog.generate_series(1, 40) series(n)
  on conflict (job_name, run_id, organization_id) do nothing;

  insert into public.organization_audit_ledger
    (id, organization_id, domain, event_type, action, actor_user_id, entity_type,
     entity_id, occurred_at, idempotency_key, metadata, source)
  select private.member_stress_uuid(p_run_id::text || ':parity:audit-row:' || series.n), v_organization_id,
    (array['administration','casework','messages','data_access','communications','knowledge','operations','exports'])[1 + (series.n % 8)],
    'demo.parity.' || (series.n % 8), (array['create','update','read','export','settings_change','acknowledge'])[1 + (series.n % 6)],
    featured_steward, (array['organization','case','message','export','document','job_run'])[1 + (series.n % 6)],
    p_lane || '-parity-' || series.n, pg_catalog.now() - (series.n || ' hours')::interval,
    private.member_stress_uuid(p_run_id::text || ':parity:audit-idempotency:' || series.n),
    pg_catalog.jsonb_build_object('organizationId', v_organization_id, 'count', series.n,
      'reasonCode', 'sample-seed', 'runId', p_run_id::text), 'demo_seed'
  from pg_catalog.generate_series(1, 120) series(n)
  on conflict (idempotency_key) do nothing;

  insert into public.public_event_rsvps
    (id, organization_id, event_id, email, name, locale, created_at)
  select private.member_stress_uuid(p_run_id::text || ':parity:public-rsvp:' || series.n), v_organization_id,
    p_lane || '-public-open-house', p_lane || '-guest-' || series.n || '@example.invalid',
    'Community guest ' || series.n, case when series.n % 8 = 0 then 'es' else 'en' end,
    pg_catalog.now() - (series.n || ' minutes')::interval
  from pg_catalog.generate_series(1, 100) series(n)
  on conflict (event_id, email) do nothing;

  delete from private.demo_seed_function_evidence where lane = p_lane and run_id = p_run_id;
  insert into private.demo_seed_function_evidence
    (lane, run_id, function_id, status, evidence_key)
  select p_lane, p_run_id, function_id, coverage, evidence_key
  from private.demo_seed_function_catalog;

  page_result := private.demo_seed_record_page_evidence(
    p_lane, p_run_id, v_organization_id, featured_user, featured_steward, featured_conversation);
  if not (page_result ->> 'ok')::boolean then
    raise exception 'two-page seed contract failed: %', page_result;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'functions', 114,
    'seededFunctions', (select pg_catalog.count(*) from private.demo_seed_function_catalog where coverage = 'seeded'),
    'schemaGates', (select pg_catalog.count(*) from private.demo_seed_function_catalog where coverage = 'schema-not-yet-landed'),
    'pageDepth', page_result,
    'outboundDeliveries', 0
  );
end;
$function$;

create function public.presg_demo_seed_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text)
returns jsonb language sql security definer set search_path = '' as $function$
  select private.demo_seed_apply_function_parity('presg', p_run_id, p_target_ref, p_confirm_token);
$function$;

create function public.uniondemo_seed_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text)
returns jsonb language sql security definer set search_path = '' as $function$
  select private.demo_seed_apply_function_parity('uniondemo', p_run_id, p_target_ref, p_confirm_token);
$function$;

create function private.demo_seed_function_parity_status(p_lane text, p_run_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select pg_catalog.jsonb_build_object(
    'ok',
      (select pg_catalog.count(*) = 114 from private.demo_seed_function_evidence where lane = p_lane and run_id = p_run_id)
      and not exists (
        select 1 from private.demo_seed_page_evidence e
        join private.demo_seed_page_contract c on c.surface = e.surface
        where e.lane = p_lane and e.run_id = p_run_id and e.actual_rows < c.minimum_rows),
    'functions', (select pg_catalog.count(*) from private.demo_seed_function_evidence where lane = p_lane and run_id = p_run_id),
    'seededFunctions', (select pg_catalog.count(*) from private.demo_seed_function_evidence where lane = p_lane and run_id = p_run_id and status = 'seeded'),
    'schemaGates', (select pg_catalog.count(*) from private.demo_seed_function_evidence where lane = p_lane and run_id = p_run_id and status = 'schema-not-yet-landed'),
    'pageDepth', (select pg_catalog.jsonb_object_agg(e.surface, pg_catalog.jsonb_build_object(
      'actual', e.actual_rows, 'minimum', c.minimum_rows, 'pageSize', c.page_size,
      'ok', e.actual_rows >= c.minimum_rows))
      from private.demo_seed_page_evidence e
      join private.demo_seed_page_contract c on c.surface = e.surface
      where e.lane = p_lane and e.run_id = p_run_id)
  );
$function$;

create function public.presg_demo_function_parity_status(p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service_role required'; end if;
  return private.demo_seed_function_parity_status('presg', p_run_id);
end;
$function$;

create function public.uniondemo_function_parity_status(p_run_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'service_role required'; end if;
  return private.demo_seed_function_parity_status('uniondemo', p_run_id);
end;
$function$;

create function private.demo_seed_remove_function_parity(p_lane text, p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_organization_id uuid := private.member_stress_uuid(p_run_id::text || case when p_lane = 'presg' then ':presg:organization' else ':ud:organization' end);
begin
  perform pg_catalog.set_config('unionground.demo_seed_remove_run', p_run_id::text, true);
  delete from private.demo_seed_page_evidence where lane = p_lane and run_id = p_run_id;
  delete from private.demo_seed_function_evidence where lane = p_lane and run_id = p_run_id;
  -- Domain rows cascade or are removed by the lane's ordinary user/org cleanup.
  -- Explicit organization-owned W1 rows are removed here before the protected
  -- organization can be deleted by the lane cleanup.
  delete from public.public_event_rsvps r where r.organization_id = v_organization_id;
  delete from public.organization_audit_ledger a where a.organization_id = v_organization_id;
  delete from public.organization_job_acknowledgements a where a.organization_id = v_organization_id;
  delete from public.organization_job_runs r where r.organization_id = v_organization_id;
  delete from public.integration_webhook_deliveries d where d.organization_id = v_organization_id;
  delete from public.integration_webhooks w where w.organization_id = v_organization_id;
  delete from public.integration_api_keys k where k.organization_id = v_organization_id;
  delete from public.chapter_integration_overrides o where o.organization_id = v_organization_id;
  delete from public.integration_jobs j where j.organization_id = v_organization_id;
  delete from public.organization_integrations i where i.organization_id = v_organization_id;
  delete from public.pay_scale_steps s where s.organization_id = v_organization_id;
  delete from public.pay_scale_grades g where g.organization_id = v_organization_id;
  delete from public.organization_analytics_exports e where e.organization_id = v_organization_id;
  delete from public.organization_engagement_events e where e.organization_id = v_organization_id;
  delete from public.organization_page_views v where v.organization_id = v_organization_id;
  delete from public.member_qa_votes v where v.organization_id = v_organization_id;
  delete from public.member_qa_replies r where r.organization_id = v_organization_id;
  delete from public.member_qa_questions q where q.organization_id = v_organization_id;
  if not exists (select 1 from public.chapters c where c.organization_id = v_organization_id)
     and not exists (select 1 from public.organization_memberships m where m.organization_id = v_organization_id) then
    delete from public.organizations o where o.id = v_organization_id;
  end if;
  return pg_catalog.jsonb_build_object('removed', true, 'lane', p_lane, 'runId', p_run_id);
end;
$function$;

create function public.presg_demo_remove_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  return private.demo_seed_remove_function_parity('presg', p_run_id);
end;
$function$;

create function public.uniondemo_remove_function_parity(p_run_id uuid, p_target_ref text, p_confirm_token text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  return private.demo_seed_remove_function_parity('uniondemo', p_run_id);
end;
$function$;

-- Repair the guard definitions for environments where the earlier lane SQL
-- was manually installed before this migration was committed.
create or replace function private.presg_demo_authorize(p_target_ref text, p_confirm_token text)
returns void language plpgsql security invoker set search_path = '' as $function$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'presg demo RPC requires service_role'; end if;
  if p_target_ref <> 'sampledemoprojectref' then raise exception 'presg demo target mismatch'; end if;
  if p_confirm_token <> 'SEED_UNION_GROUND_SAMPLE_DEMO' then raise exception 'presg demo confirmation mismatch'; end if;
end;
$function$;

create or replace function private.uniondemo_authorize(p_target_ref text, p_confirm_token text)
returns void language plpgsql security invoker set search_path = '' as $function$
begin
  if (select auth.role()) <> 'service_role' then raise exception 'union demo RPC requires service_role'; end if;
  if p_target_ref <> 'sampledemoprojectref' then raise exception 'union demo target mismatch'; end if;
  if p_confirm_token <> 'SEED_UNION_DEMO_ORG_SAMPLE_30K' then raise exception 'union demo confirmation mismatch'; end if;
end;
$function$;

revoke all on function private.demo_seed_user(text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_chapter(text, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_record_page_evidence(text, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_apply_function_parity(text, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_function_parity_status(text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.demo_seed_remove_function_parity(text, uuid) from public, anon, authenticated, service_role;

revoke all on function public.presg_demo_seed_function_parity(uuid, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_seed_function_parity(uuid, text, text) from public, anon, authenticated;
revoke all on function public.presg_demo_function_parity_status(uuid) from public, anon, authenticated;
revoke all on function public.uniondemo_function_parity_status(uuid) from public, anon, authenticated;
revoke all on function public.presg_demo_remove_function_parity(uuid, text, text) from public, anon, authenticated;
revoke all on function public.uniondemo_remove_function_parity(uuid, text, text) from public, anon, authenticated;

grant execute on function public.presg_demo_seed_function_parity(uuid, text, text) to service_role;
grant execute on function public.uniondemo_seed_function_parity(uuid, text, text) to service_role;
grant execute on function public.presg_demo_function_parity_status(uuid) to service_role;
grant execute on function public.uniondemo_function_parity_status(uuid) to service_role;
grant execute on function public.presg_demo_remove_function_parity(uuid, text, text) to service_role;
grant execute on function public.uniondemo_remove_function_parity(uuid, text, text) to service_role;
